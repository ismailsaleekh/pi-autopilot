// Shared coordinator multiprocess harness (Phase 40 / D70 changes C3+C4).
//
// Extracted VERBATIM from tests/multiprocess/coordinator-process.test.ts so the
// 5/10/32-client persistent release-trace cohorts can live in sibling files and
// be scheduled concurrently, and so the remaining lifecycle tests reuse the exact
// same helpers. Helpers are pure functions or per-instance classes. The one
// module-level counter (releaseTraceQueryMeter, the D70 C3 O(1)-round-trip proof)
// is reset at the start of each certifyPersistentReleaseTrace call; because
// node:test runs one process per file and each cohort file drives exactly one
// cohort, concurrent cohorts never share a process or a counter. Every
// real-process spawn/kill path and every assertion is byte-identical to the
// pre-extraction original.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessLite } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { isExactProcessAlive, isProcessAlive, processStartIdentity, retireExactProcess } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { stopCoordinatorByLock, stopSpawnedChild, stopTestCoordinatorsForStateRoot } from './coordinator-process-lifecycle.ts';

export const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const coordinatorCli = join(packageRoot, 'src', 'cli', 'autopilot-coordinator.ts');
export const negotiationClient = join(packageRoot, 'tests', 'helpers', 'negotiation-process-client.ts');
export const releaseTraceClient = join(packageRoot, 'tests', 'helpers', 'release-trace-process-client.ts');
export const RELEASE_TRACE_SEED = 0x40cf09;

export interface LockRecord {
  readonly pid: number;
  readonly process_start_identity: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function completesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('condition did not become true before timeout');
}

export async function waitForCoordinator(client: CoordinatorClient): Promise<void> {
  await waitFor(async () => {
    try {
      await client.query('status');
      return true;
    } catch {
      return false;
    }
  });
}

export async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Readonly<Record<string, unknown>>;
    const pid = record['pid'];
    const processStartIdentity = record['process_start_identity'];
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && typeof processStartIdentity === 'string' && processStartIdentity.length > 0 ? { pid, process_start_identity: processStartIdentity } : null;
  } catch {
    return null;
  }
}

export function hardKillExactLock(record: LockRecord, label: string): void {
  assert.equal(isExactProcessAlive(record.pid, record.process_start_identity), true, `${label} lifecycle process identity changed before hard kill`);
  process.kill(record.pid, 'SIGKILL');
}

export function startServe(stateRoot: string): ChildProcessLite {
  return spawn(process.execPath, ['--experimental-strip-types', coordinatorCli, 'serve', '--state-root', stateRoot], {
    cwd: packageRoot,
    env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
}

export function runNegotiationClient(stateRoot: string, action: 'attach-acquire' | 'attach-acquire-write' | 'attach-acquire-path' | 'acquire-path' | 'release' | 'ack', suffix: string, ...args: readonly string[]): Readonly<Record<string, unknown>> {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', negotiationClient, action, stateRoot, suffix, ...args], {
    cwd: packageRoot,
    env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout.trim()) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('negotiation process output is not an object');
  return parsed as Readonly<Record<string, unknown>>;
}

export class PersistentTraceClient {
  readonly suffix: string;
  readonly #child: ChildProcessLite;
  readonly #pid: number | null;
  readonly #processStartIdentity: string | null;
  readonly #pending = new Map<string, { readonly resolve: (value: Readonly<Record<string, unknown>>) => void; readonly reject: (error: Error) => void }>();
  readonly #ready: Promise<void>;
  readonly #closed: Promise<void>;
  #resolveClosed: (() => void) | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: Error) => void) | null = null;
  #stdout = '';
  #stderr = '';
  readonly #stdinErrors: Error[] = [];
  #sequence = 0;
  #exitError: Error | null = null;
  #closedObserved = false;

  constructor(stateRoot: string, suffix: string) {
    this.suffix = suffix;
    this.#ready = new Promise<void>((resolveReady, rejectReady) => { this.#resolveReady = resolveReady; this.#rejectReady = rejectReady; });
    this.#closed = new Promise<void>((resolveClosed) => { this.#resolveClosed = resolveClosed; });
    this.#child = spawn(process.execPath, ['--experimental-strip-types', releaseTraceClient, 'persistent', stateRoot, suffix], {
      cwd: packageRoot,
      env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.#pid = this.#child.pid ?? null;
    this.#processStartIdentity = this.#pid === null ? null : processStartIdentity(this.#pid);
    this.#child.stdin.on('error', (error) => { this.#stdinErrors.push(error); this.#fail(error); });
    this.#child.stderr.on('data', (chunk) => { this.#stderr += chunk.toString('utf8'); });
    this.#child.stdout.on('data', (chunk) => {
      this.#stdout += chunk.toString('utf8');
      for (;;) {
        const newline = this.#stdout.indexOf('\n');
        if (newline < 0) break;
        const line = this.#stdout.slice(0, newline).trim();
        this.#stdout = this.#stdout.slice(newline + 1);
        if (line.length > 0) this.#onLine(line);
      }
    });
    this.#child.on('error', (error) => this.#fail(error));
    this.#child.on('close', (code, signal) => {
      this.#closedObserved = true;
      if (code !== 0 || this.#pending.size > 0) {
        this.#exitError = new Error(`persistent trace client ${suffix} exited code=${String(code)} signal=${signal ?? 'none'}: ${this.#stderr}`);
        this.#fail(this.#exitError);
      }
      this.#resolveClosed?.();
      this.#resolveClosed = null;
    });
  }

  async ready(): Promise<void> {
    if (this.#pid === null) throw new Error(`persistent trace client ${this.suffix} has no spawned PID`);
    if (this.#processStartIdentity === null) throw new Error(`persistent trace client ${this.suffix} has no exact process-start identity captured at spawn`);
    await this.#ready;
  }

  async send(action: string, fields: Readonly<Record<string, unknown>> = {}): Promise<Readonly<Record<string, unknown>>> {
    await this.#ready;
    const id = `${this.suffix}-${String(++this.#sequence)}`;
    return await new Promise((resolveResponse, rejectResponse) => {
      this.#pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
      this.#child.stdin.write(`${JSON.stringify({ id, action, ...fields })}\n`);
    });
  }

  async stop(): Promise<void> {
    const failures: Error[] = [];
    if (this.#child.exitCode === null) {
      try { await withTimeout(this.send('shutdown'), 10_000, `persistent trace client ${this.suffix} did not acknowledge shutdown`); }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      try { this.#child.stdin.end(); }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
    }
    let closed = await completesWithin(this.#closed, 5_000);
    if (!closed) {
      try { this.#signalExact('SIGTERM'); }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      closed = await completesWithin(this.#closed, 5_000);
    }
    if (!closed) {
      try { this.#signalExact('SIGKILL'); }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      closed = await completesWithin(this.#closed, 5_000);
    }
    if (!closed || !this.#closedObserved) failures.push(new Error(`persistent trace client ${this.suffix} did not produce exact child-close proof`));
    failures.push(...this.#stdinErrors);
    if (this.#exitError !== null) failures.push(this.#exitError);
    if (failures.length > 0) throw new AggregateError(failures, `persistent trace client ${this.suffix} cleanup failed`);
  }

  assertStopped(): void {
    if (!this.#closedObserved) throw new Error(`persistent trace client ${this.suffix} lacks final child-close proof`);
    if (this.#pid !== null && this.#processStartIdentity !== null && isExactProcessAlive(this.#pid, this.#processStartIdentity)) throw new Error(`persistent trace client ${this.suffix} exact child is still alive after cleanup`);
  }

  #signalExact(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.#pid === null || this.#processStartIdentity === null) throw new Error(`persistent trace client ${this.suffix} cannot signal without exact spawn identity`);
    if (!isProcessAlive(this.#pid)) return;
    if (!isExactProcessAlive(this.#pid, this.#processStartIdentity)) throw new Error(`persistent trace client ${this.suffix} process identity changed before ${signal}`);
    if (signal === 'SIGTERM') retireExactProcess(this.#pid, this.#processStartIdentity);
    else {
      if (!isExactProcessAlive(this.#pid, this.#processStartIdentity)) throw new Error(`persistent trace client ${this.suffix} process identity changed before forced kill`);
      process.kill(this.#pid, 'SIGKILL');
    }
  }

  #onLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); return; }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { this.#fail(new Error(`persistent trace client ${this.suffix} emitted a non-object`)); return; }
    const record = value as Readonly<Record<string, unknown>>;
    if (record['kind'] === 'ready') { this.#resolveReady?.(); this.#resolveReady = null; this.#rejectReady = null; return; }
    const id = record['id'];
    if (record['kind'] !== 'response' || typeof id !== 'string') { this.#fail(new Error(`persistent trace client ${this.suffix} emitted an invalid response`)); return; }
    const pending = this.#pending.get(id);
    if (pending === undefined) { this.#fail(new Error(`persistent trace client ${this.suffix} emitted unknown response ${id}`)); return; }
    this.#pending.delete(id);
    if (record['ok'] !== true) { pending.reject(new Error(String(record['error'] ?? 'persistent command failed'))); return; }
    const result = record['result'];
    if (typeof result !== 'object' || result === null || Array.isArray(result)) { pending.reject(new Error(`persistent response ${id} has no result object`)); return; }
    pending.resolve(result as Readonly<Record<string, unknown>>);
  }

  #fail(error: Error): void {
    this.#rejectReady?.(error);
    this.#resolveReady = null;
    this.#rejectReady = null;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export interface TraceTask {
  readonly id: string;
  readonly kind: 'acquire' | 'retry' | 'defer' | 'handoff' | 'cancel' | 'supersede' | 'reacquire' | 'crash';
  readonly actor: string;
  readonly dependencies: readonly string[];
  readonly attempt?: number;
  readonly groupId?: string;
}

export function randomizedTopologicalOrder(tasks: readonly TraceTask[], seed: number): readonly TraceTask[] {
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const ordered: TraceTask[] = [];
  let state = seed >>> 0;
  const next = (): number => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((task) => task.dependencies.every((dependency) => completed.has(dependency))).sort((left, right) => left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error('release trace task graph has a cycle');
    const selected = ready[next() % ready.length];
    if (selected === undefined) throw new Error('release trace random scheduler selected no task');
    remaining.delete(selected.id);
    completed.add(selected.id);
    ordered.push(selected);
  }
  return Object.freeze(ordered);
}

export function records(value: unknown, label: string): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${label} entry is not an object`);
    return entry as Readonly<Record<string, unknown>>;
  });
}

export interface ReleaseTraceSnapshot {
  readonly groups: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly leases: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly requests: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

export async function assertProductionDoctor(client: CoordinatorClient, phase: string): Promise<void> {
  const doctor = await client.query('doctor');
  assert.equal(doctor.payload['healthy'], true, `${phase}: coordinator doctor is unhealthy: ${JSON.stringify(doctor.payload['invariant_findings'])}`);
  assert.equal(doctor.payload['integrity'], 'ok', `${phase}: database integrity`);
  assert.equal(doctor.payload['invariant_error_count'], 0, `${phase}: production invariant error count`);
  assert.deepEqual(doctor.payload['invariant_findings'], [], `${phase}: production checkCoordinationInvariants findings`);
}

// Phase 40 / D70 change C3: the release-trace invariant check previously issued
// one global status query plus ONE `status` query per client (up to 32 for the
// largest cohort) on every one of ~150 scheduled steps, i.e. O(clients) socket
// round trips per step. The coordinator's global projection now returns the
// exact UNION of every run's per-run projection (proven equivalent in
// tests/unit/coordinator-global-projection-equivalence.test.ts), so the same
// per-entity assertions are evaluated against ONE global query. This is O(1)
// status round trips per checkpoint (still O(entities) data work) — a transport
// batching change only; the exact invariants, doctor cadence, and randomized
// schedule are unchanged.
export const releaseTraceQueryMeter = { statusQueries: 0, checkpoints: 0 };

export async function assertReleaseTraceInvariants(client: CoordinatorClient, suffixes: readonly string[], phase: string, expectedStates: ReadonlyMap<string, string>, expectedAuthority: 'none' | 'granted' | 'grant-ready', handoffPendingSuffix: string | null = null): Promise<ReleaseTraceSnapshot> {
  releaseTraceQueryMeter.checkpoints += 1;
  await assertProductionDoctor(client, phase);
  const statusQueriesBefore = releaseTraceQueryMeter.statusQueries;
  const global = await client.query('status', 'repo-release-trace', null);
  releaseTraceQueryMeter.statusQueries += 1;
  // Fail closed if a per-entity fan-out ever creeps back in: exactly one status
  // query must be issued per checkpoint (O(1) round trips), regardless of cohort.
  assert.equal(releaseTraceQueryMeter.statusQueries - statusQueriesBefore, 1, `${phase}: release-trace checkpoint must issue exactly one status query (O(1) round trips)`);
  const runs = records(global.payload['runs'], `${phase} runs`);
  const sessions = records(global.payload['session_leases'], `${phase} sessions`);
  assert.equal(runs.length, suffixes.length, `${phase}: durable run count`);
  for (const suffix of suffixes) {
    const runId = `run-${suffix}`;
    const attached = sessions.filter((session) => session['workstream_run'] === runId && session['status'] === 'attached');
    assert.equal(attached.length, suffix === handoffPendingSuffix ? 0 : 1, `${phase}: ${runId} attached-session count`);
  }

  // The single global projection carries every run's acquisition groups, edit
  // leases, and claim requests as the exact union of the per-run projections;
  // the de-duplicating merge below is preserved verbatim so a repeated identity
  // must still agree byte-for-byte.
  const groups = new Map<string, Readonly<Record<string, unknown>>>();
  const leases = new Map<string, Readonly<Record<string, unknown>>>();
  const requests = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [field, target, idField] of [
    ['acquisition_groups', groups, 'acquisition_group_id'],
    ['edit_leases', leases, 'edit_lease_id'],
    ['claim_requests', requests, 'request_id'],
  ] as const) {
    for (const entity of records(global.payload[field], `${phase} ${field}`)) {
      const id = entity[idField];
      if (typeof id !== 'string') throw new Error(`${phase}: ${field} identity is invalid`);
      const prior = target.get(id);
      if (prior !== undefined) assert.deepEqual(entity, prior, `${phase}: duplicate projection ${id} disagrees`);
      else target.set(id, entity);
    }
  }
  assert.equal(groups.size, expectedStates.size, `${phase}: durable acquisition group count`);
  for (const [groupId, expectedState] of expectedStates) assert.equal(groups.get(groupId)?.['state'], expectedState, `${phase}: ${groupId} state`);
  const authorityGroups = [...groups.values()].filter((group) => group['state'] === 'granted' || group['state'] === 'grant-ready');
  assert.equal(authorityGroups.length, expectedAuthority === 'none' ? 0 : 1, `${phase}: one-or-zero total authority groups`);
  if (expectedAuthority !== 'none') assert.equal(authorityGroups[0]?.['state'], expectedAuthority, `${phase}: authority phase`);
  assert.equal(leases.size, expectedAuthority === 'granted' ? 2 : 0, `${phase}: active layered critical authority count`);
  assert.equal(new Set([...leases.values()].map((lease) => `${String(lease['mode'])}\0${String(lease['path'])}`)).size, leases.size, `${phase}: duplicate mode/path authority`);
  for (const group of groups.values()) {
    const state = group['state'];
    const groupId = group['acquisition_group_id'];
    const held = [...leases.values()].filter((lease) => lease['acquisition_group_id'] === groupId);
    if (state === 'waiting' || state === 'grant-ready' || state === 'released' || state === 'cancelled' || state === 'superseded') assert.equal(held.length, 0, `${phase}: ${String(state)} group holds a lease`);
    if (state === 'granted') assert.equal(held.length, 2, `${phase}: granted group lacks layered WRITE/EXCLUSIVE authority`);
  }
  for (const request of requests.values()) {
    assert.equal(groups.has(String(request['acquisition_group_id'])), true, `${phase}: request has no acquisition group`);
    const status = request['status'];
    if (status === 'deferred') {
      assert.equal(typeof request['owner_reason'], 'string', `${phase}: deferred request owner reason`);
      assert.equal(typeof request['release_condition'], 'object', `${phase}: deferred request condition`);
    }
    if (status === 'released' || status === 'grant-ready' || status === 'granted' || status === 'requester-notified' || status === 'resolved') assert.equal(typeof request['release_event_seq'], 'number', `${phase}: released request sequence`);
  }
  return { groups, leases, requests };
}

export function closeResult(child: ChildProcessLite): Promise<number | null> {
  return new Promise((resolveClose) => child.on('close', (code) => resolveClose(code)));
}

export async function finishCoordinatorProcessTest(input: {
  readonly primaryFailure: unknown | null;
  readonly root: string;
  readonly stateRoot: string;
  readonly lockPath: string;
  readonly children: readonly (ChildProcessLite | null)[];
  readonly label: string;
}): Promise<void> {
  const cleanupFailures: unknown[] = [];
  try { await stopCoordinatorByLock(input.lockPath); } catch (error) { cleanupFailures.push(error); }
  for (const result of await Promise.allSettled(input.children.map(async (child) => await stopSpawnedChild(child)))) {
    if (result.status === 'rejected') cleanupFailures.push(result.reason);
  }
  try { await stopTestCoordinatorsForStateRoot(input.stateRoot); } catch (error) { cleanupFailures.push(error); }
  if (cleanupFailures.length === 0) {
    try { await rm(input.root, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
  } else cleanupFailures.push(new Error(`${input.label} root retained because exact process cleanup was not proven: ${input.root}`));
  if (input.primaryFailure !== null && cleanupFailures.length === 0) throw input.primaryFailure;
  if (input.primaryFailure !== null || cleanupFailures.length > 0) throw new AggregateError([...(input.primaryFailure === null ? [] : [input.primaryFailure]), ...cleanupFailures], `${input.label} or cleanup failed`);
}

export function numericField(record: Readonly<Record<string, unknown>>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number') throw new Error(`${field} is not numeric`);
  return value;
}


export async function certifyPersistentReleaseTrace(clientCount: number): Promise<void> {
  releaseTraceQueryMeter.statusQueries = 0;
  releaseTraceQueryMeter.checkpoints = 0;
  const root = await mkdtemp(join(tmpdir(), `pi-autopilot-${String(clientCount)}-client-release-trace-`));
  const stateRoot = join(root, 'state');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const paths = coordinatorRuntimePaths(env);
  const server = startServe(stateRoot);
  const suffixes = Array.from({ length: clientCount }, (_entry, index) => `seed-${String(clientCount)}-${String(index)}`);
  const owner = suffixes[0];
  if (owner === undefined) throw new Error('seeded release trace has no owner');
  const contestedPath = `src/contested/cohort-${String(clientCount)}.ts`;
  const primaryGroup = (suffix: string): string => `release-trace-group-${suffix}-attempt-1`;
  const replacementGroup = (suffix: string): string => `release-trace-group-${suffix}-attempt-2`;
  const actors = new Map<string, PersistentTraceClient>();
  let coordinator = new CoordinatorClient({ env, autoStart: false });
  const states = new Map<string, string>();
  const currentGroups = new Map<string, { readonly groupId: string; readonly attempt: number }>();
  const committedSequences = new Map<string, number>();
  let traceError: unknown = null;
  try {
    await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
    await waitForCoordinator(coordinator);
    for (const suffix of suffixes) actors.set(suffix, new PersistentTraceClient(stateRoot, suffix));
    await Promise.all([...actors.values()].map(async (actor) => await actor.ready()));
    for (const suffix of suffixes) {
      const actor = actors.get(suffix);
      if (actor === undefined) throw new Error(`release trace actor ${suffix} is missing during attachment`);
      await actor.send('attach-run');
      await assertProductionDoctor(coordinator, `${String(clientCount)} ${suffix} run attached`);
      await actor.send('attach-session');
      await assertProductionDoctor(coordinator, `${String(clientCount)} ${suffix} session attached`);
    }
    await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} clients attached`, states, 'none');

    const ownerActor = actors.get(owner);
    if (ownerActor === undefined) throw new Error('release trace owner process is missing');
    const ownerGroup = primaryGroup(owner);
    const ownerGrant = await ownerActor.send('acquire', { group_id: ownerGroup, path: contestedPath, attempt: 1 });
    assert.equal(ownerGrant['outcome'], 'granted');
    states.set(ownerGroup, 'granted');
    currentGroups.set(owner, { groupId: ownerGroup, attempt: 1 });
    committedSequences.set(ownerGroup, numericField(ownerGrant, 'committed_event_seq'));
    await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} owner acquire`, states, 'granted');

    const cancelActor = suffixes[suffixes.length - 1];
    if (cancelActor === undefined) throw new Error('release trace cancellation actor is missing');
    const tasks: TraceTask[] = [
      { id: 'coordinator-crash', kind: 'crash', actor: owner, dependencies: [] },
      { id: 'owner-handoff-1', kind: 'handoff', actor: owner, dependencies: [] },
      { id: 'owner-handoff-2', kind: 'handoff', actor: owner, dependencies: ['owner-handoff-1'] },
    ];
    for (const [index, suffix] of suffixes.slice(1).entries()) {
      const acquireId = `acquire-${suffix}`;
      const retryId = `retry-${suffix}`;
      const deferId = `defer-${suffix}`;
      const handoffId = `handoff-${suffix}`;
      tasks.push({ id: acquireId, kind: 'acquire', actor: suffix, dependencies: [], attempt: 1, groupId: primaryGroup(suffix) });
      tasks.push({ id: retryId, kind: 'retry', actor: suffix, dependencies: [acquireId], attempt: 1, groupId: primaryGroup(suffix) });
      tasks.push({ id: deferId, kind: 'defer', actor: owner, dependencies: [retryId], attempt: 1, groupId: primaryGroup(suffix) });
      const hasHandoff = index % 3 === 0;
      if (hasHandoff) tasks.push({ id: handoffId, kind: 'handoff', actor: suffix, dependencies: [acquireId] });
      if (suffix === cancelActor) {
        const cancellationDependencies = [deferId, ...(hasHandoff ? [handoffId] : [])];
        tasks.push({ id: `cancel-${suffix}`, kind: 'cancel', actor: suffix, dependencies: cancellationDependencies, attempt: 1, groupId: primaryGroup(suffix) });
        tasks.push({ id: `supersede-${suffix}`, kind: 'supersede', actor: suffix, dependencies: [`cancel-${suffix}`], attempt: 1 });
        tasks.push({ id: `reacquire-${suffix}`, kind: 'reacquire', actor: suffix, dependencies: [`supersede-${suffix}`], attempt: 2, groupId: replacementGroup(suffix) });
        tasks.push({ id: `retry-replacement-${suffix}`, kind: 'retry', actor: suffix, dependencies: [`reacquire-${suffix}`], attempt: 2, groupId: replacementGroup(suffix) });
        tasks.push({ id: `defer-replacement-${suffix}`, kind: 'defer', actor: owner, dependencies: [`retry-replacement-${suffix}`], attempt: 2, groupId: replacementGroup(suffix) });
      }
    }
    const seed = RELEASE_TRACE_SEED ^ clientCount;
    const plan = randomizedTopologicalOrder(tasks, seed);
    const alternateKinds = randomizedTopologicalOrder(tasks, seed ^ 0x9e3779b9).map((task) => task.kind).join(',');
    assert.notEqual(plan.map((task) => task.kind).join(','), alternateKinds, 'changing the seed must change operation categories, not only waiter identity');

    for (const [step, task] of plan.entries()) {
      const actor = actors.get(task.actor);
      if (actor === undefined) throw new Error(`release trace actor ${task.actor} is missing`);
      if (task.kind === 'acquire' || task.kind === 'reacquire') {
        if (task.groupId === undefined || task.attempt === undefined) throw new Error('acquire task identity is missing');
        const result = await actor.send('acquire', { group_id: task.groupId, path: contestedPath, attempt: task.attempt });
        assert.equal(result['outcome'], 'waiting-for-peer-release');
        states.set(task.groupId, 'waiting');
        currentGroups.set(task.actor, { groupId: task.groupId, attempt: task.attempt });
        committedSequences.set(task.groupId, numericField(result, 'committed_event_seq'));
      } else if (task.kind === 'retry') {
        if (task.groupId === undefined || task.attempt === undefined) throw new Error('retry task identity is missing');
        const first = await actor.send('retry', { group_id: task.groupId, path: contestedPath, attempt: task.attempt });
        assert.equal(first['committed_event_seq'], committedSequences.get(task.groupId));
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} ${task.id} first replay`, states, 'granted');
        const second = await actor.send('retry', { group_id: task.groupId, path: contestedPath, attempt: task.attempt });
        assert.equal(second['committed_event_seq'], first['committed_event_seq']);
        assert.equal(second['outcome'], first['outcome']);
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} ${task.id} duplicate replay`, states, 'granted');
      } else if (task.kind === 'defer') {
        if (task.groupId === undefined) throw new Error('defer task group is missing');
        const deferred = await actor.send('defer', { group_id: task.groupId });
        assert.equal(deferred['status'], 'deferred');
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} ${task.id} defer commit`, states, 'granted');
        const duplicate = await actor.send('defer-duplicate', { group_id: task.groupId });
        assert.equal(duplicate['version'], deferred['version']);
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} ${task.id} defer duplicate`, states, 'granted');
        const stale = await actor.send('defer-stale', { group_id: task.groupId });
        assert.equal(stale['stale_code'], 'stale-version');
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} ${task.id} defer stale`, states, 'granted');
      } else if (task.kind === 'handoff') {
        await actor.send('handoff-prepare');
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} ${task.id} handoff prepared`, states, 'granted', task.actor);
        await actor.send('handoff-attach');
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} ${task.id} handoff attached`, states, 'granted');
        const stale = await actor.send('handoff-stale');
        assert.equal(stale['stale_code'], 'fenced-session');
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} ${task.id} stale handoff fenced`, states, 'granted');
      } else if (task.kind === 'cancel') {
        if (task.groupId === undefined) throw new Error('cancel task group is missing');
        const result = await actor.send('cancel', { group_id: task.groupId });
        assert.equal(result['state'], 'cancelled');
        states.set(task.groupId, 'cancelled');
      } else if (task.kind === 'supersede') {
        await actor.send('supersede', { attempt: 1, superseded_by_attempt: 2 });
      } else {
        const elected = await readLock(paths.lockPath);
        if (elected === null) throw new Error('missing coordinator lock before seeded interleaving crash');
        hardKillExactLock(elected, 'seeded interleaving crash');
        await waitFor(async () => {
          const current = await readLock(paths.lockPath);
          return current === null || !isExactProcessAlive(current.pid, current.process_start_identity);
        });
        coordinator = new CoordinatorClient({ env });
        await waitForCoordinator(coordinator);
        const replay = await ownerActor.send('retry', { group_id: ownerGroup, path: contestedPath, attempt: 1 });
        assert.equal(replay['committed_event_seq'], committedSequences.get(ownerGroup));
        assert.equal(replay['outcome'], 'granted');
      }
      await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} randomized step ${String(step + 1)} ${task.id}`, states, 'granted');
    }

    for (const requiredKind of ['acquire', 'defer', 'retry', 'handoff', 'cancel', 'supersede', 'reacquire', 'crash']) assert.equal(plan.some((task) => task.kind === requiredKind), true, `missing randomized ${requiredKind} operation`);

    // This is an actual concurrent-client interleaving, not another shuffled
    // order array: commands are written to distinct long-lived child processes
    // before responses are awaited, and the coordinator races their sockets.
    const concurrentActors = randomizedTopologicalOrder(
      suffixes.slice(1).map((suffix) => ({ id: `concurrent-${suffix}`, kind: 'retry' as const, actor: suffix, dependencies: [] })),
      seed ^ 0x63d83595,
    ).map((task) => task.actor);
    const concurrentResults = await Promise.all(concurrentActors.map(async (suffix, index) => {
      const actor = actors.get(suffix);
      const identity = currentGroups.get(suffix);
      if (actor === undefined || identity === undefined) throw new Error(`concurrent persistent actor ${suffix} is missing`);
      // Seeded stagger values alter which independently running process reaches
      // the socket first; they are operation timing, not waiter-array ordering.
      const delayMs = (((seed >>> (index % 16)) ^ (index * 17)) >>> 0) % 7;
      if (delayMs > 0) await sleep(delayMs);
      const result = await actor.send('retry', { group_id: identity.groupId, path: contestedPath, attempt: identity.attempt });
      await assertProductionDoctor(coordinator, `${String(clientCount)} concurrent retry ${suffix}`);
      return { suffix, identity, result };
    }));
    assert.ok(concurrentResults.length >= 4, 'release certification must overlap at least four persistent clients');
    for (const { identity, result } of concurrentResults) assert.equal(result['committed_event_seq'], committedSequences.get(identity.groupId));
    await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} concurrent persistent retry wave`, states, 'granted');

    let holder = owner;
    const observedHolders = new Set([owner]);
    let noiseState = (seed ^ 0x51f15e) >>> 0;
    const nextNoise = (): number => { noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0; return noiseState; };
    for (let transfer = 1; transfer < clientCount; transfer += 1) {
      if ((nextNoise() & 1) === 0) {
        const holderActor = actors.get(holder);
        if (holderActor === undefined) throw new Error('holder process is missing before handoff');
        await holderActor.send('handoff-prepare');
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} transfer noise handoff prepared ${String(transfer)}`, states, 'granted', holder);
        await holderActor.send('handoff-attach');
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} transfer noise handoff attached ${String(transfer)}`, states, 'granted');
        const stale = await holderActor.send('handoff-stale');
        assert.equal(stale['stale_code'], 'fenced-session');
        await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} transfer noise stale handoff ${String(transfer)}`, states, 'granted');
      }
      if (nextNoise() % 3 === 0) {
        const waitingSuffixes = suffixes.filter((suffix) => states.get(currentGroups.get(suffix)?.groupId ?? '') === 'waiting');
        const retrySuffix = waitingSuffixes[nextNoise() % waitingSuffixes.length];
        if (retrySuffix !== undefined) {
          const retryActor = actors.get(retrySuffix);
          const identity = currentGroups.get(retrySuffix);
          if (retryActor === undefined || identity === undefined) throw new Error('transfer retry actor is missing');
          const retried = await retryActor.send('retry', { group_id: identity.groupId, path: contestedPath, attempt: identity.attempt });
          assert.equal(retried['committed_event_seq'], committedSequences.get(identity.groupId));
          await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} transfer noise retry ${String(transfer)}`, states, 'granted');
        }
      }

      const before = await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} pre-release ${String(transfer)}`, states, 'granted');
      const expected = [...before.groups.values()].filter((group) => group['state'] === 'waiting').sort((left, right) => {
        const starvation = (numericField(left, 'bypass_count') >= 8 ? 0 : 1) - (numericField(right, 'bypass_count') >= 8 ? 0 : 1);
        return starvation || numericField(left, 'offer_count') - numericField(right, 'offer_count') || numericField(left, 'created_event_seq') - numericField(right, 'created_event_seq') || String(left['acquisition_group_id']).localeCompare(String(right['acquisition_group_id']));
      })[0];
      if (expected === undefined || typeof expected['acquisition_group_id'] !== 'string') throw new Error('fair release trace has no expected successor');
      const holderActor = actors.get(holder);
      const holderIdentity = currentGroups.get(holder);
      if (holderActor === undefined || holderIdentity === undefined) throw new Error('release holder identity is missing');
      const released = await holderActor.send('release');
      assert.equal(released['status'] === 'released' || released['status'] === 'grant-ready', true);
      states.set(holderIdentity.groupId, 'released');
      states.set(expected['acquisition_group_id'], 'grant-ready');
      const offered = await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} release ${String(transfer)}`, states, 'grant-ready');
      const grantReady = [...offered.groups.values()].find((group) => group['state'] === 'grant-ready');
      assert.equal(grantReady?.['acquisition_group_id'], expected['acquisition_group_id'], `${String(clientCount)} fairness successor ${String(transfer)}`);
      const nextHolder = [...currentGroups.entries()].find((entry) => entry[1].groupId === expected['acquisition_group_id'])?.[0];
      if (nextHolder === undefined || observedHolders.has(nextHolder)) throw new Error('authority was offered twice or to an unknown actor');
      const nextActor = actors.get(nextHolder);
      if (nextActor === undefined) throw new Error('grant-ready actor process is missing');
      const grant = await nextActor.send('ack');
      assert.equal(grant['state'], 'granted');
      assert.equal(grant['lease_count'], 2);
      states.set(expected['acquisition_group_id'], 'granted');
      holder = nextHolder;
      observedHolders.add(holder);
      await assertReleaseTraceInvariants(coordinator, suffixes, `${String(clientCount)} acknowledgement ${String(transfer)}`, states, 'granted');
    }
    assert.equal(observedHolders.size, clientCount, 'every persistent client must receive contested authority exactly once');
    assert.equal([...states.values()].filter((state) => state === 'granted').length, 1);

    // Phase 40 / D70 change C3: prove the invariant cadence is O(1) status round
    // trips per checkpoint, not O(clients). The total status-query count equals
    // the checkpoint count and NEVER scales with clientCount. Under the old
    // per-client fan-out this same run issued (checkpoints x clientCount) status
    // queries; the 32-client cohort alone dropped from tens of thousands of round
    // trips to a few hundred (one per checkpoint) while evaluating byte-identical
    // per-entity invariants against the single authoritative global projection.
    assert.equal(releaseTraceQueryMeter.statusQueries, releaseTraceQueryMeter.checkpoints, `${String(clientCount)}-client release trace must issue exactly one status query per checkpoint (O(1) round trips), observed ${String(releaseTraceQueryMeter.statusQueries)} queries for ${String(releaseTraceQueryMeter.checkpoints)} checkpoints`);
    assert.ok(releaseTraceQueryMeter.checkpoints >= clientCount, 'release trace must exercise at least one checkpoint per client');
  } catch (error) { traceError = error; }

  const cleanupFailures: unknown[] = [];
  for (const result of await Promise.allSettled([...actors.values()].map(async (actor) => await actor.stop()))) {
    if (result.status === 'rejected') cleanupFailures.push(result.reason);
  }
  for (const actor of actors.values()) {
    try { actor.assertStopped(); } catch (error) { cleanupFailures.push(error); }
  }
  try { await stopCoordinatorByLock(paths.lockPath); } catch (error) { cleanupFailures.push(error); }
  try { await stopSpawnedChild(server); } catch (error) { cleanupFailures.push(error); }
  try { await stopTestCoordinatorsForStateRoot(stateRoot); } catch (error) { cleanupFailures.push(error); }
  if (cleanupFailures.length === 0) {
    try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
  } else cleanupFailures.push(new Error(`release-trace root retained because process cleanup was not proven: ${root}`));
  if (traceError !== null || cleanupFailures.length > 0) {
    throw new AggregateError([...(traceError === null ? [] : [traceError]), ...cleanupFailures], `${String(clientCount)}-client persistent release trace or cleanup failed`);
  }
}
