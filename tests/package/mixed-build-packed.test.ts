import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackFile[];
}

function parsePack(stdout: string): PackResult {
  const value: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value) || value.length !== 1) throw new Error('npm pack result is malformed');
  const entry: unknown = value[0];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('npm pack entry is malformed');
  const record = entry as Readonly<Record<string, unknown>>;
  const filename = record.filename;
  const files = record.files;
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('npm pack filename is malformed');
  if (!Array.isArray(files)) throw new Error('npm pack files list is malformed');
  const parsedFiles = files.map((file): PackFile => {
    if (typeof file !== 'object' || file === null || Array.isArray(file)) throw new Error('npm pack file entry is malformed');
    const path = (file as Readonly<Record<string, unknown>>).path;
    if (typeof path !== 'string' || path.length === 0) throw new Error('npm pack file path is malformed');
    return { path };
  });
  return { filename, files: parsedFiles };
}

void describe('packed current-architecture payload boundary', () => {
  void it('packs package-contained runtime surfaces and no removed legacy dist tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-packed-current-'));
    const packRoot = join(root, 'pack');
    const cacheRoot = join(root, 'npm-cache');
    await mkdir(packRoot, { recursive: true });
    try {
      const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packRoot], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: { ...process.env, NPM_CONFIG_CACHE: cacheRoot, NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false' },
        maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(packed.status, 0, packed.stderr);
      const result = parsePack(packed.stdout);
      const tarball = join(packRoot, result.filename);
      assert.equal(existsSync(tarball), true, 'npm pack must create the tarball');
      const paths = new Set(result.files.map((file) => file.path));
      for (const required of ['bin/autopilot-core.mjs', 'bin/autopilot-agent-run.mjs', 'binaries/MANIFEST.json', 'src/extension.ts', 'src/resolve-core.ts', 'src/generated/child-extension.ts', 'extensions/autopilot.ts', 'docs/generated/index.md', 'AUTOPILOT-INSTRUCTIONS.md', 'README.md', 'LICENSE']) {
        assert.equal(paths.has(required), true, `packed payload missing ${required}`);
      }
      for (const forbidden of result.files.map((file) => file.path).filter((path) => path === 'dist' || path.startsWith('dist/') || path.includes('/dist/'))) {
        assert.fail(`packed payload contains removed build artifact ${forbidden}`);
      }
      for (const forbidden of result.files.map((file) => file.path).filter((path) => path === '.pi' || path.startsWith('.pi/') || path.includes('/.pi/'))) {
        assert.fail(`packed payload contains private runtime state ${forbidden}`);
      }
      const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { bin?: Readonly<Record<string, string>> };
      assert.equal(pkg.bin?.['autopilot-core'], 'bin/autopilot-core.mjs');
      assert.equal(pkg.bin?.['autopilot-agent-run'], 'bin/autopilot-agent-run.mjs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
