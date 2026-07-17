import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkCoordinationInvariants } from '../../src/core/coordination/invariants.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import { validCoordinationSnapshot } from '../helpers/coordination-fixture.ts';

void describe('cf46 worktree lifecycle regressions', () => {
  void it('derives one stable migration/runtime worktree identity from exact owner and kind', () => {
    const owner = { repo_id: 'repo-migrated-duplicate', autopilot_id: 'autopilot-migrated', workstream_run: 'run-migrated-duplicate', unit_id: 'main', attempt: 1 };
    const first = deterministicWorktreeId(owner, 'main');
    assert.equal(first, deterministicWorktreeId({ ...owner }, 'main'));
    assert.match(first, /^worktree-[a-f0-9]{32}$/u);
    assert.notEqual(first, deterministicWorktreeId({ ...owner, unit_id: 'unit-response-loss' }, 'unit'));
  });

  void it('reports exact active semantic worktree duplicates without weakening identity lookup', () => {
    const snapshot = validCoordinationSnapshot();
    const original = snapshot.worktrees[0];
    if (original === undefined) throw new Error('fixture worktree is missing');
    const duplicate = { ...original, worktree_id: 'migration-worktree-duplicate' };
    const findings = checkCoordinationInvariants({ ...snapshot, worktrees: [original, duplicate] });
    assert.equal(findings.some((finding) => finding.code === 'duplicate-active-worktree-authority'), true);
  });

  void it('treats a committed remove as historical only after a later higher-authority committed recreate', () => {
    const snapshot = validCoordinationSnapshot();
    const worktree = snapshot.worktrees[0];
    const template = snapshot.worktree_operations[0];
    if (worktree === undefined || template === undefined) throw new Error('fixture worktree operation is missing');
    if (template.operation_type === 'metadata-reconcile') throw new Error('ordinary lifecycle fixture unexpectedly uses metadata reconciliation');
    const evidence = { ref: '_saga-evidence/run-a/operation-remove.json', sha256: `sha256:${'a'.repeat(64)}` as const };
    const remove = {
      ...template, operation_id: 'operation-remove', operation_type: 'remove' as const, stage: 'committed' as const,
      authority_version: 1, intent_event_seq: 3, intent: { ...template.intent, reason: 'historical remove', target_sha: 'b'.repeat(40) },
      completed_steps: ['preflight-probe', 'external-action', 'postcondition-verification'], verification_evidence: evidence, version: 5,
    };
    const recreate = {
      ...template, operation_id: 'operation-recreate', operation_type: 'create' as const, stage: 'committed' as const,
      authority_version: 2, intent_event_seq: 4, intent: { ...template.intent, reason: 'later package recreate', base_sha: 'b'.repeat(40), checkout_mode: 'full' as const, sparse_patterns: [], paths: [] },
      completed_steps: ['preflight-probe', 'external-action', 'postcondition-verification'], verification_evidence: { ref: '_saga-evidence/run-a/operation-recreate.json', sha256: `sha256:${'b'.repeat(64)}` as const }, version: 5,
    };
    const superseded = checkCoordinationInvariants({ ...snapshot, worktrees: [{ ...worktree, state: 'active', version: 3 }], worktree_operations: [remove, recreate] });
    assert.equal(superseded.some((finding) => finding.code === 'worktree-remove-state-mismatch'), false);
    const unexplained = checkCoordinationInvariants({ ...snapshot, worktrees: [{ ...worktree, state: 'active', version: 2 }], worktree_operations: [remove] });
    assert.equal(unexplained.some((finding) => finding.code === 'worktree-remove-state-mismatch'), true);
  });

  void it('reports authority and owner drift between near-duplicate projections as corruption', () => {
    const snapshot = validCoordinationSnapshot();
    const original = snapshot.worktrees[0];
    if (original === undefined) throw new Error('fixture worktree is missing');
    const branchDrift = { ...original, worktree_id: 'migration-worktree-drift', branch: `${original.branch}-foreign` };
    const branchFindings = checkCoordinationInvariants({ ...snapshot, worktrees: [original, branchDrift] });
    assert.equal(branchFindings.some((finding) => finding.code === 'conflicting-active-worktree-authority'), true);
    const ownerDrift = { ...original, worktree_id: 'migration-worktree-owner-drift', owner: { ...original.owner, autopilot_id: 'foreign-autopilot' } };
    const ownerFindings = checkCoordinationInvariants({ ...snapshot, worktrees: [original, ownerDrift] });
    assert.equal(ownerFindings.some((finding) => finding.code === 'conflicting-active-worktree-authority'), true);
  });
});
