import { randomBytes } from 'node:crypto';

import {
  assertAutopilotRosterContract,
  parseAutopilotRosterContract,
} from './contracts.ts';
import { launchabilityBlockCodesForCandidates } from './activation-fence.ts';
import { doctorRoleResults, doctorRosterInventory } from './doctor.ts';
import {
  type ProposalResult,
  type RosterCandidateSet,
  proposeRosterCandidates,
  validateCandidateSetApproval,
} from './provider-recipes.ts';
import {
  ROSTER_DIAGNOSTIC_CODES,
  type Digest,
  type RosterDiagnostic,
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
const RECEIPT_SCHEMA = 'autopilot.roster_setup_receipt.v1' as const;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/u;
const MAX_CONTENT_BYTES = 48_000;

const INPUT_ACTIONS = ['inspect', 'propose', 'refine', 'save', 'reject', 'doctor'] as const;
type InputAction = (typeof INPUT_ACTIONS)[number];
type ResultAction = Exclude<InputAction, 'refine'>;
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

interface RosterToolTextResult {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly details: RosterToolResult;
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

interface ApprovalSnapshot {
  readonly approval_token: string;
  readonly activation_token: string;
  readonly scope: RosterScope;
  readonly candidate_set_sha256: Digest;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
  readonly original_command: string;
  readonly presentation_sha256: Digest;
  consumed: boolean;
}

interface ApprovalPresentation extends ControllerApprovalInput {
  readonly presentation_text: string;
  readonly presentation_sha256: Digest;
}

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
  currentApprovalPresentation(): ApprovalPresentation | null;
  authorizeInput(input: { readonly activation_token: string; readonly source?: string | undefined; readonly text: string }): ControllerApprovalResult;
}

interface SaveCapabilityInput {
  readonly request: RosterToolRequest;
  readonly candidate_set: RosterCandidateSet;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
}

interface SaveCapabilityResult {
  readonly ok: boolean;
  readonly status: Extract<ResultStatus, 'saved' | 'blocked' | 'failed'>;
  readonly receipt: unknown;
  readonly diagnostics: readonly { readonly code: string; readonly severity?: string; readonly message?: string; readonly remediation?: string; readonly secret_free?: boolean }[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly string[];
}

interface CreateRosterSetupToolOptions {
  readonly inventory?: RosterInventory | ((input: { readonly request: RosterToolRequest; readonly ctx: unknown }) => RosterInventory | Promise<RosterInventory>) | undefined;
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

const PARAMETER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'string', enum: [REQUEST_SCHEMA] },
    action: { type: 'string', enum: [...INPUT_ACTIONS] },
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
  },
  required: [
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
      'Manage Phase 37 Autopilot roster setup pre-run. Inactive until the package activates one setup session; inspect, propose/refine, reject, and doctor are zero-write, save requires exact approval.',
    promptSnippet: 'Inspect, propose/refine, reject, doctor, or save Autopilot roster setup with exact hashes and no secrets.',
    promptGuidelines: [
      'Use autopilot_manage_rosters only inside the activated autopilot-roster-setup session and pass its activation_token exactly.',
      'Use autopilot_manage_rosters inspect, propose, refine, doctor, and reject only as zero-write pre-run operations.',
      'Use autopilot_manage_rosters save only after exact approval of candidate_set_sha256, approved_roster_sha256s, default tuple, scope, and original_command.',
      'Do not ask autopilot_manage_rosters to resolve credentials or secrets; treat blocked and converged diagnostics honestly.',
    ],
    parameters: PARAMETER_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<RosterToolTextResult> {
      if (signal?.aborted === true) {
        return textResult(resultForFailure('inspect', 'failed', ['ROSTER_READBACK_MISMATCH']));
      }
      const parsed = parseRequest(params);
      if (!parsed.ok) {
        return textResult(resultForFailure(parsed.action, 'failed', ['ROSTER_READBACK_MISMATCH']));
      }
      const request = parsed.request;
      if (!controller.accepts(request.activation_token)) {
        return textResult(resultForFailure(resultActionForInput(request.action), 'blocked', ['ROSTER_TRANSITION_REQUIRED']));
      }
      try {
        const result = await dispatchRosterToolAction({ request, ctx, options, controller });
        return textResult(result);
      } catch {
        return textResult(resultForFailure(resultActionForInput(request.action), 'failed', ['ROSTER_READBACK_MISMATCH']));
      }
    },
  };
  return { tool, controller, hostAuthorization: controller.hostAuthorization };
}

function createController(): RosterSetupController & {
  readonly hostAuthorization: RosterSetupHostAuthorization;
  accepts(token: string): boolean;
  rememberProposal(token: string, request: RosterToolRequest, candidateSet: RosterCandidateSet): void;
  invalidateProposal(token: string): void;
  consumeApproval(request: RosterToolRequest, candidateSet: RosterCandidateSet): boolean;
} {
  let activationToken: string | null = null;
  let sessionId: string | null = null;
  let everActivated = false;
  let active = false;
  let latestCandidateSet: RosterCandidateSet | null = null;
  let latestPresentation: ApprovalPresentation | null = null;
  let presentationAlreadyAuthorized = false;
  const approvals = new Map<string, ApprovalSnapshot>();

  const accepts = (token: string): boolean => active && activationToken !== null && token === activationToken;
  const clearProposal = (): void => {
    latestCandidateSet = null;
    latestPresentation = null;
    presentationAlreadyAuthorized = false;
    approvals.clear();
  };

  const hostAuthorization: RosterSetupHostAuthorization = {
    currentApprovalPresentation(): ApprovalPresentation | null {
      return latestPresentation === null ? null : { ...latestPresentation, approved_roster_sha256s: [...latestPresentation.approved_roster_sha256s] };
    },
    authorizeInput(input): ControllerApprovalResult {
      if (!active || activationToken === null) return { ok: false, approval_token: null, reason: 'inactive' };
      if (input.activation_token !== activationToken) return { ok: false, approval_token: null, reason: 'bad-activation-token' };
      if (!isHostUserInputSource(input.source)) return { ok: false, approval_token: null, reason: 'source-not-user' };
      if (latestCandidateSet === null || latestPresentation === null) return { ok: false, approval_token: null, reason: 'no-current-presentation' };
      if (presentationAlreadyAuthorized) return { ok: false, approval_token: null, reason: 'duplicate-authorization' };
      if (input.text !== latestPresentation.presentation_text || !approvalMatchesCandidateSet(latestPresentation, latestCandidateSet)) {
        return { ok: false, approval_token: null, reason: 'stale-or-mismatched-approval' };
      }
      const approvalToken = `approval:${randomBytes(24).toString('hex')}`;
      approvals.set(approvalToken, { ...latestPresentation, approval_token: approvalToken, consumed: false });
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
      latestPresentation = buildApprovalPresentation(request, candidateSet);
      presentationAlreadyAuthorized = false;
      approvals.clear();
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
      if (!approvalMatchesCandidateSet(approval, candidateSet)) return false;
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
  const launchabilityCodes = launchabilityBlockCodesForCandidates(candidateSet.candidates);
  if (launchabilityCodes.length > 0) return saveBlocked(launchabilityCodes);
  if (options.saveApproved === undefined) return saveFailed(['ROSTER_READBACK_MISMATCH']);
  try {
    const saved = await options.saveApproved({
      request,
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

async function currentInventory(
  request: RosterToolRequest,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
): Promise<RosterInventory> {
  if (typeof options.inventory === 'function') {
    return normalizeRosterInventory(await options.inventory({ request, ctx }));
  }
  if (options.inventory !== undefined) return normalizeRosterInventory(options.inventory);
  return await resolveRosterSetupInventoryFromContext({ ctx: setupContext(ctx), scope: request.scope });
}

async function currentProposal(
  request: RosterToolRequest,
  ctx: unknown,
  options: CreateRosterSetupToolOptions,
): Promise<ProposalResult> {
  const inventory = await currentInventory(request, ctx, options);
  return proposeRosterCandidates({ inventory, scope: request.scope, include_unready: true });
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
  return Object.freeze({ ...input, presentation_text: presentationText, presentation_sha256: canonicalSha256(preimage) });
}

export function renderRosterSetupApprovalPresentation(input: RosterSetupApprovalPresentationInput): string {
  return [
    'I approve saving the Autopilot roster setup with:',
    `scope: ${input.scope}`,
    `candidate_set_sha256: ${input.candidate_set_sha256}`,
    `approved_roster_sha256s, in order: [${input.approved_roster_sha256s.join(', ')}]`,
    `default_roster_id: ${input.default_roster_id}`,
    `default_roster_revision: ${String(input.default_roster_revision)}`,
    `default_roster_sha256: ${input.default_roster_sha256}`,
    `original_command: ${input.original_command}`,
  ].join('\n');
}

function isHostUserInputSource(source: string | undefined): boolean {
  return source === 'user' || source === 'interactive';
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

function parseReceipt(value: unknown): RosterToolReceipt | null {
  try {
    return parseAutopilotRosterContract(RECEIPT_SCHEMA, value) as unknown as RosterToolReceipt;
  } catch {
    return null;
  }
}

function receiptMatchesSave(request: RosterToolRequest, candidateSet: RosterCandidateSet, receipt: RosterToolReceipt): boolean {
  if (request.candidate_set_sha256 === null || request.default_roster_id === null || request.default_roster_revision === null || request.default_roster_sha256 === null) return false;
  if (receipt.scope !== request.scope) return false;
  if (receipt.approved_candidate_set_sha256 !== request.candidate_set_sha256) return false;
  if (!sameStrings(receipt.approved_roster_sha256s, request.approved_roster_sha256s)) return false;
  if (receipt.default_roster_id !== request.default_roster_id || receipt.default_roster_revision !== request.default_roster_revision || receipt.default_roster_sha256 !== request.default_roster_sha256) return false;
  if (receipt.original_command !== request.original_command) return false;
  if (receipt.fresh_session_required !== true || receipt.zero_secrets !== true) return false;
  const matches = receipt.saved_rosters.filter((ref) => ref.roster_id === receipt.default_roster_id && ref.roster_revision === receipt.default_roster_revision && ref.roster_sha256 === receipt.default_roster_sha256);
  if (matches.length !== 1) return false;
  const candidateHashes = candidateSet.candidates.map((candidate) => candidate.roster_sha256);
  return sameStrings(candidateHashes, request.approved_roster_sha256s);
}

function defaultTupleMatches(request: RosterToolRequest, candidateSet: RosterCandidateSet): boolean {
  if (request.default_roster_id === null || request.default_roster_revision === null || request.default_roster_sha256 === null) return false;
  const matches = candidateSet.candidates.filter((candidate) =>
    candidate.roster_id === request.default_roster_id &&
    candidate.roster_revision === request.default_roster_revision &&
    candidate.roster_sha256 === request.default_roster_sha256,
  );
  return matches.length === 1 && request.approved_roster_sha256s.includes(request.default_roster_sha256);
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
  return request.candidate_set_sha256 === approval.candidate_set_sha256 &&
    request.scope === approval.scope &&
    request.default_roster_id === approval.default_roster_id &&
    request.default_roster_revision === approval.default_roster_revision &&
    request.default_roster_sha256 === approval.default_roster_sha256 &&
    request.original_command === approval.original_command &&
    sameStrings(request.approved_roster_sha256s, approval.approved_roster_sha256s);
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

function textResult(result: RosterToolResult): RosterToolTextResult {
  const text = boundedResultText(result);
  return { content: [{ type: 'text', text }], details: result };
}

function boundedResultText(result: RosterToolResult): string {
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
    receipt_sha256: result.receipt?.receipt_sha256 ?? null,
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

function parseRequest(value: unknown): { readonly ok: true; readonly request: RosterToolRequest } | { readonly ok: false; readonly action: ResultAction } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return { ok: false, action: 'inspect' };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const rawAction = record['action'];
  const action = typeof rawAction === 'string' && isInputAction(rawAction) ? rawAction : null;
  if (!hasExactRequestKeys(record) || action === null) return { ok: false, action: action === null ? 'inspect' : resultActionForInput(action) };
  if (record['schema_version'] !== REQUEST_SCHEMA) return { ok: false, action: resultActionForInput(action) };
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
    originalCommand === null || originalCommand.length === 0 || originalCommand.length > 4096
  ) {
    return { ok: false, action: resultActionForInput(action) };
  }
  return {
    ok: true,
    request: {
      schema_version: REQUEST_SCHEMA,
      action,
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
    },
  };
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

function isInputAction(value: string): value is InputAction {
  return (INPUT_ACTIONS as readonly string[]).includes(value);
}

function resultActionForInput(action: InputAction): ResultAction {
  return action === 'refine' ? 'propose' : action;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
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

function uniqueSortedStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
