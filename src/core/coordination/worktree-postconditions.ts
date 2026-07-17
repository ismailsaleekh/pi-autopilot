import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { gitQueryNulStrings, gitQueryText, runGitQuery, type GitProcessEnv } from '../git-process.ts';
import { AUTOPILOT_PREFLIGHT_ROLLBACK_REASON_PREFIX } from '../names.ts';
import { parseMetadataReconcileIntent, type GitWorktreeRegistrationFact, type MetadataReconcileIntent } from './metadata-reconcile.ts';
import type { CoordinationOwnerIdentity, CoordinationWorktreeKind, CoordinationWorktreeOperationIntent, CoordinationOperationStage, CoordinationWorktreeOperationType } from './types.ts';
import { deterministicWorktreeId } from './worktree-identity.ts';

export type WorktreePostconditionOutcome = 'satisfied' | 'not-applied' | 'unsafe';

export interface WorktreePostconditionResult {
  readonly outcome: WorktreePostconditionOutcome;
  readonly proof: readonly string[];
  readonly effect_applied: boolean;
  readonly capture_sha: string | null;
  readonly proof_source: 'physical-worktree' | 'owned-git-ref' | 'repository-facts' | 'metadata-registration-set';
}

interface OrdinaryPostconditionRequest {
  readonly operationType: Exclude<CoordinationWorktreeOperationType, 'metadata-reconcile'>;
  readonly owner: CoordinationOwnerIdentity;
  readonly kind: CoordinationWorktreeKind;
  readonly canonicalWorktreeId: string;
  readonly intent: CoordinationWorktreeOperationIntent;
  readonly durableStage?: CoordinationOperationStage;
  readonly env?: GitProcessEnv;
}

interface MetadataPostconditionRequest {
  readonly operationType: 'metadata-reconcile';
  readonly owner: CoordinationOwnerIdentity;
  readonly kind: CoordinationWorktreeKind;
  readonly canonicalWorktreeId: string;
  readonly intent: MetadataReconcileIntent;
  readonly env?: GitProcessEnv;
}

export type WorktreePostconditionRequest = OrdinaryPostconditionRequest | MetadataPostconditionRequest;

type PostconditionHandler = (request: WorktreePostconditionRequest) => WorktreePostconditionResult;

const MAX_PROOF_ENTRIES = 256;
const MAX_PROOF_ENTRY_LENGTH = 1_024;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function result(
  outcome: WorktreePostconditionOutcome,
  proof: readonly string[],
  source: WorktreePostconditionResult['proof_source'] = 'repository-facts',
  captureSha: string | null = null,
  effectApplied: boolean = outcome === 'satisfied',
): WorktreePostconditionResult {
  const deterministic = [...proof].map((entry) => entry.slice(0, MAX_PROOF_ENTRY_LENGTH)).sort(compare);
  const bounded = deterministic.length <= MAX_PROOF_ENTRIES
    ? deterministic
    : [...deterministic.slice(0, MAX_PROOF_ENTRIES - 1), `proof_truncated_entries=${String(deterministic.length - MAX_PROOF_ENTRIES + 1)}`];
  return Object.freeze({ outcome, proof: Object.freeze(bounded), effect_applied: effectApplied, capture_sha: captureSha, proof_source: source });
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function canonicalPath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

function ordinaryRequest(request: WorktreePostconditionRequest): OrdinaryPostconditionRequest {
  if (request.operationType === 'metadata-reconcile') throw new Error('metadata reconciliation does not use an ordinary worktree intent');
  return request;
}

function metadataRequest(request: WorktreePostconditionRequest): MetadataPostconditionRequest {
  if (request.operationType !== 'metadata-reconcile') throw new Error('ordinary worktree operation does not use metadata reconciliation intent');
  return request;
}

function assertCanonicalIdentity(request: WorktreePostconditionRequest): WorktreePostconditionResult | null {
  const expected = deterministicWorktreeId(request.owner, request.kind);
  if (request.canonicalWorktreeId !== expected) return result('unsafe', [`actual_canonical_worktree_id=${request.canonicalWorktreeId}`, `expected_canonical_worktree_id=${expected}`]);
  if (request.operationType === 'metadata-reconcile') {
    const intent = parseMetadataReconcileIntent(request.intent);
    if (intent.canonical_worktree_id !== expected || intent.repo_id !== request.owner.repo_id) return result('unsafe', ['metadata_reconcile_canonical_owner_mismatch']);
    return null;
  }
  const expectedBranch = request.kind === 'main'
    ? `autopilot/${request.owner.workstream_run}`
    : `autopilot/unit/${request.owner.workstream_run}/${request.owner.unit_id}/attempt-${String(request.owner.attempt)}`;
  if (request.intent.branch !== expectedBranch) return result('unsafe', [`actual_branch_authority=${request.intent.branch}`, `expected_branch_authority=${expectedBranch}`]);
  const invalidMetadataRefs = request.intent.metadata_refs.filter((ref) => ref.length === 0 || ref.includes('\0') || isAbsolute(ref) || ref.replace(/\\/gu, '/').split('/').some((segment) => segment === '..' || segment === ''));
  if (invalidMetadataRefs.length > 0) return result('unsafe', invalidMetadataRefs.map((ref) => `unbounded_metadata_ref=${ref}`));
  return null;
}

export function gitWorktreeRegistrationFacts(repoRoot: string, env?: GitProcessEnv): readonly GitWorktreeRegistrationFact[] {
  const fields = gitQueryNulStrings({ descriptor: { kind: 'worktree-list', nul: true }, cwd: repoRoot, ...(env === undefined ? {} : { env }) });
  const registrations: GitWorktreeRegistrationFact[] = [];
  let path: string | null = null;
  let head = '';
  let branch: string | null = null;
  let prunable = false;
  const flush = (): void => {
    if (path !== null) registrations.push(Object.freeze({ worktree_path: canonicalPath(path), head_sha: head, branch_ref: branch, prunable }));
    path = null;
    head = '';
    branch = null;
    prunable = false;
  };
  for (const field of fields) {
    if (field.startsWith('worktree ')) {
      flush();
      path = field.slice('worktree '.length);
    } else if (field.startsWith('HEAD ')) head = field.slice('HEAD '.length);
    else if (field.startsWith('branch ')) branch = field.slice('branch '.length);
    else if (field === 'prunable' || field.startsWith('prunable ')) prunable = true;
  }
  flush();
  return Object.freeze(registrations.sort((left, right) => compare(left.worktree_path, right.worktree_path)));
}

function registrationFor(intent: CoordinationWorktreeOperationIntent, env?: GitProcessEnv): { readonly all: readonly GitWorktreeRegistrationFact[]; readonly exact: readonly GitWorktreeRegistrationFact[] } {
  const all = gitWorktreeRegistrationFacts(intent.repo_root, env);
  const expected = canonicalPath(intent.worktree_path);
  return { all, exact: Object.freeze(all.filter((entry) => entry.worktree_path === expected)) };
}

function metadataMissing(request: OrdinaryPostconditionRequest): readonly string[] {
  if (request.intent.metadata_refs.length === 0) return Object.freeze([]);
  const taskRoot = request.owner.unit_id === 'main'
    ? dirname(request.intent.worktree_path)
    : dirname(dirname(dirname(dirname(request.intent.worktree_path))));
  const worktreeRoot = dirname(dirname(taskRoot));
  let runtimeRoot: string | null = null;
  const taskInfo = resolve(taskRoot, '_task-info.json');
  if (existsSync(taskInfo)) {
    try {
      const value: unknown = JSON.parse(readFileSync(taskInfo, 'utf8'));
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const candidate = Reflect.get(value, 'runtime_root');
        if (typeof candidate === 'string') {
          const resolved = resolve(candidate);
          const rel = relative(resolve(taskRoot), resolved);
          if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) runtimeRoot = resolved;
        }
      }
    } catch {
      return Object.freeze(request.intent.metadata_refs.map((ref) => `unreadable_metadata_root=${ref}`));
    }
  }
  return Object.freeze(request.intent.metadata_refs.filter((ref) => {
    if (request.operationType === 'remove' && request.intent.reason.startsWith(AUTOPILOT_PREFLIGHT_ROLLBACK_REASON_PREFIX) && ref === '_ledger.jsonl') return false;
    const ownerScopedCandidates = [
      resolve(request.intent.worktree_path, ...ref.split('/')),
      resolve(taskRoot, ...ref.split('/')),
      ...(runtimeRoot === null ? [] : [resolve(runtimeRoot, ...ref.split('/'))]),
      ...(ref === '_ledger.jsonl' || ref.startsWith('_archive/') ? [resolve(worktreeRoot, ...ref.split('/'))] : []),
    ];
    return !ownerScopedCandidates.some((candidate) => existsSync(candidate));
  }));
}

function physicalAuthority(request: OrdinaryPostconditionRequest): WorktreePostconditionResult | null {
  const intent = request.intent;
  const present = existsSync(intent.worktree_path);
  const registrations = registrationFor(intent, request.env);
  if (registrations.exact.length > 1) return result('unsafe', registrations.exact.map((entry) => `duplicate_registration=${entry.worktree_path}:${entry.head_sha}`));
  if (!present) return null;
  if (registrations.exact.length !== 1) return result('unsafe', ['git_registration_absent', 'physical_path_present']);
  const entry = registrations.exact[0];
  if (entry === undefined || entry.branch_ref !== `refs/heads/${intent.branch}`) return result('unsafe', [`actual_registration_branch=${String(entry?.branch_ref ?? null)}`, `expected_registration_branch=refs/heads/${intent.branch}`]);
  const top = canonicalPath(gitQueryText({ descriptor: { kind: 'show-toplevel' }, cwd: intent.worktree_path, ...(request.env === undefined ? {} : { env: request.env }) }).trim());
  if (top !== canonicalPath(intent.worktree_path)) return result('unsafe', [`actual_toplevel=${top}`, `expected_toplevel=${canonicalPath(intent.worktree_path)}`]);
  const commonRaw = gitQueryText({ descriptor: { kind: 'git-common-dir' }, cwd: intent.worktree_path, ...(request.env === undefined ? {} : { env: request.env }) }).trim();
  const common = canonicalPath(isAbsolute(commonRaw) ? commonRaw : resolve(intent.worktree_path, commonRaw));
  if (common !== canonicalPath(intent.git_common_dir)) return result('unsafe', [`actual_git_common_dir=${common}`, `expected_git_common_dir=${canonicalPath(intent.git_common_dir)}`]);
  const branchQuery = runGitQuery({ descriptor: { kind: 'current-branch' }, cwd: intent.worktree_path, ...(request.env === undefined ? {} : { env: request.env }) });
  const branch = branchQuery.negative ? null : new TextDecoder('utf-8', { fatal: true }).decode(branchQuery.stdout).trim();
  if (branch !== intent.branch) return result('unsafe', [`actual_physical_branch=${String(branch)}`, `expected_physical_branch=${intent.branch}`]);
  return null;
}

function ownedRuntimeRepoPrefix(request: OrdinaryPostconditionRequest): string | null {
  if (request.owner.unit_id !== 'main') return null;
  const taskInfo = resolve(dirname(request.intent.worktree_path), '_task-info.json');
  if (!existsSync(taskInfo)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(taskInfo, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const runtimeRoot = Reflect.get(value, 'runtime_root');
    if (typeof runtimeRoot !== 'string') return null;
    const relative = runtimeRoot.startsWith(`${resolve(request.intent.worktree_path)}${sep}`)
      ? runtimeRoot.slice(resolve(request.intent.worktree_path).length + 1).replace(/\\/gu, '/')
      : null;
    return relative === null || relative.length === 0 || relative.startsWith('../') ? null : relative.replace(/\/$/u, '');
  } catch { return null; }
}

interface MutableWorktreeFact {
  readonly status: string;
  readonly path: string;
}

function mutableWorktreeFacts(request: OrdinaryPostconditionRequest, includeIgnored: boolean): readonly MutableWorktreeFact[] {
  const query = runGitQuery({ descriptor: { kind: 'status-porcelain', ...(includeIgnored ? { includeIgnored: true } : {}) }, cwd: request.intent.worktree_path, ...(request.env === undefined ? {} : { env: request.env }) });
  if (query.stdout.length === 0) return Object.freeze([]);
  const records = new TextDecoder('utf-8', { fatal: true }).decode(query.stdout).split('\0');
  const facts: MutableWorktreeFact[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Git porcelain status record is malformed');
    const status = record.slice(0, 2);
    facts.push(Object.freeze({ status, path: record.slice(3).replace(/\\/gu, '/').replace(/\/$/u, '') }));
    if (status.includes('R') || status.includes('C')) {
      const second = records[index + 1];
      if (second === undefined || second.length === 0) throw new Error('Git porcelain rename/copy record lacks its second path');
      facts.push(Object.freeze({ status, path: second.replace(/\\/gu, '/').replace(/\/$/u, '') }));
      index += 1;
    }
  }
  const approvedRemovalResidue = request.operationType === 'remove' ? request.intent.paths.map((path) => path.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/$/u, '')) : [];
  const runtimePrefix = ownedRuntimeRepoPrefix(request);
  return Object.freeze(facts.filter((fact) => {
    const packageOwnedRuntime = runtimePrefix !== null && (fact.path === runtimePrefix || fact.path.startsWith(`${runtimePrefix}/`));
    const approvedRemoval = approvedRemovalResidue.some((prefix) => fact.path === prefix || fact.path.startsWith(`${prefix}/`));
    return !((fact.status === '??' || fact.status === '!!') && (packageOwnedRuntime || approvedRemoval));
  }));
}

function clean(request: OrdinaryPostconditionRequest, includeIgnored: boolean): readonly string[] {
  return Object.freeze(mutableWorktreeFacts(request, includeIgnored).map((fact) => `mutable=${fact.status} ${fact.path}`));
}

function effectWithMetadata(request: OrdinaryPostconditionRequest, proof: readonly string[], source: WorktreePostconditionResult['proof_source'] = 'repository-facts', captureSha: string | null = null): WorktreePostconditionResult {
  const missing = metadataMissing(request);
  return missing.length === 0
    ? result('satisfied', [...proof, 'metadata_complete'], source, captureSha)
    : result('not-applied', [...proof, ...missing.map((ref) => `missing_metadata=${ref}`)], source, captureSha, true);
}

function head(request: OrdinaryPostconditionRequest): string {
  return gitQueryText({ descriptor: { kind: 'head' }, cwd: request.intent.worktree_path, ...(request.env === undefined ? {} : { env: request.env }) }).trim();
}

function exactDiffPaths(request: OrdinaryPostconditionRequest, from: string, to: string): readonly string[] {
  return Object.freeze(gitQueryNulStrings({ descriptor: { kind: 'diff-paths', from, to, noRenames: true }, cwd: request.intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).map((path) => path.replace(/\\/gu, '/')).sort(compare));
}

function samePaths(expectedInput: readonly string[], actualInput: readonly string[]): boolean {
  const expected = [...expectedInput].map((path) => path.replace(/\\/gu, '/')).sort(compare);
  const actual = [...actualInput].sort(compare);
  return expected.length === actual.length && expected.every((path, index) => path === actual[index]);
}

function createPostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = ordinaryRequest(requestInput);
  const authority = physicalAuthority(request);
  if (authority !== null) return authority;
  const intent = request.intent;
  const present = existsSync(intent.worktree_path);
  const registration = registrationFor(intent, request.env).exact;
  if (!present) {
    if (registration.length > 0) return result('unsafe', ['physical_path_absent', 'git_registration_present']);
    const branch = runGitQuery({ descriptor: { kind: 'ref-exists', ref: `refs/heads/${intent.branch}` }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) });
    if (branch.negative) return result('not-applied', ['branch_absent', 'git_registration_absent', 'physical_path_absent']);
    if (intent.base_sha === null) return result('unsafe', ['create_base_sha_absent']);
    const sha = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: `refs/heads/${intent.branch}`, verify: true }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).trim();
    return sha === intent.base_sha ? result('not-applied', [`branch_precreated_at_base=${sha}`, 'git_registration_absent', 'physical_path_absent']) : result('unsafe', [`actual_branch_sha=${sha}`, `expected_branch_sha=${intent.base_sha}`]);
  }
  if (intent.base_sha === null) return result('unsafe', ['create_base_sha_absent']);
  const currentHead = head(request);
  const historicalAdvance = currentHead !== intent.base_sha
    && request.durableStage === 'committed'
    && !runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor: intent.base_sha, descendant: currentHead }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).negative;
  if (currentHead !== intent.base_sha && !historicalAdvance) return result('unsafe', [`actual_head=${currentHead}`, `expected_head=${intent.base_sha}`]);
  if (intent.checkout_mode !== null && intent.checkout_mode !== 'full') {
    const sparse = runGitQuery({ descriptor: { kind: 'config-bool', key: 'core.sparseCheckout' }, cwd: intent.worktree_path, ...(request.env === undefined ? {} : { env: request.env }) });
    if (sparse.negative || new TextDecoder().decode(sparse.stdout).trim() !== 'true') return result('not-applied', ['sparse_configuration_incomplete', 'worktree_registered']);
  }
  const missing = metadataMissing(request);
  return missing.length === 0
    ? result('satisfied', [`branch=${intent.branch}`, `head=${currentHead}`, ...(historicalAdvance ? [`historical_create_base=${intent.base_sha}`] : []), 'metadata_complete', 'worktree_registered'])
    : result('not-applied', ['worktree_registered', ...missing.map((ref) => `missing_metadata=${ref}`)], 'repository-facts', null, true);
}

function futureOwnedParentPresent(worktreePath: string, path: string): boolean {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
  const wildcard = normalized.search(/[?*[{]/u);
  const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
  const literal = prefix.replace(/\/$/u, '');
  const parent = wildcard < 0 ? dirname(literal) : (literal.length === 0 ? '.' : prefix.endsWith('/') ? literal : dirname(literal));
  const candidate = resolve(worktreePath, ...parent.split('/'));
  if (!existsSync(candidate)) return false;
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  const root = canonicalPath(worktreePath);
  const physical = canonicalPath(candidate);
  return physical === root || physical.startsWith(`${root}${sep}`);
}

function materializePostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = ordinaryRequest(requestInput);
  const authority = physicalAuthority(request);
  if (authority !== null) return authority;
  if (!existsSync(request.intent.worktree_path)) return result('unsafe', ['owned_worktree_missing']);
  const sparse = runGitQuery({ descriptor: { kind: 'config-bool', key: 'core.sparseCheckout' }, cwd: request.intent.worktree_path, ...(request.env === undefined ? {} : { env: request.env }) });
  if (sparse.negative || new TextDecoder().decode(sparse.stdout).trim() !== 'true') return result('unsafe', ['sparse_checkout_disabled']);
  const missing: string[] = [];
  const lfs: string[] = [];
  const unsupported: string[] = [];
  for (const path of request.intent.paths) {
    const records = gitQueryNulStrings({ descriptor: { kind: 'ls-files-state', paths: [path] }, cwd: request.intent.worktree_path, ...(request.env === undefined ? {} : { env: request.env }) });
    if (records.length === 0) {
      if (!futureOwnedParentPresent(request.intent.worktree_path, path)) missing.push(path);
      continue;
    }
    if (records.some((entry) => entry.startsWith('S '))) { missing.push(path); continue; }
    for (const record of records) {
      const trackedPath = record.slice(2);
      const absolute = resolve(request.intent.worktree_path, ...trackedPath.split('/'));
      if (!existsSync(absolute)) { missing.push(path); continue; }
      const info = lstatSync(absolute);
      if (!info.isFile()) { unsupported.push(trackedPath); continue; }
      if (info.size <= 1_024 && readFileSync(absolute).subarray(0, 256).toString().startsWith('version https://git-lfs.github.com/spec/v1')) lfs.push(trackedPath);
    }
  }
  if (unsupported.length > 0) return result('unsafe', unsupported.map((path) => `unsupported_materialized_entry=${path}`));
  if (lfs.length > 0) return result('unsafe', lfs.map((path) => `lfs_pointer=${path}`));
  const metadata = metadataMissing(request);
  return missing.length === 0 && metadata.length === 0
    ? result('satisfied', ['sparse_checkout_enabled', ...request.intent.paths.map((path) => `materialized=${path}`), 'metadata_complete'])
    : result('not-applied', [...missing.map((path) => `not_materialized=${path}`), ...metadata.map((ref) => `missing_metadata=${ref}`)], 'repository-facts', null, missing.length === 0);
}

function commitPostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = ordinaryRequest(requestInput);
  const authority = physicalAuthority(request);
  if (authority !== null) return authority;
  if (!existsSync(request.intent.worktree_path) || request.intent.base_sha === null) return result('unsafe', ['commit_authority_incomplete']);
  const dirty = clean(request, false);
  if (dirty.length > 0) return result('not-applied', dirty);
  const currentHead = head(request);
  if (request.intent.target_sha !== null && currentHead !== request.intent.target_sha) return result('unsafe', [`actual_head=${currentHead}`, `expected_target_head=${request.intent.target_sha}`]);
  if (currentHead === request.intent.base_sha) return result('not-applied', [`head=${currentHead}`, 'worktree_clean']);
  if (runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor: request.intent.base_sha, descendant: currentHead }, cwd: request.intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).negative) return result('unsafe', [`actual_head=${currentHead}`, `expected_ancestor=${request.intent.base_sha}`]);
  const paths = exactDiffPaths(request, request.intent.base_sha, currentHead);
  if (!samePaths(request.intent.paths, paths)) return result('unsafe', [...request.intent.paths.map((path) => `expected_path=${path}`), ...paths.map((path) => `actual_path=${path}`)]);
  const metadata = metadataMissing(request);
  return metadata.length === 0
    ? result('satisfied', [`base=${request.intent.base_sha}`, `head=${currentHead}`, ...paths.map((path) => `committed=${path}`), 'metadata_complete', 'worktree_clean'])
    : result('not-applied', [`effect_head=${currentHead}`, ...metadata.map((ref) => `missing_metadata=${ref}`)], 'repository-facts', null, true);
}

function quarantinePostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = ordinaryRequest(requestInput);
  const intent = request.intent;
  if (intent.base_sha === null) return result('unsafe', ['quarantine_base_sha_absent']);
  const expectedBranch = `refs/heads/${intent.branch}`;
  if (existsSync(intent.worktree_path)) {
    const authority = physicalAuthority(request);
    if (authority !== null) return authority;
    const mutable = mutableWorktreeFacts(request, true);
    if (mutable.length > 0) {
      const actualPaths = [...new Set(mutable.map((fact) => fact.path))].sort(compare);
      if (!samePaths(intent.paths, actualPaths)) return result('unsafe', [...intent.paths.map((path) => `expected_mutable_path=${path}`), ...actualPaths.map((path) => `actual_mutable_path=${path}`)], 'physical-worktree');
      return result('not-applied', mutable.map((fact) => `mutable=${fact.status} ${fact.path}`), 'physical-worktree');
    }
    const capture = head(request);
    if (capture === intent.base_sha) return intent.paths.length === 0
      ? effectWithMetadata(request, [`capture_sha=${capture}`, 'worktree_clean_including_ignored'], 'physical-worktree', capture)
      : result('not-applied', [`head=${capture}`, 'worktree_clean_including_ignored'], 'physical-worktree');
    const parents = gitQueryText({ descriptor: { kind: 'rev-list-parents', revision: capture }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).trim().split(/\s+/u).slice(1);
    const paths = exactDiffPaths(request, intent.base_sha, capture);
    if (parents.length !== 1 || parents[0] !== intent.base_sha || !samePaths(intent.paths, paths)) return result('unsafe', [`capture_sha=${capture}`, ...parents.map((parent) => `actual_parent=${parent}`), ...intent.paths.map((path) => `expected_path=${path}`), ...paths.map((path) => `actual_path=${path}`)], 'physical-worktree');
    return effectWithMetadata(request, [`base=${intent.base_sha}`, `capture_sha=${capture}`, ...paths.map((path) => `captured=${path}`), 'worktree_clean_including_ignored'], 'physical-worktree', capture);
  }
  const registrationFacts = registrationFor(intent, request.env);
  const registrations = registrationFacts.exact;
  const substituted = registrationFacts.all.filter((entry) => entry.branch_ref === expectedBranch && !registrations.includes(entry));
  if (substituted.length > 0 || registrations.length > 1 || registrations.some((entry) => entry.branch_ref !== expectedBranch)) return result('unsafe', [...registrations, ...substituted].map((entry) => `registration=${entry.worktree_path}:${String(entry.branch_ref)}:${entry.head_sha}`), 'owned-git-ref');
  const branchQuery = runGitQuery({ descriptor: { kind: 'resolve-commit', revision: expectedBranch }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) });
  if (branchQuery.negative) return result('unsafe', ['owned_capture_branch_absent', `expected_ref=${expectedBranch}`], 'owned-git-ref');
  const capture = new TextDecoder('utf-8', { fatal: true }).decode(branchQuery.stdout).trim();
  if (registrations.some((entry) => entry.head_sha !== capture)) return result('unsafe', registrations.map((entry) => `registration_head=${entry.head_sha}:capture_head=${capture}`), 'owned-git-ref');
  const parents = gitQueryText({ descriptor: { kind: 'rev-list-parents', revision: capture }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).trim().split(/\s+/u).slice(1);
  const paths = exactDiffPaths(request, intent.base_sha, capture);
  if (parents.length !== 1 || parents[0] !== intent.base_sha || !samePaths(intent.paths, paths)) return result('unsafe', [`capture_sha=${capture}`, `owned_ref=${expectedBranch}`, ...parents.map((parent) => `actual_parent=${parent}`), ...intent.paths.map((path) => `expected_path=${path}`), ...paths.map((path) => `actual_path=${path}`)], 'owned-git-ref');
  return effectWithMetadata(request, [`base=${intent.base_sha}`, `capture_sha=${capture}`, `owned_ref=${expectedBranch}`, ...paths.map((path) => `captured=${path}`)], 'owned-git-ref', capture);
}

function resetPostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = ordinaryRequest(requestInput);
  const authority = physicalAuthority(request);
  if (authority !== null) return authority;
  if (!existsSync(request.intent.worktree_path) || request.intent.target_sha === null) return result('unsafe', ['reset_authority_incomplete']);
  const dirty = clean(request, true);
  if (dirty.length > 0) return result('unsafe', dirty);
  const current = head(request);
  if (current === request.intent.target_sha) return effectWithMetadata(request, [`head=${current}`, 'worktree_clean_including_ignored']);
  if (request.intent.base_sha !== null && current === request.intent.base_sha) return result('not-applied', [`head=${current}`, `pending_target_head=${request.intent.target_sha}`, 'worktree_clean_including_ignored']);
  return result('unsafe', [`actual_head=${current}`, `expected_base_head=${String(request.intent.base_sha)}`, `expected_target_head=${request.intent.target_sha}`]);
}

function mergePostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = ordinaryRequest(requestInput);
  const intent = request.intent;
  if (intent.base_sha === null || intent.target_sha === null) return result('unsafe', ['merge_intent_incomplete']);
  const cwd = intent.archive_ref === null ? intent.worktree_path : intent.repo_root;
  if (intent.archive_ref === null) {
    const authority = physicalAuthority(request);
    if (authority !== null) return authority;
    if (!existsSync(cwd)) return result('unsafe', ['merge_worktree_absent']);
    const mergePath = gitQueryText({ descriptor: { kind: 'git-path', name: 'MERGE_HEAD' }, cwd, ...(request.env === undefined ? {} : { env: request.env }) }).trim();
    if (existsSync(isAbsolute(mergePath) ? mergePath : resolve(cwd, mergePath))) return head(request) === intent.base_sha
      ? result('not-applied', [`head=${intent.base_sha}`, 'interrupted_merge'])
      : result('unsafe', ['interrupted_merge_head_moved']);
    const dirty = clean(request, false);
    if (dirty.length > 0) return result('unsafe', dirty);
  }
  const current = gitQueryText({ descriptor: { kind: 'head' }, cwd, ...(request.env === undefined ? {} : { env: request.env }) }).trim();
  if (intent.archive_ref !== null) {
    const branchQuery = runGitQuery({ descriptor: { kind: 'current-branch' }, cwd, ...(request.env === undefined ? {} : { env: request.env }) });
    const branch = branchQuery.negative ? null : new TextDecoder('utf-8', { fatal: true }).decode(branchQuery.stdout).trim();
    if (branch !== intent.archive_ref) return result('unsafe', [`actual_integration_branch=${String(branch)}`, `expected_integration_branch=${intent.archive_ref}`]);
    if (current === intent.target_sha) return effectWithMetadata(request, [`head=${current}`, `merged_source=${intent.target_sha}`]);
    return current === intent.base_sha ? result('not-applied', [`head=${current}`]) : result('unsafe', [`actual_head=${current}`, `expected_base_head=${intent.base_sha}`, `expected_target_head=${intent.target_sha}`]);
  }
  if (!runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor: intent.target_sha, descendant: current }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).negative) return effectWithMetadata(request, [`head=${current}`, `merged_source=${intent.target_sha}`]);
  if (current === intent.base_sha) return result('not-applied', [`head=${current}`]);
  const parents = gitQueryText({ descriptor: { kind: 'rev-list-parents', revision: current }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).trim().split(/\s+/u).slice(1);
  return parents.includes(intent.base_sha) && parents.includes(intent.target_sha)
    ? effectWithMetadata(request, [`base_parent=${intent.base_sha}`, `head=${current}`, `source_parent=${intent.target_sha}`])
    : result('unsafe', [`actual_head=${current}`, ...parents.map((parent) => `actual_parent=${parent}`), `expected_base_parent=${intent.base_sha}`, `expected_source_parent=${intent.target_sha}`]);
}

function archivePostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = ordinaryRequest(requestInput);
  const intent = request.intent;
  if (intent.archive_ref === null || intent.target_sha === null) return result('unsafe', ['archive_intent_incomplete']);
  const ref = `refs/heads/${intent.archive_ref}`;
  const query = runGitQuery({ descriptor: { kind: 'resolve-commit', revision: ref }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) });
  if (query.negative) return result('not-applied', [`archive_ref_absent=${ref}`]);
  const actual = new TextDecoder('utf-8', { fatal: true }).decode(query.stdout).trim();
  return actual === intent.target_sha ? effectWithMetadata(request, [`archive_ref=${ref}`, `archive_sha=${actual}`]) : result('unsafe', [`actual_archive_sha=${actual}`, `expected_archive_sha=${intent.target_sha}`]);
}

function removePostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = ordinaryRequest(requestInput);
  const intent = request.intent;
  const present = existsSync(intent.worktree_path);
  const registration = registrationFor(intent, request.env).exact;
  const branch = runGitQuery({ descriptor: { kind: 'ref-exists', ref: `refs/heads/${intent.branch}` }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) });
  if (!present && registration.length === 0 && branch.negative) {
    const metadata = metadataMissing(request);
    return metadata.length === 0
      ? result('satisfied', ['branch_absent', 'git_registration_absent', 'metadata_complete', 'physical_path_absent'])
      : result('not-applied', metadata.map((ref) => `missing_metadata=${ref}`), 'repository-facts', null, true);
  }
  if (!present && registration.length <= 1 && !branch.negative && intent.target_sha !== null) {
    const actual = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: `refs/heads/${intent.branch}`, verify: true }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).trim();
    return actual === intent.target_sha ? result('not-applied', ['branch_present', `branch_sha=${actual}`, ...(registration.length === 1 ? ['stale_registration_present'] : ['git_registration_absent']), 'physical_path_absent']) : result('unsafe', [`actual_branch_sha=${actual}`, `expected_branch_sha=${intent.target_sha}`]);
  }
  if (present) {
    const authority = physicalAuthority(request);
    if (authority !== null) return authority;
    if (branch.negative || intent.target_sha === null) return result('unsafe', ['owned_branch_or_expected_sha_absent_before_remove']);
    const actual = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: `refs/heads/${intent.branch}`, verify: true }, cwd: intent.repo_root, ...(request.env === undefined ? {} : { env: request.env }) }).trim();
    if (actual !== intent.target_sha) return result('unsafe', [`actual_branch_sha=${actual}`, `expected_branch_sha=${intent.target_sha}`]);
    const dirty = clean(request, true);
    return dirty.length === 0 ? result('not-applied', ['physical_worktree_clean', `branch_sha=${actual}`]) : result('unsafe', dirty);
  }
  return result('unsafe', [`git_registration_count=${String(registration.length)}`, `path_present=${String(present)}`]);
}

function metadataReconcilePostcondition(requestInput: WorktreePostconditionRequest): WorktreePostconditionResult {
  const request = metadataRequest(requestInput);
  const intent = parseMetadataReconcileIntent(request.intent);
  if (pathEntryExists(intent.target_registration_path)) return result('unsafe', ['metadata_reconcile_target_path_present'], 'metadata-registration-set');
  const observed = gitWorktreeRegistrationFacts(intent.git_common_dir, request.env);
  const observedJson = JSON.stringify(observed);
  const beforeJson = JSON.stringify(intent.approved_before_registrations);
  const afterJson = JSON.stringify(intent.expected_after_registrations);
  const refs = intent.preserved_refs.map((entry) => {
    const query = runGitQuery({ descriptor: { kind: 'resolve-revision', revision: entry.ref, verify: true }, cwd: intent.git_common_dir, ...(request.env === undefined ? {} : { env: request.env }) });
    return query.negative ? `${entry.ref}=absent` : `${entry.ref}=${new TextDecoder('utf-8', { fatal: true }).decode(query.stdout).trim()}`;
  });
  const refMismatch = refs.filter((entry, index) => entry !== `${intent.preserved_refs[index]?.ref}=${intent.preserved_refs[index]?.sha}`);
  if (refMismatch.length > 0) return result('unsafe', refMismatch.map((entry) => `preserved_ref_mismatch=${entry}`), 'metadata-registration-set');
  if (observedJson === afterJson) return result('satisfied', ['approved_registration_metadata_absent', ...refs.map((entry) => `preserved_ref=${entry}`)], 'metadata-registration-set');
  if (observedJson === beforeJson) return result('not-applied', ['exact_approved_prunable_set_present', ...refs.map((entry) => `preserved_ref=${entry}`)], 'metadata-registration-set');
  return result('unsafe', ['registration_set_drift', `observed_registration_count=${String(observed.length)}`, `approved_before_count=${String(intent.approved_before_registrations.length)}`, `expected_after_count=${String(intent.expected_after_registrations.length)}`], 'metadata-registration-set');
}

export const WORKTREE_POSTCONDITION_REGISTRY: Readonly<Record<CoordinationWorktreeOperationType, PostconditionHandler>> = Object.freeze({
  create: createPostcondition,
  materialize: materializePostcondition,
  commit: commitPostcondition,
  merge: mergePostcondition,
  reset: resetPostcondition,
  quarantine: quarantinePostcondition,
  archive: archivePostcondition,
  remove: removePostcondition,
  'metadata-reconcile': metadataReconcilePostcondition,
});

export function inspectWorktreePostcondition(request: WorktreePostconditionRequest): WorktreePostconditionResult {
  const identity = assertCanonicalIdentity(request);
  if (identity !== null) return identity;
  try { return WORKTREE_POSTCONDITION_REGISTRY[request.operationType](request); }
  catch (error) {
    return result('unsafe', [`probe_error=${error instanceof Error ? error.name : 'unknown'}`, `probe_message=${error instanceof Error ? error.message : String(error)}`]);
  }
}
