import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOPILOT_RUNNER_BIN,
  AUTOPILOT_SCHEMA_NAMES,
  AUTOPILOT_STATUS_TOOL,
} from '../names.ts';
import { renderAutopilotPerfectQualityRules } from '../quality/contract.ts';
import type { AutopilotRosterUnitSpecV2 } from '../roster/runtime-spec.ts';
import {
  parseNewRunRuntimeUnitSpec,
  type AutopilotRosterRuntimeIdentity,
  type AutopilotRuntimeUnitSpec,
} from '../roster/runtime-consumers.ts';
import {
  AUTOPILOT_ROLE_VALUES,
  AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT,
  type AutopilotContextRef,
  type AutopilotRole,
  type AutopilotTemplate,
  type AutopilotThinking,
  type AutopilotUnitSpec,
} from '../contracts/types.ts';

export { AUTOPILOT_ROLE_VALUES };
export type {
  AutopilotContextRef,
  AutopilotRole,
  AutopilotTemplate,
  AutopilotThinking,
  AutopilotUnitSpec,
};

export interface AutopilotProviderIdentity {
  readonly provider_id: string;
  readonly requested_model_id: string;
  readonly executed_model_id: string;
  readonly api: string;
  readonly thinking_level: string;
}

export interface AutopilotForcedOutputContract {
  readonly tool_name: typeof AUTOPILOT_STATUS_TOOL;
  readonly schema_version: 'autopilot.status.v1';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly attempt: number;
  readonly status_output: string;
  readonly receipt_output: string;
  readonly provider_identity: AutopilotProviderIdentity;
  readonly roster_runtime_identity?: AutopilotRosterRuntimeIdentity;
  readonly request_profile?: AutopilotRosterUnitSpecV2['request_profile'];
}

export interface AutopilotRenderedPrompt {
  readonly text: string;
  readonly snapshotPath: string | null;
}

export interface AutopilotPromptRenderOptions {
  readonly templatesDir?: string;
  readonly forcedOutputContract?: AutopilotForcedOutputContract;
}

export interface AutopilotPromptTemplateValidationResult {
  readonly template: AutopilotTemplate;
  readonly templatePath: string | null;
  readonly slots: readonly string[];
  readonly issues: readonly string[];
}

export class AutopilotPromptTemplateError extends Error {
  public readonly issues: readonly string[];
  public readonly templatePath: string | null;

  public constructor(message: string, issues: readonly string[] = [], templatePath: string | null = null) {
    super(`${message}${issues.length === 0 ? '' : `: ${issues.join('; ')}`}`);
    this.name = 'AutopilotPromptTemplateError';
    this.issues = issues;
    this.templatePath = templatePath;
  }
}

export class AutopilotUnitSpecError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Autopilot unit spec failed prompt-renderer validation: ${issues.join('; ')}`);
    this.name = 'AutopilotUnitSpecError';
    this.issues = issues;
  }
}

const DEFAULT_TEMPLATE_DIR_FROM_SOURCE = fileURLToPath(
  new URL('../../../templates/', import.meta.url),
);
const DEFAULT_TEMPLATE_DIR_FROM_DIST = fileURLToPath(
  new URL('../../../../templates/', import.meta.url),
);

export const DEFAULT_AUTOPILOT_TEMPLATE_DIR = existsSync(DEFAULT_TEMPLATE_DIR_FROM_SOURCE)
  ? DEFAULT_TEMPLATE_DIR_FROM_SOURCE
  : DEFAULT_TEMPLATE_DIR_FROM_DIST;

const TEMPLATE_SLOT_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu;
const RAW_CHILD_PI_PROMPT_LAUNCH_PATTERN = /\bpi(?:\s+[^\n`]*?)?\s+-p(?:\s|$)/u;

const AUTOPILOT_PROMPT_TEMPLATE_ALLOWED_SLOTS = [
  'artifact_root',
  'attempt',
  'context_refs',
  'cwd',
  'evidence_dir',
  'forced_output_contract_json',
  'model',
  'objective',
  'owned_paths',
  'quality_rules',
  'read_only_paths',
  'receipt_output',
  'role',
  'role_specific_instructions',
  'status_output',
  'status_payload_contract',
  'stop_boundary',
  'thinking',
  'unit_id',
  'untouchable_paths',
  'validation_commands',
  'verdict_guidance',
  'workstream',
] as const;

type AutopilotPromptTemplateSlot = (typeof AUTOPILOT_PROMPT_TEMPLATE_ALLOWED_SLOTS)[number];
type AutopilotPromptTemplateSlotValues = Readonly<Record<AutopilotPromptTemplateSlot, string>>;

const AUTOPILOT_PROMPT_TEMPLATE_ALLOWED_SLOT_SET = new Set<string>(
  AUTOPILOT_PROMPT_TEMPLATE_ALLOWED_SLOTS,
);

const AUTOPILOT_PROMPT_TEMPLATE_REQUIRED_SLOTS: readonly AutopilotPromptTemplateSlot[] = [
  'workstream',
  'unit_id',
  'role',
  'attempt',
  'model',
  'thinking',
  'objective',
  'cwd',
  'owned_paths',
  'read_only_paths',
  'untouchable_paths',
  'context_refs',
  'validation_commands',
  'evidence_dir',
  'artifact_root',
  'stop_boundary',
  'quality_rules',
  'role_specific_instructions',
  'status_payload_contract',
  'status_output',
  'receipt_output',
  'forced_output_contract_json',
  'verdict_guidance',
] as const;

const AUTOPILOT_FORBIDDEN_TEMPLATE_FRAGMENTS = [
  'docs/guides/high-level-orchestrator-playbook.md',
  'ledger.md',
  'Prompt/plan construction',
  'The operator never does the work',
] as const;

const AUTOPILOT_TEMPLATE_MAX_BYTES = 14_000;

export type AutopilotRenderableUnitSpec = AutopilotRuntimeUnitSpec;

export function renderAutopilotAgentPrompt(
  input: AutopilotRenderableUnitSpec,
  options: AutopilotPromptRenderOptions = {},
): string {
  const runtime = parseNewRunRuntimeUnitSpec(input);
  const unitSpec = runtime.unit_spec;
  assertValidAutopilotUnitSpec(unitSpec);
  const templatePath = autopilotTemplatePath(unitSpec.template, options.templatesDir);
  const source = readTemplateSource(templatePath);
  assertValidAutopilotTemplateSource(unitSpec.template, source, templatePath);
  const slots = buildAutopilotPromptTemplateSlots(unitSpec, options);
  return renderTemplateSource(source, slots, templatePath);
}

export async function renderAndMaybeWriteAutopilotPromptSnapshot(input: {
  readonly spec: AutopilotRenderableUnitSpec;
  readonly forceSnapshot?: boolean;
  readonly templatesDir?: string;
  readonly forcedOutputContract?: AutopilotForcedOutputContract;
  readonly coordinationAppendix?: string;
}): Promise<AutopilotRenderedPrompt> {
  const options: AutopilotPromptRenderOptions = {
    ...(input.templatesDir === undefined ? {} : { templatesDir: input.templatesDir }),
    ...(input.forcedOutputContract === undefined
      ? {}
      : { forcedOutputContract: input.forcedOutputContract }),
  };
  const baseText = renderAutopilotAgentPrompt(input.spec, options);
  const text = input.coordinationAppendix === undefined ? baseText : `${baseText}\n\n${input.coordinationAppendix}`;
  const shouldWrite = input.forceSnapshot === true || input.spec.render_prompt_snapshot === true;
  if (!shouldWrite) return { text, snapshotPath: null };
  const snapshotPath = deriveAutopilotPromptSnapshotPath(input.spec);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${text}\n`, 'utf8');
  return { text, snapshotPath };
}

export function deriveAutopilotPromptSnapshotPath(spec: AutopilotRenderableUnitSpec): string {
  const file = `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.md`;
  return join(deriveAutopilotArtifactRoot(spec), 'rendered-prompts', file);
}

export function deriveAutopilotArtifactRoot(spec: AutopilotRenderableUnitSpec): string {
  const statusDir = dirname(spec.status_output);
  return basename(statusDir) === 'statuses' ? dirname(statusDir) : statusDir;
}

export function autopilotTemplatePath(
  template: AutopilotTemplate,
  templatesDir = DEFAULT_AUTOPILOT_TEMPLATE_DIR,
): string {
  return resolve(templatesDir, `${template}.md`);
}

export function validateAutopilotPromptTemplateSource(input: {
  readonly template: AutopilotTemplate;
  readonly source: string;
  readonly templatePath?: string;
}): AutopilotPromptTemplateValidationResult {
  const slots = extractTemplateSlots(input.source);
  const slotSet = new Set(slots);
  const issues: string[] = [];

  if (input.source.trim().length === 0) issues.push('template source must not be empty');
  if (utf8ByteLength(input.source) > AUTOPILOT_TEMPLATE_MAX_BYTES) {
    issues.push(
      `template exceeds ${String(AUTOPILOT_TEMPLATE_MAX_BYTES)} bytes; fixed Autopilot prompts must stay compact`,
    );
  }
  for (const required of AUTOPILOT_PROMPT_TEMPLATE_REQUIRED_SLOTS) {
    if (!slotSet.has(required)) issues.push(`missing required slot {{${required}}}`);
  }
  for (const slot of slots) {
    if (!isAutopilotPromptTemplateSlot(slot)) issues.push(`unknown slot {{${slot}}}`);
  }
  for (const fragment of AUTOPILOT_FORBIDDEN_TEMPLATE_FRAGMENTS) {
    if (input.source.includes(fragment)) {
      issues.push(`template must not paste or depend on legacy fragment ${JSON.stringify(fragment)}`);
    }
  }
  if (RAW_CHILD_PI_PROMPT_LAUNCH_PATTERN.test(input.source)) {
    issues.push('template must not instruct raw child Pi prompt launches; use Autopilot runner only');
  }

  const frozenSlots = Object.freeze(slots);
  const frozenIssues = Object.freeze(issues);
  return Object.freeze({
    template: input.template,
    templatePath: input.templatePath ?? null,
    slots: frozenSlots,
    issues: frozenIssues,
  });
}

export function assertValidAutopilotTemplateSource(
  template: AutopilotTemplate,
  source: string,
  templatePath: string | null = null,
): void {
  const result = validateAutopilotPromptTemplateSource({
    template,
    source,
    ...(templatePath === null ? {} : { templatePath }),
  });
  if (result.issues.length > 0) {
    throw new AutopilotPromptTemplateError(
      `Autopilot prompt template ${template} failed deterministic validation`,
      result.issues,
      result.templatePath,
    );
  }
}

export function assertValidAutopilotUnitSpec(spec: AutopilotRenderableUnitSpec): void {
  const issues = autopilotUnitSpecIssues(spec);
  if (issues.length > 0) throw new AutopilotUnitSpecError(issues);
}

export function buildAutopilotPromptTemplateSlots(
  spec: AutopilotRenderableUnitSpec,
  options: AutopilotPromptRenderOptions = {},
): AutopilotPromptTemplateSlotValues {
  const runtime = parseNewRunRuntimeUnitSpec(spec);
  const unitSpec = runtime.unit_spec;
  const forcedOutputContract = forcedOutputContractForUnitSpec(unitSpec, options.forcedOutputContract);

  return Object.freeze({
    artifact_root: deriveAutopilotArtifactRoot(unitSpec),
    attempt: String(unitSpec.attempt),
    context_refs: contextRefs(unitSpec),
    cwd: unitSpec.cwd,
    evidence_dir: unitSpec.evidence_dir,
    forced_output_contract_json: JSON.stringify(forcedOutputContract, null, 2),
    model: unitSpec.model,
    objective: unitSpec.objective,
    owned_paths: bulletList(unitSpec.owned_paths),
    quality_rules: qualityRules(),
    read_only_paths: bulletList(unitSpec.read_only_paths),
    receipt_output: unitSpec.receipt_output,
    role: unitSpec.role,
    role_specific_instructions: roleSpecificInstructions(unitSpec.role),
    status_output: unitSpec.status_output,
    status_payload_contract: statusPayloadContract(unitSpec.role),
    stop_boundary: unitSpec.stop_boundary,
    thinking: unitSpec.thinking,
    unit_id: unitSpec.unit_id,
    untouchable_paths: bulletList(unitSpec.untouchable_paths),
    validation_commands: validationCommands(unitSpec.validation_commands),
    verdict_guidance: verdictGuidance(unitSpec.role),
    workstream: unitSpec.workstream,
  });
}

function buildDefaultForcedOutputContract(spec: AutopilotRenderableUnitSpec): AutopilotForcedOutputContract {
  const runtime = parseNewRunRuntimeUnitSpec(spec);
  const unitSpec = runtime.unit_spec;
  return Object.freeze({
    tool_name: AUTOPILOT_STATUS_TOOL,
    schema_version: 'autopilot.status.v1',
    workstream: unitSpec.workstream,
    unit_id: unitSpec.unit_id,
    role: unitSpec.role,
    attempt: unitSpec.attempt,
    status_output: unitSpec.status_output,
    receipt_output: unitSpec.receipt_output,
    provider_identity: {
      provider_id: unitSpec.request_profile.provider_id,
      requested_model_id: unitSpec.request_profile.model_id,
      executed_model_id: unitSpec.request_profile.model_id,
      api: unitSpec.request_profile.api,
      thinking_level: unitSpec.request_profile.thinking,
    },
    roster_runtime_identity: runtime.roster_identity,
    request_profile: unitSpec.request_profile,
  });
}

function forcedOutputContractForUnitSpec(
  spec: AutopilotRenderableUnitSpec,
  provided: AutopilotForcedOutputContract | undefined,
): AutopilotForcedOutputContract {
  const runtime = parseNewRunRuntimeUnitSpec(spec);
  const expected = buildDefaultForcedOutputContract(runtime.unit_spec);
  if (provided === undefined) return expected;
  for (const field of ['tool_name', 'schema_version', 'workstream', 'unit_id', 'role', 'attempt', 'status_output', 'receipt_output'] as const) {
    if (provided[field] !== expected[field]) {
      throw new AutopilotUnitSpecError([`forced_output_contract ${field} does not match unit_spec.v2`]);
    }
  }
  for (const field of ['provider_id', 'requested_model_id', 'executed_model_id', 'api', 'thinking_level'] as const) {
    if (provided.provider_identity[field] !== expected.provider_identity[field]) {
      throw new AutopilotUnitSpecError([`forced_output_contract provider_identity.${field} does not match unit_spec.v2 request_profile`]);
    }
  }
  if (expected.roster_runtime_identity === undefined || expected.request_profile === undefined) {
    throw new AutopilotUnitSpecError(['unit_spec.v2 forced_output_contract roster identity is unavailable']);
  }
  return Object.freeze({
    ...provided,
    roster_runtime_identity: expected.roster_runtime_identity,
    request_profile: expected.request_profile,
  });
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function readTemplateSource(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new AutopilotPromptTemplateError(
      `failed to read Autopilot prompt template at ${path}`,
      [error instanceof Error ? error.message : String(error)],
      path,
    );
  }
}

function extractTemplateSlots(source: string): readonly string[] {
  const slots: string[] = [];
  for (const match of source.matchAll(TEMPLATE_SLOT_PATTERN)) {
    const slot = match[1];
    if (slot !== undefined) slots.push(slot);
  }
  return Object.freeze([...new Set(slots)].sort((left, right) => left.localeCompare(right)));
}

function renderTemplateSource(
  source: string,
  slots: AutopilotPromptTemplateSlotValues,
  templatePath: string,
): string {
  return source.replace(TEMPLATE_SLOT_PATTERN, (_fullMatch: string, rawSlot: string): string => {
    if (!isAutopilotPromptTemplateSlot(rawSlot)) {
      throw new AutopilotPromptTemplateError(
        'template render encountered an unresolved slot after validation',
        [`unresolved slot {{${rawSlot}}}`],
        templatePath,
      );
    }
    return slots[rawSlot];
  });
}

function isAutopilotPromptTemplateSlot(slot: string): slot is AutopilotPromptTemplateSlot {
  return AUTOPILOT_PROMPT_TEMPLATE_ALLOWED_SLOT_SET.has(slot);
}

function autopilotUnitSpecIssues(spec: AutopilotRenderableUnitSpec): readonly string[] {
  const issues: string[] = [];
  let unitSpec: AutopilotRosterUnitSpecV2;
  try {
    unitSpec = parseNewRunRuntimeUnitSpec(spec).unit_spec;
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return Object.freeze(issues);
  }
  if (!AUTOPILOT_ROLE_VALUES.includes(unitSpec.role)) issues.push(`unknown role ${unitSpec.role}`);
  if (unitSpec.template !== unitSpec.role) issues.push('template must match role');
  if (!Number.isInteger(unitSpec.attempt) || unitSpec.attempt < 1) issues.push('attempt must be a positive integer');
  if ((unitSpec.role === 'implement' || unitSpec.role === 'fix') && unitSpec.owned_paths.length === 0) {
    issues.push(`${unitSpec.role} specs require at least one owned path`);
  }
  if (
    (unitSpec.role === 'validate' || unitSpec.role === 'bughunt') &&
    unitSpec.validation_commands.length === 0
  ) {
    issues.push(`${unitSpec.role} specs require at least one validation command`);
  }
  if (unitSpec.status_output === unitSpec.receipt_output) {
    issues.push('status_output and receipt_output must be distinct');
  }
  for (const [label, path] of [
    ['cwd', unitSpec.cwd],
    ['status_output', unitSpec.status_output],
    ['receipt_output', unitSpec.receipt_output],
    ['evidence_dir', unitSpec.evidence_dir],
  ] as const) {
    if (!isAbsolutePath(path)) issues.push(`${label} must be absolute`);
  }
  return Object.freeze(issues);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(path);
}

function bulletList(values: readonly string[]): string {
  if (values.length === 0) return '- none';
  return values.map((value) => `- ${value}`).join('\n');
}

function contextRefs(spec: AutopilotRenderableUnitSpec): string {
  if (spec.context_refs.length === 0) return '- none';
  return spec.context_refs
    .map((ref) => {
      const hash = ref.sha256 === undefined || ref.sha256 === null ? '' : ` sha256=${ref.sha256}`;
      const bytes = ref.byte_count === undefined || ref.byte_count === null ? '' : ` bytes=${String(ref.byte_count)}`;
      return `- ${ref.path}: ${ref.purpose}${hash}${bytes}`;
    })
    .join('\n');
}

function validationCommands(commands: readonly string[]): string {
  if (commands.length === 0) return '- none declared for this role';
  return commands.map((command) => `- ${command}`).join('\n');
}

function qualityRules(): string {
  return [
    renderAutopilotPerfectQualityRules(),
    '- Git discipline is worktree-scoped: local git inspection and mutation are allowed only inside this unit cwd/registered Autopilot worktree; never run git against the operator source checkout, another worktree, external paths, or remotes; do not create/delete/move shared branches or tags.',
    '- Stay inside owned_paths for source edits. Treat read_only_paths and untouchable_paths as no-write zones.',
    `- Do not hand-assemble raw child Pi launches; Autopilot child work is launched only through ${AUTOPILOT_RUNNER_BIN} by the parent.`,
    '- Use real files, diffs, and commands for claims. Reports are optional evidence refs, not the verdict authority.',
    '- Do not paste large file or report bodies into the final answer; final truth is the forced AutopilotStatusEntry.',
    '- Use only subscription Pi channels for frontier models; do not introduce OpenRouter or metered Claude, GPT, or Codex API routes.',
  ].join('\n');
}

function roleSpecificInstructions(role: AutopilotRole): string {
  switch (role) {
    case 'strategy':
      return [
        '- Produce or update an execution-ready strategy/DAG artifact only within owned paths or evidence_dir.',
        '- Cover dependencies, safe parallel waves, ownership boundaries, validation matrix, real-boundary witnesses, blockers, and closure criteria.',
        '- Do not launch implementation work. Do not broaden scope beyond the requested workstream.',
        '- Reference a strategy artifact through report_ref or evidence_refs; changed_paths must be empty in the final status for this role.',
      ].join('\n');
    case 'implement':
      return [
        '- Implement the requested source, test, doc, or config change inside owned_paths only.',
        '- Inspect relevant existing code before editing; maintain existing architecture and contracts.',
        '- Run declared validation commands when applicable and record concise command summaries.',
        '- In the final status, changed_paths must list every path you edited and all must be under owned_paths.',
      ].join('\n');
    case 'validate':
      return [
        '- Act as an independent adversarial validator over real source, diffs, artifacts, and command output.',
        '- Do not edit files. Run the declared validation commands unless impossible, and record skipped commands as blocked or not-run with reasons.',
        '- Classify findings by severity and root cause. PASS only when the unit is clean with no findings and no failed or non-zero commands.',
        '- changed_paths must be empty for this role.',
      ].join('\n');
    case 'fix':
      return [
        '- Fix validator findings at root cause inside owned_paths only.',
        '- Re-read the finding evidence and relevant source before editing; do not suppress symptoms or weaken tests or contracts.',
        '- Run declared validation commands when applicable and record command summaries.',
        '- In the final status, changed_paths must list every path you edited and all must be under owned_paths.',
      ].join('\n');
    case 'adjudicate':
      return [
        '- Resolve a blocker, conflict, or readiness question through read-first analysis and a clear ruling.',
        '- Prefer a compact adjudication artifact under evidence_dir when details exceed the status bounds.',
        '- Classify the outcome as ratify, split, remediate, or planning-contradiction. Operator-decision is valid only for your exact coordinator assignment, after source-run Git-HEAD artifact registration, when exact schema-valid clauses demand incompatible outcomes and sequencing, partitioning, ownership transfer, rebase/revalidation, and replanning all fail. Complete through assignment-bound terminal child evidence; never self-claim another adjudicator identity.',
        '- Do not make implementation fixes. Operational claim, offline, handoff, worktree, merge, test, validation, deadlock, disk, or cleanup blockers must remain autonomous and must never produce an operator packet.',
        '- changed_paths must be empty for this role.',
      ].join('\n');
    case 'bughunt':
      return [
        '- Perform a final obvious-miss pass over the completed milestone using real files, diffs, artifacts, and declared commands.',
        '- Do not edit files. Look for integration gaps, stale docs or prompts, missing negative witnesses, and contract drift.',
        '- PASS only when no actionable findings remain. Use NEEDS_FIX for concrete defects with evidence.',
        '- changed_paths must be empty for this role.',
      ].join('\n');
    case 'extract':
      return [
        '- Produce an operator-decision packet only from a coordinator-accepted planning-contradiction; otherwise produce a non-escalating transfer summary.',
        '- Extract facts from referenced artifacts without pasting large bodies; write a compact packet under evidence_dir if needed.',
        '- Include context, options, trade-offs, recommendation, and exact next action.',
        '- changed_paths must be empty for this role.',
      ].join('\n');
  }
}

function statusPayloadContract(role: AutopilotRole): string {
  const changedPathRule =
    role === 'implement' || role === 'fix'
      ? `changed_paths must list every edited repo-relative path, every entry must be inside owned_paths, and the list must contain at most ${String(AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT)} paths. If this unit would edit more paths, emit BLOCKED and ask the parent to split the work.`
      : 'changed_paths must be an empty array for this read/coordinator role.';
  return [
    '- schema_version: "autopilot.status.v1"',
    '- workstream, unit_id, role, and attempt must exactly match this prompt.',
    `- ${changedPathRule}`,
    '- PASS/DONE require severity "clean", no findings, and no failed or non-zero command summaries.',
    '- NEEDS_FIX requires at least one finding and non-clean severity.',
    '- Evidence/report refs are repo or Autopilot-relative paths; include sha256 and byte_count when the referenced file exists.',
    '- next_action must be one bounded sentence telling the parent Autopilot what to do next.',
  ].join('\n');
}

function verdictGuidance(role: AutopilotRole): string {
  if (role === 'validate' || role === 'bughunt') {
    return 'Valid verdicts: PASS, NEEDS_FIX, or BLOCKED. PASS is allowed only for clean validation with no findings and no failed or non-zero commands.';
  }
  return 'Valid verdicts: DONE or BLOCKED. DONE is allowed only for clean completion with no findings.';
}

export function autopilotSchemaList(): string {
  return AUTOPILOT_SCHEMA_NAMES.map((name) => `- ${name}`).join('\n');
}
