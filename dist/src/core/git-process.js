import { spawn, spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { isAbsolute } from 'node:path';
export const GIT_QUERY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const GIT_MUTATION_DIAGNOSTIC_BYTES = 256 * 1024;
export const GIT_DEFAULT_QUERY_TIMEOUT_MS = 30_000;
export const GIT_DEFAULT_MUTATION_TIMEOUT_MS = 120_000;
const GIT_TERMINATION_GRACE_MS = 1_000;
export class GitProcessDescriptorError extends Error {
    name = 'GitProcessDescriptorError';
    constructor(message) {
        super(`GitProcessDescriptorError: ${message}`);
    }
}
export class GitQueryError extends Error {
    name = 'GitQueryError';
    code;
    descriptor;
    diagnostic;
    constructor(code, descriptor, message, diagnostic = '') {
        super(`GitQueryError [${code}/${descriptor}]: ${message}`);
        this.code = code;
        this.descriptor = descriptor;
        this.diagnostic = diagnostic;
    }
}
function atom(value, label, allowLeadingDash = false) {
    if (value.length === 0 || value.includes('\0'))
        throw new GitProcessDescriptorError(`${label} must be non-empty and NUL-free`);
    if (!allowLeadingDash && value.startsWith('-'))
        throw new GitProcessDescriptorError(`${label} must not be option-shaped`);
    return value;
}
function atoms(values, label, allowLeadingDash = false) {
    return values.map((value) => atom(value, label, allowLeadingDash));
}
function absolutePath(value, label) {
    atom(value, label, true);
    if (!isAbsolute(value))
        throw new GitProcessDescriptorError(`${label} must be absolute`);
    return value;
}
function repoPath(value, label) {
    atom(value, label, true);
    const normalized = value.replace(/\\/gu, '/');
    if (isAbsolute(value) || normalized.split('/').some((segment) => segment === '..' || segment === ''))
        throw new GitProcessDescriptorError(`${label} must be bounded repository-relative authority`);
    return value;
}
function autopilotRef(value) {
    atom(value, 'Autopilot ref');
    if (!value.startsWith('refs/heads/autopilot/'))
        throw new GitProcessDescriptorError('mutating ref must be under refs/heads/autopilot/');
    return value;
}
function unifiedLines(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000)
        throw new GitProcessDescriptorError('unified line count must be a bounded non-negative integer');
    return value;
}
function queryCommand(descriptor) {
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
            if (descriptor.filter !== undefined && !/^[ACDMRTUXB*]+$/u.test(descriptor.filter))
                throw new GitProcessDescriptorError('diff filter is invalid');
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
        case 'show-file': return { argv: ['show', `${atom(descriptor.revision, 'show revision')}:${atom(descriptor.path, 'show path', true)}`], acceptedExitCodes: descriptor.allowAbsent === true ? [0, 128] : [0], negativeExitCodes: descriptor.allowAbsent === true ? [128] : [] };
        case 'rev-list-parents': return { argv: ['rev-list', '--parents', '-n', '1', atom(descriptor.revision, 'revision')], acceptedExitCodes: [0], negativeExitCodes: [] };
        case 'rev-list-range': return { argv: ['rev-list', ...(descriptor.reverse === true ? ['--reverse'] : []), `${atom(descriptor.fromExclusive, 'range start')}..${atom(descriptor.toInclusive, 'range end')}`], acceptedExitCodes: [0], negativeExitCodes: [] };
        case 'last-commit-for-path': return { argv: ['log', '-1', '--format=%H', `${atom(descriptor.fromExclusive, 'range start')}..${atom(descriptor.toInclusive, 'range end')}`, '--', atom(descriptor.path, 'log path', true)], acceptedExitCodes: [0], negativeExitCodes: [] };
        case 'sparse-checkout-help': return { argv: ['sparse-checkout', '-h'], acceptedExitCodes: [0, 129], negativeExitCodes: [] };
    }
}
function patternsInput(patterns) {
    if (patterns.length === 0)
        throw new GitProcessDescriptorError('sparse-checkout mutation requires non-empty patterns');
    for (const pattern of patterns) {
        atom(pattern, 'sparse pattern', true);
        if (pattern.includes('\n') || pattern.includes('\r'))
            throw new GitProcessDescriptorError('sparse pattern must be one physical input line');
    }
    return new TextEncoder().encode(`${patterns.join('\n')}\n`);
}
function mutationCommand(descriptor) {
    switch (descriptor.kind) {
        case 'worktree-add': {
            const common = ['worktree', 'add', ...(descriptor.noCheckout ? ['--no-checkout'] : [])];
            if (descriptor.createBranch) {
                if (descriptor.startPoint === null)
                    throw new GitProcessDescriptorError('new worktree branch requires a start point');
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
            if (descriptor.paths.length === 0)
                throw new GitProcessDescriptorError('stage mutation requires at least one path');
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
export function gitQueryArgv(descriptor) {
    return Object.freeze([...queryCommand(descriptor).argv]);
}
export function gitMutationArgv(descriptor) {
    return Object.freeze([...mutationCommand(descriptor).argv]);
}
function boundedDiagnostic(stdout, stderr, droppedBytes = 0) {
    let remaining = GIT_MUTATION_DIAGNOSTIC_BYTES;
    const retain = (value) => {
        const bytes = value.subarray(0, remaining);
        remaining -= bytes.byteLength;
        return bytes;
    };
    const retainedStderr = retain(stderr);
    const retainedStdout = retain(stdout);
    const omitted = droppedBytes + stderr.byteLength - retainedStderr.byteLength + stdout.byteLength - retainedStdout.byteLength;
    const decode = (value) => new TextDecoder('utf-8', { fatal: false }).decode(value);
    const raw = [decode(retainedStderr).trim(), decode(retainedStdout).trim()].filter((value) => value.length > 0).join('\n');
    const redacted = raw
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1<redacted>@')
        .replace(/\b(capability|credential|password|token|secret)([=: ]+)[^\s]+/giu, '$1$2<redacted>')
        .replace(/\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]+\b/gu, '<redacted>');
    return omitted === 0 ? redacted : `${redacted}${redacted.length === 0 ? '' : '\n'}[diagnostic truncated; dropped_bytes=${String(omitted)}]`;
}
function queryErrorCode(error) {
    if ('code' in error && error.code === 'ETIMEDOUT')
        return 'timeout';
    if ('code' in error && error.code === 'ENOBUFS')
        return 'output-overflow';
    return 'spawn-failure';
}
export function gitQueryText(input) {
    return new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery(input).stdout);
}
export function gitQueryNulStrings(input) {
    const bytes = runGitQuery(input).stdout;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const values = [];
    let cursor = 0;
    while (cursor < bytes.length) {
        const delimiter = bytes.indexOf(0, cursor);
        if (delimiter < 0)
            throw new GitQueryError('unexpected-exit', input.descriptor.kind, 'NUL-delimited Git query ended with an unterminated record');
        if (delimiter > cursor)
            values.push(decoder.decode(bytes.subarray(cursor, delimiter)));
        cursor = delimiter + 1;
    }
    return Object.freeze(values);
}
export function runGitQuery(input) {
    let command;
    try {
        command = queryCommand(input.descriptor);
    }
    catch (error) {
        if (error instanceof GitProcessDescriptorError)
            throw new GitQueryError('invalid-descriptor', input.descriptor.kind, error.message);
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
    if (stdout.byteLength + stderr.byteLength > GIT_QUERY_MAX_OUTPUT_BYTES)
        throw new GitQueryError('output-overflow', input.descriptor.kind, `Git query exceeded the ${String(GIT_QUERY_MAX_OUTPUT_BYTES)}-byte retained output ceiling`, boundedDiagnostic(stdout, stderr));
    if (result.error !== undefined) {
        const code = queryErrorCode(result.error);
        throw new GitQueryError(code, input.descriptor.kind, result.error.message, boundedDiagnostic(stdout, stderr));
    }
    if (result.signal !== null)
        throw new GitQueryError('signal', input.descriptor.kind, `Git query ended by signal ${result.signal}`, boundedDiagnostic(stdout, stderr));
    const exitCode = result.status ?? -1;
    if (!command.acceptedExitCodes.includes(exitCode))
        throw new GitQueryError('unexpected-exit', input.descriptor.kind, `Git query exited with status ${String(exitCode)}`, boundedDiagnostic(stdout, stderr));
    return Object.freeze({ descriptor: input.descriptor.kind, exitCode, stdout, stderr, negative: command.negativeExitCodes.includes(exitCode) });
}
function captureChunk(stream, chunk) {
    const remaining = Math.max(0, GIT_MUTATION_DIAGNOSTIC_BYTES - stream.retainedBytes);
    const retained = chunk.subarray(0, remaining);
    if (retained.length > 0) {
        stream.chunks.push(new Uint8Array(retained));
        stream.retainedBytes += retained.length;
    }
    stream.droppedBytes += chunk.length - retained.length;
}
function concatenate(chunks, total) {
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}
async function wait(milliseconds) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
export function gitProcessTreeTerminationKind(platformName = platform()) {
    return platformName === 'win32' ? 'windows-task-tree' : 'posix-process-group';
}
async function terminateProcessTree(child) {
    if (child.pid === undefined)
        return;
    if (gitProcessTreeTerminationKind() === 'windows-task-tree') {
        await new Promise((resolvePromise) => {
            const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', shell: false });
            killer.once('close', () => resolvePromise());
            killer.once('error', () => resolvePromise());
        });
        return;
    }
    try {
        process.kill(-child.pid, 'SIGTERM');
    }
    catch {
        try {
            child.kill('SIGTERM');
        }
        catch {
            return;
        }
    }
    await wait(GIT_TERMINATION_GRACE_MS);
    // The group can outlive its leader; always attempt the hard group kill after
    // grace rather than trusting only the direct child's exitCode.
    try {
        process.kill(-child.pid, 'SIGKILL');
    }
    catch {
        if (child.exitCode === null)
            try {
                child.kill('SIGKILL');
            }
            catch {
                return;
            }
    }
}
export async function runGitMutation(input) {
    const command = mutationCommand(input.descriptor);
    return await new Promise((resolvePromise) => {
        const stdout = { chunks: [], retainedBytes: 0, droppedBytes: 0 };
        const stderr = { chunks: [], retainedBytes: 0, droppedBytes: 0 };
        let unknownReason = null;
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
        child.stdout.on('data', (chunk) => captureChunk(stdout, chunk));
        child.stderr.on('data', (chunk) => captureChunk(stderr, chunk));
        child.stdout.on('error', () => { unknownReason = 'stdout-failure'; void terminateProcessTree(child); });
        child.stderr.on('error', () => { unknownReason = 'stderr-failure'; void terminateProcessTree(child); });
        child.stdin.on('error', () => { unknownReason = 'stdin-failure'; void terminateProcessTree(child); });
        child.on('error', () => { unknownReason = 'spawn-failure'; });
        if (command.input === null)
            child.stdin.end();
        else
            child.stdin.write(new TextDecoder().decode(command.input), (error) => {
                if (error !== null && error !== undefined) {
                    unknownReason = 'stdin-failure';
                    void terminateProcessTree(child);
                }
                child.stdin.end();
            });
        child.on('close', (code, signal) => {
            if (settled)
                return;
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
