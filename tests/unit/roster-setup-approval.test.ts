import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  autopilotRosterContractCanonicalJson,
  autopilotRosterContractSha256OmittingOwnField,
  parseAutopilotRosterContract,
} from '../../src/core/roster/contracts.ts';
import {
  createRosterSetupApprovalSession,
  type RosterSetupApprovalSession,
} from '../../src/core/roster/setup-approval.ts';
import { createRosterSetupReceiptFactory } from '../../src/core/roster/setup-receipt.ts';
import {
  formatAuthorityPath,
  resolveRosterScopePaths,
  rosterRevisionPath,
  RosterStorage,
  type PreRunSelectionAuthorityProjection,
  type RosterAuthorityProjection,
  type RosterConfigAuthorityProjection,
  type RosterReceiptBuildInput,
  type RosterSha256,
  type RosterStorageCodec,
  type RosterStorageScope,
  type SavedRosterRef,
} from '../../src/core/roster/storage.ts';

const CANDIDATE_SET_SHA: RosterSha256 = 'sha256:4b6d1ae6e50461d6eef793291ab7af69edc7de79030bd1bc7f56bbe29379b708';
const NEXT_CANDIDATE_SET_SHA: RosterSha256 = 'sha256:5b6d1ae6e50461d6eef793291ab7af69edc7de79030bd1bc7f56bbe29379b708';
const INVENTORY_SHA: RosterSha256 = 'sha256:5dcdf4a8464efa7588e9f3febcee4a3e09d13f48cac28a17807fc0924bd1eb8b';
const OTHER_INVENTORY_SHA: RosterSha256 = 'sha256:6dcdf4a8464efa7588e9f3febcee4a3e09d13f48cac28a17807fc0924bd1eb8b';
const RECIPE_REGISTRY_SHA: RosterSha256 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const ASSIGNMENT_SHA: RosterSha256 = 'sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4';
const ZERO_SHA: RosterSha256 = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const ORIGINAL_COMMAND = '/autopilot run phase37 --goal roster-freeze';
const FIXED_RECEIPT_TIME = '2026-07-22T12:00:05.000Z';

type Receipt = ReturnType<ReturnType<typeof createRosterSetupReceiptFactory>>['receipt'];

interface Scenario {
  readonly stateRoot: string;
  readonly storage: RosterStorage<Receipt>;
  readonly cruise: RosterFixture;
  readonly precision: RosterFixture;
  readonly configBytes: Uint8Array;
  readonly config: RosterConfigAuthorityProjection;
  readonly session: RosterSetupApprovalSession<Receipt>;
}

interface RosterFixture {
  readonly bytes: Uint8Array;
  readonly ref: SavedRosterRef;
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const root = await realpath(tmpdir());
  const dir = await mkdtemp(join(root, 'roster-setup-approval-'));
  try {
    await chmod(dir, 0o700);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashFieldForSchema(schema: string): string {
  if (schema === 'autopilot.roster.v1') return 'roster_sha256';
  if (schema === 'autopilot.roster_config.v1') return 'config_sha256';
  if (schema === 'autopilot.pre_run_selection.v1') return 'selection_sha256';
  if (schema === 'autopilot.roster_setup_receipt.v1') return 'receipt_sha256';
  throw new Error(`unknown schema ${schema}`);
}

function hashObject(value: Record<string, unknown>): RosterSha256 {
  const schema = value['schema_version'];
  if (typeof schema !== 'string') throw new Error('missing schema_version');
  return autopilotRosterContractSha256OmittingOwnField(value, hashFieldForSchema(schema)) as RosterSha256;
}

function encodeWithHash(value: Record<string, unknown>): Uint8Array {
  const copy = cloneJson(value) as Record<string, unknown>;
  const schema = copy['schema_version'];
  if (typeof schema !== 'string') throw new Error('missing schema_version');
  copy[hashFieldForSchema(schema)] = hashObject(copy);
  return new TextEncoder().encode(autopilotRosterContractCanonicalJson(copy));
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Record<string, unknown>;
}

function decodeRoster(bytes: Uint8Array): RosterAuthorityProjection {
  const parsed = parseObject(bytes);
  return {
    scope: parsed['scope'] as RosterStorageScope,
    selected_scope: parsed['selected_scope'] as RosterStorageScope,
    roster_id: parsed['roster_id'] as string,
    roster_revision: parsed['roster_revision'] as number,
    roster_sha256: parsed['roster_sha256'] as RosterSha256,
    assignment_set_sha256: parsed['assignment_set_sha256'] as RosterSha256,
  };
}

function decodeConfig(bytes: Uint8Array): RosterConfigAuthorityProjection {
  const parsed = parseObject(bytes);
  return {
    scope: parsed['scope'] as RosterStorageScope,
    default_roster_id: parsed['default_roster_id'] as string,
    default_roster_revision: parsed['default_roster_revision'] as number,
    default_roster_sha256: parsed['default_roster_sha256'] as RosterSha256,
    rosters: parsed['rosters'] as SavedRosterRef[],
    previous_config_sha256: parsed['previous_config_sha256'] as RosterSha256 | null,
    config_sha256: parsed['config_sha256'] as RosterSha256,
  };
}

function decodeSelection(bytes: Uint8Array): PreRunSelectionAuthorityProjection {
  const parsed = parseObject(bytes);
  return {
    repo_id: parsed['repo_id'] as string,
    workstream_run: parsed['workstream_run'] as string,
    scope: parsed['scope'] as RosterStorageScope,
    roster_id: parsed['roster_id'] as string,
    roster_revision: parsed['roster_revision'] as number,
    roster_sha256: parsed['roster_sha256'] as RosterSha256,
    assignment_set_sha256: parsed['assignment_set_sha256'] as RosterSha256,
    config_sha256: parsed['config_sha256'] as RosterSha256,
    selection_sha256: parsed['selection_sha256'] as RosterSha256,
  };
}

const codec: RosterStorageCodec<Receipt> = {
  hashBytes(bytes: Uint8Array): RosterSha256 {
    return hashObject(parseObject(bytes));
  },
  decodeRoster,
  decodeConfig,
  decodeSelection,
  createSetupReceipt(input: RosterReceiptBuildInput) {
    return createRosterSetupReceiptFactory({ clock: () => FIXED_RECEIPT_TIME, receiptId: 'receipt-phase37-w2-approval' })(input);
  },
};

function makeRoster(scope: RosterStorageScope, id: string): RosterFixture {
  const bytes = encodeWithHash({
    schema_version: 'autopilot.roster.v1',
    roster_id: id,
    roster_revision: 1,
    display_name: id,
    scope,
    selected_scope: scope,
    assignment_set_sha256: ASSIGNMENT_SHA,
    roster_sha256: ZERO_SHA,
  });
  const parsed = parseObject(bytes);
  return {
    bytes,
    ref: {
      roster_id: parsed['roster_id'] as string,
      roster_revision: parsed['roster_revision'] as number,
      roster_sha256: parsed['roster_sha256'] as RosterSha256,
      assignment_set_sha256: parsed['assignment_set_sha256'] as RosterSha256,
    },
  };
}

function makeConfig(input: {
  readonly stateRoot: string;
  readonly scope: RosterStorageScope;
  readonly rosters: readonly SavedRosterRef[];
  readonly defaultRef: SavedRosterRef;
  readonly previous: RosterSha256 | null;
}): { readonly bytes: Uint8Array; readonly config: RosterConfigAuthorityProjection } {
  const paths = resolveRosterScopePaths({ scope: input.scope, stateRoot: input.stateRoot });
  const rosters = input.rosters.map((ref) => ({
    ...ref,
    path: formatAuthorityPath(rosterRevisionPath(paths, ref), paths.authorityRoot, paths.authorityDisplayRoot),
  }));
  const bytes = encodeWithHash({
    schema_version: 'autopilot.roster_config.v1',
    scope: input.scope,
    default_roster_id: input.defaultRef.roster_id,
    default_roster_revision: input.defaultRef.roster_revision,
    default_roster_sha256: input.defaultRef.roster_sha256,
    rosters,
    previous_config_sha256: input.previous,
    updated_at: FIXED_RECEIPT_TIME,
    config_sha256: ZERO_SHA,
  });
  return { bytes, config: decodeConfig(bytes) };
}

function diagnosticCodes(result: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
  return result.diagnostics.map((item) => item.code);
}

function present(session: RosterSetupApprovalSession<Receipt>, scenario: Scenario, candidateSetSha: RosterSha256 = CANDIDATE_SET_SHA) {
  return session.present({
    scope: 'user',
    candidate_set_sha256: candidateSetSha,
    inventory_sha256: INVENTORY_SHA,
    recipe_registry_sha256: RECIPE_REGISTRY_SHA,
    approved_roster_sha256s: [scenario.cruise.ref.roster_sha256, scenario.precision.ref.roster_sha256],
    default_roster_id: scenario.cruise.ref.roster_id,
    default_roster_revision: scenario.cruise.ref.roster_revision,
    default_roster_sha256: scenario.cruise.ref.roster_sha256,
    expected_previous_config_sha256: null,
  });
}

async function makeScenario(dir: string): Promise<Scenario> {
  const stateRoot = join(dir, 'state');
  const storage = new RosterStorage({ codec, stateRoot });
  const cruise = makeRoster('user', 'cruise-codex-subscription-bdb4f15f0ff9');
  const precision = makeRoster('user', 'precision-codex-subscription-bdb4f15f0ff9');
  const madeConfig = makeConfig({
    stateRoot,
    scope: 'user',
    rosters: [cruise.ref, precision.ref],
    defaultRef: cruise.ref,
    previous: null,
  });
  const session = createRosterSetupApprovalSession({ originalCommand: ORIGINAL_COMMAND, storage });
  return { stateRoot, storage, cruise, precision, configBytes: madeConfig.bytes, config: madeConfig.config, session };
}

void describe('Phase 37 W2 roster setup approval session', () => {
  void it('binds exact restatement proof, requires explicit host authorization, saves once, receipts after readback, and forbids auto-start', async () => {
    await withTempDir(async (dir) => {
      const scenario = await makeScenario(dir);
      const stages: string[] = [];
      const proofResult = present(scenario.session, scenario);
      assert.equal(proofResult.ok, true);
      const proof = proofResult.restatement_proof;
      assert.notEqual(proof, null);
      if (proof === null) throw new Error('proof missing');
      assert.equal(proof.scope, 'user');
      assert.equal(proof.candidate_set_sha256, CANDIDATE_SET_SHA);
      assert.deepEqual(proof.approved_roster_sha256s, [scenario.cruise.ref.roster_sha256, scenario.precision.ref.roster_sha256]);
      assert.equal(proof.default_roster_id, scenario.cruise.ref.roster_id);
      assert.equal(proof.default_roster_revision, 1);
      assert.equal(proof.default_roster_sha256, scenario.cruise.ref.roster_sha256);
      assert.equal(proof.original_command, ORIGINAL_COMMAND);

      const naturalLanguageOnly = scenario.session.authorize({
        restatement_proof_sha256: proof.proof_sha256,
        host_authorized: false,
        approval_text: 'yes, I approve with hidden text that must not be parsed',
      } as Parameters<typeof scenario.session.authorize>[0]);
      assert.equal(naturalLanguageOnly.ok, false);
      assert.deepEqual(diagnosticCodes(naturalLanguageOnly), ['ROSTER_AUTH_REQUIRED']);
      assert.equal(scenario.session.getState().phase, 'presented');

      const authorized = scenario.session.authorize({
        restatement_proof_sha256: proof.proof_sha256,
        host_authorized: true,
        authorization_source: 'explicit-host-authorization-after-restatement',
      });
      assert.equal(authorized.ok, true);
      assert.equal(scenario.session.getState().phase, 'authorized');

      const saved = await scenario.session.save({
        roster_bytes: [scenario.cruise.bytes, scenario.precision.bytes],
        config_bytes: scenario.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
        faults: { onStage: (event) => { stages.push(event.stage); } },
      });
      assert.equal(saved.ok, true);
      assert.equal(saved.status, 'saved');
      assert.equal(saved.write_count, 3);
      assert.equal(saved.lock_count, 1);
      assert.equal(saved.retry_command, ORIGINAL_COMMAND);
      assert.equal(saved.restart_required, true);
      assert.equal(saved.auto_start_allowed, false);
      assert.equal(saved.same_session_save_allowed, false);
      assert.equal(saved.receipt_emitted_after_readback, true);
      assert.ok(stages.indexOf('after-readback') < stages.indexOf('before-receipt'));
      assert.equal(saved.files_touched.some((file) => file.includes('receipt')), false);

      const receipt = saved.receipt?.receipt;
      assert.notEqual(receipt, undefined);
      if (receipt === undefined) throw new Error('receipt missing');
      parseAutopilotRosterContract('autopilot.roster_setup_receipt.v1', receipt);
      assert.equal(receipt.original_command, ORIGINAL_COMMAND);
      assert.equal(receipt.fresh_session_required, true);
      assert.equal(receipt.zero_secrets, true);
      assert.equal(receipt.approved_candidate_set_sha256, CANDIDATE_SET_SHA);
      assert.deepEqual(receipt.approved_roster_sha256s, proof.approved_roster_sha256s);

      const state = scenario.session.getState();
      assert.equal(state.phase, 'saved');
      assert.equal(state.restart_required, true);
      assert.equal(state.same_session_save_allowed, false);
      assert.equal(scenario.session.autoStart().ok, false);
      const replay = await scenario.session.save({ roster_bytes: [scenario.cruise.bytes, scenario.precision.bytes], config_bytes: scenario.configBytes });
      assert.equal(replay.ok, false);
      assert.deepEqual(diagnosticCodes(replay), ['ROSTER_TRANSITION_REQUIRED']);
      assert.equal(replay.write_count, 0);
    });
  });

  void it('keeps reject, refine, and save-without-approval zero-write and zero-lock', async () => {
    await withTempDir(async (dir) => {
      const scenario = await makeScenario(dir);
      const noApprovalPresentation = present(scenario.session, scenario);
      assert.equal(noApprovalPresentation.ok, true);
      const noApproval = await scenario.session.save({ roster_bytes: [scenario.cruise.bytes], config_bytes: scenario.configBytes });
      assert.equal(noApproval.ok, false);
      assert.deepEqual(diagnosticCodes(noApproval), ['ROSTER_AUTH_REQUIRED']);
      assert.equal(noApproval.write_count, 0);
      assert.equal(noApproval.lock_count, 0);
      assert.equal(existsSync(scenario.stateRoot), false);

      const rejectScenario = await makeScenario(join(dir, 'reject'));
      assert.equal(present(rejectScenario.session, rejectScenario).ok, true);
      const rejected = rejectScenario.session.reject();
      assert.equal(rejected.ok, true);
      assert.equal(rejected.write_count, 0);
      assert.equal(rejected.lock_count, 0);
      assert.equal(existsSync(rejectScenario.stateRoot), false);

      const refineScenario = await makeScenario(join(dir, 'refine'));
      assert.equal(present(refineScenario.session, refineScenario).ok, true);
      const refined = refineScenario.session.refine();
      assert.equal(refined.ok, true);
      assert.equal(refined.status, 'refinement-required');
      assert.equal(refined.write_count, 0);
      assert.equal(refined.lock_count, 0);
      assert.equal(existsSync(refineScenario.stateRoot), false);
    });
  });

  void it('blocks stale inventory, candidate, config, and roster-order changes before lock or write and requires re-presentation', async () => {
    await withTempDir(async (dir) => {
      const staleInventory = await makeScenario(join(dir, 'inventory'));
      const inventoryProof = present(staleInventory.session, staleInventory);
      assert.equal(inventoryProof.ok, true);
      if (inventoryProof.restatement_proof === null) throw new Error('missing proof');
      assert.equal(staleInventory.session.authorize({ restatement_proof_sha256: inventoryProof.restatement_proof.proof_sha256, host_authorized: true }).ok, true);
      const inventorySave = await staleInventory.session.save({
        roster_bytes: [staleInventory.cruise.bytes, staleInventory.precision.bytes],
        config_bytes: staleInventory.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: OTHER_INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
      });
      assert.equal(inventorySave.ok, false);
      assert.deepEqual(diagnosticCodes(inventorySave), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
      assert.equal(inventorySave.write_count, 0);
      assert.equal(inventorySave.lock_count, 0);
      assert.equal(staleInventory.session.getState().phase, 'stale-representation-required');
      assert.equal(existsSync(staleInventory.stateRoot), false);

      const rePresented = staleInventory.session.present({
        scope: 'user',
        candidate_set_sha256: NEXT_CANDIDATE_SET_SHA,
        inventory_sha256: OTHER_INVENTORY_SHA,
        recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        approved_roster_sha256s: [staleInventory.cruise.ref.roster_sha256, staleInventory.precision.ref.roster_sha256],
        default_roster_id: staleInventory.cruise.ref.roster_id,
        default_roster_revision: staleInventory.cruise.ref.roster_revision,
        default_roster_sha256: staleInventory.cruise.ref.roster_sha256,
        expected_previous_config_sha256: null,
      });
      assert.equal(rePresented.ok, true);
      if (rePresented.restatement_proof === null) throw new Error('missing reproof');
      assert.equal(staleInventory.session.authorize({ restatement_proof_sha256: rePresented.restatement_proof.proof_sha256, host_authorized: true }).ok, true);
      const afterRepresentation = await staleInventory.session.save({
        roster_bytes: [staleInventory.cruise.bytes, staleInventory.precision.bytes],
        config_bytes: staleInventory.configBytes,
        current_candidate_set_sha256: NEXT_CANDIDATE_SET_SHA,
        current_inventory_sha256: OTHER_INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
      });
      assert.equal(afterRepresentation.ok, true);

      const staleConfig = await makeScenario(join(dir, 'config'));
      const configProof = present(staleConfig.session, staleConfig);
      if (configProof.restatement_proof === null) throw new Error('missing config proof');
      assert.equal(staleConfig.session.authorize({ restatement_proof_sha256: configProof.restatement_proof.proof_sha256, host_authorized: true }).ok, true);
      const configSave = await staleConfig.session.save({
        roster_bytes: [staleConfig.cruise.bytes, staleConfig.precision.bytes],
        config_bytes: staleConfig.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      });
      assert.equal(configSave.ok, false);
      assert.deepEqual(diagnosticCodes(configSave), ['ROSTER_APPROVAL_STALE_CONFIG']);
      assert.equal(configSave.write_count, 0);
      assert.equal(configSave.lock_count, 0);
      assert.equal(existsSync(staleConfig.stateRoot), false);

      const orderDrift = await makeScenario(join(dir, 'order'));
      const orderProof = present(orderDrift.session, orderDrift);
      if (orderProof.restatement_proof === null) throw new Error('missing order proof');
      assert.equal(orderDrift.session.authorize({ restatement_proof_sha256: orderProof.restatement_proof.proof_sha256, host_authorized: true }).ok, true);
      const orderSave = await orderDrift.session.save({
        roster_bytes: [orderDrift.precision.bytes, orderDrift.cruise.bytes],
        config_bytes: orderDrift.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
      });
      assert.equal(orderSave.ok, false);
      assert.deepEqual(diagnosticCodes(orderSave), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
      assert.equal(orderSave.write_count, 0);
      assert.equal(orderSave.lock_count, 0);
      assert.equal(existsSync(orderDrift.stateRoot), false);
    });
  });

  void it('surfaces crash and receipt-replay states without same-session re-save', async () => {
    await withTempDir(async (dir) => {
      const beforeConfig = await makeScenario(join(dir, 'before-config'));
      const beforeProof = present(beforeConfig.session, beforeConfig);
      if (beforeProof.restatement_proof === null) throw new Error('missing before-config proof');
      assert.equal(beforeConfig.session.authorize({ restatement_proof_sha256: beforeProof.restatement_proof.proof_sha256, host_authorized: true }).ok, true);
      const crashedBeforeConfig = await beforeConfig.session.save({
        roster_bytes: [beforeConfig.cruise.bytes, beforeConfig.precision.bytes],
        config_bytes: beforeConfig.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
        faults: { crashStage: 'after-rosters-before-config' },
      });
      assert.equal(crashedBeforeConfig.ok, false);
      assert.equal(crashedBeforeConfig.write_count, 2);
      assert.equal(crashedBeforeConfig.lock_count, 1);
      assert.equal(crashedBeforeConfig.receipt, null);
      assert.deepEqual(diagnosticCodes(crashedBeforeConfig), ['ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING']);
      assert.equal(existsSync(resolveRosterScopePaths({ scope: 'user', stateRoot: beforeConfig.stateRoot }).configPath), false);

      const replayRequired = await makeScenario(join(dir, 'receipt-replay'));
      const replayProof = present(replayRequired.session, replayRequired);
      if (replayProof.restatement_proof === null) throw new Error('missing replay proof');
      assert.equal(replayRequired.session.authorize({ restatement_proof_sha256: replayProof.restatement_proof.proof_sha256, host_authorized: true }).ok, true);
      const crashedAfterReadback = await replayRequired.session.save({
        roster_bytes: [replayRequired.cruise.bytes, replayRequired.precision.bytes],
        config_bytes: replayRequired.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
        faults: { crashStage: 'after-readback-before-receipt' },
      });
      assert.equal(crashedAfterReadback.ok, false);
      assert.equal(crashedAfterReadback.phase, 'receipt-replay-required');
      assert.equal(crashedAfterReadback.restart_required, true);
      assert.equal(crashedAfterReadback.retry_command, ORIGINAL_COMMAND);
      assert.equal(crashedAfterReadback.receipt, null);
      assert.deepEqual(diagnosticCodes(crashedAfterReadback), ['ROSTER_RECEIPT_REPLAY_REQUIRED']);
      assert.equal(existsSync(resolveRosterScopePaths({ scope: 'user', stateRoot: replayRequired.stateRoot }).configPath), true);
      const blockedReplay = await replayRequired.session.save({ roster_bytes: [replayRequired.cruise.bytes, replayRequired.precision.bytes], config_bytes: replayRequired.configBytes });
      assert.equal(blockedReplay.ok, false);
      assert.equal(blockedReplay.write_count, 0);
      assert.deepEqual(diagnosticCodes(blockedReplay), ['ROSTER_TRANSITION_REQUIRED']);
    });
  });

  void it('does not place credentials, prompts, or arbitrary exception text into receipts, states, or diagnostics', async () => {
    await withTempDir(async (dir) => {
      const secret = 'phase37-secret-token-should-not-appear';
      const unsafeStorage = new RosterStorage({ codec, stateRoot: join(dir, 'unsafe-state') });
      const unsafeSession = createRosterSetupApprovalSession({
        originalCommand: `/autopilot run phase37 --api-key ${secret}`,
        storage: unsafeStorage,
      });
      const blocked = unsafeSession.present({
        scope: 'user',
        candidate_set_sha256: CANDIDATE_SET_SHA,
        inventory_sha256: INVENTORY_SHA,
        recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        approved_roster_sha256s: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        default_roster_id: 'cruise-codex-subscription-bdb4f15f0ff9',
        default_roster_revision: 1,
        default_roster_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        expected_previous_config_sha256: null,
      });
      assert.equal(blocked.ok, false);
      assert.equal(JSON.stringify(blocked).includes(secret), false);
      assert.equal(JSON.stringify(unsafeSession.getState()).includes(secret), false);

      const scenario = await makeScenario(join(dir, 'approval-secret'));
      const proofResult = present(scenario.session, scenario);
      if (proofResult.restatement_proof === null) throw new Error('missing proof');
      const authorization = scenario.session.authorize({
        restatement_proof_sha256: proofResult.restatement_proof.proof_sha256,
        host_authorized: true,
        approval_text: `natural language containing ${secret}`,
      } as Parameters<typeof scenario.session.authorize>[0]);
      assert.equal(authorization.ok, true);
      const saved = await scenario.session.save({
        roster_bytes: [scenario.cruise.bytes, scenario.precision.bytes],
        config_bytes: scenario.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
      });
      assert.equal(saved.ok, true);
      assert.equal(JSON.stringify(saved.receipt?.receipt).includes(secret), false);
      assert.equal(JSON.stringify(saved).includes('approval_text'), false);
      assert.equal(JSON.stringify(saved.receipt?.receipt).includes('system_prompt'), false);
      assert.equal(JSON.stringify(saved.receipt?.receipt).includes('credential'), false);

      const leakingCodec: RosterStorageCodec<Receipt> = {
        ...codec,
        decodeRoster(): RosterAuthorityProjection {
          throw new Error(`parser leaked ${secret}`);
        },
      };
      const leakingStorage = new RosterStorage({ codec: leakingCodec, stateRoot: join(dir, 'leaking-state') });
      const leaking = await makeScenario(join(dir, 'leaking-fixtures'));
      const leakingSession = createRosterSetupApprovalSession({ originalCommand: ORIGINAL_COMMAND, storage: leakingStorage });
      const leakingProof = present(leakingSession, { ...leaking, session: leakingSession, storage: leakingStorage });
      if (leakingProof.restatement_proof === null) throw new Error('missing leaking proof');
      assert.equal(leakingSession.authorize({ restatement_proof_sha256: leakingProof.restatement_proof.proof_sha256, host_authorized: true }).ok, true);
      const failed = await leakingSession.save({
        roster_bytes: [leaking.cruise.bytes, leaking.precision.bytes],
        config_bytes: leaking.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
      });
      assert.equal(failed.ok, false);
      assert.equal(JSON.stringify(failed).includes(secret), false);
      assert.deepEqual(diagnosticCodes(failed), ['ROSTER_READBACK_MISMATCH']);
    });
  });

  void it('keeps saved complete-after-state bytes exact', async () => {
    await withTempDir(async (dir) => {
      const scenario = await makeScenario(dir);
      const proofResult = present(scenario.session, scenario);
      if (proofResult.restatement_proof === null) throw new Error('missing proof');
      assert.equal(scenario.session.approve({ restatement_proof_sha256: proofResult.restatement_proof.proof_sha256, host_authorized: true }).ok, true);
      const saved = await scenario.session.save({
        roster_bytes: [scenario.cruise.bytes, scenario.precision.bytes],
        config_bytes: scenario.configBytes,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_inventory_sha256: INVENTORY_SHA,
        current_recipe_registry_sha256: RECIPE_REGISTRY_SHA,
        current_previous_config_sha256: null,
      });
      assert.equal(saved.ok, true);
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot: scenario.stateRoot });
      assert.deepEqual(await readFile(paths.configPath), Buffer.from(scenario.configBytes));
      assert.deepEqual(await readFile(rosterRevisionPath(paths, scenario.cruise.ref)), Buffer.from(scenario.cruise.bytes));
      assert.deepEqual(await readFile(rosterRevisionPath(paths, scenario.precision.ref)), Buffer.from(scenario.precision.bytes));
    });
  });
});
