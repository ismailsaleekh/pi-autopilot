import { gitQueryText, runGitMutation, runGitQuery } from "./git-process.js";
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
async function mutate(descriptor, cwd, env) {
    // The mutation report is deliberately not effect truth. The owning worktree
    // saga probes the canonical operation postcondition after this action.
    await runGitMutation({ descriptor, cwd, env: runtimeGitEnv(env) });
}
export async function createAutopilotGitWorktree(input) {
    const branchExists = !runGitQuery({ descriptor: { kind: 'ref-exists', ref: `refs/heads/${input.branch}` }, cwd: input.repoRoot, env: runtimeGitEnv(input.env) }).negative;
    if (branchExists) {
        const existingSha = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: `refs/heads/${input.branch}`, verify: true }, cwd: input.repoRoot, env: runtimeGitEnv(input.env) }).trim();
        const expectedSha = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: input.startPoint }, cwd: input.repoRoot, env: runtimeGitEnv(input.env) }).trim();
        if (existingSha !== expectedSha)
            fail('existing-branch-moved', 'partial worktree recovery found the intended branch at an unexpected commit.', [`branch=${input.branch}`, `expected=${expectedSha}`, `actual=${existingSha}`]);
    }
    if (input.mode === 'full') {
        await mutate({ kind: 'worktree-add', path: input.worktreePath, branch: input.branch, startPoint: branchExists ? null : input.startPoint, createBranch: !branchExists, noCheckout: false }, input.repoRoot, input.env);
        return;
    }
    if (input.sparsePatterns.length === 0)
        fail('empty-sparse-patterns', 'sparse worktree creation requires at least one sparse checkout pattern.');
    assertSparseCheckoutSupported(input.repoRoot, input.env);
    await mutate({ kind: 'worktree-add', path: input.worktreePath, branch: input.branch, startPoint: branchExists ? null : input.startPoint, createBranch: !branchExists, noCheckout: true }, input.repoRoot, input.env);
    await applySparseCheckoutSet(input.worktreePath, input.sparsePatterns, input.env);
    await mutate({ kind: 'checkout-force', branch: input.branch }, input.worktreePath, input.env);
    assertSparseCheckoutEnabled(input.worktreePath, input.env);
}
export async function applySparseCheckoutSet(worktreePath, patterns, env) {
    await mutate({ kind: 'sparse-checkout-set', patterns }, worktreePath, env);
}
export async function addSparseCheckoutPatterns(worktreePath, patterns, env) {
    if (patterns.length === 0)
        return;
    assertSparseCheckoutEnabled(worktreePath, env);
    await mutate({ kind: 'sparse-checkout-add', patterns }, worktreePath, env);
}
export function isSparseCheckoutEnabled(worktreePath, env) {
    const result = runGitQuery({ descriptor: { kind: 'config-bool', key: 'core.sparseCheckout' }, cwd: worktreePath, env: runtimeGitEnv(env) });
    return !result.negative && new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim() === 'true';
}
export function assertSparseCheckoutEnabled(worktreePath, env) {
    if (!isSparseCheckoutEnabled(worktreePath, env))
        fail('sparse-checkout-not-enabled', 'expected registered Autopilot worktree to have core.sparseCheckout=true.', [worktreePath]);
}
export function isSparseMissingPath(worktreePath, repoRelativePath, env) {
    const output = gitQueryText({ descriptor: { kind: 'ls-files-state', paths: [repoRelativePath] }, cwd: worktreePath, env: runtimeGitEnv(env) });
    return output.split('\0').some((record) => record.startsWith('S '));
}
function assertSparseCheckoutSupported(repoRoot, env) {
    const result = runGitQuery({ descriptor: { kind: 'sparse-checkout-help' }, cwd: repoRoot, env: runtimeGitEnv(env) });
    const helpText = `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;
    if (result.exitCode !== 0 && !helpText.includes('usage: git sparse-checkout'))
        fail('sparse-checkout-unsupported', 'git sparse-checkout is not available; Autopilot refuses to fall back to full checkout implicitly.', [helpText.trim()]);
}
function runtimeGitEnv(env = process.env) {
    return { ...process.env, ...env, AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'sparse-worktree', GIT_LFS_SKIP_SMUDGE: '1' };
}
