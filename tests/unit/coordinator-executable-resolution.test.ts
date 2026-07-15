import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface CoordinatorExecutableResolution {
  readonly packageRoot: string;
  readonly bootstrapPath: string;
  readonly coordinatorPath: string;
}

interface ExecutableResolverModule {
  resolveCoordinatorExecutable(moduleUrl: string): CoordinatorExecutableResolution;
}

interface CoordinatorClientModule {
  resolveCoordinatorExecutableForClientModule(): CoordinatorExecutableResolution;
}

function clientModule(value: unknown): CoordinatorClientModule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('coordinator client module is malformed');
  const resolver = (value as Readonly<Record<string, unknown>>)['resolveCoordinatorExecutableForClientModule'];
  if (typeof resolver !== 'function') throw new TypeError('coordinator client executable resolver export is missing');
  return value as CoordinatorClientModule;
}

function resolverModule(value: unknown): ExecutableResolverModule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('coordinator executable resolver module is malformed');
  const resolver = (value as Readonly<Record<string, unknown>>)['resolveCoordinatorExecutable'];
  if (typeof resolver !== 'function') throw new TypeError('coordinator executable resolver export is missing');
  return value as ExecutableResolverModule;
}

async function copyFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
}

void it('resolves source-loaded and dist-loaded clients to one contained compiled production coordinator', async () => {
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const sourceLoaded: unknown = await import('../../src/core/coordination/client.ts');
  const distLoaded: unknown = await import(pathToFileURL(join(packageRoot, 'dist', 'src', 'core', 'coordination', 'client.js')).href);
  const fromSource = clientModule(sourceLoaded).resolveCoordinatorExecutableForClientModule();
  const fromDist = clientModule(distLoaded).resolveCoordinatorExecutableForClientModule();
  assert.deepEqual(fromSource, fromDist);
  assert.equal(fromSource.packageRoot, packageRoot);
  assert.equal(fromSource.bootstrapPath, join(packageRoot, 'dist', 'src', 'cli', 'autopilot-coordinator-bootstrap.js'));
  assert.equal(fromSource.coordinatorPath, join(packageRoot, 'dist', 'src', 'cli', 'autopilot-coordinator.js'));
  for (const executable of [fromSource.bootstrapPath, fromSource.coordinatorPath]) {
    assert.equal(executable.endsWith('.js'), true);
    assert.equal(executable.startsWith(`${packageRoot}/`) || executable.startsWith(`${packageRoot}\\`), true);
  }
});

void it('rejects package identity drift, symlink payloads, and module locations outside the closed source/dist set', async () => {
  const sourceRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const loaded: unknown = await import('../../src/core/coordination/executable-resolution.ts');
  const resolver = resolverModule(loaded);
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-resolver-fixture-'));
  const fixture = join(root, 'node_modules', 'pi-autopilot');
  try {
    for (const relative of [
      'package.json',
      'dist/src/cli/autopilot-coordinator-bootstrap.js',
      'dist/src/cli/autopilot-coordinator.js',
      'src/core/coordination/client.ts',
      'dist/src/core/coordination/client.js',
    ]) await copyFile(join(sourceRoot, relative), join(fixture, relative));
    const sourceUrl = pathToFileURL(join(fixture, 'src', 'core', 'coordination', 'client.ts')).href;
    const expected = resolver.resolveCoordinatorExecutable(sourceUrl);
    assert.equal(expected.packageRoot, fixture);

    await writeFile(join(fixture, 'package.json'), `${JSON.stringify({ name: 'synthetic-other-package', version: '1.1.7' })}\n`, 'utf8');
    assert.throws(() => resolver.resolveCoordinatorExecutable(sourceUrl), /package identity/u);
    await copyFile(join(sourceRoot, 'package.json'), join(fixture, 'package.json'));

    const coordinator = join(fixture, 'dist', 'src', 'cli', 'autopilot-coordinator.js');
    const outside = join(root, 'outside.js');
    await writeFile(outside, 'export {};\n', 'utf8');
    await rm(coordinator);
    await symlink(outside, coordinator);
    assert.throws(() => resolver.resolveCoordinatorExecutable(sourceUrl), /symbolic link|symlink|real path/u);

    const outsideModule = pathToFileURL(join(fixture, 'lib', 'client.js')).href;
    assert.throws(() => resolver.resolveCoordinatorExecutable(outsideModule), /module location/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
