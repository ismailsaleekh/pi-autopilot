import { constants as fsConstants, existsSync, lstatSync, openSync, closeSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { assertPrivatePathNoAliases, enforcePrivateAuthorityPath } from "../private-path.js";
import { CoordinationRuntimeError } from "./failures.js";
import { COORDINATOR_BUSY_TIMEOUT_MS, ensureCoordinatorPrivateRoots } from "./runtime-paths.js";
function createPrivatePlaceholder(path) {
    if (existsSync(path))
        return;
    try {
        const descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        closeSync(descriptor);
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
            throw error;
    }
}
function assertPrivateRegularSingleLink(path) {
    assertPrivatePathNoAliases(path);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new CoordinationRuntimeError('system-fatal', 'writer guard must be a private regular non-symbolic file', [path]);
    if (metadata.nlink !== 1)
        throw new CoordinationRuntimeError('system-fatal', 'writer guard refuses hardlink aliases', [path, `link_count=${String(metadata.nlink)}`]);
    if (platform() !== 'win32') {
        const getuid = process.getuid;
        if (getuid !== undefined && metadata.uid !== getuid())
            throw new CoordinationRuntimeError('system-fatal', 'writer guard owner differs from the coordinator process user', [path, `uid=${String(metadata.uid)}`]);
    }
    return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}
/** Exact process-lifetime SQLite connection/transaction that owns writer authority. */
export class CoordinatorWriterGuard {
    #database;
    path;
    #identity;
    #released = false;
    constructor(path, database, identity) {
        this.path = path;
        this.#database = database;
        this.#identity = identity;
    }
    static async acquire(paths, timeoutMs = COORDINATOR_BUSY_TIMEOUT_MS) {
        await ensureCoordinatorPrivateRoots(paths);
        createPrivatePlaceholder(paths.writerGuardPath);
        await enforcePrivateAuthorityPath(paths.writerGuardPath, false);
        const expectedIdentity = assertPrivateRegularSingleLink(paths.writerGuardPath);
        const database = new DatabaseSync(paths.writerGuardPath, { timeout: Math.max(1, timeoutMs) });
        try {
            database.exec(`PRAGMA busy_timeout=${String(Math.max(1, timeoutMs))}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;`);
            if (!database.isTransaction)
                throw new CoordinationRuntimeError('system-fatal', 'writer guard BEGIN EXCLUSIVE did not retain its transaction');
            const retainedIdentity = assertPrivateRegularSingleLink(paths.writerGuardPath);
            const opened = statSync(paths.writerGuardPath);
            if (!opened.isFile() || retainedIdentity.dev !== expectedIdentity.dev || retainedIdentity.ino !== expectedIdentity.ino)
                throw new CoordinationRuntimeError('system-fatal', 'writer guard identity changed during acquisition', [paths.writerGuardPath]);
            return new CoordinatorWriterGuard(paths.writerGuardPath, database, expectedIdentity);
        }
        catch (error) {
            try {
                if (database.isTransaction)
                    database.exec('ROLLBACK');
            }
            finally {
                database.close();
            }
            if (error instanceof CoordinationRuntimeError)
                throw error;
            throw new CoordinationRuntimeError('system-fatal', 'SQLite writer guard acquisition failed', [paths.writerGuardPath, error instanceof Error ? error.message : String(error)]);
        }
    }
    assertHeld() {
        if (this.#released || !this.#database.isTransaction)
            throw new CoordinationRuntimeError('system-fatal', 'SQLite writer guard authority is not held for the writable process lifetime', [this.path]);
        const observed = assertPrivateRegularSingleLink(this.path);
        if (observed.dev !== this.#identity.dev || observed.ino !== this.#identity.ino)
            throw new CoordinationRuntimeError('system-fatal', 'SQLite writer guard path identity changed while authority was held', [this.path]);
    }
    release() {
        if (this.#released)
            return;
        this.assertHeld();
        try {
            this.#database.exec('ROLLBACK');
        }
        finally {
            this.#database.close();
            this.#released = true;
        }
    }
}
