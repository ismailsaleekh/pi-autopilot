import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from "./canonical-json.js";
import { CoordinationRuntimeError } from "./failures.js";
import { D65_GRAPH_PUBLICATION_STAGES, parseD65GraphPublication, } from "./d65-semantic-graph.js";
// D65-A2 graph-publication saga residue lifecycle (fresh plan "Graph publication
// is owned by the graph consumer through the closed mutable saga residue"). The
// residue is a mode-0600, no-follow, link-count-one regular file at
// `<dirname(run_resource.main_worktree_path)>/_graph-publication.json`, outside
// the Git worktree and runtime discovery corpus, no larger than 1 MiB. Each
// rewrite is atomic (temp+rename), monotonic (stage only advances), and
// descriptor-identity checked. This module owns only the residue lifecycle; the
// Git commit orchestration of G/H is the saga/runtime owner's separate domain.
export const D65_GRAPH_PUBLICATION_RESIDUE_FILENAME = '_graph-publication.json';
export const D65_GRAPH_PUBLICATION_RESIDUE_MAX_BYTES = 1_048_576;
/** The residue path is the sibling of the run's main worktree. */
export function d65GraphPublicationResiduePath(mainWorktreePath) {
    return join(dirname(mainWorktreePath), D65_GRAPH_PUBLICATION_RESIDUE_FILENAME);
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
        if (before.nlink !== 1)
            throw new CoordinationRuntimeError('unauthorized-client', 'graph publication residue must have link count one', [path]);
        descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.size > D65_GRAPH_PUBLICATION_RESIDUE_MAX_BYTES)
            throw new CoordinationRuntimeError('invalid-request', 'graph publication residue exceeds its 1 MiB bound', [path]);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1)
            throw new CoordinationRuntimeError('unauthorized-client', 'graph publication residue identity changed during read', [path]);
        const bytes = readFileSync(descriptor);
        return parseD65GraphPublication(parseJson(bytes, 'graph publication residue'));
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
        catch { /* best-effort cleanup */ }
        throw error;
    }
}
/** Create the residue at the `prepared` stage. Rejects if one already exists. */
export function createD65GraphPublicationResidue(mainWorktreePath, residue) {
    const parsed = parseD65GraphPublication(residue);
    if (parsed.stage !== 'prepared')
        throw new CoordinationRuntimeError('invalid-request', 'a new graph publication residue must begin at the prepared stage');
    if (readD65GraphPublicationResidue(mainWorktreePath) !== null)
        throw new CoordinationRuntimeError('coordinator-contention', 'a graph publication residue already exists for this run');
    writeResidueAtomic(mainWorktreePath, parsed);
    return parsed;
}
/**
 * Advance the residue exactly one monotonic stage. The prior on-disk residue
 * must match `expectedPrior` byte-for-byte on its identity fields; the next
 * stage must be exactly one greater; immutable identity fields never change.
 */
export function advanceD65GraphPublicationResidue(mainWorktreePath, next) {
    const parsed = parseD65GraphPublication(next);
    const current = readD65GraphPublicationResidue(mainWorktreePath);
    if (current === null)
        throw new CoordinationRuntimeError('invalid-state', 'cannot advance an absent graph publication residue');
    // Monotonic: exactly one stage forward.
    if (STAGE_ORDER[parsed.stage] !== STAGE_ORDER[current.stage] + 1)
        throw new CoordinationRuntimeError('invalid-state', `graph publication residue stage must advance exactly one step from ${current.stage}`, [current.stage, parsed.stage]);
    // Immutable identity fields never change across stages.
    const immutable = [
        'publication_id', 'program_id', 'repo_id', 'autopilot_id', 'workstream_run', 'graph_sequence', 'artifact_id',
        'prior_authority_kind', 'prior_graph_sha256', 'prior_publication_commit', 'prior_registration_event_seq',
        'authority_base_commit', 'authority_path_count', 'authority_path_manifest_sha256', 'created_at',
    ];
    for (const key of immutable) {
        if (canonicalJson(parsed[key]) !== canonicalJson(current[key]))
            throw new CoordinationRuntimeError('invalid-state', `graph publication residue immutable field ${String(key)} changed across a stage advance`);
    }
    writeResidueAtomic(mainWorktreePath, parsed);
    return parsed;
}
/**
 * Descriptor-safe cleanup: remove the residue only after it reached `registered`
 * and prove its absence. Loss or mismatch before cleanup is terminal.
 */
export function cleanupD65GraphPublicationResidue(mainWorktreePath) {
    const current = readD65GraphPublicationResidue(mainWorktreePath);
    if (current === null)
        return;
    if (current.stage !== 'registered')
        throw new CoordinationRuntimeError('invalid-state', 'graph publication residue cleanup requires the registered stage');
    const path = d65GraphPublicationResiduePath(mainWorktreePath);
    unlinkSync(path);
    if (readD65GraphPublicationResidue(mainWorktreePath) !== null)
        throw new CoordinationRuntimeError('invalid-state', 'graph publication residue persisted after cleanup');
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
