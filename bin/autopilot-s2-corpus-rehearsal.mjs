#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, 'dist', 'tools', 's2-corpus-rehearsal', 'cli.js');
await import(pathToFileURL(cli).href);
