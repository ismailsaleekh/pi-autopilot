#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.isFile() && path.endsWith('.test.ts')) files.push(relative(root, path));
  }
}
walk(join(root, 'tests'));
if (files.length === 0) {
  console.error('run-tests-tree: no tests/**/*.test.ts files found');
  process.exit(1);
}
const child = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...files], { cwd: root, stdio: 'inherit', env: process.env });
if (child.error) { console.error(`run-tests-tree: failed to launch node:test: ${child.error.message}`); process.exit(2); }
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
