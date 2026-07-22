import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COORDINATION_FAILURE_CODES, coordinationFailureDefinition, CoordinationRuntimeError, type CoordinationFailureCode } from '../../src/core/coordination/failures.ts';
import { buildS2CoordinationFailureDiagnostic, buildS2CoordinationRuntimeErrorDiagnostic, S2_DIAGNOSTIC_MAX_EVIDENCE_ENTRIES, S2_DIAGNOSTIC_MAX_MESSAGE_CODE_POINTS, S2_DIAGNOSTIC_MAX_TEXT_CODE_POINTS } from '../../src/core/coordination/s2-diagnostics.ts';
import { assertS2FailureTaxonomyMatchesExistingRetryPolicy, decideS2CoordinationFailure, isS2AuthorityCriticalFailure, listS2CoordinationFailureDecisions, type S2FailureCriticality, type S2FailureScopeKind } from '../../src/core/coordination/s2-failure-taxonomy.ts';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

interface ExpectedClassification {
  readonly criticality: S2FailureCriticality;
  readonly scope_kind: S2FailureScopeKind;
}

const EXPECTED_CLASSIFICATION: { readonly [Code in CoordinationFailureCode]: ExpectedClassification } = {
  'invalid-request': { criticality: 'authority-critical', scope_kind: 'request-envelope' },
  'invalid-state': { criticality: 'authority-critical', scope_kind: 'coordinator-invariant' },
  'protocol-mismatch': { criticality: 'authority-critical', scope_kind: 'connection-protocol' },
  'schema-mismatch': { criticality: 'authority-critical', scope_kind: 'store-schema-boundary' },
  'frame-too-large': { criticality: 'authority-critical', scope_kind: 'ipc-frame' },
  'unauthorized-client': { criticality: 'authority-critical', scope_kind: 'client-authority-proof' },
  'coordinator-unavailable': { criticality: 'progress-critical', scope_kind: 'coordinator-endpoint' },
  'coordinator-contention': { criticality: 'progress-critical', scope_kind: 'transaction-attempt' },
  'fenced-session': { criticality: 'authority-critical', scope_kind: 'session-generation' },
  'stale-version': { criticality: 'authority-critical', scope_kind: 'entity-version' },
  'idempotency-conflict': { criticality: 'authority-critical', scope_kind: 'idempotency-key' },
  'request-timeout': { criticality: 'progress-critical', scope_kind: 'transaction-attempt' },
  'recovery-required': { criticality: 'progress-critical', scope_kind: 'owner-run-recovery' },
  'git-partial-effect': { criticality: 'progress-critical', scope_kind: 'owner-operation-saga' },
  'disk-failure': { criticality: 'progress-critical', scope_kind: 'owner-operation-storage' },
  'permission-denied': { criticality: 'progress-critical', scope_kind: 'owner-operation-path' },
  'planning-contradiction-review': { criticality: 'authority-critical', scope_kind: 'planning-authority-set' },
  'store-corrupt': { criticality: 'authority-critical', scope_kind: 'coordinator-store' },
  'system-fatal': { criticality: 'authority-critical', scope_kind: 'local-runtime' },
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

void describe('S2 coordination failure taxonomy', () => {
  void it('classifies every existing coordination failure code exactly once', () => {
    const decisions = listS2CoordinationFailureDecisions();
    assert.deepEqual(decisions.map((decision) => decision.code), COORDINATION_FAILURE_CODES);
    assert.equal(new Set(decisions.map((decision) => decision.code)).size, COORDINATION_FAILURE_CODES.length);
    assertS2FailureTaxonomyMatchesExistingRetryPolicy();

    for (const code of COORDINATION_FAILURE_CODES) {
      const decision = decideS2CoordinationFailure(code);
      const expected = EXPECTED_CLASSIFICATION[code];
      assert.equal(decision.code, code);
      assert.equal(decision.criticality, expected.criticality, code);
      assert.equal(decision.scope_kind, expected.scope_kind, code);
      assert.equal(decision.retry_policy, coordinationFailureDefinition(code).retry_policy, code);
      assert.equal(decision.exact_scope.length > 0, true, code);
      assert.equal(decision.evidence_requirement.length > 0, true, code);
      assert.equal(decision.permitted_repair_or_retry.length > 0, true, code);
      assert.equal(isS2AuthorityCriticalFailure(code), expected.criticality === 'authority-critical', code);
    }
  });

  void it('makes authority failures fail closed and progress failures evidence-gated without unrelated stops', () => {
    for (const code of COORDINATION_FAILURE_CODES) {
      const decision = decideS2CoordinationFailure(code);
      if (decision.criticality === 'authority-critical') {
        assert.equal(decision.scope_rule, 'fail-closed-at-exact-scope', code);
        assert.equal(decision.evidence_publication, 'required-for-diagnosis', code);
      } else {
        assert.equal(decision.scope_rule, 'must-not-stop-unrelated-runs-or-coordinator', code);
        assert.equal(decision.evidence_publication, 'required-before-repair-or-retry', code);
        assert.match(decision.permitted_repair_or_retry, /retry|reconcile|reattest|restart|complete|compensate|repair/u, code);
      }
    }
  });

  void it('builds bounded redacted diagnostics through the centralized decision API', () => {
    const diagnostic = buildS2CoordinationFailureDiagnostic({
      code: 'coordinator-unavailable',
      message: `capability=synthetic-secret ${'m'.repeat(S2_DIAGNOSTIC_MAX_MESSAGE_CODE_POINTS * 2)}`,
      evidence: Array.from({ length: S2_DIAGNOSTIC_MAX_EVIDENCE_ENTRIES + 3 }, (_entry, index) => `authorization:synthetic-${String(index)} ${'e'.repeat(S2_DIAGNOSTIC_MAX_TEXT_CODE_POINTS * 2)}`),
    });

    assert.equal(diagnostic.decision, decideS2CoordinationFailure('coordinator-unavailable'));
    assert.equal(diagnostic.decision.criticality, 'progress-critical');
    assert.equal(diagnostic.redacted, true);
    assert.equal(diagnostic.message.includes('synthetic-secret'), false);
    assert.equal(diagnostic.evidence.some((entry) => entry.includes('synthetic-')), false);
    assert.equal(diagnostic.message.length <= S2_DIAGNOSTIC_MAX_MESSAGE_CODE_POINTS + '…[truncated]'.length, true);
    assert.equal(diagnostic.evidence.every((entry) => [...entry].length <= S2_DIAGNOSTIC_MAX_TEXT_CODE_POINTS), true);
    assert.equal(diagnostic.truncation.omitted_entries > 0, true);
    assert.equal(diagnostic.truncation.omitted_code_points > 0, true);

    const runtimeDiagnostic = buildS2CoordinationRuntimeErrorDiagnostic(new CoordinationRuntimeError('store-corrupt', 'store integrity failed', ['token=synthetic']));
    assert.equal(runtimeDiagnostic.decision.criticality, 'authority-critical');
    assert.equal(runtimeDiagnostic.evidence.some((entry) => entry.includes('synthetic')), false);
  });

  void it('guards S2 consumers from bypassing the centralized taxonomy decision API', async () => {
    const taxonomySource = await readFile(join(packageRoot, 'src/core/coordination/s2-failure-taxonomy.ts'), 'utf8');
    const diagnosticsSource = await readFile(join(packageRoot, 'src/core/coordination/s2-diagnostics.ts'), 'utf8');
    assert.equal(/export\s+const\s+S2_[A-Z0-9_]*DECISION_BY_CODE/u.test(taxonomySource), false);
    assert.match(diagnosticsSource, /decideS2CoordinationFailure/u);
    assert.equal(/coordinationFailureDefinition|COORDINATION_FAILURE_TAXONOMY|COORDINATION_FAILURE_MATRIX|COORDINATION_FAILURE_CODES/u.test(diagnosticsSource), false);

    for (const code of COORDINATION_FAILURE_CODES) {
      const literalPattern = new RegExp(`['\"]${escapeRegExp(code)}['\"]`, 'u');
      assert.equal(literalPattern.test(diagnosticsSource), false, code);
    }
  });
});
