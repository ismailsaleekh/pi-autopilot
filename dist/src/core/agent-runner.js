import { constants as fsConstants, existsSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOPILOT_STATUS_CONTEXT_ENV, AUTOPILOT_STATUS_TOOL, } from "./names.js";
import { buildAutopilotProviderIdentity, buildAutopilotStatusToolContext, deriveAutopilotArtifactRoot, parseAutopilotStatusToolContext, validateAutopilotStatusEvidence, } from "./forced-output/index.js";
import { AutopilotForcedOutputEvidenceError } from "./forced-output/status-evidence.js";
import { parseAutopilotStatusEntry, parseAutopilotUnitSpec } from "./contracts/index.js";
import { captureAutopilotExecutionBaseline, deriveAutopilotExecutionAuditPath, writeAutopilotExecutionAudit, } from "./execution-audit/index.js";
import { assertAutopilotSpecQualityGate } from "./quality/spec-gate.js";
import { AutopilotPromptTemplateError, renderAndMaybeWriteAutopilotPromptSnapshot, } from "./prompt-renderer/index.js";
export class AutopilotAgentRunError extends Error {
    failureClass;
    details;
    constructor(failureClass, details) {
        super(`${failureClass}: ${details.reason}`);
        this.name = 'AutopilotAgentRunError';
        this.failureClass = failureClass;
        this.details = details;
    }
}
const AUTOPILOT_AGENT_PI_EXECUTABLE_ENV = 'AUTOPILOT_AGENT_PI_EXECUTABLE';
const DEFAULT_AGENT_WALL_MS = 3_600_000;
const RPC_COMMAND_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_TEXT_LIMIT = 600;
const FAILURE_REASON_LIMIT = 2_400;
const AUTOPILOT_AGENT_STATUS_EXTENSION_PATH = resolveAutopilotStatusExtensionPath(import.meta.url);
function resolveAutopilotStatusExtensionPath(moduleUrl) {
    const sourcePath = fileURLToPath(new URL('../internal/status-extension.ts', moduleUrl));
    if (existsSync(sourcePath))
        return sourcePath;
    return fileURLToPath(new URL('../internal/status-extension.js', moduleUrl));
}
class AutopilotPiRunError extends Error {
    code;
    details;
    rpcRunArtifacts;
    constructor(code, message, details, rpcRunArtifacts) {
        super(message);
        this.name = 'AutopilotPiRunError';
        this.code = code;
        this.details = details;
        this.rpcRunArtifacts = rpcRunArtifacts;
    }
}
export async function runAutopilotAgentFromSpecPath(specPath, options = {}) {
    const spec = await readAndValidateSpec(specPath);
    let providerIdentity;
    let context;
    try {
        providerIdentity = buildAutopilotProviderIdentity(spec.model, spec.thinking);
        context = buildAutopilotStatusToolContext({ unitSpec: spec, providerIdentity });
    }
    catch (error) {
        throw new AutopilotAgentRunError('spec-invalid', {
            reason: errorMessage(error),
            specPath,
            statusOutput: spec.status_output,
            receiptOutput: spec.receipt_output,
        });
    }
    await preflightSpec(spec, specPath, { skipStaleOutputCheck: options.dryRun === true });
    const auditBaseline = await captureAutopilotExecutionBaseline(spec.cwd);
    const auditOutput = deriveAutopilotExecutionAuditPath(spec);
    const contextPath = deriveAutopilotStatusContextPath(spec);
    await writeStatusContext(contextPath, context);
    let rendered;
    try {
        rendered = await renderAndMaybeWriteAutopilotPromptSnapshot({
            spec,
            ...(options.forcePromptSnapshot === undefined ? {} : { forceSnapshot: options.forcePromptSnapshot }),
        });
    }
    catch (error) {
        if (error instanceof AutopilotPromptTemplateError) {
            throw new AutopilotAgentRunError('spec-invalid', {
                reason: `prompt template validation failed before model spend: ${error.message}`,
                specPath,
                statusOutput: spec.status_output,
                receiptOutput: spec.receipt_output,
            });
        }
        throw error;
    }
    if (options.dryRun === true) {
        return ({
            status: 'dry-run',
            spec,
            statusEntry: null,
            statusOutput: spec.status_output,
            receiptOutput: spec.receipt_output,
            promptSnapshotPath: rendered.snapshotPath,
            contextPath,
            auditOutput: null,
            auditClassification: null,
            summary: 'dry-run rendered prompt and status context without launching Pi',
        });
    }
    const env = { ...process.env, ...(options.env ?? {}) };
    const spawnSpec = {
        executable: options.piExecutable ?? resolvePiExecutable(env),
        model: providerIdentity.requested_model_id,
        thinking: providerIdentity.thinking_level,
        cwd: spec.cwd,
        toolPolicy: toolPolicyForRole(spec.role),
        env,
        contextPath,
        wallMs: options.timeoutMsOverride ?? timeoutMsForSpec(spec),
        name: `autopilot-${spec.unit_id}-${spec.role}-attempt-${String(spec.attempt)}`,
    };
    let piResult;
    try {
        piResult = await runPiPromptWithStatusCarrier(spawnSpec, rendered.text);
    }
    catch (error) {
        if (error instanceof AutopilotPiRunError) {
            const audit = await writeAttemptAudit(spec, auditBaseline, null, auditOutput);
            throw new AutopilotAgentRunError('pi-spawn-failed', {
                reason: `Pi spawn failed before valid Autopilot status acceptance: ${error.code}: ${error.message}${formatPiRunErrorDiagnostics(error)}`,
                specPath,
                statusOutput: spec.status_output,
                receiptOutput: spec.receipt_output,
                promptSnapshotPath: rendered.snapshotPath,
                auditOutput,
                auditClassification: audit.classification,
                piErrorCode: error.code,
            });
        }
        throw error;
    }
    let evidence;
    try {
        evidence = await validateAutopilotStatusEvidence({ unitSpec: spec, providerIdentity });
    }
    catch (error) {
        const audit = await writeAttemptAudit(spec, auditBaseline, null, auditOutput);
        if (piResult.isError) {
            throw new AutopilotAgentRunError('pi-spawn-failed', {
                reason: `Pi session returned an error result before valid Autopilot status acceptance: ${formatPiResultFailureDiagnostics(piResult)}`,
                specPath,
                statusOutput: spec.status_output,
                receiptOutput: spec.receipt_output,
                promptSnapshotPath: rendered.snapshotPath,
                auditOutput,
                auditClassification: audit.classification,
            });
        }
        if (error instanceof AutopilotForcedOutputEvidenceError) {
            const failureClass = error.code === 'missing-status' || error.code === 'missing-receipt'
                ? 'missing-structured-output'
                : 'invalid-structured-output';
            throw new AutopilotAgentRunError(failureClass, {
                reason: error.message,
                specPath,
                statusOutput: spec.status_output,
                receiptOutput: spec.receipt_output,
                promptSnapshotPath: rendered.snapshotPath,
                auditOutput,
                auditClassification: audit.classification,
            });
        }
        throw new AutopilotAgentRunError('invalid-structured-output', {
            reason: errorMessage(error),
            specPath,
            statusOutput: spec.status_output,
            receiptOutput: spec.receipt_output,
            promptSnapshotPath: rendered.snapshotPath,
            auditOutput,
            auditClassification: audit.classification,
        });
    }
    const audit = await writeAttemptAudit(spec, auditBaseline, evidence.status, auditOutput);
    try {
        validateAutopilotEmitStatusCarrier(piResult, evidence.receipt.tool_call_id, evidence.receipt.status_sha256);
        parseAutopilotStatusEntry(evidence.status, {
            unitSpec: spec,
            artifactRoot: deriveAutopilotArtifactRoot(spec),
            executionAudit: audit,
        });
    }
    catch (error) {
        throw new AutopilotAgentRunError('invalid-structured-output', {
            reason: errorMessage(error),
            specPath,
            statusOutput: spec.status_output,
            receiptOutput: spec.receipt_output,
            promptSnapshotPath: rendered.snapshotPath,
            auditOutput,
            auditClassification: audit.classification,
        });
    }
    if (!isSuccessVerdict(evidence.status)) {
        throw new AutopilotAgentRunError('status-non-success', {
            reason: `Autopilot status verdict ${evidence.status.verdict}: ${evidence.status.summary}`,
            specPath,
            statusOutput: spec.status_output,
            receiptOutput: spec.receipt_output,
            promptSnapshotPath: rendered.snapshotPath,
            auditOutput,
            auditClassification: audit.classification,
            statusVerdict: evidence.status.verdict,
        });
    }
    if (piResult.isError &&
        !isBenignTerminalStatusCompletion(piResult, evidence.receipt.tool_call_id, evidence.receipt.status_sha256)) {
        throw new AutopilotAgentRunError('pi-spawn-failed', {
            reason: `Pi session returned an error result after Autopilot status emission: ${formatPiResultFailureDiagnostics(piResult)}`,
            specPath,
            statusOutput: spec.status_output,
            receiptOutput: spec.receipt_output,
            promptSnapshotPath: rendered.snapshotPath,
            auditOutput,
            auditClassification: audit.classification,
        });
    }
    return ({
        status: 'success',
        spec,
        statusEntry: evidence.status,
        statusOutput: spec.status_output,
        receiptOutput: spec.receipt_output,
        promptSnapshotPath: rendered.snapshotPath,
        contextPath,
        auditOutput,
        auditClassification: audit.classification,
        summary: evidence.status.summary,
    });
}
async function readAndValidateSpec(specPath) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(specPath, 'utf8'));
    }
    catch (error) {
        throw new AutopilotAgentRunError('spec-invalid', {
            reason: `unit spec is not readable JSON: ${errorMessage(error)}`,
            specPath,
        });
    }
    try {
        const spec = parseAutopilotUnitSpec(parsed);
        assertAutopilotSpecQualityGate(spec);
        return spec;
    }
    catch (error) {
        throw new AutopilotAgentRunError('spec-invalid', {
            reason: errorMessage(error),
            specPath,
        });
    }
}
async function preflightSpec(spec, specPath, options = {}) {
    try {
        await access(spec.cwd, fsConstants.R_OK);
    }
    catch (error) {
        throw new AutopilotAgentRunError('spec-invalid', {
            reason: `cwd is not an accessible directory before model spend: ${spec.cwd}; ${errorMessage(error)}`,
            specPath,
        });
    }
    if (options.skipStaleOutputCheck !== true) {
        for (const [label, path] of [
            ['status_output', spec.status_output],
            ['receipt_output', spec.receipt_output],
        ]) {
            if (existsSync(path)) {
                throw new AutopilotAgentRunError('spec-invalid', {
                    reason: `${label} already exists; refusing stale forced-output path ${path}`,
                    specPath,
                    statusOutput: spec.status_output,
                    receiptOutput: spec.receipt_output,
                });
            }
        }
    }
    await mkdir(dirname(spec.status_output), { recursive: true });
    await mkdir(dirname(spec.receipt_output), { recursive: true });
    await mkdir(spec.evidence_dir, { recursive: true });
}
function timeoutMsForSpec(spec) {
    return spec.timeout_seconds === undefined ? DEFAULT_AGENT_WALL_MS : spec.timeout_seconds * 1000;
}
function deriveAutopilotStatusContextPath(spec) {
    return resolve(dirname(spec.receipt_output), `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.context.json`);
}
async function writeStatusContext(path, context) {
    const parsed = parseAutopilotStatusToolContext(JSON.parse(JSON.stringify(context)));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}
async function writeAttemptAudit(spec, baseline, statusEntry, auditPath) {
    return await writeAutopilotExecutionAudit({
        unitSpec: spec,
        baseline,
        statusEntry,
        auditPath,
    });
}
function resolvePiExecutable(env) {
    const override = env[AUTOPILOT_AGENT_PI_EXECUTABLE_ENV];
    if (override !== undefined) {
        if (override.trim().length === 0) {
            throw new AutopilotAgentRunError('spec-invalid', {
                reason: `${AUTOPILOT_AGENT_PI_EXECUTABLE_ENV} must be non-empty when set`,
            });
        }
        return override;
    }
    return 'pi';
}
function toolPolicyForRole(role) {
    if (role === 'implement' || role === 'fix' || role === 'strategy' || role === 'adjudicate') {
        return ({
            builtinTools: (['read', 'grep', 'find', 'ls', 'bash', 'write', 'edit']),
            customTools: ([AUTOPILOT_STATUS_TOOL]),
            disableMutatingBash: false,
        });
    }
    return ({
        builtinTools: (['read', 'grep', 'find', 'ls', 'bash']),
        customTools: ([AUTOPILOT_STATUS_TOOL]),
        disableMutatingBash: true,
    });
}
function buildPiToolArgument(policy) {
    return [...policy.builtinTools, ...policy.customTools].join(',');
}
function validateModelIdentity(model) {
    try {
        buildAutopilotProviderIdentity(model, 'high');
    }
    catch (error) {
        throw new AutopilotAgentRunError('spec-invalid', {
            reason: errorMessage(error),
        });
    }
}
async function runPiPromptWithStatusCarrier(spec, prompt) {
    validateModelIdentity(spec.model);
    const argv = [
        '--mode',
        'rpc',
        '--model',
        spec.model,
        '--thinking',
        spec.thinking,
        '--name',
        spec.name,
        '--no-session',
        '--no-context-files',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-extensions',
        '--approve',
        '--tools',
        buildPiToolArgument(spec.toolPolicy),
        '--extension',
        AUTOPILOT_AGENT_STATUS_EXTENSION_PATH,
    ];
    const env = sanitizeAgentEnv(spec.env, spec.contextPath);
    let child;
    try {
        child = spawn(spec.executable, argv, {
            cwd: spec.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
        });
    }
    catch (error) {
        throw new AutopilotPiRunError('spawn-failed', `Failed to start Pi executable ${JSON.stringify(spec.executable)}: ${errorMessage(error)}`);
    }
    return await supervisePiRpcChild(child, spec, prompt);
}
function sanitizeAgentEnv(env, contextPath) {
    const out = { ...env, [AUTOPILOT_STATUS_CONTEXT_ENV]: contextPath };
    delete out['PIPELINE_CODEX_CLI_EXECUTABLE'];
    delete out['PIPELINE_CODEX_CLI_MODEL'];
    return out;
}
function supervisePiRpcChild(child, spec, prompt) {
    return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        let stdoutBuffer = '';
        let stderrText = '';
        let lastState;
        let lastMessage;
        let turnCount = 0;
        let sawErrorEvent = false;
        const pendingCommands = new Map();
        const eventWaiters = new Map();
        const eventsByType = new Map();
        const toolResultCandidates = [];
        const errorMessages = [];
        const eventSummaries = [];
        const responseSummaries = [];
        const diagnostics = () => ({
            errorMessages: ([...errorMessages]),
            stderrTail: tailText(stderrText),
            eventSummaries: (eventSummaries.slice(-10)),
            responseSummaries: (responseSummaries.slice(-10)),
        });
        const clearPending = (error) => {
            for (const pending of pendingCommands.values()) {
                clearTimeout(pending.timer);
                pending.reject(error);
            }
            pendingCommands.clear();
            for (const waiters of eventWaiters.values()) {
                for (const waiter of waiters) {
                    clearTimeout(waiter.timer);
                    waiter.reject(error);
                }
                waiters.clear();
            }
            eventWaiters.clear();
        };
        const settleReject = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(wallTimer);
            clearPending(error);
            if (!child.killed)
                child.kill('SIGTERM');
            rejectPromise(error);
        };
        const settleResolve = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(wallTimer);
            clearPending(new AutopilotPiRunError('settled', 'Pi RPC supervisor settled'));
            child.stdin.end();
            if (!child.killed)
                child.kill('SIGTERM');
            resolvePromise(result);
        };
        const wallTimer = setTimeout(() => {
            settleReject(new AutopilotPiRunError('wall-timeout', `Pi RPC wall timeout after ${String(spec.wallMs)} ms`, {
                timeoutMs: spec.wallMs,
            }, diagnostics()));
        }, spec.wallMs);
        const waitForEvent = (type, timeoutMs) => {
            const existing = eventsByType.get(type);
            if (existing !== undefined)
                return Promise.resolve(existing);
            return new Promise((resolveEvent, rejectEvent) => {
                const waiter = {
                    resolve: resolveEvent,
                    reject: rejectEvent,
                    timer: setTimeout(() => {
                        const waiters = eventWaiters.get(type);
                        if (waiters !== undefined) {
                            waiters.delete(waiter);
                            if (waiters.size === 0)
                                eventWaiters.delete(type);
                        }
                        rejectEvent(new AutopilotPiRunError('rpc-timeout', `timed out waiting for Pi RPC event ${type}`, {
                            eventType: type,
                            timeoutMs,
                        }, diagnostics()));
                    }, timeoutMs),
                };
                const current = eventWaiters.get(type);
                if (current === undefined)
                    eventWaiters.set(type, new Set([waiter]));
                else
                    current.add(waiter);
            });
        };
        const sendCommand = (type, body = {}) => {
            return new Promise((resolveCommand, rejectCommand) => {
                const id = `autopilot-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
                const command = { ...body, type, id };
                const timer = setTimeout(() => {
                    const pending = pendingCommands.get(id);
                    if (pending === undefined)
                        return;
                    pendingCommands.delete(id);
                    pending.reject(new AutopilotPiRunError('rpc-timeout', `Pi RPC command timeout: ${type}`, {
                        command: type,
                        id,
                    }, diagnostics()));
                }, RPC_COMMAND_TIMEOUT_MS);
                pendingCommands.set(id, {
                    resolve: resolveCommand,
                    reject: rejectCommand,
                    timer,
                });
                child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
                    if (error === null || error === undefined)
                        return;
                    clearTimeout(timer);
                    pendingCommands.delete(id);
                    rejectCommand(new AutopilotPiRunError('rpc-write-error', `Failed to write Pi RPC command ${type}: ${error.message}`, {
                        command: type,
                        id,
                    }, diagnostics()));
                });
            });
        };
        const handleResponse = (record) => {
            const id = typeof record['id'] === 'string' ? record['id'] : '';
            const pending = pendingCommands.get(id);
            const response = toRpcResponse(record);
            responseSummaries.push(projectResponse(response));
            if (pending === undefined)
                return;
            clearTimeout(pending.timer);
            pendingCommands.delete(id);
            if (response.success)
                pending.resolve(response);
            else
                pending.reject(new AutopilotPiRunError('rpc-command-failed', response.error ?? `Pi RPC command ${response.command ?? response.id} failed`, {
                    id: response.id,
                }, diagnostics()));
        };
        const handleEvent = (record) => {
            const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
            eventsByType.set(type, record);
            eventSummaries.push(projectEvent(record));
            if (record['isError'] === true)
                sawErrorEvent = true;
            if (typeof record['errorMessage'] === 'string') {
                sawErrorEvent = true;
                errorMessages.push(record['errorMessage']);
            }
            if (type === 'message_end' || type === 'turn_end') {
                const message = record['message'];
                if (isJsonRecord(message))
                    lastMessage = message;
                if (type === 'turn_end')
                    turnCount += 1;
            }
            const statusToolCandidate = toStatusToolResultCandidate(record);
            if (statusToolCandidate !== null)
                toolResultCandidates.push(statusToolCandidate);
            const waiters = eventWaiters.get(type);
            if (waiters !== undefined) {
                for (const waiter of waiters) {
                    clearTimeout(waiter.timer);
                    waiter.resolve(record);
                }
                waiters.clear();
                eventWaiters.delete(type);
            }
        };
        const parseLine = (line) => {
            const trimmed = line.trim();
            if (trimmed.length === 0)
                return;
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            }
            catch (error) {
                throw new AutopilotPiRunError('rpc-parse-error', `Failed to parse Pi RPC frame: ${errorMessage(error)}`, {
                    frame: trimmed.slice(0, 200),
                }, diagnostics());
            }
            if (!isJsonRecord(parsed))
                return;
            if (parsed['type'] === 'response')
                handleResponse(parsed);
            else
                handleEvent(parsed);
        };
        child.stdout.on('data', (chunk) => {
            stdoutBuffer += chunk.toString('utf8');
            while (true) {
                const newline = stdoutBuffer.indexOf('\n');
                if (newline < 0)
                    break;
                const line = stdoutBuffer.slice(0, newline);
                stdoutBuffer = stdoutBuffer.slice(newline + 1);
                try {
                    parseLine(line);
                }
                catch (error) {
                    settleReject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
        child.stderr.on('data', (chunk) => {
            stderrText = tailText(`${stderrText}${chunk.toString('utf8')}`);
        });
        child.on('error', (error) => {
            settleReject(new AutopilotPiRunError('spawn-error', error.message, {}, diagnostics()));
        });
        child.on('close', (code, signal) => {
            if (settled)
                return;
            settleReject(new AutopilotPiRunError('child-exit', `Pi child exited before completion: code=${String(code)} signal=${String(signal)}`, {
                code: code ?? -1,
                signal: signal ?? 'none',
            }, diagnostics()));
        });
        void (async () => {
            try {
                const stateResponse = await sendCommand('get_state');
                if (isJsonRecord(stateResponse.data))
                    lastState = stateResponse.data;
                await sendCommand('prompt', { message: prompt });
                await waitForEvent('agent_end', spec.wallMs);
                await sendCommand('get_session_stats').catch(() => undefined);
                const facts = deriveResultFacts(lastState, lastMessage);
                settleResolve(({
                    isError: sawErrorEvent || facts.stopReason === 'error',
                    stopReason: facts.stopReason,
                    provider: facts.provider,
                    model: facts.model,
                    api: facts.api,
                    thinkingLevel: facts.thinkingLevel,
                    numTurns: turnCount,
                    artifacts: ({
                        structuredOutput: ({
                            toolResultCandidates: ([...toolResultCandidates]),
                        }),
                        diagnostics: diagnostics(),
                    }),
                }));
            }
            catch (error) {
                settleReject(error instanceof Error ? error : new Error(String(error)));
            }
        })();
    });
}
function toRpcResponse(record) {
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    const command = typeof record['command'] === 'string' ? record['command'] : undefined;
    const error = typeof record['error'] === 'string' ? record['error'] : undefined;
    return {
        type: 'response',
        id,
        ...(command === undefined ? {} : { command }),
        success: record['success'] === true,
        ...(record['data'] === undefined ? {} : { data: record['data'] }),
        ...(error === undefined ? {} : { error }),
    };
}
function toStatusToolResultCandidate(record) {
    const type = stringField(record, 'type');
    const toolName = stringField(record, 'toolName') ?? stringField(record, 'tool_name');
    if (toolName !== AUTOPILOT_STATUS_TOOL)
        return null;
    if (type === 'tool_result') {
        return toolResultCandidateFromRecord(record, record);
    }
    if (type === 'tool_execution_end') {
        const result = jsonRecordField(record, 'result');
        return toolResultCandidateFromRecord(record, result);
    }
    return null;
}
function toolResultCandidateFromRecord(eventRecord, resultRecord) {
    const toolName = stringField(eventRecord, 'toolName');
    const toolUnderscore = stringField(eventRecord, 'tool_name');
    const toolCallId = stringField(eventRecord, 'toolCallId');
    const toolCallUnderscore = stringField(eventRecord, 'tool_call_id');
    const rawDetails = resultRecord?.['details'];
    const details = normalizeStatusToolResultDetails(rawDetails, {
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolUnderscore === undefined ? {} : { tool_name: toolUnderscore }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(toolCallUnderscore === undefined ? {} : { tool_call_id: toolCallUnderscore }),
    });
    const detailsConflict = booleanField(eventRecord, 'detailsConflict') ??
        (resultRecord === undefined ? undefined : booleanField(resultRecord, 'detailsConflict'));
    return ({
        ...(toolUnderscore === undefined ? {} : { tool_name: toolUnderscore }),
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolCallUnderscore === undefined ? {} : { tool_call_id: toolCallUnderscore }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(typeof eventRecord['isError'] === 'boolean' ? { isError: eventRecord['isError'] } : {}),
        ...(details === undefined ? {} : { details }),
        ...(detailsConflict === undefined ? {} : { detailsConflict }),
    });
}
function deriveResultFacts(state, message) {
    const stateModel = isJsonRecord(state?.['model']) ? state?.['model'] : undefined;
    const provider = stringField(message, 'provider') ?? stringField(stateModel, 'provider');
    const model = stringField(message, 'model') ?? stringField(stateModel, 'id');
    const api = stringField(message, 'api') ?? stringField(stateModel, 'api');
    const thinkingLevel = stringField(state, 'thinkingLevel');
    const stopReason = stringField(message, 'stopReason');
    return ({
        stopReason: stopReason ?? null,
        provider: provider ?? null,
        model: model ?? null,
        api: api ?? null,
        thinkingLevel: thinkingLevel ?? null,
    });
}
function normalizeStatusToolResultDetails(rawDetails, eventIdentity) {
    if (!isJsonRecord(rawDetails))
        return rawDetails;
    const toolName = stringField(rawDetails, 'tool_name') ??
        stringField(rawDetails, 'toolName') ??
        eventIdentity.tool_name ??
        eventIdentity.toolName;
    const toolCallId = stringField(rawDetails, 'tool_call_id') ??
        stringField(rawDetails, 'toolCallId') ??
        eventIdentity.tool_call_id ??
        eventIdentity.toolCallId;
    return ({
        ...(toolName === undefined ? {} : { tool_name: toolName }),
        ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
        ...rawDetails,
    });
}
function validateAutopilotEmitStatusCarrier(piResult, expectedToolCallId, expectedStatusSha256) {
    const candidates = statusToolResultCandidates(piResult);
    if (candidates.length === 0) {
        throw new Error('missing autopilot_emit_status tool-result carrier in Pi RPC artifacts');
    }
    const mismatchReasons = [];
    let matchingCarrierCount = 0;
    for (const [index, candidate] of candidates.entries()) {
        const mismatchReason = autopilotEmitStatusCandidateMismatch(candidate, expectedToolCallId, expectedStatusSha256);
        if (mismatchReason === null) {
            matchingCarrierCount += 1;
        }
        else {
            mismatchReasons.push(`candidate ${String(index + 1)}: ${mismatchReason}`);
        }
    }
    if (matchingCarrierCount === 0) {
        throw new Error('no autopilot_emit_status carrier matched accepted receipt/status evidence; ' +
            formatCarrierMismatchReasons(mismatchReasons));
    }
}
function statusToolResultCandidates(piResult) {
    return (piResult.artifacts.structuredOutput?.toolResultCandidates ?? []).filter((candidate) => (candidate.toolName ?? candidate.tool_name) === AUTOPILOT_STATUS_TOOL);
}
function autopilotEmitStatusCandidateMismatch(candidate, expectedToolCallId, expectedStatusSha256) {
    // Pi may mark a terminating tool-result frame as isError even after the
    // status tool has written valid status+receipt artifacts. The artifact/receipt
    // join below is the authority; do not reject solely on the transport flag.
    if (candidate.detailsConflict === true)
        return 'details conflict across events';
    if (!isJsonRecord(candidate.details)) {
        return 'details are missing or not a JSON object';
    }
    const details = candidate.details;
    return (detailMismatch(details, 'tool_name', AUTOPILOT_STATUS_TOOL) ??
        detailMismatch(details, 'tool_call_id', expectedToolCallId) ??
        detailMismatch(details, 'status_sha256', expectedStatusSha256) ??
        detailMismatch(details, 'terminating', true));
}
function formatCarrierMismatchReasons(reasons) {
    if (reasons.length === 0)
        return 'no candidate diagnostics available';
    const shown = reasons.slice(0, 4).join('; ');
    const suffix = reasons.length > 4 ? `; ${String(reasons.length - 4)} more candidate(s) omitted` : '';
    return boundedDiagnosticText(`${shown}${suffix}`, FAILURE_REASON_LIMIT);
}
function detailMismatch(details, field, expected) {
    const actual = details[field];
    if (actual === expected)
        return null;
    return `${field} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}
function isSuccessVerdict(status) {
    return status.verdict === 'DONE' || status.verdict === 'PASS';
}
function isBenignTerminalStatusCompletion(piResult, expectedToolCallId, expectedStatusSha256) {
    if (piResult.artifacts.diagnostics.errorMessages.length > 0)
        return false;
    if (piResult.stopReason !== null &&
        piResult.stopReason !== 'toolUse' &&
        piResult.stopReason !== 'stop') {
        return false;
    }
    try {
        validateAutopilotEmitStatusCarrier(piResult, expectedToolCallId, expectedStatusSha256);
        return true;
    }
    catch {
        return false;
    }
}
function formatPiResultFailureDiagnostics(piResult) {
    const diagnostics = piResult.artifacts.diagnostics;
    const parts = [
        `stop_reason=${formatNullable(piResult.stopReason)}`,
        `provider=${formatNullable(piResult.provider)}`,
        `model=${formatNullable(piResult.model)}`,
        `api=${formatNullable(piResult.api)}`,
        `thinking=${formatNullable(piResult.thinkingLevel)}`,
        `turns=${String(piResult.numTurns)}`,
    ];
    appendDiagnosticList(parts, 'error_messages', diagnostics.errorMessages);
    appendDiagnosticText(parts, 'stderr_tail', diagnostics.stderrTail);
    appendDiagnosticJsonList(parts, 'last_events', diagnostics.eventSummaries);
    appendDiagnosticJsonList(parts, 'last_responses', diagnostics.responseSummaries);
    return boundedDiagnosticText(parts.join('; '), FAILURE_REASON_LIMIT);
}
function formatPiRunErrorDiagnostics(error) {
    const parts = [];
    if (error.details !== undefined)
        appendDiagnosticText(parts, 'details', safeJsonString(error.details));
    if (error.rpcRunArtifacts !== undefined) {
        appendDiagnosticList(parts, 'error_messages', error.rpcRunArtifacts.errorMessages);
        appendDiagnosticText(parts, 'stderr_tail', error.rpcRunArtifacts.stderrTail);
        appendDiagnosticJsonList(parts, 'last_events', error.rpcRunArtifacts.eventSummaries);
        appendDiagnosticJsonList(parts, 'last_responses', error.rpcRunArtifacts.responseSummaries);
    }
    if (parts.length === 0)
        return '';
    return `; ${boundedDiagnosticText(parts.join('; '), FAILURE_REASON_LIMIT)}`;
}
function appendDiagnosticText(parts, label, value) {
    if (value.length === 0)
        return;
    parts.push(`${label}=${JSON.stringify(boundedDiagnosticText(value, DIAGNOSTIC_TEXT_LIMIT))}`);
}
function appendDiagnosticList(parts, label, values) {
    const bounded = values
        .filter((value) => value.length > 0)
        .slice(-3)
        .map((value) => boundedDiagnosticText(value, DIAGNOSTIC_TEXT_LIMIT));
    if (bounded.length > 0)
        parts.push(`${label}=${JSON.stringify(bounded)}`);
}
function appendDiagnosticJsonList(parts, label, values) {
    const bounded = values.slice(-5).map((value) => boundedDiagnosticText(safeJsonString(value), DIAGNOSTIC_TEXT_LIMIT));
    if (bounded.length > 0)
        parts.push(`${label}=${JSON.stringify(bounded)}`);
}
function formatNullable(value) {
    return value === null ? 'null' : JSON.stringify(boundedDiagnosticText(value, DIAGNOSTIC_TEXT_LIMIT));
}
function boundedDiagnosticText(value, limit) {
    const compact = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
    if (compact.length <= limit)
        return compact;
    return `${compact.slice(0, limit)}…<truncated>`;
}
function tailText(value) {
    if (value.length <= DIAGNOSTIC_TEXT_LIMIT)
        return value;
    return value.slice(value.length - DIAGNOSTIC_TEXT_LIMIT);
}
function safeJsonString(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
function projectEvent(record) {
    const out = { type: stringField(record, 'type') ?? 'unknown' };
    for (const field of ['isError', 'errorMessage', 'stopReason', 'toolName', 'tool_call_id', 'toolCallId']) {
        if (record[field] !== undefined)
            out[field] = record[field];
    }
    const message = record['message'];
    if (isJsonRecord(message)) {
        out['message'] = {
            provider: stringField(message, 'provider'),
            model: stringField(message, 'model'),
            api: stringField(message, 'api'),
            stopReason: stringField(message, 'stopReason'),
        };
    }
    return (out);
}
function projectResponse(response) {
    return ({
        type: response.type,
        id: response.id,
        command: response.command ?? null,
        success: response.success,
        ...(response.error === undefined ? {} : { error: response.error }),
    });
}
function isJsonRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringField(record, field) {
    if (record === undefined)
        return undefined;
    const value = record[field];
    return typeof value === 'string' ? value : undefined;
}
function booleanField(record, field) {
    const value = record[field];
    return typeof value === 'boolean' ? value : undefined;
}
function jsonRecordField(record, field) {
    const value = record[field];
    return isJsonRecord(value) ? value : undefined;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
