import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import {
  parseAutopilotUnitSpecV2,
  type AutopilotRosterRequestProfileV1,
  type AutopilotUnitSpecV2,
} from '../../src/core/contracts/index.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { resolveRosterScopePaths, rosterRevisionPath } from '../../src/core/roster/paths.ts';
import { requestProfileFromAssignment } from '../../src/core/roster/runtime-spec.ts';
import { buildW4CertifiedRosterForCandidate, SEED_CANDIDATES } from '../../src/core/roster/provider-recipes.ts';
import { authorizeExistingRunRosterTransitionInput, buildExistingRunRosterTransitionProposal, commitApprovedExistingRunRosterTransition, savedRosterRefForSelection, savedRosterRefFromSavedRef } from '../../src/core/roster/transition.ts';

const MANIFEST = readJsonObject(resolve('design/phase37/roster-contract-freeze.v1.json'));
const FIXTURES = readJsonObject(resolve('design/phase37/roster-acceptance-fixtures.v1.json'));
const REGISTRY = objectAt(FIXTURES, 'object_registry');

void describe('agent runner roster v2 identity', () => {
  void it('dry-runs v2 without fixed-roster clamping and writes v2-aware status context', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'rosterw3', sourceCwd: source });
      const supervisor = new DurableRunSupervisorClient(process.env);
      const attachment = await supervisor.attach({ repo: prepared.repo, active: prepared.active, rawSessionId: 'roster-runner-parent' });
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;

      const { selection, assignment, requestProfile } = await installRosterAuthority({
        stateRoot: process.env[AUTOPILOT_STATE_ROOT_ENV] ?? '',
        mainWorktreePath: prepared.mainWorktreePath,
        workstream: prepared.active.workstream,
        repoId: prepared.active.repo_key,
        workstreamRun: prepared.active.workstream_run,
        role: 'validate',
      });
      const unitSpec = parseAutopilotUnitSpecV2(makeUnitSpecV2(prepared.mainWorktreePath, prepared.runtimeRoot, requestProfile, selection, assignment));
      const specPath = join(prepared.runtimeRoot, 'unit-specs', 'u01validate.validate.attempt-1.json');
      await mkdir(dirname(specPath), { recursive: true });
      await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');

      const result = await runAutopilotAgentFromSpecPath(specPath, { dryRun: true });
      assert.equal(result.status, 'dry-run');
      assert.equal(result.spec.schema_version, 'autopilot.unit_spec.v2');
      assert.equal(result.spec.model, requestProfile.model);
      assert.equal(result.spec.thinking, requestProfile.thinking);

      const context = JSON.parse(await readFile(result.contextPath, 'utf8')) as Record<string, unknown>;
      assert.equal(context['receipt_schema_version'], 'autopilot.receipt.v2');
      const rosterIdentity = context['roster_execution_identity'] as Record<string, unknown>;
      assert.equal(rosterIdentity['roster_id'], unitSpec.roster_id);
      assert.equal((rosterIdentity['request_profile'] as Record<string, unknown>)['model'], requestProfile.model);

      assert.equal(typeof result.promptSnapshotPath, 'string');
      const prompt = await readFile(result.promptSnapshotPath ?? '', 'utf8');
      assert.match(prompt, new RegExp(requestProfile.model.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.match(prompt, /autopilot_emit_status/u);
      assert.match(prompt, /roster_runtime_identity/u);
    });
  });

  void it('rejects old-roster specs after a transition, enforces new attempts, and refuses untrusted target roster', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'rosterw3', sourceCwd: source });
      const supervisor = new DurableRunSupervisorClient(process.env);
      const attachment = await supervisor.attach({ repo: prepared.repo, active: prepared.active, rawSessionId: 'roster-transition-runner-parent' });
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;
      const stateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV] ?? '';
      await chmod(stateRoot, 0o700);

      const old = await installRosterAuthority({ stateRoot, mainWorktreePath: prepared.mainWorktreePath, workstream: prepared.active.workstream, repoId: prepared.active.repo_key, workstreamRun: prepared.active.workstream_run, role: 'validate' });
      const oldSpec = parseAutopilotUnitSpecV2(makeUnitSpecV2(prepared.mainWorktreePath, prepared.runtimeRoot, old.requestProfile, old.selection, old.assignment));
      const oldSpecPath = join(prepared.runtimeRoot, 'unit-specs', 'u01validate.validate.attempt-1.json');
      await mkdir(dirname(oldSpecPath), { recursive: true });
      await writeFile(oldSpecPath, JSON.stringify(oldSpec), 'utf8');

      await chmod(prepared.mainWorktreePath, 0o700);
      await chmod(join(prepared.mainWorktreePath, '.pi'), 0o700).catch(() => undefined);
      await chmod(join(prepared.mainWorktreePath, '.pi', 'autopilot'), 0o700).catch(() => undefined);
      await chmod(prepared.runtimeRoot, 0o700);
      const target = await installUntrustedW4TargetRoster({ stateRoot });
      const run = { repo_id: prepared.active.repo_key, workstream: prepared.active.workstream, workstream_run: prepared.active.workstream_run, main_worktree_path: prepared.active.main_worktree_path, runtime_root: prepared.active.runtime_root, source_repo: prepared.active.source_repo };
      const proposal = buildExistingRunRosterTransitionProposal({
        stateRoot,
        run,
        from_roster: savedRosterRefForSelection({ selection: old.selection as Parameters<typeof savedRosterRefForSelection>[0]['selection'], stateRoot, trustedProjectRoot: prepared.active.source_repo }),
        to_roster: savedRosterRefFromSavedRef({ scope: 'user', ref: target.ref, stateRoot }),
        reason: 'runner transition test',
        approved_at: '2026-07-23T00:00:00.000Z',
      });
      const approval = authorizeExistingRunRosterTransitionInput({ proposal, source: 'user', text: proposal.approval_phrase }).approval;
      if (approval === null) throw new Error('missing approval');
      const committed = await commitApprovedExistingRunRosterTransition({ stateRoot, run, proposal, approval, expected_active_run: run });
      assert.equal(committed.ok, true, committed.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
      const transitionArtifactSha256 = committed.transition_artifact_sha256;
      if (transitionArtifactSha256 === null) throw new Error('transition artifact sha missing');
      await assert.rejects(() => runAutopilotAgentFromSpecPath(oldSpecPath, { dryRun: true }), /old FROM-roster/u);

      const transitionBytes = await readFile(committed.runtime_transition_path);
      const makeTargetSpec = (attempt: number): AutopilotUnitSpecV2 => parseAutopilotUnitSpecV2({
        ...makeUnitSpecV2(prepared.mainWorktreePath, prepared.runtimeRoot, target.requestProfile, old.selection, target.assignment),
        attempt,
        model: target.requestProfile.model,
        thinking: target.requestProfile.thinking,
        status_output: join(prepared.runtimeRoot, 'statuses', `u01validate.validate.attempt-${String(attempt)}.json`),
        receipt_output: join(prepared.runtimeRoot, 'receipts', `u01validate.validate.attempt-${String(attempt)}.receipt.json`),
        roster_id: target.roster.roster_id,
        roster_revision: target.roster.roster_revision,
        roster_sha256: target.roster.roster_sha256,
        assignment_sha256: target.assignment.assignment_sha256,
        context_refs: [{ path: committed.runtime_transition_ref, purpose: `committed existing-run roster transition ${proposal.transition.transition_id}`, sha256: transitionArtifactSha256, byte_count: transitionBytes.byteLength }],
        request_profile: target.requestProfile,
      });

      const staleTargetSpecPath = join(prepared.runtimeRoot, 'unit-specs', 'u01validate.validate.target-attempt-1.json');
      await writeFile(staleTargetSpecPath, JSON.stringify(makeTargetSpec(1)), 'utf8');
      await assert.rejects(() => runAutopilotAgentFromSpecPath(staleTargetSpecPath, { dryRun: true }), /must be newer than max FROM-roster attempt 1/u);

      const targetSpecPath = join(prepared.runtimeRoot, 'unit-specs', 'u01validate.validate.attempt-2.json');
      await writeFile(targetSpecPath, JSON.stringify(makeTargetSpec(2)), 'utf8');
      await assert.rejects(() => runAutopilotAgentFromSpecPath(targetSpecPath, { dryRun: true }), /not centrally trusted W4-certified/u);
    });
  });
});

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'autopilot-agent-runner-roster-'));
  const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  const originalSessionContext = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'autopilot-state');
  const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
  try {
    return await run(root);
  } finally {
    await coordinator.close();
    if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    if (originalSessionContext === undefined) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    else process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = originalSessionContext;
    await rm(root, { recursive: true, force: true });
  }
}

function makeUnitSpecV2(
  mainWorktreePath: string,
  runtimeRoot: string,
  requestProfile: AutopilotRosterRequestProfileV1,
  selection: Readonly<Record<string, unknown>>,
  assignment: Readonly<Record<string, unknown>>,
): AutopilotUnitSpecV2 {
  return {
    schema_version: 'autopilot.unit_spec.v2',
    workstream: 'rosterw3',
    unit_id: 'u01validate',
    role: 'validate',
    template: 'validate',
    attempt: 1,
    objective: 'Dry-run a v2 roster-selected validation unit.',
    cwd: mainWorktreePath,
    model: requestProfile.model,
    thinking: requestProfile.thinking,
    owned_paths: [],
    read_only_paths: ['src/index.ts'],
    untouchable_paths: [],
    context_refs: [
      { path: '.pi/autopilot/rosterw3/mission.md', purpose: 'Mission', sha256: null, byte_count: null },
      { path: '.pi/autopilot/rosterw3/master-plan.json', purpose: 'Plan', sha256: null, byte_count: null },
    ],
    validation_commands: ['true'],
    status_output: join(runtimeRoot, 'statuses', 'u01validate.validate.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u01validate.validate.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u01validate'),
    stop_boundary: 'Validate only.',
    quality_profile: 'validation-only',
    risk_level: 'low',
    acceptance_criteria: ['dry-run accepted'],
    verification_plan: verificationPlan(),
    closure_criteria: ['prompt rendered'],
    upstream_refs: [],
    timeout_seconds: 60,
    render_prompt_snapshot: true,
    roster_id: stringAt(selection, 'roster_id'),
    roster_revision: numberAt(selection, 'roster_revision'),
    roster_sha256: stringAt(selection, 'roster_sha256'),
    assignment_sha256: stringAt(assignment, 'assignment_sha256'),
    pre_run_selection_sha256: stringAt(selection, 'selection_sha256'),
    request_profile: requestProfile,
  };
}

function verificationPlan(): AutopilotUnitSpecV2['verification_plan'] {
  return {
    positive_witnesses: [{ id: 'positive-validation-command', command: 'true', expected_signal: 'passes', required: true }],
    negative_witnesses: [],
    regression_witnesses: [],
    real_boundary_witnesses: [],
    blast_radius_checks: [],
    docs_schema_prompt_checks: [],
    dirty_tree_checks: [],
  };
}

async function installRosterAuthority(input: {
  readonly stateRoot: string;
  readonly mainWorktreePath: string;
  readonly workstream: string;
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly role: AutopilotUnitSpecV2['role'];
}): Promise<{
  readonly selection: Readonly<Record<string, unknown>>;
  readonly roster: Readonly<Record<string, unknown>>;
  readonly assignment: Readonly<Record<string, unknown>>;
  readonly requestProfile: AutopilotRosterRequestProfileV1;
}> {
  const roster = cloneRecord(generatedRoster(1));
  const assignment = arrayAt(roster, 'assignments').map(objectAtValue).find((entry) => entry['role'] === input.role);
  if (assignment === undefined) throw new Error(`missing ${input.role} assignment`);
  const fixtureSelection = objectAt(REGISTRY, 'synthetic_pre_run_selection');
  const canonicalSelection = buildCanonicalPreRunSelection({
    stateRoot: input.stateRoot,
    repo_id: input.repoId,
    workstream_run: input.workstreamRun,
    selected: {
      scope: 'user',
      roster_id: stringAt(roster, 'roster_id'),
      roster_revision: numberAt(roster, 'roster_revision'),
      roster_sha256: stringAt(roster, 'roster_sha256') as `sha256:${string}`,
      assignment_set_sha256: stringAt(roster, 'assignment_set_sha256') as `sha256:${string}`,
      config_sha256: stringAt(fixtureSelection, 'config_sha256') as `sha256:${string}`,
    },
  });
  await mkdir(dirname(canonicalSelection.selection_path), { recursive: true, mode: 0o700 });
  await chmod(join(input.stateRoot, 'roster-selections'), 0o700).catch(() => undefined);
  await chmod(dirname(canonicalSelection.selection_path), 0o700);
  await writeFile(canonicalSelection.selection_path, canonicalSelection.selection_bytes, { mode: 0o600 });
  await chmod(canonicalSelection.selection_path, 0o600);
  const mirrorPath = resolve(input.mainWorktreePath, '.pi', 'autopilot', input.workstream, 'roster-snapshot.json');
  await mkdir(dirname(mirrorPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(mirrorPath), 0o700);
  await writeFile(mirrorPath, canonicalSelection.selection_bytes, { mode: 0o600 });
  await chmod(mirrorPath, 0o600);
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot: input.stateRoot });
  const rosterPath = rosterRevisionPath(paths, { roster_id: stringAt(roster, 'roster_id'), roster_revision: numberAt(roster, 'roster_revision') });
  await mkdir(dirname(rosterPath), { recursive: true, mode: 0o700 });
  await chmod(paths.rostersRoot, 0o700).catch(() => undefined);
  await chmod(dirname(rosterPath), 0o700);
  await writeFile(rosterPath, `${canonicalRosterJson(roster)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(rosterPath, 0o600);
  return {
    selection: canonicalSelection.selection as unknown as Readonly<Record<string, unknown>>,
    roster,
    assignment,
    requestProfile: requestProfileFromAssignment(assignment),
  };
}

async function installUntrustedW4TargetRoster(input: { readonly stateRoot: string }): Promise<{
  readonly roster: ReturnType<typeof buildW4CertifiedRosterForCandidate> extends infer T ? NonNullable<T> : never;
  readonly ref: { readonly roster_id: string; readonly roster_revision: number; readonly roster_sha256: `sha256:${string}`; readonly assignment_set_sha256: `sha256:${string}` };
  readonly assignment: Readonly<Record<string, unknown>> & { readonly assignment_sha256: string };
  readonly requestProfile: AutopilotRosterRequestProfileV1;
}> {
  const candidate = SEED_CANDIDATES.find((entry) => entry.candidate_id === 'kimi-coding-precision-v1');
  if (candidate === undefined) throw new Error('missing target candidate');
  const manifestSha = `sha256:${'9'.repeat(64)}` as const;
  const roster = buildW4CertifiedRosterForCandidate({ candidate, certification_manifest_id: 'test-kimi-live-manifest', certification_manifest_sha256: manifestSha });
  if (roster === null) throw new Error('target roster unavailable');
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot: input.stateRoot });
  const ref = { roster_id: roster.roster_id, roster_revision: roster.roster_revision, roster_sha256: roster.roster_sha256, assignment_set_sha256: roster.assignment_set_sha256 };
  const rosterPath = rosterRevisionPath(paths, ref);
  await mkdir(dirname(rosterPath), { recursive: true, mode: 0o700 });
  await chmod(paths.rostersRoot, 0o700).catch(() => undefined);
  await chmod(dirname(rosterPath), 0o700);
  await writeFile(rosterPath, canonicalRosterJson(roster), { encoding: 'utf8', mode: 0o600 });
  await chmod(rosterPath, 0o600);
  const assignment = roster.assignments.find((entry) => entry.role === 'validate');
  if (assignment === undefined) throw new Error('missing target validate assignment');
  return { roster, ref, assignment: assignment as unknown as Readonly<Record<string, unknown>> & { readonly assignment_sha256: string }, requestProfile: requestProfileFromAssignment(assignment) };
}

async function initGitSource(source: string): Promise<void> {
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
  await writeFile(join(source, 'src', 'index.ts'), 'export const roster = "baseline";\n', 'utf8');
  git(source, ['init']);
  git(source, ['config', 'user.email', 'autopilot@example.invalid']);
  git(source, ['config', 'user.name', 'Autopilot Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'baseline']);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function generatedRoster(index: number): Readonly<Record<string, unknown>> {
  return objectAt(arrayAt(MANIFEST, 'generated_rosters'), String(index));
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> {
  return objectAtValue(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function objectAt(record: unknown, key: string): Readonly<Record<string, unknown>> {
  if (Array.isArray(record)) return objectAtValue(record[Number(key)]);
  return objectAtValue(objectAtValue(record)[key]);
}

function objectAtValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  throw new Error('expected object fixture value');
}

function arrayAt(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = record[key];
  if (Array.isArray(value)) return value;
  throw new Error(`expected array fixture value at ${key}`);
}

function stringAt(record: unknown, key: string): string {
  const value = objectAtValue(record)[key];
  if (typeof value === 'string') return value;
  throw new Error(`expected string value at ${key}`);
}

function numberAt(record: unknown, key: string): number {
  const value = objectAtValue(record)[key];
  if (typeof value === 'number') return value;
  throw new Error(`expected number value at ${key}`);
}
