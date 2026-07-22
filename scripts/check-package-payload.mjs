#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true' } });
if (packed.status !== 0) {
  console.error(packed.stderr);
  process.exit(1);
}
const parsed = JSON.parse(packed.stdout);
const files = new Set(parsed[0]?.files?.map((entry) => entry.path) ?? []);
const required = [
  'bin/autopilot-agent-run.mjs',
  'bin/autopilot-coordinator.mjs',
  'dist/src/cli/autopilot-coordinator-bootstrap.js',
  'dist/src/cli/autopilot-coordinator.js',
  'dist/src/core/coordination/executable-resolution.js',
  'dist/src/core/coordination/migration.js',
  'dist/src/core/coordination/migration-paths.js',
  'dist/src/core/coordination/store.js',
  'dist/src/core/coordination/schemas.js',
  'dist/src/core/coordination/upgrade-contracts.js',
  'dist/src/core/coordination/upgrade.js',
  'extensions/autopilot.ts',
  'README.md',
  'TEST_PLAN.md',
  'TESTING.md',
  'PUBLISHING.md',
  'AUTOPILOT-INSTRUCTIONS.md',
  'logo.png',
  'docs/INDEX.md',
  'docs/read-before-edit.md',
  'docs/manifest.json',
  'docs/subsystems/coordination.md',
  'scripts/docs-generate.mjs',
  'scripts/docs-verify.mjs',
  'scripts/check-package-payload.mjs',
  'scripts/check-production-git-spawns.mjs',
  'scripts/generate-sbom.mjs',
  'scripts/run-certified-command.mjs',
  'scripts/security-scan.mjs',
  'scripts/test-packed-consumer-release.mjs',
  'scripts/verify-packed-consumer.mjs',
  'artifacts/security/cyclonedx-sbom.json',
  'artifacts/security/offline-security-scan.json',
];
const missing = required.filter((path) => !files.has(path));
const forbidden = [...files].filter((path) => path.startsWith('tests/')
  || path.startsWith('tools/')
  || path === '.pi'
  || path.startsWith('.pi/')
  || path.includes('/.pi/')
  || /(?:s1-corpus|corpus-clone|corpus-rehearsal|rehearsal-result|live-witness|transition-backup|actual-cf50|cf50.*\.tgz)/iu.test(path)
  || /(?:^|\/)private(?:\/|$)/u.test(path)
  || /(?:^|\/)(?:capability(?:\.key)?|c5-sandbox\.sb)$/u.test(path)
  || path.endsWith('.sb')
  || path.endsWith('.s1-corpus-request.json'));
let securityScanError = null;
let lockfileSha256 = null;
let securityScanLockfileSha256 = null;
try {
  const lockBytes = readFileSync(resolve(root, 'package-lock.json'));
  lockfileSha256 = `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`;
  const securityScan = JSON.parse(readFileSync(resolve(root, 'artifacts/security/offline-security-scan.json'), 'utf8'));
  securityScanLockfileSha256 = securityScan.lockfile_sha256;
  if (securityScan.schema_version !== 'autopilot.security_scan.v1' || securityScan.passed !== true || securityScanLockfileSha256 !== lockfileSha256) securityScanError = 'offline security scan is missing, failed, or stale for the exact package-lock.json';
} catch (error) {
  securityScanError = error instanceof Error ? error.message : String(error);
}
const result = { schema_version: 'autopilot.package_payload_check.v1', file_count: files.size, required, missing, forbidden, lockfile_sha256: lockfileSha256, security_scan_lockfile_sha256: securityScanLockfileSha256, security_scan_error: securityScanError, passed: missing.length === 0 && forbidden.length === 0 && securityScanError === null };
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
