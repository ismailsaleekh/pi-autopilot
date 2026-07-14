import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, constants as fsConstants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AUTOPILOT_ROLE_VALUES, parseAutopilotExecutionAudit, parseAutopilotReceipt, parseAutopilotStatusEntry } from "../contracts/index.js";
const MAX_LEGACY_TERMINAL_ARTIFACT_BYTES = 1024 * 1024;
const HISTORICAL_UNIT_STATES = new Set(['queued', 'ready', 'running', 'blocked', 'completed', 'failed']);
function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function json(bytes, label) {
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch (error) {
        throw new Error(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function artifact(runtimeRoot, path, label) {
    const resolvedRoot = realpathSync(runtimeRoot);
    const resolvedPath = resolve(path);
    const lexical = relative(resolve(runtimeRoot), resolvedPath);
    if (lexical.length === 0 || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical))
        throw new Error(`${label} escapes the runtime root`);
    const before = lstatSync(resolvedPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LEGACY_TERMINAL_ARTIFACT_BYTES)
        throw new Error(`${label} must be a bounded regular non-symbolic file`);
    const physicalPath = realpathSync(resolvedPath);
    const physical = relative(resolvedRoot, physicalPath);
    if (physical.length === 0 || physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical))
        throw new Error(`${label} physically escapes the runtime root`);
    const descriptor = openSync(resolvedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs || opened.size > MAX_LEGACY_TERMINAL_ARTIFACT_BYTES)
            throw new Error(`${label} identity changed while opening`);
        const bytes = readFileSync(descriptor);
        const afterDescriptor = fstatSync(descriptor);
        const afterPath = lstatSync(resolvedPath);
        if (bytes.byteLength !== opened.size || afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino || afterDescriptor.size !== opened.size || afterDescriptor.mtimeMs !== opened.mtimeMs || afterDescriptor.ctimeMs !== opened.ctimeMs || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size || afterPath.mtimeMs !== opened.mtimeMs || afterPath.ctimeMs !== opened.ctimeMs)
            throw new Error(`${label} identity changed during read`);
        return Object.freeze({ ref: lexical.split(sep).join('/'), path: resolvedPath, bytes, sha256: sha256(bytes) });
    }
    finally {
        closeSync(descriptor);
    }
}
function runtimeRef(runtimeRoot, ref, label) {
    const normalized = ref.replace(/\\/gu, '/');
    if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..' || normalized.includes('\u0000'))
        throw new Error(`${label} is not a safe runtime-relative ref`);
    const path = resolve(runtimeRoot, normalized);
    const rel = relative(resolve(runtimeRoot), path);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(`${label} escapes the runtime root`);
    return path;
}
function unproven(reason, inspectedPaths) {
    return { proven: false, reason, inspectedPaths: Object.freeze([...new Set(inspectedPaths)].sort()) };
}
function terminalStateProjection(value, unitId) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('runtime state is not an object');
    const state = value;
    if (state['schema_version'] !== 'autopilot.state.v1' || typeof state['workstream'] !== 'string')
        throw new Error('runtime state schema or workstream is invalid');
    const completed = state['completed'];
    const running = state['running'];
    const units = state['units'];
    if (!Array.isArray(completed) || !completed.every((entry) => typeof entry === 'string') || !Array.isArray(running) || !running.every((entry) => typeof entry === 'string'))
        throw new Error('runtime state completed/running queues are invalid');
    if (typeof units !== 'object' || units === null || Array.isArray(units))
        throw new Error('runtime state units map is invalid');
    const rawUnit = units[unitId];
    if (typeof rawUnit !== 'object' || rawUnit === null || Array.isArray(rawUnit))
        throw new Error(`runtime state lacks unit ${unitId}`);
    const unit = rawUnit;
    const role = unit['role'];
    const attempt = unit['attempt'];
    const unitState = unit['state'];
    if (unit['unit_id'] !== unitId || typeof role !== 'string' || !AUTOPILOT_ROLE_VALUES.includes(role) || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || typeof unitState !== 'string' || !HISTORICAL_UNIT_STATES.has(unitState))
        throw new Error(`runtime state identity for unit ${unitId} is invalid`);
    const statusRef = unit['status_ref'];
    const receiptRef = unit['receipt_ref'];
    if (statusRef !== undefined && typeof statusRef !== 'string')
        throw new Error('runtime state status_ref is invalid');
    if (receiptRef !== undefined && typeof receiptRef !== 'string')
        throw new Error('runtime state receipt_ref is invalid');
    return {
        workstream: state['workstream'], completed: Object.freeze([...completed]), running: Object.freeze([...running]),
        unit: { role: role, state: unitState, attempt, ...(statusRef === undefined ? {} : { statusRef }), ...(receiptRef === undefined ? {} : { receiptRef }) },
    };
}
export function proveLegacyReadAttemptTerminal(input) {
    const statePath = join(input.runtimeRoot, 'state.json');
    const inspectedPaths = [statePath];
    try {
        const stateArtifact = artifact(input.runtimeRoot, statePath, 'legacy READ terminal state');
        const state = terminalStateProjection(json(stateArtifact.bytes, 'legacy READ terminal state'), input.unitId);
        if (state.workstream !== input.workstream)
            return unproven('runtime state workstream does not match the durable run', inspectedPaths);
        const unit = state.unit;
        if (unit.attempt < input.attempt)
            return unproven(`runtime state attempt ${String(unit.attempt)} precedes retained claim attempt ${String(input.attempt)}`, inspectedPaths);
        if (unit.attempt > input.attempt) {
            const proof = {
                kind: 'superseded-by-later-attempt', unitId: input.unitId, attempt: input.attempt, currentAttempt: unit.attempt,
                evidence: stateArtifact, artifacts: Object.freeze([stateArtifact]),
                mechanicalProof: Object.freeze([
                    `runtime-state-current-attempt:${input.unitId}:${String(unit.attempt)}`,
                    `retained-read-attempt-superseded:${input.unitId}:${String(input.attempt)}`,
                    `state-sha256:${stateArtifact.sha256}`,
                ]),
            };
            return { proven: true, proof };
        }
        if (unit.state !== 'completed' || !state.completed.includes(input.unitId) || state.running.includes(input.unitId))
            return unproven(`runtime state does not prove attempt terminal: state=${unit.state}`, inspectedPaths);
        if (unit.statusRef === undefined || unit.receiptRef === undefined)
            return unproven('completed runtime state lacks status_ref or receipt_ref', inspectedPaths);
        const statusPath = runtimeRef(input.runtimeRoot, unit.statusRef, 'status_ref');
        const receiptPath = runtimeRef(input.runtimeRoot, unit.receiptRef, 'receipt_ref');
        const auditRef = `execution-audits/${input.unitId}.${unit.role}.attempt-${String(input.attempt)}.json`;
        const auditPath = runtimeRef(input.runtimeRoot, auditRef, 'execution audit ref');
        inspectedPaths.push(statusPath, receiptPath, auditPath);
        const auditArtifact = artifact(input.runtimeRoot, auditPath, 'legacy READ terminal execution audit');
        const audit = parseAutopilotExecutionAudit(json(auditArtifact.bytes, 'legacy READ terminal execution audit'));
        const statusArtifact = artifact(input.runtimeRoot, statusPath, 'legacy READ terminal status');
        const status = parseAutopilotStatusEntry(json(statusArtifact.bytes, 'legacy READ terminal status'), { artifactRoot: input.runtimeRoot, executionAudit: audit });
        const receiptArtifact = artifact(input.runtimeRoot, receiptPath, 'legacy READ terminal receipt');
        const receipt = parseAutopilotReceipt(json(receiptArtifact.bytes, 'legacy READ terminal receipt'), { statusOutputPath: statusPath });
        const exactIdentity = status.workstream === input.workstream && status.unit_id === input.unitId && status.role === unit.role && status.attempt === input.attempt
            && audit.workstream === input.workstream && audit.unit_id === input.unitId && audit.role === unit.role && audit.attempt === input.attempt
            && receipt.workstream === input.workstream && receipt.unit_id === input.unitId && receipt.role === unit.role && receipt.attempt === input.attempt;
        if (!exactIdentity)
            return unproven('status, receipt, audit, and runtime state identities disagree', inspectedPaths);
        if (realpathSync(receipt.status_output) !== realpathSync(statusPath))
            return unproven('receipt status_output does not resolve to the state-bound status artifact', inspectedPaths);
        if (status.verdict !== 'DONE' && status.verdict !== 'PASS')
            return unproven(`completed runtime status verdict is ${status.verdict}, not DONE/PASS`, inspectedPaths);
        if (audit.classification !== 'clean' || audit.omitted_status_changes.length !== 0 || audit.reported_but_not_actual_changes.length !== 0 || audit.outside_owned_paths.length !== 0 || audit.read_only_touched_paths.length !== 0 || audit.untouchable_touched_paths.length !== 0)
            return unproven('completed READ attempt does not have a clean scope-consistent execution audit', inspectedPaths);
        const artifacts = Object.freeze([stateArtifact, statusArtifact, receiptArtifact, auditArtifact]);
        const proof = {
            kind: 'completed-current-attempt', unitId: input.unitId, attempt: input.attempt, currentAttempt: unit.attempt,
            evidence: receiptArtifact, artifacts,
            mechanicalProof: Object.freeze([
                `runtime-state-completed:${input.unitId}:${String(input.attempt)}`,
                `terminal-status:${status.verdict}:${statusArtifact.sha256}`,
                `terminal-receipt:${receiptArtifact.sha256}`,
                `clean-scope-consistent-audit:${auditArtifact.sha256}`,
            ]),
        };
        return { proven: true, proof };
    }
    catch (error) {
        return unproven(`runtime terminal proof invalid: ${error instanceof Error ? error.message : String(error)}`, inspectedPaths);
    }
}
