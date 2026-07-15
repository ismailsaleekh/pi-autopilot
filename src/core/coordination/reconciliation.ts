import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CoordinatorClient } from './client.ts';
import { parseCoordinationReconciliationEvidence, parseOptionalCoordinationReconciliationReceipt, parseCoordinationRun } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { readCoordinatorSessionContext, type CoordinatorSessionContext } from './supervisor.ts';
import { coordinatorRuntimePaths } from './runtime-paths.ts';
import { classifyHistoricalUnitFailureEvidenceGeneration, parseHistoricalUnitFailureRegenerationCandidate, parseUnitAttemptTarget, validateReconciliationEvidenceDocument, type HistoricalUnitFailureGeneration, type ReconciliationEvidenceIdentity } from './terminal-evidence.ts';
import type { CoordinationReconciliationDetail, CoordinationReconciliationEvidence, CoordinationReconciliationSource, CoordinationReconciliationSummary, CoordinatorResponseEnvelope } from './types.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../names.ts';
import type { ActiveAutopilotRow, ProcessEnvLike } from '../parallel-runtime.ts';

interface JsonMap {
  readonly [key: string]: unknown;
}

export interface RecordReleaseEvidenceInput {
  readonly source: Exclude<CoordinationReconciliationSource, 'child-process'>;
  readonly targetId: string;
  readonly evidenceRef: string;
  readonly evidenceSha256: `sha256:${string}`;
}

export interface RecordReleaseEvidenceResult {
  readonly evidence: CoordinationReconciliationEvidence;
  readonly reconciliation: CoordinationReconciliationSummary;
}

interface PendingReconciliationIntent {
  readonly schema_version: 'autopilot.reconciliation_intent.v1';
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream_run: string;
  readonly source: Exclude<CoordinationReconciliationSource, 'child-process'>;
  readonly target_id: string;
  readonly evidence_path: string;
  readonly evidence_ref: string;
  readonly evidence_sha256: `sha256:${string}`;
}

interface PendingReconciliationIntentSupersession {
  readonly schema_version: 'autopilot.reconciliation_intent_supersession.v1';
  readonly disposition: 'current-evidence-regeneration-required';
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream_run: string;
  readonly source: 'attempt-reset';
  readonly target_id: string;
  readonly evidence_ref: string;
  readonly evidence_sha256: `sha256:${string}`;
  readonly pending_intent_sha256: `sha256:${string}`;
  readonly historical_generation: HistoricalUnitFailureGeneration;
  readonly historical_action: 'reset' | 'abort';
}

const MAX_PENDING_RECONCILIATION_INTENT_BYTES = 64 * 1024;
const MAX_COORDINATION_EVIDENCE_BYTES = 1024 * 1024;

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `${label} is not an object`);
  return value as JsonMap;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new CoordinationRuntimeError('invalid-state', `${label} is not a string array`);
  return Object.freeze([...value]);
}

export function parseCoordinationReconciliationSummary(value: unknown): CoordinationReconciliationSummary {
  const parsed = record(value, 'coordination reconciliation summary');
  const fields = ['notification_ids', 'offered_group_ids', 'released_lease_ids', 'released_observation_ids', 'released_request_ids', 'stale_observation_ids'] as const;
  const unknown = Object.keys(parsed).filter((field) => !(fields as readonly string[]).includes(field));
  if (unknown.length > 0 || fields.some((field) => !(field in parsed))) throw new CoordinationRuntimeError('schema-mismatch', 'coordination reconciliation summary fields are incompatible', unknown);
  return {
    released_lease_ids: stringArray(parsed['released_lease_ids'], 'released_lease_ids'),
    released_observation_ids: stringArray(parsed['released_observation_ids'], 'released_observation_ids'),
    stale_observation_ids: stringArray(parsed['stale_observation_ids'], 'stale_observation_ids'),
    released_request_ids: stringArray(parsed['released_request_ids'], 'released_request_ids'),
    notification_ids: stringArray(parsed['notification_ids'], 'notification_ids'),
    offered_group_ids: stringArray(parsed['offered_group_ids'], 'offered_group_ids'),
  };
}

export function reconciliationSummaryFromDetails(details: readonly CoordinationReconciliationDetail[]): CoordinationReconciliationSummary {
  const ids = (kind: CoordinationReconciliationDetail['kind']): readonly string[] => Object.freeze(details.filter((detail) => detail.kind === kind).map((detail) => detail.entity_id));
  return {
    released_lease_ids: ids('released-lease'),
    released_observation_ids: ids('released-observation'),
    stale_observation_ids: ids('stale-observation'),
    released_request_ids: ids('released-request'),
    notification_ids: ids('notification'),
    offered_group_ids: ids('offered-group'),
  };
}

function committedSequence(response: CoordinatorResponseEnvelope): number {
  if (response.committed_event_seq === null) throw new CoordinationRuntimeError('invalid-state', 'coordinator reconciliation mutation omitted committed event sequence');
  return response.committed_event_seq;
}

export class RunReconciliationClient {
  readonly #client: CoordinatorClient;
  #session: CoordinatorSessionContext;

  constructor(client: CoordinatorClient, session: CoordinatorSessionContext) {
    this.#client = client;
    this.#session = session;
  }

  static async fromEnvironment(env: ProcessEnvLike = process.env): Promise<RunReconciliationClient> {
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for owned-run reconciliation`);
    const session = await readCoordinatorSessionContext(contextPath);
    return new RunReconciliationClient(new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }), session);
  }

  get session(): CoordinatorSessionContext {
    return this.#session;
  }

  async reconcile(reason: string): Promise<{ readonly reconciliation: CoordinationReconciliationSummary; readonly committedEventSeq: number }> {
    const response = await this.#client.mutate('reconcile-run', this.#identity(`reconcile-run:${this.#session.workstream_run}:${randomUUID()}`), {
      reason,
      ...this.#sessionProof(),
    });
    const receipt = parseOptionalCoordinationReconciliationReceipt(response.payload['reconciliation_receipt']);
    const details = receipt === null ? [] : await this.#client.reconciliationDetails({ repoId: this.#session.repo_id, workstreamRun: this.#session.workstream_run, sessionId: this.#session.session_id, fencingGeneration: this.#session.session_generation, sessionLeaseId: this.#session.session_lease_id, sessionToken: this.#session.session_token, receipt });
    return { reconciliation: reconciliationSummaryFromDetails(details), committedEventSeq: committedSequence(response) };
  }

  async recordReleaseEvidence(input: RecordReleaseEvidenceInput): Promise<RecordReleaseEvidenceResult> {
    const evidenceIdentity = createHash('sha256').update(`${this.#session.repo_id}\0${this.#session.workstream_run}\0${input.source}\0${input.targetId}\0${input.evidenceRef}\0${input.evidenceSha256}`, 'utf8').digest('hex');
    const idempotencyKey = `record-release-evidence:${evidenceIdentity}`;
    const payload = {
      source: input.source,
      target_id: input.targetId,
      evidence_ref: input.evidenceRef,
      evidence_sha256: input.evidenceSha256,
      ...this.#sessionProof(),
    };
    let response: CoordinatorResponseEnvelope;
    try {
      response = await this.#client.mutate('record-release-evidence', this.#identity(idempotencyKey), payload);
    } catch (error) {
      if (!(error instanceof CoordinationRuntimeError && error.code === 'stale-version')) throw error;
      const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
      const values = status.payload['runs'];
      if (!Array.isArray(values) || values.length !== 1 || values[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'stale reconciliation retry could not recover one exact durable run');
      const currentRun = parseCoordinationRun(values[0]);
      if (currentRun.active_session_generation !== this.#session.session_generation) throw new CoordinationRuntimeError('fenced-session', 'stale reconciliation retry observed a replacement session generation');
      this.#session = { ...this.#session, run_version: currentRun.version };
      // One bounded retry uses the identical semantic idempotency key and exact
      // authenticated session after refreshing only durable run version.
      response = await this.#client.mutate('record-release-evidence', this.#identity(idempotencyKey), payload);
    }
    const run = parseCoordinationRun(response.payload['run']);
    this.#session = { ...this.#session, run_version: run.version };
    const receipt = parseOptionalCoordinationReconciliationReceipt(response.payload['reconciliation_receipt']);
    const details = receipt === null ? [] : await this.#client.reconciliationDetails({ repoId: this.#session.repo_id, workstreamRun: this.#session.workstream_run, sessionId: this.#session.session_id, fencingGeneration: this.#session.session_generation, sessionLeaseId: this.#session.session_lease_id, sessionToken: this.#session.session_token, receipt });
    return {
      evidence: parseCoordinationReconciliationEvidence(response.payload['reconciliation_evidence']),
      reconciliation: reconciliationSummaryFromDetails(details),
    };
  }

  #identity(idempotencyKey: string) {
    return {
      repoId: this.#session.repo_id,
      workstreamRun: this.#session.workstream_run,
      sessionId: this.#session.session_id,
      fencingGeneration: this.#session.session_generation,
      expectedVersion: this.#session.run_version,
      idempotencyKey,
    };
  }

  #sessionProof(): { readonly session_lease_id: string; readonly session_token: string } {
    return { session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token };
  }
}

function parsePendingReconciliationIntent(value: unknown): PendingReconciliationIntent {
  const parsed = record(value, 'pending reconciliation intent');
  const fields = ['autopilot_id', 'evidence_path', 'evidence_ref', 'evidence_sha256', 'repo_id', 'schema_version', 'source', 'target_id', 'workstream_run'] as const;
  const unknownFields = Object.keys(parsed).filter((field) => !(fields as readonly string[]).includes(field));
  if (unknownFields.length > 0 || fields.some((field) => !(field in parsed))) throw new CoordinationRuntimeError('schema-mismatch', 'pending reconciliation intent fields are incompatible', unknownFields);
  const requiredString = (field: typeof fields[number]): string => {
    const entry = parsed[field];
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 2048) throw new CoordinationRuntimeError('invalid-state', `pending reconciliation intent ${field} is invalid`);
    return entry;
  };
  const sourceValue = requiredString('source');
  if (sourceValue !== 'unit-merge' && sourceValue !== 'attempt-reset' && sourceValue !== 'quarantine-capture' && sourceValue !== 'run-close' && sourceValue !== 'run-abort') throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent source is invalid');
  const digest = requiredString('evidence_sha256');
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent digest is invalid');
  if (requiredString('schema_version') !== 'autopilot.reconciliation_intent.v1') throw new CoordinationRuntimeError('schema-mismatch', 'pending reconciliation intent schema is incompatible');
  const evidencePath = requiredString('evidence_path');
  if (!isAbsolute(evidencePath)) throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent evidence path must be absolute');
  return {
    schema_version: 'autopilot.reconciliation_intent.v1',
    repo_id: requiredString('repo_id'),
    autopilot_id: requiredString('autopilot_id'),
    workstream_run: requiredString('workstream_run'),
    source: sourceValue,
    target_id: requiredString('target_id'),
    evidence_path: evidencePath,
    evidence_ref: requiredString('evidence_ref'),
    evidence_sha256: digest as `sha256:${string}`,
  };
}

function pendingIntentRoot(active: ActiveAutopilotRow): string {
  return join(active.runtime_root, 'coordination-reconciliation', 'pending');
}

function supersededIntentRoot(active: ActiveAutopilotRow): string {
  return join(active.runtime_root, 'coordination-reconciliation', 'superseded');
}

function pendingIntentPath(active: ActiveAutopilotRow, intent: Pick<PendingReconciliationIntent, 'source' | 'target_id' | 'evidence_ref' | 'evidence_sha256'>): string {
  const id = createHash('sha256').update(`${active.repo_key}\0${active.workstream_run}\0${intent.source}\0${intent.target_id}\0${intent.evidence_ref}\0${intent.evidence_sha256}`, 'utf8').digest('hex');
  return join(pendingIntentRoot(active), `${id}.json`);
}

function samePendingIntent(left: PendingReconciliationIntent, right: PendingReconciliationIntent): boolean {
  return left.schema_version === right.schema_version && left.repo_id === right.repo_id && left.autopilot_id === right.autopilot_id && left.workstream_run === right.workstream_run && left.source === right.source && left.target_id === right.target_id && left.evidence_path === right.evidence_path && left.evidence_ref === right.evidence_ref && left.evidence_sha256 === right.evidence_sha256;
}

async function existingPendingIntent(path: string): Promise<PendingReconciliationIntent | null> {
  if (!existsSync(path)) return null;
  try {
    const bytes = await readStableRegularFile(path, 'existing pending reconciliation intent', MAX_PENDING_RECONCILIATION_INTENT_BYTES);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    return parsePendingReconciliationIntent(value);
  } catch (error) {
    if (error instanceof CoordinationRuntimeError) throw error;
    throw new CoordinationRuntimeError('invalid-state', 'existing pending reconciliation intent is unreadable', [path, error instanceof Error ? error.message : String(error)]);
  }
}

export async function readStableRegularFile(path: string, label: string, maximumBytes: number): Promise<Uint8Array> {
  let descriptor: number | null = null;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new CoordinationRuntimeError('unauthorized-client', `${label} must be a regular non-symbolic file`, [path]);
    const canonicalBefore = realpathSync(path);
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maximumBytes) throw new CoordinationRuntimeError('invalid-request', `${label} must be a regular file no larger than ${String(maximumBytes)} bytes`, [path, `size=${String(opened.size)}`]);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new CoordinationRuntimeError('unauthorized-client', `${label} changed while its identity was being established`, [path]);
    const bytes = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    const canonicalAfter = realpathSync(path);
    if (bytes.byteLength !== opened.size || afterDescriptor.size !== opened.size || afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || canonicalAfter !== canonicalBefore) throw new CoordinationRuntimeError('unauthorized-client', `${label} changed during its atomic read`, [path]);
    return bytes;
  } catch (error) {
    if (error instanceof CoordinationRuntimeError) throw error;
    throw new CoordinationRuntimeError('invalid-request', `${label} is unreadable`, [path, error instanceof Error ? error.message : String(error)]);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

async function readOwnedEvidenceBytes(active: ActiveAutopilotRow, evidencePath: string): Promise<Uint8Array> {
  const canonicalRoot = realpathSync(active.main_worktree_path);
  const canonicalEvidence = realpathSync(evidencePath);
  const physicalRef = relative(canonicalRoot, canonicalEvidence);
  if (physicalRef.length === 0 || physicalRef === '..' || physicalRef.startsWith(`..${sep}`) || isAbsolute(physicalRef)) throw new CoordinationRuntimeError('unauthorized-client', 'reconciliation evidence physically escapes the run-owned main worktree', [evidencePath]);
  return await readStableRegularFile(evidencePath, 'reconciliation evidence', MAX_COORDINATION_EVIDENCE_BYTES);
}

async function persistImmutableSupersession(path: string, supersession: PendingReconciliationIntentSupersession): Promise<void> {
  const bytes = `${JSON.stringify(supersession, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const existing = new TextDecoder('utf-8', { fatal: true }).decode(await readStableRegularFile(path, 'pending reconciliation intent supersession', MAX_PENDING_RECONCILIATION_INTENT_BYTES));
    if (existing !== bytes) throw new CoordinationRuntimeError('idempotency-conflict', 'historical pending reconciliation intent supersession differs from its immutable replay identity', [path]);
    return;
  }
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (!existsSync(path)) throw error;
      const existing = new TextDecoder('utf-8', { fatal: true }).decode(await readStableRegularFile(path, 'pending reconciliation intent supersession', MAX_PENDING_RECONCILIATION_INTENT_BYTES));
      if (existing !== bytes) throw new CoordinationRuntimeError('idempotency-conflict', 'concurrent historical pending reconciliation supersession differs from its immutable replay identity', [path]);
    }
  } finally { await rm(temporary, { force: true }); }
}

function evidenceIdentity(active: ActiveAutopilotRow, intent: PendingReconciliationIntent): ReconciliationEvidenceIdentity {
  const unitTarget = intent.source === 'unit-merge' || intent.source === 'attempt-reset' || intent.source === 'quarantine-capture' ? parseUnitAttemptTarget(intent.target_id) : null;
  return {
    repoKey: active.repo_key, autopilotId: active.autopilot_id, workstream: active.workstream, workstreamRun: active.workstream_run,
    source: intent.source, targetId: intent.target_id, unitId: unitTarget?.unitId ?? null, attempt: unitTarget?.attempt ?? null,
  };
}

async function supersedeHistoricalPendingIntent(input: { readonly active: ActiveAutopilotRow; readonly intentPath: string; readonly intentBytes: Uint8Array; readonly intent: PendingReconciliationIntent; readonly evidenceBytes: Uint8Array }): Promise<boolean> {
  if (input.intent.source !== 'attempt-reset' && input.intent.source !== 'quarantine-capture') return false;
  if (classifyHistoricalUnitFailureEvidenceGeneration(input.evidenceBytes) === null) return false;
  const candidate = parseHistoricalUnitFailureRegenerationCandidate(input.evidenceBytes, evidenceIdentity(input.active, input.intent));
  if (input.intent.source !== 'attempt-reset') throw new CoordinationRuntimeError('invalid-state', 'historical reset/abort pending evidence cannot satisfy a quarantine-capture intent', [input.intentPath]);
  const evidenceSha256 = `sha256:${createHash('sha256').update(input.evidenceBytes).digest('hex')}` as const;
  if (candidate.originalSha256 !== input.intent.evidence_sha256 || evidenceSha256 !== input.intent.evidence_sha256) throw new CoordinationRuntimeError('invalid-state', 'historical pending reconciliation evidence digest differs from its immutable intent', [input.intentPath]);
  const supersession: PendingReconciliationIntentSupersession = {
    schema_version: 'autopilot.reconciliation_intent_supersession.v1', disposition: candidate.disposition,
    repo_id: input.intent.repo_id, autopilot_id: input.intent.autopilot_id, workstream_run: input.intent.workstream_run,
    source: 'attempt-reset', target_id: input.intent.target_id, evidence_ref: input.intent.evidence_ref, evidence_sha256: input.intent.evidence_sha256,
    pending_intent_sha256: `sha256:${createHash('sha256').update(input.intentBytes).digest('hex')}`,
    historical_generation: candidate.generation, historical_action: candidate.action,
  };
  await persistImmutableSupersession(join(supersededIntentRoot(input.active), `${input.intentPath.slice(input.intentPath.lastIndexOf(sep) + 1)}`), supersession);
  await rm(input.intentPath);
  return true;
}

async function writePendingIntent(path: string, intent: PendingReconciliationIntent): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await existingPendingIntent(path);
  if (existing !== null) {
    if (!samePendingIntent(existing, intent)) throw new CoordinationRuntimeError('idempotency-conflict', 'pending reconciliation intent identity was reused with different evidence', [path]);
    return;
  }
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (!existsSync(path)) throw error;
      const raced = await existingPendingIntent(path);
      if (raced === null || !samePendingIntent(raced, intent)) throw new CoordinationRuntimeError('idempotency-conflict', 'concurrent pending reconciliation intent differs from the requested evidence', [path]);
    }
  } finally { await rm(temporary, { force: true }); }
}

async function durableCoordinatorRunExists(active: ActiveAutopilotRow, env: ProcessEnvLike): Promise<boolean> {
  const stateRoot = dirname(dirname(resolve(active.worktree_root)));
  const expectedWorktreeRoot = resolve(stateRoot, 'worktrees', active.repo_key);
  if (expectedWorktreeRoot !== resolve(active.worktree_root)) throw new CoordinationRuntimeError('invalid-state', 'active worktree root is not under the package-owned state root');
  const coordinatorEnv: ProcessEnvLike = { ...env, AUTOPILOT_STATE_ROOT: stateRoot };
  const paths = coordinatorRuntimePaths(coordinatorEnv);
  if (!existsSync(paths.databasePath)) return false;
  const status = await new CoordinatorClient({ env: coordinatorEnv }).query('status', active.repo_key, active.workstream_run);
  const runs = status.payload['runs'];
  if (!Array.isArray(runs)) throw new CoordinationRuntimeError('invalid-state', 'coordinator status omitted durable runs');
  if (runs.length > 1) throw new CoordinationRuntimeError('store-corrupt', 'coordinator returned duplicate durable runs');
  return runs.length === 1;
}

export async function recordCoordinatorReleaseEvidenceFromFile(input: {
  readonly active: ActiveAutopilotRow;
  readonly source: Exclude<CoordinationReconciliationSource, 'child-process'>;
  readonly targetId: string;
  readonly evidencePath: string;
  readonly env?: ProcessEnvLike;
}): Promise<RecordReleaseEvidenceResult | null> {
  const env = input.env ?? process.env;
  if (!isAbsolute(input.evidencePath)) throw new CoordinationRuntimeError('invalid-request', 'reconciliation evidence path must be absolute');
  const evidenceRef = relative(input.active.main_worktree_path, input.evidencePath).split(sep).join('/');
  if (evidenceRef.length === 0 || evidenceRef === '..' || evidenceRef.startsWith('../') || isAbsolute(evidenceRef)) throw new CoordinationRuntimeError('unauthorized-client', 'reconciliation evidence is outside the run-owned main worktree');
  const bytes = await readOwnedEvidenceBytes(input.active, input.evidencePath);
  const unitTarget = input.source === 'unit-merge' || input.source === 'attempt-reset' || input.source === 'quarantine-capture' ? parseUnitAttemptTarget(input.targetId) : null;
  validateReconciliationEvidenceDocument(bytes, {
    repoKey: input.active.repo_key,
    autopilotId: input.active.autopilot_id,
    workstream: input.active.workstream,
    workstreamRun: input.active.workstream_run,
    source: input.source,
    targetId: input.targetId,
    unitId: unitTarget?.unitId ?? null,
    attempt: unitTarget?.attempt ?? null,
  });
  const evidenceSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const intent: PendingReconciliationIntent = {
    schema_version: 'autopilot.reconciliation_intent.v1',
    repo_id: input.active.repo_key,
    autopilot_id: input.active.autopilot_id,
    workstream_run: input.active.workstream_run,
    source: input.source,
    target_id: input.targetId,
    evidence_path: input.evidencePath,
    evidence_ref: evidenceRef,
    evidence_sha256: evidenceSha256,
  };
  const intentPath = pendingIntentPath(input.active, intent);
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) {
    if (!(await durableCoordinatorRunExists(input.active, env))) return null;
    await writePendingIntent(intentPath, intent);
    throw new CoordinationRuntimeError('unauthorized-client', 'durable lifecycle evidence was preserved, but reconciliation requires a current attached session', [intentPath]);
  }
  const client = await RunReconciliationClient.fromEnvironment(env);
  const session = client.session;
  if (session.repo_id !== input.active.repo_key || session.autopilot_id !== input.active.autopilot_id || session.workstream_run !== input.active.workstream_run) throw new CoordinationRuntimeError('unauthorized-client', 'reconciliation evidence does not belong to the attached durable run');
  await writePendingIntent(intentPath, intent);
  const result = await client.recordReleaseEvidence({ source: input.source, targetId: input.targetId, evidenceRef, evidenceSha256 });
  await rm(intentPath);
  return result;
}

export async function replayPendingCoordinatorReconciliation(input: { readonly active: ActiveAutopilotRow; readonly env?: ProcessEnvLike }): Promise<readonly RecordReleaseEvidenceResult[]> {
  const root = pendingIntentRoot(input.active);
  let names: readonly string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  const results: RecordReleaseEvidenceResult[] = [];
  for (const name of names) {
    const path = join(root, name);
    let value: unknown;
    let intentBytes: Uint8Array;
    try {
      intentBytes = await readStableRegularFile(path, 'pending reconciliation intent', MAX_PENDING_RECONCILIATION_INTENT_BYTES);
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(intentBytes)) as unknown;
    } catch (error) {
      if (error instanceof CoordinationRuntimeError) throw error;
      throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent is unreadable', [path, error instanceof Error ? error.message : String(error)]);
    }
    const intent = parsePendingReconciliationIntent(value);
    if (intent.repo_id !== input.active.repo_key || intent.autopilot_id !== input.active.autopilot_id || intent.workstream_run !== input.active.workstream_run) throw new CoordinationRuntimeError('unauthorized-client', 'pending reconciliation intent belongs to a different durable run', [path]);
    const expectedPath = pendingIntentPath(input.active, intent);
    if (expectedPath !== path) throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation intent filename does not match its immutable identity', [path, expectedPath]);
    const currentEvidenceRef = relative(input.active.main_worktree_path, intent.evidence_path).split(sep).join('/');
    if (currentEvidenceRef !== intent.evidence_ref) throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation evidence path no longer matches its accepted run-owned ref', [path]);
    const currentBytes = await readOwnedEvidenceBytes(input.active, intent.evidence_path);
    const currentSha = `sha256:${createHash('sha256').update(currentBytes).digest('hex')}`;
    if (currentSha !== intent.evidence_sha256) throw new CoordinationRuntimeError('invalid-state', 'pending reconciliation evidence changed after the durable intent was written', [path, `expected=${intent.evidence_sha256}`, `actual=${currentSha}`]);
    if (await supersedeHistoricalPendingIntent({ active: input.active, intentPath: path, intentBytes, intent, evidenceBytes: currentBytes })) continue;
    const result = await recordCoordinatorReleaseEvidenceFromFile({
      active: input.active,
      source: intent.source,
      targetId: intent.target_id,
      evidencePath: intent.evidence_path,
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    if (result === null) throw new CoordinationRuntimeError('unauthorized-client', 'pending reconciliation replay requires an attached coordinator session');
    results.push(result);
  }
  return Object.freeze(results);
}
