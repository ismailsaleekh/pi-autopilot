import { canonicalJson } from './canonical-json.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationSessionLease, parseCoordinationWorktree, parseCoordinationWorktreeOperation } from './contracts.ts';
import { parseD65BootstrapCharter, type D65BootstrapCharter } from './d65-bootstrap-charter.ts';
import { parseD65HeartbeatAcceptanceResult, type D65LaunchPolicy } from './d65-launch-policy.ts';
import type { D65AcceptedEventResultJoin } from './d65-semantic-version.ts';
import type { D65CompleteGraph } from './d65-semantic-graph.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type { CoordinationAuthoritativeArtifact } from './types.ts';

const BOOTSTRAP_EVENT_TYPES = Object.freeze([
  'run-attached',
  'session-attached',
  'worktree-operation-prepared',
  'worktree-operation-in-progress',
  'worktree-operation-in-progress',
  'worktree-operation-verified',
  'worktree-operation-committed',
  'authoritative-artifact-registered',
  'program-heartbeat-accepted',
] as const);

function fail(issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-state', `semantic-graph-bootstrap-transition-invalid: ${issue}`, [...detail]);
}

function result(join: D65AcceptedEventResultJoin): Readonly<Record<string, unknown>> {
  if (join.result === null || join.result.repo_id !== join.repo_id || join.result.idempotency_key !== join.idempotency_key || join.result.request_sha256 !== join.request_sha256 || join.result.committed_event_seq !== join.event_seq) fail('bootstrap event lacks its exact joined idempotency result', [String(join.event_seq), join.event_type]);
  return join.result.payload;
}

function genericResult(join: D65AcceptedEventResultJoin): Readonly<Record<string, unknown>> {
  const payload = result(join);
  if (payload['event_type'] !== join.event_type || payload['entity_type'] !== join.entity_type || payload['entity_id'] !== join.entity_id) fail('bootstrap generic result metadata differs from its event', [String(join.event_seq), join.event_type]);
  return payload;
}

/** Validate the exact sequence-2 B→E bootstrap charter and parent-planning postimage. */
export function validateD65FirstCompleteGraph(input: {
  readonly graph: D65CompleteGraph;
  readonly charter: D65BootstrapCharter | unknown;
  readonly historyBThroughE: readonly D65AcceptedEventResultJoin[];
  readonly policyArtifact: CoordinationAuthoritativeArtifact;
  readonly policy: D65LaunchPolicy;
  readonly authorityCommitParents: readonly string[];
  readonly authorityDiffPaths: readonly string[];
}): void {
  if (input.graph.graph_sequence !== 2) fail('first complete graph sequence must be exactly 2');
  const charter = parseD65BootstrapCharter(input.charter);
  if (input.historyBThroughE.length !== BOOTSTRAP_EVENT_TYPES.length) fail('bootstrap history has a missing or extra coordinator event', [`actual=${String(input.historyBThroughE.length)}`, `expected=${String(BOOTSTRAP_EVENT_TYPES.length)}`]);
  for (let index = 0; index < input.historyBThroughE.length; index += 1) {
    const join = input.historyBThroughE[index];
    const expectedType = BOOTSTRAP_EVENT_TYPES[index];
    if (join === undefined || join.event_seq !== index + 1 || join.event_type !== expectedType) fail('bootstrap history is gapped, reordered, or contains a complete-mode event', [String(index + 1), expectedType ?? '<missing>', join?.event_type ?? '<missing>']);
    result(join);
  }
  const first = input.historyBThroughE[0];
  if (first === undefined || canonicalJson({ schema_version: 'autopilot.coordination_event.v1', repo_id: first.repo_id, event_seq: first.event_seq, event_type: first.event_type, entity_type: first.entity_type, entity_id: first.entity_id, idempotency_key: first.idempotency_key, request_sha256: first.request_sha256, occurred_at: charter.attach_event.occurred_at }) !== canonicalJson(charter.attach_event)) fail('history B does not equal reconstructed charter attach_event');
  if (canonicalJson(genericResult(first)) !== canonicalJson({ ...charter.attach_result, event_type: 'run-attached', entity_type: 'run', entity_id: charter.run.workstream_run })) fail('history B result does not equal reconstructed charter attach_result');

  const sessionEvent = input.historyBThroughE[1];
  if (sessionEvent === undefined || sessionEvent.entity_type !== 'session-lease') fail('bootstrap attach-session event has a wrong entity type');
  const sessionPayload = genericResult(sessionEvent);
  const session = parseCoordinationSessionLease(sessionPayload['session']);
  if (session.repo_id !== input.graph.repo_id || session.workstream_run !== input.graph.workstream_run || session.session_generation !== 1 || session.attachment_kind !== 'dispatch' || session.status !== 'attached') fail('bootstrap session is not the exact first attached dispatch generation');

  const operationEvents = input.historyBThroughE.slice(2, 7);
  let operationId: string | null = null;
  const expectedStages = ['prepared','in-progress','in-progress','verified','committed'] as const;
  for (let index = 0; index < operationEvents.length; index += 1) {
    const event = operationEvents[index];
    if (event === undefined || event.entity_type !== 'worktree-operation') fail('bootstrap main-worktree event has a wrong entity type');
    const payload = genericResult(event);
    const operation = parseCoordinationWorktreeOperation(payload['operation']);
    const worktree = parseCoordinationWorktree(payload['worktree']);
    if (operationId === null) operationId = operation.operation_id;
    if (operation.operation_id !== operationId || event.entity_id !== operationId || operation.operation_type !== 'create' || operation.owner.unit_id !== 'main' || operation.owner.attempt !== 1 || worktree.kind !== 'main' || worktree.worktree_id !== operation.worktree_id || operation.stage !== expectedStages[index]) fail('bootstrap main/create operation chain is not one exact prepared→committed identity', [String(event.event_seq), operation.operation_id, operation.stage]);
  }
  const committedEvent = operationEvents[4];
  if (committedEvent === undefined) fail('bootstrap main/create operation lacks its committed event');
  const committedPayload = genericResult(committedEvent);
  const committedOperation = parseCoordinationWorktreeOperation(committedPayload['operation']);
  const committedWorktree = parseCoordinationWorktree(committedPayload['worktree']);
  if (committedOperation.stage !== 'committed' || committedWorktree.state !== 'active' || committedWorktree.canonical_path !== charter.run_resource.main_worktree_path || committedWorktree.branch !== charter.run_resource.branch) fail('bootstrap main worktree committed postimage differs from run-resource authority');

  const policyEvent = input.historyBThroughE[7];
  if (policyEvent === undefined || policyEvent.entity_type !== 'authoritative-artifact' || policyEvent.entity_id !== input.policyArtifact.artifact_id) fail('bootstrap launch-policy registration event identity is wrong');
  const resultArtifact = parseCoordinationAuthoritativeArtifact(genericResult(policyEvent)['authoritative_artifact']);
  if (canonicalJson(resultArtifact) !== canonicalJson(input.policyArtifact) || input.policyArtifact.document_schema_version !== 'autopilot.launch_policy.v1' || input.policyArtifact.source_type !== 'task' || input.policyArtifact.source_scope !== 'run-main') fail('bootstrap policy event/result/artifact authority is not exact');
  if (input.policy.repo_id !== input.graph.repo_id || input.policy.workstream_run !== input.graph.workstream_run || input.policy.bootstrap_graph_sha256 !== input.graph.prior_graph_sha256 || input.policy.bootstrap_receipt_event_seq !== input.graph.prior_event_seq || input.policyArtifact.evidence.ref !== `authority/launch-policies/${input.policy.policy_id}.json`) fail('bootstrap launch policy does not bind graph/bootstrap identity');

  const heartbeatEvent = input.historyBThroughE[8];
  if (heartbeatEvent === undefined || heartbeatEvent.entity_type !== 'program-heartbeat' || heartbeatEvent.entity_id !== input.graph.workstream_run) fail('initial program heartbeat event identity is wrong');
  const heartbeat = parseD65HeartbeatAcceptanceResult(result(heartbeatEvent));
  if (heartbeat.repo_id !== input.graph.repo_id || heartbeat.workstream_run !== input.graph.workstream_run || heartbeat.sequence !== 1 || heartbeat.acceptance_kind !== 'governing') fail('initial program heartbeat acceptance is not the exact governing sequence 1 row');
  if (input.graph.covered_event_seq !== heartbeatEvent.event_seq) fail('first graph E is not the initial governing-heartbeat acceptance event');

  if (input.authorityCommitParents.length !== 2 || input.authorityCommitParents[0] !== input.graph.covered_authority_commit || input.authorityCommitParents[1] !== input.policyArtifact.git_commit) fail('first authority G must have the accepted policy commit as its sole parent', input.authorityCommitParents);
  const expectedCorePaths = Object.values(input.graph.core).map((entry) => entry.ref).sort();
  const actualPaths = [...input.authorityDiffPaths].sort();
  if (canonicalJson(actualPaths) !== canonicalJson(expectedCorePaths)) fail('no-event parent planning must change exactly the five core paths', [...actualPaths, '--expected--', ...expectedCorePaths]);
}
