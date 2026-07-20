import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { CoordinationRuntimeError } from './failures.ts';

// D65-A1/A2 semantic graph authority contract (freeze §9.1–9.5, fresh plan
// "Semantic graph authority contract"). These are the closed, versioned,
// size-bounded, lowest-layer parsers for the pre-run bootstrap envelope, the
// complete graph root, its authority/projection shards, the D65 append-only
// terminal-intent v2 row, the graph-publication saga residue, and the
// current-build attach_run_result.v2 effect. Unknown fields, wrong types, or
// out-of-range values fail loudly; there is no fallback parser.

// ---- shared bounded primitives (independent of contracts.ts to keep this a
// self-contained lowest layer that both the store and tests can import) -------

type JsonObject = Readonly<Record<string, unknown>>;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RUN_NONCE = /^[a-f0-9]{6}$/u;

export const D65_GRAPH_ROOT_MAX_BYTES = 1_048_576 as const;
export const D65_GRAPH_AGGREGATE_MAX_BYTES = 536_870_912 as const;
export const D65_GRAPH_AGGREGATE_MAX_ENTRIES = 200_000 as const;

export function fail(label: string, issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-state', `${label}: ${issue}`, [...detail]);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function object(value: unknown, label: string, fields: readonly string[]): JsonObject {
  if (!isJsonObject(value)) fail(label, 'must be an object');
  const record = value;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  const unknown = actual.filter((key) => !expected.includes(key));
  if (unknown.length > 0) fail(label, `contains unknown fields: ${unknown.join(', ')}`);
  const missing = expected.filter((key) => !(key in record));
  if (missing.length > 0) fail(label, `missing required fields: ${missing.join(', ')}`);
  return record;
}

export function str(record: JsonObject, field: string, label: string, maxLength = 512): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\u0000')) fail(label, `${field} must be a bounded non-empty string`);
  return value;
}

export function nullableStr(record: JsonObject, field: string, label: string, maxLength = 512): string | null {
  if (record[field] === null) return null;
  return str(record, field, label, maxLength);
}

export function identifier(record: JsonObject, field: string, label: string): string {
  const value = str(record, field, label, 192);
  if (!IDENTIFIER.test(value)) fail(label, `${field} is not a bounded identifier`);
  return value;
}

export function integer(record: JsonObject, field: string, label: string, minimum = 0): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(label, `${field} must be a safe integer >= ${String(minimum)}`);
  return value;
}

export function nullableInteger(record: JsonObject, field: string, label: string, minimum = 0): number | null {
  if (record[field] === null) return null;
  return integer(record, field, label, minimum);
}

export function boolean(record: JsonObject, field: string, label: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') fail(label, `${field} must be boolean`);
  return value;
}

export function literal<T extends string>(record: JsonObject, field: string, expected: T, label: string): T {
  if (record[field] !== expected) fail(label, `${field} must equal ${expected}`);
  return expected;
}

export function oneOf<T extends readonly string[]>(record: JsonObject, field: string, values: T, label: string): T[number] {
  const value = record[field];
  if (typeof value !== 'string' || !values.includes(value)) fail(label, `${field} must be one of ${values.join(', ')}`);
  return value as T[number];
}

export function sha256Field(record: JsonObject, field: string, label: string): `sha256:${string}` {
  const value = str(record, field, label, 71);
  if (!SHA256.test(value)) fail(label, `${field} must be sha256:<64 lowercase hex>`);
  return value as `sha256:${string}`;
}

export function nullableSha256Field(record: JsonObject, field: string, label: string): `sha256:${string}` | null {
  if (record[field] === null) return null;
  return sha256Field(record, field, label);
}

export function gitOid(record: JsonObject, field: string, label: string): string {
  const value = str(record, field, label, 40);
  if (!GIT_OID.test(value)) fail(label, `${field} must be a full 40-lowercase-hex Git OID`);
  return value;
}

export function nullableGitOid(record: JsonObject, field: string, label: string): string | null {
  if (record[field] === null) return null;
  return gitOid(record, field, label);
}

export function timestamp(record: JsonObject, field: string, label: string): string {
  const value = str(record, field, label, 32);
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) fail(label, `${field} must be an ISO UTC millisecond timestamp`);
  return value;
}

/** A bounded repository-relative path with no absolute/parent/dot segments. */
export function repoRelativePath(record: JsonObject, field: string, label: string, maxLength = 512): string {
  const value = str(record, field, label, maxLength);
  const segments = value.split('/');
  if (value.startsWith('/') || value.startsWith('./') || value.endsWith('/') || value.includes('//') || /^[A-Za-z]:/u.test(value) || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value) || segments.includes('.') || segments.includes('..')) fail(label, `${field} must be a normalized repository-relative path`);
  return value;
}

export function array(value: unknown, label: string, maxItems: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) fail(label, `must be an array with at most ${String(maxItems)} entries`);
  return value;
}

/** RFC-8785-plus-LF SHA-256 of a JSON value: `sha256:<hex>`. */
export function canonicalSha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(`${canonicalJson(value)}\n`, 'utf8').digest('hex')}`;
}

export function bytesSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

// ---- prospective run/resource (subset validated for identity binding) -------

/**
 * A prospective canonical object is the exact byte image of the row the same
 * transaction will create. We keep it as a bounded JSON object and require the
 * caller to prove byte-equality against the created row.
 */
export function boundedProspective(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) fail(label, 'must be an object');
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 64) fail(label, 'prospective object field count is out of range');
  return value;
}

// ---- autopilot.semantic_graph_bootstrap.v1 ----------------------------------

export const D65_BOOTSTRAP_SCHEMA = 'autopilot.semantic_graph_bootstrap.v1' as const;

/** The exact ordered allowed bootstrap operations (§9.5). */
export const D65_ALLOWED_BOOTSTRAP_OPERATIONS = [
  'attach-run',
  'attach-session',
  'prepare-main-worktree',
  'transition-main-worktree',
  'register-launch-policy',
  'accept-program-heartbeat',
  'parent-planning',
  'publish-complete-graph',
] as const;

export interface D65SemanticGraphBootstrap {
  readonly schema_version: typeof D65_BOOTSTRAP_SCHEMA;
  readonly program_id: string;
  readonly graph_sequence: 1;
  readonly prior_graph_sha256: null;
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly run_timestamp: string;
  readonly run_nonce: string;
  readonly content_commit: string;
  readonly content_tree: string;
  readonly package_commit: string;
  readonly package_tree: string;
  readonly prospective_run: JsonObject;
  readonly prospective_resource: JsonObject;
  readonly covered_event_seq: 0;
  readonly trust_anchor_ref: string;
  readonly trust_anchor_sha256: `sha256:${string}`;
  readonly allowed_bootstrap_operations: readonly string[];
  readonly created_at: string;
}

export function parseD65SemanticGraphBootstrap(value: unknown): D65SemanticGraphBootstrap {
  const label = 'autopilot.semantic_graph_bootstrap.v1';
  const record = object(value, label, [
    'schema_version', 'program_id', 'graph_sequence', 'prior_graph_sha256', 'repo_id', 'autopilot_id',
    'workstream', 'workstream_run', 'run_timestamp', 'run_nonce', 'content_commit', 'content_tree',
    'package_commit', 'package_tree', 'prospective_run', 'prospective_resource', 'covered_event_seq',
    'trust_anchor_ref', 'trust_anchor_sha256', 'allowed_bootstrap_operations', 'created_at',
  ]);
  literal(record, 'schema_version', D65_BOOTSTRAP_SCHEMA, label);
  if (record['graph_sequence'] !== 1) fail(label, 'graph_sequence must be exactly 1');
  if (record['prior_graph_sha256'] !== null) fail(label, 'prior_graph_sha256 must be null');
  if (record['covered_event_seq'] !== 0) fail(label, 'covered_event_seq must be exactly 0 (D65 requires repository absence)');
  const runNonce = str(record, 'run_nonce', label, 6);
  if (!RUN_NONCE.test(runNonce)) fail(label, 'run_nonce must be exactly six lowercase hex characters');
  const operations = array(record['allowed_bootstrap_operations'], `${label}.allowed_bootstrap_operations`, 8);
  if (operations.length !== D65_ALLOWED_BOOTSTRAP_OPERATIONS.length || operations.some((op, index) => op !== D65_ALLOWED_BOOTSTRAP_OPERATIONS[index])) {
    fail(label, 'allowed_bootstrap_operations must be the exact ordered frozen array');
  }
  return {
    schema_version: D65_BOOTSTRAP_SCHEMA,
    program_id: identifier(record, 'program_id', label),
    graph_sequence: 1,
    prior_graph_sha256: null,
    repo_id: identifier(record, 'repo_id', label),
    autopilot_id: identifier(record, 'autopilot_id', label),
    workstream: identifier(record, 'workstream', label),
    workstream_run: identifier(record, 'workstream_run', label),
    run_timestamp: timestamp(record, 'run_timestamp', label),
    run_nonce: runNonce,
    content_commit: gitOid(record, 'content_commit', label),
    content_tree: gitOid(record, 'content_tree', label),
    package_commit: gitOid(record, 'package_commit', label),
    package_tree: gitOid(record, 'package_tree', label),
    prospective_run: boundedProspective(record['prospective_run'], `${label}.prospective_run`),
    prospective_resource: boundedProspective(record['prospective_resource'], `${label}.prospective_resource`),
    covered_event_seq: 0,
    trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label),
    trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
    allowed_bootstrap_operations: Object.freeze([...D65_ALLOWED_BOOTSTRAP_OPERATIONS]),
    created_at: timestamp(record, 'created_at', label),
  };
}

// ---- autopilot.run_terminal_intent.v2 ---------------------------------------

export const D65_TERMINAL_INTENT_V2_SCHEMA = 'autopilot.run_terminal_intent.v2' as const;
export const TERMINAL_INTENT_CANCELLATION_MAX = 3 as const;

export interface D65ReservationObligationRow {
  readonly [key: string]: unknown;
}

export interface D65TerminalEffectSets {
  readonly blocking_owned_obligations: readonly JsonObject[];
  readonly foreign_dependent_obligations: readonly JsonObject[];
  readonly abort_owned_obligations: readonly JsonObject[];
  readonly other_nonterminal_obligations: readonly JsonObject[];
}

export interface D65RunTerminalIntentV2 {
  readonly schema_version: typeof D65_TERMINAL_INTENT_V2_SCHEMA;
  readonly terminal_intent_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly intent_attempt: number;
  readonly prior_terminal_intent_id: string | null;
  readonly prior_terminal_intent_sha256: `sha256:${string}` | null;
  readonly outcome: 'closed' | 'aborted';
  readonly state: 'prepared' | 'committed' | 'cancelled';
  readonly reservation_ids: readonly string[];
  readonly terminal_effect_sets: D65TerminalEffectSets;
  readonly prepared_event_seq: number;
  readonly terminal_event_seq: number | null;
  readonly version: number;
}

function obligationRows(value: unknown, label: string): readonly JsonObject[] {
  const entries = array(value, label, 100_000);
  const rows: JsonObject[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isJsonObject(entry)) fail(label, `entry ${String(index)} must be an object`);
    const schema = entry['schema_version'];
    if (schema !== 'autopilot.reservation_obligation.v1') fail(label, `entry ${String(index)} must be a reservation obligation row`);
    const obligationId = entry['obligation_id'];
    if (typeof obligationId !== 'string' || obligationId.length === 0) fail(label, `entry ${String(index)} lacks an obligation_id`);
    if (seen.has(obligationId)) fail(label, `duplicate obligation identity ${obligationId}`);
    seen.add(obligationId);
    rows.push(entry);
  }
  // Sorted by obligation_id decoded bytes.
  for (let index = 1; index < rows.length; index += 1) {
    const previous = String(rows[index - 1]?.['obligation_id']);
    const current = String(rows[index]?.['obligation_id']);
    if (!(previous < current)) fail(label, 'obligation rows must be sorted by obligation_id decoded bytes');
  }
  return Object.freeze(rows);
}

export function parseD65TerminalEffectSets(value: unknown, label: string): D65TerminalEffectSets {
  const record = object(value, label, [
    'blocking_owned_obligations', 'foreign_dependent_obligations', 'abort_owned_obligations', 'other_nonterminal_obligations',
  ]);
  return {
    blocking_owned_obligations: obligationRows(record['blocking_owned_obligations'], `${label}.blocking_owned_obligations`),
    foreign_dependent_obligations: obligationRows(record['foreign_dependent_obligations'], `${label}.foreign_dependent_obligations`),
    abort_owned_obligations: obligationRows(record['abort_owned_obligations'], `${label}.abort_owned_obligations`),
    other_nonterminal_obligations: obligationRows(record['other_nonterminal_obligations'], `${label}.other_nonterminal_obligations`),
  };
}

export function parseD65RunTerminalIntentV2(value: unknown): D65RunTerminalIntentV2 {
  const label = D65_TERMINAL_INTENT_V2_SCHEMA;
  const record = object(value, label, [
    'schema_version', 'terminal_intent_id', 'repo_id', 'workstream_run', 'intent_attempt',
    'prior_terminal_intent_id', 'prior_terminal_intent_sha256', 'outcome', 'state', 'reservation_ids',
    'terminal_effect_sets', 'prepared_event_seq', 'terminal_event_seq', 'version',
  ]);
  literal(record, 'schema_version', D65_TERMINAL_INTENT_V2_SCHEMA, label);
  const intentAttempt = integer(record, 'intent_attempt', label, 1);
  if (intentAttempt > TERMINAL_INTENT_CANCELLATION_MAX + 1) fail(label, `intent_attempt must be <= ${String(TERMINAL_INTENT_CANCELLATION_MAX + 1)}`);
  const priorId = nullableStr(record, 'prior_terminal_intent_id', label, 192);
  const priorSha = nullableSha256Field(record, 'prior_terminal_intent_sha256', label);
  if (intentAttempt === 1) {
    if (priorId !== null || priorSha !== null) fail(label, 'attempt 1 must carry null prior chain fields');
  } else {
    if (priorId === null || priorSha === null) fail(label, 'attempts after the first must name the exact prior intent id and digest');
  }
  const outcome = oneOf(record, 'outcome', ['closed', 'aborted'] as const, label);
  if (intentAttempt === TERMINAL_INTENT_CANCELLATION_MAX + 1 && outcome !== 'aborted') fail(label, 'the mandatory fourth attempt must be a noncancellable abort');
  const reservationIds = array(record['reservation_ids'], `${label}.reservation_ids`, 100_000).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 192) fail(label, `reservation_ids[${String(index)}] must be a bounded identifier`);
    return entry;
  });
  if (new Set(reservationIds).size !== reservationIds.length) fail(label, 'reservation_ids must be unique');
  const terminalEventSeq = nullableInteger(record, 'terminal_event_seq', label, 1);
  const state = oneOf(record, 'state', ['prepared', 'committed', 'cancelled'] as const, label);
  if (state === 'prepared' && terminalEventSeq !== null) fail(label, 'prepared intent has no terminal_event_seq');
  if ((state === 'committed' || state === 'cancelled') && terminalEventSeq === null) fail(label, 'committed/cancelled intent requires a terminal_event_seq');
  return {
    schema_version: D65_TERMINAL_INTENT_V2_SCHEMA,
    terminal_intent_id: identifier(record, 'terminal_intent_id', label),
    repo_id: identifier(record, 'repo_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    intent_attempt: intentAttempt,
    prior_terminal_intent_id: priorId,
    prior_terminal_intent_sha256: priorSha,
    outcome,
    state,
    reservation_ids: Object.freeze(reservationIds),
    terminal_effect_sets: parseD65TerminalEffectSets(record['terminal_effect_sets'], `${label}.terminal_effect_sets`),
    prepared_event_seq: integer(record, 'prepared_event_seq', label, 1),
    terminal_event_seq: terminalEventSeq,
    version: integer(record, 'version', label, 1),
  };
}

// ---- autopilot.graph_publication.v1 (saga residue) --------------------------

export const D65_GRAPH_PUBLICATION_SCHEMA = 'autopilot.graph_publication.v1' as const;
export const D65_GRAPH_PUBLICATION_STAGES = ['prepared', 'authority-committed', 'publication-committed', 'registered'] as const;
export type D65GraphPublicationStage = (typeof D65_GRAPH_PUBLICATION_STAGES)[number];
export const D65_GRAPH_PRIOR_AUTHORITY_KINDS = ['bootstrap', 'complete'] as const;

export interface D65GraphPublication {
  readonly schema_version: typeof D65_GRAPH_PUBLICATION_SCHEMA;
  readonly publication_id: string;
  readonly program_id: string;
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream_run: string;
  readonly graph_sequence: number;
  readonly artifact_id: string;
  readonly stage: D65GraphPublicationStage;
  readonly prior_authority_kind: 'bootstrap' | 'complete';
  readonly prior_graph_sha256: `sha256:${string}`;
  readonly prior_publication_commit: string | null;
  readonly prior_registration_event_seq: number;
  readonly authority_base_commit: string;
  readonly authority_path_count: number;
  readonly authority_path_manifest_sha256: `sha256:${string}`;
  readonly authority_commit: string | null;
  readonly authority_tree: string | null;
  readonly covered_event_seq: number;
  readonly publication_commit: string | null;
  readonly publication_tree: string | null;
  readonly graph_ref: string | null;
  readonly graph_sha256: `sha256:${string}` | null;
  readonly graph_byte_count: number | null;
  readonly registration_event_seq: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function parseD65GraphPublication(value: unknown): D65GraphPublication {
  const label = D65_GRAPH_PUBLICATION_SCHEMA;
  const record = object(value, label, [
    'schema_version', 'publication_id', 'program_id', 'repo_id', 'autopilot_id', 'workstream_run',
    'graph_sequence', 'artifact_id', 'stage', 'prior_authority_kind', 'prior_graph_sha256',
    'prior_publication_commit', 'prior_registration_event_seq', 'authority_base_commit',
    'authority_path_count', 'authority_path_manifest_sha256', 'authority_commit', 'authority_tree',
    'covered_event_seq', 'publication_commit', 'publication_tree', 'graph_ref', 'graph_sha256',
    'graph_byte_count', 'registration_event_seq', 'created_at', 'updated_at',
  ]);
  literal(record, 'schema_version', D65_GRAPH_PUBLICATION_SCHEMA, label);
  const stage = oneOf(record, 'stage', D65_GRAPH_PUBLICATION_STAGES, label);
  const priorKind = oneOf(record, 'prior_authority_kind', D65_GRAPH_PRIOR_AUTHORITY_KINDS, label);
  const priorPublicationCommit = nullableGitOid(record, 'prior_publication_commit', label);
  // For bootstrap prior authority prior_publication_commit is null; for complete
  // prior authority it is the accepted publication commit.
  if (priorKind === 'bootstrap' && priorPublicationCommit !== null) fail(label, 'bootstrap prior authority must have null prior_publication_commit');
  if (priorKind === 'complete' && priorPublicationCommit === null) fail(label, 'complete prior authority requires prior_publication_commit');
  const authorityCommit = nullableGitOid(record, 'authority_commit', label);
  const authorityTree = nullableGitOid(record, 'authority_tree', label);
  const publicationCommit = nullableGitOid(record, 'publication_commit', label);
  const publicationTree = nullableGitOid(record, 'publication_tree', label);
  const graphRef = record['graph_ref'] === null ? null : repoRelativePath(record, 'graph_ref', label);
  const graphSha = nullableSha256Field(record, 'graph_sha256', label);
  const graphByteCount = nullableInteger(record, 'graph_byte_count', label, 0);
  const registrationEventSeq = nullableInteger(record, 'registration_event_seq', label, 1);
  // Stage-monotonic null discipline.
  const authorityPresent = stage === 'authority-committed' || stage === 'publication-committed' || stage === 'registered';
  const publicationPresent = stage === 'publication-committed' || stage === 'registered';
  const registered = stage === 'registered';
  if (authorityPresent !== (authorityCommit !== null && authorityTree !== null)) fail(label, 'authority commit/tree presence must match stage');
  if (publicationPresent !== (publicationCommit !== null && publicationTree !== null && graphRef !== null && graphSha !== null && graphByteCount !== null)) fail(label, 'publication commit/tree/ref/hash/byte-count presence must match stage');
  if (registered !== (registrationEventSeq !== null)) fail(label, 'registration_event_seq presence must match the registered stage');
  if (graphByteCount !== null && graphByteCount > D65_GRAPH_ROOT_MAX_BYTES) fail(label, 'graph_byte_count exceeds the 1 MiB graph-root bound');
  return {
    schema_version: D65_GRAPH_PUBLICATION_SCHEMA,
    publication_id: identifier(record, 'publication_id', label),
    program_id: identifier(record, 'program_id', label),
    repo_id: identifier(record, 'repo_id', label),
    autopilot_id: identifier(record, 'autopilot_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    graph_sequence: integer(record, 'graph_sequence', label, 1),
    artifact_id: identifier(record, 'artifact_id', label),
    stage,
    prior_authority_kind: priorKind,
    prior_graph_sha256: sha256Field(record, 'prior_graph_sha256', label),
    prior_publication_commit: priorPublicationCommit,
    prior_registration_event_seq: integer(record, 'prior_registration_event_seq', label, 1),
    authority_base_commit: gitOid(record, 'authority_base_commit', label),
    authority_path_count: integer(record, 'authority_path_count', label, 0),
    authority_path_manifest_sha256: sha256Field(record, 'authority_path_manifest_sha256', label),
    authority_commit: authorityCommit,
    authority_tree: authorityTree,
    covered_event_seq: integer(record, 'covered_event_seq', label, 1),
    publication_commit: publicationCommit,
    publication_tree: publicationTree,
    graph_ref: graphRef,
    graph_sha256: graphSha,
    graph_byte_count: graphByteCount,
    registration_event_seq: registrationEventSeq,
    created_at: timestamp(record, 'created_at', label),
    updated_at: timestamp(record, 'updated_at', label),
  };
}

// ---- autopilot.semantic_graph_authority_shard.v1 ----------------------------

export const D65_AUTHORITY_SHARD_SCHEMA = 'autopilot.semantic_graph_authority_shard.v1' as const;

export interface D65AuthorityShardEntry {
  readonly identity: string;
  readonly ref: string;
  readonly git_mode: string;
  readonly git_blob_oid: string;
  readonly sha256: `sha256:${string}`;
  readonly byte_count: number;
  readonly document_schema_version: string | null;
}

export interface D65AuthorityShard {
  readonly schema_version: typeof D65_AUTHORITY_SHARD_SCHEMA;
  readonly program_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly graph_sequence: number;
  readonly collection: string;
  readonly entry_count: number;
  readonly total_bytes: number;
  readonly first_identity: string;
  readonly last_identity: string;
  readonly entries: readonly D65AuthorityShardEntry[];
}

const GIT_BLOB_MODES = ['100644', '100755', '120000'] as const;

function shardEntry(value: unknown, label: string): D65AuthorityShardEntry {
  const record = object(value, label, ['identity', 'ref', 'git_mode', 'git_blob_oid', 'sha256', 'byte_count', 'document_schema_version']);
  return {
    identity: identifier(record, 'identity', label),
    ref: repoRelativePath(record, 'ref', label),
    git_mode: oneOf(record, 'git_mode', GIT_BLOB_MODES, label),
    git_blob_oid: gitOid(record, 'git_blob_oid', label),
    sha256: sha256Field(record, 'sha256', label),
    byte_count: integer(record, 'byte_count', label, 0),
    document_schema_version: nullableStr(record, 'document_schema_version', label, 128),
  };
}

export function parseD65AuthorityShard(value: unknown): D65AuthorityShard {
  const label = D65_AUTHORITY_SHARD_SCHEMA;
  const record = object(value, label, [
    'schema_version', 'program_id', 'repo_id', 'workstream_run', 'graph_sequence', 'collection',
    'entry_count', 'total_bytes', 'first_identity', 'last_identity', 'entries',
  ]);
  literal(record, 'schema_version', D65_AUTHORITY_SHARD_SCHEMA, label);
  const entries = array(record['entries'], `${label}.entries`, 200_000).map((entry, index) => shardEntry(entry, `${label}.entries[${String(index)}]`));
  if (entries.length === 0) fail(label, 'zero-entry shards are forbidden');
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]?.identity ?? '';
    const current = entries[index]?.identity ?? '';
    if (!(previous < current)) fail(label, 'shard entries must be sorted by decoded identity bytes with no duplicates');
  }
  const entryCount = integer(record, 'entry_count', label, 1);
  if (entryCount !== entries.length) fail(label, 'entry_count must equal the number of entries');
  const totalBytes = integer(record, 'total_bytes', label, 0);
  const summed = entries.reduce((total, entry) => total + entry.byte_count, 0);
  if (totalBytes !== summed) fail(label, 'total_bytes must equal the checked sum of member byte_count');
  const firstIdentity = identifier(record, 'first_identity', label);
  const lastIdentity = identifier(record, 'last_identity', label);
  if (firstIdentity !== entries[0]?.identity || lastIdentity !== entries[entries.length - 1]?.identity) fail(label, 'first/last identity must equal the shard slice endpoints');
  return {
    schema_version: D65_AUTHORITY_SHARD_SCHEMA,
    program_id: identifier(record, 'program_id', label),
    repo_id: identifier(record, 'repo_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    graph_sequence: integer(record, 'graph_sequence', label, 1),
    collection: identifier(record, 'collection', label),
    entry_count: entryCount,
    total_bytes: totalBytes,
    first_identity: firstIdentity,
    last_identity: lastIdentity,
    entries: Object.freeze(entries),
  };
}

// ---- autopilot.semantic_graph_projection_shard.v1 ---------------------------

export const D65_PROJECTION_SHARD_SCHEMA = 'autopilot.semantic_graph_projection_shard.v1' as const;

export interface D65ProjectionShardEntry {
  readonly identity: string;
  readonly kind: string;
  readonly value_sha256: `sha256:${string}`;
  readonly value: JsonObject;
}

export interface D65ProjectionShard {
  readonly schema_version: typeof D65_PROJECTION_SHARD_SCHEMA;
  readonly program_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly graph_sequence: number;
  readonly projection_kind: string;
  readonly entry_count: number;
  readonly total_bytes: number;
  readonly first_identity: string;
  readonly last_identity: string;
  readonly entries: readonly D65ProjectionShardEntry[];
}

function projectionEntry(value: unknown, label: string): D65ProjectionShardEntry {
  const record = object(value, label, ['identity', 'kind', 'value_sha256', 'value']);
  const inner = record['value'];
  if (!isJsonObject(inner)) fail(label, 'value must be a closed package object');
  const valueSha = sha256Field(record, 'value_sha256', label);
  const recomputed = canonicalSha256(inner);
  if (recomputed !== valueSha) fail(label, 'value_sha256 must equal SHA-256 of the RFC-8785 value bytes plus LF');
  return {
    identity: identifier(record, 'identity', label),
    kind: identifier(record, 'kind', label),
    value_sha256: valueSha,
    value: inner,
  };
}

export function parseD65ProjectionShard(value: unknown): D65ProjectionShard {
  const label = D65_PROJECTION_SHARD_SCHEMA;
  const record = object(value, label, [
    'schema_version', 'program_id', 'repo_id', 'workstream_run', 'graph_sequence', 'projection_kind',
    'entry_count', 'total_bytes', 'first_identity', 'last_identity', 'entries',
  ]);
  literal(record, 'schema_version', D65_PROJECTION_SHARD_SCHEMA, label);
  const entries = array(record['entries'], `${label}.entries`, 200_000).map((entry, index) => projectionEntry(entry, `${label}.entries[${String(index)}]`));
  if (entries.length === 0) fail(label, 'zero-entry projection shards are forbidden');
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]?.identity ?? '';
    const current = entries[index]?.identity ?? '';
    if (!(previous < current)) fail(label, 'projection entries must be sorted by decoded identity bytes with no duplicates');
  }
  const entryCount = integer(record, 'entry_count', label, 1);
  if (entryCount !== entries.length) fail(label, 'entry_count must equal the number of entries');
  const firstIdentity = identifier(record, 'first_identity', label);
  const lastIdentity = identifier(record, 'last_identity', label);
  if (firstIdentity !== entries[0]?.identity || lastIdentity !== entries[entries.length - 1]?.identity) fail(label, 'first/last identity must equal the shard slice endpoints');
  return {
    schema_version: D65_PROJECTION_SHARD_SCHEMA,
    program_id: identifier(record, 'program_id', label),
    repo_id: identifier(record, 'repo_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    graph_sequence: integer(record, 'graph_sequence', label, 1),
    projection_kind: identifier(record, 'projection_kind', label),
    entry_count: entryCount,
    total_bytes: integer(record, 'total_bytes', label, 0),
    first_identity: firstIdentity,
    last_identity: lastIdentity,
    entries: Object.freeze(entries),
  };
}

// ---- autopilot.attach_run_result.v2 -----------------------------------------

export const D65_ATTACH_RUN_RESULT_V2_SCHEMA = 'autopilot.attach_run_result.v2' as const;

export interface D65BootstrapGraphRef {
  readonly ref: string;
  readonly sha256: `sha256:${string}`;
  readonly byte_count: number;
  readonly git_commit: string;
  readonly covered_event_seq: 0;
}

export interface D65TrustAnchorResult {
  readonly trust_anchor_ref: string;
  readonly trust_anchor_sha256: `sha256:${string}`;
  readonly git_commit: string;
  readonly git_mode: '100644';
  readonly git_type: 'blob';
  readonly git_blob_oid: string;
  readonly byte_count: 44;
}

export interface D65AttachRunResultV2 {
  readonly schema_version: typeof D65_ATTACH_RUN_RESULT_V2_SCHEMA;
  readonly repository: JsonObject;
  readonly run: JsonObject;
  readonly run_resource: JsonObject;
  readonly mailbox_cursor: JsonObject;
  readonly bootstrap_graph: D65BootstrapGraphRef;
  readonly bootstrap_artifact: JsonObject;
  readonly trust_anchor: D65TrustAnchorResult;
}

/** The bootstrap-graph binding on attach-run.bootstrap_graph and result. */
export function parseD65BootstrapGraphRef(value: unknown, label: string): D65BootstrapGraphRef {
  const record = object(value, label, ['ref', 'sha256', 'byte_count', 'git_commit', 'covered_event_seq']);
  if (record['covered_event_seq'] !== 0) fail(label, 'covered_event_seq must be exactly 0');
  const byteCount = integer(record, 'byte_count', label, 1);
  if (byteCount > D65_GRAPH_ROOT_MAX_BYTES) fail(label, 'bootstrap graph byte_count exceeds the 1 MiB root bound');
  return {
    ref: repoRelativePath(record, 'ref', label),
    sha256: sha256Field(record, 'sha256', label),
    byte_count: byteCount,
    git_commit: gitOid(record, 'git_commit', label),
    covered_event_seq: 0,
  };
}

export function parseD65TrustAnchorResult(value: unknown, label: string): D65TrustAnchorResult {
  const record = object(value, label, ['trust_anchor_ref', 'trust_anchor_sha256', 'git_commit', 'git_mode', 'git_type', 'git_blob_oid', 'byte_count']);
  if (record['byte_count'] !== 44) fail(label, 'trust anchor byte_count must be exactly 44');
  literal(record, 'git_mode', '100644', label);
  literal(record, 'git_type', 'blob', label);
  return {
    trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label),
    trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
    git_commit: gitOid(record, 'git_commit', label),
    git_mode: '100644',
    git_type: 'blob',
    git_blob_oid: gitOid(record, 'git_blob_oid', label),
    byte_count: 44,
  };
}

export function parseD65AttachRunResultV2(value: unknown): D65AttachRunResultV2 {
  const label = D65_ATTACH_RUN_RESULT_V2_SCHEMA;
  const record = object(value, label, [
    'schema_version', 'repository', 'run', 'run_resource', 'mailbox_cursor', 'bootstrap_graph', 'bootstrap_artifact', 'trust_anchor',
  ]);
  literal(record, 'schema_version', D65_ATTACH_RUN_RESULT_V2_SCHEMA, label);
  if (!isJsonObject(record['repository'])) fail(label, 'repository must be the canonical post-B repository object');
  if (!isJsonObject(record['run'])) fail(label, 'run must be the canonical post-B run object');
  if (!isJsonObject(record['run_resource'])) fail(label, 'run_resource must be the canonical post-B resource object');
  if (!isJsonObject(record['mailbox_cursor'])) fail(label, 'mailbox_cursor must be the canonical post-B mailbox cursor object');
  if (!isJsonObject(record['bootstrap_artifact'])) fail(label, 'bootstrap_artifact must be the canonical post-B artifact object');
  return {
    schema_version: D65_ATTACH_RUN_RESULT_V2_SCHEMA,
    repository: record['repository'],
    run: record['run'],
    run_resource: record['run_resource'],
    mailbox_cursor: record['mailbox_cursor'],
    bootstrap_graph: parseD65BootstrapGraphRef(record['bootstrap_graph'], `${label}.bootstrap_graph`),
    bootstrap_artifact: record['bootstrap_artifact'],
    trust_anchor: parseD65TrustAnchorResult(record['trust_anchor'], `${label}.trust_anchor`),
  };
}

// ---- autopilot.semantic_graph.v1 (complete graph root) ----------------------

export const D65_COMPLETE_GRAPH_SCHEMA = 'autopilot.semantic_graph.v1' as const;

/** A shard descriptor names a shard blob and its contiguous identity slice. */
export interface D65ShardDescriptor {
  readonly ref: string;
  readonly sha256: `sha256:${string}`;
  readonly byte_count: number;
  readonly entry_count: number;
  readonly first_identity: string;
  readonly last_identity: string;
}

/** A projection index: aggregate counts/bytes/digest plus sorted descriptors. */
export interface D65ProjectionIndex {
  readonly entry_count: number;
  readonly total_bytes: number;
  readonly sha256: `sha256:${string}`;
  readonly shards: readonly D65ShardDescriptor[];
}

const EMPTY_INDEX_SHA256 = canonicalSha256([]);

function shardDescriptor(value: unknown, label: string): D65ShardDescriptor {
  const record = object(value, label, ['ref', 'sha256', 'byte_count', 'entry_count', 'first_identity', 'last_identity']);
  return {
    ref: repoRelativePath(record, 'ref', label),
    sha256: sha256Field(record, 'sha256', label),
    byte_count: integer(record, 'byte_count', label, 1),
    entry_count: integer(record, 'entry_count', label, 1),
    first_identity: identifier(record, 'first_identity', label),
    last_identity: identifier(record, 'last_identity', label),
  };
}

export function parseD65ProjectionIndex(value: unknown, label: string): D65ProjectionIndex {
  const record = object(value, label, ['entry_count', 'total_bytes', 'sha256', 'shards']);
  const entryCount = integer(record, 'entry_count', label, 0);
  const totalBytes = integer(record, 'total_bytes', label, 0);
  const digest = sha256Field(record, 'sha256', label);
  const shards = array(record['shards'], `${label}.shards`, 100_000).map((entry, index) => shardDescriptor(entry, `${label}.shards[${String(index)}]`));
  if (entryCount === 0) {
    // Empty index: count/bytes 0, digest of canonical [] plus LF, shards=[].
    if (totalBytes !== 0 || shards.length !== 0) fail(label, 'empty index must have zero bytes and no shards');
    if (digest !== EMPTY_INDEX_SHA256) fail(label, 'empty index digest must be SHA-256 of canonical [] plus LF');
  } else {
    if (shards.length === 0) fail(label, 'non-empty index requires at least one shard');
    // Descriptor ranges must be contiguous with no gap/overlap, sorted.
    const summedEntries = shards.reduce((total, shard) => total + shard.entry_count, 0);
    if (summedEntries !== entryCount) fail(label, 'aggregate entry_count must equal the sum of descriptor entry counts');
    for (let index = 1; index < shards.length; index += 1) {
      const previousLast = shards[index - 1]?.last_identity ?? '';
      const currentFirst = shards[index]?.first_identity ?? '';
      if (!(previousLast < currentFirst)) fail(label, 'shard descriptors must sort by identity range with no gap or overlap');
    }
    for (const shard of shards) if (!(shard.first_identity <= shard.last_identity)) fail(label, 'shard descriptor first_identity must not exceed last_identity');
  }
  return { entry_count: entryCount, total_bytes: totalBytes, sha256: digest, shards: Object.freeze(shards) };
}

const D65_CORE_KEYS = ['mission', 'master_plan', 'state', 'decision_log', 'events'] as const;

export interface D65CoreEntry {
  readonly ref: string;
  readonly git_mode: '100644';
  readonly git_blob_oid: string;
  readonly sha256: `sha256:${string}`;
  readonly byte_count: number;
  readonly record_count: number | null;
  readonly document_schema_version: string | null;
}

function coreEntry(value: unknown, label: string): D65CoreEntry {
  const record = object(value, label, ['ref', 'git_mode', 'git_blob_oid', 'sha256', 'byte_count', 'record_count', 'document_schema_version']);
  return {
    ref: repoRelativePath(record, 'ref', label),
    git_mode: literal(record, 'git_mode', '100644', label),
    git_blob_oid: gitOid(record, 'git_blob_oid', label),
    sha256: sha256Field(record, 'sha256', label),
    byte_count: integer(record, 'byte_count', label, 0),
    record_count: nullableInteger(record, 'record_count', label, 0),
    document_schema_version: nullableStr(record, 'document_schema_version', label, 128),
  };
}

const D65_COLLECTION_KEYS = [
  'authorities', 'specs', 'statuses', 'receipts', 'audits', 'execution_commits', 'terminal_acceptances',
  'unit_merge_intents', 'unit_merges', 'integration_analyses', 'quarantine', 'reconciliation', 'evidence',
] as const;

const D65_QUEUE_KEYS = [
  'unit_ready', 'unit_running', 'unit_blocked', 'unit_completed', 'unit_held', 'work_audit_review', 'work_validation_ready',
] as const;

export interface D65CompleteGraph {
  readonly schema_version: typeof D65_COMPLETE_GRAPH_SCHEMA;
  readonly program_id: string;
  readonly mode: 'complete';
  readonly graph_sequence: number;
  readonly prior_graph_sha256: `sha256:${string}`;
  readonly prior_event_seq: number;
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly covered_authority_commit: string;
  readonly covered_authority_tree: string;
  readonly covered_event_seq: number;
  readonly bootstrap_charter: JsonObject;
  readonly core: Readonly<Record<(typeof D65_CORE_KEYS)[number], D65CoreEntry>>;
  readonly collections: Readonly<Record<(typeof D65_COLLECTION_KEYS)[number], D65ProjectionIndex>>;
  readonly work_items: D65ProjectionIndex;
  readonly bughunt: D65ProjectionIndex;
  readonly closure: JsonObject | null;
  readonly queue_projection: Readonly<Record<(typeof D65_QUEUE_KEYS)[number], D65ProjectionIndex>>;
  readonly exceptions: D65ProjectionIndex;
  readonly coordinator_projection: D65ProjectionIndex;
  readonly created_at: string;
}

export function parseD65CompleteGraph(value: unknown): D65CompleteGraph {
  const label = D65_COMPLETE_GRAPH_SCHEMA;
  const record = object(value, label, [
    'schema_version', 'program_id', 'mode', 'graph_sequence', 'prior_graph_sha256', 'prior_event_seq',
    'repo_id', 'autopilot_id', 'workstream', 'workstream_run', 'covered_authority_commit',
    'covered_authority_tree', 'covered_event_seq', 'bootstrap_charter', 'core', 'collections', 'work_items',
    'bughunt', 'closure', 'queue_projection', 'exceptions', 'coordinator_projection', 'created_at',
  ]);
  literal(record, 'schema_version', D65_COMPLETE_GRAPH_SCHEMA, label);
  literal(record, 'mode', 'complete', label);
  const graphSequence = integer(record, 'graph_sequence', label, 2);
  if (!isJsonObject(record['bootstrap_charter'])) fail(label, 'bootstrap_charter must be the immutable B snapshot object');
  const coreRecord = object(record['core'], `${label}.core`, D65_CORE_KEYS);
  const core = {} as Record<(typeof D65_CORE_KEYS)[number], D65CoreEntry>;
  for (const key of D65_CORE_KEYS) core[key] = coreEntry(coreRecord[key], `${label}.core.${key}`);
  const collectionsRecord = object(record['collections'], `${label}.collections`, D65_COLLECTION_KEYS);
  const collections = {} as Record<(typeof D65_COLLECTION_KEYS)[number], D65ProjectionIndex>;
  for (const key of D65_COLLECTION_KEYS) collections[key] = parseD65ProjectionIndex(collectionsRecord[key], `${label}.collections.${key}`);
  const queueRecord = object(record['queue_projection'], `${label}.queue_projection`, D65_QUEUE_KEYS);
  const queue = {} as Record<(typeof D65_QUEUE_KEYS)[number], D65ProjectionIndex>;
  for (const key of D65_QUEUE_KEYS) queue[key] = parseD65ProjectionIndex(queueRecord[key], `${label}.queue_projection.${key}`);
  const closure = record['closure'] === null ? null : (isJsonObject(record['closure']) ? record['closure'] : fail(label, 'closure must be null or the single complete closure object'));
  return {
    schema_version: D65_COMPLETE_GRAPH_SCHEMA,
    program_id: identifier(record, 'program_id', label),
    mode: 'complete',
    graph_sequence: graphSequence,
    prior_graph_sha256: sha256Field(record, 'prior_graph_sha256', label),
    prior_event_seq: integer(record, 'prior_event_seq', label, 1),
    repo_id: identifier(record, 'repo_id', label),
    autopilot_id: identifier(record, 'autopilot_id', label),
    workstream: identifier(record, 'workstream', label),
    workstream_run: identifier(record, 'workstream_run', label),
    covered_authority_commit: gitOid(record, 'covered_authority_commit', label),
    covered_authority_tree: gitOid(record, 'covered_authority_tree', label),
    covered_event_seq: integer(record, 'covered_event_seq', label, 1),
    bootstrap_charter: record['bootstrap_charter'],
    core: Object.freeze(core),
    collections: Object.freeze(collections),
    work_items: parseD65ProjectionIndex(record['work_items'], `${label}.work_items`),
    bughunt: parseD65ProjectionIndex(record['bughunt'], `${label}.bughunt`),
    closure,
    queue_projection: Object.freeze(queue),
    exceptions: parseD65ProjectionIndex(record['exceptions'], `${label}.exceptions`),
    coordinator_projection: parseD65ProjectionIndex(record['coordinator_projection'], `${label}.coordinator_projection`),
    created_at: timestamp(record, 'created_at', label),
  };
}

// ---- attach-run.bootstrap_graph request payload -----------------------------

export const D65_ATTACH_RUN_BOOTSTRAP_SCHEMA = 'autopilot.semantic_graph_bootstrap.v1' as const;

export interface D65AttachRunBootstrapGraphPayload {
  readonly schema_version: typeof D65_ATTACH_RUN_BOOTSTRAP_SCHEMA;
  readonly ref: string;
  readonly sha256: `sha256:${string}`;
  readonly byte_count: number;
  readonly git_commit: string;
  readonly covered_event_seq: 0;
  readonly prospective_run: JsonObject;
  readonly prospective_resource: JsonObject;
  readonly trust_anchor_ref: string;
  readonly trust_anchor_sha256: `sha256:${string}`;
}

/**
 * Strictly parse the current-build `attach-run.bootstrap_graph` request object.
 * `schema_version` is exactly the bootstrap schema; refs are bounded
 * repository-relative paths; `covered_event_seq` is exactly 0 (D65 requires
 * repository absence). Prospective run/resource are the exact projected rows the
 * transaction will byte-compare against.
 */
export function parseD65AttachRunBootstrapGraphPayload(value: unknown): D65AttachRunBootstrapGraphPayload {
  const label = 'attach-run.bootstrap_graph';
  const record = object(value, label, [
    'schema_version', 'ref', 'sha256', 'byte_count', 'git_commit', 'covered_event_seq',
    'prospective_run', 'prospective_resource', 'trust_anchor_ref', 'trust_anchor_sha256',
  ]);
  literal(record, 'schema_version', D65_ATTACH_RUN_BOOTSTRAP_SCHEMA, label);
  if (record['covered_event_seq'] !== 0) fail(label, 'covered_event_seq must be exactly 0 (D65 requires repository absence)');
  const byteCount = integer(record, 'byte_count', label, 1);
  if (byteCount > D65_GRAPH_ROOT_MAX_BYTES) fail(label, 'bootstrap graph byte_count exceeds the 1 MiB root bound');
  return {
    schema_version: D65_ATTACH_RUN_BOOTSTRAP_SCHEMA,
    ref: repoRelativePath(record, 'ref', label),
    sha256: sha256Field(record, 'sha256', label),
    byte_count: byteCount,
    git_commit: gitOid(record, 'git_commit', label),
    covered_event_seq: 0,
    prospective_run: boundedProspective(record['prospective_run'], `${label}.prospective_run`),
    prospective_resource: boundedProspective(record['prospective_resource'], `${label}.prospective_resource`),
    trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label),
    trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
  };
}

// ---- {ref,sha256,byte_count} evidence ref (continuation/parent-loss) ---------

export interface D65EvidenceRefWithCount {
  readonly ref: string;
  readonly sha256: `sha256:${string}`;
  readonly byte_count: number;
}

/** Parse a closed `{ref,sha256,byte_count}` evidence reference. */
export function parseD65EvidenceRefWithCount(value: unknown, label: string): D65EvidenceRefWithCount {
  const record = object(value, label, ['ref', 'sha256', 'byte_count']);
  return {
    ref: repoRelativePath(record, 'ref', label, 1024),
    sha256: sha256Field(record, 'sha256', label),
    byte_count: integer(record, 'byte_count', label, 0),
  };
}

export function parseD65NullableEvidenceRefWithCount(value: unknown, label: string): D65EvidenceRefWithCount | null {
  return value === null ? null : parseD65EvidenceRefWithCount(value, label);
}
