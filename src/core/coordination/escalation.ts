import { createHash } from 'node:crypto';

import { parseAutopilotMasterPlan, parseAutopilotUnitSpec } from '../contracts/index.ts';
import { parseD65LaunchPolicy, parseD65CapacityDecision, parseD65SubscriptionProbe } from './d65-launch-policy.ts';
import { parseD65CompleteGraph, parseD65RunTerminalIntentV2 } from './d65-semantic-graph.ts';
import { CoordinatorClient } from './client.ts';
import { parseCoordinationAdjudicationAssignment, parseCoordinationAuthoritativeArtifact, parseCoordinationContradictionAdjudication, parseCoordinationEscalation } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { readCoordinatorSessionContext, type CoordinatorSessionContext } from './supervisor.ts';
import type { CoordinationAdjudicationAssignment, CoordinationAuthoritativeArtifact, CoordinationContradictionAdjudication, CoordinationEscalation, CoordinationEvidenceRef } from './types.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../names.ts';
import type { ProcessEnvLike } from '../parallel-runtime.ts';

const REQUIRED_MISSION_SECTIONS = [
  'Goal',
  'Non-goals / exclusions',
  'Perfect-quality bar',
  'Definition of done',
  'Key constraints',
  'Current strategy summary',
  'Open questions',
] as const;

export interface CoordinationAuthoritativeDocument {
  readonly ref: CoordinationEvidenceRef;
  readonly bytes: Uint8Array;
}

export function validatePlanningContradictionSubmission(input: {
  readonly packet: CoordinationEscalation;
  readonly adjudicationBytes: Uint8Array;
  readonly authoritativeDocuments: readonly CoordinationAuthoritativeDocument[];
}): { readonly packet: CoordinationEscalation; readonly adjudication: CoordinationContradictionAdjudication } {
  const packet = parseCoordinationEscalation(input.packet);
  const adjudication = parseCoordinationContradictionAdjudication(parseJson(input.adjudicationBytes, 'planning contradiction adjudication'));
  assertDigest(packet.adjudication, input.adjudicationBytes, 'adjudication');
  if (adjudication.adjudication_id !== packet.escalation_id) throw reject('adjudication identity does not match escalation identity');
  const participating = [...packet.participating_runs].sort();
  if (participating.includes(adjudication.adjudicator.workstream_run)) throw reject('independent adjudicator must not belong to a participating run');
  if (JSON.stringify([...adjudication.independent_from_runs].sort()) !== JSON.stringify(participating)) throw reject('adjudication independence set must exactly match participating runs');
  if (adjudication.operational_reasons.length > 0) throw reject('operational blockers can never produce an operator-decision packet', adjudication.operational_reasons);
  if (canonical(adjudication.conflicting_clauses) !== canonical(packet.conflicting_clauses)) throw reject('adjudication clauses do not exactly match the submitted packet');
  if (canonical(adjudication.decision_options) !== canonical(packet.decision_options)) throw reject('adjudication options do not exactly match the submitted packet');

  const documents = new Map(input.authoritativeDocuments.map((document) => [evidenceKey(document.ref), document]));
  if (documents.size !== input.authoritativeDocuments.length) throw reject('authoritative document evidence contains duplicate refs');
  const participatingRuns = new Set(packet.participating_runs);
  if (packet.conflicting_clauses.some((clause) => !participatingRuns.has(clause.source_run))) throw reject('every authoritative clause source_run must be a participating run');
  const packetRefs = new Set(packet.authoritative_refs.map(evidenceKey));
  if (packetRefs.size < 2) throw reject('planning contradiction requires at least two distinct authoritative refs');
  const clauseIds = new Set(packet.conflicting_clauses.map((clause) => clause.clause_id));
  const clauseRefs = new Set(packet.conflicting_clauses.map((clause) => evidenceKey(clause.authoritative_ref)));
  if (clauseIds.size !== packet.conflicting_clauses.length) throw reject('conflicting clause ids must be unique');
  if (clauseRefs.size < 2) throw reject('conflicting clauses must cite at least two distinct authoritative refs');
  for (const clause of packet.conflicting_clauses) {
    const key = evidenceKey(clause.authoritative_ref);
    if (!packetRefs.has(key)) throw reject('conflicting clause references evidence outside authoritative_refs', [clause.clause_id]);
    const document = documents.get(key);
    if (document === undefined) throw reject('authoritative requirement document is missing', [clause.authoritative_ref.ref]);
    assertDigest(document.ref, document.bytes, `authoritative document ${document.ref.ref}`);
    validateAuthoritativeCoordinationDocument(clause.source_type, clause.schema_version, document.bytes);
    const text = Buffer.from(document.bytes).toString('utf8');
    if (!text.includes(clause.exact_requirement)) throw reject('exact conflicting requirement is not present in its authoritative document', [clause.clause_id, clause.authoritative_ref.ref]);
  }
  for (const ref of packet.authoritative_refs) {
    if (!documents.has(evidenceKey(ref))) throw reject('packet authoritative ref has no validated source document', [ref.ref]);
  }

  const grouped = new Map<string, Set<string>>();
  for (const clause of packet.conflicting_clauses) {
    const outcomes = grouped.get(clause.artifact_or_invariant) ?? new Set<string>();
    outcomes.add(clause.demanded_outcome);
    grouped.set(clause.artifact_or_invariant, outcomes);
  }
  if (![...grouped.values()].some((outcomes) => outcomes.size >= 2)) throw reject('clauses do not demand incompatible outcomes for the same artifact or invariant');
  return { packet, adjudication };
}

interface JsonMap {
  readonly [key: string]: unknown;
}

export interface CoordinationAdjudicationBundle {
  readonly assignment: CoordinationAdjudicationAssignment;
  readonly authoritativeDocuments: readonly { readonly artifact: CoordinationAuthoritativeArtifact; readonly contentUtf8: string }[];
}

function responseRecord(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `${label} is not an object`);
  return value as JsonMap;
}

export class PlanningContradictionClient {
  readonly #client: CoordinatorClient;
  readonly #session: CoordinatorSessionContext;

  constructor(client: CoordinatorClient, session: CoordinatorSessionContext) {
    this.#client = client;
    this.#session = session;
  }

  static async fromEnvironment(env: ProcessEnvLike = process.env): Promise<PlanningContradictionClient> {
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for contradiction submission`);
    const session = await readCoordinatorSessionContext(contextPath);
    return new PlanningContradictionClient(new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }), session);
  }

  async assignmentBundleFor(unitId: string, attempt: number): Promise<CoordinationAdjudicationBundle | null> {
    const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
    const rawAssignments = status.payload['adjudication_assignments'];
    if (!Array.isArray(rawAssignments)) throw new CoordinationRuntimeError('invalid-state', 'coordinator status omitted adjudication assignments');
    const assigned = rawAssignments.map(parseCoordinationAdjudicationAssignment).filter((assignment) => assignment.state === 'assigned' && assignment.adjudicator.workstream_run === this.#session.workstream_run && assignment.adjudicator.unit_id === unitId && assignment.adjudicator.attempt === attempt);
    if (assigned.length === 0) return null;
    if (assigned.length > 1) throw new CoordinationRuntimeError('invalid-state', 'adjudication attempt has multiple simultaneous coordinator assignments', assigned.map((assignment) => assignment.assignment_id));
    const response = await this.#client.mutate('claim-adjudication-assignment', {
      repoId: this.#session.repo_id, workstreamRun: this.#session.workstream_run, sessionId: this.#session.session_id, fencingGeneration: this.#session.session_generation, expectedVersion: this.#session.run_version,
      idempotencyKey: `claim-adjudication-assignment:${unitId}:${String(attempt)}`,
    }, { unit_id: unitId, attempt, session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token });
    const assignment = parseCoordinationAdjudicationAssignment(response.payload['adjudication_assignment']);
    const rawDocuments = response.payload['authoritative_documents'];
    if (!Array.isArray(rawDocuments)) throw new CoordinationRuntimeError('invalid-state', 'assignment bundle omitted authoritative documents');
    const authoritativeDocuments = rawDocuments.map((value) => {
      const document = responseRecord(value, 'assignment authoritative document');
      if (typeof document['content_utf8'] !== 'string') throw new CoordinationRuntimeError('invalid-state', 'assignment authoritative document omitted UTF-8 content');
      return { artifact: parseCoordinationAuthoritativeArtifact(document['artifact']), contentUtf8: document['content_utf8'] };
    });
    return { assignment, authoritativeDocuments };
  }

  async registerAuthoritativeArtifact(input: { readonly artifactId: string; readonly sourceType: 'mission' | 'master-plan' | 'task'; readonly sourceScope: 'repository' | 'run-main'; readonly documentSchemaVersion: string; readonly gitCommit: string; readonly evidence: CoordinationEvidenceRef }): Promise<CoordinationAuthoritativeArtifact> {
    const response = await this.#client.mutate('register-authoritative-artifact', {
      repoId: this.#session.repo_id, workstreamRun: this.#session.workstream_run, sessionId: this.#session.session_id, fencingGeneration: this.#session.session_generation, expectedVersion: this.#session.run_version,
      idempotencyKey: `register-authoritative-artifact:${input.artifactId}:${input.evidence.sha256}`,
    }, { artifact_id: input.artifactId, source_type: input.sourceType, source_scope: input.sourceScope, document_schema_version: input.documentSchemaVersion, git_commit: input.gitCommit, ref: input.evidence.ref, sha256: input.evidence.sha256, session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token });
    return parseCoordinationAuthoritativeArtifact(response.payload['authoritative_artifact']);
  }

  async assign(assignment: CoordinationAdjudicationAssignment): Promise<CoordinationAdjudicationAssignment> {
    const parsed = parseCoordinationAdjudicationAssignment(assignment);
    const response = await this.#client.mutate('assign-adjudication', {
      repoId: this.#session.repo_id, workstreamRun: this.#session.workstream_run, sessionId: this.#session.session_id, fencingGeneration: this.#session.session_generation, expectedVersion: this.#session.run_version,
      idempotencyKey: `assign-adjudication:${parsed.assignment_id}`,
    }, { assignment: parsed, session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token });
    return parseCoordinationAdjudicationAssignment(response.payload['adjudication_assignment']);
  }

  async submit(packet: CoordinationEscalation, assignmentId: string): Promise<CoordinationEscalation> {
    const parsed = parseCoordinationEscalation(packet);
    const response = await this.#client.mutate('submit-planning-contradiction', {
      repoId: this.#session.repo_id,
      workstreamRun: this.#session.workstream_run,
      sessionId: this.#session.session_id,
      fencingGeneration: this.#session.session_generation,
      expectedVersion: this.#session.run_version,
      idempotencyKey: `submit-planning-contradiction:${parsed.escalation_id}:${parsed.adjudication.sha256}`,
    }, { packet: parsed, assignment_id: assignmentId, session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token });
    return parseCoordinationEscalation(response.payload['escalation']);
  }
}

export function rejectOperationalEscalation(reason: string): never {
  throw reject('operator decision rejected because the reason is operational', [reason]);
}

export function validateAuthoritativeCoordinationDocument(sourceType: 'mission' | 'master-plan' | 'task', schemaVersion: string, bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString('utf8');
  if (sourceType === 'mission') {
    if (schemaVersion !== 'autopilot.mission.v1') throw reject('mission authoritative ref uses an unsupported schema version');
    const headings = new Set([...text.matchAll(/^##\s+(.+)\s*$/gmu)].map((match) => match[1]?.trim()).filter((heading): heading is string => heading !== undefined && heading.length > 0));
    const missing = REQUIRED_MISSION_SECTIONS.filter((section) => !headings.has(section));
    if (missing.length > 0) throw reject('authoritative mission is not schema-valid', missing);
    return;
  }
  const parsed = parseJson(bytes, `authoritative ${sourceType}`);
  try {
    if (sourceType === 'master-plan') {
      if (schemaVersion !== 'autopilot.master_plan.v1') throw new Error('master-plan schema version mismatch');
      parseAutopilotMasterPlan(parsed);
    } else if (D65_TASK_DOCUMENT_PARSERS[schemaVersion] !== undefined) {
      // D65-A1/A4: signed/authority package-run documents register through the
      // existing register-authoritative-artifact action as source_type=task and
      // are strictly parsed at the lowest layer here. No new action/table.
      D65_TASK_DOCUMENT_PARSERS[schemaVersion](parsed);
    } else {
      if (schemaVersion !== 'autopilot.unit_spec.v1') throw new Error('task schema version mismatch');
      parseAutopilotUnitSpec(parsed);
    }
  } catch (error) {
    throw reject(`authoritative ${sourceType} is not schema-valid`, [error instanceof Error ? error.message : String(error)]);
  }
}

/** The D65 authority documents that may register as source_type=task. */
const D65_TASK_DOCUMENT_PARSERS: Readonly<Record<string, (value: unknown) => unknown>> = Object.freeze({
  'autopilot.launch_policy.v1': parseD65LaunchPolicy,
  'autopilot.capacity_decision.v1': parseD65CapacityDecision,
  'autopilot.subscription_probe.v1': parseD65SubscriptionProbe,
  'autopilot.semantic_graph.v1': parseD65CompleteGraph,
  'autopilot.run_terminal_intent.v2': parseD65RunTerminalIntentV2,
});

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch (error) {
    throw reject(`${label} is not valid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
}

function assertDigest(ref: CoordinationEvidenceRef, bytes: Uint8Array, label: string): void {
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== ref.sha256) throw reject(`${label} hash does not match immutable evidence`, [`expected=${ref.sha256}`, `actual=${actual}`]);
}

function evidenceKey(ref: CoordinationEvidenceRef): string {
  return `${ref.ref}\0${ref.sha256}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw reject('contradiction evidence contains a non-JSON value');
  return `{${Object.entries(value).sort((left, right) => left[0].localeCompare(right[0])).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

function reject(message: string, evidence: readonly string[] = []): CoordinationRuntimeError {
  return new CoordinationRuntimeError('invalid-request', message, evidence);
}
