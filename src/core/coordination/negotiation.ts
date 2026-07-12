import { CoordinatorClient } from './client.ts';
import { parseCoordinationAcquisitionGroup, parseCoordinationClaimRequest, parseCoordinationEditLease, parseCoordinationReleaseCondition, parseCoordinationRequestedLease } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { readCoordinatorSessionContext, type CoordinatorSessionContext } from './supervisor.ts';
import type { CoordinationAcquisitionGroup, CoordinationClaimRequest, CoordinationEditLease, CoordinationReleaseCondition, CoordinationRequestedLease, CoordinatorResponseEnvelope } from './types.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../names.ts';
import type { ProcessEnvLike } from '../parallel-runtime.ts';

interface JsonMap {
  readonly [key: string]: unknown;
}

export interface AcquireClaimGroupInput {
  readonly acquisitionGroupId: string;
  readonly unitId: string;
  readonly attempt: number;
  readonly requestedLeases: readonly CoordinationRequestedLease[];
  readonly reason: string;
  readonly normalReleaseCondition: CoordinationReleaseCondition;
  readonly specRef: string;
  readonly specSha256: `sha256:${string}`;
  readonly preemptible: boolean;
  readonly checkpointOrdinal: number;
}

export type ClaimGroupAcquisitionResult =
  | {
      readonly outcome: 'granted';
      readonly acquisitionGroup: CoordinationAcquisitionGroup;
      readonly editLeases: readonly CoordinationEditLease[];
      readonly requestRefs: readonly string[];
      readonly committedEventSeq: number;
    }
  | {
      readonly outcome: 'waiting-for-peer-release';
      readonly acquisitionGroup: CoordinationAcquisitionGroup;
      readonly claimRequests: readonly CoordinationClaimRequest[];
      readonly requestRefs: readonly string[];
      readonly committedEventSeq: number;
    };

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `${label} is not an object`);
  return value as JsonMap;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new CoordinationRuntimeError('invalid-state', `${label} is not a string array`);
  return Object.freeze([...value]);
}

function committedSequence(response: CoordinatorResponseEnvelope): number {
  if (response.committed_event_seq === null) throw new CoordinationRuntimeError('invalid-state', 'coordinator mutation omitted committed event sequence');
  return response.committed_event_seq;
}

function parseEntityArray<T>(value: unknown, label: string, parser: (entry: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `${label} is not an array`);
  return Object.freeze(value.map(parser));
}

export class ClaimNegotiationClient {
  readonly #client: CoordinatorClient;
  readonly #session: CoordinatorSessionContext;

  constructor(client: CoordinatorClient, session: CoordinatorSessionContext) {
    this.#client = client;
    this.#session = session;
  }

  static async fromEnvironment(env: ProcessEnvLike = process.env): Promise<ClaimNegotiationClient> {
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for claim negotiation`);
    const session = await readCoordinatorSessionContext(contextPath);
    return new ClaimNegotiationClient(new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }), session);
  }

  async acquire(input: AcquireClaimGroupInput): Promise<ClaimGroupAcquisitionResult> {
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
      if (current === undefined) throw new CoordinationRuntimeError('invalid-state', 'acquisition group disappeared after a durable acquire response');
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

  async acknowledgeGrant(group: CoordinationAcquisitionGroup): Promise<{ readonly acquisitionGroup: CoordinationAcquisitionGroup; readonly editLeases: readonly CoordinationEditLease[]; readonly committedEventSeq: number }> {
    const response = await this.#client.mutate('acknowledge-grant', this.#identity(group.version, `acknowledge-grant:${group.acquisition_group_id}:${String(group.version)}`), {
      acquisition_group_id: group.acquisition_group_id,
      ...this.#sessionProof(),
    });
    if (response.payload['outcome'] === 'offer-expired') throw new CoordinationRuntimeError('stale-version', 'grant offer expired and was requeued by the coordinator');
    if (response.payload['outcome'] !== 'granted') throw new CoordinationRuntimeError('invalid-state', 'coordinator returned an unsupported grant acknowledgement outcome');
    return {
      acquisitionGroup: parseCoordinationAcquisitionGroup(response.payload['acquisition_group']),
      editLeases: parseEntityArray(response.payload['edit_leases'], 'acknowledge-grant edit_leases', parseCoordinationEditLease),
      committedEventSeq: committedSequence(response),
    };
  }

  async respond(input: { readonly request: CoordinationClaimRequest; readonly response: 'release-now' | 'deferred'; readonly ownerReason: string; readonly releaseCondition: CoordinationReleaseCondition | null }): Promise<CoordinationClaimRequest> {
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

  async cancel(input: { readonly request: CoordinationClaimRequest; readonly reason: string }): Promise<CoordinationAcquisitionGroup> {
    const response = await this.#client.mutate('cancel-claim-request', this.#identity(input.request.version, `cancel-claim-request:${input.request.request_id}`), {
      request_id: input.request.request_id,
      reason: input.reason,
      ...this.#sessionProof(),
    });
    return parseCoordinationAcquisitionGroup(response.payload['acquisition_group']);
  }

  async cancelGroup(input: { readonly group: CoordinationAcquisitionGroup; readonly reason: string }): Promise<CoordinationAcquisitionGroup> {
    const response = await this.#client.mutate('cancel-acquisition-group', this.#identity(input.group.version, `cancel-acquisition-group:${input.group.acquisition_group_id}`), {
      acquisition_group_id: input.group.acquisition_group_id,
      reason: input.reason,
      ...this.#sessionProof(),
    });
    return parseCoordinationAcquisitionGroup(response.payload['acquisition_group']);
  }

  async supersede(input: { readonly unitId: string; readonly attempt: number; readonly attemptVersion: number; readonly supersededByAttempt: number; readonly reason: string }): Promise<void> {
    await this.#client.mutate('supersede-attempt', this.#identity(input.attemptVersion, `supersede-attempt:${this.#session.workstream_run}:${input.unitId}:${String(input.attempt)}`), {
      unit_id: input.unitId,
      attempt: input.attempt,
      superseded_by_attempt: input.supersededByAttempt,
      reason: input.reason,
      ...this.#sessionProof(),
    });
  }

  #identity(expectedVersion: number, idempotencyKey: string) {
    return {
      repoId: this.#session.repo_id,
      workstreamRun: this.#session.workstream_run,
      sessionId: this.#session.session_id,
      fencingGeneration: this.#session.session_generation,
      expectedVersion,
      idempotencyKey,
    };
  }

  #sessionProof(): { readonly session_lease_id: string; readonly session_token: string } {
    return { session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token };
  }
}
