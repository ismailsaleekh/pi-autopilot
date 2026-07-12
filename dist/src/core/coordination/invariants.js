import { claimModesConflict, coordinationPathsOverlap } from "./contracts.js";
import { coordinationOwnerKey, detectCoordinationWaitCycles } from "./deadlock.js";
import { CoordinationRuntimeError } from "./failures.js";
const TERMINAL_REQUEST_STATES = new Set(['resolved', 'cancelled', 'superseded']);
const LIVE_RUN_STATES = new Set(['active', 'paused', 'merging', 'blocked', 'recovering']);
function ownerKey(owner) {
    return `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}`;
}
function runKey(repoId, workstreamRun) {
    return `${repoId}\0${workstreamRun}`;
}
function conditionSatisfied(snapshot, repoId, workstreamRun, condition) {
    if (condition.condition_type === 'explicit-owner-release')
        return false;
    if (condition.condition_type === 'child-terminal')
        return snapshot.child_leases.some((child) => child.owner.repo_id === repoId && child.owner.workstream_run === workstreamRun && child.child_lease_id === condition.target_id && child.status === 'terminal');
    if (condition.condition_type === 'run-closed')
        return snapshot.runs.some((run) => run.repo_id === repoId && run.workstream_run === workstreamRun && condition.target_id === workstreamRun && (run.status === 'closed' || run.status === 'aborted'));
    return snapshot.reconciliation_evidence.some((evidence) => evidence.repo_id === repoId && evidence.workstream_run === workstreamRun && evidence.release_condition.condition_type === condition.condition_type && evidence.release_condition.target_id === condition.target_id);
}
function finding(code, entity, detail, severity = 'error') {
    return { code, severity, entity, detail };
}
function duplicateFindings(values, code, entity) {
    const counts = new Map();
    for (const value of values)
        counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()]
        .filter((entry) => entry[1] > 1)
        .map((entry) => finding(code, entity, `duplicate identity ${entry[0]}`));
}
export function checkCoordinationInvariants(snapshot) {
    const findings = [];
    const repositoryIds = new Set(snapshot.repositories.map((repository) => repository.repo_id));
    const runs = new Map(snapshot.runs.map((run) => [runKey(run.repo_id, run.workstream_run), run]));
    const attempts = new Map(snapshot.unit_attempts.map((attempt) => [ownerKey(attempt.owner), attempt]));
    const groups = new Map(snapshot.acquisition_groups.map((group) => [group.acquisition_group_id, group]));
    const worktrees = new Map(snapshot.worktrees.map((worktree) => [worktree.worktree_id, worktree]));
    const reservations = new Map(snapshot.change_reservations.map((reservation) => [reservation.reservation_id, reservation]));
    findings.push(...duplicateFindings(snapshot.repositories.map((value) => value.repo_id), 'duplicate-repository', 'repositories'));
    findings.push(...duplicateFindings(snapshot.runs.map((value) => runKey(value.repo_id, value.workstream_run)), 'duplicate-run', 'runs'));
    findings.push(...duplicateFindings(snapshot.session_leases.map((value) => value.session_lease_id), 'duplicate-session-lease', 'session_leases'));
    findings.push(...duplicateFindings(snapshot.child_leases.map((value) => value.child_lease_id), 'duplicate-child-lease', 'child_leases'));
    findings.push(...duplicateFindings(snapshot.unit_attempts.map((value) => ownerKey(value.owner)), 'duplicate-unit-attempt', 'unit_attempts'));
    findings.push(...duplicateFindings(snapshot.acquisition_groups.map((value) => value.acquisition_group_id), 'duplicate-acquisition-group', 'acquisition_groups'));
    findings.push(...duplicateFindings(snapshot.edit_leases.map((value) => value.edit_lease_id), 'duplicate-edit-lease', 'edit_leases'));
    findings.push(...duplicateFindings(snapshot.change_reservations.map((value) => value.reservation_id), 'duplicate-reservation', 'change_reservations'));
    findings.push(...duplicateFindings(snapshot.reservation_obligations.map((value) => value.obligation_id), 'duplicate-reservation-obligation', 'reservation_obligations'));
    findings.push(...duplicateFindings(snapshot.run_terminal_intents.map((value) => value.terminal_intent_id), 'duplicate-run-terminal-intent', 'run_terminal_intents'));
    findings.push(...duplicateFindings(snapshot.claim_requests.map((value) => value.request_id), 'duplicate-claim-request', 'claim_requests'));
    findings.push(...duplicateFindings(snapshot.mailbox_cursors.map((value) => runKey(value.repo_id, value.workstream_run)), 'duplicate-mailbox-cursor', 'mailbox_cursors'));
    findings.push(...duplicateFindings(snapshot.reconciliation_evidence.map((value) => value.reconciliation_evidence_id), 'duplicate-reconciliation-evidence', 'reconciliation_evidence'));
    findings.push(...duplicateFindings(snapshot.messages.map((value) => value.message_id), 'duplicate-message', 'messages'));
    findings.push(...duplicateFindings(snapshot.worktrees.map((value) => value.worktree_id), 'duplicate-worktree', 'worktrees'));
    findings.push(...duplicateFindings(snapshot.worktree_operations.map((value) => value.operation_id), 'duplicate-operation', 'worktree_operations'));
    findings.push(...duplicateFindings(snapshot.wait_for_edges.map((value) => value.edge_id), 'duplicate-wait-for-edge', 'wait_for_edges'));
    findings.push(...duplicateFindings(snapshot.wait_for_edges.map((value) => value.request_id), 'duplicate-wait-for-request', 'wait_for_edges'));
    findings.push(...duplicateFindings(snapshot.deadlock_resolutions.map((value) => value.resolution_id), 'duplicate-deadlock-resolution', 'deadlock_resolutions'));
    findings.push(...duplicateFindings(snapshot.authoritative_artifacts.map((value) => value.artifact_id), 'duplicate-authoritative-artifact', 'authoritative_artifacts'));
    findings.push(...duplicateFindings(snapshot.adjudication_assignments.map((value) => value.assignment_id), 'duplicate-adjudication-assignment', 'adjudication_assignments'));
    findings.push(...duplicateFindings(snapshot.adjudication_assignments.filter((value) => value.state === 'assigned').map((value) => ownerKey(value.adjudicator)), 'duplicate-live-adjudicator-assignment', 'adjudication_assignments'));
    findings.push(...duplicateFindings(snapshot.escalations.map((value) => value.escalation_id), 'duplicate-escalation', 'escalations'));
    findings.push(...duplicateFindings(snapshot.events.map((value) => `${value.repo_id}\0${String(value.event_seq)}`), 'duplicate-event-sequence', 'events'));
    findings.push(...duplicateFindings(snapshot.events.map((value) => `${value.repo_id}\0${value.idempotency_key}`), 'duplicate-idempotency-key', 'events'));
    for (const run of snapshot.runs) {
        if (!repositoryIds.has(run.repo_id))
            findings.push(finding('run-repository-missing', run.workstream_run, `repository ${run.repo_id} does not exist`));
    }
    for (const session of snapshot.session_leases) {
        const run = runs.get(runKey(session.repo_id, session.workstream_run));
        if (run === undefined) {
            findings.push(finding('session-run-missing', session.session_lease_id, 'owning run does not exist'));
            continue;
        }
        if (session.status === 'attached' && session.session_generation !== run.active_session_generation) {
            findings.push(finding('attached-session-generation-mismatch', session.session_lease_id, `attached generation ${String(session.session_generation)} differs from run generation ${String(run.active_session_generation)}`));
        }
    }
    for (const run of snapshot.runs) {
        const attached = snapshot.session_leases.filter((session) => session.repo_id === run.repo_id && session.workstream_run === run.workstream_run && session.status === 'attached');
        if (attached.length > 1)
            findings.push(finding('multiple-attached-sessions', run.workstream_run, `${String(attached.length)} sessions are attached`));
        const cursors = snapshot.mailbox_cursors.filter((cursor) => cursor.repo_id === run.repo_id && cursor.workstream_run === run.workstream_run);
        if (cursors.length !== 1)
            findings.push(finding('run-mailbox-cursor-count', run.workstream_run, `run requires exactly one durable mailbox cursor, found ${String(cursors.length)}`));
    }
    const assertOwner = (owner, entity) => {
        const run = runs.get(runKey(owner.repo_id, owner.workstream_run));
        if (run === undefined) {
            findings.push(finding('owner-run-missing', entity, `run ${owner.workstream_run} does not exist`));
            return;
        }
        if (run.autopilot_id !== owner.autopilot_id)
            findings.push(finding('owner-autopilot-mismatch', entity, `owner ${owner.autopilot_id} differs from run owner ${run.autopilot_id}`));
    };
    for (const attempt of snapshot.unit_attempts)
        assertOwner(attempt.owner, ownerKey(attempt.owner));
    for (const child of snapshot.child_leases) {
        assertOwner(child.owner, child.child_lease_id);
        if (!attempts.has(ownerKey(child.owner)))
            findings.push(finding('child-attempt-missing', child.child_lease_id, 'owning unit attempt does not exist'));
        if (child.status === 'terminal' && child.terminal_evidence === null)
            findings.push(finding('terminal-child-evidence-missing', child.child_lease_id, 'terminal child requires immutable evidence'));
    }
    for (const attempt of snapshot.unit_attempts) {
        const attemptGroups = snapshot.acquisition_groups.filter((group) => ownerKey(group.owner) === ownerKey(attempt.owner));
        const initialGroups = attemptGroups.filter((group) => group.acquisition_kind === 'initial' || group.acquisition_kind === 'legacy-unknown');
        if (initialGroups.length > 1)
            findings.push(finding('multiple-initial-acquisition-groups', ownerKey(attempt.owner), 'unit attempt may declare only one immutable initial acquisition group'));
        for (const expansion of attemptGroups.filter((group) => group.acquisition_kind === 'materialization-read-expansion')) {
            if (initialGroups.length !== 1 || expansion.requested_leases.some((lease) => lease.mode !== 'READ'))
                findings.push(finding('invalid-materialization-expansion', expansion.acquisition_group_id, 'materialization expansion requires one initial group and READ-only authority'));
        }
    }
    for (const group of snapshot.acquisition_groups) {
        assertOwner(group.owner, group.acquisition_group_id);
        const groupAttempt = attempts.get(ownerKey(group.owner));
        if (groupAttempt !== undefined && groupAttempt.role !== 'implement' && groupAttempt.role !== 'fix' && groupAttempt.role !== 'unknown' && group.requested_leases.some((lease) => lease.mode !== 'READ'))
            findings.push(finding('non-source-role-write-authority', group.acquisition_group_id, `${groupAttempt.role} unit requested source-changing authority`));
        if (!attempts.has(ownerKey(group.owner)))
            findings.push(finding('group-attempt-missing', group.acquisition_group_id, 'owning unit attempt does not exist'));
        const leases = snapshot.edit_leases.filter((lease) => lease.acquisition_group_id === group.acquisition_group_id);
        if (group.state === 'waiting' || group.state === 'grant-ready' || group.state === 'released' || group.state === 'cancelled' || group.state === 'superseded') {
            if (leases.length > 0)
                findings.push(finding('ungranted-group-holds-leases', group.acquisition_group_id, `${group.state} group holds ${String(leases.length)} active leases`));
        }
        if (group.state === 'grant-ready' && group.offer_expires_at === null)
            findings.push(finding('grant-offer-expiry-missing', group.acquisition_group_id, 'grant-ready group requires a bounded offer expiry'));
        if (group.state !== 'grant-ready' && group.offer_expires_at !== null)
            findings.push(finding('unexpected-grant-offer-expiry', group.acquisition_group_id, `${group.state} group retains an offer expiry`));
        if (group.state === 'granted') {
            const requested = new Set(group.requested_leases.map((lease) => `${lease.mode}\0${lease.path}`));
            const unexpected = leases.filter((lease) => !requested.has(`${lease.mode}\0${lease.path}`));
            if (unexpected.length > 0)
                findings.push(finding('acquisition-group-unrequested-lease', group.acquisition_group_id, 'active lease set contains authority outside the requested set'));
            if (group.grant_event_seq === null)
                findings.push(finding('granted-group-event-missing', group.acquisition_group_id, 'granted group requires grant_event_seq'));
        }
    }
    const offeredGroups = snapshot.acquisition_groups.filter((group) => group.state === 'grant-ready');
    for (let leftIndex = 0; leftIndex < offeredGroups.length; leftIndex += 1) {
        const left = offeredGroups[leftIndex];
        if (left === undefined)
            continue;
        for (let rightIndex = leftIndex + 1; rightIndex < offeredGroups.length; rightIndex += 1) {
            const right = offeredGroups[rightIndex];
            if (right === undefined || left.owner.repo_id !== right.owner.repo_id)
                continue;
            const incompatible = left.requested_leases.some((leftLease) => right.requested_leases.some((rightLease) => coordinationPathsOverlap(leftLease.path, rightLease.path) && claimModesConflict(leftLease.mode, rightLease.mode)));
            if (incompatible)
                findings.push(finding('incompatible-grant-offers', `${left.acquisition_group_id},${right.acquisition_group_id}`, 'only one incompatible acquisition group may hold a bounded offer'));
        }
    }
    for (const lease of snapshot.edit_leases) {
        assertOwner(lease.owner, lease.edit_lease_id);
        const owningRun = runs.get(runKey(lease.owner.repo_id, lease.owner.workstream_run));
        if (owningRun !== undefined && owningRun.coordination_authority !== 'coordinator-edit-leases-v1')
            findings.push(finding('legacy-run-retains-edit-lease', lease.edit_lease_id, 'legacy-path-claim authoritative run must not hold coordinator edit authority'));
        const attempt = attempts.get(ownerKey(lease.owner));
        if (attempt !== undefined && ['merged', 'failed', 'reset', 'quarantined', 'superseded'].includes(attempt.state))
            findings.push(finding('terminal-attempt-retains-edit-lease', lease.edit_lease_id, `${attempt.state} unit attempt retains active edit authority`));
        if (conditionSatisfied(snapshot, lease.owner.repo_id, lease.owner.workstream_run, lease.normal_release_condition))
            findings.push(finding('satisfied-condition-retains-lease', lease.edit_lease_id, 'accepted terminal evidence must release active edit authority'));
        const group = groups.get(lease.acquisition_group_id);
        if (group === undefined)
            findings.push(finding('lease-group-missing', lease.edit_lease_id, 'acquisition group does not exist'));
        else if (ownerKey(group.owner) !== ownerKey(lease.owner))
            findings.push(finding('lease-group-owner-mismatch', lease.edit_lease_id, 'lease and acquisition group have different owners'));
    }
    for (let leftIndex = 0; leftIndex < snapshot.edit_leases.length; leftIndex += 1) {
        const left = snapshot.edit_leases[leftIndex];
        if (left === undefined)
            continue;
        for (let rightIndex = leftIndex + 1; rightIndex < snapshot.edit_leases.length; rightIndex += 1) {
            const right = snapshot.edit_leases[rightIndex];
            if (right === undefined || left.owner.repo_id !== right.owner.repo_id)
                continue;
            if (coordinationPathsOverlap(left.path, right.path) && claimModesConflict(left.mode, right.mode)) {
                findings.push(finding('incompatible-active-edit-leases', `${left.edit_lease_id},${right.edit_lease_id}`, `${left.mode} ${left.path} overlaps ${right.mode} ${right.path}`));
            }
        }
    }
    for (const reservation of snapshot.change_reservations) {
        const run = runs.get(runKey(reservation.repo_id, reservation.workstream_run));
        if (run === undefined)
            findings.push(finding('reservation-run-missing', reservation.reservation_id, 'owning run does not exist'));
        else {
            if (run.coordination_authority !== 'coordinator-edit-leases-v1')
                findings.push(finding('legacy-run-retains-reservation', reservation.reservation_id, 'legacy-path-claim authoritative run must not hold change reservations'));
            if (run.autopilot_id !== reservation.autopilot_id)
                findings.push(finding('reservation-owner-mismatch', reservation.reservation_id, 'reservation owner differs from run owner'));
            if ((run.status === 'closed' || run.status === 'aborted') && reservation.released_event_seq === null)
                findings.push(finding('terminal-run-retains-reservation', reservation.reservation_id, `${run.status} run retains an unlanded reservation`));
            if (run.status !== 'closed' && run.status !== 'aborted' && reservation.released_event_seq !== null)
                findings.push(finding('live-run-released-reservation', reservation.reservation_id, 'reservation was released without a terminal run transition'));
        }
        const acceptedMerge = snapshot.reconciliation_evidence.some((evidence) => evidence.repo_id === reservation.repo_id && evidence.workstream_run === reservation.workstream_run && evidence.source === 'unit-merge' && evidence.release_condition.evidence !== null && evidence.release_condition.evidence.ref === reservation.merge_evidence.ref && evidence.release_condition.evidence.sha256 === reservation.merge_evidence.sha256);
        if (!acceptedMerge)
            findings.push(finding('reservation-merge-evidence-missing', reservation.reservation_id, 'reservation does not reference accepted immutable unit-merge evidence'));
    }
    for (const obligation of snapshot.reservation_obligations) {
        const reservation = reservations.get(obligation.reservation_id);
        const predecessor = reservations.get(obligation.predecessor_reservation_id);
        if (reservation === undefined)
            findings.push(finding('obligation-reservation-missing', obligation.obligation_id, 'dependent reservation does not exist'));
        if (predecessor === undefined)
            findings.push(finding('obligation-predecessor-missing', obligation.obligation_id, 'predecessor reservation does not exist'));
        if (reservation !== undefined && (obligation.repo_id !== reservation.repo_id || obligation.workstream_run !== reservation.workstream_run))
            findings.push(finding('obligation-owner-mismatch', obligation.obligation_id, 'obligation owner differs from dependent reservation'));
        if (reservation !== undefined && predecessor !== undefined) {
            if (reservation.repo_id !== predecessor.repo_id || reservation.workstream_run === predecessor.workstream_run)
                findings.push(finding('obligation-predecessor-invalid', obligation.obligation_id, 'predecessor must be a foreign run reservation in the same repository'));
            if (!coordinationPathsOverlap(reservation.path, predecessor.path))
                findings.push(finding('obligation-paths-do-not-overlap', obligation.obligation_id, 'reservation pair does not overlap'));
        }
        if (obligation.state === 'waiting-for-predecessor' && predecessor !== undefined && predecessor.released_event_seq !== null)
            findings.push(finding('released-predecessor-obligation-not-advanced', obligation.obligation_id, 'released predecessor must advance or cancel its obligation'));
        if ((obligation.state === 'integration-required' || obligation.state === 'resolved') && predecessor !== undefined && obligation.predecessor_released_event_seq !== predecessor.released_event_seq)
            findings.push(finding('obligation-release-sequence-mismatch', obligation.obligation_id, 'obligation does not bind the predecessor release event'));
    }
    const orderedActiveReservations = snapshot.change_reservations.filter((reservation) => reservation.released_event_seq === null).sort((left, right) => left.created_event_seq - right.created_event_seq || left.reservation_id.localeCompare(right.reservation_id));
    for (let leftIndex = 0; leftIndex < orderedActiveReservations.length; leftIndex += 1) {
        const predecessor = orderedActiveReservations[leftIndex];
        if (predecessor === undefined)
            continue;
        for (let rightIndex = leftIndex + 1; rightIndex < orderedActiveReservations.length; rightIndex += 1) {
            const dependent = orderedActiveReservations[rightIndex];
            if (dependent === undefined || dependent.repo_id !== predecessor.repo_id || dependent.workstream_run === predecessor.workstream_run || !coordinationPathsOverlap(predecessor.path, dependent.path))
                continue;
            const obligation = snapshot.reservation_obligations.find((entry) => entry.reservation_id === dependent.reservation_id && entry.predecessor_reservation_id === predecessor.reservation_id && entry.state !== 'cancelled');
            if (obligation === undefined)
                findings.push(finding('overlapping-reservations-uncoordinated', `${predecessor.reservation_id},${dependent.reservation_id}`, 'foreign unlanded overlap requires deterministic integration ordering'));
        }
    }
    for (const intent of snapshot.run_terminal_intents) {
        const run = runs.get(runKey(intent.repo_id, intent.workstream_run));
        if (run === undefined)
            findings.push(finding('terminal-intent-run-missing', intent.terminal_intent_id, 'owning run does not exist'));
        const activeReservations = snapshot.change_reservations.filter((reservation) => reservation.repo_id === intent.repo_id && reservation.workstream_run === intent.workstream_run && reservation.released_event_seq === null).map((reservation) => reservation.reservation_id).sort();
        if (intent.state === 'prepared' && JSON.stringify([...intent.reservation_ids].sort()) !== JSON.stringify(activeReservations))
            findings.push(finding('terminal-intent-reservation-set-drift', intent.terminal_intent_id, 'prepared terminal intent no longer matches active reservation set'));
        if (intent.state === 'committed' && run !== undefined && run.status !== intent.outcome)
            findings.push(finding('terminal-intent-run-status-mismatch', intent.terminal_intent_id, `committed ${intent.outcome} intent has run status ${run.status}`));
    }
    for (const run of snapshot.runs) {
        const preparedIntents = snapshot.run_terminal_intents.filter((intent) => intent.repo_id === run.repo_id && intent.workstream_run === run.workstream_run && intent.state === 'prepared');
        if (preparedIntents.length > 1)
            findings.push(finding('multiple-prepared-terminal-intents', run.workstream_run, `${String(preparedIntents.length)} terminal intents are prepared`));
        if (run.status !== 'closed' && run.status !== 'aborted')
            continue;
        const liveLeases = snapshot.edit_leases.filter((lease) => lease.owner.repo_id === run.repo_id && lease.owner.workstream_run === run.workstream_run);
        if (liveLeases.length > 0)
            findings.push(finding('terminal-run-retains-edit-leases', run.workstream_run, `${run.status} run retains ${String(liveLeases.length)} active edit leases`));
        const unresolved = snapshot.reservation_obligations.filter((obligation) => obligation.repo_id === run.repo_id && obligation.workstream_run === run.workstream_run && obligation.state !== 'resolved' && obligation.state !== 'cancelled');
        if (unresolved.length > 0)
            findings.push(finding('terminal-run-retains-reservation-obligations', run.workstream_run, `${run.status} run retains ${String(unresolved.length)} integration obligations`));
    }
    for (const request of snapshot.claim_requests) {
        assertOwner(request.requester, request.request_id);
        assertOwner(request.owner, request.request_id);
        if (!groups.has(request.acquisition_group_id))
            findings.push(finding('request-group-missing', request.request_id, 'request acquisition group does not exist'));
        for (const leaseId of request.blocking_lease_ids) {
            const lease = snapshot.edit_leases.find((candidate) => candidate.edit_lease_id === leaseId);
            if (lease === undefined) {
                if (!TERMINAL_REQUEST_STATES.has(request.status) && request.status !== 'released' && request.status !== 'requester-notified')
                    findings.push(finding('request-blocking-lease-missing', request.request_id, `blocking lease ${leaseId} is absent before release evidence`));
            }
            else if (ownerKey(lease.owner) !== ownerKey(request.owner)) {
                findings.push(finding('request-addressed-to-wrong-owner', request.request_id, `blocking lease ${leaseId} has a different owner`));
            }
        }
        if (request.status === 'deferred' && (request.owner_reason === null || request.release_condition === null))
            findings.push(finding('deferred-request-promise-incomplete', request.request_id, 'deferred request requires owner_reason and typed release_condition'));
        if (request.status === 'deferred' && request.release_condition !== null && conditionSatisfied(snapshot, request.owner.repo_id, request.owner.workstream_run, request.release_condition))
            findings.push(finding('satisfied-deferred-request-not-released', request.request_id, 'satisfied typed release promise must release and notify automatically'));
        if ((request.status === 'released' || request.status === 'grant-ready' || request.status === 'granted' || request.status === 'requester-notified' || request.status === 'resolved') && request.release_event_seq === null)
            findings.push(finding('released-request-event-missing', request.request_id, `${request.status} request requires release_event_seq`));
        if ((request.status === 'granted' || request.status === 'resolved') && request.grant_event_seq === null)
            findings.push(finding('granted-request-event-missing', request.request_id, `${request.status} request requires grant_event_seq`));
        if (!TERMINAL_REQUEST_STATES.has(request.status) && request.status !== 'deferred' && request.status !== 'contradiction-review') {
            const run = runs.get(runKey(request.requester.repo_id, request.requester.workstream_run));
            if (run !== undefined && !LIVE_RUN_STATES.has(run.status))
                findings.push(finding('nonterminal-request-on-terminal-run', request.request_id, `requester run is ${run.status}`));
        }
        if (request.release_event_seq !== null) {
            const notification = snapshot.messages.find((message) => message.message_type === 'release-notification' && message.correlation_id === request.request_id && message.created_event_seq === request.release_event_seq);
            if (notification === undefined)
                findings.push(finding('release-notification-not-atomic', request.request_id, 'release event lacks a same-sequence requester notification'));
        }
    }
    for (const cursor of snapshot.mailbox_cursors) {
        if (!runs.has(runKey(cursor.repo_id, cursor.workstream_run)))
            findings.push(finding('mailbox-cursor-run-missing', cursor.workstream_run, 'mailbox cursor owning run does not exist'));
        if (cursor.acknowledged_through_event_seq > cursor.delivered_through_event_seq)
            findings.push(finding('mailbox-cursor-order-invalid', cursor.workstream_run, 'acknowledgement cursor exceeds delivery cursor'));
    }
    const expectedConditionBySource = { 'child-process': 'child-terminal', 'unit-merge': 'unit-merged', 'attempt-reset': 'attempt-reset', 'quarantine-capture': 'quarantine-captured', 'run-close': 'run-closed', 'run-abort': 'run-closed' };
    for (const evidence of snapshot.reconciliation_evidence) {
        const run = runs.get(runKey(evidence.repo_id, evidence.workstream_run));
        if (run === undefined)
            findings.push(finding('reconciliation-evidence-run-missing', evidence.reconciliation_evidence_id, 'owning run does not exist'));
        else if (run.autopilot_id !== evidence.autopilot_id)
            findings.push(finding('reconciliation-evidence-owner-mismatch', evidence.reconciliation_evidence_id, 'evidence owner differs from durable run owner'));
        if (expectedConditionBySource[evidence.source] !== evidence.release_condition.condition_type)
            findings.push(finding('reconciliation-source-condition-mismatch', evidence.reconciliation_evidence_id, 'evidence source does not match its typed release condition'));
    }
    for (const message of snapshot.messages) {
        if (!runs.has(runKey(message.repo_id, message.recipient_workstream_run)))
            findings.push(finding('message-recipient-run-missing', message.message_id, 'recipient run does not exist'));
        if (message.status === 'delivered' && message.delivered_event_seq === null)
            findings.push(finding('delivered-message-event-missing', message.message_id, 'delivered message requires delivered_event_seq'));
        if (message.status === 'acknowledged' && (message.delivered_event_seq === null || message.acknowledged_event_seq === null))
            findings.push(finding('acknowledged-message-events-missing', message.message_id, 'acknowledged message requires delivery and acknowledgement events'));
        const cursor = snapshot.mailbox_cursors.find((entry) => entry.repo_id === message.repo_id && entry.workstream_run === message.recipient_workstream_run);
        if (message.status !== 'pending' && cursor !== undefined && message.created_event_seq > cursor.delivered_through_event_seq)
            findings.push(finding('delivered-message-ahead-of-cursor', message.message_id, 'durable delivery cursor does not include the delivered message'));
    }
    for (const worktree of snapshot.worktrees)
        assertOwner(worktree.owner, worktree.worktree_id);
    const incompleteByWorktree = new Map();
    for (const operation of snapshot.worktree_operations) {
        assertOwner(operation.owner, operation.operation_id);
        const worktree = worktrees.get(operation.worktree_id);
        if (worktree === undefined)
            findings.push(finding('operation-worktree-missing', operation.operation_id, 'worktree does not exist'));
        else {
            if (ownerKey(worktree.owner) !== ownerKey(operation.owner))
                findings.push(finding('foreign-worktree-operation', operation.operation_id, 'operation owner differs from worktree owner'));
            if (worktree.canonical_path !== operation.intent.worktree_path || worktree.git_common_dir !== operation.intent.git_common_dir || worktree.branch !== operation.intent.branch)
                findings.push(finding('operation-intent-authority-mismatch', operation.operation_id, 'operation intent disagrees with immutable worktree authority'));
            const expectedAuthorityVersion = operation.stage === 'committed' && worktree.version === operation.authority_version + 1 ? operation.authority_version + 1 : operation.authority_version;
            if (worktree.version !== expectedAuthorityVersion)
                findings.push(finding('operation-authority-version-mismatch', operation.operation_id, 'operation authority version is not fenced to its worktree version'));
        }
        if ((operation.stage === 'verified' || operation.stage === 'committed' || operation.stage === 'compensated' || operation.stage === 'failed') && operation.verification_evidence === null)
            findings.push(finding('operation-verification-missing', operation.operation_id, `${operation.stage} operation requires verification evidence`));
        const requiredOperationSteps = ['preflight-probe', 'external-action', 'postcondition-verification'];
        if ((operation.stage === 'verified' || operation.stage === 'committed') && (operation.completed_steps.length !== requiredOperationSteps.length || requiredOperationSteps.some((step, index) => operation.completed_steps[index] !== step)))
            findings.push(finding('operation-step-plan-incomplete', operation.operation_id, 'verified operation lacks the closed probe/action/verification step plan'));
        if (!['committed', 'compensated', 'failed'].includes(operation.stage)) {
            const prior = incompleteByWorktree.get(operation.worktree_id);
            if (prior !== undefined)
                findings.push(finding('concurrent-worktree-operations', operation.operation_id, `worktree already has incomplete operation ${prior}`));
            else
                incompleteByWorktree.set(operation.worktree_id, operation.operation_id);
        }
        if (operation.operation_type === 'remove' && operation.stage === 'committed' && worktree?.state !== 'removed')
            findings.push(finding('worktree-remove-state-mismatch', operation.operation_id, 'committed remove operation requires removed worktree state'));
    }
    for (const worktree of snapshot.worktrees) {
        if (worktree.state === 'removed' && !snapshot.worktree_operations.some((operation) => operation.worktree_id === worktree.worktree_id && operation.operation_type === 'remove' && operation.stage === 'committed'))
            findings.push(finding('removed-worktree-without-commit', worktree.worktree_id, 'removed worktree state requires a committed remove operation'));
    }
    for (const edge of snapshot.wait_for_edges) {
        const request = snapshot.claim_requests.find((candidate) => candidate.request_id === edge.request_id);
        if (request === undefined)
            findings.push(finding('wait-edge-request-missing', edge.edge_id, 'wait-for edge request does not exist'));
        else {
            if (coordinationOwnerKey(edge.requester) !== coordinationOwnerKey(request.requester) || coordinationOwnerKey(edge.blocker) !== coordinationOwnerKey(request.owner))
                findings.push(finding('wait-edge-owner-mismatch', edge.edge_id, 'wait-for edge owners differ from the durable claim request'));
            const liveBlocker = request.blocking_lease_ids.some((leaseId) => snapshot.edit_leases.some((lease) => lease.edit_lease_id === leaseId));
            if (edge.state === 'active' && !liveBlocker)
                findings.push(finding('active-wait-edge-without-blocker', edge.edge_id, 'active wait edge has no active blocking lease'));
            if (edge.state === 'resolved' && edge.resolved_event_seq === null)
                findings.push(finding('resolved-wait-edge-event-missing', edge.edge_id, 'resolved wait edge requires a terminal event sequence'));
        }
    }
    const activeCycles = detectCoordinationWaitCycles(snapshot.wait_for_edges);
    for (const cycle of activeCycles) {
        const resolution = snapshot.deadlock_resolutions.find((candidate) => candidate.cycle_edge_ids.length === cycle.edge_ids.length && candidate.cycle_edge_ids.every((edgeId) => cycle.edge_ids.includes(edgeId)) && candidate.state !== 'resolved');
        if (resolution === undefined)
            findings.push(finding('wait-cycle-unresolved', cycle.cycle_id, 'every active wait-for cycle requires a typed deadlock resolution'));
    }
    for (const resolution of snapshot.deadlock_resolutions) {
        if (resolution.state === 'deferred-no-safe-victim' && (resolution.victim !== null || resolution.action !== 'none'))
            findings.push(finding('unsafe-deadlock-victim', resolution.resolution_id, 'no-safe-victim deadlock cannot name a preemption action'));
        if (resolution.state === 'awaiting-recovery' && resolution.action !== 'request-reset-or-quarantine')
            findings.push(finding('deadlock-recovery-action-mismatch', resolution.resolution_id, 'awaiting recovery requires reset-or-quarantine action'));
        if (resolution.state === 'resolved' && resolution.resolved_event_seq === null)
            findings.push(finding('deadlock-resolution-event-missing', resolution.resolution_id, 'resolved deadlock requires resolved_event_seq'));
    }
    const artifacts = new Map(snapshot.authoritative_artifacts.map((artifact) => [artifact.artifact_id, artifact]));
    for (const artifact of snapshot.authoritative_artifacts) {
        if (!runs.has(runKey(artifact.repo_id, artifact.source_run)))
            findings.push(finding('authoritative-artifact-run-missing', artifact.artifact_id, 'registering source run does not exist'));
    }
    for (const assignment of snapshot.adjudication_assignments) {
        assertOwner(assignment.adjudicator, assignment.assignment_id);
        if (assignment.participating_runs.includes(assignment.adjudicator.workstream_run))
            findings.push(finding('adjudicator-not-independent', assignment.assignment_id, 'adjudicator run is a participating run'));
        for (const artifactId of assignment.authoritative_artifact_ids)
            if (!artifacts.has(artifactId))
                findings.push(finding('assignment-artifact-missing', assignment.assignment_id, `authoritative artifact ${artifactId} does not exist`));
        if (assignment.state === 'assigned' && (assignment.adjudication !== null || assignment.child_lease_id !== null || assignment.accepted_event_seq !== null))
            findings.push(finding('unaccepted-assignment-has-result', assignment.assignment_id, 'assigned adjudication cannot contain accepted result evidence'));
        if (assignment.state === 'accepted') {
            const child = snapshot.child_leases.find((candidate) => candidate.child_lease_id === assignment.child_lease_id);
            if (assignment.adjudication === null || assignment.accepted_event_seq === null || child === undefined || child.status !== 'terminal' || child.terminal_evidence?.sha256 !== assignment.adjudication.sha256 || ownerKey(child.owner) !== ownerKey(assignment.adjudicator))
                findings.push(finding('accepted-assignment-child-proof-invalid', assignment.assignment_id, 'accepted adjudication requires exact assigned terminal-child evidence'));
        }
    }
    for (const escalation of snapshot.escalations) {
        if (!repositoryIds.has(escalation.repo_id))
            findings.push(finding('escalation-repository-missing', escalation.escalation_id, 'repository does not exist'));
        for (const participatingRun of escalation.participating_runs) {
            if (!runs.has(runKey(escalation.repo_id, participatingRun)))
                findings.push(finding('escalation-run-missing', escalation.escalation_id, `participating run ${participatingRun} does not exist`));
        }
        const assignment = snapshot.adjudication_assignments.find((candidate) => candidate.assignment_id === escalation.escalation_id && candidate.state === 'accepted');
        if (assignment === undefined || assignment.adjudication?.sha256 !== escalation.adjudication.sha256)
            findings.push(finding('escalation-assignment-proof-missing', escalation.escalation_id, 'operator-decision packet requires exact accepted adjudication assignment evidence'));
    }
    const eventsByRepo = new Map();
    for (const event of snapshot.events) {
        if (!repositoryIds.has(event.repo_id))
            findings.push(finding('event-repository-missing', `${event.repo_id}:${String(event.event_seq)}`, 'repository does not exist'));
        const sequences = eventsByRepo.get(event.repo_id) ?? [];
        sequences.push(event.event_seq);
        eventsByRepo.set(event.repo_id, sequences);
        if (event.event_seq > snapshot.repository_event_seq)
            findings.push(finding('event-sequence-ahead-of-snapshot', event.entity_id, `${String(event.event_seq)} exceeds ${String(snapshot.repository_event_seq)}`));
    }
    for (const [repoId, sequences] of eventsByRepo) {
        const ordered = [...sequences].sort((left, right) => left - right);
        for (let index = 1; index < ordered.length; index += 1) {
            const previous = ordered[index - 1];
            const current = ordered[index];
            if (previous !== undefined && current !== undefined && current <= previous)
                findings.push(finding('nonmonotonic-event-sequence', repoId, `${String(previous)} then ${String(current)}`));
        }
    }
    return Object.freeze(findings);
}
export function assertCoordinationInvariants(snapshot) {
    const findings = checkCoordinationInvariants(snapshot).filter((entry) => entry.severity === 'error');
    if (findings.length > 0) {
        throw new CoordinationRuntimeError('invalid-state', 'coordination snapshot violates required invariants', findings.slice(0, 32).map((entry) => `${entry.code}: ${entry.entity}: ${entry.detail}`));
    }
}
