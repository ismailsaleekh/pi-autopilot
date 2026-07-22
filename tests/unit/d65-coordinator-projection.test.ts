import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyD65GraphRegistrationBaseline,
  buildD65CoordinatorProjectionMembers,
  d65CoordinatorProjectionIdentity,
  projectD65ChildLease,
  projectD65SessionLease,
  reconstructD65CoordinatorProjection,
  type D65CoordinatorProjectionSnapshot,
} from '../../src/core/coordination/d65-coordinator-projection.ts';
import {
  parseCoordinationAuthoritativeArtifact,
  parseCoordinationChildLease,
  parseCoordinationRun,
  parseCoordinationRunResource,
  parseCoordinationSessionLease,
} from '../../src/core/coordination/contracts.ts';

function snapshot(): D65CoordinatorProjectionSnapshot {
  const run = parseCoordinationRun({ schema_version: 'autopilot.coordination_run.v1', repo_id: 'repo-1', autopilot_id: 'auto-1', workstream: 'work-1', workstream_run: 'run-1', coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 1, created_event_seq: 1, version: 2 });
  const resource = parseCoordinationRunResource({ schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-1', workstream_run: 'run-1', source_repo: '/tmp/source', git_common_dir: '/tmp/source/.git', worktree_root: '/tmp/worktrees', main_worktree_path: '/tmp/worktrees/main', runtime_root: '/tmp/runtime', branch: 'run-1', target_branch: null, target_base_sha: 'a'.repeat(40), origin_url: null, started_at: '2026-07-21T00:00:00.000Z', version: 1 });
  const session = parseCoordinationSessionLease({ schema_version: 'autopilot.session_lease.v2', session_lease_id: 'session-1', repo_id: 'repo-1', workstream_run: 'run-1', session_id: 'physical-1', session_generation: 1, pid: 101, boot_id: 'boot-1', lease_expires_at: '2026-07-21T00:15:00.000Z', attachment_kind: 'dispatch', status: 'attached', attached_event_seq: 2, version: 3 });
  const child = parseCoordinationChildLease({ schema_version: 'autopilot.child_lease.v1', child_lease_id: 'child-1', owner: { repo_id: 'repo-1', autopilot_id: 'auto-1', workstream_run: 'run-1', unit_id: 'unit-1', attempt: 1 }, pid: 102, boot_id: 'boot-2', lease_expires_at: '2026-07-21T00:15:00.000Z', status: 'running', terminal_evidence: null, version: 2 });
  return Object.freeze({ run, resource, sessions: [projectD65SessionLease(session, 1)], children: [projectD65ChildLease(child, 1)], attempts: [], faults: [], reservations: [], edit_leases: [], acquisition_groups: [], worktrees: [], operations: [], terminal_intents: [], current_terminal_intent_id: null, authoritative_artifacts: [], covered_event_seq: 7, run_version: 2 });
}

void describe('D65 additive coordinator_projection encoding freeze', () => {
  void it('round-trips the exact singleton and natural-row identities', () => {
    const source = snapshot();
    const members = buildD65CoordinatorProjectionMembers(source);
    assert.deepEqual(members.map((member) => member.identity), [...members.map((member) => member.identity)].sort());
    assert.equal(members.find((member) => member.kind === 'run')?.identity, 'cp:run');
    assert.equal(members.find((member) => member.kind === 'session')?.identity, d65CoordinatorProjectionIdentity('session', 'session-1'));
    assert.ok(members.every((member) => Buffer.byteLength(member.identity, 'utf8') <= 192));
    const loaded = reconstructD65CoordinatorProjection(members, { repoId: 'repo-1', workstreamRun: 'run-1', coveredEventSeq: 7 });
    assert.deepEqual(loaded, source);
    const session = loaded.sessions[0];
    const child = loaded.children[0];
    if (session === undefined || child === undefined) throw new Error('projection fixture omitted session or child');
    assert.equal('lease_expires_at' in session, false);
    assert.equal('version' in session, false);
    assert.equal(session.semantic_version, 2);
    assert.equal('lease_expires_at' in child, false);
    assert.equal('version' in child, false);
    assert.equal(child.semantic_version, 1);
  });

  void it('rejects an alias whose digest does not bind the embedded natural identity', () => {
    const members = [...buildD65CoordinatorProjectionMembers(snapshot())];
    const index = members.findIndex((member) => member.kind === 'session');
    const session = members[index];
    if (session === undefined) throw new Error('projection fixture omitted session member');
    members[index] = { ...session, identity: d65CoordinatorProjectionIdentity('session', 'session-alias') };
    assert.throws(() => reconstructD65CoordinatorProjection(members, { repoId: 'repo-1', workstreamRun: 'run-1', coveredEventSeq: 7 }), /does not bind its complete embedded natural identity/u);
  });

  void it('rejects duplicate identities, wrong kind, missing singleton, and wrong scalar wrapper', () => {
    const source = buildD65CoordinatorProjectionMembers(snapshot());
    const first = source[0];
    if (first === undefined) throw new Error('projection fixture is unexpectedly empty');
    assert.throws(() => reconstructD65CoordinatorProjection([...source, first], { repoId: 'repo-1', workstreamRun: 'run-1', coveredEventSeq: 7 }), /duplicate entry identity/u);
    assert.throws(() => reconstructD65CoordinatorProjection(source.map((member) => member.kind === 'session' ? { ...member, kind: 'alias-kind' } : member), { repoId: 'repo-1', workstreamRun: 'run-1', coveredEventSeq: 7 }), /unknown kind/u);
    assert.throws(() => reconstructD65CoordinatorProjection(source.filter((member) => member.kind !== 'run-version'), { repoId: 'repo-1', workstreamRun: 'run-1', coveredEventSeq: 7 }), /singleton cardinality/u);
    assert.throws(() => reconstructD65CoordinatorProjection(source.map((member) => member.kind === 'covered-event-seq' ? { ...member, value: { covered_event_seq: 7, alias: true } } : member), { repoId: 'repo-1', workstreamRun: 'run-1', coveredEventSeq: 7 }), /unknown fields/u);
  });

  void it('constructs exact B(N) by adding only the prior graph artifact at R', () => {
    const prior = snapshot();
    const artifact = parseCoordinationAuthoritativeArtifact({ schema_version: 'autopilot.authoritative_artifact.v1', artifact_id: 'semantic-graph:00000000000000000002', repo_id: 'repo-1', source_run: 'run-1', source_type: 'task', source_scope: 'run-main', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: 'a'.repeat(40), evidence: { ref: 'semantic-graphs/00000000000000000002/graph.json', sha256: `sha256:${'b'.repeat(64)}` }, registered_event_seq: 8, version: 1 });
    const baseline = applyD65GraphRegistrationBaseline({ prior, artifact });
    assert.equal(baseline.covered_event_seq, 8);
    assert.deepEqual(baseline.authoritative_artifacts, [artifact]);
    assert.deepEqual({ ...baseline, authoritative_artifacts: [], covered_event_seq: 7 }, prior);
    assert.throws(() => applyD65GraphRegistrationBaseline({ prior, artifact: { ...artifact, registered_event_seq: 9 } }), /registration R is not prior E\+1/u);
    assert.throws(() => applyD65GraphRegistrationBaseline({ prior: { ...prior, authoritative_artifacts: [artifact] }, artifact }), /already contains its own future artifact/u);
  });

  void it('rejects covered-event and run-version disagreement', () => {
    const source = buildD65CoordinatorProjectionMembers(snapshot());
    assert.throws(() => reconstructD65CoordinatorProjection(source, { repoId: 'repo-1', workstreamRun: 'run-1', coveredEventSeq: 8 }), /does not equal the graph root/u);
    const wrongRunVersion = source.map((member) => member.kind === 'run-version' ? { ...member, value: { run_version: 3 } } : member);
    assert.throws(() => reconstructD65CoordinatorProjection(wrongRunVersion, { repoId: 'repo-1', workstreamRun: 'run-1', coveredEventSeq: 7 }), /does not equal the projected run/u);
  });
});
