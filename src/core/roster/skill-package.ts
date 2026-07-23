import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTOPILOT_ROSTER_SETUP_SKILL_NAME = 'autopilot-roster-setup';
export const AUTOPILOT_ROSTER_SETUP_SKILL_DIR = 'templates/skills/autopilot-roster-setup';
export const AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH = 'templates/skills/autopilot-roster-setup/SKILL.md';
export const AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH = 'templates/skills/autopilot-roster-setup/payload.json';
export const AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY = './templates/skills/autopilot-roster-setup';
export const AUTOPILOT_ROSTER_SETUP_FREEZE_ID = 'phase37-roster-w0-2026-07-22';
export const AUTOPILOT_ROSTER_SETUP_PI_MINIMUM_VERSION = '0.80.6';
export const AUTOPILOT_ROSTER_SETUP_SKILL_SHA256 = 'sha256:f14f135f2ef7e101b95bdd6e7d3c787cb4efafd7a727b9f724d20d101857b352';
export const AUTOPILOT_ROSTER_SETUP_SKILL_BYTE_COUNT = 6872;
export const AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256 = 'sha256:12fdd2ade39a21741e15dd97965049ec1272d8d3260c6b17f83f93988c58ed6b';
export const AUTOPILOT_ROSTER_SETUP_PAYLOAD_BYTE_COUNT = 2825;

const PACKAGE_NAME = 'pi-autopilot';
const SOURCE_MODULE_RELATIVE_PATH = join('src', 'core', 'roster', 'skill-package.ts');
const DIST_MODULE_RELATIVE_PATH = join('dist', 'src', 'core', 'roster', 'skill-package.js');

export type AutopilotRosterSetupSkillPackageFailureReason =
  | 'module-url'
  | 'package-layout'
  | 'package-identity'
  | 'missing'
  | 'symlink'
  | 'not-file'
  | 'hash-mismatch'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'payload-contract';

export class AutopilotRosterSetupSkillPackageError extends Error {
  public readonly reason: AutopilotRosterSetupSkillPackageFailureReason;
  public readonly diagnostics: readonly string[];

  public constructor(reason: AutopilotRosterSetupSkillPackageFailureReason, message: string, diagnostics: readonly string[] = []) {
    super(message);
    this.name = 'AutopilotRosterSetupSkillPackageError';
    this.reason = reason;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export interface AutopilotRosterSetupSkillPayload {
  readonly schema_version: 'autopilot.roster_setup_skill_payload.v1';
  readonly skill_name: typeof AUTOPILOT_ROSTER_SETUP_SKILL_NAME;
  readonly resource_kind: 'pi-skill';
  readonly freeze_id: typeof AUTOPILOT_ROSTER_SETUP_FREEZE_ID;
  readonly pi_minimum_version: typeof AUTOPILOT_ROSTER_SETUP_PI_MINIMUM_VERSION;
  readonly normal_activation: 'inactive-skill-command-only';
  readonly resources: {
    readonly skill_md: {
      readonly path: typeof AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH;
      readonly sha256: typeof AUTOPILOT_ROSTER_SETUP_SKILL_SHA256;
      readonly byte_count: typeof AUTOPILOT_ROSTER_SETUP_SKILL_BYTE_COUNT;
    };
  };
  readonly authorities: readonly {
    readonly path: string;
    readonly role: string;
    readonly sha256?: string;
  }[];
  readonly required_tool_contract: {
    readonly operation: 'autopilot_manage_rosters';
    readonly request_schema: 'autopilot.roster_tool_request.v1';
    readonly result_schema: 'autopilot.roster_tool_result.v1';
    readonly actions: readonly ['inspect', 'propose', 'reject', 'doctor', 'save'];
    readonly zero_write_actions: readonly ['inspect', 'propose', 'reject', 'doctor'];
    readonly write_action: 'save';
    readonly w0_save_blocks_before_storage: true;
    readonly save_success_visible_write_count_certified: 3;
  };
  readonly conversation_contract: {
    readonly mode: 'agent-first ordinary multi-turn conversation; no wizard, menu, or questionnaire';
    readonly inactive_by_default: true;
    readonly no_run_worktree_or_spend_before_saved_retry: true;
    readonly secret_free_outputs: true;
    readonly project_trust_required_for_trusted_project_scope: true;
    readonly cruise_recommendation_only_when_ready: true;
    readonly blocked_and_converged_honesty_required: true;
    readonly approval_requires_exact_restatement: false;
    readonly approval_authorization: 'nonempty bounded user/rpc/interactive turn after current package-bound presentation; setup agent interprets approval semantics';
    readonly approval_fields: readonly [
      'scope',
      'candidate_set_sha256',
      'approved_roster_sha256s_in_order',
      'default_roster_id',
      'default_roster_revision',
      'default_roster_sha256',
      'original_command',
    ];
    readonly post_save: readonly ['fresh_pi_session_required', 'retry_exact_original_autopilot_command', 'never_auto_start'];
  };
}

export interface VerifiedAutopilotRosterSetupSkillPackage {
  readonly packageRoot: string;
  readonly name: typeof AUTOPILOT_ROSTER_SETUP_SKILL_NAME;
  readonly skillDirRelativePath: typeof AUTOPILOT_ROSTER_SETUP_SKILL_DIR;
  readonly skillPath: string;
  readonly skillRelativePath: typeof AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH;
  readonly skillSha256: typeof AUTOPILOT_ROSTER_SETUP_SKILL_SHA256;
  readonly skillByteCount: typeof AUTOPILOT_ROSTER_SETUP_SKILL_BYTE_COUNT;
  readonly skillText: string;
  readonly payloadPath: string;
  readonly payloadRelativePath: typeof AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH;
  readonly payloadSha256: typeof AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256;
  readonly payloadByteCount: typeof AUTOPILOT_ROSTER_SETUP_PAYLOAD_BYTE_COUNT;
  readonly payloadText: string;
  readonly payload: AutopilotRosterSetupSkillPayload;
  readonly packageSkillEntry: typeof AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function fail(reason: AutopilotRosterSetupSkillPackageFailureReason, message: string, diagnostics: readonly string[] = []): never {
  throw new AutopilotRosterSetupSkillPackageError(reason, message, diagnostics);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail('invalid-utf8', `${label} is not valid UTF-8`, [`cause=${error instanceof Error ? error.message : String(error)}`]);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    fail('invalid-json', `${label} is not valid JSON`, [`cause=${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!isRecord(parsed)) fail('payload-contract', `${label} must be a JSON object`);
  return parsed;
}

function sortedCopy(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function expectKeys(record: JsonRecord, expectedKeys: readonly string[], label: string): void {
  const actual = sortedCopy(Object.keys(record));
  const expected = sortedCopy(expectedKeys);
  if (actual.length !== expected.length) {
    fail('payload-contract', `${label} keys changed`, [`expected=${expected.join(',')}`, `actual=${actual.join(',')}`]);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedKey = expected[index];
    const actualKey = actual[index];
    if (actualKey !== expectedKey) {
      fail('payload-contract', `${label} keys changed`, [`expected=${expected.join(',')}`, `actual=${actual.join(',')}`]);
    }
  }
}

function expectRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail('payload-contract', `${label} must be an object`);
  return value;
}

function expectString(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail('payload-contract', `${label} changed`, [`expected=${expected}`, `actual=${String(value)}`]);
}

function expectNumber(value: unknown, expected: number, label: string): void {
  if (value !== expected) fail('payload-contract', `${label} changed`, [`expected=${expected}`, `actual=${String(value)}`]);
}

function expectBoolean(value: unknown, expected: boolean, label: string): void {
  if (value !== expected) fail('payload-contract', `${label} changed`, [`expected=${String(expected)}`, `actual=${String(value)}`]);
}

function expectStringArray(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value)) fail('payload-contract', `${label} must be an array`);
  const actual: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') fail('payload-contract', `${label} must contain only strings`);
    actual.push(entry);
  }
  if (actual.length !== expected.length) {
    fail('payload-contract', `${label} changed`, [`expected=${expected.join('|')}`, `actual=${actual.join('|')}`]);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedEntry = expected[index];
    const actualEntry = actual[index];
    if (actualEntry !== expectedEntry) {
      fail('payload-contract', `${label} changed`, [`expected=${expected.join('|')}`, `actual=${actual.join('|')}`]);
    }
  }
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child);
}

function packageRelativeSegments(relativePath: string): string[] {
  if (relativePath.startsWith('/') || relativePath.includes('\\')) {
    fail('package-layout', 'packaged roster setup resource path is not package-relative', [`path=${relativePath}`]);
  }
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      fail('package-layout', 'packaged roster setup resource path contains an unsafe segment', [`path=${relativePath}`]);
    }
  }
  return segments;
}

function readPhysicalPackageFile(packageRoot: string, relativePath: string, label: string): { readonly path: string; readonly bytes: Uint8Array } {
  const normalizedRoot = resolve(packageRoot);
  const segments = packageRelativeSegments(relativePath);
  const target = resolve(normalizedRoot, ...segments);
  if (!isContained(normalizedRoot, target)) {
    fail('package-layout', `${label} escapes the package root`, [`package_root=${normalizedRoot}`, `resource=${target}`]);
  }

  let cursor = normalizedRoot;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      fail('missing', `${label} is missing from the package`, [`resource=${cursor}`, `cause=${error instanceof Error ? error.message : String(error)}`]);
    }
    if (info.isSymbolicLink()) fail('symlink', `${label} contains a symbolic link`, [`resource=${cursor}`]);
  }

  const info = lstatSync(target);
  if (!info.isFile()) fail('not-file', `${label} is not a regular file`, [`resource=${target}`]);

  const realRoot = realpathSync(normalizedRoot);
  const realTarget = realpathSync(target);
  const expectedRealTarget = join(realRoot, ...segments);
  if (realTarget !== expectedRealTarget || !isContained(realRoot, realTarget)) {
    fail('package-layout', `${label} real path drifted outside the package root`, [`resource=${target}`, `resolved=${realTarget}`]);
  }

  return { path: target, bytes: readFileSync(target) };
}

function assertPhysicalPackageRoot(packageRoot: string): string {
  const normalizedRoot = resolve(packageRoot);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(normalizedRoot);
  } catch (error) {
    fail('missing', 'roster setup package root is missing', [`package_root=${normalizedRoot}`, `cause=${error instanceof Error ? error.message : String(error)}`]);
  }
  if (info.isSymbolicLink()) fail('symlink', 'roster setup package root is a symbolic link', [`package_root=${normalizedRoot}`]);
  if (!info.isDirectory()) fail('package-layout', 'roster setup package root is not a directory', [`package_root=${normalizedRoot}`]);
  return normalizedRoot;
}

function verifyPackageManifest(packageRoot: string): void {
  const manifest = readPhysicalPackageFile(packageRoot, 'package.json', 'package manifest');
  const manifestText = decodeUtf8(manifest.bytes, 'package manifest');
  const parsed = parseJsonObject(manifestText, 'package manifest');
  if (parsed['name'] !== PACKAGE_NAME) {
    fail('package-identity', 'package manifest identity does not match Autopilot', [`expected_name=${PACKAGE_NAME}`, `actual_name=${String(parsed['name'])}`]);
  }
  const pi = expectRecord(parsed['pi'], 'package manifest pi field');
  expectStringArray(pi['skills'], [AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY], 'package manifest pi.skills');
}

function assertHash(label: string, bytes: Uint8Array, expectedHash: string, expectedByteCount: number): void {
  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {
    fail('hash-mismatch', `${label} hash mismatch`, [`expected=${expectedHash}`, `actual=${actualHash}`]);
  }
  if (bytes.byteLength !== expectedByteCount) {
    fail('hash-mismatch', `${label} byte count mismatch`, [`expected=${expectedByteCount}`, `actual=${bytes.byteLength}`]);
  }
}

function assertSkillContentContract(skillText: string): void {
  const requiredFragments = [
    'name: autopilot-roster-setup',
    'disable-model-invocation: true',
    'agent-first, ordinary multi-turn conversation',
    'Do not open a wizard, menu',
    'write_count=0',
    'candidate_set_sha256',
    'approved_roster_sha256s, in proposal order',
    'Recommend Cruise only when',
    'project trust',
    'secret-free',
    'fresh Pi session',
    'Do not auto-start Autopilot',
    'Retry exactly the original command',
  ] as const;
  for (const fragment of requiredFragments) {
    if (!skillText.includes(fragment)) {
      fail('payload-contract', 'SKILL.md is missing a required roster setup instruction marker', [`marker=${fragment}`]);
    }
  }
}

function expectAuthorities(value: unknown): void {
  if (!Array.isArray(value)) fail('payload-contract', 'payload authorities must be an array');
  if (value.length !== 4) fail('payload-contract', 'payload authorities changed', [`actual_count=${value.length}`]);
  for (const entry of value) {
    const record = expectRecord(entry, 'payload authority entry');
    const keys = Object.keys(record);
    if (!keys.includes('path') || !keys.includes('role')) fail('payload-contract', 'payload authority entry is missing path or role');
    if (typeof record['path'] !== 'string' || typeof record['role'] !== 'string') fail('payload-contract', 'payload authority path and role must be strings');
    if (Object.prototype.hasOwnProperty.call(record, 'sha256') && typeof record['sha256'] !== 'string') fail('payload-contract', 'payload authority sha256 must be a string when present');
  }
}

function validatePayload(payload: JsonRecord, skillByteCount: number): AutopilotRosterSetupSkillPayload {
  expectKeys(payload, [
    'schema_version',
    'skill_name',
    'resource_kind',
    'freeze_id',
    'pi_minimum_version',
    'normal_activation',
    'resources',
    'authorities',
    'required_tool_contract',
    'conversation_contract',
  ], 'payload');
  expectString(payload['schema_version'], 'autopilot.roster_setup_skill_payload.v1', 'payload schema_version');
  expectString(payload['skill_name'], AUTOPILOT_ROSTER_SETUP_SKILL_NAME, 'payload skill_name');
  expectString(payload['resource_kind'], 'pi-skill', 'payload resource_kind');
  expectString(payload['freeze_id'], AUTOPILOT_ROSTER_SETUP_FREEZE_ID, 'payload freeze_id');
  expectString(payload['pi_minimum_version'], AUTOPILOT_ROSTER_SETUP_PI_MINIMUM_VERSION, 'payload pi_minimum_version');
  expectString(payload['normal_activation'], 'inactive-skill-command-only', 'payload normal_activation');

  const resources = expectRecord(payload['resources'], 'payload resources');
  expectKeys(resources, ['skill_md'], 'payload resources');
  const skillMd = expectRecord(resources['skill_md'], 'payload resources.skill_md');
  expectKeys(skillMd, ['path', 'sha256', 'byte_count'], 'payload resources.skill_md');
  expectString(skillMd['path'], AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH, 'payload skill path');
  expectString(skillMd['sha256'], AUTOPILOT_ROSTER_SETUP_SKILL_SHA256, 'payload skill sha256');
  expectNumber(skillMd['byte_count'], skillByteCount, 'payload skill byte_count');

  expectAuthorities(payload['authorities']);

  const tool = expectRecord(payload['required_tool_contract'], 'payload required_tool_contract');
  expectKeys(tool, ['operation', 'request_schema', 'result_schema', 'actions', 'zero_write_actions', 'write_action', 'w0_save_blocks_before_storage', 'save_success_visible_write_count_certified'], 'payload required_tool_contract');
  expectString(tool['operation'], 'autopilot_manage_rosters', 'payload tool operation');
  expectString(tool['request_schema'], 'autopilot.roster_tool_request.v1', 'payload tool request_schema');
  expectString(tool['result_schema'], 'autopilot.roster_tool_result.v1', 'payload tool result_schema');
  expectStringArray(tool['actions'], ['inspect', 'propose', 'reject', 'doctor', 'save'], 'payload tool actions');
  expectStringArray(tool['zero_write_actions'], ['inspect', 'propose', 'reject', 'doctor'], 'payload zero_write_actions');
  expectString(tool['write_action'], 'save', 'payload write_action');
  expectBoolean(tool['w0_save_blocks_before_storage'], true, 'payload w0_save_blocks_before_storage');
  expectNumber(tool['save_success_visible_write_count_certified'], 3, 'payload save_success_visible_write_count_certified');

  const conversation = expectRecord(payload['conversation_contract'], 'payload conversation_contract');
  expectKeys(conversation, [
    'mode',
    'inactive_by_default',
    'no_run_worktree_or_spend_before_saved_retry',
    'secret_free_outputs',
    'project_trust_required_for_trusted_project_scope',
    'cruise_recommendation_only_when_ready',
    'blocked_and_converged_honesty_required',
    'approval_requires_exact_restatement',
    'approval_authorization',
    'approval_fields',
    'post_save',
  ], 'payload conversation_contract');
  expectString(conversation['mode'], 'agent-first ordinary multi-turn conversation; no wizard, menu, or questionnaire', 'payload conversation mode');
  expectBoolean(conversation['inactive_by_default'], true, 'payload inactive_by_default');
  expectBoolean(conversation['no_run_worktree_or_spend_before_saved_retry'], true, 'payload no_run_worktree_or_spend_before_saved_retry');
  expectBoolean(conversation['secret_free_outputs'], true, 'payload secret_free_outputs');
  expectBoolean(conversation['project_trust_required_for_trusted_project_scope'], true, 'payload project_trust_required_for_trusted_project_scope');
  expectBoolean(conversation['cruise_recommendation_only_when_ready'], true, 'payload cruise_recommendation_only_when_ready');
  expectBoolean(conversation['blocked_and_converged_honesty_required'], true, 'payload blocked_and_converged_honesty_required');
  expectBoolean(conversation['approval_requires_exact_restatement'], false, 'payload approval_requires_exact_restatement');
  expectString(conversation['approval_authorization'], 'nonempty bounded user/rpc/interactive turn after current package-bound presentation; setup agent interprets approval semantics', 'payload approval_authorization');
  expectStringArray(conversation['approval_fields'], ['scope', 'candidate_set_sha256', 'approved_roster_sha256s_in_order', 'default_roster_id', 'default_roster_revision', 'default_roster_sha256', 'original_command'], 'payload approval_fields');
  expectStringArray(conversation['post_save'], ['fresh_pi_session_required', 'retry_exact_original_autopilot_command', 'never_auto_start'], 'payload post_save');

  return payload as unknown as AutopilotRosterSetupSkillPayload;
}

function packageRootForModulePath(modulePath: string): string {
  const sourceRoot = resolve(dirname(modulePath), '..', '..', '..');
  if (modulePath === join(sourceRoot, SOURCE_MODULE_RELATIVE_PATH)) return sourceRoot;
  const distRoot = resolve(dirname(modulePath), '..', '..', '..', '..');
  if (modulePath === join(distRoot, DIST_MODULE_RELATIVE_PATH)) return distRoot;
  fail('package-layout', 'roster setup skill-package module is outside the closed source/dist package layouts', [`module=${modulePath}`]);
}

export function verifyAutopilotRosterSetupSkillPackageRoot(packageRoot: string): VerifiedAutopilotRosterSetupSkillPackage {
  const normalizedRoot = assertPhysicalPackageRoot(packageRoot);
  verifyPackageManifest(normalizedRoot);

  const skill = readPhysicalPackageFile(normalizedRoot, AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH, 'Autopilot roster setup SKILL.md');
  assertHash('Autopilot roster setup SKILL.md', skill.bytes, AUTOPILOT_ROSTER_SETUP_SKILL_SHA256, AUTOPILOT_ROSTER_SETUP_SKILL_BYTE_COUNT);
  const skillText = decodeUtf8(skill.bytes, 'Autopilot roster setup SKILL.md');
  assertSkillContentContract(skillText);

  const payloadResource = readPhysicalPackageFile(normalizedRoot, AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH, 'Autopilot roster setup payload.json');
  assertHash('Autopilot roster setup payload.json', payloadResource.bytes, AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256, AUTOPILOT_ROSTER_SETUP_PAYLOAD_BYTE_COUNT);
  const payloadText = decodeUtf8(payloadResource.bytes, 'Autopilot roster setup payload.json');
  const payload = validatePayload(parseJsonObject(payloadText, 'Autopilot roster setup payload.json'), skill.bytes.byteLength);

  return Object.freeze({
    packageRoot: normalizedRoot,
    name: AUTOPILOT_ROSTER_SETUP_SKILL_NAME,
    skillDirRelativePath: AUTOPILOT_ROSTER_SETUP_SKILL_DIR,
    skillPath: skill.path,
    skillRelativePath: AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH,
    skillSha256: AUTOPILOT_ROSTER_SETUP_SKILL_SHA256,
    skillByteCount: AUTOPILOT_ROSTER_SETUP_SKILL_BYTE_COUNT,
    skillText,
    payloadPath: payloadResource.path,
    payloadRelativePath: AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH,
    payloadSha256: AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256,
    payloadByteCount: AUTOPILOT_ROSTER_SETUP_PAYLOAD_BYTE_COUNT,
    payloadText,
    payload,
    packageSkillEntry: AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY,
  });
}

export function resolveAutopilotRosterSetupSkillPackage(moduleUrl = import.meta.url): VerifiedAutopilotRosterSetupSkillPackage {
  let modulePath: string;
  try {
    modulePath = resolve(fileURLToPath(moduleUrl));
  } catch (error) {
    fail('module-url', 'roster setup skill-package module URL is not a local file', [`cause=${error instanceof Error ? error.message : String(error)}`]);
  }
  return verifyAutopilotRosterSetupSkillPackageRoot(packageRootForModulePath(modulePath));
}
