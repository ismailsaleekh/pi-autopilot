import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { runGitQuery, type GitProcessEnv } from '../git-process.ts';
import { CoordinatorClient } from './client.ts';
import { canonicalJson } from './canonical-json.ts';
import { parseCoordinationWorktree } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import {
  AUTOPILOT_IDENTITY_FAULT_RESOLUTION_EVIDENCE_SCHEMA,
  parseIdentityFaultResolutionEvidence,
  type CandidateOperationIdentity,
  type IdentityFaultResolutionEvidence,
} from './identity-fault-resolution-contract.ts';
import { parseRunScopedLogicalFault, type RunScopedLogicalFault } from './logical-faults.ts';
import type { CoordinatorSessionContext } from './supervisor.ts';
import type { CoordinationWorktree } from './types.ts';
import { deterministicWorktreeId, sameWorktreeAuthority } from './worktree-identity.ts';
import { gitWorktreeRegistrationFacts } from './worktree-postconditions.ts';

interface IdentityRecoveryProjection {
  readonly fault: RunScopedLogicalFault;
  readonly fault_id: string;
  readonly canonical_worktree_id: string;
  readonly selected_current_worktree_id: string;
  readonly candidate_worktree_ids: readonly string[];
  readonly candidate_worktrees: readonly CoordinationWorktree[];
  readonly candidate_operation_ids: readonly CandidateOperationIdentity[];
}

export interface IdentityFaultResolutionResult {
  readonly fault: RunScopedLogicalFault;
  readonly evidence: IdentityFaultResolutionEvidence;
  readonly evidence_ref: string;
  readonly replayed: boolean;
}

function exactObject(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `${label} must be an object`);
  const record = value as Readonly<Record<string, unknown>>;
  if (canonicalJson(Object.keys(record).sort()) !== canonicalJson([...fields].sort())) throw new CoordinationRuntimeError('invalid-state', `${label} fields are not the exact negotiated contract`, Object.keys(record));
  return record;
}

function sortedStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new CoordinationRuntimeError('invalid-state', `${label} must be a string array`);
  const sorted = [...value].sort();
  if (canonicalJson(value) !== canonicalJson(sorted) || new Set(value).size !== value.length) throw new CoordinationRuntimeError('invalid-state', `${label} must be sorted and unique`);
  return Object.freeze(sorted);
}

function parseCandidateOperations(value: unknown): readonly CandidateOperationIdentity[] {
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'identity recovery operation projection must be an array');
  const output = value.map((entry, index) => {
    const row = exactObject(entry, ['operation_ids', 'worktree_id'], `identity recovery operation row ${String(index)}`);
    if (typeof row['worktree_id'] !== 'string') throw new CoordinationRuntimeError('invalid-state', 'identity recovery operation row lacks a worktree ID');
    return Object.freeze({ worktree_id: row['worktree_id'], operation_ids: sortedStrings(row['operation_ids'], 'identity recovery operation IDs') });
  });
  const sorted = [...output].sort((left, right) => left.worktree_id.localeCompare(right.worktree_id));
  if (canonicalJson(output) !== canonicalJson(sorted) || new Set(output.map((entry) => entry.worktree_id)).size !== output.length) throw new CoordinationRuntimeError('invalid-state', 'identity recovery operation rows must be sorted and candidate-unique');
  return Object.freeze(sorted);
}

function parseProjection(value: unknown): IdentityRecoveryProjection {
  const record = exactObject(value, ['candidate_operation_ids', 'candidate_worktree_ids', 'candidate_worktrees', 'canonical_worktree_id', 'fault', 'fault_id', 'selected_current_worktree_id'], 'identity recovery projection');
  for (const field of ['fault_id', 'canonical_worktree_id', 'selected_current_worktree_id'] as const) if (typeof record[field] !== 'string') throw new CoordinationRuntimeError('invalid-state', `identity recovery projection ${field} must be text`);
  const candidateIds = sortedStrings(record['candidate_worktree_ids'], 'identity recovery candidate IDs');
  if (!Array.isArray(record['candidate_worktrees'])) throw new CoordinationRuntimeError('invalid-state', 'identity recovery candidate worktrees must be an array');
  const worktrees = Object.freeze(record['candidate_worktrees'].map(parseCoordinationWorktree).sort((left, right) => left.worktree_id.localeCompare(right.worktree_id)));
  const operations = parseCandidateOperations(record['candidate_operation_ids']);
  if (canonicalJson(worktrees.map((entry) => entry.worktree_id)) !== canonicalJson(candidateIds)
    || canonicalJson(operations.map((entry) => entry.worktree_id)) !== canonicalJson(candidateIds)) throw new CoordinationRuntimeError('invalid-state', 'identity recovery projection does not cover its exact candidate set');
  return Object.freeze({
    fault: parseRunScopedLogicalFault(record['fault']),
    fault_id: record['fault_id'] as string,
    canonical_worktree_id: record['canonical_worktree_id'] as string,
    selected_current_worktree_id: record['selected_current_worktree_id'] as string,
    candidate_worktree_ids: candidateIds,
    candidate_worktrees: worktrees,
    candidate_operation_ids: operations,
  });
}

function exactRunProjection(payload: Readonly<Record<string, unknown>>, faultId: string): IdentityRecoveryProjection {
  const values = payload['negotiated_identity_recovery'];
  const activeFaults = payload['run_scoped_logical_faults'];
  if (!Array.isArray(values) || !Array.isArray(activeFaults)) throw new CoordinationRuntimeError('unauthorized-client', 'identity fault resolution requires negotiated canonical-alias and scoped-fault vocabulary');
  const matches = values.map(parseProjection).filter((entry) => entry.fault_id === faultId);
  if (matches.length !== 1 || matches[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'identity fault resolution requires exactly one matching negotiated projection', [faultId]);
  const projection = matches[0];
  const currentActive = activeFaults.map(parseRunScopedLogicalFault).filter((entry) => entry.fault_id === faultId);
  if (projection.fault.status === 'active' && (currentActive.length !== 1 || canonicalJson(currentActive[0]) !== canonicalJson(projection.fault))) throw new CoordinationRuntimeError('store-corrupt', 'active identity fault projections disagree across negotiated surfaces', [faultId]);
  if (projection.fault.status === 'resolved' && currentActive.length !== 0) throw new CoordinationRuntimeError('store-corrupt', 'resolved identity fault remains in the active negotiated fault surface', [faultId]);
  return projection;
}

function assertInside(root: string, path: string, label: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CoordinationRuntimeError('unauthorized-client', `${label} escapes its package-owned root`, [path, root]);
}

async function publishEvidence(root: string, evidence: IdentityFaultResolutionEvidence): Promise<{ readonly path: string; readonly sha256: string }> {
  const path = resolve(root, `${evidence.fault_id}.json`);
  assertInside(root, path, 'identity fault resolution evidence');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = `${canonicalJson(evidence)}\n`;
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await readFile(path, 'utf8') !== bytes) throw new CoordinationRuntimeError('idempotency-conflict', 'immutable identity fault resolution evidence differs from exact replay', [path]);
    return Object.freeze({ path, sha256: `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}` });
  }
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await link(temporary, path); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await readFile(path, 'utf8') !== bytes) throw new CoordinationRuntimeError('idempotency-conflict', 'concurrent identity fault resolution evidence differs from exact replay', [path]);
  } finally { await rm(temporary, { force: true }); }
  return Object.freeze({ path, sha256: `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}` });
}

function branchSha(gitCommonDir: string, branch: string, env?: GitProcessEnv): string {
  const query = runGitQuery({ cwd: gitCommonDir, descriptor: { kind: 'resolve-revision', revision: `refs/heads/${branch}`, verify: true }, ...(env === undefined ? {} : { env }) });
  if (query.negative) throw new CoordinationRuntimeError('recovery-required', 'identity fault selected branch ref is absent', [branch]);
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(query.stdout).trim(); }
  catch { throw new CoordinationRuntimeError('recovery-required', 'identity fault selected branch ref output is not valid UTF-8', [branch]); }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) throw new CoordinationRuntimeError('recovery-required', 'identity fault selected branch did not resolve to an exact object ID', [branch, value]);
  return value;
}

/**
 * Production I3 consumer. It accepts no operator-selected routing: the exact
 * candidate/current projection is supplied by the audited schema-13 migration,
 * then independently revalidated against complete current Git facts.
 */
export async function resolveCanonicalIdentityFault(input: {
  readonly client: CoordinatorClient;
  readonly session: CoordinatorSessionContext;
  readonly fault_id: string;
  readonly env?: GitProcessEnv;
}): Promise<IdentityFaultResolutionResult> {
  const status = await input.client.query('status', input.session.repo_id, input.session.workstream_run);
  const projection = exactRunProjection(status.payload, input.fault_id);
  const fault = projection.fault;
  if (fault.invariant_id !== 'F3-SEMANTIC-UNIQUENESS' || fault.fault_code !== 'identity-recovery-pending' || fault.entity_type !== 'worktree'
    || fault.repo_id !== input.session.repo_id || fault.workstream_run !== input.session.workstream_run || fault.entity_id !== projection.canonical_worktree_id) throw new CoordinationRuntimeError('invalid-state', 'negotiated identity recovery projection differs from its exact fault authority', [fault.fault_id]);
  const selected = projection.candidate_worktrees.find((worktree) => worktree.worktree_id === projection.selected_current_worktree_id);
  if (selected === undefined || deterministicWorktreeId(selected.owner, selected.kind) !== projection.canonical_worktree_id
    || projection.candidate_worktrees.some((candidate) => !sameWorktreeAuthority(candidate, selected))) throw new CoordinationRuntimeError('recovery-required', 'identity fault candidates do not prove one exact canonical routing authority', [fault.fault_id]);
  const worktreeRoot = resolve(input.session.state_root, 'worktrees', input.session.repo_key);
  const ownedBase = resolve(input.session.state_root, 'worktrees');
  assertInside(ownedBase, worktreeRoot, 'identity fault repository worktree root');
  const evidenceRoot = resolve(worktreeRoot, '_saga-evidence', input.session.workstream_run, 'identity-recovery');
  let evidence: IdentityFaultResolutionEvidence;
  if (fault.status === 'active') {
    const registrations = gitWorktreeRegistrationFacts(selected.git_common_dir, input.env);
    const sha = branchSha(selected.git_common_dir, selected.branch, input.env);
    const registration = registrations.find((entry) => entry.worktree_path === selected.canonical_path && entry.branch_ref === `refs/heads/${selected.branch}`);
    if (registration === undefined || registration.head_sha !== sha) throw new CoordinationRuntimeError('recovery-required', 'identity fault Git registration and selected branch ref do not agree exactly', [selected.canonical_path, selected.branch]);
    evidence = parseIdentityFaultResolutionEvidence({
      schema_version: AUTOPILOT_IDENTITY_FAULT_RESOLUTION_EVIDENCE_SCHEMA,
      fault_id: fault.fault_id,
      invariant_id: 'F3-SEMANTIC-UNIQUENESS',
      repo_id: fault.repo_id,
      workstream_run: fault.workstream_run,
      canonical_worktree_id: projection.canonical_worktree_id,
      selected_current_worktree_id: projection.selected_current_worktree_id,
      candidate_worktree_ids: projection.candidate_worktree_ids,
      candidate_operation_ids: projection.candidate_operation_ids,
      observed_registrations: registrations,
      preserved_refs: [{ ref: `refs/heads/${selected.branch}`, sha }],
      resolution: 'exact-canonical-routing-confirmed',
    });
  } else {
    if (fault.resolved_event_seq === null || fault.version < 2) throw new CoordinationRuntimeError('store-corrupt', 'resolved identity fault lacks exact resolution authority', [fault.fault_id]);
    const path = resolve(evidenceRoot, `${fault.fault_id}.json`);
    assertInside(evidenceRoot, path, 'identity fault replay evidence');
    let value: unknown;
    try { value = JSON.parse(await readFile(path, 'utf8')) as unknown; }
    catch (error) { throw new CoordinationRuntimeError('recovery-required', 'committed identity fault replay evidence is unavailable', [path, error instanceof Error ? error.message : String(error)]); }
    evidence = parseIdentityFaultResolutionEvidence(value);
    if (evidence.fault_id !== fault.fault_id || evidence.canonical_worktree_id !== projection.canonical_worktree_id
      || evidence.selected_current_worktree_id !== projection.selected_current_worktree_id
      || canonicalJson(evidence.candidate_worktree_ids) !== canonicalJson(projection.candidate_worktree_ids)
      || canonicalJson(evidence.candidate_operation_ids) !== canonicalJson(projection.candidate_operation_ids)) throw new CoordinationRuntimeError('store-corrupt', 'committed identity fault evidence differs from durable canonical routing projections', [fault.fault_id]);
  }
  const published = await publishEvidence(evidenceRoot, evidence);
  const evidenceRef = relative(worktreeRoot, published.path).split(sep).join('/');
  const idempotencyKey = `identity-fault-resolution:${createHash('sha256').update(`${fault.fault_id}\0${published.sha256}`, 'utf8').digest('hex')}`;
  const response = await input.client.mutate('resolve-run-scoped-fault', {
    repoId: input.session.repo_id,
    workstreamRun: input.session.workstream_run,
    sessionId: input.session.session_id,
    fencingGeneration: input.session.session_generation,
    expectedVersion: fault.status === 'active' ? fault.version : fault.version - 1,
    idempotencyKey,
  }, {
    fault_id: fault.fault_id,
    resolution_evidence_ref: evidenceRef,
    resolution_evidence_sha256: published.sha256,
    session_lease_id: input.session.session_lease_id,
    session_token: input.session.session_token,
  });
  const resolved = parseRunScopedLogicalFault(response.payload['run_scoped_fault']);
  if (resolved.fault_id !== fault.fault_id || resolved.status !== 'resolved' || resolved.resolved_event_seq !== response.committed_event_seq) throw new CoordinationRuntimeError('store-corrupt', 'identity fault resolution response lacks exact committed audit authority', [fault.fault_id]);
  return Object.freeze({ fault: resolved, evidence, evidence_ref: evidenceRef, replayed: fault.status === 'resolved' });
}
