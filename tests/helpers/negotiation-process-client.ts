import { join } from 'node:path';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAcquisitionGroup, parseCoordinationClaimRequest, parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { readCoordinatorSessionContext, writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

function requireArg(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}

function contextPath(stateRoot: string, suffix: string): string {
  return join(stateRoot, `session-${suffix}.json`);
}

function token(suffix: string): string {
  return suffix.charCodeAt(0).toString(16).slice(-1).repeat(64);
}

function acquisitionInput(suffix: string) {
  return {
    acquisitionGroupId: `group-${suffix}`, unitId: `unit-${suffix}`, attempt: 1,
    requestedLeases: [{ path: 'src/shared.ts', mode: 'WRITE' as const, purpose: `process ${suffix}` }],
    reason: `process ${suffix} requires shared source`,
    normalReleaseCondition: { condition_type: 'unit-merged' as const, target_id: `unit-${suffix}:1`, evidence: null },
    specRef: `.pi/autopilot/workstream-${suffix}/unit-specs/unit-${suffix}.json`,
    specSha256: `sha256:${suffix.charCodeAt(0).toString(16).slice(-1).repeat(64)}` as `sha256:${string}`,
    preemptible: true, checkpointOrdinal: 0,
  };
}

async function attach(stateRoot: string, suffix: string): Promise<CoordinatorSessionContext> {
  const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
  const client = new CoordinatorClient({ env, autoStart: false });
  const repoId = 'repo-process-negotiation';
  const workstreamRun = `run-${suffix}`;
  const runResponse = await client.mutate('attach-run', {
    repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}`,
  }, { repo_key: repoId, canonical_root: '/tmp/generic-process-negotiation', git_common_dir: '/tmp/generic-process-negotiation/.git', autopilot_id: `autopilot-${suffix}`, workstream: `workstream-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1' });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const sessionResponse = await client.mutate('attach-session', {
    repoId, workstreamRun, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}`,
  }, { session_lease_id: `lease-session-${suffix}`, session_token: token(suffix), pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  const context: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId,
    autopilot_id: attachedRun.autopilot_id, workstream: attachedRun.workstream, workstream_run: attachedRun.workstream_run,
    session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
    session_lease_id: session.session_lease_id, session_token: token(suffix), session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  };
  await writeCoordinatorSessionContext(contextPath(stateRoot, suffix), context);
  return context;
}

async function queryRequests(client: CoordinatorClient, context: CoordinatorSessionContext) {
  const status = await client.query('status', context.repo_id, context.workstream_run);
  const values = status.payload['claim_requests'];
  if (!Array.isArray(values)) throw new Error('status claim_requests is not an array');
  return values.map((value) => parseCoordinationClaimRequest(value));
}

async function queryGroups(client: CoordinatorClient, context: CoordinatorSessionContext) {
  const status = await client.query('status', context.repo_id, context.workstream_run);
  const values = status.payload['acquisition_groups'];
  if (!Array.isArray(values)) throw new Error('status acquisition_groups is not an array');
  return values.map((value) => parseCoordinationAcquisitionGroup(value));
}

async function main(): Promise<void> {
  const action = requireArg(2, 'action');
  const stateRoot = requireArg(3, 'state root');
  const suffix = requireArg(4, 'actor suffix');
  const context = action === 'attach-acquire' ? await attach(stateRoot, suffix) : await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const client = new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot }, autoStart: false });
  const negotiation = new ClaimNegotiationClient(client, context);
  if (action === 'attach-acquire') {
    const result = await negotiation.acquire(acquisitionInput(suffix));
    console.log(JSON.stringify({ action, outcome: result.outcome, request_refs: result.requestRefs }));
    return;
  }
  if (action === 'release') {
    const targetGroup = requireArg(5, 'target acquisition group');
    const request = (await queryRequests(client, context)).find((entry) => entry.acquisition_group_id === targetGroup && !['resolved', 'cancelled', 'superseded'].includes(entry.status));
    if (request === undefined) throw new Error(`missing request for ${targetGroup}`);
    const released = await negotiation.respond({ request, response: 'release-now', ownerReason: 'owner process completed its critical section', releaseCondition: null });
    console.log(JSON.stringify({ action, status: released.status, release_event_seq: released.release_event_seq }));
    return;
  }
  if (action === 'ack') {
    const group = (await queryGroups(client, context)).find((entry) => entry.state === 'grant-ready');
    if (group === undefined) throw new Error('missing grant-ready group');
    const granted = await negotiation.acknowledgeGrant(group);
    console.log(JSON.stringify({ action, state: granted.acquisitionGroup.state, lease_count: granted.editLeases.length }));
    return;
  }
  throw new Error(`unsupported action ${action}`);
}

await main().catch((error: unknown) => {
  const diagnostic = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(diagnostic);
  process.exitCode = 1;
});
