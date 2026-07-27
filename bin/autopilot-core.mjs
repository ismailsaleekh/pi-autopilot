#!/usr/bin/env node
import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const supported = {
  'darwin-arm64': 'autopilot-core',
  'darwin-x64': 'autopilot-core',
  'linux-x64': 'autopilot-core',
  'linux-arm64': 'autopilot-core',
  'win32-x64': 'autopilot-core.exe',
};

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const platformKey = `${process.platform}-${process.arch}`;
const binaryName = supported[platformKey];
if (binaryName === undefined) {
  console.error(`autopilot-core unsupported platform ${platformKey}. Supported platforms: ${Object.keys(supported).join(', ')}`);
  process.exit(127);
}
const binary = join(packageRoot, 'binaries', platformKey, binaryName);
try {
  accessSync(binary, constants.X_OK);
} catch {
  console.error(`Autopilot unavailable: core binary missing for ${platformKey}. Reinstall pi-autopilot.`);
  process.exit(127);
}
const child = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (child.error) {
  console.error(`autopilot-core failed to start: ${child.error.message}`);
  process.exit(127);
}
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
