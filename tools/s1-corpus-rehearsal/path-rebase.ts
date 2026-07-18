import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import type { Sha256Digest } from './contracts.ts';
import { compareCodeUnits, readRegularFileNoFollow } from './inventory.ts';
import { logicalSqliteDigest, type SqliteLogicalDigest } from './sqlite-snapshot.ts';

export interface CorpusPathMapping {
  readonly source_path: string;
  readonly copy_path: string;
  readonly source_label: string;
  readonly kind: 'state-root' | 'repo-root' | 'git-common-dir' | 'worktree-root' | 'worktree' | 'runtime' | 'evidence';
}

export interface PathRewriteLedgerEntry {
  readonly target_kind: 'sqlite-cell' | 'runtime-metadata';
  readonly target_identity_sha256: Sha256Digest;
  readonly column: string;
  readonly json_pointer: string;
  readonly old_path_sha256: Sha256Digest;
  readonly clone_relative_path: string | null;
  readonly rewrite_kind: 'path-rebase' | 'remote-neutralization';
  readonly before_sha256: Sha256Digest;
  readonly after_sha256: Sha256Digest;
}

export interface PathRebaseResult {
  readonly entries: readonly PathRewriteLedgerEntry[];
  readonly ledger_sha256: Sha256Digest;
  readonly database_before: SqliteLogicalDigest;
  readonly database_after: SqliteLogicalDigest;
}

interface JsonObject { readonly [key: string]: unknown }

const METADATA_FILES = new Set(['active-autopilots.json', '_index.json', '_task-info.json', '_branches.json', '_unit-index.json', '_unit-info.json', 'state.json']);
const METADATA_JSONL_FILES = new Set(['_ledger.jsonl']);
const ACTIONABLE_PATH_FIELDS = new Set(['canonical_path', 'canonical_root', 'git_common_dir', 'main_worktree_path', 'repo_root', 'repository_root', 'runtime_root', 'source_repo', 'state_root', 'task_root', 'worktree_path', 'worktree_root']);
const WRITABLE_REMOTE_FIELDS = new Set(['origin_url', 'push_url', 'remote_url']);
const IMMUTABLE_ARTIFACT_SEGMENTS = new Set(['_archive', 'backups', 'evidence', 'sessions', 'startup-reports', 'transition-backups']);

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function pointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function normalizedMappings(mappings: readonly CorpusPathMapping[], cloneRoot: string): readonly CorpusPathMapping[] {
  if (mappings.length === 0) throw new Error('C5 path rebase requires at least one source/copy mapping');
  const source = new Set<string>();
  const output = mappings.map((entry) => {
    const sourcePath = resolve(entry.source_path);
    const copyPath = resolve(entry.copy_path);
    if (source.has(sourcePath)) throw new Error(`C5 path rebase contains duplicate source authority ${digest(sourcePath)}`);
    source.add(sourcePath);
    if (!inside(cloneRoot, copyPath)) throw new Error('C5 path rebase copy path escapes clone root');
    return Object.freeze({ ...entry, source_path: sourcePath, copy_path: copyPath });
  });
  return Object.freeze(output.sort((left, right) => right.source_path.length - left.source_path.length || compareCodeUnits(left.source_path, right.source_path)));
}

function mappedPath(value: string, mappings: readonly CorpusPathMapping[]): string | null {
  if (!isAbsolute(value)) return null;
  const path = resolve(value);
  for (const mapping of mappings) {
    if (!inside(mapping.source_path, path)) continue;
    const rel = relative(mapping.source_path, path);
    return resolve(mapping.copy_path, rel);
  }
  throw new Error(`C5 actionable metadata contains an absolute path outside the declared source corpus: ${digest(value)}`);
}

function entry(input: {
  readonly targetKind: PathRewriteLedgerEntry['target_kind'];
  readonly targetIdentity: string;
  readonly column: string;
  readonly pointer: string;
  readonly oldValue: string;
  readonly newValue: string | null;
  readonly cloneRoot: string;
  readonly rewriteKind: PathRewriteLedgerEntry['rewrite_kind'];
}): PathRewriteLedgerEntry {
  const cloneRelative = input.newValue === null ? null : relative(input.cloneRoot, input.newValue).split(sep).join('/');
  if (cloneRelative !== null && (cloneRelative === '' || cloneRelative === '..' || cloneRelative.startsWith('../') || isAbsolute(cloneRelative))) throw new Error('C5 rewritten path escapes clone root');
  return Object.freeze({
    target_kind: input.targetKind,
    target_identity_sha256: digest(`pi-autopilot/c5/rewrite-target/v1\0${input.targetIdentity}`),
    column: input.column,
    json_pointer: input.pointer,
    old_path_sha256: digest(`pi-autopilot/c5/rewrite-source/v1\0${input.oldValue}`),
    clone_relative_path: cloneRelative,
    rewrite_kind: input.rewriteKind,
    before_sha256: digest(canonicalJson(input.oldValue)),
    after_sha256: digest(canonicalJson(input.newValue)),
  });
}

function transform(input: {
  readonly value: unknown;
  readonly pointer: string;
  readonly mappings: readonly CorpusPathMapping[];
  readonly cloneRoot: string;
  readonly targetKind: PathRewriteLedgerEntry['target_kind'];
  readonly targetIdentity: string;
  readonly column: string;
  readonly neutralizeOrigin: boolean;
  readonly actionablePath: boolean;
  readonly entries: PathRewriteLedgerEntry[];
}): unknown {
  if (typeof input.value === 'string') {
    if (!input.actionablePath) return input.value;
    const mapped = mappedPath(input.value, input.mappings);
    if (mapped === null) return input.value;
    if (!inside(input.cloneRoot, mapped)) throw new Error('C5 rewritten actionable path escapes clone root');
    input.entries.push(entry({ targetKind: input.targetKind, targetIdentity: input.targetIdentity, column: input.column, pointer: input.pointer, oldValue: input.value, newValue: mapped, cloneRoot: input.cloneRoot, rewriteKind: 'path-rebase' }));
    return mapped;
  }
  if (Array.isArray(input.value)) return input.value.map((value, index) => transform({ ...input, value, pointer: `${input.pointer}/${String(index)}` }));
  if (typeof input.value !== 'object' || input.value === null) return input.value;
  const record = input.value as JsonObject;
  const output: { [key: string]: unknown } = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    const pointer = `${input.pointer}/${pointerSegment(key)}`;
    if (input.neutralizeOrigin && WRITABLE_REMOTE_FIELDS.has(key) && typeof value === 'string') {
      input.entries.push(entry({ targetKind: input.targetKind, targetIdentity: input.targetIdentity, column: input.column, pointer, oldValue: value, newValue: null, cloneRoot: input.cloneRoot, rewriteKind: 'remote-neutralization' }));
      output[key] = null;
    } else output[key] = transform({ ...input, value, pointer, actionablePath: input.actionablePath || ACTIONABLE_PATH_FIELDS.has(key) });
  }
  return output;
}

export interface ActionableJsonFacts {
  readonly absolute_paths: readonly { readonly pointer: string; readonly value: string }[];
  readonly writable_remote_pointers: readonly string[];
}

export function actionableJsonFacts(value: unknown): ActionableJsonFacts {
  const absolutePaths: { pointer: string; value: string }[] = [];
  const writableRemotes: string[] = [];
  const visit = (candidate: unknown, pointer: string, actionablePath: boolean): void => {
    if (typeof candidate === 'string') {
      if (actionablePath && isAbsolute(candidate)) absolutePaths.push(Object.freeze({ pointer, value: candidate }));
      return;
    }
    if (Array.isArray(candidate)) { candidate.forEach((entry, index) => visit(entry, `${pointer}/${String(index)}`, actionablePath)); return; }
    if (typeof candidate !== 'object' || candidate === null) return;
    const record = candidate as JsonObject;
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      const childPointer = `${pointer}/${pointerSegment(key)}`;
      const child = record[key];
      if (WRITABLE_REMOTE_FIELDS.has(key) && child !== null && child !== undefined) writableRemotes.push(childPointer);
      visit(child, childPointer, actionablePath || ACTIONABLE_PATH_FIELDS.has(key));
    }
  };
  visit(value, '', false);
  return Object.freeze({ absolute_paths: Object.freeze(absolutePaths), writable_remote_pointers: Object.freeze(writableRemotes) });
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.['count'] === 1;
}

function rebaseDatabase(databasePath: string, cloneRoot: string, mappings: readonly CorpusPathMapping[], entries: PathRewriteLedgerEntry[]): void {
  const database = new DatabaseSync(databasePath, { timeout: 30_000 });
  try {
    database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    if (!tableExists(database, 'repositories')) throw new Error('C5 path rebase source omits schema-12 repositories');
    for (const row of database.prepare('SELECT repo_id, canonical_root, git_common_dir FROM repositories ORDER BY repo_id').all()) {
      const repoId = row['repo_id'];
      const canonicalRoot = row['canonical_root'];
      const gitCommonDir = row['git_common_dir'];
      if (typeof repoId !== 'string' || typeof canonicalRoot !== 'string' || typeof gitCommonDir !== 'string') throw new Error('C5 repositories path projection is malformed');
      const mappedRoot = mappedPath(canonicalRoot, mappings);
      const mappedCommon = mappedPath(gitCommonDir, mappings);
      if (mappedRoot === null || mappedCommon === null) throw new Error('C5 repository path projection is not absolute');
      entries.push(entry({ targetKind: 'sqlite-cell', targetIdentity: `repositories\0${repoId}`, column: 'canonical_root', pointer: '', oldValue: canonicalRoot, newValue: mappedRoot, cloneRoot, rewriteKind: 'path-rebase' }));
      entries.push(entry({ targetKind: 'sqlite-cell', targetIdentity: `repositories\0${repoId}`, column: 'git_common_dir', pointer: '', oldValue: gitCommonDir, newValue: mappedCommon, cloneRoot, rewriteKind: 'path-rebase' }));
      database.prepare('UPDATE repositories SET canonical_root=?, git_common_dir=? WHERE repo_id=?').run(mappedRoot, mappedCommon, repoId);
    }
    for (const table of ['run_resources', 'worktrees', 'worktree_operations'] as const) {
      if (!tableExists(database, table)) throw new Error(`C5 path rebase source omits schema-12 ${table}`);
      for (const row of database.prepare(`SELECT entity_id,payload_json FROM "${table}" ORDER BY entity_id`).all()) {
        const entityId = row['entity_id'];
        const payloadText = row['payload_json'];
        if (typeof entityId !== 'string' || typeof payloadText !== 'string') throw new Error(`C5 ${table} path projection is malformed`);
        let payload: unknown;
        try { payload = JSON.parse(payloadText) as unknown; }
        catch { throw new Error(`C5 ${table} payload is not JSON for ${digest(entityId)}`); }
        const beforeCount = entries.length;
        const transformed = transform({ value: payload, pointer: '', mappings, cloneRoot, targetKind: 'sqlite-cell', targetIdentity: `${table}\0${entityId}`, column: 'payload_json', neutralizeOrigin: true, actionablePath: false, entries });
        if (entries.length > beforeCount) database.prepare(`UPDATE "${table}" SET payload_json=? WHERE entity_id=?`).run(canonicalJson(transformed), entityId);
      }
    }
    database.exec('COMMIT');
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.['busy'] !== 0) throw new Error('C5 path rebase could not retire clone WAL authority');
    const journal = database.prepare('PRAGMA journal_mode=DELETE').get();
    if (journal?.['journal_mode'] !== 'delete') throw new Error('C5 path rebase could not publish a sidecar-free schema-12 clone');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally { database.close(); }
}

async function metadataPaths(root: string, excludedRoots: ReadonlySet<string>): Promise<readonly string[]> {
  const paths: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) throw new Error('C5 metadata traversal stack underflow');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name))) {
      visited += 1;
      if (visited > 1_000_000) throw new Error('C5 metadata traversal exceeds the bounded node limit');
      const path = join(directory, entry.name);
      const relativeSegments = relative(root, path).split(sep);
      if (relativeSegments.some((segment) => IMMUTABLE_ARTIFACT_SEGMENTS.has(segment)) || [...excludedRoots].some((excluded) => inside(excluded, path))) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && (METADATA_FILES.has(entry.name) || METADATA_JSONL_FILES.has(entry.name))) paths.push(path);
    }
  }
  return Object.freeze(paths.sort());
}

async function rebaseMetadataFile(path: string, cloneRoot: string, mappings: readonly CorpusPathMapping[], entries: PathRewriteLedgerEntry[]): Promise<void> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('C5 actionable runtime metadata is not a bounded regular file');
  const input = readRegularFileNoFollow(path, 64 * 1024 * 1024);
  if (input.identity.link_count !== 1) throw new Error('C5 actionable runtime metadata is hardlinked');
  const text = Buffer.from(input.bytes).toString('utf8');
  const targetIdentity = `runtime\0${relative(cloneRoot, path).split(sep).join('/')}`;
  const values: readonly unknown[] = METADATA_JSONL_FILES.has(path.slice(path.lastIndexOf(sep) + 1))
    ? text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown)
    : [JSON.parse(text) as unknown];
  const transformed = values.map((value, index) => transform({ value, pointer: METADATA_JSONL_FILES.has(path.slice(path.lastIndexOf(sep) + 1)) ? `/${String(index)}` : '', mappings, cloneRoot, targetKind: 'runtime-metadata', targetIdentity, column: 'file', neutralizeOrigin: true, actionablePath: false, entries }));
  if (canonicalJson(values) === canonicalJson(transformed)) return;
  const output = METADATA_JSONL_FILES.has(path.slice(path.lastIndexOf(sep) + 1)) ? `${transformed.map(canonicalJson).join('\n')}\n` : `${canonicalJson(transformed[0])}\n`;
  const temporary = `${path}.c5-rebase`;
  try {
    await writeFile(temporary, output, { encoding: 'utf8', flag: 'wx', mode: stat.mode & 0o777 });
    const current = lstatSync(path);
    if (String(current.dev) !== input.identity.device || String(current.ino) !== input.identity.inode || current.size !== input.size_bytes || current.nlink !== 1) throw new Error('C5 actionable runtime metadata changed during rebase');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function rebaseCorpusPaths(input: {
  readonly database_path: string;
  readonly state_root: string;
  readonly clone_root: string;
  readonly mappings: readonly CorpusPathMapping[];
  readonly ledger_path: string;
  readonly expected_user_version: number;
}): Promise<PathRebaseResult> {
  const cloneRoot = resolve(input.clone_root);
  const stateRoot = resolve(input.state_root);
  if (!inside(cloneRoot, stateRoot) || !inside(cloneRoot, input.database_path) || !inside(cloneRoot, input.ledger_path)) throw new Error('C5 path rebase targets escape clone authority');
  if (existsSync(input.ledger_path)) throw new Error('C5 path rebase ledger destination already exists');
  const mappings = normalizedMappings(input.mappings, cloneRoot);
  const databaseBefore = logicalSqliteDigest(input.database_path);
  if (databaseBefore.user_version !== input.expected_user_version) throw new Error(`C5 path rebase requires schema ${String(input.expected_user_version)}`);
  const entries: PathRewriteLedgerEntry[] = [];
  rebaseDatabase(input.database_path, cloneRoot, mappings, entries);
  const evidenceRoots = new Set(mappings.filter((mapping) => mapping.kind === 'evidence').map((mapping) => mapping.copy_path));
  for (const path of await metadataPaths(stateRoot, evidenceRoots)) await rebaseMetadataFile(path, cloneRoot, mappings, entries);
  const databaseAfter = logicalSqliteDigest(input.database_path);
  if (existsSync(`${input.database_path}-journal`) || existsSync(`${input.database_path}-wal`) || existsSync(`${input.database_path}-shm`)) throw new Error('C5 path rebase retained SQLite journal/WAL/SHM sidecars');
  if (databaseAfter.user_version !== databaseBefore.user_version) throw new Error('C5 path rebase changed SQLite schema identity');
  if (entries.length === 0) throw new Error('C5 path rebase produced no audited transformations');
  entries.sort((left, right) => compareCodeUnits(`${left.target_kind}\0${left.target_identity_sha256}\0${left.column}\0${left.json_pointer}`, `${right.target_kind}\0${right.target_identity_sha256}\0${right.column}\0${right.json_pointer}`));
  const bytes = `${canonicalJson({ schema_version: 'autopilot.s1_corpus_path_rebase_ledger.v1', entries })}\n`;
  await mkdir(resolve(input.ledger_path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(input.ledger_path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return Object.freeze({ entries: Object.freeze(entries), ledger_sha256: digest(bytes), database_before: databaseBefore, database_after: databaseAfter });
}
