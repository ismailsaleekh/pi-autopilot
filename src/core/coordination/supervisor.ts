import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { link, open, readFile, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { platform } from 'node:os';

import { CoordinatorClient, durableIdentifier } from './client.ts';
import { parseCoordinationMessage, parseCoordinationMigrationRecoveryWork, parseCoordinationRun, parseCoordinationRunTerminalIntent, parseCoordinationSessionLease } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { acknowledgeCoordinationMigrationFreeze, activeCoordinationMigrationFreeze, assertMigrationPathSafe } from './migration-paths.ts';
import { currentBootId } from './process-identity.ts';
import { COORDINATOR_HEARTBEAT_MS, COORDINATOR_SESSION_LEASE_MS, enforcePrivateAuthorityPath, ensurePrivateAuthorityDirectory } from './runtime-paths.ts';
import type { CoordinationMessage, CoordinationMigrationRecoveryWork, CoordinationReconciliationSource, CoordinationRun, CoordinationSessionLease, CoordinatorResponseEnvelope } from './types.ts';
import type { ActiveAutopilotRow, AutopilotRepoIdentity, ProcessEnvLike } from '../parallel-runtime.ts';

export const AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA = 'autopilot.coordinator_session_context.v1' as const;

export interface CoordinatorSessionContext {
  readonly schema_version: typeof AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA;
  readonly state_root: string;
  readonly repo_id: string;
  readonly repo_key: string;
  readonly autopilot_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly session_id: string;
  readonly session_generation: number;
  readonly run_version: number;
  readonly session_lease_id: string;
  readonly session_token: string;
  readonly session_version: number;
  readonly pid: number;
  readonly boot_id: string;
}

export interface RunSupervisorAttachment {
  readonly run: CoordinationRun;
  readonly session: CoordinationSessionLease;
  readonly contextPath: string;
  readonly context: CoordinatorSessionContext;
}

export type MigrationRecoveryResolutionInput =
  | { readonly resolutionType: 'authority-retained' }
  | { readonly resolutionType: 'authority-released'; readonly releaseSource: Exclude<CoordinationReconciliationSource, 'child-process'>; readonly releaseTargetId: string; readonly evidenceBytes: Uint8Array };

export interface MigrationRecoveryResolutionResult {
  readonly recoveryWork: CoordinationMigrationRecoveryWork;
  readonly remainingRecoveryCount: number;
  readonly run: CoordinationRun;
}

export type MigrationRecoveryEvidenceBoundary = 'after-evidence-temp-synced' | 'after-evidence-published';

export interface CoordinationMessageInjection {
  readonly customType: 'autopilot-coordination';
  readonly content: string;
  readonly display: true;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface CoordinationMessageSink {
  send(message: CoordinationMessageInjection, delivery: 'steer' | 'followUp', triggerTurn: boolean): void;
  isIdle(): boolean;
}

interface JsonMap {
  readonly [key: string]: unknown;
}

const SESSION_CONTEXT_FIELDS = ['autopilot_id', 'boot_id', 'pid', 'repo_id', 'repo_key', 'run_version', 'schema_version', 'session_generation', 'session_id', 'session_lease_id', 'session_token', 'session_version', 'state_root', 'workstream', 'workstream_run'] as const;
const AUTHORITY_TOKEN = /^[a-f0-9]{64}$/u;

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: JsonMap, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new CoordinationRuntimeError('invalid-state', `coordinator payload field ${field} is invalid`);
  return value;
}

function requireAuthorityToken(record: JsonMap, field: string): string {
  const value = requireString(record, field);
  if (!AUTHORITY_TOKEN.test(value)) throw new CoordinationRuntimeError('invalid-state', `coordinator payload field ${field} is not a valid authority token`);
  return value;
}

function requireInteger(record: JsonMap, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CoordinationRuntimeError('invalid-state', `coordinator payload field ${field} is invalid`);
  return value;
}

function requireRecord(value: unknown, label: string): JsonMap {
  if (!isJsonMap(value)) throw new CoordinationRuntimeError('invalid-state', `${label} is not an object`);
  return value;
}

function payloadRecord(response: CoordinatorResponseEnvelope, field: string): JsonMap {
  return requireRecord(response.payload[field], `response.${field}`);
}

function payloadArray(response: CoordinatorResponseEnvelope, field: string): readonly unknown[] {
  const value = response.payload[field];
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `response.${field} is not an array`);
  return value;
}

function leaseExpiry(): string {
  return new Date(Date.now() + COORDINATOR_SESSION_LEASE_MS).toISOString();
}

function messageContent(message: CoordinationMessage): string {
  const payload = JSON.stringify(message.payload);
  const bounded = payload.length <= 2_000 ? payload : `${payload.slice(0, 2_000)}…<truncated>`;
  return `Autopilot coordination ${message.message_type} (${message.correlation_id}): ${bounded}`;
}

function fsyncParentDirectory(path: string): void {
  if (platform() === 'win32') return;
  const descriptor = openSync(dirname(path), fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function readExactRegularFile(path: string, maximumBytes: number, label: string): { readonly bytes: Uint8Array; readonly dev: number; readonly ino: number } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new CoordinationRuntimeError('invalid-state', `${label} must be a bounded regular non-symbolic file`, [path]);
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new CoordinationRuntimeError('invalid-state', `${label} identity changed while opening`, [path]);
    const bytes = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (bytes.byteLength !== opened.size || afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino || afterDescriptor.size !== opened.size || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size) throw new CoordinationRuntimeError('invalid-state', `${label} identity changed during read`, [path]);
    return { bytes, dev: opened.dev, ino: opened.ino };
  } finally { closeSync(descriptor); }
}

async function publishMigrationRecoveryEvidence(input: {
  readonly stateRoot: string;
  readonly evidenceRoot: string;
  readonly evidencePath: string;
  readonly evidenceBytes: Uint8Array;
  readonly afterBoundary?: (boundary: MigrationRecoveryEvidenceBoundary) => void | Promise<void>;
}): Promise<void> {
  const maximumBytes = 1024 * 1024;
  if (input.evidenceBytes.byteLength > maximumBytes) throw new CoordinationRuntimeError('invalid-request', 'migration recovery evidence exceeds its immutable byte ceiling');
  assertMigrationPathSafe(input.stateRoot, input.evidenceRoot, 'migration recovery evidence root');
  await ensurePrivateAuthorityDirectory(input.evidenceRoot);
  assertMigrationPathSafe(input.stateRoot, input.evidenceRoot, 'migration recovery evidence root');
  assertMigrationPathSafe(input.stateRoot, input.evidencePath, 'migration recovery evidence destination');
  const evidenceName = input.evidencePath.slice(dirname(input.evidencePath).length + 1);
  let residueRemoved = false;
  for (const entry of readdirSync(input.evidenceRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(`${evidenceName}.tmp-`) && !entry.name.startsWith(`${evidenceName}.invalid-`)) continue;
    const residue = join(input.evidenceRoot, entry.name);
    assertMigrationPathSafe(input.stateRoot, residue, 'migration recovery evidence crash residue');
    if (entry.isSymbolicLink() || !entry.isFile()) throw new CoordinationRuntimeError('invalid-state', 'migration recovery evidence crash residue has an unsafe type', [residue]);
    const opened = readExactRegularFile(residue, maximumBytes, 'migration recovery evidence crash residue');
    const current = lstatSync(residue);
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new CoordinationRuntimeError('invalid-state', 'migration recovery evidence crash residue changed before cleanup', [residue]);
    unlinkSync(residue);
    residueRemoved = true;
  }
  if (residueRemoved) fsyncParentDirectory(input.evidencePath);
  if (existsSync(input.evidencePath)) {
    const existing = readExactRegularFile(input.evidencePath, maximumBytes, 'migration recovery evidence');
    if (existing.bytes.byteLength === input.evidenceBytes.byteLength && timingSafeEqual(existing.bytes, input.evidenceBytes)) return;
    const invalid = `${input.evidencePath}.invalid-${String(process.pid)}-${randomBytes(8).toString('hex')}`;
    assertMigrationPathSafe(input.stateRoot, invalid, 'invalid migration recovery evidence quarantine');
    await rename(input.evidencePath, invalid);
    const quarantined = readExactRegularFile(invalid, maximumBytes, 'invalid migration recovery evidence quarantine');
    if (quarantined.dev !== existing.dev || quarantined.ino !== existing.ino) throw new CoordinationRuntimeError('idempotency-conflict', 'migration recovery evidence identity changed during invalid-file quarantine', [input.evidencePath, invalid]);
    fsyncParentDirectory(input.evidencePath);
    await unlink(invalid);
    fsyncParentDirectory(input.evidencePath);
  }
  const temporary = `${input.evidencePath}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`;
  assertMigrationPathSafe(input.stateRoot, temporary, 'migration recovery evidence temporary');
  let handle: FileHandle | null = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    const written = await handle.write(input.evidenceBytes);
    if (written.bytesWritten !== input.evidenceBytes.byteLength) throw new CoordinationRuntimeError('coordinator-unavailable', 'migration recovery evidence temporary write was incomplete', [temporary, String(written.bytesWritten), String(input.evidenceBytes.byteLength)]);
    await handle.sync();
    await handle.close(); handle = null;
    await enforcePrivateAuthorityPath(temporary, false);
    await input.afterBoundary?.('after-evidence-temp-synced');
    try { await link(temporary, input.evidencePath); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = readExactRegularFile(input.evidencePath, maximumBytes, 'concurrent migration recovery evidence');
      if (existing.bytes.byteLength !== input.evidenceBytes.byteLength || !timingSafeEqual(existing.bytes, input.evidenceBytes)) throw new CoordinationRuntimeError('idempotency-conflict', 'migration recovery evidence identity was concurrently reused with different bytes', [input.evidencePath]);
    }
    await enforcePrivateAuthorityPath(input.evidencePath, false);
    fsyncParentDirectory(input.evidencePath);
    await input.afterBoundary?.('after-evidence-published');
  } finally {
    if (handle !== null) await handle.close();
    if (existsSync(temporary)) {
      await unlink(temporary);
      fsyncParentDirectory(input.evidencePath);
    }
  }
}

export function readMigrationRecoveryEvidenceFile(path: string): Uint8Array {
  if (!isAbsolute(path)) throw new CoordinationRuntimeError('invalid-request', 'migration recovery evidence path must be absolute');
  return readExactRegularFile(path, 1024 * 1024, 'migration recovery evidence input').bytes;
}

export async function writeCoordinatorSessionContext(path: string, context: CoordinatorSessionContext): Promise<void> {
  await ensurePrivateAuthorityDirectory(dirname(path));
  const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(context, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await enforcePrivateAuthorityPath(temporary, false);
  await rename(temporary, path);
  await enforcePrivateAuthorityPath(path, false);
}

export async function readCoordinatorSessionContext(path: string): Promise<CoordinatorSessionContext> {
  if (!isAbsolute(path)) throw new CoordinationRuntimeError('invalid-request', 'coordinator session context path must be absolute');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-state', 'coordinator session context is unreadable', [path, error instanceof Error ? error.message : String(error)]);
  }
  const record = requireRecord(value, 'coordinator session context');
  const unknownFields = Object.keys(record).filter((field) => !(SESSION_CONTEXT_FIELDS as readonly string[]).includes(field));
  const missingFields = SESSION_CONTEXT_FIELDS.filter((field) => !(field in record));
  if (unknownFields.length > 0 || missingFields.length > 0) throw new CoordinationRuntimeError('schema-mismatch', 'coordinator session context fields are incompatible', [...unknownFields.map((field) => `unknown=${field}`), ...missingFields.map((field) => `missing=${field}`)]);
  if (record['schema_version'] !== AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA) throw new CoordinationRuntimeError('schema-mismatch', 'coordinator session context schema is incompatible');
  const stateRoot = requireString(record, 'state_root');
  if (!isAbsolute(stateRoot) || normalize(stateRoot) !== stateRoot) throw new CoordinationRuntimeError('invalid-state', 'coordinator session state root is not a normalized absolute path');
  const sessionGeneration = requireInteger(record, 'session_generation');
  const sessionPid = requireInteger(record, 'pid');
  if (sessionGeneration < 1 || sessionPid < 1) throw new CoordinationRuntimeError('invalid-state', 'coordinator session generation and pid must be positive');
  return {
    schema_version: AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA,
    state_root: stateRoot,
    repo_id: requireString(record, 'repo_id'),
    repo_key: requireString(record, 'repo_key'),
    autopilot_id: requireString(record, 'autopilot_id'),
    workstream: requireString(record, 'workstream'),
    workstream_run: requireString(record, 'workstream_run'),
    session_id: requireString(record, 'session_id'),
    session_generation: sessionGeneration,
    run_version: requireInteger(record, 'run_version'),
    session_lease_id: requireString(record, 'session_lease_id'),
    session_token: requireAuthorityToken(record, 'session_token'),
    session_version: requireInteger(record, 'session_version'),
    pid: sessionPid,
    boot_id: requireString(record, 'boot_id'),
  };
}

export class DurableRunSupervisorClient {
  readonly #client: CoordinatorClient;
  readonly #migrationRecoveryAuthority = new AsyncLocalStorage<string>();

  constructor(env: ProcessEnvLike = process.env, options: { readonly allowMigrationRecoveryAutoStart?: boolean } = {}) {
    this.#client = new CoordinatorClient({ env, ...(options.allowMigrationRecoveryAutoStart === undefined ? {} : { allowMigrationRecoveryAutoStart: options.allowMigrationRecoveryAutoStart }) });
  }

  get client(): CoordinatorClient {
    return this.#client;
  }

  async withMigrationRecoveryAuthority<T>(operation: (operationToken: string) => Promise<T>): Promise<T> {
    const inheritedToken = this.#migrationRecoveryAuthority.getStore();
    if (inheritedToken !== undefined) return await operation(inheritedToken);
    // Dynamic import avoids the parallel-runtime → supervisor → migration cycle;
    // recovery authority is acquired only after package module initialization.
    const migration = await import('./migration.ts');
    const lock = await migration.acquireCoordinationGlobalMigrationLock(this.#client.paths.stateRoot);
    let authorization: { readonly token: string; readonly release: () => Promise<void> } | null = null;
    try {
      const granted = await migration.authorizeCoordinationMigrationRecovery(this.#client.paths.stateRoot, lock);
      authorization = granted;
      return await this.#migrationRecoveryAuthority.run(granted.token, async () => await operation(granted.token));
    } finally {
      try { if (authorization !== null) await authorization.release(); }
      finally { await lock.release(); }
    }
  }

  async attach(input: { readonly repo: AutopilotRepoIdentity; readonly active: ActiveAutopilotRow; readonly rawSessionId: string; readonly handoffToken?: string | null }): Promise<RunSupervisorAttachment> {
    const repoId = input.repo.repoKey;
    const sessionId = durableIdentifier('session', input.rawSessionId);
    const status = await this.#client.query('run-catalog', repoId, input.active.workstream_run);
    const runValues = payloadArray(status, 'runs');
    const pendingRecoveryCount = requireInteger(status.payload, 'pending_migration_recovery_count');
    const pendingRecovery = payloadArray(status, 'pending_migration_recovery').map((value) => requireRecord(value, 'pending migration recovery identity'));
    if (pendingRecoveryCount > 0) throw new CoordinationRuntimeError('recovery-required', 'ordinary run supervisor attachment is fenced while migration recovery work is pending', pendingRecovery.map((work) => String(work['recovery_id'])));
    let run: CoordinationRun;
    if (runValues.length === 0) {
      const attachedRun = await this.#client.mutate('attach-run', {
        repoId,
        workstreamRun: input.active.workstream_run,
        sessionId: null,
        fencingGeneration: null,
        expectedVersion: 0,
        idempotencyKey: `attach-run:${repoId}:${input.active.workstream_run}`,
      }, {
        repo_key: input.repo.repoKey,
        canonical_root: input.repo.repoRoot,
        git_common_dir: input.repo.gitCommonDir,
        autopilot_id: input.active.autopilot_id,
        workstream: input.active.workstream,
        coordination_authority: input.active.coordination_authority,
        run_resource: {
          schema_version: 'autopilot.coordination_run_resource.v1',
          repo_id: repoId,
          workstream_run: input.active.workstream_run,
          source_repo: input.active.source_repo,
          git_common_dir: input.active.git_common_dir,
          worktree_root: input.active.worktree_root,
          main_worktree_path: input.active.main_worktree_path,
          runtime_root: input.active.runtime_root,
          branch: input.active.branch,
          target_branch: input.active.target_branch,
          target_base_sha: input.active.target_base_sha,
          origin_url: input.active.origin_url,
          started_at: input.active.started_at,
          version: 1,
        },
      });
      run = parseCoordinationRun(payloadRecord(attachedRun, 'run'));
    } else if (runValues.length === 1) {
      run = parseCoordinationRun(runValues[0]);
      if (run.autopilot_id !== input.active.autopilot_id || run.workstream !== input.active.workstream || run.coordination_authority !== input.active.coordination_authority) throw new CoordinationRuntimeError('invalid-state', 'durable run supervisor identity or coordination authority disagrees with the active Autopilot row');
    } else {
      throw new CoordinationRuntimeError('invalid-state', 'coordinator returned duplicate durable run supervisors');
    }
    const generation = run.active_session_generation + 1;
    const sessionLeaseId = `session-lease-${randomUUID()}`;
    const sessionToken = randomBytes(32).toString('hex');
    const attachSession = await this.#client.mutate('attach-session', {
      repoId,
      workstreamRun: run.workstream_run,
      sessionId,
      fencingGeneration: generation,
      expectedVersion: run.version,
      idempotencyKey: `attach-session:${repoId}:${run.workstream_run}:${sessionLeaseId}`,
    }, {
      session_lease_id: sessionLeaseId,
      session_token: sessionToken,
      pid: process.pid,
      boot_id: currentBootId(),
      lease_expires_at: leaseExpiry(),
      handoff_token: input.handoffToken ?? null,
    });
    const attachedRun = parseCoordinationRun(payloadRecord(attachSession, 'run'));
    const session = parseCoordinationSessionLease(payloadRecord(attachSession, 'session'));
    const context: CoordinatorSessionContext = {
      schema_version: AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA,
      state_root: this.#client.paths.stateRoot,
      repo_id: repoId,
      repo_key: input.repo.repoKey,
      autopilot_id: input.active.autopilot_id,
      workstream: input.active.workstream,
      workstream_run: input.active.workstream_run,
      session_id: session.session_id,
      session_generation: session.session_generation,
      run_version: attachedRun.version,
      session_lease_id: session.session_lease_id,
      session_token: sessionToken,
      session_version: session.version,
      pid: session.pid,
      boot_id: session.boot_id,
    };
    const contextPath = join(this.#client.paths.sessionsRoot, `${createHash('sha256').update(`${repoId}\0${run.workstream_run}\0${session.session_lease_id}`, 'utf8').digest('hex')}.json`);
    await writeCoordinatorSessionContext(contextPath, context);
    return { run: attachedRun, session, contextPath, context };
  }

  async attachTerminalRecovery(input: { readonly repo: AutopilotRepoIdentity; readonly active: ActiveAutopilotRow; readonly rawSessionId: string }): Promise<RunSupervisorAttachment> {
    const repoId = input.repo.repoKey;
    const status = await this.#client.query('status', repoId, input.active.workstream_run);
    const runValues = payloadArray(status, 'runs');
    if (runValues.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'terminal-cleanup recovery requires exactly one durable run supervisor');
    const run = parseCoordinationRun(runValues[0]);
    if ((run.status !== 'closed' && run.status !== 'aborted') || run.autopilot_id !== input.active.autopilot_id || run.workstream !== input.active.workstream || run.coordination_authority !== 'coordinator-edit-leases-v1') throw new CoordinationRuntimeError('unauthorized-client', 'terminal-cleanup recovery identity does not match the durable terminal run');
    const intentValues = payloadArray(status, 'run_terminal_intents').map((value) => parseCoordinationRunTerminalIntent(value));
    const intents = intentValues.filter((intent) => intent.state === 'committed');
    if (intents.length !== 1 || intents[0] === undefined || intents[0].outcome !== run.status) throw new CoordinationRuntimeError('invalid-state', 'terminal-cleanup recovery requires one matching committed terminal intent');
    const generation = run.active_session_generation + 1;
    const sessionLeaseId = `terminal-recovery-lease-${randomUUID()}`;
    const sessionToken = randomBytes(32).toString('hex');
    const response = await this.#client.mutate('attach-terminal-recovery', {
      repoId, workstreamRun: run.workstream_run, sessionId: durableIdentifier('terminal-recovery-session', input.rawSessionId),
      fencingGeneration: generation, expectedVersion: run.version, idempotencyKey: durableIdentifier('attach-terminal-recovery', `${repoId}\0${run.workstream_run}\0${sessionLeaseId}`),
    }, {
      session_lease_id: sessionLeaseId, session_token: sessionToken, pid: process.pid, boot_id: currentBootId(),
      lease_expires_at: leaseExpiry(), terminal_intent_id: intents[0].terminal_intent_id,
    });
    const attachedRun = parseCoordinationRun(payloadRecord(response, 'run'));
    const session = parseCoordinationSessionLease(payloadRecord(response, 'session'));
    if (attachedRun.status !== run.status) throw new CoordinationRuntimeError('store-corrupt', 'terminal recovery attachment reactivated a terminal run');
    const context: CoordinatorSessionContext = {
      schema_version: AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA, state_root: this.#client.paths.stateRoot, repo_id: repoId, repo_key: input.repo.repoKey,
      autopilot_id: input.active.autopilot_id, workstream: input.active.workstream, workstream_run: input.active.workstream_run,
      session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
      session_lease_id: session.session_lease_id, session_token: sessionToken, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
    };
    const contextPath = join(this.#client.paths.sessionsRoot, `${createHash('sha256').update(`${repoId}\0${run.workstream_run}\0${session.session_lease_id}`, 'utf8').digest('hex')}.json`);
    await writeCoordinatorSessionContext(contextPath, context);
    return { run: attachedRun, session, contextPath, context };
  }

  async attachMigrationRecovery(input: { readonly repo: AutopilotRepoIdentity; readonly workstreamRun: string; readonly recoveryId: string; readonly rawSessionId: string }): Promise<RunSupervisorAttachment> {
    return await this.withMigrationRecoveryAuthority(async (operationToken) => {
    const repoId = input.repo.repoKey;
    const status = await this.#client.query('migration-recovery', repoId, input.workstreamRun, { cursor_recovery_id: null, cursor_run: null, include_resolved: false, limit: 1, recovery_id: input.recoveryId });
    const runs = payloadArray(status, 'runs').map((value) => parseCoordinationRun(value));
    if (runs.length !== 1 || runs[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'migration recovery requires exactly one durable run supervisor');
    const run = runs[0];
    if (run.coordination_authority !== 'coordinator-edit-leases-v1') throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery requires coordinator sole authority');
    const pending = payloadArray(status, 'recovery').map((value) => parseCoordinationMigrationRecoveryWork(value)).filter((work) => work.status === 'pending');
    if (!pending.some((work) => work.recovery_id === input.recoveryId)) throw new CoordinationRuntimeError('invalid-state', 'requested migration recovery row is not pending for the durable run', [input.recoveryId]);
    const generation = run.active_session_generation + 1;
    const sessionLeaseId = `migration-recovery-lease-${randomUUID()}`;
    const sessionToken = randomBytes(32).toString('hex');
    const response = await this.#client.mutate('attach-migration-recovery', {
      repoId, workstreamRun: run.workstream_run, sessionId: durableIdentifier('migration-recovery-session', input.rawSessionId),
      fencingGeneration: generation, expectedVersion: run.version, idempotencyKey: durableIdentifier('attach-migration-recovery', `${repoId}\0${run.workstream_run}\0${sessionLeaseId}`),
    }, {
      recovery_id: input.recoveryId, session_lease_id: sessionLeaseId, session_token: sessionToken, pid: process.pid, boot_id: currentBootId(), lease_expires_at: leaseExpiry(), migration_operation_token: operationToken,
    });
    const attachedRun = parseCoordinationRun(payloadRecord(response, 'run'));
    const session = parseCoordinationSessionLease(payloadRecord(response, 'session'));
    if (session.attachment_kind !== 'migration-recovery' || attachedRun.status !== run.status) throw new CoordinationRuntimeError('store-corrupt', 'migration recovery attachment acquired ordinary dispatch or changed durable run status');
    const context: CoordinatorSessionContext = {
      schema_version: AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA, state_root: this.#client.paths.stateRoot, repo_id: repoId, repo_key: input.repo.repoKey,
      autopilot_id: run.autopilot_id, workstream: run.workstream, workstream_run: run.workstream_run,
      session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
      session_lease_id: session.session_lease_id, session_token: sessionToken, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
    };
    const contextPath = join(this.#client.paths.sessionsRoot, `${createHash('sha256').update(`${repoId}\0${run.workstream_run}\0${session.session_lease_id}`, 'utf8').digest('hex')}.json`);
    await writeCoordinatorSessionContext(contextPath, context);
    return { run: attachedRun, session, contextPath, context };
    });
  }

  async resolveMigrationRecovery(input: { readonly attachment: RunSupervisorAttachment; readonly recoveryWork: CoordinationMigrationRecoveryWork; readonly resolution: MigrationRecoveryResolutionInput; readonly afterEvidenceBoundary?: (boundary: MigrationRecoveryEvidenceBoundary) => void | Promise<void> }): Promise<MigrationRecoveryResolutionResult> {
    return await this.withMigrationRecoveryAuthority(async (operationToken) => {
    if (input.attachment.session.attachment_kind !== 'migration-recovery') throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery mutation requires a recovery-only supervisor attachment');
    const session = input.attachment.session;
    const work = input.recoveryWork;
    if (work.status !== 'pending' || work.repo_id !== session.repo_id || work.workstream_run !== session.workstream_run) throw new CoordinationRuntimeError('invalid-request', 'migration recovery mutation work identity does not match its recovery-only session');
    const detail = work.detail;
    let evidenceBytes: Uint8Array;
    let releaseSource: string | null = null;
    let releaseTargetId: string | null = null;
    if (input.resolution.resolutionType === 'authority-retained') {
      evidenceBytes = new TextEncoder().encode(`${JSON.stringify({
        schema_version: 'autopilot.migration_authority_recovery.v1', repo_id: work.repo_id, autopilot_id: input.attachment.run.autopilot_id,
        workstream: input.attachment.run.workstream, workstream_run: work.workstream_run, recovery_id: work.recovery_id,
        resolution_type: 'authority-retained', claim_path: detail['claim_path'], claim_mode: detail['claim_mode'], unit_id: detail['unit_id'], attempt: detail['attempt'], edit_lease_id: detail['edit_lease_id'], recorded_event_seq: work.created_event_seq,
      }, null, 2)}\n`);
    } else {
      evidenceBytes = input.resolution.evidenceBytes;
      releaseSource = input.resolution.releaseSource;
      releaseTargetId = input.resolution.releaseTargetId;
    }
    const evidenceSha256 = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}` as `sha256:${string}`;
    const evidenceRef = `${createHash('sha256').update(`${work.recovery_id}\0${input.resolution.resolutionType}\0${evidenceSha256}`, 'utf8').digest('hex')}.json`;
    const evidenceRoot = join(this.#client.paths.stateRoot, 'migration-recovery-evidence', work.repo_id, work.workstream_run);
    const evidencePath = join(evidenceRoot, evidenceRef);
    await publishMigrationRecoveryEvidence({ stateRoot: this.#client.paths.stateRoot, evidenceRoot, evidencePath, evidenceBytes, ...(input.afterEvidenceBoundary === undefined ? {} : { afterBoundary: input.afterEvidenceBoundary }) });
    const idempotencyKey = durableIdentifier('resolve-migration-recovery', `${work.recovery_id}\0${input.resolution.resolutionType}\0${evidenceSha256}`);
    const response = await this.#client.mutate('resolve-migration-recovery', {
      repoId: work.repo_id, workstreamRun: work.workstream_run, sessionId: session.session_id, fencingGeneration: session.session_generation,
      expectedVersion: work.version, idempotencyKey,
    }, {
      recovery_id: work.recovery_id, resolution_type: input.resolution.resolutionType, evidence_ref: evidenceRef, evidence_sha256: evidenceSha256,
      release_source: releaseSource, release_target_id: releaseTargetId, session_lease_id: session.session_lease_id, session_token: input.attachment.context.session_token, migration_operation_token: operationToken,
    });
    const recoveryWork = parseCoordinationMigrationRecoveryWork(response.payload['recovery_work']);
    const remainingRecoveryCount = requireInteger(response.payload, 'remaining_recovery_count');
    const run = parseCoordinationRun(response.payload['run']);
    if (run.status !== input.attachment.run.status) throw new CoordinationRuntimeError('store-corrupt', 'migration recovery resolution changed durable run terminal/recovery state');
    return { recoveryWork, remainingRecoveryCount, run };
    });
  }

  async heartbeatMigrationRecovery(attachment: RunSupervisorAttachment): Promise<RunSupervisorAttachment> {
    if (attachment.session.attachment_kind !== 'migration-recovery') throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery heartbeat requires a recovery-only supervisor attachment');
    return await this.withMigrationRecoveryAuthority(async (operationToken) => {
      const response = await this.#client.mutate('heartbeat', {
        repoId: attachment.context.repo_id, workstreamRun: attachment.context.workstream_run, sessionId: attachment.session.session_id,
        fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.session.version,
        idempotencyKey: durableIdentifier('heartbeat-migration-recovery', `${attachment.session.session_lease_id}\0${String(attachment.session.version)}`),
      }, { lease_expires_at: leaseExpiry(), session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token, migration_operation_token: operationToken });
      const session = parseCoordinationSessionLease(payloadRecord(response, 'session'));
      if (session.attachment_kind !== 'migration-recovery') throw new CoordinationRuntimeError('store-corrupt', 'migration recovery heartbeat changed the session attachment kind');
      const context = { ...attachment.context, session_version: session.version };
      await writeCoordinatorSessionContext(attachment.contextPath, context);
      return { ...attachment, session, context };
    });
  }

  async detachMigrationRecovery(attachment: RunSupervisorAttachment, reason = 'migration recovery completed'): Promise<void> {
    if (attachment.session.attachment_kind !== 'migration-recovery') throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery detach requires a recovery-only supervisor attachment');
    await this.withMigrationRecoveryAuthority(async (operationToken) => {
      await this.#client.mutate('detach-session', {
        repoId: attachment.context.repo_id, workstreamRun: attachment.context.workstream_run, sessionId: attachment.session.session_id,
        fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.session.version,
        idempotencyKey: durableIdentifier('detach-migration-recovery', attachment.session.session_lease_id),
      }, { reason, session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token, migration_operation_token: operationToken });
      await unlink(attachment.contextPath).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      });
    });
  }
}

export class AutopilotSessionBridge {
  readonly #supervisor: DurableRunSupervisorClient;
  readonly #sink: CoordinationMessageSink;
  readonly #recoverOwnedOperations: ((contextPath: string) => Promise<void>) | null;
  #attachment: RunSupervisorAttachment;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #handoffPrepared = false;
  #fatalError: Error | null = null;
  #operation: Promise<void> = Promise.resolve();

  private constructor(supervisor: DurableRunSupervisorClient, attachment: RunSupervisorAttachment, sink: CoordinationMessageSink, recoverOwnedOperations: ((contextPath: string) => Promise<void>) | null) {
    this.#supervisor = supervisor;
    this.#attachment = attachment;
    this.#sink = sink;
    this.#recoverOwnedOperations = recoverOwnedOperations;
  }

  static async start(input: { readonly repo: AutopilotRepoIdentity; readonly active: ActiveAutopilotRow; readonly rawSessionId: string; readonly sink: CoordinationMessageSink; readonly env?: ProcessEnvLike; readonly recoverOwnedOperations?: (contextPath: string) => Promise<void>; readonly onAttachedBeforeMailbox?: (bridge: AutopilotSessionBridge) => void | Promise<void> }): Promise<AutopilotSessionBridge> {
    const supervisor = new DurableRunSupervisorClient(input.env ?? process.env);
    const attachment = await supervisor.attach({ repo: input.repo, active: input.active, rawSessionId: input.rawSessionId });
    const bridge = new AutopilotSessionBridge(supervisor, attachment, input.sink, input.recoverOwnedOperations ?? null);
    await input.onAttachedBeforeMailbox?.(bridge);
    await bridge.reconcileOwnedRun('session-attachment-before-mailbox-and-dispatch');
    if (bridge.#recoverOwnedOperations !== null) await bridge.#recoverOwnedOperations(bridge.#attachment.contextPath);
    await bridge.drainMailbox();
    bridge.#startHeartbeat();
    return bridge;
  }

  get attachment(): RunSupervisorAttachment {
    return this.#attachment;
  }

  async reconcileOwnedRun(reason = 'explicit-owned-run-reconciliation'): Promise<void> {
    await this.#enqueue(async () => {
      this.#assertOpen();
      const session = this.#attachment.session;
      await this.#supervisor.client.mutate('reconcile-run', {
        repoId: session.repo_id,
        workstreamRun: session.workstream_run,
        sessionId: session.session_id,
        fencingGeneration: session.session_generation,
        expectedVersion: this.#attachment.context.run_version,
        idempotencyKey: `reconcile-run:${session.session_lease_id}:${randomUUID()}`,
      }, { reason, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
    });
  }

  async drainMailbox(): Promise<readonly CoordinationMessage[]> {
    let delivered: readonly CoordinationMessage[] = [];
    await this.#enqueue(async () => {
      this.#assertOpen();
      delivered = await this.#drainMailboxNow();
    });
    return delivered;
  }

  async #drainMailboxNow(): Promise<readonly CoordinationMessage[]> {
    const session = this.#attachment.session;
    const response = await this.#supervisor.client.mutate('drain-mailbox', {
      repoId: session.repo_id,
      workstreamRun: session.workstream_run,
      sessionId: session.session_id,
      fencingGeneration: session.session_generation,
      expectedVersion: session.version,
      idempotencyKey: `drain-mailbox:${session.session_lease_id}:${randomUUID()}`,
    }, { delivery_id: `delivery-${randomUUID()}`, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
    const delivered = Object.freeze(payloadArray(response, 'messages').map((value) => parseCoordinationMessage(value)));
    for (const message of delivered) {
      this.#sink.send({ customType: 'autopilot-coordination', content: messageContent(message), display: true, details: { message_id: message.message_id, message_type: message.message_type, correlation_id: message.correlation_id } }, this.#sink.isIdle() ? 'steer' : 'followUp', true);
      await this.#supervisor.client.mutate('acknowledge-message', {
        repoId: session.repo_id,
        workstreamRun: session.workstream_run,
        sessionId: session.session_id,
        fencingGeneration: session.session_generation,
        expectedVersion: message.version,
        idempotencyKey: `ack-message:${message.message_id}`,
      }, { message_id: message.message_id, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
    }
    return delivered;
  }

  async prepareHandoff(): Promise<string> {
    let token = '';
    await this.#enqueue(async () => {
      this.#assertOpen();
      this.#stopHeartbeat();
      const session = this.#attachment.session;
      token = `handoff-${randomUUID()}`;
      try {
        const response = await this.#supervisor.client.mutate('prepare-handoff', {
          repoId: session.repo_id,
          workstreamRun: session.workstream_run,
          sessionId: session.session_id,
          fencingGeneration: session.session_generation,
          expectedVersion: session.version,
          idempotencyKey: `prepare-handoff:${session.session_lease_id}`,
        }, { handoff_token: token, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
        const nextSession = parseCoordinationSessionLease(payloadRecord(response, 'session'));
        this.#attachment = { ...this.#attachment, session: nextSession, context: { ...this.#attachment.context, session_version: nextSession.version } };
        this.#handoffPrepared = true;
        await writeCoordinatorSessionContext(this.#attachment.contextPath, this.#attachment.context);
      } catch (error) {
        if (!this.#handoffPrepared) this.#startHeartbeat();
        throw error;
      }
    });
    return token;
  }

  async acceptTerminalDetach(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#closed) return;
      this.#stopHeartbeat();
      this.#closed = true;
    });
  }

  async close(reason = 'session-shutdown'): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#closed) return;
      this.#stopHeartbeat();
      if (this.#handoffPrepared) {
        this.#closed = true;
        return;
      }
      const session = this.#attachment.session;
      const response = await this.#supervisor.client.mutate('detach-session', {
        repoId: session.repo_id,
        workstreamRun: session.workstream_run,
        sessionId: session.session_id,
        fencingGeneration: session.session_generation,
        expectedVersion: session.version,
        idempotencyKey: `detach-session:${session.session_lease_id}`,
      }, { reason, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
      const nextSession = parseCoordinationSessionLease(payloadRecord(response, 'session'));
      this.#attachment = { ...this.#attachment, session: nextSession, context: { ...this.#attachment.context, session_version: nextSession.version } };
      await writeCoordinatorSessionContext(this.#attachment.contextPath, this.#attachment.context);
      this.#closed = true;
    });
  }

  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      void this.#enqueue(async () => {
        if (this.#closed || this.#handoffPrepared) return;
        const session = this.#attachment.session;
        const stateRoot = this.#supervisor.client.paths.stateRoot;
        const migrationFreeze = activeCoordinationMigrationFreeze(stateRoot);
        if (migrationFreeze !== null) {
          acknowledgeCoordinationMigrationFreeze(stateRoot, session.repo_id);
          const detached = await this.#supervisor.client.mutate('detach-session', {
            repoId: session.repo_id,
            workstreamRun: session.workstream_run,
            sessionId: session.session_id,
            fencingGeneration: session.session_generation,
            expectedVersion: session.version,
            idempotencyKey: `migration-freeze-detach:${session.session_lease_id}`,
          }, { reason: 'coordination-migration-freeze', session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
          const detachedSession = parseCoordinationSessionLease(payloadRecord(detached, 'session'));
          this.#attachment = { ...this.#attachment, session: detachedSession, context: { ...this.#attachment.context, session_version: detachedSession.version } };
          await writeCoordinatorSessionContext(this.#attachment.contextPath, this.#attachment.context);
          this.#closed = true;
          this.#stopHeartbeat();
          this.#sink.send({ customType: 'autopilot-coordination', content: 'Autopilot session drained and fenced for the active coordination migration freeze.', display: true, details: { freeze: migrationFreeze } }, this.#sink.isIdle() ? 'steer' : 'followUp', true);
          return;
        }
        const response = await this.#supervisor.client.mutate('heartbeat', {
          repoId: session.repo_id,
          workstreamRun: session.workstream_run,
          sessionId: session.session_id,
          fencingGeneration: session.session_generation,
          expectedVersion: session.version,
          idempotencyKey: `heartbeat:${session.session_lease_id}:${String(session.version)}`,
        }, { lease_expires_at: leaseExpiry(), session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
        const nextSession = parseCoordinationSessionLease(payloadRecord(response, 'session'));
        this.#attachment = { ...this.#attachment, session: nextSession, context: { ...this.#attachment.context, session_version: nextSession.version } };
        await writeCoordinatorSessionContext(this.#attachment.contextPath, this.#attachment.context);
        await this.#drainMailboxNow();
        if (this.#recoverOwnedOperations !== null) await this.#recoverOwnedOperations(this.#attachment.contextPath);
      }).catch((error: unknown) => {
        this.#fatalError = error instanceof Error ? error : new Error(String(error));
        this.#stopHeartbeat();
        try {
          this.#sink.send({
            customType: 'autopilot-coordination',
            content: `Autopilot coordination heartbeat halted loudly: ${this.#fatalError.message}`,
            display: true,
            details: { error_code: 'coordinator-unavailable' },
          }, this.#sink.isIdle() ? 'steer' : 'followUp', false);
        } catch (notificationError) {
          this.#fatalError = new Error(`coordinator heartbeat failed (${this.#fatalError.message}) and Pi notification delivery failed (${notificationError instanceof Error ? notificationError.message : String(notificationError)})`);
        }
      });
    }, COORDINATOR_HEARTBEAT_MS);

  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  #assertOpen(): void {
    if (this.#closed) throw new CoordinationRuntimeError('fenced-session', 'session bridge is closed');
    if (this.#fatalError !== null) throw new CoordinationRuntimeError('coordinator-unavailable', this.#fatalError.message);
  }

  #enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(run, run);
    this.#operation = next.catch(() => undefined);
    return next;
  }
}
