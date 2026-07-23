#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcessLite, type ChildProcessDataChunk } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

interface JsonObject { readonly [key: string]: unknown }
interface RuntimeResponse { readonly ok: boolean; readonly committed_event_seq: number | null; readonly error_code: string | null; readonly payload: Readonly<Record<string, unknown>> }
interface RuntimeClient {
  query(action: string, repoId?: string, workstreamRun?: string | null, payload?: Readonly<Record<string, unknown>>): Promise<RuntimeResponse>;
  mutate(action: string, identity: Readonly<Record<string, unknown>>, payload: Readonly<Record<string, unknown>>): Promise<RuntimeResponse>;
}
interface ClientConstructor { new(options: Readonly<Record<string, unknown>>): RuntimeClient }
interface SupervisorAttachment { readonly run: JsonObject; readonly session: JsonObject; readonly contextPath: string; readonly context: JsonObject }
interface RuntimeSupervisor { readonly client: RuntimeClient; attach(input: Readonly<Record<string, unknown>>): Promise<SupervisorAttachment>; attachTerminalRecovery(input: Readonly<Record<string, unknown>>): Promise<SupervisorAttachment> }
interface SupervisorConstructor { new(env: Readonly<Record<string, string | undefined>>, options?: Readonly<Record<string, unknown>>): RuntimeSupervisor }
interface RunRecord { readonly repo: JsonObject; readonly run: JsonObject; readonly resource: JsonObject; readonly active: JsonObject; readonly active_source: 'rebased-metadata' | 'durable-projection' }
interface I5ApprovalRecord { readonly run_key: string; readonly worktree_root: string; readonly approval: JsonObject }
interface WorkerDescriptor {
  readonly schema_version: 'autopilot.s1_corpus_incident_worker_input.v1';
  readonly rehearsal_id: string;
  readonly corpus_id: string;
  readonly scenario_id: string;
  readonly scenario_root: string;
  readonly repository_root: string;
  readonly base_state_root: string;
  readonly base_lock_path: string;
  readonly base_socket_path: string;
  readonly candidate: Readonly<Record<string, string>>;
  readonly cf50: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly states: Readonly<Record<string, string>>;
  readonly lock_paths: Readonly<Record<string, string>>;
  readonly socket_paths: Readonly<Record<string, string>>;
  readonly enabled_incidents: readonly ('I1' | 'I2' | 'I3' | 'I4' | 'I5')[];
  readonly runs: readonly RunRecord[];
  readonly i2: Readonly<Record<string, unknown>>;
  readonly i3: Readonly<Record<string, unknown>>;
  readonly i4: Readonly<Record<string, unknown>>;
  readonly i5: { readonly approvals: readonly I5ApprovalRecord[]; readonly before_registrations: readonly JsonObject[]; readonly expected_after_registrations: readonly JsonObject[]; readonly preserved_refs: readonly JsonObject[] };
  readonly current_pointer_path: string;
  readonly output_path: string;
}

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const coordinatorChildren = new Set<ChildProcessLite>();

function spawnCoordinator(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): ChildProcessLite {
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
  coordinatorChildren.add(child);
  child.once('close', () => coordinatorChildren.delete(child));
  return child;
}

function record(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

async function readStableCloneFile(path: string, maximumBytes: number, label: string): Promise<Uint8Array> {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes) throw new Error(`${label} is not a bounded single-link physical file`);
  const bytes = await readFile(path);
  const after = lstatSync(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== 1 || bytes.byteLength !== before.size) throw new Error(`${label} changed during its bounded read`);
  return bytes;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) throw new Error(`${label} must be nonempty text`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function exactFields(row: JsonObject, fields: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has an unknown or missing field`);
}

function stringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  const row = record(value, label);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(row)) output[key] = text(entry, `${label}.${key}`);
  return Object.freeze(output);
}

function parseWorkerDescriptor(value: unknown): WorkerDescriptor {
  const row = record(value, 'incident worker input');
  exactFields(row, ['schema_version', 'rehearsal_id', 'corpus_id', 'scenario_id', 'scenario_root', 'repository_root', 'base_state_root', 'base_lock_path', 'base_socket_path', 'candidate', 'cf50', 'environment', 'states', 'lock_paths', 'socket_paths', 'enabled_incidents', 'runs', 'i2', 'i3', 'i4', 'i5', 'current_pointer_path', 'output_path'], 'incident worker input');
  if (row['schema_version'] !== 'autopilot.s1_corpus_incident_worker_input.v1') throw new Error('C5 incident worker input schema is invalid');
  const scenarioRoot = resolve(text(row['scenario_root'], 'scenario root'));
  const containedPath = (entry: unknown, label: string): string => {
    const path = resolve(text(entry, label));
    const rel = relative(scenarioRoot, path);
    if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} escapes scenario authority`);
    return path;
  };
  const candidate = stringMap(row['candidate'], 'candidate release');
  const cf50 = stringMap(row['cf50'], 'cf50 release');
  for (const [label, paths] of [['candidate release', candidate], ['cf50 release', cf50]] as const) for (const [key, path] of Object.entries(paths)) if (key.endsWith('_path') || key === 'package_root') containedPath(path, `${label}.${key}`);
  const statesRaw = stringMap(row['states'], 'incident states');
  const states = Object.freeze(Object.fromEntries(Object.entries(statesRaw).map(([key, path]) => [key, containedPath(path, `incident state ${key}`)])));
  const lockPathsRaw = stringMap(row['lock_paths'], 'incident lock paths');
  const lockPaths = Object.freeze(Object.fromEntries(Object.entries(lockPathsRaw).map(([key, path]) => [key, containedPath(path, `incident lock path ${key}`)])));
  const socketPathsRaw = stringMap(row['socket_paths'], 'incident socket paths');
  const socketPaths = Object.freeze(Object.fromEntries(Object.entries(socketPathsRaw).map(([key, path]) => [key, containedPath(path, `incident socket path ${key}`)])));
  const stateKeys = canonical(Object.keys(states).sort());
  if (stateKeys !== canonical(Object.keys(lockPaths).sort()) || stateKeys !== canonical(Object.keys(socketPaths).sort())) throw new Error('incident state, lock, and socket path keys disagree');
  if (!Array.isArray(row['enabled_incidents']) || !row['enabled_incidents'].every((entry) => entry === 'I1' || entry === 'I2' || entry === 'I3' || entry === 'I4' || entry === 'I5') || new Set(row['enabled_incidents']).size !== row['enabled_incidents'].length) throw new Error('enabled incident set is malformed');
  const enabledIncidents = row['enabled_incidents'] as readonly ('I1' | 'I2' | 'I3' | 'I4' | 'I5')[];
  if (!Array.isArray(row['runs'])) throw new Error('incident runs must be an array');
  const runs = row['runs'].map((entry, index): RunRecord => {
    const run = record(entry, `incident run ${String(index)}`);
    exactFields(run, ['repo', 'run', 'resource', 'active', 'active_source'], `incident run ${String(index)}`);
    if (run['active_source'] !== 'rebased-metadata' && run['active_source'] !== 'durable-projection') throw new Error('incident active source is malformed');
    const active = record(run['active'], 'incident active row');
    return Object.freeze({ repo: record(run['repo'], 'incident repo'), run: record(run['run'], 'incident durable run'), resource: record(run['resource'], 'incident run resource'), active: Object.freeze({ ...active, pid: process.pid, boot_id: 'c5-sandbox-worker' }), active_source: run['active_source'] });
  });
  const i5 = record(row['i5'], 'I5 descriptor');
  exactFields(i5, ['approvals', 'before_registrations', 'expected_after_registrations', 'preserved_refs'], 'I5 descriptor');
  if (!Array.isArray(i5['approvals']) || !Array.isArray(i5['before_registrations']) || !Array.isArray(i5['expected_after_registrations']) || !Array.isArray(i5['preserved_refs'])) throw new Error('I5 descriptor arrays are malformed');
  const approvals = i5['approvals'].map((entry, index): I5ApprovalRecord => {
    const approval = record(entry, `I5 approval ${String(index)}`);
    exactFields(approval, ['run_key', 'worktree_root', 'approval'], `I5 approval ${String(index)}`);
    const approvalValue = record(approval['approval'], 'I5 approval value');
    const recoveryEvidencePath = containedPath(approvalValue['recovery_evidence_path'], 'I5 recovery evidence path');
    return Object.freeze({ run_key: text(approval['run_key'], 'I5 approval run key'), worktree_root: containedPath(approval['worktree_root'], 'I5 worktree root'), approval: Object.freeze({ ...approvalValue, recovery_evidence_path: recoveryEvidencePath }) });
  });
  return Object.freeze({ schema_version: 'autopilot.s1_corpus_incident_worker_input.v1', rehearsal_id: text(row['rehearsal_id'], 'rehearsal ID'), corpus_id: text(row['corpus_id'], 'corpus ID'), scenario_id: text(row['scenario_id'], 'scenario ID'), scenario_root: scenarioRoot, repository_root: containedPath(row['repository_root'], 'repository root'), base_state_root: containedPath(row['base_state_root'], 'base state root'), base_lock_path: containedPath(row['base_lock_path'], 'base lock path'), base_socket_path: containedPath(row['base_socket_path'], 'base socket path'), candidate, cf50, environment: stringMap(row['environment'], 'clone environment'), states, lock_paths: lockPaths, socket_paths: socketPaths, enabled_incidents: Object.freeze([...enabledIncidents]), runs: Object.freeze(runs), i2: record(row['i2'], 'I2 descriptor'), i3: record(row['i3'], 'I3 descriptor'), i4: record(row['i4'], 'I4 descriptor'), i5: Object.freeze({ approvals: Object.freeze(approvals), before_registrations: Object.freeze(i5['before_registrations'].map((entry) => record(entry, 'I5 before registration'))), expected_after_registrations: Object.freeze(i5['expected_after_registrations'].map((entry) => record(entry, 'I5 expected registration'))), preserved_refs: Object.freeze(i5['preserved_refs'].map((entry) => record(entry, 'I5 preserved ref'))) }), current_pointer_path: containedPath(row['current_pointer_path'], 'current pointer path'), output_path: containedPath(row['output_path'], 'worker output path') });
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = record(value, 'canonical JSON value');
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function digest(value: unknown): `sha256:${string}` {
  const bytes = typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function constructorFrom(module: JsonObject, field: string, label: string): ClientConstructor {
  const value = module[field];
  if (typeof value !== 'function' || typeof Reflect.get(value, 'prototype') !== 'object') throw new Error(`${label} omits ${field}`);
  return value as ClientConstructor;
}

function supervisorConstructorFrom(module: JsonObject): SupervisorConstructor {
  const value = module['DurableRunSupervisorClient'];
  if (typeof value !== 'function' || typeof Reflect.get(value, 'prototype') !== 'object') throw new Error('candidate supervisor module omits DurableRunSupervisorClient');
  return value as SupervisorConstructor;
}

async function loadModule(path: string): Promise<JsonObject> {
  return record(await import(pathToFileURL(path).href), 'installed release module');
}

function stateEnvironment(base: Readonly<Record<string, string>>, stateRoot: string): Readonly<Record<string, string>> {
  return Object.freeze({ ...base, AUTOPILOT_STATE_ROOT: stateRoot });
}

async function wait(milliseconds: number): Promise<void> { await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)); }

async function stopChild(child: ChildProcessLite): Promise<void> {
  if (child.exitCode !== null) return;
  let closed = false;
  const closePromise = new Promise<void>((resolveClose) => child.once('close', () => { closed = true; resolveClose(); }));
  child.kill('SIGTERM');
  const gracefulDeadline = Date.now() + 30_000;
  while (!closed && child.exitCode === null && Date.now() < gracefulDeadline) await wait(25);
  if (!closed && child.exitCode === null) child.kill('SIGKILL');
  const reapedDeadline = Date.now() + 10_000;
  while (!closed && child.exitCode === null && Date.now() < reapedDeadline) await Promise.race([closePromise, wait(25)]);
  if (!closed && child.exitCode === null) throw new Error('C5 coordinator did not stop/reap within the bounded shutdown window');
  await Promise.race([closePromise, wait(0)]);
}

async function stopAllCoordinators(): Promise<void> {
  const failures: Error[] = [];
  for (const child of [...coordinatorChildren]) {
    try { await stopChild(child); }
    catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if ([...coordinatorChildren].some((child) => child.exitCode === null)) failures.push(new Error('C5 worker retained a live coordinator child after bounded cleanup'));
  if (failures.length > 0) throw new AggregateError(failures, 'C5 worker coordinator cleanup failed');
}

async function startCoordinator(input: { readonly cli: string; readonly package_root: string; readonly state_root: string; readonly env: Readonly<Record<string, string>>; readonly Client: ClientConstructor }): Promise<{ readonly child: ChildProcessLite; readonly client: RuntimeClient; readonly close: () => Promise<void> }> {
  const env = stateEnvironment(input.env, input.state_root);
  const child = spawnCoordinator(process.execPath, [input.cli, 'serve', '--state-root', input.state_root], input.package_root, env);
  let diagnosticBytes = 0;
  child.stderr?.on('data', (chunk: ChildProcessDataChunk) => { diagnosticBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength; });
  const client = new input.Client({ env, autoStart: false, startupTimeoutMs: 30_000, readinessTimeoutMs: 60_000 });
  const deadline = Date.now() + 90_000;
  let lastReadinessError = 'none';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`C5 coordinator exited before readiness with code ${String(child.exitCode)} and ${String(diagnosticBytes)} diagnostic bytes`);
    try { const response = await client.query('handshake'); if (response.ok) return Object.freeze({ child, client, close: async () => await stopChild(child) }); lastReadinessError = response.error_code ?? 'handshake-not-ok'; }
    catch (error) { lastReadinessError = error instanceof Error ? error.message : String(error); }
    await wait(50);
  }
  await stopChild(child);
  throw new Error(`C5 coordinator did not become ready within the bounded startup window; last_error_sha256=${digest(lastReadinessError)}`);
}

async function expectStartupFailure(input: { readonly cli: string; readonly package_root: string; readonly state_root: string; readonly env: Readonly<Record<string, string>>; readonly expected_diagnostic: RegExp }): Promise<Readonly<Record<string, unknown>>> {
  const child = spawnCoordinator(process.execPath, [input.cli, 'serve', '--state-root', input.state_root], input.package_root, stateEnvironment(input.env, input.state_root));
  let bytes = 0;
  let diagnostic = '';
  child.stderr?.on('data', (chunk: ChildProcessDataChunk) => { const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); bytes += Buffer.byteLength(value); if (diagnostic.length < MAX_DIAGNOSTIC_BYTES) diagnostic += value.slice(0, MAX_DIAGNOSTIC_BYTES - diagnostic.length); });
  const deadline = Date.now() + 90_000;
  while (child.exitCode === null && Date.now() < deadline) await wait(50);
  if (child.exitCode === null) { await stopChild(child); throw new Error('C5 fatal-negative coordinator remained live'); }
  if (child.exitCode === 0) throw new Error('C5 fatal-negative coordinator exited successfully');
  if (!input.expected_diagnostic.test(diagnostic)) throw new Error('C5 fatal-negative coordinator failed without the exact expected diagnostic class');
  return Object.freeze({ exit_code: child.exitCode, diagnostic_bytes: bytes, diagnostic_sha256: digest(diagnostic) });
}

function token(label: string): string { return createHash('sha256').update(label).digest('hex'); }

function runPayload(root: string, prefix: string): Readonly<Record<string, unknown>> {
  const repoRoot = `${root}/i1/${prefix}/repository`;
  const worktreeRoot = `${root}/i1/${prefix}/worktrees`;
  const main = `${worktreeRoot}/active/${prefix}-run/main`;
  return Object.freeze({ repo_key: `${prefix}-repo`, canonical_root: repoRoot, git_common_dir: `${repoRoot}/.git`, autopilot_id: `${prefix}-autopilot`, workstream: `${prefix}-work`, coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: `${prefix}-repo`, workstream_run: `${prefix}-run`, source_repo: repoRoot, git_common_dir: `${repoRoot}/.git`, worktree_root: worktreeRoot, main_worktree_path: main, runtime_root: `${main}/.pi/autopilot/${prefix}-work`, branch: `autopilot/${prefix}-run`, target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-16T00:00:00.000Z', version: 1 } });
}

interface I1Journey { readonly client: RuntimeClient; readonly identity: Readonly<Record<string, unknown>>; readonly payload: Readonly<Record<string, unknown>>; readonly first: RuntimeResponse; readonly evidence: Readonly<Record<string, unknown>> }

async function attachAndHeartbeat(client: RuntimeClient, root: string, prefix: string): Promise<I1Journey> {
  const repoId = `${prefix}-repo`;
  const run = `${prefix}-run`;
  const sessionId = `${prefix}-session`;
  const leaseId = `${prefix}-lease`;
  const sessionToken = token(prefix);
  const attached = await client.mutate('attach-run', { repoId, workstreamRun: run, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `${prefix}-attach-run` }, runPayload(root, prefix));
  const runValue = record(attached.payload['run'], 'I1 attached run');
  const sessionResponse = await client.mutate('attach-session', { repoId, workstreamRun: run, sessionId, fencingGeneration: 1, expectedVersion: integer(runValue['version'], 'I1 run version'), idempotencyKey: `${prefix}-attach-session` }, { session_lease_id: leaseId, session_token: sessionToken, pid: process.pid, boot_id: `${prefix}-boot`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
  const session = record(sessionResponse.payload['session'], 'I1 attached session');
  const identity = { repoId, workstreamRun: run, sessionId, fencingGeneration: 1, expectedVersion: integer(session['version'], 'I1 session version'), idempotencyKey: `${prefix}-heartbeat` };
  const payload = { session_lease_id: leaseId, session_token: sessionToken, lease_expires_at: '2099-01-02T00:00:00.000Z' };
  const first = await client.mutate('heartbeat', identity, payload);
  const replay = await client.mutate('heartbeat', identity, payload);
  if (first.committed_event_seq !== replay.committed_event_seq || canonical(first.payload) !== canonical(replay.payload)) throw new Error('C5 I1 heartbeat replay is not exact');
  return Object.freeze({ client, identity, payload, first, evidence: Object.freeze({ committed_event_seq: first.committed_event_seq, response_sha256: digest(first.payload) }) });
}

async function assertJourneyReplay(journey: I1Journey): Promise<void> {
  const replay = await journey.client.mutate('heartbeat', journey.identity, journey.payload);
  if (replay.committed_event_seq !== journey.first.committed_event_seq || canonical(replay.payload) !== canonical(journey.first.payload)) throw new Error('C5 I1 restart replay is not exact');
}

function assertLegacyHandshake(response: RuntimeResponse): void {
  if (!response.ok || response.payload['schema_version'] !== 'autopilot.coordinator_handshake.v1' || response.payload['package_build'] !== '1.1.8-cf50' || response.payload['protocol_version'] !== '1.6' || response.payload['database_schema_version'] !== 12) throw new Error('C5 I1 peer did not preserve the exact cf50 handshake façade');
}

async function runI1(input: WorkerDescriptor, CandidateClient: ClientConstructor, Cf50Client: ClientConstructor): Promise<Readonly<Record<string, unknown>>> {
  const evidence: Readonly<Record<string, unknown>>[] = [];
  const candidateCli = text(input.candidate['coordinator_cli_path'], 'candidate CLI');
  const candidatePackage = text(input.candidate['package_root'], 'candidate package root');
  const cf50Cli = text(input.cf50['coordinator_cli_path'], 'cf50 CLI');
  const cf50Package = text(input.cf50['package_root'], 'cf50 package root');
  const candidateState = text(input.states['i1-cf50-to-s1'], 'I1 cf50-to-S1 state');
  let server: Awaited<ReturnType<typeof startCoordinator>> | null = null;
  try {
    server = await startCoordinator({ cli: candidateCli, package_root: candidatePackage, state_root: candidateState, env: input.environment, Client: CandidateClient });
    const oldClient = new Cf50Client({ env: stateEnvironment(input.environment, candidateState), autoStart: false });
    assertLegacyHandshake(await oldClient.query('handshake'));
    const firstDirection = await attachAndHeartbeat(oldClient, input.scenario_root, 'c5-old-to-s1');
    const candidateLockPath = text(input.lock_paths['i1-cf50-to-s1'], 'I1 candidate lock path');
    const candidateLockBefore = record(JSON.parse(await readFile(candidateLockPath, 'utf8')) as unknown, 'candidate lock before restart');
    await server.close(); server = null;
    server = await startCoordinator({ cli: candidateCli, package_root: candidatePackage, state_root: candidateState, env: input.environment, Client: CandidateClient });
    assertLegacyHandshake(await oldClient.query('handshake'));
    const candidateLockAfter = record(JSON.parse(await readFile(candidateLockPath, 'utf8')) as unknown, 'candidate lock after restart');
    if (candidateLockBefore['instance_id'] === candidateLockAfter['instance_id']) throw new Error('C5 S1 natural restart reused endpoint instance identity');
    await assertJourneyReplay(firstDirection);
    evidence.push(Object.freeze({ direction: 'cf50-client-to-s1', journey: firstDirection.evidence }));
  } finally { if (server !== null) await server.close(); }

  const cfState = text(input.states['i1-s1-to-cf50'], 'I1 S1-to-cf50 state');
  let oldServer: Awaited<ReturnType<typeof startCoordinator>> | null = null;
  try {
    oldServer = await startCoordinator({ cli: cf50Cli, package_root: cf50Package, state_root: cfState, env: input.environment, Client: Cf50Client });
    const newClient = new CandidateClient({ env: stateEnvironment(input.environment, cfState), autoStart: false });
    assertLegacyHandshake(await newClient.query('handshake'));
    const secondDirection = await attachAndHeartbeat(newClient, input.scenario_root, 'c5-s1-to-old');
    const cfLockPath = text(input.lock_paths['i1-s1-to-cf50'], 'I1 cf50 lock path');
    const cfLockBefore = record(JSON.parse(await readFile(cfLockPath, 'utf8')) as unknown, 'cf50 lock before restart');
    await oldServer.close(); oldServer = null;
    oldServer = await startCoordinator({ cli: cf50Cli, package_root: cf50Package, state_root: cfState, env: input.environment, Client: Cf50Client });
    assertLegacyHandshake(await newClient.query('handshake'));
    const cfLockAfter = record(JSON.parse(await readFile(cfLockPath, 'utf8')) as unknown, 'cf50 lock after restart');
    if (cfLockBefore['instance_id'] === cfLockAfter['instance_id']) throw new Error('C5 cf50 natural restart reused endpoint instance identity');
    await assertJourneyReplay(secondDirection);
    evidence.push(Object.freeze({ direction: 's1-client-to-cf50', journey: secondDirection.evidence }));
  } finally { if (oldServer !== null) await oldServer.close(); }

  const mixedState = text(input.states['i1-mixed-election'], 'I1 mixed state');
  const mixedEnv = stateEnvironment(input.environment, mixedState);
  const electionChildren = [spawnCoordinator(process.execPath, [cf50Cli, 'serve', '--state-root', mixedState], cf50Package, mixedEnv), spawnCoordinator(process.execPath, [candidateCli, 'serve', '--state-root', mixedState], candidatePackage, mixedEnv)];
  for (const child of electionChildren) child.stderr?.on('data', () => { /* bounded process lifecycle is asserted through exit state and handshake */ });
  try {
    const oldPeer = new Cf50Client({ env: mixedEnv, autoStart: false, readinessTimeoutMs: 60_000 });
    const newPeer = new CandidateClient({ env: mixedEnv, autoStart: false, readinessTimeoutMs: 60_000 });
    const handshake = async (client: RuntimeClient): Promise<RuntimeResponse> => {
      const deadline = Date.now() + 90_000;
      let lastError = 'none';
      while (Date.now() < deadline) { try { const response = await client.query('handshake'); if (response.ok) return response; lastError = response.error_code ?? 'handshake-not-ok'; } catch (error) { lastError = error instanceof Error ? error.message : String(error); } await wait(50); }
      throw new Error(`C5 mixed election did not converge within the bounded window; last_error_sha256=${digest(lastError)}`);
    };
    const handshakes = await Promise.all([handshake(oldPeer), handshake(newPeer)]);
    handshakes.forEach(assertLegacyHandshake);
    await Promise.all([attachAndHeartbeat(oldPeer, input.scenario_root, 'c5-mixed-old'), attachAndHeartbeat(newPeer, input.scenario_root, 'c5-mixed-new')]);
    const lock = record(JSON.parse(await readFile(text(input.lock_paths['i1-mixed-election'], 'I1 mixed lock path'), 'utf8')) as unknown, 'mixed lifecycle lock');
    if (lock['package_build'] !== '1.1.8-cf50' && lock['package_build'] !== '1.2.0-s1') throw new Error('C5 mixed election published an unknown winner build');
    const winnerPid = integer(lock['pid'], 'mixed winner pid');
    for (let index = 0; index < 1200 && electionChildren.filter((child) => child.exitCode === null).length !== 1; index += 1) await wait(25);
    if (!electionChildren.some((child) => child.pid === winnerPid) || electionChildren.filter((child) => child.exitCode === null).length !== 1) throw new Error('C5 mixed election did not converge on exactly one tracked winner');
    evidence.push(Object.freeze({ direction: 'mixed-election', winner_build: lock['package_build'], handshake_sha256: digest(handshakes) }));
  } finally { for (const child of electionChildren) await stopChild(child); }
  return Object.freeze({ passed: true, evidence_sha256: digest(evidence) });
}

function runKey(recordValue: RunRecord): string { return `${text(recordValue.run['repo_id'], 'run repo')}\u0000${text(recordValue.run['workstream_run'], 'run id')}`; }
function runIdentityDigest(repoId: string, runId: string): `sha256:${string}` { return digest(`${repoId}\u0000${runId}`); }

async function preflightIncidentAuthority(input: WorkerDescriptor, client: RuntimeClient): Promise<void> {
  const global = await client.query('status');
  if (integer(global.payload['pending_migration_recovery_count'], 'C5 pending migration recovery count') !== 0) throw new Error('C5 candidate migration produced pending recovery authority; incident rehearsal cannot attach ordinary sessions');
  const authorityRequired = new Set<string>([
    ...input.i5.approvals.map((entry) => entry.run_key),
    ...(typeof input.i2['run_key'] === 'string' ? [input.i2['run_key']] : []),
    ...(Array.isArray(input.i3['run_keys']) ? input.i3['run_keys'].filter((entry): entry is string => typeof entry === 'string') : []),
  ]);
  const expectedAliases = new Set(Array.isArray(input.i3['alias_ids']) ? input.i3['alias_ids'].map((value) => text(value, 'C5 I3 preflight alias ID')) : []);
  const projectedAliases = new Set<string>();
  for (const runRecord of input.runs) {
    const repoId = text(runRecord.run['repo_id'], 'C5 preflight repo ID');
    const runId = text(runRecord.run['workstream_run'], 'C5 preflight run ID');
    const status = text(runRecord.run['status'], 'C5 preflight run status');
    const projection = await client.query('status', repoId, runId);
    if ((status === 'closed' || status === 'aborted') && authorityRequired.has(runKey(runRecord))) {
      const intents = projection.payload['run_terminal_intents'];
      if (!Array.isArray(intents)) throw new Error('C5 terminal authority preflight omitted run terminal intents');
      const committed = intents.map((value) => record(value, 'C5 terminal intent')).filter((intent) => intent['state'] === 'committed' && intent['outcome'] === status);
      if (committed.length !== 1) throw new Error('C5 terminal incident authority requires exactly one matching committed terminal intent');
    }
    const aliases = projection.payload['negotiated_worktree_aliases'];
    if (!Array.isArray(aliases)) throw new Error('C5 candidate omitted the admitted canonical alias projection');
    for (const value of aliases) projectedAliases.add(text(record(value, 'C5 preflight alias projection')['alias_worktree_id'], 'C5 preflight projected alias ID'));
  }
  if (expectedAliases.size > 0 && (projectedAliases.size !== expectedAliases.size || [...expectedAliases].some((alias) => !projectedAliases.has(alias)))) throw new Error('C5 candidate migration alias projection differs from the exact measured 46-twin set');
}

async function attachDurableRuns(input: WorkerDescriptor, supervisor: RuntimeSupervisor): Promise<{ readonly attachments: ReadonlyMap<string, SupervisorAttachment>; readonly results: readonly JsonObject[]; readonly reconciliations: readonly JsonObject[] }> {
  const attachments = new Map<string, SupervisorAttachment>();
  const results: JsonObject[] = [];
  const reconciliations: JsonObject[] = [];
  const authorityRequired = new Set<string>([
    ...input.i5.approvals.map((entry) => entry.run_key),
    ...(typeof input.i2['run_key'] === 'string' ? [input.i2['run_key']] : []),
    ...(Array.isArray(input.i3['run_keys']) ? input.i3['run_keys'].filter((entry): entry is string => typeof entry === 'string') : []),
  ]);
  for (const runRecord of input.runs) {
    const repoId = text(runRecord.run['repo_id'], 'durable run repo');
    const runId = text(runRecord.run['workstream_run'], 'durable run ID');
    const status = text(runRecord.run['status'], 'durable run status');
    const key = runKey(runRecord);
    if ((status === 'closed' || status === 'aborted') && !authorityRequired.has(key)) {
      const response = await supervisor.client.query('status', repoId, runId);
      results.push({ corpus_id: input.corpus_id, scenario_id: input.scenario_id, repo_id_sha256: digest(repoId), run_id_sha256: runIdentityDigest(repoId, runId), attachment_kind: 'terminal-query-only', outcome: response.ok ? 'passed' : 'failed', committed_event_seq: null, diagnostic_codes: runRecord.active_source === 'durable-projection' ? ['durable-projection-active'] : [] });
      reconciliations.push({ corpus_id: input.corpus_id, scenario_id: input.scenario_id, run_id_sha256: runIdentityDigest(repoId, runId), consumer: 'run-reconcile', before_sha256: digest(response.payload), after_sha256: digest(response.payload), replayed: false, outcome: 'expected-blocked', diagnostic_codes: ['terminal-query-only'] });
      continue;
    }
    const terminalRecovery = status === 'closed' || status === 'aborted';
    const attachment = terminalRecovery
      ? await supervisor.attachTerminalRecovery({ repo: runRecord.repo, active: runRecord.active, rawSessionId: `c5-terminal-${digest(key).slice(7, 23)}` })
      : await supervisor.attach({ repo: runRecord.repo, active: runRecord.active, rawSessionId: `c5-${digest(key).slice(7, 23)}`, handoffToken: null });
    attachments.set(key, attachment);
    const context = attachment.context;
    const heartbeatIdentity = { repoId, workstreamRun: runId, sessionId: context['session_id'], fencingGeneration: context['session_generation'], expectedVersion: attachment.session['version'], idempotencyKey: `c5-heartbeat-${digest(key).slice(7)}` };
    const heartbeatPayload = { session_lease_id: context['session_lease_id'], session_token: context['session_token'], lease_expires_at: '2099-01-02T00:00:00.000Z' };
    const heartbeat = await supervisor.client.mutate('heartbeat', heartbeatIdentity, heartbeatPayload);
    const replay = await supervisor.client.mutate('heartbeat', heartbeatIdentity, heartbeatPayload);
    if (heartbeat.committed_event_seq !== replay.committed_event_seq || canonical(heartbeat.payload) !== canonical(replay.payload)) throw new Error('C5 durable run heartbeat replay is not exact');
    results.push({ corpus_id: input.corpus_id, scenario_id: input.scenario_id, repo_id_sha256: digest(repoId), run_id_sha256: runIdentityDigest(repoId, runId), attachment_kind: terminalRecovery ? 'terminal-recovery' : 'dispatch', outcome: 'passed', committed_event_seq: heartbeat.committed_event_seq, diagnostic_codes: runRecord.active_source === 'durable-projection' ? ['durable-projection-active'] : [] });
    const before = await supervisor.client.query('status', repoId, runId);
    try {
      const reconciled = await supervisor.client.mutate('reconcile-run', { repoId, workstreamRun: runId, sessionId: attachment.context['session_id'], fencingGeneration: attachment.context['session_generation'], expectedVersion: attachment.context['run_version'], idempotencyKey: `c5-reconcile-${digest(key).slice(7)}` }, { reason: 'C5 per-durable-run production reconciliation', session_lease_id: attachment.context['session_lease_id'], session_token: attachment.context['session_token'] });
      reconciliations.push({ corpus_id: input.corpus_id, scenario_id: input.scenario_id, run_id_sha256: runIdentityDigest(repoId, runId), consumer: 'run-reconcile', before_sha256: digest(before.payload), after_sha256: digest(reconciled.payload), replayed: false, outcome: 'passed', diagnostic_codes: [] });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'recovery-required')) throw error;
      reconciliations.push({ corpus_id: input.corpus_id, scenario_id: input.scenario_id, run_id_sha256: runIdentityDigest(repoId, runId), consumer: 'run-reconcile', before_sha256: digest(before.payload), after_sha256: digest(before.payload), replayed: false, outcome: 'expected-blocked', diagnostic_codes: ['scoped-recovery-required'] });
    }
  }
  return Object.freeze({ attachments, results: Object.freeze(results), reconciliations: Object.freeze(reconciliations) });
}

function sessionEnv(base: Readonly<Record<string, string>>, attachment: SupervisorAttachment): Readonly<Record<string, string>> {
  return Object.freeze({ ...base, AUTOPILOT_COORDINATOR_SESSION_CONTEXT: attachment.contextPath });
}

async function runI2(input: WorkerDescriptor, modules: JsonObject, attachments: ReadonlyMap<string, SupervisorAttachment>): Promise<{ readonly result: JsonObject; readonly reconciliation: JsonObject }> {
  const runKeyValue = text(input.i2['run_key'], 'I2 run key');
  const attachment = attachments.get(runKeyValue);
  if (attachment === undefined) throw new Error('C5 I2 run has no production supervisor attachment');
  const recover = modules['recoverOwnedWorktreeSagas'];
  if (typeof recover !== 'function') throw new Error('candidate worktree saga module omits recovery consumer');
  const repoId = text(attachment.context['repo_id'], 'I2 repo');
  const runId = text(attachment.context['workstream_run'], 'I2 run');
  const historicalLeaseIds = new Set(Array.isArray(input.i2['historical_lease_ids']) ? input.i2['historical_lease_ids'].map((value) => text(value, 'I2 lease ID')) : []);
  if (historicalLeaseIds.size !== 42) throw new Error('C5 I2 descriptor does not contain the exact historical 42-lease set');
  const statusClient = new (constructorFrom(await loadModule(text(input.candidate['client_module_path'], 'candidate client module')), 'CoordinatorClient', 'candidate client module'))({ env: input.environment, autoStart: false });
  const beforeStatus = await statusClient.query('status', repoId, runId);
  const beforeLeases = beforeStatus.payload['edit_leases'];
  if (!Array.isArray(beforeLeases) || [...historicalLeaseIds].some((id) => !beforeLeases.some((value) => text(record(value, 'I2 before lease')['edit_lease_id'], 'I2 before lease ID') === id))) throw new Error('C5 I2 released historical WRITE authority before exact commit/parent/path proof');
  const runRecord = input.runs.find((entry) => runKey(entry) === runKeyValue);
  if (runRecord === undefined) throw new Error('C5 I2 durable active row disappeared');
  const active = runRecord.active;
  const env = sessionEnv(input.environment, attachment);
  const branchRef = text(input.i2['branch_ref'], 'I2 capture branch ref');
  const captureSha = text(input.i2['capture_sha'], 'I2 capture SHA');
  if (!branchRef.startsWith('refs/heads/')) throw new Error('C5 I2 capture branch is outside owned heads authority');
  const refsBeforeWithheld = gitRefs(input.repository_root);
  const worktreePath = resolve(text(input.i2['worktree_path'], 'I2 worktree path'));
  const worktreeRel = relative(input.scenario_root, worktreePath);
  if (worktreeRel === '' || isAbsolute(worktreeRel) || worktreeRel === '..' || worktreeRel.startsWith(`..${sep}`) || worktreePath === input.repository_root) throw new Error('C5 I2 proof-withheld worktree escapes isolated unit authority');
  const withheldWorktreePath = `${worktreePath}.c5-proof-withheld`;
  if (existsSync(withheldWorktreePath)) throw new Error('C5 I2 proof-withheld temporary worktree path already exists');
  const movedWorktree = existsSync(worktreePath);
  if (movedWorktree) await rename(worktreePath, withheldWorktreePath);
  let withheldBlocked = false;
  let refDeleted = false;
  try {
    mutateCloneGitRef(input.repository_root, ['update-ref', '-d', branchRef, captureSha]);
    refDeleted = true;
    try { await recover({ active, env }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'recovery-required')) throw error; withheldBlocked = true; }
  } finally {
    let restorationError: unknown = null;
    try { if (refDeleted) mutateCloneGitRef(input.repository_root, ['update-ref', branchRef, captureSha, '0'.repeat(40)]); } catch (error) { restorationError = error; }
    try { if (movedWorktree) await rename(withheldWorktreePath, worktreePath); } catch (error) { restorationError = restorationError === null ? error : new AggregateError([restorationError, error], 'C5 I2 ref and worktree restoration both failed'); }
    if (restorationError !== null) throw restorationError;
  }
  if (!withheldBlocked || canonical(gitRefs(input.repository_root)) !== canonical(refsBeforeWithheld) || existsSync(withheldWorktreePath) || existsSync(worktreePath) !== movedWorktree) throw new Error('C5 I2 proof-withheld control did not fail closed and restore exact clone Git/worktree facts');
  const withheldStatus = await statusClient.query('status', repoId, runId);
  const withheldLeases = withheldStatus.payload['edit_leases'];
  if (!Array.isArray(withheldLeases) || [...historicalLeaseIds].some((id) => !withheldLeases.some((value) => text(record(value, 'I2 withheld lease')['edit_lease_id'], 'I2 withheld lease ID') === id))) throw new Error('C5 I2 proof-withheld control released historical WRITE authority');
  const first: unknown = await recover({ active, env });
  const replay: unknown = await recover({ active, env });
  if (!Array.isArray(first) || !Array.isArray(replay)) throw new Error('C5 I2 recovery consumer returned malformed operation evidence');
  if (replay.length !== 0) throw new Error('C5 I2 recovery replay was not an exact terminal no-op');
  const operationId = text(input.i2['operation_id'], 'I2 operation ID');
  const operation = first.map((value) => record(value, 'I2 recovered operation')).find((value) => value['operation_id'] === operationId);
  if (operation === undefined || operation['stage'] !== 'committed') throw new Error('C5 I2 operation did not terminalize from exact branch proof');
  const status = await statusClient.query('status', repoId, runId);
  const leases = status.payload['edit_leases'];
  if (!Array.isArray(leases)) throw new Error('C5 I2 status omitted edit leases');
  if (leases.some((value) => historicalLeaseIds.has(text(record(value, 'I2 lease')['edit_lease_id'], 'I2 remaining lease ID')))) throw new Error('C5 I2 retained historical WRITE authority after exact recovery');
  const evidence = { operation_id: operationId, proof_withheld_blocked: withheldBlocked, proof_withheld_lease_set_sha256: digest([...historicalLeaseIds].sort()), capture_sha: input.i2['capture_sha'], parent_sha: input.i2['parent_sha'], path_set_sha256: input.i2['path_set_sha256'], lease_set_sha256: digest([...historicalLeaseIds].sort()), operation_sha256: digest(operation), replay_sha256: digest(replay) };
  return Object.freeze({ result: { incident_id: 'I2', provenance: 'retained-actual', passed: true, assertion_ids: ['capture-exact', 'parent-exact', 'path-set-exact', 'no-release-before-proof', 'historical-lease-set-exact'], evidence_sha256: digest(evidence) }, reconciliation: { corpus_id: input.corpus_id, scenario_id: input.scenario_id, run_id_sha256: runIdentityDigest(repoId, runId), consumer: 'worktree-saga', before_sha256: digest(input.i2), after_sha256: digest(operation), replayed: true, outcome: 'passed', diagnostic_codes: [] } });
}

async function runI3(input: WorkerDescriptor, modules: JsonObject, client: RuntimeClient, attachments: ReadonlyMap<string, SupervisorAttachment>): Promise<{ readonly result: JsonObject; readonly reconciliation: readonly JsonObject[] }> {
  const resolveFault = modules['resolveCanonicalIdentityFault'];
  const prepareUnit = modules['prepareAutopilotUnitWorktree'];
  const recover = modules['recoverOwnedWorktreeSagas'];
  if (typeof resolveFault !== 'function' || typeof prepareUnit !== 'function' || typeof recover !== 'function') throw new Error('candidate I3 modules omit a production consumer');
  const runKeys = Array.isArray(input.i3['run_keys']) ? input.i3['run_keys'].map((value) => text(value, 'I3 run key')) : [];
  const aliasIds = new Set(Array.isArray(input.i3['alias_ids']) ? input.i3['alias_ids'].map((value) => text(value, 'I3 alias ID')) : []);
  if (aliasIds.size !== 46) throw new Error('C5 I3 descriptor omits the exact 46 historical aliases');
  const rows: JsonObject[] = [];
  const cleanupProofs: Readonly<Record<string, unknown>>[] = [];
  let classified = 0;
  let resolved = 0;
  let scopedRecovery = 0;
  for (const key of runKeys) {
    const attachment = attachments.get(key);
    if (attachment === undefined) throw new Error('C5 I3 run has no production supervisor attachment');
    const repoId = text(attachment.context['repo_id'], 'I3 repo');
    const runId = text(attachment.context['workstream_run'], 'I3 run');
    const before = await client.query('status', repoId, runId);
    const recovery = before.payload['negotiated_identity_recovery'];
    const aliases = before.payload['negotiated_worktree_aliases'];
    const worktrees = before.payload['worktrees'];
    if (!Array.isArray(recovery) || !Array.isArray(aliases) || !Array.isArray(worktrees)) throw new Error('C5 I3 status omitted negotiated alias/recovery/worktree projections');
    const canonicalIds = new Set(worktrees.map((value) => text(record(value, 'I3 worktree projection')['worktree_id'], 'I3 canonical worktree ID')));
    classified += aliases.map((value) => record(value, 'I3 alias projection')).filter((value) => typeof value['alias_worktree_id'] === 'string' && aliasIds.has(value['alias_worktree_id']) && typeof value['canonical_worktree_id'] === 'string' && canonicalIds.has(value['canonical_worktree_id'])).length;
    let runScopedRecovery = false;
    for (const value of recovery) {
      const projection = record(value, 'I3 recovery projection');
      const faultId = text(projection['fault_id'], 'I3 fault ID');
      try { const result: unknown = await resolveFault({ client, session: attachment.context, fault_id: faultId, env: input.environment }); if (record(result, 'I3 result')['replayed'] === false) resolved += 1; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'recovery-required')) throw error; scopedRecovery += 1; runScopedRecovery = true; }
    }
    const runRecord = input.runs.find((entry) => runKey(entry) === key);
    if (runRecord === undefined) throw new Error('C5 I3 durable active row disappeared');
    const cleanupEnv = sessionEnv(input.environment, attachment);
    if (runScopedRecovery) cleanupProofs.push(Object.freeze({ run_id_sha256: runIdentityDigest(repoId, runId), outcome: 'expected-fenced' }));
    else {
      const firstCleanup: unknown = await recover({ active: runRecord.active, env: cleanupEnv });
      const replayCleanup: unknown = await recover({ active: runRecord.active, env: cleanupEnv });
      if (!Array.isArray(firstCleanup) || !Array.isArray(replayCleanup) || replayCleanup.length !== 0) throw new Error('C5 I3 cleanup replay was not a bounded terminal no-op');
      cleanupProofs.push(Object.freeze({ run_id_sha256: runIdentityDigest(repoId, runId), outcome: 'replay-proven', first_sha256: digest(firstCleanup), replay_sha256: digest(replayCleanup) }));
    }
    const after = await client.query('status', repoId, runId);
    rows.push({ corpus_id: input.corpus_id, scenario_id: input.scenario_id, run_id_sha256: runIdentityDigest(repoId, runId), consumer: 'canonical-identity', before_sha256: digest(before.payload), after_sha256: digest(after.payload), replayed: false, outcome: 'passed', diagnostic_codes: [] });
  }
  if (classified !== 46) throw new Error(`C5 I3 classified ${String(classified)} rather than exactly 46 historical twins`);
  if (!cleanupProofs.some((proof) => proof['outcome'] === 'replay-proven')) throw new Error('C5 I3 produced no mechanically replayed cleanup proof');
  const safeRunKey = text(input.i3['safe_run_key'], 'I3 safe run key');
  const safeAttachment = attachments.get(safeRunKey);
  if (safeAttachment === undefined) throw new Error('C5 I3 safe-next-attempt run has no attachment');
  const safeStatus = await client.query('status', text(safeAttachment.context['repo_id'], 'I3 safe repo'), text(safeAttachment.context['workstream_run'], 'I3 safe run'));
  const safeFaults = safeStatus.payload['run_scoped_logical_faults'];
  if (!Array.isArray(safeFaults) || safeFaults.length !== 0) throw new Error('C5 I3 measured safe-next run remains scoped-faulted after identity recovery');
  const safeRunRecord = input.runs.find((entry) => runKey(entry) === safeRunKey);
  if (safeRunRecord === undefined) throw new Error('C5 I3 safe durable active row disappeared');
  const safeActive = safeRunRecord.active;
  const unitId = text(input.i3['safe_unit_id'], 'I3 safe unit');
  const attempt = integer(input.i3['safe_attempt'], 'I3 safe attempt');
  const safeEnv = sessionEnv(input.environment, safeAttachment);
  await client.mutate('register-attempt', { repoId: safeAttachment.context['repo_id'], workstreamRun: safeAttachment.context['workstream_run'], sessionId: safeAttachment.context['session_id'], fencingGeneration: safeAttachment.context['session_generation'], expectedVersion: safeAttachment.context['run_version'], idempotencyKey: `c5-i3-safe-attempt-${digest(`${unitId}\0${String(attempt)}`).slice(7)}` }, { unit_id: unitId, attempt, spec_ref: `c5-specs/${unitId}.json`, spec_sha256: digest({ unit_id: unitId, attempt, purpose: 'C5 safe next attempt proof' }), role: 'fix', preemptible: true, checkpoint_ordinal: 0, session_lease_id: safeAttachment.context['session_lease_id'], session_token: safeAttachment.context['session_token'] });
  const prepared: unknown = await prepareUnit({ active: safeActive, unitId, attempt, env: safeEnv });
  const preparedRow = record(prepared, 'I3 safe worktree result');
  if (preparedRow['created'] !== true) throw new Error('C5 I3 safe next attempt did not create new production worktree authority');
  return Object.freeze({ result: { incident_id: 'I3', provenance: 'retained-actual', passed: true, assertion_ids: ['twins-46-classified', 'aliases-or-scoped-recovery', 'cleanup-idempotent-replay', 'safe-next-attempt-created'], evidence_sha256: digest({ classified, resolved, scoped_recovery: scopedRecovery, cleanup_proofs: cleanupProofs, prepared: preparedRow }) }, reconciliation: Object.freeze(rows) });
}

function containsEventType(value: unknown, eventType: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsEventType(entry, eventType));
  if (typeof value !== 'object' || value === null) return false;
  const row = value as JsonObject;
  return row['event_type'] === eventType || Object.values(row).some((entry) => containsEventType(entry, eventType));
}

async function runI4(input: WorkerDescriptor, CandidateClient: ClientConstructor, Supervisor: SupervisorConstructor): Promise<Readonly<Record<string, unknown>>> {
  const cli = text(input.candidate['coordinator_cli_path'], 'candidate CLI');
  const packageRoot = text(input.candidate['package_root'], 'candidate package');
  const behindState = text(input.states['i4-counter-behind'], 'I4 behind state');
  let server = await startCoordinator({ cli, package_root: packageRoot, state_root: behindState, env: input.environment, Client: CandidateClient });
  const behindDoctor = await server.client.query('doctor');
  if (!behindDoctor.ok) throw new Error('C5 I4 counter-behind repair did not produce a healthy coordinator');
  const behindRepo = text(input.i4['faulted_run_key'], 'I4 faulted key').split('\u0000')[0];
  if (behindRepo === undefined) throw new Error('C5 I4 faulted key lost its repository');
  const repairExport = `${behindState}/c5-counter-behind-export.json`;
  await server.client.query('export', behindRepo, null, { output_path: repairExport });
  const repairEvidence: unknown = JSON.parse(await readFile(repairExport, 'utf8')) as unknown;
  if (!containsEventType(repairEvidence, 'store-invariant-repaired')) throw new Error('C5 I4 counter-behind repair omitted immutable audit evidence');
  await server.close();
  const ahead = await expectStartupFailure({ cli, package_root: packageRoot, state_root: text(input.states['i4-counter-ahead'], 'I4 ahead state'), env: input.environment, expected_diagnostic: /ahead of immutable event history/u });
  const ambiguous = await expectStartupFailure({ cli, package_root: packageRoot, state_root: text(input.states['i4-payload-owner-ambiguous'], 'I4 owner-ambiguous state'), env: input.environment, expected_diagnostic: /payload\/index ownership is ambiguous|payload.*owner.*ambiguous/iu });
  const physical = await expectStartupFailure({ cli, package_root: packageRoot, state_root: text(input.states['i4-physical-integrity'], 'I4 physical state'), env: input.environment, expected_diagnostic: /(?:integrity|malformed|corrupt)/iu });

  const logicalState = text(input.states['i4-scoped-logical-row-fault'], 'I4 scoped logical state');
  server = await startCoordinator({ cli, package_root: packageRoot, state_root: logicalState, env: input.environment, Client: CandidateClient });
  const logicalEnv = stateEnvironment(input.environment, logicalState);
  const supervisor = new Supervisor(logicalEnv);
  const faultedKey = text(input.i4['faulted_run_key'], 'I4 faulted key');
  const healthyKey = text(input.i4['healthy_run_key'], 'I4 healthy key');
  const faultedRecord = input.runs.find((value) => runKey(value) === faultedKey);
  const healthyRecord = input.runs.find((value) => runKey(value) === healthyKey);
  if (faultedRecord === undefined || healthyRecord === undefined) throw new Error('C5 I4 selected runs disappeared');
  const faulted = await supervisor.attach({ repo: faultedRecord.repo, active: faultedRecord.active, rawSessionId: 'c5-i4-faulted', handoffToken: null });
  const healthy = await supervisor.attach({ repo: healthyRecord.repo, active: healthyRecord.active, rawSessionId: 'c5-i4-healthy', handoffToken: null });
  await server.close();
  const logicalPointer = record(JSON.parse(await readFile(join(logicalState, 'coordinator', 'current-store.json'), 'utf8')) as unknown, 'I4 logical store pointer');
  const logicalGeneration = text(logicalPointer['generation_id'], 'I4 logical generation');
  const logicalDatabasePath = join(logicalState, 'coordinator', 'stores', logicalGeneration, 'coordinator.db');
  const logicalDatabase = new DatabaseSync(logicalDatabasePath, { timeout: 30_000 });
  try {
    logicalDatabase.exec('BEGIN IMMEDIATE');
    const changed = logicalDatabase.prepare("UPDATE run_resources SET payload_json='{' WHERE repo_id=? AND workstream_run=?").run(text(faulted.context['repo_id'], 'I4 faulted repo'), text(faulted.context['workstream_run'], 'I4 faulted run'));
    if (changed.changes !== 1) throw new Error('C5 I4 logical injection did not target one run-resource row');
    logicalDatabase.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
  } catch (error) { if (logicalDatabase.isTransaction) logicalDatabase.exec('ROLLBACK'); throw error; }
  finally { logicalDatabase.close(); }
  server = await startCoordinator({ cli, package_root: packageRoot, state_root: logicalState, env: input.environment, Client: CandidateClient });
  const faultedStatus = await supervisor.client.query('status', text(faulted.context['repo_id'], 'I4 repo'), text(faulted.context['workstream_run'], 'I4 faulted run'));
  const faults = faultedStatus.payload['run_scoped_logical_faults'];
  if (!Array.isArray(faults) || faults.length !== 1 || record(faults[0], 'I4 logical fault')['invariant_id'] !== 'F4-PAYLOAD-INDEX-AMBIGUITY') throw new Error('C5 I4 malformed payload did not become one scoped logical fault');
  const faultHeartbeat = await supervisor.client.mutate('heartbeat', { repoId: faulted.context['repo_id'], workstreamRun: faulted.context['workstream_run'], sessionId: faulted.context['session_id'], fencingGeneration: faulted.context['session_generation'], expectedVersion: faulted.session['version'], idempotencyKey: 'c5-i4-fault-heartbeat' }, { session_lease_id: faulted.context['session_lease_id'], session_token: faulted.context['session_token'], lease_expires_at: '2099-01-03T00:00:00.000Z' });
  if (!faultHeartbeat.ok) throw new Error('C5 I4 faulted run heartbeat did not renew authority');
  const sessionProof = (attachment: SupervisorAttachment): Readonly<Record<string, unknown>> => ({ session_lease_id: attachment.context['session_lease_id'], session_token: attachment.context['session_token'] });
  const acquisitionPayload = (label: string, attachment: SupervisorAttachment): Readonly<Record<string, unknown>> => ({ acquisition_group_id: `c5-group-${label}`, acquisition_kind: 'initial', unit_id: `c5-unit-${label}`, attempt: 1, requested_leases: [{ path: `c5/${label}.ts`, mode: 'WRITE', purpose: 'C5 scoped-fault dispatch proof' }], reason: 'C5 scoped-fault dispatch proof', normal_release_condition: { condition_type: 'unit-merged', target_id: `c5-unit-${label}:1`, evidence: null }, spec_ref: `c5-${label}.json`, spec_sha256: digest(label), role: 'fix', preemptible: true, checkpoint_ordinal: 0, ...sessionProof(attachment) });
  const identity = (attachment: SupervisorAttachment, label: string): Readonly<Record<string, unknown>> => ({ repoId: attachment.context['repo_id'], workstreamRun: attachment.context['workstream_run'], sessionId: attachment.context['session_id'], fencingGeneration: attachment.context['session_generation'], expectedVersion: attachment.context['run_version'], idempotencyKey: `c5-i4-${label}` });
  let faultedBlocked = false;
  try { await supervisor.client.mutate('acquire-group', identity(faulted, 'faulted'), acquisitionPayload('faulted', faulted)); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'recovery-required')) throw error; faultedBlocked = true; }
  if (!faultedBlocked) throw new Error('C5 I4 faulted run was not exclusively fenced');
  const acquired = await supervisor.client.mutate('acquire-group', identity(healthy, 'healthy'), acquisitionPayload('healthy', healthy));
  if (!acquired.ok) throw new Error('C5 I4 healthy run did not dispatch');
  await server.close();
  return Object.freeze({ incident_id: 'I4', provenance: 'actual-plus-controlled-clone-injection', passed: true, assertion_ids: ['counter-behind-audited-repair', 'faulted-run-only-blocked', 'healthy-run-dispatched', 'ambiguous-and-physical-fatal'], evidence_sha256: digest({ behind: behindDoctor.payload, behind_repair_export_sha256: digest(repairEvidence), ahead, ambiguous, physical, fault: faults[0], heartbeat_event_seq: faultHeartbeat.committed_event_seq, healthy_event_seq: acquired.committed_event_seq }) });
}

function mutateCloneGitRef(repositoryRoot: string, args: readonly string[]): void {
  const result = spawnSync('/usr/bin/git', args, { cwd: repositoryRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null || result.stdout !== '' || result.stderr !== '') throw new Error('C5 controlled clone Git ref mutation failed or emitted diagnostics');
}

function gitRefs(repositoryRoot: string): readonly string[] {
  const result = spawnSync('/usr/bin/git', ['for-each-ref', '--format=%(refname)%00%(objectname)'], { cwd: repositoryRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) throw new Error('C5 I5 ref measurement failed');
  return Object.freeze(result.stdout.split('\n').filter((value) => value.length > 0).sort());
}

async function runI5(input: WorkerDescriptor, modules: JsonObject, client: RuntimeClient, attachments: ReadonlyMap<string, SupervisorAttachment>): Promise<{ readonly result: JsonObject; readonly reconciliation: readonly JsonObject[] }> {
  const execute = modules['executeApprovedMetadataReconcileBatch'];
  if (typeof execute !== 'function') throw new Error('candidate metadata reconciliation module omits repository-wide production consumer');
  const entries = input.i5.approvals.map((row) => {
    const attachment = attachments.get(row.run_key);
    if (attachment === undefined) throw new Error('C5 I5 approval run has no production supervisor attachment');
    return { client, session: attachment.context, worktree_root: row.worktree_root, approval: row.approval };
  });
  if (entries.length !== 34) throw new Error('C5 I5 exact approval set is not 34 rows');
  const approvalEvidenceBefore = await Promise.all(input.i5.approvals.map(async (row) => {
    const path = text(record(row.approval, 'I5 approval')['recovery_evidence_path'], 'I5 recovery evidence path');
    return Object.freeze({ path_sha256: digest(path), content_sha256: digest(await readFile(path)) });
  }));
  const beforeRefs = gitRefs(input.repository_root);
  const first: unknown = await execute({ entries, env: input.environment });
  const replay: unknown = await execute({ entries, env: input.environment });
  const firstRow = record(first, 'I5 first result');
  const replayRow = record(replay, 'I5 replay result');
  const firstBatch = record(firstRow['batch'], 'I5 first batch');
  if (canonical(firstBatch['before_registrations']) !== canonical(input.i5.before_registrations) || canonical(firstBatch['after_registrations']) !== canonical(input.i5.expected_after_registrations)) throw new Error('C5 I5 production batch differs from exact measured before/after registration sets');
  const operations = firstRow['operations'];
  if (!Array.isArray(operations) || operations.length !== 34 || operations.some((value) => record(value, 'I5 operation')['stage'] !== 'committed')) throw new Error('C5 I5 did not commit every exact approved operation');
  const replayBatch = record(replayRow['batch'], 'I5 replay batch');
  if (replayBatch['mutation_report'] !== 'already-satisfied') throw new Error('C5 I5 replay was not mechanically idempotent');
  const afterRefs = gitRefs(input.repository_root);
  if (canonical(beforeRefs) !== canonical(afterRefs)) throw new Error('C5 I5 changed the complete Git ref set');
  const approvalEvidenceAfter = await Promise.all(input.i5.approvals.map(async (row) => {
    const path = text(record(row.approval, 'I5 approval')['recovery_evidence_path'], 'I5 recovery evidence path');
    return Object.freeze({ path_sha256: digest(path), content_sha256: digest(await readFile(path)) });
  }));
  if (canonical(approvalEvidenceBefore) !== canonical(approvalEvidenceAfter)) throw new Error('C5 I5 changed immutable recovery evidence');
  for (const preserved of input.i5.preserved_refs) {
    const fact = `${text(preserved['ref'], 'I5 preserved ref')}\u0000${text(preserved['sha'], 'I5 preserved SHA')}`;
    if (!beforeRefs.includes(fact) || !afterRefs.includes(fact)) throw new Error('C5 I5 changed a preserved branch/archive/evidence ref');
  }
  for (const approval of input.i5.approvals) {
    const target = text(record(approval.approval['intent'], 'I5 intent')['target_registration_path'], 'I5 target path');
    if (existsSync(target)) throw new Error('C5 I5 invented missing filesystem bytes');
  }
  const grouped = new Map<string, JsonObject>();
  for (const approval of input.i5.approvals) {
    if (grouped.has(approval.run_key)) continue;
    const attachment = attachments.get(approval.run_key);
    if (attachment === undefined) throw new Error('C5 I5 grouped attachment disappeared');
    grouped.set(approval.run_key, { corpus_id: input.corpus_id, scenario_id: input.scenario_id, run_id_sha256: runIdentityDigest(text(attachment.context['repo_id'], 'I5 repo'), text(attachment.context['workstream_run'], 'I5 run')), consumer: 'metadata-reconcile', before_sha256: digest(input.i5.before_registrations), after_sha256: digest(input.i5.expected_after_registrations), replayed: true, outcome: 'passed', diagnostic_codes: [] });
  }
  return Object.freeze({ result: { incident_id: 'I5', provenance: 'retained-actual', passed: true, assertion_ids: ['registrations-34-reconciled', 'branch-refs-preserved', 'archive-refs-preserved', 'evidence-preserved', 'missing-bytes-not-invented'], evidence_sha256: digest({ first, replay, before_refs: beforeRefs, after_refs: afterRefs, immutable_evidence: approvalEvidenceAfter }) }, reconciliation: Object.freeze([...grouped.values()]) });
}

function doctorRow(input: WorkerDescriptor, payload: Readonly<Record<string, unknown>>, phase: 'post-migration' | 'post-reconciliation'): JsonObject {
  const healthy = payload['healthy'];
  const integrity = payload['integrity'];
  const findings = payload['invariant_findings'];
  const findingValues = Array.isArray(findings) ? findings : [];
  const codes = [...new Set(findingValues.map((value) => record(value, 'doctor finding')['invariant_id']).filter((value): value is string => typeof value === 'string'))].sort();
  return { corpus_id: input.corpus_id, scenario_id: input.scenario_id, phase, integrity: integrity === 'ok' ? 'ok' : 'failed', healthy: healthy === true, finding_count: findingValues.length, finding_codes: codes, projection_sha256: digest(payload) };
}

async function dispatchRows(input: WorkerDescriptor, client: RuntimeClient, attachments: ReadonlyMap<string, SupervisorAttachment>, modules: { readonly scheduler: JsonObject; readonly validate: JsonObject; readonly config: JsonObject; readonly reservations: JsonObject }): Promise<readonly JsonObject[]> {
  const planNextDispatch = modules.scheduler['planNextDispatch'];
  const parseState = modules.validate['parseAutopilotState'];
  const parseMasterPlan = modules.validate['parseAutopilotMasterPlan'];
  const parseUnitSpec = modules.validate['parseAutopilotUnitSpec'];
  const readSchedulerConfig = modules.config['readSchedulerConfig'];
  const parseReservationView = modules.reservations['parseReservationCoordinationView'];
  if (typeof planNextDispatch !== 'function' || typeof parseState !== 'function' || typeof parseMasterPlan !== 'function' || typeof parseUnitSpec !== 'function' || typeof readSchedulerConfig !== 'function' || typeof parseReservationView !== 'function') throw new Error('candidate dispatch modules omit a required production planner consumer');
  const rows: JsonObject[] = [];
  for (const runRecord of input.runs) {
    const repoId = text(runRecord.run['repo_id'], 'dispatch repo ID');
    const runId = text(runRecord.run['workstream_run'], 'dispatch run ID');
    const durableStatus = text(runRecord.run['status'], 'dispatch run status');
    const attachment = attachments.get(runKey(runRecord));
    const runtimeRoot = resolve(text(runRecord.resource['runtime_root'], 'dispatch runtime root'));
    const rel = relative(input.scenario_root, runtimeRoot);
    if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('C5 dispatch runtime root escapes scenario authority');
    const status = await client.query('status', repoId, runId);
    const faults = status.payload['run_scoped_logical_faults'];
    const scopedFaultActive = Array.isArray(faults) && faults.length > 0;
    const noPlanRow = (disposition: 'paused' | 'recovering' | 'terminal', probeCode: string): JsonObject => ({ corpus_id: input.corpus_id, scenario_id: input.scenario_id, run_id_sha256: runIdentityDigest(repoId, runId), disposition, planner_invoked: false, scheduler_plan_sha256: null, selected_count: 0, skipped_code_counts: [], coordinator_admission_probe: 'not-applicable', coordinator_admission_probe_code: probeCode, agent_process_started: false, external_git_effect_started: false, outcome: 'passed' });
    if (durableStatus === 'closed' || durableStatus === 'aborted') { rows.push(noPlanRow('terminal', 'durable-run-terminal')); continue; }
    if (durableStatus === 'paused') { rows.push(noPlanRow('paused', 'durable-run-paused')); continue; }
    const statePath = join(runtimeRoot, 'state.json');
    const masterPlanPath = join(runtimeRoot, 'master-plan.json');
    if (!existsSync(statePath) || !existsSync(masterPlanPath)) { rows.push(noPlanRow('recovering', 'runtime-artifacts-absent')); continue; }
    const stateBytes = await readStableCloneFile(statePath, 64 * 1024 * 1024, 'dispatch state');
    const masterPlanBytes = await readStableCloneFile(masterPlanPath, 64 * 1024 * 1024, 'dispatch master plan');
    let state: unknown;
    let masterPlan: unknown;
    try {
      state = parseState(JSON.parse(Buffer.from(stateBytes).toString('utf8')) as unknown);
      masterPlan = parseMasterPlan(JSON.parse(Buffer.from(masterPlanBytes).toString('utf8')) as unknown);
    } catch {
      rows.push(noPlanRow('recovering', 'runtime-artifacts-incompatible'));
      continue;
    }
    const stateRow = record(state, 'dispatch state');
    const planRow = record(masterPlan, 'dispatch master plan');
    const workstream = text(stateRow['workstream'], 'dispatch workstream');
    if (planRow['workstream'] !== workstream || workstream !== runRecord.run['workstream']) throw new Error('C5 dispatch runtime artifacts differ from durable workstream identity');
    const attemptValues = status.payload['unit_attempts'];
    if (!Array.isArray(attemptValues)) throw new Error('C5 dispatch status omitted durable unit attempts');
    const candidates: Readonly<Record<string, unknown>>[] = [];
    const attemptsByUnit = new Map<string, number>();
    for (const value of attemptValues) {
      const attempt = record(value, 'dispatch unit attempt');
      const owner = record(attempt['owner'], 'dispatch attempt owner');
      if (owner['repo_id'] !== repoId || owner['workstream_run'] !== runId) continue;
      const unitId = text(owner['unit_id'], 'dispatch unit ID');
      const attemptNumber = integer(owner['attempt'], 'dispatch attempt number');
      attemptsByUnit.set(unitId, Math.max(attemptsByUnit.get(unitId) ?? 0, attemptNumber));
      const specRef = record(attempt['spec'], 'dispatch attempt spec');
      const ref = text(specRef['ref'], 'dispatch spec ref');
      const specPath = isAbsolute(ref) ? resolve(ref) : resolve(runtimeRoot, ref);
      const specRel = relative(input.scenario_root, specPath);
      if (specRel === '' || isAbsolute(specRel) || specRel === '..' || specRel.startsWith(`..${sep}`)) throw new Error('C5 dispatch spec ref escapes scenario authority');
      let spec: unknown | null = null;
      if (existsSync(specPath)) {
        const bytes = await readStableCloneFile(specPath, 64 * 1024 * 1024, 'dispatch unit spec');
        if (digest(bytes) !== specRef['sha256']) throw new Error('C5 dispatch spec bytes differ from durable attempt evidence');
        spec = parseUnitSpec(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown);
      }
      candidates.push(Object.freeze({ unit_id: unitId, attempt: attemptNumber, spec, governing_blockers: [], peer_claim_request_refs: [], worktree_available: true }));
    }
    const runningIds = Array.isArray(stateRow['running']) ? stateRow['running'].map((value) => text(value, 'dispatch running unit')) : [];
    const runningAttempts = runningIds.map((unitId) => { const attempt = attemptsByUnit.get(unitId); if (attempt === undefined) throw new Error('C5 running scheduler unit lacks durable attempt authority'); return { unit_id: unitId, attempt }; });
    const leaseValues = status.payload['edit_leases'];
    if (!Array.isArray(leaseValues)) throw new Error('C5 dispatch status omitted durable edit leases');
    const activeClaims = leaseValues.map((value) => {
      const lease = record(value, 'dispatch edit lease');
      const owner = record(lease['owner'], 'dispatch lease owner');
      const mode = text(lease['mode'], 'dispatch lease mode');
      if (mode !== 'READ' && mode !== 'WRITE' && mode !== 'EXCLUSIVE') throw new Error('C5 dispatch lease has an invalid claim mode');
      return Object.freeze({ path: text(lease['path'], 'dispatch lease path'), claim_type: mode, unit_id: text(owner['unit_id'], 'dispatch lease unit'), attempt: integer(owner['attempt'], 'dispatch lease attempt') });
    });
    const contextGateRow = record(stateRow['context_gate'], 'dispatch context gate');
    const gate = contextGateRow['gate'];
    if (gate !== 'ok' && gate !== 'halt' && gate !== 'unknown') throw new Error('C5 dispatch context gate is malformed');
    const config: unknown = await readSchedulerConfig({ runtimeRoot, workstream, now: new Date(text(stateRow['updated_at'], 'dispatch state time')) });
    const reservationView: unknown = parseReservationView(status.payload);
    const dispatch: unknown = await planNextDispatch({ workstream, runtimeRoot, contextGate: gate, state, masterPlan, config, candidates, runningAttempts, activeClaims, reservationCoordination: { workstreamRun: runId, view: reservationView }, now: new Date(text(stateRow['updated_at'], 'dispatch state time')) });
    const dispatchPlan = record(dispatch, 'production dispatch plan');
    const selectedValues = dispatchPlan['selected'];
    const skippedValues = dispatchPlan['skipped'];
    if (!Array.isArray(selectedValues) || !Array.isArray(skippedValues)) throw new Error('production dispatch plan omitted selected/skipped projections');
    const codeCounts = new Map<string, number>();
    for (const skipped of skippedValues) {
      const reasons = record(skipped, 'dispatch skipped unit')['reasons'];
      if (!Array.isArray(reasons)) throw new Error('production dispatch skipped unit omits reason codes');
      for (const reason of reasons) {
        const code = text(reason, 'dispatch skip code');
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      }
    }
    const codes = [...codeCounts].map(([code, count]) => ({ code, count })).sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
    let disposition: 'launchable' | 'paused' | 'recovering' | 'terminal' = durableStatus === 'closed' || durableStatus === 'aborted' ? 'terminal' : durableStatus === 'paused' ? 'paused' : durableStatus === 'recovering' || attachment === undefined ? 'recovering' : selectedValues.length > 0 ? 'launchable' : 'recovering';
    if (scopedFaultActive) disposition = 'recovering';
    let probe: 'acquire-cancel' | 'not-applicable' = 'not-applicable';
    let probeCode = scopedFaultActive ? 'run-scoped-fault' : attachment === undefined ? 'attachment-unavailable' : durableStatus === 'recovering' ? 'durable-run-recovering' : selectedValues.length === 0 ? 'scheduler-no-selection' : 'admission-probe-not-applicable';
    const selected = selectedValues[0] === undefined ? null : record(selectedValues[0], 'dispatch selected unit');
    if (disposition === 'launchable' && attachment !== undefined && selected !== null) {
      const unitId = text(selected['unit_id'], 'selected dispatch unit');
      const attemptNumber = integer(selected['attempt'], 'selected dispatch attempt');
      const durableAttempt = attemptValues.map((value) => record(value, 'dispatch unit attempt')).find((value) => { const owner = record(value['owner'], 'dispatch attempt owner'); return owner['unit_id'] === unitId && owner['attempt'] === attemptNumber; });
      if (durableAttempt === undefined) throw new Error('C5 selected dispatch lacks exact durable attempt authority');
      const acquisitionValues = status.payload['acquisition_groups'];
      if (!Array.isArray(acquisitionValues)) throw new Error('C5 dispatch status omitted durable acquisition groups');
      const priorGroupCount = acquisitionValues.map((value) => record(value, 'dispatch acquisition group')).filter((value) => { const owner = record(value['owner'], 'dispatch acquisition owner'); return owner['repo_id'] === repoId && owner['workstream_run'] === runId && owner['unit_id'] === unitId && owner['attempt'] === attemptNumber; }).length;
      const role = text(durableAttempt['role'], 'selected dispatch role');
      const stateValue = text(durableAttempt['state'], 'selected dispatch state');
      if (priorGroupCount > 0) probeCode = 'prior-acquisition-group';
      else if (role !== 'implement' && role !== 'fix') probeCode = 'non-source-changing-role';
      else if (stateValue !== 'preflight') probeCode = 'attempt-not-clean-preflight';
      else {
        const specRef = record(durableAttempt['spec'], 'selected dispatch spec');
        const suffix = runIdentityDigest(repoId, runId).slice(7, 23);
        const groupId = `c5-dry-run-${suffix}`;
        const identity = { repoId, workstreamRun: runId, sessionId: attachment.context['session_id'], fencingGeneration: attachment.context['session_generation'], expectedVersion: attachment.context['run_version'], idempotencyKey: `c5-dry-run-acquire-${suffix}` };
        const acquired = await client.mutate('acquire-group', identity, { acquisition_group_id: groupId, acquisition_kind: 'initial', unit_id: unitId, attempt: attemptNumber, requested_leases: [{ path: `c5-dry-run/${suffix}.probe`, mode: 'WRITE', purpose: 'C5 acquire-cancel dispatch dry run' }], reason: 'C5 acquire-cancel dispatch dry run', normal_release_condition: { condition_type: 'unit-merged', target_id: `${unitId}:${String(attemptNumber)}`, evidence: null }, spec_ref: specRef['ref'], spec_sha256: specRef['sha256'], role, preemptible: durableAttempt['preemptible'], checkpoint_ordinal: durableAttempt['checkpoint_ordinal'], session_lease_id: attachment.context['session_lease_id'], session_token: attachment.context['session_token'] });
        const group = record(acquired.payload['acquisition_group'], 'dispatch acquisition group');
        const cancelled = await client.mutate('cancel-acquisition-group', { ...identity, expectedVersion: integer(group['version'], 'dispatch group version'), idempotencyKey: `c5-dry-run-cancel-${suffix}` }, { acquisition_group_id: groupId, reason: 'C5 dry-run cancellation', session_lease_id: attachment.context['session_lease_id'], session_token: attachment.context['session_token'] });
        if (record(cancelled.payload['acquisition_group'], 'cancelled dispatch acquisition group')['state'] !== 'cancelled') throw new Error('C5 dispatch admission probe did not atomically cancel acquired authority');
        probe = 'acquire-cancel';
        probeCode = 'acquire-cancel-passed';
      }
    }
    rows.push({ corpus_id: input.corpus_id, scenario_id: input.scenario_id, run_id_sha256: runIdentityDigest(repoId, runId), disposition, planner_invoked: true, scheduler_plan_sha256: digest(dispatchPlan), selected_count: selectedValues.length, skipped_code_counts: codes, coordinator_admission_probe: probe, coordinator_admission_probe_code: probeCode, agent_process_started: false, external_git_effect_started: false, outcome: 'passed' });
  }
  return Object.freeze(rows);
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (inputPath === undefined) throw new Error('usage: incident-worker.ts <clone-private-input.json>');
  const input = parseWorkerDescriptor(JSON.parse(Buffer.from(await readStableCloneFile(inputPath, 64 * 1024 * 1024, 'incident worker input')).toString('utf8')) as unknown);
  const candidateClientModule = await loadModule(text(input.candidate['client_module_path'], 'candidate client module'));
  const cf50ClientModule = await loadModule(text(input.cf50['client_module_path'], 'cf50 client module'));
  const CandidateClient = constructorFrom(candidateClientModule, 'CoordinatorClient', 'candidate client');
  const Cf50Client = constructorFrom(cf50ClientModule, 'CoordinatorClient', 'cf50 client');
  const supervisorModule = await loadModule(text(input.candidate['supervisor_module_path'], 'candidate supervisor module'));
  const worktreeSagaModule = await loadModule(text(input.candidate['worktree_saga_module_path'], 'candidate saga module'));
  const parallelModule = await loadModule(text(input.candidate['parallel_runtime_module_path'], 'candidate parallel module'));
  const identityModule = await loadModule(text(input.candidate['identity_resolution_module_path'], 'candidate identity module'));
  const metadataModule = await loadModule(text(input.candidate['metadata_reconcile_module_path'], 'candidate metadata module'));
  const dispatchModules = Object.freeze({
    scheduler: await loadModule(text(input.candidate['scheduler_module_path'], 'candidate scheduler module')),
    validate: await loadModule(text(input.candidate['contract_validate_module_path'], 'candidate contract validate module')),
    config: await loadModule(text(input.candidate['scheduler_config_module_path'], 'candidate scheduler config module')),
    reservations: await loadModule(text(input.candidate['reservations_module_path'], 'candidate reservations module')),
  });
  const Supervisor = supervisorConstructorFrom(supervisorModule);

  const incidentResults: JsonObject[] = [];
  if (input.enabled_incidents.includes('I1')) {
    const i1 = await runI1(input, CandidateClient, Cf50Client);
    incidentResults.push({ incident_id: 'I1', provenance: 'retained-actual', passed: true, assertion_ids: ['actual-cf50-client-to-s1', 's1-client-to-actual-cf50', 'attach-heartbeat-replay', 'natural-restart', 'mixed-election'], evidence_sha256: text(i1['evidence_sha256'], 'I1 evidence') });
  }
  const baseServer = await startCoordinator({ cli: text(input.candidate['coordinator_cli_path'], 'candidate CLI'), package_root: text(input.candidate['package_root'], 'candidate package'), state_root: input.base_state_root, env: input.environment, Client: CandidateClient });
  try {
    const doctorBefore = await baseServer.client.query('doctor');
    await preflightIncidentAuthority(input, baseServer.client);
    const supervisor = new Supervisor(input.environment);
    const attached = await attachDurableRuns(input, supervisor);
    const reconciliationResults: JsonObject[] = [...attached.reconciliations];
    if (input.enabled_incidents.includes('I2')) { const i2 = await runI2(input, worktreeSagaModule, attached.attachments); incidentResults.push(i2.result); reconciliationResults.push(i2.reconciliation); }
    if (input.enabled_incidents.includes('I5')) { const i5 = await runI5(input, metadataModule, baseServer.client, attached.attachments); incidentResults.push(i5.result); reconciliationResults.push(...i5.reconciliation); }
    if (input.enabled_incidents.includes('I3')) { const i3Modules = Object.freeze({ ...identityModule, ...parallelModule, ...worktreeSagaModule }); const i3 = await runI3(input, i3Modules, baseServer.client, attached.attachments); incidentResults.push(i3.result); reconciliationResults.push(...i3.reconciliation); }
    if (input.enabled_incidents.includes('I4')) incidentResults.push(await runI4(input, CandidateClient, Supervisor));
    const dispatchDryRunResults = await dispatchRows(input, baseServer.client, attached.attachments, dispatchModules);
    const doctorAfter = await baseServer.client.query('doctor');
    const pointer = record(JSON.parse(await readFile(input.current_pointer_path, 'utf8')) as unknown, 'current store pointer');
    const output = {
      schema_version: 'autopilot.s1_corpus_incident_worker_output.v1',
      rehearsal_id: input.rehearsal_id,
      corpus_id: input.corpus_id,
      scenario_id: input.scenario_id,
      generation_id: text(pointer['generation_id'], 'store generation ID'),
      attach_results: attached.results,
      doctor_results: [doctorRow(input, doctorBefore.payload, 'post-migration'), doctorRow(input, doctorAfter.payload, 'post-reconciliation')],
      reconciliation_results: reconciliationResults,
      dispatch_dry_run_results: dispatchDryRunResults,
      incident_results: incidentResults,
    };
    await writeFile(input.output_path, `${canonical(output)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } finally { await baseServer.close(); }
  const lifecycleAuthorityPaths = [input.base_lock_path, input.base_socket_path, ...Object.values(input.lock_paths), ...Object.values(input.socket_paths)];
  for (let index = 0; index < 200 && lifecycleAuthorityPaths.some(existsSync); index += 1) await wait(25);
  if (lifecycleAuthorityPaths.some(existsSync)) throw new Error('C5 worker retained clone coordinator lock or socket authority after bounded shutdown');
}

async function entry(): Promise<void> {
  let failure: unknown = null;
  try { await main(); } catch (error) { failure = error; }
  try { await stopAllCoordinators(); }
  catch (cleanupError) { failure = failure === null ? cleanupError : new AggregateError([failure, cleanupError], 'C5 incident worker failed and coordinator cleanup also failed'); }
  if (failure !== null) throw failure;
}

await entry().catch((error: unknown) => { process.stderr.write(`C5 incident worker failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
