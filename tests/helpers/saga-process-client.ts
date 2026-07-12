import { readFile } from 'node:fs/promises';

import { recoverOwnedWorktreeSagas } from '../../src/core/coordination/worktree-saga.ts';
import { parseLegacyActiveAutopilots } from '../../src/core/coordination/legacy-preflight.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

const activePath = process.argv[2];
if (activePath === undefined) throw new Error('active row path is required');
const value: unknown = JSON.parse(await readFile(activePath, 'utf8')) as unknown;
const active = parseLegacyActiveAutopilots([value])[0];
if (active === undefined) throw new Error('active row is missing');
const env: ProcessEnvLike = process.env;
const operations = await recoverOwnedWorktreeSagas({ active, env });
console.log(JSON.stringify({ recovered: operations.map((operation) => operation.operation_id) }));
