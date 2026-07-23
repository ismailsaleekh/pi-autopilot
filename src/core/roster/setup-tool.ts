import { randomBytes } from 'node:crypto';

import {
  assertAutopilotRosterContract,
  parseAutopilotRosterContract,
} from './contracts.ts';
import { launchabilityBlockCodesForCandidates } from './activation-fence.ts';
import { doctorRoleResults, doctorRosterInventory } from './doctor.ts';
import {
  type ProposalResult,
  type QualificationManifest,
  type Roster,
  type RosterCandidate,
  type RosterCandidateSet,
  proposeRosterCandidates,
  validateCandidateSetApproval,
} from './provider-recipes.ts';
import { applyW4ProviderRegistryReadinessToCandidateSet } from './providers/index.ts';
import {
  CUSTOM_ROSTER_INTENT_REQUEST_SCHEMA,
  CUSTOM_ROSTER_TOOL_UNSUPPORTED_DIAGNOSTIC,
  isCustomRosterUnsupportedToolPayload,
  validateCustomRosterIntentSetupRequest,
  verifyCustomRosterManifestForRoster,
  type CustomRosterIntentSetupRequest,
  type CustomRosterIntentValidationResult,
} from './custom-certification.ts';
export {
  CUSTOM_ROSTER_INTENT_REQUEST_SCHEMA,
  CUSTOM_ROSTER_REQUEST_SCHEMA,
  CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA,
  CUSTOM_ROSTER_TOOL_UNSUPPORTED_DIAGNOSTIC,
  buildUserCustomRosterFromAssignments,
  validateCustomRosterSetupRequest,
  validateCustomRosterIntentSetupRequest,
  verifyCustomRosterManifestForRoster,
} from './custom-certification.ts';
export type {
  CustomRosterIntentSetupRequest,
  CustomRosterIntentValidationResult,
  CustomRosterSetupRequest,
  CustomRosterSetupValidationResult,
  CustomRosterManifestVerificationResult,
} from './custom-certification.ts';
import {
  ROSTER_DIAGNOSTIC_CODES,
  ROSTER_PROFILES,
  ROSTER_ROLE_ORDER,
  type Digest,
  type RosterDiagnostic,
  type RosterDiagnosticCode,
  type RosterInventory,
  type RosterScope,
  canonicalSha256,
  normalizeRosterInventory,
  rosterDiagnostic,
} from './route-policies.ts';
import { isProjectTrusted, resolveRosterSetupInventoryFromContext } from './setup-context.ts';

const TOOL_NAME = 'autopilot_manage_rosters' as const;
const REQUEST_SCHEMA = 'autopilot.roster_tool_request.v1' as const;
const RESULT_SCHEMA = 'autopilot.roster_tool_result.v1' as const;
const REQUEST_SCHEMA_V2 = 'autopilot.roster_tool_request.v2' as const;
const RESULT_SCHEMA_V2 = 'autopilot.roster_tool_result.v2' as const;
export const CUSTOM_CANDIDATE_SCHEMA_V2 = 'autopilot.custom_roster_candidate.v2' as const;
export const CUSTOM_PROPOSAL_SCHEMA_V2 = 'autopilot.custom_roster_proposal.v2' as const;
const CUSTOM_APPROVAL_SCHEMA_V2 = 'autopilot.custom_roster_approval.v2' as const;
const CUSTOM_APPROVAL_BINDING_SCHEMA_V2 = 'autopilot.custom_roster_approval_binding.v2' as const;
const CUSTOM_SAVE_RECEIPT_SCHEMA_V2 = 'autopilot.custom_roster_setup_receipt.v2' as const;
const RECEIPT_SCHEMA = 'autopilot.roster_setup_receipt.v1' as const;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/u;
const MAX_CONTENT_BYTES = 48_000;

const INPUT_ACTIONS = ['inspect', 'propose', 'refine', 'save', 'reject', 'doctor'] as const;
const INPUT_ACTIONS_V2 = ['propose-custom', 'save', 'reject'] as const;
type InputAction = (typeof INPUT_ACTIONS)[number];
type InputActionV2 = (typeof INPUT_ACTIONS_V2)[number];
type ResultAction = Exclude<InputAction, 'refine'>;
type ResultActionV2 = InputActionV2;
type ResultStatus = 'inspected' | 'proposed' | 'saved' | 'rejected' | 'blocked' | 'failed';

type ToolDiagnostic = Omit<RosterDiagnostic, 'code'> & { readonly code: string };

type RosterToolReceipt = Record<string, unknown> & {
  readonly schema_version: typeof RECEIPT_SCHEMA;
  readonly scope: RosterScope;
  readonly saved_rosters: readonly {
    readonly roster_id: string;
    readonly roster_revision: number;
    readonly roster_sha256: Digest;
    readonly assignment_set_sha256: Digest;
  }[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
  readonly approved_candidate_set_sha256: Digest;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly config_sha256: Digest;
  readonly original_command: string;
  readonly fresh_session_required: boolean;
  readonly zero_secrets: boolean;
  readonly receipt_sha256: Digest;
};

interface RosterToolResultPreimage {
  readonly schema_version: typeof RESULT_SCHEMA;
  readonly action: ResultAction;
  readonly ok: boolean;
  readonly status: ResultStatus;
  readonly candidate_set: RosterCandidateSet | null;
  readonly receipt: RosterToolReceipt | null;
  readonly diagnostics: readonly ToolDiagnostic[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly string[];
}

type RosterToolResult = RosterToolResultPreimage & { readonly result_sha256: Digest };

export interface CustomRosterCandidateV2 {
  readonly schema_version: typeof CUSTOM_CANDIDATE_SCHEMA_V2;
  readonly candidate_id: string;
  readonly scope: RosterScope;
  readonly profile_id: string;
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly assignment_set_sha256: Digest;
  readonly roster_sha256: Digest;
  readonly inventory_sha256: Digest;
  readonly validation_result_sha256: Digest;
  readonly manifest_sha256: Digest | null;
  readonly validation_status: CustomRosterIntentValidationResult['validation']['status'];
  readonly certification_status: CustomRosterIntentValidationResult['validation']['certification_status'];
  readonly diagnostic_codes: readonly string[];
  readonly custom_candidate_sha256: Digest;
}

export interface CustomRosterProposalV2 {
  readonly schema_version: typeof CUSTOM_PROPOSAL_SCHEMA_V2;
  readonly proposal_id: string;
  readonly scope: RosterScope;
  readonly inventory_sha256: Digest;
  readonly validation_result_sha256: Digest;
  readonly roster_sha256: Digest;
  readonly manifest_sha256: Digest | null;
  readonly custom_candidate: CustomRosterCandidateV2;
  readonly proposal_sha256: Digest;
}

interface CustomRosterApprovalBindingV2 {
  readonly schema_version: typeof CUSTOM_APPROVAL_BINDING_SCHEMA_V2;
  readonly custom_proposal_sha256: Digest;
  readonly validation_result_sha256: Digest;
  readonly roster_sha256: Digest;
  readonly manifest_sha256: Digest | null;
  readonly approval_sha256: Digest;
}

interface CustomRosterApprovalV2 {
  readonly schema_version: typeof CUSTOM_APPROVAL_SCHEMA_V2;
  readonly custom_proposal_sha256: Digest;
  readonly validation_result_sha256: Digest;
  readonly roster_sha256: Digest;
  readonly manifest_sha256: Digest | null;
  readonly approval_sha256: Digest;
}

interface CustomRosterSaveReceiptV2 {
  readonly schema_version: typeof CUSTOM_SAVE_RECEIPT_SCHEMA_V2;
  readonly custom_proposal_sha256: Digest;
  readonly validation_result_sha256: Digest;
  readonly roster_sha256: Digest;
  readonly manifest_sha256: Digest | null;
  readonly approval_sha256: Digest;
  readonly storage_receipt_sha256: Digest | null;
  readonly config_sha256: Digest | null;
  readonly custom_authority_path: string | null;
  readonly custom_authority_sha256: Digest | null;
  readonly zero_secrets: true;
  readonly fresh_session_required: true;
  readonly receipt_sha256: Digest;
}

interface RosterToolResultV2Preimage {
  readonly schema_version: typeof RESULT_SCHEMA_V2;
  readonly action: ResultActionV2;
  readonly ok: boolean;
  readonly status: ResultStatus;
  readonly candidate_set: RosterCandidateSet | null;
  readonly custom_proposal: CustomRosterProposalV2 | null;
  readonly custom_validation: CustomRosterIntentValidationResult['validation'] | null;
  readonly custom_roster: Roster | null;
  readonly approval_binding: CustomRosterApprovalBindingV2 | null;
  readonly receipt: RosterToolReceipt | null;
  readonly custom_receipt: CustomRosterSaveReceiptV2 | null;
  readonly diagnostics: readonly ToolDiagnostic[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly string[];
}

type RosterToolResultV2 = RosterToolResultV2Preimage & { readonly result_sha256: Digest };
type AnyRosterToolResult = RosterToolResult | RosterToolResultV2;

interface RosterToolTextResult {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly details: AnyRosterToolResult;
}

interface RosterToolRequest {
  readonly schema_version: typeof REQUEST_SCHEMA;
  readonly action: InputAction;
  readonly activation_token: string;
  readonly approval_token: string | null;
  readonly scope: RosterScope;
  readonly trusted_project_root: string | null;
  readonly candidate_set_sha256: Digest | null;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string | null;
  readonly default_roster_revision: number | null;
  readonly default_roster_sha256: Digest | null;
  readonly original_command: string;
}

interface RosterToolRequestV2Base {
  readonly schema_version: typeof REQUEST_SCHEMA_V2;
  readonly action: InputActionV2;
  readonly activation_token: string;
  readonly approval_token: string | null;
  readonly scope: RosterScope;
  readonly trusted_project_root: string | null;
  readonly candidate_set_sha256: Digest | null;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string | null;
  readonly default_roster_revision: number | null;
  readonly default_roster_sha256: Digest | null;
  readonly original_command: string;
}

interface RosterToolProposeCustomRequestV2 extends RosterToolRequestV2Base {
  readonly action: 'propose-custom';
  readonly custom_roster_request: unknown;
  readonly custom_roster_approval: null;
}

interface RosterToolSaveCustomRequestV2 extends RosterToolRequestV2Base {
  readonly action: 'save';
  readonly custom_roster_request: null;
  readonly custom_roster_approval: CustomRosterApprovalV2;
}

interface RosterToolRejectCustomRequestV2 extends RosterToolRequestV2Base {
  readonly action: 'reject';
  readonly custom_roster_request: null;
  readonly custom_roster_approval: null;
}

type RosterToolRequestV2 = RosterToolProposeCustomRequestV2 | RosterToolSaveCustomRequestV2 | RosterToolRejectCustomRequestV2;
type AnyRosterToolRequest = RosterToolRequest | RosterToolRequestV2;

interface ApprovalSnapshot {
  readonly approval_token: string;
  readonly activation_token: string;
  readonly schema_version: typeof REQUEST_SCHEMA | typeof REQUEST_SCHEMA_V2;
  readonly scope: RosterScope;
  readonly candidate_set_sha256: Digest;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
  readonly original_command: string;
  readonly presentation_sha256: Digest;
  readonly custom_approval_binding?: CustomRosterApprovalBindingV2 | undefined;
  consumed: boolean;
}

interface ApprovalPresentation extends ControllerApprovalInput {
  readonly schema_version: typeof REQUEST_SCHEMA;
  readonly presentation_text: string;
  readonly presentation_sha256: Digest;
}

interface CustomApprovalPresentation extends ControllerCustomApprovalInput {
  readonly schema_version: typeof REQUEST_SCHEMA_V2;
  readonly presentation_text: string;
  readonly presentation_sha256: Digest;
}

type AnyApprovalPresentation = ApprovalPresentation | CustomApprovalPresentation;

interface ControllerActivationResult {
  readonly ok: boolean;
  readonly active: boolean;
  readonly activation_token: string | null;
  readonly session_id: string | null;
  readonly reason: 'activated' | 'already-active' | 'already-used';
}

export interface RosterSetupApprovalPresentationInput {
  readonly scope: RosterScope;
  readonly candidate_set_sha256: Digest;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
  readonly original_command: string;
}

interface ControllerApprovalInput extends RosterSetupApprovalPresentationInput {
  readonly activation_token: string;
}

interface ControllerCustomApprovalInput extends ControllerApprovalInput {
  readonly custom_proposal_sha256: Digest;
  readonly validation_result_sha256: Digest;
  readonly roster_sha256: Digest;
  readonly manifest_sha256: Digest | null;
  readonly approval_sha256: Digest;
}

interface ControllerApprovalResult {
  readonly ok: boolean;
  readonly approval_token: string | null;
  readonly reason: 'approved' | 'inactive' | 'bad-activation-token' | 'source-not-user' | 'no-current-presentation' | 'duplicate-authorization' | 'stale-or-mismatched-approval';
}

interface RosterSetupController {
  activate(sessionId?: string): ControllerActivationResult;
  deactivate(activationToken: string): boolean;
  isActive(): boolean;
  currentActivationToken(): string | null;
}

interface RosterSetupHostAuthorization {
  currentApprovalPresentation(): AnyApprovalPresentation | null;
  authorizeInput(input: { readonly activation_token: string; readonly source?: string | undefined; readonly text: string }): ControllerApprovalResult;
}

interface SaveCapabilityInput {
  readonly request: AnyRosterToolRequest;
  readonly ctx: unknown;
  readonly candidate_set: RosterCandidateSet;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
  readonly custom_rosters_by_sha256?: ReadonlyMap<Digest, Roster> | undefined;
  readonly custom_roster_bytes_by_sha256?: ReadonlyMap<Digest, Uint8Array> | undefined;
  readonly custom_manifests_by_roster_sha256?: ReadonlyMap<Digest, QualificationManifest> | undefined;
  readonly custom_validation_results_by_roster_sha256?: ReadonlyMap<Digest, CustomRosterIntentValidationResult['validation']> | undefined;
}

interface RememberedCustomProposal {
  readonly request: RosterToolProposeCustomRequestV2;
  readonly intent_request: CustomRosterIntentSetupRequest;
  readonly inventory_sha256: Digest;
  readonly candidate_set: RosterCandidateSet;
  readonly custom_proposal: CustomRosterProposalV2;
  readonly validation_result: CustomRosterIntentValidationResult['validation'];
  readonly roster: Roster;
  readonly roster_bytes: Uint8Array;
  readonly qualification_manifest: QualificationManifest | null;
  readonly manifest_sha256: Digest | null;
  readonly approval_binding: CustomRosterApprovalBindingV2;
}

interface SaveCapabilityResult {
  readonly ok: boolean;
  readonly status: Extract<ResultStatus, 'saved' | 'blocked' | 'failed'>;
  readonly receipt: unknown;
  readonly diagnostics: readonly { readonly code: string; readonly severity?: string; readonly message?: string; readonly remediation?: string; readonly secret_free?: boolean }[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly string[];
  readonly custom_authority_path?: string | null | undefined;
  readonly custom_authority_sha256?: Digest | null | undefined;
}

interface CreateRosterSetupToolOptions {
  readonly inventory?: RosterInventory | ((input: { readonly request: AnyRosterToolRequest; readonly ctx: unknown }) => RosterInventory | Promise<RosterInventory>) | undefined;
  readonly qualificationManifests?: readonly QualificationManifest[] | ((input: { readonly request: AnyRosterToolRequest; readonly ctx: unknown }) => readonly QualificationManifest[] | Promise<readonly QualificationManifest[]>) | undefined;
  readonly saveApproved?: ((input: SaveCapabilityInput) => SaveCapabilityResult | Promise<SaveCapabilityResult>) | undefined;
}

interface RosterSetupToolDefinition {
  readonly name: typeof TOOL_NAME;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<RosterToolTextResult>;
}

const BASE_PARAMETER_PROPERTIES = Object.freeze({
  activation_token: { type: 'string', minLength: 16, maxLength: 200, pattern: TOKEN_PATTERN.source },
  approval_token: { anyOf: [{ type: 'string', minLength: 16, maxLength: 200, pattern: TOKEN_PATTERN.source }, { type: 'null' }] },
  scope: { type: 'string', enum: ['user', 'trusted-project'] },
  trusted_project_root: { anyOf: [{ type: 'string', minLength: 1, maxLength: 4096 }, { type: 'null' }] },
  candidate_set_sha256: { anyOf: [{ type: 'string', minLength: 71, maxLength: 71, pattern: DIGEST_PATTERN.source }, { type: 'null' }] },
  approved_roster_sha256s: { type: 'array', minItems: 0, maxItems: 16, uniqueItems: true, items: { type: 'string', minLength: 71, maxLength: 71, pattern: DIGEST_PATTERN.source } },
  default_roster_id: { anyOf: [{ type: 'string', minLength: 1, maxLength: 96, pattern: '^[a-z][a-z0-9-]{0,95}$' }, { type: 'null' }] },
  default_roster_revision: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
  default_roster_sha256: { anyOf: [{ type: 'string', minLength: 71, maxLength: 71, pattern: DIGEST_PATTERN.source }, { type: 'null' }] },
  original_command: { type: 'string', minLength: 1, maxLength: 4096 },
} as const);

const BASE_PARAMETER_REQUIRED = Object.freeze([
  'schema_version',
  'action',
  'activation_token',
  'approval_token',
  'scope',
  'trusted_project_root',
  'candidate_set_sha256',
  'approved_roster_sha256s',
  'default_roster_id',
  'default_roster_revision',
  'default_roster_sha256',
  'original_command',
] as const);

const DIGEST_PARAMETER_SCHEMA = Object.freeze({ type: 'string', minLength: 71, maxLength: 71, pattern: DIGEST_PATTERN.source } as const);
const NULL_PARAMETER_SCHEMA = Object.freeze({ type: 'null' } as const);
const CUSTOM_ROLE_INTENT_PARAMETER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: [...ROSTER_ROLE_ORDER] },
    provider_id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]{0,63}$' },
    model_id: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$' },
    api: { type: 'string', enum: ['openai-codex-responses', 'anthropic-messages', 'openai-completions'] },
    thinking: { type: 'string', enum: ['high', 'xhigh'] },
    service_tier: { anyOf: [{ type: 'string', enum: ['priority'] }, NULL_PARAMETER_SCHEMA] },
    cache_policy: { type: 'string', enum: ['provider-default', 'none', 'short', 'long'] },
    system_prompt_profile: { type: 'string', enum: ['pi-default.v1', 'anthropic-autopilot-sanitized.v1'] },
  },
  required: ['role', 'provider_id', 'model_id', 'api', 'thinking'],
} as const);
const CUSTOM_ROSTER_INTENT_REQUEST_PARAMETER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'string', enum: [CUSTOM_ROSTER_INTENT_REQUEST_SCHEMA] },
    request_id: { type: 'string', minLength: 1, maxLength: 96, pattern: '^[a-z][a-z0-9-]{0,95}$' },
    natural_language_request: { type: 'string', minLength: 1, maxLength: 16000 },
    profile_id: { type: 'string', enum: ROSTER_PROFILES.map((profile) => profile.profile_id) },
    role_assignment_intent: {
      type: 'array',
      minItems: ROSTER_ROLE_ORDER.length,
      maxItems: ROSTER_ROLE_ORDER.length,
      items: CUSTOM_ROLE_INTENT_PARAMETER_SCHEMA,
    },
    qualification_manifest: { anyOf: [NULL_PARAMETER_SCHEMA, { type: 'object' }] },
  },
  required: ['schema_version', 'request_id', 'natural_language_request', 'profile_id', 'role_assignment_intent', 'qualification_manifest'],
} as const);
const CUSTOM_ROSTER_APPROVAL_PARAMETER_SCHEMA_V2 = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'string', enum: [CUSTOM_APPROVAL_SCHEMA_V2] },
    custom_proposal_sha256: DIGEST_PARAMETER_SCHEMA,
    validation_result_sha256: DIGEST_PARAMETER_SCHEMA,
    roster_sha256: DIGEST_PARAMETER_SCHEMA,
    manifest_sha256: { anyOf: [DIGEST_PARAMETER_SCHEMA, NULL_PARAMETER_SCHEMA] },
    approval_sha256: DIGEST_PARAMETER_SCHEMA,
  },
  required: ['schema_version', 'custom_proposal_sha256', 'validation_result_sha256', 'roster_sha256', 'manifest_sha256', 'approval_sha256'],
} as const);
const PARAMETER_SCHEMA = Object.freeze({
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema_version: { type: 'string', enum: [REQUEST_SCHEMA] },
        action: { type: 'string', enum: [...INPUT_ACTIONS] },
        ...BASE_PARAMETER_PROPERTIES,
      },
      required: BASE_PARAMETER_REQUIRED,
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema_version: { type: 'string', enum: [REQUEST_SCHEMA_V2] },
        action: { type: 'string', enum: ['propose-custom'] },
        ...BASE_PARAMETER_PROPERTIES,
        approval_token: NULL_PARAMETER_SCHEMA,
        candidate_set_sha256: NULL_PARAMETER_SCHEMA,
        approved_roster_sha256s: { type: 'array', minItems: 0, maxItems: 0, uniqueItems: true, items: DIGEST_PARAMETER_SCHEMA },
        default_roster_id: NULL_PARAMETER_SCHEMA,
        default_roster_revision: NULL_PARAMETER_SCHEMA,
        default_roster_sha256: NULL_PARAMETER_SCHEMA,
        custom_roster_request: CUSTOM_ROSTER_INTENT_REQUEST_PARAMETER_SCHEMA,
        custom_roster_approval: NULL_PARAMETER_SCHEMA,
      },
      required: [...BASE_PARAMETER_REQUIRED, 'custom_roster_request', 'custom_roster_approval'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema_version: { type: 'string', enum: [REQUEST_SCHEMA_V2] },
        action: { type: 'string', enum: ['save'] },
        ...BASE_PARAMETER_PROPERTIES,
        approval_token: { type: 'string', minLength: 16, maxLength: 200, pattern: TOKEN_PATTERN.source },
        candidate_set_sha256: DIGEST_PARAMETER_SCHEMA,
        approved_roster_sha256s: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: DIGEST_PARAMETER_SCHEMA },
        default_roster_id: { type: 'string', minLength: 1, maxLength: 96, pattern: '^[a-z][a-z0-9-]{0,95}$' },
        default_roster_revision: { type: 'integer', minimum: 1 },
        default_roster_sha256: DIGEST_PARAMETER_SCHEMA,
        custom_roster_request: NULL_PARAMETER_SCHEMA,
        custom_roster_approval: CUSTOM_ROSTER_APPROVAL_PARAMETER_SCHEMA_V2,
      },
      required: [...BASE_PARAMETER_REQUIRED, 'custom_roster_request', 'custom_roster_approval'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema_version: { type: 'string', enum: [REQUEST_SCHEMA_V2] },
        action: { type: 'string', enum: ['reject'] },
        ...BASE_PARAMETER_PROPERTIES,
        approval_token: NULL_PARAMETER_SCHEMA,
        candidate_set_sha256: NULL_PARAMETER_SCHEMA,
        approved_roster_sha256s: { type: 'array', minItems: 0, maxItems: 0, uniqueItems: true, items: DIGEST_PARAMETER_SCHEMA },
        default_roster_id: NULL_PARAMETER_SCHEMA,
        default_roster_revision: NULL_PARAMETER_SCHEMA,
        default_roster_sha256: NULL_PARAMETER_SCHEMA,
        custom_roster_request: NULL_PARAMETER_SCHEMA,
        custom_roster_approval: NULL_PARAMETER_SCHEMA,
      },
      required: [...BASE_PARAMETER_REQUIRED, 'custom_roster_request', 'custom_roster_approval'],
    },
  ],
} as const);

export function createAutopilotRosterSetupTool(options: CreateRosterSetupToolOptions = {}): {
  readonly tool: RosterSetupToolDefinition;
  readonly controller: RosterSetupController;
  readonly hostAuthorization: RosterSetupHostAuthorization;
} {
  const controller = createController();
  const tool: RosterSetupToolDefinition = {
    name: TOOL_NAME,
    label: 'Autopilot Roster Setup',
    description:
      'Manage Phase 37 Autopilot roster setup pre-run. Inactive until the package activates one setup session; inspect, propose/refine, reject, and doctor are zero-write, save requires host authorization plus exact save bindings.',
    promptSnippet: 'Inspect, propose/refine, reject, doctor, or save Autopilot roster setup with exact hashes and no secrets.',
    promptGuidelines: [
      'Use autopilot_manage_rosters only inside the activated autopilot-roster-setup session and pass its activation_token exactly.',
      'Use autopilot_manage_rosters inspect, propose, refine, doctor, and reject only as zero-write pre-run operations.',
      'Use autopilot_manage_rosters save only after host authorization and semantic user approval; bind candidate_set_sha256, approved_roster_sha256s, default tuple, scope, and original_command exactly.',
      'Do not ask autopilot_manage_rosters to resolve credentials or secrets; treat blocked and converged diagnostics honestly.',
    ],
    parameters: PARAMETER_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<RosterToolTextResult> {
      if (signal?.aborted === true) {
        return textResult(resultForFailure('inspect', 'failed', ['ROSTER_READBACK_MISMATCH']));
      }
      const parsed = parseRequest(params);
      if (!parsed.ok) {
        return textResult(resultForParsedFailure(parsed));
      }
      const request = parsed.request;
      if (!controller.accepts(request.activation_token)) {
        return textResult(resultForRequestFailure(request, 'blocked', ['ROSTER_TRANSITION_REQUIRED']));
      }
      try {
        const result = request.schema_version === REQUEST_SCHEMA_V2
          ? await dispatchRosterToolActionV2({ request, ctx, options, controller })
          : await dispatchRosterToolAction({ request, ctx, options, controller });
        return textResult(result);
      } catch {
        return textResult(resultForRequestFailure(request, 'failed', ['ROSTER_READBACK_MISMATCH']));
      }
    },
  };
  return { tool, controller, hostAuthorization: controller.hostAuthorization };
}

function createController(): RosterSetupController & {
  readonly hostAuthorization: RosterSetupHostAuthorization;
  accepts(token: string): boolean;
  rememberProposal(token: string, request: RosterToolRequest, candidateSet: RosterCandidateSet): void;
  rememberCustomProposal(token: string, request: RosterToolProposeCustomRequestV2, proposal: RememberedCustomProposal): void;
  currentCustomProposal(): RememberedCustomProposal | null;
  invalidateProposal(token: string): void;
  consumeApproval(request: RosterToolRequest, candidateSet: RosterCandidateSet): boolean;
  consumeCustomApproval(request: RosterToolSaveCustomRequestV2, proposal: RememberedCustomProposal): boolean;
} {
  let activationToken: string | null = null;
  let sessionId: string | null = null;
  let everActivated = false;
  let active = false;
  let latestCandidateSet: RosterCandidateSet | null = null;
  let latestCustomProposal: RememberedCustomProposal | null = null;
  let latestPresentation: AnyApprovalPresentation | null = null;
  let presentationAlreadyAuthorized = false;
  const approvals = new Map<string, ApprovalSnapshot>();

  const accepts = (token: string): boolean => active && activationToken !== null && token === activationToken;
  const clearProposal = (): void => {
    latestCandidateSet = null;
    latestCustomProposal = null;
    latestPresentation = null;
    presentationAlreadyAuthorized = false;
    approvals.clear();
  };

  const hostAuthorization: RosterSetupHostAuthorization = {
    currentApprovalPresentation(): AnyApprovalPresentation | null {
      return latestPresentation === null ? null : { ...latestPresentation, approved_roster_sha256s: [...latestPresentation.approved_roster_sha256s] };
    },
    authorizeInput(input): ControllerApprovalResult {
      if (!active || activationToken === null) return { ok: false, approval_token: null, reason: 'inactive' };
      if (input.activation_token !== activationToken) return { ok: false, approval_token: null, reason: 'bad-activation-token' };
      if (!isHostUserInputSource(input.source)) return { ok: false, approval_token: null, reason: 'source-not-user' };
      if (latestCandidateSet === null || latestPresentation === null) return { ok: false, approval_token: null, reason: 'no-current-presentation' };
      if (presentationAlreadyAuthorized) return { ok: false, approval_token: null, reason: 'duplicate-authorization' };
      if (!isBoundedNonEmptyHostInput(input.text) || !approvalMatchesCandidateSet(latestPresentation, latestCandidateSet)) {
        return { ok: false, approval_token: null, reason: 'stale-or-mismatched-approval' };
      }
      const approvalToken = `approval:${randomBytes(24).toString('hex')}`;
      approvals.set(approvalToken, approvalSnapshotFromPresentation(latestPresentation, approvalToken));
      presentationAlreadyAuthorized = true;
      return { ok: true, approval_token: approvalToken, reason: 'approved' };
    },
  };

  return {
    hostAuthorization,
    activate(inputSessionId?: string): ControllerActivationResult {
      if (active) return { ok: false, active: true, activation_token: null, session_id: sessionId, reason: 'already-active' };
      if (everActivated) return { ok: false, active: false, activation_token: null, session_id: sessionId, reason: 'already-used' };
      activationToken = `setup:${randomBytes(24).toString('hex')}`;
      sessionId = inputSessionId ?? `roster-setup-${randomBytes(12).toString('hex')}`;
      everActivated = true;
      active = true;
      clearProposal();
      return { ok: true, active: true, activation_token: activationToken, session_id: sessionId, reason: 'activated' };
    },
    deactivate(token: string): boolean {
      if (!active || token !== activationToken) return false;
      active = false;
      clearProposal();
      return true;
    },
    isActive(): boolean {
      return active;
    },
    currentActivationToken(): string | null {
      return active ? activationToken : null;
    },
    accepts,
    rememberProposal(token: string, request: RosterToolRequest, candidateSet: RosterCandidateSet): void {
      if (!accepts(token)) return;
      latestCandidateSet = candidateSet;
      latestCustomProposal = null;
      latestPresentation = buildApprovalPresentation(request, candidateSet);
      presentationAlreadyAuthorized = false;
      approvals.clear();
    },
    rememberCustomProposal(token: string, _request: RosterToolProposeCustomRequestV2, proposal: RememberedCustomProposal): void {
      if (!accepts(token)) return;
      latestCandidateSet = proposal.candidate_set;
      latestCustomProposal = proposal;
      latestPresentation = buildCustomApprovalPresentation(proposal);
      presentationAlreadyAuthorized = false;
      approvals.clear();
    },
    currentCustomProposal(): RememberedCustomProposal | null {
      return latestCustomProposal;
    },
    invalidateProposal(token: string): void {
      if (!accepts(token)) return;
      clearProposal();
    },
    consumeApproval(request: RosterToolRequest, candidateSet: RosterCandidateSet): boolean {
      if (request.approval_token === null || !accepts(request.activation_token)) return false;
      const approval = approvals.get(request.approval_token);
      if (approval === undefined || approval.consumed) return false;
      if (!approvalMatchesRequest(approval, request)) return false;
      if (!approvalSnapshotMatchesCandidateSet(approval, candidateSet)) return false;
      approval.consumed = true;
      approvals.delete(request.approval_token);
      return true;
    },
    consumeCustomApproval(request: RosterToolSaveCustomRequestV2, proposal: RememberedCustomProposal): boolean {
      if (request.approval_token === null || !accepts(request.activation_token)) return false;
      const approval = approvals.get(request.approval_token);
      if (approval === undefined || approval.consumed) return false;
      if (!approvalMatchesCustomRequest(approval, request, proposal)) return false;
      approval.consumed = true;
      approvals.delete(request.approval_token);
      return true;
    },
  };
}

async function dispatchRosterToolAction(input: {
  readonly request: RosterToolRequest;
  readonly ctx: unknown;
  readonly options: CreateRosterSetupToolOptions;
  readonly controller: ReturnType<typeof createController>;
}): Promise<RosterToolResult> {
  const { request, ctx, options, controller } = input;
  if (request.scope === 'trusted-project' && await trustedProjectBlocked(ctx)) {
    return materializeResult({
      schema_version: RESULT_SCHEMA,
      action: resultActionForInput(request.action),
      ok: false,
      status: request.action === 'save' ? 'blocked' : 'blocked',
      candidate_set: null,
      receipt: null,
      diagnostics: diagnosticsFromCodes([request.action === 'save' ? 'ROSTER_STORAGE_TRUST_REQUIRED' : 'ROSTER_PROJECT_UNTRUSTED']),
      write_count: 0,
      lock_count: 0,
      files_touched: [],
    });
  }

  switch (request.action) {
    case 'inspect':
      return inspectAction(request, ctx, options);
    case 'doctor':
      return doctorAction(request, ctx, options);
    case 'propose':
    case 'refine':
      return proposeAction(request, ctx, options, controller);
    case 'reject':
      return rejectAction(request, controller);
    case 'save':
      return saveAction(request, ctx, options, controller);
  }
}

async function dispatchRosterToolActionV2(input: {
  readonly request: RosterToolRequestV2;
  readonly ctx: unknown;
  readonly options: CreateRosterSetupToolOptions;
  readonly controller: ReturnType<typeof createController>;
}): Promise<RosterToolResultV2> {
  const { request, ctx, options, controller } = input;
  if (request.scope === 'trusted-project' && await trustedProjectBlocked(ctx)) {
    return materializeResultV2({
      schema_version: RESULT_SCHEMA_V2,
      action: request.action,
      ok: false,
      status: 'blocked',
      candidate_set: null,
      custom_proposal: null,
      custom_validation: null,
      custom_roster: null,
      approval_binding: null,
      receipt: null,
      custom_receipt: null,
      diagnostics: diagnosticsFromCodes([request.action === 'save' ? 'ROSTER_STORAGE_TRUST_REQUIRED' : 'ROSTER_PROJECT_UNTRUSTED']),
      write_count: 0,
      lock_count: 0,
      files_touched: [],
    });
  }
  switch (request.action) {
    case 'propose-custom':
      return proposeCustomAction(request, ctx, options, controller);
    case 'reject':
      return rejectActionV2(request, controller);
    case 'save':
      return saveCustomAction(request, ctx, options, controller);
  }
}

async function inspectAction(request: RosterToolRequest, ctx: unknown, options: CreateRosterSetupToolOptions): Promise<RosterToolResult> {
  const inventory = await currentInventory(request, ctx, options);
  const doctor = doctorRosterInventory({ inventory });
  const status: ResultStatus = doctor.status === 'failed' ? 'failed' : doctor.status === 'blocked' ? 'blocked' : 'inspected';
  return materializeResult({
    schema_version: RESULT_SCHEMA,
    action: 'inspect',
    ok: status === 'inspected',
    status,
    candidate_set: null,
    receipt: null,
    diagnostics: diagnosticsFromRoster(doctor.diagnostics),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

async function doctorAction(request: RosterToolRequest, ctx: unknown, options: CreateRosterSetupToolOptions): Promise<RosterToolResult> {
  const inventory = await currentInventory(request, ctx, options);
  const doctor = doctorRosterInventory({ inventory });
  const roleResults = doctorRoleResults({ inventory });
  const roleDiagnostics = roleResults.flatMap((entry) => entry.diagnostics);
  const diagnostics = diagnosticsFromRoster([...doctor.diagnostics, ...roleDiagnostics]);
  const status: ResultStatus = doctor.status === 'failed' ? 'failed' : doctor.status === 'blocked' ? 'blocked' : 'inspected';
  return materializeResult({
    schema_version: RESULT_SCHEMA,
    action: 'doctor',
    ok: status === 'inspected',
    status,
    candidate_set: null,
    receipt: null,
    diagnostics,
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

async function proposeAction(
  request: RosterToolRequest,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
  controller: ReturnType<typeof createController>,
): Promise<RosterToolResult> {
  const proposal = await currentProposal(request, ctx, options);
  controller.rememberProposal(request.activation_token, request, proposal.candidate_set);
  return proposalToResult('propose', proposal);
}

function rejectAction(request: RosterToolRequest, controller: ReturnType<typeof createController>): RosterToolResult {
  controller.invalidateProposal(request.activation_token);
  return materializeResult({
    schema_version: RESULT_SCHEMA,
    action: 'reject',
    ok: true,
    status: 'rejected',
    candidate_set: null,
    receipt: null,
    diagnostics: diagnosticsFromCodes(['ROSTER_PROPOSAL_REJECTED']),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

async function proposeCustomAction(
  request: RosterToolProposeCustomRequestV2,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
  controller: ReturnType<typeof createController>,
): Promise<RosterToolResultV2> {
  const inventory = await currentInventory(request, ctx, options);
  const built = validateCustomRosterIntentSetupRequest({
    request: request.custom_roster_request,
    inventory,
    scope: request.scope,
  });
  if (built.roster === null || built.roster_bytes === null) {
    return materializeResultV2({
      schema_version: RESULT_SCHEMA_V2,
      action: 'propose-custom',
      ok: false,
      status: 'failed',
      candidate_set: null,
      custom_proposal: null,
      custom_validation: built.validation,
      custom_roster: null,
      approval_binding: null,
      receipt: null,
      custom_receipt: null,
      diagnostics: diagnosticsFromExternal(built.validation.diagnostics),
      write_count: 0,
      lock_count: 0,
      files_touched: [],
    });
  }
  if (built.request === null) {
    return materializeResultV2({
      schema_version: RESULT_SCHEMA_V2,
      action: 'propose-custom',
      ok: false,
      status: 'failed',
      candidate_set: null,
      custom_proposal: null,
      custom_validation: built.validation,
      custom_roster: null,
      approval_binding: null,
      receipt: null,
      custom_receipt: null,
      diagnostics: diagnosticsFromExternal(built.validation.diagnostics),
      write_count: 0,
      lock_count: 0,
      files_touched: [],
    });
  }
  const inventorySha256 = normalizeRosterInventory(inventory).inventory_sha256;
  const customProposal = customProposalForValidation({ inventory_sha256: inventorySha256, roster: built.roster, validation: built.validation, manifest_sha256: built.qualification_manifest_sha256 });
  const candidateSet = customCandidateSetForValidation({ inventory, roster: built.roster, custom_proposal: customProposal });
  const approvalBinding = customApprovalBindingForValidation(customProposal, built.validation, built.roster, built.qualification_manifest_sha256);
  const remembered: RememberedCustomProposal = Object.freeze({
    request,
    intent_request: built.request,
    inventory_sha256: inventorySha256,
    candidate_set: candidateSet,
    custom_proposal: customProposal,
    validation_result: built.validation,
    roster: built.roster,
    roster_bytes: built.roster_bytes,
    qualification_manifest: built.qualification_manifest,
    manifest_sha256: built.qualification_manifest_sha256,
    approval_binding: approvalBinding,
  });
  controller.rememberCustomProposal(request.activation_token, request, remembered);
  return materializeResultV2({
    schema_version: RESULT_SCHEMA_V2,
    action: 'propose-custom',
    ok: built.validation.ok,
    status: built.validation.ok ? 'proposed' : built.validation.status === 'failed' ? 'failed' : 'blocked',
    candidate_set: candidateSet,
    custom_proposal: customProposal,
    custom_validation: built.validation,
    custom_roster: built.roster,
    approval_binding: approvalBinding,
    receipt: null,
    custom_receipt: null,
    diagnostics: diagnosticsFromExternal(built.validation.diagnostics),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

function rejectActionV2(request: RosterToolRejectCustomRequestV2, controller: ReturnType<typeof createController>): RosterToolResultV2 {
  controller.invalidateProposal(request.activation_token);
  return materializeResultV2({
    schema_version: RESULT_SCHEMA_V2,
    action: 'reject',
    ok: true,
    status: 'rejected',
    candidate_set: null,
    custom_proposal: null,
    custom_validation: null,
    custom_roster: null,
    approval_binding: null,
    receipt: null,
    custom_receipt: null,
    diagnostics: diagnosticsFromCodes(['ROSTER_PROPOSAL_REJECTED']),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

async function saveAction(
  request: RosterToolRequest,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
  controller: ReturnType<typeof createController>,
): Promise<RosterToolResult> {
  const proposal = await currentProposal(request, ctx, options);
  const candidateSet = proposal.candidate_set;
  if (request.candidate_set_sha256 === null) return saveBlocked(['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
  const approvalDiagnostics = validateCandidateSetApproval(
    candidateSet,
    request.candidate_set_sha256,
    request.approved_roster_sha256s,
  );
  if (approvalDiagnostics.length > 0) return saveBlocked(approvalDiagnostics.map((diagnostic) => diagnostic.code));
  if (!defaultTupleMatches(request, candidateSet)) return saveBlocked(['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
  if (!controller.consumeApproval(request, candidateSet)) return saveBlocked(['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
  const approvedCandidates = candidateSet.candidates.filter((candidate) => request.approved_roster_sha256s.includes(candidate.roster_sha256));
  const launchabilityCodes = launchabilityBlockCodesForCandidates(approvedCandidates);
  if (launchabilityCodes.length > 0) return saveBlocked(launchabilityCodes);
  if (options.saveApproved === undefined) return saveFailed(['ROSTER_READBACK_MISMATCH']);
  try {
    const saved = await options.saveApproved({
      request,
      ctx,
      candidate_set: candidateSet,
      approved_roster_sha256s: request.approved_roster_sha256s,
      default_roster_id: request.default_roster_id ?? '',
      default_roster_revision: request.default_roster_revision ?? 0,
      default_roster_sha256: request.default_roster_sha256 ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    });
    return normalizeSaveCapabilityResult(request, candidateSet, saved);
  } catch {
    return saveFailed(['ROSTER_READBACK_MISMATCH']);
  }
}

async function saveCustomAction(
  request: RosterToolSaveCustomRequestV2,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
  controller: ReturnType<typeof createController>,
): Promise<RosterToolResultV2> {
  const proposal = controller.currentCustomProposal();
  if (proposal === null) return saveBlockedV2(['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
  if (request.candidate_set_sha256 === null) return saveBlockedV2(['ROSTER_APPROVAL_STALE_CANDIDATE_SET'], proposal);
  if (!sameCustomApprovalRequestBinding(request.custom_roster_approval, proposal.approval_binding)) {
    return saveBlockedV2(['ROSTER_APPROVAL_STALE_CANDIDATE_SET'], proposal);
  }

  const freshProposal = await rebuildCustomProposalForSave({ request, ctx, options, proposal });
  if (freshProposal === null || !sameRememberedCustomProposal(proposal, freshProposal)) {
    return saveBlockedV2(['ROSTER_APPROVAL_STALE_CANDIDATE_SET'], proposal);
  }

  const candidateSet = freshProposal.candidate_set;
  const approvalDiagnostics = validateCandidateSetApproval(candidateSet, request.candidate_set_sha256, request.approved_roster_sha256s);
  if (approvalDiagnostics.length > 0) return saveBlockedV2(approvalDiagnostics.map((diagnostic) => diagnostic.code), freshProposal);
  if (!defaultTupleMatches(request, candidateSet)) return saveBlockedV2(['ROSTER_APPROVAL_STALE_CANDIDATE_SET'], freshProposal);
  if (!controller.consumeCustomApproval(request, freshProposal)) return saveBlockedV2(['ROSTER_APPROVAL_STALE_CANDIDATE_SET'], freshProposal);

  const freshVerification = freshProposal.qualification_manifest === null
    ? null
    : verifyCustomRosterManifestForRoster({ roster: freshProposal.roster, manifest: freshProposal.qualification_manifest });
  if (
    freshProposal.validation_result.ok !== true ||
    freshProposal.validation_result.status !== 'certified' ||
    freshVerification?.ok !== true
  ) {
    return saveBlockedV2(['ROSTER_QUALIFICATION_REQUIRED', ...freshProposal.validation_result.diagnostics.map((diagnostic) => diagnostic.code)], freshProposal);
  }
  if (options.saveApproved === undefined) return saveFailedV2(['ROSTER_READBACK_MISMATCH'], freshProposal);
  try {
    const saved = await options.saveApproved({
      request,
      ctx,
      candidate_set: candidateSet,
      approved_roster_sha256s: request.approved_roster_sha256s,
      default_roster_id: request.default_roster_id ?? '',
      default_roster_revision: request.default_roster_revision ?? 0,
      default_roster_sha256: request.default_roster_sha256 ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      custom_rosters_by_sha256: new Map([[freshProposal.roster.roster_sha256, freshProposal.roster]]),
      custom_roster_bytes_by_sha256: new Map([[freshProposal.roster.roster_sha256, freshProposal.roster_bytes]]),
      custom_manifests_by_roster_sha256: freshProposal.qualification_manifest === null ? new Map() : new Map([[freshProposal.roster.roster_sha256, freshProposal.qualification_manifest]]),
      custom_validation_results_by_roster_sha256: new Map([[freshProposal.roster.roster_sha256, freshProposal.validation_result]]),
    });
    return normalizeSaveCapabilityResultV2(request, freshProposal, saved);
  } catch {
    return saveFailedV2(['ROSTER_READBACK_MISMATCH'], freshProposal);
  }
}

async function currentInventory(
  request: AnyRosterToolRequest,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
): Promise<RosterInventory> {
  if (typeof options.inventory === 'function') {
    return normalizeRosterInventory(await options.inventory({ request, ctx }));
  }
  if (options.inventory !== undefined) return normalizeRosterInventory(options.inventory);
  return await resolveRosterSetupInventoryFromContext({ ctx: setupContext(ctx), scope: request.scope });
}

async function rebuildCustomProposalForSave(input: {
  readonly request: RosterToolSaveCustomRequestV2;
  readonly ctx: unknown;
  readonly options: CreateRosterSetupToolOptions;
  readonly proposal: RememberedCustomProposal;
}): Promise<RememberedCustomProposal | null> {
  try {
    const inventory = await currentInventory(input.request, input.ctx, input.options);
    const built = validateCustomRosterIntentSetupRequest({
      request: input.proposal.intent_request,
      inventory,
      scope: input.request.scope,
    });
    if (built.request === null || built.roster === null || built.roster_bytes === null) return null;
    const inventorySha256 = normalizeRosterInventory(inventory).inventory_sha256;
    const customProposal = customProposalForValidation({ inventory_sha256: inventorySha256, roster: built.roster, validation: built.validation, manifest_sha256: built.qualification_manifest_sha256 });
    const candidateSet = customCandidateSetForValidation({ inventory, roster: built.roster, custom_proposal: customProposal });
    const approvalBinding = customApprovalBindingForValidation(customProposal, built.validation, built.roster, built.qualification_manifest_sha256);
    return Object.freeze({
      request: input.proposal.request,
      intent_request: built.request,
      inventory_sha256: inventorySha256,
      candidate_set: candidateSet,
      custom_proposal: customProposal,
      validation_result: built.validation,
      roster: built.roster,
      roster_bytes: built.roster_bytes,
      qualification_manifest: built.qualification_manifest,
      manifest_sha256: built.qualification_manifest_sha256,
      approval_binding: approvalBinding,
    });
  } catch {
    return null;
  }
}

async function currentProposal(
  request: RosterToolRequest,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
): Promise<ProposalResult> {
  const inventory = await currentInventory(request, ctx, options);
  const proposal = proposeRosterCandidates({ inventory, scope: request.scope, include_unready: true });
  const manifests = await currentQualificationManifests(request, ctx, options);
  if (manifests.length === 0) return proposal;
  const candidateSet = applyW4ProviderRegistryReadinessToCandidateSet({
    candidateSet: proposal.candidate_set,
    manifests,
  });
  return proposalWithCandidateSet(proposal, candidateSet);
}

function proposalWithCandidateSet(proposal: ProposalResult, candidateSet: RosterCandidateSet): ProposalResult {
  const diagnostics = diagnosticsForCandidateSet(candidateSet);
  const hasLaunchableReady = candidateSet.candidates.some((candidate) => candidate.launch_readiness === 'w4-certified-ready');
  const hasBlockingRouteOrAuth = diagnostics.some((diagnostic) =>
    diagnostic.code === 'ROSTER_AUTH_REQUIRED' ||
    diagnostic.code === 'ROSTER_AUTH_CHANNEL_FORBIDDEN' ||
    diagnostic.code === 'ROSTER_ROUTE_FORBIDDEN' ||
    diagnostic.code === 'ROSTER_PROJECT_UNTRUSTED' ||
    diagnostic.code === 'ROSTER_RECOMMENDED_PROFILE_BLOCKED' ||
    diagnostic.code === 'ROSTER_EXPLICIT_CHOICE_REQUIRED',
  );
  const ok = hasLaunchableReady && !hasBlockingRouteOrAuth;
  return {
    ...proposal,
    ok,
    status: ok ? 'proposed' : 'blocked',
    candidate_set: candidateSet,
    diagnostics,
  };
}

function diagnosticsForCandidateSet(candidateSet: RosterCandidateSet): readonly RosterDiagnostic[] {
  const codes = uniqueRosterDiagnosticCodes(candidateSet.candidates.flatMap((candidate) => candidate.diagnostic_codes));
  return codes.map((code) => rosterDiagnostic(code));
}

function uniqueRosterDiagnosticCodes(codes: readonly RosterDiagnosticCode[]): readonly RosterDiagnosticCode[] {
  return [...new Set(codes)].sort((left, right) => left.localeCompare(right));
}

async function currentQualificationManifests(
  request: RosterToolRequest,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
): Promise<readonly QualificationManifest[]> {
  if (typeof options.qualificationManifests === 'function') {
    return await options.qualificationManifests({ request, ctx });
  }
  return options.qualificationManifests ?? [];
}

function buildApprovalPresentation(request: RosterToolRequest, candidateSet: RosterCandidateSet): ApprovalPresentation | null {
  const defaultCandidate = candidateSet.candidates.find((candidate) => candidate.profile_id === candidateSet.recommended_profile_id) ?? candidateSet.candidates[0];
  if (defaultCandidate === undefined) return null;
  const input: ControllerApprovalInput = {
    activation_token: request.activation_token,
    scope: request.scope,
    candidate_set_sha256: candidateSet.candidate_set_sha256,
    approved_roster_sha256s: candidateSet.candidates.map((candidate) => candidate.roster_sha256),
    default_roster_id: defaultCandidate.roster_id,
    default_roster_revision: defaultCandidate.roster_revision,
    default_roster_sha256: defaultCandidate.roster_sha256,
    original_command: request.original_command,
  };
  const presentationText = renderRosterSetupApprovalPresentation(input);
  const preimage = {
    schema_version: 'autopilot.roster_approval_presentation.v1' as const,
    scope: input.scope,
    candidate_set_sha256: input.candidate_set_sha256,
    approved_roster_sha256s: input.approved_roster_sha256s,
    default_roster_id: input.default_roster_id,
    default_roster_revision: input.default_roster_revision,
    default_roster_sha256: input.default_roster_sha256,
    original_command: input.original_command,
    presentation_text: presentationText,
  };
  return Object.freeze({ schema_version: REQUEST_SCHEMA, ...input, presentation_text: presentationText, presentation_sha256: canonicalSha256(preimage) });
}

function buildCustomApprovalPresentation(proposal: RememberedCustomProposal): CustomApprovalPresentation | null {
  const candidate = proposal.candidate_set.candidates[0];
  if (candidate === undefined) return null;
  const input: ControllerCustomApprovalInput = {
    activation_token: proposal.request.activation_token,
    scope: proposal.request.scope,
    candidate_set_sha256: proposal.candidate_set.candidate_set_sha256,
    approved_roster_sha256s: [proposal.roster.roster_sha256],
    default_roster_id: proposal.roster.roster_id,
    default_roster_revision: proposal.roster.roster_revision,
    default_roster_sha256: proposal.roster.roster_sha256,
    original_command: proposal.request.original_command,
    custom_proposal_sha256: proposal.custom_proposal.proposal_sha256,
    validation_result_sha256: proposal.validation_result.result_sha256,
    roster_sha256: proposal.roster.roster_sha256,
    manifest_sha256: proposal.manifest_sha256,
    approval_sha256: proposal.approval_binding.approval_sha256,
  };
  const presentationText = renderCustomRosterSetupApprovalPresentation(input);
  const preimage = {
    schema_version: 'autopilot.custom_roster_approval_presentation.v2' as const,
    scope: input.scope,
    candidate_set_sha256: input.candidate_set_sha256,
    approved_roster_sha256s: input.approved_roster_sha256s,
    default_roster_id: input.default_roster_id,
    default_roster_revision: input.default_roster_revision,
    default_roster_sha256: input.default_roster_sha256,
    original_command: input.original_command,
    custom_proposal_sha256: input.custom_proposal_sha256,
    validation_result_sha256: input.validation_result_sha256,
    roster_sha256: input.roster_sha256,
    manifest_sha256: input.manifest_sha256,
    approval_sha256: input.approval_sha256,
    presentation_text: presentationText,
  };
  return Object.freeze({ schema_version: REQUEST_SCHEMA_V2, ...input, presentation_text: presentationText, presentation_sha256: canonicalSha256(preimage) });
}

export function renderRosterSetupApprovalPresentation(input: RosterSetupApprovalPresentationInput): string {
  return [
    'Autopilot roster setup current package-bound approval presentation:',
    `scope: ${input.scope}`,
    `candidate_set_sha256: ${input.candidate_set_sha256}`,
    `approved_roster_sha256s, in proposal order: [${input.approved_roster_sha256s.join(', ')}]`,
    `default_roster_id: ${input.default_roster_id}`,
    `default_roster_revision: ${String(input.default_roster_revision)}`,
    `default_roster_sha256: ${input.default_roster_sha256}`,
    `original_command: ${input.original_command}`,
  ].join('\n');
}

export function renderCustomRosterSetupApprovalPresentation(input: ControllerCustomApprovalInput): string {
  return [
    'Autopilot custom roster setup current package-bound approval presentation v2:',
    'Structural custom validation is not launch-ready unless certification_status is autopilot-certified.',
    `scope: ${input.scope}`,
    `candidate_set_sha256: ${input.candidate_set_sha256}`,
    `approved_roster_sha256s, in proposal order: [${input.approved_roster_sha256s.join(', ')}]`,
    `default_roster_id: ${input.default_roster_id}`,
    `default_roster_revision: ${String(input.default_roster_revision)}`,
    `default_roster_sha256: ${input.default_roster_sha256}`,
    `custom_proposal_sha256: ${input.custom_proposal_sha256}`,
    `validation_result_sha256: ${input.validation_result_sha256}`,
    `roster_sha256: ${input.roster_sha256}`,
    `manifest_sha256: ${input.manifest_sha256 ?? 'null'}`,
    `approval_sha256: ${input.approval_sha256}`,
    `original_command: ${input.original_command}`,
  ].join('\n');
}

function isHostUserInputSource(source: string | undefined): boolean {
  return source === 'user' || source === 'interactive' || source === 'rpc';
}

function isBoundedNonEmptyHostInput(text: string): boolean {
  const byteLength = Buffer.byteLength(text, 'utf8');
  return byteLength > 0 && byteLength <= MAX_CONTENT_BYTES;
}

function customCandidateSetForValidation(input: {
  readonly inventory: RosterInventory;
  readonly roster: Roster;
  readonly custom_proposal: CustomRosterProposalV2;
}): RosterCandidateSet {
  const candidate = customV1CandidateForProposal(input.roster, input.custom_proposal);
  const withoutIdAndHash = {
    schema_version: 'autopilot.roster_candidate_set.v1' as const,
    scope: input.roster.scope,
    inventory_sha256: normalizeRosterInventory(input.inventory).inventory_sha256,
    recipe_registry_sha256: canonicalSha256({
      schema_version: 'autopilot.custom_roster_candidate_set_reference.v2',
      custom_proposal_sha256: input.custom_proposal.proposal_sha256,
    }),
    candidates: [candidate],
    recommended_profile_id: input.roster.profile_id,
    created_at: input.roster.created_at,
  };
  const candidateSetIdHash = canonicalSha256(withoutIdAndHash).slice('sha256:'.length, 'sha256:'.length + 16);
  const withoutHash = {
    ...withoutIdAndHash,
    candidate_set_id: `candidate-set-${candidateSetIdHash}`,
  };
  const candidateSet = { ...withoutHash, candidate_set_sha256: canonicalSha256(withoutHash) };
  return parseAutopilotRosterContract('autopilot.roster_candidate_set.v1', candidateSet) as unknown as RosterCandidateSet;
}

function customV1CandidateForProposal(roster: Roster, proposal: CustomRosterProposalV2): RosterCandidate {
  const routePolicyId = roster.route_policy_ids.length === 1 ? roster.route_policy_ids[0] ?? 'custom-roster-route-v1' : 'custom-roster-mixed-v1';
  const withoutHash = {
    schema_version: 'autopilot.roster_candidate.v1' as const,
    candidate_id: `${roster.profile_id}-${roster.roster_id}`.slice(0, 96),
    candidate_sort_key: `custom:${roster.profile_id}:${roster.roster_id}`,
    scope: roster.scope,
    profile_id: roster.profile_id,
    recipe_id: 'custom-roster',
    recipe_revision: 1,
    route_policy_id: routePolicyId,
    route_policy_revision: 1,
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    assignment_set_sha256: roster.assignment_set_sha256,
    roster_sha256: roster.roster_sha256,
    candidate_state: 'qualification-required' as const,
    launch_readiness: 'not-ready-until-w4' as const,
    qualification_state: 'qualification-required' as const,
    non_certifying_seed: false,
    synthetic_fixture_ready_only: false,
    converges_with: null as string | null,
    diagnostic_codes: ['ROSTER_QUALIFICATION_REQUIRED' as const],
    readiness_authority: null,
    provider_pack_id: null,
    certification_manifest_id: null,
    certification_manifest_sha256: proposal.manifest_sha256,
    recipe_sha256: canonicalSha256({ schema_version: 'autopilot.custom_roster_recipe_reference.v2', custom_proposal_sha256: proposal.proposal_sha256 }),
    route_policy_sha256: canonicalSha256({ schema_version: 'autopilot.custom_roster_route_policy_set.v2', route_policy_ids: roster.route_policy_ids }),
  } satisfies Omit<RosterCandidate, 'candidate_sha256'>;
  return { ...withoutHash, candidate_sha256: canonicalSha256(withoutHash) };
}

function customProposalForValidation(input: {
  readonly inventory_sha256: Digest;
  readonly roster: Roster;
  readonly validation: CustomRosterIntentValidationResult['validation'];
  readonly manifest_sha256: Digest | null;
}): CustomRosterProposalV2 {
  const customCandidate = customCandidateV2ForValidation(input);
  const withoutHash = {
    schema_version: CUSTOM_PROPOSAL_SCHEMA_V2,
    proposal_id: `custom-proposal-${input.roster.roster_sha256.slice('sha256:'.length, 'sha256:'.length + 16)}`,
    scope: input.roster.scope,
    inventory_sha256: input.inventory_sha256,
    validation_result_sha256: input.validation.result_sha256,
    roster_sha256: input.roster.roster_sha256,
    manifest_sha256: input.manifest_sha256,
    custom_candidate: customCandidate,
  } satisfies Omit<CustomRosterProposalV2, 'proposal_sha256'>;
  return Object.freeze({ ...withoutHash, proposal_sha256: canonicalSha256(withoutHash) });
}

function customCandidateV2ForValidation(input: {
  readonly inventory_sha256: Digest;
  readonly roster: Roster;
  readonly validation: CustomRosterIntentValidationResult['validation'];
  readonly manifest_sha256: Digest | null;
}): CustomRosterCandidateV2 {
  const withoutHash = {
    schema_version: CUSTOM_CANDIDATE_SCHEMA_V2,
    candidate_id: `${input.roster.profile_id}-${input.roster.roster_id}`.slice(0, 96),
    scope: input.roster.scope,
    profile_id: input.roster.profile_id,
    roster_id: input.roster.roster_id,
    roster_revision: input.roster.roster_revision,
    assignment_set_sha256: input.roster.assignment_set_sha256,
    roster_sha256: input.roster.roster_sha256,
    inventory_sha256: input.inventory_sha256,
    validation_result_sha256: input.validation.result_sha256,
    manifest_sha256: input.manifest_sha256,
    validation_status: input.validation.status,
    certification_status: input.validation.certification_status,
    diagnostic_codes: uniqueSortedStrings(input.validation.diagnostics.map((diagnostic) => diagnostic.code)),
  } satisfies Omit<CustomRosterCandidateV2, 'custom_candidate_sha256'>;
  return Object.freeze({ ...withoutHash, custom_candidate_sha256: canonicalSha256(withoutHash) });
}

function customApprovalBindingForValidation(proposal: CustomRosterProposalV2, validation: CustomRosterIntentValidationResult['validation'], roster: Roster, manifestSha256: Digest | null): CustomRosterApprovalBindingV2 {
  const approvalSha256 = customApprovalSha256({
    custom_proposal_sha256: proposal.proposal_sha256,
    validation_result_sha256: validation.result_sha256,
    roster_sha256: roster.roster_sha256,
    manifest_sha256: manifestSha256,
  });
  return Object.freeze({
    schema_version: CUSTOM_APPROVAL_BINDING_SCHEMA_V2,
    custom_proposal_sha256: proposal.proposal_sha256,
    validation_result_sha256: validation.result_sha256,
    roster_sha256: roster.roster_sha256,
    manifest_sha256: manifestSha256,
    approval_sha256: approvalSha256,
  });
}

function customApprovalSha256(input: Omit<CustomRosterApprovalV2, 'schema_version' | 'approval_sha256'>): Digest {
  return canonicalSha256({ schema_version: CUSTOM_APPROVAL_SCHEMA_V2, ...input });
}

function customSaveReceiptV2(input: {
  readonly request: RosterToolSaveCustomRequestV2;
  readonly proposal: RememberedCustomProposal;
  readonly receipt: RosterToolReceipt;
  readonly saved: SaveCapabilityResult;
}): CustomRosterSaveReceiptV2 {
  const withoutHash = {
    schema_version: CUSTOM_SAVE_RECEIPT_SCHEMA_V2,
    custom_proposal_sha256: input.proposal.custom_proposal.proposal_sha256,
    validation_result_sha256: input.proposal.validation_result.result_sha256,
    roster_sha256: input.proposal.roster.roster_sha256,
    manifest_sha256: input.proposal.manifest_sha256,
    approval_sha256: input.proposal.approval_binding.approval_sha256,
    storage_receipt_sha256: input.receipt.receipt_sha256,
    config_sha256: input.receipt.config_sha256,
    custom_authority_path: input.saved.custom_authority_path ?? null,
    custom_authority_sha256: input.saved.custom_authority_sha256 ?? null,
    zero_secrets: true as const,
    fresh_session_required: true as const,
  } satisfies Omit<CustomRosterSaveReceiptV2, 'receipt_sha256'>;
  return Object.freeze({ ...withoutHash, receipt_sha256: canonicalSha256(withoutHash) });
}

function proposalToResult(action: ResultAction, proposal: ProposalResult): RosterToolResult {
  return materializeResult({
    schema_version: RESULT_SCHEMA,
    action,
    ok: proposal.ok,
    status: proposal.status,
    candidate_set: proposal.candidate_set,
    receipt: null,
    diagnostics: diagnosticsFromRoster(proposal.diagnostics),
    write_count: proposal.write_count,
    lock_count: proposal.lock_count,
    files_touched: proposal.files_touched,
  });
}

function saveBlocked(codes: readonly string[]): RosterToolResult {
  return materializeResult({
    schema_version: RESULT_SCHEMA,
    action: 'save',
    ok: false,
    status: 'blocked',
    candidate_set: null,
    receipt: null,
    diagnostics: diagnosticsFromCodes(codes),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

function saveBlockedV2(codes: readonly string[], proposal: RememberedCustomProposal | null = null): RosterToolResultV2 {
  return materializeResultV2({
    schema_version: RESULT_SCHEMA_V2,
    action: 'save',
    ok: false,
    status: 'blocked',
    candidate_set: null,
    custom_proposal: proposal?.custom_proposal ?? null,
    custom_validation: proposal?.validation_result ?? null,
    custom_roster: null,
    approval_binding: proposal?.approval_binding ?? null,
    receipt: null,
    custom_receipt: null,
    diagnostics: diagnosticsFromCodes(codes),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

function saveFailed(codes: readonly string[]): RosterToolResult {
  return materializeResult({
    schema_version: RESULT_SCHEMA,
    action: 'save',
    ok: false,
    status: 'failed',
    candidate_set: null,
    receipt: null,
    diagnostics: diagnosticsFromCodes(codes),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

function saveFailedV2(codes: readonly string[], proposal: RememberedCustomProposal | null = null): RosterToolResultV2 {
  return materializeResultV2({
    schema_version: RESULT_SCHEMA_V2,
    action: 'save',
    ok: false,
    status: 'failed',
    candidate_set: null,
    custom_proposal: proposal?.custom_proposal ?? null,
    custom_validation: proposal?.validation_result ?? null,
    custom_roster: null,
    approval_binding: proposal?.approval_binding ?? null,
    receipt: null,
    custom_receipt: null,
    diagnostics: diagnosticsFromCodes(codes),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

function normalizeSaveCapabilityResult(
  request: RosterToolRequest,
  candidateSet: RosterCandidateSet,
  saved: SaveCapabilityResult,
): RosterToolResult {
  const diagnostics = diagnosticsFromExternal(saved.diagnostics);
  const filesTouched = uniqueSortedStrings(saved.files_touched.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096));
  const writeCount = nonNegativeInteger(saved.write_count);
  const lockCount = nonNegativeInteger(saved.lock_count);
  if (saved.ok && saved.status === 'saved') {
    const receipt = parseReceipt(saved.receipt);
    if (receipt === null || !receiptMatchesSave(request, candidateSet, receipt)) {
      return materializeResult({
        schema_version: RESULT_SCHEMA,
        action: 'save',
        ok: false,
        status: 'failed',
        candidate_set: null,
        receipt: null,
        diagnostics: diagnosticsFromCodes(['ROSTER_READBACK_MISMATCH']),
        write_count: writeCount,
        lock_count: lockCount,
        files_touched: filesTouched,
      });
    }
    return materializeResult({
      schema_version: RESULT_SCHEMA,
      action: 'save',
      ok: true,
      status: 'saved',
      candidate_set: null,
      receipt,
      diagnostics,
      write_count: writeCount,
      lock_count: lockCount,
      files_touched: filesTouched,
    });
  }
  const status = saved.status === 'blocked' ? 'blocked' : 'failed';
  return materializeResult({
    schema_version: RESULT_SCHEMA,
    action: 'save',
    ok: false,
    status,
    candidate_set: null,
    receipt: null,
    diagnostics: diagnostics.length === 0 ? diagnosticsFromCodes(['ROSTER_READBACK_MISMATCH']) : diagnostics,
    write_count: writeCount,
    lock_count: lockCount,
    files_touched: filesTouched,
  });
}

function normalizeSaveCapabilityResultV2(
  request: RosterToolSaveCustomRequestV2,
  proposal: RememberedCustomProposal,
  saved: SaveCapabilityResult,
): RosterToolResultV2 {
  const diagnostics = diagnosticsFromExternal(saved.diagnostics);
  const filesTouched = uniqueSortedStrings(saved.files_touched.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096));
  const writeCount = nonNegativeInteger(saved.write_count);
  const lockCount = nonNegativeInteger(saved.lock_count);
  if (saved.ok && saved.status === 'saved') {
    const receipt = parseReceipt(saved.receipt);
    if (receipt === null || !receiptMatchesSave(request, proposal.candidate_set, receipt)) {
      return saveFailedV2(['ROSTER_READBACK_MISMATCH'], proposal);
    }
    const customReceipt = customSaveReceiptV2({ request, proposal, receipt, saved });
    return materializeResultV2({
      schema_version: RESULT_SCHEMA_V2,
      action: 'save',
      ok: true,
      status: 'saved',
      candidate_set: null,
      custom_proposal: proposal.custom_proposal,
      custom_validation: proposal.validation_result,
      custom_roster: null,
      approval_binding: proposal.approval_binding,
      receipt,
      custom_receipt: customReceipt,
      diagnostics,
      write_count: writeCount,
      lock_count: lockCount,
      files_touched: filesTouched,
    });
  }
  const status = saved.status === 'blocked' ? 'blocked' : 'failed';
  return materializeResultV2({
    schema_version: RESULT_SCHEMA_V2,
    action: 'save',
    ok: false,
    status,
    candidate_set: null,
    custom_proposal: proposal.custom_proposal,
    custom_validation: proposal.validation_result,
    custom_roster: null,
    approval_binding: proposal.approval_binding,
    receipt: null,
    custom_receipt: null,
    diagnostics: diagnostics.length === 0 ? diagnosticsFromCodes(['ROSTER_READBACK_MISMATCH']) : diagnostics,
    write_count: writeCount,
    lock_count: lockCount,
    files_touched: filesTouched,
  });
}

function parseReceipt(value: unknown): RosterToolReceipt | null {
  try {
    return parseAutopilotRosterContract(RECEIPT_SCHEMA, value) as unknown as RosterToolReceipt;
  } catch {
    return null;
  }
}

function receiptMatchesSave(request: RosterToolRequest | RosterToolSaveCustomRequestV2, candidateSet: RosterCandidateSet, receipt: RosterToolReceipt): boolean {
  if (request.candidate_set_sha256 === null || request.default_roster_id === null || request.default_roster_revision === null || request.default_roster_sha256 === null) return false;
  if (receipt.scope !== request.scope) return false;
  if (receipt.approved_candidate_set_sha256 !== request.candidate_set_sha256) return false;
  if (!sameStrings(receipt.approved_roster_sha256s, request.approved_roster_sha256s)) return false;
  if (receipt.default_roster_id !== request.default_roster_id || receipt.default_roster_revision !== request.default_roster_revision || receipt.default_roster_sha256 !== request.default_roster_sha256) return false;
  if (receipt.original_command !== request.original_command) return false;
  if (receipt.fresh_session_required !== true || receipt.zero_secrets !== true) return false;
  const matches = receipt.saved_rosters.filter((ref) => ref.roster_id === receipt.default_roster_id && ref.roster_revision === receipt.default_roster_revision && ref.roster_sha256 === receipt.default_roster_sha256);
  if (matches.length !== 1) return false;
  return approvedRosterSha256sMatchCandidateSubset(candidateSet, request.approved_roster_sha256s);
}

function defaultTupleMatches(request: RosterToolRequest | RosterToolSaveCustomRequestV2, candidateSet: RosterCandidateSet): boolean {
  if (request.default_roster_id === null || request.default_roster_revision === null || request.default_roster_sha256 === null) return false;
  const matches = candidateSet.candidates.filter((candidate) =>
    candidate.roster_id === request.default_roster_id &&
    candidate.roster_revision === request.default_roster_revision &&
    candidate.roster_sha256 === request.default_roster_sha256,
  );
  return matches.length === 1 && request.approved_roster_sha256s.includes(request.default_roster_sha256);
}

function approvalSnapshotFromPresentation(presentation: AnyApprovalPresentation, approvalToken: string): ApprovalSnapshot {
  return {
    approval_token: approvalToken,
    activation_token: presentation.activation_token,
    schema_version: presentation.schema_version,
    scope: presentation.scope,
    candidate_set_sha256: presentation.candidate_set_sha256,
    approved_roster_sha256s: [...presentation.approved_roster_sha256s],
    default_roster_id: presentation.default_roster_id,
    default_roster_revision: presentation.default_roster_revision,
    default_roster_sha256: presentation.default_roster_sha256,
    original_command: presentation.original_command,
    presentation_sha256: presentation.presentation_sha256,
    ...(presentation.schema_version === REQUEST_SCHEMA_V2 ? { custom_approval_binding: customApprovalBindingFromPresentation(presentation) } : {}),
    consumed: false,
  };
}

function customApprovalBindingFromPresentation(presentation: CustomApprovalPresentation): CustomRosterApprovalBindingV2 {
  return Object.freeze({
    schema_version: CUSTOM_APPROVAL_BINDING_SCHEMA_V2,
    custom_proposal_sha256: presentation.custom_proposal_sha256,
    validation_result_sha256: presentation.validation_result_sha256,
    roster_sha256: presentation.roster_sha256,
    manifest_sha256: presentation.manifest_sha256,
    approval_sha256: presentation.approval_sha256,
  });
}

function approvalMatchesCandidateSet(input: ControllerApprovalInput, candidateSet: RosterCandidateSet): boolean {
  if (candidateSet.candidate_set_sha256 !== input.candidate_set_sha256) return false;
  if (validateCandidateSetApproval(candidateSet, input.candidate_set_sha256, input.approved_roster_sha256s).length > 0) return false;
  const matches = candidateSet.candidates.filter((candidate) =>
    candidate.roster_id === input.default_roster_id &&
    candidate.roster_revision === input.default_roster_revision &&
    candidate.roster_sha256 === input.default_roster_sha256,
  );
  return matches.length === 1 && input.approved_roster_sha256s.includes(input.default_roster_sha256);
}

function approvalMatchesRequest(approval: ApprovalSnapshot, request: RosterToolRequest): boolean {
  return approval.schema_version === REQUEST_SCHEMA &&
    request.candidate_set_sha256 === approval.candidate_set_sha256 &&
    request.scope === approval.scope &&
    request.default_roster_id === approval.default_roster_id &&
    request.default_roster_revision === approval.default_roster_revision &&
    request.default_roster_sha256 === approval.default_roster_sha256 &&
    request.original_command === approval.original_command &&
    approvedRosterSha256sPreservePresentedOrder(approval.approved_roster_sha256s, request.approved_roster_sha256s);
}

function approvalMatchesCustomRequest(approval: ApprovalSnapshot, request: RosterToolSaveCustomRequestV2, proposal: RememberedCustomProposal): boolean {
  if (approval.schema_version !== REQUEST_SCHEMA_V2) return false;
  if (approval.custom_approval_binding === undefined) return false;
  if (request.candidate_set_sha256 !== approval.candidate_set_sha256 || proposal.candidate_set.candidate_set_sha256 !== approval.candidate_set_sha256) return false;
  if (request.scope !== approval.scope || request.original_command !== approval.original_command) return false;
  if (request.default_roster_id !== approval.default_roster_id || request.default_roster_revision !== approval.default_roster_revision || request.default_roster_sha256 !== approval.default_roster_sha256) return false;
  if (!approvedRosterSha256sPreservePresentedOrder(approval.approved_roster_sha256s, request.approved_roster_sha256s)) return false;
  if (!sameCustomApprovalBinding(approval.custom_approval_binding, proposal.approval_binding)) return false;
  return sameCustomApprovalRequestBinding(request.custom_roster_approval, proposal.approval_binding);
}

function approvalSnapshotMatchesCandidateSet(approval: ApprovalSnapshot, candidateSet: RosterCandidateSet): boolean {
  return candidateSet.candidate_set_sha256 === approval.candidate_set_sha256 &&
    approval.default_roster_id.length > 0 &&
    candidateSet.candidates.some((candidate) =>
      candidate.roster_id === approval.default_roster_id &&
      candidate.roster_revision === approval.default_roster_revision &&
      candidate.roster_sha256 === approval.default_roster_sha256,
    ) &&
    approvedRosterSha256sPreservePresentedOrder(
      candidateSet.candidates.map((candidate) => candidate.roster_sha256),
      approval.approved_roster_sha256s,
    );
}

function sameCustomApprovalBinding(left: CustomRosterApprovalBindingV2, right: CustomRosterApprovalBindingV2): boolean {
  return left.schema_version === right.schema_version &&
    left.custom_proposal_sha256 === right.custom_proposal_sha256 &&
    left.validation_result_sha256 === right.validation_result_sha256 &&
    left.roster_sha256 === right.roster_sha256 &&
    left.manifest_sha256 === right.manifest_sha256 &&
    left.approval_sha256 === right.approval_sha256;
}

function sameCustomApprovalRequestBinding(left: CustomRosterApprovalV2, right: CustomRosterApprovalBindingV2): boolean {
  return left.schema_version === CUSTOM_APPROVAL_SCHEMA_V2 &&
    left.custom_proposal_sha256 === right.custom_proposal_sha256 &&
    left.validation_result_sha256 === right.validation_result_sha256 &&
    left.roster_sha256 === right.roster_sha256 &&
    left.manifest_sha256 === right.manifest_sha256 &&
    left.approval_sha256 === right.approval_sha256 &&
    left.approval_sha256 === customApprovalSha256({
      custom_proposal_sha256: left.custom_proposal_sha256,
      validation_result_sha256: left.validation_result_sha256,
      roster_sha256: left.roster_sha256,
      manifest_sha256: left.manifest_sha256,
    });
}

function sameRememberedCustomProposal(left: RememberedCustomProposal, right: RememberedCustomProposal): boolean {
  return left.inventory_sha256 === right.inventory_sha256 &&
    left.candidate_set.candidate_set_sha256 === right.candidate_set.candidate_set_sha256 &&
    left.custom_proposal.proposal_sha256 === right.custom_proposal.proposal_sha256 &&
    canonicalSha256(left.custom_proposal) === canonicalSha256(right.custom_proposal) &&
    left.validation_result.result_sha256 === right.validation_result.result_sha256 &&
    canonicalSha256(left.validation_result) === canonicalSha256(right.validation_result) &&
    left.roster.roster_sha256 === right.roster.roster_sha256 &&
    sameBytes(left.roster_bytes, right.roster_bytes) &&
    left.manifest_sha256 === right.manifest_sha256 &&
    sameCustomApprovalBinding(left.approval_binding, right.approval_binding);
}

function resultForFailure(action: ResultAction, status: Extract<ResultStatus, 'blocked' | 'failed'>, codes: readonly string[]): RosterToolResult {
  return materializeResult({
    schema_version: RESULT_SCHEMA,
    action,
    ok: false,
    status,
    candidate_set: null,
    receipt: null,
    diagnostics: diagnosticsFromCodes(codes),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

function resultForFailureV2(action: ResultActionV2, status: Extract<ResultStatus, 'blocked' | 'failed'>, codes: readonly string[]): RosterToolResultV2 {
  return materializeResultV2({
    schema_version: RESULT_SCHEMA_V2,
    action,
    ok: false,
    status,
    candidate_set: null,
    custom_proposal: null,
    custom_validation: null,
    custom_roster: null,
    approval_binding: null,
    receipt: null,
    custom_receipt: null,
    diagnostics: diagnosticsFromCodes(codes),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

function resultForParsedFailure(input: ParseRequestFailure): AnyRosterToolResult {
  return input.schema_version === REQUEST_SCHEMA_V2
    ? resultForFailureV2(input.action_v2, input.status, input.codes)
    : resultForFailure(input.action, input.status, input.codes);
}

function resultForRequestFailure(request: AnyRosterToolRequest, status: Extract<ResultStatus, 'blocked' | 'failed'>, codes: readonly string[]): AnyRosterToolResult {
  return request.schema_version === REQUEST_SCHEMA_V2
    ? resultForFailureV2(resultActionForInputV2(request.action), status, codes)
    : resultForFailure(resultActionForInput(request.action), status, codes);
}

function materializeResult(preimage: RosterToolResultPreimage): RosterToolResult {
  const normalizedPreimage = {
    ...preimage,
    diagnostics: sortDiagnostics(preimage.diagnostics),
    files_touched: uniqueSortedStrings(preimage.files_touched),
  };
  const result = {
    ...normalizedPreimage,
    result_sha256: canonicalSha256(normalizedPreimage),
  };
  assertAutopilotRosterContract(RESULT_SCHEMA, result);
  return result;
}

function materializeResultV2(preimage: RosterToolResultV2Preimage): RosterToolResultV2 {
  if (preimage.candidate_set !== null) {
    assertAutopilotRosterContract('autopilot.roster_candidate_set.v1', preimage.candidate_set);
  }
  if (preimage.custom_proposal !== null && parseCustomRosterProposalV2(preimage.custom_proposal) === null) {
    throw new Error('invalid custom roster proposal v2');
  }
  const normalizedPreimage = {
    ...preimage,
    diagnostics: sortDiagnostics(preimage.diagnostics),
    files_touched: uniqueSortedStrings(preimage.files_touched),
  };
  return Object.freeze({ ...normalizedPreimage, result_sha256: canonicalSha256(normalizedPreimage) });
}

function textResult(result: AnyRosterToolResult): RosterToolTextResult {
  const text = boundedResultText(result);
  return { content: [{ type: 'text', text }], details: result };
}

function boundedResultText(result: AnyRosterToolResult): string {
  const full = JSON.stringify(result);
  if (Buffer.byteLength(full, 'utf8') <= MAX_CONTENT_BYTES) return full;
  const compact = {
    schema_version: result.schema_version,
    action: result.action,
    ok: result.ok,
    status: result.status,
    candidate_set_sha256: result.candidate_set?.candidate_set_sha256 ?? null,
    candidate_count: result.candidate_set?.candidates.length ?? 0,
    candidate_roster_sha256s: result.candidate_set?.candidates.map((candidate) => candidate.roster_sha256).slice(0, 16) ?? [],
    custom_proposal_sha256: result.schema_version === RESULT_SCHEMA_V2 ? result.custom_proposal?.proposal_sha256 ?? null : null,
    custom_validation_result_sha256: result.schema_version === RESULT_SCHEMA_V2 ? result.custom_validation?.result_sha256 ?? null : null,
    custom_roster_sha256: result.schema_version === RESULT_SCHEMA_V2 ? result.custom_roster?.roster_sha256 ?? result.approval_binding?.roster_sha256 ?? null : null,
    custom_manifest_sha256: result.schema_version === RESULT_SCHEMA_V2 ? result.approval_binding?.manifest_sha256 ?? null : null,
    custom_approval_sha256: result.schema_version === RESULT_SCHEMA_V2 ? result.approval_binding?.approval_sha256 ?? null : null,
    receipt_sha256: result.receipt?.receipt_sha256 ?? null,
    custom_receipt_sha256: result.schema_version === RESULT_SCHEMA_V2 ? result.custom_receipt?.receipt_sha256 ?? null : null,
    diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code),
    write_count: result.write_count,
    lock_count: result.lock_count,
    files_touched: result.files_touched,
    result_sha256: result.result_sha256,
  };
  return JSON.stringify(compact);
}

function diagnosticsFromRoster(diagnostics: readonly RosterDiagnostic[]): readonly ToolDiagnostic[] {
  return sortDiagnostics(diagnostics.map((diagnostic) => ({ ...diagnostic })));
}

function diagnosticsFromCodes(codes: readonly string[]): readonly ToolDiagnostic[] {
  return sortDiagnostics(codes.map((code) => diagnosticForCode(code)));
}

function diagnosticsFromExternal(diagnostics: readonly { readonly code: string; readonly severity?: string; readonly message?: string; readonly remediation?: string; readonly secret_free?: boolean }[]): readonly ToolDiagnostic[] {
  return sortDiagnostics(diagnostics.map((diagnostic) => diagnosticForCode(diagnostic.code, diagnostic.severity)));
}

function diagnosticForCode(code: string, severity?: string): ToolDiagnostic {
  const normalized = /^ROSTER_[A-Z0-9_]+$/u.test(code) ? code : 'ROSTER_READBACK_MISMATCH';
  if ((ROSTER_DIAGNOSTIC_CODES as readonly string[]).includes(normalized)) {
    return rosterDiagnostic(normalized as (typeof ROSTER_DIAGNOSTIC_CODES)[number]);
  }
  return {
    code: normalized,
    severity: severity === 'info' || severity === 'warning' || severity === 'error' || severity === 'fatal'
      ? severity
      : normalized === 'ROSTER_READBACK_MISMATCH'
        ? 'fatal'
        : 'error',
    message: `${normalized} roster setup diagnostic`,
    remediation: 'Follow the Phase 37 roster setup contract and retry only after the blocking condition is repaired.',
    secret_free: true,
  };
}

function sortDiagnostics(diagnostics: readonly ToolDiagnostic[]): readonly ToolDiagnostic[] {
  const byCode = new Map<string, ToolDiagnostic>();
  for (const diagnostic of diagnostics) {
    byCode.set(diagnostic.code, { ...diagnostic, secret_free: true });
  }
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
}

type ParseRequestFailure = {
  readonly ok: false;
  readonly schema_version: typeof REQUEST_SCHEMA | typeof REQUEST_SCHEMA_V2;
  readonly action: ResultAction;
  readonly action_v2: ResultActionV2;
  readonly status: Extract<ResultStatus, 'blocked' | 'failed'>;
  readonly codes: readonly string[];
};

type ParseRequestResult = { readonly ok: true; readonly request: AnyRosterToolRequest } | ParseRequestFailure;

function parseRequest(value: unknown): ParseRequestResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return parseFailure('inspect', 'propose-custom', false);
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record['schema_version'] === REQUEST_SCHEMA_V2) return parseRequestV2(record);
  const unsupportedCustomPath = isCustomRosterUnsupportedToolPayload(value);
  return parseRequestV1(record, unsupportedCustomPath);
}

function parseRequestV1(record: Readonly<Record<string, unknown>>, unsupportedCustomPath: boolean): ParseRequestResult {
  const rawAction = record['action'];
  const action = typeof rawAction === 'string' && isInputAction(rawAction) ? rawAction : null;
  if (!hasExactRequestKeys(record) || action === null) return parseFailure(action === null ? 'inspect' : resultActionForInput(action), 'propose-custom', unsupportedCustomPath);
  if (record['schema_version'] !== REQUEST_SCHEMA) return parseFailure(resultActionForInput(action), 'propose-custom', unsupportedCustomPath);
  const base = parseBaseFields(record);
  if (base === null) return parseFailure(resultActionForInput(action), 'propose-custom', unsupportedCustomPath);
  return { ok: true, request: { schema_version: REQUEST_SCHEMA, action, ...base } };
}

function parseRequestV2(record: Readonly<Record<string, unknown>>): ParseRequestResult {
  const rawAction = record['action'];
  const action = typeof rawAction === 'string' && isInputActionV2(rawAction) ? rawAction : null;
  if (!hasExactRequestKeysV2(record) || action === null) return parseFailure('inspect', action === null ? 'propose-custom' : resultActionForInputV2(action), false, REQUEST_SCHEMA_V2);
  const base = parseBaseFields(record);
  if (base === null) return parseFailure('inspect', resultActionForInputV2(action), false, REQUEST_SCHEMA_V2);
  if (action === 'propose-custom') {
    if (base.approval_token !== null || record['custom_roster_approval'] !== null) return parseFailure('inspect', 'propose-custom', false, REQUEST_SCHEMA_V2);
    if (base.candidate_set_sha256 !== null || base.approved_roster_sha256s.length !== 0 || base.default_roster_id !== null || base.default_roster_revision !== null || base.default_roster_sha256 !== null) {
      return parseFailure('inspect', 'propose-custom', false, REQUEST_SCHEMA_V2);
    }
    return { ok: true, request: { schema_version: REQUEST_SCHEMA_V2, action, ...base, custom_roster_request: record['custom_roster_request'], custom_roster_approval: null } };
  }
  if (action === 'reject') {
    if (
      base.approval_token !== null ||
      base.candidate_set_sha256 !== null ||
      base.approved_roster_sha256s.length !== 0 ||
      base.default_roster_id !== null ||
      base.default_roster_revision !== null ||
      base.default_roster_sha256 !== null ||
      record['custom_roster_request'] !== null ||
      record['custom_roster_approval'] !== null
    ) return parseFailure('inspect', 'reject', false, REQUEST_SCHEMA_V2);
    return { ok: true, request: { schema_version: REQUEST_SCHEMA_V2, action, ...base, custom_roster_request: null, custom_roster_approval: null } };
  }
  const approval = parseCustomApprovalV2(record['custom_roster_approval']);
  if (
    record['custom_roster_request'] !== null ||
    approval === null ||
    base.approval_token === null ||
    base.candidate_set_sha256 === null ||
    base.approved_roster_sha256s.length === 0 ||
    base.default_roster_id === null ||
    base.default_roster_revision === null ||
    base.default_roster_sha256 === null
  ) return parseFailure('inspect', 'save', false, REQUEST_SCHEMA_V2);
  return { ok: true, request: { schema_version: REQUEST_SCHEMA_V2, action, ...base, custom_roster_request: null, custom_roster_approval: approval } };
}

function parseBaseFields(record: Readonly<Record<string, unknown>>): Omit<RosterToolRequest, 'schema_version' | 'action'> | null {
  const activationToken = stringField(record, 'activation_token');
  const approvalToken = nullableStringField(record, 'approval_token');
  const scope = scopeField(record['scope']);
  const trustedProjectRoot = nullableStringField(record, 'trusted_project_root');
  const candidateSetSha = nullableDigestField(record, 'candidate_set_sha256');
  const approved = digestArrayField(record['approved_roster_sha256s']);
  const defaultRosterId = nullableRosterId(record['default_roster_id']);
  const defaultRosterRevision = nullablePositiveInteger(record['default_roster_revision']);
  const defaultRosterSha = nullableDigest(record['default_roster_sha256']);
  const originalCommand = stringField(record, 'original_command');
  if (
    activationToken === null || !TOKEN_PATTERN.test(activationToken) ||
    approvalToken === undefined || (approvalToken !== null && !TOKEN_PATTERN.test(approvalToken)) ||
    scope === null || trustedProjectRoot === undefined || candidateSetSha === undefined ||
    approved === null || defaultRosterId === undefined || defaultRosterRevision === undefined || defaultRosterSha === undefined ||
    originalCommand === null || originalCommand.length === 0 || originalCommand.length > 4096 || originalCommand.includes('\u0000')
  ) {
    return null;
  }
  return {
    activation_token: activationToken,
    approval_token: approvalToken,
    scope,
    trusted_project_root: trustedProjectRoot,
    candidate_set_sha256: candidateSetSha,
    approved_roster_sha256s: approved,
    default_roster_id: defaultRosterId,
    default_roster_revision: defaultRosterRevision,
    default_roster_sha256: defaultRosterSha,
    original_command: originalCommand,
  };
}

function parseCustomCandidateV2(value: unknown): CustomRosterCandidateV2 | null {
  if (!isPlainRecord(value)) return null;
  const expected = new Set(['schema_version', 'candidate_id', 'scope', 'profile_id', 'roster_id', 'roster_revision', 'assignment_set_sha256', 'roster_sha256', 'inventory_sha256', 'validation_result_sha256', 'manifest_sha256', 'validation_status', 'certification_status', 'diagnostic_codes', 'custom_candidate_sha256']);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) return null;
  const assignmentSet = digestField(value['assignment_set_sha256']);
  const rosterSha = digestField(value['roster_sha256']);
  const inventorySha = digestField(value['inventory_sha256']);
  const validationSha = digestField(value['validation_result_sha256']);
  const manifestSha = nullableDigest(value['manifest_sha256']);
  const candidateSha = digestField(value['custom_candidate_sha256']);
  const diagnostics = stringArray(value['diagnostic_codes'], /^ROSTER_[A-Z0-9_]+$/u);
  if (
    value['schema_version'] !== CUSTOM_CANDIDATE_SCHEMA_V2 ||
    typeof value['candidate_id'] !== 'string' || value['candidate_id'].length === 0 || value['candidate_id'].length > 96 ||
    scopeField(value['scope']) === null ||
    typeof value['profile_id'] !== 'string' || !ROSTER_PROFILES.some((profile) => profile.profile_id === value['profile_id']) ||
    typeof value['roster_id'] !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/u.test(value['roster_id']) ||
    typeof value['roster_revision'] !== 'number' || !Number.isSafeInteger(value['roster_revision']) || value['roster_revision'] < 1 ||
    assignmentSet === null || rosterSha === null || inventorySha === null || validationSha === null || manifestSha === undefined || candidateSha === null ||
    !isCustomValidationStatus(value['validation_status']) ||
    !isCustomCertificationStatus(value['certification_status']) ||
    diagnostics === null
  ) return null;
  const withoutHash = {
    schema_version: CUSTOM_CANDIDATE_SCHEMA_V2,
    candidate_id: value['candidate_id'],
    scope: scopeField(value['scope']) as RosterScope,
    profile_id: value['profile_id'],
    roster_id: value['roster_id'],
    roster_revision: value['roster_revision'],
    assignment_set_sha256: assignmentSet,
    roster_sha256: rosterSha,
    inventory_sha256: inventorySha,
    validation_result_sha256: validationSha,
    manifest_sha256: manifestSha,
    validation_status: value['validation_status'],
    certification_status: value['certification_status'],
    diagnostic_codes: diagnostics,
  } satisfies Omit<CustomRosterCandidateV2, 'custom_candidate_sha256'>;
  if (canonicalSha256(withoutHash) !== candidateSha) return null;
  return Object.freeze({ ...withoutHash, custom_candidate_sha256: candidateSha });
}

export function parseCustomRosterProposalV2(value: unknown): CustomRosterProposalV2 | null {
  if (!isPlainRecord(value)) return null;
  const expected = new Set(['schema_version', 'proposal_id', 'scope', 'inventory_sha256', 'validation_result_sha256', 'roster_sha256', 'manifest_sha256', 'custom_candidate', 'proposal_sha256']);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) return null;
  const inventorySha = digestField(value['inventory_sha256']);
  const validationSha = digestField(value['validation_result_sha256']);
  const rosterSha = digestField(value['roster_sha256']);
  const manifestSha = nullableDigest(value['manifest_sha256']);
  const proposalSha = digestField(value['proposal_sha256']);
  const customCandidate = parseCustomCandidateV2(value['custom_candidate']);
  const scope = scopeField(value['scope']);
  if (
    value['schema_version'] !== CUSTOM_PROPOSAL_SCHEMA_V2 ||
    typeof value['proposal_id'] !== 'string' || !/^custom-proposal-[a-f0-9]{16}$/u.test(value['proposal_id']) ||
    scope === null || inventorySha === null || validationSha === null || rosterSha === null || manifestSha === undefined || proposalSha === null || customCandidate === null ||
    customCandidate.scope !== scope ||
    customCandidate.inventory_sha256 !== inventorySha ||
    customCandidate.validation_result_sha256 !== validationSha ||
    customCandidate.roster_sha256 !== rosterSha ||
    customCandidate.manifest_sha256 !== manifestSha
  ) return null;
  const withoutHash = {
    schema_version: CUSTOM_PROPOSAL_SCHEMA_V2,
    proposal_id: value['proposal_id'],
    scope,
    inventory_sha256: inventorySha,
    validation_result_sha256: validationSha,
    roster_sha256: rosterSha,
    manifest_sha256: manifestSha,
    custom_candidate: customCandidate,
  } satisfies Omit<CustomRosterProposalV2, 'proposal_sha256'>;
  if (canonicalSha256(withoutHash) !== proposalSha) return null;
  return Object.freeze({ ...withoutHash, proposal_sha256: proposalSha });
}

function parseCustomApprovalV2(value: unknown): CustomRosterApprovalV2 | null {
  if (!isPlainRecord(value)) return null;
  const expected = new Set(['schema_version', 'custom_proposal_sha256', 'validation_result_sha256', 'roster_sha256', 'manifest_sha256', 'approval_sha256']);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) return null;
  const customProposal = digestField(value['custom_proposal_sha256']);
  const validation = digestField(value['validation_result_sha256']);
  const roster = digestField(value['roster_sha256']);
  const manifest = nullableDigest(value['manifest_sha256']);
  const approval = digestField(value['approval_sha256']);
  if (value['schema_version'] !== CUSTOM_APPROVAL_SCHEMA_V2 || customProposal === null || validation === null || roster === null || manifest === undefined || approval === null) return null;
  const parsed = Object.freeze({ schema_version: CUSTOM_APPROVAL_SCHEMA_V2, custom_proposal_sha256: customProposal, validation_result_sha256: validation, roster_sha256: roster, manifest_sha256: manifest, approval_sha256: approval });
  if (parsed.approval_sha256 !== customApprovalSha256({ custom_proposal_sha256: customProposal, validation_result_sha256: validation, roster_sha256: roster, manifest_sha256: manifest })) return null;
  return parsed;
}

function parseFailure(
  action: ResultAction,
  actionV2: ResultActionV2,
  unsupportedCustomPath: boolean,
  schemaVersion: typeof REQUEST_SCHEMA | typeof REQUEST_SCHEMA_V2 = REQUEST_SCHEMA,
): ParseRequestFailure {
  return unsupportedCustomPath
    ? { ok: false, schema_version: REQUEST_SCHEMA, action, action_v2: actionV2, status: 'blocked', codes: [CUSTOM_ROSTER_TOOL_UNSUPPORTED_DIAGNOSTIC] }
    : { ok: false, schema_version: schemaVersion, action, action_v2: actionV2, status: 'failed', codes: ['ROSTER_READBACK_MISMATCH'] };
}

function hasExactRequestKeys(record: Readonly<Record<string, unknown>>): boolean {
  const expected = new Set<string>([
    'schema_version',
    'action',
    'activation_token',
    'approval_token',
    'scope',
    'trusted_project_root',
    'candidate_set_sha256',
    'approved_roster_sha256s',
    'default_roster_id',
    'default_roster_revision',
    'default_roster_sha256',
    'original_command',
  ]);
  const keys = Object.keys(record);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasExactRequestKeysV2(record: Readonly<Record<string, unknown>>): boolean {
  const expected = new Set<string>([
    'schema_version',
    'action',
    'activation_token',
    'approval_token',
    'scope',
    'trusted_project_root',
    'candidate_set_sha256',
    'approved_roster_sha256s',
    'default_roster_id',
    'default_roster_revision',
    'default_roster_sha256',
    'original_command',
    'custom_roster_request',
    'custom_roster_approval',
  ]);
  const keys = Object.keys(record);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isInputAction(value: string): value is InputAction {
  return (INPUT_ACTIONS as readonly string[]).includes(value);
}

function isInputActionV2(value: string): value is InputActionV2 {
  return (INPUT_ACTIONS_V2 as readonly string[]).includes(value);
}

function resultActionForInput(action: InputAction): ResultAction {
  return action === 'refine' ? 'propose' : action;
}

function resultActionForInputV2(action: InputActionV2): ResultActionV2 {
  return action;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function digestField(value: unknown): Digest | null {
  return typeof value === 'string' && DIGEST_PATTERN.test(value) ? value as Digest : null;
}

function nullableStringField(record: Readonly<Record<string, unknown>>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === 'string' && value.length >= 1 && value.length <= 4096 && !value.includes('\u0000')) return value;
  return undefined;
}

function scopeField(value: unknown): RosterScope | null {
  return value === 'user' || value === 'trusted-project' ? value : null;
}

function nullableDigestField(record: Readonly<Record<string, unknown>>, key: string): Digest | null | undefined {
  return nullableDigest(record[key]);
}

function nullableDigest(value: unknown): Digest | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && DIGEST_PATTERN.test(value)) return value as Digest;
  return undefined;
}

function digestArrayField(value: unknown): readonly Digest[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const output: Digest[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !DIGEST_PATTERN.test(item)) return null;
    output.push(item as Digest);
  }
  if (new Set(output).size !== output.length) return null;
  return output;
}

function stringArray(value: unknown, pattern: RegExp): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item)) return null;
    output.push(item);
  }
  const sorted = [...output].sort((left, right) => left.localeCompare(right));
  if (new Set(output).size !== output.length || !sameStrings(output, sorted)) return null;
  return Object.freeze(output);
}

function isCustomValidationStatus(value: unknown): value is CustomRosterIntentValidationResult['validation']['status'] {
  return value === 'failed' || value === 'blocked' || value === 'certified';
}

function isCustomCertificationStatus(value: unknown): value is CustomRosterIntentValidationResult['validation']['certification_status'] {
  return value === 'absent' || value === 'invalid' || value === 'untrusted' || value === 'autopilot-certified';
}

function nullableRosterId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && /^[a-z][a-z0-9-]{0,95}$/u.test(value)) return value;
  return undefined;
}

function nullablePositiveInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  return undefined;
}

async function trustedProjectBlocked(ctx: unknown): Promise<boolean> {
  return !await isProjectTrusted(setupContext(ctx));
}

function setupContext(ctx: unknown): Parameters<typeof resolveRosterSetupInventoryFromContext>[0]['ctx'] {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  return ctx as Parameters<typeof resolveRosterSetupInventoryFromContext>[0]['ctx'];
}

function nonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => right[index] === entry);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function approvedRosterSha256sPreservePresentedOrder(presentedRosterSha256s: readonly Digest[], approvedRosterSha256s: readonly Digest[]): boolean {
  if (approvedRosterSha256s.length === 0 || new Set(approvedRosterSha256s).size !== approvedRosterSha256s.length) return false;
  let cursor = 0;
  for (const approved of approvedRosterSha256s) {
    const index = presentedRosterSha256s.indexOf(approved, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

function approvedRosterSha256sMatchCandidateSubset(candidateSet: RosterCandidateSet, approvedRosterSha256s: readonly Digest[]): boolean {
  return approvedRosterSha256sPreservePresentedOrder(
    candidateSet.candidates.map((candidate) => candidate.roster_sha256),
    approvedRosterSha256s,
  );
}

function uniqueSortedStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
