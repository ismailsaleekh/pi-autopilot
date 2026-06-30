import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

interface PackageScripts {
  readonly [key: string]: string | undefined;
}

interface PackageBin {
  readonly 'autopilot-agent-run'?: string;
}

interface PackageJson {
  readonly name: string;
  readonly type: string;
  readonly keywords: readonly string[];
  readonly files: readonly string[];
  readonly bin: PackageBin;
  readonly pi: { readonly extensions: readonly string[] };
  readonly scripts: PackageScripts;
  readonly peerDependencies: PackageScripts;
}

interface PackFile {
  readonly path: string;
}

interface PackEntry {
  readonly filename: string;
  readonly files: readonly PackFile[];
}

const root = new URL('../../', import.meta.url);

const DOC_FILES = ['README.md', 'TESTING.md', 'TEST_PLAN.md', 'PUBLISHING.md'] as const;

interface JsonMap {
  readonly [key: string]: unknown;
}

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: JsonMap, key: string): unknown {
  return value[key];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const values: readonly unknown[] = value;
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string') throw new TypeError(`${label} must contain strings`);
    result.push(item);
  }
  return result;
}

function requireStringMap(value: unknown, label: string): PackageScripts {
  if (!isJsonMap(value)) throw new TypeError(`${label} must be an object`);
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function parsePackageJson(value: unknown): PackageJson {
  if (!isJsonMap(value)) throw new TypeError('package.json must be an object');
  const pi = field(value, 'pi');
  const bin = field(value, 'bin');
  if (!isJsonMap(pi)) throw new TypeError('pi must be an object');
  if (!isJsonMap(bin)) throw new TypeError('bin must be an object');
  return {
    name: requireString(field(value, 'name'), 'name'),
    type: requireString(field(value, 'type'), 'type'),
    keywords: requireStringArray(field(value, 'keywords'), 'keywords'),
    files: requireStringArray(field(value, 'files'), 'files'),
    bin: { 'autopilot-agent-run': requireString(field(bin, 'autopilot-agent-run'), 'bin') },
    pi: { extensions: requireStringArray(field(pi, 'extensions'), 'pi.extensions') },
    scripts: requireStringMap(field(value, 'scripts'), 'scripts'),
    peerDependencies: requireStringMap(field(value, 'peerDependencies'), 'peerDependencies'),
  };
}

async function packageJson(): Promise<PackageJson> {
  return parsePackageJson(parseJson(await readFile(new URL('package.json', root), 'utf8')));
}

async function docText(file: (typeof DOC_FILES)[number]): Promise<string> {
  return await readFile(new URL(file, root), 'utf8');
}

function literalPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function parsePackEntries(stdout: string): PackEntry[] {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed)) throw new TypeError('pack output must be an array');
  const packEntries: readonly unknown[] = parsed;
  return packEntries.map((entry): PackEntry => {
    if (!isJsonMap(entry)) throw new TypeError('pack entry must be an object');
    const files = field(entry, 'files');
    if (!Array.isArray(files)) throw new TypeError('pack files must be an array');
    const packFiles: readonly unknown[] = files;
    return {
      filename: requireString(field(entry, 'filename'), 'pack filename'),
      files: packFiles.map((file): PackFile => {
        if (!isJsonMap(file)) throw new TypeError('pack file must be an object');
        return { path: requireString(field(file, 'path'), 'pack file path') };
      }),
    };
  });
}

void describe('package manifest and payload', () => {
  void it('declares the Autopilot package surfaces', async () => {
    const pkg = await packageJson();
    assert.equal(pkg.name, 'pi-autopilot');
    assert.equal(pkg.type, 'module');
    assert.ok(pkg.keywords.includes('pi-package'));
    assert.ok(pkg.keywords.includes('pi-extension'));
    assert.ok(pkg.keywords.includes('autopilot'));
    assert.deepEqual(pkg.pi.extensions, ['./extensions/autopilot.ts']);
    assert.equal(pkg.bin['autopilot-agent-run'], './bin/autopilot-agent-run.mjs');
    assert.ok(pkg.peerDependencies['@earendil-works/pi-coding-agent']);
    for (const script of ['typecheck', 'test:type-safety', 'test:unit', 'test:sdk', 'test:rpc', 'test:package']) {
      assert.equal(typeof pkg.scripts[script], 'string', script);
    }
    for (const dir of ['bin/', 'extensions/', 'src/', 'templates/']) assert.ok(pkg.files.includes(dir), dir);
  });

  void it('has required docs and runtime files', async () => {
    for (const file of [
      'README.md',
      'TESTING.md',
      'TEST_PLAN.md',
      'PUBLISHING.md',
      'LICENSE',
      'extensions/autopilot.ts',
      'src/extension.ts',
      'src/core/context-budget.ts',
      'src/core/names.ts',
      'src/core/paths.ts',
      'src/core/prompts.ts',
      'bin/autopilot-agent-run.mjs',
      'templates/README.md',
    ]) {
      assert.ok(existsSync(new URL(file, root)), file);
    }
  });

  void it('documents current Autopilot surfaces across package docs', async () => {
    for (const file of DOC_FILES) {
      const text = await docText(file);
      for (const surface of ['autopilot-agent-run', 'context_budget', 'autopilot-restart']) {
        assert.match(text, literalPattern(surface), `${file} missing ${surface}`);
      }
    }

    const readme = await docText('README.md');
    const plan = await docText('TEST_PLAN.md');
    for (const surface of [
      '/autopilot',
      '/autopilot-restart',
      'context_budget',
      'autopilot-agent-run',
      '.pi/autopilot/<workstream>/',
      'autopilot_emit_status',
      'forced-output/status',
      'state-store',
      'fake-Pi',
      'offline SDK/RPC/package gates',
    ]) {
      assert.match(readme, literalPattern(surface), `README missing ${surface}`);
      assert.match(plan, literalPattern(surface), `TEST_PLAN missing ${surface}`);
    }
  });

  void it('maps README promises to TEST_PLAN rows', async () => {
    const readme = await docText('README.md');
    const plan = await docText('TEST_PLAN.md');
    const mappings = [
      { claim: 'Commands', row: 'Public commands are `/autopilot` and `/autopilot-restart`' },
      { claim: 'context_budget', row: '`context_budget` parent gate' },
      { claim: 'Contracts, templates, and state-store', row: 'Contracts/templates are schema-backed and package-owned' },
      { claim: 'forced-output/status', row: 'Forced-output/status tool is child-only' },
      { claim: 'state-store', row: 'State store' },
      { claim: 'autopilot-agent-run', row: '`autopilot-agent-run` bin is shipped' },
      { claim: 'fake-Pi', row: 'Runner accepts valid fake child' },
      { claim: 'parent prompt', row: 'Parent prompt requires `context_budget`' },
      { claim: 'restart prompt', row: 'Restart prompt is read-only' },
      { claim: 'offline SDK/RPC/package gates', row: 'Offline SDK/RPC/package gates are provider-free' },
      { claim: 'pack:dry-run', row: 'Published package payload' },
      { claim: 'Known limitations', row: 'Remaining limitations are documented' },
    ];
    for (const mapping of mappings) {
      assert.match(readme, literalPattern(mapping.claim), `README missing claim ${mapping.claim}`);
      assert.match(plan, literalPattern(mapping.row), `TEST_PLAN missing row ${mapping.row}`);
    }
  });

  void it('keeps pack and test instructions coherent', async () => {
    const pkg = await packageJson();
    const testing = await docText('TESTING.md');
    const publishing = await docText('PUBLISHING.md');
    for (const script of ['typecheck', 'test:package', 'test', 'pack:dry-run']) {
      assert.equal(typeof pkg.scripts[script], 'string', script);
      const command = `npm --prefix packages/pi-autopilot run ${script}`;
      assert.match(testing, literalPattern(command), `TESTING missing ${command}`);
      assert.match(publishing, literalPattern(command), `PUBLISHING missing ${command}`);
    }
  });

  void it('does not publish stale docs claims', async () => {
    const stalePhrases = [
      'placeholder',
      'skeleton lane',
      'W2 provides',
      'shipped W2',
      'does not yet implement live child-agent execution',
      'runner remains offline',
      'placeholder for package wiring only',
    ];
    for (const file of DOC_FILES) {
      const text = await docText(file);
      for (const phrase of stalePhrases) {
        assert.equal(text.includes(phrase), false, `${file} contains stale phrase ${phrase}`);
      }
    }
  });

  void it('packs the runtime payload and excludes tests', () => {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/pi-npm-cache' },
    });
    assert.equal(result.status, 0, result.stderr);
    const entries = parsePackEntries(result.stdout);
    const entry = entries[0];
    if (entry === undefined) throw new Error('pack must return an entry');
    assert.match(entry.filename, /^pi-autopilot-/);
    const files = entry.files.map((file) => file.path).sort();
    for (const file of [
      'package.json',
      'README.md',
      'TESTING.md',
      'TEST_PLAN.md',
      'PUBLISHING.md',
      'LICENSE',
      'extensions/autopilot.ts',
      'src/extension.ts',
      'src/core/context-budget.ts',
      'src/core/names.ts',
      'src/core/paths.ts',
      'src/core/prompts.ts',
      'src/testing/fake-extension-host.ts',
      'bin/autopilot-agent-run.mjs',
      'templates/README.md',
    ]) {
      assert.ok(files.includes(file), file);
    }
    assert.equal(files.some((file) => file.startsWith('tests/')), false);
    assert.equal(files.some((file) => file.includes('node_modules')), false);
  });

  void it('exposes the runner help path', () => {
    const result = spawnSync(process.execPath, ['bin/autopilot-agent-run.mjs', '--help'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /autopilot-agent-run/);
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /--pi-executable/);
  });
});
