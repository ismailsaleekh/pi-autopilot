import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import type { AutopilotState, AutopilotStatusEntry } from '../../src/core/contracts/types.ts';
import { validateAutopilotStateReferences } from '../../src/core/state-store/index.ts';
import { computeAutopilotRosterContractObjectHash } from '../../src/core/roster/contracts.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import {
  materializeNewRunUnitSpecV2,
  materializeObservedProfile,
  materializeReceiptV2,
  requestProfileFromAssignment,
  type AutopilotReceiptV2MaterializationInput,
  type AutopilotRosterReceiptV2,
  type AutopilotRosterSelectionV1,
  type AutopilotRosterUnitSpecV2,
  type AutopilotRosterV1,
  type AutopilotUnitSpecV2MaterializationInput,
} from '../../src/core/roster/runtime-spec.ts';
import {
  assertRuntimeReceiptMatchesUnitSpec,
  parseNewRunRuntimeReceipt,
  parseNewRunRuntimeUnitSpec,
  unitSpecAuthorityProjection,
} from '../../src/core/roster/runtime-consumers.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-roster-v2-runtime-consumers-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void describe('Phase37 roster v2 runtime consumers', () => {
  void it('accepts strict new-run unit_spec.v2 and keeps roster identity in the explicit authority projection', () => {
    const unit = makeUnitSpec({});
    const context = parseNewRunRuntimeUnitSpec(unit);

    assert.equal(context.schema_version, 'autopilot.unit_spec.v2');
    assert.equal(context.unit_spec.schema_version, 'autopilot.unit_spec.v2');
    assert.equal(context.roster_identity.roster_sha256, unit.roster_sha256);
    assert.equal(context.roster_identity.assignment_sha256, unit.assignment_sha256);
    assert.equal(context.roster_identity.request_profile_sha256, unit.request_profile.request_profile_sha256);
    assert.equal(context.authority_spec.schema_version, 'autopilot.unit_spec.v1');
    assert.equal(context.authority_spec.model, unit.request_profile.model);
    assert.equal(context.authority_spec.thinking, unit.request_profile.thinking);

    assert.throws(
      () => parseNewRunRuntimeUnitSpec(unitSpecAuthorityProjection(unit)),
      /unit_spec\.v2/u,
    );
  });

  void it('rejects mixed receipt schemas and request-profile drift', () => {
    const unit = makeUnitSpec({});
    const unitContext = parseNewRunRuntimeUnitSpec(unit);
    const receipt = makeReceipt(unit);
    const receiptContext = parseNewRunRuntimeReceipt(receipt, { unitSpec: unitContext });
    assert.doesNotThrow(() => assertRuntimeReceiptMatchesUnitSpec({ unitSpec: unitContext, receipt: receiptContext }));

    assert.throws(
      () => parseNewRunRuntimeReceipt({ schema_version: 'autopilot.receipt.v1' }),
      /receipt\.v2/u,
    );

    const drifted = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
    drifted['assignment_sha256'] = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    assert.throws(
      () => parseNewRunRuntimeReceipt(drifted, { unitSpec: unitContext }),
      /assignment_sha256/u,
    );
  });

  void it('state-store validates v2 spec/status/receipt refs without discarding roster identity and rejects mixed v1 receipts', async () => {
    await withTempDir(async (root) => {
      const unit = makeUnitSpec({
        cwd: join(root, 'worktree'),
        status_output: join(root, 'statuses', 'u-runtime.implement.attempt-1.json'),
        receipt_output: join(root, 'receipts', 'u-runtime.implement.attempt-1.receipt.json'),
        evidence_dir: join(root, 'evidence', 'u-runtime'),
      });
      const receipt = makeReceipt(unit);
      const status = makeStatus(unit);
      const specRef = 'unit-specs/u-runtime.implement.attempt-1.json';
      const statusRef = 'statuses/u-runtime.implement.attempt-1.json';
      const receiptRef = 'receipts/u-runtime.implement.attempt-1.receipt.json';
      await writeJson(join(root, specRef), unit);
      await writeJson(join(root, statusRef), status);
      await writeJson(join(root, receiptRef), receipt);

      const refs = await validateAutopilotStateReferences({
        artifactRoot: root,
        state: makeState({ specRef, statusRef, receiptRef }),
      });
      assert.equal(refs.specs[specRef]?.schema_version, 'autopilot.unit_spec.v2');
      assert.equal(refs.receipts[receiptRef]?.schema_version, 'autopilot.receipt.v2');
      assert.equal((refs.specs[specRef] as AutopilotRosterUnitSpecV2).assignment_sha256, unit.assignment_sha256);

      await writeJson(join(root, receiptRef), {
        schema_version: 'autopilot.receipt.v1',
        tool_name: 'autopilot_emit_status',
        workstream: unit.workstream,
        unit_id: unit.unit_id,
        role: unit.role,
        attempt: unit.attempt,
      });
      await assert.rejects(
        () => validateAutopilotStateReferences({ artifactRoot: root, state: makeState({ specRef, statusRef, receiptRef }) }),
        /receipt\.v2/u,
      );
    });
  });
});

function makeUnitSpec(overrides: Partial<AutopilotUnitSpecV2MaterializationInput>): AutopilotRosterUnitSpecV2 {
  const { selection, roster, requestProfile } = pinnedFacts();
  return materializeNewRunUnitSpecV2({
    selection,
    roster,
    role: 'implement',
    request_profile: requestProfile,
    workstream: 'phase37-runtime',
    unit_id: 'u-runtime',
    attempt: 1,
    objective: 'Exercise v2 runtime consumers.',
    cwd: '/tmp/phase37-runtime/worktree',
    owned_paths: ['src/runtime.ts'],
    read_only_paths: ['README.md'],
    untouchable_paths: ['private/**'],
    context_refs: [{ path: 'README.md', purpose: 'context', sha256: null, byte_count: null }],
    validation_commands: [],
    status_output: '/tmp/phase37-runtime/statuses/u-runtime.implement.attempt-1.json',
    receipt_output: '/tmp/phase37-runtime/receipts/u-runtime.implement.attempt-1.receipt.json',
    evidence_dir: '/tmp/phase37-runtime/evidence/u-runtime',
    stop_boundary: 'Stop at runtime consumer boundary.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['runtime consumers retain identity'],
    verification_plan: null,
    closure_criteria: ['focused tests pass'],
    upstream_refs: [],
    timeout_seconds: 600,
    render_prompt_snapshot: false,
    ...overrides,
  });
}

function makeReceipt(unit: AutopilotRosterUnitSpecV2): AutopilotRosterReceiptV2 {
  const { selection, roster, assignment, requestProfile } = pinnedFacts();
  const observed = materializeObservedProfile({
    request_profile: requestProfile,
    provider_id: assignment.provider_id,
    requested_model_id: assignment.model_id,
    executed_model_id: assignment.model_id,
    api: assignment.api,
    thinking: assignment.thinking,
    service_tier: assignment.service_tier,
    cache_policy: assignment.cache_policy,
    system_prompt_profile: assignment.system_prompt_profile,
    system_prompt_sha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    route_policy_id: assignment.route_policy_id,
    route_policy_revision: assignment.route_policy_revision,
  });
  const input: AutopilotReceiptV2MaterializationInput = {
    unit_spec: unit,
    selection,
    roster,
    request_profile: requestProfile,
    observed_profile: observed,
    emitted_at: '2026-07-23T12:00:00.000Z',
    status_sha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    schema_sha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    tool_call_id: 'call-runtime-v2',
    provider_identity: {
      provider_id: assignment.provider_id,
      requested_model_id: assignment.model_id,
      executed_model_id: assignment.model_id,
      api: assignment.api,
      thinking_level: assignment.thinking,
    },
    expected_identity_hash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  };
  return materializeReceiptV2(input);
}

function makeStatus(unit: AutopilotRosterUnitSpecV2): AutopilotStatusEntry {
  return {
    schema_version: 'autopilot.status.v1',
    workstream: unit.workstream,
    unit_id: unit.unit_id,
    role: unit.role,
    attempt: unit.attempt,
    verdict: 'DONE',
    severity: 'clean',
    summary: 'done',
    changed_paths: ['src/runtime.ts'],
    findings: [],
    commands: [],
    evidence_refs: [],
    report_ref: null,
    next_action: 'parent may continue',
  };
}

function makeState(input: { readonly specRef: string; readonly statusRef: string; readonly receiptRef: string }): AutopilotState {
  return {
    schema_version: 'autopilot.state.v1',
    workstream: 'phase37-runtime',
    updated_at: '2026-07-23T12:00:02.000Z',
    status: 'running',
    context_gate: { gate: 'ok', percent: null },
    last_event_id: 0,
    ready_queue: [],
    running: [],
    blocked: [],
    completed: ['u-runtime'],
    units: {
      'u-runtime': {
        unit_id: 'u-runtime',
        role: 'implement',
        state: 'completed',
        attempt: 1,
        spec_ref: input.specRef,
        status_ref: input.statusRef,
        receipt_ref: input.receiptRef,
        summary: 'completed',
      },
    },
    operator_questions: [],
    next_actions: [],
  };
}

function pinnedFacts(): {
  readonly selection: AutopilotRosterSelectionV1;
  readonly roster: AutopilotRosterV1;
  readonly assignment: AutopilotRosterV1['assignments'][number];
  readonly requestProfile: ReturnType<typeof requestProfileFromAssignment>;
} {
  const roster = SEED_ROSTERS.find((entry) => entry.assignments.some((assignment) => assignment.role === 'implement'));
  if (roster === undefined) throw new Error('missing seed roster');
  const assignment = roster.assignments.find((entry) => entry.role === 'implement');
  if (assignment === undefined) throw new Error('missing implement assignment');
  const selectionWithoutHash = {
    schema_version: 'autopilot.pre_run_selection.v1' as const,
    repo_id: 'repo-runtime-v2',
    workstream_run: 'run-runtime-v2',
    scope: roster.scope,
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    roster_sha256: roster.roster_sha256,
    assignment_set_sha256: roster.assignment_set_sha256,
    config_sha256: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    selected_at: '2026-07-23T12:00:00.000Z',
    selection_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  const selection = {
    ...selectionWithoutHash,
    selection_sha256: requiredHash('autopilot.pre_run_selection.v1', selectionWithoutHash),
  };
  return { selection, roster, assignment, requestProfile: requestProfileFromAssignment(assignment) };
}

function requiredHash(schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0], value: unknown): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
