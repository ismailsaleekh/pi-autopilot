import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COORDINATION_FAILURE_CODES, coordinationFailureDefinition, CoordinationRuntimeError, type CoordinationFailureCode, type CoordinationRetryPolicy } from '../../src/core/coordination/failures.ts';
import { buildS2CoordinationFailureDiagnostic, buildS2CoordinationRuntimeErrorDiagnostic, S2_DIAGNOSTIC_MAX_EVIDENCE_ENTRIES, S2_DIAGNOSTIC_MAX_MESSAGE_CODE_POINTS, S2_DIAGNOSTIC_MAX_TEXT_CODE_POINTS } from '../../src/core/coordination/s2-diagnostics.ts';
import { assertS2FailureTaxonomyMatchesExistingRetryPolicy, decideS2CoordinationFailure, isS2AuthorityCriticalFailure, isS2CoordinationFailureCode, isS2CoordinatorContentionFailure, isS2CoordinatorStoreCorruptionFailure, isS2CoordinatorTransportProgressFailure, isS2FailureResponseRetryable, isS2OwnerRecoveryProgressFailure, isS2OwnerRecoveryRequiredFailure, isS2ProgressCriticalFailure, isS2SameOperationProgressRetry, isS2StaleVersionFailure, listS2CoordinationFailureDecisions, s2CoordinationFailureClass, s2WorktreeSagaFailureCode, shouldS2AttemptEffectUnknownRecovery, shouldS2PreserveWorktreeSagaFailure, shouldS2UseSystemFatalExit, type S2AuthorityScopeRule, type S2FailureCriticality, type S2FailureEvidencePublication, type S2FailureScopeKind, type S2ProgressScopeRule } from '../../src/core/coordination/s2-failure-taxonomy.ts';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

interface ExpectedDecision {
  readonly criticality: S2FailureCriticality;
  readonly scope_kind: S2FailureScopeKind;
  readonly scope_rule: S2AuthorityScopeRule | S2ProgressScopeRule;
  readonly evidence_publication: S2FailureEvidencePublication;
  readonly retry_policy: CoordinationRetryPolicy;
  readonly exact_scope: string;
  readonly evidence_requirement: string;
  readonly permitted_repair_or_retry: string;
}

const EXPECTED_DECISIONS: { readonly [Code in CoordinationFailureCode]: ExpectedDecision } = {
  'invalid-request': {
    criticality: 'authority-critical',
    scope_kind: 'request-envelope',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the rejected request envelope and operation identity only',
    evidence_requirement: 'strict validator finding with field or invariant name; bounded redacted request diagnostics only',
    permitted_repair_or_retry: 'reject the envelope; caller may submit a corrected request under a valid new operation identity',
  },
  'invalid-state': {
    criticality: 'authority-critical',
    scope_kind: 'coordinator-invariant',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'after-reconciliation',
    exact_scope: 'the invariant-broken coordinator entity set named by the finding',
    evidence_requirement: 'published invariant finding with entity identities, versions, and event sequence range',
    permitted_repair_or_retry: 'keep that invariant scope closed until accepted reconciliation publishes a repaired successor state',
  },
  'protocol-mismatch': {
    criticality: 'authority-critical',
    scope_kind: 'connection-protocol',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the single client connection and negotiated protocol attempt',
    evidence_requirement: 'observed protocol lineage, handshake transcript digest, and rejected peer class',
    permitted_repair_or_retry: 'close the connection; retry only with an exact compatible protocol implementation',
  },
  'schema-mismatch': {
    criticality: 'authority-critical',
    scope_kind: 'store-schema-boundary',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the client and coordinator store schema boundary for this attach attempt',
    evidence_requirement: 'offered API schema, store schema, package identity, and exact rejection reason',
    permitted_repair_or_retry: 'refuse attach; use an implementation with the exact accepted schema lineage',
  },
  'frame-too-large': {
    criticality: 'authority-critical',
    scope_kind: 'ipc-frame',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the oversized IPC frame and its request identity',
    evidence_requirement: 'measured frame bytes, configured bound, action name, and request identity',
    permitted_repair_or_retry: 'reject the frame; caller must page or externalize evidence before creating a bounded request',
  },
  'unauthorized-client': {
    criticality: 'authority-critical',
    scope_kind: 'client-authority-proof',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the failed client capability, identity proof, and connection',
    evidence_requirement: 'bounded authentication failure reason and peer identity fields with all secrets redacted',
    permitted_repair_or_retry: 'deny the operation; reattach only after presenting a valid capability and identity proof',
  },
  'coordinator-unavailable': {
    criticality: 'progress-critical',
    scope_kind: 'coordinator-endpoint',
    scope_rule: 'must-not-stop-unrelated-runs-or-coordinator',
    evidence_publication: 'required-before-repair-or-retry',
    retry_policy: 'same-idempotency-key',
    exact_scope: 'the unavailable coordinator endpoint observation for the in-flight request',
    evidence_requirement: 'published endpoint/startup observation with socket path, lifecycle phase, and stable process identity evidence',
    permitted_repair_or_retry: 'reattest or restart locally, then retry the identical idempotency key without releasing claims or replacing unrelated runs',
  },
  'coordinator-contention': {
    criticality: 'progress-critical',
    scope_kind: 'transaction-attempt',
    scope_rule: 'must-not-stop-unrelated-runs-or-coordinator',
    evidence_publication: 'required-before-repair-or-retry',
    retry_policy: 'same-idempotency-key',
    exact_scope: 'the contended transaction attempt and idempotency key',
    evidence_requirement: 'published contention finding with transaction class, bounded retry window, and idempotency key identity',
    permitted_repair_or_retry: 'retry the identical idempotency key after bounded backoff; do not stop the coordinator or unrelated work',
  },
  'fenced-session': {
    criticality: 'authority-critical',
    scope_kind: 'session-generation',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'after-reattach',
    exact_scope: 'the stale session generation and its run attachment',
    evidence_requirement: 'current durable generation, rejected generation, run identity, and attach event sequence',
    permitted_repair_or_retry: 'fail the stale session closed; reattach to the current generation before issuing new operations',
  },
  'stale-version': {
    criticality: 'authority-critical',
    scope_kind: 'entity-version',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'same-idempotency-key',
    exact_scope: 'the entity version precondition on the attempted mutation',
    evidence_requirement: 'expected version, observed version, entity identity, and committed event sequence',
    permitted_repair_or_retry: 'reject the stale mutation; reread the entity and retry only the still-valid intended operation identity',
  },
  'idempotency-conflict': {
    criticality: 'authority-critical',
    scope_kind: 'idempotency-key',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the reused idempotency key and conflicting request digest',
    evidence_requirement: 'original request digest, conflicting request digest, owner identity, and committed result identity',
    permitted_repair_or_retry: 'return the conflict; never apply the second request under the reused key',
  },
  'request-timeout': {
    criticality: 'progress-critical',
    scope_kind: 'transaction-attempt',
    scope_rule: 'must-not-stop-unrelated-runs-or-coordinator',
    evidence_publication: 'required-before-repair-or-retry',
    retry_policy: 'same-idempotency-key',
    exact_scope: 'the timed-out response observation for the in-flight idempotency key',
    evidence_requirement: 'published timeout observation with deadline, request identity, and last observed coordinator endpoint',
    permitted_repair_or_retry: 'retry the identical idempotency key and inspect the committed sequence before issuing related work',
  },
  'recovery-required': {
    criticality: 'progress-critical',
    scope_kind: 'owner-run-recovery',
    scope_rule: 'must-not-stop-unrelated-runs-or-coordinator',
    evidence_publication: 'required-before-repair-or-retry',
    retry_policy: 'after-reconciliation',
    exact_scope: 'the owning run recovery item named by durable state',
    evidence_requirement: 'published recovery receipt naming owner, pending intent, and accepted reconciliation evidence',
    permitted_repair_or_retry: 'owning supervisor reconciles that item and resumes only after the recovery receipt is accepted',
  },
  'git-partial-effect': {
    criticality: 'progress-critical',
    scope_kind: 'owner-operation-saga',
    scope_rule: 'must-not-stop-unrelated-runs-or-coordinator',
    evidence_publication: 'required-before-repair-or-retry',
    retry_policy: 'after-reconciliation',
    exact_scope: 'the owner-scoped Git or filesystem saga operation',
    evidence_requirement: 'published saga intent, command identity, postcondition findings, and compensation or completion receipt',
    permitted_repair_or_retry: 'complete or compensate idempotently from postconditions; do not infer success from process exit alone',
  },
  'disk-failure': {
    criticality: 'progress-critical',
    scope_kind: 'owner-operation-storage',
    scope_rule: 'must-not-stop-unrelated-runs-or-coordinator',
    evidence_publication: 'required-before-repair-or-retry',
    retry_policy: 'after-reconciliation',
    exact_scope: 'the storage-dependent owner operation and retained intent',
    evidence_requirement: 'published capacity or I/O finding plus retained operation intent and owner identity',
    permitted_repair_or_retry: 'retry only after storage evidence changes and reconciliation confirms the retained intent is still current',
  },
  'permission-denied': {
    criticality: 'progress-critical',
    scope_kind: 'owner-operation-path',
    scope_rule: 'must-not-stop-unrelated-runs-or-coordinator',
    evidence_publication: 'required-before-repair-or-retry',
    retry_policy: 'after-reconciliation',
    exact_scope: 'the denied owner-scoped filesystem path operation',
    evidence_requirement: 'published path, owner identity, denied operation, and permission repair evidence with secrets redacted',
    permitted_repair_or_retry: 'repair permissions for the owner path and reconcile; never delete or alter a foreign run path',
  },
  'planning-contradiction-review': {
    criticality: 'authority-critical',
    scope_kind: 'planning-authority-set',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the complete conflicting authoritative planning clauses and participating runs',
    evidence_requirement: 'complete contradiction artifact with authoritative refs, clause identities, exhausted alternatives, and adjudication digest',
    permitted_repair_or_retry: 'pause only the contradictory planning authority set until the explicit operator decision is recorded',
  },
  'store-corrupt': {
    criticality: 'authority-critical',
    scope_kind: 'coordinator-store',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the coordinator store whose integrity proof failed',
    evidence_requirement: 'integrity-check finding, schema identity, store identity, and immutable diagnostic digest',
    permitted_repair_or_retry: 'halt store use and recover only from verified durable authority; never fall back to mutable legacy state',
  },
  'system-fatal': {
    criticality: 'authority-critical',
    scope_kind: 'local-runtime',
    scope_rule: 'fail-closed-at-exact-scope',
    evidence_publication: 'required-for-diagnosis',
    retry_policy: 'never',
    exact_scope: 'the local runtime boundary named by the fatal condition',
    evidence_requirement: 'bounded fatal diagnostic with runtime boundary, package identity, and exact halt reason',
    permitted_repair_or_retry: 'halt that runtime boundary until the fatal condition is externally repaired and reverified',
  },
};

function decisionProjection(code: CoordinationFailureCode): ExpectedDecision {
  const decision = decideS2CoordinationFailure(code);
  return {
    criticality: decision.criticality,
    scope_kind: decision.scope_kind,
    scope_rule: decision.scope_rule,
    evidence_publication: decision.evidence_publication,
    retry_policy: decision.retry_policy,
    exact_scope: decision.exact_scope,
    evidence_requirement: decision.evidence_requirement,
    permitted_repair_or_retry: decision.permitted_repair_or_retry,
  };
}

async function coordinationSourceFiles(relativeDirectory = 'src/core/coordination'): Promise<readonly string[]> {
  const directory = join(packageRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await coordinationSourceFiles(relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      output.push(relativePath);
    }
  }
  return output.sort();
}

function isS2ConsumerSource(relativePath: string, source: string): boolean {
  if (relativePath.endsWith('/s2-failure-taxonomy.ts')) return false;
  return /(?:from\s+['"]\.\/s2-|export\s+\*\s+from\s+['"]\.\/s2-|S2Coordination|S2_FAILURE|buildS2Coordination|decideS2CoordinationFailure|listS2CoordinationFailureDecisions|isS2AuthorityCriticalFailure)/u.test(source);
}

void describe('S2 coordination failure taxonomy', () => {
  void it('classifies every existing coordination failure code exactly once', () => {
    const decisions = listS2CoordinationFailureDecisions();
    assert.deepEqual(decisions.map((decision) => decision.code), COORDINATION_FAILURE_CODES);
    assert.equal(new Set(decisions.map((decision) => decision.code)).size, COORDINATION_FAILURE_CODES.length);
    assertS2FailureTaxonomyMatchesExistingRetryPolicy();

    for (const code of COORDINATION_FAILURE_CODES) {
      const expected = EXPECTED_DECISIONS[code];
      assert.deepEqual(decisionProjection(code), expected, code);
      assert.equal(decideS2CoordinationFailure(code).retry_policy, coordinationFailureDefinition(code).retry_policy, code);
      assert.equal(isS2AuthorityCriticalFailure(code), expected.criticality === 'authority-critical', code);
    }
  });

  void it('locks exact per-code evidence and repair scope behavior', () => {
    const expectedAuthorityRule: S2AuthorityScopeRule = 'fail-closed-at-exact-scope';
    const expectedProgressRule: S2ProgressScopeRule = 'must-not-stop-unrelated-runs-or-coordinator';

    for (const code of COORDINATION_FAILURE_CODES) {
      const decision = decideS2CoordinationFailure(code);
      assert.deepEqual(decisionProjection(code), EXPECTED_DECISIONS[code], code);
      assert.equal(decision.exact_scope.length > 0, true, code);
      assert.equal(decision.evidence_requirement.length > 0, true, code);

      if (decision.criticality === 'authority-critical') {
        assert.equal(decision.scope_rule, expectedAuthorityRule, code);
        assert.equal(decision.evidence_publication, 'required-for-diagnosis', code);
      } else {
        assert.equal(decision.scope_rule, expectedProgressRule, code);
        assert.equal(decision.evidence_publication, 'required-before-repair-or-retry', code);
        assert.equal(/(?:identical idempotency key|owning supervisor|owner-scoped|owner operation|owner path|retained intent|foreign run path|unrelated runs|unrelated work)/u.test(`${decision.exact_scope} ${decision.permitted_repair_or_retry}`), true, code);
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

  void it('redacts bearer, API-key, and authority-secret labels without lossy fallback', () => {
    const diagnostic = buildS2CoordinationFailureDiagnostic({
      code: 'unauthorized-client',
      message: 'Authorization: Bearer synthetic-live-bearer OPENAI_API_KEY=synthetic-openai-key status=visible',
      evidence: [
        'x-api-key: synthetic-header-key',
        'AWS_SECRET_ACCESS_KEY=synthetic-aws-secret',
        'handoff-token=synthetic-handoff',
        '{"client_secret": "synthetic-json-secret"}',
      ],
    });

    assert.equal(diagnostic.redacted, true);
    assert.equal(diagnostic.message, 'Authorization: Bearer <redacted> OPENAI_API_KEY=<redacted> status=visible');
    assert.deepEqual(diagnostic.evidence, [
      'x-api-key: <redacted>',
      'AWS_SECRET_ACCESS_KEY=<redacted>',
      'handoff-token=<redacted>',
      '{"client_secret": "<redacted>"}',
    ]);
    assert.equal(JSON.stringify(diagnostic).includes('synthetic-live-bearer'), false);
    assert.equal(JSON.stringify(diagnostic).includes('synthetic-openai-key'), false);
    assert.equal(JSON.stringify(diagnostic).includes('synthetic-header-key'), false);
    assert.equal(JSON.stringify(diagnostic).includes('synthetic-aws-secret'), false);
    assert.equal(JSON.stringify(diagnostic).includes('synthetic-handoff'), false);
    assert.equal(JSON.stringify(diagnostic).includes('synthetic-json-secret'), false);

    const nonSecret = buildS2CoordinationFailureDiagnostic({
      code: 'coordinator-unavailable',
      message: 'status=coordinator-unavailable phase=ready socket=/tmp/synthetic.sock',
      evidence: ['owner=synthetic-run result=ready'],
    });
    assert.equal(nonSecret.redacted, false);
    assert.equal(nonSecret.message, 'status=coordinator-unavailable phase=ready socket=/tmp/synthetic.sock');
    assert.deepEqual(nonSecret.evidence, ['owner=synthetic-run result=ready']);
  });

  void it('centralizes all runtime seam judgments over every failure code', () => {
    for (const code of COORDINATION_FAILURE_CODES) {
      const expected = EXPECTED_DECISIONS[code];
      assert.equal(isS2CoordinationFailureCode(code), true, code);
      assert.equal(isS2ProgressCriticalFailure(code), expected.criticality === 'progress-critical', code);
      assert.equal(isS2FailureResponseRetryable(code), expected.retry_policy !== 'never', code);
      assert.equal(isS2SameOperationProgressRetry(code), expected.criticality === 'progress-critical' && expected.retry_policy === 'same-idempotency-key', code);
      assert.equal(isS2OwnerRecoveryProgressFailure(code), expected.criticality === 'progress-critical' && expected.retry_policy === 'after-reconciliation', code);
      assert.equal(shouldS2AttemptEffectUnknownRecovery(code), expected.criticality === 'progress-critical', code);
      assert.equal(s2CoordinationFailureClass(code), coordinationFailureDefinition(code).failure_class, code);
      assert.equal(shouldS2UseSystemFatalExit(code), code === 'store-corrupt' || code === 'system-fatal', code);
      const runtime = new CoordinationRuntimeError(code, `synthetic ${code}`);
      assert.equal(isS2CoordinatorContentionFailure(runtime), code === 'coordinator-contention', code);
      assert.equal(isS2StaleVersionFailure(runtime), expected.scope_kind === 'entity-version', code);
      assert.equal(isS2CoordinatorTransportProgressFailure(runtime), expected.criticality === 'progress-critical' && expected.retry_policy === 'same-idempotency-key' && (expected.scope_kind === 'coordinator-endpoint' || expected.scope_kind === 'transaction-attempt'), code);
      assert.equal(shouldS2PreserveWorktreeSagaFailure(runtime), ['session-generation', 'client-authority-proof', 'entity-version'].includes(expected.scope_kind), code);
      assert.equal(isS2OwnerRecoveryRequiredFailure(runtime), expected.scope_kind === 'owner-run-recovery', code);
      assert.equal(isS2CoordinatorStoreCorruptionFailure(runtime), expected.scope_kind === 'coordinator-store', code);
      assert.equal(s2WorktreeSagaFailureCode(runtime, false), code, code);
    }
    assert.equal(isS2CoordinationFailureCode('not-a-coordination-code'), false);
  });

  void it('guards real runtime consumers from bypassing the centralized taxonomy decision API', async () => {
    const sources = new Map<string, string>();
    for (const relativePath of await coordinationSourceFiles()) {
      sources.set(relativePath, await readFile(join(packageRoot, relativePath), 'utf8'));
    }
    for (const relativePath of ['src/cli/autopilot-agent-run.ts', 'src/cli/autopilot-coordinator.ts']) {
      sources.set(relativePath, await readFile(join(packageRoot, relativePath), 'utf8'));
    }

    const indexSource = sources.get('src/core/coordination/index.ts');
    assert.equal(indexSource?.includes("export * from './s2-diagnostics.ts';"), true);
    assert.equal(indexSource?.includes("export * from './s2-failure-taxonomy.ts';"), true);

    const taxonomySource = sources.get('src/core/coordination/s2-failure-taxonomy.ts');
    assert.notEqual(taxonomySource, undefined);
    assert.equal(/export\s+(?:const|let|var)\s+S2_[A-Z0-9_]*DECISION_BY_CODE|export\s*\{[^}]*S2_[A-Z0-9_]*DECISION_BY_CODE|export\s+default\s+S2_[A-Z0-9_]*DECISION_BY_CODE/u.test(taxonomySource ?? ''), false);

    const requiredConsumers: Readonly<Record<string, readonly string[]>> = Object.freeze({
      'src/cli/autopilot-agent-run.ts': ['buildS2CoordinationRuntimeErrorDiagnostic'],
      'src/cli/autopilot-coordinator.ts': ['shouldS2UseSystemFatalExit'],
      'src/core/coordination/client.ts': ['s2CoordinationFailureClass', 'isS2CoordinatorContentionFailure'],
      'src/core/coordination/d65-graph-publisher.ts': ['shouldS2AttemptEffectUnknownRecovery'],
      'src/core/coordination/server.ts': ['isS2FailureResponseRetryable', 'buildS2CoordinationRuntimeErrorDiagnostic', 'isS2CoordinatorContentionFailure'],
      'src/core/coordination/startup-observation.ts': ['isS2CoordinationFailureCode', 's2CoordinationFailureClass'],
      'src/core/coordination/store.ts': ['isS2CoordinationFailureCode', 'isS2FailureResponseRetryable', 'buildS2CoordinationRuntimeErrorDiagnostic'],
      'src/core/coordination/reconciliation.ts': ['isS2StaleVersionFailure'],
      'src/core/coordination/supervisor.ts': ['isS2SameOperationProgressRetry', 'isS2OwnerRecoveryProgressFailure'],
      'src/core/coordination/worktree-saga.ts': ['isS2CoordinatorTransportProgressFailure', 's2WorktreeSagaFailureCode', 'shouldS2PreserveWorktreeSagaFailure'],
      'src/core/coordination/d65-semantic-version.ts': ['isS2CoordinatorStoreCorruptionFailure'],
    });

    for (const [relativePath, requiredSymbols] of Object.entries(requiredConsumers)) {
      const source = sources.get(relativePath);
      assert.notEqual(source, undefined, relativePath);
      for (const symbol of requiredSymbols) assert.equal(source?.includes(symbol), true, `${relativePath} must use ${symbol}`);
    }

    for (const [relativePath, source] of sources) {
      const displayPath = relative(packageRoot, join(packageRoot, relativePath));
      const isTaxonomy = relativePath === 'src/core/coordination/s2-failure-taxonomy.ts';
      const isLegacyDefinition = relativePath === 'src/core/coordination/failures.ts';
      if (!isTaxonomy) assert.equal(/S2_DECISION_BY_CODE/u.test(source), false, displayPath);
      if (isTaxonomy || isLegacyDefinition) continue;

      assert.equal(/coordinationFailureDefinition\(/u.test(source), false, displayPath);
      assert.equal(/\.retry_policy\s*(?:===|!==)\s*['"]|\.retry_policy\s*!==\s*['"]never['"]|\.failure_class\s*===\s*['"](?:owned-recovery|system-fatal|retryable-contention|client-invalid|fenced-client|contradiction-review)['"]/u.test(source), false, displayPath);
      assert.equal(/new\s+Set\s*\(\s*\[\s*['"](?:coordinator-unavailable|coordinator-contention|request-timeout)['"]/u.test(source), false, displayPath);
      assert.equal(/instanceof\s+CoordinationRuntimeError[^\n;{}]*(?:&&|\|\|)[^\n;{}]*\.code\s*(?:===|!==)\s*['"][a-z0-9-]+['"]|\.code\s*(?:===|!==)\s*['"](?:invalid-request|invalid-state|protocol-mismatch|schema-mismatch|frame-too-large|unauthorized-client|coordinator-unavailable|coordinator-contention|fenced-session|stale-version|idempotency-conflict|request-timeout|recovery-required|git-partial-effect|disk-failure|permission-denied|planning-contradiction-review|store-corrupt|system-fatal)['"]/u.test(source), false, displayPath);

      if (isS2ConsumerSource(relativePath, source)) {
        assert.equal(/criticality:\s*['"](?:authority-critical|progress-critical)['"]|scope_rule:\s*['"](?:fail-closed-at-exact-scope|must-not-stop-unrelated-runs-or-coordinator)['"]/u.test(source), false, displayPath);
        assert.equal(/COORDINATION_FAILURE_TAXONOMY|COORDINATION_FAILURE_MATRIX|COORDINATION_FAILURE_CODES/u.test(source), false, displayPath);
      }
    }
  });
});
