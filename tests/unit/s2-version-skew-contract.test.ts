import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  S2_PREVIOUS_RELEASE_TARBALL_SHA256,
  S2_RELEASE_SKEW_REQUIRED_JOURNEYS,
  parseS2ReleaseSkewFixtureManifest,
} from '../../src/core/coordination/s2-version-skew.ts';
import { verifyS2PreviousReleaseFixture } from '../helpers/s2-release-fixture.ts';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = fileURLToPath(new URL('../fixtures/releases/s2/manifest.json', import.meta.url));

interface JsonMap {
  readonly [key: string]: unknown;
}

interface PackFile {
  readonly path: string;
}

interface PackEntry {
  readonly files: readonly PackFile[];
}

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function parsePackEntries(stdout: string): PackEntry[] {
  const parsed: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new TypeError('pack output must be an array');
  const entries: PackEntry[] = [];
  for (const entry of parsed) {
    if (!isJsonMap(entry)) throw new TypeError('pack entry must be an object');
    const files = entry['files'];
    if (!Array.isArray(files)) throw new TypeError('pack files must be an array');
    const packFiles: PackFile[] = [];
    for (const file of files) {
      if (!isJsonMap(file)) throw new TypeError('pack file must be an object');
      packFiles.push({ path: requireString(file['path'], 'pack file path') });
    }
    entries.push({ files: packFiles });
  }
  return entries;
}

void describe('S2-C release skew fixture contract', () => {
  void it('pins the previous published tarball through the S2-C manifest', async () => {
    const verified = await verifyS2PreviousReleaseFixture();
    assert.equal(verified.manifest.lane, 's2-c');
    assert.equal(verified.manifest.previous_tarball_sha256, S2_PREVIOUS_RELEASE_TARBALL_SHA256);
    assert.deepEqual(verified.manifest.required_journeys, S2_RELEASE_SKEW_REQUIRED_JOURNEYS);
  });

  void it('rejects non-canonical S2-C fixture manifests', async () => {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    const canonical = parseS2ReleaseSkewFixtureManifest(parsed);
    assert.equal(canonical.previous_fixture_manifest, '../cf50/manifest.json');

    if (!isJsonMap(parsed)) throw new TypeError('fixture manifest must be an object');
    const withExtraField: JsonMap = { ...parsed, extra_field: true };
    assert.throws(() => parseS2ReleaseSkewFixtureManifest(withExtraField), /field set mismatch/u);

    const withDigestDrift: JsonMap = { ...parsed, previous_tarball_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' };
    assert.throws(() => parseS2ReleaseSkewFixtureManifest(withDigestDrift), /previous_tarball_sha256 mismatch/u);
  });

  void it('excludes S2-C and previous-release fixtures from the npm payload', async () => {
    const npmCache = await mkdtemp(join(tmpdir(), 'pi-autopilot-s2-pack-cache-'));
    try {
      const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: { ...process.env, NPM_CONFIG_CACHE: npmCache, NPM_CONFIG_OFFLINE: 'true', npm_config_offline: 'true' },
      });
      assert.equal(packed.status, 0, packed.stderr);
      const entry = parsePackEntries(packed.stdout)[0];
      if (entry === undefined) throw new Error('pack output must contain one entry');
      const files = entry.files.map((file) => file.path).sort();
      assert.equal(files.some((file) => file.startsWith('tests/')), false);
      assert.equal(files.includes('tests/fixtures/releases/s2/manifest.json'), false);
      assert.equal(files.includes('tests/fixtures/releases/s2/README.md'), false);
      assert.equal(files.includes('tests/fixtures/releases/cf50/pi-autopilot-1.1.8-cf50.tgz'), false);
    } finally {
      await rm(npmCache, { recursive: true, force: true });
    }
  });
});
