import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { CoordinationRuntimeError } from "./failures.js";
import { isExactProcessAlive, isProcessAlive, preflightProcessRetirementSupport, processStartIdentity, retireExactProcess } from "./process-identity.js";
import { enforcePrivateAuthorityPath, ensureCoordinatorPrivateRoots } from "./runtime-paths.js";
import { acquireSerializedProcessGuard, readExactLockText } from "./serialized-lock.js";
import { parseCurrentCoordinatorLock, parsePriorSchema11CurrentCoordinatorLock } from "./upgrade-contracts.js";
export const SCHEMA11_RETIREMENT_REPORT_SCHEMA = 'autopilot.schema11_retirement.v1';
function databaseVersion(database) {
    const row = database.prepare('PRAGMA user_version').get();
    const version = row?.['user_version'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version))
        throw new CoordinationRuntimeError('store-corrupt', 'coordinator database has no exact schema version');
    return version;
}
function databaseIntegrity(database) {
    const row = database.prepare('PRAGMA integrity_check(1)').get();
    const integrity = row?.['integrity_check'];
    if (typeof integrity !== 'string')
        throw new CoordinationRuntimeError('store-corrupt', 'coordinator database integrity result is malformed');
    return integrity;
}
function schema11DrainBlockers(database) {
    if (databaseVersion(database) !== 11 || databaseIntegrity(database) !== 'ok')
        throw new CoordinationRuntimeError('schema-mismatch', 'cf42 retirement requires an exact healthy schema-11 database');
    const blockers = [];
    for (const row of database.prepare("SELECT repo_id, workstream_run, session_lease_id, status FROM session_leases WHERE status IN ('attached','handoff-pending') ORDER BY repo_id, workstream_run, session_generation").all()) {
        const repoId = row['repo_id'];
        const run = row['workstream_run'];
        const lease = row['session_lease_id'];
        const status = row['status'];
        if (typeof repoId !== 'string' || typeof run !== 'string' || typeof lease !== 'string' || typeof status !== 'string')
            throw new CoordinationRuntimeError('store-corrupt', 'schema-11 session drain row is malformed');
        blockers.push(`session-not-drained:${repoId}:${run}:${lease}:${status}`);
    }
    for (const row of database.prepare("SELECT repo_id, workstream_run, child_lease_id, status FROM child_leases WHERE status IN ('preflight','starting','running','recovery-required') ORDER BY repo_id, workstream_run, unit_id, attempt").all()) {
        const repoId = row['repo_id'];
        const run = row['workstream_run'];
        const child = row['child_lease_id'];
        const status = row['status'];
        if (typeof repoId !== 'string' || typeof run !== 'string' || typeof child !== 'string' || typeof status !== 'string')
            throw new CoordinationRuntimeError('store-corrupt', 'schema-11 child drain row is malformed');
        blockers.push(`child-not-drained:${repoId}:${run}:${child}:${status}`);
    }
    for (const row of database.prepare("SELECT repo_id, workstream_run, entity_id FROM unit_attempts WHERE json_type(payload_json,'$.critical_section')!='null' ORDER BY repo_id, workstream_run, entity_id").all()) {
        const repoId = row['repo_id'];
        const run = row['workstream_run'];
        const attempt = row['entity_id'];
        if (typeof repoId !== 'string' || typeof run !== 'string' || typeof attempt !== 'string')
            throw new CoordinationRuntimeError('store-corrupt', 'schema-11 critical-section drain row is malformed');
        blockers.push(`critical-section-active:${repoId}:${run}:${attempt}`);
    }
    for (const row of database.prepare("SELECT repo_id, workstream_run, entity_id FROM worktree_operations WHERE json_extract(payload_json,'$.stage') NOT IN ('committed','compensated','failed') ORDER BY repo_id, workstream_run, entity_id").all()) {
        const repoId = row['repo_id'];
        const run = row['workstream_run'];
        const operation = row['entity_id'];
        if (typeof repoId !== 'string' || typeof run !== 'string' || typeof operation !== 'string')
            throw new CoordinationRuntimeError('store-corrupt', 'schema-11 operation drain row is malformed');
        blockers.push(`operation-not-drained:${repoId}:${run}:${operation}`);
    }
    return Object.freeze(blockers);
}
function sameSchema11Lock(left, right) {
    return left !== null && right !== null && left.pid === right.pid && left.boot_id === right.boot_id && left.process_start_identity === right.process_start_identity && left.token === right.token && left.instance_id === right.instance_id && left.started_at === right.started_at;
}
async function waitForRetirement(pid, processIdentity) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid))
            return;
        const observedIdentity = processStartIdentity(pid);
        if (observedIdentity !== null && observedIdentity !== processIdentity)
            throw new CoordinationRuntimeError('unauthorized-client', 'cf42 PID identity changed during exact retirement', [`pid=${String(pid)}`]);
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new CoordinationRuntimeError('coordinator-unavailable', 'cf42 coordinator did not retire before the exact upgrade deadline', [`pid=${String(pid)}`]);
}
/**
 * Explicit package-owned cf42→cf43 retirement. It never edits the live database,
 * lock, socket, claims, or messages. It refuses until every process authority and
 * critical section is durably drained, takes a verified SQLite backup, rechecks
 * exact lock/process identity, and only then signals that exact cf42 process.
 */
export async function retireSchema11CoordinatorForUpgrade(paths) {
    await ensureCoordinatorPrivateRoots(paths);
    const guard = acquireSerializedProcessGuard(paths.lifecycleElectionPath, 10_000, 'schema-11 coordinator retirement');
    try {
        const lockText = await readExactLockText(paths.lockPath);
        if (lockText === null) {
            const database = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 10_000 });
            try {
                const version = databaseVersion(database);
                if (databaseIntegrity(database) !== 'ok')
                    throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed integrity before schema upgrade');
                if (version === 12)
                    return { schema_version: SCHEMA11_RETIREMENT_REPORT_SCHEMA, outcome: 'already-current', retired_package_build: null, retired_pid: null, database_schema_version: 12, backup_path: null, backup_sha256: null };
                if (version !== 11)
                    throw new CoordinationRuntimeError('schema-mismatch', 'coordinator database is neither the exact cf42 source nor cf43 target', [`schema=${String(version)}`]);
                const blockers = schema11DrainBlockers(database);
                if (blockers.length > 0)
                    throw new CoordinationRuntimeError('coordinator-contention', 'schema-11 coordinator authority is not fully drained', blockers);
                return { schema_version: SCHEMA11_RETIREMENT_REPORT_SCHEMA, outcome: 'ready-for-schema12-start', retired_package_build: null, retired_pid: null, database_schema_version: 11, backup_path: null, backup_sha256: null };
            }
            finally {
                database.close();
            }
        }
        let parsedLock;
        try {
            parsedLock = JSON.parse(lockText);
        }
        catch {
            throw new CoordinationRuntimeError('schema-mismatch', 'coordinator lifecycle lock is not valid JSON');
        }
        const current = parseCurrentCoordinatorLock(parsedLock);
        if (current !== null)
            return { schema_version: SCHEMA11_RETIREMENT_REPORT_SCHEMA, outcome: 'already-current', retired_package_build: null, retired_pid: null, database_schema_version: 12, backup_path: null, backup_sha256: null };
        const source = parsePriorSchema11CurrentCoordinatorLock(parsedLock);
        if (source === null)
            throw new CoordinationRuntimeError('protocol-mismatch', 'only the exact cf42/protocol-1.5/schema-11 lifecycle identity can use schema-11 retirement');
        if (!isExactProcessAlive(source.pid, source.process_start_identity))
            throw new CoordinationRuntimeError('coordinator-unavailable', 'cf42 lifecycle identity is not an exact live process; ordinary elected startup must reclaim a dead lock', [`pid=${String(source.pid)}`]);
        preflightProcessRetirementSupport();
        const database = new DatabaseSync(paths.databasePath, { timeout: 10_000 });
        const stamp = new Date().toISOString().replace(/[-:.]/gu, '');
        const backupPath = join(paths.backupsRoot, `coordinator.pre-cf43-retirement.${stamp}.db`);
        let backupSha256 = null;
        database.exec('BEGIN IMMEDIATE');
        try {
            const blockers = schema11DrainBlockers(database);
            if (blockers.length > 0)
                throw new CoordinationRuntimeError('coordinator-contention', 'schema-11 coordinator authority is not fully drained', blockers);
            const backupSource = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 10_000 });
            try {
                await backup(backupSource, backupPath);
            }
            finally {
                backupSource.close();
            }
            await enforcePrivateAuthorityPath(backupPath, false);
            const backupBytes = await readFile(backupPath);
            backupSha256 = `sha256:${createHash('sha256').update(backupBytes).digest('hex')}`;
            const backupDatabase = new DatabaseSync(backupPath, { readOnly: true, timeout: 10_000 });
            try {
                if (databaseVersion(backupDatabase) !== 11 || databaseIntegrity(backupDatabase) !== 'ok')
                    throw new CoordinationRuntimeError('store-corrupt', 'pre-cf43 retirement backup is not exact healthy schema 11');
            }
            finally {
                backupDatabase.close();
            }
            const recheckedText = await readExactLockText(paths.lockPath);
            if (recheckedText === null)
                throw new CoordinationRuntimeError('unauthorized-client', 'cf42 lifecycle lock disappeared before exact retirement');
            let recheckedValue;
            try {
                recheckedValue = JSON.parse(recheckedText);
            }
            catch {
                throw new CoordinationRuntimeError('schema-mismatch', 'cf42 lifecycle lock became invalid JSON before retirement');
            }
            const rechecked = parsePriorSchema11CurrentCoordinatorLock(recheckedValue);
            if (!sameSchema11Lock(source, rechecked) || !isExactProcessAlive(source.pid, source.process_start_identity))
                throw new CoordinationRuntimeError('unauthorized-client', 'cf42 lifecycle identity changed before exact retirement');
            retireExactProcess(source.pid, source.process_start_identity);
            await waitForRetirement(source.pid, source.process_start_identity);
            database.exec('ROLLBACK');
        }
        catch (error) {
            try {
                database.exec('ROLLBACK');
            }
            catch (rollbackError) {
                throw new CoordinationRuntimeError('system-fatal', 'cf42 retirement failed and its non-mutating writer boundary could not be rolled back', [error instanceof Error ? error.message : String(error), rollbackError instanceof Error ? rollbackError.message : String(rollbackError)]);
            }
            throw error;
        }
        finally {
            database.close();
        }
        if (backupSha256 === null)
            throw new CoordinationRuntimeError('system-fatal', 'cf42 retirement completed without its verified backup digest');
        return { schema_version: SCHEMA11_RETIREMENT_REPORT_SCHEMA, outcome: 'ready-for-schema12-start', retired_package_build: '1.1.0-cf42', retired_pid: source.pid, database_schema_version: 11, backup_path: backupPath, backup_sha256: backupSha256 };
    }
    finally {
        guard.release();
    }
}
