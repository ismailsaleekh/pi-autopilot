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
  'bin/autopilot-s2-corpus-rehearsal.mjs',
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
  'dist/tools/s2-corpus-rehearsal/cli.js',
  'dist/tools/s2-corpus-rehearsal/contracts.js',
  'dist/tools/s2-corpus-rehearsal/release-gate.js',
  'dist/tools/s2-corpus-rehearsal/terminal-recovery-worker.js',
  'tools/s2-corpus-rehearsal/cli.ts',
  'tools/s2-corpus-rehearsal/contracts.ts',
  'tools/s2-corpus-rehearsal/release-gate.ts',
  'tools/s2-corpus-rehearsal/candidate-worker.ts',
  'tools/s2-corpus-rehearsal/terminal-recovery-worker.ts',
  'tools/s2-corpus-rehearsal/git-mirror.ts',
  'tools/s2-corpus-rehearsal/inventory.ts',
  'tools/s2-corpus-rehearsal/path-rebase.ts',
  'artifacts/security/cyclonedx-sbom.json',
  'artifacts/security/offline-security-scan.json',
];
const missing = required.filter((path) => !files.has(path));
const isGenericS2Harness = (path) => path === 'bin/autopilot-s2-corpus-rehearsal.mjs' || path.startsWith('tools/s2-corpus-rehearsal/') || path.startsWith('dist/tools/s2-corpus-rehearsal/');
const isRequiredGenericPublicCorpusDoc = (path) => path === 'docs/tools/s2-corpus-rehearsal.md';
const forbidden = [...files].filter((path) => path.startsWith('tests/')
  || (path.startsWith('tools/') && !path.startsWith('tools/s2-corpus-rehearsal/'))
  || path === '.pi'
  || path.startsWith('.pi/')
  || path.includes('/.pi/')
  || (!isGenericS2Harness(path) && !isRequiredGenericPublicCorpusDoc(path) && /(?:s1-corpus|corpus-clone|corpus-rehearsal|rehearsal-result|live-witness|transition-backup|actual-cf50|cf50.*\.tgz)/iu.test(path))
  || (!isRequiredGenericPublicCorpusDoc(path) && /(?:^|\/)(?:private|corpus|corpora|results?|logs?)(?:\/|$)/iu.test(path))
  || /\.(?:tgz|tar|tar\.gz|zip|log)$/iu.test(path)
  || /(?:^|\/)(?:capability(?:\.key)?|c5-sandbox\.sb)$/u.test(path)
  || path.endsWith('.sb')
  || path.endsWith('.s1-corpus-request.json')
  || path.endsWith('.s2-corpus-request.json')
  || path.endsWith('.s2-corpus-result.json'));
const publishedScriptContentFindings = [...files].filter((path) => path.startsWith('scripts/') && /\.(?:mjs|js|ts)$/u.test(path) && path !== 'scripts/check-package-payload.mjs').flatMap((path) => {
  const text = readFileSync(resolve(root, path), 'utf8');
  const findings = [];
  for (const [label, pattern] of [
    ['closed-plan-private-path', /(?:^|[^A-Za-z0-9._-])plans\/active\//u],
    ['private-corpus-artifact-byte', /(?:tests\/fixtures\/releases|actual-cf50|cf50[^\n]*\.tgz|s1-corpus-request\.json|s2-corpus-request\.json|s2-corpus-result\.json)/iu],
  ]) if (pattern.test(text)) findings.push(`${path}:${label}`);
  return findings;
});
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
const result = { schema_version: 'autopilot.package_payload_check.v1', file_count: files.size, required, missing, forbidden, published_script_content_findings: publishedScriptContentFindings, lockfile_sha256: lockfileSha256, security_scan_lockfile_sha256: securityScanLockfileSha256, security_scan_error: securityScanError, passed: missing.length === 0 && forbidden.length === 0 && publishedScriptContentFindings.length === 0 && securityScanError === null };
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
