import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { invokePackedManifestAutopilot } from '../helpers/packed-manifest-route.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const predecessors = [
  { label: 'cf45', commit: 'a0d8a732decdb5f7061b01a8c5ead6120cba081f', version: '1.1.3', build: '1.1.3-cf45' },
  { label: 'cf46', commit: '79fa09508def3277b9e6fb3461f7b3d753d43993', version: '1.1.4', build: '1.1.4-cf46' },
  { label: 'cf47', commit: '210d695393232c19652b664a60b9ecfc6fe0e713', version: '1.1.5', build: '1.1.5-cf47' },
  { label: 'cf48', commit: 'a8a6078dfe1e49c2c9e61abcae10741fce20b745', version: '1.1.6', build: '1.1.6-cf48' },
  { label: 'cf49', commit: '2f708ab11f261c171629e89b25c8b0ba988e9d12', version: '1.1.7', build: '1.1.7-cf49' },
] as const;

function run(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>): ReturnType<typeof spawnSync> {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)}): ${String(result.stderr)}`);
  return result;
}

function gitText(args: readonly string[]): string {
  return String(run('git', args, packageRoot, process.env).stdout);
}

async function materializeCommit(commit: string, destination: string): Promise<void> {
  assert.equal(gitText(['rev-parse', `${commit}^{commit}`]).trim(), commit);
  const names = gitText(['ls-tree', '-r', '--name-only', commit]).trim().split('\n').filter((name) => name.length > 0);
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe archived package path ${name}`);
    const output = String(run('git', ['show', `${commit}:${name}`], packageRoot, process.env).stdout);
    const target = join(destination, ...name.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output, 'utf8');
  }
}

function packedFilename(stdout: string): string {
  const value: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'object' || value[0] === null) throw new Error('npm pack output is malformed');
  const filename = (value[0] as Readonly<Record<string, unknown>>)['filename'];
  if (typeof filename !== 'string') throw new Error('npm pack filename is missing');
  return filename;
}

async function packCommit(input: typeof predecessors[number], root: string, env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const source = join(root, `${input.label}-source`);
  const packs = join(root, 'packs');
  await mkdir(packs, { recursive: true });
  await materializeCommit(input.commit, source);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as Readonly<Record<string, unknown>>;
  assert.equal(manifest['version'], input.version, `${input.label} package version must match the intended fixture`);
  const constants = await readFile(join(source, 'src/core/coordination/runtime-constants.ts'), 'utf8');
  assert.match(constants, new RegExp(`COORDINATOR_PACKAGE_BUILD = '${input.build.replaceAll('.', '\\.')}'`, 'u'));
  const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packs], source, env);
  return join(packs, packedFilename(String(packed.stdout)));
}

async function packCandidate(root: string, env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const packs = join(root, 'packs');
  await mkdir(packs, { recursive: true });
  const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packs], packageRoot, env);
  return join(packs, packedFilename(String(packed.stdout)));
}

function install(tarball: string, consumer: string, env: Readonly<Record<string, string | undefined>>): void {
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', tarball], consumer, env);
}

function coordinatorBin(consumer: string): string {
  return join(consumer, 'node_modules', '.bin', platform() === 'win32' ? 'autopilot-coordinator.cmd' : 'autopilot-coordinator');
}

async function lock(consumerEnv: Readonly<Record<string, string | undefined>>): Promise<Readonly<Record<string, unknown>>> {
  return JSON.parse(await readFile(coordinatorRuntimePaths(consumerEnv).lockPath, 'utf8')) as Readonly<Record<string, unknown>>;
}

async function stopCoordinator(env: Readonly<Record<string, string | undefined>>): Promise<void> {
  let value: Readonly<Record<string, unknown>>;
  try { value = await lock(env); } catch { return; }
  const pid = value['pid'];
  if (typeof pid !== 'number' || !isProcessAlive(pid)) return;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isProcessAlive(pid)) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  assert.equal(isProcessAlive(pid), false);
}

async function invokePackedAutopilot(consumer: string, project: string, stateRoot: string, homeRoot: string, workstream: string, env: Readonly<Record<string, string | undefined>>): Promise<void> {
  const invocation = await invokePackedManifestAutopilot({ consumerRoot: consumer, projectRoot: project, stateRoot, homeRoot, workstream, env });
  assert.equal(invocation.status, 0, `${invocation.stderr}\n${invocation.stdout}`);
  assert.equal(invocation.result?.['manifestEntry'], './extensions/autopilot.ts');
  assert.equal(invocation.result?.['messages'], 1, JSON.stringify(invocation.result?.['notifications']));
}

void it('packs exact cf45/cf46/cf47/cf48/cf49 binaries and completes the manifest-route cf49-to-cf50 reload journey', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-packed-startup-reload-'));
  const cache = join(root, 'npm-cache');
  const npmEnv = { ...process.env, NPM_CONFIG_CACHE: cache, NPM_CONFIG_OFFLINE: 'true', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  try {
    const candidate = await packCandidate(root, npmEnv);
    assert.equal(existsSync(candidate), true);
    for (const predecessor of predecessors) {
      const tarball = await packCommit(predecessor, root, npmEnv);
      const consumer = join(root, `consumer-${predecessor.label}`);
      const stateRoot = join(root, `state-${predecessor.label}`);
      const env = { ...npmEnv, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
      await mkdir(consumer, { recursive: true });
      install(tarball, consumer, env);
      run(coordinatorBin(consumer), ['status', '--state-root', stateRoot], consumer, env);
      const predecessorLock = await lock(env);
      assert.equal(predecessorLock['package_build'], predecessor.build);
      const project = predecessor.label === 'cf49' ? join(root, 'packed-project') : null;
      if (project !== null) {
        await mkdir(project, { recursive: true });
        await writeFile(join(project, 'README.md'), '# packed reload\n', 'utf8');
        run('git', ['init'], project, env);
        run('git', ['config', 'user.email', 'packed@example.invalid'], project, env);
        run('git', ['config', 'user.name', 'Packed Test'], project, env);
        run('git', ['add', '.'], project, env);
        run('git', ['commit', '-m', 'baseline'], project, env);
        await invokePackedAutopilot(consumer, project, stateRoot, join(root, 'packed-home-predecessor'), 'packed-reload-unit', env);
      }
      install(candidate, consumer, env);
      const healthy = JSON.parse(String(run(coordinatorBin(consumer), ['status', '--state-root', stateRoot], consumer, env).stdout)) as Readonly<Record<string, unknown>>;
      assert.equal((await lock(env))['package_build'], predecessor.build, 'a healthy certified predecessor remains authoritative and usable');

      if (predecessor.label === 'cf49' && project !== null) {
        const predecessorRuns = healthy['runs'];
        assert.equal(Array.isArray(predecessorRuns) && predecessorRuns.length, 1);
        const originalRun = Array.isArray(predecessorRuns) ? predecessorRuns[0] : null;
        await unlink(coordinatorRuntimePaths(env).socketPath);
        await invokePackedAutopilot(consumer, project, stateRoot, join(root, 'packed-home-candidate'), 'packed-reload-unit', env);
        const current = await lock(env);
        assert.equal(current['package_build'], '1.1.8-cf50');
        assert.notEqual(current['pid'], predecessorLock['pid']);
        await invokePackedAutopilot(consumer, project, stateRoot, join(root, 'packed-home-next'), 'packed-next-item', env);
        const status = JSON.parse(String(run(coordinatorBin(consumer), ['status', '--state-root', stateRoot], consumer, env).stdout)) as Readonly<Record<string, unknown>>;
        const runs = status['runs'];
        assert.equal(Array.isArray(runs) && runs.length, 2, 'reload must preserve one original run and prepare one exact next item');
        const runIds = Array.isArray(runs) ? runs.map((runEntry) => typeof runEntry === 'object' && runEntry !== null && !Array.isArray(runEntry) ? (runEntry as Readonly<Record<string, unknown>>)['workstream_run'] : null) : [];
        assert.equal(new Set(runIds).size, 2, 'reload must not duplicate a durable run operation');
        assert.equal(Array.isArray(runs) && runs.some((runEntry) => typeof runEntry === 'object' && runEntry !== null && !Array.isArray(runEntry) && typeof originalRun === 'object' && originalRun !== null && !Array.isArray(originalRun) && (runEntry as Readonly<Record<string, unknown>>)['workstream_run'] === (originalRun as Readonly<Record<string, unknown>>)['workstream_run']), true, 'the durable predecessor run identity must survive replacement');
      }
      await stopCoordinator(env);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
