import { isAbsolute, normalize } from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type { GitWorktreeRegistrationFact, PreservedGitRefFact } from './metadata-reconcile.ts';

export const AUTOPILOT_IDENTITY_FAULT_RESOLUTION_EVIDENCE_SCHEMA = 'autopilot.identity_fault_resolution_evidence.v1' as const;

export interface CandidateOperationIdentity {
  readonly worktree_id: string;
  readonly operation_ids: readonly string[];
}

export interface IdentityFaultResolutionEvidence {
  readonly schema_version: typeof AUTOPILOT_IDENTITY_FAULT_RESOLUTION_EVIDENCE_SCHEMA;
  readonly fault_id: string;
  readonly invariant_id: 'F3-SEMANTIC-UNIQUENESS';
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly canonical_worktree_id: string;
  readonly selected_current_worktree_id: string;
  readonly candidate_worktree_ids: readonly string[];
  readonly candidate_operation_ids: readonly CandidateOperationIdentity[];
  readonly observed_registrations: readonly GitWorktreeRegistrationFact[];
  readonly preserved_refs: readonly PreservedGitRefFact[];
  readonly resolution: 'exact-canonical-routing-confirmed';
}

const GIT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const REF = /^refs\/(?:heads|autopilot|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u;
const CANONICAL_WORKTREE = /^worktree-[a-f0-9]{32}$/u;

function object(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-request', `${label} must be an object`);
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new CoordinationRuntimeError('invalid-request', `${label} fields are closed`, actual);
  return record;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) throw new CoordinationRuntimeError('invalid-request', `${label} is invalid`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = text(value, label);
  if (!isAbsolute(path) || normalize(path) !== path) throw new CoordinationRuntimeError('invalid-request', `${label} must be a normalized absolute path`);
  return path;
}

function sortedUnique(values: readonly string[], label: string): readonly string[] {
  if (values.some((value) => text(value, label) !== value)) throw new CoordinationRuntimeError('invalid-request', `${label} contains an invalid identity`);
  const sorted = [...values].sort();
  if (canonicalJson(values) !== canonicalJson(sorted) || new Set(values).size !== values.length) throw new CoordinationRuntimeError('invalid-request', `${label} must be sorted and unique`);
  return Object.freeze(sorted);
}

function registrations(value: unknown): readonly GitWorktreeRegistrationFact[] {
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-request', 'identity fault registrations must be an array');
  const parsed = value.map((entry, index) => {
    const row = object(entry, ['branch_ref', 'head_sha', 'prunable', 'worktree_path'], `observed_registrations[${String(index)}]`);
    const branch = row['branch_ref'];
    if (branch !== null && (typeof branch !== 'string' || !REF.test(branch))) throw new CoordinationRuntimeError('invalid-request', 'identity fault registration branch ref is invalid');
    if (typeof row['head_sha'] !== 'string' || !GIT_SHA.test(row['head_sha']) || typeof row['prunable'] !== 'boolean') throw new CoordinationRuntimeError('invalid-request', 'identity fault registration Git facts are invalid');
    return Object.freeze({ worktree_path: absolutePath(row['worktree_path'], 'identity fault registration path'), head_sha: row['head_sha'], branch_ref: branch, prunable: row['prunable'] });
  });
  const sorted = [...parsed].sort((left, right) => left.worktree_path.localeCompare(right.worktree_path));
  if (canonicalJson(parsed) !== canonicalJson(sorted) || new Set(parsed.map((entry) => entry.worktree_path)).size !== parsed.length) throw new CoordinationRuntimeError('invalid-request', 'identity fault registrations must be sorted and path-unique');
  return Object.freeze(sorted);
}

function refs(value: unknown): readonly PreservedGitRefFact[] {
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-request', 'identity fault preserved refs must be an array');
  const parsed = value.map((entry, index) => {
    const row = object(entry, ['ref', 'sha'], `preserved_refs[${String(index)}]`);
    if (typeof row['ref'] !== 'string' || !REF.test(row['ref']) || typeof row['sha'] !== 'string' || !GIT_SHA.test(row['sha'])) throw new CoordinationRuntimeError('invalid-request', 'identity fault preserved ref is invalid');
    return Object.freeze({ ref: row['ref'], sha: row['sha'] });
  });
  const sorted = [...parsed].sort((left, right) => left.ref.localeCompare(right.ref));
  if (canonicalJson(parsed) !== canonicalJson(sorted) || new Set(parsed.map((entry) => entry.ref)).size !== parsed.length) throw new CoordinationRuntimeError('invalid-request', 'identity fault preserved refs must be sorted and unique');
  return Object.freeze(sorted);
}

function candidateOperations(value: unknown): readonly CandidateOperationIdentity[] {
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-request', 'identity fault candidate operation identities must be an array');
  const parsed = value.map((entry, index) => {
    const row = object(entry, ['operation_ids', 'worktree_id'], `candidate_operation_ids[${String(index)}]`);
    if (!Array.isArray(row['operation_ids']) || !row['operation_ids'].every((id) => typeof id === 'string')) throw new CoordinationRuntimeError('invalid-request', 'identity fault operation IDs must be a string array');
    return Object.freeze({ worktree_id: text(row['worktree_id'], 'candidate worktree ID'), operation_ids: sortedUnique(row['operation_ids'], 'candidate operation IDs') });
  });
  const sorted = [...parsed].sort((left, right) => left.worktree_id.localeCompare(right.worktree_id));
  if (canonicalJson(parsed) !== canonicalJson(sorted) || new Set(parsed.map((entry) => entry.worktree_id)).size !== parsed.length) throw new CoordinationRuntimeError('invalid-request', 'identity fault candidate operation rows must be sorted and unique');
  return Object.freeze(sorted);
}

export function parseIdentityFaultResolutionEvidence(value: unknown): IdentityFaultResolutionEvidence {
  const record = object(value, ['candidate_operation_ids', 'candidate_worktree_ids', 'canonical_worktree_id', 'fault_id', 'invariant_id', 'observed_registrations', 'preserved_refs', 'repo_id', 'resolution', 'schema_version', 'selected_current_worktree_id', 'workstream_run'], 'IdentityFaultResolutionEvidence');
  if (record['schema_version'] !== AUTOPILOT_IDENTITY_FAULT_RESOLUTION_EVIDENCE_SCHEMA
    || record['invariant_id'] !== 'F3-SEMANTIC-UNIQUENESS'
    || record['resolution'] !== 'exact-canonical-routing-confirmed') throw new CoordinationRuntimeError('invalid-request', 'identity fault resolution literals are invalid');
  const canonical = text(record['canonical_worktree_id'], 'canonical worktree ID');
  if (!CANONICAL_WORKTREE.test(canonical)) throw new CoordinationRuntimeError('invalid-request', 'identity fault canonical worktree ID is invalid');
  if (!Array.isArray(record['candidate_worktree_ids']) || !record['candidate_worktree_ids'].every((id) => typeof id === 'string')) throw new CoordinationRuntimeError('invalid-request', 'identity fault candidate IDs must be a string array');
  const candidates = sortedUnique(record['candidate_worktree_ids'], 'candidate worktree IDs');
  const operations = candidateOperations(record['candidate_operation_ids']);
  if (canonicalJson(operations.map((entry) => entry.worktree_id)) !== canonicalJson(candidates)) throw new CoordinationRuntimeError('invalid-request', 'identity fault operation rows do not cover the exact candidate set');
  const selected = text(record['selected_current_worktree_id'], 'selected current worktree ID');
  if (!candidates.includes(selected)) throw new CoordinationRuntimeError('invalid-request', 'identity fault selected projection is outside its candidate set');
  return Object.freeze({
    schema_version: AUTOPILOT_IDENTITY_FAULT_RESOLUTION_EVIDENCE_SCHEMA,
    fault_id: text(record['fault_id'], 'fault ID'),
    invariant_id: 'F3-SEMANTIC-UNIQUENESS',
    repo_id: text(record['repo_id'], 'repo ID'),
    workstream_run: text(record['workstream_run'], 'workstream run'),
    canonical_worktree_id: canonical,
    selected_current_worktree_id: selected,
    candidate_worktree_ids: candidates,
    candidate_operation_ids: operations,
    observed_registrations: registrations(record['observed_registrations']),
    preserved_refs: refs(record['preserved_refs']),
    resolution: 'exact-canonical-routing-confirmed',
  });
}
