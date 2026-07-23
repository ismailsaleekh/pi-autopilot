import { chmodSync, closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync, } from 'node:fs';
import { chmod, link, mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathIsInsideOrEqual } from "./paths.js";
export const ROSTER_PRIVATE_DIR_MODE = 0o700;
export const ROSTER_PRIVATE_FILE_MODE = 0o600;
export class RosterStorageError extends Error {
    code;
    constructor(code, message, cause) {
        super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
        this.name = 'RosterStorageError';
        this.code = code;
    }
}
export class RosterWriterLock {
    path;
    record;
    #authorityRoot;
    #hooks;
    #released = false;
    constructor(input) {
        this.path = input.path;
        this.#authorityRoot = input.authorityRoot;
        this.record = input.record;
        this.#hooks = input.hooks;
    }
    async release() {
        if (this.#released)
            return;
        const existing = await readAuthorityFileIfPresent(this.path, this.#authorityRoot);
        if (existing === null) {
            throw new RosterStorageError('ROSTER_LOCK_STALE_PROCESS_UNPROVEN', `writer lock disappeared before release: ${this.path}`);
        }
        const parsed = parseLockRecord(existing.bytes, this.path);
        if (parsed.token !== this.record.token) {
            throw new RosterStorageError('ROSTER_LOCK_STALE_PROCESS_UNPROVEN', `writer lock token changed before release: ${this.path}`);
        }
        await unlink(this.path);
        await fsyncDirectory(dirname(this.path), this.#authorityRoot);
        await emitStage(this.#hooks, { stage: 'after-lock-release', path: this.path });
        this.#released = true;
    }
}
export function assertRosterStorageNodeGuarantees(input = {}) {
    const platform = input.platform ?? process.platform;
    if (platform === 'win32') {
        throw new RosterStorageError('ROSTER_STORAGE_UNSUPPORTED_PLATFORM', 'Phase 37 roster storage requires POSIX no-follow/private-mode/fsync guarantees; Windows ACL binding is not implemented in this storage core');
    }
    const getuid = input.getuid ?? process.getuid;
    if (typeof getuid !== 'function') {
        throw new RosterStorageError('ROSTER_STORAGE_UNSUPPORTED_PLATFORM', 'process.getuid() is unavailable; cannot verify owner-controlled roster authority files');
    }
    const noFollow = input.noFollowFlag ?? fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== 'number' || noFollow === 0) {
        throw new RosterStorageError('ROSTER_STORAGE_UNSUPPORTED_PLATFORM', 'O_NOFOLLOW is unavailable');
    }
}
export async function ensurePrivateDirectory(path, authorityRoot) {
    assertRosterStorageNodeGuarantees();
    const dirPath = normalizeAbsolutePath(path, 'directory path');
    const root = normalizeAbsolutePath(authorityRoot, 'authority root');
    if (!pathIsInsideOrEqual(root, dirPath)) {
        throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `${dirPath} is outside authority root ${root}`);
    }
    const { rootPath, segments } = splitAbsolutePath(dirPath);
    let current = rootPath;
    for (const segment of segments) {
        if (segment === '.' || segment === '..' || segment.includes('\0')) {
            throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `unsafe directory segment ${segment}`);
        }
        const next = join(current, segment);
        let created = false;
        let stats = lstatIfPresent(next);
        if (stats === null) {
            await mkdir(next, { mode: ROSTER_PRIVATE_DIR_MODE });
            chmodSync(next, ROSTER_PRIVATE_DIR_MODE);
            await fsyncDirectory(current, root, { allowOutsideAuthorityRoot: true });
            created = true;
            stats = lstatSync(next);
        }
        if (stats.isSymbolicLink()) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `directory path contains symlink: ${next}`);
        }
        if (!stats.isDirectory()) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority directory is not a directory: ${next}`);
        }
        if (pathIsInsideOrEqual(root, next)) {
            assertOwned(next, stats);
            if (created) {
                chmodSync(next, ROSTER_PRIVATE_DIR_MODE);
                stats = lstatSync(next);
            }
            assertPrivateMode(next, stats, ROSTER_PRIVATE_DIR_MODE, 'directory');
        }
        current = next;
    }
}
export async function validateExistingAuthorityDirectory(path, authorityRoot) {
    assertRosterStorageNodeGuarantees();
    const dirPath = normalizeAbsolutePath(path, 'directory path');
    const root = normalizeAbsolutePath(authorityRoot, 'authority root');
    if (!pathIsInsideOrEqual(root, dirPath)) {
        throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `${dirPath} is outside authority root ${root}`);
    }
    const stats = lstatSync(dirPath);
    if (stats.isSymbolicLink()) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority directory is a symlink: ${dirPath}`);
    }
    if (!stats.isDirectory()) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority path is not a directory: ${dirPath}`);
    }
    assertOwned(dirPath, stats);
    assertPrivateMode(dirPath, stats, ROSTER_PRIVATE_DIR_MODE, 'directory');
}
export async function readAuthorityFileIfPresent(path, authorityRoot) {
    assertRosterStorageNodeGuarantees();
    const filePath = normalizeAbsolutePath(path, 'authority file path');
    const root = normalizeAbsolutePath(authorityRoot, 'authority root');
    assertInsideRoot(filePath, root);
    const parentState = await validateExistingAncestors(dirname(filePath), root);
    if (parentState === 'missing')
        return null;
    const before = lstatIfPresent(filePath);
    if (before === null)
        return null;
    assertAuthorityFileStats(filePath, before);
    const fd = openNoFollowFd(filePath, fsConstants.O_RDONLY);
    try {
        const opened = fstatSync(fd);
        assertAuthorityFileStats(filePath, opened);
        if (before.dev !== opened.dev || before.ino !== opened.ino) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority file changed while opening: ${filePath}`);
        }
        const bytes = readAllFromFd(fd, opened.size);
        const after = fstatSync(fd);
        assertAuthorityFileStats(filePath, after);
        if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority file changed while reading: ${filePath}`);
        }
        return Object.freeze({ path: filePath, bytes });
    }
    finally {
        closeSync(fd);
    }
}
export async function publishReplaceAtomic(input) {
    assertRosterStorageNodeGuarantees();
    const filePath = normalizeAbsolutePath(input.path, 'authority file path');
    const root = normalizeAbsolutePath(input.authorityRoot, 'authority root');
    assertInsideRoot(filePath, root);
    await ensurePrivateDirectory(dirname(filePath), root);
    const existing = lstatIfPresent(filePath);
    if (existing !== null)
        assertAuthorityFileStats(filePath, existing);
    const tempPath = await writeExclusiveTempFile({ path: filePath, authorityRoot: root, bytes: input.bytes, hooks: input.hooks });
    try {
        await emitStage(input.hooks, { stage: 'before-rename', path: filePath, tempPath });
        const current = lstatIfPresent(filePath);
        if (current !== null)
            assertAuthorityFileStats(filePath, current);
        await rename(tempPath, filePath);
        await emitStage(input.hooks, { stage: 'after-rename', path: filePath, tempPath });
        await fsyncDirectory(dirname(filePath), root);
        assertAuthorityFileStats(filePath, lstatSync(filePath));
    }
    catch (error) {
        await cleanupOwnedTemp(tempPath, root);
        throw error;
    }
}
export async function publishCreateOnlyAtomic(input) {
    assertRosterStorageNodeGuarantees();
    const filePath = normalizeAbsolutePath(input.path, 'authority file path');
    const root = normalizeAbsolutePath(input.authorityRoot, 'authority root');
    assertInsideRoot(filePath, root);
    if (await recoverCreateOnlyOrphanTempHardlinkIfPresent({ path: filePath, authorityRoot: root, bytes: input.bytes })) {
        return Object.freeze({ status: 'idempotent', path: filePath });
    }
    const existing = await readAuthorityFileIfPresent(filePath, root);
    if (existing !== null) {
        return bytesEqual(existing.bytes, input.bytes)
            ? Object.freeze({ status: 'idempotent', path: filePath })
            : Object.freeze({ status: 'conflict', path: filePath });
    }
    await ensurePrivateDirectory(dirname(filePath), root);
    const tempPath = await writeExclusiveTempFile({ path: filePath, authorityRoot: root, bytes: input.bytes, hooks: input.hooks });
    try {
        await emitStage(input.hooks, { stage: 'before-link', path: filePath, tempPath });
        await link(tempPath, filePath);
        await emitStage(input.hooks, { stage: 'after-link', path: filePath, tempPath });
        await unlink(tempPath);
        await emitStage(input.hooks, { stage: 'after-temp-unlink', path: filePath, tempPath });
        await fsyncDirectory(dirname(filePath), root);
        assertAuthorityFileStats(filePath, lstatSync(filePath));
        return Object.freeze({ status: 'created', path: filePath });
    }
    catch (error) {
        await cleanupOwnedTemp(tempPath, root);
        if (isErrno(error, 'EEXIST')) {
            const raced = await readAuthorityFileIfPresent(filePath, root);
            if (raced !== null) {
                return bytesEqual(raced.bytes, input.bytes)
                    ? Object.freeze({ status: 'idempotent', path: filePath })
                    : Object.freeze({ status: 'conflict', path: filePath });
            }
        }
        if (isErrno(error, 'EPERM') || isErrno(error, 'ENOTSUP') || isErrno(error, 'ENOSYS')) {
            throw new RosterStorageError('ROSTER_STORAGE_UNSUPPORTED_PLATFORM', `atomic create-only link publication is unavailable for ${filePath}`, error);
        }
        throw error;
    }
}
export async function acquireRosterWriterLock(input) {
    assertRosterStorageNodeGuarantees();
    const lockPath = normalizeAbsolutePath(input.lockPath, 'lock path');
    const root = normalizeAbsolutePath(input.authorityRoot, 'authority root');
    assertInsideRoot(lockPath, root);
    await ensurePrivateDirectory(dirname(lockPath), root);
    await emitStage(input.hooks, { stage: 'before-lock-open', path: lockPath });
    const rootStats = lstatSync(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority root is unsafe: ${root}`);
    }
    assertOwned(root, rootStats);
    assertPrivateMode(root, rootStats, ROSTER_PRIVATE_DIR_MODE, 'directory');
    const record = Object.freeze({
        schema_version: 'autopilot.roster_writer_lock.v1',
        pid: process.pid,
        process_start_time_ms: Date.now(),
        exec_path: process.execPath,
        authority_root: root,
        authority_root_dev: String(rootStats.dev),
        authority_root_ino: String(rootStats.ino),
        token: randomUUID(),
        created_at: new Date().toISOString(),
    });
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
    let fd;
    try {
        fd = openSync(lockPath, flags, ROSTER_PRIVATE_FILE_MODE);
    }
    catch (error) {
        if (isErrno(error, 'EEXIST')) {
            await assertExistingLockIsSafe(lockPath, root);
            throw new RosterStorageError('ROSTER_LOCK_STALE_PROCESS_UNPROVEN', `writer lock already exists and stale age alone is not authority to break it: ${lockPath}`, error);
        }
        throw error;
    }
    try {
        writeAllToFd(fd, bytes);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    await chmod(lockPath, ROSTER_PRIVATE_FILE_MODE);
    assertAuthorityFileStats(lockPath, lstatSync(lockPath));
    await fsyncDirectory(dirname(lockPath), root);
    await emitStage(input.hooks, { stage: 'after-lock-write', path: lockPath });
    return new RosterWriterLock({ path: lockPath, authorityRoot: root, record, hooks: input.hooks });
}
async function writeExclusiveTempFile(input) {
    const filePath = normalizeAbsolutePath(input.path, 'authority file path');
    const root = normalizeAbsolutePath(input.authorityRoot, 'authority root');
    const parent = dirname(filePath);
    const tempPath = join(parent, `.${basename(filePath)}.tmp-${String(process.pid)}-${randomUUID()}`);
    await emitStage(input.hooks, { stage: 'before-temp-open', path: filePath, tempPath });
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
    let fd = null;
    try {
        fd = openSync(tempPath, flags, ROSTER_PRIVATE_FILE_MODE);
        await emitStage(input.hooks, { stage: 'after-temp-open', path: filePath, tempPath });
        writeAllToFd(fd, input.bytes);
        chmodSync(tempPath, ROSTER_PRIVATE_FILE_MODE);
        await emitStage(input.hooks, { stage: 'after-temp-write', path: filePath, tempPath });
        fsyncSync(fd);
        await emitStage(input.hooks, { stage: 'after-temp-fsync', path: filePath, tempPath });
    }
    catch (error) {
        if (fd !== null)
            closeSync(fd);
        await cleanupOwnedTemp(tempPath, root);
        throw error;
    }
    closeSync(fd);
    assertAuthorityFileStats(tempPath, lstatSync(tempPath));
    return tempPath;
}
async function recoverCreateOnlyOrphanTempHardlinkIfPresent(input) {
    const filePath = normalizeAbsolutePath(input.path, 'authority file path');
    const root = normalizeAbsolutePath(input.authorityRoot, 'authority root');
    assertInsideRoot(filePath, root);
    const parentState = await validateExistingAncestors(dirname(filePath), root);
    if (parentState === 'missing')
        return false;
    const before = lstatIfPresent(filePath);
    if (before === null || before.nlink === 1)
        return false;
    assertAuthorityFileBaseStats(filePath, before);
    assertAuthorityHardlinkCount(filePath, before, 2);
    const fd = openNoFollowFd(filePath, fsConstants.O_RDONLY);
    let existingBytes;
    try {
        const opened = fstatSync(fd);
        assertAuthorityFileBaseStats(filePath, opened);
        assertSameFileIdentity(filePath, before, opened);
        assertAuthorityHardlinkCount(filePath, opened, 2);
        existingBytes = readAllFromFd(fd, opened.size);
        const afterRead = fstatSync(fd);
        assertAuthorityFileBaseStats(filePath, afterRead);
        assertSameFileIdentity(filePath, opened, afterRead);
        assertAuthorityHardlinkCount(filePath, afterRead, 2);
        if (opened.size !== afterRead.size) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority file changed size while proving orphan temp hardlink: ${filePath}`);
        }
    }
    finally {
        closeSync(fd);
    }
    if (!bytesEqual(existingBytes, input.bytes)) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `create-only orphan hardlink bytes do not match replay bytes: ${filePath}`);
    }
    const tempPath = await findCreateOnlyOrphanTempHardlink(filePath, root, before);
    await unlink(tempPath);
    await fsyncDirectory(dirname(filePath), root);
    assertAuthorityFileStats(filePath, lstatSync(filePath));
    return true;
}
async function findCreateOnlyOrphanTempHardlink(filePath, authorityRoot, finalStats) {
    const parent = dirname(filePath);
    const names = await readdir(parent);
    const matches = [];
    for (const name of names) {
        if (!isCreateOnlyTempName(name, basename(filePath)))
            continue;
        const candidatePath = join(parent, name);
        assertInsideRoot(candidatePath, authorityRoot);
        const candidateStats = lstatIfPresent(candidatePath);
        if (candidateStats === null)
            continue;
        assertAuthorityFileBaseStats(candidatePath, candidateStats);
        if (candidateStats.dev !== finalStats.dev || candidateStats.ino !== finalStats.ino)
            continue;
        assertAuthorityHardlinkCount(candidatePath, candidateStats, 2);
        matches.push(candidatePath);
    }
    if (matches.length !== 1) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `create-only orphan temp hardlink is unproven for: ${filePath}`);
    }
    return matches[0] ?? unreachableTempPath(filePath);
}
function isCreateOnlyTempName(name, finalBase) {
    const prefix = `.${finalBase}.tmp-`;
    if (!name.startsWith(prefix))
        return false;
    const rest = name.slice(prefix.length);
    const separator = rest.indexOf('-');
    if (separator <= 0)
        return false;
    const pid = rest.slice(0, separator);
    const uuid = rest.slice(separator + 1);
    return /^[1-9][0-9]*$/u.test(pid) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid);
}
function unreachableTempPath(filePath) {
    throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `create-only orphan temp hardlink disappeared for: ${filePath}`);
}
async function cleanupOwnedTemp(tempPath, authorityRoot) {
    const root = normalizeAbsolutePath(authorityRoot, 'authority root');
    const normalized = normalizeAbsolutePath(tempPath, 'temp path');
    if (!pathIsInsideOrEqual(root, normalized))
        return;
    const stats = lstatIfPresent(normalized);
    if (stats === null)
        return;
    if (stats.isSymbolicLink() || !stats.isFile())
        return;
    try {
        assertOwned(normalized, stats);
        if ((stats.mode & 0o777) !== ROSTER_PRIVATE_FILE_MODE)
            return;
        await rm(normalized, { force: true });
        await fsyncDirectory(dirname(normalized), root).catch(() => undefined);
    }
    catch {
        return;
    }
}
async function fsyncDirectory(path, authorityRoot, options = {}) {
    assertRosterStorageNodeGuarantees();
    const dirPath = normalizeAbsolutePath(path, 'directory path');
    const root = normalizeAbsolutePath(authorityRoot, 'authority root');
    if (!options.allowOutsideAuthorityRoot)
        assertInsideRoot(dirPath, root);
    const stats = lstatSync(dirPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `cannot fsync unsafe directory: ${dirPath}`);
    }
    if (pathIsInsideOrEqual(root, dirPath)) {
        assertOwned(dirPath, stats);
        assertPrivateMode(dirPath, stats, ROSTER_PRIVATE_DIR_MODE, 'directory');
    }
    const directoryFlag = fsConstants.O_DIRECTORY ?? 0;
    const fd = openNoFollowFd(dirPath, fsConstants.O_RDONLY | directoryFlag);
    try {
        fsyncSync(fd);
    }
    catch (error) {
        throw new RosterStorageError('ROSTER_STORAGE_UNSUPPORTED_PLATFORM', `directory fsync is unavailable for ${dirPath}`, error);
    }
    finally {
        closeSync(fd);
    }
}
async function validateExistingAncestors(path, authorityRoot) {
    const dirPath = normalizeAbsolutePath(path, 'ancestor path');
    const root = normalizeAbsolutePath(authorityRoot, 'authority root');
    assertInsideRoot(dirPath, root);
    const { rootPath, segments } = splitAbsolutePath(dirPath);
    let current = rootPath;
    for (const segment of segments) {
        current = join(current, segment);
        const stats = lstatIfPresent(current);
        if (stats === null)
            return 'missing';
        if (stats.isSymbolicLink()) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `ancestor path contains symlink: ${current}`);
        }
        if (!stats.isDirectory()) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `ancestor path is not a directory: ${current}`);
        }
        if (pathIsInsideOrEqual(root, current)) {
            assertOwned(current, stats);
            assertPrivateMode(current, stats, ROSTER_PRIVATE_DIR_MODE, 'directory');
        }
    }
    return 'present';
}
async function assertExistingLockIsSafe(lockPath, authorityRoot) {
    const existing = await readAuthorityFileIfPresent(lockPath, authorityRoot);
    if (existing === null) {
        throw new RosterStorageError('ROSTER_LOCK_STALE_PROCESS_UNPROVEN', `writer lock raced during inspection: ${lockPath}`);
    }
    parseLockRecord(existing.bytes, lockPath);
}
function parseLockRecord(bytes, path) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
    catch (error) {
        throw new RosterStorageError('ROSTER_LOCK_STALE_PROCESS_UNPROVEN', `writer lock is not valid JSON: ${path}`, error);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new RosterStorageError('ROSTER_LOCK_STALE_PROCESS_UNPROVEN', `writer lock is not an object: ${path}`);
    }
    const record = parsed;
    if (record.schema_version !== 'autopilot.roster_writer_lock.v1' ||
        typeof record.pid !== 'number' ||
        typeof record.process_start_time_ms !== 'number' ||
        typeof record.exec_path !== 'string' ||
        typeof record.authority_root !== 'string' ||
        typeof record.authority_root_dev !== 'string' ||
        typeof record.authority_root_ino !== 'string' ||
        typeof record.token !== 'string' ||
        typeof record.created_at !== 'string') {
        throw new RosterStorageError('ROSTER_LOCK_STALE_PROCESS_UNPROVEN', `writer lock record is incomplete: ${path}`);
    }
    return Object.freeze({
        schema_version: 'autopilot.roster_writer_lock.v1',
        pid: record.pid,
        process_start_time_ms: record.process_start_time_ms,
        exec_path: record.exec_path,
        authority_root: record.authority_root,
        authority_root_dev: record.authority_root_dev,
        authority_root_ino: record.authority_root_ino,
        token: record.token,
        created_at: record.created_at,
    });
}
function assertAuthorityFileStats(path, stats) {
    assertAuthorityFileBaseStats(path, stats);
    assertAuthorityHardlinkCount(path, stats, 1);
}
function assertAuthorityFileBaseStats(path, stats) {
    if (stats.isSymbolicLink()) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority file is a symlink: ${path}`);
    }
    if (!stats.isFile()) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority path is not a regular file: ${path}`);
    }
    assertOwned(path, stats);
    assertPrivateMode(path, stats, ROSTER_PRIVATE_FILE_MODE, 'file');
}
function assertAuthorityHardlinkCount(path, stats, expected) {
    if (stats.nlink !== expected) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority file hardlink count for ${path} must be ${String(expected)}, got ${String(stats.nlink)}`);
    }
}
function assertSameFileIdentity(path, before, after) {
    if (before.dev !== after.dev || before.ino !== after.ino) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `authority file identity changed while proving orphan temp hardlink: ${path}`);
    }
}
function assertOwned(path, stats) {
    const getuid = process.getuid;
    if (typeof getuid !== 'function') {
        throw new RosterStorageError('ROSTER_STORAGE_UNSUPPORTED_PLATFORM', 'process.getuid() is unavailable');
    }
    const uid = getuid();
    if (stats.uid !== uid) {
        throw new RosterStorageError('ROSTER_STORAGE_PERMISSION_DENIED', `authority path is not owned by the current user: ${path}`);
    }
}
function assertPrivateMode(path, stats, expected, kind) {
    const mode = stats.mode & 0o777;
    if (mode !== expected) {
        throw new RosterStorageError('ROSTER_STORAGE_PERMISSION_DENIED', `${kind} mode for ${path} must be ${expected.toString(8)}, got ${mode.toString(8)}`);
    }
}
function assertInsideRoot(path, authorityRoot) {
    if (!pathIsInsideOrEqual(authorityRoot, path)) {
        throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `${path} escapes authority root ${authorityRoot}`);
    }
}
function openNoFollowFd(path, flags, mode) {
    assertRosterStorageNodeGuarantees();
    try {
        return mode === undefined ? openSync(path, flags | fsConstants.O_NOFOLLOW) : openSync(path, flags | fsConstants.O_NOFOLLOW, mode);
    }
    catch (error) {
        if (isErrno(error, 'ELOOP')) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `refusing to follow symlink: ${path}`, error);
        }
        throw error;
    }
}
function lstatIfPresent(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        throw error;
    }
}
function readAllFromFd(fd, size) {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
        if (bytesRead === 0)
            break;
        offset += bytesRead;
    }
    if (offset !== size) {
        throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', `short authority read: expected ${String(size)} bytes, got ${String(offset)}`);
    }
    return buffer;
}
function writeAllToFd(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) {
            throw new RosterStorageError('ROSTER_STORAGE_AUTHORITY_UNSAFE', 'short authority write');
        }
        offset += written;
    }
}
async function emitStage(hooks, event) {
    if (hooks?.onStage === undefined)
        return;
    await hooks.onStage(event);
}
function normalizeAbsolutePath(value, label) {
    if (value.length === 0 || value.includes('\0')) {
        throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `${label} must be a non-empty path without NUL`);
    }
    const resolved = resolve(value);
    if (!isAbsolute(resolved)) {
        throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `${label} must be absolute: ${value}`);
    }
    return resolved;
}
function splitAbsolutePath(path) {
    const resolved = normalizeAbsolutePath(path, 'path');
    const rootPath = resolved.startsWith(sep) ? sep : resolve(sep);
    const relativePath = resolved.startsWith(rootPath) ? resolved.slice(rootPath.length) : relative(rootPath, resolved);
    return Object.freeze({ rootPath, segments: Object.freeze(relativePath.split(sep).filter((part) => part.length > 0)) });
}
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let index = 0; index < a.length; index += 1) {
        diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
    }
    return diff === 0;
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
