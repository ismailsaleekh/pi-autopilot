// Sharded from tests/unit/worktree-saga-recovery.test.ts (Phase 40 / D70 change C4).
// Test bodies are byte-identical to the originals; only the file boundary and
// the shared-helper import changed. Same describe name preserves test identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationWorktreeOperation } from '../../src/core/coordination/contracts.ts';
import { CoordinationRuntimeError, formatCoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { readCurrentStoreGeneration } from '../../src/core/coordination/store-generation.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { executeOwnedWorktreeSaga, OwnedWorktreeSagaClient, recoverOwnedWorktreeSagas } from '../../src/core/coordination/worktree-saga.ts';
import { deriveWorktreeOperationKeyV2, operationIdFromWorktreeOperationKey } from '../../src/core/coordination/worktree-operation-identity.ts';
import { git, setup, close, unitCreateSpec } from '../helpers/worktree-saga-harness.ts';

void describe('owner-scoped worktree and Git saga recovery', () => {
  void it('recovers prepared and post-action create crash boundaries idempotently', async () => {
    const value = await setup('a');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const spec = unitCreateSpec(value);
      const prepared = await saga.prepare(spec);
      assert.equal(prepared.operation.stage, 'prepared');
      const expectedKey = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: prepared.worktree.worktree_id, operationType: spec.operationType, completeImmutableIntent: spec.intent });
      assert.equal(prepared.operation.operation_id, operationIdFromWorktreeOperationKey(expectedKey));
      const exactReplay = await saga.prepare(spec);
      assert.equal(exactReplay.replayed, true);
      assert.equal(exactReplay.operation.operation_id, prepared.operation.operation_id);
      const recoveredPrepared = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recoveredPrepared.length, 1);
      assert.equal(recoveredPrepared[0]?.stage, 'committed');
      assert.equal(existsSync(spec.intent.worktree_path), true);
      assert.equal(git(spec.intent.worktree_path, ['rev-parse', '--abbrev-ref', 'HEAD']), spec.intent.branch);

      const unitB = unitCreateSpec(value, 'unit-b');
      await saga.prepare(unitB);
      await mkdir(join(unitB.intent.worktree_path, '..'), { recursive: true });
      git(value.repo, ['worktree', 'add', '-b', unitB.intent.branch, unitB.intent.worktree_path, unitB.intent.base_sha ?? 'HEAD']);
      const recoveredPostAction = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recoveredPostAction.some((entry) => entry.operation_type === 'create' && entry.owner.unit_id === 'unit-b' && entry.stage === 'committed'), true);
      assert.equal(git(unitB.intent.worktree_path, ['rev-parse', 'HEAD']), value.active.target_base_sha);

      const unitC = unitCreateSpec(value, 'unit-c');
      await saga.prepare(unitC);
      git(value.repo, ['branch', unitC.intent.branch, value.active.target_base_sha]);
      const recoveredBranchOnly = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recoveredBranchOnly.some((entry) => entry.owner.unit_id === 'unit-c' && entry.stage === 'committed'), true);
      assert.equal(existsSync(unitC.intent.worktree_path), true);
      const intendedTerminal = git(unitC.intent.worktree_path, ['rev-parse', 'HEAD']);
      const removeMovedBranch = { ...unitC, operationType: 'remove' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const, intent: { ...unitC.intent, reason: 'branch movement fence witness', target_sha: intendedTerminal } };
      await saga.prepare(removeMovedBranch);
      await writeFile(join(unitC.intent.worktree_path, 'src', 'late.ts'), 'late change\n', 'utf8');
      git(unitC.intent.worktree_path, ['add', 'src/late.ts']);
      git(unitC.intent.worktree_path, ['commit', '-m', 'foreign late branch movement']);
      const movedHead = git(unitC.intent.worktree_path, ['rev-parse', 'HEAD']);
      await assert.rejects(
        () => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }),
        (error: unknown) => error instanceof CoordinationRuntimeError
          && error.code === 'recovery-required'
          && error.evidence.some((entry) => entry.includes(intendedTerminal))
          && error.evidence.some((entry) => entry.includes(movedHead)),
      );
      assert.equal(existsSync(unitC.intent.worktree_path), true);
      assert.equal(git(unitC.intent.worktree_path, ['rev-parse', 'HEAD']), movedHead);
    } finally {
      await close(value);
    }
  });


  void it('rejects caller-invented operation IDs while preserving existing historical resume IDs', async () => {
    const value = await setup('opid');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const spec = { ...unitCreateSpec(value, 'unit-operation-id'), operationId: 'operation-caller-invented' };
      await assert.rejects(() => saga.prepare(spec), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-request' && error.message.includes('existing historical operation'));
      const reservedMainUnit = unitCreateSpec(value, 'main');
      await assert.rejects(() => saga.prepare(reservedMainUnit), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-request' && error.message.includes('reserves unit ID main'));
      assert.equal((await saga.operations()).some((operation) => operation.operation_id === spec.operationId), false);
      assert.equal(existsSync(spec.intent.worktree_path), false);
      assert.equal(existsSync(reservedMainUnit.intent.worktree_path), false);
    } finally {
      await close(value);
    }
  });


  void it('replays an immutable historical alias operation through its schema-13 canonical index', async () => {
    const value = await setup('alias');
    let restarted: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const create = unitCreateSpec(value, 'unit-historical-alias');
      let actions = 0;
      const committed = await executeOwnedWorktreeSaga(create, {
        action: () => { actions += 1; git(value.repo, ['worktree', 'add', '-b', create.intent.branch, create.intent.worktree_path, value.active.target_base_sha]); },
      }, value.env);
      if (committed.operation === null || committed.operation.verification_evidence === null || committed.worktree === null) throw new Error('canonical alias fixture operation did not commit immutable evidence');
      const operationId = committed.operation.operation_id;
      const canonicalWorktreeId = committed.operation.worktree_id;
      const aliasWorktreeId = 'migration-worktree-historical-alias';
      await value.server.close();
      const currentGeneration = readCurrentStoreGeneration(coordinatorRuntimePaths(value.env));
      if (currentGeneration === null) throw new Error('schema-13 alias fixture generation is missing');
      const database = new DatabaseSync(currentGeneration.database_path);
      try {
        const row = database.prepare('SELECT payload_json FROM worktree_operations WHERE entity_id=?').get(operationId);
        const payloadText = row?.['payload_json'];
        if (typeof payloadText !== 'string') throw new Error('schema-13 alias fixture operation payload is missing');
        const historical = { ...parseCoordinationWorktreeOperation(JSON.parse(payloadText) as unknown), worktree_id: aliasWorktreeId };
        if (historical.verification_evidence === null) throw new Error('historical alias fixture operation evidence is missing');
        const aliasWorktree = { ...committed.worktree, worktree_id: aliasWorktreeId };
        database.prepare('INSERT INTO worktrees(entity_id,repo_id,workstream_run,payload_json,version,canonical_worktree_id,autopilot_id,unit_id,attempt,kind,is_current_canonical) VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(
          aliasWorktreeId, aliasWorktree.owner.repo_id, aliasWorktree.owner.workstream_run, JSON.stringify(aliasWorktree), aliasWorktree.version, canonicalWorktreeId, aliasWorktree.owner.autopilot_id, aliasWorktree.owner.unit_id, aliasWorktree.owner.attempt, aliasWorktree.kind,
        );
        database.prepare('UPDATE worktree_operations SET payload_json=? WHERE entity_id=?').run(JSON.stringify(historical), operationId);
        database.prepare('INSERT INTO worktree_aliases(alias_worktree_id,canonical_worktree_id,repo_id,autopilot_id,workstream_run,unit_id,attempt,kind,resolution_state,reason,evidence_sha256,created_event_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
          aliasWorktreeId, canonicalWorktreeId, historical.owner.repo_id, historical.owner.autopilot_id, historical.owner.workstream_run, historical.owner.unit_id, historical.owner.attempt, 'unit', 'resolved', 'legacy-migration-id', historical.verification_evidence.sha256, historical.intent_event_seq,
        );
      } finally { database.close(); }
      restarted = await startCoordinatorServer(coordinatorRuntimePaths(value.env));

      const replay = await executeOwnedWorktreeSaga({ ...create, operationId }, { action: () => { actions += 1; } }, value.env);
      assert.equal(replay.operation?.operation_id, operationId);
      assert.equal(replay.operation?.worktree_id, aliasWorktreeId);
      assert.equal(replay.replayed, true);
      assert.equal(actions, 1);
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), value.active.target_base_sha);

      await restarted.close();
      restarted = null;
      const inspect = new DatabaseSync(currentGeneration.database_path, { readOnly: true });
      try {
        const row = inspect.prepare('SELECT payload_json,canonical_worktree_id FROM worktree_operations WHERE entity_id=?').get(operationId);
        const payloadText = row?.['payload_json'];
        if (typeof payloadText !== 'string') throw new Error('historical alias payload disappeared after replay');
        const historical = parseCoordinationWorktreeOperation(JSON.parse(payloadText) as unknown);
        assert.equal(historical.worktree_id, aliasWorktreeId);
        assert.equal(row?.['canonical_worktree_id'], canonicalWorktreeId);
      } finally { inspect.close(); }
    } finally {
      if (restarted !== null) await restarted.close();
      await value.server.close().catch(() => undefined);
      await rm(value.root, { recursive: true, force: true });
    }
  });


  void it('recovers a nonterminal historical alias operation and replays it without minting a v2 duplicate', async () => {
    const value = await setup('alias-recovery');
    let restarted: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-historical-alias-recovery');
      const prepared = await saga.prepare(create);
      const canonicalWorktreeId = prepared.worktree.worktree_id;
      const aliasWorktreeId = 'migration-worktree-historical-alias-recovery';
      const historicalOperationId = 'operation-historical-alias-recovery';
      await value.server.close();
      const currentGeneration = readCurrentStoreGeneration(coordinatorRuntimePaths(value.env));
      if (currentGeneration === null) throw new Error('historical alias recovery generation is missing');
      const database = new DatabaseSync(currentGeneration.database_path);
      try {
        const historicalOperation = { ...prepared.operation, operation_id: historicalOperationId, worktree_id: aliasWorktreeId };
        const aliasWorktree = { ...prepared.worktree, worktree_id: aliasWorktreeId };
        const aliasEvidenceSha = `sha256:${createHash('sha256').update(JSON.stringify(historicalOperation), 'utf8').digest('hex')}`;
        database.prepare('UPDATE worktree_operations SET entity_id=?,payload_json=? WHERE entity_id=?').run(historicalOperationId, JSON.stringify(historicalOperation), prepared.operation.operation_id);
        database.prepare('INSERT INTO worktrees(entity_id,repo_id,workstream_run,payload_json,version,canonical_worktree_id,autopilot_id,unit_id,attempt,kind,is_current_canonical) VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(
          aliasWorktreeId, aliasWorktree.owner.repo_id, aliasWorktree.owner.workstream_run, JSON.stringify(aliasWorktree), aliasWorktree.version, canonicalWorktreeId, aliasWorktree.owner.autopilot_id, aliasWorktree.owner.unit_id, aliasWorktree.owner.attempt, aliasWorktree.kind,
        );
        database.prepare('INSERT INTO worktree_aliases(alias_worktree_id,canonical_worktree_id,repo_id,autopilot_id,workstream_run,unit_id,attempt,kind,resolution_state,reason,evidence_sha256,created_event_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
          aliasWorktreeId, canonicalWorktreeId, historicalOperation.owner.repo_id, historicalOperation.owner.autopilot_id, historicalOperation.owner.workstream_run, historicalOperation.owner.unit_id, historicalOperation.owner.attempt, 'unit', 'resolved', 'legacy-migration-id', aliasEvidenceSha, historicalOperation.intent_event_seq,
        );
      } finally { database.close(); }
      restarted = await startCoordinatorServer(coordinatorRuntimePaths(value.env));

      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const historical = recovered.find((operation) => operation.operation_id === historicalOperationId);
      assert.equal(historical?.stage, 'committed');
      assert.equal(historical?.worktree_id, aliasWorktreeId, 'immutable historical operation ID must remain raw');
      assert.equal(existsSync(create.intent.worktree_path), true);
      let duplicateActions = 0;
      const replay = await executeOwnedWorktreeSaga(create, { action: () => { duplicateActions += 1; } }, value.env);
      assert.equal(replay.replayed, true);
      assert.equal(replay.operation?.operation_id, historicalOperationId);
      assert.equal(duplicateActions, 0, 'implicit canonical replay must not execute a duplicate external effect');
      const matching = (await saga.operations()).filter((operation) => operation.owner.unit_id === create.unitId && operation.operation_type === 'create' && JSON.stringify(operation.intent) === JSON.stringify(create.intent));
      assert.deepEqual(matching.map((operation) => operation.operation_id), [historicalOperationId]);
    } finally {
      if (restarted !== null) await restarted.close();
      await value.server.close().catch(() => undefined);
      await rm(value.root, { recursive: true, force: true });
    }
  });


  void it('preserves bounded typed preflight and reconciling evidence without executing an unsafe action', async () => {
    let rejectReconcilingReport = true;
    const value = await setup('x', {
      afterStoreCommitBeforeResponse: (action) => {
        if (rejectReconcilingReport && action === 'transition-operation') {
          rejectReconcilingReport = false;
          throw new CoordinationRuntimeError('coordinator-unavailable', 'synthetic durable report response loss', ['transition_marker=reconciling-committed']);
        }
      },
    });
    try {
      const spec = unitCreateSpec(value, 'unit-unsafe-probe');
      let actionCount = 0;
      git(value.repo, ['worktree', 'add', '-b', 'foreign/unit-unsafe-probe', spec.intent.worktree_path, spec.intent.base_sha ?? 'HEAD']);
      let observed: CoordinationRuntimeError | null = null;
      try {
        await executeOwnedWorktreeSaga(spec, {
          action: () => { actionCount += 1; },
        }, value.env);
      } catch (error) {
        if (!(error instanceof CoordinationRuntimeError)) throw error;
        observed = error;
      }
      if (observed === null) throw new Error('unsafe preflight did not fail');
      assert.equal(observed.code, 'recovery-required');
      assert.equal(actionCount, 0);
      assert.equal(observed.evidence.includes('cause_code=recovery-required'), true);
      assert.equal(observed.evidence.some((entry) => entry.includes('actual_registration_branch=refs/heads/foreign/unit-unsafe-probe')), true);
      assert.equal(observed.evidence.some((entry) => entry.includes('expected_registration_branch=refs/heads/autopilot/unit/')), true);
      const visibleDiagnostic = formatCoordinationRuntimeError(observed);
      assert.match(visibleDiagnostic, /actual_registration_branch=refs\/heads\/foreign\/unit-unsafe-probe/u);
      assert.equal(observed.evidence.includes('reconciliation_code=coordinator-unavailable'), true);
      assert.equal(observed.evidence.includes('reconciliation_evidence[0]=failure_class=retryable-contention'), true);
      assert.equal(observed.evidence.includes('reconciliation_evidence[1]=server_evidence[0]=transition_marker=reconciling-committed'), true);
      assert.equal(observed.evidence.length <= 32, true);
      assert.equal(observed.evidence.every((entry) => [...entry].length <= 256), true);

      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const operation = (await saga.operations()).find((candidate) => candidate.owner.unit_id === 'unit-unsafe-probe');
      assert.equal(operation?.stage, 'reconciling');
      const status = await new CoordinatorClient({ env: value.env, autoStart: false }).query('status', value.active.repo_key, value.active.workstream_run);
      const sessions = status.payload['session_leases'];
      assert.equal(Array.isArray(sessions) && sessions.some((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['session_lease_id'] === value.session.session_lease_id && (entry as Record<string, unknown>)['status'] === 'attached'), true);

      let replayed: CoordinationRuntimeError | null = null;
      try {
        await executeOwnedWorktreeSaga(spec, {
          action: () => { actionCount += 1; },
        }, value.env);
      } catch (error) {
        if (!(error instanceof CoordinationRuntimeError)) throw error;
        replayed = error;
      }
      if (replayed === null) throw new Error('unsafe replay preflight did not fail');
      assert.equal(replayed.code, 'recovery-required');
      assert.deepEqual(replayed.evidence.filter((entry) => entry.startsWith('cause_evidence[')).slice(0, 3), observed.evidence.filter((entry) => entry.startsWith('cause_evidence[')).slice(0, 3));
      assert.equal(actionCount, 0);
      assert.equal((await saga.operations()).find((candidate) => candidate.owner.unit_id === 'unit-unsafe-probe')?.stage, 'reconciling');
    } finally {
      await close(value);
    }
  });


  void it('commits an already-applied exact effect without repeating the external action', async () => {
    const value = await setup('y');
    try {
      const spec = unitCreateSpec(value, 'unit-applied-effect');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      await saga.prepare(spec);
      git(value.repo, ['worktree', 'add', '-b', spec.intent.branch, spec.intent.worktree_path, spec.intent.base_sha ?? 'HEAD']);
      let actionCount = 0;
      const result = await executeOwnedWorktreeSaga(spec, {
        action: () => { actionCount += 1; },
      }, value.env);
      assert.equal(actionCount, 0);
      assert.equal(result.operation?.stage, 'committed');
    } finally {
      await close(value);
    }
  });


  void it('rejects operation-evidence symlink substitution and resumes without repeating the applied effect', async () => {
    const value = await setup('evidence-link');
    try {
      const spec = unitCreateSpec(value, 'unit-evidence-link');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const prepared = await saga.prepare(spec);
      const evidencePath = join(value.active.worktree_root, '_saga-evidence', value.active.workstream_run, `${prepared.operation.operation_id}.json`);
      const external = join(value.root, 'external-evidence.json');
      await writeFile(external, 'external bytes must survive\n', 'utf8');
      await mkdir(dirname(evidencePath), { recursive: true });
      await symlink(external, evidencePath);
      let actions = 0;
      const callbacks = { action: () => { actions += 1; git(value.repo, ['worktree', 'add', '-b', spec.intent.branch, spec.intent.worktree_path, value.active.target_base_sha]); } };
      await assert.rejects(
        () => executeOwnedWorktreeSaga(spec, callbacks, value.env),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required' && error.message.includes('symlink substitution'),
      );
      assert.equal(await readFile(external, 'utf8'), 'external bytes must survive\n');
      assert.equal(actions, 1);
      await rm(evidencePath);
      const recovered = await executeOwnedWorktreeSaga(spec, callbacks, value.env);
      assert.equal(recovered.operation?.stage, 'committed');
      assert.equal(actions, 1);
      assert.equal(git(spec.intent.worktree_path, ['rev-parse', 'HEAD']), value.active.target_base_sha);
    } finally {
      await close(value);
    }
  });

});
