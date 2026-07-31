#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { resolveCoreWrapper } from '../src/resolve-core-runtime.js';

let coreWrapper;
try {
  coreWrapper = resolveCoreWrapper();
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
