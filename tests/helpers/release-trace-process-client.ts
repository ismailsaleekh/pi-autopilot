import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import {
  parseCoordinationAcquisitionGroup,
  parseCoordinationClaimRequest,
  parseCoordinationRun,
  parseCoordinationSessionLease,
  parseCoordinationUnitAttempt,
} from '../../src/core/coordination/contracts.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import {
  readCoordinatorSessionContext,
  writeCoordinatorSessionContext,
  type CoordinatorSessionContext,
} from '../../src/core/coordination/supervisor.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

function requireArg(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}

function contextPath(stateRoot: string, suffix: string): string {
  return join(stateRoot, `release-trace-session-${suffix}.json`);
}

function token(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

function environment(stateRoot: string): ProcessEnvLike {
  return { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
}

function acquisitionInput(suffix: string, groupId: string, path: string, attempt = 1) {
  return {
    acquisitionGroupId: groupId,
    unitId: `unit-${suffix}`,
    attempt,
    acquisitionKind: 'initial' as const,
    requestedLeases: [{ path, mode: 'WRITE' as const, purpose: `seeded release trace ${suffix}` }],
    reason: `seeded release trace ${suffix} contests ${path}`,
    normalReleaseCondition: { condition_type: 'unit-merged' as const, target_id: `unit-${suffix}:${String(attempt)}`, evidence: null },
    specRef: `.pi/autopilot/workstream-${suffix}/unit-specs/unit-${suffix}.json`,
    specSha256: `sha256:${token('spec', suffix)}` as `sha256:${string}`,
    role: 'implement' as const,
    preemptible: true,
    checkpointOrdinal: 0,
  };
}

async function attachRunOnly(stateRoot: string, suffix: string) {
  const repoId = 'repo-release-trace';
  const workstreamRun = `run-${suffix}`;
  const response = await new CoordinatorClient({ env: environment(stateRoot), autoStart: false }).mutate('attach-run', {
    repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `release-trace-attach-run-${suffix}`,
  }, {
    repo_key: repoId, canonical_root: '/tmp/generic-release-trace-repository', git_common_dir: '/tmp/generic-release-trace-repository/.git',
    autopilot_id: `autopilot-${suffix}`, workstream: `workstream-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun,
      source_repo: '/tmp/generic-release-trace-repository', git_common_dir: '/tmp/generic-release-trace-repository/.git', worktree_root: join(stateRoot, 'worktrees', repoId),
      main_worktree_path: join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main'),
      runtime_root: join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main', '.pi', 'autopilot', `workstream-${suffix}`),
      branch: `autopilot/${workstreamRun}`, target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-12T00:00:00.000Z', version: 1,
    },
  });
  return parseCoordinationRun(response.payload['run']);
}

async function attachSessionOnly(stateRoot: string, suffix: string): Promise<CoordinatorSessionContext> {
  const env = environment(stateRoot);
  const client = new CoordinatorClient({ env, autoStart: false });
  const repoId = 'repo-release-trace';
  const workstreamRun = `run-${suffix}`;
  const status = await client.query('status', repoId, workstreamRun);
  const runs = status.payload['runs'];
  if (!Array.isArray(runs) || runs.length !== 1) throw new Error(`release trace run ${workstreamRun} is missing before session attach`);
  const run = parseCoordinationRun(runs[0]);
  const sessionToken = token('session', suffix, '1');
  const response = await client.mutate('attach-session', {
    repoId, workstreamRun, sessionId: `session-${suffix}-1`, fencingGeneration: 1, expectedVersion: run.version,
    idempotencyKey: `release-trace-attach-session-${suffix}-1`,
  }, {
    session_lease_id: `release-trace-session-lease-${suffix}-1`, session_token: sessionToken, pid: process.pid,
    boot_id: `release-trace-boot-${suffix}-1`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = parseCoordinationRun(response.payload['run']);
  const session = parseCoordinationSessionLease(response.payload['session']);
  const context: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId,
    autopilot_id: attachedRun.autopilot_id, workstream: attachedRun.workstream, workstream_run: attachedRun.workstream_run,
    session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
    session_lease_id: session.session_lease_id, session_token: sessionToken, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  };
  await writeCoordinatorSessionContext(contextPath(stateRoot, suffix), context);
  return context;
}

async function attach(stateRoot: string, suffix: string): Promise<CoordinatorSessionContext> {
  await attachRunOnly(stateRoot, suffix);
  return await attachSessionOnly(stateRoot, suffix);
}

async function statusEntities(client: CoordinatorClient, context: CoordinatorSessionContext, field: string): Promise<readonly unknown[]> {
  const status = await client.query('status', context.repo_id, context.workstream_run);
  const values = status.payload[field];
  if (!Array.isArray(values)) throw new Error(`status ${field} is not an array`);
  return values;
}

async function acquire(stateRoot: string, suffix: string, groupId: string, path: string, attachFirst: boolean, attempt = 1) {
  const context = attachFirst
    ? await attach(stateRoot, suffix)
    : await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const negotiation = new ClaimNegotiationClient(new CoordinatorClient({ env: environment(stateRoot), autoStart: false }), context);
  return await negotiation.acquire(acquisitionInput(suffix, groupId, path, attempt));
}

async function prepareHandoff(stateRoot: string, suffix: string): Promise<Readonly<Record<string, unknown>>> {
  const old = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const nextGeneration = old.session_generation + 1;
  const response = await new CoordinatorClient({ env: environment(stateRoot), autoStart: false }).mutate('prepare-handoff', {
    repoId: old.repo_id, workstreamRun: old.workstream_run, sessionId: old.session_id, fencingGeneration: old.session_generation,
    expectedVersion: old.session_version, idempotencyKey: `release-trace-prepare-handoff-${suffix}-${String(nextGeneration)}`,
  }, { handoff_token: token('handoff', suffix, String(nextGeneration)), session_lease_id: old.session_lease_id, session_token: old.session_token });
  const session = parseCoordinationSessionLease(response.payload['session']);
  await writeCoordinatorSessionContext(contextPath(stateRoot, suffix), { ...old, session_version: session.version });
  return { old_generation: old.session_generation, next_generation: nextGeneration, session_version: session.version };
}

async function attachHandoff(stateRoot: string, suffix: string): Promise<Readonly<Record<string, unknown>>> {
  const old = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const client = new CoordinatorClient({ env: environment(stateRoot), autoStart: false });
  const nextGeneration = old.session_generation + 1;
  const run = parseCoordinationRun((await statusEntities(client, old, 'runs'))[0]);
  const nextToken = token('session', suffix, String(nextGeneration));
  const response = await client.mutate('attach-session', {
    repoId: old.repo_id, workstreamRun: old.workstream_run, sessionId: `session-${suffix}-${String(nextGeneration)}`,
    fencingGeneration: nextGeneration, expectedVersion: run.version, idempotencyKey: `release-trace-attach-session-${suffix}-${String(nextGeneration)}`,
  }, {
    session_lease_id: `release-trace-session-lease-${suffix}-${String(nextGeneration)}`, session_token: nextToken, pid: process.pid,
    boot_id: `release-trace-boot-${suffix}-${String(nextGeneration)}`, lease_expires_at: '2099-01-01T00:00:00.000Z',
    handoff_token: token('handoff', suffix, String(nextGeneration)),
  });
  const attachedRun = parseCoordinationRun(response.payload['run']);
  const session = parseCoordinationSessionLease(response.payload['session']);
  await writeCoordinatorSessionContext(contextPath(stateRoot, suffix), {
    ...old, session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
    session_lease_id: session.session_lease_id, session_token: nextToken, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  });
  return { old_generation: old.session_generation, new_generation: session.session_generation };
}

async function staleHandoffHeartbeat(stateRoot: string, suffix: string): Promise<Readonly<Record<string, unknown>>> {
  const current = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const oldGeneration = current.session_generation - 1;
  let staleCode: string | null = null;
  try {
    await new CoordinatorClient({ env: environment(stateRoot), autoStart: false }).mutate('heartbeat', {
      repoId: current.repo_id, workstreamRun: current.workstream_run, sessionId: `session-${suffix}-${String(oldGeneration)}`,
      fencingGeneration: oldGeneration, expectedVersion: 2, idempotencyKey: `release-trace-stale-heartbeat-${suffix}-${String(current.session_generation)}`,
    }, {
      lease_expires_at: '2099-01-01T00:00:00.000Z', session_lease_id: `release-trace-session-lease-${suffix}-${String(oldGeneration)}`,
      session_token: token('session', suffix, String(oldGeneration)),
    });
  } catch (error) {
    if (error instanceof CoordinationRuntimeError) staleCode = error.code;
    else throw error;
  }
  return { old_generation: oldGeneration, new_generation: current.session_generation, stale_code: staleCode };
}

async function deferAll(stateRoot: string, suffix: string): Promise<Readonly<Record<string, unknown>>> {
  const context = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const client = new CoordinatorClient({ env: environment(stateRoot), autoStart: false });
  const negotiation = new ClaimNegotiationClient(client, context);
  const requests = (await statusEntities(client, context, 'claim_requests'))
    .map((value) => parseCoordinationClaimRequest(value))
    .filter((request) => request.owner.workstream_run === context.workstream_run && ['pending', 'delivered', 'acknowledged', 'deferred'].includes(request.status))
    .sort((left, right) => left.created_event_seq - right.created_event_seq || left.request_id.localeCompare(right.request_id));
  let duplicateRetries = 0;
  let staleReorders = 0;
  for (const request of requests) {
    const input = {
      request,
      response: 'deferred' as const,
      ownerReason: 'seeded owner retains the contested path until explicit release',
      releaseCondition: { condition_type: 'unit-merged' as const, target_id: request.owner.unit_id + ':' + String(request.owner.attempt), evidence: null },
    };
    const deferred = await negotiation.respond(input);
    const duplicate = await negotiation.respond(input);
    if (duplicate.version !== deferred.version) throw new Error('duplicate defer changed durable request version');
    duplicateRetries += 1;
    try {
      await negotiation.respond({ request, response: 'release-now', ownerReason: 'seeded stale reordered release', releaseCondition: null });
    } catch (error) {
      if (error instanceof CoordinationRuntimeError && error.code === 'stale-version') staleReorders += 1;
      else throw error;
    }
  }
  return { deferred_count: requests.length, duplicate_retries: duplicateRetries, stale_reorders: staleReorders };
}

function deferredRequestPath(stateRoot: string, suffix: string, acquisitionGroupId: string): string {
  return join(stateRoot, `release-trace-defer-${suffix}-${token(acquisitionGroupId).slice(0, 16)}.json`);
}

async function deferOne(stateRoot: string, suffix: string, acquisitionGroupId: string, mode: 'commit' | 'duplicate' | 'stale'): Promise<Readonly<Record<string, unknown>>> {
  const context = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const client = new CoordinatorClient({ env: environment(stateRoot), autoStart: false });
  const negotiation = new ClaimNegotiationClient(client, context);
  let request;
  if (mode === 'commit') {
    request = (await statusEntities(client, context, 'claim_requests')).map((value) => parseCoordinationClaimRequest(value))
      .filter((entry) => entry.owner.workstream_run === context.workstream_run && entry.acquisition_group_id === acquisitionGroupId && ['pending', 'delivered', 'acknowledged'].includes(entry.status))
      .sort((left, right) => left.created_event_seq - right.created_event_seq || left.request_id.localeCompare(right.request_id))[0];
    if (request === undefined) throw new Error(`owner has no live request for ${acquisitionGroupId}`);
    await writeFile(deferredRequestPath(stateRoot, suffix, acquisitionGroupId), `${JSON.stringify(request)}\n`, { encoding: 'utf8', mode: 0o600 });
  } else request = parseCoordinationClaimRequest(JSON.parse(await readFile(deferredRequestPath(stateRoot, suffix, acquisitionGroupId), 'utf8')) as unknown);
  const input = { request, response: 'deferred' as const, ownerReason: 'seeded persistent holder defers one interleaved request', releaseCondition: { condition_type: 'unit-merged' as const, target_id: `${request.owner.unit_id}:${String(request.owner.attempt)}`, evidence: null } };
  if (mode === 'stale') {
    let staleCode: string | null = null;
    try { await negotiation.respond({ request, response: 'release-now', ownerReason: 'seeded stale reordered release', releaseCondition: null }); }
    catch (error) { if (error instanceof CoordinationRuntimeError) staleCode = error.code; else throw error; }
    return { request_id: request.request_id, stale_code: staleCode };
  }
  const deferred = await negotiation.respond(input);
  return { request_id: deferred.request_id, status: deferred.status, version: deferred.version };
}

async function cancelGroup(stateRoot: string, suffix: string, acquisitionGroupId: string): Promise<Readonly<Record<string, unknown>>> {
  const context = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const client = new CoordinatorClient({ env: environment(stateRoot), autoStart: false });
  const negotiation = new ClaimNegotiationClient(client, context);
  const group = (await statusEntities(client, context, 'acquisition_groups'))
    .map((value) => parseCoordinationAcquisitionGroup(value))
    .find((entry) => entry.acquisition_group_id === acquisitionGroupId);
  if (group === undefined) throw new Error(`actor has no acquisition group ${acquisitionGroupId}`);
  const cancelled = await negotiation.cancelGroup({ group, reason: 'seeded persistent cancellation before replacement attempt' });
  return { group_id: cancelled.acquisition_group_id, state: cancelled.state, version: cancelled.version };
}

async function supersedeAttempt(stateRoot: string, suffix: string, attempt: number, supersededByAttempt: number): Promise<Readonly<Record<string, unknown>>> {
  const context = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const client = new CoordinatorClient({ env: environment(stateRoot), autoStart: false });
  const negotiation = new ClaimNegotiationClient(client, context);
  const current = (await statusEntities(client, context, 'unit_attempts'))
    .map((value) => parseCoordinationUnitAttempt(value))
    .find((entry) => entry.owner.unit_id === `unit-${suffix}` && entry.owner.attempt === attempt);
  if (current === undefined) throw new Error(`actor has no attempt ${String(attempt)}`);
  await negotiation.supersede({ unitId: current.owner.unit_id, attempt, attemptVersion: current.version, supersededByAttempt, reason: 'seeded persistent cancellation replacement' });
  return { attempt, superseded_by_attempt: supersededByAttempt };
}

async function releaseOne(stateRoot: string, suffix: string): Promise<Readonly<Record<string, unknown>>> {
  const context = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const client = new CoordinatorClient({ env: environment(stateRoot), autoStart: false });
  const negotiation = new ClaimNegotiationClient(client, context);
  const leases = await statusEntities(client, context, 'edit_leases');
  const leaseIds = new Set(leases.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('edit lease is not an object');
    const id = (value as Readonly<Record<string, unknown>>)['edit_lease_id'];
    if (typeof id !== 'string') throw new Error('edit lease id is invalid');
    return id;
  }));
  const request = (await statusEntities(client, context, 'claim_requests'))
    .map((value) => parseCoordinationClaimRequest(value))
    .filter((entry) => entry.owner.workstream_run === context.workstream_run && ['pending', 'delivered', 'acknowledged', 'deferred'].includes(entry.status) && entry.blocking_lease_ids.some((id) => leaseIds.has(id)))
    .sort((left, right) => left.created_event_seq - right.created_event_seq || left.request_id.localeCompare(right.request_id))[0];
  if (request === undefined) throw new Error('current holder has no live contested release request');
  const released = await negotiation.respond({ request, response: 'release-now', ownerReason: 'seeded holder completed its contested phase', releaseCondition: null });
  return { request_id: released.request_id, status: released.status, release_event_seq: released.release_event_seq };
}

async function acknowledgeOffer(stateRoot: string, suffix: string): Promise<Readonly<Record<string, unknown>>> {
  const context = await readCoordinatorSessionContext(contextPath(stateRoot, suffix));
  const client = new CoordinatorClient({ env: environment(stateRoot), autoStart: false });
  const negotiation = new ClaimNegotiationClient(client, context);
  const group = (await statusEntities(client, context, 'acquisition_groups'))
    .map((value) => parseCoordinationAcquisitionGroup(value))
    .find((entry) => entry.state === 'grant-ready');
  if (group === undefined) throw new Error('actor has no grant-ready acquisition group');
  const granted = await negotiation.acknowledgeGrant(group);
  return { group_id: granted.acquisitionGroup.acquisition_group_id, state: granted.acquisitionGroup.state, lease_count: granted.editLeases.length };
}

function commandRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('persistent command must be an object');
  return value as Readonly<Record<string, unknown>>;
}

function commandString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`persistent command ${field} is invalid`);
  return value;
}

function commandInteger(record: Readonly<Record<string, unknown>>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`persistent command ${field} is invalid`);
  return value;
}

async function persistent(stateRoot: string, suffix: string): Promise<void> {
  console.log(JSON.stringify({ kind: 'ready', suffix, pid: process.pid }));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let id = 'unknown';
    try {
      const command = commandRecord(JSON.parse(line) as unknown);
      id = commandString(command, 'id');
      const action = commandString(command, 'action');
      if (action === 'shutdown') { console.log(JSON.stringify({ kind: 'response', id, ok: true, result: { stopped: true } })); break; }
      let result: Readonly<Record<string, unknown>>;
      if (action === 'attach-run') {
        const run = await attachRunOnly(stateRoot, suffix);
        result = { workstream_run: run.workstream_run, version: run.version };
      } else if (action === 'attach-session') {
        const context = await attachSessionOnly(stateRoot, suffix);
        result = { session_id: context.session_id, session_generation: context.session_generation };
      } else if (action === 'acquire') {
        const acquired = await acquire(stateRoot, suffix, commandString(command, 'group_id'), commandString(command, 'path'), false, commandInteger(command, 'attempt'));
        result = { outcome: acquired.outcome, committed_event_seq: acquired.committedEventSeq };
      } else if (action === 'retry') {
        const replay = await acquire(stateRoot, suffix, commandString(command, 'group_id'), commandString(command, 'path'), false, commandInteger(command, 'attempt'));
        result = { outcome: replay.outcome, committed_event_seq: replay.committedEventSeq };
      } else if (action === 'handoff-prepare') result = await prepareHandoff(stateRoot, suffix);
      else if (action === 'handoff-attach') result = await attachHandoff(stateRoot, suffix);
      else if (action === 'handoff-stale') result = await staleHandoffHeartbeat(stateRoot, suffix);
      else if (action === 'defer') result = await deferOne(stateRoot, suffix, commandString(command, 'group_id'), 'commit');
      else if (action === 'defer-duplicate') result = await deferOne(stateRoot, suffix, commandString(command, 'group_id'), 'duplicate');
      else if (action === 'defer-stale') result = await deferOne(stateRoot, suffix, commandString(command, 'group_id'), 'stale');
      else if (action === 'cancel') result = await cancelGroup(stateRoot, suffix, commandString(command, 'group_id'));
      else if (action === 'supersede') result = await supersedeAttempt(stateRoot, suffix, commandInteger(command, 'attempt'), commandInteger(command, 'superseded_by_attempt'));
      else if (action === 'release') result = await releaseOne(stateRoot, suffix);
      else if (action === 'ack') result = await acknowledgeOffer(stateRoot, suffix);
      else throw new Error(`unsupported persistent action ${action}`);
      console.log(JSON.stringify({ kind: 'response', id, ok: true, result }));
    } catch (error) {
      console.log(JSON.stringify({ kind: 'response', id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
    }
  }
}

async function main(): Promise<void> {
  const action = requireArg(2, 'action');
  const stateRoot = requireArg(3, 'state root');
  const suffix = requireArg(4, 'actor suffix');
  if (action === 'persistent') { await persistent(stateRoot, suffix); return; }
  if (action === 'attach-acquire') {
    const result = await acquire(stateRoot, suffix, requireArg(5, 'group id'), requireArg(6, 'path'), true);
    console.log(JSON.stringify({ action, outcome: result.outcome, committed_event_seq: result.committedEventSeq }));
    return;
  }
  if (action === 'replay-acquire') {
    const replay = await acquire(stateRoot, suffix, requireArg(5, 'group id'), requireArg(6, 'path'), false);
    console.log(JSON.stringify({ action, outcome: replay.outcome, committed_event_seq: replay.committedEventSeq }));
    return;
  }
  if (action === 'handoff') {
    await prepareHandoff(stateRoot, suffix);
    await attachHandoff(stateRoot, suffix);
    console.log(JSON.stringify(await staleHandoffHeartbeat(stateRoot, suffix)));
  }
  else if (action === 'defer-all') console.log(JSON.stringify(await deferAll(stateRoot, suffix)));
  else if (action === 'release-one') console.log(JSON.stringify(await releaseOne(stateRoot, suffix)));
  else if (action === 'ack') console.log(JSON.stringify(await acknowledgeOffer(stateRoot, suffix)));
  else throw new Error(`unsupported action ${action}`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
