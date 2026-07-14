import { CoordinatorClient } from './client.ts';
import { parseCoordinationAcquisitionGroup, parseCoordinationClaimRequest, parseCoordinationEditLease, parseCoordinationObservation, parseCoordinationReleaseCondition, parseCoordinationRequestedLease } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { readCoordinatorSessionContext, type CoordinatorSessionContext } from './supervisor.ts';
import type { CoordinationAcquisitionGroup, CoordinationClaimRequest, CoordinationEditLease, CoordinationObservation, CoordinationReleaseCondition, CoordinationRequestedLease, CoordinatorResponseEnvelope } from './types.ts';
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
  readonly acquisitionKind?: 'initial' | 'materialization-read-expansion';
  readonly reason: string;
  readonly normalReleaseCondition: CoordinationReleaseCondition;
  readonly specRef: string;
  readonly specSha256: `sha256:${string}`;
  readonly role: 'strategy' | 'implement' | 'validate' | 'fix' | 'adjudicate' | 'bughunt' | 'extract';
  readonly preemptible: boolean;
  readonly checkpointOrdinal: number;
}

export type ClaimGroupAcquisitionResult =
  | {
      readonly outcome: 'granted';
      readonly acquisitionGroup: CoordinationAcquisitionGroup;
      readonly observations: readonly CoordinationObservation[];
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

function assertCompleteGrantedAuthority(group: CoordinationAcquisitionGroup, observations: readonly CoordinationObservation[], editLeases: readonly CoordinationEditLease[]): void {
  const evidence: string[] = [];
  for (const requested of group.requested_leases) {
    if (requested.mode === 'READ') {
      const matching = observations.filter((observation) => observation.path === requested.path && observation.purpose === requested.purpose && observation.execution_state === 'active' && observation.freshness === 'current' && requested.source_identity !== undefined && observation.source_identity.base_commit === requested.source_identity.base_commit && observation.source_identity.object_id === requested.source_identity.object_id && observation.source_identity.object_kind === requested.source_identity.object_kind);
      if (matching.length !== 1) evidence.push(`READ ${requested.path}:observations=${String(matching.length)}:source=${requested.source_identity === undefined ? 'unbound' : 'bound'}`);
    } else {
      const matching = editLeases.filter((lease) => lease.path === requested.path && lease.mode === requested.mode && lease.purpose === requested.purpose && JSON.stringify(lease.exclusive_operation) === JSON.stringify(requested.exclusive_operation));
      if (matching.length !== 1) evidence.push(`${requested.mode} ${requested.path}:leases=${String(matching.length)}`);
    }
  }
  if (observations.length + editLeases.length !== group.requested_leases.length) evidence.push(`cardinality=${String(observations.length + editLeases.length)}/${String(group.requested_leases.length)}`);
  if (evidence.length > 0) throw new CoordinationRuntimeError('recovery-required', 'granted acquisition lacks its exact immutable observation/edit authority set; dispatch requires a new revalidated attempt', evidence);
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
    if ((input.acquisitionKind ?? 'initial') === 'initial') {
      const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
      const groups = parseEntityArray(status.payload['acquisition_groups'], 'status acquisition_groups', parseCoordinationAcquisitionGroup);
      const rebound = groups.find((group) => group.acquisition_kind === 'legacy-unknown' && group.state === 'granted' && group.owner.autopilot_id === this.#session.autopilot_id && group.owner.workstream_run === this.#session.workstream_run && group.owner.unit_id === input.unitId && group.owner.attempt === input.attempt && sameRequestedAuthority(group.requested_leases, requestedLeases));
      if (rebound !== undefined) {
        await this.#client.mutate('reconcile-run', this.#identity(this.#session.run_version, `reconcile-migrated-authority:${this.#session.session_lease_id}:${rebound.acquisition_group_id}`), { reason: 'validate current generation before migrated authority reuse', ...this.#sessionProof() });
        const verifiedStatus = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
        const verifiedGroups = parseEntityArray(verifiedStatus.payload['acquisition_groups'], 'verified status acquisition_groups', parseCoordinationAcquisitionGroup);
        const verified = verifiedGroups.find((group) => group.acquisition_group_id === rebound.acquisition_group_id && group.state === 'granted');
        if (verified !== undefined) {
          const observations = parseEntityArray(verifiedStatus.payload['observations'], 'verified status observations', parseCoordinationObservation).filter((observation) => observation.acquisition_group_id === verified.acquisition_group_id && observation.execution_state === 'active');
          const editLeases = parseEntityArray(verifiedStatus.payload['edit_leases'], 'verified status edit_leases', parseCoordinationEditLease).filter((lease) => lease.acquisition_group_id === verified.acquisition_group_id);
          if (verified.grant_event_seq === null) throw new CoordinationRuntimeError('invalid-state', 'migrated granted acquisition lacks its grant event');
          assertCompleteGrantedAuthority(verified, observations, editLeases);
          return { outcome: 'granted', acquisitionGroup: verified, observations, editLeases, requestRefs: [], committedEventSeq: verified.grant_event_seq };
        }
        throw new CoordinationRuntimeError('recovery-required', 'migrated authority became terminal during current-generation reconciliation; dispatch is refused');
      }
    }
    const response = await this.#client.mutate('acquire-group', this.#identity(this.#session.run_version, `acquire-group:${input.acquisitionGroupId}`), {
      acquisition_group_id: input.acquisitionGroupId,
      unit_id: input.unitId,
      attempt: input.attempt,
      requested_leases: requestedLeases,
      acquisition_kind: input.acquisitionKind ?? 'initial',
      reason: input.reason,
      normal_release_condition: normalReleaseCondition,
      spec_ref: input.specRef,
      spec_sha256: input.specSha256,
      role: input.role,
      preemptible: input.preemptible,
      checkpoint_ordinal: input.checkpointOrdinal,
      ...this.#sessionProof(),
    });
    const payload = record(response.payload, 'acquire-group response');
    const acquisitionGroup = parseCoordinationAcquisitionGroup(payload['acquisition_group']);
    const requestRefs = stringArray(payload['request_refs'], 'acquire-group request_refs');
    if (payload['outcome'] === 'granted') {
      const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
      const observations = parseEntityArray(status.payload['observations'], 'status observations', parseCoordinationObservation).filter((observation) => observation.acquisition_group_id === acquisitionGroup.acquisition_group_id && observation.execution_state === 'active');
      const editLeases = parseEntityArray(status.payload['edit_leases'], 'status edit_leases', parseCoordinationEditLease).filter((lease) => lease.acquisition_group_id === acquisitionGroup.acquisition_group_id);
      assertCompleteGrantedAuthority(acquisitionGroup, observations, editLeases);
      return { outcome: 'granted', acquisitionGroup, observations, editLeases, requestRefs, committedEventSeq: committedSequence(response) };
    }
    if (payload['outcome'] === 'waiting-for-peer-release') {
      const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
      const groups = parseEntityArray(status.payload['acquisition_groups'], 'status acquisition_groups', parseCoordinationAcquisitionGroup);
      const current = groups.find((group) => group.acquisition_group_id === acquisitionGroup.acquisition_group_id);
      if (current === undefined) throw new CoordinationRuntimeError('invalid-state', 'acquisition group disappeared after a durable acquire response');
      if (current.state === 'grant-ready') {
        const granted = await this.acknowledgeGrant(current);
        return { outcome: 'granted', acquisitionGroup: granted.acquisitionGroup, observations: granted.observations, editLeases: granted.editLeases, requestRefs, committedEventSeq: granted.committedEventSeq };
      }
      if (current.state === 'granted') {
        const observations = parseEntityArray(status.payload['observations'], 'status observations', parseCoordinationObservation).filter((observation) => observation.acquisition_group_id === current.acquisition_group_id && observation.execution_state === 'active');
        const leases = parseEntityArray(status.payload['edit_leases'], 'status edit_leases', parseCoordinationEditLease).filter((lease) => lease.acquisition_group_id === current.acquisition_group_id);
        assertCompleteGrantedAuthority(current, observations, leases);
        return { outcome: 'granted', acquisitionGroup: current, observations, editLeases: leases, requestRefs, committedEventSeq: committedSequence(response) };
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

  async acknowledgeGrant(group: CoordinationAcquisitionGroup): Promise<{ readonly acquisitionGroup: CoordinationAcquisitionGroup; readonly observations: readonly CoordinationObservation[]; readonly editLeases: readonly CoordinationEditLease[]; readonly committedEventSeq: number }> {
    const response = await this.#client.mutate('acknowledge-grant', this.#identity(group.version, `acknowledge-grant:${group.acquisition_group_id}:${String(group.version)}`), {
      acquisition_group_id: group.acquisition_group_id,
      ...this.#sessionProof(),
    });
    if (response.payload['outcome'] === 'offer-expired') throw new CoordinationRuntimeError('stale-version', 'grant offer expired and was requeued by the coordinator');
    if (response.payload['outcome'] !== 'granted') throw new CoordinationRuntimeError('invalid-state', 'coordinator returned an unsupported grant acknowledgement outcome');
    const acquisitionGroup = parseCoordinationAcquisitionGroup(response.payload['acquisition_group']);
    const observations = parseEntityArray(response.payload['observations'], 'acknowledge-grant observations', parseCoordinationObservation);
    const editLeases = parseEntityArray(response.payload['edit_leases'], 'acknowledge-grant edit_leases', parseCoordinationEditLease);
    assertCompleteGrantedAuthority(acquisitionGroup, observations, editLeases);
    return { acquisitionGroup, observations, editLeases, committedEventSeq: committedSequence(response) };
  }

  async respondById(input: { readonly requestId: string; readonly response: 'release-now' | 'deferred'; readonly ownerReason: string; readonly releaseCondition: CoordinationReleaseCondition | null }): Promise<CoordinationClaimRequest> {
    const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
    const requests = parseEntityArray(status.payload['claim_requests'], 'status claim_requests', parseCoordinationClaimRequest);
    const request = requests.find((candidate) => candidate.request_id === input.requestId);
    if (request === undefined) throw new CoordinationRuntimeError('invalid-request', `claim request ${input.requestId} is not visible to the attached owner run`);
    if (request.owner.repo_id !== this.#session.repo_id || request.owner.autopilot_id !== this.#session.autopilot_id || request.owner.workstream_run !== this.#session.workstream_run) throw new CoordinationRuntimeError('unauthorized-client', 'attached session is not the durable owner of the claim request');
    return await this.respond({ request, response: input.response, ownerReason: input.ownerReason, releaseCondition: input.releaseCondition });
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

function sameRequestedAuthority(left: readonly CoordinationRequestedLease[], right: readonly CoordinationRequestedLease[]): boolean {
  const identity = (lease: CoordinationRequestedLease): string => `${lease.mode}\0${lease.path}\0${lease.purpose}\0${JSON.stringify(lease.source_identity)}\0${JSON.stringify(lease.exclusive_operation)}`;
  const leftSet = [...new Set(left.map(identity))].sort();
  const rightSet = [...new Set(right.map(identity))].sort();
  return leftSet.length === rightSet.length && leftSet.every((value, index) => value === rightSet[index]);
}
