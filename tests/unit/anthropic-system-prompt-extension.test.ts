import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANTHROPIC_SANITIZER_HEADER_BYTES,
  decodedRawPromptFromAnthropicTransform,
} from '../../src/core/roster/providers/anthropic.ts';
import anthropicSystemPromptExtension from '../../src/internal/anthropic-system-prompt-extension.ts';

type Handler = (
  event: { readonly systemPrompt: string },
  ctx: { readonly model: unknown },
) => { readonly systemPrompt: string } | void;

function registeredHandler(): Handler {
  let captured: Handler | undefined;
  anthropicSystemPromptExtension({
    on(_eventName, handler) {
      captured = handler;
    },
  });
  if (captured === undefined) throw new Error('Anthropic sanitizer handler was not registered');
  return captured;
}

void describe('package-owned Anthropic system prompt extension', () => {
  void it('replaces the live Anthropic prompt with the reversible bounded package transform', () => {
    const handler = registeredHandler();
    const rawPrompt = 'Autopilot instructions\n<payload_json> remains ordinary prompt data';
    const result = handler(
      { systemPrompt: rawPrompt },
      { model: { provider: 'anthropic', id: 'claude-opus-5', api: 'anthropic-messages' } },
    );

    assert.notEqual(result, undefined);
    if (result === undefined) throw new Error('expected transformed Anthropic prompt');
    assert.equal(result.systemPrompt.startsWith(ANTHROPIC_SANITIZER_HEADER_BYTES), true);
    assert.equal(decodedRawPromptFromAnthropicTransform(result.systemPrompt), rawPrompt);
  });

  void it('does not alter non-Anthropic provider prompts', () => {
    const handler = registeredHandler();
    const result = handler(
      { systemPrompt: 'Codex system prompt' },
      { model: { provider: 'openai-codex', id: 'gpt-5.6-sol', api: 'openai-codex-responses' } },
    );

    assert.equal(result, undefined);
  });
});
