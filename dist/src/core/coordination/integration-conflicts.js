import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { coordinationPathsOverlap } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
const GIT_OBJECT = /^[a-f0-9]{40,64}$/u;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SEMANTIC_JSON_BYTES = 1024 * 1024;
const MAX_CONFLICT_EVIDENCE = 128;
/**
 * Classify two real branch outcomes from immutable Git commits. Declared WRITE
 * scopes are deliberately absent: only actual diffs, merge-tree, hunk, protected
 * surface, and mechanically extractable JSON semantic-key facts participate.
 */
export function classifyCoordinationIntegrationConflict(input) {
    assertCommit(input.repoRoot, input.predecessorCommit, 'predecessor commit');
    assertCommit(input.repoRoot, input.dependentCommit, 'dependent commit');
    const mergeBase = git(input.repoRoot, ['merge-base', input.predecessorCommit, input.dependentCommit], 'integration merge-base').trim();
    if (!GIT_OBJECT.test(mergeBase))
        throw new CoordinationRuntimeError('invalid-state', 'integration merge-base is not a full Git object id', [mergeBase]);
    const paths = sortedUnique(input.overlappingPaths.map(normalizePath));
    if (paths.length === 0)
        throw new CoordinationRuntimeError('invalid-request', 'integration conflict classification requires at least one actual overlapping path');
    const predecessor = { commit: input.predecessorCommit, label: 'predecessor' };
    const dependent = { commit: input.dependentCommit, label: 'dependent' };
    const predecessorChanged = changedPaths(input.repoRoot, mergeBase, predecessor.commit, paths);
    const dependentChanged = changedPaths(input.repoRoot, mergeBase, dependent.commit, paths);
    const actualOverlap = paths.filter((path) => predecessorChanged.some((changed) => coordinationPathsOverlap(changed, path)) && dependentChanged.some((changed) => coordinationPathsOverlap(changed, path)));
    const classifiedPaths = actualOverlap.length > 0 ? actualOverlap : paths;
    const mergeTree = mergeTreeStatus(input.repoRoot, predecessor.commit, dependent.commit, classifiedPaths);
    const predecessorHunks = diffHunks(input.repoRoot, mergeBase, predecessor.commit, classifiedPaths);
    const dependentHunks = diffHunks(input.repoRoot, mergeBase, dependent.commit, classifiedPaths);
    const overlappingHunks = overlappingHunkEvidence(predecessorHunks, dependentHunks);
    const semanticKeys = sharedJsonSemanticKeys(input.repoRoot, mergeBase, predecessor.commit, dependent.commit, classifiedPaths);
    const configuredProtected = input.protectedPaths ?? [];
    const protectedSurfaces = actualOverlap.filter((path) => isDefaultProtectedSurface(path) || configuredProtected.some((protectedPath) => coordinationPathsOverlap(path, protectedPath)));
    const deleteModify = deleteModifyPaths(input.repoRoot, mergeBase, predecessor.commit, dependent.commit, classifiedPaths);
    let kind;
    let disposition;
    if (protectedSurfaces.length > 0) {
        kind = 'protected-surface-conflict';
        disposition = 'repair-required';
    }
    else if (semanticKeys.length > 0) {
        kind = 'semantic-key-conflict';
        disposition = 'repair-required';
    }
    else if (mergeTree.status === 'conflict' && deleteModify.length > 0) {
        kind = 'delete-modify-conflict';
        disposition = 'repair-required';
    }
    else if (mergeTree.status === 'conflict') {
        kind = 'textual-merge-conflict';
        disposition = 'repair-required';
    }
    else if (overlappingHunks.length > 0) {
        kind = 'clean-overlap';
        disposition = 'ordered-integration';
    }
    else {
        kind = 'disjoint-hunks';
        disposition = 'ordered-integration';
    }
    const evidence = sortedUnique([
        `merge-base=${mergeBase}`,
        `merge-tree=${mergeTree.status}`,
        ...mergeTree.conflictPaths.map((path) => `merge-conflict-path=${path}`),
        ...predecessorChanged.map((path) => `predecessor-changed=${path}`),
        ...dependentChanged.map((path) => `dependent-changed=${path}`),
        ...deleteModify.map((path) => `delete-modify=${path}`),
    ]).slice(0, MAX_CONFLICT_EVIDENCE);
    const classificationId = `integration-${createHash('sha256').update([mergeBase, input.predecessorCommit, input.dependentCommit, ...classifiedPaths, kind, ...overlappingHunks, ...semanticKeys, ...protectedSurfaces].join('\0'), 'utf8').digest('hex')}`;
    return Object.freeze({
        schema_version: 'autopilot.integration_conflict.v1',
        classification_id: classificationId,
        kind,
        disposition,
        merge_base: mergeBase,
        predecessor_commit: input.predecessorCommit,
        dependent_commit: input.dependentCommit,
        merge_tree_status: mergeTree.status,
        overlapping_paths: Object.freeze(classifiedPaths),
        overlapping_hunks: Object.freeze(overlappingHunks),
        semantic_keys: Object.freeze(semanticKeys),
        protected_surfaces: Object.freeze(protectedSurfaces),
        evidence: Object.freeze(evidence),
    });
}
/** Existing schema-10 rows are preserved conservatively and must integrate. */
export function legacyConservativeIntegrationConflict(obligationId, paths) {
    return Object.freeze({
        schema_version: 'autopilot.integration_conflict.v1',
        classification_id: `legacy-${createHash('sha256').update(`${obligationId}\0${[...paths].sort().join('\0')}`, 'utf8').digest('hex')}`,
        kind: 'legacy-conservative',
        disposition: 'repair-required',
        merge_base: null,
        predecessor_commit: null,
        dependent_commit: null,
        merge_tree_status: 'legacy-unverified',
        overlapping_paths: Object.freeze(sortedUnique(paths.map(normalizePath))),
        overlapping_hunks: Object.freeze([]),
        semantic_keys: Object.freeze([]),
        protected_surfaces: Object.freeze([]),
        evidence: Object.freeze(['historical reservation obligation predates integration-time Git classification']),
    });
}
export function isDefaultProtectedSurface(path) {
    const normalized = normalizePath(path);
    const name = basename(normalized);
    if (['.gitmodules', '.gitattributes', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'uv.lock', 'composer.lock'].includes(name))
        return true;
    const segments = normalized.split('/');
    return segments.includes('migrations') || segments.includes('schema-migrations') || normalized.startsWith('.github/workflows/');
}
function mergeTreeStatus(repoRoot, predecessorCommit, dependentCommit, relevantPaths) {
    const result = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', predecessorCommit, dependentCommit], { cwd: repoRoot, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES });
    const status = result.status ?? -1;
    if (status !== 0 && status !== 1)
        throw new CoordinationRuntimeError('invalid-state', 'git merge-tree failed during integration classification', [result.stderr.trim(), `status=${String(status)}`]);
    if (status === 0)
        return { status: 'clean', conflictPaths: Object.freeze([]) };
    const values = result.stdout.split('\0').map((value) => value.trim()).filter((value) => value.length > 0 && !GIT_OBJECT.test(value)).map(normalizePath);
    const relevant = values.filter((path) => relevantPaths.some((candidate) => coordinationPathsOverlap(path, candidate)));
    // If Git reports a conflict but this Git version does not expose parseable
    // path names, fail conservatively for the classified pair rather than claim a
    // clean merge from missing output.
    return { status: relevant.length > 0 || values.length === 0 ? 'conflict' : 'clean', conflictPaths: Object.freeze(sortedUnique(relevant)) };
}
function changedPaths(repoRoot, base, commit, paths) {
    const output = git(repoRoot, ['diff', '--name-only', '--no-renames', '-z', base, commit, '--', ...paths], 'integration changed paths');
    return Object.freeze(sortedUnique(output.split('\0').filter((path) => path.length > 0).map(normalizePath)));
}
function diffHunks(repoRoot, base, commit, paths) {
    const hunks = [];
    for (const path of paths) {
        const output = git(repoRoot, ['diff', '--no-ext-diff', '--no-color', '--unified=0', base, commit, '--', path], `integration hunk diff ${path}`);
        for (const line of output.split('\n')) {
            const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
            if (match === null)
                continue;
            hunks.push({ path, oldStart: Number(match[1]), oldCount: Number(match[2] ?? '1'), newStart: Number(match[3]), newCount: Number(match[4] ?? '1') });
        }
    }
    return Object.freeze(hunks);
}
function overlappingHunkEvidence(left, right) {
    const evidence = [];
    for (const leftHunk of left) {
        for (const rightHunk of right) {
            if (leftHunk.path !== rightHunk.path || !rangesOverlap(leftHunk.oldStart, leftHunk.oldCount, rightHunk.oldStart, rightHunk.oldCount))
                continue;
            evidence.push(`${leftHunk.path}:base-${String(leftHunk.oldStart)},${String(leftHunk.oldCount)}|base-${String(rightHunk.oldStart)},${String(rightHunk.oldCount)}`);
        }
    }
    return sortedUnique(evidence);
}
function rangesOverlap(leftStart, leftCount, rightStart, rightCount) {
    const leftEnd = leftCount === 0 ? leftStart : leftStart + leftCount - 1;
    const rightEnd = rightCount === 0 ? rightStart : rightStart + rightCount - 1;
    return leftStart <= rightEnd && rightStart <= leftEnd;
}
function deleteModifyPaths(repoRoot, base, predecessorCommit, dependentCommit, paths) {
    const predecessorDeleted = new Set(diffFilterPaths(repoRoot, base, predecessorCommit, 'D', paths));
    const dependentDeleted = new Set(diffFilterPaths(repoRoot, base, dependentCommit, 'D', paths));
    const predecessorChanged = new Set(changedPaths(repoRoot, base, predecessorCommit, paths));
    const dependentChanged = new Set(changedPaths(repoRoot, base, dependentCommit, paths));
    return sortedUnique(paths.filter((path) => (predecessorDeleted.has(path) && dependentChanged.has(path) && !dependentDeleted.has(path)) || (dependentDeleted.has(path) && predecessorChanged.has(path) && !predecessorDeleted.has(path))));
}
function diffFilterPaths(repoRoot, base, commit, filter, paths) {
    const output = git(repoRoot, ['diff', `--diff-filter=${filter}`, '--name-only', '--no-renames', '-z', base, commit, '--', ...paths], `integration ${filter} paths`);
    return Object.freeze(sortedUnique(output.split('\0').filter((path) => path.length > 0).map(normalizePath)));
}
function sharedJsonSemanticKeys(repoRoot, base, predecessorCommit, dependentCommit, paths) {
    const shared = [];
    for (const path of paths.filter((candidate) => candidate.endsWith('.json'))) {
        const baseJson = gitJsonObject(repoRoot, base, path);
        const predecessorJson = gitJsonObject(repoRoot, predecessorCommit, path);
        const dependentJson = gitJsonObject(repoRoot, dependentCommit, path);
        if (baseJson === undefined || predecessorJson === undefined || dependentJson === undefined)
            continue;
        const predecessorKeys = new Set(changedJsonPointers(baseJson, predecessorJson));
        const dependentKeys = new Set(changedJsonPointers(baseJson, dependentJson));
        for (const key of semanticPointerOverlap(predecessorKeys, dependentKeys))
            shared.push(`${path}#${key}`);
    }
    return sortedUnique(shared);
}
function gitJsonObject(repoRoot, commit, path) {
    const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: MAX_SEMANTIC_JSON_BYTES + 1 });
    if ((result.status ?? -1) !== 0 || Buffer.byteLength(result.stdout, 'utf8') > MAX_SEMANTIC_JSON_BYTES)
        return undefined;
    try {
        return JSON.parse(result.stdout);
    }
    catch {
        return undefined;
    }
}
function changedJsonPointers(before, after, pointer = '') {
    if (stableJson(before) === stableJson(after))
        return [];
    if (isPlainObject(before) && isPlainObject(after)) {
        const changed = [];
        for (const key of sortedUnique([...Object.keys(before), ...Object.keys(after)])) {
            const escaped = key.replace(/~/gu, '~0').replace(/\//gu, '~1');
            changed.push(...changedJsonPointers(before[key], after[key], `${pointer}/${escaped}`));
        }
        return changed.length > 0 ? changed : [pointer || '/'];
    }
    // Arrays are one semantic authority: independent index edits can invalidate
    // ordering and generated identity even when textual hunks are disjoint.
    return [pointer || '/'];
}
function semanticPointerOverlap(left, right) {
    const shared = new Set();
    for (const pointer of left)
        for (const authority of pointerAuthorities(pointer))
            if (right.has(authority))
                shared.add(authority);
    for (const pointer of right)
        for (const authority of pointerAuthorities(pointer))
            if (left.has(authority))
                shared.add(authority);
    return sortedUnique([...shared]);
}
function pointerAuthorities(pointer) {
    if (pointer === '/')
        return ['/'];
    const authorities = [pointer];
    let cursor = pointer;
    while (cursor.lastIndexOf('/') > 0) {
        cursor = cursor.slice(0, cursor.lastIndexOf('/'));
        authorities.push(cursor);
    }
    authorities.push('/');
    return authorities;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stableJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    const row = value;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
}
function assertCommit(repoRoot, commit, label) {
    if (!GIT_OBJECT.test(commit))
        throw new CoordinationRuntimeError('invalid-request', `${label} must be a full lowercase Git object id`, [commit]);
    const result = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: repoRoot, encoding: 'utf8' });
    if ((result.status ?? -1) !== 0)
        throw new CoordinationRuntimeError('invalid-state', `${label} is unavailable in the repository object database`, [commit, result.stderr.trim()]);
}
function git(repoRoot, args, label) {
    const result = spawnSync('git', [...args], { cwd: repoRoot, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES });
    if ((result.status ?? -1) !== 0)
        throw new CoordinationRuntimeError('invalid-state', `${label} failed`, [result.stderr.trim(), ...args]);
    return result.stdout;
}
function normalizePath(path) {
    const normalized = path.replace(/\\/gu, '/').replace(/\/\*\*$/u, '').replace(/^\.\//u, '').replace(/\/$/u, '');
    if (normalized.length === 0 || normalized.startsWith('/') || normalized.includes('/../') || normalized.startsWith('../'))
        throw new CoordinationRuntimeError('invalid-request', 'integration path is not bounded repository-relative authority', [path]);
    return normalized;
}
function sortedUnique(values) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
