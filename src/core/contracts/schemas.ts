import {
  AUTOPILOT_COMMAND_STATUS_VALUES,
  AUTOPILOT_CONTEXT_GATE_VALUES,
  AUTOPILOT_EVENT_TYPE_VALUES,
  AUTOPILOT_HANDOFF_REASON_VALUES,
  AUTOPILOT_ROLE_VALUES,
  AUTOPILOT_SEVERITY_VALUES,
  AUTOPILOT_TEMPLATE_VALUES,
  AUTOPILOT_THINKING_VALUES,
  AUTOPILOT_UNIT_STATE_VALUES,
  AUTOPILOT_VERDICT_VALUES,
  AUTOPILOT_WORKSTREAM_STATUS_VALUES,
} from './types.ts';

export type JsonMap = Readonly<Record<string, unknown>>;

export const AUTOPILOT_SCHEMA_ID_BASE = 'urn:pi-autopilot:schemas' as const;

const ISO_TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const WORKSTREAM_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
const UNIT_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const NOT_CHAR = '!';
const NEGATIVE_LOOKAHEAD = `(?${NOT_CHAR}`;
const RELATIVE_PATH_PATTERN =
  `^${NEGATIVE_LOOKAHEAD}/)${NEGATIVE_LOOKAHEAD}[A-Za-z]:)${NEGATIVE_LOOKAHEAD}.*(?:^|/)\\.\\.(?:/|$))` +
  `${NEGATIVE_LOOKAHEAD}.*(?:^|/)\\.(?:/|$))${NEGATIVE_LOOKAHEAD}.*\\u0000)${NEGATIVE_LOOKAHEAD}.*\\\\)` +
  '[^\\s][^\\u0000\\\\]{0,511}$';
const ABSOLUTE_PATH_PATTERN =
  `^${NEGATIVE_LOOKAHEAD}.*(?:^|/)\\.\\.(?:/|$))${NEGATIVE_LOOKAHEAD}.*(?:^|/)\\.(?:/|$))` +
  `${NEGATIVE_LOOKAHEAD}.*\\u0000)/(?:[^\\u0000/]+/?)*$`;
const MODEL_PATTERN = `^${NEGATIVE_LOOKAHEAD}openrouter/)${NEGATIVE_LOOKAHEAD}.*\\s)[A-Za-z0-9._/-]{3,120}$`;

const boundedString = (maxLength: number, minLength = 1): JsonMap => ({
  type: 'string',
  minLength,
  maxLength,
});

const enumSchema = (values: readonly string[]): JsonMap => ({
  type: 'string',
  enum: [...values],
});

const relativePathSchema = (): JsonMap => ({
  type: 'string',
  minLength: 1,
  maxLength: 512,
  pattern: RELATIVE_PATH_PATTERN,
});

const absolutePathSchema = (): JsonMap => ({
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  pattern: ABSOLUTE_PATH_PATTERN,
});

const isoTimestampSchema = (): JsonMap => ({
  type: 'string',
  pattern: ISO_TIMESTAMP_PATTERN,
});

const sha256Schema = (): JsonMap => ({
  type: 'string',
  pattern: SHA256_PATTERN,
});

const unitIdSchema = (): JsonMap => ({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: UNIT_ID_PATTERN,
});

const workstreamSchema = (): JsonMap => ({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: WORKSTREAM_PATTERN,
});

const boundedArray = (items: JsonMap, maxItems: number, minItems = 0): JsonMap => ({
  type: 'array',
  minItems,
  maxItems,
  items,
});

const noExtraMap = (properties: Record<string, JsonMap>, required: readonly string[]): JsonMap => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: [...required],
});

export const AUTOPILOT_CONTEXT_REF_JSON_SCHEMA = noExtraMap(
  {
    path: relativePathSchema(),
    purpose: boundedString(240),
    sha256: sha256Schema(),
    byte_count: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
  },
  ['path', 'purpose'],
);

export const AUTOPILOT_EVIDENCE_REF_JSON_SCHEMA = noExtraMap(
  {
    path: relativePathSchema(),
    sha256: sha256Schema(),
    byte_count: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
    description: boundedString(240),
  },
  ['path'],
);

export const AUTOPILOT_COMMAND_SUMMARY_JSON_SCHEMA = noExtraMap(
  {
    command: boundedString(800),
    status: enumSchema(AUTOPILOT_COMMAND_STATUS_VALUES),
    exit_code: { anyOf: [{ type: 'integer', minimum: -1, maximum: 255 }, { type: 'null' }] },
    summary: boundedString(360),
    evidence_ref: relativePathSchema(),
  },
  ['command', 'status', 'exit_code', 'summary'],
);

export const AUTOPILOT_FINDING_JSON_SCHEMA = noExtraMap(
  {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 96,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$',
    },
    severity: enumSchema(['minor-local', 'major-local', 'critical']),
    path: relativePathSchema(),
    summary: boundedString(500),
    evidence_refs: boundedArray(AUTOPILOT_EVIDENCE_REF_JSON_SCHEMA, 12),
  },
  ['id', 'severity', 'summary'],
);

export const AUTOPILOT_UNIT_SPEC_JSON_SCHEMA = {
  $id: `${AUTOPILOT_SCHEMA_ID_BASE}/unit-spec.v1.json`,
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { const: 'autopilot.unit_spec.v1' },
    workstream: workstreamSchema(),
    unit_id: unitIdSchema(),
    role: enumSchema(AUTOPILOT_ROLE_VALUES),
    template: enumSchema(AUTOPILOT_TEMPLATE_VALUES),
    attempt: { type: 'integer', minimum: 1, maximum: 999 },
    objective: boundedString(1200),
    cwd: absolutePathSchema(),
    model: { type: 'string', minLength: 3, maxLength: 120, pattern: MODEL_PATTERN },
    thinking: enumSchema(AUTOPILOT_THINKING_VALUES),
    owned_paths: boundedArray(relativePathSchema(), 120),
    read_only_paths: boundedArray(relativePathSchema(), 200),
    untouchable_paths: boundedArray(relativePathSchema(), 200),
    context_refs: boundedArray(AUTOPILOT_CONTEXT_REF_JSON_SCHEMA, 80),
    validation_commands: boundedArray(boundedString(800), 40),
    status_output: absolutePathSchema(),
    receipt_output: absolutePathSchema(),
    evidence_dir: absolutePathSchema(),
    stop_boundary: boundedString(1200),
    timeout_seconds: { type: 'integer', minimum: 60, maximum: 86_400 },
    render_prompt_snapshot: { type: 'boolean' },
  },
  required: [
    'schema_version',
    'workstream',
    'unit_id',
    'role',
    'template',
    'attempt',
    'objective',
    'cwd',
    'model',
    'thinking',
    'owned_paths',
    'read_only_paths',
    'untouchable_paths',
    'context_refs',
    'validation_commands',
    'status_output',
    'receipt_output',
    'evidence_dir',
    'stop_boundary',
  ],
  allOf: [
    {
      if: { properties: { role: { enum: ['implement', 'fix'] } }, required: ['role'] },
      then: { properties: { owned_paths: { type: 'array', minItems: 1 } } },
    },
    {
      if: { properties: { role: { enum: ['validate', 'bughunt'] } }, required: ['role'] },
      then: { properties: { validation_commands: { type: 'array', minItems: 1 } } },
    },
  ],
} as const satisfies JsonMap;

export const AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA = {
  $id: `${AUTOPILOT_SCHEMA_ID_BASE}/status-entry.v1.json`,
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { const: 'autopilot.status.v1' },
    workstream: workstreamSchema(),
    unit_id: unitIdSchema(),
    role: enumSchema(AUTOPILOT_ROLE_VALUES),
    attempt: { type: 'integer', minimum: 1, maximum: 999 },
    verdict: enumSchema(AUTOPILOT_VERDICT_VALUES),
    severity: enumSchema(AUTOPILOT_SEVERITY_VALUES),
    summary: boundedString(360),
    changed_paths: boundedArray(relativePathSchema(), 120),
    findings: boundedArray(AUTOPILOT_FINDING_JSON_SCHEMA, 80),
    commands: boundedArray(AUTOPILOT_COMMAND_SUMMARY_JSON_SCHEMA, 80),
    evidence_refs: boundedArray(AUTOPILOT_EVIDENCE_REF_JSON_SCHEMA, 80),
    report_ref: { anyOf: [AUTOPILOT_EVIDENCE_REF_JSON_SCHEMA, { type: 'null' }] },
    next_action: boundedString(360),
  },
  required: [
    'schema_version',
    'workstream',
    'unit_id',
    'role',
    'attempt',
    'verdict',
    'severity',
    'summary',
    'changed_paths',
    'findings',
    'commands',
    'evidence_refs',
    'report_ref',
    'next_action',
  ],
  allOf: [
    {
      if: {
        properties: { role: { enum: ['strategy', 'implement', 'fix', 'adjudicate', 'extract'] } },
        required: ['role'],
      },
      then: { properties: { verdict: { enum: ['DONE', 'BLOCKED'] } } },
    },
    {
      if: { properties: { role: { enum: ['validate', 'bughunt'] } }, required: ['role'] },
      then: { properties: { verdict: { enum: ['PASS', 'NEEDS_FIX', 'BLOCKED'] } } },
    },
    {
      if: { properties: { verdict: { enum: ['PASS', 'DONE'] } }, required: ['verdict'] },
      then: {
        properties: { severity: { const: 'clean' }, findings: { type: 'array', maxItems: 0 } },
      },
    },
    {
      if: { properties: { verdict: { enum: ['NEEDS_FIX', 'BLOCKED'] } }, required: ['verdict'] },
      then: { properties: { severity: { enum: ['minor-local', 'major-local', 'critical'] } } },
    },
    {
      if: {
        properties: {
          role: { enum: ['strategy', 'validate', 'adjudicate', 'bughunt', 'extract'] },
        },
        required: ['role'],
      },
      then: { properties: { changed_paths: { type: 'array', maxItems: 0 } } },
    },
  ],
} as const satisfies JsonMap;

export const AUTOPILOT_EVENT_ROW_JSON_SCHEMA = {
  $id: `${AUTOPILOT_SCHEMA_ID_BASE}/event-row.v1.json`,
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { const: 'autopilot.event.v1' },
    id: { type: 'integer', minimum: 1, maximum: 9_000_000_000_000_000 },
    ts: isoTimestampSchema(),
    event: enumSchema(AUTOPILOT_EVENT_TYPE_VALUES),
    workstream: workstreamSchema(),
    unit_id: unitIdSchema(),
    role: enumSchema(AUTOPILOT_ROLE_VALUES),
    verdict: enumSchema(AUTOPILOT_VERDICT_VALUES),
    severity: enumSchema(AUTOPILOT_SEVERITY_VALUES),
    spec_ref: relativePathSchema(),
    status_ref: relativePathSchema(),
    receipt_ref: relativePathSchema(),
    evidence_ref: relativePathSchema(),
    summary: boundedString(360),
  },
  required: ['schema_version', 'id', 'ts', 'event', 'workstream', 'summary'],
  allOf: [
    {
      if: { properties: { event: { const: 'unit_spec_created' } }, required: ['event'] },
      then: {
        properties: {
          unit_id: unitIdSchema(),
          role: enumSchema(AUTOPILOT_ROLE_VALUES),
          spec_ref: relativePathSchema(),
        },
        required: ['unit_id', 'role', 'spec_ref'],
      },
    },
    {
      if: { properties: { event: { const: 'agent_completed' } }, required: ['event'] },
      then: {
        properties: {
          unit_id: unitIdSchema(),
          role: enumSchema(AUTOPILOT_ROLE_VALUES),
          verdict: enumSchema(AUTOPILOT_VERDICT_VALUES),
          status_ref: relativePathSchema(),
        },
        required: ['unit_id', 'role', 'verdict', 'status_ref'],
      },
    },
    {
      if: { properties: { event: { const: 'handoff_written' } }, required: ['event'] },
      then: { properties: { evidence_ref: relativePathSchema() }, required: ['evidence_ref'] },
    },
  ],
} as const satisfies JsonMap;

const stateUnitSchema = noExtraMap(
  {
    unit_id: unitIdSchema(),
    role: enumSchema(AUTOPILOT_ROLE_VALUES),
    state: enumSchema(AUTOPILOT_UNIT_STATE_VALUES),
    attempt: { type: 'integer', minimum: 1, maximum: 999 },
    spec_ref: relativePathSchema(),
    status_ref: relativePathSchema(),
    receipt_ref: relativePathSchema(),
    summary: boundedString(360),
  },
  ['unit_id', 'role', 'state', 'attempt', 'summary'],
);

export const AUTOPILOT_STATE_JSON_SCHEMA = {
  $id: `${AUTOPILOT_SCHEMA_ID_BASE}/state.v1.json`,
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { const: 'autopilot.state.v1' },
    workstream: workstreamSchema(),
    updated_at: isoTimestampSchema(),
    status: enumSchema(AUTOPILOT_WORKSTREAM_STATUS_VALUES),
    context_gate: noExtraMap(
      {
        gate: enumSchema(AUTOPILOT_CONTEXT_GATE_VALUES),
        percent: { anyOf: [{ type: 'number', minimum: 0, maximum: 100 }, { type: 'null' }] },
      },
      ['gate', 'percent'],
    ),
    last_event_id: { type: 'integer', minimum: 0, maximum: 9_000_000_000_000_000 },
    ready_queue: boundedArray(unitIdSchema(), 500),
    running: boundedArray(unitIdSchema(), 500),
    blocked: boundedArray(unitIdSchema(), 500),
    completed: boundedArray(unitIdSchema(), 500),
    units: {
      type: 'object',
      additionalProperties: stateUnitSchema,
      propertyNames: unitIdSchema(),
      maxProperties: 2_000,
    },
    operator_questions: boundedArray(boundedString(500), 80),
    next_actions: boundedArray(boundedString(500), 80),
  },
  required: [
    'schema_version',
    'workstream',
    'updated_at',
    'status',
    'context_gate',
    'last_event_id',
    'ready_queue',
    'running',
    'blocked',
    'completed',
    'units',
    'operator_questions',
    'next_actions',
  ],
} as const satisfies JsonMap;

export const AUTOPILOT_RECEIPT_JSON_SCHEMA = {
  $id: `${AUTOPILOT_SCHEMA_ID_BASE}/receipt.v1.json`,
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { const: 'autopilot.receipt.v1' },
    tool_name: { const: 'autopilot_emit_status' },
    workstream: workstreamSchema(),
    unit_id: unitIdSchema(),
    role: enumSchema(AUTOPILOT_ROLE_VALUES),
    attempt: { type: 'integer', minimum: 1, maximum: 999 },
    emitted_at: isoTimestampSchema(),
    status_output: absolutePathSchema(),
    status_sha256: sha256Schema(),
    schema_sha256: sha256Schema(),
    tool_call_id: boundedString(200),
    provider_identity: noExtraMap(
      {
        provider_id: boundedString(120),
        requested_model_id: boundedString(120),
        executed_model_id: boundedString(120),
        api: boundedString(120),
        thinking_level: boundedString(40),
      },
      ['provider_id', 'requested_model_id', 'executed_model_id', 'api', 'thinking_level'],
    ),
    expected_identity_hash: sha256Schema(),
  },
  required: [
    'schema_version',
    'tool_name',
    'workstream',
    'unit_id',
    'role',
    'attempt',
    'emitted_at',
    'status_output',
    'status_sha256',
    'schema_sha256',
    'tool_call_id',
    'provider_identity',
    'expected_identity_hash',
  ],
} as const satisfies JsonMap;

export const AUTOPILOT_HANDOFF_JSON_SCHEMA = {
  $id: `${AUTOPILOT_SCHEMA_ID_BASE}/handoff.v1.json`,
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { const: 'autopilot.handoff.v1' },
    workstream: workstreamSchema(),
    written_at: isoTimestampSchema(),
    reason: enumSchema(AUTOPILOT_HANDOFF_REASON_VALUES),
    state_ref: relativePathSchema(),
    event_tail_ref: { anyOf: [relativePathSchema(), { type: 'null' }] },
    status_refs: boundedArray(relativePathSchema(), 500),
    summary: boundedString(1000),
    open_blockers: boundedArray(boundedString(500), 80),
    next_actions: boundedArray(boundedString(500), 80),
  },
  required: [
    'schema_version',
    'workstream',
    'written_at',
    'reason',
    'state_ref',
    'event_tail_ref',
    'status_refs',
    'summary',
    'open_blockers',
    'next_actions',
  ],
} as const satisfies JsonMap;

export const AUTOPILOT_JSON_SCHEMAS = Object.freeze({
  unitSpec: AUTOPILOT_UNIT_SPEC_JSON_SCHEMA,
  statusEntry: AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA,
  eventRow: AUTOPILOT_EVENT_ROW_JSON_SCHEMA,
  state: AUTOPILOT_STATE_JSON_SCHEMA,
  receipt: AUTOPILOT_RECEIPT_JSON_SCHEMA,
  handoff: AUTOPILOT_HANDOFF_JSON_SCHEMA,
});
