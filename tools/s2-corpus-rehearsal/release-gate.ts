import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { backup, DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import {
  parseCorpusCloneManifest,
  parseCorpusCloneRequest,
  parseCorpusRehearsalResult,
  S2_CORPUS_CLONE_MANIFEST_SCHEMA,
  S2_CORPUS_REHEARSAL_RESULT_SCHEMA,
  S2_D_DURABLE_RUN_ACTIONS,
  type ActionResult,
  type CorpusBlocker,
  type CorpusCloneManifest,
  type CorpusCloneRequest,
  type CorpusRehearsalResult,
  type DatabaseWitness,
  type DurableRunContract,
  type GitWitness,
  type IsolationProof,
  type IsolationProofs,
  type Sha256Digest,
  type SourceWitness,
} from './contracts.ts';
import type { ActiveAutopilotRow, AutopilotRepoIdentity } from '../../src/core/parallel-runtime.ts';
import { buildWritableGitMirror, gitRefs, gitWorktreeFacts, hashGitWitness, verifyGitMirror, type GitMirrorResult } from './git-mirror.ts';
import { assertDisjointCanonicalRoots, assertNoSharedRegularFileIdentity, assertNoSymlinkSocketOrHardlinkRoute, compareCodeUnits, copyRegularFileNoFollow, copyTreeWithoutLinks, digestBytes, fileIdentity, hashRegularFile, inside, inventoryDigest, inventoryTree, readRegularFileNoFollow, type TreeInventory } from './inventory.ts';
import { assertMetadataCloneContained, rebaseCorpusPaths, type CorpusPathMapping, type PathRebaseResult } from './path-rebase.ts';

interface DiscoveredDurableRun {
  readonly contract: DurableRunContract;
  readonly repo: AutopilotRepoIdentity;
  readonly active: ActiveAutopilotRow;
  readonly copy_state_root: string;
}

interface BuiltCorpus {
  readonly corpus_id: string;
  readonly source_state_root: string;
  readonly source_repository_root: string;
  readonly copy_state_root: string;
  readonly copy_repository_root: string;
  readonly source_inventory: readonly TreeInventory[];
  readonly copy_inventory: readonly TreeInventory[];
  readonly source_git: GitWitness;
  readonly mirror: GitMirrorResult;
  readonly path_rebase: PathRebaseResult;
  readonly durable_runs: readonly DiscoveredDurableRun[];
}

export interface BuiltMutableClone {
  readonly request: CorpusCloneRequest;
  readonly clone_root: string;
  readonly manifest: CorpusCloneManifest;
  readonly corpora: readonly BuiltCorpus[];
}

function physicalDirectory(path: string, label: string): string {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolve(path)) throw new Error(`${label} must be a canonical physical directory`);
  return canonical;
}

function physicalRegularFile(path: string, label: string): string {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || canonical !== resolve(path)) throw new Error(`${label} must be a canonical single-link physical regular file`);
  return canonical;
}

function proof(value: unknown): IsolationProof {
  return Object.freeze({ passed: true, evidence_sha256: digestBytes(canonicalJson(value)) });
}

function sourcePathDigest(rehearsalId: string, path: string): Sha256Digest {
  return digestBytes(`pi-autopilot/s2-d/source-path/v1\0${rehearsalId}\0${resolve(path)}`);
}

function cloneRelative(cloneRoot: string, path: string): string {
  const rel = relative(cloneRoot, path).split(sep).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || rel.includes('\u0000')) throw new Error('S2-D clone-relative path escapes clone root');
  return rel;
}

async function databaseWitnesses(rehearsalId: string, corpusId: string, databasePath: string): Promise<readonly DatabaseWitness[]> {
  const roles = [
    ['database', databasePath],
    ['wal', `${databasePath}-wal`],
    ['shm', `${databasePath}-shm`],
    ['journal', `${databasePath}-journal`],
  ] as const;
  const rows: DatabaseWitness[] = [];
  for (const [role, path] of roles) {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('S2-D database component is not a single-link physical file');
      rows.push(Object.freeze({ corpus_id: corpusId, role, present: true, path_sha256: sourcePathDigest(rehearsalId, path), identity: fileIdentity(path), size_bytes: stat.size, sha256: await hashRegularFile(path) }));
    } else rows.push(Object.freeze({ corpus_id: corpusId, role, present: false, path_sha256: sourcePathDigest(rehearsalId, path), identity: null, size_bytes: null, sha256: null }));
  }
  return Object.freeze(rows);
}

function quoteSqlIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\u0000')) throw new Error('S2-D SQLite identifier is invalid');
  return `"${value.replace(/"/gu, '""')}"`;
}

function sqliteValue(value: SQLOutputValue): unknown {
  if (value === null) return Object.freeze({ type: 'null', value: null });
  if (typeof value === 'string') return Object.freeze({ type: 'text', value });
  if (typeof value === 'bigint') return Object.freeze({ type: 'integer', value: value.toString() });
  if (typeof value === 'number') return Object.freeze({ type: Number.isInteger(value) ? 'integer' : 'float', value: Object.is(value, -0) ? '-0' : String(value) });
  return Object.freeze({ type: 'blob', value: Buffer.from(value).toString('base64') });
}

function logicalSqliteDigest(databasePath: string): Sha256Digest {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 30_000 });
  try {
    database.exec('PRAGMA query_only=ON');
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.['integrity_check'] !== 'ok') throw new Error('S2-D SQLite integrity_check failed');
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name").all();
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row['name']));
    const tableRows = tables.map((table) => {
      const rowHashes: Sha256Digest[] = [];
      for (const row of database.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)}`).iterate() as Iterable<Record<string, SQLOutputValue>>) rowHashes.push(digestBytes(canonicalJson(Object.keys(row).sort(compareCodeUnits).map((column) => ({ column, value: sqliteValue(row[column] ?? null) })))));
      return { table, rows_sha256: digestBytes(canonicalJson(rowHashes.sort(compareCodeUnits))), row_count: rowHashes.length };
    });
    return digestBytes(canonicalJson({ schema, tableRows }));
  } finally { database.close(); }
}

async function createCoherentDatabaseCopy(input: { readonly sourceDatabasePath: string; readonly copyDatabasePath: string; readonly scratchDatabasePath: string }): Promise<void> {
  if (existsSync(`${input.sourceDatabasePath}-journal`)) throw new Error('S2-D SQLite source retained a rollback journal and has no coherent read-only boundary');
  await rm(input.copyDatabasePath, { force: true });
  await rm(`${input.copyDatabasePath}-wal`, { force: true });
  await rm(`${input.copyDatabasePath}-shm`, { force: true });
  await rm(`${input.copyDatabasePath}-journal`, { force: true });
  await rm(input.scratchDatabasePath, { force: true });
  await rm(`${input.scratchDatabasePath}-wal`, { force: true });
  await mkdir(dirname(input.scratchDatabasePath), { recursive: true, mode: 0o700 });
  await copyRegularFileNoFollow(input.sourceDatabasePath, input.scratchDatabasePath, 0o600);
  if (existsSync(`${input.sourceDatabasePath}-wal`)) await copyRegularFileNoFollow(`${input.sourceDatabasePath}-wal`, `${input.scratchDatabasePath}-wal`, 0o600);
  const sourceBefore = logicalSqliteDigest(input.scratchDatabasePath);
  const snapshot = new DatabaseSync(input.scratchDatabasePath, { readOnly: true, timeout: 30_000 });
  try { snapshot.exec('PRAGMA query_only=ON'); await backup(snapshot, input.copyDatabasePath); }
  finally { snapshot.close(); }
  await chmod(input.copyDatabasePath, 0o600);
  if (existsSync(`${input.copyDatabasePath}-wal`) || existsSync(`${input.copyDatabasePath}-shm`) || existsSync(`${input.copyDatabasePath}-journal`)) throw new Error('S2-D SQLite backup retained mutable sidecar authority in clone');
  const sourceAfter = logicalSqliteDigest(input.scratchDatabasePath);
  const copyDigest = logicalSqliteDigest(input.copyDatabasePath);
  if (sourceBefore !== sourceAfter || sourceBefore !== copyDigest) throw new Error('S2-D SQLite logical state is not coherent in mutable clone');
}

function sourceWitness(rehearsalId: string, corpusId: string, rootLabel: string, inventory: TreeInventory): SourceWitness {
  return Object.freeze({ corpus_id: corpusId, root_label: rootLabel, path_sha256: sourcePathDigest(rehearsalId, inventory.canonical_root), identity: inventory.root_identity, file_count: inventory.file_count, total_bytes: inventory.total_bytes, tree_sha256: inventory.tree_sha256 });
}

async function sourceGitWitness(corpusId: string, repositoryRoot: string): Promise<GitWitness> {
  const facts = await gitWorktreeFacts(join(repositoryRoot, '.git'));
  const refs = await gitRefs(repositoryRoot);
  return Object.freeze({ corpus_id: corpusId, ref_digest: hashGitWitness(facts, refs), registration_digest: digestBytes(canonicalJson(facts)), worktree_digest: digestBytes(canonicalJson(facts.map((fact) => ({ worktree_path: fact.worktree_path, head_sha: fact.head_sha })).sort((left, right) => compareCodeUnits(left.worktree_path, right.worktree_path)))) });
}

export async function preflightCloneRequest(request: CorpusCloneRequest): Promise<CorpusCloneRequest> {
  const parsed = parseCorpusCloneRequest(request);
  if (existsSync(parsed.destination_root)) throw new Error('S2-D destination root must be absent');
  const parent = physicalDirectory(dirname(parsed.destination_root), 'S2-D destination parent');
  if (dirname(resolve(parsed.destination_root)) !== parent) throw new Error('S2-D destination root must have a canonical physical parent');
  const resultPath = resolve(parsed.result_path);
  if (!inside(parsed.destination_root, resultPath) || resultPath === parsed.destination_root) throw new Error('S2-D result path must be below destination root');
  const corpora = parsed.corpora.map((corpus) => {
    const state = physicalDirectory(corpus.state_root, `S2-D ${corpus.corpus_id} state root`);
    const repo = physicalDirectory(corpus.repository_root, `S2-D ${corpus.corpus_id} repository root`);
    const database = physicalRegularFile(corpus.database_path, `S2-D ${corpus.corpus_id} database`);
    const capability = physicalRegularFile(corpus.capability_path, `S2-D ${corpus.corpus_id} capability`);
    if (!inside(state, database) || !inside(state, capability)) throw new Error('S2-D database and capability must be under the declared state root');
    const capabilityInput = readRegularFileNoFollow(capability, 1024);
    const capabilityText = Buffer.from(capabilityInput.bytes).toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(capabilityText)) throw new Error('S2-D source capability must use the current 64-hex format');
    return Object.freeze({ ...corpus, state_root: state, repository_root: repo, database_path: database, capability_path: capability, retained_snapshot_roots: Object.freeze(corpus.retained_snapshot_roots.map((root, index) => physicalDirectory(root, `S2-D ${corpus.corpus_id} retained root ${String(index)}`)).sort(compareCodeUnits)) });
  });
  const sourceRoots = corpora.flatMap((corpus) => [corpus.state_root, corpus.repository_root, ...corpus.retained_snapshot_roots]);
  for (const source of sourceRoots) if (inside(source, parsed.destination_root) || inside(parsed.destination_root, source)) throw new Error('S2-D destination is not disjoint from source authority');
  return Object.freeze({ ...parsed, destination_root: resolve(parsed.destination_root), result_path: resultPath, corpora: Object.freeze(corpora) });
}

async function rotateCapability(sourceCapability: string, copyCapability: string): Promise<Sha256Digest> {
  const source = Buffer.from(readRegularFileNoFollow(sourceCapability, 1024).bytes).toString('utf8').trim();
  let fresh = randomBytes(32).toString('hex');
  if (fresh === source) fresh = randomBytes(32).toString('hex');
  if (fresh === source) throw new Error('S2-D capability rotation could not produce distinct authority');
  await writeFile(copyCapability, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  return digestBytes(Buffer.from(fresh, 'hex'));
}

async function buildCorpus(input: { readonly request: CorpusCloneRequest; readonly corpusIndex: number }): Promise<BuiltCorpus> {
  const corpus = input.request.corpora[input.corpusIndex];
  if (corpus === undefined) throw new Error('S2-D corpus index disappeared');
  const corpusRoot = join(input.request.destination_root, 'corpora', corpus.corpus_id);
  const copyState = join(corpusRoot, 'state');
  const copyRepository = join(corpusRoot, 'repository');
  await mkdir(corpusRoot, { recursive: true, mode: 0o700 });
  const sourceStateInventory = await inventoryTree(corpus.state_root);
  const sourceRepoInventory = await inventoryTree(corpus.repository_root);
  await copyTreeWithoutLinks(corpus.state_root, copyState);
  const copiedCoordinatorRoot = join(copyState, 'coordinator');
  if (existsSync(copiedCoordinatorRoot)) {
    for (const entry of await readdir(copiedCoordinatorRoot)) if (entry.endsWith('.sock') || entry.endsWith('.lock')) await rm(join(copiedCoordinatorRoot, entry), { force: true });
  }
  const copyDatabase = join(copyState, relative(corpus.state_root, corpus.database_path));
  await createCoherentDatabaseCopy({ sourceDatabasePath: corpus.database_path, copyDatabasePath: copyDatabase, scratchDatabasePath: join(corpusRoot, 'private', 'raw-sqlite', 'coordinator.db') });
  const copyCapability = join(copyState, relative(corpus.state_root, corpus.capability_path));
  await rotateCapability(corpus.capability_path, copyCapability);
  const mirror = await buildWritableGitMirror({ source_repository_root: corpus.repository_root, clone_root: corpusRoot, copy_repository_root: copyRepository });
  const mappings: CorpusPathMapping[] = [
    { corpus_id: corpus.corpus_id, source_path: corpus.repository_root, copy_path: copyRepository, source_label: 'repository' },
    { corpus_id: corpus.corpus_id, source_path: corpus.state_root, copy_path: copyState, source_label: 'state' },
    { corpus_id: corpus.corpus_id, source_path: join(corpus.repository_root, '.git'), copy_path: mirror.git_common_dir, source_label: 'git-common' },
  ];
  const pathRebase = await rebaseCorpusPaths({ clone_root: corpusRoot, state_root: copyState, ledger_path: join(corpusRoot, 'private', 'path-rebase-ledger.json'), rehearsal_id: input.request.rehearsal_id, mappings, database_paths: [copyDatabase] });
  await verifyGitMirror(mirror.git_common_dir, corpusRoot);
  await assertMetadataCloneContained(copyState, corpusRoot, [copyDatabase]);
  const durableRuns = await discoverDurableRuns({ rehearsalId: input.request.rehearsal_id, corpusId: corpus.corpus_id, copyStateRoot: copyState, copyDatabasePath: copyDatabase });
  const sourceGit = await sourceGitWitness(corpus.corpus_id, corpus.repository_root);
  const copyInventories = [await inventoryTree(copyState), await inventoryTree(copyRepository)];
  return Object.freeze({ corpus_id: corpus.corpus_id, source_state_root: corpus.state_root, source_repository_root: corpus.repository_root, copy_state_root: copyState, copy_repository_root: copyRepository, source_inventory: Object.freeze([sourceStateInventory, sourceRepoInventory]), copy_inventory: Object.freeze(copyInventories), source_git: sourceGit, mirror, path_rebase: pathRebase, durable_runs: durableRuns });
}

function combineProofs(corpora: readonly BuiltCorpus[], cloneRoot: string, request: CorpusCloneRequest, sourceAfter: readonly TreeInventory[]): IsolationProofs {
  for (const corpus of corpora) {
    assertDisjointCanonicalRoots(corpus.source_state_root, corpus.copy_state_root);
    assertDisjointCanonicalRoots(corpus.source_repository_root, corpus.copy_repository_root);
    for (const source of corpus.source_inventory) for (const copy of corpus.copy_inventory) assertNoSharedRegularFileIdentity(source, copy);
    for (const copy of corpus.copy_inventory) {
      assertNoSymlinkSocketOrHardlinkRoute(copy);
      if (copy.nodes.some((node) => /(?:^|\/)(?:[^/]+\.sock|[^/]+\.lock|LOCK)$/u.test(node.relative_path))) throw new Error('S2-D clone retained executable lock or socket authority');
    }
  }
  const sourceBeforeDigest = digestBytes(canonicalJson(corpora.flatMap((corpus) => corpus.source_inventory.map(inventoryDigest)).sort(compareCodeUnits)));
  const sourceAfterDigest = digestBytes(canonicalJson(sourceAfter.map(inventoryDigest).sort(compareCodeUnits)));
  if (sourceBeforeDigest !== sourceAfterDigest) throw new Error('S2-D source changed during clone construction');
  const cloneInventories = corpora.flatMap((corpus) => corpus.copy_inventory);
  const clonePaths = corpora.flatMap((corpus) => [corpus.copy_state_root, corpus.copy_repository_root]);
  return Object.freeze({
    roots_disjoint: proof({ source: request.corpora.flatMap((corpus) => [sourcePathDigest(request.rehearsal_id, corpus.state_root), sourcePathDigest(request.rehearsal_id, corpus.repository_root)]), clone: clonePaths.map((path) => cloneRelative(cloneRoot, path)) }),
    no_shared_regular_file_identity: proof(cloneInventories.map(inventoryDigest).sort(compareCodeUnits)),
    no_live_symlink_hardlink_socket_route: proof(cloneInventories.map((inventory) => inventory.tree_sha256).sort(compareCodeUnits)),
    git_mirror_self_contained: proof(corpora.map((corpus) => ({ corpus_id: corpus.corpus_id, refs_sha256: corpus.mirror.refs_sha256, registrations_sha256: corpus.mirror.registrations_sha256 }))),
    git_no_remote_alternate_hook_include: proof(corpora.map((corpus) => corpus.mirror.git_common_dir)),
    capability_rotated: proof(corpora.map((corpus) => corpus.copy_state_root)),
    worktree_paths_rebased: proof(corpora.flatMap((corpus) => corpus.path_rebase.entries)),
    no_live_lock_database_evidence_write_route: proof(corpora.map((corpus) => ({ corpus_id: corpus.corpus_id, state: cloneRelative(cloneRoot, corpus.copy_state_root), repository: cloneRelative(cloneRoot, corpus.copy_repository_root) }))),
    sandbox_write_confinement: proof({ clone_root: cloneRelative(dirname(cloneRoot), cloneRoot), mode: 'operator-or-sandbox-required-for-private-run' }),
    live_before_after_equal: proof({ before: sourceBeforeDigest, after: sourceAfterDigest }),
  });
}

function sqliteRows(database: DatabaseSync, sql: string, parameters: readonly (string | number | null)[] = []): readonly Record<string, unknown>[] {
  return database.prepare(sql).all(...parameters) as readonly Record<string, unknown>[];
}

function sqlText(row: Readonly<Record<string, unknown>>, field: string, label: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) throw new Error(`${label}.${field} must be text`);
  return value;
}

function sqlInteger(row: Readonly<Record<string, unknown>>, field: string, label: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}.${field} must be a nonnegative integer`);
  return value;
}

function jsonRecord(text: string, label: string): Readonly<Record<string, unknown>> {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Readonly<Record<string, unknown>>;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('S2-D optional text field has invalid type');
  return value;
}

function activeFromDurableRow(input: { readonly run: Readonly<Record<string, unknown>>; readonly repo: Readonly<Record<string, unknown>>; readonly resource: Readonly<Record<string, unknown>> }): { readonly repo: AutopilotRepoIdentity; readonly active: ActiveAutopilotRow } {
  const repoId = sqlText(input.run, 'repo_id', 'runs');
  const workstreamRun = sqlText(input.run, 'workstream_run', 'runs');
  const sourceRepo = sqlText(input.resource, 'source_repo', 'run_resource');
  const gitCommonDir = sqlText(input.resource, 'git_common_dir', 'run_resource');
  const originUrl = optionalText(input.resource['origin_url']);
  const targetBranch = optionalText(input.resource['target_branch']);
  const targetBaseSha = sqlText(input.resource, 'target_base_sha', 'run_resource');
  const active: ActiveAutopilotRow = Object.freeze({
    schema_version: 'autopilot.active_parent.v2',
    coordination_authority: sqlText(input.run, 'coordination_authority', 'runs') === 'coordinator-edit-leases-v1' ? 'coordinator-edit-leases-v1' : 'legacy-path-claims-v1',
    autopilot_id: sqlText(input.run, 'autopilot_id', 'runs'),
    workstream: sqlText(input.run, 'workstream', 'runs'),
    workstream_run: workstreamRun,
    repo_key: repoId,
    source_repo: sourceRepo,
    git_common_dir: gitCommonDir,
    worktree_root: sqlText(input.resource, 'worktree_root', 'run_resource'),
    main_worktree_path: sqlText(input.resource, 'main_worktree_path', 'run_resource'),
    branch: sqlText(input.resource, 'branch', 'run_resource'),
    runtime_root: sqlText(input.resource, 'runtime_root', 'run_resource'),
    target_branch: targetBranch,
    target_base_sha: targetBaseSha,
    origin_url: originUrl,
    pid: process.pid,
    boot_id: 's2-d-candidate-worker',
    status: sqlText(input.run, 'status', 'runs') === 'closed' ? 'closed' : sqlText(input.run, 'status', 'runs') === 'paused' ? 'paused' : sqlText(input.run, 'status', 'runs') === 'blocked' ? 'blocked' : sqlText(input.run, 'status', 'runs') === 'crashed' ? 'crashed' : sqlText(input.run, 'status', 'runs') === 'merging' ? 'merging' : 'active',
    started_at: sqlText(input.resource, 'started_at', 'run_resource'),
    active_run_epoch: 1,
    active_epoch_started_at: sqlText(input.resource, 'started_at', 'run_resource'),
    active_run_receipt_id: `s2-d-${workstreamRun}`,
  });
  return Object.freeze({ repo: Object.freeze({ repoRoot: sqlText(input.repo, 'canonical_root', 'repositories'), gitCommonDir, repoKey: repoId, headSha: targetBaseSha, targetBranch, originUrl }), active });
}

function jsonText(value: unknown, field: string, label: string): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  const row = value as Readonly<Record<string, unknown>>;
  return typeof row[field] === 'string' && String(row[field]).length > 0 ? String(row[field]) : null;
}

function jsonIntegerField(value: Readonly<Record<string, unknown>>, field: string): number | null {
  const candidate = value[field];
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : null;
}

export function runDisposition(input: { readonly database: DatabaseSync; readonly run: Readonly<Record<string, unknown>>; readonly resource: Readonly<Record<string, unknown>> }): Pick<DurableRunContract, 'attachment_strategy' | 'terminal_attempt_lease' | 'authority_version_mismatch'> & { readonly phase36_evidence: Readonly<Record<string, number | string>> } {
  const repoId = sqlText(input.run, 'repo_id', 'runs');
  const workstreamRun = sqlText(input.run, 'workstream_run', 'runs');
  const pendingMigration = sqlInteger(sqliteRows(input.database, "SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'", [repoId, workstreamRun])[0] ?? {}, 'count', 'migration_recovery_work');
  const incompleteRows = sqliteRows(input.database, "SELECT payload_json FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') ORDER BY entity_id", [repoId, workstreamRun]);
  const incompleteOperations = incompleteRows.length;
  let authorityMismatchCount = 0;
  for (const row of incompleteRows) {
    const operation = jsonRecord(sqlText(row, 'payload_json', 'worktree_operations'), 'worktree_operations.payload_json');
    const worktreeId = jsonText(operation['worktree_id'], 'worktree_id', 'worktree_operation') ?? '';
    const authorityVersion = jsonIntegerField(operation, 'authority_version');
    const worktree = sqliteRows(input.database, 'SELECT payload_json,version FROM worktrees WHERE repo_id=? AND workstream_run=? AND entity_id=? LIMIT 1', [repoId, workstreamRun, worktreeId])[0];
    const rowVersion = worktree === undefined ? null : typeof worktree['version'] === 'number' && Number.isSafeInteger(worktree['version']) ? worktree['version'] : null;
    const payloadVersion = worktree === undefined ? null : jsonIntegerField(jsonRecord(sqlText(worktree, 'payload_json', 'worktrees'), 'worktrees.payload_json'), 'version');
    const worktreeVersion = payloadVersion ?? rowVersion;
    if (authorityVersion === null || worktreeVersion === null || authorityVersion !== worktreeVersion) authorityMismatchCount += 1;
  }
  const terminalIntentCount = sqlInteger(sqliteRows(input.database, "SELECT COUNT(*) AS count FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state')='committed'", [repoId, workstreamRun])[0] ?? {}, 'count', 'run_terminal_intents');
  const runStatus = sqlText(input.run, 'status', 'runs');
  const terminalRecoverySupported = (runStatus === 'closed' || runStatus === 'aborted') && terminalIntentCount > 0;
  const staleLeaseCount = sqlInteger(sqliteRows(input.database, "SELECT COUNT(*) AS count FROM session_leases WHERE repo_id=? AND workstream_run=? AND status!='detached'", [repoId, workstreamRun])[0] ?? {}, 'count', 'session_leases');
  const terminalRetainedLeases = sqlInteger(sqliteRows(input.database, "SELECT COUNT(*) AS count FROM edit_leases leases JOIN unit_attempts attempts ON attempts.repo_id=leases.repo_id AND attempts.workstream_run=leases.workstream_run AND json_extract(attempts.payload_json, '$.owner.unit_id')=json_extract(leases.payload_json, '$.owner.unit_id') AND json_extract(attempts.payload_json, '$.owner.attempt')=json_extract(leases.payload_json, '$.owner.attempt') WHERE leases.repo_id=? AND leases.workstream_run=? AND json_extract(attempts.payload_json, '$.state') IN ('merged','failed','reset','quarantined','superseded')", [repoId, workstreamRun])[0] ?? {}, 'count', 'terminal retained edit leases');
  const terminalCoveredByPendingRecovery = sqlInteger(sqliteRows(input.database, "SELECT COUNT(*) AS count FROM edit_leases leases JOIN unit_attempts attempts ON attempts.repo_id=leases.repo_id AND attempts.workstream_run=leases.workstream_run AND json_extract(attempts.payload_json, '$.owner.unit_id')=json_extract(leases.payload_json, '$.owner.unit_id') AND json_extract(attempts.payload_json, '$.owner.attempt')=json_extract(leases.payload_json, '$.owner.attempt') WHERE leases.repo_id=? AND leases.workstream_run=? AND json_extract(attempts.payload_json, '$.state') IN ('merged','failed','reset','quarantined','superseded') AND EXISTS(SELECT 1 FROM migration_recovery_work work WHERE work.repo_id=leases.repo_id AND work.workstream_run=leases.workstream_run AND work.status='pending' AND json_extract(work.payload_json, '$.edit_lease_id')=leases.entity_id)", [repoId, workstreamRun])[0] ?? {}, 'count', 'terminal retained edit leases covered by pending recovery');
  const mismatch = authorityMismatchCount > 0
    ? 'operation-authority-version-mismatch-blocked'
    : incompleteOperations > 0
      ? 'operation-authority-version-mismatch-recovered'
      : 'no-operation-authority-version-mismatch';
  const terminalLease = terminalRetainedLeases > 0 ? 'retained-terminal-attempt-recovery-required' : 'no-retained-terminal-attempt-lease';
  const attachmentStrategy = pendingMigration > 0 || incompleteOperations > 0 || terminalRetainedLeases > 0 ? 'owned-recovery' : 'safe-attachment';
  return Object.freeze({
    attachment_strategy: attachmentStrategy,
    terminal_attempt_lease: terminalLease,
    authority_version_mismatch: mismatch,
    phase36_evidence: Object.freeze({ pending_migration_recovery: pendingMigration, incomplete_owned_operations: incompleteOperations, authority_version_mismatch_count: authorityMismatchCount, terminal_intents: terminalIntentCount, terminal_recovery_supported: terminalRecoverySupported ? 1 : 0, retained_non_detached_leases: staleLeaseCount, terminal_retained_attempt_edit_leases: terminalRetainedLeases, terminal_retained_attempt_leases_covered_by_pending_recovery: terminalCoveredByPendingRecovery, attachment_strategy: attachmentStrategy, terminal_attempt_lease: terminalLease, authority_version_mismatch: mismatch }),
  });
}

async function discoverDurableRuns(input: { readonly rehearsalId: string; readonly corpusId: string; readonly copyStateRoot: string; readonly copyDatabasePath: string }): Promise<readonly DiscoveredDurableRun[]> {
  if (!existsSync(input.copyDatabasePath)) throw new Error('S2-D cloned coordinator store is absent');
  const stat = lstatSync(input.copyDatabasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('S2-D cloned coordinator store is not single-link clone authority');
  const database = new DatabaseSync(input.copyDatabasePath, { readOnly: true });
  try {
    const requiredTables = ['repositories', 'runs', 'run_resources', 'session_leases', 'worktrees', 'worktree_operations', 'migration_recovery_work', 'run_terminal_intents', 'edit_leases', 'unit_attempts'];
    const tables = new Set(sqliteRows(database, "SELECT name FROM sqlite_schema WHERE type='table'").map((row) => sqlText(row, 'name', 'sqlite_schema')));
    for (const table of requiredTables) if (!tables.has(table)) throw new Error(`S2-D cloned coordinator store missing authoritative table ${table}`);
    const rows = sqliteRows(database, "SELECT r.*, rr.payload_json AS resource_json, repo.canonical_root AS canonical_root, repo.git_common_dir AS repo_git_common_dir FROM runs r JOIN run_resources rr ON rr.repo_id=r.repo_id AND rr.workstream_run=r.workstream_run JOIN repositories repo ON repo.repo_id=r.repo_id ORDER BY r.repo_id, r.workstream_run");
    if (rows.length === 0) throw new Error('S2-D cloned coordinator store contains no durable runs to rehearse');
    return Object.freeze(rows.map((row) => {
      const repoId = sqlText(row, 'repo_id', 'durable run');
      const workstreamRun = sqlText(row, 'workstream_run', 'durable run');
      const runDigest = digestBytes(`pi-autopilot/s2-d/run/v1\0${input.rehearsalId}\0${input.corpusId}\0${repoId}\0${workstreamRun}`);
      const repoDigest = digestBytes(`pi-autopilot/s2-d/repo/v1\0${input.rehearsalId}\0${input.corpusId}\0${repoId}`);
      const resource = jsonRecord(sqlText(row, 'resource_json', 'run_resources'), 'run_resources.payload_json');
      const repoRow = Object.freeze({ canonical_root: sqlText(row, 'canonical_root', 'repositories'), git_common_dir: sqlText(row, 'repo_git_common_dir', 'repositories') });
      const active = activeFromDurableRow({ run: row, repo: repoRow, resource });
      const disposition = runDisposition({ database, run: row, resource });
      const contract: DurableRunContract = Object.freeze({ corpus_id: input.corpusId, run_id_sha256: runDigest, repo_id_sha256: repoDigest, required_actions: S2_D_DURABLE_RUN_ACTIONS, attachment_strategy: disposition.attachment_strategy, terminal_attempt_lease: disposition.terminal_attempt_lease, authority_version_mismatch: disposition.authority_version_mismatch, evidence_sha256: digestBytes(canonicalJson({ corpus_id: input.corpusId, run_id_sha256: runDigest, repo_id_sha256: repoDigest, active_session_generation: sqlInteger(row, 'active_session_generation', 'runs'), run_version: sqlInteger(row, 'version', 'runs'), phase36_evidence: disposition.phase36_evidence })) });
      return Object.freeze({ contract, repo: active.repo, active: active.active, copy_state_root: input.copyStateRoot });
    }));
  } finally { database.close(); }
}

export async function buildMutableClone(input: CorpusCloneRequest): Promise<BuiltMutableClone> {
  const request = await preflightCloneRequest(input);
  let created = false;
  try {
    await mkdir(request.destination_root, { mode: 0o700 });
    created = true;
    await mkdir(join(request.destination_root, 'private'), { mode: 0o700 });
    await writeFile(join(request.destination_root, 'private', 'request.json'), `${canonicalJson(request)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const corpora: BuiltCorpus[] = [];
    for (let index = 0; index < request.corpora.length; index += 1) corpora.push(await buildCorpus({ request, corpusIndex: index }));
    const sourceAfter = await Promise.all(request.corpora.flatMap((corpus) => [corpus.state_root, corpus.repository_root]).map(async (root) => await inventoryTree(root)));
    const proofs = combineProofs(corpora, request.destination_root, request, sourceAfter);
    const sourceWitnesses = corpora.flatMap((corpus) => [sourceWitness(request.rehearsal_id, corpus.corpus_id, 'state', corpus.source_inventory[0] ?? (() => { throw new Error('S2-D state inventory missing'); })()), sourceWitness(request.rehearsal_id, corpus.corpus_id, 'repository', corpus.source_inventory[1] ?? (() => { throw new Error('S2-D repository inventory missing'); })())]).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.root_label}`, `${right.corpus_id}\0${right.root_label}`));
    const databaseWitnessRows = (await Promise.all(request.corpora.map(async (corpus) => await databaseWitnesses(request.rehearsal_id, corpus.corpus_id, corpus.database_path)))).flat().sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.role}`, `${right.corpus_id}\0${right.role}`));
    const cloneCapabilities = await Promise.all(request.corpora.map(async (corpus) => {
      const copyCapability = join(request.destination_root, 'corpora', corpus.corpus_id, 'state', relative(corpus.state_root, corpus.capability_path));
      return digestBytes(Buffer.from(Buffer.from(readRegularFileNoFollow(copyCapability, 1024).bytes).toString('utf8').trim(), 'hex'));
    }));
    const manifestValue = { schema_version: S2_CORPUS_CLONE_MANIFEST_SCHEMA, rehearsal_id: request.rehearsal_id, created_at: request.created_at, candidate_build: request.candidate_build, source_witness_before: sourceWitnesses, database_witness_before: databaseWitnessRows, git_witness_before: corpora.map((corpus) => corpus.source_git).sort((left, right) => compareCodeUnits(left.corpus_id, right.corpus_id)), path_rebase_ledger: corpora.flatMap((corpus) => corpus.path_rebase.entries).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.target_kind}\0${left.target_sha256}\0${left.json_pointer}`, `${right.corpus_id}\0${right.target_kind}\0${right.target_sha256}\0${right.json_pointer}`)), clone_capability_sha256: digestBytes(canonicalJson(cloneCapabilities.sort(compareCodeUnits))), isolation_proofs: proofs, durable_runs: corpora.flatMap((corpus) => corpus.durable_runs.map((run) => run.contract)).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.run_id_sha256}`, `${right.corpus_id}\0${right.run_id_sha256}`)) };
    const manifest = parseCorpusCloneManifest(manifestValue);
    await writeFile(join(request.destination_root, 'private', 'manifest.json'), `${canonicalJson(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return Object.freeze({ request, clone_root: request.destination_root, manifest, corpora: Object.freeze(corpora) });
  } catch (error) {
    if (created) await rm(request.destination_root, { recursive: true, force: true });
    throw error;
  }
}

interface ObservedRehearsal {
  readonly action_results: readonly ActionResult[];
  readonly new_blockers: readonly CorpusBlocker[];
}

function assertObservedCoverage(manifest: CorpusCloneManifest, actions: readonly ActionResult[]): void {
  const expected = new Set<string>();
  for (const run of manifest.durable_runs) for (const action of run.required_actions) expected.add(`${run.corpus_id}\0${run.run_id_sha256}\0${action}`);
  const observed = new Set(actions.map((action) => `${action.corpus_id}\0${action.run_id_sha256}\0${action.action}`));
  if (expected.size === 0) throw new Error('S2-D rehearsal requires at least one discovered durable run');
  for (const key of expected) if (!observed.has(key)) throw new Error(`S2-D candidate subprocess did not execute required action ${key}`);
  for (const key of observed) if (!expected.has(key)) throw new Error(`S2-D candidate subprocess returned unknown action ${key}`);
}

export function rehearseManifest(manifest: CorpusCloneManifest, observed?: ObservedRehearsal, live?: { readonly source_after: readonly SourceWitness[]; readonly database_after: readonly DatabaseWitness[]; readonly git_after: readonly GitWitness[] }): CorpusRehearsalResult {
  const parsed = parseCorpusCloneManifest(manifest);
  if (observed === undefined || live === undefined) throw new Error('S2-D rehearsal requires observed candidate subprocess execution and live after-domain witnesses');
  if (!Object.values(parsed.isolation_proofs).every((entry) => entry.passed)) throw new Error('S2-D release gate cannot rehearse without complete isolation proofs');
  const actions = [...observed.action_results].sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.run_id_sha256}\0${left.action}`, `${right.corpus_id}\0${right.run_id_sha256}\0${right.action}`));
  assertObservedCoverage(parsed, actions);
  const sourceBeforeSha = digestBytes(canonicalJson(parsed.source_witness_before));
  const sourceAfterSha = digestBytes(canonicalJson(live.source_after));
  const databaseBeforeSha = digestBytes(canonicalJson(parsed.database_witness_before));
  const databaseAfterSha = digestBytes(canonicalJson(live.database_after));
  const gitBeforeSha = digestBytes(canonicalJson(parsed.git_witness_before));
  const gitAfterSha = digestBytes(canonicalJson(live.git_after));
  const databaseComponents = databaseBeforeSha === databaseAfterSha;
  const gitRefs = parsed.git_witness_before.every((before) => live.git_after.some((after) => after.corpus_id === before.corpus_id && after.ref_digest === before.ref_digest));
  const registrations = parsed.git_witness_before.every((before) => live.git_after.some((after) => after.corpus_id === before.corpus_id && after.registration_digest === before.registration_digest));
  const worktrees = parsed.git_witness_before.every((before) => live.git_after.some((after) => after.corpus_id === before.corpus_id && after.worktree_digest === before.worktree_digest));
  const files = sourceBeforeSha === sourceAfterSha;
  const result = { schema_version: S2_CORPUS_REHEARSAL_RESULT_SCHEMA, rehearsal_id: parsed.rehearsal_id, candidate_build: parsed.candidate_build, action_results: actions, live_unchanged: { source_witness_before_sha256: sourceBeforeSha, source_witness_after_sha256: sourceAfterSha, database_witness_before_sha256: databaseBeforeSha, database_witness_after_sha256: databaseAfterSha, git_witness_before_sha256: gitBeforeSha, git_witness_after_sha256: gitAfterSha, database_components: databaseComponents, git_refs: gitRefs, registrations, worktrees, files, passed: databaseComponents && gitRefs && registrations && worktrees && files }, isolation_proofs: parsed.isolation_proofs, new_blockers: observed.new_blockers, completed_at: new Date().toISOString() };
  return parseCorpusRehearsalResult(result);
}

async function liveSourceWitnesses(clone: BuiltMutableClone): Promise<readonly SourceWitness[]> {
  const witnesses: SourceWitness[] = [];
  for (const corpus of clone.request.corpora) {
    witnesses.push(sourceWitness(clone.request.rehearsal_id, corpus.corpus_id, 'state', await inventoryTree(corpus.state_root)));
    witnesses.push(sourceWitness(clone.request.rehearsal_id, corpus.corpus_id, 'repository', await inventoryTree(corpus.repository_root)));
  }
  return Object.freeze(witnesses.sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.root_label}`, `${right.corpus_id}\0${right.root_label}`)));
}

async function liveDatabaseWitnesses(clone: BuiltMutableClone): Promise<readonly DatabaseWitness[]> {
  return Object.freeze((await Promise.all(clone.request.corpora.map(async (corpus) => await databaseWitnesses(clone.request.rehearsal_id, corpus.corpus_id, corpus.database_path)))).flat().sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.role}`, `${right.corpus_id}\0${right.role}`)));
}

async function liveGitWitnesses(clone: BuiltMutableClone): Promise<readonly GitWitness[]> {
  return Object.freeze((await Promise.all(clone.request.corpora.map(async (corpus) => await sourceGitWitness(corpus.corpus_id, corpus.repository_root)))).sort((left, right) => compareCodeUnits(left.corpus_id, right.corpus_id)));
}

function candidateWorkerPath(): string {
  return fileURLToPath(new URL('./candidate-worker.ts', import.meta.url));
}

async function runCandidateSubprocess(input: DiscoveredDurableRun): Promise<ObservedRehearsal> {
  const inputPath = join(input.copy_state_root, 'coordinator', `s2-d-candidate-${randomUUID()}.json`);
  await writeFile(inputPath, `${canonicalJson({ state_root: input.copy_state_root, corpus_id: input.contract.corpus_id, run_id_sha256: input.contract.run_id_sha256, repo_id_sha256: input.contract.repo_id_sha256, repo: input.repo, active: input.active, contract: input.contract })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    const output = await new Promise<string>((resolveOutput, rejectOutput) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', candidateWorkerPath(), inputPath], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), env: { ...process.env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
      child.once('error', (error) => rejectOutput(error));
      child.once('close', (code, signal) => {
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (code !== 0) rejectOutput(new Error(`S2-D candidate subprocess failed code=${String(code)} signal=${String(signal)} stderr_sha256=${digestBytes(stderrText)}`));
        else resolveOutput(Buffer.concat(stdout).toString('utf8'));
      });
    });
    const parsed = JSON.parse(output) as ObservedRehearsal;
    return Object.freeze({ action_results: Object.freeze([...parsed.action_results]), new_blockers: Object.freeze([...parsed.new_blockers]) });
  } finally { await rm(inputPath, { force: true }); }
}

export async function writeRehearsalResult(clone: BuiltMutableClone): Promise<CorpusRehearsalResult> {
  if (existsSync(clone.request.result_path)) throw new Error('S2-D result path must remain absent until the gate is complete');
  const observedRows = await Promise.all(clone.corpora.flatMap((corpus) => corpus.durable_runs).map(async (run) => await runCandidateSubprocess(run)));
  const observed = Object.freeze({ action_results: Object.freeze(observedRows.flatMap((row) => row.action_results)), new_blockers: Object.freeze(observedRows.flatMap((row) => row.new_blockers)) });
  if (observed.new_blockers.length !== 0) throw new Error(`S2-D candidate subprocess returned blockers before release result: ${observed.new_blockers.map((blocker) => `${blocker.code}:${blocker.run_id_sha256 ?? 'global'}`).sort(compareCodeUnits).join(',')}`);
  const live = { source_after: await liveSourceWitnesses(clone), database_after: await liveDatabaseWitnesses(clone), git_after: await liveGitWitnesses(clone) };
  const result = rehearseManifest(clone.manifest, observed, live);
  await mkdir(dirname(clone.request.result_path), { recursive: true, mode: 0o700 });
  await writeFile(clone.request.result_path, `${canonicalJson(result)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return result;
}
