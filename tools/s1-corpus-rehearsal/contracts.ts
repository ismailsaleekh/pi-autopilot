import { isAbsolute } from 'node:path';

export const S1_CORPUS_CLONE_REQUEST_SCHEMA = 'autopilot.s1_corpus_clone_request.v1' as const;
export const S1_CORPUS_CLONE_MANIFEST_SCHEMA = 'autopilot.s1_corpus_clone_manifest.v1' as const;
export const S1_CORPUS_REHEARSAL_RESULT_SCHEMA = 'autopilot.s1_corpus_rehearsal_result.v1' as const;
export const S1_CORPUS_INCIDENTS = Object.freeze(['I1', 'I2', 'I3', 'I4', 'I5'] as const);
export const S1_ACTUAL_CF50_TARBALL_SHA256 = 'sha256:e98ccee99e95d5ba9c958c91c354eef40326fa21cf89a8ba37bd10e6650485a7' as const;
export const S1_I2_CAPTURE_SHA = '8725cf1ba2f361334ce208c7f9e7e417ce780a8a' as const;
export const S1_I2_OPERATION_ID = 'operation-5df1cda32ea1a860e6fe85d8891bb0d2' as const;

export type S1CorpusIncidentId = typeof S1_CORPUS_INCIDENTS[number];
export type Sha256Digest = `sha256:${string}`;

export class S1CorpusContractError extends Error {
  override readonly name = 'S1CorpusContractError';
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super(`${label} failed closed-contract validation: ${issues.join('; ')}`);
    this.issues = Object.freeze([...issues]);
  }
}

interface JsonObject { readonly [key: string]: unknown }

export interface FileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly link_count: number;
}

export interface SourceRoot {
  readonly corpus_id: string;
  readonly label: string;
  readonly kind: 'live-state' | 'live-repository' | 'retained-snapshot';
  readonly path_sha256: Sha256Digest;
  readonly identity: FileIdentity;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly tree_sha256: Sha256Digest;
}

export interface DatabaseComponent {
  readonly corpus_id: string;
  readonly role: 'database' | 'wal' | 'shm' | 'journal';
  readonly present: boolean;
  readonly path_sha256: Sha256Digest;
  readonly identity: FileIdentity | null;
  readonly size_bytes: number | null;
  readonly sha256: Sha256Digest | null;
}

export interface SourceNodeDigest {
  readonly corpus_id: string;
  readonly root_label: string;
  readonly path_sha256: Sha256Digest;
  readonly kind: 'regular' | 'directory' | 'socket' | 'symlink';
  readonly identity: FileIdentity;
  readonly mode: number;
  readonly size_bytes: number;
  readonly sha256: Sha256Digest | null;
  readonly symlink_target_sha256: Sha256Digest | null;
}

export interface SourceGitRef {
  readonly corpus_id: string;
  readonly repository_label: string;
  readonly ref: string;
  readonly object_id: string;
  readonly object_type: 'commit' | 'tag' | 'tree' | 'blob';
}

export interface SourceRegistration {
  readonly corpus_id: string;
  readonly repository_label: string;
  readonly worktree_path_sha256: Sha256Digest;
  readonly head_sha: string;
  readonly branch_ref: string | null;
  readonly prunable: boolean;
  readonly path_present: boolean;
}

export interface CopyRoot {
  readonly corpus_id: string;
  readonly scenario_id: string;
  readonly label: string;
  readonly clone_relative_path: string;
  readonly identity: FileIdentity;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly tree_sha256: Sha256Digest;
}

export interface CopyFileDigest {
  readonly corpus_id: string;
  readonly scenario_id: string;
  readonly root_label: string;
  readonly clone_relative_path: string;
  readonly source_path_sha256: Sha256Digest | null;
  readonly identity: FileIdentity;
  readonly mode: number;
  readonly size_bytes: number;
  readonly sha256: Sha256Digest;
  readonly copy_method: 'stream-copy' | 'sqlite-backup' | 'git-materialization' | 'generated-clone-authority';
}

export type CopyGitFact =
  | {
    readonly kind: 'ref';
    readonly corpus_id: string;
    readonly scenario_id: string;
    readonly repository_label: string;
    readonly ref: string;
    readonly object_id: string;
    readonly object_type: 'commit' | 'tag' | 'tree' | 'blob';
  }
  | {
    readonly kind: 'registration';
    readonly corpus_id: string;
    readonly scenario_id: string;
    readonly repository_label: string;
    readonly worktree_relative_path: string;
    readonly head_sha: string;
    readonly branch_ref: string | null;
    readonly prunable: boolean;
    readonly path_present: boolean;
  };

export interface PathRebase {
  readonly corpus_id: string;
  readonly source_path_sha256: Sha256Digest;
  readonly source_label: string;
  readonly clone_relative_path: string;
  readonly kind: 'state-root' | 'repo-root' | 'git-common-dir' | 'worktree-root' | 'worktree' | 'runtime' | 'evidence';
  readonly rewrite_ledger_sha256: Sha256Digest;
}

export interface BackupCoverage {
  readonly corpus_id: string;
  readonly incident_id: 'I2' | 'I3' | 'I4' | 'I5';
  readonly subject_id_sha256: Sha256Digest;
  readonly coverage: 'exact-filesystem' | 'git-ref-only' | 'database-only' | 'absent';
  readonly snapshot_label: string;
  readonly evidence_sha256: Sha256Digest;
}

export interface IsolationProof {
  readonly passed: boolean;
  readonly evidence_sha256: Sha256Digest;
}

export interface IsolationProofs {
  readonly roots_disjoint: IsolationProof;
  readonly no_shared_regular_file_identity: IsolationProof;
  readonly no_live_symlink_or_hardlink: IsolationProof;
  readonly coherent_sqlite_snapshot: IsolationProof;
  readonly git_objects_self_contained: IsolationProof;
  readonly git_no_alternates_or_shared_metadata: IsolationProof;
  readonly no_live_writable_remote_or_config_include: IsolationProof;
  readonly authority_files_removed: IsolationProof;
  readonly capability_fresh: IsolationProof;
  readonly actionable_paths_clone_contained: IsolationProof;
  readonly environment_clone_only: IsolationProof;
  readonly sandbox_write_confinement: IsolationProof;
  readonly construction_live_unchanged: IsolationProof;
}

export interface I1Requirement {
  readonly incident_id: 'I1';
  readonly corpus_id: string;
  readonly cf50_tarball_sha256: Sha256Digest;
  readonly directions: readonly ['cf50-client-to-s1', 's1-client-to-cf50', 'mixed-election'];
  readonly actions: readonly ['attach', 'heartbeat', 'idempotent-replay', 'natural-restart'];
}

export interface I2Requirement {
  readonly incident_id: 'I2';
  readonly corpus_id: string;
  readonly operation_id: string;
  readonly capture_sha: string;
  readonly parent_sha: string;
  readonly exact_path_set_sha256: Sha256Digest;
  readonly owner_sha256: Sha256Digest;
  readonly historical_write_lease_count: 42;
  readonly historical_write_lease_ids_sha256: Sha256Digest;
}

export interface I3Requirement {
  readonly incident_id: 'I3';
  readonly corpus_id: string;
  readonly semantic_twin_count: 46;
  readonly semantic_identity_set_sha256: Sha256Digest;
  readonly operation_history_set_sha256: Sha256Digest;
  readonly next_attempt_owner_sha256: Sha256Digest;
}

export interface I4Requirement {
  readonly incident_id: 'I4';
  readonly corpus_id: string;
  readonly counter_behind_repo_sha256: Sha256Digest;
  readonly faulted_run_sha256: Sha256Digest;
  readonly healthy_run_sha256: Sha256Digest;
  readonly fatal_negative_kinds: readonly ['counter-ahead', 'payload-owner-ambiguous', 'physical-integrity'];
}

export interface I5Requirement {
  readonly incident_id: 'I5';
  readonly corpus_id: string;
  readonly missing_registration_count: 34;
  readonly registration_set_sha256: Sha256Digest;
  readonly preserved_ref_set_sha256: Sha256Digest;
  readonly exact_filesystem_coverage_count: 7;
  readonly absence_coverage_count: 27;
}

export type RequiredIncident = I1Requirement | I2Requirement | I3Requirement | I4Requirement | I5Requirement;

export interface CorpusCloneManifest {
  readonly schema_version: typeof S1_CORPUS_CLONE_MANIFEST_SCHEMA;
  readonly rehearsal_id: string;
  readonly created_at: string;
  readonly source_roots: readonly SourceRoot[];
  readonly source_database_components: readonly DatabaseComponent[];
  readonly source_file_digests: readonly SourceNodeDigest[];
  readonly source_git_refs: readonly SourceGitRef[];
  readonly source_worktree_registrations: readonly SourceRegistration[];
  readonly copy_roots: readonly CopyRoot[];
  readonly copy_file_digests: readonly CopyFileDigest[];
  readonly copy_git_refs: readonly CopyGitFact[];
  readonly path_rebase_map: readonly PathRebase[];
  readonly backup_coverage: readonly BackupCoverage[];
  readonly capability_sha256: Sha256Digest;
  readonly isolation_proofs: IsolationProofs;
  readonly required_incidents: readonly [I1Requirement, I2Requirement, I3Requirement, I4Requirement, I5Requirement];
}

export interface CorpusSourceRequest {
  readonly corpus_id: string;
  readonly state_root: string;
  readonly repository_root: string;
  readonly database_path: string;
  readonly retained_snapshot_roots: readonly string[];
}

export interface CorpusCloneRequest {
  readonly schema_version: typeof S1_CORPUS_CLONE_REQUEST_SCHEMA;
  readonly rehearsal_id: string;
  readonly created_at: string;
  readonly destination_root: string;
  readonly result_path: string;
  readonly candidate_tarball_path: string;
  readonly candidate_tarball_sha256: Sha256Digest;
  readonly cf50_tarball_path: string;
  readonly cf50_tarball_sha256: Sha256Digest;
  readonly corpora: readonly CorpusSourceRequest[];
}

export type Outcome = 'passed' | 'expected-blocked' | 'failed';

export interface AttachResult {
  readonly corpus_id: string;
  readonly scenario_id: string;
  readonly repo_id_sha256: Sha256Digest;
  readonly run_id_sha256: Sha256Digest;
  readonly attachment_kind: 'dispatch' | 'terminal-recovery' | 'migration-recovery' | 'terminal-query-only';
  readonly outcome: Outcome;
  readonly committed_event_seq: number | null;
  readonly diagnostic_codes: readonly string[];
}

export interface DoctorResult {
  readonly corpus_id: string;
  readonly scenario_id: string;
  readonly phase: 'post-migration' | 'post-reconciliation';
  readonly integrity: 'ok' | 'failed';
  readonly healthy: boolean;
  readonly finding_count: number;
  readonly finding_codes: readonly string[];
  readonly projection_sha256: Sha256Digest;
}

export interface ReconciliationResult {
  readonly corpus_id: string;
  readonly scenario_id: string;
  readonly run_id_sha256: Sha256Digest;
  readonly consumer: 'worktree-saga' | 'failed-unit-authority' | 'canonical-identity' | 'metadata-reconcile' | 'run-reconcile';
  readonly before_sha256: Sha256Digest;
  readonly after_sha256: Sha256Digest;
  readonly replayed: boolean;
  readonly outcome: Outcome;
  readonly diagnostic_codes: readonly string[];
}

export interface DispatchDryRunResult {
  readonly corpus_id: string;
  readonly scenario_id: string;
  readonly run_id_sha256: Sha256Digest;
  readonly disposition: 'launchable' | 'paused' | 'recovering' | 'terminal';
  readonly planner_invoked: boolean;
  readonly scheduler_plan_sha256: Sha256Digest | null;
  readonly selected_count: number;
  readonly skipped_code_counts: readonly { readonly code: string; readonly count: number }[];
  readonly coordinator_admission_probe: 'acquire-cancel' | 'not-applicable';
  readonly coordinator_admission_probe_code: string;
  readonly agent_process_started: false;
  readonly external_git_effect_started: false;
  readonly outcome: Outcome;
}

export interface IncidentResult {
  readonly incident_id: S1CorpusIncidentId;
  readonly provenance: 'retained-actual' | 'actual-plus-controlled-clone-injection';
  readonly passed: boolean;
  readonly assertion_ids: readonly string[];
  readonly evidence_sha256: Sha256Digest;
}

export interface CopyPostDigests {
  readonly roots_sha256: Sha256Digest;
  readonly databases_sha256: Sha256Digest;
  readonly evidence_sha256: Sha256Digest;
  readonly git_refs_sha256: Sha256Digest;
  readonly registrations_sha256: Sha256Digest;
  readonly worktrees_sha256: Sha256Digest;
}

export interface LiveDigestSet {
  readonly database_components_sha256: Sha256Digest;
  readonly evidence_sha256: Sha256Digest;
  readonly authority_objects_sha256: Sha256Digest;
  readonly git_refs_sha256: Sha256Digest;
  readonly registrations_sha256: Sha256Digest;
  readonly worktrees_sha256: Sha256Digest;
}

export interface LiveUnchanged {
  readonly baseline_inventory_sha256: Sha256Digest;
  readonly post_inventory_sha256: Sha256Digest;
  readonly database_components: boolean;
  readonly evidence: boolean;
  readonly authority_objects: boolean;
  readonly git_refs: boolean;
  readonly registrations: boolean;
  readonly worktrees: boolean;
  readonly passed: boolean;
}

export interface CorpusBlocker {
  readonly code: string;
  readonly corpus_id: string | null;
  readonly run_id_sha256: Sha256Digest | null;
  readonly incident_id: S1CorpusIncidentId | null;
  readonly diagnostic_sha256: Sha256Digest;
}

export interface CorpusRehearsalResult {
  readonly schema_version: typeof S1_CORPUS_REHEARSAL_RESULT_SCHEMA;
  readonly rehearsal_id: string;
  readonly candidate_build: '1.2.0-s1';
  readonly store_generation_id: readonly { readonly corpus_id: string; readonly scenario_id: string; readonly generation_id: string }[];
  readonly attach_results: readonly AttachResult[];
  readonly doctor_results: readonly DoctorResult[];
  readonly reconciliation_results: readonly ReconciliationResult[];
  readonly dispatch_dry_run_results: readonly DispatchDryRunResult[];
  readonly incident_results: readonly [IncidentResult, IncidentResult, IncidentResult, IncidentResult, IncidentResult];
  readonly copy_post_digests: CopyPostDigests;
  readonly live_post_digests: LiveDigestSet;
  readonly live_unchanged: LiveUnchanged;
  readonly new_blockers: readonly CorpusBlocker[];
  readonly completed_at: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const DIAGNOSTIC = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_ARRAY = 1_000_000;

function object(value: unknown, fields: readonly string[], label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new S1CorpusContractError(label, ['must be an object']);
  const record = value as JsonObject;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) throw new S1CorpusContractError(label, [`field set mismatch: ${actual.join(',')}`]);
  return record;
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) throw new S1CorpusContractError(label, ['must be bounded nonempty text without NUL']);
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label, 192);
  if (!IDENTIFIER.test(parsed)) throw new S1CorpusContractError(label, ['must be a closed identifier']);
  return parsed;
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new S1CorpusContractError(label, ['must be sha256:<64 lowercase hex>']);
  return value as Sha256Digest;
}

function objectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new S1CorpusContractError(label, ['must be a 40- or 64-hex Git object ID']);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 32);
  if (!RFC3339.test(parsed) || !Number.isFinite(Date.parse(parsed))) throw new S1CorpusContractError(label, ['must be canonical UTC RFC3339']);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new S1CorpusContractError(label, [`must be an integer >= ${String(minimum)}`]);
  return value;
}

function permissionMode(value: unknown, label: string): number {
  const mode = integer(value, label);
  if (mode > 0o777) throw new S1CorpusContractError(label, ['must contain only portable rwx permission bits']);
  return mode;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new S1CorpusContractError(label, ['must be boolean']);
  return value;
}

function array(value: unknown, label: string, max = MAX_ARRAY): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new S1CorpusContractError(label, [`must be an array with at most ${String(max)} entries`]);
  return value;
}

function exactLiteral<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new S1CorpusContractError(label, [`must be one of ${values.join(',')}`]);
  return value as T;
}

function nullable<T>(value: unknown, parse: (entry: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function absolutePath(value: unknown, label: string): string {
  const path = text(value, label, 4096);
  if (!isAbsolute(path)) throw new S1CorpusContractError(label, ['must be absolute']);
  return path;
}

function relativePath(value: unknown, label: string): string {
  const path = text(value, label, 4096);
  const segments = path.replace(/\\/gu, '/').split('/');
  if (isAbsolute(path) || /^[A-Za-z]:/u.test(path) || segments.some((segment) => segment.includes(':')) || segments.includes('..') || segments.includes('.') || segments.includes('')) throw new S1CorpusContractError(label, ['must be a normalized portable nonempty relative path']);
  return segments.join('/');
}

function sortedUnique<T>(values: readonly T[], identity: (entry: T) => string, label: string): readonly T[] {
  const keys = values.map(identity);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= (keys[index - 1] ?? ''))) throw new S1CorpusContractError(label, ['must be sorted and unique']);
  return Object.freeze([...values]);
}

function parseIdentity(value: unknown, label: string): FileIdentity {
  const row = object(value, ['device', 'inode', 'link_count'], label);
  return Object.freeze({ device: text(row['device'], `${label}.device`, 64), inode: text(row['inode'], `${label}.inode`, 64), link_count: integer(row['link_count'], `${label}.link_count`, 1) });
}

function parseSourceRoot(value: unknown, label: string): SourceRoot {
  const row = object(value, ['corpus_id', 'label', 'kind', 'path_sha256', 'identity', 'file_count', 'total_bytes', 'tree_sha256'], label);
  return Object.freeze({
    corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), label: identifier(row['label'], `${label}.label`),
    kind: exactLiteral(row['kind'], ['live-state', 'live-repository', 'retained-snapshot'] as const, `${label}.kind`),
    path_sha256: digest(row['path_sha256'], `${label}.path_sha256`), identity: parseIdentity(row['identity'], `${label}.identity`),
    file_count: integer(row['file_count'], `${label}.file_count`), total_bytes: integer(row['total_bytes'], `${label}.total_bytes`), tree_sha256: digest(row['tree_sha256'], `${label}.tree_sha256`),
  });
}

function parseDatabaseComponent(value: unknown, label: string): DatabaseComponent {
  const row = object(value, ['corpus_id', 'role', 'present', 'path_sha256', 'identity', 'size_bytes', 'sha256'], label);
  const present = booleanValue(row['present'], `${label}.present`);
  const identityValue = nullable(row['identity'], (entry) => parseIdentity(entry, `${label}.identity`));
  const size = nullable(row['size_bytes'], (entry) => integer(entry, `${label}.size_bytes`));
  const sha = nullable(row['sha256'], (entry) => digest(entry, `${label}.sha256`));
  if (present !== (identityValue !== null && size !== null && sha !== null)) throw new S1CorpusContractError(label, ['presence must agree with identity, size, and digest']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), role: exactLiteral(row['role'], ['database', 'journal', 'shm', 'wal'] as const, `${label}.role`), present, path_sha256: digest(row['path_sha256'], `${label}.path_sha256`), identity: identityValue, size_bytes: size, sha256: sha });
}

function parseSourceNode(value: unknown, label: string): SourceNodeDigest {
  const row = object(value, ['corpus_id', 'root_label', 'path_sha256', 'kind', 'identity', 'mode', 'size_bytes', 'sha256', 'symlink_target_sha256'], label);
  const kind = exactLiteral(row['kind'], ['regular', 'directory', 'socket', 'symlink'] as const, `${label}.kind`);
  const sha = nullable(row['sha256'], (entry) => digest(entry, `${label}.sha256`));
  const target = nullable(row['symlink_target_sha256'], (entry) => digest(entry, `${label}.symlink_target_sha256`));
  if ((kind === 'regular') !== (sha !== null) || (kind === 'symlink') !== (target !== null)) throw new S1CorpusContractError(label, ['node kind disagrees with content/target digest']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), root_label: identifier(row['root_label'], `${label}.root_label`), path_sha256: digest(row['path_sha256'], `${label}.path_sha256`), kind, identity: parseIdentity(row['identity'], `${label}.identity`), mode: permissionMode(row['mode'], `${label}.mode`), size_bytes: integer(row['size_bytes'], `${label}.size_bytes`), sha256: sha, symlink_target_sha256: target });
}

function parseGitRef(value: unknown, label: string): SourceGitRef {
  const row = object(value, ['corpus_id', 'repository_label', 'ref', 'object_id', 'object_type'], label);
  const ref = text(row['ref'], `${label}.ref`, 1024);
  if (!ref.startsWith('refs/')) throw new S1CorpusContractError(`${label}.ref`, ['must be normalized under refs/']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), repository_label: identifier(row['repository_label'], `${label}.repository_label`), ref, object_id: objectId(row['object_id'], `${label}.object_id`), object_type: exactLiteral(row['object_type'], ['commit', 'tag', 'tree', 'blob'] as const, `${label}.object_type`) });
}

function parseRegistration(value: unknown, label: string): SourceRegistration {
  const row = object(value, ['corpus_id', 'repository_label', 'worktree_path_sha256', 'head_sha', 'branch_ref', 'prunable', 'path_present'], label);
  const branch = nullable(row['branch_ref'], (entry) => text(entry, `${label}.branch_ref`, 1024));
  if (branch !== null && !branch.startsWith('refs/heads/')) throw new S1CorpusContractError(`${label}.branch_ref`, ['must be a normalized branch ref']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), repository_label: identifier(row['repository_label'], `${label}.repository_label`), worktree_path_sha256: digest(row['worktree_path_sha256'], `${label}.worktree_path_sha256`), head_sha: objectId(row['head_sha'], `${label}.head_sha`), branch_ref: branch, prunable: booleanValue(row['prunable'], `${label}.prunable`), path_present: booleanValue(row['path_present'], `${label}.path_present`) });
}

function parseCopyRoot(value: unknown, label: string): CopyRoot {
  const row = object(value, ['corpus_id', 'scenario_id', 'label', 'clone_relative_path', 'identity', 'file_count', 'total_bytes', 'tree_sha256'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(row['scenario_id'], `${label}.scenario_id`), label: identifier(row['label'], `${label}.label`), clone_relative_path: relativePath(row['clone_relative_path'], `${label}.clone_relative_path`), identity: parseIdentity(row['identity'], `${label}.identity`), file_count: integer(row['file_count'], `${label}.file_count`), total_bytes: integer(row['total_bytes'], `${label}.total_bytes`), tree_sha256: digest(row['tree_sha256'], `${label}.tree_sha256`) });
}

function parseCopyFile(value: unknown, label: string): CopyFileDigest {
  const row = object(value, ['corpus_id', 'scenario_id', 'root_label', 'clone_relative_path', 'source_path_sha256', 'identity', 'mode', 'size_bytes', 'sha256', 'copy_method'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(row['scenario_id'], `${label}.scenario_id`), root_label: identifier(row['root_label'], `${label}.root_label`), clone_relative_path: relativePath(row['clone_relative_path'], `${label}.clone_relative_path`), source_path_sha256: nullable(row['source_path_sha256'], (entry) => digest(entry, `${label}.source_path_sha256`)), identity: parseIdentity(row['identity'], `${label}.identity`), mode: permissionMode(row['mode'], `${label}.mode`), size_bytes: integer(row['size_bytes'], `${label}.size_bytes`), sha256: digest(row['sha256'], `${label}.sha256`), copy_method: exactLiteral(row['copy_method'], ['stream-copy', 'sqlite-backup', 'git-materialization', 'generated-clone-authority'] as const, `${label}.copy_method`) });
}

function parseCopyGitFact(value: unknown, label: string): CopyGitFact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new S1CorpusContractError(label, ['must be an object']);
  const kind = (value as JsonObject)['kind'];
  if (kind === 'ref') {
    const row = object(value, ['kind', 'corpus_id', 'scenario_id', 'repository_label', 'ref', 'object_id', 'object_type'], label);
    const ref = text(row['ref'], `${label}.ref`, 1024);
    if (!ref.startsWith('refs/')) throw new S1CorpusContractError(`${label}.ref`, ['must be normalized under refs/']);
    return Object.freeze({ kind, corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(row['scenario_id'], `${label}.scenario_id`), repository_label: identifier(row['repository_label'], `${label}.repository_label`), ref, object_id: objectId(row['object_id'], `${label}.object_id`), object_type: exactLiteral(row['object_type'], ['commit', 'tag', 'tree', 'blob'] as const, `${label}.object_type`) });
  }
  const row = object(value, ['kind', 'corpus_id', 'scenario_id', 'repository_label', 'worktree_relative_path', 'head_sha', 'branch_ref', 'prunable', 'path_present'], label);
  if (row['kind'] !== 'registration') throw new S1CorpusContractError(`${label}.kind`, ['must be ref or registration']);
  const branch = nullable(row['branch_ref'], (entry) => text(entry, `${label}.branch_ref`, 1024));
  return Object.freeze({ kind: 'registration', corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(row['scenario_id'], `${label}.scenario_id`), repository_label: identifier(row['repository_label'], `${label}.repository_label`), worktree_relative_path: relativePath(row['worktree_relative_path'], `${label}.worktree_relative_path`), head_sha: objectId(row['head_sha'], `${label}.head_sha`), branch_ref: branch, prunable: booleanValue(row['prunable'], `${label}.prunable`), path_present: booleanValue(row['path_present'], `${label}.path_present`) });
}

function parsePathRebase(value: unknown, label: string): PathRebase {
  const row = object(value, ['corpus_id', 'source_path_sha256', 'source_label', 'clone_relative_path', 'kind', 'rewrite_ledger_sha256'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), source_path_sha256: digest(row['source_path_sha256'], `${label}.source_path_sha256`), source_label: identifier(row['source_label'], `${label}.source_label`), clone_relative_path: relativePath(row['clone_relative_path'], `${label}.clone_relative_path`), kind: exactLiteral(row['kind'], ['state-root', 'repo-root', 'git-common-dir', 'worktree-root', 'worktree', 'runtime', 'evidence'] as const, `${label}.kind`), rewrite_ledger_sha256: digest(row['rewrite_ledger_sha256'], `${label}.rewrite_ledger_sha256`) });
}

function parseBackupCoverage(value: unknown, label: string): BackupCoverage {
  const row = object(value, ['corpus_id', 'incident_id', 'subject_id_sha256', 'coverage', 'snapshot_label', 'evidence_sha256'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), incident_id: exactLiteral(row['incident_id'], ['I2', 'I3', 'I4', 'I5'] as const, `${label}.incident_id`), subject_id_sha256: digest(row['subject_id_sha256'], `${label}.subject_id_sha256`), coverage: exactLiteral(row['coverage'], ['exact-filesystem', 'git-ref-only', 'database-only', 'absent'] as const, `${label}.coverage`), snapshot_label: identifier(row['snapshot_label'], `${label}.snapshot_label`), evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}

function parseProof(value: unknown, label: string): IsolationProof {
  const row = object(value, ['passed', 'evidence_sha256'], label);
  return Object.freeze({ passed: booleanValue(row['passed'], `${label}.passed`), evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}

const PROOF_FIELDS = Object.freeze(['roots_disjoint', 'no_shared_regular_file_identity', 'no_live_symlink_or_hardlink', 'coherent_sqlite_snapshot', 'git_objects_self_contained', 'git_no_alternates_or_shared_metadata', 'no_live_writable_remote_or_config_include', 'authority_files_removed', 'capability_fresh', 'actionable_paths_clone_contained', 'environment_clone_only', 'sandbox_write_confinement', 'construction_live_unchanged'] as const);

function parseProofs(value: unknown): IsolationProofs {
  const row = object(value, PROOF_FIELDS, 'manifest.isolation_proofs');
  return Object.freeze({
    roots_disjoint: parseProof(row['roots_disjoint'], 'manifest.isolation_proofs.roots_disjoint'),
    no_shared_regular_file_identity: parseProof(row['no_shared_regular_file_identity'], 'manifest.isolation_proofs.no_shared_regular_file_identity'),
    no_live_symlink_or_hardlink: parseProof(row['no_live_symlink_or_hardlink'], 'manifest.isolation_proofs.no_live_symlink_or_hardlink'),
    coherent_sqlite_snapshot: parseProof(row['coherent_sqlite_snapshot'], 'manifest.isolation_proofs.coherent_sqlite_snapshot'),
    git_objects_self_contained: parseProof(row['git_objects_self_contained'], 'manifest.isolation_proofs.git_objects_self_contained'),
    git_no_alternates_or_shared_metadata: parseProof(row['git_no_alternates_or_shared_metadata'], 'manifest.isolation_proofs.git_no_alternates_or_shared_metadata'),
    no_live_writable_remote_or_config_include: parseProof(row['no_live_writable_remote_or_config_include'], 'manifest.isolation_proofs.no_live_writable_remote_or_config_include'),
    authority_files_removed: parseProof(row['authority_files_removed'], 'manifest.isolation_proofs.authority_files_removed'),
    capability_fresh: parseProof(row['capability_fresh'], 'manifest.isolation_proofs.capability_fresh'),
    actionable_paths_clone_contained: parseProof(row['actionable_paths_clone_contained'], 'manifest.isolation_proofs.actionable_paths_clone_contained'),
    environment_clone_only: parseProof(row['environment_clone_only'], 'manifest.isolation_proofs.environment_clone_only'),
    sandbox_write_confinement: parseProof(row['sandbox_write_confinement'], 'manifest.isolation_proofs.sandbox_write_confinement'),
    construction_live_unchanged: parseProof(row['construction_live_unchanged'], 'manifest.isolation_proofs.construction_live_unchanged'),
  });
}

function exactTuple<T extends string>(value: unknown, expected: readonly T[], label: string): readonly T[] {
  const values = array(value, label, expected.length);
  if (values.length !== expected.length || values.some((entry, index) => entry !== expected[index])) throw new S1CorpusContractError(label, [`must equal ${expected.join(',')}`]);
  return Object.freeze([...expected]);
}

function parseRequirement(value: unknown, expectedIncident: S1CorpusIncidentId, label: string): RequiredIncident {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as JsonObject)['incident_id'] !== expectedIncident) throw new S1CorpusContractError(label, [`must be ${expectedIncident}`]);
  if (expectedIncident === 'I1') {
    const row = object(value, ['incident_id', 'corpus_id', 'cf50_tarball_sha256', 'directions', 'actions'], label);
    const cf50Digest = digest(row['cf50_tarball_sha256'], `${label}.cf50_tarball_sha256`);
    if (cf50Digest !== S1_ACTUAL_CF50_TARBALL_SHA256) throw new S1CorpusContractError(`${label}.cf50_tarball_sha256`, ['must equal the frozen actual published cf50 fixture digest']);
    return Object.freeze({ incident_id: 'I1', corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), cf50_tarball_sha256: cf50Digest, directions: exactTuple(row['directions'], ['cf50-client-to-s1', 's1-client-to-cf50', 'mixed-election'] as const, `${label}.directions`) as I1Requirement['directions'], actions: exactTuple(row['actions'], ['attach', 'heartbeat', 'idempotent-replay', 'natural-restart'] as const, `${label}.actions`) as I1Requirement['actions'] });
  }
  if (expectedIncident === 'I2') {
    const row = object(value, ['incident_id', 'corpus_id', 'operation_id', 'capture_sha', 'parent_sha', 'exact_path_set_sha256', 'owner_sha256', 'historical_write_lease_count', 'historical_write_lease_ids_sha256'], label);
    if (row['historical_write_lease_count'] !== 42) throw new S1CorpusContractError(`${label}.historical_write_lease_count`, ['must equal 42']);
    const operationId = identifier(row['operation_id'], `${label}.operation_id`);
    const captureSha = objectId(row['capture_sha'], `${label}.capture_sha`);
    if (operationId !== S1_I2_OPERATION_ID || captureSha !== S1_I2_CAPTURE_SHA) throw new S1CorpusContractError(label, ['I2 must bind the exact retained operation and capture commit']);
    return Object.freeze({ incident_id: 'I2', corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), operation_id: operationId, capture_sha: captureSha, parent_sha: objectId(row['parent_sha'], `${label}.parent_sha`), exact_path_set_sha256: digest(row['exact_path_set_sha256'], `${label}.exact_path_set_sha256`), owner_sha256: digest(row['owner_sha256'], `${label}.owner_sha256`), historical_write_lease_count: 42, historical_write_lease_ids_sha256: digest(row['historical_write_lease_ids_sha256'], `${label}.historical_write_lease_ids_sha256`) });
  }
  if (expectedIncident === 'I3') {
    const row = object(value, ['incident_id', 'corpus_id', 'semantic_twin_count', 'semantic_identity_set_sha256', 'operation_history_set_sha256', 'next_attempt_owner_sha256'], label);
    if (row['semantic_twin_count'] !== 46) throw new S1CorpusContractError(`${label}.semantic_twin_count`, ['must equal 46']);
    return Object.freeze({ incident_id: 'I3', corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), semantic_twin_count: 46, semantic_identity_set_sha256: digest(row['semantic_identity_set_sha256'], `${label}.semantic_identity_set_sha256`), operation_history_set_sha256: digest(row['operation_history_set_sha256'], `${label}.operation_history_set_sha256`), next_attempt_owner_sha256: digest(row['next_attempt_owner_sha256'], `${label}.next_attempt_owner_sha256`) });
  }
  if (expectedIncident === 'I4') {
    const row = object(value, ['incident_id', 'corpus_id', 'counter_behind_repo_sha256', 'faulted_run_sha256', 'healthy_run_sha256', 'fatal_negative_kinds'], label);
    return Object.freeze({ incident_id: 'I4', corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), counter_behind_repo_sha256: digest(row['counter_behind_repo_sha256'], `${label}.counter_behind_repo_sha256`), faulted_run_sha256: digest(row['faulted_run_sha256'], `${label}.faulted_run_sha256`), healthy_run_sha256: digest(row['healthy_run_sha256'], `${label}.healthy_run_sha256`), fatal_negative_kinds: exactTuple(row['fatal_negative_kinds'], ['counter-ahead', 'payload-owner-ambiguous', 'physical-integrity'] as const, `${label}.fatal_negative_kinds`) as I4Requirement['fatal_negative_kinds'] });
  }
  const row = object(value, ['incident_id', 'corpus_id', 'missing_registration_count', 'registration_set_sha256', 'preserved_ref_set_sha256', 'exact_filesystem_coverage_count', 'absence_coverage_count'], label);
  if (row['missing_registration_count'] !== 34 || row['exact_filesystem_coverage_count'] !== 7 || row['absence_coverage_count'] !== 27) throw new S1CorpusContractError(label, ['I5 counts must equal 34/7/27']);
  return Object.freeze({ incident_id: 'I5', corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), missing_registration_count: 34, registration_set_sha256: digest(row['registration_set_sha256'], `${label}.registration_set_sha256`), preserved_ref_set_sha256: digest(row['preserved_ref_set_sha256'], `${label}.preserved_ref_set_sha256`), exact_filesystem_coverage_count: 7, absence_coverage_count: 27 });
}

function parseList<T>(value: unknown, label: string, parse: (entry: unknown, entryLabel: string) => T, identity: (entry: T) => string): readonly T[] {
  const parsed = array(value, label).map((entry, index) => parse(entry, `${label}[${String(index)}]`));
  return sortedUnique(parsed, identity, label);
}

export function parseCorpusCloneManifest(value: unknown): CorpusCloneManifest {
  const fields = ['schema_version', 'rehearsal_id', 'created_at', 'source_roots', 'source_database_components', 'source_file_digests', 'source_git_refs', 'source_worktree_registrations', 'copy_roots', 'copy_file_digests', 'copy_git_refs', 'path_rebase_map', 'backup_coverage', 'capability_sha256', 'isolation_proofs', 'required_incidents'];
  const row = object(value, fields, 'CorpusCloneManifest');
  if (row['schema_version'] !== S1_CORPUS_CLONE_MANIFEST_SCHEMA) throw new S1CorpusContractError('manifest.schema_version', ['unsupported schema']);
  const requirements = array(row['required_incidents'], 'manifest.required_incidents', 5);
  if (requirements.length !== 5) throw new S1CorpusContractError('manifest.required_incidents', ['must contain I1-I5 exactly once']);
  const i1 = parseRequirement(requirements[0], 'I1', 'manifest.required_incidents[0]') as I1Requirement;
  const i2 = parseRequirement(requirements[1], 'I2', 'manifest.required_incidents[1]') as I2Requirement;
  const i3 = parseRequirement(requirements[2], 'I3', 'manifest.required_incidents[2]') as I3Requirement;
  const i4 = parseRequirement(requirements[3], 'I4', 'manifest.required_incidents[3]') as I4Requirement;
  const i5 = parseRequirement(requirements[4], 'I5', 'manifest.required_incidents[4]') as I5Requirement;
  const manifest = Object.freeze({
    schema_version: S1_CORPUS_CLONE_MANIFEST_SCHEMA,
    rehearsal_id: identifier(row['rehearsal_id'], 'manifest.rehearsal_id'),
    created_at: timestamp(row['created_at'], 'manifest.created_at'),
    source_roots: parseList(row['source_roots'], 'manifest.source_roots', parseSourceRoot, (entry) => `${entry.corpus_id}\u0000${entry.label}`),
    source_database_components: parseList(row['source_database_components'], 'manifest.source_database_components', parseDatabaseComponent, (entry) => `${entry.corpus_id}\u0000${entry.role}`),
    source_file_digests: parseList(row['source_file_digests'], 'manifest.source_file_digests', parseSourceNode, (entry) => `${entry.corpus_id}\u0000${entry.root_label}\u0000${entry.path_sha256}`),
    source_git_refs: parseList(row['source_git_refs'], 'manifest.source_git_refs', parseGitRef, (entry) => `${entry.corpus_id}\u0000${entry.repository_label}\u0000${entry.ref}`),
    source_worktree_registrations: parseList(row['source_worktree_registrations'], 'manifest.source_worktree_registrations', parseRegistration, (entry) => `${entry.corpus_id}\u0000${entry.repository_label}\u0000${entry.worktree_path_sha256}`),
    copy_roots: parseList(row['copy_roots'], 'manifest.copy_roots', parseCopyRoot, (entry) => `${entry.corpus_id}\u0000${entry.scenario_id}\u0000${entry.label}`),
    copy_file_digests: parseList(row['copy_file_digests'], 'manifest.copy_file_digests', parseCopyFile, (entry) => `${entry.corpus_id}\u0000${entry.scenario_id}\u0000${entry.root_label}\u0000${entry.clone_relative_path}`),
    copy_git_refs: parseList(row['copy_git_refs'], 'manifest.copy_git_refs', parseCopyGitFact, (entry) => entry.kind === 'ref' ? `${entry.corpus_id}\u0000${entry.scenario_id}\u0000ref\u0000${entry.ref}` : `${entry.corpus_id}\u0000${entry.scenario_id}\u0000registration\u0000${entry.worktree_relative_path}`),
    path_rebase_map: parseList(row['path_rebase_map'], 'manifest.path_rebase_map', parsePathRebase, (entry) => `${entry.corpus_id}\u0000${entry.source_path_sha256}`),
    backup_coverage: parseList(row['backup_coverage'], 'manifest.backup_coverage', parseBackupCoverage, (entry) => `${entry.corpus_id}\u0000${entry.incident_id}\u0000${entry.subject_id_sha256}`),
    capability_sha256: digest(row['capability_sha256'], 'manifest.capability_sha256'),
    isolation_proofs: parseProofs(row['isolation_proofs']),
    required_incidents: Object.freeze([i1, i2, i3, i4, i5] as const),
  });
  if (Object.values(manifest.isolation_proofs).some((proof) => !proof.passed)) throw new S1CorpusContractError('manifest.isolation_proofs', ['every independently measured proof must pass before rehearsal']);
  for (const [label, values] of [
    ['source_roots', manifest.source_roots], ['source_database_components', manifest.source_database_components], ['source_file_digests', manifest.source_file_digests],
    ['source_git_refs', manifest.source_git_refs], ['source_worktree_registrations', manifest.source_worktree_registrations], ['copy_roots', manifest.copy_roots],
    ['copy_file_digests', manifest.copy_file_digests], ['copy_git_refs', manifest.copy_git_refs], ['path_rebase_map', manifest.path_rebase_map], ['backup_coverage', manifest.backup_coverage],
  ] as const) if (values.length === 0) throw new S1CorpusContractError(`manifest.${label}`, ['must not be empty']);
  const corpusIds = new Set(manifest.source_roots.map((entry) => entry.corpus_id));
  for (const corpusId of corpusIds) {
    const rootKinds = new Set(manifest.source_roots.filter((entry) => entry.corpus_id === corpusId).map((entry) => entry.kind));
    if (!rootKinds.has('live-state') || !rootKinds.has('live-repository')) throw new S1CorpusContractError('manifest.source_roots', ['every corpus must include measured live-state and live-repository roots']);
    const components = manifest.source_database_components.filter((entry) => entry.corpus_id === corpusId);
    if (components.map((entry) => entry.role).join(',') !== 'database,journal,shm,wal' || components[0]?.present !== true) throw new S1CorpusContractError('manifest.source_database_components', ['every corpus must measure database,journal,shm,wal exactly and the database must be present']);
  }
  if (manifest.required_incidents.some((requirement) => !corpusIds.has(requirement.corpus_id))) throw new S1CorpusContractError('manifest.required_incidents', ['every incident must name a measured source corpus']);
  const i5Registrations = manifest.source_worktree_registrations.filter((entry) => entry.corpus_id === i5.corpus_id && entry.prunable && !entry.path_present);
  const i5Coverage = manifest.backup_coverage.filter((entry) => entry.corpus_id === i5.corpus_id && entry.incident_id === 'I5');
  if (i5Registrations.length !== 34 || i5Coverage.length !== 34
    || i5Coverage.filter((entry) => entry.coverage === 'exact-filesystem').length !== 7
    || i5Coverage.filter((entry) => entry.coverage === 'absent').length !== 27) throw new S1CorpusContractError('manifest I5 coverage', ['measured registrations and backup coverage must equal 34/7/27']);
  return manifest;
}

function parseSourceRequest(value: unknown, label: string): CorpusSourceRequest {
  const row = object(value, ['corpus_id', 'state_root', 'repository_root', 'database_path', 'retained_snapshot_roots'], label);
  const retained = array(row['retained_snapshot_roots'], `${label}.retained_snapshot_roots`, 64).map((entry, index) => absolutePath(entry, `${label}.retained_snapshot_roots[${String(index)}]`));
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), state_root: absolutePath(row['state_root'], `${label}.state_root`), repository_root: absolutePath(row['repository_root'], `${label}.repository_root`), database_path: absolutePath(row['database_path'], `${label}.database_path`), retained_snapshot_roots: sortedUnique(retained, (entry) => entry, `${label}.retained_snapshot_roots`) });
}

export function parseCorpusCloneRequest(value: unknown): CorpusCloneRequest {
  const row = object(value, ['schema_version', 'rehearsal_id', 'created_at', 'destination_root', 'result_path', 'candidate_tarball_path', 'candidate_tarball_sha256', 'cf50_tarball_path', 'cf50_tarball_sha256', 'corpora'], 'CorpusCloneRequest');
  if (row['schema_version'] !== S1_CORPUS_CLONE_REQUEST_SCHEMA) throw new S1CorpusContractError('request.schema_version', ['unsupported schema']);
  const corpora = parseList(row['corpora'], 'request.corpora', parseSourceRequest, (entry) => entry.corpus_id);
  if (corpora.length === 0) throw new S1CorpusContractError('request.corpora', ['must not be empty']);
  return Object.freeze({ schema_version: S1_CORPUS_CLONE_REQUEST_SCHEMA, rehearsal_id: identifier(row['rehearsal_id'], 'request.rehearsal_id'), created_at: timestamp(row['created_at'], 'request.created_at'), destination_root: absolutePath(row['destination_root'], 'request.destination_root'), result_path: absolutePath(row['result_path'], 'request.result_path'), candidate_tarball_path: absolutePath(row['candidate_tarball_path'], 'request.candidate_tarball_path'), candidate_tarball_sha256: digest(row['candidate_tarball_sha256'], 'request.candidate_tarball_sha256'), cf50_tarball_path: absolutePath(row['cf50_tarball_path'], 'request.cf50_tarball_path'), cf50_tarball_sha256: digest(row['cf50_tarball_sha256'], 'request.cf50_tarball_sha256'), corpora });
}

function parseCodes(value: unknown, label: string): readonly string[] {
  const values = array(value, label, 1024).map((entry, index) => {
    const code = text(entry, `${label}[${String(index)}]`, 128);
    if (!DIAGNOSTIC.test(code)) throw new S1CorpusContractError(`${label}[${String(index)}]`, ['must be a bounded diagnostic code']);
    return code;
  });
  return sortedUnique(values, (entry) => entry, label);
}

function parseOutcome(value: unknown, label: string): Outcome {
  return exactLiteral(value, ['passed', 'expected-blocked', 'failed'] as const, label);
}

function parseAttach(value: unknown, label: string): AttachResult {
  const row = object(value, ['corpus_id', 'scenario_id', 'repo_id_sha256', 'run_id_sha256', 'attachment_kind', 'outcome', 'committed_event_seq', 'diagnostic_codes'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(row['scenario_id'], `${label}.scenario_id`), repo_id_sha256: digest(row['repo_id_sha256'], `${label}.repo_id_sha256`), run_id_sha256: digest(row['run_id_sha256'], `${label}.run_id_sha256`), attachment_kind: exactLiteral(row['attachment_kind'], ['dispatch', 'terminal-recovery', 'migration-recovery', 'terminal-query-only'] as const, `${label}.attachment_kind`), outcome: parseOutcome(row['outcome'], `${label}.outcome`), committed_event_seq: nullable(row['committed_event_seq'], (entry) => integer(entry, `${label}.committed_event_seq`, 1)), diagnostic_codes: parseCodes(row['diagnostic_codes'], `${label}.diagnostic_codes`) });
}

function parseDoctor(value: unknown, label: string): DoctorResult {
  const row = object(value, ['corpus_id', 'scenario_id', 'phase', 'integrity', 'healthy', 'finding_count', 'finding_codes', 'projection_sha256'], label);
  const findingCodes = parseCodes(row['finding_codes'], `${label}.finding_codes`);
  const findingCount = integer(row['finding_count'], `${label}.finding_count`);
  if (findingCodes.length > findingCount) throw new S1CorpusContractError(label, ['finding codes cannot exceed finding count']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(row['scenario_id'], `${label}.scenario_id`), phase: exactLiteral(row['phase'], ['post-migration', 'post-reconciliation'] as const, `${label}.phase`), integrity: exactLiteral(row['integrity'], ['ok', 'failed'] as const, `${label}.integrity`), healthy: booleanValue(row['healthy'], `${label}.healthy`), finding_count: findingCount, finding_codes: findingCodes, projection_sha256: digest(row['projection_sha256'], `${label}.projection_sha256`) });
}

function parseReconciliation(value: unknown, label: string): ReconciliationResult {
  const row = object(value, ['corpus_id', 'scenario_id', 'run_id_sha256', 'consumer', 'before_sha256', 'after_sha256', 'replayed', 'outcome', 'diagnostic_codes'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(row['scenario_id'], `${label}.scenario_id`), run_id_sha256: digest(row['run_id_sha256'], `${label}.run_id_sha256`), consumer: exactLiteral(row['consumer'], ['worktree-saga', 'failed-unit-authority', 'canonical-identity', 'metadata-reconcile', 'run-reconcile'] as const, `${label}.consumer`), before_sha256: digest(row['before_sha256'], `${label}.before_sha256`), after_sha256: digest(row['after_sha256'], `${label}.after_sha256`), replayed: booleanValue(row['replayed'], `${label}.replayed`), outcome: parseOutcome(row['outcome'], `${label}.outcome`), diagnostic_codes: parseCodes(row['diagnostic_codes'], `${label}.diagnostic_codes`) });
}

function parseDispatch(value: unknown, label: string): DispatchDryRunResult {
  const row = object(value, ['corpus_id', 'scenario_id', 'run_id_sha256', 'disposition', 'planner_invoked', 'scheduler_plan_sha256', 'selected_count', 'skipped_code_counts', 'coordinator_admission_probe', 'coordinator_admission_probe_code', 'agent_process_started', 'external_git_effect_started', 'outcome'], label);
  if (row['agent_process_started'] !== false || row['external_git_effect_started'] !== false) throw new S1CorpusContractError(label, ['dry-run must not start an agent or Git effect']);
  const skipped = parseList(row['skipped_code_counts'], `${label}.skipped_code_counts`, (entry, entryLabel) => {
    const skippedRow = object(entry, ['code', 'count'], entryLabel);
    const code = text(skippedRow['code'], `${entryLabel}.code`, 128);
    if (!DIAGNOSTIC.test(code)) throw new S1CorpusContractError(`${entryLabel}.code`, ['must be a bounded diagnostic code']);
    return Object.freeze({ code, count: integer(skippedRow['count'], `${entryLabel}.count`) });
  }, (entry) => entry.code);
  const plannerInvoked = booleanValue(row['planner_invoked'], `${label}.planner_invoked`);
  const schedulerPlanSha256 = nullable(row['scheduler_plan_sha256'], (entry) => digest(entry, `${label}.scheduler_plan_sha256`));
  const selectedCount = integer(row['selected_count'], `${label}.selected_count`);
  const probe = exactLiteral(row['coordinator_admission_probe'], ['acquire-cancel', 'not-applicable'] as const, `${label}.coordinator_admission_probe`);
  const probeCode = text(row['coordinator_admission_probe_code'], `${label}.coordinator_admission_probe_code`, 128);
  if (!DIAGNOSTIC.test(probeCode)) throw new S1CorpusContractError(`${label}.coordinator_admission_probe_code`, ['must be a bounded diagnostic code']);
  if (plannerInvoked !== (schedulerPlanSha256 !== null)) throw new S1CorpusContractError(label, ['planner_invoked must exactly match scheduler plan evidence presence']);
  if (!plannerInvoked && (selectedCount !== 0 || skipped.length !== 0 || probe !== 'not-applicable')) throw new S1CorpusContractError(label, ['a non-invoked planner must have zero selections/skips and no admission probe']);
  if ((probe === 'acquire-cancel') !== (probeCode === 'acquire-cancel-passed')) throw new S1CorpusContractError(label, ['acquire-cancel probe and its explicit result code must agree']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(row['scenario_id'], `${label}.scenario_id`), run_id_sha256: digest(row['run_id_sha256'], `${label}.run_id_sha256`), disposition: exactLiteral(row['disposition'], ['launchable', 'paused', 'recovering', 'terminal'] as const, `${label}.disposition`), planner_invoked: plannerInvoked, scheduler_plan_sha256: schedulerPlanSha256, selected_count: selectedCount, skipped_code_counts: skipped, coordinator_admission_probe: probe, coordinator_admission_probe_code: probeCode, agent_process_started: false, external_git_effect_started: false, outcome: parseOutcome(row['outcome'], `${label}.outcome`) });
}

const INCIDENT_ASSERTIONS: Readonly<Record<S1CorpusIncidentId, readonly string[]>> = Object.freeze({
  I1: Object.freeze(['actual-cf50-client-to-s1', 's1-client-to-actual-cf50', 'attach-heartbeat-replay', 'natural-restart', 'mixed-election']),
  I2: Object.freeze(['capture-exact', 'parent-exact', 'path-set-exact', 'no-release-before-proof', 'historical-lease-set-exact']),
  I3: Object.freeze(['twins-46-classified', 'aliases-or-scoped-recovery', 'cleanup-idempotent-replay', 'safe-next-attempt-created']),
  I4: Object.freeze(['counter-behind-audited-repair', 'faulted-run-only-blocked', 'healthy-run-dispatched', 'ambiguous-and-physical-fatal']),
  I5: Object.freeze(['registrations-34-reconciled', 'branch-refs-preserved', 'archive-refs-preserved', 'evidence-preserved', 'missing-bytes-not-invented']),
});

function parseIncidentResult(value: unknown, expectedIncident: S1CorpusIncidentId, label: string): IncidentResult {
  const row = object(value, ['incident_id', 'provenance', 'passed', 'assertion_ids', 'evidence_sha256'], label);
  if (row['incident_id'] !== expectedIncident) throw new S1CorpusContractError(`${label}.incident_id`, [`must equal ${expectedIncident}`]);
  const assertions = exactTuple(row['assertion_ids'], INCIDENT_ASSERTIONS[expectedIncident], `${label}.assertion_ids`);
  return Object.freeze({ incident_id: expectedIncident, provenance: exactLiteral(row['provenance'], ['retained-actual', 'actual-plus-controlled-clone-injection'] as const, `${label}.provenance`), passed: booleanValue(row['passed'], `${label}.passed`), assertion_ids: assertions, evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}

function parseDigestObject<T extends object>(value: unknown, fields: readonly string[], label: string): T {
  const row = object(value, fields, label);
  const output: { [key: string]: Sha256Digest } = {};
  for (const field of fields) output[field] = digest(row[field], `${label}.${field}`);
  return output as T;
}

function parseLiveUnchanged(value: unknown): LiveUnchanged {
  const fields = ['baseline_inventory_sha256', 'post_inventory_sha256', 'database_components', 'evidence', 'authority_objects', 'git_refs', 'registrations', 'worktrees', 'passed'];
  const row = object(value, fields, 'result.live_unchanged');
  const output = Object.freeze({ baseline_inventory_sha256: digest(row['baseline_inventory_sha256'], 'result.live_unchanged.baseline_inventory_sha256'), post_inventory_sha256: digest(row['post_inventory_sha256'], 'result.live_unchanged.post_inventory_sha256'), database_components: booleanValue(row['database_components'], 'result.live_unchanged.database_components'), evidence: booleanValue(row['evidence'], 'result.live_unchanged.evidence'), authority_objects: booleanValue(row['authority_objects'], 'result.live_unchanged.authority_objects'), git_refs: booleanValue(row['git_refs'], 'result.live_unchanged.git_refs'), registrations: booleanValue(row['registrations'], 'result.live_unchanged.registrations'), worktrees: booleanValue(row['worktrees'], 'result.live_unchanged.worktrees'), passed: booleanValue(row['passed'], 'result.live_unchanged.passed') });
  const categories = [output.database_components, output.evidence, output.authority_objects, output.git_refs, output.registrations, output.worktrees];
  if (output.passed !== categories.every(Boolean) || output.baseline_inventory_sha256 !== output.post_inventory_sha256) throw new S1CorpusContractError('result.live_unchanged', ['passed requires exact category and inventory digest equality']);
  return output;
}

function parseBlocker(value: unknown, label: string): CorpusBlocker {
  const row = object(value, ['code', 'corpus_id', 'run_id_sha256', 'incident_id', 'diagnostic_sha256'], label);
  const code = text(row['code'], `${label}.code`, 128);
  if (!DIAGNOSTIC.test(code)) throw new S1CorpusContractError(`${label}.code`, ['must be a bounded diagnostic code']);
  return Object.freeze({ code, corpus_id: nullable(row['corpus_id'], (entry) => identifier(entry, `${label}.corpus_id`)), run_id_sha256: nullable(row['run_id_sha256'], (entry) => digest(entry, `${label}.run_id_sha256`)), incident_id: nullable(row['incident_id'], (entry) => exactLiteral(entry, S1_CORPUS_INCIDENTS, `${label}.incident_id`)), diagnostic_sha256: digest(row['diagnostic_sha256'], `${label}.diagnostic_sha256`) });
}

export function parseCorpusRehearsalResult(value: unknown): CorpusRehearsalResult {
  const fields = ['schema_version', 'rehearsal_id', 'candidate_build', 'store_generation_id', 'attach_results', 'doctor_results', 'reconciliation_results', 'dispatch_dry_run_results', 'incident_results', 'copy_post_digests', 'live_post_digests', 'live_unchanged', 'new_blockers', 'completed_at'];
  const row = object(value, fields, 'CorpusRehearsalResult');
  if (row['schema_version'] !== S1_CORPUS_REHEARSAL_RESULT_SCHEMA || row['candidate_build'] !== '1.2.0-s1') throw new S1CorpusContractError('result identity', ['schema or candidate build mismatch']);
  const generationIds = parseList(row['store_generation_id'], 'result.store_generation_id', (entry, label) => {
    const generation = object(entry, ['corpus_id', 'scenario_id', 'generation_id'], label);
    const generationId = text(generation['generation_id'], `${label}.generation_id`, 64);
    if (!/^generation-[a-f0-9]{32}$/u.test(generationId)) throw new S1CorpusContractError(`${label}.generation_id`, ['must be a generation address']);
    return Object.freeze({ corpus_id: identifier(generation['corpus_id'], `${label}.corpus_id`), scenario_id: identifier(generation['scenario_id'], `${label}.scenario_id`), generation_id: generationId });
  }, (entry) => `${entry.corpus_id}\u0000${entry.scenario_id}`);
  const incidents = array(row['incident_results'], 'result.incident_results', 5);
  if (incidents.length !== 5) throw new S1CorpusContractError('result.incident_results', ['must contain I1-I5 exactly once']);
  const i1 = parseIncidentResult(incidents[0], 'I1', 'result.incident_results[0]');
  const i2 = parseIncidentResult(incidents[1], 'I2', 'result.incident_results[1]');
  const i3 = parseIncidentResult(incidents[2], 'I3', 'result.incident_results[2]');
  const i4 = parseIncidentResult(incidents[3], 'I4', 'result.incident_results[3]');
  const i5 = parseIncidentResult(incidents[4], 'I5', 'result.incident_results[4]');
  const blockers = parseList(row['new_blockers'], 'result.new_blockers', parseBlocker, (entry) => `${entry.code}\u0000${entry.corpus_id ?? ''}\u0000${entry.incident_id ?? ''}\u0000${entry.run_id_sha256 ?? ''}`);
  const liveUnchanged = parseLiveUnchanged(row['live_unchanged']);
  const attachResults = parseList(row['attach_results'], 'result.attach_results', parseAttach, (entry) => `${entry.corpus_id}\u0000${entry.scenario_id}\u0000${entry.repo_id_sha256}\u0000${entry.run_id_sha256}\u0000${entry.attachment_kind}`);
  const doctorResults = parseList(row['doctor_results'], 'result.doctor_results', parseDoctor, (entry) => `${entry.corpus_id}\u0000${entry.scenario_id}\u0000${entry.phase}`);
  const reconciliationResults = parseList(row['reconciliation_results'], 'result.reconciliation_results', parseReconciliation, (entry) => `${entry.corpus_id}\u0000${entry.scenario_id}\u0000${entry.run_id_sha256}\u0000${entry.consumer}`);
  const dispatchResults = parseList(row['dispatch_dry_run_results'], 'result.dispatch_dry_run_results', parseDispatch, (entry) => `${entry.corpus_id}\u0000${entry.scenario_id}\u0000${entry.run_id_sha256}`);
  const scenarioKey = (entry: { readonly corpus_id: string; readonly scenario_id: string }): string => `${entry.corpus_id}\u0000${entry.scenario_id}`;
  const generationScenarios = generationIds.map(scenarioKey);
  const generationScenarioSet = new Set(generationScenarios);
  const doctorPhases = new Map<string, string[]>();
  for (const entry of doctorResults) {
    const key = scenarioKey(entry);
    const phases = doctorPhases.get(key) ?? [];
    phases.push(entry.phase);
    doctorPhases.set(key, phases);
  }
  const attachRuns = attachResults.map((entry) => `${scenarioKey(entry)}\u0000${entry.run_id_sha256}`);
  const dispatchRuns = dispatchResults.map((entry) => `${scenarioKey(entry)}\u0000${entry.run_id_sha256}`);
  const runReconciliations = reconciliationResults.filter((entry) => entry.consumer === 'run-reconcile').map((entry) => `${scenarioKey(entry)}\u0000${entry.run_id_sha256}`);
  const coverageComplete = new Set(attachRuns).size === attachRuns.length
    && JSON.stringify([...attachRuns].sort()) === JSON.stringify([...dispatchRuns].sort())
    && JSON.stringify([...runReconciliations].sort()) === JSON.stringify([...dispatchRuns].sort())
    && generationScenarios.every((scenario) => {
      const phases = doctorPhases.get(scenario) ?? [];
      return phases.length === 2 && phases[0] === 'post-migration' && phases[1] === 'post-reconciliation';
    })
    && doctorResults.length === generationScenarios.length * 2
    && [...attachResults, ...doctorResults, ...reconciliationResults, ...dispatchResults].every((entry) => generationScenarioSet.has(scenarioKey(entry)));
  if (blockers.length > 0 || !liveUnchanged.passed || [i1, i2, i3, i4, i5].some((incident) => !incident.passed)
    || generationIds.length === 0 || attachResults.length === 0 || doctorResults.length === 0 || reconciliationResults.length === 0 || dispatchResults.length === 0
    || !coverageComplete || attachResults.some((entry) => entry.outcome === 'failed') || doctorResults.some((entry) => entry.integrity !== 'ok' || !entry.healthy)
    || reconciliationResults.some((entry) => entry.outcome === 'failed') || dispatchResults.some((entry) => entry.outcome === 'failed')) throw new S1CorpusContractError('CorpusRehearsalResult', ['certification result must have complete passing evidence, no blockers, and exact live equality']);
  return Object.freeze({
    schema_version: S1_CORPUS_REHEARSAL_RESULT_SCHEMA,
    rehearsal_id: identifier(row['rehearsal_id'], 'result.rehearsal_id'),
    candidate_build: '1.2.0-s1',
    store_generation_id: generationIds,
    attach_results: attachResults,
    doctor_results: doctorResults,
    reconciliation_results: reconciliationResults,
    dispatch_dry_run_results: dispatchResults,
    incident_results: Object.freeze([i1, i2, i3, i4, i5] as const),
    copy_post_digests: parseDigestObject<CopyPostDigests>(row['copy_post_digests'], ['roots_sha256', 'databases_sha256', 'evidence_sha256', 'git_refs_sha256', 'registrations_sha256', 'worktrees_sha256'], 'result.copy_post_digests'),
    live_post_digests: parseDigestObject<LiveDigestSet>(row['live_post_digests'], ['database_components_sha256', 'evidence_sha256', 'authority_objects_sha256', 'git_refs_sha256', 'registrations_sha256', 'worktrees_sha256'], 'result.live_post_digests'),
    live_unchanged: liveUnchanged,
    new_blockers: blockers,
    completed_at: timestamp(row['completed_at'], 'result.completed_at'),
  });
}
