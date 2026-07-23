import { isAbsolute } from 'node:path';

export const S2_CORPUS_CLONE_REQUEST_SCHEMA = 'autopilot.s2_d_corpus_clone_request.v1' as const;
export const S2_CORPUS_CLONE_MANIFEST_SCHEMA = 'autopilot.s2_d_corpus_clone_manifest.v1' as const;
export const S2_CORPUS_REHEARSAL_RESULT_SCHEMA = 'autopilot.s2_d_corpus_rehearsal_result.v1' as const;

export type Sha256Digest = `sha256:${string}`;
export const S2_D_DURABLE_RUN_ACTIONS = ['attach', 'doctor', 'reconcile', 'dispatch-dry-run'] as const;
export type DurableRunAction = (typeof S2_D_DURABLE_RUN_ACTIONS)[number];
export type AttachmentStrategy = 'safe-attachment' | 'owned-recovery';
export type AttemptLeaseDisposition = 'no-retained-terminal-attempt-lease' | 'retained-terminal-attempt-reconciled';
export type AuthorityVersionDisposition = 'no-operation-authority-version-mismatch' | 'operation-authority-version-mismatch-blocked' | 'operation-authority-version-mismatch-recovered';

export class S2CorpusContractError extends Error {
  override readonly name = 'S2CorpusContractError';
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super(`${label} failed S2-D corpus contract validation: ${issues.join('; ')}`);
    this.issues = Object.freeze([...issues]);
  }
}

export interface FileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly link_count: number;
}

export interface CorpusSourceRequest {
  readonly corpus_id: string;
  readonly state_root: string;
  readonly repository_root: string;
  readonly database_path: string;
  readonly capability_path: string;
  readonly retained_snapshot_roots: readonly string[];
}

export interface CorpusCloneRequest {
  readonly schema_version: typeof S2_CORPUS_CLONE_REQUEST_SCHEMA;
  readonly rehearsal_id: string;
  readonly created_at: string;
  readonly destination_root: string;
  readonly result_path: string;
  readonly candidate_build: string;
  readonly corpora: readonly CorpusSourceRequest[];
}

export interface SourceWitness {
  readonly corpus_id: string;
  readonly root_label: string;
  readonly path_sha256: Sha256Digest;
  readonly identity: FileIdentity;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly tree_sha256: Sha256Digest;
}

export interface DatabaseWitness {
  readonly corpus_id: string;
  readonly role: 'database' | 'wal' | 'shm' | 'journal';
  readonly present: boolean;
  readonly path_sha256: Sha256Digest;
  readonly identity: FileIdentity | null;
  readonly size_bytes: number | null;
  readonly sha256: Sha256Digest | null;
}

export interface GitWitness {
  readonly corpus_id: string;
  readonly ref_digest: Sha256Digest;
  readonly registration_digest: Sha256Digest;
  readonly worktree_digest: Sha256Digest;
}

export interface PathRebaseEntry {
  readonly corpus_id: string;
  readonly target_kind: 'json-file' | 'jsonl-file' | 'sqlite-cell' | 'git-registration';
  readonly target_sha256: Sha256Digest;
  readonly json_pointer: string;
  readonly old_path_sha256: Sha256Digest;
  readonly clone_relative_path: string | null;
  readonly rewrite_kind: 'path-rebase' | 'remote-neutralization';
  readonly after_sha256: Sha256Digest;
}

export interface IsolationProof {
  readonly passed: boolean;
  readonly evidence_sha256: Sha256Digest;
}

export interface IsolationProofs {
  readonly roots_disjoint: IsolationProof;
  readonly no_shared_regular_file_identity: IsolationProof;
  readonly no_live_symlink_hardlink_socket_route: IsolationProof;
  readonly git_mirror_self_contained: IsolationProof;
  readonly git_no_remote_alternate_hook_include: IsolationProof;
  readonly capability_rotated: IsolationProof;
  readonly worktree_paths_rebased: IsolationProof;
  readonly no_live_lock_database_evidence_write_route: IsolationProof;
  readonly sandbox_write_confinement: IsolationProof;
  readonly live_before_after_equal: IsolationProof;
}

export interface DurableRunContract {
  readonly corpus_id: string;
  readonly run_id_sha256: Sha256Digest;
  readonly repo_id_sha256: Sha256Digest;
  readonly required_actions: typeof S2_D_DURABLE_RUN_ACTIONS;
  readonly attachment_strategy: AttachmentStrategy;
  readonly terminal_attempt_lease: AttemptLeaseDisposition;
  readonly authority_version_mismatch: AuthorityVersionDisposition;
  readonly evidence_sha256: Sha256Digest;
}

export interface CorpusCloneManifest {
  readonly schema_version: typeof S2_CORPUS_CLONE_MANIFEST_SCHEMA;
  readonly rehearsal_id: string;
  readonly created_at: string;
  readonly candidate_build: string;
  readonly source_witness_before: readonly SourceWitness[];
  readonly database_witness_before: readonly DatabaseWitness[];
  readonly git_witness_before: readonly GitWitness[];
  readonly path_rebase_ledger: readonly PathRebaseEntry[];
  readonly clone_capability_sha256: Sha256Digest;
  readonly isolation_proofs: IsolationProofs;
  readonly durable_runs: readonly DurableRunContract[];
}

export interface ActionResult {
  readonly corpus_id: string;
  readonly run_id_sha256: Sha256Digest;
  readonly action: DurableRunAction;
  readonly outcome: 'passed';
  readonly evidence_sha256: Sha256Digest;
}

export interface CorpusBlocker {
  readonly code: string;
  readonly corpus_id: string | null;
  readonly run_id_sha256: Sha256Digest | null;
  readonly diagnostic_sha256: Sha256Digest;
}

export interface LiveUnchangedProof {
  readonly source_witness_before_sha256: Sha256Digest;
  readonly source_witness_after_sha256: Sha256Digest;
  readonly database_witness_before_sha256: Sha256Digest;
  readonly database_witness_after_sha256: Sha256Digest;
  readonly git_witness_before_sha256: Sha256Digest;
  readonly git_witness_after_sha256: Sha256Digest;
  readonly database_components: boolean;
  readonly git_refs: boolean;
  readonly registrations: boolean;
  readonly worktrees: boolean;
  readonly files: boolean;
  readonly passed: boolean;
}

export interface CorpusRehearsalResult {
  readonly schema_version: typeof S2_CORPUS_REHEARSAL_RESULT_SCHEMA;
  readonly rehearsal_id: string;
  readonly candidate_build: string;
  readonly action_results: readonly ActionResult[];
  readonly live_unchanged: LiveUnchangedProof;
  readonly isolation_proofs: IsolationProofs;
  readonly new_blockers: readonly CorpusBlocker[];
  readonly completed_at: string;
}

interface JsonMap { readonly [key: string]: unknown }

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function jsonMap(value: unknown, fields: readonly string[], label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new S2CorpusContractError(label, ['must be an object']);
  const row = value as JsonMap;
  const actual = Object.keys(row).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) throw new S2CorpusContractError(label, [`field set mismatch: ${actual.join(',')}`]);
  return row;
}

function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\u0000')) throw new S2CorpusContractError(label, ['must be bounded nonempty text without NUL']);
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label, 192);
  if (!IDENTIFIER.test(parsed)) throw new S2CorpusContractError(label, ['must be a closed identifier']);
  return parsed;
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new S2CorpusContractError(label, ['must be sha256:<64 lowercase hex>']);
  return value as Sha256Digest;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 32);
  if (!RFC3339.test(parsed) || !Number.isFinite(Date.parse(parsed))) throw new S2CorpusContractError(label, ['must be canonical UTC RFC3339']);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new S2CorpusContractError(label, [`must be an integer >= ${String(minimum)}`]);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new S2CorpusContractError(label, ['must be boolean']);
  return value;
}

function array(value: unknown, label: string, maximum = 1_000_000): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new S2CorpusContractError(label, [`must be an array with at most ${String(maximum)} entries`]);
  return value;
}

function exactLiteral<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new S2CorpusContractError(label, [`must be one of ${values.join(',')}`]);
  return value as T;
}

function absolutePath(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!isAbsolute(parsed)) throw new S2CorpusContractError(label, ['must be absolute']);
  return parsed;
}

function parseIdentity(value: unknown, label: string): FileIdentity {
  const row = jsonMap(value, ['device', 'inode', 'link_count'], label);
  return Object.freeze({ device: text(row['device'], `${label}.device`, 64), inode: text(row['inode'], `${label}.inode`, 64), link_count: integer(row['link_count'], `${label}.link_count`, 1) });
}

function parseSourceRequest(value: unknown, label: string): CorpusSourceRequest {
  const row = jsonMap(value, ['corpus_id', 'state_root', 'repository_root', 'database_path', 'capability_path', 'retained_snapshot_roots'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), state_root: absolutePath(row['state_root'], `${label}.state_root`), repository_root: absolutePath(row['repository_root'], `${label}.repository_root`), database_path: absolutePath(row['database_path'], `${label}.database_path`), capability_path: absolutePath(row['capability_path'], `${label}.capability_path`), retained_snapshot_roots: Object.freeze(array(row['retained_snapshot_roots'], `${label}.retained_snapshot_roots`, 10_000).map((entry, index) => absolutePath(entry, `${label}.retained_snapshot_roots.${String(index)}`))) });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T>(values: readonly T[], identity: (entry: T) => string, label: string): readonly T[] {
  const keys = values.map(identity);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= (keys[index - 1] ?? ''))) throw new S2CorpusContractError(label, ['must be sorted and unique']);
  return Object.freeze([...values]);
}

export function parseCorpusCloneRequest(value: unknown): CorpusCloneRequest {
  const row = jsonMap(value, ['schema_version', 'rehearsal_id', 'created_at', 'destination_root', 'result_path', 'candidate_build', 'corpora'], 'S2-D clone request');
  if (row['schema_version'] !== S2_CORPUS_CLONE_REQUEST_SCHEMA) throw new S2CorpusContractError('S2-D clone request', ['schema_version mismatch']);
  const corpora = array(row['corpora'], 'S2-D clone request.corpora', 10_000).map((entry, index) => parseSourceRequest(entry, `S2-D clone request.corpora.${String(index)}`));
  return Object.freeze({ schema_version: S2_CORPUS_CLONE_REQUEST_SCHEMA, rehearsal_id: identifier(row['rehearsal_id'], 'S2-D clone request.rehearsal_id'), created_at: timestamp(row['created_at'], 'S2-D clone request.created_at'), destination_root: absolutePath(row['destination_root'], 'S2-D clone request.destination_root'), result_path: absolutePath(row['result_path'], 'S2-D clone request.result_path'), candidate_build: identifier(row['candidate_build'], 'S2-D clone request.candidate_build'), corpora: sortedUnique(corpora, (entry) => entry.corpus_id, 'S2-D clone request.corpora') });
}

function parseWitness(value: unknown, label: string): SourceWitness {
  const row = jsonMap(value, ['corpus_id', 'root_label', 'path_sha256', 'identity', 'file_count', 'total_bytes', 'tree_sha256'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), root_label: identifier(row['root_label'], `${label}.root_label`), path_sha256: digest(row['path_sha256'], `${label}.path_sha256`), identity: parseIdentity(row['identity'], `${label}.identity`), file_count: integer(row['file_count'], `${label}.file_count`), total_bytes: integer(row['total_bytes'], `${label}.total_bytes`), tree_sha256: digest(row['tree_sha256'], `${label}.tree_sha256`) });
}

function parseDatabaseWitness(value: unknown, label: string): DatabaseWitness {
  const row = jsonMap(value, ['corpus_id', 'role', 'present', 'path_sha256', 'identity', 'size_bytes', 'sha256'], label);
  const present = booleanValue(row['present'], `${label}.present`);
  const identityValue = row['identity'] === null ? null : parseIdentity(row['identity'], `${label}.identity`);
  const size = row['size_bytes'] === null ? null : integer(row['size_bytes'], `${label}.size_bytes`);
  const sha = row['sha256'] === null ? null : digest(row['sha256'], `${label}.sha256`);
  if (present !== (identityValue !== null && size !== null && sha !== null)) throw new S2CorpusContractError(label, ['presence must match identity, size, and digest']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), role: exactLiteral(row['role'], ['database', 'wal', 'shm', 'journal'] as const, `${label}.role`), present, path_sha256: digest(row['path_sha256'], `${label}.path_sha256`), identity: identityValue, size_bytes: size, sha256: sha });
}

function parseGitWitness(value: unknown, label: string): GitWitness {
  const row = jsonMap(value, ['corpus_id', 'ref_digest', 'registration_digest', 'worktree_digest'], label);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), ref_digest: digest(row['ref_digest'], `${label}.ref_digest`), registration_digest: digest(row['registration_digest'], `${label}.registration_digest`), worktree_digest: digest(row['worktree_digest'], `${label}.worktree_digest`) });
}

function parseRebaseEntry(value: unknown, label: string): PathRebaseEntry {
  const row = jsonMap(value, ['corpus_id', 'target_kind', 'target_sha256', 'json_pointer', 'old_path_sha256', 'clone_relative_path', 'rewrite_kind', 'after_sha256'], label);
  const clonePath = row['clone_relative_path'] === null ? null : text(row['clone_relative_path'], `${label}.clone_relative_path`);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), target_kind: exactLiteral(row['target_kind'], ['json-file', 'jsonl-file', 'sqlite-cell', 'git-registration'] as const, `${label}.target_kind`), target_sha256: digest(row['target_sha256'], `${label}.target_sha256`), json_pointer: text(row['json_pointer'], `${label}.json_pointer`, 4096), old_path_sha256: digest(row['old_path_sha256'], `${label}.old_path_sha256`), clone_relative_path: clonePath, rewrite_kind: exactLiteral(row['rewrite_kind'], ['path-rebase', 'remote-neutralization'] as const, `${label}.rewrite_kind`), after_sha256: digest(row['after_sha256'], `${label}.after_sha256`) });
}

function parseProof(value: unknown, label: string): IsolationProof {
  const row = jsonMap(value, ['passed', 'evidence_sha256'], label);
  return Object.freeze({ passed: booleanValue(row['passed'], `${label}.passed`), evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}

function parseProofs(value: unknown, label: string): IsolationProofs {
  const row = jsonMap(value, ['roots_disjoint', 'no_shared_regular_file_identity', 'no_live_symlink_hardlink_socket_route', 'git_mirror_self_contained', 'git_no_remote_alternate_hook_include', 'capability_rotated', 'worktree_paths_rebased', 'no_live_lock_database_evidence_write_route', 'sandbox_write_confinement', 'live_before_after_equal'], label);
  const proofs = Object.freeze({ roots_disjoint: parseProof(row['roots_disjoint'], `${label}.roots_disjoint`), no_shared_regular_file_identity: parseProof(row['no_shared_regular_file_identity'], `${label}.no_shared_regular_file_identity`), no_live_symlink_hardlink_socket_route: parseProof(row['no_live_symlink_hardlink_socket_route'], `${label}.no_live_symlink_hardlink_socket_route`), git_mirror_self_contained: parseProof(row['git_mirror_self_contained'], `${label}.git_mirror_self_contained`), git_no_remote_alternate_hook_include: parseProof(row['git_no_remote_alternate_hook_include'], `${label}.git_no_remote_alternate_hook_include`), capability_rotated: parseProof(row['capability_rotated'], `${label}.capability_rotated`), worktree_paths_rebased: parseProof(row['worktree_paths_rebased'], `${label}.worktree_paths_rebased`), no_live_lock_database_evidence_write_route: parseProof(row['no_live_lock_database_evidence_write_route'], `${label}.no_live_lock_database_evidence_write_route`), sandbox_write_confinement: parseProof(row['sandbox_write_confinement'], `${label}.sandbox_write_confinement`), live_before_after_equal: parseProof(row['live_before_after_equal'], `${label}.live_before_after_equal`) });
  if (!Object.values(proofs).every((proofEntry) => proofEntry.passed)) throw new S2CorpusContractError(label, ['every isolation proof must pass']);
  return proofs;
}

function parseRunContract(value: unknown, label: string): DurableRunContract {
  const row = jsonMap(value, ['corpus_id', 'run_id_sha256', 'repo_id_sha256', 'required_actions', 'attachment_strategy', 'terminal_attempt_lease', 'authority_version_mismatch', 'evidence_sha256'], label);
  const actions = array(row['required_actions'], `${label}.required_actions`, 4).map((entry, index) => exactLiteral(entry, S2_D_DURABLE_RUN_ACTIONS, `${label}.required_actions.${String(index)}`));
  if (actions.length !== S2_D_DURABLE_RUN_ACTIONS.length || actions.some((action, index) => action !== S2_D_DURABLE_RUN_ACTIONS[index])) throw new S2CorpusContractError(label, ['required_actions must be the exact durable-run gate sequence']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), run_id_sha256: digest(row['run_id_sha256'], `${label}.run_id_sha256`), repo_id_sha256: digest(row['repo_id_sha256'], `${label}.repo_id_sha256`), required_actions: S2_D_DURABLE_RUN_ACTIONS, attachment_strategy: exactLiteral(row['attachment_strategy'], ['safe-attachment', 'owned-recovery'] as const, `${label}.attachment_strategy`), terminal_attempt_lease: exactLiteral(row['terminal_attempt_lease'], ['no-retained-terminal-attempt-lease', 'retained-terminal-attempt-reconciled'] as const, `${label}.terminal_attempt_lease`), authority_version_mismatch: exactLiteral(row['authority_version_mismatch'], ['no-operation-authority-version-mismatch', 'operation-authority-version-mismatch-blocked', 'operation-authority-version-mismatch-recovered'] as const, `${label}.authority_version_mismatch`), evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}

export function parseCorpusCloneManifest(value: unknown): CorpusCloneManifest {
  const row = jsonMap(value, ['schema_version', 'rehearsal_id', 'created_at', 'candidate_build', 'source_witness_before', 'database_witness_before', 'git_witness_before', 'path_rebase_ledger', 'clone_capability_sha256', 'isolation_proofs', 'durable_runs'], 'S2-D clone manifest');
  if (row['schema_version'] !== S2_CORPUS_CLONE_MANIFEST_SCHEMA) throw new S2CorpusContractError('S2-D clone manifest', ['schema_version mismatch']);
  const runs = array(row['durable_runs'], 'S2-D clone manifest.durable_runs').map((entry, index) => parseRunContract(entry, `S2-D clone manifest.durable_runs.${String(index)}`));
  return Object.freeze({ schema_version: S2_CORPUS_CLONE_MANIFEST_SCHEMA, rehearsal_id: identifier(row['rehearsal_id'], 'S2-D clone manifest.rehearsal_id'), created_at: timestamp(row['created_at'], 'S2-D clone manifest.created_at'), candidate_build: identifier(row['candidate_build'], 'S2-D clone manifest.candidate_build'), source_witness_before: sortedUnique(array(row['source_witness_before'], 'S2-D clone manifest.source_witness_before').map((entry, index) => parseWitness(entry, `S2-D clone manifest.source_witness_before.${String(index)}`)), (entry) => `${entry.corpus_id}\0${entry.root_label}`, 'S2-D clone manifest.source_witness_before'), database_witness_before: sortedUnique(array(row['database_witness_before'], 'S2-D clone manifest.database_witness_before').map((entry, index) => parseDatabaseWitness(entry, `S2-D clone manifest.database_witness_before.${String(index)}`)), (entry) => `${entry.corpus_id}\0${entry.role}`, 'S2-D clone manifest.database_witness_before'), git_witness_before: sortedUnique(array(row['git_witness_before'], 'S2-D clone manifest.git_witness_before').map((entry, index) => parseGitWitness(entry, `S2-D clone manifest.git_witness_before.${String(index)}`)), (entry) => entry.corpus_id, 'S2-D clone manifest.git_witness_before'), path_rebase_ledger: sortedUnique(array(row['path_rebase_ledger'], 'S2-D clone manifest.path_rebase_ledger').map((entry, index) => parseRebaseEntry(entry, `S2-D clone manifest.path_rebase_ledger.${String(index)}`)), (entry) => `${entry.corpus_id}\0${entry.target_kind}\0${entry.target_sha256}\0${entry.json_pointer}`, 'S2-D clone manifest.path_rebase_ledger'), clone_capability_sha256: digest(row['clone_capability_sha256'], 'S2-D clone manifest.clone_capability_sha256'), isolation_proofs: parseProofs(row['isolation_proofs'], 'S2-D clone manifest.isolation_proofs'), durable_runs: sortedUnique(runs, (entry) => `${entry.corpus_id}\0${entry.run_id_sha256}`, 'S2-D clone manifest.durable_runs') });
}

function parseActionResult(value: unknown, label: string): ActionResult {
  const row = jsonMap(value, ['corpus_id', 'run_id_sha256', 'action', 'outcome', 'evidence_sha256'], label);
  if (row['outcome'] !== 'passed') throw new S2CorpusContractError(label, ['outcome must be passed']);
  return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), run_id_sha256: digest(row['run_id_sha256'], `${label}.run_id_sha256`), action: exactLiteral(row['action'], ['attach', 'doctor', 'reconcile', 'dispatch-dry-run'] as const, `${label}.action`), outcome: 'passed', evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}

function parseBlocker(value: unknown, label: string): CorpusBlocker {
  const row = jsonMap(value, ['code', 'corpus_id', 'run_id_sha256', 'diagnostic_sha256'], label);
  return Object.freeze({ code: identifier(row['code'], `${label}.code`), corpus_id: row['corpus_id'] === null ? null : identifier(row['corpus_id'], `${label}.corpus_id`), run_id_sha256: row['run_id_sha256'] === null ? null : digest(row['run_id_sha256'], `${label}.run_id_sha256`), diagnostic_sha256: digest(row['diagnostic_sha256'], `${label}.diagnostic_sha256`) });
}

function parseLiveUnchanged(value: unknown, label: string): LiveUnchangedProof {
  const row = jsonMap(value, ['source_witness_before_sha256', 'source_witness_after_sha256', 'database_witness_before_sha256', 'database_witness_after_sha256', 'git_witness_before_sha256', 'git_witness_after_sha256', 'database_components', 'git_refs', 'registrations', 'worktrees', 'files', 'passed'], label);
  const parsed = Object.freeze({ source_witness_before_sha256: digest(row['source_witness_before_sha256'], `${label}.source_witness_before_sha256`), source_witness_after_sha256: digest(row['source_witness_after_sha256'], `${label}.source_witness_after_sha256`), database_witness_before_sha256: digest(row['database_witness_before_sha256'], `${label}.database_witness_before_sha256`), database_witness_after_sha256: digest(row['database_witness_after_sha256'], `${label}.database_witness_after_sha256`), git_witness_before_sha256: digest(row['git_witness_before_sha256'], `${label}.git_witness_before_sha256`), git_witness_after_sha256: digest(row['git_witness_after_sha256'], `${label}.git_witness_after_sha256`), database_components: booleanValue(row['database_components'], `${label}.database_components`), git_refs: booleanValue(row['git_refs'], `${label}.git_refs`), registrations: booleanValue(row['registrations'], `${label}.registrations`), worktrees: booleanValue(row['worktrees'], `${label}.worktrees`), files: booleanValue(row['files'], `${label}.files`), passed: booleanValue(row['passed'], `${label}.passed`) });
  if (!parsed.passed || !parsed.database_components || !parsed.git_refs || !parsed.registrations || !parsed.worktrees || !parsed.files || parsed.source_witness_before_sha256 !== parsed.source_witness_after_sha256 || parsed.database_witness_before_sha256 !== parsed.database_witness_after_sha256 || parsed.git_witness_before_sha256 !== parsed.git_witness_after_sha256) throw new S2CorpusContractError(label, ['live source before/after proofs must all pass and match']);
  return parsed;
}

export function parseCorpusRehearsalResult(value: unknown): CorpusRehearsalResult {
  const row = jsonMap(value, ['schema_version', 'rehearsal_id', 'candidate_build', 'action_results', 'live_unchanged', 'isolation_proofs', 'new_blockers', 'completed_at'], 'S2-D rehearsal result');
  if (row['schema_version'] !== S2_CORPUS_REHEARSAL_RESULT_SCHEMA) throw new S2CorpusContractError('S2-D rehearsal result', ['schema_version mismatch']);
  const blockers = array(row['new_blockers'], 'S2-D rehearsal result.new_blockers').map((entry, index) => parseBlocker(entry, `S2-D rehearsal result.new_blockers.${String(index)}`));
  if (blockers.length !== 0) throw new S2CorpusContractError('S2-D rehearsal result', ['new_blockers must be empty for release']);
  const actionValues = array(row['action_results'], 'S2-D rehearsal result.action_results');
  if (actionValues.length === 0) throw new S2CorpusContractError('S2-D rehearsal result', ['action_results must cover at least one durable run']);
  const actions = sortedUnique(actionValues.map((entry, index) => parseActionResult(entry, `S2-D rehearsal result.action_results.${String(index)}`)), (entry) => `${entry.corpus_id}\0${entry.run_id_sha256}\0${entry.action}`, 'S2-D rehearsal result.action_results');
  const grouped = new Map<string, string[]>();
  for (const action of actions) grouped.set(`${action.corpus_id}\0${action.run_id_sha256}`, [...(grouped.get(`${action.corpus_id}\0${action.run_id_sha256}`) ?? []), action.action].sort(compareCodeUnits));
  for (const [key, values] of grouped) if (values.join(',') !== 'attach,dispatch-dry-run,doctor,reconcile') throw new S2CorpusContractError('S2-D rehearsal result', [`durable-run action coverage is incomplete for ${key}`]);
  return Object.freeze({ schema_version: S2_CORPUS_REHEARSAL_RESULT_SCHEMA, rehearsal_id: identifier(row['rehearsal_id'], 'S2-D rehearsal result.rehearsal_id'), candidate_build: identifier(row['candidate_build'], 'S2-D rehearsal result.candidate_build'), action_results: actions, live_unchanged: parseLiveUnchanged(row['live_unchanged'], 'S2-D rehearsal result.live_unchanged'), isolation_proofs: parseProofs(row['isolation_proofs'], 'S2-D rehearsal result.isolation_proofs'), new_blockers: Object.freeze(blockers), completed_at: timestamp(row['completed_at'], 'S2-D rehearsal result.completed_at') });
}
