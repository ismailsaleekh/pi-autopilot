import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAcquisitionGroup, parseCoordinationChangeReservation, parseCoordinationChildLease, parseCoordinationEditLease, parseCoordinationReservationObligation, parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { checkCoordinationInvariants } from '../../src/core/coordination/invariants.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { RunReconciliationClient } from '../../src/core/coordination/reconciliation.ts';
import { ReservationCoordinationClient, reconcilePendingReservationResolutions, reservationCloseBlockers, reservationSchedulingBlockers } from '../../src/core/coordination/reservations.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { ensureMainWorktreeSagaRegistered, executeOwnedWorktreeSaga, type WorktreeSagaInspection } from '../../src/core/coordination/worktree-saga.ts';
import { writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import type { CoordinationReservationObligation, CoordinatorResponseEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ActiveAutopilotRow, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { validCoordinationSnapshot } from '../helpers/coordination-fixture.ts';

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
  readonly server: Awaited<ReturnType<typeof startCoordinatorServer>>;
}

function values(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' } });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-reservations-'));
  const repository = join(root, 'repository');
  await mkdir(repository, { recursive: true });
  git(repository, ['init', '-b', 'main']);
  await writeFile(join(repository, 'README.md'), 'generic reservation fixture\n', 'utf8');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'initial']);
  const stateRoot = join(root, 'state');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  return { root, stateRoot, env, server, client: new CoordinatorClient({ env, autoStart: false }) };
}

async function attachActor(harness: Harness, suffix: string): Promise<Actor> {
  const repoId = 'generic-reservation-repo';
  const workstreamRun = `run-${suffix}`;
  const runResponse = await harness.client.mutate('attach-run', {
    repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}`,
  }, {
    repo_key: repoId, canonical_root: join(harness.root, 'repository'), git_common_dir: join(harness.root, 'repository', '.git'), autopilot_id: `autopilot-${suffix}`, workstream: `work-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun,
      source_repo: join(harness.root, 'repository'), git_common_dir: join(harness.root, 'repository', '.git'), worktree_root: join(harness.stateRoot, 'worktrees', repoId),
      main_worktree_path: join(harness.stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main'), runtime_root: join(harness.stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main', '.pi', 'autopilot', `work-${suffix}`),
      branch: `autopilot/${workstreamRun}`, target_branch: 'main', target_base_sha: git(join(harness.root, 'repository'), ['rev-parse', 'HEAD']), origin_url: null,
      started_at: '2026-07-12T00:00:00.000Z', version: 1,
    },
  });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const sessionToken = suffix.charCodeAt(0).toString(16).slice(-1).repeat(64);
  const sessionResponse = await harness.client.mutate('attach-session', {
    repoId, workstreamRun, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}`,
  }, { session_lease_id: `session-lease-${suffix}`, session_token: sessionToken, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  const mainWorktree = join(harness.stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main');
  await mkdir(dirname(mainWorktree), { recursive: true });
  git(join(harness.root, 'repository'), ['worktree', 'add', '-b', `autopilot/${workstreamRun}`, mainWorktree, 'main']);
  const context: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: harness.stateRoot, repo_id: repoId, repo_key: repoId,
    autopilot_id: attachedRun.autopilot_id, workstream: attachedRun.workstream, workstream_run: attachedRun.workstream_run,
    session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
    session_lease_id: session.session_lease_id, session_token: sessionToken, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  };
  return {
    context,
    negotiation: new ClaimNegotiationClient(harness.client, context),
    reconciliation: new RunReconciliationClient(harness.client, context),
    reservations: new ReservationCoordinationClient(harness.client, context),
  };
}

function acquisitionInput(suffix: string, path = 'src/shared.ts') {
  return {
    acquisitionGroupId: `group-${suffix}`, unitId: `unit-${suffix}`, attempt: 1,
    requestedLeases: [{ path, mode: 'WRITE' as const, purpose: `implement ${suffix}` }, { path: `docs/${suffix}.md`, mode: 'READ' as const, purpose: `read context ${suffix}` }],
    reason: `run ${suffix} changes ${path}`,
    normalReleaseCondition: { condition_type: 'unit-merged' as const, target_id: `unit-${suffix}:1`, evidence: null },
    specRef: `.pi/autopilot/work-${suffix}/unit-specs/unit-${suffix}.json`, specSha256: `sha256:${suffix.charCodeAt(0).toString(16).slice(-1).repeat(64)}` as `sha256:${string}`,
    role: 'implement' as const, preemptible: true, checkpointOrdinal: 0,
  };
}

async function writeEvidence(harness: Harness, actor: Actor, ref: string, value: Readonly<Record<string, unknown>>): Promise<`sha256:${string}`> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(harness.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main', ...ref.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

async function writeValidatorArtifacts(harness: Harness, actor: Actor, unitId: string, attempt: number): Promise<{
  readonly statusRef: string; readonly statusSha256: `sha256:${string}`; readonly receiptRef: string; readonly receiptSha256: `sha256:${string}`; readonly auditRef: string; readonly auditSha256: `sha256:${string}`;
}> {
  const statusRef = `statuses/${unitId}.json`;
  const statusPath = join(harness.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main', '.pi', 'autopilot', actor.context.workstream, ...statusRef.split('/'));
  const statusSha256 = await writeEvidence(harness, actor, `.pi/autopilot/${actor.context.workstream}/${statusRef}`, {
    schema_version: 'autopilot.status.v1', workstream: actor.context.workstream, unit_id: unitId, role: 'validate', attempt, verdict: 'PASS', severity: 'clean', summary: 'Independent reservation validation passed.', changed_paths: [], findings: [], commands: [{ command: 'generic-validation', status: 'passed', exit_code: 0, summary: 'passed' }], evidence_refs: [], report_ref: null, next_action: 'close',
  });
  const receiptRef = `receipts/${unitId}.json`;
  const receiptSha256 = await writeEvidence(harness, actor, `.pi/autopilot/${actor.context.workstream}/${receiptRef}`, {
    schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: actor.context.workstream, unit_id: unitId, role: 'validate', attempt, emitted_at: '2026-07-12T10:11:00.000Z', status_output: statusPath, status_sha256: statusSha256, schema_sha256: `sha256:${'a'.repeat(64)}`, tool_call_id: `tool-${unitId}`, provider_identity: { provider_id: 'openai-codex', requested_model_id: 'openai-codex/gpt-5.6-sol', executed_model_id: 'openai-codex/gpt-5.6-sol', api: 'openai-codex-responses', thinking_level: 'xhigh' }, expected_identity_hash: `sha256:${'b'.repeat(64)}`,
  });
  const auditRef = `execution-audits/${unitId}.json`;
  const auditSha256 = await writeEvidence(harness, actor, `.pi/autopilot/${actor.context.workstream}/${auditRef}`, {
    schema_version: 'autopilot.execution_audit.v1', workstream: actor.context.workstream, unit_id: unitId, role: 'validate', attempt, audited_at: '2026-07-12T10:11:00.000Z', cwd: join(harness.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main'), git_head: null, dirty_baseline: false, dirty_baseline_paths: [], dirty_relevant_paths: [], actual_changed_paths: [], status_reported_changed_paths: [], omitted_status_changes: [], reported_but_not_actual_changes: [], outside_owned_paths: [], read_only_touched_paths: [], untouchable_touched_paths: [], path_counts: { dirty_baseline_paths: 0, dirty_relevant_paths: 0, actual_changed_paths: 0, status_reported_changed_paths: 0, omitted_status_changes: 0, reported_but_not_actual_changes: 0, outside_owned_paths: 0, read_only_touched_paths: 0, untouchable_touched_paths: 0 }, truncated_path_sets: [], declared_validation_commands: ['generic-validation'], status_reported_commands: ['generic-validation'], command_coverage_gaps: [], classification: 'clean', evidence_refs: [], summary: 'Independent reservation validation audit is clean.',
  });
  const childId = `child-${actor.context.workstream_run}-${unitId}-${String(attempt)}`;
  await harness.client.mutate('register-attempt', { repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id, fencingGeneration: actor.context.session_generation, expectedVersion: actor.context.run_version, idempotencyKey: `register-attempt-${childId}` }, { unit_id: unitId, attempt, spec_ref: `unit-specs/${unitId}.json`, spec_sha256: `sha256:${'c'.repeat(64)}`, role: 'validate', preemptible: true, checkpoint_ordinal: 0, session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token });
  const childToken = createHash('sha256').update(childId, 'utf8').digest('hex');
  const registered = await harness.client.mutate('register-child', {
    repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: actor.context.session_id, fencingGeneration: actor.context.session_generation, expectedVersion: actor.context.run_version, idempotencyKey: `register-${childId}`,
  }, { child_lease_id: childId, autopilot_id: actor.context.autopilot_id, unit_id: unitId, attempt, pid: process.pid, boot_id: actor.context.boot_id, child_token: childToken, lease_expires_at: '2099-01-01T00:00:00.000Z', session_lease_id: actor.context.session_lease_id, session_token: actor.context.session_token });
  const child = parseCoordinationChildLease(registered.payload['child']);
  await harness.client.mutate('complete-child', {
    repoId: actor.context.repo_id, workstreamRun: actor.context.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: child.version, idempotencyKey: `complete-${childId}`,
  }, { child_lease_id: childId, child_token: childToken, pid: process.pid, boot_id: actor.context.boot_id, status: 'terminal', evidence_ref: `.pi/autopilot/${actor.context.workstream}/${receiptRef}`, evidence_sha256: receiptSha256 });
  return { statusRef, statusSha256, receiptRef, receiptSha256, auditRef, auditSha256 };
}

function unitMergeDocument(actor: Actor, suffix: string, changedPaths: readonly string[], integrationBefore: string, integrationAfter: string) {
  return {
    schema_version: 'autopilot.unit_merge.v1', workstream: actor.context.workstream, workstream_run: actor.context.workstream_run,
    autopilot_id: actor.context.autopilot_id, active_run_epoch: 1, unit_id: `unit-${suffix}`, role: 'implement', attempt: 1,
    unit_branch: `autopilot/unit/${actor.context.workstream_run}/unit-${suffix}/attempt-1`, main_branch: `autopilot/${actor.context.workstream_run}`,
    unit_head: integrationAfter, integration_before: integrationBefore, integration_after: integrationAfter, merge_commit_sha: integrationAfter,
    changed_paths: changedPaths, status_ref: `statuses/unit-${suffix}.json`, receipt_ref: `receipts/unit-${suffix}.json`, audit_ref: `execution-audits/unit-${suffix}.json`, execution_commit_ref: `execution-commits/unit-${suffix}.json`, merged_at: '2026-07-12T10:00:00.000Z',
  };
}

async function recordUnitMerge(harness: Harness, actor: Actor, suffix: string, changedPaths: readonly string[]): Promise<void> {
  const ref = `.pi/autopilot/${actor.context.workstream}/unit-merges/unit-${suffix}.implement.attempt-1.json`;
  const evidencePath = join(harness.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main', ...ref.split('/'));
  let sha: `sha256:${string}`;
  if (existsSync(evidencePath)) {
    const bytes = await readFile(evidencePath);
    sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } else {
    const main = join(harness.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main');
    const before = git(main, ['rev-parse', 'HEAD']);
    for (const path of changedPaths) {
      const target = join(main, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `change from ${suffix}\n`, 'utf8');
    }
    git(main, ['add', '--', ...changedPaths]);
    git(main, ['commit', '-m', `unit ${suffix}`]);
    const after = git(main, ['rev-parse', 'HEAD']);
    sha = await writeEvidence(harness, actor, ref, unitMergeDocument(actor, suffix, changedPaths, before, after));
  }
  await actor.reconciliation.recordReleaseEvidence({ source: 'unit-merge', targetId: `unit-${suffix}:1`, evidenceRef: ref, evidenceSha256: sha });
}

async function status(harness: Harness, actor: Actor): Promise<CoordinatorResponseEnvelope> {
  return await harness.client.query('status', actor.context.repo_id, actor.context.workstream_run);
}

function activeRow(harness: Harness, actor: Actor): ActiveAutopilotRow {
  const main = join(harness.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main');
  return {
    schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: actor.context.autopilot_id, workstream: actor.context.workstream, workstream_run: actor.context.workstream_run,
    repo_key: actor.context.repo_id, source_repo: join(harness.root, 'repository'), git_common_dir: join(harness.root, 'repository', '.git'),
    worktree_root: join(harness.stateRoot, 'worktrees', actor.context.repo_id), main_worktree_path: main, branch: `autopilot/${actor.context.workstream_run}`,
    runtime_root: join(main, '.pi', 'autopilot', actor.context.workstream), target_branch: 'main', target_base_sha: 'a'.repeat(40), origin_url: null,
    pid: process.pid, boot_id: actor.context.boot_id, status: 'active', started_at: '2026-07-12T10:00:00.000Z', active_run_epoch: 1,
    active_epoch_started_at: '2026-07-12T10:00:00.000Z', active_run_receipt_id: `receipt-${actor.context.workstream_run}`,
  };
}

async function terminalEvidence(harness: Harness, actor: Actor, outcome: 'closed' | 'aborted'): Promise<{ readonly ref: string; readonly sha: `sha256:${string}` }> {
  const ref = `.pi/autopilot/${actor.context.workstream}/close/${outcome}.json`;
  const actorHead = git(join(harness.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main'), ['rev-parse', 'HEAD']);
  if (outcome === 'closed') git(join(harness.root, 'repository'), ['merge', '--ff-only', actorHead]);
  const sha = await writeEvidence(harness, actor, ref, {
    schema_version: 'autopilot.run_terminal.v1', repo_key: actor.context.repo_id, autopilot_id: actor.context.autopilot_id,
    workstream: actor.context.workstream, workstream_run: actor.context.workstream_run, outcome, terminal_sha: actorHead, accepted_at: '2026-07-12T10:05:00.000Z',
  });
  return { ref, sha };
}

void describe('Coordination Fabric edit leases and change reservations', () => {
  void it('atomically converts exact merged WRITE paths, releases all attempt leases, orders overlap, and requires integration before close', async () => {
    const harness = await createHarness();
    try {
      const first = await attachActor(harness, 'a');
      const second = await attachActor(harness, 'b');
      const firstGrant = await first.negotiation.acquire(acquisitionInput('a'));
      assert.equal(firstGrant.outcome, 'granted');
      const secondWait = await second.negotiation.acquire(acquisitionInput('b'));
      assert.equal(secondWait.outcome, 'waiting-for-peer-release');

      await recordUnitMerge(harness, first, 'a', ['src/shared.ts']);
      await recordUnitMerge(harness, first, 'a', ['src/shared.ts']);
      const firstStatus = await status(harness, first);
      assert.equal(values(firstStatus.payload['edit_leases'], 'first edit leases').length, 0);
      const firstReservations = values(firstStatus.payload['change_reservations'], 'first reservations').map((entry) => parseCoordinationChangeReservation(entry));
      assert.deepEqual(firstReservations.map((entry) => entry.path), ['src/shared.ts']);
      assert.equal(firstReservations[0]?.released_event_seq, null);
      assert.deepEqual(await reservationCloseBlockers(activeRow(harness, first), harness.env), []);

      const offered = values((await status(harness, second)).payload['acquisition_groups'], 'second groups').map((entry) => parseCoordinationAcquisitionGroup(entry)).find((group) => group.acquisition_group_id === 'group-b');
      if (offered === undefined) throw new Error('second acquisition group is missing');
      assert.equal(offered.state, 'grant-ready');
      await second.negotiation.acknowledgeGrant(offered);
      await recordUnitMerge(harness, second, 'b', ['src/shared.ts']);

      const overlapStatus = await status(harness, second);
      const obligations = values(overlapStatus.payload['reservation_obligations'], 'reservation obligations').map((entry) => parseCoordinationReservationObligation(entry));
      assert.equal(obligations.length, 1);
      const obligation = obligations[0];
      if (obligation === undefined) throw new Error('reservation obligation is missing');
      assert.equal(obligation.state, 'waiting-for-predecessor');
      assert.deepEqual(obligation.overlapping_paths, ['src/shared.ts']);
      assert.ok((await reservationCloseBlockers(activeRow(harness, second), harness.env)).some((blocker) => blocker.includes('reservation ordering waits for predecessor')));
      assert.equal(values(overlapStatus.payload['edit_leases'], 'second edit leases').length, 0);

      const firstActive = activeRow(harness, first);
      const firstSessionContextPath = join(harness.root, 'session-a.json');
      await writeCoordinatorSessionContext(firstSessionContextPath, first.context);
      const firstEnv = { ...harness.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: firstSessionContextPath };
      await ensureMainWorktreeSagaRegistered({ active: firstActive, env: firstEnv });
      const firstIntent = await first.reservations.prepareRunTerminal('closed');
      assert.deepEqual(firstIntent.reservation_ids, [firstReservations[0]?.reservation_id]);
      let terminalOperationApplied = false;
      const inspectTerminalOperation = (): WorktreeSagaInspection => terminalOperationApplied ? { outcome: 'satisfied', proof: ['terminal-operation-applied'] } : { outcome: 'not-applied', proof: ['terminal-operation-pending'] };
      await executeOwnedWorktreeSaga({
        active: firstActive, unitId: 'main', attempt: 1, kind: 'main', operationType: 'merge', operationKey: 'terminal-close-operation-witness', initialWorktreeState: 'active', committedWorktreeState: 'active',
        intent: { repo_root: firstActive.source_repo, worktree_path: firstActive.main_worktree_path, git_common_dir: firstActive.git_common_dir, branch: firstActive.branch, reason: 'integrate current target before close', base_sha: git(firstActive.main_worktree_path, ['rev-parse', 'HEAD']), target_sha: git(firstActive.main_worktree_path, ['rev-parse', 'HEAD']), archive_ref: null, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [] },
      }, { inspect: inspectTerminalOperation, action: () => { terminalOperationApplied = true; }, verify: () => inspectTerminalOperation().proof }, firstEnv);
      const firstTerminal = await terminalEvidence(harness, first, 'closed');
      await first.reconciliation.recordReleaseEvidence({ source: 'run-close', targetId: first.context.workstream_run, evidenceRef: firstTerminal.ref, evidenceSha256: firstTerminal.sha });

      const requiredView = await second.reservations.view();
      const required = requiredView.obligations.find((entry) => entry.obligation_id === obligation.obligation_id);
      if (required === undefined) throw new Error('advanced reservation obligation is missing');
      const dependentMergeRef = requiredView.reservations.find((entry) => entry.reservation_id === obligation.reservation_id)?.merge_evidence.ref;
      if (dependentMergeRef === undefined) throw new Error('dependent merge evidence is missing');
      assert.equal(required?.state, 'integration-required');
      assert.equal((await reservationCloseBlockers(activeRow(harness, second), harness.env)).some((blocker) => blocker.includes('requires rebase/integration')), true);

      const secondMain = join(harness.stateRoot, 'worktrees', second.context.repo_id, 'active', second.context.workstream_run, 'main');
      if (required?.predecessor_terminal_sha === null || required?.predecessor_terminal_sha === undefined) throw new Error('predecessor terminal commit is missing');
      git(secondMain, ['merge', '--no-ff', '-s', 'ours', '-m', 'integrate predecessor reservation', required.predecessor_terminal_sha]);
      const integratedHead = git(secondMain, ['rev-parse', 'HEAD']);
      const integrationRef = `.pi/autopilot/${second.context.workstream}/reservation-integration/${obligation.obligation_id}.json`;
      const integrationSha = await writeEvidence(harness, second, integrationRef, {
        schema_version: 'autopilot.reservation_integration.v1', repo_id: second.context.repo_id, autopilot_id: second.context.autopilot_id,
        workstream: second.context.workstream, workstream_run: second.context.workstream_run, obligation_id: obligation.obligation_id,
        reservation_id: obligation.reservation_id, predecessor_reservation_id: obligation.predecessor_reservation_id,
        predecessor_released_event_seq: required?.predecessor_released_event_seq, predecessor_terminal_sha: required?.predecessor_terminal_sha, covered_paths: obligation.overlapping_paths,
        integration_head: integratedHead, integrated_at: '2026-07-12T10:10:00.000Z',
      });
      const validationRef = `.pi/autopilot/${second.context.workstream}/validation/reservation-${obligation.obligation_id}.json`;
      const forgedValidationSha = await writeEvidence(harness, second, validationRef, {
        schema_version: 'autopilot.validation_evidence.v1', workstream: second.context.workstream, source_unit_id: 'unit-b', source_attempt: 1, validation_unit_id: 'forged-validator', validation_attempt: 1, unit_merge_ref: dependentMergeRef, integration_head: integratedHead,
        covered_paths: obligation.overlapping_paths, covered_path_groups: [], witness_ids: ['invented'], status_ref: 'statuses/missing.json', status_sha256: `sha256:${'c'.repeat(64)}`, receipt_ref: 'receipts/missing.json', receipt_sha256: `sha256:${'d'.repeat(64)}`, audit_ref: 'execution-audits/missing.json', audit_sha256: `sha256:${'e'.repeat(64)}`, verdict: 'PASS', validated_at: '2026-07-12T10:10:30.000Z',
      });
      await assert.rejects(() => second.reservations.resolve({ obligation: required, integrationEvidenceRef: integrationRef, integrationEvidenceSha256: integrationSha, validationEvidenceRef: validationRef, validationEvidenceSha256: forgedValidationSha }), /evidence file is unreadable/u);
      const validatorArtifacts = await writeValidatorArtifacts(harness, second, 'validate-b', 1);
      await writeEvidence(harness, second, validationRef, {
        schema_version: 'autopilot.validation_evidence.v1', workstream: second.context.workstream, source_unit_id: 'unit-b', source_attempt: 1,
        validation_unit_id: 'validate-b', validation_attempt: 1, unit_merge_ref: dependentMergeRef, integration_head: integratedHead,
        covered_paths: obligation.overlapping_paths, covered_path_groups: [], witness_ids: ['reservation-overlap'], status_ref: validatorArtifacts.statusRef, status_sha256: validatorArtifacts.statusSha256, receipt_ref: validatorArtifacts.receiptRef, receipt_sha256: validatorArtifacts.receiptSha256, audit_ref: validatorArtifacts.auditRef, audit_sha256: validatorArtifacts.auditSha256, verdict: 'PASS', validated_at: '2026-07-12T10:11:00.000Z',
      });
      const sessionContextPath = join(harness.root, 'session-b.json');
      await writeCoordinatorSessionContext(sessionContextPath, second.context);
      const reconciled = await reconcilePendingReservationResolutions(activeRow(harness, second), { ...harness.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: sessionContextPath });
      assert.equal(reconciled[0]?.state, 'resolved');
      assert.deepEqual(await reservationCloseBlockers(activeRow(harness, second), harness.env), []);
      await mkdir(join(secondMain, 'docs'), { recursive: true });
      await writeFile(join(secondMain, 'docs', 'later.md'), 'disjoint post-validation change\n', 'utf8');
      git(secondMain, ['add', 'docs/later.md']);
      git(secondMain, ['commit', '-m', 'disjoint post-validation change']);
      assert.deepEqual(await reservationCloseBlockers(activeRow(harness, second), harness.env), []);
      assert.equal((await second.negotiation.acquire(acquisitionInput('l'))).outcome, 'granted');
      await recordUnitMerge(harness, second, 'l', ['src/shared.ts']);
      assert.ok((await reservationCloseBlockers(activeRow(harness, second), harness.env)).some((blocker) => blocker.includes('is stale at integration head')));
      const driftHead = git(secondMain, ['rev-parse', 'HEAD']);
      const refreshedObligation = (await second.reservations.view()).obligations.find((entry) => entry.obligation_id === obligation.obligation_id);
      if (refreshedObligation === undefined) throw new Error('refreshable obligation is missing');
      await writeEvidence(harness, second, integrationRef, {
        schema_version: 'autopilot.reservation_integration.v1', repo_id: second.context.repo_id, autopilot_id: second.context.autopilot_id, workstream: second.context.workstream, workstream_run: second.context.workstream_run,
        obligation_id: obligation.obligation_id, reservation_id: obligation.reservation_id, predecessor_reservation_id: obligation.predecessor_reservation_id,
        predecessor_released_event_seq: refreshedObligation.predecessor_released_event_seq, predecessor_terminal_sha: refreshedObligation.predecessor_terminal_sha, covered_paths: obligation.overlapping_paths, integration_head: driftHead, integrated_at: '2026-07-12T10:12:00.000Z',
      });
      const refreshValidatorArtifacts = await writeValidatorArtifacts(harness, second, 'validate-b-refresh', 1);
      await writeEvidence(harness, second, validationRef, {
        schema_version: 'autopilot.validation_evidence.v1', workstream: second.context.workstream, source_unit_id: 'unit-b', source_attempt: 1, validation_unit_id: 'validate-b-refresh', validation_attempt: 1,
        unit_merge_ref: dependentMergeRef, integration_head: driftHead, covered_paths: obligation.overlapping_paths, covered_path_groups: [], witness_ids: ['reservation-overlap-refresh'],
        status_ref: refreshValidatorArtifacts.statusRef, status_sha256: refreshValidatorArtifacts.statusSha256, receipt_ref: refreshValidatorArtifacts.receiptRef, receipt_sha256: refreshValidatorArtifacts.receiptSha256, audit_ref: refreshValidatorArtifacts.auditRef, audit_sha256: refreshValidatorArtifacts.auditSha256, verdict: 'PASS', validated_at: '2026-07-12T10:13:00.000Z',
      });
      assert.equal((await reconcilePendingReservationResolutions(activeRow(harness, second), { ...harness.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: sessionContextPath }))[0]?.state, 'resolved');
      assert.deepEqual(await reservationCloseBlockers(activeRow(harness, second), harness.env), []);

      await second.reservations.prepareRunTerminal('closed');
      const secondTerminal = await terminalEvidence(harness, second, 'closed');
      await second.reconciliation.recordReleaseEvidence({ source: 'run-close', targetId: second.context.workstream_run, evidenceRef: secondTerminal.ref, evidenceSha256: secondTerminal.sha });
      const finalStatus = await status(harness, second);
      assert.equal(values(finalStatus.payload['change_reservations'], 'final reservations').map((entry) => parseCoordinationChangeReservation(entry)).every((reservation) => reservation.released_event_seq !== null), true);
      assert.equal(values(finalStatus.payload['reservation_obligations'], 'final obligations').map((entry) => parseCoordinationReservationObligation(entry)).every((entry) => entry.state === 'resolved' || entry.state === 'cancelled'), true);
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  void it('creates an immediate integration obligation when a predecessor landed before the dependent reservation', async () => {
    const harness = await createHarness();
    try {
      const first = await attachActor(harness, 'h');
      const dependent = await attachActor(harness, 'i');
      assert.equal((await first.negotiation.acquire(acquisitionInput('h'))).outcome, 'granted');
      const waiting = await dependent.negotiation.acquire(acquisitionInput('i'));
      assert.equal(waiting.outcome, 'waiting-for-peer-release');
      await recordUnitMerge(harness, first, 'h', ['src/shared.ts']);
      await first.reservations.prepareRunTerminal('closed');
      const firstTerminal = await terminalEvidence(harness, first, 'closed');
      await first.reconciliation.recordReleaseEvidence({ source: 'run-close', targetId: first.context.workstream_run, evidenceRef: firstTerminal.ref, evidenceSha256: firstTerminal.sha });
      const offered = values((await status(harness, dependent)).payload['acquisition_groups'], 'dependent groups').map((entry) => parseCoordinationAcquisitionGroup(entry)).find((group) => group.acquisition_group_id === 'group-i');
      if (offered === undefined) throw new Error('dependent offer is missing');
      await dependent.negotiation.acknowledgeGrant(offered);
      await recordUnitMerge(harness, dependent, 'i', ['src/shared.ts']);
      const obligations = (await dependent.reservations.view()).obligations;
      assert.equal(obligations.length, 1);
      assert.equal(obligations[0]?.state, 'integration-required');
      assert.equal(obligations[0]?.predecessor_terminal_sha, git(join(harness.root, 'repository'), ['rev-parse', 'HEAD']));

      await dependent.reservations.prepareRunTerminal('aborted');
      const dependentAbort = await terminalEvidence(harness, dependent, 'aborted');
      await dependent.reconciliation.recordReleaseEvidence({ source: 'run-abort', targetId: dependent.context.workstream_run, evidenceRef: dependentAbort.ref, evidenceSha256: dependentAbort.sha });

      const alreadyIntegrated = await attachActor(harness, 'j');
      assert.equal((await alreadyIntegrated.negotiation.acquire(acquisitionInput('j'))).outcome, 'granted');
      await recordUnitMerge(harness, alreadyIntegrated, 'j', ['src/shared.ts']);
      assert.deepEqual((await alreadyIntegrated.reservations.view()).obligations, []);
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  void it('rejects an empty changed-path declaration when Git contains a real diff', async () => {
    const harness = await createHarness();
    try {
      const actor = await attachActor(harness, 'k');
      assert.equal((await actor.negotiation.acquire(acquisitionInput('k', 'src/owned.ts'))).outcome, 'granted');
      const main = join(harness.stateRoot, 'worktrees', actor.context.repo_id, 'active', actor.context.workstream_run, 'main');
      const before = git(main, ['rev-parse', 'HEAD']);
      await mkdir(join(main, 'src'), { recursive: true });
      await writeFile(join(main, 'src', 'owned.ts'), 'real change\n', 'utf8');
      git(main, ['add', 'src/owned.ts']);
      git(main, ['commit', '-m', 'real changed path']);
      const after = git(main, ['rev-parse', 'HEAD']);
      const ref = `.pi/autopilot/${actor.context.workstream}/unit-merges/unit-k.implement.attempt-1.json`;
      const sha = await writeEvidence(harness, actor, ref, unitMergeDocument(actor, 'k', [], before, after));
      await assert.rejects(() => actor.reconciliation.recordReleaseEvidence({ source: 'unit-merge', targetId: 'unit-k:1', evidenceRef: ref, evidenceSha256: sha }), /changed_paths do not equal the exact Git diff/u);
      assert.equal(values((await status(harness, actor)).payload['edit_leases'], 'leases after underreported merge').length, 2);
      assert.equal(values((await status(harness, actor)).payload['change_reservations'], 'reservations after underreported merge').length, 0);
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  void it('rejects merge evidence outside active WRITE authority without releasing the lease', async () => {
    const harness = await createHarness();
    try {
      const actor = await attachActor(harness, 'x');
      const grant = await actor.negotiation.acquire(acquisitionInput('x', 'src/owned.ts'));
      assert.equal(grant.outcome, 'granted');
      await assert.rejects(() => recordUnitMerge(harness, actor, 'x', ['src/not-owned.ts']), /outside active WRITE\/EXCLUSIVE authority/u);
      const current = await status(harness, actor);
      assert.equal(values(current.payload['edit_leases'], 'edit leases').map((entry) => parseCoordinationEditLease(entry)).length, 2);
      assert.equal(values(current.payload['change_reservations'], 'reservations').length, 0);
      if (grant.outcome !== 'granted') throw new Error('preflight grant is missing');
      await actor.negotiation.cancelGroup({ group: grant.acquisitionGroup, reason: 'clean prelaunch rollback witness' });
      assert.equal(values((await status(harness, actor)).payload['edit_leases'], 'edit leases after prelaunch rollback').length, 0);
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  void it('keeps reservations out of edit conflicts while exposing exact scheduler ordering and integration blockers', () => {
    const snapshot = validCoordinationSnapshot();
    const predecessor = { schema_version: 'autopilot.change_reservation.v1' as const, reservation_id: 'reservation-a', repo_id: 'repo-1', autopilot_id: 'autopilot-a', workstream_run: 'run-a', path: 'src/shared.ts', merge_evidence: { ref: 'merge-a.json', sha256: `sha256:${'a'.repeat(64)}` as const }, created_event_seq: 4, released_event_seq: null, terminal_outcome: null, terminal_sha: null, version: 1 };
    const dependent = { ...predecessor, reservation_id: 'reservation-b', autopilot_id: 'autopilot-b', workstream_run: 'run-b', merge_evidence: { ref: 'merge-b.json', sha256: `sha256:${'b'.repeat(64)}` as const }, created_event_seq: 5 };
    const waiting: CoordinationReservationObligation = { schema_version: 'autopilot.reservation_obligation.v1', obligation_id: 'obligation-b-a', repo_id: 'repo-1', workstream_run: 'run-b', reservation_id: 'reservation-b', predecessor_reservation_id: 'reservation-a', overlapping_paths: ['src/shared.ts'], state: 'waiting-for-predecessor', created_event_seq: 5, predecessor_released_event_seq: null, predecessor_terminal_sha: null, integration_evidence: null, validation_evidence: null, resolved_event_seq: null, version: 1 };
    const blockers = reservationSchedulingBlockers({ workstreamRun: 'run-b', requestedPaths: ['src/shared.ts'], view: { reservations: [predecessor, dependent], obligations: [waiting], editLeases: [] } });
    assert.equal(blockers.ordering.length, 1);
    assert.equal(blockers.integration.length, 0);
    assert.deepEqual(reservationSchedulingBlockers({ workstreamRun: 'run-b', requestedPaths: ['src/disjoint.ts'], view: { reservations: [predecessor, dependent], obligations: [waiting], editLeases: [] } }), { ordering: [], integration: [] });
    const invalid = checkCoordinationInvariants({ ...snapshot, change_reservations: [predecessor, dependent], reservation_obligations: [] });
    assert.ok(invalid.some((finding) => finding.code === 'overlapping-reservations-uncoordinated'));
  });
});
