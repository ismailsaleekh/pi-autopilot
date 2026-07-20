import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { platform } from 'node:os';
import { isAbsolute } from 'node:path';

export const GIT_QUERY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const GIT_MUTATION_DIAGNOSTIC_BYTES = 256 * 1024;
export const GIT_DEFAULT_QUERY_TIMEOUT_MS = 30_000;
export const GIT_DEFAULT_MUTATION_TIMEOUT_MS = 120_000;
export const GIT_TERMINATION_GRACE_MS = 1_000;

// D58 streaming-query frozen constants.
export const GIT_STREAM_WIRE_MAX_BYTES = 268_435_456;
export const GIT_STREAM_ENTRY_MAX = 500_000;
export const GIT_STREAM_PATH_MAX_BYTES = 134_217_728;
export const GIT_STREAM_RECORD_MAX_BYTES = 1_048_576;
export const GIT_STREAM_OBJECT_TOTAL_MAX_BYTES = Number.MAX_SAFE_INTEGER;
export const GIT_STREAM_DIAGNOSTIC_MAX_BYTES = 262_144;
export const GIT_STREAM_TIMEOUT_MS = 30_000;
export const GIT_FORCE_KILL_WAIT_MS = 2_000;
export const GIT_PIPE_DRAIN_WAIT_MS = 1_000;
export const GIT_STREAM_TOTAL_DEADLINE_MS = 35_000;
export const GIT_STREAM_STDERR_RETAIN_PREFIX = 131_072;
export const GIT_STREAM_STDERR_RETAIN_SUFFIX = 131_072;

export interface GitProcessEnv {
  readonly [key: string]: string | undefined;
}

export type GitQueryDescriptor =
  | { readonly kind: 'head' }
  | { readonly kind: 'show-toplevel' }
  | { readonly kind: 'git-common-dir' }
  | { readonly kind: 'git-path'; readonly name: string }
  | { readonly kind: 'current-branch' }
  | { readonly kind: 'resolve-revision'; readonly revision: string; readonly verify?: boolean }
  | { readonly kind: 'resolve-commit'; readonly revision: string }
  | { readonly kind: 'resolve-tree'; readonly revision: string }
  | { readonly kind: 'ref-exists'; readonly ref: string }
  | { readonly kind: 'commit-exists'; readonly revision: string }
  | { readonly kind: 'is-ancestor'; readonly ancestor: string; readonly descendant: string }
  | { readonly kind: 'merge-base'; readonly left: string; readonly right: string }
  | { readonly kind: 'merge-tree-analysis'; readonly base: string; readonly left: string; readonly right: string }
  | { readonly kind: 'status-porcelain'; readonly includeIgnored?: boolean }
  | { readonly kind: 'diff-paths'; readonly from: string; readonly to: string; readonly paths?: readonly string[]; readonly noRenames?: boolean; readonly filter?: string }
  | { readonly kind: 'diff-text'; readonly from: string; readonly to: string; readonly path: string; readonly unifiedLines: number }
  | { readonly kind: 'staged-clean' }
  | { readonly kind: 'worktree-list'; readonly nul?: boolean }
  | { readonly kind: 'config-get'; readonly key: string; readonly file?: string }
  | { readonly kind: 'config-bool'; readonly key: string }
  | { readonly kind: 'config-regexp'; readonly file: string; readonly pattern: string }
  | { readonly kind: 'ls-files-state'; readonly paths: readonly string[] }
  | { readonly kind: 'ls-tree-path'; readonly revision: string; readonly path: string }
  | { readonly kind: 'ls-tree-recursive'; readonly revision: string; readonly includeSize: boolean }
  | { readonly kind: 'ls-tree-recursive-stream'; readonly commit: string }
  | { readonly kind: 'show-file'; readonly revision: string; readonly path: string; readonly allowAbsent?: boolean }
  | { readonly kind: 'rev-list-parents'; readonly revision: string }
  | { readonly kind: 'rev-list-range'; readonly fromExclusive: string; readonly toInclusive: string; readonly reverse?: boolean }
  | { readonly kind: 'last-commit-for-path'; readonly fromExclusive: string; readonly toInclusive: string; readonly path: string }
  | { readonly kind: 'sparse-checkout-help' };

export type GitMutationDescriptor =
  | { readonly kind: 'worktree-add'; readonly path: string; readonly branch: string; readonly startPoint: string | null; readonly createBranch: boolean; readonly noCheckout: boolean }
  | { readonly kind: 'worktree-remove'; readonly path: string }
  | { readonly kind: 'worktree-prune' }
  | { readonly kind: 'sparse-checkout-set'; readonly patterns: readonly string[] }
  | { readonly kind: 'sparse-checkout-add'; readonly patterns: readonly string[] }
  | { readonly kind: 'checkout-force'; readonly branch: string }
  | { readonly kind: 'stage-paths'; readonly paths: readonly string[]; readonly sparse?: boolean; readonly force?: boolean }
  | { readonly kind: 'commit'; readonly message: string }
  | { readonly kind: 'merge'; readonly target: string; readonly mode: 'no-ff' | 'ff-only'; readonly message?: string }
  | { readonly kind: 'merge-abort' }
  | { readonly kind: 'reset-hard'; readonly target: string }
  | { readonly kind: 'update-ref-create'; readonly ref: string; readonly target: string; readonly expectedOld: string }
  | { readonly kind: 'update-ref-delete'; readonly ref: string; readonly expectedOld: string };

export interface GitQueryResult {
  readonly descriptor: GitQueryDescriptor['kind'];
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly negative: boolean;
}

export type GitEffectUnknownReason =
  | 'timeout'
  | 'signal'
  | 'spawn-failure'
  | 'stdin-failure'
  | 'stdout-failure'
  | 'stderr-failure'
  | 'diagnostic-truncation'
  | 'report-loss';

export interface GitMutationReportedResult {
  readonly kind: 'reported';
  readonly descriptor: GitMutationDescriptor['kind'];
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly diagnostic: string;
}

export interface GitMutationEffectUnknownResult {
  readonly kind: 'effect-unknown';
  readonly descriptor: GitMutationDescriptor['kind'];
  readonly reason: GitEffectUnknownReason;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly diagnostic: string;
  readonly droppedBytes: number;
}

export type GitMutationResult = GitMutationReportedResult | GitMutationEffectUnknownResult;

export class GitProcessDescriptorError extends Error {
  override readonly name = 'GitProcessDescriptorError';

  constructor(message: string) {
    super(`GitProcessDescriptorError: ${message}`);
  }
}

export class GitQueryError extends Error {
  override readonly name = 'GitQueryError';
  readonly code: 'invalid-descriptor' | 'spawn-failure' | 'timeout' | 'signal' | 'output-overflow' | 'unexpected-exit';
  readonly descriptor: GitQueryDescriptor['kind'];
  readonly diagnostic: string;

  constructor(code: GitQueryError['code'], descriptor: GitQueryDescriptor['kind'], message: string, diagnostic = '') {
    super(`GitQueryError [${code}/${descriptor}]: ${message}`);
    this.code = code;
    this.descriptor = descriptor;
    this.diagnostic = diagnostic;
  }
}

interface QueryCommand {
  readonly argv: readonly string[];
  readonly acceptedExitCodes: readonly number[];
  readonly negativeExitCodes: readonly number[];
}

interface MutationCommand {
  readonly argv: readonly string[];
  readonly input: Uint8Array | null;
}

function atom(value: string, label: string, allowLeadingDash = false): string {
  if (value.length === 0 || value.includes('\0')) throw new GitProcessDescriptorError(`${label} must be non-empty and NUL-free`);
  if (!allowLeadingDash && value.startsWith('-')) throw new GitProcessDescriptorError(`${label} must not be option-shaped`);
  return value;
}

function atoms(values: readonly string[], label: string, allowLeadingDash = false): readonly string[] {
  return values.map((value) => atom(value, label, allowLeadingDash));
}

function absolutePath(value: string, label: string): string {
  atom(value, label, true);
  if (!isAbsolute(value)) throw new GitProcessDescriptorError(`${label} must be absolute`);
  return value;
}

function repoPath(value: string, label: string): string {
  atom(value, label, true);
  const normalized = value.replace(/\\/gu, '/');
  if (isAbsolute(value) || normalized.split('/').some((segment) => segment === '..' || segment === '')) throw new GitProcessDescriptorError(`${label} must be bounded repository-relative authority`);
  return value;
}

function autopilotRef(value: string): string {
  atom(value, 'Autopilot ref');
  if (!value.startsWith('refs/heads/autopilot/')) throw new GitProcessDescriptorError('mutating ref must be under refs/heads/autopilot/');
  return value;
}

function unifiedLines(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new GitProcessDescriptorError('unified line count must be a bounded non-negative integer');
  return value;
}

function streamingCommitOid(value: string): string {
  atom(value, 'streaming tree commit');
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new GitProcessDescriptorError('streaming tree commit must be exactly 40 lowercase-hex object id sealed from HEAD^{commit}');
  return value;
}

function queryCommand(descriptor: GitQueryDescriptor): QueryCommand {
  switch (descriptor.kind) {
    case 'head': return { argv: ['rev-parse', 'HEAD'], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'show-toplevel': return { argv: ['rev-parse', '--show-toplevel'], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'git-common-dir': return { argv: ['rev-parse', '--git-common-dir'], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'git-path': return { argv: ['rev-parse', '--git-path', atom(descriptor.name, 'Git path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'current-branch': return { argv: ['symbolic-ref', '--quiet', '--short', 'HEAD'], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'resolve-revision': return { argv: ['rev-parse', ...(descriptor.verify === true ? ['--verify'] : []), atom(descriptor.revision, 'revision')], acceptedExitCodes: descriptor.verify === true ? [0, 1, 128] : [0], negativeExitCodes: descriptor.verify === true ? [1, 128] : [] };
    case 'resolve-commit': return { argv: ['rev-parse', '--verify', `${atom(descriptor.revision, 'commit revision')}^{commit}`], acceptedExitCodes: [0, 1, 128], negativeExitCodes: [1, 128] };
    case 'resolve-tree': return { argv: ['rev-parse', '--verify', `${atom(descriptor.revision, 'tree revision')}^{tree}`], acceptedExitCodes: [0, 1, 128], negativeExitCodes: [1, 128] };
    case 'ref-exists': return { argv: ['show-ref', '--verify', '--quiet', atom(descriptor.ref, 'ref')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'commit-exists': return { argv: ['cat-file', '-e', `${atom(descriptor.revision, 'commit revision')}^{commit}`], acceptedExitCodes: [0, 1, 128], negativeExitCodes: [1, 128] };
    case 'is-ancestor': return { argv: ['merge-base', '--is-ancestor', atom(descriptor.ancestor, 'ancestor'), atom(descriptor.descendant, 'descendant')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'merge-base': return { argv: ['merge-base', atom(descriptor.left, 'left commit'), atom(descriptor.right, 'right commit')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'merge-tree-analysis': return { argv: ['merge-tree', atom(descriptor.base, 'merge base'), atom(descriptor.left, 'left commit'), atom(descriptor.right, 'right commit')], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'status-porcelain': return { argv: ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(descriptor.includeIgnored === true ? ['--ignored=traditional', '--ignore-submodules=none'] : [])], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'diff-paths': {
      if (descriptor.filter !== undefined && !/^[ACDMRTUXB*]+$/u.test(descriptor.filter)) throw new GitProcessDescriptorError('diff filter is invalid');
      return { argv: ['diff', '--name-only', ...(descriptor.noRenames === true ? ['--no-renames'] : []), ...(descriptor.filter === undefined ? [] : [`--diff-filter=${descriptor.filter}`]), '-z', atom(descriptor.from, 'from revision'), atom(descriptor.to, 'to revision'), '--', ...atoms(descriptor.paths ?? [], 'diff path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    }
    case 'diff-text': return { argv: ['diff', '--no-ext-diff', '--no-color', `--unified=${String(unifiedLines(descriptor.unifiedLines))}`, atom(descriptor.from, 'from revision'), atom(descriptor.to, 'to revision'), '--', atom(descriptor.path, 'diff path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'staged-clean': return { argv: ['diff', '--cached', '--quiet', '--exit-code'], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'worktree-list': return { argv: ['worktree', 'list', '--porcelain', ...(descriptor.nul === true ? ['-z'] : [])], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'config-get': return { argv: ['config', ...(descriptor.file === undefined ? [] : ['--file', atom(descriptor.file, 'config file', true)]), '--get', atom(descriptor.key, 'config key')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'config-bool': return { argv: ['config', '--bool', atom(descriptor.key, 'config key')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'config-regexp': return { argv: ['config', '-z', '--file', atom(descriptor.file, 'config file', true), '--get-regexp', atom(descriptor.pattern, 'config pattern', true)], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'ls-files-state': return { argv: ['ls-files', '-t', '-z', '--', ...atoms(descriptor.paths, 'tracked path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'ls-tree-path': return { argv: ['ls-tree', '-z', atom(descriptor.revision, 'tree revision'), '--', atom(descriptor.path, 'tree path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'ls-tree-recursive': return { argv: ['ls-tree', '-r', ...(descriptor.includeSize ? ['-l'] : []), '--full-tree', '-z', atom(descriptor.revision, 'tree revision')], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'ls-tree-recursive-stream': return { argv: ['ls-tree', '-r', '-l', '--full-tree', '-z', streamingCommitOid(descriptor.commit)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'show-file': return { argv: ['show', `${atom(descriptor.revision, 'show revision')}:${atom(descriptor.path, 'show path', true)}`], acceptedExitCodes: descriptor.allowAbsent === true ? [0, 128] : [0], negativeExitCodes: descriptor.allowAbsent === true ? [128] : [] };
    case 'rev-list-parents': return { argv: ['rev-list', '--parents', '-n', '1', atom(descriptor.revision, 'revision')], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'rev-list-range': return { argv: ['rev-list', ...(descriptor.reverse === true ? ['--reverse'] : []), `${atom(descriptor.fromExclusive, 'range start')}..${atom(descriptor.toInclusive, 'range end')}`], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'last-commit-for-path': return { argv: ['log', '-1', '--format=%H', `${atom(descriptor.fromExclusive, 'range start')}..${atom(descriptor.toInclusive, 'range end')}`, '--', atom(descriptor.path, 'log path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'sparse-checkout-help': return { argv: ['sparse-checkout', '-h'], acceptedExitCodes: [0, 129], negativeExitCodes: [] };
  }
}

function patternsInput(patterns: readonly string[]): Uint8Array {
  if (patterns.length === 0) throw new GitProcessDescriptorError('sparse-checkout mutation requires non-empty patterns');
  for (const pattern of patterns) {
    atom(pattern, 'sparse pattern', true);
    if (pattern.includes('\n') || pattern.includes('\r')) throw new GitProcessDescriptorError('sparse pattern must be one physical input line');
  }
  return new TextEncoder().encode(`${patterns.join('\n')}\n`);
}

function mutationCommand(descriptor: GitMutationDescriptor): MutationCommand {
  switch (descriptor.kind) {
    case 'worktree-add': {
      const common = ['worktree', 'add', ...(descriptor.noCheckout ? ['--no-checkout'] : [])];
      if (descriptor.createBranch) {
        if (descriptor.startPoint === null) throw new GitProcessDescriptorError('new worktree branch requires a start point');
        return { argv: [...common, '-b', atom(descriptor.branch, 'branch'), '--', absolutePath(descriptor.path, 'worktree path'), atom(descriptor.startPoint, 'start point')], input: null };
      }
      return { argv: [...common, '--', absolutePath(descriptor.path, 'worktree path'), atom(descriptor.branch, 'branch')], input: null };
    }
    case 'worktree-remove': return { argv: ['worktree', 'remove', '--', absolutePath(descriptor.path, 'worktree path')], input: null };
    case 'worktree-prune': return { argv: ['worktree', 'prune', '--expire', 'now'], input: null };
    case 'sparse-checkout-set': return { argv: ['sparse-checkout', 'set', '--no-cone', '--skip-checks', '--stdin'], input: patternsInput(descriptor.patterns) };
    case 'sparse-checkout-add': return { argv: ['sparse-checkout', 'add', '--skip-checks', '--stdin'], input: patternsInput(descriptor.patterns) };
    case 'checkout-force': return { argv: ['checkout', '--force', atom(descriptor.branch, 'branch')], input: null };
    case 'stage-paths': {
      if (descriptor.paths.length === 0) throw new GitProcessDescriptorError('stage mutation requires at least one path');
      return { argv: ['--literal-pathspecs', 'add', ...(descriptor.sparse === true ? ['--sparse'] : []), ...(descriptor.force === true ? ['-f'] : []), '-A', '--', ...descriptor.paths.map((path) => repoPath(path, 'stage path'))], input: null };
    }
    case 'commit': return { argv: ['commit', '--quiet', '--no-verify', '-m', atom(descriptor.message, 'commit message', true)], input: null };
    case 'merge': return { argv: ['merge', descriptor.mode === 'ff-only' ? '--ff-only' : '--no-ff', ...(descriptor.mode === 'no-ff' ? ['--no-edit'] : []), ...(descriptor.message === undefined ? [] : ['-m', atom(descriptor.message, 'merge message', true)]), atom(descriptor.target, 'merge target')], input: null };
    case 'merge-abort': return { argv: ['merge', '--abort'], input: null };
    case 'reset-hard': return { argv: ['reset', '--hard', atom(descriptor.target, 'reset target')], input: null };
    case 'update-ref-create': return { argv: ['update-ref', autopilotRef(descriptor.ref), atom(descriptor.target, 'target'), atom(descriptor.expectedOld, 'expected old object')], input: null };
    case 'update-ref-delete': return { argv: ['update-ref', '-d', autopilotRef(descriptor.ref), atom(descriptor.expectedOld, 'expected old object')], input: null };
  }
}

export function gitQueryArgv(descriptor: GitQueryDescriptor): readonly string[] {
  return Object.freeze([...queryCommand(descriptor).argv]);
}

export function gitMutationArgv(descriptor: GitMutationDescriptor): readonly string[] {
  return Object.freeze([...mutationCommand(descriptor).argv]);
}

function boundedDiagnostic(stdout: Uint8Array, stderr: Uint8Array, droppedBytes = 0): string {
  let remaining = GIT_MUTATION_DIAGNOSTIC_BYTES;
  const retain = (value: Uint8Array): Uint8Array => {
    const bytes = value.subarray(0, remaining);
    remaining -= bytes.byteLength;
    return bytes;
  };
  const retainedStderr = retain(stderr);
  const retainedStdout = retain(stdout);
  const omitted = droppedBytes + stderr.byteLength - retainedStderr.byteLength + stdout.byteLength - retainedStdout.byteLength;
  const decode = (value: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(value);
  const raw = [decode(retainedStderr).trim(), decode(retainedStdout).trim()].filter((value) => value.length > 0).join('\n');
  const redacted = raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1<redacted>@')
    .replace(/\b(capability|credential|password|token|secret)([=: ]+)[^\s]+/giu, '$1$2<redacted>')
    .replace(/\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]+\b/gu, '<redacted>');
  return omitted === 0 ? redacted : `${redacted}${redacted.length === 0 ? '' : '\n'}[diagnostic truncated; dropped_bytes=${String(omitted)}]`;
}

function queryErrorCode(error: Error): GitQueryError['code'] {
  if ('code' in error && error.code === 'ETIMEDOUT') return 'timeout';
  if ('code' in error && error.code === 'ENOBUFS') return 'output-overflow';
  return 'spawn-failure';
}

export function gitQueryText(input: {
  readonly descriptor: GitQueryDescriptor;
  readonly cwd: string;
  readonly env?: GitProcessEnv;
  readonly timeoutMs?: number;
}): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery(input).stdout);
}

export function gitQueryNulStrings(input: {
  readonly descriptor: GitQueryDescriptor;
  readonly cwd: string;
  readonly env?: GitProcessEnv;
  readonly timeoutMs?: number;
}): readonly string[] {
  const bytes = runGitQuery(input).stdout;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const values: string[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const delimiter = bytes.indexOf(0, cursor);
    if (delimiter < 0) throw new GitQueryError('unexpected-exit', input.descriptor.kind, 'NUL-delimited Git query ended with an unterminated record');
    if (delimiter > cursor) values.push(decoder.decode(bytes.subarray(cursor, delimiter)));
    cursor = delimiter + 1;
  }
  return Object.freeze(values);
}

export function runGitQuery(input: {
  readonly descriptor: GitQueryDescriptor;
  readonly cwd: string;
  readonly env?: GitProcessEnv;
  readonly timeoutMs?: number;
}): GitQueryResult {
  let command: QueryCommand;
  try { command = queryCommand(input.descriptor); }
  catch (error) {
    if (error instanceof GitProcessDescriptorError) throw new GitQueryError('invalid-descriptor', input.descriptor.kind, error.message);
    throw error;
  }
  const result = spawnSync('git', command.argv, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: input.timeoutMs ?? GIT_DEFAULT_QUERY_TIMEOUT_MS,
    // spawnSync applies this independently to stdout/stderr. The explicit
    // combined check below is the authoritative retained-output ceiling.
    maxBuffer: GIT_QUERY_MAX_OUTPUT_BYTES + 1,
  });
  const stdout = new Uint8Array(result.stdout);
  const stderr = new Uint8Array(result.stderr);
  if (stdout.byteLength + stderr.byteLength > GIT_QUERY_MAX_OUTPUT_BYTES) throw new GitQueryError('output-overflow', input.descriptor.kind, `Git query exceeded the ${String(GIT_QUERY_MAX_OUTPUT_BYTES)}-byte retained output ceiling`, boundedDiagnostic(stdout, stderr));
  if (result.error !== undefined) {
    const code = queryErrorCode(result.error);
    throw new GitQueryError(code, input.descriptor.kind, result.error.message, boundedDiagnostic(stdout, stderr));
  }
  if (result.signal !== null) throw new GitQueryError('signal', input.descriptor.kind, `Git query ended by signal ${result.signal}`, boundedDiagnostic(stdout, stderr));
  const exitCode = result.status ?? -1;
  if (!command.acceptedExitCodes.includes(exitCode)) throw new GitQueryError('unexpected-exit', input.descriptor.kind, `Git query exited with status ${String(exitCode)}`, boundedDiagnostic(stdout, stderr));
  return Object.freeze({ descriptor: input.descriptor.kind, exitCode, stdout, stderr, negative: command.negativeExitCodes.includes(exitCode) });
}

interface CapturedStream {
  readonly chunks: Uint8Array[];
  retainedBytes: number;
  droppedBytes: number;
}

function captureChunk(stream: CapturedStream, chunk: Uint8Array): void {
  const remaining = Math.max(0, GIT_MUTATION_DIAGNOSTIC_BYTES - stream.retainedBytes);
  const retained = chunk.subarray(0, remaining);
  if (retained.length > 0) {
    stream.chunks.push(new Uint8Array(retained));
    stream.retainedBytes += retained.length;
  }
  stream.droppedBytes += chunk.length - retained.length;
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function gitProcessTreeTerminationKind(platformName: string = platform()): 'windows-task-tree' | 'posix-process-group' {
  return platformName === 'win32' ? 'windows-task-tree' : 'posix-process-group';
}

async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined) return;
  if (gitProcessTreeTerminationKind() === 'windows-task-tree') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', shell: false });
      killer.once('close', () => resolvePromise());
      killer.once('error', () => resolvePromise());
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { return; } }
  await wait(GIT_TERMINATION_GRACE_MS);
  // The group can outlive its leader; always attempt the hard group kill after
  // grace rather than trusting only the direct child's exitCode.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { if (child.exitCode === null) try { child.kill('SIGKILL'); } catch { return; } }
}

export async function runGitMutation(input: {
  readonly descriptor: GitMutationDescriptor;
  readonly cwd: string;
  readonly env?: GitProcessEnv;
  readonly timeoutMs?: number;
}): Promise<GitMutationResult> {
  const command = mutationCommand(input.descriptor);
  return await new Promise<GitMutationResult>((resolvePromise) => {
    const stdout: CapturedStream = { chunks: [], retainedBytes: 0, droppedBytes: 0 };
    const stderr: CapturedStream = { chunks: [], retainedBytes: 0, droppedBytes: 0 };
    let unknownReason: GitEffectUnknownReason | null = null;
    let settled = false;
    const child = spawn('git', command.argv, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: platform() !== 'win32',
    });
    const timeout = setTimeout(() => {
      unknownReason = 'timeout';
      void terminateProcessTree(child);
    }, input.timeoutMs ?? GIT_DEFAULT_MUTATION_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Uint8Array) => captureChunk(stdout, chunk));
    child.stderr.on('data', (chunk: Uint8Array) => captureChunk(stderr, chunk));
    child.stdout.on('error', () => { unknownReason = 'stdout-failure'; void terminateProcessTree(child); });
    child.stderr.on('error', () => { unknownReason = 'stderr-failure'; void terminateProcessTree(child); });
    child.stdin.on('error', () => { unknownReason = 'stdin-failure'; void terminateProcessTree(child); });
    child.on('error', () => { unknownReason = 'spawn-failure'; });
    if (command.input === null) child.stdin.end();
    else child.stdin.write(new TextDecoder().decode(command.input), (error) => {
      if (error !== null && error !== undefined) {
        unknownReason = 'stdin-failure';
        void terminateProcessTree(child);
      }
      child.stdin.end();
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdoutBytes = concatenate(stdout.chunks, stdout.retainedBytes);
      const stderrBytes = concatenate(stderr.chunks, stderr.retainedBytes);
      const streamDroppedBytes = stdout.droppedBytes + stderr.droppedBytes;
      const diagnosticDroppedBytes = Math.max(0, stdoutBytes.byteLength + stderrBytes.byteLength - GIT_MUTATION_DIAGNOSTIC_BYTES);
      const droppedBytes = streamDroppedBytes + diagnosticDroppedBytes;
      const reason = unknownReason
        ?? (signal === null ? null : 'signal')
        ?? (code === null ? 'report-loss' : null)
        ?? (droppedBytes > 0 ? 'diagnostic-truncation' : null);
      if (reason !== null || droppedBytes > 0) {
        resolvePromise({ kind: 'effect-unknown', descriptor: input.descriptor.kind, reason: reason ?? 'diagnostic-truncation', exitCode: code, signal, diagnostic: boundedDiagnostic(stdoutBytes, stderrBytes, streamDroppedBytes), droppedBytes });
        return;
      }
      resolvePromise({ kind: 'reported', descriptor: input.descriptor.kind, exitCode: code ?? -1, stdout: stdoutBytes, stderr: stderrBytes, diagnostic: boundedDiagnostic(stdoutBytes, stderrBytes) });
    });
  });
}

// === D58 streaming recursive ls-tree query ===

export type GitLsTreeStreamObjectType = 'blob' | 'tree' | 'commit';
export type GitLsTreeStreamMode = '100644' | '100755' | '120000' | '160000' | '040000';
export type GitStreamTerminalState = 'exited' | 'spawn-failed' | 'grace-terminated' | 'force-terminated' | 'spawn-unconfirmed' | 'containment-failed';

export type GitStreamingQueryErrorCode =
  | 'invalid-descriptor'
  | 'invalid-ls-tree-output'
  | 'git-stream-wire-overflow'
  | 'git-stream-record-overflow'
  | 'git-stream-entry-overflow'
  | 'git-stream-path-overflow'
  | 'tracked-tree-total-overflow'
  | 'stream-diagnostic-overflow'
  | 'git-process-containment-failed';

export interface GitLsTreeStreamRecord {
  readonly mode: GitLsTreeStreamMode;
  readonly object_type: GitLsTreeStreamObjectType;
  readonly oid: string;
  readonly size: number | null;
  readonly path_bytes: Uint8Array;
}

export interface GitStreamingQuerySummary {
  readonly descriptor: 'ls-tree-recursive-stream';
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly wire_bytes: number;
  readonly entry_count: number;
  readonly path_bytes: number;
  readonly object_total_bytes: number;
  readonly stderr_bytes: number;
  readonly stderr_sha256: string | null;
  readonly terminal_state: GitStreamTerminalState;
}

export class GitStreamingQueryError extends Error {
  override readonly name = 'GitStreamingQueryError';
  readonly code: GitStreamingQueryErrorCode;
  readonly terminalState: GitStreamTerminalState | null;
  readonly diagnostic: string;
  readonly rootPid: number | null;

  constructor(code: GitStreamingQueryErrorCode, message: string, options: { diagnostic?: string; terminalState?: GitStreamTerminalState | null; rootPid?: number | null } = {}) {
    super(`GitStreamingQueryError [${code}]: ${message}`);
    this.code = code;
    this.terminalState = options.terminalState ?? null;
    this.diagnostic = options.diagnostic ?? '';
    this.rootPid = options.rootPid ?? null;
  }
}

function streamingOverflow(code: GitStreamingQueryErrorCode, message: string): GitStreamingQueryError {
  return new GitStreamingQueryError(code, message);
}

/**
 * Resolve a finite per-stream containment ceiling. The frozen constant is the
 * production ceiling and the default. A caller-supplied override (used by the
 * lowest-layer containment tests, mirroring the injectable `clock` seam) may
 * only make the bound STRICTER: it must be a positive safe integer no greater
 * than the frozen ceiling. A non-integer, non-positive, or loosening override
 * fails loudly as an invalid descriptor so the seam can never weaken the
 * contractual containment ceiling.
 */
function resolveStreamCap(override: number | undefined, frozenCeiling: number, label: string): number {
  if (override === undefined) return frozenCeiling;
  if (!Number.isSafeInteger(override) || override < 1) throw new GitStreamingQueryError('invalid-descriptor', `git ls-tree ${label} ceiling override must be a positive safe integer`);
  if (override > frozenCeiling) throw new GitStreamingQueryError('invalid-descriptor', `git ls-tree ${label} ceiling override may only tighten the frozen ${String(frozenCeiling)} ceiling`);
  return override;
}

export function checkedAdd(augend: number, addend: number, overflowCode: string): number {
  if (!Number.isSafeInteger(augend) || !Number.isSafeInteger(addend) || augend < 0 || addend < 0) {
    throw streamingOverflow(overflowCode as GitStreamingQueryErrorCode, `checked addition rejected a non-safe non-negative operand (${String(augend)} + ${String(addend)})`);
  }
  const result = augend + addend;
  if (!Number.isSafeInteger(result)) throw streamingOverflow(overflowCode as GitStreamingQueryErrorCode, `checked addition overflowed the safe-integer range (${String(augend)} + ${String(addend)})`);
  return result;
}

export function checkedMultiply(multiplicand: number, multiplier: number, overflowCode: string): number {
  if (!Number.isSafeInteger(multiplicand) || !Number.isSafeInteger(multiplier) || multiplicand < 0 || multiplier < 0) {
    throw streamingOverflow(overflowCode as GitStreamingQueryErrorCode, `checked multiplication rejected a non-safe non-negative operand (${String(multiplicand)} * ${String(multiplier)})`);
  }
  if (multiplicand !== 0 && multiplier > Number.MAX_SAFE_INTEGER / multiplicand) {
    throw streamingOverflow(overflowCode as GitStreamingQueryErrorCode, `checked multiplication overflowed the safe-integer range (${String(multiplicand)} * ${String(multiplier)})`);
  }
  return multiplicand * multiplier;
}

export function checkedCeilMultiply(value: number, numerator: number, denominator: number, overflowCode: string): number {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw streamingOverflow(overflowCode as GitStreamingQueryErrorCode, 'checked ceil-multiply requires safe-integer operands');
  }
  if (value < 0 || numerator < 0 || denominator <= 0) {
    throw streamingOverflow(overflowCode as GitStreamingQueryErrorCode, 'checked ceil-multiply requires non-negative value/numerator and positive denominator');
  }
  const scaled = checkedMultiply(value, numerator, overflowCode);
  return Math.ceil(scaled / denominator);
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function strictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw streamingOverflow('invalid-ls-tree-output', `git ls-tree bytes were not valid UTF-8: ${errorMessage(error)}`);
  }
}

function decodeStreamPath(raw: Uint8Array): Uint8Array {
  // Paths retain their decoded bytes and are never normalized into a different identity.
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index];
    if (byte === 0x2f /* / */) continue;
    if (byte === 0x5c /* backslash */) throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree path contained a backslash');
  }
  if (raw.length === 0) throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree path was empty');
  const segments = bytesToUtf8(raw).split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree path contained an empty, dot, or dot-dot segment');
  }
  return raw;
}

function parseStreamingRecord(raw: Uint8Array): GitLsTreeStreamRecord {
  if (raw.length === 0) throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree emitted an empty record');
  const tabIndex = raw.indexOf(9 /* TAB */);
  if (tabIndex < 0) throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree record did not contain a path separator');
  const meta = strictUtf8(raw.subarray(0, tabIndex)).trim().split(/\s+/u);
  if (meta.length !== 4) throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree metadata did not contain exactly mode, type, object id, and size');
  const [mode, type, oid, sizeToken] = meta as [string, string, string, string];
  const pathBytes = decodeStreamPath(raw.subarray(tabIndex + 1));
  if (!/^[0-9a-f]{40}$/u.test(oid)) throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree object id was not exactly 40 lowercase hex');
  if (mode === '100644' || mode === '100755' || mode === '120000') {
    if (type !== 'blob') throw streamingOverflow('invalid-ls-tree-output', `git ls-tree mode ${mode} requires object type blob`);
    if (!/^\d+$/u.test(sizeToken)) throw streamingOverflow('invalid-ls-tree-output', `git ls-tree blob size was not decimal (${sizeToken})`);
    if (!Number.isSafeInteger(Number(sizeToken))) throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree blob size exceeded the safe-integer range');
    return Object.freeze({ mode, object_type: 'blob', oid, size: Number(sizeToken), path_bytes: pathBytes });
  }
  if (mode === '160000') {
    if (type !== 'commit') throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree mode 160000 requires object type commit');
    if (sizeToken !== '-') throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree commit (gitlink) size must be a dash');
    return Object.freeze({ mode: '160000', object_type: 'commit', oid, size: null, path_bytes: pathBytes });
  }
  if (mode === '040000') {
    if (type !== 'tree') throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree mode 040000 requires object type tree');
    if (sizeToken !== '-') throw streamingOverflow('invalid-ls-tree-output', 'git ls-tree tree size must be a dash');
    return Object.freeze({ mode: '040000', object_type: 'tree', oid, size: null, path_bytes: pathBytes });
  }
  throw streamingOverflow('invalid-ls-tree-output', `git ls-tree mode was not an accepted pair (${mode} ${type})`);
}

interface StderrAccumulator {
  total: number;
  hash: ReturnType<typeof createHash>;
  prefix: Uint8Array[];
  prefixBytes: number;
  suffix: Uint8Array;
}

function newStderrAccumulator(): StderrAccumulator {
  return { total: 0, hash: createHash('sha256'), prefix: [], prefixBytes: 0, suffix: new Uint8Array(0) };
}

function feedStderr(acc: StderrAccumulator, chunk: Uint8Array): void {
  acc.total = checkedAdd(acc.total, chunk.length, 'stream-diagnostic-overflow');
  acc.hash.update(chunk);
  const remainingPrefix = GIT_STREAM_STDERR_RETAIN_PREFIX - acc.prefixBytes;
  if (remainingPrefix > 0) {
    const taken = chunk.subarray(0, Math.min(chunk.length, remainingPrefix));
    if (taken.length > 0) {
      acc.prefix.push(new Uint8Array(taken));
      acc.prefixBytes += taken.length;
    }
  }
  // Maintain a rolling suffix window of the last GIT_STREAM_STDERR_RETAIN_SUFFIX bytes.
  const desired = Math.min(acc.total, GIT_STREAM_STDERR_RETAIN_SUFFIX);
  if (desired === 0) { acc.suffix = new Uint8Array(0); return; }
  const merged = new Uint8Array(desired);
  // If the existing suffix plus this chunk exceeds the window, keep the tail.
  const startInChunk = Math.max(0, chunk.length - desired);
  const carry = Math.min(acc.suffix.length, desired - (chunk.length - startInChunk));
  merged.set(acc.suffix.subarray(acc.suffix.length - carry), 0);
  merged.set(chunk.subarray(startInChunk), carry);
  acc.suffix = merged;
}

function finalizeStderr(acc: StderrAccumulator): { bytes: number; sha256: string | null; retained: Uint8Array; dropped: number } {
  const sha256 = acc.total === 0 ? null : `sha256:${acc.hash.digest('hex')}`;
  const prefixBytes = concatenate(acc.prefix, acc.prefixBytes);
  const retained = concatenate([prefixBytes, acc.suffix], prefixBytes.length + acc.suffix.length);
  const retainedCeiling = GIT_STREAM_STDERR_RETAIN_PREFIX + GIT_STREAM_STDERR_RETAIN_SUFFIX;
  const dropped = Math.max(0, acc.total - retainedCeiling);
  return { bytes: acc.total, sha256, retained, dropped };
}

function stderrDiagnostic(acc: StderrAccumulator, extra: string): string {
  const { bytes, sha256, retained, dropped } = finalizeStderr(acc);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(retained).trim();
  const parts = [decoded];
  if (extra.length > 0) parts.push(extra);
  parts.push(`stderr_total_bytes=${String(bytes)}`);
  parts.push(`stderr_sha256=${sha256 ?? '<none>'}`);
  if (dropped > 0) parts.push(`stderr_dropped_bytes=${String(dropped)}`);
  return parts.filter((value) => value.length > 0).join('\n');
}

/**
 * Streams `git ls-tree -r -l --full-tree -z <commit>` without retaining the complete
 * raw output. Each parsed record is delivered to `onRecord`. Read failure is loud
 * and never effect-unknown. The settle-once process lifecycle enforces the
 * absolute 35-second deadline and reports authority-critical
 * `git-process-containment-failed` for any unconfirmed reap.
 */
export async function runGitStreamingLsTree(input: {
  readonly commit: string;
  readonly cwd: string;
  readonly env?: GitProcessEnv;
  readonly onRecord: (record: GitLsTreeStreamRecord) => void;
  readonly clock?: () => number;
  // Tightening-only containment-ceiling overrides for the lowest-layer tests.
  // Each may only lower the frozen ceiling (see resolveStreamCap); production
  // callers omit them and get the frozen GIT_STREAM_* constants.
  readonly maxEntries?: number;
  readonly maxPathBytes?: number;
  readonly maxRecordBytes?: number;
}): Promise<GitStreamingQuerySummary> {
  const clock = input.clock ?? Date.now;
  const entryMax = resolveStreamCap(input.maxEntries, GIT_STREAM_ENTRY_MAX, 'entry');
  const pathMax = resolveStreamCap(input.maxPathBytes, GIT_STREAM_PATH_MAX_BYTES, 'path byte');
  const recordMax = resolveStreamCap(input.maxRecordBytes, GIT_STREAM_RECORD_MAX_BYTES, 'record byte');
  const start = clock();
  let command: QueryCommand;
  try {
    command = queryCommand({ kind: 'ls-tree-recursive-stream', commit: input.commit });
  } catch (error) {
    if (error instanceof GitProcessDescriptorError) throw new GitStreamingQueryError('invalid-descriptor', error.message);
    throw error;
  }
  const argv = command.argv;
  const remainingMs = (limit: number): number => {
    const elapsed = clock() - start;
    return Math.max(0, limit - elapsed);
  };
  return await new Promise<GitStreamingQuerySummary>((resolve, reject) => {
    let pid: number | null = null;
    let spawnEventConfirmed = false;
    let terminalState: GitStreamTerminalState | null = null;
    let closeObserved = false;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let wireBytes = 0;
    let entryCount = 0;
    let pathBytes = 0;
    let objectTotal = 0;
    let firstError: Error | null = null;
    const stderrAcc = newStderrAccumulator();

    const finish = (state: GitStreamTerminalState, summaryExitCode: number | null, summarySignal: string | null): void => {
      if (terminalState !== null) return;
      terminalState = state;
    };

    const failLoud = (error: GitStreamingQueryError): void => {
      if (firstError === null) firstError = error;
      beginTermination('grace-terminating');
    };

    const reapTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (terminalState === null) finish('containment-failed', null, null);
      onDeadline();
    }, remainingMs(GIT_STREAM_TOTAL_DEADLINE_MS));
    const execTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (terminalState !== null) return;
      if (!spawnEventConfirmed) {
        const rootPid = pid;
        finish('spawn-unconfirmed', null, null);
        firstError = new GitStreamingQueryError('git-process-containment-failed', 'git ls-tree spawn did not settle before the execution deadline', { terminalState: 'spawn-unconfirmed', rootPid });
      } else {
        beginTermination('grace-terminating');
      }
      onDeadline();
    }, remainingMs(GIT_STREAM_TIMEOUT_MS));

    const dispose = (): void => {
      clearTimeout(reapTimer);
      clearTimeout(execTimer);
    };

    const settle = (): void => {
      if (firstError !== null) { dispose(); reject(firstError); return; }
      const stderr = finalizeStderr(stderrAcc);
      if (stderr.bytes > GIT_STREAM_DIAGNOSTIC_MAX_BYTES) {
        dispose();
        reject(new GitStreamingQueryError('stream-diagnostic-overflow', `git ls-tree stderr exceeded the ${String(GIT_STREAM_DIAGNOSTIC_MAX_BYTES)}-byte diagnostic ceiling`, { diagnostic: stderrDiagnostic(stderrAcc, '') }));
        return;
      }
      if (stderr.bytes > 0) {
        dispose();
        reject(new GitStreamingQueryError('invalid-ls-tree-output', 'git ls-tree produced non-empty stderr; success requires empty stderr', { diagnostic: stderrDiagnostic(stderrAcc, '') }));
        return;
      }
      const state = terminalState ?? 'exited';
      dispose();
      resolve(Object.freeze({
        descriptor: 'ls-tree-recursive-stream',
        exit_code: lastExitCode,
        signal: lastSignal,
        wire_bytes: wireBytes,
        entry_count: entryCount,
        path_bytes: pathBytes,
        object_total_bytes: objectTotal,
        stderr_bytes: stderr.bytes,
        stderr_sha256: stderr.sha256,
        terminal_state: state,
      }));
    };

    let lastExitCode: number | null = null;
    let lastSignal: string | null = null;

    function flushPending(): void {
      while (pending.length > 0) {
        const delimiter = indexOfPendingNul();
        if (delimiter < 0) break;
        const recordBytes = drainPending(delimiter);
        if (recordBytes.length === 0) continue;
        try {
          // A complete NUL-terminated record must itself be within the record
          // ceiling. The post-flush `pendingBytes` check only bounds an
          // in-progress (not-yet-terminated) record; without this per-record
          // check a complete oversized record whose terminal NUL arrives in the
          // same chunk would be drained (dropping pendingBytes) and delivered
          // before that check could fire, silently bypassing the ceiling. The
          // D58 record grammar is `<mode> <type> <oid> <size>\t<path><NUL>`, so
          // the record's full byte length INCLUDES its terminal NUL delimiter
          // (drainPending strips that NUL from `recordBytes`); the ceiling is on
          // that complete NUL-inclusive length, consistent with the in-progress
          // `pendingBytes` bound which counts the NUL bytes it holds.
          if (recordBytes.length + 1 > recordMax) throw streamingOverflow('git-stream-record-overflow', `git ls-tree record exceeded the ${String(recordMax)}-byte record ceiling`);
          const record = parseStreamingRecord(recordBytes);
          entryCount = checkedAdd(entryCount, 1, 'git-stream-entry-overflow');
          if (entryCount > entryMax) throw streamingOverflow('git-stream-entry-overflow', `git ls-tree entry count exceeded the ${String(entryMax)}-entry ceiling`);
          pathBytes = checkedAdd(pathBytes, record.path_bytes.length, 'git-stream-path-overflow');
          if (pathBytes > pathMax) throw streamingOverflow('git-stream-path-overflow', `git ls-tree cumulative path bytes exceeded the ${String(pathMax)}-byte ceiling`);
          if (record.object_type === 'blob' && record.size !== null) objectTotal = checkedAdd(objectTotal, record.size, 'tracked-tree-total-overflow');
          input.onRecord(record);
        } catch (error) {
          if (error instanceof GitStreamingQueryError) { failLoud(error); return; }
          throw error;
        }
      }
    }

    function indexOfPendingNul(): number {
      let offset = 0;
      for (const chunk of pending) {
        const at = chunk.indexOf(0);
        if (at >= 0) return offset + at;
        offset += chunk.length;
      }
      return -1;
    }

    function drainPending(upToExclusive: number): Uint8Array {
      const out = new Uint8Array(upToExclusive);
      let written = 0;
      while (pending.length > 0 && written < upToExclusive) {
        const chunk = pending[0];
        if (chunk === undefined) break;
        const need = upToExclusive - written;
        if (chunk.length <= need) {
          out.set(chunk, written);
          written += chunk.length;
          pending.shift();
          pendingBytes -= chunk.length;
        } else {
          out.set(chunk.subarray(0, need), written);
          written += need;
          pending[0] = new Uint8Array(chunk.subarray(need));
          pendingBytes -= need;
        }
      }
      // Drop the trailing NUL delimiter byte as well.
      if (pending.length > 0) {
        const head = pending[0];
        if (head !== undefined) {
          pending[0] = new Uint8Array(head.subarray(1));
          pendingBytes -= 1;
        }
      }
      return out;
    }

    let terminating = false;
    let forceKilled = false;
    function beginTermination(_entryState: 'grace-terminating'): void {
      if (terminating) return;
      terminating = true;
      void terminateStreamingTree();
    }

    async function terminateStreamingTree(): Promise<void> {
      if (pid === null) return;
      if (gitProcessTreeTerminationKind() === 'windows-task-tree') {
        await new Promise<void>((resolveKill) => {
          const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', shell: false });
          killer.once('close', () => resolveKill());
          killer.once('error', () => resolveKill());
        });
        return;
      }
      try { process.kill(-pid, 'SIGTERM'); } catch { try { childHandle.kill('SIGTERM'); } catch { /* ignore */ } }
      await wait(Math.min(GIT_TERMINATION_GRACE_MS, remainingMs(GIT_STREAM_TOTAL_DEADLINE_MS)));
      if (terminalState !== null || closeObserved) return;
      try { process.kill(-pid, 'SIGKILL'); forceKilled = true; } catch {
        if (!closeObserved) { try { childHandle.kill('SIGKILL'); forceKilled = true; } catch { /* ignore */ } }
      }
      await wait(Math.min(GIT_FORCE_KILL_WAIT_MS, remainingMs(GIT_STREAM_TOTAL_DEADLINE_MS)));
    }

    function onDeadline(): void {
      if (terminalState === 'containment-failed' || terminalState === 'spawn-unconfirmed') {
        dispose();
        if (firstError === null) {
          firstError = new GitStreamingQueryError('git-process-containment-failed', 'git ls-tree process containment could not be confirmed within the absolute deadline', { terminalState, rootPid: pid });
        }
        reject(firstError);
      }
    }

    let childHandle: ReturnType<typeof spawn>;
    try {
      childHandle = spawn('git', argv, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: platform() !== 'win32',
      });
    } catch (error) {
      dispose();
      reject(new GitStreamingQueryError('invalid-ls-tree-output', `git ls-tree spawn threw synchronously: ${errorMessage(error)}`));
      return;
    }

    const handleEvents = childHandle as unknown as { once(event: 'spawn', listener: () => void): void; once(event: 'error', listener: (error: Error) => void): void; };
    handleEvents.once('spawn', () => {
      spawnEventConfirmed = true;
      pid = childHandle.pid ?? null;
    });
    childHandle.once('error', (error: Error) => {
      if (terminalState !== null) return;
      if (!spawnEventConfirmed) {
        finish('spawn-failed', null, null);
        dispose();
        reject(new GitStreamingQueryError('invalid-ls-tree-output', `git ls-tree failed to spawn: ${errorMessage(error)}`, { terminalState: 'spawn-failed', rootPid: null }));
      } else {
        failLoud(new GitStreamingQueryError('invalid-ls-tree-output', `git ls-tree stream error after spawn: ${errorMessage(error)}`));
      }
    });
    childHandle.stdin.on('error', () => { failLoud(new GitStreamingQueryError('invalid-ls-tree-output', 'git ls-tree stdin stream errored')); });
    childHandle.stdin.end();
    childHandle.stdout.on('data', (chunk: Uint8Array) => {
      if (terminalState !== null) return;
      try {
        wireBytes = checkedAdd(wireBytes, chunk.length, 'git-stream-wire-overflow');
        pending.push(new Uint8Array(chunk));
        pendingBytes = checkedAdd(pendingBytes, chunk.length, 'git-stream-record-overflow');
        flushPending();
        if (pendingBytes > recordMax) throw streamingOverflow('git-stream-record-overflow', `git ls-tree pending record exceeded the ${String(recordMax)}-byte record ceiling`);
        if (wireBytes > GIT_STREAM_WIRE_MAX_BYTES) throw streamingOverflow('git-stream-wire-overflow', `git ls-tree wire output exceeded the ${String(GIT_STREAM_WIRE_MAX_BYTES)}-byte ceiling`);
      } catch (error) {
        if (error instanceof GitStreamingQueryError) { failLoud(error); return; }
        throw error;
      }
    });
    childHandle.stdout.on('error', () => { failLoud(new GitStreamingQueryError('invalid-ls-tree-output', 'git ls-tree stdout stream errored')); });
    childHandle.stderr.on('data', (chunk: Uint8Array) => { feedStderr(stderrAcc, chunk); });
    childHandle.stderr.on('error', () => { failLoud(new GitStreamingQueryError('invalid-ls-tree-output', 'git ls-tree stderr stream errored')); });
    childHandle.once('close', (code, signal) => {
      if (terminalState !== null) return;
      closeObserved = true;
      lastExitCode = code;
      lastSignal = signal;
      const terminalForTermination: GitStreamTerminalState = forceKilled ? 'force-terminated' : 'grace-terminated';
      const state: GitStreamTerminalState = terminating ? terminalForTermination : 'exited';
      if (firstError === null) {
        if (state !== 'exited') {
          firstError = new GitStreamingQueryError('invalid-ls-tree-output', `git ls-tree was ${state} before producing a complete stream`, { terminalState: state, rootPid: pid, diagnostic: stderrDiagnostic(stderrAcc, '') });
        } else if (code !== 0) {
          firstError = new GitStreamingQueryError('invalid-ls-tree-output', `git ls-tree exited with status ${String(code ?? -1)}`, { diagnostic: stderrDiagnostic(stderrAcc, '') });
        } else if (pendingBytes > 0) {
          firstError = new GitStreamingQueryError('invalid-ls-tree-output', 'git ls-tree stream ended with a partial final record (no terminal NUL)', { diagnostic: stderrDiagnostic(stderrAcc, `pending_bytes=${String(pendingBytes)}`) });
        }
      }
      finish(state, code, signal);
      settle();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
