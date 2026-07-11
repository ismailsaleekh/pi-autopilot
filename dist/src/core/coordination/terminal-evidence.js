import { CoordinationRuntimeError } from "./failures.js";
function record(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} must be a JSON object`);
    return value;
}
function text(value, field, label) {
    const entry = value[field];
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 2048)
        throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be bounded non-empty text`);
    return entry;
}
function integer(value, field, label) {
    const entry = value[field];
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 1)
        throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be a positive integer`);
    return entry;
}
function assertIdentity(document, expected, includeAutopilot) {
    if (text(document, 'workstream_run', 'reconciliation evidence') !== expected.workstreamRun)
        throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence workstream_run does not match durable ownership');
    if (includeAutopilot && text(document, 'autopilot_id', 'reconciliation evidence') !== expected.autopilotId)
        throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence autopilot_id does not match durable ownership');
    if (expected.unitId !== null && text(document, 'unit_id', 'reconciliation evidence') !== expected.unitId)
        throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence unit_id does not match its release target');
    if (expected.attempt !== null && integer(document, 'attempt', 'reconciliation evidence') !== expected.attempt)
        throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence attempt does not match its release target');
}
export function parseUnitAttemptTarget(targetId) {
    const split = targetId.lastIndexOf(':');
    if (split <= 0)
        throw new CoordinationRuntimeError('invalid-request', 'unit terminal evidence target must be unit-id:attempt');
    const attempt = Number(targetId.slice(split + 1));
    if (!Number.isSafeInteger(attempt) || attempt < 1)
        throw new CoordinationRuntimeError('invalid-request', 'unit terminal evidence target attempt is invalid');
    return { unitId: targetId.slice(0, split), attempt };
}
export function validateReconciliationEvidenceDocument(bytes, expected) {
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence is not valid UTF-8 JSON', [error instanceof Error ? error.message : String(error)]);
    }
    const document = record(parsed, 'reconciliation evidence');
    const schema = text(document, 'schema_version', 'reconciliation evidence');
    switch (expected.source) {
        case 'child-process':
            if (schema !== 'autopilot.receipt.v1')
                throw new CoordinationRuntimeError('invalid-state', 'child-terminal evidence must be an autopilot.receipt.v1 artifact');
            if (text(document, 'workstream', 'reconciliation evidence') !== expected.workstream)
                throw new CoordinationRuntimeError('invalid-state', 'child receipt workstream does not match durable ownership');
            if (expected.unitId === null || expected.attempt === null || text(document, 'unit_id', 'reconciliation evidence') !== expected.unitId || integer(document, 'attempt', 'reconciliation evidence') !== expected.attempt)
                throw new CoordinationRuntimeError('invalid-state', 'child receipt identity does not match its process lease');
            if (text(document, 'tool_name', 'reconciliation evidence') !== 'autopilot_emit_status')
                throw new CoordinationRuntimeError('invalid-state', 'child receipt does not prove the forced status carrier');
            return;
        case 'unit-merge':
            if (schema !== 'autopilot.unit_merge.v1')
                throw new CoordinationRuntimeError('invalid-state', 'unit-merge release requires autopilot.unit_merge.v1 evidence');
            assertIdentity(document, expected, true);
            if (text(document, 'merge_commit_sha', 'reconciliation evidence').length < 7)
                throw new CoordinationRuntimeError('invalid-state', 'unit-merge evidence lacks a commit identity');
            return;
        case 'attempt-reset': {
            if (schema !== 'autopilot.unit_failure.v1')
                throw new CoordinationRuntimeError('invalid-state', 'attempt-reset release requires autopilot.unit_failure.v1 evidence');
            assertIdentity(document, expected, false);
            const action = text(document, 'action', 'reconciliation evidence');
            if (action !== 'reset' && action !== 'abort')
                throw new CoordinationRuntimeError('invalid-state', 'attempt-reset evidence action must be reset or abort');
            return;
        }
        case 'quarantine-capture': {
            if (schema !== 'autopilot.unit_failure.v1')
                throw new CoordinationRuntimeError('invalid-state', 'quarantine release requires autopilot.unit_failure.v1 evidence');
            assertIdentity(document, expected, false);
            const action = text(document, 'action', 'reconciliation evidence');
            if (action !== 'quarantine' && action !== 'preserve')
                throw new CoordinationRuntimeError('invalid-state', 'quarantine evidence action must be quarantine or preserve');
            text(document, 'capture_commit_sha', 'reconciliation evidence');
            return;
        }
        case 'run-close':
        case 'run-abort': {
            if (schema !== 'autopilot.run_terminal.v1')
                throw new CoordinationRuntimeError('invalid-state', 'run terminal release requires autopilot.run_terminal.v1 evidence');
            if (text(document, 'repo_key', 'reconciliation evidence') !== expected.repoKey || text(document, 'autopilot_id', 'reconciliation evidence') !== expected.autopilotId || text(document, 'workstream_run', 'reconciliation evidence') !== expected.workstreamRun)
                throw new CoordinationRuntimeError('invalid-state', 'run terminal evidence identity does not match durable ownership');
            const expectedOutcome = expected.source === 'run-close' ? 'closed' : 'aborted';
            if (text(document, 'outcome', 'reconciliation evidence') !== expectedOutcome)
                throw new CoordinationRuntimeError('invalid-state', `run terminal evidence outcome must be ${expectedOutcome}`);
            text(document, 'terminal_sha', 'reconciliation evidence');
            return;
        }
    }
}
