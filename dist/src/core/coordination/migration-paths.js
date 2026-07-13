import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { CoordinationRuntimeError } from "./failures.js";
import { currentBootId, isProcessAlive } from "./process-identity.js";
import { COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_PACKAGE_BUILD } from "./runtime-constants.js";
import { enforceWindowsPrivateAcl, hardenRuntimeAuthorityBeforeMarkerRead } from "../private-path.js";
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION } from "./types.js";
export const COORDINATION_MIGRATION_JOURNAL_SCHEMA = 'autopilot.coordination_migration_journal.v1';
export const COORDINATION_CUTOVER_MARKER_SCHEMA = 'autopilot.coordination_cutover.v1';
export const COORDINATION_FREEZE_SCHEMA = 'autopilot.coordination_freeze.v1';
export const COORDINATION_FREEZE_ACK_SCHEMA = 'autopilot.coordination_freeze_ack.v1';
function pathInside(root, candidate) {
    const rel = relative(resolve(root), resolve(candidate));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/**
 * Rejects lexical escape, symlinks/junctions in every existing package-owned
 * component, and physical escape through an existing ancestor. The state root
 * itself may be absent, but if present it must be a real directory rather than
 * an alias. This intentionally uses path/realpath APIs instead of inode-only
 * assumptions so it has the same fail-closed behavior on Windows.
 */
export function assertMigrationPathSafe(stateRoot, candidate, label) {
    const root = resolve(stateRoot);
    const target = resolve(candidate);
    if (!pathInside(root, target))
        throw new CoordinationRuntimeError('invalid-state', `${label} escapes the migration state root lexically`, [target, root]);
    if (!existsSync(root)) {
        let ancestor = dirname(root);
        while (!existsSync(ancestor)) {
            const parent = dirname(ancestor);
            if (parent === ancestor)
                throw new CoordinationRuntimeError('invalid-state', `${label} has no existing physical state-root ancestor`, [root]);
            ancestor = parent;
        }
        const info = lstatSync(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new CoordinationRuntimeError('invalid-state', `${label} state-root ancestor is not a real directory`, [ancestor]);
        return;
    }
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new CoordinationRuntimeError('invalid-state', `${label} state root must be a real non-symbolic directory`, [root]);
    const physicalRoot = realpathSync(root);
    const rel = relative(root, target);
    let current = root;
    for (const component of rel === '' ? [] : rel.split(sep)) {
        current = join(current, component);
        if (!existsSync(current))
            break;
        const info = lstatSync(current);
        if (info.isSymbolicLink())
            throw new CoordinationRuntimeError('invalid-state', `${label} has a symbolic-link or junction component`, [current]);
        const physical = realpathSync(current);
        if (!pathInside(physicalRoot, physical))
            throw new CoordinationRuntimeError('invalid-state', `${label} escapes the migration state root physically`, [current, physical, physicalRoot]);
    }
}
export function coordinationGlobalMigrationLockPath(stateRoot) {
    const canonicalStateRoot = resolve(stateRoot);
    const identity = createHash('sha256').update(canonicalStateRoot, 'utf8').digest('hex').slice(0, 32);
    return join(dirname(canonicalStateRoot), `.autopilot-coordination-migration-${identity}.lock`);
}
function migrationPathsForStateRoot(stateRoot, repoKey) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,191}$/u.test(repoKey))
        throw new CoordinationRuntimeError('invalid-request', 'migration repo key is invalid');
    hardenRuntimeAuthorityBeforeMarkerRead(stateRoot, repoKey);
    const root = join(stateRoot, 'migrations', repoKey);
    const paths = {
        root,
        journalPath: join(root, 'journal.json'),
        freezePath: join(root, 'freeze.json'),
        freezeAckRoot: join(root, 'freeze-acks'),
        lockPath: join(root, 'migration.lock'),
        snapshotRoot: join(root, 'snapshot'),
        archiveRoot: join(root, 'legacy-archive'),
        cutoverMarkerPath: join(stateRoot, 'cutovers', `${repoKey}.json`),
    };
    for (const [name, path] of Object.entries(paths))
        assertMigrationPathSafe(stateRoot, path, `coordination migration ${name}`);
    return paths;
}
export function coordinationMigrationPaths(paths, repoKey) {
    return migrationPathsForStateRoot(paths.stateRoot, repoKey);
}
function record(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} must be an object`);
    return value;
}
function readRegularJsonNoFollow(path, label) {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024)
        throw new CoordinationRuntimeError('invalid-state', `${label} must be a bounded regular non-symbolic file`, [path]);
    const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
            throw new CoordinationRuntimeError('invalid-state', `${label} identity changed while opening`, [path]);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(descriptor));
        const after = lstatSync(path);
        if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size)
            throw new CoordinationRuntimeError('invalid-state', `${label} identity changed while reading`, [path]);
        return JSON.parse(text);
    }
    catch (error) {
        if (error instanceof CoordinationRuntimeError)
            throw error;
        throw new CoordinationRuntimeError('invalid-state', `${label} is unreadable`, [path, error instanceof Error ? error.message : String(error)]);
    }
    finally {
        closeSync(descriptor);
    }
}
function readFreeze(path) {
    const parsed = readRegularJsonNoFollow(path, 'coordination migration freeze');
    const value = record(parsed, 'coordination migration freeze');
    if (value['schema_version'] !== COORDINATION_FREEZE_SCHEMA || typeof value['repo_key'] !== 'string' || typeof value['migration_id'] !== 'string' || typeof value['freeze_token'] !== 'string')
        throw new CoordinationRuntimeError('invalid-state', 'coordination migration freeze identity is invalid', [path]);
    return value;
}
function durableLegacyFreezeAck(stateRoot, repoKey, freezePath) {
    const freeze = readFreeze(freezePath);
    if (freeze['repo_key'] !== repoKey)
        throw new CoordinationRuntimeError('invalid-state', 'coordination migration freeze repository identity is mismatched', [freezePath]);
    const paths = migrationPathsForStateRoot(stateRoot, repoKey);
    assertMigrationPathSafe(stateRoot, paths.freezeAckRoot, 'coordination freeze acknowledgement directory');
    mkdirSync(paths.freezeAckRoot, { recursive: true, mode: 0o700 });
    if (platform() === 'win32')
        enforceWindowsPrivateAcl(paths.freezeAckRoot, true);
    else
        chmodSync(paths.freezeAckRoot, 0o700);
    assertMigrationPathSafe(stateRoot, paths.freezeAckRoot, 'coordination freeze acknowledgement directory');
    const bootId = currentBootId();
    const file = join(paths.freezeAckRoot, `${String(process.pid)}-${createSafeName(bootId)}-${createSafeName(String(freeze['migration_id']))}-${createSafeName(String(freeze['freeze_token'])).slice(0, 24)}.json`);
    assertMigrationPathSafe(stateRoot, file, 'coordination freeze acknowledgement');
    const acknowledgement = {
        schema_version: COORDINATION_FREEZE_ACK_SCHEMA,
        repo_key: repoKey,
        migration_id: String(freeze['migration_id']),
        freeze_token: String(freeze['freeze_token']),
        client_kind: 'legacy-package-client',
        pid: process.pid,
        boot_id: bootId,
        package_build: COORDINATOR_PACKAGE_BUILD,
        protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
        database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION,
        drain_state: 'dispatch-stopped',
        critical_section: null,
        acknowledged_at: new Date().toISOString(),
    };
    if (existsSync(file)) {
        let existing;
        try {
            existing = JSON.parse(readFileSync(file, 'utf8'));
        }
        catch (error) {
            throw new CoordinationRuntimeError('invalid-state', 'existing coordination freeze acknowledgement is unreadable', [file, error instanceof Error ? error.message : String(error)]);
        }
        const row = record(existing, 'existing coordination freeze acknowledgement');
        if (row['schema_version'] !== acknowledgement.schema_version || row['repo_key'] !== acknowledgement.repo_key || row['migration_id'] !== acknowledgement.migration_id || row['freeze_token'] !== acknowledgement.freeze_token || row['pid'] !== acknowledgement.pid || row['boot_id'] !== acknowledgement.boot_id || row['drain_state'] !== 'dispatch-stopped' || row['critical_section'] !== null)
            throw new CoordinationRuntimeError('invalid-state', 'existing coordination freeze acknowledgement identity is mismatched', [file]);
        return;
    }
    const temporary = `${file}.tmp-${randomBytes(8).toString('hex')}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
        writeSync(fd, `${JSON.stringify(acknowledgement, null, 2)}\n`);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        linkSync(temporary, file);
    }
    catch (error) {
        unlinkSync(temporary);
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            durableLegacyFreezeAck(stateRoot, repoKey, freezePath);
            return;
        }
        throw error;
    }
    unlinkSync(temporary);
    if (platform() === 'win32')
        enforceWindowsPrivateAcl(file, false);
    else
        chmodSync(file, 0o600);
    if (platform() !== 'win32') {
        const directoryFd = openSync(dirname(file), fsConstants.O_RDONLY);
        try {
            fsyncSync(directoryFd);
        }
        finally {
            closeSync(directoryFd);
        }
    }
    assertMigrationPathSafe(stateRoot, file, 'coordination freeze acknowledgement');
}
function createSafeName(value) {
    return value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 96) || 'unknown-boot';
}
export function readCoordinationCutoverMarker(path, expectedRepoKey, stateRoot) {
    if (stateRoot !== undefined && expectedRepoKey !== undefined)
        hardenRuntimeAuthorityBeforeMarkerRead(stateRoot, expectedRepoKey);
    if (stateRoot !== undefined)
        assertMigrationPathSafe(stateRoot, path, 'coordination cutover marker');
    if (!existsSync(path))
        return null;
    const parsed = readRegularJsonNoFollow(path, 'coordination cutover marker');
    const value = record(parsed, 'coordination cutover marker');
    const fields = ['committed_at', 'database_sha256', 'migration_id', 'repo_key', 'schema_version', 'snapshot_sha256'];
    const unknownFields = Object.keys(value).filter((field) => !fields.includes(field));
    if (unknownFields.length > 0 || fields.some((field) => !(field in value)))
        throw new CoordinationRuntimeError('invalid-state', 'coordination cutover marker has an invalid closed shape', [path]);
    const repoKey = value['repo_key'];
    const snapshot = value['snapshot_sha256'];
    const database = value['database_sha256'];
    const committedAt = value['committed_at'];
    const migrationId = value['migration_id'];
    if (value['schema_version'] !== COORDINATION_CUTOVER_MARKER_SCHEMA || typeof repoKey !== 'string' || typeof snapshot !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(snapshot) || typeof database !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(database) || typeof committedAt !== 'string' || Number.isNaN(Date.parse(committedAt)) || typeof migrationId !== 'string' || migrationId.length === 0)
        throw new CoordinationRuntimeError('invalid-state', 'coordination cutover marker fields are invalid', [path]);
    if (expectedRepoKey !== undefined && repoKey !== expectedRepoKey)
        throw new CoordinationRuntimeError('invalid-state', 'coordination cutover marker repository identity is mismatched', [path, repoKey, expectedRepoKey]);
    return { schema_version: COORDINATION_CUTOVER_MARKER_SCHEMA, repo_key: repoKey, snapshot_sha256: snapshot, database_sha256: database, committed_at: committedAt, migration_id: migrationId };
}
export function activeCoordinationMigrationFreeze(stateRoot) {
    const migrationsRoot = join(stateRoot, 'migrations');
    assertMigrationPathSafe(stateRoot, migrationsRoot, 'coordination migrations root');
    if (!existsSync(migrationsRoot))
        return null;
    const freezes = [];
    for (const entry of readdirSync(migrationsRoot, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            throw new CoordinationRuntimeError('invalid-state', 'migration root contains a symbolic-link repository entry', [join(migrationsRoot, entry.name)]);
        if (entry.isDirectory()) {
            const freeze = join(migrationsRoot, entry.name, 'freeze.json');
            assertMigrationPathSafe(stateRoot, freeze, 'coordination migration freeze');
            if (existsSync(freeze))
                freezes.push(freeze);
        }
    }
    if (freezes.length > 1)
        throw new CoordinationRuntimeError('invalid-state', 'multiple global coordination migration freezes are active', freezes.sort());
    return freezes[0] ?? null;
}
export function acknowledgeCoordinationMigrationFreeze(stateRoot, repoKey) {
    const paths = migrationPathsForStateRoot(stateRoot, repoKey);
    if (!existsSync(paths.freezePath))
        return false;
    durableLegacyFreezeAck(stateRoot, repoKey, paths.freezePath);
    return true;
}
export function assertCoordinationMigrationRecoveryOperationAuthorized(stateRoot, operationToken) {
    const globalLockPath = coordinationGlobalMigrationLockPath(stateRoot);
    const authorizationPath = join(stateRoot, 'migrations', '.recovery-operation.json');
    assertMigrationPathSafe(dirname(resolve(stateRoot)), globalLockPath, 'global migration operation lock');
    assertMigrationPathSafe(stateRoot, authorizationPath, 'migration recovery operation authorization');
    if (!existsSync(globalLockPath) || !existsSync(authorizationPath))
        throw new CoordinationRuntimeError('coordinator-contention', 'migration recovery mutation lacks the serialized global recovery operation authority', [globalLockPath, authorizationPath]);
    const operationLock = record(readRegularJsonNoFollow(globalLockPath, 'global migration operation lock'), 'global migration operation lock');
    const authorization = record(readRegularJsonNoFollow(authorizationPath, 'migration recovery operation authorization'), 'migration recovery operation authorization');
    if (operationLock['schema_version'] !== 'autopilot.coordination_migration_lock.v1' || authorization['schema_version'] !== 'autopilot.coordination_recovery_operation.v1' || operationLock['pid'] !== authorization['pid'] || operationLock['boot_id'] !== authorization['boot_id'] || operationLock['token'] !== authorization['token'] || operationToken !== authorization['token'] || authorization['boot_id'] !== currentBootId() || typeof authorization['pid'] !== 'number' || !Number.isSafeInteger(authorization['pid']) || !isProcessAlive(authorization['pid']))
        throw new CoordinationRuntimeError('coordinator-contention', 'migration recovery operation authority is stale, mismatched, or not bound to this request', [globalLockPath, authorizationPath]);
}
export function assertCoordinationFrozenMutationAllowed(stateRoot, repoKey, action, operationToken) {
    const freezePath = activeCoordinationMigrationFreeze(stateRoot);
    if (freezePath === null)
        return;
    const freeze = readFreeze(freezePath);
    const journalPath = join(dirname(freezePath), 'journal.json');
    assertMigrationPathSafe(stateRoot, journalPath, 'coordination migration journal for mutation fence');
    if (!existsSync(journalPath))
        throw new CoordinationRuntimeError('invalid-state', 'global coordination freeze has no durable migration journal', [freezePath, journalPath]);
    const journal = record(readRegularJsonNoFollow(journalPath, 'coordination migration journal for mutation fence'), 'coordination migration journal for mutation fence');
    if (journal['schema_version'] !== COORDINATION_MIGRATION_JOURNAL_SCHEMA || journal['repo_key'] !== freeze['repo_key'] || journal['migration_id'] !== freeze['migration_id'] || !Array.isArray(journal['completed_effects']) || typeof journal['state'] !== 'string')
        throw new CoordinationRuntimeError('invalid-state', 'global coordination freeze and migration journal identities disagree', [freezePath, journalPath]);
    const effects = journal['completed_effects'];
    if (!effects.every((value) => typeof value === 'string'))
        throw new CoordinationRuntimeError('invalid-state', 'coordination migration journal completed effects are malformed', [journalPath]);
    const preAuthorityDrainActions = new Set(['detach-session', 'heartbeat', 'heartbeat-child', 'checkpoint-child', 'complete-child', 'record-release-evidence', 'cancel-run-terminal', 'reconcile-run', 'transition-operation']);
    if (!effects.includes('freeze-drain-complete')) {
        if (preAuthorityDrainActions.has(action))
            return;
        throw new CoordinationRuntimeError('coordinator-contention', `coordinator mutation ${action} refused: migration freeze is active and the global drain is incomplete`, [freezePath]);
    }
    const recoveryActions = new Set(['attach-migration-recovery', 'resolve-migration-recovery', 'detach-session', 'heartbeat']);
    if (repoKey === freeze['repo_key'] && ['imported', 'verified', 'cutover-ready'].includes(journal['state']) && recoveryActions.has(action)) {
        assertCoordinationMigrationRecoveryOperationAuthorized(stateRoot, operationToken);
        return;
    }
    throw new CoordinationRuntimeError('coordinator-contention', `coordinator mutation ${action} refused after global migration writer authority was acquired`, [freezePath, String(freeze['repo_key'])]);
}
export function assertCoordinationDispatchAllowed(stateRoot, repoKey, operation) {
    const paths = migrationPathsForStateRoot(stateRoot, repoKey);
    const globalFreeze = activeCoordinationMigrationFreeze(stateRoot);
    if (globalFreeze !== null)
        throw new CoordinationRuntimeError('coordinator-contention', `${operation} refused: a global coordination migration freeze is active`, [globalFreeze]);
    if (existsSync(paths.freezePath))
        throw new CoordinationRuntimeError('coordinator-contention', `${operation} refused: coordination migration freeze is active`, [paths.freezePath]);
}
export function assertLegacyCoordinationWritable(stateRoot, repoKey, operation) {
    const paths = migrationPathsForStateRoot(stateRoot, repoKey);
    const marker = readCoordinationCutoverMarker(paths.cutoverMarkerPath, repoKey, stateRoot);
    if (marker !== null)
        throw new CoordinationRuntimeError('unauthorized-client', `${operation} refused: repository coordination cutover is committed and legacy files are a read-only archive`, [paths.cutoverMarkerPath]);
    if (existsSync(paths.freezePath))
        acknowledgeCoordinationMigrationFreeze(stateRoot, repoKey);
    assertCoordinationDispatchAllowed(stateRoot, repoKey, operation);
}
export function coordinationCutoverCommitted(stateRoot, repoKey) {
    const markerPath = join(stateRoot, 'cutovers', `${repoKey}.json`);
    return readCoordinationCutoverMarker(markerPath, repoKey, stateRoot) !== null;
}
