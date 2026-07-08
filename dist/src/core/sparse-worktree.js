import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
export class AutopilotSparseWorktreeError extends Error {
    name = 'AutopilotSparseWorktreeError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotSparseWorktreeError [${code}]: ${message}`);
        this.code = code;
        this.evidence = Object.freeze([...evidence]);
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotSparseWorktreeError(code, message, evidence);
}
export function createAutopilotGitWorktree(input) {
    if (input.mode === 'full') {
        runGit(['worktree', 'add', '-b', input.branch, input.worktreePath, input.startPoint], input.repoRoot, runtimeGitEnv(input.env));
        return;
    }
    if (input.sparsePatterns.length === 0) {
        fail('empty-sparse-patterns', 'sparse worktree creation requires at least one sparse checkout pattern.');
    }
    assertSparseCheckoutSupported(input.repoRoot, input.env);
    runGit(['worktree', 'add', '--no-checkout', '-b', input.branch, input.worktreePath, input.startPoint], input.repoRoot, runtimeGitEnv(input.env));
    applySparseCheckoutSet(input.worktreePath, input.sparsePatterns, input.env);
    runGit(['checkout', '--force', input.branch], input.worktreePath, runtimeGitEnv(input.env));
    assertSparseCheckoutEnabled(input.worktreePath, input.env);
}
export function applySparseCheckoutSet(worktreePath, patterns, env) {
    runGitWithInput(['sparse-checkout', 'set', '--no-cone', '--skip-checks', '--stdin'], worktreePath, sparsePatternInput(patterns), runtimeGitEnv(env));
}
export function addSparseCheckoutPatterns(worktreePath, patterns, env) {
    if (patterns.length === 0)
        return;
    assertSparseCheckoutEnabled(worktreePath, env);
    runGitWithInput(['sparse-checkout', 'add', '--skip-checks', '--stdin'], worktreePath, sparsePatternInput(patterns), runtimeGitEnv(env));
}
export function isSparseCheckoutEnabled(worktreePath, env) {
    const result = spawnSync('git', ['config', '--bool', 'core.sparseCheckout'], {
        cwd: worktreePath,
        encoding: 'utf8',
        env: runtimeGitEnv(env),
    });
    if ((result.status ?? -1) !== 0)
        return false;
    return result.stdout.trim() === 'true';
}
export function assertSparseCheckoutEnabled(worktreePath, env) {
    if (!isSparseCheckoutEnabled(worktreePath, env)) {
        fail('sparse-checkout-not-enabled', 'expected registered Autopilot worktree to have core.sparseCheckout=true.', [worktreePath]);
    }
}
export function removeGitWorktreeIfPresent(repoRoot, worktreePath, env) {
    if (!existsSync(worktreePath))
        return;
    runGit(['worktree', 'remove', '--force', worktreePath], repoRoot, runtimeGitEnv(env));
}
export function isSparseMissingPath(worktreePath, repoRelativePath, env) {
    const result = spawnSync('git', ['ls-files', '-t', '--', repoRelativePath], {
        cwd: worktreePath,
        encoding: 'utf8',
        env: runtimeGitEnv(env),
    });
    if ((result.status ?? -1) !== 0)
        return false;
    return result.stdout.split('\n').some((line) => line.startsWith('S '));
}
function assertSparseCheckoutSupported(repoRoot, env) {
    const result = spawnSync('git', ['sparse-checkout', '-h'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: runtimeGitEnv(env),
    });
    const helpText = `${result.stdout}\n${result.stderr}`;
    if ((result.status ?? -1) !== 0 && !helpText.includes('usage: git sparse-checkout')) {
        fail('sparse-checkout-unsupported', 'git sparse-checkout is not available; Autopilot refuses to fall back to full checkout implicitly.', [result.stderr.trim(), result.stdout.trim()]);
    }
}
function sparsePatternInput(patterns) {
    if (patterns.some((pattern) => pattern.includes('\0') || pattern.trim().length === 0)) {
        fail('invalid-sparse-pattern', 'sparse checkout patterns must be non-empty and must not contain NUL.');
    }
    return `${patterns.join('\n')}\n`;
}
function runGit(args, cwd, env) {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env });
    if (result.error !== undefined)
        fail('git-spawn-failed', `git ${args.join(' ')} failed to spawn: ${result.error.message}`);
    if ((result.status ?? -1) !== 0)
        fail('git-command-failed', `git ${args.join(' ')} exited with status ${String(result.status ?? -1)}.`, [result.stderr.trim(), result.stdout.trim()]);
    return result.stdout;
}
function runGitWithInput(args, cwd, input, env) {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', input, env });
    if (result.error !== undefined)
        fail('git-spawn-failed', `git ${args.join(' ')} failed to spawn: ${result.error.message}`);
    if ((result.status ?? -1) !== 0)
        fail('git-command-failed', `git ${args.join(' ')} exited with status ${String(result.status ?? -1)}.`, [result.stderr.trim(), result.stdout.trim()]);
    return result.stdout;
}
function runtimeGitEnv(env = process.env) {
    return {
        ...process.env,
        ...env,
        AUTOPILOT_RUNTIME: '1',
        AUTOPILOT_RUNTIME_AUTHORITY: 'sparse-worktree',
        GIT_LFS_SKIP_SMUDGE: '1',
    };
}
