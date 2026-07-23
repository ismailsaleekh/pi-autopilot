import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readStableRegularFile, recordCoordinatorReleaseEvidenceFromFile } from './coordination/reconciliation.ts';
import { currentUnitFailureProducerProvenance, type CurrentUnitFailureProducerProvenance } from './coordination/unit-failure-producer-provenance.ts';
import { ensureD65WorktreeStageCadenceFromEnvironment } from './coordination/d65-graph-successor-runtime.ts';
import { CoordinatorClient } from './coordination/client.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationChildLease, parseCoordinationEditLease, parseCoordinationReconciliationEvidence, parseCoordinationRunResource, parseCoordinationUnitAttempt, parseCoordinationWorktree, parseCoordinationWorktreeOperation } from './coordination/contracts.ts';
import { CoordinationRuntimeError } from './coordination/failures.ts';
import { readCoordinatorSessionContext } from './coordination/supervisor.ts';
import { parseAutopilotChildTerminalAcceptance } from './coordination/terminal-acceptance.ts';
import { classifyHistoricalUnitFailureEvidenceGeneration, parseHistoricalUnitFailureRegenerationCandidate, parseUnitFailureEvidenceFacts, type ReconciliationEvidenceIdentity } from './coordination/terminal-evidence.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from './names.ts';
import { gitHead, readGitStatus, releaseClaimsForUnit, updateUnitBranchStatus, writeJsonAtomic, type ActiveAutopilotContext, type ProcessEnvLike } from './parallel-runtime.ts';
import { gitQueryNulStrings, gitQueryText, runGitMutation, runGitQuery } from './git-process.ts';
import { cleanupTerminalUnitWorktree } from './worktree-cleanup.ts';
import { executeOwnedWorktreeSaga } from './coordination/worktree-saga.ts';
import type { CoordinationWorktree, CoordinationWorktreeOperation } from './coordination/types.ts';
import { inspectWorktreePostcondition } from './coordination/worktree-postconditions.ts';
import { deterministicWorktreeId } from './coordination/worktree-identity.ts';

export type AutopilotUnitFailureAction = 'quarantine' | 'reset' | 'preserve' | 'abort';

const MAX_UNIT_FAILURE_EVIDENCE_BYTES = 1024 * 1024;
const CURRENT_UNIT_FAILURE_PRODUCER_PROVENANCE = currentUnitFailureProducerProvenance();

export interface AutopilotUnitFailureRecord {
  readonly schema_version: 'autopilot.unit_failure.v1';
  readonly producer_build: CurrentUnitFailureProducerProvenance['producer_build'];
  readonly producer_generation: CurrentUnitFailureProducerProvenance['producer_generation'];
  readonly action: AutopilotUnitFailureAction;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly unit_id: string;
  readonly attempt: number;
  readonly unit_worktree_path: string;
  readonly dirty_paths: readonly string[];
  readonly capture_commit_sha: string | null;
  readonly capture_ref: string | null;
  readonly git_head_before: string;
  readonly git_head_after: string;
  readonly git_common_dir: string;
  readonly branch: string;
  readonly postcondition_worktree_clean: true;
  readonly summary: string;
  readonly created_at: string;
}

interface UnitFailureInput {
  readonly context: ActiveAutopilotContext;
  readonly unitId: string;
  readonly attempt: number;
  readonly unitWorktreePath: string;
  readonly summary: string;
  readonly now?: Date;
  readonly env?: ProcessEnvLike;
  readonly baselineHead?: string;
}

interface PublishedUnitFailureRecord {
  readonly record: AutopilotUnitFailureRecord;
  readonly evidencePath: string;
}

export function latestCommittedQuarantineOperationForWorktree(
  worktree: CoordinationWorktree,
  operations: readonly CoordinationWorktreeOperation[],
): Extract<CoordinationWorktreeOperation, { readonly operation_type: 'quarantine' }> | null {
  const canonicalWorktreeId = deterministicWorktreeId(worktree.owner, worktree.kind);
  if (worktree.worktree_id !== canonicalWorktreeId) throw new CoordinationRuntimeError('invalid-state', 'retained failed-unit reconciliation requires the current canonical worktree projection', [worktree.worktree_id, canonicalWorktreeId]);
  return operations.filter((candidate): candidate is Extract<CoordinationWorktreeOperation, { readonly operation_type: 'quarantine' }> => {
    const candidateKind = candidate.owner.unit_id === 'main' ? 'main' : 'unit';
    return deterministicWorktreeId(candidate.owner, candidateKind) === canonicalWorktreeId
      && candidate.owner.repo_id === worktree.owner.repo_id
      && candidate.owner.autopilot_id === worktree.owner.autopilot_id
      && candidate.owner.workstream_run === worktree.owner.workstream_run
      && candidate.owner.unit_id === worktree.owner.unit_id
      && candidate.owner.attempt === worktree.owner.attempt
      && candidate.operation_type === 'quarantine'
      && candidate.stage === 'committed';
  }).sort((left, right) => right.intent_event_seq - left.intent_event_seq || left.operation_id.localeCompare(right.operation_id))[0] ?? null;
}

export async function reconcileRetainedFailedUnitAuthority(input: {
  readonly context: ActiveAutopilotContext;
  readonly env?: ProcessEnvLike;
}): Promise<readonly AutopilotUnitFailureRecord[]> {
  if (input.context.active.coordination_authority !== 'coordinator-edit-leases-v1') return Object.freeze([]);
  const env = input.env ?? process.env;
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('unauthorized-client', 'retained failed-unit authority reconciliation requires the owner durable session');
  const session = await readCoordinatorSessionContext(contextPath);
  if (session.repo_id !== input.context.active.repo_key || session.autopilot_id !== input.context.active.autopilot_id || session.workstream_run !== input.context.active.workstream_run) throw new CoordinationRuntimeError('unauthorized-client', 'retained failed-unit authority does not belong to the attached run');
  const status = await new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }).query('status', session.repo_id, session.workstream_run);
  const array = (value: unknown, label: string): readonly unknown[] => {
    if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `coordinator status ${label} is not an array`);
    return value;
  };
  const attempts = array(status.payload['unit_attempts'], 'unit_attempts').map(parseCoordinationUnitAttempt);
  const children = array(status.payload['child_leases'], 'child_leases').map(parseCoordinationChildLease);
  const leases = array(status.payload['edit_leases'], 'edit_leases').map(parseCoordinationEditLease);
  const worktrees = array(status.payload['worktrees'], 'worktrees').map(parseCoordinationWorktree);
  const operations = array(status.payload['worktree_operations'], 'worktree_operations').map(parseCoordinationWorktreeOperation);
  const processed = new Set<string>();
  const records: AutopilotUnitFailureRecord[] = [];
  for (const lease of leases) {
    const ownerKey = `${lease.owner.unit_id}\0${String(lease.owner.attempt)}`;
    if (processed.has(ownerKey)) continue;
    const attempt = attempts.find((candidate) => candidate.owner.unit_id === lease.owner.unit_id && candidate.owner.attempt === lease.owner.attempt);
    const child = children.find((candidate) => candidate.owner.unit_id === lease.owner.unit_id && candidate.owner.attempt === lease.owner.attempt);
    if (attempt === undefined) throw new CoordinationRuntimeError('invalid-state', 'retained edit authority has no exact durable attempt owner', [lease.edit_lease_id]);
    if (attempt.role !== 'implement' && attempt.role !== 'fix') continue;
    if (child === undefined) {
      if (attempt.state === 'running' || attempt.state === 'preflight') continue;
      throw new CoordinationRuntimeError('recovery-required', 'terminal source-changing attempt retains edit authority without its child process fact', [lease.edit_lease_id, attempt.state]);
    }
    if (child.status !== 'terminal' && child.status !== 'recovery-required') continue;
    if (child.status === 'terminal') {
      const verdict = await acceptedTerminalVerdict(input.context, child, attempt.role);
      if (verdict === 'DONE') continue;
      if (verdict !== 'NEEDS_FIX' && verdict !== 'BLOCKED') throw new CoordinationRuntimeError('invalid-state', 'source-changing terminal acceptance has an invalid recovery verdict', [child.child_lease_id, verdict]);
    }
    const worktree = worktrees.find((candidate) => candidate.kind === 'unit' && candidate.owner.unit_id === lease.owner.unit_id && candidate.owner.attempt === lease.owner.attempt && candidate.state !== 'removed');
    if (worktree === undefined) throw new CoordinationRuntimeError('recovery-required', 'terminal source-changing attempt retains edit authority without one recoverable registered unit worktree', [lease.edit_lease_id, child.child_lease_id]);
    if (worktree.state === 'quarantined') {
      const operation = latestCommittedQuarantineOperationForWorktree(worktree, operations);
      if (operation === null) throw new CoordinationRuntimeError('recovery-required', 'quarantined retained authority lacks its committed capture operation', [worktree.worktree_id]);
      records.push(await finishCommittedQuarantine({ context: input.context, unitId: lease.owner.unit_id, attempt: lease.owner.attempt, unitWorktreePath: worktree.canonical_path, summary: 'resume immutable quarantine publication for retained failed-attempt authority', env }, operation));
      processed.add(ownerKey);
      continue;
    }
    let metadata: unknown;
    try { metadata = JSON.parse(await readFile(join(dirname(worktree.canonical_path), '_unit-info.json'), 'utf8')) as unknown; }
    catch (error) { throw new CoordinationRuntimeError('recovery-required', 'retained failed-unit authority lacks readable owned unit metadata', [worktree.canonical_path, error instanceof Error ? error.message : String(error)]); }
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw new CoordinationRuntimeError('invalid-state', 'owned unit metadata is not an object', [worktree.canonical_path]);
    const unitInfo = metadata as Readonly<Record<string, unknown>>;
    const baseSha = unitInfo['base_sha'];
    if (unitInfo['unit_id'] !== lease.owner.unit_id || unitInfo['attempt'] !== lease.owner.attempt || unitInfo['worktree_path'] !== worktree.canonical_path || typeof baseSha !== 'string' || !/^[a-f0-9]{7,64}$/u.test(baseSha)) throw new CoordinationRuntimeError('invalid-state', 'owned unit metadata identity disagrees with retained authority', [worktree.canonical_path]);
    const cleanUnchanged = existsSync(worktree.canonical_path) && readGitStatus(worktree.canonical_path).changedPaths.length === 0 && gitHead(worktree.canonical_path) === baseSha;
    const failureInput = { context: input.context, unitId: lease.owner.unit_id, attempt: lease.owner.attempt, unitWorktreePath: worktree.canonical_path, summary: cleanUnchanged ? 'automatic clean failed-attempt reset during retained-authority reconciliation' : 'automatic immutable quarantine capture during retained-authority reconciliation', baselineHead: baseSha, env };
    records.push(cleanUnchanged ? await resetFailedUnit(failureInput) : await quarantineFailedUnit(failureInput));
    processed.add(ownerKey);
  }
  return Object.freeze(records);
}

export async function acceptedTerminalVerdict(context: ActiveAutopilotContext, child: ReturnType<typeof parseCoordinationChildLease>, expectedRole: 'implement' | 'fix'): Promise<string> {
  if (child.terminal_evidence === null) throw new CoordinationRuntimeError('recovery-required', 'terminal source-changing child lacks accepted terminal evidence', [child.child_lease_id]);
  const path = resolve(context.active.main_worktree_path, child.terminal_evidence.ref);
  const inside = relative(context.active.main_worktree_path, path);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance evidence escapes the owned main worktree', [child.terminal_evidence.ref]);
  const bytes = await readFile(path);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== child.terminal_evidence.sha256) throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance evidence hash differs from coordinator authority', [child.child_lease_id, child.terminal_evidence.ref]);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch (error) { throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance evidence is not valid JSON', [child.terminal_evidence.ref, error instanceof Error ? error.message : String(error)]); }
  const acceptance = parseAutopilotChildTerminalAcceptance(value);
  if (acceptance.repo_id !== child.owner.repo_id || acceptance.autopilot_id !== child.owner.autopilot_id || acceptance.workstream_run !== child.owner.workstream_run || acceptance.unit_id !== child.owner.unit_id || acceptance.attempt !== child.owner.attempt || acceptance.child_lease_id !== child.child_lease_id || acceptance.role !== expectedRole) throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance identity differs from retained child authority', [child.child_lease_id]);
  return acceptance.verdict;
}

export async function quarantineFailedUnit(input: UnitFailureInput): Promise<AutopilotUnitFailureRecord> {
  const publication = await writeFailureRecord({ ...input, action: 'quarantine' });
  const { record } = publication;
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: record.git_head_after, archiveRef: record.capture_ref, env: input.env ?? process.env, recovery: 'unit-recovery' });
  await recordFailureEvidence(input, publication, 'quarantine-capture');
  await ensureD65WorktreeStageCadenceFromEnvironment(input.env ?? process.env);
  await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit quarantine');
  return record;
}

async function committedQuarantineCaptureProof(input: UnitFailureInput, operation: Extract<CoordinationWorktreeOperation, { readonly operation_type: 'quarantine' }>): Promise<{ readonly captureSha: string; readonly proofSource: 'physical-worktree' | 'owned-git-ref' }> {
  const canonicalId = deterministicWorktreeId(operation.owner, 'unit');
  const inspection = inspectWorktreePostcondition({ operationType: 'quarantine', owner: operation.owner, kind: 'unit', canonicalWorktreeId: canonicalId, intent: operation.intent, env: input.env ?? process.env });
  if (inspection.outcome !== 'satisfied' || inspection.capture_sha === null || (inspection.proof_source !== 'physical-worktree' && inspection.proof_source !== 'owned-git-ref')) throw new CoordinationRuntimeError('recovery-required', 'committed quarantine no longer has exact canonical capture proof', inspection.proof);
  const evidence = operation.verification_evidence;
  if (evidence === null) throw new CoordinationRuntimeError('recovery-required', 'committed quarantine lacks immutable canonical verification evidence', [operation.operation_id]);
  const expectedRef = `_saga-evidence/${operation.owner.workstream_run}/${operation.operation_id}.json`;
  if (evidence.ref !== expectedRef) throw new CoordinationRuntimeError('invalid-state', 'committed quarantine verification evidence ref is not operation-bound', [evidence.ref, expectedRef]);
  const evidencePath = resolve(input.context.active.worktree_root, ...evidence.ref.split('/'));
  const bytes = await readStableRegularFile(evidencePath, 'committed quarantine canonical evidence', MAX_UNIT_FAILURE_EVIDENCE_BYTES);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== evidence.sha256) throw new CoordinationRuntimeError('invalid-state', 'committed quarantine verification evidence digest changed', [evidence.ref]);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch (error) { throw new CoordinationRuntimeError('invalid-state', 'committed quarantine verification evidence is invalid JSON', [evidence.ref, error instanceof Error ? error.message : String(error)]); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'committed quarantine verification evidence is not an object', [evidence.ref]);
  if (Reflect.get(value, 'operation_id') !== operation.operation_id || Reflect.get(value, 'terminal_stage') !== 'verified' || Reflect.get(value, 'capture_sha') !== inspection.capture_sha || Reflect.get(value, 'proof_source') !== inspection.proof_source) throw new CoordinationRuntimeError('invalid-state', 'committed quarantine immutable evidence disagrees with current exact capture proof', [operation.operation_id]);
  return { captureSha: inspection.capture_sha, proofSource: inspection.proof_source };
}

async function finishCommittedQuarantine(input: UnitFailureInput, operation: Extract<CoordinationWorktreeOperation, { readonly operation_type: 'quarantine' }>): Promise<AutopilotUnitFailureRecord> {
  if (operation.owner.repo_id !== input.context.active.repo_key || operation.owner.autopilot_id !== input.context.active.autopilot_id || operation.owner.workstream_run !== input.context.active.workstream_run || operation.owner.unit_id !== input.unitId || operation.owner.attempt !== input.attempt || resolve(operation.intent.worktree_path) !== resolve(input.unitWorktreePath)) throw new CoordinationRuntimeError('invalid-state', 'committed quarantine operation identity differs from retained authority ownership', [operation.operation_id]);
  const captureProof = await committedQuarantineCaptureProof(input, operation);
  const facts: OwnedFailureWorktreeFacts = existsSync(input.unitWorktreePath) ? inspectOwnedFailureWorktree(input) : {
    head: captureProof.captureSha,
    branch: operation.intent.branch,
    gitCommonDir: operation.intent.git_common_dir,
    mutablePaths: Object.freeze([]),
    ignoredPaths: Object.freeze([]),
  };
  if (facts.mutablePaths.length > 0) throw new CoordinationRuntimeError('recovery-required', 'committed quarantine worktree regained mutable residue before evidence publication', facts.mutablePaths.slice(0, 128));
  const baseSha = operation.intent.base_sha;
  const preCaptureHead = operation.intent.target_sha;
  if (baseSha === null || preCaptureHead === null) throw new CoordinationRuntimeError('recovery-required', 'committed quarantine operation lacks exact baseline and pre-capture heads', [operation.operation_id]);
  if (operation.intent.paths.length === 0 && (facts.head !== preCaptureHead || facts.head === baseSha)) throw new CoordinationRuntimeError('recovery-required', 'clean committed quarantine does not prove source commits after the attempt baseline', [operation.operation_id, baseSha, preCaptureHead, facts.head]);
  const ancestor = runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor: baseSha, descendant: facts.head }, cwd: input.context.active.source_repo });
  if (ancestor.negative) throw new CoordinationRuntimeError('recovery-required', 'committed quarantine capture is not an inspectable descendant of its pre-capture head', [baseSha, facts.head]);
  const capturedPaths = gitQueryNulStrings({ descriptor: { kind: 'diff-paths', from: baseSha, to: facts.head, noRenames: true }, cwd: input.context.active.source_repo }).map((path) => path.replace(/\\/gu, '/'));
  const expectedPaths = [...operation.intent.paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const actualPaths = [...capturedPaths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (expectedPaths.length !== actualPaths.length || expectedPaths.some((path, index) => path !== actualPaths[index])) throw new CoordinationRuntimeError('recovery-required', 'committed quarantine capture path set differs from immutable intent', [...expectedPaths.map((path) => `expected=${path}`), ...actualPaths.map((path) => `actual=${path}`)]);
  const action: 'quarantine' | 'preserve' = operation.intent.reason.startsWith('preserve ') ? 'preserve' : 'quarantine';
  const captureRef = `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/${action}-capture`;
  await archiveFailureBranch(input, facts.head, captureRef, `${action} immutable failure capture recovery`, 'quarantined');
  const evidencePath = join(input.context.active.runtime_root, 'quarantine', `${input.unitId}.attempt-${String(input.attempt)}.${action}.json`);
  let record: AutopilotUnitFailureRecord;
  if (existsSync(evidencePath)) {
    let value: unknown;
    try { value = JSON.parse(await readFile(evidencePath, 'utf8')) as unknown; }
    catch (error) { throw new CoordinationRuntimeError('recovery-required', 'committed quarantine evidence is unreadable during publication recovery', [evidencePath, error instanceof Error ? error.message : String(error)]); }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'committed quarantine evidence is not an object', [evidencePath]);
    const candidate = value as Readonly<Record<string, unknown>>;
    const exactFields = ['schema_version', 'producer_build', 'producer_generation', 'action', 'workstream', 'workstream_run', 'unit_id', 'attempt', 'unit_worktree_path', 'dirty_paths', 'capture_commit_sha', 'capture_ref', 'git_head_before', 'git_head_after', 'git_common_dir', 'branch', 'postcondition_worktree_clean', 'summary', 'created_at'].sort();
    const actualFields = Object.keys(candidate).sort();
    const exact = actualFields.length === exactFields.length && actualFields.every((field, index) => field === exactFields[index]);
    const dirtyPaths = candidate['dirty_paths'];
    if (!exact || candidate['schema_version'] !== 'autopilot.unit_failure.v1' || candidate['producer_build'] !== CURRENT_UNIT_FAILURE_PRODUCER_PROVENANCE.producer_build || candidate['producer_generation'] !== CURRENT_UNIT_FAILURE_PRODUCER_PROVENANCE.producer_generation || candidate['action'] !== action || candidate['workstream'] !== input.context.active.workstream || candidate['workstream_run'] !== input.context.active.workstream_run || candidate['unit_id'] !== input.unitId || candidate['attempt'] !== input.attempt || resolve(String(candidate['unit_worktree_path'])) !== resolve(input.unitWorktreePath) || !Array.isArray(dirtyPaths) || dirtyPaths.some((path) => typeof path !== 'string') || candidate['capture_commit_sha'] !== facts.head || candidate['capture_ref'] !== captureRef || candidate['git_head_before'] !== preCaptureHead || candidate['git_head_after'] !== facts.head || resolve(String(candidate['git_common_dir'])) !== resolve(facts.gitCommonDir) || candidate['branch'] !== facts.branch || candidate['postcondition_worktree_clean'] !== true || typeof candidate['summary'] !== 'string' || typeof candidate['created_at'] !== 'string' || !Number.isFinite(Date.parse(candidate['created_at']))) throw new CoordinationRuntimeError('invalid-state', 'committed quarantine evidence differs from exact capture operation and worktree facts', [evidencePath]);
    record = {
      schema_version: 'autopilot.unit_failure.v1', ...CURRENT_UNIT_FAILURE_PRODUCER_PROVENANCE, action, workstream: input.context.active.workstream, workstream_run: input.context.active.workstream_run,
      unit_id: input.unitId, attempt: input.attempt, unit_worktree_path: input.unitWorktreePath, dirty_paths: dirtyPaths.map((path) => String(path)),
      capture_commit_sha: facts.head, capture_ref: captureRef, git_head_before: preCaptureHead, git_head_after: facts.head, git_common_dir: facts.gitCommonDir,
      branch: facts.branch, postcondition_worktree_clean: true, summary: String(candidate['summary']), created_at: String(candidate['created_at']),
    };
  } else {
    record = {
      schema_version: 'autopilot.unit_failure.v1', ...CURRENT_UNIT_FAILURE_PRODUCER_PROVENANCE, action, workstream: input.context.active.workstream, workstream_run: input.context.active.workstream_run,
      unit_id: input.unitId, attempt: input.attempt, unit_worktree_path: input.unitWorktreePath, dirty_paths: operation.intent.paths,
      capture_commit_sha: facts.head, capture_ref: captureRef, git_head_before: preCaptureHead, git_head_after: facts.head, git_common_dir: facts.gitCommonDir,
      branch: facts.branch, postcondition_worktree_clean: true, summary: input.summary, created_at: (input.now ?? new Date()).toISOString(),
    };
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeJsonAtomic(evidencePath, record);
  }
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: record.git_head_after, archiveRef: record.capture_ref, env: input.env ?? process.env, recovery: 'unit-recovery' });
  await recordFailureEvidence(input, { record, evidencePath }, 'quarantine-capture');
  await ensureD65WorktreeStageCadenceFromEnvironment(input.env ?? process.env);
  await releaseLegacyClaimsIfApplicable(input, 'autopilot resumed failed unit quarantine publication');
  return record;
}

async function resumeRemovedResetFailure(input: UnitFailureInput): Promise<AutopilotUnitFailureRecord> {
  if (input.context.active.coordination_authority !== 'coordinator-edit-leases-v1') throw new CoordinationRuntimeError('recovery-required', 'missing failed-unit worktree has no coordinator recovery authority', [input.unitWorktreePath]);
  const evidencePath = await failureEvidencePublicationPath(input, 'reset');
  if (!existsSync(evidencePath)) throw new CoordinationRuntimeError('recovery-required', 'missing failed-unit worktree has no immutable reset evidence', [input.unitWorktreePath, evidencePath]);
  const evidenceBytes = await readStableRegularFile(evidencePath, 'removed unit reset evidence', MAX_UNIT_FAILURE_EVIDENCE_BYTES);
  const facts = parseUnitFailureEvidenceFacts(evidenceBytes, failureEvidenceIdentity(input, 'reset'));
  if (facts.action !== 'reset' || resolve(facts.unitWorktreePath) !== resolve(input.unitWorktreePath) || realpathSync(facts.gitCommonDir) !== realpathSync(input.context.active.git_common_dir) || facts.branch !== `autopilot/unit/${input.context.active.workstream_run}/${input.unitId}/attempt-${String(input.attempt)}` || facts.gitHeadBefore !== facts.gitHeadAfter) throw new CoordinationRuntimeError('invalid-state', 'removed unit reset evidence differs from its exact clean owner identity', [evidencePath]);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(evidenceBytes)) as unknown; }
  catch (error) { throw new CoordinationRuntimeError('invalid-state', 'removed unit reset evidence is unreadable', [evidencePath, error instanceof Error ? error.message : String(error)]); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'removed unit reset evidence is not an object', [evidencePath]);
  const field = (name: string): unknown => Reflect.get(value, name);
  const dirtyPaths = field('dirty_paths');
  const summary = field('summary');
  const createdAt = field('created_at');
  if (!Array.isArray(dirtyPaths) || dirtyPaths.some((entry) => typeof entry !== 'string') || dirtyPaths.length !== 0 || typeof summary !== 'string' || summary.length === 0 || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new CoordinationRuntimeError('invalid-state', 'removed unit reset evidence has invalid bounded publication fields', [evidencePath]);
  const contextPath = (input.env ?? process.env)[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('unauthorized-client', 'removed unit reset recovery requires its durable coordinator session');
  const session = await readCoordinatorSessionContext(contextPath);
  if (session.repo_id !== input.context.active.repo_key || session.autopilot_id !== input.context.active.autopilot_id || session.workstream_run !== input.context.active.workstream_run) throw new CoordinationRuntimeError('unauthorized-client', 'removed unit reset recovery session differs from its exact owner');
  const status = await new CoordinatorClient({ env: input.env ?? process.env }).query('status', session.repo_id, session.workstream_run);
  const array = (candidate: unknown, label: string): readonly unknown[] => {
    if (!Array.isArray(candidate)) throw new CoordinationRuntimeError('invalid-state', `removed unit reset recovery status omitted ${label}`);
    return candidate;
  };
  const operations = array(status.payload['worktree_operations'], 'worktree_operations').map(parseCoordinationWorktreeOperation).filter((operation) => operation.owner.repo_id === session.repo_id && operation.owner.autopilot_id === session.autopilot_id && operation.owner.workstream_run === session.workstream_run && operation.owner.unit_id === input.unitId && operation.owner.attempt === input.attempt);
  const resetOperations = operations.filter((operation) => operation.operation_type === 'reset' && operation.stage === 'committed');
  const removeOperations = operations.filter((operation) => operation.operation_type === 'remove' && operation.stage !== 'compensated' && operation.stage !== 'failed');
  if (resetOperations.length !== 1 || removeOperations.length !== 1) throw new CoordinationRuntimeError('recovery-required', 'missing failed-unit worktree lacks one committed reset and one durable remove operation', [...resetOperations.map((operation) => operation.operation_id), ...removeOperations.map((operation) => operation.operation_id)]);
  const resetOperation = resetOperations[0];
  const removeOperation = removeOperations[0];
  if (resetOperation === undefined || removeOperation === undefined || !('worktree_path' in resetOperation.intent) || !('worktree_path' in removeOperation.intent) || resolve(resetOperation.intent.worktree_path) !== resolve(input.unitWorktreePath) || resolve(removeOperation.intent.worktree_path) !== resolve(input.unitWorktreePath) || resetOperation.intent.branch !== facts.branch || removeOperation.intent.branch !== facts.branch || resetOperation.intent.base_sha !== facts.gitHeadAfter || resetOperation.intent.target_sha !== facts.gitHeadAfter || resetOperation.intent.paths.length !== 0 || removeOperation.intent.target_sha !== facts.gitHeadAfter || removeOperation.intent_event_seq <= resetOperation.intent_event_seq) throw new CoordinationRuntimeError('invalid-state', 'durable reset/remove operations differ from immutable removed-unit evidence', [evidencePath]);
  const attempts = array(status.payload['unit_attempts'], 'unit_attempts').map(parseCoordinationUnitAttempt).filter((attempt) => attempt.owner.unit_id === input.unitId && attempt.owner.attempt === input.attempt);
  if (attempts.length !== 1 || attempts[0]?.state !== 'reset') throw new CoordinationRuntimeError('invalid-state', 'removed unit reset recovery lacks the exact released attempt state', attempts.map((attempt) => attempt.state));
  const worktrees = array(status.payload['worktrees'], 'worktrees').map(parseCoordinationWorktree).filter((worktree) => worktree.owner.unit_id === input.unitId && worktree.owner.attempt === input.attempt);
  if (worktrees.length !== 1 || (worktrees[0]?.state !== 'terminal' && worktrees[0]?.state !== 'removed') || resolve(worktrees[0].canonical_path) !== resolve(input.unitWorktreePath)) throw new CoordinationRuntimeError('invalid-state', 'removed unit reset recovery lacks the exact terminal canonical worktree projection');
  const evidenceRef = relative(input.context.active.main_worktree_path, evidencePath).replace(/\\/gu, '/');
  const evidenceSha256 = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
  const accepted = array(status.payload['reconciliation_evidence'], 'reconciliation_evidence').map(parseCoordinationReconciliationEvidence).filter((entry) => entry.source === 'attempt-reset' && entry.release_condition.target_id === `${input.unitId}:${String(input.attempt)}` && entry.release_condition.evidence?.ref === evidenceRef && entry.release_condition.evidence.sha256 === evidenceSha256);
  if (accepted.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'removed unit reset recovery lacks one exact accepted release-evidence row', [evidenceRef, evidenceSha256]);
  const record: AutopilotUnitFailureRecord = {
    schema_version: 'autopilot.unit_failure.v1', ...CURRENT_UNIT_FAILURE_PRODUCER_PROVENANCE, action: 'reset', workstream: input.context.active.workstream, workstream_run: input.context.active.workstream_run,
    unit_id: input.unitId, attempt: input.attempt, unit_worktree_path: facts.unitWorktreePath, dirty_paths: Object.freeze([]), capture_commit_sha: null, capture_ref: null,
    git_head_before: facts.gitHeadBefore, git_head_after: facts.gitHeadAfter, git_common_dir: facts.gitCommonDir, branch: facts.branch, postcondition_worktree_clean: true,
    summary, created_at: createdAt,
  };
  await cleanupTerminalUnitWorktree({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, allowedStatuses: ['aborted'], reason: 'autopilot failed unit reset cleanup', ...(input.env === undefined ? {} : { env: input.env }), ...(input.now === undefined ? {} : { now: input.now }) });
  return record;
}

export async function resetFailedUnit(input: UnitFailureInput): Promise<AutopilotUnitFailureRecord> {
  if (!existsSync(input.unitWorktreePath)) return await resumeRemovedResetFailure(input);
  const captured = await captureDirtyBeforeDestructiveTransition(input);
  if (captured !== null) return captured;
  await resetWorktreeForRecordedTransition(input, 'unit-reset', 'reset');
  const publication = await writeFailureRecord({ ...input, action: 'reset' });
  const { record } = publication;
  const currentSha = record.git_head_after;
  const archiveRef = null;
  await recordFailureEvidence(input, publication, 'attempt-reset');
  await ensureD65WorktreeStageCadenceFromEnvironment(input.env ?? process.env);
  await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit reset');
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef, env: input.env ?? process.env, recovery: 'unit-recovery' });
  await cleanupTerminalUnitWorktree({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, allowedStatuses: ['aborted'], reason: 'autopilot failed unit reset cleanup', ...(input.env === undefined ? {} : { env: input.env }), ...(input.now === undefined ? {} : { now: input.now }) });
  return record;
}

export async function preserveFailedUnit(input: UnitFailureInput): Promise<AutopilotUnitFailureRecord> {
  const publication = await writeFailureRecord({ ...input, action: 'preserve' });
  const { record } = publication;
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: record.git_head_after, archiveRef: record.capture_ref, env: input.env ?? process.env, recovery: 'unit-recovery' });
  await recordFailureEvidence(input, publication, 'quarantine-capture');
  await ensureD65WorktreeStageCadenceFromEnvironment(input.env ?? process.env);
  await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit preserve-after-quarantine-capture');
  return record;
}

export async function abortFailedUnit(input: UnitFailureInput): Promise<AutopilotUnitFailureRecord> {
  const captured = await captureDirtyBeforeDestructiveTransition(input);
  if (captured !== null) return captured;
  await resetWorktreeForRecordedTransition(input, 'unit-abort-reset', 'abort');
  const publication = await writeFailureRecord({ ...input, action: 'abort' });
  const { record } = publication;
  await recordFailureEvidence(input, publication, 'attempt-reset');
  await ensureD65WorktreeStageCadenceFromEnvironment(input.env ?? process.env);
  await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit abort');
  const currentSha = record.git_head_after;
  const archiveRef = `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/aborted`;
  await archiveFailureBranch(input, currentSha, archiveRef, 'unit abort preservation archive');
  await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef, env: input.env ?? process.env, recovery: 'unit-recovery' });
  await cleanupTerminalUnitWorktree({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, allowedStatuses: ['aborted'], reason: 'autopilot failed unit abort cleanup', ...(input.env === undefined ? {} : { env: input.env }), ...(input.now === undefined ? {} : { now: input.now }) });
  return record;
}

async function releaseLegacyClaimsIfApplicable(input: UnitFailureInput, reason: string): Promise<void> {
  if (input.context.active.coordination_authority === 'coordinator-edit-leases-v1') return;
  await releaseClaimsForUnit(releaseInput(input, reason));
}

async function archiveFailureBranch(input: UnitFailureInput, sha: string, archiveRef: string, reason: string, worktreeState: 'terminal' | 'quarantined' = 'terminal'): Promise<void> {
  const active = input.context.active;
  const branch = existsSync(input.unitWorktreePath) ? gitQueryText({ descriptor: { kind: 'current-branch' }, cwd: input.unitWorktreePath }).trim() : `autopilot/unit/${active.workstream_run}/${input.unitId}/attempt-${String(input.attempt)}`;
  await executeOwnedWorktreeSaga({
    active, unitId: input.unitId, attempt: input.attempt, kind: 'unit', operationType: 'archive',
    initialWorktreeState: worktreeState, committedWorktreeState: worktreeState,
    intent: {
      repo_root: active.source_repo, worktree_path: input.unitWorktreePath, git_common_dir: active.git_common_dir, branch,
      reason, base_sha: active.target_base_sha, target_sha: sha, archive_ref: archiveRef, checkout_mode: null,
      sparse_patterns: [], paths: [], metadata_refs: [],
    },
  }, {
    action: async () => { await runGitMutation({ descriptor: { kind: 'update-ref-create', ref: `refs/heads/${archiveRef}`, target: sha, expectedOld: '0'.repeat(40) }, cwd: active.source_repo, env: { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-failure-archive' } }); },
  }, input.env ?? process.env);
}

async function captureDirtyBeforeDestructiveTransition(input: UnitFailureInput): Promise<AutopilotUnitFailureRecord | null> {
  const facts = inspectOwnedFailureWorktree(input);
  if (facts.mutablePaths.length === 0) return null;
  return await quarantineFailedUnit({ ...input, summary: `automatic preservation before destructive transition: ${input.summary}` });
}

async function commitD65FailureEvidence(input: UnitFailureInput, publication: PublishedUnitFailureRecord): Promise<void> {
  const env = input.env ?? process.env;
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) return;
  const session = await readCoordinatorSessionContext(contextPath);
  const client = new CoordinatorClient({ env });
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const artifactsValue = status.payload['authoritative_artifacts'];
  const resourcesValue = status.payload['run_resources'];
  if (!Array.isArray(artifactsValue) || !Array.isArray(resourcesValue) || resourcesValue.length !== 1 || resourcesValue[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 unit failure evidence commit lacks one exact artifact/resource projection');
  const artifacts = artifactsValue.map(parseCoordinationAuthoritativeArtifact);
  const bootstrap = artifacts.some((artifact) => artifact.artifact_id === `semantic-graph-bootstrap:${session.workstream_run}` && artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1');
  const graphs = artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1').sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  if (!bootstrap) {
    if (graphs.length > 0) throw new CoordinationRuntimeError('invalid-state', 'complete graph exists without D65 bootstrap authority');
    return;
  }
  const graph = graphs[graphs.length - 1];
  if (graph === undefined) return;
  const resource = parseCoordinationRunResource(resourcesValue[0]);
  const evidenceRef = relative(resource.main_worktree_path, publication.evidencePath).replace(/\\/gu, '/');
  if (evidenceRef.length === 0 || evidenceRef === '..' || evidenceRef.startsWith('../') || isAbsolute(evidenceRef)) throw new CoordinationRuntimeError('unauthorized-client', 'unit failure evidence path escapes run-main authority', [publication.evidencePath]);
  const expectedBytes = await readFile(publication.evidencePath);
  const expectedDigest = `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`;
  let head = gitQueryText({ descriptor: { kind: 'head' }, cwd: resource.main_worktree_path }).trim();
  if (head === graph.git_commit) {
    const acceptedBytes = runGitQuery({ descriptor: { kind: 'show-file', revision: head, path: evidenceRef, allowAbsent: true }, cwd: resource.main_worktree_path });
    if (!acceptedBytes.negative) {
      const acceptedDigest = `sha256:${createHash('sha256').update(acceptedBytes.stdout).digest('hex')}`;
      if (acceptedDigest !== expectedDigest) throw new CoordinationRuntimeError('idempotency-conflict', 'accepted graph contains different unit failure evidence bytes', [evidenceRef, expectedDigest, acceptedDigest]);
      return;
    }
    if (runGitQuery({ descriptor: { kind: 'staged-clean' }, cwd: resource.main_worktree_path }).negative) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence refuses to commit over a nonempty shared index', [evidenceRef]);
    const gitEnv: ProcessEnvLike = { ...env, GIT_AUTHOR_NAME: 'autopilot-runtime', GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid', GIT_COMMITTER_NAME: 'autopilot-runtime', GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid', GIT_AUTHOR_DATE: publication.record.created_at, GIT_COMMITTER_DATE: publication.record.created_at };
    const staged = await runGitMutation({ descriptor: { kind: 'stage-paths', paths: [evidenceRef], sparse: true }, cwd: resource.main_worktree_path, env: gitEnv });
    if (staged.kind !== 'reported' || staged.exitCode !== 0) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence staging failed', [staged.kind === 'reported' ? staged.diagnostic : staged.reason]);
    const committed = await runGitMutation({ descriptor: { kind: 'commit', message: `autopilot: ${publication.record.action} unit failure evidence` }, cwd: resource.main_worktree_path, env: gitEnv });
    if (committed.kind !== 'reported' || committed.exitCode !== 0) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence commit failed', [committed.kind === 'reported' ? committed.diagnostic : committed.reason]);
    head = gitQueryText({ descriptor: { kind: 'head' }, cwd: resource.main_worktree_path }).trim();
  }
  const parents = gitQueryText({ descriptor: { kind: 'rev-list-parents', revision: head }, cwd: resource.main_worktree_path }).trim().split(/\s+/u).filter((entry) => entry.length > 0);
  const paths = gitQueryNulStrings({ descriptor: { kind: 'diff-paths', from: graph.git_commit, to: head, noRenames: true }, cwd: resource.main_worktree_path });
  const committedBytes = runGitQuery({ descriptor: { kind: 'show-file', revision: head, path: evidenceRef }, cwd: resource.main_worktree_path }).stdout;
  const committedDigest = `sha256:${createHash('sha256').update(committedBytes).digest('hex')}`;
  if (parents.length !== 2 || parents[1] !== graph.git_commit || paths.length !== 1 || paths[0] !== evidenceRef || committedDigest !== expectedDigest) throw new CoordinationRuntimeError('idempotency-conflict', 'unit failure evidence commit differs from its exact one-parent one-ref stage', [head, graph.git_commit, evidenceRef, expectedDigest, committedDigest]);
}

async function recordFailureEvidence(input: UnitFailureInput, publication: PublishedUnitFailureRecord, source: 'attempt-reset' | 'quarantine-capture'): Promise<void> {
  if (input.context.active.coordination_authority !== 'coordinator-edit-leases-v1') return;
  await commitD65FailureEvidence(input, publication);
  await recordCoordinatorReleaseEvidenceFromFile({
    active: input.context.active,
    source,
    targetId: `${input.unitId}:${String(input.attempt)}`,
    evidencePath: publication.evidencePath,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
}

async function resetWorktreeForRecordedTransition(input: UnitFailureInput, authority: string, action: 'reset' | 'abort'): Promise<void> {
  if (!existsSync(input.unitWorktreePath)) throw new CoordinationRuntimeError('recovery-required', 'owned failed-unit worktree is missing before reset; edit authority remains retained', [input.unitWorktreePath]);
  const active = input.context.active;
  const branch = gitQueryText({ descriptor: { kind: 'current-branch' }, cwd: input.unitWorktreePath }).trim();
  const target = gitHead(input.unitWorktreePath);
  await executeOwnedWorktreeSaga({
    active, unitId: input.unitId, attempt: input.attempt, kind: 'unit', operationType: 'reset',
    initialWorktreeState: 'active', committedWorktreeState: 'terminal',
    intent: {
      repo_root: active.source_repo, worktree_path: input.unitWorktreePath, git_common_dir: active.git_common_dir, branch,
      reason: `${action} failed unit after immutable failure evidence`, base_sha: target, target_sha: target, archive_ref: null,
      checkout_mode: null, sparse_patterns: [], paths: readGitStatus(input.unitWorktreePath).changedPaths, metadata_refs: [],
    },
  }, {
    action: async () => {
      await runGitMutation({ descriptor: { kind: 'reset-hard', target }, cwd: input.unitWorktreePath, env: { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: authority } });
    },
  }, input.env ?? process.env);
}

function releaseInput(input: Pick<UnitFailureInput, 'context' | 'unitId' | 'attempt' | 'now'>, reason: string): { readonly context: ActiveAutopilotContext; readonly unitId: string; readonly attempt: number; readonly reason: string; readonly now?: Date } {
  return input.now === undefined
    ? { context: input.context, unitId: input.unitId, attempt: input.attempt, reason }
    : { context: input.context, unitId: input.unitId, attempt: input.attempt, reason, now: input.now };
}

interface OwnedFailureWorktreeFacts {
  readonly head: string;
  readonly branch: string;
  readonly gitCommonDir: string;
  readonly mutablePaths: readonly string[];
  readonly ignoredPaths: readonly string[];
}

function parseFullStatus(output: string): { readonly mutablePaths: readonly string[]; readonly ignoredPaths: readonly string[] } {
  const records = output.split('\0');
  const mutable = new Set<string>();
  const ignored = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index];
    if (entry === undefined || entry.length === 0) continue;
    if (entry.length < 4 || entry[2] !== ' ') throw new CoordinationRuntimeError('invalid-state', 'quarantine Git status output is malformed', [entry]);
    const code = entry.slice(0, 2);
    const path = entry.slice(3).replace(/\\/gu, '/').replace(/\/$/u, '');
    if (path.length === 0) throw new CoordinationRuntimeError('invalid-state', 'quarantine Git status contains an empty path');
    mutable.add(path);
    if (code === '!!') ignored.add(path);
    if (code.includes('R') || code.includes('C')) {
      const second = records[index + 1];
      if (second === undefined || second.length === 0) throw new CoordinationRuntimeError('invalid-state', 'quarantine rename/copy status lacks its second path', [entry]);
      mutable.add(second.replace(/\\/gu, '/').replace(/\/$/u, ''));
      index += 1;
    }
  }
  return { mutablePaths: Object.freeze([...mutable].sort()), ignoredPaths: Object.freeze([...ignored].sort()) };
}

function inspectOwnedFailureWorktree(input: UnitFailureInput): OwnedFailureWorktreeFacts {
  if (!existsSync(input.unitWorktreePath)) throw new CoordinationRuntimeError('recovery-required', 'owned failed-unit worktree is missing; refusing to substitute a base SHA or release edit authority', [input.unitWorktreePath]);
  const root = realpathSync(input.unitWorktreePath);
  const top = realpathSync(gitQueryText({ descriptor: { kind: 'show-toplevel' }, cwd: input.unitWorktreePath }).trim());
  if (root !== top) throw new CoordinationRuntimeError('unauthorized-client', 'failed-unit worktree path is not its exact Git toplevel', [root, top]);
  const commonRaw = gitQueryText({ descriptor: { kind: 'git-common-dir' }, cwd: input.unitWorktreePath }).trim();
  const common = realpathSync(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
  const expectedCommon = realpathSync(input.context.active.git_common_dir);
  if (common !== expectedCommon) throw new CoordinationRuntimeError('unauthorized-client', 'failed-unit worktree belongs to a foreign Git common directory', [common, expectedCommon]);
  const branch = gitQueryText({ descriptor: { kind: 'current-branch' }, cwd: input.unitWorktreePath }).trim();
  const expectedBranch = `autopilot/unit/${input.context.active.workstream_run}/${input.unitId}/attempt-${String(input.attempt)}`;
  if (branch !== expectedBranch) throw new CoordinationRuntimeError('invalid-state', 'failed-unit worktree branch differs from deterministic durable ownership', [branch, expectedBranch]);
  const head = gitHead(input.unitWorktreePath);
  if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new CoordinationRuntimeError('invalid-state', 'failed-unit worktree HEAD is not a full Git object id', [head]);
  const status = parseFullStatus(gitQueryText({ descriptor: { kind: 'status-porcelain', includeIgnored: true }, cwd: input.unitWorktreePath }));
  return { head, branch, gitCommonDir: common, mutablePaths: status.mutablePaths, ignoredPaths: status.ignoredPaths };
}

function assertNoNestedRepositoryResidue(root: string, paths: readonly string[]): void {
  const pending = paths.map((path) => resolve(root, path));
  let inspected = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || !existsSync(current)) continue;
    const rel = relative(root, current);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CoordinationRuntimeError('unauthorized-client', 'quarantine candidate escapes its owned worktree', [current]);
    const stat = lstatSync(current);
    inspected += 1;
    if (inspected > 100_000) throw new CoordinationRuntimeError('recovery-required', 'quarantine candidate exceeds the bounded filesystem inspection ceiling', [`entries>${String(100_000)}`]);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') throw new CoordinationRuntimeError('recovery-required', 'quarantine cannot safely flatten nested repository or submodule metadata', [join(current, entry.name)]);
      pending.push(join(current, entry.name));
    }
  }
}

function configuredSubmodulePaths(cwd: string): readonly string[] {
  const result = runGitQuery({ descriptor: { kind: 'config-regexp', file: '.gitmodules', pattern: '^[.]?submodule[.].*[.]path$' }, cwd });
  if (result.negative) return Object.freeze([]);
  const output = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  return Object.freeze(output.split('\0').filter((record) => record.length > 0).map((record) => record.slice(record.indexOf('\n') + 1).replace(/\\/gu, '/')).filter((path) => path.length > 0));
}

function failureEvidenceIdentity(input: UnitFailureInput, action: AutopilotUnitFailureAction): ReconciliationEvidenceIdentity {
  return {
    repoKey: input.context.active.repo_key, autopilotId: input.context.active.autopilot_id, workstream: input.context.active.workstream, workstreamRun: input.context.active.workstream_run,
    source: action === 'quarantine' || action === 'preserve' ? 'quarantine-capture' : 'attempt-reset', targetId: `${input.unitId}:${String(input.attempt)}`, unitId: input.unitId, attempt: input.attempt,
  };
}

async function failureEvidencePublicationPath(input: UnitFailureInput, action: AutopilotUnitFailureAction): Promise<string> {
  const root = join(input.context.active.runtime_root, 'quarantine');
  const path = join(root, `${input.unitId}.attempt-${String(input.attempt)}.${action}.json`);
  if (!existsSync(path)) return path;
  const bytes = await readStableRegularFile(path, 'existing unit failure evidence', MAX_UNIT_FAILURE_EVIDENCE_BYTES);
  if (classifyHistoricalUnitFailureEvidenceGeneration(bytes) === null) return path;
  const candidate = parseHistoricalUnitFailureRegenerationCandidate(bytes, failureEvidenceIdentity(input, action));
  if (candidate.action !== action) throw new CoordinationRuntimeError('invalid-state', 'historical unit failure evidence action differs from current regeneration action', [path, candidate.action, action]);
  return join(root, `${input.unitId}.attempt-${String(input.attempt)}.${action}.regenerated-from-${candidate.originalSha256.slice('sha256:'.length)}.json`);
}

function currentFailureRecordBytes(record: AutopilotUnitFailureRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

async function persistCurrentFailureRecord(path: string, record: AutopilotUnitFailureRecord, expected: ReconciliationEvidenceIdentity): Promise<AutopilotUnitFailureRecord> {
  const bytes = currentFailureRecordBytes(record);
  await mkdir(dirname(path), { recursive: true });
  const acceptExisting = async (): Promise<AutopilotUnitFailureRecord> => {
    const existingBytes = await readStableRegularFile(path, 'existing current unit failure evidence', MAX_UNIT_FAILURE_EVIDENCE_BYTES);
    parseUnitFailureEvidenceFacts(existingBytes, expected);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(existingBytes)) as unknown; }
    catch (error) { throw new CoordinationRuntimeError('invalid-state', 'existing current unit failure evidence is unreadable', [path, error instanceof Error ? error.message : String(error)]); }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'existing current unit failure evidence is not an object', [path]);
    const existing = value as AutopilotUnitFailureRecord;
    if (typeof existing.created_at !== 'string' || !Number.isFinite(Date.parse(existing.created_at))) throw new CoordinationRuntimeError('invalid-state', 'existing current unit failure evidence created_at is invalid', [path]);
    const expectedBytes = currentFailureRecordBytes({ ...record, created_at: existing.created_at });
    if (new TextDecoder().decode(existingBytes) !== expectedBytes) throw new CoordinationRuntimeError('idempotency-conflict', 'existing current unit failure evidence differs from re-derived worktree facts', [path]);
    return existing;
  };
  if (existsSync(path)) return await acceptExisting();
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (!existsSync(path)) throw error;
      return await acceptExisting();
    }
  } finally { await rm(temporary, { force: true }); }
  return record;
}

async function writeFailureRecord(input: UnitFailureInput & { readonly action: AutopilotUnitFailureAction }): Promise<PublishedUnitFailureRecord> {
  const now = input.now ?? new Date();
  const before = inspectOwnedFailureWorktree(input);
  const dirtyPaths = before.mutablePaths;
  const captureCommitSha = input.action === 'quarantine' || input.action === 'preserve'
    ? await captureQuarantineSnapshot(input, before)
    : null;
  const after = inspectOwnedFailureWorktree(input);
  if (after.mutablePaths.length > 0) throw new CoordinationRuntimeError('recovery-required', 'failed-unit evidence cannot be published while mutable or ignored residue remains', after.mutablePaths.slice(0, 128));
  const captureRef = captureCommitSha === null ? null : `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/${input.action}-capture`;
  if (captureRef !== null && captureCommitSha !== null) await archiveFailureBranch(input, captureCommitSha, captureRef, `${input.action} immutable failure capture`, 'quarantined');
  const derived: AutopilotUnitFailureRecord = {
    schema_version: 'autopilot.unit_failure.v1', ...CURRENT_UNIT_FAILURE_PRODUCER_PROVENANCE, action: input.action, workstream: input.context.active.workstream, workstream_run: input.context.active.workstream_run,
    unit_id: input.unitId, attempt: input.attempt, unit_worktree_path: input.unitWorktreePath, dirty_paths: dirtyPaths,
    capture_commit_sha: captureCommitSha, capture_ref: captureRef, git_head_before: before.head, git_head_after: after.head,
    git_common_dir: after.gitCommonDir, branch: after.branch, postcondition_worktree_clean: true, summary: input.summary, created_at: now.toISOString(),
  };
  const evidencePath = await failureEvidencePublicationPath(input, input.action);
  const record = await persistCurrentFailureRecord(evidencePath, derived, failureEvidenceIdentity(input, input.action));
  return { record, evidencePath };
}

async function assertFailureBaselineAncestor(input: UnitFailureInput, beforeFacts: OwnedFailureWorktreeFacts): Promise<void> {
  let baseline = input.baselineHead;
  if (baseline === undefined) {
    try {
      const value = JSON.parse(await readFile(join(dirname(input.unitWorktreePath), '_unit-info.json'), 'utf8')) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('unit metadata is not an object');
      const metadata = value as Readonly<Record<string, unknown>>;
      if (metadata['unit_id'] !== input.unitId || metadata['attempt'] !== input.attempt || resolve(String(metadata['worktree_path'])) !== resolve(input.unitWorktreePath) || typeof metadata['base_sha'] !== 'string') throw new Error('unit metadata identity is inconsistent');
      baseline = metadata['base_sha'];
    } catch (error) {
      if (beforeFacts.mutablePaths.length === 0) throw new CoordinationRuntimeError('recovery-required', 'clean committed quarantine requires the exact attempt baseline; refusing to treat current HEAD as provenance', [input.unitWorktreePath, error instanceof Error ? error.message : String(error)]);
      baseline = beforeFacts.head;
    }
  }
  if (!/^[a-f0-9]{40,64}$/u.test(baseline)) throw new CoordinationRuntimeError('invalid-state', 'failed-unit baseline is not a full Git object id', [baseline]);
  const ancestor = runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor: baseline, descendant: beforeFacts.head }, cwd: input.unitWorktreePath });
  if (ancestor.negative) throw new CoordinationRuntimeError('recovery-required', 'failed-unit pre-capture HEAD does not descend from its exact attempt baseline', [baseline, beforeFacts.head]);
}

async function captureQuarantineSnapshot(input: UnitFailureInput & { readonly action: AutopilotUnitFailureAction }, beforeFacts: OwnedFailureWorktreeFacts): Promise<string> {
  const active = input.context.active;
  await assertFailureBaselineAncestor(input, beforeFacts);
  assertNoNestedRepositoryResidue(input.unitWorktreePath, beforeFacts.mutablePaths);
  const submodules = configuredSubmodulePaths(input.unitWorktreePath);
  const changedSubmodules = submodules.filter((submodule) => beforeFacts.mutablePaths.some((path) => path === submodule || path.startsWith(`${submodule}/`) || submodule.startsWith(`${path}/`)));
  if (changedSubmodules.length > 0) throw new CoordinationRuntimeError('recovery-required', 'quarantine cannot certify dirty submodule bytes as an immutable superproject capture', changedSubmodules);
  await executeOwnedWorktreeSaga({
    active, unitId: input.unitId, attempt: input.attempt, kind: 'unit', operationType: 'quarantine',
    initialWorktreeState: 'active', committedWorktreeState: 'quarantined',
    intent: {
      repo_root: active.source_repo, worktree_path: input.unitWorktreePath, git_common_dir: active.git_common_dir, branch: beforeFacts.branch,
      reason: `${input.action} dirty failed work before releasing edit authority`, base_sha: beforeFacts.head, target_sha: beforeFacts.head, archive_ref: null,
      checkout_mode: null, sparse_patterns: [], paths: beforeFacts.mutablePaths, metadata_refs: [],
    },
  }, {
    action: async () => {
      if (inspectOwnedFailureWorktree(input).mutablePaths.length === 0) return;
      const env = {
        AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-quarantine-capture',
        GIT_AUTHOR_NAME: 'autopilot-runtime', GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
        GIT_COMMITTER_NAME: 'autopilot-runtime', GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
      };
      await runGitMutation({ descriptor: { kind: 'stage-paths', paths: ['.'], sparse: true, force: true }, cwd: input.unitWorktreePath, env });
      const staged = runGitQuery({ descriptor: { kind: 'staged-clean' }, cwd: input.unitWorktreePath, env: { ...process.env, ...env } });
      if (staged.negative) await runGitMutation({ descriptor: { kind: 'commit', message: `autopilot quarantine capture ${active.workstream_run} ${input.unitId} attempt ${String(input.attempt)}` }, cwd: input.unitWorktreePath, env });
    },
  }, input.env ?? process.env);
  return inspectOwnedFailureWorktree(input).head;
}
