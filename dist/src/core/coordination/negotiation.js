import { CoordinatorClient } from "./client.js";
import { parseCoordinationAcquisitionGroup, parseCoordinationClaimRequest, parseCoordinationEditLease, parseCoordinationReleaseCondition, parseCoordinationRequestedLease } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { readCoordinatorSessionContext } from "./supervisor.js";
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
function committedSequence(response) {
    if (response.committed_event_seq === null)
        throw new CoordinationRuntimeError('invalid-state', 'coordinator mutation omitted committed event sequence');
    return response.committed_event_seq;
}
function parseEntityArray(value, label, parser) {
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not an array`);
    return Object.freeze(value.map(parser));
}
export class ClaimNegotiationClient {
    #client;
    #session;
    constructor(client, session) {
        this.#client = client;
        this.#session = session;
    }
    static async fromEnvironment(env = process.env) {
        const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        if (contextPath === undefined || contextPath.trim().length === 0)
            throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for claim negotiation`);
        const session = await readCoordinatorSessionContext(contextPath);
        return new ClaimNegotiationClient(new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }), session);
    }
    async acquire(input) {
        const requestedLeases = Object.freeze(input.requestedLeases.map((entry) => parseCoordinationRequestedLease(entry)));
        const normalReleaseCondition = parseCoordinationReleaseCondition(input.normalReleaseCondition);
        const response = await this.#client.mutate('acquire-group', this.#identity(this.#session.run_version, `acquire-group:${input.acquisitionGroupId}`), {
            acquisition_group_id: input.acquisitionGroupId,
            unit_id: input.unitId,
            attempt: input.attempt,
            requested_leases: requestedLeases,
            reason: input.reason,
            normal_release_condition: normalReleaseCondition,
            spec_ref: input.specRef,
            spec_sha256: input.specSha256,
            preemptible: input.preemptible,
            checkpoint_ordinal: input.checkpointOrdinal,
            ...this.#sessionProof(),
        });
        const payload = record(response.payload, 'acquire-group response');
        const acquisitionGroup = parseCoordinationAcquisitionGroup(payload['acquisition_group']);
        const requestRefs = stringArray(payload['request_refs'], 'acquire-group request_refs');
        if (payload['outcome'] === 'granted') {
            return {
                outcome: 'granted', acquisitionGroup,
                editLeases: parseEntityArray(payload['edit_leases'], 'acquire-group edit_leases', parseCoordinationEditLease),
                requestRefs, committedEventSeq: committedSequence(response),
            };
        }
        if (payload['outcome'] === 'waiting-for-peer-release') {
            const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
            const groups = parseEntityArray(status.payload['acquisition_groups'], 'status acquisition_groups', parseCoordinationAcquisitionGroup);
            const current = groups.find((group) => group.acquisition_group_id === acquisitionGroup.acquisition_group_id);
            if (current === undefined)
                throw new CoordinationRuntimeError('invalid-state', 'acquisition group disappeared after a durable acquire response');
            if (current.state === 'grant-ready') {
                const granted = await this.acknowledgeGrant(current);
                return { outcome: 'granted', acquisitionGroup: granted.acquisitionGroup, editLeases: granted.editLeases, requestRefs, committedEventSeq: granted.committedEventSeq };
            }
            if (current.state === 'granted') {
                const leases = parseEntityArray(status.payload['edit_leases'], 'status edit_leases', parseCoordinationEditLease).filter((lease) => lease.acquisition_group_id === current.acquisition_group_id);
                return { outcome: 'granted', acquisitionGroup: current, editLeases: leases, requestRefs, committedEventSeq: committedSequence(response) };
            }
            const currentRequests = parseEntityArray(status.payload['claim_requests'], 'status claim_requests', parseCoordinationClaimRequest).filter((claimRequest) => claimRequest.acquisition_group_id === current.acquisition_group_id);
            return {
                outcome: 'waiting-for-peer-release', acquisitionGroup: current,
                claimRequests: currentRequests,
                requestRefs: currentRequests.map((claimRequest) => claimRequest.request_id), committedEventSeq: committedSequence(response),
            };
        }
        throw new CoordinationRuntimeError('invalid-state', 'coordinator returned an unsupported acquisition outcome');
    }
    async acknowledgeGrant(group) {
        const response = await this.#client.mutate('acknowledge-grant', this.#identity(group.version, `acknowledge-grant:${group.acquisition_group_id}:${String(group.version)}`), {
            acquisition_group_id: group.acquisition_group_id,
            ...this.#sessionProof(),
        });
        if (response.payload['outcome'] === 'offer-expired')
            throw new CoordinationRuntimeError('stale-version', 'grant offer expired and was requeued by the coordinator');
        if (response.payload['outcome'] !== 'granted')
            throw new CoordinationRuntimeError('invalid-state', 'coordinator returned an unsupported grant acknowledgement outcome');
        return {
            acquisitionGroup: parseCoordinationAcquisitionGroup(response.payload['acquisition_group']),
            editLeases: parseEntityArray(response.payload['edit_leases'], 'acknowledge-grant edit_leases', parseCoordinationEditLease),
            committedEventSeq: committedSequence(response),
        };
    }
    async respond(input) {
        const condition = input.releaseCondition === null ? null : parseCoordinationReleaseCondition(input.releaseCondition);
        const response = await this.#client.mutate('respond-claim-request', this.#identity(input.request.version, `respond-claim-request:${input.request.request_id}:${String(input.request.version)}:${input.response}`), {
            request_id: input.request.request_id,
            response: input.response,
            owner_reason: input.ownerReason,
            release_condition: condition,
            ...this.#sessionProof(),
        });
        return parseCoordinationClaimRequest(response.payload['claim_request']);
    }
    async cancel(input) {
        const response = await this.#client.mutate('cancel-claim-request', this.#identity(input.request.version, `cancel-claim-request:${input.request.request_id}`), {
            request_id: input.request.request_id,
            reason: input.reason,
            ...this.#sessionProof(),
        });
        return parseCoordinationAcquisitionGroup(response.payload['acquisition_group']);
    }
    async cancelGroup(input) {
        const response = await this.#client.mutate('cancel-acquisition-group', this.#identity(input.group.version, `cancel-acquisition-group:${input.group.acquisition_group_id}`), {
            acquisition_group_id: input.group.acquisition_group_id,
            reason: input.reason,
            ...this.#sessionProof(),
        });
        return parseCoordinationAcquisitionGroup(response.payload['acquisition_group']);
    }
    async supersede(input) {
        await this.#client.mutate('supersede-attempt', this.#identity(input.attemptVersion, `supersede-attempt:${this.#session.workstream_run}:${input.unitId}:${String(input.attempt)}`), {
            unit_id: input.unitId,
            attempt: input.attempt,
            superseded_by_attempt: input.supersededByAttempt,
            reason: input.reason,
            ...this.#sessionProof(),
        });
    }
    #identity(expectedVersion, idempotencyKey) {
        return {
            repoId: this.#session.repo_id,
            workstreamRun: this.#session.workstream_run,
            sessionId: this.#session.session_id,
            fencingGeneration: this.#session.session_generation,
            expectedVersion,
            idempotencyKey,
        };
    }
    #sessionProof() {
        return { session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token };
    }
}
