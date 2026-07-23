#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, 'dist', 'tools', 's2-corpus-rehearsal', 'cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
  shell: false,
});
if (result.error !== undefined) {
  process.stderr.write(`autopilot-s2-corpus-rehearsal failed to launch: ${result.error.message}\n`);
  process.exitCode = 1;
} else if (result.signal !== null) {
  process.stderr.write(`autopilot-s2-corpus-rehearsal terminated by ${result.signal}\n`);
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
