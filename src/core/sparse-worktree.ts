import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { AutopilotCheckoutMode } from './checkout-profile.ts';

export interface ProcessEnvLike {
  readonly [key: string]: string | undefined;
}

export interface CreateAutopilotGitWorktreeInput {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly startPoint: string;
  readonly mode: AutopilotCheckoutMode;
  readonly sparsePatterns: readonly string[];
  readonly env?: ProcessEnvLike;
}

export class AutopilotSparseWorktreeError extends Error {
  override readonly name = 'AutopilotSparseWorktreeError';
  readonly code: string;
  readonly evidence: readonly string[];

  constructor(code: string, message: string, evidence: readonly string[] = []) {
    super(`AutopilotSparseWorktreeError [${code}]: ${message}`);
    this.code = code;
    this.evidence = Object.freeze([...evidence]);
  }
}

function fail(code: string, message: string, evidence: readonly string[] = []): never {
  throw new AutopilotSparseWorktreeError(code, message, evidence);
}

export function createAutopilotGitWorktree(input: CreateAutopilotGitWorktreeInput): void {
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

export function applySparseCheckoutSet(worktreePath: string, patterns: readonly string[], env?: ProcessEnvLike): void {
  runGitWithInput(
    ['sparse-checkout', 'set', '--no-cone', '--skip-checks', '--stdin'],
    worktreePath,
    sparsePatternInput(patterns),
    runtimeGitEnv(env),
  );
}

export function addSparseCheckoutPatterns(worktreePath: string, patterns: readonly string[], env?: ProcessEnvLike): void {
  if (patterns.length === 0) return;
  assertSparseCheckoutEnabled(worktreePath, env);
  runGitWithInput(
    ['sparse-checkout', 'add', '--skip-checks', '--stdin'],
    worktreePath,
    sparsePatternInput(patterns),
    runtimeGitEnv(env),
  );
}

export function isSparseCheckoutEnabled(worktreePath: string, env?: ProcessEnvLike): boolean {
  const result = spawnSync('git', ['config', '--bool', 'core.sparseCheckout'], {
    cwd: worktreePath,
    encoding: 'utf8',
    env: runtimeGitEnv(env),
  });
  if ((result.status ?? -1) !== 0) return false;
  return result.stdout.trim() === 'true';
}

export function assertSparseCheckoutEnabled(worktreePath: string, env?: ProcessEnvLike): void {
  if (!isSparseCheckoutEnabled(worktreePath, env)) {
    fail('sparse-checkout-not-enabled', 'expected registered Autopilot worktree to have core.sparseCheckout=true.', [worktreePath]);
  }
}

export function removeGitWorktreeIfPresent(repoRoot: string, worktreePath: string, env?: ProcessEnvLike): void {
  if (!existsSync(worktreePath)) return;
  runGit(['worktree', 'remove', '--force', worktreePath], repoRoot, runtimeGitEnv(env));
}

export function isSparseMissingPath(worktreePath: string, repoRelativePath: string, env?: ProcessEnvLike): boolean {
  const result = spawnSync('git', ['ls-files', '-t', '--', repoRelativePath], {
    cwd: worktreePath,
    encoding: 'utf8',
    env: runtimeGitEnv(env),
  });
  if ((result.status ?? -1) !== 0) return false;
  return result.stdout.split('\n').some((line) => line.startsWith('S '));
}

function assertSparseCheckoutSupported(repoRoot: string, env?: ProcessEnvLike): void {
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

function sparsePatternInput(patterns: readonly string[]): string {
  if (patterns.some((pattern) => pattern.includes('\0') || pattern.trim().length === 0)) {
    fail('invalid-sparse-pattern', 'sparse checkout patterns must be non-empty and must not contain NUL.');
  }
  return `${patterns.join('\n')}\n`;
}

function runGit(args: readonly string[], cwd: string, env: ProcessEnvLike): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env });
  if (result.error !== undefined) fail('git-spawn-failed', `git ${args.join(' ')} failed to spawn: ${result.error.message}`);
  if ((result.status ?? -1) !== 0) fail('git-command-failed', `git ${args.join(' ')} exited with status ${String(result.status ?? -1)}.`, [result.stderr.trim(), result.stdout.trim()]);
  return result.stdout;
}

function runGitWithInput(args: readonly string[], cwd: string, input: string, env: ProcessEnvLike): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', input, env });
  if (result.error !== undefined) fail('git-spawn-failed', `git ${args.join(' ')} failed to spawn: ${result.error.message}`);
  if ((result.status ?? -1) !== 0) fail('git-command-failed', `git ${args.join(' ')} exited with status ${String(result.status ?? -1)}.`, [result.stderr.trim(), result.stdout.trim()]);
  return result.stdout;
}

function runtimeGitEnv(env: ProcessEnvLike = process.env): Record<string, string | undefined> {
  return {
    ...process.env,
    ...env,
    AUTOPILOT_RUNTIME: '1',
    AUTOPILOT_RUNTIME_AUTHORITY: 'sparse-worktree',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}
