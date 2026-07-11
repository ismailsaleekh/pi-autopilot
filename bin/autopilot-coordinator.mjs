#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'dist', 'src', 'cli', 'autopilot-coordinator.js');

if (!existsSync(cli)) {
  process.stderr.write(
    `autopilot-coordinator compiled entrypoint is missing: ${cli}\n` +
      'Run `npm run build` in the pi-autopilot package before using the local checkout.\n',
  );
  process.exitCode = 1;
} else {
  try {
    await import(pathToFileURL(cli).href);
  } catch (error) {
    process.stderr.write(`autopilot-coordinator failed to load compiled entrypoint: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
