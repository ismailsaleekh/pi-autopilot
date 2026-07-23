import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotUnitWorktree, prepareAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';

interface PackageScripts {
  readonly [key: string]: string | undefined;
}

interface PackageBin {
  readonly 'autopilot-agent-run'?: string;
  readonly 'autopilot-coordinator'?: string;
  readonly 'autopilot-s2-corpus-rehearsal'?: string;
}

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly author: string;
  readonly keywords: readonly string[];
  readonly files: readonly string[];
  readonly bin: PackageBin;
  readonly pi: { readonly extensions: readonly string[] };
  readonly scripts: PackageScripts;
  readonly peerDependencies: PackageScripts;
  readonly repository: { readonly type: string; readonly url: string };
  readonly bugs: { readonly url: string };
  readonly homepage: string;
  readonly publishConfig: { readonly access: string };
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
  const repository = field(value, 'repository');
  const bugs = field(value, 'bugs');
  const publishConfig = field(value, 'publishConfig');
  if (!isJsonMap(repository)) throw new TypeError('repository must be an object');
  if (!isJsonMap(bugs)) throw new TypeError('bugs must be an object');
  if (!isJsonMap(publishConfig)) throw new TypeError('publishConfig must be an object');
  return {
    name: requireString(field(value, 'name'), 'name'),
    version: requireString(field(value, 'version'), 'version'),
    type: requireString(field(value, 'type'), 'type'),
    author: requireString(field(value, 'author'), 'author'),
    keywords: requireStringArray(field(value, 'keywords'), 'keywords'),
    files: requireStringArray(field(value, 'files'), 'files'),
    bin: {
      'autopilot-agent-run': requireString(field(bin, 'autopilot-agent-run'), 'bin.autopilot-agent-run'),
      'autopilot-coordinator': requireString(field(bin, 'autopilot-coordinator'), 'bin.autopilot-coordinator'),
      'autopilot-s2-corpus-rehearsal': requireString(field(bin, 'autopilot-s2-corpus-rehearsal'), 'bin.autopilot-s2-corpus-rehearsal'),
    },
    pi: { extensions: requireStringArray(field(pi, 'extensions'), 'pi.extensions') },
    scripts: requireStringMap(field(value, 'scripts'), 'scripts'),
    peerDependencies: requireStringMap(field(value, 'peerDependencies'), 'peerDependencies'),
    repository: {
      type: requireString(field(repository, 'type'), 'repository.type'),
      url: requireString(field(repository, 'url'), 'repository.url'),
    },
    bugs: { url: requireString(field(bugs, 'url'), 'bugs.url') },
    homepage: requireString(field(value, 'homepage'), 'homepage'),
    publishConfig: { access: requireString(field(publishConfig, 'access'), 'publishConfig.access') },
  };
}

async function packageJson(): Promise<PackageJson> {
  return parsePackageJson(parseJson(await readFile(new URL('package.json', root), 'utf8')));
}

async function docText(file: (typeof DOC_FILES)[number]): Promise<string> {
  return await readFile(new URL(file, root), 'utf8');
}

async function sourceText(file: string): Promise<string> {
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
  void it('BUG-173 rejects tracked local runtime state in the public package repository', () => {
    const tracked = spawnSync('git', ['ls-files', '-z', '--', '.pi'], { cwd: root, encoding: 'utf8' });
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.equal(tracked.stdout, '', 'public package source must track zero local runtime-state paths');
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '.pi/runtime-state-probe'], { cwd: root, encoding: 'utf8' });
    assert.equal(ignored.status, 0, 'the package must ignore its complete local runtime-state root');
  });

  void it('declares the Autopilot package surfaces', async () => {
    const pkg = await packageJson();
    assert.equal(pkg.name, 'pi-autopilot');
    assert.equal(pkg.version, '1.2.0');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.author, 'Ismail Salikhodjaev <ismailsalikhodjaev@gmail.com>');
    assert.deepEqual(pkg.repository, {
      type: 'git',
      url: 'git+https://github.com/ismailsaleekh/pi-autopilot.git',
    });
    assert.equal(pkg.bugs.url, 'https://github.com/ismailsaleekh/pi-autopilot/issues');
    assert.equal(pkg.homepage, 'https://github.com/ismailsaleekh/pi-autopilot#readme');
    assert.equal(pkg.publishConfig.access, 'public');
    assert.ok(pkg.keywords.includes('pi-package'));
    assert.ok(pkg.keywords.includes('pi-extension'));
    assert.ok(pkg.keywords.includes('autopilot'));
    assert.deepEqual(pkg.pi.extensions, ['./extensions/autopilot.ts']);
    assert.equal(pkg.bin['autopilot-agent-run'], 'bin/autopilot-agent-run.mjs');
    assert.equal(pkg.bin['autopilot-coordinator'], 'bin/autopilot-coordinator.mjs');
    assert.equal(pkg.bin['autopilot-s2-corpus-rehearsal'], 'bin/autopilot-s2-corpus-rehearsal.mjs');
    assert.ok(pkg.files.includes('dist/'));
    assert.ok(pkg.peerDependencies['@earendil-works/pi-coding-agent']);
    for (const script of ['build', 'typecheck', 'test:type-safety', 'test:unit', 'test:e2e', 'test:model', 'test:multiprocess', 'test:version-skew', 'test:upgrade', 'test:crash', 'test:chaos', 'test:scale', 'test:sdk', 'test:rpc', 'test:package', 'test:packed-migration', 'test:s2-corpus', 's2:corpus', 'security:scan', 'security:audit', 'sbom', 'payload:check', 'test', 'test:release', 'pack:dry-run']) {
      assert.equal(typeof pkg.scripts[script], 'string', script);
    }
    assert.match(pkg.scripts['prepack'] ?? '', /security:scan -- --quiet && npm run sbom/u, 'prepack must regenerate security evidence before SBOM');
    assert.match(pkg.scripts['test:multiprocess'] ?? '', /--test-concurrency=1/u, 'resource-heavy real-process files must be serialized so fixed startup deadlines are not invalidated by cross-file load');
    for (const dir of ['bin/', 'dist/', 'extensions/', 'src/', 'tools/s2-corpus-rehearsal/', 'templates/', 'artifacts/security/']) assert.ok(pkg.files.includes(dir), dir);
  });

  void it('pins shrinkwrapped Pi integrity and Linux native libc selectors without exceptions', async () => {
    const lockValue = parseJson(await readFile(new URL('package-lock.json', root), 'utf8'));
    if (!isJsonMap(lockValue)) throw new TypeError('package-lock.json must be an object');
    const packagesValue = field(lockValue, 'packages');
    if (!isJsonMap(packagesValue)) throw new TypeError('package-lock packages must be an object');
    const requireLockPackage = (path: string): JsonMap => {
      const value = field(packagesValue, path);
      if (!isJsonMap(value)) throw new TypeError(`package-lock entry missing: ${path}`);
      return value;
    };
    const piRoot = 'node_modules/@earendil-works/pi-coding-agent/node_modules/';
    const integrityByPackage = new Map<string, string>([
      ['@earendil-works/pi-agent-core', 'sha512-yqbh68CyhqxMov/jUogFJfMqlu2Gd37GAki+tr59YCmAPHfomiCA5ESzusXtpGzABeiZFC/OrRdQ4GwCCOMIHA=='],
      ['@earendil-works/pi-ai', 'sha512-hzHE7Z8l5mgJk+ke67Lge0rwS2+wbKJrFKl9o5M1R1rh33+cCT7D1AHz1OAtX5wFs90E1/BTGhyJRTUHaMxGvQ=='],
      ['@earendil-works/pi-tui', 'sha512-OMEe+Zt8oQYi/rCq3upxsTlIScWL0FPhXwQus34TbQb3EmTx88S7Uzx32JxvQiEeWOw8eDCdJf2PBUBE9r6wIg=='],
    ]);
    for (const [name, integrity] of integrityByPackage) {
      const entry = requireLockPackage(`${piRoot}${name}`);
      assert.equal(field(entry, 'version'), '0.81.1');
      assert.equal(field(entry, 'integrity'), integrity);
    }
    const libcByPackage = new Map<string, string>([
      ['@mariozechner/clipboard-linux-arm64-gnu', 'glibc'],
      ['@mariozechner/clipboard-linux-arm64-musl', 'musl'],
      ['@mariozechner/clipboard-linux-riscv64-gnu', 'glibc'],
      ['@mariozechner/clipboard-linux-x64-gnu', 'glibc'],
      ['@mariozechner/clipboard-linux-x64-musl', 'musl'],
    ]);
    for (const [name, libc] of libcByPackage) assert.deepEqual(field(requireLockPackage(`${piRoot}${name}`), 'libc'), [libc]);
  });

  void it('has required docs and runtime files', async () => {
    for (const file of [
      'src/core/coordination/migration.ts',
      'src/core/coordination/migration-paths.ts',
      'src/core/coordination/upgrade.ts',
      'src/core/coordination/upgrade-contracts.ts',
      'src/core/coordination/serialized-lock.ts',
      'src/core/coordination/immutable-file.ts',
      'dist/src/core/coordination/migration.js',
      'dist/src/core/coordination/migration-paths.js',
      'dist/src/core/coordination/upgrade.js',
      'dist/src/core/coordination/upgrade-contracts.js',
      'dist/src/core/coordination/serialized-lock.js',
      'dist/src/core/coordination/immutable-file.js',
      'artifacts/security/cyclonedx-sbom.json',
      'artifacts/security/offline-security-scan.json',
      'scripts/check-package-payload.mjs',
      'scripts/check-production-git-spawns.mjs',
      'scripts/generate-sbom.mjs',
      'scripts/run-certified-command.mjs',
      'scripts/security-scan.mjs',
      'scripts/test-packed-consumer-release.mjs',
      'scripts/verify-packed-consumer.mjs',
      'dist/tools/s2-corpus-rehearsal/cli.js',
      'dist/tools/s2-corpus-rehearsal/contracts.js',
      'dist/tools/s2-corpus-rehearsal/release-gate.js',
      'dist/tools/s2-corpus-rehearsal/terminal-recovery-worker.js',
      'tools/s2-corpus-rehearsal/cli.ts',
      'tools/s2-corpus-rehearsal/contracts.ts',
      'tools/s2-corpus-rehearsal/release-gate.ts',
      'bin/autopilot-s2-corpus-rehearsal.mjs',
      'README.md',
      'TESTING.md',
      'TEST_PLAN.md',
      'PUBLISHING.md',
      'LICENSE',
      'extensions/autopilot.ts',
      'src/extension.ts',
      'dist/src/cli/autopilot-agent-run.js',
      'dist/src/cli/autopilot-coordinator-bootstrap.js',
      'dist/src/cli/autopilot-coordinator.js',
      'dist/src/cli/migration-recovery.js',
      'dist/src/core/agent-runner.js',
      'dist/src/core/close-runtime.js',
      'dist/src/core/coordination/admission.js',
      'dist/src/core/coordination/client.js',
      'dist/src/core/coordination/executable-resolution.js',
      'dist/src/core/coordination/negotiated-transport.js',
      'dist/src/core/coordination/peer-admission-state.js',
      'dist/src/core/coordination/peer-classification.js',
      'dist/src/core/coordination/contracts.js',
      'dist/src/core/coordination/invariants.js',
      'dist/src/core/coordination/legacy-preflight.js',
      'dist/src/core/coordination/package-isolation.js',
      'dist/src/core/coordination/server.js',
      'dist/src/core/coordination/store.js',
      'dist/src/core/coordination/supervisor.js',
      'dist/src/core/coordination/transition-model.js',
      'dist/src/core/coordination/worktree-saga.js',
      'dist/src/internal/status-extension.js',
      'src/core/context-budget.ts',
      'src/core/coordination/index.ts',
      'src/core/coordination/admission.ts',
      'src/core/coordination/client.ts',
      'src/core/coordination/executable-resolution.ts',
      'src/core/coordination/negotiated-transport.ts',
      'src/core/coordination/peer-admission-state.ts',
      'src/core/coordination/peer-classification.ts',
      'src/core/coordination/contracts.ts',
      'src/core/coordination/invariants.ts',
      'src/core/coordination/legacy-preflight.ts',
      'src/core/coordination/package-isolation.ts',
      'src/core/coordination/server.ts',
      'src/core/coordination/store.ts',
      'src/core/coordination/supervisor.ts',
      'src/core/coordination/transition-model.ts',
      'src/core/coordination/worktree-saga.ts',
      'src/core/git-guard.ts',
      'src/core/checkout-profile.ts',
      'src/core/sparse-worktree.ts',
      'src/core/disk-gate.ts',
      'src/core/materialization.ts',
      'src/core/adjudication/index.ts',
      'src/core/lifecycle/index.ts',
      'src/core/close-runtime.ts',
      'src/core/names.ts',
      'src/core/paths.ts',
      'src/core/prompts.ts',
      'bin/autopilot-agent-run.mjs',
      'bin/autopilot-coordinator.mjs',
      'templates/README.md',
    ]) {
      assert.ok(existsSync(new URL(file, root)), file);
    }
  });

  // NOTE: the former 'documents current Autopilot surfaces across package docs' and
  // 'maps README promises to TEST_PLAN rows' presence-only checks were ABSORBED into
  // tests/package/docs-contract.test.ts (single source of truth, design section 11).
  // Surface coverage against code is enforced by the docs freshness gate (C1); the
  // TEST_PLAN capability-row ledger and thin-hub README routing are asserted there.

  void it('keeps pack and test instructions coherent', async () => {
    const pkg = await packageJson();
    const testing = await docText('TESTING.md');
    const publishing = await docText('PUBLISHING.md');
    const exactTestChain = 'npm run typecheck && npm run test:type-safety && npm run security:scan && npm run test:unit && npm run test:e2e && npm run test:model && npm run test:multiprocess && npm run test:crash && npm run test:chaos && npm run test:scale && npm run test:sdk && npm run test:rpc && npm run test:package && npm run payload:check';
    assert.equal(pkg.scripts['test'], exactTestChain);
    const expansionStart = testing.indexOf('`npm run test` expands to:');
    const expansionEnd = testing.indexOf('```', testing.indexOf('```bash', expansionStart) + '```bash'.length);
    const expansion = testing.slice(expansionStart, expansionEnd);
    let prior = -1;
    for (const command of exactTestChain.split(' && ')) {
      const index = expansion.indexOf(command);
      assert.ok(index > prior, `TESTING npm test expansion is missing or reorders ${command}`);
      prior = index;
    }
    assert.match(testing, /`sbom` and registry-backed `security:audit` are not nested in `npm run test`/u);
    for (const exactScaleClaim of ['exactly **100,000**', 'exactly **10,000**', 'exactly **32**', '**<60s**', '**<512 MiB**', '**<256 MiB**', '**<1s**', '**=100,000**', '**=10,000**']) {
      assert.match(await docText('TEST_PLAN.md'), literalPattern(exactScaleClaim), `TEST_PLAN missing exact scale assertion ${exactScaleClaim}`);
    }
    for (const script of ['typecheck', 'test:package', 'test:packed-migration', 'test:version-skew', 'test:s2-corpus', 'test', 'pack:dry-run', 'payload:check', 'security:scan', 'sbom']) {
      assert.equal(typeof pkg.scripts[script], 'string', script);
      const command = `npm run ${script}`;
      assert.match(testing, literalPattern(command), `TESTING missing ${command}`);
      assert.match(publishing, literalPattern(command), `PUBLISHING missing ${command}`);
    }
  });

  void it('locks CF-9 multiprocess and scale certification implementation claims', async () => {
    const scale = await sourceText('tests/scale/coordination-scale.test.ts');
    const multiprocess = await sourceText('tests/multiprocess/coordinator-process.test.ts');
    const processClient = await sourceText('tests/helpers/release-trace-process-client.ts');
    assert.match(scale, /stageCoordinatorSemanticReplay/u);
    assert.match(await sourceText('src/core/coordination/store.ts'), /parseSemanticReplayLine\(line/u);
    assert.equal((await sourceText('src/core/coordination/store.ts')).includes('SEMANTIC_REPLAY_OBSERVATION_LINE'), false, 'semantic replay must not regex-accept records');
    assert.match(scale, /EVENT_COUNT = 100_000/u);
    assert.match(scale, /REQUEST_COUNT = 10_000/u);
    assert.match(scale, /CLIENT_COUNT = 32/u);
    assert.equal(/INSERT\s+INTO/iu.test(scale), false, 'scale test must not insert coordinator rows directly');
    for (const limit of ['MAX_DURATION_MS = 60_000', 'MAX_RSS = 512 * 1024 * 1024', 'MAX_DATABASE_BYTES = 256 * 1024 * 1024', 'MAX_INDEXED_QUERY_MS = 1_000']) assert.match(scale, literalPattern(limit));
    assert.match((await packageJson()).scripts['test:scale'] ?? '', /--max-old-space-size=256/u);
    assert.match(multiprocess, /new PersistentTraceClient/u);
    assert.match(multiprocess, /randomizedTopologicalOrder/u);
    assert.match(multiprocess, /changing the seed must change operation categories/u);
    assert.match(multiprocess, /Promise\.all\(concurrentActors/u);
    assert.match(multiprocess, /coordinator races their sockets/u);
    for (const action of ['acquire', 'retry', 'defer', 'handoff', 'cancel', 'supersede', 'reacquire', 'crash']) assert.match(multiprocess, literalPattern(`'${action}'`));
    assert.match(processClient, /createInterface\(\{ input: process\.stdin/u);
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
      '/autopilot-restart',
      'autopilot-restart',
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
      'artifacts/security/cyclonedx-sbom.json',
      'artifacts/security/offline-security-scan.json',
      'dist/src/core/coordination/migration.js',
      'dist/src/core/coordination/migration-paths.js',
      'src/core/coordination/migration.ts',
      'src/core/coordination/migration-paths.ts',
      'package.json',
      'README.md',
      'TESTING.md',
      'TEST_PLAN.md',
      'PUBLISHING.md',
      'LICENSE',
      'extensions/autopilot.ts',
      'src/extension.ts',
      'dist/extensions/autopilot.js',
      'dist/src/cli/autopilot-agent-run.js',
      'dist/src/cli/autopilot-coordinator-bootstrap.js',
      'dist/src/cli/autopilot-coordinator.js',
      'dist/src/cli/migration-recovery.js',
      'dist/src/core/agent-runner.js',
      'dist/src/core/close-runtime.js',
      'dist/src/core/coordination/admission.js',
      'dist/src/core/coordination/client.js',
      'dist/src/core/coordination/executable-resolution.js',
      'dist/src/core/coordination/negotiated-transport.js',
      'dist/src/core/coordination/peer-admission-state.js',
      'dist/src/core/coordination/peer-classification.js',
      'dist/src/core/coordination/contracts.js',
      'dist/src/core/coordination/invariants.js',
      'dist/src/core/coordination/legacy-preflight.js',
      'dist/src/core/coordination/package-isolation.js',
      'dist/src/core/coordination/server.js',
      'dist/src/core/coordination/store.js',
      'dist/src/core/coordination/supervisor.js',
      'dist/src/core/coordination/transition-model.js',
      'dist/src/core/coordination/worktree-saga.js',
      'dist/src/internal/status-extension.js',
      'src/core/context-budget.ts',
      'src/core/coordination/admission.ts',
      'src/core/coordination/client.ts',
      'src/core/coordination/executable-resolution.ts',
      'src/core/coordination/negotiated-transport.ts',
      'src/core/coordination/peer-admission-state.ts',
      'src/core/coordination/peer-classification.ts',
      'src/core/coordination/contracts.ts',
      'src/core/coordination/invariants.ts',
      'src/core/coordination/legacy-preflight.ts',
      'src/core/coordination/package-isolation.ts',
      'src/core/coordination/server.ts',
      'src/core/coordination/store.ts',
      'src/core/coordination/supervisor.ts',
      'src/core/coordination/transition-model.ts',
      'src/core/coordination/worktree-saga.ts',
      'src/core/git-guard.ts',
      'src/core/checkout-profile.ts',
      'src/core/sparse-worktree.ts',
      'src/core/disk-gate.ts',
      'src/core/materialization.ts',
      'src/core/adjudication/index.ts',
      'src/core/lifecycle/index.ts',
      'src/core/close-runtime.ts',
      'src/core/names.ts',
      'src/core/paths.ts',
      'src/core/prompts.ts',
      'src/testing/fake-extension-host.ts',
      'dist/tools/s2-corpus-rehearsal/cli.js',
      'dist/tools/s2-corpus-rehearsal/contracts.js',
      'dist/tools/s2-corpus-rehearsal/release-gate.js',
      'dist/tools/s2-corpus-rehearsal/terminal-recovery-worker.js',
      'tools/s2-corpus-rehearsal/cli.ts',
      'tools/s2-corpus-rehearsal/contracts.ts',
      'tools/s2-corpus-rehearsal/release-gate.ts',
      'tools/s2-corpus-rehearsal/candidate-worker.ts',
      'tools/s2-corpus-rehearsal/terminal-recovery-worker.ts',
      'tools/s2-corpus-rehearsal/git-mirror.ts',
      'tools/s2-corpus-rehearsal/inventory.ts',
      'tools/s2-corpus-rehearsal/path-rebase.ts',
      'bin/autopilot-agent-run.mjs',
      'bin/autopilot-coordinator.mjs',
      'bin/autopilot-s2-corpus-rehearsal.mjs',
      'templates/README.md',
    ]) {
      assert.ok(files.includes(file), file);
    }
    assert.equal(files.some((file) => file.startsWith('tests/')), false);
    assert.equal(files.includes('tests/fixtures/releases/cf50/pi-autopilot-1.1.8-cf50.tgz'), false, 'the actual cf50 skew fixture must never ship in the npm payload');
    assert.equal(files.includes('tests/fixtures/releases/s2/manifest.json'), false, 'S2-C release manifests stay test-only');
    assert.equal(files.some((file) => file !== 'docs/tools/s2-corpus-rehearsal.md' && /(?:^|\/)(?:private|corpus|corpora|results?|logs?)(?:\/|$)|\.(?:tgz|tar|tar\.gz|zip|log)$/iu.test(file)), false, 'package payload must deterministically exclude private S2 corpus inputs, outputs, logs, and tarballs while allowing the required generic public S2-D docs');
    assert.equal(files.some((file) => file.startsWith('tools/') && !file.startsWith('tools/s2-corpus-rehearsal/')), false, 'only generic S2-D corpus harness tools may ship');
    assert.equal(files.some((file) => file.includes('node_modules')), false);
  });

  void it('keeps post-cutover runtime authority coordinator-only with no task-info or unmanaged-worktree fallback', async () => {
    const parallel = await readFile(new URL('src/core/parallel-runtime.ts', root), 'utf8');
    const runner = await readFile(new URL('src/core/agent-runner.ts', root), 'utf8');
    const saga = await readFile(new URL('src/core/coordination/worktree-saga.ts', root), 'utf8');
    const coordinatorProjection = parallel.slice(parallel.indexOf('export async function readCoordinatorActiveAutopilots'), parallel.indexOf('function legacyRootIdentity'));
    assert.match(coordinatorProjection, /readCoordinatorRunCatalog/u);
    assert.equal(/TASK_INFO_FILE|readJson/u.test(coordinatorProjection), false);
    assert.match(parallel, /post-cutover activation requires a durable coordinator session/u);
    assert.match(runner, /readCoordinatorActiveAutopilots/u);
    assert.match(saga, /post-cutover worktree mutation requires a current durable coordinator session/u);
    for (const functionName of ['writeActiveAutopilots', 'writePathClaims', 'appendClaimEvent']) {
      const start = parallel.indexOf(`export async function ${functionName}`);
      assert.notEqual(start, -1);
      assert.match(parallel.slice(start, start + 600), /assertLegacyCoordinationWritable/u, functionName);
    }
  });

  void it('ships compiled authority, observation, terminal-acceptance, migration, and recovery behavior in exact source parity', async () => {
    const sourceStore = await readFile(new URL('src/core/coordination/store.ts', root), 'utf8');
    const compiledStore = await readFile(new URL('dist/src/core/coordination/store.js', root), 'utf8');
    const sourceMigration = await readFile(new URL('src/core/coordination/migration.ts', root), 'utf8');
    const compiledMigration = await readFile(new URL('dist/src/core/coordination/migration.js', root), 'utf8');
    const sourceRunner = await readFile(new URL('src/core/agent-runner.ts', root), 'utf8');
    const compiledRunner = await readFile(new URL('dist/src/core/agent-runner.js', root), 'utf8');
    const sourceUnavailableRecovery = await readFile(new URL('src/core/coordination/unavailable-recovery.ts', root), 'utf8');
    const compiledUnavailableRecovery = await readFile(new URL('dist/src/core/coordination/unavailable-recovery.js', root), 'utf8');
    const sourceToolCallId = await readFile(new URL('src/core/tool-call-id.ts', root), 'utf8');
    const compiledToolCallId = await readFile(new URL('dist/src/core/tool-call-id.js', root), 'utf8');
    for (const marker of ['register-authoritative-artifact', 'assign-adjudication', 'claim-adjudication-assignment', 'complete-adjudication', 'terminal_evidence_ref', 'materialization-read-expansion', 'checkpoint-child', 'deadlockFixedPointMeasure', 'evidence_artifacts', 'observations']) {
      assert.equal(sourceStore.includes(marker), true, `source is missing ${marker}`);
      assert.equal(compiledStore.includes(marker), true, `compiled coordinator is stale for ${marker}`);
    }
    for (const marker of ['after-cutover-marker', 'source-hashes-rechecked-before-cutover', 'legacy-files-archived-read-only', 'runtime-projections-rebound']) {
      assert.equal(sourceMigration.includes(marker), true, `source migration is missing ${marker}`);
      assert.equal(compiledMigration.includes(marker), true, `compiled migration is stale for ${marker}`);
    }
    for (const marker of ['preemptionSignal', 'quarantineFailedUnit', 'writeAutopilotChildTerminalAcceptance', 'preserveOrResetFailedSourceAttempt']) {
      assert.equal(sourceRunner.includes(marker), true, `source runner is missing ${marker}`);
      assert.equal(compiledRunner.includes(marker), true, `compiled runner is stale for ${marker}`);
    }
    for (const marker of ['endpoint-recovered', 'process_start_identity', 'retireExactProcess']) {
      assert.equal(sourceUnavailableRecovery.includes(marker), true, `source unavailable recovery is missing ${marker}`);
      assert.equal(compiledUnavailableRecovery.includes(marker), true, `compiled unavailable recovery is stale for ${marker}`);
    }
    for (const marker of ['opaqueToolCallIdIssue', 'Unicode code points', "pattern: '^[^\\\\u0000]*$'"]) {
      assert.equal(sourceToolCallId.includes(marker), true, `source tool-call-id contract is missing ${marker}`);
      assert.equal(compiledToolCallId.includes(marker), true, `compiled tool-call-id contract is stale for ${marker}`);
    }
  });

  void it('ships the admission HMAC security boundary in compiled parity', async () => {
    const sourceAdmission = await readFile(new URL('src/core/coordination/admission.ts', root), 'utf8');
    const compiledAdmission = await readFile(new URL('dist/src/core/coordination/admission.js', root), 'utf8');
    const sourceTransport = await readFile(new URL('src/core/coordination/negotiated-transport.ts', root), 'utf8');
    const compiledTransport = await readFile(new URL('dist/src/core/coordination/negotiated-transport.js', root), 'utf8');
    for (const marker of ['pi-autopilot/admission/v1\\0', "Buffer.from(capability, 'hex')", 'canonicalJson(unsigned)', 'timingSafeEqual(actualHmac, expectedHmac)']) {
      assert.equal(sourceAdmission.includes(marker), true, `source admission is missing ${marker}`);
      assert.equal(compiledAdmission.includes(marker), true, `compiled admission is stale for ${marker}`);
    }
    for (const marker of ['runCoordinatorNegotiatedTransport', 'CoordinatorSocketChannel', 'multiple or unsolicited response frames', 'coordinator connection closed between protocol phases']) {
      assert.equal(sourceTransport.includes(marker), true, `source negotiated transport is missing ${marker}`);
      assert.equal(compiledTransport.includes(marker), true, `compiled negotiated transport is stale for ${marker}`);
    }
  });

  void it('exposes the runner help path without Node type stripping', async () => {
    const wrapper = await readFile(new URL('bin/autopilot-agent-run.mjs', root), 'utf8');
    assert.equal(wrapper.includes('--experimental-strip-types'), false);
    assert.equal(wrapper.includes('src/cli/autopilot-agent-run.ts'), false);
    assert.match(wrapper, /'dist', 'src', 'cli', 'autopilot-agent-run\.js'/u);

    const result = spawnSync(process.execPath, ['bin/autopilot-agent-run.mjs', '--help'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /autopilot-agent-run/);
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /--pi-executable/);
  });

  void it('exposes the coordinator help path without TypeScript stripping', async () => {
    const wrapper = await readFile(new URL('bin/autopilot-coordinator.mjs', root), 'utf8');
    const client = await readFile(new URL('src/core/coordination/client.ts', root), 'utf8');
    const coordinatorCli = await readFile(new URL('src/cli/autopilot-coordinator.ts', root), 'utf8');
    const coordinationIndex = await readFile(new URL('src/core/coordination/index.ts', root), 'utf8');
    const resolver = await readFile(new URL('src/core/coordination/executable-resolution.ts', root), 'utf8');
    assert.equal(wrapper.includes('--experimental-strip-types'), false);
    assert.equal(client.includes('--experimental-strip-types'), false);
    assert.equal(client.includes('autopilot-coordinator.ts'), false);
    assert.equal(resolver.includes('process.cwd'), false);
    assert.equal(resolver.includes("process.env['PATH']"), false);
    assert.equal(existsSync(new URL('src/core/coordination/patch-activation.ts', root)), false);
    assert.equal(coordinatorCli.includes('activate-patch'), false);
    assert.equal(coordinatorCli.includes('patch-readiness'), false);
    assert.equal(coordinationIndex.includes('patch-activation'), false);
    assert.match(wrapper, /'dist', 'src', 'cli', 'autopilot-coordinator\.js'/u);
    assert.match(resolver, /autopilot-coordinator-bootstrap/u);
    const result = spawnSync(process.execPath, ['bin/autopilot-coordinator.mjs', '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /autopilot-coordinator status/u);
    assert.match(result.stdout, /replay --replay-id/u);
    assert.match(result.stdout, /--input <absolute-request-jsonl>/u);
    assert.match(result.stdout, /migrate --dry-run/u);
    assert.match(result.stdout, /verify \[--repo-key/u);
    assert.equal(result.stdout.includes('activate-patch'), false);
    assert.equal(result.stdout.includes('patch-readiness'), false);
    const obsolete = spawnSync(process.execPath, ['bin/autopilot-coordinator.mjs', 'activate-patch'], { cwd: root, encoding: 'utf8' });
    assert.equal(obsolete.status, 2);
    assert.match(obsolete.stderr, /usage: autopilot-coordinator serve/u);
    const invalid = spawnSync(process.execPath, ['bin/autopilot-coordinator.mjs', 'migrate', '--repo-key', 'missing-mode'], { cwd: root, encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /requires a mode/u);
  });

  void it('BUG-172 runs both packed npm bins from node_modules without TypeScript stripping', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-autopilot-installed-bin-'));
    const previousStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
    let coordinatorStateRoot: string | null = null;
    try {
      const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', tempRoot], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/pi-npm-cache' },
      });
      assert.equal(pack.status, 0, pack.stderr);
      const packEntries = parsePackEntries(pack.stdout);
      const packEntry = packEntries[0];
      if (packEntry === undefined) throw new Error('pack must return an entry');
      const tarballPath = join(tempRoot, packEntry.filename);
      const installRoot = join(tempRoot, 'install-root');
      await mkdir(installRoot, { recursive: true });
      const install = spawnSync(
        'npm',
        ['install', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', tarballPath],
        { cwd: installRoot, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/pi-npm-cache' } },
      );
      assert.equal(install.status, 0, install.stderr);

      const installedPackage = join(installRoot, 'node_modules', 'pi-autopilot');
      const installedBin = join(installedPackage, 'bin', 'autopilot-agent-run.mjs');
      const installedCoordinator = join(installedPackage, 'bin', 'autopilot-coordinator.mjs');
      const installedBinLink = join(installRoot, 'node_modules', '.bin', 'autopilot-agent-run');
      const installedCoordinatorLink = join(installRoot, 'node_modules', '.bin', 'autopilot-coordinator');
      for (const [command, path] of [['autopilot-agent-run', installedBinLink], ['autopilot-coordinator', installedCoordinatorLink]] as const) {
        assert.equal(existsSync(path), true, `${command} must be linked through the packed npm installation`);
        const help = spawnSync(path, ['--help'], { cwd: installRoot, encoding: 'utf8' });
        assert.equal(help.status, 0, `${command}: ${help.stderr}`);
        assert.match(help.stdout, new RegExp(command, 'u'));
      }
      const source = join(tempRoot, 'source');
      await initInstalledBinSource(source);
      const stateRoot = join(tempRoot, 'autopilot-state');
      coordinatorStateRoot = stateRoot;
      process.env[AUTOPILOT_STATE_ROOT_ENV] = stateRoot;
      const prepared = await prepareAutopilotWorkstream({ workstream: 'node-modules-smoke', sourceCwd: source });
      const attachment = await new DurableRunSupervisorClient(process.env).attach({ repo: prepared.repo, active: prepared.active, rawSessionId: 'packed-install-session' });
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;
      const worktree = prepared.mainWorktreePath;
      const unitWorktree = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'node-modules-smoke', attempt: 1 });
      const runtimeRoot = prepared.runtimeRoot;
      await mkdir(join(runtimeRoot, 'unit-specs'), { recursive: true });
      const specPath = join(runtimeRoot, 'unit-specs', 'node-modules-smoke.implement.attempt-1.json');
      await writeFile(
        specPath,
        `${JSON.stringify({
          schema_version: 'autopilot.unit_spec.v1',
          workstream: 'node-modules-smoke',
          unit_id: 'node-modules-smoke',
          role: 'implement',
          template: 'implement',
          attempt: 1,
          objective: 'Dry-run from an installed node_modules package.',
          cwd: unitWorktree.unitInfo.worktree_path,
          model: 'openai-codex/gpt-5.6-terra',
          thinking: 'high',
          owned_paths: ['src/smoke.ts'],
          read_only_paths: [],
          untouchable_paths: ['private/**'],
          context_refs: [
            { path: '.pi/autopilot/node-modules-smoke/mission.md', purpose: 'Durable mission truth' },
            { path: '.pi/autopilot/node-modules-smoke/master-plan.json', purpose: 'Durable master plan truth' },
          ],
          validation_commands: [],
          status_output: join(runtimeRoot, 'statuses', 'node-modules-smoke.implement.attempt-1.json'),
          receipt_output: join(runtimeRoot, 'receipts', 'node-modules-smoke.implement.attempt-1.receipt.json'),
          evidence_dir: join(runtimeRoot, 'evidence', 'node-modules-smoke'),
          stop_boundary: 'Dry-run only.',
          quality_profile: 'source-change',
          risk_level: 'medium',
          acceptance_criteria: ['installed package dry-run validates the spec'],
          verification_plan: {
            positive_witnesses: [
              {
                id: 'positive-installed-smoke',
                command: 'npm test',
                expected_signal: 'package smoke passes',
                required: true,
              },
            ],
            negative_witnesses: [],
            regression_witnesses: [],
            real_boundary_witnesses: [],
            blast_radius_checks: [],
            docs_schema_prompt_checks: [],
            dirty_tree_checks: [],
          },
          closure_criteria: ['installed package runner works'],
          upstream_refs: [],
          timeout_seconds: 60,
          render_prompt_snapshot: true,
        }, null, 2)}\n`,
        'utf8',
      );

      await stopExternalCoordinator(stateRoot);
      assert.equal(existsSync(coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }).lockPath), false, 'source coordinator must be stopped before the installed binary proves autostart');
      const runnerEnv = { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --disable-warning=ExperimentalWarning`.trim(), [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
      const packedMigration = spawnSync(process.execPath, [installedCoordinator, 'migrate', '--dry-run', '--state-root', join(tempRoot, 'migration-state'), '--repo-root', source], { cwd: source, encoding: 'utf8', env: runnerEnv });
      assert.equal(packedMigration.status, 0, packedMigration.stderr);
      assert.match(packedMigration.stdout, /autopilot\.coordination_migration_report\.v1/u);
      assert.match(packedMigration.stdout, /"dry_run": true/u);
      const coordinatorStatus = spawnSync(process.execPath, [installedCoordinator, 'status', '--state-root', stateRoot, '--repo-id', prepared.repo.repoKey, '--run', prepared.active.workstream_run], {
        cwd: source,
        encoding: 'utf8',
        env: runnerEnv,
      });
      assert.equal(coordinatorStatus.status, 0, coordinatorStatus.stderr);
      assert.match(coordinatorStatus.stdout, /autopilot\.coordinator_status\.v1/u);
      for (const [command, expected] of [
        [['recovery', 'list', '--state-root', stateRoot, '--repo-root', source], /autopilot\.migration_recovery_cli\.v1/u],
        [['recovery', 'doctor', '--state-root', stateRoot, '--repo-root', source], /"healthy": true/u],
      ] as const) {
        const recovery = spawnSync(installedCoordinatorLink, command, { cwd: source, encoding: 'utf8', env: runnerEnv });
        assert.equal(recovery.status, 0, recovery.stderr);
        assert.match(recovery.stdout, expected);
      }
      const dryRun = spawnSync(process.execPath, [installedBin, '--dry-run', '--json', specPath], {
        cwd: worktree,
        encoding: 'utf8',
        env: runnerEnv,
      });
      assert.equal(dryRun.status, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /"status":"dry-run"/u);
      assert.equal(dryRun.stderr, '');
      assert.ok(existsSync(join(installedPackage, 'dist', 'src', 'cli', 'autopilot-agent-run.js')));

      const fakePi = join(tempRoot, 'fake-pi.mjs');
      await writeFile(fakePi, INSTALLED_PACKAGE_FAKE_PI_SOURCE, 'utf8');
      if (platform() !== 'win32') await chmod(fakePi, 0o755);
      const liveRun = spawnSync(
        process.execPath,
        [installedBin, '--json', '--pi-executable', fakePi, specPath],
        { cwd: worktree, encoding: 'utf8', env: { ...runnerEnv, AUTOPILOT_FAKE_PI_SCENARIO: 'success' } },
      );
      assert.equal(liveRun.status, 0, liveRun.stderr);
      assert.match(liveRun.stdout, /"status":"success"/u);
      assert.equal(liveRun.stderr, '');
    } finally {
      delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
      if (coordinatorStateRoot !== null) await stopExternalCoordinator(coordinatorStateRoot);
      if (previousStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
      else process.env[AUTOPILOT_STATE_ROOT_ENV] = previousStateRoot;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function stopExternalCoordinator(stateRoot: string): Promise<void> {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  if (!existsSync(paths.lockPath)) return;
  const parsed: unknown = JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('coordinator lock is malformed');
  const pid = (parsed as Readonly<Record<string, unknown>>)['pid'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('coordinator lock pid is malformed');
  if (isProcessAlive(pid)) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (isProcessAlive(pid) && Date.now() < deadline) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  if (isProcessAlive(pid)) throw new Error('coordinator did not stop before cleanup');
  if (existsSync(paths.lockPath)) {
    const stale: unknown = JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown;
    if (typeof stale !== 'object' || stale === null || Array.isArray(stale) || (stale as Readonly<Record<string, unknown>>)['pid'] !== pid) throw new Error('coordinator lock identity changed during cleanup');
  }
}

async function initInstalledBinSource(source: string): Promise<void> {
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
  await writeFile(join(source, 'src', 'smoke.ts'), 'export const smoke = "baseline";\n', 'utf8');
  git(source, ['init']);
  git(source, ['config', 'user.email', 'autopilot@example.invalid']);
  git(source, ['config', 'user.name', 'Autopilot Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'baseline']);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

const INSTALLED_PACKAGE_FAKE_PI_SOURCE = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { createInterface } from 'node:readline';

const contextPath = process.env.AUTOPILOT_AGENT_STATUS_CONTEXT;
const extensionIndex = process.argv.indexOf('--extension');
const extensionPath = extensionIndex < 0 ? undefined : process.argv[extensionIndex + 1];
const expectedExtensionSuffix = ['dist', 'src', 'internal', 'status-extension.js'].join(sep);
const extensionPathOk =
  typeof extensionPath === 'string' && extensionPath.endsWith(expectedExtensionSuffix) && existsSync(extensionPath);

function write(record) { process.stdout.write(JSON.stringify(record) + '\\n'); }
function response(command, success = true, extra = {}) {
  write({ id: command.id, type: 'response', command: command.type, success, ...extra });
}
function loadContext() {
  if (!contextPath) throw new Error('missing AUTOPILOT_AGENT_STATUS_CONTEXT');
  return JSON.parse(readFileSync(contextPath, 'utf8'));
}
function emitStatus() {
  const context = loadContext();
  const unit = context.unit_spec;
  const changedPath = join(unit.cwd, ...String(unit.owned_paths[0]).split('/'));
  mkdirSync(dirname(changedPath), { recursive: true });
  writeFileSync(changedPath, 'export const smoke = "installed fake";\\n', 'utf8');
  const status = {
    schema_version: 'autopilot.status.v1',
    workstream: unit.workstream,
    unit_id: unit.unit_id,
    role: unit.role,
    attempt: unit.attempt,
    verdict: 'DONE',
    severity: 'clean',
    summary: 'Installed package fake Pi completed.',
    changed_paths: [unit.owned_paths[0]],
    findings: [],
    commands: [],
    evidence_refs: [],
    report_ref: null,
    next_action: 'installed package smoke complete'
  };
  mkdirSync(dirname(context.status_output), { recursive: true });
  mkdirSync(dirname(context.receipt_output), { recursive: true });
  const statusBytes = JSON.stringify(status, null, 2) + '\\n';
  writeFileSync(context.status_output, statusBytes, 'utf8');
  const statusSha256 = 'sha256:' + createHash('sha256').update(statusBytes, 'utf8').digest('hex');
  const toolCallId = 'installed-package-call-1';
  const receipt = {
    schema_version: 'autopilot.receipt.v1',
    tool_name: 'autopilot_emit_status',
    workstream: unit.workstream,
    unit_id: unit.unit_id,
    role: unit.role,
    attempt: unit.attempt,
    emitted_at: '2026-06-30T00:00:00.000Z',
    status_output: context.status_output,
    status_sha256: statusSha256,
    schema_sha256: context.schema_sha256,
    tool_call_id: toolCallId,
    provider_identity: context.provider_identity,
    expected_identity_hash: context.expected_identity_hash
  };
  writeFileSync(context.receipt_output, JSON.stringify(receipt, null, 2) + '\\n', 'utf8');
  write({
    type: 'tool_execution_end',
    toolName: 'autopilot_emit_status',
    toolCallId,
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Autopilot status emitted' }],
      details: {
        tool_name: 'autopilot_emit_status',
        tool_call_id: toolCallId,
        terminating: true,
        status_sha256: statusSha256
      }
    }
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    response(command, true, { data: { model: { id: 'gpt-5.6-terra', provider: 'openai-codex', api: 'openai-codex-responses' }, thinkingLevel: 'high' } });
    return;
  }
  if (command.type === 'get_session_stats') {
    response(command, true, { data: { sessionId: 'installed-package-smoke' } });
    return;
  }
  if (command.type === 'prompt') {
    if (!extensionPathOk) {
      response(command, false, { error: 'expected compiled status extension path, got ' + String(extensionPath) });
      return;
    }
    response(command);
    write({ type: 'agent_start' });
    write({ type: 'turn_start' });
    emitStatus();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-5.6-terra', stopReason: 'stop' };
    write({ type: 'message_end', message });
    write({ type: 'turn_end', message, toolResults: [] });
    write({ type: 'agent_end', messages: [message] });
    return;
  }
  response(command, false, { error: 'unsupported command' });
});
`;
