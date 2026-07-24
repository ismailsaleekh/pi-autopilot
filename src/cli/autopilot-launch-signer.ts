#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { sign, createPrivateKey } from 'node:crypto';

import { canonicalJson } from '../core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../core/coordination/client.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationSessionLease } from '../core/coordination/contracts.ts';
import { CoordinationRuntimeError } from '../core/coordination/failures.ts';
import { parseD65LaunchPolicy } from '../core/coordination/d65-launch-policy.ts';
import { encodeUnpaddedBase64Url } from '../core/coordination/d65-trust.ts';
import { runGitQuery } from '../core/git-process.ts';
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
}

const CONFIG_FIELDS = [
  'schema_version', 'program_id', 'repo_id', 'workstream', 'workstream_run', 'private_key_path',
  'trust_anchor_ref', 'trust_anchor_sha256', 'signer_key_id', 'program_evidence_root', 'policy_id',
  'policy_ref', 'package_commit', 'package_tree', 'b0_commit', 'b0_tree', 'roster_sha256', 'roster_provider',
  'policy_issued_at',
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
  });
}

interface PolicyRequest { readonly kind: 'launch-policy'; readonly state_root: string; readonly repo_id: string; readonly workstream_run: string; readonly policy_id: string; readonly policy_ref: string; readonly expected_policy_sha256: `sha256:${string}` }
interface HeartbeatRequest { readonly kind: 'program-heartbeat'; readonly state_root: string; readonly repo_id: string; readonly workstream_run: string; readonly graph_sequence: number; readonly graph_sha256: `sha256:${string}`; readonly heartbeat_sequence: number }
type SignerRequest = PolicyRequest | HeartbeatRequest;

function parseRequest(raw: string): SignerRequest {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch (error) { fail('request is not JSON', [error instanceof Error ? error.message : String(error)]); }
  const record = requireObject(value, 'request');
  if (record['kind'] === 'launch-policy') {
    return Object.freeze({
      kind: 'launch-policy', state_root: requireString(record, 'state_root', 'request'), repo_id: requireString(record, 'repo_id', 'request'),
      workstream_run: requireString(record, 'workstream_run', 'request'), policy_id: requireString(record, 'policy_id', 'request'),
      policy_ref: requireString(record, 'policy_ref', 'request'), expected_policy_sha256: requireSha256(record, 'expected_policy_sha256', 'request'),
    });
  }
  if (record['kind'] === 'program-heartbeat') {
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

function requireOne<T>(values: readonly T[], label: string): T {
  if (values.length !== 1 || values[0] === undefined) fail(`${label} cardinality is not exactly one`, [`count=${String(values.length)}`]);
  return values[0];
}

async function persistSignedCandidate(absolutePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  await writeFile(absolutePath, bytes, { mode: 0o600 });
  chmodSync(absolutePath, 0o600);
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
  const privateKeyPem = new TextDecoder('utf-8').decode(readMode0600(config.private_key_path, 'operator private key'));
  const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-LAUNCH-POLICY\u0000', canonicalJson(fields)), createPrivateKey(privateKeyPem))));
  const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
  // Parse-validate our own output before writing (fail closed).
  parseD65LaunchPolicy(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  if (bytesSha256(bytes) !== request.expected_policy_sha256) fail('signed policy digest differs from the sealed expected policy digest', [bytesSha256(bytes), request.expected_policy_sha256]);
  void resource;
  const absolutePath = join(config.program_evidence_root, 'signed-launch-policies', `${request.policy_id}.json`);
  await persistSignedCandidate(absolutePath, bytes);
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
    rows: heartbeatRows(config, request, attached, policyArtifact, status, doctor, dispatchRow),
    provider_health: [{ provider: config.roster_provider, state: 'healthy', observation_ref: policyArtifact.evidence.ref, observation_sha256: policyArtifact.evidence.sha256, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
    dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: config.trust_anchor_ref, trust_anchor_sha256: config.trust_anchor_sha256, signer_key_id: config.signer_key_id,
  };
  const privateKeyPem = new TextDecoder('utf-8').decode(readMode0600(config.private_key_path, 'operator private key'));
  const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-PROGRAM-HEARTBEAT\u0000', canonicalJson(fields)), createPrivateKey(privateKeyPem))));
  const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
  const ref = `program-heartbeats/${String(request.heartbeat_sequence).padStart(20, '0')}.json`;
  const absolutePath = join(config.program_evidence_root, ref);
  await persistSignedCandidate(absolutePath, bytes);
  return { ref, absolutePath, bytes };
}

function heartbeatRows(config: SignerConfig, request: HeartbeatRequest, attached: ReturnType<typeof parseCoordinationSessionLease>, policyArtifact: ReturnType<typeof parseCoordinationAuthoritativeArtifact>, status: { payload: Record<string, unknown> }, doctor: { payload: Record<string, unknown> }, dispatchRow: boolean): readonly Record<string, unknown>[] {
  const stopReasons = dispatchRow ? [] : ['graph-publication-pending'];
  return [{
    workstream: config.workstream, workstream_run: request.workstream_run, parent_session_file_sha256: null,
    coordinator_session_lease_id: attached.session_lease_id, accepted_graph_sequence: request.graph_sequence, accepted_graph_sha256: request.graph_sha256,
    status_sha256: status.payload['semantic_snapshot_sha256'], doctor_sha256: doctor.payload['semantic_snapshot_sha256'], session_lease_state: 'attached',
    child_lease_ids: [], launch_policy_sha256: policyArtifact.evidence.sha256, last_progress_event_seq: attached.attached_event_seq,
    last_handoff_sha256: null, row_state: 'active', dispatch_allowed: stopReasons.length === 0, stop_reasons: stopReasons,
  }];
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

const isDirectRun = process.argv[1] !== undefined && (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith('/autopilot-launch-signer.ts') || import.meta.url.endsWith('/autopilot-launch-signer.js'));
if (isDirectRun) void main();
