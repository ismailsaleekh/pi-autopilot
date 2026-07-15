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
