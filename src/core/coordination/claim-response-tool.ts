import { AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME } from '../names.ts';
import type { CoordinationClaimRequest, CoordinationEvidenceRef, CoordinationReleaseCondition, CoordinationReleaseConditionType } from './types.ts';

const COORDINATION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u;
const AUTOMATIC_DEFER_CONDITIONS = ['child-terminal', 'unit-merged', 'attempt-reset', 'quarantine-captured', 'run-closed'] as const satisfies readonly CoordinationReleaseConditionType[];
type AutomaticDeferCondition = (typeof AUTOMATIC_DEFER_CONDITIONS)[number];

export interface ClaimResponseToolParameters {
  readonly request_id: string;
  readonly response: 'release-now' | 'deferred';
  readonly owner_reason: string;
  readonly condition_type?: AutomaticDeferCondition;
  readonly target_id?: string;
  readonly evidence_ref?: string;
  readonly evidence_sha256?: string;
}

export interface ClaimResponseToolDetails {
  readonly schema_version: 'autopilot.claim_response_tool_result.v1';
  readonly request_id: string;
  readonly status: CoordinationClaimRequest['status'];
  readonly owner_reason: string | null;
  readonly release_condition: CoordinationReleaseCondition | null;
  readonly version: number;
}

export interface ClaimResponseToolResult {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly details: ClaimResponseToolDetails;
}

export interface ClaimRequestResponder {
  respondById(input: {
    readonly requestId: string;
    readonly response: 'release-now' | 'deferred';
    readonly ownerReason: string;
    readonly releaseCondition: CoordinationReleaseCondition | null;
  }): Promise<CoordinationClaimRequest>;
}

export interface ClaimResponseToolDefinition {
  readonly name: typeof AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: string,
    params: ClaimResponseToolParameters,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<ClaimResponseToolResult>;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\u0000')) throw new Error(`${field} must be a non-empty string of at most ${String(maximum)} characters`);
  return value.trim();
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maximum);
}

function identifier(value: unknown, field: string): string {
  const text = requiredText(value, field, 192);
  if (!COORDINATION_IDENTIFIER.test(text)) throw new Error(`${field} must be a bounded coordinator identifier`);
  return text;
}

function releaseCondition(params: ClaimResponseToolParameters): CoordinationReleaseCondition | null {
  const conditionType = params.condition_type;
  const targetId = params.target_id === undefined ? undefined : identifier(params.target_id, 'target_id');
  const evidenceRef = optionalText(params.evidence_ref, 'evidence_ref', 2048);
  const evidenceSha256 = optionalText(params.evidence_sha256, 'evidence_sha256', 71);
  if (params.response === 'release-now') {
    if (conditionType !== undefined || targetId !== undefined || evidenceRef !== undefined || evidenceSha256 !== undefined) throw new Error('release-now must not include deferred release-condition fields');
    return null;
  }
  if (conditionType === undefined || !(AUTOMATIC_DEFER_CONDITIONS as readonly string[]).includes(conditionType)) throw new Error(`deferred requires condition_type=${AUTOMATIC_DEFER_CONDITIONS.join('|')}`);
  if (targetId === undefined) throw new Error('deferred requires target_id');
  if ((evidenceRef === undefined) !== (evidenceSha256 === undefined)) throw new Error('deferred evidence_ref and evidence_sha256 must be supplied together');
  if (evidenceSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(evidenceSha256)) throw new Error('evidence_sha256 must be a lowercase sha256 digest');
  const evidence: CoordinationEvidenceRef | null = evidenceRef === undefined || evidenceSha256 === undefined ? null : { ref: evidenceRef, sha256: evidenceSha256 as `sha256:${string}` };
  return { condition_type: conditionType, target_id: targetId, evidence };
}

export function createClaimResponseTool(responder: () => ClaimRequestResponder | null): ClaimResponseToolDefinition {
  return {
    name: AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME,
    label: 'Autopilot Claim Response',
    description: 'Respond as the authenticated durable owner to one current coordinator claim request. Use release-now when the blocking authority is no longer needed, or defer to one typed automatic terminal condition. The coordinator versions the response and atomically releases all request-bound authority.',
    promptSnippet: 'Release or conditionally defer an Autopilot coordinator claim request as its authenticated owner.',
    promptGuidelines: [
      'Use only for the exact request_id delivered by the coordinator to this active Autopilot run.',
      'Prefer release-now as soon as the contested authority is no longer required. Never route an operational claim conflict to operator_questions.',
      'Use deferred only with a real package-observable child, merge, reset, quarantine, or run-close target; never invent evidence or terminal artifacts.',
    ],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        request_id: { type: 'string', minLength: 1, maxLength: 192, pattern: '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$' },
        response: { type: 'string', enum: ['release-now', 'deferred'] },
        owner_reason: { type: 'string', minLength: 1, maxLength: 1024 },
        condition_type: { type: 'string', enum: [...AUTOMATIC_DEFER_CONDITIONS] },
        target_id: { type: 'string', minLength: 1, maxLength: 192, pattern: '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$' },
        evidence_ref: { type: 'string', minLength: 1, maxLength: 2048 },
        evidence_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      },
      required: ['request_id', 'response', 'owner_reason'],
    },
    async execute(_toolCallId, params, signal): Promise<ClaimResponseToolResult> {
      if (signal?.aborted === true) throw new Error('Autopilot claim response was aborted before coordinator mutation');
      const current = responder();
      if (current === null) throw new Error('No authenticated active Autopilot run is attached in this parent session');
      const requestId = identifier(params.request_id, 'request_id');
      const ownerReason = requiredText(params.owner_reason, 'owner_reason', 1024);
      if (params.response !== 'release-now' && params.response !== 'deferred') throw new Error('response must be release-now or deferred');
      const condition = releaseCondition(params);
      const request = await current.respondById({ requestId, response: params.response, ownerReason, releaseCondition: condition });
      const details: ClaimResponseToolDetails = {
        schema_version: 'autopilot.claim_response_tool_result.v1', request_id: request.request_id, status: request.status,
        owner_reason: request.owner_reason, release_condition: request.release_condition, version: request.version,
      };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  };
}
