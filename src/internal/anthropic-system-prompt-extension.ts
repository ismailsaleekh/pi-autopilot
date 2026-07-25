import { transformAnthropicAutopilotSystemPrompt } from '../core/roster/providers/anthropic.ts';

interface AnthropicSanitizerContextLike {
  readonly model: unknown;
}

interface AnthropicSanitizerEventLike {
  readonly systemPrompt: string;
}

interface AnthropicSanitizerExtensionHostLike {
  on(
    eventName: 'before_agent_start',
    handler: (
      event: AnthropicSanitizerEventLike,
      ctx: AnthropicSanitizerContextLike,
    ) => { readonly systemPrompt: string } | void,
  ): void;
}

function isAnthropicModel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const model = value as Readonly<Record<string, unknown>>;
  return model['provider'] === 'anthropic' && typeof model['id'] === 'string' && model['id'].startsWith('claude-');
}

export default function anthropicAutopilotSystemPromptExtension(pi: AnthropicSanitizerExtensionHostLike): void {
  pi.on('before_agent_start', (event, ctx) => {
    if (!isAnthropicModel(ctx.model)) return;
    const transformed = transformAnthropicAutopilotSystemPrompt(event.systemPrompt);
    if (!transformed.ok) {
      throw new Error(`Anthropic Autopilot system prompt transform failed: ${transformed.diagnostics.map((entry) => entry.code).join(', ')}`);
    }
    return { systemPrompt: transformed.transformed_prompt_bytes_utf8 };
  });
}
