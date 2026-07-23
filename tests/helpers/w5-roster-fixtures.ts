import { createHash } from 'node:crypto';

import { computeAutopilotRosterContractObjectHash } from '../../src/core/roster/contracts.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import {
  SEED_CANDIDATES,
  SEED_ROSTERS,
  requestProfileFromAssignment,
  type RosterCandidate,
} from '../../src/core/roster/provider-recipes.ts';
import {
  materializeNewRunUnitSpecV2,
  materializeObservedProfile,
  materializeReceiptV2,
  type AutopilotReceiptV2MaterializationInput,
  type AutopilotRosterReceiptV2,
  type AutopilotRosterSelectionV1,
  type AutopilotRosterUnitSpecV2,
  type AutopilotRosterV1,
  type AutopilotUnitSpecV2MaterializationInput,
} from '../../src/core/roster/runtime-spec.ts';
import type { Digest, RosterRole } from '../../src/core/roster/route-policies.ts';
import { kimiRosterInventory, selfHashedKimiW4ManifestFixture } from './roster-setup-harness.ts';
import { proposeRosterCandidates, type QualificationManifest } from '../../src/core/roster/provider-recipes.ts';

const ZERO_SHA = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const;

export interface W5PinnedFacts {
  readonly candidate: RosterCandidate;
  readonly roster: AutopilotRosterV1;
  readonly selection: AutopilotRosterSelectionV1;
  readonly assignment: AutopilotRosterV1['assignments'][number];
  readonly requestProfile: ReturnType<typeof requestProfileFromAssignment>;
}

export function w5PinnedFacts(role: RosterRole = 'implement', candidateId = 'codex-cruise-v1'): W5PinnedFacts {
  const candidate = SEED_CANDIDATES.find((entry) => entry.candidate_id === candidateId);
  if (candidate === undefined) throw new Error(`missing seed candidate ${candidateId}`);
  const roster = SEED_ROSTERS.find((entry) => entry.roster_id === candidate.roster_id && entry.roster_revision === candidate.roster_revision);
  if (roster === undefined) throw new Error(`missing seed roster ${candidate.roster_id}`);
  const assignment = roster.assignments.find((entry) => entry.role === role);
  if (assignment === undefined) throw new Error(`missing role ${role}`);
  const selectionPreimage = {
    schema_version: 'autopilot.pre_run_selection.v1' as const,
    repo_id: 'repo-w5-roster-fixtures',
    workstream_run: 'w5-roster-run-001',
    scope: roster.scope,
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    roster_sha256: roster.roster_sha256,
    assignment_set_sha256: roster.assignment_set_sha256,
    config_sha256: 'sha256:5555555555555555555555555555555555555555555555555555555555555555' as const,
    selected_at: '2026-07-23T12:00:00.000Z',
    selection_sha256: ZERO_SHA,
  };
  const selection = {
    ...selectionPreimage,
    selection_sha256: w5RequiredHash('autopilot.pre_run_selection.v1', selectionPreimage),
  };
  return { candidate, roster, selection, assignment, requestProfile: requestProfileFromAssignment(assignment) };
}

export function w5UnitSpec(overrides: Partial<AutopilotUnitSpecV2MaterializationInput> = {}): AutopilotRosterUnitSpecV2 {
  const role = overrides.role ?? 'implement';
  const facts = w5PinnedFacts(role);
  return materializeNewRunUnitSpecV2({
    selection: facts.selection,
    roster: facts.roster,
    role,
    request_profile: facts.requestProfile,
    workstream: 'w5-roster-runtime',
    unit_id: 'w5-roster-unit',
    attempt: 1,
    objective: 'Exercise W5 roster boundary composition.',
    cwd: '/tmp/w5-roster-runtime/worktree',
    owned_paths: ['src/w5-runtime.ts'],
    read_only_paths: ['PHASE37_ROSTER_CONTRACT_FREEZE.md'],
    untouchable_paths: ['private/**'],
    context_refs: [{ path: 'PHASE37_ROSTER_CONTRACT_FREEZE.md', purpose: 'contract', sha256: null, byte_count: null }],
    validation_commands: ['npm run typecheck'],
    status_output: '/tmp/w5-roster-runtime/statuses/w5-roster-unit.implement.attempt-1.json',
    receipt_output: '/tmp/w5-roster-runtime/receipts/w5-roster-unit.implement.attempt-1.receipt.json',
    evidence_dir: '/tmp/w5-roster-runtime/evidence/w5-roster-unit',
    stop_boundary: 'Stop after W5 focused runtime validation.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['roster identities remain pinned'],
    verification_plan: null,
    closure_criteria: ['focused tests pass'],
    upstream_refs: [],
    timeout_seconds: 600,
    render_prompt_snapshot: false,
    ...overrides,
  });
}

export function w5Receipt(
  unit: AutopilotRosterUnitSpecV2,
  overrides: Partial<AutopilotReceiptV2MaterializationInput> = {},
): AutopilotRosterReceiptV2 {
  const facts = w5PinnedFacts(unit.role);
  const observedProfile = materializeObservedProfile({
    request_profile: facts.requestProfile,
    provider_id: facts.assignment.provider_id,
    requested_model_id: facts.assignment.model_id,
    executed_model_id: facts.assignment.model_id,
    api: facts.assignment.api,
    thinking: facts.assignment.thinking,
    service_tier: facts.assignment.service_tier,
    cache_policy: facts.assignment.cache_policy,
    system_prompt_profile: facts.assignment.system_prompt_profile,
    system_prompt_sha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    route_policy_id: facts.assignment.route_policy_id,
    route_policy_revision: facts.assignment.route_policy_revision,
  });
  return materializeReceiptV2({
    unit_spec: unit,
    selection: facts.selection,
    roster: facts.roster,
    request_profile: facts.requestProfile,
    observed_profile: observedProfile,
    emitted_at: '2026-07-23T12:00:05.000Z',
    status_sha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    schema_sha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    tool_call_id: 'call-w5-roster',
    provider_identity: {
      provider_id: facts.assignment.provider_id,
      requested_model_id: facts.assignment.model_id,
      executed_model_id: facts.assignment.model_id,
      api: facts.assignment.api,
      thinking_level: facts.assignment.thinking,
    },
    expected_identity_hash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    ...overrides,
  });
}

export function w5JsonBytes(value: unknown): string {
  return canonicalRosterJson(value);
}

export function w5TerminalAcceptance(
  unit: AutopilotRosterUnitSpecV2,
  unitBytes: string,
  receipt: AutopilotRosterReceiptV2,
  receiptBytes: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 'autopilot.child_terminal_acceptance.v1',
    repo_id: 'repo-w5-roster-fixtures',
    autopilot_id: 'autopilot-w5-roster',
    workstream: unit.workstream,
    workstream_run: 'w5-roster-run-001',
    unit_id: unit.unit_id,
    role: unit.role,
    attempt: unit.attempt,
    child_lease_id: 'lease-w5-roster',
    verdict: 'accepted',
    transport_result: 'accepted',
    spec: { ref: 'unit-specs/w5-roster-unit.implement.attempt-1.json', sha256: w5Sha256Utf8(unitBytes) },
    status: { ref: 'statuses/w5-roster-unit.implement.attempt-1.json', sha256: receipt.status_sha256 },
    receipt: { ref: 'receipts/w5-roster-unit.implement.attempt-1.receipt.json', sha256: w5Sha256Utf8(receiptBytes) },
    audit: { ref: 'execution-audits/w5-roster-unit.implement.attempt-1.audit.json', sha256: 'sha256:6666666666666666666666666666666666666666666666666666666666666666' },
    tool_call_id: receipt.tool_call_id,
    carrier_status_sha256: receipt.status_sha256,
    audit_disposition: 'accepted',
    created_at: '2026-07-23T12:00:06.000Z',
    ...overrides,
  };
}

export function w5RequiredHash(
  schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0],
  value: unknown,
): Digest {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash as Digest;
}

export function w5RehashObject<T extends Record<string, unknown>>(
  schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0],
  value: T,
  hashField: keyof T & string,
): T {
  return { ...value, [hashField]: w5RequiredHash(schemaVersion, { ...value, [hashField]: ZERO_SHA }) };
}

export function w5Sha256Utf8(text: string): Digest {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}` as Digest;
}

export function w5SelfHashedKimiManifest(): QualificationManifest {
  return selfHashedKimiW4ManifestFixture().manifest;
}

export function w5KimiCandidate(): RosterCandidate {
  const proposal = proposeRosterCandidates({ inventory: kimiRosterInventory(), include_unready: true });
  const candidate = proposal.candidate_set.candidates.find((entry) => entry.recipe_id === 'kimi-coding-plan');
  if (candidate === undefined) throw new Error('missing W5 Kimi candidate');
  return candidate;
}
