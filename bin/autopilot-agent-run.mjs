#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants, lstatSync, accessSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const coreWrapper = join(packageRoot, 'bin', 'autopilot-core.mjs');
const devCore = join(packageRoot, 'target', 'release', process.platform === 'win32' ? 'autopilot-core.exe' : 'autopilot-core');
const coreInvocation = resolveCoreInvocation();

const child = spawnSync(coreInvocation.command, [...coreInvocation.prefixArgs, 'agent-run', ...process.argv.slice(2)], { stdio: 'inherit' });
if (child.error) {
  console.error(`autopilot-agent-run failed to start contained core: ${child.error.message}`);
  process.exit(127);
}
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);

function resolveCoreInvocation() {
  const dev = optionalExecutable(devCore, 'source checkout target/release autopilot-core');
  if (dev) return { command: devCore, prefixArgs: [] };
  try {
    const stat = lstatSync(coreWrapper);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('sibling bin/autopilot-core.mjs is not a regular non-symlink file');
    }
    accessSync(coreWrapper, constants.R_OK);
    return { command: process.execPath, prefixArgs: [coreWrapper] };
  } catch (error) {
    console.error(`autopilot-agent-run cannot resolve contained autopilot-core wrapper: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(127);
  }
}

function optionalExecutable(path, label) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${label} is present but is not a regular non-symlink file: ${path}`);
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    console.error(`autopilot-agent-run cannot use ${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(127);
  }
}
