import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { assertMetadataReconcileEvidence, AUTOPILOT_METADATA_RECONCILE_EVIDENCE_SCHEMA, AUTOPILOT_METADATA_RECONCILE_INTENT_SCHEMA, parseMetadataReconcileIntent, type MetadataReconcileEvidence, type MetadataReconcileIntent } from '../../src/core/coordination/metadata-reconcile.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { AUTOPILOT_WORKTREE_ALIAS_SCHEMA, deterministicWorktreeId, parseWorktreeAlias, WorktreeAliasRegistry, type WorktreeAlias } from '../../src/core/coordination/worktree-identity.ts';
import { deriveWorktreeOperationKeyV2, operationIdFromWorktreeOperationKey } from '../../src/core/coordination/worktree-operation-identity.ts';

const digest = `sha256:${'a'.repeat(64)}` as const;

function alias(overrides: Partial<WorktreeAlias> = {}): WorktreeAlias {
  const owner = { repo_id: 'repo-1', autopilot_id: 'autopilot-a', workstream_run: 'run-a', unit_id: 'unit-a', attempt: 1 };
  return {
    schema_version: AUTOPILOT_WORKTREE_ALIAS_SCHEMA,
    alias_worktree_id: 'migration-worktree-history-a',
    canonical_worktree_id: deterministicWorktreeId(owner, 'unit'),
    ...owner,
    kind: 'unit',
    resolution_state: 'resolved',
    reason: 'legacy-migration-id',
    evidence_sha256: digest,
    created_event_seq: 7,
    ...overrides,
  };
}

function metadataIntent(): MetadataReconcileIntent {
  return {
    schema_version: AUTOPILOT_METADATA_RECONCILE_INTENT_SCHEMA,
    repo_id: 'repo-1',
    canonical_worktree_id: 'worktree-f7553ec87b54bdd344687ab6e638dbd0',
    git_common_dir: '/tmp/repository/.git',
    target_registration_path: '/tmp/worktrees/missing',
    approved_before_registrations: [
      { worktree_path: '/tmp/worktrees/missing', head_sha: 'a'.repeat(40), branch_ref: 'refs/heads/autopilot/unit/run-a/unit-a/attempt-1', prunable: true },
      { worktree_path: '/tmp/worktrees/retained', head_sha: 'b'.repeat(40), branch_ref: 'refs/heads/autopilot/run-b', prunable: false },
    ],
    approved_prunable_registration_paths: ['/tmp/worktrees/missing'],
    expected_after_registrations: [
      { worktree_path: '/tmp/worktrees/retained', head_sha: 'b'.repeat(40), branch_ref: 'refs/heads/autopilot/run-b', prunable: false },
    ],
    preserved_refs: [
      { ref: 'refs/heads/autopilot/archive/run-a/unit-a', sha: 'c'.repeat(40) },
      { ref: 'refs/heads/autopilot/unit/run-a/unit-a/attempt-1', sha: 'a'.repeat(40) },
    ],
    recovery_evidence_sha256: digest,
  };
}

void describe('S1 canonical worktree identity seam', () => {
  void it('matches exact NUL-delimited canonical-ID vectors and field ordering', () => {
    assert.equal(deterministicWorktreeId({ repo_id: 'repo-1', autopilot_id: 'autopilot-a', workstream_run: 'run-a', unit_id: 'unit-a', attempt: 1 }, 'unit'), 'worktree-f7553ec87b54bdd344687ab6e638dbd0');
    assert.equal(deterministicWorktreeId({ repo_id: 'repository/α', autopilot_id: 'autopilot-🚀', workstream_run: 'run:2026', unit_id: 'main', attempt: 1 }, 'main'), 'worktree-31098c57bb46aece887ffb56c46757a5');
    assert.equal(deterministicWorktreeId({ repo_id: 'a', autopilot_id: 'b', workstream_run: 'c', unit_id: 'd', attempt: 12 }, 'unit'), 'worktree-d5b1fa2ea682e5c7e81e80990e704f01');
    assert.equal(deterministicWorktreeId({ repo_id: 'a', autopilot_id: 'b', workstream_run: 'c', unit_id: 'd1', attempt: 2 }, 'unit'), 'worktree-1fa3eb35779aeb0486def272ac54d60b');
    assert.notEqual(
      deterministicWorktreeId({ repo_id: 'a', autopilot_id: 'b', workstream_run: 'c', unit_id: 'd', attempt: 12 }, 'unit'),
      deterministicWorktreeId({ repo_id: 'a', autopilot_id: 'b', workstream_run: 'c', unit_id: 'd1', attempt: 2 }, 'unit'),
    );
  });

  void it('resolves immutable aliases one hop and retains pending scope', () => {
    const resolvedAlias = parseWorktreeAlias(alias());
    const pendingAlias = parseWorktreeAlias(alias({ alias_worktree_id: 'migration-worktree-history-b', resolution_state: 'identity-recovery-pending', reason: 'duplicate-semantic-projection', created_event_seq: 8 }));
    const registry = new WorktreeAliasRegistry([resolvedAlias, pendingAlias]);
    assert.deepEqual(registry.resolve('migration-worktree-history-a'), {
      requested_worktree_id: 'migration-worktree-history-a',
      canonical_worktree_id: resolvedAlias.canonical_worktree_id,
      resolution_state: 'resolved',
      alias: resolvedAlias,
    });
    assert.equal(registry.resolve('migration-worktree-history-b').resolution_state, 'identity-recovery-pending');
    assert.equal(registry.resolve(resolvedAlias.canonical_worktree_id).resolution_state, 'canonical');
    assert.throws(() => registry.resolve('unknown-migration-worktree'), CoordinationRuntimeError);
  });

  void it('rejects alias repointing, duplicate identities, chains, and tuple drift', () => {
    assert.throws(() => parseWorktreeAlias(alias({ canonical_worktree_id: 'worktree-00000000000000000000000000000000' })), /not the deterministic ID/u);
    assert.throws(() => new WorktreeAliasRegistry([alias(), alias()]), /duplicate alias identity/u);
    assert.throws(() => parseWorktreeAlias(alias({ alias_worktree_id: alias().canonical_worktree_id })), /non-canonical historical entity ID/u);
    const registry = new WorktreeAliasRegistry([alias()]);
    assert.throws(() => registry.resolveProjection({ worktree_id: alias().alias_worktree_id, owner: { repo_id: 'repo-1', autopilot_id: 'autopilot-a', workstream_run: 'run-a', unit_id: 'unit-b', attempt: 1 }, kind: 'unit' }), /semantic tuple/u);
  });

  void it('derives operation-key v2 from canonical identity and complete canonical intent', () => {
    const first = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: 'worktree-f7553ec87b54bdd344687ab6e638dbd0', operationType: 'remove', completeImmutableIntent: { z: 1, a: ['x', true] } });
    const reordered = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: 'worktree-f7553ec87b54bdd344687ab6e638dbd0', operationType: 'remove', completeImmutableIntent: { a: ['x', true], z: 1 } });
    const changed = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: 'worktree-f7553ec87b54bdd344687ab6e638dbd0', operationType: 'remove', completeImmutableIntent: { a: ['x', false], z: 1 } });
    assert.equal(canonicalJson({ z: 1, a: ['x', true] }), '{"a":["x",true],"z":1}');
    assert.equal(first.immutable_intent_sha256, 'sha256:cf1a5a7cdfcf12358289f47f34af0c331456264aed30919b283cf1317adece57');
    assert.equal(first.operation_key_sha256, 'sha256:1f91dc8c9fc75e4737467b042bbde1acb92f9ccee6c934f4a36607ad66b0a2d8');
    assert.deepEqual(reordered, first);
    assert.notEqual(changed.operation_key_sha256, first.operation_key_sha256);
    assert.equal(operationIdFromWorktreeOperationKey(first), 'operation-1f91dc8c9fc75e4737467b042bbde1acb92f9ccee6c934f4a36607ad66b0a2d8');
  });

  void it('makes aliases of one semantic tuple converge on one operation identity', () => {
    const registry = new WorktreeAliasRegistry([alias()]);
    const fromAlias = registry.resolve(alias().alias_worktree_id).canonical_worktree_id;
    const fromCanonical = registry.resolve(alias().canonical_worktree_id).canonical_worktree_id;
    assert.equal(
      deriveWorktreeOperationKeyV2({ canonicalWorktreeId: fromAlias, operationType: 'metadata-reconcile', completeImmutableIntent: metadataIntent() }).operation_key_sha256,
      deriveWorktreeOperationKeyV2({ canonicalWorktreeId: fromCanonical, operationType: 'metadata-reconcile', completeImmutableIntent: metadataIntent() }).operation_key_sha256,
    );
  });

  void it('requires complete exact metadata-reconcile sets and unchanged refs', () => {
    const intent = parseMetadataReconcileIntent(metadataIntent());
    const evidence: MetadataReconcileEvidence = {
      schema_version: AUTOPILOT_METADATA_RECONCILE_EVIDENCE_SCHEMA,
      canonical_worktree_id: intent.canonical_worktree_id,
      operation_key_sha256: deriveWorktreeOperationKeyV2({ canonicalWorktreeId: intent.canonical_worktree_id, operationType: 'metadata-reconcile', completeImmutableIntent: intent }).operation_key_sha256,
      observed_before_registrations: intent.approved_before_registrations,
      approved_prunable_registration_paths: intent.approved_prunable_registration_paths,
      observed_after_registrations: intent.expected_after_registrations,
      preserved_refs_before: intent.preserved_refs,
      preserved_refs_after: intent.preserved_refs,
    };
    assert.doesNotThrow(() => assertMetadataReconcileEvidence(intent, evidence));
    assert.throws(() => parseMetadataReconcileIntent({ ...intent, approved_prunable_registration_paths: [] }), /complete pre-reconcile prunable set/u);
    assert.throws(() => parseMetadataReconcileIntent({ ...intent, expected_after_registrations: intent.approved_before_registrations }), /before-minus-approved/u);
    assert.throws(() => assertMetadataReconcileEvidence(intent, { ...evidence, preserved_refs_after: [] }), /non-destructive/u);
  });
});
