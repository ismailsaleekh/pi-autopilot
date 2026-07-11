import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { CoordinationRuntimeError } from "./failures.js";
export const LEGACY_PREFLIGHT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const LEGACY_PREFLIGHT_MAX_FINDINGS = 100;
const ACTIVE_FILE = 'active-autopilots.json';
const CLAIM_FILE = 'path-claims.json';
const ACTIVE_STATUSES = ['active', 'paused', 'merging', 'blocked', 'crashed', 'closed'];
const CLAIM_MODES = ['READ', 'WRITE', 'EXCLUSIVE'];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function contractFailure(label, detail) {
    throw new CoordinationRuntimeError('invalid-state', `${label}: ${detail}`);
}
function isJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function object(value, label, fields) {
    if (!isJsonObject(value))
        contractFailure(label, 'must be an object');
    const record = value;
    const unknown = Object.keys(record).filter((field) => !fields.includes(field));
    if (unknown.length > 0)
        contractFailure(label, `unknown fields: ${unknown.sort().join(', ')}`);
    for (const field of fields)
        if (!(field in record))
            contractFailure(label, `missing field ${field}`);
    return record;
}
function string(record, field, label) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048)
        contractFailure(label, `${field} must be a bounded non-empty string`);
    return value;
}
function nullableString(record, field, label) {
    return record[field] === null ? null : string(record, field, label);
}
function isoTimestamp(record, field, label) {
    const value = string(record, field, label);
    if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value)))
        contractFailure(label, `${field} must be an ISO UTC timestamp`);
    return value;
}
function integer(record, field, label, minimum = 0) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
        contractFailure(label, `${field} must be a safe integer >= ${String(minimum)}`);
    return value;
}
function literal(record, field, expected, label) {
    if (record[field] !== expected)
        contractFailure(label, `${field} must equal ${expected}`);
    return expected;
}
function oneOf(record, field, values, label) {
    const value = record[field];
    if (typeof value !== 'string' || !values.includes(value))
        contractFailure(label, `${field} must be one of ${values.join(', ')}`);
    return value;
}
function absolutePath(record, field, label) {
    const value = string(record, field, label);
    if (!isAbsolute(value) || value.includes('\u0000'))
        contractFailure(label, `${field} must be absolute`);
    return value;
}
function repoPath(record, field, label) {
    const value = string(record, field, label);
    const segments = value.split('/');
    if (value.startsWith('/') || value.startsWith('./') || value.endsWith('/') || value.includes('//') || /^[A-Za-z]:/u.test(value) || segments.includes('.') || segments.includes('..') || value.includes('\\') || value.includes('\u0000'))
        contractFailure(label, `${field} must be repository-relative and normalized`);
    return value;
}
export function parseLegacyActiveAutopilotRow(value) {
    const label = 'legacy active Autopilot row';
    const record = object(value, label, ['active_epoch_started_at', 'active_run_epoch', 'active_run_receipt_id', 'autopilot_id', 'boot_id', 'branch', 'git_common_dir', 'main_worktree_path', 'origin_url', 'pid', 'repo_key', 'runtime_root', 'schema_version', 'source_repo', 'started_at', 'status', 'target_base_sha', 'target_branch', 'workstream', 'workstream_run', 'worktree_root']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.active_parent.v1', label),
        autopilot_id: string(record, 'autopilot_id', label),
        workstream: string(record, 'workstream', label),
        workstream_run: string(record, 'workstream_run', label),
        repo_key: string(record, 'repo_key', label),
        source_repo: absolutePath(record, 'source_repo', label),
        git_common_dir: absolutePath(record, 'git_common_dir', label),
        worktree_root: absolutePath(record, 'worktree_root', label),
        main_worktree_path: absolutePath(record, 'main_worktree_path', label),
        branch: string(record, 'branch', label),
        runtime_root: absolutePath(record, 'runtime_root', label),
        target_branch: nullableString(record, 'target_branch', label),
        target_base_sha: string(record, 'target_base_sha', label),
        origin_url: nullableString(record, 'origin_url', label),
        pid: integer(record, 'pid', label, 1),
        boot_id: string(record, 'boot_id', label),
        status: oneOf(record, 'status', ACTIVE_STATUSES, label),
        started_at: isoTimestamp(record, 'started_at', label),
        active_run_epoch: integer(record, 'active_run_epoch', label, 1),
        active_epoch_started_at: isoTimestamp(record, 'active_epoch_started_at', label),
        active_run_receipt_id: string(record, 'active_run_receipt_id', label),
    };
}
export function parseLegacyPathClaim(value) {
    const label = 'legacy path claim';
    const record = object(value, label, ['acquired_at', 'active_run_epoch', 'attempt', 'autopilot_id', 'claim_type', 'path', 'reason', 'schema_version', 'unit_id', 'workstream', 'workstream_run']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.path_claim.v1', label),
        path: repoPath(record, 'path', label),
        autopilot_id: string(record, 'autopilot_id', label),
        workstream: string(record, 'workstream', label),
        workstream_run: string(record, 'workstream_run', label),
        unit_id: string(record, 'unit_id', label),
        attempt: integer(record, 'attempt', label, 1),
        claim_type: oneOf(record, 'claim_type', CLAIM_MODES, label),
        acquired_at: isoTimestamp(record, 'acquired_at', label),
        active_run_epoch: integer(record, 'active_run_epoch', label, 1),
        reason: string(record, 'reason', label),
    };
}
function parseArray(value, label, parser) {
    if (!Array.isArray(value) || value.length > 100_000)
        contractFailure(label, 'must be a bounded array');
    return Object.freeze(value.map(parser));
}
export function parseLegacyActiveAutopilots(value) {
    return parseArray(value, ACTIVE_FILE, parseLegacyActiveAutopilotRow);
}
export function parseLegacyPathClaims(value) {
    return parseArray(value, CLAIM_FILE, parseLegacyPathClaim);
}
function canonicalClaimPath(path) {
    return path.replace(/\/\*\*$/u, '').replace(/\/$/u, '');
}
function pathDepth(path) {
    return path.split('/').length;
}
function conflict(left, right) {
    return left !== 'READ' || right !== 'READ';
}
export function checkLegacyCoordinationInvariants(input) {
    const findings = [];
    const internalFindingLimit = LEGACY_PREFLIGHT_MAX_FINDINGS + 1;
    const add = (code, entity, detail) => {
        if (findings.length < internalFindingLimit)
            findings.push({ code, severity: 'error', entity, detail });
    };
    const activeIds = new Set();
    const runIds = new Set();
    for (const row of input.rows) {
        if (row.repo_key !== input.repoKey)
            add('legacy-row-repository-mismatch', row.autopilot_id, `row repo_key ${row.repo_key} differs from ${input.repoKey}`);
        if (activeIds.has(row.autopilot_id))
            add('legacy-duplicate-autopilot-id', row.autopilot_id, 'autopilot_id occurs more than once');
        activeIds.add(row.autopilot_id);
        if (runIds.has(row.workstream_run))
            add('legacy-duplicate-workstream-run', row.workstream_run, 'workstream_run occurs more than once');
        runIds.add(row.workstream_run);
    }
    const claimKeys = new Set();
    for (const claim of input.claims) {
        const key = `${claim.autopilot_id}\0${claim.workstream_run}\0${claim.active_run_epoch}\0${claim.unit_id}\0${String(claim.attempt)}\0${claim.claim_type}\0${claim.path}`;
        if (claimKeys.has(key))
            add('legacy-duplicate-claim', claim.path, 'claim identity occurs more than once');
        claimKeys.add(key);
        const owner = input.rows.find((row) => row.autopilot_id === claim.autopilot_id && row.workstream_run === claim.workstream_run);
        if (owner === undefined) {
            add('legacy-claim-owner-missing', claim.path, `owner ${claim.autopilot_id}/${claim.workstream_run} does not exist`);
            continue;
        }
        if (owner.workstream !== claim.workstream)
            add('legacy-claim-workstream-mismatch', claim.path, `claim workstream ${claim.workstream} differs from owner ${owner.workstream}`);
        if (owner.active_run_epoch !== claim.active_run_epoch)
            add('legacy-old-epoch-claim', claim.path, `claim epoch ${String(claim.active_run_epoch)} differs from owner epoch ${String(owner.active_run_epoch)}`);
    }
    const indexedClaims = new Map();
    const orderedClaims = [...input.claims].sort((left, right) => {
        const leftPath = canonicalClaimPath(left.path);
        const rightPath = canonicalClaimPath(right.path);
        return pathDepth(leftPath) - pathDepth(rightPath) || leftPath.localeCompare(rightPath);
    });
    for (const claim of orderedClaims) {
        if (findings.length >= internalFindingLimit)
            break;
        const claimPath = canonicalClaimPath(claim.path);
        const segments = claimPath.split('/');
        const candidatePaths = segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
        for (const candidatePath of candidatePaths) {
            const indexed = indexedClaims.get(candidatePath);
            if (indexed === undefined)
                continue;
            for (const existing of [indexed.read, indexed.write]) {
                if (existing === null)
                    continue;
                const exactAttempt = existing.autopilot_id === claim.autopilot_id && existing.workstream_run === claim.workstream_run && existing.active_run_epoch === claim.active_run_epoch && existing.unit_id === claim.unit_id && existing.attempt === claim.attempt && existing.path === claim.path && existing.claim_type === claim.claim_type;
                if (!exactAttempt && conflict(existing.claim_type, claim.claim_type)) {
                    add('legacy-incompatible-claims', `${existing.path},${claim.path}`, `${existing.claim_type} owned by ${existing.workstream_run}/${existing.unit_id} overlaps ${claim.claim_type} owned by ${claim.workstream_run}/${claim.unit_id}`);
                    break;
                }
            }
        }
        const current = indexedClaims.get(claimPath) ?? { read: null, write: null };
        indexedClaims.set(claimPath, claim.claim_type === 'READ' ? { ...current, read: current.read ?? claim } : { ...current, write: current.write ?? claim });
    }
    if (input.activationWorkstream !== undefined && input.currentPid !== undefined && input.currentBootId !== undefined) {
        const resumed = input.rows.find((row) => row.workstream === input.activationWorkstream && ['active', 'paused', 'merging', 'blocked'].includes(row.status));
        if (resumed !== undefined && (resumed.pid !== input.currentPid || resumed.boot_id !== input.currentBootId)) {
            const ownedClaims = input.claims.filter((claim) => claim.autopilot_id === resumed.autopilot_id && claim.workstream_run === resumed.workstream_run);
            if (ownedClaims.length > 0)
                add('legacy-resume-would-self-conflict', resumed.workstream_run, `session replacement would advance epoch while ${String(ownedClaims.length)} run-owned claims remain epoch-bound`);
        }
    }
    return Object.freeze(findings);
}
async function readLegacyFile(path) {
    if (!existsSync(path))
        return { parsed: [], digest: null };
    const bytes = await readFile(path);
    if (bytes.byteLength > LEGACY_PREFLIGHT_MAX_INPUT_BYTES)
        throw new CoordinationRuntimeError('invalid-state', `${path} exceeds the ${String(LEGACY_PREFLIGHT_MAX_INPUT_BYTES)} byte preflight bound`);
    const text = new TextDecoder().decode(bytes);
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', `${path} contains invalid JSON`, [error instanceof Error ? error.message : String(error)]);
    }
    return { parsed, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}
function timestamp(value) {
    return value.toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z');
}
async function writeDiagnostic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
    await rename(temporary, path);
}
export async function runLegacyCoordinationPreflight(input) {
    const now = input.now ?? new Date();
    const diagnosticRoot = join(input.coordinationRoot, 'preflight');
    const diagnosticNonce = randomBytes(8).toString('hex');
    const diagnosticPath = join(diagnosticRoot, `${timestamp(now)}.${input.mode}.${diagnosticNonce}.json`);
    let rows = [];
    let claims = [];
    let activeDigest = null;
    let claimDigest = null;
    let findings = [];
    try {
        const activeFile = await readLegacyFile(join(input.coordinationRoot, ACTIVE_FILE));
        const claimFile = await readLegacyFile(join(input.coordinationRoot, CLAIM_FILE));
        activeDigest = activeFile.digest;
        claimDigest = claimFile.digest;
        rows = parseLegacyActiveAutopilots(activeFile.parsed);
        claims = parseLegacyPathClaims(claimFile.parsed);
        findings = checkLegacyCoordinationInvariants({
            repoKey: input.repoKey,
            rows,
            claims,
            ...(input.activationWorkstream === undefined ? {} : { activationWorkstream: input.activationWorkstream }),
            ...(input.currentPid === undefined ? {} : { currentPid: input.currentPid }),
            ...(input.currentBootId === undefined ? {} : { currentBootId: input.currentBootId }),
        });
    }
    catch (error) {
        findings = [{ code: error instanceof CoordinationRuntimeError ? error.code : 'invalid-state', severity: 'error', entity: 'legacy-coordination', detail: error instanceof Error ? error.message : String(error) }];
    }
    const bounded = findings.slice(0, LEGACY_PREFLIGHT_MAX_FINDINGS);
    const result = {
        schema_version: 'autopilot.coordination_preflight.v1',
        mode: input.mode,
        repo_key: input.repoKey,
        workstream: input.activationWorkstream ?? null,
        active_row_count: rows.length,
        claim_count: claims.length,
        active_rows_sha256: activeDigest,
        path_claims_sha256: claimDigest,
        findings: bounded,
        truncated_findings: Math.max(0, findings.length - bounded.length),
        safe: findings.every((entry) => entry.severity !== 'error'),
        created_at: now.toISOString(),
        diagnostic_path: diagnosticPath,
    };
    await writeDiagnostic(diagnosticPath, result);
    if (!result.safe) {
        const codes = [...new Set(bounded.map((entry) => entry.code))].join(', ');
        throw new CoordinationRuntimeError('invalid-state', `legacy coordination preflight refused inconsistent authority: ${codes}`, bounded.map((entry) => `${entry.code}: ${entry.entity}: ${entry.detail}`));
    }
    return result;
}
