import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { parseAutopilotExecutionAudit } from "../contracts/index.js";
export async function captureAutopilotExecutionBaseline(cwd) {
    const snapshot = readGitStatusSnapshot(cwd);
    return Object.freeze({
        cwd,
        available: snapshot.available,
        gitHead: snapshot.gitHead,
        dirtyPaths: snapshot.changedPaths,
        summary: snapshot.summary,
    });
}
export function deriveAutopilotExecutionAuditPath(spec) {
    return resolve(deriveAutopilotArtifactRootFromStatus(spec.status_output), 'execution-audits', `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.json`);
}
export async function writeAutopilotExecutionAudit(input) {
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
export function buildAutopilotExecutionAudit(input) {
    const auditAvailable = input.baseline.available && input.postRun.available;
    const runtimeRoot = runtimeRootRelativePrefix(input.unitSpec);
    const baselineDirtyPaths = auditAvailable
        ? input.baseline.dirtyPaths.filter((path) => !matchesPathPattern(path, runtimeRoot))
        : [];
    const baselineDirty = baselineDirtyPaths.length > 0;
    const dirtyRelevantPaths = baselineDirtyPaths.filter((path) => matchesPathPatterns(path, relevantDirtyPathPatterns(input.unitSpec)));
    const actualChangedPaths = auditAvailable
        ? sortedDifference(input.postRun.changedPaths, baselineDirtyPaths).filter((path) => !matchesPathPattern(path, runtimeRoot))
        : [];
    const statusReportedChangedPaths = sortedUnique(input.statusEntry?.changed_paths ?? []);
    const omittedStatusChanges = auditAvailable
        ? sortedDifference(actualChangedPaths, statusReportedChangedPaths)
        : [];
    const reportedButNotActualChanges = auditAvailable
        ? sortedDifference(statusReportedChangedPaths, actualChangedPaths)
        : [];
    const outsideOwnedPaths = actualChangedPaths.filter((path) => !matchesPathPatterns(path, input.unitSpec.owned_paths));
    const readOnlyTouchedPaths = actualChangedPaths.filter((path) => matchesPathPatterns(path, input.unitSpec.read_only_paths));
    const untouchableTouchedPaths = actualChangedPaths.filter((path) => matchesPathPatterns(path, input.unitSpec.untouchable_paths));
    const statusReportedCommands = sortedUnique((input.statusEntry?.commands ?? []).map((command) => command.command));
    const declaredValidationCommands = sortedUnique(input.unitSpec.validation_commands);
    const commandCoverageGaps = sortedDifference(declaredValidationCommands, statusReportedCommands);
    const classification = classifyAudit({
        auditAvailable,
        dirtyRelevantPaths,
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
        dirty_baseline: auditAvailable ? baselineDirty : null,
        dirty_baseline_paths: baselineDirtyPaths,
        dirty_relevant_paths: dirtyRelevantPaths,
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
        summary: auditSummary({
            classification,
            auditAvailable,
            baselineDirty,
            dirtyRelevantPaths,
        }),
    });
}
function classifyAudit(input) {
    if (input.untouchableTouchedPaths.length > 0)
        return 'critical-protected-path-violation';
    if (input.readOnlyTouchedPaths.length > 0)
        return 'protected-path-review-required';
    if (!input.auditAvailable || input.dirtyRelevantPaths.length > 0)
        return 'audit-unavailable';
    if (input.outsideOwnedPaths.length > 0 ||
        input.omittedStatusChanges.length > 0 ||
        input.reportedButNotActualChanges.length > 0 ||
        input.commandCoverageGaps.length > 0) {
        return 'scope-review-required';
    }
    return 'clean';
}
function auditSummary(input) {
    if (!input.auditAvailable)
        return 'Execution audit could not read git status; semantic closure requires review.';
    if (input.dirtyRelevantPaths.length > 0) {
        return 'Execution audit found dirty baseline paths on unit-owned or protected surfaces; semantic closure requires attribution review.';
    }
    if (input.classification === 'clean' && input.baselineDirty) {
        return 'Execution audit is clean; unrelated dirty baseline paths are recorded as caveats.';
    }
    if (input.classification === 'clean')
        return 'Execution audit is clean.';
    return `Execution audit classified this attempt as ${input.classification}.`;
}
function readGitStatusSnapshot(cwd) {
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
function readGitHead(cwd) {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (result.status !== 0)
        return null;
    const head = result.stdout.trim();
    return head.length === 0 ? null : head;
}
function parsePorcelainStatusPaths(output) {
    const records = output.split('\0').filter((record) => record.length > 0);
    const paths = [];
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
            if (nextRecord !== undefined)
                paths.push(toPosixRelativePath(nextRecord));
            index += 2;
            continue;
        }
        if (pathPart.length > 0)
            paths.push(toPosixRelativePath(pathPart));
        index += 1;
    }
    return sortedUnique(paths);
}
function toPosixRelativePath(path) {
    return path.replace(/\\/gu, '/');
}
function matchesPathPatterns(path, patterns) {
    return patterns.some((pattern) => matchesPathPattern(path, pattern));
}
function relevantDirtyPathPatterns(spec) {
    return Object.freeze([...spec.owned_paths, ...spec.read_only_paths, ...spec.untouchable_paths]);
}
function matchesPathPattern(path, pattern) {
    const normalizedPath = normalizeRelative(path);
    const normalizedPattern = normalizeRelative(pattern);
    if (normalizedPattern.endsWith('/**')) {
        const base = normalizedPattern.slice(0, -3);
        return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
    }
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}
function normalizeRelative(path) {
    return normalize(path).split(sep).join('/');
}
function sortedDifference(left, right) {
    const rightSet = new Set(right);
    return Object.freeze(sortedUnique(left.filter((value) => !rightSet.has(value))));
}
function sortedUnique(values) {
    return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}
function deriveAutopilotArtifactRootFromStatus(statusOutput) {
    const statusDir = dirname(statusOutput);
    const root = dirname(statusDir);
    const relativePath = relative(root, statusOutput);
    if (relativePath.startsWith('..') || isAbsolute(relativePath))
        return dirname(statusDir);
    return root;
}
function runtimeRootRelativePrefix(spec) {
    const runtimeRoot = deriveAutopilotArtifactRootFromStatus(spec.status_output);
    const rel = relative(spec.cwd, runtimeRoot).split(sep).join('/');
    return rel.length === 0 || rel.startsWith('..') ? `.pi/autopilot/${spec.workstream}` : rel;
}
function boundedText(value) {
    const trimmed = value.trim();
    if (trimmed.length <= 240)
        return trimmed;
    return `${trimmed.slice(0, 237)}...`;
}
