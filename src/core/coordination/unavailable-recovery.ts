import { isProcessAlive, preflightProcessRetirementSupport, processStartIdentity, retireExactProcess } from './process-identity.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { ensureCoordinatorPrivateRoots, type CoordinatorRuntimePaths } from './runtime-paths.ts';
import { acquireSerializedProcessGuard, readExactLockText } from './serialized-lock.ts';
import { parseKnownCompatibleCurrentCoordinatorLock, parsePredecessorCoordinatorLock, type KnownCompatibleCurrentCoordinatorLock, type PredecessorCoordinatorLock } from './upgrade-contracts.ts';

const DEFAULT_UNAVAILABLE_ATTESTATION_MS = 2_000;
const DEFAULT_RETIREMENT_TIMEOUT_MS = 10_000;
const UNAVAILABLE_PROBE_INTERVAL_MS = 100;

export interface UnavailableCoordinatorRecoveryReport {
  readonly outcome: 'endpoint-recovered' | 'owner-absent' | 'owner-retired';
  readonly package_build: string;
  readonly pid: number;
  readonly instance_id: string;
  readonly endpoint_probe_count: number;
}

interface RecoveryOptions {
  readonly attestationTimeoutMs?: number;
  readonly retirementTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function report(owner: KnownCompatibleCurrentCoordinatorLock, outcome: UnavailableCoordinatorRecoveryReport['outcome'], probes: number): UnavailableCoordinatorRecoveryReport {
  return { outcome, package_build: owner.package_build, pid: owner.pid, instance_id: owner.instance_id, endpoint_probe_count: probes };
}

function sameCurrentOwner(left: KnownCompatibleCurrentCoordinatorLock, right: KnownCompatibleCurrentCoordinatorLock): boolean {
  return left.pid === right.pid
    && left.boot_id === right.boot_id
    && left.process_start_identity === right.process_start_identity
    && left.token === right.token
    && left.instance_id === right.instance_id
    && left.package_build === right.package_build
    && left.protocol_version === right.protocol_version
    && left.database_schema_version === right.database_schema_version
    && left.started_at === right.started_at;
}

function sameFenceOwner(left: PredecessorCoordinatorLock, right: PredecessorCoordinatorLock): boolean {
  return left.pid === right.pid && left.token === right.token && left.started_at === right.started_at;
}

async function exactCurrentLock(paths: CoordinatorRuntimePaths, expectedText: string, expected: KnownCompatibleCurrentCoordinatorLock): Promise<void> {
  const text = await readExactLockText(paths.lockPath);
  if (text !== expectedText) throw new CoordinationRuntimeError('coordinator-contention', 'coordinator lifecycle identity changed during unavailable-endpoint recovery');
  let parsed: ReturnType<typeof parseKnownCompatibleCurrentCoordinatorLock> = null;
  try { parsed = parseKnownCompatibleCurrentCoordinatorLock(JSON.parse(text) as unknown); } catch { /* fail below */ }
  if (parsed === null || !sameCurrentOwner(parsed, expected)) throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator lifecycle identity became unknown during unavailable-endpoint recovery');
}

async function exactFence(paths: CoordinatorRuntimePaths, expected: PredecessorCoordinatorLock): Promise<void> {
  const text = await readExactLockText(paths.predecessorLockPath);
  let parsed: ReturnType<typeof parsePredecessorCoordinatorLock> = null;
  try { parsed = text === null ? null : parsePredecessorCoordinatorLock(JSON.parse(text) as unknown); } catch { /* fail below */ }
  if (parsed === null || !sameFenceOwner(parsed, expected)) throw new CoordinationRuntimeError('coordinator-contention', 'predecessor safety fence changed during unavailable-endpoint recovery');
}

function exactProcessState(owner: KnownCompatibleCurrentCoordinatorLock): 'exact-live' | 'absent' {
  if (!isProcessAlive(owner.pid)) return 'absent';
  const observed = processStartIdentity(owner.pid);
  if (observed === null) throw new CoordinationRuntimeError('recovery-required', 'live coordinator process-creation identity is unavailable; automatic retirement is forbidden', [`pid=${String(owner.pid)}`, `instance_id=${owner.instance_id}`]);
  return observed === owner.process_start_identity ? 'exact-live' : 'absent';
}

function recoveryGuard(paths: CoordinatorRuntimePaths, timeoutMs: number): ReturnType<typeof acquireSerializedProcessGuard> {
  return acquireSerializedProcessGuard(paths.lifecycleElectionPath, Math.max(10_000, timeoutMs), 'unavailable coordinator lifecycle recovery');
}

/**
 * Recovers a known wire-compatible coordinator whose immutable lifecycle owner
 * remains exact but whose authenticated endpoint is unavailable. Probes run
 * without holding lifecycle election so a healthy prior build's fence timer is
 * never starved by diagnosis. Election is then acquired to exclude startup and
 * replacement, released for one final endpoint probe, and reacquired before the
 * exact identity-fenced signal. PID liveness alone is never retirement proof.
 */
export async function recoverUnavailableKnownCoordinator(
  paths: CoordinatorRuntimePaths,
  probeEndpoint: () => Promise<boolean>,
  options: RecoveryOptions = {},
): Promise<UnavailableCoordinatorRecoveryReport> {
  await ensureCoordinatorPrivateRoots(paths);
  const attestationTimeoutMs = options.attestationTimeoutMs ?? DEFAULT_UNAVAILABLE_ATTESTATION_MS;
  const retirementTimeoutMs = options.retirementTimeoutMs ?? DEFAULT_RETIREMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(attestationTimeoutMs) || attestationTimeoutMs < 100 || attestationTimeoutMs > 30_000 || !Number.isSafeInteger(retirementTimeoutMs) || retirementTimeoutMs < 100 || retirementTimeoutMs > 30_000) throw new CoordinationRuntimeError('invalid-request', 'unavailable coordinator recovery timeouts are outside their bounded contract');

  const lockText = await readExactLockText(paths.lockPath);
  if (lockText === null) throw new CoordinationRuntimeError('coordinator-unavailable', 'unavailable coordinator lifecycle lock disappeared before recovery');
  let owner: ReturnType<typeof parseKnownCompatibleCurrentCoordinatorLock> = null;
  try { owner = parseKnownCompatibleCurrentCoordinatorLock(JSON.parse(lockText) as unknown); } catch { /* fail below */ }
  if (owner === null) throw new CoordinationRuntimeError('protocol-mismatch', 'unavailable coordinator recovery requires an exact known wire-compatible lifecycle owner');
  if (owner.pid === process.pid) throw new CoordinationRuntimeError('recovery-required', 'client process is recorded as coordinator owner; automatic self-retirement is forbidden', [`pid=${String(owner.pid)}`]);
  const fenceText = await readExactLockText(paths.predecessorLockPath);
  let fence: ReturnType<typeof parsePredecessorCoordinatorLock> = null;
  try { fence = fenceText === null ? null : parsePredecessorCoordinatorLock(JSON.parse(fenceText) as unknown); } catch { /* fail below */ }
  if (fence === null || fence.pid !== owner.pid || fence.started_at !== owner.started_at) throw new CoordinationRuntimeError('recovery-required', 'known coordinator predecessor fence does not bind the exact lifecycle owner', [`pid=${String(owner.pid)}`, `instance_id=${owner.instance_id}`]);
  if (exactProcessState(owner) === 'absent') return report(owner, 'owner-absent', 0);

  const deadline = Date.now() + attestationTimeoutMs;
  let endpointProbeCount = 0;
  do {
    await exactCurrentLock(paths, lockText, owner);
    await exactFence(paths, fence);
    if (exactProcessState(owner) === 'absent') return report(owner, 'owner-absent', endpointProbeCount);
    endpointProbeCount += 1;
    if (await probeEndpoint()) return report(owner, 'endpoint-recovered', endpointProbeCount);
    if (Date.now() < deadline) await sleep(Math.min(UNAVAILABLE_PROBE_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);

  // First election pass proves no startup/replacement transaction is in flight.
  const preFinalGuard = recoveryGuard(paths, attestationTimeoutMs);
  try {
    await exactCurrentLock(paths, lockText, owner);
    await exactFence(paths, fence);
    if (exactProcessState(owner) === 'absent') return report(owner, 'owner-absent', endpointProbeCount);
  } finally { preFinalGuard.release(); }

  // The final probe runs without starving the prior coordinator's own lifecycle
  // maintenance. A recovered endpoint always wins over retirement.
  endpointProbeCount += 1;
  if (await probeEndpoint()) return report(owner, 'endpoint-recovered', endpointProbeCount);

  const retirementGuard = recoveryGuard(paths, attestationTimeoutMs);
  try {
    await exactCurrentLock(paths, lockText, owner);
    await exactFence(paths, fence);
    if (exactProcessState(owner) === 'absent') return report(owner, 'owner-absent', endpointProbeCount);
    preflightProcessRetirementSupport();
    retireExactProcess(owner.pid, owner.process_start_identity);
    const retirementDeadline = Date.now() + retirementTimeoutMs;
    while (Date.now() < retirementDeadline) {
      if (!isProcessAlive(owner.pid)) return report(owner, 'owner-retired', endpointProbeCount);
      let observed = processStartIdentity(owner.pid);
      if (observed === null) {
        // kill(0) and process metadata can race during final reap. Recheck both;
        // only a still-live process with repeated missing birth identity is ambiguous.
        await sleep(25);
        if (!isProcessAlive(owner.pid)) return report(owner, 'owner-retired', endpointProbeCount);
        observed = processStartIdentity(owner.pid);
        if (observed === null) throw new CoordinationRuntimeError('recovery-required', 'coordinator process identity became ambiguous after exact retirement signal', [`pid=${String(owner.pid)}`]);
      }
      if (observed !== owner.process_start_identity) return report(owner, 'owner-retired', endpointProbeCount);
      await sleep(25);
    }
    throw new CoordinationRuntimeError('coordinator-unavailable', 'exact unavailable coordinator did not retire before the bounded replacement deadline', [`pid=${String(owner.pid)}`, `instance_id=${owner.instance_id}`, `probe_count=${String(endpointProbeCount)}`]);
  } finally { retirementGuard.release(); }
}
