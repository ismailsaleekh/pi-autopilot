import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAcquisitionGroup, parseCoordinationClaimRequest, parseCoordinationDeadlockResolution, parseCoordinationEditLease, parseCoordinationEscalation, parseCoordinationRun, parseCoordinationSessionLease, parseCoordinationWaitForEdge } from '../../src/core/coordination/contracts.ts';
import { buildCoordinationWaitForEdges, compareCoordinationGrantPriority, detectCoordinationWaitCycles, MAX_GRANT_BYPASSES, selectCoordinationDeadlockVictim } from '../../src/core/coordination/deadlock.ts';
import { PlanningContradictionClient, rejectOperationalEscalation, validatePlanningContradictionSubmission } from '../../src/core/coordination/escalation.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { COORDINATOR_GRANT_OFFER_TTL_MS, coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import type { CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { COORDINATION_OPERATIONAL_ESCALATION_REASONS, type CoordinationClaimRequest, type CoordinationEditLease, type CoordinationEscalation, type CoordinationOwnerIdentity, type CoordinationWaitForEdge } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

interface Actor {
  readonly context: CoordinatorSessionContext;
  readonly claims: ClaimNegotiationClient;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function runAdjudicatorProcess(args: readonly string[], env: ProcessEnvLike): Promise<void> {
  const script = fileURLToPath(new URL('../helpers/adjudication-process-client.ts', import.meta.url));
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', rejectProcess);
    child.on('close', (code) => {
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(`adjudicator process exited ${String(code)}: ${stderr}`));
    });
  });
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function attachActor(client: CoordinatorClient, stateRoot: string, repoRoot: string, suffix: string): Promise<Actor> {
  const repoId = 'repo-deadlock';
  const runResponse = await client.mutate('attach-run', { repoId, workstreamRun: `run-${suffix}`, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}` }, {
    repo_key: repoId, canonical_root: repoRoot, git_common_dir: join(repoRoot, '.git'), autopilot_id: `autopilot-${suffix}`, workstream: `work-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1',
  });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const token = suffix.charCodeAt(0).toString(16).repeat(64).slice(0, 64);
  const sessionResponse = await client.mutate('attach-session', { repoId, workstreamRun: run.workstream_run, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}` }, {
    session_lease_id: `session-lease-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  const context: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId, autopilot_id: attachedRun.autopilot_id,
    workstream: attachedRun.workstream, workstream_run: attachedRun.workstream_run, session_id: session.session_id, session_generation: session.session_generation,
    run_version: attachedRun.version, session_lease_id: session.session_lease_id, session_token: token, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  };
  return { context, claims: new ClaimNegotiationClient(client, context) };
}

function acquisition(actor: Actor, id: string, path: string, unitId: string, preemptible = true, role: 'implement' | 'adjudicate' = 'implement', acquisitionKind: 'initial' | 'materialization-read-expansion' = 'initial') {
  return {
    acquisitionGroupId: id, unitId, attempt: 1, acquisitionKind, requestedLeases: [{ path, mode: acquisitionKind === 'initial' && role === 'implement' ? 'WRITE' as const : 'READ' as const, purpose: `own ${path}` }], reason: `requires ${path}`,
    normalReleaseCondition: role === 'adjudicate' ? { condition_type: 'child-terminal' as const, target_id: `child-${actor.context.workstream_run}-${unitId}-1`, evidence: null } : { condition_type: 'unit-merged' as const, target_id: `${unitId}:1`, evidence: null }, specRef: `.pi/autopilot/${actor.context.workstream}/unit-specs/${unitId}.json`,
    specSha256: `sha256:${actor.context.autopilot_id.charCodeAt(0).toString(16).repeat(64).slice(0, 64)}` as `sha256:${string}`, role, preemptible, checkpointOrdinal: 0,
  };
}

async function registerUnitWorktree(client: CoordinatorClient, actor: Actor, repoRoot: string, unitId: string): Promise<string> {
  const owner: CoordinationOwnerIdentity = { repo_id: actor.context.repo_id, autopilot_id: actor.context.autopilot_id, workstream_run: actor.context.workstream_run, unit_id: unitId, attempt: 1 };
  const worktreePath = join(actor.context.state_root, 'worktrees', actor.context.repo_key, 'active', actor.context.workstream_run, 'units', unitId, 'attempt-1', 'worktree');
  const branch = `autopilot/unit/${actor.context.workstream_run}/${unitId}/attempt-1`;
  await mkdir(worktreePath, { recursive: true });
  await client.mutate('prepare-operation', { repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id, fencingGeneration: actor.context.session_generation, expectedVersion: 0, idempotencyKey: `register-unit-${actor.context.workstream_run}-${unitId}` }, {
    worktree: { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: `unit-${actor.context.workstream_run}-${unitId}`, owner, kind: 'unit', canonical_path: worktreePath, git_common_dir: join(repoRoot, '.git'), branch, state: 'planned', version: 1 },
    operation: { schema_version: 'autopilot.worktree_operation.v2', operation_id: `create-unit-${actor.context.workstream_run}-${unitId}`, worktree_id: `unit-${actor.context.workstream_run}-${unitId}`, owner, operation_type: 'create', stage: 'prepared', authority_version: 1, intent_event_seq: 0, intent: { repo_root: repoRoot, worktree_path: worktreePath, git_common_dir: join(repoRoot, '.git'), branch, reason: 'register adjudicator fixture worktree', base_sha: 'a'.repeat(40), target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] }, completed_steps: [], current_step: null, recovery_attempts: 0, verification_evidence: null, error_code: null, version: 1 },
    session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token,
  });
  return worktreePath;
}

async function registerRunningChild(client: CoordinatorClient, actor: Actor, unitId: string): Promise<{ readonly childId: string; readonly token: string }> {
  const token = actor.context.autopilot_id.charCodeAt(1).toString(16).repeat(64).slice(0, 64);
  const childId = `child-${actor.context.workstream_run}-${unitId}-1`;
  await client.mutate('register-child', {
    repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id, fencingGeneration: actor.context.session_generation,
    expectedVersion: actor.context.run_version, idempotencyKey: `register-child-${actor.context.workstream_run}`,
  }, { child_lease_id: childId, autopilot_id: actor.context.autopilot_id, unit_id: unitId, attempt: 1, pid: process.pid, boot_id: actor.context.boot_id, child_token: token, session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token, lease_expires_at: '2099-01-01T00:00:00.000Z' });
  return { childId, token };
}

void describe('Coordination Fabric deadlock, starvation, and escalation arbitration', () => {
  void it('detects every generated ring while leaving generated DAGs acyclic', () => {
    for (let size = 2; size <= 32; size += 1) {
      const owners = Array.from({ length: size }, (_, index): CoordinationOwnerIdentity => ({ repo_id: 'repo', autopilot_id: `auto-${String(index)}`, workstream_run: `run-${String(index)}`, unit_id: `unit-${String(index)}`, attempt: 1 }));
      const requests: CoordinationClaimRequest[] = [];
      const leases: CoordinationEditLease[] = [];
      for (let index = 0; index < size; index += 1) {
        const requester = owners[index];
        const blocker = owners[(index + 1) % size];
        if (requester === undefined || blocker === undefined) throw new Error('generated owner missing');
        const leaseId = `lease-${String(index)}`;
        leases.push({ schema_version: 'autopilot.edit_lease.v1', edit_lease_id: leaseId, owner: blocker, acquisition_group_id: `held-${String(index)}`, path: `src/${String(index)}.ts`, mode: 'WRITE', purpose: 'ring', acquired_event_seq: index + 1, normal_release_condition: { condition_type: 'unit-merged', target_id: `${blocker.unit_id}:1`, evidence: null }, version: 1 });
        requests.push({ schema_version: 'autopilot.claim_request.v1', request_id: `request-${String(index)}`, acquisition_group_id: `wait-${String(index)}`, requester, owner: blocker, blocking_lease_ids: [leaseId], requested_leases: [{ path: `src/${String(index)}.ts`, mode: 'WRITE', purpose: 'ring' }], reason: 'ring', created_event_seq: index + 1, status: 'deferred', owner_reason: 'held', release_condition: { condition_type: 'unit-merged', target_id: `${blocker.unit_id}:1`, evidence: null }, release_event_seq: null, grant_event_seq: null, version: 2 });
      }
      const edges = buildCoordinationWaitForEdges({ requests, editLeases: leases, eventSeq: size + 1 });
      assert.equal(detectCoordinationWaitCycles(edges).length, 1);
      const dagEdges: CoordinationWaitForEdge[] = edges.slice(0, -1);
      assert.equal(detectCoordinationWaitCycles(dagEdges).length, 0);
    }
  });

  void it('uses the locked victim ordering and refuses critical/non-preemptible victims', () => {
    const ownerA: CoordinationOwnerIdentity = { repo_id: 'repo', autopilot_id: 'a', workstream_run: 'run-a', unit_id: 'unit-a', attempt: 1 };
    const ownerB: CoordinationOwnerIdentity = { repo_id: 'repo', autopilot_id: 'b', workstream_run: 'run-b', unit_id: 'unit-b', attempt: 1 };
    const edges: CoordinationWaitForEdge[] = [
      { schema_version: 'autopilot.wait_for_edge.v1', edge_id: 'edge-a', repo_id: 'repo', request_id: 'request-a', requester: ownerA, blocker: ownerB, state: 'active', created_event_seq: 1, resolved_event_seq: null, version: 1 },
      { schema_version: 'autopilot.wait_for_edge.v1', edge_id: 'edge-b', repo_id: 'repo', request_id: 'request-b', requester: ownerB, blocker: ownerA, state: 'active', created_event_seq: 2, resolved_event_seq: null, version: 1 },
    ];
    const cycle = detectCoordinationWaitCycles(edges)[0];
    if (cycle === undefined) throw new Error('cycle missing');
    const victim = selectCoordinationDeadlockVictim(cycle, {
      attempts: [
        { schema_version: 'autopilot.unit_attempt.v1', owner: ownerA, state: 'preflight', role: 'implement', spec: { ref: 'a.json', sha256: `sha256:${'a'.repeat(64)}` }, preemptible: true, checkpoint_ordinal: 0, critical_section: null, version: 1 },
        { schema_version: 'autopilot.unit_attempt.v1', owner: ownerB, state: 'running', role: 'implement', spec: { ref: 'b.json', sha256: `sha256:${'b'.repeat(64)}` }, preemptible: true, checkpoint_ordinal: 1, critical_section: null, version: 1 },
      ],
      acquisitionGroups: [], claimRequests: [],
      childLeases: [{ schema_version: 'autopilot.child_lease.v1', child_lease_id: 'child-b', owner: ownerB, pid: 2, boot_id: 'boot', lease_expires_at: '2099-01-01T00:00:00.000Z', status: 'running', terminal_evidence: null, version: 1 }],
      worktrees: [], worktreeOperations: [],
    });
    assert.equal(victim?.victim_class, 2);
    assert.equal(victim?.owner.workstream_run, 'run-a');
    assert.equal(selectCoordinationDeadlockVictim(cycle, {
      attempts: [
        { schema_version: 'autopilot.unit_attempt.v1', owner: ownerA, state: 'running', role: 'implement', spec: { ref: 'a.json', sha256: `sha256:${'a'.repeat(64)}` }, preemptible: false, checkpoint_ordinal: 0, critical_section: null, version: 1 },
        { schema_version: 'autopilot.unit_attempt.v1', owner: ownerB, state: 'running', role: 'implement', spec: { ref: 'b.json', sha256: `sha256:${'b'.repeat(64)}` }, preemptible: true, checkpoint_ordinal: 2, critical_section: 'merge', version: 1 },
      ], acquisitionGroups: [], claimRequests: [], childLeases: [], worktrees: [], worktreeOperations: [],
    }), null);
    assert.equal(MAX_GRANT_BYPASSES, 8);
    const baseGroup = { schema_version: 'autopilot.acquisition_group.v2' as const, owner: ownerA, acquisition_kind: 'initial' as const, requested_leases: [{ path: 'src/a.ts', mode: 'WRITE' as const, purpose: 'fairness' }], reason: 'fairness', normal_release_condition: { condition_type: 'unit-merged' as const, target_id: 'unit-a:1', evidence: null }, state: 'waiting' as const, created_event_seq: 1, fairness_event_seq: 1, grant_event_seq: null, offer_expires_at: null, version: 1 };
    const starved = { ...baseGroup, acquisition_group_id: 'starved', offer_count: 12, bypass_count: MAX_GRANT_BYPASSES };
    const newcomer = { ...baseGroup, acquisition_group_id: 'newcomer', created_event_seq: 99, fairness_event_seq: 99, offer_count: 0, bypass_count: 0 };
    assert.equal(compareCoordinationGrantPriority(starved, newcomer) < 0, true);
  });

  void it('forbids every post-initial WRITE expansion while permitting typed READ materialization expansion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-write-expansion-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const actor = await attachActor(client, stateRoot, repoRoot, 'a');
      await actor.claims.acquire(acquisition(actor, 'group-initial', 'src/a.ts', 'unit-a'));
      await assert.rejects(() => actor.claims.acquire(acquisition(actor, 'group-second-write', 'src/b.ts', 'unit-a')), (error: unknown) => error instanceof CoordinationRuntimeError && /exactly one immutable initial/u.test(error.message));
      const invalidExpansion = acquisition(actor, 'group-invalid-expansion', 'src/b.ts', 'unit-a', true, 'implement', 'materialization-read-expansion');
      await assert.rejects(() => actor.claims.acquire({ ...invalidExpansion, requestedLeases: [{ path: 'src/b.ts', mode: 'WRITE', purpose: 'forbidden expansion' }] }), (error: unknown) => error instanceof CoordinationRuntimeError && /READ authority only/u.test(error.message));
      const readExpansion = await actor.claims.acquire(acquisition(actor, 'group-read-expansion', 'src/b.ts', 'unit-a', true, 'implement', 'materialization-read-expansion'));
      assert.equal(readExpansion.outcome, 'granted');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('ages an otherwise eligible waiter exactly once per decision and grants it at eight bypasses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-starvation-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    let now = new Date('2026-07-12T10:00:00.000Z');
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env), { now: () => new Date(now) });
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const owner = await attachActor(client, stateRoot, repoRoot, 'a');
      await owner.claims.acquire(acquisition(owner, 'group-owner', 'src/shared.ts', 'unit-owner'));
      const starved = await attachActor(client, stateRoot, repoRoot, 'b');
      await starved.claims.acquire(acquisition(starved, 'group-b', 'src/shared.ts', 'unit-b'));
      const ownerStatus = await client.query('status', owner.context.repo_id, owner.context.workstream_run);
      const request = array(ownerStatus.payload['claim_requests'], 'owner claim requests').map(parseCoordinationClaimRequest)[0];
      if (request === undefined) throw new Error('starvation owner request missing');
      await owner.claims.respond({ request, response: 'release-now', ownerReason: 'release shared authority for fairness decisions', releaseCondition: null });
      const newerSuffixes = ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      for (const suffix of newerSuffixes) {
        const newer = await attachActor(client, stateRoot, repoRoot, suffix);
        await newer.claims.acquire(acquisition(newer, `group-${suffix}`, 'src/shared.ts', `unit-${suffix}`));
        now = new Date(now.getTime() + COORDINATOR_GRANT_OFFER_TTL_MS + 1);
        assert.equal(server.store.sweepExpiredGrantOffers(), 1);
      }
      const thresholdCompetitor = await attachActor(client, stateRoot, repoRoot, 'k');
      await thresholdCompetitor.claims.acquire(acquisition(thresholdCompetitor, 'group-k', 'src/shared.ts', 'unit-k'));
      now = new Date(now.getTime() + COORDINATOR_GRANT_OFFER_TTL_MS + 1);
      assert.equal(server.store.sweepExpiredGrantOffers(), 1);
      const starvedStatus = await client.query('status', starved.context.repo_id, starved.context.workstream_run);
      const starvedGroup = array(starvedStatus.payload['acquisition_groups'], 'starved groups').map(parseCoordinationAcquisitionGroup)[0];
      assert.equal(starvedGroup?.bypass_count, MAX_GRANT_BYPASSES);
      assert.equal(starvedGroup?.state, 'grant-ready');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('resolves a real transactional two-run cycle by cancelling only a safe preflight victim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-deadlock-resolve-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const a = await attachActor(client, stateRoot, repoRoot, 'a');
      const b = await attachActor(client, stateRoot, repoRoot, 'b');
      await a.claims.acquire(acquisition(a, 'group-a-held', 'src/a.ts', 'unit-a'));
      await b.claims.acquire(acquisition(b, 'group-b-held', 'src/b.ts', 'unit-b'));
      await a.claims.acquire(acquisition(a, 'group-a-wait', 'src/b.ts', 'unit-a', true, 'implement', 'materialization-read-expansion'));
      await b.claims.acquire(acquisition(b, 'group-b-wait', 'src/a.ts', 'unit-b', true, 'implement', 'materialization-read-expansion'));
      const status = await client.query('status', a.context.repo_id, a.context.workstream_run);
      const resolutions = array(status.payload['deadlock_resolutions'], 'deadlock resolutions').map(parseCoordinationDeadlockResolution);
      assert.equal(resolutions.length, 1);
      assert.equal(resolutions[0]?.state, 'resolved');
      assert.equal(resolutions[0]?.victim_class, 2);
      assert.equal(array(status.payload['escalations'], 'escalations').length, 0);
      const edges = array(status.payload['wait_for_edges'], 'wait edges').map(parseCoordinationWaitForEdge);
      assert.equal(detectCoordinationWaitCycles(edges).length, 0);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('never cancels a dirty preflight worktree and retains leases until owner recovery evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-deadlock-dirty-preflight-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const a = await attachActor(client, stateRoot, repoRoot, 'a');
      const b = await attachActor(client, stateRoot, repoRoot, 'b');
      await a.claims.acquire(acquisition(a, 'group-a-held', 'src/a.ts', 'unit-a'));
      await b.claims.acquire(acquisition(b, 'group-b-held', 'src/b.ts', 'unit-b'));
      const worktree = await registerUnitWorktree(client, a, repoRoot, 'unit-a');
      await writeFile(join(worktree, 'dirty-untracked.txt'), 'must survive recovery\n');
      await a.claims.acquire(acquisition(a, 'group-a-wait', 'src/b.ts', 'unit-a', true, 'implement', 'materialization-read-expansion'));
      await b.claims.acquire(acquisition(b, 'group-b-wait', 'src/a.ts', 'unit-b', true, 'implement', 'materialization-read-expansion'));
      const status = await client.query('status', a.context.repo_id, a.context.workstream_run);
      const resolution = array(status.payload['deadlock_resolutions'], 'deadlock resolutions').map(parseCoordinationDeadlockResolution).find((entry) => entry.state === 'resolved');
      assert.equal(resolution?.victim_class, 2);
      assert.equal(resolution?.victim?.workstream_run, b.context.workstream_run);
      assert.equal(array(status.payload['edit_leases'], 'dirty non-victim edit leases').length > 0, true);
      assert.equal(await readFile(join(worktree, 'dirty-untracked.txt'), 'utf8'), 'must survive recovery\n');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('resolves a multi-cycle strongly connected component to a transactional fixed point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-deadlock-fixed-point-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const actors = await Promise.all(['a', 'b', 'c', 'd'].map(async (suffix) => await attachActor(client, stateRoot, repoRoot, suffix)));
      const [a, b, c, d] = actors;
      if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error('fixed-point actors missing');
      for (const [actor, suffix] of [[a, 'a'], [b, 'b'], [c, 'c'], [d, 'd']] as const) await actor.claims.acquire(acquisition(actor, `group-${suffix}-held`, `src/${suffix}.ts`, `unit-${suffix}`));
      const expansion = async (actor: Actor, suffix: string, paths: readonly string[]): Promise<void> => {
        await actor.claims.acquire({ ...acquisition(actor, `group-${suffix}-wait`, paths[0] ?? 'src/missing.ts', `unit-${suffix}`, true, 'implement', 'materialization-read-expansion'), requestedLeases: paths.map((path) => ({ path, mode: 'READ' as const, purpose: 'fixed-point dependency' })) });
      };
      await expansion(b, 'b', ['src/a.ts', 'src/c.ts']);
      await expansion(a, 'a', ['src/d.ts']);
      await expansion(c, 'c', ['src/d.ts']);
      await expansion(d, 'd', ['src/b.ts']);
      const status = await client.query('status', a.context.repo_id, a.context.workstream_run);
      const edges = array(status.payload['wait_for_edges'], 'wait edges').map(parseCoordinationWaitForEdge);
      assert.equal(detectCoordinationWaitCycles(edges).length, 0);
      const statusC = await client.query('status', c.context.repo_id, c.context.workstream_run);
      const resolvedIds = new Set([...array(status.payload['deadlock_resolutions'], 'deadlock resolutions'), ...array(statusC.payload['deadlock_resolutions'], 'deadlock resolutions c')].map(parseCoordinationDeadlockResolution).filter((entry) => entry.state === 'resolved').map((entry) => entry.resolution_id));
      assert.equal(resolvedIds.size >= 2, true);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('drives a real running checkpoint victim into child preemption and recovery without releasing authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-deadlock-running-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    let server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const a = await attachActor(client, stateRoot, repoRoot, 'a');
      const b = await attachActor(client, stateRoot, repoRoot, 'b');
      await a.claims.acquire(acquisition(a, 'group-a-held', 'src/a.ts', 'unit-a'));
      await b.claims.acquire(acquisition(b, 'group-b-held', 'src/b.ts', 'unit-b'));
      const childA = await registerRunningChild(client, a, 'unit-a');
      const childB = await registerRunningChild(client, b, 'unit-b');
      for (const [actor, child, unit] of [[a, childA, 'unit-a'], [b, childB, 'unit-b']] as const) {
        await client.mutate('checkpoint-child', { repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: 1, idempotencyKey: `checkpoint-${unit}` }, { child_lease_id: child.childId, child_token: child.token, pid: process.pid, boot_id: actor.context.boot_id, checkpoint_ordinal: 1, critical_section: null, preemptible: true });
      }
      await a.claims.acquire(acquisition(a, 'group-a-wait', 'src/b.ts', 'unit-a', true, 'implement', 'materialization-read-expansion'));
      await b.claims.acquire(acquisition(b, 'group-b-wait', 'src/a.ts', 'unit-b', true, 'implement', 'materialization-read-expansion'));
      const status = await client.query('status', a.context.repo_id, a.context.workstream_run);
      const resolution = array(status.payload['deadlock_resolutions'], 'deadlock resolutions').map(parseCoordinationDeadlockResolution).find((entry) => entry.state === 'awaiting-recovery');
      assert.equal(resolution?.victim_class, 3);
      if (resolution?.victim === null || resolution?.victim === undefined) throw new Error('running victim missing');
      const victimActor = resolution.victim.workstream_run === a.context.workstream_run ? a : b;
      await server.close();
      server = await startCoordinatorServer(coordinatorRuntimePaths(env));
      const replayed = await client.query('status', victimActor.context.repo_id, victimActor.context.workstream_run);
      assert.equal(array(replayed.payload['deadlock_resolutions'], 'replayed running resolutions').map(parseCoordinationDeadlockResolution).some((entry) => entry.resolution_id === resolution.resolution_id && entry.state === 'awaiting-recovery'), true);
      const victimChild = resolution.victim.workstream_run === a.context.workstream_run ? childA : childB;
      const heartbeat = await client.mutate('heartbeat-child', { repoId: victimActor.context.repo_id, workstreamRun: victimActor.context.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: 1, idempotencyKey: 'victim-preemption-heartbeat' }, { child_lease_id: victimChild.childId, child_token: victimChild.token, pid: process.pid, boot_id: victimActor.context.boot_id, lease_expires_at: '2099-01-01T00:00:00.000Z' });
      assert.equal(heartbeat.payload['preemption_requested'], true);
      await client.mutate('complete-child', { repoId: victimActor.context.repo_id, workstreamRun: victimActor.context.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: 2, idempotencyKey: 'victim-recovery-required' }, { child_lease_id: victimChild.childId, child_token: victimChild.token, pid: process.pid, boot_id: victimActor.context.boot_id, status: 'recovery-required', evidence_ref: null, evidence_sha256: null });
      const after = await client.query('status', victimActor.context.repo_id, victimActor.context.workstream_run);
      assert.equal(array(after.payload['edit_leases'], 'victim edit leases').length > 0, true);
      assert.equal(array(after.payload['escalations'], 'escalations').length, 0);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('keeps a real no-safe-victim cycle explicitly deferred without escalation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-deadlock-defer-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    let server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const a = await attachActor(client, stateRoot, repoRoot, 'a');
      const b = await attachActor(client, stateRoot, repoRoot, 'b');
      await a.claims.acquire(acquisition(a, 'group-a-held', 'src/a.ts', 'unit-a', false));
      await b.claims.acquire(acquisition(b, 'group-b-held', 'src/b.ts', 'unit-b', false));
      await registerRunningChild(client, a, 'unit-a');
      await registerRunningChild(client, b, 'unit-b');
      await a.claims.acquire(acquisition(a, 'group-a-wait', 'src/b.ts', 'unit-a', false, 'implement', 'materialization-read-expansion'));
      await b.claims.acquire(acquisition(b, 'group-b-wait', 'src/a.ts', 'unit-b', false, 'implement', 'materialization-read-expansion'));
      const status = await client.query('status', a.context.repo_id, a.context.workstream_run);
      const resolution = array(status.payload['deadlock_resolutions'], 'deadlock resolutions').map(parseCoordinationDeadlockResolution)[0];
      assert.equal(resolution?.state, 'deferred-no-safe-victim');
      assert.equal(resolution?.victim, null);
      const requests = array(status.payload['claim_requests'], 'claim requests').map(parseCoordinationClaimRequest);
      assert.equal(requests.filter((request) => request.status === 'deferred').length, 2);
      assert.equal(requests.every((request) => request.release_condition !== null), true);
      assert.equal(array(status.payload['escalations'], 'escalations').length, 0);
      await server.close();
      const database = new DatabaseSync(coordinatorRuntimePaths(env).databasePath);
      database.exec('DELETE FROM deadlock_resolutions; DELETE FROM wait_for_edges;');
      database.close();
      server = await startCoordinatorServer(coordinatorRuntimePaths(env));
      const replayed = await client.query('status', a.context.repo_id, a.context.workstream_run);
      const replayedResolution = array(replayed.payload['deadlock_resolutions'], 'replayed deadlock resolutions').map(parseCoordinationDeadlockResolution).find((entry) => entry.state === 'deferred-no-safe-victim');
      assert.equal(replayedResolution?.resolution_id, resolution?.resolution_id);
      assert.equal(array(replayed.payload['escalations'], 'replayed escalations').length, 0);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('mechanically rejects every operational escalation class', () => {
    for (const reason of COORDINATION_OPERATIONAL_ESCALATION_REASONS) assert.throws(() => rejectOperationalEscalation(reason), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-request' && error.evidence.includes(reason));
  });

  void it('accepts exactly one independently adjudicated contradiction and rejects operational packets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-contradiction-'));
    const repoRoot = join(root, 'repo');
    await mkdir(repoRoot, { recursive: true });
    git(repoRoot, ['init']);
    const missionTemplate = (requirement: string): string => `# Mission\n\n## Goal\n${requirement}\n\n## Non-goals / exclusions\nNone.\n\n## Perfect-quality bar\nExact.\n\n## Definition of done\nRequirement holds.\n\n## Key constraints\nAuthoritative.\n\n## Current strategy summary\nAdjudicate.\n\n## Open questions\nNone.\n`;
    const missionA = Buffer.from(missionTemplate('The shared artifact must remain text.'));
    const missionB = Buffer.from(missionTemplate('The shared artifact must become binary.'));
    await writeFile(join(repoRoot, 'mission-a.md'), missionA);
    await writeFile(join(repoRoot, 'mission-b.md'), missionB);
    git(repoRoot, ['add', 'mission-a.md', 'mission-b.md']);
    git(repoRoot, ['commit', '-m', 'authoritative contradiction fixtures']);
    const authoritativeCommit = git(repoRoot, ['rev-parse', 'HEAD']);
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const a = await attachActor(client, stateRoot, repoRoot, 'a');
      const b = await attachActor(client, stateRoot, repoRoot, 'b');
      const adjudicator = await attachActor(client, stateRoot, repoRoot, 'c');
      await adjudicator.claims.acquire(acquisition(adjudicator, 'group-adjudicator', 'reviews/contradiction.json', 'unit-adjudicate', true, 'adjudicate'));
      const clauses = [
        { authoritative_ref: { ref: 'mission-a.md', sha256: digest(missionA) }, source_type: 'mission' as const, source_scope: 'repository' as const, source_run: a.context.workstream_run, schema_version: 'autopilot.mission.v1', clause_id: 'format-text', exact_requirement: 'The shared artifact must remain text.', artifact_or_invariant: 'shared artifact format', demanded_outcome: 'text' },
        { authoritative_ref: { ref: 'mission-b.md', sha256: digest(missionB) }, source_type: 'mission' as const, source_scope: 'repository' as const, source_run: b.context.workstream_run, schema_version: 'autopilot.mission.v1', clause_id: 'format-binary', exact_requirement: 'The shared artifact must become binary.', artifact_or_invariant: 'shared artifact format', demanded_outcome: 'binary' },
      ];
      const firstClause = clauses[0];
      const secondClause = clauses[1];
      if (firstClause === undefined || secondClause === undefined) throw new Error('contradiction clauses missing');
      const arbiter = new PlanningContradictionClient(client, a.context);
      const peerArbiter = new PlanningContradictionClient(client, b.context);
      const artifactA = await arbiter.registerAuthoritativeArtifact({ artifactId: 'artifact-mission-a', sourceType: 'mission', sourceScope: 'repository', documentSchemaVersion: 'autopilot.mission.v1', gitCommit: authoritativeCommit, evidence: firstClause.authoritative_ref });
      const artifactB = await peerArbiter.registerAuthoritativeArtifact({ artifactId: 'artifact-mission-b', sourceType: 'mission', sourceScope: 'repository', documentSchemaVersion: 'autopilot.mission.v1', gitCommit: authoritativeCommit, evidence: secondClause.authoritative_ref });
      await writeFile(join(repoRoot, 'mission-a.md'), missionTemplate('FORGED mutable replacement that must not affect registered evidence.'));
      const adjudication = {
        schema_version: 'autopilot.planning_contradiction_adjudication.v1', adjudication_id: 'contradiction-format', adjudicator: { repo_id: adjudicator.context.repo_id, autopilot_id: adjudicator.context.autopilot_id, workstream_run: adjudicator.context.workstream_run, unit_id: 'unit-adjudicate', attempt: 1 }, adjudicator_role: 'adjudicate',
        independent_from_runs: [a.context.workstream_run, b.context.workstream_run], verdict: 'major-contradiction', conflicting_clauses: clauses,
        sequencing_can_satisfy_both: false, partitioning_can_satisfy_both: false, ownership_transfer_can_satisfy_both: false, rebase_revalidation_can_satisfy_both: false, replanning_can_preserve_both: false,
        operational_reasons: [], decision_options: ['retain text requirement', 'adopt binary requirement'],
      } as const;
      const assignmentInput = { schema_version: 'autopilot.adjudication_assignment.v1' as const, assignment_id: 'contradiction-format', repo_id: a.context.repo_id, requesting_run: a.context.workstream_run, participating_runs: [a.context.workstream_run, b.context.workstream_run], authoritative_artifact_ids: [artifactA.artifact_id, artifactB.artifact_id], conflicting_clauses: clauses, adjudicator: adjudication.adjudicator, decision_options: adjudication.decision_options, state: 'assigned' as const, adjudication: null, child_lease_id: null, assigned_event_seq: 0, accepted_event_seq: null, version: 1 };
      const assignment = await arbiter.assign(assignmentInput);
      await assert.rejects(() => arbiter.assign({ ...assignmentInput, assignment_id: 'contradiction-duplicate-owner' }), (error: unknown) => error instanceof CoordinationRuntimeError && /already has a live/u.test(error.message));
      const adjudicatorWorktree = await registerUnitWorktree(client, adjudicator, repoRoot, 'unit-adjudicate');
      const adjudicationBytes = Buffer.from(`${JSON.stringify(adjudication, null, 2)}\n`);
      const adjudicationRef = `adjudications/${assignment.assignment_id}.json`;
      const adjudicationPath = join(adjudicatorWorktree, adjudicationRef);
      const packet: CoordinationEscalation = {
        schema_version: 'autopilot.planning_contradiction.v1', escalation_id: assignment.assignment_id, repo_id: a.context.repo_id, participating_runs: [a.context.workstream_run, b.context.workstream_run],
        authoritative_refs: clauses.map((clause) => clause.authoritative_ref), conflicting_clauses: clauses, exhausted_alternatives: ['sequencing', 'partitioning', 'ownership-transfer', 'rebase-revalidation', 'replanning'],
        adjudication: { ref: adjudicationRef, sha256: digest(adjudicationBytes) }, decision_options: adjudication.decision_options, created_event_seq: 0, version: 1,
      };
      assert.equal(validatePlanningContradictionSubmission({ packet, adjudicationBytes, authoritativeDocuments: [{ ref: packet.authoritative_refs[0] ?? firstClause.authoritative_ref, bytes: missionA }, { ref: packet.authoritative_refs[1] ?? secondClause.authoritative_ref, bytes: missionB }] }).packet.escalation_id, packet.escalation_id);
      await assert.rejects(() => arbiter.submit(packet, assignment.assignment_id), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-state');
      await runAdjudicatorProcess([stateRoot, adjudicator.context.repo_id, adjudicator.context.workstream_run, assignment.assignment_id, adjudicator.context.autopilot_id, adjudicator.context.session_id, String(adjudicator.context.session_generation), String(adjudicator.context.run_version), adjudicator.context.session_lease_id, adjudicator.context.session_token, adjudicator.context.boot_id, adjudicatorWorktree, 'unit-adjudicate'], env);
      await writeFile(adjudicationPath, '{"forged_after_acceptance":true}\n');
      const accepted = await arbiter.submit(packet, assignment.assignment_id);
      assert.equal(accepted.created_event_seq > 0, true);
      const replay = await arbiter.submit(packet, assignment.assignment_id);
      assert.equal(replay.created_event_seq, accepted.created_event_seq);
      const status = await client.query('status', a.context.repo_id, a.context.workstream_run);
      assert.equal(array(status.payload['escalations'], 'escalations').map(parseCoordinationEscalation).length, 1);
      const adjudicatorStatus = await client.query('status', adjudicator.context.repo_id, adjudicator.context.workstream_run);
      assert.equal(array(adjudicatorStatus.payload['edit_leases'], 'adjudicator leases').some((value) => parseCoordinationEditLease(value).owner.unit_id === 'unit-adjudicate'), false);

      await adjudicator.claims.acquire(acquisition(adjudicator, 'group-adjudicator-oversize', 'reviews/contradiction-oversize.json', 'unit-adjudicate-oversize', true, 'adjudicate'));
      const oversizedOwner = { ...adjudication.adjudicator, unit_id: 'unit-adjudicate-oversize' };
      const oversizedAssignment = await arbiter.assign({ schema_version: 'autopilot.adjudication_assignment.v1', assignment_id: 'contradiction-oversize', repo_id: a.context.repo_id, requesting_run: a.context.workstream_run, participating_runs: [a.context.workstream_run, b.context.workstream_run], authoritative_artifact_ids: [artifactA.artifact_id, artifactB.artifact_id], conflicting_clauses: clauses, adjudicator: oversizedOwner, decision_options: adjudication.decision_options, state: 'assigned', adjudication: null, child_lease_id: null, assigned_event_seq: 0, accepted_event_seq: null, version: 1 });
      const oversizedWorktree = await registerUnitWorktree(client, adjudicator, repoRoot, oversizedOwner.unit_id);
      const oversizedChild = await registerRunningChild(client, adjudicator, oversizedOwner.unit_id);
      const oversizedPath = join(oversizedWorktree, 'adjudications', `${oversizedAssignment.assignment_id}.json`);
      await mkdir(join(oversizedWorktree, 'adjudications'), { recursive: true });
      const forgedIdentityAdjudication = { ...adjudication, adjudication_id: oversizedAssignment.assignment_id, adjudicator: { ...oversizedOwner, unit_id: 'forged-adjudicator' } };
      await writeFile(oversizedPath, `${JSON.stringify(forgedIdentityAdjudication)}\n`);
      await assert.rejects(() => client.mutate('complete-adjudication', { repoId: adjudicator.context.repo_id, workstreamRun: adjudicator.context.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: 1, idempotencyKey: 'complete-forged-identity-adjudication' }, { assignment_id: oversizedAssignment.assignment_id, adjudication_path: oversizedPath, child_lease_id: oversizedChild.childId, child_token: oversizedChild.token, pid: process.pid, boot_id: adjudicator.context.boot_id }), (error: unknown) => error instanceof CoordinationRuntimeError && /does not exactly match/u.test(error.message));
      await writeFile(oversizedPath, 'x'.repeat(1024 * 1024 + 1));
      await assert.rejects(() => client.mutate('complete-adjudication', { repoId: adjudicator.context.repo_id, workstreamRun: adjudicator.context.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: 1, idempotencyKey: 'complete-oversized-adjudication' }, { assignment_id: oversizedAssignment.assignment_id, adjudication_path: oversizedPath, child_lease_id: oversizedChild.childId, child_token: oversizedChild.token, pid: process.pid, boot_id: adjudicator.context.boot_id }), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-request' && /no larger/u.test(error.message));
      await rm(oversizedPath);
      const outsideEvidence = join(root, 'outside-adjudication.json');
      await writeFile(outsideEvidence, adjudicationBytes);
      await symlink(outsideEvidence, oversizedPath);
      await assert.rejects(() => client.mutate('complete-adjudication', { repoId: adjudicator.context.repo_id, workstreamRun: adjudicator.context.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: 1, idempotencyKey: 'complete-symlink-adjudication' }, { assignment_id: oversizedAssignment.assignment_id, adjudication_path: oversizedPath, child_lease_id: oversizedChild.childId, child_token: oversizedChild.token, pid: process.pid, boot_id: adjudicator.context.boot_id }), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'unauthorized-client' && /non-symbolic/u.test(error.message));

      const operationalAdjudication = { ...adjudication, adjudication_id: 'contradiction-operational', operational_reasons: ['deadlock'] as const };
      const operationalBytes = Buffer.from(`${JSON.stringify(operationalAdjudication)}\n`);
      assert.throws(() => validatePlanningContradictionSubmission({ packet: { ...packet, escalation_id: 'contradiction-operational', adjudication: { ref: 'operational.json', sha256: digest(operationalBytes) } }, adjudicationBytes: operationalBytes, authoritativeDocuments: [{ ref: firstClause.authoritative_ref, bytes: missionA }, { ref: secondClause.authoritative_ref, bytes: missionB }] }), (error: unknown) => error instanceof CoordinationRuntimeError && /operational blockers/u.test(error.message));
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
