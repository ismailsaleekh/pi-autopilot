import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseCoordinationWorktree, parseCoordinationWorktreeOperation } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { reconcileApprovedMissingWorktreeMetadata, } from "./metadata-reconcile-runtime.js";
import { parseMetadataReconcileIntent } from "./metadata-reconcile.js";
import { deriveWorktreeOperationKeyV2, operationIdFromWorktreeOperationKey } from "./worktree-operation-identity.js";
import { deterministicWorktreeId } from "./worktree-identity.js";
const COMPLETED_STEPS = Object.freeze(['preflight-probe', 'external-action', 'postcondition-verification']);
function sessionProof(session) {
    return Object.freeze({ session_lease_id: session.session_lease_id, session_token: session.session_token });
}
function operationIdentity(session, idempotencyKey, expectedVersion) {
    return {
        repoId: session.repo_id,
        workstreamRun: session.workstream_run,
        sessionId: session.session_id,
        fencingGeneration: session.session_generation,
        expectedVersion,
        idempotencyKey,
    };
}
function metadataOperations(payload) {
    const values = payload['worktree_operations'];
    if (!Array.isArray(values))
        throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation status omitted durable worktree operations');
    return Object.freeze(values.map((value) => parseCoordinationWorktreeOperation(value)).filter((operation) => operation.operation_type === 'metadata-reconcile'));
}
async function currentWorktreeVersion(client, session, worktreeId) {
    const status = await client.query('status', session.repo_id, session.workstream_run);
    const values = status.payload['worktrees'];
    if (!Array.isArray(values))
        throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation status omitted durable worktrees');
    return values.map((value) => parseCoordinationWorktree(value)).find((worktree) => worktree.worktree_id === worktreeId)?.version ?? 0;
}
async function currentOperation(client, session, operationId) {
    const status = await client.query('status', session.repo_id, session.workstream_run);
    const operation = metadataOperations(status.payload).find((candidate) => candidate.operation_id === operationId);
    if (operation === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'persisted metadata reconciliation operation disappeared', [operationId]);
    return operation;
}
async function transition(input) {
    const response = await input.client.mutate('transition-operation', operationIdentity(input.session, `metadata-reconcile:${input.operation.operation_id}:${input.stage}:v${String(input.operation.version)}`, input.operation.version), {
        operation_id: input.operation.operation_id,
        stage: input.stage,
        completed_steps: input.completedSteps,
        current_step: input.currentStep,
        recovery_attempts: input.recoveryAttempts,
        verification_evidence: input.evidence,
        error_code: input.errorCode,
        worktree_state: input.worktreeState,
        ...sessionProof(input.session),
    });
    const operation = parseCoordinationWorktreeOperation(response.payload['operation']);
    if (operation.operation_type !== 'metadata-reconcile')
        throw new CoordinationRuntimeError('store-corrupt', 'metadata reconciliation transition returned an ordinary operation');
    return operation;
}
function validateApproval(session, approval) {
    const intent = parseMetadataReconcileIntent(approval.intent);
    const worktree = approval.worktree;
    const canonicalId = deterministicWorktreeId(worktree.owner, worktree.kind);
    if (session.repo_id !== worktree.owner.repo_id
        || session.autopilot_id !== worktree.owner.autopilot_id
        || session.workstream_run !== worktree.owner.workstream_run
        || intent.repo_id !== session.repo_id
        || worktree.worktree_id !== canonicalId
        || intent.canonical_worktree_id !== canonicalId
        || intent.target_registration_path !== worktree.canonical_path
        || intent.git_common_dir !== worktree.git_common_dir) {
        throw new CoordinationRuntimeError('unauthorized-client', 'metadata reconciliation approval differs from its attached canonical worktree authority', [worktree.worktree_id, intent.canonical_worktree_id]);
    }
    const key = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: canonicalId, operationType: 'metadata-reconcile', completeImmutableIntent: intent });
    return {
        schema_version: 'autopilot.worktree_operation.v2',
        operation_id: operationIdFromWorktreeOperationKey(key),
        worktree_id: worktree.worktree_id,
        owner: worktree.owner,
        operation_type: 'metadata-reconcile',
        stage: 'prepared',
        authority_version: worktree.version,
        intent_event_seq: 0,
        intent,
        completed_steps: [],
        current_step: null,
        recovery_attempts: 0,
        verification_evidence: null,
        error_code: null,
        version: 1,
    };
}
async function evidenceRef(worktreeRoot, session, path) {
    const expectedRoot = join(worktreeRoot, '_saga-evidence', session.workstream_run);
    const rel = relative(worktreeRoot, path).split(sep).join('/');
    if (!rel.startsWith(`_saga-evidence/${session.workstream_run}/metadata-reconcile/`))
        throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation runtime published evidence outside its operation-owned root', [path, expectedRoot]);
    const bytes = await readFile(path);
    return Object.freeze({ ref: rel, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
}
async function markBatchRecovering(entries, persistedOperationIds, errorCode) {
    const failures = [];
    for (const entry of entries) {
        if (!persistedOperationIds.has(entry.operation.operation_id))
            continue;
        try {
            const current = await currentOperation(entry.client, entry.session, entry.operation.operation_id);
            if (current.stage === 'prepared' || current.stage === 'in-progress' || current.stage === 'reconciling') {
                await transition({
                    client: entry.client,
                    session: entry.session,
                    operation: current,
                    stage: 'reconciling',
                    completedSteps: current.completed_steps,
                    currentStep: current.current_step ?? (current.stage === 'prepared' ? 'preflight-probe' : 'external-action'),
                    recoveryAttempts: current.recovery_attempts + 1,
                    evidence: current.verification_evidence,
                    errorCode,
                    worktreeState: entry.approval.worktree.state,
                });
            }
        }
        catch (error) {
            failures.push(error);
        }
    }
    return Object.freeze(failures);
}
/**
 * Repository-wide C3/I5 production consumer. Every row is first persisted under
 * its own run/session authority; only then may one exact-set Git metadata
 * mutation execute. Evidence and terminal operation state return to each
 * operation owner's package-private run root.
 */
export async function executeApprovedMetadataReconcileBatch(input) {
    if (input.entries.length === 0)
        throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation operation consumer requires at least one approval');
    const prepared = input.entries.map((entry) => ({ ...entry, operation: validateApproval(entry.session, entry.approval) }));
    const operationIds = new Set(prepared.map((entry) => entry.operation.operation_id));
    const canonicalIds = new Set(prepared.map((entry) => entry.operation.intent.canonical_worktree_id));
    if (operationIds.size !== prepared.length || canonicalIds.size !== prepared.length)
        throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation batch contains duplicate operation or canonical worktree authority');
    const first = prepared[0];
    if (first === undefined)
        throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation operation set disappeared');
    for (const entry of prepared) {
        const expectedWorktreeRoot = resolve(entry.session.state_root, 'worktrees', entry.session.repo_key);
        if (entry.session.repo_id !== first.session.repo_id
            || entry.session.repo_key !== first.session.repo_key
            || resolve(entry.session.state_root) !== resolve(first.session.state_root)
            || resolve(entry.worktree_root) !== expectedWorktreeRoot
            || entry.operation.intent.repo_id !== first.operation.intent.repo_id
            || entry.operation.intent.git_common_dir !== first.operation.intent.git_common_dir)
            throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation operation batch crosses repository or package-owned evidence authority');
    }
    const persistedOperationIds = new Set();
    try {
        for (const entry of prepared) {
            const key = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: entry.operation.intent.canonical_worktree_id, operationType: 'metadata-reconcile', completeImmutableIntent: entry.operation.intent });
            const expectedWorktreeVersion = await currentWorktreeVersion(entry.client, entry.session, entry.approval.worktree.worktree_id);
            await entry.client.mutate('prepare-operation', operationIdentity(entry.session, key.operation_key_sha256, expectedWorktreeVersion), {
                worktree: entry.approval.worktree,
                operation: entry.operation,
                ...sessionProof(entry.session),
            });
            persistedOperationIds.add(entry.operation.operation_id);
            const current = await currentOperation(entry.client, entry.session, entry.operation.operation_id);
            if (current.stage === 'prepared') {
                await transition({ client: entry.client, session: entry.session, operation: current, stage: 'in-progress', completedSteps: [], currentStep: 'preflight-probe', recoveryAttempts: current.recovery_attempts, evidence: null, errorCode: null, worktreeState: entry.approval.worktree.state });
            }
            else if (current.stage === 'compensated' || current.stage === 'failed') {
                throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation operation is terminal without a committed exact-set transition', [current.operation_id, current.stage]);
            }
        }
    }
    catch (error) {
        const transitionFailures = await markBatchRecovering(prepared, persistedOperationIds, 'metadata-reconcile-batch-preparation-failure');
        if (transitionFailures.length > 0)
            throw new AggregateError([error, ...transitionFailures], 'metadata reconciliation preparation failed and durable recovery-state publication was incomplete');
        throw error;
    }
    let batch;
    try {
        batch = await reconcileApprovedMissingWorktreeMetadata({
            approvals: prepared.map((entry) => entry.approval),
            evidence_roots: prepared.map((entry) => ({
                canonical_worktree_id: entry.operation.intent.canonical_worktree_id,
                evidence_root: join(entry.worktree_root, '_saga-evidence', entry.session.workstream_run),
            })),
            ...(input.env === undefined ? {} : { env: input.env }),
            ...(input.observe_before_final_drift_check === undefined ? {} : { observe_before_final_drift_check: input.observe_before_final_drift_check }),
        });
    }
    catch (error) {
        const transitionFailures = await markBatchRecovering(prepared, persistedOperationIds, 'metadata-reconcile-runtime-failure');
        if (transitionFailures.length > 0)
            throw new AggregateError([error, ...transitionFailures], 'metadata reconciliation failed and durable recovery-state publication was incomplete');
        throw error;
    }
    const evidencePaths = new Map();
    for (const path of batch.evidence_paths) {
        const canonicalId = path.slice(path.lastIndexOf(sep) + 1).replace(/\.json$/u, '');
        if (evidencePaths.has(canonicalId))
            throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation batch published duplicate operation evidence', [canonicalId]);
        evidencePaths.set(canonicalId, path);
    }
    const committed = [];
    const transitionFailures = [];
    for (const entry of prepared) {
        try {
            let current = await currentOperation(entry.client, entry.session, entry.operation.operation_id);
            const path = evidencePaths.get(entry.operation.intent.canonical_worktree_id);
            if (path === undefined)
                throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation batch omitted operation evidence', [entry.operation.intent.canonical_worktree_id]);
            const evidence = await evidenceRef(entry.worktree_root, entry.session, path);
            if (current.stage === 'prepared')
                current = await transition({ client: entry.client, session: entry.session, operation: current, stage: 'in-progress', completedSteps: [], currentStep: 'preflight-probe', recoveryAttempts: current.recovery_attempts, evidence: null, errorCode: null, worktreeState: entry.approval.worktree.state });
            if (current.stage === 'in-progress' || current.stage === 'reconciling')
                current = await transition({ client: entry.client, session: entry.session, operation: current, stage: 'verified', completedSteps: COMPLETED_STEPS, currentStep: null, recoveryAttempts: current.recovery_attempts, evidence, errorCode: null, worktreeState: entry.approval.worktree.state });
            if (current.stage === 'verified')
                current = await transition({ client: entry.client, session: entry.session, operation: current, stage: 'committed', completedSteps: COMPLETED_STEPS, currentStep: null, recoveryAttempts: current.recovery_attempts, evidence, errorCode: null, worktreeState: entry.approval.worktree.state });
            if (current.stage !== 'committed')
                throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation did not reach committed durable authority', [current.operation_id, current.stage]);
            committed.push(current);
        }
        catch (error) {
            transitionFailures.push(error);
        }
    }
    if (transitionFailures.length > 0)
        throw new AggregateError(transitionFailures, 'metadata reconciliation Git postcondition succeeded but one or more durable operation commits failed');
    return Object.freeze({ batch, operations: Object.freeze(committed) });
}
/** One-run specialization retained for ordinary cleanup consumers. */
export async function executeApprovedMetadataReconcileOperations(input) {
    return await executeApprovedMetadataReconcileBatch({
        entries: input.approvals.map((approval) => ({ client: input.client, session: input.session, worktree_root: input.worktree_root, approval })),
        ...(input.env === undefined ? {} : { env: input.env }),
        ...(input.observe_before_final_drift_check === undefined ? {} : { observe_before_final_drift_check: input.observe_before_final_drift_check }),
    });
}
