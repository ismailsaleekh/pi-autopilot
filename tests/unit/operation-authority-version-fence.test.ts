import assert from 'node:assert/strict';
import { it } from 'node:test';

import { checkCoordinationInvariants, parseCoordinationSnapshot } from '../../src/core/coordination/index.ts';
import { validCoordinationSnapshot } from '../helpers/coordination-fixture.ts';

// Issue: doctor reported 15 run-local operation-authority-version-mismatch
// errors. The invariant required worktree.version === operation.authority_version
// (with a single committed+1 allowance), but a worktree that survived multiple
// committed operations has version well past an earlier operation's
// authority_version. The fix fences committed operations monotonically
// (worktree.version >= authority_version) while keeping in-flight operations
// strict (exact match), so a durable worktree that advanced through several
// committed operations no longer flags every earlier committed operation.

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

const VERIFICATION_EVIDENCE = { ref: '_saga-evidence/op.json', sha256: `sha256:${'a'.repeat(64)}` } as const;
const COMPLETED_STEPS = ['preflight-probe', 'external-action', 'postcondition-verification'] as const;

void it('does not flag an earlier committed operation when the worktree version advanced through later committed operations', () => {
  const snapshot = parseCoordinationSnapshot(jsonRoundTrip(validCoordinationSnapshot()));
  const operation = snapshot.worktree_operations[0];
  const worktree = snapshot.worktrees[0];
  if (operation === undefined || worktree === undefined) throw new Error('fixture missing worktree operation');
  // Simulate a second later committed operation that advanced the worktree
  // version past the earlier operation's authority_version, exactly as the
  // production coordinator observed. Pre-fix this produced
  // operation-authority-version-mismatch for the earlier operation.
  const laterOperation = { ...operation, operation_id: 'operation-later', authority_version: operation.authority_version + 3, stage: 'committed' as const, verification_evidence: VERIFICATION_EVIDENCE, completed_steps: [...COMPLETED_STEPS] };
  const committed = {
    ...snapshot,
    worktree_operations: [
      { ...operation, stage: 'committed' as const, verification_evidence: VERIFICATION_EVIDENCE, completed_steps: [...COMPLETED_STEPS] },
      laterOperation,
    ],
    worktrees: snapshot.worktrees.map((entry) => entry.worktree_id === worktree.worktree_id ? { ...entry, version: laterOperation.authority_version + 1 } : entry),
  };
  const findings = checkCoordinationInvariants(parseCoordinationSnapshot(jsonRoundTrip(committed)));
  assert.equal(findings.some((entry) => entry.code === 'operation-authority-version-mismatch'), false, 'a worktree that advanced through later committed operations must not flag the earlier committed operation');
});

void it('still flags a committed operation whose authority_version exceeds the worktree version (forged forward authority)', () => {
  const snapshot = parseCoordinationSnapshot(jsonRoundTrip(validCoordinationSnapshot()));
  const operation = snapshot.worktree_operations[0];
  const worktree = snapshot.worktrees[0];
  if (operation === undefined || worktree === undefined) throw new Error('fixture missing worktree operation');
  const forged = {
    ...snapshot,
    worktree_operations: snapshot.worktree_operations.map((entry) => entry.operation_id === operation.operation_id ? { ...entry, stage: 'committed' as const, authority_version: worktree.version + 5, verification_evidence: VERIFICATION_EVIDENCE, completed_steps: [...COMPLETED_STEPS] } : entry),
  };
  const findings = checkCoordinationInvariants(parseCoordinationSnapshot(jsonRoundTrip(forged)));
  assert.equal(findings.some((entry) => entry.code === 'operation-authority-version-mismatch'), true, 'a committed operation claiming authority ahead of the worktree version must still fail closed');
});

void it('still flags an in-flight (prepared) operation when the worktree version advanced (stale operation)', () => {
  const snapshot = parseCoordinationSnapshot(jsonRoundTrip(validCoordinationSnapshot()));
  const operation = snapshot.worktree_operations[0];
  const worktree = snapshot.worktrees[0];
  if (operation === undefined || worktree === undefined) throw new Error('fixture missing worktree operation');
  const stale = {
    ...snapshot,
    worktrees: snapshot.worktrees.map((entry) => entry.worktree_id === worktree.worktree_id ? { ...entry, version: operation.authority_version + 2 } : entry),
  };
  const findings = checkCoordinationInvariants(parseCoordinationSnapshot(jsonRoundTrip(stale)));
  assert.equal(findings.some((entry) => entry.code === 'operation-authority-version-mismatch'), true, 'a prepared operation whose worktree advanced is stale and must remain flagged for owned reconciliation');
});
