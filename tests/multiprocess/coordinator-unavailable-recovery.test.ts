import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { isExactProcessAlive, isProcessAlive, processStartIdentity, retireExactProcess } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths, ensureCoordinatorPrivateRoots } from '../../src/core/coordination/runtime-paths.ts';
import { recoverUnavailableKnownCoordinator } from '../../src/core/coordination/unavailable-recovery.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { startTaggedCoordinator } from '../helpers/tagged-coordinator.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const unavailableOwner = join(packageRoot, 'tests', 'helpers', 'unavailable-coordinator-owner.ts');
const sessionToken = 'a'.repeat(64);
const childToken = 'b'.repeat(64);
const CF45_COMMIT = 'a0d8a732decdb5f7061b01a8c5ead6120cba081f';

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Readonly<Record<string, unknown>>;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} is not an integer`);
  return value;
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => {
      child.once('close', () => resolveExit());
    }),
    new Promise<never>((_resolve, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('process did not exit before timeout')), timeoutMs)),
  ]);
}

async function spawnUnavailableOwner(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ['--experimental-strip-types', unavailableOwner], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('\n')) resolveReady();
    });
    child.once('close', (code) => rejectReady(new Error(`unavailable owner exited before readiness (${String(code)}): ${stderr}`)));
  });
  return child;
}

async function retireSyntheticOwner(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !isProcessAlive(pid)) return;
  const identity = processStartIdentity(pid);
  if (identity === null) throw new Error('synthetic owner identity became unavailable during cleanup');
  const exited = waitForExit(child);
  retireExactProcess(pid, identity);
  await exited;
}

async function stopSpawnedCoordinator(lockPath: string): Promise<void> {
  let lock: Readonly<Record<string, unknown>>;
  try { lock = record(JSON.parse(await readFile(lockPath, 'utf8')) as unknown, 'coordinator lock'); }
  catch { return; }
  const pid = lock['pid'];
  const identity = lock['process_start_identity'];
  if (typeof pid !== 'number' || typeof identity !== 'string' || !isExactProcessAlive(pid, identity)) return;
  retireExactProcess(pid, identity);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isProcessAlive(pid)) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  assert.equal(isProcessAlive(pid), false, 'replacement coordinator must retire during test cleanup');
}

void it('prefers a recovered exact endpoint over retirement throughout the bounded outage window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-unavailable-probe-'));
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') });
  let owner: ReturnType<typeof spawn> | null = null;
  try {
    await ensureCoordinatorPrivateRoots(paths);
    owner = await spawnUnavailableOwner();
    const pid = owner.pid;
    if (pid === undefined) throw new Error('probe owner has no pid');
    const identity = processStartIdentity(pid);
    if (identity === null) throw new Error('probe owner identity is unavailable');
    const startedAt = '2026-07-15T00:02:00.000Z';
    await writeFile(paths.lockPath, `${JSON.stringify({ schema_version: 'autopilot.coordinator_lock.v2', pid, boot_id: 'probe-owner-boot', process_start_identity: identity, token: 'probe-owner-token', instance_id: 'probe-owner-instance', package_build: '1.1.3-cf45', protocol_version: '1.6', database_schema_version: 12, started_at: startedAt })}\n`, 'utf8');
    await writeFile(paths.predecessorLockPath, `${JSON.stringify({ schema_version: 'autopilot.coordinator_lock.v1', pid, boot_id: 'probe-owner-boot', token: 'probe-fence-token', started_at: startedAt })}\n`, 'utf8');
    let probes = 0;
    const report = await recoverUnavailableKnownCoordinator(paths, () => Promise.resolve(++probes === 2), { attestationTimeoutMs: 1_000, retirementTimeoutMs: 1_000 });
    assert.equal(report.outcome, 'endpoint-recovered');
    assert.equal(report.endpoint_probe_count, 2);
    assert.equal(isExactProcessAlive(pid, identity), true, 'endpoint recovery must not signal its exact lifecycle owner');
  } finally {
    if (owner !== null) await retireSyntheticOwner(owner);
    await rm(root, { recursive: true, force: true });
  }
});

void it('rejects lifecycle replacement during outage attestation without signaling either identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-unavailable-race-'));
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') });
  let owner: ReturnType<typeof spawn> | null = null;
  try {
    await ensureCoordinatorPrivateRoots(paths);
    owner = await spawnUnavailableOwner();
    const pid = owner.pid;
    if (pid === undefined) throw new Error('race owner has no pid');
    const identity = processStartIdentity(pid);
    if (identity === null) throw new Error('race owner identity is unavailable');
    const startedAt = '2026-07-15T00:03:00.000Z';
    const initialLock = { schema_version: 'autopilot.coordinator_lock.v2', pid, boot_id: 'race-owner-boot', process_start_identity: identity, token: 'race-owner-token', instance_id: 'race-owner-instance', package_build: '1.1.3-cf45', protocol_version: '1.6', database_schema_version: 12, started_at: startedAt };
    await writeFile(paths.lockPath, `${JSON.stringify(initialLock)}\n`, 'utf8');
    await writeFile(paths.predecessorLockPath, `${JSON.stringify({ schema_version: 'autopilot.coordinator_lock.v1', pid, boot_id: 'race-owner-boot', token: 'race-fence-token', started_at: startedAt })}\n`, 'utf8');
    let replaced = false;
    await assert.rejects(() => recoverUnavailableKnownCoordinator(paths, async () => {
      if (!replaced) {
        replaced = true;
        await writeFile(paths.lockPath, `${JSON.stringify({ ...initialLock, token: 'replacement-token', instance_id: 'replacement-instance' })}\n`, 'utf8');
      }
      return false;
    }, { attestationTimeoutMs: 500, retirementTimeoutMs: 1_000 }), (error: unknown) => typeof error === 'object' && error !== null && (error as Readonly<Record<string, unknown>>)['code'] === 'coordinator-contention');
    assert.equal(isExactProcessAlive(pid, identity), true, 'identity replacement must abort before signaling');
  } finally {
    if (owner !== null) await retireSyntheticOwner(owner);
    await rm(root, { recursive: true, force: true });
  }
});

void it('replaces the real cf45 binary after socket loss while preserving an attached session across concurrent cf48 clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-real-cf45-handoff-'));
  const stateRoot = join(root, 'state');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const tagged = await startTaggedCoordinator({ stateRoot, extractionRoot: root, commit: CF45_COMMIT });
  const paths = tagged.paths;
  try {
    const cf45Client = new CoordinatorClient({ env, autoStart: false });
    const attached = await cf45Client.mutate('attach-run', { repoId: 'repo-cf45-handoff', workstreamRun: 'run-cf45-handoff', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-cf45-handoff' }, {
      repo_key: 'repo-cf45-handoff', canonical_root: '/tmp/repo-cf45-handoff', git_common_dir: '/tmp/repo-cf45-handoff/.git', autopilot_id: 'autopilot-cf45-handoff', workstream: 'cf45-handoff', coordination_authority: 'coordinator-edit-leases-v1',
      run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-cf45-handoff', workstream_run: 'run-cf45-handoff', source_repo: '/tmp/repo-cf45-handoff', git_common_dir: '/tmp/repo-cf45-handoff/.git', worktree_root: '/tmp/state/worktrees/repo-cf45-handoff', main_worktree_path: '/tmp/state/worktrees/repo-cf45-handoff/active/run-cf45-handoff/main', runtime_root: '/tmp/state/worktrees/repo-cf45-handoff/active/run-cf45-handoff/main/.pi/autopilot/cf45-handoff', branch: 'autopilot/run-cf45-handoff', target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-15T02:58:00.000Z', version: 1 },
    });
    const run = record(attached.payload['run'], 'cf45 run');
    let runVersion = integer(run['version'], 'cf45 run version');
    let session: Readonly<Record<string, unknown>> | null = null;
    for (let generation = 1; generation <= 9; generation += 1) {
      const finalGeneration = generation === 9;
      const token = finalGeneration ? sessionToken : generation.toString(16).repeat(64);
      const sessionResponse = await cf45Client.mutate('attach-session', { repoId: 'repo-cf45-handoff', workstreamRun: 'run-cf45-handoff', sessionId: `session-generation-${String(generation)}`, fencingGeneration: generation, expectedVersion: runVersion, idempotencyKey: `attach-session-cf45-handoff-${String(generation)}` }, { session_lease_id: `lease-session-generation-${String(generation)}`, session_token: token, pid: process.pid, boot_id: `session-generation-${String(generation)}-boot`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
      session = record(sessionResponse.payload['session'], 'cf45 session');
      runVersion = integer(record(sessionResponse.payload['run'], 'cf45 attached run')['version'], 'cf45 attached run version');
    }
    if (session === null) throw new Error('cf45 generation-9 session was not attached');
    const priorPid = tagged.child.pid;
    if (priorPid === undefined) throw new Error('real cf45 process has no pid');
    await unlink(paths.socketPath);

    const heartbeatClient = new CoordinatorClient({ env, startupTimeoutMs: 30_000 });
    const statusClient = new CoordinatorClient({ env, startupTimeoutMs: 30_000 });
    const [heartbeat, status] = await Promise.all([
      heartbeatClient.mutate('heartbeat', { repoId: 'repo-cf45-handoff', workstreamRun: 'run-cf45-handoff', sessionId: 'session-generation-9', fencingGeneration: 9, expectedVersion: integer(session['version'], 'cf45 session version'), idempotencyKey: 'heartbeat-after-real-cf45-socket-loss' }, { session_lease_id: 'lease-session-generation-9', session_token: sessionToken, lease_expires_at: '2099-01-02T00:00:00.000Z' }),
      statusClient.query('status', 'repo-cf45-handoff', 'run-cf45-handoff'),
    ]);
    assert.equal(record(heartbeat.payload['session'], 'recovered session')['status'], 'attached');
    const sessions = status.payload['session_leases'];
    assert.equal(Array.isArray(sessions) && sessions.some((entry) => record(entry, 'preserved session')['session_lease_id'] === 'lease-session-generation-9' && record(entry, 'preserved session')['status'] === 'attached'), true);
    assert.equal(isProcessAlive(priorPid), false);
    const currentLock = record(JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown, 'cf48 replacement lock');
    assert.equal(currentLock['package_build'], '1.1.6-cf48');
    assert.notEqual(currentLock['pid'], priorPid);
  } finally {
    await tagged.close();
    await stopSpawnedCoordinator(paths.lockPath);
    await rm(root, { recursive: true, force: true });
  }
});

void it('identity-fences a live socketless known coordinator and preserves active session and child leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-unavailable-recovery-'));
  const stateRoot = join(root, 'state');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const paths = coordinatorRuntimePaths(env);
  let initial: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
  let unavailable: ReturnType<typeof spawn> | null = null;
  try {
    initial = await startCoordinatorServer(paths);
    const initialClient = new CoordinatorClient({ env, autoStart: false });
    const attached = await initialClient.mutate('attach-run', { repoId: 'repo-unavailable', workstreamRun: 'run-unavailable', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-unavailable' }, {
      repo_key: 'repo-unavailable', canonical_root: '/tmp/repo-startup-race', git_common_dir: '/tmp/repo-startup-race/.git', autopilot_id: 'autopilot-unavailable', workstream: 'unavailable', coordination_authority: 'coordinator-edit-leases-v1',
      run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-unavailable', workstream_run: 'run-unavailable', source_repo: '/tmp/repo-startup-race', git_common_dir: '/tmp/repo-startup-race/.git', worktree_root: '/tmp/state/worktrees/repo-unavailable', main_worktree_path: '/tmp/state/worktrees/repo-unavailable/active/run-unavailable/main', runtime_root: '/tmp/state/worktrees/repo-unavailable/active/run-unavailable/main/.pi/autopilot/unavailable', branch: 'autopilot/run-unavailable', target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-15T00:00:00.000Z', version: 1 },
    });
    const run = record(attached.payload['run'], 'attached run');
    const sessionResponse = await initialClient.mutate('attach-session', { repoId: 'repo-unavailable', workstreamRun: 'run-unavailable', sessionId: 'session-unavailable', fencingGeneration: 1, expectedVersion: integer(run['version'], 'run version'), idempotencyKey: 'attach-session-unavailable' }, { session_lease_id: 'lease-session-unavailable', session_token: sessionToken, pid: process.pid, boot_id: 'session-boot-unavailable', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
    const attachedRun = record(sessionResponse.payload['run'], 'session run');
    const session = record(sessionResponse.payload['session'], 'session');
    await initialClient.mutate('acquire-group', { repoId: 'repo-unavailable', workstreamRun: 'run-unavailable', sessionId: 'session-unavailable', fencingGeneration: 1, expectedVersion: integer(attachedRun['version'], 'attached run version'), idempotencyKey: 'acquire-unavailable' }, { acquisition_group_id: 'group-unavailable', acquisition_kind: 'initial', unit_id: 'unit-response-loss', attempt: 1, requested_leases: [{ path: 'src/unavailable.ts', mode: 'WRITE', purpose: 'preserved child authority' }], reason: 'establish active child before coordinator outage', normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-response-loss:1', evidence: null }, spec_ref: 'unit-specs/unit-response-loss.json', spec_sha256: `sha256:${'c'.repeat(64)}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: 'lease-session-unavailable', session_token: sessionToken });
    const childResponse = await initialClient.mutate('register-child', { repoId: 'repo-unavailable', workstreamRun: 'run-unavailable', sessionId: 'session-unavailable', fencingGeneration: 1, expectedVersion: integer(attachedRun['version'], 'child run version'), idempotencyKey: 'register-child-unavailable' }, { child_lease_id: 'child-run-unavailable-unit-response-loss-1', autopilot_id: 'autopilot-unavailable', unit_id: 'unit-response-loss', attempt: 1, pid: process.pid, boot_id: 'child-boot-unavailable', child_token: childToken, session_lease_id: 'lease-session-unavailable', session_token: sessionToken, lease_expires_at: '2099-01-01T00:00:00.000Z' });
    const child = record(childResponse.payload['child'], 'child');
    await initial.close();
    initial = null;

    unavailable = await spawnUnavailableOwner();
    const unavailablePid = unavailable.pid;
    if (unavailablePid === undefined) throw new Error('unavailable owner has no pid');
    const unavailableIdentity = processStartIdentity(unavailablePid);
    if (unavailableIdentity === null) throw new Error('unavailable owner process identity is unavailable');
    const startedAt = '2026-07-15T00:01:00.000Z';
    const oldLock = { schema_version: 'autopilot.coordinator_lock.v2', pid: unavailablePid, boot_id: 'socketless-owner-boot', process_start_identity: unavailableIdentity, token: 'socketless-owner-token', instance_id: 'socketless-owner-instance', package_build: '1.1.2-cf44', protocol_version: '1.6', database_schema_version: 12, started_at: startedAt };
    const oldFence = { schema_version: 'autopilot.coordinator_lock.v1', pid: unavailablePid, boot_id: 'socketless-owner-boot', token: 'socketless-fence-token', started_at: startedAt };
    await writeFile(paths.lockPath, `${JSON.stringify(oldLock)}\n`, 'utf8');
    await writeFile(paths.predecessorLockPath, `${JSON.stringify(oldFence)}\n`, 'utf8');

    const recoveringClient = new CoordinatorClient({ env });
    const recoveredStatus = await recoveringClient.query('status', 'repo-unavailable', 'run-unavailable');
    await waitForExit(unavailable);
    assert.equal(isProcessAlive(unavailablePid), false);
    const replacementLock = record(JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown, 'replacement lock');
    assert.equal(replacementLock['package_build'], '1.1.6-cf48');
    assert.notEqual(replacementLock['pid'], unavailablePid);
    const sessions = recoveredStatus.payload['session_leases'];
    const children = recoveredStatus.payload['child_leases'];
    const leases = recoveredStatus.payload['edit_leases'];
    assert.equal(Array.isArray(sessions) && sessions.some((entry) => record(entry, 'session row')['session_lease_id'] === 'lease-session-unavailable' && record(entry, 'session row')['status'] === 'attached'), true);
    assert.equal(Array.isArray(children) && children.some((entry) => record(entry, 'child row')['child_lease_id'] === 'child-run-unavailable-unit-response-loss-1' && record(entry, 'child row')['status'] === 'running'), true);
    assert.equal(Array.isArray(leases) && leases.length, 1, 'WRITE authority must survive coordinator replacement');

    const heartbeat = await recoveringClient.mutate('heartbeat', { repoId: 'repo-unavailable', workstreamRun: 'run-unavailable', sessionId: 'session-unavailable', fencingGeneration: 1, expectedVersion: integer(session['version'], 'session version'), idempotencyKey: 'heartbeat-after-unavailable-recovery' }, { session_lease_id: 'lease-session-unavailable', session_token: sessionToken, lease_expires_at: '2099-01-02T00:00:00.000Z' });
    assert.equal(record(heartbeat.payload['session'], 'heartbeat session')['status'], 'attached');
    const childHeartbeat = await recoveringClient.mutate('heartbeat-child', { repoId: 'repo-unavailable', workstreamRun: 'run-unavailable', sessionId: null, fencingGeneration: null, expectedVersion: integer(child['version'], 'child version'), idempotencyKey: 'child-heartbeat-after-unavailable-recovery' }, { child_lease_id: 'child-run-unavailable-unit-response-loss-1', child_token: childToken, pid: process.pid, boot_id: 'child-boot-unavailable', lease_expires_at: '2099-01-02T00:00:00.000Z' });
    assert.equal(record(childHeartbeat.payload['child'], 'heartbeat child')['status'], 'running');
  } finally {
    if (initial !== null) await initial.close();
    if (unavailable !== null) await retireSyntheticOwner(unavailable);
    await stopSpawnedCoordinator(paths.lockPath);
    await rm(root, { recursive: true, force: true });
  }
});
