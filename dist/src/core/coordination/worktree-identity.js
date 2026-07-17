import { createHash } from 'node:crypto';
import { CoordinationRuntimeError } from "./failures.js";
export const AUTOPILOT_WORKTREE_ALIAS_SCHEMA = 'autopilot.worktree_alias.v1';
export const WORKTREE_ALIAS_RESOLUTION_STATES = ['resolved', 'identity-recovery-pending'];
export const WORKTREE_ALIAS_REASONS = ['legacy-migration-id', 'duplicate-semantic-projection'];
const WORKTREE_ID_PATTERN = /^worktree-[a-f0-9]{32}$/u;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
function semanticIdentityValue(identity) {
    return `${identity.repo_id}\0${identity.autopilot_id}\0${identity.workstream_run}\0${identity.unit_id}\0${String(identity.attempt)}\0${identity.kind}`;
}
function assertIdentity(identity, label) {
    for (const [field, value] of Object.entries(identity)) {
        if (field === 'attempt')
            continue;
        if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
            throw new CoordinationRuntimeError('invalid-request', `${label}.${field} must be non-empty NUL-free text`);
    }
    if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1)
        throw new CoordinationRuntimeError('invalid-request', `${label}.attempt must be a positive safe integer`);
    if (identity.kind !== 'main' && identity.kind !== 'unit')
        throw new CoordinationRuntimeError('invalid-request', `${label}.kind is invalid`);
}
export function canonicalWorktreeSemanticIdentity(owner, kind) {
    const identity = {
        repo_id: owner.repo_id,
        autopilot_id: owner.autopilot_id,
        workstream_run: owner.workstream_run,
        unit_id: owner.unit_id,
        attempt: owner.attempt,
        kind,
    };
    assertIdentity(identity, 'canonical worktree identity');
    return Object.freeze(identity);
}
/**
 * Frozen schema-13 identity derivation. Paths, refs, state, timestamps,
 * migration IDs, and operation IDs never participate.
 */
export function deterministicWorktreeId(owner, kind) {
    return deterministicWorktreeIdFromIdentity(canonicalWorktreeSemanticIdentity(owner, kind));
}
export function deterministicWorktreeIdFromIdentity(identity) {
    assertIdentity(identity, 'canonical worktree identity');
    return `worktree-${createHash('sha256').update(semanticIdentityValue(identity), 'utf8').digest('hex').slice(0, 32)}`;
}
export function worktreeOwnerKindKey(worktree) {
    return semanticIdentityValue(canonicalWorktreeSemanticIdentity(worktree.owner, worktree.kind));
}
export function sameWorktreeAuthority(left, right) {
    return worktreeOwnerKindKey(left) === worktreeOwnerKindKey(right)
        && left.canonical_path === right.canonical_path
        && left.git_common_dir === right.git_common_dir
        && left.branch === right.branch;
}
function exactObject(value, fields, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-request', `${label} must be an object`);
    const record = value;
    const actual = Object.keys(record).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index]))
        throw new CoordinationRuntimeError('invalid-request', `${label} fields are closed`, actual);
    return record;
}
function requiredString(record, field, label) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
        throw new CoordinationRuntimeError('invalid-request', `${label}.${field} must be non-empty NUL-free text`);
    return value;
}
export function parseWorktreeAlias(value) {
    const label = 'WorktreeAlias';
    const record = exactObject(value, ['alias_worktree_id', 'attempt', 'autopilot_id', 'canonical_worktree_id', 'created_event_seq', 'evidence_sha256', 'kind', 'reason', 'repo_id', 'resolution_state', 'schema_version', 'unit_id', 'workstream_run'], label);
    const aliasId = requiredString(record, 'alias_worktree_id', label);
    const canonicalId = requiredString(record, 'canonical_worktree_id', label);
    const attempt = record['attempt'];
    const createdEventSeq = record['created_event_seq'];
    const kind = record['kind'];
    const state = record['resolution_state'];
    const reason = record['reason'];
    const evidence = record['evidence_sha256'];
    if (record['schema_version'] !== AUTOPILOT_WORKTREE_ALIAS_SCHEMA)
        throw new CoordinationRuntimeError('invalid-request', `${label}.schema_version is invalid`);
    if (!ENTITY_ID_PATTERN.test(aliasId) || WORKTREE_ID_PATTERN.test(aliasId))
        throw new CoordinationRuntimeError('invalid-request', `${label}.alias_worktree_id must be a non-canonical historical entity ID`);
    if (!WORKTREE_ID_PATTERN.test(canonicalId))
        throw new CoordinationRuntimeError('invalid-request', `${label}.canonical_worktree_id is invalid`);
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1)
        throw new CoordinationRuntimeError('invalid-request', `${label}.attempt must be a positive safe integer`);
    if (typeof createdEventSeq !== 'number' || !Number.isSafeInteger(createdEventSeq) || createdEventSeq < 1)
        throw new CoordinationRuntimeError('invalid-request', `${label}.created_event_seq must be a positive safe integer`);
    if (kind !== 'main' && kind !== 'unit')
        throw new CoordinationRuntimeError('invalid-request', `${label}.kind is invalid`);
    if (state !== 'resolved' && state !== 'identity-recovery-pending')
        throw new CoordinationRuntimeError('invalid-request', `${label}.resolution_state is invalid`);
    if (reason !== 'legacy-migration-id' && reason !== 'duplicate-semantic-projection')
        throw new CoordinationRuntimeError('invalid-request', `${label}.reason is invalid`);
    if (typeof evidence !== 'string' || !SHA256_PATTERN.test(evidence))
        throw new CoordinationRuntimeError('invalid-request', `${label}.evidence_sha256 is invalid`);
    const alias = {
        schema_version: AUTOPILOT_WORKTREE_ALIAS_SCHEMA,
        alias_worktree_id: aliasId,
        canonical_worktree_id: canonicalId,
        repo_id: requiredString(record, 'repo_id', label),
        autopilot_id: requiredString(record, 'autopilot_id', label),
        workstream_run: requiredString(record, 'workstream_run', label),
        unit_id: requiredString(record, 'unit_id', label),
        attempt,
        kind,
        resolution_state: state,
        reason,
        evidence_sha256: evidence,
        created_event_seq: createdEventSeq,
    };
    const expectedCanonical = deterministicWorktreeIdFromIdentity({
        repo_id: alias.repo_id,
        autopilot_id: alias.autopilot_id,
        workstream_run: alias.workstream_run,
        unit_id: alias.unit_id,
        attempt: alias.attempt,
        kind: alias.kind,
    });
    if (alias.canonical_worktree_id !== expectedCanonical)
        throw new CoordinationRuntimeError('invalid-request', 'worktree alias target is not the deterministic ID of its semantic identity', [alias.alias_worktree_id, alias.canonical_worktree_id, expectedCanonical]);
    return Object.freeze(alias);
}
/** Immutable in-memory view of the append-only SQLite alias registry. */
export class WorktreeAliasRegistry {
    #aliases;
    constructor(input) {
        const aliases = new Map();
        for (const candidate of input) {
            const alias = parseWorktreeAlias(candidate);
            if (aliases.has(alias.alias_worktree_id))
                throw new CoordinationRuntimeError('store-corrupt', 'worktree alias registry contains a duplicate alias identity', [alias.alias_worktree_id]);
            aliases.set(alias.alias_worktree_id, alias);
        }
        for (const alias of aliases.values()) {
            if (aliases.has(alias.canonical_worktree_id))
                throw new CoordinationRuntimeError('store-corrupt', 'worktree alias chains are forbidden', [alias.alias_worktree_id, alias.canonical_worktree_id]);
        }
        this.#aliases = aliases;
    }
    resolve(worktreeId) {
        const alias = this.#aliases.get(worktreeId) ?? null;
        if (alias !== null)
            return Object.freeze({ requested_worktree_id: worktreeId, canonical_worktree_id: alias.canonical_worktree_id, resolution_state: alias.resolution_state, alias });
        if (!WORKTREE_ID_PATTERN.test(worktreeId))
            throw new CoordinationRuntimeError('invalid-state', 'historical worktree ID is absent from the immutable alias registry', [worktreeId]);
        return Object.freeze({ requested_worktree_id: worktreeId, canonical_worktree_id: worktreeId, resolution_state: 'canonical', alias: null });
    }
    resolveProjection(worktree) {
        const expected = deterministicWorktreeId(worktree.owner, worktree.kind);
        const resolved = this.resolve(worktree.worktree_id);
        if (resolved.canonical_worktree_id !== expected)
            throw new CoordinationRuntimeError('store-corrupt', 'worktree projection canonical identity disagrees with its indexed semantic tuple', [worktree.worktree_id, resolved.canonical_worktree_id, expected]);
        return resolved;
    }
    aliases() {
        return Object.freeze([...this.#aliases.values()].sort((left, right) => left.alias_worktree_id < right.alias_worktree_id ? -1 : left.alias_worktree_id > right.alias_worktree_id ? 1 : 0));
    }
}
