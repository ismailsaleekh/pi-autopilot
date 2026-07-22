import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { parseCoordinationAcquisitionGroup, parseCoordinationAuthoritativeArtifact, parseCoordinationChangeReservation, parseCoordinationChildLease, parseCoordinationEditLease, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationRunTerminalIntent, parseCoordinationSessionLease, parseCoordinationUnitAttempt, parseCoordinationWorktree, parseCoordinationWorktreeOperation, } from "./contracts.js";
import { canonicalJson } from "./canonical-json.js";
import { reconstructD65BootstrapCharter } from "./d65-bootstrap-charter.js";
import { applyD65GraphRegistrationBaseline, assertD65CoordinatorProjectionEqual, projectD65ChildLease, projectD65SessionLease, } from "./d65-coordinator-projection.js";
import { canonicalBlobText } from "./d65-graph-producer.js";
import { produceD65CompleteGraphFromAuthority } from "./d65-graph-body.js";
import { loadD65CompleteGraph } from "./d65-graph-loader.js";
import { d65SemanticGraphArtifactId, d65SemanticGraphSequenceFromArtifactId } from "./d65-graph-publication.js";
import { parseD65CompleteGraph, parseD65RunTerminalIntentV2 } from "./d65-semantic-graph.js";
import { parseD65HeartbeatAcceptanceResult, parseD65LaunchPolicy } from "./d65-launch-policy.js";
import { computeD65SemanticVersionCounts, d65SemanticEventWorkstreamRuns, isPureD65ChildHeartbeat, isPureD65SessionHeartbeat } from "./d65-semantic-version.js";
import { CoordinationRuntimeError } from "./failures.js";
import { readD65CoordinatorExport, readD65GraphAuthorityAtCommit } from "./d65-graph-runtime.js";
import { parseRunScopedLogicalFault } from "./logical-faults.js";
import { runGitQuery } from "../git-process.js";
function fail(issue, evidence = []) {
    throw new CoordinationRuntimeError('invalid-state', `semantic-graph-successor: ${issue}`, evidence);
}
function isJsonMap(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function jsonMap(value, label) {
    if (!isJsonMap(value))
        fail(`${label} must be an object`);
    return value;
}
function jsonArray(value, label) {
    if (!Array.isArray(value))
        fail(`${label} must be an array`);
    return value;
}
function text(value, field, label) {
    const entry = value[field];
    if (typeof entry !== 'string')
        fail(`${label}.${field} must be text`);
    return entry;
}
function integer(value, field, label, minimum = 0) {
    const entry = value[field];
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < minimum)
        fail(`${label}.${field} must be a safe integer >= ${String(minimum)}`);
    return entry;
}
function nullableInteger(value, field, label) {
    if (value[field] === null)
        return null;
    return integer(value, field, label, 1);
}
function parseJsonText(textValue, label) {
    let value;
    try {
        value = JSON.parse(textValue);
    }
    catch (error) {
        fail(`${label} is not JSON`, [error instanceof Error ? error.message : String(error)]);
    }
    return jsonMap(value, label);
}
function rows(exported, table) {
    return Object.freeze(jsonArray(exported[table], `coordinator export ${table}`).map((entry) => jsonMap(entry, `coordinator export ${table} row`)));
}
function payload(row, label) {
    return parseJsonText(text(row, 'payload_json', label), `${label}.payload_json`);
}
function exactlyOne(values, label) {
    const value = values[0];
    if (values.length !== 1 || value === undefined)
        fail(`${label} cardinality is not exactly one`, [`count=${String(values.length)}`]);
    return value;
}
function gitBlob(repoRoot, commit, ref, label) {
    const listing = runGitQuery({ cwd: repoRoot, descriptor: { kind: 'ls-tree-path', revision: commit, path: ref } });
    const records = new TextDecoder('utf-8', { fatal: true }).decode(listing.stdout).split('\0').filter((entry) => entry.length > 0);
    const record = records[0];
    if (records.length !== 1 || record === undefined)
        fail(`${label} must resolve to exactly one Git tree entry`, [commit, ref]);
    const tab = record.indexOf('\t');
    const metadata = tab < 0 ? [] : record.slice(0, tab).split(/\s+/u);
    const listedPath = tab < 0 ? '' : record.slice(tab + 1);
    if (metadata[0] !== '100644' || metadata[1] !== 'blob' || metadata[2] === undefined || !/^[a-f0-9]{40}$/u.test(metadata[2]) || listedPath !== ref)
        fail(`${label} must be an exact mode-100644 Git blob`, [record]);
    const shown = runGitQuery({ cwd: repoRoot, descriptor: { kind: 'show-file', revision: commit, path: ref } }).stdout;
    if (shown.byteLength > 1_048_576)
        fail(`${label} exceeds the 1 MiB graph blob bound`, [ref, `bytes=${String(shown.byteLength)}`]);
    return shown;
}
export function reconstructD65BootstrapCharterFromCoordinatorExport(exportedValue, repoId, workstreamRun) {
    const exported = jsonMap(exportedValue, 'coordinator export');
    const eventRow = exactlyOne(rows(exported, 'events').filter((row) => text(row, 'repo_id', 'bootstrap event') === repoId && integer(row, 'event_seq', 'bootstrap event', 1) === 1 && text(row, 'event_type', 'bootstrap event') === 'run-attached' && text(row, 'entity_type', 'bootstrap event') === 'run' && text(row, 'entity_id', 'bootstrap event') === workstreamRun), 'bootstrap B event');
    const key = text(eventRow, 'idempotency_key', 'bootstrap event');
    const resultRow = exactlyOne(rows(exported, 'idempotency_results').filter((row) => text(row, 'repo_id', 'bootstrap result') === repoId && text(row, 'idempotency_key', 'bootstrap result') === key), 'bootstrap B idempotency result');
    return reconstructD65BootstrapCharter({
        event: {
            schema_version: 'autopilot.coordination_event.v1', repo_id: repoId, event_seq: 1,
            event_type: 'run-attached', entity_type: 'run', entity_id: workstreamRun, idempotency_key: key,
            request_sha256: text(eventRow, 'request_sha256', 'bootstrap event'), occurred_at: text(eventRow, 'occurred_at', 'bootstrap event'),
        },
        result: {
            repo_id: repoId, idempotency_key: key, request_sha256: text(resultRow, 'request_sha256', 'bootstrap result'),
            committed_event_seq: integer(resultRow, 'committed_event_seq', 'bootstrap result', 1),
            payload: parseJsonText(text(resultRow, 'payload_json', 'bootstrap result'), 'bootstrap result payload'),
        },
    });
}
function eventResultJoins(exported, repoId, throughEventSeq) {
    const resultByKey = new Map();
    for (const row of rows(exported, 'idempotency_results')) {
        if (text(row, 'repo_id', 'idempotency result') !== repoId)
            continue;
        const key = text(row, 'idempotency_key', 'idempotency result');
        if (resultByKey.has(key))
            fail('coordinator export has duplicate idempotency result identity', [key]);
        resultByKey.set(key, row);
    }
    const joined = [];
    for (const row of rows(exported, 'events')) {
        if (text(row, 'repo_id', 'event') !== repoId)
            continue;
        const eventSeq = integer(row, 'event_seq', 'event', 1);
        if (eventSeq > throughEventSeq)
            continue;
        const key = text(row, 'idempotency_key', 'event');
        const resultRow = resultByKey.get(key);
        const result = resultRow === undefined ? null : Object.freeze({
            repo_id: text(resultRow, 'repo_id', 'idempotency result'),
            idempotency_key: key,
            request_sha256: text(resultRow, 'request_sha256', 'idempotency result'),
            committed_event_seq: integer(resultRow, 'committed_event_seq', 'idempotency result', 1),
            payload: parseJsonText(text(resultRow, 'payload_json', 'idempotency result'), 'idempotency result payload'),
        });
        joined.push(Object.freeze({
            repo_id: repoId,
            event_seq: eventSeq,
            event_type: text(row, 'event_type', 'event'),
            entity_type: text(row, 'entity_type', 'event'),
            entity_id: text(row, 'entity_id', 'event'),
            idempotency_key: key,
            request_sha256: text(row, 'request_sha256', 'event'),
            result,
        }));
    }
    joined.sort((left, right) => left.event_seq - right.event_seq);
    return Object.freeze(joined);
}
function semanticSuccessorEvent(input) {
    const suffix = input.joins.filter((row) => row.event_seq > input.priorRegistrationEventSeq);
    if (suffix.length !== input.coveredEventSeq - input.priorRegistrationEventSeq)
        fail('successor event suffix is not contiguous', [`rows=${String(suffix.length)}`, `range=${String(input.coveredEventSeq - input.priorRegistrationEventSeq)}`]);
    let semantic = null;
    for (let index = 0; index < suffix.length; index += 1) {
        const row = suffix[index];
        if (row === undefined || row.event_seq !== input.priorRegistrationEventSeq + index + 1)
            fail('successor event suffix has a gap');
        // The repository sequence is shared; a foreign run's immutable event is
        // contiguous history but is not semantic authority for this run.
        if (!d65SemanticEventWorkstreamRuns(row).includes(input.workstreamRun))
            continue;
        let pure = false;
        if (row.event_type === 'session-heartbeat')
            pure = input.sessionIds.has(row.entity_id) && isPureD65SessionHeartbeat(row);
        else if (row.event_type === 'child-heartbeat')
            pure = input.childIds.has(row.entity_id) && isPureD65ChildHeartbeat(row);
        else if (row.event_type === 'program-heartbeat-accepted') {
            if (row.result === null)
                fail('program heartbeat event lacks its immutable result');
            const accepted = parseD65HeartbeatAcceptanceResult(row.result.payload);
            pure = row.entity_type === 'program-heartbeat' && row.entity_id === input.workstreamRun && accepted.repo_id === input.repoId && accepted.workstream_run === input.workstreamRun;
        }
        if (pure) {
            if (semantic !== null)
                fail('normalized liveness appears after the semantic successor event');
            continue;
        }
        if (semantic !== null)
            fail('successor would collapse more than one semantic event', [semantic, row.event_type]);
        semantic = row.event_type;
    }
    return semantic;
}
function runFromExport(row) {
    return parseCoordinationRun({ schema_version: 'autopilot.coordination_run.v1', repo_id: text(row, 'repo_id', 'runs row'), autopilot_id: text(row, 'autopilot_id', 'runs row'), workstream: text(row, 'workstream', 'runs row'), workstream_run: text(row, 'workstream_run', 'runs row'), coordination_authority: 'coordinator-edit-leases-v1', status: text(row, 'status', 'runs row'), active_session_generation: integer(row, 'active_session_generation', 'runs row'), created_event_seq: integer(row, 'created_event_seq', 'runs row', 1), version: integer(row, 'version', 'runs row', 1) });
}
function sessionFromExport(row) {
    return parseCoordinationSessionLease({ schema_version: 'autopilot.session_lease.v2', session_lease_id: text(row, 'session_lease_id', 'session row'), repo_id: text(row, 'repo_id', 'session row'), workstream_run: text(row, 'workstream_run', 'session row'), session_id: text(row, 'session_id', 'session row'), session_generation: integer(row, 'session_generation', 'session row', 1), pid: integer(row, 'pid', 'session row', 1), boot_id: text(row, 'boot_id', 'session row'), attachment_kind: text(row, 'attachment_kind', 'session row'), lease_expires_at: text(row, 'lease_expires_at', 'session row'), status: text(row, 'status', 'session row'), attached_event_seq: integer(row, 'attached_event_seq', 'session row', 1), version: integer(row, 'version', 'session row', 1) });
}
function childFromExport(row) {
    const evidenceRef = row['terminal_evidence_ref'];
    const evidenceSha = row['terminal_evidence_sha256'];
    const terminalEvidence = evidenceRef === null && evidenceSha === null ? null : { ref: text(row, 'terminal_evidence_ref', 'child row'), sha256: text(row, 'terminal_evidence_sha256', 'child row') };
    return parseCoordinationChildLease({ schema_version: 'autopilot.child_lease.v1', child_lease_id: text(row, 'child_lease_id', 'child row'), owner: { repo_id: text(row, 'repo_id', 'child row'), autopilot_id: text(row, 'autopilot_id', 'child row'), workstream_run: text(row, 'workstream_run', 'child row'), unit_id: text(row, 'unit_id', 'child row'), attempt: integer(row, 'attempt', 'child row', 1) }, pid: integer(row, 'pid', 'child row', 1), boot_id: text(row, 'boot_id', 'child row'), lease_expires_at: text(row, 'lease_expires_at', 'child row'), status: text(row, 'status', 'child row'), terminal_evidence: terminalEvidence, version: integer(row, 'version', 'child row', 1) });
}
function faultFromExport(row) {
    return parseRunScopedLogicalFault({
        schema_version: 'autopilot.run_scoped_fault.v1',
        fault_id: text(row, 'fault_id', 'run_scoped_faults row'),
        invariant_id: text(row, 'invariant_id', 'run_scoped_faults row'),
        repo_id: text(row, 'repo_id', 'run_scoped_faults row'),
        workstream_run: text(row, 'workstream_run', 'run_scoped_faults row'),
        entity_type: text(row, 'entity_type', 'run_scoped_faults row'),
        entity_id: text(row, 'entity_id', 'run_scoped_faults row'),
        fault_code: text(row, 'fault_code', 'run_scoped_faults row'),
        detail: parseJsonText(text(row, 'detail_json', 'run_scoped_faults row'), 'run scoped fault detail'),
        status: text(row, 'status', 'run_scoped_faults row'),
        created_event_seq: integer(row, 'created_event_seq', 'run_scoped_faults row', 1),
        resolved_event_seq: nullableInteger(row, 'resolved_event_seq', 'run_scoped_faults row'),
        version: integer(row, 'version', 'run_scoped_faults row', 1),
    });
}
function coordinatorProjectionFromExport(input) {
    const scopedRows = (table) => rows(input.exported, table).filter((row) => text(row, 'repo_id', `${table} row`) === input.repoId && text(row, 'workstream_run', `${table} row`) === input.workstreamRun);
    const scopedPayloads = (table) => scopedRows(table).map((row) => payload(row, `${table} row`));
    const run = runFromExport(exactlyOne(scopedRows('runs'), 'exported run'));
    const resource = parseCoordinationRunResource(exactlyOne(scopedPayloads('run_resources'), 'exported run resource'));
    const sessionRows = scopedRows('session_leases').map(sessionFromExport);
    const childRows = scopedRows('child_leases').map(childFromExport);
    const semanticCounts = computeD65SemanticVersionCounts(input.joins.filter((row) => row.event_type === 'session-heartbeat' && sessionRows.some((session) => session.session_lease_id === row.entity_id) || row.event_type === 'child-heartbeat' && childRows.some((child) => child.child_lease_id === row.entity_id) || row.event_type === 'program-heartbeat-accepted' && row.entity_id === input.workstreamRun), input.coveredEventSeq);
    const sessions = sessionRows.map((session) => projectD65SessionLease(session, semanticCounts.sessionPureLeaseEvents.get(session.session_lease_id) ?? 0));
    const children = childRows.map((child) => projectD65ChildLease(child, semanticCounts.childPureLeaseEvents.get(child.child_lease_id) ?? 0));
    const attempts = Object.freeze(scopedPayloads('unit_attempts').map((entry) => {
        const attempt = parseCoordinationUnitAttempt(entry);
        const entityId = `attempt-${createHash('sha256').update(`${attempt.owner.repo_id}\u0000${attempt.owner.autopilot_id}\u0000${attempt.owner.workstream_run}\u0000${attempt.owner.unit_id}\u0000${String(attempt.owner.attempt)}`, 'utf8').digest('hex')}`;
        const registrations = input.joins.filter((join) => join.event_type === 'unit-attempt-registered' && join.entity_id === entityId);
        const registration = registrations[0];
        if (registrations.length > 1)
            fail('unit attempt has more than one immutable registration event', [entityId]);
        if (registration === undefined || registration.result === null)
            return Object.freeze({ attempt, consumed_probe: null });
        const resultPayload = registration.result.payload;
        const artifactId = resultPayload['consumed_probe_artifact_id'];
        if (artifactId === undefined)
            return Object.freeze({ attempt, consumed_probe: null });
        if (typeof artifactId !== 'string')
            fail('attempt registration consumption artifact id is malformed', [entityId]);
        const sha = resultPayload['consumed_probe_sha256'];
        const sequence = resultPayload['consumed_probe_sequence'];
        const provider = resultPayload['consumed_probe_provider'];
        const trigger = resultPayload['consumed_probe_trigger_continuation_sha256'];
        if (typeof sha !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(sha) || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || typeof provider !== 'string' || typeof trigger !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(trigger))
            fail('attempt registration consumption tuple is malformed', [entityId, artifactId]);
        return Object.freeze({ attempt, consumed_probe: Object.freeze({ artifact_id: artifactId, sha256: sha, probe_sequence: sequence, provider, trigger_continuation_sha256: trigger, consumption_event_seq: registration.event_seq }) });
    }));
    const faults = rows(input.exported, 'run_scoped_faults').filter((row) => text(row, 'repo_id', 'run scoped fault') === input.repoId && text(row, 'workstream_run', 'run scoped fault') === input.workstreamRun).map(faultFromExport);
    const reservations = scopedPayloads('change_reservations').map(parseCoordinationChangeReservation);
    const editLeases = scopedPayloads('edit_leases').map(parseCoordinationEditLease);
    const acquisitionGroups = scopedPayloads('acquisition_groups').map(parseCoordinationAcquisitionGroup);
    const worktrees = rows(input.exported, 'worktrees').filter((row) => text(row, 'repo_id', 'worktree row') === input.repoId && text(row, 'workstream_run', 'worktree row') === input.workstreamRun && integer(row, 'is_current_canonical', 'worktree row') === 1).map((row) => parseCoordinationWorktree(payload(row, 'worktree row')));
    const operations = scopedPayloads('worktree_operations').map(parseCoordinationWorktreeOperation);
    const terminalIntents = scopedPayloads('run_terminal_intents').map((entry) => entry['schema_version'] === 'autopilot.run_terminal_intent.v2' ? parseD65RunTerminalIntentV2(entry) : parseCoordinationRunTerminalIntent(entry));
    const currentIntents = terminalIntents.filter((intent) => intent.state === 'prepared' || intent.state === 'committed');
    if (currentIntents.length > 1)
        fail('coordinator export has more than one current terminal intent');
    const artifacts = rows(input.exported, 'authoritative_artifacts').filter((row) => text(row, 'repo_id', 'artifact row') === input.repoId && text(row, 'source_run', 'artifact row') === input.workstreamRun).map((row) => parseCoordinationAuthoritativeArtifact(payload(row, 'artifact row'))).filter((artifact) => artifact.artifact_id !== input.futureGraphArtifactId);
    return Object.freeze({ run, resource, sessions: Object.freeze(sessions), children: Object.freeze(children), attempts, faults: Object.freeze(faults), reservations: Object.freeze(reservations), edit_leases: Object.freeze(editLeases), acquisition_groups: Object.freeze(acquisitionGroups), worktrees: Object.freeze(worktrees), operations: Object.freeze(operations), terminal_intents: Object.freeze(terminalIntents), current_terminal_intent_id: currentIntents[0]?.terminal_intent_id ?? null, authoritative_artifacts: Object.freeze(artifacts), covered_event_seq: input.coveredEventSeq, run_version: run.version });
}
/**
 * Prepare the exact first complete graph (sequence 2) from real coordinator/Git
 * authority. Admission is fail-closed: the run must have the accepted bootstrap
 * artifact, exactly one accepted signed launch policy binding that bootstrap,
 * the initial governing program-heartbeat head, and NO accepted complete graph.
 * The returned builder discovers the complete body independently from G through
 * `produceD65CompleteGraphFromAuthority`; nothing is copied from parent claims.
 */
export async function prepareD65FirstCompleteGraphPublication(input) {
    const exported = await readD65CoordinatorExport(input.client, input.session);
    const repository = exactlyOne(rows(exported, 'repositories').filter((row) => text(row, 'repo_id', 'repository row') === input.session.repo_id), 'exported repository');
    const coveredEventSeq = integer(repository, 'event_seq', 'repository row', 1);
    const artifacts = rows(exported, 'authoritative_artifacts').filter((row) => text(row, 'repo_id', 'artifact row') === input.session.repo_id && text(row, 'source_run', 'artifact row') === input.session.workstream_run).map((row) => parseCoordinationAuthoritativeArtifact(payload(row, 'artifact row')));
    if (artifacts.some((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1'))
        fail('first complete graph preparation requires that no complete graph is already accepted');
    const bootstrapArtifact = exactlyOne(artifacts.filter((artifact) => artifact.artifact_id === `semantic-graph-bootstrap:${input.session.workstream_run}` && artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1'), 'accepted bootstrap artifact');
    const policyArtifact = exactlyOne(artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1'), 'accepted launch policy artifact');
    const charter = reconstructD65BootstrapCharterFromCoordinatorExport(exported, input.session.repo_id, input.session.workstream_run);
    const mainWorktreePath = charter.run_resource.main_worktree_path;
    const policy = parseD65LaunchPolicy((() => {
        const bytes = gitBlob(mainWorktreePath, policyArtifact.git_commit, policyArtifact.evidence.ref, 'accepted launch policy');
        if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== policyArtifact.evidence.sha256)
            fail('accepted launch policy bytes diverge from their artifact digest');
        try {
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        catch (error) {
            fail('accepted launch policy is not UTF-8 JSON', [error instanceof Error ? error.message : String(error)]);
        }
    })());
    if (policy.repo_id !== input.session.repo_id || policy.workstream_run !== input.session.workstream_run)
        fail('accepted launch policy identity differs from the preparing run');
    if (policy.bootstrap_graph_sha256 !== bootstrapArtifact.evidence.sha256 || policy.bootstrap_receipt_event_seq !== bootstrapArtifact.registered_event_seq)
        fail('accepted launch policy does not bind the exact accepted bootstrap digest/receipt');
    const heads = rows(exported, 'events').filter((row) => text(row, 'repo_id', 'heartbeat event') === input.session.repo_id && text(row, 'event_type', 'heartbeat event') === 'program-heartbeat-accepted' && text(row, 'entity_id', 'heartbeat event') === input.session.workstream_run);
    if (heads.length === 0)
        fail('first complete graph preparation requires the initial governing program heartbeat acceptance');
    const headEvent = heads.reduce((left, right) => integer(left, 'event_seq', 'heartbeat event', 1) >= integer(right, 'event_seq', 'heartbeat event', 1) ? left : right);
    const headResult = exactlyOne(rows(exported, 'idempotency_results').filter((row) => text(row, 'repo_id', 'heartbeat result') === input.session.repo_id && text(row, 'idempotency_key', 'heartbeat result') === text(headEvent, 'idempotency_key', 'heartbeat event')), 'heartbeat acceptance result');
    const head = parseD65HeartbeatAcceptanceResult(parseJsonText(text(headResult, 'payload_json', 'heartbeat result'), 'heartbeat acceptance payload'));
    if (head.acceptance_kind !== 'governing' || head.sequence !== 1)
        fail('first complete graph preparation requires the sequence-1 governing heartbeat head', [String(head.sequence), head.acceptance_kind]);
    const joins = eventResultJoins(exported, input.session.repo_id, coveredEventSeq);
    const futureArtifactId = d65SemanticGraphArtifactId(2);
    const projection = coordinatorProjectionFromExport({ exported, repoId: input.session.repo_id, workstreamRun: input.session.workstream_run, coveredEventSeq, futureGraphArtifactId: futureArtifactId, joins });
    if (projection.resource.main_worktree_path !== mainWorktreePath)
        fail('exported run resource differs from the immutable bootstrap charter resource');
    const runtimePrefix = relative(projection.resource.main_worktree_path, projection.resource.runtime_root).replace(/\\/gu, '/');
    if (runtimePrefix.length === 0 || runtimePrefix === '..' || runtimePrefix.startsWith('../') || isAbsolute(runtimePrefix))
        fail('run runtime root is not an exact descendant of main worktree', [projection.resource.main_worktree_path, projection.resource.runtime_root]);
    const priorGraphSha256 = bootstrapArtifact.evidence.sha256;
    const priorRegistrationEventSeq = bootstrapArtifact.registered_event_seq;
    return Object.freeze({
        programId: policy.program_id,
        repoId: input.session.repo_id,
        autopilotId: projection.run.autopilot_id,
        workstream: projection.run.workstream,
        workstreamRun: input.session.workstream_run,
        mainWorktreePath,
        runtimePrefix,
        authorityRef: `refs/heads/${projection.resource.branch}`,
        graphSequence: 2,
        coveredEventSeq,
        priorGraphSha256,
        priorRegistrationEventSeq,
        policyCommit: policyArtifact.git_commit,
        buildGraph(authority) {
            return produceD65CompleteGraphFromAuthority({
                header: {
                    program_id: policy.program_id,
                    repo_id: input.session.repo_id,
                    autopilot_id: projection.run.autopilot_id,
                    workstream: projection.run.workstream,
                    workstream_run: input.session.workstream_run,
                    graph_sequence: 2,
                    prior_graph_sha256: priorGraphSha256,
                    prior_event_seq: priorRegistrationEventSeq,
                    covered_authority_commit: authority.commit,
                    covered_authority_tree: authority.tree,
                    covered_event_seq: coveredEventSeq,
                    created_at: input.createdAt,
                    bootstrap_charter: { repository: charter.repository, run: charter.run, run_resource: charter.run_resource, mailbox_cursor: charter.mailbox_cursor, bootstrap_graph: charter.bootstrap_graph, bootstrap_artifact: charter.bootstrap_artifact, trust_anchor: charter.trust_anchor, attach_event: charter.attach_event, attach_result: charter.attach_result },
                },
                readGitAtG: readD65GraphAuthorityAtCommit(mainWorktreePath, authority.commit),
                acceptedArtifacts: projection.authoritative_artifacts,
                coordinatorProjection: projection,
            });
        },
    });
}
/**
 * Prepare the only safe generic successor when Git authority is byte-stable:
 * reuse every accepted core/authority/package projection from N, rebuild the
 * complete coordinator projection at E, and require exactly one semantic event
 * after R. The caller must publish G with an empty authority path manifest, so
 * G's tree remains exactly the current accepted H tree.
 */
export async function prepareD65CoordinatorOnlySuccessor(input) {
    const exported = await readD65CoordinatorExport(input.client, input.session);
    const repository = exactlyOne(rows(exported, 'repositories').filter((row) => text(row, 'repo_id', 'repository row') === input.session.repo_id), 'exported repository');
    const coveredEventSeq = integer(repository, 'event_seq', 'repository row', 1);
    const artifacts = rows(exported, 'authoritative_artifacts').filter((row) => text(row, 'repo_id', 'artifact row') === input.session.repo_id && text(row, 'source_run', 'artifact row') === input.session.workstream_run).map((row) => parseCoordinationAuthoritativeArtifact(payload(row, 'artifact row')));
    const graphArtifacts = artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1').map((artifact) => ({ artifact, sequence: d65SemanticGraphSequenceFromArtifactId(artifact.artifact_id) })).sort((left, right) => left.sequence - right.sequence);
    for (let index = 0; index < graphArtifacts.length; index += 1)
        if (graphArtifacts[index]?.sequence !== index + 2)
            fail('accepted complete graph artifact sequence has a gap, duplicate, or rollback', graphArtifacts.map((entry) => String(entry.sequence)));
    const priorEntry = graphArtifacts.at(-1);
    if (priorEntry === undefined)
        fail('coordinator export has no accepted complete graph');
    const priorArtifact = priorEntry.artifact;
    if (priorArtifact.source_type !== 'task' || priorArtifact.source_scope !== 'run-main' || priorArtifact.version !== 1)
        fail('accepted prior graph artifact scope/version is not exact', [priorArtifact.artifact_id]);
    // Git-stable successors use the exact prior accepted H as pre-G base. A
    // Git-changing successor (package-accepted unit merge / authority-artifact
    // commit already covered through E) uses the exact current main-authority tip
    // reached from that H; ancestry is checked below once the run-main repository
    // is known, and the store's registration-time authority-movement verifier
    // proves the exact per-commit event/evidence pairing.
    const gitStableSuccessor = input.authorityBaseCommit === priorArtifact.git_commit;
    const futureArtifactId = d65SemanticGraphArtifactId(priorEntry.sequence + 1);
    if (artifacts.some((artifact) => artifact.artifact_id === futureArtifactId))
        fail('future graph artifact identity is already occupied', [futureArtifactId]);
    const joins = eventResultJoins(exported, input.session.repo_id, coveredEventSeq);
    const priorRegistration = exactlyOne(joins.filter((row) => row.event_seq === priorArtifact.registered_event_seq && row.event_type === 'authoritative-artifact-registered' && row.entity_type === 'authoritative-artifact' && row.entity_id === priorArtifact.artifact_id), 'prior graph registration event');
    if (priorRegistration.result === null)
        fail('prior graph registration event lacks its immutable result');
    const resultArtifact = parseCoordinationAuthoritativeArtifact(priorRegistration.result.payload['authoritative_artifact']);
    if (Object.keys(priorRegistration.result.payload).sort().join(',') !== 'authoritative_artifact,entity_id,entity_type,event_type' || priorRegistration.result.payload['event_type'] !== 'authoritative-artifact-registered' || priorRegistration.result.payload['entity_type'] !== 'authoritative-artifact' || priorRegistration.result.payload['entity_id'] !== priorArtifact.artifact_id || canonicalJson(resultArtifact) !== canonicalJson(priorArtifact))
        fail('prior graph registration event/result/artifact tuple is not exact');
    const projection = coordinatorProjectionFromExport({ exported, repoId: input.session.repo_id, workstreamRun: input.session.workstream_run, coveredEventSeq, futureGraphArtifactId: futureArtifactId, joins });
    const repoRoot = projection.resource.main_worktree_path;
    const priorRootBytes = gitBlob(repoRoot, priorArtifact.git_commit, priorArtifact.evidence.ref, 'accepted prior graph root');
    const priorDigest = `sha256:${createHash('sha256').update(priorRootBytes).digest('hex')}`;
    if (priorDigest !== priorArtifact.evidence.sha256)
        fail('accepted prior graph root digest differs from its artifact row');
    let parsedRoot;
    try {
        parsedRoot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(priorRootBytes));
    }
    catch (error) {
        fail('accepted prior graph root is not UTF-8 JSON', [error instanceof Error ? error.message : String(error)]);
    }
    const priorGraph = parseD65CompleteGraph(parsedRoot);
    if (new TextDecoder().decode(priorRootBytes) !== canonicalBlobText(priorGraph))
        fail('accepted prior graph root is not canonical JSON plus one LF');
    if (priorGraph.graph_sequence !== priorEntry.sequence || futureArtifactId !== d65SemanticGraphArtifactId(priorGraph.graph_sequence + 1) || priorArtifact.artifact_id !== d65SemanticGraphArtifactId(priorGraph.graph_sequence) || priorArtifact.registered_event_seq !== priorGraph.covered_event_seq + 1)
        fail('accepted prior graph tuple is internally inconsistent');
    if (priorGraph.repo_id !== input.session.repo_id || priorGraph.workstream_run !== input.session.workstream_run || projection.run.autopilot_id !== priorGraph.autopilot_id || projection.run.workstream !== priorGraph.workstream)
        fail('accepted prior graph identity differs from current coordinator authority');
    const semanticEventType = semanticSuccessorEvent({ joins, priorRegistrationEventSeq: priorArtifact.registered_event_seq, coveredEventSeq, repoId: input.session.repo_id, workstreamRun: input.session.workstream_run, sessionIds: new Set(projection.sessions.map((row) => row.session_lease_id)), childIds: new Set(projection.children.map((row) => row.child_lease_id)) });
    const loaded = loadD65CompleteGraph(priorGraph, (ref) => gitBlob(repoRoot, priorArtifact.git_commit, ref, 'accepted prior graph shard'));
    if (semanticEventType === null) {
        // A Git movement without a covered semantic event is an unexplained
        // product/source change: no-event N+1 is forbidden and the moved tip can
        // never be adopted as already-current authority.
        if (!gitStableSuccessor)
            fail('run-main Git authority moved beyond the prior accepted H without a covered semantic event', [input.authorityBaseCommit, priorArtifact.git_commit]);
        const baseline = applyD65GraphRegistrationBaseline({ prior: loaded.coordinatorProjection, artifact: priorArtifact });
        assertD65CoordinatorProjectionEqual(baseline, Object.freeze({ ...projection, covered_event_seq: priorArtifact.registered_event_seq }), canonicalJson);
        return Object.freeze({ state: 'already-current', programId: priorGraph.program_id, repoId: priorGraph.repo_id, autopilotId: priorGraph.autopilot_id, workstreamRun: priorGraph.workstream_run, mainWorktreePath: projection.resource.main_worktree_path, authorityRef: `refs/heads/${projection.resource.branch}`, graphSequence: priorGraph.graph_sequence, coveredEventSeq, priorGraphSha256: priorDigest, priorPublicationCommit: priorArtifact.git_commit, priorRegistrationEventSeq: priorArtifact.registered_event_seq, semanticEventType: null });
    }
    const runtimePrefix = relative(projection.resource.main_worktree_path, projection.resource.runtime_root).replace(/\\/gu, '/');
    if (runtimePrefix.length === 0 || runtimePrefix === '..' || runtimePrefix.startsWith('../') || isAbsolute(runtimePrefix))
        fail('run runtime root is not an exact descendant of main worktree', [projection.resource.main_worktree_path, projection.resource.runtime_root]);
    void runtimePrefix;
    if (!gitStableSuccessor) {
        const ancestry = runGitQuery({ cwd: repoRoot, descriptor: { kind: 'is-ancestor', ancestor: priorArtifact.git_commit, descendant: input.authorityBaseCommit } });
        if (ancestry.negative)
            fail('successor authority base does not descend from the prior accepted publication H', [input.authorityBaseCommit, priorArtifact.git_commit]);
    }
    return Object.freeze({
        state: 'publication-required',
        programId: priorGraph.program_id,
        repoId: priorGraph.repo_id,
        autopilotId: priorGraph.autopilot_id,
        workstreamRun: priorGraph.workstream_run,
        mainWorktreePath: projection.resource.main_worktree_path,
        authorityRef: `refs/heads/${projection.resource.branch}`,
        graphSequence: priorGraph.graph_sequence + 1,
        coveredEventSeq,
        priorGraphSha256: priorDigest,
        priorPublicationCommit: priorArtifact.git_commit,
        priorRegistrationEventSeq: priorArtifact.registered_event_seq,
        semanticEventType,
        buildGraph(authority) {
            if (gitStableSuccessor && authority.tree !== input.authorityBaseTree)
                fail('coordinator-only successor G changed Git authority despite an empty path manifest', [authority.tree, input.authorityBaseTree]);
            return produceD65CompleteGraphFromAuthority({
                header: {
                    program_id: priorGraph.program_id,
                    repo_id: priorGraph.repo_id,
                    autopilot_id: priorGraph.autopilot_id,
                    workstream: priorGraph.workstream,
                    workstream_run: priorGraph.workstream_run,
                    graph_sequence: priorGraph.graph_sequence + 1,
                    prior_graph_sha256: priorDigest,
                    prior_event_seq: priorArtifact.registered_event_seq,
                    covered_authority_commit: authority.commit,
                    covered_authority_tree: authority.tree,
                    covered_event_seq: coveredEventSeq,
                    created_at: input.createdAt,
                    bootstrap_charter: priorGraph.bootstrap_charter,
                },
                readGitAtG: readD65GraphAuthorityAtCommit(repoRoot, authority.commit),
                acceptedArtifacts: projection.authoritative_artifacts,
                coordinatorProjection: projection,
            });
        },
    });
}
