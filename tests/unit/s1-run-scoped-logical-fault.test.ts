import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import type { CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';

function request(input: Omit<CoordinatorRequestEnvelope, 'schema_version' | 'protocol_version' | 'request_id'> & { readonly request_id: string }): CoordinatorRequestEnvelope {
  return { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: input.request_id, action: input.action, idempotency_key: input.idempotency_key, repo_id: input.repo_id, workstream_run: input.workstream_run, session_id: input.session_id, fencing_generation: input.fencing_generation, expected_version: input.expected_version, payload: input.payload };
}

function token(label: string): string { return createHash('sha256').update(label, 'utf8').digest('hex'); }

function attachRun(store: CoordinatorStore, root: string, repoId: string, run: string): void {
  const response = store.handle(request({ request_id: `attach-${run}`, action: 'attach-run', idempotency_key: `attach-${run}`, repo_id: repoId, workstream_run: run, session_id: null, fencing_generation: null, expected_version: 0, payload: {
    repo_key: repoId, canonical_root: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), autopilot_id: `autopilot-${run}`, workstream: `workstream-${run}`, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: run, source_repo: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), worktree_root: join(root, 'worktrees'), main_worktree_path: join(root, 'worktrees', run, 'main'), runtime_root: join(root, 'runtime', run), branch: `autopilot/${run}`, target_branch: null, target_base_sha: 'a'.repeat(40), origin_url: null, started_at: '2026-07-16T00:00:00.000Z', version: 1 },
  } }));
  assert.equal(response.ok, true, JSON.stringify(response.payload));
  const session = store.handle(request({ request_id: `session-${run}`, action: 'attach-session', idempotency_key: `session-${run}`, repo_id: repoId, workstream_run: run, session_id: `session-${run}`, fencing_generation: 1, expected_version: 1, payload: { session_lease_id: `session-lease-${run}`, session_token: token(`session-${run}`), pid: process.pid, boot_id: `boot-${run}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null } }));
  assert.equal(session.ok, true, JSON.stringify(session.payload));
}

void describe('S1 run-scoped logical store faults', () => {
  void it('renews the faulted run heartbeat, blocks its dispatch, and leaves another run dispatchable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-scoped-fault-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    const repoId = 'repo-s1-scoped-fault';
    const runA = 'run-faulted';
    const runB = 'run-healthy';
    let store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-16T00:00:00.000Z') });
    attachRun(store, root, repoId, runA);
    attachRun(store, root, repoId, runB);
    const generationPath = store.currentGeneration().database_path;
    store.close();

    const tamper = new DatabaseSync(generationPath);
    try { tamper.prepare('UPDATE run_resources SET payload_json=? WHERE repo_id=? AND workstream_run=?').run('{', repoId, runA); }
    finally { tamper.close(); }

    store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-16T00:01:00.000Z') });
    try {
      const faults = store.negotiatedRunScopedFaults(repoId, runA);
      assert.equal(faults.length, 1);
      assert.equal(faults[0]?.invariant_id, 'F4-PAYLOAD-INDEX-AMBIGUITY');
      assert.equal(faults[0]?.entity_type, 'run_resources');
      const heartbeat = store.handle(request({ request_id: 'heartbeat-faulted', action: 'heartbeat', idempotency_key: 'heartbeat-faulted', repo_id: repoId, workstream_run: runA, session_id: `session-${runA}`, fencing_generation: 1, expected_version: 1, payload: { lease_expires_at: '2099-01-01T00:01:00.000Z', session_lease_id: `session-lease-${runA}`, session_token: token(`session-${runA}`) } }));
      assert.equal(heartbeat.ok, true, JSON.stringify(heartbeat.payload));
      const faultedDispatch = store.handle(request({ request_id: 'dispatch-faulted', action: 'acquire-group', idempotency_key: 'dispatch-faulted', repo_id: repoId, workstream_run: runA, session_id: `session-${runA}`, fencing_generation: 1, expected_version: 2, payload: { acquisition_group_id: 'group-faulted', acquisition_kind: 'initial', unit_id: 'unit-faulted', attempt: 1, requested_leases: [{ path: 'src/faulted.ts', mode: 'WRITE', purpose: 'must remain fenced' }], reason: 'fault isolation proof', normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-faulted:1', evidence: null }, spec_ref: 'unit-faulted.json', spec_sha256: `sha256:${'b'.repeat(64)}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: `session-lease-${runA}`, session_token: token(`session-${runA}`) } }));
      assert.equal(faultedDispatch.ok, false);
      assert.equal(faultedDispatch.error_code, 'recovery-required');
      const terminalAcceptance = store.handle(request({ request_id: 'terminal-faulted', action: 'prepare-run-terminal', idempotency_key: 'terminal-faulted', repo_id: repoId, workstream_run: runA, session_id: `session-${runA}`, fencing_generation: 1, expected_version: 2, payload: { outcome: 'closed', terminal_intent_id: 'terminal-faulted', session_lease_id: `session-lease-${runA}`, session_token: token(`session-${runA}`) } }));
      assert.equal(terminalAcceptance.ok, false);
      assert.equal(terminalAcceptance.error_code, 'recovery-required');
      assert.match(String(terminalAcceptance.payload['message']), /authority-critical mutation/u);
      const reconciliation = store.handle(request({ request_id: 'reconcile-faulted', action: 'reconcile-run', idempotency_key: 'reconcile-faulted', repo_id: repoId, workstream_run: runA, session_id: `session-${runA}`, fencing_generation: 1, expected_version: 2, payload: { reason: 'must not release faulted authority', session_lease_id: `session-lease-${runA}`, session_token: token(`session-${runA}`) } }));
      assert.equal(reconciliation.ok, false);
      assert.equal(reconciliation.error_code, 'recovery-required');
      const healthyDispatch = store.handle(request({ request_id: 'dispatch-healthy', action: 'acquire-group', idempotency_key: 'dispatch-healthy', repo_id: repoId, workstream_run: runB, session_id: `session-${runB}`, fencing_generation: 1, expected_version: 2, payload: { acquisition_group_id: 'group-healthy', acquisition_kind: 'initial', unit_id: 'unit-healthy', attempt: 1, requested_leases: [{ path: 'src/healthy.ts', mode: 'WRITE', purpose: 'unrelated dispatch remains live' }], reason: 'fault isolation proof', normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-healthy:1', evidence: null }, spec_ref: 'unit-healthy.json', spec_sha256: `sha256:${'c'.repeat(64)}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: `session-lease-${runB}`, session_token: token(`session-${runB}`) } }));
      assert.equal(healthyDispatch.ok, true, JSON.stringify(healthyDispatch.payload));
      const status = store.handle(request({ request_id: 'status-faulted', action: 'status', idempotency_key: null, repo_id: repoId, workstream_run: runA, session_id: null, fencing_generation: null, expected_version: null, payload: {} }));
      assert.equal(status.ok, true, JSON.stringify(status.payload));
      assert.equal('run_scoped_faults' in status.payload, false, 'legacy status grammar must not expose negotiated S1 vocabulary');
      const doctor = store.handle(request({ request_id: 'doctor-faulted', action: 'doctor', idempotency_key: null, repo_id: 'global', workstream_run: null, session_id: null, fencing_generation: null, expected_version: null, payload: {} }));
      assert.equal(doctor.ok, true, JSON.stringify(doctor.payload));
      assert.equal('run_scoped_faults' in doctor.payload, false, 'legacy doctor grammar must remain unchanged');
    } finally { store.close(); }

    const reopened = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-16T00:02:00.000Z') });
    try { assert.equal(reopened.negotiatedRunScopedFaults(repoId, runA).length, 1, 'restart must not duplicate an active fault or its audit event'); }
    finally { reopened.close(); await rm(root, { recursive: true, force: true }); }
  });
});
