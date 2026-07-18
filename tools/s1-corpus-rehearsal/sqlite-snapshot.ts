import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import type { DatabaseComponent, Sha256Digest } from './contracts.ts';
import { copyRegularFileNoFollow, hashRegularFile, inspectRegularFileNoFollow, pathFileIdentity, sourcePathDigest } from './inventory.ts';

export interface SqliteLogicalDigest {
  readonly user_version: number;
  readonly schema_sha256: Sha256Digest;
  readonly tables: readonly { readonly table: string; readonly row_count: number; readonly rows_sha256: Sha256Digest }[];
  readonly logical_sha256: Sha256Digest;
}

export interface CoherentSqliteSnapshot {
  readonly source_components_before: readonly DatabaseComponent[];
  readonly source_components_after: readonly DatabaseComponent[];
  readonly source_logical_before: SqliteLogicalDigest;
  readonly source_logical_after: SqliteLogicalDigest;
  readonly copy_logical: SqliteLogicalDigest;
  readonly copy_sha256: Sha256Digest;
}

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function quoteIdentifier(value: string): string {
  if (value.includes('\u0000')) throw new Error('SQLite identifier contains NUL');
  return `"${value.replace(/"/gu, '""')}"`;
}

function encodeSqlValue(value: SQLOutputValue): Readonly<Record<string, string | null>> {
  if (value === null) return Object.freeze({ type: 'null', value: null });
  if (typeof value === 'string') return Object.freeze({ type: 'text', value });
  if (typeof value === 'bigint') return Object.freeze({ type: 'integer', value: value.toString() });
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQLite logical digest encountered a non-finite number');
    return Object.freeze({ type: Number.isInteger(value) ? 'integer' : 'float', value: Object.is(value, -0) ? '-0' : String(value) });
  }
  return Object.freeze({ type: 'blob', value: Buffer.from(value).toString('base64') });
}

function requireIntegrity(database: DatabaseSync, label: string): void {
  const rows = database.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0]?.['integrity_check'] !== 'ok') throw new Error(`${label} SQLite integrity_check failed`);
}

export function logicalSqliteDigest(databasePath: string): SqliteLogicalDigest {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 30_000 });
  try {
    database.exec('PRAGMA query_only=ON');
    requireIntegrity(database, databasePath);
    const versionRow = database.prepare('PRAGMA user_version').get();
    const version = versionRow?.['user_version'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new Error('C5 SQLite database has an invalid user_version');
    const schemaRows = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name").all().map((row) => ({
      type: row['type'], name: row['name'], tbl_name: row['tbl_name'], sql: row['sql'],
    }));
    const schemaSha256 = digest(canonicalJson(schemaRows));
    const tableNames = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => {
      const name = row['name'];
      if (typeof name !== 'string' || name.length === 0) throw new Error('C5 SQLite database contains an invalid table name');
      return name;
    });
    const tables = tableNames.map((table) => {
      const rowHashes: string[] = [];
      let rowCount = 0;
      for (const row of database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).iterate()) {
        const encoded = Object.keys(row).sort().map((column) => ({ column, value: encodeSqlValue(row[column] ?? null) }));
        rowHashes.push(digest(canonicalJson(encoded)));
        rowCount += 1;
        if (rowCount > 10_000_000) throw new Error(`C5 SQLite table ${table} exceeded the bounded logical digest row count`);
      }
      rowHashes.sort();
      return Object.freeze({ table, row_count: rowCount, rows_sha256: digest(canonicalJson(rowHashes)) });
    });
    return Object.freeze({ user_version: version, schema_sha256: schemaSha256, tables: Object.freeze(tables), logical_sha256: digest(canonicalJson({ user_version: version, schema_sha256: schemaSha256, tables })) });
  } finally { database.close(); }
}

async function component(rehearsalId: string, corpusId: string, databasePath: string, role: DatabaseComponent['role']): Promise<DatabaseComponent> {
  const path = role === 'database' ? databasePath : `${databasePath}-${role}`;
  if (!existsSync(path)) return Object.freeze({ corpus_id: corpusId, role, present: false, path_sha256: sourcePathDigest(rehearsalId, path), identity: null, size_bytes: null, sha256: null });
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`C5 SQLite ${role} component is not a physical regular file`);
  const inspected = await inspectRegularFileNoFollow(path);
  return Object.freeze({ corpus_id: corpusId, role, present: true, path_sha256: sourcePathDigest(rehearsalId, path), identity: inspected.identity, size_bytes: inspected.size_bytes, sha256: inspected.sha256 });
}

async function components(rehearsalId: string, corpusId: string, databasePath: string): Promise<readonly DatabaseComponent[]> {
  return Object.freeze(await Promise.all((['database', 'journal', 'shm', 'wal'] as const).map(async (role) => await component(rehearsalId, corpusId, databasePath, role))));
}

function equalComponents(left: readonly DatabaseComponent[], right: readonly DatabaseComponent[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function copyStableDatabaseFiles(sourceDatabasePath: string, destinationDatabasePath: string, sourceComponents: readonly DatabaseComponent[]): Promise<void> {
  if (existsSync(destinationDatabasePath) || existsSync(`${destinationDatabasePath}-journal`) || existsSync(`${destinationDatabasePath}-wal`) || existsSync(`${destinationDatabasePath}-shm`)) throw new Error('C5 raw SQLite snapshot destination already exists');
  await mkdir(dirname(destinationDatabasePath), { recursive: true, mode: 0o700 });
  await copyRegularFileNoFollow(sourceDatabasePath, destinationDatabasePath, 0o600);
  const wal = sourceComponents.find((entry) => entry.role === 'wal');
  if (wal?.present === true) await copyRegularFileNoFollow(`${sourceDatabasePath}-wal`, `${destinationDatabasePath}-wal`, 0o600);
}

async function duplicateRawSnapshot(sourceDatabasePath: string, destinationDatabasePath: string): Promise<void> {
  await mkdir(dirname(destinationDatabasePath), { recursive: true, mode: 0o700 });
  await copyRegularFileNoFollow(sourceDatabasePath, destinationDatabasePath, 0o600);
  if (existsSync(`${sourceDatabasePath}-wal`)) await copyRegularFileNoFollow(`${sourceDatabasePath}-wal`, `${destinationDatabasePath}-wal`, 0o600);
}

export async function createCoherentSqliteSnapshot(input: {
  readonly rehearsal_id: string;
  readonly corpus_id: string;
  readonly source_database_path: string;
  readonly raw_snapshot_database_path: string;
  readonly copy_database_path: string;
  readonly expected_user_version: number;
  readonly observe_after_backup_before_source_recheck?: () => Promise<void> | void;
}): Promise<CoherentSqliteSnapshot> {
  for (const path of [input.raw_snapshot_database_path, input.copy_database_path]) {
    if (existsSync(path) || existsSync(`${path}-journal`) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) throw new Error('C5 SQLite snapshot destinations must be absent');
  }
  if (existsSync(`${input.source_database_path}-journal`)) throw new Error('C5 SQLite source retained a rollback journal and has no bounded WAL snapshot boundary');
  const sourceInfo = lstatSync(input.source_database_path);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('C5 SQLite snapshot source must be a physical regular file');
  const sourceComponentsBefore = await components(input.rehearsal_id, input.corpus_id, input.source_database_path);
  await copyStableDatabaseFiles(input.source_database_path, input.raw_snapshot_database_path, sourceComponentsBefore);
  const sourceComponentsAfterRawCopy = await components(input.rehearsal_id, input.corpus_id, input.source_database_path);
  if (!equalComponents(sourceComponentsBefore, sourceComponentsAfterRawCopy)) throw new Error('C5 SQLite source components drifted during raw read-only capture');

  const scratchRoot = join(dirname(input.copy_database_path), `.c5-sqlite-verify-${randomUUID()}`);
  const firstVerificationPath = join(scratchRoot, 'before.db');
  const secondVerificationPath = join(scratchRoot, 'after.db');
  let sourceLogicalBefore: SqliteLogicalDigest;
  let sourceLogicalAfter: SqliteLogicalDigest;
  try {
    await duplicateRawSnapshot(input.raw_snapshot_database_path, firstVerificationPath);
    sourceLogicalBefore = logicalSqliteDigest(firstVerificationPath);
    if (sourceLogicalBefore.user_version !== input.expected_user_version) throw new Error(`C5 SQLite source schema mismatch: expected ${String(input.expected_user_version)}, observed ${String(sourceLogicalBefore.user_version)}`);
    const snapshotSource = new DatabaseSync(firstVerificationPath, { readOnly: true, timeout: 30_000 });
    try {
      snapshotSource.exec('PRAGMA query_only=ON');
      await backup(snapshotSource, input.copy_database_path);
    } finally { snapshotSource.close(); }
    chmodSync(input.copy_database_path, 0o600);
    if (existsSync(`${input.copy_database_path}-journal`) || existsSync(`${input.copy_database_path}-wal`) || existsSync(`${input.copy_database_path}-shm`)) throw new Error('C5 SQLite backup retained a journal/WAL/SHM authority sidecar in the clone');
    await input.observe_after_backup_before_source_recheck?.();
    const sourceComponentsBeforeSecondCopy = await components(input.rehearsal_id, input.corpus_id, input.source_database_path);
    if (!equalComponents(sourceComponentsBefore, sourceComponentsBeforeSecondCopy)) throw new Error('C5 SQLite source components drifted during coherent snapshot');
    await copyStableDatabaseFiles(input.source_database_path, secondVerificationPath, sourceComponentsBeforeSecondCopy);
    const sourceComponentsAfterSecondCopy = await components(input.rehearsal_id, input.corpus_id, input.source_database_path);
    if (!equalComponents(sourceComponentsBefore, sourceComponentsAfterSecondCopy)) throw new Error('C5 SQLite source components drifted during second read-only capture');
    sourceLogicalAfter = logicalSqliteDigest(secondVerificationPath);
  } catch (error) {
    rmSync(input.copy_database_path, { force: true });
    throw error;
  } finally { rmSync(scratchRoot, { recursive: true, force: true }); }

  const copyLogical = logicalSqliteDigest(input.copy_database_path);
  const sourceComponentsAfter = await components(input.rehearsal_id, input.corpus_id, input.source_database_path);
  if (!equalComponents(sourceComponentsBefore, sourceComponentsAfter)) throw new Error('C5 SQLite source components drifted before snapshot publication');
  if (sourceLogicalBefore.logical_sha256 !== sourceLogicalAfter.logical_sha256 || sourceLogicalBefore.logical_sha256 !== copyLogical.logical_sha256) throw new Error('C5 SQLite logical state disagrees before/after raw capture or in the clone');
  const copyIdentities = [pathFileIdentity(input.raw_snapshot_database_path), pathFileIdentity(input.copy_database_path)];
  for (const copyIdentity of copyIdentities) {
    for (const sourceComponent of sourceComponentsBefore) {
      if (sourceComponent.identity !== null && sourceComponent.identity.device === copyIdentity.device && sourceComponent.identity.inode === copyIdentity.inode) throw new Error('C5 SQLite snapshot shares a source file identity');
    }
  }
  return Object.freeze({ source_components_before: sourceComponentsBefore, source_components_after: sourceComponentsAfter, source_logical_before: sourceLogicalBefore, source_logical_after: sourceLogicalAfter, copy_logical: copyLogical, copy_sha256: await hashRegularFile(input.copy_database_path) });
}
