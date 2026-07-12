import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAcquisitionGroup, parseCoordinationClaimRequest, parseCoordinationMailboxCursor, parseCoordinationMessage, parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { recordCoordinatorReleaseEvidenceFromFile, replayPendingCoordinatorReconciliation, RunReconciliationClient } from '../../src/core/coordination/reconciliation.ts';
import { ReservationCoordinationClient } from '../../src/core/coordination/reservations.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import type { CoordinationAcquisitionGroup, CoordinationClaimRequest, CoordinationMessage, CoordinationReleaseCondition, CoordinatorResponseEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ActiveAutopilotRow, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';

interface Actor {
  readonly context: CoordinatorSessionContext;
  readonly negotiation: ClaimNegotiationClient;
  readonly reconciliation: RunReconciliationClient;
  readonly reservations: ReservationCoordinationClient;
}

interface Harness {
  readonly root: string;
  readonly stateRoot: string;
  readonly env: ProcessEnvLike;
  readonly client: CoordinatorClient;
  server: Awaited<ReturnType<typeof startCoordinatorServer>>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' } });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function token(seed: string): string {
  return seed.charCodeAt(0).toString(16).slice(-1).repeat(64);
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-offline-reconciliation-'));
  const repository = join(root, 'repository');
  await mkdir(repository, { recursive: true });
  git(repository, ['init', '-b', 'main']);
  await writeFile(join(repository, 'README.md'), 'offline reconciliation fixture\n', 'utf8');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'initial']);
  const stateRoot = join(root, 'state');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  return { root, stateRoot, env, server, client: new CoordinatorClient({ env, autoStart: false }) };
}

async function writeEvidence(stateRoot: string, actor: Actor, ref: string, content: string): Promise<`sha256:${string}`> {
  const path = join(stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main', ...ref.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

async function closeHarness(value: Harness): Promise<void> {
  await value.server.close();
  await rm(value.root, { recursive: true, force: true });
}

async function attachActor(client: CoordinatorClient, stateRoot: string, suffix: string, existingRun: boolean = false): Promise<Actor> {
  const repoId = 'repo-offline';
  const workstreamRun = `run-${suffix.charAt(0)}`;
  let run;
  if (existingRun) {
    const status = await client.query('status', repoId, workstreamRun);
    const runs = array(status.payload['runs'], 'runs');
    if (runs.length !== 1) throw new Error('expected one existing run');
    run = parseCoordinationRun(runs[0]);
  } else {
    const response = await client.mutate('attach-run', {
      repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}`,
    }, { repo_key: repoId, canonical_root: join(dirname(stateRoot), 'repository'), git_common_dir: join(dirname(stateRoot), 'repository', '.git'), autopilot_id: `autopilot-${suffix.charAt(0)}`, workstream: `work-${suffix.charAt(0)}`, coordination_authority: 'coordinator-edit-leases-v1' });
    run = parseCoordinationRun(response.payload['run']);
  }
  const generation = run.active_session_generation + 1;
  const sessionToken = token(suffix);
  const response = await client.mutate('attach-session', {
    repoId, workstreamRun, sessionId: `session-${suffix}`, fencingGeneration: generation, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}`,
  }, { session_lease_id: `session-lease-${suffix}`, session_token: sessionToken, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2000-01-01T00:00:00.000Z', handoff_token: null });
  const attachedRun = parseCoordinationRun(response.payload['run']);
  const session = parseCoordinationSessionLease(response.payload['session']);
  const mainWorktree = join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main');
  if (!existsSync(mainWorktree)) {
    await mkdir(dirname(mainWorktree), { recursive: true });
    git(join(dirname(stateRoot), 'repository'), ['worktree', 'add', '-b', `autopilot/${workstreamRun}`, mainWorktree, 'main']);
  }
  const context: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId,
    autopilot_id: attachedRun.autopilot_id, workstream: attachedRun.workstream, workstream_run: attachedRun.workstream_run,
    session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
    session_lease_id: session.session_lease_id, session_token: sessionToken, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  };
  return { context, negotiation: new ClaimNegotiationClient(client, context), reconciliation: new RunReconciliationClient(client, context), reservations: new ReservationCoordinationClient(client, context) };
}

function acquisitionInput(suffix: string, condition: CoordinationReleaseCondition, path = 'src/shared.ts') {
  return {
    acquisitionGroupId: `group-${suffix}`, unitId: `unit-${suffix}`, attempt: 1,
    requestedLeases: [{ path, mode: 'WRITE' as const, purpose: `implement ${suffix}` }],
    reason: `run ${suffix} needs ${path}`, normalReleaseCondition: condition,
    specRef: `.pi/autopilot/work-${suffix}/unit-specs/unit-${suffix}.json`, specSha256: `sha256:${suffix.charCodeAt(0).toString(16).slice(-1).repeat(64)}` as `sha256:${string}`,
    role: 'implement' as const, preemptible: true, checkpointOrdinal: 0,
  };
}

async function status(client: CoordinatorClient, actor: Actor): Promise<CoordinatorResponseEnvelope> {
  return await client.query('status', actor.context.repo_id, actor.context.workstream_run);
}

async function requests(client: CoordinatorClient, actor: Actor): Promise<readonly CoordinationClaimRequest[]> {
  return array((await status(client, actor)).payload['claim_requests'], 'claim_requests').map((entry) => parseCoordinationClaimRequest(entry));
}

async function groups(client: CoordinatorClient, actor: Actor): Promise<readonly CoordinationAcquisitionGroup[]> {
  return array((await status(client, actor)).payload['acquisition_groups'], 'acquisition_groups').map((entry) => parseCoordinationAcquisitionGroup(entry));
}

async function drain(client: CoordinatorClient, actor: Actor, id: string): Promise<{ readonly messages: readonly CoordinationMessage[]; readonly cursor: ReturnType<typeof parseCoordinationMailboxCursor> }> {
  const response = await client.mutate('drain-mailbox', {
    repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id,
    fencingGeneration: actor.context.session_generation, expectedVersion: actor.context.session_version, idempotencyKey: `drain-${id}`,
  }, { delivery_id: `delivery-${id}`, session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token });
  return {
    messages: array(response.payload['messages'], 'messages').map((entry) => parseCoordinationMessage(entry)),
    cursor: parseCoordinationMailboxCursor(response.payload['mailbox_cursor']),
  };
}

async function acknowledge(client: CoordinatorClient, actor: Actor, message: CoordinationMessage): Promise<void> {
  await client.mutate('acknowledge-message', {
    repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id,
    fencingGeneration: actor.context.session_generation, expectedVersion: message.version, idempotencyKey: `ack-${message.message_id}`,
  }, { message_id: message.message_id, session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token });
}

async function detach(client: CoordinatorClient, actor: Actor): Promise<void> {
  await client.mutate('detach-session', {
    repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id,
    fencingGeneration: actor.context.session_generation, expectedVersion: actor.context.session_version, idempotencyKey: `detach-${actor.context.session_lease_id}`,
  }, { reason: 'offline replay test', session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token });
}

void describe('Coordination Fabric offline replay and automatic reconciliation', () => {
  void it('releases a deferred child-terminal lease while both parents are offline, survives restart, and replays until durable acknowledgement', async () => {
    const value = await harness();
    try {
      const owner = await attachActor(value.client, value.stateRoot, 'a');
      const requester = await attachActor(value.client, value.stateRoot, 'b');
      const childId = 'child-run-a-unit-a-1';
      const ownerGrant = await owner.negotiation.acquire(acquisitionInput('a', { condition_type: 'child-terminal', target_id: childId, evidence: null }));
      assert.equal(ownerGrant.outcome, 'granted');
      const childToken = 'c'.repeat(64);
      const childResponse = await value.client.mutate('register-child', {
        repoId: owner.context.repo_id, workstreamRun: owner.context.workstream_run, sessionId: owner.context.session_id,
        fencingGeneration: owner.context.session_generation, expectedVersion: owner.context.run_version, idempotencyKey: 'register-offline-child',
      }, { child_lease_id: childId, autopilot_id: owner.context.autopilot_id, unit_id: 'unit-a', attempt: 1, pid: process.pid, boot_id: 'boot-child', child_token: childToken, lease_expires_at: '2099-01-01T00:00:00.000Z', session_lease_id: owner.context.session_lease_id, session_token: owner.context.session_token });
      const child = childResponse.payload['child'];
      if (typeof child !== 'object' || child === null || Array.isArray(child) || typeof (child as Readonly<Record<string, unknown>>)['version'] !== 'number') throw new Error('invalid child response');
      const childVersion = (child as Readonly<Record<string, unknown>>)['version'];
      if (typeof childVersion !== 'number') throw new Error('missing child version');

      const waiting = await requester.negotiation.acquire(acquisitionInput('b', { condition_type: 'unit-merged', target_id: 'unit-b:1', evidence: null }));
      assert.equal(waiting.outcome, 'waiting-for-peer-release');
      const ownerRequest = (await requests(value.client, owner)).find((entry) => entry.requester.workstream_run === requester.context.workstream_run);
      if (ownerRequest === undefined) throw new Error('owner request missing');
      const deferred = await owner.negotiation.respond({ request: ownerRequest, response: 'deferred', ownerReason: 'child still owns the edit lease', releaseCondition: { condition_type: 'child-terminal', target_id: childId, evidence: null } });
      assert.equal(deferred.status, 'deferred');
      await detach(value.client, owner);
      await detach(value.client, requester);

      const terminalEvidenceRef = '.pi/autopilot/work-a/receipts/unit-a.json';
      const terminalEvidenceSha = await writeEvidence(value.stateRoot, owner, terminalEvidenceRef, JSON.stringify({ schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: owner.context.workstream, unit_id: 'unit-a', attempt: 1 }) + '\n');
      await value.client.mutate('complete-child', {
        repoId: owner.context.repo_id, workstreamRun: owner.context.workstream_run, sessionId: null, fencingGeneration: null,
        expectedVersion: childVersion, idempotencyKey: 'complete-offline-child',
      }, { child_lease_id: childId, child_token: childToken, pid: process.pid, boot_id: 'boot-child', status: 'terminal', evidence_ref: terminalEvidenceRef, evidence_sha256: terminalEvidenceSha });
      const requesterOfflineStatus = await status(value.client, requester);
      assert.equal(array(requesterOfflineStatus.payload['edit_leases'], 'requester edit leases').length, 0);
      assert.equal((await groups(value.client, requester))[0]?.state, 'grant-ready');
      assert.equal(typeof requesterOfflineStatus.payload['pending_messages'] === 'number' && requesterOfflineStatus.payload['pending_messages'] >= 2, true);

      await value.server.close();
      value.server = await startCoordinatorServer(coordinatorRuntimePaths(value.env));
      const resumedRequester = await attachActor(value.client, value.stateRoot, 'b-resumed', true);
      await resumedRequester.reconciliation.reconcile('resume-before-dispatch');
      const firstReplay = await drain(value.client, resumedRequester, 'requester-first-replay');
      assert.deepEqual(firstReplay.messages.map((entry) => entry.message_type).sort(), ['grant-offer', 'release-notification']);
      assert.equal(firstReplay.cursor.acknowledged_through_event_seq, 0);
      await detach(value.client, resumedRequester);

      const secondRequester = await attachActor(value.client, value.stateRoot, 'b-second', true);
      const secondReplay = await drain(value.client, secondRequester, 'requester-second-replay');
      assert.deepEqual(secondReplay.messages.map((entry) => entry.message_id), firstReplay.messages.map((entry) => entry.message_id));
      for (const message of secondReplay.messages) await acknowledge(value.client, secondRequester, message);
      const acknowledgedStatus = await status(value.client, secondRequester);
      const cursors = array(acknowledgedStatus.payload['mailbox_cursors'], 'mailbox cursors').map((entry) => parseCoordinationMailboxCursor(entry));
      assert.equal(cursors[0]?.acknowledged_through_event_seq, cursors[0]?.delivered_through_event_seq);
      const offered = (await groups(value.client, secondRequester))[0];
      if (offered === undefined) throw new Error('grant offer missing after replay');
      const grant = await secondRequester.negotiation.acknowledgeGrant(offered);
      assert.equal(grant.acquisitionGroup.state, 'granted');
    } finally {
      await closeHarness(value);
    }
  });

  void it('releases terminal leases for merge, reset, quarantine, and run-close evidence but never from heartbeat age', async () => {
    const value = await harness();
    try {
      const owner = await attachActor(value.client, value.stateRoot, 'a');
      const cases = [
        { suffix: 'm', source: 'unit-merge' as const, condition: 'unit-merged' as const, target: 'unit-m:1' },
        { suffix: 'r', source: 'attempt-reset' as const, condition: 'attempt-reset' as const, target: 'unit-r:1' },
        { suffix: 'q', source: 'quarantine-capture' as const, condition: 'quarantine-captured' as const, target: 'unit-q:1' },
      ];
      for (const entry of cases) {
        const grant = await owner.negotiation.acquire(acquisitionInput(entry.suffix, { condition_type: entry.condition, target_id: entry.target, evidence: null }, `src/${entry.suffix}.ts`));
        assert.equal(grant.outcome, 'granted');
      }
      assert.equal(array((await status(value.client, owner)).payload['edit_leases'], 'initial leases').length, 3);
      await assert.rejects(
        () => owner.reconciliation.recordReleaseEvidence({ source: 'unit-merge', targetId: 'unit-m:1', evidenceRef: '.pi/autopilot/work-a/evidence/m.json', evidenceSha256: `sha256:${'1'.repeat(64)}` }),
        /evidence file is unreadable/u,
      );
      const invalidEvidenceRef = '.pi/autopilot/work-a/evidence/m.json';
      await writeEvidence(value.stateRoot, owner, invalidEvidenceRef, JSON.stringify({ schema_version: 'autopilot.unit_merge.v1', workstream_run: owner.context.workstream_run, autopilot_id: owner.context.autopilot_id, unit_id: 'unit-m', attempt: 1, merge_commit_sha: 'abc1234' }) + '\n');
      await assert.rejects(
        () => owner.reconciliation.recordReleaseEvidence({ source: 'unit-merge', targetId: 'unit-m:1', evidenceRef: invalidEvidenceRef, evidenceSha256: `sha256:${'2'.repeat(64)}` }),
        /hash does not match/u,
      );
      const wrongIdentitySha = await writeEvidence(value.stateRoot, owner, invalidEvidenceRef, JSON.stringify({ schema_version: 'autopilot.unit_merge.v1', workstream_run: owner.context.workstream_run, autopilot_id: owner.context.autopilot_id, unit_id: 'unit-other', attempt: 1, merge_commit_sha: 'abc1234' }) + '\n');
      await assert.rejects(
        () => owner.reconciliation.recordReleaseEvidence({ source: 'unit-merge', targetId: 'unit-m:1', evidenceRef: invalidEvidenceRef, evidenceSha256: wrongIdentitySha }),
        /unit_id does not match/u,
      );
      assert.equal(array((await status(value.client, owner)).payload['edit_leases'], 'leases after rejected evidence').length, 3);
      const doctor = await value.client.query('doctor');
      assert.equal(array(doctor.payload['expired_session_classifications'], 'expired sessions').length, 1);
      await owner.reconciliation.reconcile('expired-heartbeat-is-classification-only');
      assert.equal(array((await status(value.client, owner)).payload['edit_leases'], 'leases after expiry reconciliation').length, 3);

      for (const entry of cases) {
        const evidenceRef = `.pi/autopilot/work-a/evidence/${entry.suffix}.json`;
        const integrationHead = git(join(value.stateRoot, 'worktrees', owner.context.repo_id, 'active', owner.context.workstream_run, 'main'), ['rev-parse', 'HEAD']);
        const document = entry.source === 'unit-merge'
          ? { schema_version: 'autopilot.unit_merge.v1', workstream_run: owner.context.workstream_run, autopilot_id: owner.context.autopilot_id, unit_id: 'unit-m', attempt: 1, merge_commit_sha: integrationHead, integration_before: integrationHead, integration_after: integrationHead, execution_commit_ref: 'execution-commits/unit-m.json', changed_paths: [] }
          : entry.source === 'attempt-reset'
            ? { schema_version: 'autopilot.unit_failure.v1', workstream_run: owner.context.workstream_run, unit_id: 'unit-r', attempt: 1, action: 'reset' }
            : { schema_version: 'autopilot.unit_failure.v1', workstream_run: owner.context.workstream_run, unit_id: 'unit-q', attempt: 1, action: 'quarantine', capture_commit_sha: 'abc1234' };
        const evidenceSha256 = await writeEvidence(value.stateRoot, owner, evidenceRef, `${JSON.stringify(document)}\n`);
        await owner.reconciliation.recordReleaseEvidence({ source: entry.source, targetId: entry.target, evidenceRef, evidenceSha256 });
      }
      assert.equal(array((await status(value.client, owner)).payload['edit_leases'], 'leases after terminal evidence').length, 0);

      const closeGrant = await owner.negotiation.acquire(acquisitionInput('z', { condition_type: 'run-closed', target_id: owner.context.workstream_run, evidence: null }, 'src/close.ts'));
      assert.equal(closeGrant.outcome, 'granted');
      await owner.reservations.prepareRunTerminal('closed');
      const closeEvidenceRef = '.pi/autopilot/work-a/close/run-terminal.json';
      const closeTerminalSha = git(join(value.root, 'repository'), ['rev-parse', 'HEAD']);
      const closeEvidenceSha = await writeEvidence(value.stateRoot, owner, closeEvidenceRef, `${JSON.stringify({ schema_version: 'autopilot.run_terminal.v1', repo_key: owner.context.repo_id, autopilot_id: owner.context.autopilot_id, workstream_run: owner.context.workstream_run, outcome: 'closed', terminal_sha: closeTerminalSha })}\n`);
      const closed = await owner.reconciliation.recordReleaseEvidence({ source: 'run-close', targetId: owner.context.workstream_run, evidenceRef: closeEvidenceRef, evidenceSha256: closeEvidenceSha });
      assert.equal(closed.reconciliation.released_lease_ids.length, 1);
      const replayedClose = await owner.reconciliation.recordReleaseEvidence({ source: 'run-close', targetId: owner.context.workstream_run, evidenceRef: closeEvidenceRef, evidenceSha256: closeEvidenceSha });
      assert.equal(replayedClose.evidence.reconciliation_evidence_id, closed.evidence.reconciliation_evidence_id);
      await assert.rejects(() => owner.negotiation.acquire(acquisitionInput('post-close', { condition_type: 'unit-merged', target_id: 'unit-post-close:1', evidence: null }, 'src/post-close.ts')), /terminal run run-a rejects new coordination action acquire-group/u);
      await assert.rejects(() => attachActor(value.client, value.stateRoot, 'a-terminal', true), /terminal run run-a cannot accept/u);
      assert.equal(array((await status(value.client, owner)).payload['edit_leases'], 'leases after run close').length, 0);

      const abortedOwner = await attachActor(value.client, value.stateRoot, 'c');
      await abortedOwner.negotiation.acquire(acquisitionInput('c', { condition_type: 'run-closed', target_id: abortedOwner.context.workstream_run, evidence: null }, 'src/abort.ts'));
      await abortedOwner.reservations.prepareRunTerminal('aborted');
      const abortEvidenceRef = '.pi/autopilot/work-c/close/run-terminal.json';
      const abortTerminalSha = git(join(value.stateRoot, 'worktrees', abortedOwner.context.repo_id, 'active', abortedOwner.context.workstream_run, 'main'), ['rev-parse', 'HEAD']);
      const abortEvidenceSha = await writeEvidence(value.stateRoot, abortedOwner, abortEvidenceRef, `${JSON.stringify({ schema_version: 'autopilot.run_terminal.v1', repo_key: abortedOwner.context.repo_id, autopilot_id: abortedOwner.context.autopilot_id, workstream_run: abortedOwner.context.workstream_run, outcome: 'aborted', terminal_sha: abortTerminalSha })}\n`);
      await abortedOwner.reconciliation.recordReleaseEvidence({ source: 'run-abort', targetId: abortedOwner.context.workstream_run, evidenceRef: abortEvidenceRef, evidenceSha256: abortEvidenceSha });
      const abortedRunStatus = await status(value.client, abortedOwner);
      const abortedRuns = array(abortedRunStatus.payload['runs'], 'aborted runs').map((entry) => parseCoordinationRun(entry));
      assert.equal(abortedRuns[0]?.status, 'aborted');
      assert.equal(array(abortedRunStatus.payload['edit_leases'], 'leases after run abort').length, 0);
    } finally {
      await closeHarness(value);
    }
  });

  void it('replays a durable lifecycle-to-coordinator intent before resumed dispatch', async () => {
    const value = await harness();
    try {
      const owner = await attachActor(value.client, value.stateRoot, 'a');
      await owner.negotiation.acquire(acquisitionInput('a', { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null }));
      const mainWorktree = join(value.stateRoot, 'worktrees', owner.context.repo_id, 'active', owner.context.workstream_run, 'main');
      const runtimeRoot = join(mainWorktree, '.pi', 'autopilot', 'work-a');
      const active: ActiveAutopilotRow = {
        schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: owner.context.autopilot_id, workstream: owner.context.workstream,
        workstream_run: owner.context.workstream_run, repo_key: owner.context.repo_id, source_repo: join(value.root, 'repository'),
        git_common_dir: join(value.root, 'repository', '.git'), worktree_root: join(value.stateRoot, 'worktrees', owner.context.repo_id),
        main_worktree_path: mainWorktree, branch: 'autopilot/run-a', runtime_root: runtimeRoot, target_branch: 'main', target_base_sha: 'a'.repeat(40),
        origin_url: null, pid: process.pid, boot_id: owner.context.boot_id, status: 'active', started_at: '2026-07-11T00:00:00.000Z',
        active_run_epoch: 1, active_epoch_started_at: '2026-07-11T00:00:00.000Z', active_run_receipt_id: 'receipt-run-a',
      };
      const evidenceRef = '.pi/autopilot/work-a/unit-merges/unit-a.json';
      const integrationHead = git(mainWorktree, ['rev-parse', 'HEAD']);
      await writeEvidence(value.stateRoot, owner, evidenceRef, `${JSON.stringify({ schema_version: 'autopilot.unit_merge.v1', workstream_run: owner.context.workstream_run, autopilot_id: owner.context.autopilot_id, unit_id: 'unit-a', attempt: 1, merge_commit_sha: integrationHead, integration_before: integrationHead, integration_after: integrationHead, execution_commit_ref: 'execution-commits/unit-a.json', changed_paths: [] })}\n`);
      const evidencePath = join(mainWorktree, ...evidenceRef.split('/'));
      const pendingRoot = join(runtimeRoot, 'coordination-reconciliation', 'pending');
      await assert.rejects(
        () => recordCoordinatorReleaseEvidenceFromFile({ active, source: 'unit-merge', targetId: 'unit-a:1', evidencePath, env: value.env }),
        /evidence was preserved.*requires a current attached session/u,
      );
      assert.equal((await readdir(pendingRoot, { withFileTypes: true })).filter((entry) => entry.isFile()).length, 1);
      const sessionContextPath = join(value.stateRoot, 'replay-session-context.json');
      await writeCoordinatorSessionContext(sessionContextPath, owner.context);
      const replayEnv = { ...value.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: sessionContextPath };
      const replayed = await replayPendingCoordinatorReconciliation({ active, env: replayEnv });
      assert.equal(replayed.length, 1);
      assert.equal(array((await status(value.client, owner)).payload['edit_leases'], 'leases after pending replay').length, 0);
      assert.deepEqual((await readdir(pendingRoot, { withFileTypes: true })).map((entry) => entry.name), []);
    } finally {
      await closeHarness(value);
    }
  });

  void it('repairs a committed terminal-child fact left before release when the coordinator restarts', async () => {
    const value = await harness();
    try {
      const owner = await attachActor(value.client, value.stateRoot, 'a');
      const requester = await attachActor(value.client, value.stateRoot, 'b');
      const childId = 'child-run-a-unit-a-1';
      await owner.negotiation.acquire(acquisitionInput('a', { condition_type: 'child-terminal', target_id: childId, evidence: null }));
      const childToken = 'd'.repeat(64);
      await value.client.mutate('register-child', {
        repoId: owner.context.repo_id, workstreamRun: owner.context.workstream_run, sessionId: owner.context.session_id,
        fencingGeneration: owner.context.session_generation, expectedVersion: owner.context.run_version, idempotencyKey: 'register-restart-child',
      }, { child_lease_id: childId, autopilot_id: owner.context.autopilot_id, unit_id: 'unit-a', attempt: 1, pid: process.pid, boot_id: 'boot-child', child_token: childToken, lease_expires_at: '2099-01-01T00:00:00.000Z', session_lease_id: owner.context.session_lease_id, session_token: owner.context.session_token });
      await requester.negotiation.acquire(acquisitionInput('b', { condition_type: 'unit-merged', target_id: 'unit-b:1', evidence: null }));
      const recoveryEvidenceRef = '.pi/autopilot/work-a/receipts/unit-a.json';
      const recoveryEvidenceSha = await writeEvidence(value.stateRoot, owner, recoveryEvidenceRef, JSON.stringify({ schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: owner.context.workstream, unit_id: 'unit-a', attempt: 1 }) + '\n');
      await value.server.close();

      const database = new DatabaseSync(coordinatorRuntimePaths(value.env).databasePath);
      database.prepare("UPDATE child_leases SET status='terminal', terminal_evidence_ref=?, terminal_evidence_sha256=?, version=version+1 WHERE child_lease_id=?").run(recoveryEvidenceRef, recoveryEvidenceSha, childId);
      database.close();
      value.server = await startCoordinatorServer(coordinatorRuntimePaths(value.env));

      assert.equal(array((await status(value.client, owner)).payload['edit_leases'], 'owner leases after startup reconciliation').length, 0);
      assert.equal((await groups(value.client, requester))[0]?.state, 'grant-ready');
      const requesterStatus = await status(value.client, requester);
      assert.equal(typeof requesterStatus.payload['pending_messages'] === 'number' && requesterStatus.payload['pending_messages'] >= 2, true);
      const doctor = await value.client.query('doctor');
      const startup = doctor.payload['last_startup_reconciliation'];
      if (typeof startup !== 'object' || startup === null || Array.isArray(startup)) throw new Error('startup reconciliation summary missing');
      assert.equal(array((startup as Readonly<Record<string, unknown>>)['released_lease_ids'], 'startup released leases').length, 1);
    } finally {
      await closeHarness(value);
    }
  });
});
