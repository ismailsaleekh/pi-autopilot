import { randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CoordinationRuntimeError } from "./failures.js";
import { assertPrivatePathNoAliases, enforceWindowsPrivateAcl, ensurePrivateAuthorityDirectorySync } from "../private-path.js";
import { platform } from 'node:os';
function failureMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function acquireSerializedProcessGuard(databasePath, timeoutMs, label) {
    ensurePrivateAuthorityDirectorySync(dirname(databasePath));
    const database = new DatabaseSync(databasePath, { timeout: Math.max(1, timeoutMs) });
    try {
        if (platform() === 'win32')
            enforceWindowsPrivateAcl(databasePath, false);
        database.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE;');
    }
    catch (error) {
        database.close();
        throw new CoordinationRuntimeError('coordinator-contention', `timed out acquiring serialized ${label}`, [failureMessage(error)]);
    }
    let released = false;
    return {
        release: () => {
            if (released)
                return;
            released = true;
            try {
                database.exec('COMMIT');
            }
            finally {
                database.close();
            }
        },
    };
}
export async function readExactLockText(path) {
    try {
        assertPrivatePathNoAliases(path);
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return null;
        throw error;
    }
}
/**
 * Atomically moves one byte-exact lock record out of the elected pathname.
 * Callers must hold the matching SQLite process guard until either a successor
 * record has been created or the tombstone has been restored. A mismatched move
 * is restored when possible and always fails closed.
 */
export async function quarantineExactLock(path, expectedText, label) {
    const before = await readExactLockText(path);
    if (before !== expectedText)
        throw new CoordinationRuntimeError('coordinator-contention', `${label} identity changed before serialized reclamation`);
    const tombstone = `${path}.reclaim.${String(process.pid)}.${randomUUID()}`;
    await rename(path, tombstone);
    const moved = await readExactLockText(tombstone);
    if (moved !== expectedText) {
        try {
            if (await readExactLockText(path) === null)
                await rename(tombstone, path);
        }
        catch { /* retain both paths for forensic recovery */ }
        throw new CoordinationRuntimeError('coordinator-contention', `${label} identity changed during serialized reclamation`);
    }
    return tombstone;
}
export async function discardLockTombstone(path) {
    await rm(path, { force: true });
}
export async function restoreLockTombstone(path, tombstone, label) {
    if (await readExactLockText(path) !== null)
        throw new CoordinationRuntimeError('system-fatal', `${label} could not be restored because its pathname was reoccupied`, [tombstone]);
    await rename(tombstone, path);
}
