import { canonicalJson } from './canonical-json.ts';
import {
  parseCoordinationAuthoritativeArtifact,
  parseCoordinationEvent,
  parseCoordinationMailboxCursor,
  parseCoordinationRepository,
  parseCoordinationRun,
  parseCoordinationRunResource,
} from './contracts.ts';
import {
  object,
  parseD65AttachRunResultV2,
  type D65AttachRunResultV2,
  type D65TrustAnchorResult,
  type JsonObject,
} from './d65-semantic-graph.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type {
  CoordinationAuthoritativeArtifact,
  CoordinationEvent,
  CoordinationMailboxCursor,
  CoordinationRepository,
  CoordinationRun,
  CoordinationRunResource,
} from './types.ts';

export interface D65BootstrapCharter {
  readonly repository: CoordinationRepository;
  readonly run: CoordinationRun;
  readonly run_resource: CoordinationRunResource;
  readonly mailbox_cursor: CoordinationMailboxCursor;
  readonly bootstrap_graph: D65AttachRunResultV2['bootstrap_graph'];
  readonly bootstrap_artifact: CoordinationAuthoritativeArtifact;
  readonly trust_anchor: D65TrustAnchorResult;
  readonly attach_event: CoordinationEvent;
  readonly attach_result: D65AttachRunResultV2;
}

export interface D65BootstrapEventResultAuthority {
  readonly event: unknown;
  readonly result: Readonly<{
    repo_id: string;
    idempotency_key: string;
    request_sha256: string;
    committed_event_seq: number;
    payload: unknown;
  }>;
}

function fail(issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-state', `semantic-graph-bootstrap-charter-invalid: ${issue}`, [...detail]);
}

function equal(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) fail(`${label} differs between duplicated immutable bootstrap authority`);
}

/** Closed parser for the byte-identical charter carried by every complete graph. */
export function parseD65BootstrapCharter(value: unknown): D65BootstrapCharter {
  const label = 'semantic_graph.bootstrap_charter';
  const row = object(value, label, ['repository','run','run_resource','mailbox_cursor','bootstrap_graph','bootstrap_artifact','trust_anchor','attach_event','attach_result']);
  const attachResult = parseD65AttachRunResultV2(row['attach_result']);
  const repository = parseCoordinationRepository(row['repository']);
  const run = parseCoordinationRun(row['run']);
  const resource = parseCoordinationRunResource(row['run_resource']);
  const cursor = parseCoordinationMailboxCursor(row['mailbox_cursor']);
  const artifact = parseCoordinationAuthoritativeArtifact(row['bootstrap_artifact']);
  const event = parseCoordinationEvent(row['attach_event']);
  const parsed: D65BootstrapCharter = Object.freeze({
    repository,
    run,
    run_resource: resource,
    mailbox_cursor: cursor,
    bootstrap_graph: attachResult.bootstrap_graph,
    bootstrap_artifact: artifact,
    trust_anchor: attachResult.trust_anchor,
    attach_event: event,
    attach_result: attachResult,
  });
  equal(parsed.repository, attachResult.repository, 'repository');
  equal(parsed.run, attachResult.run, 'run');
  equal(parsed.run_resource, attachResult.run_resource, 'run_resource');
  equal(parsed.mailbox_cursor, attachResult.mailbox_cursor, 'mailbox_cursor');
  equal(parsed.bootstrap_graph, attachResult.bootstrap_graph, 'bootstrap_graph');
  equal(parsed.bootstrap_artifact, attachResult.bootstrap_artifact, 'bootstrap_artifact');
  equal(parsed.trust_anchor, attachResult.trust_anchor, 'trust_anchor');
  if (repository.repo_id !== run.repo_id || resource.repo_id !== run.repo_id || cursor.repo_id !== run.repo_id || artifact.repo_id !== run.repo_id || event.repo_id !== run.repo_id) fail('charter repository identities disagree');
  if (resource.workstream_run !== run.workstream_run || cursor.workstream_run !== run.workstream_run || artifact.source_run !== run.workstream_run || event.entity_id !== run.workstream_run) fail('charter run identities disagree');
  if (event.event_type !== 'run-attached' || event.entity_type !== 'run') fail('attach_event is not the sole run-attached B event');
  if (event.event_seq !== repository.created_event_seq || event.event_seq !== run.created_event_seq || event.event_seq !== artifact.registered_event_seq) fail('bootstrap B event sequence differs from created/registered row authority');
  if (event.event_seq !== 1 || parsed.bootstrap_graph.covered_event_seq !== 0) fail('fresh D65 bootstrap must be B=1 over covered event zero');
  if (artifact.artifact_id !== `semantic-graph-bootstrap:${run.workstream_run}` || artifact.document_schema_version !== 'autopilot.semantic_graph_bootstrap.v1' || artifact.source_type !== 'task' || artifact.source_scope !== 'repository') fail('bootstrap artifact identity/schema/scope is not exact');
  if (artifact.git_commit !== parsed.bootstrap_graph.git_commit || artifact.evidence.ref !== parsed.bootstrap_graph.ref || artifact.evidence.sha256 !== parsed.bootstrap_graph.sha256) fail('bootstrap artifact does not bind the exact bootstrap graph ref tuple');
  return parsed;
}

export function assertD65BootstrapCharterIdentity(charter: D65BootstrapCharter, expected: Readonly<{ repo_id: string; autopilot_id: string; workstream: string; workstream_run: string }>): void {
  if (charter.run.repo_id !== expected.repo_id || charter.run.autopilot_id !== expected.autopilot_id || charter.run.workstream !== expected.workstream || charter.run.workstream_run !== expected.workstream_run) fail('charter identity differs from complete graph identity', [charter.run.repo_id, charter.run.autopilot_id, charter.run.workstream, charter.run.workstream_run]);
}

/** Reconstruct charter only from the immutable B event and joined idempotency result. */
export function reconstructD65BootstrapCharter(authority: D65BootstrapEventResultAuthority): D65BootstrapCharter {
  const event = parseCoordinationEvent(authority.event);
  const result = authority.result;
  if (result.repo_id !== event.repo_id || result.idempotency_key !== event.idempotency_key || result.request_sha256 !== event.request_sha256 || result.committed_event_seq !== event.event_seq) fail('attach event/result join identity is not exact');
  const payload = object(result.payload, 'bootstrap attach idempotency result', ['schema_version','repository','run','run_resource','mailbox_cursor','bootstrap_graph','bootstrap_artifact','trust_anchor','event_type','entity_type','entity_id']);
  if (payload['event_type'] !== event.event_type || payload['entity_type'] !== event.entity_type || payload['entity_id'] !== event.entity_id) fail('generic idempotency result metadata differs from attach event authority');
  const effect: JsonObject = Object.freeze({
    schema_version: payload['schema_version'], repository: payload['repository'], run: payload['run'],
    run_resource: payload['run_resource'], mailbox_cursor: payload['mailbox_cursor'], bootstrap_graph: payload['bootstrap_graph'],
    bootstrap_artifact: payload['bootstrap_artifact'], trust_anchor: payload['trust_anchor'],
  });
  const attachResult = parseD65AttachRunResultV2(effect);
  return parseD65BootstrapCharter(Object.freeze({
    repository: attachResult.repository,
    run: attachResult.run,
    run_resource: attachResult.run_resource,
    mailbox_cursor: attachResult.mailbox_cursor,
    bootstrap_graph: attachResult.bootstrap_graph,
    bootstrap_artifact: attachResult.bootstrap_artifact,
    trust_anchor: attachResult.trust_anchor,
    attach_event: event,
    attach_result: attachResult,
  }));
}
