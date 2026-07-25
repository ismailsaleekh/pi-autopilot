#!/usr/bin/env node
// BUG-179: deterministic package-loader/signer executable certification.
//
// This gate runs after `npm run build` and proves that both package-owned module
// layouts resolve to the SAME physical root-level signer. It deliberately does
// not launch Pi, a model, a coordinator, or a signer, and it has no cwd/PATH/
// ancestor/global-install fallback. A missing build, manifest drift, symlink, or
// layout mismatch fails prepack loudly before publication.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveExtensionPackageExecutables } from '../dist/src/core/coordination/executable-resolution.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(packageRoot, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const declaredExtensions = manifest?.pi?.extensions;
if (!Array.isArray(declaredExtensions) || declaredExtensions.length !== 1 || declaredExtensions[0] !== './extensions/autopilot.ts') {
  throw new Error('BUG-179 launch entrypoint check: package.json pi.extensions must be exactly ["./extensions/autopilot.ts"]');
}

const sourceModuleUrl = pathToFileURL(join(packageRoot, 'src', 'extension.ts')).href;
const distModuleUrl = pathToFileURL(join(packageRoot, 'dist', 'src', 'extension.js')).href;
const source = resolveExtensionPackageExecutables(sourceModuleUrl);
const dist = resolveExtensionPackageExecutables(distModuleUrl);
const expectedSignerPath = join(packageRoot, 'bin', 'autopilot-launch-signer.mjs');
const expectedRunnerPath = join(packageRoot, 'bin', 'autopilot-agent-run.mjs');
if (source.packageRoot !== packageRoot || source.launchSignerPath !== expectedSignerPath || source.agentRunnerPath !== expectedRunnerPath) {
  throw new Error(`BUG-179 launch entrypoint check: source layout resolved unexpected executable identity: ${JSON.stringify(source)}`);
}
if (dist.packageRoot !== source.packageRoot || dist.launchSignerPath !== source.launchSignerPath || dist.agentRunnerPath !== source.agentRunnerPath) {
  throw new Error(`BUG-179 launch entrypoint check: source/dist executable identities diverge: ${JSON.stringify({ source, dist })}`);
}

const report = {
  schema_version: 'autopilot.launch_entrypoint_check.v1',
  passed: true,
  package_root: packageRoot,
  package_extension: declaredExtensions[0],
  source_module: fileURLToPath(sourceModuleUrl),
  dist_module: fileURLToPath(distModuleUrl),
  signer_path: expectedSignerPath,
  runner_path: expectedRunnerPath,
};
// npm forwards prepack stdout into `npm pack --json` stdout. Default success
// MUST therefore be silent so the npm JSON document remains parseable; callers
// that need a machine-readable witness opt in explicitly.
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
