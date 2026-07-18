import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { canonicalJson } from "./canonical-json.js";
import { CoordinationRuntimeError } from "./failures.js";
import { COORDINATOR_API_SCHEMA_VERSION, COORDINATOR_STORE_SCHEMA_VERSION, enforcePrivateAuthorityPath, ensureCoordinatorPrivateRoots } from "./runtime-paths.js";
export const COORDINATOR_STORE_GENERATION_SCHEMA = 'autopilot.coordinator_store_generation.v1';
export const COORDINATOR_STORE_POINTER_SCHEMA = 'autopilot.coordinator_store_pointer.v1';
export const COORDINATOR_FIXED_PATH_BARRIER_SCHEMA = 'autopilot.cf50_fixed_path_barrier.v1';
export const STORE_GENERATION_ID_PATTERN = /^generation-[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FIXED_BARRIER_TABLE = 'autopilot_s1_fixed_path_barrier';
const FIXED_BARRIER_MESSAGE = 'cf50 fixed store retired by S1 generation publication';
export const STORE_PUBLICATION_BOUNDARIES = [
    'staging-created',
    'source-checkpointed',
    'source-captured',
    'migration-complete',
    'integrity-verified',
    'database-fsynced',
    'publication-fsynced',
    'generation-renamed',
    'fixed-path-barrier-installed',
    'pointer-replaced',
    'coordinator-directory-fsynced',
];
function sha256Bytes(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function fileSha256(path) {
    return sha256Bytes(readFileSync(path));
}
function canonicalTimestamp(value, label) {
    if (typeof value !== 'string' || value.length !== 24)
        throw new CoordinationRuntimeError('store-corrupt', `${label} must be a canonical ISO timestamp`);
    try {
        if (new Date(value).toISOString() !== value)
            throw new Error('timestamp differs after canonicalization');
    }
    catch {
        throw new CoordinationRuntimeError('store-corrupt', `${label} must be a canonical ISO timestamp`);
    }
    return value;
}
function exactRecord(value, fields, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('store-corrupt', `${label} must be an object`);
    const record = value;
    const actual = Object.keys(record).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index]))
        throw new CoordinationRuntimeError('store-corrupt', `${label} fields are closed`, actual);
    return record;
}
function parseSha256(value, label) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value))
        throw new CoordinationRuntimeError('store-corrupt', `${label} is not a canonical SHA-256 digest`);
    return value;
}
function parseGenerationId(value, label) {
    if (typeof value !== 'string' || !STORE_GENERATION_ID_PATTERN.test(value))
        throw new CoordinationRuntimeError('store-corrupt', `${label} is not a generation address`);
    return value;
}
export function parseStoreGenerationPublication(value) {
    const label = 'CoordinatorStoreGenerationPublication';
    const record = exactRecord(value, ['created_at', 'generation_id', 'migration_checksums', 'publication_database_sha256', 'schema_version', 'source_database_sha256', 'source_generation_id', 'source_kind', 'store_schema_version'], label);
    if (record['schema_version'] !== COORDINATOR_STORE_GENERATION_SCHEMA || record['store_schema_version'] !== COORDINATOR_STORE_SCHEMA_VERSION)
        throw new CoordinationRuntimeError('store-corrupt', `${label} schema identity is invalid`);
    const sourceKind = record['source_kind'];
    if (sourceKind !== 'cf50-fixed-schema12' && sourceKind !== 's1-generation-restore')
        throw new CoordinationRuntimeError('store-corrupt', `${label}.source_kind is invalid`);
    const sourceGeneration = record['source_generation_id'];
    if (sourceGeneration !== null && (typeof sourceGeneration !== 'string' || !STORE_GENERATION_ID_PATTERN.test(sourceGeneration)))
        throw new CoordinationRuntimeError('store-corrupt', `${label}.source_generation_id is invalid`);
    if ((sourceKind === 'cf50-fixed-schema12') !== (sourceGeneration === null))
        throw new CoordinationRuntimeError('store-corrupt', `${label} source kind/generation identity is contradictory`);
    const checksums = record['migration_checksums'];
    if (!Array.isArray(checksums) || checksums.some((entry) => typeof entry !== 'string' || !/^[a-f0-9]{64}$/u.test(entry)))
        throw new CoordinationRuntimeError('store-corrupt', `${label}.migration_checksums is invalid`);
    return Object.freeze({
        schema_version: COORDINATOR_STORE_GENERATION_SCHEMA,
        generation_id: parseGenerationId(record['generation_id'], `${label}.generation_id`),
        store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION,
        source_kind: sourceKind,
        source_generation_id: sourceGeneration,
        source_database_sha256: parseSha256(record['source_database_sha256'], `${label}.source_database_sha256`),
        publication_database_sha256: parseSha256(record['publication_database_sha256'], `${label}.publication_database_sha256`),
        migration_checksums: Object.freeze([...checksums]),
        created_at: canonicalTimestamp(record['created_at'], `${label}.created_at`),
    });
}
export function parseStorePointer(value) {
    const label = 'CoordinatorStorePointer';
    const record = exactRecord(value, ['generation_id', 'previous_generation_id', 'publication_sha256', 'published_at', 'relative_generation_path', 'schema_version', 'store_schema_version'], label);
    if (record['schema_version'] !== COORDINATOR_STORE_POINTER_SCHEMA || record['store_schema_version'] !== COORDINATOR_STORE_SCHEMA_VERSION)
        throw new CoordinationRuntimeError('store-corrupt', `${label} schema identity is invalid`);
    const generationId = parseGenerationId(record['generation_id'], `${label}.generation_id`);
    const relativePath = record['relative_generation_path'];
    if (relativePath !== `stores/${generationId}` || isAbsolute(relativePath) || relativePath.split('/').includes('..'))
        throw new CoordinationRuntimeError('store-corrupt', `${label}.relative_generation_path is invalid`);
    const previous = record['previous_generation_id'];
    if (previous !== null && (typeof previous !== 'string' || !STORE_GENERATION_ID_PATTERN.test(previous) || previous === generationId))
        throw new CoordinationRuntimeError('store-corrupt', `${label}.previous_generation_id is invalid`);
    return Object.freeze({
        schema_version: COORDINATOR_STORE_POINTER_SCHEMA,
        generation_id: generationId,
        relative_generation_path: relativePath,
        store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION,
        publication_sha256: parseSha256(record['publication_sha256'], `${label}.publication_sha256`),
        previous_generation_id: previous,
        published_at: canonicalTimestamp(record['published_at'], `${label}.published_at`),
    });
}
function parseJsonBytes(bytes, path, label) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
    catch (error) {
        throw new CoordinationRuntimeError('store-corrupt', `${label} is unreadable or invalid JSON`, [path, error instanceof Error ? error.message : String(error)]);
    }
    return parsed;
}
function parseJsonFile(path, label) {
    return parseJsonBytes(readFileSync(path), path, label);
}
function assertOwnedPrivateObject(path, kind, requireSingleLink) {
    const metadata = lstatSync(path);
    const validKind = kind === 'file' ? metadata.isFile() : metadata.isDirectory();
    if (!validKind || metadata.isSymbolicLink())
        throw new CoordinationRuntimeError('system-fatal', `store generation ${kind} is a symbolic alias or wrong object kind`, [path]);
    if (requireSingleLink && metadata.nlink !== 1)
        throw new CoordinationRuntimeError('system-fatal', 'live store generation refuses hardlink aliases', [path, `link_count=${String(metadata.nlink)}`]);
    if (platform() !== 'win32') {
        const getuid = process.getuid;
        if (getuid !== undefined && metadata.uid !== getuid())
            throw new CoordinationRuntimeError('system-fatal', 'store generation owner differs from the coordinator process user', [path, `uid=${String(metadata.uid)}`]);
    }
}
function storeDatabaseFileIdentity(path) {
    assertOwnedPrivateObject(path, 'file', true);
    const metadata = lstatSync(path);
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}
function sameStoreDatabaseFileIdentity(left, right) {
    return left.device === right.device && left.inode === right.inode;
}
function assertContainedNoSymlinks(root, target) {
    const canonicalRoot = resolve(root);
    const canonicalTarget = resolve(target);
    const lexical = relative(canonicalRoot, canonicalTarget);
    if (lexical.length === 0 || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical))
        throw new CoordinationRuntimeError('system-fatal', 'store generation path escapes its private root', [canonicalRoot, canonicalTarget]);
    assertOwnedPrivateObject(canonicalRoot, 'directory', false);
    let current = canonicalRoot;
    for (const component of lexical.split(sep)) {
        current = join(current, component);
        if (existsSync(current)) {
            const info = lstatSync(current);
            if (info.isSymbolicLink())
                throw new CoordinationRuntimeError('system-fatal', 'store generation path contains a symlink segment', [current]);
        }
    }
    const physicalRoot = realpathSync(canonicalRoot);
    const existingTarget = existsSync(canonicalTarget) ? realpathSync(canonicalTarget) : realpathSync(join(canonicalTarget, '..'));
    const physical = relative(physicalRoot, existingTarget);
    if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical))
        throw new CoordinationRuntimeError('system-fatal', 'store generation path physically escapes its private root', [canonicalTarget]);
}
function syncFile(path) {
    const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
function syncDirectory(path) {
    if (platform() === 'win32')
        return;
    const descriptor = openSync(path, fsConstants.O_RDONLY);
    try {
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
function sqliteValue(row, field, label) {
    const value = row?.[field];
    if (value === undefined)
        throw new CoordinationRuntimeError('store-corrupt', `${label} omitted ${field}`);
    return value;
}
function verifyDatabase(path, schema) {
    assertOwnedPrivateObject(path, 'file', true);
    const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    try {
        const integrity = sqliteValue(database.prepare('PRAGMA integrity_check').get(), 'integrity_check', 'store integrity');
        const version = sqliteValue(database.prepare('PRAGMA user_version').get(), 'user_version', 'store schema');
        if (integrity !== 'ok' || version !== schema)
            throw new CoordinationRuntimeError('store-corrupt', 'store generation database integrity/schema identity is invalid', [path, `integrity=${String(integrity)}`, `schema=${String(version)}`]);
    }
    finally {
        database.close();
    }
}
function generationPaths(paths, generationId) {
    const directory = join(paths.storesRoot, generationId);
    return { directory, database: join(directory, 'coordinator.db'), publication: join(directory, 'publication.json') };
}
async function writeSyncedFile(path, body) {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await enforcePrivateAuthorityPath(path, false);
}
async function atomicReplacePointer(paths, pointer) {
    const body = `${canonicalJson(pointer)}\n`;
    const temporary = join(paths.coordinatorRoot, `.current-store.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`);
    try {
        await writeSyncedFile(temporary, body);
        await rename(temporary, paths.currentStorePointerPath);
        await enforcePrivateAuthorityPath(paths.currentStorePointerPath, false);
        return sha256Bytes(Buffer.from(body, 'utf8'));
    }
    finally {
        if (existsSync(temporary))
            await unlink(temporary);
    }
}
function readStableCurrentStoreGeneration(paths, verifyDatabaseContents) {
    if (!existsSync(paths.currentStorePointerPath))
        return null;
    assertContainedNoSymlinks(paths.coordinatorRoot, paths.currentStorePointerPath);
    assertOwnedPrivateObject(paths.currentStorePointerPath, 'file', true);
    const pointerBytes = readFileSync(paths.currentStorePointerPath);
    const pointerSha256 = sha256Bytes(pointerBytes);
    const pointer = parseStorePointer(parseJsonBytes(pointerBytes, paths.currentStorePointerPath, 'current store pointer'));
    const expectedRelative = `stores/${pointer.generation_id}`;
    if (pointer.relative_generation_path !== expectedRelative)
        throw new CoordinationRuntimeError('store-corrupt', 'store pointer generation path disagrees with its ID');
    const generation = generationPaths(paths, pointer.generation_id);
    assertContainedNoSymlinks(paths.coordinatorRoot, generation.directory);
    assertOwnedPrivateObject(generation.directory, 'directory', false);
    const databaseIdentity = storeDatabaseFileIdentity(generation.database);
    assertOwnedPrivateObject(generation.publication, 'file', true);
    const publicationBytes = readFileSync(generation.publication);
    if (sha256Bytes(publicationBytes) !== pointer.publication_sha256)
        throw new CoordinationRuntimeError('store-corrupt', 'store pointer publication digest is invalid', [generation.publication]);
    const publication = parseStoreGenerationPublication(parseJsonBytes(publicationBytes, generation.publication, 'store generation publication'));
    if (publication.generation_id !== pointer.generation_id || publication.store_schema_version !== pointer.store_schema_version)
        throw new CoordinationRuntimeError('store-corrupt', 'store generation publication identity disagrees with its pointer');
    if (publication.source_kind === 'cf50-fixed-schema12' && pointer.previous_generation_id !== null)
        throw new CoordinationRuntimeError('store-corrupt', 'first-generation publication has a contradictory predecessor pointer');
    if (publication.source_kind === 's1-generation-restore' && pointer.previous_generation_id !== publication.source_generation_id)
        throw new CoordinationRuntimeError('store-corrupt', 'restored generation source disagrees with its predecessor pointer');
    if (verifyDatabaseContents)
        verifyDatabase(generation.database, COORDINATOR_STORE_SCHEMA_VERSION);
    const finalDatabaseIdentity = storeDatabaseFileIdentity(generation.database);
    if (!sameStoreDatabaseFileIdentity(databaseIdentity, finalDatabaseIdentity)
        || sha256Bytes(readFileSync(paths.currentStorePointerPath)) !== pointerSha256
        || sha256Bytes(readFileSync(generation.publication)) !== pointer.publication_sha256) {
        throw new CoordinationRuntimeError('store-corrupt', 'store generation authority changed during verification');
    }
    return Object.freeze({
        pointer,
        pointer_sha256: pointerSha256,
        publication,
        generation_path: generation.directory,
        database_path: generation.database,
        database_file_identity: databaseIdentity,
        publication_path: generation.publication,
    });
}
/**
 * Reads only immutable pointer/publication bytes and live database inode
 * authority. Admission uses this bounded path; physical SQLite integrity and
 * the fixed barrier remain mandatory at startup/publication, not five times per
 * ordinary socket request.
 */
export function readCurrentStoreAdmissionGeneration(paths) {
    return readStableCurrentStoreGeneration(paths, false);
}
export function assertCurrentStoreGenerationAuthority(paths, expected) {
    const observed = readCurrentStoreAdmissionGeneration(paths);
    if (observed === null
        || observed.pointer_sha256 !== expected.pointer_sha256
        || observed.pointer.generation_id !== expected.pointer.generation_id
        || observed.pointer.publication_sha256 !== expected.pointer.publication_sha256
        || !sameStoreDatabaseFileIdentity(observed.database_file_identity, expected.database_file_identity)) {
        throw new CoordinationRuntimeError('store-corrupt', 'current store generation changed from the serving database authority');
    }
    return observed;
}
export function readCurrentStoreGeneration(paths) {
    const current = readStableCurrentStoreGeneration(paths, true);
    if (current === null)
        return null;
    verifyPublishedFixedBarrier(paths);
    assertCurrentStoreGenerationAuthority(paths, current);
    return current;
}
function quoteIdentifier(value) { return `"${value.replaceAll('"', '""')}"`; }
function barrierTriggerName(table, operation) {
    return `autopilot_s1_deny_${createHash('sha256').update(table, 'utf8').digest('hex').slice(0, 20)}_${operation.toLowerCase()}`;
}
function fixedBarrierRecord(database) {
    const exists = database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(FIXED_BARRIER_TABLE);
    if (exists === undefined)
        return null;
    const rows = database.prepare(`SELECT schema_version, source_database_sha256, generation_id, publication_sha256 FROM ${quoteIdentifier(FIXED_BARRIER_TABLE)}`).all();
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || row['schema_version'] !== COORDINATOR_FIXED_PATH_BARRIER_SCHEMA)
        throw new CoordinationRuntimeError('store-corrupt', 'fixed-path barrier record is malformed');
    return { source_database_sha256: parseSha256(row['source_database_sha256'], 'fixed barrier source digest'), generation_id: parseGenerationId(row['generation_id'], 'fixed barrier generation'), publication_sha256: parseSha256(row['publication_sha256'], 'fixed barrier publication digest') };
}
function verifyFixedBarrier(database, expected) {
    const version = sqliteValue(database.prepare('PRAGMA user_version').get(), 'user_version', 'fixed barrier schema');
    if (version !== COORDINATOR_API_SCHEMA_VERSION)
        throw new CoordinationRuntimeError('store-corrupt', 'fixed-path barrier does not retain API/schema-12 identity');
    const record = fixedBarrierRecord(database);
    if (record === null)
        throw new CoordinationRuntimeError('store-corrupt', 'fixed-path mutation-deny barrier is absent');
    if (expected !== undefined && canonicalJson(record) !== canonicalJson(expected))
        throw new CoordinationRuntimeError('store-corrupt', 'fixed-path barrier evidence disagrees with the published generation');
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => {
        const name = row['name'];
        if (typeof name !== 'string')
            throw new CoordinationRuntimeError('store-corrupt', 'fixed-path barrier found an invalid user table');
        return name;
    });
    for (const table of tables)
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
            const trigger = database.prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(barrierTriggerName(table, operation));
            if (trigger?.['tbl_name'] !== table || typeof trigger['sql'] !== 'string' || !trigger['sql'].includes(`RAISE(ABORT, '${FIXED_BARRIER_MESSAGE}')`))
                throw new CoordinationRuntimeError('store-corrupt', 'fixed-path barrier does not deny every user-table mutation', [table, operation]);
        }
    return record;
}
function installFixedBarrier(paths, evidence) {
    if (existsSync(`${paths.databasePath}-wal`) || existsSync(`${paths.databasePath}-shm`))
        throw new CoordinationRuntimeError('store-corrupt', 'fixed cf50 source retained WAL/SHM authority before barrier installation', [paths.databasePath]);
    const database = new DatabaseSync(paths.databasePath, { timeout: 10_000 });
    try {
        database.exec('PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE');
        const installed = fixedBarrierRecord(database);
        if (installed !== null) {
            verifyFixedBarrier(database, evidence);
            database.exec('ROLLBACK');
            return;
        }
        const version = sqliteValue(database.prepare('PRAGMA user_version').get(), 'user_version', 'fixed source schema');
        const integrity = sqliteValue(database.prepare('PRAGMA integrity_check').get(), 'integrity_check', 'fixed source integrity');
        if (version !== COORDINATOR_API_SCHEMA_VERSION || integrity !== 'ok')
            throw new CoordinationRuntimeError('store-corrupt', 'fixed cf50 source is not exact schema-12 integrity before barrier installation');
        if (fileSha256(paths.databasePath) !== evidence.source_database_sha256)
            throw new CoordinationRuntimeError('store-corrupt', 'fixed cf50 source changed after verified generation capture', [paths.databasePath]);
        database.exec(`CREATE TABLE ${quoteIdentifier(FIXED_BARRIER_TABLE)}(schema_version TEXT PRIMARY KEY, source_database_sha256 TEXT NOT NULL, generation_id TEXT NOT NULL, publication_sha256 TEXT NOT NULL) STRICT`);
        database.prepare(`INSERT INTO ${quoteIdentifier(FIXED_BARRIER_TABLE)}(schema_version, source_database_sha256, generation_id, publication_sha256) VALUES(?, ?, ?, ?)`).run(COORDINATOR_FIXED_PATH_BARRIER_SCHEMA, evidence.source_database_sha256, evidence.generation_id, evidence.publication_sha256);
        const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => {
            const name = row['name'];
            if (typeof name !== 'string')
                throw new CoordinationRuntimeError('store-corrupt', 'fixed source found an invalid user table');
            return name;
        });
        for (const table of tables)
            for (const operation of ['INSERT', 'UPDATE', 'DELETE'])
                database.exec(`CREATE TRIGGER ${quoteIdentifier(barrierTriggerName(table, operation))} BEFORE ${operation} ON ${quoteIdentifier(table)} BEGIN SELECT RAISE(ABORT, '${FIXED_BARRIER_MESSAGE}'); END`);
        verifyFixedBarrier(database, evidence);
        database.exec('COMMIT');
    }
    catch (error) {
        if (database.isTransaction)
            database.exec('ROLLBACK');
        throw error;
    }
    finally {
        database.close();
    }
    if (existsSync(`${paths.databasePath}-wal`) || existsSync(`${paths.databasePath}-shm`))
        throw new CoordinationRuntimeError('store-corrupt', 'fixed-path barrier publication retained WAL/SHM authority', [paths.databasePath]);
    syncFile(paths.databasePath);
    syncDirectory(paths.coordinatorRoot);
}
async function captureFixedSource(paths, target) {
    const source = new DatabaseSync(paths.databasePath, { timeout: 10_000 });
    let transaction = false;
    try {
        if (fixedBarrierRecord(source) !== null)
            throw new CoordinationRuntimeError('store-corrupt', 'fixed cf50 source was barriered before a complete generation became recoverable');
        source.exec('PRAGMA busy_timeout=10000');
        const checkpoint = source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint === undefined || checkpoint['busy'] !== 0)
            throw new CoordinationRuntimeError('store-corrupt', 'fixed cf50 source WAL checkpoint could not retire every reader/writer snapshot', [paths.databasePath, `busy=${String(checkpoint?.['busy'])}`]);
        const journal = source.prepare('PRAGMA journal_mode=DELETE').get();
        if (journal?.['journal_mode'] !== 'delete')
            throw new CoordinationRuntimeError('store-corrupt', 'fixed cf50 source did not retire WAL journal mode before capture', [paths.databasePath, String(journal?.['journal_mode'])]);
        if (existsSync(`${paths.databasePath}-wal`) || existsSync(`${paths.databasePath}-shm`))
            throw new CoordinationRuntimeError('store-corrupt', 'fixed cf50 source retained WAL/SHM after successful checkpoint retirement', [paths.databasePath]);
        source.exec('BEGIN EXCLUSIVE');
        transaction = true;
        const integrity = sqliteValue(source.prepare('PRAGMA integrity_check').get(), 'integrity_check', 'fixed source integrity');
        const version = sqliteValue(source.prepare('PRAGMA user_version').get(), 'user_version', 'fixed source schema');
        if (integrity !== 'ok' || version !== COORDINATOR_API_SCHEMA_VERSION)
            throw new CoordinationRuntimeError('schema-mismatch', 'S1 migration input must be exact cf50 schema 12', [`integrity=${String(integrity)}`, `schema=${String(version)}`]);
        const digest = fileSha256(paths.databasePath);
        copyFileSync(paths.databasePath, target, fsConstants.COPYFILE_EXCL);
        if (fileSha256(paths.databasePath) !== digest || fileSha256(target) !== digest)
            throw new CoordinationRuntimeError('store-corrupt', 'fixed cf50 source changed or diverged during exact generation capture', [paths.databasePath, target]);
        source.exec('ROLLBACK');
        transaction = false;
        return digest;
    }
    finally {
        if (transaction && source.isTransaction)
            source.exec('ROLLBACK');
        source.close();
    }
}
/** Any pointer or generation-shaped directory is durable S1 authority. Rollback
 * callers use this conservative probe so an orphaned-but-recoverable generation
 * can never be overwritten by a historical fixed-store restore. */
export async function storeGenerationPublicationPresent(paths) {
    if (existsSync(paths.currentStorePointerPath))
        return true;
    if (!existsSync(paths.storesRoot))
        return false;
    assertOwnedPrivateObject(paths.storesRoot, 'directory', false);
    return (await readdir(paths.storesRoot)).some((name) => STORE_GENERATION_ID_PATTERN.test(name));
}
/** Verify, rather than merely detect, the immutable schema-12 mutation barrier. */
export function fixedStoreBarrierPublished(paths) {
    if (!existsSync(paths.databasePath))
        return false;
    assertOwnedPrivateObject(paths.databasePath, 'file', true);
    const database = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 5_000 });
    try {
        const barrier = fixedBarrierRecord(database);
        if (barrier === null)
            return false;
        verifyFixedBarrier(database, barrier);
        return true;
    }
    finally {
        database.close();
    }
}
function verifyPublishedFixedBarrier(paths) {
    if (!existsSync(paths.databasePath))
        throw new CoordinationRuntimeError('store-corrupt', 'published S1 authority has no fixed-path schema-12 barrier');
    const fixed = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 5_000 });
    let barrier;
    try {
        barrier = verifyFixedBarrier(fixed);
    }
    finally {
        fixed.close();
    }
    const generation = generationPaths(paths, barrier.generation_id);
    assertContainedNoSymlinks(paths.coordinatorRoot, generation.directory);
    assertOwnedPrivateObject(generation.directory, 'directory', false);
    assertOwnedPrivateObject(generation.database, 'file', true);
    assertOwnedPrivateObject(generation.publication, 'file', true);
    const publicationBytes = readFileSync(generation.publication);
    if (sha256Bytes(publicationBytes) !== barrier.publication_sha256)
        throw new CoordinationRuntimeError('store-corrupt', 'fixed-path barrier publication digest is not recoverable');
    const publication = parseStoreGenerationPublication(parseJsonFile(generation.publication, 'fixed barrier source publication'));
    if (publication.generation_id !== barrier.generation_id || publication.source_kind !== 'cf50-fixed-schema12' || publication.source_generation_id !== null || publication.source_database_sha256 !== barrier.source_database_sha256)
        throw new CoordinationRuntimeError('store-corrupt', 'fixed-path barrier evidence disagrees with its first publication');
    verifyDatabase(generation.database, COORDINATOR_STORE_SCHEMA_VERSION);
    return barrier;
}
async function recoverBarrieredFirstPublication(paths, writerGuard, options) {
    if (!existsSync(paths.databasePath))
        return null;
    const fixed = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 5_000 });
    let barrier;
    try {
        barrier = fixedBarrierRecord(fixed);
        if (barrier !== null)
            verifyFixedBarrier(fixed, barrier);
    }
    finally {
        fixed.close();
    }
    if (barrier === null)
        return null;
    const candidates = [];
    for (const name of await readdir(paths.storesRoot)) {
        if (!STORE_GENERATION_ID_PATTERN.test(name))
            continue;
        const generation = generationPaths(paths, name);
        if (!existsSync(generation.publication) || !existsSync(generation.database))
            continue;
        const publicationBytes = readFileSync(generation.publication);
        const publication = parseStoreGenerationPublication(parseJsonFile(generation.publication, 'orphan generation publication'));
        if (publication.generation_id !== name || name !== barrier.generation_id || sha256Bytes(publicationBytes) !== barrier.publication_sha256 || publication.source_database_sha256 !== barrier.source_database_sha256)
            continue;
        const pointer = { schema_version: COORDINATOR_STORE_POINTER_SCHEMA, generation_id: name, relative_generation_path: `stores/${name}`, store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION, publication_sha256: barrier.publication_sha256, previous_generation_id: null, published_at: (options.now ?? (() => new Date()))().toISOString() };
        candidates.push(Object.freeze({ pointer, publication, generation_path: generation.directory, database_path: generation.database, publication_path: generation.publication }));
    }
    if (candidates.length !== 1)
        throw new CoordinationRuntimeError('store-corrupt', 'barriered fixed source has an ambiguous or missing complete first generation', [`candidate_count=${String(candidates.length)}`]);
    const candidate = candidates[0];
    if (candidate === undefined)
        throw new CoordinationRuntimeError('store-corrupt', 'barrier recovery candidate disappeared');
    verifyDatabase(candidate.database_path, COORDINATOR_STORE_SCHEMA_VERSION);
    if (fileSha256(candidate.database_path) !== candidate.publication.publication_database_sha256)
        throw new CoordinationRuntimeError('store-corrupt', 'barrier recovery generation database disagrees with its immutable publication hash', [candidate.database_path]);
    writerGuard.assertHeld();
    await atomicReplacePointer(paths, candidate.pointer);
    await options.onBoundary?.('pointer-replaced');
    syncDirectory(paths.coordinatorRoot);
    await options.onBoundary?.('coordinator-directory-fsynced');
    const recovered = readCurrentStoreGeneration(paths);
    if (recovered === null)
        throw new CoordinationRuntimeError('store-corrupt', 'recovered store pointer disappeared');
    return recovered;
}
export async function publishRestoredStoreGeneration(paths, writerGuard, sourceDatabasePath, sourceDatabaseSha256, sourceGenerationId, migration, options = {}) {
    writerGuard.assertHeldFor(paths);
    await ensureCoordinatorPrivateRoots(paths);
    const current = readCurrentStoreGeneration(paths);
    if (current === null || current.pointer.generation_id !== sourceGenerationId)
        throw new CoordinationRuntimeError('store-corrupt', 'restore source generation is not the exact current generation authority', [sourceGenerationId, current?.pointer.generation_id ?? 'missing']);
    const sourcePath = resolve(sourceDatabasePath);
    assertOwnedPrivateObject(sourcePath, 'file', true);
    if (!SHA256_PATTERN.test(sourceDatabaseSha256) || fileSha256(sourcePath) !== sourceDatabaseSha256)
        throw new CoordinationRuntimeError('store-corrupt', 'restore source digest does not match its verified backup evidence', [sourcePath]);
    if (existsSync(`${sourcePath}-wal`) || existsSync(`${sourcePath}-shm`))
        throw new CoordinationRuntimeError('store-corrupt', 'restore source carries foreign WAL/SHM components', [sourcePath]);
    const sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
    let sourceSchema;
    try {
        const integrity = sqliteValue(sourceDatabase.prepare('PRAGMA integrity_check').get(), 'integrity_check', 'restore source integrity');
        const version = sqliteValue(sourceDatabase.prepare('PRAGMA user_version').get(), 'user_version', 'restore source schema');
        if (integrity !== 'ok' || typeof version !== 'number' || !Number.isSafeInteger(version) || version !== COORDINATOR_API_SCHEMA_VERSION && version !== COORDINATOR_STORE_SCHEMA_VERSION)
            throw new CoordinationRuntimeError('store-corrupt', 'restore source must be exact schema 12 or schema 13 with physical integrity', [sourcePath, `integrity=${String(integrity)}`, `schema=${String(version)}`]);
        sourceSchema = version;
    }
    finally {
        sourceDatabase.close();
    }
    const generationId = `generation-${randomBytes(16).toString('hex')}`;
    const final = generationPaths(paths, generationId);
    const stagingDirectory = join(paths.storesRoot, `.staging-${generationId}`);
    assertContainedNoSymlinks(paths.coordinatorRoot, stagingDirectory);
    await mkdir(stagingDirectory, { mode: 0o700 });
    await enforcePrivateAuthorityPath(stagingDirectory, true);
    await options.onBoundary?.('staging-created');
    const stagingDatabase = join(stagingDirectory, 'coordinator.db');
    const stagingPublication = join(stagingDirectory, 'publication.json');
    try {
        const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 10_000 });
        try {
            await backup(source, stagingDatabase);
        }
        finally {
            source.close();
        }
        if (fileSha256(sourcePath) !== sourceDatabaseSha256)
            throw new CoordinationRuntimeError('store-corrupt', 'restore source changed during fresh-generation capture', [sourcePath]);
        await enforcePrivateAuthorityPath(stagingDatabase, false);
        await options.onBoundary?.('source-captured');
        const migrationChecksums = sourceSchema === COORDINATOR_API_SCHEMA_VERSION
            ? await migration.migrateSchema12To13(stagingDatabase)
            : current.publication.migration_checksums;
        if (sourceSchema === COORDINATOR_API_SCHEMA_VERSION)
            await options.onBoundary?.('migration-complete');
        await migration.verifySchema13(stagingDatabase);
        verifyDatabase(stagingDatabase, COORDINATOR_STORE_SCHEMA_VERSION);
        if (existsSync(`${stagingDatabase}-wal`) || existsSync(`${stagingDatabase}-shm`))
            throw new CoordinationRuntimeError('store-corrupt', 'restored staging generation retained foreign WAL/SHM', [stagingDatabase]);
        await options.onBoundary?.('integrity-verified');
        syncFile(stagingDatabase);
        await options.onBoundary?.('database-fsynced');
        const publication = {
            schema_version: COORDINATOR_STORE_GENERATION_SCHEMA,
            generation_id: generationId,
            store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION,
            source_kind: 's1-generation-restore',
            source_generation_id: sourceGenerationId,
            source_database_sha256: sourceDatabaseSha256,
            publication_database_sha256: fileSha256(stagingDatabase),
            migration_checksums: Object.freeze([...migrationChecksums]),
            created_at: (options.now ?? (() => new Date()))().toISOString(),
        };
        await writeSyncedFile(stagingPublication, `${canonicalJson(publication)}\n`);
        await options.onBoundary?.('publication-fsynced');
        syncDirectory(stagingDirectory);
        writerGuard.assertHeld();
        await rename(stagingDirectory, final.directory);
        syncDirectory(paths.storesRoot);
        await options.onBoundary?.('generation-renamed');
        writerGuard.assertHeld();
        const pointer = {
            schema_version: COORDINATOR_STORE_POINTER_SCHEMA,
            generation_id: generationId,
            relative_generation_path: `stores/${generationId}`,
            store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION,
            publication_sha256: fileSha256(final.publication),
            previous_generation_id: sourceGenerationId,
            published_at: (options.now ?? (() => new Date()))().toISOString(),
        };
        await atomicReplacePointer(paths, pointer);
        await options.onBoundary?.('pointer-replaced');
        writerGuard.assertHeld();
        syncDirectory(paths.coordinatorRoot);
        await options.onBoundary?.('coordinator-directory-fsynced');
        const restored = readCurrentStoreGeneration(paths);
        if (restored === null)
            throw new CoordinationRuntimeError('store-corrupt', 'restored current store pointer disappeared');
        return restored;
    }
    catch (error) {
        if (existsSync(stagingDirectory))
            await rm(stagingDirectory, { recursive: true, force: true });
        throw error;
    }
}
export async function ensureCurrentStoreGeneration(paths, writerGuard, migration, options = {}) {
    writerGuard.assertHeldFor(paths);
    await ensureCoordinatorPrivateRoots(paths);
    assertContainedNoSymlinks(paths.coordinatorRoot, paths.storesRoot);
    for (const name of await readdir(paths.coordinatorRoot)) {
        if (!/^\.current-store\.\d+\.[a-f0-9]{16}\.tmp$/u.test(name))
            continue;
        const stalePointer = join(paths.coordinatorRoot, name);
        assertContainedNoSymlinks(paths.coordinatorRoot, stalePointer);
        assertOwnedPrivateObject(stalePointer, 'file', true);
        await unlink(stalePointer);
    }
    for (const name of await readdir(paths.storesRoot)) {
        if (!/^\.staging-generation-[a-f0-9]{32}$/u.test(name))
            continue;
        const staleStaging = join(paths.storesRoot, name);
        assertContainedNoSymlinks(paths.coordinatorRoot, staleStaging);
        assertOwnedPrivateObject(staleStaging, 'directory', false);
        await rm(staleStaging, { recursive: true, force: true });
    }
    const current = readCurrentStoreGeneration(paths);
    if (current !== null)
        return current;
    const recovered = await recoverBarrieredFirstPublication(paths, writerGuard, options);
    if (recovered !== null)
        return recovered;
    if (!existsSync(paths.databasePath)) {
        await migration.prepareFreshSchema12(paths.databasePath);
        await enforcePrivateAuthorityPath(paths.databasePath, false);
        syncFile(paths.databasePath);
        syncDirectory(paths.coordinatorRoot);
    }
    const generationId = `generation-${randomBytes(16).toString('hex')}`;
    const final = generationPaths(paths, generationId);
    const stagingDirectory = join(paths.storesRoot, `.staging-${generationId}`);
    assertContainedNoSymlinks(paths.coordinatorRoot, stagingDirectory);
    await mkdir(stagingDirectory, { mode: 0o700 });
    await enforcePrivateAuthorityPath(stagingDirectory, true);
    await options.onBoundary?.('staging-created');
    const stagingDatabase = join(stagingDirectory, 'coordinator.db');
    const stagingPublication = join(stagingDirectory, 'publication.json');
    try {
        const sourceDatabaseSha256 = await captureFixedSource(paths, stagingDatabase);
        await enforcePrivateAuthorityPath(stagingDatabase, false);
        await options.onBoundary?.('source-checkpointed');
        await options.onBoundary?.('source-captured');
        const migrationChecksums = await migration.migrateSchema12To13(stagingDatabase);
        await options.onBoundary?.('migration-complete');
        await migration.verifySchema13(stagingDatabase);
        verifyDatabase(stagingDatabase, COORDINATOR_STORE_SCHEMA_VERSION);
        if (existsSync(`${stagingDatabase}-wal`) || existsSync(`${stagingDatabase}-shm`))
            throw new CoordinationRuntimeError('store-corrupt', 'staging generation retained WAL/SHM after migration checkpoint', [stagingDatabase]);
        await options.onBoundary?.('integrity-verified');
        syncFile(stagingDatabase);
        await options.onBoundary?.('database-fsynced');
        const publication = {
            schema_version: COORDINATOR_STORE_GENERATION_SCHEMA,
            generation_id: generationId,
            store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION,
            source_kind: 'cf50-fixed-schema12',
            source_generation_id: null,
            source_database_sha256: sourceDatabaseSha256,
            publication_database_sha256: fileSha256(stagingDatabase),
            migration_checksums: Object.freeze([...migrationChecksums]),
            created_at: (options.now ?? (() => new Date()))().toISOString(),
        };
        await writeSyncedFile(stagingPublication, `${canonicalJson(publication)}\n`);
        await options.onBoundary?.('publication-fsynced');
        syncDirectory(stagingDirectory);
        writerGuard.assertHeld();
        await rename(stagingDirectory, final.directory);
        syncDirectory(paths.storesRoot);
        await options.onBoundary?.('generation-renamed');
        writerGuard.assertHeld();
        const publicationSha256 = fileSha256(final.publication);
        installFixedBarrier(paths, { source_database_sha256: sourceDatabaseSha256, generation_id: generationId, publication_sha256: publicationSha256 });
        await options.onBoundary?.('fixed-path-barrier-installed');
        writerGuard.assertHeld();
        const pointer = {
            schema_version: COORDINATOR_STORE_POINTER_SCHEMA,
            generation_id: generationId,
            relative_generation_path: `stores/${generationId}`,
            store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION,
            publication_sha256: publicationSha256,
            previous_generation_id: null,
            published_at: (options.now ?? (() => new Date()))().toISOString(),
        };
        await atomicReplacePointer(paths, pointer);
        await options.onBoundary?.('pointer-replaced');
        writerGuard.assertHeld();
        syncDirectory(paths.coordinatorRoot);
        await options.onBoundary?.('coordinator-directory-fsynced');
        const published = readCurrentStoreGeneration(paths);
        if (published === null)
            throw new CoordinationRuntimeError('store-corrupt', 'published current store pointer disappeared');
        return published;
    }
    catch (error) {
        if (existsSync(stagingDirectory))
            await rm(stagingDirectory, { recursive: true, force: true });
        throw error;
    }
}
