import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { copyFile, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { parseCoordinationUnitAttempt, parseCoordinationWorktreeOperation } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { CoordinatorFrameDecoder, AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, encodeCoordinatorFrame } from "./ipc.js";
import { isExactProcessAlive, isProcessAlive, predecessorCompatibleBootId, preflightProcessRetirementSupport, processStartIdentity, retireExactProcess } from "./process-identity.js";
import { coordinatorRuntimePaths, enforcePrivateAuthorityPath, ensureCoordinatorPrivateRoots, ensurePrivateAuthorityDirectory } from "./runtime-paths.js";
import { acquireSerializedProcessGuard, discardLockTombstone, quarantineExactLock, readExactLockText } from "./serialized-lock.js";
import { CoordinatorStore, upgradeVerifiedPrivateSchema6CopyToSchema12 } from "./store.js";
import { COORDINATOR_UPGRADE_INTENT_SCHEMA, COORDINATOR_UPGRADE_PATH, parseCoordinatorUpgradeIntent, parseKnownCoordinatorUpgradeIntent, parseCurrentCoordinatorLock, parsePredecessorCoordinatorLock, parsePredecessorStatusEnvelope, } from "./upgrade-contracts.js";
const UPGRADE_DRAIN_TIMEOUT_MS = 2_000;
const UPGRADE_POLL_MS = 50;
const TERMINAL_OPERATION_STAGES = new Set(['committed', 'compensated', 'failed']);
const EMPTY_UPGRADE_PAYLOAD = Object.freeze({});
/** Deliberately newer than every package schema; aa3e377 rejects it before authority opens. */
export const COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION = 2_147_483_000;
function failureMessage(error) { return error instanceof Error ? error.message : String(error); }
export function coordinatorUpgradeIntentPath(paths) { return join(paths.coordinatorRoot, 'upgrade-intent.json'); }
function upgradeRoot(paths) { return join(paths.coordinatorRoot, 'upgrades'); }
function sleep(ms) { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }
async function unlinkIfExists(path) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return;
        throw error;
    }
}
async function fsyncDirectory(path) {
    if (platform() === 'win32')
        return;
    const directory = await open(path, 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
async function atomicWriteJson(path, value) {
    const validated = parseCoordinatorUpgradeIntent(value);
    await ensurePrivateAuthorityDirectory(dirname(path));
    const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await enforcePrivateAuthorityPath(temporary, false);
    await rename(temporary, path);
    await enforcePrivateAuthorityPath(path, false);
    await fsyncDirectory(dirname(path));
}
async function readRawCoordinatorUpgradeIntent(paths) {
    try {
        return JSON.parse(await readFile(coordinatorUpgradeIntentPath(paths), 'utf8'));
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return null;
        if (error instanceof SyntaxError)
            throw new CoordinationRuntimeError('schema-mismatch', 'durable coordinator upgrade intent contains invalid JSON', [coordinatorUpgradeIntentPath(paths)]);
        throw error;
    }
}
/** Exact local intent reader for every writable upgrade transition. */
export async function readCoordinatorUpgradeIntent(paths) {
    const raw = await readRawCoordinatorUpgradeIntent(paths);
    return raw === null ? null : parseCoordinatorUpgradeIntent(raw);
}
/**
 * Runtime reader admits historical targets only as immutable known lineage.
 * Callers may observe them, but only a committed historical intent is inert.
 */
export async function readKnownCoordinatorUpgradeIntent(paths) {
    const raw = await readRawCoordinatorUpgradeIntent(paths);
    return raw === null ? null : parseKnownCoordinatorUpgradeIntent(raw);
}
async function readLock(path, label) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        throw new CoordinationRuntimeError('protocol-mismatch', `${label} is unreadable; refusing replacement`, [failureMessage(error)]);
    }
}
function samePredecessor(left, right) {
    return left.pid === right.pid && left.boot_id === right.boot_id && left.token === right.token && left.started_at === right.started_at;
}
function connectSocket(path, timeoutMs) {
    return new Promise((resolveConnect, rejectConnect) => {
        const socket = connect(path);
        const timer = setTimeout(() => { socket.destroy(); rejectConnect(new CoordinationRuntimeError('request-timeout', 'predecessor upgrade probe timed out while connecting')); }, timeoutMs);
        const onError = (error) => { clearTimeout(timer); rejectConnect(error); };
        socket.once('error', onError);
        socket.once('connect', () => { clearTimeout(timer); socket.off('error', onError); resolveConnect(socket); });
    });
}
async function predecessorStatus(paths, capability, repoId, workstreamRun, timeoutMs) {
    const requestId = `upgrade-status-${randomUUID()}`;
    const request = { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.2', request_id: requestId, action: 'status', idempotency_key: null, repo_id: repoId, workstream_run: workstreamRun, session_id: null, fencing_generation: null, expected_version: null, payload: EMPTY_UPGRADE_PAYLOAD };
    const socket = await connectSocket(paths.predecessorSocketPath, timeoutMs);
    const decoder = new CoordinatorFrameDecoder();
    return await new Promise((resolveStatus, rejectStatus) => {
        let settled = false;
        const fail = (error) => { if (settled)
            return; settled = true; clearTimeout(timer); socket.destroy(); rejectStatus(error instanceof Error ? error : new Error(String(error))); };
        const timer = setTimeout(() => fail(new CoordinationRuntimeError('request-timeout', 'authenticated predecessor status probe timed out')), timeoutMs);
        socket.on('data', (chunk) => {
            try {
                const frames = decoder.push(chunk);
                if (frames.length === 0)
                    return;
                const status = parsePredecessorStatusEnvelope(frames[0], requestId);
                settled = true;
                clearTimeout(timer);
                socket.end();
                resolveStatus(status);
            }
            catch (error) {
                fail(error);
            }
        });
        socket.once('error', fail);
        socket.once('close', () => { if (!settled)
            fail(new CoordinationRuntimeError('coordinator-unavailable', 'predecessor closed the authenticated status probe without a response')); });
        socket.write(encodeCoordinatorFrame({ transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability, request }), (error) => { if (error !== null && error !== undefined)
            fail(error); });
    });
}
function readiness(statuses) {
    const blockers = [];
    const drainable = [];
    const safeCheckpoints = [];
    for (const status of statuses) {
        for (const operation of status.worktree_operations)
            if (!TERMINAL_OPERATION_STAGES.has(operation.stage))
                blockers.push(`worktree-operation:${operation.operation_id}:${operation.stage}`);
        for (const attempt of status.unit_attempts) {
            if (attempt.state !== 'running')
                continue;
            const identity = `${attempt.owner.repo_id}/${attempt.owner.workstream_run}/${attempt.owner.unit_id}:${String(attempt.owner.attempt)}`;
            if (attempt.critical_section !== null)
                blockers.push(`critical-section:${identity}:${attempt.critical_section}`);
            else if (!attempt.preemptible)
                blockers.push(`non-preemptible:${identity}`);
            else if (attempt.checkpoint_ordinal < 1)
                drainable.push(`awaiting-checkpoint:${identity}`);
            else
                safeCheckpoints.push(`${identity}@${String(attempt.checkpoint_ordinal)}`);
        }
    }
    return { blockers: Object.freeze(blockers.sort()), drainable: Object.freeze(drainable.sort()), safeCheckpoints: Object.freeze(safeCheckpoints.sort()) };
}
async function authenticatedReadiness(paths, capability, timeoutMs) {
    const global = await predecessorStatus(paths, capability, 'global', null, timeoutMs);
    const statuses = [global];
    for (const run of global.runs.filter((entry) => entry.status !== 'closed' && entry.status !== 'aborted'))
        statuses.push(await predecessorStatus(paths, capability, run.repo_id, run.workstream_run, timeoutMs));
    return readiness(statuses);
}
function parseJsonPayload(value, label) {
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('store-corrupt', `${label} is not serialized JSON`);
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch (error) {
        throw new CoordinationRuntimeError('store-corrupt', `${label} contains invalid JSON`, [failureMessage(error)]);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new CoordinationRuntimeError('store-corrupt', `${label} is not an object`);
    return parsed;
}
function databaseReadiness(database) {
    const integrity = database.prepare('PRAGMA integrity_check').get()?.['integrity_check'];
    const version = database.prepare('PRAGMA user_version').get()?.['user_version'];
    if (integrity !== 'ok')
        throw new CoordinationRuntimeError('store-corrupt', 'predecessor database failed quiescent integrity check');
    if (version !== 6)
        throw new CoordinationRuntimeError('schema-mismatch', 'predecessor database is not exact schema 6');
    const attempts = database.prepare('SELECT payload_json FROM unit_attempts ORDER BY entity_id').all().map((row, index) => parseCoordinationUnitAttempt(parseJsonPayload(row['payload_json'], `unit_attempts[${String(index)}]`)));
    const operations = database.prepare('SELECT payload_json FROM worktree_operations ORDER BY entity_id').all().map((row, index) => parseCoordinationWorktreeOperation(parseJsonPayload(row['payload_json'], `worktree_operations[${String(index)}]`)));
    return readiness([{ package_build: COORDINATOR_UPGRADE_PATH.source.package_build, protocol_version: '1.2', database_schema_version: 6, runs: [], unit_attempts: attempts, worktree_operations: operations }]);
}
function quiescentDatabaseReadiness(databasePath) {
    const database = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
        return databaseReadiness(database);
    }
    finally {
        database.close();
    }
}
function acquireExclusiveWriterBarrier(paths, acceptInstalledBarrier = false) {
    const database = new DatabaseSync(paths.databasePath, { timeout: 10_000 });
    try {
        database.exec('PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE');
        const version = Number(database.prepare('PRAGMA user_version').get()?.['user_version']);
        if (version === 6)
            databaseReadiness(database);
        else if (!acceptInstalledBarrier || version !== COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION)
            throw new CoordinationRuntimeError('schema-mismatch', 'writer-barrier acquisition requires exact schema 6 or its installed incompatible barrier');
        return database;
    }
    catch (error) {
        if (database.isTransaction)
            database.exec('ROLLBACK');
        database.close();
        throw error;
    }
}
function closeWriterBarrier(database, committed) {
    try {
        if (!committed && database.isTransaction)
            database.exec('ROLLBACK');
    }
    finally {
        database.close();
    }
}
async function writeIntent(paths, intent, state, changes = {}) {
    const next = parseCoordinatorUpgradeIntent({ ...intent, ...changes, state, updated_at: new Date().toISOString() });
    await atomicWriteJson(coordinatorUpgradeIntentPath(paths), next);
    return next;
}
async function verifyAndRecordBackup(target, expectedDigest) {
    await enforcePrivateAuthorityPath(target, false);
    const targetHandle = await open(target, 'r');
    try {
        await targetHandle.sync();
    }
    finally {
        await targetHandle.close();
    }
    const bytes = await readFile(target);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (expectedDigest !== undefined && digest !== expectedDigest)
        throw new CoordinationRuntimeError('store-corrupt', 'deterministic final upgrade backup digest does not match the committed migration barrier', [target, `expected=${expectedDigest}`, `actual=${digest}`]);
    const verified = new DatabaseSync(target, { readOnly: true });
    try {
        const integrity = verified.prepare('PRAGMA integrity_check').get()?.['integrity_check'];
        const version = verified.prepare('PRAGMA user_version').get()?.['user_version'];
        if (integrity !== 'ok' || version !== 6)
            throw new CoordinationRuntimeError('store-corrupt', 'SQLite backup did not preserve exact schema-6 integrity', [`integrity=${String(integrity)}`, `schema=${String(version)}`]);
    }
    finally {
        verified.close();
    }
    await fsyncDirectory(dirname(target));
    return { schema_version: 'autopilot.coordinator_upgrade_backup.v1', path: target, sha256: digest, source_database_schema_version: 6, integrity: 'ok', created_at: new Date().toISOString() };
}
async function createVerifiedBackup(paths, upgradeId) {
    await ensurePrivateAuthorityDirectory(paths.backupsRoot);
    const target = join(paths.backupsRoot, `coordinator.preflight.pre-upgrade-1.2-to-1.6.${upgradeId}.db`);
    await unlink(target).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error; });
    const source = new DatabaseSync(paths.databasePath, { timeout: 5_000 });
    try {
        const integrity = source.prepare('PRAGMA integrity_check').get()?.['integrity_check'];
        const version = source.prepare('PRAGMA user_version').get()?.['user_version'];
        if (integrity !== 'ok' || version !== 6)
            throw new CoordinationRuntimeError('store-corrupt', 'upgrade source is not exact schema-6 integrity', [`integrity=${String(integrity)}`, `schema=${String(version)}`]);
        await backup(source, target);
    }
    finally {
        source.close();
    }
    return await verifyAndRecordBackup(target);
}
function finalUpgradeBackupPath(paths, upgradeId) {
    return join(paths.backupsRoot, `coordinator.final.pre-upgrade-1.2-to-1.6.${upgradeId}.db`);
}
async function createVerifiedLockedBoundaryBackup(paths, upgradeId, database) {
    await ensurePrivateAuthorityDirectory(paths.backupsRoot);
    databaseReadiness(database);
    const target = finalUpgradeBackupPath(paths, upgradeId);
    await unlink(target).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error; });
    // node:sqlite backup() cannot use the connection that owns an active
    // transaction, and DatabaseSync.serialize() is unavailable on supported
    // Node 22. Open a distinct read snapshot after BEGIN EXCLUSIVE: the outer
    // writer transaction has made no changes yet, prevents every competing
    // writer, and WAL readers see the exact committed schema-6 boundary.
    const snapshot = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 10_000 });
    try {
        const mode = snapshot.prepare('PRAGMA journal_mode').get()?.['journal_mode'];
        if (mode !== 'wal')
            throw new CoordinationRuntimeError('schema-mismatch', 'locked upgrade backup requires WAL snapshot isolation', [`journal_mode=${String(mode)}`]);
        await backup(snapshot, target);
    }
    finally {
        snapshot.close();
    }
    return await verifyAndRecordBackup(target);
}
async function verifyBackup(record) {
    await enforcePrivateAuthorityPath(record.path, false);
    const bytes = await readFile(record.path);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== record.sha256)
        throw new CoordinationRuntimeError('store-corrupt', 'verified upgrade backup digest changed', [record.path]);
    const database = new DatabaseSync(record.path, { readOnly: true });
    try {
        if (database.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok' || database.prepare('PRAGMA user_version').get()?.['user_version'] !== 6)
            throw new CoordinationRuntimeError('store-corrupt', 'verified upgrade backup no longer has exact schema-6 integrity');
    }
    finally {
        database.close();
    }
}
async function migratedPrivateDatabasePath(paths, upgradeId) {
    return join(upgradeRoot(paths), upgradeId, 'target-state', 'coordinator', 'coordinator.db');
}
async function verifyMigrationOnCopy(paths, record, upgradeId, retain = false) {
    const root = join(upgradeRoot(paths), upgradeId, retain ? 'target-state' : 'migration-probe-state');
    await rm(root, { recursive: true, force: true });
    const probePaths = coordinatorRuntimePaths({ ...process.env, AUTOPILOT_STATE_ROOT: root });
    await ensureCoordinatorPrivateRoots(probePaths);
    await copyFile(record.path, probePaths.databasePath, fsConstants.COPYFILE_EXCL);
    await enforcePrivateAuthorityPath(probePaths.databasePath, false);
    let store = null;
    try {
        await upgradeVerifiedPrivateSchema6CopyToSchema12(probePaths, record.sha256);
        store = await CoordinatorStore.open(probePaths);
        if (store.integrity() !== 'ok')
            throw new CoordinationRuntimeError('store-corrupt', 'schema migration probe failed integrity');
        const status = store.status('global', null).payload;
        if (status['package_build'] !== COORDINATOR_UPGRADE_PATH.target.package_build || status['protocol_version'] !== COORDINATOR_UPGRADE_PATH.target.protocol_version || status['database_schema_version'] !== COORDINATOR_UPGRADE_PATH.target.database_schema_version)
            throw new CoordinationRuntimeError('schema-mismatch', 'schema migration probe did not reach the locked target identity');
    }
    finally {
        store?.close();
    }
    const checkpoint = new DatabaseSync(probePaths.databasePath, { timeout: 5_000 });
    try {
        checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        if (checkpoint.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok' || checkpoint.prepare('PRAGMA user_version').get()?.['user_version'] !== COORDINATOR_UPGRADE_PATH.target.database_schema_version)
            throw new CoordinationRuntimeError('store-corrupt', 'private migrated target failed final target-schema verification');
    }
    finally {
        checkpoint.close();
    }
    await unlinkIfExists(`${probePaths.databasePath}-wal`);
    await unlinkIfExists(`${probePaths.databasePath}-shm`);
    const handle = await open(probePaths.databasePath, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await fsyncDirectory(dirname(probePaths.databasePath));
    if (!retain)
        await rm(root, { recursive: true, force: true });
    return probePaths.databasePath;
}
async function waitForExactRetirement(pid, processIdentity, deadline) {
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid))
            return;
        const observedIdentity = processStartIdentity(pid);
        // A signalled macOS process can remain as an unreaped PID while libproc no
        // longer exposes BSD info. Null is not stale/reuse proof: wait fail-closed.
        if (observedIdentity !== null && observedIdentity !== processIdentity)
            throw new CoordinationRuntimeError('unauthorized-client', 'predecessor PID was reused during exact retirement', [`pid=${String(pid)}`]);
        await sleep(25);
    }
    throw new CoordinationRuntimeError('coordinator-unavailable', 'predecessor did not retire before the upgrade deadline', [`pid=${String(pid)}`]);
}
async function takeOverPredecessorFenceAfterBarrier(paths, intent, expected) {
    const expectedText = await readExactLockText(paths.predecessorLockPath);
    if (expectedText === null)
        throw new CoordinationRuntimeError('unauthorized-client', 'predecessor lock disappeared before post-barrier fence takeover');
    const observed = parsePredecessorCoordinatorLock(JSON.parse(expectedText));
    if (observed === null || !samePredecessor(observed, expected))
        throw new CoordinationRuntimeError('unauthorized-client', 'predecessor lock changed before post-barrier fence takeover');
    const fence = { schema_version: 'autopilot.coordinator_lock.v1', pid: process.pid, boot_id: predecessorCompatibleBootId(), token: randomBytes(24).toString('hex'), started_at: new Date().toISOString() };
    const temporary = `${paths.predecessorLockPath}.takeover.${String(process.pid)}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(fence)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await enforcePrivateAuthorityPath(temporary, false);
    if (await readExactLockText(paths.predecessorLockPath) !== expectedText)
        throw new CoordinationRuntimeError('coordinator-contention', 'predecessor lock identity changed at post-barrier fence takeover');
    await rename(temporary, paths.predecessorLockPath);
    await enforcePrivateAuthorityPath(paths.predecessorLockPath, false);
    await fsyncDirectory(dirname(paths.predecessorLockPath));
    return { intent: await writeIntent(paths, intent, intent.state, { predecessor_fence: fence }), fence };
}
async function installPredecessorFence(paths, intent, deadline = Date.now() + 10_000) {
    let existingText = await readExactLockText(paths.predecessorLockPath);
    while (existingText !== null) {
        const existing = parsePredecessorCoordinatorLock(JSON.parse(existingText));
        if (existing === null)
            throw new CoordinationRuntimeError('protocol-mismatch', 'cannot install the old-format fence over an unknown lock');
        if (intent.predecessor_fence !== null && samePredecessor(existing, intent.predecessor_fence) && existing.pid === process.pid)
            return { intent, fence: existing };
        if (!isProcessAlive(existing.pid))
            break;
        if (Date.now() >= deadline)
            throw new CoordinationRuntimeError('coordinator-contention', 'cannot install the old-format fence while its lock PID is alive', [`pid=${String(existing.pid)}`]);
        await sleep(25);
        existingText = await readExactLockText(paths.predecessorLockPath);
    }
    const fence = { schema_version: 'autopilot.coordinator_lock.v1', pid: process.pid, boot_id: predecessorCompatibleBootId(), token: randomBytes(24).toString('hex'), started_at: new Date().toISOString() };
    const temporary = `${paths.predecessorLockPath}.fence.${String(process.pid)}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(fence)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await enforcePrivateAuthorityPath(temporary, false);
    if (existingText === null)
        await rename(temporary, paths.predecessorLockPath);
    else {
        if (await readExactLockText(paths.predecessorLockPath) !== existingText)
            throw new CoordinationRuntimeError('coordinator-contention', 'predecessor lock identity changed at continuous fence publication');
        await rename(temporary, paths.predecessorLockPath);
    }
    await enforcePrivateAuthorityPath(paths.predecessorLockPath, false);
    await fsyncDirectory(dirname(paths.predecessorLockPath));
    const next = await writeIntent(paths, intent, intent.state, { predecessor_fence: fence });
    return { intent: next, fence };
}
export async function recordCoordinatorFenceHandoff(paths, expected, replacement) {
    const intent = await readCoordinatorUpgradeIntent(paths);
    if (intent === null || intent.predecessor_fence === null || !samePredecessor(intent.predecessor_fence, expected) || !['starting', 'reconnect-verified'].includes(intent.state))
        throw new CoordinationRuntimeError('unauthorized-client', 'current coordinator fence handoff is not authorized by the durable upgrade intent');
    await writeIntent(paths, intent, intent.state, { predecessor_fence: replacement });
}
function databaseVersionAndIntegrity(path) {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    try {
        return {
            version: Number(database.prepare('PRAGMA user_version').get()?.['user_version']),
            integrity: String(database.prepare('PRAGMA integrity_check').get()?.['integrity_check']),
        };
    }
    finally {
        database.close();
    }
}
const BARRIER_DENIAL_MESSAGE = 'schema 6 retired by durable coordinator upgrade barrier';
const BARRIER_TRIGGER_OPERATIONS = Object.freeze(['INSERT', 'UPDATE', 'DELETE']);
function quoteSqlIdentifier(value) { return `"${value.replaceAll('"', '""')}"`; }
function barrierTriggerName(table, operation) {
    return `coordinator_upgrade_deny_${createHash('sha256').update(table, 'utf8').digest('hex').slice(0, 24)}_${operation.toLowerCase()}`;
}
function mutableBarrierTables(database) {
    return database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all().map((row) => {
        const name = row['name'];
        if (typeof name !== 'string' || name.length === 0)
            throw new CoordinationRuntimeError('store-corrupt', 'migration barrier found an invalid mutable table name');
        return name;
    });
}
function verifyMechanicalMutationBarrier(database) {
    const tables = mutableBarrierTables(database);
    if (!tables.includes('coordinator_upgrade_barrier'))
        throw new CoordinationRuntimeError('schema-mismatch', 'committed migration barrier table is absent');
    for (const table of tables) {
        for (const operation of BARRIER_TRIGGER_OPERATIONS) {
            const name = barrierTriggerName(table, operation);
            const row = database.prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
            const sql = row?.['sql'];
            if (row?.['tbl_name'] !== table || typeof sql !== 'string' || !sql.includes(`BEFORE ${operation}`) || !sql.includes(`RAISE(ABORT, '${BARRIER_DENIAL_MESSAGE}')`))
                throw new CoordinationRuntimeError('schema-mismatch', 'committed migration barrier does not mechanically deny every schema-6 mutation', [table, operation]);
        }
    }
}
function installedBarrierBackupDigest(database, upgradeId) {
    const integrity = database.prepare('PRAGMA integrity_check').get()?.['integrity_check'];
    const version = Number(database.prepare('PRAGMA user_version').get()?.['user_version']);
    if (integrity !== 'ok' || version !== COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION)
        throw new CoordinationRuntimeError('schema-mismatch', 'shared database is not the exact committed incompatible migration barrier');
    verifyMechanicalMutationBarrier(database);
    let rows;
    try {
        rows = database.prepare('SELECT upgrade_id, source_schema, target_schema, backup_sha256 FROM coordinator_upgrade_barrier').all();
    }
    catch (error) {
        throw new CoordinationRuntimeError('schema-mismatch', 'committed incompatible migration barrier record is unreadable', [failureMessage(error)]);
    }
    const row = rows[0];
    const digest = row?.['backup_sha256'];
    if (rows.length !== 1 || row?.['upgrade_id'] !== upgradeId || row['source_schema'] !== 6 || row['target_schema'] !== COORDINATOR_UPGRADE_PATH.target.database_schema_version || typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest))
        throw new CoordinationRuntimeError('schema-mismatch', 'committed incompatible migration barrier identity does not match the durable upgrade', [upgradeId]);
    return digest;
}
function commitIncompatibleMigrationBarrier(database, upgradeId, backupRecord) {
    const version = Number(database.prepare('PRAGMA user_version').get()?.['user_version']);
    if (version === COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION) {
        if (installedBarrierBackupDigest(database, upgradeId) !== backupRecord.sha256)
            throw new CoordinationRuntimeError('store-corrupt', 'installed migration barrier names a different final backup digest');
        database.exec('COMMIT');
        return;
    }
    if (version !== 6)
        throw new CoordinationRuntimeError('schema-mismatch', 'shared database is neither schema 6 nor the incompatible migration barrier');
    database.exec('CREATE TABLE coordinator_upgrade_barrier(upgrade_id TEXT PRIMARY KEY NOT NULL, source_schema INTEGER NOT NULL, target_schema INTEGER NOT NULL, backup_sha256 TEXT NOT NULL) STRICT');
    database.prepare('INSERT INTO coordinator_upgrade_barrier(upgrade_id, source_schema, target_schema, backup_sha256) VALUES(?, 6, ?, ?)').run(upgradeId, COORDINATOR_UPGRADE_PATH.target.database_schema_version, backupRecord.sha256);
    // Main-schema triggers are deliberately installed on every user table,
    // including the barrier record itself. SQLite invalidates statements prepared
    // by already-open aa3e377 connections when this schema change commits; their
    // automatic reprepare then reaches these BEFORE triggers and fails before a
    // row, event sequence, heartbeat, lease, or idempotency record can change.
    for (const table of mutableBarrierTables(database)) {
        for (const operation of BARRIER_TRIGGER_OPERATIONS) {
            database.exec(`CREATE TRIGGER ${quoteSqlIdentifier(barrierTriggerName(table, operation))} BEFORE ${operation} ON ${quoteSqlIdentifier(table)} BEGIN SELECT RAISE(ABORT, '${BARRIER_DENIAL_MESSAGE}'); END`);
        }
    }
    verifyMechanicalMutationBarrier(database);
    database.exec(`PRAGMA user_version=${String(COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION)}; COMMIT;`);
}
async function publishMigratedPrivateDatabase(paths, backupRecord, upgradeId) {
    const current = databaseVersionAndIntegrity(paths.databasePath);
    if (current.version === COORDINATOR_UPGRADE_PATH.target.database_schema_version && current.integrity === 'ok')
        return;
    if (current.version !== COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION || current.integrity !== 'ok')
        throw new CoordinationRuntimeError('schema-mismatch', 'target-schema publication requires the exact incompatible migration barrier');
    const barrier = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 5_000 });
    try {
        if (installedBarrierBackupDigest(barrier, upgradeId) !== backupRecord.sha256)
            throw new CoordinationRuntimeError('store-corrupt', 'target-schema publication backup does not match the committed barrier digest');
    }
    finally {
        barrier.close();
    }
    const staged = await verifyMigrationOnCopy(paths, backupRecord, upgradeId, true);
    if (staged !== await migratedPrivateDatabasePath(paths, upgradeId))
        throw new CoordinationRuntimeError('system-fatal', 'private migration target path changed unexpectedly');
    await rename(staged, paths.databasePath);
    await enforcePrivateAuthorityPath(paths.databasePath, false);
    await fsyncDirectory(dirname(paths.databasePath));
    const published = databaseVersionAndIntegrity(paths.databasePath);
    if (published.version !== COORDINATOR_UPGRADE_PATH.target.database_schema_version || published.integrity !== 'ok')
        throw new CoordinationRuntimeError('store-corrupt', 'atomically published target-schema database failed verification');
}
async function commitLockedSchema6Boundary(paths, intentValue, database, options, onBarrierCommitted) {
    let intent = intentValue;
    const finalReadiness = databaseReadiness(database);
    const finalBlockers = [...finalReadiness.blockers, ...finalReadiness.drainable];
    if (finalBlockers.length > 0) {
        await writeIntent(paths, intent, 'refused', { blockers: finalBlockers, failure: 'predecessor entered work that was not at a safe checkpoint before the barrier' });
        throw new CoordinationRuntimeError('coordinator-contention', 'live predecessor database contains an incompatible critical section; it remains writable because the barrier transaction was rolled back', finalBlockers);
    }
    const finalBackup = await createVerifiedLockedBoundaryBackup(paths, intent.upgrade_id, database);
    // The shared authority must become old-incompatible before the journal can
    // claim that the final backup exists. A process death after this COMMIT leaves
    // the digest-bound barrier authoritative; recovery locates the deterministic
    // backup by upgrade_id and reconstructs the intent without exposing schema 6.
    commitIncompatibleMigrationBarrier(database, intent.upgrade_id, finalBackup);
    onBarrierCommitted?.();
    await options.onBoundary?.('incompatible-barrier-committed');
    intent = await writeIntent(paths, intent, 'barrier-installed', { backup: finalBackup, safe_checkpoints: finalReadiness.safeCheckpoints });
    return { intent, backup: finalBackup };
}
async function recoverCommittedBoundaryBeforeIntent(paths, intentValue, database) {
    const expectedDigest = installedBarrierBackupDigest(database, intentValue.upgrade_id);
    const target = finalUpgradeBackupPath(paths, intentValue.upgrade_id);
    if (intentValue.state === 'final-backed-up' && (intentValue.backup === null || intentValue.backup.path !== target || intentValue.backup.sha256 !== expectedDigest))
        throw new CoordinationRuntimeError('store-corrupt', 'journaled final backup does not match the committed incompatible barrier');
    const finalBackup = await verifyAndRecordBackup(target, expectedDigest);
    const finalReadiness = quiescentDatabaseReadiness(finalBackup.path);
    const finalBlockers = [...finalReadiness.blockers, ...finalReadiness.drainable];
    if (finalBlockers.length > 0)
        throw new CoordinationRuntimeError('store-corrupt', 'deterministic final backup contains work outside a safe checkpoint', finalBlockers);
    const intent = await writeIntent(paths, intentValue, 'barrier-installed', { backup: finalBackup, safe_checkpoints: finalReadiness.safeCheckpoints });
    database.exec('COMMIT');
    return { intent, backup: finalBackup };
}
async function copyExactBackupForRestore(paths, backupRecord, upgradeId) {
    const expectedDigest = backupRecord.sha256;
    const currentBytes = existsSync(paths.databasePath) ? await readFile(paths.databasePath) : null;
    if (currentBytes !== null && `sha256:${createHash('sha256').update(currentBytes).digest('hex')}` === expectedDigest)
        return;
    const temporary = `${paths.databasePath}.restore.${upgradeId}.${randomUUID()}.tmp`;
    await copyFile(backupRecord.path, temporary);
    const handle = await open(temporary, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    const stagedDigest = `sha256:${createHash('sha256').update(await readFile(temporary)).digest('hex')}`;
    if (stagedDigest !== expectedDigest) {
        try {
            await unlinkIfExists(temporary);
        }
        catch (cleanupError) {
            throw new CoordinationRuntimeError('system-fatal', 'staged rollback digest failed and its untrusted temporary copy could not be removed', [temporary, cleanupError instanceof Error ? cleanupError.message : String(cleanupError)]);
        }
        throw new CoordinationRuntimeError('store-corrupt', 'staged rollback copy differs from the verified backup');
    }
    if (existsSync(paths.databasePath)) {
        const failed = join(paths.backupsRoot, `coordinator.failed-upgrade.${upgradeId}.db`);
        await unlink(failed).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error; });
        await rename(paths.databasePath, failed);
    }
    await rename(temporary, paths.databasePath);
    await enforcePrivateAuthorityPath(paths.databasePath, false);
    await fsyncDirectory(dirname(paths.databasePath));
}
async function restoreBackup(paths, intentValue, failure) {
    if (intentValue.backup === null)
        throw new CoordinationRuntimeError('recovery-required', 'upgrade rollback has no verified final backup');
    const backupRecord = intentValue.backup;
    const guard = acquireSerializedProcessGuard(paths.lifecycleElectionPath, 10_000, 'coordinator lifecycle election for rollback');
    let intent = await writeIntent(paths, intentValue, 'rollback-restoring', { failure: failureMessage(failure) });
    try {
        await verifyBackup(backupRecord);
        const currentText = await readExactLockText(paths.lockPath);
        if (currentText !== null) {
            const current = parseCurrentCoordinatorLock(JSON.parse(currentText));
            if (current === null)
                throw new CoordinationRuntimeError('recovery-required', 'rollback refuses an unknown current-generation lock');
            if (isProcessAlive(current.pid)) {
                if (!isExactProcessAlive(current.pid, current.process_start_identity))
                    throw new CoordinationRuntimeError('recovery-required', 'rollback refuses to retire a reused current-generation PID');
                retireExactProcess(current.pid, current.process_start_identity);
                await waitForExactRetirement(current.pid, current.process_start_identity, Date.now() + 10_000);
            }
            const remaining = await readExactLockText(paths.lockPath);
            if (remaining !== null) {
                const stale = parseCurrentCoordinatorLock(JSON.parse(remaining));
                if (stale === null || stale.token !== current.token || stale.instance_id !== current.instance_id || isProcessAlive(stale.pid))
                    throw new CoordinationRuntimeError('recovery-required', 'current-generation lock changed before rollback');
                const tombstone = await quarantineExactLock(paths.lockPath, remaining, 'failed target lock');
                await discardLockTombstone(tombstone);
            }
        }
        if (platform() !== 'win32')
            await unlink(paths.socketPath).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error; });
        await unlink(`${paths.databasePath}-wal`).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error; });
        await unlink(`${paths.databasePath}-shm`).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error; });
        await copyExactBackupForRestore(paths, backupRecord, intent.upgrade_id);
        await unlinkIfExists(`${paths.databasePath}-wal`);
        await unlinkIfExists(`${paths.databasePath}-shm`);
        const restoredDigest = `sha256:${createHash('sha256').update(await readFile(paths.databasePath)).digest('hex')}`;
        if (restoredDigest !== backupRecord.sha256)
            throw new CoordinationRuntimeError('store-corrupt', 'restored database is not byte-exactly the verified backup');
        quiescentDatabaseReadiness(paths.databasePath);
        const fenceText = await readExactLockText(paths.predecessorLockPath);
        if (fenceText !== null) {
            const fence = parsePredecessorCoordinatorLock(JSON.parse(fenceText));
            if (fence === null)
                throw new CoordinationRuntimeError('recovery-required', 'rollback found an unknown predecessor lock');
            if (isProcessAlive(fence.pid) && fence.pid !== process.pid)
                throw new CoordinationRuntimeError('recovery-required', 'rollback refuses to remove a live predecessor lock', [`pid=${String(fence.pid)}`]);
            if (intent.predecessor_fence === null || fence.token !== intent.predecessor_fence.token)
                throw new CoordinationRuntimeError('recovery-required', 'rollback predecessor fence identity changed');
            const tombstone = await quarantineExactLock(paths.predecessorLockPath, fenceText, 'rollback predecessor fence');
            await discardLockTombstone(tombstone);
        }
        intent = await writeIntent(paths, intent, 'rollback-restored', { predecessor_fence: null, failure: failureMessage(failure) });
        return intent;
    }
    finally {
        guard.release();
    }
}
function transaction(paths, initial) {
    let current = initial;
    const refresh = async () => {
        const durable = await readCoordinatorUpgradeIntent(paths);
        if (durable === null || durable.upgrade_id !== current.upgrade_id)
            throw new CoordinationRuntimeError('recovery-required', 'durable upgrade intent changed identity during choreography');
        current = durable;
        return current;
    };
    return {
        get intent() { return current; },
        markStarting: async () => { current = await writeIntent(paths, await refresh(), 'starting'); },
        markReconnectVerified: async () => { current = await writeIntent(paths, await refresh(), 'reconnect-verified'); },
        commit: async () => { current = await writeIntent(paths, await refresh(), 'committed'); },
        rollback: async (failure) => { current = await restoreBackup(paths, await refresh(), failure); },
        markRecoveryRequired: async (failure) => { current = await writeIntent(paths, await refresh(), 'recovery-required', { failure: failureMessage(failure) }); },
    };
}
export async function preparePredecessorCoordinatorUpgrade(paths, capability, deadline, options = {}) {
    preflightProcessRetirementSupport();
    const guard = acquireSerializedProcessGuard(paths.lifecycleElectionPath, Math.max(1, deadline - Date.now()), 'coordinator lifecycle election for exact predecessor upgrade');
    let intent = null;
    let retirementStarted = false;
    let incompatibleAuthorityCommitted = false;
    try {
        const existingIntent = await readKnownCoordinatorUpgradeIntent(paths);
        if (existingIntent !== null && (existingIntent.target.package_build !== COORDINATOR_UPGRADE_PATH.target.package_build || existingIntent.state !== 'refused'))
            throw new CoordinationRuntimeError('recovery-required', `new schema upgrade refuses to overwrite durable ${existingIntent.state} intent for target ${existingIntent.target.package_build}`, [coordinatorUpgradeIntentPath(paths), existingIntent.upgrade_id]);
        const lockValue = await readLock(paths.predecessorLockPath, 'predecessor lifecycle lock');
        const lock = parsePredecessorCoordinatorLock(lockValue);
        if (lock === null || !isProcessAlive(lock.pid) || lock.pid === process.pid)
            throw new CoordinationRuntimeError('protocol-mismatch', 'incompatible coordinator is not the exact live 1.2 predecessor');
        const processIdentity = processStartIdentity(lock.pid);
        if (processIdentity === null)
            throw new CoordinationRuntimeError('protocol-mismatch', 'cannot obtain the predecessor process-creation identity required for exact retirement', [`pid=${String(lock.pid)}`]);
        const firstStatus = await predecessorStatus(paths, capability, 'global', null, Math.min(1_000, Math.max(100, deadline - Date.now())));
        if (firstStatus.package_build !== COORDINATOR_UPGRADE_PATH.source.package_build)
            throw new CoordinationRuntimeError('protocol-mismatch', 'only the exact aa3e377 / 0.13.0-cf34 predecessor is upgradeable');
        const confirmed = parsePredecessorCoordinatorLock(await readLock(paths.predecessorLockPath, 'predecessor lifecycle lock'));
        if (confirmed === null || !samePredecessor(lock, confirmed) || !isExactProcessAlive(lock.pid, processIdentity))
            throw new CoordinationRuntimeError('unauthorized-client', 'authenticated predecessor identity does not have stable lifecycle ownership');
        const now = new Date().toISOString();
        intent = parseCoordinatorUpgradeIntent({
            schema_version: COORDINATOR_UPGRADE_INTENT_SCHEMA,
            upgrade_id: randomUUID(),
            state: 'prepared',
            source: { package_build: '0.13.0-cf34', protocol_version: '1.2', database_schema_version: 6, pid: lock.pid, boot_id: lock.boot_id, process_start_identity: processIdentity, lock_token: lock.token, lock_started_at: lock.started_at },
            target: COORDINATOR_UPGRADE_PATH.target,
            safe_checkpoints: [], blockers: [], predecessor_fence: null, backup: null,
            created_at: now, updated_at: now, failure: null,
        });
        await atomicWriteJson(coordinatorUpgradeIntentPath(paths), intent);
        intent = await writeIntent(paths, intent, 'draining');
        const drainDeadline = Math.min(deadline, Date.now() + UPGRADE_DRAIN_TIMEOUT_MS);
        let ready = await authenticatedReadiness(paths, capability, Math.min(1_000, Math.max(100, deadline - Date.now())));
        while (ready.blockers.length === 0 && ready.drainable.length > 0 && Date.now() < drainDeadline) {
            await sleep(UPGRADE_POLL_MS);
            ready = await authenticatedReadiness(paths, capability, Math.min(1_000, Math.max(100, deadline - Date.now())));
        }
        const blockers = [...ready.blockers, ...ready.drainable];
        if (blockers.length > 0) {
            intent = await writeIntent(paths, intent, 'refused', { blockers, safe_checkpoints: ready.safeCheckpoints, failure: 'authenticated drain did not reach a safe checkpoint' });
            throw new CoordinationRuntimeError('coordinator-contention', 'coordinator upgrade refused while incompatible work is active', blockers);
        }
        const preflightBackup = await createVerifiedBackup(paths, intent.upgrade_id);
        await verifyMigrationOnCopy(paths, preflightBackup, intent.upgrade_id);
        intent = await writeIntent(paths, intent, 'preflight-backed-up', { backup: preflightBackup, safe_checkpoints: ready.safeCheckpoints });
        // Re-authenticate immediately before taking SQLite exclusion. The old
        // protocol has no quiesce verb, so BEGIN EXCLUSIVE is the only point after
        // which readiness and the rollback image cannot race another old write.
        ready = await authenticatedReadiness(paths, capability, Math.min(1_000, Math.max(100, deadline - Date.now())));
        const finalStatusBlockers = [...ready.blockers, ...ready.drainable];
        if (finalStatusBlockers.length > 0) {
            intent = await writeIntent(paths, intent, 'refused', { blockers: finalStatusBlockers, failure: 'work entered an unsafe section before writer exclusion' });
            throw new CoordinationRuntimeError('coordinator-contention', 'coordinator became unsafe before writer exclusion', finalStatusBlockers);
        }
        const beforeBarrier = parsePredecessorCoordinatorLock(await readLock(paths.predecessorLockPath, 'predecessor lifecycle lock'));
        if (beforeBarrier === null || !samePredecessor(lock, beforeBarrier) || !isExactProcessAlive(lock.pid, processIdentity))
            throw new CoordinationRuntimeError('unauthorized-client', 'predecessor identity changed before writer exclusion');
        // Keep the authenticated predecessor alive while taking the exact rollback
        // image and committing the incompatibility barrier. Before COMMIT, process
        // death rolls this transaction back and the predecessor remains authority.
        // After COMMIT, durable deny triggers invalidate already-prepared statements
        // on its open connection, so it is mechanically unable to mutate schema 6.
        const writerBarrier = acquireExclusiveWriterBarrier(paths);
        let barrierCommitted = false;
        try {
            await options.onBoundary?.('writer-barrier-acquired');
            const lockedReadiness = databaseReadiness(writerBarrier);
            const lockedBlockers = [...lockedReadiness.blockers, ...lockedReadiness.drainable];
            if (lockedBlockers.length > 0)
                throw new CoordinationRuntimeError('coordinator-contention', 'coordinator became unsafe before the durable writer barrier', lockedBlockers);
            const boundary = await commitLockedSchema6Boundary(paths, intent, writerBarrier, options, () => { incompatibleAuthorityCommitted = true; });
            intent = boundary.intent;
            barrierCommitted = true;
        }
        finally {
            closeWriterBarrier(writerBarrier, barrierCommitted);
        }
        // Retirement is intentionally after the fsynced backup and barrier COMMIT.
        // File fencing is now defense in depth: even arbitrary upgrader death leaves
        // a live but trigger-denied old process rather than writable schema 6.
        const takeover = await takeOverPredecessorFenceAfterBarrier(paths, intent, lock);
        intent = takeover.intent;
        retirementStarted = true;
        if (isProcessAlive(lock.pid)) {
            if (!isExactProcessAlive(lock.pid, processIdentity))
                throw new CoordinationRuntimeError('unauthorized-client', 'predecessor PID was reused after barrier commit');
            retireExactProcess(lock.pid, processIdentity);
            await waitForExactRetirement(lock.pid, processIdentity, deadline);
        }
        await options.onBoundary?.('predecessor-retired-after-barrier');
        if (platform() !== 'win32')
            await unlink(paths.predecessorSocketPath).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error; });
        intent = await writeIntent(paths, intent, 'barrier-installed', { predecessor_fence: takeover.fence });
        if (intent.backup === null)
            throw new CoordinationRuntimeError('recovery-required', 'final schema-6 backup disappeared after incompatible barrier commit');
        await publishMigratedPrivateDatabase(paths, intent.backup, intent.upgrade_id);
        intent = await writeIntent(paths, intent, 'migration-verified');
        return transaction(paths, intent);
    }
    catch (error) {
        if (intent !== null && intent.state !== 'refused') {
            // Never regress a committed old-incompatible authority to a generic
            // recovery terminal. Its last pre-commit intent plus deterministic backup
            // are sufficient for resume to reconstruct the missing journal record.
            if (!incompatibleAuthorityCommitted) {
                const sourceStillExact = isExactProcessAlive(intent.source.pid, intent.source.process_start_identity);
                const state = !retirementStarted && sourceStillExact ? 'refused' : 'recovery-required';
                try {
                    await writeIntent(paths, intent, state, { failure: failureMessage(error), blockers: error instanceof CoordinationRuntimeError ? error.evidence : [] });
                }
                catch (intentError) {
                    throw new CoordinationRuntimeError('system-fatal', 'coordinator upgrade failed and its durable failure intent could not be published', [failureMessage(error), failureMessage(intentError)]);
                }
            }
        }
        throw error;
    }
    finally {
        guard.release();
    }
}
export async function resumeCoordinatorUpgrade(paths) {
    const readable = await readKnownCoordinatorUpgradeIntent(paths);
    if (readable === null)
        return null;
    if (readable.target.package_build !== COORDINATOR_UPGRADE_PATH.target.package_build) {
        if (readable.state === 'committed')
            return null;
        throw new CoordinationRuntimeError('recovery-required', `historical coordinator upgrade target ${readable.target.package_build} stopped at ${readable.state}; this package will not rewrite or resume another build's intent`, [coordinatorUpgradeIntentPath(paths), readable.upgrade_id]);
    }
    let intent = parseCoordinatorUpgradeIntent(readable);
    if (intent.state === 'committed' || intent.state === 'refused')
        return null;
    if (intent.state === 'rollback-restored')
        throw new CoordinationRuntimeError('recovery-required', 'schema-6 backup was restored exactly; this package cannot automatically restart the unavailable aa3e377 binary', [coordinatorUpgradeIntentPath(paths)]);
    if (intent.state === 'rollback-restoring') {
        intent = await restoreBackup(paths, intent, intent.failure ?? 'resuming interrupted rollback');
        throw new CoordinationRuntimeError('recovery-required', 'interrupted rollback completed with the exact schema-6 backup; restart aa3e377 manually', [coordinatorUpgradeIntentPath(paths), intent.upgrade_id]);
    }
    if (intent.state === 'recovery-required')
        throw new CoordinationRuntimeError('recovery-required', 'coordinator upgrade requires explicit operator recovery', [coordinatorUpgradeIntentPath(paths), intent.failure ?? 'unknown failure']);
    const guard = acquireSerializedProcessGuard(paths.lifecycleElectionPath, 10_000, 'coordinator lifecycle election for upgrade recovery');
    try {
        const observed = databaseVersionAndIntegrity(paths.databasePath);
        if (observed.integrity !== 'ok')
            throw new CoordinationRuntimeError('store-corrupt', 'upgrade recovery found a corrupt shared database');
        if (observed.version === 6) {
            // No barrier COMMIT means no planned retirement has occurred. Never turn a
            // pre-commit crash into a kill-and-migrate path: preserve the exact old
            // authority when alive, and require manual recovery if it died itself.
            const sourceAlive = isProcessAlive(intent.source.pid);
            if (sourceAlive && !isExactProcessAlive(intent.source.pid, intent.source.process_start_identity))
                throw new CoordinationRuntimeError('unauthorized-client', 'upgrade source PID was reused before pre-commit recovery');
            const failure = sourceAlive
                ? 'interrupted before the durable incompatibility barrier; exact predecessor remains authoritative'
                : 'predecessor died before the durable incompatibility barrier; automatic migration is forbidden';
            intent = await writeIntent(paths, intent, sourceAlive ? 'refused' : 'recovery-required', { failure });
            throw new CoordinationRuntimeError('recovery-required', failure, [coordinatorUpgradeIntentPath(paths), intent.upgrade_id]);
        }
        if (observed.version === COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION) {
            // The database is the source of truth if death occurred after COMMIT but
            // before JSON publication. Reconstruct the exact backup record while old
            // deny triggers remain installed and before touching the source process.
            const writerBarrier = acquireExclusiveWriterBarrier(paths, true);
            let recovered = false;
            try {
                const boundary = await recoverCommittedBoundaryBeforeIntent(paths, intent, writerBarrier);
                intent = boundary.intent;
                recovered = true;
            }
            finally {
                closeWriterBarrier(writerBarrier, recovered);
            }
        }
        else if (observed.version !== COORDINATOR_UPGRADE_PATH.target.database_schema_version) {
            throw new CoordinationRuntimeError('schema-mismatch', 'upgrade recovery found neither schema 6, the durable incompatibility barrier, nor the exact target schema');
        }
        if (intent.state === 'barrier-installed' || observed.version === COORDINATOR_UPGRADE_BARRIER_SCHEMA_VERSION) {
            const finalBackup = intent.backup;
            if (finalBackup === null)
                throw new CoordinationRuntimeError('recovery-required', 'committed barrier recovery did not reconstruct its deterministic final backup');
            await verifyBackup(finalBackup);
            preflightProcessRetirementSupport();
            const sourceAlive = isProcessAlive(intent.source.pid);
            if (sourceAlive && !isExactProcessAlive(intent.source.pid, intent.source.process_start_identity))
                throw new CoordinationRuntimeError('unauthorized-client', 'upgrade source PID was reused after barrier commit');
            const expectedSourceLock = {
                schema_version: 'autopilot.coordinator_lock.v1', pid: intent.source.pid, boot_id: intent.source.boot_id,
                token: intent.source.lock_token, started_at: intent.source.lock_started_at,
            };
            const lockText = await readExactLockText(paths.predecessorLockPath);
            const lock = lockText === null ? null : parsePredecessorCoordinatorLock(JSON.parse(lockText));
            const fenced = lock !== null && samePredecessor(lock, expectedSourceLock)
                ? await takeOverPredecessorFenceAfterBarrier(paths, intent, expectedSourceLock)
                : await installPredecessorFence(paths, intent);
            intent = await writeIntent(paths, fenced.intent, 'barrier-installed', { predecessor_fence: fenced.fence });
            if (sourceAlive) {
                retireExactProcess(intent.source.pid, intent.source.process_start_identity);
                await waitForExactRetirement(intent.source.pid, intent.source.process_start_identity, Date.now() + 10_000);
            }
            if (platform() !== 'win32')
                await unlink(paths.predecessorSocketPath).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                    throw error; });
            await publishMigratedPrivateDatabase(paths, finalBackup, intent.upgrade_id);
            intent = await writeIntent(paths, intent, 'migration-verified');
        }
        if (intent.state === 'migration-verified' || intent.state === 'starting' || intent.state === 'reconnect-verified')
            return transaction(paths, intent);
        if (intent.state === 'rollback-restoring')
            return transaction(paths, intent);
        throw new CoordinationRuntimeError('recovery-required', `durable coordinator upgrade stopped at ${intent.state}`, [coordinatorUpgradeIntentPath(paths)]);
    }
    finally {
        guard.release();
    }
}
