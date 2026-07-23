import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { isExactProcessAlive, processStartIdentity } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { runCoordinationMigration } from '../../src/core/coordination/migration.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { OwnedWorktreeSagaClient } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, coordinationRootForRepo, prepareAutopilotWorkstream, resolveRepoIdentity, writeActiveAutopilots, writePathClaims, type ActiveAutopilotRow, type AutopilotPathClaim, type AutopilotRepoIdentity, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { buildMutableClone, writeRehearsalResult } from '../../tools/s2-corpus-rehearsal/release-gate.ts';
import { digestBytes, inventoryDigest, inventoryTree, readRegularFileNoFollow } from '../../tools/s2-corpus-rehearsal/inventory.ts';
import { assertMetadataCloneContained } from '../../tools/s2-corpus-rehearsal/path-rebase.ts';
import { migrationTestClock } from '../helpers/migration-fixture.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fileText(path: string): string {
  return Buffer.from(readRegularFileNoFollow(path, 1024 * 1024).bytes).toString('utf8');
}

interface OwnedCoordinatorIdentity {
  readonly state_root: string;
  readonly pid: number;
  readonly process_start_identity: string;
  readonly capability_sha256: string;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function readOwnedCoordinatorIdentity(stateRoot: string): OwnedCoordinatorIdentity | null {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  if (paths.stateRoot !== stateRoot || !existsSync(paths.lockPath) || !existsSync(paths.capabilityPath)) return null;
  const row = jsonObject(JSON.parse(fileText(paths.lockPath)) as unknown, 'coordinator lifecycle lock');
  const pid = row['pid'];
  const start = row['process_start_identity'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof start !== 'string' || start.length === 0) throw new Error('coordinator lifecycle lock identity is malformed');
  return Object.freeze({ state_root: stateRoot, pid, process_start_identity: start, capability_sha256: sha256(fileText(paths.capabilityPath)) });
}

function sameOwnedCoordinatorIdentity(left: OwnedCoordinatorIdentity | null, right: OwnedCoordinatorIdentity | null): boolean {
  return left !== null && right !== null && left.state_root === right.state_root && left.pid === right.pid && left.process_start_identity === right.process_start_identity && left.capability_sha256 === right.capability_sha256;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function stopOwnedCoordinator(owner: OwnedCoordinatorIdentity | null): Promise<void> {
  if (owner === null) return;
  const current = readOwnedCoordinatorIdentity(owner.state_root);
  if (!sameOwnedCoordinatorIdentity(owner, current)) return;
  if (!isExactProcessAlive(owner.pid, owner.process_start_identity)) return;
  process.kill(owner.pid, 'SIGTERM');
  for (let index = 0; index < 200 && isExactProcessAlive(owner.pid, owner.process_start_identity); index += 1) await wait(25);
  if (isExactProcessAlive(owner.pid, owner.process_start_identity)) {
    process.kill(owner.pid, 'SIGKILL');
    for (let index = 0; index < 200 && isExactProcessAlive(owner.pid, owner.process_start_identity); index += 1) await wait(25);
  }
  assert.equal(isExactProcessAlive(owner.pid, owner.process_start_identity), false, 'owned source coordinator must be reaped by exact process identity');
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: owner.state_root });
  await Promise.all([paths.lockPath, paths.socketPath, paths.startupLockPath, paths.predecessorLockPath, paths.predecessorSocketPath, paths.predecessorStartupLockPath].map(async (path) => { await rm(path, { force: true }); }));
}

function assertNoNewCoordinator(owner: OwnedCoordinatorIdentity | null, stateRoot: string): void {
  const current = readOwnedCoordinatorIdentity(stateRoot);
  if (current === null) return;
  if (sameOwnedCoordinatorIdentity(owner, current)) return;
  assert.equal(processStartIdentity(current.pid) === current.process_start_identity, false, 'S2-D rehearsal left a new detached coordinator process');
}

void it('constructs a generic synthetic S2-D clone with no live route and rehearses every durable run', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-s2-d-synthetic-')));
  const sourceState = join(root, 'source-state');
  const sourceRepository = join(root, 'source-repository');
  const sourceMain = (runId: string): string => join(sourceState, 'worktrees', 'repo-one', 'active', runId, 'main');
  const sourceCoordinator = join(sourceState, 'coordinator');
  let sourceDatabasePath = join(sourceCoordinator, 'coordinator.db');
  const sourceCapabilityPath = join(sourceCoordinator, 'capability');
  const cloneRoot = join(root, 'clone');
  try {
    await mkdir(sourceRepository, { recursive: true });
    await mkdir(sourceMain('run-a'), { recursive: true });
    await mkdir(sourceMain('run-b'), { recursive: true });
    await mkdir(sourceMain('run-c'), { recursive: true });
    await mkdir(sourceCoordinator, { recursive: true });
    git(sourceRepository, ['init']);
    git(sourceRepository, ['config', 'user.email', 's2@example.invalid']);
    git(sourceRepository, ['config', 'user.name', 'S2 Test']);
    await writeFile(join(sourceRepository, 'tracked.txt'), 's2 synthetic source\n', { encoding: 'utf8', mode: 0o600 });
    git(sourceRepository, ['add', 'tracked.txt']);
    git(sourceRepository, ['commit', '-m', 's2 synthetic source']);
    git(sourceRepository, ['remote', 'add', 'origin', `file://${sourceRepository}`]);
    const head = git(sourceRepository, ['rev-parse', 'HEAD']);
    const sourceGit = await realpath(join(sourceRepository, '.git'));
    const repo: AutopilotRepoIdentity = { repoRoot: sourceRepository, gitCommonDir: sourceGit, repoKey: 'repo-one', headSha: head, targetBranch: null, originUrl: `file://${sourceRepository}` };
    const activeRow = (runId: string): ActiveAutopilotRow => ({ schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: `autopilot-${runId}`, workstream: `workstream-${runId}`, workstream_run: runId, repo_key: repo.repoKey, source_repo: sourceRepository, git_common_dir: sourceGit, worktree_root: join(sourceState, 'worktrees', repo.repoKey), main_worktree_path: sourceMain(runId), branch: `autopilot/${runId}`, runtime_root: join(sourceMain(runId), '.pi', 'autopilot', runId), target_branch: null, target_base_sha: head, origin_url: repo.originUrl, pid: process.pid, boot_id: 's2-d-synthetic', status: 'active', started_at: '2026-07-23T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-23T00:00:00.000Z', active_run_receipt_id: `receipt-${runId}` });
    const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: sourceState };
    const supervisor = new DurableRunSupervisorClient(env);
    for (const active of [activeRow('run-a'), activeRow('run-b'), activeRow('run-c')]) {
      const attachment = await supervisor.attach({ repo, active, rawSessionId: `seed-${active.workstream_run}` });
      if (active.workstream_run === 'run-b' || active.workstream_run === 'run-c') {
        const managedEnv = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
        const saga = await OwnedWorktreeSagaClient.fromEnvironment(managedEnv);
        const unitId = `unit-${active.workstream_run}`;
        await saga.prepare({
          active, unitId, attempt: 1, kind: 'unit', operationType: 'create', initialWorktreeState: 'planned', committedWorktreeState: 'active',
          intent: { repo_root: active.source_repo, worktree_path: join(active.worktree_root, 'active', active.workstream_run, 'units', unitId, 'attempt-1', 'worktree'), git_common_dir: active.git_common_dir, branch: `autopilot/unit/${active.workstream_run}/${unitId}/attempt-1`, reason: `S2-D ${active.workstream_run} subprocess authority regression`, base_sha: active.target_base_sha, target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
        });
      }
      await supervisor.client.mutate('detach-session', { repoId: attachment.context.repo_id, workstreamRun: attachment.context.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.session.version, idempotencyKey: `seed-detach-${active.workstream_run}` }, { reason: 'synthetic S2-D source seeding complete', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
    }
    const pointer = JSON.parse(await readFile(join(sourceCoordinator, 'current-store.json'), 'utf8')) as { readonly relative_generation_path: string };
    sourceDatabasePath = join(sourceCoordinator, pointer.relative_generation_path, 'coordinator.db');
    const sourceCoordinatorOwner = readOwnedCoordinatorIdentity(sourceState);
    await stopOwnedCoordinator(sourceCoordinatorOwner);
    assertNoNewCoordinator(sourceCoordinatorOwner, sourceState);
    await writeFile(join(sourceCoordinator, 'coordinator.lock'), 'live lock must not route from clone\n', { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sourceState, 'active-autopilots.json'), `${canonicalJson([{ ...activeRow('run-a'), target_registration_path: join(sourceRepository, '.git', 'worktrees', 'run-a'), approved_prunable_registration_paths: [join(sourceRepository, '.git', 'worktrees', 'run-a-old')] }, activeRow('run-b')])}\n`, { encoding: 'utf8', mode: 0o600 });

    const sourceBefore = digestBytes(canonicalJson([inventoryDigest(await inventoryTree(sourceState)), inventoryDigest(await inventoryTree(sourceRepository))].sort()));
    const sourceCapabilityBefore = fileText(sourceCapabilityPath);
    const clone = await buildMutableClone({
      schema_version: 'autopilot.s2_d_corpus_clone_request.v1',
      rehearsal_id: 's2-d-synthetic',
      created_at: '2026-07-23T00:00:00.000Z',
      destination_root: cloneRoot,
      result_path: join(cloneRoot, 'private', 'result.json'),
      candidate_build: 'phase36-s2',
      corpora: [{ corpus_id: 'synthetic-corpus', state_root: sourceState, repository_root: sourceRepository, database_path: sourceDatabasePath, capability_path: sourceCapabilityPath, retained_snapshot_roots: [] }],
    });
    const result = await writeRehearsalResult(clone);
    const sourceAfter = digestBytes(canonicalJson([inventoryDigest(await inventoryTree(sourceState)), inventoryDigest(await inventoryTree(sourceRepository))].sort()));
    assert.equal(sourceAfter, sourceBefore);
    assert.equal(fileText(sourceCapabilityPath), sourceCapabilityBefore);

    const copyState = join(cloneRoot, 'corpora', 'synthetic-corpus', 'state');
    const copyRepository = join(cloneRoot, 'corpora', 'synthetic-corpus', 'repository');
    const copyCapability = join(copyState, 'coordinator', 'capability');
    const copyDatabase = join(copyState, relative(sourceState, sourceDatabasePath));
    assert.notEqual(fileText(copyCapability).trim(), sourceCapabilityBefore.trim());
    await assertMetadataCloneContained(copyState, cloneRoot, [copyDatabase]);
    assert.equal(git(copyRepository, ['remote']), '');
    assert.equal(result.action_results.length, 12);
    assert.deepEqual([...new Set(result.action_results.map((entry) => entry.action))].sort(), ['attach', 'dispatch-dry-run', 'doctor', 'reconcile']);
    assert.equal(clone.manifest.durable_runs.length, 3);
    assert.deepEqual([...new Set(clone.manifest.durable_runs.map((run) => run.attachment_strategy))].sort(), ['owned-recovery', 'safe-attachment']);
    assert.deepEqual([...new Set(clone.manifest.durable_runs.map((run) => run.authority_version_mismatch))].sort(), ['no-operation-authority-version-mismatch', 'operation-authority-version-mismatch-recovered']);
    assert.equal(clone.manifest.durable_runs.every((run) => run.terminal_attempt_lease === 'no-retained-terminal-attempt-lease'), true);
    assert.equal(clone.manifest.durable_runs.every((run) => run.evidence_sha256.startsWith('sha256:')), true);
    assert.equal(clone.manifest.path_rebase_ledger.some((entry) => entry.target_kind === 'sqlite-cell'), true);
    assert.equal(clone.manifest.path_rebase_ledger.some((entry) => entry.rewrite_kind === 'remote-neutralization'), true);
    assert.equal(Object.values(clone.manifest.isolation_proofs).every((proof) => proof.passed), true);
    assert.equal(result.live_unchanged.passed, true);
    assert.equal(result.new_blockers.length, 0);
    assertNoNewCoordinator(sourceCoordinatorOwner, sourceState);
    for (const corpus of clone.corpora) assertNoNewCoordinator(null, corpus.copy_state_root);

    const manifestText = await readFile(join(cloneRoot, 'private', 'manifest.json'), 'utf8');
    const resultText = await readFile(join(cloneRoot, 'private', 'result.json'), 'utf8');
    assert.equal(manifestText.includes(sourceState), false);
    assert.equal(manifestText.includes(sourceRepository), false);
    assert.equal(resultText.includes(sourceState), false);
    assert.equal(resultText.includes(sourceRepository), false);
  } finally {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
      }
    }
  }
});

void it('recovers a retained terminal-attempt lease through the actual offline S2-D subprocess', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-s2-d-terminal-recovery-')));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'README.md'), '# retained terminal lease source\n', 'utf8');
    for (const args of [['init'], ['config', 'user.email', 'terminal@example.invalid'], ['config', 'user.name', 'Terminal Test'], ['add', '.'], ['commit', '-m', 'baseline']]) git(source, args);
    const head = git(source, ['rev-parse', 'HEAD']);
    const gitCommonDir = await realpath(join(source, '.git'));
    const repo: AutopilotRepoIdentity = { repoRoot: source, gitCommonDir, repoKey: 'repo-terminal', headSha: head, targetBranch: null, originUrl: null };
    const main = join(stateRoot, 'worktrees', repo.repoKey, 'active', 'run-terminal', 'main');
    await mkdir(main, { recursive: true });
    const active: ActiveAutopilotRow = { schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: 'autopilot-terminal', workstream: 'terminal-proof', workstream_run: 'run-terminal', repo_key: repo.repoKey, source_repo: source, git_common_dir: gitCommonDir, worktree_root: join(stateRoot, 'worktrees', repo.repoKey), main_worktree_path: main, branch: 'autopilot/run-terminal', runtime_root: join(main, '.pi', 'autopilot', 'terminal-proof'), target_branch: null, target_base_sha: head, origin_url: null, pid: process.pid, boot_id: 'terminal-proof-boot', status: 'active', started_at: '2026-07-23T00:20:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-23T00:20:00.000Z', active_run_receipt_id: 'receipt-terminal' };
    const supervisor = new DurableRunSupervisorClient(env, { allowMigrationRecoveryAutoStart: true });
    const attachment = await supervisor.attach({ repo, active, rawSessionId: 'terminal-recovery-seed' });
    const managedEnv = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
    const saga = await OwnedWorktreeSagaClient.fromEnvironment(managedEnv);
    await saga.prepare({
      active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'create', initialWorktreeState: 'planned', committedWorktreeState: 'active',
      intent: { repo_root: active.source_repo, worktree_path: active.main_worktree_path, git_common_dir: active.git_common_dir, branch: active.branch, reason: 'S2-D retained terminal recovery main worktree', base_sha: active.target_base_sha, target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
    });
    const unitId = 'unit-retained-terminal';
    const specSha = `sha256:${'d'.repeat(64)}`;
    await supervisor.client.mutate('register-attempt', { repoId: repo.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.context.run_version, idempotencyKey: 'terminal-seed-register-attempt' }, { unit_id: unitId, attempt: 1, role: 'implement', spec_ref: `unit-specs/${unitId}.json`, spec_sha256: specSha, preemptible: true, checkpoint_ordinal: 0, session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
    await supervisor.client.mutate('acquire-group', { repoId: repo.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.context.run_version, idempotencyKey: 'terminal-seed-acquire-group' }, { acquisition_group_id: 'terminal-seed-group', acquisition_kind: 'initial', unit_id: unitId, attempt: 1, requested_leases: [{ path: 'src/retained-terminal.ts', mode: 'WRITE', purpose: 'retained terminal-attempt recovery e2e' }], reason: 'seed retained terminal-attempt lease', normal_release_condition: { condition_type: 'run-closed', target_id: active.workstream_run, evidence: null }, spec_ref: `unit-specs/${unitId}.json`, spec_sha256: specSha, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
    const childId = `child-${active.workstream_run}-${unitId}-1`;
    const childToken = 'e'.repeat(64);
    const childResponse = await supervisor.client.mutate('register-child', { repoId: repo.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.context.run_version, idempotencyKey: 'terminal-seed-register-child' }, { child_lease_id: childId, autopilot_id: active.autopilot_id, unit_id: unitId, attempt: 1, pid: process.pid, boot_id: 'terminal-seed-boot', child_token: childToken, lease_expires_at: '2099-01-01T00:00:00.000Z', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
    const childVersion = jsonObject(childResponse.payload['child'], 'registered child')['version'];
    if (typeof childVersion !== 'number') throw new Error('registered child omitted a version');
    await supervisor.client.mutate('complete-child', { repoId: repo.repoKey, workstreamRun: active.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: childVersion, idempotencyKey: 'terminal-seed-complete-child' }, { child_lease_id: childId, child_token: childToken, pid: process.pid, boot_id: 'terminal-seed-boot', status: 'recovery-required', evidence_ref: null, evidence_sha256: null });

    const coordinatorRoot = join(stateRoot, 'coordinator');
    const pointer = JSON.parse(await readFile(join(coordinatorRoot, 'current-store.json'), 'utf8')) as { readonly relative_generation_path: string };
    const databasePath = join(coordinatorRoot, pointer.relative_generation_path, 'coordinator.db');
    const seededCoordinator = readOwnedCoordinatorIdentity(stateRoot);
    await stopOwnedCoordinator(seededCoordinator);
    const database = new DatabaseSync(databasePath);
    try {
      const row = jsonObject(database.prepare('SELECT version FROM runs WHERE repo_id=? AND workstream_run=?').get(repo.repoKey, active.workstream_run), 'seeded terminal run');
      const version = row['version'];
      if (typeof version !== 'number') throw new Error('seeded terminal run omitted version');
      const seqRow = jsonObject(database.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(repo.repoKey), 'repository sequence');
      const eventSeq = seqRow['event_seq'];
      if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq) || eventSeq < 1) throw new Error('repository sequence is invalid for terminal fixture');
      const terminalIntent = { schema_version: 'autopilot.run_terminal_intent.v1', terminal_intent_id: 'terminal-retained-lease-intent', repo_id: repo.repoKey, workstream_run: active.workstream_run, outcome: 'closed', state: 'committed', reservation_ids: [], prepared_event_seq: eventSeq, terminal_event_seq: eventSeq, version: 2 };
      database.prepare("UPDATE runs SET status='closed', version=? WHERE repo_id=? AND workstream_run=?").run(version + 1, repo.repoKey, active.workstream_run);
      database.prepare('INSERT INTO run_terminal_intents(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(terminalIntent.terminal_intent_id, repo.repoKey, active.workstream_run, canonicalJson(terminalIntent), terminalIntent.version);
      const retained = jsonObject(database.prepare("SELECT COUNT(*) AS count FROM edit_leases leases JOIN unit_attempts attempts ON attempts.repo_id=leases.repo_id AND attempts.workstream_run=leases.workstream_run AND json_extract(attempts.payload_json, '$.owner.unit_id')=json_extract(leases.payload_json, '$.owner.unit_id') AND json_extract(attempts.payload_json, '$.owner.attempt')=json_extract(leases.payload_json, '$.owner.attempt') WHERE leases.repo_id=? AND leases.workstream_run=? AND json_extract(attempts.payload_json, '$.state') IN ('merged','failed','reset','quarantined','superseded')").get(repo.repoKey, active.workstream_run), 'retained terminal lease count');
      assert.equal(retained['count'], 1);
    } finally { database.close(); }

    const inputPath = join(stateRoot, 'coordinator', 'terminal-recovery-input.json');
    const worker = fileURLToPath(new URL('../../tools/s2-corpus-rehearsal/terminal-recovery-worker.ts', import.meta.url));
    const workerInput = { state_root: stateRoot, corpus_id: 'terminal-corpus', run_id_sha256: sha256('terminal-run'), repo_id_sha256: sha256('terminal-repo'), repo, active, contract: { corpus_id: 'terminal-corpus', run_id_sha256: sha256('terminal-run'), repo_id_sha256: sha256('terminal-repo'), required_actions: ['attach', 'doctor', 'reconcile', 'dispatch-dry-run'], attachment_strategy: 'owned-recovery', terminal_attempt_lease: 'retained-terminal-attempt-recovery-required', authority_version_mismatch: 'no-operation-authority-version-mismatch', evidence_sha256: sha256('terminal-contract') } };
    await writeFile(inputPath, `${canonicalJson(workerInput)}\n`, { encoding: 'utf8', mode: 0o600 });
    const recovery = spawnSync(process.execPath, ['--experimental-strip-types', worker, inputPath], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env }, encoding: 'utf8', timeout: 120_000 });
    assert.equal(recovery.status, 0, recovery.stderr);
    const output = jsonObject(JSON.parse(recovery.stdout) as unknown, 'terminal recovery subprocess output');
    assert.equal(output['before_retained_terminal_attempt_leases'], 0, 'subprocess coordinator startup reconciliation should observe the offline retained lease as already released');
    assert.equal(output['after_retained_terminal_attempt_leases'], 0);
    assert.equal(output['recovery_attachment'], 'already-clear');
    const recoveryCoordinator = readOwnedCoordinatorIdentity(stateRoot);
    await stopOwnedCoordinator(recoveryCoordinator);
    assertNoNewCoordinator(recoveryCoordinator, stateRoot);
    const proofDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const after = jsonObject(proofDb.prepare("SELECT COUNT(*) AS count FROM edit_leases leases JOIN unit_attempts attempts ON attempts.repo_id=leases.repo_id AND attempts.workstream_run=leases.workstream_run AND json_extract(attempts.payload_json, '$.owner.unit_id')=json_extract(leases.payload_json, '$.owner.unit_id') AND json_extract(attempts.payload_json, '$.owner.attempt')=json_extract(leases.payload_json, '$.owner.attempt') WHERE leases.repo_id=? AND leases.workstream_run=? AND json_extract(attempts.payload_json, '$.state') IN ('merged','failed','reset','quarantined','superseded')").get(repo.repoKey, active.workstream_run), 'after terminal lease count');
      const receipts = jsonObject(proofDb.prepare("SELECT COUNT(*) AS count FROM reconciliation_receipts WHERE repo_id=? AND workstream_run=? AND source_action IN ('attach-terminal-recovery','startup-reconciliation')").get(repo.repoKey, active.workstream_run), 'terminal recovery reconciliation receipts');
      assert.equal(after['count'], 0, 'retained terminal-attempt lease must be absent after reconciliation');
      assert.equal(receipts['count'], 1, 'terminal recovery must leave a durable reconciliation proof receipt');
    } finally { proofDb.close(); }
  } finally {
    await stopOwnedCoordinator(readOwnedCoordinatorIdentity(stateRoot));
    await rm(root, { recursive: true, force: true });
  }
});

void it('fails release when migration-frozen owned recovery leaves doctor unhealthy blockers', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-s2-d-migration-')));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'README.md'), '# generic migration repository\n', 'utf8');
    for (const args of [['init'], ['config', 'user.email', 'migration@example.invalid'], ['config', 'user.name', 'Migration Test'], ['add', '.'], ['commit', '-m', 'baseline']]) git(source, args);
    const prepared = await prepareAutopilotWorkstream({ workstream: 'migration-proof', sourceCwd: source, env, now: new Date('2026-07-12T11:00:00.000Z') });
    const coordinationRoot = coordinationRootForRepo(prepared.active.repo_key, env);
    const dormant = { ...prepared.active, pid: 999_999_999, boot_id: 'prior-boot', active_run_epoch: 2 };
    await writeActiveAutopilots(coordinationRoot, [dormant]);
    const claim: AutopilotPathClaim = { schema_version: 'autopilot.path_claim.v1', path: 'src/future.ts', autopilot_id: dormant.autopilot_id, workstream: dormant.workstream, workstream_run: dormant.workstream_run, unit_id: 'unit-old-session', attempt: 1, claim_type: 'WRITE', acquired_at: '2026-07-12T11:01:00.000Z', active_run_epoch: 1, reason: 'old-session durable ownership proof' };
    await writePathClaims(coordinationRoot, [claim]);
    const repoKey = resolveRepoIdentity(source).repoKey;
    await runCoordinationMigration({ command: 'apply', repoKey, env, clock: migrationTestClock() });
    const sourceCoordinator = join(stateRoot, 'coordinator');
    const pointer = JSON.parse(await readFile(join(sourceCoordinator, 'current-store.json'), 'utf8')) as { readonly relative_generation_path: string };
    const sourceDatabasePath = join(sourceCoordinator, pointer.relative_generation_path, 'coordinator.db');
    const sourceCapabilityPath = join(sourceCoordinator, 'capability');
    if (!existsSync(sourceCapabilityPath)) await writeFile(sourceCapabilityPath, `${'c'.repeat(64)}\n`, { encoding: 'utf8', mode: 0o600 });
    const cloneRoot = join(root, 's2-d-migration-clone');
    const clone = await buildMutableClone({
      schema_version: 'autopilot.s2_d_corpus_clone_request.v1', rehearsal_id: 's2-d-migration-freeze', created_at: '2026-07-23T00:10:00.000Z', destination_root: cloneRoot, result_path: join(cloneRoot, 'private', 'result.json'), candidate_build: 'phase36-s2',
      corpora: [{ corpus_id: 'migration-corpus', state_root: stateRoot, repository_root: source, database_path: sourceDatabasePath, capability_path: sourceCapabilityPath, retained_snapshot_roots: [] }],
    });
    assert.equal(clone.manifest.durable_runs.length, 1);
    assert.equal(clone.manifest.durable_runs[0]?.attachment_strategy, 'owned-recovery');
    await assert.rejects(() => writeRehearsalResult(clone), /candidate-doctor-blocked/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
