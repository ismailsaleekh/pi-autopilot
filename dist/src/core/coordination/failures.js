export const COORDINATION_FAILURE_CODES = [
    'invalid-request',
    'invalid-state',
    'protocol-mismatch',
    'schema-mismatch',
    'frame-too-large',
    'unauthorized-client',
    'coordinator-unavailable',
    'coordinator-contention',
    'fenced-session',
    'stale-version',
    'idempotency-conflict',
    'request-timeout',
    'recovery-required',
    'git-partial-effect',
    'disk-failure',
    'permission-denied',
    'planning-contradiction-review',
    'store-corrupt',
    'system-fatal',
];
const definitions = [
    { code: 'invalid-request', failure_class: 'client-invalid', retry_policy: 'never', operator_decision: false, description: 'Request failed strict schema or semantic validation.' },
    { code: 'invalid-state', failure_class: 'owned-recovery', retry_policy: 'after-reconciliation', operator_decision: false, description: 'Authoritative state violates a coordination invariant.' },
    { code: 'protocol-mismatch', failure_class: 'client-invalid', retry_policy: 'never', operator_decision: false, description: 'Client protocol is incompatible with the coordinator.' },
    { code: 'schema-mismatch', failure_class: 'client-invalid', retry_policy: 'never', operator_decision: false, description: 'Client schema is incompatible with the coordinator store.' },
    { code: 'frame-too-large', failure_class: 'client-invalid', retry_policy: 'never', operator_decision: false, description: 'IPC frame exceeds the package bound.' },
    { code: 'unauthorized-client', failure_class: 'client-invalid', retry_policy: 'never', operator_decision: false, description: 'Client capability or identity proof is invalid.' },
    { code: 'coordinator-unavailable', failure_class: 'retryable-contention', retry_policy: 'same-idempotency-key', operator_decision: false, description: 'Coordinator is unavailable and may be restarted locally.' },
    { code: 'coordinator-contention', failure_class: 'retryable-contention', retry_policy: 'same-idempotency-key', operator_decision: false, description: 'Bounded transactional contention prevented this attempt.' },
    { code: 'fenced-session', failure_class: 'fenced-client', retry_policy: 'after-reattach', operator_decision: false, description: 'A newer session generation fenced this client.' },
    { code: 'stale-version', failure_class: 'retryable-contention', retry_policy: 'same-idempotency-key', operator_decision: false, description: 'Expected prior entity version no longer matches.' },
    { code: 'idempotency-conflict', failure_class: 'client-invalid', retry_policy: 'never', operator_decision: false, description: 'An idempotency key was reused with a different request.' },
    { code: 'request-timeout', failure_class: 'retryable-contention', retry_policy: 'same-idempotency-key', operator_decision: false, description: 'Client did not observe a response before its bounded timeout.' },
    { code: 'recovery-required', failure_class: 'owned-recovery', retry_policy: 'after-reconciliation', operator_decision: false, description: 'The owning run supervisor must reconcile durable state.' },
    { code: 'git-partial-effect', failure_class: 'owned-recovery', retry_policy: 'after-reconciliation', operator_decision: false, description: 'A Git or filesystem saga requires postcondition reconciliation.' },
    { code: 'disk-failure', failure_class: 'owned-recovery', retry_policy: 'after-reconciliation', operator_decision: false, description: 'Disk capacity or I/O failure interrupted an owned operation.' },
    { code: 'permission-denied', failure_class: 'owned-recovery', retry_policy: 'after-reconciliation', operator_decision: false, description: 'Filesystem authority prevented an owned operation.' },
    { code: 'planning-contradiction-review', failure_class: 'contradiction-review', retry_policy: 'never', operator_decision: true, description: 'A complete independently adjudicated planning contradiction awaits a decision.' },
    { code: 'store-corrupt', failure_class: 'system-fatal', retry_policy: 'never', operator_decision: false, description: 'Coordinator integrity checks prove store corruption.' },
    { code: 'system-fatal', failure_class: 'system-fatal', retry_policy: 'never', operator_decision: false, description: 'An unrecoverable local system condition requires a safety halt.' },
];
export const COORDINATION_FAILURE_TAXONOMY = Object.freeze(definitions);
export function coordinationFailureDefinition(code) {
    const definition = COORDINATION_FAILURE_TAXONOMY.find((candidate) => candidate.code === code);
    if (definition === undefined)
        throw new Error(`Coordination failure taxonomy is incomplete for ${code}`);
    return definition;
}
export const COORDINATION_FAILURE_MATRIX = Object.freeze([
    { scenario: 'client-timeout-before-response', failure_code: 'request-timeout', durable_effect: 'unknown-until-replay', required_response: 'retry the identical idempotency key and inspect the committed sequence', forbidden_response: 'issue a new mutation identity' },
    { scenario: 'duplicate-or-delayed-request', failure_code: null, durable_effect: 'single-committed-effect', required_response: 'return the original committed result for the same idempotency key', forbidden_response: 'apply the effect twice' },
    { scenario: 'stale-session-generation', failure_code: 'fenced-session', durable_effect: 'none', required_response: 'reject and require attachment with a new generation', forbidden_response: 'rewrite or release durable run-owned claims' },
    { scenario: 'coordinator-crash-before-commit', failure_code: 'coordinator-unavailable', durable_effect: 'none', required_response: 'restart and retry the identical idempotency key', forbidden_response: 'infer that the effect committed' },
    { scenario: 'coordinator-crash-after-commit', failure_code: 'coordinator-unavailable', durable_effect: 'single-committed-effect', required_response: 'recover the committed transaction and return it on retry', forbidden_response: 'repeat the committed effect' },
    { scenario: 'store-integrity-failure', failure_code: 'store-corrupt', durable_effect: 'safety-halt', required_response: 'halt loudly and produce bounded diagnostics', forbidden_response: 'fall back to mutable legacy coordination' },
    { scenario: 'disk-capacity-or-io-failure', failure_code: 'disk-failure', durable_effect: 'prepared-recovery-work', required_response: 'retain operation intent and reconcile after capacity recovery', forbidden_response: 'report external action success without verification' },
    { scenario: 'filesystem-permission-failure', failure_code: 'permission-denied', durable_effect: 'prepared-recovery-work', required_response: 'retain owner-scoped recovery state', forbidden_response: 'delete or repair a foreign run path' },
    { scenario: 'git-or-filesystem-partial-effect', failure_code: 'git-partial-effect', durable_effect: 'prepared-recovery-work', required_response: 'inspect postconditions and complete or compensate idempotently', forbidden_response: 'guess success from process termination' },
]);
export class CoordinationRuntimeError extends Error {
    name = 'CoordinationRuntimeError';
    code;
    failure_class;
    retry_policy;
    evidence;
    constructor(code, message, evidence = []) {
        super(`CoordinationRuntimeError [${code}]: ${message}`);
        const definition = coordinationFailureDefinition(code);
        this.code = code;
        this.failure_class = definition.failure_class;
        this.retry_policy = definition.retry_policy;
        this.evidence = Object.freeze([...evidence]);
    }
}
