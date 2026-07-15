import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { assertPrivatePathNoAliases } from '../private-path.ts';
import { COORDINATOR_COMPILED_ENTRYPOINT_ENV } from './executable-resolution.ts';
import { COORDINATION_FAILURE_CODES, CoordinationRuntimeError, coordinationFailureDefinition, formatCoordinationRuntimeError, sanitizeCoordinationDiagnosticText, type CoordinationFailureClass, type CoordinationFailureCode } from './failures.ts';
import { isExactProcessAlive } from './process-identity.ts';
import { enforcePrivateAuthorityPath, ensureCoordinatorPrivateRoots, type CoordinatorRuntimePaths } from './runtime-paths.ts';
import { readExactLockText } from './serialized-lock.ts';
import { parseCurrentCoordinatorLock, type CurrentCoordinatorLock } from './upgrade-contracts.ts';

export const COORDINATOR_STARTUP_BARRIER_ROOT_ENV = 'AUTOPILOT_COORDINATOR_STARTUP_BARRIER_ROOT';
export const COORDINATOR_STARTUP_ATTEMPT_ID_ENV = 'AUTOPILOT_COORDINATOR_STARTUP_ATTEMPT_ID';
export const COORDINATOR_STARTUP_REPORT_SCHEMA = 'autopilot.coordinator_startup_report.v1' as const;
const STARTUP_REPORT_MAX_BYTES = 32 * 1024;
const STARTUP_REPORT_RETENTION = 64;
const STARTUP_FAILURE_CLASSES: readonly CoordinationFailureClass[] = ['client-invalid', 'retryable-contention', 'fenced-client', 'owned-recovery', 'contradiction-review', 'system-fatal'];

export const COORDINATOR_STARTUP_PHASES = [
  'bootstrap/import',
  'before-lifecycle-election',
  'after-lifecycle-lock-acquisition',
  'before-private-root-capability-setup',
  'after-private-root-capability-setup',
  'before-sqlite-open-reconciliation',
  'after-sqlite-open-reconciliation',
  'before-socket-bind',
  'after-listen-before-lifecycle-activation',
  'after-activation-before-first-handshake',
  'first-exact-handshake-served',
] as const;

export type CoordinatorStartupPhase = (typeof COORDINATOR_STARTUP_PHASES)[number];
export type CoordinatorStartupOutcome = 'running' | 'ready' | 'election-loser' | 'failed';

export interface SafeCoordinatorLifecycleIdentity {
  readonly schema_version: string;
  readonly pid: number;
  readonly boot_id: string;
  readonly process_start_identity: string;
  readonly instance_id: string;
  readonly package_build: string;
  readonly protocol_version: string;
  readonly database_schema_version: number;
  readonly started_at: string;
}

export interface CoordinatorStartupReport {
  readonly schema_version: typeof COORDINATOR_STARTUP_REPORT_SCHEMA;
  readonly attempt_id: string;
  readonly spawned_pid: number;
  readonly outcome: CoordinatorStartupOutcome;
  readonly phase: CoordinatorStartupPhase;
  readonly selected_compiled_entrypoint: string | null;
  readonly exact_competing_lifecycle_owner_observed: boolean;
  readonly lifecycle: SafeCoordinatorLifecycleIdentity | null;
  readonly error: string | null;
  readonly failure_code: CoordinationFailureCode | null;
  readonly failure_class: CoordinationFailureClass | null;
  readonly diagnostics_truncated: boolean;
  readonly omitted_code_points: number;
  readonly updated_at: string;
}

interface StartupObservationEnv {
  readonly [key: string]: string | undefined;
}

export interface CoordinatorStartupObserver {
  readonly attemptId: string;
  readonly reportPath: string;
  transition(phase: CoordinatorStartupPhase, lifecycle?: CurrentCoordinatorLock): Promise<void>;
  electionLoser(error: unknown): Promise<void>;
  failed(error: unknown): Promise<void>;
}

function validAttemptId(value: string): boolean {
  return /^startup-[a-f0-9]{24,64}$/u.test(value);
}

export function createCoordinatorStartupAttemptId(): string {
  return `startup-${randomBytes(16).toString('hex')}`;
}

export function coordinatorStartupReportPath(paths: CoordinatorRuntimePaths, attemptId: string): string {
  if (!validAttemptId(attemptId)) throw new CoordinationRuntimeError('invalid-request', 'coordinator startup attempt id is malformed');
  return join(paths.startupReportsRoot, `${attemptId}.json`);
}

function safeLifecycle(lock: CurrentCoordinatorLock): SafeCoordinatorLifecycleIdentity {
  return {
    schema_version: lock.schema_version,
    pid: lock.pid,
    boot_id: lock.boot_id,
    process_start_identity: lock.process_start_identity,
    instance_id: lock.instance_id,
    package_build: lock.package_build,
    protocol_version: lock.protocol_version,
    database_schema_version: lock.database_schema_version,
    started_at: lock.started_at,
  };
}

async function exactCurrentLifecycle(paths: CoordinatorRuntimePaths): Promise<CurrentCoordinatorLock | null> {
  const text = await readExactLockText(paths.lockPath);
  if (text === null) return null;
  let lock: CurrentCoordinatorLock | null = null;
  try { lock = parseCurrentCoordinatorLock(JSON.parse(text) as unknown); } catch { return null; }
  return lock !== null && isExactProcessAlive(lock.pid, lock.process_start_identity) ? lock : null;
}

function boundedError(error: unknown): { readonly text: string; readonly truncated: boolean; readonly omitted: number } {
  const raw = error instanceof CoordinationRuntimeError
    ? formatCoordinationRuntimeError(error)
    : error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  const sanitized = sanitizeCoordinationDiagnosticText(raw, 4_096);
  const truncated = sanitized.includes('…[truncated]');
  const originalLength = [...raw].length;
  return { text: sanitized, truncated, omitted: truncated ? Math.max(1, originalLength - 4_096) : 0 };
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EISDIR') throw error;
  } finally { await handle?.close(); }
}

async function writeReportAtomic(paths: CoordinatorRuntimePaths, path: string, report: CoordinatorStartupReport): Promise<void> {
  const text = `${JSON.stringify(report)}\n`;
  if (Buffer.byteLength(text, 'utf8') > STARTUP_REPORT_MAX_BYTES) throw new CoordinationRuntimeError('system-fatal', 'bounded coordinator startup report exceeded its package limit');
  assertPrivatePathNoAliases(paths.startupReportsRoot);
  assertPrivatePathNoAliases(path);
  const temporary = join(paths.startupReportsRoot, `.${basename(path)}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`);
  // wx is itself no-follow safe for the final path: an existing symlink is an
  // EEXIST collision rather than a followed target.
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await enforcePrivateAuthorityPath(temporary, false);
  await rename(temporary, path);
  await enforcePrivateAuthorityPath(path, false);
  await syncDirectory(paths.startupReportsRoot);
}

async function pruneReports(paths: CoordinatorRuntimePaths, retainedPath: string): Promise<void> {
  const entries = await readdir(paths.startupReportsRoot, { withFileTypes: true });
  const reports: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(paths.startupReportsRoot, entry.name);
    assertPrivatePathNoAliases(path);
    const info = await stat(path);
    if (/^\.startup-[a-f0-9]{24,64}\.json\.\d+\.[a-f0-9]{16}\.tmp$/u.test(entry.name)) {
      if (Date.now() - info.mtimeMs > 300_000) await rm(path, { force: true });
      continue;
    }
    if (!/^startup-[a-f0-9]{24,64}\.json$/u.test(entry.name)) continue;
    reports.push({ path, mtimeMs: info.mtimeMs });
  }
  reports.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  for (const report of reports.slice(STARTUP_REPORT_RETENTION)) if (report.path !== retainedPath) await rm(report.path, { force: true });
}

async function waitAtBarrier(paths: CoordinatorRuntimePaths, phase: CoordinatorStartupPhase, env: StartupObservationEnv): Promise<void> {
  const configured = env[COORDINATOR_STARTUP_BARRIER_ROOT_ENV];
  if (configured === undefined) return;
  if (!isAbsolute(configured)) throw new CoordinationRuntimeError('invalid-request', `${COORDINATOR_STARTUP_BARRIER_ROOT_ENV} must be absolute`);
  const root = resolve(configured);
  const allowedRoot = resolve(paths.stateRoot, 'test-startup-barriers');
  const relativeRoot = relative(allowedRoot, root);
  if (relativeRoot.startsWith('..') || isAbsolute(relativeRoot)) throw new CoordinationRuntimeError('invalid-request', 'coordinator startup barrier root must stay inside the isolated state-root test barrier directory');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await enforcePrivateAuthorityPath(root, true);
  const pause = join(root, `pause.${phase}`);
  try { await stat(pause); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  const reached = join(root, `reached.${phase}`);
  try { await writeFile(reached, 'reached\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  await enforcePrivateAuthorityPath(reached, false);
  const release = join(root, `release.${phase}`);
  for (;;) {
    try { await stat(release); return; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

export async function createCoordinatorStartupObserver(paths: CoordinatorRuntimePaths, attemptId: string, env: StartupObservationEnv = process.env): Promise<CoordinatorStartupObserver> {
  await ensureCoordinatorPrivateRoots(paths, env);
  await mkdir(paths.startupReportsRoot, { recursive: true, mode: 0o700 });
  await enforcePrivateAuthorityPath(paths.startupReportsRoot, true, env);
  const reportPath = coordinatorStartupReportPath(paths, attemptId);
  let phase: CoordinatorStartupPhase = 'before-lifecycle-election';
  let lifecycle: CurrentCoordinatorLock | null = null;
  let outcome: CoordinatorStartupOutcome = 'running';
  const selectedCompiledEntrypoint = env[COORDINATOR_COMPILED_ENTRYPOINT_ENV] ?? null;
  if (selectedCompiledEntrypoint !== null && !isAbsolute(selectedCompiledEntrypoint)) throw new CoordinationRuntimeError('invalid-request', 'selected compiled coordinator entrypoint must be absolute');

  const publish = async (error: unknown | null): Promise<void> => {
    const bounded = error === null ? null : boundedError(error);
    await writeReportAtomic(paths, reportPath, {
      schema_version: COORDINATOR_STARTUP_REPORT_SCHEMA,
      attempt_id: attemptId,
      spawned_pid: process.pid,
      outcome,
      phase,
      selected_compiled_entrypoint: selectedCompiledEntrypoint,
      exact_competing_lifecycle_owner_observed: outcome === 'election-loser' && lifecycle !== null,
      lifecycle: lifecycle === null ? null : safeLifecycle(lifecycle),
      error: bounded?.text ?? null,
      failure_code: error instanceof CoordinationRuntimeError ? error.code : null,
      failure_class: error instanceof CoordinationRuntimeError ? error.failure_class : null,
      diagnostics_truncated: bounded?.truncated ?? false,
      omitted_code_points: bounded?.omitted ?? 0,
      updated_at: new Date().toISOString(),
    });
  };

  const observer: CoordinatorStartupObserver = {
    attemptId,
    reportPath,
    transition: async (nextPhase, observedLifecycle) => {
      phase = nextPhase;
      if (observedLifecycle !== undefined) lifecycle = observedLifecycle;
      if (nextPhase === 'first-exact-handshake-served') outcome = 'ready';
      await publish(null);
      await waitAtBarrier(paths, nextPhase, env);
    },
    electionLoser: async (error) => {
      outcome = 'election-loser';
      lifecycle = await exactCurrentLifecycle(paths);
      await publish(error);
    },
    failed: async (error) => {
      outcome = 'failed';
      lifecycle = await exactCurrentLifecycle(paths);
      await publish(error);
    },
  };
  await pruneReports(paths, reportPath);
  return observer;
}

export function readCoordinatorStartupReport(path: string, expectedAttemptId: string): CoordinatorStartupReport | null {
  if (!validAttemptId(expectedAttemptId) || dirname(path) === path) return null;
  let descriptor: number | null = null;
  try {
    assertPrivatePathNoAliases(path);
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size < 2 || info.size > STARTUP_REPORT_MAX_BYTES) return null;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    const value: unknown = JSON.parse(bytes.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const report = value as Readonly<Record<string, unknown>>;
    const phase = report['phase'];
    const outcome = report['outcome'];
    const selectedCompiledEntrypoint = report['selected_compiled_entrypoint'];
    if (report['schema_version'] !== COORDINATOR_STARTUP_REPORT_SCHEMA || report['attempt_id'] !== expectedAttemptId || typeof report['spawned_pid'] !== 'number' || !Number.isSafeInteger(report['spawned_pid']) || report['spawned_pid'] < 1 || typeof phase !== 'string' || !COORDINATOR_STARTUP_PHASES.includes(phase as CoordinatorStartupPhase) || (outcome !== 'running' && outcome !== 'ready' && outcome !== 'election-loser' && outcome !== 'failed') || (selectedCompiledEntrypoint !== null && (typeof selectedCompiledEntrypoint !== 'string' || !isAbsolute(selectedCompiledEntrypoint))) || typeof report['exact_competing_lifecycle_owner_observed'] !== 'boolean' || (report['error'] !== null && typeof report['error'] !== 'string') || (report['failure_code'] !== null && (typeof report['failure_code'] !== 'string' || !COORDINATION_FAILURE_CODES.includes(report['failure_code'] as CoordinationFailureCode))) || (report['failure_class'] !== null && (typeof report['failure_class'] !== 'string' || !STARTUP_FAILURE_CLASSES.includes(report['failure_class'] as CoordinationFailureClass))) || typeof report['diagnostics_truncated'] !== 'boolean' || typeof report['omitted_code_points'] !== 'number' || !Number.isSafeInteger(report['omitted_code_points']) || report['omitted_code_points'] < 0 || typeof report['updated_at'] !== 'string') return null;
    const failureCode = report['failure_code'] as CoordinationFailureCode | null;
    const failureClass = report['failure_class'] as CoordinationFailureClass | null;
    if ((failureCode === null) !== (failureClass === null) || (failureCode !== null && coordinationFailureDefinition(failureCode).failure_class !== failureClass)) return null;
    const lifecycleValue = report['lifecycle'];
    let lifecycleIdentity: SafeCoordinatorLifecycleIdentity | null = null;
    if (lifecycleValue !== null) {
      if (typeof lifecycleValue !== 'object' || Array.isArray(lifecycleValue)) return null;
      const candidate = lifecycleValue as Readonly<Record<string, unknown>>;
      if (typeof candidate['schema_version'] !== 'string' || typeof candidate['pid'] !== 'number' || typeof candidate['boot_id'] !== 'string' || typeof candidate['process_start_identity'] !== 'string' || typeof candidate['instance_id'] !== 'string' || typeof candidate['package_build'] !== 'string' || typeof candidate['protocol_version'] !== 'string' || typeof candidate['database_schema_version'] !== 'number' || typeof candidate['started_at'] !== 'string' || Object.hasOwn(candidate, 'token')) return null;
      lifecycleIdentity = {
        schema_version: candidate['schema_version'],
        pid: candidate['pid'],
        boot_id: candidate['boot_id'],
        process_start_identity: candidate['process_start_identity'],
        instance_id: candidate['instance_id'],
        package_build: candidate['package_build'],
        protocol_version: candidate['protocol_version'],
        database_schema_version: candidate['database_schema_version'],
        started_at: candidate['started_at'],
      };
    }
    return { schema_version: COORDINATOR_STARTUP_REPORT_SCHEMA, attempt_id: expectedAttemptId, spawned_pid: report['spawned_pid'] as number, outcome, phase: phase as CoordinatorStartupPhase, selected_compiled_entrypoint: selectedCompiledEntrypoint as string | null, exact_competing_lifecycle_owner_observed: report['exact_competing_lifecycle_owner_observed'] as boolean, lifecycle: lifecycleIdentity, error: report['error'] as string | null, failure_code: failureCode, failure_class: failureClass, diagnostics_truncated: report['diagnostics_truncated'] as boolean, omitted_code_points: report['omitted_code_points'] as number, updated_at: report['updated_at'] as string };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    return null;
  } finally { if (descriptor !== null) closeSync(descriptor); }
}
