#!/usr/bin/env node
import { isAbsolute, join, resolve } from 'node:path';

import { CoordinatorClient } from '../core/coordination/client.ts';
import { CoordinationRuntimeError } from '../core/coordination/failures.ts';
import { CoordinatorAlreadyRunningError, runCoordinatorUntilSignal } from '../core/coordination/server.ts';
import { coordinatorRuntimePaths } from '../core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../core/parallel-runtime.ts';

interface CliArgs {
  readonly command: 'serve' | 'status' | 'doctor' | 'export';
  readonly stateRoot: string | null;
  readonly repoId: string;
  readonly workstreamRun: string | null;
  readonly outputPath: string | null;
}

function usage(): string {
  return [
    'usage: autopilot-coordinator serve [--state-root <absolute-path>]',
    '       autopilot-coordinator status [--state-root <absolute-path>] [--repo-id <id>] [--run <workstream-run>]',
    '       autopilot-coordinator doctor [--state-root <absolute-path>]',
    '       autopilot-coordinator export [--state-root <absolute-path>] [--output <absolute-path>]',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  const command = argv[0];
  if (command !== 'serve' && command !== 'status' && command !== 'doctor' && command !== 'export') throw new Error(usage());
  let stateRoot: string | null = null;
  let repoId = 'global';
  let workstreamRun: string | null = null;
  let outputPath: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--help' || token === '-h') throw new Error(usage());
    if (token !== '--state-root' && token !== '--repo-id' && token !== '--run' && token !== '--output') throw new Error(`unknown option ${String(token)}\n${usage()}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--state-root') stateRoot = value;
    else if (token === '--repo-id') repoId = value;
    else if (token === '--run') workstreamRun = value;
    else outputPath = value;
    index += 1;
  }
  if (stateRoot !== null && !isAbsolute(stateRoot)) throw new Error('--state-root must be absolute');
  if (outputPath !== null && !isAbsolute(outputPath)) throw new Error('--output must be absolute');
  if (command !== 'status' && (repoId !== 'global' || workstreamRun !== null)) throw new Error('--repo-id and --run are supported only by status');
  if (command !== 'export' && outputPath !== null) throw new Error('--output is supported only by export');
  return { command, stateRoot, repoId, workstreamRun, outputPath };
}

function environment(args: CliArgs): ProcessEnvLike {
  return args.stateRoot === null ? process.env : { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: resolve(args.stateRoot) };
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(usage());
    return 0;
  }
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const env = environment(args);
  try {
    if (args.command === 'serve') {
      await runCoordinatorUntilSignal(coordinatorRuntimePaths(env));
      return 0;
    }
    const client = new CoordinatorClient({ env });
    const response = args.command === 'status'
      ? await client.query('status', args.repoId, args.workstreamRun)
      : args.command === 'doctor'
        ? await client.query('doctor')
        : await client.query('export', 'global', null, { output_path: args.outputPath ?? join(client.paths.exportsRoot, 'coordinator-export.json') });
    console.log(JSON.stringify(response.payload, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof CoordinatorAlreadyRunningError) {
      console.log(error.message);
      return 0;
    }
    if (error instanceof CoordinationRuntimeError) {
      console.error(error.message);
      return error.failure_class === 'system-fatal' ? 70 : 1;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
