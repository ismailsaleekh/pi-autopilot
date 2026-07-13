#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const components = [];
const requiredPeerNames = new Set(Object.keys(manifest.peerDependencies ?? {}));
const purlName = (name) => name.startsWith('@') && name.includes('/') ? `${encodeURIComponent(name.slice(0, name.indexOf('/')))}/${encodeURIComponent(name.slice(name.indexOf('/') + 1))}` : encodeURIComponent(name);
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === '' || !entry || typeof entry !== 'object' || typeof entry.version !== 'string') continue;
  const marker = '/node_modules/';
  const index = path.lastIndexOf(marker);
  const name = typeof entry.name === 'string' ? entry.name : index >= 0 ? path.slice(index + marker.length) : path.replace(/^node_modules\//u, '');
  if (!name) continue;
  const component = { type: 'library', name, version: entry.version, purl: `pkg:npm/${purlName(name)}@${entry.version}`, scope: entry.dev === true && !requiredPeerNames.has(name) ? 'excluded' : 'required', ...(typeof entry.integrity === 'string' && entry.integrity.startsWith('sha512-') ? { hashes: [{ alg: 'SHA-512', content: Buffer.from(entry.integrity.slice('sha512-'.length), 'base64').toString('hex') }] } : {}) };
  components.push(component);
}
components.sort((left, right) => `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`));
const lockHash = createHash('sha256').update(readFileSync(resolve(root, 'package-lock.json'))).digest('hex');
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${lockHash.slice(0, 8)}-${lockHash.slice(8, 12)}-5${lockHash.slice(13, 16)}-8${lockHash.slice(17, 20)}-${lockHash.slice(20, 32)}`,
  version: 1,
  metadata: { component: { type: 'application', name: manifest.name, version: manifest.version, purl: `pkg:npm/${purlName(manifest.name)}@${manifest.version}` }, properties: [{ name: 'pi-autopilot:lockfile-sha256', value: `sha256:${lockHash}` }] },
  components,
};
const output = resolve(root, 'artifacts/security/cyclonedx-sbom.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
console.error(`${output}: ${components.length} components`);
