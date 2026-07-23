import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertNoSymlinkOnSkillPath,
  discoverPackedRosterSetupSkill,
  expectedPackageSkillEntry,
  expectedPackageSkillName,
  packageRootPath,
  sha256,
} from '../helpers/roster-setup-harness.ts';
import {
  AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY,
  AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH,
  AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256,
  AUTOPILOT_ROSTER_SETUP_SKILL_BYTE_COUNT,
  AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH,
  AUTOPILOT_ROSTER_SETUP_SKILL_NAME,
  AUTOPILOT_ROSTER_SETUP_SKILL_SHA256,
  resolveAutopilotRosterSetupSkillPackage,
} from '../../src/core/roster/skill-package.ts';

interface PackFile {
  readonly path: string;
}

interface PackEntry {
  readonly files: readonly PackFile[];
}

interface JsonMap {
  readonly [key: string]: unknown;
}

const packageRoot = packageRootPath();

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePackEntries(stdout: string): PackEntry[] {
  const parsed: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new TypeError('npm pack JSON must be an array');
  return parsed.map((entry): PackEntry => {
    if (!isJsonMap(entry)) throw new TypeError('npm pack entry must be an object');
    const files = entry['files'];
    if (!Array.isArray(files)) throw new TypeError('npm pack files must be an array');
    return {
      files: files.map((file): PackFile => {
        if (!isJsonMap(file) || typeof file['path'] !== 'string') throw new TypeError('npm pack file entry must include path');
        return { path: file['path'] };
      }),
    };
  });
}

void describe('Phase 37 W2 roster onboarding packed skill package', () => {
  void it('is discoverable by a Pi package-style skill loader with exact bytes and disable-model-invocation', async () => {
    await assertNoSymlinkOnSkillPath(packageRoot);
    const discovered = await discoverPackedRosterSetupSkill(packageRoot);
    assert.equal(expectedPackageSkillEntry(), AUTOPILOT_ROSTER_SETUP_PACKAGE_SKILL_ENTRY);
    assert.equal(expectedPackageSkillName(), AUTOPILOT_ROSTER_SETUP_SKILL_NAME);
    assert.equal(discovered.length, 1);
    const skill = discovered[0];
    if (skill === undefined) throw new Error('missing roster setup skill');
    assert.equal(skill.name, AUTOPILOT_ROSTER_SETUP_SKILL_NAME);
    assert.equal(skill.name, expectedPackageSkillName());
    assert.equal(skill.disableModelInvocation, true);
    assert.match(skill.description, /Normally inactive agent-first Autopilot roster setup lane/u);
    assert.equal(resolve(skill.filePath), join(packageRoot, ...AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH.split('/')));
    assert.equal(resolve(skill.baseDir), join(packageRoot, 'templates', 'skills', AUTOPILOT_ROSTER_SETUP_SKILL_NAME));
    assert.equal(skill.bytes.byteLength, AUTOPILOT_ROSTER_SETUP_SKILL_BYTE_COUNT);
    assert.equal(skill.sha256, AUTOPILOT_ROSTER_SETUP_SKILL_SHA256);
    assert.deepEqual(skill.bytes, await readFile(skill.filePath));

    const verified = resolveAutopilotRosterSetupSkillPackage();
    assert.equal(verified.skillSha256, skill.sha256);
    assert.equal(verified.skillText, Buffer.from(skill.bytes).toString('utf8'));
    assert.equal(verified.payload.resources.skill_md.sha256, AUTOPILOT_ROSTER_SETUP_SKILL_SHA256);
    assert.equal(sha256(await readFile(join(packageRoot, ...AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH.split('/')))), AUTOPILOT_ROSTER_SETUP_PAYLOAD_SHA256);
  });

  void it('packs only the exact onboarding skill resources without broad skill or test payloads', () => {
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
    assert.equal(files.includes(AUTOPILOT_ROSTER_SETUP_SKILL_MD_PATH), true);
    assert.equal(files.includes(AUTOPILOT_ROSTER_SETUP_PAYLOAD_PATH), true);
    assert.equal(files.some((file) => file.startsWith('skills/')), false);
    assert.equal(files.some((file) => file.startsWith('tests/')), false);
    assert.equal(files.some((file) => file.includes('node_modules')), false);
  });
});
