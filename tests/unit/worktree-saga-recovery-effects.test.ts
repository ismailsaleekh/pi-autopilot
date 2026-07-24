// Sharded from tests/unit/worktree-saga-recovery.test.ts (Phase 40 / D70 change C4).
// Test bodies are byte-identical to the originals; only the file boundary and
// the shared-helper import changed. Same describe name preserves test identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { RunReconciliationClient } from '../../src/core/coordination/reconciliation.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { currentUnitFailureProducerProvenance } from '../../src/core/coordination/unit-failure-producer-provenance.ts';
import { executeOwnedWorktreeSaga, OwnedWorktreeSagaClient, recoverOwnedWorktreeSagas, WORKTREE_SAGA_BOUNDARIES } from '../../src/core/coordination/worktree-saga.ts';
import { inspectWorktreePostcondition } from '../../src/core/coordination/worktree-postconditions.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import { git, gitInput, setup, close, unitCreateSpec } from '../helpers/worktree-saga-harness.ts';

void describe('owner-scoped worktree and Git saga recovery', () => {
  void it('retains recoverable intent across simulated ENOSPC and permission failures', async () => {
    const value = await setup('p');
    try {
      const create = unitCreateSpec(value, 'unit-io-failure');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      for (const code of ['ENOSPC', 'EACCES', 'EEXIST'] as const) {
        const target = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
        const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/unit-io-failure/attempt-1/${code.toLowerCase()}`;
        const operation = { ...create, operationType: 'archive' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, reason: `${code} recovery witness`, target_sha: target, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [] } };
        let failOnce = true;
        const callbacks = {
          action: () => { if (failOnce) { failOnce = false; throw Object.assign(new Error(`simulated ${code}`), { code }); } git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, target, '0'.repeat(40)]); },
        };
        await assert.rejects(() => executeOwnedWorktreeSaga(operation, callbacks, value.env), new RegExp(`simulated ${code}`, 'u'));
        assert.equal((await saga.operations()).find((entry) => entry.operation_type !== 'metadata-reconcile' && entry.intent.reason === `${code} recovery witness`)?.error_code, code);
        const recovered = await executeOwnedWorktreeSaga(operation, callbacks, value.env);
        assert.equal(recovered.operation?.stage, 'committed');
      }
    } finally {
      await close(value);
    }
  });


  void it('recovers every durable orchestration boundary without duplicating its external effect', async () => {
    const value = await setup('b');
    try {
      const create = unitCreateSpec(value, 'unit-boundaries');
      await new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session).prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      for (const [index, boundary] of WORKTREE_SAGA_BOUNDARIES.entries()) {
        const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/unit-boundaries/attempt-1/boundary-${String(index)}`;
        const target = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
        let effectCount = 0;
        let injected = false;
        const spec = {
          ...create, operationType: 'archive' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
          intent: { ...create.intent, reason: `fault-injection witness at ${boundary}`, target_sha: target, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [] },
        };
        const callbacks = {
          action: () => { effectCount += 1; git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, target, '0'.repeat(40)]); },
          observeBoundary: (current: typeof boundary) => { if (!injected && current === boundary) { injected = true; throw new Error(`injected boundary ${boundary}`); } },
        };
        const expectedPhase = boundary === 'after-prepare' ? 'prepared'
          : boundary === 'before-probe' || boundary === 'after-probe' ? 'preflight-probe'
            : boundary === 'after-start' ? 'start-report'
              : boundary === 'before-action' || boundary === 'after-action' ? 'external-action'
                : boundary === 'after-action-report' ? 'action-report'
                  : boundary === 'before-verification' || boundary === 'after-verification' ? 'postcondition-verification'
                    : boundary === 'after-evidence' ? 'evidence-write'
                      : boundary === 'after-verified-commit' ? 'verified-report'
                        : 'commit-report';
        await assert.rejects(() => executeOwnedWorktreeSaga(spec, callbacks, value.env), (error: unknown) => error instanceof CoordinationRuntimeError && error.message.includes(`injected boundary ${boundary}`) && error.evidence.includes(`phase=${expectedPhase}`));
        const recovered = await executeOwnedWorktreeSaga(spec, { action: callbacks.action }, value.env);
        assert.equal(recovered.operation?.stage, 'committed');
        assert.equal(effectCount <= 1, true, `${boundary} repeated its external effect`);
      }
    } finally {
      await close(value);
    }
  });


  void it('terminalizes sanitized I2 operation-5df1 branch-proof capture 8725cf1, releases exactly 42 WRITE leases, and performs no second commit', async () => {
    const value = await setup('i2');
    try {
      const client = new CoordinatorClient({ env: value.env, autoStart: false });
      const claims = new ClaimNegotiationClient(client, value.session);
      const capturedPaths = Array.from({ length: 42 }, (_entry, index) => `src/i2-captured-${String(index).padStart(2, '0')}.ts`);
      const acquired = await claims.acquire({
        acquisitionGroupId: 'group-i2-42-write', unitId: 'FOUND-APP-IMPL', attempt: 1,
        requestedLeases: capturedPaths.map((path) => ({ path, mode: 'WRITE' as const, purpose: 'sanitized historical I2 retained authority' })),
        reason: 'sanitized historical I2 42-WRITE authority shape', normalReleaseCondition: { condition_type: 'quarantine-captured', target_id: 'FOUND-APP-IMPL:1', evidence: null },
        specRef: '.pi/autopilot/work-i2/unit-specs/FOUND-APP-IMPL.json', specSha256: `sha256:${'a'.repeat(64)}`, role: 'implement', preemptible: true, checkpointOrdinal: 0,
      });
      assert.equal(acquired.outcome, 'granted');
      if (acquired.outcome !== 'granted') throw new Error('I2 retained authority was not granted');
      const unrelated = await claims.acquire({
        acquisitionGroupId: 'group-i2-unrelated', unitId: 'UNRELATED', attempt: 1,
        requestedLeases: [{ path: 'src/unrelated.ts', mode: 'WRITE', purpose: 'must survive I2 exact release' }],
        reason: 'unrelated authority isolation witness', normalReleaseCondition: { condition_type: 'quarantine-captured', target_id: 'UNRELATED:1', evidence: null },
        specRef: '.pi/autopilot/work-i2/unit-specs/UNRELATED.json', specSha256: `sha256:${'b'.repeat(64)}`, role: 'implement', preemptible: true, checkpointOrdinal: 0,
      });
      assert.equal(unrelated.outcome, 'granted');
      if (unrelated.outcome !== 'granted') throw new Error('unrelated authority was not granted');

      const create = unitCreateSpec(value, 'FOUND-APP-IMPL');
      const saga = new OwnedWorktreeSagaClient(client, value.session);
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      for (const [index, path] of capturedPaths.entries()) await writeFile(join(create.intent.worktree_path, path), `export const captured${String(index)} = true;\n`, 'utf8');
      const quarantine = {
        ...create,
        operationType: 'quarantine' as const,
        initialWorktreeState: 'active' as const,
        committedWorktreeState: 'quarantined' as const,
        intent: {
          ...create.intent,
          reason: 'sanitized regression for historical operation-5df1cda32ea1a860e6fe85d8891bb0d2 / capture 8725cf1',
          target_sha: value.active.target_base_sha,
          paths: capturedPaths,
        },
      };
      const prepared = await saga.prepare(quarantine);
      git(create.intent.worktree_path, ['add', '--', ...capturedPaths]);
      git(create.intent.worktree_path, ['commit', '-m', 'sanitized I2 quarantine capture']);
      const capture = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      assert.equal(git(value.repo, ['rev-list', '--count', `${value.active.target_base_sha}..${capture}`]), '1');
      await rm(create.intent.worktree_path, { recursive: true, force: false });

      git(value.repo, ['update-ref', '-d', `refs/heads/${create.intent.branch}`, capture]);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required' && error.message.includes(prepared.operation.operation_id));
      const withheld = (await saga.operations()).find((entry) => entry.operation_id === prepared.operation.operation_id);
      assert.notEqual(withheld?.stage, 'committed', 'proof-withheld control must not terminalize authority');
      git(value.repo, ['update-ref', `refs/heads/${create.intent.branch}`, capture, '0'.repeat(40)]);

      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const operation = recovered.find((entry) => entry.operation_id === prepared.operation.operation_id);
      if (operation === undefined || operation.operation_type !== 'quarantine') throw new Error('I2 recovery did not return the exact quarantine operation');
      assert.equal(operation.stage, 'committed');
      assert.equal(operation.error_code, null);
      assert.equal(existsSync(create.intent.worktree_path), false);
      assert.equal(git(value.repo, ['rev-parse', `refs/heads/${create.intent.branch}`]), capture);
      assert.equal(git(value.repo, ['rev-list', '--count', `${value.active.target_base_sha}..refs/heads/${create.intent.branch}`]), '1');
      if (operation?.verification_evidence === null || operation?.verification_evidence === undefined) throw new Error('I2 recovery evidence missing');
      const evidence: unknown = JSON.parse(await readFile(join(value.active.worktree_root, ...operation.verification_evidence.ref.split('/')), 'utf8'));
      if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) throw new Error('I2 recovery evidence is not an object');
      assert.equal(Reflect.get(evidence, 'capture_sha'), capture);
      assert.equal(Reflect.get(evidence, 'proof_source'), 'owned-git-ref');
      const worktree = (await saga.worktrees()).find((entry) => entry.worktree_id === operation.worktree_id);
      assert.equal(worktree?.state, 'quarantined');

      const captureRef = `autopilot/archive/${value.active.workstream_run}/unit/FOUND-APP-IMPL/attempt-1/quarantine-capture`;
      git(value.repo, ['update-ref', `refs/heads/${captureRef}`, capture, '0'.repeat(40)]);
      const evidenceRef = '.pi/autopilot/work-i2/quarantine/FOUND-APP-IMPL.attempt-1.quarantine.json';
      const failureDocument = {
        schema_version: 'autopilot.unit_failure.v1', ...currentUnitFailureProducerProvenance(), action: 'quarantine', workstream: value.active.workstream, workstream_run: value.active.workstream_run,
        unit_id: 'FOUND-APP-IMPL', attempt: 1, unit_worktree_path: create.intent.worktree_path, dirty_paths: capturedPaths,
        capture_commit_sha: capture, capture_ref: captureRef, git_head_before: value.active.target_base_sha, git_head_after: capture,
        git_common_dir: value.active.git_common_dir, branch: create.intent.branch, postcondition_worktree_clean: true,
        summary: 'sanitized exact I2 absent-worktree authority release witness', created_at: '2026-07-11T00:00:01.000Z',
      };
      const failureBytes = `${JSON.stringify(failureDocument, null, 2)}\n`;
      const failurePath = join(value.active.main_worktree_path, ...evidenceRef.split('/'));
      await mkdir(dirname(failurePath), { recursive: true });
      await writeFile(failurePath, failureBytes, 'utf8');
      const failureSha: `sha256:${string}` = `sha256:${createHash('sha256').update(failureBytes, 'utf8').digest('hex')}`;
      const reconciliation = new RunReconciliationClient(client, value.session);
      const forgedRef = '.pi/autopilot/work-i2/quarantine/FOUND-APP-IMPL.attempt-1.forged-path-set.json';
      const forgedBytes = `${JSON.stringify({ ...failureDocument, dirty_paths: capturedPaths.slice(1) }, null, 2)}\n`;
      const forgedPath = join(value.active.main_worktree_path, ...forgedRef.split('/'));
      await mkdir(dirname(forgedPath), { recursive: true });
      await writeFile(forgedPath, forgedBytes, 'utf8');
      const forgedSha: `sha256:${string}` = `sha256:${createHash('sha256').update(forgedBytes, 'utf8').digest('hex')}`;
      await assert.rejects(
        () => reconciliation.recordReleaseEvidence({ source: 'quarantine-capture', targetId: 'FOUND-APP-IMPL:1', evidenceRef: forgedRef, evidenceSha256: forgedSha }),
        /exactly one matching committed canonical operation/u,
      );
      const afterRejectedRelease = await client.query('status', value.active.repo_key, value.active.workstream_run);
      const retained = afterRejectedRelease.payload['edit_leases'];
      if (!Array.isArray(retained)) throw new Error('I2 rejected-release status edit_leases is not an array');
      assert.equal(retained.length, 43, 'incomplete path proof must release no authority');

      const release = await reconciliation.recordReleaseEvidence({ source: 'quarantine-capture', targetId: 'FOUND-APP-IMPL:1', evidenceRef, evidenceSha256: failureSha });
      assert.deepEqual([...release.reconciliation.released_lease_ids].sort(), acquired.editLeases.map((lease) => lease.edit_lease_id).sort());
      assert.equal(release.reconciliation.released_lease_ids.length, 42);
      const afterRelease = await client.query('status', value.active.repo_key, value.active.workstream_run);
      const remaining = afterRelease.payload['edit_leases'];
      if (!Array.isArray(remaining)) throw new Error('I2 status edit_leases is not an array');
      assert.equal(remaining.length, 1);
      assert.equal(Reflect.get(remaining[0], 'edit_lease_id'), unrelated.editLeases[0]?.edit_lease_id);
      assert.equal(git(value.repo, ['rev-list', '--count', `${value.active.target_base_sha}..refs/heads/${create.intent.branch}`]), '1');

      git(value.repo, ['update-ref', '-d', `refs/heads/${create.intent.branch}`, capture]);
      const archiveOnly = inspectWorktreePostcondition({
        operationType: 'quarantine', owner: operation.owner, kind: 'unit', canonicalWorktreeId: deterministicWorktreeId(operation.owner, 'unit'),
        intent: { ...operation.intent, archive_ref: captureRef }, durableStage: operation.stage,
      });
      assert.equal(archiveOnly.outcome, 'satisfied', archiveOnly.proof.join('\n'));
      assert.equal(archiveOnly.proof_source, 'owned-git-ref');
      assert.equal(archiveOnly.capture_sha, capture);
    } finally {
      await close(value);
    }
  });


  void it('replays materialize, commit, quarantine, archive, and remove effects without duplication', async () => {
    const value = await setup('g');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const full = unitCreateSpec(value, 'unit-g');
      const create = { ...full, intent: { ...full.intent, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/src/base.ts'] } };
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(join(create.intent.worktree_path, 'src', 'base.ts')), true);
      assert.equal(existsSync(join(create.intent.worktree_path, 'docs', 'context.md')), false);

      const materialize = {
        ...create, operationType: 'materialize' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...create.intent, reason: 'materialize docs context', base_sha: null, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/docs/context.md'], paths: ['docs/context.md'] },
      };
      await saga.prepare(materialize);
      gitInput(create.intent.worktree_path, ['sparse-checkout', 'add', '--skip-checks', '--stdin'], '/docs/context.md\n');
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(join(create.intent.worktree_path, 'docs', 'context.md')), true);

      const commitBase = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(create.intent.worktree_path, 'src', 'change.ts'), 'export const changed = true;\n', 'utf8');
      const commit = {
        ...create, operationType: 'commit' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...create.intent, reason: 'commit exact change', base_sha: commitBase, target_sha: null, checkout_mode: null, sparse_patterns: [], paths: ['src/change.ts'] },
      };
      await saga.prepare(commit);
      git(create.intent.worktree_path, ['add', '--sparse', 'src/change.ts']);
      git(create.intent.worktree_path, ['commit', '-m', 'simulated response-loss commit']);
      const committedHead = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(create.intent.worktree_path, ['rev-list', '--count', `${commitBase}..HEAD`]), '1');

      const mainCreate = {
        active: value.active, unitId: 'main', attempt: 1, kind: 'main' as const, operationType: 'create' as const,
        initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
        intent: {
          repo_root: value.repo, worktree_path: value.active.main_worktree_path, git_common_dir: join(value.repo, '.git'), branch: value.active.branch,
          reason: 'create integration main', base_sha: value.active.target_base_sha, target_sha: null, archive_ref: null,
          checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [],
        },
      };
      await saga.prepare(mainCreate);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const integrationBefore = git(value.active.main_worktree_path, ['rev-parse', 'HEAD']);
      const merge = {
        ...mainCreate, operationType: 'merge' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...mainCreate.intent, reason: 'merge committed unit', base_sha: integrationBefore, target_sha: committedHead, checkout_mode: null, paths: ['src/change.ts'] },
      };
      await saga.prepare(merge);
      git(value.active.main_worktree_path, ['merge', '--no-ff', '--no-edit', '-m', 'simulated response-loss merge', committedHead]);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      git(value.active.main_worktree_path, ['merge-base', '--is-ancestor', committedHead, 'HEAD']);
      assert.equal(git(value.active.main_worktree_path, ['rev-list', '--merges', '--count', `${integrationBefore}..HEAD`]), '1');
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(value.active.main_worktree_path, ['rev-list', '--merges', '--count', `${integrationBefore}..HEAD`]), '1');

      await writeFile(join(create.intent.worktree_path, 'src', 'quarantine.ts'), 'preserve me\n', 'utf8');
      const quarantine = {
        ...create, operationType: 'quarantine' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'quarantined' as const,
        intent: { ...create.intent, reason: 'capture dirty work', base_sha: committedHead, target_sha: null, checkout_mode: null, sparse_patterns: [], paths: ['src/quarantine.ts'] },
      };
      await saga.prepare(quarantine);
      git(create.intent.worktree_path, ['add', '--sparse', 'src/quarantine.ts']);
      git(create.intent.worktree_path, ['commit', '-m', 'simulated response-loss quarantine capture']);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const captureHead = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      assert.notEqual(captureHead, committedHead);
      assert.equal(git(create.intent.worktree_path, ['status', '--porcelain']), '');

      const reset = {
        ...create, operationType: 'reset' as const, initialWorktreeState: 'quarantined' as const, committedWorktreeState: 'terminal' as const,
        intent: { ...create.intent, reason: 'verify exact captured reset boundary', base_sha: captureHead, target_sha: captureHead, checkout_mode: null, sparse_patterns: [], paths: [] },
      };
      await saga.prepare(reset);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), captureHead);

      const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/unit-g/attempt-1/capture`;
      const archive = {
        ...create, operationType: 'archive' as const, initialWorktreeState: 'quarantined' as const, committedWorktreeState: 'terminal' as const,
        intent: { ...create.intent, reason: 'archive quarantine capture', base_sha: committedHead, target_sha: captureHead, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: ['src/quarantine.ts'] },
      };
      await saga.prepare(archive);
      git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, captureHead]);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(value.repo, ['rev-parse', `refs/heads/${archiveRef}`]), captureHead);

      const remove = {
        ...create, operationType: 'remove' as const, initialWorktreeState: 'terminal' as const, committedWorktreeState: 'removed' as const,
        intent: { ...create.intent, reason: 'remove archived terminal worktree', base_sha: commitBase, target_sha: captureHead, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [] },
      };
      await saga.prepare(remove);
      git(value.repo, ['worktree', 'remove', create.intent.worktree_path]);
      git(value.repo, ['branch', '-D', create.intent.branch]);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(create.intent.worktree_path), false);
      assert.equal(git(value.repo, ['rev-parse', `refs/heads/${archiveRef}`]), captureHead);
    } finally {
      await close(value);
    }
  });


  void it('refuses to commit a recovered Git effect until bounded immutable metadata is present', async () => {
    const value = await setup('q');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-metadata-gate');
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const base = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(create.intent.worktree_path, 'src', 'gated.ts'), 'gated\n', 'utf8');
      const commit = { ...create, operationType: 'commit' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, reason: 'metadata gate witness', base_sha: base, target_sha: null, checkout_mode: null, paths: ['src/gated.ts'], metadata_refs: ['execution-commits/gated.json'] } };
      await saga.prepare(commit);
      git(create.intent.worktree_path, ['add', 'src/gated.ts']);
      git(create.intent.worktree_path, ['commit', '-m', 'simulated response-loss gated commit']);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /canonical postcondition|metadata postcondition|missing_metadata|partial-effect/u);
      assert.equal(git(create.intent.worktree_path, ['rev-list', '--count', `${base}..HEAD`]), '1');
      assert.notEqual((await saga.operations()).find((operation) => operation.operation_type !== 'metadata-reconcile' && operation.intent.reason === 'metadata gate witness')?.stage, 'committed');
      const taskRoot = dirname(dirname(dirname(dirname(create.intent.worktree_path))));
      await mkdir(join(taskRoot, 'execution-commits'), { recursive: true });
      await writeFile(join(taskRoot, 'execution-commits', 'gated.json'), '{}\n', 'utf8');
      const taskInfoPath = join(taskRoot, '_task-info.json');
      await writeFile(taskInfoPath, `${JSON.stringify({ runtime_root: value.active.runtime_root })}\n`, 'utf8');
      const taskInfoBytes = await readFile(taskInfoPath);
      const externalTaskInfo = join(value.root, 'foreign-task-info.json');
      await writeFile(externalTaskInfo, `${JSON.stringify({ runtime_root: value.active.runtime_root })}\n`, 'utf8');
      await rm(taskInfoPath);
      await symlink(externalTaskInfo, taskInfoPath);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /canonical postcondition|metadata postcondition|unreadable_metadata_root|partial-effect/u);
      assert.equal(git(create.intent.worktree_path, ['rev-list', '--count', `${base}..HEAD`]), '1');
      assert.notEqual((await saga.operations()).find((operation) => operation.operation_type !== 'metadata-reconcile' && operation.intent.reason === 'metadata gate witness')?.stage, 'committed');
      await rm(taskInfoPath);
      const oversizedTaskInfo = new Uint8Array(1_048_577);
      oversizedTaskInfo.fill(0x20);
      await writeFile(taskInfoPath, oversizedTaskInfo);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /canonical postcondition|metadata postcondition|unreadable_metadata_root|partial-effect/u);
      assert.equal(git(create.intent.worktree_path, ['rev-list', '--count', `${base}..HEAD`]), '1');
      assert.notEqual((await saga.operations()).find((operation) => operation.operation_type !== 'metadata-reconcile' && operation.intent.reason === 'metadata gate witness')?.stage, 'committed');
      await writeFile(taskInfoPath, taskInfoBytes);
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.operation_type !== 'metadata-reconcile' && operation.intent.reason === 'metadata gate witness' && operation.stage === 'committed'), true);
      assert.equal(git(create.intent.worktree_path, ['rev-list', '--count', `${base}..HEAD`]), '1');
    } finally {
      await close(value);
    }
  });


  void it('recreates future-owned parents but refuses an unresolved LFS pointer during materialization recovery', async () => {
    const value = await setup('n');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const base = unitCreateSpec(value, 'unit-lfs');
      const create = { ...base, intent: { ...base.intent, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/src/base.ts'] } };
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await saga.prepare({ ...create, operationType: 'materialize', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'LFS recovery refusal witness', base_sha: null, sparse_patterns: ['/docs/pointer.bin', '/src/future/new.ts'], paths: ['docs/pointer.bin', 'src/future/new.ts'] } });
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /postcondition|lfs_pointer|recovery/u);
      assert.equal(existsSync(join(create.intent.worktree_path, 'src', 'future')), true);
      assert.equal(existsSync(join(create.intent.worktree_path, 'docs', 'pointer.bin')), true);
      assert.notEqual((await saga.operations()).find((operation) => operation.operation_type === 'materialize')?.stage, 'committed');
    } finally {
      await close(value);
    }
  });


  void it('refuses stale archive refs and unrelated path substitution without mutating either', async () => {
    const archiveHarness = await setup('h');
    try {
      const create = unitCreateSpec(archiveHarness, 'unit-archive-fence');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: archiveHarness.env, autoStart: false }), archiveHarness.session);
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: archiveHarness.active, env: archiveHarness.env });
      await assert.rejects(() => saga.prepare({ ...create, operationType: 'materialize', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'Git pathspec magic rejection witness', base_sha: null, sparse_patterns: ['/src/base.ts'], paths: [':(top)foreign.ts'] } }), /pathspec magic|invalid-request/u);
      const staleSha = git(archiveHarness.repo, ['rev-parse', 'HEAD']);
      await writeFile(join(archiveHarness.repo, 'foreign.ts'), 'foreign\n', 'utf8');
      git(archiveHarness.repo, ['add', 'foreign.ts']);
      git(archiveHarness.repo, ['commit', '-m', 'foreign target movement']);
      const intendedSha = git(archiveHarness.repo, ['rev-parse', 'HEAD']);
      await assert.rejects(() => saga.prepare({ ...create, operationType: 'archive', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'archive namespace escape witness', base_sha: staleSha, target_sha: intendedSha, archive_ref: git(archiveHarness.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) } }), /run-owned namespace|unauthorized/u);
      const archiveRef = `autopilot/archive/${archiveHarness.active.workstream_run}/stale-proof`;
      git(archiveHarness.repo, ['update-ref', `refs/heads/${archiveRef}`, staleSha]);
      await saga.prepare({ ...create, operationType: 'archive', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'stale archive ref fence witness', base_sha: staleSha, target_sha: intendedSha, archive_ref: archiveRef } });
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: archiveHarness.active, env: archiveHarness.env }), /archive_expected|archive_actual|recovery/u);
      assert.equal(git(archiveHarness.repo, ['rev-parse', `refs/heads/${archiveRef}`]), staleSha);
    } finally {
      await close(archiveHarness);
    }

    const substitutionHarness = await setup('i');
    try {
      const substituted = unitCreateSpec(substitutionHarness, 'unit-substituted');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: substitutionHarness.env, autoStart: false }), substitutionHarness.session);
      await saga.prepare(substituted);
      const substitutedAttemptRoot = join(substituted.intent.worktree_path, '..');
      const outside = join(substitutionHarness.root, 'foreign-directory');
      await mkdir(join(substitutedAttemptRoot, '..'), { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, substitutedAttemptRoot);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: substitutionHarness.active, env: substitutionHarness.env }), /symlink substitution|path_present|git_registered|registered_branch_mismatch|recovery/u);
      assert.equal(existsSync(substitutedAttemptRoot), true);
      assert.equal(existsSync(join(outside, 'worktree')), false);
      assert.equal(git(substitutionHarness.repo, ['rev-parse', 'HEAD']), substitutionHarness.active.target_base_sha);
    } finally {
      await close(substitutionHarness);
    }
  });

});
