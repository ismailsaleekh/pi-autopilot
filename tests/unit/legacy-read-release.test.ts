import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import type { AutopilotExecutionAudit, AutopilotReceipt, AutopilotStatusEntry } from '../../src/core/contracts/index.ts';
import { runCoordinationMigration } from '../../src/core/coordination/migration.ts';
import { parseCoordinationMigrationRecoveryWork } from '../../src/core/coordination/contracts.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { proveLegacyReadAttemptTerminal } from '../../src/core/coordination/legacy-read-terminal.ts';
import { coordinationRootForRepo, prepareAutopilotWorkstream, readActiveAutopilots, resolveRepoIdentity, writeActiveAutopilots, writePathClaims, type ActiveAutopilotRow, type AutopilotPathClaim, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { terminateExactMigrationFixtureCoordinator } from '../helpers/migration-fixture.ts';

const CLOCK = { now: (): Date => new Date('2026-07-14T10:00:00.000Z') };

interface LegacyReadFixture {
  readonly root: string;
  readonly source: string;
  readonly stateRoot: string;
  readonly env: ProcessEnvLike;
  readonly active: ActiveAutopilotRow;
  readonly claim: AutopilotPathClaim;
}

void describe('BUG-174 legacy READ authority release', () => {
  void it('accepts an exact zero-change terminal chain despite unrelated historical state-model drift', async () => {
    await withLegacyReadFixture(async (fixture) => {
      await writeTerminalReadEvidence(fixture, 2, { includeUnrelatedDrift: true });
      const current = proveLegacyReadAttemptTerminal({ runtimeRoot: fixture.active.runtime_root, workstream: fixture.active.workstream, unitId: fixture.claim.unit_id, attempt: 2 });
      assert.equal(current.proven, true);
      if (!current.proven) throw new Error(current.reason);
      assert.equal(current.proof.kind, 'completed-current-attempt');
      const superseded = proveLegacyReadAttemptTerminal({ runtimeRoot: fixture.active.runtime_root, workstream: fixture.active.workstream, unitId: fixture.claim.unit_id, attempt: 1 });
      assert.equal(superseded.proven, true);
      if (!superseded.proven) throw new Error(superseded.reason);
      assert.equal(superseded.proof.kind, 'superseded-by-later-attempt');
    });
  });

  void it('rejects a forged receipt hash and never treats WRITE authority as historical READ evidence', async () => {
    await withLegacyReadFixture(async (fixture) => {
      await writeTerminalReadEvidence(fixture, 1, { forgeReceiptHash: true });
      const forged = proveLegacyReadAttemptTerminal({ runtimeRoot: fixture.active.runtime_root, workstream: fixture.active.workstream, unitId: fixture.claim.unit_id, attempt: 1 });
      assert.equal(forged.proven, false);
      if (forged.proven) throw new Error('forged receipt unexpectedly proved terminal');
      assert.match(forged.reason, /status_sha256/u);
      const root = coordinationRootForRepo(fixture.active.repo_key, fixture.env);
      await writePathClaims(root, [{ ...fixture.claim, claim_type: 'WRITE' }]);
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.active.repo_key, env: fixture.env, clock: CLOCK });
      assert.equal(dry.terminal_leak_count, 0);
      assert.equal(dry.recovery_work_count, 1);
    });
  });

  void it('classifies terminal READ claims before import instead of retaining synthetic queued authority', async () => {
    await withLegacyReadFixture(async (fixture) => {
      await writeTerminalReadEvidence(fixture, 1, { includeUnrelatedDrift: true });
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.active.repo_key, env: fixture.env, clock: CLOCK });
      assert.equal(dry.legacy_claim_count, 1);
      assert.equal(dry.terminal_leak_count, 1);
      assert.equal(dry.recovery_work_count, 0);
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.active.repo_key, env: fixture.env, clock: CLOCK });
      assert.equal(applied.imported_lease_count, 0);
      assert.equal(applied.terminal_leak_count, 1);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.active.repo_key, env: fixture.env, clock: CLOCK });
    });
  });

  void it('retires an unbound post-cutover READ lease without fabricating provenance and grants blocked WRITE', async () => {
    await withLegacyReadFixture(async (fixture) => {
      const repoKey = fixture.active.repo_key;
      const applied = await runCoordinationMigration({ command: 'apply', repoKey, env: fixture.env, clock: CLOCK });
      assert.equal(applied.imported_lease_count, 1);
      assert.equal(applied.recovery_work_count, 1);
      await runCoordinationMigration({ command: 'verify', repoKey, env: fixture.env, clock: CLOCK });
      await runCoordinationMigration({ command: 'cutover', repoKey, env: fixture.env, clock: CLOCK });
      await writeTerminalReadEvidence(fixture, 1, { includeUnrelatedDrift: true });

      const server = await startCoordinatorServer(coordinatorRuntimePaths(fixture.env), CLOCK);
      const generationDatabasePath = server.store.currentGeneration().database_path;
      try {
        const supervisor = new DurableRunSupervisorClient(fixture.env);
        const retired = await supervisor.client.query('status', repoKey, fixture.active.workstream_run);
        assert.equal(Array.isArray(retired.payload['edit_leases']) ? retired.payload['edit_leases'].length : -1, 0);
        assert.equal(Array.isArray(retired.payload['observations']) ? retired.payload['observations'].length : -1, 0, 'historical READ cannot receive a source identity after acquisition');
        assert.equal(Array.isArray(retired.payload['migration_recovery_work']) ? retired.payload['migration_recovery_work'].length : -1, 0);
        assert.equal(Array.isArray(retired.payload['acquisition_groups']) ? (retired.payload['acquisition_groups'][0] as Readonly<Record<string, unknown>> | undefined)?.['state'] : null, 'released');

        const contender = await prepareAutopilotWorkstream({ workstream: 'bug-174-contender', sourceCwd: fixture.source, coordinationSessionId: 'bug-174-contender-bootstrap', env: fixture.env, now: CLOCK.now() });
        const attachment = await supervisor.attach({ repo: contender.repo, active: contender.active, rawSessionId: 'bug-174-contender-session' });
        const negotiation = new ClaimNegotiationClient(supervisor.client, attachment.context);
        const granted = await negotiation.acquire({
          acquisitionGroupId: 'bug-174-write-group', unitId: 'bug-174-write-unit', attempt: 1,
          requestedLeases: [{ path: 'README.md', mode: 'WRITE', purpose: 'prove historical READ no longer blocks WRITE' }],
          reason: 'BUG-174 regression grant witness', normalReleaseCondition: { condition_type: 'unit-merged', target_id: 'bug-174-write-unit:1', evidence: null },
          specRef: '.pi/autopilot/bug-174-contender/unit-specs/bug-174-write-unit.json', specSha256: `sha256:${'d'.repeat(64)}`,
          role: 'implement', preemptible: true, checkpointOrdinal: 0,
        });
        assert.equal(granted.outcome, 'granted');
      } finally { await server.close(); }

      const database = new DatabaseSync(generationDatabasePath, { readOnly: true });
      try {
        const audit = database.prepare("SELECT payload_json FROM migration_legacy_audit WHERE json_extract(payload_json, '$.schema_version')='autopilot.schema9_read_retirement.v1'").get();
        assert.notEqual(audit, undefined);
        const payload = JSON.parse(String(audit?.['payload_json'])) as Readonly<Record<string, unknown>>;
        assert.equal(payload['disposition'], 'retired-unbound-read-authority');
        assert.equal(Array.isArray(payload['retired_recovery_work']) ? payload['retired_recovery_work'].length : -1, 1);
        assert.equal('source_identity' in payload, false);
      } finally { database.close(); }
    });
  });
});

async function withLegacyReadFixture(run: (fixture: LegacyReadFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-bug-174-'));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'README.md'), '# BUG-174 generic repository\n', 'utf8');
    for (const args of [['init'], ['config', 'user.email', 'bug-174@example.invalid'], ['config', 'user.name', 'BUG 174 Test'], ['add', '.'], ['commit', '-m', 'baseline']]) {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const prepared = await prepareAutopilotWorkstream({ workstream: 'bug-174-owner', sourceCwd: source, env, now: new Date('2026-07-14T09:00:00.000Z') });
    const coordinationRoot = coordinationRootForRepo(prepared.active.repo_key, env);
    const active: ActiveAutopilotRow = { ...prepared.active, pid: 999_999_999, boot_id: 'retired-bug-174-boot', active_run_epoch: 2 };
    await writeActiveAutopilots(coordinationRoot, [active]);
    const claim: AutopilotPathClaim = {
      schema_version: 'autopilot.path_claim.v1', path: 'README.md', autopilot_id: active.autopilot_id, workstream: active.workstream,
      workstream_run: active.workstream_run, unit_id: 'legacy-read-unit', attempt: 1, claim_type: 'READ',
      acquired_at: '2026-07-14T09:01:00.000Z', active_run_epoch: 1, reason: 'historical read authority regression',
    };
    await writePathClaims(coordinationRoot, [claim]);
    await run({ root, source, stateRoot, env, active, claim });
  } finally {
    await terminateExactMigrationFixtureCoordinator(stateRoot);
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
}

async function makeRemovable(root: string): Promise<void> {
  await chmod(root, 0o700).catch((error: unknown) => {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  });
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await makeRemovable(path);
    else await chmod(path, 0o600);
  }
}

async function writeTerminalReadEvidence(fixture: LegacyReadFixture, currentAttempt: number, options: { readonly forgeReceiptHash?: boolean; readonly includeUnrelatedDrift?: boolean }): Promise<void> {
  const unitId = fixture.claim.unit_id;
  const role = 'validate' as const;
  const statusRef = `statuses/${unitId}.${role}.attempt-${String(currentAttempt)}.json`;
  const receiptRef = `receipts/${unitId}.${role}.attempt-${String(currentAttempt)}.receipt.json`;
  const auditRef = `execution-audits/${unitId}.${role}.attempt-${String(currentAttempt)}.json`;
  const statusPath = join(fixture.active.runtime_root, statusRef);
  const status: AutopilotStatusEntry = {
    schema_version: 'autopilot.status.v1', workstream: fixture.active.workstream, unit_id: unitId, role, attempt: currentAttempt,
    verdict: 'PASS', severity: 'clean', summary: 'Historical read-only attempt completed with no repository changes.', changed_paths: [], findings: [], commands: [], evidence_refs: [], report_ref: null, next_action: 'release retained read authority',
  };
  const statusBytes = `${JSON.stringify(status, null, 2)}\n`;
  await mkdir(dirname(statusPath), { recursive: true });
  await writeFile(statusPath, statusBytes, 'utf8');
  const receipt: AutopilotReceipt = {
    schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: fixture.active.workstream, unit_id: unitId, role, attempt: currentAttempt,
    emitted_at: '2026-07-14T09:10:00.000Z', status_output: statusPath,
    status_sha256: options.forgeReceiptHash === true ? `sha256:${'f'.repeat(64)}` : `sha256:${createHash('sha256').update(statusBytes).digest('hex')}`,
    schema_sha256: `sha256:${'a'.repeat(64)}`, tool_call_id: `bug-174-${String(currentAttempt)}`,
    provider_identity: { provider_id: 'openai-codex', requested_model_id: 'openai-codex/gpt-5.6-sol', executed_model_id: 'openai-codex/gpt-5.6-sol', api: 'openai-codex-responses', thinking_level: 'xhigh' },
    expected_identity_hash: `sha256:${'b'.repeat(64)}`,
  };
  const audit: AutopilotExecutionAudit = {
    schema_version: 'autopilot.execution_audit.v1', workstream: fixture.active.workstream, unit_id: unitId, role, attempt: currentAttempt,
    audited_at: '2026-07-14T09:10:00.000Z', cwd: fixture.active.main_worktree_path, git_head: git(fixture.active.main_worktree_path, ['rev-parse', 'HEAD']),
    dirty_baseline: false, dirty_baseline_paths: [], dirty_relevant_paths: [], actual_changed_paths: [], status_reported_changed_paths: [], omitted_status_changes: [], reported_but_not_actual_changes: [], outside_owned_paths: [], read_only_touched_paths: [], untouchable_touched_paths: [],
    path_counts: { dirty_baseline_paths: 0, dirty_relevant_paths: 0, actual_changed_paths: 0, status_reported_changed_paths: 0, omitted_status_changes: 0, reported_but_not_actual_changes: 0, outside_owned_paths: 0, read_only_touched_paths: 0, untouchable_touched_paths: 0 },
    truncated_path_sets: [], declared_validation_commands: [], status_reported_commands: [], command_coverage_gaps: [], classification: 'clean', evidence_refs: [], summary: 'Clean zero-change historical READ execution audit.',
  };
  await writeJson(join(fixture.active.runtime_root, receiptRef), receipt);
  await writeJson(join(fixture.active.runtime_root, auditRef), audit);
  const state = {
    schema_version: 'autopilot.state.v1', workstream: fixture.active.workstream, updated_at: '2026-07-14T09:11:00.000Z', status: 'paused',
    context_gate: { gate: 'ok', percent: 10 }, last_event_id: 1, ready_queue: [], running: [], blocked: [], completed: [unitId],
    units: { [unitId]: { unit_id: unitId, role, state: 'completed', attempt: currentAttempt, status_ref: statusRef, receipt_ref: receiptRef, summary: 'terminal' } },
    operator_questions: [], next_actions: [],
    ...(options.includeUnrelatedDrift === true ? { work_items: { unrelated: { state: 'historical-future-state' } } } : {}),
  };
  await writeJson(join(fixture.active.runtime_root, 'state.json'), state);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
