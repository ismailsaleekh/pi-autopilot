#!/usr/bin/env node
// Compatibility entrypoint for older release notes. The active payload gate is
// scripts/check-payload.mjs; keep this file as a thin delegator so stale dist/
// signer-era allowlists cannot survive in an executable script.

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const child = spawnSync(process.execPath, [join(root, 'scripts', 'check-payload.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

if (child.error) {
  process.stderr.write(`check-package-payload: failed to start check-payload.mjs: ${child.error.message}\n`);
  process.exit(1);
}
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
