import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANTHROPIC_OPUS5_SONNET5_CANDIDATE_ID,
  proposeRosterCandidates,
} from '../../src/core/roster/provider-recipes.ts';
import { resolveRosterSetupInventoryFromContext } from '../../src/core/roster/setup-context.ts';

const MODELS = [
  {
    provider: 'anthropic',
    id: 'claude-opus-5',
    api: 'anthropic-messages',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5',
    api: 'anthropic-messages',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
] as const;

void describe('Anthropic Opus 5 / Sonnet 5 roster registration', () => {
  void it('resolves the approved exact Pi model ids into the registered Precision candidate', async () => {
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
    const candidate = proposal.candidate_set.candidates.find((entry) => entry.candidate_id === ANTHROPIC_OPUS5_SONNET5_CANDIDATE_ID);

    assert.notEqual(candidate, undefined);
    assert.equal(candidate?.roster_id, 'anthropic-precision-opus5-sonnet5-v1');
    assert.equal(candidate?.launch_readiness, 'not-ready-until-w4');
    assert.deepEqual(candidate?.diagnostic_codes, ['ROSTER_QUALIFICATION_REQUIRED']);
  });

  void it('does not reuse the registered roster identity when resolved assignment facts differ', async () => {
    const inventory = await resolveRosterSetupInventoryFromContext({
      scope: 'user',
      ctx: {
        modelRegistry: {
          getAll: () => MODELS,
          getProviderAuthStatus: () => ({ configured: true, source: 'runtime' }),
          isUsingOAuth: () => true,
        },
      },
      createdAt: '2026-07-25T00:00:00.000Z',
    });
    const proposal = proposeRosterCandidates({ inventory, include_unready: true });
    const candidate = proposal.candidate_set.candidates.find((entry) => entry.candidate_id === ANTHROPIC_OPUS5_SONNET5_CANDIDATE_ID);

    assert.notEqual(candidate, undefined);
    assert.notEqual(candidate?.assignment_set_sha256, 'sha256:ad709aa7f4ea2f5049eea536926529989cddb475308962dbc3334849b309354c');
    assert.notEqual(candidate?.roster_id, 'anthropic-precision-opus5-sonnet5-v1');
    assert.match(candidate?.roster_id ?? '', /^precision-anthropic-opus5-sonnet5-subscription-[a-f0-9]{12}$/u);
  });

  void it('rejects configured Anthropic API-key auth instead of inferring subscription OAuth', async () => {
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
    const anthropic = inventory.providers.find((provider) => provider.provider_id === 'anthropic');
    const proposal = proposeRosterCandidates({ inventory, include_unready: true });

    assert.equal(anthropic?.auth_class, 'api-key');
    assert.equal(anthropic?.is_using_oauth, false);
    assert.equal(anthropic?.billing_route_class, 'third-party-metered-blocked');
    assert.equal(proposal.candidate_set.candidates.some((entry) => entry.candidate_id === ANTHROPIC_OPUS5_SONNET5_CANDIDATE_ID), false);
  });

  void it('fails closed when either approved model is absent', async () => {
    const inventory = await resolveRosterSetupInventoryFromContext({
      scope: 'user',
      ctx: {
        modelRegistry: {
          getAll: () => MODELS.filter((model) => model.id !== 'claude-opus-5'),
          getProviderAuthStatus: () => ({ configured: true, source: 'stored' }),
          isUsingOAuth: () => true,
        },
      },
      createdAt: '2026-07-25T00:00:00.000Z',
    });
    const proposal = proposeRosterCandidates({ inventory, include_unready: true });

    assert.equal(proposal.candidate_set.candidates.some((entry) => entry.candidate_id === ANTHROPIC_OPUS5_SONNET5_CANDIDATE_ID), false);
  });
});
