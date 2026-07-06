import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { parseAutopilotExecutionCommit } from './contracts/index.ts';
import type { AutopilotExecutionAudit, AutopilotExecutionCommit, AutopilotExecutionCommitOrigin, AutopilotStatusEntry, AutopilotUnitSpec } from './contracts/types.ts';
import {
  AUTOPILOT_RUNTIME_ENV,
  AUTOPILOT_RUNTIME_VALUE,
  type ActiveAutopilotContext,
  type AutopilotPathClaim,
  gitHead,
  isAutopilotRuntimeRepoPath,
  matchesRepoPathPattern,
  readGitStatus,
  runGit,
} from './parallel-runtime.ts';

export class AutopilotExecutionCommitError extends Error {
  override readonly name = 'AutopilotExecutionCommitError';
  readonly code: string;
  readonly evidence: readonly string[];

  constructor(code: string, message: string, evidence: readonly string[] = []) {
    super(`AutopilotExecutionCommitError [${code}]: ${message}`);
    this.code = code;
    this.evidence = Object.freeze([...evidence]);
  }
}

function fail(code: string, message: string, evidence: readonly string[] = []): never {
  throw new AutopilotExecutionCommitError(code, message, evidence);
}

export function deriveAutopilotExecutionCommitPath(spec: AutopilotUnitSpec): string {
  return resolve(
    dirname(dirname(spec.status_output)),
    'execution-commits',
    `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.json`,
  );
}

export async function commitAutopilotExecution(input: {
  readonly spec: AutopilotUnitSpec;
  readonly statusEntry: AutopilotStatusEntry;
  readonly audit: AutopilotExecutionAudit;
  readonly context: ActiveAutopilotContext;
  readonly acquiredClaims: readonly AutopilotPathClaim[];
  readonly auditPath: string;
  readonly commitPath?: string;
}): Promise<AutopilotExecutionCommit | null> {
  if (input.spec.role !== 'implement' && input.spec.role !== 'fix') return null;
  if (input.statusEntry.verdict !== 'DONE') return null;
  if (input.audit.classification !== 'clean') {
    fail('audit-not-clean', 'runtime commit requires a clean execution audit for source-changing success.', [
      `classification=${input.audit.classification}`,
      ...input.audit.outside_owned_paths.map((path) => `outside_owned=${path}`),
      ...input.audit.read_only_touched_paths.map((path) => `read_only_touched=${path}`),
      ...input.audit.untouchable_touched_paths.map((path) => `untouchable_touched=${path}`),
    ]);
  }

  const headBeforeRuntimeCommit = gitHead(input.spec.cwd);
  const status = readGitStatus(input.spec.cwd);
  const nonRuntimeChangedPaths = status.changedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream));
  const claimedWritePatterns = activeWriteClaimPaths(input);
  const dirtyClaimedPaths = nonRuntimeChangedPaths.filter((path) =>
    claimedWritePatterns.some((pattern) => matchesRepoPathPattern(path, pattern)),
  ).sort();
  const unclaimedChangedPaths = nonRuntimeChangedPaths.filter((path) => !dirtyClaimedPaths.includes(path));
  if (unclaimedChangedPaths.length > 0) {
    fail('unclaimed-changes', 'execution-commit evidence refused unclaimed source changes.', unclaimedChangedPaths);
  }
  const committedClaimedPaths = sortedUnique(input.audit.committed_changed_paths ?? []);
  for (const path of committedClaimedPaths) {
    if (!claimedWritePatterns.some((pattern) => matchesRepoPathPattern(path, pattern))) {
      fail('committed-path-outside-claims', 'child-created commit changed a path outside active WRITE claims.', [path]);
    }
  }
  const editedClaimedPaths = sortedUnique([...committedClaimedPaths, ...dirtyClaimedPaths]);
  if (editedClaimedPaths.length === 0) {
    fail('no-claimed-edits', 'source-changing DONE status produced no claimed source edits to commit or capture.');
  }
  assertSameSet('status.changed_paths', input.statusEntry.changed_paths, 'actual claimed changed paths', editedClaimedPaths);
  assertSameSet('audit.actual_changed_paths', input.audit.actual_changed_paths, 'actual claimed changed paths', editedClaimedPaths);
  const stagedOutsideClaims = status.stagedPaths
    .filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream))
    .filter((path) => !claimedWritePatterns.some((pattern) => matchesRepoPathPattern(path, pattern)));
  if (stagedOutsideClaims.length > 0) {
    fail('preexisting-staged-paths', 'execution-commit evidence refused staged source paths outside active WRITE claims.', stagedOutsideClaims);
  }

  let runtimeCommitCreated = false;
  let commitSubject = `autopilot captured child commit ${input.spec.unit_id} attempt ${String(input.spec.attempt)}`;
  if (dirtyClaimedPaths.length > 0) {
    runGit(['add', '--', ...dirtyClaimedPaths], input.spec.cwd, runtimeGitEnv());
    const staged = readGitStatus(input.spec.cwd);
    const stagedSource = staged.stagedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream));
    for (const stagedPath of stagedSource) {
      if (!dirtyClaimedPaths.includes(stagedPath)) {
        fail('staged-path-set-mismatch', 'runtime staging included a source path outside dirty claimed edits.', [stagedPath]);
      }
    }
    commitSubject = `autopilot runtime commit ${input.spec.unit_id} attempt ${String(input.spec.attempt)}`;
    runGit(['commit', '--no-verify', '-m', commitSubject], input.spec.cwd, runtimeGitEnv());
    runtimeCommitCreated = true;
  }

  const afterHead = gitHead(input.spec.cwd);
  const beforeHead = input.audit.baseline_head ?? headBeforeRuntimeCommit;
  if (afterHead === beforeHead) fail('commit-not-created', 'source-changing success did not advance or capture a changed HEAD.');
  const diffPaths = committedDiffPaths(input.spec.cwd, beforeHead, afterHead);
  assertSameSet('committed diff paths', diffPaths, 'actual claimed changed paths', editedClaimedPaths);

  const afterStatus = readGitStatus(input.spec.cwd);
  const afterSourceDirty = afterStatus.changedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream));
  if (afterSourceDirty.length > 0) {
    fail('post-commit-source-dirty', 'runtime commit left source paths dirty after commit.', afterSourceDirty);
  }

  const commitShas = commitRange(input.spec.cwd, beforeHead, afterHead);
  const commitOrigin = executionCommitOrigin(runtimeCommitCreated, committedClaimedPaths.length > 0);
  const commitPath = input.commitPath ?? deriveAutopilotExecutionCommitPath(input.spec);
  const record = parseAutopilotExecutionCommit({
    schema_version: 'autopilot.execution_commit.v1',
    workstream: input.spec.workstream,
    workstream_run: input.context.active.workstream_run,
    autopilot_id: input.context.active.autopilot_id,
    active_run_epoch: input.context.active.active_run_epoch,
    unit_id: input.spec.unit_id,
    role: input.spec.role,
    attempt: input.spec.attempt,
    cwd: input.spec.cwd,
    branch: input.context.active.branch,
    claimed_paths: claimedWritePatterns,
    edited_claimed_paths: editedClaimedPaths,
    before_head: beforeHead,
    after_head: afterHead,
    commit_sha: afterHead,
    commit_subject: commitSubject,
    commit_origin: commitOrigin,
    commit_shas: commitShas,
    status_ref: relativeArtifactRef(input.spec.status_output, input.context.active.runtime_root),
    receipt_ref: relativeArtifactRef(input.spec.receipt_output, input.context.active.runtime_root),
    audit_ref: relativeArtifactRef(input.auditPath, input.context.active.runtime_root),
    created_at: new Date().toISOString(),
  });
  await mkdir(dirname(commitPath), { recursive: true });
  await writeFile(commitPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

function activeWriteClaimPaths(input: {
  readonly spec: AutopilotUnitSpec;
  readonly context: ActiveAutopilotContext;
  readonly acquiredClaims: readonly AutopilotPathClaim[];
}): readonly string[] {
  const fromAcquired = input.acquiredClaims.filter((claim) =>
    claim.autopilot_id === input.context.active.autopilot_id &&
    claim.active_run_epoch === input.context.active.active_run_epoch &&
    claim.unit_id === input.spec.unit_id &&
    claim.attempt === input.spec.attempt &&
    (claim.claim_type === 'WRITE' || claim.claim_type === 'EXCLUSIVE'),
  ).map((claim) => claim.path);
  const unique = [...new Set(fromAcquired)].sort();
  if (unique.length === 0) {
    fail('missing-write-claims', 'source-changing runtime commit requires active WRITE claims for unit owned paths.');
  }
  return Object.freeze(unique);
}

function committedDiffPaths(cwd: string, beforeHead: string, afterHead: string): readonly string[] {
  const output = runGit(['diff', '--name-only', '-z', beforeHead, afterHead], cwd);
  return Object.freeze(output.split('\0').filter((path) => path.length > 0).map((path) => path.replace(/\\/gu, '/')).sort());
}

function commitRange(cwd: string, beforeHead: string, afterHead: string): readonly string[] {
  const output = runGit(['rev-list', '--reverse', `${beforeHead}..${afterHead}`], cwd);
  const shas = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return Object.freeze(shas.includes(afterHead) ? shas : [...shas, afterHead]);
}

function executionCommitOrigin(runtimeCommitCreated: boolean, childCommitCaptured: boolean): AutopilotExecutionCommitOrigin {
  if (runtimeCommitCreated && childCommitCaptured) return 'mixed';
  if (runtimeCommitCreated) return 'runtime';
  return 'child';
}

function runtimeGitEnv(): Record<string, string> {
  return {
    [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE,
    AUTOPILOT_RUNTIME_AUTHORITY: 'execution-commit',
    GIT_AUTHOR_NAME: 'autopilot-runtime',
    GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
    GIT_COMMITTER_NAME: 'autopilot-runtime',
    GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
  };
}

function assertSameSet(leftLabel: string, left: readonly string[], rightLabel: string, right: readonly string[]): void {
  const leftSet = sortedUnique(left);
  const rightSet = sortedUnique(right);
  if (leftSet.length !== rightSet.length || leftSet.some((value, index) => value !== rightSet[index])) {
    fail('path-set-mismatch', `${leftLabel} must equal ${rightLabel}.`, [
      `${leftLabel}=${JSON.stringify(leftSet)}`,
      `${rightLabel}=${JSON.stringify(rightSet)}`,
    ]);
  }
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function relativeArtifactRef(path: string, runtimeRoot: string): string {
  const rel = path.startsWith(runtimeRoot) ? path.slice(runtimeRoot.length).replace(/^\/+/, '') : path;
  return rel.replace(/\\/gu, '/');
}
