#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'src', 'cli', 'autopilot-agent-run.ts');
const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error !== undefined) {
  process.stderr.write(`autopilot-agent-run failed to launch TypeScript entrypoint: ${result.error.message}\n`);
  process.exit(1);
}
if (result.signal !== null) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
