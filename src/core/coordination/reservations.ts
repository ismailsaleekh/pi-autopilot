import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CoordinatorClient } from './client.ts';
import { coordinationPathsOverlap, parseCoordinationChangeReservation, parseCoordinationEditLease, parseCoordinationReservationObligation, parseCoordinationRunTerminalIntent } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { coordinatorRuntimePaths } from './runtime-paths.ts';
import { readCoordinatorSessionContext, type CoordinatorSessionContext } from './supervisor.ts';
import type { CoordinationChangeReservation, CoordinationEditLease, CoordinationReservationObligation, CoordinationRunTerminalIntent } from './types.ts';
import { parseAutopilotUnitMerge, type AutopilotUnitMerge } from '../unit-merge.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../names.ts';
import { gitHead, type ActiveAutopilotRow, type ProcessEnvLike } from '../parallel-runtime.ts';

export interface ReservationCoordinationView {
  readonly reservations: readonly CoordinationChangeReservation[];
  readonly obligations: readonly CoordinationReservationObligation[];
  readonly editLeases: readonly CoordinationEditLease[];
}

export interface ReservationResolutionInput {
  readonly obligation: CoordinationReservationObligation;
  readonly integrationEvidenceRef: string;
  readonly integrationEvidenceSha256: `sha256:${string}`;
  readonly validationEvidenceRef: string;
  readonly validationEvidenceSha256: `sha256:${string}`;
}

interface UnitMergeFile {
  readonly merge: AutopilotUnitMerge;
  readonly evidenceRef: string;
  readonly sha256: `sha256:${string}`;
}

function parseArray<T>(value: unknown, label: string, parser: (entry: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `${label} is not an array`);
  return Object.freeze(value.map(parser));
}

function stateRootForActive(active: ActiveAutopilotRow): string {
  const stateRoot = dirname(dirname(resolve(active.worktree_root)));
  if (resolve(stateRoot, 'worktrees', active.repo_key) !== resolve(active.worktree_root)) throw new CoordinationRuntimeError('invalid-state', 'active worktree root is not under its package-owned state root');
  return stateRoot;
}

export class ReservationCoordinationClient {
  readonly #client: CoordinatorClient;
  readonly #session: CoordinatorSessionContext;

  constructor(client: CoordinatorClient, session: CoordinatorSessionContext) {
    this.#client = client;
    this.#session = session;
  }

  static async fromEnvironment(env: ProcessEnvLike = process.env): Promise<ReservationCoordinationClient> {
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for reservation coordination`);
    const session = await readCoordinatorSessionContext(contextPath);
    return new ReservationCoordinationClient(new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }), session);
  }

  async view(): Promise<ReservationCoordinationView> {
    const response = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
    return parseReservationCoordinationView(response.payload);
  }

  async prepareRunTerminal(outcome: 'closed' | 'aborted'): Promise<CoordinationRunTerminalIntent> {
    const terminalIntentId = `terminal-${this.#session.workstream_run}-${randomUUID()}`;
    const response = await this.#client.mutate('prepare-run-terminal', {
      repoId: this.#session.repo_id,
      workstreamRun: this.#session.workstream_run,
      sessionId: this.#session.session_id,
      fencingGeneration: this.#session.session_generation,
      expectedVersion: this.#session.run_version,
      idempotencyKey: `prepare-run-terminal:${terminalIntentId}`,
    }, { outcome, terminal_intent_id: terminalIntentId, session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token });
    return parseCoordinationRunTerminalIntent(response.payload['run_terminal_intent']);
  }

  async cancelRunTerminal(intent: CoordinationRunTerminalIntent, reason: string): Promise<CoordinationRunTerminalIntent> {
    const response = await this.#client.mutate('cancel-run-terminal', {
      repoId: this.#session.repo_id,
      workstreamRun: this.#session.workstream_run,
      sessionId: this.#session.session_id,
      fencingGeneration: this.#session.session_generation,
      expectedVersion: intent.version,
      idempotencyKey: `cancel-run-terminal:${intent.terminal_intent_id}`,
    }, { reason, terminal_intent_id: intent.terminal_intent_id, session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token });
    return parseCoordinationRunTerminalIntent(response.payload['run_terminal_intent']);
  }

  async resolve(input: ReservationResolutionInput): Promise<CoordinationReservationObligation> {
    const obligation = parseCoordinationReservationObligation(input.obligation);
    if (obligation.repo_id !== this.#session.repo_id || obligation.workstream_run !== this.#session.workstream_run) throw new CoordinationRuntimeError('unauthorized-client', 'reservation obligation does not belong to the attached run');
    const response = await this.#client.mutate('resolve-reservation-obligation', {
      repoId: this.#session.repo_id,
      workstreamRun: this.#session.workstream_run,
      sessionId: this.#session.session_id,
      fencingGeneration: this.#session.session_generation,
      expectedVersion: obligation.version,
      idempotencyKey: `resolve-reservation-obligation:${obligation.obligation_id}:${String(obligation.version)}`,
    }, {
      obligation_id: obligation.obligation_id,
      integration_evidence_ref: input.integrationEvidenceRef,
      integration_evidence_sha256: input.integrationEvidenceSha256,
      validation_evidence_ref: input.validationEvidenceRef,
      validation_evidence_sha256: input.validationEvidenceSha256,
      session_lease_id: this.#session.session_lease_id,
      session_token: this.#session.session_token,
    });
    return parseCoordinationReservationObligation(response.payload['reservation_obligation']);
  }
}

export async function reconcilePendingReservationResolutions(active: ActiveAutopilotRow, env: ProcessEnvLike = process.env): Promise<readonly CoordinationReservationObligation[]> {
  if (active.coordination_authority !== 'coordinator-edit-leases-v1') return Object.freeze([]);
  if (env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === undefined) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator-backed reservation reconciliation requires its durable session');
  const client = await ReservationCoordinationClient.fromEnvironment(env);
  const view = await client.view();
  const resolved: CoordinationReservationObligation[] = [];
  for (const obligation of view.obligations.filter((entry) => entry.workstream_run === active.workstream_run && (entry.state === 'integration-required' || entry.state === 'resolved'))) {
    const integrationPath = join(active.runtime_root, 'reservation-integration', `${obligation.obligation_id}.json`);
    const validationPath = join(active.runtime_root, 'validation', `reservation-${obligation.obligation_id}.json`);
    if (!existsSync(integrationPath) || !existsSync(validationPath)) continue;
    const integrationBytes = await readFile(integrationPath);
    const validationBytes = await readFile(validationPath);
    const integrationRef = relative(active.main_worktree_path, integrationPath).split(sep).join('/');
    const validationRef = relative(active.main_worktree_path, validationPath).split(sep).join('/');
    if (integrationRef.startsWith('../') || validationRef.startsWith('../')) throw new CoordinationRuntimeError('unauthorized-client', 'reservation resolution artifacts escape the run-owned main worktree');
    const integrationSha256 = `sha256:${createHash('sha256').update(integrationBytes).digest('hex')}` as const;
    const validationSha256 = `sha256:${createHash('sha256').update(validationBytes).digest('hex')}` as const;
    if (obligation.state === 'resolved' && obligation.integration_evidence?.ref === integrationRef && obligation.integration_evidence.sha256 === integrationSha256 && obligation.validation_evidence?.ref === validationRef && obligation.validation_evidence.sha256 === validationSha256) continue;
    resolved.push(await client.resolve({
      obligation,
      integrationEvidenceRef: integrationRef,
      integrationEvidenceSha256: integrationSha256,
      validationEvidenceRef: validationRef,
      validationEvidenceSha256: validationSha256,
    }));
  }
  return Object.freeze(resolved);
}

export function parseReservationCoordinationView(payload: Readonly<Record<string, unknown>>): ReservationCoordinationView {
  return {
    reservations: parseArray(payload['change_reservations'], 'change_reservations', parseCoordinationChangeReservation),
    obligations: parseArray(payload['reservation_obligations'], 'reservation_obligations', parseCoordinationReservationObligation),
    editLeases: parseArray(payload['edit_leases'], 'edit_leases', parseCoordinationEditLease),
  };
}

export function reservationSchedulingBlockers(input: {
  readonly workstreamRun: string;
  readonly requestedPaths: readonly string[];
  readonly view: ReservationCoordinationView;
}): { readonly ordering: readonly string[]; readonly integration: readonly string[] } {
  const relevant = input.view.obligations.filter((obligation) => obligation.workstream_run === input.workstreamRun && obligation.state !== 'resolved' && obligation.state !== 'cancelled' && obligation.overlapping_paths.some((path) => input.requestedPaths.some((requested) => coordinationPathsOverlap(path, requested))));
  return {
    ordering: relevant.filter((obligation) => obligation.state === 'waiting-for-predecessor').map((obligation) => `${obligation.obligation_id}: wait for predecessor reservation ${obligation.predecessor_reservation_id}`),
    integration: relevant.filter((obligation) => obligation.state === 'integration-required').map((obligation) => `${obligation.obligation_id}: integrate landed predecessor and revalidate ${obligation.overlapping_paths.join(', ')}`),
  };
}

export async function reservationCloseBlockers(active: ActiveAutopilotRow, env: ProcessEnvLike = process.env): Promise<readonly string[]> {
  if (active.coordination_authority !== 'coordinator-edit-leases-v1') return Object.freeze([]);
  const stateRoot = stateRootForActive(active);
  const coordinatorEnv: ProcessEnvLike = { ...env, AUTOPILOT_STATE_ROOT: stateRoot };
  if (!existsSync(coordinatorRuntimePaths(coordinatorEnv).databasePath)) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator-backed close lost its durable coordinator database');
  const client = new CoordinatorClient({ env: coordinatorEnv });
  const status = await client.query('status', active.repo_key, active.workstream_run);
  const runs = status.payload['runs'];
  if (!Array.isArray(runs)) throw new CoordinationRuntimeError('invalid-state', 'coordinator status omitted durable runs');
  if (runs.length === 0) throw new CoordinationRuntimeError('invalid-state', 'coordinator-backed close has no durable coordinator run');
  if (runs.length !== 1) throw new CoordinationRuntimeError('store-corrupt', 'coordinator returned duplicate durable runs');
  const view = parseReservationCoordinationView(status.payload);
  const ownReservations = view.reservations.filter((reservation) => reservation.repo_id === active.repo_key && reservation.workstream_run === active.workstream_run);
  const ownLeases = view.editLeases.filter((lease) => lease.owner.repo_id === active.repo_key && lease.owner.workstream_run === active.workstream_run);
  const ownObligations = view.obligations.filter((obligation) => obligation.repo_id === active.repo_key && obligation.workstream_run === active.workstream_run);
  const blockers: string[] = [];
  if (ownLeases.length > 0) blockers.push(...ownLeases.map((lease) => `Coordination Fabric: terminal unit retains active ${lease.mode} edit lease ${lease.edit_lease_id} on ${lease.path}`));
  blockers.push(...ownObligations.filter((obligation) => obligation.state === 'waiting-for-predecessor').map((obligation) => `Coordination Fabric: reservation ordering waits for predecessor ${obligation.predecessor_reservation_id} (${obligation.obligation_id})`));
  blockers.push(...ownObligations.filter((obligation) => obligation.state === 'integration-required').map((obligation) => `Coordination Fabric: landed predecessor requires rebase/integration and current revalidation for ${obligation.overlapping_paths.join(', ')} (${obligation.obligation_id})`));
  const resolvedObligations = ownObligations.filter((entry) => entry.state === 'resolved');
  const currentHead = resolvedObligations.length > 0 && existsSync(active.main_worktree_path) ? gitHead(active.main_worktree_path) : null;
  for (const obligation of resolvedObligations) {
    if (obligation.integration_evidence === null || obligation.validation_evidence === null) {
      blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} lacks immutable integration/validation evidence`);
      continue;
    }
    const integration = await readVerifiedRuntimeEvidence(active, obligation.integration_evidence);
    const validation = await readVerifiedRuntimeEvidence(active, obligation.validation_evidence);
    const integrationHead = textField(integration, 'integration_head', obligation.integration_evidence.ref);
    if (currentHead === null) blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} cannot verify its current integration head`);
    else if (integrationHead !== currentHead) {
      const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', integrationHead, currentHead], { cwd: active.main_worktree_path, encoding: 'utf8' });
      const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', integrationHead, currentHead], { cwd: active.main_worktree_path, encoding: 'utf8' });
      const changed = (diff.status ?? -1) === 0 ? diff.stdout.split('\0').filter((path) => path.length > 0) : [];
      const invalidating = changed.filter((path) => obligation.overlapping_paths.some((protectedPath) => coordinationPathsOverlap(path, protectedPath)));
      if ((ancestry.status ?? -1) !== 0 || (diff.status ?? -1) !== 0 || invalidating.length > 0) blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} is stale at integration head ${currentHead}${invalidating.length > 0 ? ` on ${invalidating.join(', ')}` : ''}`);
    }
    if (currentHead !== null && obligation.predecessor_terminal_sha !== null) {
      const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', obligation.predecessor_terminal_sha, currentHead], { cwd: active.main_worktree_path, encoding: 'utf8' });
      if ((ancestry.status ?? -1) !== 0) blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} integration head does not contain predecessor commit ${obligation.predecessor_terminal_sha}`);
    }
    if (textField(validation, 'integration_head', obligation.validation_evidence.ref) !== integrationHead || textField(validation, 'verdict', obligation.validation_evidence.ref) !== 'PASS') blockers.push(`Coordination Fabric: resolved obligation ${obligation.obligation_id} lacks a current validation PASS`);
  }
  const mergeFiles = await readUnitMergeFiles(active);
  const expected = new Map<string, UnitMergeFile>();
  for (const file of mergeFiles) {
    for (const path of file.merge.changed_paths) expected.set(`${file.evidenceRef}\0${file.sha256}\0${path}`, file);
  }
  for (const [key, file] of expected) {
    const split = key.split('\0');
    const path = split[2];
    if (path === undefined) throw new CoordinationRuntimeError('invalid-state', 'internal reservation proof key is malformed');
    const match = ownReservations.filter((reservation) => reservation.path === path && reservation.merge_evidence.ref === file.evidenceRef && reservation.merge_evidence.sha256 === file.sha256 && reservation.released_event_seq === null);
    if (match.length !== 1) blockers.push(`Coordination Fabric: accepted unit merge ${file.merge.unit_id} attempt ${String(file.merge.attempt)} path ${path} requires exactly one active change reservation, found ${String(match.length)}`);
  }
  for (const reservation of ownReservations) {
    if (reservation.released_event_seq !== null) blockers.push(`Coordination Fabric: unclosed run has prematurely released reservation ${reservation.reservation_id}`);
    const key = `${reservation.merge_evidence.ref}\0${reservation.merge_evidence.sha256}\0${reservation.path}`;
    if (!expected.has(key)) blockers.push(`Coordination Fabric: reservation ${reservation.reservation_id} lacks matching current unit-merge/path evidence`);
  }
  for (const reservation of ownReservations.filter((entry) => entry.released_event_seq === null)) {
    const predecessors = view.reservations.filter((candidate) => candidate.repo_id === reservation.repo_id && candidate.workstream_run !== reservation.workstream_run && candidate.released_event_seq === null && (candidate.created_event_seq < reservation.created_event_seq || (candidate.created_event_seq === reservation.created_event_seq && candidate.reservation_id.localeCompare(reservation.reservation_id) < 0)) && coordinationPathsOverlap(candidate.path, reservation.path));
    for (const predecessor of predecessors) {
      const obligation = ownObligations.find((entry) => entry.reservation_id === reservation.reservation_id && entry.predecessor_reservation_id === predecessor.reservation_id && entry.state !== 'cancelled');
      if (obligation === undefined) blockers.push(`Coordination Fabric: overlapping reservation ${reservation.reservation_id} is missing ordering evidence for predecessor ${predecessor.reservation_id}`);
    }
  }
  return Object.freeze([...new Set(blockers)].sort((left, right) => left.localeCompare(right)));
}

export async function preparedRunTerminalIntent(active: ActiveAutopilotRow, env: ProcessEnvLike = process.env): Promise<CoordinationRunTerminalIntent | null> {
  if (active.coordination_authority !== 'coordinator-edit-leases-v1') return null;
  const stateRoot = stateRootForActive(active);
  const coordinatorEnv: ProcessEnvLike = { ...env, AUTOPILOT_STATE_ROOT: stateRoot };
  if (!existsSync(coordinatorRuntimePaths(coordinatorEnv).databasePath)) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator-backed terminal recovery lost its durable coordinator database');
  const status = await new CoordinatorClient({ env: coordinatorEnv }).query('status', active.repo_key, active.workstream_run);
  const values = status.payload['run_terminal_intents'];
  if (!Array.isArray(values)) throw new CoordinationRuntimeError('invalid-state', 'coordinator status omitted run terminal intents');
  const prepared = values.map((value) => parseCoordinationRunTerminalIntent(value)).filter((intent) => intent.state === 'prepared');
  if (prepared.length > 1) throw new CoordinationRuntimeError('store-corrupt', 'run has multiple prepared terminal intents');
  return prepared[0] ?? null;
}

export interface ResolvedReservationIntegration {
  readonly obligationId: string;
  readonly predecessorTerminalSha: string;
  readonly paths: readonly string[];
}

export async function resolvedReservationIntegrations(active: ActiveAutopilotRow, env: ProcessEnvLike = process.env): Promise<readonly ResolvedReservationIntegration[]> {
  if (active.coordination_authority !== 'coordinator-edit-leases-v1') return Object.freeze([]);
  const stateRoot = stateRootForActive(active);
  const coordinatorEnv: ProcessEnvLike = { ...env, AUTOPILOT_STATE_ROOT: stateRoot };
  if (!existsSync(coordinatorRuntimePaths(coordinatorEnv).databasePath)) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator-backed integration proof lost its durable coordinator database');
  const status = await new CoordinatorClient({ env: coordinatorEnv }).query('status', active.repo_key, active.workstream_run);
  const runs = status.payload['runs'];
  if (!Array.isArray(runs) || runs.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'coordinator-backed integration proof requires exactly one durable run');
  const view = parseReservationCoordinationView(status.payload);
  const integrations: ResolvedReservationIntegration[] = [];
  for (const obligation of view.obligations.filter((entry) => entry.workstream_run === active.workstream_run && entry.state === 'resolved')) {
    if (obligation.predecessor_terminal_sha === null) throw new CoordinationRuntimeError('store-corrupt', 'resolved reservation obligation lacks predecessor terminal commit', [obligation.obligation_id]);
    integrations.push({ obligationId: obligation.obligation_id, predecessorTerminalSha: obligation.predecessor_terminal_sha, paths: obligation.overlapping_paths });
  }
  return Object.freeze(integrations);
}

async function readVerifiedRuntimeEvidence(active: ActiveAutopilotRow, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): Promise<Readonly<Record<string, unknown>>> {
  const path = resolve(active.main_worktree_path, evidence.ref);
  const relativePath = relative(active.main_worktree_path, path);
  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new CoordinationRuntimeError('unauthorized-client', 'reservation evidence escapes the run-owned main worktree', [evidence.ref]);
  const bytes = await readFile(path);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== evidence.sha256) throw new CoordinationRuntimeError('invalid-state', 'reservation evidence changed after coordinator acceptance', [evidence.ref]);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; } catch (error) { throw new CoordinationRuntimeError('invalid-state', 'reservation evidence is invalid JSON', [evidence.ref, error instanceof Error ? error.message : String(error)]); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CoordinationRuntimeError('invalid-state', 'reservation evidence must be an object', [evidence.ref]);
  return parsed as Readonly<Record<string, unknown>>;
}

function textField(record: Readonly<Record<string, unknown>>, field: string, ref: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) throw new CoordinationRuntimeError('invalid-state', `reservation evidence ${ref} has invalid ${field}`);
  return value;
}

async function readUnitMergeFiles(active: ActiveAutopilotRow): Promise<readonly UnitMergeFile[]> {
  const root = join(active.runtime_root, 'unit-merges');
  if (!existsSync(root)) return Object.freeze([]);
  const files = await listJsonFiles(root);
  const out: UnitMergeFile[] = [];
  for (const path of files) {
    const bytes = await readFile(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch (error) {
      throw new CoordinationRuntimeError('invalid-state', 'unit merge evidence is not valid JSON', [path, error instanceof Error ? error.message : String(error)]);
    }
    const merge = parseAutopilotUnitMerge(parsed);
    if (merge.autopilot_id !== active.autopilot_id || merge.workstream_run !== active.workstream_run) continue;
    const evidenceRef = relative(active.main_worktree_path, path).split(sep).join('/');
    if (evidenceRef.length === 0 || evidenceRef === '..' || evidenceRef.startsWith('../') || isAbsolute(evidenceRef)) throw new CoordinationRuntimeError('unauthorized-client', 'unit merge evidence escapes the run-owned main worktree', [path]);
    out.push({ merge, evidenceRef, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  }
  return Object.freeze(out.sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef)));
}

async function listJsonFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return Object.freeze(files.sort((left, right) => left.localeCompare(right)));
}
