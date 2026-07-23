import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  autopilotRosterContractCanonicalJson,
  autopilotRosterContractHashField,
  autopilotRosterContractSha256OmittingOwnField,
  parseAutopilotRosterContract,
  type AutopilotRosterContractBySchemaVersion,
  type AutopilotRosterContractSchemaVersion,
} from '../../src/core/roster/contracts.ts';
import {
  fakeInventoryFromProviders,
  getProviderRecipe,
  seedRosterByCandidate,
  type EvidenceRef,
  type ProviderRecipe,
  type QualificationManifest,
  type RoleTemplate,
  type RosterCandidate,
  type RosterCandidateSet,
} from '../../src/core/roster/provider-recipes.ts';
import {
  PHASE37_FIXTURE_CLOCK,
  PHASE37_PACKAGE_VERSION,
  PHASE37_PI_VERSION,
  ROSTER_ROLE_ORDER,
  canonicalSha256,
  type Digest,
  type InventoryProvider,
  type RosterInventory,
  type RosterRole,
} from '../../src/core/roster/route-policies.ts';
import { createRosterSetupApprovalSession, type RosterSetupApprovalSaveResult, type RosterSetupApprovalSession } from '../../src/core/roster/setup-approval.ts';
import { createRosterSetupReceiptFactory, type AutopilotRosterSetupReceipt } from '../../src/core/roster/setup-receipt.ts';
import { createAutopilotRosterSetupTool } from '../../src/core/roster/setup-tool.ts';
import {
  formatAuthorityPath,
  resolveRosterScopePaths,
  rosterRevisionPath,
  RosterStorage,
  type PreRunSelectionAuthorityProjection,
  type RosterAuthorityProjection,
  type RosterConfigAuthorityProjection,
  type RosterReceiptBuildInput,
  type RosterSha256,
  type RosterStorageCodec,
  type RosterStorageScope,
  type SavedRosterRef,
} from '../../src/core/roster/storage.ts';
import {
  AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY,
  AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH,
  AUTOPILOT_ROSTER_SETUP_SKILL_NAME,
} from '../../src/core/roster/skill-package.ts';
import { KIMI_CODING_REQUIRED_EVIDENCE_REFS } from '../../src/core/roster/providers/kimi-coding.ts';

export const ROSTER_SETUP_TOOL_NAME = 'autopilot_manage_rosters' as const;
export const ROSTER_TOOL_REQUEST_SCHEMA = 'autopilot.roster_tool_request.v1' as const;
export const ROSTER_TOOL_RESULT_SCHEMA = 'autopilot.roster_tool_result.v1' as const;
export const SAFE_ORIGINAL_COMMAND = '/autopilot phase37-w2 proof-lane' as const;
export const SECRET_MARKER = 'phase37-secret-token-should-not-appear' as const;

const ZERO_SHA = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as RosterSha256;
const FIXED_RECEIPT_TIME = '2026-07-22T12:00:05.000Z';

export const EXPECTED_ROSTER_TOOL_PARAMETER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'string', enum: [ROSTER_TOOL_REQUEST_SCHEMA] },
    action: { type: 'string', enum: ['inspect', 'propose', 'refine', 'save', 'reject', 'doctor'] },
    activation_token: { type: 'string', minLength: 16, maxLength: 200, pattern: '^[A-Za-z0-9._:-]{16,200}$' },
    approval_token: { anyOf: [{ type: 'string', minLength: 16, maxLength: 200, pattern: '^[A-Za-z0-9._:-]{16,200}$' }, { type: 'null' }] },
    scope: { type: 'string', enum: ['user', 'trusted-project'] },
    trusted_project_root: { anyOf: [{ type: 'string', minLength: 1, maxLength: 4096 }, { type: 'null' }] },
    candidate_set_sha256: { anyOf: [{ type: 'string', minLength: 71, maxLength: 71, pattern: '^sha256:[a-f0-9]{64}$' }, { type: 'null' }] },
    approved_roster_sha256s: { type: 'array', minItems: 0, maxItems: 16, uniqueItems: true, items: { type: 'string', minLength: 71, maxLength: 71, pattern: '^sha256:[a-f0-9]{64}$' } },
    default_roster_id: { anyOf: [{ type: 'string', minLength: 1, maxLength: 96, pattern: '^[a-z][a-z0-9-]{0,95}$' }, { type: 'null' }] },
    default_roster_revision: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    default_roster_sha256: { anyOf: [{ type: 'string', minLength: 71, maxLength: 71, pattern: '^sha256:[a-f0-9]{64}$' }, { type: 'null' }] },
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

export interface JsonMap {
  readonly [key: string]: unknown;
}

export interface RosterToolRequestLike extends JsonMap {
  readonly schema_version: typeof ROSTER_TOOL_REQUEST_SCHEMA;
  readonly action: string;
  readonly activation_token: string;
  readonly approval_token: string | null;
  readonly scope: RosterStorageScope;
  readonly trusted_project_root: string | null;
  readonly candidate_set_sha256: Digest | null;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string | null;
  readonly default_roster_revision: number | null;
  readonly default_roster_sha256: Digest | null;
  readonly original_command: string;
}

type SetupBundle = ReturnType<typeof createAutopilotRosterSetupTool>;
export type RosterSetupToolDefinition = SetupBundle['tool'];
export type RosterToolResult = Awaited<ReturnType<SetupBundle['tool']['execute']>>['details'];
export type RosterToolTextResult = Awaited<ReturnType<SetupBundle['tool']['execute']>>;
export type RosterSetupReceipt = AutopilotRosterSetupReceipt;

type ReceiptEmission = ReturnType<ReturnType<typeof createRosterSetupReceiptFactory>>;

type RosterContractObject = Readonly<Record<string, unknown>>;

export interface ApprovalFields {
  readonly scope: RosterStorageScope;
  readonly candidate_set_sha256: Digest;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
  readonly original_command: string;
}

export interface HostApproval extends ApprovalFields {
  readonly approval_token: string;
  readonly restatement_proof_sha256: RosterSha256;
}

export interface FakeSideEffectCounters {
  readonly runStarts: number;
  readonly worktreeMutations: number;
  readonly coordinatorQueries: number;
  readonly modelInvocations: number;
  readonly credentialResolutions: number;
  readonly credentialResolutionLabels: readonly string[];
  readonly modelCatalogReads: number;
  readonly authStatusReads: number;
  readonly toolExecutions: number;
  readonly saveCapabilityCalls: number;
}

interface MutableSideEffectCounters {
  runStarts: number;
  worktreeMutations: number;
  coordinatorQueries: number;
  modelInvocations: number;
  credentialResolutions: number;
  credentialResolutionLabels: string[];
  modelCatalogReads: number;
  authStatusReads: number;
  toolExecutions: number;
  saveCapabilityCalls: number;
}

interface FakePiModel {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap: Readonly<Record<string, string | null>>;
  readonly input: readonly string[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

interface FakeAuthStatus {
  readonly configured: boolean;
  readonly source: 'stored' | 'runtime' | 'environment';
}

export class FakeRosterModelRegistry {
  readonly #models: readonly FakePiModel[];
  readonly #counters: MutableSideEffectCounters;

  public constructor(counters: MutableSideEffectCounters, models: readonly FakePiModel[] = codexPiModels()) {
    this.#counters = counters;
    this.#models = Object.freeze(models.map((model) => Object.freeze({ ...model, input: Object.freeze([...model.input]), thinkingLevelMap: Object.freeze({ ...model.thinkingLevelMap }) })));
  }

  public getAll(): readonly FakePiModel[] {
    this.#counters.modelCatalogReads += 1;
    return this.#models;
  }

  public getProviderAuthStatus(provider: string): FakeAuthStatus {
    this.#counters.authStatusReads += 1;
    if (provider === 'openai-codex') return { configured: true, source: 'stored' };
    return { configured: false, source: 'stored' };
  }

  public getApiKeyAndHeaders(provider: string): never {
    this.#recordCredentialResolution(`getApiKeyAndHeaders:${provider}`);
  }

  public getApiKeyForProvider(provider: string): never {
    this.#recordCredentialResolution(`getApiKeyForProvider:${provider}`);
  }

  public getProviderAuth(provider: string): never {
    this.#recordCredentialResolution(`getProviderAuth:${provider}`);
  }

  public invokeModel(): never {
    this.#counters.modelInvocations += 1;
    throw new Error('fake roster setup harness forbids model invocation');
  }

  #recordCredentialResolution(label: string): never {
    this.#counters.credentialResolutions += 1;
    this.#counters.credentialResolutionLabels.push(label);
    throw new Error(`credential resolution is forbidden in roster setup proof lane: ${label} ${SECRET_MARKER}`);
  }
}

export class FakeProjectTrust {
  #trusted: boolean;
  public calls = 0;

  public constructor(trusted: boolean) {
    this.#trusted = trusted;
  }

  public setTrusted(trusted: boolean): void {
    this.#trusted = trusted;
  }

  public isProjectTrusted(): boolean {
    this.calls += 1;
    return this.#trusted;
  }
}

export class FakePiSdkSession {
  readonly #tools = new Map<string, RosterSetupToolDefinition>();
  readonly #activeTools = new Set<string>();
  readonly #counters: MutableSideEffectCounters;
  #toolCallCounter = 0;

  public constructor(counters: MutableSideEffectCounters) {
    this.#counters = counters;
  }

  public registerTool(tool: RosterSetupToolDefinition): void {
    this.#tools.set(tool.name, tool);
  }

  public getToolDefinition(name: string): RosterSetupToolDefinition | undefined {
    return this.#tools.get(name);
  }

  public getAllTools(): readonly RosterSetupToolDefinition[] {
    return Object.freeze([...this.#tools.values()]);
  }

  public getActiveTools(): readonly string[] {
    return Object.freeze([...this.#activeTools]);
  }

  public setActiveTools(names: readonly string[]): void {
    this.#activeTools.clear();
    for (const name of names) {
      if (this.#tools.has(name)) this.#activeTools.add(name);
    }
  }

  public isToolActive(name: string): boolean {
    return this.#activeTools.has(name);
  }

  public async executeTool(name: string, params: unknown, ctx: unknown): Promise<RosterToolTextResult> {
    const tool = this.#tools.get(name);
    if (tool === undefined || !this.#activeTools.has(name)) throw new Error(`tool unavailable or inactive: ${name}`);
    this.#counters.toolExecutions += 1;
    this.#toolCallCounter += 1;
    return await tool.execute(`fake-tool-call-${this.#toolCallCounter}`, params, undefined, undefined, ctx);
  }

  public startRun(): never {
    this.#counters.runStarts += 1;
    throw new Error('fake roster setup harness forbids run starts');
  }

  public mutateWorktree(): never {
    this.#counters.worktreeMutations += 1;
    throw new Error('fake roster setup harness forbids worktree mutation');
  }

  public queryCoordinator(): never {
    this.#counters.coordinatorQueries += 1;
    throw new Error('fake roster setup harness forbids coordinator queries');
  }
}

export interface RosterSetupHarnessOptions {
  readonly projectTrusted?: boolean | undefined;
  readonly originalCommand?: string | undefined;
  readonly inventory?: RosterInventory | undefined;
  readonly qualificationManifests?: readonly QualificationManifest[] | undefined;
}

export class RosterSetupHarness {
  public readonly root: string;
  public readonly projectRoot: string;
  public readonly stateRoot: string;
  public readonly originalCommand: string;
  public readonly counters: MutableSideEffectCounters;
  public readonly modelRegistry: FakeRosterModelRegistry;
  public readonly trust: FakeProjectTrust;
  public readonly pi: FakePiSdkSession;
  public readonly storage: RosterStorage<AutopilotRosterSetupReceipt>;
  public readonly inventoryOverride: RosterInventory | undefined;
  public readonly qualificationManifests: readonly QualificationManifest[];
  public readonly bundle: SetupBundle;

  #activationToken: string | null = null;
  #approvalSession: RosterSetupApprovalSession<AutopilotRosterSetupReceipt> | null = null;
  #lastApprovalSaveResult: RosterSetupApprovalSaveResult<AutopilotRosterSetupReceipt> | null = null;

  private constructor(input: {
    readonly root: string;
    readonly projectRoot: string;
    readonly stateRoot: string;
    readonly originalCommand: string;
    readonly projectTrusted: boolean;
    readonly inventory?: RosterInventory | undefined;
    readonly qualificationManifests?: readonly QualificationManifest[] | undefined;
  }) {
    this.root = input.root;
    this.projectRoot = input.projectRoot;
    this.stateRoot = input.stateRoot;
    this.originalCommand = input.originalCommand;
    this.counters = {
      runStarts: 0,
      worktreeMutations: 0,
      coordinatorQueries: 0,
      modelInvocations: 0,
      credentialResolutions: 0,
      credentialResolutionLabels: [],
      modelCatalogReads: 0,
      authStatusReads: 0,
      toolExecutions: 0,
      saveCapabilityCalls: 0,
    };
    this.modelRegistry = new FakeRosterModelRegistry(this.counters);
    this.trust = new FakeProjectTrust(input.projectTrusted);
    this.pi = new FakePiSdkSession(this.counters);
    this.storage = new RosterStorage({ codec: rosterSetupCodec, stateRoot: input.stateRoot });
    this.inventoryOverride = input.inventory;
    this.qualificationManifests = Object.freeze([...(input.qualificationManifests ?? [])]);
    this.bundle = createAutopilotRosterSetupTool({
      ...(this.inventoryOverride === undefined ? {} : { inventory: this.inventoryOverride }),
      qualificationManifests: this.qualificationManifests,
      saveApproved: async (saveInput) => await this.#saveApproved(saveInput),
    });
  }

  public static async create(options: RosterSetupHarnessOptions = {}): Promise<RosterSetupHarness> {
    const tempRoot = await realpath(tmpdir());
    const root = await mkdtemp(join(tempRoot, 'roster-setup-w2-'));
    const projectRoot = join(root, 'project');
    const stateRoot = join(root, 'state');
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    return new RosterSetupHarness({
      root,
      projectRoot,
      stateRoot,
      originalCommand: options.originalCommand ?? SAFE_ORIGINAL_COMMAND,
      projectTrusted: options.projectTrusted ?? true,
      inventory: options.inventory,
      qualificationManifests: options.qualificationManifests,
    });
  }

  public async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  public get activationToken(): string | null {
    return this.#activationToken;
  }

  public get lastApprovalSaveResult(): RosterSetupApprovalSaveResult<AutopilotRosterSetupReceipt> | null {
    return this.#lastApprovalSaveResult;
  }

  public context(): { readonly modelRegistry: FakeRosterModelRegistry; readonly isProjectTrusted: () => boolean; readonly cwd: string } {
    return {
      modelRegistry: this.modelRegistry,
      isProjectTrusted: () => this.trust.isProjectTrusted(),
      cwd: this.projectRoot,
    };
  }

  public directRequest(action: string, overrides: Partial<RosterToolRequestLike> = {}): RosterToolRequestLike {
    return rosterToolRequest(this.#activationToken ?? 'setup:inactive-token-000000000000000000000000', action, {
      original_command: this.originalCommand,
      ...overrides,
    });
  }

  public activateSetup(): string {
    const activation = this.bundle.controller.activate('fake-pi-sdk-roster-setup-session');
    if (!activation.ok || activation.activation_token === null) throw new Error(`setup activation failed: ${activation.reason}`);
    this.#activationToken = activation.activation_token;
    this.pi.registerTool(this.bundle.tool);
    this.pi.setActiveTools([...this.pi.getActiveTools(), this.bundle.tool.name]);
    return activation.activation_token;
  }

  public async invoke(action: string, overrides: Partial<RosterToolRequestLike> = {}): Promise<RosterToolResult> {
    const output = await this.pi.executeTool(ROSTER_SETUP_TOOL_NAME, this.directRequest(action, overrides), this.context());
    return output.details;
  }

  public async invokeRaw(params: unknown): Promise<RosterToolResult> {
    const output = await this.pi.executeTool(ROSTER_SETUP_TOOL_NAME, params, this.context());
    return output.details;
  }

  public hostApprove(proposal: RosterToolResult, overrides: Partial<ApprovalFields> = {}): HostApproval {
    const candidateSet = requireCandidateSet(proposal);
    const fields = { ...approvalFieldsForCandidateSet(candidateSet, this.originalCommand), ...overrides };
    this.#approvalSession = createRosterSetupApprovalSession({
      originalCommand: fields.original_command,
      storage: this.storage,
    });
    const presented = this.#approvalSession.present({
      scope: fields.scope,
      candidateSet,
      approved_roster_sha256s: fields.approved_roster_sha256s,
      default_roster_id: fields.default_roster_id,
      default_roster_revision: fields.default_roster_revision,
      default_roster_sha256: fields.default_roster_sha256,
      expected_previous_config_sha256: null,
    });
    if (!presented.ok || presented.restatement_proof === null) {
      throw new Error(`host approval presentation failed: ${JSON.stringify(presented)}`);
    }
    const authorized = this.#approvalSession.authorize({
      restatement_proof_sha256: presented.restatement_proof.proof_sha256,
      host_authorized: true,
      authorization_source: 'explicit-host-authorization-after-restatement',
    });
    if (!authorized.ok) throw new Error(`host authorization failed: ${JSON.stringify(authorized)}`);
    if (this.#activationToken === null) throw new Error('setup must be active before controller approval');
    const controllerApproval = this.bundle.hostAuthorization.authorizeInput({
      activation_token: this.#activationToken,
      source: 'user',
      text: 'use your recommendation',
    });
    if (!controllerApproval.ok || controllerApproval.approval_token === null) {
      throw new Error(`controller approval failed: ${controllerApproval.reason}`);
    }
    return Object.freeze({
      ...fields,
      approval_token: controllerApproval.approval_token,
      restatement_proof_sha256: presented.restatement_proof.proof_sha256,
    });
  }

  public async saveWithApproval(approval: HostApproval, overrides: Partial<RosterToolRequestLike> = {}): Promise<RosterToolResult> {
    return await this.invoke('save', {
      scope: approval.scope,
      approval_token: approval.approval_token,
      candidate_set_sha256: approval.candidate_set_sha256,
      approved_roster_sha256s: approval.approved_roster_sha256s,
      default_roster_id: approval.default_roster_id,
      default_roster_revision: approval.default_roster_revision,
      default_roster_sha256: approval.default_roster_sha256,
      original_command: approval.original_command,
      ...overrides,
    });
  }

  public sideEffectsSnapshot(): FakeSideEffectCounters {
    return Object.freeze({
      runStarts: this.counters.runStarts,
      worktreeMutations: this.counters.worktreeMutations,
      coordinatorQueries: this.counters.coordinatorQueries,
      modelInvocations: this.counters.modelInvocations,
      credentialResolutions: this.counters.credentialResolutions,
      credentialResolutionLabels: Object.freeze([...this.counters.credentialResolutionLabels]),
      modelCatalogReads: this.counters.modelCatalogReads,
      authStatusReads: this.counters.authStatusReads,
      toolExecutions: this.counters.toolExecutions,
      saveCapabilityCalls: this.counters.saveCapabilityCalls,
    });
  }

  public async publishedConfig(): Promise<RosterConfigAuthorityProjection> {
    const paths = resolveRosterScopePaths({ scope: 'user', stateRoot: this.stateRoot });
    const parsed = parseJsonRecord(await readFile(paths.configPath, 'utf8'), 'published config');
    const config = parseAutopilotRosterContract('autopilot.roster_config.v1', parsed);
    return configProjection(config);
  }

  public async stateFiles(): Promise<readonly string[]> {
    return await listFiles(this.stateRoot);
  }

  async #saveApproved(input: Parameters<NonNullable<NonNullable<Parameters<typeof createAutopilotRosterSetupTool>[0]>['saveApproved']>>[0]): Promise<ReturnType<NonNullable<NonNullable<Parameters<typeof createAutopilotRosterSetupTool>[0]>['saveApproved']>>> {
    this.counters.saveCapabilityCalls += 1;
    if (this.#approvalSession === null) {
      return {
        ok: false,
        status: 'blocked',
        receipt: null,
        diagnostics: [{ code: 'ROSTER_AUTH_REQUIRED', secret_free: true }],
        write_count: 0,
        lock_count: 0,
        files_touched: [],
      };
    }
    const rosterBytes = rosterBytesForApprovedCandidates(input.candidate_set, input.approved_roster_sha256s);
    const configBytes = configBytesForSave({
      stateRoot: this.stateRoot,
      scope: input.request.scope,
      rosterBytes,
      default_roster_id: input.default_roster_id,
      default_roster_revision: input.default_roster_revision,
      default_roster_sha256: input.default_roster_sha256 as RosterSha256,
      previous_config_sha256: null,
    });
    const saved = await this.#approvalSession.save({
      roster_bytes: rosterBytes,
      config_bytes: configBytes,
      current_candidate_set: input.candidate_set,
      current_candidate_set_sha256: input.candidate_set.candidate_set_sha256 as RosterSha256,
      current_inventory_sha256: input.candidate_set.inventory_sha256 as RosterSha256,
      current_recipe_registry_sha256: input.candidate_set.recipe_registry_sha256 as RosterSha256,
      current_previous_config_sha256: null,
    });
    this.#lastApprovalSaveResult = saved;
    return {
      ok: saved.ok,
      status: saved.status,
      receipt: saved.receipt?.receipt ?? null,
      diagnostics: saved.diagnostics,
      write_count: saved.write_count,
      lock_count: saved.lock_count,
      files_touched: saved.files_touched,
    };
  }
}

export async function withRosterSetupHarness<T>(run: (harness: RosterSetupHarness) => Promise<T>, options: RosterSetupHarnessOptions = {}): Promise<T> {
  const harness = await RosterSetupHarness.create(options);
  try {
    return await run(harness);
  } finally {
    await harness.dispose();
  }
}

export interface FakeJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface FakeJsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly result: unknown;
}

export interface FakeJsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: string | null;
  readonly error: FakeJsonRpcError;
}

export type FakeJsonRpcResponse = FakeJsonRpcSuccess | FakeJsonRpcFailure;

export class FakeRosterJsonRpcHarness {
  readonly #harness: RosterSetupHarness;
  readonly #seenIds = new Set<string>();
  #inFlight = false;

  public constructor(harness: RosterSetupHarness) {
    this.#harness = harness;
  }

  public async handleLine(line: string): Promise<FakeJsonRpcResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return rpcError(null, -32700, 'parse error: malformed JSONL record');
    }
    return await this.handleCommand(parsed);
  }

  public async handleCommand(command: unknown): Promise<FakeJsonRpcResponse> {
    if (!isJsonMap(command)) return rpcError(null, -32600, 'invalid request: command must be an object');
    const id = command['id'];
    if (typeof id !== 'string' || id.length === 0) return rpcError(null, -32600, 'invalid request: id must be a non-empty string');
    if (this.#seenIds.has(id)) return rpcError(id, -32001, 'duplicate or replayed request id rejected');
    const jsonrpc = command['jsonrpc'];
    const method = command['method'];
    if (jsonrpc !== '2.0' || typeof method !== 'string') {
      this.#seenIds.add(id);
      return rpcError(id, -32600, 'invalid request: jsonrpc and method are required');
    }

    if (method === 'tools/list') {
      this.#seenIds.add(id);
      return rpcResult(id, {
        tools: this.#harness.pi.getAllTools()
          .filter((tool) => this.#harness.pi.isToolActive(tool.name))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
      });
    }

    if (method !== 'tools/call') {
      this.#seenIds.add(id);
      return rpcError(id, -32601, `method not found: ${method}`);
    }

    if (this.#inFlight) {
      this.#seenIds.add(id);
      return rpcError(id, -32002, 'concurrent tool calls are rejected closed');
    }

    const params = command['params'];
    if (!isJsonMap(params) || typeof params['name'] !== 'string' || !Object.prototype.hasOwnProperty.call(params, 'arguments')) {
      this.#seenIds.add(id);
      return rpcError(id, -32602, 'invalid params: tools/call requires name and arguments');
    }
    const toolName = params['name'];
    if (this.#harness.pi.getToolDefinition(toolName) === undefined || !this.#harness.pi.isToolActive(toolName)) {
      this.#seenIds.add(id);
      return rpcError(id, -32003, `tool unavailable or inactive: ${toolName}`);
    }

    this.#seenIds.add(id);
    this.#inFlight = true;
    try {
      const output = await this.#harness.pi.executeTool(toolName, params['arguments'], this.#harness.context());
      return rpcResult(id, { content: output.content, details: output.details });
    } catch (_error) {
      return rpcError(id, -32004, 'tool execution failed closed');
    } finally {
      this.#inFlight = false;
    }
  }
}

export interface FakePackedSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly disableModelInvocation: boolean;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export async function discoverPackedRosterSetupSkill(packageRoot = packageRootPath()): Promise<readonly FakePackedSkill[]> {
  const manifest = parseJsonRecord(await readFile(join(packageRoot, 'package.json'), 'utf8'), 'package manifest');
  const pi = requireRecord(manifest['pi'], 'package manifest pi');
  const skills = pi['skills'];
  if (!Array.isArray(skills) || !skills.every((entry) => typeof entry === 'string')) {
    throw new TypeError('package pi.skills must be a string array');
  }
  const discovered: FakePackedSkill[] = [];
  for (const entry of skills) {
    const skillDir = resolve(packageRoot, entry);
    if (!isInside(packageRoot, skillDir)) throw new Error(`skill entry escapes package root: ${entry}`);
    const skillPath = join(skillDir, 'SKILL.md');
    const bytes = await readFile(skillPath);
    const frontmatter = parseSkillFrontmatter(Buffer.from(bytes).toString('utf8'), skillPath);
    discovered.push(Object.freeze({
      name: requiredFrontmatterString(frontmatter, 'name', skillPath),
      description: requiredFrontmatterString(frontmatter, 'description', skillPath),
      filePath: skillPath,
      baseDir: skillDir,
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      bytes,
      sha256: sha256(bytes),
    }));
  }
  return Object.freeze(discovered);
}

export function packageRootPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireCandidateSet(result: RosterToolResult): RosterCandidateSet {
  if (result.candidate_set === null) throw new Error('expected candidate set');
  return result.candidate_set as RosterCandidateSet;
}

export function diagnosticCodes(result: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
  return Object.freeze(result.diagnostics.map((diagnostic) => diagnostic.code));
}

export function approvalFieldsForCandidateSet(candidateSet: RosterCandidateSet, originalCommand: string = SAFE_ORIGINAL_COMMAND): ApprovalFields {
  const defaultCandidate = candidateSet.candidates.find((candidate) => candidate.profile_id === 'cruise') ?? candidateSet.candidates[0];
  if (defaultCandidate === undefined) throw new Error('candidate set must not be empty');
  return Object.freeze({
    scope: candidateSet.scope,
    candidate_set_sha256: candidateSet.candidate_set_sha256,
    approved_roster_sha256s: Object.freeze(candidateSet.candidates.map((candidate) => candidate.roster_sha256)),
    default_roster_id: defaultCandidate.roster_id,
    default_roster_revision: defaultCandidate.roster_revision,
    default_roster_sha256: defaultCandidate.roster_sha256,
    original_command: originalCommand,
  });
}

export function rosterToolRequest(token: string, action: string, overrides: Partial<RosterToolRequestLike> = {}): RosterToolRequestLike {
  return Object.freeze({
    schema_version: ROSTER_TOOL_REQUEST_SCHEMA,
    action,
    activation_token: token,
    approval_token: null,
    scope: 'user',
    trusted_project_root: null,
    candidate_set_sha256: null,
    approved_roster_sha256s: Object.freeze([]),
    default_roster_id: null,
    default_roster_revision: null,
    default_roster_sha256: null,
    original_command: SAFE_ORIGINAL_COMMAND,
    ...overrides,
  });
}

export function assertSecretFree(value: unknown, secret = SECRET_MARKER): void {
  const text = JSON.stringify(value);
  if (text.includes(secret)) throw new Error('secret marker leaked into roster setup result');
  for (const forbidden of ['api_key', 'oauth_token', 'access_token', 'authorization', 'password', 'credential_secret']) {
    if (new RegExp(forbidden, 'iu').test(text)) throw new Error(`forbidden secret-adjacent field leaked: ${forbidden}`);
  }
}

export function assertNoRunWorktreeCoordinatorOrSpend(counters: FakeSideEffectCounters): void {
  const forbidden = {
    runStarts: counters.runStarts,
    worktreeMutations: counters.worktreeMutations,
    coordinatorQueries: counters.coordinatorQueries,
    modelInvocations: counters.modelInvocations,
    credentialResolutions: counters.credentialResolutions,
  };
  for (const [name, value] of Object.entries(forbidden)) {
    if (value !== 0) throw new Error(`unexpected ${name} side effect count ${String(value)}`);
  }
}

export function jsonRpcToolCall(id: string, args: unknown, name = ROSTER_SETUP_TOOL_NAME): JsonMap {
  return Object.freeze({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: Object.freeze({ name, arguments: args }),
  });
}

export function jsonRpcListTools(id: string): JsonMap {
  return Object.freeze({ jsonrpc: '2.0', id, method: 'tools/list', params: Object.freeze({}) });
}

export function isRpcFailure(response: FakeJsonRpcResponse): response is FakeJsonRpcFailure {
  return Object.prototype.hasOwnProperty.call(response, 'error');
}

export function isRpcSuccess(response: FakeJsonRpcResponse): response is FakeJsonRpcSuccess {
  return Object.prototype.hasOwnProperty.call(response, 'result');
}

export function rpcToolResult(response: FakeJsonRpcResponse): RosterToolResult {
  if (!isRpcSuccess(response) || !isJsonMap(response.result)) throw new Error(`expected successful tool response: ${JSON.stringify(response)}`);
  const details = response.result['details'];
  if (!isJsonMap(details)) throw new Error('successful tool response is missing details');
  return details as unknown as RosterToolResult;
}

export function rpcListedTools(response: FakeJsonRpcResponse): readonly JsonMap[] {
  if (!isRpcSuccess(response) || !isJsonMap(response.result)) throw new Error(`expected tools/list success: ${JSON.stringify(response)}`);
  const tools = response.result['tools'];
  if (!Array.isArray(tools) || !tools.every(isJsonMap)) throw new TypeError('tools/list result must contain object tools');
  return Object.freeze(tools);
}

function codexPiModels(): readonly FakePiModel[] {
  const recipe = mustRecipe('codex-subscription');
  const provider = providerForRecipe(recipe);
  return Object.freeze(provider.models.map((model) => Object.freeze({
    provider: recipe.provider_family,
    id: model.model_id,
    api: model.api,
    reasoning: model.reasoning_capability === 'reasoning-supported',
    thinkingLevelMap: Object.freeze({ high: 'high', xhigh: model.thinking_values.includes('xhigh') ? 'xhigh' : null }),
    input: Object.freeze([...model.input_modalities]),
    contextWindow: model.context_window,
    maxTokens: model.max_output_tokens,
  })));
}

function mustRecipe(recipeId: string): ProviderRecipe {
  const recipe = getProviderRecipe(recipeId, 1);
  if (recipe === null) throw new Error(`missing provider recipe ${recipeId}`);
  return recipe;
}

function providerForRecipe(recipe: ProviderRecipe): InventoryProvider {
  const byModel = new Map<string, RoleTemplate[]>();
  for (const profile of recipe.profile_templates) {
    for (const roleTemplate of profile.role_templates) {
      const key = `${roleTemplate.model_id}:${roleTemplate.api}`;
      byModel.set(key, [...(byModel.get(key) ?? []), roleTemplate]);
    }
  }
  return {
    provider_id: recipe.provider_family,
    auth_configured: true,
    auth_class: recipe.provider_family === 'openai-codex' ? 'oauth' : 'api-key-plan-token',
    auth_source: 'stored',
    auth_status: 'configured',
    is_using_oauth: recipe.provider_family === 'openai-codex',
    billing_route_class: recipe.provider_family === 'openai-codex' ? 'subscription-oauth' : 'plan-api-token',
    models: [...byModel.values()].map((templates) => {
      const first = templates[0];
      if (first === undefined) throw new Error('empty model template group');
      return {
        model_id: first.model_id,
        api: first.api,
        context_window: Math.max(...templates.map((template) => template.context_window)),
        max_output_tokens: Math.max(...templates.map((template) => template.max_output_tokens)),
        input_modalities: [...new Set(templates.flatMap((template) => [...template.input_modalities]))].sort(),
        output_modalities: [...new Set(templates.flatMap((template) => [...template.output_modalities]))].sort(),
        reasoning_capability: first.reasoning_capability,
        tool_capability: first.tool_capability,
        thinking_values: [...new Set(templates.map((template) => template.thinking))].sort(),
        service_tiers: [...new Set(templates.map((template) => template.service_tier))].sort((left, right) => {
          if (left === right) return 0;
          if (left === null) return -1;
          if (right === null) return 1;
          return left.localeCompare(right);
        }),
        cache_policies: [...new Set(templates.map((template) => template.cache_policy))].sort(),
        system_prompt_profiles: [...new Set(templates.map((template) => template.system_prompt_profile))].sort(),
      };
    }),
  };
}

export function codexRosterInventory(): RosterInventory {
  return fakeInventoryFromProviders({
    inventory_id: 'inventory-roster-setup-w2-codex',
    providers: [providerForRecipe(mustRecipe('codex-subscription'))],
  });
}

export function kimiRosterInventory(): RosterInventory {
  return fakeInventoryFromProviders({
    inventory_id: 'inventory-roster-setup-w4-kimi',
    providers: [providerForRecipe(mustRecipe('kimi-coding-plan'))],
  });
}

export function trustedKimiW4ManifestFixture(): { readonly manifest: QualificationManifest } {
  const recipe = mustRecipe('kimi-coding-plan');
  const route = liveW3EvidenceRef('kimi-coding-plan-entitlement-proof', 'route-proof', 'plan-entitlement');
  const billing = liveW3EvidenceRef('kimi-coding-billing-route-proof', 'billing-proof', 'billing-route');
  const roleRefs = new Map<RosterRole, EvidenceRef>(ROSTER_ROLE_ORDER.map((role) => [
    role,
    liveW3EvidenceRef(`kimi-coding-exec-${role}-proof`, 'execution-proof', `execution/${role}`),
  ]));
  const live_evidence = [route, billing, ...ROSTER_ROLE_ORDER.map((role) => {
    const ref = roleRefs.get(role);
    if (ref === undefined) throw new Error(`missing role ref ${role}`);
    return ref;
  })].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
  const withoutHash = {
    schema_version: 'autopilot.certification_manifest.v1' as const,
    manifest_id: 'kimi-coding-plan-w4-qualified-v1' as const,
    manifest_revision: 1,
    subject_kind: 'provider_recipe' as const,
    subject_id: 'kimi-coding-plan',
    subject_sha256: recipe.recipe_sha256,
    package_version: PHASE37_PACKAGE_VERSION,
    pi_version: PHASE37_PI_VERSION,
    qualification_state: 'w4-certified-ready' as const,
    role_results: ROSTER_ROLE_ORDER.map((role) => {
      const ref = roleRefs.get(role);
      if (ref === undefined) throw new Error(`missing role ref ${role}`);
      return { role, state: 'pass' as const, evidence_refs: [ref] };
    }),
    required_evidence: KIMI_CODING_REQUIRED_EVIDENCE_REFS,
    live_evidence,
    issued_at: '2026-07-23T00:00:00.000Z',
    expires_at: '2026-08-22T00:00:00.000Z',
  };
  const manifest = Object.freeze({ ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) }) satisfies QualificationManifest;
  return { manifest };
}

function liveW3EvidenceRef(evidence_id: string, kind: EvidenceRef['kind'], scope: string): EvidenceRef {
  const uri = `w3-evidence://phase37/kimi-coding/authenticated/no-fallback/${scope}`;
  return Object.freeze({
    evidence_id,
    kind,
    uri,
    sha256: canonicalSha256({ schema_version: 'autopilot.w3_evidence_ref_digest.v1', evidence_id, kind, uri, authenticated: true, no_fallback: true, package_version: PHASE37_PACKAGE_VERSION, pi_version: PHASE37_PI_VERSION }),
    byte_count: 128,
    secret_free: true,
  });
}

function rosterBytesForCandidateSet(candidateSet: RosterCandidateSet): readonly Uint8Array[] {
  return Object.freeze(candidateSet.candidates.map((candidate) => rosterBytesForCandidate(candidate)));
}

function rosterBytesForApprovedCandidates(candidateSet: RosterCandidateSet, approvedRosterSha256s: readonly Digest[]): readonly Uint8Array[] {
  const byHash = new Map(candidateSet.candidates.map((candidate) => [candidate.roster_sha256, candidate]));
  return Object.freeze(approvedRosterSha256s.map((sha) => {
    const candidate = byHash.get(sha);
    if (candidate === undefined) throw new Error(`approved candidate ${sha} missing from candidate set`);
    return rosterBytesForCandidate(candidate);
  }));
}

function rosterBytesForCandidate(candidate: RosterCandidate): Uint8Array {
  const roster = seedRosterByCandidate(candidate);
  if (roster === null) throw new Error(`missing seed roster for candidate ${candidate.candidate_id}`);
  if (roster.roster_sha256 !== candidate.roster_sha256) throw new Error(`candidate ${candidate.candidate_id} roster hash drifted`);
  return encodeContract(roster as unknown as RosterContractObject);
}

function configBytesForSave(input: {
  readonly stateRoot: string;
  readonly scope: RosterStorageScope;
  readonly rosterBytes: readonly Uint8Array[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: RosterSha256;
  readonly previous_config_sha256: RosterSha256 | null;
}): Uint8Array {
  const paths = resolveRosterScopePaths({ scope: input.scope, stateRoot: input.stateRoot });
  const rosters = input.rosterBytes.map((bytes) => rosterProjection(parseBytes('autopilot.roster.v1', bytes)));
  const saved = rosters.map((roster): SavedRosterRef => {
    const ref = {
      roster_id: roster.roster_id,
      roster_revision: roster.roster_revision,
      roster_sha256: roster.roster_sha256,
      assignment_set_sha256: roster.assignment_set_sha256,
    } satisfies SavedRosterRef;
    return Object.freeze({
      ...ref,
      path: formatAuthorityPath(rosterRevisionPath(paths, ref), paths.authorityRoot, paths.authorityDisplayRoot),
    });
  });
  const withoutHash = {
    schema_version: 'autopilot.roster_config.v1' as const,
    scope: input.scope,
    default_roster_id: input.default_roster_id,
    default_roster_revision: input.default_roster_revision,
    default_roster_sha256: input.default_roster_sha256,
    rosters: saved,
    previous_config_sha256: input.previous_config_sha256,
    updated_at: PHASE37_FIXTURE_CLOCK,
    config_sha256: ZERO_SHA,
  };
  const config = {
    ...withoutHash,
    config_sha256: autopilotRosterContractSha256OmittingOwnField(withoutHash, 'config_sha256') as RosterSha256,
  };
  return encodeContract(parseAutopilotRosterContract('autopilot.roster_config.v1', config));
}

const rosterSetupCodec: RosterStorageCodec<AutopilotRosterSetupReceipt> = Object.freeze({
  hashBytes(bytes: Uint8Array): RosterSha256 {
    const parsed = parseJsonRecord(Buffer.from(bytes).toString('utf8'), 'authority bytes');
    const schema = parsed['schema_version'];
    if (typeof schema !== 'string') throw new Error('authority bytes missing schema_version');
    const hashField = autopilotRosterContractHashField(schema as AutopilotRosterContractSchemaVersion);
    if (hashField === null) throw new Error(`authority schema ${schema} has no hash field`);
    return autopilotRosterContractSha256OmittingOwnField(parsed, hashField) as RosterSha256;
  },
  decodeRoster(bytes: Uint8Array): RosterAuthorityProjection {
    return rosterProjection(parseBytes('autopilot.roster.v1', bytes));
  },
  decodeConfig(bytes: Uint8Array): RosterConfigAuthorityProjection {
    return configProjection(parseBytes('autopilot.roster_config.v1', bytes));
  },
  decodeSelection(bytes: Uint8Array): PreRunSelectionAuthorityProjection {
    const parsed = parseBytes('autopilot.pre_run_selection.v1', bytes);
    return Object.freeze({
      repo_id: parsed.repo_id,
      workstream_run: parsed.workstream_run,
      scope: parsed.scope,
      roster_id: parsed.roster_id,
      roster_revision: parsed.roster_revision,
      roster_sha256: parsed.roster_sha256 as RosterSha256,
      assignment_set_sha256: parsed.assignment_set_sha256 as RosterSha256,
      config_sha256: parsed.config_sha256 as RosterSha256,
      selection_sha256: parsed.selection_sha256 as RosterSha256,
    });
  },
  createSetupReceipt(input: RosterReceiptBuildInput): ReceiptEmission {
    return createRosterSetupReceiptFactory({ clock: () => FIXED_RECEIPT_TIME, receiptId: 'receipt-phase37-w2-sdk' })(input);
  },
});

function parseBytes<Schema extends keyof AutopilotRosterContractBySchemaVersion>(schema: Schema, bytes: Uint8Array): AutopilotRosterContractBySchemaVersion[Schema] {
  return parseAutopilotRosterContract(schema, parseJsonRecord(Buffer.from(bytes).toString('utf8'), schema));
}

function encodeContract(value: unknown): Uint8Array {
  return new TextEncoder().encode(autopilotRosterContractCanonicalJson(value));
}

function rosterProjection(roster: AutopilotRosterContractBySchemaVersion['autopilot.roster.v1']): RosterAuthorityProjection {
  return Object.freeze({
    scope: roster.scope,
    selected_scope: roster.selected_scope,
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    roster_sha256: roster.roster_sha256 as RosterSha256,
    assignment_set_sha256: roster.assignment_set_sha256 as RosterSha256,
  });
}

function configProjection(config: AutopilotRosterContractBySchemaVersion['autopilot.roster_config.v1']): RosterConfigAuthorityProjection {
  return Object.freeze({
    scope: config.scope,
    default_roster_id: config.default_roster_id,
    default_roster_revision: config.default_roster_revision,
    default_roster_sha256: config.default_roster_sha256 as RosterSha256,
    rosters: Object.freeze(config.rosters.map((roster): SavedRosterRef => Object.freeze({
      roster_id: roster.roster_id,
      roster_revision: roster.roster_revision,
      roster_sha256: roster.roster_sha256 as RosterSha256,
      assignment_set_sha256: roster.assignment_set_sha256 as RosterSha256,
      ...(roster.path === undefined ? {} : { path: roster.path }),
    }))),
    previous_config_sha256: config.previous_config_sha256 as RosterSha256 | null,
    config_sha256: config.config_sha256 as RosterSha256,
  });
}

function parseJsonRecord(text: string, label: string): JsonMap {
  const parsed: unknown = JSON.parse(text) as unknown;
  if (!isJsonMap(parsed)) throw new TypeError(`${label} must be a JSON object`);
  return parsed;
}

function requireRecord(value: unknown, label: string): JsonMap {
  if (!isJsonMap(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

async function listFiles(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      const relativePath = relative(root, full).split(/[\\/]+/u).join('/');
      if (entry.isDirectory()) await walk(full);
      else output.push(relativePath);
    }
  }
  await walk(root);
  return Object.freeze(output.sort((left, right) => left.localeCompare(right)));
}

function rpcResult(id: string, result: unknown): FakeJsonRpcSuccess {
  return Object.freeze({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | null, code: number, message: string, data?: unknown): FakeJsonRpcFailure {
  return Object.freeze({
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}

function parseSkillFrontmatter(text: string, path: string): Readonly<Record<string, string | boolean>> {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== '---') throw new Error(`skill ${path} missing frontmatter`);
  const result: Record<string, string | boolean> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) throw new Error(`skill ${path} frontmatter parsing escaped bounds`);
    if (line === '---') return Object.freeze(result);
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error(`skill ${path} has malformed frontmatter line: ${line}`);
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    result[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  throw new Error(`skill ${path} frontmatter did not close`);
}

function requiredFrontmatterString(frontmatter: Readonly<Record<string, string | boolean>>, key: string, path: string): string {
  const value = frontmatter[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`skill ${path} missing frontmatter ${key}`);
  return value;
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath.length === 0 || (!relativePath.startsWith('..') && !relativePath.startsWith('/') && !relativePath.includes(`..${String.fromCharCode(92)}`));
}

export async function assertNoSymlinkOnSkillPath(packageRoot = packageRootPath()): Promise<void> {
  let cursor = packageRoot;
  for (const segment of AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH.split('/')) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`roster setup skill path contains symlink: ${cursor}`);
  }
}

export function expectedPackageSkillEntry(): string {
  return AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY;
}

export function expectedPackageSkillName(): string {
  return AUTOPILOT_ROSTER_SETUP_SKILL_NAME;
}
