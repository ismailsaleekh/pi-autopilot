import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { runGitMutation, runGitQuery, type GitProcessEnv } from '../git-process.ts';
import { canonicalJson } from './canonical-json.ts';
import { CoordinationRuntimeError } from './failures.ts';
import {
  assertMetadataReconcileEvidence,
  parseMetadataReconcileIntent,
  type GitWorktreeRegistrationFact,
  type MetadataReconcileEvidence,
  type MetadataReconcileIntent,
  type PreservedGitRefFact,
} from './metadata-reconcile.ts';
import { deriveWorktreeOperationKeyV2 } from './worktree-operation-identity.ts';
import { gitWorktreeRegistrationFacts, inspectWorktreePostcondition } from './worktree-postconditions.ts';
import { deterministicWorktreeId, type CanonicalWorktreeSemanticIdentity } from './worktree-identity.ts';

export interface MetadataReconcileApproval {
  readonly semantic_identity: CanonicalWorktreeSemanticIdentity;
  readonly intent: MetadataReconcileIntent;
  readonly recovery_evidence_path: string;
}

export interface MetadataReconcileBatchResult {
  readonly evidence_paths: readonly string[];
  readonly before_registrations: readonly GitWorktreeRegistrationFact[];
  readonly after_registrations: readonly GitWorktreeRegistrationFact[];
  readonly approved_prunable_paths: readonly string[];
  readonly mutation_report: 'reported' | 'effect-unknown' | 'already-satisfied';
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertInside(root: string, path: string, label: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) throw new CoordinationRuntimeError('unauthorized-client', `${label} escapes its package-owned evidence root`, [path, root]);
}

async function verifyRecoveryEvidence(approval: MetadataReconcileApproval): Promise<void> {
  if (!existsSync(approval.recovery_evidence_path)) throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation recovery evidence is missing', [approval.recovery_evidence_path]);
  const before = lstatSync(approval.recovery_evidence_path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024) throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation recovery evidence is not a bounded stable regular file', [approval.recovery_evidence_path]);
  const bytes = await readFile(approval.recovery_evidence_path);
  const after = lstatSync(approval.recovery_evidence_path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.byteLength !== before.size) throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation recovery evidence changed during proof', [approval.recovery_evidence_path]);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== approval.intent.recovery_evidence_sha256) throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation recovery evidence digest differs from durable approval', [approval.intent.canonical_worktree_id, digest, approval.intent.recovery_evidence_sha256]);
}

function readPreservedRefs(intent: MetadataReconcileIntent, env?: GitProcessEnv): readonly PreservedGitRefFact[] {
  return Object.freeze(intent.preserved_refs.map((expected) => {
    const query = runGitQuery({ descriptor: { kind: 'resolve-revision', revision: expected.ref, verify: true }, cwd: intent.git_common_dir, ...(env === undefined ? {} : { env }) });
    if (query.negative) throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation preserved ref is absent', [expected.ref]);
    const actual = new TextDecoder('utf-8', { fatal: true }).decode(query.stdout).trim();
    if (actual !== expected.sha) throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation preserved ref moved', [expected.ref, `expected=${expected.sha}`, `actual=${actual}`]);
    return Object.freeze({ ref: expected.ref, sha: actual });
  }));
}

function inspectApproval(approval: MetadataReconcileApproval, env?: GitProcessEnv) {
  const identity = approval.semantic_identity;
  return inspectWorktreePostcondition({
    operationType: 'metadata-reconcile',
    owner: { repo_id: identity.repo_id, autopilot_id: identity.autopilot_id, workstream_run: identity.workstream_run, unit_id: identity.unit_id, attempt: identity.attempt },
    kind: identity.kind,
    canonicalWorktreeId: approval.intent.canonical_worktree_id,
    intent: approval.intent,
    ...(env === undefined ? {} : { env }),
  });
}

async function publishEvidence(input: {
  readonly evidenceRoot: string;
  readonly approval: MetadataReconcileApproval;
  readonly evidence: MetadataReconcileEvidence;
}): Promise<string> {
  const path = resolve(input.evidenceRoot, 'metadata-reconcile', `${input.approval.intent.canonical_worktree_id}.json`);
  assertInside(input.evidenceRoot, path, 'metadata reconciliation evidence');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = `${canonicalJson(input.evidence)}\n`;
  if (existsSync(path)) {
    if (await readFile(path, 'utf8') !== bytes) throw new CoordinationRuntimeError('idempotency-conflict', 'immutable metadata reconciliation evidence differs from the exact replay', [path]);
    return path;
  }
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await link(temporary, path); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if (await readFile(path, 'utf8') !== bytes) throw new CoordinationRuntimeError('idempotency-conflict', 'concurrent metadata reconciliation evidence differs from exact replay', [path]);
  } finally { await rm(temporary, { force: true }); }
  return path;
}

/**
 * Executes one exact metadata-only batch. The caller supplies schema-13
 * per-row approvals; this runtime never infers DB state or backup coverage.
 */
export async function reconcileApprovedMissingWorktreeMetadata(input: {
  readonly approvals: readonly MetadataReconcileApproval[];
  readonly evidence_root: string;
  readonly env?: GitProcessEnv;
  readonly observe_before_final_drift_check?: () => Promise<void> | void;
}): Promise<MetadataReconcileBatchResult> {
  if (input.approvals.length === 0) throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation requires at least one approved row');
  const approvals = input.approvals.map((approval) => ({ ...approval, intent: parseMetadataReconcileIntent(approval.intent) }));
  const first = approvals[0];
  if (first === undefined) throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation approval set disappeared');
  for (const approval of approvals) {
    const canonicalId = deterministicWorktreeId({
      repo_id: approval.semantic_identity.repo_id,
      autopilot_id: approval.semantic_identity.autopilot_id,
      workstream_run: approval.semantic_identity.workstream_run,
      unit_id: approval.semantic_identity.unit_id,
      attempt: approval.semantic_identity.attempt,
    }, approval.semantic_identity.kind);
    if (canonicalId !== approval.intent.canonical_worktree_id || approval.semantic_identity.repo_id !== approval.intent.repo_id) throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation approval canonical owner differs from immutable intent', [approval.intent.canonical_worktree_id, canonicalId]);
    if (approval.intent.git_common_dir !== first.intent.git_common_dir || approval.intent.repo_id !== first.intent.repo_id) throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation batch crosses repository authority');
    if (!exactEqual(approval.intent.approved_before_registrations, first.intent.approved_before_registrations)
      || !exactEqual(approval.intent.approved_prunable_registration_paths, first.intent.approved_prunable_registration_paths)
      || !exactEqual(approval.intent.expected_after_registrations, first.intent.expected_after_registrations)
      || !exactEqual(approval.intent.preserved_refs, first.intent.preserved_refs)) throw new CoordinationRuntimeError('invalid-state', 'metadata reconciliation rows disagree on complete batch before/after/ref facts', [approval.intent.canonical_worktree_id]);
    if (pathEntryExists(approval.intent.target_registration_path)) throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation target path has a physical or symbolic filesystem entry; metadata-only prune is forbidden', [approval.intent.target_registration_path]);
    await verifyRecoveryEvidence(approval);
  }
  const targets = approvals.map((approval) => approval.intent.target_registration_path).sort(compare);
  const approved = [...first.intent.approved_prunable_registration_paths].sort(compare);
  if (!exactEqual(targets, approved)) throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation rows do not cover the complete approved prunable set', [...targets.map((path) => `row=${path}`), ...approved.map((path) => `approved=${path}`)]);

  const before = gitWorktreeRegistrationFacts(first.intent.git_common_dir, input.env);
  const initialInspection = inspectApproval(first, input.env);
  if (initialInspection.outcome === 'unsafe') throw new CoordinationRuntimeError('recovery-required', 'canonical metadata reconciliation probe rejected the approved batch before action', initialInspection.proof);
  const initiallyApplied = initialInspection.outcome === 'satisfied';
  if (!initiallyApplied && !exactEqual(before, first.intent.approved_before_registrations)) throw new CoordinationRuntimeError('recovery-required', 'Git worktree registration set drifted before metadata reconciliation proof', [`observed=${String(before.length)}`, `approved=${String(first.intent.approved_before_registrations.length)}`]);
  const preservedBefore = readPreservedRefs(first.intent, input.env);
  await input.observe_before_final_drift_check?.();
  const finalPreservedBefore = readPreservedRefs(first.intent, input.env);
  if (!exactEqual(finalPreservedBefore, preservedBefore)) throw new CoordinationRuntimeError('recovery-required', 'preserved Git refs changed between metadata reconciliation proof and action', first.intent.preserved_refs.map((entry) => entry.ref));
  const finalBefore = gitWorktreeRegistrationFacts(first.intent.git_common_dir, input.env);
  const alreadySatisfied = exactEqual(finalBefore, first.intent.expected_after_registrations);
  if (!alreadySatisfied && !exactEqual(finalBefore, first.intent.approved_before_registrations)) throw new CoordinationRuntimeError('recovery-required', 'Git worktree registration set changed between proof and action; refusing prune', [`observed=${String(finalBefore.length)}`, `approved=${String(first.intent.approved_before_registrations.length)}`]);

  const mutation = alreadySatisfied ? null : await runGitMutation({ descriptor: { kind: 'worktree-prune' }, cwd: first.intent.git_common_dir, ...(input.env === undefined ? {} : { env: input.env }) });
  const after = gitWorktreeRegistrationFacts(first.intent.git_common_dir, input.env);
  const afterInspection = inspectApproval(first, input.env);
  if (afterInspection.outcome !== 'satisfied' || !exactEqual(after, first.intent.expected_after_registrations)) throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation canonical postcondition is not satisfied', [`before=${String(finalBefore.length)}`, `after=${String(after.length)}`, `expected_after=${String(first.intent.expected_after_registrations.length)}`, ...afterInspection.proof, ...(mutation === null ? [] : [`mutation_report=${mutation.kind}`, `mutation_diagnostic=${mutation.diagnostic}`])]);

  const preservedAfter = readPreservedRefs(first.intent, input.env);
  const evidencePaths: string[] = [];
  for (const approval of approvals) {
    const key = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: approval.intent.canonical_worktree_id, operationType: 'metadata-reconcile', completeImmutableIntent: approval.intent });
    const refsBefore = preservedBefore;
    const refsAfter = preservedAfter;
    const evidence: MetadataReconcileEvidence = {
      schema_version: 'autopilot.worktree_metadata_reconcile_evidence.v1',
      canonical_worktree_id: approval.intent.canonical_worktree_id,
      operation_key_sha256: key.operation_key_sha256,
      observed_before_registrations: approval.intent.approved_before_registrations,
      approved_prunable_registration_paths: approval.intent.approved_prunable_registration_paths,
      observed_after_registrations: after,
      preserved_refs_before: refsBefore,
      preserved_refs_after: refsAfter,
    };
    assertMetadataReconcileEvidence(approval.intent, evidence);
    evidencePaths.push(await publishEvidence({ evidenceRoot: input.evidence_root, approval, evidence }));
  }
  return Object.freeze({
    evidence_paths: Object.freeze(evidencePaths.sort(compare)),
    before_registrations: first.intent.approved_before_registrations,
    after_registrations: after,
    approved_prunable_paths: first.intent.approved_prunable_registration_paths,
    mutation_report: mutation === null ? 'already-satisfied' : mutation.kind,
  });
}
