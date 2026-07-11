import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { backup, DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import { claimModesConflict, coordinationPathsOverlap, parseCoordinationAcquisitionGroup, parseCoordinationChildLease, parseCoordinationClaimRequest, parseCoordinationEditLease, parseCoordinationMessage, parseCoordinationReleaseCondition, parseCoordinationRepository, parseCoordinationRequestedLease, parseCoordinationRun, parseCoordinationSessionLease, parseCoordinationUnitAttempt } from './contracts.ts';
import { CoordinationRuntimeError, type CoordinationFailureCode } from './failures.ts';
import { COORDINATOR_BUSY_TIMEOUT_MS, COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_GRANT_OFFER_TTL_MS, COORDINATOR_PACKAGE_BUILD, type CoordinatorRuntimePaths } from './runtime-paths.ts';
import type { CoordinationAcquisitionGroup, CoordinationChildLease, CoordinationClaimRequest, CoordinationEditLease, CoordinationMessage, CoordinationOwnerIdentity, CoordinationReleaseCondition, CoordinationRepository, CoordinationRequestedLease, CoordinationRun, CoordinationSessionLease, CoordinationUnitAttempt, CoordinatorRequestEnvelope, CoordinatorResponseEnvelope } from './types.ts';

const DATABASE_EXPORT_SCHEMA = 'autopilot.coordinator_export.v1';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RUN_OWNED_IDEMPOTENCY_ACTIONS = new Set(['acquire-group', 'acknowledge-grant', 'respond-claim-request', 'cancel-claim-request', 'cancel-acquisition-group', 'supersede-attempt']);

interface StoreEffect {
  readonly committedEventSeq: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface IdempotentEffect extends StoreEffect {
  readonly replayed: boolean;
}

interface SqlRow {
  readonly [key: string]: SQLOutputValue;
}

export interface StoreClock {
  now(): Date;
}

const systemClock: StoreClock = { now: () => new Date() };

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

const MIGRATION_2 = `
CREATE TABLE acquisition_groups (
  entity_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  PRIMARY KEY(repo_id, entity_id),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_acquisition_groups_run ON acquisition_groups(repo_id, workstream_run, entity_id);
CREATE INDEX idx_edit_leases_repo ON edit_leases(repo_id, entity_id);
CREATE INDEX idx_claim_requests_owner_status ON claim_requests(repo_id, owner_workstream_run, entity_id);
CREATE INDEX idx_claim_requests_requester_status ON claim_requests(repo_id, requester_workstream_run, entity_id);
`;

function asRow(value: SqlRow | undefined, label: string): SqlRow {
  if (value === undefined) throw new CoordinationRuntimeError('invalid-state', `${label} row is missing`);
  return value;
}

function sqlString(row: SqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not text`);
  return value;
}

function sqlNullableString(row: SqlRow, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== 'string') throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not nullable text`);
  return value;
}

function sqlInteger(row: SqlRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not a safe integer`);
  return value;
}

function payloadString(payload: Readonly<Record<string, unknown>>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string') throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be text`);
  return value;
}

function payloadNullableString(payload: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = payload[field];
  if (value === null) return null;
  if (typeof value !== 'string') throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be nullable text`);
  return value;
}

function payloadInteger(payload: Readonly<Record<string, unknown>>, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be an integer`);
  return value;
}

function payloadBoolean(payload: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = payload[field];
  if (typeof value !== 'boolean') throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be boolean`);
  return value;
}

function payloadRequestedLeases(payload: Readonly<Record<string, unknown>>): readonly CoordinationRequestedLease[] {
  const value = payload['requested_leases'];
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-request', 'payload field requested_leases must be an array');
  return Object.freeze(value.map((entry, index) => parseCoordinationRequestedLease(entry, `requested_leases[${String(index)}]`)));
}

function payloadReleaseCondition(payload: Readonly<Record<string, unknown>>, field: string): CoordinationReleaseCondition {
  return parseCoordinationReleaseCondition(payload[field], `payload.${field}`);
}

function ownerIdentityKey(owner: CoordinationOwnerIdentity): string {
  return `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}`;
}

function sameOwner(left: CoordinationOwnerIdentity, right: CoordinationOwnerIdentity): boolean {
  return ownerIdentityKey(left) === ownerIdentityKey(right);
}

function unitAttemptEntityId(owner: CoordinationOwnerIdentity): string {
  return `attempt-${createHash('sha256').update(ownerIdentityKey(owner), 'utf8').digest('hex')}`;
}

function stableEntityId(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value !== 'object') throw new CoordinationRuntimeError('invalid-request', 'request contains a non-JSON value');
  const entries = Object.entries(value).sort((left, right) => left[0].localeCompare(right[0]));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function requestDigest(request: CoordinatorRequestEnvelope): `sha256:${string}` {
  const runOwnedIdempotency = RUN_OWNED_IDEMPOTENCY_ACTIONS.has(request.action);
  const payload = runOwnedIdempotency
    ? Object.fromEntries(Object.entries(request.payload).filter(([field]) => field !== 'session_lease_id' && field !== 'session_token'))
    : request.payload;
  const semantic = {
    schema_version: request.schema_version,
    protocol_version: request.protocol_version,
    action: request.action,
    repo_id: request.repo_id,
    workstream_run: request.workstream_run,
    session_id: runOwnedIdempotency ? null : request.session_id,
    fencing_generation: runOwnedIdempotency ? null : request.fencing_generation,
    expected_version: runOwnedIdempotency && request.action === 'acquire-group' ? null : request.expected_version,
    payload,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex')}`;
}

function parseJsonObject(text: string, label: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CoordinationRuntimeError('store-corrupt', `${label} contains invalid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('store-corrupt', `${label} is not an object`);
  return value as Readonly<Record<string, unknown>>;
}

function repositoryFromRow(row: SqlRow): CoordinationRepository {
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

function runFromRow(row: SqlRow): CoordinationRun {
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

function sessionFromRow(row: SqlRow): CoordinationSessionLease {
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

function childFromRow(row: SqlRow): CoordinationChildLease {
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

function entityFromRow<T>(row: SqlRow, parser: (value: unknown) => T, label: string): T {
  const parsed = parser(parseJsonObject(sqlString(row, 'payload_json'), label));
  const version = sqlInteger(row, 'version');
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== version) throw new CoordinationRuntimeError('store-corrupt', `${label} payload version disagrees with its indexed row`);
  return parsed;
}

function acquisitionGroupFromRow(row: SqlRow): CoordinationAcquisitionGroup {
  return entityFromRow(row, parseCoordinationAcquisitionGroup, 'acquisition group');
}

function editLeaseFromRow(row: SqlRow): CoordinationEditLease {
  return entityFromRow(row, parseCoordinationEditLease, 'edit lease');
}

function claimRequestFromRow(row: SqlRow): CoordinationClaimRequest {
  return entityFromRow(row, parseCoordinationClaimRequest, 'claim request');
}

function unitAttemptFromRow(row: SqlRow): CoordinationUnitAttempt {
  return entityFromRow(row, parseCoordinationUnitAttempt, 'unit attempt');
}

function messageFromRow(row: SqlRow): CoordinationMessage {
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

function integrityResult(db: DatabaseSync): string {
  const row = asRow(db.prepare('PRAGMA integrity_check').get(), 'integrity_check');
  const value = row['integrity_check'];
  if (typeof value !== 'string') throw new CoordinationRuntimeError('store-corrupt', 'integrity check returned an invalid result');
  return value;
}

function sqliteFailure(error: unknown): CoordinationRuntimeError {
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/u.test(message.toLowerCase())) return new CoordinationRuntimeError('coordinator-contention', message);
  if (/readonly|permission|access/u.test(message.toLowerCase())) return new CoordinationRuntimeError('permission-denied', message);
  if (/disk|full|i\/o/u.test(message.toLowerCase())) return new CoordinationRuntimeError('disk-failure', message);
  if (/malformed|not a database|corrupt/u.test(message.toLowerCase())) return new CoordinationRuntimeError('store-corrupt', message);
  return new CoordinationRuntimeError('invalid-state', message);
}

export class CoordinatorStore {
  readonly #db: DatabaseSync;
  readonly #clock: StoreClock;
  #lastBackupPath: string | null;

  private constructor(db: DatabaseSync, clock: StoreClock, lastBackupPath: string | null) {
    this.#db = db;
    this.#clock = clock;
    this.#lastBackupPath = lastBackupPath;
  }

  static async open(paths: CoordinatorRuntimePaths, clock: StoreClock = systemClock): Promise<CoordinatorStore> {
    try {
      await mkdir(paths.coordinatorRoot, { recursive: true, mode: 0o700 });
      await mkdir(paths.backupsRoot, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw sqliteFailure(error);
    }
    let existed: boolean;
    try {
      existed = existsSync(paths.databasePath) && statSync(paths.databasePath).size > 0;
    } catch (error) {
      throw sqliteFailure(error);
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(paths.databasePath, { timeout: COORDINATOR_BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
    } catch (error) {
      throw sqliteFailure(error);
    }
    let lastBackupPath: string | null = null;
    try {
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${String(COORDINATOR_BUSY_TIMEOUT_MS)}; PRAGMA trusted_schema=OFF;`);
      if (integrityResult(db) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed startup integrity check');
      const versionRow = asRow(db.prepare('PRAGMA user_version').get(), 'user_version');
      const currentVersion = sqlInteger(versionRow, 'user_version');
      if (currentVersion > COORDINATOR_DATABASE_SCHEMA_VERSION) throw new CoordinationRuntimeError('schema-mismatch', `database schema ${String(currentVersion)} is newer than supported schema ${String(COORDINATOR_DATABASE_SCHEMA_VERSION)}`);
      if (currentVersion < COORDINATOR_DATABASE_SCHEMA_VERSION && existed) {
        const stamp = clock.now().toISOString().replace(/[-:.]/gu, '');
        lastBackupPath = join(paths.backupsRoot, `coordinator.pre-v${String(currentVersion)}.${stamp}.db`);
        await backup(db, lastBackupPath);
        const backupDb = new DatabaseSync(lastBackupPath, { readOnly: true });
        try {
          if (integrityResult(backupDb) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'pre-migration backup failed integrity verification');
        } finally {
          backupDb.close();
        }
      }
      const migrations = [
        { version: 1, sql: MIGRATION_1 },
        { version: 2, sql: MIGRATION_2 },
      ] as const;
      for (const migration of migrations) {
        if (currentVersion >= migration.version) continue;
        const checksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(migration.sql);
          db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)').run(migration.version, checksum, clock.now().toISOString());
          db.exec(`PRAGMA user_version=${String(migration.version)}`);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      for (const migration of migrations) {
        let migrationRow: SqlRow | undefined;
        try {
          migrationRow = db.prepare('SELECT version, checksum FROM schema_migrations WHERE version=?').get(migration.version);
        } catch (error) {
          throw new CoordinationRuntimeError('schema-mismatch', 'coordinator migration journal is unavailable', [error instanceof Error ? error.message : String(error)]);
        }
        const expectedChecksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
        if (migrationRow === undefined || sqlInteger(migrationRow, 'version') !== migration.version || sqlString(migrationRow, 'checksum') !== expectedChecksum) throw new CoordinationRuntimeError('schema-mismatch', `coordinator migration ${String(migration.version)} checksum does not match the package schema`);
      }
      if (integrityResult(db) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed post-migration integrity check');
      if (platform() !== 'win32') chmodSync(paths.databasePath, 0o600);
      return new CoordinatorStore(db, clock, lastBackupPath);
    } catch (error) {
      db.close();
      if (error instanceof CoordinationRuntimeError) throw error;
      throw sqliteFailure(error);
    }
  }

  close(): void {
    this.#db.close();
  }

  sweepExpiredGrantOffers(): number {
    const now = this.#clock.now().toISOString();
    const repoRows = this.#db.prepare("SELECT DISTINCT repo_id FROM acquisition_groups WHERE json_extract(payload_json, '$.state')='grant-ready' AND json_extract(payload_json, '$.offer_expires_at')<=? ORDER BY repo_id").all(now);
    let expiredCount = 0;
    for (const repoRow of repoRows) {
      const repoId = sqlString(repoRow, 'repo_id');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const seq = this.#nextEventSequence(repoId);
        const before = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready' AND json_extract(payload_json, '$.offer_expires_at')<=?").get(repoId, now), 'expired offer count'), 'count');
        if (!this.#expireGrantOffers(repoId, seq)) {
          this.#db.exec('ROLLBACK');
          continue;
        }
        this.#reevaluateWaitingGroups(repoId, seq);
        const idempotencyKey = `grant-offer-expiry:${repoId}:${String(seq)}`;
        const digest = `sha256:${createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')}`;
        this.#db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(repoId, seq, 'grant-offers-expired', 'repository', repoId, idempotencyKey, digest, now);
        this.#db.exec('COMMIT');
        expiredCount += before;
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
    return expiredCount;
  }

  handle(request: CoordinatorRequestEnvelope): CoordinatorResponseEnvelope {
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
    } catch (error) {
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

  #dispatch(request: CoordinatorRequestEnvelope): StoreEffect {
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
      case 'acquire-group': return this.acquireGroup(request);
      case 'acknowledge-grant': return this.acknowledgeGrant(request);
      case 'respond-claim-request': return this.respondClaimRequest(request);
      case 'cancel-claim-request': return this.cancelClaimRequest(request);
      case 'cancel-acquisition-group': return this.cancelAcquisitionGroup(request);
      case 'supersede-attempt': return this.supersedeAttempt(request);
      case 'transition-operation': throw new CoordinationRuntimeError('recovery-required', `${request.action} is reserved for a later Coordination Fabric transition`);
    }
  }

  status(repoId: string, workstreamRun: string | null): StoreEffect {
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
    const acquisitionGroups = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(acquisitionGroupFromRow);
    const editLeases = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(editLeaseFromRow);
    const claimRequests = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? AND (requester_workstream_run=? OR owner_workstream_run=?) ORDER BY entity_id').all(repoId, workstreamRun, workstreamRun).map(claimRequestFromRow);
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
        acquisition_groups: acquisitionGroups,
        edit_leases: editLeases,
        claim_requests: claimRequests,
        pending_messages: pendingMessages,
      },
    };
  }

  doctor(): StoreEffect {
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

  exportTo(outputPath: string): StoreEffect {
    const target = resolve(outputPath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const tables = [
      ['repositories', 'repo_id'],
      ['runs', 'repo_id, workstream_run'],
      ['session_leases', 'repo_id, workstream_run, session_generation, session_lease_id'],
      ['child_leases', 'repo_id, workstream_run, unit_id, attempt, child_lease_id'],
      ['unit_attempts', 'repo_id, workstream_run, entity_id'],
      ['acquisition_groups', 'repo_id, workstream_run, entity_id'],
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
    ] as const;
    const exported: Record<string, unknown> = { schema_version: DATABASE_EXPORT_SCHEMA, database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION };
    for (const [table, order] of tables) {
      const rows = this.#db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((row) => Object.fromEntries(Object.entries(row)));
      exported[table] = rows;
    }
    writeFileSync(target, `${canonicalJson(exported)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { committedEventSeq: null, payload: { schema_version: 'autopilot.coordinator_export_result.v1', output_path: target, sha256: `sha256:${createHash('sha256').update(canonicalJson(exported), 'utf8').digest('hex')}` } };
  }

  attachRun(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const workstreamRun = this.#workstreamRun(request);
      const existingRepoRow = this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(request.repo_id);
      const existingRunRow = this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun);
      if (existingRunRow !== undefined) throw new CoordinationRuntimeError('stale-version', 'run already exists; query status before attachment');
      if (request.expected_version !== 0) throw new CoordinationRuntimeError('stale-version', 'new run registration requires expected_version 0');
      const seq = existingRepoRow === undefined ? 1 : this.#nextEventSequence(request.repo_id);
      if (existingRepoRow === undefined) {
        this.#db.prepare('INSERT INTO repositories(repo_id, repo_key, canonical_root, git_common_dir, event_seq, created_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, 1)').run(
          request.repo_id,
          payloadString(request.payload, 'repo_key'),
          payloadString(request.payload, 'canonical_root'),
          payloadString(request.payload, 'git_common_dir'),
          seq,
          seq,
        );
      } else {
        const repository = repositoryFromRow(existingRepoRow);
        if (repository.repo_key !== payloadString(request.payload, 'repo_key') || repository.canonical_root !== payloadString(request.payload, 'canonical_root') || repository.git_common_dir !== payloadString(request.payload, 'git_common_dir')) {
          throw new CoordinationRuntimeError('invalid-state', 'repository identity disagrees with its durable coordinator record');
        }
        this.#db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(seq, request.repo_id);
      }
      this.#db.prepare("INSERT INTO runs(repo_id, autopilot_id, workstream, workstream_run, status, active_session_generation, created_event_seq, version) VALUES(?, ?, ?, ?, 'active', 0, ?, 1)").run(
        request.repo_id,
        payloadString(request.payload, 'autopilot_id'),
        payloadString(request.payload, 'workstream'),
        workstreamRun,
        seq,
      );
      const run = runFromRow(asRow(this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun), 'created run'));
      return { sequence: seq, eventType: 'run-attached', entityType: 'run', entityId: workstreamRun, payload: { run } };
    });
  }

  attachSession(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const workstreamRun = this.#workstreamRun(request);
      const sessionId = this.#sessionId(request);
      const run = this.#requireRun(request.repo_id, workstreamRun);
      this.#assertVersion(run.version, request.expected_version, 'run');
      const nextGeneration = run.active_session_generation + 1;
      if (request.fencing_generation !== nextGeneration) throw new CoordinationRuntimeError('stale-version', `next session generation must be ${String(nextGeneration)}`);
      const suppliedHandoffToken = payloadNullableString(request.payload, 'handoff_token');
      const pendingHandoff = suppliedHandoffToken === null
        ? this.#db.prepare("SELECT handoff_token FROM handoffs WHERE repo_id=? AND workstream_run=? AND status='pending' ORDER BY created_event_seq DESC LIMIT 1").get(request.repo_id, workstreamRun)
        : this.#db.prepare("SELECT handoff_token FROM handoffs WHERE handoff_token=? AND repo_id=? AND workstream_run=? AND status='pending'").get(suppliedHandoffToken, request.repo_id, workstreamRun);
      if (suppliedHandoffToken !== null && pendingHandoff === undefined) throw new CoordinationRuntimeError('fenced-session', 'handoff token is missing, consumed, or belongs to another run');
      const effectiveHandoffToken = pendingHandoff === undefined ? null : sqlString(pendingHandoff, 'handoff_token');
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE repo_id=? AND workstream_run=? AND status='attached'").run(request.repo_id, workstreamRun);
      if (effectiveHandoffToken !== null) {
        this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=(SELECT from_session_lease_id FROM handoffs WHERE handoff_token=?)").run(effectiveHandoffToken);
        this.#db.prepare("UPDATE handoffs SET status='consumed', consumed_event_seq=? WHERE handoff_token=?").run(seq, effectiveHandoffToken);
      }
      const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
      this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1)").run(
        payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration,
        payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), seq,
      );
      this.#db.prepare("UPDATE runs SET active_session_generation=?, status='active', version=version+1 WHERE repo_id=? AND workstream_run=?").run(nextGeneration, request.repo_id, workstreamRun);
      const nextRun = this.#requireRun(request.repo_id, workstreamRun);
      const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached session'));
      return { sequence: seq, eventType: 'session-attached', entityType: 'session-lease', entityId: session.session_lease_id, payload: { run: nextRun, session } };
    });
  }

  detachSession(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#sessionMutation(request, 'session-detached', (session) => {
      this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=?").run(session.session_lease_id);
      return { entityId: session.session_lease_id, payload: { session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'detached session')), reason: payloadString(request.payload, 'reason') } };
    });
  }

  prepareHandoff(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#sessionMutation(request, 'session-handoff-prepared', (session, seq) => {
      const token = payloadString(request.payload, 'handoff_token');
      this.#db.prepare("UPDATE session_leases SET status='handoff-pending', version=version+1 WHERE session_lease_id=?").run(session.session_lease_id);
      this.#db.prepare("INSERT INTO handoffs(handoff_token, repo_id, workstream_run, from_session_lease_id, status, created_event_seq, consumed_event_seq) VALUES(?, ?, ?, ?, 'pending', ?, NULL)").run(token, request.repo_id, this.#workstreamRun(request), session.session_lease_id, seq);
      return { entityId: session.session_lease_id, payload: { handoff_token: token, session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'handoff session')) } };
    });
  }

  heartbeatSession(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#sessionMutation(request, 'session-heartbeat', (session) => {
      this.#db.prepare('UPDATE session_leases SET lease_expires_at=?, version=version+1 WHERE session_lease_id=?').run(payloadString(request.payload, 'lease_expires_at'), session.session_lease_id);
      return { entityId: session.session_lease_id, payload: { session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'heartbeat session')) } };
    });
  }

  registerChild(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const session = this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      const seq = this.#nextEventSequence(request.repo_id);
      const childId = payloadString(request.payload, 'child_lease_id');
      const childTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'child_token'), 'utf8').digest('hex');
      this.#db.prepare("INSERT INTO child_leases(child_lease_id, repo_id, autopilot_id, workstream_run, unit_id, attempt, pid, boot_id, child_token_sha256, lease_expires_at, status, terminal_evidence_ref, terminal_evidence_sha256, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, 1)").run(
        childId, request.repo_id, payloadString(request.payload, 'autopilot_id'), this.#workstreamRun(request), payloadString(request.payload, 'unit_id'), payloadInteger(request.payload, 'attempt'), payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), childTokenSha256, payloadString(request.payload, 'lease_expires_at'),
      );
      const child = childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'registered child'));
      return { sequence: seq, eventType: 'child-registered', entityType: 'child-lease', entityId: childId, payload: { child, authorizing_session_lease_id: session.session_lease_id } };
    });
  }

  heartbeatChild(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const childId = payloadString(request.payload, 'child_lease_id');
      const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
      const child = childFromRow(childRow);
      this.#assertChildAuthority(request, child, childRow);
      this.#assertVersion(child.version, request.expected_version, 'child lease');
      if (child.status !== 'running') throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare('UPDATE child_leases SET lease_expires_at=?, version=version+1 WHERE child_lease_id=?').run(payloadString(request.payload, 'lease_expires_at'), childId);
      return { sequence: seq, eventType: 'child-heartbeat', entityType: 'child-lease', entityId: childId, payload: { child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'heartbeat child')) } };
    });
  }

  completeChild(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const childId = payloadString(request.payload, 'child_lease_id');
      const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
      const child = childFromRow(childRow);
      this.#assertChildAuthority(request, child, childRow);
      this.#assertVersion(child.version, request.expected_version, 'child lease');
      if (child.status !== 'running') throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
      const status = payloadString(request.payload, 'status');
      const evidenceRef = payloadNullableString(request.payload, 'evidence_ref');
      const evidenceSha = payloadNullableString(request.payload, 'evidence_sha256');
      if (status === 'terminal' && (evidenceRef === null || evidenceSha === null || !SHA256_PATTERN.test(evidenceSha))) throw new CoordinationRuntimeError('invalid-request', 'terminal child completion requires immutable evidence');
      if (status === 'recovery-required' && (evidenceRef !== null || evidenceSha !== null)) throw new CoordinationRuntimeError('invalid-request', 'recovery-required child completion must not claim terminal evidence');
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare('UPDATE child_leases SET status=?, terminal_evidence_ref=?, terminal_evidence_sha256=?, version=version+1 WHERE child_lease_id=?').run(status, evidenceRef, evidenceSha, childId);
      return { sequence: seq, eventType: status === 'terminal' ? 'child-terminal' : 'child-recovery-required', entityType: 'child-lease', entityId: childId, payload: { child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'completed child')) } };
    });
  }

  acquireGroup(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      const groupId = payloadString(request.payload, 'acquisition_group_id');
      if (this.#db.prepare('SELECT entity_id FROM acquisition_groups WHERE repo_id=? AND entity_id=?').get(request.repo_id, groupId) !== undefined) throw new CoordinationRuntimeError('stale-version', 'acquisition group already exists; retry with its original idempotency key or query status');
      const owner: CoordinationOwnerIdentity = {
        repo_id: request.repo_id,
        autopilot_id: run.autopilot_id,
        workstream_run: run.workstream_run,
        unit_id: payloadString(request.payload, 'unit_id'),
        attempt: payloadInteger(request.payload, 'attempt'),
      };
      const requestedLeases = payloadRequestedLeases(request.payload);
      const releaseCondition = payloadReleaseCondition(request.payload, 'normal_release_condition');
      const seq = this.#nextEventSequence(request.repo_id);
      const attempt: CoordinationUnitAttempt = {
        schema_version: 'autopilot.unit_attempt.v1', owner, state: 'preflight',
        spec: { ref: payloadString(request.payload, 'spec_ref'), sha256: payloadString(request.payload, 'spec_sha256') as `sha256:${string}` },
        preemptible: payloadBoolean(request.payload, 'preemptible'), checkpoint_ordinal: payloadInteger(request.payload, 'checkpoint_ordinal'), critical_section: null, version: 1,
      };
      this.#insertOrVerifyUnitAttempt(attempt);
      this.#assertReleaseConditionOwner(releaseCondition, owner);
      const group: CoordinationAcquisitionGroup = {
        schema_version: 'autopilot.acquisition_group.v2', acquisition_group_id: groupId, owner, requested_leases: requestedLeases,
        reason: payloadString(request.payload, 'reason'), normal_release_condition: releaseCondition, state: 'waiting', created_event_seq: seq, fairness_event_seq: seq,
        grant_event_seq: null, offer_expires_at: null, offer_count: 0, bypass_count: 0, version: 1,
      };
      this.#insertEntity('acquisition_groups', groupId, owner.repo_id, owner.workstream_run, group);
      const expiredOffers = this.#expireGrantOffers(request.repo_id, seq);
      if (expiredOffers) this.#reevaluateWaitingGroups(request.repo_id, seq);
      const currentGroup = expiredOffers ? this.#requireGroup(request.repo_id, groupId) : group;
      if (currentGroup.state === 'grant-ready') {
        const requests = this.#claimRequestsForGroup(request.repo_id, groupId);
        return { sequence: seq, eventType: 'acquisition-group-waiting', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'waiting-for-peer-release', acquisition_group: currentGroup, claim_requests: requests, request_refs: requests.map((entry) => entry.request_id) } };
      }
      const blockers = this.#blockingLeases(owner.repo_id, requestedLeases);
      if (blockers.some((lease) => sameOwner(lease.owner, owner))) throw new CoordinationRuntimeError('invalid-state', 'new acquisition group redundantly overlaps authority already held by the same unit attempt');
      const offeredBlockers = this.#blockingGrantOffers(owner.repo_id, groupId, requestedLeases);
      if (blockers.length === 0 && offeredBlockers.length === 0) {
        const granted = this.#grantGroup(currentGroup, seq);
        this.#reevaluateWaitingGroups(request.repo_id, seq);
        return { sequence: seq, eventType: 'acquisition-group-granted', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'granted', acquisition_group: granted.group, edit_leases: granted.leases, request_refs: [] } };
      }
      const requests = this.#ensureClaimRequests(currentGroup, blockers, seq);
      return { sequence: seq, eventType: 'acquisition-group-waiting', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'waiting-for-peer-release', acquisition_group: currentGroup, claim_requests: requests, request_refs: requests.map((entry) => entry.request_id) } };
    });
  }

  acknowledgeGrant(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const groupId = payloadString(request.payload, 'acquisition_group_id');
      const group = this.#requireGroup(request.repo_id, groupId);
      this.#assertGroupOwner(request, group);
      this.#assertVersion(group.version, request.expected_version, 'acquisition group');
      const seq = this.#nextEventSequence(request.repo_id);
      const offerExpired = this.#expireGrantOffers(request.repo_id, seq);
      if (offerExpired) {
        this.#reevaluateWaitingGroups(request.repo_id, seq);
        const requeued = this.#requireGroup(request.repo_id, groupId);
        return { sequence: seq, eventType: 'grant-offer-expired', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'offer-expired', acquisition_group: requeued, edit_leases: [] } };
      }
      const current = this.#requireGroup(request.repo_id, groupId);
      if (current.state !== 'grant-ready') throw new CoordinationRuntimeError('invalid-state', `acquisition group is ${current.state}, not grant-ready`);
      if (current.offer_expires_at === null || Date.parse(current.offer_expires_at) <= this.#clock.now().getTime()) throw new CoordinationRuntimeError('stale-version', 'grant offer expired before requester preflight acknowledgement');
      if (this.#blockingLeases(request.repo_id, current.requested_leases).length > 0) throw new CoordinationRuntimeError('coordinator-contention', 'grant offer is no longer completely free');
      const granted = this.#grantGroup(current, seq);
      this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND correlation_id=? AND message_type='grant-offer' AND status!='acknowledged'").run(seq, seq, request.repo_id, groupId);
      const groupRequests = this.#claimRequestsForGroup(request.repo_id, groupId);
      for (const claimRequest of groupRequests) {
        const next: CoordinationClaimRequest = { ...claimRequest, status: 'resolved', grant_event_seq: seq, version: claimRequest.version + 1 };
        this.#updateClaimRequest(next);
      }
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'acquisition-group-granted', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'granted', acquisition_group: granted.group, edit_leases: granted.leases, request_refs: groupRequests.map((entry) => entry.request_id), grant_evidence: { acquisition_group_id: groupId, grant_event_seq: seq, lease_ids: granted.leases.map((entry) => entry.edit_lease_id) } } };
    });
  }

  respondClaimRequest(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const requestId = payloadString(request.payload, 'request_id');
      const claimRequest = this.#requireClaimRequest(requestId);
      this.#assertRequestOwner(request, claimRequest);
      this.#assertVersion(claimRequest.version, request.expected_version, 'claim request');
      if (!['pending', 'delivered', 'acknowledged', 'deferred'].includes(claimRequest.status)) throw new CoordinationRuntimeError('invalid-state', `claim request is ${claimRequest.status}`);
      const seq = this.#nextEventSequence(request.repo_id);
      const offersExpired = this.#expireGrantOffers(request.repo_id, seq);
      if (payloadString(request.payload, 'response') === 'deferred') {
        const condition = payloadReleaseCondition(request.payload, 'release_condition');
        this.#assertReleaseConditionOwner(condition, claimRequest.owner);
        const deferred: CoordinationClaimRequest = { ...claimRequest, status: 'deferred', owner_reason: payloadString(request.payload, 'owner_reason'), release_condition: condition, version: claimRequest.version + 1 };
        this.#updateClaimRequest(deferred);
        if (offersExpired) this.#reevaluateWaitingGroups(request.repo_id, seq);
        return { sequence: seq, eventType: 'claim-request-deferred', entityType: 'claim-request', entityId: requestId, payload: { claim_request: deferred } };
      }
      const releasedLeaseIds: string[] = [];
      for (const leaseId of claimRequest.blocking_lease_ids) {
        const row = this.#db.prepare('SELECT * FROM edit_leases WHERE entity_id=?').get(leaseId);
        if (row === undefined) continue;
        const lease = editLeaseFromRow(row);
        if (!sameOwner(lease.owner, claimRequest.owner)) throw new CoordinationRuntimeError('invalid-state', 'claim request blocking lease changed durable owner');
        this.#db.prepare('DELETE FROM edit_leases WHERE entity_id=?').run(leaseId);
        releasedLeaseIds.push(leaseId);
        this.#markGroupReleasedWhenEmpty(lease.owner.repo_id, lease.acquisition_group_id);
      }
      const released: CoordinationClaimRequest = { ...claimRequest, status: 'released', owner_reason: payloadNullableString(request.payload, 'owner_reason'), release_condition: claimRequest.release_condition, release_event_seq: seq, version: claimRequest.version + 1 };
      this.#updateClaimRequest(released);
      const notification = this.#releaseNotification(released, releasedLeaseIds, seq);
      this.#insertMessage(notification);
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'claim-request-released', entityType: 'claim-request', entityId: requestId, payload: { claim_request: this.#requireClaimRequest(requestId), released_lease_ids: releasedLeaseIds, release_notification: notification } };
    });
  }

  cancelClaimRequest(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const claimRequest = this.#requireClaimRequest(payloadString(request.payload, 'request_id'));
      this.#assertRequestRequester(request, claimRequest);
      this.#assertVersion(claimRequest.version, request.expected_version, 'claim request');
      const group = this.#requireGroup(request.repo_id, claimRequest.acquisition_group_id);
      if (group.state === 'granted') throw new CoordinationRuntimeError('invalid-state', 'a granted acquisition group must release through its owner lifecycle');
      const seq = this.#nextEventSequence(request.repo_id);
      this.#cancelGroup(group, 'cancelled', seq);
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'claim-request-cancelled', entityType: 'claim-request', entityId: claimRequest.request_id, payload: { acquisition_group: this.#requireGroup(request.repo_id, group.acquisition_group_id), request_refs: this.#claimRequestsForGroup(request.repo_id, group.acquisition_group_id).map((entry) => entry.request_id), reason: payloadString(request.payload, 'reason') } };
    });
  }

  cancelAcquisitionGroup(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const group = this.#requireGroup(request.repo_id, payloadString(request.payload, 'acquisition_group_id'));
      this.#assertGroupOwner(request, group);
      this.#assertVersion(group.version, request.expected_version, 'acquisition group');
      const seq = this.#nextEventSequence(request.repo_id);
      this.#cancelGroup(group, 'cancelled', seq);
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'acquisition-group-cancelled', entityType: 'acquisition-group', entityId: group.acquisition_group_id, payload: { acquisition_group: this.#requireGroup(request.repo_id, group.acquisition_group_id), request_refs: this.#claimRequestsForGroup(request.repo_id, group.acquisition_group_id).map((entry) => entry.request_id), reason: payloadString(request.payload, 'reason') } };
    });
  }

  supersedeAttempt(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      const unitId = payloadString(request.payload, 'unit_id');
      const attemptNumber = payloadInteger(request.payload, 'attempt');
      const attempt = this.#requireUnitAttempt(request.repo_id, run.workstream_run, unitId, attemptNumber);
      this.#assertVersion(attempt.version, request.expected_version, 'unit attempt');
      const seq = this.#nextEventSequence(request.repo_id);
      const groups = this.#groupsForAttempt(attempt.owner);
      if (groups.some((group) => group.state === 'granted')) throw new CoordinationRuntimeError('invalid-state', 'running/granted attempt must release or quarantine before supersession');
      for (const group of groups) this.#cancelGroup(group, 'superseded', seq);
      const superseded: CoordinationUnitAttempt = { ...attempt, state: 'superseded', version: attempt.version + 1 };
      this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), superseded);
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'unit-attempt-superseded', entityType: 'unit-attempt', entityId: unitAttemptEntityId(attempt.owner), payload: { unit_attempt: superseded, superseded_by_attempt: payloadInteger(request.payload, 'superseded_by_attempt'), reason: payloadString(request.payload, 'reason'), request_refs: groups.flatMap((group) => this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id).map((entry) => entry.request_id)) } };
    });
  }

  drainMailbox(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#sessionMutation(request, 'mailbox-drained', (session, seq) => {
      const workstreamRun = this.#workstreamRun(request);
      this.#db.prepare("UPDATE messages SET status='delivered', delivered_event_seq=COALESCE(delivered_event_seq, ?), version=version+1 WHERE repo_id=? AND recipient_workstream_run=? AND status='pending'").run(seq, request.repo_id, workstreamRun);
      const messages = this.#db.prepare("SELECT * FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status='delivered' ORDER BY created_event_seq, message_id").all(request.repo_id, workstreamRun).map(messageFromRow);
      for (const message of messages) {
        if (message.message_type !== 'claim-request') continue;
        const claimRequest = this.#requireClaimRequest(message.correlation_id);
        if (claimRequest.status === 'pending') this.#updateClaimRequest({ ...claimRequest, status: 'delivered', version: claimRequest.version + 1 });
      }
      return { entityId: payloadString(request.payload, 'delivery_id'), payload: { delivery_id: payloadString(request.payload, 'delivery_id'), session_version: session.version, messages } };
    });
  }

  acknowledgeMessage(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const messageId = payloadString(request.payload, 'message_id');
      const message = messageFromRow(asRow(this.#db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId), 'message'));
      if (message.repo_id !== request.repo_id || message.recipient_workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session does not own mailbox message');
      this.#assertVersion(message.version, request.expected_version, 'message');
      if (message.status !== 'delivered') throw new CoordinationRuntimeError('invalid-state', `message is ${message.status}`);
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare("UPDATE messages SET status='acknowledged', acknowledged_event_seq=?, version=version+1 WHERE message_id=?").run(seq, messageId);
      if (message.message_type === 'claim-request') {
        const claimRequest = this.#requireClaimRequest(message.correlation_id);
        if (claimRequest.status === 'delivered') this.#updateClaimRequest({ ...claimRequest, status: 'acknowledged', version: claimRequest.version + 1 });
      } else if (message.message_type === 'release-notification') {
        const claimRequest = this.#requireClaimRequest(message.correlation_id);
        if (claimRequest.status === 'released') this.#updateClaimRequest({ ...claimRequest, status: 'requester-notified', version: claimRequest.version + 1 });
      }
      return { sequence: seq, eventType: 'message-acknowledged', entityType: 'message', entityId: messageId, payload: { message: messageFromRow(asRow(this.#db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId), 'acknowledged message')) } };
    });
  }

  enqueueMessageForTest(message: CoordinationMessage): void {
    const parsed = parseCoordinationMessage(message);
    this.#db.prepare('INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      parsed.message_id, parsed.repo_id, parsed.recipient_workstream_run, parsed.message_type, parsed.correlation_id, canonicalJson(parsed.payload), parsed.status, parsed.created_event_seq, parsed.delivered_event_seq, parsed.acknowledged_event_seq, parsed.version,
    );
  }

  #insertEntity(table: 'unit_attempts' | 'acquisition_groups' | 'edit_leases', entityId: string, repoId: string, workstreamRun: string, entity: CoordinationUnitAttempt | CoordinationAcquisitionGroup | CoordinationEditLease): void {
    this.#db.prepare(`INSERT INTO ${table}(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)`).run(entityId, repoId, workstreamRun, canonicalJson(entity), entity.version);
  }

  #updateEntity(table: 'unit_attempts' | 'acquisition_groups' | 'edit_leases', entityId: string, entity: CoordinationUnitAttempt | CoordinationAcquisitionGroup | CoordinationEditLease): void {
    const result = table === 'acquisition_groups'
      ? this.#db.prepare('UPDATE acquisition_groups SET payload_json=?, version=? WHERE repo_id=? AND entity_id=?').run(canonicalJson(entity), entity.version, entity.owner.repo_id, entityId)
      : this.#db.prepare(`UPDATE ${table} SET payload_json=?, version=? WHERE entity_id=?`).run(canonicalJson(entity), entity.version, entityId);
    if (result.changes !== 1) throw new CoordinationRuntimeError('invalid-state', `${table} entity ${entityId} disappeared during mutation`);
  }

  #insertOrVerifyUnitAttempt(attempt: CoordinationUnitAttempt): void {
    const entityId = unitAttemptEntityId(attempt.owner);
    const row = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
    if (row === undefined) {
      this.#insertEntity('unit_attempts', entityId, attempt.owner.repo_id, attempt.owner.workstream_run, attempt);
      return;
    }
    const existing = unitAttemptFromRow(row);
    if (!sameOwner(existing.owner, attempt.owner) || canonicalJson(existing.spec) !== canonicalJson(attempt.spec)) throw new CoordinationRuntimeError('invalid-state', 'unit attempt identity was reused with different immutable spec evidence');
    if (existing.state === 'superseded' || existing.state === 'reset' || existing.state === 'failed' || existing.state === 'quarantined') throw new CoordinationRuntimeError('invalid-state', `unit attempt is ${existing.state}`);
  }

  #requireUnitAttempt(repoId: string, workstreamRun: string, unitId: string, attempt: number): CoordinationUnitAttempt {
    const run = this.#requireRun(repoId, workstreamRun);
    const owner: CoordinationOwnerIdentity = { repo_id: repoId, autopilot_id: run.autopilot_id, workstream_run: workstreamRun, unit_id: unitId, attempt };
    return unitAttemptFromRow(asRow(this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(owner)), 'unit attempt'));
  }

  #requireGroup(repoId: string, groupId: string): CoordinationAcquisitionGroup {
    return acquisitionGroupFromRow(asRow(this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND entity_id=?').get(repoId, groupId), 'acquisition group'));
  }

  #requireClaimRequest(requestId: string): CoordinationClaimRequest {
    return claimRequestFromRow(asRow(this.#db.prepare('SELECT * FROM claim_requests WHERE entity_id=?').get(requestId), 'claim request'));
  }

  #claimRequestsForGroup(repoId: string, groupId: string): readonly CoordinationClaimRequest[] {
    return this.#db.prepare("SELECT * FROM claim_requests WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=? ORDER BY entity_id").all(repoId, groupId).map(claimRequestFromRow);
  }

  #groupsForAttempt(owner: CoordinationOwnerIdentity): readonly CoordinationAcquisitionGroup[] {
    return this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(owner.repo_id, owner.workstream_run).map(acquisitionGroupFromRow).filter((group) => sameOwner(group.owner, owner));
  }

  #assertReleaseConditionOwner(condition: CoordinationReleaseCondition, owner: CoordinationOwnerIdentity): void {
    if (condition.condition_type === 'run-closed' && condition.target_id !== owner.workstream_run) throw new CoordinationRuntimeError('invalid-request', 'run-closed condition must target the blocking owner run');
    if ((condition.condition_type === 'unit-merged' || condition.condition_type === 'attempt-reset' || condition.condition_type === 'quarantine-captured') && condition.target_id !== `${owner.unit_id}:${String(owner.attempt)}`) throw new CoordinationRuntimeError('invalid-request', `${condition.condition_type} condition must target the blocking owner unit attempt`);
    if (condition.condition_type === 'child-terminal') {
      const expectedChildId = `child-${owner.workstream_run}-${owner.unit_id}-${String(owner.attempt)}`;
      if (condition.target_id !== expectedChildId) throw new CoordinationRuntimeError('invalid-request', 'child-terminal condition must target the deterministic child lease for the blocking unit attempt');
      const row = this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(condition.target_id);
      if (row !== undefined && !sameOwner(childFromRow(row).owner, owner)) throw new CoordinationRuntimeError('invalid-request', 'child-terminal condition targets a child lease with different durable ownership');
    }
  }

  #assertGroupOwner(request: CoordinatorRequestEnvelope, group: CoordinationAcquisitionGroup): void {
    if (group.owner.repo_id !== request.repo_id || group.owner.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session does not own acquisition group');
  }

  #assertRequestOwner(request: CoordinatorRequestEnvelope, claimRequest: CoordinationClaimRequest): void {
    if (claimRequest.owner.repo_id !== request.repo_id || claimRequest.owner.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session is not the blocking claim owner');
  }

  #assertRequestRequester(request: CoordinatorRequestEnvelope, claimRequest: CoordinationClaimRequest): void {
    if (claimRequest.requester.repo_id !== request.repo_id || claimRequest.requester.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session is not the claim requester');
  }

  #blockingLeases(repoId: string, requested: readonly CoordinationRequestedLease[]): readonly CoordinationEditLease[] {
    const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow);
    return Object.freeze(leases.filter((lease) => requested.some((entry) => coordinationPathsOverlap(entry.path, lease.path) && claimModesConflict(entry.mode, lease.mode))));
  }

  #blockingGrantOffers(repoId: string, groupId: string, requested: readonly CoordinationRequestedLease[]): readonly CoordinationAcquisitionGroup[] {
    const offered = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY entity_id').all(repoId).map(acquisitionGroupFromRow);
    return Object.freeze(offered.filter((group) => group.acquisition_group_id !== groupId && group.state === 'grant-ready' && requested.some((entry) => group.requested_leases.some((offeredLease) => coordinationPathsOverlap(entry.path, offeredLease.path) && claimModesConflict(entry.mode, offeredLease.mode)))));
  }

  #grantGroup(group: CoordinationAcquisitionGroup, seq: number): { readonly group: CoordinationAcquisitionGroup; readonly leases: readonly CoordinationEditLease[] } {
    if (this.#blockingLeases(group.owner.repo_id, group.requested_leases).length > 0) throw new CoordinationRuntimeError('coordinator-contention', 'complete acquisition group became blocked before grant');
    const leases = group.requested_leases.map((requested, index): CoordinationEditLease => ({
      schema_version: 'autopilot.edit_lease.v1',
      edit_lease_id: stableEntityId('lease', [group.owner.repo_id, group.acquisition_group_id, String(index), requested.mode, requested.path]),
      owner: group.owner, acquisition_group_id: group.acquisition_group_id, path: requested.path, mode: requested.mode, purpose: requested.purpose,
      acquired_event_seq: seq, normal_release_condition: group.normal_release_condition, version: 1,
    }));
    for (const lease of leases) this.#insertEntity('edit_leases', lease.edit_lease_id, lease.owner.repo_id, lease.owner.workstream_run, lease);
    const granted: CoordinationAcquisitionGroup = { ...group, state: 'granted', grant_event_seq: seq, offer_expires_at: null, version: group.version + 1 };
    this.#updateEntity('acquisition_groups', group.acquisition_group_id, granted);
    return { group: granted, leases };
  }

  #ensureClaimRequests(group: CoordinationAcquisitionGroup, blockers: readonly CoordinationEditLease[], seq: number): readonly CoordinationClaimRequest[] {
    const byOwner = new Map<string, CoordinationEditLease[]>();
    for (const blocker of blockers) {
      const key = ownerIdentityKey(blocker.owner);
      const owned = byOwner.get(key) ?? [];
      owned.push(blocker);
      byOwner.set(key, owned);
    }
    const requests: CoordinationClaimRequest[] = [];
    for (const owned of [...byOwner.values()].sort((left, right) => ownerIdentityKey(left[0]?.owner ?? group.owner).localeCompare(ownerIdentityKey(right[0]?.owner ?? group.owner)))) {
      const owner = owned[0]?.owner;
      if (owner === undefined) continue;
      const leaseIds = owned.map((lease) => lease.edit_lease_id).sort();
      const requestId = stableEntityId('claim-request', [group.acquisition_group_id, ownerIdentityKey(owner), ...leaseIds]);
      const existingRow = this.#db.prepare('SELECT * FROM claim_requests WHERE entity_id=?').get(requestId);
      if (existingRow !== undefined) {
        requests.push(claimRequestFromRow(existingRow));
        continue;
      }
      const claimRequest: CoordinationClaimRequest = {
        schema_version: 'autopilot.claim_request.v1', request_id: requestId, acquisition_group_id: group.acquisition_group_id,
        requester: group.owner, owner, blocking_lease_ids: leaseIds, requested_leases: group.requested_leases, reason: group.reason,
        created_event_seq: seq, status: 'pending', owner_reason: null, release_condition: null, release_event_seq: null, grant_event_seq: null, version: 1,
      };
      this.#db.prepare('INSERT INTO claim_requests(entity_id, repo_id, requester_workstream_run, owner_workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?, ?)').run(requestId, owner.repo_id, group.owner.workstream_run, owner.workstream_run, canonicalJson(claimRequest), claimRequest.version);
      const message: CoordinationMessage = {
        schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['claim-request', requestId]), repo_id: owner.repo_id,
        recipient_workstream_run: owner.workstream_run, message_type: 'claim-request', correlation_id: requestId,
        payload: { request_id: requestId, acquisition_group_id: group.acquisition_group_id, requester_run: group.owner.workstream_run, requester_unit: group.owner.unit_id, requester_attempt: group.owner.attempt, blocking_lease_ids: leaseIds, requested_leases: group.requested_leases, reason: group.reason },
        status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
      };
      this.#insertMessage(message);
      requests.push(claimRequest);
    }
    return Object.freeze(requests);
  }

  #updateClaimRequest(claimRequest: CoordinationClaimRequest): void {
    const result = this.#db.prepare('UPDATE claim_requests SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(claimRequest), claimRequest.version, claimRequest.request_id);
    if (result.changes !== 1) throw new CoordinationRuntimeError('invalid-state', `claim request ${claimRequest.request_id} disappeared during mutation`);
  }

  #insertMessage(message: CoordinationMessage): void {
    this.#db.prepare('INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      message.message_id, message.repo_id, message.recipient_workstream_run, message.message_type, message.correlation_id, canonicalJson(message.payload), message.status, message.created_event_seq, message.delivered_event_seq, message.acknowledged_event_seq, message.version,
    );
  }

  #releaseNotification(claimRequest: CoordinationClaimRequest, releasedLeaseIds: readonly string[], seq: number): CoordinationMessage {
    return {
      schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['release-notification', claimRequest.request_id, String(seq)]), repo_id: claimRequest.requester.repo_id,
      recipient_workstream_run: claimRequest.requester.workstream_run, message_type: 'release-notification', correlation_id: claimRequest.request_id,
      payload: { request_id: claimRequest.request_id, acquisition_group_id: claimRequest.acquisition_group_id, released_lease_ids: [...releasedLeaseIds], release_event_seq: seq },
      status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
    };
  }

  #markGroupReleasedWhenEmpty(repoId: string, groupId: string): void {
    const count = sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM edit_leases WHERE repo_id=? AND json_extract(payload_json, \'$.acquisition_group_id\')=?').get(repoId, groupId), 'group lease count'), 'count');
    if (count !== 0) return;
    const group = this.#requireGroup(repoId, groupId);
    if (group.state === 'granted') this.#updateEntity('acquisition_groups', groupId, { ...group, state: 'released', version: group.version + 1 });
  }

  #markSatisfiedRequests(group: CoordinationAcquisitionGroup, seq: number): void {
    for (const claimRequest of this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id)) {
      if (['resolved', 'cancelled', 'superseded', 'released', 'grant-ready', 'requester-notified'].includes(claimRequest.status)) continue;
      const stillBlocked = claimRequest.blocking_lease_ids.some((leaseId) => this.#db.prepare('SELECT entity_id FROM edit_leases WHERE repo_id=? AND entity_id=?').get(group.owner.repo_id, leaseId) !== undefined);
      if (stillBlocked) continue;
      const released: CoordinationClaimRequest = { ...claimRequest, status: 'released', release_event_seq: seq, version: claimRequest.version + 1 };
      this.#updateClaimRequest(released);
      this.#insertMessage(this.#releaseNotification(released, claimRequest.blocking_lease_ids, seq));
    }
  }

  #reevaluateWaitingGroups(repoId: string, seq: number): void {
    const waiting = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY json_extract(payload_json, \'$.fairness_event_seq\'), entity_id').all(repoId).map(acquisitionGroupFromRow).filter((group) => group.state === 'waiting');
    for (const group of waiting) {
      this.#markSatisfiedRequests(group, seq);
      const blockers = this.#blockingLeases(repoId, group.requested_leases);
      this.#ensureClaimRequests(group, blockers, seq);
      if (blockers.length > 0 || this.#blockingGrantOffers(repoId, group.acquisition_group_id, group.requested_leases).length > 0) continue;
      const offered: CoordinationAcquisitionGroup = { ...group, state: 'grant-ready', offer_expires_at: new Date(this.#clock.now().getTime() + COORDINATOR_GRANT_OFFER_TTL_MS).toISOString(), version: group.version + 1 };
      this.#updateEntity('acquisition_groups', group.acquisition_group_id, offered);
      for (const claimRequest of this.#claimRequestsForGroup(repoId, group.acquisition_group_id)) {
        if (claimRequest.release_event_seq === null || ['cancelled', 'superseded', 'resolved'].includes(claimRequest.status)) continue;
        this.#updateClaimRequest({ ...claimRequest, status: 'grant-ready', version: claimRequest.version + 1 });
      }
      this.#insertMessage({
        schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['grant-offer', group.owner.repo_id, group.acquisition_group_id, String(offered.version)]), repo_id: repoId,
        recipient_workstream_run: group.owner.workstream_run, message_type: 'grant-offer', correlation_id: group.acquisition_group_id,
        payload: { acquisition_group_id: group.acquisition_group_id, offer_expires_at: offered.offer_expires_at, request_refs: this.#claimRequestsForGroup(repoId, group.acquisition_group_id).map((entry) => entry.request_id) },
        status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
      });
    }
  }

  #expireGrantOffers(repoId: string, seq: number): boolean {
    const now = this.#clock.now().toISOString();
    const offered = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready' ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow);
    let expired = false;
    for (const group of offered) {
      if (group.offer_expires_at === null || group.offer_expires_at > now) continue;
      expired = true;
      this.#updateEntity('acquisition_groups', group.acquisition_group_id, { ...group, state: 'waiting', offer_expires_at: null, offer_count: group.offer_count + 1, fairness_event_seq: seq, version: group.version + 1 });
      this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND correlation_id=? AND message_type='grant-offer' AND status!='acknowledged'").run(seq, seq, repoId, group.acquisition_group_id);
      for (const claimRequest of this.#claimRequestsForGroup(repoId, group.acquisition_group_id)) {
        if (claimRequest.status === 'grant-ready') this.#updateClaimRequest({ ...claimRequest, status: 'released', version: claimRequest.version + 1 });
      }
    }
    return expired;
  }

  #cancelGroup(group: CoordinationAcquisitionGroup, status: 'cancelled' | 'superseded', seq: number): void {
    if (group.state !== 'waiting' && group.state !== 'grant-ready') throw new CoordinationRuntimeError('invalid-state', `cannot ${status} acquisition group in state ${group.state}`);
    this.#updateEntity('acquisition_groups', group.acquisition_group_id, { ...group, state: status, offer_expires_at: null, version: group.version + 1 });
    for (const claimRequest of this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id)) {
      if (claimRequest.status === 'resolved' || claimRequest.status === 'cancelled' || claimRequest.status === 'superseded') continue;
      this.#updateClaimRequest({ ...claimRequest, status, version: claimRequest.version + 1 });
    }
    this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND (correlation_id=? OR correlation_id IN (SELECT entity_id FROM claim_requests WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=?)) AND status!='acknowledged'").run(seq, seq, group.owner.repo_id, group.acquisition_group_id, group.owner.repo_id, group.acquisition_group_id);
  }

  #sessionMutation(request: CoordinatorRequestEnvelope, eventType: string, apply: (session: CoordinationSessionLease, sequence: number) => { readonly entityId: string; readonly payload: Readonly<Record<string, unknown>> }): IdempotentEffect {
    return this.#mutation(request, () => {
      const session = this.#requireCurrentSession(request);
      this.#assertVersion(session.version, request.expected_version, 'session lease');
      const seq = this.#nextEventSequence(request.repo_id);
      const applied = apply(session, seq);
      return { sequence: seq, eventType, entityType: 'session-lease', entityId: applied.entityId, payload: applied.payload };
    });
  }

  #mutation(request: CoordinatorRequestEnvelope, apply: () => { readonly sequence: number; readonly eventType: string; readonly entityType: string; readonly entityId: string; readonly payload: Readonly<Record<string, unknown>> }): IdempotentEffect {
    const idempotencyKey = request.idempotency_key;
    if (idempotencyKey === null) throw new CoordinationRuntimeError('invalid-request', 'mutation lacks idempotency key');
    const digest = requestDigest(request);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.#db.prepare('SELECT request_sha256, committed_event_seq, payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(request.repo_id, idempotencyKey);
      if (prior !== undefined) {
        this.#assertReplayAuthority(request);
        if (sqlString(prior, 'request_sha256') !== digest) throw new CoordinationRuntimeError('idempotency-conflict', 'idempotency key was reused with a different request');
        const replay: IdempotentEffect = { committedEventSeq: sqlInteger(prior, 'committed_event_seq'), payload: parseJsonObject(sqlString(prior, 'payload_json'), 'idempotency payload'), replayed: true };
        this.#db.exec('COMMIT');
        return replay;
      }
      const result = apply();
      const committed = this.#commitDescription(result.sequence, result.eventType, result.entityType, result.entityId, result.payload);
      this.#db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(request.repo_id, result.sequence, result.eventType, result.entityType, result.entityId, idempotencyKey, digest, this.#clock.now().toISOString());
      this.#db.prepare('INSERT INTO idempotency_results(repo_id, idempotency_key, request_sha256, committed_event_seq, payload_json) VALUES(?, ?, ?, ?, ?)').run(request.repo_id, idempotencyKey, digest, result.sequence, canonicalJson(committed.payload));
      this.#db.exec('COMMIT');
      return { ...committed, replayed: false };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #commitDescription(sequence: number, eventType: string, entityType: string, entityId: string, payload: Readonly<Record<string, unknown>>): StoreEffect {
    return { committedEventSeq: sequence, payload: { ...payload, event_type: eventType, entity_type: entityType, entity_id: entityId } };
  }

  #nextEventSequence(repoId: string): number {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(repoId), 'repository'));
    const next = this.#db.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(repoId);
    const sequence = sqlInteger(asRow(next, 'repository event sequence'), 'event_seq') + 1;
    this.#db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(sequence, repository.repo_id);
    return sequence;
  }

  #requireRun(repoId: string, workstreamRun: string): CoordinationRun {
    return runFromRow(asRow(this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(repoId, workstreamRun), 'run'));
  }

  #requireCurrentSession(request: CoordinatorRequestEnvelope): CoordinationSessionLease {
    const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
    const sessionId = this.#sessionId(request);
    const generation = request.fencing_generation;
    if (generation === null || generation !== run.active_session_generation) throw new CoordinationRuntimeError('fenced-session', 'session generation is no longer current');
    const row = this.#db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND session_id=? AND session_generation=? AND status='attached'").get(request.repo_id, run.workstream_run, sessionId, generation);
    if (row === undefined) throw new CoordinationRuntimeError('fenced-session', 'session is not attached to the durable run supervisor');
    if (sqlString(row, 'session_lease_id') !== payloadString(request.payload, 'session_lease_id')) throw new CoordinationRuntimeError('unauthorized-client', 'session lease identity does not match current authority');
    this.#assertCapability(row, 'session_token_sha256', payloadString(request.payload, 'session_token'), 'session');
    return sessionFromRow(row);
  }

  #assertReplayAuthority(request: CoordinatorRequestEnvelope): void {
    if (request.action === 'attach-run') return;
    if (request.action === 'heartbeat-child' || request.action === 'complete-child') {
      const childId = payloadString(request.payload, 'child_lease_id');
      const row = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child replay authority');
      this.#assertChildAuthority(request, childFromRow(row), row);
      return;
    }
    const sessionLeaseId = payloadString(request.payload, 'session_lease_id');
    const row = asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(sessionLeaseId), 'session replay authority');
    const session = sessionFromRow(row);
    const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
    if (session.repo_id !== request.repo_id || session.workstream_run !== run.workstream_run || session.session_id !== request.session_id || session.session_generation !== request.fencing_generation || session.session_generation !== run.active_session_generation) throw new CoordinationRuntimeError('fenced-session', 'idempotent replay session is no longer the current generation');
    const allowedStatus = request.action === 'prepare-handoff' ? 'handoff-pending' : request.action === 'detach-session' ? 'detached' : 'attached';
    if (session.status !== allowedStatus) throw new CoordinationRuntimeError('fenced-session', `idempotent replay requires session status ${allowedStatus}`);
    this.#assertCapability(row, 'session_token_sha256', payloadString(request.payload, 'session_token'), 'session');
  }

  #assertChildAuthority(request: CoordinatorRequestEnvelope, child: CoordinationChildLease, row: SqlRow): void {
    if (child.owner.repo_id !== request.repo_id || child.owner.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'client does not own child lease');
    if (child.pid !== payloadInteger(request.payload, 'pid') || child.boot_id !== payloadString(request.payload, 'boot_id')) throw new CoordinationRuntimeError('unauthorized-client', 'child process identity does not match its lease');
    this.#assertCapability(row, 'child_token_sha256', payloadString(request.payload, 'child_token'), 'child');
  }

  #assertCapability(row: SqlRow, field: string, token: string, label: string): void {
    const expected = Buffer.from(sqlString(row, field), 'utf8');
    const actual = Buffer.from(createHash('sha256').update(token, 'utf8').digest('hex'), 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new CoordinationRuntimeError('unauthorized-client', `${label} capability does not match its lease`);
  }

  #assertVersion(actual: number, expected: number | null, label: string): void {
    if (expected === null || actual !== expected) throw new CoordinationRuntimeError('stale-version', `${label} version ${String(actual)} does not match expected ${String(expected)}`);
  }

  #workstreamRun(request: CoordinatorRequestEnvelope): string {
    if (request.workstream_run === null) throw new CoordinationRuntimeError('invalid-request', 'request lacks workstream_run');
    return request.workstream_run;
  }

  #sessionId(request: CoordinatorRequestEnvelope): string {
    if (request.session_id === null) throw new CoordinationRuntimeError('invalid-request', 'request lacks session_id');
    return request.session_id;
  }
}

export function coordinationErrorCode(value: string | null): CoordinationFailureCode {
  switch (value) {
    case 'invalid-request': case 'invalid-state': case 'protocol-mismatch': case 'schema-mismatch': case 'frame-too-large': case 'unauthorized-client': case 'coordinator-unavailable': case 'coordinator-contention': case 'fenced-session': case 'stale-version': case 'idempotency-conflict': case 'request-timeout': case 'recovery-required': case 'git-partial-effect': case 'disk-failure': case 'permission-denied': case 'planning-contradiction-review': case 'store-corrupt': case 'system-fatal': return value;
    default: return 'system-fatal';
  }
}
