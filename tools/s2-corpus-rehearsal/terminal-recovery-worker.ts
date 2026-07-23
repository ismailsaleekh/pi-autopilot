import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { parseCoordinationEditLease, parseCoordinationUnitAttempt } from '../../src/core/coordination/contracts.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { DurableRunSupervisorClient, type RunSupervisorAttachment } from '../../src/core/coordination/supervisor.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ActiveAutopilotRow, type AutopilotRepoIdentity, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import type { DurableRunContract, Sha256Digest } from './contracts.ts';

interface WorkerInput {
  readonly state_root: string;
  readonly corpus_id: string;
  readonly run_id_sha256: Sha256Digest;
  readonly repo_id_sha256: Sha256Digest;
  readonly repo: AutopilotRepoIdentity;
  readonly active: ActiveAutopilotRow;
  readonly contract: DurableRunContract;
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

function parseRepo(value: unknown): AutopilotRepoIdentity {
  const row = record(value, 'repo');
  return Object.freeze({ repoRoot: text(row['repoRoot'], 'repo.repoRoot'), gitCommonDir: text(row['gitCommonDir'], 'repo.gitCommonDir'), repoKey: text(row['repoKey'], 'repo.repoKey'), headSha: text(row['headSha'], 'repo.headSha'), targetBranch: nullableText(row['targetBranch'], 'repo.targetBranch'), originUrl: nullableText(row['originUrl'], 'repo.originUrl') });
}

function parseActive(value: unknown): ActiveAutopilotRow {
  const row = record(value, 'active');
  return Object.freeze({
    schema_version: 'autopilot.active_parent.v2', coordination_authority: row['coordination_authority'] === 'coordinator-edit-leases-v1' ? 'coordinator-edit-leases-v1' : 'legacy-path-claims-v1',
    autopilot_id: text(row['autopilot_id'], 'active.autopilot_id'), workstream: text(row['workstream'], 'active.workstream'), workstream_run: text(row['workstream_run'], 'active.workstream_run'), repo_key: text(row['repo_key'], 'active.repo_key'),
    source_repo: text(row['source_repo'], 'active.source_repo'), git_common_dir: text(row['git_common_dir'], 'active.git_common_dir'), worktree_root: text(row['worktree_root'], 'active.worktree_root'), main_worktree_path: text(row['main_worktree_path'], 'active.main_worktree_path'), branch: text(row['branch'], 'active.branch'), runtime_root: text(row['runtime_root'], 'active.runtime_root'),
    target_branch: nullableText(row['target_branch'], 'active.target_branch'), target_base_sha: text(row['target_base_sha'], 'active.target_base_sha'), origin_url: nullableText(row['origin_url'], 'active.origin_url'), pid: integer(row['pid'], 'active.pid', 1), boot_id: text(row['boot_id'], 'active.boot_id'),
    status: row['status'] === 'closed' ? 'closed' : row['status'] === 'paused' ? 'paused' : row['status'] === 'blocked' ? 'blocked' : row['status'] === 'crashed' ? 'crashed' : row['status'] === 'merging' ? 'merging' : 'active', started_at: text(row['started_at'], 'active.started_at'), active_run_epoch: integer(row['active_run_epoch'], 'active.active_run_epoch', 1), active_epoch_started_at: text(row['active_epoch_started_at'], 'active.active_epoch_started_at'), active_run_receipt_id: text(row['active_run_receipt_id'], 'active.active_run_receipt_id'),
  });
}

function parseInput(value: unknown): WorkerInput {
  const row = record(value, 'terminal recovery worker input');
  const contract = record(row['contract'], 'contract') as unknown as DurableRunContract;
  return Object.freeze({ state_root: text(row['state_root'], 'state_root'), corpus_id: text(row['corpus_id'], 'corpus_id'), run_id_sha256: sha(row['run_id_sha256'], 'run_id_sha256'), repo_id_sha256: sha(row['repo_id_sha256'], 'repo_id_sha256'), repo: parseRepo(row['repo']), active: parseActive(row['active']), contract });
}

async function detach(supervisor: DurableRunSupervisorClient, attachment: RunSupervisorAttachment): Promise<void> {
  await supervisor.client.mutate('detach-session', {
    repoId: attachment.context.repo_id, workstreamRun: attachment.context.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.session.version, idempotencyKey: `s2-d-terminal-recovery-detach:${attachment.session.session_lease_id}`,
  }, { reason: 'S2-D terminal recovery subprocess completed', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
  await unlink(attachment.contextPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  });
}

async function terminalAttemptLeaseCount(supervisor: DurableRunSupervisorClient, input: WorkerInput): Promise<number> {
  const status = await supervisor.client.query('status', input.active.repo_key, input.active.workstream_run);
  const attempts = status.payload['unit_attempts'];
  const leases = status.payload['edit_leases'];
  if (!Array.isArray(attempts) || !Array.isArray(leases)) throw new Error('terminal recovery status omitted proof tables');
  const terminalOwners = new Set(attempts.map((value) => parseCoordinationUnitAttempt(value)).filter((attempt) => ['merged', 'failed', 'reset', 'quarantined', 'superseded'].includes(attempt.state)).map((attempt) => `${attempt.owner.unit_id}\0${String(attempt.owner.attempt)}`));
  return leases.map((value) => parseCoordinationEditLease(value)).filter((lease) => terminalOwners.has(`${lease.owner.unit_id}\0${String(lease.owner.attempt)}`)).length;
}

async function execute(input: WorkerInput): Promise<Readonly<Record<string, unknown>>> {
  if (input.contract.terminal_attempt_lease === 'no-retained-terminal-attempt-lease') throw new Error('terminal recovery subprocess requires a retained terminal-attempt lease contract');
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: input.state_root };
  const supervisor = new DurableRunSupervisorClient(env, { allowMigrationRecoveryAutoStart: true });
  const before = await terminalAttemptLeaseCount(supervisor, input);
  if (before === 0) return Object.freeze({ recovery_kind: 'terminal-attempt-lease', before_retained_terminal_attempt_leases: 0, after_retained_terminal_attempt_leases: 0, recovery_attachment: 'already-clear', recovery_generation: null, pid: process.pid });
  const recoveryAttachment = await supervisor.attachTerminalRecovery({ repo: input.repo, active: input.active, rawSessionId: `s2-d-terminal-recovery-subprocess-${input.active.workstream_run}-${randomUUID()}` });
  try {
    const after = await terminalAttemptLeaseCount(supervisor, input);
    if (after !== 0) throw new Error(`terminal recovery left ${String(after)} retained terminal-attempt edit leases`);
    return Object.freeze({ recovery_kind: 'terminal-attempt-lease', before_retained_terminal_attempt_leases: before, after_retained_terminal_attempt_leases: after, recovery_attachment: recoveryAttachment.session.attachment_kind, recovery_generation: recoveryAttachment.session.session_generation, pid: process.pid, evidence_sha256: digestBytes(canonicalJson({ before, after, attachment_kind: recoveryAttachment.session.attachment_kind, generation: recoveryAttachment.session.session_generation })) });
  } finally {
    if (recoveryAttachment.session.status === 'attached') await detach(supervisor, recoveryAttachment);
  }
}

const inputPath = process.argv[2];
if (inputPath === undefined) throw new Error('usage: terminal-recovery-worker <input-json>');
await execute(parseInput(JSON.parse(await readFile(inputPath, 'utf8')) as unknown))
  .then((output) => { process.stdout.write(`${canonicalJson(output)}\n`); })
  .catch((error: unknown) => { process.stderr.write(`S2-D terminal recovery subprocess failed: ${error instanceof CoordinationRuntimeError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
