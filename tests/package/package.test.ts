import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotUnitWorktree, prepareAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';

interface PackageScripts {
  readonly [key: string]: string | undefined;
}

interface PackageBin {
  readonly 'autopilot-agent-run'?: string;
  readonly 'autopilot-coordinator'?: string;
}

interface PackageJson {
  readonly name: string;
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
    type: requireString(field(value, 'type'), 'type'),
    author: requireString(field(value, 'author'), 'author'),
    keywords: requireStringArray(field(value, 'keywords'), 'keywords'),
    files: requireStringArray(field(value, 'files'), 'files'),
    bin: {
      'autopilot-agent-run': requireString(field(bin, 'autopilot-agent-run'), 'bin.autopilot-agent-run'),
      'autopilot-coordinator': requireString(field(bin, 'autopilot-coordinator'), 'bin.autopilot-coordinator'),
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
    assert.ok(pkg.files.includes('dist/'));
    assert.ok(pkg.peerDependencies['@earendil-works/pi-coding-agent']);
    for (const script of ['build', 'typecheck', 'test:type-safety', 'test:unit', 'test:model', 'test:sdk', 'test:rpc', 'test:package']) {
      assert.equal(typeof pkg.scripts[script], 'string', script);
    }
    for (const dir of ['bin/', 'dist/', 'extensions/', 'src/', 'templates/']) assert.ok(pkg.files.includes(dir), dir);
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
      'dist/src/cli/autopilot-agent-run.js',
      'dist/src/cli/autopilot-coordinator.js',
      'dist/src/core/agent-runner.js',
      'dist/src/core/close-runtime.js',
      'dist/src/core/coordination/client.js',
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
      'src/core/coordination/client.ts',
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

  void it('documents current Autopilot surfaces across package docs', async () => {
    for (const file of DOC_FILES) {
      const text = await docText(file);
      for (const surface of ['autopilot-agent-run', 'autopilot-coordinator', 'autopilot-coordination', 'context_budget', 'autopilot-inject', 'autopilot-onboard', 'autopilot-handoff', 'autopilot-config', 'autopilot-claim-gc', 'autopilot-close', 'autopilot-abort']) {
        assert.match(text, literalPattern(surface), `${file} missing ${surface}`);
      }
    }

    const readme = await docText('README.md');
    const plan = await docText('TEST_PLAN.md');
    for (const surface of [
      '/autopilot',
      '/autopilot-inject',
      '/autopilot-onboard',
      '/autopilot-handoff',
      '/autopilot-config',
      '/autopilot-claim-gc',
      '/autopilot-coordination',
      '/autopilot-close',
      '/autopilot-abort',
      'context_budget',
      'autopilot-agent-run',
      '.pi/autopilot/<workstream>/',
      'autopilot_emit_status',
      'forced-output/status',
      'state-store',
      'autopilot.master_plan.v1',
      'autopilot.decision.v1',
      'autopilot.execution_audit.v1',
      'perfect-quality',
      'scope/protected-path adjudication',
      'work-item lifecycle',
      'terminal closure',
      'runtime close/merge/abort',
      'per-unit worktrees',
      'autopilot.unit_merge.v1',
      'validation staleness',
      'fake-Pi',
      'offline SDK/RPC/package gates',
      'sparse by default',
      '.autopilot/checkout-profile.json',
      'autopilot_materialize_context',
      'openai-codex/gpt-5.6-sol',
      'openai-codex/gpt-5.6-terra',
      'openai-codex/gpt-5.6-luna',
      'Coordination Fabric Phases 27–32',
      'end-to-end peer claim negotiation',
      'automatic terminal-evidence reconciliation',
      'read-only canonical preflight',
      'standalone production surfaces',
      'transactional coordinator',
      'durable run supervisor',
      'session fencing',
    ]) {
      assert.match(readme, literalPattern(surface), `README missing ${surface}`);
      assert.match(plan, literalPattern(surface), `TEST_PLAN missing ${surface}`);
    }
  });

  void it('maps README promises to TEST_PLAN rows', async () => {
    const readme = await docText('README.md');
    const plan = await docText('TEST_PLAN.md');
    const mappings = [
      { claim: 'Commands', row: 'Public commands are `/autopilot`, `/autopilot-inject`, `/autopilot-onboard`, `/autopilot-handoff`, `/autopilot-config`, `/autopilot-claim-gc`, `/autopilot-coordination`, `/autopilot-close`, and `/autopilot-abort`' },
      { claim: 'Coordination Fabric Phases 27–32', row: 'Coordination Fabric contracts and protocol lock' },
      { claim: 'end-to-end peer claim negotiation', row: 'End-to-end peer claim negotiation' },
      { claim: 'automatic terminal-evidence reconciliation', row: 'Offline mailbox replay and automatic reconciliation' },
      { claim: 'read-only canonical preflight', row: 'Legacy coordination preflight has real consumers' },
      { claim: 'standalone production surfaces', row: 'Standalone package boundary' },
      { claim: 'context_budget', row: '`context_budget` parent gate' },
      { claim: 'Fixed model roster', row: 'Fixed parent and child model roster' },
      { claim: 'Contracts, templates, and state-store', row: 'Contracts/templates are schema-backed and package-owned' },
      { claim: 'perfect-quality', row: 'Perfect-quality doctrine is package-owned' },
      { claim: 'scope/protected-path adjudication', row: 'Scope/protected-path adjudication blocks silent closure' },
      { claim: 'work-item lifecycle', row: 'Work-item lifecycle separates transport success from closure' },
      { claim: 'closure gates', row: 'Terminal closure gate rejects unresolved semantic risk' },
      { claim: 'runtime close/merge/abort', row: 'Runtime close/merge/abort is deterministic and local-only' },
      { claim: 'per-unit worktrees', row: 'Phase 2 per-unit worktrees isolate source-changing units' },
      { claim: 'sparse by default', row: 'Sparse-by-default worktrees and checkout profiles' },
      { claim: 'autopilot_materialize_context', row: 'Sparse materialization tool is child-only' },
      { claim: 'forced-output/status', row: 'Forced-output/status tool is child-only' },
      { claim: 'state-store', row: 'State store' },
      { claim: 'autopilot-agent-run', row: '`autopilot-agent-run` bin is shipped' },
      { claim: 'fake-Pi', row: 'Runner accepts valid fake child' },
      { claim: 'parent prompt', row: 'Parent prompt requires `context_budget`' },
      { claim: 'onboard prompt', row: 'Onboard prompt is read-only' },
      { claim: 'handoff prompt', row: 'Handoff prompt uses the active workstream' },
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
      const command = `npm run ${script}`;
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
      'dist/src/cli/autopilot-coordinator.js',
      'dist/src/core/agent-runner.js',
      'dist/src/core/close-runtime.js',
      'dist/src/core/coordination/client.js',
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
      'src/core/coordination/client.ts',
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
      'bin/autopilot-agent-run.mjs',
      'bin/autopilot-coordinator.mjs',
      'templates/README.md',
    ]) {
      assert.ok(files.includes(file), file);
    }
    assert.equal(files.some((file) => file.startsWith('tests/')), false);
    assert.equal(files.some((file) => file.includes('node_modules')), false);
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
    assert.equal(wrapper.includes('--experimental-strip-types'), false);
    assert.match(wrapper, /'dist', 'src', 'cli', 'autopilot-coordinator\.js'/u);
    const result = spawnSync(process.execPath, ['bin/autopilot-coordinator.mjs', '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /autopilot-coordinator status/u);
  });

  void it('runs the packed bins from node_modules without TypeScript stripping', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-autopilot-installed-bin-'));
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
      const source = join(tempRoot, 'source');
      await initInstalledBinSource(source);
      const previousStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
      const stateRoot = join(tempRoot, 'autopilot-state');
      coordinatorStateRoot = stateRoot;
      process.env[AUTOPILOT_STATE_ROOT_ENV] = stateRoot;
      const prepared = await prepareAutopilotWorkstream({ workstream: 'node-modules-smoke', sourceCwd: source });
      const attachment = await new DurableRunSupervisorClient(process.env).attach({ repo: prepared.repo, active: prepared.active, rawSessionId: 'packed-install-session' });
      if (previousStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
      else process.env[AUTOPILOT_STATE_ROOT_ENV] = previousStateRoot;
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

      const runnerEnv = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
      const coordinatorStatus = spawnSync(process.execPath, [installedCoordinator, 'status', '--state-root', stateRoot, '--repo-id', prepared.repo.repoKey, '--run', prepared.active.workstream_run], {
        cwd: source,
        encoding: 'utf8',
        env: runnerEnv,
      });
      assert.equal(coordinatorStatus.status, 0, coordinatorStatus.stderr);
      assert.match(coordinatorStatus.stdout, /autopilot\.coordinator_status\.v1/u);
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
      const chmod = spawnSync('chmod', ['755', fakePi], { encoding: 'utf8' });
      assert.equal(chmod.status, 0, chmod.stderr);
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
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (existsSync(paths.lockPath) && Date.now() < deadline) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  if (existsSync(paths.lockPath)) throw new Error('coordinator did not stop before cleanup');
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
