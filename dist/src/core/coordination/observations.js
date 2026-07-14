import { spawnSync } from 'node:child_process';
import { CoordinationRuntimeError } from "./failures.js";
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/u;
function git(cwd, args, label) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if ((result.status ?? -1) !== 0)
        throw new CoordinationRuntimeError('invalid-request', `${label} failed while deriving observation identity`, [result.stderr.trim(), ...args]);
    return result.stdout;
}
function observationObjectPath(path) {
    return path.replace(/\\/gu, '/').replace(/\/\*\*$/u, '').replace(/\/$/u, '');
}
/**
 * Derive an immutable observation identity from the exact worktree commit.
 * Sparse checkout state is irrelevant because ls-tree reads the Git object
 * database rather than trusting materialized filesystem bytes.
 */
export function deriveCoordinationObservationSourceIdentity(input) {
    const baseCommit = git(input.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'observation base commit').trim();
    if (!GIT_OBJECT_ID.test(baseCommit))
        throw new CoordinationRuntimeError('invalid-state', 'observation worktree HEAD is not a valid Git commit object id', [baseCommit]);
    const objectPath = observationObjectPath(input.path);
    if (objectPath.length === 0)
        throw new CoordinationRuntimeError('invalid-request', 'observation path must identify a bounded repository file or directory');
    const listing = git(input.cwd, ['ls-tree', '-z', baseCommit, '--', objectPath], 'observation tree lookup');
    const rows = listing.split('\0').filter((entry) => entry.length > 0);
    if (rows.length === 0) {
        if (input.allowMissing !== true)
            throw new CoordinationRuntimeError('invalid-request', 'READ observation path is not tracked at the exact worktree commit', [input.path, baseCommit]);
        const rootTree = git(input.cwd, ['rev-parse', '--verify', `${baseCommit}^{tree}`], 'legacy missing observation root tree').trim();
        if (!GIT_OBJECT_ID.test(rootTree))
            throw new CoordinationRuntimeError('invalid-state', 'legacy missing observation root tree is invalid', [rootTree]);
        return { base_commit: baseCommit, object_id: rootTree, object_kind: 'missing' };
    }
    if (rows.length !== 1)
        throw new CoordinationRuntimeError('invalid-state', 'observation path resolved to multiple Git tree entries', [input.path, ...rows.slice(0, 8)]);
    const match = /^(?:[0-7]{6}) (blob|tree) ([a-f0-9]{40,64})\t/u.exec(rows[0] ?? '');
    if (match === null)
        throw new CoordinationRuntimeError('invalid-state', 'observation Git tree entry is malformed', [input.path, rows[0] ?? '']);
    const objectKind = match[1];
    const objectId = match[2];
    if ((objectKind !== 'blob' && objectKind !== 'tree') || objectId === undefined || !GIT_OBJECT_ID.test(objectId))
        throw new CoordinationRuntimeError('invalid-state', 'observation Git object identity is unsupported', [input.path, rows[0] ?? '']);
    return { base_commit: baseCommit, object_id: objectId, object_kind: objectKind };
}
export function assertCoordinationObservationSourceIdentity(input) {
    const actual = deriveCoordinationObservationSourceIdentity({ cwd: input.cwd, path: input.path, ...(input.allowMissing === undefined ? {} : { allowMissing: input.allowMissing }) });
    if (actual.base_commit !== input.expected.base_commit || actual.object_id !== input.expected.object_id || actual.object_kind !== input.expected.object_kind) {
        throw new CoordinationRuntimeError('stale-version', 'observation source identity changed before atomic acquisition', [
            input.path,
            `expected=${input.expected.base_commit}:${input.expected.object_kind}:${input.expected.object_id}`,
            `actual=${actual.base_commit}:${actual.object_kind}:${actual.object_id}`,
        ]);
    }
}
