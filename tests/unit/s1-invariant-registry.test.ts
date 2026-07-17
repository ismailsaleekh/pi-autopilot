import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runS1InvariantDetectors, S1_INVARIANT_REGISTRY, type S1InvariantDetectorHost } from '../../src/core/coordination/invariant-registry.ts';

void describe('S1 executable invariant registry', () => {
  void it('executes every closed detector and declares exactly one repair disposition', () => {
    const calls: string[] = [];
    const host: S1InvariantDetectorHost = {
      detectPhysicalIntegrity: () => calls.push('physical-integrity'),
      detectStoreGeneration: () => calls.push('store-generation'),
      detectWriterGuard: () => calls.push('writer-guard'),
      detectMigrationBoundary: () => calls.push('migration-boundary'),
      detectEventCounterBehind: () => calls.push('event-counter-behind'),
      detectEventCounterAhead: () => calls.push('event-counter-ahead'),
      detectPayloadIndexAmbiguity: () => calls.push('payload-index-ambiguity'),
      detectCanonicalIdentity: () => calls.push('canonical-identity'),
      detectAliasOneHop: () => calls.push('alias-one-hop'),
      detectSemanticUniqueness: () => calls.push('semantic-uniqueness'),
      detectOperationCanonicalIndex: () => calls.push('operation-canonical-index'),
      detectIdentityRecovery: () => calls.push('identity-recovery'),
    };
    runS1InvariantDetectors(host, S1_INVARIANT_REGISTRY.map((definition) => definition.id));
    assert.deepEqual(calls, S1_INVARIANT_REGISTRY.map((definition) => definition.detector_name));
    assert.equal(new Set(S1_INVARIANT_REGISTRY.map((definition) => definition.id)).size, S1_INVARIANT_REGISTRY.length);
    assert.equal(S1_INVARIANT_REGISTRY.every((definition) => (definition.mechanical_repair === null) !== (definition.no_safe_repair_proof === null)), true);
    assert.throws(() => runS1InvariantDetectors(host, ['F4-WRITER-GUARD', 'F4-WRITER-GUARD']), /requested twice/u);
    assert.throws(() => runS1InvariantDetectors(host, ['unknown-invariant']), /Unknown S1 invariant/u);
  });
});
