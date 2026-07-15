import { createHash } from 'node:crypto';
/**
 * One closed worktree identity derivation shared by migration and runtime.
 * Owner identity and kind are authority-bearing; paths and refs are validated
 * separately and must never be used to merge different owners.
 */
export function deterministicWorktreeId(owner, kind) {
    const value = `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}\0${kind}`;
    return `worktree-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}
export function worktreeOwnerKindKey(worktree) {
    const owner = worktree.owner;
    return `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}\0${worktree.kind}`;
}
export function sameWorktreeAuthority(left, right) {
    return worktreeOwnerKindKey(left) === worktreeOwnerKindKey(right)
        && left.canonical_path === right.canonical_path
        && left.git_common_dir === right.git_common_dir
        && left.branch === right.branch;
}
