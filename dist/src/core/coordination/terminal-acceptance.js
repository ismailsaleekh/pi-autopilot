import { createHash, randomBytes } from 'node:crypto';
import { link, readFile, unlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseAutopilotExecutionAudit, parseAutopilotReceipt, parseAutopilotStatusEntry, parseAutopilotUnitSpec } from "../contracts/index.js";
import { writeJsonAtomic } from "../parallel-runtime.js";
import { CoordinationRuntimeError } from "./failures.js";
export const AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA = 'autopilot.child_terminal_acceptance.v1';
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_REF_LENGTH = 1024;
const ACCEPTED_VERDICTS = new Set(['DONE', 'PASS', 'NEEDS_FIX', 'BLOCKED']);
function record(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} must be an object`);
    return value;
}
function exact(value, fields, label) {
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index]))
        throw new CoordinationRuntimeError('invalid-state', `${label} fields are not exact`, actual);
}
function text(value, field, label, maximum = 512) {
    const entry = value[field];
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > maximum || entry.includes('\u0000'))
        throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be bounded non-empty text`);
    return entry;
}
function identifier(value, field, label) {
    const entry = text(value, field, label, 192);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u.test(entry))
        throw new CoordinationRuntimeError('invalid-state', `${label}.${field} is not an identifier`);
    return entry;
}
function evidence(value, label) {
    const entry = record(value, label);
    exact(entry, ['ref', 'sha256'], label);
    const ref = text(entry, 'ref', label, MAX_REF_LENGTH).replace(/\\/gu, '/');
    const digest = text(entry, 'sha256', label, 71);
    if (ref.startsWith('/') || ref.startsWith('../') || ref.includes('/../') || ref === '..' || /^[A-Za-z]:/u.test(ref))
        throw new CoordinationRuntimeError('invalid-state', `${label}.ref is not run-relative`);
    if (!SHA256.test(digest))
        throw new CoordinationRuntimeError('invalid-state', `${label}.sha256 is not a SHA-256 digest`);
    return { ref, sha256: digest };
}
export function parseAutopilotChildTerminalAcceptance(value) {
    const label = 'AutopilotChildTerminalAcceptance';
    const entry = record(value, label);
    exact(entry, ['schema_version', 'repo_id', 'autopilot_id', 'workstream', 'workstream_run', 'unit_id', 'role', 'attempt', 'child_lease_id', 'verdict', 'transport_result', 'spec', 'status', 'receipt', 'audit', 'tool_call_id', 'carrier_status_sha256', 'audit_disposition', 'created_at'], label);
    if (entry['schema_version'] !== AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA)
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance schema is incompatible');
    const role = text(entry, 'role', label);
    if (!['implement', 'validate', 'fix', 'bughunt', 'strategy', 'adjudicate'].includes(role))
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance role is invalid');
    const attempt = entry['attempt'];
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1)
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance attempt must be a positive integer');
    const verdict = text(entry, 'verdict', label);
    if (!ACCEPTED_VERDICTS.has(verdict))
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance verdict is invalid');
    if (entry['transport_result'] !== 'accepted')
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance transport_result must be accepted');
    const carrierStatusSha256 = text(entry, 'carrier_status_sha256', label, 71);
    if (!SHA256.test(carrierStatusSha256))
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance carrier_status_sha256 is invalid');
    const auditDisposition = text(entry, 'audit_disposition', label);
    if (auditDisposition !== 'zero-change' && auditDisposition !== 'accounted-changes')
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance audit_disposition is invalid');
    const createdAt = text(entry, 'created_at', label, 32);
    if (!Number.isFinite(Date.parse(createdAt)))
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance created_at is invalid');
    return {
        schema_version: AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA,
        repo_id: identifier(entry, 'repo_id', label),
        autopilot_id: identifier(entry, 'autopilot_id', label),
        workstream: identifier(entry, 'workstream', label),
        workstream_run: identifier(entry, 'workstream_run', label),
        unit_id: identifier(entry, 'unit_id', label),
        role,
        attempt,
        child_lease_id: identifier(entry, 'child_lease_id', label),
        verdict,
        transport_result: 'accepted',
        spec: evidence(entry['spec'], `${label}.spec`),
        status: evidence(entry['status'], `${label}.status`),
        receipt: evidence(entry['receipt'], `${label}.receipt`),
        audit: evidence(entry['audit'], `${label}.audit`),
        tool_call_id: identifier(entry, 'tool_call_id', label),
        carrier_status_sha256: carrierStatusSha256,
        audit_disposition: auditDisposition,
        created_at: createdAt,
    };
}
function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function relativeEvidence(root, path, bytes, label) {
    const ref = relative(resolve(root), resolve(path)).replace(/\\/gu, '/');
    if (ref.length === 0 || ref.startsWith('../') || ref.startsWith('/') || /^[A-Za-z]:/u.test(ref))
        throw new CoordinationRuntimeError('unauthorized-client', `${label} is outside the durable run main worktree`, [path]);
    return { ref, sha256: sha256(bytes) };
}
export async function writeAutopilotChildTerminalAcceptance(input) {
    const [specBytes, statusBytes, receiptBytes, auditBytes] = await Promise.all([
        readFile(input.specPath), readFile(input.statusPath), readFile(input.receiptPath), readFile(input.auditPath),
    ]);
    const expectedSpec = relativeEvidence(input.mainWorktreePath, input.specPath, specBytes, 'terminal acceptance spec');
    const expectedStatus = relativeEvidence(input.mainWorktreePath, input.statusPath, statusBytes, 'terminal acceptance status');
    const expectedReceipt = relativeEvidence(input.mainWorktreePath, input.receiptPath, receiptBytes, 'terminal acceptance receipt');
    const expectedAudit = relativeEvidence(input.mainWorktreePath, input.auditPath, auditBytes, 'terminal acceptance audit');
    const path = join(input.runtimeRoot, 'terminal-acceptances', `${input.child.owner.unit_id}.${input.status.role}.attempt-${String(input.child.owner.attempt)}.json`);
    const existingAcceptance = async () => {
        let bytes;
        try {
            bytes = await readFile(path);
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
                return null;
            throw error;
        }
        const existing = parseAutopilotChildTerminalAcceptance(parseJson(bytes, 'existing terminal acceptance'));
        assertAutopilotChildTerminalAcceptanceChain({ acceptance: existing, child: input.child, specBytes, statusBytes, receiptBytes, auditBytes });
        if (existing.spec.ref !== expectedSpec.ref || existing.status.ref !== expectedStatus.ref || existing.receipt.ref !== expectedReceipt.ref || existing.audit.ref !== expectedAudit.ref)
            throw new CoordinationRuntimeError('idempotency-conflict', 'existing terminal acceptance artifact refs differ from the exact parent-validated inputs', [path]);
        return { path, evidence: relativeEvidence(input.mainWorktreePath, path, bytes, 'existing terminal acceptance artifact'), acceptance: existing };
    };
    const existing = await existingAcceptance();
    if (existing !== null)
        return existing;
    const acceptance = parseAutopilotChildTerminalAcceptance({
        schema_version: AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA,
        repo_id: input.child.owner.repo_id,
        autopilot_id: input.child.owner.autopilot_id,
        workstream: input.workstream,
        workstream_run: input.child.owner.workstream_run,
        unit_id: input.child.owner.unit_id,
        role: input.status.role,
        attempt: input.child.owner.attempt,
        child_lease_id: input.child.child_lease_id,
        verdict: input.status.verdict,
        transport_result: 'accepted',
        spec: expectedSpec,
        status: expectedStatus,
        receipt: expectedReceipt,
        audit: expectedAudit,
        tool_call_id: input.receipt.tool_call_id,
        carrier_status_sha256: input.receipt.status_sha256,
        audit_disposition: autopilotAuditProvesZeroSourceChange(input.audit) ? 'zero-change' : 'accounted-changes',
        created_at: (input.now ?? new Date()).toISOString(),
    });
    assertAutopilotChildTerminalAcceptanceChain({ acceptance, child: input.child, specBytes, statusBytes, receiptBytes, auditBytes });
    const stagingPath = `${path}.${String(process.pid)}.${randomBytes(16).toString('hex')}.pending`;
    await writeJsonAtomic(stagingPath, acceptance);
    try {
        try {
            await link(stagingPath, path);
        }
        catch (error) {
            if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'))
                throw error;
            const raced = await existingAcceptance();
            if (raced === null)
                throw new CoordinationRuntimeError('recovery-required', 'terminal acceptance create race lost without a durable artifact', [path]);
            return raced;
        }
        const bytes = await readFile(path);
        return { path, evidence: relativeEvidence(input.mainWorktreePath, path, bytes, 'terminal acceptance artifact'), acceptance };
    }
    finally {
        await unlink(stagingPath).catch((error) => {
            if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'))
                throw error;
        });
    }
}
function parseJson(bytes, label) {
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', `${label} is not valid UTF-8 JSON`, [error instanceof Error ? error.message : String(error)]);
    }
}
export function autopilotAuditProvesZeroSourceChange(audit) {
    return audit.classification !== 'audit-unavailable'
        && audit.dirty_baseline === false
        && audit.head_change_kind === 'none'
        && audit.baseline_head !== null
        && audit.baseline_head !== undefined
        && audit.post_run_head === audit.baseline_head
        && audit.path_counts.dirty_baseline_paths === 0
        && audit.path_counts.actual_changed_paths === 0
        && audit.path_counts.dirty_relevant_paths === 0
        && audit.path_counts.omitted_status_changes === 0
        && audit.path_counts.reported_but_not_actual_changes === 0
        && audit.path_counts.outside_owned_paths === 0
        && audit.path_counts.read_only_touched_paths === 0
        && audit.path_counts.untouchable_touched_paths === 0
        && audit.truncated_path_sets.length === 0
        && (audit.committed_changed_paths ?? []).length === 0;
}
export function assertAutopilotChildTerminalAcceptanceChain(input) {
    const { acceptance, child } = input;
    if (acceptance.repo_id !== child.owner.repo_id || acceptance.autopilot_id !== child.owner.autopilot_id || acceptance.workstream_run !== child.owner.workstream_run || acceptance.unit_id !== child.owner.unit_id || acceptance.attempt !== child.owner.attempt || acceptance.child_lease_id !== child.child_lease_id)
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance identity differs from the authenticated child lease');
    for (const [label, expected, bytes] of [
        ['spec', acceptance.spec.sha256, input.specBytes], ['status', acceptance.status.sha256, input.statusBytes], ['receipt', acceptance.receipt.sha256, input.receiptBytes], ['audit', acceptance.audit.sha256, input.auditBytes],
    ])
        if (sha256(bytes) !== expected)
            throw new CoordinationRuntimeError('invalid-state', `terminal acceptance ${label} hash differs from its artifact bytes`);
    const spec = parseAutopilotUnitSpec(parseJson(input.specBytes, 'terminal acceptance spec'));
    const audit = parseAutopilotExecutionAudit(parseJson(input.auditBytes, 'terminal acceptance audit'));
    const status = parseAutopilotStatusEntry(parseJson(input.statusBytes, 'terminal acceptance status'), { unitSpec: spec, executionAudit: audit });
    const receipt = parseAutopilotReceipt(parseJson(input.receiptBytes, 'terminal acceptance receipt'));
    if (spec.workstream !== acceptance.workstream || spec.unit_id !== acceptance.unit_id || spec.role !== acceptance.role || spec.attempt !== acceptance.attempt || status.workstream !== acceptance.workstream || status.unit_id !== acceptance.unit_id || status.role !== acceptance.role || status.attempt !== acceptance.attempt || status.verdict !== acceptance.verdict || receipt.workstream !== acceptance.workstream || receipt.unit_id !== acceptance.unit_id || receipt.role !== acceptance.role || receipt.attempt !== acceptance.attempt || audit.workstream !== acceptance.workstream || audit.unit_id !== acceptance.unit_id || audit.role !== acceptance.role || audit.attempt !== acceptance.attempt)
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance spec/status/receipt/audit identities disagree');
    if (receipt.tool_name !== 'autopilot_emit_status' || receipt.tool_call_id !== acceptance.tool_call_id || receipt.status_sha256 !== acceptance.status.sha256 || receipt.status_sha256 !== acceptance.carrier_status_sha256)
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance does not bind the exact accepted forced-output carrier');
    const disposition = autopilotAuditProvesZeroSourceChange(audit) ? 'zero-change' : 'accounted-changes';
    if (acceptance.audit_disposition !== disposition)
        throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance audit disposition differs from the exact execution audit');
    return { spec, status, receipt, audit };
}
