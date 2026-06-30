export type AutopilotSchemaVersion =
  | 'autopilot.unit_spec.v1'
  | 'autopilot.status.v1'
  | 'autopilot.event.v1'
  | 'autopilot.state.v1'
  | 'autopilot.receipt.v1'
  | 'autopilot.handoff.v1';

export const AUTOPILOT_ROLE_VALUES = [
  'strategy',
  'implement',
  'validate',
  'fix',
  'adjudicate',
  'bughunt',
  'extract',
] as const;
export type AutopilotRole = (typeof AUTOPILOT_ROLE_VALUES)[number];

export const AUTOPILOT_TEMPLATE_VALUES = AUTOPILOT_ROLE_VALUES;
export type AutopilotTemplate = AutopilotRole;

export const AUTOPILOT_THINKING_VALUES = ['high', 'xhigh'] as const;
export type AutopilotThinking = (typeof AUTOPILOT_THINKING_VALUES)[number];

export const AUTOPILOT_VERDICT_VALUES = ['DONE', 'PASS', 'NEEDS_FIX', 'BLOCKED'] as const;
export type AutopilotVerdict = (typeof AUTOPILOT_VERDICT_VALUES)[number];

export const AUTOPILOT_SEVERITY_VALUES = [
  'clean',
  'minor-local',
  'major-local',
  'critical',
] as const;
export type AutopilotSeverity = (typeof AUTOPILOT_SEVERITY_VALUES)[number];

export const AUTOPILOT_COMMAND_STATUS_VALUES = ['passed', 'failed', 'not-run', 'blocked'] as const;
export type AutopilotCommandStatus = (typeof AUTOPILOT_COMMAND_STATUS_VALUES)[number];

export const AUTOPILOT_CONTEXT_GATE_VALUES = ['ok', 'halt', 'unknown'] as const;
export type AutopilotContextGate = (typeof AUTOPILOT_CONTEXT_GATE_VALUES)[number];

export const AUTOPILOT_WORKSTREAM_STATUS_VALUES = ['running', 'paused', 'blocked', 'completed'] as const;
export type AutopilotWorkstreamStatus = (typeof AUTOPILOT_WORKSTREAM_STATUS_VALUES)[number];

export const AUTOPILOT_UNIT_STATE_VALUES = [
  'queued',
  'ready',
  'running',
  'blocked',
  'completed',
  'failed',
] as const;
export type AutopilotUnitState = (typeof AUTOPILOT_UNIT_STATE_VALUES)[number];

export const AUTOPILOT_EVENT_TYPE_VALUES = [
  'state_created',
  'state_updated',
  'unit_spec_created',
  'agent_started',
  'agent_completed',
  'agent_failed',
  'unit_blocked',
  'handoff_written',
  'resume_loaded',
] as const;
export type AutopilotEventType = (typeof AUTOPILOT_EVENT_TYPE_VALUES)[number];

export const AUTOPILOT_HANDOFF_REASON_VALUES = [
  'context-halt',
  'operator-pause',
  'terminal-transfer',
] as const;
export type AutopilotHandoffReason = (typeof AUTOPILOT_HANDOFF_REASON_VALUES)[number];

export type AutopilotSha256Digest = `sha256:${string}`;

export interface AutopilotContextRef {
  readonly path: string;
  readonly purpose: string;
  readonly sha256?: AutopilotSha256Digest;
  readonly byte_count?: number;
}

export interface AutopilotEvidenceRef {
  readonly path: string;
  readonly sha256?: AutopilotSha256Digest;
  readonly byte_count?: number;
  readonly description?: string;
}

export interface AutopilotCommandSummary {
  readonly command: string;
  readonly status: AutopilotCommandStatus;
  readonly exit_code: number | null;
  readonly summary: string;
  readonly evidence_ref?: string;
}

export interface AutopilotFinding {
  readonly id: string;
  readonly severity: Exclude<AutopilotSeverity, 'clean'>;
  readonly path?: string;
  readonly summary: string;
  readonly evidence_refs?: readonly AutopilotEvidenceRef[];
}

export interface AutopilotUnitSpec {
  readonly schema_version: 'autopilot.unit_spec.v1';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly template: AutopilotTemplate;
  readonly attempt: number;
  readonly objective: string;
  readonly cwd: string;
  readonly model: string;
  readonly thinking: AutopilotThinking;
  readonly owned_paths: readonly string[];
  readonly read_only_paths: readonly string[];
  readonly untouchable_paths: readonly string[];
  readonly context_refs: readonly AutopilotContextRef[];
  readonly validation_commands: readonly string[];
  readonly status_output: string;
  readonly receipt_output: string;
  readonly evidence_dir: string;
  readonly stop_boundary: string;
  readonly timeout_seconds?: number;
  readonly render_prompt_snapshot?: boolean;
}

export interface AutopilotStatusEntry {
  readonly schema_version: 'autopilot.status.v1';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly attempt: number;
  readonly verdict: AutopilotVerdict;
  readonly severity: AutopilotSeverity;
  readonly summary: string;
  readonly changed_paths: readonly string[];
  readonly findings: readonly AutopilotFinding[];
  readonly commands: readonly AutopilotCommandSummary[];
  readonly evidence_refs: readonly AutopilotEvidenceRef[];
  readonly report_ref: AutopilotEvidenceRef | null;
  readonly next_action: string;
}

export interface AutopilotEventRow {
  readonly schema_version: 'autopilot.event.v1';
  readonly id: number;
  readonly ts: string;
  readonly event: AutopilotEventType;
  readonly workstream: string;
  readonly unit_id?: string;
  readonly role?: AutopilotRole;
  readonly verdict?: AutopilotVerdict;
  readonly severity?: AutopilotSeverity;
  readonly spec_ref?: string;
  readonly status_ref?: string;
  readonly receipt_ref?: string;
  readonly evidence_ref?: string;
  readonly summary: string;
}

export interface AutopilotStateUnit {
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly state: AutopilotUnitState;
  readonly attempt: number;
  readonly spec_ref?: string;
  readonly status_ref?: string;
  readonly receipt_ref?: string;
  readonly summary: string;
}

export interface AutopilotState {
  readonly schema_version: 'autopilot.state.v1';
  readonly workstream: string;
  readonly updated_at: string;
  readonly status: AutopilotWorkstreamStatus;
  readonly context_gate: {
    readonly gate: AutopilotContextGate;
    readonly percent: number | null;
  };
  readonly last_event_id: number;
  readonly ready_queue: readonly string[];
  readonly running: readonly string[];
  readonly blocked: readonly string[];
  readonly completed: readonly string[];
  readonly units: Readonly<Record<string, AutopilotStateUnit>>;
  readonly operator_questions: readonly string[];
  readonly next_actions: readonly string[];
}

export interface AutopilotReceipt {
  readonly schema_version: 'autopilot.receipt.v1';
  readonly tool_name: 'autopilot_emit_status';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly attempt: number;
  readonly emitted_at: string;
  readonly status_output: string;
  readonly status_sha256: AutopilotSha256Digest;
  readonly schema_sha256: AutopilotSha256Digest;
  readonly tool_call_id: string;
  readonly provider_identity: {
    readonly provider_id: string;
    readonly requested_model_id: string;
    readonly executed_model_id: string;
    readonly api: string;
    readonly thinking_level: string;
  };
  readonly expected_identity_hash: AutopilotSha256Digest;
}

export interface AutopilotHandoff {
  readonly schema_version: 'autopilot.handoff.v1';
  readonly workstream: string;
  readonly written_at: string;
  readonly reason: AutopilotHandoffReason;
  readonly state_ref: string;
  readonly event_tail_ref: string | null;
  readonly status_refs: readonly string[];
  readonly summary: string;
  readonly open_blockers: readonly string[];
  readonly next_actions: readonly string[];
}
