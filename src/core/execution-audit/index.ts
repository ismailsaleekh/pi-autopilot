import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import { parseAutopilotExecutionAudit } from '../contracts/index.ts';
import type {
  AutopilotAuditClassification,
  AutopilotExecutionAudit,
  AutopilotStatusEntry,
  AutopilotUnitSpec,
} from '../contracts/types.ts';

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
  const baselineDirty = input.baseline.dirtyPaths.length > 0;
  const runtimeRoot = runtimeRootRelativePrefix(input.unitSpec);
  const actualChangedPaths = auditAvailable
    ? sortedDifference(input.postRun.changedPaths, input.baseline.dirtyPaths).filter(
        (path) => !matchesPathPattern(path, runtimeRoot),
      )
    : [];
  const statusReportedChangedPaths = sortedUnique(input.statusEntry?.changed_paths ?? []);
  const omittedStatusChanges = auditAvailable
    ? sortedDifference(actualChangedPaths, statusReportedChangedPaths)
    : [];
  const reportedButNotActualChanges = auditAvailable
    ? sortedDifference(statusReportedChangedPaths, actualChangedPaths)
    : [];
  const outsideOwnedPaths = actualChangedPaths.filter(
    (path) => !matchesPathPatterns(path, input.unitSpec.owned_paths),
  );
  const readOnlyTouchedPaths = actualChangedPaths.filter((path) =>
    matchesPathPatterns(path, input.unitSpec.read_only_paths),
  );
  const untouchableTouchedPaths = actualChangedPaths.filter((path) =>
    matchesPathPatterns(path, input.unitSpec.untouchable_paths),
  );
  const statusReportedCommands = sortedUnique(
    (input.statusEntry?.commands ?? []).map((command) => command.command),
  );
  const declaredValidationCommands = sortedUnique(input.unitSpec.validation_commands);
  const commandCoverageGaps = sortedDifference(declaredValidationCommands, statusReportedCommands);
  const classification = classifyAudit({
    auditAvailable,
    baselineDirty,
    outsideOwnedPaths,
    readOnlyTouchedPaths,
    untouchableTouchedPaths,
    omittedStatusChanges,
    reportedButNotActualChanges,
    commandCoverageGaps,
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
    dirty_baseline: input.baseline.available ? baselineDirty : null,
    actual_changed_paths: actualChangedPaths,
    status_reported_changed_paths: statusReportedChangedPaths,
    omitted_status_changes: omittedStatusChanges,
    reported_but_not_actual_changes: reportedButNotActualChanges,
    outside_owned_paths: outsideOwnedPaths,
    read_only_touched_paths: readOnlyTouchedPaths,
    untouchable_touched_paths: untouchableTouchedPaths,
    declared_validation_commands: declaredValidationCommands,
    status_reported_commands: statusReportedCommands,
    command_coverage_gaps: commandCoverageGaps,
    classification,
    evidence_refs: [],
    summary: auditSummary(classification, auditAvailable, baselineDirty),
  });
}

function classifyAudit(input: {
  readonly auditAvailable: boolean;
  readonly baselineDirty: boolean;
  readonly outsideOwnedPaths: readonly string[];
  readonly readOnlyTouchedPaths: readonly string[];
  readonly untouchableTouchedPaths: readonly string[];
  readonly omittedStatusChanges: readonly string[];
  readonly reportedButNotActualChanges: readonly string[];
  readonly commandCoverageGaps: readonly string[];
}): AutopilotAuditClassification {
  if (input.untouchableTouchedPaths.length > 0) return 'critical-protected-path-violation';
  if (input.readOnlyTouchedPaths.length > 0) return 'protected-path-review-required';
  if (!input.auditAvailable || input.baselineDirty) return 'audit-unavailable';
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

function auditSummary(
  classification: AutopilotAuditClassification,
  auditAvailable: boolean,
  baselineDirty: boolean,
): string {
  if (!auditAvailable) return 'Execution audit could not read git status; semantic closure requires review.';
  if (baselineDirty) return 'Execution audit found a dirty baseline; semantic closure requires review.';
  if (classification === 'clean') return 'Execution audit is clean.';
  return `Execution audit classified this attempt as ${classification}.`;
}

function readGitStatusSnapshot(cwd: string): GitStatusSnapshot {
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  if (status.status !== 0) {
    return Object.freeze({
      available: false,
      gitHead: null,
      changedPaths: [],
      summary: boundedText(status.stderr),
    });
  }
  return Object.freeze({
    available: true,
    gitHead: readGitHead(cwd),
    changedPaths: parsePorcelainStatusPaths(status.stdout),
    summary: 'git status snapshot captured',
  });
}

function readGitHead(cwd: string): string | null {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const head = result.stdout.trim();
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
