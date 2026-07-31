#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { resolveCoreBinary } from '../src/resolve-core-runtime.js';

let binary;
try {
  binary = resolveCoreBinary();
} catch (error) {
  console.error(`Autopilot unavailable: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(127);
}

const child = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (child.error) {
  console.error(`autopilot-core failed to start: ${child.error.message}`);
  process.exit(127);
}
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
