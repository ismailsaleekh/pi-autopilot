import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { encodeCoordinatorFrame, parseCoordinatorTransportRequest } from '../../src/core/coordination/ipc.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import type { CoordinationMessage, CoordinatorRequestEnvelope, CoordinatorResponseEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const EMPTY_COORDINATOR_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({});

interface JsonMap {
  readonly [key: string]: unknown;
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
    protocol_version: '1.0',
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
    repo_key: 'repo-runtime-test', canonical_root: '/tmp/generic-runtime-repository', git_common_dir: '/tmp/generic-runtime-repository/.git', autopilot_id: 'autopilot-runtime-test', workstream: 'runtime-test',
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
        payload: { repo_key: 'repo-runtime-test', canonical_root: '/tmp/generic-runtime-repository', git_common_dir: '/tmp/generic-runtime-repository/.git', autopilot_id: 'autopilot-runtime-test', workstream: 'runtime-test' },
      });
      const first = await client.request(attachRequest);
      const second = await client.request(attachRequest);
      assert.equal(first.committed_event_seq, 1);
      assert.equal(second.committed_event_seq, 1);
      const status = await client.query('status', 'repo-runtime-test', 'run-runtime-test');
      assert.equal(queryPayload(status, 'runs').length, 1);

      const exportOne = join(root, 'export-one.json');
      const exportTwo = join(root, 'export-two.json');
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

  void it('backs up and verifies an existing pre-schema database before migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-migration-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    await mkdir(paths.coordinatorRoot, { recursive: true });
    const legacy = new DatabaseSync(paths.databasePath);
    legacy.exec('CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker(value) VALUES(\'before-migration\');');
    legacy.close();
    const server = await startCoordinatorServer(paths);
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const doctor = await client.query('doctor');
      const backupPath = doctor.payload['last_backup_path'];
      assert.equal(typeof backupPath, 'string');
      if (typeof backupPath !== 'string') throw new Error('missing backup path');
      assert.equal(existsSync(backupPath), true);
      assert.equal(doctor.payload['integrity'], 'ok');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('backs up and upgrades a valid schema-1 coordinator through the claim-negotiation migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-v1-upgrade-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    const initial = await startCoordinatorServer(paths);
    await initial.close();
    const oldDatabase = new DatabaseSync(paths.databasePath);
    oldDatabase.exec('DROP TABLE reconciliation_evidence; DROP TABLE mailbox_cursors; DROP INDEX idx_messages_cursor; DROP TABLE acquisition_groups; DROP INDEX idx_edit_leases_repo; DROP INDEX idx_claim_requests_owner_status; DROP INDEX idx_claim_requests_requester_status; DELETE FROM schema_migrations WHERE version IN (2,3); PRAGMA user_version=1;');
    oldDatabase.close();
    const upgraded = await startCoordinatorServer(paths);
    try {
      const doctor = await new CoordinatorClient({ env, autoStart: false }).query('doctor');
      assert.equal(doctor.payload['database_schema_version'], 3);
      assert.equal(typeof doctor.payload['last_backup_path'], 'string');
      const database = new DatabaseSync(paths.databasePath, { readOnly: true });
      try {
        const migration = record(database.prepare('SELECT version FROM schema_migrations WHERE version=2').get(), 'migration 2');
        assert.equal(migration['version'], 2);
      } finally {
        database.close();
      }
    } finally {
      await upgraded.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('migrates existing delivered and acknowledged mailbox state into durable cursors', async () => {
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
    await initial.close();
    const oldDatabase = new DatabaseSync(paths.databasePath);
    oldDatabase.exec('DROP TABLE reconciliation_evidence; DROP TABLE mailbox_cursors; DROP INDEX idx_messages_cursor; DELETE FROM schema_migrations WHERE version=3; PRAGMA user_version=2;');
    oldDatabase.close();
    const upgraded = await startCoordinatorServer(paths);
    try {
      const status = await new CoordinatorClient({ env, autoStart: false }).query('status', 'repo-runtime-test', 'run-runtime-test');
      const cursors = queryPayload(status, 'mailbox_cursors');
      assert.equal(cursors.length, 1);
      const cursor = record(cursors[0], 'migrated mailbox cursor');
      assert.equal(cursor['delivered_through_event_seq'], 5);
      assert.equal(cursor['acknowledged_through_event_seq'], 5);
      assert.equal(status.payload['pending_messages'], 1);
    } finally {
      await upgraded.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects a tampered migration journal as an incompatible schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-schema-tamper-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    const server = await startCoordinatorServer(paths);
    await server.close();
    const database = new DatabaseSync(paths.databasePath);
    database.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=1").run();
    database.close();
    try {
      await assert.rejects(
        () => startCoordinatorServer(paths),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'schema-mismatch',
      );
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

      const childToken = 'a'.repeat(64);
      const childResponse = await client.mutate('register-child', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: 'session-second', fencingGeneration: 2,
        expectedVersion: integer(secondRun['version'], 'second run version'), idempotencyKey: 'register-child-runtime-test',
      }, {
        child_lease_id: 'child-runtime-test', autopilot_id: 'autopilot-runtime-test', unit_id: 'unit-runtime-test', attempt: 1,
        pid: process.pid, boot_id: 'child-boot', child_token: childToken, session_lease_id: 'lease-session-second-2', session_token: sessionToken(2), lease_expires_at: '2026-07-11T15:00:00.000Z',
      });
      const registeredChild = record(childResponse.payload['child'], 'child');
      assert.equal(registeredChild['status'], 'running');

      const message: CoordinationMessage = {
        schema_version: 'autopilot.coordination_message.v1', message_id: 'message-runtime-test', repo_id: 'repo-runtime-test', recipient_workstream_run: 'run-runtime-test',
        message_type: 'recovery-required', correlation_id: 'child-runtime-test', payload: { child_lease_id: 'child-runtime-test' }, status: 'pending',
        created_event_seq: 4, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
      };
      server.store.enqueueMessageForTest(message);

      const thirdSessionResponse = await attachSession(client, integer(secondRun['version'], 'second run version'), 3, 'session-third', 'boot-reused-pid');
      const thirdSession = record(thirdSessionResponse.payload['session'], 'third session');

      const childHeartbeat = await client.mutate('heartbeat-child', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: null, fencingGeneration: null,
        expectedVersion: integer(registeredChild['version'], 'registered child version'), idempotencyKey: 'heartbeat-child-after-handoff',
      }, {
        child_lease_id: 'child-runtime-test', child_token: childToken, pid: process.pid, boot_id: 'child-boot', lease_expires_at: '2000-01-01T00:00:00.000Z',
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
          child_lease_id: 'child-runtime-test', child_token: 'b'.repeat(64), pid: process.pid, boot_id: 'child-boot', lease_expires_at: '2026-07-11T21:00:00.000Z',
        }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'unauthorized-client',
      );
      const childEvidenceRef = '.pi/autopilot/runtime-test/receipts/unit-runtime-test.json';
      const childEvidenceBytes = `${JSON.stringify({ schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: 'runtime-test', unit_id: 'unit-runtime-test', attempt: 1 })}\n`;
      const childEvidencePath = join(root, 'state', 'worktrees', 'repo-runtime-test', 'active', 'run-runtime-test', 'main', ...childEvidenceRef.split('/'));
      await mkdir(dirname(childEvidencePath), { recursive: true });
      await writeFile(childEvidencePath, childEvidenceBytes, 'utf8');
      const childEvidenceSha = `sha256:${createHash('sha256').update(childEvidenceBytes, 'utf8').digest('hex')}`;
      const completedChild = await client.mutate('complete-child', {
        repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: null, fencingGeneration: null,
        expectedVersion: integer(heartbeatChild['version'], 'heartbeat child version'), idempotencyKey: 'complete-child-after-handoff',
      }, {
        child_lease_id: 'child-runtime-test', child_token: childToken, pid: process.pid, boot_id: 'child-boot', status: 'terminal',
        evidence_ref: childEvidenceRef, evidence_sha256: childEvidenceSha,
      });
      const terminalChild = record(completedChild.payload['child'], 'completed child');
      assert.equal(terminalChild['status'], 'terminal');
      await assert.rejects(
        () => client.mutate('complete-child', {
          repoId: 'repo-runtime-test', workstreamRun: 'run-runtime-test', sessionId: null, fencingGeneration: null,
          expectedVersion: integer(terminalChild['version'], 'terminal child version'), idempotencyKey: 'rewrite-terminal-child',
        }, {
          child_lease_id: 'child-runtime-test', child_token: childToken, pid: process.pid, boot_id: 'child-boot', status: 'recovery-required', evidence_ref: null, evidence_sha256: null,
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
    assert.throws(() => encodeCoordinatorFrame({ payload: 'x'.repeat(1_048_577) }), /frame exceeds/u);
    const digest = createHash('sha256').update('runtime-test', 'utf8').digest('hex');
    assert.equal(digest.length, 64);
  });
});
