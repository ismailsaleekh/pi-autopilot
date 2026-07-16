import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { invokePackedManifestAutopilot, type PackedManifestInvocation } from '../helpers/packed-manifest-route.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CF48_COMMIT = 'a8a6078dfe1e49c2c9e61abcae10741fce20b745';

function run(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function runChecked(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>): ReturnType<typeof spawnSync> {
  const result = run(command, args, cwd, env);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)}): ${String(result.stderr)}`);
  return result;
}

async function materializeCommit(commit: string, destination: string, env: Readonly<Record<string, string | undefined>>): Promise<void> {
  assert.equal(String(runChecked('git', ['rev-parse', `${commit}^{commit}`], packageRoot, env).stdout).trim(), commit);
  const names = String(runChecked('git', ['ls-tree', '-r', '--name-only', commit], packageRoot, env).stdout).trim().split('\n').filter((name) => name.length > 0);
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe package fixture path ${name}`);
    const bytes = runChecked('git', ['show', `${commit}:${name}`], packageRoot, env).stdout;
    const target = join(destination, ...name.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

function packedFilename(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) throw new Error('npm pack output is malformed');
  const filename = (parsed[0] as Readonly<Record<string, unknown>>)['filename'];
  if (typeof filename !== 'string') throw new Error('npm pack filename is absent');
  return filename;
}

async function packSource(source: string, packs: string, env: Readonly<Record<string, string | undefined>>): Promise<string> {
  await mkdir(packs, { recursive: true });
  const result = runChecked('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packs], source, env);
  return join(packs, packedFilename(String(result.stdout)));
}

function install(tarball: string, consumer: string, env: Readonly<Record<string, string | undefined>>): void {
  runChecked('npm', ['install', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', tarball], consumer, env);
}

async function initProject(project: string, env: Readonly<Record<string, string | undefined>>): Promise<void> {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# synthetic package boundary\n', 'utf8');
  runChecked('git', ['init'], project, env);
  runChecked('git', ['config', 'user.email', 'package-boundary@example.invalid'], project, env);
  runChecked('git', ['config', 'user.name', 'Package Boundary'], project, env);
  runChecked('git', ['add', '.'], project, env);
  runChecked('git', ['commit', '-m', 'baseline'], project, env);
}

function notificationText(invocation: PackedManifestInvocation): string {
  const notifications = invocation.result?.['notifications'];
  if (!Array.isArray(notifications)) return '';
  return notifications.map((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && typeof (entry as Readonly<Record<string, unknown>>)['message'] === 'string' ? (entry as Readonly<Record<string, unknown>>)['message'] as string : '').join('\n');
}

async function stopCoordinator(stateRoot: string): Promise<void> {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  if (!existsSync(paths.lockPath)) return;
  const parsed: unknown = JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('isolated coordinator lock is malformed');
  const pid = (parsed as Readonly<Record<string, unknown>>)['pid'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('isolated coordinator pid is malformed');
  if (isProcessAlive(pid)) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (isProcessAlive(pid) && Date.now() < deadline) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  assert.equal(isProcessAlive(pid), false, 'isolated coordinator must stop before fixture cleanup');
}

void it('reproduces cf48 through the declared installed manifest route and starts cf50 through that same Pi SDK route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-installed-manifest-'));
  const env = { ...process.env, NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_OFFLINE: 'true', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  try {
    const cf48Source = join(root, 'cf48-source');
    await materializeCommit(CF48_COMMIT, cf48Source, env);
    const cf48Tarball = await packSource(cf48Source, join(root, 'packs-cf48'), env);
    const cf48Consumer = join(root, 'consumer-cf48');
    const cf48Project = join(root, 'project-cf48');
    await mkdir(cf48Consumer, { recursive: true });
    await initProject(cf48Project, env);
    install(cf48Tarball, cf48Consumer, env);
    const baseline = await invokePackedManifestAutopilot({ consumerRoot: cf48Consumer, projectRoot: cf48Project, stateRoot: join(root, 'state-cf48'), homeRoot: join(root, 'home-cf48'), workstream: 'manifest-baseline', env });
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(baseline.result?.['manifestEntry'], './extensions/autopilot.ts');
    assert.equal(baseline.result?.['messages'], 0);
    assert.match(notificationText(baseline), /spawned coordinator failed with exit code 1 before readiness/u);
    const fallback = join(cf48Consumer, 'node_modules', 'pi-autopilot', 'src', 'cli', 'autopilot-coordinator.ts');
    const directBoundary = run(process.execPath, ['--experimental-strip-types', fallback, '--help'], cf48Project, env);
    assert.equal(directBoundary.status, 1);
    assert.match(String(directBoundary.stderr), /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/u);

    const candidateTarball = await packSource(packageRoot, join(root, 'packs-candidate'), env);
    const candidateConsumer = join(root, 'consumer-candidate');
    const candidateProject = join(root, 'project-candidate');
    const candidateState = join(root, 'state-candidate');
    await mkdir(candidateConsumer, { recursive: true });
    await initProject(candidateProject, env);
    install(candidateTarball, candidateConsumer, env);
    const candidate = await invokePackedManifestAutopilot({ consumerRoot: candidateConsumer, projectRoot: candidateProject, stateRoot: candidateState, homeRoot: join(root, 'home-candidate'), workstream: 'manifest-candidate', env });
    assert.equal(candidate.status, 0, `${candidate.stderr}\n${candidate.stdout}`);
    assert.equal(candidate.result?.['manifestEntry'], './extensions/autopilot.ts');
    assert.equal(candidate.result?.['messages'], 1, notificationText(candidate));
    assert.equal(notificationText(candidate).includes('error'), false, notificationText(candidate));
    const lock = JSON.parse(await readFile(coordinatorRuntimePaths({ ...env, [AUTOPILOT_STATE_ROOT_ENV]: candidateState }).lockPath, 'utf8')) as Readonly<Record<string, unknown>>;
    assert.equal(lock['package_build'], '1.1.8-cf50');
    await stopCoordinator(candidateState);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it('fails before spawn with explicit packaging evidence when the installed compiled coordinator is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-missing-compiled-'));
  const env = { ...process.env, NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_OFFLINE: 'true', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  try {
    const tarball = await packSource(packageRoot, join(root, 'packs'), env);
    const consumer = join(root, 'consumer');
    const project = join(root, 'project');
    const stateRoot = join(root, 'state');
    await mkdir(consumer, { recursive: true });
    await initProject(project, env);
    install(tarball, consumer, env);
    const installedRoot = join(consumer, 'node_modules', 'pi-autopilot');
    await rm(join(installedRoot, 'dist', 'src', 'cli', 'autopilot-coordinator.js'));
    const marker = join(root, 'source-runtime-marker');
    await writeFile(join(installedRoot, 'src', 'cli', 'autopilot-coordinator.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'forbidden');\n`, 'utf8');
    const invocation = await invokePackedManifestAutopilot({ consumerRoot: consumer, projectRoot: project, stateRoot, homeRoot: join(root, 'home'), workstream: 'missing-compiled', env });
    assert.equal(invocation.status, 0, `${invocation.stderr}\n${invocation.stdout}`);
    const diagnostic = notificationText(invocation);
    assert.match(diagnostic, /startup_phase=spawn-resolution/u);
    assert.match(diagnostic, /selected_compiled_entrypoint=.*dist.*autopilot-coordinator\.js/u);
    assert.match(diagnostic, /compiled coordinator artifact is missing/u);
    assert.equal(existsSync(marker), false, 'production startup must never invoke source TypeScript');
    for (const forbidden of ['--experimental-strip-types', 'tsx', 'ts-node', '.ts;']) assert.equal(diagnostic.includes(forbidden), false, diagnostic);
    assert.equal(existsSync(coordinatorRuntimePaths({ ...env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }).lockPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it('reports packed bootstrap import failure with bounded sanitized pre-CLI evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-bootstrap-import-'));
  const env = { ...process.env, NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_OFFLINE: 'true', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  try {
    const tarball = await packSource(packageRoot, join(root, 'packs'), env);
    const consumer = join(root, 'consumer');
    const project = join(root, 'project');
    const stateRoot = join(root, 'state');
    await mkdir(consumer, { recursive: true });
    await initProject(project, env);
    install(tarball, consumer, env);
    const corrupt = join(consumer, 'node_modules', 'pi-autopilot', 'dist', 'src', 'core', 'coordination', 'server.js');
    const original = await readFile(corrupt, 'utf8');
    await writeFile(corrupt, `throw new Error('synthetic import failure capability=do-not-expose ${'x'.repeat(8_000)}');\n${original}`, 'utf8');
    const invocation = await invokePackedManifestAutopilot({ consumerRoot: consumer, projectRoot: project, stateRoot, homeRoot: join(root, 'home'), workstream: 'bootstrap-import', env });
    assert.equal(invocation.status, 0, `${invocation.stderr}\n${invocation.stdout}`);
    const diagnostic = notificationText(invocation);
    assert.match(diagnostic, /spawned_pid=\d+/u);
    assert.match(diagnostic, /spawned_exit_code=1/u);
    assert.match(diagnostic, /startup_phase=bootstrap\/import/u);
    assert.match(diagnostic, /selected_compiled_entrypoint=.*dist.*autopilot-coordinator\.js/u);
    assert.match(diagnostic, /synthetic import failure/u);
    assert.match(diagnostic, /capability=<redacted>/u);
    assert.match(diagnostic, /startup_report_truncated=true/u);
    assert.match(diagnostic, /startup_report_omitted_code_points=[1-9]\d*/u);
    assert.ok([...diagnostic].length <= 4_096);
    for (const secretLabel of ['session_token=', 'child_token=', 'handoff_token=', 'fence_token=']) assert.equal(diagnostic.includes(secretLabel), false, diagnostic);
    const reportsRoot = coordinatorRuntimePaths({ ...env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }).startupReportsRoot;
    const reports = (await readdir(reportsRoot)).filter((name) => name.endsWith('.json'));
    assert.equal(reports.length, 1);
    const reportPath = join(reportsRoot, reports[0] ?? 'missing');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Readonly<Record<string, unknown>>;
    assert.equal(report['phase'], 'bootstrap/import');
    assert.equal(report['diagnostics_truncated'], true);
    assert.equal(typeof report['selected_compiled_entrypoint'], 'string');
    const reportInfo = await lstat(reportPath);
    assert.equal(reportInfo.isFile(), true);
    assert.equal(reportInfo.isSymbolicLink(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
