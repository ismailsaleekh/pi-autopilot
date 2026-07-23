import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import type { PathRebaseEntry, Sha256Digest } from './contracts.ts';
import { compareCodeUnits, digestBytes, inside, readRegularFileNoFollow } from './inventory.ts';

export interface CorpusPathMapping {
  readonly corpus_id: string;
  readonly source_path: string;
  readonly copy_path: string;
  readonly source_label: string;
}

export interface PathRebaseResult {
  readonly entries: readonly PathRebaseEntry[];
  readonly ledger_sha256: Sha256Digest;
}

interface JsonMap { readonly [key: string]: unknown }

const WRITABLE_REMOTE_FIELDS = new Set(['origin_url', 'push_url', 'remote_url']);
const SCANNED_FILE_NAMES = new Set(['active-autopilots.json', 'runs.json', 'durable-runs.json', 'metadata.json', 'state.json']);

function digestPrivatePath(rehearsalId: string, path: string): Sha256Digest {
  return digestBytes(`pi-autopilot/s2-d/path/v1\0${rehearsalId}\0${resolve(path)}`);
}

function pointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function jsonMap(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as JsonMap;
}

function normalizedMappings(mappings: readonly CorpusPathMapping[], cloneRoot: string): readonly CorpusPathMapping[] {
  if (mappings.length === 0) throw new Error('S2-D path rebase requires mappings');
  const sources = new Set<string>();
  const normalized = mappings.map((mapping) => {
    const source = resolve(mapping.source_path);
    const copy = resolve(mapping.copy_path);
    if (sources.has(source)) throw new Error('S2-D path rebase has duplicate source root');
    sources.add(source);
    if (!inside(cloneRoot, copy)) throw new Error('S2-D mapped copy path escapes clone root');
    return Object.freeze({ ...mapping, source_path: source, copy_path: copy });
  });
  return Object.freeze(normalized.sort((left, right) => right.source_path.length - left.source_path.length || compareCodeUnits(left.source_path, right.source_path)));
}

function mappedPath(value: string, mappings: readonly CorpusPathMapping[]): { readonly mapping: CorpusPathMapping; readonly path: string } | null {
  if (!isAbsolute(value)) return null;
  const path = resolve(value);
  for (const mapping of mappings) {
    if (!inside(mapping.source_path, path)) continue;
    return Object.freeze({ mapping, path: resolve(mapping.copy_path, relative(mapping.source_path, path)) });
  }
  throw new Error(`S2-D actionable path escapes declared source authority: ${createHash('sha256').update(path).digest('hex')}`);
}

function entry(input: { readonly rehearsalId: string; readonly corpusId: string; readonly targetKind: PathRebaseEntry['target_kind']; readonly targetPath: string; readonly pointer: string; readonly oldValue: string; readonly newValue: string | null; readonly cloneRoot: string; readonly rewriteKind: PathRebaseEntry['rewrite_kind'] }): PathRebaseEntry {
  const cloneRelative = input.newValue === null ? null : relative(input.cloneRoot, input.newValue).split(sep).join('/');
  if (cloneRelative !== null && (cloneRelative === '' || cloneRelative === '..' || cloneRelative.startsWith('../') || isAbsolute(cloneRelative))) throw new Error('S2-D rebased path escapes clone root');
  return Object.freeze({ corpus_id: input.corpusId, target_kind: input.targetKind, target_sha256: digestPrivatePath(input.rehearsalId, input.targetPath), json_pointer: input.pointer, old_path_sha256: digestPrivatePath(input.rehearsalId, input.oldValue), clone_relative_path: cloneRelative, rewrite_kind: input.rewriteKind, after_sha256: digestBytes(canonicalJson(input.newValue)) });
}

function transform(input: { readonly value: unknown; readonly pointer: string; readonly mappings: readonly CorpusPathMapping[]; readonly cloneRoot: string; readonly rehearsalId: string; readonly targetPath: string; readonly targetKind: PathRebaseEntry['target_kind']; readonly entries: PathRebaseEntry[] }): unknown {
  if (typeof input.value === 'string') return transformString({ ...input, value: input.value });
  if (Array.isArray(input.value)) return input.value.map((value, index) => transform({ ...input, value, pointer: `${input.pointer}/${String(index)}` }));
  if (typeof input.value !== 'object' || input.value === null) return input.value;
  const row = jsonMap(input.value, 'S2-D path rebase value');
  const output: { [key: string]: unknown } = {};
  for (const key of Object.keys(row).sort(compareCodeUnits)) {
    const child = row[key];
    const pointer = `${input.pointer}/${pointerSegment(key)}`;
    if (WRITABLE_REMOTE_FIELDS.has(key) && child !== null && child !== undefined) {
      if (typeof child !== 'string') throw new Error('S2-D writable remote field must be text before neutralization');
      const firstMapping = input.mappings[0];
      if (firstMapping === undefined) throw new Error('S2-D remote neutralization requires corpus authority');
      input.entries.push(entry({ rehearsalId: input.rehearsalId, corpusId: firstMapping.corpus_id, targetKind: input.targetKind, targetPath: input.targetPath, pointer, oldValue: child, newValue: null, cloneRoot: input.cloneRoot, rewriteKind: 'remote-neutralization' }));
      output[key] = null;
    } else {
      output[key] = transform({ ...input, value: child, pointer });
    }
  }
  return output;
}

function transformString(input: { readonly value: string; readonly pointer: string; readonly mappings: readonly CorpusPathMapping[]; readonly cloneRoot: string; readonly rehearsalId: string; readonly targetPath: string; readonly targetKind: PathRebaseEntry['target_kind']; readonly entries: PathRebaseEntry[] }): string {
  const mapped = mappedPath(input.value, input.mappings);
  if (mapped === null) return input.value;
  if (!inside(input.cloneRoot, mapped.path)) throw new Error('S2-D transformed path escapes clone root');
  input.entries.push(entry({ rehearsalId: input.rehearsalId, corpusId: mapped.mapping.corpus_id, targetKind: input.targetKind, targetPath: input.targetPath, pointer: input.pointer, oldValue: input.value, newValue: mapped.path, cloneRoot: input.cloneRoot, rewriteKind: 'path-rebase' }));
  return mapped.path;
}

async function metadataPaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) throw new Error('S2-D metadata traversal underflow');
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const dirent of entries) {
      visited += 1;
      if (visited > 1_000_000) throw new Error('S2-D metadata traversal exceeded bounded node limit');
      const path = join(directory, dirent.name);
      if (dirent.isDirectory()) pending.push(path);
      else if (dirent.isFile() && (SCANNED_FILE_NAMES.has(dirent.name) || dirent.name.endsWith('.metadata.json') || dirent.name.endsWith('.jsonl'))) paths.push(path);
    }
  }
  return Object.freeze(paths.sort(compareCodeUnits));
}

async function rebaseFile(input: { readonly path: string; readonly cloneRoot: string; readonly rehearsalId: string; readonly mappings: readonly CorpusPathMapping[]; readonly entries: PathRebaseEntry[] }): Promise<void> {
  const stat = lstatSync(input.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('S2-D metadata file is not bounded single-link authority');
  const raw = readRegularFileNoFollow(input.path, 64 * 1024 * 1024);
  const text = Buffer.from(raw.bytes).toString('utf8');
  const jsonl = input.path.endsWith('.jsonl');
  const values: readonly unknown[] = jsonl ? text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown) : [JSON.parse(text) as unknown];
  const before = canonicalJson(values);
  const transformed = values.map((value, index) => transform({ value, pointer: jsonl ? `/${String(index)}` : '', mappings: input.mappings, cloneRoot: input.cloneRoot, rehearsalId: input.rehearsalId, targetPath: input.path, targetKind: jsonl ? 'jsonl-file' : 'json-file', entries: input.entries }));
  if (canonicalJson(transformed) === before) return;
  const output = jsonl ? `${transformed.map(canonicalJson).join('\n')}\n` : `${canonicalJson(transformed[0])}\n`;
  const temporary = `${input.path}.s2-d-rebase`;
  try {
    await writeFile(temporary, output, { encoding: 'utf8', flag: 'wx', mode: stat.mode & 0o777 });
    const current = lstatSync(input.path);
    if (current.dev !== Number(raw.identity.device) || current.ino !== Number(raw.identity.inode) || current.size !== raw.size_bytes || current.nlink !== 1) throw new Error('S2-D metadata changed during rebase');
    await rename(temporary, input.path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function sqlIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\u0000')) throw new Error('S2-D SQLite identifier is invalid');
  return `"${value.replace(/"/gu, '""')}"`;
}

function sqliteRows(database: DatabaseSync, sql: string): readonly Record<string, unknown>[] {
  return database.prepare(sql).all() as readonly Record<string, unknown>[];
}

function parseJsonCell(text: string): unknown | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  return JSON.parse(trimmed) as unknown;
}

function sqlInput(value: unknown): SQLInputValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value === null) return value;
  if (value instanceof Uint8Array) return value;
  throw new Error('S2-D SQLite primary key has unsupported type');
}

function rebaseSqliteDatabase(input: { readonly path: string; readonly cloneRoot: string; readonly rehearsalId: string; readonly mappings: readonly CorpusPathMapping[]; readonly entries: PathRebaseEntry[] }): void {
  const stat = lstatSync(input.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024) throw new Error('S2-D SQLite metadata database is not bounded single-link authority');
  const database = new DatabaseSync(input.path);
  try {
    database.exec('PRAGMA query_only=OFF; BEGIN IMMEDIATE');
    try {
      const tables = sqliteRows(database, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => String(row['name']));
      for (const table of tables) {
        const tableName = sqlIdentifier(table);
        const tableInfo = sqliteRows(database, `PRAGMA table_info(${tableName})`);
        const columns = tableInfo.filter((row) => /TEXT|JSON|CLOB|CHAR|VARCHAR/iu.test(String(row['type'] ?? ''))).map((row) => String(row['name'])).sort(compareCodeUnits);
        const primaryKeys = tableInfo.filter((row) => typeof row['pk'] === 'number' && row['pk'] > 0).sort((left, right) => Number(left['pk']) - Number(right['pk'])).map((row) => String(row['name']));
        const selector = primaryKeys.length === 0 ? 'rowid AS s2_pk_0' : primaryKeys.map((key, index) => `${sqlIdentifier(key)} AS s2_pk_${String(index)}`).join(', ');
        const where = primaryKeys.length === 0 ? 'rowid=?' : primaryKeys.map((key) => `${sqlIdentifier(key)}=?`).join(' AND ');
        for (const column of columns) {
          const columnName = sqlIdentifier(column);
          const rows = sqliteRows(database, `SELECT ${selector}, ${columnName} AS value FROM ${tableName} WHERE typeof(${columnName})='text' ORDER BY ${primaryKeys.length === 0 ? 's2_pk_0' : primaryKeys.map(sqlIdentifier).join(', ')}`);
          for (const row of rows) {
            const value = row['value'];
            if (typeof value !== 'string') continue;
            const identity = primaryKeys.length === 0 ? String(row['s2_pk_0']) : primaryKeys.map((_, index) => String(row[`s2_pk_${String(index)}`])).join(':');
            const parsed = parseJsonCell(value);
            const beforeCount = input.entries.length;
            const targetPath = `${input.path}#${table}.${column}.${identity}`;
            const transformed = parsed === null
              ? transformString({ value, pointer: `/${pointerSegment(table)}/${pointerSegment(identity)}/${pointerSegment(column)}`, mappings: input.mappings, cloneRoot: input.cloneRoot, rehearsalId: input.rehearsalId, targetPath, targetKind: 'sqlite-cell', entries: input.entries })
              : transform({ value: parsed, pointer: `/${pointerSegment(table)}/${pointerSegment(identity)}/${pointerSegment(column)}`, mappings: input.mappings, cloneRoot: input.cloneRoot, rehearsalId: input.rehearsalId, targetPath, targetKind: 'sqlite-cell', entries: input.entries });
            if (input.entries.length === beforeCount) continue;
            const keyValues: SQLInputValue[] = primaryKeys.length === 0 ? [sqlInput(row['s2_pk_0'])] : primaryKeys.map((_, index) => sqlInput(row[`s2_pk_${String(index)}`]));
            database.prepare(`UPDATE ${tableName} SET ${columnName}=? WHERE ${where}`).run(typeof transformed === 'string' ? transformed : canonicalJson(transformed), ...keyValues);
          }
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally { database.close(); }
}

export async function rebaseCorpusPaths(input: { readonly clone_root: string; readonly state_root: string; readonly ledger_path: string; readonly rehearsal_id: string; readonly mappings: readonly CorpusPathMapping[]; readonly database_paths?: readonly string[] }): Promise<PathRebaseResult> {
  const cloneRoot = resolve(input.clone_root);
  const stateRoot = resolve(input.state_root);
  if (!inside(cloneRoot, stateRoot) || !inside(cloneRoot, input.ledger_path)) throw new Error('S2-D path rebase target escapes clone root');
  if (existsSync(input.ledger_path)) throw new Error('S2-D path rebase ledger already exists');
  const mappings = normalizedMappings(input.mappings, cloneRoot);
  const entries: PathRebaseEntry[] = [];
  for (const path of await metadataPaths(stateRoot)) await rebaseFile({ path, cloneRoot, rehearsalId: input.rehearsal_id, mappings, entries });
  for (const path of input.database_paths ?? []) {
    const databasePath = resolve(path);
    if (!inside(cloneRoot, databasePath)) throw new Error('S2-D SQLite rebase database escapes clone root');
    if (existsSync(databasePath)) rebaseSqliteDatabase({ path: databasePath, cloneRoot, rehearsalId: input.rehearsal_id, mappings, entries });
  }
  if (entries.length === 0) throw new Error('S2-D path rebase produced no audited transformations');
  entries.sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.target_kind}\0${left.target_sha256}\0${left.json_pointer}`, `${right.corpus_id}\0${right.target_kind}\0${right.target_sha256}\0${right.json_pointer}`));
  const bytes = `${canonicalJson({ schema_version: 'autopilot.s2_d_path_rebase_ledger.v1', entries })}\n`;
  await mkdir(resolve(input.ledger_path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(input.ledger_path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return Object.freeze({ entries: Object.freeze(entries), ledger_sha256: digestBytes(bytes) });
}

export function assertNoLiveActionablePaths(value: unknown, cloneRoot: string): void {
  const visit = (candidate: unknown, pointer: string): void => {
    if (typeof candidate === 'string') {
      if (isAbsolute(candidate) && !inside(cloneRoot, candidate)) throw new Error(`S2-D live absolute path remains at ${pointer}`);
      return;
    }
    if (Array.isArray(candidate)) { candidate.forEach((entryValue, index) => visit(entryValue, `${pointer}/${String(index)}`)); return; }
    if (typeof candidate !== 'object' || candidate === null) return;
    const row = jsonMap(candidate, 'S2-D structural path scan');
    for (const key of Object.keys(row).sort(compareCodeUnits)) {
      if (WRITABLE_REMOTE_FIELDS.has(key) && row[key] !== null && row[key] !== undefined) throw new Error(`S2-D writable remote route remains at ${pointer}/${pointerSegment(key)}`);
      visit(row[key], `${pointer}/${pointerSegment(key)}`);
    }
  };
  visit(value, '');
}

export async function assertMetadataCloneContained(stateRoot: string, cloneRoot: string, databasePaths: readonly string[] = []): Promise<void> {
  for (const path of await metadataPaths(stateRoot)) {
    const text = await readFile(path, 'utf8');
    const values: readonly unknown[] = path.endsWith('.jsonl') ? text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown) : [JSON.parse(text) as unknown];
    for (const value of values) assertNoLiveActionablePaths(value, cloneRoot);
  }
  for (const path of databasePaths) {
    const databasePath = resolve(path);
    if (!inside(cloneRoot, databasePath) || !existsSync(databasePath)) continue;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = sqliteRows(database, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => String(row['name']));
      for (const table of tables) {
        const tableName = sqlIdentifier(table);
        const columns = sqliteRows(database, `PRAGMA table_info(${tableName})`).filter((row) => /TEXT|JSON|CLOB|CHAR|VARCHAR/iu.test(String(row['type'] ?? ''))).map((row) => String(row['name'])).sort(compareCodeUnits);
        for (const column of columns) {
          const columnName = sqlIdentifier(column);
          const rows = sqliteRows(database, `SELECT ${columnName} AS value FROM ${tableName} WHERE typeof(${columnName})='text'`);
          for (const row of rows) {
            const value = row['value'];
            if (typeof value !== 'string') continue;
            const parsed = parseJsonCell(value);
            if (parsed === null) assertNoLiveActionablePaths(value, cloneRoot);
            else assertNoLiveActionablePaths(parsed, cloneRoot);
          }
        }
      }
    } finally { database.close(); }
  }
}
