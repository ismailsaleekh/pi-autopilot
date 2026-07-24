// Sharded from tests/unit/worktree-saga-recovery.test.ts (Phase 40 / D70 change C4).
// Test bodies are byte-identical to the originals; only the file boundary and
// the shared-helper import changed. Same describe name preserves test identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { executeOwnedWorktreeSaga, fixedWorktreeSagaCallbacks, OwnedWorktreeSagaClient, recoverOwnedWorktreeSagas } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, BRANCHES_FILE, MATERIALIZED_PATHS_FILE, UNIT_INDEX_FILE, UNIT_INFO_FILE, WORKTREE_LEDGER_FILE, prepareAutopilotWorkstream, readUnitIndex, recoverAutopilotWorktreeSagas, resolveRepoIdentity } from '../../src/core/parallel-runtime.ts';
import { git, setup, close, unitCreateSpec } from '../helpers/worktree-saga-harness.ts';

void describe('owner-scoped worktree and Git saga recovery', () => {
  void it('replays a committed canonical key through a later committed reset without repeating its historical effect', async () => {
    const value = await setup('sup');
    try {
      const create = unitCreateSpec(value, 'unit-superseded-commit');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const base = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      const commit = { ...create, operationType: 'commit' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, reason: 'canonical supersession commit', base_sha: base, target_sha: null, checkout_mode: null, paths: ['src/historical.ts'] } };
      let commitActions = 0;
      const commitCallbacks = { action: async () => { commitActions += 1; await writeFile(join(create.intent.worktree_path, 'src', 'historical.ts'), 'historical\n', 'utf8'); git(create.intent.worktree_path, ['add', 'src/historical.ts']); git(create.intent.worktree_path, ['commit', '-m', 'historical commit']); } };
      const committed = await executeOwnedWorktreeSaga(commit, commitCallbacks, value.env);
      const committedHead = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      assert.equal(committed.operation?.stage, 'committed');
      assert.equal(commitActions, 1);

      const reset = { ...create, operationType: 'reset' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'terminal' as const, intent: { ...create.intent, reason: 'canonical later reset', base_sha: committedHead, target_sha: base, checkout_mode: null, paths: [] } };
      await executeOwnedWorktreeSaga(reset, { action: () => { git(create.intent.worktree_path, ['reset', '--hard', base]); } }, value.env);
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), base);

      const replay = await executeOwnedWorktreeSaga(commit, commitCallbacks, value.env);
      assert.equal(replay.operation?.operation_id, committed.operation?.operation_id);
      assert.equal(replay.replayed, true);
      assert.equal(commitActions, 1);
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), base);
    } finally {
      await close(value);
    }
  });


  void it('finishes an exact pre-spend rollback projection after remove response loss without touching another live child', async () => {
    const value = await setup('z');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-pre-spend-failure');
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const taskRoot = dirname(dirname(dirname(dirname(create.intent.worktree_path))));
      const attemptRoot = dirname(create.intent.worktree_path);
      const branchInfo = {
        unit_id: 'unit-pre-spend-failure', attempt: 1, branch: create.intent.branch, worktree_path: create.intent.worktree_path,
        base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, status: 'active' as const,
      };
      await writeFile(join(attemptRoot, UNIT_INFO_FILE), `${JSON.stringify({
        schema_version: 'autopilot.unit_info.v1', workstream: value.active.workstream, workstream_run: value.active.workstream_run,
        autopilot_id: value.active.autopilot_id, ...branchInfo, runtime_root: value.active.runtime_root,
        created_at: value.active.started_at, checkout_mode: 'full', checkout_profile_ref: '_checkout-profile.json', materialized_paths_ref: MATERIALIZED_PATHS_FILE,
      }, null, 2)}\n`, 'utf8');
      await writeFile(join(attemptRoot, MATERIALIZED_PATHS_FILE), '{}\n', 'utf8');
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [branchInfo] }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, BRANCHES_FILE), `${JSON.stringify({ schema_version: 'autopilot.branches.v1', active_branch: value.active.branch, base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, unit_branches: [branchInfo] }, null, 2)}\n`, 'utf8');

      const coordinator = new CoordinatorClient({ env: value.env, autoStart: false });
      await coordinator.mutate('register-attempt', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id,
        fencingGeneration: value.session.session_generation, expectedVersion: value.session.run_version, idempotencyKey: 'register-unrelated-strategy-attempt',
      }, {
        unit_id: 'strategy-read-only', attempt: 1, spec_ref: 'unit-specs/strategy-read-only.json', spec_sha256: `sha256:${'a'.repeat(64)}`,
        role: 'strategy', preemptible: true, checkpoint_ordinal: 0, session_lease_id: value.session.session_lease_id, session_token: value.session.session_token,
      });
      await coordinator.mutate('register-child', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id,
        fencingGeneration: value.session.session_generation, expectedVersion: value.session.run_version, idempotencyKey: 'register-unrelated-strategy-child',
      }, {
        child_lease_id: 'child-run-z-strategy-read-only-1', autopilot_id: value.active.autopilot_id, unit_id: 'strategy-read-only', attempt: 1,
        pid: process.pid, boot_id: 'strategy-child-boot', child_token: 'e'.repeat(64), session_lease_id: value.session.session_lease_id,
        session_token: value.session.session_token, lease_expires_at: '2099-01-01T00:00:00.000Z',
      });

      const remove = {
        ...create, operationType: 'remove' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const,
        intent: { ...create.intent, reason: 'autopilot-agent-run preflight rollback after failure: synthetic pre-spend rejection', target_sha: value.active.target_base_sha, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [WORKTREE_LEDGER_FILE] },
      };
      await saga.prepare(remove);
      git(value.repo, ['worktree', 'remove', create.intent.worktree_path]);
      git(value.repo, ['branch', '-D', create.intent.branch]);

      const recovered = await recoverAutopilotWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.operation_type === 'remove' && operation.owner.unit_id === 'unit-pre-spend-failure' && operation.stage === 'committed'), true);
      assert.equal((await readUnitIndex(taskRoot)).units.some((unit) => unit.unit_id === 'unit-pre-spend-failure' && unit.attempt === 1), false);
      const branches = JSON.parse(await readFile(join(taskRoot, BRANCHES_FILE), 'utf8')) as Readonly<Record<string, unknown>>;
      assert.equal(Array.isArray(branches['unit_branches']) && branches['unit_branches'].length, 0);
      assert.equal(existsSync(attemptRoot), false);
      const replayed = await recoverAutopilotWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(replayed.some((operation) => operation.owner.unit_id === 'unit-pre-spend-failure' && operation.stage !== 'committed'), false);
      assert.equal((await readUnitIndex(taskRoot)).units.some((unit) => unit.unit_id === 'unit-pre-spend-failure'), false);
      const status = await coordinator.query('status', value.active.repo_key, value.active.workstream_run);
      const children = status.payload['child_leases'];
      assert.equal(Array.isArray(children) && children.some((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['child_lease_id'] === 'child-run-z-strategy-read-only-1' && (entry as Record<string, unknown>)['status'] === 'running'), true);
    } finally {
      await close(value);
    }
  });


  void it('preserves a later package-owned quarantine when a historical preflight rollback was superseded', async () => {
    const value = await setup('s');
    let restarted: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const full = unitCreateSpec(value, 'unit-superseded-rollback');
      const create = { ...full, intent: { ...full.intent, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/src/base.ts'] } };
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const taskRoot = dirname(dirname(dirname(dirname(create.intent.worktree_path))));
      const attemptRoot = dirname(create.intent.worktree_path);
      const activeBranchInfo = {
        unit_id: create.unitId, attempt: create.attempt, branch: create.intent.branch, worktree_path: create.intent.worktree_path,
        base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, status: 'active' as const,
      };
      await writeFile(join(attemptRoot, UNIT_INFO_FILE), `${JSON.stringify({
        schema_version: 'autopilot.unit_info.v1', workstream: value.active.workstream, workstream_run: value.active.workstream_run,
        autopilot_id: value.active.autopilot_id, ...activeBranchInfo, runtime_root: value.active.runtime_root,
        created_at: value.active.started_at, checkout_mode: 'claim-minimal', checkout_profile_ref: '_checkout-profile.json', materialized_paths_ref: MATERIALIZED_PATHS_FILE,
      }, null, 2)}\n`, 'utf8');
      await writeFile(join(attemptRoot, MATERIALIZED_PATHS_FILE), '{}\n', 'utf8');
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [activeBranchInfo] }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, BRANCHES_FILE), `${JSON.stringify({ schema_version: 'autopilot.branches.v1', active_branch: value.active.branch, base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, unit_branches: [activeBranchInfo] }, null, 2)}\n`, 'utf8');

      const rollback = {
        ...create, operationType: 'remove' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const,
        intent: { ...create.intent, reason: 'autopilot-agent-run preflight rollback after failure: synthetic pre-spend rejection', target_sha: value.active.target_base_sha, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [WORKTREE_LEDGER_FILE] },
      };
      await saga.prepare(rollback);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(create.intent.worktree_path), false);

      const recreate = { ...create, intent: { ...create.intent, reason: 'package recreate after exact pre-spend rollback' } };
      const preparedRecreate = await saga.prepare(recreate);
      await executeOwnedWorktreeSaga(recreate, fixedWorktreeSagaCallbacks(preparedRecreate.operation, value.env), value.env);
      const materialize = {
        ...create, operationType: 'materialize' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...create.intent, reason: 'package materialization after exact recreate', base_sha: null, sparse_patterns: ['/docs/context.md'], paths: ['docs/context.md'] },
      };
      await saga.prepare(materialize);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });

      const coordinator = new CoordinatorClient({ env: value.env, autoStart: false });
      await coordinator.mutate('register-attempt', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id,
        fencingGeneration: value.session.session_generation, expectedVersion: value.session.run_version, idempotencyKey: 'register-superseded-rollback-attempt',
      }, {
        unit_id: create.unitId, attempt: create.attempt, spec_ref: `unit-specs/${create.unitId}.json`, spec_sha256: `sha256:${'c'.repeat(64)}`,
        role: 'fix', preemptible: true, checkpoint_ordinal: 0, session_lease_id: value.session.session_lease_id, session_token: value.session.session_token,
      });
      const childLeaseId = `child-${value.active.workstream_run}-${create.unitId}-${String(create.attempt)}`;
      await coordinator.mutate('register-child', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id,
        fencingGeneration: value.session.session_generation, expectedVersion: value.session.run_version, idempotencyKey: 'register-superseded-rollback-child',
      }, {
        child_lease_id: childLeaseId, autopilot_id: value.active.autopilot_id, unit_id: create.unitId, attempt: create.attempt,
        pid: process.pid, boot_id: 'superseded-rollback-child-boot', child_token: 'f'.repeat(64), session_lease_id: value.session.session_lease_id,
        session_token: value.session.session_token, lease_expires_at: '2099-01-01T00:00:00.000Z',
      });

      const quarantineBase = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(create.intent.worktree_path, 'src', 'quarantined.ts'), 'preserve exact failed work\n', 'utf8');
      const quarantine = {
        ...create, operationType: 'quarantine' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'quarantined' as const,
        intent: { ...create.intent, reason: 'quarantine later package-owned failed work', base_sha: quarantineBase, target_sha: null, checkout_mode: null, sparse_patterns: [], paths: ['src/quarantined.ts'] },
      };
      await saga.prepare(quarantine);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const captureHead = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/${create.unitId}/attempt-1/capture`;
      const archive = {
        ...create, operationType: 'archive' as const, initialWorktreeState: 'quarantined' as const, committedWorktreeState: 'quarantined' as const,
        intent: { ...create.intent, reason: 'archive exact later quarantine capture', base_sha: quarantineBase, target_sha: captureHead, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [] },
      };
      const preparedArchive = await saga.prepare(archive);
      await executeOwnedWorktreeSaga(archive, fixedWorktreeSagaCallbacks(preparedArchive.operation, value.env), value.env);
      const quarantinedBranchInfo = { ...activeBranchInfo, current_sha: captureHead, archive_ref: archiveRef, status: 'quarantined' as const };
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [quarantinedBranchInfo] }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, BRANCHES_FILE), `${JSON.stringify({ schema_version: 'autopilot.branches.v1', active_branch: value.active.branch, base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, unit_branches: [quarantinedBranchInfo] }, null, 2)}\n`, 'utf8');

      const rollbackBeforeAlias = (await saga.operations()).find((operation) => operation.operation_type === 'remove' && operation.intent.reason.startsWith('autopilot-agent-run preflight rollback after failure:'));
      if (rollbackBeforeAlias?.verification_evidence === null || rollbackBeforeAlias?.verification_evidence === undefined) throw new Error('superseded rollback evidence is missing before alias migration');
      const canonicalProjection = (await saga.worktrees()).find((worktree) => worktree.owner.unit_id === create.unitId && worktree.owner.attempt === create.attempt);
      if (canonicalProjection === undefined) throw new Error('superseded rollback canonical worktree is missing');
      const rollbackAliasId = 'migration-worktree-superseded-rollback';
      const rollbackEvidencePath = join(value.active.worktree_root, ...rollbackBeforeAlias.verification_evidence.ref.split('/'));
      const rollbackEvidence = JSON.parse(await readFile(rollbackEvidencePath, 'utf8')) as Readonly<Record<string, unknown>>;
      const historicalRollbackEvidenceBytes = `${JSON.stringify({ ...rollbackEvidence, worktree_id: rollbackAliasId })}\n`;
      const historicalRollbackEvidenceSha = `sha256:${createHash('sha256').update(historicalRollbackEvidenceBytes, 'utf8').digest('hex')}` as const;
      const historicalRollback = { ...rollbackBeforeAlias, worktree_id: rollbackAliasId, verification_evidence: { ...rollbackBeforeAlias.verification_evidence, sha256: historicalRollbackEvidenceSha } };
      const aliasProjection = { ...canonicalProjection, worktree_id: rollbackAliasId };

      const generationDatabasePath = value.server.store.currentGeneration().database_path;
      await value.server.close();
      await writeFile(rollbackEvidencePath, historicalRollbackEvidenceBytes, 'utf8');
      const database = new DatabaseSync(generationDatabasePath);
      try {
        database.prepare("UPDATE child_leases SET status='recovery-required', version=version+1 WHERE child_lease_id=?").run(childLeaseId);
        const row = database.prepare("SELECT entity_id, payload_json FROM unit_attempts WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.owner.unit_id')=? AND json_extract(payload_json, '$.owner.attempt')=?").get(value.active.repo_key, value.active.workstream_run, create.unitId, create.attempt) as Readonly<Record<string, unknown>> | undefined;
        if (row === undefined || typeof row['entity_id'] !== 'string' || typeof row['payload_json'] !== 'string') throw new Error('unit attempt fixture row is missing');
        const payload = JSON.parse(row['payload_json']) as Record<string, unknown>;
        const next = { ...payload, state: 'quarantined', version: Number(payload['version']) + 1 };
        database.prepare('UPDATE unit_attempts SET payload_json=?, version=? WHERE entity_id=?').run(JSON.stringify(next), next.version, row['entity_id']);
        database.prepare('UPDATE worktree_operations SET payload_json=? WHERE entity_id=?').run(JSON.stringify(historicalRollback), historicalRollback.operation_id);
        database.prepare('INSERT INTO worktrees(entity_id,repo_id,workstream_run,payload_json,version,canonical_worktree_id,autopilot_id,unit_id,attempt,kind,is_current_canonical) VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(
          rollbackAliasId, aliasProjection.owner.repo_id, aliasProjection.owner.workstream_run, JSON.stringify(aliasProjection), aliasProjection.version, canonicalProjection.worktree_id, aliasProjection.owner.autopilot_id, aliasProjection.owner.unit_id, aliasProjection.owner.attempt, aliasProjection.kind,
        );
        database.prepare('INSERT INTO worktree_aliases(alias_worktree_id,canonical_worktree_id,repo_id,autopilot_id,workstream_run,unit_id,attempt,kind,resolution_state,reason,evidence_sha256,created_event_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
          rollbackAliasId, canonicalProjection.worktree_id, historicalRollback.owner.repo_id, historicalRollback.owner.autopilot_id, historicalRollback.owner.workstream_run, historicalRollback.owner.unit_id, historicalRollback.owner.attempt, aliasProjection.kind, 'resolved', 'legacy-migration-id', historicalRollbackEvidenceSha, historicalRollback.intent_event_seq,
        );
      } finally { database.close(); }
      restarted = await startCoordinatorServer(coordinatorRuntimePaths(value.env));

      const rejectUnprovenSupersession = async (): Promise<void> => {
        await assert.rejects(
          () => recoverAutopilotWorktreeSagas({ active: value.active, env: value.env }),
          (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required',
        );
      };
      const foreignResidue = join(create.intent.worktree_path, 'src', 'foreign-residue.ts');
      await writeFile(foreignResidue, 'foreign residue\n', 'utf8');
      await rejectUnprovenSupersession();
      await rm(foreignResidue);

      git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, quarantineBase]);
      await rejectUnprovenSupersession();
      git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, captureHead]);

      const mismatchedIndex = { ...quarantinedBranchInfo, current_sha: quarantineBase };
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [mismatchedIndex] }, null, 2)}\n`, 'utf8');
      await rejectUnprovenSupersession();
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [quarantinedBranchInfo] }, null, 2)}\n`, 'utf8');

      const archiveOperation = (await saga.operations()).find((operation) => operation.operation_type === 'archive' && operation.owner.unit_id === create.unitId);
      if (archiveOperation?.verification_evidence === null || archiveOperation?.verification_evidence === undefined) throw new Error('archive operation evidence is missing');
      const archiveEvidencePath = join(value.active.worktree_root, ...archiveOperation.verification_evidence.ref.split('/'));
      const archiveEvidenceBytes = await readFile(archiveEvidencePath);
      await writeFile(archiveEvidencePath, Buffer.concat([archiveEvidenceBytes, Buffer.from('tamper')]));
      await rejectUnprovenSupersession();
      await writeFile(archiveEvidencePath, archiveEvidenceBytes);

      await recoverAutopilotWorktreeSagas({ active: value.active, env: value.env });
      await recoverAutopilotWorktreeSagas({ active: value.active, env: value.env });
      const rollbackOperation = (await saga.operations()).find((operation) => operation.operation_type !== 'metadata-reconcile' && operation.intent.reason.startsWith('autopilot-agent-run preflight rollback after failure:'));
      if (rollbackOperation === undefined) throw new Error('historical rollback operation is missing');
      const auditPath = join(value.active.worktree_root, '_saga-evidence', value.active.workstream_run, 'supersessions', `${rollbackOperation.operation_id}.json`);
      assert.equal(existsSync(auditPath), true);
      const audit = JSON.parse(await readFile(auditPath, 'utf8')) as Readonly<Record<string, unknown>>;
      assert.equal(audit['schema_version'], 'autopilot.worktree_rollback_supersession.v1');
      assert.equal(audit['disposition'], 'historical-preflight-rollback-superseded-by-exact-later-package-quarantine');
      assert.equal(existsSync(create.intent.worktree_path), true);
      assert.equal(git(create.intent.worktree_path, ['status', '--porcelain']), '');
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), captureHead);
      assert.equal((await readUnitIndex(taskRoot)).units[0]?.status, 'quarantined');
      const doctor = await new CoordinatorClient({ env: value.env, autoStart: false }).query('doctor');
      const findings = doctor.payload['invariant_findings'];
      assert.equal(Array.isArray(findings) && findings.some((finding) => typeof finding === 'object' && finding !== null && (finding as Record<string, unknown>)['code'] === 'worktree-remove-state-mismatch'), false);
    } finally {
      if (restarted !== null) await restarted.close();
      await value.server.close().catch(() => undefined);
      await rm(value.root, { recursive: true, force: true });
    }
  });


  void it('rejects duplicate injection through both the retired schema-12 path and current schema-13 generation', async () => {
    const value = await setup('d');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-duplicate');
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const canonical = (await saga.worktrees()).find((entry) => entry.owner.unit_id === 'unit-duplicate');
      if (canonical === undefined) throw new Error('canonical unit worktree is missing');
      const generationDatabasePath = value.server.store.currentGeneration().database_path;
      const pointerBefore = await readFile(coordinatorRuntimePaths(value.env).currentStorePointerPath);
      await value.server.close();
      const duplicate = { ...canonical, worktree_id: 'migration-worktree-schema12-duplicate' };
      const fixed = new DatabaseSync(coordinatorRuntimePaths(value.env).databasePath);
      try {
        assert.throws(() => fixed.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(duplicate.worktree_id, duplicate.owner.repo_id, duplicate.owner.workstream_run, JSON.stringify(duplicate), duplicate.version), /cf50 fixed store retired by S1 generation publication/u);
      } finally { fixed.close(); }
      const database = new DatabaseSync(generationDatabasePath);
      try {
        database.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(duplicate.worktree_id, duplicate.owner.repo_id, duplicate.owner.workstream_run, JSON.stringify(duplicate), duplicate.version);
      } finally { database.close(); }
      await assert.rejects(() => startCoordinatorServer(coordinatorRuntimePaths(value.env)), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'store-corrupt' && error.evidence.includes(duplicate.worktree_id));
      assert.deepEqual(await readFile(coordinatorRuntimePaths(value.env).currentStorePointerPath), pointerBefore);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });


  void it('rejects a history-free terminal shadow through both retired schema-12 and current schema-13 paths', async () => {
    const value = await setup('r');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-removed-shadow');
      const remove = {
        ...create, operationType: 'remove' as const, initialWorktreeState: 'terminal' as const, committedWorktreeState: 'removed' as const,
        intent: { ...create.intent, reason: 'prepare unit worktree pre-create cleanup', target_sha: value.active.target_base_sha, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [] },
      };
      await saga.prepare(remove);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const canonical = (await saga.worktrees()).find((entry) => entry.owner.unit_id === create.unitId);
      if (canonical === undefined || canonical.state !== 'removed') throw new Error('deterministic removed projection is missing');
      assert.equal(existsSync(canonical.canonical_path), false);
      assert.equal(git(value.repo, ['branch', '--list', canonical.branch]), '');

      const generationDatabasePath = value.server.store.currentGeneration().database_path;
      const pointerBefore = await readFile(coordinatorRuntimePaths(value.env).currentStorePointerPath);
      await value.server.close();
      const shadowId = 'migration-worktree-removed-shadow';
      const shadow = { ...canonical, worktree_id: shadowId, state: 'terminal', version: 1 };
      const fixed = new DatabaseSync(coordinatorRuntimePaths(value.env).databasePath);
      try {
        assert.throws(() => fixed.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(shadow.worktree_id, shadow.owner.repo_id, shadow.owner.workstream_run, JSON.stringify(shadow), shadow.version), /cf50 fixed store retired by S1 generation publication/u);
      } finally { fixed.close(); }
      const database = new DatabaseSync(generationDatabasePath);
      try {
        database.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(shadow.worktree_id, shadow.owner.repo_id, shadow.owner.workstream_run, JSON.stringify(shadow), shadow.version);
      } finally { database.close(); }
      await assert.rejects(() => startCoordinatorServer(coordinatorRuntimePaths(value.env)), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'store-corrupt' && error.evidence.includes(shadowId));
      assert.deepEqual(await readFile(coordinatorRuntimePaths(value.env).currentStorePointerPath), pointerBefore);
      assert.equal(existsSync(canonical.canonical_path), false);
      assert.equal(git(value.repo, ['branch', '--list', canonical.branch]), '');
    } finally {
      await value.server.close().catch(() => undefined);
      await rm(value.root, { recursive: true, force: true });
    }
  });


  void it('serializes concurrent stale-lock reclaimers before the external effect', async () => {
    const value = await setup('o');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-stale-lock');
      const prepared = await saga.prepare(create);
      const lockRoot = join(value.stateRoot, 'worktrees', value.active.repo_key, '.locks');
      await mkdir(lockRoot, { recursive: true });
      await writeFile(join(lockRoot, `${prepared.worktree.worktree_id}.saga.lock`), `${JSON.stringify({ schema_version: 'autopilot.saga_execution_lock.v1', pid: 99999999, boot_id: 'foreign-dead-boot', token: 'dead-token' })}\n`, 'utf8');
      const [left, right] = await Promise.all([
        recoverOwnedWorktreeSagas({ active: value.active, env: value.env }),
        recoverOwnedWorktreeSagas({ active: value.active, env: value.env }),
      ]);
      assert.equal([...left, ...right].some((operation) => operation.owner.unit_id === 'unit-stale-lock' && operation.stage === 'committed'), true);
      assert.equal(git(value.repo, ['branch', '--list', create.intent.branch]).split('\n').filter((line) => line.includes(create.intent.branch)).length, 1);
      assert.equal(existsSync(create.intent.worktree_path), true);
    } finally {
      await close(value);
    }
  });


  void it('autonomously finishes real unit-create metadata after a partial Git effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-unit-create-metadata-'));
    const stateRoot = join(root, 'state');
    const source = join(root, 'source');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    let server: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      await mkdir(join(source, 'src'), { recursive: true });
      await writeFile(join(source, 'src', 'base.ts'), 'export const base = true;\n', 'utf8');
      git(source, ['init']);
      git(source, ['config', 'user.email', 'autopilot@example.invalid']);
      git(source, ['config', 'user.name', 'Autopilot Test']);
      git(source, ['add', '.']);
      git(source, ['commit', '-m', 'baseline']);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'metadata-recovery', sourceCwd: source, env });
      server = await startCoordinatorServer(coordinatorRuntimePaths(env));
      const attachment = await new DurableRunSupervisorClient(env).attach({ repo: resolveRepoIdentity(source), active: prepared.active, rawSessionId: 'metadata-recovery-session' });
      const managedEnv = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
      const unitId = 'unit-metadata';
      const attempt = 1;
      const unitPath = join(prepared.taskRoot, 'units', unitId, 'attempt-1', 'worktree');
      const branch = `autopilot/unit/${prepared.active.workstream_run}/${unitId}/attempt-1`;
      const ownerSaga = await OwnedWorktreeSagaClient.fromEnvironment(managedEnv);
      await ownerSaga.prepare({
        active: prepared.active, unitId, attempt, kind: 'unit', operationType: 'create', initialWorktreeState: 'planned', committedWorktreeState: 'active',
        intent: { repo_root: prepared.active.source_repo, worktree_path: unitPath, git_common_dir: prepared.active.git_common_dir, branch, reason: 'real partial unit create metadata witness', base_sha: prepared.active.target_base_sha, target_sha: null, archive_ref: null, checkout_mode: 'claim-minimal', sparse_patterns: ['/src/base.ts'], paths: ['src/future.ts'], metadata_refs: [`units/${unitId}/attempt-1/_unit-info.json`, '_unit-index.json', '_branches.json'] },
      });
      await mkdir(join(unitPath, '..'), { recursive: true });
      git(source, ['worktree', 'add', '--no-checkout', '-b', branch, unitPath, prepared.active.target_base_sha]);
      const recovered = await recoverAutopilotWorktreeSagas({ active: prepared.active, env: managedEnv });
      assert.equal(recovered.some((operation) => operation.owner.unit_id === unitId && operation.stage === 'committed'), true);
      assert.equal(existsSync(join(prepared.taskRoot, 'units', unitId, 'attempt-1', '_unit-info.json')), true);
      assert.equal(existsSync(join(prepared.taskRoot, '_unit-index.json')), true);
      assert.equal(existsSync(join(prepared.taskRoot, '_branches.json')), true);
      assert.equal(existsSync(join(unitPath, 'src')), true);
      assert.equal(git(unitPath, ['config', '--bool', 'core.sparseCheckout']), 'true');
    } finally {
      if (server !== null) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

});
