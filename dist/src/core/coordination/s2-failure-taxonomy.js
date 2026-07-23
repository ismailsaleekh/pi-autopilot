import { COORDINATION_FAILURE_CODES, CoordinationRuntimeError, coordinationFailureDefinition } from "./failures.js";
export const S2_FAILURE_TAXONOMY_SCHEMA_VERSION = 'autopilot.s2.failure_taxonomy.v1';
function authorityDecision(input) {
    return Object.freeze({
        schema_version: S2_FAILURE_TAXONOMY_SCHEMA_VERSION,
        criticality: 'authority-critical',
        scope_rule: 'fail-closed-at-exact-scope',
        evidence_publication: 'required-for-diagnosis',
        ...input,
    });
}
function progressDecision(input) {
    return Object.freeze({
        schema_version: S2_FAILURE_TAXONOMY_SCHEMA_VERSION,
        criticality: 'progress-critical',
        scope_rule: 'must-not-stop-unrelated-runs-or-coordinator',
        evidence_publication: 'required-before-repair-or-retry',
        ...input,
    });
}
const S2_DECISION_BY_CODE = Object.freeze({
    'invalid-request': authorityDecision({
        code: 'invalid-request',
        retry_policy: 'never',
        scope_kind: 'request-envelope',
        exact_scope: 'the rejected request envelope and operation identity only',
        evidence_requirement: 'strict validator finding with field or invariant name; bounded redacted request diagnostics only',
        permitted_repair_or_retry: 'reject the envelope; caller may submit a corrected request under a valid new operation identity',
    }),
    'invalid-state': authorityDecision({
        code: 'invalid-state',
        retry_policy: 'after-reconciliation',
        scope_kind: 'coordinator-invariant',
        exact_scope: 'the invariant-broken coordinator entity set named by the finding',
        evidence_requirement: 'published invariant finding with entity identities, versions, and event sequence range',
        permitted_repair_or_retry: 'keep that invariant scope closed until accepted reconciliation publishes a repaired successor state',
    }),
    'protocol-mismatch': authorityDecision({
        code: 'protocol-mismatch',
        retry_policy: 'never',
        scope_kind: 'connection-protocol',
        exact_scope: 'the single client connection and negotiated protocol attempt',
        evidence_requirement: 'observed protocol lineage, handshake transcript digest, and rejected peer class',
        permitted_repair_or_retry: 'close the connection; retry only with an exact compatible protocol implementation',
    }),
    'schema-mismatch': authorityDecision({
        code: 'schema-mismatch',
        retry_policy: 'never',
        scope_kind: 'store-schema-boundary',
        exact_scope: 'the client and coordinator store schema boundary for this attach attempt',
        evidence_requirement: 'offered API schema, store schema, package identity, and exact rejection reason',
        permitted_repair_or_retry: 'refuse attach; use an implementation with the exact accepted schema lineage',
    }),
    'frame-too-large': authorityDecision({
        code: 'frame-too-large',
        retry_policy: 'never',
        scope_kind: 'ipc-frame',
        exact_scope: 'the oversized IPC frame and its request identity',
        evidence_requirement: 'measured frame bytes, configured bound, action name, and request identity',
        permitted_repair_or_retry: 'reject the frame; caller must page or externalize evidence before creating a bounded request',
    }),
    'unauthorized-client': authorityDecision({
        code: 'unauthorized-client',
        retry_policy: 'never',
        scope_kind: 'client-authority-proof',
        exact_scope: 'the failed client capability, identity proof, and connection',
        evidence_requirement: 'bounded authentication failure reason and peer identity fields with all secrets redacted',
        permitted_repair_or_retry: 'deny the operation; reattach only after presenting a valid capability and identity proof',
    }),
    'coordinator-unavailable': progressDecision({
        code: 'coordinator-unavailable',
        retry_policy: 'same-idempotency-key',
        scope_kind: 'coordinator-endpoint',
        exact_scope: 'the unavailable coordinator endpoint observation for the in-flight request',
        evidence_requirement: 'published endpoint/startup observation with socket path, lifecycle phase, and stable process identity evidence',
        permitted_repair_or_retry: 'reattest or restart locally, then retry the identical idempotency key without releasing claims or replacing unrelated runs',
    }),
    'coordinator-contention': progressDecision({
        code: 'coordinator-contention',
        retry_policy: 'same-idempotency-key',
        scope_kind: 'transaction-attempt',
        exact_scope: 'the contended transaction attempt and idempotency key',
        evidence_requirement: 'published contention finding with transaction class, bounded retry window, and idempotency key identity',
        permitted_repair_or_retry: 'retry the identical idempotency key after bounded backoff; do not stop the coordinator or unrelated work',
    }),
    'fenced-session': authorityDecision({
        code: 'fenced-session',
        retry_policy: 'after-reattach',
        scope_kind: 'session-generation',
        exact_scope: 'the stale session generation and its run attachment',
        evidence_requirement: 'current durable generation, rejected generation, run identity, and attach event sequence',
        permitted_repair_or_retry: 'fail the stale session closed; reattach to the current generation before issuing new operations',
    }),
    'stale-version': authorityDecision({
        code: 'stale-version',
        retry_policy: 'same-idempotency-key',
        scope_kind: 'entity-version',
        exact_scope: 'the entity version precondition on the attempted mutation',
        evidence_requirement: 'expected version, observed version, entity identity, and committed event sequence',
        permitted_repair_or_retry: 'reject the stale mutation; reread the entity and retry only the still-valid intended operation identity',
    }),
    'idempotency-conflict': authorityDecision({
        code: 'idempotency-conflict',
        retry_policy: 'never',
        scope_kind: 'idempotency-key',
        exact_scope: 'the reused idempotency key and conflicting request digest',
        evidence_requirement: 'original request digest, conflicting request digest, owner identity, and committed result identity',
        permitted_repair_or_retry: 'return the conflict; never apply the second request under the reused key',
    }),
    'request-timeout': progressDecision({
        code: 'request-timeout',
        retry_policy: 'same-idempotency-key',
        scope_kind: 'transaction-attempt',
        exact_scope: 'the timed-out response observation for the in-flight idempotency key',
        evidence_requirement: 'published timeout observation with deadline, request identity, and last observed coordinator endpoint',
        permitted_repair_or_retry: 'retry the identical idempotency key and inspect the committed sequence before issuing related work',
    }),
    'recovery-required': progressDecision({
        code: 'recovery-required',
        retry_policy: 'after-reconciliation',
        scope_kind: 'owner-run-recovery',
        exact_scope: 'the owning run recovery item named by durable state',
        evidence_requirement: 'published recovery receipt naming owner, pending intent, and accepted reconciliation evidence',
        permitted_repair_or_retry: 'owning supervisor reconciles that item and resumes only after the recovery receipt is accepted',
    }),
    'git-partial-effect': progressDecision({
        code: 'git-partial-effect',
        retry_policy: 'after-reconciliation',
        scope_kind: 'owner-operation-saga',
        exact_scope: 'the owner-scoped Git or filesystem saga operation',
        evidence_requirement: 'published saga intent, command identity, postcondition findings, and compensation or completion receipt',
        permitted_repair_or_retry: 'complete or compensate idempotently from postconditions; do not infer success from process exit alone',
    }),
    'disk-failure': progressDecision({
        code: 'disk-failure',
        retry_policy: 'after-reconciliation',
        scope_kind: 'owner-operation-storage',
        exact_scope: 'the storage-dependent owner operation and retained intent',
        evidence_requirement: 'published capacity or I/O finding plus retained operation intent and owner identity',
        permitted_repair_or_retry: 'retry only after storage evidence changes and reconciliation confirms the retained intent is still current',
    }),
    'permission-denied': progressDecision({
        code: 'permission-denied',
        retry_policy: 'after-reconciliation',
        scope_kind: 'owner-operation-path',
        exact_scope: 'the denied owner-scoped filesystem path operation',
        evidence_requirement: 'published path, owner identity, denied operation, and permission repair evidence with secrets redacted',
        permitted_repair_or_retry: 'repair permissions for the owner path and reconcile; never delete or alter a foreign run path',
    }),
    'planning-contradiction-review': authorityDecision({
        code: 'planning-contradiction-review',
        retry_policy: 'never',
        scope_kind: 'planning-authority-set',
        exact_scope: 'the complete conflicting authoritative planning clauses and participating runs',
        evidence_requirement: 'complete contradiction artifact with authoritative refs, clause identities, exhausted alternatives, and adjudication digest',
        permitted_repair_or_retry: 'pause only the contradictory planning authority set until the explicit operator decision is recorded',
    }),
    'store-corrupt': authorityDecision({
        code: 'store-corrupt',
        retry_policy: 'never',
        scope_kind: 'coordinator-store',
        exact_scope: 'the coordinator store whose integrity proof failed',
        evidence_requirement: 'integrity-check finding, schema identity, store identity, and immutable diagnostic digest',
        permitted_repair_or_retry: 'halt store use and recover only from verified durable authority; never fall back to mutable legacy state',
    }),
    'system-fatal': authorityDecision({
        code: 'system-fatal',
        retry_policy: 'never',
        scope_kind: 'local-runtime',
        exact_scope: 'the local runtime boundary named by the fatal condition',
        evidence_requirement: 'bounded fatal diagnostic with runtime boundary, package identity, and exact halt reason',
        permitted_repair_or_retry: 'halt that runtime boundary until the fatal condition is externally repaired and reverified',
    }),
});
export function decideS2CoordinationFailure(code) {
    return S2_DECISION_BY_CODE[code];
}
export function listS2CoordinationFailureDecisions() {
    return COORDINATION_FAILURE_CODES.map((code) => decideS2CoordinationFailure(code));
}
export function isS2AuthorityCriticalFailure(code) {
    return decideS2CoordinationFailure(code).criticality === 'authority-critical';
}
export function isS2ProgressCriticalFailure(code) {
    return decideS2CoordinationFailure(code).criticality === 'progress-critical';
}
export function isS2CoordinationFailureCode(value) {
    return typeof value === 'string' && COORDINATION_FAILURE_CODES.includes(value);
}
export function s2CoordinationFailureClass(code) {
    return coordinationFailureDefinition(code).failure_class;
}
export function isS2FailureResponseRetryable(code) {
    return decideS2CoordinationFailure(code).retry_policy !== 'never';
}
export function isS2SameOperationProgressRetry(code) {
    const decision = decideS2CoordinationFailure(code);
    return decision.criticality === 'progress-critical' && decision.retry_policy === 'same-idempotency-key';
}
export function isS2OwnerRecoveryProgressFailure(code) {
    const decision = decideS2CoordinationFailure(code);
    return decision.criticality === 'progress-critical' && decision.retry_policy === 'after-reconciliation';
}
export function shouldS2AttemptEffectUnknownRecovery(code) {
    return decideS2CoordinationFailure(code).criticality === 'progress-critical';
}
export function shouldS2UseSystemFatalExit(code) {
    const decision = decideS2CoordinationFailure(code);
    return decision.criticality === 'authority-critical' && decision.retry_policy === 'never' && (decision.scope_kind === 'coordinator-store' || decision.scope_kind === 'local-runtime');
}
export function isS2CoordinationRuntimeError(error) {
    return error instanceof CoordinationRuntimeError;
}
export function isS2RuntimeFailureWithScopeKind(error, scopeKinds) {
    return error instanceof CoordinationRuntimeError && scopeKinds.includes(decideS2CoordinationFailure(error.code).scope_kind);
}
export function isS2CoordinatorContentionFailure(error) {
    return error instanceof CoordinationRuntimeError && error.code === 'coordinator-contention';
}
export function isS2StaleVersionFailure(error) {
    return isS2RuntimeFailureWithScopeKind(error, ['entity-version']);
}
export function isS2CoordinatorTransportProgressFailure(error) {
    const decision = error instanceof CoordinationRuntimeError ? decideS2CoordinationFailure(error.code) : null;
    return decision !== null && decision.criticality === 'progress-critical' && decision.retry_policy === 'same-idempotency-key' && (decision.scope_kind === 'coordinator-endpoint' || decision.scope_kind === 'transaction-attempt');
}
export function shouldS2PreserveWorktreeSagaFailure(error) {
    return isS2RuntimeFailureWithScopeKind(error, ['session-generation', 'client-authority-proof', 'entity-version']);
}
export function isS2OwnerRecoveryRequiredFailure(error) {
    return isS2RuntimeFailureWithScopeKind(error, ['owner-run-recovery']);
}
export function isS2CoordinatorStoreCorruptionFailure(error) {
    return isS2RuntimeFailureWithScopeKind(error, ['coordinator-store']);
}
export function s2WorktreeSagaFailureCode(error, transportInterrupted) {
    if (isS2OwnerRecoveryRequiredFailure(error))
        return error.code;
    if (transportInterrupted)
        return 'coordinator-unavailable';
    if (error instanceof CoordinationRuntimeError)
        return error.code;
    return 'recovery-required';
}
export function assertS2FailureTaxonomyMatchesExistingRetryPolicy() {
    for (const code of COORDINATION_FAILURE_CODES) {
        const expected = coordinationFailureDefinition(code).retry_policy;
        const actual = decideS2CoordinationFailure(code).retry_policy;
        if (actual !== expected)
            throw new Error(`S2 failure taxonomy retry policy mismatch for ${code}`);
    }
}
