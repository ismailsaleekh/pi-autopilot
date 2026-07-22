import {
  parseAutopilotDecisionRow,
  parseAutopilotEventRow,
  parseAutopilotMasterPlan,
  parseAutopilotState,
  parseAutopilotStatusEntry,
  type AutopilotDecisionRow,
  type AutopilotEventRow,
  type AutopilotMasterPlan,
  type AutopilotState,
  type AutopilotStatusEntry,
} from '../contracts/index.ts';
import { canonicalJson } from './canonical-json.ts';
import { buildD65CoordinatorProjectionMembers, type D65CoordinatorProjectionSnapshot } from './d65-coordinator-projection.ts';
import {
  D65_CORE_KEYS,
  D65_GRAPH_ROOT_MAX_BYTES,
  bytesSha256,
  type D65CoreEntry,
} from './d65-semantic-graph.ts';
import {
  D65_GRAPH_AUTHORITY_REGISTRY,
  d65GitBlobOid,
  discoverD65GraphAuthority,
  type D65DiscoveredGraphAuthority,
  type D65GraphAuthorityReader,
  type D65GraphTreeLeaf,
} from './d65-graph-authority.ts';
import { normalizeD65NonCoordinatorProjections } from './d65-graph-projections.ts';
import { deriveD65QueueProjection, D65_QUEUE_KEYS } from './d65-graph-queues.ts';
import type { D65LoadedGraph } from './d65-graph-loader.ts';
import { buildD65CompleteGraph, type D65GraphBody, type D65GraphHeader, type D65ProducedGraph, type D65ProjectionInput } from './d65-graph-producer.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type { CoordinationAuthoritativeArtifact } from './types.ts';

export interface D65DiscoveredGraphCore {
  readonly descriptors: D65GraphBody['core'];
  readonly master_plan: AutopilotMasterPlan;
  readonly state: AutopilotState;
  readonly decisions: readonly AutopilotDecisionRow[];
  readonly events: readonly AutopilotEventRow[];
}

export interface D65DiscoveredGraphBody {
  readonly body: D65GraphBody;
  readonly core: D65DiscoveredGraphCore;
  readonly authority: D65DiscoveredGraphAuthority;
}

function fail(issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-state', `semantic-graph-discovery-mismatch: ${issue}`, [...detail]);
}

function decodeUtf8(bytes: Uint8Array, ref: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { fail('core authority blob is not valid UTF-8', [ref, error instanceof Error ? error.message : String(error)]); }
}

function parseJson(bytes: Uint8Array, ref: string): unknown {
  try { return JSON.parse(decodeUtf8(bytes, ref)) as unknown; }
  catch (error) { fail('core authority blob is not valid JSON', [ref, error instanceof Error ? error.message : String(error)]); }
}

function jsonl<T>(bytes: Uint8Array, ref: string, parse: (value: unknown) => T, id: (value: T) => number): readonly T[] {
  const rows: T[] = [];
  const lines = decodeUtf8(bytes, ref).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(line) as unknown; }
    catch (error) { fail('core JSONL contains malformed nonblank JSON', [ref, `line=${String(index + 1)}`, error instanceof Error ? error.message : String(error)]); }
    const parsed = parse(value);
    const expected = rows.length + 1;
    if (id(parsed) !== expected) fail('core JSONL ids are not contiguous from one', [ref, `line=${String(index + 1)}`, `expected=${String(expected)}`, `actual=${String(id(parsed))}`]);
    rows.push(parsed);
  }
  return Object.freeze(rows);
}

function coreLeaf(reader: D65GraphAuthorityReader, ref: string): { readonly leaf: D65GraphTreeLeaf; readonly bytes: Uint8Array } {
  const matches = reader.entries.filter((entry) => entry.ref === ref);
  const leaf = matches[0];
  if (matches.length !== 1 || leaf === undefined) fail('core ref does not resolve to exactly one Git tree entry', [ref, `count=${String(matches.length)}`]);
  if (leaf.mode !== '100644' || leaf.type !== 'blob') fail('core ref is not a mode-100644 regular Git blob', [ref, leaf.mode, leaf.type]);
  const bytes = reader.readBlob(ref);
  if (bytes.byteLength > D65_GRAPH_ROOT_MAX_BYTES) fail('core authority blob exceeds the 1 MiB bound', [ref, `bytes=${String(bytes.byteLength)}`]);
  if (d65GitBlobOid(bytes) !== leaf.oid) fail('core bytes do not equal the named Git blob object', [ref, leaf.oid]);
  return { leaf, bytes };
}

function descriptor(input: { readonly ref: string; readonly leaf: D65GraphTreeLeaf; readonly bytes: Uint8Array; readonly recordCount: number | null; readonly schema: string | null }): D65CoreEntry {
  return Object.freeze({ ref: input.ref, git_mode: '100644', git_blob_oid: input.leaf.oid, sha256: bytesSha256(input.bytes), byte_count: input.bytes.byteLength, record_count: input.recordCount, document_schema_version: input.schema });
}

/** Independently read and parse the five exact core blobs at authority commit G. */
export function discoverD65GraphCore(input: {
  readonly readGitAtG: D65GraphAuthorityReader;
  readonly runtimePrefix: string;
  readonly workstream: string;
}): D65DiscoveredGraphCore {
  if (input.runtimePrefix !== `.pi/autopilot/${input.workstream}`) fail('core runtime prefix does not equal the exact workstream root', [input.runtimePrefix, input.workstream]);
  const refs = {
    mission: `${input.runtimePrefix}/mission.md`,
    master_plan: `${input.runtimePrefix}/master-plan.json`,
    state: `${input.runtimePrefix}/state.json`,
    decision_log: `${input.runtimePrefix}/decision-log.jsonl`,
    events: `${input.runtimePrefix}/events.jsonl`,
  } as const;
  const mission = coreLeaf(input.readGitAtG, refs.mission);
  const master = coreLeaf(input.readGitAtG, refs.master_plan);
  const stateBlob = coreLeaf(input.readGitAtG, refs.state);
  const decisionsBlob = coreLeaf(input.readGitAtG, refs.decision_log);
  const eventsBlob = coreLeaf(input.readGitAtG, refs.events);
  const masterPlan = parseAutopilotMasterPlan(parseJson(master.bytes, refs.master_plan));
  const state = parseAutopilotState(parseJson(stateBlob.bytes, refs.state));
  const decisions = jsonl(decisionsBlob.bytes, refs.decision_log, parseAutopilotDecisionRow, (entry) => entry.id);
  const events = jsonl(eventsBlob.bytes, refs.events, parseAutopilotEventRow, (entry) => entry.id);
  if (masterPlan.workstream !== input.workstream || state.workstream !== input.workstream) fail('core master-plan/state workstream differs from graph workstream');
  if (masterPlan.mission_ref !== 'mission.md') fail('master-plan mission_ref is not the exact core mission ref', [masterPlan.mission_ref]);
  const latestDecision = decisions[decisions.length - 1]?.id ?? 0;
  const latestEvent = events[events.length - 1]?.id ?? 0;
  if (masterPlan.last_decision_id !== latestDecision) fail('master-plan last_decision_id differs from the exact decision ledger tail', [String(masterPlan.last_decision_id), String(latestDecision)]);
  if (masterPlan.last_event_id !== latestEvent || state.last_event_id !== latestEvent) fail('master-plan/state last_event_id differs from the exact event ledger tail', [String(masterPlan.last_event_id), String(state.last_event_id), String(latestEvent)]);
  const descriptors = Object.freeze({
    mission: descriptor({ ref: refs.mission, ...mission, recordCount: null, schema: null }),
    master_plan: descriptor({ ref: refs.master_plan, ...master, recordCount: 1, schema: 'autopilot.master_plan.v1' }),
    state: descriptor({ ref: refs.state, ...stateBlob, recordCount: 1, schema: 'autopilot.state.v1' }),
    decision_log: descriptor({ ref: refs.decision_log, ...decisionsBlob, recordCount: decisions.length, schema: 'autopilot.decision.v1' }),
    events: descriptor({ ref: refs.events, ...eventsBlob, recordCount: events.length, schema: 'autopilot.event.v1' }),
  });
  for (const key of D65_CORE_KEYS) if (descriptors[key] === undefined) fail('core descriptor set is incomplete', [key]);
  return Object.freeze({ descriptors, master_plan: masterPlan, state, decisions, events });
}

function queueMembers(state: AutopilotState): D65GraphBody['queues'] {
  const derived = deriveD65QueueProjection(state);
  const queues = Object.create(null) as Record<(typeof D65_QUEUE_KEYS)[number], readonly D65ProjectionInput[]>;
  for (const key of D65_QUEUE_KEYS) queues[key] = Object.freeze(derived[key].map((identity) => Object.freeze({ identity, kind: key, value: Object.freeze({ identity }) })));
  return Object.freeze(queues);
}

/** Build exact body inputs solely from G plus the independently exported store projection at E. */
/** Compare a loaded graph body to independently rediscovered G/store authority. */
export function assertD65DiscoveredGraphBodyEqual(loaded: D65LoadedGraph, expected: D65GraphBody): void {
  if (canonicalJson(loaded.graph.core) !== canonicalJson(expected.core)) fail('loaded core descriptors do not equal independent G discovery');
  for (const [collection, expectedEntries] of Object.entries(expected.collections)) {
    const actual = loaded.authorities[collection];
    if (actual === undefined || canonicalJson(actual.entries) !== canonicalJson(expectedEntries)) fail('loaded authority collection does not equal independent G discovery', [collection]);
  }
  for (const [kind, expectedMembers] of Object.entries(expected.projections)) {
    const actual = loaded.projections[kind];
    if (actual === undefined || canonicalJson(actual.members) !== canonicalJson(expectedMembers)) fail('loaded non-coordinator projection does not equal independent normalization', [kind]);
  }
  for (const [kind, expectedMembers] of Object.entries(expected.queues)) {
    const actual = loaded.projections[kind];
    if (actual === undefined || canonicalJson(actual.members) !== canonicalJson(expectedMembers)) fail('loaded queue projection does not equal independent state derivation', [kind]);
  }
  if (canonicalJson(loaded.graph.closure) !== canonicalJson(expected.closure)) fail('loaded closure projection does not equal independent state normalization');
}

export function produceD65CompleteGraphFromAuthority(input: {
  readonly header: D65GraphHeader;
  readonly readGitAtG: D65GraphAuthorityReader;
  readonly acceptedArtifacts: readonly CoordinationAuthoritativeArtifact[];
  readonly coordinatorProjection: D65CoordinatorProjectionSnapshot;
}): D65ProducedGraph {
  const discovered = discoverD65GraphBody({
    readGitAtG: input.readGitAtG,
    acceptedArtifacts: input.acceptedArtifacts,
    coordinatorProjection: input.coordinatorProjection,
    repoId: input.header.repo_id,
    workstreamRun: input.header.workstream_run,
    workstream: input.header.workstream,
    runtimePrefix: `.pi/autopilot/${input.header.workstream}`,
  });
  return buildD65CompleteGraph(input.header, discovered.body);
}

export function discoverD65GraphBody(input: {
  readonly readGitAtG: D65GraphAuthorityReader;
  readonly acceptedArtifacts: readonly CoordinationAuthoritativeArtifact[];
  readonly coordinatorProjection: D65CoordinatorProjectionSnapshot;
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly workstream: string;
  readonly runtimePrefix: string;
}): D65DiscoveredGraphBody {
  const core = discoverD65GraphCore(input);
  const authority = discoverD65GraphAuthority({
    ...input,
    registry: D65_GRAPH_AUTHORITY_REGISTRY,
    mainWorktreePath: input.coordinatorProjection.resource.main_worktree_path,
    coreSeeds: { state: core.state, master_plan: core.master_plan },
  });
  const statuses: { runtime_ref: string; status: AutopilotStatusEntry }[] = [];
  const prefix = `${input.runtimePrefix}/`;
  for (const entry of authority.collections.statuses) {
    const parsed = authority.parsed_by_ref.get(entry.ref);
    if (parsed === undefined) fail('discovered status entry lacks its independently parsed value', [entry.ref]);
    if (!entry.ref.startsWith(prefix)) fail('fixed-root status is outside the exact runtime prefix', [entry.ref]);
    statuses.push({ runtime_ref: entry.ref.slice(prefix.length), status: parseAutopilotStatusEntry(parsed) });
  }
  const normalized = normalizeD65NonCoordinatorProjections(core.master_plan, core.state, statuses);
  const coordinatorMembers: readonly D65ProjectionInput[] = buildD65CoordinatorProjectionMembers(input.coordinatorProjection).map((member) => Object.freeze({ identity: member.identity, kind: member.kind, value: member.value }));
  const body: D65GraphBody = Object.freeze({
    core: core.descriptors,
    collections: authority.collections,
    projections: Object.freeze({ work_items: normalized.work_items, bughunt: normalized.bughunt, exceptions: normalized.exceptions, coordinator_projection: coordinatorMembers }),
    queues: queueMembers(core.state),
    closure: normalized.closure,
  });
  return Object.freeze({ body, core, authority });
}
