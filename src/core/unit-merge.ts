import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parseAutopilotExecutionAudit, parseAutopilotExecutionCommit, parseAutopilotReceipt, parseAutopilotStatusEntry, type AutopilotExecutionAudit, type AutopilotExecutionCommit, type AutopilotReceipt, type AutopilotStatusEntry } from './contracts/index.ts';
import { gitHead, readGitStatus, releaseClaimsForUnit, updateUnitBranchStatus, withAutopilotFileLock, writeJsonAtomic, type ActiveAutopilotContext, type ActiveAutopilotRow, type ProcessEnvLike } from './parallel-runtime.ts';
import { gitQueryNulStrings, runGitMutation } from './git-process.ts';
import { cleanupTerminalUnitWorktree } from './worktree-cleanup.ts';
import { recordCoordinatorReleaseEvidenceFromFile } from './coordination/reconciliation.ts';
import { CoordinatorClient } from './coordination/client.ts';
import { CoordinationRuntimeError } from './coordination/failures.ts';
import { coordinationPathsOverlap, parseCoordinationObservation, parseCoordinationUnitAttempt } from './coordination/contracts.ts';
import { readCoordinatorSessionContext } from './coordination/supervisor.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from './names.ts';
import { executeOwnedWorktreeSaga, inspectOwnedWorktreeSpecPostcondition, WorktreeSagaCompensatedError } from './coordination/worktree-saga.ts';
import { recordValidationStalenessForMerge } from './validation-staleness.ts';
import { classifyCoordinationIntegrationConflict } from './coordination/integration-conflicts.ts';
import type { CoordinationObservation, CoordinationUnitAttempt } from './coordination/types.ts';

export interface AutopilotUnitMerge {
  readonly schema_version: 'autopilot.unit_merge.v1';
  readonly workstream: string;
  readonly workstream_run: string;
  readonly autopilot_id: string;
  readonly active_run_epoch: number;
  readonly unit_id: string;
  readonly role: 'implement' | 'fix';
  readonly attempt: number;
  readonly unit_branch: string;
  readonly main_branch: string;
  readonly unit_head: string;
  readonly integration_before: string;
  readonly integration_after: string;
  readonly merge_commit_sha: string;
  readonly changed_paths: readonly string[];
  readonly status_ref: string;
  readonly receipt_ref: string;
  readonly audit_ref: string;
  readonly execution_commit_ref: string;
  readonly merged_at: string;
}

export interface AutopilotUnitMergeResult {
  readonly outcome: 'merged' | 'conflict' | 'blocked';
  readonly merge: AutopilotUnitMerge | null;
  readonly blockers: readonly string[];
  readonly conflict_path: string | null;
  readonly integration_analysis_path: string | null;
}

export class AutopilotUnitMergeError extends Error {
  override readonly name = 'AutopilotUnitMergeError';
  readonly code: string;
  readonly evidence: readonly string[];

  constructor(code: string, message: string, evidence: readonly string[] = []) {
    super(`AutopilotUnitMergeError [${code}]: ${message}`);
    this.code = code;
    this.evidence = Object.freeze([...evidence]);
  }
}

function fail(code: string, message: string, evidence: readonly string[] = []): never {
  throw new AutopilotUnitMergeError(code, message, evidence);
}

export async function mergeAutopilotUnit(input: {
  readonly context: ActiveAutopilotContext;
  readonly unitId: string;
  readonly attempt: number;
  readonly statusPath: string;
  readonly receiptPath: string;
  readonly auditPath: string;
  readonly executionCommitPath: string;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
}): Promise<AutopilotUnitMergeResult> {
  const now = input.now ?? new Date();
  const active = input.context.active;
  return await withAutopilotFileLock(join(active.runtime_root, '.locks', 'unit-merge.lock'), `unit-merge:${active.autopilot_id}:${input.unitId}:${String(input.attempt)}`, async () => {
    const status = parseAutopilotStatusEntry(await readJsonFile(input.statusPath));
    const receipt = parseAutopilotReceipt(await readJsonFile(input.receiptPath));
    const audit = parseAutopilotExecutionAudit(await readJsonFile(input.auditPath));
    const executionCommit = parseAutopilotExecutionCommit(await readJsonFile(input.executionCommitPath));
    const blockers = mergePreflightBlockers(active, input.unitId, input.attempt, status, receipt, audit, executionCommit);
    if (blockers.length > 0) return { outcome: 'blocked', merge: null, blockers, conflict_path: null, integration_analysis_path: null };
    if (active.coordination_authority === 'coordinator-edit-leases-v1') {
      const observationBlockers = await activeMainObservationBlockers(active, executionCommit.edited_claimed_paths, input.env ?? process.env);
      if (observationBlockers.length > 0) return { outcome: 'blocked', merge: null, blockers: observationBlockers, conflict_path: null, integration_analysis_path: null };
    }
    const unitBranch = executionCommit.branch;
    const unitHead = gitHead(executionCommit.cwd);
    const validatedUnitHead = executionCommit.commit_sha;
    if (unitHead !== validatedUnitHead) {
      return {
        outcome: 'blocked',
        merge: null,
        blockers: [`unit worktree HEAD ${unitHead} does not match execution commit ${validatedUnitHead}`],
        conflict_path: null,
        integration_analysis_path: null,
      };
    }
    const mergePath = join(active.runtime_root, 'unit-merges', `${input.unitId}.${executionCommit.role}.attempt-${String(input.attempt)}.json`);
    const mergeIntentPath = join(active.runtime_root, 'unit-merge-intents', `${input.unitId}.${executionCommit.role}.attempt-${String(input.attempt)}.json`);
    let before: string;
    if (existsSync(mergeIntentPath)) {
      const intent = await readJsonFile(mergeIntentPath);
      if (!isRecord(intent) || intent['schema_version'] !== 'autopilot.unit_merge_intent.v1' || intent['workstream_run'] !== active.workstream_run || intent['autopilot_id'] !== active.autopilot_id || intent['unit_id'] !== input.unitId || intent['attempt'] !== input.attempt || intent['unit_head'] !== validatedUnitHead || typeof intent['integration_before'] !== 'string') fail('merge-intent-mismatch', 'durable unit-merge intent does not match the exact attempt authority.', [mergeIntentPath]);
      before = intent['integration_before'];
    } else {
      before = gitHead(active.main_worktree_path);
      await writeJsonAtomic(mergeIntentPath, { schema_version: 'autopilot.unit_merge_intent.v1', workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id, unit_id: input.unitId, role: executionCommit.role, attempt: input.attempt, unit_head: validatedUnitHead, integration_before: before, created_at: now.toISOString() });
    }
    const conflictPath = join(active.runtime_root, 'merge-conflicts', `${input.unitId}.attempt-${String(input.attempt)}.${timestamp(now)}.json`);
    const integrationAnalysisPath = executionCommit.edited_claimed_paths.length === 0 ? null : join(active.runtime_root, 'integration-analyses', `${input.unitId}.attempt-${String(input.attempt)}.json`);
    if (integrationAnalysisPath !== null) {
      const integrationConflict = classifyCoordinationIntegrationConflict({ repoRoot: active.source_repo, predecessorCommit: before, dependentCommit: validatedUnitHead, overlappingPaths: executionCommit.edited_claimed_paths });
      if (existsSync(integrationAnalysisPath)) {
        const existing = await readJsonFile(integrationAnalysisPath);
        if (!isRecord(existing) || existing['schema_version'] !== 'autopilot.integration_analysis.v1' || existing['workstream_run'] !== active.workstream_run || existing['unit_id'] !== input.unitId || existing['attempt'] !== input.attempt || existing['integration_before'] !== before || existing['unit_head'] !== validatedUnitHead || !isRecord(existing['classification']) || existing['classification']['classification_id'] !== integrationConflict.classification_id) fail('integration-analysis-drift', 'immutable integration analysis differs on replay; create a repair attempt instead of overwriting evidence.', [integrationAnalysisPath]);
      } else {
        await writeJsonAtomic(integrationAnalysisPath, { schema_version: 'autopilot.integration_analysis.v1', workstream: active.workstream, workstream_run: active.workstream_run, unit_id: input.unitId, attempt: input.attempt, integration_before: before, unit_head: validatedUnitHead, classification: integrationConflict, created_at: now.toISOString() });
      }
      if (integrationConflict.disposition === 'repair-required') {
        await writeJsonAtomic(conflictPath, { schema_version: 'autopilot.merge_conflict.v1', workstream: active.workstream, workstream_run: active.workstream_run, unit_id: input.unitId, attempt: input.attempt, unit_branch: unitBranch, integration_head: before, dirty_paths: [], abort_status: 0, error: `integration classification requires repair: ${integrationConflict.kind}`, integration_analysis_ref: relativeRuntimeRef(active.runtime_root, integrationAnalysisPath), classification: integrationConflict, created_at: now.toISOString() });
        return { outcome: 'conflict', merge: null, blockers: [`${integrationConflict.kind}: integration repair required before merge`], conflict_path: conflictPath, integration_analysis_path: integrationAnalysisPath };
      }
    }
    let durableMerge: AutopilotUnitMerge | null = null;
    const persistMergeEvidence = async (): Promise<AutopilotUnitMerge> => {
      if (existsSync(mergePath)) {
        const existing = parseAutopilotUnitMerge(await readJsonFile(mergePath));
        if (existing.workstream_run !== active.workstream_run || existing.autopilot_id !== active.autopilot_id || existing.unit_id !== input.unitId || existing.attempt !== input.attempt || existing.unit_head !== validatedUnitHead || existing.integration_before !== before) fail('merge-evidence-mismatch', 'existing immutable unit-merge evidence disagrees with its durable merge intent.', [mergePath]);
        return existing;
      }
      const after = gitHead(active.main_worktree_path);
      const merge: AutopilotUnitMerge = {
        schema_version: 'autopilot.unit_merge.v1', workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id,
        active_run_epoch: active.active_run_epoch, unit_id: input.unitId, role: executionCommit.role, attempt: input.attempt, unit_branch: unitBranch,
        main_branch: active.branch, unit_head: validatedUnitHead, integration_before: before, integration_after: after, merge_commit_sha: after,
        changed_paths: diffPaths(active.main_worktree_path, before, after), status_ref: relativeRuntimeRef(active.runtime_root, input.statusPath),
        receipt_ref: relativeRuntimeRef(active.runtime_root, input.receiptPath), audit_ref: relativeRuntimeRef(active.runtime_root, input.auditPath),
        execution_commit_ref: relativeRuntimeRef(active.runtime_root, input.executionCommitPath), merged_at: now.toISOString(),
      };
      await writeJsonAtomic(mergePath, merge);
      return merge;
    };
    const mergeSpec = {
      active,
      unitId: 'main',
      attempt: 1,
      kind: 'main' as const,
      operationType: 'merge' as const,
      initialWorktreeState: 'active' as const,
      committedWorktreeState: 'active' as const,
      intent: {
        repo_root: active.source_repo,
        worktree_path: active.main_worktree_path,
        git_common_dir: active.git_common_dir,
        branch: active.branch,
        reason: `merge accepted unit ${input.unitId} attempt ${String(input.attempt)}`,
        base_sha: before,
        target_sha: validatedUnitHead,
        archive_ref: null,
        checkout_mode: null,
        sparse_patterns: [],
        paths: executionCommit.edited_claimed_paths,
        metadata_refs: [relativeRuntimeRef(active.runtime_root, join(active.runtime_root, 'unit-merges', `${input.unitId}.${executionCommit.role}.attempt-${String(input.attempt)}.json`))],
      },
    };
    try {
      await executeOwnedWorktreeSaga(mergeSpec, {
        action: async () => {
          const merge = await runGitMutation({ descriptor: { kind: 'merge', mode: 'no-ff', message: `autopilot unit merge ${active.workstream_run} ${input.unitId} attempt ${String(input.attempt)}`, target: validatedUnitHead }, cwd: active.main_worktree_path, env: runtimeGitEnv('unit-merge', input.env) });
          const postcondition = inspectOwnedWorktreeSpecPostcondition(mergeSpec, input.env ?? process.env);
          if (postcondition.effect_applied) return;
          if (postcondition.outcome === 'unsafe') throw new CoordinationRuntimeError('recovery-required', 'unit merge canonical probe found unsafe repository state', postcondition.proof);
          if (!postcondition.proof.includes('interrupted_merge')) throw new CoordinationRuntimeError('recovery-required', 'unit merge did not apply and left no canonically compensable merge state', [...postcondition.proof, `mutation_report=${merge.kind}`, `mutation_diagnostic=${merge.diagnostic}`]);
          const dirty = readGitStatus(active.main_worktree_path).changedPaths;
          const abort = await runGitMutation({ descriptor: { kind: 'merge-abort' }, cwd: active.main_worktree_path, env: runtimeGitEnv('unit-merge-abort', input.env) });
          await writeJsonAtomic(conflictPath, {
            schema_version: 'autopilot.merge_conflict.v1', workstream: active.workstream, workstream_run: active.workstream_run,
            unit_id: input.unitId, attempt: input.attempt, unit_branch: unitBranch, integration_head: before,
            dirty_paths: dirty, abort_status: abort.kind === 'reported' ? abort.exitCode : -1, error: merge.diagnostic, created_at: now.toISOString(),
          });
          const restored = inspectOwnedWorktreeSpecPostcondition(mergeSpec, input.env ?? process.env);
          if (restored.outcome !== 'not-applied' || restored.effect_applied || restored.proof.includes('interrupted_merge')) fail('merge-abort-failed', 'unit merge conflicted and canonical abort probe did not restore the pre-merge state.', [abort.diagnostic, conflictPath, ...restored.proof]);
          throw new WorktreeSagaCompensatedError('unit merge conflicted and was cleanly aborted', [`conflict_path=${conflictPath}`, `integration_head=${before}`, `unit_head=${validatedUnitHead}`]);
        },
        finalize: async () => {
          durableMerge = await persistMergeEvidence();
          const validationEvidenceRefs = await listValidationEvidenceRefs(active.runtime_root);
          if (validationEvidenceRefs.length > 0) await recordValidationStalenessForMerge({
            runtimeRoot: active.runtime_root,
            workstream: active.workstream,
            invalidatingMergeRef: relativeRuntimeRef(active.runtime_root, mergePath),
            validationEvidenceRefs,
            now,
          });
        },
      }, input.env ?? process.env);
    } catch (error) {
      if (error instanceof WorktreeSagaCompensatedError) return { outcome: 'conflict', merge: null, blockers: [], conflict_path: conflictPath, integration_analysis_path: integrationAnalysisPath };
      throw error;
    }
    const merge = durableMerge ?? parseAutopilotUnitMerge(JSON.parse(await readFile(mergePath, 'utf8')) as unknown);
    if (active.coordination_authority === 'coordinator-edit-leases-v1') await recordCoordinatorReleaseEvidenceFromFile({
      active,
      source: 'unit-merge',
      targetId: `${input.unitId}:${String(input.attempt)}`,
      evidencePath: mergePath,
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    if (active.coordination_authority === 'legacy-path-claims-v1') {
      await releaseClaimsForUnit({ context: input.context, unitId: input.unitId, attempt: input.attempt, reason: 'autopilot unit merge release', now });
    }
    const archiveRef = `autopilot/archive/${active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}`;
    await executeOwnedWorktreeSaga({
      active, unitId: input.unitId, attempt: input.attempt, kind: 'unit', operationType: 'archive',
      initialWorktreeState: 'active', committedWorktreeState: 'terminal',
      intent: {
        repo_root: active.source_repo, worktree_path: executionCommit.cwd, git_common_dir: active.git_common_dir, branch: unitBranch,
        reason: 'archive accepted unit branch before retirement', base_sha: executionCommit.before_head, target_sha: validatedUnitHead,
        archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: executionCommit.edited_claimed_paths, metadata_refs: [],
      },
    }, {
      action: async () => { await runGitMutation({ descriptor: { kind: 'update-ref-create', ref: `refs/heads/${archiveRef}`, target: validatedUnitHead, expectedOld: '0'.repeat(40) }, cwd: active.source_repo, env: runtimeGitEnv('unit-archive', input.env) }); },
    }, input.env ?? process.env);
    await updateUnitBranchStatus({ active, unitId: input.unitId, attempt: input.attempt, status: 'merged', currentSha: validatedUnitHead, archiveRef });
    await cleanupTerminalUnitWorktree({
      active,
      unitId: input.unitId,
      attempt: input.attempt,
      allowedStatuses: ['merged'],
      reason: 'autopilot unit merge cleanup',
      ...(input.env === undefined ? {} : { env: input.env }),
      now,
    });
    return { outcome: 'merged', merge, blockers: [], conflict_path: null, integration_analysis_path: integrationAnalysisPath };
  });
}

async function activeMainObservationBlockers(active: ActiveAutopilotRow, changedPaths: readonly string[], env: ProcessEnvLike): Promise<readonly string[]> {
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) fail('coordinator-session-missing', 'unit merge requires the current owner session before mutating the shared run main worktree.');
  const session = await readCoordinatorSessionContext(contextPath);
  if (session.repo_id !== active.repo_key || session.autopilot_id !== active.autopilot_id || session.workstream_run !== active.workstream_run) fail('coordinator-session-mismatch', 'unit merge session does not own the run main worktree.', [session.workstream_run, active.workstream_run]);
  const response = await new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }).query('status', session.repo_id, session.workstream_run);
  const raw = response.payload['observations'];
  const rawAttempts = response.payload['unit_attempts'];
  if (!Array.isArray(raw) || !Array.isArray(rawAttempts)) fail('coordinator-status-invalid', 'coordinator status observations/unit_attempts are not arrays.');
  return mainWorktreeObservationBlockers(raw.map(parseCoordinationObservation), rawAttempts.map(parseCoordinationUnitAttempt), active.workstream_run, changedPaths);
}

export function mainWorktreeObservationBlockers(observations: readonly CoordinationObservation[], attempts: readonly CoordinationUnitAttempt[], workstreamRun: string, changedPaths: readonly string[]): readonly string[] {
  const attemptRoles = new Map(attempts.map((attempt) => [`${attempt.owner.unit_id}\0${String(attempt.owner.attempt)}`, attempt.role] as const));
  const activeObservations = observations.filter((observation) => {
    if (observation.owner.workstream_run !== workstreamRun || observation.execution_state !== 'active' || !changedPaths.some((path) => coordinationPathsOverlap(path, observation.path))) return false;
    const role = attemptRoles.get(`${observation.owner.unit_id}\0${String(observation.owner.attempt)}`);
    // Implement/fix readers own immutable bytes in separate unit worktrees and
    // cannot block run-main integration. Main-worktree validators/bughunts still
    // fence the physical checkout mutation until their observation terminates.
    return role !== 'implement' && role !== 'fix';
  });
  return Object.freeze(activeObservations.map((observation) => `run-main integration waits for active main-worktree observation ${observation.observation_id} on ${observation.path}`));
}

export function parseAutopilotUnitMerge(value: unknown): AutopilotUnitMerge {
  if (!isRecord(value)) fail('invalid-unit-merge', 'unit merge evidence must be an object.');
  return {
    schema_version: expectConst(value, 'schema_version', 'autopilot.unit_merge.v1'),
    workstream: expectString(value, 'workstream'),
    workstream_run: expectString(value, 'workstream_run'),
    autopilot_id: expectString(value, 'autopilot_id'),
    active_run_epoch: expectInteger(value, 'active_run_epoch'),
    unit_id: expectString(value, 'unit_id'),
    role: expectRole(value),
    attempt: expectInteger(value, 'attempt'),
    unit_branch: expectString(value, 'unit_branch'),
    main_branch: expectString(value, 'main_branch'),
    unit_head: expectString(value, 'unit_head'),
    integration_before: expectString(value, 'integration_before'),
    integration_after: expectString(value, 'integration_after'),
    merge_commit_sha: expectString(value, 'merge_commit_sha'),
    changed_paths: expectStringArray(value, 'changed_paths'),
    status_ref: expectString(value, 'status_ref'),
    receipt_ref: expectString(value, 'receipt_ref'),
    audit_ref: expectString(value, 'audit_ref'),
    execution_commit_ref: expectString(value, 'execution_commit_ref'),
    merged_at: expectString(value, 'merged_at'),
  };
}

function mergePreflightBlockers(active: ActiveAutopilotRow, unitId: string, attempt: number, status: AutopilotStatusEntry, receipt: AutopilotReceipt, audit: AutopilotExecutionAudit, executionCommit: AutopilotExecutionCommit): readonly string[] {
  const blockers: string[] = [];
  if (status.workstream !== active.workstream || receipt.workstream !== active.workstream || audit.workstream !== active.workstream || executionCommit.workstream !== active.workstream) blockers.push('workstream identity mismatch across unit evidence');
  if (status.unit_id !== unitId || receipt.unit_id !== unitId || audit.unit_id !== unitId || executionCommit.unit_id !== unitId) blockers.push('unit identity mismatch across unit evidence');
  if (status.attempt !== attempt || receipt.attempt !== attempt || audit.attempt !== attempt || executionCommit.attempt !== attempt) blockers.push('attempt mismatch across unit evidence');
  if (status.verdict !== 'DONE') blockers.push(`source-changing unit status verdict must be DONE, got ${status.verdict}`);
  if (audit.classification !== 'clean') blockers.push(`execution audit must be clean, got ${audit.classification}`);
  if (executionCommit.autopilot_id !== active.autopilot_id || executionCommit.workstream_run !== active.workstream_run) blockers.push('execution commit durable run authority does not match active workstream');
  if (!existsSync(executionCommit.cwd)) blockers.push(`unit worktree is missing: ${executionCommit.cwd}`);
  if (existsSync(executionCommit.cwd) && readGitStatus(executionCommit.cwd).changedPaths.length > 0) blockers.push('unit worktree must be clean before mergeback');
  return Object.freeze(blockers);
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    fail('json-read-failed', `failed to read ${path}: ${errorMessage(error)}`);
  }
}

function diffPaths(cwd: string, left: string, right: string): readonly string[] {
  return Object.freeze(gitQueryNulStrings({ descriptor: { kind: 'diff-paths', from: left, to: right, noRenames: true }, cwd }).map((path) => path.replace(/\\/gu, '/')).sort((leftPath, rightPath) => leftPath.localeCompare(rightPath)));
}

function relativeRuntimeRef(runtimeRoot: string, absolutePath: string): string {
  const normalizedRoot = runtimeRoot.endsWith('/') ? runtimeRoot : `${runtimeRoot}/`;
  if (!absolutePath.startsWith(normalizedRoot)) fail('artifact-outside-runtime-root', 'unit merge artifact ref is outside authoritative runtime root.', [absolutePath, runtimeRoot]);
  return absolutePath.slice(normalizedRoot.length);
}

async function listValidationEvidenceRefs(runtimeRoot: string): Promise<readonly string[]> {
  const root = join(runtimeRoot, 'validation');
  if (!existsSync(root)) return Object.freeze([]);
  const refs: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) refs.push(relativeRuntimeRef(runtimeRoot, path));
    }
  };
  await walk(root);
  return Object.freeze(refs.sort((left, right) => left.localeCompare(right)));
}

function runtimeGitEnv(authority: string, env: ProcessEnvLike = process.env): Record<string, string> {
  return {
    ...process.env,
    ...env,
    AUTOPILOT_RUNTIME: '1',
    AUTOPILOT_RUNTIME_AUTHORITY: authority,
    GIT_AUTHOR_NAME: 'autopilot-runtime',
    GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
    GIT_COMMITTER_NAME: 'autopilot-runtime',
    GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
  };
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail('invalid-unit-merge', `${key} must be a non-empty string.`);
  return value;
}

function expectInteger(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) fail('invalid-unit-merge', `${key} must be an integer.`);
  return value as number;
}

function expectConst<T extends string>(record: Readonly<Record<string, unknown>>, key: string, expected: T): T {
  const value = record[key];
  if (value !== expected) fail('invalid-unit-merge', `${key} must equal ${expected}.`);
  return expected;
}

function expectStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) fail('invalid-unit-merge', `${key} must be a string array.`);
  return Object.freeze([...value]);
}

function expectRole(record: Readonly<Record<string, unknown>>): 'implement' | 'fix' {
  const role = expectString(record, 'role');
  if (role !== 'implement' && role !== 'fix') fail('invalid-unit-merge', 'role must be implement or fix.');
  return role;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
