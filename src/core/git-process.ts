import { spawn, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

export const GIT_QUERY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const GIT_MUTATION_DIAGNOSTIC_BYTES = 256 * 1024;
export const GIT_DEFAULT_QUERY_TIMEOUT_MS = 30_000;
export const GIT_DEFAULT_MUTATION_TIMEOUT_MS = 120_000;
const GIT_TERMINATION_GRACE_MS = 1_000;

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
  | { readonly kind: 'update-ref-delete'; readonly ref: string; readonly expectedOld: string }
  | { readonly kind: 'merge-tree-write'; readonly left: string; readonly right: string };

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

function queryCommand(descriptor: GitQueryDescriptor): QueryCommand {
  switch (descriptor.kind) {
    case 'head': return { argv: ['rev-parse', 'HEAD'], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'show-toplevel': return { argv: ['rev-parse', '--show-toplevel'], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'git-common-dir': return { argv: ['rev-parse', '--git-common-dir'], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'git-path': return { argv: ['rev-parse', '--git-path', atom(descriptor.name, 'Git path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'current-branch': return { argv: ['symbolic-ref', '--quiet', '--short', 'HEAD'], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'resolve-revision': return { argv: ['rev-parse', ...(descriptor.verify === true ? ['--verify'] : []), atom(descriptor.revision, 'revision')], acceptedExitCodes: [0, 1, 128], negativeExitCodes: descriptor.verify === true ? [1, 128] : [] };
    case 'resolve-commit': return { argv: ['rev-parse', '--verify', `${atom(descriptor.revision, 'commit revision')}^{commit}`], acceptedExitCodes: [0, 1, 128], negativeExitCodes: [1, 128] };
    case 'resolve-tree': return { argv: ['rev-parse', '--verify', `${atom(descriptor.revision, 'tree revision')}^{tree}`], acceptedExitCodes: [0, 1, 128], negativeExitCodes: [1, 128] };
    case 'ref-exists': return { argv: ['show-ref', '--verify', '--quiet', atom(descriptor.ref, 'ref')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'commit-exists': return { argv: ['cat-file', '-e', `${atom(descriptor.revision, 'commit revision')}^{commit}`], acceptedExitCodes: [0, 1, 128], negativeExitCodes: [1, 128] };
    case 'is-ancestor': return { argv: ['merge-base', '--is-ancestor', atom(descriptor.ancestor, 'ancestor'), atom(descriptor.descendant, 'descendant')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'merge-base': return { argv: ['merge-base', atom(descriptor.left, 'left commit'), atom(descriptor.right, 'right commit')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'status-porcelain': return { argv: ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(descriptor.includeIgnored === true ? ['--ignored=matching', '--ignore-submodules=none'] : [])], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'diff-paths': return { argv: ['diff', '--name-only', ...(descriptor.noRenames === true ? ['--no-renames'] : []), ...(descriptor.filter === undefined ? [] : [`--diff-filter=${atom(descriptor.filter, 'diff filter')}`]), '-z', atom(descriptor.from, 'from revision'), atom(descriptor.to, 'to revision'), '--', ...atoms(descriptor.paths ?? [], 'diff path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'diff-text': return { argv: ['diff', '--no-ext-diff', '--no-color', `--unified=${String(descriptor.unifiedLines)}`, atom(descriptor.from, 'from revision'), atom(descriptor.to, 'to revision'), '--', atom(descriptor.path, 'diff path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'staged-clean': return { argv: ['diff', '--cached', '--quiet', '--exit-code'], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'worktree-list': return { argv: ['worktree', 'list', '--porcelain', ...(descriptor.nul === true ? ['-z'] : [])], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'config-get': return { argv: ['config', ...(descriptor.file === undefined ? [] : ['--file', atom(descriptor.file, 'config file', true)]), '--get', atom(descriptor.key, 'config key')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'config-bool': return { argv: ['config', '--bool', atom(descriptor.key, 'config key')], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'config-regexp': return { argv: ['config', '--file', atom(descriptor.file, 'config file', true), '--get-regexp', atom(descriptor.pattern, 'config pattern', true)], acceptedExitCodes: [0, 1], negativeExitCodes: [1] };
    case 'ls-files-state': return { argv: ['ls-files', '-t', '--', ...atoms(descriptor.paths, 'tracked path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'ls-tree-path': return { argv: ['ls-tree', '-z', atom(descriptor.revision, 'tree revision'), '--', atom(descriptor.path, 'tree path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'ls-tree-recursive': return { argv: ['ls-tree', '-r', ...(descriptor.includeSize ? ['-l'] : []), '--full-tree', '-z', atom(descriptor.revision, 'tree revision')], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'show-file': return { argv: ['show', `${atom(descriptor.revision, 'show revision')}:${atom(descriptor.path, 'show path', true)}`], acceptedExitCodes: descriptor.allowAbsent === true ? [0, 128] : [0], negativeExitCodes: descriptor.allowAbsent === true ? [128] : [] };
    case 'rev-list-parents': return { argv: ['rev-list', '--parents', '-n', '1', atom(descriptor.revision, 'revision')], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'rev-list-range': return { argv: ['rev-list', ...(descriptor.reverse === true ? ['--reverse'] : []), `${atom(descriptor.fromExclusive, 'range start')}..${atom(descriptor.toInclusive, 'range end')}`], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'last-commit-for-path': return { argv: ['log', '-1', '--format=%H', `${atom(descriptor.fromExclusive, 'range start')}..${atom(descriptor.toInclusive, 'range end')}`, '--', atom(descriptor.path, 'log path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
    case 'sparse-checkout-help': return { argv: ['sparse-checkout', '-h'], acceptedExitCodes: [0, 129], negativeExitCodes: [] };
  }
}

function patternsInput(patterns: readonly string[]): Uint8Array {
  if (patterns.length === 0) throw new GitProcessDescriptorError('sparse-checkout mutation requires non-empty patterns');
  for (const pattern of patterns) atom(pattern, 'sparse pattern', true);
  return new TextEncoder().encode(`${patterns.join('\n')}\n`);
}

function mutationCommand(descriptor: GitMutationDescriptor): MutationCommand {
  switch (descriptor.kind) {
    case 'worktree-add': {
      const common = ['worktree', 'add', ...(descriptor.noCheckout ? ['--no-checkout'] : [])];
      if (descriptor.createBranch) {
        if (descriptor.startPoint === null) throw new GitProcessDescriptorError('new worktree branch requires a start point');
        return { argv: [...common, '-b', atom(descriptor.branch, 'branch'), atom(descriptor.path, 'worktree path', true), atom(descriptor.startPoint, 'start point')], input: null };
      }
      return { argv: [...common, atom(descriptor.path, 'worktree path', true), atom(descriptor.branch, 'branch')], input: null };
    }
    case 'worktree-remove': return { argv: ['worktree', 'remove', '--', atom(descriptor.path, 'worktree path', true)], input: null };
    case 'worktree-prune': return { argv: ['worktree', 'prune', '--expire', 'now'], input: null };
    case 'sparse-checkout-set': return { argv: ['sparse-checkout', 'set', '--no-cone', '--skip-checks', '--stdin'], input: patternsInput(descriptor.patterns) };
    case 'sparse-checkout-add': return { argv: ['sparse-checkout', 'add', '--skip-checks', '--stdin'], input: patternsInput(descriptor.patterns) };
    case 'checkout-force': return { argv: ['checkout', '--force', atom(descriptor.branch, 'branch')], input: null };
    case 'stage-paths': {
      if (descriptor.paths.length === 0) throw new GitProcessDescriptorError('stage mutation requires at least one path');
      return { argv: ['add', ...(descriptor.sparse === true ? ['--sparse'] : []), ...(descriptor.force === true ? ['-f'] : []), '-A', '--', ...atoms(descriptor.paths, 'stage path', true)], input: null };
    }
    case 'commit': return { argv: ['commit', '--quiet', '--no-verify', '-m', atom(descriptor.message, 'commit message', true)], input: null };
    case 'merge': return { argv: ['merge', descriptor.mode === 'ff-only' ? '--ff-only' : '--no-ff', ...(descriptor.mode === 'no-ff' ? ['--no-edit'] : []), ...(descriptor.message === undefined ? [] : ['-m', atom(descriptor.message, 'merge message', true)]), atom(descriptor.target, 'merge target')], input: null };
    case 'merge-abort': return { argv: ['merge', '--abort'], input: null };
    case 'reset-hard': return { argv: ['reset', '--hard', atom(descriptor.target, 'reset target')], input: null };
    case 'update-ref-create': return { argv: ['update-ref', atom(descriptor.ref, 'ref'), atom(descriptor.target, 'target'), atom(descriptor.expectedOld, 'expected old object')], input: null };
    case 'update-ref-delete': return { argv: ['update-ref', '-d', atom(descriptor.ref, 'ref'), atom(descriptor.expectedOld, 'expected old object')], input: null };
    case 'merge-tree-write': return { argv: ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', atom(descriptor.left, 'left commit'), atom(descriptor.right, 'right commit')], input: null };
  }
}

export function gitQueryArgv(descriptor: GitQueryDescriptor): readonly string[] {
  return Object.freeze([...queryCommand(descriptor).argv]);
}

export function gitMutationArgv(descriptor: GitMutationDescriptor): readonly string[] {
  return Object.freeze([...mutationCommand(descriptor).argv]);
}

function boundedDiagnostic(stdout: Uint8Array, stderr: Uint8Array, droppedBytes = 0): string {
  const decode = (value: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(value);
  const raw = [decode(stderr).trim(), decode(stdout).trim()].filter((value) => value.length > 0).join('\n');
  const redacted = raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1<redacted>@')
    .replace(/\b(capability|credential|password|token|secret)([=: ]+)[^\s]+/giu, '$1$2<redacted>')
    .replace(/\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]+\b/gu, '<redacted>');
  return droppedBytes === 0 ? redacted : `${redacted}${redacted.length === 0 ? '' : '\n'}[diagnostic truncated; dropped_bytes=${String(droppedBytes)}]`;
}

function queryErrorCode(error: Error): GitQueryError['code'] {
  if ('code' in error && error.code === 'ETIMEDOUT') return 'timeout';
  if ('code' in error && error.code === 'ENOBUFS') return 'output-overflow';
  return 'spawn-failure';
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
    // Node applies maxBuffer independently to stdout/stderr. Halving the
    // package-wide allowance guarantees combined retained query bytes never
    // exceed the frozen 64 MiB ceiling.
    maxBuffer: GIT_QUERY_MAX_OUTPUT_BYTES / 2,
  });
  const stdout = new Uint8Array(result.stdout);
  const stderr = new Uint8Array(result.stderr);
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
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { return; } }
  }
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
      const droppedBytes = stdout.droppedBytes + stderr.droppedBytes;
      const reason = unknownReason
        ?? (signal === null ? null : 'signal')
        ?? (code === null ? 'report-loss' : null)
        ?? (droppedBytes > 0 ? 'diagnostic-truncation' : null);
      if (reason !== null || droppedBytes > 0) {
        resolvePromise({ kind: 'effect-unknown', descriptor: input.descriptor.kind, reason: reason ?? 'diagnostic-truncation', exitCode: code, signal, diagnostic: boundedDiagnostic(stdoutBytes, stderrBytes, droppedBytes), droppedBytes });
        return;
      }
      resolvePromise({ kind: 'reported', descriptor: input.descriptor.kind, exitCode: code ?? -1, stdout: stdoutBytes, stderr: stderrBytes, diagnostic: boundedDiagnostic(stdoutBytes, stderrBytes) });
    });
  });
}
