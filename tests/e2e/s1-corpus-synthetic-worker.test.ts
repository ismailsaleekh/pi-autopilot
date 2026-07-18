import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { parseAutopilotMasterPlan, parseAutopilotState, parseAutopilotUnitSpec } from '../../src/core/contracts/validate.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import {
  installActualCf50Package,
  loadActualCf50Client,
  startActualCf50Coordinator,
  verifyActualCf50Fixture,
  type VersionSkewClient,
  type VersionSkewResponse,
} from '../helpers/actual-cf50-package.ts';
import { S1_ACTUAL_CF50_TARBALL_SHA256, type CorpusCloneRequest, type Sha256Digest } from '../../tools/s1-corpus-rehearsal/contracts.ts';
import { buildCloneEnvironment } from '../../tools/s1-corpus-rehearsal/environment.ts';
import { buildIsolatedGitMirror } from '../../tools/s1-corpus-rehearsal/git-mirror.ts';
import { corpusRunIdentityDigest, runScenarioWorker, type ScenarioWorkerCloneAuthority, type ScenarioWorkerScenarioAuthority } from '../../tools/s1-corpus-rehearsal/incident-runner.ts';
import { copyRegularFileNoFollow } from '../../tools/s1-corpus-rehearsal/inventory.ts';

interface JsonMap { readonly [key: string]: unknown }

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonMap;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be text`);
  return value;
}

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function checked(command: string, args: readonly string[], cwd: string, npmCache: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NPM_CONFIG_CACHE: npmCache, NPM_CONFIG_OFFLINE: 'true' } });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stderr}`);
  return result.stdout;
}

function packedFilename(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('synthetic worker npm pack result must contain one entry');
  const row = record(parsed[0], 'synthetic worker npm pack entry');
  return text(row['filename'], 'synthetic worker npm pack filename');
}

function token(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function runPayload(input: {
  readonly repoId: string;
  readonly runId: string;
  readonly workstream: string;
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly worktreeRoot: string;
  readonly mainWorktree: string;
  readonly runtimeRoot: string;
  readonly head: string;
}): Readonly<Record<string, unknown>> {
  return {
    repo_key: input.repoId,
    canonical_root: input.repositoryRoot,
    git_common_dir: input.gitCommonDir,
    autopilot_id: `autopilot-${input.runId}`,
    workstream: input.workstream,
    coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: input.repoId, workstream_run: input.runId,
      source_repo: input.repositoryRoot, git_common_dir: input.gitCommonDir, worktree_root: input.worktreeRoot,
      main_worktree_path: input.mainWorktree, runtime_root: input.runtimeRoot, branch: 'autopilot/run',
      target_branch: null, target_base_sha: input.head, origin_url: null, started_at: '2026-07-18T00:00:00.000Z', version: 1,
    },
  };
}

async function attachSeedRun(input: {
  readonly client: VersionSkewClient;
  readonly repoId: string;
  readonly runId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): Promise<{ readonly runVersion: number; readonly sessionVersion: number; readonly sessionId: string; readonly leaseId: string; readonly sessionToken: string }> {
  const runResponse = await input.client.mutate('attach-run', { repoId: input.repoId, workstreamRun: input.runId, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `seed-attach-run-${input.runId}` }, input.payload);
  const run = record(runResponse.payload['run'], 'synthetic seed run');
  const sessionId = `seed-session-${input.runId}`;
  const leaseId = `seed-lease-${input.runId}`;
  const sessionToken = token(input.runId);
  const sessionResponse = await input.client.mutate('attach-session', { repoId: input.repoId, workstreamRun: input.runId, sessionId, fencingGeneration: 1, expectedVersion: integer(run['version'], 'synthetic seed run version'), idempotencyKey: `seed-attach-session-${input.runId}` }, { session_lease_id: leaseId, session_token: sessionToken, pid: process.pid, boot_id: 'synthetic-seed-boot', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
  const session = record(sessionResponse.payload['session'], 'synthetic seed session');
  const attachedRun = record(sessionResponse.payload['run'], 'synthetic seed attached run');
  return { runVersion: integer(attachedRun['version'], 'synthetic seed attached run version'), sessionVersion: integer(session['version'], 'synthetic seed session version'), sessionId, leaseId, sessionToken };
}

async function detachSeedRun(client: VersionSkewClient, repoId: string, runId: string, attachment: Awaited<ReturnType<typeof attachSeedRun>>): Promise<void> {
  await client.mutate('detach-session', { repoId, workstreamRun: runId, sessionId: attachment.sessionId, fencingGeneration: 1, expectedVersion: attachment.sessionVersion, idempotencyKey: `seed-detach-${runId}` }, { reason: 'synthetic worker seed complete', session_lease_id: attachment.leaseId, session_token: attachment.sessionToken });
}

function assertOk(response: VersionSkewResponse, label: string): void {
  assert.equal(response.ok, true, `${label}: ${String(response.error_code)}`);
}

void it('executes one packed-candidate scenario worker over synthetic durable authority without claiming actual-corpus certification', async () => {
  const backendAvailable = platform() === 'darwin' ? existsSync('/usr/bin/sandbox-exec') : platform() === 'linux' ? existsSync('/usr/bin/bwrap') && process.getuid?.() !== 0 : false;
  if (!backendAvailable) return;

  const root = await realpath(await mkdtemp('/tmp/c5w-'));
  const sourceState = join(root, 'source-state');
  const sourceRepository = join(root, 'source-repository');
  const sourceMain = join(sourceState, 'worktrees', 'run', 'main');
  const cloneRoot = join(root, 'clone');
  const copyState = join(cloneRoot, 'state');
  const copyRepository = join(cloneRoot, 'repository');
  const copyMain = join(copyState, 'worktrees', 'run', 'main');
  let seedCoordinator: Awaited<ReturnType<typeof startActualCf50Coordinator>> | null = null;
  try {
    await mkdir(sourceRepository, { recursive: true });
    await mkdir(join(sourceMain, '..'), { recursive: true });
    await mkdir(join(sourceRepository, 'src'), { recursive: true });
    await writeFile(join(sourceRepository, '.gitignore'), '.pi/\n', 'utf8');
    await writeFile(join(sourceRepository, 'src', 'old.ts'), 'export const oldAuthority = true;\n', 'utf8');
    await writeFile(join(sourceRepository, 'src', 'new.ts'), 'export const futureAuthority = true;\n', 'utf8');
    git(sourceRepository, ['init']);
    git(sourceRepository, ['config', 'user.email', 'c5-worker@example.invalid']);
    git(sourceRepository, ['config', 'user.name', 'C5 Worker Test']);
    git(sourceRepository, ['add', '.']);
    git(sourceRepository, ['commit', '-m', 'synthetic worker baseline']);
    git(sourceRepository, ['worktree', 'add', '-b', 'autopilot/run', sourceMain, 'HEAD']);
    const head = git(sourceRepository, ['rev-parse', 'HEAD']);

    await mkdir(copyState, { recursive: true });
    const mirror = await buildIsolatedGitMirror({ source_repository_root: sourceRepository, source_state_root: sourceState, copy_root: cloneRoot, copy_repository_root: copyRepository, copy_state_root: copyState });
    const environment = await buildCloneEnvironment({ clone_root: cloneRoot, state_root: copyState, project_root: copyRepository, home_root: join(cloneRoot, 'home'), temp_root: join(cloneRoot, 'tmp'), npm_cache_root: join(cloneRoot, 'npm-cache') });
    const privateRoot = join(cloneRoot, 'private');
    await mkdir(join(privateRoot, 'toolchain'), { recursive: true, mode: 0o700 });
    await copyRegularFileNoFollow(process.execPath, join(privateRoot, 'toolchain', 'node'), 0o700);

    const hostNpmCache = join(root, 'host-npm-cache');
    await mkdir(hostNpmCache, { mode: 0o700 });
    checked('npm', ['run', 'build'], process.cwd(), hostNpmCache);
    const packRoot = join(privateRoot, 'candidate-pack');
    await mkdir(packRoot, { mode: 0o700 });
    const candidateName = packedFilename(checked('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packRoot], process.cwd(), hostNpmCache));
    const candidateTarball = join(packRoot, candidateName);
    const candidateDigest = digest(await readFile(candidateTarball));
    const cf50 = await verifyActualCf50Fixture();
    const cf50Tarball = join(privateRoot, 'actual-cf50.tgz');
    await copyFile(cf50.tarballPath, cf50Tarball);

    const repoId = 'synthetic-worker-repo';
    const launchRun = 'synthetic-launch-run';
    const missingRun = 'synthetic-missing-runtime-run';
    const launchWorkstream = 'synthetic-launch';
    const missingWorkstream = 'synthetic-missing';
    const worktreeRoot = join(copyState, 'worktrees', repoId);
    const launchRuntime = join(copyMain, '.pi', 'autopilot', launchWorkstream);
    const missingRuntime = join(copyMain, '.pi', 'autopilot', missingWorkstream);
    const unitId = 'u01-implement';
    const specPath = join(launchRuntime, 'unit-specs', `${unitId}.implement.attempt-1.json`);
    await mkdir(join(launchRuntime, 'unit-specs'), { recursive: true });
    const verificationPlan = { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] };
    const spec = parseAutopilotUnitSpec({
      schema_version: 'autopilot.unit_spec.v1', workstream: launchWorkstream, unit_id: unitId, role: 'implement', template: 'implement', attempt: 1,
      objective: 'Exercise the production scheduler without launching an agent.', cwd: copyMain, model: 'openai-codex/gpt-5.6-terra', thinking: 'high',
      owned_paths: ['src/new.ts'], read_only_paths: [], untouchable_paths: ['private/**'], context_refs: [], validation_commands: [],
      status_output: join(launchRuntime, 'statuses', `${unitId}.implement.attempt-1.json`), receipt_output: join(launchRuntime, 'receipts', `${unitId}.implement.attempt-1.receipt.json`), evidence_dir: join(launchRuntime, 'evidence', unitId),
      stop_boundary: 'No agent is launched by this structural rehearsal.', quality_profile: 'source-change', risk_level: 'medium', acceptance_criteria: ['planner result is measured'], verification_plan: verificationPlan, closure_criteria: ['no external effect starts'], upstream_refs: [],
    });
    const specBytes = `${canonicalJson(spec)}\n`;
    await writeFile(specPath, specBytes, 'utf8');
    const state = parseAutopilotState({ schema_version: 'autopilot.state.v1', workstream: launchWorkstream, updated_at: '2026-07-18T00:00:00.000Z', status: 'running', context_gate: { gate: 'ok', percent: 10 }, last_event_id: 0, ready_queue: [unitId], running: [], blocked: [], completed: [], units: { [unitId]: { unit_id: unitId, role: 'implement', state: 'ready', attempt: 1, summary: 'ready for structural dispatch' } }, operator_questions: [], next_actions: [] });
    const masterPlan = parseAutopilotMasterPlan({ schema_version: 'autopilot.master_plan.v1', workstream: launchWorkstream, mission_ref: 'mission.md', goal_summary: 'Exercise one production dispatch plan.', non_goals: [], definition_of_done: [], risk_level: 'medium', lanes: [{ lane_id: 'main', summary: 'synthetic structural lane', unit_ids: [unitId] }], units: { [unitId]: { unit_id: unitId, role: 'implement', state: 'ready', dependencies: [], summary: 'structural dispatch candidate' } }, ownership_matrix: { owned_paths: ['src/new.ts'], read_only_paths: [], untouchable_paths: ['private/**'], held_paths: [] }, verification_matrix: verificationPlan, closure_criteria: [], current_focus: unitId, last_decision_id: 0, last_event_id: 0, updated_at: '2026-07-18T00:00:00.000Z' });
    await writeFile(join(launchRuntime, 'state.json'), `${canonicalJson(state)}\n`, 'utf8');
    await writeFile(join(launchRuntime, 'master-plan.json'), `${canonicalJson(masterPlan)}\n`, 'utf8');
    await writeFile(join(launchRuntime, 'mission.md'), '# Synthetic structural worker\n', 'utf8');

    const installation = await installActualCf50Package(join(root, 'seed-package'));
    seedCoordinator = await startActualCf50Coordinator({ installation, stateRoot: copyState });
    const seedClient = await loadActualCf50Client({ installation, env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: copyState }, autoStart: false });
    const launchAttachment = await attachSeedRun({ client: seedClient, repoId, runId: launchRun, payload: runPayload({ repoId, runId: launchRun, workstream: launchWorkstream, repositoryRoot: copyRepository, gitCommonDir: mirror.git_common_dir, worktreeRoot, mainWorktree: copyMain, runtimeRoot: launchRuntime, head }) });
    const specDigest = digest(specBytes);
    assertOk(await seedClient.mutate('register-attempt', { repoId, workstreamRun: launchRun, sessionId: launchAttachment.sessionId, fencingGeneration: 1, expectedVersion: launchAttachment.runVersion, idempotencyKey: 'seed-register-attempt' }, { unit_id: unitId, attempt: 1, role: 'implement', spec_ref: `unit-specs/${unitId}.implement.attempt-1.json`, spec_sha256: specDigest, preemptible: true, checkpoint_ordinal: 0, session_lease_id: launchAttachment.leaseId, session_token: launchAttachment.sessionToken }), 'synthetic register attempt');
    const acquisition = await seedClient.mutate('acquire-group', { repoId, workstreamRun: launchRun, sessionId: launchAttachment.sessionId, fencingGeneration: 1, expectedVersion: launchAttachment.runVersion, idempotencyKey: 'seed-acquire-group' }, { acquisition_group_id: 'seed-existing-initial-group', acquisition_kind: 'initial', unit_id: unitId, attempt: 1, requested_leases: [{ path: 'src/old.ts', mode: 'WRITE', purpose: 'retained synthetic dispatch authority' }], reason: 'seed prior acquisition group', normal_release_condition: { condition_type: 'unit-merged', target_id: `${unitId}:1`, evidence: null }, spec_ref: `unit-specs/${unitId}.implement.attempt-1.json`, spec_sha256: specDigest, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: launchAttachment.leaseId, session_token: launchAttachment.sessionToken });
    assertOk(acquisition, 'synthetic acquire group');
    assert.equal(record(acquisition.payload['acquisition_group'], 'synthetic acquisition group')['state'], 'granted');
    await detachSeedRun(seedClient, repoId, launchRun, launchAttachment);
    const missingAttachment = await attachSeedRun({ client: seedClient, repoId, runId: missingRun, payload: runPayload({ repoId, runId: missingRun, workstream: missingWorkstream, repositoryRoot: copyRepository, gitCommonDir: mirror.git_common_dir, worktreeRoot, mainWorktree: copyMain, runtimeRoot: missingRuntime, head }) });
    await detachSeedRun(seedClient, repoId, missingRun, missingAttachment);
    await seedCoordinator.close();
    seedCoordinator = null;

    const request: CorpusCloneRequest = {
      schema_version: 'autopilot.s1_corpus_clone_request.v1', rehearsal_id: 'synthetic-worker-structural-only', created_at: '2026-07-18T00:00:00.000Z', destination_root: cloneRoot, result_path: join(privateRoot, 'forbidden-certification-result.json'),
      candidate_tarball_path: candidateTarball, candidate_tarball_sha256: candidateDigest, cf50_tarball_path: cf50Tarball, cf50_tarball_sha256: S1_ACTUAL_CF50_TARBALL_SHA256,
      corpora: [{ corpus_id: 'synthetic-worker-corpus', state_root: sourceState, repository_root: sourceRepository, database_path: join(sourceState, 'coordinator', 'coordinator.db'), retained_snapshot_roots: [] }],
    };
    const nonSyntheticCorpus = 'operator-private-corpus-only';
    const requiredIncidents: ScenarioWorkerCloneAuthority['manifest']['required_incidents'] = [
      { incident_id: 'I1', corpus_id: nonSyntheticCorpus, cf50_tarball_sha256: S1_ACTUAL_CF50_TARBALL_SHA256, directions: ['cf50-client-to-s1', 's1-client-to-cf50', 'mixed-election'], actions: ['attach', 'heartbeat', 'idempotent-replay', 'natural-restart'] },
      { incident_id: 'I2', corpus_id: nonSyntheticCorpus, operation_id: 'operation-5df1cda32ea1a860e6fe85d8891bb0d2', capture_sha: '8725cf1ba2f361334ce208c7f9e7e417ce780a8a', parent_sha: 'a'.repeat(40), exact_path_set_sha256: digest('paths'), owner_sha256: digest('owner'), historical_write_lease_count: 42, historical_write_lease_ids_sha256: digest('leases') },
      { incident_id: 'I3', corpus_id: nonSyntheticCorpus, semantic_twin_count: 46, semantic_identity_set_sha256: digest('identities'), operation_history_set_sha256: digest('history'), next_attempt_owner_sha256: digest('next') },
      { incident_id: 'I4', corpus_id: nonSyntheticCorpus, counter_behind_repo_sha256: digest('repo'), faulted_run_sha256: digest('faulted'), healthy_run_sha256: digest('healthy'), fatal_negative_kinds: ['counter-ahead', 'payload-owner-ambiguous', 'physical-integrity'] },
      { incident_id: 'I5', corpus_id: nonSyntheticCorpus, missing_registration_count: 34, registration_set_sha256: digest('registrations'), preserved_ref_set_sha256: digest('refs'), exact_filesystem_coverage_count: 7, absence_coverage_count: 27 },
    ];
    const cloneAuthority: ScenarioWorkerCloneAuthority = { request, manifest: { required_incidents: requiredIncidents, backup_coverage: [] } };
    const scenario: ScenarioWorkerScenarioAuthority = { corpus_id: 'synthetic-worker-corpus', scenario_id: 'candidate-main', scenario_root: cloneRoot, state_root: copyState, repository_root: copyRepository, database_path: coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: copyState }).databasePath, candidate_tarball_path: candidateTarball, cf50_tarball_path: cf50Tarball, environment, git_mirror: mirror };
    const output = await runScenarioWorker(cloneAuthority, scenario);

    assert.equal(output.incident_results.length, 0, 'synthetic structural execution must never emit retained-actual incident evidence');
    assert.equal(output.attach_results.length, 2);
    assert.equal(output.doctor_results.length, 2);
    assert.equal(output.dispatch_dry_run_results.length, 2);
    const dispatch = output.dispatch_dry_run_results.map((value) => record(value, 'synthetic worker dispatch row'));
    const launchDigest = corpusRunIdentityDigest(repoId, launchRun);
    const missingDigest = corpusRunIdentityDigest(repoId, missingRun);
    const launchRow = dispatch.find((row) => row['run_id_sha256'] === launchDigest);
    const missingRow = dispatch.find((row) => row['run_id_sha256'] === missingDigest);
    if (launchRow === undefined || missingRow === undefined) throw new Error('synthetic worker omitted one exact durable run');
    assert.equal(launchRow['planner_invoked'], true);
    assert.equal(launchRow['coordinator_admission_probe'], 'not-applicable');
    assert.equal(launchRow['coordinator_admission_probe_code'], 'prior-acquisition-group');
    assert.equal(typeof launchRow['scheduler_plan_sha256'], 'string');
    assert.equal(missingRow['disposition'], 'recovering');
    assert.equal(missingRow['planner_invoked'], false);
    assert.equal(missingRow['scheduler_plan_sha256'], null);
    assert.equal(missingRow['coordinator_admission_probe_code'], 'runtime-artifacts-absent');
    assert.equal(existsSync(request.result_path), false, 'synthetic scenario execution must not write an actual-corpus certification result');
    assert.equal(existsSync(coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: copyState }).lockPath), false, 'scenario worker must release exact lifecycle authority');
  } finally {
    if (seedCoordinator !== null) await seedCoordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});
