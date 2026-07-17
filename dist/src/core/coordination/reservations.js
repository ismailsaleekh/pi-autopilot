import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CoordinatorClient } from "./client.js";
import { coordinationPathsOverlap, parseCoordinationChangeReservation, parseCoordinationEditLease, parseCoordinationIntegrationConflict, parseCoordinationReservationObligation, parseCoordinationRun, parseCoordinationRunTerminalIntent } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { coordinatorRuntimePaths } from "./runtime-paths.js";
import { readCoordinatorSessionContext, writeCoordinatorSessionContext } from "./supervisor.js";
import { parseAutopilotUnitMerge } from "../unit-merge.js";
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from "../names.js";
import { gitHead, writeJsonAtomic } from "../parallel-runtime.js";
import { gitQueryNulStrings, runGitMutation, runGitQuery } from "../git-process.js";
import { executeOwnedWorktreeSaga, inspectOwnedWorktreeSpecPostcondition, WorktreeSagaCompensatedError } from "./worktree-saga.js";
import { classifyCoordinationIntegrationConflict } from "./integration-conflicts.js";
import { recordValidationStalenessForReservationIntegration, reservationValidationStalenessPath } from "../validation-staleness.js";
function parseArray(value, label, parser) {
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not an array`);
    return Object.freeze(value.map(parser));
}
function stateRootForActive(active) {
    const stateRoot = dirname(dirname(resolve(active.worktree_root)));
    if (resolve(stateRoot, 'worktrees', active.repo_key) !== resolve(active.worktree_root))
        throw new CoordinationRuntimeError('invalid-state', 'active worktree root is not under its package-owned state root');
    return stateRoot;
}
export class ReservationCoordinationClient {
    #client;
    #session;
    #contextPath;
    constructor(client, session, contextPath = null) {
        this.#client = client;
        this.#session = session;
        this.#contextPath = contextPath;
    }
    get session() { return this.#session; }
    static async fromEnvironment(env = process.env) {
        const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        if (contextPath === undefined || contextPath.trim().length === 0)
            throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for reservation coordination`);
        const session = await readCoordinatorSessionContext(contextPath);
        return new ReservationCoordinationClient(new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }), session, contextPath);
    }
    async view() {
        const response = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
        return parseReservationCoordinationView(response.payload);
    }
    async prepareRunTerminal(outcome) {
        const terminalIntentId = `terminal-${this.#session.workstream_run}-${randomUUID()}`;
        const response = await this.#client.mutate('prepare-run-terminal', {
            repoId: this.#session.repo_id,
            workstreamRun: this.#session.workstream_run,
            sessionId: this.#session.session_id,
            fencingGeneration: this.#session.session_generation,
            expectedVersion: this.#session.run_version,
            idempotencyKey: `prepare-run-terminal:${terminalIntentId}`,
        }, { outcome, terminal_intent_id: terminalIntentId, session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token });
        const run = parseCoordinationRun(response.payload['run']);
        this.#session = { ...this.#session, run_version: run.version };
        if (this.#contextPath !== null)
            await writeCoordinatorSessionContext(this.#contextPath, this.#session);
        return parseCoordinationRunTerminalIntent(response.payload['run_terminal_intent']);
    }
    async cancelRunTerminal(intent, reason) {
        const response = await this.#client.mutate('cancel-run-terminal', {
            repoId: this.#session.repo_id,
            workstreamRun: this.#session.workstream_run,
            sessionId: this.#session.session_id,
            fencingGeneration: this.#session.session_generation,
            expectedVersion: intent.version,
            idempotencyKey: `cancel-run-terminal:${intent.terminal_intent_id}`,
        }, { reason, terminal_intent_id: intent.terminal_intent_id, session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token });
        const run = parseCoordinationRun(response.payload['run']);
        this.#session = { ...this.#session, run_version: run.version };
        if (this.#contextPath !== null)
            await writeCoordinatorSessionContext(this.#contextPath, this.#session);
        return parseCoordinationRunTerminalIntent(response.payload['run_terminal_intent']);
    }
    async resolve(input) {
        const obligation = parseCoordinationReservationObligation(input.obligation);
        if (obligation.repo_id !== this.#session.repo_id || obligation.workstream_run !== this.#session.workstream_run)
            throw new CoordinationRuntimeError('unauthorized-client', 'reservation obligation does not belong to the attached run');
        const response = await this.#client.mutate('resolve-reservation-obligation', {
            repoId: this.#session.repo_id,
            workstreamRun: this.#session.workstream_run,
            sessionId: this.#session.session_id,
            fencingGeneration: this.#session.session_generation,
            expectedVersion: obligation.version,
            idempotencyKey: `resolve-reservation-obligation:${obligation.obligation_id}:${String(obligation.version)}`,
        }, {
            obligation_id: obligation.obligation_id,
            integration_evidence_ref: input.integrationEvidenceRef,
            integration_evidence_sha256: input.integrationEvidenceSha256,
            validation_evidence_ref: input.validationEvidenceRef,
            validation_evidence_sha256: input.validationEvidenceSha256,
            session_lease_id: this.#session.session_lease_id,
            session_token: this.#session.session_token,
        });
        return parseCoordinationReservationObligation(response.payload['reservation_obligation']);
    }
}
export async function reconcilePendingReservationResolutions(active, env = process.env) {
    if (active.coordination_authority !== 'coordinator-edit-leases-v1')
        return Object.freeze([]);
    if (env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === undefined)
        throw new CoordinationRuntimeError('unauthorized-client', 'coordinator-backed reservation reconciliation requires its durable session');
    const client = await ReservationCoordinationClient.fromEnvironment(env);
    const view = await client.view();
    const resolved = [];
    for (const obligation of view.obligations.filter((entry) => entry.workstream_run === active.workstream_run && (entry.state === 'integration-required' || entry.state === 'resolved'))) {
        const integrationPath = join(active.runtime_root, 'reservation-integration', `${obligation.obligation_id}.json`);
        const validationPath = join(active.runtime_root, 'validation', `reservation-${obligation.obligation_id}.json`);
        if (!existsSync(integrationPath) || !existsSync(validationPath))
            continue;
        const integrationBytes = await readFile(integrationPath);
        const validationBytes = await readFile(validationPath);
        const integrationRef = relative(active.main_worktree_path, integrationPath).split(sep).join('/');
        const validationRef = relative(active.main_worktree_path, validationPath).split(sep).join('/');
        if (integrationRef.startsWith('../') || validationRef.startsWith('../'))
            throw new CoordinationRuntimeError('unauthorized-client', 'reservation resolution artifacts escape the run-owned main worktree');
        const integrationSha256 = `sha256:${createHash('sha256').update(integrationBytes).digest('hex')}`;
        const validationSha256 = `sha256:${createHash('sha256').update(validationBytes).digest('hex')}`;
        if (obligation.state === 'resolved' && obligation.integration_evidence?.ref === integrationRef && obligation.integration_evidence.sha256 === integrationSha256 && obligation.validation_evidence?.ref === validationRef && obligation.validation_evidence.sha256 === validationSha256)
            continue;
        resolved.push(await client.resolve({
            obligation,
            integrationEvidenceRef: integrationRef,
            integrationEvidenceSha256: integrationSha256,
            validationEvidenceRef: validationRef,
            validationEvidenceSha256: validationSha256,
        }));
    }
    return Object.freeze(resolved);
}
/**
 * Integrate landed, mechanically clean predecessor commits in deterministic
 * obligation order. Major/protected/semantic conflicts are never guessed: they
 * produce bounded repair-routing evidence and remain unresolved for a fresh
 * repair + independent validation attempt.
 */
export async function preparePendingReservationIntegrations(active, env = process.env, now = new Date()) {
    if (active.coordination_authority !== 'coordinator-edit-leases-v1')
        return { integration_evidence_paths: Object.freeze([]), repair_route_paths: Object.freeze([]), stale_validation_paths: Object.freeze([]) };
    const client = await ReservationCoordinationClient.fromEnvironment(env);
    const view = await client.view();
    const evidencePaths = [];
    const repairPaths = [];
    const stalePaths = [];
    const obligations = view.obligations.filter((entry) => entry.workstream_run === active.workstream_run && entry.state === 'integration-required').sort((left, right) => left.created_event_seq - right.created_event_seq || left.obligation_id.localeCompare(right.obligation_id));
    for (const obligation of obligations) {
        if (obligation.predecessor_terminal_sha === null || obligation.predecessor_released_event_seq === null)
            throw new CoordinationRuntimeError('store-corrupt', 'integration-required reservation obligation lacks predecessor landing identity', [obligation.obligation_id]);
        const integrationPath = join(active.runtime_root, 'reservation-integration', `${obligation.obligation_id}.json`);
        if (existsSync(integrationPath)) {
            evidencePaths.push(integrationPath);
            stalePaths.push(...await reconcileReservationIntegrationStaleness(active, obligation, integrationPath, now));
            continue;
        }
        const currentHead = gitHead(active.main_worktree_path);
        const predecessorAlreadyIntegrated = gitAncestor(active.main_worktree_path, obligation.predecessor_terminal_sha, currentHead);
        let currentClassification = obligation.integration_conflict;
        if (!predecessorAlreadyIntegrated) {
            currentClassification = classifyCoordinationIntegrationConflict({ repoRoot: active.source_repo, predecessorCommit: obligation.predecessor_terminal_sha, dependentCommit: currentHead, overlappingPaths: obligation.overlapping_paths });
        }
        if (!predecessorAlreadyIntegrated && currentClassification.disposition === 'repair-required') {
            repairPaths.push(await writeReservationRepairRoute(active, obligation, currentClassification, currentHead, now));
            continue;
        }
        // A repair unit may already have integrated a mechanically major conflict.
        // In that case ancestry is the postcondition proof; retain the major
        // classification in evidence and require a fresh independent PASS rather
        // than perpetually re-emitting a repair route.
        const before = currentHead;
        let after = before;
        const persistIntegrationEvidence = async () => {
            after = gitHead(active.main_worktree_path);
            const changedPaths = diffPaths(active.main_worktree_path, before, after);
            await writeJsonAtomic(integrationPath, {
                schema_version: 'autopilot.reservation_integration.v1', repo_id: obligation.repo_id, autopilot_id: active.autopilot_id, workstream: active.workstream, workstream_run: active.workstream_run,
                obligation_id: obligation.obligation_id, reservation_id: obligation.reservation_id, predecessor_reservation_id: obligation.predecessor_reservation_id,
                predecessor_released_event_seq: obligation.predecessor_released_event_seq, predecessor_terminal_sha: obligation.predecessor_terminal_sha, covered_paths: obligation.overlapping_paths,
                integration_head: after, integration_before: before, changed_paths: changedPaths, classification: currentClassification, integrated_at: now.toISOString(),
            });
        };
        if (!predecessorAlreadyIntegrated) {
            const mergeSpec = {
                active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'merge', initialWorktreeState: 'active', committedWorktreeState: 'active',
                intent: { repo_root: active.source_repo, worktree_path: active.main_worktree_path, git_common_dir: active.git_common_dir, branch: active.branch, reason: `ordered reservation integration ${obligation.obligation_id}`, base_sha: before, target_sha: obligation.predecessor_terminal_sha, archive_ref: null, checkout_mode: null, sparse_patterns: [], paths: obligation.overlapping_paths, metadata_refs: [relative(active.main_worktree_path, integrationPath).replace(/\\/gu, '/')] },
            };
            try {
                await executeOwnedWorktreeSaga(mergeSpec, {
                    action: async () => {
                        const merge = await runGitMutation({ descriptor: { kind: 'merge', mode: 'no-ff', message: `autopilot reservation integration ${obligation.obligation_id}`, target: obligation.predecessor_terminal_sha ?? '' }, cwd: active.main_worktree_path, env: reservationGitEnv(env) });
                        const postcondition = inspectOwnedWorktreeSpecPostcondition(mergeSpec, env);
                        if (postcondition.effect_applied)
                            return;
                        if (postcondition.outcome === 'unsafe')
                            throw new CoordinationRuntimeError('recovery-required', 'reservation merge canonical probe found unsafe repository state', postcondition.proof);
                        if (!postcondition.proof.includes('interrupted_merge'))
                            throw new CoordinationRuntimeError('recovery-required', 'reservation merge did not apply and left no canonically compensable merge state', [...postcondition.proof, `mutation_report=${merge.kind}`, `mutation_diagnostic=${merge.diagnostic}`]);
                        const abort = await runGitMutation({ descriptor: { kind: 'merge-abort' }, cwd: active.main_worktree_path, env: reservationGitEnv(env) });
                        const restored = inspectOwnedWorktreeSpecPostcondition(mergeSpec, env);
                        if (restored.outcome !== 'not-applied' || restored.effect_applied || restored.proof.includes('interrupted_merge'))
                            throw new CoordinationRuntimeError('recovery-required', 'reservation merge conflicted and canonical abort probe failed', [obligation.obligation_id, abort.diagnostic, ...restored.proof]);
                        throw new WorktreeSagaCompensatedError(`reservation integration conflicted: ${merge.diagnostic}`, [obligation.obligation_id]);
                    },
                    finalize: persistIntegrationEvidence,
                }, env);
            }
            catch (error) {
                if (!(error instanceof WorktreeSagaCompensatedError))
                    throw error;
                const reclassified = classifyCoordinationIntegrationConflict({ repoRoot: active.source_repo, predecessorCommit: obligation.predecessor_terminal_sha, dependentCommit: before, overlappingPaths: obligation.overlapping_paths });
                repairPaths.push(await writeReservationRepairRoute(active, obligation, reclassified, before, now));
                continue;
            }
        }
        else {
            await persistIntegrationEvidence();
        }
        evidencePaths.push(integrationPath);
        stalePaths.push(...await reconcileReservationIntegrationStaleness(active, obligation, integrationPath, now));
    }
    return { integration_evidence_paths: Object.freeze(evidencePaths), repair_route_paths: Object.freeze(repairPaths), stale_validation_paths: Object.freeze(stalePaths) };
}
export function parseReservationCoordinationView(payload) {
    return {
        reservations: parseArray(payload['change_reservations'], 'change_reservations', parseCoordinationChangeReservation),
        obligations: parseArray(payload['reservation_obligations'], 'reservation_obligations', parseCoordinationReservationObligation),
        editLeases: parseArray(payload['edit_leases'], 'edit_leases', parseCoordinationEditLease),
    };
}
export function reservationSchedulingBlockers(input) {
    const relevant = input.view.obligations.filter((obligation) => obligation.workstream_run === input.workstreamRun && obligation.state !== 'resolved' && obligation.state !== 'cancelled' && obligation.overlapping_paths.some((path) => input.requestedPaths.some((requested) => coordinationPathsOverlap(path, requested))));
    return {
        // Ordinary overlapping reservations are an integration obligation, not a
        // launch lock. Only a mechanically classified repair-required conflict
        // pauses further edits on that exact surface.
        ordering: Object.freeze([]),
        integration: relevant.filter((obligation) => obligation.integration_conflict.disposition === 'repair-required').map((obligation) => `${obligation.obligation_id}: ${obligation.integration_conflict.kind} requires deterministic integration repair and revalidation on ${obligation.overlapping_paths.join(', ')}`),
    };
}
export async function reservationCloseBlockers(active, env = process.env) {
    if (active.coordination_authority !== 'coordinator-edit-leases-v1')
        return Object.freeze([]);
    const stateRoot = stateRootForActive(active);
    const coordinatorEnv = { ...env, AUTOPILOT_STATE_ROOT: stateRoot };
    if (!existsSync(coordinatorRuntimePaths(coordinatorEnv).databasePath))
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator-backed close lost its durable coordinator database');
    const client = new CoordinatorClient({ env: coordinatorEnv });
    const status = await client.query('status', active.repo_key, active.workstream_run);
    const runs = status.payload['runs'];
    if (!Array.isArray(runs))
        throw new CoordinationRuntimeError('invalid-state', 'coordinator status omitted durable runs');
    if (runs.length === 0)
        throw new CoordinationRuntimeError('invalid-state', 'coordinator-backed close has no durable coordinator run');
    if (runs.length !== 1)
        throw new CoordinationRuntimeError('store-corrupt', 'coordinator returned duplicate durable runs');
    const view = parseReservationCoordinationView(status.payload);
    const ownReservations = view.reservations.filter((reservation) => reservation.repo_id === active.repo_key && reservation.workstream_run === active.workstream_run);
    const ownLeases = view.editLeases.filter((lease) => lease.owner.repo_id === active.repo_key && lease.owner.workstream_run === active.workstream_run);
    const ownObligations = view.obligations.filter((obligation) => obligation.repo_id === active.repo_key && obligation.workstream_run === active.workstream_run);
    const blockers = [];
    if (ownLeases.length > 0)
        blockers.push(...ownLeases.map((lease) => `Coordination Fabric: terminal unit retains active ${lease.mode} edit lease ${lease.edit_lease_id} on ${lease.path}`));
    blockers.push(...ownObligations.filter((obligation) => obligation.state === 'waiting-for-predecessor').map((obligation) => `Coordination Fabric: speculative reservation awaits predecessor landing before final integration (${obligation.obligation_id}; ${obligation.integration_conflict.kind})`));
    blockers.push(...ownObligations.filter((obligation) => obligation.state === 'integration-required').map((obligation) => `Coordination Fabric: landed predecessor requires ${obligation.integration_conflict.disposition === 'repair-required' ? 'integration repair' : 'ordered integration'} and current revalidation for ${obligation.overlapping_paths.join(', ')} (${obligation.obligation_id}; ${obligation.integration_conflict.kind})`));
    const resolvedObligations = ownObligations.filter((entry) => entry.state === 'resolved');
    const currentHead = resolvedObligations.length > 0 && existsSync(active.main_worktree_path) ? gitHead(active.main_worktree_path) : null;
    for (const obligation of resolvedObligations) {
        if (obligation.integration_evidence === null || obligation.validation_evidence === null) {
            blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} lacks immutable integration/validation evidence`);
            continue;
        }
        const integration = await readVerifiedRuntimeEvidence(active, obligation.integration_evidence);
        const validation = await readVerifiedRuntimeEvidence(active, obligation.validation_evidence);
        const integrationHead = textField(integration, 'integration_head', obligation.integration_evidence.ref);
        if (currentHead === null)
            blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} cannot verify its current integration head`);
        else if (integrationHead !== currentHead) {
            const ancestry = runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor: integrationHead, descendant: currentHead }, cwd: active.main_worktree_path });
            const changed = gitQueryNulStrings({ descriptor: { kind: 'diff-paths', from: integrationHead, to: currentHead, noRenames: true }, cwd: active.main_worktree_path });
            const invalidating = changed.filter((path) => obligation.overlapping_paths.some((protectedPath) => coordinationPathsOverlap(path, protectedPath)));
            if (ancestry.negative || invalidating.length > 0)
                blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} is stale at integration head ${currentHead}${invalidating.length > 0 ? ` on ${invalidating.join(', ')}` : ''}`);
        }
        if (currentHead !== null && obligation.predecessor_terminal_sha !== null) {
            const ancestry = runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor: obligation.predecessor_terminal_sha, descendant: currentHead }, cwd: active.main_worktree_path });
            if (ancestry.negative)
                blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} integration head does not contain predecessor commit ${obligation.predecessor_terminal_sha}`);
        }
        if (textField(validation, 'integration_head', obligation.validation_evidence.ref) !== integrationHead || textField(validation, 'verdict', obligation.validation_evidence.ref) !== 'PASS')
            blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} lacks a current validation PASS`);
    }
    const mergeFiles = await readUnitMergeFiles(active);
    const expected = new Map();
    for (const file of mergeFiles) {
        for (const path of file.merge.changed_paths)
            expected.set(`${file.evidenceRef}\0${file.sha256}\0${path}`, file);
    }
    for (const [key, file] of expected) {
        const split = key.split('\0');
        const path = split[2];
        if (path === undefined)
            throw new CoordinationRuntimeError('invalid-state', 'internal reservation proof key is malformed');
        const match = ownReservations.filter((reservation) => reservation.path === path && reservation.merge_evidence.ref === file.evidenceRef && reservation.merge_evidence.sha256 === file.sha256 && reservation.released_event_seq === null);
        if (match.length !== 1)
            blockers.push(`Coordination Fabric: accepted unit merge ${file.merge.unit_id} attempt ${String(file.merge.attempt)} path ${path} requires exactly one active change reservation, found ${String(match.length)}`);
    }
    for (const reservation of ownReservations) {
        if (reservation.released_event_seq !== null)
            blockers.push(`Coordination Fabric: unclosed run has prematurely released reservation ${reservation.reservation_id}`);
        const key = `${reservation.merge_evidence.ref}\0${reservation.merge_evidence.sha256}\0${reservation.path}`;
        if (!expected.has(key))
            blockers.push(`Coordination Fabric: reservation ${reservation.reservation_id} lacks matching current unit-merge/path evidence`);
    }
    for (const reservation of ownReservations.filter((entry) => entry.released_event_seq === null)) {
        const predecessors = view.reservations.filter((candidate) => candidate.repo_id === reservation.repo_id && candidate.workstream_run !== reservation.workstream_run && candidate.released_event_seq === null && (candidate.created_event_seq < reservation.created_event_seq || (candidate.created_event_seq === reservation.created_event_seq && candidate.reservation_id.localeCompare(reservation.reservation_id) < 0)) && coordinationPathsOverlap(candidate.path, reservation.path));
        for (const predecessor of predecessors) {
            const obligation = ownObligations.find((entry) => entry.reservation_id === reservation.reservation_id && entry.predecessor_reservation_id === predecessor.reservation_id && entry.state !== 'cancelled');
            if (obligation === undefined)
                blockers.push(`Coordination Fabric: overlapping reservation ${reservation.reservation_id} is missing ordering evidence for predecessor ${predecessor.reservation_id}`);
        }
    }
    return Object.freeze([...new Set(blockers)].sort((left, right) => left.localeCompare(right)));
}
export async function preparedRunTerminalIntent(active, env = process.env) {
    if (active.coordination_authority !== 'coordinator-edit-leases-v1')
        return null;
    const stateRoot = stateRootForActive(active);
    const coordinatorEnv = { ...env, AUTOPILOT_STATE_ROOT: stateRoot };
    if (!existsSync(coordinatorRuntimePaths(coordinatorEnv).databasePath))
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator-backed terminal recovery lost its durable coordinator database');
    const status = await new CoordinatorClient({ env: coordinatorEnv }).query('status', active.repo_key, active.workstream_run);
    const values = status.payload['run_terminal_intents'];
    if (!Array.isArray(values))
        throw new CoordinationRuntimeError('invalid-state', 'coordinator status omitted run terminal intents');
    const prepared = values.map((value) => parseCoordinationRunTerminalIntent(value)).filter((intent) => intent.state === 'prepared');
    if (prepared.length > 1)
        throw new CoordinationRuntimeError('store-corrupt', 'run has multiple prepared terminal intents');
    return prepared[0] ?? null;
}
export async function resolvedReservationIntegrations(active, env = process.env) {
    if (active.coordination_authority !== 'coordinator-edit-leases-v1')
        return Object.freeze([]);
    const stateRoot = stateRootForActive(active);
    const coordinatorEnv = { ...env, AUTOPILOT_STATE_ROOT: stateRoot };
    if (!existsSync(coordinatorRuntimePaths(coordinatorEnv).databasePath))
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator-backed integration proof lost its durable coordinator database');
    const status = await new CoordinatorClient({ env: coordinatorEnv }).query('status', active.repo_key, active.workstream_run);
    const runs = status.payload['runs'];
    if (!Array.isArray(runs) || runs.length !== 1)
        throw new CoordinationRuntimeError('invalid-state', 'coordinator-backed integration proof requires exactly one durable run');
    const view = parseReservationCoordinationView(status.payload);
    const integrations = [];
    for (const obligation of view.obligations.filter((entry) => entry.workstream_run === active.workstream_run && entry.state === 'resolved')) {
        if (obligation.predecessor_terminal_sha === null)
            throw new CoordinationRuntimeError('store-corrupt', 'resolved reservation obligation lacks predecessor terminal commit', [obligation.obligation_id]);
        integrations.push({ obligationId: obligation.obligation_id, predecessorTerminalSha: obligation.predecessor_terminal_sha, paths: obligation.overlapping_paths });
    }
    return Object.freeze(integrations);
}
async function reconcileReservationIntegrationStaleness(active, obligation, integrationPath, now) {
    const parsed = JSON.parse(await readFile(integrationPath, 'utf8'));
    if (!record(parsed) || parsed['schema_version'] !== 'autopilot.reservation_integration.v1' || parsed['repo_id'] !== obligation.repo_id || parsed['workstream_run'] !== obligation.workstream_run || parsed['obligation_id'] !== obligation.obligation_id || parsed['reservation_id'] !== obligation.reservation_id || parsed['predecessor_reservation_id'] !== obligation.predecessor_reservation_id || parsed['predecessor_released_event_seq'] !== obligation.predecessor_released_event_seq || parsed['predecessor_terminal_sha'] !== obligation.predecessor_terminal_sha)
        throw new CoordinationRuntimeError('invalid-state', 'persisted reservation integration evidence does not match its immutable obligation', [integrationPath, obligation.obligation_id]);
    const integrationHead = parsed['integration_head'];
    if (typeof integrationHead !== 'string' || !/^[a-f0-9]{40,64}$/u.test(integrationHead))
        throw new CoordinationRuntimeError('invalid-state', 'persisted reservation integration evidence has an invalid integration head', [integrationPath]);
    const classification = parsed['classification'];
    const changed = parsed['changed_paths'];
    // Manually produced repair evidence predates automatic ordered integration
    // fields and is validated by the coordinator's existing ancestry + current
    // independent-PASS contract. Only package-generated evidence participates in
    // resumable automatic staleness projection.
    if (classification === undefined && changed === undefined)
        return Object.freeze([]);
    if (classification === undefined || changed === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'automatic reservation integration evidence is only partially populated', [integrationPath]);
    parseCoordinationIntegrationConflict(classification, 'reservation integration classification');
    if (!Array.isArray(changed) || !changed.every((path) => typeof path === 'string') || new Set(changed).size !== changed.length)
        throw new CoordinationRuntimeError('invalid-state', 'persisted reservation integration evidence has invalid changed paths', [integrationPath]);
    if (changed.length === 0)
        return Object.freeze([]);
    const changedPaths = changed;
    const validationRefs = (await listJsonFiles(join(active.runtime_root, 'validation'))).map((path) => relative(active.runtime_root, path).replace(/\\/gu, '/'));
    const integrationRef = relative(active.runtime_root, integrationPath).replace(/\\/gu, '/');
    if (integrationRef.startsWith('../') || integrationRef.startsWith('/'))
        throw new CoordinationRuntimeError('invalid-state', 'reservation integration evidence escapes the authoritative runtime root', [integrationPath]);
    const stale = await recordValidationStalenessForReservationIntegration({ runtimeRoot: active.runtime_root, workstream: active.workstream, obligationId: obligation.obligation_id, invalidatingRef: integrationRef, currentIntegrationHead: integrationHead, changedPaths, validationEvidenceRefs: validationRefs, now });
    return Object.freeze(stale.map((entry) => reservationValidationStalenessPath(active.runtime_root, entry.source_unit_id, entry.source_attempt, obligation.obligation_id, entry.stale_validation_ref)));
}
async function writeReservationRepairRoute(active, obligation, classification, currentHead, now) {
    const generation = createHash('sha256').update(`${obligation.obligation_id}\0${currentHead}\0${classification.classification_id}`, 'utf8').digest('hex').slice(0, 24);
    const path = join(active.runtime_root, 'reservation-repairs', `${obligation.obligation_id}.${generation}.json`);
    if (existsSync(path)) {
        const existing = JSON.parse(await readFile(path, 'utf8'));
        if (!record(existing) || existing['schema_version'] !== 'autopilot.reservation_repair.v1' || existing['obligation_id'] !== obligation.obligation_id || existing['current_head'] !== currentHead || existing['predecessor_terminal_sha'] !== obligation.predecessor_terminal_sha || !record(existing['classification']) || existing['classification']['classification_id'] !== classification.classification_id)
            throw new CoordinationRuntimeError('invalid-state', 'immutable reservation repair route differs on replay', [path, obligation.obligation_id]);
        return path;
    }
    await writeJsonAtomic(path, {
        schema_version: 'autopilot.reservation_repair.v1', repo_id: obligation.repo_id, autopilot_id: active.autopilot_id, workstream: active.workstream, workstream_run: active.workstream_run,
        obligation_id: obligation.obligation_id, reservation_id: obligation.reservation_id, predecessor_reservation_id: obligation.predecessor_reservation_id,
        current_head: currentHead, predecessor_terminal_sha: obligation.predecessor_terminal_sha, overlapping_paths: obligation.overlapping_paths, classification,
        state: 'repair-ready', required_next_state: 'repair-then-independent-revalidation', created_at: now.toISOString(),
    });
    return path;
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function gitAncestor(cwd, ancestor, descendant) {
    return !runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor, descendant }, cwd }).negative;
}
function diffPaths(cwd, before, after) {
    if (before === after)
        return Object.freeze([]);
    return Object.freeze(gitQueryNulStrings({ descriptor: { kind: 'diff-paths', from: before, to: after, noRenames: true }, cwd }).map((path) => path.replace(/\\/gu, '/')).sort((left, right) => left.localeCompare(right)));
}
function reservationGitEnv(env) {
    return { ...process.env, ...env, AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'reservation-integration', GIT_AUTHOR_NAME: 'autopilot-runtime', GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid', GIT_COMMITTER_NAME: 'autopilot-runtime', GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid' };
}
async function readVerifiedRuntimeEvidence(active, evidence) {
    const path = resolve(active.main_worktree_path, evidence.ref);
    const relativePath = relative(active.main_worktree_path, path);
    if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
        throw new CoordinationRuntimeError('unauthorized-client', 'reservation evidence escapes the run-owned main worktree', [evidence.ref]);
    const bytes = await readFile(path);
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== evidence.sha256)
        throw new CoordinationRuntimeError('invalid-state', 'reservation evidence changed after coordinator acceptance', [evidence.ref]);
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', 'reservation evidence is invalid JSON', [evidence.ref, error instanceof Error ? error.message : String(error)]);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new CoordinationRuntimeError('invalid-state', 'reservation evidence must be an object', [evidence.ref]);
    return parsed;
}
function textField(record, field, ref) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0)
        throw new CoordinationRuntimeError('invalid-state', `reservation evidence ${ref} has invalid ${field}`);
    return value;
}
async function readUnitMergeFiles(active) {
    const root = join(active.runtime_root, 'unit-merges');
    if (!existsSync(root))
        return Object.freeze([]);
    const files = await listJsonFiles(root);
    const out = [];
    for (const path of files) {
        const bytes = await readFile(path);
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
        }
        catch (error) {
            throw new CoordinationRuntimeError('invalid-state', 'unit merge evidence is not valid JSON', [path, error instanceof Error ? error.message : String(error)]);
        }
        const merge = parseAutopilotUnitMerge(parsed);
        if (merge.autopilot_id !== active.autopilot_id || merge.workstream_run !== active.workstream_run)
            continue;
        const evidenceRef = relative(active.main_worktree_path, path).split(sep).join('/');
        if (evidenceRef.length === 0 || evidenceRef === '..' || evidenceRef.startsWith('../') || isAbsolute(evidenceRef))
            throw new CoordinationRuntimeError('unauthorized-client', 'unit merge evidence escapes the run-owned main worktree', [path]);
        out.push({ merge, evidenceRef, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    }
    return Object.freeze(out.sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef)));
}
async function listJsonFiles(root) {
    if (!existsSync(root))
        return Object.freeze([]);
    const files = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory())
            files.push(...await listJsonFiles(path));
        else if (entry.isFile() && entry.name.endsWith('.json'))
            files.push(path);
    }
    return Object.freeze(files.sort((left, right) => left.localeCompare(right)));
}
