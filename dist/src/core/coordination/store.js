import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';
import { parseCoordinationChildLease, parseCoordinationMessage, parseCoordinationRepository, parseCoordinationRun, parseCoordinationSessionLease } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { COORDINATOR_BUSY_TIMEOUT_MS, COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_PACKAGE_BUILD } from "./runtime-paths.js";
const DATABASE_EXPORT_SCHEMA = 'autopilot.coordinator_export.v1';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const systemClock = { now: () => new Date() };
const MIGRATION_1 = `
CREATE TABLE repositories (
  repo_id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL UNIQUE,
  canonical_root TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  version INTEGER NOT NULL CHECK(version >= 1)
) STRICT;
CREATE TABLE runs (
  repo_id TEXT NOT NULL,
  autopilot_id TEXT NOT NULL,
  workstream TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  status TEXT NOT NULL,
  active_session_generation INTEGER NOT NULL DEFAULT 0 CHECK(active_session_generation >= 0),
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  version INTEGER NOT NULL CHECK(version >= 1),
  PRIMARY KEY(repo_id, workstream_run),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE session_leases (
  session_lease_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_generation INTEGER NOT NULL CHECK(session_generation >= 1),
  pid INTEGER NOT NULL CHECK(pid >= 1),
  boot_id TEXT NOT NULL,
  session_token_sha256 TEXT NOT NULL CHECK(length(session_token_sha256) = 64),
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attached_event_seq INTEGER NOT NULL CHECK(attached_event_seq >= 1),
  version INTEGER NOT NULL CHECK(version >= 1),
  UNIQUE(repo_id, workstream_run, session_id, session_generation),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE TABLE child_leases (
  child_lease_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  autopilot_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  pid INTEGER NOT NULL CHECK(pid >= 1),
  boot_id TEXT NOT NULL,
  child_token_sha256 TEXT NOT NULL CHECK(length(child_token_sha256) = 64),
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  terminal_evidence_ref TEXT,
  terminal_evidence_sha256 TEXT,
  version INTEGER NOT NULL CHECK(version >= 1),
  UNIQUE(repo_id, workstream_run, unit_id, attempt),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE TABLE unit_attempts (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE edit_leases (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE change_reservations (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE claim_requests (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, requester_workstream_run TEXT NOT NULL, owner_workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, requester_workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT, FOREIGN KEY(repo_id, owner_workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  recipient_workstream_run TEXT NOT NULL,
  message_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  delivered_event_seq INTEGER,
  acknowledged_event_seq INTEGER,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, recipient_workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE TABLE worktrees (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE worktree_operations (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE merge_operations (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE escalations (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT) STRICT;
CREATE TABLE handoffs (
  handoff_token TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  from_session_lease_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  consumed_event_seq INTEGER,
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT,
  FOREIGN KEY(from_session_lease_id) REFERENCES session_leases(session_lease_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE events (
  repo_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK(event_seq >= 1),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(repo_id, event_seq),
  UNIQUE(repo_id, idempotency_key),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE idempotency_results (
  repo_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  committed_event_seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(repo_id, idempotency_key),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_sessions_run_status ON session_leases(repo_id, workstream_run, status);
CREATE INDEX idx_children_run_status ON child_leases(repo_id, workstream_run, status);
CREATE INDEX idx_messages_mailbox ON messages(repo_id, recipient_workstream_run, status, created_event_seq);
CREATE INDEX idx_events_entity ON events(repo_id, entity_type, entity_id, event_seq);
`;
function asRow(value, label) {
    if (value === undefined)
        throw new CoordinationRuntimeError('invalid-state', `${label} row is missing`);
    return value;
}
function sqlString(row, field) {
    const value = row[field];
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not text`);
    return value;
}
function sqlNullableString(row, field) {
    const value = row[field];
    if (value === null)
        return null;
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not nullable text`);
    return value;
}
function sqlInteger(row, field) {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
        throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not a safe integer`);
    return value;
}
function payloadString(payload, field) {
    const value = payload[field];
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be text`);
    return value;
}
function payloadNullableString(payload, field) {
    const value = payload[field];
    if (value === null)
        return null;
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be nullable text`);
    return value;
}
function payloadInteger(payload, field) {
    const value = payload[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
        throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be an integer`);
    return value;
}
function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    if (typeof value !== 'object')
        throw new CoordinationRuntimeError('invalid-request', 'request contains a non-JSON value');
    const entries = Object.entries(value).sort((left, right) => left[0].localeCompare(right[0]));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}
function requestDigest(request) {
    const semantic = {
        schema_version: request.schema_version,
        protocol_version: request.protocol_version,
        action: request.action,
        repo_id: request.repo_id,
        workstream_run: request.workstream_run,
        session_id: request.session_id,
        fencing_generation: request.fencing_generation,
        expected_version: request.expected_version,
        payload: request.payload,
    };
    return `sha256:${createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex')}`;
}
function parseJsonObject(text, label) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new CoordinationRuntimeError('store-corrupt', `${label} contains invalid JSON`, [error instanceof Error ? error.message : String(error)]);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('store-corrupt', `${label} is not an object`);
    return value;
}
function repositoryFromRow(row) {
    return parseCoordinationRepository({
        schema_version: 'autopilot.coordination_repository.v1',
        repo_id: sqlString(row, 'repo_id'),
        repo_key: sqlString(row, 'repo_key'),
        canonical_root: sqlString(row, 'canonical_root'),
        git_common_dir: sqlString(row, 'git_common_dir'),
        created_event_seq: sqlInteger(row, 'created_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function runFromRow(row) {
    return parseCoordinationRun({
        schema_version: 'autopilot.coordination_run.v1',
        repo_id: sqlString(row, 'repo_id'),
        autopilot_id: sqlString(row, 'autopilot_id'),
        workstream: sqlString(row, 'workstream'),
        workstream_run: sqlString(row, 'workstream_run'),
        status: sqlString(row, 'status'),
        active_session_generation: sqlInteger(row, 'active_session_generation'),
        created_event_seq: sqlInteger(row, 'created_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function sessionFromRow(row) {
    return parseCoordinationSessionLease({
        schema_version: 'autopilot.session_lease.v1',
        session_lease_id: sqlString(row, 'session_lease_id'),
        repo_id: sqlString(row, 'repo_id'),
        workstream_run: sqlString(row, 'workstream_run'),
        session_id: sqlString(row, 'session_id'),
        session_generation: sqlInteger(row, 'session_generation'),
        pid: sqlInteger(row, 'pid'),
        boot_id: sqlString(row, 'boot_id'),
        lease_expires_at: sqlString(row, 'lease_expires_at'),
        status: sqlString(row, 'status'),
        attached_event_seq: sqlInteger(row, 'attached_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function childFromRow(row) {
    const evidenceRef = sqlNullableString(row, 'terminal_evidence_ref');
    const evidenceSha = sqlNullableString(row, 'terminal_evidence_sha256');
    return parseCoordinationChildLease({
        schema_version: 'autopilot.child_lease.v1',
        child_lease_id: sqlString(row, 'child_lease_id'),
        owner: {
            repo_id: sqlString(row, 'repo_id'),
            autopilot_id: sqlString(row, 'autopilot_id'),
            workstream_run: sqlString(row, 'workstream_run'),
            unit_id: sqlString(row, 'unit_id'),
            attempt: sqlInteger(row, 'attempt'),
        },
        pid: sqlInteger(row, 'pid'),
        boot_id: sqlString(row, 'boot_id'),
        lease_expires_at: sqlString(row, 'lease_expires_at'),
        status: sqlString(row, 'status'),
        terminal_evidence: evidenceRef === null || evidenceSha === null ? null : { ref: evidenceRef, sha256: evidenceSha },
        version: sqlInteger(row, 'version'),
    });
}
function messageFromRow(row) {
    return parseCoordinationMessage({
        schema_version: 'autopilot.coordination_message.v1',
        message_id: sqlString(row, 'message_id'),
        repo_id: sqlString(row, 'repo_id'),
        recipient_workstream_run: sqlString(row, 'recipient_workstream_run'),
        message_type: sqlString(row, 'message_type'),
        correlation_id: sqlString(row, 'correlation_id'),
        payload: parseJsonObject(sqlString(row, 'payload_json'), 'message payload'),
        status: sqlString(row, 'status'),
        created_event_seq: sqlInteger(row, 'created_event_seq'),
        delivered_event_seq: row['delivered_event_seq'] === null ? null : sqlInteger(row, 'delivered_event_seq'),
        acknowledged_event_seq: row['acknowledged_event_seq'] === null ? null : sqlInteger(row, 'acknowledged_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function integrityResult(db) {
    const row = asRow(db.prepare('PRAGMA integrity_check').get(), 'integrity_check');
    const value = row['integrity_check'];
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('store-corrupt', 'integrity check returned an invalid result');
    return value;
}
function sqliteFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/busy|locked/u.test(message.toLowerCase()))
        return new CoordinationRuntimeError('coordinator-contention', message);
    if (/readonly|permission|access/u.test(message.toLowerCase()))
        return new CoordinationRuntimeError('permission-denied', message);
    if (/disk|full|i\/o/u.test(message.toLowerCase()))
        return new CoordinationRuntimeError('disk-failure', message);
    if (/malformed|not a database|corrupt/u.test(message.toLowerCase()))
        return new CoordinationRuntimeError('store-corrupt', message);
    return new CoordinationRuntimeError('invalid-state', message);
}
export class CoordinatorStore {
    #db;
    #paths;
    #clock;
    #lastBackupPath;
    constructor(db, paths, clock, lastBackupPath) {
        this.#db = db;
        this.#paths = paths;
        this.#clock = clock;
        this.#lastBackupPath = lastBackupPath;
    }
    static async open(paths, clock = systemClock) {
        try {
            await mkdir(paths.coordinatorRoot, { recursive: true, mode: 0o700 });
            await mkdir(paths.backupsRoot, { recursive: true, mode: 0o700 });
        }
        catch (error) {
            throw sqliteFailure(error);
        }
        let existed;
        try {
            existed = existsSync(paths.databasePath) && statSync(paths.databasePath).size > 0;
        }
        catch (error) {
            throw sqliteFailure(error);
        }
        let db;
        try {
            db = new DatabaseSync(paths.databasePath, { timeout: COORDINATOR_BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
        }
        catch (error) {
            throw sqliteFailure(error);
        }
        let lastBackupPath = null;
        try {
            db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${String(COORDINATOR_BUSY_TIMEOUT_MS)}; PRAGMA trusted_schema=OFF;`);
            if (integrityResult(db) !== 'ok')
                throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed startup integrity check');
            const versionRow = asRow(db.prepare('PRAGMA user_version').get(), 'user_version');
            const currentVersion = sqlInteger(versionRow, 'user_version');
            if (currentVersion > COORDINATOR_DATABASE_SCHEMA_VERSION)
                throw new CoordinationRuntimeError('schema-mismatch', `database schema ${String(currentVersion)} is newer than supported schema ${String(COORDINATOR_DATABASE_SCHEMA_VERSION)}`);
            if (currentVersion < COORDINATOR_DATABASE_SCHEMA_VERSION) {
                if (existed) {
                    const stamp = clock.now().toISOString().replace(/[-:.]/gu, '');
                    lastBackupPath = join(paths.backupsRoot, `coordinator.pre-v${String(currentVersion)}.${stamp}.db`);
                    await backup(db, lastBackupPath);
                    const backupDb = new DatabaseSync(lastBackupPath, { readOnly: true });
                    try {
                        if (integrityResult(backupDb) !== 'ok')
                            throw new CoordinationRuntimeError('store-corrupt', 'pre-migration backup failed integrity verification');
                    }
                    finally {
                        backupDb.close();
                    }
                }
                if (currentVersion === 0) {
                    const checksum = createHash('sha256').update(MIGRATION_1, 'utf8').digest('hex');
                    db.exec('BEGIN IMMEDIATE');
                    try {
                        db.exec(MIGRATION_1);
                        db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)').run(1, checksum, clock.now().toISOString());
                        db.exec('PRAGMA user_version=1');
                        db.exec('COMMIT');
                    }
                    catch (error) {
                        db.exec('ROLLBACK');
                        throw error;
                    }
                }
            }
            const expectedMigrationChecksum = createHash('sha256').update(MIGRATION_1, 'utf8').digest('hex');
            let migrationRow;
            try {
                migrationRow = db.prepare('SELECT version, checksum FROM schema_migrations WHERE version=1').get();
            }
            catch (error) {
                throw new CoordinationRuntimeError('schema-mismatch', 'coordinator migration journal is unavailable', [error instanceof Error ? error.message : String(error)]);
            }
            if (migrationRow === undefined || sqlInteger(migrationRow, 'version') !== 1 || sqlString(migrationRow, 'checksum') !== expectedMigrationChecksum)
                throw new CoordinationRuntimeError('schema-mismatch', 'coordinator migration journal checksum does not match the package schema');
            if (integrityResult(db) !== 'ok')
                throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed post-migration integrity check');
            if (platform() !== 'win32')
                chmodSync(paths.databasePath, 0o600);
            return new CoordinatorStore(db, paths, clock, lastBackupPath);
        }
        catch (error) {
            db.close();
            if (error instanceof CoordinationRuntimeError)
                throw error;
            throw sqliteFailure(error);
        }
    }
    close() {
        this.#db.close();
    }
    handle(request) {
        try {
            const effect = this.#dispatch(request);
            return {
                schema_version: 'autopilot.coordinator_response.v1',
                protocol_version: '1.0',
                request_id: request.request_id,
                ok: true,
                committed_event_seq: effect.committedEventSeq,
                error_code: null,
                retryable: false,
                payload: effect.payload,
            };
        }
        catch (error) {
            const runtime = error instanceof CoordinationRuntimeError ? error : sqliteFailure(error);
            return {
                schema_version: 'autopilot.coordinator_response.v1',
                protocol_version: '1.0',
                request_id: request.request_id,
                ok: false,
                committed_event_seq: null,
                error_code: runtime.code,
                retryable: runtime.retry_policy !== 'never',
                payload: { message: runtime.message, evidence: runtime.evidence },
            };
        }
    }
    #dispatch(request) {
        switch (request.action) {
            case 'status': return this.status(request.repo_id, request.workstream_run);
            case 'doctor': return this.doctor();
            case 'export': return this.exportTo(payloadString(request.payload, 'output_path'));
            case 'attach-run': return this.attachRun(request);
            case 'attach-session': return this.attachSession(request);
            case 'detach-session': return this.detachSession(request);
            case 'prepare-handoff': return this.prepareHandoff(request);
            case 'heartbeat': return this.heartbeatSession(request);
            case 'register-child': return this.registerChild(request);
            case 'heartbeat-child': return this.heartbeatChild(request);
            case 'complete-child': return this.completeChild(request);
            case 'drain-mailbox': return this.drainMailbox(request);
            case 'acknowledge-message': return this.acknowledgeMessage(request);
            case 'acquire-group':
            case 'acknowledge-grant':
            case 'respond-claim-request':
            case 'cancel-claim-request':
            case 'transition-operation':
                throw new CoordinationRuntimeError('recovery-required', `${request.action} is reserved for a later Coordination Fabric transition`);
        }
    }
    status(repoId, workstreamRun) {
        const repositories = repoId === 'global'
            ? this.#db.prepare('SELECT * FROM repositories ORDER BY repo_id').all().map(repositoryFromRow)
            : this.#db.prepare('SELECT * FROM repositories WHERE repo_id=? ORDER BY repo_id').all(repoId).map(repositoryFromRow);
        const runs = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM runs ORDER BY repo_id, workstream_run').all() : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? ORDER BY workstream_run').all(repoId)).map(runFromRow)
            : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').all(repoId, workstreamRun).map(runFromRow);
        const sessions = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM session_leases ORDER BY repo_id, workstream_run, session_generation').all() : this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? ORDER BY workstream_run, session_generation').all(repoId)).map(sessionFromRow)
            : this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? ORDER BY session_generation').all(repoId, workstreamRun).map(sessionFromRow);
        const children = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM child_leases ORDER BY repo_id, workstream_run, unit_id, attempt').all() : this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? ORDER BY workstream_run, unit_id, attempt').all(repoId)).map(childFromRow)
            : this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? ORDER BY unit_id, attempt').all(repoId, workstreamRun).map(childFromRow);
        const pendingMessages = workstreamRun === null ? 0 : sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status!='acknowledged'").get(repoId, workstreamRun), 'message count'), 'count');
        return {
            committedEventSeq: null,
            payload: {
                schema_version: 'autopilot.coordinator_status.v1',
                package_build: COORDINATOR_PACKAGE_BUILD,
                protocol_version: '1.0',
                database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION,
                repositories,
                runs,
                session_leases: sessions,
                child_leases: children,
                pending_messages: pendingMessages,
            },
        };
    }
    doctor() {
        const integrity = integrityResult(this.#db);
        const now = this.#clock.now().toISOString();
        const expired = this.#db.prepare("SELECT session_lease_id, repo_id, workstream_run, status, lease_expires_at FROM session_leases WHERE status IN ('attached','handoff-pending') AND lease_expires_at < ? ORDER BY repo_id, workstream_run").all(now).map((row) => ({
            session_lease_id: sqlString(row, 'session_lease_id'),
            repo_id: sqlString(row, 'repo_id'),
            workstream_run: sqlString(row, 'workstream_run'),
            status: sqlString(row, 'status'),
            lease_expires_at: sqlString(row, 'lease_expires_at'),
            classification: 'heartbeat-expired-recovery-check',
            write_authority_released: false,
        }));
        const expiredChildren = this.#db.prepare("SELECT child_lease_id, repo_id, workstream_run, lease_expires_at FROM child_leases WHERE status='running' AND lease_expires_at < ? ORDER BY repo_id, workstream_run, child_lease_id").all(now).map((row) => ({
            child_lease_id: sqlString(row, 'child_lease_id'),
            repo_id: sqlString(row, 'repo_id'),
            workstream_run: sqlString(row, 'workstream_run'),
            lease_expires_at: sqlString(row, 'lease_expires_at'),
            classification: 'heartbeat-expired-recovery-check',
            write_authority_released: false,
        }));
        const migrations = this.#db.prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version').all().map((row) => ({ version: sqlInteger(row, 'version'), checksum: sqlString(row, 'checksum'), applied_at: sqlString(row, 'applied_at') }));
        return {
            committedEventSeq: null,
            payload: {
                schema_version: 'autopilot.coordinator_doctor.v1',
                healthy: integrity === 'ok',
                integrity,
                database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION,
                migrations,
                expired_session_classifications: expired,
                expired_child_classifications: expiredChildren,
                last_backup_path: this.#lastBackupPath,
            },
        };
    }
    exportTo(outputPath) {
        const target = resolve(outputPath);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const tables = [
            ['repositories', 'repo_id'],
            ['runs', 'repo_id, workstream_run'],
            ['session_leases', 'repo_id, workstream_run, session_generation, session_lease_id'],
            ['child_leases', 'repo_id, workstream_run, unit_id, attempt, child_lease_id'],
            ['unit_attempts', 'repo_id, workstream_run, entity_id'],
            ['edit_leases', 'repo_id, workstream_run, entity_id'],
            ['change_reservations', 'repo_id, workstream_run, entity_id'],
            ['claim_requests', 'repo_id, requester_workstream_run, owner_workstream_run, entity_id'],
            ['messages', 'repo_id, recipient_workstream_run, created_event_seq, message_id'],
            ['worktrees', 'repo_id, workstream_run, entity_id'],
            ['worktree_operations', 'repo_id, workstream_run, entity_id'],
            ['merge_operations', 'repo_id, workstream_run, entity_id'],
            ['escalations', 'repo_id, entity_id'],
            ['handoffs', 'repo_id, workstream_run, created_event_seq, handoff_token'],
            ['events', 'repo_id, event_seq'],
            ['idempotency_results', 'repo_id, idempotency_key'],
            ['schema_migrations', 'version'],
        ];
        const exported = { schema_version: DATABASE_EXPORT_SCHEMA, database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION };
        for (const [table, order] of tables) {
            const rows = this.#db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((row) => Object.fromEntries(Object.entries(row)));
            exported[table] = rows;
        }
        writeFileSync(target, `${canonicalJson(exported)}\n`, { encoding: 'utf8', mode: 0o600 });
        return { committedEventSeq: null, payload: { schema_version: 'autopilot.coordinator_export_result.v1', output_path: target, sha256: `sha256:${createHash('sha256').update(canonicalJson(exported), 'utf8').digest('hex')}` } };
    }
    attachRun(request) {
        return this.#mutation(request, () => {
            const workstreamRun = this.#workstreamRun(request);
            const existingRepoRow = this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(request.repo_id);
            const existingRunRow = this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun);
            if (existingRunRow !== undefined)
                throw new CoordinationRuntimeError('stale-version', 'run already exists; query status before attachment');
            if (request.expected_version !== 0)
                throw new CoordinationRuntimeError('stale-version', 'new run registration requires expected_version 0');
            const seq = existingRepoRow === undefined ? 1 : this.#nextEventSequence(request.repo_id);
            if (existingRepoRow === undefined) {
                this.#db.prepare('INSERT INTO repositories(repo_id, repo_key, canonical_root, git_common_dir, event_seq, created_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, 1)').run(request.repo_id, payloadString(request.payload, 'repo_key'), payloadString(request.payload, 'canonical_root'), payloadString(request.payload, 'git_common_dir'), seq, seq);
            }
            else {
                const repository = repositoryFromRow(existingRepoRow);
                if (repository.repo_key !== payloadString(request.payload, 'repo_key') || repository.canonical_root !== payloadString(request.payload, 'canonical_root') || repository.git_common_dir !== payloadString(request.payload, 'git_common_dir')) {
                    throw new CoordinationRuntimeError('invalid-state', 'repository identity disagrees with its durable coordinator record');
                }
                this.#db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(seq, request.repo_id);
            }
            this.#db.prepare("INSERT INTO runs(repo_id, autopilot_id, workstream, workstream_run, status, active_session_generation, created_event_seq, version) VALUES(?, ?, ?, ?, 'active', 0, ?, 1)").run(request.repo_id, payloadString(request.payload, 'autopilot_id'), payloadString(request.payload, 'workstream'), workstreamRun, seq);
            const run = runFromRow(asRow(this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun), 'created run'));
            return { sequence: seq, eventType: 'run-attached', entityType: 'run', entityId: workstreamRun, payload: { run } };
        });
    }
    attachSession(request) {
        return this.#mutation(request, () => {
            const workstreamRun = this.#workstreamRun(request);
            const sessionId = this.#sessionId(request);
            const run = this.#requireRun(request.repo_id, workstreamRun);
            this.#assertVersion(run.version, request.expected_version, 'run');
            const nextGeneration = run.active_session_generation + 1;
            if (request.fencing_generation !== nextGeneration)
                throw new CoordinationRuntimeError('stale-version', `next session generation must be ${String(nextGeneration)}`);
            const suppliedHandoffToken = payloadNullableString(request.payload, 'handoff_token');
            const pendingHandoff = suppliedHandoffToken === null
                ? this.#db.prepare("SELECT handoff_token FROM handoffs WHERE repo_id=? AND workstream_run=? AND status='pending' ORDER BY created_event_seq DESC LIMIT 1").get(request.repo_id, workstreamRun)
                : this.#db.prepare("SELECT handoff_token FROM handoffs WHERE handoff_token=? AND repo_id=? AND workstream_run=? AND status='pending'").get(suppliedHandoffToken, request.repo_id, workstreamRun);
            if (suppliedHandoffToken !== null && pendingHandoff === undefined)
                throw new CoordinationRuntimeError('fenced-session', 'handoff token is missing, consumed, or belongs to another run');
            const effectiveHandoffToken = pendingHandoff === undefined ? null : sqlString(pendingHandoff, 'handoff_token');
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE repo_id=? AND workstream_run=? AND status='attached'").run(request.repo_id, workstreamRun);
            if (effectiveHandoffToken !== null) {
                this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=(SELECT from_session_lease_id FROM handoffs WHERE handoff_token=?)").run(effectiveHandoffToken);
                this.#db.prepare("UPDATE handoffs SET status='consumed', consumed_event_seq=? WHERE handoff_token=?").run(seq, effectiveHandoffToken);
            }
            const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
            this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1)").run(payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration, payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), seq);
            this.#db.prepare("UPDATE runs SET active_session_generation=?, status='active', version=version+1 WHERE repo_id=? AND workstream_run=?").run(nextGeneration, request.repo_id, workstreamRun);
            const nextRun = this.#requireRun(request.repo_id, workstreamRun);
            const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached session'));
            return { sequence: seq, eventType: 'session-attached', entityType: 'session-lease', entityId: session.session_lease_id, payload: { run: nextRun, session } };
        });
    }
    detachSession(request) {
        return this.#sessionMutation(request, 'session-detached', (session, seq) => {
            this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=?").run(session.session_lease_id);
            return { entityId: session.session_lease_id, payload: { session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'detached session')), reason: payloadString(request.payload, 'reason') } };
        });
    }
    prepareHandoff(request) {
        return this.#sessionMutation(request, 'session-handoff-prepared', (session, seq) => {
            const token = payloadString(request.payload, 'handoff_token');
            this.#db.prepare("UPDATE session_leases SET status='handoff-pending', version=version+1 WHERE session_lease_id=?").run(session.session_lease_id);
            this.#db.prepare("INSERT INTO handoffs(handoff_token, repo_id, workstream_run, from_session_lease_id, status, created_event_seq, consumed_event_seq) VALUES(?, ?, ?, ?, 'pending', ?, NULL)").run(token, request.repo_id, this.#workstreamRun(request), session.session_lease_id, seq);
            return { entityId: session.session_lease_id, payload: { handoff_token: token, session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'handoff session')) } };
        });
    }
    heartbeatSession(request) {
        return this.#sessionMutation(request, 'session-heartbeat', (session) => {
            this.#db.prepare('UPDATE session_leases SET lease_expires_at=?, version=version+1 WHERE session_lease_id=?').run(payloadString(request.payload, 'lease_expires_at'), session.session_lease_id);
            return { entityId: session.session_lease_id, payload: { session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'heartbeat session')) } };
        });
    }
    registerChild(request) {
        return this.#mutation(request, () => {
            const session = this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#assertVersion(run.version, request.expected_version, 'run');
            const seq = this.#nextEventSequence(request.repo_id);
            const childId = payloadString(request.payload, 'child_lease_id');
            const childTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'child_token'), 'utf8').digest('hex');
            this.#db.prepare("INSERT INTO child_leases(child_lease_id, repo_id, autopilot_id, workstream_run, unit_id, attempt, pid, boot_id, child_token_sha256, lease_expires_at, status, terminal_evidence_ref, terminal_evidence_sha256, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, 1)").run(childId, request.repo_id, payloadString(request.payload, 'autopilot_id'), this.#workstreamRun(request), payloadString(request.payload, 'unit_id'), payloadInteger(request.payload, 'attempt'), payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), childTokenSha256, payloadString(request.payload, 'lease_expires_at'));
            const child = childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'registered child'));
            return { sequence: seq, eventType: 'child-registered', entityType: 'child-lease', entityId: childId, payload: { child, authorizing_session_lease_id: session.session_lease_id } };
        });
    }
    heartbeatChild(request) {
        return this.#mutation(request, () => {
            const childId = payloadString(request.payload, 'child_lease_id');
            const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
            const child = childFromRow(childRow);
            this.#assertChildAuthority(request, child, childRow);
            this.#assertVersion(child.version, request.expected_version, 'child lease');
            if (child.status !== 'running')
                throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare('UPDATE child_leases SET lease_expires_at=?, version=version+1 WHERE child_lease_id=?').run(payloadString(request.payload, 'lease_expires_at'), childId);
            return { sequence: seq, eventType: 'child-heartbeat', entityType: 'child-lease', entityId: childId, payload: { child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'heartbeat child')) } };
        });
    }
    completeChild(request) {
        return this.#mutation(request, () => {
            const childId = payloadString(request.payload, 'child_lease_id');
            const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
            const child = childFromRow(childRow);
            this.#assertChildAuthority(request, child, childRow);
            this.#assertVersion(child.version, request.expected_version, 'child lease');
            if (child.status !== 'running')
                throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
            const status = payloadString(request.payload, 'status');
            const evidenceRef = payloadNullableString(request.payload, 'evidence_ref');
            const evidenceSha = payloadNullableString(request.payload, 'evidence_sha256');
            if (status === 'terminal' && (evidenceRef === null || evidenceSha === null || !SHA256_PATTERN.test(evidenceSha)))
                throw new CoordinationRuntimeError('invalid-request', 'terminal child completion requires immutable evidence');
            if (status === 'recovery-required' && (evidenceRef !== null || evidenceSha !== null))
                throw new CoordinationRuntimeError('invalid-request', 'recovery-required child completion must not claim terminal evidence');
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare('UPDATE child_leases SET status=?, terminal_evidence_ref=?, terminal_evidence_sha256=?, version=version+1 WHERE child_lease_id=?').run(status, evidenceRef, evidenceSha, childId);
            return { sequence: seq, eventType: status === 'terminal' ? 'child-terminal' : 'child-recovery-required', entityType: 'child-lease', entityId: childId, payload: { child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'completed child')) } };
        });
    }
    drainMailbox(request) {
        return this.#sessionMutation(request, 'mailbox-drained', (session, seq) => {
            const workstreamRun = this.#workstreamRun(request);
            this.#db.prepare("UPDATE messages SET status='delivered', delivered_event_seq=COALESCE(delivered_event_seq, ?), version=version+1 WHERE repo_id=? AND recipient_workstream_run=? AND status='pending'").run(seq, request.repo_id, workstreamRun);
            const messages = this.#db.prepare("SELECT * FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status IN ('pending','delivered') ORDER BY created_event_seq, message_id").all(request.repo_id, workstreamRun).map(messageFromRow);
            return { entityId: payloadString(request.payload, 'delivery_id'), payload: { delivery_id: payloadString(request.payload, 'delivery_id'), session_version: session.version, messages } };
        });
    }
    acknowledgeMessage(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const messageId = payloadString(request.payload, 'message_id');
            const message = messageFromRow(asRow(this.#db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId), 'message'));
            if (message.repo_id !== request.repo_id || message.recipient_workstream_run !== this.#workstreamRun(request))
                throw new CoordinationRuntimeError('unauthorized-client', 'session does not own mailbox message');
            this.#assertVersion(message.version, request.expected_version, 'message');
            if (message.status !== 'delivered')
                throw new CoordinationRuntimeError('invalid-state', `message is ${message.status}`);
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare("UPDATE messages SET status='acknowledged', acknowledged_event_seq=?, version=version+1 WHERE message_id=?").run(seq, messageId);
            return { sequence: seq, eventType: 'message-acknowledged', entityType: 'message', entityId: messageId, payload: { message: messageFromRow(asRow(this.#db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId), 'acknowledged message')) } };
        });
    }
    enqueueMessageForTest(message) {
        const parsed = parseCoordinationMessage(message);
        this.#db.prepare('INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(parsed.message_id, parsed.repo_id, parsed.recipient_workstream_run, parsed.message_type, parsed.correlation_id, canonicalJson(parsed.payload), parsed.status, parsed.created_event_seq, parsed.delivered_event_seq, parsed.acknowledged_event_seq, parsed.version);
    }
    #sessionMutation(request, eventType, apply) {
        return this.#mutation(request, () => {
            const session = this.#requireCurrentSession(request);
            this.#assertVersion(session.version, request.expected_version, 'session lease');
            const seq = this.#nextEventSequence(request.repo_id);
            const applied = apply(session, seq);
            return { sequence: seq, eventType, entityType: 'session-lease', entityId: applied.entityId, payload: applied.payload };
        });
    }
    #mutation(request, apply) {
        const idempotencyKey = request.idempotency_key;
        if (idempotencyKey === null)
            throw new CoordinationRuntimeError('invalid-request', 'mutation lacks idempotency key');
        const digest = requestDigest(request);
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const prior = this.#db.prepare('SELECT request_sha256, committed_event_seq, payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(request.repo_id, idempotencyKey);
            if (prior !== undefined) {
                if (sqlString(prior, 'request_sha256') !== digest)
                    throw new CoordinationRuntimeError('idempotency-conflict', 'idempotency key was reused with a different request');
                const replay = { committedEventSeq: sqlInteger(prior, 'committed_event_seq'), payload: parseJsonObject(sqlString(prior, 'payload_json'), 'idempotency payload'), replayed: true };
                this.#db.exec('COMMIT');
                return replay;
            }
            const result = apply();
            const committed = this.#commitDescription(result.sequence, result.eventType, result.entityType, result.entityId, result.payload);
            this.#db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(request.repo_id, result.sequence, result.eventType, result.entityType, result.entityId, idempotencyKey, digest, this.#clock.now().toISOString());
            this.#db.prepare('INSERT INTO idempotency_results(repo_id, idempotency_key, request_sha256, committed_event_seq, payload_json) VALUES(?, ?, ?, ?, ?)').run(request.repo_id, idempotencyKey, digest, result.sequence, canonicalJson(committed.payload));
            this.#db.exec('COMMIT');
            return { ...committed, replayed: false };
        }
        catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
    }
    #commitDescription(sequence, eventType, entityType, entityId, payload) {
        return { committedEventSeq: sequence, payload: { ...payload, event_type: eventType, entity_type: entityType, entity_id: entityId } };
    }
    #nextEventSequence(repoId) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(repoId), 'repository'));
        const next = this.#db.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(repoId);
        const sequence = sqlInteger(asRow(next, 'repository event sequence'), 'event_seq') + 1;
        this.#db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(sequence, repository.repo_id);
        return sequence;
    }
    #requireRun(repoId, workstreamRun) {
        return runFromRow(asRow(this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(repoId, workstreamRun), 'run'));
    }
    #requireCurrentSession(request) {
        const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
        const sessionId = this.#sessionId(request);
        const generation = request.fencing_generation;
        if (generation === null || generation !== run.active_session_generation)
            throw new CoordinationRuntimeError('fenced-session', 'session generation is no longer current');
        const row = this.#db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND session_id=? AND session_generation=? AND status='attached'").get(request.repo_id, run.workstream_run, sessionId, generation);
        if (row === undefined)
            throw new CoordinationRuntimeError('fenced-session', 'session is not attached to the durable run supervisor');
        if (sqlString(row, 'session_lease_id') !== payloadString(request.payload, 'session_lease_id'))
            throw new CoordinationRuntimeError('unauthorized-client', 'session lease identity does not match current authority');
        this.#assertCapability(row, 'session_token_sha256', payloadString(request.payload, 'session_token'), 'session');
        return sessionFromRow(row);
    }
    #assertChildAuthority(request, child, row) {
        if (child.owner.repo_id !== request.repo_id || child.owner.workstream_run !== this.#workstreamRun(request))
            throw new CoordinationRuntimeError('unauthorized-client', 'client does not own child lease');
        if (child.pid !== payloadInteger(request.payload, 'pid') || child.boot_id !== payloadString(request.payload, 'boot_id'))
            throw new CoordinationRuntimeError('unauthorized-client', 'child process identity does not match its lease');
        this.#assertCapability(row, 'child_token_sha256', payloadString(request.payload, 'child_token'), 'child');
    }
    #assertCapability(row, field, token, label) {
        const expected = Buffer.from(sqlString(row, field), 'utf8');
        const actual = Buffer.from(createHash('sha256').update(token, 'utf8').digest('hex'), 'utf8');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
            throw new CoordinationRuntimeError('unauthorized-client', `${label} capability does not match its lease`);
    }
    #assertVersion(actual, expected, label) {
        if (expected === null || actual !== expected)
            throw new CoordinationRuntimeError('stale-version', `${label} version ${String(actual)} does not match expected ${String(expected)}`);
    }
    #workstreamRun(request) {
        if (request.workstream_run === null)
            throw new CoordinationRuntimeError('invalid-request', 'request lacks workstream_run');
        return request.workstream_run;
    }
    #sessionId(request) {
        if (request.session_id === null)
            throw new CoordinationRuntimeError('invalid-request', 'request lacks session_id');
        return request.session_id;
    }
}
export function coordinationErrorCode(value) {
    switch (value) {
        case 'invalid-request':
        case 'invalid-state':
        case 'protocol-mismatch':
        case 'schema-mismatch':
        case 'frame-too-large':
        case 'unauthorized-client':
        case 'coordinator-unavailable':
        case 'coordinator-contention':
        case 'fenced-session':
        case 'stale-version':
        case 'idempotency-conflict':
        case 'request-timeout':
        case 'recovery-required':
        case 'git-partial-effect':
        case 'disk-failure':
        case 'permission-denied':
        case 'planning-contradiction-review':
        case 'store-corrupt':
        case 'system-fatal': return value;
        default: return 'system-fatal';
    }
}
