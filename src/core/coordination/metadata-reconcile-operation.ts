import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { CoordinatorClient } from './client.ts';
import { parseCoordinationWorktree, parseCoordinationWorktreeOperation } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import {
  reconcileApprovedMissingWorktreeMetadata,
  type MetadataReconcileApproval,
  type MetadataReconcileBatchResult,
} from './metadata-reconcile-runtime.ts';
import { parseMetadataReconcileIntent } from './metadata-reconcile.ts';
import type { CoordinatorSessionContext } from './supervisor.ts';
import type { CoordinationEvidenceRef, CoordinationWorktree, CoordinationWorktreeOperation } from './types.ts';
import { deriveWorktreeOperationKeyV2, operationIdFromWorktreeOperationKey } from './worktree-operation-identity.ts';
import { deterministicWorktreeId } from './worktree-identity.ts';
import type { GitProcessEnv } from '../git-process.ts';

export interface PersistedMetadataReconcileApproval extends MetadataReconcileApproval {
  readonly worktree: CoordinationWorktree;
}

export interface MetadataReconcileOperationResult {
  readonly batch: MetadataReconcileBatchResult;
  readonly operations: readonly Extract<CoordinationWorktreeOperation, { readonly operation_type: 'metadata-reconcile' }>[];
}

const COMPLETED_STEPS = Object.freeze(['preflight-probe', 'external-action', 'postcondition-verification'] as const);

type MetadataOperation = Extract<CoordinationWorktreeOperation, { readonly operation_type: 'metadata-reconcile' }>;

function sessionProof(session: CoordinatorSessionContext): Readonly<Record<string, string>> {
  return Object.freeze({ session_lease_id: session.session_lease_id, session_token: session.session_token });
}

function operationIdentity(session: CoordinatorSessionContext, idempotencyKey: string, expectedVersion: number) {
  return {
    repoId: session.repo_id,
    workstreamRun: session.workstream_run,
    sessionId: session.session_id,
    fencingGeneration: session.session_generation,
    expectedVersion,
    idempotencyKey,
  };
}

function metadataOperations(payload: Readonly<Record<string, unknown>>): readonly MetadataOperation[] {
  const values = payload['worktree_operations'];
  if (!Array.isArray(values)) throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation status omitted durable worktree operations');
  return Object.freeze(values.map((value) => parseCoordinationWorktreeOperation(value)).filter((operation): operation is MetadataOperation => operation.operation_type === 'metadata-reconcile'));
}

async function currentWorktreeVersion(client: CoordinatorClient, session: CoordinatorSessionContext, worktreeId: string): Promise<number> {
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const values = status.payload['worktrees'];
  if (!Array.isArray(values)) throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation status omitted durable worktrees');
  return values.map((value) => parseCoordinationWorktree(value)).find((worktree) => worktree.worktree_id === worktreeId)?.version ?? 0;
}

async function currentOperation(client: CoordinatorClient, session: CoordinatorSessionContext, operationId: string): Promise<MetadataOperation> {
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const operation = metadataOperations(status.payload).find((candidate) => candidate.operation_id === operationId);
  if (operation === undefined) throw new CoordinationRuntimeError('invalid-state', 'persisted metadata reconciliation operation disappeared', [operationId]);
  return operation;
}

async function transition(input: {
  readonly client: CoordinatorClient;
  readonly session: CoordinatorSessionContext;
  readonly operation: MetadataOperation;
  readonly stage: 'in-progress' | 'verified' | 'committed' | 'reconciling';
  readonly completedSteps: readonly string[];
  readonly currentStep: string | null;
  readonly recoveryAttempts: number;
  readonly evidence: CoordinationEvidenceRef | null;
  readonly errorCode: string | null;
  readonly worktreeState: CoordinationWorktree['state'];
}): Promise<MetadataOperation> {
  const response = await input.client.mutate('transition-operation', operationIdentity(
    input.session,
    `metadata-reconcile:${input.operation.operation_id}:${input.stage}:v${String(input.operation.version)}`,
    input.operation.version,
  ), {
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
  if (operation.operation_type !== 'metadata-reconcile') throw new CoordinationRuntimeError('store-corrupt', 'metadata reconciliation transition returned an ordinary operation');
  return operation;
}

function validateApproval(session: CoordinatorSessionContext, approval: PersistedMetadataReconcileApproval): MetadataOperation {
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

async function evidenceRef(worktreeRoot: string, session: CoordinatorSessionContext, path: string): Promise<CoordinationEvidenceRef> {
  const expectedRoot = join(worktreeRoot, '_saga-evidence', session.workstream_run);
  const rel = relative(worktreeRoot, path).split(sep).join('/');
  if (!rel.startsWith(`_saga-evidence/${session.workstream_run}/metadata-reconcile/`)) throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation runtime published evidence outside its operation-owned root', [path, expectedRoot]);
  const bytes = await readFile(path);
  return Object.freeze({ ref: rel, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
}

/**
 * Production consumer for C3/I5 metadata-only reconciliation. Every exact-set
 * approval is durable before Git mutation, resumes from persisted stages, and
 * commits only after the store revalidates immutable runtime evidence.
 */
export async function executeApprovedMetadataReconcileOperations(input: {
  readonly client: CoordinatorClient;
  readonly session: CoordinatorSessionContext;
  readonly worktree_root: string;
  readonly approvals: readonly PersistedMetadataReconcileApproval[];
  readonly env?: GitProcessEnv;
  readonly observe_before_final_drift_check?: () => Promise<void> | void;
}): Promise<MetadataReconcileOperationResult> {
  if (input.approvals.length === 0) throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation operation consumer requires at least one approval');
  const prepared = input.approvals.map((approval) => ({ approval, operation: validateApproval(input.session, approval) }));
  for (const entry of prepared) {
    const key = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: entry.operation.intent.canonical_worktree_id, operationType: 'metadata-reconcile', completeImmutableIntent: entry.operation.intent });
    const expectedWorktreeVersion = await currentWorktreeVersion(input.client, input.session, entry.approval.worktree.worktree_id);
    await input.client.mutate('prepare-operation', operationIdentity(input.session, key.operation_key_sha256, expectedWorktreeVersion), {
      worktree: entry.approval.worktree,
      operation: entry.operation,
      ...sessionProof(input.session),
    });
    const current = await currentOperation(input.client, input.session, entry.operation.operation_id);
    if (current.stage === 'prepared') {
      await transition({ client: input.client, session: input.session, operation: current, stage: 'in-progress', completedSteps: [], currentStep: 'preflight-probe', recoveryAttempts: current.recovery_attempts, evidence: null, errorCode: null, worktreeState: entry.approval.worktree.state });
    } else if (current.stage === 'compensated' || current.stage === 'failed') {
      throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation operation is terminal without a committed exact-set transition', [current.operation_id, current.stage]);
    }
  }

  const evidenceRoot = join(input.worktree_root, '_saga-evidence', input.session.workstream_run);
  let batch: MetadataReconcileBatchResult;
  try {
    batch = await reconcileApprovedMissingWorktreeMetadata({
      approvals: input.approvals,
      evidence_root: evidenceRoot,
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.observe_before_final_drift_check === undefined ? {} : { observe_before_final_drift_check: input.observe_before_final_drift_check }),
    });
  } catch (error) {
    const transitionFailures: unknown[] = [];
    for (const entry of prepared) {
      try {
        const current = await currentOperation(input.client, input.session, entry.operation.operation_id);
        if (current.stage === 'prepared' || current.stage === 'in-progress' || current.stage === 'reconciling') {
          await transition({ client: input.client, session: input.session, operation: current, stage: 'reconciling', completedSteps: current.completed_steps, currentStep: current.current_step ?? 'external-action', recoveryAttempts: current.recovery_attempts + 1, evidence: current.verification_evidence, errorCode: 'metadata-reconcile-runtime-failure', worktreeState: entry.approval.worktree.state });
        }
      } catch (transitionError) { transitionFailures.push(transitionError); }
    }
    if (transitionFailures.length > 0) throw new AggregateError([error, ...transitionFailures], 'metadata reconciliation failed and durable recovery-state publication was incomplete');
    throw error;
  }

  const evidenceByCanonicalId = new Map<string, CoordinationEvidenceRef>();
  for (const path of batch.evidence_paths) {
    const name = path.slice(path.lastIndexOf(sep) + 1).replace(/\.json$/u, '');
    evidenceByCanonicalId.set(name, await evidenceRef(input.worktree_root, input.session, path));
  }
  const committed: MetadataOperation[] = [];
  for (const entry of prepared) {
    let current = await currentOperation(input.client, input.session, entry.operation.operation_id);
    const evidence = evidenceByCanonicalId.get(entry.operation.intent.canonical_worktree_id);
    if (evidence === undefined) throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation batch omitted operation evidence', [entry.operation.intent.canonical_worktree_id]);
    if (current.stage === 'prepared') current = await transition({ client: input.client, session: input.session, operation: current, stage: 'in-progress', completedSteps: [], currentStep: 'preflight-probe', recoveryAttempts: current.recovery_attempts, evidence: null, errorCode: null, worktreeState: entry.approval.worktree.state });
    if (current.stage === 'in-progress' || current.stage === 'reconciling') current = await transition({ client: input.client, session: input.session, operation: current, stage: 'verified', completedSteps: COMPLETED_STEPS, currentStep: null, recoveryAttempts: current.recovery_attempts, evidence, errorCode: null, worktreeState: entry.approval.worktree.state });
    if (current.stage === 'verified') current = await transition({ client: input.client, session: input.session, operation: current, stage: 'committed', completedSteps: COMPLETED_STEPS, currentStep: null, recoveryAttempts: current.recovery_attempts, evidence, errorCode: null, worktreeState: entry.approval.worktree.state });
    if (current.stage !== 'committed') throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation did not reach committed durable authority', [current.operation_id, current.stage]);
    committed.push(current);
  }
  return Object.freeze({ batch, operations: Object.freeze(committed) });
}
