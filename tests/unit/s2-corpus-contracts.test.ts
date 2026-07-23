import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  parseCorpusCloneManifest,
  parseCorpusCloneRequest,
  parseCorpusRehearsalResult,
  S2_CORPUS_CLONE_MANIFEST_SCHEMA,
  S2_CORPUS_CLONE_REQUEST_SCHEMA,
  S2_CORPUS_REHEARSAL_RESULT_SCHEMA,
} from '../../tools/s2-corpus-rehearsal/contracts.ts';
import { rehearseManifest, runDisposition } from '../../tools/s2-corpus-rehearsal/release-gate.ts';

function sha(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, '0')}`;
}

function identity(index: number) {
  return { device: '1', inode: String(index + 1), link_count: 1 };
}

function proof(index: number) {
  return { passed: true, evidence_sha256: sha(index) };
}

function proofs() {
  return {
    roots_disjoint: proof(1),
    no_shared_regular_file_identity: proof(2),
    no_live_symlink_hardlink_socket_route: proof(3),
    git_mirror_self_contained: proof(4),
    git_no_remote_alternate_hook_include: proof(5),
    capability_rotated: proof(6),
    worktree_paths_rebased: proof(7),
    no_live_lock_database_evidence_write_route: proof(8),
    sandbox_write_confinement: proof(9),
    live_before_after_equal: proof(10),
  };
}

function manifestFixture(): Record<string, unknown> {
  return {
    schema_version: S2_CORPUS_CLONE_MANIFEST_SCHEMA,
    rehearsal_id: 's2-d-contract',
    created_at: '2026-07-23T00:00:00.000Z',
    candidate_build: 'phase36-s2',
    source_witness_before: [
      { corpus_id: 'corpus', root_label: 'repository', path_sha256: sha(11), identity: identity(11), file_count: 2, total_bytes: 10, tree_sha256: sha(12) },
      { corpus_id: 'corpus', root_label: 'state', path_sha256: sha(13), identity: identity(13), file_count: 3, total_bytes: 20, tree_sha256: sha(14) },
    ],
    database_witness_before: [
      { corpus_id: 'corpus', role: 'database', present: true, path_sha256: sha(15), identity: identity(15), size_bytes: 128, sha256: sha(16) },
      { corpus_id: 'corpus', role: 'journal', present: false, path_sha256: sha(17), identity: null, size_bytes: null, sha256: null },
      { corpus_id: 'corpus', role: 'shm', present: false, path_sha256: sha(18), identity: null, size_bytes: null, sha256: null },
      { corpus_id: 'corpus', role: 'wal', present: false, path_sha256: sha(19), identity: null, size_bytes: null, sha256: null },
    ],
    git_witness_before: [{ corpus_id: 'corpus', ref_digest: sha(20), registration_digest: sha(21), worktree_digest: sha(22) }],
    path_rebase_ledger: [
      { corpus_id: 'corpus', target_kind: 'json-file', target_sha256: sha(23), json_pointer: '/source_repo', old_path_sha256: sha(24), clone_relative_path: 'corpora/corpus/repository', rewrite_kind: 'path-rebase', after_sha256: sha(25) },
      { corpus_id: 'corpus', target_kind: 'sqlite-cell', target_sha256: sha(26), json_pointer: '/run_resources/1/payload_json/source_repo', old_path_sha256: sha(27), clone_relative_path: 'corpora/corpus/repository', rewrite_kind: 'path-rebase', after_sha256: sha(28) },
    ],
    clone_capability_sha256: sha(29),
    isolation_proofs: proofs(),
    durable_runs: [
      { corpus_id: 'corpus', run_id_sha256: sha(30), repo_id_sha256: sha(31), required_actions: ['attach', 'doctor', 'reconcile', 'dispatch-dry-run'], attachment_strategy: 'safe-attachment', terminal_attempt_lease: 'no-retained-terminal-attempt-lease', authority_version_mismatch: 'no-operation-authority-version-mismatch', evidence_sha256: sha(32) },
      { corpus_id: 'corpus', run_id_sha256: sha(33), repo_id_sha256: sha(31), required_actions: ['attach', 'doctor', 'reconcile', 'dispatch-dry-run'], attachment_strategy: 'owned-recovery', terminal_attempt_lease: 'retained-terminal-attempt-recovery-required', authority_version_mismatch: 'operation-authority-version-mismatch-recovered', evidence_sha256: sha(34) },
    ],
  };
}

function resultFixture(): Record<string, unknown> {
  const actionRows = [30, 33].flatMap((runIndex) => ['attach', 'dispatch-dry-run', 'doctor', 'reconcile'].map((action, actionIndex) => ({ corpus_id: 'corpus', run_id_sha256: sha(runIndex), action, outcome: 'passed', evidence_sha256: sha(40 + actionIndex + runIndex) })));
  return {
    schema_version: S2_CORPUS_REHEARSAL_RESULT_SCHEMA,
    rehearsal_id: 's2-d-contract',
    candidate_build: 'phase36-s2',
    action_results: actionRows,
    live_unchanged: { source_witness_before_sha256: sha(90), source_witness_after_sha256: sha(90), database_witness_before_sha256: sha(91), database_witness_after_sha256: sha(91), git_witness_before_sha256: sha(92), git_witness_after_sha256: sha(92), database_components: true, git_refs: true, registrations: true, worktrees: true, files: true, passed: true },
    isolation_proofs: proofs(),
    new_blockers: [],
    completed_at: '2026-07-23T01:00:00.000Z',
  };
}

void describe('S2-D corpus contracts', () => {
  void it('accepts closed clone requests, manifests, and per-durable-run rehearsal results', () => {
    const request = parseCorpusCloneRequest({
      schema_version: S2_CORPUS_CLONE_REQUEST_SCHEMA,
      rehearsal_id: 's2-d-contract',
      created_at: '2026-07-23T00:00:00.000Z',
      destination_root: '/tmp/s2-d-clone',
      result_path: '/tmp/s2-d-clone/private/result.json',
      candidate_build: 'phase36-s2',
      corpora: [{ corpus_id: 'corpus', state_root: '/tmp/source-state', repository_root: '/tmp/source-repo', database_path: '/tmp/source-state/coordinator/coordinator.db', capability_path: '/tmp/source-state/coordinator/capability', retained_snapshot_roots: [] }],
    });
    assert.equal(request.corpora.length, 1);
    const manifest = parseCorpusCloneManifest(manifestFixture());
    assert.equal(manifest.durable_runs.length, 2);
    assert.equal(manifest.path_rebase_ledger.some((entry) => entry.target_kind === 'sqlite-cell'), true);
    const result = parseCorpusRehearsalResult(resultFixture());
    assert.equal(result.action_results.length, 8);
  });

  void it('derives Phase36 store dispositions from coordinator rows instead of constants', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE migration_recovery_work(repo_id TEXT, workstream_run TEXT, status TEXT, payload_json TEXT);
        CREATE TABLE worktree_operations(entity_id TEXT, repo_id TEXT, workstream_run TEXT, payload_json TEXT);
        CREATE TABLE worktrees(entity_id TEXT, repo_id TEXT, workstream_run TEXT, payload_json TEXT, version INTEGER);
        CREATE TABLE run_terminal_intents(repo_id TEXT, workstream_run TEXT, payload_json TEXT);
        CREATE TABLE session_leases(repo_id TEXT, workstream_run TEXT, status TEXT);
        CREATE TABLE edit_leases(entity_id TEXT, repo_id TEXT, workstream_run TEXT, payload_json TEXT);
        CREATE TABLE unit_attempts(repo_id TEXT, workstream_run TEXT, payload_json TEXT);
      `);
      const run = { repo_id: 'repo', workstream_run: 'run', status: 'active' };
      assert.deepEqual(runDisposition({ database, run, resource: {} }), {
        attachment_strategy: 'safe-attachment', terminal_attempt_lease: 'no-retained-terminal-attempt-lease', authority_version_mismatch: 'no-operation-authority-version-mismatch',
        phase36_evidence: { pending_migration_recovery: 0, incomplete_owned_operations: 0, authority_version_mismatch_count: 0, terminal_intents: 0, terminal_recovery_supported: 0, retained_non_detached_leases: 0, terminal_retained_attempt_edit_leases: 0, terminal_retained_attempt_leases_covered_by_pending_recovery: 0, attachment_strategy: 'safe-attachment', terminal_attempt_lease: 'no-retained-terminal-attempt-lease', authority_version_mismatch: 'no-operation-authority-version-mismatch' },
      });
      database.prepare('INSERT INTO worktrees VALUES(?,?,?,?,?)').run('worktree', 'repo', 'run', JSON.stringify({ version: 3 }), 3);
      database.prepare('INSERT INTO worktree_operations VALUES(?,?,?,?)').run('op-ok', 'repo', 'run', JSON.stringify({ worktree_id: 'worktree', stage: 'prepared', authority_version: 3 }));
      assert.equal(runDisposition({ database, run, resource: {} }).authority_version_mismatch, 'operation-authority-version-mismatch-recovered');
      database.prepare('UPDATE worktree_operations SET payload_json=? WHERE entity_id=?').run(JSON.stringify({ worktree_id: 'worktree', stage: 'prepared', authority_version: 2 }), 'op-ok');
      assert.equal(runDisposition({ database, run, resource: {} }).authority_version_mismatch, 'operation-authority-version-mismatch-blocked');
      database.prepare('INSERT INTO edit_leases VALUES(?,?,?,?)').run('lease', 'repo', 'run', JSON.stringify({ owner: { unit_id: 'unit', attempt: 1 } }));
      database.prepare('INSERT INTO unit_attempts VALUES(?,?,?)').run('repo', 'run', JSON.stringify({ owner: { unit_id: 'unit', attempt: 1 }, state: 'failed' }));
      database.prepare('INSERT INTO migration_recovery_work VALUES(?,?,?,?)').run('repo', 'run', 'pending', JSON.stringify({ edit_lease_id: 'lease' }));
      const retained = runDisposition({ database, run, resource: {} });
      assert.equal(retained.attachment_strategy, 'owned-recovery');
      assert.equal(retained.terminal_attempt_lease, 'retained-terminal-attempt-recovery-required');
      assert.equal(retained.phase36_evidence['terminal_retained_attempt_leases_covered_by_pending_recovery'], 1);
    } finally { database.close(); }
  });

  void it('keeps candidate doctor failures as release blockers, never passed action rows', () => {
    const source = readFileSync(new URL('../../tools/s2-corpus-rehearsal/candidate-worker.ts', import.meta.url), 'utf8');
    assert.match(source, /blockers\.push\(blocker\(input, 'doctor'/u);
    assert.equal(/doctor_block[\s\S]{0,160}actionRow\(input, 'doctor'/u.test(source), false);
    assert.match(source, /doctor\.payload\['healthy'\] !== true \|\| invariantErrorCount !== 0/u);
  });

  void it('routes retained terminal-attempt recovery through an actual subprocess and leak assertion', () => {
    const source = readFileSync(new URL('../../tools/s2-corpus-rehearsal/candidate-worker.ts', import.meta.url), 'utf8');
    assert.match(source, /terminal-recovery-worker\.ts/u);
    assert.match(source, /runTerminalRecoverySubprocess\(input, before\)/u);
    assert.match(source, /stopCloneCoordinator\(input\.state_root\)/u);
    assert.match(readFileSync(new URL('../../tools/s2-corpus-rehearsal/release-gate.ts', import.meta.url), 'utf8'), /assertCloneCoordinatorReaped\(input\.copy_state_root\)/u);
  });

  void it('rejects fake-green rehearsal without subprocess observations and after-domain witnesses', () => {
    assert.throws(() => rehearseManifest(parseCorpusCloneManifest(manifestFixture())), /subprocess execution and live after-domain witnesses/u);
  });

  void it('rejects release evidence with route gaps, live drift, blockers, or incomplete durable-run coverage', () => {
    const falseProof = manifestFixture();
    falseProof['isolation_proofs'] = { ...proofs(), git_no_remote_alternate_hook_include: { passed: false, evidence_sha256: sha(91) } };
    assert.throws(() => parseCorpusCloneManifest(falseProof), /every isolation proof must pass/u);

    const drift = resultFixture();
    drift['live_unchanged'] = { source_witness_before_sha256: sha(90), source_witness_after_sha256: sha(91), database_witness_before_sha256: sha(91), database_witness_after_sha256: sha(91), git_witness_before_sha256: sha(92), git_witness_after_sha256: sha(92), database_components: true, git_refs: true, registrations: true, worktrees: true, files: true, passed: true };
    assert.throws(() => parseCorpusRehearsalResult(drift), /before\/after proofs/u);

    const databaseDrift = resultFixture();
    databaseDrift['live_unchanged'] = { source_witness_before_sha256: sha(90), source_witness_after_sha256: sha(90), database_witness_before_sha256: sha(91), database_witness_after_sha256: sha(93), git_witness_before_sha256: sha(92), git_witness_after_sha256: sha(92), database_components: true, git_refs: true, registrations: true, worktrees: true, files: true, passed: true };
    assert.throws(() => parseCorpusRehearsalResult(databaseDrift), /before\/after proofs/u);

    const blocker = resultFixture();
    blocker['new_blockers'] = [{ code: 'phase36-blocker', corpus_id: 'corpus', run_id_sha256: sha(30), diagnostic_sha256: sha(92) }];
    assert.throws(() => parseCorpusRehearsalResult(blocker), /new_blockers must be empty/u);

    const empty = resultFixture();
    empty['action_results'] = [];
    assert.throws(() => parseCorpusRehearsalResult(empty), /at least one durable run/u);

    const incomplete = resultFixture();
    const rows = incomplete['action_results'];
    if (!Array.isArray(rows)) throw new Error('fixture actions malformed');
    incomplete['action_results'] = rows.filter((row) => typeof row !== 'object' || row === null || Reflect.get(row, 'action') !== 'doctor');
    assert.throws(() => parseCorpusRehearsalResult(incomplete), /durable-run action coverage is incomplete/u);
  });
});
