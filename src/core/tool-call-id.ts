export const AUTOPILOT_TOOL_CALL_ID_MAX_CODE_POINTS = 200;

/**
 * JSON Schema counts string length in Unicode code points. Keep the runtime on
 * that exact measure instead of JavaScript UTF-16 code units. No normalization
 * is allowed because receipt/acceptance equality binds the provider carrier.
 */
export function opaqueToolCallIdIssue(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be an opaque string';
  const codePoints = Array.from(value).length;
  if (codePoints < 1 || codePoints > AUTOPILOT_TOOL_CALL_ID_MAX_CODE_POINTS) return `must contain 1..${String(AUTOPILOT_TOOL_CALL_ID_MAX_CODE_POINTS)} Unicode code points`;
  if (value.includes('\u0000')) return 'must not contain NUL';
  return null;
}

/** Closed schema shared verbatim by receipt and terminal-acceptance contracts. */
export function opaqueToolCallIdJsonSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'string',
    minLength: 1,
    maxLength: AUTOPILOT_TOOL_CALL_ID_MAX_CODE_POINTS,
    pattern: '^[^\\u0000]*$',
  });
}
