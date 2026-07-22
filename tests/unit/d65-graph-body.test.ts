import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { discoverD65GraphCore } from '../../src/core/coordination/d65-graph-body.ts';
import type { D65GraphAuthorityReader, D65GraphTreeLeaf } from '../../src/core/coordination/d65-graph-authority.ts';

const encoder = new TextEncoder();

function blobOid(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${String(bytes.byteLength)}\0`, 'utf8').update(bytes).digest('hex');
}

function verificationPlan() {
  return { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] };
}

function coreReader(overrides: Readonly<Record<string, string>> = {}): D65GraphAuthorityReader {
  const prefix = '.pi/autopilot/demo';
  const values: Readonly<Record<string, string>> = {
    [`${prefix}/mission.md`]: '# Mission\n',
    [`${prefix}/master-plan.json`]: `${JSON.stringify({
      schema_version: 'autopilot.master_plan.v1', workstream: 'demo', mission_ref: 'mission.md', goal_summary: 'demo', non_goals: [], definition_of_done: ['done'], risk_level: 'low',
      lanes: [{ lane_id: 'main', summary: 'main', unit_ids: ['u1'] }], units: { u1: { unit_id: 'u1', role: 'validate', state: 'ready', dependencies: [], summary: 'validate' } },
      ownership_matrix: { owned_paths: [], read_only_paths: [], untouchable_paths: [], held_paths: [] }, verification_matrix: verificationPlan(), closure_criteria: ['done'], current_focus: 'u1',
      last_decision_id: 1, last_event_id: 1, updated_at: '2026-07-22T00:00:00.000Z',
    })}\n`,
    [`${prefix}/state.json`]: `${JSON.stringify({
      schema_version: 'autopilot.state.v1', workstream: 'demo', updated_at: '2026-07-22T00:00:00.000Z', status: 'running', context_gate: { gate: 'ok', percent: 100 }, last_event_id: 1,
      ready_queue: ['u1'], running: [], blocked: [], completed: [], units: { u1: { unit_id: 'u1', role: 'validate', state: 'ready', attempt: 1, summary: 'ready' } }, operator_questions: [], next_actions: [],
    })}\n`,
    [`${prefix}/decision-log.jsonl`]: `\n${JSON.stringify({ schema_version: 'autopilot.decision.v1', id: 1, ts: '2026-07-22T00:00:00.000Z', event: 'master_plan_created', workstream: 'demo', summary: 'plan', decision: 'execute' })}\n\n`,
    [`${prefix}/events.jsonl`]: `${JSON.stringify({ schema_version: 'autopilot.event.v1', id: 1, ts: '2026-07-22T00:00:00.000Z', event: 'state_created', workstream: 'demo', summary: 'start' })}\n`,
    ...overrides,
  };
  const bytes = new Map<string, Uint8Array>();
  const entries: D65GraphTreeLeaf[] = Object.entries(values).map(([ref, text]) => {
    const content = encoder.encode(text); bytes.set(ref, content);
    return Object.freeze({ ref, mode: '100644', type: 'blob', oid: blobOid(content) });
  });
  return Object.freeze({ entries: Object.freeze(entries), readBlob: (ref: string): Uint8Array => {
    const value = bytes.get(ref); if (value === undefined) throw new Error(`missing ${ref}`); return value;
  } });
}

describe('D65 complete graph core discovery', () => {
  it('reads exact core Git blobs and counts only nonblank parsed JSONL rows', () => {
    const discovered = discoverD65GraphCore({ readGitAtG: coreReader(), runtimePrefix: '.pi/autopilot/demo', workstream: 'demo' });
    assert.equal(discovered.decisions.length, 1);
    assert.equal(discovered.events.length, 1);
    assert.equal(discovered.descriptors.decision_log.record_count, 1);
    assert.equal(discovered.descriptors.events.record_count, 1);
    assert.equal(discovered.descriptors.mission.document_schema_version, null);
    assert.equal(discovered.descriptors.master_plan.document_schema_version, 'autopilot.master_plan.v1');
  });

  it('rejects a ledger gap and stale state/master-plan tail authority', () => {
    const gap = `${JSON.stringify({ schema_version: 'autopilot.event.v1', id: 2, ts: '2026-07-22T00:00:00.000Z', event: 'state_created', workstream: 'demo', summary: 'gap' })}\n`;
    assert.throws(
      () => discoverD65GraphCore({ readGitAtG: coreReader({ '.pi/autopilot/demo/events.jsonl': gap }), runtimePrefix: '.pi/autopilot/demo', workstream: 'demo' }),
      /ids are not contiguous from one/u,
    );
    assert.throws(
      () => discoverD65GraphCore({ readGitAtG: coreReader({ '.pi/autopilot/demo/events.jsonl': '' }), runtimePrefix: '.pi/autopilot/demo', workstream: 'demo' }),
      /last_event_id differs from the exact event ledger tail/u,
    );
  });

  it('rejects any aliased runtime prefix rather than discovering by suffix', () => {
    assert.throws(
      () => discoverD65GraphCore({ readGitAtG: coreReader(), runtimePrefix: '.pi/autopilot/other', workstream: 'demo' }),
      /runtime prefix does not equal the exact workstream root/u,
    );
  });
});
