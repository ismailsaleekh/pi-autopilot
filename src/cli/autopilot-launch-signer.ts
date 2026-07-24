#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sign, createPrivateKey } from 'node:crypto';

import { canonicalJson } from '../core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../core/coordination/client.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationSessionLease } from '../core/coordination/contracts.ts';
import { CoordinationRuntimeError } from '../core/coordination/failures.ts';
import { parseD65LaunchPolicy } from '../core/coordination/d65-launch-policy.ts';
import { encodeUnpaddedBase64Url } from '../core/coordination/d65-trust.ts';
import { runGitQuery } from '../core/git-process.ts';
import { ensurePrivateDirectory, publishCreateOnlyAtomic } from '../core/roster/transaction.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../core/parallel-runtime.ts';

// The external operator launch signer (freeze §9.3; fresh plan §2.2/§3.2).
//
// This is the ONLY component that possesses the operator's private PKCS#8 key.
// It is a distinct executable — never a runtime module and never a test helper —
// and it never invokes a model or paid API. It reads the LIVE coordinator
// status/doctor/policy identity for a run, builds the canonical unsigned launch
// policy / program heartbeat bytes, signs them with the operator key, and writes
// the signed candidate to the exact evidence/worktree path the runtime consumes.
// The runtime never sees the key or unsigned bytes.
//
// Key/config isolation: the key path and the sealed program facts are supplied
// through a mode-0600 signer config file named on argv (`--config`). The runtime
// passes only the signing request; it never learns the key path.

interface SignerConfig {
  readonly schema_version: 'autopilot.launch_signer_config.v1';
  readonly program_id: string;
  readonly repo_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly private_key_path: string;
  /** The isolated coordinator state root the operator key must live outside of. */
  readonly state_root: string;
  /** The isolated Pi session root the operator key must live outside of. */
  readonly session_root: string;
  readonly trust_anchor_ref: string;
  readonly trust_anchor_sha256: `sha256:${string}`;
  readonly signer_key_id: `sha256:${string}`;
  readonly program_evidence_root: string;
  readonly policy_id: string;
  readonly policy_ref: string;
  readonly package_commit: string;
  readonly package_tree: string;
  readonly b0_commit: string;
  readonly b0_tree: string;
  readonly roster_sha256: `sha256:${string}`;
  readonly roster_provider: string;
  /** The exact sealed policy issue timestamp (the policy has no validity window). */
  readonly policy_issued_at: string;
  /**
   * The complete set of declared program rows (identity-sorted by workstream).
   * The signer emits one heartbeat row per declared program row. THIS run's row
   * is bound to live coordinator authority. Each OTHER row carries its own
   * isolated coordinator `state_root`: when that coordinator has a launched run,
   * the signer reads THAT row's own live status/doctor/session/policy/graph
   * authority (so launching a later row can never regress an earlier launched
   * row to planned); when the row is unlaunched (null state root or absent run),
   * it is emitted as `planned`/`row-not-launched`. Cap-one with only this
   * workstream is a one-row set; the full program declares all six.
   */
  readonly program_rows: readonly D65SignerProgramRow[];
}

interface D65SignerProgramRow {
  readonly workstream: string;
  readonly workstream_run: string;
  /** The row's own isolated coordinator state root (null for a not-yet-sealed row). */
  readonly state_root: string | null;
  /** The row's own coordinator repo id (null for a not-yet-sealed row). */
  readonly repo_id: string | null;
}

const CONFIG_FIELDS = [
  'schema_version', 'program_id', 'repo_id', 'workstream', 'workstream_run', 'private_key_path',
  'state_root', 'session_root',
  'trust_anchor_ref', 'trust_anchor_sha256', 'signer_key_id', 'program_evidence_root', 'policy_id',
  'policy_ref', 'package_commit', 'package_tree', 'b0_commit', 'b0_tree', 'roster_sha256', 'roster_provider',
  'policy_issued_at', 'program_rows',
] as const;

function fail(message: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-request', `launch-signer: ${message}`, [...detail]);
}

function bytesSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function readMode0600(path: string, label: string): Uint8Array {
  if (!isAbsolute(path)) fail(`${label} path must be absolute`, [path]);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > 1_048_576) fail(`${label} must be a one-link no-follow regular mode-0600 file <=1 MiB`, [path]);
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail(`${label} descriptor identity changed while opening`, [path]);
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function requireObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function requireString(record: Readonly<Record<string, unknown>>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) fail(`${label}.${field} must be a bounded string`);
  return value;
}

function requireSha256(record: Readonly<Record<string, unknown>>, field: string, label: string): `sha256:${string}` {
  const value = requireString(record, field, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) fail(`${label}.${field} must be sha256:<64 lowercase hex>`);
  return value as `sha256:${string}`;
}

function requireInteger(record: Readonly<Record<string, unknown>>, field: string, label: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${label}.${field} must be a positive safe integer`);
  return value;
}

function parseConfig(bytes: Uint8Array): SignerConfig {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch (error) { fail('config is not UTF-8 JSON', [error instanceof Error ? error.message : String(error)]); }
  const record = requireObject(value, 'config');
  const keys = Object.keys(record).sort();
  const expected = [...CONFIG_FIELDS].sort();
  if (keys.length !== expected.length || expected.some((field, index) => keys[index] !== field)) fail('config has unexpected/missing fields', keys);
  if (record['schema_version'] !== 'autopilot.launch_signer_config.v1') fail('config schema is wrong');
  return Object.freeze({
    schema_version: 'autopilot.launch_signer_config.v1',
    program_id: requireString(record, 'program_id', 'config'),
    repo_id: requireString(record, 'repo_id', 'config'),
    workstream: requireString(record, 'workstream', 'config'),
    workstream_run: requireString(record, 'workstream_run', 'config'),
    private_key_path: requireString(record, 'private_key_path', 'config'),
    state_root: requireString(record, 'state_root', 'config'),
    session_root: requireString(record, 'session_root', 'config'),
    trust_anchor_ref: requireString(record, 'trust_anchor_ref', 'config'),
    trust_anchor_sha256: requireSha256(record, 'trust_anchor_sha256', 'config'),
    signer_key_id: requireSha256(record, 'signer_key_id', 'config'),
    program_evidence_root: requireString(record, 'program_evidence_root', 'config'),
    policy_id: requireString(record, 'policy_id', 'config'),
    policy_ref: requireString(record, 'policy_ref', 'config'),
    package_commit: requireString(record, 'package_commit', 'config'),
    package_tree: requireString(record, 'package_tree', 'config'),
    b0_commit: requireString(record, 'b0_commit', 'config'),
    b0_tree: requireString(record, 'b0_tree', 'config'),
    roster_sha256: requireSha256(record, 'roster_sha256', 'config'),
    roster_provider: requireString(record, 'roster_provider', 'config'),
    policy_issued_at: requireString(record, 'policy_issued_at', 'config'),
    program_rows: parseProgramRows(record['program_rows']),
  });
}

function parseProgramRows(value: unknown): readonly D65SignerProgramRow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail('config.program_rows must be a non-empty bounded array');
  const rows = value.map((entry, index) => {
    const record = requireObject(entry, `config.program_rows[${String(index)}]`);
    const keys = Object.keys(record).sort();
    if (keys.length !== 4 || keys[0] !== 'repo_id' || keys[1] !== 'state_root' || keys[2] !== 'workstream' || keys[3] !== 'workstream_run') fail(`config.program_rows[${String(index)}] must have exactly workstream, workstream_run, state_root, and repo_id`);
    const stateRootRaw = record['state_root'];
    const stateRoot = stateRootRaw === null ? null : requireString(record, 'state_root', `config.program_rows[${String(index)}]`);
    if (stateRoot !== null && !isAbsolute(stateRoot)) fail(`config.program_rows[${String(index)}].state_root must be an absolute path or null`);
    const repoIdRaw = record['repo_id'];
    const repoId = repoIdRaw === null ? null : requireString(record, 'repo_id', `config.program_rows[${String(index)}]`);
    if ((stateRoot === null) !== (repoId === null)) fail(`config.program_rows[${String(index)}] state_root and repo_id must be both null or both present`);
    return Object.freeze({ workstream: requireString(record, 'workstream', 'config.program_rows'), workstream_run: requireString(record, 'workstream_run', 'config.program_rows'), state_root: stateRoot, repo_id: repoId });
  });
  const sorted = [...rows].sort((left, right) => (left.workstream < right.workstream ? -1 : left.workstream > right.workstream ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) if ((sorted[index - 1]?.workstream ?? '') === (sorted[index]?.workstream ?? '')) fail('config.program_rows workstream identities must be unique');
  return Object.freeze(sorted);
}

interface PolicyRequest { readonly kind: 'launch-policy'; readonly state_root: string; readonly repo_id: string; readonly workstream_run: string; readonly policy_id: string; readonly policy_ref: string; readonly expected_policy_sha256: `sha256:${string}` }
interface HeartbeatRequest { readonly kind: 'program-heartbeat'; readonly state_root: string; readonly repo_id: string; readonly workstream_run: string; readonly graph_sequence: number; readonly graph_sha256: `sha256:${string}`; readonly heartbeat_sequence: number }
type SignerRequest = PolicyRequest | HeartbeatRequest;

const POLICY_REQUEST_FIELDS = ['kind', 'state_root', 'repo_id', 'workstream_run', 'policy_id', 'policy_ref', 'expected_policy_sha256'] as const;
const HEARTBEAT_REQUEST_FIELDS = ['kind', 'state_root', 'repo_id', 'workstream_run', 'graph_sequence', 'graph_sha256', 'heartbeat_sequence'] as const;

/** Enforce an exact closed field set (no unknown/missing request fields). */
function requireExactFields(record: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || expected.some((field, index) => actual[index] !== field)) fail(`${label} has unexpected/missing fields`, actual);
}

function parseRequest(raw: string): SignerRequest {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch (error) { fail('request is not JSON', [error instanceof Error ? error.message : String(error)]); }
  const record = requireObject(value, 'request');
  if (record['kind'] === 'launch-policy') {
    requireExactFields(record, POLICY_REQUEST_FIELDS, 'launch-policy request');
    return Object.freeze({
      kind: 'launch-policy', state_root: requireString(record, 'state_root', 'request'), repo_id: requireString(record, 'repo_id', 'request'),
      workstream_run: requireString(record, 'workstream_run', 'request'), policy_id: requireString(record, 'policy_id', 'request'),
      policy_ref: requireString(record, 'policy_ref', 'request'), expected_policy_sha256: requireSha256(record, 'expected_policy_sha256', 'request'),
    });
  }
  if (record['kind'] === 'program-heartbeat') {
    requireExactFields(record, HEARTBEAT_REQUEST_FIELDS, 'program-heartbeat request');
    return Object.freeze({
      kind: 'program-heartbeat', state_root: requireString(record, 'state_root', 'request'), repo_id: requireString(record, 'repo_id', 'request'),
      workstream_run: requireString(record, 'workstream_run', 'request'), graph_sequence: requireInteger(record, 'graph_sequence', 'request'),
      graph_sha256: requireSha256(record, 'graph_sha256', 'request'), heartbeat_sequence: requireInteger(record, 'heartbeat_sequence', 'request'),
    });
  }
  return fail('request kind must be launch-policy or program-heartbeat');
}

function gitBlob(repoRoot: string, commit: string, ref: string): Uint8Array {
  return runGitQuery({ cwd: repoRoot, descriptor: { kind: 'show-file', revision: commit, path: ref } }).stdout;
}

/**
 * Read the operator private key, proving its realpath is OUTSIDE every protected
 * root (source clone, Git common dir, state root, session root, worktree/runtime
 * roots, and the program evidence root). The external-key boundary is meaningless
 * if the key can live inside runtime-controlled or packaged authority.
 */
/** The complete set of protected roots the operator key must live outside of. */
function protectedRootsFromResource(config: SignerConfig, resource: ReturnType<typeof parseCoordinationRunResource>): readonly string[] {
  return [resource.source_repo, resource.git_common_dir, resource.worktree_root, resource.main_worktree_path, resource.runtime_root, config.program_evidence_root, config.state_root, config.session_root];
}

/**
 * Prove the operator private key's canonical realpath is OUTSIDE every protected
 * root. Exported for direct regression coverage of the external-key boundary
 * (audit item F): a key inside any clone/state/session/worktree/runtime/evidence
 * root rejects loudly.
 */
export function assertPrivateKeyOutsideProtectedRoots(privateKeyPath: string, protectedRoots: readonly string[]): void {
  const keyReal = realpathSync(privateKeyPath);
  for (const root of protectedRoots) {
    let rootReal: string;
    try { rootReal = realpathSync(root); }
    catch { continue; }
    const withSep = rootReal.endsWith('/') ? rootReal : `${rootReal}/`;
    if (keyReal === rootReal || keyReal.startsWith(withSep)) fail('operator private key must live outside every clone/state/session/worktree/runtime/evidence root', [keyReal, rootReal]);
  }
}

function readOperatorPrivateKey(config: SignerConfig, protectedRoots: readonly string[]): string {
  assertPrivateKeyOutsideProtectedRoots(config.private_key_path, protectedRoots);
  return new TextDecoder('utf-8').decode(readMode0600(config.private_key_path, 'operator private key'));
}

function requireOne<T>(values: readonly T[], label: string): T {
  if (values.length !== 1 || values[0] === undefined) fail(`${label} cardinality is not exactly one`, [`count=${String(values.length)}`]);
  return values[0];
}

/**
 * Publish a signed candidate through a canonical-root-contained, no-alias,
 * temp+fsync+link/rename create-only atomic protocol (audit item F). If the
 * exact bytes already exist, only byte-identical content is accepted; a
 * conflicting/partial-residue/symlinked/hardlinked/wrong-mode candidate rejects
 * loudly. Reuses the proven Phase 37 atomic publication primitive rather than a
 * weaker copy.
 */
async function persistSignedCandidate(absolutePath: string, bytes: Uint8Array, authorityRoot: string): Promise<void> {
  await ensurePrivateDirectory(dirname(absolutePath), authorityRoot);
  const result = await publishCreateOnlyAtomic({ path: absolutePath, authorityRoot, bytes });
  if (result.status === 'conflict') fail('signed candidate publication found conflicting existing bytes at the sealed sequence path', [absolutePath]);
}

/** Build and sign the launch policy from live coordinator + config authority. */
async function signPolicy(config: SignerConfig, request: PolicyRequest, env: ProcessEnvLike): Promise<{ ref: string; absolutePath: string; bytes: Uint8Array }> {
  const client = new CoordinatorClient({ env: { ...env, [AUTOPILOT_STATE_ROOT_ENV]: request.state_root } });
  const status = await client.query('status', request.repo_id, request.workstream_run);
  const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
  const bootstrap = requireOne(artifacts.filter((a) => a.artifact_id === `semantic-graph-bootstrap:${request.workstream_run}` && a.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1'), 'bootstrap artifact');
  const resources = (status.payload['run_resources'] as unknown[]).map(parseCoordinationRunResource);
  const resource = requireOne(resources, 'run resource');
  const fields = {
    schema_version: 'autopilot.launch_policy.v1', program_id: config.program_id, policy_id: request.policy_id, policy_version: 1,
    repo_id: request.repo_id, workstream_run: request.workstream_run, package_commit: config.package_commit, package_tree: config.package_tree,
    base_commit: config.b0_commit, base_tree: config.b0_tree, bootstrap_graph_sha256: bootstrap.evidence.sha256, bootstrap_receipt_event_seq: bootstrap.registered_event_seq,
    roster_sha256: config.roster_sha256, parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1,
    program_evidence_root: config.program_evidence_root, trust_anchor_ref: config.trust_anchor_ref, trust_anchor_sha256: config.trust_anchor_sha256,
    prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: config.policy_issued_at, signer_key_id: config.signer_key_id,
  };
  const privateKeyPem = readOperatorPrivateKey(config, protectedRootsFromResource(config, resource));
  const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-LAUNCH-POLICY\u0000', canonicalJson(fields)), createPrivateKey(privateKeyPem))));
  const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
  // Parse-validate our own output before writing (fail closed).
  parseD65LaunchPolicy(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  if (bytesSha256(bytes) !== request.expected_policy_sha256) fail('signed policy digest differs from the sealed expected policy digest', [bytesSha256(bytes), request.expected_policy_sha256]);
  const absolutePath = join(config.program_evidence_root, 'signed-launch-policies', `${request.policy_id}.json`);
  await persistSignedCandidate(absolutePath, bytes, realpathSync(config.program_evidence_root));
  return { ref: request.policy_ref, absolutePath, bytes };
}

/** Build and sign the program heartbeat from live coordinator + config authority. */
async function signHeartbeat(config: SignerConfig, request: HeartbeatRequest, env: ProcessEnvLike): Promise<{ ref: string; absolutePath: string; bytes: Uint8Array }> {
  const client = new CoordinatorClient({ env: { ...env, [AUTOPILOT_STATE_ROOT_ENV]: request.state_root } });
  const status = await client.query('status', request.repo_id, request.workstream_run);
  const doctor = await client.query('doctor', request.repo_id, request.workstream_run);
  const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
  const policyArtifact = requireOne(artifacts.filter((a) => a.document_schema_version === 'autopilot.launch_policy.v1'), 'accepted launch policy artifact');
  const resources = (status.payload['run_resources'] as unknown[]).map(parseCoordinationRunResource);
  const resource = requireOne(resources, 'run resource');
  const policy = parseD65LaunchPolicy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(gitBlob(resource.main_worktree_path, policyArtifact.git_commit, policyArtifact.evidence.ref))) as unknown);
  const sessions = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease);
  const run = requireOne((status.payload['runs'] as unknown[]).map(parseCoordinationRun), 'run');
  const attached = requireOne(sessions.filter((s) => (s.status === 'attached' || s.status === 'handoff-pending') && s.attachment_kind === 'dispatch' && s.session_generation === run.active_session_generation), 'attached dispatch session');
  const head = status.payload['accepted_program_heartbeat'];
  const priorSha = head === null ? null : (head as Record<string, unknown>)['heartbeat_sha256'] as `sha256:${string}`;
  const priorSeq = head === null ? 0 : Number((head as Record<string, unknown>)['sequence']);
  if (request.heartbeat_sequence !== priorSeq + 1) fail('requested heartbeat sequence is not the exact next chain sequence', [String(request.heartbeat_sequence), String(priorSeq + 1)]);
  const issued = new Date(); issued.setMilliseconds(Math.max(0, issued.getMilliseconds() - 50));
  const dispatchRow = request.graph_sequence >= 2;
  const fields = {
    schema_version: 'autopilot.program_heartbeat.v1', program_id: config.program_id, sequence: request.heartbeat_sequence, prior_sha256: priorSha,
    issued_at: issued.toISOString(), valid_until: new Date(issued.getTime() + 15 * 60 * 1000).toISOString(),
    package_commit: config.package_commit, package_tree: config.package_tree, base_commit: config.b0_commit, base_tree: config.b0_tree,
    rows: await heartbeatRows(config, request, attached, policyArtifact, status, doctor, dispatchRow, env),
    provider_health: [{ provider: config.roster_provider, state: 'healthy', observation_ref: policyArtifact.evidence.ref, observation_sha256: policyArtifact.evidence.sha256, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
    dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: config.trust_anchor_ref, trust_anchor_sha256: config.trust_anchor_sha256, signer_key_id: config.signer_key_id,
  };
  const privateKeyPem = readOperatorPrivateKey(config, protectedRootsFromResource(config, resource));
  const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-PROGRAM-HEARTBEAT\u0000', canonicalJson(fields)), createPrivateKey(privateKeyPem))));
  const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
  const ref = `program-heartbeats/${String(request.heartbeat_sequence).padStart(20, '0')}.json`;
  const absolutePath = join(config.program_evidence_root, ref);
  await persistSignedCandidate(absolutePath, bytes, realpathSync(config.program_evidence_root));
  return { ref, absolutePath, bytes };
}

async function heartbeatRows(config: SignerConfig, request: HeartbeatRequest, attached: ReturnType<typeof parseCoordinationSessionLease>, policyArtifact: ReturnType<typeof parseCoordinationAuthoritativeArtifact>, status: { payload: Record<string, unknown> }, doctor: { payload: Record<string, unknown> }, dispatchRow: boolean, env: ProcessEnvLike): Promise<readonly Record<string, unknown>[]> {
  const thisRowStopReasons = dispatchRow ? [] : ['graph-publication-pending'];
  // Emit one identity-sorted row per declared program row (§3.2). THIS run's row
  // is bound to live coordinator authority. Every OTHER declared row is read from
  // its own live coordinator authority when launched (never regressed to
  // planned), or emitted as planned/unlaunched when its coordinator has no run.
  const rows: Record<string, unknown>[] = [];
  for (const row of config.program_rows) {
    if (row.workstream === config.workstream) {
      rows.push({
        workstream: row.workstream, workstream_run: row.workstream_run, parent_session_file_sha256: null,
        coordinator_session_lease_id: attached.session_lease_id, accepted_graph_sequence: request.graph_sequence, accepted_graph_sha256: request.graph_sha256,
        status_sha256: status.payload['semantic_snapshot_sha256'], doctor_sha256: doctor.payload['semantic_snapshot_sha256'], session_lease_state: 'attached',
        child_lease_ids: [], launch_policy_sha256: policyArtifact.evidence.sha256, last_progress_event_seq: attached.attached_event_seq,
        last_handoff_sha256: null, row_state: 'active', dispatch_allowed: thisRowStopReasons.length === 0, stop_reasons: thisRowStopReasons,
      });
      continue;
    }
    rows.push(await foreignRowFromLiveAuthority(row, env));
  }
  return rows;
}

/**
 * Read an already-launched foreign program row's own live status/doctor/session/
 * policy/graph authority from ITS isolated coordinator, or emit a planned/
 * unlaunched row when its coordinator has no launched run. A launched foreign
 * row is never regressed to planned merely because a different row is signing.
 */
async function foreignRowFromLiveAuthority(row: D65SignerProgramRow, env: ProcessEnvLike): Promise<Record<string, unknown>> {
  const plannedRow: Record<string, unknown> = {
    workstream: row.workstream, workstream_run: row.workstream_run, parent_session_file_sha256: null,
    coordinator_session_lease_id: null, accepted_graph_sequence: null, accepted_graph_sha256: null,
    status_sha256: null, doctor_sha256: null, session_lease_state: null,
    child_lease_ids: [], launch_policy_sha256: null, last_progress_event_seq: null,
    last_handoff_sha256: null, row_state: 'planned', dispatch_allowed: false, stop_reasons: ['row-not-launched'],
  };
  if (row.state_root === null || row.repo_id === null) return plannedRow;
  const client = new CoordinatorClient({ env: { ...env, [AUTOPILOT_STATE_ROOT_ENV]: row.state_root } });
  let status: { payload: Record<string, unknown> };
  try {
    status = await client.query('status', row.repo_id, row.workstream_run);
  } catch {
    // The foreign coordinator is unreachable or has no run for this identity:
    // the row is not launched from this authority's perspective.
    return plannedRow;
  }
  const runs = (status.payload['runs'] as unknown[] | undefined) ?? [];
  if (!Array.isArray(runs) || runs.length !== 1) return plannedRow;
  const artifacts = (status.payload['authoritative_artifacts'] as unknown[] | undefined) ?? [];
  const parsedArtifacts = Array.isArray(artifacts) ? artifacts.map(parseCoordinationAuthoritativeArtifact) : [];
  const foreignPolicy = parsedArtifacts.find((a) => a.document_schema_version === 'autopilot.launch_policy.v1');
  const foreignGraphs = parsedArtifacts.filter((a) => a.document_schema_version === 'autopilot.semantic_graph.v1');
  if (foreignPolicy === undefined || foreignGraphs.length === 0) return plannedRow;
  const run = parseCoordinationRun(runs[0]);
  const sessions = ((status.payload['session_leases'] as unknown[] | undefined) ?? []).map(parseCoordinationSessionLease);
  const attached = sessions.find((s) => (s.status === 'attached' || s.status === 'handoff-pending') && s.attachment_kind === 'dispatch' && s.session_generation === run.active_session_generation);
  const doctor = await client.query('doctor', row.repo_id, row.workstream_run);
  const head = status.payload['accepted_program_heartbeat'];
  const acceptedGraphSequence = head === null || typeof head !== 'object' ? foreignGraphs.length + 1 : Number((head as Record<string, unknown>)['sequence']);
  const highestGraph = foreignGraphs.reduce((max, g) => (g.registered_event_seq > max.registered_event_seq ? g : max), foreignGraphs[0]!);
  return {
    workstream: row.workstream, workstream_run: row.workstream_run, parent_session_file_sha256: null,
    coordinator_session_lease_id: attached?.session_lease_id ?? null, accepted_graph_sequence: acceptedGraphSequence, accepted_graph_sha256: highestGraph.evidence.sha256,
    status_sha256: status.payload['semantic_snapshot_sha256'] ?? null, doctor_sha256: doctor.payload['semantic_snapshot_sha256'] ?? null, session_lease_state: attached === undefined ? null : 'attached',
    child_lease_ids: [], launch_policy_sha256: foreignPolicy.evidence.sha256, last_progress_event_seq: attached?.attached_event_seq ?? null,
    last_handoff_sha256: null, row_state: 'active', dispatch_allowed: true, stop_reasons: [],
  };
}

function concatDomain(domain: string, message: string): Uint8Array {
  const domainBytes = new TextEncoder().encode(domain);
  const messageBytes = new TextEncoder().encode(message);
  const out = new Uint8Array(domainBytes.length + messageBytes.length);
  out.set(domainBytes, 0);
  out.set(messageBytes, domainBytes.length);
  return out;
}

function argValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value === undefined ? null : value;
}

export async function runLaunchSignerCli(argv: readonly string[], env: ProcessEnvLike, emit: (line: string) => void): Promise<number> {
  const configPath = argValue(argv, '--config') ?? env['AUTOPILOT_LAUNCH_SIGNER_CONFIG'] ?? null;
  const requestRaw = argValue(argv, '--request');
  if (configPath === null) { emit(JSON.stringify({ error: 'launch-signer requires --config <absolute-path> or AUTOPILOT_LAUNCH_SIGNER_CONFIG' })); return 2; }
  if (requestRaw === null) { emit(JSON.stringify({ error: 'launch-signer requires --request <json>' })); return 2; }
  const config = parseConfig(readMode0600(configPath, 'launch signer config'));
  const request = parseRequest(requestRaw);
  if (request.repo_id !== config.repo_id || request.workstream_run !== config.workstream_run) fail('request identity does not match the signer config');
  const produced = request.kind === 'launch-policy'
    ? await signPolicy(config, request, env)
    : await signHeartbeat(config, request, env);
  emit(JSON.stringify({ schema_version: 'autopilot.launch_signer_result.v1', ref: produced.ref, absolute_path: produced.absolutePath, sha256: bytesSha256(produced.bytes), byte_count: produced.bytes.byteLength }));
  return 0;
}

async function main(): Promise<void> {
  try {
    const code = await runLaunchSignerCli(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`));
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}

// Run `main()` only when this module is the invoked entrypoint: either it is
// argv[1] itself (`node .../autopilot-launch-signer.{js,ts}`) or it is loaded by
// the packaged bin wrapper (`node .../bin/autopilot-launch-signer.mjs`, which
// dynamic-imports the compiled entrypoint). Keying off `import.meta.url` alone
// is wrong: the module URL always ends with the entrypoint suffix, so a plain
// suffix check fires on every ordinary import (including tests) and poisons the
// importer's exit code. Detection must therefore be driven by `process.argv[1]`.
const invokedPath = process.argv[1];
const isDirectRun = invokedPath !== undefined && (
  pathToFileURL(resolve(invokedPath)).href === import.meta.url ||
  /[\\/]bin[\\/]autopilot-launch-signer\.mjs$/u.test(invokedPath)
);
if (isDirectRun) void main();
