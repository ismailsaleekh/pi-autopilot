import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinatorFrameDecoder, encodeCoordinatorFrame } from '../../src/core/coordination/ipc.ts';
import { currentBootId, processStartIdentity } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import {
  installActualCf50Package,
  loadActualCf50Client,
  startActualCf50Coordinator,
  verifyActualCf50Fixture,
  type VersionSkewClient,
  type VersionSkewMutationIdentity,
  type VersionSkewResponse,
} from '../helpers/actual-cf50-package.ts';
import { assertNoLeakedCoordinators, stopCoordinatorByLock, stopTestCoordinatorsForStateRoot } from '../helpers/coordinator-process-lifecycle.ts';

interface JsonMap { readonly [key: string]: unknown }

interface AttachedJourney {
  readonly client: VersionSkewClient;
  readonly heartbeatIdentity: VersionSkewMutationIdentity;
  readonly heartbeatPayload: Readonly<Record<string, unknown>>;
  readonly firstHeartbeat: VersionSkewResponse;
}

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonMap;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} is not an integer`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is not a non-empty string`);
  return value;
}

function sessionToken(seed: string): string {
  const code = seed.codePointAt(0) ?? 1;
  return (code % 16).toString(16).repeat(64);
}

function runPayload(root: string, prefix: string): Readonly<Record<string, unknown>> {
  const repoRoot = join(root, `${prefix}-repository`);
  const worktreeRoot = join(root, `${prefix}-worktrees`);
  const main = join(worktreeRoot, 'active', `${prefix}-run`, 'main');
  return {
    repo_key: `${prefix}-repo`, canonical_root: repoRoot, git_common_dir: join(repoRoot, '.git'), autopilot_id: `${prefix}-autopilot`, workstream: `${prefix}-work`, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: `${prefix}-repo`, workstream_run: `${prefix}-run`,
      source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: worktreeRoot,
      main_worktree_path: main, runtime_root: join(main, '.pi', 'autopilot', `${prefix}-work`),
      branch: `autopilot/${prefix}-run`, target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null,
      started_at: '2026-07-16T00:00:00.000Z', version: 1,
    },
  };
}

async function attachAndHeartbeat(client: VersionSkewClient, root: string, prefix: string): Promise<AttachedJourney> {
  const repoId = `${prefix}-repo`;
  const workstreamRun = `${prefix}-run`;
  const sessionId = `${prefix}-session`;
  const leaseId = `${prefix}-session-lease`;
  const token = sessionToken(prefix);
  const attachedRunResponse = await client.mutate('attach-run', {
    repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `${prefix}-attach-run`,
  }, runPayload(root, prefix));
  const attachedRun = record(attachedRunResponse.payload['run'], `${prefix} attached run`);
  const attachedSessionResponse = await client.mutate('attach-session', {
    repoId, workstreamRun, sessionId, fencingGeneration: 1, expectedVersion: integer(attachedRun['version'], `${prefix} run version`), idempotencyKey: `${prefix}-attach-session`,
  }, {
    session_lease_id: leaseId, session_token: token, pid: process.pid, boot_id: `${prefix}-boot`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedSession = record(attachedSessionResponse.payload['session'], `${prefix} attached session`);
  const heartbeatIdentity: VersionSkewMutationIdentity = {
    repoId, workstreamRun, sessionId, fencingGeneration: 1,
    expectedVersion: integer(attachedSession['version'], `${prefix} session version`),
    idempotencyKey: `${prefix}-heartbeat-replay`,
  };
  const heartbeatPayload = { session_lease_id: leaseId, session_token: token, lease_expires_at: '2099-01-02T00:00:00.000Z' };
  const firstHeartbeat = await client.mutate('heartbeat', heartbeatIdentity, heartbeatPayload);
  assert.equal(record(firstHeartbeat.payload['session'], `${prefix} heartbeat session`)['status'], 'attached');
  return { client, heartbeatIdentity, heartbeatPayload, firstHeartbeat };
}

async function assertExactReplay(journey: AttachedJourney): Promise<void> {
  const replay = await journey.client.mutate('heartbeat', journey.heartbeatIdentity, journey.heartbeatPayload);
  assert.equal(replay.committed_event_seq, journey.firstHeartbeat.committed_event_seq);
  assert.deepEqual(replay.payload, journey.firstHeartbeat.payload);
}

function assertLegacyCf50Handshake(response: VersionSkewResponse): void {
  assert.equal(response.ok, true);
  assert.equal(response.payload['schema_version'], 'autopilot.coordinator_handshake.v1');
  assert.equal(response.payload['package_build'], '1.1.8-cf50');
  assert.equal(response.payload['protocol_version'], '1.6');
  assert.equal(response.payload['database_schema_version'], 12);
}

async function lifecycleLock(path: string): Promise<JsonMap> {
  return record(JSON.parse(await readFile(path, 'utf8')) as unknown, 'coordinator lifecycle lock');
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onListening = (): void => { server.off('error', rejectListen); resolveListen(); };
    server.once('error', rejectListen);
    server.once('listening', onListening);
    server.listen(path);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
}

void after(async () => { await assertNoLeakedCoordinators(); });

void describe('actual cf50 ↔ current S1 candidate compatibility harness', () => {
  void it('pins the immutable actual cf50 tarball and proves its first request is the exact empty legacy handshake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-actual-cf50-handshake-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const requests: JsonMap[] = [];
    let fake: Server | null = null;
    try {
      const fixture = await verifyActualCf50Fixture();
      assert.equal(fixture.manifest.tarball_sha256, 'sha256:e98ccee99e95d5ba9c958c91c354eef40326fa21cf89a8ba37bd10e6650485a7');
      const installation = await installActualCf50Package(root);
      await mkdir(paths.coordinatorRoot, { recursive: true });
      const processIdentity = processStartIdentity(process.pid);
      if (processIdentity === null) throw new Error('cannot prove fake cf50 endpoint process-birth identity');
      const endpointBootId = currentBootId();
      const endpointInstanceId = 'actual-cf50-handshake-instance';
      const endpointStartedAt = '2026-07-16T00:00:00.000Z';
      await writeFile(paths.lockPath, `${JSON.stringify({
        schema_version: 'autopilot.coordinator_lock.v2', pid: process.pid, boot_id: endpointBootId, process_start_identity: processIdentity,
        token: 'actual-cf50-handshake-lock-token', instance_id: endpointInstanceId, package_build: '1.1.8-cf50',
        protocol_version: '1.6', database_schema_version: 12, started_at: endpointStartedAt,
      })}\n`, 'utf8');
      fake = createServer((socket) => {
        const decoder = new CoordinatorFrameDecoder();
        socket.on('data', (chunk: NodeBuffer) => {
          for (const frame of decoder.push(chunk)) {
            const transport = record(frame, 'actual cf50 handshake transport');
            const request = record(transport['request'], 'actual cf50 handshake request');
            requests.push(request);
            const requestId = stringValue(request['request_id'], 'actual cf50 request id');
            socket.write(encodeCoordinatorFrame({
              schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.6', request_id: requestId, ok: true,
              committed_event_seq: null, error_code: null, retryable: false,
              payload: {
                schema_version: 'autopilot.coordinator_handshake.v1', package_build: '1.1.8-cf50', protocol_version: '1.6', database_schema_version: 12,
                lifecycle_lock_schema: 'autopilot.coordinator_lock.v2', lifecycle_pid: process.pid, lifecycle_boot_id: endpointBootId,
                lifecycle_process_start_identity: processIdentity, lifecycle_instance_id: endpointInstanceId, lifecycle_started_at: endpointStartedAt,
              },
            }));
          }
        });
      });
      await listen(fake, paths.socketPath);
      const actualClient = await loadActualCf50Client({ installation, env, autoStart: false });
      assertLegacyCf50Handshake(await actualClient.query('handshake'));
      assert.equal(requests.length, 1);
      const request = requests[0];
      if (request === undefined) throw new Error('actual cf50 emitted no handshake request');
      assert.deepEqual(Object.keys(request).sort(), ['action', 'expected_version', 'fencing_generation', 'idempotency_key', 'payload', 'protocol_version', 'repo_id', 'request_id', 'schema_version', 'session_id', 'workstream_run'].sort());
      assert.equal(request['schema_version'], 'autopilot.coordinator_request.v1');
      assert.equal(request['protocol_version'], '1.6');
      assert.equal(request['action'], 'handshake');
      assert.equal(request['repo_id'], 'global');
      assert.equal(request['workstream_run'], null);
      assert.equal(request['session_id'], null);
      assert.equal(request['fencing_generation'], null);
      assert.equal(request['expected_version'], null);
      assert.equal(request['idempotency_key'], null);
      assert.deepEqual(request['payload'], {});
    } finally {
      if (fake !== null) await closeServer(fake);
      await stopTestCoordinatorsForStateRoot(stateRoot);
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('runs the actual cf50 client against the candidate coordinator across attach, heartbeat, replay, and natural restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-cf50-client-candidate-server-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const installation = await installActualCf50Package(root);
    let candidate: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      candidate = await startCoordinatorServer(paths);
      const oldClient = await loadActualCf50Client({ installation, env, autoStart: false });
      assertLegacyCf50Handshake(await oldClient.query('handshake'));
      const journey = await attachAndHeartbeat(oldClient, root, 'old-to-candidate');
      const before = await lifecycleLock(paths.lockPath);
      assert.equal(before['package_build'], '1.1.8-cf50', 'the unchanged client must see the frozen cf50 lifecycle façade');

      await candidate.close();
      candidate = await startCoordinatorServer(paths);
      const after = await lifecycleLock(paths.lockPath);
      assert.notEqual(after['instance_id'], before['instance_id'], 'natural restart must publish a new endpoint instance');
      assertLegacyCf50Handshake(await oldClient.query('handshake'));
      await assertExactReplay(journey);
    } finally {
      if (candidate !== null) await candidate.close();
      await stopTestCoordinatorsForStateRoot(stateRoot);
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('runs the candidate client against the actual cf50 coordinator across attach, heartbeat, replay, and natural restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-candidate-client-cf50-server-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const installation = await installActualCf50Package(root);
    let actual: Awaited<ReturnType<typeof startActualCf50Coordinator>> | null = null;
    try {
      actual = await startActualCf50Coordinator({ installation, stateRoot });
      const candidateClient: VersionSkewClient = new CoordinatorClient({ env, autoStart: false });
      assertLegacyCf50Handshake(await candidateClient.query('handshake'));
      const journey = await attachAndHeartbeat(candidateClient, root, 'candidate-to-old');
      const before = await lifecycleLock(actual.paths.lockPath);
      assert.equal(before['pid'], actual.child.pid);
      assert.equal(before['package_build'], '1.1.8-cf50');

      await actual.close();
      actual = await startActualCf50Coordinator({ installation, stateRoot });
      const after = await lifecycleLock(actual.paths.lockPath);
      assert.notEqual(after['instance_id'], before['instance_id'], 'actual cf50 natural restart must publish a new endpoint instance');
      assert.equal(after['pid'], actual.child.pid);
      assertLegacyCf50Handshake(await candidateClient.query('handshake'));
      await assertExactReplay(journey);
      assert.equal((await lifecycleLock(actual.paths.lockPath))['pid'], actual.child.pid, 'candidate client must not replace a healthy actual cf50 predecessor');
    } finally {
      if (actual !== null) await actual.close();
      await stopTestCoordinatorsForStateRoot(stateRoot);
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('converges actual cf50 and candidate auto-start onto one mixed-build election winner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-cf50-s1-mixed-election-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    try {
      const installation = await installActualCf50Package(root);
      const actualClient = await loadActualCf50Client({ installation, env, autoStart: true });
      const candidateClient: VersionSkewClient = new CoordinatorClient({ env, autoStart: true, startupTimeoutMs: 10_000, readinessTimeoutMs: 30_000 });
      const [actualHandshake, candidateHandshake] = await Promise.all([actualClient.query('handshake'), candidateClient.query('handshake')]);
      assertLegacyCf50Handshake(actualHandshake);
      assertLegacyCf50Handshake(candidateHandshake);
      const winner = await lifecycleLock(paths.lockPath);
      const winnerPid = integer(winner['pid'], 'mixed-election winner pid');
      const winnerInstance = stringValue(winner['instance_id'], 'mixed-election winner instance');
      assert.equal(winner['package_build'], '1.1.8-cf50');

      await Promise.all([
        attachAndHeartbeat(actualClient, root, 'mixed-old-client'),
        attachAndHeartbeat(candidateClient, root, 'mixed-candidate-client'),
      ]);
      const stable = await lifecycleLock(paths.lockPath);
      assert.equal(stable['pid'], winnerPid);
      assert.equal(stable['instance_id'], winnerInstance);
    } finally {
      await stopCoordinatorByLock(paths.lockPath);
      await stopTestCoordinatorsForStateRoot(stateRoot);
      await rm(root, { recursive: true, force: true });
    }
  });
});
