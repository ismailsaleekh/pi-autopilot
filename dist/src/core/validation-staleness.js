import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from "./parallel-runtime.js";
import { parseAutopilotUnitMerge } from "./unit-merge.js";
export class AutopilotValidationStalenessError extends Error {
    name = 'AutopilotValidationStalenessError';
    code;
    constructor(code, message) {
        super(`AutopilotValidationStalenessError [${code}]: ${message}`);
        this.code = code;
    }
}
function fail(code, message) {
    throw new AutopilotValidationStalenessError(code, message);
}
export function parseValidationEvidence(value) {
    if (!isRecord(value))
        fail('invalid-validation-evidence', 'validation evidence must be an object.');
    return {
        schema_version: expectConst(value, 'schema_version', 'autopilot.validation_evidence.v1'),
        workstream: expectString(value, 'workstream'),
        source_unit_id: expectString(value, 'source_unit_id'),
        source_attempt: expectInteger(value, 'source_attempt'),
        validation_unit_id: expectString(value, 'validation_unit_id'),
        validation_attempt: expectInteger(value, 'validation_attempt'),
        unit_merge_ref: expectString(value, 'unit_merge_ref'),
        integration_head: expectString(value, 'integration_head'),
        covered_paths: expectStringArray(value, 'covered_paths'),
        covered_path_groups: expectStringArray(value, 'covered_path_groups'),
        witness_ids: expectStringArray(value, 'witness_ids'),
        status_ref: expectString(value, 'status_ref'),
        receipt_ref: expectString(value, 'receipt_ref'),
        audit_ref: expectString(value, 'audit_ref'),
        verdict: expectVerdict(value),
        validated_at: expectString(value, 'validated_at'),
    };
}
export async function recordValidationStalenessForMerge(input) {
    const now = input.now ?? new Date();
    const invalidatingMerge = parseAutopilotUnitMerge(await readRuntimeJson(input.runtimeRoot, input.invalidatingMergeRef));
    const records = [];
    for (const ref of input.validationEvidenceRefs) {
        const validation = parseValidationEvidence(await readRuntimeJson(input.runtimeRoot, ref));
        if (validation.verdict !== 'PASS')
            continue;
        if (validation.source_unit_id === invalidatingMerge.unit_id && validation.source_attempt === invalidatingMerge.attempt)
            continue;
        const overlap = overlapping(validation.covered_paths, invalidatingMerge.changed_paths);
        if (overlap.length === 0)
            continue;
        const record = {
            schema_version: 'autopilot.validation_staleness.v1',
            workstream: input.workstream,
            stale_validation_ref: ref,
            source_unit_id: validation.source_unit_id,
            source_attempt: validation.source_attempt,
            invalidating_unit_merge_ref: input.invalidatingMergeRef,
            invalidating_unit_id: invalidatingMerge.unit_id,
            invalidating_attempt: invalidatingMerge.attempt,
            overlapping_paths: overlap,
            next_state: validation.source_attempt > 1 ? 'revalidation-ready' : 'validation-ready',
            created_at: now.toISOString(),
        };
        const path = join(input.runtimeRoot, 'validation-staleness', `${validation.source_unit_id}.attempt-${String(validation.source_attempt)}.by-${invalidatingMerge.unit_id}.json`);
        await writeJsonAtomic(path, record);
        records.push(record);
    }
    return Object.freeze(records);
}
export function validationCanCloseSourceWork(input) {
    return input.validation.verdict === 'PASS' &&
        input.validation.source_unit_id === input.unitMerge.unit_id &&
        input.validation.source_attempt === input.unitMerge.attempt &&
        input.validation.unit_merge_ref.length > 0 &&
        input.validation.integration_head === input.unitMerge.integration_after;
}
async function readRuntimeJson(runtimeRoot, ref) {
    const path = join(runtimeRoot, ref);
    if (!existsSync(path))
        fail('missing-runtime-ref', `runtime ref is missing: ${ref}`);
    return JSON.parse(await readFile(path, 'utf8'));
}
function overlapping(left, right) {
    const out = [];
    for (const path of left) {
        if (right.some((other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`)))
            out.push(path);
    }
    return Object.freeze([...new Set(out)].sort((a, b) => a.localeCompare(b)));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function expectString(record, key) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0)
        fail('invalid-validation-evidence', `${key} must be a non-empty string.`);
    return value;
}
function expectInteger(record, key) {
    const value = record[key];
    if (!Number.isInteger(value))
        fail('invalid-validation-evidence', `${key} must be an integer.`);
    return value;
}
function expectConst(record, key, expected) {
    const value = record[key];
    if (value !== expected)
        fail('invalid-validation-evidence', `${key} must equal ${expected}.`);
    return expected;
}
function expectStringArray(record, key) {
    const value = record[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
        fail('invalid-validation-evidence', `${key} must be a string array.`);
    return Object.freeze([...value]);
}
function expectVerdict(record) {
    const value = expectString(record, 'verdict');
    if (value !== 'PASS' && value !== 'NEEDS_FIX' && value !== 'BLOCKED')
        fail('invalid-validation-evidence', 'verdict is invalid.');
    return value;
}
