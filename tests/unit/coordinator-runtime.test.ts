import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { encodeCoordinatorFrame, parseCoordinatorLegacyReplayTransportRequest, parseCoordinatorTransportRequest } from '../../src/core/coordination/ipc.ts';
import { isProcessAlive, predecessorCompatibleBootEstimate, processStartIdentity, retireExactProcess } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths, windowsPrivateAclCommand, windowsPrivateTreeAclCommand } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import type { CoordinationMessage, CoordinatorRequestEnvelope, CoordinatorResponseEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const EMPTY_COORDINATOR_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({});

void it('builds an exact protected user-only Windows DACL contract for files and authority roots', () => {
  const env = { USERDOMAIN: 'CORP', USERNAME: "operator'o" };
  const directory = windowsPrivateAclCommand("C:\\state with 'quote'", true, env);
  const file = windowsPrivateAclCommand('C:\\state\\freeze.json', false, env);
  assert.equal(directory.executable, 'powershell.exe');
  assert.deepEqual(directory.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.match(directory.args[5] ?? '', /SetSecurityDescriptorSddlForm/u);
  assert.match(directory.args[5] ?? '', /D:P\(A;OICI;FA;;;\$sid\)/u);
  assert.match(directory.args[5] ?? '', /AreAccessRulesProtected/u);
  assert.match(directory.args[5] ?? '', /operator''o/u);
  assert.match(file.args[5] ?? '', /D:P\(A;;FA;;;\$sid\)/u);
  assert.match(file.args[5] ?? '', /SetAccessControl/u);
  assert.equal(/Get-Acl|Set-Acl/u.test(file.args[5] ?? ''), false);
  const tree = windowsPrivateTreeAclCommand('C:\\operator-state\\worktrees', env);
  assert.equal(/Get-ChildItem.*-Recurse/u.test(tree.args[5] ?? ''), false);
  assert.match(tree.args[5] ?? '', /Stack\[string\]/u);
  assert.match(tree.args[5] ?? '', /ReparsePoint/u);
  assert.match(tree.args[5] ?? '', /SetAccessControl/u);
  assert.equal(/Get-Acl|Set-Acl/u.test(tree.args[5] ?? ''), false);
});

void it('uses a refreshable predecessor boot estimate and never exposes second-resolution macOS identity', () => {
  const before = predecessorCompatibleBootEstimate(1_000_000, 100, 'host');
  const corrected = predecessorCompatibleBootEstimate(1_060_000, 100, 'host');
  assert.notEqual(before, corrected, 'a corrected clock produces a fence identity that maintenance must rewrite');
  if (platform() === 'darwin') {
    const identity = processStartIdentity(process.pid);
    assert.match(identity ?? '', /^darwin-proc-birth:\d+:[0-9]{6}$/u);
    assert.equal((identity ?? '').includes('lstart'), false);
  }
  assert.throws(() => retireExactProcess(process.pid, 'ambiguous-or-reused-pid'), /refusing to retire/u);
  assert.equal(isProcessAlive(process.pid), true, 'identity mismatch must never signal the observed PID');
});

interface JsonMap {
  readonly [key: string]: unknown;
}

interface MutableJsonMap {
  [key: string]: unknown;
}

function omitFields(value: JsonMap, omitted: readonly string[]): JsonMap {
  const result: MutableJsonMap = {};
  for (const [key, entry] of Object.entries(value)) if (!omitted.includes(key)) result[key] = entry;
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('canonical test value is not JSON');
  return `{${Object.entries(value).sort((left, right) => left[0].localeCompare(right[0])).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonMap;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} is not an integer`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not text`);
  return value;
}

function queryPayload(response: CoordinatorResponseEnvelope, field: string): readonly unknown[] {
  const value = response.payload[field];
  if (!Array.isArray(value)) throw new Error(`${field} is not an array`);
  return value;
}

function request(overrides: Partial<CoordinatorRequestEnvelope>): CoordinatorRequestEnvelope {
  return {
    schema_version: 'autopilot.coordinator_request.v1',
    protocol_version: '1.6',
    request_id: `request-${randomUUID()}`,
    action: 'status',
    idempotency_key: null,
    repo_id: 'repo-runtime-test',
    workstream_run: null,
    session_id: null,
    fencing_generation: null,
    expected_version: null,
    payload: EMPTY_COORDINATOR_PAYLOAD,
    ...overrides,
  };
}

async function withCoordinator(run: (input: { readonly root: string; readonly client: CoordinatorClient; readonly server: Awaited<ReturnType<typeof startCoordinatorServer>> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-unit-'));
  const stateRoot = join(root, 'state');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  try {
    await run({ root, client: new CoordinatorClient({ env, autoStart: false }), server });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function attachRun(client: CoordinatorClient): Promise<CoordinatorResponseEnvelope> {
  return await client.mutate('attach-run', {
    repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-runtime-test',
  }, {
    repo_key: 'repo-runtime-test', canonical_root: '/tmp/generic-runtime-repository', git_common_dir: '/tmp/generic-runtime-repository/.git', autopilot_id: 'autopilot-runtime-test', workstream: 'runtime-test', coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-runtime-test', workstream_run: 'run-runtime-test',
      source_repo: '/tmp/generic-runtime-repository', git_common_dir: '/tmp/generic-runtime-repository/.git', worktree_root: '/tmp/pi-autopilot-runtime-state/worktrees/repo-runtime-test',
      main_worktree_path: '/tmp/pi-autopilot-runtime-state/worktrees/repo-runtime-test/active/run-runtime-test/main', runtime_root: '/tmp/pi-autopilot-runtime-state/worktrees/repo-runtime-test/active/run-runtime-test/main/.pi/autopilot/runtime-test',
      branch: 'autopilot/run-runtime-test', target_branch: null, target_base_sha: '0000000000000000000000000000000000000000', origin_url: null,
      started_at: '2026-07-12T00:00:00.000Z', version: 1,
    },
  });
}

function sessionToken(generation: number): string {
  return generation.toString(16).repeat(64);
}

async function attachSession(client: CoordinatorClient, runVersion: number, generation: number, sessionId: string, bootId: string): Promise<CoordinatorResponseEnvelope> {
  return await client.mutate('attach-session', {
    repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId, fencingGeneration: generation, expectedVersion: runVersion, idempotencyKey: `attach-session-${sessionId}-${String(generation)}`,
  }, {
    session_lease_id: `lease-${sessionId}-${String(generation)}`, session_token: sessionToken(generation), pid: process.pid, boot_id: bootId, lease_expires_at: '2000-01-01T00:00:00.000Z', handoff_token: null,
  });
}

void describe('transactional coordinator runtime', () => {
  void it('commits duplicate mutations once and exports deterministic transactional evidence', async () => {
    await withCoordinator(async ({ root, client }) => {
      const attachRequest = request({
        action: 'attach-run', idempotency_key: 'attach-run-duplicate', workstream_run: 'run-runtime-test', expected_version: 0,
        payload: {
          repo_key: 'repo-runtime-test', canonical_root: '/tmp/generic-runtime-repository', git_common_dir: '/tmp/generic-runtime-repository/.git', autopilot_id: 'autopilot-runtime-test', workstream: 'runtime-test', coordination_authority: 'coordinator-edit-leases-v1',
          run_resource: {
            schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-runtime-test', workstream_run: 'run-runtime-test',
            source_repo: '/tmp/generic-runtime-repository', git_common_dir: '/tmp/generic-runtime-repository/.git', worktree_root: '/tmp/pi-autopilot-runtime-state/worktrees/repo-runtime-test',
            main_worktree_path: '/tmp/pi-autopilot-runtime-state/worktrees/repo-runtime-test/active/run-runtime-test/main', runtime_root: '/tmp/pi-autopilot-runtime-state/worktrees/repo-runtime-test/active/run-runtime-test/main/.pi/autopilot/runtime-test',
            branch: 'autopilot/run-runtime-test', target_branch: null, target_base_sha: '0000000000000000000000000000000000000000', origin_url: null,
            started_at: '2026-07-12T00:00:00.000Z', version: 1,
          },
        },
      });
      const first = await client.request(attachRequest);
      const second = await client.request(attachRequest);
      assert.equal(first.committed_event_seq, 1);
      assert.equal(second.committed_event_seq, 1);
      const status = await client.query('status', 'repo-runtime-test', 'run-runtime-test');
      assert.equal(queryPayload(status, 'runs').length, 1);

      const exportOne = join(client.paths.exportsRoot, 'export-one.json');
      const exportTwo = join(client.paths.exportsRoot, 'export-two.json');
      await client.query('export', 'global', null, { output_path: exportOne });
      await client.query('export', 'global', null, { output_path: exportTwo });
      assert.equal(await readFile(exportOne, 'utf8'), await readFile(exportTwo, 'utf8'));
      const parsed = record(JSON.parse(await readFile(exportOne, 'utf8')) as unknown, 'export');
      const events = parsed['events'];
      assert.equal(Array.isArray(events) ? events.length : -1, 1);
      const doctor = await client.query('doctor');
      assert.equal(doctor.payload['healthy'], true);
      assert.equal(doctor.payload['integrity'], 'ok');
    });
  });

  void it('confines export output to pre-existing private no-follow directories', async () => {
    await withCoordinator(async ({ root, client }) => {
      await assert.rejects(
        () => client.query('export', 'global', null, { output_path: join(root, 'outside-export.json') }),
        /must remain below the private coordinator exports root/u,
      );
      const privateDirectory = join(client.paths.exportsRoot, 'private-request');
      await mkdir(privateDirectory, { mode: 0o700 });
      const validTarget = join(privateDirectory, 'valid.json');
      await client.query('export', 'global', null, { output_path: validTarget });
      assert.equal(existsSync(validTarget), true);
      if (platform() !== 'win32') {
        const permissiveDirectory = join(client.paths.exportsRoot, 'permissive-request');
        await mkdir(permissiveDirectory, { mode: 0o755 });
        await chmod(permissiveDirectory, 0o755);
        await assert.rejects(
          () => client.query('export', 'global', null, { output_path: join(permissiveDirectory, 'forbidden.json') }),
          /parent directories must be exact mode 0700/u,
        );
        const victim = join(root, 'victim.txt');
        await writeFile(victim, 'preserve\n', 'utf8');
        const parentAlias = join(client.paths.exportsRoot, 'parent-alias');
        await symlink(privateDirectory, parentAlias, 'dir');
        await assert.rejects(
          () => client.query('export', 'global', null, { output_path: join(parentAlias, 'escaped.json') }),
          /must contain only real private directories/u,
        );
        const targetAlias = join(client.paths.exportsRoot, 'target-alias.json');
        await symlink(victim, targetAlias, 'file');
        await assert.rejects(
          () => client.query('export', 'global', null, { output_path: targetAlias }),
          /must be an absent or single-link regular file/u,
        );
        assert.equal(await readFile(victim, 'utf8'), 'preserve\n');
      }
    });
  });

  void it('fails closed without replacing an unknown stale lifecycle identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-unknown-lock-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') });
    await mkdir(paths.coordinatorRoot, { recursive: true });
    const unknown = `${JSON.stringify({ schema_version: 'autopilot.coordinator_lock.v2', pid: 2_147_483_647, boot_id: 'unknown-boot', token: 'unknown-token', instance_id: 'unknown-instance', package_build: 'unknown-build', protocol_version: '1.3', database_schema_version: 999, started_at: '2026-07-13T00:00:00.000Z' })}\n`;
    await writeFile(paths.lockPath, unknown, 'utf8');
    try {
      await assert.rejects(() => startCoordinatorServer(paths), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'protocol-mismatch');
      assert.equal(await readFile(paths.lockPath, 'utf8'), unknown);
      assert.equal(existsSync(paths.databasePath), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('never promotes a pre-cf50 schema-12 matrix build into the S1 predecessor role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-pre-cf50-lock-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') });
    await mkdir(paths.coordinatorRoot, { recursive: true });
    const prior = `${JSON.stringify({ schema_version: 'autopilot.coordinator_lock.v2', pid: 2_147_483_647, boot_id: 'prior-build-boot', process_start_identity: 'prior-build-process', token: 'prior-build-token', instance_id: 'prior-build-instance', package_build: '1.1.7-cf49', protocol_version: '1.6', database_schema_version: 12, started_at: '2026-07-13T00:00:00.000Z' })}\n`;
    await writeFile(paths.lockPath, prior, 'utf8');
    try {
      await assert.rejects(() => startCoordinatorServer(paths), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'protocol-mismatch' && /only the exact cf50 façade/u.test(error.message));
      assert.equal(await readFile(paths.lockPath, 'utf8'), prior);
      assert.equal(existsSync(paths.currentStorePointerPath), false);
      assert.equal(existsSync(paths.runtimeIdentityPath), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('never reclaims a live lifecycle PID because boot identity differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-live-boot-mismatch-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') });
    await mkdir(paths.coordinatorRoot, { recursive: true });
    const identity = processStartIdentity(process.pid);
    if (identity === null) throw new Error('process identity unavailable');
    const live = { schema_version: 'autopilot.coordinator_lock.v2', pid: process.pid, boot_id: 'deliberately-wrong-boot', process_start_identity: identity, token: 'live-token', instance_id: 'live-instance', package_build: '1.0.3-cf40', protocol_version: '1.3', database_schema_version: 9, started_at: '2026-07-13T00:00:00.000Z' };
    await writeFile(paths.lockPath, `${JSON.stringify(live)}\n`, 'utf8');
    try {
      await assert.rejects(() => startCoordinatorServer(paths), (error: unknown) => error instanceof Error && error.name === 'CoordinatorAlreadyRunningError');
      assert.deepEqual(JSON.parse(await readFile(paths.lockPath, 'utf8')), live);
      assert.equal(existsSync(paths.databasePath), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('reclaims a PID-reused known current lock and its paired predecessor fence without signaling the reused process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-pid-reuse-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') });
    await mkdir(paths.coordinatorRoot, { recursive: true });
    const startedAt = '2026-07-15T00:00:00.000Z';
    const stale = { schema_version: 'autopilot.coordinator_lock.v2', pid: process.pid, boot_id: 'stale-owner-boot', process_start_identity: 'linux-start-ticks:1', token: 'stale-owner-token', instance_id: 'stale-owner-instance', package_build: '1.1.8-cf50', protocol_version: '1.6', database_schema_version: 12, started_at: startedAt };
    const fence = { schema_version: 'autopilot.coordinator_lock.v1', pid: process.pid, boot_id: 'stale-owner-boot', token: 'stale-fence-token', started_at: startedAt };
    await writeFile(paths.lockPath, `${JSON.stringify(stale)}\n`, 'utf8');
    await writeFile(paths.predecessorLockPath, `${JSON.stringify(fence)}\n`, 'utf8');
    let server: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      server = await startCoordinatorServer(paths);
      assert.equal(isProcessAlive(process.pid), true, 'PID reuse reconciliation must not signal the current process');
      const current = JSON.parse(await readFile(paths.lockPath, 'utf8')) as Readonly<Record<string, unknown>>;
      assert.equal(current['pid'], process.pid);
      assert.notEqual(current['instance_id'], stale.instance_id);
      assert.equal(current['process_start_identity'], processStartIdentity(process.pid));
    } finally {
      if (server !== null) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails closed when the retired fixed cf50 barrier is downgraded out of schema 12', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-schema6-direct-start-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') });
    try {
      const initialized = await startCoordinatorServer(paths);
      await initialized.close();
      const database = new DatabaseSync(paths.databasePath);
      try { database.exec('PRAGMA user_version=6'); }
      finally { database.close(); }
      await assert.rejects(() => startCoordinatorServer(paths), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'store-corrupt' && /fixed-path barrier/u.test(error.message));
      const unchanged = new DatabaseSync(paths.databasePath, { readOnly: true });
      try { assert.equal((unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6); }
      finally { unchanged.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('refuses a pre-schema fixed source without rewriting it or bypassing the exact cf50 migration boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-migration-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    await mkdir(paths.coordinatorRoot, { recursive: true });
    const legacy = new DatabaseSync(paths.databasePath);
    legacy.exec('CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker(value) VALUES(\'before-migration\');');
    legacy.close();
    const before = await readFile(paths.databasePath);
    try {
      await assert.rejects(() => startCoordinatorServer(paths), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'schema-mismatch' && /exact cf50 schema 12/u.test(error.message));
      assert.deepEqual(await readFile(paths.databasePath), before);
      assert.equal(existsSync(paths.currentStorePointerPath), false);
      assert.equal(existsSync(paths.runtimeIdentityPath), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('refuses in-place downgrade of a published S1 generation to schema 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-v1-upgrade-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    const initial = await startCoordinatorServer(paths);
    const generationDatabasePath = initial.store.currentGeneration().database_path;
    const pointerBefore = await readFile(paths.currentStorePointerPath);
    await initial.close();
    const oldDatabase = new DatabaseSync(generationDatabasePath);
    oldDatabase.exec('DROP TABLE result_details; DROP TABLE result_receipts; DROP TABLE mailbox_delivery_items; DROP TABLE mailbox_deliveries; DROP TABLE reconciliation_details; DROP TABLE reconciliation_receipts; DROP TABLE observations; DROP TABLE semantic_replays; ALTER TABLE session_leases DROP COLUMN attachment_kind; DROP TABLE migration_legacy_audit; DROP TABLE migration_recovery_work; DROP TABLE coordination_migrations; DROP TABLE run_resources; DROP TABLE evidence_artifacts; DROP TABLE adjudication_assignments; DROP TABLE authoritative_artifacts; DROP TABLE deadlock_resolutions; DROP TABLE wait_for_edges; DROP TABLE reservation_obligations; DROP TABLE run_terminal_intents; ALTER TABLE runs DROP COLUMN coordination_authority; DROP INDEX idx_worktree_operations_recovery; DROP INDEX idx_worktrees_owner; DROP TABLE reconciliation_evidence; DROP TABLE mailbox_cursors; DROP INDEX idx_messages_cursor; DROP TABLE acquisition_groups; DROP INDEX idx_edit_leases_repo; DROP INDEX idx_claim_requests_owner_status; DROP INDEX idx_claim_requests_requester_status; DELETE FROM schema_migrations WHERE version IN (2,3,4,5,6,7,8,9,10,11,12); PRAGMA user_version=1;');
    oldDatabase.close();
    try {
      await assert.rejects(() => startCoordinatorServer(paths), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'store-corrupt');
      assert.deepEqual(await readFile(paths.currentStorePointerPath), pointerBefore);
      const unchanged = new DatabaseSync(generationDatabasePath, { readOnly: true });
      try { assert.equal((unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1); }
      finally { unchanged.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('refuses a schema-2 downgrade of a published generation without rewriting mailbox state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-v2-mailbox-upgrade-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    const initial = await startCoordinatorServer(paths);
    const client = new CoordinatorClient({ env, autoStart: false });
    const runResponse = await attachRun(client);
    const run = record(runResponse.payload['run'], 'mailbox migration run');
    const sessionResponse = await attachSession(client, integer(run['version'], 'mailbox migration run version'), 1, 'session-mailbox-migration', 'boot-mailbox-migration');
    const session = record(sessionResponse.payload['session'], 'mailbox migration session');
    initial.store.enqueueMessageForTest({
      schema_version: 'autopilot.coordination_message.v1', message_id: 'message-mailbox-migration', repo_id: 'repo-runtime-test', recipient_workstream_run: 'run-runtime-test',
      message_type: 'recovery-required', correlation_id: 'migration-recovery', payload: { reason: 'migration witness' }, status: 'pending', created_event_seq: 5,
      delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
    });
    const drained = await client.mutate('drain-mailbox', {
      repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-mailbox-migration', fencingGeneration: 1,
      expectedVersion: integer(session['version'], 'mailbox migration session version'), idempotencyKey: 'drain-mailbox-migration',
    }, { delivery_id: 'delivery-mailbox-migration', session_lease_id: 'lease-session-mailbox-migration-1', session_token: sessionToken(1) });
    const delivered = record(queryPayload(drained, 'messages')[0], 'mailbox migration message');
    await client.mutate('acknowledge-message', {
      repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-mailbox-migration', fencingGeneration: 1,
      expectedVersion: integer(delivered['version'], 'mailbox migration message version'), idempotencyKey: 'ack-mailbox-migration',
    }, { message_id: 'message-mailbox-migration', session_lease_id: 'lease-session-mailbox-migration-1', session_token: sessionToken(1) });
    initial.store.enqueueMessageForTest({
      schema_version: 'autopilot.coordination_message.v1', message_id: 'message-mailbox-migration-pending', repo_id: 'repo-runtime-test', recipient_workstream_run: 'run-runtime-test',
      message_type: 'recovery-required', correlation_id: 'migration-pending', payload: { reason: 'pending migration witness' }, status: 'pending', created_event_seq: 6,
      delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
    });
    const generationDatabasePath = initial.store.currentGeneration().database_path;
    const pointerBefore = await readFile(paths.currentStorePointerPath);
    await initial.close();
    const oldDatabase = new DatabaseSync(generationDatabasePath);
    oldDatabase.exec('DROP TABLE result_details; DROP TABLE result_receipts; DROP TABLE mailbox_delivery_items; DROP TABLE mailbox_deliveries; DROP TABLE reconciliation_details; DROP TABLE reconciliation_receipts; DROP TABLE observations; DROP TABLE semantic_replays; ALTER TABLE session_leases DROP COLUMN attachment_kind; DROP TABLE migration_legacy_audit; DROP TABLE migration_recovery_work; DROP TABLE coordination_migrations; DROP TABLE run_resources; DROP TABLE evidence_artifacts; DROP TABLE adjudication_assignments; DROP TABLE authoritative_artifacts; DROP TABLE deadlock_resolutions; DROP TABLE wait_for_edges; DROP TABLE reservation_obligations; DROP TABLE run_terminal_intents; ALTER TABLE runs DROP COLUMN coordination_authority; DROP INDEX idx_worktree_operations_recovery; DROP INDEX idx_worktrees_owner; DROP TABLE reconciliation_evidence; DROP TABLE mailbox_cursors; DROP INDEX idx_messages_cursor; DELETE FROM schema_migrations WHERE version IN (3,4,5,6,7,8,9,10,11,12); PRAGMA user_version=2;');
    oldDatabase.close();
    try {
      await assert.rejects(() => startCoordinatorServer(paths), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'store-corrupt');
      assert.deepEqual(await readFile(paths.currentStorePointerPath), pointerBefore);
      const unchanged = new DatabaseSync(generationDatabasePath, { readOnly: true });
      try { assert.equal((unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2); }
      finally { unchanged.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('refuses a schema-5 downgrade of a published generation without inventing legacy authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-migrate-v5-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    let server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const runResponse = await attachRun(client);
      const run = record(runResponse.payload['run'], 'migration run');
      const sessionResponse = await attachSession(client, integer(run['version'], 'migration run version'), 1, 'session-migration-v5', 'boot-migration-v5');
      const attachedRun = record(sessionResponse.payload['run'], 'attached migration run');
      const acquireIdentity = { repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-migration-v5', fencingGeneration: 1, expectedVersion: integer(attachedRun['version'], 'attached migration run version'), idempotencyKey: 'migration-v5-group' };
      const acquirePayload = { acquisition_group_id: 'group-migration-v5', acquisition_kind: 'initial', unit_id: 'unit-migration-v5', attempt: 1, requested_leases: [{ path: 'src/migration-v5.ts', mode: 'WRITE', purpose: 'migration fixture' }], reason: 'migration fixture', normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-migration-v5:1', evidence: null }, spec_ref: 'unit-migration-v5.json', spec_sha256: `sha256:${'d'.repeat(64)}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: 'lease-session-migration-v5-1', session_token: sessionToken(1) };
      await client.mutate('acquire-group', acquireIdentity, acquirePayload);
      const legacyPayload = omitFields(acquirePayload, ['acquisition_kind', 'role']);
      const legacyRequest = { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.1', request_id: 'legacy-retry-request', action: 'acquire-group', idempotency_key: 'migration-v5-group', repo_id: 'repo-runtime-test', workstream_run: 'run-runtime-test', session_id: 'session-migration-v5', fencing_generation: 1, expected_version: integer(attachedRun['version'], 'attached migration run version'), payload: legacyPayload };
      const legacySemantic = { schema_version: legacyRequest.schema_version, protocol_version: legacyRequest.protocol_version, action: legacyRequest.action, repo_id: legacyRequest.repo_id, workstream_run: legacyRequest.workstream_run, session_id: null, fencing_generation: null, expected_version: null, payload: omitFields(legacyPayload, ['session_lease_id', 'session_token']) };
      const legacyDigest = `sha256:${createHash('sha256').update(canonicalJson(legacySemantic), 'utf8').digest('hex')}`;
      const generationDatabasePath = server.store.currentGeneration().database_path;
      const pointerBefore = await readFile(coordinatorRuntimePaths(env).currentStorePointerPath);
      await server.close();
      const database = new DatabaseSync(generationDatabasePath);
      database.exec("UPDATE unit_attempts SET payload_json=json_remove(payload_json, '$.role'); UPDATE acquisition_groups SET payload_json=json_remove(payload_json, '$.acquisition_kind'); UPDATE idempotency_results SET payload_json=json_remove(payload_json, '$.acquisition_group.acquisition_kind') WHERE idempotency_key='migration-v5-group'; DROP TABLE result_details; DROP TABLE result_receipts; DROP TABLE mailbox_delivery_items; DROP TABLE mailbox_deliveries; DROP TABLE reconciliation_details; DROP TABLE reconciliation_receipts; DROP TABLE observations; DROP TABLE semantic_replays; ALTER TABLE session_leases DROP COLUMN attachment_kind; DROP TABLE migration_legacy_audit; DROP TABLE migration_recovery_work; DROP TABLE coordination_migrations; DROP TABLE run_resources; DROP TABLE evidence_artifacts; DROP TABLE adjudication_assignments; DROP TABLE authoritative_artifacts; DROP TABLE deadlock_resolutions; DROP TABLE wait_for_edges; DELETE FROM schema_migrations WHERE version IN (6,7,8,9,10,11,12); PRAGMA user_version=5;");
      database.prepare("UPDATE idempotency_results SET request_sha256=? WHERE idempotency_key='migration-v5-group'").run(legacyDigest);
      database.close();
      await assert.rejects(() => startCoordinatorServer(coordinatorRuntimePaths(env)), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'store-corrupt');
      assert.deepEqual(await readFile(coordinatorRuntimePaths(env).currentStorePointerPath), pointerBefore);
      const unchanged = new DatabaseSync(generationDatabasePath, { readOnly: true });
      try { assert.equal((unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5); }
      finally { unchanged.close(); }
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects a tampered migration journal inside the current S1 generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-schema-tamper-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    const server = await startCoordinatorServer(paths);
    const generationDatabasePath = server.store.currentGeneration().database_path;
    const pointerBefore = await readFile(paths.currentStorePointerPath);
    await server.close();
    const database = new DatabaseSync(generationDatabasePath);
    database.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=1").run();
    database.close();
    try {
      await assert.rejects(
        () => startCoordinatorServer(paths),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'schema-mismatch',
      );
      assert.deepEqual(await readFile(paths.currentStorePointerPath), pointerBefore);
      assert.equal(existsSync(join(paths.coordinatorRoot, 'coordination.json')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails loudly on a corrupt store without rewriting or falling back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-corrupt-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    await mkdir(paths.coordinatorRoot, { recursive: true });
    const corruptBytes = 'not-a-sqlite-database\n';
    await writeFile(paths.databasePath, corruptBytes, 'utf8');
    try {
      await assert.rejects(
        () => startCoordinatorServer(paths),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'store-corrupt',
      );
      assert.equal(await readFile(paths.databasePath, 'utf8'), corruptBytes);
      assert.equal(existsSync(join(paths.coordinatorRoot, 'coordination.json')), false);
      assert.equal(existsSync(join(paths.coordinatorRoot, 'coordination.jsonl')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fences old sessions, retains child ownership, and preserves mailbox state across handoff', async () => {
    await withCoordinator(async ({ root, client, server }) => {
      const runResponse = await attachRun(client);
      const initialRun = record(runResponse.payload['run'], 'run');
      const firstSessionResponse = await attachSession(client, integer(initialRun['version'], 'run.version'), 1, 'session-first', 'boot-first');
      const firstSession = record(firstSessionResponse.payload['session'], 'first session');
      const firstRun = record(firstSessionResponse.payload['run'], 'first run');

      const handoff = await client.mutate('prepare-handoff', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-first', fencingGeneration: 1,
        expectedVersion: integer(firstSession['version'], 'first session version'), idempotencyKey: 'prepare-handoff-first',
      }, { handoff_token: 'handoff-runtime-test', session_lease_id: 'lease-session-first-1', session_token: sessionToken(1) });
      const handoffSession = record(handoff.payload['session'], 'handoff session');
      assert.equal(handoffSession['status'], 'handoff-pending');

      const secondSessionResponse = await attachSession(client, integer(firstRun['version'], 'first run version'), 2, 'session-second', 'boot-second');
      const secondRun = record(secondSessionResponse.payload['run'], 'second run');

      await assert.rejects(
        () => client.mutate('heartbeat', {
          repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-first', fencingGeneration: 1,
          expectedVersion: integer(handoffSession['version'], 'handoff version'), idempotencyKey: 'stale-heartbeat-first',
        }, { lease_expires_at: '2026-07-11T19:00:00.000Z', session_lease_id: 'lease-session-first-1', session_token: sessionToken(1) }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'fenced-session',
      );

      await client.mutate('acquire-group', { repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-second', fencingGeneration: 2, expectedVersion: integer(secondRun['version'], 'second run version'), idempotencyKey: 'acquire-child-runtime-test' }, { acquisition_group_id: 'group-runtime-test', acquisition_kind: 'initial', unit_id: 'unit-runtime-test', attempt: 1, requested_leases: [{ path: 'src/runtime.ts', mode: 'WRITE', purpose: 'register child fixture' }], reason: 'establish durable attempt before child', normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-runtime-test:1', evidence: null }, spec_ref: 'unit-runtime-test.json', spec_sha256: `sha256:${'a'.repeat(64)}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: 'lease-session-second-2', session_token: sessionToken(2) });
      const childToken = 'a'.repeat(64);
      const childResponse = await client.mutate('register-child', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-second', fencingGeneration: 2,
        expectedVersion: integer(secondRun['version'], 'second run version'), idempotencyKey: 'register-child-runtime-test',
      }, {
        child_lease_id: 'child-run-runtime-test-unit-runtime-test-1', autopilot_id: 'autopilot-runtime-test', unit_id: 'unit-runtime-test', attempt: 1,
        pid: process.pid, boot_id: 'child-boot', child_token: childToken, session_lease_id: 'lease-session-second-2', session_token: sessionToken(2), lease_expires_at: '2026-07-11T15:00:00.000Z',
      });
      const registeredChild = record(childResponse.payload['child'], 'child');
      assert.equal(registeredChild['status'], 'running');

      const message: CoordinationMessage = {
        schema_version: 'autopilot.coordination_message.v1', message_id: 'message-runtime-test', repo_id: 'repo-runtime-test', recipient_workstream_run: 'run-runtime-test',
        message_type: 'recovery-required', correlation_id: 'child-run-runtime-test-unit-runtime-test-1', payload: { child_lease_id: 'child-run-runtime-test-unit-runtime-test-1' }, status: 'pending',
        created_event_seq: 4, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
      };
      server.store.enqueueMessageForTest(message);

      const thirdSessionResponse = await attachSession(client, integer(secondRun['version'], 'second run version'), 3, 'session-third', 'boot-reused-pid');
      const thirdSession = record(thirdSessionResponse.payload['session'], 'third session');

      const childHeartbeat = await client.mutate('heartbeat-child', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: null, fencingGeneration: null,
        expectedVersion: integer(registeredChild['version'], 'registered child version'), idempotencyKey: 'heartbeat-child-after-handoff',
      }, {
        child_lease_id: 'child-run-runtime-test-unit-runtime-test-1', child_token: childToken, pid: process.pid, boot_id: 'child-boot', lease_expires_at: '2000-01-01T00:00:00.000Z',
      });
      const heartbeatChild = record(childHeartbeat.payload['child'], 'heartbeat child');
      assert.equal(heartbeatChild['status'], 'running');
      const childExpiryDoctor = await client.query('doctor');
      const expiredChildren = childExpiryDoctor.payload['expired_child_classifications'];
      assert.equal(Array.isArray(expiredChildren) && expiredChildren.length === 1, true);
      if (!Array.isArray(expiredChildren)) throw new Error('missing child expiry classifications');
      assert.equal(record(expiredChildren[0], 'child expiry')['write_authority_released'], false);
      await assert.rejects(
        () => client.mutate('heartbeat-child', {
          repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: null, fencingGeneration: null,
          expectedVersion: integer(heartbeatChild['version'], 'heartbeat child version'), idempotencyKey: 'heartbeat-child-wrong-token',
        }, {
          child_lease_id: 'child-run-runtime-test-unit-runtime-test-1', child_token: 'b'.repeat(64), pid: process.pid, boot_id: 'child-boot', lease_expires_at: '2026-07-11T21:00:00.000Z',
        }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'unauthorized-client',
      );
      const completedChild = await client.mutate('complete-child', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: null, fencingGeneration: null,
        expectedVersion: integer(heartbeatChild['version'], 'heartbeat child version'), idempotencyKey: 'recover-child-after-handoff',
      }, {
        child_lease_id: 'child-run-runtime-test-unit-runtime-test-1', child_token: childToken, pid: process.pid, boot_id: 'child-boot', status: 'recovery-required',
        evidence_ref: null, evidence_sha256: null,
      });
      const terminalChild = record(completedChild.payload['child'], 'recovery child');
      assert.equal(terminalChild['status'], 'recovery-required');
      await assert.rejects(
        () => client.mutate('complete-child', {
          repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: null, fencingGeneration: null,
          expectedVersion: integer(terminalChild['version'], 'terminal child version'), idempotencyKey: 'rewrite-terminal-child',
        }, {
          child_lease_id: 'child-run-runtime-test-unit-runtime-test-1', child_token: childToken, pid: process.pid, boot_id: 'child-boot', status: 'terminal', evidence_ref: null, evidence_sha256: null,
        }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-state',
      );

      await assert.rejects(
        () => client.mutate('heartbeat', {
          repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-third', fencingGeneration: 3,
          expectedVersion: integer(thirdSession['version'], 'third session version'), idempotencyKey: 'heartbeat-third-stolen-pid',
        }, {
          lease_expires_at: '2026-07-11T21:00:00.000Z', session_lease_id: 'lease-session-third-3', session_token: 'd'.repeat(64),
        }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'unauthorized-client',
      );

      const drain = await client.mutate('drain-mailbox', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-third', fencingGeneration: 3,
        expectedVersion: integer(thirdSession['version'], 'third session version'), idempotencyKey: 'drain-mailbox-third',
      }, { delivery_id: 'delivery-third', session_lease_id: 'lease-session-third-3', session_token: sessionToken(3) });
      const messages = queryPayload(drain, 'messages');
      assert.equal(messages.length, 1);
      const delivered = record(messages[0], 'delivered message');
      await client.mutate('acknowledge-message', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-third', fencingGeneration: 3,
        expectedVersion: integer(delivered['version'], 'message version'), idempotencyKey: 'ack-message-runtime-test',
      }, { message_id: text(delivered['message_id'], 'message id'), session_lease_id: 'lease-session-third-3', session_token: sessionToken(3) });

      const status = await client.query('status', 'repo-runtime-test', 'run-runtime-test');
      assert.equal(queryPayload(status, 'child_leases').length, 1);
      assert.equal(status.payload['pending_messages'], 0);
      const sessions = queryPayload(status, 'session_leases').map((value) => record(value, 'session status'));
      assert.equal(sessions.filter((value) => value['status'] === 'attached').length, 1);
      assert.equal(sessions.find((value) => value['session_id'] === 'session-first')?.['status'], 'detached');
      assert.equal(sessions.find((value) => value['session_id'] === 'session-second')?.['status'], 'fenced');
      const doctor = await client.query('doctor');
      const expired = doctor.payload['expired_session_classifications'];
      assert.equal(Array.isArray(expired) && expired.length >= 1, true);
      if (!Array.isArray(expired)) throw new Error('missing expiry classifications');
      assert.equal(record(expired[0], 'expiry')['write_authority_released'], false);
    });
  });

  void it('rejects malformed transport, bad capability shape, and oversized frames', () => {
    assert.throws(() => parseCoordinatorTransportRequest({ transport_version: 'wrong', capability: 'a'.repeat(64), request: request({}) }), /protocol version|transport version/u);
    assert.throws(() => parseCoordinatorTransportRequest({ transport_version: 'autopilot.coordinator_transport.v1', capability: 'short', request: request({}) }), /capability proof/u);
    const legacy = parseCoordinatorLegacyReplayTransportRequest({ transport_version: 'autopilot.coordinator_transport.v1', capability: 'a'.repeat(64), request: { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.1', request_id: 'legacy-request', action: 'acquire-group', idempotency_key: 'legacy-key', repo_id: 'repo-runtime-test', workstream_run: 'run-runtime-test', session_id: 'old-session', fencing_generation: 1, expected_version: 1, payload: { acquisition_group_id: 'legacy-group' } } });
    assert.equal(legacy.request['protocol_version'], '1.1');
    assert.throws(() => encodeCoordinatorFrame({ payload: 'x'.repeat(1_048_577) }), /frame exceeds/u);
    const digest = createHash('sha256').update('runtime-test', 'utf8').digest('hex');
    assert.equal(digest.length, 64);
  });
});
