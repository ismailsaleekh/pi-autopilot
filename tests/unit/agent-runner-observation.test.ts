import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { authorityArtifactPath } from '../../src/core/authority.ts';
import { parseAutopilotReceiptV2, parseAutopilotUnitSpecV2, type AutopilotRosterRequestProfileV1, type AutopilotUnitSpecV2 } from '../../src/core/contracts/index.ts';
import { parseAutopilotChildTerminalAcceptance } from '../../src/core/coordination/terminal-acceptance.ts';
import { proveStructuredAttemptTerminal } from '../../src/core/coordination/terminal-attempt-proof.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { DurableRunSupervisorClient, readCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import {
  AUTOPILOT_STATE_ROOT_ENV,
  coordinationRootForRepo,
  prepareAutopilotWorkstream,
  readPathClaims,
  unitWorktreePathForActiveAutopilot,
} from '../../src/core/parallel-runtime.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { resolveRosterScopePaths, rosterRevisionPath } from '../../src/core/roster/paths.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import { requestProfileFromAssignment } from '../../src/core/roster/runtime-spec.ts';

const MANIFEST = readJsonObject(resolve('design/phase37/roster-contract-freeze.v1.json'));
const FIXTURES = readJsonObject(resolve('design/phase37/roster-acceptance-fixtures.v1.json'));
const REGISTRY = objectAt(FIXTURES, 'object_registry');
const FAKE_TIMEOUT_MS = 10_000;

void describe('W3 v2 runner observation and authentication', () => {
  void it('accepts v2 fake RPC only with child execution observation and native terminal acceptance', async () => {
    await withPreparedV2(async ({ root, prepared, specPath, unitSpec }) => {
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'success-v2' },
        timeoutMsOverride: FAKE_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'PASS');
      const receipt = parseAutopilotReceiptV2(JSON.parse(await readFile(unitSpec.receipt_output, 'utf8')) as unknown);
      assert.equal(receipt.observed_profile.executed_model_id, unitSpec.request_profile.model_id);
      assert.equal(receipt.observed_profile.cache_policy, 'provider-default');
      assert.equal(receipt.observed_profile.service_tier, null);
      assert.equal(receipt.observed_profile.system_prompt_profile, 'pi-default.v1');
      assert.equal(receipt.observed_profile.route_policy_id, 'codex-subscription-v1');
      assert.equal(await pathExists(resolve(prepared.runtimeRoot, 'terminal-v1-compat')), false);
      if (result.statusEntry === null) throw new Error('missing accepted status');
      const acceptancePath = resolve(prepared.runtimeRoot, 'terminal-acceptances', `${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.json`);
      const acceptance = parseAutopilotChildTerminalAcceptance(JSON.parse(await readFile(acceptancePath, 'utf8')) as unknown);
      assert.equal(acceptance.receipt.sha256, sha256Utf8(await readFile(unitSpec.receipt_output, 'utf8')));
      const sessionContextPath = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
      if (sessionContextPath === undefined) throw new Error('missing coordinator session context');
      const session = await readCoordinatorSessionContext(sessionContextPath);
      const proof = proveStructuredAttemptTerminal({
        mainWorktreePath: prepared.mainWorktreePath,
        runtimeRoot: prepared.runtimeRoot,
        repoId: session.repo_id,
        autopilotId: session.autopilot_id,
        workstream: session.workstream,
        workstreamRun: session.workstream_run,
        unitId: unitSpec.unit_id,
        attempt: unitSpec.attempt,
        childLeaseId: acceptance.child_lease_id,
        spec: acceptance.spec,
      });
      assert.equal(proof.proven, true, proof.proven ? undefined : proof.reason);
    });
  });

  void it('rejects absent observation, pre-spend API mismatch, and observed model/tier/cache/prompt drift', async () => {
    await withPreparedV2(async ({ root, specPath }) => {
      const fakePi = await writeFakePi(root);
      await expectAgentRejects(
        () => runAutopilotAgentFromSpecPath(specPath, {
          piExecutable: fakePi,
          env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'pre-spend-api-drift' },
          timeoutMsOverride: FAKE_TIMEOUT_MS,
        }),
        'pi-spawn-failed',
        /pre-spend-profile-mismatch|Pi state does not match roster request profile before model spend/u,
      );
    });

    for (const [scenario, pattern] of [
      ['absent-observer', /missing or unreadable child execution observation/u],
      ['model-drift', /executed_model_id mismatch/u],
      ['api-drift', /provider-qualified route policy|api mismatch/u],
      ['tier-drift', /service_tier mismatch/u],
      ['cache-drift', /cache_policy mismatch/u],
      ['prompt-drift', /system_prompt_profile mismatch/u],
    ] as const) {
      await withPreparedV2(async ({ root, specPath }) => {
        const fakePi = await writeFakePi(root);
        await expectAgentRejects(
          () => runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: scenario },
            timeoutMsOverride: FAKE_TIMEOUT_MS,
          }),
          'invalid-structured-output',
          pattern,
        );
      });
    }
  });

  void it('rejects forged v2 specs and absent runtime mirrors before fake Pi spawn', async () => {
    await withPreparedV2(async ({ root, specPath, unitSpec }) => {
      const fakePi = await writeFakePi(root);
      const forged = { ...unitSpec, pre_run_selection_sha256: sha('forged-selection') };
      const forgedPath = join(dirname(specPath), 'forged.validate.attempt-1.json');
      await writeFile(forgedPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
      await expectAgentRejects(
        () => runAutopilotAgentFromSpecPath(forgedPath, { piExecutable: fakePi, env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'success-v2' }, timeoutMsOverride: FAKE_TIMEOUT_MS }),
        'spec-invalid',
        /external roster\/selection authentication/u,
      );
    });

    await withPreparedV2(async ({ root, prepared, specPath, unitSpec }) => {
      const fakePi = await writeFakePi(root);
      await rm(resolve(prepared.mainWorktreePath, '.pi', 'autopilot', unitSpec.workstream, 'roster-snapshot.json'), { force: true });
      await expectAgentRejects(
        () => runAutopilotAgentFromSpecPath(specPath, { piExecutable: fakePi, env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'success-v2' }, timeoutMsOverride: FAKE_TIMEOUT_MS }),
        'spec-invalid',
        /runtime roster mirror unavailable|ROSTER_PINNED_SELECTION_UNAVAILABLE|ROSTER_TRANSITION_REQUIRED/u,
      );
    });
  });

  void it('blocks forged, missing, and drifted source-changing v2 auth before preflight side effects', async () => {
    for (const [index, fault] of (['forged-spec', 'missing-mirror', 'mirror-drift'] as const).entries()) {
      await withPreparedV2(async ({ root, prepared, specPath, unitSpec }) => {
        const { fakePi, sentinelPath } = await writeSpawnSentinelPi(root, fault);
        const beforeCoordinator = await coordinatorEffectCounts(prepared);
        let runSpecPath = specPath;
        if (fault === 'forged-spec') {
          const forged = { ...unitSpec, pre_run_selection_sha256: sha(`preauth-forged-${String(index)}`) };
          runSpecPath = join(dirname(specPath), `forged-${String(index)}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.json`);
          await writeFile(runSpecPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
        } else {
          const mirrorPath = resolve(prepared.mainWorktreePath, '.pi', 'autopilot', unitSpec.workstream, 'roster-snapshot.json');
          if (fault === 'missing-mirror') await rm(mirrorPath, { force: true });
          else await writeFile(mirrorPath, '{"schema_version":"autopilot.pre_run_selection.v1","drifted":true}\n', 'utf8');
        }

        await expectAgentRejects(
          () => runAutopilotAgentFromSpecPath(runSpecPath, { piExecutable: fakePi, env: { ...process.env }, timeoutMsOverride: FAKE_TIMEOUT_MS }),
          'spec-invalid',
          /external roster\/selection authentication|preflight authority derivation|runtime roster mirror|pre-run selection|ROSTER_/u,
        );
        await assertNoPreflightSideEffects({ prepared, unitSpec, sentinelPath, beforeCoordinator });
      }, { role: 'implement', unitId: `w3preauth${String(index)}` });
    }
  });

  void it('allows the first source-changing preflight mutation only after valid v2 authentication', async () => {
    await withPreparedV2(async ({ specPath, unitSpec }) => {
      assert.equal(await pathExists(unitSpec.cwd), false, 'fixture starts before unit worktree creation');
      const result = await runAutopilotAgentFromSpecPath(specPath, { dryRun: true });
      assert.equal(result.status, 'dry-run');
      assert.equal(await pathExists(unitSpec.cwd), true, 'valid v2 auth gates the first worktree mutation');
      assert.equal(result.spec.schema_version, 'autopilot.unit_spec.v2');
    }, { role: 'implement', unitId: 'w3validpreauth' });
  });

  void it('rejects unsupported request profile fields pre-spend and rejects ordinary v1 without grandfather authority', async () => {
    await withPreparedV2(async ({ root, specPath }) => {
      const fakePi = await writeFakePi(root);
      await expectAgentRejects(
        () => runAutopilotAgentFromSpecPath(specPath, { piExecutable: fakePi, env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'success-v2' }, timeoutMsOverride: FAKE_TIMEOUT_MS }),
        'spec-invalid',
        /request_profile\.system_prompt_profile/u,
      );
    }, { rosterIndex: 2 });

    await withPreparedV2(async ({ prepared }) => {
      const v1 = {
        schema_version: 'autopilot.unit_spec.v1', workstream: 'w3obs', unit_id: 'v1ordinary', role: 'validate', template: 'validate', attempt: 1,
        objective: 'ordinary v1 should fail', cwd: prepared.mainWorktreePath, model: 'openai-codex/gpt-5.6-sol', thinking: 'xhigh', owned_paths: [], read_only_paths: ['src/index.ts'], untouchable_paths: [],
        context_refs: [
          { path: '.pi/autopilot/w3obs/mission.md', purpose: 'Mission' },
          { path: '.pi/autopilot/w3obs/master-plan.json', purpose: 'Plan' },
        ], validation_commands: ['true'], status_output: join(prepared.runtimeRoot, 'statuses', 'v1ordinary.validate.attempt-1.json'), receipt_output: join(prepared.runtimeRoot, 'receipts', 'v1ordinary.validate.attempt-1.receipt.json'), evidence_dir: join(prepared.runtimeRoot, 'evidence', 'v1ordinary'), stop_boundary: 'stop',
        quality_profile: 'validation-only', risk_level: 'low', acceptance_criteria: ['reject'], verification_plan: verificationPlan(), closure_criteria: ['reject'], upstream_refs: [], timeout_seconds: 60, render_prompt_snapshot: false,
      };
      const v1Path = join(prepared.runtimeRoot, 'unit-specs', 'v1ordinary.validate.attempt-1.json');
      await writeFile(v1Path, `${JSON.stringify(v1, null, 2)}\n`, 'utf8');
      await expectAgentRejects(() => runAutopilotAgentFromSpecPath(v1Path, { dryRun: true }), 'spec-invalid', /unit_spec\.v1 execution is forbidden/u);
      const v1Bytes = await readFile(v1Path, 'utf8');
      await writeFile(`${v1Path}.grandfather-authority.json`, `${JSON.stringify({ schema_version: 'autopilot.v1_grandfather_authority.v1', authority: 'grandfathered-existing-v1', unit_spec_sha256: sha256Utf8(v1Bytes), historical_bytes_mutated: false, reason: 'focused v1 history regression' }, null, 2)}\n`, 'utf8');
      const dryRun = await runAutopilotAgentFromSpecPath(v1Path, { dryRun: true });
      assert.equal(dryRun.status, 'dry-run');
      assert.equal(await readFile(v1Path, 'utf8'), v1Bytes);
    });
  });
});

async function withPreparedV2<T>(run: (context: {
  readonly root: string;
  readonly prepared: Awaited<ReturnType<typeof prepareAutopilotWorkstream>>;
  readonly specPath: string;
  readonly unitSpec: AutopilotUnitSpecV2;
}) => Promise<T>, options: { readonly rosterIndex?: number; readonly role?: AutopilotUnitSpecV2['role']; readonly unitId?: string } = {}): Promise<T> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'autopilot-w3-observation-'));
  const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  const originalSessionContext = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'autopilot-state');
  const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
  try {
    const source = join(root, 'source');
    await initGitSource(source);
    const prepared = await prepareAutopilotWorkstream({ workstream: 'w3obs', sourceCwd: source });
    const supervisor = new DurableRunSupervisorClient(process.env);
    const attachment = await supervisor.attach({ repo: prepared.repo, active: prepared.active, rawSessionId: `w3-observation-${Date.now()}` });
    process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;
    const role = options.role ?? 'validate';
    const unitId = options.unitId ?? (role === 'implement' || role === 'fix' ? 'w3implement' : 'w3validate');
    const authority = await installRosterAuthority({
      stateRoot: process.env[AUTOPILOT_STATE_ROOT_ENV], mainWorktreePath: prepared.mainWorktreePath, workstream: prepared.active.workstream,
      repoId: prepared.active.repo_key, workstreamRun: prepared.active.workstream_run, role, rosterIndex: options.rosterIndex ?? 1,
    });
    const cwd = role === 'implement' || role === 'fix'
      ? unitWorktreePathForActiveAutopilot(prepared.active, unitId, 1)
      : prepared.mainWorktreePath;
    const unitSpec = parseAutopilotUnitSpecV2(makeUnitSpecV2(prepared.mainWorktreePath, prepared.runtimeRoot, authority.requestProfile, authority.selection, authority.assignment, { role, unitId, cwd }));
    const specPath = join(prepared.runtimeRoot, 'unit-specs', `${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.json`);
    await mkdir(dirname(specPath), { recursive: true });
    await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');
    return await run({ root, prepared, specPath, unitSpec });
  } finally {
    await coordinator.close();
    if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    if (originalSessionContext === undefined) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    else process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = originalSessionContext;
    await rm(root, { recursive: true, force: true });
  }
}

async function installRosterAuthority(input: { readonly stateRoot: string; readonly mainWorktreePath: string; readonly workstream: string; readonly repoId: string; readonly workstreamRun: string; readonly role: AutopilotUnitSpecV2['role']; readonly rosterIndex?: number }) {
  const roster = cloneRecord(generatedRoster(input.rosterIndex ?? 1));
  const assignment = arrayAt(roster, 'assignments').map(objectAtValue).find((entry) => entry['role'] === input.role);
  if (assignment === undefined) throw new Error(`missing ${input.role} assignment`);
  const fixtureSelection = objectAt(REGISTRY, 'synthetic_pre_run_selection');
  const selection = buildCanonicalPreRunSelection({
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
  await mkdir(dirname(selection.selection_path), { recursive: true, mode: 0o700 });
  await chmod(join(input.stateRoot, 'roster-selections'), 0o700).catch(() => undefined);
  await chmod(dirname(selection.selection_path), 0o700);
  await writeFile(selection.selection_path, selection.selection_bytes, { mode: 0o600 });
  await chmod(selection.selection_path, 0o600);
  const mirrorPath = resolve(input.mainWorktreePath, '.pi', 'autopilot', input.workstream, 'roster-snapshot.json');
  await mkdir(dirname(mirrorPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(mirrorPath), 0o700);
  await writeFile(mirrorPath, selection.selection_bytes, { mode: 0o600 });
  await chmod(mirrorPath, 0o600);
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot: input.stateRoot });
  const rosterPath = rosterRevisionPath(paths, { roster_id: stringAt(roster, 'roster_id'), roster_revision: numberAt(roster, 'roster_revision') });
  await mkdir(dirname(rosterPath), { recursive: true, mode: 0o700 });
  await chmod(paths.rostersRoot, 0o700).catch(() => undefined);
  await chmod(dirname(rosterPath), 0o700);
  await writeFile(rosterPath, `${canonicalRosterJson(roster)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(rosterPath, 0o600);
  return { selection: { ...selection.selection }, roster, assignment, requestProfile: requestProfileFromAssignment(assignment) };
}

function makeUnitSpecV2(
  mainWorktreePath: string,
  runtimeRoot: string,
  requestProfile: AutopilotRosterRequestProfileV1,
  selection: Readonly<Record<string, unknown>>,
  assignment: Readonly<Record<string, unknown>>,
  options: { readonly role?: AutopilotUnitSpecV2['role']; readonly unitId?: string; readonly cwd?: string } = {},
): AutopilotUnitSpecV2 {
  const role = options.role ?? 'validate';
  const unitId = options.unitId ?? (role === 'implement' || role === 'fix' ? 'w3implement' : 'w3validate');
  const sourceChanging = role === 'implement' || role === 'fix';
  const validationRole = role === 'validate' || role === 'bughunt';
  return {
    schema_version: 'autopilot.unit_spec.v2', workstream: 'w3obs', unit_id: unitId, role, template: role, attempt: 1,
    objective: sourceChanging ? 'Implement W3 preflight-auth side-effect fixture.' : 'Validate W3 child execution observation.', cwd: options.cwd ?? mainWorktreePath, model: requestProfile.model, thinking: requestProfile.thinking,
    owned_paths: sourceChanging ? [`src/${unitId}.ts`] : [], read_only_paths: ['src/index.ts'], untouchable_paths: [], context_refs: [{ path: '.pi/autopilot/w3obs/mission.md', purpose: 'Mission', sha256: null, byte_count: null }], validation_commands: validationRole ? ['true'] : [],
    status_output: join(runtimeRoot, 'statuses', `${unitId}.${role}.attempt-1.json`), receipt_output: join(runtimeRoot, 'receipts', `${unitId}.${role}.attempt-1.receipt.json`), evidence_dir: join(runtimeRoot, 'evidence', unitId), stop_boundary: sourceChanging ? 'Edit only the owned preflight-auth fixture.' : 'Validate only.',
    quality_profile: sourceChanging ? 'source-change' : 'validation-only', risk_level: sourceChanging ? 'medium' : 'low', acceptance_criteria: [sourceChanging ? 'owned fixture can be changed' : 'observation accepted'], verification_plan: verificationPlan(), closure_criteria: [sourceChanging ? 'preflight mutation is gated by v2 auth' : 'receipt.v2 accepted'], upstream_refs: [], timeout_seconds: 60, render_prompt_snapshot: false,
    roster_id: stringAt(selection, 'roster_id'), roster_revision: numberAt(selection, 'roster_revision'), roster_sha256: stringAt(selection, 'roster_sha256'), assignment_sha256: stringAt(assignment, 'assignment_sha256'), pre_run_selection_sha256: stringAt(selection, 'selection_sha256'), request_profile: requestProfile,
  };
}

function verificationPlan(): AutopilotUnitSpecV2['verification_plan'] {
  return { positive_witnesses: [{ id: 'positive-validation-command', command: 'true', expected_signal: 'passes', required: true }], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] };
}

async function initGitSource(source: string): Promise<void> {
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
  await writeFile(join(source, 'src', 'index.ts'), 'export const baseline = true;\n', 'utf8');
  git(source, ['init']);
  git(source, ['config', 'user.email', 'autopilot@example.invalid']);
  git(source, ['config', 'user.name', 'Autopilot Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'baseline']);
}

async function writeFakePi(root: string): Promise<string> {
  const fakePath = join(root, 'fake-pi-v2.mjs');
  await writeFile(fakePath, FAKE_PI_V2_SOURCE, 'utf8');
  await chmod(fakePath, 0o755);
  return fakePath;
}

async function writeSpawnSentinelPi(root: string, label: string): Promise<{ readonly fakePi: string; readonly sentinelPath: string }> {
  const fakePath = join(root, `sentinel-pi-${label}.mjs`);
  const sentinelPath = join(root, `sentinel-pi-${label}.spawned`);
  await writeFile(fakePath, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'spawned\\n', 'utf8');\nprocess.exit(97);\n`, 'utf8');
  await chmod(fakePath, 0o755);
  return { fakePi: fakePath, sentinelPath };
}

interface CoordinatorEffectCounts {
  readonly childLeases: number;
  readonly unitAttempts: number;
  readonly observations: number;
  readonly editLeases: number;
}

async function coordinatorEffectCounts(prepared: Awaited<ReturnType<typeof prepareAutopilotWorkstream>>): Promise<CoordinatorEffectCounts | null> {
  try {
    const status = await new CoordinatorClient({ env: process.env, autoStart: false }).query('status', prepared.active.repo_key, prepared.active.workstream_run);
    return {
      childLeases: arrayLength(status.payload['child_leases']),
      unitAttempts: arrayLength(status.payload['unit_attempts']),
      observations: arrayLength(status.payload['observations']),
      editLeases: arrayLength(status.payload['edit_leases']),
    };
  } catch {
    return null;
  }
}

async function assertNoPreflightSideEffects(input: {
  readonly prepared: Awaited<ReturnType<typeof prepareAutopilotWorkstream>>;
  readonly unitSpec: AutopilotUnitSpecV2;
  readonly sentinelPath: string;
  readonly beforeCoordinator: CoordinatorEffectCounts | null;
}): Promise<void> {
  assert.equal(await pathExists(input.sentinelPath), false, 'forged v2 must not spawn or enter Pi RPC');
  assert.equal(await pathExists(input.unitSpec.cwd), false, 'forged v2 must not create the source-changing unit worktree');
  assert.equal(await pathExists(dirname(input.unitSpec.cwd)), false, 'forged v2 must not create the source-changing unit attempt root');
  assert.equal(await pathExists(dirname(input.unitSpec.status_output)), false, 'forged v2 must not mkdir status output');
  assert.equal(await pathExists(dirname(input.unitSpec.receipt_output)), false, 'forged v2 must not mkdir receipt output');
  assert.equal(await pathExists(input.unitSpec.evidence_dir), false, 'forged v2 must not mkdir evidence output');
  assert.equal(await pathExists(resolve(input.prepared.runtimeRoot, 'rendered-prompts')), false, 'forged v2 must not render a prompt snapshot');
  assert.equal(await pathExists(authorityArtifactPath(input.prepared.runtimeRoot, { unit_id: input.unitSpec.unit_id, role: input.unitSpec.role, attempt: input.unitSpec.attempt })), false, 'forged v2 must not persist lowered authority');
  assert.equal(await pathExists(join(dirname(input.unitSpec.cwd), '_materialized-paths.json')), false, 'forged v2 must not materialize source paths');
  const claims = await readPathClaims(coordinationRootForRepo(input.prepared.active.repo_key, process.env)).catch(() => []);
  assert.equal(claims.some((claim) => claim.unit_id === input.unitSpec.unit_id && claim.attempt === input.unitSpec.attempt), false, 'forged v2 must not retain path claims');
  const claimEventsPath = join(coordinationRootForRepo(input.prepared.active.repo_key, process.env), 'claim-events.jsonl');
  if (await pathExists(claimEventsPath)) {
    const claimEvents = await readFile(claimEventsPath, 'utf8');
    assert.equal(claimEvents.includes(`"unit_id":"${input.unitSpec.unit_id}"`), false, 'forged v2 must not acquire or roll back claims');
  }
  const afterCoordinator = await coordinatorEffectCounts(input.prepared);
  if (input.beforeCoordinator !== null && afterCoordinator !== null) assert.deepEqual(afterCoordinator, input.beforeCoordinator, 'forged v2 must not mutate coordinator projections');
}

async function expectAgentRejects(run: () => Promise<unknown>, failureClass: AutopilotAgentRunError['failureClass'], reasonPattern: RegExp): Promise<void> {
  try { await run(); }
  catch (error) {
    assert.equal(error instanceof AutopilotAgentRunError, true, error instanceof Error ? error.stack : String(error));
    const runError = error as AutopilotAgentRunError;
    assert.equal(runError.failureClass, failureClass, runError.details.reason);
    assert.match(runError.details.reason, reasonPattern);
    return;
  }
  throw new Error('expected AutopilotAgentRunError');
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function generatedRoster(index: number): Readonly<Record<string, unknown>> { return objectAt(arrayAt(MANIFEST, 'generated_rosters'), String(index)); }
function readJsonObject(path: string): Readonly<Record<string, unknown>> { return objectAtValue(JSON.parse(readFileSync(path, 'utf8')) as unknown); }
function cloneRecord(value: unknown): Record<string, unknown> { return JSON.parse(JSON.stringify(value)) as Record<string, unknown>; }
function objectAt(record: unknown, key: string): Readonly<Record<string, unknown>> { return Array.isArray(record) ? objectAtValue(record[Number(key)]) : objectAtValue(objectAtValue(record)[key]); }
function objectAtValue(value: unknown): Readonly<Record<string, unknown>> { if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>; throw new Error('expected object fixture value'); }
function arrayAt(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] { const value = record[key]; if (Array.isArray(value)) return value; throw new Error(`expected array fixture value at ${key}`); }
function stringAt(record: unknown, key: string): string { const value = objectAtValue(record)[key]; if (typeof value === 'string') return value; throw new Error(`expected string value at ${key}`); }
function numberAt(record: unknown, key: string): number { const value = objectAtValue(record)[key]; if (typeof value === 'number') return value; throw new Error(`expected number value at ${key}`); }
function sha(label: string): `sha256:${string}` { return `sha256:${Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64)}` as `sha256:${string}`; }
function sha256Utf8(value: string): `sha256:${string}` { return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }

const FAKE_PI_V2_SOURCE = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const scenario = process.env.AUTOPILOT_FAKE_PI_SCENARIO || 'success-v2';
const contextPath = process.env.AUTOPILOT_AGENT_STATUS_CONTEXT;
const observationPath = process.env.AUTOPILOT_EXECUTION_OBSERVATION_PATH;
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function response(cmd, success = true, extra = {}) { write({ id: cmd.id, type: 'response', command: cmd.type, success, ...extra }); }
function sha256(text) { return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex'); }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'; }
function hashOmitting(value, field) { const clone = JSON.parse(JSON.stringify(value)); clone[field] = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'; delete clone[field]; return sha256(canonical(clone)); }
function loadContext() { if (!contextPath) throw new Error('missing context'); return JSON.parse(readFileSync(contextPath, 'utf8')); }
function requestProfile() { return loadContext().roster_execution_identity.request_profile; }
function state() { const p = requestProfile(); return { model: { id: p.model_id, provider: p.provider_id, api: scenario === 'pre-spend-api-drift' ? 'openai-completions' : p.api }, thinkingLevel: p.thinking, isStreaming: false, sessionId: 'fake-v2' }; }
function status(context) { const unit = context.unit_spec; return { schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id, role: unit.role, attempt: unit.attempt, verdict: 'PASS', severity: 'clean', summary: 'fake v2 pass', changed_paths: [], findings: [], commands: [{ command: 'true', status: 'passed', exit_code: 0, summary: 'true passed' }], evidence_refs: [], report_ref: null, covered_witness_ids: ['positive-validation-command'], next_action: 'accept' }; }
function observedProfile(p) { const observed = { provider_id: p.provider_id, requested_model_id: p.model_id, executed_model_id: p.model_id, api: p.api, thinking: p.thinking, service_tier: p.service_tier, cache_policy: p.cache_policy, system_prompt_profile: p.system_prompt_profile, system_prompt_sha256: sha256('fake-system-prompt'), route_policy_id: p.route_policy_id, route_policy_revision: p.route_policy_revision, request_profile_sha256: p.request_profile_sha256, observed_profile_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }; observed.observed_profile_sha256 = hashOmitting(observed, 'observed_profile_sha256'); return observed; }
function emitObservation(context, final) { if (scenario === 'absent-observer') return; const p = context.roster_execution_identity.request_profile; const profile = { service_tier: scenario === 'tier-drift' ? 'priority' : p.service_tier, cache_policy: scenario === 'cache-drift' ? 'none' : p.cache_policy, system_prompt_profile: scenario === 'prompt-drift' ? 'anthropic-autopilot-sanitized.v1' : p.system_prompt_profile, system_prompt_sha256: sha256('fake-system-prompt'), route_policy_id: p.route_policy_id, route_policy_revision: p.route_policy_revision }; const obs = { schema_version: 'autopilot.execution_observation.v1', source: 'fake-rpc-subprocess.v1', observed_at: '2026-07-23T00:00:00.000Z', mode: 'rpc', active_model: { provider: p.provider_id, id: p.model_id, api: p.api }, final_assistant_message: { provider: final.provider, model: final.model, api: final.api, stopReason: final.stopReason }, execution_profile: profile, diagnostics: [] }; mkdirSync(dirname(observationPath), { recursive: true }); writeFileSync(observationPath, JSON.stringify(obs, null, 2) + '\\n', 'utf8'); }
function emitArtifacts() { const context = loadContext(); const p = context.roster_execution_identity.request_profile; const s = status(context); mkdirSync(dirname(context.status_output), { recursive: true }); mkdirSync(dirname(context.receipt_output), { recursive: true }); const statusBytes = JSON.stringify(s, null, 2) + '\\n'; writeFileSync(context.status_output, statusBytes, 'utf8'); const statusSha = sha256(statusBytes); const receipt = { schema_version: 'autopilot.receipt.v2', tool_name: 'autopilot_emit_status', workstream: s.workstream, unit_id: s.unit_id, role: s.role, attempt: s.attempt, emitted_at: '2026-07-23T00:00:00.000Z', status_output: context.status_output, status_sha256: statusSha, schema_sha256: context.schema_sha256, tool_call_id: 'call-fake-v2-1', provider_identity: context.provider_identity, expected_identity_hash: context.expected_identity_hash, roster_id: context.roster_execution_identity.roster_id, roster_revision: context.roster_execution_identity.roster_revision, roster_sha256: context.roster_execution_identity.roster_sha256, assignment_sha256: context.roster_execution_identity.assignment_sha256, pre_run_selection_sha256: context.roster_execution_identity.pre_run_selection_sha256, request_profile: p, observed_profile: observedProfile(p) }; writeFileSync(context.receipt_output, JSON.stringify(receipt, null, 2) + '\\n', 'utf8'); const details = { schema_version: 'autopilot.status_tool_result.v1', tool_name: 'autopilot_emit_status', tool_call_id: 'call-fake-v2-1', terminating: true, status_sha256: statusSha, schema_sha256: context.schema_sha256, expected_identity_hash: context.expected_identity_hash }; write({ type: 'tool_result', toolName: 'autopilot_emit_status', toolCallId: 'call-fake-v2-1', isError: false, details }); return context; }
function assistant(context) { const p = context.roster_execution_identity.request_profile; return { role: 'assistant', content: [{ type: 'text', text: 'fake v2 done' }], provider: p.provider_id, model: scenario === 'model-drift' ? 'gpt-5.6-terra' : p.model_id, api: scenario === 'api-drift' ? 'openai-completions' : p.api, usage: { input: 1, output: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }; }
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => { const cmd = JSON.parse(line); if (cmd.type === 'get_state') { response(cmd, true, { data: state() }); return; } if (cmd.type === 'get_session_stats') { response(cmd, true, { data: {} }); return; } if (cmd.type === 'prompt') { response(cmd); write({ type: 'agent_start' }); write({ type: 'turn_start' }); const context = emitArtifacts(); const msg = assistant(context); emitObservation(context, msg); write({ type: 'message_end', message: msg }); write({ type: 'turn_end', message: msg, toolResults: [] }); write({ type: 'agent_end', messages: [msg] }); return; } response(cmd, false, { error: 'unsupported' }); });
`;
