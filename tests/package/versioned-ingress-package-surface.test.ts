import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

void describe('versioned ingress package surface', () => {
  void it('ships the coordination barrel and compiled registry for package consumers', async () => {
    const registryPath = join(packageRoot, 'dist', 'src', 'core', 'coordination', 'versioned-ingress-registry.js');
    await access(registryPath);
    const coordination = await import(pathToFileURL(join(packageRoot, 'dist', 'src', 'core', 'coordination', 'index.js')).href) as Readonly<Record<string, unknown>>;
    assert.equal(typeof coordination['parseVersionedPersistedArtifact'], 'function');
    assert.equal(typeof coordination['parseVersionedUnitFailureIngress'], 'function');
    const fixture = await readFile(join(packageRoot, 'tests', 'fixtures', 's2-ingress', 'current-unit-failure-reset.json'));
    const parse = coordination['parseVersionedUnitFailureIngress'];
    if (typeof parse !== 'function') throw new TypeError('registry parser export missing');
    const parsed = parse({ bytes: new Uint8Array(fixture), producer_build: '1.2.0-s1', producer_generation: 3, identity: { workstream: 'workstream-bug177', workstreamRun: 'workstream-run-bug177', unitId: 'unit-current', attempt: 1 } }) as Readonly<Record<string, unknown>>;
    assert.equal(parsed['kind'], 'unit_failure');
  });
});
