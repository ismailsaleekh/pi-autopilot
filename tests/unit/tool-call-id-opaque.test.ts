import assert from 'node:assert/strict';
import { it } from 'node:test';

import { getAutopilotJsonSchema, parseAutopilotReceipt } from '../../src/core/contracts/index.ts';
import { parseAutopilotChildTerminalAcceptance } from '../../src/core/coordination/terminal-acceptance.ts';
import { CHILD_TERMINAL_ACCEPTANCE_SCHEMA } from '../../src/core/coordination/schemas.ts';

interface JsonRecord { readonly [key: string]: unknown }

// Issue: a valid Codex receipt carries a provider-native tool_call_id of the
// shape `call_…|fc_…`. The receipt parser accepts it as bounded text, but the
// child-terminal acceptance parsed tool_call_id as a strict identifier (which
// rejects `|`), so writeAutopilotChildTerminalAcceptance copied the receipt id
// unchanged and then its own parser rejected it, exiting 31 and quarantining an
// otherwise-valid terminal result. The fix treats tool_call_id as a bounded
// opaque non-empty string in both the runtime parser and the JSON schema while
// retaining exact receipt↔acceptance equality.

const digest = `sha256:${'a'.repeat(64)}` as const;

function acceptance(toolCallId: string): JsonRecord {
  return {
    schema_version: 'autopilot.child_terminal_acceptance.v1', repo_id: 'repo-1', autopilot_id: 'auto-1', workstream: 'work-1', workstream_run: 'run-1',
    unit_id: 'unit-1', role: 'validate', attempt: 2, child_lease_id: 'child-run-1-unit-1-2', verdict: 'NEEDS_FIX', transport_result: 'accepted',
    spec: { ref: 'unit-specs/unit-1.validate.attempt-2.json', sha256: digest }, status: { ref: 'statuses/unit-1.validate.attempt-2.json', sha256: digest },
    receipt: { ref: 'receipts/unit-1.validate.attempt-2.receipt.json', sha256: digest }, audit: { ref: 'execution-audits/unit-1.validate.attempt-2.json', sha256: digest },
    tool_call_id: toolCallId, carrier_status_sha256: digest, audit_disposition: 'zero-change', created_at: '2026-07-14T00:00:00.000Z',
  };
}

function jsonRoundTrip(value: JsonRecord): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

void it('round-trips tool_call_id as truly opaque text without interpreting pipe structure', () => {
  for (const toolCallId of ['call_abc|fc_def', 'call_0123|fc_4567|suffix', 'call_native-id.with.dots|fc_part', '|leading', 'trailing|', 'double||pipe', '|']) {
    const parsed = parseAutopilotChildTerminalAcceptance(jsonRoundTrip(acceptance(toolCallId)));
    assert.equal(parsed.tool_call_id, toolCallId, 'opaque tool_call_id must round-trip unchanged for exact receipt equality');
  }
});

void it('uses Unicode code-point length and rejects empty, non-string, NUL-bearing, and oversized values', () => {
  const exactly200AstralCodePoints = '😀'.repeat(200);
  assert.equal(parseAutopilotChildTerminalAcceptance(jsonRoundTrip(acceptance(exactly200AstralCodePoints))).tool_call_id, exactly200AstralCodePoints);
  assert.throws(() => parseAutopilotChildTerminalAcceptance(jsonRoundTrip(acceptance('😀'.repeat(201)))), /1\.\.200 Unicode code points/u);
  assert.throws(() => parseAutopilotChildTerminalAcceptance(jsonRoundTrip({ ...acceptance('call_1'), tool_call_id: '' })), /1\.\.200 Unicode code points/u);
  assert.throws(() => parseAutopilotChildTerminalAcceptance(jsonRoundTrip({ ...acceptance('call_1'), tool_call_id: 42 })), /opaque string/u);
  assert.throws(() => parseAutopilotChildTerminalAcceptance(jsonRoundTrip({ ...acceptance('call_1'), tool_call_id: `call_${'\u0000'}` })), /must not contain NUL/u);
  assert.throws(() => parseAutopilotChildTerminalAcceptance(jsonRoundTrip({ ...acceptance('call_1'), tool_call_id: `call_${'x'.repeat(200)}` })), /1\.\.200 Unicode code points/u);
});

void it('enforces the identical opaque contract on the forced-output receipt', () => {
  const receipt = {
    schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: 'work-1', unit_id: 'unit-1', role: 'validate', attempt: 2,
    emitted_at: '2026-07-14T00:00:00.000Z', status_output: '/tmp/status.json', status_sha256: digest, schema_sha256: digest,
    tool_call_id: '|opaque||😀', provider_identity: { provider_id: 'openai-codex', requested_model_id: 'openai-codex/gpt-5.6-sol', executed_model_id: 'openai-codex/gpt-5.6-sol', api: 'openai-codex-responses', thinking_level: 'xhigh' }, expected_identity_hash: digest,
  };
  assert.equal(parseAutopilotReceipt(jsonRoundTrip(receipt)).tool_call_id, receipt.tool_call_id);
  assert.equal(parseAutopilotReceipt(jsonRoundTrip({ ...receipt, tool_call_id: '😀'.repeat(200) })).tool_call_id, '😀'.repeat(200));
  assert.throws(() => parseAutopilotReceipt(jsonRoundTrip({ ...receipt, tool_call_id: '😀'.repeat(201) })), /1\.\.200 Unicode code points/u);
  assert.throws(() => parseAutopilotReceipt(jsonRoundTrip({ ...receipt, tool_call_id: `call\u0000id` })), /must not contain NUL/u);
});

void it('admits a provider-native tool_call_id through the closed JSON schema definition', () => {
  const toolCallId = 'call_abc|fc_def';
  // The JSON schema must describe tool_call_id as a bounded opaque string (no
  // identifier pattern) so it cannot drift from the runtime parser. A pipe in a
  // provider-native id must not violate the declared schema shape.
  const properties = CHILD_TERMINAL_ACCEPTANCE_SCHEMA['properties'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  const toolCallIdSchema = properties['tool_call_id'];
  if (toolCallIdSchema === undefined) throw new Error('tool_call_id schema property is missing');
  assert.equal(toolCallIdSchema['type'], 'string');
  assert.equal(toolCallIdSchema?.['minLength'], 1);
  assert.equal(toolCallIdSchema?.['maxLength'], 200);
  assert.equal(toolCallIdSchema['pattern'], '^[^\\u0000]*$', 'tool_call_id schema must reject NUL without interpreting provider structure');

  const receiptSchema = getAutopilotJsonSchema('receipt');
  const receiptProperties = receiptSchema['properties'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  assert.deepEqual(receiptProperties['tool_call_id'], toolCallIdSchema, 'receipt and terminal acceptance must publish one exact opaque contract');
});
