import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ExtensionPackageExecutableResolution {
  readonly packageRoot: string;
  readonly launchSignerPath: string;
  readonly agentRunnerPath: string;
}

interface ExecutableResolverModule {
  resolveExtensionPackageExecutables(moduleUrl: string): ExtensionPackageExecutableResolution;
}

interface ExtensionModule {
  defaultLaunchSignerResolver(manifest: unknown, env: Readonly<Record<string, string | undefined>>): unknown;
}

interface PathsModule {
  runnerInvocationFromModuleUrl(moduleUrl: string): string;
}

function resolverModule(value: unknown): ExecutableResolverModule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('package executable resolver module is malformed');
  const resolver = (value as Readonly<Record<string, unknown>>)['resolveExtensionPackageExecutables'];
  if (typeof resolver !== 'function') throw new TypeError('extension package executable resolver export is missing');
  return value as ExecutableResolverModule;
}

async function copyFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
}

function extensionModule(value: unknown): ExtensionModule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('extension module is malformed');
  const resolver = (value as Readonly<Record<string, unknown>>)['defaultLaunchSignerResolver'];
  if (typeof resolver !== 'function') throw new TypeError('default launch signer resolver export is missing');
  return value as ExtensionModule;
}

function pathsModule(value: unknown): PathsModule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('paths module is malformed');
  const resolver = (value as Readonly<Record<string, unknown>>)['runnerInvocationFromModuleUrl'];
  if (typeof resolver !== 'function') throw new TypeError('runner invocation resolver export is missing');
  return value as PathsModule;
}

void it('BUG-179 resolves source-loaded and dist-loaded extensions to one physical package launch signer', async () => {
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const loaded: unknown = await import('../../src/core/coordination/executable-resolution.ts');
  const resolver = resolverModule(loaded);
  const source = resolver.resolveExtensionPackageExecutables(pathToFileURL(join(packageRoot, 'src', 'extension.ts')).href);
  const dist = resolver.resolveExtensionPackageExecutables(pathToFileURL(join(packageRoot, 'dist', 'src', 'extension.js')).href);
  assert.deepEqual(source, dist);
  assert.deepEqual(source, {
    packageRoot,
    launchSignerPath: join(packageRoot, 'bin', 'autopilot-launch-signer.mjs'),
    agentRunnerPath: join(packageRoot, 'bin', 'autopilot-agent-run.mjs'),
  });
});

void it('BUG-179 routes source-loaded and dist-loaded child launches through the same physical package runner', async () => {
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const sourcePaths: unknown = await import('../../src/core/paths.ts');
  const distPaths: unknown = await import(pathToFileURL(join(packageRoot, 'dist', 'src', 'core', 'paths.js')).href);
  const sourceExtensionUrl = pathToFileURL(join(packageRoot, 'src', 'extension.ts')).href;
  const distExtensionUrl = pathToFileURL(join(packageRoot, 'dist', 'src', 'extension.js')).href;
  const expected = join(packageRoot, 'bin', 'autopilot-agent-run.mjs');
  assert.equal(pathsModule(sourcePaths).runnerInvocationFromModuleUrl(sourceExtensionUrl), expected);
  assert.equal(pathsModule(distPaths).runnerInvocationFromModuleUrl(distExtensionUrl), expected);
});

void it('BUG-179 default signer resolution succeeds from both the source package entry and compiled extension module', async () => {
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-default-signer-'));
  try {
    const evidenceRoot = join(root, 'program-evidence');
    const configPath = join(root, 'operator-key', 'signer-config.json');
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(evidenceRoot, 'signer-invocation.json'), `${JSON.stringify({
      schema_version: 'autopilot.launch_signer_invocation.v1',
      node: process.execPath,
      signer_bin: join(packageRoot, 'bin', 'autopilot-launch-signer.mjs'),
      config_path: configPath,
    })}\n`, { mode: 0o600 });
    const manifest = { program_evidence_root: evidenceRoot };
    const sourceLoaded: unknown = await import('../../src/extension.ts');
    const distLoaded: unknown = await import(pathToFileURL(join(packageRoot, 'dist', 'src', 'extension.js')).href);
    const sourceSigner = extensionModule(sourceLoaded).defaultLaunchSignerResolver(manifest, {});
    const distSigner = extensionModule(distLoaded).defaultLaunchSignerResolver(manifest, {});
    for (const signer of [sourceSigner, distSigner]) {
      assert.equal(typeof (signer as Readonly<Record<string, unknown>>)['signLaunchPolicy'], 'function');
      assert.equal(typeof (signer as Readonly<Record<string, unknown>>)['signProgramHeartbeat'], 'function');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it('BUG-179 keeps the prepack launch-entrypoint gate silent unless JSON output is explicitly requested', () => {
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const script = join(packageRoot, 'scripts', 'check-launch-entrypoint.mjs');
  const quiet = spawnSync(process.execPath, [script], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '', 'prepack success must not contaminate npm pack --json stdout');
  const verbose = spawnSync(process.execPath, [script, '--json'], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(verbose.status, 0, verbose.stderr);
  const report = JSON.parse(verbose.stdout) as Record<string, unknown>;
  assert.equal(report['schema_version'], 'autopilot.launch_entrypoint_check.v1');
  assert.equal(report['passed'], true);
  assert.equal(report['package_root'], packageRoot);
});

void it('BUG-179 rejects signer manifest drift, symlink payloads, and extension modules outside the closed source/dist layouts', async () => {
  const sourceRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const loaded: unknown = await import('../../src/core/coordination/executable-resolution.ts');
  const resolver = resolverModule(loaded);
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-signer-resolver-'));
  const fixture = join(root, 'node_modules', 'pi-autopilot');
  try {
    for (const relative of [
      'package.json',
      'bin/autopilot-launch-signer.mjs',
      'bin/autopilot-agent-run.mjs',
      'src/extension.ts',
      'dist/src/extension.js',
    ]) await copyFile(join(sourceRoot, relative), join(fixture, relative));

    const sourceUrl = pathToFileURL(join(fixture, 'src', 'extension.ts')).href;
    assert.equal(resolver.resolveExtensionPackageExecutables(sourceUrl).packageRoot, fixture);

    const manifest = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8')) as Record<string, unknown>;
    manifest['bin'] = { 'autopilot-launch-signer': 'dist/bin/autopilot-launch-signer.mjs' };
    await writeFile(join(fixture, 'package.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
    assert.throws(() => resolver.resolveExtensionPackageExecutables(sourceUrl), /extension executable manifest identity/u);
    await copyFile(join(sourceRoot, 'package.json'), join(fixture, 'package.json'));

    const signer = join(fixture, 'bin', 'autopilot-launch-signer.mjs');
    const outside = join(root, 'outside-signer.mjs');
    await writeFile(outside, '#!/usr/bin/env node\n', 'utf8');
    await rm(signer);
    await symlink(outside, signer);
    assert.throws(() => resolver.resolveExtensionPackageExecutables(sourceUrl), /symbolic link|real path/u);

    const outsideModule = pathToFileURL(join(fixture, 'lib', 'extension.js')).href;
    assert.throws(() => resolver.resolveExtensionPackageExecutables(outsideModule), /module location/u);
    assert.throws(() => resolver.resolveExtensionPackageExecutables('https://example.invalid/extension.js'), /not a local package file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
