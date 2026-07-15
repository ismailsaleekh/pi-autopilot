import { DatabaseSync } from 'node:sqlite';

import { CoordinationRuntimeError } from './failures.ts';
import { isExactProcessAlive, isProcessAlive, preflightProcessRetirementSupport, retireExactProcess } from './process-identity.ts';
import { COORDINATOR_PACKAGE_BUILD } from './runtime-constants.ts';
import { classifyCoordinatorRuntimeIdentity } from './runtime-compatibility.ts';
import { ensureCoordinatorPrivateRoots, type CoordinatorRuntimePaths } from './runtime-paths.ts';
import { acquireSerializedProcessGuard, readExactLockText } from './serialized-lock.ts';
import { parseKnownCompatibleCurrentCoordinatorLock } from './upgrade-contracts.ts';

export const PATCH_ACTIVATION_REPORT_SCHEMA = 'autopilot.patch_activation.v1' as const;

export interface PatchActivationReport {
  readonly schema_version: typeof PATCH_ACTIVATION_REPORT_SCHEMA;
  readonly outcome: 'no-prior-coordinator' | 'already-current' | 'activated-after-drain';
  readonly prior_package_build: string | null;
  readonly prior_pid: number | null;
  readonly drained_checkpoints: readonly string[];
  readonly activated_package_build: typeof COORDINATOR_PACKAGE_BUILD;
}

interface PatchActivationDrainBlockers {
  readonly sessions: readonly string[];
  readonly children: readonly string[];
  readonly criticalSections: readonly string[];
  readonly operations: readonly string[];
}

const PATCH_DRAIN_POLL_MS = 200;
const PATCH_DRAIN_TIMEOUT_MS = 30_000;

/**
 * BUG-177 patch activation: a live cf43 coordinator remains authoritative until
 * every durable session, child, and critical section has drained. This verb
 * refuses to edit the database, lock, socket, claims, messages, or worktrees. It
 * rechecks exact lock/process identity, signals only that exact drained process,
 * waits for its exit, and then returns. Ordinary elected startup publishes the
 * cf44 lock; this function never substitutes a PID-only signal or lock deletion.
 */
export async function activatePatchBuild(paths: CoordinatorRuntimePaths): Promise<PatchActivationReport> {
  await ensureCoordinatorPrivateRoots(paths);
  const guard = acquireSerializedProcessGuard(paths.lifecycleElectionPath, 10_000, 'patch build activation');
  try {
    const lockText = await readExactLockText(paths.lockPath);
    if (lockText === null) return { schema_version: PATCH_ACTIVATION_REPORT_SCHEMA, outcome: 'no-prior-coordinator', prior_package_build: null, prior_pid: null, drained_checkpoints: [], activated_package_build: COORDINATOR_PACKAGE_BUILD };
    let parsedLock: unknown;
    try { parsedLock = JSON.parse(lockText); }
    catch { throw new CoordinationRuntimeError('schema-mismatch', 'coordinator lifecycle lock is not valid JSON'); }
    const prior = parseKnownCompatibleCurrentCoordinatorLock(parsedLock);
    if (prior === null) throw new CoordinationRuntimeError('protocol-mismatch', 'patch activation requires an exact known compatible current-generation coordinator lock');
    if (prior.package_build === COORDINATOR_PACKAGE_BUILD) return { schema_version: PATCH_ACTIVATION_REPORT_SCHEMA, outcome: 'already-current', prior_package_build: prior.package_build, prior_pid: prior.pid, drained_checkpoints: [], activated_package_build: COORDINATOR_PACKAGE_BUILD };
    if (!isExactProcessAlive(prior.pid, prior.process_start_identity)) throw new CoordinationRuntimeError('coordinator-unavailable', 'prior compatible coordinator is not an exact live process; ordinary elected startup must reclaim a dead lock', [`pid=${String(prior.pid)}`, `build=${prior.package_build}`]);
    preflightProcessRetirementSupport();
    const drainDeadline = Date.now() + PATCH_DRAIN_TIMEOUT_MS;
    let blockers = patchDrainBlockers(paths);
    const checkpoints: string[] = [];
    while (blockers.sessions.length > 0 || blockers.children.length > 0 || blockers.criticalSections.length > 0 || blockers.operations.length > 0) {
      if (Date.now() >= drainDeadline) throw new CoordinationRuntimeError('coordinator-contention', 'prior compatible coordinator did not drain before patch activation', [...blockers.sessions, ...blockers.children, ...blockers.criticalSections, ...blockers.operations]);
      const rechecked = await readExactLockText(paths.lockPath);
      if (rechecked !== lockText) throw new CoordinationRuntimeError('coordinator-contention', 'prior compatible coordinator lifecycle lock changed during patch drain');
      if (!isExactProcessAlive(prior.pid, prior.process_start_identity)) throw new CoordinationRuntimeError('coordinator-unavailable', 'prior compatible coordinator exited before patch activation completed', [`pid=${String(prior.pid)}`]);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, PATCH_DRAIN_POLL_MS));
      blockers = patchDrainBlockers(paths);
    }
    for (const checkpoint of [...blockers.sessions, ...blockers.children, ...blockers.criticalSections, ...blockers.operations]) checkpoints.push(checkpoint);
    const finalLock = await readExactLockText(paths.lockPath);
    if (finalLock !== lockText) throw new CoordinationRuntimeError('coordinator-contention', 'prior compatible coordinator lifecycle lock changed before exact retirement');
    if (!isExactProcessAlive(prior.pid, prior.process_start_identity)) throw new CoordinationRuntimeError('coordinator-unavailable', 'prior compatible coordinator exited before exact retirement', [`pid=${String(prior.pid)}`]);
    retireExactProcess(prior.pid, prior.process_start_identity);
    const retirementDeadline = Date.now() + 10_000;
    while (Date.now() < retirementDeadline) {
      if (!isProcessAlive(prior.pid)) break;
      if (processStartIdentityChanged(prior.pid, prior.process_start_identity)) throw new CoordinationRuntimeError('unauthorized-client', 'prior compatible coordinator PID identity changed during exact retirement', [`pid=${String(prior.pid)}`]);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (isProcessAlive(prior.pid)) throw new CoordinationRuntimeError('coordinator-unavailable', 'prior compatible coordinator did not retire before the patch activation deadline', [`pid=${String(prior.pid)}`]);
    return { schema_version: PATCH_ACTIVATION_REPORT_SCHEMA, outcome: 'activated-after-drain', prior_package_build: prior.package_build, prior_pid: prior.pid, drained_checkpoints: Object.freeze(checkpoints), activated_package_build: COORDINATOR_PACKAGE_BUILD };
  } finally { guard.release(); }
}

function processStartIdentityChanged(pid: number, expected: string): boolean {
  if (!isProcessAlive(pid)) return false;
  return !isExactProcessAlive(pid, expected);
}

function patchDrainBlockers(paths: CoordinatorRuntimePaths): PatchActivationDrainBlockers {
  // Coordinator inspection never opens the live database writable. A read-only
  // connection observes durable drain state without mutating storage. The drain
  // fences only GENUINELY-LIVE authority: attached/handoff-pending sessions,
  // live child processes (preflight/starting/running), active critical sections,
  // and incomplete worktree operations. `recovery-required` children are dead
  // processes whose state is durable; cf44 opens the same database and its
  // startup reconciliation (#recoverDurableTransitionsAfterStartup) handles them
  // identically, so they are not drain blockers for a wire-compatible patch.
  const database = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 10_000 });
  try {
    const sessions: string[] = [];
    for (const row of database.prepare("SELECT repo_id, workstream_run, session_lease_id, status FROM session_leases WHERE status IN ('attached','handoff-pending') ORDER BY repo_id, workstream_run, session_generation").all()) {
      if (typeof row['repo_id'] === 'string' && typeof row['workstream_run'] === 'string' && typeof row['session_lease_id'] === 'string' && typeof row['status'] === 'string') sessions.push(`session-not-drained:${row['repo_id']}:${row['workstream_run']}:${row['session_lease_id']}:${row['status']}`);
    }
    const children: string[] = [];
    for (const row of database.prepare("SELECT repo_id, workstream_run, child_lease_id, status FROM child_leases WHERE status IN ('preflight','starting','running') ORDER BY repo_id, workstream_run, unit_id, attempt").all()) {
      if (typeof row['repo_id'] === 'string' && typeof row['workstream_run'] === 'string' && typeof row['child_lease_id'] === 'string' && typeof row['status'] === 'string') children.push(`child-not-drained:${row['repo_id']}:${row['workstream_run']}:${row['child_lease_id']}:${row['status']}`);
    }
    const criticalSections: string[] = [];
    for (const row of database.prepare("SELECT repo_id, workstream_run, entity_id FROM unit_attempts WHERE json_type(payload_json,'$.critical_section')!='null' ORDER BY repo_id, workstream_run, entity_id").all()) {
      if (typeof row['repo_id'] === 'string' && typeof row['workstream_run'] === 'string' && typeof row['entity_id'] === 'string') criticalSections.push(`critical-section-active:${row['repo_id']}:${row['workstream_run']}:${row['entity_id']}`);
    }
    const operations: string[] = [];
    for (const row of database.prepare("SELECT repo_id, workstream_run, entity_id FROM worktree_operations WHERE json_extract(payload_json,'$.stage') NOT IN ('committed','compensated','failed') ORDER BY repo_id, workstream_run, entity_id").all()) {
      if (typeof row['repo_id'] === 'string' && typeof row['workstream_run'] === 'string' && typeof row['entity_id'] === 'string') operations.push(`operation-not-drained:${row['repo_id']}:${row['workstream_run']}:${row['entity_id']}`);
    }
    return { sessions: Object.freeze(sessions), children: Object.freeze(children), criticalSections: Object.freeze(criticalSections), operations: Object.freeze(operations) };
  } finally { database.close(); }
}

export async function reportPatchActivationReadiness(paths: CoordinatorRuntimePaths): Promise<{ readonly schema_version: 'autopilot.patch_activation_readiness.v1'; readonly current_package_build: typeof COORDINATOR_PACKAGE_BUILD; readonly running_package_build: string | null; readonly running_pid: number | null; readonly running_process_start_identity: string | null; readonly running_is_exact_current: boolean; readonly compatibility: 'exact-current' | 'prior-compatible' | 'incompatible' | 'no-coordinator' | 'unreadable-lock'; readonly drain_blockers: PatchActivationDrainBlockers }> {
  await ensureCoordinatorPrivateRoots(paths);
  const lockText = await readExactLockText(paths.lockPath);
  let runningPackageBuild: string | null = null;
  let runningPid: number | null = null;
  let runningIdentity: string | null = null;
  let compatibility: 'exact-current' | 'prior-compatible' | 'incompatible' | 'no-coordinator' | 'unreadable-lock' = 'no-coordinator';
  if (lockText !== null) {
    try {
      const parsed = JSON.parse(lockText) as unknown;
      const prior = parseKnownCompatibleCurrentCoordinatorLock(parsed);
      if (prior !== null) {
        runningPackageBuild = prior.package_build;
        runningPid = prior.pid;
        runningIdentity = prior.process_start_identity;
        compatibility = prior.package_build === COORDINATOR_PACKAGE_BUILD ? 'exact-current' : 'prior-compatible';
      } else {
        const descriptor = classifyCoordinatorRuntimeIdentity({ package_build: (parsed as { package_build?: unknown }).package_build, protocol_version: (parsed as { protocol_version?: unknown }).protocol_version, database_schema_version: (parsed as { database_schema_version?: unknown }).database_schema_version });
        compatibility = descriptor.kind === 'incompatible' ? 'incompatible' : 'prior-compatible';
      }
    } catch { compatibility = 'unreadable-lock'; }
  }
  const blockers = compatibility === 'no-coordinator' ? { sessions: [], children: [], criticalSections: [], operations: [] } as PatchActivationDrainBlockers : patchDrainBlockers(paths);
  return { schema_version: 'autopilot.patch_activation_readiness.v1', current_package_build: COORDINATOR_PACKAGE_BUILD, running_package_build: runningPackageBuild, running_pid: runningPid, running_process_start_identity: runningIdentity, running_is_exact_current: compatibility === 'exact-current', compatibility, drain_blockers: blockers };
}
