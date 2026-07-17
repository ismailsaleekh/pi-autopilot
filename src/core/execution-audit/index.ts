import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import { parseAutopilotExecutionAudit } from '../contracts/index.ts';
import {
  AUTOPILOT_EXECUTION_AUDIT_PATH_SET_VALUES,
  type AutopilotAuditClassification,
  type AutopilotExecutionAudit,
  type AutopilotExecutionAuditPathCounts,
  type AutopilotExecutionAuditPathSet,
  type AutopilotHeadChangeKind,
  type AutopilotStatusEntry,
  type AutopilotUnitSpec,
} from '../contracts/types.ts';
import { GitQueryError, gitQueryNulStrings, runGitQuery } from '../git-process.ts';

export interface AutopilotExecutionBaseline {
  readonly cwd: string;
  readonly available: boolean;
  readonly gitHead: string | null;
  readonly dirtyPaths: readonly string[];
  readonly summary: string;
}

interface GitStatusSnapshot {
  readonly available: boolean;
  readonly gitHead: string | null;
  readonly changedPaths: readonly string[];
  readonly summary: string;
}

interface BoundedAuditPathSet {
  readonly paths: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
}

const EXECUTION_AUDIT_PATH_SET_LIMIT = 500;

export async function captureAutopilotExecutionBaseline(
  cwd: string,
): Promise<AutopilotExecutionBaseline> {
  const snapshot = readGitStatusSnapshot(cwd);
  return Object.freeze({
    cwd,
    available: snapshot.available,
    gitHead: snapshot.gitHead,
    dirtyPaths: snapshot.changedPaths,
    summary: snapshot.summary,
  });
}

export function deriveAutopilotExecutionAuditPath(spec: AutopilotUnitSpec): string {
  return resolve(
    deriveAutopilotArtifactRootFromStatus(spec.status_output),
    'execution-audits',
    `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.json`,
  );
}

export async function writeAutopilotExecutionAudit(input: {
  readonly unitSpec: AutopilotUnitSpec;
  readonly baseline: AutopilotExecutionBaseline;
  readonly statusEntry: AutopilotStatusEntry | null;
  readonly auditPath?: string;
}): Promise<AutopilotExecutionAudit> {
  const postRun = readGitStatusSnapshot(input.unitSpec.cwd);
  const audit = buildAutopilotExecutionAudit({
    unitSpec: input.unitSpec,
    baseline: input.baseline,
    postRun,
    statusEntry: input.statusEntry,
  });
  const parsed = parseAutopilotExecutionAudit(audit);
  const auditPath = input.auditPath ?? deriveAutopilotExecutionAuditPath(input.unitSpec);
  await mkdir(dirname(auditPath), { recursive: true });
  await writeFile(auditPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return parsed;
}

export function buildAutopilotExecutionAudit(input: {
  readonly unitSpec: AutopilotUnitSpec;
  readonly baseline: AutopilotExecutionBaseline;
  readonly postRun: GitStatusSnapshot;
  readonly statusEntry: AutopilotStatusEntry | null;
}): AutopilotExecutionAudit {
  const auditAvailable = input.baseline.available && input.postRun.available;
  const runtimeRoot = runtimeRootRelativePrefix(input.unitSpec);
  const baselineDirtyPathsFull = auditAvailable
    ? input.baseline.dirtyPaths.filter((path) => !matchesPathPattern(path, runtimeRoot))
    : [];
  const baselineDirty = baselineDirtyPathsFull.length > 0;
  const dirtyRelevantPathsFull = baselineDirtyPathsFull.filter((path) =>
    matchesPathPatterns(path, relevantDirtyPathPatterns(input.unitSpec)),
  );
  const headChangeKind = classifyHeadChange(input.unitSpec.cwd, input.baseline.gitHead, input.postRun.gitHead, auditAvailable);
  const committedChangedPathsFull = auditAvailable
    ? committedChangedPaths(input.unitSpec.cwd, input.baseline.gitHead, input.postRun.gitHead).filter(
        (path) => !matchesPathPattern(path, runtimeRoot),
      )
    : [];
  const dirtyChangedPathsFull = auditAvailable
    ? sortedDifference(input.postRun.changedPaths, baselineDirtyPathsFull).filter(
        (path) => !matchesPathPattern(path, runtimeRoot),
      )
    : [];
  const actualChangedPathsFull = sortedUnique([...committedChangedPathsFull, ...dirtyChangedPathsFull]);
  const statusReportedChangedPathsFull = sortedUnique(input.statusEntry?.changed_paths ?? []);
  const omittedStatusChangesFull = auditAvailable
    ? sortedDifference(actualChangedPathsFull, statusReportedChangedPathsFull)
    : [];
  const reportedButNotActualChangesFull = auditAvailable
    ? sortedDifference(statusReportedChangedPathsFull, actualChangedPathsFull)
    : [];
  const outsideOwnedPathsFull = actualChangedPathsFull.filter(
    (path) => !matchesPathPatterns(path, input.unitSpec.owned_paths),
  );
  const readOnlyTouchedPathsFull = actualChangedPathsFull.filter((path) =>
    matchesPathPatterns(path, input.unitSpec.read_only_paths),
  );
  const untouchableTouchedPathsFull = actualChangedPathsFull.filter((path) =>
    matchesPathPatterns(path, input.unitSpec.untouchable_paths),
  );
  const dirtyRelevantPaths = boundedAuditPathSet(dirtyRelevantPathsFull);
  const boundedPathSets = Object.freeze({
    dirty_baseline_paths: boundedAuditPathSet(baselineDirtyPathsFull, dirtyRelevantPaths.paths),
    dirty_relevant_paths: dirtyRelevantPaths,
    actual_changed_paths: boundedAuditPathSet(actualChangedPathsFull),
    status_reported_changed_paths: boundedAuditPathSet(statusReportedChangedPathsFull),
    omitted_status_changes: boundedAuditPathSet(omittedStatusChangesFull),
    reported_but_not_actual_changes: boundedAuditPathSet(reportedButNotActualChangesFull),
    outside_owned_paths: boundedAuditPathSet(outsideOwnedPathsFull),
    read_only_touched_paths: boundedAuditPathSet(readOnlyTouchedPathsFull),
    untouchable_touched_paths: boundedAuditPathSet(untouchableTouchedPathsFull),
  } satisfies Record<AutopilotExecutionAuditPathSet, BoundedAuditPathSet>);
  const pathCounts = executionAuditPathCounts(boundedPathSets);
  const truncatedPathSets = truncatedAuditPathSets(boundedPathSets);
  const statusReportedCommands = sortedUnique(
    (input.statusEntry?.commands ?? []).map((command) => command.command),
  );
  const declaredValidationCommands = sortedUnique(input.unitSpec.validation_commands);
  const commandCoverageGaps = sortedDifference(declaredValidationCommands, statusReportedCommands);
  const classification = classifyAudit({
    auditAvailable,
    dirtyRelevantPaths: dirtyRelevantPathsFull,
    outsideOwnedPaths: outsideOwnedPathsFull,
    readOnlyTouchedPaths: readOnlyTouchedPathsFull,
    untouchableTouchedPaths: untouchableTouchedPathsFull,
    omittedStatusChanges: omittedStatusChangesFull,
    reportedButNotActualChanges: reportedButNotActualChangesFull,
    commandCoverageGaps,
    truncatedPathSets,
    headChangeKind,
  });
  return Object.freeze({
    schema_version: 'autopilot.execution_audit.v1',
    workstream: input.unitSpec.workstream,
    unit_id: input.unitSpec.unit_id,
    role: input.unitSpec.role,
    attempt: input.unitSpec.attempt,
    audited_at: new Date().toISOString(),
    cwd: input.unitSpec.cwd,
    git_head: input.baseline.gitHead ?? input.postRun.gitHead,
    baseline_head: input.baseline.gitHead,
    post_run_head: input.postRun.gitHead,
    head_change_kind: headChangeKind,
    committed_changed_paths: boundedAuditPathSet(committedChangedPathsFull).paths,
    dirty_baseline: auditAvailable ? baselineDirty : null,
    dirty_baseline_paths: boundedPathSets.dirty_baseline_paths.paths,
    dirty_relevant_paths: boundedPathSets.dirty_relevant_paths.paths,
    actual_changed_paths: boundedPathSets.actual_changed_paths.paths,
    status_reported_changed_paths: boundedPathSets.status_reported_changed_paths.paths,
    omitted_status_changes: boundedPathSets.omitted_status_changes.paths,
    reported_but_not_actual_changes: boundedPathSets.reported_but_not_actual_changes.paths,
    outside_owned_paths: boundedPathSets.outside_owned_paths.paths,
    read_only_touched_paths: boundedPathSets.read_only_touched_paths.paths,
    untouchable_touched_paths: boundedPathSets.untouchable_touched_paths.paths,
    path_counts: pathCounts,
    truncated_path_sets: truncatedPathSets,
    declared_validation_commands: declaredValidationCommands,
    status_reported_commands: statusReportedCommands,
    command_coverage_gaps: commandCoverageGaps,
    classification,
    evidence_refs: [],
    summary: auditSummary({
      classification,
      auditAvailable,
      baselineDirty,
      dirtyRelevantPathCount: dirtyRelevantPathsFull.length,
      truncatedPathSets,
    }),
  });
}

function classifyAudit(input: {
  readonly auditAvailable: boolean;
  readonly dirtyRelevantPaths: readonly string[];
  readonly outsideOwnedPaths: readonly string[];
  readonly readOnlyTouchedPaths: readonly string[];
  readonly untouchableTouchedPaths: readonly string[];
  readonly omittedStatusChanges: readonly string[];
  readonly reportedButNotActualChanges: readonly string[];
  readonly commandCoverageGaps: readonly string[];
  readonly truncatedPathSets: readonly AutopilotExecutionAuditPathSet[];
  readonly headChangeKind: AutopilotHeadChangeKind;
}): AutopilotAuditClassification {
  if (input.untouchableTouchedPaths.length > 0) return 'critical-protected-path-violation';
  if (input.readOnlyTouchedPaths.length > 0) return 'protected-path-review-required';
  if (
    !input.auditAvailable ||
    input.dirtyRelevantPaths.length > 0 ||
    input.truncatedPathSets.length > 0 ||
    input.headChangeKind === 'rewrite' ||
    input.headChangeKind === 'unavailable'
  ) {
    return 'audit-unavailable';
  }
  if (
    input.outsideOwnedPaths.length > 0 ||
    input.omittedStatusChanges.length > 0 ||
    input.reportedButNotActualChanges.length > 0 ||
    input.commandCoverageGaps.length > 0
  ) {
    return 'scope-review-required';
  }
  return 'clean';
}

function auditSummary(input: {
  readonly classification: AutopilotAuditClassification;
  readonly auditAvailable: boolean;
  readonly baselineDirty: boolean;
  readonly dirtyRelevantPathCount: number;
  readonly truncatedPathSets: readonly AutopilotExecutionAuditPathSet[];
}): string {
  if (!input.auditAvailable) return 'Execution audit could not read git status; semantic closure requires review.';
  if (input.dirtyRelevantPathCount > 0) {
    return 'Execution audit found dirty baseline paths on unit-owned or protected surfaces; semantic closure requires attribution review.';
  }
  if (input.truncatedPathSets.length > 0) {
    return `Execution audit truncated ${input.truncatedPathSets.join(', ')} evidence to schema limits; semantic closure requires review.`;
  }
  if (input.classification === 'clean' && input.baselineDirty) {
    return 'Execution audit is clean; unrelated dirty baseline paths are recorded as caveats.';
  }
  if (input.classification === 'clean') return 'Execution audit is clean.';
  return `Execution audit classified this attempt as ${input.classification}.`;
}

function classifyHeadChange(
  cwd: string,
  baselineHead: string | null,
  postRunHead: string | null,
  auditAvailable: boolean,
): AutopilotHeadChangeKind {
  if (!auditAvailable) return 'unavailable';
  if (baselineHead === null || postRunHead === null) return 'unavailable';
  if (baselineHead === postRunHead) return 'none';
  return isAncestor(cwd, baselineHead, postRunHead) ? 'fast-forward' : 'rewrite';
}

function committedChangedPaths(
  cwd: string,
  baselineHead: string | null,
  postRunHead: string | null,
): readonly string[] {
  if (baselineHead === null || postRunHead === null || baselineHead === postRunHead) return [];
  return Object.freeze(gitQueryNulStrings({ descriptor: { kind: 'diff-paths', from: baselineHead, to: postRunHead }, cwd }).map(toPosixRelativePath).sort());
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return !runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor, descendant }, cwd }).negative;
}

function boundedAuditPathSet(
  paths: readonly string[],
  priorityPaths: readonly string[] = [],
): BoundedAuditPathSet {
  const uniquePaths = sortedUnique(paths);
  if (uniquePaths.length <= EXECUTION_AUDIT_PATH_SET_LIMIT) {
    return Object.freeze({ paths: uniquePaths, count: uniquePaths.length, truncated: false });
  }
  const uniquePathSet = new Set(uniquePaths);
  const selected = new Set<string>();
  for (const path of sortedUnique(priorityPaths)) {
    if (!uniquePathSet.has(path)) continue;
    selected.add(path);
    if (selected.size >= EXECUTION_AUDIT_PATH_SET_LIMIT) break;
  }
  for (const path of uniquePaths) {
    if (selected.size >= EXECUTION_AUDIT_PATH_SET_LIMIT) break;
    selected.add(path);
  }
  return Object.freeze({
    paths: sortedUnique([...selected]),
    count: uniquePaths.length,
    truncated: true,
  });
}

function executionAuditPathCounts(
  pathSets: Readonly<Record<AutopilotExecutionAuditPathSet, BoundedAuditPathSet>>,
): AutopilotExecutionAuditPathCounts {
  return Object.freeze(
    Object.fromEntries(
      AUTOPILOT_EXECUTION_AUDIT_PATH_SET_VALUES.map((pathSet) => [pathSet, pathSets[pathSet].count]),
    ) as Record<AutopilotExecutionAuditPathSet, number>,
  );
}

function truncatedAuditPathSets(
  pathSets: Readonly<Record<AutopilotExecutionAuditPathSet, BoundedAuditPathSet>>,
): readonly AutopilotExecutionAuditPathSet[] {
  return Object.freeze(AUTOPILOT_EXECUTION_AUDIT_PATH_SET_VALUES.filter((pathSet) => pathSets[pathSet].truncated));
}

function readGitStatusSnapshot(cwd: string): GitStatusSnapshot {
  try {
    const status = runGitQuery({ descriptor: { kind: 'status-porcelain' }, cwd });
    const gitHead = readGitHead(cwd);
    if (gitHead === null) return Object.freeze({ available: false, gitHead: null, changedPaths: [], summary: 'git status succeeded but HEAD was unavailable' });
    return Object.freeze({
      available: true,
      gitHead,
      changedPaths: parsePorcelainStatusPaths(new TextDecoder('utf-8', { fatal: true }).decode(status.stdout)),
      summary: 'git status snapshot captured',
    });
  } catch (error) {
    if (!(error instanceof GitQueryError)) throw error;
    return Object.freeze({ available: false, gitHead: null, changedPaths: [], summary: boundedText(error.diagnostic || error.message) });
  }
}

function readGitHead(cwd: string): string | null {
  let result: ReturnType<typeof runGitQuery>;
  try { result = runGitQuery({ descriptor: { kind: 'head' }, cwd }); }
  catch (error) { if (error instanceof GitQueryError) return null; throw error; }
  const head = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim();
  return head.length === 0 ? null : head;
}

function parsePorcelainStatusPaths(output: string): readonly string[] {
  const records = output.split('\0').filter((record) => record.length > 0);
  const paths: string[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (record === undefined) {
      index += 1;
      continue;
    }
    const statusCode = record.slice(0, 2);
    const pathPart = record.length > 3 ? record.slice(3) : '';
    if ((statusCode.includes('R') || statusCode.includes('C')) && index + 1 < records.length) {
      const nextRecord = records[index + 1];
      if (nextRecord !== undefined) paths.push(toPosixRelativePath(nextRecord));
      index += 2;
      continue;
    }
    if (pathPart.length > 0) paths.push(toPosixRelativePath(pathPart));
    index += 1;
  }
  return sortedUnique(paths);
}

function toPosixRelativePath(path: string): string {
  return path.replace(/\\/gu, '/');
}

function matchesPathPatterns(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPathPattern(path, pattern));
}

function relevantDirtyPathPatterns(spec: AutopilotUnitSpec): readonly string[] {
  return Object.freeze([...spec.owned_paths, ...spec.read_only_paths, ...spec.untouchable_paths]);
}

function matchesPathPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeRelative(path);
  const normalizedPattern = normalizeRelative(pattern);
  if (normalizedPattern.endsWith('/**')) {
    const base = normalizedPattern.slice(0, -3);
    return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
  }
  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function normalizeRelative(path: string): string {
  return normalize(path).split(sep).join('/');
}

function sortedDifference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return Object.freeze(sortedUnique(left.filter((value) => !rightSet.has(value))));
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function deriveAutopilotArtifactRootFromStatus(statusOutput: string): string {
  const statusDir = dirname(statusOutput);
  const root = dirname(statusDir);
  const relativePath = relative(root, statusOutput);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return dirname(statusDir);
  return root;
}

function runtimeRootRelativePrefix(spec: AutopilotUnitSpec): string {
  const runtimeRoot = deriveAutopilotArtifactRootFromStatus(spec.status_output);
  const rel = relative(spec.cwd, runtimeRoot).split(sep).join('/');
  return rel.length === 0 || rel.startsWith('..') ? `.pi/autopilot/${spec.workstream}` : rel;
}

function boundedText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 240) return trimmed;
  return `${trimmed.slice(0, 237)}...`;
}
