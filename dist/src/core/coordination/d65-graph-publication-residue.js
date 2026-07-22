import { constants as fsConstants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalJson } from "./canonical-json.js";
import { CoordinationRuntimeError } from "./failures.js";
import { D65_GRAPH_PUBLICATION_FIELDS, D65_GRAPH_PUBLICATION_STAGES, parseD65GraphPublication, } from "./d65-semantic-graph.js";
// D65-A2/A5 graph-publication saga residue lifecycle (fresh plan "Graph
// publication is owned by the graph consumer through the closed mutable saga
// residue" and "Each residue rewrite is canonical JSON-plus-LF, exact mode 0600,
// transition-specific CAS, file-fsynced, atomic-renamed, directory-fsynced,
// descriptor-identity checked, and serialized by one package-owned per-run
// publication lock"). The residue is a mode-0600, no-follow, link-count-one
// regular file at `<dirname(run_resource.main_worktree_path)>/
// _graph-publication.json`, outside the Git worktree and runtime discovery
// corpus, no larger than 1 MiB. Each rewrite is atomic (temp+rename), durable
// (file+directory fsync, post-write verify), monotonic (stage advances exactly
// one step), transition-specific-field CAS checked, descriptor-identity checked,
// and serialized by one package-owned per-run publication lock. This module owns
// only the residue lifecycle; the Git commit orchestration of G/H is the
// saga/runtime owner's separate domain.
export const D65_GRAPH_PUBLICATION_RESIDUE_FILENAME = '_graph-publication.json';
export const D65_GRAPH_PUBLICATION_RESIDUE_LOCK_FILENAME = '_graph-publication.lock';
export const D65_GRAPH_PUBLICATION_RESIDUE_MAX_BYTES = 1_048_576;
/** The residue path is the sibling of the run's main worktree. */
export function d65GraphPublicationResiduePath(mainWorktreePath) {
    return join(dirname(mainWorktreePath), D65_GRAPH_PUBLICATION_RESIDUE_FILENAME);
}
/** The per-run publication lock path is the sibling of the residue. */
export function d65GraphPublicationLockPath(mainWorktreePath) {
    return join(dirname(mainWorktreePath), D65_GRAPH_PUBLICATION_RESIDUE_LOCK_FILENAME);
}
/**
 * Fsync the residue's parent directory so a rename/create is durable. POSIX
 * only: Node has no portable Windows directory-handle fsync contract (mirrors
 * the package's existing durable-write helpers in migration-paths.ts).
 */
function fsyncResidueDirectory(mainWorktreePath) {
    if (platform() === 'win32')
        return;
    const directory = dirname(d65GraphPublicationResiduePath(mainWorktreePath));
    const directoryFd = openSync(directory, fsConstants.O_RDONLY);
    try {
        fsyncSync(directoryFd);
    }
    finally {
        closeSync(directoryFd);
    }
}
/**
 * Acquire the package-owned per-run publication lock through an O_EXCL/O_NOFOLLOW
 * lock file beside the residue, run the critical section, and release it. Every
 * residue create/advance/cleanup rewrite is serialized by this single lock so no
 * two writers ever rewrite one run's residue concurrently. A pre-existing lock
 * fails closed as coordinator contention; the lock is never silently stolen.
 */
function withD65PublicationLock(mainWorktreePath, action) {
    const lockPath = d65GraphPublicationLockPath(mainWorktreePath);
    let descriptor;
    try {
        descriptor = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    }
    catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
            throw new CoordinationRuntimeError('coordinator-contention', 'the per-run graph publication lock is already held', [lockPath]);
        }
        throw error;
    }
    let outcome = null;
    let actionError = null;
    try {
        const content = Buffer.from(`${String(process.pid)}\n`, 'utf8');
        let written = 0;
        while (written < content.byteLength)
            written += writeSync(descriptor, content, written, content.byteLength - written, null);
        fsyncSync(descriptor);
        outcome = Object.freeze({ value: action() });
    }
    catch (error) {
        actionError = error;
    }
    let releaseError = null;
    try {
        closeSync(descriptor);
    }
    catch (error) {
        releaseError = error;
    }
    try {
        unlinkSync(lockPath);
    }
    catch (error) {
        releaseError = releaseError ?? error;
    }
    if (actionError !== null) {
        if (releaseError !== null)
            throw new CoordinationRuntimeError('invalid-state', 'graph publication action failed and its package lock could not be released', [actionError instanceof Error ? actionError.message : String(actionError), releaseError instanceof Error ? releaseError.message : String(releaseError), lockPath]);
        throw actionError;
    }
    if (releaseError !== null)
        throw new CoordinationRuntimeError('invalid-state', 'graph publication package lock could not be released', [releaseError instanceof Error ? releaseError.message : String(releaseError), lockPath]);
    if (outcome === null)
        throw new CoordinationRuntimeError('invalid-state', 'graph publication lock action did not complete');
    return outcome.value;
}
const STAGE_ORDER = Object.freeze({
    prepared: 0,
    'authority-committed': 1,
    'publication-committed': 2,
    registered: 3,
});
/** Read the current residue, or null when absent. Enforces no-follow/one-link. */
export function readD65GraphPublicationResidue(mainWorktreePath) {
    const path = d65GraphPublicationResiduePath(mainWorktreePath);
    let descriptor = null;
    try {
        let before;
        try {
            before = lstatSync(path);
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
                return null;
            throw error;
        }
        if (!before.isFile() || before.isSymbolicLink())
            throw new CoordinationRuntimeError('unauthorized-client', 'graph publication residue must be a regular non-symbolic file', [path]);
        if (before.nlink !== 1 || (platform() !== 'win32' && (before.mode & 0o777) !== 0o600))
            throw new CoordinationRuntimeError('unauthorized-client', 'graph publication residue must have one link and exact mode 0600', [path]);
        descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.size > D65_GRAPH_PUBLICATION_RESIDUE_MAX_BYTES)
            throw new CoordinationRuntimeError('invalid-request', 'graph publication residue exceeds its 1 MiB bound', [path]);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1)
            throw new CoordinationRuntimeError('unauthorized-client', 'graph publication residue identity changed during read', [path]);
        const bytes = readFileSync(descriptor);
        const parsed = parseD65GraphPublication(parseJson(bytes, 'graph publication residue'));
        const canonical = new TextEncoder().encode(`${canonicalJson(parsed)}\n`);
        if (bytes.byteLength !== canonical.byteLength || bytes.some((byte, index) => byte !== canonical[index]))
            throw new CoordinationRuntimeError('invalid-state', 'graph publication residue bytes are not canonical JSON plus exactly one LF', [path]);
        return parsed;
    }
    finally {
        if (descriptor !== null)
            closeSync(descriptor);
    }
}
function writeResidueAtomic(mainWorktreePath, residue) {
    const path = d65GraphPublicationResiduePath(mainWorktreePath);
    const serialized = `${canonicalJson(residue)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > D65_GRAPH_PUBLICATION_RESIDUE_MAX_BYTES)
        throw new CoordinationRuntimeError('invalid-request', 'graph publication residue exceeds its 1 MiB bound');
    const temporary = `${path}.${String(process.pid)}.${String(Date.now())}.pending`;
    const descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
        const buffer = Buffer.from(serialized, 'utf8');
        let written = 0;
        while (written < buffer.length)
            written += writeSync(descriptor, buffer, written, buffer.length - written);
        // Fsync the file bytes before the atomic rename so the rename can never
        // publish a torn or unflushed residue after a crash.
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
    try {
        renameSync(temporary, path);
    }
    catch (error) {
        try {
            unlinkSync(temporary);
        }
        catch (cleanupError) {
            throw new CoordinationRuntimeError('invalid-state', 'graph publication residue rename failed and its temporary file could not be removed', [error instanceof Error ? error.message : String(error), cleanupError instanceof Error ? cleanupError.message : String(cleanupError), temporary]);
        }
        throw error;
    }
    // Fsync the parent directory so the rename (name→inode binding) is durable.
    fsyncResidueDirectory(mainWorktreePath);
    // Post-write verification: re-read through the no-follow/one-link descriptor
    // path and prove the persisted bytes are exactly the canonical serialization.
    const persisted = readD65GraphPublicationResidue(mainWorktreePath);
    if (persisted === null)
        throw new CoordinationRuntimeError('invalid-state', 'graph publication residue disappeared immediately after a durable write', [path]);
    if (`${canonicalJson(persisted)}\n` !== serialized)
        throw new CoordinationRuntimeError('invalid-state', 'graph publication residue post-write verification does not match the written bytes', [path]);
}
// The exact fields each stage advance is permitted to change. `stage` and
// `updated_at` are always allowed to move; every other field outside the named
// set must equal the current on-disk residue (transition-specific field CAS,
// fresh plan "transition-specific CAS").
const STAGE_ADVANCE_MUTABLE_FIELDS = Object.freeze({
    // A new residue is created, never advanced into prepared.
    prepared: Object.freeze([]),
    // prepared -> authority-committed records only G and its tree.
    'authority-committed': Object.freeze(['authority_commit', 'authority_tree']),
    // authority-committed -> publication-committed records only H/tree/ref/hash/count.
    'publication-committed': Object.freeze(['publication_commit', 'publication_tree', 'graph_ref', 'graph_sha256', 'graph_byte_count']),
    // publication-committed -> registered records only R.
    registered: Object.freeze(['registration_event_seq']),
});
// Shared single source of truth from the parser module; the residue CAS and the
// parser can never drift on the closed field set.
const ALL_RESIDUE_FIELDS = D65_GRAPH_PUBLICATION_FIELDS;
/** Create the residue at the `prepared` stage. Rejects if one already exists. */
export function createD65GraphPublicationResidue(mainWorktreePath, residue) {
    const parsed = parseD65GraphPublication(residue);
    if (parsed.stage !== 'prepared')
        throw new CoordinationRuntimeError('invalid-request', 'a new graph publication residue must begin at the prepared stage');
    return withD65PublicationLock(mainWorktreePath, () => {
        if (readD65GraphPublicationResidue(mainWorktreePath) !== null)
            throw new CoordinationRuntimeError('coordinator-contention', 'a graph publication residue already exists for this run');
        writeResidueAtomic(mainWorktreePath, parsed);
        return parsed;
    });
}
/**
 * Advance the residue exactly one monotonic stage under the package-owned per-run
 * publication lock. The next stage must be exactly one greater; immutable
 * identity fields never change; and only the exact transition-specific mutable
 * fields (plus `stage`/`updated_at`) may differ from the current on-disk residue.
 */
export function advanceD65GraphPublicationResidue(mainWorktreePath, next) {
    const parsed = parseD65GraphPublication(next);
    return withD65PublicationLock(mainWorktreePath, () => {
        const current = readD65GraphPublicationResidue(mainWorktreePath);
        if (current === null)
            throw new CoordinationRuntimeError('invalid-state', 'cannot advance an absent graph publication residue');
        // Monotonic: exactly one stage forward.
        if (STAGE_ORDER[parsed.stage] !== STAGE_ORDER[current.stage] + 1)
            throw new CoordinationRuntimeError('invalid-state', `graph publication residue stage must advance exactly one step from ${current.stage}`, [current.stage, parsed.stage]);
        // Transition-specific field CAS: only the exact fields this advance is
        // permitted to change, plus stage/updated_at, may differ from current.
        const mutable = new Set([...STAGE_ADVANCE_MUTABLE_FIELDS[parsed.stage], 'stage', 'updated_at']);
        for (const key of ALL_RESIDUE_FIELDS) {
            if (mutable.has(key))
                continue;
            if (canonicalJson(parsed[key]) !== canonicalJson(current[key]))
                throw new CoordinationRuntimeError('invalid-state', `graph publication residue field ${String(key)} changed outside the ${current.stage}->${parsed.stage} transition CAS`);
        }
        writeResidueAtomic(mainWorktreePath, parsed);
        return parsed;
    });
}
/**
 * Descriptor-safe cleanup: remove the residue only after it reached `registered`
 * and prove its absence. Loss or mismatch before cleanup is terminal. Serialized
 * by the same per-run publication lock.
 */
export function cleanupD65GraphPublicationResidue(mainWorktreePath) {
    withD65PublicationLock(mainWorktreePath, () => {
        const current = readD65GraphPublicationResidue(mainWorktreePath);
        if (current === null)
            return;
        if (current.stage !== 'registered')
            throw new CoordinationRuntimeError('invalid-state', 'graph publication residue cleanup requires the registered stage');
        const path = d65GraphPublicationResiduePath(mainWorktreePath);
        const before = lstatSync(path);
        const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
            const opened = fstatSync(descriptor);
            const immediate = lstatSync(path);
            if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || immediate.dev !== opened.dev || immediate.ino !== opened.ino || immediate.nlink !== 1)
                throw new CoordinationRuntimeError('invalid-state', 'graph publication residue identity changed before descriptor-pinned cleanup', [path]);
            unlinkSync(path);
            const unlinked = fstatSync(descriptor);
            if (unlinked.dev !== opened.dev || unlinked.ino !== opened.ino || unlinked.nlink !== 0)
                throw new CoordinationRuntimeError('invalid-state', 'graph publication residue cleanup did not unlink the opened inode', [path]);
        }
        finally {
            closeSync(descriptor);
        }
        fsyncResidueDirectory(mainWorktreePath);
        if (readD65GraphPublicationResidue(mainWorktreePath) !== null)
            throw new CoordinationRuntimeError('invalid-state', 'graph publication residue persisted after cleanup');
    });
}
/** True while any residue exists and is not yet `registered` (dispatch is false). */
export function d65GraphPublicationPending(mainWorktreePath) {
    const current = readD65GraphPublicationResidue(mainWorktreePath);
    return current !== null && current.stage !== 'registered';
}
export const D65_GRAPH_PUBLICATION_STAGE_VALUES = D65_GRAPH_PUBLICATION_STAGES;
function parseJson(bytes, label) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-request', `${label} is not valid UTF-8`, [error instanceof Error ? error.message : String(error)]);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-request', `${label} is not valid JSON`, [error instanceof Error ? error.message : String(error)]);
    }
}
