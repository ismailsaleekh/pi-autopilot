import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { durableIdentifier } from '../core/coordination/client.ts';
import { parseCoordinationMigrationRecoveryWork, parseCoordinationRun, parseCoordinationSessionLease } from '../core/coordination/contracts.ts';
import { CoordinationRuntimeError } from '../core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../core/coordination/runtime-paths.ts';
import { acquireSerializedProcessGuard } from '../core/coordination/serialized-lock.ts';
import { DurableRunSupervisorClient, readCoordinatorSessionContext, readMigrationRecoveryEvidenceFile, type RunSupervisorAttachment } from '../core/coordination/supervisor.ts';
import { currentBootId, isProcessAlive } from '../core/coordination/process-identity.ts';
import type { CoordinationMigrationRecoveryWork, CoordinationReconciliationSource } from '../core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV, resolveRepoIdentity, type ProcessEnvLike } from '../core/parallel-runtime.ts';

type Command = 'list' | 'show' | 'doctor' | 'drain-stale-sessions' | 'retain-authority' | 'release-with-evidence';
type ReleaseSource = Exclude<CoordinationReconciliationSource, 'child-process'>;
interface Args { command: Command; stateRoot: string | null; repoRoot: string; run: string | null; recoveryId: string | null; all: boolean; source: ReleaseSource | null; targetId: string | null; evidence: string | null }

export function migrationRecoveryUsage(): string {
  return [
    '       autopilot-coordinator recovery list --repo-root <absolute-path> [--run <run>] [--state-root <absolute-path>]',
    '       autopilot-coordinator recovery show --repo-root <absolute-path> --recovery-id <id> [--run <run>] [--state-root <absolute-path>]',
    '       autopilot-coordinator recovery doctor --repo-root <absolute-path> [--run <run>] [--state-root <absolute-path>]',
    '       autopilot-coordinator recovery drain-stale-sessions --repo-root <absolute-path> [--run <run>] [--state-root <absolute-path>]',
    '       autopilot-coordinator recovery retain-authority --repo-root <absolute-path> --run <run> (--recovery-id <id>|--all) [--state-root <absolute-path>]',
    '       autopilot-coordinator recovery release-with-evidence --repo-root <absolute-path> --run <run> --recovery-id <id> --source <unit-merge|attempt-reset|quarantine-capture|run-close|run-abort> --target-id <id> --evidence <absolute-json-path> [--state-root <absolute-path>]',
  ].join('\n');
}

function source(value: string): ReleaseSource {
  const allowed: readonly ReleaseSource[] = ['unit-merge', 'attempt-reset', 'quarantine-capture', 'run-close', 'run-abort'];
  if (!allowed.includes(value as ReleaseSource)) throw new Error(`--source must be one of ${allowed.join(', ')}`);
  return value as ReleaseSource;
}

function parse(argv: readonly string[]): Args {
  const raw = argv[0];
  const command = raw === 'retain' ? 'retain-authority' : raw === 'release' ? 'release-with-evidence' : raw;
  if (command !== 'list' && command !== 'show' && command !== 'doctor' && command !== 'drain-stale-sessions' && command !== 'retain-authority' && command !== 'release-with-evidence') throw new Error(migrationRecoveryUsage());
  let stateRoot: string | null = null, repoRoot: string | null = null, run: string | null = null, recoveryId: string | null = null, releaseSource: ReleaseSource | null = null, targetId: string | null = null, evidence: string | null = null, all = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--all') { all = true; continue; }
    const value = argv[index + 1];
    if (!['--state-root', '--repo-root', '--run', '--recovery-id', '--source', '--target-id', '--evidence'].includes(token ?? '')) throw new Error(`unknown recovery option ${String(token)}\n${migrationRecoveryUsage()}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${String(token)} requires a value`);
    if (token === '--state-root') stateRoot = value;
    else if (token === '--repo-root') repoRoot = value;
    else if (token === '--run') run = value;
    else if (token === '--recovery-id') recoveryId = value;
    else if (token === '--source') releaseSource = source(value);
    else if (token === '--target-id') targetId = value;
    else evidence = value;
    index += 1;
  }
  if (repoRoot === null || !isAbsolute(repoRoot)) throw new Error('recovery requires an absolute --repo-root');
  if (stateRoot !== null && !isAbsolute(stateRoot)) throw new Error('--state-root must be absolute');
  if (evidence !== null && !isAbsolute(evidence)) throw new Error('--evidence must be absolute');
  if ((command === 'show' || command === 'retain-authority' || command === 'release-with-evidence') && recoveryId === null && !all) throw new Error(`${command} requires --recovery-id${command === 'retain-authority' ? ' or --all' : ''}`);
  if ((command === 'retain-authority' || command === 'release-with-evidence') && run === null) throw new Error(`${command} requires --run`);
  if (recoveryId !== null && all) throw new Error('--recovery-id and --all are mutually exclusive');
  if (all && command !== 'retain-authority') throw new Error('--all is supported only by retain-authority');
  if (command === 'release-with-evidence' && (releaseSource === null || targetId === null || evidence === null)) throw new Error('release-with-evidence requires --source, --target-id, and --evidence');
  if (command !== 'release-with-evidence' && (releaseSource !== null || targetId !== null || evidence !== null)) throw new Error('--source, --target-id, and --evidence are supported only by release-with-evidence');
  return { command, stateRoot, repoRoot: resolve(repoRoot), run, recoveryId, all, source: releaseSource, targetId, evidence };
}

async function recoveryRows(supervisor: DurableRunSupervisorClient, repoKey: string, run: string | null, includeResolved: boolean, recoveryId: string | null): Promise<readonly CoordinationMigrationRecoveryWork[]> {
  const rows: CoordinationMigrationRecoveryWork[] = [];
  let cursorRun: string | null = null;
  let cursorRecoveryId: string | null = null;
  do {
    const response = await supervisor.client.query('migration-recovery', repoKey, run, { cursor_recovery_id: cursorRecoveryId, cursor_run: cursorRun, include_resolved: includeResolved, limit: 128, recovery_id: recoveryId });
    const page = response.payload['recovery'];
    if (!Array.isArray(page)) throw new CoordinationRuntimeError('store-corrupt', 'coordinator recovery query omitted its bounded page');
    rows.push(...page.map(parseCoordinationMigrationRecoveryWork));
    const next = response.payload['next_cursor'];
    if (next === null) { cursorRun = null; cursorRecoveryId = null; break; }
    if (typeof next !== 'object' || Array.isArray(next)) throw new CoordinationRuntimeError('store-corrupt', 'coordinator recovery query returned an invalid cursor');
    const record = next as Readonly<Record<string, unknown>>;
    if (typeof record['cursor_run'] !== 'string' || typeof record['cursor_recovery_id'] !== 'string') throw new CoordinationRuntimeError('store-corrupt', 'coordinator recovery query returned an incomplete cursor');
    cursorRun = record['cursor_run'];
    cursorRecoveryId = record['cursor_recovery_id'];
  } while (cursorRun !== null && cursorRecoveryId !== null);
  return Object.freeze(rows);
}

async function detach(supervisor: DurableRunSupervisorClient, attachment: RunSupervisorAttachment): Promise<void> {
  await supervisor.client.mutate('detach-session', {
    repoId: attachment.context.repo_id, workstreamRun: attachment.context.workstream_run, sessionId: attachment.session.session_id,
    fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.session.version,
    idempotencyKey: durableIdentifier('detach-migration-recovery', attachment.session.session_lease_id),
  }, { reason: 'migration recovery CLI completed', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
  await rm(attachment.contextPath, { force: true });
}

function replayed(work: CoordinationMigrationRecoveryWork, command: Command, evidenceBytes: Uint8Array | null, releaseSource: ReleaseSource | null, targetId: string | null): boolean {
  const resolution = work.resolution;
  if (work.status !== 'resolved' || resolution === null) return false;
  if (command === 'retain-authority') return resolution.resolution_type === 'authority-retained';
  if (command !== 'release-with-evidence' || evidenceBytes === null) return false;
  const sha = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
  return resolution.resolution_type === 'authority-released' && resolution.release_source === releaseSource && resolution.release_target_id === targetId && resolution.evidence.sha256 === sha;
}

async function drainStaleSessions(supervisor: DurableRunSupervisorClient, repoKey: string, runFilter: string | null): Promise<Readonly<Record<string, unknown>>> {
  const catalog = await supervisor.client.query('run-catalog', repoKey, runFilter);
  const rawRuns = catalog.payload['runs'];
  if (!Array.isArray(rawRuns)) throw new CoordinationRuntimeError('store-corrupt', 'run catalog omitted runs during stale-session drain');
  const contexts = new Map<string, { path: string; context: Awaited<ReturnType<typeof readCoordinatorSessionContext>> }>();
  const entries = await readdir(supervisor.client.paths.sessionsRoot, { withFileTypes: true });
  if (entries.length > 10_000) throw new CoordinationRuntimeError('invalid-state', 'session context count exceeds the recovery drain bound');
  for (const entry of entries) {
    const path = resolve(supervisor.client.paths.sessionsRoot, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json') || (await lstat(path)).isSymbolicLink()) throw new CoordinationRuntimeError('invalid-state', 'session context root contains a non-regular entry', [path]);
    const context = await readCoordinatorSessionContext(path);
    if (contexts.has(context.session_lease_id)) throw new CoordinationRuntimeError('store-corrupt', 'duplicate private session contexts claim one lease', [context.session_lease_id]);
    contexts.set(context.session_lease_id, { path, context });
  }
  const drained: string[] = [];
  for (const rawRun of rawRuns) {
    const run = parseCoordinationRun(rawRun);
    const status = await supervisor.client.query('status', repoKey, run.workstream_run);
    const values = status.payload['session_leases'];
    if (!Array.isArray(values)) throw new CoordinationRuntimeError('store-corrupt', 'run status omitted session leases during stale-session drain');
    for (const value of values) {
      const session = parseCoordinationSessionLease(value);
      if (session.status !== 'attached' && session.status !== 'handoff-pending') continue;
      if (session.boot_id === currentBootId() && isProcessAlive(session.pid)) throw new CoordinationRuntimeError('coordinator-contention', 'recovery drain refuses a live session process', [run.workstream_run, session.session_lease_id, String(session.pid)]);
      const owned = contexts.get(session.session_lease_id);
      if (owned === undefined || owned.context.repo_id !== repoKey || owned.context.workstream_run !== run.workstream_run || owned.context.session_id !== session.session_id || owned.context.session_generation !== session.session_generation) throw new CoordinationRuntimeError('recovery-required', 'stale session cannot be detached without its exact private authority context', [run.workstream_run, session.session_lease_id]);
      await supervisor.client.mutate('detach-session', { repoId: repoKey, workstreamRun: run.workstream_run, sessionId: session.session_id, fencingGeneration: session.session_generation, expectedVersion: session.version, idempotencyKey: durableIdentifier('drain-stale-session', session.session_lease_id) }, { reason: 'exact dead legacy session drained before migration', session_lease_id: session.session_lease_id, session_token: owned.context.session_token });
      await rm(owned.path, { force: true });
      drained.push(`${run.workstream_run}:${session.session_lease_id}`);
    }
  }
  return { schema_version: 'autopilot.migration_recovery_cli.v1', action: 'drain-stale-sessions', repo_key: repoKey, run: runFilter, drained_count: drained.length, drained };
}

async function executeMigrationRecoveryCli(argv: readonly string[], baseEnv: ProcessEnvLike): Promise<Readonly<Record<string, unknown>>> {
  const args = parse(argv);
  const env: ProcessEnvLike = args.stateRoot === null ? baseEnv : { ...baseEnv, [AUTOPILOT_STATE_ROOT_ENV]: args.stateRoot };
  const repo = resolveRepoIdentity(args.repoRoot);
  const supervisor = new DurableRunSupervisorClient(env, { allowMigrationRecoveryAutoStart: true });
  const allRows = await recoveryRows(supervisor, repo.repoKey, args.run, args.command === 'show' || args.recoveryId !== null, args.all ? null : args.recoveryId);
  const pending = allRows.filter((work) => work.status === 'pending');
  if (args.command === 'list') return { schema_version: 'autopilot.migration_recovery_cli.v1', action: 'list', repo_key: repo.repoKey, run: args.run, pending_count: pending.length, recovery: pending };
  if (args.command === 'doctor') {
    const doctor = await supervisor.client.query('doctor');
    return { schema_version: 'autopilot.migration_recovery_cli.v1', action: 'doctor', repo_key: repo.repoKey, run: args.run, pending_count: pending.length, healthy: doctor.payload['healthy'], doctor: doctor.payload };
  }
  if (args.command === 'drain-stale-sessions') return await drainStaleSessions(supervisor, repo.repoKey, args.run);
  if (args.command === 'show') {
    const exact = allRows.filter((work) => work.recovery_id === args.recoveryId);
    if (exact.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'recovery show requires exactly one matching row', [String(args.recoveryId)]);
    return { schema_version: 'autopilot.migration_recovery_cli.v1', action: 'show', repo_key: repo.repoKey, recovery: exact[0] };
  }
  const evidenceBytes = args.evidence === null ? null : readMigrationRecoveryEvidenceFile(args.evidence);
  const targets = args.all ? pending : allRows.filter((work) => work.recovery_id === args.recoveryId);
  if (targets.length === 0 && args.all) return { schema_version: 'autopilot.migration_recovery_cli.v1', action: args.command, replayed: true, resolved_count: 0, remaining_recovery_count: 0 };
  if (targets.length === 0) throw new CoordinationRuntimeError('invalid-state', 'no matching migration recovery work', [String(args.recoveryId ?? args.run)]);
  if (targets.some((work) => work.workstream_run !== args.run)) throw new CoordinationRuntimeError('invalid-request', 'recovery work does not belong to --run');
  const already = targets.filter((work) => replayed(work, args.command, evidenceBytes, args.source, args.targetId));
  const unresolved = targets.filter((work) => work.status === 'pending');
  if (already.length + unresolved.length !== targets.length) throw new CoordinationRuntimeError('invalid-state', 'existing recovery resolution conflicts with requested outcome');
  if (unresolved.length === 0) return { schema_version: 'autopilot.migration_recovery_cli.v1', action: args.command, replayed: true, resolved_count: already.length, remaining_recovery_count: pending.length };
  const first = unresolved[0];
  if (first === undefined || args.run === null) throw new CoordinationRuntimeError('invalid-state', 'recovery target disappeared');
  const attachment = await supervisor.attachMigrationRecovery({ repo, workstreamRun: args.run, recoveryId: first.recovery_id, rawSessionId: `recovery-cli-${process.pid}-${randomUUID()}` });
  let primary: unknown = null;
  const results = [];
  try {
    for (const work of unresolved) results.push(await supervisor.resolveMigrationRecovery({ attachment, recoveryWork: work, resolution: args.command === 'retain-authority' ? { resolutionType: 'authority-retained' } : { resolutionType: 'authority-released', releaseSource: args.source!, releaseTargetId: args.targetId!, evidenceBytes: evidenceBytes! } }));
  } catch (error) { primary = error; }
  try { await detach(supervisor, attachment); } catch (error) { primary = primary === null ? error : new AggregateError([primary, error], 'recovery mutation and fenced detach both failed'); }
  if (primary !== null) throw primary;
  const last = results.at(-1);
  return { schema_version: 'autopilot.migration_recovery_cli.v1', action: args.command, replayed: false, resolved_count: results.length, outcome: args.command === 'retain-authority' ? 'authority-retained' : 'authority-released', remaining_recovery_count: last?.remainingRecoveryCount ?? pending.length };
}

export async function runMigrationRecoveryCli(argv: readonly string[], baseEnv: ProcessEnvLike = process.env): Promise<Readonly<Record<string, unknown>>> {
  const args = parse(argv);
  const env: ProcessEnvLike = args.stateRoot === null ? baseEnv : { ...baseEnv, [AUTOPILOT_STATE_ROOT_ENV]: args.stateRoot };
  const paths = coordinatorRuntimePaths(env);
  const guard = acquireSerializedProcessGuard(resolve(paths.coordinatorRoot, 'migration-recovery-cli.election.db'), 10_000, 'migration recovery CLI');
  try {
    // Recovery commands never signal a coordinator: another client may have
    // attached after startup. Migration commands own process retirement while
    // holding the repository migration lock and after proving a durable drain.
    return await executeMigrationRecoveryCli(argv, baseEnv);
  } finally { guard.release(); }
}
