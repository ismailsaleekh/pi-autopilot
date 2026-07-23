import {
  autopilotRosterContractSha256,
  parseAutopilotRosterCandidateSet,
  type AutopilotRosterContractBySchemaVersion,
} from './contracts.ts';
import { assertRosterSha256, assertValidRosterId, assertValidRosterRevision, type RosterSha256 } from './paths.ts';
import { isOriginalAutopilotCommandReceiptSafe } from './setup-receipt.ts';
import type {
  RosterSaveResult,
  RosterStorage,
  RosterStorageDiagnostic,
  RosterStorageFaultInjection,
  RosterStorageScope,
  TrustedProjectStorageContext,
} from './storage.ts';

export type RosterSetupApprovalPhase =
  | 'awaiting-presentation'
  | 'presented'
  | 'authorized'
  | 'rejected'
  | 'refinement-required'
  | 'stale-representation-required'
  | 'saving'
  | 'saved'
  | 'receipt-replay-required'
  | 'failed';

export interface RosterSetupApprovalSessionOptions<Receipt = unknown> {
  readonly originalCommand: string;
  readonly storage: RosterStorage<Receipt>;
  readonly trustedProject?: TrustedProjectStorageContext | undefined;
}

export interface RosterSetupApprovalPresentationInput {
  readonly scope?: RosterStorageScope | undefined;
  readonly candidateSet?: unknown;
  readonly candidate_set_sha256?: RosterSha256 | undefined;
  readonly inventory_sha256?: RosterSha256 | undefined;
  readonly recipe_registry_sha256?: RosterSha256 | undefined;
  readonly approved_roster_sha256s: readonly RosterSha256[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: RosterSha256;
  readonly expected_previous_config_sha256: RosterSha256 | null;
}

export interface RosterSetupRestatementProof {
  readonly schema_version: 'autopilot.roster_setup_restatement_proof.v1';
  readonly proof_contract: 'phase37-w2-approval-restatement-v1';
  readonly scope: RosterStorageScope;
  readonly inventory_sha256: RosterSha256;
  readonly recipe_registry_sha256: RosterSha256;
  readonly candidate_set_sha256: RosterSha256;
  readonly approved_roster_sha256s: readonly RosterSha256[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: RosterSha256;
  readonly expected_previous_config_sha256: RosterSha256 | null;
  readonly original_command: string;
  readonly proof_sha256: RosterSha256;
}

export interface RosterSetupApprovalAuthorizationInput {
  readonly restatement_proof_sha256: RosterSha256;
  readonly host_authorized: boolean;
  readonly authorization_source?: 'explicit-host-authorization-after-restatement' | undefined;
}

export interface RosterSetupApprovalSaveInput {
  readonly roster_bytes: readonly Uint8Array[];
  readonly config_bytes: Uint8Array;
  readonly current_candidate_set?: unknown;
  readonly current_candidate_set_sha256?: RosterSha256 | undefined;
  readonly current_inventory_sha256?: RosterSha256 | undefined;
  readonly current_recipe_registry_sha256?: RosterSha256 | undefined;
  readonly current_previous_config_sha256?: RosterSha256 | null | undefined;
  readonly trustedProject?: TrustedProjectStorageContext | undefined;
  readonly faults?: RosterStorageFaultInjection | undefined;
}

export interface RosterSetupApprovalStateSnapshot {
  readonly phase: RosterSetupApprovalPhase;
  readonly original_command_bound: boolean;
  readonly original_command_sha256: RosterSha256;
  readonly restatement_proof_sha256: RosterSha256 | null;
  readonly authorized_restatement_proof_sha256: RosterSha256 | null;
  readonly restart_required: boolean;
  readonly auto_start_allowed: false;
  readonly same_session_save_allowed: boolean;
}

export interface RosterSetupApprovalBaseResult {
  readonly ok: boolean;
  readonly status: 'presented' | 'authorized' | 'rejected' | 'blocked' | 'failed' | 'saved' | 'refinement-required';
  readonly phase: RosterSetupApprovalPhase;
  readonly diagnostics: readonly RosterStorageDiagnostic[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly string[];
}

export interface RosterSetupApprovalPresentationResult extends RosterSetupApprovalBaseResult {
  readonly status: 'presented' | 'blocked' | 'failed';
  readonly restatement_proof: RosterSetupRestatementProof | null;
}

export interface RosterSetupApprovalAuthorizationResult extends RosterSetupApprovalBaseResult {
  readonly status: 'authorized' | 'blocked' | 'failed';
  readonly restatement_proof_sha256: RosterSha256 | null;
}

export interface RosterSetupApprovalDispositionResult extends RosterSetupApprovalBaseResult {
  readonly status: 'rejected' | 'refinement-required' | 'blocked';
}

export interface RosterSetupApprovalSaveResult<Receipt = unknown> extends RosterSetupApprovalBaseResult {
  readonly status: 'saved' | 'blocked' | 'failed';
  readonly storage_result: RosterSaveResult<Receipt> | null;
  readonly config_sha256: RosterSha256 | null;
  readonly receipt: RosterSaveResult<Receipt>['receipt'];
  readonly retry_command: string | null;
  readonly restart_required: boolean;
  readonly auto_start_allowed: false;
  readonly same_session_save_allowed: false;
  readonly receipt_emitted_after_readback: boolean;
}

export interface RosterSetupApprovalAutoStartResult extends RosterSetupApprovalBaseResult {
  readonly status: 'blocked';
  readonly restart_required: boolean;
  readonly auto_start_allowed: false;
}

export interface RosterSetupApprovalSession<Receipt = unknown> {
  readonly getState: () => RosterSetupApprovalStateSnapshot;
  readonly present: (input: RosterSetupApprovalPresentationInput) => RosterSetupApprovalPresentationResult;
  readonly authorize: (input: RosterSetupApprovalAuthorizationInput) => RosterSetupApprovalAuthorizationResult;
  readonly approve: (input: RosterSetupApprovalAuthorizationInput) => RosterSetupApprovalAuthorizationResult;
  readonly reject: () => RosterSetupApprovalDispositionResult;
  readonly refine: () => RosterSetupApprovalDispositionResult;
  readonly save: (input: RosterSetupApprovalSaveInput) => Promise<RosterSetupApprovalSaveResult<Receipt>>;
  readonly autoStart: () => RosterSetupApprovalAutoStartResult;
}

type CandidateSet = AutopilotRosterContractBySchemaVersion['autopilot.roster_candidate_set.v1'];

type CandidateIdentity = Readonly<{
  scope: RosterStorageScope;
  candidate_set_sha256: RosterSha256;
  inventory_sha256: RosterSha256;
  recipe_registry_sha256: RosterSha256;
  candidateSet: CandidateSet | null;
}>;

const ZERO_WRITE = Object.freeze({ write_count: 0, lock_count: 0, files_touched: Object.freeze([] as string[]) });
const AUTOPILOT_COMMAND_PATTERN = /^\/autopilot(?:\s|$)/u;

export function createRosterSetupApprovalSession<Receipt = unknown>(
  options: RosterSetupApprovalSessionOptions<Receipt>,
): RosterSetupApprovalSession<Receipt> {
  return new RosterSetupApprovalSessionImpl(options);
}

class RosterSetupApprovalSessionImpl<Receipt> implements RosterSetupApprovalSession<Receipt> {
  readonly #storage: RosterStorage<Receipt>;
  readonly #trustedProject: TrustedProjectStorageContext | undefined;
  readonly #originalCommand: string;
  readonly #originalCommandSha256: RosterSha256;
  readonly #originalCommandUsable: boolean;
  #phase: RosterSetupApprovalPhase = 'awaiting-presentation';
  #proof: RosterSetupRestatementProof | null = null;
  #authorizedProofSha256: RosterSha256 | null = null;
  #restartRequired = false;
  #sameSessionSaveForbidden = false;

  public constructor(options: RosterSetupApprovalSessionOptions<Receipt>) {
    this.#storage = options.storage;
    this.#trustedProject = options.trustedProject;
    this.#originalCommand = options.originalCommand;
    this.#originalCommandSha256 = autopilotRosterContractSha256({ original_command: options.originalCommand }) as RosterSha256;
    this.#originalCommandUsable = isUsableOriginalAutopilotCommand(options.originalCommand);
  }

  public getState(): RosterSetupApprovalStateSnapshot {
    return Object.freeze({
      phase: this.#phase,
      original_command_bound: this.#originalCommandUsable,
      original_command_sha256: this.#originalCommandSha256,
      restatement_proof_sha256: this.#proof?.proof_sha256 ?? null,
      authorized_restatement_proof_sha256: this.#authorizedProofSha256,
      restart_required: this.#restartRequired,
      auto_start_allowed: false,
      same_session_save_allowed: !this.#sameSessionSaveForbidden && this.#phase === 'authorized',
    });
  }

  public present(input: RosterSetupApprovalPresentationInput): RosterSetupApprovalPresentationResult {
    if (!this.#originalCommandUsable) {
      return Object.freeze({
        ok: false,
        status: 'blocked',
        phase: this.#phase,
        diagnostics: diagnostics(['ROSTER_AUTH_CHANNEL_FORBIDDEN']),
        restatement_proof: null,
        ...ZERO_WRITE,
      });
    }
    if (this.#sameSessionSaveForbidden || this.#phase === 'saved' || this.#phase === 'receipt-replay-required') {
      return Object.freeze({
        ok: false,
        status: 'blocked',
        phase: this.#phase,
        diagnostics: diagnostics(['ROSTER_TRANSITION_REQUIRED']),
        restatement_proof: null,
        ...ZERO_WRITE,
      });
    }
    if (this.#phase === 'rejected' || this.#phase === 'refinement-required') {
      return Object.freeze({
        ok: false,
        status: 'blocked',
        phase: this.#phase,
        diagnostics: diagnostics(['ROSTER_PROPOSAL_REJECTED']),
        restatement_proof: null,
        ...ZERO_WRITE,
      });
    }
    try {
      const identity = candidateIdentityFromPresentation(input);
      const proof = buildRestatementProof({
        scope: identity.scope,
        inventory_sha256: identity.inventory_sha256,
        recipe_registry_sha256: identity.recipe_registry_sha256,
        candidate_set_sha256: identity.candidate_set_sha256,
        approved_roster_sha256s: input.approved_roster_sha256s,
        default_roster_id: input.default_roster_id,
        default_roster_revision: input.default_roster_revision,
        default_roster_sha256: input.default_roster_sha256,
        expected_previous_config_sha256: input.expected_previous_config_sha256,
        original_command: this.#originalCommand,
      }, identity.candidateSet);
      this.#phase = 'presented';
      this.#proof = proof;
      this.#authorizedProofSha256 = null;
      return Object.freeze({
        ok: true,
        status: 'presented',
        phase: this.#phase,
        diagnostics: Object.freeze([]),
        restatement_proof: proof,
        ...ZERO_WRITE,
      });
    } catch (_error) {
      this.#phase = 'failed';
      return Object.freeze({
        ok: false,
        status: 'failed',
        phase: this.#phase,
        diagnostics: diagnostics(['ROSTER_APPROVAL_STALE_CANDIDATE_SET']),
        restatement_proof: null,
        ...ZERO_WRITE,
      });
    }
  }

  public authorize(input: RosterSetupApprovalAuthorizationInput): RosterSetupApprovalAuthorizationResult {
    if (this.#phase !== 'presented' || this.#proof === null) {
      return Object.freeze({
        ok: false,
        status: 'blocked',
        phase: this.#phase,
        diagnostics: diagnostics(['ROSTER_AUTH_REQUIRED']),
        restatement_proof_sha256: null,
        ...ZERO_WRITE,
      });
    }
    if (input.host_authorized !== true || input.restatement_proof_sha256 !== this.#proof.proof_sha256) {
      return Object.freeze({
        ok: false,
        status: 'blocked',
        phase: this.#phase,
        diagnostics: diagnostics([input.host_authorized === true ? 'ROSTER_APPROVAL_STALE_CANDIDATE_SET' : 'ROSTER_AUTH_REQUIRED']),
        restatement_proof_sha256: this.#proof.proof_sha256,
        ...ZERO_WRITE,
      });
    }
    if (
      input.authorization_source !== undefined &&
      input.authorization_source !== 'explicit-host-authorization-after-restatement'
    ) {
      return Object.freeze({
        ok: false,
        status: 'blocked',
        phase: this.#phase,
        diagnostics: diagnostics(['ROSTER_AUTH_REQUIRED']),
        restatement_proof_sha256: this.#proof.proof_sha256,
        ...ZERO_WRITE,
      });
    }
    this.#phase = 'authorized';
    this.#authorizedProofSha256 = this.#proof.proof_sha256;
    return Object.freeze({
      ok: true,
      status: 'authorized',
      phase: this.#phase,
      diagnostics: Object.freeze([]),
      restatement_proof_sha256: this.#proof.proof_sha256,
      ...ZERO_WRITE,
    });
  }

  public approve(input: RosterSetupApprovalAuthorizationInput): RosterSetupApprovalAuthorizationResult {
    return this.authorize(input);
  }

  public reject(): RosterSetupApprovalDispositionResult {
    if (this.#sameSessionSaveForbidden || this.#phase === 'saved' || this.#phase === 'receipt-replay-required') {
      return Object.freeze({
        ok: false,
        status: 'blocked',
        phase: this.#phase,
        diagnostics: diagnostics(['ROSTER_TRANSITION_REQUIRED']),
        ...ZERO_WRITE,
      });
    }
    this.#phase = 'rejected';
    this.#proof = null;
    this.#authorizedProofSha256 = null;
    return Object.freeze({
      ok: true,
      status: 'rejected',
      phase: this.#phase,
      diagnostics: diagnostics(['ROSTER_PROPOSAL_REJECTED']),
      ...ZERO_WRITE,
    });
  }

  public refine(): RosterSetupApprovalDispositionResult {
    if (this.#sameSessionSaveForbidden || this.#phase === 'saved' || this.#phase === 'receipt-replay-required') {
      return Object.freeze({
        ok: false,
        status: 'blocked',
        phase: this.#phase,
        diagnostics: diagnostics(['ROSTER_TRANSITION_REQUIRED']),
        ...ZERO_WRITE,
      });
    }
    this.#phase = 'refinement-required';
    this.#proof = null;
    this.#authorizedProofSha256 = null;
    return Object.freeze({
      ok: true,
      status: 'refinement-required',
      phase: this.#phase,
      diagnostics: diagnostics(['ROSTER_EXPLICIT_CHOICE_REQUIRED']),
      ...ZERO_WRITE,
    });
  }

  public async save(input: RosterSetupApprovalSaveInput): Promise<RosterSetupApprovalSaveResult<Receipt>> {
    if (this.#sameSessionSaveForbidden || this.#phase === 'saved' || this.#phase === 'receipt-replay-required') {
      return this.#saveBlocked(['ROSTER_TRANSITION_REQUIRED']);
    }
    if (this.#phase !== 'authorized' || this.#proof === null || this.#authorizedProofSha256 !== this.#proof.proof_sha256) {
      return this.#saveBlocked(['ROSTER_AUTH_REQUIRED']);
    }
    const proof = this.#proof;
    let freshness: CandidateIdentity;
    try {
      freshness = candidateIdentityFromSave(input, proof);
    } catch (_error) {
      this.#phase = 'stale-representation-required';
      this.#authorizedProofSha256 = null;
      return this.#saveBlocked(['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
    }
    const staleCodes: RosterSetupDiagnosticCode[] = [];
    if (
      freshness.scope !== proof.scope ||
      freshness.candidate_set_sha256 !== proof.candidate_set_sha256 ||
      freshness.inventory_sha256 !== proof.inventory_sha256 ||
      freshness.recipe_registry_sha256 !== proof.recipe_registry_sha256
    ) {
      staleCodes.push('ROSTER_APPROVAL_STALE_CANDIDATE_SET');
    }
    if (
      input.current_previous_config_sha256 !== undefined &&
      input.current_previous_config_sha256 !== proof.expected_previous_config_sha256
    ) {
      staleCodes.push('ROSTER_APPROVAL_STALE_CONFIG');
    }
    if (staleCodes.length > 0) {
      this.#phase = 'stale-representation-required';
      this.#authorizedProofSha256 = null;
      return this.#saveBlocked(staleCodes);
    }

    this.#phase = 'saving';
    const trustedProject = input.trustedProject ?? this.#trustedProject;
    const storageResult = await this.#storage.saveApprovedDefault({
      scope: proof.scope,
      ...(trustedProject === undefined ? {} : { trustedProject }),
      approved_candidate_set_sha256: proof.candidate_set_sha256,
      current_candidate_set_sha256: freshness.candidate_set_sha256,
      approved_roster_sha256s: proof.approved_roster_sha256s,
      roster_bytes: input.roster_bytes,
      config_bytes: input.config_bytes,
      expected_previous_config_sha256: proof.expected_previous_config_sha256,
      default_roster_id: proof.default_roster_id,
      default_roster_revision: proof.default_roster_revision,
      default_roster_sha256: proof.default_roster_sha256,
      original_command: this.#originalCommand,
      ...(input.faults === undefined ? {} : { faults: input.faults }),
    });

    if (storageResult.ok && storageResult.receipt !== null) {
      this.#phase = 'saved';
      this.#restartRequired = true;
      this.#sameSessionSaveForbidden = true;
      return Object.freeze({
        ok: true,
        status: 'saved',
        phase: this.#phase,
        diagnostics: storageResult.diagnostics,
        write_count: storageResult.write_count,
        lock_count: storageResult.lock_count,
        files_touched: storageResult.files_touched,
        storage_result: storageResult,
        config_sha256: storageResult.config_sha256,
        receipt: storageResult.receipt,
        retry_command: this.#originalCommand,
        restart_required: true,
        auto_start_allowed: false,
        same_session_save_allowed: false,
        receipt_emitted_after_readback: true,
      });
    }

    const configPublished = storageResult.crash_outcome === 'config-published-receipt-replay-required' || (storageResult.ok && storageResult.receipt === null);
    if (configPublished) {
      this.#phase = 'receipt-replay-required';
      this.#restartRequired = true;
      this.#sameSessionSaveForbidden = true;
    } else if (hasDiagnostic(storageResult.diagnostics, 'ROSTER_APPROVAL_STALE_CANDIDATE_SET') || hasDiagnostic(storageResult.diagnostics, 'ROSTER_APPROVAL_STALE_CONFIG')) {
      this.#phase = 'stale-representation-required';
      this.#authorizedProofSha256 = null;
    } else {
      this.#phase = 'failed';
    }
    const extraDiagnostics = storageResult.ok && storageResult.receipt === null
      ? mergeDiagnostics(storageResult.diagnostics, diagnostics(['ROSTER_RECEIPT_REPLAY_REQUIRED']))
      : storageResult.diagnostics;
    return Object.freeze({
      ok: false,
      status: storageResult.status === 'blocked' ? 'blocked' : 'failed',
      phase: this.#phase,
      diagnostics: extraDiagnostics,
      write_count: storageResult.write_count,
      lock_count: storageResult.lock_count,
      files_touched: storageResult.files_touched,
      storage_result: storageResult,
      config_sha256: storageResult.config_sha256,
      receipt: storageResult.receipt,
      retry_command: configPublished ? this.#originalCommand : null,
      restart_required: configPublished,
      auto_start_allowed: false,
      same_session_save_allowed: false,
      receipt_emitted_after_readback: false,
    });
  }

  public autoStart(): RosterSetupApprovalAutoStartResult {
    return Object.freeze({
      ok: false,
      status: 'blocked',
      phase: this.#phase,
      diagnostics: diagnostics(['ROSTER_TRANSITION_REQUIRED']),
      restart_required: this.#restartRequired,
      auto_start_allowed: false,
      ...ZERO_WRITE,
    });
  }

  #saveBlocked(codes: readonly RosterSetupDiagnosticCode[]): RosterSetupApprovalSaveResult<Receipt> {
    return Object.freeze({
      ok: false,
      status: 'blocked',
      phase: this.#phase,
      diagnostics: diagnostics(codes),
      write_count: 0,
      lock_count: 0,
      files_touched: Object.freeze([]),
      storage_result: null,
      config_sha256: null,
      receipt: null,
      retry_command: null,
      restart_required: this.#restartRequired,
      auto_start_allowed: false,
      same_session_save_allowed: false,
      receipt_emitted_after_readback: false,
    });
  }
}

function isUsableOriginalAutopilotCommand(command: string): boolean {
  return AUTOPILOT_COMMAND_PATTERN.test(command) && isOriginalAutopilotCommandReceiptSafe(command);
}

function candidateIdentityFromPresentation(input: RosterSetupApprovalPresentationInput): CandidateIdentity {
  const parsedCandidateSet = input.candidateSet === undefined ? null : parseAutopilotRosterCandidateSet(input.candidateSet);
  const scope = input.scope ?? parsedCandidateSet?.scope;
  if (scope !== 'user' && scope !== 'trusted-project') throw new Error('scope required');
  const candidateSetSha = requireRosterSha256(
    input.candidate_set_sha256 ?? (parsedCandidateSet?.candidate_set_sha256 as RosterSha256 | undefined),
    'candidate_set_sha256',
  );
  const inventorySha = requireRosterSha256(
    input.inventory_sha256 ?? (parsedCandidateSet?.inventory_sha256 as RosterSha256 | undefined),
    'inventory_sha256',
  );
  const recipeRegistrySha = requireRosterSha256(
    input.recipe_registry_sha256 ?? (parsedCandidateSet?.recipe_registry_sha256 as RosterSha256 | undefined),
    'recipe_registry_sha256',
  );
  if (parsedCandidateSet !== null) {
    if (parsedCandidateSet.scope !== scope) throw new Error('candidate set scope drift');
    if (parsedCandidateSet.candidate_set_sha256 !== candidateSetSha) throw new Error('candidate set sha drift');
    if (parsedCandidateSet.inventory_sha256 !== inventorySha) throw new Error('inventory sha drift');
    if (parsedCandidateSet.recipe_registry_sha256 !== recipeRegistrySha) throw new Error('recipe registry sha drift');
  }
  return Object.freeze({
    scope,
    candidate_set_sha256: candidateSetSha,
    inventory_sha256: inventorySha,
    recipe_registry_sha256: recipeRegistrySha,
    candidateSet: parsedCandidateSet,
  });
}

function candidateIdentityFromSave(input: RosterSetupApprovalSaveInput, proof: RosterSetupRestatementProof): CandidateIdentity {
  if (input.current_candidate_set !== undefined) {
    const parsed = parseAutopilotRosterCandidateSet(input.current_candidate_set);
    if (input.current_candidate_set_sha256 !== undefined && input.current_candidate_set_sha256 !== parsed.candidate_set_sha256) throw new Error('current candidate set sha drift');
    if (input.current_inventory_sha256 !== undefined && input.current_inventory_sha256 !== parsed.inventory_sha256) throw new Error('current inventory sha drift');
    if (input.current_recipe_registry_sha256 !== undefined && input.current_recipe_registry_sha256 !== parsed.recipe_registry_sha256) throw new Error('current recipe registry sha drift');
    return Object.freeze({
      scope: parsed.scope,
      candidate_set_sha256: parsed.candidate_set_sha256 as RosterSha256,
      inventory_sha256: parsed.inventory_sha256 as RosterSha256,
      recipe_registry_sha256: parsed.recipe_registry_sha256 as RosterSha256,
      candidateSet: parsed,
    });
  }
  return Object.freeze({
    scope: proof.scope,
    candidate_set_sha256: input.current_candidate_set_sha256 ?? proof.candidate_set_sha256,
    inventory_sha256: input.current_inventory_sha256 ?? proof.inventory_sha256,
    recipe_registry_sha256: input.current_recipe_registry_sha256 ?? proof.recipe_registry_sha256,
    candidateSet: null,
  });
}

function buildRestatementProof(
  input: Omit<RosterSetupRestatementProof, 'schema_version' | 'proof_contract' | 'proof_sha256'>,
  candidateSet: CandidateSet | null,
): RosterSetupRestatementProof {
  assertValidRosterId(input.default_roster_id, 'default_roster_id');
  assertValidRosterRevision(input.default_roster_revision, 'default_roster_revision');
  assertRosterSha256(input.default_roster_sha256, 'default_roster_sha256');
  assertRosterSha256(input.candidate_set_sha256, 'candidate_set_sha256');
  assertRosterSha256(input.inventory_sha256, 'inventory_sha256');
  assertRosterSha256(input.recipe_registry_sha256, 'recipe_registry_sha256');
  if (input.expected_previous_config_sha256 !== null) assertRosterSha256(input.expected_previous_config_sha256, 'expected_previous_config_sha256');
  validateApprovedRosterHashes(input.approved_roster_sha256s, input.default_roster_sha256, candidateSet, input.default_roster_id, input.default_roster_revision);
  const withoutHash = Object.freeze({
    schema_version: 'autopilot.roster_setup_restatement_proof.v1' as const,
    proof_contract: 'phase37-w2-approval-restatement-v1' as const,
    scope: input.scope,
    inventory_sha256: input.inventory_sha256,
    recipe_registry_sha256: input.recipe_registry_sha256,
    candidate_set_sha256: input.candidate_set_sha256,
    approved_roster_sha256s: Object.freeze([...input.approved_roster_sha256s]),
    default_roster_id: input.default_roster_id,
    default_roster_revision: input.default_roster_revision,
    default_roster_sha256: input.default_roster_sha256,
    expected_previous_config_sha256: input.expected_previous_config_sha256,
    original_command: input.original_command,
  });
  return Object.freeze({
    ...withoutHash,
    proof_sha256: autopilotRosterContractSha256(withoutHash) as RosterSha256,
  });
}

function validateApprovedRosterHashes(
  approved: readonly RosterSha256[],
  defaultHash: RosterSha256,
  candidateSet: CandidateSet | null,
  defaultId: string,
  defaultRevision: number,
): void {
  if (approved.length === 0 || new Set(approved).size !== approved.length) throw new Error('approved roster list must be unique and non-empty');
  for (const hash of approved) assertRosterSha256(hash, 'approved_roster_sha256s');
  if (!approved.includes(defaultHash)) throw new Error('default roster hash must be approved');
  if (candidateSet === null) return;
  const candidateHashes = candidateSet.candidates.map((candidate) => candidate.roster_sha256);
  for (const hash of approved) {
    if (!candidateHashes.includes(hash)) throw new Error('approved roster hash absent from candidate set');
  }
  const defaultMatches = candidateSet.candidates.filter((candidate) =>
    candidate.roster_id === defaultId &&
    candidate.roster_revision === defaultRevision &&
    candidate.roster_sha256 === defaultHash,
  );
  if (defaultMatches.length !== 1) throw new Error('default roster tuple absent from candidate set');
}

function requireRosterSha256(value: string | undefined, label: string): RosterSha256 {
  if (value === undefined) throw new Error(`${label} required`);
  assertRosterSha256(value, label);
  return value;
}

type RosterSetupDiagnosticCode =
  | 'ROSTER_AUTH_CHANNEL_FORBIDDEN'
  | 'ROSTER_AUTH_REQUIRED'
  | 'ROSTER_APPROVAL_STALE_CANDIDATE_SET'
  | 'ROSTER_APPROVAL_STALE_CONFIG'
  | 'ROSTER_EXPLICIT_CHOICE_REQUIRED'
  | 'ROSTER_PROPOSAL_REJECTED'
  | 'ROSTER_RECEIPT_REPLAY_REQUIRED'
  | 'ROSTER_TRANSITION_REQUIRED';

function diagnostics(codes: readonly RosterSetupDiagnosticCode[]): readonly RosterStorageDiagnostic[] {
  const unique = [...new Set(codes)].sort((left, right) => left.localeCompare(right));
  return Object.freeze(unique.map((code) => Object.freeze({
    code,
    severity: severityForCode(code),
    message: messageForCode(code),
    remediation: 'Re-present the exact roster setup restatement and retry only after explicit host authorization in a fresh Pi session when required.',
    secret_free: true as const,
  })));
}

function mergeDiagnostics(
  left: readonly RosterStorageDiagnostic[],
  right: readonly RosterStorageDiagnostic[],
): readonly RosterStorageDiagnostic[] {
  const byCode = new Map<string, RosterStorageDiagnostic>();
  for (const item of left) byCode.set(item.code, item);
  for (const item of right) byCode.set(item.code, item);
  return Object.freeze([...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)));
}

function hasDiagnostic(diagnosticsToSearch: readonly RosterStorageDiagnostic[], code: string): boolean {
  return diagnosticsToSearch.some((item) => item.code === code);
}

function severityForCode(code: RosterSetupDiagnosticCode): RosterStorageDiagnostic['severity'] {
  if (code === 'ROSTER_PROPOSAL_REJECTED') return 'info';
  if (code === 'ROSTER_RECEIPT_REPLAY_REQUIRED') return 'error';
  return 'error';
}

function messageForCode(code: RosterSetupDiagnosticCode): string {
  switch (code) {
    case 'ROSTER_AUTH_CHANNEL_FORBIDDEN':
      return 'Roster setup approval cannot bind an unsafe or non-/autopilot original invocation.';
    case 'ROSTER_AUTH_REQUIRED':
      return 'Roster setup save requires explicit host authorization after exact restatement proof.';
    case 'ROSTER_APPROVAL_STALE_CANDIDATE_SET':
      return 'Roster setup candidate inventory or approved roster set changed before save.';
    case 'ROSTER_APPROVAL_STALE_CONFIG':
      return 'Roster setup config authority changed after presentation and must be re-presented.';
    case 'ROSTER_EXPLICIT_CHOICE_REQUIRED':
      return 'Roster setup refinement requires a new explicit qualified choice before approval.';
    case 'ROSTER_PROPOSAL_REJECTED':
      return 'Roster setup proposal was rejected without persistent writes.';
    case 'ROSTER_RECEIPT_REPLAY_REQUIRED':
      return 'Roster config publication was proven but setup receipt emission must be replayed in a fresh session.';
    case 'ROSTER_TRANSITION_REQUIRED':
      return 'Roster setup state forbids same-session auto-start or repeated save.';
  }
}
