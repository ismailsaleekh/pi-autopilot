import { createHash } from 'node:crypto';

import {
  parseCoordinationAcquisitionGroup,
  parseCoordinationAdjudicationAssignment,
  parseCoordinationAuthoritativeArtifact,
  parseCoordinationChildLease,
  parseCoordinationClaimRequest,
  parseCoordinationEscalation,
  parseCoordinationMailboxDeliveryReceipt,
  parseCoordinationMessage,
  parseCoordinationMigrationRecoveryWork,
  parseCoordinationReconciliationEvidence,
  parseCoordinationReconciliationReceipt,
  parseCoordinationReservationObligation,
  parseCoordinationRun,
  parseCoordinationSessionLease,
  parseCoordinationUnitAttempt,
  parseCoordinationWorktreeOperation,
} from './contracts.ts';
import { canonicalJson } from './canonical-json.ts';
import { parseD65HeartbeatAcceptanceResult } from './d65-launch-policy.ts';
import { parseRunScopedLogicalFault } from './logical-faults.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type { CoordinationChildLease, CoordinationSessionLease } from './types.ts';

// D65 semantic-version history normalizer. Purity is proven from an accepted
// event joined to its exact immutable idempotency result; event_type alone is
// never purity authority. Store callers must supply every relevant event through
// the covered E and represent a missing result as null so this module fails loud.

export interface D65AcceptedEventResultJoin {
  readonly repo_id: string;
  readonly event_seq: number;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly idempotency_key: string;
  readonly request_sha256: string;
  readonly result: null | Readonly<{
    repo_id: string;
    idempotency_key: string;
    request_sha256: string;
    committed_event_seq: number;
    payload: Readonly<Record<string, unknown>>;
  }>;
}

function fail(issue: string, evidence: readonly string[] = []): never {
  throw new CoordinationRuntimeError('store-corrupt', `D65 semantic-version history is incomplete or mismatched: ${issue}`, [...evidence]);
}

function exactJoin(row: D65AcceptedEventResultJoin): Readonly<Record<string, unknown>> {
  const result = row.result;
  if (result === null) fail('accepted event lacks its immutable idempotency result', [row.repo_id, String(row.event_seq), row.idempotency_key]);
  if (result.repo_id !== row.repo_id || result.idempotency_key !== row.idempotency_key || result.request_sha256 !== row.request_sha256 || result.committed_event_seq !== row.event_seq) {
    fail('event/result join does not match repo, sequence, idempotency key, and request SHA-256 exactly', [row.repo_id, String(row.event_seq), row.idempotency_key]);
  }
  return result.payload;
}

function exactKeys(payload: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(payload).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function oneOwner(row: D65AcceptedEventResultJoin, workstreamRun: string): readonly string[] {
  if (workstreamRun.length === 0) fail('event result has an empty workstream owner', [String(row.event_seq), row.event_type]);
  return Object.freeze([workstreamRun]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadObject(payload: Readonly<Record<string, unknown>>, key: string, row: D65AcceptedEventResultJoin): Readonly<Record<string, unknown>> {
  const value = payload[key];
  if (!isRecord(value)) fail('event result lacks its primary owner record', [String(row.event_seq), row.event_type, key]);
  return value;
}

function directRun(record: Readonly<Record<string, unknown>>, row: D65AcceptedEventResultJoin, label: string): string {
  const value = record['workstream_run'];
  if (typeof value !== 'string' || value.length === 0) fail('event primary record lacks a direct workstream owner', [String(row.event_seq), row.event_type, label]);
  return value;
}

function sortedUniqueStrings(value: unknown, row: D65AcceptedEventResultJoin, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200_000 || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) fail('internal event owner result has an invalid bounded string array', [String(row.event_seq), row.event_type, label]);
  const strings = value;
  if (new Set(strings).size !== strings.length || strings.some((entry, index) => index > 0 && (strings[index - 1] ?? '') >= entry)) fail('internal event owner result string array is not unique and sorted', [String(row.event_seq), row.event_type, label]);
  return Object.freeze([...strings]);
}

/**
 * Resolve the exact run or runs for which an accepted repository event is
 * semantic. This is deliberately event-shape-specific: recursively searching
 * arbitrary payload fields would let a foreign related/requester run masquerade
 * as the mutation owner. Every result is first joined to its immutable event,
 * then its production primary record is parsed before its owner is returned.
 */
export function d65SemanticEventWorkstreamRuns(row: D65AcceptedEventResultJoin): readonly string[] {
  const payload = exactJoin(row);
  try {
    switch (row.event_type) {
      case 'run-attached':
      case 'run-reconciled': {
        const run = parseCoordinationRun(payload['run']);
        if (row.entity_type !== 'run' || row.entity_id !== run.workstream_run) fail('run event metadata differs from its primary record', [String(row.event_seq), row.event_type]);
        return oneOwner(row, run.workstream_run);
      }
      case 'startup-run-reconciled': {
        const run = parseCoordinationRun(payload['run']);
        const receipt = parseCoordinationReconciliationReceipt(payload['reconciliation_receipt']);
        if (!exactKeys(payload, ['entity_id', 'entity_type', 'event_type', 'reconciliation_receipt', 'run']) || payload['event_type'] !== row.event_type || payload['entity_type'] !== row.entity_type || payload['entity_id'] !== row.entity_id || row.entity_type !== 'run' || row.entity_id !== run.workstream_run || receipt.repo_id !== row.repo_id || receipt.workstream_run !== run.workstream_run || receipt.committed_event_seq !== row.event_seq || receipt.source_action !== 'startup-reconciliation') fail('startup reconciliation result differs from its exact run/event/receipt authority', [String(row.event_seq)]);
        const digest = `sha256:${createHash('sha256').update(`${canonicalJson(payload)}\n`, 'utf8').digest('hex')}`;
        if (digest !== row.request_sha256) fail('startup reconciliation result digest does not equal its immutable event request digest', [String(row.event_seq)]);
        return oneOwner(row, run.workstream_run);
      }
      case 'session-attached':
      case 'session-detached':
      case 'session-handoff-prepared':
      case 'session-heartbeat':
      case 'terminal-cleanup-recovery-attached': {
        const session = parseCoordinationSessionLease(payload['session']);
        if (row.entity_type !== 'session-lease' || row.entity_id !== session.session_lease_id) fail('session event metadata differs from its primary record', [String(row.event_seq), row.event_type]);
        return oneOwner(row, session.workstream_run);
      }
      case 'migration-recovery-attached': {
        const session = parseCoordinationSessionLease(payload['session']);
        if (row.entity_type !== 'session-lease' || row.entity_id !== session.session_lease_id) fail('migration attach event metadata differs from its session', [String(row.event_seq)]);
        return oneOwner(row, session.workstream_run);
      }
      case 'migration-recovery-resolved': {
        const recovery = parseCoordinationMigrationRecoveryWork(payload['recovery_work']);
        if (row.entity_type !== 'migration-recovery-work' || row.entity_id !== recovery.recovery_id) fail('migration resolution event metadata differs from its recovery record', [String(row.event_seq)]);
        return oneOwner(row, recovery.workstream_run);
      }
      case 'program-heartbeat-accepted': {
        const acceptance = parseD65HeartbeatAcceptanceResult(payload);
        if (row.entity_type !== 'program-heartbeat' || row.entity_id !== acceptance.workstream_run) fail('program heartbeat event metadata differs from its acceptance result', [String(row.event_seq)]);
        return oneOwner(row, acceptance.workstream_run);
      }
      case 'unit-attempt-registered':
      case 'unit-attempt-verified':
      case 'unit-attempt-checkpointed':
      case 'unit-attempt-superseded': {
        const attempt = parseCoordinationUnitAttempt(payload['unit_attempt']);
        if (row.entity_type !== 'unit-attempt') fail('unit attempt event has the wrong entity type', [String(row.event_seq), row.event_type]);
        return oneOwner(row, attempt.owner.workstream_run);
      }
      case 'child-registered':
      case 'child-heartbeat':
      case 'child-terminal':
      case 'child-recovery-required': {
        const child = parseCoordinationChildLease(payload['child']);
        if (row.entity_type !== 'child-lease' || row.entity_id !== child.child_lease_id) fail('child event metadata differs from its primary record', [String(row.event_seq), row.event_type]);
        return oneOwner(row, child.owner.workstream_run);
      }
      case 'grant-offers-expired': {
        if (!exactKeys(payload, ['affected_acquisition_group_ids', 'affected_workstream_runs', 'entity_id', 'entity_type', 'event_type']) || payload['event_type'] !== row.event_type || payload['entity_type'] !== 'repository' || payload['entity_id'] !== row.repo_id || row.entity_type !== 'repository' || row.entity_id !== row.repo_id) fail('grant-offer sweep result metadata differs from its repository event', [String(row.event_seq)]);
        sortedUniqueStrings(payload['affected_acquisition_group_ids'], row, 'affected_acquisition_group_ids');
        const runs = sortedUniqueStrings(payload['affected_workstream_runs'], row, 'affected_workstream_runs');
        const digest = `sha256:${createHash('sha256').update(`${canonicalJson(payload)}\n`, 'utf8').digest('hex')}`;
        if (digest !== row.request_sha256) fail('grant-offer sweep result digest does not equal its immutable event request digest', [String(row.event_seq)]);
        return runs;
      }
      case 'legacy-authority-rebound':
      case 'acquisition-group-waiting':
      case 'acquisition-group-granted':
      case 'acquisition-group-cancelled':
      case 'grant-offer-expired':
      case 'claim-request-cancelled': {
        const group = parseCoordinationAcquisitionGroup(payload['acquisition_group']);
        if (row.event_type !== 'claim-request-cancelled' && (row.entity_type !== 'acquisition-group' || row.entity_id !== group.acquisition_group_id)) fail('acquisition event metadata differs from its primary record', [String(row.event_seq), row.event_type]);
        return oneOwner(row, group.owner.workstream_run);
      }
      case 'claim-request-deferred':
      case 'claim-request-released': {
        const request = parseCoordinationClaimRequest(payload['claim_request']);
        if (row.entity_type !== 'claim-request' || row.entity_id !== request.request_id) fail('claim event metadata differs from its primary record', [String(row.event_seq), row.event_type]);
        return oneOwner(row, request.owner.workstream_run);
      }
      case 'authoritative-artifact-registered': {
        const artifact = parseCoordinationAuthoritativeArtifact(payload['authoritative_artifact']);
        if (row.entity_type !== 'authoritative-artifact' || row.entity_id !== artifact.artifact_id) fail('artifact event metadata differs from its primary record', [String(row.event_seq)]);
        return oneOwner(row, artifact.source_run);
      }
      case 'adjudication-assigned': {
        const assignment = parseCoordinationAdjudicationAssignment(payload['adjudication_assignment']);
        if (row.entity_type !== 'adjudication-assignment' || row.entity_id !== assignment.assignment_id) fail('adjudication assignment event metadata differs from its primary record', [String(row.event_seq)]);
        return oneOwner(row, assignment.requesting_run);
      }
      case 'adjudication-assignment-claimed': {
        const assignment = parseCoordinationAdjudicationAssignment(payload['adjudication_assignment']);
        if (row.entity_type !== 'adjudication-assignment' || row.entity_id !== assignment.assignment_id) fail('adjudication claim event metadata differs from its primary record', [String(row.event_seq)]);
        return oneOwner(row, assignment.adjudicator.workstream_run);
      }
      case 'adjudication-accepted': {
        const assignment = parseCoordinationAdjudicationAssignment(payload['adjudication_assignment']);
        const child = parseCoordinationChildLease(payload['child']);
        if (row.entity_type !== 'adjudication-assignment' || row.entity_id !== assignment.assignment_id || assignment.child_lease_id !== child.child_lease_id) fail('adjudication acceptance event metadata differs from its exact child/assignment pair', [String(row.event_seq)]);
        return oneOwner(row, child.owner.workstream_run);
      }
      case 'planning-contradiction-accepted': {
        const escalation = parseCoordinationEscalation(payload['escalation']);
        if (row.entity_type !== 'escalation' || row.entity_id !== escalation.escalation_id) fail('planning contradiction event metadata differs from its escalation', [String(row.event_seq)]);
        if (escalation.participating_runs.length === 0) fail('planning contradiction has no participating run owner', [String(row.event_seq)]);
        return Object.freeze([...new Set(escalation.participating_runs)].sort());
      }
      case 'release-evidence-accepted': {
        const evidence = parseCoordinationReconciliationEvidence(payload['reconciliation_evidence']);
        if (row.entity_type !== 'reconciliation-evidence' || row.entity_id !== evidence.reconciliation_evidence_id) fail('release evidence event metadata differs from its primary record', [String(row.event_seq)]);
        return oneOwner(row, evidence.workstream_run);
      }
      case 'reservation-obligation-resolved': {
        const obligation = parseCoordinationReservationObligation(payload['reservation_obligation']);
        if (row.entity_type !== 'reservation-obligation' || row.entity_id !== obligation.obligation_id) fail('reservation obligation event metadata differs from its primary record', [String(row.event_seq)]);
        return oneOwner(row, obligation.workstream_run);
      }
      case 'run-terminal-prepared':
      case 'run-terminal-cancelled': {
        const intent = payloadObject(payload, 'run_terminal_intent', row);
        const intentId = intent['terminal_intent_id'];
        if (row.entity_type !== 'run-terminal-intent' || typeof intentId !== 'string' || row.entity_id !== intentId) fail('terminal intent event metadata differs from its primary record', [String(row.event_seq), row.event_type]);
        return oneOwner(row, directRun(intent, row, 'run_terminal_intent'));
      }
      case 'run-scoped-fault-recorded': {
        return oneOwner(row, directRun(payload, row, 'run_scoped_fault'));
      }
      case 'run-scoped-fault-resolved': {
        const fault = parseRunScopedLogicalFault(payload['run_scoped_fault']);
        if (row.entity_type !== 'run-scoped-fault' || row.entity_id !== fault.fault_id) fail('run fault event metadata differs from its primary record', [String(row.event_seq)]);
        return oneOwner(row, fault.workstream_run);
      }
      case 'mailbox-drained': {
        const delivery = parseCoordinationMailboxDeliveryReceipt(payload['delivery_receipt']);
        if (row.entity_type !== 'session-lease' || row.entity_id !== delivery.delivery_id) fail('mailbox drain event metadata differs from its delivery receipt', [String(row.event_seq), row.entity_type]);
        return oneOwner(row, delivery.workstream_run);
      }
      case 'message-acknowledged': {
        const message = parseCoordinationMessage(payload['message']);
        if (row.entity_type !== 'message' || row.entity_id !== message.message_id) fail('message acknowledgement metadata differs from its primary record', [String(row.event_seq)]);
        return oneOwner(row, message.recipient_workstream_run);
      }
      case 'worktree-operation-prepared':
      case 'worktree-operation-in-progress':
      case 'worktree-operation-verified':
      case 'worktree-operation-reconciling':
      case 'worktree-operation-committed':
      case 'worktree-operation-compensated':
      case 'worktree-operation-failed': {
        const operation = parseCoordinationWorktreeOperation(payload['operation']);
        if (row.entity_type !== 'worktree-operation' || row.entity_id !== operation.operation_id) fail('worktree operation event metadata differs from its primary record', [String(row.event_seq), row.event_type]);
        return oneOwner(row, operation.owner.workstream_run);
      }
      default:
        fail('event type has no exact D65 run-owner resolver', [String(row.event_seq), row.event_type]);
    }
  } catch (error) {
    if (error instanceof CoordinationRuntimeError && error.code === 'store-corrupt' && error.message.includes('D65 semantic-version history is incomplete or mismatched:')) throw error;
    fail('event primary owner record is malformed', [String(row.event_seq), row.event_type, error instanceof Error ? error.message : String(error)]);
  }
}

/**
 * A session heartbeat is pure only when its exact result proves the sole row
 * change was lease expiry/raw-version and reconciliation/mailbox effects were
 * empty. The current store's empty reconciliation is represented by absence of
 * `reconciliation_receipt`; `pending_messages` is an observation, not mutation.
 */
export function isPureD65SessionHeartbeat(row: D65AcceptedEventResultJoin): boolean {
  if (row.event_type !== 'session-heartbeat' || row.entity_type !== 'session-lease') return false;
  const payload = exactJoin(row);
  if (!exactKeys(payload, ['entity_id', 'entity_type', 'event_type', 'pending_messages', 'session'])) return false;
  if (payload['event_type'] !== row.event_type || payload['entity_type'] !== row.entity_type || payload['entity_id'] !== row.entity_id) fail('session-heartbeat immutable result metadata disagrees with its event', [String(row.event_seq)]);
  const pending = payload['pending_messages'];
  if (typeof pending !== 'number' || !Number.isSafeInteger(pending) || pending < 0) fail('session-heartbeat result has an invalid pending_messages observation', [String(row.event_seq)]);
  let session: CoordinationSessionLease;
  try { session = parseCoordinationSessionLease(payload['session']); }
  catch (error) { fail('session-heartbeat result session is malformed', [String(row.event_seq), error instanceof Error ? error.message : String(error)]); }
  if (session.session_lease_id !== row.entity_id) fail('session-heartbeat result identity disagrees with its event entity', [String(row.event_seq), row.entity_id, session.session_lease_id]);
  return true;
}

/** A child heartbeat is pure only when its exact result proves no preemption. */
export function isPureD65ChildHeartbeat(row: D65AcceptedEventResultJoin): boolean {
  if (row.event_type !== 'child-heartbeat' || row.entity_type !== 'child-lease') return false;
  const payload = exactJoin(row);
  if (!exactKeys(payload, ['child', 'entity_id', 'entity_type', 'event_type', 'preemption_requested', 'victim_key'])) return false;
  if (payload['event_type'] !== row.event_type || payload['entity_type'] !== row.entity_type || payload['entity_id'] !== row.entity_id) fail('child-heartbeat immutable result metadata disagrees with its event', [String(row.event_seq)]);
  if (payload['preemption_requested'] !== false || payload['victim_key'] !== null) return false;
  let child: CoordinationChildLease;
  try { child = parseCoordinationChildLease(payload['child']); }
  catch (error) { fail('child-heartbeat result child is malformed', [String(row.event_seq), error instanceof Error ? error.message : String(error)]); }
  if (child.child_lease_id !== row.entity_id) fail('child-heartbeat result identity disagrees with its event entity', [String(row.event_seq), row.entity_id, child.child_lease_id]);
  return true;
}

export interface D65SemanticVersionCounts {
  readonly sessionPureLeaseEvents: ReadonlyMap<string, number>;
  readonly childPureLeaseEvents: ReadonlyMap<string, number>;
  readonly acceptedProgramHeartbeatEvents: number;
}

/**
 * Validate every relevant event/result join through E and count only proven pure
 * lease renewals plus exact program-heartbeat liveness events. A malformed,
 * missing, duplicate, out-of-range, or mismatched join fails loudly.
 */
export function computeD65SemanticVersionCounts(rows: readonly D65AcceptedEventResultJoin[], coveredEventSeq: number): D65SemanticVersionCounts {
  if (!Number.isSafeInteger(coveredEventSeq) || coveredEventSeq < 0) fail('covered event sequence is invalid', [String(coveredEventSeq)]);
  const seen = new Set<number>();
  const sessionCounts = new Map<string, number>();
  const childCounts = new Map<string, number>();
  let heartbeatEvents = 0;
  const sorted = [...rows].sort((left, right) => left.event_seq - right.event_seq);
  for (const row of sorted) {
    if (!Number.isSafeInteger(row.event_seq) || row.event_seq < 1 || row.event_seq > coveredEventSeq) fail('event sequence is outside the covered boundary', [String(row.event_seq), String(coveredEventSeq)]);
    if (seen.has(row.event_seq)) fail('duplicate event sequence was supplied', [String(row.event_seq)]);
    seen.add(row.event_seq);
    // Every supplied relevant event must have the exact result even when it is
    // semantic (non-pure); this prevents missing history from being interpreted
    // as a non-pure no-op.
    exactJoin(row);
    if (isPureD65SessionHeartbeat(row)) sessionCounts.set(row.entity_id, (sessionCounts.get(row.entity_id) ?? 0) + 1);
    else if (isPureD65ChildHeartbeat(row)) childCounts.set(row.entity_id, (childCounts.get(row.entity_id) ?? 0) + 1);
    else if (row.event_type === 'program-heartbeat-accepted') {
      if (row.entity_type !== 'program-heartbeat') fail('program-heartbeat-accepted has the wrong entity type', [String(row.event_seq), row.entity_type]);
      heartbeatEvents += 1;
    }
  }
  return Object.freeze({ sessionPureLeaseEvents: sessionCounts, childPureLeaseEvents: childCounts, acceptedProgramHeartbeatEvents: heartbeatEvents });
}
