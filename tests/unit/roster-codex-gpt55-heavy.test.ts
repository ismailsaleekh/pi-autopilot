import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODEX_GPT55_HEAVY_CANDIDATE,
  CODEX_GPT55_HEAVY_CANDIDATE_ID,
  CODEX_GPT55_HEAVY_RECIPE,
  CODEX_GPT55_HEAVY_ROSTER,
  proposeRosterCandidates,
} from '../../src/core/roster/provider-recipes.ts';
import { resolveRosterSetupInventoryFromContext } from '../../src/core/roster/setup-context.ts';

const MODELS = [
  {
    provider: 'openai-codex',
    id: 'gpt-5.5',
    api: 'openai-codex-responses',
    reasoning: true,
    thinkingLevelMap: { high: 'high' },
    input: ['text'],
    contextWindow: 256_000,
    maxTokens: 32_768,
  },
  {
    provider: 'openai-codex',
    id: 'gpt-5.6-luna',
    api: 'openai-codex-responses',
    reasoning: true,
    thinkingLevelMap: { high: 'high' },
    input: ['text'],
    contextWindow: 256_000,
    maxTokens: 32_768,
  },
  {
    provider: 'openai-codex',
    id: 'gpt-5.6-sol',
    api: 'openai-codex-responses',
    reasoning: true,
    thinkingLevelMap: { high: 'high', xhigh: 'xhigh' },
    input: ['text'],
    contextWindow: 512_000,
    maxTokens: 65_536,
  },
  {
    provider: 'openai-codex',
    id: 'gpt-5.6-terra',
    api: 'openai-codex-responses',
    reasoning: true,
    thinkingLevelMap: { high: 'high' },
    input: ['text'],
    contextWindow: 512_000,
    maxTokens: 65_536,
  },
] as const;

void describe('Codex GPT-5.5 Heavy roster registration', () => {
  void it('freezes the approved workhorse and critical-role assignments', () => {
    assert.equal(CODEX_GPT55_HEAVY_RECIPE.recipe_id, 'codex-gpt55-heavy-subscription');
    assert.equal(CODEX_GPT55_HEAVY_RECIPE.profile_templates[0]?.selected_by_default, true);
    assert.equal(CODEX_GPT55_HEAVY_ROSTER.roster_id, 'codex-gpt55-heavy-sol-terra-v1');
    assert.equal(CODEX_GPT55_HEAVY_ROSTER.pi_version, '0.82.0');
    assert.deepEqual(CODEX_GPT55_HEAVY_ROSTER.assignments.map((assignment) => [assignment.role, assignment.model_id, assignment.thinking]), [
      ['parent', 'gpt-5.6-sol', 'xhigh'],
      ['strategy', 'gpt-5.6-sol', 'xhigh'],
      ['implement', 'gpt-5.5', 'high'],
      ['validate', 'gpt-5.5', 'high'],
      ['fix', 'gpt-5.5', 'high'],
      ['adjudicate', 'gpt-5.6-terra', 'high'],
      ['bughunt', 'gpt-5.6-sol', 'xhigh'],
      ['extract', 'gpt-5.5', 'high'],
    ]);
    assert.equal(CODEX_GPT55_HEAVY_ROSTER.assignments.every((assignment) => assignment.provider_id === 'openai-codex'), true);
    assert.equal(CODEX_GPT55_HEAVY_ROSTER.assignments.every((assignment) => assignment.auth_class === 'oauth'), true);
    assert.equal(CODEX_GPT55_HEAVY_ROSTER.assignments.every((assignment) => assignment.service_tier === null), true);
    assert.equal(CODEX_GPT55_HEAVY_ROSTER.assignments.every((assignment) => assignment.cache_policy === 'provider-default'), true);
    assert.equal(CODEX_GPT55_HEAVY_ROSTER.assignments.every((assignment) => assignment.system_prompt_profile === 'pi-default.v1'), true);
    assert.equal(CODEX_GPT55_HEAVY_CANDIDATE.launch_readiness, 'not-ready-until-w4');
  });

  void it('resolves from exact OAuth inventory and becomes the recommended Cruise default candidate', async () => {
    const inventory = await resolveRosterSetupInventoryFromContext({
      scope: 'user',
      ctx: {
        modelRegistry: {
          getAll: () => MODELS,
          getProviderAuthStatus: () => ({ configured: true, source: 'stored' }),
          isUsingOAuth: () => true,
        },
      },
      createdAt: '2026-07-25T00:00:00.000Z',
    });
    const proposal = proposeRosterCandidates({ inventory, include_unready: true });
    const recommended = proposal.candidate_set.candidates.find(
      (candidate) => candidate.profile_id === proposal.candidate_set.recommended_profile_id,
    );

    assert.equal(proposal.candidate_set.recommended_profile_id, 'cruise');
    assert.equal(proposal.candidate_set.candidates.some((candidate) => candidate.candidate_id === 'codex-cruise-v1'), true);
    assert.equal(recommended?.candidate_id, CODEX_GPT55_HEAVY_CANDIDATE_ID);
    assert.equal(recommended?.roster_id, 'codex-gpt55-heavy-sol-terra-v1');
    assert.deepEqual(recommended?.diagnostic_codes, ['ROSTER_QUALIFICATION_REQUIRED']);
  });

  void it('rejects non-OAuth Codex auth instead of exposing the subscription candidate', async () => {
    const inventory = await resolveRosterSetupInventoryFromContext({
      scope: 'user',
      ctx: {
        modelRegistry: {
          getAll: () => MODELS,
          getProviderAuthStatus: () => ({ configured: true, source: 'stored' }),
          isUsingOAuth: () => false,
        },
      },
      createdAt: '2026-07-25T00:00:00.000Z',
    });
    const proposal = proposeRosterCandidates({ inventory, include_unready: true });

    assert.equal(proposal.candidate_set.candidates.some((candidate) => candidate.candidate_id === CODEX_GPT55_HEAVY_CANDIDATE_ID), false);
  });
});
