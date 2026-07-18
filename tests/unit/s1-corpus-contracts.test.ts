import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseCoordinationWorktree } from '../../src/core/coordination/contracts.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import {
  parseCorpusCloneManifest,
  parseCorpusCloneRequest,
  parseCorpusRehearsalResult,
  S1_CORPUS_CLONE_MANIFEST_SCHEMA,
  S1_CORPUS_CLONE_REQUEST_SCHEMA,
  S1_CORPUS_REHEARSAL_RESULT_SCHEMA,
} from '../../tools/s1-corpus-rehearsal/contracts.ts';
import { historicalSemanticTwinAliases } from '../../tools/s1-corpus-rehearsal/incident-measurement.ts';
import { corpusRunIdentityDigest, durableWorktreeForRegistration } from '../../tools/s1-corpus-rehearsal/incident-runner.ts';

function sha(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, '0')}`;
}

function identity(index: number) {
  return { device: '1', inode: String(index + 1), link_count: 1 };
}

function proof(index: number) {
  return { passed: true, evidence_sha256: sha(index) };
}

function manifestFixture(): Record<string, unknown> {
  const corpusId = 'corpus-actual';
  const registrations = Array.from({ length: 34 }, (_entry, index) => ({
    corpus_id: corpusId,
    repository_label: 'repository',
    worktree_path_sha256: sha(index + 100),
    head_sha: 'a'.repeat(40),
    branch_ref: `refs/heads/autopilot/unit-${String(index).padStart(2, '0')}`,
    prunable: true,
    path_present: false,
  }));
  const coverage = Array.from({ length: 34 }, (_entry, index) => ({
    corpus_id: corpusId,
    incident_id: 'I5',
    subject_id_sha256: sha(index + 200),
    coverage: index < 7 ? 'exact-filesystem' : 'absent',
    snapshot_label: `snapshot-${String(index).padStart(2, '0')}`,
    evidence_sha256: sha(index + 300),
  }));
  return {
    schema_version: S1_CORPUS_CLONE_MANIFEST_SCHEMA,
    rehearsal_id: 'rehearsal-actual-001',
    created_at: '2026-07-16T00:00:00.000Z',
    source_roots: [
      { corpus_id: corpusId, label: 'repository', kind: 'live-repository', path_sha256: sha(80), identity: identity(80), file_count: 1, total_bytes: 128, tree_sha256: sha(81) },
      { corpus_id: corpusId, label: 'state', kind: 'live-state', path_sha256: sha(1), identity: identity(1), file_count: 1, total_bytes: 128, tree_sha256: sha(2) },
    ],
    source_database_components: [
      { corpus_id: corpusId, role: 'database', present: true, path_sha256: sha(3), identity: identity(2), size_bytes: 128, sha256: sha(4) },
      { corpus_id: corpusId, role: 'journal', present: false, path_sha256: sha(82), identity: null, size_bytes: null, sha256: null },
      { corpus_id: corpusId, role: 'shm', present: false, path_sha256: sha(83), identity: null, size_bytes: null, sha256: null },
      { corpus_id: corpusId, role: 'wal', present: false, path_sha256: sha(84), identity: null, size_bytes: null, sha256: null },
    ],
    source_file_digests: [{ corpus_id: corpusId, root_label: 'state', path_sha256: sha(5), kind: 'regular', identity: identity(3), mode: 384, size_bytes: 128, sha256: sha(6), symlink_target_sha256: null }],
    source_git_refs: [{ corpus_id: corpusId, repository_label: 'repository', ref: 'refs/heads/main', object_id: 'a'.repeat(40), object_type: 'commit' }],
    source_worktree_registrations: registrations,
    copy_roots: [{ corpus_id: corpusId, scenario_id: 'candidate-main', label: 'state', clone_relative_path: 'corpora/actual/candidate-main/state', identity: identity(4), file_count: 1, total_bytes: 128, tree_sha256: sha(7) }],
    copy_file_digests: [{ corpus_id: corpusId, scenario_id: 'candidate-main', root_label: 'state', clone_relative_path: 'corpora/actual/candidate-main/state/coordinator/coordinator.db', source_path_sha256: sha(3), identity: identity(5), mode: 384, size_bytes: 128, sha256: sha(8), copy_method: 'sqlite-backup' }],
    copy_git_refs: [{ kind: 'ref', corpus_id: corpusId, scenario_id: 'candidate-main', repository_label: 'repository', ref: 'refs/heads/main', object_id: 'a'.repeat(40), object_type: 'commit' }],
    path_rebase_map: [{ corpus_id: corpusId, source_path_sha256: sha(1), source_label: 'state', clone_relative_path: 'corpora/actual/candidate-main/state', kind: 'state-root', rewrite_ledger_sha256: sha(9) }],
    backup_coverage: coverage,
    capability_sha256: sha(10),
    isolation_proofs: {
      roots_disjoint: proof(11),
      no_shared_regular_file_identity: proof(12),
      no_live_symlink_or_hardlink: proof(13),
      coherent_sqlite_snapshot: proof(14),
      git_objects_self_contained: proof(15),
      git_no_alternates_or_shared_metadata: proof(16),
      no_live_writable_remote_or_config_include: proof(17),
      authority_files_removed: proof(18),
      capability_fresh: proof(19),
      actionable_paths_clone_contained: proof(20),
      environment_clone_only: proof(21),
      sandbox_write_confinement: proof(22),
      construction_live_unchanged: proof(23),
    },
    required_incidents: [
      { incident_id: 'I1', corpus_id: corpusId, cf50_tarball_sha256: 'sha256:e98ccee99e95d5ba9c958c91c354eef40326fa21cf89a8ba37bd10e6650485a7', directions: ['cf50-client-to-s1', 's1-client-to-cf50', 'mixed-election'], actions: ['attach', 'heartbeat', 'idempotent-replay', 'natural-restart'] },
      { incident_id: 'I2', corpus_id: corpusId, operation_id: 'operation-5df1cda32ea1a860e6fe85d8891bb0d2', capture_sha: '8725cf1ba2f361334ce208c7f9e7e417ce780a8a', parent_sha: 'c'.repeat(40), exact_path_set_sha256: sha(25), owner_sha256: sha(26), historical_write_lease_count: 42, historical_write_lease_ids_sha256: sha(27) },
      { incident_id: 'I3', corpus_id: corpusId, semantic_twin_count: 46, semantic_identity_set_sha256: sha(28), operation_history_set_sha256: sha(29), next_attempt_owner_sha256: sha(30) },
      { incident_id: 'I4', corpus_id: corpusId, counter_behind_repo_sha256: sha(31), faulted_run_sha256: sha(32), healthy_run_sha256: sha(33), fatal_negative_kinds: ['counter-ahead', 'payload-owner-ambiguous', 'physical-integrity'] },
      { incident_id: 'I5', corpus_id: corpusId, missing_registration_count: 34, registration_set_sha256: sha(34), preserved_ref_set_sha256: sha(35), exact_filesystem_coverage_count: 7, absence_coverage_count: 27 },
    ],
  };
}

function resultFixture(): Record<string, unknown> {
  const digestFields = { roots_sha256: sha(50), databases_sha256: sha(51), evidence_sha256: sha(52), git_refs_sha256: sha(53), registrations_sha256: sha(54), worktrees_sha256: sha(55) };
  const liveFields = { database_components_sha256: sha(56), evidence_sha256: sha(57), authority_objects_sha256: sha(58), git_refs_sha256: sha(59), registrations_sha256: sha(60), worktrees_sha256: sha(61) };
  return {
    schema_version: S1_CORPUS_REHEARSAL_RESULT_SCHEMA,
    rehearsal_id: 'rehearsal-actual-001',
    candidate_build: '1.2.0-s1',
    store_generation_id: [{ corpus_id: 'corpus-actual', scenario_id: 'candidate-main', generation_id: `generation-${'a'.repeat(32)}` }],
    attach_results: [{ corpus_id: 'corpus-actual', scenario_id: 'candidate-main', repo_id_sha256: sha(62), run_id_sha256: sha(63), attachment_kind: 'dispatch', outcome: 'passed', committed_event_seq: 1, diagnostic_codes: [] }],
    doctor_results: [
      { corpus_id: 'corpus-actual', scenario_id: 'candidate-main', phase: 'post-migration', integrity: 'ok', healthy: true, finding_count: 0, finding_codes: [], projection_sha256: sha(64) },
      { corpus_id: 'corpus-actual', scenario_id: 'candidate-main', phase: 'post-reconciliation', integrity: 'ok', healthy: true, finding_count: 0, finding_codes: [], projection_sha256: sha(74) },
    ],
    reconciliation_results: [
      { corpus_id: 'corpus-actual', scenario_id: 'candidate-main', run_id_sha256: sha(63), consumer: 'metadata-reconcile', before_sha256: sha(65), after_sha256: sha(66), replayed: false, outcome: 'passed', diagnostic_codes: [] },
      { corpus_id: 'corpus-actual', scenario_id: 'candidate-main', run_id_sha256: sha(63), consumer: 'run-reconcile', before_sha256: sha(75), after_sha256: sha(76), replayed: false, outcome: 'passed', diagnostic_codes: [] },
    ],
    dispatch_dry_run_results: [{ corpus_id: 'corpus-actual', scenario_id: 'candidate-main', run_id_sha256: sha(63), disposition: 'launchable', planner_invoked: true, scheduler_plan_sha256: sha(67), selected_count: 1, skipped_code_counts: [], coordinator_admission_probe: 'acquire-cancel', coordinator_admission_probe_code: 'acquire-cancel-passed', agent_process_started: false, external_git_effect_started: false, outcome: 'passed' }],
    incident_results: [
      { incident_id: 'I1', provenance: 'retained-actual', passed: true, assertion_ids: ['actual-cf50-client-to-s1', 's1-client-to-actual-cf50', 'attach-heartbeat-replay', 'natural-restart', 'mixed-election'], evidence_sha256: sha(68) },
      { incident_id: 'I2', provenance: 'retained-actual', passed: true, assertion_ids: ['capture-exact', 'parent-exact', 'path-set-exact', 'no-release-before-proof', 'historical-lease-set-exact'], evidence_sha256: sha(69) },
      { incident_id: 'I3', provenance: 'retained-actual', passed: true, assertion_ids: ['twins-46-classified', 'aliases-or-scoped-recovery', 'cleanup-idempotent-replay', 'safe-next-attempt-created'], evidence_sha256: sha(70) },
      { incident_id: 'I4', provenance: 'actual-plus-controlled-clone-injection', passed: true, assertion_ids: ['counter-behind-audited-repair', 'faulted-run-only-blocked', 'healthy-run-dispatched', 'ambiguous-and-physical-fatal'], evidence_sha256: sha(71) },
      { incident_id: 'I5', provenance: 'retained-actual', passed: true, assertion_ids: ['registrations-34-reconciled', 'branch-refs-preserved', 'archive-refs-preserved', 'evidence-preserved', 'missing-bytes-not-invented'], evidence_sha256: sha(72) },
    ],
    copy_post_digests: digestFields,
    live_post_digests: liveFields,
    live_unchanged: { baseline_inventory_sha256: sha(73), post_inventory_sha256: sha(73), database_components: true, evidence: true, authority_objects: true, git_refs: true, registrations: true, worktrees: true, passed: true },
    new_blockers: [],
    completed_at: '2026-07-16T01:00:00.000Z',
  };
}

void describe('C5 private clone and rehearsal contracts', () => {
  void it('accepts only the exact measured I1-I5 manifest and complete passing result', () => {
    const manifest = parseCorpusCloneManifest(manifestFixture());
    assert.equal(manifest.required_incidents[2].semantic_twin_count, 46);
    assert.equal(manifest.required_incidents[4].missing_registration_count, 34);
    const result = parseCorpusRehearsalResult(resultFixture());
    assert.equal(result.live_unchanged.passed, true);
    assert.deepEqual(result.new_blockers, []);
  });

  void it('keeps same-named durable runs in different repositories collision-free', () => {
    assert.notEqual(corpusRunIdentityDigest('repo-a', 'run-001'), corpusRunIdentityDigest('repo-b', 'run-001'));
    assert.equal(corpusRunIdentityDigest('repo-a', 'run-001'), corpusRunIdentityDigest('repo-a', 'run-001'));
  });

  void it('detects historical twins from semantic identity rather than an ID prefix', () => {
    const owner = { repo_id: 'repo-a', autopilot_id: 'autopilot-a', workstream_run: 'run-001', unit_id: 'unit-real', attempt: 6 };
    const canonical = parseCoordinationWorktree({ schema_version: 'autopilot.coordination_worktree.v2', worktree_id: deterministicWorktreeId(owner, 'unit'), owner, kind: 'unit', canonical_path: '/clone/worktrees/twin', git_common_dir: '/clone/repository/.git', branch: 'autopilot/twin', state: 'terminal', version: 4 });
    const historical = parseCoordinationWorktree({ ...canonical, worktree_id: 'legacy-id-with-no-migration-prefix' });
    assert.deepEqual(historicalSemanticTwinAliases([canonical, historical]).map((entry) => entry.worktree_id), [historical.worktree_id]);
  });

  void it('binds I5 approval ownership only to one real canonical durable worktree row', () => {
    const owner = { repo_id: 'repo-a', autopilot_id: 'autopilot-a', workstream_run: 'run-001', unit_id: 'unit-real', attempt: 7 };
    const worktree = parseCoordinationWorktree({ schema_version: 'autopilot.coordination_worktree.v2', worktree_id: deterministicWorktreeId(owner, 'unit'), owner, kind: 'unit', canonical_path: '/clone/worktrees/real', git_common_dir: '/clone/repository/.git', branch: 'autopilot/durable-real', state: 'terminal', version: 9 });
    assert.equal(durableWorktreeForRegistration([worktree], { worktree_path: worktree.canonical_path, branch_ref: `refs/heads/${worktree.branch}` }), worktree);
    assert.throws(() => durableWorktreeForRegistration([worktree], { worktree_path: worktree.canonical_path, branch_ref: 'refs/heads/autopilot/guessed-from-name' }), /exactly one real canonical durable worktree/u);
    const alias = parseCoordinationWorktree({ ...worktree, worktree_id: 'historical-alias' });
    assert.throws(() => durableWorktreeForRegistration([alias], { worktree_path: alias.canonical_path, branch_ref: `refs/heads/${alias.branch}` }), /exactly one real canonical durable worktree/u);
  });

  void it('rejects unknown fields, unsorted identities, false isolation, and incomplete I5 coverage', () => {
    const unknown = manifestFixture();
    const sourceRoots = unknown['source_roots'];
    if (!Array.isArray(sourceRoots) || typeof sourceRoots[0] !== 'object' || sourceRoots[0] === null) throw new Error('fixture source roots malformed');
    sourceRoots[0] = { ...(sourceRoots[0] as Record<string, unknown>), unexpected: true };
    assert.throws(() => parseCorpusCloneManifest(unknown), /field set mismatch/u);

    const unsorted = manifestFixture();
    const registrations = unsorted['source_worktree_registrations'];
    if (!Array.isArray(registrations)) throw new Error('fixture registrations malformed');
    unsorted['source_worktree_registrations'] = [...registrations].reverse();
    assert.throws(() => parseCorpusCloneManifest(unsorted), /sorted and unique/u);

    const falseProof = manifestFixture();
    const proofs = falseProof['isolation_proofs'];
    if (typeof proofs !== 'object' || proofs === null || Array.isArray(proofs)) throw new Error('fixture proofs malformed');
    falseProof['isolation_proofs'] = { ...proofs, capability_fresh: { passed: false, evidence_sha256: sha(90) } };
    assert.throws(() => parseCorpusCloneManifest(falseProof), /every independently measured proof must pass/u);

    const incomplete = manifestFixture();
    const coverage = incomplete['backup_coverage'];
    if (!Array.isArray(coverage)) throw new Error('fixture coverage malformed');
    incomplete['backup_coverage'] = coverage.slice(0, -1);
    assert.throws(() => parseCorpusCloneManifest(incomplete), /34\/7\/27/u);

    const missingJournal = manifestFixture();
    const components = missingJournal['source_database_components'];
    if (!Array.isArray(components)) throw new Error('fixture database components malformed');
    missingJournal['source_database_components'] = components.filter((entry) => typeof entry !== 'object' || entry === null || Reflect.get(entry, 'role') !== 'journal');
    assert.throws(() => parseCorpusCloneManifest(missingJournal), /database,journal,shm,wal/u);
  });

  void it('refuses to parse a blocker, live drift, failed incident, or dry-run side effect as certification', () => {
    const blocker = resultFixture();
    blocker['new_blockers'] = [{ code: 'actual-corpus-coverage-missing', corpus_id: 'corpus-actual', run_id_sha256: null, incident_id: 'I3', diagnostic_sha256: sha(91) }];
    assert.throws(() => parseCorpusRehearsalResult(blocker), /complete passing evidence/u);

    const drift = resultFixture();
    const live = drift['live_unchanged'];
    if (typeof live !== 'object' || live === null || Array.isArray(live)) throw new Error('fixture live proof malformed');
    drift['live_unchanged'] = { ...live, evidence: false, passed: false };
    assert.throws(() => parseCorpusRehearsalResult(drift), /complete passing evidence/u);

    const failedIncident = resultFixture();
    const incidents = failedIncident['incident_results'];
    if (!Array.isArray(incidents) || typeof incidents[2] !== 'object' || incidents[2] === null) throw new Error('fixture incidents malformed');
    incidents[2] = { ...(incidents[2] as Record<string, unknown>), passed: false };
    assert.throws(() => parseCorpusRehearsalResult(failedIncident), /complete passing evidence/u);

    const sideEffect = resultFixture();
    const dispatch = sideEffect['dispatch_dry_run_results'];
    if (!Array.isArray(dispatch) || typeof dispatch[0] !== 'object' || dispatch[0] === null) throw new Error('fixture dispatch malformed');
    dispatch[0] = { ...(dispatch[0] as Record<string, unknown>), agent_process_started: true };
    assert.throws(() => parseCorpusRehearsalResult(sideEffect), /must not start an agent/u);

    const fabricatedPlan = resultFixture();
    const fabricatedRows = fabricatedPlan['dispatch_dry_run_results'];
    if (!Array.isArray(fabricatedRows) || typeof fabricatedRows[0] !== 'object' || fabricatedRows[0] === null) throw new Error('fixture dispatch planner evidence malformed');
    fabricatedRows[0] = { ...(fabricatedRows[0] as Record<string, unknown>), planner_invoked: false };
    assert.throws(() => parseCorpusRehearsalResult(fabricatedPlan), /exactly match scheduler plan evidence presence/u);

    const relabeledProbe = resultFixture();
    const probeRows = relabeledProbe['dispatch_dry_run_results'];
    if (!Array.isArray(probeRows) || typeof probeRows[0] !== 'object' || probeRows[0] === null) throw new Error('fixture dispatch probe evidence malformed');
    probeRows[0] = { ...(probeRows[0] as Record<string, unknown>), coordinator_admission_probe: 'not-applicable' };
    assert.throws(() => parseCorpusRehearsalResult(relabeledProbe), /probe and its explicit result code must agree/u);

    const incompletePhases = resultFixture();
    const doctors = incompletePhases['doctor_results'];
    if (!Array.isArray(doctors)) throw new Error('fixture doctors malformed');
    incompletePhases['doctor_results'] = doctors.slice(0, 1);
    assert.throws(() => parseCorpusRehearsalResult(incompletePhases), /complete passing evidence/u);

    const runCoverageMismatch = resultFixture();
    const dispatchRows = runCoverageMismatch['dispatch_dry_run_results'];
    if (!Array.isArray(dispatchRows) || typeof dispatchRows[0] !== 'object' || dispatchRows[0] === null) throw new Error('fixture dispatch coverage malformed');
    dispatchRows[0] = { ...(dispatchRows[0] as Record<string, unknown>), run_id_sha256: sha(99) };
    assert.throws(() => parseCorpusRehearsalResult(runCoverageMismatch), /complete passing evidence/u);
  });

  void it('reports missing private corpus input as not-run with a release-blocking exit', () => {
    const env = { ...process.env };
    delete env['C5_PRIVATE_REQUEST'];
    const result = spawnSync(process.execPath, ['--experimental-strip-types', join(process.cwd(), 'tools', 's1-corpus-rehearsal', 'cli.ts'), 'status'], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout) as unknown, { reason: 'private_corpus_request_unavailable', schema_version: 'autopilot.s1_corpus_gate_status.v1', status: 'not_run' });
  });

  void it('keeps raw source paths only in a private, exact, absolute-path capture request', () => {
    const root = resolve('/tmp', 'private-c5-request');
    const request = parseCorpusCloneRequest({
      schema_version: S1_CORPUS_CLONE_REQUEST_SCHEMA,
      rehearsal_id: 'rehearsal-actual-001',
      created_at: '2026-07-16T00:00:00.000Z',
      destination_root: resolve(root, 'clone'),
      result_path: resolve(root, 'result.json'),
      candidate_tarball_path: resolve(root, 'candidate.tgz'),
      candidate_tarball_sha256: sha(92),
      cf50_tarball_path: resolve(root, 'cf50.tgz'),
      cf50_tarball_sha256: sha(93),
      corpora: [{ corpus_id: 'corpus-actual', state_root: resolve(root, 'source-state'), repository_root: resolve(root, 'source-repository'), database_path: resolve(root, 'source-state/coordinator/coordinator.db'), retained_snapshot_roots: [resolve(root, 'retained')] }],
    });
    assert.equal(request.corpora.length, 1);
    assert.throws(() => parseCorpusCloneRequest({ ...request, destination_root: 'relative-clone' }), /must be absolute/u);
  });
});
