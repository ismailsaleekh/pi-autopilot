import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { gitHead, readGitStatus, releaseClaimsForUnit, runGit, updateUnitBranchStatus, writeJsonAtomic, type ActiveAutopilotContext } from './parallel-runtime.ts';
import { cleanupTerminalUnitWorktree } from './worktree-cleanup.ts';

export type AutopilotUnitFailureAction = 'quarantine' | 'reset' | 'preserve' | 'abort';

export interface AutopilotUnitFailureRecord {
  readonly schema_version: 'autopilot.unit_failure.v1';
  readonly action: AutopilotUnitFailureAction;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly unit_id: string;
  readonly attempt: number;
  readonly unit_worktree_path: string;
  readonly dirty_paths: readonly string[];
  readonly summary: string;
  readonly created_at: string;
}

export async function quarantineFailedUnit(input: {
  readonly context: ActiveAutopilotContext;
  readonly unitId: string;
  readonly attempt: number;
  readonly unitWorktreePath: string;
  readonly summary: string;
  readonly now?: Date;
}): Promise<AutopilotUnitFailureRecord> {
  const record = await writeFailureRecord({ ...input, action: 'quarantine' });
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha, archiveRef: null });
  await releaseClaimsForUnit(releaseInput(input, 'autopilot failed unit quarantine'));
  return record;
}

export async function resetFailedUnit(input: {
  readonly context: ActiveAutopilotContext;
  readonly unitId: string;
  readonly attempt: number;
  readonly unitWorktreePath: string;
  readonly summary: string;
  readonly now?: Date;
}): Promise<AutopilotUnitFailureRecord> {
  const record = await writeFailureRecord({ ...input, action: 'reset' });
  resetWorktreeForRecordedTransition(input.unitWorktreePath, 'unit-reset');
  await releaseClaimsForUnit(releaseInput(input, 'autopilot failed unit reset'));
  const currentSha = existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha;
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef: null });
  await cleanupTerminalUnitWorktree({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, allowedStatuses: ['aborted'], reason: 'autopilot failed unit reset cleanup', ...(input.now === undefined ? {} : { now: input.now }) });
  return record;
}

export async function preserveFailedUnit(input: {
  readonly context: ActiveAutopilotContext;
  readonly unitId: string;
  readonly attempt: number;
  readonly unitWorktreePath: string;
  readonly summary: string;
  readonly now?: Date;
}): Promise<AutopilotUnitFailureRecord> {
  const record = await writeFailureRecord({ ...input, action: 'preserve' });
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha, archiveRef: null });
  return record;
}

export async function abortFailedUnit(input: {
  readonly context: ActiveAutopilotContext;
  readonly unitId: string;
  readonly attempt: number;
  readonly unitWorktreePath: string;
  readonly summary: string;
  readonly now?: Date;
}): Promise<AutopilotUnitFailureRecord> {
  const record = await writeFailureRecord({ ...input, action: 'abort' });
  resetWorktreeForRecordedTransition(input.unitWorktreePath, 'unit-abort-reset');
  await releaseClaimsForUnit(releaseInput(input, 'autopilot failed unit abort'));
  const currentSha = existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha;
  const archiveRef = `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/aborted`;
  runGit(['update-ref', `refs/heads/${archiveRef}`, currentSha], input.context.active.source_repo, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-abort-archive' });
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef });
  await cleanupTerminalUnitWorktree({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, allowedStatuses: ['aborted'], reason: 'autopilot failed unit abort cleanup', ...(input.now === undefined ? {} : { now: input.now }) });
  return record;
}

function resetWorktreeForRecordedTransition(unitWorktreePath: string, authority: string): void {
  if (!existsSync(unitWorktreePath)) return;
  runGit(['reset', '--hard', 'HEAD'], unitWorktreePath, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: authority });
  runGit(['clean', '-fd'], unitWorktreePath, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: authority });
}

function releaseInput(input: {
  readonly context: ActiveAutopilotContext;
  readonly unitId: string;
  readonly attempt: number;
  readonly now?: Date;
}, reason: string): { readonly context: ActiveAutopilotContext; readonly unitId: string; readonly attempt: number; readonly reason: string; readonly now?: Date } {
  return input.now === undefined
    ? { context: input.context, unitId: input.unitId, attempt: input.attempt, reason }
    : { context: input.context, unitId: input.unitId, attempt: input.attempt, reason, now: input.now };
}

async function writeFailureRecord(input: {
  readonly context: ActiveAutopilotContext;
  readonly unitId: string;
  readonly attempt: number;
  readonly unitWorktreePath: string;
  readonly summary: string;
  readonly action: AutopilotUnitFailureAction;
  readonly now?: Date;
}): Promise<AutopilotUnitFailureRecord> {
  const now = input.now ?? new Date();
  const dirtyPaths = existsSync(input.unitWorktreePath) ? readGitStatus(input.unitWorktreePath).changedPaths : [];
  const record: AutopilotUnitFailureRecord = {
    schema_version: 'autopilot.unit_failure.v1',
    action: input.action,
    workstream: input.context.active.workstream,
    workstream_run: input.context.active.workstream_run,
    unit_id: input.unitId,
    attempt: input.attempt,
    unit_worktree_path: input.unitWorktreePath,
    dirty_paths: dirtyPaths,
    summary: input.summary,
    created_at: now.toISOString(),
  };
  const root = join(input.context.active.runtime_root, 'quarantine');
  await mkdir(root, { recursive: true });
  await writeJsonAtomic(join(root, `${input.unitId}.attempt-${String(input.attempt)}.${input.action}.json`), record);
  return record;
}
