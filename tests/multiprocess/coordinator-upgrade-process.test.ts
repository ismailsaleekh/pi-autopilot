import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessLite } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { CoordinatorFrameDecoder, AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, encodeCoordinatorFrame } from '../../src/core/coordination/ipc.ts';
import { isProcessAlive, predecessorCompatibleBootEstimate, predecessorCompatibleBootId } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths, readOrCreateCoordinatorCapability, type CoordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION, preparePredecessorCoordinatorUpgrade, readCoordinatorUpgradeIntent } from '../../src/core/coordination/upgrade.ts';
import { parseCurrentCoordinatorLock, parsePredecessorCoordinatorLock } from '../../src/core/coordination/upgrade-contracts.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const tscPath = join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const upgradeOwnerProcess = join(packageRoot, 'tests', 'helpers', 'upgrade-owner-process.ts');

interface RunningProcess { readonly child: ChildProcessLite; exited: boolean; stderr: string }
interface BuiltPredecessor { readonly root: string; readonly bin: string }

function sleep(ms: number): Promise<void> { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(25); }
  throw new Error('condition did not become true before timeout');
}
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown; }

async function archiveAndBuildExactPredecessor(root: string): Promise<BuiltPredecessor> {
  const predecessorRoot = join(root, 'aa3e377');
  const archivePath = join(root, 'aa3e377.tar');
  await mkdir(predecessorRoot, { recursive: true });
  const archive = spawnSync('git', ['archive', '--format=tar', `--output=${archivePath}`, 'aa3e377'], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(archive.status, 0, archive.stderr);
  const extract = spawnSync('tar', ['-xf', archivePath, '-C', predecessorRoot], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  await symlink(join(packageRoot, 'node_modules'), join(predecessorRoot, 'node_modules'), 'junction');
  const build = spawnSync(process.execPath, [tscPath, '-p', join(predecessorRoot, 'tsconfig.build.json')], { cwd: predecessorRoot, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const bin = join(predecessorRoot, 'bin', 'autopilot-coordinator.mjs');
  assert.equal(existsSync(bin), true);
  return { root: predecessorRoot, bin };
}

function startCoordinator(bin: string, cwd: string, stateRoot: string): RunningProcess {
  const child = spawn(process.execPath, [bin, 'serve', '--state-root', stateRoot], {
    cwd,
    env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const running: RunningProcess = { child, exited: false, stderr: '' };
  child.stderr?.on('data', (chunk) => { running.stderr += chunk.toString('utf8'); });
  child.on('close', () => { running.exited = true; });
  return running;
}

async function socketAcceptingConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveConnection) => {
    const socket = connect(path);
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveConnection(ready);
    };
    const timer = setTimeout(() => finish(false), 250);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForExactPredecessor(running: RunningProcess, stateRoot: string): Promise<void> {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  await waitFor(async () => {
    if (running.exited) throw new Error(`aa3e377 exited before readiness: ${running.stderr}`);
    if (!existsSync(paths.predecessorLockPath)) return false;
    try {
      if (parsePredecessorCoordinatorLock(await readJson(paths.predecessorLockPath)) === null || !existsSync(paths.databasePath)) return false;
      return schemaVersion(paths.databasePath) === 6 && await socketAcceptingConnections(paths.predecessorSocketPath);
    } catch { return false; }
  });
}

async function stop(running: RunningProcess): Promise<void> {
  if (!running.exited) running.child.kill('SIGTERM');
  await waitFor(() => running.exited).catch(() => undefined);
}

async function stopCurrent(stateRoot: string): Promise<void> {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  if (!existsSync(paths.lockPath)) return;
  const lock = parseCurrentCoordinatorLock(await readJson(paths.lockPath));
  if (lock !== null && isProcessAlive(lock.pid)) process.kill(lock.pid, 'SIGTERM');
  if (lock !== null) await waitFor(() => !isProcessAlive(lock.pid)).catch(() => undefined);
}

function schemaVersion(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version); }
  finally { database.close(); }
}

interface OldSession {
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly sessionId: string;
  readonly sessionLeaseId: string;
  readonly sessionToken: string;
  readonly runVersion: number;
  readonly sessionVersion: number;
}

let oldRequestOrdinal = 0;
async function oldRequest(paths: CoordinatorRuntimePaths, capability: string, request: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const socket = connect(paths.predecessorSocketPath);
  const decoder = new CoordinatorFrameDecoder();
  return await new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const finish = (error: unknown, response?: Readonly<Record<string, unknown>>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== null) rejectResponse(error);
      else if (response === undefined) rejectResponse(new Error('old coordinator response is absent'));
      else resolveResponse(response);
    };
    const timer = setTimeout(() => finish(new Error('old coordinator request timed out')), 5_000);
    socket.on('data', (chunk: NodeBuffer) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) finish(null, frames[0] as Readonly<Record<string, unknown>>);
      } catch (error) { finish(error); }
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => { if (!settled) finish(new Error('old coordinator closed without a response')); });
    socket.once('connect', () => socket.write(encodeCoordinatorFrame({ transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability, request })));
  });
}

function oldEnvelope(action: string, identity: { readonly repoId: string; readonly workstreamRun: string | null; readonly sessionId: string | null; readonly fencingGeneration: number | null; readonly expectedVersion: number | null; readonly idempotencyKey: string | null }, payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  oldRequestOrdinal += 1;
  return { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.2', request_id: `old-barrier-${String(oldRequestOrdinal)}`, action, idempotency_key: identity.idempotencyKey, repo_id: identity.repoId, workstream_run: identity.workstreamRun, session_id: identity.sessionId, fencing_generation: identity.fencingGeneration, expected_version: identity.expectedVersion, payload };
}

async function attachOldSession(paths: CoordinatorRuntimePaths, capability: string): Promise<OldSession> {
  const repoId = 'repo-barrier';
  const workstreamRun = 'run-barrier';
  const sessionId = 'session-barrier';
  const sessionLeaseId = 'lease-barrier';
  const sessionToken = 'ab'.repeat(32);
  const attachedRun = await oldRequest(paths, capability, oldEnvelope('attach-run', { repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'barrier-attach-run' }, { repo_key: repoId, canonical_root: '/tmp/barrier', git_common_dir: '/tmp/barrier/.git', autopilot_id: 'autopilot-barrier', workstream: 'barrier', coordination_authority: 'coordinator-edit-leases-v1' }));
  assert.equal(attachedRun['ok'], true, JSON.stringify(attachedRun));
  const run = (attachedRun['payload'] as Readonly<Record<string, unknown>>)['run'] as Readonly<Record<string, unknown>>;
  const attachedSession = await oldRequest(paths, capability, oldEnvelope('attach-session', { repoId, workstreamRun, sessionId, fencingGeneration: 1, expectedVersion: Number(run['version']), idempotencyKey: 'barrier-attach-session' }, { session_lease_id: sessionLeaseId, session_token: sessionToken, pid: process.pid, boot_id: 'boot-barrier', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null }));
  assert.equal(attachedSession['ok'], true, JSON.stringify(attachedSession));
  const payload = attachedSession['payload'] as Readonly<Record<string, unknown>>;
  const nextRun = payload['run'] as Readonly<Record<string, unknown>>;
  const session = payload['session'] as Readonly<Record<string, unknown>>;
  return { repoId, workstreamRun, sessionId, sessionLeaseId, sessionToken, runVersion: Number(nextRun['version']), sessionVersion: Number(session['version']) };
}

async function assertOldMutationsDenied(paths: CoordinatorRuntimePaths, capability: string, session: OldSession, suffix: string): Promise<void> {
  const authority = { repoId: session.repoId, workstreamRun: session.workstreamRun, sessionId: session.sessionId, fencingGeneration: 1 };
  const common = { session_lease_id: session.sessionLeaseId, session_token: session.sessionToken };
  const requests = [
    oldEnvelope('heartbeat', { ...authority, expectedVersion: session.sessionVersion, idempotencyKey: `barrier-heartbeat-${suffix}` }, { ...common, lease_expires_at: '2099-02-01T00:00:00.000Z' }),
    oldEnvelope('acquire-group', { ...authority, expectedVersion: session.runVersion, idempotencyKey: `barrier-acquire-${suffix}` }, { ...common, acquisition_group_id: `group-${suffix}`, acquisition_kind: 'initial', unit_id: `unit-${suffix}`, attempt: 1, requested_leases: [{ path: `src/${suffix}.ts`, mode: 'READ', purpose: 'barrier proof' }], reason: 'barrier proof', normal_release_condition: { condition_type: 'child-terminal', target_id: `child-${suffix}`, evidence: null }, spec_ref: `unit-${suffix}.json`, spec_sha256: `sha256:${'a'.repeat(64)}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0 }),
    oldEnvelope('attach-run', { repoId: `repo-mutate-${suffix}`, workstreamRun: `run-mutate-${suffix}`, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `barrier-mutate-${suffix}` }, { repo_key: `repo-mutate-${suffix}`, canonical_root: '/tmp/barrier-mutate', git_common_dir: '/tmp/barrier-mutate/.git', autopilot_id: 'autopilot-mutate', workstream: 'mutate', coordination_authority: 'coordinator-edit-leases-v1' }),
  ];
  for (const request of requests) {
    const response = await oldRequest(paths, capability, request);
    assert.equal(response['ok'], false, `${String(request['action'])} unexpectedly mutated through the barrier`);
    assert.match(String((response['payload'] as Readonly<Record<string, unknown>>)['message']), /schema 6 retired by durable coordinator upgrade barrier/u);
  }
}

void describe('exact aa3e377 coordinator upgrade choreography', () => {
  void it('git-archives, builds, runs, and upgrades the actual executable predecessor to schema 12', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-real-predecessor-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const built = await archiveAndBuildExactPredecessor(root);
    const predecessor = startCoordinator(built.bin, built.root, stateRoot);
    try {
      await waitForExactPredecessor(predecessor, stateRoot);
      assert.equal(schemaVersion(paths.databasePath), 6);
      const response = await new CoordinatorClient({ env, startupTimeoutMs: 30_000 }).query('status');
      assert.equal(response.payload['protocol_version'], '1.6');
      assert.equal(response.payload['database_schema_version'], 12);
      await waitFor(() => predecessor.exited);
      assert.notEqual(parseCurrentCoordinatorLock(await readJson(paths.lockPath)), null);
      assert.notEqual(parsePredecessorCoordinatorLock(await readJson(paths.predecessorLockPath)), null, 'target must maintain an old-format live-PID fence');
      const intent = await readCoordinatorUpgradeIntent(paths);
      assert.equal(intent?.state, 'committed');
      assert.notEqual(intent?.backup, null);
      if (intent?.backup === null || intent?.backup === undefined) throw new Error('final upgrade backup missing');
      assert.equal(`sha256:${createHash('sha256').update(await readFile(intent.backup.path)).digest('hex')}`, intent.backup.sha256);
      assert.equal(schemaVersion(intent.backup.path), 6);
      assert.equal(schemaVersion(paths.databasePath), 12);
    } finally { await stopCurrent(stateRoot); await stop(predecessor); await rm(root, { recursive: true, force: true }); }
  });

  void it('commits the mechanical barrier while the exact predecessor is still alive, then retires it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-real-pre-barrier-attack-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const built = await archiveAndBuildExactPredecessor(root);
    const predecessor = startCoordinator(built.bin, built.root, stateRoot);
    let attack: RunningProcess | null = null;
    let writerAcquiredWhilePredecessorLive = false;
    try {
      await waitForExactPredecessor(predecessor, stateRoot);
      const capability = await readOrCreateCoordinatorCapability(paths);
      const upgrade = await preparePredecessorCoordinatorUpgrade(paths, capability, Date.now() + 25_000, {
        onBoundary: async (boundary) => {
          if (boundary === 'writer-barrier-acquired') {
            writerAcquiredWhilePredecessorLive = !predecessor.exited && isProcessAlive(predecessor.child.pid ?? -1);
            return;
          }
          if (boundary !== 'incompatible-barrier-committed') return;
          assert.equal(predecessor.exited, false, 'the exact predecessor remains alive through backup fsync and barrier COMMIT');
          assert.equal(schemaVersion(paths.databasePath), COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION);
          attack = startCoordinator(built.bin, built.root, stateRoot);
          await waitFor(() => attack?.exited === true, 10_000);
          const heldFence = parsePredecessorCoordinatorLock(await readJson(paths.predecessorLockPath));
          assert.equal(heldFence?.pid, predecessor.child.pid, 'the authenticated predecessor keeps lifecycle ownership until after durable incompatibility');
        },
      });
      await waitFor(() => attack?.exited === true, 15_000);
      const completedAttack = attack as RunningProcess | null;
      if (completedAttack === null) throw new Error('pre-barrier attack process was not started');
      assert.equal(writerAcquiredWhilePredecessorLive, true, 'exclusive SQLite writer barrier is acquired while the predecessor is alive');
      assert.equal(completedAttack.exited, true);
      assert.equal(schemaVersion(paths.databasePath), 12);
      assert.equal(upgrade.intent.state, 'migration-verified');
    } finally { if (attack !== null) await stop(attack); await stop(predecessor); await rm(root, { recursive: true, force: true }); }
  });

  void it('keeps a real stale 1.2 binary powerless after the target exceeds the predecessor freshness window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-real-stale-attack-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const built = await archiveAndBuildExactPredecessor(root);
    const predecessor = startCoordinator(built.bin, built.root, stateRoot);
    let attack: RunningProcess | null = null;
    try {
      await waitForExactPredecessor(predecessor, stateRoot);
      await new CoordinatorClient({ env, startupTimeoutMs: 30_000 }).query('status');
      await waitFor(() => predecessor.exited);
      // Exercise the real aa3e377 freshness window rather than an mtime-only fake.
      await sleep(31_000);
      attack = startCoordinator(built.bin, built.root, stateRoot);
      await waitFor(() => attack?.exited === true, 15_000);
      assert.equal(schemaVersion(paths.databasePath), 12);
      const current = parseCurrentCoordinatorLock(await readJson(paths.lockPath));
      assert.notEqual(current, null);
      await waitFor(async () => parsePredecessorCoordinatorLock(await readJson(paths.predecessorLockPath))?.boot_id === predecessorCompatibleBootId());
      const repairedFence = parsePredecessorCoordinatorLock(await readJson(paths.predecessorLockPath));
      assert.equal(repairedFence?.pid, current?.pid, 'stale predecessor must not displace target authority');
      assert.match(repairedFence?.boot_id ?? '', /^(linux:|darwin:|boot-estimate:)/u, 'target must continuously repair a predecessor-compatible boot identity');
      assert.equal((await new CoordinatorClient({ env, autoStart: false }).query('status')).payload['protocol_version'], '1.6');
      // Simulate a wall-clock correction that invalidates every old-format boot
      // estimate, then remove lock defense entirely. Schema 12 itself must keep
      // the stale executable powerless.
      assert.notEqual(predecessorCompatibleBootEstimate(1_000_000, 100, 'host'), predecessorCompatibleBootEstimate(1_060_000, 100, 'host'));
      await stop(attack);
      attack = null;
      await stopCurrent(stateRoot);
      attack = startCoordinator(built.bin, built.root, stateRoot);
      await waitFor(() => attack?.exited === true, 15_000);
      assert.equal(schemaVersion(paths.databasePath), 12);
    } finally { await stopCurrent(stateRoot); if (attack !== null) await stop(attack); await stop(predecessor); await rm(root, { recursive: true, force: true }); }
  });

  void it('refuses before retirement when authenticated status reports a critical section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-real-critical-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const built = await archiveAndBuildExactPredecessor(root);
    let predecessor = startCoordinator(built.bin, built.root, stateRoot);
    try {
      await waitForExactPredecessor(predecessor, stateRoot);
      await stop(predecessor);
      const database = new DatabaseSync(paths.databasePath);
      try {
        database.exec("INSERT INTO repositories(repo_id,repo_key,canonical_root,git_common_dir,event_seq,created_event_seq,version) VALUES('repo-upgrade','repo-upgrade','/tmp/upgrade','/tmp/upgrade/.git',1,1,1); INSERT INTO runs(repo_id,autopilot_id,workstream,workstream_run,status,active_session_generation,created_event_seq,version,coordination_authority) VALUES('repo-upgrade','autopilot','upgrade','run-upgrade','active',0,1,1,'coordinator-edit-leases-v1');");
        const attempt = { schema_version: 'autopilot.unit_attempt.v1', owner: { repo_id: 'repo-upgrade', autopilot_id: 'autopilot', workstream_run: 'run-upgrade', unit_id: 'unit', attempt: 1 }, state: 'running', role: 'implement', spec: { ref: 'unit.json', sha256: `sha256:${'a'.repeat(64)}` }, preemptible: true, checkpoint_ordinal: 1, critical_section: 'merge-target-fast-forward', version: 1 };
        database.prepare("INSERT INTO unit_attempts(entity_id,repo_id,workstream_run,payload_json,version) VALUES('attempt','repo-upgrade','run-upgrade',?,1)").run(JSON.stringify(attempt));
      } finally { database.close(); }
      predecessor = startCoordinator(built.bin, built.root, stateRoot);
      await waitForExactPredecessor(predecessor, stateRoot);
      await assert.rejects(() => new CoordinatorClient({ env, startupTimeoutMs: 10_000 }).query('status'), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'coordinator-contention');
      assert.equal(predecessor.exited, false);
      assert.equal(schemaVersion(paths.databasePath), 6);
      assert.equal((await readCoordinatorUpgradeIntent(paths))?.state, 'refused');
    } finally { await stop(predecessor); await rm(root, { recursive: true, force: true }); }
  });

  void it('rolls back a pre-commit writer barrier crash and leaves the exact predecessor writable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-real-upgrade-precommit-crash-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const built = await archiveAndBuildExactPredecessor(root);
    const predecessor = startCoordinator(built.bin, built.root, stateRoot);
    let owner: RunningProcess | null = null;
    try {
      await waitForExactPredecessor(predecessor, stateRoot);
      const capability = await readOrCreateCoordinatorCapability(paths);
      const crashBoundary = 'writer-barrier-acquired';
      const child = spawn(process.execPath, ['--experimental-strip-types', upgradeOwnerProcess, stateRoot, crashBoundary], { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      owner = { child, exited: false, stderr: '' };
      let reached = false;
      child.stdout?.on('data', (chunk) => { if (chunk.toString('utf8').includes(crashBoundary)) reached = true; });
      child.stderr?.on('data', (chunk) => { if (owner !== null) owner.stderr += chunk.toString('utf8'); });
      child.on('close', () => { if (owner !== null) owner.exited = true; });
      await waitFor(() => reached || owner?.exited === true);
      assert.equal(reached, true, owner.stderr);
      child.kill('SIGKILL');
      await waitFor(() => owner?.exited === true);
      assert.equal(predecessor.exited, false);
      assert.equal(schemaVersion(paths.databasePath), 6, 'death before COMMIT must roll back every barrier schema change');
      const response = await oldRequest(paths, capability, oldEnvelope('attach-run', { repoId: 'repo-precommit', workstreamRun: 'run-precommit', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'precommit-still-writable' }, { repo_key: 'repo-precommit', canonical_root: '/tmp/precommit', git_common_dir: '/tmp/precommit/.git', autopilot_id: 'autopilot-precommit', workstream: 'precommit', coordination_authority: 'coordinator-edit-leases-v1' }));
      assert.equal(response['ok'], true, JSON.stringify(response));
    } finally { if (owner !== null) await stop(owner); await stop(predecessor); await rm(root, { recursive: true, force: true }); }
  });

  void it('recovers a hard-crashed upgrade owner and serializes racing target clients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-real-upgrade-crash-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const built = await archiveAndBuildExactPredecessor(root);
    const predecessor = startCoordinator(built.bin, built.root, stateRoot);
    let owner: RunningProcess | null = null;
    let attack: RunningProcess | null = null;
    let staleConnection: DatabaseSync | null = null;
    try {
      await waitForExactPredecessor(predecessor, stateRoot);
      const capability = await readOrCreateCoordinatorCapability(paths);
      const oldSession = await attachOldSession(paths, capability);
      staleConnection = new DatabaseSync(paths.databasePath, { timeout: 5_000 });
      const alreadyPreparedMutation = staleConnection.prepare("UPDATE repositories SET event_seq=event_seq+1 WHERE repo_id='repo-barrier'");
      const crashBoundary = 'incompatible-barrier-committed';
      const child = spawn(process.execPath, ['--experimental-strip-types', upgradeOwnerProcess, stateRoot, crashBoundary], { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      owner = { child, exited: false, stderr: '' };
      let prepared = false;
      child.stdout?.on('data', (chunk) => { if (chunk.toString('utf8').includes(crashBoundary)) prepared = true; });
      child.stderr?.on('data', (chunk) => { if (owner !== null) owner.stderr += chunk.toString('utf8'); });
      child.on('close', () => { if (owner !== null) owner.exited = true; });
      await waitFor(() => prepared || owner?.exited === true);
      assert.equal(prepared, true, owner.stderr);
      assert.equal(predecessor.exited, false, 'the exact aa3e377 process must still be alive after barrier COMMIT');
      const barrierInspection = new DatabaseSync(paths.databasePath, { readOnly: true });
      try {
        const tableCount = Number((barrierInspection.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get() as { count: number }).count);
        const triggerCount = Number((barrierInspection.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='trigger' AND name LIKE 'coordinator_upgrade_deny_%'").get() as { count: number }).count);
        assert.equal(triggerCount, tableCount * 3, 'every mutable table must have durable INSERT, UPDATE, and DELETE denial');
      } finally { barrierInspection.close(); }
      assert.throws(() => alreadyPreparedMutation.run(), /schema 6 retired by durable coordinator upgrade barrier/u, 'an UPDATE prepared on an already-open connection must be invalidated and denied');
      await assertOldMutationsDenied(paths, capability, oldSession, 'paused');
      child.kill('SIGKILL');
      await waitFor(() => owner?.exited === true);
      const interrupted = await readCoordinatorUpgradeIntent(paths);
      assert.equal(interrupted?.state, 'preflight-backed-up', 'the database barrier must be recoverable before its JSON publication');
      assert.equal(predecessor.exited, false, 'upgrader death after COMMIT must leave the denied old process alive for exact resume retirement');
      assert.equal(schemaVersion(paths.databasePath), COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION, 'death after COMMIT must never expose writable schema 6');
      assert.throws(() => alreadyPreparedMutation.run(), /schema 6 retired by durable coordinator upgrade barrier/u);
      await assertOldMutationsDenied(paths, capability, oldSession, 'owner-killed');
      assert.equal(existsSync(paths.lockPath), false, 'no target authority is alive during the post-commit recovery gap');
      if (interrupted === null) throw new Error('interrupted upgrade intent missing');
      const deterministicBackup = join(paths.backupsRoot, `coordinator.final.pre-upgrade-1.2-to-1.6.${interrupted.upgrade_id}.db`);
      assert.equal(schemaVersion(deterministicBackup), 6);

      // A direct second launch cannot displace the still-live exact predecessor,
      // and the process that does own the old socket is already trigger-denied.
      attack = startCoordinator(built.bin, built.root, stateRoot);
      await waitFor(() => attack?.exited === true, 15_000);
      assert.equal(schemaVersion(paths.databasePath), COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION, 'a direct aa3e377 restart cannot regain writes during owner downtime');
      staleConnection.close();
      staleConnection = null;

      const clients = [new CoordinatorClient({ env, startupTimeoutMs: 30_000 }), new CoordinatorClient({ env, startupTimeoutMs: 30_000 })];
      const responses = await Promise.all(clients.map(async (client) => await client.query('status')));
      assert.equal(responses.every((response) => response.payload['database_schema_version'] === 12), true);
      const committed = await readCoordinatorUpgradeIntent(paths);
      assert.equal(committed?.state, 'committed');
      assert.equal(committed?.backup?.path, deterministicBackup);
      if (committed?.backup === null || committed?.backup === undefined) throw new Error('reconstructed final backup missing');
      assert.equal(`sha256:${createHash('sha256').update(await readFile(deterministicBackup)).digest('hex')}`, committed.backup.sha256);
      assert.notEqual(parseCurrentCoordinatorLock(await readJson(paths.lockPath)), null);
      assert.equal(predecessor.exited, true, 'resume retires the exact denied predecessor only after reconstructing the barrier backup');
    } finally { staleConnection?.close(); await stopCurrent(stateRoot); if (attack !== null) await stop(attack); if (owner !== null) await stop(owner); await stop(predecessor); await rm(root, { recursive: true, force: true }); }
  });

  void it('restores the byte-exact final backup and loudly requires manual old-binary recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-real-rollback-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const built = await archiveAndBuildExactPredecessor(root);
    const predecessor = startCoordinator(built.bin, built.root, stateRoot);
    try {
      await waitForExactPredecessor(predecessor, stateRoot);
      const capability = await readOrCreateCoordinatorCapability(paths);
      const upgrade = await preparePredecessorCoordinatorUpgrade(paths, capability, Date.now() + 20_000);
      await upgrade.markStarting();
      const backup = upgrade.intent.backup;
      if (backup === null) throw new Error('backup missing');
      await writeFile(paths.databasePath, 'simulated target startup loss\n', 'utf8');
      await upgrade.rollback(new Error('simulated target startup loss'));
      assert.deepEqual(await readFile(paths.databasePath), await readFile(backup.path));
      assert.equal(schemaVersion(paths.databasePath), 6);
      assert.equal((await readCoordinatorUpgradeIntent(paths))?.state, 'rollback-restored');
      assert.equal(existsSync(paths.lockPath), false);
      await assert.rejects(() => new CoordinatorClient({ env, startupTimeoutMs: 3_000 }).query('status'), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required');
      assert.equal(schemaVersion(paths.databasePath), 6);
    } finally { await stop(predecessor); await rm(root, { recursive: true, force: true }); }
  });
});
