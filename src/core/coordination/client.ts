import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { createCoordinatorAdmissionRequest, verifyCoordinatorAdmissionResponse } from './admission.ts';
import { assertCoordinatorAdmissionAuthorityUnchanged, captureCoordinatorAdmissionAuthority, COORDINATOR_S1_ADMISSION_IDENTITY, recaptureCoordinatorAdmissionAuthority, verifyCoordinatorS1RecoveryAuthority, type CoordinatorAdmissionAuthoritySnapshot } from './admission-runtime.ts';
import { parseCoordinationReconciliationDetail, parseCoordinationReconciliationReceipt, parseCoordinationResultDetail, parseCoordinationResultReceipt, parseCoordinatorMailboxPage, parseCoordinatorMigrationRecoveryPage, parseCoordinatorProjectionPage, parseCoordinatorReconciliationDetailPage, parseCoordinatorRequestEnvelope, parseCoordinatorResultDetailPage, parseCoordinatorRunCatalogPage } from './contracts.ts';
import { COORDINATOR_COMPILED_ENTRYPOINT_ENV, resolveCoordinatorExecutable } from './executable-resolution.ts';
import { coordinationFailureDefinition, CoordinationRuntimeError } from './failures.ts';
import { activeCoordinationMigrationFreeze } from './migration-paths.ts';
import { runCoordinatorNegotiatedTransport, type CoordinatorNegotiatedTransportHooks, type CoordinatorNegotiatedTransportResult } from './negotiated-transport.ts';
import { classifyCoordinatorInitialPeer, parseCoordinatorLegacyFacadeHandshake } from './peer-classification.ts';
import { currentBootId, isExactProcessAlive, isProcessAlive, processStartIdentity } from './process-identity.ts';
import { COORDINATOR_API_SCHEMA_VERSION, COORDINATOR_LEGACY_FACADE_BUILD, coordinatorRuntimePaths, enforcePrivateAuthorityPath, ensureCoordinatorPrivateRoots, readOrCreateCoordinatorCapability, type CoordinatorRuntimePaths } from './runtime-paths.ts';
import { acquireSerializedProcessGuard, discardLockTombstone, quarantineExactLock, readExactLockText, restoreLockTombstone } from './serialized-lock.ts';
import { coordinationErrorCode } from './store.ts';
import { preparePredecessorCoordinatorUpgrade, resumeCoordinatorUpgrade, type CoordinatorUpgradeTransaction } from './upgrade.ts';
import { recoverUnavailableKnownCoordinator } from './unavailable-recovery.ts';
import { COORDINATOR_STARTUP_ATTEMPT_ID_ENV, coordinatorStartupReportPath, createCoordinatorStartupAttemptId, readCoordinatorStartupReport, type CoordinatorStartupReport, type SafeCoordinatorLifecycleIdentity } from './startup-observation.ts';
import { parseCurrentCoordinatorLock, parseKnownCompatibleCurrentCoordinatorLock, parsePredecessorCoordinatorLock, parsePriorSchema11CurrentCoordinatorLock, parsePriorSchema10CurrentCoordinatorLock, parsePriorSchema9CurrentCoordinatorLock, type CurrentCoordinatorLock } from './upgrade-contracts.ts';
import type { ProcessEnvLike } from '../parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, type CoordinationReconciliationDetail, type CoordinationReconciliationDetailKind, type CoordinationReconciliationReceipt, type CoordinationResultDetail, type CoordinationResultReceipt, type CoordinatorMutationAction, type CoordinatorQueryAction, type CoordinatorRequestEnvelope, type CoordinatorResponseEnvelope } from './types.ts';

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
// The coordinator binds its socket only after CoordinatorStore.open completes
// schema migration, legacy reconciliation migration, and per-run terminal-proof
// reconciliation (real fs+git work per child). The readiness window is measured
// from spawn so startup-lock/predecessor-fence contention cannot steal it, and is
// bounded so a genuinely stuck coordinator still fails loudly. It is comfortably
// below the scale-test 60s ceiling for 100k events while exceeding the heaviest
// legitimate non-scale multi-run startup.
const DEFAULT_COORDINATOR_READINESS_TIMEOUT_MS = 30_000;
const EMPTY_COORDINATOR_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({});

function coordinatorLegacyFacadeIdentity() {
  return Object.freeze({
    legacyFacadeBuild: COORDINATOR_LEGACY_FACADE_BUILD,
    apiSchemaVersion: COORDINATOR_API_SCHEMA_VERSION,
    admissionIdentity: COORDINATOR_S1_ADMISSION_IDENTITY,
  });
}

interface ClientAdmissionEndpoint {
  readonly authority: CoordinatorAdmissionAuthoritySnapshot;
  readonly request: ReturnType<typeof createCoordinatorAdmissionRequest>;
}

interface JsonMap {
  readonly [key: string]: unknown;
}

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface StartupLockRecord {
  readonly schema_version: 'autopilot.coordinator_startup_lock.v1';
  readonly pid: number;
  readonly boot_id: string;
  readonly acquired_at: string;
  readonly token: string;
}

interface StartupLock {
  release(): Promise<void>;
}

export interface CoordinatorClientOptions {
  readonly env?: ProcessEnvLike;
  readonly autoStart?: boolean;
  readonly allowMigrationRecoveryAutoStart?: boolean;
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
}

export interface CoordinatorMutationIdentity {
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly sessionId: string | null;
  readonly fencingGeneration: number | null;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function errorCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return null;
}

function isConnectionFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

function parseStartupLock(value: unknown): StartupLockRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const pid = record['pid'];
  const bootId = record['boot_id'];
  const acquiredAt = record['acquired_at'];
  const token = record['token'];
  if (record['schema_version'] !== 'autopilot.coordinator_startup_lock.v1' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof bootId !== 'string' || typeof acquiredAt !== 'string' || typeof token !== 'string') return null;
  return { schema_version: 'autopilot.coordinator_startup_lock.v1', pid, boot_id: bootId, acquired_at: acquiredAt, token };
}

function sameStartupLock(left: StartupLockRecord, right: StartupLockRecord): boolean {
  return left.pid === right.pid && left.boot_id === right.boot_id && left.acquired_at === right.acquired_at && left.token === right.token;
}

async function acquireStartupLock(paths: CoordinatorRuntimePaths, deadline: number): Promise<StartupLock> {
  await ensureCoordinatorPrivateRoots(paths);
  while (Date.now() < deadline) {
    let guard: ReturnType<typeof acquireSerializedProcessGuard>;
    try { guard = acquireSerializedProcessGuard(paths.startupElectionPath, Math.min(500, Math.max(1, deadline - Date.now())), 'coordinator startup election'); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(25);
      continue;
    }
    let handle: FileHandle | null = null;
    let reclaimedTombstone: string | null = null;
    let createdPath = false;
    try {
      const existingText = await readExactLockText(paths.startupLockPath);
      if (existingText !== null) {
        let existing: StartupLockRecord | null = null;
        try { existing = parseStartupLock(JSON.parse(existingText) as unknown); } catch { /* fail below */ }
        if (existing === null) throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator startup lock is unreadable; refusing destructive replacement');
        // A live PID is never reclaimed because boot identity differs.
        if (isProcessAlive(existing.pid)) {
          guard.release();
          await sleep(50);
          continue;
        }
        reclaimedTombstone = await quarantineExactLock(paths.startupLockPath, existingText, 'stale coordinator startup lock');
      }
      const record: StartupLockRecord = {
        schema_version: 'autopilot.coordinator_startup_lock.v1',
        pid: process.pid,
        boot_id: currentBootId(),
        acquired_at: new Date().toISOString(),
        token: randomBytes(24).toString('hex'),
      };
      handle = await open(paths.startupLockPath, 'wx', 0o600);
      createdPath = true;
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await enforcePrivateAuthorityPath(paths.startupLockPath, false);
      if (reclaimedTombstone !== null) await discardLockTombstone(reclaimedTombstone);
      return {
        release: async () => {
          try {
            const currentText = await readExactLockText(paths.startupLockPath);
            if (currentText === null) throw new CoordinationRuntimeError('system-fatal', 'coordinator startup lock disappeared before release');
            let current: StartupLockRecord | null = null;
            try { current = parseStartupLock(JSON.parse(currentText) as unknown); } catch { /* fail below */ }
            if (current === null || !sameStartupLock(current, record)) throw new CoordinationRuntimeError('system-fatal', 'coordinator startup lock ownership changed');
            const tombstone = await quarantineExactLock(paths.startupLockPath, currentText, 'coordinator startup lock');
            await discardLockTombstone(tombstone);
          } finally { guard.release(); }
        },
      };
    } catch (error) {
      if (handle !== null) {
        try { await handle.close(); }
        catch (closeError) { throw new CoordinationRuntimeError('system-fatal', 'coordinator startup lock creation and file close both failed', [error instanceof Error ? error.message : String(error), closeError instanceof Error ? closeError.message : String(closeError)]); }
      }
      if (createdPath) await unlink(paths.startupLockPath).catch(() => undefined);
      if (reclaimedTombstone !== null) await restoreLockTombstone(paths.startupLockPath, reclaimedTombstone, 'stale coordinator startup lock');
      guard.release();
      throw error;
    }
  }
  throw new CoordinationRuntimeError('coordinator-contention', 'timed out acquiring coordinator startup lock');
}

async function acquirePredecessorStartupFence(paths: CoordinatorRuntimePaths, deadline: number): Promise<StartupLock> {
  while (Date.now() < deadline) {
    let handle: FileHandle | null = null;
    try {
      handle = await open(paths.predecessorStartupLockPath, 'wx', 0o600);
      const record: StartupLockRecord = { schema_version: 'autopilot.coordinator_startup_lock.v1', pid: process.pid, boot_id: currentBootId(), acquired_at: new Date().toISOString(), token: randomBytes(24).toString('hex') };
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await enforcePrivateAuthorityPath(paths.predecessorStartupLockPath, false);
      return {
        release: async () => {
          const text = await readExactLockText(paths.predecessorStartupLockPath);
          if (text === null) throw new CoordinationRuntimeError('system-fatal', 'predecessor startup fence disappeared before release');
          const current = parseStartupLock(JSON.parse(text) as unknown);
          if (current === null || !sameStartupLock(current, record)) throw new CoordinationRuntimeError('system-fatal', 'predecessor startup fence ownership changed');
          const tombstone = await quarantineExactLock(paths.predecessorStartupLockPath, text, 'predecessor startup fence');
          await discardLockTombstone(tombstone);
        },
      };
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const text = await readExactLockText(paths.predecessorStartupLockPath);
      if (text === null) continue;
      let existing: StartupLockRecord | null = null;
      try { existing = parseStartupLock(JSON.parse(text) as unknown); } catch { /* fail below */ }
      if (existing === null) throw new CoordinationRuntimeError('protocol-mismatch', 'predecessor startup fence is unreadable');
      if (isProcessAlive(existing.pid)) { await sleep(50); continue; }
      const tombstone = await quarantineExactLock(paths.predecessorStartupLockPath, text, 'dead predecessor startup lock');
      await discardLockTombstone(tombstone);
    }
  }
  throw new CoordinationRuntimeError('coordinator-contention', 'timed out acquiring predecessor-compatible startup fence');
}

async function hasLiveExactPredecessor(paths: CoordinatorRuntimePaths): Promise<boolean> {
  const text = await readExactLockText(paths.predecessorLockPath);
  if (text === null) return false;
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return false; }
  const lock = parsePredecessorCoordinatorLock(value);
  return lock !== null && isProcessAlive(lock.pid);
}

interface SpawnedCoordinator {
  readonly child: ReturnType<typeof spawn>;
  readonly attemptId: string;
  readonly reportPath: string;
  readonly bootstrapPath: string;
  readonly coordinatorPath: string;
}

interface SpawnedProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spawnError: string | null;
}

export function resolveCoordinatorExecutableForClientModule(): ReturnType<typeof resolveCoordinatorExecutable> {
  return resolveCoordinatorExecutable(import.meta.url);
}

function spawnCoordinator(paths: CoordinatorRuntimePaths, env: ProcessEnvLike): SpawnedCoordinator {
  const executable = resolveCoordinatorExecutableForClientModule();
  const attemptId = createCoordinatorStartupAttemptId();
  const child = spawn(process.execPath, [executable.bootstrapPath, 'serve', '--state-root', paths.stateRoot], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...env,
      AUTOPILOT_STATE_ROOT: paths.stateRoot,
      [COORDINATOR_STARTUP_ATTEMPT_ID_ENV]: attemptId,
      [COORDINATOR_COMPILED_ENTRYPOINT_ENV]: executable.coordinatorPath,
    },
  });
  child.unref();
  return {
    child,
    attemptId,
    reportPath: coordinatorStartupReportPath(paths, attemptId),
    bootstrapPath: executable.bootstrapPath,
    coordinatorPath: executable.coordinatorPath,
  };
}

function sameCurrentLifecycle(left: CurrentCoordinatorLock, right: CurrentCoordinatorLock): boolean {
  return left.schema_version === right.schema_version
    && left.pid === right.pid
    && left.boot_id === right.boot_id
    && left.process_start_identity === right.process_start_identity
    && left.token === right.token
    && left.instance_id === right.instance_id
    && left.package_build === right.package_build
    && left.protocol_version === right.protocol_version
    && left.database_schema_version === right.database_schema_version
    && left.started_at === right.started_at;
}

function safeLifecycleMatches(lock: CurrentCoordinatorLock, safe: SafeCoordinatorLifecycleIdentity | null): boolean {
  return safe !== null
    && safe.schema_version === lock.schema_version
    && safe.pid === lock.pid
    && safe.boot_id === lock.boot_id
    && safe.process_start_identity === lock.process_start_identity
    && safe.instance_id === lock.instance_id
    && safe.package_build === lock.package_build
    && safe.protocol_version === lock.protocol_version
    && safe.database_schema_version === lock.database_schema_version
    && safe.started_at === lock.started_at;
}

function lifecycleEvidence(lock: CurrentCoordinatorLock | null): readonly string[] {
  if (lock === null) return ['lifecycle_candidate=absent'];
  return [
    'lifecycle_candidate=exact-current',
    `lifecycle_schema=${lock.schema_version}`,
    `lifecycle_pid=${String(lock.pid)}`,
    `lifecycle_process_start_identity=${lock.process_start_identity}`,
    `lifecycle_instance_id=${lock.instance_id}`,
    `lifecycle_build=${lock.package_build}`,
    `lifecycle_protocol=${lock.protocol_version}`,
    `lifecycle_database_schema=${String(lock.database_schema_version)}`,
    `lifecycle_started_at=${lock.started_at}`,
  ];
}

export class CoordinatorClient {
  readonly #paths: CoordinatorRuntimePaths;
  readonly #env: ProcessEnvLike;
  readonly #autoStart: boolean;
  readonly #allowMigrationRecoveryAutoStart: boolean;
  readonly #requestTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #readinessTimeoutMs: number;

  constructor(options: CoordinatorClientOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#paths = coordinatorRuntimePaths(this.#env);
    this.#autoStart = options.autoStart !== false;
    this.#allowMigrationRecoveryAutoStart = options.allowMigrationRecoveryAutoStart === true;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_COORDINATOR_READINESS_TIMEOUT_MS;
  }

  get paths(): CoordinatorRuntimePaths {
    return this.#paths;
  }

  async request(requestValue: CoordinatorRequestEnvelope): Promise<CoordinatorResponseEnvelope> {
    const request = parseCoordinatorRequestEnvelope(requestValue);
    const capability = await readOrCreateCoordinatorCapability(this.#paths);
    const response = await this.#sendWithRecovery(request, capability);
    if (response.ok) {
      if (request.action === 'status') parseCoordinatorProjectionPage(response.payload, 'status');
      else if (request.action === 'doctor') parseCoordinatorProjectionPage(response.payload, 'doctor');
      else if (request.action === 'run-catalog') parseCoordinatorRunCatalogPage(response.payload);
      else if (request.action === 'migration-recovery') parseCoordinatorMigrationRecoveryPage(response.payload);
      else if (request.action === 'reconciliation-details') parseCoordinatorReconciliationDetailPage(response.payload);
      else if (request.action === 'result-details') parseCoordinatorResultDetailPage(response.payload);
      else if (request.action === 'drain-mailbox') parseCoordinatorMailboxPage(response.payload);
      if (response.payload['reconciliation_receipt'] !== undefined) parseCoordinationReconciliationReceipt(response.payload['reconciliation_receipt']);
      if (response.payload['result_receipt'] !== undefined) parseCoordinationResultReceipt(response.payload['result_receipt']);
    }
    return response;
  }

  #transportHooks(capability: string): CoordinatorNegotiatedTransportHooks<ClientAdmissionEndpoint> {
    return {
      identity: COORDINATOR_S1_ADMISSION_IDENTITY,
      assertSuccess: (response) => this.#assertSuccess(response),
      validateLegacyHandshake: async (response) => { await this.#assertLegacyFacadeLifecycle(response); },
      validateKnownCf50Predecessor: async (response) => {
        const classified = classifyCoordinatorInitialPeer(response.payload, coordinatorLegacyFacadeIdentity());
        if (classified.kind !== 'known-cf50-predecessor') throw new CoordinationRuntimeError('protocol-mismatch', 'endpoint without a predecessor path changed classification');
        if (existsSync(this.#paths.runtimeIdentityPath) || existsSync(this.#paths.currentStorePointerPath)) throw new CoordinationRuntimeError('protocol-mismatch', 'cf50 predecessor classification found S1 private identity residue');
      },
      prepareAdmission: async (response) => {
        const lifecycle = await this.#assertLegacyFacadeLifecycle(response);
        const authority = await captureCoordinatorAdmissionAuthority({ paths: this.#paths, expectedLifecycle: lifecycle });
        const request = createCoordinatorAdmissionRequest({ requestId: `admission-${randomUUID()}`, identity: COORDINATOR_S1_ADMISSION_IDENTITY });
        return Object.freeze({ endpoint: Object.freeze({ authority, request }), request });
      },
      verifyAdmission: async (response, endpoint) => verifyCoordinatorAdmissionResponse({
        response: response.payload,
        identity: COORDINATOR_S1_ADMISSION_IDENTITY,
        capability,
        expected: {
          actualClientBuild: COORDINATOR_S1_ADMISSION_IDENTITY.implementationBuild,
          requestedVocabulary: endpoint.request.payload.requested_vocabulary,
          nonce: endpoint.request.payload.nonce,
          admitted: true,
          ...endpoint.authority.endpoint,
        },
      }),
      verifyEndpointUnchanged: async (endpoint) => {
        const observed = await recaptureCoordinatorAdmissionAuthority({
          paths: this.#paths,
          expectedLifecycle: endpoint.authority.lifecycle,
          expectedGeneration: endpoint.authority.generation,
        });
        assertCoordinatorAdmissionAuthorityUnchanged(endpoint.authority, observed);
      },
    };
  }

  async #runCompatibleSocket(request: CoordinatorRequestEnvelope, capability: string, timeoutMs: number): Promise<CoordinatorNegotiatedTransportResult> {
    return await runCoordinatorNegotiatedTransport({
      socketPath: this.#paths.socketPath,
      capability,
      timeoutMs,
      handshake: request.action === 'handshake' ? request : this.#probeRequest(),
      operation: request.action === 'handshake' ? null : request,
      hooks: this.#transportHooks(capability),
    });
  }

  async #sendCompatibleRequestOnce(request: CoordinatorRequestEnvelope, capability: string, timeoutMs: number): Promise<CoordinatorResponseEnvelope> {
    return (await this.#runCompatibleSocket(request, capability, timeoutMs)).response;
  }

  async #attestReachableCoordinator(capability: string, timeoutMs: number): Promise<CoordinatorNegotiatedTransportResult> {
    const request: CoordinatorRequestEnvelope = {
      schema_version: 'autopilot.coordinator_request.v1',
      protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
      request_id: `startup-attestation-${randomUUID()}`,
      action: 'status',
      idempotency_key: null,
      repo_id: 'global',
      workstream_run: null,
      session_id: null,
      fencing_generation: null,
      expected_version: null,
      payload: EMPTY_COORDINATOR_PAYLOAD,
    };
    const result = await this.#runCompatibleSocket(request, capability, timeoutMs);
    parseCoordinatorProjectionPage(result.response.payload, 'status');
    return result;
  }

  async #sendWithRecovery(request: CoordinatorRequestEnvelope, capability: string): Promise<CoordinatorResponseEnvelope> {
    try {
      return await this.#sendCompatibleRequestOnce(request, capability, this.#requestTimeoutMs);
    } catch (error) {
      // A responding but incompatible endpoint is authoritative evidence, not a
      // missing daemon. Never route it into replacement or predecessor upgrade.
      if (!this.#autoStart || !isConnectionFailure(error)) throw error;
      const freeze = activeCoordinationMigrationFreeze(this.#paths.stateRoot);
      const recoveryAction = request.action === 'handshake' || request.action === 'status' || request.action === 'doctor' || request.action === 'export' || request.action === 'migration-recovery' || request.action === 'run-catalog' || request.action === 'reconciliation-details' || request.action === 'result-details' || request.action === 'attach-migration-recovery' || request.action === 'resolve-migration-recovery' || request.action === 'detach-session' || request.action === 'heartbeat';
      if (freeze !== null && !(this.#allowMigrationRecoveryAutoStart && recoveryAction)) throw new CoordinationRuntimeError('coordinator-contention', 'coordinator auto-start is forbidden while coordination migration is frozen; only an explicit recovery client may start the imported candidate store', [freeze]);
      await this.#ensureStarted(capability);
      const retryDeadline = Date.now() + this.#requestTimeoutMs;
      let lastRetryError: unknown = error;
      while (Date.now() < retryDeadline) {
        try { return await this.#sendCompatibleRequestOnce(request, capability, Math.min(500, this.#requestTimeoutMs)); }
        catch (retryError) {
          lastRetryError = retryError;
          if (!isConnectionFailure(retryError)) throw retryError;
          await sleep(25);
        }
      }
      throw new CoordinationRuntimeError('coordinator-unavailable', lastRetryError instanceof Error ? lastRetryError.message : String(lastRetryError));
    }
  }

  async query(action: CoordinatorQueryAction, repoId = 'global', workstreamRun: string | null = null, payload: Readonly<Record<string, unknown>> = {}): Promise<CoordinatorResponseEnvelope> {
    if ((action === 'status' || action === 'doctor') && Object.keys(payload).length === 0) return await this.#queryProjection(action, repoId, workstreamRun);
    return await this.#queryWire(action, repoId, workstreamRun, payload);
  }

  async #queryWire(action: CoordinatorQueryAction, repoId: string, workstreamRun: string | null, payload: Readonly<Record<string, unknown>>): Promise<CoordinatorResponseEnvelope> {
    return await this.request({
      schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: `request-${randomUUID()}`,
      action, idempotency_key: null, repo_id: repoId, workstream_run: workstreamRun, session_id: null, fencing_generation: null, expected_version: null, payload,
    });
  }

  async #queryProjection(action: 'status' | 'doctor', repoId: string, workstreamRun: string | null): Promise<CoordinatorResponseEnvelope> {
    const deadline = Date.now() + this.#requestTimeoutMs;
    let summary: CoordinatorResponseEnvelope;
    let attempt = 0;
    while (true) {
      try {
        summary = await this.#queryWire(action, repoId, workstreamRun, {});
        break;
      } catch (error) {
        if (!(error instanceof CoordinationRuntimeError) || error.code !== 'coordinator-contention' || Date.now() >= deadline) throw error;
        attempt += 1;
        await sleep(Math.min(100, 10 * attempt));
      }
    }
    const projection = summary.payload['projection'];
    const counts = summary.payload['section_counts'];
    const scanToken = summary.payload['scan_token'];
    if (!isJsonMap(projection) || !isJsonMap(counts) || typeof scanToken !== 'string') throw new CoordinationRuntimeError('invalid-state', `${action} summary page omitted its bounded projection contract`);
    const aggregate: Record<string, unknown> = { ...projection };
    const sections = Object.keys(counts).sort((left, right) => left.localeCompare(right));
    for (const section of sections) {
      const count = counts[section];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new CoordinationRuntimeError('invalid-state', `${action} summary section count is invalid`, [section]);
      const inline = projection[section];
      if (inline !== undefined) {
        if (!Array.isArray(inline) || inline.length !== count) throw new CoordinationRuntimeError('invalid-state', `${action} inline summary section does not match its exact count`, [section]);
        aggregate[section] = Object.freeze([...inline]);
        continue;
      }
      const items: unknown[] = [];
      let cursor: string | null = null;
      do {
        const pagePayload: Record<string, unknown> = { section, scan_token: scanToken };
        if (cursor !== null) pagePayload['cursor'] = cursor;
        const page = await this.#queryWire(action, repoId, workstreamRun, pagePayload);
        const pageItems = page.payload['items'];
        const next = page.payload['next_cursor'];
        if (!Array.isArray(pageItems) || (next !== null && typeof next !== 'string')) throw new CoordinationRuntimeError('invalid-state', `${action} detail page is malformed`, [section]);
        items.push(...pageItems);
        cursor = typeof next === 'string' ? next : null;
      } while (cursor !== null);
      if (items.length !== count) throw new CoordinationRuntimeError('invalid-state', `${action} detail pages do not match their exact summary count`, [section, `expected=${String(count)}`, `actual=${String(items.length)}`]);
      aggregate[section] = Object.freeze(items);
    }
    return { ...summary, payload: Object.freeze(aggregate) };
  }

  async reconciliationDetails(input: {
    readonly repoId: string;
    readonly workstreamRun: string;
    readonly receipt: CoordinationReconciliationReceipt;
  } & ({
    readonly sessionId: string; readonly fencingGeneration: number; readonly sessionLeaseId: string; readonly sessionToken: string;
  } | {
    readonly childLeaseId: string; readonly childToken: string; readonly pid: number; readonly bootId: string;
  })): Promise<readonly CoordinationReconciliationDetail[]> {
    const receipt = parseCoordinationReconciliationReceipt(input.receipt);
    if (receipt.repo_id !== input.repoId || receipt.workstream_run !== input.workstreamRun) throw new CoordinationRuntimeError('unauthorized-client', 'reconciliation receipt does not belong to the requested attached run');
    const emptyDigest = `sha256:${createHash('sha256').update('[]', 'utf8').digest('hex')}`;
    if (receipt.detail_count === 0) {
      if (receipt.details_sha256 !== emptyDigest || Object.values(receipt.counts).some((count) => count !== 0)) throw new CoordinationRuntimeError('invalid-state', 'empty reconciliation receipt has nonempty count or digest evidence');
      return Object.freeze([]);
    }
    const details: CoordinationReconciliationDetail[] = [];
    let cursor: string | null = null;
    do {
      const sessionAuthority = 'sessionId' in input;
      const response = await this.request({
        schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: `request-${randomUUID()}`,
        action: 'reconciliation-details', idempotency_key: null, repo_id: input.repoId, workstream_run: input.workstreamRun,
        session_id: sessionAuthority ? input.sessionId : null, fencing_generation: sessionAuthority ? input.fencingGeneration : null, expected_version: null,
        payload: sessionAuthority
          ? { reconciliation_receipt_id: receipt.reconciliation_receipt_id, cursor, session_lease_id: input.sessionLeaseId, session_token: input.sessionToken }
          : { reconciliation_receipt_id: receipt.reconciliation_receipt_id, cursor, child_lease_id: input.childLeaseId, child_token: input.childToken, pid: input.pid, boot_id: input.bootId },
      });
      const pageReceipt = parseCoordinationReconciliationReceipt(response.payload['reconciliation_receipt']);
      if (JSON.stringify(pageReceipt) !== JSON.stringify(receipt)) throw new CoordinationRuntimeError('invalid-state', 'reconciliation detail page changed its exact immutable receipt');
      const page = response.payload['details'];
      const next = response.payload['next_cursor'];
      if (!Array.isArray(page) || (next !== null && typeof next !== 'string')) throw new CoordinationRuntimeError('invalid-state', 'reconciliation detail page is malformed');
      details.push(...page.map((entry) => parseCoordinationReconciliationDetail(entry)));
      cursor = typeof next === 'string' ? next : null;
    } while (cursor !== null);
    if (details.length !== receipt.detail_count) throw new CoordinationRuntimeError('invalid-state', 'reconciliation detail pages do not match their exact receipt count');
    const actualCounts: Record<CoordinationReconciliationDetailKind, number> = { 'released-lease': 0, 'released-observation': 0, 'stale-observation': 0, 'released-request': 0, notification: 0, 'offered-group': 0 };
    for (const [index, detail] of details.entries()) {
      if (detail.ordinal !== index + 1) throw new CoordinationRuntimeError('invalid-state', 'reconciliation detail pages do not have exact contiguous ordinals');
      actualCounts[detail.kind] += 1;
    }
    if (JSON.stringify(actualCounts) !== JSON.stringify(receipt.counts)) throw new CoordinationRuntimeError('invalid-state', 'reconciliation detail pages do not match their exact per-kind counts');
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(details), 'utf8').digest('hex')}`;
    if (digest !== receipt.details_sha256) throw new CoordinationRuntimeError('invalid-state', 'reconciliation detail pages do not match their exact receipt digest');
    return Object.freeze(details);
  }

  async resultDetails(input: {
    readonly repoId: string; readonly workstreamRun: string; readonly sessionId: string; readonly fencingGeneration: number;
    readonly sessionLeaseId: string; readonly sessionToken: string; readonly receipt: CoordinationResultReceipt;
  }): Promise<Readonly<Record<string, readonly unknown[]>>> {
    const receipt = parseCoordinationResultReceipt(input.receipt);
    if (receipt.repo_id !== input.repoId || receipt.workstream_run !== input.workstreamRun) throw new CoordinationRuntimeError('unauthorized-client', 'result receipt does not belong to the requested attached run');
    const details: CoordinationResultDetail[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.request({
        schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: `request-${randomUUID()}`,
        action: 'result-details', idempotency_key: null, repo_id: input.repoId, workstream_run: input.workstreamRun, session_id: input.sessionId, fencing_generation: input.fencingGeneration, expected_version: null,
        payload: { result_receipt_id: receipt.result_receipt_id, cursor, session_lease_id: input.sessionLeaseId, session_token: input.sessionToken },
      });
      const pageReceipt = parseCoordinationResultReceipt(response.payload['result_receipt']);
      if (JSON.stringify(pageReceipt) !== JSON.stringify(receipt)) throw new CoordinationRuntimeError('invalid-state', 'result detail page changed its exact immutable receipt');
      const page = response.payload['details'];
      const next = response.payload['next_cursor'];
      if (!Array.isArray(page) || (next !== null && typeof next !== 'string')) throw new CoordinationRuntimeError('invalid-state', 'result detail page is malformed');
      details.push(...page.map((entry) => parseCoordinationResultDetail(entry)));
      cursor = typeof next === 'string' ? next : null;
    } while (cursor !== null);
    if (details.length !== receipt.detail_count) throw new CoordinationRuntimeError('invalid-state', 'result detail pages do not match their exact receipt count');
    const collections: Record<string, unknown[]> = {};
    for (const [index, detail] of details.entries()) {
      if (detail.ordinal !== index + 1) throw new CoordinationRuntimeError('invalid-state', 'result detail pages do not have exact contiguous ordinals');
      const values = collections[detail.collection] ?? [];
      if (detail.collection_ordinal !== values.length + 1) throw new CoordinationRuntimeError('invalid-state', 'result collection pages do not have exact contiguous ordinals', [detail.collection]);
      values.push(detail.value);
      collections[detail.collection] = values;
    }
    if (`sha256:${createHash('sha256').update(JSON.stringify(details), 'utf8').digest('hex')}` !== receipt.details_sha256) throw new CoordinationRuntimeError('invalid-state', 'result detail pages do not match their exact receipt digest');
    for (const [name, expected] of Object.entries(receipt.collections)) {
      const values = collections[name] ?? [];
      if (values.length !== expected.item_count || `sha256:${createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex')}` !== expected.items_sha256) throw new CoordinationRuntimeError('invalid-state', 'result detail pages do not match their collection receipt', [name]);
      collections[name] = values;
    }
    if (Object.keys(collections).length !== Object.keys(receipt.collections).length) throw new CoordinationRuntimeError('invalid-state', 'result details contain an undeclared collection');
    return Object.freeze(Object.fromEntries(Object.entries(collections).map(([name, values]) => [name, Object.freeze(values)])));
  }

  async mutate(action: CoordinatorMutationAction, identity: CoordinatorMutationIdentity, payload: Readonly<Record<string, unknown>>): Promise<CoordinatorResponseEnvelope> {
    const response = await this.request({
      schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: `request-${randomUUID()}`,
      action, idempotency_key: identity.idempotencyKey, repo_id: identity.repoId, workstream_run: identity.workstreamRun, session_id: identity.sessionId,
      fencing_generation: identity.fencingGeneration, expected_version: identity.expectedVersion, payload,
    });
    const rawReceipt = response.payload['result_receipt'];
    if (rawReceipt === undefined) return response;
    if (identity.sessionId === null || identity.fencingGeneration === null) throw new CoordinationRuntimeError('invalid-state', `child-scoped mutation ${action} returned a parent-only result receipt`);
    const sessionLeaseId = payload['session_lease_id'];
    const sessionToken = payload['session_token'];
    if (typeof sessionLeaseId !== 'string' || typeof sessionToken !== 'string') throw new CoordinationRuntimeError('invalid-state', `mutation ${action} returned a result receipt without session authority for its production consumer`);
    const receipt = parseCoordinationResultReceipt(rawReceipt);
    const collections = await this.resultDetails({ repoId: identity.repoId, workstreamRun: identity.workstreamRun, sessionId: identity.sessionId, fencingGeneration: identity.fencingGeneration, sessionLeaseId, sessionToken, receipt });
    return { ...response, payload: Object.freeze({ ...response.payload, ...collections }) };
  }

  async #ensureStarted(capability: string): Promise<void> {
    const deadline = Date.now() + this.#startupTimeoutMs;
    const lock = await acquireStartupLock(this.#paths, deadline);
    const predecessorStartupFence = await acquirePredecessorStartupFence(this.#paths, deadline).catch(async (error: unknown) => { await lock.release(); throw error; });
    let upgrade: CoordinatorUpgradeTransaction | null = null;
    try {
      try {
        const attested = await this.#attestReachableCoordinator(capability, Math.min(500, this.#requestTimeoutMs));
        const pendingUpgrade = await resumeCoordinatorUpgrade(this.#paths);
        if (pendingUpgrade !== null) {
          if (attested.peerMode !== 'negotiated-s1') throw new CoordinationRuntimeError('recovery-required', 'schema-changing upgrade reconnect reached the cf50 predecessor instead of truthful S1 admission');
          await pendingUpgrade.markReconnectVerified();
          await pendingUpgrade.commit();
        }
        return;
      } catch (error) {
        if (!isConnectionFailure(error)) throw error;
        upgrade = await resumeCoordinatorUpgrade(this.#paths);
        if (upgrade === null) {
          const currentText = await readExactLockText(this.#paths.lockPath);
          if (currentText !== null) {
            let known: ReturnType<typeof parseKnownCompatibleCurrentCoordinatorLock> = null;
            let historical: ReturnType<typeof parsePriorSchema11CurrentCoordinatorLock> | ReturnType<typeof parsePriorSchema10CurrentCoordinatorLock> | ReturnType<typeof parsePriorSchema9CurrentCoordinatorLock> = null;
            try {
              const parsed: unknown = JSON.parse(currentText) as unknown;
              known = parseKnownCompatibleCurrentCoordinatorLock(parsed);
              historical = parsePriorSchema11CurrentCoordinatorLock(parsed) ?? parsePriorSchema10CurrentCoordinatorLock(parsed) ?? parsePriorSchema9CurrentCoordinatorLock(parsed);
            } catch { /* fail below */ }
            if (known === null && historical === null) throw new CoordinationRuntimeError('protocol-mismatch', 'current-generation lifecycle lock belongs to an unknown build; auto-start will not replace it');
            if (known !== null) {
              if (known.package_build !== COORDINATOR_LEGACY_FACADE_BUILD) throw new CoordinationRuntimeError('protocol-mismatch', 'ordinary S1 startup recognizes only the exact cf50 predecessor façade lock');
              const exactOwnerLive = isExactProcessAlive(known.pid, known.process_start_identity);
              const hasS1Identity = existsSync(this.#paths.runtimeIdentityPath) || existsSync(this.#paths.currentStorePointerPath);
              if (exactOwnerLive && !hasS1Identity) throw new CoordinationRuntimeError('coordinator-unavailable', 'healthy actual cf50 remains authoritative while its endpoint is unavailable; ordinary S1 startup will not signal or replace it', [`pid=${String(known.pid)}`]);
              if (hasS1Identity) await verifyCoordinatorS1RecoveryAuthority({ paths: this.#paths, expectedLifecycle: known });
              const recovery = await recoverUnavailableKnownCoordinator(this.#paths, async () => {
                try {
                  await this.#attestReachableCoordinator(capability, Math.min(500, this.#requestTimeoutMs));
                  return true;
                } catch (probeError) {
                  if (isConnectionFailure(probeError)) return false;
                  throw probeError;
                }
              });
              if (recovery.outcome === 'endpoint-recovered') return;
            } else if (historical !== null && isProcessAlive(historical.pid)) throw new CoordinationRuntimeError('coordinator-unavailable', `historical coordinator ${historical.package_build} is live as pid ${String(historical.pid)} but its socket is unavailable; explicit migration recovery is required`);
          } else if (await hasLiveExactPredecessor(this.#paths)) {
            upgrade = await preparePredecessorCoordinatorUpgrade(this.#paths, capability, deadline);
          }
        }
      }
      if (upgrade !== null) await upgrade.markStarting();
      try {
        let child: SpawnedCoordinator;
        try { child = spawnCoordinator(this.#paths, this.#env); }
        catch (spawnError) {
          const cause = spawnError instanceof CoordinationRuntimeError ? spawnError : null;
          throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator startup failed before a child process could be launched', [
            'spawned_pid=unassigned', 'spawned_exit_code=none', 'spawned_signal=none',
            'spawned_executable=unresolved',
            'exact_competing_lifecycle_owner_observed=false', 'startup_phase=spawn-resolution',
            'lifecycle_candidate=absent', 'last_endpoint_transport_failure=none',
            `startup_report_error=${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
            'startup_report_truncated=false',
            ...(cause?.evidence.map((entry) => `cause=${entry}`) ?? []),
          ]);
        }
        // The readiness window is measured from spawn so startup-lock/predecessor-fence
        // contention cannot steal the coordinator's migration+reconciliation window.
        await this.#waitForCoordinatorWinner(capability, Date.now() + this.#readinessTimeoutMs, child, upgrade !== null);
        if (upgrade !== null) {
          await upgrade.markReconnectVerified();
          await upgrade.commit();
        }
      } catch (error) {
        if (upgrade === null) throw error;
        try {
          await upgrade.rollback(error);
        } catch (rollbackError) {
          await upgrade.markRecoveryRequired(rollbackError).catch(() => undefined);
          throw new CoordinationRuntimeError('recovery-required', 'coordinator upgrade failed and exact verified-backup restoration also failed', [error instanceof Error ? error.message : String(error), rollbackError instanceof Error ? rollbackError.message : String(rollbackError)]);
        }
        throw new CoordinationRuntimeError('recovery-required', 'coordinator upgrade failed; the exact schema-6 backup was restored, but this package cannot automatically restart the unavailable aa3e377 binary', [error instanceof Error ? error.message : String(error), `upgrade_id=${upgrade.intent.upgrade_id}`]);
      }
    } finally {
      await predecessorStartupFence.release();
      await lock.release();
    }
  }

  async #waitForCoordinatorWinner(capability: string, deadline: number, spawned: SpawnedCoordinator, requireNegotiatedS1: boolean): Promise<void> {
    const { child, attemptId, reportPath } = spawned;
    let processOutcome: SpawnedProcessOutcome | null = child.exitCode === null
      ? null
      : { exitCode: child.exitCode, signal: null, spawnError: null };
    child.once('close', (exitCode, signal) => { processOutcome = { exitCode, signal, spawnError: null }; });
    const pid = child.pid;
    let lastConnectionFailure: unknown = null;
    let report: CoordinatorStartupReport | null = readCoordinatorStartupReport(reportPath, attemptId);
    let reportLifecycleConsistent: boolean | null = null;
    let winner: CurrentCoordinatorLock | null = null;

    const refreshReport = (): CoordinatorStartupReport | null => {
      const observed = readCoordinatorStartupReport(reportPath, attemptId);
      if (observed !== null && observed.spawned_pid === pid && observed.selected_compiled_entrypoint === spawned.coordinatorPath) report = observed;
      else if (observed !== null) report = null;
      return report;
    };
    const evidence = (candidate: CurrentCoordinatorLock | null = winner): readonly string[] => {
      const currentReport = refreshReport();
      const outcome = processOutcome;
      return [
        `spawned_pid=${pid === undefined ? 'unassigned' : String(pid)}`,
        `spawned_exit_code=${outcome?.exitCode === null || outcome?.exitCode === undefined ? 'none' : String(outcome.exitCode)}`,
        `spawned_signal=${outcome?.signal ?? 'none'}`,
        `spawn_error=${outcome?.spawnError ?? 'none'}`,
        `spawned_executable=${spawned.bootstrapPath}`,
        `selected_compiled_entrypoint=${spawned.coordinatorPath}`,
        `exact_competing_lifecycle_owner_observed=${String(candidate !== null || currentReport?.exact_competing_lifecycle_owner_observed === true)}`,
        `startup_phase=${currentReport?.phase ?? 'spawn/readiness'}`,
        ...lifecycleEvidence(candidate),
        `last_endpoint_transport_failure=${lastConnectionFailure instanceof Error ? lastConnectionFailure.message : lastConnectionFailure === null ? 'none' : String(lastConnectionFailure)}`,
        `startup_report_outcome=${currentReport?.outcome ?? 'unavailable'}`,
        `startup_report_error=${currentReport?.error ?? 'none'}`,
        `startup_report_failure_code=${currentReport?.failure_code ?? 'none'}`,
        `startup_report_failure_class=${currentReport?.failure_class ?? 'none'}`,
        `startup_report_lifecycle_consistent=${reportLifecycleConsistent === null ? 'unknown' : String(reportLifecycleConsistent)}`,
        `startup_report_truncated=${String(currentReport?.diagnostics_truncated ?? false)}`,
        `startup_report_omitted_code_points=${String(currentReport?.omitted_code_points ?? 0)}`,
      ];
    };
    const fail = (message: string, cause?: unknown, candidate: CurrentCoordinatorLock | null = winner): never => {
      if (cause instanceof CoordinationRuntimeError) throw new CoordinationRuntimeError(cause.code, message, [...evidence(candidate), ...cause.evidence.map((entry) => `cause=${entry}`)]);
      // The report is bounded diagnostic evidence, never a control or authority
      // source. It cannot select retry policy or failure classification.
      throw new CoordinationRuntimeError('coordinator-unavailable', message, evidence(candidate));
    };
    if (pid === undefined) fail('coordinator spawn failed before a process id was assigned');

    const observeWinner = async (expected: CurrentCoordinatorLock | null): Promise<CurrentCoordinatorLock> => {
      const text = await readExactLockText(this.#paths.lockPath);
      if (text === null) return fail(expected === null ? 'clean election-loser exit had no durable exact-current lifecycle winner' : 'exact delayed startup winner lifecycle lock disappeared', undefined, expected);
      let parsed: CurrentCoordinatorLock | null = null;
      try { parsed = parseCurrentCoordinatorLock(JSON.parse(text) as unknown); } catch { /* fail below */ }
      if (parsed === null) return fail(expected === null ? 'clean election-loser exit reached an unknown or non-current lifecycle lock' : 'exact delayed startup winner lifecycle identity became unknown or non-current', undefined, expected);
      const observed = parsed;
      if (expected !== null && !sameCurrentLifecycle(observed, expected)) return fail('exact delayed startup winner lifecycle identity changed before endpoint publication', undefined, expected);
      if (!isProcessAlive(observed.pid)) return fail('exact delayed startup winner died before endpoint publication', undefined, observed);
      const startIdentity = processStartIdentity(observed.pid);
      if (startIdentity === null) return fail('exact delayed startup winner process-birth identity became unavailable', undefined, observed);
      if (startIdentity !== observed.process_start_identity) return fail('exact delayed startup winner process-birth identity changed before endpoint publication', undefined, observed);
      return observed;
    };

    const attestEndpoint = async (): Promise<boolean> => {
      try {
        const attested = await this.#attestReachableCoordinator(capability, Math.min(500, this.#requestTimeoutMs));
        if (requireNegotiatedS1 && attested.peerMode !== 'negotiated-s1') throw new CoordinationRuntimeError('recovery-required', 'schema-changing startup reached actual cf50 instead of truthful S1 admission');
        await this.#assertLegacyFacadeLifecycle(attested.handshake, winner);
        return true;
      } catch (error) {
        if (!isConnectionFailure(error)) fail('coordinator startup endpoint failed exact lifecycle attestation', error);
        lastConnectionFailure = error;
        return false;
      }
    };

    while (Date.now() < deadline) {
      if (winner !== null) winner = await observeWinner(winner);
      if (await attestEndpoint()) {
        await unlink(reportPath).catch(() => undefined);
        return;
      }
      const outcome = processOutcome;
      if (outcome !== null && winner === null) {
        const currentReport = refreshReport();
        if (outcome.signal !== null) fail(`spawned coordinator was terminated by signal ${outcome.signal} before readiness`);
        if (outcome.spawnError !== null) fail('coordinator child process could not be spawned');
        if (outcome.exitCode !== 0) fail(`spawned coordinator failed with exit code ${String(outcome.exitCode)} before readiness`);
        winner = await observeWinner(null);
        // The startup report is diagnostics only and never authority. Exit code
        // zero alone is also insufficient: only the durable exact lock (including
        // its secret token), exact process-birth identity, and stable full identity
        // permit the original bounded readiness wait to continue.
        if (currentReport !== null) reportLifecycleConsistent = currentReport.outcome === 'election-loser' && safeLifecycleMatches(winner, currentReport.lifecycle);
        // A contradictory report remains visible evidence but cannot create,
        // transfer, or revoke the durable winner's authority.
        continue;
      }
      await sleep(25);
    }
    if (winner !== null) winner = await observeWinner(winner);
    if (await attestEndpoint()) {
      await unlink(reportPath).catch(() => undefined);
      return;
    }
    if (winner !== null) fail('exact delayed startup winner did not publish its attested endpoint before the original readiness deadline');
    fail('spawned coordinator remained unready until the original readiness deadline');
  }

  #probeRequest(): CoordinatorRequestEnvelope {
    return {
      schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: `probe-${randomUUID()}`, action: 'handshake', idempotency_key: null, repo_id: 'global', workstream_run: null, session_id: null, fencing_generation: null, expected_version: null, payload: EMPTY_COORDINATOR_PAYLOAD,
    };
  }

  async #assertLegacyFacadeLifecycle(response: CoordinatorResponseEnvelope, expectedOwner: CurrentCoordinatorLock | null = null): Promise<CurrentCoordinatorLock> {
    const handshake = parseCoordinatorLegacyFacadeHandshake(response.payload, coordinatorLegacyFacadeIdentity());
    const text = await readExactLockText(this.#paths.lockPath);
    if (text === null) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator handshake has no legacy façade lifecycle lock');
    let lock: CurrentCoordinatorLock | null = null;
    try { lock = parseCurrentCoordinatorLock(JSON.parse(text) as unknown); } catch { /* fail below */ }
    if (lock === null || lock.package_build !== COORDINATOR_LEGACY_FACADE_BUILD) throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator handshake is paired with an unknown lifecycle authority lock');
    if (expectedOwner !== null && !sameCurrentLifecycle(lock, expectedOwner)) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator endpoint lifecycle lock changed from the elected winner candidate', lifecycleEvidence(expectedOwner));
    if (handshake.package_build !== lock.package_build
      || handshake.protocol_version !== lock.protocol_version
      || handshake.database_schema_version !== lock.database_schema_version
      || handshake.lifecycle_lock_schema !== lock.schema_version
      || handshake.lifecycle_pid !== lock.pid
      || handshake.lifecycle_boot_id !== lock.boot_id
      || handshake.lifecycle_process_start_identity !== lock.process_start_identity
      || handshake.lifecycle_instance_id !== lock.instance_id
      || handshake.lifecycle_started_at !== lock.started_at) {
      throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator legacy façade handshake disagrees with its exact lifecycle lock');
    }
    if (!isExactProcessAlive(lock.pid, lock.process_start_identity)) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator lifecycle authority does not identify the live endpoint process', [`pid=${String(lock.pid)}`]);
    return lock;
  }

  #assertSuccess(response: CoordinatorResponseEnvelope): CoordinatorResponseEnvelope {
    if (response.ok) return response;
    const code = coordinationErrorCode(response.error_code);
    const definition = coordinationFailureDefinition(code);
    const message = typeof response.payload['message'] === 'string' ? response.payload['message'] : `coordinator request failed with ${code}`;
    const responseEvidence = response.payload['evidence'];
    if (responseEvidence !== undefined && (!Array.isArray(responseEvidence) || responseEvidence.some((entry) => typeof entry !== 'string'))) throw new CoordinationRuntimeError('schema-mismatch', 'coordinator failure response evidence is not a string array');
    const serverEvidence = responseEvidence === undefined ? [] : responseEvidence as readonly string[];
    throw new CoordinationRuntimeError(code, message, [
      `failure_class=${definition.failure_class}`,
      ...serverEvidence.map((entry, index) => `server_evidence[${String(index)}]=${entry}`),
    ]);
  }
}

export function durableIdentifier(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}
