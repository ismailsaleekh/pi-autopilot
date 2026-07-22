#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from '../core/agent-runner.ts';
import { driveD65SubscriptionFailureRecoveryFromEnvironment } from '../core/coordination/d65-graph-successor-runtime.ts';
import { CoordinationRuntimeError, formatCoordinationRuntimeError } from '../core/coordination/failures.ts';
import { readStableRegularFile } from '../core/coordination/reconciliation.ts';

interface RunCliArgs {
  readonly mode: 'run';
  readonly specPath: string;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly piExecutable?: string;
}

interface RecoveryBoundFile {
  readonly ref: string;
  readonly path: string;
}

interface SubscriptionRecoveryCliArgs {
  readonly mode: 'recover-d65-subscription';
  readonly continuationPath: string;
  readonly probePath: string;
  readonly continuationSequence: number;
  readonly boundFiles: readonly RecoveryBoundFile[];
  readonly json: boolean;
}

type CliArgs = RunCliArgs | SubscriptionRecoveryCliArgs;

const MAX_RECOVERY_AUTHORITY_BYTES = 1024 * 1024;

const EXIT_BY_FAILURE_CLASS = Object.freeze({
  'spec-invalid': 2,
  'waiting-for-peer-release': 3,
  'pi-spawn-failed': 10,
  'missing-structured-output': 20,
  'invalid-structured-output': 21,
  'status-non-success': 30,
  'runtime-commit-failed': 31,
} as const satisfies Readonly<Record<AutopilotAgentRunError['failureClass'], number>>);

export async function runAutopilotAgentCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'autopilot-agent-run help') console.error(message);
    console.log(usage().trimEnd());
    return message === 'autopilot-agent-run help' ? 0 : 2;
  }

  try {
    if (args.mode === 'recover-d65-subscription') {
      const continuationBytes = await readStableRegularFile(args.continuationPath, 'D65 subscription continuation CLI input', MAX_RECOVERY_AUTHORITY_BYTES);
      const probeBytes = await readStableRegularFile(args.probePath, 'D65 subscription probe CLI input', MAX_RECOVERY_AUTHORITY_BYTES);
      const boundAuthorityFiles = [];
      for (const file of args.boundFiles) boundAuthorityFiles.push(Object.freeze({ ref: file.ref, bytes: await readStableRegularFile(file.path, `D65 subscription bound authority ${file.ref}`, MAX_RECOVERY_AUTHORITY_BYTES) }));
      const recovered = await driveD65SubscriptionFailureRecoveryFromEnvironment({ env, recovery: { continuationBytes, probeBytes, continuationSequence: args.continuationSequence, boundAuthorityFiles: Object.freeze(boundAuthorityFiles) } });
      const payload = { status: 'recovered', mode: args.mode, ...recovered };
      console.log(args.json ? JSON.stringify(payload) : `autopilot-agent-run recovered D65 subscription failure continuation_graph=${String(recovered.continuationGraphSequence)} probe_graph=${String(recovered.probeGraphSequence)}`);
      return 0;
    }
    const result = await runAutopilotAgentFromSpecPath(args.specPath, {
      dryRun: args.dryRun,
      env,
      ...(args.piExecutable === undefined ? {} : { piExecutable: args.piExecutable }),
    });
    if (args.json) {
      console.log(
        JSON.stringify({
          status: result.status,
          unit_id: result.spec.unit_id,
          role: result.spec.role,
          verdict: result.statusEntry?.verdict ?? null,
          status_output: result.statusOutput,
          receipt_output: result.receiptOutput,
          prompt_snapshot: result.promptSnapshotPath,
          context_path: result.contextPath,
          audit_output: result.auditOutput,
          audit_classification: result.auditClassification,
          execution_commit_output: result.executionCommitOutput,
          execution_commit_sha: result.executionCommitSha,
          summary: result.summary,
        }),
      );
    } else {
      console.log(
        `autopilot-agent-run ${result.status} unit=${result.spec.unit_id} role=${result.spec.role} ` +
          `status=${result.statusOutput} audit=${result.auditClassification ?? 'none'} ` +
          `commit=${result.executionCommitSha ?? 'none'} summary=${result.summary}`,
      );
    }
    return 0;
  } catch (error) {
    if (args.mode === 'recover-d65-subscription' && error instanceof CoordinationRuntimeError) {
      const payload = { status: 'recovery-pending', mode: args.mode, failure_code: error.code, failure_class: error.failure_class, retry_policy: error.retry_policy, reason: formatCoordinationRuntimeError(error) };
      console.error(args.json ? JSON.stringify(payload) : `autopilot-agent-run D65 subscription recovery paused: ${payload.reason}`);
      return 40;
    }
    if (args.mode === 'run' && error instanceof AutopilotAgentRunError) {
      const payload = {
        status: 'failed',
        failure_class: error.failureClass,
        reason: error.details.reason,
        status_output: error.details.statusOutput,
        receipt_output: error.details.receiptOutput,
        prompt_snapshot: error.details.promptSnapshotPath,
        audit_output: error.details.auditOutput,
        audit_classification: error.details.auditClassification,
        execution_commit_output: error.details.executionCommitOutput,
        execution_commit_sha: error.details.executionCommitSha,
      };
      if (args.json) {
        console.error(JSON.stringify(payload));
      } else {
        console.error(
          `autopilot-agent-run failed class=${error.failureClass} reason=${error.details.reason}`,
        );
      }
      return EXIT_BY_FAILURE_CLASS[error.failureClass];
    }
    console.error(
      `autopilot-agent-run failed unexpected: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    return 1;
  }
}

function parseArgs(argv: readonly string[]): CliArgs {
  if (argv[0] === 'recover-d65-subscription') return parseSubscriptionRecoveryArgs(argv.slice(1));
  let dryRun = false;
  let json = false;
  let piExecutable: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--pi-executable') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--pi-executable requires a value');
      piExecutable = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('autopilot-agent-run help');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error(`expected exactly one <unit-spec.json>, got ${String(positional.length)}`);
  }
  const specPath = positional[0];
  if (specPath === undefined) throw new Error('expected <unit-spec.json>');
  return { mode: 'run', specPath, dryRun, json, ...(piExecutable === undefined ? {} : { piExecutable }) };
}

function parseSubscriptionRecoveryArgs(argv: readonly string[]): SubscriptionRecoveryCliArgs {
  let continuationPath: string | undefined;
  let probePath: string | undefined;
  let continuationSequence: number | undefined;
  let json = false;
  const boundFiles: RecoveryBoundFile[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help' || arg === '-h') throw new Error('autopilot-agent-run help');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--continuation') continuationPath = value;
    else if (arg === '--probe') probePath = value;
    else if (arg === '--continuation-sequence') {
      if (!/^\d+$/u.test(value)) throw new Error('--continuation-sequence requires a positive decimal integer');
      continuationSequence = Number(value);
      if (!Number.isSafeInteger(continuationSequence) || continuationSequence < 1) throw new Error('--continuation-sequence requires a positive safe integer');
    } else if (arg === '--bound') {
      const path = argv[index + 2];
      if (path === undefined || path.startsWith('--')) throw new Error('--bound requires <repo-relative-ref> <absolute-file>');
      boundFiles.push(Object.freeze({ ref: value, path }));
      index += 1;
    } else throw new Error(`unknown recovery option ${arg}`);
    index += 1;
  }
  if (continuationPath === undefined || probePath === undefined || continuationSequence === undefined) throw new Error('recover-d65-subscription requires --continuation, --probe, and --continuation-sequence');
  for (const path of [continuationPath, probePath, ...boundFiles.map((file) => file.path)]) if (!isAbsolute(path)) throw new Error('subscription recovery authority file paths must be absolute');
  if (boundFiles.length === 0 || new Set(boundFiles.map((file) => file.ref)).size !== boundFiles.length) throw new Error('recover-d65-subscription requires unique --bound refs');
  return Object.freeze({ mode: 'recover-d65-subscription', continuationPath, probePath, continuationSequence, boundFiles: Object.freeze(boundFiles), json });
}

function usage(): string {
  return [
    'usage: autopilot-agent-run [--dry-run] [--json] [--pi-executable <path>] <unit-spec.json>',
    '       autopilot-agent-run recover-d65-subscription --continuation <absolute-json> --probe <absolute-json> --continuation-sequence <n> --bound <repo-relative-ref> <absolute-file> [--bound <ref> <file> ...] [--json]',
    '',
  ].join('\n');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  const exitCode = await runAutopilotAgentCli(process.argv.slice(2));
  process.exit(exitCode);
}
