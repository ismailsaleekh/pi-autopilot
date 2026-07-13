import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CoordinatorClient } from "./client.js";
import { parseCoordinationReconciliationEvidence, parseCoordinationRun } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { readCoordinatorSessionContext } from "./supervisor.js";
import { coordinatorRuntimePaths } from "./runtime-paths.js";
import { parseUnitAttemptTarget, validateReconciliationEvidenceDocument } from "./terminal-evidence.js";
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from "../names.js";
function record(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not an object`);
    return value;
}
function stringArray(value, label) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not a string array`);
    return Object.freeze([...value]);
}
export function parseCoordinationReconciliationSummary(value) {
    const parsed = record(value, 'coordination reconciliation summary');
    const fields = ['notification_ids', 'offered_group_ids', 'released_lease_ids', 'released_request_ids'];
    const unknown = Object.keys(parsed).filter((field) => !fields.includes(field));
    if (unknown.length > 0 || fields.some((field) => !(field in parsed)))
        throw new CoordinationRuntimeError('schema-mismatch', 'coordination reconciliation summary fields are incompatible', unknown);
    return {
        released_lease_ids: stringArray(parsed['released_lease_ids'], 'released_lease_ids'),
        released_request_ids: stringArray(parsed['released_request_ids'], 'released_request_ids'),
        notification_ids: stringArray(parsed['notification_ids'], 'notification_ids'),
        offered_group_ids: stringArray(parsed['offered_group_ids'], 'offered_group_ids'),
    };
}
function committedSequence(response) {
    if (response.committed_event_seq === null)
        throw new CoordinationRuntimeError('invalid-state', 'coordinator reconciliation mutation omitted committed event sequence');
    return response.committed_event_seq;
}
export class RunReconciliationClient {
    #client;
    #session;
    constructor(client, session) {
        this.#client = client;
        this.#session = session;
    }
    static async fromEnvironment(env = process.env) {
        const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        if (contextPath === undefined || contextPath.trim().length === 0)
            throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for owned-run reconciliation`);
        const session = await readCoordinatorSessionContext(contextPath);
        return new RunReconciliationClient(new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }), session);
    }
    get session() {
        return this.#session;
    }
    async reconcile(reason) {
        const response = await this.#client.mutate('reconcile-run', this.#identity(`reconcile-run:${this.#session.workstream_run}:${randomUUID()}`), {
            reason,
            ...this.#sessionProof(),
        });
        return { reconciliation: parseCoordinationReconciliationSummary(response.payload['reconciliation']), committedEventSeq: committedSequence(response) };
    }
    async recordReleaseEvidence(input) {
        const evidenceIdentity = createHash('sha256').update(`${this.#session.repo_id}\0${this.#session.workstream_run}\0${input.source}\0${input.targetId}\0${input.evidenceRef}\0${input.evidenceSha256}`, 'utf8').digest('hex');
        const idempotencyKey = `record-release-evidence:${evidenceIdentity}`;
        const payload = {
            source: input.source,
            target_id: input.targetId,
            evidence_ref: input.evidenceRef,
            evidence_sha256: input.evidenceSha256,
            ...this.#sessionProof(),
        };
        let response;
        try {
            response = await this.#client.mutate('record-release-evidence', this.#identity(idempotencyKey), payload);
        }
        catch (error) {
            if (!(error instanceof CoordinationRuntimeError && error.code === 'stale-version'))
                throw error;
            const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
            const values = status.payload['runs'];
            if (!Array.isArray(values) || values.length !== 1 || values[0] === undefined)
                throw new CoordinationRuntimeError('invalid-state', 'stale reconciliation retry could not recover one exact durable run');
            const currentRun = parseCoordinationRun(values[0]);
            if (currentRun.active_session_generation !== this.#session.session_generation)
                throw new CoordinationRuntimeError('fenced-session', 'stale reconciliation retry observed a replacement session generation');
            this.#session = { ...this.#session, run_version: currentRun.version };
            // One bounded retry uses the identical semantic idempotency key and exact
            // authenticated session after refreshing only durable run version.
            response = await this.#client.mutate('record-release-evidence', this.#identity(idempotencyKey), payload);
        }
        const run = parseCoordinationRun(response.payload['run']);
        this.#session = { ...this.#session, run_version: run.version };
        return {
            evidence: parseCoordinationReconciliationEvidence(response.payload['reconciliation_evidence']),
            reconciliation: parseCoordinationReconciliationSummary(response.payload['reconciliation']),
        };
    }
    #identity(idempotencyKey) {
        return {
            repoId: this.#session.repo_id,
            workstreamRun: this.#session.workstream_run,
            sessionId: this.#session.session_id,
            fencingGeneration: this.#session.session_generation,
            expectedVersion: this.#session.run_version,
            idempotencyKey,
        };
    }
    #sessionProof() {
        return { session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token };
    }
}
function parsePendingReconciliationIntent(value) {
    const parsed = record(value, 'pending reconciliation intent');
    const fields = ['autopilot_id', 'evidence_path', 'evidence_ref', 'evidence_sha256', 'repo_id', 'schema_version', 'source', 'target_id', 'workstream_run'];
    const unknownFields = Object.keys(parsed).filter((field) => !fields.includes(field));
    if (unknownFields.length > 0 || fields.some((field) => !(field in parsed)))
        throw new CoordinationRuntimeError('schema-mismatch', 'pending reconciliation intent fields are incompatible', unknownFields);
    const requiredString = (field) => {
        const entry = parsed[field];
        if (typeof entry !== 'string' || entry.length === 0 || entry.length > 2048)
            throw new CoordinationRuntimeError('invalid-state', `pending reconciliation intent ${field} is invalid`);
        return entry;
    };
    const sourceValue = requiredString('source');
    if (sourceValue !== 'unit-merge' && sourceValue !== 'attempt-reset' && sourceValue !== 'quarantine-capture' && sourceValue !== 'run-close' && sourceValue !== 'run-abort')
        throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent source is invalid');
    const digest = requiredString('evidence_sha256');
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
        throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent digest is invalid');
    if (requiredString('schema_version') !== 'autopilot.reconciliation_intent.v1')
        throw new CoordinationRuntimeError('schema-mismatch', 'pending reconciliation intent schema is incompatible');
    const evidencePath = requiredString('evidence_path');
    if (!isAbsolute(evidencePath))
        throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent evidence path must be absolute');
    return {
        schema_version: 'autopilot.reconciliation_intent.v1',
        repo_id: requiredString('repo_id'),
        autopilot_id: requiredString('autopilot_id'),
        workstream_run: requiredString('workstream_run'),
        source: sourceValue,
        target_id: requiredString('target_id'),
        evidence_path: evidencePath,
        evidence_ref: requiredString('evidence_ref'),
        evidence_sha256: digest,
    };
}
function pendingIntentRoot(active) {
    return join(active.runtime_root, 'coordination-reconciliation', 'pending');
}
function pendingIntentPath(active, intent) {
    const id = createHash('sha256').update(`${active.repo_key}\0${active.workstream_run}\0${intent.source}\0${intent.target_id}\0${intent.evidence_ref}\0${intent.evidence_sha256}`, 'utf8').digest('hex');
    return join(pendingIntentRoot(active), `${id}.json`);
}
function samePendingIntent(left, right) {
    return left.schema_version === right.schema_version && left.repo_id === right.repo_id && left.autopilot_id === right.autopilot_id && left.workstream_run === right.workstream_run && left.source === right.source && left.target_id === right.target_id && left.evidence_path === right.evidence_path && left.evidence_ref === right.evidence_ref && left.evidence_sha256 === right.evidence_sha256;
}
async function existingPendingIntent(path) {
    try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        return parsePendingReconciliationIntent(value);
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return null;
        if (error instanceof CoordinationRuntimeError)
            throw error;
        throw new CoordinationRuntimeError('invalid-state', 'existing pending reconciliation intent is unreadable', [path, error instanceof Error ? error.message : String(error)]);
    }
}
async function writePendingIntent(path, intent) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const existing = await existingPendingIntent(path);
    if (existing !== null) {
        if (!samePendingIntent(existing, intent))
            throw new CoordinationRuntimeError('idempotency-conflict', 'pending reconciliation intent identity was reused with different evidence', [path]);
        return;
    }
    const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
        await rename(temporary, path);
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
            throw error;
        await rm(temporary, { force: true });
        const raced = await existingPendingIntent(path);
        if (raced === null || !samePendingIntent(raced, intent))
            throw new CoordinationRuntimeError('idempotency-conflict', 'concurrent pending reconciliation intent differs from the requested evidence', [path]);
    }
}
async function durableCoordinatorRunExists(active, env) {
    const stateRoot = dirname(dirname(resolve(active.worktree_root)));
    const expectedWorktreeRoot = resolve(stateRoot, 'worktrees', active.repo_key);
    if (expectedWorktreeRoot !== resolve(active.worktree_root))
        throw new CoordinationRuntimeError('invalid-state', 'active worktree root is not under the package-owned state root');
    const coordinatorEnv = { ...env, AUTOPILOT_STATE_ROOT: stateRoot };
    const paths = coordinatorRuntimePaths(coordinatorEnv);
    if (!existsSync(paths.databasePath))
        return false;
    const status = await new CoordinatorClient({ env: coordinatorEnv }).query('status', active.repo_key, active.workstream_run);
    const runs = status.payload['runs'];
    if (!Array.isArray(runs))
        throw new CoordinationRuntimeError('invalid-state', 'coordinator status omitted durable runs');
    if (runs.length > 1)
        throw new CoordinationRuntimeError('store-corrupt', 'coordinator returned duplicate durable runs');
    return runs.length === 1;
}
export async function recordCoordinatorReleaseEvidenceFromFile(input) {
    const env = input.env ?? process.env;
    if (!isAbsolute(input.evidencePath))
        throw new CoordinationRuntimeError('invalid-request', 'reconciliation evidence path must be absolute');
    const evidenceRef = relative(input.active.main_worktree_path, input.evidencePath).split(sep).join('/');
    if (evidenceRef.length === 0 || evidenceRef === '..' || evidenceRef.startsWith('../') || isAbsolute(evidenceRef))
        throw new CoordinationRuntimeError('unauthorized-client', 'reconciliation evidence is outside the run-owned main worktree');
    const bytes = await readFile(input.evidencePath);
    const unitTarget = input.source === 'unit-merge' || input.source === 'attempt-reset' || input.source === 'quarantine-capture' ? parseUnitAttemptTarget(input.targetId) : null;
    validateReconciliationEvidenceDocument(bytes, {
        repoKey: input.active.repo_key,
        autopilotId: input.active.autopilot_id,
        workstream: input.active.workstream,
        workstreamRun: input.active.workstream_run,
        source: input.source,
        targetId: input.targetId,
        unitId: unitTarget?.unitId ?? null,
        attempt: unitTarget?.attempt ?? null,
    });
    const evidenceSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const intent = {
        schema_version: 'autopilot.reconciliation_intent.v1',
        repo_id: input.active.repo_key,
        autopilot_id: input.active.autopilot_id,
        workstream_run: input.active.workstream_run,
        source: input.source,
        target_id: input.targetId,
        evidence_path: input.evidencePath,
        evidence_ref: evidenceRef,
        evidence_sha256: evidenceSha256,
    };
    const intentPath = pendingIntentPath(input.active, intent);
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined || contextPath.trim().length === 0) {
        if (!(await durableCoordinatorRunExists(input.active, env)))
            return null;
        await writePendingIntent(intentPath, intent);
        throw new CoordinationRuntimeError('unauthorized-client', 'durable lifecycle evidence was preserved, but reconciliation requires a current attached session', [intentPath]);
    }
    const client = await RunReconciliationClient.fromEnvironment(env);
    const session = client.session;
    if (session.repo_id !== input.active.repo_key || session.autopilot_id !== input.active.autopilot_id || session.workstream_run !== input.active.workstream_run)
        throw new CoordinationRuntimeError('unauthorized-client', 'reconciliation evidence does not belong to the attached durable run');
    await writePendingIntent(intentPath, intent);
    const result = await client.recordReleaseEvidence({ source: input.source, targetId: input.targetId, evidenceRef, evidenceSha256 });
    await rm(intentPath);
    return result;
}
export async function replayPendingCoordinatorReconciliation(input) {
    const root = pendingIntentRoot(input.active);
    let names;
    try {
        names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return Object.freeze([]);
        throw error;
    }
    const results = [];
    for (const name of names) {
        const path = join(root, name);
        let value;
        try {
            value = JSON.parse(await readFile(path, 'utf8'));
        }
        catch (error) {
            throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent is unreadable', [path, error instanceof Error ? error.message : String(error)]);
        }
        const intent = parsePendingReconciliationIntent(value);
        if (intent.repo_id !== input.active.repo_key || intent.autopilot_id !== input.active.autopilot_id || intent.workstream_run !== input.active.workstream_run)
            throw new CoordinationRuntimeError('unauthorized-client', 'pending reconciliation intent belongs to a different durable run', [path]);
        const expectedPath = pendingIntentPath(input.active, intent);
        if (expectedPath !== path)
            throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent filename does not match its immutable identity', [path, expectedPath]);
        const currentEvidenceRef = relative(input.active.main_worktree_path, intent.evidence_path).split(sep).join('/');
        if (currentEvidenceRef !== intent.evidence_ref)
            throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation evidence path no longer matches its accepted run-owned ref', [path]);
        const currentBytes = await readFile(intent.evidence_path);
        const currentSha = `sha256:${createHash('sha256').update(currentBytes).digest('hex')}`;
        if (currentSha !== intent.evidence_sha256)
            throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation evidence changed after the durable intent was written', [path, `expected=${intent.evidence_sha256}`, `actual=${currentSha}`]);
        const result = await recordCoordinatorReleaseEvidenceFromFile({
            active: input.active,
            source: intent.source,
            targetId: intent.target_id,
            evidencePath: intent.evidence_path,
            ...(input.env === undefined ? {} : { env: input.env }),
        });
        if (result === null)
            throw new CoordinationRuntimeError('unauthorized-client', 'pending reconciliation replay requires an attached coordinator session');
        results.push(result);
    }
    return Object.freeze(results);
}
