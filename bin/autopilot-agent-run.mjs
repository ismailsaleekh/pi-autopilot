#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants, lstatSync, accessSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const coreWrapper = join(packageRoot, 'bin', 'autopilot-core.mjs');

try {
  const stat = lstatSync(coreWrapper);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('sibling bin/autopilot-core.mjs is not a regular non-symlink file');
  }
  accessSync(coreWrapper, constants.R_OK);
} catch (error) {
  console.error(`autopilot-agent-run cannot resolve contained autopilot-core wrapper: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(127);
}

const child = spawnSync(process.execPath, [coreWrapper, 'agent-run', ...process.argv.slice(2)], { stdio: 'inherit' });
if (child.error) {
  console.error(`autopilot-agent-run failed to start contained core: ${child.error.message}`);
  process.exit(127);
}
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
