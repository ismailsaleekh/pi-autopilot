import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync, lstatSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertRosterStorageNodeGuarantees,
  defaultUserStateRoot,
  formatAuthorityPath,
  preRunSelectionPath,
  resolveRosterScopePaths,
  rosterRevisionPath,
  RosterStorage,
  RosterStorageError,
  sha256Bytes,
  type PreRunSelectionAuthorityProjection,
  type RosterAuthorityProjection,
  type RosterConfigAuthorityProjection,
  type RosterReceiptBuildInput,
  type RosterReceiptEmission,
  type RosterSha256,
  type RosterStorageCodec,
  type RosterStorageScope,
  type SavedRosterRef,
} from '../../src/core/roster/storage.ts';
import { publishCreateOnlyAtomic } from '../../src/core/roster/transaction.ts';

const CANDIDATE_SET_SHA: RosterSha256 = 'sha256:4b6d1ae6e50461d6eef793291ab7af69edc7de79030bd1bc7f56bbe29379b708';
const ASSIGNMENT_CRUISE: RosterSha256 = 'sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4';
const ASSIGNMENT_AFTERBURNER: RosterSha256 = 'sha256:7814ccd19c5807b001764c9a6a40f6d1e7e669c6fda29220c1f4e0e96c309e5d';
const ZERO_SHA: RosterSha256 = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const root = await realpath(tmpdir());
  const dir = await mkdtemp(join(root, 'roster-storage-'));
  try {
    await chmod(dir, 0o700);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
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
  const hashField = hashFieldForSchema(schema);
  const copy = cloneJson(value);
  delete (copy as Record<string, unknown>)[hashField];
  return `sha256:${createHash('sha256').update(`${canonicalJson(copy)}\n`).digest('hex')}`;
}

function encodeWithHash(value: Record<string, unknown>): Uint8Array {
  const copy: Record<string, unknown> = cloneJson(value);
  const schema = copy['schema_version'];
  if (typeof schema !== 'string') throw new Error('missing schema_version');
  const hashField = hashFieldForSchema(schema);
  copy[hashField] = hashObject(copy);
  return Buffer.from(`${canonicalJson(copy)}\n`, 'utf8');
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Record<string, unknown>;
}

function decodeRosterSync(bytes: Uint8Array): RosterAuthorityProjection {
  const parsed = parseObject(bytes);
  const base = {
    scope: parsed['scope'] as RosterStorageScope,
    selected_scope: parsed['selected_scope'] as RosterStorageScope,
    roster_id: parsed['roster_id'] as string,
    roster_revision: parsed['roster_revision'] as number,
    roster_sha256: parsed['roster_sha256'] as RosterSha256,
    assignment_set_sha256: parsed['assignment_set_sha256'] as RosterSha256,
  };
  return typeof parsed['path'] === 'string' ? { ...base, path: parsed['path'] } : base;
}

function decodeConfigSync(bytes: Uint8Array): RosterConfigAuthorityProjection {
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

function decodeSelectionSync(bytes: Uint8Array): PreRunSelectionAuthorityProjection {
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

const codec: RosterStorageCodec<Record<string, unknown>> = {
  hashBytes(bytes: Uint8Array): RosterSha256 {
    const parsed = parseObject(bytes);
    return hashObject(parsed);
  },
  decodeRoster: decodeRosterSync,
  decodeConfig: decodeConfigSync,
  decodeSelection: decodeSelectionSync,
  createSetupReceipt(input: RosterReceiptBuildInput): RosterReceiptEmission<Record<string, unknown>> {
    const receipt = {
      schema_version: 'autopilot.roster_setup_receipt.v1',
      receipt_id: 'receipt-phase37-w1-storage',
      scope: input.scope,
      saved_rosters: input.saved_rosters,
      default_roster_id: input.default_roster_id,
      default_roster_revision: input.default_roster_revision,
      default_roster_sha256: input.default_roster_sha256,
      approved_candidate_set_sha256: input.approved_candidate_set_sha256,
      approved_roster_sha256s: input.approved_roster_sha256s,
      config_sha256: input.config_sha256,
      original_command: input.original_command,
      fresh_session_required: true,
      zero_secrets: true,
      issued_at: '2026-07-22T12:02:00.000Z',
      receipt_sha256: ZERO_SHA,
    };
    const receiptBytes = encodeWithHash(receipt);
    const parsed = parseObject(receiptBytes);
    return {
      receipt: parsed,
      receipt_sha256: parsed['receipt_sha256'] as RosterSha256,
      receipt_bytes: receiptBytes,
    };
  },
};

function makeRoster(scope: RosterStorageScope, id: string, assignment: RosterSha256 = ASSIGNMENT_CRUISE): { bytes: Uint8Array; ref: SavedRosterRef } {
  const roster = {
    schema_version: 'autopilot.roster.v1',
    roster_id: id,
    roster_revision: 1,
    display_name: id,
    scope,
    selected_scope: scope,
    assignment_set_sha256: assignment,
    roster_sha256: ZERO_SHA,
  };
  const bytes = encodeWithHash(roster);
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
  readonly trustedProjectRoot?: string;
}): { bytes: Uint8Array; config: RosterConfigAuthorityProjection } {
  const paths = resolveRosterScopePaths(
    input.scope === 'user'
      ? { scope: input.scope, stateRoot: input.stateRoot }
      : { scope: input.scope, stateRoot: input.stateRoot, trustedProjectRoot: required(input.trustedProjectRoot) },
  );
  const rosters = input.rosters.map((ref) => ({
    ...ref,
    path: formatAuthorityPath(rosterRevisionPath(paths, ref), paths.authorityRoot, paths.authorityDisplayRoot),
  }));
  const config = {
    schema_version: 'autopilot.roster_config.v1',
    scope: input.scope,
    default_roster_id: input.defaultRef.roster_id,
    default_roster_revision: input.defaultRef.roster_revision,
    default_roster_sha256: input.defaultRef.roster_sha256,
    rosters,
    previous_config_sha256: input.previous,
    updated_at: '2026-07-22T12:00:00.000Z',
    config_sha256: ZERO_SHA,
  };
  const bytes = encodeWithHash(config);
  return { bytes, config: decodeConfigSync(bytes) };
}

function makeSelection(input: {
  readonly repoId?: string;
  readonly workstreamRun?: string;
  readonly ref: SavedRosterRef;
  readonly configSha?: RosterSha256;
  readonly selectedAt?: string;
}): { bytes: Uint8Array; selection: PreRunSelectionAuthorityProjection } {
  const selection = {
    schema_version: 'autopilot.pre_run_selection.v1',
    repo_id: input.repoId ?? 'repo-phase37-w0-fixtures',
    workstream_run: input.workstreamRun ?? 'phase37-w0-run-001',
    scope: 'user',
    roster_id: input.ref.roster_id,
    roster_revision: input.ref.roster_revision,
    roster_sha256: input.ref.roster_sha256,
    assignment_set_sha256: input.ref.assignment_set_sha256,
    config_sha256: input.configSha ?? 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38',
    selected_at: input.selectedAt ?? '2026-07-22T12:01:00.000Z',
    selection_sha256: ZERO_SHA,
  };
  const bytes = encodeWithHash(selection);
  return { bytes, selection: decodeSelectionSync(bytes) };
}

function required(value: string | undefined): string {
  if (value === undefined) throw new Error('missing required value');
  return value;
}

async function statMode(path: string): Promise<number> {
  await Promise.resolve();
  return lstatSync(path).mode & 0o777;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

function diagnosticCodes(result: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
  return result.diagnostics.map((item) => item.code);
}

async function assertRosterStorageRejects(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof RosterStorageError && error.code === code);
}

function firstRoster(rosters: readonly { readonly bytes: Uint8Array; readonly ref: SavedRosterRef }[]): { readonly bytes: Uint8Array; readonly ref: SavedRosterRef } {
  const first = rosters[0];
  if (first === undefined) throw new Error('expected at least one roster');
  return first;
}

async function saveTwoRosters(input: {
  readonly stateRoot: string;
  readonly previous?: RosterSha256 | null | undefined;
  readonly scope?: RosterStorageScope | undefined;
  readonly trustedProjectRoot?: string | undefined;
  readonly trusted?: (() => boolean | Promise<boolean>) | undefined;
  readonly faults?: Parameters<RosterStorage['saveApprovedDefault']>[0]['faults'] | undefined;
  readonly mutateConfig?: ((config: RosterConfigAuthorityProjection, bytes: Uint8Array) => Uint8Array) | undefined;
}): Promise<Awaited<ReturnType<RosterStorage<Record<string, unknown>>['saveApprovedDefault']>> & { readonly rosters: readonly { readonly bytes: Uint8Array; readonly ref: SavedRosterRef }[]; readonly configBytes: Uint8Array }> {
  const scope = input.scope ?? 'user';
  const storage = new RosterStorage({ codec, stateRoot: input.stateRoot });
  const cruise = makeRoster(scope, 'cruise-codex-subscription-bdb4f15f0ff9', ASSIGNMENT_CRUISE);
  const precision = makeRoster(scope, 'precision-codex-subscription-bdb4f15f0ff9', ASSIGNMENT_CRUISE);
  const madeConfig = makeConfig(
    scope === 'trusted-project'
      ? {
          stateRoot: input.stateRoot,
          scope,
          rosters: [cruise.ref, precision.ref],
          defaultRef: cruise.ref,
          previous: input.previous ?? null,
          trustedProjectRoot: required(input.trustedProjectRoot),
        }
      : {
          stateRoot: input.stateRoot,
          scope,
          rosters: [cruise.ref, precision.ref],
          defaultRef: cruise.ref,
          previous: input.previous ?? null,
        },
  );
  const configBytes = input.mutateConfig?.(madeConfig.config, madeConfig.bytes) ?? madeConfig.bytes;
  const result = await storage.saveApprovedDefault({
    scope,
    ...(scope === 'trusted-project'
      ? { trustedProject: { root: required(input.trustedProjectRoot), isProjectTrusted: input.trusted ?? (() => true) } }
      : {}),
    approved_candidate_set_sha256: CANDIDATE_SET_SHA,
    current_candidate_set_sha256: CANDIDATE_SET_SHA,
    approved_roster_sha256s: [cruise.ref.roster_sha256, precision.ref.roster_sha256],
    roster_bytes: [cruise.bytes, precision.bytes],
    config_bytes: configBytes,
    expected_previous_config_sha256: input.previous ?? null,
    default_roster_id: cruise.ref.roster_id,
    default_roster_revision: cruise.ref.roster_revision,
    default_roster_sha256: cruise.ref.roster_sha256,
    original_command: '/autopilot phase37',
    faults: input.faults,
  });
  return { ...result, rosters: [cruise, precision] as const, configBytes };
}

void describe('Phase 37 W1 roster storage', () => {
  void it('uses the exact D68 default root and rejects unsupported platform guarantees loudly', () => {
    assert.equal(defaultUserStateRoot('/Users/example'), '/Users/example/.pi/agent/autopilot');
    assert.throws(() => assertRosterStorageNodeGuarantees({ platform: 'win32' }), /ROSTER_STORAGE_UNSUPPORTED_PLATFORM/u);
    assert.throws(() => resolveRosterScopePaths({ scope: 'trusted-project' }), /trustedProjectRoot/u);
  });

  void it('performs zero-write user inspection/propose/reject helpers without creating root, locks, or temps', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const storage = new RosterStorage({ codec, stateRoot });
      const read = await storage.readDefaultRoster({ scope: 'user' });
      assert.equal(read.ok, true);
      assert.equal(read.config, null);
      assert.equal(read.write_count, 0);
      assert.equal(read.lock_count, 0);
      assert.deepEqual(read.files_touched, []);
      assert.equal(existsSync(stateRoot), false);

      const propose = storage.zeroWriteResult('propose');
      const reject = storage.zeroWriteResult('reject');
      assert.equal(propose.write_count, 0);
      assert.equal(propose.lock_count, 0);
      assert.deepEqual(propose.files_touched, []);
      assert.equal(reject.write_count, 0);
      assert.equal(reject.lock_count, 0);
      assert.deepEqual(reject.files_touched, []);
      assert.equal(existsSync(stateRoot), false);
    });
  });

  void it('saves immutable rosters before config, reads back, emits receipt, and uses private owner modes', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const stages: string[] = [];
      const result = await saveTwoRosters({
        stateRoot,
        faults: {
          onStage: (event) => {
            stages.push(event.stage);
          },
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'saved');
      assert.equal(result.write_count, 3);
      assert.equal(result.lock_count, 1);
      assert.equal(result.receipt?.receipt['fresh_session_required'], true);
      assert.equal(result.receipt?.receipt['zero_secrets'], true);
      assert.equal(diagnosticCodes(result).length, 0);
      assert.ok(stages.indexOf('after-rosters-before-config') < stages.indexOf('before-config-publish'));
      assert.ok(stages.indexOf('after-config-publish') < stages.indexOf('before-receipt'));

      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      assert.equal(await statMode(paths.authorityRoot), 0o700);
      assert.equal(await statMode(paths.rostersRoot), 0o700);
      assert.equal(await statMode(paths.configPath), 0o600);
      assert.equal(existsSync(paths.lockPath), false);
      assert.equal(bytesEqual(await readFile(paths.configPath), result.configBytes), true);
      for (const roster of result.rosters) {
        const rosterPath = rosterRevisionPath(paths, roster.ref);
        assert.equal(await statMode(dirname(rosterPath)), 0o700);
        assert.equal(await statMode(rosterPath), 0o600);
        assert.equal(bytesEqual(await readFile(rosterPath), roster.bytes), true);
      }
    });
  });

  void it('rejects complete-after-state config CAS mismatch before lock/temp/write', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const result = await saveTwoRosters({ stateRoot, previous: 'sha256:2222222222222222222222222222222222222222222222222222222222222222' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'blocked');
      assert.deepEqual(diagnosticCodes(result), ['ROSTER_APPROVAL_STALE_CONFIG', 'ROSTER_CONFIG_CAS_MISMATCH']);
      assert.equal(result.write_count, 0);
      assert.equal(result.lock_count, 0);
      assert.equal(existsSync(stateRoot), false);
    });
  });

  void it('requires the default id+revision+hash tuple to match exactly one config roster before locking', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const result = await saveTwoRosters({
        stateRoot,
        mutateConfig: (_config, bytes) => encodeWithHash({
          ...parseObject(bytes),
          default_roster_sha256: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
          config_sha256: ZERO_SHA,
        }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.write_count, 0);
      assert.equal(result.lock_count, 0);
      assert.equal(existsSync(stateRoot), false);
      assert.ok(diagnosticCodes(result).includes('ROSTER_TRANSITION_REQUIRED'));
    });
  });

  void it('rejects approval smuggling through extra/default refs and roster order drift before lock/write', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'smuggle-state');
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      const cruise = makeRoster('user', 'cruise-codex-subscription-bdb4f15f0ff9', ASSIGNMENT_CRUISE);
      const precision = makeRoster('user', 'precision-codex-subscription-bdb4f15f0ff9', ASSIGNMENT_CRUISE);
      const smuggled = makeRoster('user', 'afterburner-codex-subscription-7814ccd19c58', ASSIGNMENT_AFTERBURNER);
      const smuggledPath = rosterRevisionPath(paths, smuggled.ref);
      const seeded = await publishCreateOnlyAtomic({ path: smuggledPath, authorityRoot: paths.authorityRoot, bytes: smuggled.bytes });
      assert.equal(seeded.status, 'created');
      const config = makeConfig({
        stateRoot,
        scope: 'user',
        rosters: [cruise.ref, precision.ref, smuggled.ref],
        defaultRef: smuggled.ref,
        previous: null,
      });
      const result = await new RosterStorage({ codec, stateRoot }).saveApprovedDefault({
        scope: 'user',
        approved_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        approved_roster_sha256s: [cruise.ref.roster_sha256, precision.ref.roster_sha256],
        roster_bytes: [cruise.bytes, precision.bytes],
        config_bytes: config.bytes,
        expected_previous_config_sha256: null,
        default_roster_id: smuggled.ref.roster_id,
        default_roster_revision: smuggled.ref.roster_revision,
        default_roster_sha256: smuggled.ref.roster_sha256,
        original_command: '/autopilot phase37',
      });
      assert.equal(result.ok, false);
      assert.equal(result.write_count, 0);
      assert.equal(result.lock_count, 0);
      assert.deepEqual(diagnosticCodes(result), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
      assert.equal(existsSync(paths.lockPath), false);
      assert.equal(bytesEqual(await readFile(smuggledPath), smuggled.bytes), true);

      const orderStateRoot = join(dir, 'order-state');
      const order = await saveTwoRosters({
        stateRoot: orderStateRoot,
        mutateConfig: (_config, bytes) => {
          const parsed = parseObject(bytes);
          const rosters = parsed['rosters'];
          assert.equal(Array.isArray(rosters), true);
          return encodeWithHash({ ...parsed, rosters: [...(rosters as unknown[])].reverse(), config_sha256: ZERO_SHA });
        },
      });
      assert.equal(order.ok, false);
      assert.equal(order.write_count, 0);
      assert.equal(order.lock_count, 0);
      assert.deepEqual(diagnosticCodes(order), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
      assert.equal(existsSync(orderStateRoot), false);
    });
  });

  void it('checks trusted-project trust before reads and again before save writes', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const projectRoot = join(dir, 'project');
      await mkdir(projectRoot, { mode: 0o700 });
      const storage = new RosterStorage({ codec, stateRoot });
      const read = await storage.readDefaultRoster({
        scope: 'trusted-project',
        trustedProject: { root: projectRoot, isProjectTrusted: () => false },
      });
      assert.equal(read.ok, false);
      assert.deepEqual(diagnosticCodes(read), ['ROSTER_PROJECT_UNTRUSTED']);
      assert.equal(existsSync(join(projectRoot, '.autopilot')), false);

      const save = await saveTwoRosters({
        stateRoot,
        scope: 'trusted-project',
        trustedProjectRoot: projectRoot,
        trusted: () => false,
      });
      assert.equal(save.ok, false);
      assert.deepEqual(diagnosticCodes(save), ['ROSTER_STORAGE_TRUST_REQUIRED']);
      assert.equal(save.write_count, 0);
      assert.equal(save.lock_count, 0);
      assert.equal(existsSync(join(projectRoot, '.autopilot')), false);

      const trustedSave = await saveTwoRosters({
        stateRoot,
        scope: 'trusted-project',
        trustedProjectRoot: projectRoot,
        trusted: () => true,
      });
      assert.equal(trustedSave.ok, true);
      assert.equal(trustedSave.write_count, 3);
      const projectPaths = resolveRosterScopePaths({ scope: 'trusted-project', stateRoot, trustedProjectRoot: projectRoot });
      assert.equal(existsSync(projectPaths.configPath), true);
      assert.equal(existsSync(resolveRosterScopePaths({ scope: 'user', stateRoot }).configPath), false);
      const trustedRead = await storage.readDefaultRoster({
        scope: 'trusted-project',
        trustedProject: { root: projectRoot, isProjectTrusted: () => true },
      });
      assert.equal(trustedRead.ok, true);
      assert.equal(trustedRead.default_roster?.roster_id, 'cruise-codex-subscription-bdb4f15f0ff9');
    });
  });

  void it('publishes pre-run selections create-only with exact-byte idempotency and conflict preservation', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const storage = new RosterStorage({ codec, stateRoot });
      const roster = makeRoster('user', 'cruise-codex-subscription-bdb4f15f0ff9');
      const selection = makeSelection({ ref: roster.ref });
      const first = await storage.publishPreRunSelection({ selection_bytes: selection.bytes });
      assert.equal(first.ok, true);
      assert.equal(first.status, 'published');
      assert.equal(first.write_count, 1);
      assert.equal(first.lock_count, 0);
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      const selectionPath = preRunSelectionPath(paths, selection.selection);
      assert.equal(bytesEqual(await readFile(selectionPath), selection.bytes), true);

      const replay = await storage.publishPreRunSelection({ selection_bytes: selection.bytes });
      assert.equal(replay.ok, true);
      assert.equal(replay.status, 'inspected');
      assert.equal(replay.idempotent_replay, true);
      assert.equal(replay.write_count, 0);
      assert.deepEqual(diagnosticCodes(replay), ['ROSTER_SELECTION_IDEMPOTENT_REPLAY']);

      const conflictBytes = makeSelection({ ref: roster.ref, selectedAt: '2026-07-22T12:02:00.000Z' }).bytes;
      const conflict = await storage.publishPreRunSelection({ selection_bytes: conflictBytes });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.status, 'blocked');
      assert.deepEqual(diagnosticCodes(conflict), ['ROSTER_CREATE_ONLY_CONFLICT']);
      assert.equal(bytesEqual(await readFile(selectionPath), selection.bytes), true);
    });
  });

  void it('leaves explicit orphan immutable rosters and no default on crash before config', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const result = await saveTwoRosters({ stateRoot, faults: { crashStage: 'after-rosters-before-config' } });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.crash_outcome, 'orphaned-rosters-no-config');
      assert.equal(result.write_count, 2);
      assert.equal(result.lock_count, 1);
      assert.deepEqual(diagnosticCodes(result), ['ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING']);
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      assert.equal(existsSync(paths.configPath), false);
      for (const roster of result.rosters) {
        assert.equal(existsSync(rosterRevisionPath(paths, roster.ref)), true);
      }
      const read = await new RosterStorage({ codec, stateRoot }).readDefaultRoster({ scope: 'user' });
      assert.equal(read.ok, true);
      assert.equal(read.config, null);
    });
  });

  void it('blocks receipt and requires replay when readback detects post-config drift', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      let tampered = false;
      const result = await saveTwoRosters({
        stateRoot,
        faults: {
          onStage: async (event) => {
            if (event.stage !== 'after-config-publish' || tampered) return;
            tampered = true;
            const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
            const rosterPath = rosterRevisionPath(paths, makeRoster('user', 'cruise-codex-subscription-bdb4f15f0ff9').ref);
            await writeFile(rosterPath, Buffer.from('{"tampered":true}\n', 'utf8'));
            await chmod(rosterPath, 0o600);
          },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.crash_outcome, 'config-published-receipt-replay-required');
      assert.equal(result.write_count, 3);
      assert.deepEqual(diagnosticCodes(result), ['ROSTER_READBACK_MISMATCH', 'ROSTER_RECEIPT_REPLAY_REQUIRED']);
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      assert.equal(existsSync(paths.configPath), true);
    });
  });

  void it('fails closed on symlink config, hard-linked roster authority, and broad permissions', async () => {
    await withTempDir(async (dir) => {
      const symlinkRoot = join(dir, 'symlink-state');
      await mkdir(symlinkRoot, { mode: 0o700 });
      const outside = join(dir, 'outside-config.json');
      await writeFile(outside, Buffer.from('{}\n'));
      await symlink(outside, join(symlinkRoot, 'config.json'));
      const symlinkRead = await new RosterStorage({ codec, stateRoot: symlinkRoot }).readDefaultRoster({ scope: 'user' });
      assert.equal(symlinkRead.ok, false);
      assert.deepEqual(diagnosticCodes(symlinkRead), ['ROSTER_STORAGE_AUTHORITY_UNSAFE']);

      const hardlinkRoot = join(dir, 'hardlink-state');
      const saved = await saveTwoRosters({ stateRoot: hardlinkRoot });
      assert.equal(saved.ok, true);
      const hardlinkPaths = resolveRosterScopePaths({ scope: 'user', stateRoot: hardlinkRoot });
      const rosterPath = rosterRevisionPath(hardlinkPaths, firstRoster(saved.rosters).ref);
      await link(rosterPath, join(dir, 'roster-hardlink-alias.json'));
      const hardlinkRead = await new RosterStorage({ codec, stateRoot: hardlinkRoot }).readDefaultRoster({ scope: 'user' });
      assert.equal(hardlinkRead.ok, false);
      assert.deepEqual(diagnosticCodes(hardlinkRead), ['ROSTER_STORAGE_AUTHORITY_UNSAFE']);

      const modeRoot = join(dir, 'mode-state');
      const modeSaved = await saveTwoRosters({ stateRoot: modeRoot });
      assert.equal(modeSaved.ok, true);
      const modePaths = resolveRosterScopePaths({ scope: 'user', stateRoot: modeRoot });
      await chmod(modePaths.configPath, 0o644);
      const modeRead = await new RosterStorage({ codec, stateRoot: modeRoot }).readDefaultRoster({ scope: 'user' });
      assert.equal(modeRead.ok, false);
      assert.deepEqual(diagnosticCodes(modeRead), ['ROSTER_STORAGE_PERMISSION_DENIED']);
    });
  });

  void it('redacts arbitrary exception text from secret-free storage diagnostics', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'secret-state');
      const secret = 'phase37-secret-token-should-not-appear';
      const roster = makeRoster('user', 'cruise-codex-subscription-bdb4f15f0ff9');
      const config = makeConfig({ stateRoot, scope: 'user', rosters: [roster.ref], defaultRef: roster.ref, previous: null });
      async function attempt(leakingCodec: RosterStorageCodec<Record<string, unknown>>): Promise<Awaited<ReturnType<RosterStorage<Record<string, unknown>>['saveApprovedDefault']>>> {
        return await new RosterStorage({ codec: leakingCodec, stateRoot }).saveApprovedDefault({
          scope: 'user',
          approved_candidate_set_sha256: CANDIDATE_SET_SHA,
          current_candidate_set_sha256: CANDIDATE_SET_SHA,
          approved_roster_sha256s: [roster.ref.roster_sha256],
          roster_bytes: [roster.bytes],
          config_bytes: config.bytes,
          expected_previous_config_sha256: null,
          default_roster_id: roster.ref.roster_id,
          default_roster_revision: roster.ref.roster_revision,
          default_roster_sha256: roster.ref.roster_sha256,
          original_command: '/autopilot phase37',
        });
      }

      const generic = await attempt({
        ...codec,
        decodeRoster(): RosterAuthorityProjection {
          throw new Error(`arbitrary parser failure leaked ${secret}`);
        },
      });
      assert.equal(generic.ok, false);
      assert.deepEqual(diagnosticCodes(generic), ['ROSTER_READBACK_MISMATCH']);

      const internal = await attempt({
        ...codec,
        decodeRoster(): RosterAuthorityProjection {
          throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `invalid path included ${secret}`);
        },
      });
      assert.equal(internal.ok, false);
      assert.deepEqual(diagnosticCodes(internal), ['ROSTER_STORAGE_PATH_INVALID']);

      for (const result of [generic, internal]) {
        for (const item of result.diagnostics) {
          assert.equal(item.secret_free, true);
          assert.equal(item.message.includes(secret), false);
          assert.equal(item.message.includes('arbitrary parser failure'), false);
          assert.equal(item.message.includes('invalid path included'), false);
          assert.ok(item.message.length <= 160);
        }
      }
    });
  });

  void it('recovers only byte-identical create-only orphan temp hardlinks and fails closed otherwise', async () => {
    await withTempDir(async (dir) => {
      const authorityRoot = join(dir, 'create-only-authority');
      const path = join(authorityRoot, 'selection.json');
      const bytes = Buffer.from('{"schema_version":"test","value":1}\n', 'utf8');
      const created = await publishCreateOnlyAtomic({ path, authorityRoot, bytes });
      assert.equal(created.status, 'created');
      const orphanTemp = join(authorityRoot, `.${basename(path)}.tmp-123-123e4567-e89b-42d3-a456-426614174000`);
      await link(path, orphanTemp);
      assert.equal(lstatSync(path).nlink, 2);

      await assertRosterStorageRejects(
        () => publishCreateOnlyAtomic({ path, authorityRoot, bytes: Buffer.from('{"schema_version":"test","value":2}\n', 'utf8') }),
        'ROSTER_STORAGE_AUTHORITY_UNSAFE',
      );
      assert.equal(existsSync(orphanTemp), true);
      assert.equal(lstatSync(path).nlink, 2);

      const replay = await publishCreateOnlyAtomic({ path, authorityRoot, bytes });
      assert.equal(replay.status, 'idempotent');
      assert.equal(existsSync(orphanTemp), false);
      assert.equal(lstatSync(path).nlink, 1);
      assert.equal(bytesEqual(await readFile(path), bytes), true);

      const unprovenAlias = join(authorityRoot, 'selection-unproven-alias.json');
      await link(path, unprovenAlias);
      await assertRosterStorageRejects(
        () => publishCreateOnlyAtomic({ path, authorityRoot, bytes }),
        'ROSTER_STORAGE_AUTHORITY_UNSAFE',
      );
      assert.equal(existsSync(unprovenAlias), true);
      assert.equal(lstatSync(path).nlink, 2);
      await unlink(unprovenAlias);
      assert.equal(lstatSync(path).nlink, 1);
    });
  });

  void it('preserves existing immutable roster bytes on create-only collision', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const first = await saveTwoRosters({ stateRoot });
      assert.equal(first.ok, true);
      const previousConfig = first.config_sha256;
      if (previousConfig === null) throw new Error('expected config sha');
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      const existingRosterPath = rosterRevisionPath(paths, firstRoster(first.rosters).ref);
      const originalBytes = await readFile(existingRosterPath);
      const collidingRoster = encodeWithHash({
        schema_version: 'autopilot.roster.v1',
        roster_id: firstRoster(first.rosters).ref.roster_id,
        roster_revision: 1,
        display_name: 'different bytes same path',
        scope: 'user',
        selected_scope: 'user',
        assignment_set_sha256: ASSIGNMENT_AFTERBURNER,
        roster_sha256: ZERO_SHA,
      });
      const other = makeRoster('user', 'afterburner-codex-subscription-7814ccd19c58', ASSIGNMENT_AFTERBURNER);
      const collidingRef = decodeRosterSync(collidingRoster);
      const config = makeConfig({
        stateRoot,
        scope: 'user',
        rosters: [collidingRef, other.ref],
        defaultRef: collidingRef,
        previous: previousConfig,
      });
      const storage = new RosterStorage({ codec, stateRoot });
      const result = await storage.saveApprovedDefault({
        scope: 'user',
        approved_candidate_set_sha256: CANDIDATE_SET_SHA,
        current_candidate_set_sha256: CANDIDATE_SET_SHA,
        approved_roster_sha256s: [collidingRef.roster_sha256, other.ref.roster_sha256],
        roster_bytes: [collidingRoster, other.bytes],
        config_bytes: config.bytes,
        expected_previous_config_sha256: previousConfig,
        default_roster_id: collidingRef.roster_id,
        default_roster_revision: 1,
        default_roster_sha256: collidingRef.roster_sha256,
        original_command: '/autopilot phase37',
      });
      assert.equal(result.ok, false);
      assert.deepEqual(diagnosticCodes(result), ['ROSTER_CREATE_ONLY_CONFLICT']);
      assert.equal(bytesEqual(await readFile(existingRosterPath), originalBytes), true);
    });
  });

  void it('does not break stale-looking writer locks by age and races one per-scope writer', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'stale-lock-state');
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      await mkdir(paths.authorityRoot, { recursive: true, mode: 0o700 });
      await chmod(paths.authorityRoot, 0o700);
      await writeFile(paths.lockPath, `${JSON.stringify({
        schema_version: 'autopilot.roster_writer_lock.v1',
        pid: 1,
        process_start_time_ms: 1,
        exec_path: process.execPath,
        authority_root: paths.authorityRoot,
        authority_root_dev: '0',
        authority_root_ino: '0',
        token: 'old-token',
        created_at: '1970-01-01T00:00:00.000Z',
      })}\n`);
      await chmod(paths.lockPath, 0o600);
      const stale = await saveTwoRosters({ stateRoot });
      assert.equal(stale.ok, false);
      assert.deepEqual(diagnosticCodes(stale), ['ROSTER_LOCK_STALE_PROCESS_UNPROVEN']);
      assert.equal(stale.write_count, 0);
      assert.equal(stale.lock_count, 0);
      assert.equal(existsSync(paths.lockPath), true);

      const raceRoot = join(dir, 'race-state');
      let releaseFirst!: () => void;
      const firstMayContinue = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstLocked!: () => void;
      const firstHasLock = new Promise<void>((resolve) => {
        firstLocked = resolve;
      });
      const firstPromise = saveTwoRosters({
        stateRoot: raceRoot,
        faults: {
          onStage: async (event) => {
            if (event.stage === 'after-lock') {
              firstLocked();
              await firstMayContinue;
            }
          },
        },
      });
      await firstHasLock;
      const second = await saveTwoRosters({ stateRoot: raceRoot });
      releaseFirst();
      const first = await firstPromise;
      assert.equal(first.ok, true);
      assert.equal(second.ok, false);
      assert.deepEqual(diagnosticCodes(second), ['ROSTER_LOCK_STALE_PROCESS_UNPROVEN']);
      assert.equal(second.write_count, 0);
    });
  });

  void it('rejects invalid path segments before creating pre-run selection paths', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const storage = new RosterStorage({ codec, stateRoot });
      const roster = makeRoster('user', 'cruise-codex-subscription-bdb4f15f0ff9');
      const invalid = makeSelection({ ref: roster.ref, repoId: 'repo-../escape' });
      const result = await storage.publishPreRunSelection({ selection_bytes: invalid.bytes });
      assert.equal(result.ok, false);
      assert.equal(result.write_count, 0);
      assert.equal(result.lock_count, 0);
      assert.equal(existsSync(stateRoot), false);
      assert.ok(diagnosticCodes(result).includes('ROSTER_READBACK_MISMATCH') || diagnosticCodes(result).includes('ROSTER_STORAGE_PATH_INVALID'));
      assert.equal(sha256Bytes(Buffer.from('abc')), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      assert.ok((fsConstants.O_NOFOLLOW ?? 0) !== 0);
    });
  });
});
