import { createHash } from 'node:crypto';

import {
  parseCoordinationAcquisitionGroup,
  parseCoordinationAuthoritativeArtifact,
  parseCoordinationChangeReservation,
  parseCoordinationEditLease,
  parseCoordinationOwnerIdentity,
  parseCoordinationRun,
  parseCoordinationRunResource,
  parseCoordinationRunTerminalIntent,
  parseCoordinationUnitAttempt,
  parseCoordinationWorktree,
  parseCoordinationWorktreeOperation,
} from './contracts.ts';
import { AUTOPILOT_RUN_SCOPED_FAULT_SCHEMA, parseRunScopedLogicalFault } from './logical-faults.ts';
import {
  array,
  integer,
  nullableSha256Field,
  object,
  sha256Field,
  str,
  type JsonObject,
} from './d65-semantic-graph.ts';
import { parseD65RunTerminalIntentV2 } from './d65-semantic-graph.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type {
  CoordinationAcquisitionGroup,
  CoordinationAuthoritativeArtifact,
  CoordinationChangeReservation,
  CoordinationChildLease,
  CoordinationEditLease,
  CoordinationRun,
  CoordinationRunResource,
  CoordinationRunTerminalIntent,
  CoordinationSessionLease,
  CoordinationUnitAttempt,
  CoordinationWorktree,
  CoordinationWorktreeOperation,
} from './types.ts';
import type { RunScopedLogicalFault } from './logical-faults.ts';

// Additive D65 coordinator_projection encoding freeze (2026-07-21). This is
// the single source of truth consumed by the graph producer, loader/replayer,
// store comparison, and terminal-tail baseline. No other module may invent a
// kind, identity namespace, singleton wrapper, or row binding.

export const D65_COORDINATOR_PROJECTION_KINDS = Object.freeze([
  'acquisition-group',
  'artifact',
  'attempt',
  'child',
  'covered-event-seq',
  'current-terminal-intent-id',
  'edit-lease',
  'fault',
  'operation',
  'reservation',
  'resource',
  'run',
  'run-version',
  'session',
  'terminal-intent',
  'worktree',
] as const);

export type D65CoordinatorProjectionKind = (typeof D65_COORDINATOR_PROJECTION_KINDS)[number];

const SINGLETON_KINDS = new Set<D65CoordinatorProjectionKind>([
  'run', 'resource', 'current-terminal-intent-id', 'covered-event-seq', 'run-version',
]);

const HEX64 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u;

function fail(issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-request', `semantic-graph-projection-mismatch: ${issue}`, [...detail]);
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** The durable unit_attempts.entity_id derivation, byte-identical to store.ts. */
export function d65AttemptEntityId(owner: Readonly<{ repo_id: string; autopilot_id: string; workstream_run: string; unit_id: string; attempt: number }>): string {
  const ownerKey = `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}`;
  return `attempt-${sha256Hex(ownerKey)}`;
}

/** Exact frozen entry identity. Row natural identities are never truncated. */
export function d65CoordinatorProjectionIdentity(kind: D65CoordinatorProjectionKind, naturalIdentity?: string): string {
  const identity = SINGLETON_KINDS.has(kind)
    ? (() => {
        if (naturalIdentity !== undefined) fail('a singleton coordinator projection identity cannot carry a natural identity', [kind]);
        return `cp:${kind}`;
      })()
    : (() => {
        if (naturalIdentity === undefined || !IDENTIFIER.test(naturalIdentity)) fail('a row coordinator projection requires one complete bounded natural identity', [kind, String(naturalIdentity)]);
        return `cp:${kind}:${sha256Hex(naturalIdentity)}`;
      })();
  if (!IDENTIFIER.test(identity) || Buffer.byteLength(identity, 'utf8') > 192) fail('encoded coordinator projection identity exceeds the frozen identifier grammar', [kind, identity]);
  return identity;
}

export interface D65SemanticSessionProjection {
  readonly schema_version: 'autopilot.session_lease.v2';
  readonly session_lease_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly session_id: string;
  readonly session_generation: number;
  readonly pid: number;
  readonly boot_id: string;
  readonly attachment_kind: CoordinationSessionLease['attachment_kind'];
  readonly status: CoordinationSessionLease['status'];
  readonly attached_event_seq: number;
  readonly semantic_version: number;
}

export interface D65SemanticChildProjection {
  readonly schema_version: 'autopilot.child_lease.v1';
  readonly child_lease_id: string;
  readonly owner: CoordinationChildLease['owner'];
  readonly pid: number;
  readonly boot_id: string;
  readonly status: CoordinationChildLease['status'];
  readonly terminal_evidence: CoordinationChildLease['terminal_evidence'];
  readonly semantic_version: number;
}

function semanticVersion(rawVersion: number, pureLeaseEventCount: number, label: string): number {
  if (!Number.isSafeInteger(rawVersion) || rawVersion < 1 || !Number.isSafeInteger(pureLeaseEventCount) || pureLeaseEventCount < 0) fail(`${label} semantic version operands must be nonnegative safe integers`);
  const projected = rawVersion - pureLeaseEventCount;
  if (!Number.isSafeInteger(projected) || projected < 0) fail(`${label} semantic_version subtraction underflowed`, [`raw=${String(rawVersion)}`, `pure=${String(pureLeaseEventCount)}`]);
  return projected;
}

export function projectD65SessionLease(session: CoordinationSessionLease, pureLeaseEventCount: number): D65SemanticSessionProjection {
  return Object.freeze({
    schema_version: session.schema_version,
    session_lease_id: session.session_lease_id,
    repo_id: session.repo_id,
    workstream_run: session.workstream_run,
    session_id: session.session_id,
    session_generation: session.session_generation,
    pid: session.pid,
    boot_id: session.boot_id,
    attachment_kind: session.attachment_kind,
    status: session.status,
    attached_event_seq: session.attached_event_seq,
    semantic_version: semanticVersion(session.version, pureLeaseEventCount, `session ${session.session_lease_id}`),
  });
}

export function projectD65ChildLease(child: CoordinationChildLease, pureLeaseEventCount: number): D65SemanticChildProjection {
  return Object.freeze({
    schema_version: child.schema_version,
    child_lease_id: child.child_lease_id,
    owner: child.owner,
    pid: child.pid,
    boot_id: child.boot_id,
    status: child.status,
    terminal_evidence: child.terminal_evidence,
    semantic_version: semanticVersion(child.version, pureLeaseEventCount, `child ${child.child_lease_id}`),
  });
}

export interface D65ConsumedProbeProjection {
  readonly artifact_id: string;
  readonly sha256: `sha256:${string}`;
  readonly probe_sequence: number;
  readonly provider: string;
  readonly trigger_continuation_sha256: `sha256:${string}`;
  readonly consumption_event_seq: number;
}

export interface D65AttemptProjection {
  readonly attempt: CoordinationUnitAttempt;
  readonly consumed_probe: D65ConsumedProbeProjection | null;
}

export interface D65CoordinatorProjectionMember {
  readonly identity: string;
  readonly kind: D65CoordinatorProjectionKind;
  readonly value: JsonObject;
}

export interface D65CoordinatorProjectionSnapshot {
  readonly run: CoordinationRun;
  readonly resource: CoordinationRunResource;
  readonly sessions: readonly D65SemanticSessionProjection[];
  readonly children: readonly D65SemanticChildProjection[];
  readonly attempts: readonly D65AttemptProjection[];
  readonly faults: readonly RunScopedLogicalFault[];
  readonly reservations: readonly CoordinationChangeReservation[];
  readonly edit_leases: readonly CoordinationEditLease[];
  readonly acquisition_groups: readonly CoordinationAcquisitionGroup[];
  readonly worktrees: readonly CoordinationWorktree[];
  readonly operations: readonly CoordinationWorktreeOperation[];
  readonly terminal_intents: readonly (CoordinationRunTerminalIntent | ReturnType<typeof parseD65RunTerminalIntentV2>)[];
  readonly current_terminal_intent_id: string | null;
  readonly authoritative_artifacts: readonly CoordinationAuthoritativeArtifact[];
  readonly covered_event_seq: number;
  readonly run_version: number;
}

function rowMember(kind: Exclude<D65CoordinatorProjectionKind, 'run' | 'resource' | 'current-terminal-intent-id' | 'covered-event-seq' | 'run-version'>, naturalIdentity: string, value: JsonObject): D65CoordinatorProjectionMember {
  return Object.freeze({ identity: d65CoordinatorProjectionIdentity(kind, naturalIdentity), kind, value });
}

function singletonMember(kind: Extract<D65CoordinatorProjectionKind, 'run' | 'resource' | 'current-terminal-intent-id' | 'covered-event-seq' | 'run-version'>, value: JsonObject): D65CoordinatorProjectionMember {
  return Object.freeze({ identity: d65CoordinatorProjectionIdentity(kind), kind, value });
}

/** Serialize one exact coordinator snapshot into globally identity-byte-sorted members. */
export function buildD65CoordinatorProjectionMembers(snapshot: D65CoordinatorProjectionSnapshot): readonly D65CoordinatorProjectionMember[] {
  if (snapshot.run.repo_id !== snapshot.resource.repo_id || snapshot.run.workstream_run !== snapshot.resource.workstream_run) fail('run and resource singleton identities disagree');
  if (snapshot.run.version !== snapshot.run_version) fail('run_version singleton does not equal the run row version');
  const terminalCurrent = snapshot.terminal_intents.filter((intent) => intent.state === 'prepared' || intent.state === 'committed');
  if (terminalCurrent.length > 1) fail('more than one prepared/committed terminal intent exists in the snapshot');
  const derivedCurrent = terminalCurrent[0]?.terminal_intent_id ?? null;
  if (snapshot.current_terminal_intent_id !== derivedCurrent) fail('current_terminal_intent_id does not select the sole prepared/committed terminal intent', [String(snapshot.current_terminal_intent_id), String(derivedCurrent)]);

  const members: D65CoordinatorProjectionMember[] = [
    singletonMember('run', Object.freeze({ ...snapshot.run })),
    singletonMember('resource', Object.freeze({ ...snapshot.resource })),
    singletonMember('current-terminal-intent-id', Object.freeze({ current_terminal_intent_id: snapshot.current_terminal_intent_id })),
    singletonMember('covered-event-seq', Object.freeze({ covered_event_seq: snapshot.covered_event_seq })),
    singletonMember('run-version', Object.freeze({ run_version: snapshot.run_version })),
    ...snapshot.sessions.map((row) => rowMember('session', row.session_lease_id, Object.freeze({ ...row }))),
    ...snapshot.children.map((row) => rowMember('child', row.child_lease_id, Object.freeze({ ...row }))),
    ...snapshot.attempts.map((row) => rowMember('attempt', d65AttemptEntityId(row.attempt.owner), Object.freeze({ ...row }))),
    ...snapshot.faults.map((row) => rowMember('fault', row.fault_id, Object.freeze({ ...row }))),
    ...snapshot.reservations.map((row) => rowMember('reservation', row.reservation_id, Object.freeze({ ...row }))),
    ...snapshot.edit_leases.map((row) => rowMember('edit-lease', row.edit_lease_id, Object.freeze({ ...row }))),
    ...snapshot.acquisition_groups.map((row) => rowMember('acquisition-group', row.acquisition_group_id, Object.freeze({ ...row }))),
    ...snapshot.worktrees.map((row) => rowMember('worktree', row.worktree_id, Object.freeze({ ...row }))),
    ...snapshot.operations.map((row) => rowMember('operation', row.operation_id, Object.freeze({ ...row }))),
    ...snapshot.terminal_intents.map((row) => rowMember('terminal-intent', row.terminal_intent_id, Object.freeze({ ...row }))),
    ...snapshot.authoritative_artifacts.map((row) => rowMember('artifact', row.artifact_id, Object.freeze({ ...row }))),
  ];
  // Every encoded identity is ASCII by grammar, so code-unit order is exactly
  // decoded unsigned-byte order.
  members.sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  for (let index = 1; index < members.length; index += 1) if (members[index - 1]?.identity === members[index]?.identity) fail('duplicate logical coordinator projection identity', [members[index]?.identity ?? '']);
  return Object.freeze(members);
}

function exactString(record: JsonObject, field: string, label: string): string {
  const value = str(record, field, label, 192);
  if (!IDENTIFIER.test(value)) fail(`${label}.${field} is not a bounded identifier`);
  return value;
}

function parseSemanticSession(value: unknown): D65SemanticSessionProjection {
  const label = 'coordinator_projection.session';
  const record = object(value, label, ['schema_version', 'session_lease_id', 'repo_id', 'workstream_run', 'session_id', 'session_generation', 'pid', 'boot_id', 'attachment_kind', 'status', 'attached_event_seq', 'semantic_version']);
  if (record['schema_version'] !== 'autopilot.session_lease.v2') fail(`${label}.schema_version is invalid`);
  const attachment = record['attachment_kind'];
  if (attachment !== 'dispatch' && attachment !== 'terminal-recovery' && attachment !== 'migration-recovery') fail(`${label}.attachment_kind is invalid`);
  const status = record['status'];
  if (status !== 'attached' && status !== 'handoff-pending' && status !== 'detached' && status !== 'fenced' && status !== 'expired') fail(`${label}.status is invalid`);
  return Object.freeze({
    schema_version: 'autopilot.session_lease.v2', session_lease_id: exactString(record, 'session_lease_id', label), repo_id: exactString(record, 'repo_id', label), workstream_run: exactString(record, 'workstream_run', label), session_id: exactString(record, 'session_id', label), session_generation: integer(record, 'session_generation', label, 1), pid: integer(record, 'pid', label, 1), boot_id: exactString(record, 'boot_id', label), attachment_kind: attachment, status, attached_event_seq: integer(record, 'attached_event_seq', label, 1), semantic_version: integer(record, 'semantic_version', label, 0),
  });
}

function parseTerminalEvidence(value: unknown, label: string): CoordinationChildLease['terminal_evidence'] {
  if (value === null) return null;
  const record = object(value, label, ['ref', 'sha256']);
  return Object.freeze({ ref: str(record, 'ref', label, 1024), sha256: sha256Field(record, 'sha256', label) });
}

function parseSemanticChild(value: unknown): D65SemanticChildProjection {
  const label = 'coordinator_projection.child';
  const record = object(value, label, ['schema_version', 'child_lease_id', 'owner', 'pid', 'boot_id', 'status', 'terminal_evidence', 'semantic_version']);
  if (record['schema_version'] !== 'autopilot.child_lease.v1') fail(`${label}.schema_version is invalid`);
  const status = record['status'];
  if (status !== 'running' && status !== 'terminal' && status !== 'recovery-required') fail(`${label}.status is invalid`);
  return Object.freeze({ schema_version: 'autopilot.child_lease.v1', child_lease_id: exactString(record, 'child_lease_id', label), owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`), pid: integer(record, 'pid', label, 1), boot_id: exactString(record, 'boot_id', label), status, terminal_evidence: parseTerminalEvidence(record['terminal_evidence'], `${label}.terminal_evidence`), semantic_version: integer(record, 'semantic_version', label, 0) });
}

function parseConsumedProbe(value: unknown): D65ConsumedProbeProjection | null {
  if (value === null) return null;
  const label = 'coordinator_projection.attempt.consumed_probe';
  const record = object(value, label, ['artifact_id', 'sha256', 'probe_sequence', 'provider', 'trigger_continuation_sha256', 'consumption_event_seq']);
  return Object.freeze({ artifact_id: exactString(record, 'artifact_id', label), sha256: sha256Field(record, 'sha256', label), probe_sequence: integer(record, 'probe_sequence', label, 1), provider: exactString(record, 'provider', label), trigger_continuation_sha256: sha256Field(record, 'trigger_continuation_sha256', label), consumption_event_seq: integer(record, 'consumption_event_seq', label, 1) });
}

function parseAttempt(value: unknown): D65AttemptProjection {
  const label = 'coordinator_projection.attempt';
  const record = object(value, label, ['attempt', 'consumed_probe']);
  return Object.freeze({ attempt: parseCoordinationUnitAttempt(record['attempt']), consumed_probe: parseConsumedProbe(record['consumed_probe']) });
}

function parseIntent(value: unknown): CoordinationRunTerminalIntent | ReturnType<typeof parseD65RunTerminalIntentV2> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('terminal-intent value must be an object');
  const schema = (value as Record<string, unknown>)['schema_version'];
  if (schema === 'autopilot.run_terminal_intent.v2') return parseD65RunTerminalIntentV2(value);
  return parseCoordinationRunTerminalIntent(value);
}

function ensureRunScope(repoId: string, workstreamRun: string, actualRepo: string, actualRun: string, label: string): void {
  if (actualRepo !== repoId || actualRun !== workstreamRun) fail(`${label} belongs to a different graph run`, [actualRepo, actualRun, repoId, workstreamRun]);
}

/** Parse, identity-bind, group, and reconstruct the exact frozen object. */
export function reconstructD65CoordinatorProjection(
  members: readonly Readonly<{ identity: string; kind: string; value: JsonObject }>[],
  expected: Readonly<{ repoId: string; workstreamRun: string; coveredEventSeq: number }>,
): D65CoordinatorProjectionSnapshot {
  const byKind = new Map<D65CoordinatorProjectionKind, D65CoordinatorProjectionMember[]>();
  const identities = new Set<string>();
  for (const raw of members) {
    if (!D65_COORDINATOR_PROJECTION_KINDS.includes(raw.kind as D65CoordinatorProjectionKind)) fail('coordinator projection entry has an unknown kind', [raw.kind, raw.identity]);
    const kind = raw.kind as D65CoordinatorProjectionKind;
    if (identities.has(raw.identity)) fail('coordinator projection has a duplicate entry identity', [raw.identity]);
    identities.add(raw.identity);
    const list = byKind.get(kind) ?? [];
    list.push({ identity: raw.identity, kind, value: raw.value });
    byKind.set(kind, list);
  }
  const singleton = (kind: Extract<D65CoordinatorProjectionKind, 'run' | 'resource' | 'current-terminal-intent-id' | 'covered-event-seq' | 'run-version'>): D65CoordinatorProjectionMember => {
    const list = byKind.get(kind) ?? [];
    if (list.length !== 1) fail('coordinator projection singleton cardinality is not exactly one', [kind, `count=${String(list.length)}`]);
    const member = list[0];
    if (member === undefined || member.identity !== d65CoordinatorProjectionIdentity(kind)) fail('coordinator projection singleton has a wrong/aliased identity', [kind, member?.identity ?? 'missing']);
    return member;
  };
  const rows = <T>(kind: Exclude<D65CoordinatorProjectionKind, 'run' | 'resource' | 'current-terminal-intent-id' | 'covered-event-seq' | 'run-version'>, parse: (value: unknown) => T, natural: (value: T) => string): readonly T[] => {
    const parsed = (byKind.get(kind) ?? []).map((member) => {
      const value = parse(member.value);
      const naturalIdentity = natural(value);
      const encoded = d65CoordinatorProjectionIdentity(kind, naturalIdentity);
      if (member.identity !== encoded) fail('coordinator projection row identity does not bind its complete embedded natural identity', [kind, member.identity, encoded, naturalIdentity]);
      return { naturalIdentity, value };
    });
    // Natural identifiers are restricted to the same ASCII identifier grammar.
    parsed.sort((left, right) => left.naturalIdentity < right.naturalIdentity ? -1 : left.naturalIdentity > right.naturalIdentity ? 1 : 0);
    for (let index = 1; index < parsed.length; index += 1) if (parsed[index - 1]?.naturalIdentity === parsed[index]?.naturalIdentity) fail('duplicate logical coordinator projection natural identity', [kind, parsed[index]?.naturalIdentity ?? '']);
    return Object.freeze(parsed.map((entry) => entry.value));
  };

  const run = parseCoordinationRun(singleton('run').value);
  const resource = parseCoordinationRunResource(singleton('resource').value);
  ensureRunScope(expected.repoId, expected.workstreamRun, run.repo_id, run.workstream_run, 'run');
  ensureRunScope(expected.repoId, expected.workstreamRun, resource.repo_id, resource.workstream_run, 'resource');

  const sessions = rows('session', parseSemanticSession, (row) => row.session_lease_id);
  for (const row of sessions) ensureRunScope(expected.repoId, expected.workstreamRun, row.repo_id, row.workstream_run, 'session');
  const children = rows('child', parseSemanticChild, (row) => row.child_lease_id);
  for (const row of children) ensureRunScope(expected.repoId, expected.workstreamRun, row.owner.repo_id, row.owner.workstream_run, 'child');
  const attempts = rows('attempt', parseAttempt, (row) => d65AttemptEntityId(row.attempt.owner));
  for (const row of attempts) ensureRunScope(expected.repoId, expected.workstreamRun, row.attempt.owner.repo_id, row.attempt.owner.workstream_run, 'attempt');
  const faults = rows('fault', parseRunScopedLogicalFault, (row) => row.fault_id);
  for (const row of faults) ensureRunScope(expected.repoId, expected.workstreamRun, row.repo_id, row.workstream_run, 'fault');
  const reservations = rows('reservation', parseCoordinationChangeReservation, (row) => row.reservation_id);
  for (const row of reservations) ensureRunScope(expected.repoId, expected.workstreamRun, row.repo_id, row.workstream_run, 'reservation');
  const editLeases = rows('edit-lease', parseCoordinationEditLease, (row) => row.edit_lease_id);
  for (const row of editLeases) ensureRunScope(expected.repoId, expected.workstreamRun, row.owner.repo_id, row.owner.workstream_run, 'edit lease');
  const acquisitionGroups = rows('acquisition-group', parseCoordinationAcquisitionGroup, (row) => row.acquisition_group_id);
  for (const row of acquisitionGroups) ensureRunScope(expected.repoId, expected.workstreamRun, row.owner.repo_id, row.owner.workstream_run, 'acquisition group');
  const worktrees = rows('worktree', parseCoordinationWorktree, (row) => row.worktree_id);
  for (const row of worktrees) ensureRunScope(expected.repoId, expected.workstreamRun, row.owner.repo_id, row.owner.workstream_run, 'worktree');
  const operations = rows('operation', parseCoordinationWorktreeOperation, (row) => row.operation_id);
  for (const row of operations) ensureRunScope(expected.repoId, expected.workstreamRun, row.owner.repo_id, row.owner.workstream_run, 'operation');
  const terminalIntents = rows('terminal-intent', parseIntent, (row) => row.terminal_intent_id);
  for (const row of terminalIntents) ensureRunScope(expected.repoId, expected.workstreamRun, row.repo_id, row.workstream_run, 'terminal intent');
  const artifacts = rows('artifact', parseCoordinationAuthoritativeArtifact, (row) => row.artifact_id);
  for (const row of artifacts) ensureRunScope(expected.repoId, expected.workstreamRun, row.repo_id, row.source_run, 'artifact');

  const pointerRecord = object(singleton('current-terminal-intent-id').value, 'coordinator_projection.current_terminal_intent_id', ['current_terminal_intent_id']);
  const pointerValue = pointerRecord['current_terminal_intent_id'];
  const pointer = pointerValue === null ? null : exactString(pointerRecord, 'current_terminal_intent_id', 'coordinator_projection.current_terminal_intent_id');
  const currentIntents = terminalIntents.filter((intent) => intent.state === 'prepared' || intent.state === 'committed');
  if (currentIntents.length > 1 || pointer !== (currentIntents[0]?.terminal_intent_id ?? null)) fail('current terminal intent pointer is not the sole prepared/committed intent', [String(pointer)]);

  const coveredRecord = object(singleton('covered-event-seq').value, 'coordinator_projection.covered_event_seq', ['covered_event_seq']);
  const covered = integer(coveredRecord, 'covered_event_seq', 'coordinator_projection.covered_event_seq', 0);
  if (covered !== expected.coveredEventSeq) fail('covered_event_seq singleton does not equal the graph root covered_event_seq', [String(covered), String(expected.coveredEventSeq)]);
  const runVersionRecord = object(singleton('run-version').value, 'coordinator_projection.run_version', ['run_version']);
  const runVersion = integer(runVersionRecord, 'run_version', 'coordinator_projection.run_version', 1);
  if (runVersion !== run.version) fail('run_version singleton does not equal the projected run row version', [String(runVersion), String(run.version)]);

  return Object.freeze({ run, resource, sessions, children, attempts, faults, reservations, edit_leases: editLeases, acquisition_groups: acquisitionGroups, worktrees, operations, terminal_intents: terminalIntents, current_terminal_intent_id: pointer, authoritative_artifacts: artifacts, covered_event_seq: covered, run_version: runVersion });
}

/**
 * Construct the distinguished non-self-referential B(N): add exactly N's
 * immutable artifact row at its registration R, advance only covered_event_seq
 * to R, and leave the semantic run/version and every other projection byte
 * unchanged. This helper is shared by successor registration and terminal-tail
 * entry; callers may not synthesize B(N) independently.
 */
export function applyD65GraphRegistrationBaseline(input: {
  readonly prior: D65CoordinatorProjectionSnapshot;
  readonly artifact: CoordinationAuthoritativeArtifact;
}): D65CoordinatorProjectionSnapshot {
  const { prior, artifact } = input;
  if (artifact.document_schema_version !== 'autopilot.semantic_graph.v1') fail('B(N) artifact is not a complete semantic graph');
  if (artifact.repo_id !== prior.run.repo_id || artifact.source_run !== prior.run.workstream_run) fail('B(N) artifact belongs to a different run');
  if (artifact.registered_event_seq !== prior.covered_event_seq + 1) fail('B(N) registration R is not prior E+1', [String(artifact.registered_event_seq), String(prior.covered_event_seq)]);
  if (prior.authoritative_artifacts.some((row) => row.artifact_id === artifact.artifact_id)) fail('B(N) prior projection already contains its own future artifact row', [artifact.artifact_id]);
  const artifacts = [...prior.authoritative_artifacts, artifact].sort((left, right) => left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0);
  return Object.freeze({ ...prior, authoritative_artifacts: Object.freeze(artifacts), covered_event_seq: artifact.registered_event_seq });
}

/** Structural equality for store-at-E comparison; all objects are canonical JSON values. */
export function assertD65CoordinatorProjectionEqual(actual: D65CoordinatorProjectionSnapshot, expected: D65CoordinatorProjectionSnapshot, canonicalize: (value: unknown) => string): void {
  const actualText = canonicalize(actual);
  const expectedText = canonicalize(expected);
  if (actualText !== expectedText) fail('loaded coordinator projection does not equal the committed coordinator state at E');
}

// Keep imports deliberately exercised by the closed parser surface.
void AUTOPILOT_RUN_SCOPED_FAULT_SCHEMA;
void array;
void nullableSha256Field;
void HEX64;
