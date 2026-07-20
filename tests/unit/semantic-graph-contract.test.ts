import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  D65_ALLOWED_BOOTSTRAP_OPERATIONS,
  D65_ATTACH_RUN_RESULT_V2_SCHEMA,
  D65_TERMINAL_INTENT_V2_SCHEMA,
  TERMINAL_INTENT_CANCELLATION_MAX,
  canonicalSha256,
  parseD65AttachRunResultV2,
  parseD65AuthorityShard,
  parseD65BootstrapGraphRef,
  parseD65CompleteGraph,
  parseD65GraphPublication,
  parseD65ProjectionIndex,
  parseD65ProjectionShard,
  parseD65RunTerminalIntentV2,
  parseD65SemanticGraphBootstrap,
} from '../../src/core/coordination/d65-semantic-graph.ts';
import {
  D65_ED25519_SPKI_BYTE_COUNT,
  decodeUnpaddedBase64Url,
  encodeUnpaddedBase64Url,
  parseD65TrustAnchorSpki,
  verifyD65Signature,
} from '../../src/core/coordination/d65-trust.ts';
import {
  D65_BINARY_TRUST_ANCHOR_SCHEMA,
  D65_CONTRACT_MANIFEST,
  D65_CONTRACT_SCHEMA_VERSIONS,
  d65ParserFor,
} from '../../src/core/coordination/d65-contract-manifest.ts';
import {
  d65GraphPathPrefix,
  d65SemanticGraphArtifactId,
  validateD65GraphPublication,
} from '../../src/core/coordination/d65-graph-publication.ts';
import { bytesSha256 } from '../../src/core/coordination/d65-semantic-graph.ts';
import {
  assertD65QueueProjectionCounts,
  assertD65QueueProjectionMembers,
  assertD65UnitTransition,
  assertD65WorkItemTransition,
  deriveD65QueueProjection,
  isD65LegalUnitEdge,
  isD65LegalWorkItemEdge,
} from '../../src/core/coordination/d65-graph-queues.ts';
import type { AutopilotState } from '../../src/core/contracts/types.ts';
import {
  parseD65ContinuationEvent,
  parseD65ParentLoss,
} from '../../src/core/coordination/d65-continuation.ts';
import { validateAuthoritativeCoordinationDocument } from '../../src/core/coordination/escalation.ts';
import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import {
  assertD65QueueMemberValues,
  d65ProjectionIdentities,
  loadD65CompleteGraph,
  type D65GraphBlobReader,
} from '../../src/core/coordination/d65-graph-loader.ts';
// The compiled dist manifest must expose the identical closed set (source/dist
// parity, freeze §9.5). Importing the built .js proves it byte-for-contract.
// @ts-expect-error - dist is emitted JavaScript without a .d.ts sidecar.
import { D65_CONTRACT_SCHEMA_VERSIONS as DIST_D65_CONTRACT_SCHEMA_VERSIONS } from '../../dist/src/core/coordination/d65-contract-manifest.js';

const OID = (char: string): string => char.repeat(40);
const DIGEST = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}` as const;
const EMPTY_INDEX = { entry_count: 0, total_bytes: 0, sha256: canonicalSha256([]), shards: [] };

function bootstrapFixture(): Record<string, unknown> {
  return {
    schema_version: 'autopilot.semantic_graph_bootstrap.v1',
    program_id: 'program-1', graph_sequence: 1, prior_graph_sha256: null,
    repo_id: 'repo-1', autopilot_id: 'auto-1', workstream: 'kbg-finalize-fresh', workstream_run: 'run-1',
    run_timestamp: '2026-07-19T00:00:00.000Z', run_nonce: 'a1b2c3',
    content_commit: OID('a'), content_tree: OID('b'), package_commit: OID('c'), package_tree: OID('d'),
    prospective_run: { schema_version: 'autopilot.coordination_run.v1', workstream_run: 'run-1' },
    prospective_resource: { schema_version: 'autopilot.coordination_run_resource.v1', target_base_sha: OID('a') },
    covered_event_seq: 0,
    trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki',
    trust_anchor_sha256: DIGEST('e'),
    allowed_bootstrap_operations: [...D65_ALLOWED_BOOTSTRAP_OPERATIONS],
    created_at: '2026-07-19T00:00:01.000Z',
  };
}

void describe('D65 semantic-graph bootstrap contract', () => {
  void it('parses a valid bootstrap envelope and freezes the exact ordered operations', () => {
    const parsed = parseD65SemanticGraphBootstrap(bootstrapFixture());
    assert.equal(parsed.graph_sequence, 1);
    assert.equal(parsed.covered_event_seq, 0);
    assert.deepEqual([...parsed.allowed_bootstrap_operations], [...D65_ALLOWED_BOOTSTRAP_OPERATIONS]);
    assert.equal(parsed.run_nonce, 'a1b2c3');
  });

  void it('rejects unknown fields, wrong sequence, non-null prior digest, and malformed operations', () => {
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), extra: 1 }), /unknown fields/u);
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), graph_sequence: 2 }), /graph_sequence must be exactly 1/u);
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), prior_graph_sha256: DIGEST('f') }), /prior_graph_sha256 must be null/u);
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), covered_event_seq: 1 }), /covered_event_seq must be exactly 0/u);
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), run_nonce: 'ABCDEF' }), /run_nonce must be exactly six lowercase hex/u);
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), run_nonce: 'a1b2c' }), /run_nonce/u);
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), content_commit: 'a'.repeat(39) }), /content_commit must be a full 40-lowercase-hex/u);
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), allowed_bootstrap_operations: [...D65_ALLOWED_BOOTSTRAP_OPERATIONS].reverse() }), /exact ordered frozen array/u);
    const missingOp = [...D65_ALLOWED_BOOTSTRAP_OPERATIONS].slice(0, 7);
    assert.throws(() => parseD65SemanticGraphBootstrap({ ...bootstrapFixture(), allowed_bootstrap_operations: missingOp }), /exact ordered frozen array/u);
  });
});

void describe('D65 run terminal intent v2 contract', () => {
  function intentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: D65_TERMINAL_INTENT_V2_SCHEMA, terminal_intent_id: 'terminal-intent:run-1:00000000000000000001',
      repo_id: 'repo-1', workstream_run: 'run-1', intent_attempt: 1, prior_terminal_intent_id: null, prior_terminal_intent_sha256: null,
      outcome: 'closed', state: 'prepared', reservation_ids: ['reservation-a', 'reservation-b'],
      terminal_effect_sets: { blocking_owned_obligations: [], foreign_dependent_obligations: [], abort_owned_obligations: [], other_nonterminal_obligations: [] },
      prepared_event_seq: 10, terminal_event_seq: null, version: 1, ...overrides,
    };
  }

  void it('parses the first prepared closed intent', () => {
    const parsed = parseD65RunTerminalIntentV2(intentFixture());
    assert.equal(parsed.intent_attempt, 1);
    assert.equal(parsed.prior_terminal_intent_id, null);
    assert.equal(parsed.state, 'prepared');
  });

  void it('enforces the three-cancel bound and mandatory fourth noncancellable abort', () => {
    // Attempt 4 must be abort.
    assert.throws(() => parseD65RunTerminalIntentV2(intentFixture({ intent_attempt: TERMINAL_INTENT_CANCELLATION_MAX + 1, outcome: 'closed', prior_terminal_intent_id: 'terminal-intent:run-1:00000000000000000003', prior_terminal_intent_sha256: DIGEST('a') })), /mandatory fourth attempt must be a noncancellable abort/u);
    // Attempt 5 rejects.
    assert.throws(() => parseD65RunTerminalIntentV2(intentFixture({ intent_attempt: 5, outcome: 'aborted', prior_terminal_intent_id: 'x', prior_terminal_intent_sha256: DIGEST('a') })), /intent_attempt must be <= 4/u);
    // Attempt 4 abort parses.
    const abort4 = parseD65RunTerminalIntentV2(intentFixture({ intent_attempt: 4, outcome: 'aborted', prior_terminal_intent_id: 'terminal-intent:run-1:00000000000000000003', prior_terminal_intent_sha256: DIGEST('a') }));
    assert.equal(abort4.outcome, 'aborted');
  });

  void it('binds the prior chain and terminal event sequence to state', () => {
    assert.throws(() => parseD65RunTerminalIntentV2(intentFixture({ intent_attempt: 2 })), /must name the exact prior intent id and digest/u);
    assert.throws(() => parseD65RunTerminalIntentV2(intentFixture({ prior_terminal_intent_id: 'x', prior_terminal_intent_sha256: DIGEST('a') })), /attempt 1 must carry null prior chain fields/u);
    assert.throws(() => parseD65RunTerminalIntentV2(intentFixture({ state: 'committed', terminal_event_seq: null })), /committed\/cancelled intent requires a terminal_event_seq/u);
    assert.throws(() => parseD65RunTerminalIntentV2(intentFixture({ state: 'prepared', terminal_event_seq: 11 })), /prepared intent has no terminal_event_seq/u);
  });

  void it('rejects duplicate obligation identities and unsorted rows', () => {
    const dupSets = { blocking_owned_obligations: [], foreign_dependent_obligations: [
      { schema_version: 'autopilot.reservation_obligation.v1', obligation_id: 'ob-2' },
      { schema_version: 'autopilot.reservation_obligation.v1', obligation_id: 'ob-1' },
    ], abort_owned_obligations: [], other_nonterminal_obligations: [] };
    assert.throws(() => parseD65RunTerminalIntentV2(intentFixture({ terminal_effect_sets: dupSets })), /sorted by obligation_id decoded bytes/u);
  });
});

void describe('D65 graph publication saga residue contract', () => {
  function publicationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 'autopilot.graph_publication.v1', publication_id: 'pub-1', program_id: 'program-1',
      repo_id: 'repo-1', autopilot_id: 'auto-1', workstream_run: 'run-1', graph_sequence: 2, artifact_id: 'semantic-graph:00000000000000000002',
      stage: 'prepared', prior_authority_kind: 'bootstrap', prior_graph_sha256: DIGEST('a'), prior_publication_commit: null,
      prior_registration_event_seq: 1, authority_base_commit: OID('b'), authority_path_count: 5, authority_path_manifest_sha256: DIGEST('c'),
      authority_commit: null, authority_tree: null, covered_event_seq: 3, publication_commit: null, publication_tree: null,
      graph_ref: null, graph_sha256: null, graph_byte_count: null, registration_event_seq: null,
      created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z', ...overrides,
    };
  }

  void it('parses each monotonic stage with the correct null discipline', () => {
    assert.equal(parseD65GraphPublication(publicationFixture()).stage, 'prepared');
    const registered = parseD65GraphPublication(publicationFixture({
      stage: 'registered', authority_commit: OID('d'), authority_tree: OID('e'),
      publication_commit: OID('f'), publication_tree: OID('0'), graph_ref: 'semantic-graphs/00000000000000000002/graph.json',
      graph_sha256: DIGEST('1'), graph_byte_count: 4096, registration_event_seq: 4,
    }));
    assert.equal(registered.stage, 'registered');
    assert.equal(registered.registration_event_seq, 4);
  });

  void it('rejects stage/field presence mismatches and bootstrap prior-publication commits', () => {
    assert.throws(() => parseD65GraphPublication(publicationFixture({ prior_authority_kind: 'bootstrap', prior_publication_commit: OID('9') })), /bootstrap prior authority must have null prior_publication_commit/u);
    assert.throws(() => parseD65GraphPublication(publicationFixture({ prior_authority_kind: 'complete', prior_publication_commit: null })), /complete prior authority requires prior_publication_commit/u);
    assert.throws(() => parseD65GraphPublication(publicationFixture({ stage: 'authority-committed' })), /authority commit\/tree presence must match stage/u);
    assert.throws(() => parseD65GraphPublication(publicationFixture({ registration_event_seq: 4 })), /registration_event_seq presence must match/u);
  });
});

void describe('D65 authority and projection shard contracts', () => {
  void it('parses an authority shard and checks byte-sum, sort, and range', () => {
    const shard = parseD65AuthorityShard({
      schema_version: 'autopilot.semantic_graph_authority_shard.v1', program_id: 'program-1', repo_id: 'repo-1', workstream_run: 'run-1',
      graph_sequence: 2, collection: 'specs', entry_count: 2, total_bytes: 30, first_identity: 'spec-a', last_identity: 'spec-b',
      entries: [
        { identity: 'spec-a', ref: 'unit-specs/a.json', git_mode: '100644', git_blob_oid: OID('a'), sha256: DIGEST('a'), byte_count: 10, document_schema_version: 'autopilot.unit_spec.v1' },
        { identity: 'spec-b', ref: 'unit-specs/b.json', git_mode: '100644', git_blob_oid: OID('b'), sha256: DIGEST('b'), byte_count: 20, document_schema_version: 'autopilot.unit_spec.v1' },
      ],
    });
    assert.equal(shard.entry_count, 2);
    assert.equal(shard.total_bytes, 30);
  });

  void it('rejects an authority shard with a wrong byte sum or unsorted entries', () => {
    const base = {
      schema_version: 'autopilot.semantic_graph_authority_shard.v1', program_id: 'program-1', repo_id: 'repo-1', workstream_run: 'run-1',
      graph_sequence: 2, collection: 'specs', entry_count: 2, total_bytes: 30, first_identity: 'spec-a', last_identity: 'spec-b',
      entries: [
        { identity: 'spec-b', ref: 'unit-specs/b.json', git_mode: '100644', git_blob_oid: OID('b'), sha256: DIGEST('b'), byte_count: 20, document_schema_version: null },
        { identity: 'spec-a', ref: 'unit-specs/a.json', git_mode: '100644', git_blob_oid: OID('a'), sha256: DIGEST('a'), byte_count: 10, document_schema_version: null },
      ],
    };
    assert.throws(() => parseD65AuthorityShard(base), /sorted by decoded identity bytes/u);
    assert.throws(() => parseD65AuthorityShard({ ...base, total_bytes: 99, entries: [base.entries[1], base.entries[0]] }), /total_bytes must equal/u);
  });

  void it('parses a projection shard and verifies value_sha256 recomputation', () => {
    const value = { identity: 'unit-a' };
    const shard = parseD65ProjectionShard({
      schema_version: 'autopilot.semantic_graph_projection_shard.v1', program_id: 'program-1', repo_id: 'repo-1', workstream_run: 'run-1',
      graph_sequence: 2, projection_kind: 'unit_ready', entry_count: 1, total_bytes: 20, first_identity: 'unit-a', last_identity: 'unit-a',
      entries: [{ identity: 'unit-a', kind: 'queue-member', value_sha256: canonicalSha256(value), value }],
    });
    assert.equal(shard.entries.length, 1);
    assert.throws(() => parseD65ProjectionShard({
      schema_version: 'autopilot.semantic_graph_projection_shard.v1', program_id: 'program-1', repo_id: 'repo-1', workstream_run: 'run-1',
      graph_sequence: 2, projection_kind: 'unit_ready', entry_count: 1, total_bytes: 20, first_identity: 'unit-a', last_identity: 'unit-a',
      entries: [{ identity: 'unit-a', kind: 'queue-member', value_sha256: DIGEST('9'), value }],
    }), /value_sha256 must equal SHA-256 of the RFC-8785 value bytes plus LF/u);
  });
});

void describe('D65 projection index contract', () => {
  void it('accepts an empty index only with the canonical [] digest', () => {
    const parsed = parseD65ProjectionIndex(EMPTY_INDEX, 'idx');
    assert.equal(parsed.entry_count, 0);
    assert.throws(() => parseD65ProjectionIndex({ ...EMPTY_INDEX, sha256: DIGEST('a') }, 'idx'), /empty index digest must be SHA-256 of canonical \[\] plus LF/u);
    assert.throws(() => parseD65ProjectionIndex({ entry_count: 0, total_bytes: 5, sha256: canonicalSha256([]), shards: [] }, 'idx'), /empty index must have zero bytes/u);
  });

  void it('checks descriptor range contiguity and aggregate entry sums', () => {
    const shards = [
      { ref: 'semantic-graphs/00000000000000000002/authorities/0.json', sha256: DIGEST('a'), byte_count: 100, entry_count: 2, first_identity: 'a', last_identity: 'b' },
      { ref: 'semantic-graphs/00000000000000000002/authorities/1.json', sha256: DIGEST('b'), byte_count: 100, entry_count: 1, first_identity: 'c', last_identity: 'c' },
    ];
    const parsed = parseD65ProjectionIndex({ entry_count: 3, total_bytes: 200, sha256: DIGEST('c'), shards }, 'idx');
    assert.equal(parsed.entry_count, 3);
    // overlap rejects
    const overlap = [shards[0], { ...shards[1], first_identity: 'b' }];
    assert.throws(() => parseD65ProjectionIndex({ entry_count: 3, total_bytes: 200, sha256: DIGEST('c'), shards: overlap }, 'idx'), /no gap or overlap/u);
    // wrong sum rejects
    assert.throws(() => parseD65ProjectionIndex({ entry_count: 9, total_bytes: 200, sha256: DIGEST('c'), shards }, 'idx'), /aggregate entry_count must equal/u);
  });
});

void describe('D65 attach_run_result.v2 contract', () => {
  void it('parses the closed v2 attach result and its bootstrap-graph/trust anchor', () => {
    const result = parseD65AttachRunResultV2({
      schema_version: D65_ATTACH_RUN_RESULT_V2_SCHEMA,
      repository: { schema_version: 'autopilot.coordination_repository.v1', repo_id: 'repo-1', version: 1 },
      run: { schema_version: 'autopilot.coordination_run.v1', workstream_run: 'run-1', version: 1 },
      run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', version: 1 },
      mailbox_cursor: { schema_version: 'autopilot.mailbox_cursor.v1', version: 1 },
      bootstrap_graph: { ref: '.pi/autopilot-bootstrap/run-1/bootstrap.json', sha256: DIGEST('a'), byte_count: 2048, git_commit: OID('a'), covered_event_seq: 0 },
      bootstrap_artifact: { schema_version: 'autopilot.authoritative_artifact.v1', artifact_id: 'semantic-graph-bootstrap:run-1' },
      trust_anchor: { trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki', trust_anchor_sha256: DIGEST('b'), git_commit: OID('a'), git_mode: '100644', git_type: 'blob', git_blob_oid: OID('c'), byte_count: 44 },
    });
    assert.equal(result.bootstrap_graph.covered_event_seq, 0);
    assert.equal(result.trust_anchor.byte_count, 44);
  });

  void it('rejects a non-zero covered event seq and a non-44-byte trust anchor', () => {
    assert.throws(() => parseD65BootstrapGraphRef({ ref: '.pi/autopilot-bootstrap/run-1/bootstrap.json', sha256: DIGEST('a'), byte_count: 2048, git_commit: OID('a'), covered_event_seq: 1 }, 'g'), /covered_event_seq must be exactly 0/u);
  });
});

void describe('D65 complete graph root contract', () => {
  function coreEntry(schema: string | null, records: number | null): Record<string, unknown> {
    return { ref: 'runtime/mission.md', git_mode: '100644', git_blob_oid: OID('a'), sha256: DIGEST('a'), byte_count: 100, record_count: records, document_schema_version: schema };
  }
  function completeFixture(): Record<string, unknown> {
    const collections: Record<string, unknown> = {};
    for (const key of ['authorities', 'specs', 'statuses', 'receipts', 'audits', 'execution_commits', 'terminal_acceptances', 'unit_merge_intents', 'unit_merges', 'integration_analyses', 'quarantine', 'reconciliation', 'evidence']) collections[key] = { ...EMPTY_INDEX };
    const queue: Record<string, unknown> = {};
    for (const key of ['unit_ready', 'unit_running', 'unit_blocked', 'unit_completed', 'unit_held', 'work_audit_review', 'work_validation_ready']) queue[key] = { ...EMPTY_INDEX };
    return {
      schema_version: 'autopilot.semantic_graph.v1', program_id: 'program-1', mode: 'complete', graph_sequence: 2,
      prior_graph_sha256: DIGEST('a'), prior_event_seq: 1, repo_id: 'repo-1', autopilot_id: 'auto-1', workstream: 'kbg-finalize-fresh', workstream_run: 'run-1',
      covered_authority_commit: OID('b'), covered_authority_tree: OID('c'), covered_event_seq: 5,
      bootstrap_charter: { repository: {}, run: {}, run_resource: {}, mailbox_cursor: {}, bootstrap_graph: {}, bootstrap_artifact: {}, trust_anchor: {}, attach_event: {}, attach_result: {} },
      core: { mission: coreEntry(null, null), master_plan: coreEntry('autopilot.master_plan.v1', 1), state: coreEntry('autopilot.state.v1', 1), decision_log: coreEntry('autopilot.decision.v1', 3), events: coreEntry('autopilot.event.v1', 4) },
      collections, work_items: { ...EMPTY_INDEX }, bughunt: { ...EMPTY_INDEX }, closure: null, queue_projection: queue,
      exceptions: { ...EMPTY_INDEX }, coordinator_projection: { ...EMPTY_INDEX }, created_at: '2026-07-19T00:00:00.000Z',
    };
  }

  void it('parses the first complete graph root with all indexes empty', () => {
    const parsed = parseD65CompleteGraph(completeFixture());
    assert.equal(parsed.graph_sequence, 2);
    assert.equal(parsed.closure, null);
    assert.equal(parsed.core.mission.record_count, null);
  });

  void it('rejects sequence below 2, wrong mode, and unknown fields', () => {
    assert.throws(() => parseD65CompleteGraph({ ...completeFixture(), graph_sequence: 1 }), /graph_sequence must be a safe integer >= 2/u);
    assert.throws(() => parseD65CompleteGraph({ ...completeFixture(), mode: 'bootstrap-plan-only' }), /mode must equal complete/u);
    assert.throws(() => parseD65CompleteGraph({ ...completeFixture(), extra: true }), /unknown fields/u);
  });
});

function completeGraphBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  const collections: Record<string, unknown> = {};
  for (const key of ['authorities', 'specs', 'statuses', 'receipts', 'audits', 'execution_commits', 'terminal_acceptances', 'unit_merge_intents', 'unit_merges', 'integration_analyses', 'quarantine', 'reconciliation', 'evidence']) collections[key] = { ...EMPTY_INDEX };
  const queue: Record<string, unknown> = {};
  for (const key of ['unit_ready', 'unit_running', 'unit_blocked', 'unit_completed', 'unit_held', 'work_audit_review', 'work_validation_ready']) queue[key] = { ...EMPTY_INDEX };
  const graph = {
    schema_version: 'autopilot.semantic_graph.v1', program_id: 'program-1', mode: 'complete', graph_sequence: 2,
    prior_graph_sha256: DIGEST('a'), prior_event_seq: 1, repo_id: 'repo-1', autopilot_id: 'auto-1', workstream: 'kbg-finalize-fresh', workstream_run: 'run-1',
    covered_authority_commit: OID('b'), covered_authority_tree: OID('c'), covered_event_seq: 5,
    bootstrap_charter: { repository: {}, run: {}, run_resource: {}, mailbox_cursor: {}, bootstrap_graph: {}, bootstrap_artifact: {}, trust_anchor: {}, attach_event: {}, attach_result: {} },
    core: {
      mission: { ref: 'runtime/mission.md', git_mode: '100644', git_blob_oid: OID('a'), sha256: DIGEST('a'), byte_count: 100, record_count: null, document_schema_version: null },
      master_plan: { ref: 'runtime/master-plan.json', git_mode: '100644', git_blob_oid: OID('a'), sha256: DIGEST('a'), byte_count: 100, record_count: 1, document_schema_version: 'autopilot.master_plan.v1' },
      state: { ref: 'runtime/state.json', git_mode: '100644', git_blob_oid: OID('a'), sha256: DIGEST('a'), byte_count: 100, record_count: 1, document_schema_version: 'autopilot.state.v1' },
      decision_log: { ref: 'runtime/decisions.jsonl', git_mode: '100644', git_blob_oid: OID('a'), sha256: DIGEST('a'), byte_count: 100, record_count: 3, document_schema_version: 'autopilot.decision.v1' },
      events: { ref: 'runtime/events.jsonl', git_mode: '100644', git_blob_oid: OID('a'), sha256: DIGEST('a'), byte_count: 100, record_count: 4, document_schema_version: 'autopilot.event.v1' },
    },
    collections, work_items: { ...EMPTY_INDEX }, bughunt: { ...EMPTY_INDEX }, closure: null, queue_projection: queue,
    exceptions: { ...EMPTY_INDEX }, coordinator_projection: { ...EMPTY_INDEX }, created_at: '2026-07-19T00:00:00.000Z', ...overrides,
  };
  return new TextEncoder().encode(JSON.stringify(graph));
}

void describe('D65 non-self-referential graph publication validation', () => {
  const H = OID('7');
  const G = OID('b');
  const graphRef = `${d65GraphPathPrefix(2)}graph.json`;

  void it('accepts a graph-only publication with sole parent G and correct self-exclusion', () => {
    const bytes = completeGraphBytes();
    const facts = validateD65GraphPublication({
      observation: { publicationCommit: H, publicationParents: [H, G], diffPaths: [graphRef, `${d65GraphPathPrefix(2)}authorities/0.json`], graphRootBytes: bytes, sealedGraphSha256: bytesSha256(bytes), graphRef },
      expectedAuthorityCommit: G, expectedCoveredEventSeq: 5,
    });
    assert.equal(facts.artifactId, d65SemanticGraphArtifactId(2));
    assert.equal(facts.authorityCommit, G);
  });

  void it('rejects a wrong sealed digest, multi-parent H, and a non-graph diff path', () => {
    const bytes = completeGraphBytes();
    const good = { publicationCommit: H, publicationParents: [H, G], diffPaths: [graphRef], graphRootBytes: bytes, sealedGraphSha256: bytesSha256(bytes), graphRef };
    assert.throws(() => validateD65GraphPublication({ observation: { ...good, sealedGraphSha256: DIGEST('9') }, expectedAuthorityCommit: G, expectedCoveredEventSeq: 5 }), /graph root blob does not match the sealed graph_sha256/u);
    assert.throws(() => validateD65GraphPublication({ observation: { ...good, publicationParents: [H, G, OID('4')] }, expectedAuthorityCommit: G, expectedCoveredEventSeq: 5 }), /must have exactly one parent/u);
    assert.throws(() => validateD65GraphPublication({ observation: { ...good, diffPaths: [graphRef, 'src/product.ts'] }, expectedAuthorityCommit: G, expectedCoveredEventSeq: 5 }), /changes a non-graph path/u);
  });

  void it('rejects a parent that is not the covered authority commit G and a covered-seq mismatch', () => {
    // The graph names G in covered_authority_commit but H's actual sole parent
    // is a different commit -> sole-parent-G violation.
    const bytes = completeGraphBytes();
    assert.throws(() => validateD65GraphPublication({ observation: { publicationCommit: H, publicationParents: [H, OID('5')], diffPaths: [graphRef], graphRootBytes: bytes, sealedGraphSha256: bytesSha256(bytes), graphRef }, expectedAuthorityCommit: G, expectedCoveredEventSeq: 5 }), /sole parent is not the covered authority commit G/u);
    const bytes2 = completeGraphBytes();
    assert.throws(() => validateD65GraphPublication({ observation: { publicationCommit: H, publicationParents: [H, G], diffPaths: [graphRef], graphRootBytes: bytes2, sealedGraphSha256: bytesSha256(bytes2), graphRef }, expectedAuthorityCommit: G, expectedCoveredEventSeq: 9 }), /covered_event_seq disagrees/u);
  });
});

function stateFixture(units: Record<string, string>, workItems: Record<string, string> = {}): AutopilotState {
  return {
    schema_version: 'autopilot.state.v1', workstream: 'w', updated_at: '2026-07-19T00:00:00.000Z', status: 'running',
    context_gate: { gate: 'ok', percent: 10 }, last_event_id: 1, ready_queue: [], running: [], blocked: [], completed: [],
    units: Object.fromEntries(Object.entries(units).map(([id, state]) => [id, { unit_id: id, role: 'implement', state: state as never, attempt: 1, summary: 's' }])),
    operator_questions: [], next_actions: ['x'],
    ...(Object.keys(workItems).length === 0 ? {} : { work_items: Object.fromEntries(Object.entries(workItems).map(([id, state]) => [id, { work_item_id: id, state: state as never, source_changing: true, unit_ids: [], summary: 's' }])) }),
  } as AutopilotState;
}

void describe('D65 continuation event contract', () => {
  const REF = (c: string): { ref: string; sha256: `sha256:${string}`; byte_count: number } => ({ ref: `authority/continuation/${c}.json`, sha256: DIGEST(c), byte_count: 128 });
  function continuationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 'autopilot.continuation_event.v1', program_id: 'program-1', event_id: 'event-1', event_sequence: 1,
      repo_id: 'repo-1', workstream_run: 'run-1', trigger: 'subscription-failure', class: 'provider-capacity-blocked',
      provider: 'openai-codex', failed_spec_ref: REF('a'), failed_receipt_ref: REF('b'), unit_id: 'unit-1', attempt: 1,
      session_lease_id: null, child_lease_id: 'child-1', observed_at: '2026-07-19T00:00:00.000Z', cooldown_until: '2026-07-19T00:15:00.000Z',
      retry_ordinal: null, successor_id: null, evidence_refs: [], prior_graph_sha256: null, result_graph_sequence: null, operator_decision_ref: null, ...overrides,
    };
  }
  void it('parses a subscription-failure continuation and binds provider/unit nullability', () => {
    const parsed = parseD65ContinuationEvent(continuationFixture());
    assert.equal(parsed.trigger, 'subscription-failure');
    assert.equal(parsed.provider, 'openai-codex');
  });
  void it('rejects provider fields on a non-subscription trigger and unit fields on a non-unit trigger', () => {
    assert.throws(() => parseD65ContinuationEvent(continuationFixture({ trigger: 'parent-loss', class: 'parent-recovering' })), /provider\/failed_spec_ref\/failed_receipt_ref are only present for subscription failures/u);
    assert.throws(() => parseD65ContinuationEvent(continuationFixture({ trigger: 'other', class: 'continuation-unclassified', provider: null, failed_spec_ref: null, failed_receipt_ref: null })), /unit\/attempt\/child fields are only present for unit failures/u);
    assert.throws(() => parseD65ContinuationEvent(continuationFixture({ trigger: 'other', class: 'coordinator-blocked', provider: null, failed_spec_ref: null, failed_receipt_ref: null, unit_id: null, attempt: null, child_lease_id: null })), /trigger `other` maps only to class `continuation-unclassified`/u);
    assert.throws(() => parseD65ContinuationEvent(continuationFixture({ operator_decision_ref: 'x' })), /operator_decision_ref must be null under D65/u);
  });
});

void describe('D65 parent loss contract', () => {
  const REF = (c: string): { ref: string; sha256: `sha256:${string}`; byte_count: number } => ({ ref: `authority/${c}.json`, sha256: DIGEST(c), byte_count: 128 });
  function parentLossFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 'autopilot.parent_loss.v1', program_id: 'program-1', event_id: 'event-1', repo_id: 'repo-1', workstream_run: 'run-1',
      lost_physical_session_file_identity: { path: '/state/session.json', device: 1, inode: 2, session_id: null },
      lost_coordinator_session_identity: { session_lease_id: 'lease-old', generation: 1 },
      successor_physical_session_file_identity: { path: '/state/session-2.json', device: 1, inode: 3, session_id: null },
      successor_session_id: 'session-2', successor_session_lease_id: 'lease-new', successor_generation: 2, successor_pid: 4321, successor_boot_id: 'boot-2',
      last_graph: REF('a'), last_policy: REF('b'), last_heartbeat: REF('c'), status_ref: REF('d'), doctor_ref: REF('e'),
      observed_at: '2026-07-19T00:00:00.000Z', successor_budget: 1, operator_decision_ref: null, issued_at: '2026-07-19T00:00:01.000Z',
      trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki', trust_anchor_sha256: DIGEST('0'), signer_key_id: DIGEST('1'), signature: 'sigSIG_-', ...overrides,
    };
  }
  void it('parses a signed parent-loss candidate with budget 1', () => {
    const parsed = parseD65ParentLoss(parentLossFixture());
    assert.equal(parsed.successor_budget, 1);
    assert.equal(parsed.successor_generation, 2);
  });
  void it('rejects a non-1 budget, non-null operator decision, and padded signature', () => {
    assert.throws(() => parseD65ParentLoss(parentLossFixture({ successor_budget: 2 })), /successor_budget must be exactly 1/u);
    assert.throws(() => parseD65ParentLoss(parentLossFixture({ operator_decision_ref: 'x' })), /operator_decision_ref must be null under D65/u);
    assert.throws(() => parseD65ParentLoss(parentLossFixture({ signature: 'sig=' })), /signature must be unpadded base64url/u);
  });

  void it('is admitted by the store authoritative-document validator as a task document', () => {
    // The actual store consumer: register-authoritative-artifact -> this gate.
    const parentLoss = parentLossFixture();
    const bytes = new TextEncoder().encode(JSON.stringify(parentLoss));
    assert.doesNotThrow(() => validateAuthoritativeCoordinationDocument('task', 'autopilot.parent_loss.v1', bytes));
    // A malformed parent-loss (budget 2) is rejected as not schema-valid.
    const badBytes = new TextEncoder().encode(JSON.stringify(parentLossFixture({ successor_budget: 2 })));
    assert.throws(() => validateAuthoritativeCoordinationDocument('task', 'autopilot.parent_loss.v1', badBytes), /not schema-valid/u);
  });
});

void describe('D65 complete-graph queue equations and transitions', () => {
  void it('derives the seven queue indexes from state and partitions the unit set', () => {
    const state = stateFixture({ a: 'ready', b: 'running', c: 'blocked', d: 'failed', e: 'completed', f: 'queued' }, { w1: 'audit-review', w2: 'validation-ready', w3: 'revalidation-ready', w4: 'planned' });
    const queues = deriveD65QueueProjection(state);
    assert.deepEqual([...queues.unit_ready], ['a']);
    assert.deepEqual([...queues.unit_running], ['b']);
    assert.deepEqual([...queues.unit_blocked], ['c', 'd']);
    assert.deepEqual([...queues.unit_completed], ['e']);
    assert.deepEqual([...queues.unit_held], ['f']);
    assert.deepEqual([...queues.work_audit_review], ['w1']);
    assert.deepEqual([...queues.work_validation_ready], ['w2', 'w3']);
    assert.doesNotThrow(() => assertD65QueueProjectionMembers({ state, members: queues }));
  });

  void it('rejects index counts that disagree with the derived queue sizes', () => {
    const state = stateFixture({ a: 'ready', b: 'ready' });
    const emptyIndex = { entry_count: 0, total_bytes: 0, sha256: canonicalSha256([]), shards: [] };
    const indexes = { unit_ready: emptyIndex, unit_running: emptyIndex, unit_blocked: emptyIndex, unit_completed: emptyIndex, unit_held: emptyIndex, work_audit_review: emptyIndex, work_validation_ready: emptyIndex };
    assert.throws(() => assertD65QueueProjectionCounts({ state, indexes }), /unit_ready index entry_count 0 does not equal the derived queue size 2/u);
  });

  void it('encodes the closed legal unit and work-item edge relations', () => {
    assert.equal(isD65LegalUnitEdge('ready', 'running'), true);
    assert.equal(isD65LegalUnitEdge('completed', 'ready'), false);
    assert.equal(isD65LegalWorkItemEdge('validation-ready', 'validated'), true);
    assert.equal(isD65LegalWorkItemEdge('closed', 'running'), false);
    // Recovery edge requires attempt+1 plus evidence.
    assert.throws(() => assertD65UnitTransition({ unitId: 'u', from: 'blocked', to: 'ready', fromAttempt: 1, toAttempt: 1, hasRecoveryEvidence: true }), /recovery edge requires attempt\+1/u);
    assert.throws(() => assertD65UnitTransition({ unitId: 'u', from: 'blocked', to: 'ready', fromAttempt: 1, toAttempt: 2, hasRecoveryEvidence: false }), /requires accepted recovery\/decision evidence/u);
    assert.doesNotThrow(() => assertD65UnitTransition({ unitId: 'u', from: 'blocked', to: 'ready', fromAttempt: 1, toAttempt: 2, hasRecoveryEvidence: true }));
    assert.throws(() => assertD65UnitTransition({ unitId: 'u', from: 'ready', to: 'ready', fromAttempt: 1, toAttempt: 1, hasRecoveryEvidence: false }), /undocumented same-state mutation/u);
    assert.throws(() => assertD65WorkItemTransition({ workItemId: 'w', from: 'planned', to: 'validated' }), /is not a legal edge/u);
  });
});

void describe('D65 source/dist contract manifest parity', () => {
  void it('enumerates the exact closed set of D65 JSON schemas in sorted order', () => {
    assert.deepEqual([...D65_CONTRACT_SCHEMA_VERSIONS], [
      'autopilot.attach_run_result.v2',
      'autopilot.capacity_decision.v1',
      'autopilot.continuation_event.v1',
      'autopilot.graph_publication.v1',
      'autopilot.heartbeat_high_water.v1',
      'autopilot.launch_policy.v1',
      'autopilot.parent_loss.v1',
      'autopilot.program_heartbeat.v1',
      'autopilot.program_heartbeat_acceptance_result.v1',
      'autopilot.run_terminal_intent.v2',
      'autopilot.semantic_graph.v1',
      'autopilot.semantic_graph_authority_shard.v1',
      'autopilot.semantic_graph_bootstrap.v1',
      'autopilot.semantic_graph_projection_shard.v1',
      'autopilot.subscription_probe.v1',
    ]);
    // The one explicitly frozen binary contract is not a JSON schema.
    assert.equal(D65_BINARY_TRUST_ANCHOR_SCHEMA, 'autopilot.operator_trust_anchor.v1');
    assert.equal(D65_CONTRACT_SCHEMA_VERSIONS.includes(D65_BINARY_TRUST_ANCHOR_SCHEMA), false);
  });

  void it('exposes a byte-identical manifest in the compiled dist module', () => {
    assert.deepEqual([...(DIST_D65_CONTRACT_SCHEMA_VERSIONS as readonly string[])], [...D65_CONTRACT_SCHEMA_VERSIONS]);
  });

  void it('binds every manifest entry to its exact lowest-layer parser and rejects unknown schemas', () => {
    for (const entry of D65_CONTRACT_MANIFEST) {
      assert.equal(d65ParserFor(entry.schema_version), entry.parse);
      assert.equal(entry.owner === 'graph-store-consumer' || entry.owner === 'cap-one-consumer' || entry.owner === 'graph-failure-hook', true);
    }
    assert.throws(() => d65ParserFor('autopilot.not_a_schema.v9'), /no D65 contract parser is registered/u);
  });
});

void describe('D65 trust anchor SPKI binary contract', () => {
  function realAnchor(): { spki: Uint8Array; privateKey: import('node:crypto').KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }) as unknown as Uint8Array);
    return { spki, privateKey };
  }

  void it('parses exactly 44 canonical SPKI bytes and verifies domain-separated signatures', () => {
    const { spki, privateKey } = realAnchor();
    const anchor = parseD65TrustAnchorSpki(spki);
    assert.equal(anchor.spki.byteLength, D65_ED25519_SPKI_BYTE_COUNT);
    const message = new TextEncoder().encode('{"policy_version":1}');
    const domain = Buffer.from('AUTOPILOT-D65-LAUNCH-POLICY\u0000', 'utf8');
    const signed = Buffer.concat([domain, Buffer.from(message)]);
    const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, signed, privateKey) as unknown as Uint8Array));
    assert.equal(verifyD65Signature({ trustAnchor: anchor, purpose: 'launch-policy', message, signature }), true);
    // Wrong purpose (domain confusion) fails.
    assert.equal(verifyD65Signature({ trustAnchor: anchor, purpose: 'parent-loss', message, signature }), false);
    // Padded/aliased signature rejects.
    assert.equal(verifyD65Signature({ trustAnchor: anchor, purpose: 'launch-policy', message, signature: `${signature}=` }), false);
  });

  void it('rejects wrong byte count, wrong prefix, and non-canonical DER', () => {
    const { spki } = realAnchor();
    assert.throws(() => parseD65TrustAnchorSpki(spki.subarray(0, 43)), /exactly 44 canonical SPKI bytes/u);
    const badPrefix = Uint8Array.from(spki); badPrefix[0] = 0x31;
    assert.throws(() => parseD65TrustAnchorSpki(badPrefix), /canonical Ed25519 DER header/u);
    const trailing = new Uint8Array(45); trailing.set(spki, 0);
    assert.throws(() => parseD65TrustAnchorSpki(trailing), /exactly 44 canonical SPKI bytes/u);
  });

  void it('round-trips unpadded base64url and rejects padded/alias forms', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const encoded = encodeUnpaddedBase64Url(bytes);
    assert.deepEqual([...(decodeUnpaddedBase64Url(encoded) ?? [])], [...bytes]);
    assert.equal(decodeUnpaddedBase64Url(`${encoded}=`), null);
    assert.equal(decodeUnpaddedBase64Url('has space'), null);
  });
});

void describe('D65 complete-graph loader/replayer', () => {
  const OID2 = (char: string): string => char.repeat(40);
  const DIGEST2 = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}` as const;
  const EMPTY = { entry_count: 0, total_bytes: 0, sha256: canonicalSha256([]), shards: [] };
  const shaText = (text: string): `sha256:${string}` => bytesSha256(Buffer.from(text, 'utf8'));

  function queueShard(kind: string, identity: string): { index: Record<string, unknown>; ref: string; bytes: string } {
    const ref = `semantic-graphs/00000000000000000002/queue/${kind}-0.json`;
    const value = { identity };
    const entry = { identity, kind, value_sha256: shaText(`${canonicalJson(value)}\n`), value };
    const shardObject = {
      schema_version: 'autopilot.semantic_graph_projection_shard.v1', program_id: 'p', repo_id: 'r', workstream_run: 'run',
      graph_sequence: 2, projection_kind: kind, entry_count: 1, total_bytes: Buffer.byteLength(`${canonicalJson(entry)}\n`, 'utf8'),
      first_identity: identity, last_identity: identity, entries: [entry],
    };
    const bytes = `${canonicalJson(shardObject)}\n`;
    const index = {
      entry_count: 1, total_bytes: Buffer.byteLength(`${canonicalJson(entry)}\n`, 'utf8'), sha256: shaText(`${canonicalJson([entry])}\n`),
      shards: [{ ref, sha256: shaText(bytes), byte_count: Buffer.byteLength(bytes, 'utf8'), entry_count: 1, first_identity: identity, last_identity: identity }],
    };
    return { index, ref, bytes };
  }

  function coreEntry2(schema: string | null, records: number | null, body: string): Record<string, unknown> {
    return { ref: `runtime/${schema ?? 'mission'}.f`, git_mode: '100644', git_blob_oid: OID2('a'), sha256: shaText(body), byte_count: Buffer.byteLength(body, 'utf8'), record_count: records, document_schema_version: schema };
  }

  function root(queue: Record<string, unknown>): Record<string, unknown> {
    const collections: Record<string, unknown> = {};
    for (const key of ['authorities', 'specs', 'statuses', 'receipts', 'audits', 'execution_commits', 'terminal_acceptances', 'unit_merge_intents', 'unit_merges', 'integration_analyses', 'quarantine', 'reconciliation', 'evidence']) collections[key] = { ...EMPTY };
    return {
      schema_version: 'autopilot.semantic_graph.v1', program_id: 'p', mode: 'complete', graph_sequence: 2,
      prior_graph_sha256: DIGEST2('a'), prior_event_seq: 1, repo_id: 'r', autopilot_id: 'a', workstream: 'w', workstream_run: 'run',
      covered_authority_commit: OID2('b'), covered_authority_tree: OID2('c'), covered_event_seq: 5,
      bootstrap_charter: { repository: {}, run: {}, run_resource: {}, mailbox_cursor: {}, bootstrap_graph: {}, bootstrap_artifact: {}, trust_anchor: {}, attach_event: {}, attach_result: {} },
      core: { mission: coreEntry2(null, null, '# m\n'), master_plan: coreEntry2('autopilot.master_plan.v1', 1, '{}\n'), state: coreEntry2('autopilot.state.v1', 1, '{}\n'), decision_log: coreEntry2('autopilot.decision.v1', 1, '{}\n'), events: coreEntry2('autopilot.event.v1', 1, '{}\n') },
      collections, work_items: { ...EMPTY }, bughunt: { ...EMPTY }, closure: null, queue_projection: queue, exceptions: { ...EMPTY }, coordinator_projection: { ...EMPTY }, created_at: '2026-07-19T00:00:00.000Z',
    };
  }

  const ALL_EMPTY: Record<string, unknown> = {
    unit_ready: { ...EMPTY }, unit_running: { ...EMPTY }, unit_blocked: { ...EMPTY }, unit_completed: { ...EMPTY },
    unit_held: { ...EMPTY }, work_audit_review: { ...EMPTY }, work_validation_ready: { ...EMPTY },
  };

  const reader = (blobs: Readonly<Record<string, string>>): D65GraphBlobReader => (ref) => {
    const bytes = blobs[ref];
    if (bytes === undefined) throw new Error(`missing blob ${ref}`);
    return Buffer.from(bytes, 'utf8');
  };

  void it('loads a single-member queue shard and exposes identities plus value shape', () => {
    const ready = queueShard('unit_ready', 'unit-a');
    const graph = parseD65CompleteGraph(root({ ...ALL_EMPTY, unit_ready: ready.index }));
    const loaded = loadD65CompleteGraph(graph, reader({ [ready.ref]: ready.bytes }));
    assert.deepEqual([...d65ProjectionIdentities(loaded, 'unit_ready')], ['unit-a']);
    assert.deepEqual([...d65ProjectionIdentities(loaded, 'unit_running')], []);
    assertD65QueueMemberValues(loaded, 'unit_ready');
  });

  void it('loads an all-empty graph with no shard reads and counts the five core blobs', () => {
    const graph = parseD65CompleteGraph(root({ ...ALL_EMPTY }));
    const loaded = loadD65CompleteGraph(graph, reader({}));
    assert.equal(loaded.aggregateReferencedEntries >= 5, true);
    assert.deepEqual([...d65ProjectionIdentities(loaded, 'unit_ready')], []);
  });

  void it('rejects a shard blob whose bytes do not match the descriptor byte_count', () => {
    const ready = queueShard('unit_ready', 'unit-a');
    const graph = parseD65CompleteGraph(root({ ...ALL_EMPTY, unit_ready: ready.index }));
    assert.throws(() => loadD65CompleteGraph(graph, reader({ [ready.ref]: `${ready.bytes} ` })), /byte_count does not match its descriptor/u);
  });

  void it('rejects a shard blob whose sha256 does not match the descriptor', () => {
    const ready = queueShard('unit_ready', 'unit-a');
    const tampered = ready.bytes.replace('unit-a', 'unit-b');
    const descByteCount = (ready.index as { shards: { byte_count: number }[] }).shards[0]?.byte_count;
    assert.equal(Buffer.byteLength(tampered, 'utf8'), descByteCount);
    const graph = parseD65CompleteGraph(root({ ...ALL_EMPTY, unit_ready: ready.index }));
    assert.throws(() => loadD65CompleteGraph(graph, reader({ [ready.ref]: tampered })), /sha256 does not match its descriptor/u);
  });

  void it('rejects a shard whose projection_kind does not match its index', () => {
    const ready = queueShard('unit_ready', 'unit-a');
    const other = queueShard('unit_running', 'unit-a');
    const index = { ...(ready.index as Record<string, unknown>), shards: [{ ...(ready.index as { shards: Record<string, unknown>[] }).shards[0], sha256: shaText(other.bytes), byte_count: Buffer.byteLength(other.bytes, 'utf8') }] };
    const graph = parseD65CompleteGraph(root({ ...ALL_EMPTY, unit_ready: index }));
    assert.throws(() => loadD65CompleteGraph(graph, reader({ [ready.ref]: other.bytes })), /projection_kind does not match the index/u);
  });

  void it('rejects a queue value that is not exactly {identity}', () => {
    const kind = 'unit_ready';
    const identity = 'unit-a';
    const ref = `semantic-graphs/00000000000000000002/queue/${kind}-0.json`;
    const value = { identity, extra: true };
    const entry = { identity, kind, value_sha256: shaText(`${canonicalJson(value)}\n`), value };
    const shardObject = { schema_version: 'autopilot.semantic_graph_projection_shard.v1', program_id: 'p', repo_id: 'r', workstream_run: 'run', graph_sequence: 2, projection_kind: kind, entry_count: 1, total_bytes: Buffer.byteLength(`${canonicalJson(entry)}\n`, 'utf8'), first_identity: identity, last_identity: identity, entries: [entry] };
    const bytes = `${canonicalJson(shardObject)}\n`;
    const index = { entry_count: 1, total_bytes: Buffer.byteLength(`${canonicalJson(entry)}\n`, 'utf8'), sha256: shaText(`${canonicalJson([entry])}\n`), shards: [{ ref, sha256: shaText(bytes), byte_count: Buffer.byteLength(bytes, 'utf8'), entry_count: 1, first_identity: identity, last_identity: identity }] };
    const graph = parseD65CompleteGraph(root({ ...ALL_EMPTY, unit_ready: index }));
    const loaded = loadD65CompleteGraph(graph, reader({ [ref]: bytes }));
    assert.throws(() => assertD65QueueMemberValues(loaded, 'unit_ready'), /must be exactly \{identity\} equal to its enclosing identity/u);
  });
});
