#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lockBytes = readFileSync(resolve(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes.toString('utf8'));
const findings = [];
const reviewedInstallScripts = {
  'node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai': ['1.52.0', 'sha512-gwSvbpiN/17O9TbsqSsE/OzZcpv5Fo4RQjdngGgogtuB9RsyJ8ZHhX5KjHj1bp5N9snN2eK8LDGXSaWW2hof8Q=='],
  'node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs': ['7.6.4', 'sha512-RJJPTTpvFfHcWLkIa2JFWK4XvtSzS0yEWDmunqHXli1h3JlkbcQZXDZdcWxv+JK3Xsl5/UFDPZ0iGm7DAengYw=='],
  'node_modules/esbuild': ['0.28.1', 'sha512-HrJrvZv5ayxBzPfwphOoNzkzOIIlifzk0KJrGK2c8R4+LKpMtpYLQeUdjnwjWv/LZlkH2laZk+4w78pi99D4Vw=='],
  'node_modules/fsevents': ['2.3.3', 'sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw=='],
};
const reviewedIntegrityExceptions = new Set([
  'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core@0.80.6',
  'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai@0.80.6',
  'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui@0.80.6',
]);
const reviewed = [];
const packages = lock.packages && typeof lock.packages === 'object' ? Object.entries(lock.packages) : [];
for (const [path, value] of packages) {
  if (!value || typeof value !== 'object') {
    findings.push(`invalid lock entry: ${path}`);
    continue;
  }
  const resolved = value.resolved;
  if (typeof resolved === 'string' && /^(?:git\+|git:|file:|https?:)/u.test(resolved) && !/^https:\/\/registry\.npmjs\.org\//u.test(resolved)) findings.push(`non-registry dependency source: ${path} -> ${resolved}`);
  if (typeof resolved === 'string' && /^https:\/\/registry\.npmjs\.org\//u.test(resolved) && (typeof value.integrity !== 'string' || !/^sha512-/u.test(value.integrity)) && !reviewedIntegrityExceptions.has(`${path}@${String(value.version)}`)) findings.push(`registry dependency lacks sha512 integrity: ${path}`);
  if (value.hasInstallScript === true) {
    const approval = reviewedInstallScripts[path];
    if (approval === undefined) findings.push(`dependency install script requires review: ${path}`);
    else if (value.version !== approval[0] || value.integrity !== approval[1]) findings.push(`reviewed install script changed version or integrity: ${path}`);
    else reviewed.push(`${path}@${approval[0]} (${approval[1]})`);
  }
}
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) findings.push('runtime dependencies require explicit security review');
const result = {
  schema_version: 'autopilot.security_scan.v1',
  package: packageJson.name,
  version: packageJson.version,
  lockfile_sha256: `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`,
  production_dependency_count: packageJson.dependencies ? Object.keys(packageJson.dependencies).length : 0,
  peer_dependency_count: packageJson.peerDependencies ? Object.keys(packageJson.peerDependencies).length : 0,
  audited_lock_entry_count: packages.length,
  reviewed_install_scripts: reviewed,
  reviewed_integrity_exceptions: [...reviewedIntegrityExceptions].sort(),
  findings,
  passed: findings.length === 0,
};
const output = resolve(root, 'artifacts/security/offline-security-scan.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
if (!process.argv.includes('--quiet')) console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
