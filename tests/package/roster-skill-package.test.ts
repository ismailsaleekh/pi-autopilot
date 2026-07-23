import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY,
  AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH,
  AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256,
  AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH,
  AUTOPILOT_ROSTER_SETUP_SKILL_NAME,
  AUTOPILOT_ROSTER_SETUP_SKILL_SHA256,
  AutopilotRosterSetupSkillPackageError,
  resolveAutopilotRosterSetupSkillPackage,
  verifyAutopilotRosterSetupSkillPackageRoot,
} from '../../src/core/roster/skill-package.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

interface PackFile {
  readonly path: string;
}

interface PackEntry {
  readonly files: readonly PackFile[];
}

type JsonRecord = Readonly<Record<string, unknown>>;

interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly disableModelInvocation: boolean;
}

interface RuntimeResourceLoader {
  reload(): Promise<void>;
  getSkills(): { readonly skills: readonly DiscoveredSkill[] };
}

interface PiSdkRuntime {
  readonly DefaultResourceLoader: new (options: JsonRecord) => RuntimeResourceLoader;
  readonly SettingsManager: {
    inMemory(settings: JsonRecord, options: JsonRecord): unknown;
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function loadPiSdkRuntime(): Promise<PiSdkRuntime> {
  const moduleUrl = pathToFileURL(join(packageRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')).href;
  const imported = await import(moduleUrl) as unknown;
  if (!isRecord(imported)) throw new TypeError('Pi SDK runtime import must be an object');
  const DefaultResourceLoader = imported['DefaultResourceLoader'];
  const SettingsManager = imported['SettingsManager'];
  if (typeof DefaultResourceLoader !== 'function') throw new TypeError('Pi SDK DefaultResourceLoader must be a constructor');
  if ((typeof SettingsManager !== 'function' && !isRecord(SettingsManager)) || typeof (SettingsManager as Readonly<Record<string, unknown>>)['inMemory'] !== 'function') throw new TypeError('Pi SDK SettingsManager.inMemory must be available');
  return { DefaultResourceLoader: DefaultResourceLoader as PiSdkRuntime['DefaultResourceLoader'], SettingsManager: SettingsManager as PiSdkRuntime['SettingsManager'] };
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new TypeError(`${label} must contain strings`);
    result.push(entry);
  }
  return result;
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function parsePackEntries(stdout: string): PackEntry[] {
  const parsed: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new TypeError('npm pack JSON must be an array');
  return parsed.map((entry): PackEntry => {
    if (!isRecord(entry)) throw new TypeError('npm pack entry must be an object');
    const files = entry['files'];
    if (!Array.isArray(files)) throw new TypeError('npm pack files must be an array');
    return {
      files: files.map((file): PackFile => {
        if (!isRecord(file) || typeof file['path'] !== 'string') throw new TypeError('npm pack file entry must include path');
        return { path: file['path'] };
      }),
    };
  });
}

function packageManifest(): JsonRecord {
  const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as unknown;
  if (!isRecord(parsed)) throw new TypeError('package.json must be an object');
  return parsed;
}

function assertRosterPackageError(fn: () => unknown, reason: AutopilotRosterSetupSkillPackageError['reason']): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof AutopilotRosterSetupSkillPackageError)) {
      throw new Error(`expected AutopilotRosterSetupSkillPackageError, got ${String(error)}`);
    }
    assert.equal(error.reason, reason);
    return;
  }
  throw new Error(`expected roster skill package verifier to fail with ${reason}`);
}

async function materializeMinimalPackageRoot(destination: string): Promise<void> {
  await mkdir(join(destination, 'templates', 'skills', 'autopilot-roster-setup'), { recursive: true });
  await writeFile(
    join(destination, 'package.json'),
    `${JSON.stringify({ name: 'pi-autopilot', pi: { skills: [AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY] } }, null, 2)}\n`,
    'utf8',
  );
  await copyFile(join(packageRoot, ...AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH.split('/')), join(destination, ...AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH.split('/')));
  await copyFile(join(packageRoot, ...AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH.split('/')), join(destination, ...AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH.split('/')));
}

void it('resolves exact packaged roster setup resource bytes and hashes fail-closed', async () => {
  const resource = resolveAutopilotRosterSetupSkillPackage();
  assert.equal(resource.packageRoot, packageRoot);
  assert.equal(resource.name, AUTOPILOT_ROSTER_SETUP_SKILL_NAME);
  assert.equal(resource.skillRelativePath, AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH);
  assert.equal(resource.payloadRelativePath, AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH);
  assert.equal(resource.skillSha256, AUTOPILOT_ROSTER_SETUP_SKILL_SHA256);
  assert.equal(resource.payloadSha256, AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256);
  assert.equal(await fileSha256(resource.skillPath), AUTOPILOT_ROSTER_SETUP_SKILL_SHA256);
  assert.equal(await fileSha256(resource.payloadPath), AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256);
  assert.equal(resource.payload.resources.skill_md.path, AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH);
  assert.equal(resource.payload.resources.skill_md.sha256, AUTOPILOT_ROSTER_SETUP_SKILL_SHA256);
  assert.deepEqual(resource.payload.required_tool_contract.zero_write_actions, ['inspect', 'propose', 'propose-custom', 'reject', 'doctor']);
  assert.deepEqual(resource.payload.required_tool_contract.v2_actions, ['propose-custom', 'reject', 'save']);
  assert.deepEqual(resource.payload.conversation_contract.post_save, ['fresh_pi_session_required', 'retry_exact_original_autopilot_command', 'never_auto_start']);
  for (const marker of [
    'disable-model-invocation: true',
    'ordinary multi-turn conversation',
    'Do not open a wizard, menu',
    'write_count=0',
    'candidate_set_sha256',
    'approved_roster_sha256s, in proposal order',
    'role_assignment_intent',
    'structurally valid custom roster is **not ready**',
    'Recommend Cruise only when',
    'fresh Pi session',
    'Do not auto-start Autopilot',
  ]) {
    assert.match(resource.skillText, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  }
});

void it('declares and discovers the normally inactive Pi package skill', async () => {
  const manifest = packageManifest();
  const pi = manifest['pi'];
  if (!isRecord(pi)) throw new TypeError('package pi manifest must be an object');
  assert.deepEqual(pi['skills'], [AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY]);
  const files = requireStringArray(manifest['files'], 'package files');
  assert.equal(files.includes('skills/'), false, 'package must not add a broad top-level skills payload');

  const tempRoot = await mkdtemp(join(tmpdir(), 'pi-autopilot-roster-skill-discovery-'));
  try {
    const { DefaultResourceLoader, SettingsManager } = await loadPiSdkRuntime();
    const settingsManager = SettingsManager.inMemory({ packages: [packageRoot] }, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd: tempRoot,
      agentDir: join(tempRoot, 'agent'),
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { skills } = loader.getSkills();
    const skill = skills.find((entry) => entry.name === AUTOPILOT_ROSTER_SETUP_SKILL_NAME);
    if (skill === undefined) throw new Error(`expected ${AUTOPILOT_ROSTER_SETUP_SKILL_NAME} to be discovered`);
    assert.equal(skill.disableModelInvocation, true);
    assert.equal(resolve(skill.filePath), join(packageRoot, ...AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH.split('/')));
    assert.equal(resolve(skill.baseDir), join(packageRoot, 'templates', 'skills', 'autopilot-roster-setup'));
    assert.match(skill.description, /Normally inactive agent-first Autopilot roster setup lane/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

void it('includes the exact resource files in the packed npm payload without unrelated broadening', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/pi-npm-cache' },
  });
  assert.equal(packed.status, 0, packed.stderr);
  const entries = parsePackEntries(packed.stdout);
  const entry = entries[0];
  if (entry === undefined) throw new Error('npm pack must produce one entry');
  const files = entry.files.map((file) => file.path).sort();
  assert.ok(files.includes(AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH), AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH);
  assert.ok(files.includes(AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH), AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH);
  assert.ok(files.includes('src/core/roster/skill-package.ts'), 'src/core/roster/skill-package.ts');
  assert.equal(files.some((file) => file.startsWith('skills/')), false, 'adding the roster setup skill must not introduce a broad top-level skills payload');
  assert.equal(files.some((file) => file.startsWith('tests/')), false, 'tests must stay out of the packed payload');
});

void it('rejects missing, tampered, and incorrectly declared packaged resources', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'pi-autopilot-roster-skill-negative-'));
  try {
    const exactRoot = join(tempRoot, 'exact');
    await materializeMinimalPackageRoot(exactRoot);
    assert.equal(verifyAutopilotRosterSetupSkillPackageRoot(exactRoot).skillSha256, AUTOPILOT_ROSTER_SETUP_SKILL_SHA256);

    const tamperedRoot = join(tempRoot, 'tampered');
    await materializeMinimalPackageRoot(tamperedRoot);
    await writeFile(join(tamperedRoot, ...AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH.split('/')), 'tampered\n', 'utf8');
    assertRosterPackageError(() => verifyAutopilotRosterSetupSkillPackageRoot(tamperedRoot), 'hash-mismatch');

    const missingRoot = join(tempRoot, 'missing');
    await materializeMinimalPackageRoot(missingRoot);
    await rm(join(missingRoot, ...AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH.split('/')));
    assertRosterPackageError(() => verifyAutopilotRosterSetupSkillPackageRoot(missingRoot), 'missing');

    const broadManifestRoot = join(tempRoot, 'broad-manifest');
    await materializeMinimalPackageRoot(broadManifestRoot);
    await writeFile(join(broadManifestRoot, 'package.json'), `${JSON.stringify({ name: 'pi-autopilot', pi: { skills: ['./templates/skills'] } }, null, 2)}\n`, 'utf8');
    assertRosterPackageError(() => verifyAutopilotRosterSetupSkillPackageRoot(broadManifestRoot), 'payload-contract');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
