import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY,
  CUSTOM_ROSTER_REQUEST_SCHEMA,
  buildUserCustomRosterFromAssignments,
  publishCustomRosterCertificationAuthority,
  readCustomRosterCertificationAuthority,
  requiredCustomRosterEvidenceRefs,
  validateCustomRosterSetupRequest,
  verifyCustomRosterManifestForRoster,
} from '../../src/core/roster/custom-certification.ts';
import {
  fakeInventoryFromProviders,
  getProviderRecipe,
  proposeRosterCandidates,
  seedRosterByCandidate,
  type Assignment,
  type EvidenceRef,
  type ProviderRecipe,
  type QualificationManifest,
  type RoleTemplate,
  type Roster,
} from '../../src/core/roster/provider-recipes.ts';
import {
  PHASE37_PACKAGE_VERSION,
  PHASE37_PI_VERSION,
  ROSTER_ROLE_ORDER,
  canonicalSha256,
  type InventoryProvider,
  type RosterInventory,
  type RosterRole,
} from '../../src/core/roster/route-policies.ts';
import { resolveRosterScopePaths } from '../../src/core/roster/storage.ts';

const CUSTOM_NOW = new Date('2026-07-24T00:00:00.000Z');
const CUSTOM_CREATED_AT = '2026-07-24T00:00:00.000Z';

type CustomResult = ReturnType<typeof validateCustomRosterSetupRequest>;

void describe('W5 custom roster certification', () => {
  void it('accepts a closed mixed-provider roster as a structurally valid draft but not certified', () => {
    const inventory = mixedPlanInventory();
    const roster = mixedCustomRoster(inventory);
    const result = validateCustomRosterSetupRequest({ request: customRequest(roster), inventory, now: CUSTOM_NOW });

    assert.equal(result.structural_status, 'structurally-valid-draft');
    assert.equal(result.certification_status, 'absent');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.mixed_provider_roster, true);
    assert.deepEqual(result.provider_ids, ['kimi-coding', 'zai']);
    assert.deepEqual(result.route_policy_ids, ['kimi-coding-plan-v1', 'zai-coding-plan-v1']);
    assert.deepEqual(codes(result), ['ROSTER_QUALIFICATION_REQUIRED']);
    assert.equal(JSON.stringify(result).includes('Use a mixed Kimi/ZAI'), false);
    assert.equal(result.write_count, 0);
    assert.equal(result.lock_count, 0);
    assert.deepEqual(result.files_touched, []);
    const preimage = { ...result } as Record<string, unknown>;
    delete preimage['result_sha256'];
    assert.equal(result.result_sha256, canonicalSha256(preimage));
  });

  void it('rejects request/draft schema drift and validates model thinking deterministically', () => {
    const inventory = mixedPlanInventory();
    const roster = mixedCustomRoster(inventory);

    const unknownRequestField = validateCustomRosterSetupRequest({
      request: { ...customRequest(roster), surprise: true },
      inventory,
      now: CUSTOM_NOW,
    });
    assert.equal(unknownRequestField.status, 'failed');
    assert.deepEqual(codes(unknownRequestField), ['ROSTER_CUSTOM_REQUEST_SCHEMA_INVALID']);

    const unknownRosterField = validateCustomRosterSetupRequest({
      request: customRequest(Object.assign({}, roster, { surprise: true })),
      inventory,
      now: CUSTOM_NOW,
    });
    assert.equal(unknownRosterField.status, 'failed');
    assert.deepEqual(codes(unknownRosterField), ['ROSTER_CUSTOM_DRAFT_SCHEMA_INVALID']);

    const badThinkingAssignments = roster.assignments.map((assignment) =>
      assignment.role === 'implement'
        ? rehashAssignment(assignment, { thinking: 'xhigh' })
        : assignment,
    );
    const badThinkingRoster = buildUserCustomRosterFromAssignments({
      slug: 'mixed-plan',
      display_name: 'Mixed plan draft',
      scope: 'user',
      assignments: badThinkingAssignments,
      created_at: CUSTOM_CREATED_AT,
    });
    const badThinking = validateCustomRosterSetupRequest({ request: customRequest(badThinkingRoster), inventory, now: CUSTOM_NOW });
    assert.equal(badThinking.structural_status, 'invalid');
    assert.equal(badThinking.status, 'failed');
    assert.ok(codes(badThinking).includes('ROSTER_CUSTOM_THINKING_UNREGISTERED'));
    assert.equal(badThinking.write_count, 0);
  });

  void it('blocks a perfectly shaped self-hashed custom_roster manifest because the current trust registry is empty', () => {
    const inventory = mixedPlanInventory();
    const roster = mixedCustomRoster(inventory);
    const manifest = selfHashedCustomRosterManifest(roster);
    assert.equal(CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY.trusted_manifest_ids.length, 0);
    assert.equal(CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY.trusted_manifest_sha256s.length, 0);
    assert.equal(CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY.trusted_roster_sha256s.length, 0);

    const verification = verifyCustomRosterManifestForRoster({ roster, manifest, now: CUSTOM_NOW });
    assert.equal(verification.ok, false);
    assert.equal(verification.certification_status, 'untrusted');
    assert.deepEqual(verification.issues.map((issue) => issue.code), ['W5_CUSTOM_MANIFEST_HASH_UNTRUSTED']);

    const result = validateCustomRosterSetupRequest({ request: customRequest(roster, manifest), inventory, now: CUSTOM_NOW });
    assert.equal(result.structural_status, 'structurally-valid-draft');
    assert.equal(result.certification_status, 'untrusted');
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ['ROSTER_CUSTOM_MANIFEST_HASH_UNTRUSTED', 'ROSTER_QUALIFICATION_REQUIRED']);
    assert.equal(result.write_count, 0);
    assert.deepEqual(result.files_touched, []);
  });

  void it('rejects expired and missing-role custom evidence without certifying shaped manifests', () => {
    const inventory = mixedPlanInventory();
    const roster = mixedCustomRoster(inventory);
    const manifest = selfHashedCustomRosterManifest(roster);

    const expired = rehashManifest({
      ...manifest,
      issued_at: '2026-07-20T00:00:00.000Z',
      expires_at: '2026-07-21T00:00:00.000Z',
    });
    const expiredVerification = verifyCustomRosterManifestForRoster({ roster, manifest: expired, now: CUSTOM_NOW });
    assert.equal(expiredVerification.ok, false);
    assert.ok(expiredVerification.issues.some((issue) => issue.code === 'W5_CUSTOM_MANIFEST_TIME_INVALID'));
    assert.ok(expiredVerification.issues.some((issue) => issue.code === 'W5_CUSTOM_MANIFEST_HASH_UNTRUSTED'));

    const wrongRoleEvidence = manifest.role_results.find((entry) => entry.role === 'fix')?.evidence_refs[0];
    if (wrongRoleEvidence === undefined) throw new Error('missing wrong-role evidence');
    const missingRole = rehashManifest({
      ...manifest,
      role_results: manifest.role_results.map((entry) => entry.role === 'implement' ? { ...entry, evidence_refs: [wrongRoleEvidence] } : entry),
    });
    const missingRoleVerification = verifyCustomRosterManifestForRoster({ roster, manifest: missingRole, now: CUSTOM_NOW });
    assert.equal(missingRoleVerification.ok, false);
    assert.ok(missingRoleVerification.issues.some((issue) => issue.code === 'W5_CUSTOM_MANIFEST_ROLE_COVERAGE_MISMATCH'));
    assert.ok(missingRoleVerification.issues.some((issue) => issue.code === 'W5_CUSTOM_MANIFEST_HASH_UNTRUSTED'));
  });

  void it('persists future custom certification authority only at the lower create-only boundary without adding trust', async () => {
    await withTempDir(async (dir) => {
      const inventory = mixedPlanInventory();
      const roster = mixedCustomRoster(inventory);
      const manifest = selfHashedCustomRosterManifest(roster);
      const validation = validateCustomRosterSetupRequest({ request: customRequest(roster, manifest), inventory, now: CUSTOM_NOW });
      assert.equal(validation.certification_status, 'untrusted');

      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot: dir });
      const published = await publishCustomRosterCertificationAuthority({
        paths,
        roster,
        validation_result_sha256: validation.result_sha256,
        manifest,
      });
      assert.equal(published.ok, true);
      assert.equal(published.status, 'published');
      assert.equal(published.write_count, 1);
      assert.equal(published.lock_count, 0);
      assert.equal(published.files_touched.length, 1);

      const read = await readCustomRosterCertificationAuthority({ paths, roster });
      assert.equal(read.ok, true);
      if (!read.ok) throw new Error('authority missing');
      assert.equal(read.authority.roster_sha256, roster.roster_sha256);
      assert.equal(read.authority.validation_result_sha256, validation.result_sha256);
      assert.equal(read.authority.manifest_sha256, manifest.manifest_sha256);

      const replay = await publishCustomRosterCertificationAuthority({ paths, roster, validation_result_sha256: validation.result_sha256, manifest });
      assert.equal(replay.ok, true);
      assert.equal(replay.status, 'inspected');
      assert.equal(replay.write_count, 0);

      const conflicting = await publishCustomRosterCertificationAuthority({
        paths,
        roster,
        validation_result_sha256: validation.result_sha256,
        manifest: rehashManifest({ ...manifest, manifest_id: 'custom-conflict-v1' }),
      });
      assert.equal(conflicting.ok, false);
      assert.equal(conflicting.status, 'blocked');
      assert.equal(conflicting.write_count, 0);
    });
  });

  void it('gives mixed providers zero inherited trust from provider_recipe-shaped manifests', () => {
    const inventory = mixedPlanInventory();
    const roster = mixedCustomRoster(inventory);
    const customManifest = selfHashedCustomRosterManifest(roster);
    const providerRecipeForgery = rehashManifest({
      ...customManifest,
      subject_kind: 'provider_recipe',
      subject_id: 'kimi-coding-plan',
    });

    const verification = verifyCustomRosterManifestForRoster({ roster, manifest: providerRecipeForgery, now: CUSTOM_NOW });
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some((issue) => issue.code === 'W5_CUSTOM_MANIFEST_BINDING_MISMATCH'));
    assert.ok(verification.issues.some((issue) => issue.code === 'W5_CUSTOM_MANIFEST_HASH_UNTRUSTED'));

    const result = validateCustomRosterSetupRequest({ request: customRequest(roster, providerRecipeForgery), inventory, now: CUSTOM_NOW });
    assert.equal(result.mixed_provider_roster, true);
    assert.notEqual(result.certification_status, 'autopilot-certified');
    assert.equal(result.ok, false);
    assert.equal(result.write_count, 0);
  });
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'custom-roster-authority-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function codes(result: CustomResult): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function customRequest(roster: unknown, manifest: QualificationManifest | null = null): Record<string, unknown> {
  return {
    schema_version: CUSTOM_ROSTER_REQUEST_SCHEMA,
    request_id: 'custom-mixed-plan-request',
    scope: 'user',
    natural_language_request: 'Use a mixed Kimi/ZAI plan-token custom roster; do not inherit provider trust.',
    roster,
    qualification_manifest: manifest,
  };
}

function mixedCustomRoster(inventory: RosterInventory): Roster {
  const kimi = seedRosterForRecipe(inventory, 'kimi-coding-plan');
  const zai = seedRosterForRecipe(inventory, 'zai-coding-plan');
  const assignments = ROSTER_ROLE_ORDER.map((role) => {
    const source = role === 'implement' || role === 'fix' || role === 'adjudicate' ? zai : kimi;
    const assignment = source.assignments.find((candidate) => candidate.role === role);
    if (assignment === undefined) throw new Error(`missing role ${role}`);
    return assignment;
  });
  return buildUserCustomRosterFromAssignments({
    slug: 'mixed-plan',
    display_name: 'Mixed plan draft',
    scope: 'user',
    assignments,
    created_at: CUSTOM_CREATED_AT,
  });
}

function seedRosterForRecipe(inventory: RosterInventory, recipeId: string): Roster {
  const proposal = proposeRosterCandidates({ inventory, include_unready: true });
  const candidate = proposal.candidate_set.candidates.find((entry) => entry.recipe_id === recipeId);
  if (candidate === undefined) throw new Error(`missing candidate ${recipeId}`);
  const roster = seedRosterByCandidate(candidate);
  if (roster === null) throw new Error(`missing seed roster ${recipeId}`);
  return roster;
}

function mixedPlanInventory(): RosterInventory {
  return fakeInventoryFromProviders({
    inventory_id: 'inventory-w5-custom-mixed-plan',
    providers: [providerForRecipe(mustRecipe('kimi-coding-plan')), providerForRecipe(mustRecipe('zai-coding-plan'))],
  });
}

function mustRecipe(recipeId: string): ProviderRecipe {
  const recipe = getProviderRecipe(recipeId, 1);
  if (recipe === null) throw new Error(`missing provider recipe ${recipeId}`);
  return recipe;
}

function providerForRecipe(recipe: ProviderRecipe): InventoryProvider {
  const byModel = new Map<string, RoleTemplate[]>();
  for (const profile of recipe.profile_templates) {
    for (const roleTemplate of profile.role_templates) {
      const key = `${roleTemplate.model_id}:${roleTemplate.api}`;
      byModel.set(key, [...(byModel.get(key) ?? []), roleTemplate]);
    }
  }
  return {
    provider_id: recipe.provider_family,
    auth_configured: true,
    auth_class: recipe.provider_family === 'openai-codex' ? 'oauth' : 'api-key-plan-token',
    auth_source: 'stored',
    auth_status: 'configured',
    is_using_oauth: recipe.provider_family === 'openai-codex',
    billing_route_class: recipe.provider_family === 'openai-codex' ? 'subscription-oauth' : 'plan-api-token',
    models: [...byModel.values()].map((templates) => {
      const first = templates[0];
      if (first === undefined) throw new Error('empty model template group');
      return {
        model_id: first.model_id,
        api: first.api,
        context_window: Math.max(...templates.map((template) => template.context_window)),
        max_output_tokens: Math.max(...templates.map((template) => template.max_output_tokens)),
        input_modalities: [...new Set(templates.flatMap((template) => [...template.input_modalities]))].sort(),
        output_modalities: [...new Set(templates.flatMap((template) => [...template.output_modalities]))].sort(),
        reasoning_capability: first.reasoning_capability,
        tool_capability: first.tool_capability,
        thinking_values: [...new Set(templates.map((template) => template.thinking))].sort(),
        service_tiers: [...new Set(templates.map((template) => template.service_tier))].sort((left, right) => {
          if (left === right) return 0;
          if (left === null) return -1;
          if (right === null) return 1;
          return left.localeCompare(right);
        }),
        cache_policies: [...new Set(templates.map((template) => template.cache_policy))].sort(),
        system_prompt_profiles: [...new Set(templates.map((template) => template.system_prompt_profile))].sort(),
      };
    }),
  };
}

function rehashAssignment(assignment: Assignment, patch: Partial<Omit<Assignment, 'assignment_sha256'>>): Assignment {
  const withoutHash = {
    role: patch.role ?? assignment.role,
    provider_id: patch.provider_id ?? assignment.provider_id,
    model_id: patch.model_id ?? assignment.model_id,
    model: patch.model ?? assignment.model,
    api: patch.api ?? assignment.api,
    thinking: patch.thinking ?? assignment.thinking,
    service_tier: patch.service_tier ?? assignment.service_tier,
    cache_policy: patch.cache_policy ?? assignment.cache_policy,
    system_prompt_profile: patch.system_prompt_profile ?? assignment.system_prompt_profile,
    context_window: patch.context_window ?? assignment.context_window,
    max_output_tokens: patch.max_output_tokens ?? assignment.max_output_tokens,
    input_modalities: patch.input_modalities ?? assignment.input_modalities,
    output_modalities: patch.output_modalities ?? assignment.output_modalities,
    reasoning_capability: patch.reasoning_capability ?? assignment.reasoning_capability,
    tool_capability: patch.tool_capability ?? assignment.tool_capability,
    route_policy_id: patch.route_policy_id ?? assignment.route_policy_id,
    route_policy_revision: patch.route_policy_revision ?? assignment.route_policy_revision,
    billing_class: patch.billing_class ?? assignment.billing_class,
    billing_route_class: patch.billing_route_class ?? assignment.billing_route_class,
    auth_class: patch.auth_class ?? assignment.auth_class,
    auth_source: patch.auth_source ?? assignment.auth_source,
    qualification_state: patch.qualification_state ?? assignment.qualification_state,
  } satisfies Omit<Assignment, 'assignment_sha256'>;
  return { ...withoutHash, assignment_sha256: canonicalSha256(withoutHash) };
}

function selfHashedCustomRosterManifest(roster: Roster): QualificationManifest {
  const requiredEvidence = requiredCustomRosterEvidenceRefs(roster);
  const liveEvidence = requiredEvidence.map((ref, index) => liveEvidenceRef(roster, ref, index)).sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
  const withoutHash = {
    schema_version: 'autopilot.certification_manifest.v1' as const,
    manifest_id: 'custom-mixed-plan-w5-qualified-v1',
    manifest_revision: 1,
    subject_kind: 'custom_roster' as const,
    subject_id: roster.roster_id,
    subject_sha256: roster.roster_sha256,
    package_version: PHASE37_PACKAGE_VERSION,
    pi_version: PHASE37_PI_VERSION,
    qualification_state: 'w4-certified-ready' as const,
    role_results: ROSTER_ROLE_ORDER.map((role) => {
      const required = requiredExecutionRef(requiredEvidence, role);
      const live = liveEvidence.find((ref) => ref.evidence_id === required.evidence_id);
      if (live === undefined) throw new Error(`missing live evidence ${role}`);
      return { role, state: 'pass' as const, evidence_refs: [live] };
    }),
    required_evidence: requiredEvidence,
    live_evidence: liveEvidence,
    issued_at: '2026-07-23T00:00:00.000Z',
    expires_at: '2026-08-23T00:00:00.000Z',
  };
  return { ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) };
}

function liveEvidenceRef(roster: Roster, ref: EvidenceRef, index: number): EvidenceRef {
  return {
    ...ref,
    uri: `w3-evidence://phase37/custom-roster/${roster.roster_id}/authenticated/no-fallback/${ref.evidence_id}`,
    sha256: canonicalSha256({ evidence_id: ref.evidence_id, index }),
    byte_count: 1000 + index,
    secret_free: true,
  };
}

function requiredExecutionRef(required: readonly EvidenceRef[], role: RosterRole): EvidenceRef {
  const ref = required.find((entry) => entry.kind === 'execution-proof' && entry.evidence_id.endsWith(`-${role}-proof`));
  if (ref === undefined) throw new Error(`missing required ref ${role}`);
  return ref;
}

function rehashManifest(input: QualificationManifest): QualificationManifest {
  const { manifest_sha256: _oldManifestSha, ...withoutHash } = input;
  return { ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) };
}
