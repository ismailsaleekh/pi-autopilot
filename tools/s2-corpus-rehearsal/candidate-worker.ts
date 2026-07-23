import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationEditLease, parseCoordinationMigrationRecoveryWork, parseCoordinationUnitAttempt } from '../../src/core/coordination/contracts.ts';
import { assertD65OrdinaryBoundaryFromEnvironment } from '../../src/core/coordination/d65-runtime-dispatch.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { isExactProcessAlive, isProcessAlive, processStartIdentity } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { DurableRunSupervisorClient, type RunSupervisorAttachment } from '../../src/core/coordination/supervisor.ts';
import { recoverOwnedWorktreeSagas } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ActiveAutopilotRow, type AutopilotRepoIdentity, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { S2_D_DURABLE_RUN_ACTIONS, type ActionResult, type CorpusBlocker, type DurableRunContract, type Sha256Digest } from './contracts.ts';

interface WorkerInput {
  readonly state_root: string;
  readonly corpus_id: string;
  readonly run_id_sha256: Sha256Digest;
  readonly repo_id_sha256: Sha256Digest;
  readonly repo: AutopilotRepoIdentity;
  readonly active: ActiveAutopilotRow;
  readonly contract: DurableRunContract;
}

interface WorkerOutput {
  readonly action_results: readonly ActionResult[];
  readonly new_blockers: readonly CorpusBlocker[];
}

function digestBytes(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) throw new Error(`${label} must be text`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return text(value, label);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${String(minimum)}`);
  return value;
}

function sha(value: unknown, label: string): Sha256Digest {
  const parsed = text(value, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(parsed)) throw new Error(`${label} must be a sha256 digest`);
  return parsed as Sha256Digest;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const parsed = text(value, label);
  if (!allowed.includes(parsed as T)) throw new Error(`${label} is invalid`);
  return parsed as T;
}

function parseRequiredActions(value: unknown): typeof S2_D_DURABLE_RUN_ACTIONS {
  if (!Array.isArray(value) || value.length !== S2_D_DURABLE_RUN_ACTIONS.length) throw new Error('contract.required_actions must be exact');
  for (const [index, action] of S2_D_DURABLE_RUN_ACTIONS.entries()) if (value[index] !== action) throw new Error('contract.required_actions ordering is invalid');
  return S2_D_DURABLE_RUN_ACTIONS;
}

function parseContract(value: unknown): DurableRunContract {
  const row = record(value, 'S2-D candidate worker input.contract');
  return Object.freeze({
    corpus_id: text(row['corpus_id'], 'contract.corpus_id'),
    run_id_sha256: sha(row['run_id_sha256'], 'contract.run_id_sha256'),
    repo_id_sha256: sha(row['repo_id_sha256'], 'contract.repo_id_sha256'),
    required_actions: parseRequiredActions(row['required_actions']),
    attachment_strategy: literal(row['attachment_strategy'], ['safe-attachment', 'owned-recovery'] as const, 'contract.attachment_strategy'),
    terminal_attempt_lease: literal(row['terminal_attempt_lease'], ['no-retained-terminal-attempt-lease', 'retained-terminal-attempt-recovery-required', 'retained-terminal-attempt-reconciled'] as const, 'contract.terminal_attempt_lease'),
    authority_version_mismatch: literal(row['authority_version_mismatch'], ['no-operation-authority-version-mismatch', 'operation-authority-version-mismatch-blocked', 'operation-authority-version-mismatch-recovered'] as const, 'contract.authority_version_mismatch'),
    evidence_sha256: sha(row['evidence_sha256'], 'contract.evidence_sha256'),
  });
}

function parseRepo(value: unknown): AutopilotRepoIdentity {
  const row = record(value, 'repo');
  return Object.freeze({
    repoRoot: text(row['repoRoot'], 'repo.repoRoot'),
    gitCommonDir: text(row['gitCommonDir'], 'repo.gitCommonDir'),
    repoKey: text(row['repoKey'], 'repo.repoKey'),
    headSha: text(row['headSha'], 'repo.headSha'),
    targetBranch: nullableText(row['targetBranch'], 'repo.targetBranch'),
    originUrl: nullableText(row['originUrl'], 'repo.originUrl'),
  });
}

function parseActive(value: unknown): ActiveAutopilotRow {
  const row = record(value, 'active');
  return Object.freeze({
    schema_version: literal(row['schema_version'], ['autopilot.active_parent.v2'] as const, 'active.schema_version'),
    coordination_authority: literal(row['coordination_authority'], ['legacy-path-claims-v1', 'coordinator-edit-leases-v1'] as const, 'active.coordination_authority'),
    autopilot_id: text(row['autopilot_id'], 'active.autopilot_id'),
    workstream: text(row['workstream'], 'active.workstream'),
    workstream_run: text(row['workstream_run'], 'active.workstream_run'),
    repo_key: text(row['repo_key'], 'active.repo_key'),
    source_repo: text(row['source_repo'], 'active.source_repo'),
    git_common_dir: text(row['git_common_dir'], 'active.git_common_dir'),
    worktree_root: text(row['worktree_root'], 'active.worktree_root'),
    main_worktree_path: text(row['main_worktree_path'], 'active.main_worktree_path'),
    branch: text(row['branch'], 'active.branch'),
    runtime_root: text(row['runtime_root'], 'active.runtime_root'),
    target_branch: nullableText(row['target_branch'], 'active.target_branch'),
    target_base_sha: text(row['target_base_sha'], 'active.target_base_sha'),
    origin_url: nullableText(row['origin_url'], 'active.origin_url'),
    pid: integer(row['pid'], 'active.pid', 1),
    boot_id: text(row['boot_id'], 'active.boot_id'),
    status: literal(row['status'], ['active', 'paused', 'merging', 'blocked', 'crashed', 'closed'] as const, 'active.status'),
    started_at: text(row['started_at'], 'active.started_at'),
    active_run_epoch: integer(row['active_run_epoch'], 'active.active_run_epoch', 1),
    active_epoch_started_at: text(row['active_epoch_started_at'], 'active.active_epoch_started_at'),
    active_run_receipt_id: text(row['active_run_receipt_id'], 'active.active_run_receipt_id'),
  });
}

function inputFromJson(value: unknown): WorkerInput {
  const row = record(value, 'S2-D candidate worker input');
  const contract = parseContract(row['contract']);
  return {
    state_root: text(row['state_root'], 'state_root'),
    corpus_id: text(row['corpus_id'], 'corpus_id'),
    run_id_sha256: sha(row['run_id_sha256'], 'run_id_sha256'),
    repo_id_sha256: sha(row['repo_id_sha256'], 'repo_id_sha256'),
    repo: parseRepo(row['repo']),
    active: parseActive(row['active']),
    contract,
  };
}

function actionRow(input: WorkerInput, action: ActionResult['action'], evidence: unknown): ActionResult {
  return Object.freeze({ corpus_id: input.corpus_id, run_id_sha256: input.run_id_sha256, action, outcome: 'passed', evidence_sha256: digestBytes(canonicalJson({ action, corpus_id: input.corpus_id, run_id_sha256: input.run_id_sha256, repo_id_sha256: input.repo_id_sha256, evidence })) });
}

function blocker(input: WorkerInput, action: string, error: unknown): CorpusBlocker {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message, stack: null } : { name: 'NonError', message: String(error), stack: null };
  const suffix = error instanceof CoordinationRuntimeError ? `-${error.code}` : error instanceof Error && 'code' in error ? `-${String(error.code)}` : '';
  return Object.freeze({ code: `candidate-${action}-blocked${suffix}`, corpus_id: input.corpus_id, run_id_sha256: input.run_id_sha256, diagnostic_sha256: digestBytes(canonicalJson(diagnostic)) });
}

async function detach(supervisor: DurableRunSupervisorClient, attachment: RunSupervisorAttachment): Promise<void> {
  if (attachment.session.attachment_kind === 'migration-recovery') {
    await supervisor.detachMigrationRecovery(attachment, 'S2-D candidate migration recovery subprocess completed');
    return;
  }
  await supervisor.client.mutate('detach-session', {
    repoId: attachment.context.repo_id,
    workstreamRun: attachment.context.workstream_run,
    sessionId: attachment.session.session_id,
    fencingGeneration: attachment.session.session_generation,
    expectedVersion: attachment.session.version,
    idempotencyKey: `s2-d-candidate-detach:${attachment.session.session_lease_id}`,
  }, { reason: 'S2-D candidate rehearsal subprocess completed', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
  await unlink(attachment.contextPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  });
}

function errorEvidence(error: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ code: error instanceof CoordinationRuntimeError ? error.code : error instanceof Error && 'code' in error ? String(error.code) : 'unknown', message: error instanceof Error ? error.message : String(error), evidence: error instanceof CoordinationRuntimeError ? error.evidence.slice(0, 16) : [] });
}

function terminalRecoveryWorkerPath(): string {
  return fileURLToPath(new URL('./terminal-recovery-worker.ts', import.meta.url));
}

interface LifecycleCandidate {
  readonly state_root: string;
  readonly pid: number;
  readonly process_start_identity: string;
  readonly capability_sha256: Sha256Digest;
}

function lifecycleCapabilityDigest(path: string): Sha256Digest {
  return digestBytes(readFileSync(path));
}

function readLifecycleCandidate(stateRoot: string): LifecycleCandidate | null {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  if (paths.stateRoot !== stateRoot || !existsSync(paths.lockPath) || !existsSync(paths.capabilityPath)) return null;
  const parsed = JSON.parse(readFileSync(paths.lockPath, 'utf8')) as unknown;
  const row = record(parsed, 'coordinator lifecycle lock');
  const pid = integer(row['pid'], 'coordinator lifecycle pid', 1);
  const processStart = text(row['process_start_identity'], 'coordinator lifecycle process identity');
  return Object.freeze({ state_root: stateRoot, pid, process_start_identity: processStart, capability_sha256: lifecycleCapabilityDigest(paths.capabilityPath) });
}

async function wait(milliseconds: number): Promise<void> { await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)); }

function sameLifecycleCandidate(left: LifecycleCandidate | null, right: LifecycleCandidate | null): boolean {
  return left !== null && right !== null && left.state_root === right.state_root && left.pid === right.pid && left.process_start_identity === right.process_start_identity && left.capability_sha256 === right.capability_sha256;
}

async function stopCloneCoordinator(stateRoot: string, preexisting: LifecycleCandidate | null): Promise<Readonly<Record<string, unknown>>> {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  if (paths.stateRoot !== stateRoot) throw new Error('S2-D clone coordinator cleanup state-root resolution changed');
  const lifecycle = readLifecycleCandidate(stateRoot);
  if (lifecycle === null) return Object.freeze({ stopped: false, reason: 'no-lifecycle-lock' });
  if (sameLifecycleCandidate(preexisting, lifecycle)) return Object.freeze({ stopped: false, reason: 'preexisting-foreign-coordinator-preserved', pid: lifecycle.pid, process_start_identity: lifecycle.process_start_identity });
  const started = processStartIdentity(lifecycle.pid);
  if (started === null) {
    await Promise.all([paths.lockPath, paths.socketPath, paths.startupLockPath, paths.predecessorLockPath, paths.predecessorSocketPath, paths.predecessorStartupLockPath].map(async (path) => { await rm(path, { force: true }); }));
    return Object.freeze({ stopped: false, reason: 'lifecycle-owner-already-exited', pid: lifecycle.pid, process_start_identity: lifecycle.process_start_identity });
  }
  if (started !== lifecycle.process_start_identity || lifecycle.capability_sha256 !== lifecycleCapabilityDigest(paths.capabilityPath)) throw new Error('S2-D clone coordinator lifecycle/capability identity changed before cleanup');
  process.kill(lifecycle.pid, 'SIGTERM');
  for (let index = 0; index < 200 && isExactProcessAlive(lifecycle.pid, lifecycle.process_start_identity); index += 1) await wait(25);
  if (isExactProcessAlive(lifecycle.pid, lifecycle.process_start_identity)) {
    process.kill(lifecycle.pid, 'SIGKILL');
    for (let index = 0; index < 200 && isExactProcessAlive(lifecycle.pid, lifecycle.process_start_identity); index += 1) await wait(25);
  }
  if (isExactProcessAlive(lifecycle.pid, lifecycle.process_start_identity) || isProcessAlive(lifecycle.pid) && processStartIdentity(lifecycle.pid) === lifecycle.process_start_identity) throw new Error('S2-D clone coordinator process leaked after deterministic cleanup');
  await Promise.all([paths.lockPath, paths.socketPath, paths.startupLockPath, paths.predecessorLockPath, paths.predecessorSocketPath, paths.predecessorStartupLockPath].map(async (path) => { await rm(path, { force: true }); }));
  const after = readLifecycleCandidate(stateRoot);
  if (after !== null && !sameLifecycleCandidate(preexisting, after)) throw new Error('S2-D cleanup left a new detached clone coordinator lifecycle owner');
  return Object.freeze({ stopped: true, pid: lifecycle.pid, process_start_identity: lifecycle.process_start_identity, capability_sha256: lifecycle.capability_sha256 });
}

async function runTerminalRecoverySubprocess(input: WorkerInput, before: number): Promise<Readonly<Record<string, unknown>>> {
  const inputPath = join(input.state_root, 'coordinator', `s2-d-terminal-recovery-${randomUUID()}.json`);
  await writeFile(inputPath, `${canonicalJson(input)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    const output = await new Promise<string>((resolveOutput, rejectOutput) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', terminalRecoveryWorkerPath(), inputPath], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000);
      }, 60_000);
      child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
      child.once('error', (error) => { clearTimeout(timeout); rejectOutput(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (code !== 0) rejectOutput(new Error(`terminal recovery subprocess failed code=${String(code)} signal=${String(signal)} stderr_sha256=${digestBytes(stderrText)}`));
        else resolveOutput(Buffer.concat(stdout).toString('utf8'));
      });
    });
    const parsed = record(JSON.parse(output) as unknown, 'terminal recovery worker output');
    const after = integer(parsed['after_retained_terminal_attempt_leases'], 'terminal recovery after count');
    if (parsed['before_retained_terminal_attempt_leases'] !== before || after !== 0) throw new Error('terminal recovery subprocess did not prove exact before/after retained lease counts');
    return Object.freeze({ ...parsed, input_sha256: digestBytes(canonicalJson(input)) });
  } finally { await unlink(inputPath).catch(() => undefined); }
}

function expectedAuthorityBlocked(input: WorkerInput): boolean {
  return input.contract.authority_version_mismatch === 'operation-authority-version-mismatch-blocked';
}

async function pendingMigrationRecovery(supervisor: DurableRunSupervisorClient, input: WorkerInput) {
  const page = await supervisor.client.query('migration-recovery', input.active.repo_key, input.active.workstream_run, { cursor_recovery_id: null, cursor_run: null, include_resolved: false, limit: 100, recovery_id: null });
  const values = page.payload['recovery'];
  if (!Array.isArray(values)) throw new Error('candidate migration-recovery query omitted recovery rows');
  return values.map((value) => parseCoordinationMigrationRecoveryWork(value)).filter((work) => work.status === 'pending' && work.repo_id === input.active.repo_key && work.workstream_run === input.active.workstream_run);
}

async function terminalAttemptLeaseCount(supervisor: DurableRunSupervisorClient, input: WorkerInput): Promise<number> {
  const status = await supervisor.client.query('status', input.active.repo_key, input.active.workstream_run);
  const attempts = status.payload['unit_attempts'];
  const leases = status.payload['edit_leases'];
  if (!Array.isArray(attempts) || !Array.isArray(leases)) throw new Error('candidate status omitted terminal-attempt lease proof tables');
  const terminalOwners = new Set(attempts.map((value) => parseCoordinationUnitAttempt(value)).filter((attempt) => ['merged', 'failed', 'reset', 'quarantined', 'superseded'].includes(attempt.state)).map((attempt) => `${attempt.owner.unit_id}\0${String(attempt.owner.attempt)}`));
  return leases.map((value) => parseCoordinationEditLease(value)).filter((lease) => terminalOwners.has(`${lease.owner.unit_id}\0${String(lease.owner.attempt)}`)).length;
}

async function attachDispatch(supervisor: DurableRunSupervisorClient, input: WorkerInput): Promise<RunSupervisorAttachment> {
  return await supervisor.attach({ repo: input.repo, active: input.active, rawSessionId: `s2-d-${input.corpus_id}-${input.active.workstream_run}-${randomUUID()}` });
}

async function proveTerminalAttemptRecovery(supervisor: DurableRunSupervisorClient, input: WorkerInput): Promise<Readonly<Record<string, unknown>> | null> {
  if (input.contract.terminal_attempt_lease === 'no-retained-terminal-attempt-lease') return null;
  const before = await terminalAttemptLeaseCount(supervisor, input);
  if (before === 0) return Object.freeze({ recovery_kind: 'terminal-attempt-lease', before_retained_terminal_attempt_leases: 0, after_retained_terminal_attempt_leases: 0, recovery_attachment: 'already-clear' });
  const subprocess = await runTerminalRecoverySubprocess(input, before);
  const after = await terminalAttemptLeaseCount(supervisor, input);
  if (after !== 0) throw new Error(`terminal recovery subprocess left ${String(after)} retained terminal-attempt edit leases`);
  return Object.freeze({ recovery_kind: 'terminal-attempt-lease', before_retained_terminal_attempt_leases: before, after_retained_terminal_attempt_leases: after, recovery_attachment: subprocess['recovery_attachment'], recovery_generation: subprocess['recovery_generation'], subprocess_pid: subprocess['pid'], subprocess_output_sha256: digestBytes(canonicalJson(subprocess)) });
}

async function resolvePendingMigrationRecovery(supervisor: DurableRunSupervisorClient, input: WorkerInput): Promise<{ readonly resolved: readonly string[]; readonly fallbackAttachment: RunSupervisorAttachment }> {
  const pending = await pendingMigrationRecovery(supervisor, input);
  if (pending.length === 0) throw new Error('ordinary owned attachment was fenced but no pending migration recovery rows were discoverable');
  const resolved: string[] = [];
  let retained: RunSupervisorAttachment | null = null;
  for (const [index, work] of pending.entries()) {
    const recoveryAttachment = await supervisor.attachMigrationRecovery({ repo: input.repo, workstreamRun: input.active.workstream_run, recoveryId: work.recovery_id, rawSessionId: `s2-d-migration-recovery-${work.recovery_id}-${randomUUID()}` });
    try {
      const result = await supervisor.resolveMigrationRecovery({ attachment: recoveryAttachment, recoveryWork: work, resolution: { resolutionType: 'authority-retained' } });
      resolved.push(`${result.recoveryWork.recovery_id}:${result.recoveryWork.status}:${String(result.remainingRecoveryCount)}`);
      if (index === pending.length - 1) retained = recoveryAttachment;
    } finally { if (retained !== recoveryAttachment) await detach(supervisor, recoveryAttachment); }
  }
  const after = await pendingMigrationRecovery(supervisor, input);
  if (after.length !== 0) throw new Error(`migration recovery left ${String(after.length)} pending rows`);
  if (retained === null) throw new Error('migration recovery did not retain a recovery attachment for after-proof');
  return Object.freeze({ resolved: Object.freeze(resolved), fallbackAttachment: retained });
}

async function proveOwnedRecoveryPath(supervisor: DurableRunSupervisorClient, recoverySupervisor: DurableRunSupervisorClient, input: WorkerInput, env: ProcessEnvLike): Promise<{ readonly attachment: RunSupervisorAttachment; readonly evidence: Readonly<Record<string, unknown>>; readonly recoveryBlocked: Readonly<Record<string, unknown>> | null }> {
  const terminalRecovery = await proveTerminalAttemptRecovery(recoverySupervisor, input);
  let ordinaryAttachment: RunSupervisorAttachment | null = null;
  let ordinaryBlock: Readonly<Record<string, unknown>> | null = null;
  try { ordinaryAttachment = await attachDispatch(supervisor, input); }
  catch (error) {
    if (!(error instanceof CoordinationRuntimeError) || (error.code !== 'recovery-required' && error.code !== 'coordinator-contention')) throw error;
    ordinaryBlock = errorEvidence(error);
  }
  if (ordinaryAttachment === null) {
    const migration = await resolvePendingMigrationRecovery(recoverySupervisor, input);
    await recoverySupervisor.client.query('status', input.active.repo_key, input.active.workstream_run, { cursor: null });
    let attachment: RunSupervisorAttachment;
    let postRecoveryAttachBlock: Readonly<Record<string, unknown>> | null = null;
    try {
      attachment = await attachDispatch(recoverySupervisor, input);
      await detach(recoverySupervisor, migration.fallbackAttachment);
    } catch (error) {
      if (!(error instanceof CoordinationRuntimeError) || error.code !== 'coordinator-contention') throw error;
      postRecoveryAttachBlock = errorEvidence(error);
      attachment = migration.fallbackAttachment;
    }
    return { attachment, evidence: Object.freeze({ strategy: 'owned-recovery', recovery_kind: 'migration-recovery', ordinary_dispatch_block: ordinaryBlock, post_recovery_attach_block: postRecoveryAttachBlock, resolved: migration.resolved, terminal_recovery: terminalRecovery }), recoveryBlocked: null };
  }

  const attachment = ordinaryAttachment;
  const recoveryEnv: ProcessEnvLike = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
  try {
    const operations = await recoverOwnedWorktreeSagas({ active: input.active, env: recoveryEnv });
    if (expectedAuthorityBlocked(input)) throw new Error('authority-version mismatch contract expected owned operation recovery to block, but recovery completed');
    return { attachment, evidence: Object.freeze({ strategy: 'owned-recovery', recovery_kind: 'owned-worktree-operation', recovered_operations: operations.map((operation) => `${operation.operation_id}:${operation.stage}:${String(operation.version)}`), terminal_recovery: terminalRecovery }), recoveryBlocked: null };
  } catch (error) {
    if (!expectedAuthorityBlocked(input)) throw error;
    return { attachment, evidence: Object.freeze({ strategy: 'owned-recovery', recovery_kind: 'owned-worktree-operation', recovered_operations: [], recovery_blocked: errorEvidence(error), terminal_recovery: terminalRecovery }), recoveryBlocked: errorEvidence(error) };
  }
}

async function execute(input: WorkerInput): Promise<WorkerOutput> {
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: input.state_root };
  const supervisor = new DurableRunSupervisorClient(env, { allowMigrationRecoveryAutoStart: input.contract.attachment_strategy === 'owned-recovery' || input.contract.terminal_attempt_lease !== 'no-retained-terminal-attempt-lease' });
  const recoverySupervisor = new DurableRunSupervisorClient(env, { allowMigrationRecoveryAutoStart: true });
  const actionResults: ActionResult[] = [];
  const blockers: CorpusBlocker[] = [];
  let attachment: RunSupervisorAttachment | null = null;
  let recoveryBlocked: Readonly<Record<string, unknown>> | null = null;
  try {
    if (input.contract.attachment_strategy === 'owned-recovery') {
      const recovered = await proveOwnedRecoveryPath(supervisor, recoverySupervisor, input, env);
      attachment = recovered.attachment;
      recoveryBlocked = recovered.recoveryBlocked;
      actionResults.push(actionRow(input, 'attach', { run_status: attachment.run.status, session_generation: attachment.session.session_generation, attachment_kind: attachment.session.attachment_kind, ...recovered.evidence }));
    } else {
      const terminalRecovery = await proveTerminalAttemptRecovery(recoverySupervisor, input);
      attachment = await attachDispatch(supervisor, input);
      actionResults.push(actionRow(input, 'attach', { strategy: 'safe-attachment', run_status: attachment.run.status, session_generation: attachment.session.session_generation, attachment_kind: attachment.session.attachment_kind, terminal_recovery: terminalRecovery }));
    }
  } catch (error) {
    blockers.push(blocker(input, 'attach', error));
    return Object.freeze({ action_results: Object.freeze(actionResults), new_blockers: Object.freeze(blockers) });
  }

  try {
    const doctor = await supervisor.client.query('doctor', input.active.repo_key, input.active.workstream_run);
    const findings = doctor.payload['invariant_findings'];
    const invariantErrorCount = doctor.payload['invariant_error_count'];
    if (doctor.payload['healthy'] !== true || invariantErrorCount !== 0 || !Array.isArray(findings) || findings.length !== 0) {
      blockers.push(blocker(input, 'doctor', new Error(`doctor unhealthy or invariant errors present: healthy=${String(doctor.payload['healthy'])} invariant_error_count=${String(invariantErrorCount)} findings=${Array.isArray(findings) ? String(findings.length) : 'malformed'}`)));
      return Object.freeze({ action_results: Object.freeze(actionResults), new_blockers: Object.freeze(blockers) });
    }
    actionResults.push(actionRow(input, 'doctor', { healthy: true, invariant_error_count: 0, expected_authority_block: expectedAuthorityBlocked(input) }));
  } catch (error) {
    blockers.push(blocker(input, 'doctor', error));
    return Object.freeze({ action_results: Object.freeze(actionResults), new_blockers: Object.freeze(blockers) });
  }

  try {
    if (attachment.session.attachment_kind === 'migration-recovery') {
      const pendingAfterRecovery = await pendingMigrationRecovery(recoverySupervisor, input);
      if (pendingAfterRecovery.length !== 0) throw new Error('migration recovery after-proof found pending rows before reconcile action coverage');
      actionResults.push(actionRow(input, 'reconcile', { recovery_only_after_proof: true, pending_migration_recovery_after: 0, terminal_attempt_lease: input.contract.terminal_attempt_lease, recovery_blocked: recoveryBlocked }));
    } else {
    const response = await supervisor.client.mutate('reconcile-run', {
      repoId: attachment.context.repo_id,
      workstreamRun: attachment.context.workstream_run,
      sessionId: attachment.session.session_id,
      fencingGeneration: attachment.session.session_generation,
      expectedVersion: attachment.context.run_version,
      idempotencyKey: `s2-d-candidate-reconcile:${attachment.session.session_lease_id}:${randomUUID()}`,
    }, { reason: 'S2-D candidate rehearsal owned-run reconciliation', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
    await supervisor.consumeReconciliationReceipt(response, attachment.context);
    actionResults.push(actionRow(input, 'reconcile', { committed_event_seq: response.committed_event_seq, reconciliation_receipt: response.payload['reconciliation_receipt'] ?? null, terminal_attempt_lease: input.contract.terminal_attempt_lease, recovery_blocked: recoveryBlocked }));
    }
  } catch (error) {
    if (expectedAuthorityBlocked(input)) actionResults.push(actionRow(input, 'reconcile', { expected_authority_block: true, reconcile_block: errorEvidence(error), terminal_attempt_lease: input.contract.terminal_attempt_lease, recovery_blocked: recoveryBlocked }));
    else blockers.push(blocker(input, 'reconcile', error));
  }

  try {
    const dispatchEnv: ProcessEnvLike = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
    let d65Runtime: boolean | null = null;
    let dispatchBlock: Readonly<Record<string, unknown>> | null = null;
    if (attachment.session.attachment_kind === 'migration-recovery') {
      dispatchBlock = { recovery_only_after_proof: true, pending_migration_recovery_after: (await pendingMigrationRecovery(recoverySupervisor, input)).length };
    } else if (expectedAuthorityBlocked(input)) {
      try { await recoverOwnedWorktreeSagas({ active: input.active, env: dispatchEnv }); }
      catch (error) { dispatchBlock = errorEvidence(error); }
      if (dispatchBlock === null) throw new Error('authority-version mismatch did not block the dispatch recovery probe');
    } else d65Runtime = await assertD65OrdinaryBoundaryFromEnvironment('parent-model-spawn', dispatchEnv);
    const client = new CoordinatorClient({ env, allowMigrationRecoveryAutoStart: attachment.session.attachment_kind === 'migration-recovery' });
    const status = await client.query('status', input.active.repo_key, input.active.workstream_run);
    actionResults.push(actionRow(input, 'dispatch-dry-run', { d65_runtime: d65Runtime, dispatch_block: dispatchBlock, coordinator_time: status.payload['coordinator_time'] ?? null }));
  } catch (error) {
    if (expectedAuthorityBlocked(input)) actionResults.push(actionRow(input, 'dispatch-dry-run', { expected_authority_block: true, dispatch_block: errorEvidence(error) }));
    else blockers.push(blocker(input, 'dispatch-dry-run', error));
  }

  try { await detach(supervisor, attachment); }
  catch (error) { blockers.push(blocker(input, 'detach', error)); }

  return Object.freeze({ action_results: Object.freeze(actionResults.sort((left, right) => left.action < right.action ? -1 : left.action > right.action ? 1 : 0)), new_blockers: Object.freeze(blockers) });
}

const inputPath = process.argv[2];
if (inputPath === undefined) throw new Error('usage: candidate-worker <input-json>');
const input = inputFromJson(JSON.parse(await readFile(inputPath, 'utf8')) as unknown);
const preexistingCloneCoordinator = readLifecycleCandidate(input.state_root);
let failure: unknown = null;
try {
  const output = await execute(input);
  process.stdout.write(`${canonicalJson(output)}\n`);
} catch (error) { failure = error; }
try { await stopCloneCoordinator(input.state_root, preexistingCloneCoordinator); }
catch (cleanupError) { failure = failure === null ? cleanupError : new AggregateError([failure, cleanupError], 'S2-D candidate worker failed and clone coordinator cleanup also failed'); }
if (failure !== null) throw failure;
