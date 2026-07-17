import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease, parseCoordinatorResponseEnvelope } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, type CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function sleep(milliseconds: number): Promise<void> { return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)); }

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(25); }
  throw new Error(`timed out waiting for ${label}`);
}

void describe('BUG-176 coordinator response-boundary hard-kill recovery', () => {
  void it('replays one exact compact attach after SIGKILL between commit and socket response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-response-crash-'));
    const stateRoot = join(root, 'state');
    const evidencePath = join(root, 'committed-response.json');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const repoId = `sha256-${digest('response-crash-repository')}`;
    const runId = 'response-crash-run';
    const sessionToken = digest('response-crash-session-token');
    let restarted: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    const initialStore = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-14T00:00:00.000Z') });
    try {
      const attachedRun = initialStore.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: 'response-crash-attach-run', action: 'attach-run', idempotency_key: 'response-crash-attach-run', repo_id: repoId, workstream_run: runId, session_id: null, fencing_generation: null, expected_version: 0, payload: { repo_key: repoId, canonical_root: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), autopilot_id: 'response-crash-autopilot', workstream: 'response-crash-workstream', coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId, source_repo: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), worktree_root: join(root, 'worktrees'), main_worktree_path: join(root, 'worktrees', 'main'), runtime_root: join(root, 'worktrees', 'main', '.pi', 'autopilot', 'response-crash-workstream'), branch: 'autopilot/response-crash', target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-14T00:00:00.000Z', version: 1 } } });
      assert.equal(attachedRun.ok, true);
    } finally { initialStore.close(); }
    const helper = join(process.cwd(), 'tests', 'helpers', 'coordinator-response-crash-child.ts');
    const child = spawn(process.execPath, ['--experimental-strip-types', helper, stateRoot, evidencePath], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const childClosed = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
    try {
      await waitUntil(() => existsSync(paths.socketPath), 'crash-child coordinator socket');
      const request: CoordinatorRequestEnvelope = { schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: 'response-crash-attach-session', action: 'attach-session', idempotency_key: 'response-crash-attach-session', repo_id: repoId, workstream_run: runId, session_id: 'response-crash-session', fencing_generation: 1, expected_version: 1, payload: { session_lease_id: 'response-crash-session-lease', session_token: sessionToken, pid: process.pid, boot_id: 'response-crash-boot', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null } };
      await assert.rejects(() => new CoordinatorClient({ env, autoStart: false, requestTimeoutMs: 5_000 }).request(request), /closed before a response|ECONNRESET|unavailable/u);
      const childExit = await childClosed;
      assert.equal(childExit.signal, 'SIGKILL');
      const committed = parseCoordinatorResponseEnvelope(JSON.parse(await readFile(evidencePath, 'utf8')));
      assert.equal(committed.ok, true);
      assert.notEqual(committed.committed_event_seq, null);
      restarted = await startCoordinatorServer(paths);
      const client = new CoordinatorClient({ env, autoStart: false });
      const replay = await client.request(request);
      assert.deepEqual(replay, committed, 'retry must return the exact idempotency payload committed before the lost response');
      const run = parseCoordinationRun(replay.payload['run']);
      const session = parseCoordinationSessionLease(replay.payload['session']);
      assert.equal(run.active_session_generation, 1);
      assert.equal(session.session_generation, 1);
      assert.equal(replay.payload['reconciliation_receipt'], undefined, 'empty reconciliation must not amplify every idempotency result with redundant receipt state');
      const status = await client.query('status', repoId, runId);
      const sessions = status.payload['session_leases'];
      if (!Array.isArray(sessions)) throw new Error('restarted coordinator status omitted sessions');
      assert.equal(sessions.length, 1, 'hard-kill retry must not create a second generation');
      const database = new DatabaseSync(restarted.store.currentGeneration().database_path, { readOnly: true });
      try {
        const event = database.prepare('SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND idempotency_key=?').get(repoId, request.idempotency_key ?? '');
        const result = database.prepare('SELECT COUNT(*) AS count FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, request.idempotency_key ?? '');
        assert.equal(event?.['count'], 1);
        assert.equal(result?.['count'], 1);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM reconciliation_receipts WHERE repo_id=?').get(repoId)?.['count'], 0);
      } finally { database.close(); }

      await restarted.close();
      restarted = null;
      const resultEvidencePath = join(root, 'committed-result-response.json');
      const resultCrashChild = spawn(process.execPath, ['--experimental-strip-types', helper, stateRoot, resultEvidencePath, 'acquire-group'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
      const resultChildClosed = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolveClose) => resultCrashChild.once('close', (code, signal) => resolveClose({ code, signal })));
      await waitUntil(() => existsSync(paths.socketPath), 'result-receipt crash-child coordinator socket');
      const requestedLeases = Array.from({ length: 1_024 }, (_entry, index) => ({ path: `fixtures/${String(index).padStart(4, '0')}-${'p'.repeat(160)}.json`, mode: 'WRITE' as const, purpose: `crash-bound result ${String(index)} ${'q'.repeat(160)}` }));
      const resultRequest: CoordinatorRequestEnvelope = { schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: 'response-crash-acquire-group', action: 'acquire-group', idempotency_key: 'response-crash-acquire-group', repo_id: repoId, workstream_run: runId, session_id: session.session_id, fencing_generation: 1, expected_version: run.version, payload: { acquisition_group_id: 'response-crash-group', acquisition_kind: 'initial', unit_id: 'response-crash-unit', attempt: 1, requested_leases: requestedLeases, reason: 'prove result receipt crash durability', normal_release_condition: { condition_type: 'unit-merged', target_id: 'response-crash-unit:1', evidence: null }, spec_ref: 'unit-specs/response-crash-unit.json', spec_sha256: `sha256:${digest('response-crash-spec')}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: session.session_lease_id, session_token: sessionToken } };
      await assert.rejects(() => new CoordinatorClient({ env, autoStart: false, requestTimeoutMs: 5_000 }).request(resultRequest), /closed before a response|ECONNRESET|unavailable/u);
      assert.equal((await resultChildClosed).signal, 'SIGKILL');
      const committedResult = parseCoordinatorResponseEnvelope(JSON.parse(await readFile(resultEvidencePath, 'utf8')));
      assert.equal(committedResult.ok, true);
      assert.equal(Array.isArray(committedResult.payload['edit_leases']), false);
      restarted = await startCoordinatorServer(paths);
      const resultClient = new CoordinatorClient({ env, autoStart: false });
      assert.deepEqual(await resultClient.request(resultRequest), committedResult);
      const expandedResult = await resultClient.mutate('acquire-group', { repoId, workstreamRun: runId, sessionId: session.session_id, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: 'response-crash-acquire-group' }, resultRequest.payload);
      assert.equal(Array.isArray(expandedResult.payload['edit_leases']) && expandedResult.payload['edit_leases'].length, requestedLeases.length);
      const resultDatabase = new DatabaseSync(restarted.store.currentGeneration().database_path, { readOnly: true });
      try {
        assert.equal(resultDatabase.prepare('SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND idempotency_key=?').get(repoId, resultRequest.idempotency_key ?? '')?.['count'], 1);
        assert.equal(resultDatabase.prepare('SELECT COUNT(*) AS count FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, resultRequest.idempotency_key ?? '')?.['count'], 1);
        assert.equal(resultDatabase.prepare('SELECT COUNT(*) AS count FROM result_receipts WHERE repo_id=? AND source_action=?').get(repoId, 'acquire-group')?.['count'], 1);
        assert.equal(resultDatabase.prepare('SELECT COUNT(*) AS count FROM result_details').get()?.['count'], requestedLeases.length);
      } finally { resultDatabase.close(); }
    } finally {
      if (restarted !== null) await restarted.close();
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
});
