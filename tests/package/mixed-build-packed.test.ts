import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startTaggedCoordinator } from '../helpers/tagged-coordinator.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

function packFilename(stdout: string): string {
  const value: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'object' || value[0] === null || Array.isArray(value[0])) throw new Error('npm pack result is malformed');
  const filename = (value[0] as Readonly<Record<string, unknown>>)['filename'];
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('npm pack filename is malformed');
  return filename;
}

void describe('BUG-175 packed mixed-build compatibility', () => {
  void it('runs the installed 1.0.3 client through the exact live v1.0.1 coordinator without replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-bug-175-packed-'));
    const packRoot = join(root, 'pack');
    const installRoot = join(root, 'consumer');
    const cacheRoot = join(root, 'npm-cache');
    const stateRoot = join(root, 'state');
    await mkdir(packRoot, { recursive: true });
    await mkdir(installRoot, { recursive: true });
    let tagged: Awaited<ReturnType<typeof startTaggedCoordinator>> | null = null;
    try {
      const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', packRoot], { cwd: packageRoot, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: cacheRoot, NPM_CONFIG_OFFLINE: 'true' } });
      assert.equal(packed.status, 0, packed.stderr);
      const tarball = join(packRoot, packFilename(packed.stdout));
      assert.equal(existsSync(tarball), true);
      const installed = spawnSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', tarball], { cwd: installRoot, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: cacheRoot, NPM_CONFIG_OFFLINE: 'true' } });
      assert.equal(installed.status, 0, installed.stderr);

      tagged = await startTaggedCoordinator({ stateRoot, extractionRoot: root });
      const before = await readFile(tagged.paths.lockPath, 'utf8');
      const clientModule = pathToFileURL(join(installRoot, 'node_modules', 'pi-autopilot', 'dist', 'src', 'core', 'coordination', 'client.js')).href;
      const probe = join(root, 'installed-client-probe.mjs');
      await writeFile(probe, `import { CoordinatorClient } from ${JSON.stringify(clientModule)};\nconst client = new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: process.env.AUTOPILOT_STATE_ROOT }, autoStart: false });\nconst response = await client.query('handshake');\nconsole.log(JSON.stringify(response.payload));\n`, 'utf8');
      const result = spawnSync(process.execPath, [probe], { cwd: installRoot, encoding: 'utf8', env: { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot } });
      assert.equal(result.status, 0, result.stderr);
      const payload: unknown = JSON.parse(result.stdout.trim()) as unknown;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('installed mixed-build probe returned malformed payload');
      assert.equal((payload as Readonly<Record<string, unknown>>)['package_build'], '1.0.1-cf38');
      assert.equal(await readFile(tagged.paths.lockPath, 'utf8'), before);
    } finally {
      if (tagged !== null) await tagged.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
