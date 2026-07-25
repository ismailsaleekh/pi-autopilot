import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { D65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';

// BUG-180 shared witness for the D65 bootstrap `context_budget` receipt contract.
//
// D65 introduced a PRIVATE strict-identifier regex for the receipt's
// `tool_call_id` while the package already owned one canonical opaque
// tool-call-ID contract (`src/core/tool-call-id.ts`). The private grammar had no
// `|`, so the first mandatory receipt of a real Codex Responses launch rejected a
// legitimate provider-native composite id and fenced the launch.
//
// This module holds the ONE assertion battery for that contract so the
// source-level and COMPILED (dist) D65 writer/reader are proven against exactly
// the same behavioral witness — never a static string/grep assertion.

/**
 * The exact provider-native Codex Responses composite tool-call id observed in
 * the live launch failure (83 Unicode code points, non-empty, NUL-free). It is
 * canonical-valid opaque text and must round-trip byte-for-byte.
 */
export const BUG_180_PROVIDER_TOOL_CALL_ID = 'call_S9OGEFV3FIosvpBEt3LVpVyV|fc_02a58fed1144d632016a64ce4623848191b87bb309587459b0';

/** One astral (non-BMP) code point: 2 UTF-16 units, 1 Unicode code point. */
const ASTRAL = '\u{1D4B3}';

/** Exactly the canonical 200-code-point maximum, measured as code points. */
export const BUG_180_MAX_CODE_POINT_TOOL_CALL_ID = ASTRAL.repeat(200);

/** One code point beyond the canonical maximum. */
export const BUG_180_OVERSIZED_TOOL_CALL_ID = ASTRAL.repeat(201);

/** The exact D65 receipt-writer input shape (structurally shared with dist). */
export interface D65ContextBudgetReceiptReport {
  readonly gate: string;
  readonly percent: number | null;
  readonly tool_call_id: string;
  readonly session_id: string;
}

/**
 * The exact production D65 receipt surface under test. Both the TypeScript
 * source module and the compiled `dist` module satisfy it, so one battery
 * proves source/dist behavioral parity rather than text equality.
 */
export interface D65ContextBudgetReceiptApi {
  writeD65ContextBudgetReceipt(manifest: D65LaunchManifest, report: D65ContextBudgetReceiptReport): void;
  requireD65ContextBudgetReceipt(manifest: D65LaunchManifest, expectedSessionId: string): void;
  d65ContextBudgetReceiptPath(manifest: D65LaunchManifest): string;
}

/** The exact persisted receipt record (closed field set). */
interface PersistedReceipt {
  readonly [key: string]: unknown;
}

function isPersistedReceipt(value: unknown): value is PersistedReceipt {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readReceipt(path: string): PersistedReceipt {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  if (!isPersistedReceipt(parsed)) throw new TypeError('persisted D65 context_budget receipt must be a JSON object');
  return parsed;
}

/**
 * A sealed-manifest builder that needs NO clone, coordinator, or signer: the
 * receipt writer/reader consume only the sealed identity + evidence root, so a
 * parser-valid manifest is the exact production input. Every call returns a
 * distinct run identity and evidence root so create-only receipt semantics are
 * exercised honestly (never by reusing one run's receipt).
 */
export interface D65ContextBudgetReceiptFixture {
  readonly root: string;
  readonly manifest: () => D65LaunchManifest;
  readonly close: () => Promise<void>;
}

type ManifestParser = (value: unknown) => D65LaunchManifest;

export async function buildD65ContextBudgetReceiptFixture(
  suffix: string,
  parseD65LaunchManifest: ManifestParser,
): Promise<D65ContextBudgetReceiptFixture> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), `d65-budget-${suffix}-`)));
  let ordinal = 0;
  const manifest = (): D65LaunchManifest => {
    ordinal += 1;
    return parseD65LaunchManifest(manifestDocument(root, `${suffix}${String(ordinal)}`.toLowerCase()));
  };
  return { root, manifest, close: async () => { await rm(root, { recursive: true, force: true }); } };
}

function hex(seed: string, filler: string): string {
  const base = seed.replace(/[^a-f0-9]/gu, '');
  return `${base}${filler.repeat(40)}`.slice(0, 40);
}

function manifestDocument(root: string, suffix: string): Readonly<Record<string, unknown>> {
  const clone = join(root, `clone-${suffix}`);
  const stateRoot = join(root, `state-${suffix}`);
  const sessionRoot = join(root, `sessions-${suffix}`);
  const repoId = `repo-${suffix}`;
  const workstreamRun = `run-${suffix}`;
  const workstream = `wk${suffix}`;
  const worktreeRoot = join(stateRoot, 'worktrees', repoId);
  const mainWorktreePath = join(worktreeRoot, 'active', workstreamRun, 'main');
  const runtimeRoot = join(mainWorktreePath, '.pi', 'autopilot', workstream);
  // The program evidence root is real, private (0700), and authority-distinct
  // from every clone/state/session/worktree root — exactly the production shape.
  const programEvidenceRoot = join(root, `evidence-${suffix}`);
  mkdirSync(programEvidenceRoot, { recursive: true, mode: 0o700 });
  chmodSync(programEvidenceRoot, 0o700);
  const b0Commit = hex(suffix, '1');
  const contentCommit = hex(suffix, '2');
  const overlayCommit = hex(suffix, '3');
  const digest = (filler: string): string => `sha256:${filler.repeat(64).slice(0, 64)}`;
  const prospectiveRun = { schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: `ap-${suffix}`, workstream, workstream_run: workstreamRun, coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1 };
  const prospectiveResource = { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun, source_repo: clone, git_common_dir: join(clone, '.git'), worktree_root: worktreeRoot, main_worktree_path: mainWorktreePath, runtime_root: runtimeRoot, branch: `autopilot/${workstreamRun}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null, started_at: '2026-07-25T12:58:45.000Z', version: 1 };
  return {
    schema_version: 'autopilot.launch_manifest.v1', manifest_id: `launch-${suffix}`, program_id: `program-${suffix}`, workstream, workstream_run: workstreamRun, autopilot_id: `ap-${suffix}`,
    run_timestamp: '2026-07-25T12:58:45.000Z', run_nonce: 'a1b2c3', source_clone: clone, canonical_root: clone, git_common_dir: join(clone, '.git'), repo_id: repoId, repo_key: repoId,
    b0_commit: b0Commit, b0_tree: hex(suffix, '4'), content_result_commit: contentCommit, content_result_tree: hex(suffix, '5'), package_commit: hex(suffix, '6'), package_tree: hex(suffix, '7'),
    run_branch: `autopilot/${workstreamRun}`, target_branch: 'main', state_root: stateRoot, session_root: sessionRoot, worktree_root: worktreeRoot, main_worktree_path: mainWorktreePath, runtime_root: runtimeRoot,
    bootstrap_overlay: { overlay_commit: overlayCommit, overlay_tree: hex(suffix, '8'), overlay_ref: `refs/heads/autopilot/bootstrap/${workstreamRun}`, bootstrap_ref: `.pi/autopilot-bootstrap/${workstreamRun}/bootstrap.json`, bootstrap_sha256: digest('a'), bootstrap_byte_count: 512 },
    trust_anchor: { trust_anchor_ref: `.pi/autopilot-trust/d65/program-${suffix}/operator-ed25519.spki`, trust_anchor_sha256: digest('b'), trust_anchor_blob_oid: hex(suffix, '9'), byte_count: 44 },
    prospective_run: prospectiveRun, prospective_resource: prospectiveResource, coordination_authority: 'coordinator-edit-leases-v1',
    roster_authority: 'user-default', roster_selection_ref: `roster-selections/${repoId}/${workstreamRun}.json`, roster_sha256: digest('c'),
    roster_selection: { roster_ref: join(root, `roster-${suffix}.json`), roster_bytes_sha256: digest('d'), selection_ref: join(root, `selection-${suffix}.json`), selection_bytes_sha256: digest('e'), selection_sha256: digest('f'), provider: 'openai-codex' },
    parent_model: 'openai-codex/gpt-5.6-sol', parent_thinking: 'xhigh',
    policy_candidate: { policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', policy_sha256: digest('0'), registration_idempotency_key: `register-launch-policy:${workstreamRun}:policy-1` },
    program_evidence_root: programEvidenceRoot,
    launch_seal: { launch_commit: overlayCommit, launch_tree: hex(suffix, '8'), launch_audit_ref: join(root, `audit-${suffix}.json`), launch_audit_sha256: digest('1'), launch_seal_ref: join(root, `seal-${suffix}.json`), launch_seal_sha256: digest('2'), bootstrap_projection_ref: join(root, `projection-${suffix}.json`), bootstrap_projection_sha256: digest('3') },
    attach_run_idempotency_key: `attach-run:${repoId}:${workstreamRun}`, attach_session_idempotency_key: `attach-session:${repoId}:${workstreamRun}`,
    created_at: '2026-07-25T12:58:46.000Z',
  };
}

/**
 * BUG-180: the ONE behavioral battery proving the D65 receipt writer/reader
 * consume the package's canonical OPAQUE tool-call-ID contract — provider-native
 * composite ids are accepted and preserved byte-for-byte, while every security
 * property of the receipt fence is retained.
 */
export function assertD65ContextBudgetOpaqueToolCallContract(
  api: D65ContextBudgetReceiptApi,
  fixture: D65ContextBudgetReceiptFixture,
): void {
  const sessionId = 'session-7f3c1d0a5b9e4c2d8a6f0b3e1c7d9a54';

  // 1. The exact live provider-native composite id writes successfully and the
  //    persisted receipt retains it byte-for-byte (no split/normalize/truncate).
  const live = fixture.manifest();
  assert.equal(Array.from(BUG_180_PROVIDER_TOOL_CALL_ID).length, 83, 'BUG-180 live provider id must be 83 Unicode code points');
  api.writeD65ContextBudgetReceipt(live, { gate: 'ok', percent: 10, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId });
  const livePath = api.d65ContextBudgetReceiptPath(live);
  assert.equal(existsSync(livePath), true, 'BUG-180 receipt must exist for a real Codex composite tool-call id');
  assert.equal(readReceipt(livePath)['tool_call_id'], BUG_180_PROVIDER_TOOL_CALL_ID, 'BUG-180 receipt must retain the exact unchanged provider tool-call id');
  api.requireD65ContextBudgetReceipt(live, sessionId);

  // 2. Exactly 200 astral code points pass; 201 fail. The bound is measured in
  //    Unicode code points, never UTF-16 units.
  const maximum = fixture.manifest();
  api.writeD65ContextBudgetReceipt(maximum, { gate: 'ok', percent: 0, tool_call_id: BUG_180_MAX_CODE_POINT_TOOL_CALL_ID, session_id: sessionId });
  assert.equal(readReceipt(api.d65ContextBudgetReceiptPath(maximum))['tool_call_id'], BUG_180_MAX_CODE_POINT_TOOL_CALL_ID);
  api.requireD65ContextBudgetReceipt(maximum, sessionId);
  assert.equal(BUG_180_MAX_CODE_POINT_TOOL_CALL_ID.length, 400, 'the 200-code-point value must exceed 200 UTF-16 units');

  const oversized = fixture.manifest();
  assert.throws(() => api.writeD65ContextBudgetReceipt(oversized, { gate: 'ok', percent: 0, tool_call_id: BUG_180_OVERSIZED_TOOL_CALL_ID, session_id: sessionId }), /bounded opaque tool-call ID/u);
  assert.equal(existsSync(api.d65ContextBudgetReceiptPath(oversized)), false, 'a rejected tool-call id must never seal a receipt');

  // 3. Empty and NUL-bearing ids remain fenced.
  const empty = fixture.manifest();
  assert.throws(() => api.writeD65ContextBudgetReceipt(empty, { gate: 'ok', percent: 0, tool_call_id: '', session_id: sessionId }), /bounded opaque tool-call ID/u);
  assert.equal(existsSync(api.d65ContextBudgetReceiptPath(empty)), false);

  const nul = fixture.manifest();
  assert.throws(() => api.writeD65ContextBudgetReceipt(nul, { gate: 'ok', percent: 0, tool_call_id: `call_${'\u0000'}fc`, session_id: sessionId }), /bounded opaque tool-call ID/u);
  assert.equal(existsSync(api.d65ContextBudgetReceiptPath(nul)), false);

  // 4. Arbitrary opaque pipe shapes round-trip exactly (no provider parsing).
  for (const opaque of ['|leading', 'trailing|', 'double||pipe', '|', 'call_0123|fc_4567|suffix']) {
    const pipes = fixture.manifest();
    api.writeD65ContextBudgetReceipt(pipes, { gate: 'ok', percent: 99.5, tool_call_id: opaque, session_id: sessionId });
    assert.equal(readReceipt(api.d65ContextBudgetReceiptPath(pipes))['tool_call_id'], opaque, 'opaque tool-call ids must never be reinterpreted by separator');
    api.requireD65ContextBudgetReceipt(pipes, sessionId);
  }

  // 5. Every other receipt security property is retained.
  const fenced = fixture.manifest();
  assert.throws(() => api.requireD65ContextBudgetReceipt(fenced, sessionId), /did not produce a durable context_budget call receipt/u);
  assert.throws(() => api.writeD65ContextBudgetReceipt(fenced, { gate: 'halt', percent: 90, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId }), /gate is not ok/u);
  assert.throws(() => api.writeD65ContextBudgetReceipt(fenced, { gate: 'unknown', percent: null, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId }), /gate is not ok/u);
  assert.throws(() => api.writeD65ContextBudgetReceipt(fenced, { gate: 'ok', percent: null, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId }), /percent must be a finite number/u);
  assert.throws(() => api.writeD65ContextBudgetReceipt(fenced, { gate: 'ok', percent: 100.1, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId }), /percent must be a finite number/u);
  assert.throws(() => api.writeD65ContextBudgetReceipt(fenced, { gate: 'ok', percent: Number.NaN, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId }), /percent must be a finite number/u);
  assert.throws(() => api.writeD65ContextBudgetReceipt(fenced, { gate: 'ok', percent: 10, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: 'session with spaces' }), /bounded coordinator session identity/u);
  assert.equal(existsSync(api.d65ContextBudgetReceiptPath(fenced)), false, 'no rejected report may seal a receipt');

  // A sealed receipt is create-only and session-bound.
  api.writeD65ContextBudgetReceipt(fenced, { gate: 'ok', percent: 10, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId });
  api.writeD65ContextBudgetReceipt(fenced, { gate: 'ok', percent: 42, tool_call_id: 'call_second|fc_second', session_id: sessionId });
  assert.equal(readReceipt(api.d65ContextBudgetReceiptPath(fenced))['tool_call_id'], BUG_180_PROVIDER_TOOL_CALL_ID, 'the create-only receipt must never be replaced by a later call');
  assert.throws(() => api.requireD65ContextBudgetReceipt(fenced, 'session-0000000000000000000000000000ffff'), /another run\/session/u);

  // 6. Malformed / cross-run / extra-field persisted receipts remain fenced,
  //    including one whose tool_call_id violates the canonical opaque contract.
  const tampered = fixture.manifest();
  const tamperedPath = api.d65ContextBudgetReceiptPath(tampered);
  mkdirSync(dirname(tamperedPath), { recursive: true, mode: 0o700 });
  const base = { schema_version: 'autopilot.d65_context_budget_receipt.v1', program_id: tampered.program_id, workstream_run: tampered.workstream_run, gate: 'ok', percent: 10, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId };
  for (const mutation of [
    { ...base, extra: true },
    { ...base, workstream_run: 'foreign-run' },
    { ...base, program_id: 'foreign-program' },
    { ...base, gate: 'halt' },
    { ...base, percent: 101 },
    { ...base, tool_call_id: '' },
    { ...base, tool_call_id: BUG_180_OVERSIZED_TOOL_CALL_ID },
    { ...base, tool_call_id: 42 },
  ]) {
    writeFileSync(tamperedPath, `${JSON.stringify(mutation)}\n`, { mode: 0o600 });
    assert.throws(() => api.requireD65ContextBudgetReceipt(tampered, sessionId), /another run\/session/u, `tampered receipt must stay fenced: ${JSON.stringify(mutation['tool_call_id'])}`);
  }
  // The exact untampered record is still accepted (the battery proves rejection
  // came from the mutation, never from an unrelated fixture defect).
  writeFileSync(tamperedPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  api.requireD65ContextBudgetReceipt(tampered, sessionId);
}
