import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  D65_GRAPH_AUTHORITY_REGISTRY,
  discoverD65GraphAuthority,
  type D65GraphAuthorityReader,
  type D65GraphTreeLeaf,
} from '../../src/core/coordination/d65-graph-authority.ts';

const encoder = new TextEncoder();

function oid(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${String(bytes.byteLength)}\0`, 'utf8').update(bytes).digest('hex');
}

function reader(documents: readonly Readonly<{ ref: string; value: unknown; mode?: D65GraphTreeLeaf['mode']; raw?: string; oid?: string }>[]): D65GraphAuthorityReader {
  const bytes = new Map<string, Uint8Array>();
  const entries = documents.map((document): D65GraphTreeLeaf => {
    const content = encoder.encode(document.raw ?? `${JSON.stringify(document.value)}\n`);
    bytes.set(document.ref, content);
    const mode = document.mode ?? '100644';
    return Object.freeze({ ref: document.ref, mode, type: mode === '160000' ? 'commit' : 'blob', oid: document.oid ?? oid(content) });
  });
  return Object.freeze({ entries: Object.freeze(entries), readBlob: (ref: string): Uint8Array => {
    const content = bytes.get(ref);
    if (content === undefined) throw new Error(`missing test blob ${ref}`);
    return content;
  } });
}

function discover(readGitAtG: D65GraphAuthorityReader) {
  return discoverD65GraphAuthority({
    readGitAtG, acceptedArtifacts: [], repoId: 'repo-1', workstreamRun: 'run-1', workstream: 'demo',
    runtimePrefix: '.pi/autopilot/demo',
  });
}

describe('D65 graph authority registry and fixed-root discovery', () => {
  it('discovers opaque evidence bytes with the full ga identity and exact Git tuple', () => {
    const ref = '.pi/autopilot/demo/evidence/proof.bin';
    const bytes = encoder.encode('proof\n');
    const result = discover(reader([{ ref, value: null, raw: 'proof\n' }]));
    assert.equal(result.collections.evidence.length, 1);
    assert.deepEqual(result.collections.evidence[0], {
      identity: `ga:evidence:${createHash('sha256').update(ref, 'utf8').digest('hex')}`,
      ref, git_mode: '100644', git_blob_oid: oid(bytes),
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byte_count: bytes.byteLength, document_schema_version: null,
    });
  });

  it('rejects unknown schemas, undeclared authority subdirectories, and non-regular modes', () => {
    assert.throws(
      () => discover(reader([{ ref: '.pi/autopilot/demo/statuses/bad.json', value: { schema_version: 'autopilot.unknown.v1' } }])),
      /authority schema is not admitted at its fixed registry root/u,
    );
    assert.throws(
      () => discover(reader([{ ref: '.pi/autopilot/demo/authority/unregistered/bad.json', value: { schema_version: 'autopilot.authority.v1' } }])),
      /fixed authority root contains an undeclared nested path/u,
    );
    assert.throws(
      () => discover(reader([{ ref: '.pi/autopilot/demo/evidence/link', value: null, raw: 'target', mode: '120000' }])),
      /not a mode-100644 regular Git blob/u,
    );
  });

  it('rejects historical unit-failure layouts at the D65 discovery boundary', () => {
    assert.throws(
      () => discover(reader([{ ref: '.pi/autopilot/demo/quarantine/u1.json', value: {
        schema_version: 'autopilot.unit_failure.v1', action: 'reset', workstream: 'demo', workstream_run: 'run-1', unit_id: 'u1', attempt: 1,
        unit_worktree_path: '/tmp/u1', dirty_paths: [], summary: 'historical', created_at: '2026-07-22T00:00:00.000Z',
      } }])),
      /missing required fields/u,
    );
  });

  it('rejects a blob observation whose bytes do not equal its named Git object id', () => {
    assert.throws(
      () => discover(reader([{ ref: '.pi/autopilot/demo/evidence/proof.bin', value: null, raw: 'proof\n', oid: 'a'.repeat(40) }])),
      /bytes do not equal the named Git blob object/u,
    );
  });

  it('exposes one closed parser-bearing row for every non-opaque registry root', () => {
    assert.ok(D65_GRAPH_AUTHORITY_REGISTRY.length >= 19);
    for (const registration of D65_GRAPH_AUTHORITY_REGISTRY) {
      assert.ok(registration.roots.length > 0);
      if (!registration.opaque) {
        assert.ok(registration.schemas.length > 0);
        for (const admitted of registration.schemas) assert.equal(typeof admitted.parser, 'function');
      }
    }
  });

  it('covers every current fixed-root writer/schema pair with exactly one registry parser', () => {
    // The exact writer/schema → fixed-root inventory of the current package.
    // Adding a writer or schema without a registry/parser change in the same
    // commit fails this enumeration (accepted amendment §2 sign-off gate).
    const writers: readonly Readonly<{ root: string; schema: string }>[] = [
      { root: 'authority/', schema: 'autopilot.authority.v1' },
      { root: 'authority/continuation/', schema: 'autopilot.continuation_event.v1' },
      { root: 'authority/continuation/', schema: 'autopilot.parent_loss.v1' },
      { root: 'unit-specs/', schema: 'autopilot.unit_spec.v1' },
      { root: 'statuses/', schema: 'autopilot.status.v1' },
      { root: 'receipts/', schema: 'autopilot.receipt.v1' },
      { root: 'execution-audits/', schema: 'autopilot.execution_audit.v1' },
      { root: 'execution-commits/', schema: 'autopilot.execution_commit.v1' },
      { root: 'terminal-acceptances/', schema: 'autopilot.child_terminal_acceptance.v1' },
      { root: 'unit-merge-intents/', schema: 'autopilot.unit_merge_intent.v1' },
      { root: 'unit-merges/', schema: 'autopilot.unit_merge.v1' },
      { root: 'integration-analyses/', schema: 'autopilot.integration_analysis.v1' },
      { root: 'merge-conflicts/', schema: 'autopilot.merge_conflict.v1' },
      { root: 'quarantine/', schema: 'autopilot.unit_failure.v1' },
      { root: 'coordination-reconciliation/', schema: 'autopilot.reconciliation_intent.v1' },
      { root: 'coordination-reconciliation/', schema: 'autopilot.reconciliation_intent_supersession.v1' },
      { root: 'reservation-integration/', schema: 'autopilot.reservation_integration.v1' },
      { root: 'reservation-repairs/', schema: 'autopilot.reservation_repair.v1' },
      { root: 'validation/', schema: 'autopilot.validation_evidence.v1' },
      { root: 'validation-staleness/', schema: 'autopilot.validation_staleness.v1' },
      { root: 'validation-staleness/', schema: 'autopilot.validation_staleness.v2' },
    ];
    for (const writer of writers) {
      const matches = D65_GRAPH_AUTHORITY_REGISTRY.filter((registration) => registration.roots.includes(writer.root) && registration.schemas.some((admitted) => admitted.schema_version === writer.schema));
      assert.equal(matches.length, 1, `writer ${writer.root} ${writer.schema} must have exactly one registry parser`);
    }
    // Conversely every registered non-opaque schema is in the writer inventory
    // (no orphan registry rows).
    for (const registration of D65_GRAPH_AUTHORITY_REGISTRY) {
      if (registration.opaque) continue;
      for (const admitted of registration.schemas) {
        assert.equal(writers.some((writer) => registration.roots.includes(writer.root) && writer.schema === admitted.schema_version), true, `registry schema ${admitted.schema_version} lacks a writer inventory row`);
      }
    }
  });
});

describe('D65 transitive-ref extractor closure', () => {
  const prefix = '.pi/autopilot/demo';
  const mainWorktreePath = '/repo/main';

  function coreSeeds(units: Readonly<Record<string, unknown>>, extras: Readonly<Record<string, unknown>> = {}) {
    const state = {
      schema_version: 'autopilot.state.v1', workstream: 'demo', updated_at: '2026-07-22T00:00:00.000Z', status: 'running',
      context_gate: { gate: 'ok', percent: 10 }, last_event_id: 1, ready_queue: [], running: [], blocked: [], completed: [],
      units, operator_questions: [], next_actions: [], ...extras,
    };
    const masterPlan = {
      schema_version: 'autopilot.master_plan.v1', workstream: 'demo', mission_ref: 'mission.md', goal_summary: 'closure test',
      non_goals: [], definition_of_done: ['done'], risk_level: 'low', lanes: [], units: Object.freeze({}),
      ownership_matrix: { owned_paths: [], read_only_paths: [], untouchable_paths: [], held_paths: [] },
      verification_matrix: { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] },
      closure_criteria: ['done'], current_focus: 'none', last_decision_id: 0, last_event_id: 1, updated_at: '2026-07-22T00:00:00.000Z',
    };
    // These seeds mirror the parsed core objects; the closure consumes the raw
    // parsed shapes (already validated upstream by discoverD65GraphCore).
    return { state, master_plan: masterPlan } as never;
  }

  function discoverWithSeeds(readGitAtG: D65GraphAuthorityReader, seeds: ReturnType<typeof coreSeeds>) {
    return discoverD65GraphAuthority({
      readGitAtG, acceptedArtifacts: [], repoId: 'repo-1', workstreamRun: 'run-1', workstream: 'demo',
      runtimePrefix: prefix, mainWorktreePath, coreSeeds: seeds,
    });
  }

  const status = {
    schema_version: 'autopilot.status.v1', workstream: 'demo', unit_id: 'u1', role: 'implement', attempt: 1,
    verdict: 'DONE', severity: 'clean', summary: 'The implement unit completed cleanly with all validations green.', changed_paths: [],
    findings: [], commands: [], evidence_refs: [] as unknown[], report_ref: null, next_action: 'advance work',
  };

  it('includes referenced status evidence as opaque evidence and rejects a wrong digest binding', () => {
    const evidenceBytes = 'raw evidence\n';
    const evidenceSha = `sha256:${createHash('sha256').update(evidenceBytes, 'utf8').digest('hex')}`;
    const boundStatus = { ...status, evidence_refs: [{ path: 'evidence/proof.txt', sha256: evidenceSha, byte_count: evidenceBytes.length }] };
    const good = discoverWithSeeds(reader([
      { ref: `${prefix}/statuses/u1.json`, value: boundStatus },
      { ref: `${prefix}/evidence/proof.txt`, value: null, raw: evidenceBytes },
    ]), coreSeeds({}));
    assert.equal(good.collections.evidence.length, 1);
    assert.equal(good.collections.evidence[0]?.ref, `${prefix}/evidence/proof.txt`);
    const wrongDigest = { ...status, evidence_refs: [{ path: 'evidence/proof.txt', sha256: `sha256:${'0'.repeat(64)}`, byte_count: evidenceBytes.length }] };
    assert.throws(
      () => discoverWithSeeds(reader([
        { ref: `${prefix}/statuses/u1.json`, value: wrongDigest },
        { ref: `${prefix}/evidence/proof.txt`, value: null, raw: evidenceBytes },
      ]), coreSeeds({})),
      /digest binding does not match target bytes/u,
    );
  });

  it('rejects a missing required transitive target and a state unit ref outside its collection root', () => {
    const missing = { ...status, evidence_refs: [{ path: 'evidence/absent.txt' }] };
    assert.throws(
      () => discoverWithSeeds(reader([{ ref: `${prefix}/statuses/u1.json`, value: missing }]), coreSeeds({})),
      /required transitive authority ref is absent at G/u,
    );
    // A state unit status_ref that resolves to an evidence path conflicts with
    // its declared `statuses` target collection.
    assert.throws(
      () => discoverWithSeeds(reader([
        { ref: `${prefix}/evidence/misplaced.json`, value: null, raw: 'not a status\n' },
      ]), coreSeeds({ u1: { unit_id: 'u1', role: 'implement', state: 'ready', attempt: 1, summary: 'unit', status_ref: 'evidence/misplaced.json' } })),
      /two conflicting collection assignments/u,
    );
  });

  it('resolves state unit refs through the runtime base and unit-spec declared outputs beneath the runtime root', () => {
    const spec = {
      schema_version: 'autopilot.unit_spec.v1', workstream: 'demo', unit_id: 'u1', role: 'implement', template: 'implement',
      attempt: 1, objective: 'closure spec objective for testing purposes', cwd: '/repo/main', model: 'terra', thinking: 'high',
      owned_paths: ['src/'], read_only_paths: [], untouchable_paths: [], context_refs: [], validation_commands: [],
      status_output: `${mainWorktreePath}/${prefix}/statuses/u1.json`, receipt_output: `${mainWorktreePath}/${prefix}/receipts/u1.json`,
      evidence_dir: `${mainWorktreePath}/${prefix}/evidence/u1`, stop_boundary: 'stop after the unit completes its objective',
      upstream_refs: [{ unit_id: 'u0', purpose: 'context from the upstream implement unit', status_ref: 'statuses/u0.json' }],
    };
    const upstreamStatus = { ...status, unit_id: 'u0' };
    const result = discoverWithSeeds(reader([
      { ref: `${prefix}/unit-specs/u1.json`, value: spec },
      { ref: `${prefix}/statuses/u0.json`, value: upstreamStatus },
      { ref: `${prefix}/statuses/u1.json`, value: status },
      { ref: `${prefix}/evidence/u1/log.txt`, value: null, raw: 'child log\n' },
    ]), coreSeeds({ u1: { unit_id: 'u1', role: 'implement', state: 'ready', attempt: 1, summary: 'unit', spec_ref: 'unit-specs/u1.json', status_ref: 'statuses/u1.json' } }));
    assert.equal(result.collections.specs.length, 1);
    assert.equal(result.collections.statuses.length, 2);
    // The declared evidence_dir contents are recursively included as opaque evidence.
    assert.equal(result.collections.evidence.some((entry) => entry.ref === `${prefix}/evidence/u1/log.txt`), true);
  });

  it('omits absolute unit-spec outputs that resolve outside the run-main runtime root (unit-worktree cwd)', () => {
    // A unit-worktree spec: its cwd-derived outputs live beneath the UNIT
    // worktree's runtime root, not the run-main runtime root. The closed spec
    // parser accepts them (they are under the spec's own runtime artifact
    // root), and graph discovery treats them as non-authority: never traversed,
    // never an error by themselves (accepted amendment §3).
    const unitCwd = '/repo/units/u1/worktree';
    const spec = {
      schema_version: 'autopilot.unit_spec.v1', workstream: 'demo', unit_id: 'u1', role: 'implement', template: 'implement',
      attempt: 1, objective: 'closure spec objective for testing purposes', cwd: unitCwd, model: 'terra', thinking: 'high',
      owned_paths: ['src/'], read_only_paths: [], untouchable_paths: [], context_refs: [], validation_commands: [],
      status_output: `${unitCwd}/${prefix}/statuses/u1.json`, receipt_output: `${unitCwd}/${prefix}/receipts/u1.json`,
      evidence_dir: `${unitCwd}/${prefix}/evidence/u1`, stop_boundary: 'stop after the unit completes its objective',
    };
    const result = discoverWithSeeds(reader([{ ref: `${prefix}/unit-specs/u1.json`, value: spec }]), coreSeeds({}));
    assert.equal(result.collections.specs.length, 1);
    assert.equal(result.collections.evidence.length, 0);
  });
});
