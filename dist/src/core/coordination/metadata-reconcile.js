import { isAbsolute, normalize } from 'node:path';
import { canonicalJson } from "./canonical-json.js";
import { CoordinationRuntimeError } from "./failures.js";
export const AUTOPILOT_METADATA_RECONCILE_INTENT_SCHEMA = 'autopilot.worktree_metadata_reconcile_intent.v1';
export const AUTOPILOT_METADATA_RECONCILE_EVIDENCE_SCHEMA = 'autopilot.worktree_metadata_reconcile_evidence.v1';
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CANONICAL_WORKTREE_ID_PATTERN = /^worktree-[a-f0-9]{32}$/u;
const REF_PATTERN = /^refs\/(?:heads|autopilot|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u;
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
function absolutePath(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value) || normalize(value) !== value)
        throw new CoordinationRuntimeError('invalid-request', `${label} must be a normalized absolute NUL-free path`);
    return value;
}
function sha(value, label) {
    if (typeof value !== 'string' || !SHA_PATTERN.test(value))
        throw new CoordinationRuntimeError('invalid-request', `${label} must be a lowercase Git object ID`);
    return value;
}
function parseRegistration(value, label) {
    const record = exactObject(value, ['branch_ref', 'head_sha', 'prunable', 'worktree_path'], label);
    const branch = record['branch_ref'];
    if (branch !== null && (typeof branch !== 'string' || !REF_PATTERN.test(branch)))
        throw new CoordinationRuntimeError('invalid-request', `${label}.branch_ref must be null or a normalized owned Git ref`);
    if (typeof record['prunable'] !== 'boolean')
        throw new CoordinationRuntimeError('invalid-request', `${label}.prunable must be boolean`);
    return Object.freeze({ worktree_path: absolutePath(record['worktree_path'], `${label}.worktree_path`), head_sha: sha(record['head_sha'], `${label}.head_sha`), branch_ref: branch, prunable: record['prunable'] });
}
function parsePreservedRef(value, label) {
    const record = exactObject(value, ['ref', 'sha'], label);
    const ref = record['ref'];
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref))
        throw new CoordinationRuntimeError('invalid-request', `${label}.ref is invalid`);
    return Object.freeze({ ref, sha: sha(record['sha'], `${label}.sha`) });
}
function sortedUnique(values, identity, label) {
    const output = [...values].sort((left, right) => {
        const leftKey = identity(left);
        const rightKey = identity(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    for (let index = 1; index < output.length; index += 1) {
        const previous = output[index - 1];
        const current = output[index];
        if (previous !== undefined && current !== undefined && identity(previous) === identity(current))
            throw new CoordinationRuntimeError('invalid-request', `${label} contains a duplicate identity`, [identity(current)]);
    }
    if (canonicalJson(values) !== canonicalJson(output))
        throw new CoordinationRuntimeError('invalid-request', `${label} must be sorted by stable identity`);
    return Object.freeze(output);
}
function registrationIdentity(value) { return value.worktree_path; }
function refIdentity(value) { return value.ref; }
function parseRegistrationArray(value, label) {
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-request', `${label} must be an array`);
    return sortedUnique(value.map((entry, index) => parseRegistration(entry, `${label}[${String(index)}]`)), registrationIdentity, label);
}
function parseRefArray(value, label) {
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-request', `${label} must be an array`);
    return sortedUnique(value.map((entry, index) => parsePreservedRef(entry, `${label}[${String(index)}]`)), refIdentity, label);
}
function parsePathArray(value, label) {
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-request', `${label} must be an array`);
    return sortedUnique(value.map((entry, index) => absolutePath(entry, `${label}[${String(index)}]`)), (entry) => entry, label);
}
export function parseMetadataReconcileIntent(value) {
    const label = 'MetadataReconcileIntent';
    const record = exactObject(value, ['approved_before_registrations', 'approved_prunable_registration_paths', 'canonical_worktree_id', 'expected_after_registrations', 'git_common_dir', 'preserved_refs', 'recovery_evidence_sha256', 'repo_id', 'schema_version', 'target_registration_path'], label);
    if (record['schema_version'] !== AUTOPILOT_METADATA_RECONCILE_INTENT_SCHEMA)
        throw new CoordinationRuntimeError('invalid-request', `${label}.schema_version is invalid`);
    const repoId = record['repo_id'];
    const canonicalId = record['canonical_worktree_id'];
    const evidence = record['recovery_evidence_sha256'];
    if (typeof repoId !== 'string' || repoId.length === 0 || repoId.includes('\0'))
        throw new CoordinationRuntimeError('invalid-request', `${label}.repo_id is invalid`);
    if (typeof canonicalId !== 'string' || !CANONICAL_WORKTREE_ID_PATTERN.test(canonicalId))
        throw new CoordinationRuntimeError('invalid-request', `${label}.canonical_worktree_id is invalid`);
    if (typeof evidence !== 'string' || !SHA256_PATTERN.test(evidence))
        throw new CoordinationRuntimeError('invalid-request', `${label}.recovery_evidence_sha256 is invalid`);
    const before = parseRegistrationArray(record['approved_before_registrations'], `${label}.approved_before_registrations`);
    const approved = parsePathArray(record['approved_prunable_registration_paths'], `${label}.approved_prunable_registration_paths`);
    const after = parseRegistrationArray(record['expected_after_registrations'], `${label}.expected_after_registrations`);
    const target = absolutePath(record['target_registration_path'], `${label}.target_registration_path`);
    const completePrunable = before.filter((entry) => entry.prunable).map((entry) => entry.worktree_path);
    if (canonicalJson(approved) !== canonicalJson(completePrunable))
        throw new CoordinationRuntimeError('invalid-request', 'metadata reconcile approved set must equal the complete pre-reconcile prunable set');
    if (!approved.includes(target))
        throw new CoordinationRuntimeError('invalid-request', 'metadata reconcile target registration is not in the exact approved prunable set', [target]);
    const expectedAfter = before.filter((entry) => !approved.includes(entry.worktree_path));
    if (canonicalJson(after) !== canonicalJson(expectedAfter))
        throw new CoordinationRuntimeError('invalid-request', 'metadata reconcile expected-after set is not the exact before-minus-approved set');
    return Object.freeze({
        schema_version: AUTOPILOT_METADATA_RECONCILE_INTENT_SCHEMA,
        repo_id: repoId,
        canonical_worktree_id: canonicalId,
        git_common_dir: absolutePath(record['git_common_dir'], `${label}.git_common_dir`),
        target_registration_path: target,
        approved_before_registrations: before,
        approved_prunable_registration_paths: approved,
        expected_after_registrations: after,
        preserved_refs: parseRefArray(record['preserved_refs'], `${label}.preserved_refs`),
        recovery_evidence_sha256: evidence,
    });
}
/** Store-side proof gate. It compares exact sets and cannot authorize path/ref deletion. */
export function assertMetadataReconcileEvidence(intentInput, evidenceInput) {
    const intent = parseMetadataReconcileIntent(intentInput);
    const evidence = parseMetadataReconcileEvidence(evidenceInput);
    if (evidence.canonical_worktree_id !== intent.canonical_worktree_id
        || canonicalJson(evidence.observed_before_registrations) !== canonicalJson(intent.approved_before_registrations)
        || canonicalJson(evidence.approved_prunable_registration_paths) !== canonicalJson(intent.approved_prunable_registration_paths)
        || canonicalJson(evidence.observed_after_registrations) !== canonicalJson(intent.expected_after_registrations)
        || canonicalJson(evidence.preserved_refs_before) !== canonicalJson(intent.preserved_refs)
        || canonicalJson(evidence.preserved_refs_after) !== canonicalJson(intent.preserved_refs)) {
        throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation evidence does not prove the exact approved non-destructive before/after transition', [intent.canonical_worktree_id]);
    }
}
export function parseMetadataReconcileEvidence(value) {
    const label = 'MetadataReconcileEvidence';
    const record = exactObject(value, ['approved_prunable_registration_paths', 'canonical_worktree_id', 'observed_after_registrations', 'observed_before_registrations', 'operation_key_sha256', 'preserved_refs_after', 'preserved_refs_before', 'schema_version'], label);
    const canonicalId = record['canonical_worktree_id'];
    const operationKey = record['operation_key_sha256'];
    if (record['schema_version'] !== AUTOPILOT_METADATA_RECONCILE_EVIDENCE_SCHEMA)
        throw new CoordinationRuntimeError('invalid-request', `${label}.schema_version is invalid`);
    if (typeof canonicalId !== 'string' || !CANONICAL_WORKTREE_ID_PATTERN.test(canonicalId))
        throw new CoordinationRuntimeError('invalid-request', `${label}.canonical_worktree_id is invalid`);
    if (typeof operationKey !== 'string' || !SHA256_PATTERN.test(operationKey))
        throw new CoordinationRuntimeError('invalid-request', `${label}.operation_key_sha256 is invalid`);
    return Object.freeze({
        schema_version: AUTOPILOT_METADATA_RECONCILE_EVIDENCE_SCHEMA,
        canonical_worktree_id: canonicalId,
        operation_key_sha256: operationKey,
        observed_before_registrations: parseRegistrationArray(record['observed_before_registrations'], `${label}.observed_before_registrations`),
        approved_prunable_registration_paths: parsePathArray(record['approved_prunable_registration_paths'], `${label}.approved_prunable_registration_paths`),
        observed_after_registrations: parseRegistrationArray(record['observed_after_registrations'], `${label}.observed_after_registrations`),
        preserved_refs_before: parseRefArray(record['preserved_refs_before'], `${label}.preserved_refs_before`),
        preserved_refs_after: parseRefArray(record['preserved_refs_after'], `${label}.preserved_refs_after`),
    });
}
