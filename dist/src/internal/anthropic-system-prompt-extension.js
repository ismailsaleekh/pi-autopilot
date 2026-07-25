import { transformAnthropicAutopilotSystemPrompt } from "../core/roster/providers/anthropic.js";
function isAnthropicModel(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const model = value;
    return model['provider'] === 'anthropic' && typeof model['id'] === 'string' && model['id'].startsWith('claude-');
}
export default function anthropicAutopilotSystemPromptExtension(pi) {
    pi.on('before_agent_start', (event, ctx) => {
        if (!isAnthropicModel(ctx.model))
            return;
        const transformed = transformAnthropicAutopilotSystemPrompt(event.systemPrompt);
        if (!transformed.ok) {
            throw new Error(`Anthropic Autopilot system prompt transform failed: ${transformed.diagnostics.map((entry) => entry.code).join(', ')}`);
        }
        return { systemPrompt: transformed.transformed_prompt_bytes_utf8 };
    });
}
