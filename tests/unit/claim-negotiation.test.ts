import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { parseCoordinationAcquisitionGroup, parseCoordinationClaimRequest, parseCoordinationMessage, parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths, COORDINATOR_GRANT_OFFER_TTL_MS } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import type { CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import type { CoordinationClaimRequest, CoordinationMessage, CoordinationReleaseCondition } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

interface Actor {
  readonly context: CoordinatorSessionContext;
  readonly negotiation: ClaimNegotiationClient;
}

interface JsonMap {
  readonly [key: string]: unknown;
}

const RELEASE_CONDITION: CoordinationReleaseCondition = { condition_type: 'unit-merged', target_id: 'unit:1', evidence: null };

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonMap;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

async function attachActor(client: CoordinatorClient, stateRoot: string, suffix: string, generation = 1, repoId = 'repo-negotiation'): Promise<Actor> {
  const workstreamRun = `run-${suffix}`;
  const runResponse = await client.mutate('attach-run', {
    repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}`,
  }, {
    repo_key: repoId, canonical_root: `/tmp/generic-negotiation-repository-${repoId}`, git_common_dir: `/tmp/generic-negotiation-repository-${repoId}/.git`, autopilot_id: `autopilot-${suffix}`, workstream: `workstream-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1',
  });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const token = suffix.charCodeAt(0).toString(16).slice(-1).repeat(64);
  const sessionResponse = await client.mutate('attach-session', {
    repoId, workstreamRun, sessionId: `session-${suffix}`, fencingGeneration: generation, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}`,
  }, {
    session_lease_id: `lease-session-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  const context: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId,
    autopilot_id: attachedRun.autopilot_id, workstream: attachedRun.workstream, workstream_run: attachedRun.workstream_run,
    session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
    session_lease_id: session.session_lease_id, session_token: token, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  };
  return { context, negotiation: new ClaimNegotiationClient(client, context) };
}

async function replaceActor(client: CoordinatorClient, actor: Actor, suffix: string): Promise<Actor> {
  const status = await client.query('status', actor.context.repo_id, actor.context.workstream_run);
  const runs = array(status.payload['runs'], 'runs');
  if (runs.length !== 1) throw new Error('replacement requires exactly one run');
  const run = parseCoordinationRun(runs[0]);
  const generation = run.active_session_generation + 1;
  const token = suffix.charCodeAt(0).toString(16).slice(-1).repeat(64);
  const response = await client.mutate('attach-session', {
    repoId: run.repo_id, workstreamRun: run.workstream_run, sessionId: `session-${suffix}`, fencingGeneration: generation,
    expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}`,
  }, { session_lease_id: `lease-session-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
  const attachedRun = parseCoordinationRun(response.payload['run']);
  const session = parseCoordinationSessionLease(response.payload['session']);
  const context: CoordinatorSessionContext = {
    ...actor.context, session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
    session_lease_id: session.session_lease_id, session_token: token, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  };
  return { context, negotiation: new ClaimNegotiationClient(client, context) };
}

function acquisitionInput(suffix: string) {
  return {
    acquisitionGroupId: `group-${suffix}`, unitId: `unit-${suffix}`, attempt: 1,
    requestedLeases: [{ path: 'src/shared.ts', mode: 'WRITE' as const, purpose: `implement ${suffix}` }],
    reason: `workstream ${suffix} requires shared source`, normalReleaseCondition: { ...RELEASE_CONDITION, target_id: `unit-${suffix}:1` },
    specRef: `.pi/autopilot/workstream-${suffix}/unit-specs/unit-${suffix}.json`, specSha256: `sha256:${suffix.charCodeAt(0).toString(16).slice(-1).repeat(64)}` as `sha256:${string}`,
    role: 'implement' as const, preemptible: true, checkpointOrdinal: 0,
  };
}

async function claimRequests(client: CoordinatorClient, actor: Actor): Promise<readonly CoordinationClaimRequest[]> {
  const status = await client.query('status', actor.context.repo_id, actor.context.workstream_run);
  return array(status.payload['claim_requests'], 'claim_requests').map((entry) => parseCoordinationClaimRequest(entry));
}

async function groups(client: CoordinatorClient, actor: Actor) {
  const status = await client.query('status', actor.context.repo_id, actor.context.workstream_run);
  return array(status.payload['acquisition_groups'], 'acquisition_groups').map((entry) => parseCoordinationAcquisitionGroup(entry));
}

async function drain(client: CoordinatorClient, actor: Actor, delivery: string): Promise<readonly CoordinationMessage[]> {
  const response = await client.mutate('drain-mailbox', {
    repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id,
    fencingGeneration: actor.context.session_generation, expectedVersion: actor.context.session_version, idempotencyKey: `drain-${delivery}`,
  }, { delivery_id: delivery, session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token });
  return array(response.payload['messages'], 'messages').map((entry) => parseCoordinationMessage(entry));
}

async function acknowledge(client: CoordinatorClient, actor: Actor, message: CoordinationMessage): Promise<void> {
  await client.mutate('acknowledge-message', {
    repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id,
    fencingGeneration: actor.context.session_generation, expectedVersion: message.version, idempotencyKey: `ack-${message.message_id}`,
  }, { message_id: message.message_id, session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token });
}

void describe('Coordination Fabric claim negotiation', () => {
  void it('completes conflict, durable defer, atomic release notification, offer acknowledgement, and exact grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-negotiation-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const owner = await attachActor(client, stateRoot, 'a');
      const requester = await attachActor(client, stateRoot, 'b');
      const ownerInput = acquisitionInput('a');
      const ownerCompleteInput = { ...ownerInput, requestedLeases: [...ownerInput.requestedLeases, { path: 'src/owner-private.ts', mode: 'WRITE' as const, purpose: 'retain unrelated owner authority' }] };
      const ownerGrant = await owner.negotiation.acquire(ownerCompleteInput);
      assert.equal(ownerGrant.outcome, 'granted');
      const duplicateOwnerGrant = await owner.negotiation.acquire(ownerCompleteInput);
      assert.equal(duplicateOwnerGrant.committedEventSeq, ownerGrant.committedEventSeq);
      await assert.rejects(
        () => owner.negotiation.acquire({ ...ownerCompleteInput, acquisitionGroupId: 'group-a-duplicate-intent' }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-state',
      );
      const replacementOwner = await replaceActor(client, owner, 'a2');
      const handoffReplay = await replacementOwner.negotiation.acquire(ownerCompleteInput);
      assert.equal(handoffReplay.committedEventSeq, ownerGrant.committedEventSeq);
      await assert.rejects(
        () => owner.negotiation.acquire(ownerCompleteInput),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'fenced-session',
      );
      const requesterInput = acquisitionInput('b');
      const waiting = await requester.negotiation.acquire({ ...requesterInput, requestedLeases: [...requesterInput.requestedLeases, { path: 'src/requester-only.ts', mode: 'WRITE', purpose: 'prove atomic complete-set grant' }] });
      assert.equal(waiting.outcome, 'waiting-for-peer-release');
      if (waiting.outcome !== 'waiting-for-peer-release') throw new Error('requester unexpectedly granted');
      assert.equal(waiting.claimRequests.length, 1);
      assert.deepEqual(waiting.requestRefs, [waiting.claimRequests[0]?.request_id]);
      const blockedStatus = await client.query('status', requester.context.repo_id, requester.context.workstream_run);
      assert.equal(array(blockedStatus.payload['edit_leases'], 'blocked requester leases').length, 0);

      const ownerInbox = await drain(client, replacementOwner, 'delivery-owner');
      assert.equal(ownerInbox.length, 1);
      assert.equal(ownerInbox[0]?.message_type, 'claim-request');
      const ownerMessage = ownerInbox[0];
      if (ownerMessage === undefined) throw new Error('missing owner claim request');
      await acknowledge(client, replacementOwner, ownerMessage);
      const acknowledged = (await claimRequests(client, replacementOwner)).find((entry) => entry.request_id === waiting.claimRequests[0]?.request_id);
      if (acknowledged === undefined) throw new Error('missing acknowledged request');
      assert.equal(acknowledged.status, 'acknowledged');
      await assert.rejects(
        () => replacementOwner.negotiation.respond({ request: acknowledged, response: 'deferred', ownerReason: 'invalid unrelated promise', releaseCondition: { condition_type: 'unit-merged', target_id: 'unrelated-unit:9', evidence: null } }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-request',
      );

      const deferred = await replacementOwner.negotiation.respond({ request: acknowledged, response: 'deferred', ownerReason: 'owner unit is still running', releaseCondition: { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null } });
      assert.equal(deferred.status, 'deferred');
      assert.equal(deferred.owner_reason, 'owner unit is still running');
      assert.equal(deferred.release_condition?.condition_type, 'unit-merged');
      const duplicateDeferred = await replacementOwner.negotiation.respond({ request: acknowledged, response: 'deferred', ownerReason: 'owner unit is still running', releaseCondition: { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null } });
      assert.equal(duplicateDeferred.version, deferred.version);
      await assert.rejects(
        () => replacementOwner.negotiation.respond({ request: acknowledged, response: 'release-now', ownerReason: 'stale reorder', releaseCondition: null }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'stale-version',
      );

      const currentDeferred = (await claimRequests(client, replacementOwner)).find((entry) => entry.request_id === deferred.request_id);
      if (currentDeferred === undefined) throw new Error('missing deferred request');
      const released = await replacementOwner.negotiation.respond({ request: currentDeferred, response: 'release-now', ownerReason: 'typed release condition is now satisfied', releaseCondition: null });
      assert.equal(released.status, 'grant-ready');
      const requesterInbox = await drain(client, requester, 'delivery-requester');
      assert.deepEqual(requesterInbox.map((entry) => entry.message_type).sort(), ['grant-offer', 'release-notification']);
      const releaseMessage = requesterInbox.find((entry) => entry.message_type === 'release-notification');
      if (releaseMessage === undefined) throw new Error('missing release notification');
      assert.equal(releaseMessage.created_event_seq, released.release_event_seq);

      const offered = (await groups(client, requester)).find((entry) => entry.acquisition_group_id === 'group-b');
      if (offered === undefined) throw new Error('missing grant-ready group');
      assert.equal(offered.state, 'grant-ready');
      const requesterGrant = await requester.negotiation.acknowledgeGrant(offered);
      assert.equal(requesterGrant.acquisitionGroup.state, 'granted');
      assert.deepEqual(requesterGrant.editLeases.map((entry) => `${entry.mode} ${entry.path}`), ['WRITE src/shared.ts', 'WRITE src/requester-only.ts']);
      const ownerStatus = await client.query('status', owner.context.repo_id, owner.context.workstream_run);
      const requesterStatus = await client.query('status', requester.context.repo_id, requester.context.workstream_run);
      const retainedOwnerLeases = array(ownerStatus.payload['edit_leases'], 'owner leases');
      assert.equal(retainedOwnerLeases.length, 1);
      assert.equal(record(retainedOwnerLeases[0], 'retained owner lease')['path'], 'src/owner-private.ts');
      assert.equal(array(requesterStatus.payload['edit_leases'], 'requester leases').length, 2);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('orders whole-group offers fairly, keeps other waiters queued, and supports cancellation and supersession', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-negotiation-fair-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const owner = await attachActor(client, stateRoot, 'a');
      const first = await attachActor(client, stateRoot, 'b');
      const second = await attachActor(client, stateRoot, 'c');
      const third = await attachActor(client, stateRoot, 'd');
      await owner.negotiation.acquire(acquisitionInput('a'));
      const firstWait = await first.negotiation.acquire(acquisitionInput('b'));
      const secondWait = await second.negotiation.acquire(acquisitionInput('c'));
      assert.equal(firstWait.outcome, 'waiting-for-peer-release');
      assert.equal(secondWait.outcome, 'waiting-for-peer-release');
      if (firstWait.outcome !== 'waiting-for-peer-release') throw new Error('first waiter unexpectedly granted');
      const releaseRequest = (await claimRequests(client, owner)).find((entry) => entry.acquisition_group_id === 'group-b');
      if (releaseRequest === undefined) throw new Error('missing first release request');
      await owner.negotiation.respond({ request: releaseRequest, response: 'release-now', ownerReason: 'owner no longer needs shared path', releaseCondition: null });
      const firstGroup = (await groups(client, first))[0];
      const secondGroup = (await groups(client, second))[0];
      assert.equal(firstGroup?.state, 'grant-ready');
      assert.equal(secondGroup?.state, 'waiting');
      if (firstGroup === undefined) throw new Error('missing first group');
      await first.negotiation.acknowledgeGrant(firstGroup);
      const secondRequests = await claimRequests(client, second);
      const requestBlockedByFirst = secondRequests.find((entry) => entry.owner.workstream_run === first.context.workstream_run && !['resolved', 'cancelled', 'superseded'].includes(entry.status));
      if (requestBlockedByFirst === undefined) throw new Error('second waiter did not receive a correlated request to the successful acquirer');
      const cancelled = await second.negotiation.cancel({ request: requestBlockedByFirst, reason: 'requester replanned to a disjoint artifact' });
      assert.equal(cancelled.state, 'cancelled');
      const duplicateCancellation = await second.negotiation.cancel({ request: requestBlockedByFirst, reason: 'requester replanned to a disjoint artifact' });
      assert.equal(duplicateCancellation.version, cancelled.version);

      const thirdWait = await third.negotiation.acquire(acquisitionInput('d'));
      assert.equal(thirdWait.outcome, 'waiting-for-peer-release');
      await third.negotiation.supersede({ unitId: 'unit-d', attempt: 1, attemptVersion: 1, supersededByAttempt: 2, reason: 'attempt replaced by a corrected unit spec' });
      await third.negotiation.supersede({ unitId: 'unit-d', attempt: 1, attemptVersion: 1, supersededByAttempt: 2, reason: 'attempt replaced by a corrected unit spec' });
      const thirdGroup = (await groups(client, third))[0];
      assert.equal(thirdGroup?.state, 'superseded');
      assert.equal((await claimRequests(client, third)).every((entry) => entry.status === 'superseded'), true);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('isolates identical acquisition-group ids and paths across repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-negotiation-repositories-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const firstRepo = await attachActor(client, stateRoot, 'x', 1, 'repo-negotiation-one');
      const secondRepo = await attachActor(client, stateRoot, 'y', 1, 'repo-negotiation-two');
      const first = await firstRepo.negotiation.acquire({ ...acquisitionInput('x'), acquisitionGroupId: 'group-shared-id' });
      const second = await secondRepo.negotiation.acquire({ ...acquisitionInput('y'), acquisitionGroupId: 'group-shared-id' });
      assert.equal(first.outcome, 'granted');
      assert.equal(second.outcome, 'granted');
      const firstStatus = await client.query('status', firstRepo.context.repo_id, firstRepo.context.workstream_run);
      const secondStatus = await client.query('status', secondRepo.context.repo_id, secondRepo.context.workstream_run);
      assert.equal(array(firstStatus.payload['edit_leases'], 'first repo leases').length, 1);
      assert.equal(array(secondStatus.payload['edit_leases'], 'second repo leases').length, 1);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('re-evaluates every expired offer even when the triggering owner response is deferred', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-negotiation-defer-expiry-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    let now = new Date('2026-07-11T09:00:00.000Z');
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env), { now: () => new Date(now) });
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const owner = await attachActor(client, stateRoot, 'a');
      const first = await attachActor(client, stateRoot, 'b');
      const second = await attachActor(client, stateRoot, 'c');
      const otherRequester = await attachActor(client, stateRoot, 'e');
      await owner.negotiation.acquire(acquisitionInput('a'));
      const otherOwnerInput = acquisitionInput('a');
      await owner.negotiation.acquire({
        ...otherOwnerInput, acquisitionGroupId: 'group-a-other', unitId: 'unit-a-other', normalReleaseCondition: { condition_type: 'unit-merged', target_id: 'unit-a-other:1', evidence: null }, requestedLeases: [{ path: 'src/other-shared.ts', mode: 'WRITE', purpose: 'hold second independent path' }],
      });
      await first.negotiation.acquire(acquisitionInput('b'));
      await second.negotiation.acquire(acquisitionInput('c'));
      const otherInput = acquisitionInput('e');
      await otherRequester.negotiation.acquire({
        ...otherInput, requestedLeases: [{ path: 'src/other-shared.ts', mode: 'WRITE', purpose: 'wait on second owner group' }],
      });
      const ownerRequests = await claimRequests(client, owner);
      const firstRelease = ownerRequests.find((entry) => entry.acquisition_group_id === 'group-b');
      const otherDeferred = ownerRequests.find((entry) => entry.acquisition_group_id === 'group-e');
      if (firstRelease === undefined || otherDeferred === undefined) throw new Error('missing owner requests for expiry/defer test');
      await owner.negotiation.respond({ request: firstRelease, response: 'release-now', ownerReason: 'release shared path', releaseCondition: null });
      assert.equal((await groups(client, first))[0]?.state, 'grant-ready');
      now = new Date(now.getTime() + COORDINATOR_GRANT_OFFER_TTL_MS + 1);
      await owner.negotiation.respond({ request: otherDeferred, response: 'deferred', ownerReason: 'other owner group remains active', releaseCondition: { condition_type: 'unit-merged', target_id: 'unit-a-other:1', evidence: null } });
      assert.equal((await groups(client, first))[0]?.state, 'waiting');
      assert.equal((await groups(client, second))[0]?.state, 'grant-ready');
      assert.equal((await claimRequests(client, otherRequester)).some((entry) => entry.status === 'deferred'), true);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('expires an offline grant offer and gives the next fair waiter a bounded offer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-negotiation-expiry-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    let now = new Date('2026-07-11T10:00:00.000Z');
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env), { now: () => new Date(now) });
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const owner = await attachActor(client, stateRoot, 'a');
      const offlineFirst = await attachActor(client, stateRoot, 'b');
      const next = await attachActor(client, stateRoot, 'c');
      const newcomer = await attachActor(client, stateRoot, 'd');
      await owner.negotiation.acquire(acquisitionInput('a'));
      await offlineFirst.negotiation.acquire(acquisitionInput('b'));
      await next.negotiation.acquire(acquisitionInput('c'));
      const releaseRequest = (await claimRequests(client, owner)).find((entry) => entry.acquisition_group_id === 'group-b');
      if (releaseRequest === undefined) throw new Error('missing release request');
      await owner.negotiation.respond({ request: releaseRequest, response: 'release-now', ownerReason: 'release for bounded offer', releaseCondition: null });
      assert.equal((await groups(client, offlineFirst))[0]?.state, 'grant-ready');

      now = new Date(now.getTime() + COORDINATOR_GRANT_OFFER_TTL_MS + 1);
      assert.equal(server.store.sweepExpiredGrantOffers(), 1);
      const newcomerResult = await newcomer.negotiation.acquire(acquisitionInput('d'));
      assert.equal(newcomerResult.outcome, 'waiting-for-peer-release');
      const expired = (await groups(client, offlineFirst))[0];
      const nextOffered = (await groups(client, next))[0];
      assert.equal(expired?.state, 'waiting');
      assert.equal(expired?.offer_count, 1);
      assert.equal(expired?.bypass_count, 1);
      assert.equal(nextOffered?.state, 'grant-ready');
      const newcomerGroup = (await groups(client, newcomer))[0];
      assert.equal(newcomerGroup?.state, 'waiting');
      assert.equal((await claimRequests(client, newcomer)).length, 0);
      if (newcomerGroup === undefined) throw new Error('missing newcomer group');
      const cancelledNewcomer = await newcomer.negotiation.cancelGroup({ group: newcomerGroup, reason: 'cancel offer-only wait without an owner request' });
      assert.equal(cancelledNewcomer.state, 'cancelled');
      if (nextOffered === undefined) throw new Error('missing next offered group');
      await next.negotiation.cancelGroup({ group: nextOffered, reason: 'exercise fair rotation after bounded offer' });
      assert.equal((await groups(client, offlineFirst))[0]?.state, 'grant-ready');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
