import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAcquisitionGroup, parseCoordinationClaimRequest, parseCoordinationMailboxCursor, parseCoordinationMessage, parseCoordinationRun, parseCoordinationSessionLease, parseCoordinationUnitAttempt } from '../../src/core/coordination/contracts.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { recordCoordinatorReleaseEvidenceFromFile, replayPendingCoordinatorReconciliation, RunReconciliationClient } from '../../src/core/coordination/reconciliation.ts';
import { ReservationCoordinationClient } from '../../src/core/coordination/reservations.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { proveStructuredAttemptTerminal } from '../../src/core/coordination/terminal-attempt-proof.ts';
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

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Readonly<Record<string, unknown>>;
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
    }, {
      repo_key: repoId, canonical_root: join(dirname(stateRoot), 'repository'), git_common_dir: join(dirname(stateRoot), 'repository', '.git'), autopilot_id: `autopilot-${suffix.charAt(0)}`, workstream: `work-${suffix.charAt(0)}`, coordination_authority: 'coordinator-edit-leases-v1',
      run_resource: {
        schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun,
        source_repo: join(dirname(stateRoot), 'repository'), git_common_dir: join(dirname(stateRoot), 'repository', '.git'), worktree_root: join(stateRoot, 'worktrees', repoId),
        main_worktree_path: join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main'), runtime_root: join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main', '.pi', 'autopilot', `work-${suffix.charAt(0)}`),
        branch: `autopilot/${workstreamRun}`, target_branch: 'main', target_base_sha: git(join(dirname(stateRoot), 'repository'), ['rev-parse', 'HEAD']), origin_url: null,
        started_at: '2026-07-12T00:00:00.000Z', version: 1,
      },
    });
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

async function writeTerminalFixtureSpec(value: Harness, actor: Actor, unitId: string): Promise<`sha256:${string}`> {
  const main = join(value.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main');
  const runtimeRoot = join(main, '.pi', 'autopilot', actor.context.workstream);
  const spec = {
    schema_version: 'autopilot.unit_spec.v1', workstream: actor.context.workstream, unit_id: unitId, role: 'implement', template: 'implement', attempt: 1,
    objective: 'Exercise offline terminal reconciliation.', cwd: main, model: 'openai-codex/gpt-5.6-terra', thinking: 'high', owned_paths: ['src/shared.ts'], read_only_paths: [], untouchable_paths: [], context_refs: [], validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', `${unitId}.json`), receipt_output: join(runtimeRoot, 'receipts', `${unitId}.json`), evidence_dir: join(runtimeRoot, 'evidence', unitId), stop_boundary: 'Edit only the owned fixture.', quality_profile: 'source-change', risk_level: 'medium',
    acceptance_criteria: ['offline completion is reconciled'], verification_plan: { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] }, closure_criteria: ['terminal evidence is durable'], upstream_refs: [], timeout_seconds: 3600, render_prompt_snapshot: true,
  };
  return await writeEvidence(value.stateRoot, actor, `.pi/autopilot/${actor.context.workstream}/unit-specs/${unitId}.json`, `${JSON.stringify(spec)}\n`);
}

async function writeTerminalAcceptance(value: Harness, actor: Actor, unitId: string, childId: string, specSha256: `sha256:${string}`): Promise<{ readonly ref: string; readonly sha256: `sha256:${string}` }> {
  const main = join(value.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main');
  const runtimeRoot = join(main, '.pi', 'autopilot', actor.context.workstream);
  const head = git(main, ['rev-parse', 'HEAD']);
  const specRef = `.pi/autopilot/${actor.context.workstream}/unit-specs/${unitId}.json`;
  const statusRef = `.pi/autopilot/${actor.context.workstream}/statuses/${unitId}.json`;
  const receiptRef = `.pi/autopilot/${actor.context.workstream}/receipts/${unitId}.json`;
  const auditRef = `.pi/autopilot/${actor.context.workstream}/execution-audits/${unitId}.implement.attempt-1.json`;
  const statusSha256 = await writeEvidence(value.stateRoot, actor, statusRef, `${JSON.stringify({ schema_version: 'autopilot.status.v1', workstream: actor.context.workstream, unit_id: unitId, role: 'implement', attempt: 1, verdict: 'BLOCKED', severity: 'major-local', summary: 'Offline terminal fixture is blocked.', changed_paths: [], findings: [], commands: [], evidence_refs: [], report_ref: null, next_action: 'resume after peer release' })}\n`);
  const toolCallId = `tool-${unitId}`;
  const receiptSha256 = await writeEvidence(value.stateRoot, actor, receiptRef, `${JSON.stringify({ schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: actor.context.workstream, unit_id: unitId, role: 'implement', attempt: 1, emitted_at: '2026-07-12T10:00:00.000Z', status_output: join(runtimeRoot, 'statuses', `${unitId}.json`), status_sha256: statusSha256, schema_sha256: `sha256:${'a'.repeat(64)}`, tool_call_id: toolCallId, provider_identity: { provider_id: 'openai-codex', requested_model_id: 'openai-codex/gpt-5.6-terra', executed_model_id: 'openai-codex/gpt-5.6-terra', api: 'openai-codex-responses', thinking_level: 'high' }, expected_identity_hash: `sha256:${'b'.repeat(64)}` })}\n`);
  const auditSha256 = await writeEvidence(value.stateRoot, actor, auditRef, `${JSON.stringify({ schema_version: 'autopilot.execution_audit.v1', workstream: actor.context.workstream, unit_id: unitId, role: 'implement', attempt: 1, audited_at: '2026-07-12T10:00:00.000Z', cwd: main, git_head: head, baseline_head: head, post_run_head: head, head_change_kind: 'none', committed_changed_paths: [], dirty_baseline: false, dirty_baseline_paths: [], dirty_relevant_paths: [], actual_changed_paths: [], status_reported_changed_paths: [], omitted_status_changes: [], reported_but_not_actual_changes: [], outside_owned_paths: [], read_only_touched_paths: [], untouchable_touched_paths: [], path_counts: { dirty_baseline_paths: 0, dirty_relevant_paths: 0, actual_changed_paths: 0, status_reported_changed_paths: 0, omitted_status_changes: 0, reported_but_not_actual_changes: 0, outside_owned_paths: 0, read_only_touched_paths: 0, untouchable_touched_paths: 0 }, truncated_path_sets: [], declared_validation_commands: [], status_reported_commands: [], command_coverage_gaps: [], classification: 'clean', evidence_refs: [], summary: 'Offline terminal fixture has zero changes.' })}\n`);
  const ref = `.pi/autopilot/${actor.context.workstream}/terminal-acceptances/${unitId}.implement.attempt-1.json`;
  const sha256 = await writeEvidence(value.stateRoot, actor, ref, `${JSON.stringify({ schema_version: 'autopilot.child_terminal_acceptance.v1', repo_id: actor.context.repo_id, autopilot_id: actor.context.autopilot_id, workstream: actor.context.workstream, workstream_run: actor.context.workstream_run, unit_id: unitId, role: 'implement', attempt: 1, child_lease_id: childId, verdict: 'BLOCKED', transport_result: 'accepted', spec: { ref: specRef, sha256: specSha256 }, status: { ref: statusRef, sha256: statusSha256 }, receipt: { ref: receiptRef, sha256: receiptSha256 }, audit: { ref: auditRef, sha256: auditSha256 }, tool_call_id: toolCallId, carrier_status_sha256: statusSha256, audit_disposition: 'zero-change', created_at: '2026-07-12T10:01:00.000Z' })}\n`);
  return { ref, sha256 };
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
  void it('keeps source edit authority after offline child terminal, then replays exact merge release after owner resume', async () => {
    const value = await harness();
    try {
      const owner = await attachActor(value.client, value.stateRoot, 'a');
      const requester = await attachActor(value.client, value.stateRoot, 'b');
      const childId = 'child-run-a-unit-a-1';
      const specSha256 = await writeTerminalFixtureSpec(value, owner, 'unit-a');
      const ownerGrant = await owner.negotiation.acquire({ ...acquisitionInput('a', { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null }), specSha256 });
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
      const deferred = await owner.negotiation.respond({ request: ownerRequest, response: 'deferred', ownerReason: 'source edit authority remains through integration', releaseCondition: { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null } });
      assert.equal(deferred.status, 'deferred');
      await detach(value.client, owner);
      await detach(value.client, requester);

      const terminalEvidence = await writeTerminalAcceptance(value, owner, 'unit-a', childId, specSha256);
      await value.client.mutate('complete-child', {
        repoId: owner.context.repo_id, workstreamRun: owner.context.workstream_run, sessionId: null, fencingGeneration: null,
        expectedVersion: childVersion, idempotencyKey: 'complete-offline-child',
      }, { child_lease_id: childId, child_token: childToken, pid: process.pid, boot_id: 'boot-child', status: 'terminal', evidence_ref: terminalEvidence.ref, evidence_sha256: terminalEvidence.sha256 });
      const requesterOfflineStatus = await status(value.client, requester);
      assert.equal(array(requesterOfflineStatus.payload['edit_leases'], 'requester edit leases').length, 0);
      assert.equal((await groups(value.client, requester))[0]?.state, 'waiting');

      await value.server.close();
      value.server = await startCoordinatorServer(coordinatorRuntimePaths(value.env));
      const resumedOwner = await attachActor(value.client, value.stateRoot, 'a-resumed', true);
      const ownerMain = join(value.stateRoot, 'worktrees', resumedOwner.context.repo_id, 'active', resumedOwner.context.workstream_run, 'main');
      const integrationHead = git(ownerMain, ['rev-parse', 'HEAD']);
      const mergeRef = '.pi/autopilot/work-a/unit-merges/unit-a.json';
      const mergeSha = await writeEvidence(value.stateRoot, resumedOwner, mergeRef, `${JSON.stringify({ schema_version: 'autopilot.unit_merge.v1', workstream_run: resumedOwner.context.workstream_run, autopilot_id: resumedOwner.context.autopilot_id, unit_id: 'unit-a', attempt: 1, merge_commit_sha: integrationHead, integration_before: integrationHead, integration_after: integrationHead, execution_commit_ref: 'execution-commits/unit-a.json', changed_paths: [] })}\n`);
      await resumedOwner.reconciliation.recordReleaseEvidence({ source: 'unit-merge', targetId: 'unit-a:1', evidenceRef: mergeRef, evidenceSha256: mergeSha });
      await detach(value.client, resumedOwner);
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

  void it('releases exact merge/run evidence, rejects synthetic failure evidence, and never releases from heartbeat age', async () => {
    const value = await harness();
    try {
      const owner = await attachActor(value.client, value.stateRoot, 'a');
      const cases = [
        { suffix: 'm', source: 'unit-merge' as const, condition: 'unit-merged' as const, target: 'unit-m:1' },
        { suffix: 'r', source: 'attempt-reset' as const, condition: 'attempt-reset' as const, target: 'unit-r:1' },
        { suffix: 'q', source: 'quarantine-capture' as const, condition: 'quarantine-captured' as const, target: 'unit-q:1' },
      ];
      const grantedGroups = new Map<string, CoordinationAcquisitionGroup>();
      for (const entry of cases) {
        const grant = await owner.negotiation.acquire(acquisitionInput(entry.suffix, { condition_type: entry.condition, target_id: entry.target, evidence: null }, `src/${entry.suffix}.ts`));
        assert.equal(grant.outcome, 'granted');
        if (grant.outcome === 'granted') grantedGroups.set(entry.suffix, grant.acquisitionGroup);
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

      const integrationHead = git(join(value.stateRoot, 'worktrees', owner.context.repo_id, 'active', owner.context.workstream_run, 'main'), ['rev-parse', 'HEAD']);
      const mergeRef = '.pi/autopilot/work-a/evidence/m.json';
      const mergeSha = await writeEvidence(value.stateRoot, owner, mergeRef, `${JSON.stringify({ schema_version: 'autopilot.unit_merge.v1', workstream_run: owner.context.workstream_run, autopilot_id: owner.context.autopilot_id, unit_id: 'unit-m', attempt: 1, merge_commit_sha: integrationHead, integration_before: integrationHead, integration_after: integrationHead, execution_commit_ref: 'execution-commits/unit-m.json', changed_paths: [] })}\n`);
      await owner.reconciliation.recordReleaseEvidence({ source: 'unit-merge', targetId: 'unit-m:1', evidenceRef: mergeRef, evidenceSha256: mergeSha });
      for (const entry of cases.filter((candidate) => candidate.source !== 'unit-merge')) {
        const evidenceRef = `.pi/autopilot/work-a/evidence/${entry.suffix}.json`;
        const quarantine = entry.source === 'quarantine-capture';
        const document = { schema_version: 'autopilot.unit_failure.v1', workstream: owner.context.workstream, workstream_run: owner.context.workstream_run, unit_id: `unit-${entry.suffix}`, attempt: 1, unit_worktree_path: join(value.root, `synthetic-${entry.suffix}`), dirty_paths: quarantine ? ['src/q.ts'] : [], capture_commit_sha: quarantine ? integrationHead : null, capture_ref: quarantine ? `autopilot/archive/${owner.context.workstream_run}/unit/unit-q/attempt-1/quarantine-capture` : null, git_head_before: integrationHead, git_head_after: integrationHead, git_common_dir: join(value.root, 'repository', '.git'), branch: `autopilot/unit/${owner.context.workstream_run}/unit-${entry.suffix}/attempt-1`, postcondition_worktree_clean: true, action: quarantine ? 'quarantine' : 'reset', summary: 'synthetic evidence must not release authority', created_at: '2026-07-12T10:00:00.000Z' };
        const evidenceSha256 = await writeEvidence(value.stateRoot, owner, evidenceRef, `${JSON.stringify(document)}\n`);
        await assert.rejects(() => owner.reconciliation.recordReleaseEvidence({ source: entry.source, targetId: entry.target, evidenceRef, evidenceSha256 }), /exactly one registered owner worktree/u);
        const group = grantedGroups.get(entry.suffix);
        if (group === undefined) throw new Error(`missing granted ${entry.suffix} group`);
        await owner.negotiation.cancelGroup({ group, reason: 'synthetic failure evidence rejected before child launch' });
      }
      assert.equal(array((await status(value.client, owner)).payload['edit_leases'], 'leases after exact merge and prelaunch cleanup').length, 0);

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

  void it('repairs a running child from exact parent terminal acceptance after coordinator restart without releasing source edits', async () => {
    const value = await harness();
    try {
      const owner = await attachActor(value.client, value.stateRoot, 'a');
      const childId = 'child-run-a-unit-a-1';
      const specSha256 = await writeTerminalFixtureSpec(value, owner, 'unit-a');
      await owner.negotiation.acquire({ ...acquisitionInput('a', { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null }), specSha256 });
      const childToken = 'd'.repeat(64);
      await value.client.mutate('register-child', {
        repoId: owner.context.repo_id, workstreamRun: owner.context.workstream_run, sessionId: owner.context.session_id,
        fencingGeneration: owner.context.session_generation, expectedVersion: owner.context.run_version, idempotencyKey: 'register-restart-child',
      }, { child_lease_id: childId, autopilot_id: owner.context.autopilot_id, unit_id: 'unit-a', attempt: 1, pid: process.pid, boot_id: 'boot-child', child_token: childToken, lease_expires_at: '2099-01-01T00:00:00.000Z', session_lease_id: owner.context.session_lease_id, session_token: owner.context.session_token });
      const acceptance = await writeTerminalAcceptance(value, owner, 'unit-a', childId, specSha256);
      const preRestart = await status(value.client, owner);
      const durableAttempt = array(preRestart.payload['unit_attempts'], 'terminal repair attempts').map(parseCoordinationUnitAttempt).find((attempt) => attempt.owner.unit_id === 'unit-a');
      if (durableAttempt === undefined) throw new Error('terminal repair attempt missing');
      const mainWorktreePath = join(value.stateRoot, 'worktrees', owner.context.repo_id, 'active', owner.context.workstream_run, 'main');
      const proof = proveStructuredAttemptTerminal({ mainWorktreePath, runtimeRoot: join(mainWorktreePath, '.pi', 'autopilot', owner.context.workstream), repoId: owner.context.repo_id, autopilotId: owner.context.autopilot_id, workstream: owner.context.workstream, workstreamRun: owner.context.workstream_run, unitId: 'unit-a', attempt: 1, childLeaseId: childId, spec: durableAttempt.spec });
      assert.equal(proof.proven, true, proof.proven ? undefined : proof.reason);
      assert.equal(existsSync(join(value.stateRoot, 'worktrees', owner.context.repo_id, 'active', owner.context.workstream_run, 'main', ...acceptance.ref.split('/'))), true);
      await value.server.close();
      value.server = await startCoordinatorServer(coordinatorRuntimePaths(value.env));

      const repaired = await status(value.client, owner);
      const repairedChild = array(repaired.payload['child_leases'], 'repaired child leases').map((entry) => record(entry, 'repaired child')).find((entry) => entry['child_lease_id'] === childId);
      assert.equal(repairedChild?.['status'], 'terminal');
      assert.equal(record(repairedChild?.['terminal_evidence'], 'repaired terminal evidence')['sha256'], acceptance.sha256);
      assert.equal(array(repaired.payload['edit_leases'], 'source edit leases after terminal repair').length, 1, 'terminal transport fact alone must retain source-changing edit authority');
      const doctor = await value.client.query('doctor');
      const startup = doctor.payload['last_startup_reconciliation'];
      if (typeof startup !== 'object' || startup === null || Array.isArray(startup)) throw new Error('startup reconciliation summary missing');
      assert.equal(array((startup as Readonly<Record<string, unknown>>)['released_lease_ids'], 'startup released edit leases').length, 0);
    } finally {
      await closeHarness(value);
    }
  });
});
