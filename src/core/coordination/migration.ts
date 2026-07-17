import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platform, tmpdir } from 'node:os';

import { CoordinatorClient } from './client.ts';
import { legacyMigrationExclusiveOperation } from './exclusive-policy.ts';
import { parseLegacyActiveAutopilots, parseLegacyPathClaims, checkLegacyCoordinationInvariants, LEGACY_PREFLIGHT_MAX_INPUT_BYTES } from './legacy-preflight.ts';
import { activeCoordinationMigrationFreeze, assertMigrationPathSafe, coordinationGlobalMigrationLockPath, coordinationMigrationPaths, COORDINATION_CUTOVER_MARKER_SCHEMA, COORDINATION_FREEZE_ACK_SCHEMA, COORDINATION_FREEZE_SCHEMA, COORDINATION_MIGRATION_JOURNAL_SCHEMA, readCoordinationCutoverMarker, type CoordinationCutoverMarker, type CoordinationFreezeAcknowledgement, type CoordinationMigrationPaths } from './migration-paths.ts';
import { currentBootId, isExactProcessAlive, isProcessAlive, predecessorCompatibleBootId, preflightProcessRetirementSupport, retireExactProcess } from './process-identity.ts';
import { COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_PACKAGE_BUILD, COORDINATOR_STORE_SCHEMA_VERSION, coordinatorRuntimePaths, enforcePrivateAuthorityPath, enforceWindowsPrivateTree, ensureCoordinatorPrivateRoots, ensurePrivateAuthorityDirectory, type CoordinatorRuntimePaths } from './runtime-paths.ts';
import { acquireSerializedProcessGuard, discardLockTombstone, quarantineExactLock, readExactLockText, restoreLockTombstone } from './serialized-lock.ts';
import { startCoordinatorServer, type CoordinatorStartupAdoption } from './server.ts';
import { parseCurrentCoordinatorLock, parsePredecessorCoordinatorLock, parsePriorSchema11CurrentCoordinatorLock, parsePriorSchema10CurrentCoordinatorLock, parsePriorSchema9CurrentCoordinatorLock, type CurrentCoordinatorLock } from './upgrade-contracts.ts';
import { COORDINATOR_SCHEMA_MIGRATION_CHECKSUMS, CoordinatorStore, type CoordinationLegacyImportPlan, type CoordinationMigrationAuditInput, type CoordinationMigrationRecordState, type CoordinationMigrationRecoveryInput, type StoreClock } from './store.ts';
import { backup, DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { CoordinationRuntimeError } from './failures.ts';
import { normalizeRepoRelativePath, pathOverlapsOrContains, resolveRepoIdentity } from '../parallel-runtime.ts';
import { proveLegacyReadAttemptTerminal } from './legacy-read-terminal.ts';
import type { ActiveAutopilotRow, AutopilotPathClaim, AutopilotUnitBranchInfo, AutopilotWorktreeIndexRow, ProcessEnvLike } from '../parallel-runtime.ts';
import { parseAutopilotUnitMerge, type AutopilotUnitMerge } from '../unit-merge.ts';
import { parseCoordinationEditLease, parseCoordinationUnitAttempt, parseCoordinationWorktreeOperation } from './contracts.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, type CoordinationAcquisitionGroup, type CoordinationChangeReservation, type CoordinationEditLease, type CoordinationReconciliationEvidence, type CoordinationRepository, type CoordinationReservationObligation, type CoordinationRun, type CoordinationRunResource, type CoordinationRunStatus, type CoordinationUnitAttempt, type CoordinationWorktree, type CoordinationWorktreeOperation, type CoordinationWorktreeState } from './types.ts';
import { legacyConservativeIntegrationConflict } from './integration-conflicts.ts';
import { deterministicWorktreeId } from './worktree-identity.ts';
import { readCurrentStoreGeneration } from './store-generation.ts';
import { GitQueryError, runGitQuery, type GitQueryDescriptor, type GitQueryResult } from '../git-process.ts';

export const COORDINATION_MIGRATION_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const COORDINATION_MIGRATION_MAX_DATABASE_COMPONENT_BYTES = 256 * 1024 * 1024;
export const COORDINATION_MIGRATION_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const COORDINATION_MIGRATION_MAX_FILES = 100_000;
export const COORDINATION_MIGRATION_MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const COORDINATION_MIGRATION_MAX_JSONL_ROWS = 100_000;

export type CoordinationMigrationState = 'planned' | 'frozen' | 'snapshotted' | 'imported' | 'verified' | 'cutover-ready' | 'cutover-committed' | 'legacy-archived' | 'rollback-restoring' | 'rollback-restored' | 'rollback-unfreezing' | 'rolled-back';
export type CoordinationMigrationCommand = 'dry-run' | 'apply' | 'verify' | 'rollback' | 'cutover';
export const COORDINATION_MIGRATION_CRASH_BOUNDARIES = ['after-lock-candidate-synced', 'after-lock-published', 'after-lock-reclaim-linked', 'after-lock-reclaim-quarantined', 'after-lock-release-linked', 'after-lock-release-unlinked', 'after-plan', 'after-freeze-written-before-journal', 'after-freeze', 'after-writer-authority', 'after-snapshot-copied-before-journal', 'after-snapshot', 'after-backup-created-before-journal', 'after-backup', 'after-import-commit-before-journal', 'after-import', 'after-verified-store-before-journal', 'after-verified', 'after-cutover-ready-store-before-journal', 'after-cutover-ready', 'after-rollback-intent', 'after-rollback-restore-before-journal', 'after-rollback-restore', 'after-rollback-verified', 'after-rollback-unfreeze', 'after-cutover-marker-before-journal', 'after-cutover-marker', 'after-cutover-store', 'after-runtime-projections', 'after-legacy-files-archived-before-store', 'after-legacy-archive-store-before-journal', 'after-legacy-archive', 'after-cutover-unfreeze'] as const;
export type CoordinationMigrationCrashBoundary = (typeof COORDINATION_MIGRATION_CRASH_BOUNDARIES)[number];

interface SnapshotEntry {
  readonly source_path: string;
  readonly relative_path: string;
  readonly exists: boolean;
  readonly size_bytes: number;
  readonly sha256: `sha256:${string}`;
}

interface GitSnapshotEntry {
  readonly workstream_run: string;
  readonly source_head: string;
  readonly main_head: string | null;
  readonly main_branch: string | null;
}

interface MigrationRepositoryIdentity {
  readonly canonical_root: string;
  readonly git_common_dir: string;
}

interface TerminalProof {
  readonly source: 'unit-merge' | 'attempt-reset' | 'quarantine-capture' | 'run-close' | 'run-abort' | 'legacy-read-terminal';
  readonly mechanical_proof: 'accepted-unit-merge' | 'accepted-attempt-reset' | 'accepted-quarantine-capture' | 'accepted-run-terminal' | 'accepted-read-terminal' | 'superseded-read-terminal';
  readonly evidence_ref: string;
  readonly evidence_sha256: `sha256:${string}`;
  readonly supporting_evidence?: readonly { readonly ref: string; readonly sha256: `sha256:${string}` }[];
  readonly exact_git_objects: readonly string[];
  readonly filesystem_postconditions: readonly string[];
}

interface CoordinationMigrationJournal {
  readonly schema_version: typeof COORDINATION_MIGRATION_JOURNAL_SCHEMA;
  readonly migration_id: string;
  readonly repo_key: string;
  readonly state: CoordinationMigrationState;
  readonly freeze_token: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly snapshot_sha256: `sha256:${string}` | null;
  readonly snapshot_entries: readonly SnapshotEntry[];
  readonly git_snapshot: readonly GitSnapshotEntry[];
  readonly backup_path: string | null;
  readonly backup_sha256: `sha256:${string}` | null;
  readonly database_existed_before: boolean;
  readonly repository_root: string;
  readonly repository_git_common_dir: string;
  readonly completed_effects: readonly string[];
  readonly report: CoordinationMigrationReport;
}

export interface CoordinationMigrationReport {
  readonly schema_version: 'autopilot.coordination_migration_report.v1';
  readonly command: CoordinationMigrationCommand;
  readonly repo_key: string;
  readonly migration_id: string | null;
  readonly state: CoordinationMigrationState;
  readonly dry_run: boolean;
  readonly source_file_count: number;
  readonly source_total_bytes: number;
  readonly active_run_count: number;
  readonly legacy_claim_count: number;
  readonly classified_claim_count: number;
  readonly equivalent_lease_count: number;
  readonly imported_run_count: number;
  readonly imported_attempt_count: number;
  readonly imported_lease_count: number;
  readonly imported_reservation_count: number;
  readonly imported_worktree_count: number;
  readonly imported_audit_count: number;
  readonly rebound_old_epoch_claim_count: number;
  readonly terminal_leak_count: number;
  readonly recovery_work_count: number;
  readonly blockers: readonly string[];
  readonly recovery: readonly Readonly<Record<string, unknown>>[];
  readonly snapshot_sha256: `sha256:${string}` | null;
  readonly backup_path: string | null;
  readonly cutover_marker_path: string | null;
  readonly created_at: string;
}

interface ParsedUnitMetadata {
  readonly by_attempt: ReadonlyMap<string, AutopilotUnitBranchInfo>;
  readonly worktrees: readonly AutopilotUnitBranchInfo[];
  readonly missingTaskInfoRuns: ReadonlySet<string>;
  readonly orphanAttempts: ReadonlySet<string>;
}

interface LegacyMergeEvidence {
  readonly merge: AutopilotUnitMerge;
  readonly path: string;
  readonly sha256: `sha256:${string}`;
  readonly ref: string;
}

interface LegacyTerminalEvidence {
  readonly attemptProof: ReadonlyMap<string, TerminalProof>;
  readonly readProof: ReadonlyMap<string, TerminalProof>;
  readonly runProof: ReadonlyMap<string, TerminalProof>;
  readonly paths: readonly string[];
}

interface LegacyInspection {
  readonly rows: readonly ActiveAutopilotRow[];
  readonly claims: readonly AutopilotPathClaim[];
  readonly unitMetadata: ParsedUnitMetadata;
  readonly worktreeIndex: readonly AutopilotWorktreeIndexRow[];
  readonly sourceEntries: readonly SnapshotEntry[];
  readonly gitSnapshot: readonly GitSnapshotEntry[];
  readonly audit: readonly CoordinationMigrationAuditInput[];
  readonly merges: readonly LegacyMergeEvidence[];
  readonly terminalEvidence: LegacyTerminalEvidence;
  readonly blockers: readonly string[];
  readonly recovery: readonly CoordinationMigrationRecoveryInput[];
  readonly terminalLeakKeys: ReadonlySet<string>;
  readonly equivalentClaimKeys: ReadonlySet<string>;
  readonly reboundCount: number;
  readonly totalBytes: number;
  readonly ledgerTerminalizedRuns: ReadonlySet<string>;
  readonly runtimeRunStatuses: ReadonlyMap<string, CoordinationRunStatus>;
}

interface MigrationClock extends StoreClock {}
const systemClock: MigrationClock = { now: () => new Date() };
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,191}$/u;
const TOP_LEVEL_COORDINATION_FILES = ['active-autopilots.json', 'path-claims.json', 'claim-events.jsonl', 'merge-log.jsonl', 'foreign-merge-acks.jsonl'] as const;
const TOP_LEVEL_WORKTREE_FILES = ['_index.json', '_ledger.jsonl'] as const;

function failure(code: string, message: string, evidence: readonly string[] = []): never {
  throw new CoordinationRuntimeError(code === 'blocked' ? 'invalid-state' : 'invalid-request', message, evidence);
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const row = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
}

function boundedString(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\u0000')) failure('invalid', `${label} must be a bounded non-empty string`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) failure('invalid', `${label} must be a safe integer >= ${String(minimum)}`);
  return value;
}

function object(value: unknown, label: string, fields: readonly string[]): Readonly<Record<string, unknown>> {
  return closedObject(value, label, fields, []);
}

function closedObject(value: unknown, label: string, requiredFields: readonly string[], optionalFields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) failure('invalid', `${label} must be an object`);
  const row = value as Readonly<Record<string, unknown>>;
  const allowedFields = new Set([...requiredFields, ...optionalFields]);
  const unknown = Object.keys(row).filter((field) => !allowedFields.has(field));
  if (unknown.length > 0) failure('invalid', `${label} has unknown fields`, unknown.sort());
  for (const field of requiredFields) if (!(field in row)) failure('invalid', `${label} is missing ${field}`);
  return row;
}

function readBounded(path: string, maximum = COORDINATION_MIGRATION_MAX_FILE_BYTES): Uint8Array {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) failure('invalid', 'migration input must be a regular non-symlink file', [path]);
  if (info.size > maximum) failure('invalid', `migration input exceeds ${String(maximum)} bytes`, [path]);
  return readFileSync(path);
}

function assertNoDuplicateJsonKeys(text: string, label: string): void {
  let index = 0;
  const whitespace = (): void => { while (/\s/u.test(text[index] ?? '')) index += 1; };
  const parseStringToken = (): string => {
    if (text[index] !== '"') failure('invalid', `${label} contains invalid JSON string`);
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index];
      index += 1;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') {
        const token = text.slice(start, index);
        try { return JSON.parse(token) as string; }
        catch { failure('invalid', `${label} contains invalid JSON string escaping`); }
      }
      if (char !== undefined && char.charCodeAt(0) < 0x20) failure('invalid', `${label} contains an unescaped control character`);
    }
    failure('invalid', `${label} contains an unterminated JSON string`);
  };
  const parseValue = (): void => {
    whitespace();
    const char = text[index];
    if (char === '"') { parseStringToken(); return; }
    if (char === '{') {
      index += 1; whitespace();
      const keys = new Set<string>();
      if (text[index] === '}') { index += 1; return; }
      while (true) {
        whitespace(); const key = parseStringToken();
        if (keys.has(key)) failure('invalid', `${label} contains duplicate JSON object key`, [key]);
        keys.add(key); whitespace();
        if (text[index] !== ':') failure('invalid', `${label} contains invalid JSON object syntax`);
        index += 1; parseValue(); whitespace();
        if (text[index] === '}') { index += 1; return; }
        if (text[index] !== ',') failure('invalid', `${label} contains invalid JSON object separator`);
        index += 1;
      }
    }
    if (char === '[') {
      index += 1; whitespace();
      if (text[index] === ']') { index += 1; return; }
      while (true) {
        parseValue(); whitespace();
        if (text[index] === ']') { index += 1; return; }
        if (text[index] !== ',') failure('invalid', `${label} contains invalid JSON array separator`);
        index += 1;
      }
    }
    const tail = text.slice(index);
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(tail)?.[0];
    if (token === undefined) failure('invalid', `${label} contains an invalid JSON value`);
    index += token.length;
  };
  parseValue(); whitespace();
  if (index !== text.length) failure('invalid', `${label} contains trailing JSON content`);
}

function parseJsonFile(path: string, missing: unknown): unknown {
  if (!existsSync(path)) return missing;
  const bytes = readBounded(path, LEGACY_PREFLIGHT_MAX_INPUT_BYTES);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try {
    assertNoDuplicateJsonKeys(text, path);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof CoordinationRuntimeError) throw error;
    failure('invalid', 'migration input contains invalid JSON', [path, error instanceof Error ? error.message : String(error)]);
  }
}

function validateBoundedJson(value: unknown, label: string, depth = 0): void {
  if (depth > 12) failure('invalid', `${label} exceeds maximum JSON depth`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { boundedString(value, label, 8192); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) failure('invalid', `${label} contains a non-finite number`); return; }
  if (Array.isArray(value)) {
    if (value.length > 4096) failure('invalid', `${label} contains an oversized array`);
    value.forEach((entry, index) => validateBoundedJson(entry, `${label}[${String(index)}]`, depth + 1));
    return;
  }
  if (typeof value !== 'object') failure('invalid', `${label} contains a non-JSON value`);
  const row = value as Readonly<Record<string, unknown>>;
  if (Object.keys(row).length > 128) failure('invalid', `${label} contains too many fields`);
  for (const [field, entry] of Object.entries(row)) {
    boundedString(field, `${label} field`, 128);
    validateBoundedJson(entry, `${label}.${field}`, depth + 1);
  }
}

const LEGACY_JSONL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'autopilot.claim_event.v1': ['active_run_epoch', 'attempt', 'autopilot_id', 'blockers', 'claim_type', 'event', 'path', 'reason', 'repo_key', 'schema_version', 'ts', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.merge_event.v1': ['autopilot_id', 'branch', 'changed_paths', 'integration_commit_sha', 'merge_id', 'merged_at', 'repo_key', 'schema_version', 'target_after', 'target_before', 'target_branch', 'workstream', 'workstream_after', 'workstream_before', 'workstream_run'],
  'autopilot.foreign_merge_ack.v1': ['ack_id', 'acked_at', 'acknowledging_autopilot_id', 'acknowledging_workstream_run', 'action', 'foreign_autopilot_id', 'foreign_workstream_run', 'intersection_paths', 'merge_id', 'repo_key', 'schema_version'],
  'autopilot.worktree_ledger.v1': ['archive_ref', 'archive_sha', 'attempt', 'autopilot_id', 'base_sha', 'blockers', 'branch', 'branch_deleted', 'checkout_mode', 'event', 'main_path', 'mode', 'moved_task_root', 'path', 'proof', 'reason', 'repo_key', 'schema_version', 'status', 'ts', 'unit_id', 'unit_path', 'workstream', 'workstream_run'],
};

function requiredPayloadFields(payload: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  for (const field of fields) if (!(field in payload)) failure('invalid', `${label} is missing ${field}`);
}

function stringArray(value: unknown, label: string, maximum = 4096): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 2048)) failure('invalid', `${label} must be a bounded string array`);
  return value;
}

function validateLegacyJsonlPayload(payload: Readonly<Record<string, unknown>>, schema: string, label: string): void {
  if (schema === 'autopilot.claim_event.v1') {
    requiredPayloadFields(payload, ['active_run_epoch', 'autopilot_id', 'event', 'reason', 'repo_key', 'schema_version', 'ts', 'workstream', 'workstream_run'], label);
    const event = boundedString(payload['event'], `${label}.event`, 32);
    if (!['acquire', 'release', 'upgrade', 'expand', 'rejected'].includes(event)) failure('invalid', `${label}.event is invalid`);
    integer(payload['active_run_epoch'], `${label}.active_run_epoch`, 1);
    for (const field of ['autopilot_id', 'reason', 'repo_key', 'ts', 'workstream', 'workstream_run']) boundedString(payload[field], `${label}.${field}`);
    if (payload['path'] !== undefined) normalizeRepoRelativePath(boundedString(payload['path'], `${label}.path`));
    if (payload['attempt'] !== undefined) integer(payload['attempt'], `${label}.attempt`, 1);
    return;
  }
  if (schema === 'autopilot.merge_event.v1') {
    requiredPayloadFields(payload, LEGACY_JSONL_FIELDS[schema] ?? [], label);
    for (const field of ['autopilot_id', 'branch', 'merge_id', 'merged_at', 'repo_key', 'target_after', 'target_before', 'target_branch', 'workstream', 'workstream_after', 'workstream_before', 'workstream_run']) boundedString(payload[field], `${label}.${field}`);
    for (const changedPath of stringArray(payload['changed_paths'], `${label}.changed_paths`)) normalizeRepoRelativePath(changedPath);
    if (payload['integration_commit_sha'] !== null) boundedString(payload['integration_commit_sha'], `${label}.integration_commit_sha`, 128);
    return;
  }
  if (schema === 'autopilot.foreign_merge_ack.v1') {
    requiredPayloadFields(payload, LEGACY_JSONL_FIELDS[schema] ?? [], label);
    for (const field of ['ack_id', 'acked_at', 'acknowledging_autopilot_id', 'acknowledging_workstream_run', 'foreign_autopilot_id', 'foreign_workstream_run', 'merge_id', 'repo_key']) boundedString(payload[field], `${label}.${field}`);
    if (payload['action'] !== 'non-intersecting') failure('invalid', `${label}.action is invalid`);
    for (const changedPath of stringArray(payload['intersection_paths'], `${label}.intersection_paths`)) normalizeRepoRelativePath(changedPath);
    return;
  }
  requiredPayloadFields(payload, ['autopilot_id', 'event', 'schema_version', 'ts', 'workstream', 'workstream_run'], label);
  for (const field of ['autopilot_id', 'event', 'ts', 'workstream', 'workstream_run']) boundedString(payload[field], `${label}.${field}`);
  if (payload['branch_deleted'] !== undefined && typeof payload['branch_deleted'] !== 'boolean') failure('invalid', `${label}.branch_deleted must be boolean`);
  if (payload['moved_task_root'] !== undefined && !isAbsolute(boundedString(payload['moved_task_root'], `${label}.moved_task_root`))) failure('invalid', `${label}.moved_task_root must be absolute`);
}

function parseJsonl(path: string, sourceKind: CoordinationMigrationAuditInput['source_kind'], expectedSchema: string): readonly CoordinationMigrationAuditInput[] {
  if (!existsSync(path)) return [];
  const bytes = readBounded(path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const lines = text.split('\n');
  if (lines.length > COORDINATION_MIGRATION_MAX_JSONL_ROWS + 1) failure('invalid', 'migration JSONL row bound exceeded', [path]);
  const rows: CoordinationMigrationAuditInput[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) continue;
    if (Buffer.byteLength(line, 'utf8') > COORDINATION_MIGRATION_MAX_JSONL_LINE_BYTES) failure('invalid', 'migration JSONL line bound exceeded', [path, String(index + 1)]);
    let parsed: unknown;
    try { assertNoDuplicateJsonKeys(line, `${path}:${String(index + 1)}`); parsed = JSON.parse(line) as unknown; }
    catch { failure('invalid', 'migration JSONL line contains invalid JSON', [path, String(index + 1)]); }
    validateBoundedJson(parsed, `${path}:${String(index + 1)}`);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || (parsed as Readonly<Record<string, unknown>>)['schema_version'] !== expectedSchema) failure('invalid', `migration JSONL line must use ${expectedSchema}`, [path, String(index + 1)]);
    const payload = parsed as Readonly<Record<string, unknown>>;
    const allowed = LEGACY_JSONL_FIELDS[expectedSchema];
    if (allowed === undefined) failure('invalid', 'migration JSONL schema has no closed field contract', [expectedSchema]);
    const unknownFields = Object.keys(payload).filter((field) => !allowed.includes(field));
    if (unknownFields.length > 0) failure('invalid', 'migration JSONL line has unknown fields', [path, String(index + 1), ...unknownFields.sort()]);
    validateLegacyJsonlPayload(payload, expectedSchema, `${path}:${String(index + 1)}`);
    rows.push({ audit_id: entityId('audit', `${sourceKind}\0${path}\0${String(index + 1)}\0${stableJson(payload)}`), source_kind: sourceKind, payload });
  }
  return Object.freeze(rows);
}

function ledgerTerminalizedRuns(rows: readonly ActiveAutopilotRow[], audit: readonly CoordinationMigrationAuditInput[]): ReadonlySet<string> {
  const terminalized = new Set<string>();
  const ledger = audit.filter((entry) => entry.source_kind === 'worktree-ledger').map((entry) => entry.payload);
  for (const row of rows) {
    if (existsSync(row.main_worktree_path)) continue;
    const mainRemoved = ledger.some((entry) => entry['workstream_run'] === row.workstream_run && entry['autopilot_id'] === row.autopilot_id && entry['event'] === 'main-worktree-remove' && entry['path'] === row.main_worktree_path && Array.isArray(entry['proof']) && entry['proof'].includes('path_absent_after_remove'));
    const branchRetired = ledger.some((entry) => entry['workstream_run'] === row.workstream_run && entry['autopilot_id'] === row.autopilot_id && entry['event'] === 'branch-retire' && entry['branch'] === row.branch && Array.isArray(entry['proof']) && entry['proof'].includes('branch_deleted'));
    const branchAbsent = gitText(row.source_repo, { kind: 'ref-exists', ref: `refs/heads/${row.branch}` }) === null;
    if (mainRemoved && branchRetired && branchAbsent) terminalized.add(row.workstream_run);
  }
  return terminalized;
}

function readRuntimeRunStatuses(rows: readonly ActiveAutopilotRow[]): ReadonlyMap<string, CoordinationRunStatus> {
  const statuses = new Map<string, CoordinationRunStatus>();
  for (const row of rows) {
    const path = join(row.runtime_root, 'state.json');
    if (!existsSync(path)) continue;
    const stateValue = parseJsonFile(path, null);
    validateBoundedJson(stateValue, path);
    const state = closedObject(stateValue, path, ['blocked', 'completed', 'context_gate', 'last_event_id', 'next_actions', 'operator_questions', 'ready_queue', 'running', 'schema_version', 'status', 'units', 'updated_at', 'workstream'], ['audit_review_queue', 'closure_gate', 'last_decision_id', 'notes', 'protected_path_exceptions', 'scope_exceptions', 'validation_ready_queue', 'work_items']);
    if (state['schema_version'] !== 'autopilot.state.v1' || state['workstream'] !== row.workstream) failure('invalid', 'runtime state identity disagrees with active run ownership', [path]);
    const legacyStatus = state['status'];
    if (legacyStatus !== 'running' && legacyStatus !== 'paused' && legacyStatus !== 'blocked' && legacyStatus !== 'completed') failure('invalid', 'runtime state status is invalid', [path]);
    const status: CoordinationRunStatus = legacyStatus === 'running' ? 'active' : legacyStatus === 'completed' ? 'closed' : legacyStatus;
    statuses.set(row.workstream_run, status);
  }
  return statuses;
}

function entityId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}

function attemptKey(run: string, unit: string, attempt: number): string {
  return `${run}\0${unit}\0${String(attempt)}`;
}

function claimKey(claim: AutopilotPathClaim): string {
  return `${claim.workstream_run}\0${claim.unit_id}\0${String(claim.attempt)}\0${claim.claim_type}\0${claim.path}`;
}

function parseUnitBranch(value: unknown, label: string): AutopilotUnitBranchInfo {
  const fields = ['archive_ref', 'attempt', 'base_sha', 'branch', 'current_sha', 'status', 'unit_id', 'worktree_path'];
  const row = object(value, label, fields);
  const statusValue = boundedString(row['status'], `${label}.status`, 32);
  if (!['active', 'merged', 'aborted', 'quarantined', 'superseded'].includes(statusValue)) failure('invalid', `${label}.status is invalid`);
  const worktreePath = boundedString(row['worktree_path'], `${label}.worktree_path`);
  if (!isAbsolute(worktreePath)) failure('invalid', `${label}.worktree_path must be absolute`);
  const archive = row['archive_ref'];
  if (archive !== null && typeof archive !== 'string') failure('invalid', `${label}.archive_ref must be nullable text`);
  return {
    unit_id: boundedString(row['unit_id'], `${label}.unit_id`, 192), attempt: integer(row['attempt'], `${label}.attempt`, 1),
    branch: boundedString(row['branch'], `${label}.branch`, 512), worktree_path: resolve(worktreePath),
    base_sha: boundedString(row['base_sha'], `${label}.base_sha`, 128), current_sha: boundedString(row['current_sha'], `${label}.current_sha`, 128),
    archive_ref: archive, status: statusValue as AutopilotUnitBranchInfo['status'],
  };
}

function readUnitMetadata(rows: readonly ActiveAutopilotRow[]): ParsedUnitMetadata {
  const map = new Map<string, AutopilotUnitBranchInfo>();
  const worktrees: AutopilotUnitBranchInfo[] = [];
  const missingTaskInfoRuns = new Set<string>();
  const orphanAttempts = new Set<string>();
  for (const active of rows) {
    const taskRoot = dirname(active.main_worktree_path);
    const taskInfoPath = join(taskRoot, '_task-info.json');
    if (!existsSync(taskInfoPath)) {
      missingTaskInfoRuns.add(active.workstream_run);
      continue;
    }
    const taskBaseFields = ['autopilot_id', 'base_sha', 'branch', 'closed_at', 'git_common_dir', 'repo_key', 'runtime_root', 'schema_version', 'source_repo', 'started_at', 'status', 'target_base_sha', 'target_branch', 'workstream', 'workstream_run', 'worktree_path'];
    const taskCheckoutFields = ['checkout_mode', 'checkout_profile_origin', 'checkout_profile_ref', 'checkout_profile_sha256'];
    const taskValue = parseJsonFile(taskInfoPath, null);
    const taskRecord = typeof taskValue === 'object' && taskValue !== null && !Array.isArray(taskValue) ? taskValue as Readonly<Record<string, unknown>> : null;
    const taskSchema = taskRecord?.['schema_version'];
    const presentTaskCheckoutFields = taskCheckoutFields.filter((field) => taskRecord !== null && field in taskRecord);
    if (presentTaskCheckoutFields.length !== 0 && presentTaskCheckoutFields.length !== taskCheckoutFields.length) failure('invalid', '_task-info.json has a partial checkout metadata generation', [taskInfoPath, ...presentTaskCheckoutFields]);
    const hasTaskCheckout = presentTaskCheckoutFields.length === taskCheckoutFields.length;
    const hasCoordinationAuthority = taskRecord !== null && 'coordination_authority' in taskRecord;
    if (taskSchema === 'autopilot.task_info.v1' && hasCoordinationAuthority) failure('invalid', 'v1 _task-info.json cannot declare post-v1 coordination authority', [taskInfoPath]);
    if (taskSchema === 'autopilot.task_info.v2' && !hasCoordinationAuthority) failure('invalid', 'v2 _task-info.json is missing coordination authority', [taskInfoPath]);
    if (taskSchema !== 'autopilot.task_info.v1' && taskSchema !== 'autopilot.task_info.v2') failure('invalid', '_task-info.json uses an unsupported historical schema', [taskInfoPath, String(taskSchema)]);
    const taskInfo = object(taskValue, taskInfoPath, [...taskBaseFields, ...(hasTaskCheckout ? taskCheckoutFields : []), ...(hasCoordinationAuthority ? ['coordination_authority'] : [])]);
    const fixedIdentityMatches = taskInfo['repo_key'] === active.repo_key && taskInfo['autopilot_id'] === active.autopilot_id && taskInfo['workstream'] === active.workstream && taskInfo['workstream_run'] === active.workstream_run && taskInfo['source_repo'] === active.source_repo && taskInfo['git_common_dir'] === active.git_common_dir && taskInfo['worktree_path'] === active.main_worktree_path && taskInfo['runtime_root'] === active.runtime_root && taskInfo['branch'] === active.branch && taskInfo['target_branch'] === active.target_branch;
    const exactBaseMatches = taskInfo['base_sha'] === active.target_base_sha && taskInfo['target_base_sha'] === active.target_base_sha;
    const closedAdvancedBase = active.status === 'closed' && typeof taskInfo['base_sha'] === 'string' && taskInfo['base_sha'] === taskInfo['target_base_sha'] && GIT_OBJECT_ID.test(taskInfo['base_sha']) && gitAncestor(active.source_repo, taskInfo['base_sha'], active.target_base_sha);
    if (!fixedIdentityMatches || (!exactBaseMatches && !closedAdvancedBase)) failure('invalid', '_task-info.json disagrees with active run ownership', [taskInfoPath]);
    if (taskSchema === 'autopilot.task_info.v2' && taskInfo['coordination_authority'] !== active.coordination_authority) failure('invalid', '_task-info.json coordination authority disagrees with active run ownership', [taskInfoPath]);
    const unitPath = join(taskRoot, '_unit-index.json');
    const branchesPath = join(taskRoot, '_branches.json');
    const unitRaw = parseJsonFile(unitPath, { schema_version: 'autopilot.unit_index.v1', units: [] });
    const unit = object(unitRaw, unitPath, ['schema_version', 'units']);
    if (unit['schema_version'] !== 'autopilot.unit_index.v1' || !Array.isArray(unit['units']) || unit['units'].length > 10_000) failure('invalid', '_unit-index.json has an invalid schema or bound', [unitPath]);
    const branchRaw = parseJsonFile(branchesPath, { schema_version: 'autopilot.branches.v1', active_branch: active.branch, base_sha: active.target_base_sha, current_sha: active.target_base_sha, archive_ref: null, unit_branches: [] });
    const branches = object(branchRaw, branchesPath, ['active_branch', 'archive_ref', 'base_sha', 'current_sha', 'schema_version', 'unit_branches']);
    if (branches['schema_version'] !== 'autopilot.branches.v1' || !Array.isArray(branches['unit_branches']) || branches['unit_branches'].length > 10_000) failure('invalid', '_branches.json has an invalid schema or bound', [branchesPath]);
    const indexed = unit['units'].map((entry, index) => parseUnitBranch(entry, `${unitPath}[${String(index)}]`));
    const branchRows = branches['unit_branches'].map((entry, index) => parseUnitBranch(entry, `${branchesPath}[${String(index)}]`));
    for (const candidate of indexed) {
      const key = attemptKey(active.workstream_run, candidate.unit_id, candidate.attempt);
      if (map.has(key)) failure('invalid', 'duplicate unit attempt metadata', [key]);
      const matching = branchRows.find((entry) => entry.unit_id === candidate.unit_id && entry.attempt === candidate.attempt);
      const recoverableMissingBranchRow = matching === undefined && candidate.status === 'active' && !existsSync(candidate.worktree_path);
      if (recoverableMissingBranchRow) orphanAttempts.add(key);
      else if (matching === undefined || stableJson(matching) !== stableJson(candidate)) failure('invalid', '_unit-index.json and _branches.json disagree', [key]);
      if (!isInside(active.worktree_root, candidate.worktree_path)) failure('invalid', 'unit worktree path escapes its repository worktree root', [candidate.worktree_path]);
      const unitInfoPath = join(dirname(candidate.worktree_path), '_unit-info.json');
      if (existsSync(unitInfoPath)) {
        const unitInfoBaseFields = ['archive_ref', 'attempt', 'autopilot_id', 'base_sha', 'branch', 'created_at', 'current_sha', 'runtime_root', 'schema_version', 'status', 'unit_id', 'workstream', 'workstream_run', 'worktree_path'];
        const unitInfoCheckoutFields = ['checkout_mode', 'checkout_profile_ref', 'materialized_paths_ref'];
        const unitInfoValue = parseJsonFile(unitInfoPath, null);
        const unitInfoRecord = typeof unitInfoValue === 'object' && unitInfoValue !== null && !Array.isArray(unitInfoValue) ? unitInfoValue as Readonly<Record<string, unknown>> : null;
        const presentCheckoutFields = unitInfoCheckoutFields.filter((field) => unitInfoRecord !== null && field in unitInfoRecord);
        if (presentCheckoutFields.length !== 0 && presentCheckoutFields.length !== unitInfoCheckoutFields.length) failure('invalid', '_unit-info.json has a partial checkout metadata generation', [unitInfoPath, ...presentCheckoutFields]);
        const unitInfo = object(unitInfoValue, unitInfoPath, presentCheckoutFields.length === 0 ? unitInfoBaseFields : [...unitInfoBaseFields, ...unitInfoCheckoutFields]);
        const unitIdentity = { archive_ref: unitInfo['archive_ref'], attempt: unitInfo['attempt'], base_sha: unitInfo['base_sha'], branch: unitInfo['branch'], current_sha: unitInfo['current_sha'], status: unitInfo['status'], unit_id: unitInfo['unit_id'], worktree_path: unitInfo['worktree_path'] };
        const parsedUnitInfo = parseUnitBranch(unitIdentity, unitInfoPath);
        const immutableUnitIdentityMatches = parsedUnitInfo.unit_id === candidate.unit_id && parsedUnitInfo.attempt === candidate.attempt && parsedUnitInfo.base_sha === candidate.base_sha && parsedUnitInfo.branch === candidate.branch && parsedUnitInfo.worktree_path === candidate.worktree_path;
        const terminalIndexSupersedesCreationSnapshot = immutableUnitIdentityMatches && parsedUnitInfo.status === 'active' && candidate.status !== 'active' && (parsedUnitInfo.archive_ref === null || parsedUnitInfo.archive_ref === candidate.archive_ref) && (parsedUnitInfo.current_sha === candidate.current_sha || gitAncestor(active.source_repo, parsedUnitInfo.current_sha, candidate.current_sha));
        if ((stableJson(parsedUnitInfo) !== stableJson(candidate) && !terminalIndexSupersedesCreationSnapshot) || unitInfo['schema_version'] !== 'autopilot.unit_info.v1' || unitInfo['workstream_run'] !== active.workstream_run || unitInfo['autopilot_id'] !== active.autopilot_id || unitInfo['runtime_root'] !== active.runtime_root) failure('invalid', '_unit-info.json disagrees with run/unit index ownership', [unitInfoPath]);
      }
      map.set(key, candidate);
      worktrees.push(candidate);
    }
    const extras = branchRows.filter((entry) => !indexed.some((candidate) => candidate.unit_id === entry.unit_id && candidate.attempt === entry.attempt));
    if (extras.length > 0) failure('invalid', '_branches.json contains units absent from _unit-index.json', extras.map((entry) => `${entry.unit_id}:${String(entry.attempt)}`));
  }
  const frozenWorktrees = Object.freeze(worktrees);
  return { by_attempt: map, worktrees: frozenWorktrees, missingTaskInfoRuns, orphanAttempts };
}

function migrationGitQuery(cwd: string, descriptor: GitQueryDescriptor): GitQueryResult {
  try { return runGitQuery({ cwd, descriptor }); }
  catch (error) {
    if (error instanceof GitQueryError) failure('blocked', 'migration Git inspection failed', [cwd, error.message, error.diagnostic]);
    throw error;
  }
}

function migrationGitOutput(result: GitQueryResult, cwd: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout); }
  catch { return failure('blocked', 'migration Git output is not valid UTF-8', [cwd, result.descriptor]); }
}

function gitText(cwd: string, descriptor: GitQueryDescriptor): string | null {
  const result = migrationGitQuery(cwd, descriptor);
  return result.negative ? null : migrationGitOutput(result, cwd).trim();
}

function exactCommit(repo: string, value: string): string | null {
  const commit = gitText(repo, { kind: 'resolve-commit', revision: value });
  return commit !== null && /^[a-f0-9]{40,64}$/u.test(commit) ? commit : null;
}

function gitAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return !migrationGitQuery(repo, { kind: 'is-ancestor', ancestor, descendant }).negative;
}

function gitWorktreeContains(repo: string, candidate: string): boolean {
  const output = gitText(repo, { kind: 'worktree-list', nul: true });
  if (output === null) return failure('blocked', 'migration Git worktree list unexpectedly reported absence', [repo]);
  const expected = resolve(candidate);
  return output.split('\0').some((entry) => entry.startsWith('worktree ') && resolve(entry.slice('worktree '.length)) === expected);
}

function evidenceRef(row: ActiveAutopilotRow, path: string): string {
  const root = isInside(row.runtime_root, path) ? row.runtime_root : row.worktree_root;
  return relative(root, path).split(sep).join('/');
}

function readLegacyMergeEvidence(rows: readonly ActiveAutopilotRow[]): { readonly merges: readonly LegacyMergeEvidence[]; readonly blockers: readonly string[] } {
  const merges: LegacyMergeEvidence[] = [];
  const blockers: string[] = [];
  const fields = ['active_run_epoch', 'attempt', 'audit_ref', 'autopilot_id', 'changed_paths', 'execution_commit_ref', 'integration_after', 'integration_before', 'main_branch', 'merge_commit_sha', 'merged_at', 'receipt_ref', 'role', 'schema_version', 'status_ref', 'unit_branch', 'unit_head', 'unit_id', 'workstream', 'workstream_run'];
  for (const row of rows) {
    const root = join(row.runtime_root, 'unit-merges');
    if (!existsSync(root)) continue;
    const files = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
    if (files.length > 10_000) failure('invalid', 'unit-merge evidence file count exceeds bound', [root]);
    for (const file of files) {
      const path = join(root, file);
      const raw = parseJsonFile(path, null);
      object(raw, path, fields);
      const merge = parseAutopilotUnitMerge(raw);
      if (merge.workstream_run !== row.workstream_run || merge.autopilot_id !== row.autopilot_id || merge.workstream !== row.workstream || merge.main_branch !== row.branch) failure('invalid', 'unit-merge evidence disagrees with durable run identity', [path]);
      const normalizedPaths = merge.changed_paths.map((changedPath) => normalizeRepoRelativePath(changedPath)).sort();
      if (new Set(normalizedPaths).size !== normalizedPaths.length || stableJson(normalizedPaths) !== stableJson([...merge.changed_paths].sort())) failure('invalid', 'unit-merge changed paths must be unique and normalized', [path]);
      if (!existsSync(row.main_worktree_path)) { blockers.push(`unit-merge Git proof unavailable because main worktree is missing: ${path}`); continue; }
      const before = exactCommit(row.source_repo, merge.integration_before);
      const after = exactCommit(row.source_repo, merge.integration_after);
      const mergeCommit = exactCommit(row.source_repo, merge.merge_commit_sha);
      const unitHead = exactCommit(row.source_repo, merge.unit_head);
      const currentHead = gitText(row.main_worktree_path, { kind: 'head' });
      const currentBranch = gitText(row.main_worktree_path, { kind: 'current-branch' });
      const diff = before === null || after === null ? null : migrationGitQuery(row.source_repo, { kind: 'diff-paths', from: before, to: after, noRenames: true });
      const actualPaths = diff === null ? [] : migrationGitOutput(diff, row.source_repo).split('\0').filter((entry) => entry.length > 0).map((entry) => entry.replace(/\\/gu, '/')).sort();
      const exact = before !== null && after !== null && mergeCommit === after && unitHead !== null && currentHead !== null && currentBranch === row.branch && gitAncestor(row.source_repo, before, after) && gitAncestor(row.source_repo, unitHead, after) && gitAncestor(row.source_repo, after, currentHead) && diff !== null && stableJson(actualPaths) === stableJson(normalizedPaths);
      if (!exact) { blockers.push(`unit-merge exact Git object/ref/ancestry/diff proof failed: ${path}`); continue; }
      merges.push({ merge, path, sha256: digest(readBounded(path, LEGACY_PREFLIGHT_MAX_INPUT_BYTES)), ref: evidenceRef(row, path) });
    }
  }
  const frozenMerges = Object.freeze(merges);
  const frozenBlockers = Object.freeze(blockers);
  return { merges: frozenMerges, blockers: frozenBlockers };
}

function acceptedAttemptProof(row: ActiveAutopilotRow, metadata: AutopilotUnitBranchInfo | undefined, record: Readonly<Record<string, unknown>>, path: string, action: string): TerminalProof | null {
  if (metadata === undefined || resolve(boundedString(record['unit_worktree_path'], `${path}.unit_worktree_path`)) !== resolve(metadata.worktree_path)) return null;
  const current = exactCommit(row.source_repo, metadata.current_sha);
  const base = exactCommit(row.source_repo, metadata.base_sha);
  if (current === null || base === null || !gitAncestor(row.source_repo, base, current)) return null;
  const branchRef = gitText(row.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${metadata.branch}` });
  const archiveRef = metadata.archive_ref === null ? null : gitText(row.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${metadata.archive_ref}` });
  const evidenceSha = digest(readBounded(path, LEGACY_PREFLIGHT_MAX_INPUT_BYTES));
  if (action === 'reset' || action === 'abort') {
    if (metadata.status !== 'aborted' || record['capture_commit_sha'] !== null || existsSync(metadata.worktree_path) || gitWorktreeContains(row.source_repo, metadata.worktree_path) || branchRef !== null || metadata.archive_ref !== null && archiveRef !== current) return null;
    const exactGitObjects = Object.freeze([base, current, ...(archiveRef === null ? [] : [archiveRef])]);
    const filesystemPostconditions = Object.freeze([`worktree-absent:${metadata.worktree_path}`, `git-worktree-registration-absent:${metadata.worktree_path}`, `branch-ref-absent:${metadata.branch}`]);
    return { source: 'attempt-reset', mechanical_proof: 'accepted-attempt-reset', evidence_ref: evidenceRef(row, path), evidence_sha256: evidenceSha, exact_git_objects: exactGitObjects, filesystem_postconditions: filesystemPostconditions };
  }
  const captureValue = record['capture_commit_sha'];
  if (metadata.status !== 'quarantined' || typeof captureValue !== 'string') return null;
  const capture = exactCommit(row.source_repo, captureValue);
  if (capture === null || capture !== current) return null;
  if (existsSync(metadata.worktree_path)) {
    const head = gitText(metadata.worktree_path, { kind: 'head' });
    const branch = gitText(metadata.worktree_path, { kind: 'current-branch' });
    const clean = gitText(metadata.worktree_path, { kind: 'status-porcelain' });
    if (head !== capture || branch !== metadata.branch || clean !== '' || branchRef !== capture) return null;
    const exactGitObjects = Object.freeze([base, capture]);
    const filesystemPostconditions = Object.freeze([`clean-worktree-head:${metadata.worktree_path}:${capture}`, `branch-ref:${metadata.branch}:${capture}`]);
    return { source: 'quarantine-capture', mechanical_proof: 'accepted-quarantine-capture', evidence_ref: evidenceRef(row, path), evidence_sha256: evidenceSha, exact_git_objects: exactGitObjects, filesystem_postconditions: filesystemPostconditions };
  }
  if (metadata.archive_ref === null || archiveRef !== capture || gitWorktreeContains(row.source_repo, metadata.worktree_path)) return null;
  const exactGitObjects = Object.freeze([base, capture, archiveRef]);
  const filesystemPostconditions = Object.freeze([`worktree-absent:${metadata.worktree_path}`, `git-worktree-registration-absent:${metadata.worktree_path}`, `archive-ref:${metadata.archive_ref}:${capture}`]);
  return { source: 'quarantine-capture', mechanical_proof: 'accepted-quarantine-capture', evidence_ref: evidenceRef(row, path), evidence_sha256: evidenceSha, exact_git_objects: exactGitObjects, filesystem_postconditions: filesystemPostconditions };
}

function acceptedRunProof(row: ActiveAutopilotRow, index: readonly AutopilotWorktreeIndexRow[], path: string, outcome: 'closed' | 'aborted', terminalValue: string): TerminalProof | null {
  if (row.status !== 'closed') return null;
  const terminal = exactCommit(row.source_repo, terminalValue);
  if (terminal === null || existsSync(row.main_worktree_path) || gitWorktreeContains(row.source_repo, row.main_worktree_path) || gitText(row.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${row.branch}` }) !== null) return null;
  const archiveRef = `autopilot/archive/${row.workstream_run}/${outcome === 'closed' ? 'main' : 'aborted'}`;
  if (gitText(row.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${archiveRef}` }) !== terminal) return null;
  const indexed = index.filter((entry) => entry.workstream_run === row.workstream_run && entry.autopilot_id === row.autopilot_id && entry.status === 'archived' && resolve(entry.main_path) === resolve(row.main_worktree_path) && entry.branch === row.branch);
  if (indexed.length !== 1) return null;
  if (outcome === 'closed') {
    if (row.target_branch === null || gitText(row.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${row.target_branch}` }) !== terminal) return null;
  }
  const exactGitObjects = Object.freeze([terminal]);
  const filesystemPostconditions = Object.freeze([`main-worktree-absent:${row.main_worktree_path}`, `git-worktree-registration-absent:${row.main_worktree_path}`, `branch-ref-absent:${row.branch}`, `archive-ref:${archiveRef}:${terminal}`, 'worktree-index-archived']);
  return { source: outcome === 'closed' ? 'run-close' : 'run-abort', mechanical_proof: 'accepted-run-terminal', evidence_ref: evidenceRef(row, path), evidence_sha256: digest(readBounded(path, LEGACY_PREFLIGHT_MAX_INPUT_BYTES)), exact_git_objects: exactGitObjects, filesystem_postconditions: filesystemPostconditions };
}

function readLegacyTerminalEvidence(rows: readonly ActiveAutopilotRow[], claims: readonly AutopilotPathClaim[], unitMetadata: ParsedUnitMetadata, index: readonly AutopilotWorktreeIndexRow[]): LegacyTerminalEvidence {
  const attemptProof = new Map<string, TerminalProof>();
  const readProof = new Map<string, TerminalProof>();
  const runProof = new Map<string, TerminalProof>();
  const paths: string[] = [];
  for (const row of rows) {
    const runtimeRoots = [row.runtime_root, join(row.worktree_root, '_archive', row.workstream_run, 'runtime')];
    for (const runtimeRoot of runtimeRoots) {
      const quarantineRoot = join(runtimeRoot, 'quarantine');
      if (existsSync(quarantineRoot)) {
        const files = readdirSync(quarantineRoot, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => join(quarantineRoot, entry.name)).sort();
        if (files.length > 10_000) failure('invalid', 'terminal evidence file count exceeds bound', [quarantineRoot]);
        for (const path of files) {
          paths.push(path);
          const evidenceValue = parseJsonFile(path, null);
          const evidenceSchema = typeof evidenceValue === 'object' && evidenceValue !== null && !Array.isArray(evidenceValue) ? (evidenceValue as Readonly<Record<string, unknown>>)['schema_version'] : null;
          if (evidenceSchema === 'autopilot.unit_index_adjudication.v1') {
            const adjudication = closedObject(evidenceValue, path, ['action', 'attempt', 'created_at', 'reason', 'schema_version', 'transport_failure_ref', 'unit_id', 'unit_index_ref', 'unit_info_ref', 'workstream', 'workstream_run'], ['branches_ref', 'manual_path_remove_ref', 'prior_reset_ref']);
            if (adjudication['workstream'] !== row.workstream || adjudication['workstream_run'] !== row.workstream_run) failure('invalid', 'unit-index adjudication evidence identity is invalid', [path]);
            boundedString(adjudication['unit_id'], `${path}.unit_id`, 192);
            integer(adjudication['attempt'], `${path}.attempt`, 1);
            continue;
          }
          if (evidenceSchema === 'autopilot.manual_worktree_reconcile.v1') {
            const reconciliation = object(evidenceValue, path, ['action', 'attempt', 'changed_path_hash_proof', 'created_at', 'exists_after_remove', 'exists_before_remove', 'path_within_run_root', 'reason', 'schema_version', 'top_level_entries_before_remove', 'transport_failure_ref', 'unit_id', 'workstream', 'workstream_run', 'worktree_path']);
            if (reconciliation['workstream'] !== row.workstream || reconciliation['workstream_run'] !== row.workstream_run) failure('invalid', 'manual worktree reconciliation evidence identity is invalid', [path]);
            boundedString(reconciliation['unit_id'], `${path}.unit_id`, 192);
            integer(reconciliation['attempt'], `${path}.attempt`, 1);
            continue;
          }
          const record = closedObject(evidenceValue, path, ['action', 'attempt', 'created_at', 'dirty_paths', 'schema_version', 'summary', 'unit_id', 'unit_worktree_path', 'workstream', 'workstream_run'], ['capture_commit_sha']);
          if (record['schema_version'] !== 'autopilot.unit_failure.v1' || record['workstream'] !== row.workstream || record['workstream_run'] !== row.workstream_run) failure('invalid', 'unit terminal evidence identity is invalid', [path]);
          const unitId = boundedString(record['unit_id'], `${path}.unit_id`, 192);
          const attempt = integer(record['attempt'], `${path}.attempt`, 1);
          const action = boundedString(record['action'], `${path}.action`, 32);
          if (!['reset', 'abort', 'quarantine', 'preserve'].includes(action)) continue;
          stringArray(record['dirty_paths'], `${path}.dirty_paths`);
          const key = attemptKey(row.workstream_run, unitId, attempt);
          const accepted = acceptedAttemptProof(row, unitMetadata.by_attempt.get(key), record, path, action);
          if (accepted !== null && (attemptProof.get(key)?.source !== 'attempt-reset' || accepted.source === 'attempt-reset')) attemptProof.set(key, accepted);
        }
      }
      const closeRoot = join(runtimeRoot, 'close');
      for (const outcome of ['closed', 'aborted'] as const) {
        const path = join(closeRoot, `_run-terminal.${outcome}.json`);
        if (!existsSync(path)) continue;
        paths.push(path);
        const terminalValue = parseJsonFile(path, null);
        const terminalMap = typeof terminalValue === 'object' && terminalValue !== null && !Array.isArray(terminalValue) ? terminalValue as Readonly<Record<string, unknown>> : null;
        const hasCleanupBinding = terminalMap !== null && ('cleanup_manifest_ref' in terminalMap || 'cleanup_manifest_sha256' in terminalMap);
        const terminalFields = ['accepted_at', 'autopilot_id', ...(hasCleanupBinding ? ['cleanup_manifest_ref', 'cleanup_manifest_sha256'] : []), 'outcome', 'repo_key', 'schema_version', 'terminal_sha', 'workstream', 'workstream_run'];
        const record = object(terminalValue, path, terminalFields);
        if (record['schema_version'] !== 'autopilot.run_terminal.v1' || record['repo_key'] !== row.repo_key || record['autopilot_id'] !== row.autopilot_id || record['workstream'] !== row.workstream || record['workstream_run'] !== row.workstream_run || record['outcome'] !== outcome || typeof record['terminal_sha'] !== 'string' || !/^[a-f0-9]{7,64}$/u.test(record['terminal_sha'])) failure('invalid', 'run terminal evidence identity is invalid', [path]);
        if (hasCleanupBinding && (record['cleanup_manifest_ref'] !== 'close/_terminal-cleanup.json' || typeof record['cleanup_manifest_sha256'] !== 'string' || !DIGEST.test(record['cleanup_manifest_sha256']))) failure('invalid', 'run terminal cleanup binding is invalid', [path]);
        const accepted = acceptedRunProof(row, index, path, outcome, record['terminal_sha']);
        if (accepted !== null) runProof.set(row.workstream_run, accepted);
      }
    }
  }
  for (const row of rows) {
    const attempts = new Map<string, AutopilotPathClaim>();
    for (const claim of claims) {
      if (claim.workstream_run !== row.workstream_run || claim.autopilot_id !== row.autopilot_id || claim.claim_type !== 'READ') continue;
      attempts.set(attemptKey(claim.workstream_run, claim.unit_id, claim.attempt), claim);
    }
    for (const [key, claim] of attempts) {
      const result = proveLegacyReadAttemptTerminal({ runtimeRoot: row.runtime_root, workstream: row.workstream, unitId: claim.unit_id, attempt: claim.attempt });
      if (!result.proven) continue;
      paths.push(...result.proof.artifacts.map((artifact) => artifact.path));
      readProof.set(key, {
        source: 'legacy-read-terminal',
        mechanical_proof: result.proof.kind === 'completed-current-attempt' ? 'accepted-read-terminal' : 'superseded-read-terminal',
        evidence_ref: evidenceRef(row, result.proof.evidence.path),
        evidence_sha256: result.proof.evidence.sha256,
        supporting_evidence: result.proof.artifacts.map((artifact) => ({ ref: evidenceRef(row, artifact.path), sha256: artifact.sha256 })),
        exact_git_objects: [],
        filesystem_postconditions: result.proof.mechanicalProof,
      });
    }
  }
  const frozenPaths = Object.freeze([...new Set(paths)].sort());
  return { attemptProof, readProof, runProof, paths: frozenPaths };
}

function parseWorktreeIndex(path: string): readonly AutopilotWorktreeIndexRow[] {
  const parsed = parseJsonFile(path, { schema_version: 'autopilot.worktree_index.v1', active: [], archive: [] });
  const root = object(parsed, path, ['active', 'archive', 'schema_version']);
  if (root['schema_version'] !== 'autopilot.worktree_index.v1' || !Array.isArray(root['active']) || !Array.isArray(root['archive']) || root['active'].length + root['archive'].length > 100_000) failure('invalid', 'worktree index has invalid schema or bound', [path]);
  return Object.freeze([...root['active'], ...root['archive']].map((entry, index) => {
    const row = object(entry, `${path}[${String(index)}]`, ['autopilot_id', 'branch', 'main_path', 'started_at', 'status', 'workstream', 'workstream_run']);
    const statusValue = boundedString(row['status'], 'worktree index status', 16);
    if (statusValue !== 'active' && statusValue !== 'archived') failure('invalid', 'worktree index status is invalid');
    const mainPath = boundedString(row['main_path'], 'worktree index main_path');
    if (!isAbsolute(mainPath)) failure('invalid', 'worktree index main_path must be absolute');
    return { workstream: boundedString(row['workstream'], 'worktree index workstream', 192), workstream_run: boundedString(row['workstream_run'], 'worktree index run', 192), autopilot_id: boundedString(row['autopilot_id'], 'worktree index autopilot', 192), started_at: boundedString(row['started_at'], 'worktree index started_at', 64), main_path: resolve(mainPath), branch: boundedString(row['branch'], 'worktree index branch', 512), status: statusValue as AutopilotWorktreeIndexRow['status'] };
  }));
}

function sourcePaths(stateRoot: string, repoKey: string, rows: readonly ActiveAutopilotRow[], unitMetadata: ParsedUnitMetadata, merges: readonly LegacyMergeEvidence[], terminalPaths: readonly string[]): readonly string[] {
  const coordination = join(stateRoot, 'coordination', repoKey);
  const worktrees = join(stateRoot, 'worktrees', repoKey);
  const paths = [...TOP_LEVEL_COORDINATION_FILES.map((name) => join(coordination, name)), ...TOP_LEVEL_WORKTREE_FILES.map((name) => join(worktrees, name))];
  paths.push(...merges.map((entry) => entry.path), ...terminalPaths);
  for (const row of rows) {
    const taskRoot = dirname(row.main_worktree_path);
    paths.push(join(taskRoot, '_task-info.json'), join(taskRoot, '_branches.json'), join(taskRoot, '_unit-index.json'), join(row.runtime_root, 'state.json'));
    for (const unit of unitMetadata.worktrees.filter((entry) => isInside(taskRoot, entry.worktree_path))) paths.push(join(dirname(unit.worktree_path), '_unit-info.json'));
  }
  return Object.freeze([...new Set(paths.map((path) => resolve(path)))].sort());
}

function physicalContainmentRoot(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) failure('invalid', 'migration input has no existing physical ancestor', [path]);
    current = parent;
  }
  return realpathSync(current);
}

function snapshotEntries(stateRoot: string, paths: readonly string[]): readonly SnapshotEntry[] {
  if (paths.length > COORDINATION_MIGRATION_MAX_FILES) failure('invalid', 'migration input file count exceeds bound');
  const physicalStateRoot = physicalContainmentRoot(stateRoot);
  let total = 0;
  return Object.freeze(paths.map((path) => {
    if (!isInside(stateRoot, path) || !isInside(physicalStateRoot, physicalContainmentRoot(path))) failure('invalid', 'migration input path escapes isolated state root physically or lexically', [path]);
    const relativePath = relative(stateRoot, path).split(sep).join('/');
    if (!existsSync(path)) return { source_path: path, relative_path: relativePath, exists: false, size_bytes: 0, sha256: digest(new TextEncoder().encode('<missing>')) };
    const bytes = readBounded(path);
    total += bytes.byteLength;
    if (total > COORDINATION_MIGRATION_MAX_TOTAL_BYTES) failure('invalid', 'migration aggregate input bytes exceed bound');
    return { source_path: path, relative_path: relativePath, exists: true, size_bytes: bytes.byteLength, sha256: digest(bytes) };
  }));
}

function aggregateDigest(entries: readonly SnapshotEntry[], gitSnapshot: readonly GitSnapshotEntry[]): `sha256:${string}` {
  const identity = { files: entries.map((entry) => ({ relative_path: entry.relative_path, exists: entry.exists, size_bytes: entry.size_bytes, sha256: entry.sha256 })), git: gitSnapshot };
  return digest(new TextEncoder().encode(stableJson(identity)));
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function captureGitSnapshot(rows: readonly ActiveAutopilotRow[], repository: MigrationRepositoryIdentity): readonly GitSnapshotEntry[] {
  const snapshots = rows.map((row) => {
    const sourceHead = existsSync(row.source_repo) ? gitText(row.source_repo, { kind: 'head' }) : null;
    const mainHead = existsSync(row.main_worktree_path) ? gitText(row.main_worktree_path, { kind: 'head' }) : null;
    const mainBranch = existsSync(row.main_worktree_path) ? gitText(row.main_worktree_path, { kind: 'current-branch' }) : null;
    if (sourceHead === null || existsSync(row.main_worktree_path) && (mainHead === null || mainBranch === null)) failure('blocked', 'failed to capture migration Git state', [row.workstream_run]);
    return { workstream_run: row.workstream_run, source_head: sourceHead, main_head: mainHead, main_branch: mainBranch };
  });
  if (snapshots.length === 0) {
    const head = gitText(repository.canonical_root, { kind: 'head' });
    const branch = gitText(repository.canonical_root, { kind: 'current-branch' });
    if (head === null || branch === null) failure('blocked', 'failed to capture empty-repository migration Git state', [repository.canonical_root]);
    snapshots.push({ workstream_run: '@repository', source_head: head, main_head: head, main_branch: branch });
  }
  return Object.freeze(snapshots.sort((left, right) => left.workstream_run.localeCompare(right.workstream_run)));
}

function recheckGitSnapshot(expected: readonly GitSnapshotEntry[], rows: readonly ActiveAutopilotRow[], repository: MigrationRepositoryIdentity): readonly string[] {
  if (expected.length === 0) return [];
  const actual = captureGitSnapshot(rows, repository);
  if (stableJson(actual) === stableJson(expected)) return [];
  const drift = Object.freeze([`Git repository/worktree state changed: expected=${stableJson(expected)} actual=${stableJson(actual)}`]);
  return drift;
}

function inspectGit(rows: readonly ActiveAutopilotRow[], ledgerTerminalized: ReadonlySet<string>): readonly string[] {
  const blockers: string[] = [];
  for (const row of rows) {
    if (!existsSync(row.source_repo)) { blockers.push(`source repository is missing: ${row.source_repo}`); continue; }
    const top = gitText(row.source_repo, { kind: 'show-toplevel' });
    const common = gitText(row.source_repo, { kind: 'git-common-dir' });
    if (top === null || common === null) { blockers.push(`source repository Git response is incomplete: ${row.source_repo}`); continue; }
    try {
      if (realpathSync(top) !== realpathSync(row.source_repo)) blockers.push(`source repository canonical root mismatch: ${row.workstream_run}`);
      const resolvedCommon = isAbsolute(common) ? common : resolve(row.source_repo, common);
      if (realpathSync(resolvedCommon) !== realpathSync(row.git_common_dir)) blockers.push(`Git common-dir mismatch: ${row.workstream_run}`);
    } catch { blockers.push(`source repository canonical path verification failed: ${row.workstream_run}`); }
    if (existsSync(row.main_worktree_path)) {
      const branch = gitText(row.main_worktree_path, { kind: 'current-branch' });
      if (branch !== row.branch) blockers.push(`main worktree branch mismatch: ${row.workstream_run}`);
    } else if (row.status !== 'closed' && !ledgerTerminalized.has(row.workstream_run)) blockers.push(`live main worktree is missing and requires recovery: ${row.workstream_run}`);
  }
  return Object.freeze(blockers.sort());
}

interface ReadonlyCoordinatorRepository {
  readonly repo_id: string;
  readonly repo_key: string;
  readonly canonical_root: string;
  readonly git_common_dir: string;
}

interface ReadonlyCoordinatorRun {
  readonly workstream_run: string;
  readonly status: string;
}

interface ReadonlyCoordinatorSession {
  readonly workstream_run: string;
  readonly session_lease_id: string;
  readonly status: string;
}

interface ReadonlyCoordinatorChild {
  readonly workstream_run: string;
  readonly child_lease_id: string;
  readonly status: string;
}

interface ReadonlyCoordinatorMigration {
  readonly migration_id: string;
  readonly snapshot_sha256: `sha256:${string}`;
  readonly state: CoordinationMigrationRecordState;
  readonly report: Readonly<Record<string, unknown>>;
}

interface ReadonlyCoordinatorInspection {
  readonly schemaVersion: 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
  readonly repositories: readonly ReadonlyCoordinatorRepository[];
  readonly runs: readonly ReadonlyCoordinatorRun[];
  readonly sessions: readonly ReadonlyCoordinatorSession[];
  readonly children: readonly ReadonlyCoordinatorChild[];
  readonly attempts: readonly CoordinationUnitAttempt[];
  readonly editLeases: readonly CoordinationEditLease[];
  readonly worktreeOperations: readonly CoordinationWorktreeOperation[];
  readonly globalDrainBlockers: readonly string[];
  readonly migration: ReadonlyCoordinatorMigration | null;
}

interface SqliteRow {
  readonly [field: string]: SQLOutputValue;
}

const SCHEMA_6_TABLES = Object.freeze([
  'acquisition_groups', 'adjudication_assignments', 'authoritative_artifacts', 'change_reservations', 'child_leases',
  'claim_requests', 'deadlock_resolutions', 'edit_leases', 'escalations', 'events', 'evidence_artifacts', 'handoffs',
  'idempotency_results', 'mailbox_cursors', 'merge_operations', 'messages', 'reconciliation_evidence', 'repositories',
  'reservation_obligations', 'run_terminal_intents', 'runs', 'schema_migrations', 'session_leases', 'unit_attempts',
  'wait_for_edges', 'worktree_operations', 'worktrees',
] as const);
const SCHEMA_7_TABLES = Object.freeze([...SCHEMA_6_TABLES, 'coordination_migrations', 'migration_legacy_audit', 'migration_recovery_work', 'run_resources'].sort());
const SCHEMA_9_TABLES = Object.freeze([...SCHEMA_7_TABLES, 'semantic_replays'].sort());
const SCHEMA_10_TABLES = Object.freeze([...SCHEMA_9_TABLES, 'observations'].sort());
const SCHEMA_12_TABLES = Object.freeze([...SCHEMA_10_TABLES, 'mailbox_deliveries', 'mailbox_delivery_items', 'reconciliation_details', 'reconciliation_receipts', 'result_details', 'result_receipts'].sort());
const SCHEMA_13_TABLES = Object.freeze([...SCHEMA_12_TABLES, 'run_scoped_faults', 'worktree_aliases'].sort());
const COORDINATION_MIGRATION_MAX_DATABASE_ROWS = 100_000;
const COORDINATION_MIGRATION_MAX_DATABASE_JSON_BYTES = 1024 * 1024;

function sqlText(row: SqliteRow, field: string, label: string, maximum = 2048): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\u0000')) failure('blocked', `${label}.${field} is not bounded text`);
  return value;
}

function sqlSafeInteger(row: SqliteRow, field: string, label: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) failure('blocked', `${label}.${field} is not a safe integer`);
  return value;
}

function boundedDatabaseRows(database: DatabaseSync, table: string, sql: string, parameters: readonly (string | number)[] = []): readonly SqliteRow[] {
  const countRow = database.prepare(`SELECT COUNT(*) AS row_count FROM ${table}`).get() as SqliteRow | undefined;
  if (countRow === undefined || sqlSafeInteger(countRow, 'row_count', table) > COORDINATION_MIGRATION_MAX_DATABASE_ROWS) failure('blocked', `coordinator table ${table} exceeds the migration inspection row bound`);
  const rows = database.prepare(sql).all(...parameters) as SqliteRow[];
  if (rows.length > COORDINATION_MIGRATION_MAX_DATABASE_ROWS) failure('blocked', `coordinator query for ${table} exceeds the migration inspection row bound`);
  return Object.freeze(rows);
}

function parseDatabasePayload(row: SqliteRow, field: string, label: string): Readonly<Record<string, unknown>> {
  const text = sqlText(row, field, label, COORDINATION_MIGRATION_MAX_DATABASE_JSON_BYTES);
  if (Buffer.byteLength(text, 'utf8') > COORDINATION_MIGRATION_MAX_DATABASE_JSON_BYTES) failure('blocked', `${label}.${field} exceeds the migration JSON byte bound`);
  let parsed: unknown;
  try { assertNoDuplicateJsonKeys(text, `${label}.${field}`); parsed = JSON.parse(text) as unknown; }
  catch (error) {
    if (error instanceof CoordinationRuntimeError) throw error;
    failure('blocked', `${label}.${field} contains invalid JSON`);
  }
  validateBoundedJson(parsed, `${label}.${field}`);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) failure('blocked', `${label}.${field} must be a JSON object`);
  return parsed as Readonly<Record<string, unknown>>;
}

function assertExactTableColumns(database: DatabaseSync, table: string, expected: readonly string[]): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[];
  if (rows.length > 64) failure('blocked', `coordinator table ${table} has too many columns`);
  const actual = rows.map((row) => sqlText(row, 'name', `${table} column`, 128));
  if (stableJson(actual) !== stableJson(expected)) failure('blocked', `coordinator table ${table} does not match its exact schema profile`, [`expected=${stableJson(expected)}`, `actual=${stableJson(actual)}`]);
}

function assertReadOnlySchema(database: DatabaseSync): 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 {
  const versionRow = database.prepare('PRAGMA user_version').get() as SqliteRow | undefined;
  if (versionRow === undefined) failure('blocked', 'coordinator database has no schema version');
  const version = sqlSafeInteger(versionRow, 'user_version', 'coordinator database');
  if (version !== 6 && version !== 7 && version !== 8 && version !== 9 && version !== 10 && version !== 11 && version !== 12 && version !== 13) failure('blocked', `migration inspection supports only exact coordinator schema 6 through private store schema ${String(COORDINATOR_STORE_SCHEMA_VERSION)}`, [`schema=${String(version)}`]);
  const integrityRow = database.prepare('PRAGMA integrity_check(1)').get() as SqliteRow | undefined;
  if (integrityRow === undefined || integrityRow['integrity_check'] !== 'ok') failure('blocked', 'coordinator database failed read-only integrity inspection');
  const schemaRows = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as SqliteRow[];
  if (schemaRows.length > 64) failure('blocked', 'coordinator database schema contains too many tables');
  const actual = schemaRows.map((row) => sqlText(row, 'name', 'coordinator schema table', 128));
  const expected = version === 6 ? [...SCHEMA_6_TABLES].sort() : version === 13 ? SCHEMA_13_TABLES : version === 12 ? SCHEMA_12_TABLES : version >= 10 ? SCHEMA_10_TABLES : version === 9 ? SCHEMA_9_TABLES : SCHEMA_7_TABLES;
  if (stableJson(actual) !== stableJson(expected)) failure('blocked', `coordinator schema ${String(version)} table profile is not exact`, [`expected=${stableJson(expected)}`, `actual=${stableJson(actual)}`]);
  assertExactTableColumns(database, 'repositories', ['repo_id', 'repo_key', 'canonical_root', 'git_common_dir', 'event_seq', 'created_event_seq', 'version']);
  assertExactTableColumns(database, 'runs', ['repo_id', 'autopilot_id', 'workstream', 'workstream_run', 'status', 'active_session_generation', 'created_event_seq', 'version', 'coordination_authority']);
  assertExactTableColumns(database, 'session_leases', ['session_lease_id', 'repo_id', 'workstream_run', 'session_id', 'session_generation', 'pid', 'boot_id', 'session_token_sha256', 'lease_expires_at', 'status', 'attached_event_seq', 'version', ...(version >= 8 ? ['attachment_kind'] : [])]);
  assertExactTableColumns(database, 'child_leases', ['child_lease_id', 'repo_id', 'autopilot_id', 'workstream_run', 'unit_id', 'attempt', 'pid', 'boot_id', 'child_token_sha256', 'lease_expires_at', 'status', 'terminal_evidence_ref', 'terminal_evidence_sha256', 'version']);
  assertExactTableColumns(database, 'unit_attempts', ['entity_id', 'repo_id', 'workstream_run', 'payload_json', 'version']);
  assertExactTableColumns(database, 'edit_leases', ['entity_id', 'repo_id', 'workstream_run', 'payload_json', 'version']);
  assertExactTableColumns(database, 'worktree_operations', ['entity_id', 'repo_id', 'workstream_run', 'payload_json', 'version', ...(version >= 13 ? ['canonical_worktree_id'] : [])]);
  if (version >= 13) assertExactTableColumns(database, 'worktrees', ['entity_id', 'repo_id', 'workstream_run', 'payload_json', 'version', 'canonical_worktree_id', 'autopilot_id', 'unit_id', 'attempt', 'kind', 'is_current_canonical']);
  assertExactTableColumns(database, 'schema_migrations', ['version', 'checksum', 'applied_at']);
  if (version >= 7) {
    assertExactTableColumns(database, 'coordination_migrations', ['repo_id', 'migration_id', 'snapshot_sha256', 'journal_path', 'state', 'report_json', 'imported_at', 'updated_at', 'version']);
    assertExactTableColumns(database, 'migration_recovery_work', ['entity_id', 'repo_id', 'workstream_run', 'recovery_type', 'payload_json', 'status', 'created_event_seq', 'version', ...(version >= 8 ? ['resolution_json', 'resolved_event_seq'] : [])]);
  }
  if (version >= 9) {
    assertExactTableColumns(database, 'semantic_replays', ['replay_id', 'record_count', 'records_sha256', 'applied_at']);
  }
  if (version >= 10) assertExactTableColumns(database, 'observations', ['entity_id', 'repo_id', 'workstream_run', 'acquisition_group_id', 'payload_json', 'execution_state', 'freshness', 'version']);
  if (version >= 12) {
    assertExactTableColumns(database, 'reconciliation_receipts', ['entity_id', 'repo_id', 'workstream_run', 'committed_event_seq', 'source_action', 'payload_json', 'version']);
    assertExactTableColumns(database, 'reconciliation_details', ['reconciliation_receipt_id', 'ordinal', 'kind', 'entity_id']);
    assertExactTableColumns(database, 'mailbox_deliveries', ['delivery_id', 'repo_id', 'workstream_run', 'session_lease_id', 'snapshot_through_event_seq', 'next_ordinal', 'payload_json', 'version']);
    assertExactTableColumns(database, 'result_receipts', ['entity_id', 'repo_id', 'workstream_run', 'committed_event_seq', 'source_action', 'payload_json', 'version']);
    assertExactTableColumns(database, 'result_details', ['result_receipt_id', 'ordinal', 'collection_name', 'collection_ordinal', 'payload_json']);
    assertExactTableColumns(database, 'mailbox_delivery_items', ['delivery_id', 'ordinal', 'message_id', 'snapshot_delivered_event_seq', 'snapshot_message_version']);
  }
  if (version >= 13) {
    assertExactTableColumns(database, 'worktree_aliases', ['alias_worktree_id', 'canonical_worktree_id', 'repo_id', 'autopilot_id', 'workstream_run', 'unit_id', 'attempt', 'kind', 'resolution_state', 'reason', 'evidence_sha256', 'created_event_seq']);
    assertExactTableColumns(database, 'run_scoped_faults', ['fault_id', 'invariant_id', 'repo_id', 'workstream_run', 'entity_type', 'entity_id', 'fault_code', 'detail_json', 'status', 'created_event_seq', 'resolved_event_seq', 'version']);
  }
  const migrationRows = boundedDatabaseRows(database, 'schema_migrations', 'SELECT version, checksum FROM schema_migrations ORDER BY version');
  if (migrationRows.length !== version) failure('blocked', 'coordinator schema migration journal length is not exact');
  for (let index = 0; index < migrationRows.length; index += 1) {
    const row = migrationRows[index];
    const checksum = row === undefined ? null : sqlText(row, 'checksum', 'schema migration', 64);
    const checksumMatches = checksum === COORDINATOR_SCHEMA_MIGRATION_CHECKSUMS[index];
    if (row === undefined || sqlSafeInteger(row, 'version', 'schema migration') !== index + 1 || !checksumMatches) failure('blocked', 'coordinator schema migration journal is malformed, discontinuous, or not the exact locked schema-6/7/8/9/10/11/12/13 package lineage');
  }
  return version;
}

interface CoordinatorDatabaseSourceIdentity {
  readonly path: string;
  readonly exists: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtime_ms: number;
  readonly ctime_ms: number;
  readonly sha256: `sha256:${string}`;
}

function coordinatorDatabaseSourceIdentity(path: string): CoordinatorDatabaseSourceIdentity {
  if (!existsSync(path)) return { path, exists: false, dev: 0, ino: 0, size: 0, mtime_ms: 0, ctime_ms: 0, sha256: digest(new TextEncoder().encode('<missing>')) };
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) failure('blocked', 'coordinator database snapshot source must be a regular non-symbolic file', [path]);
  if (info.size > COORDINATION_MIGRATION_MAX_DATABASE_COMPONENT_BYTES) failure('blocked', 'coordinator database snapshot source exceeds its bounded file ceiling', [path, String(info.size)]);
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!sameFileIdentity(info, opened) || opened.size !== info.size) failure('blocked', 'coordinator database snapshot source identity changed while opening', [path]);
    const bytes = readFileSync(descriptor);
    const after = lstatSync(path);
    if (bytes.byteLength !== info.size || !sameFileIdentity(info, after) || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) failure('blocked', 'coordinator database snapshot source identity changed during hashing', [path]);
    return { path, exists: true, dev: info.dev, ino: info.ino, size: info.size, mtime_ms: info.mtimeMs, ctime_ms: info.ctimeMs, sha256: digest(bytes) };
  } finally { closeSync(descriptor); }
}

function coordinatorAuthorityDatabasePath(paths: CoordinatorRuntimePaths): string {
  const current = readCurrentStoreGeneration(paths);
  return current?.database_path ?? paths.databasePath;
}

function coordinatorDatabaseSourceIdentities(databasePath: string): readonly CoordinatorDatabaseSourceIdentity[] {
  const identities = Object.freeze([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(coordinatorDatabaseSourceIdentity));
  const total = identities.reduce((sum, entry) => sum + entry.size, 0);
  if (total > COORDINATION_MIGRATION_MAX_TOTAL_BYTES) failure('blocked', 'coordinator database snapshot exceeds its aggregate byte ceiling', [String(total)]);
  return identities;
}

function assertCoordinatorDatabaseSourceStable(expected: readonly CoordinatorDatabaseSourceIdentity[]): void {
  const actual = coordinatorDatabaseSourceIdentities(expected[0]?.path ?? failure('blocked', 'coordinator database snapshot identity is empty'));
  if (stableJson(actual) !== stableJson(expected)) failure('blocked', 'coordinator database/WAL/SHM identity or bytes changed during copied inspection', [`expected=${stableJson(expected)}`, `actual=${stableJson(actual)}`]);
}

/**
 * SQLite read-only WAL connections may still take reader marks in the source
 * SHM file. Migration inspection therefore never opens the source database at
 * all. It copies a bounded, byte-stable db/WAL/SHM generation outside the state
 * root, proves source identity and hashes before and after both copy and query,
 * opens only the disposable copy, and removes it in a finally block.
 */
function copiedCoordinatorDatabase(paths: CoordinatorRuntimePaths, writerAuthorityAcquired: boolean): { readonly databasePath: string; readonly root: string; readonly source: readonly CoordinatorDatabaseSourceIdentity[] } {
  const authorityDatabasePath = coordinatorAuthorityDatabasePath(paths);
  assertMigrationPathSafe(paths.stateRoot, authorityDatabasePath, 'read-only coordinator database inspection');
  const source = coordinatorDatabaseSourceIdentities(authorityDatabasePath);
  const database = source[0];
  if (database === undefined || !database.exists) failure('blocked', 'coordinator database disappeared before copied inspection');
  const wal = source[1];
  const shm = source[2];
  if (wal?.exists === true && wal.size > 0 && ((!coordinationMigrationCoordinatorRunning(paths) && !writerAuthorityAcquired) || shm?.exists !== true)) failure('blocked', 'uncheckpointed coordinator WAL has no live fenced owner or durable migration writer authority; copied inspection is unsafe', [wal.path]);
  const root = mkdtempSync(join(tmpdir(), 'autopilot-coordinator-inspection-'));
  if (isInside(paths.stateRoot, root)) {
    rmSync(root, { recursive: true, force: true });
    failure('blocked', 'disposable coordinator inspection root must be outside the state root', [root]);
  }
  const targetDatabase = join(root, basename(authorityDatabasePath));
  try {
    for (const entry of source) {
      if (!entry.exists) continue;
      const suffix = entry.path.slice(authorityDatabasePath.length);
      const target = `${targetDatabase}${suffix}`;
      copyFileSync(entry.path, target, fsConstants.COPYFILE_EXCL);
      const copied = coordinatorDatabaseSourceIdentity(target);
      if (copied.size !== entry.size || copied.sha256 !== entry.sha256) failure('blocked', 'coordinator database snapshot copy does not match its source bytes', [entry.path, target]);
    }
    assertCoordinatorDatabaseSourceStable(source);
    return { databasePath: targetDatabase, root, source };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function openImmutableCoordinatorDatabase(path: string): DatabaseSync {
  const walPath = `${path}-wal`;
  if (existsSync(walPath) && statSync(walPath).size > 0) failure('blocked', 'immutable coordinator inspection refuses an uncheckpointed WAL', [walPath]);
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  return new DatabaseSync(url, { readOnly: true, timeout: 1_000, enableForeignKeyConstraints: false });
}

function inspectCoordinatorReadOnly(paths: CoordinatorRuntimePaths, repoKey: string, writerAuthorityAcquired = false): ReadonlyCoordinatorInspection | null {
  if (!existsSync(paths.currentStorePointerPath) && !existsSync(paths.databasePath)) return null;
  const copied = copiedCoordinatorDatabase(paths, writerAuthorityAcquired);
  let database: DatabaseSync;
  try { database = new DatabaseSync(copied.databasePath, { readOnly: true, timeout: 1_000, enableForeignKeyConstraints: false }); }
  catch (error) {
    rmSync(copied.root, { recursive: true, force: true });
    failure('blocked', 'copied coordinator database could not be opened read-only', [error instanceof Error ? error.message : String(error)]);
  }
  try {
    database.exec('BEGIN');
    const schemaVersion = assertReadOnlySchema(database);
    const repositories = boundedDatabaseRows(database, 'repositories', 'SELECT repo_id, repo_key, canonical_root, git_common_dir FROM repositories WHERE repo_id=? ORDER BY repo_id', [repoKey]).map((row) => ({ repo_id: sqlText(row, 'repo_id', 'repository', 192), repo_key: sqlText(row, 'repo_key', 'repository', 192), canonical_root: sqlText(row, 'canonical_root', 'repository'), git_common_dir: sqlText(row, 'git_common_dir', 'repository') }));
    const runs = boundedDatabaseRows(database, 'runs', 'SELECT workstream_run, status FROM runs WHERE repo_id=? ORDER BY workstream_run', [repoKey]).map((row) => ({ workstream_run: sqlText(row, 'workstream_run', 'run', 192), status: sqlText(row, 'status', 'run', 32) }));
    const sessions = boundedDatabaseRows(database, 'session_leases', 'SELECT workstream_run, session_lease_id, status FROM session_leases WHERE repo_id=? ORDER BY workstream_run, session_generation', [repoKey]).map((row) => ({ workstream_run: sqlText(row, 'workstream_run', 'session lease', 192), session_lease_id: sqlText(row, 'session_lease_id', 'session lease', 192), status: sqlText(row, 'status', 'session lease', 32) }));
    const children = boundedDatabaseRows(database, 'child_leases', 'SELECT workstream_run, child_lease_id, status FROM child_leases WHERE repo_id=? ORDER BY workstream_run, unit_id, attempt', [repoKey]).map((row) => ({ workstream_run: sqlText(row, 'workstream_run', 'child lease', 192), child_lease_id: sqlText(row, 'child_lease_id', 'child lease', 192), status: sqlText(row, 'status', 'child lease', 32) }));
    const attempts = boundedDatabaseRows(database, 'unit_attempts', 'SELECT payload_json FROM unit_attempts WHERE repo_id=? ORDER BY workstream_run, entity_id', [repoKey]).map((row, index) => parseCoordinationUnitAttempt(parseDatabasePayload(row, 'payload_json', `unit attempt ${String(index)}`)));
    const editLeases = boundedDatabaseRows(database, 'edit_leases', 'SELECT payload_json FROM edit_leases WHERE repo_id=? ORDER BY workstream_run, entity_id', [repoKey]).map((row, index) => parseCoordinationEditLease(parseDatabasePayload(row, 'payload_json', `edit lease ${String(index)}`)));
    const worktreeOperations = boundedDatabaseRows(database, 'worktree_operations', 'SELECT payload_json FROM worktree_operations WHERE repo_id=? ORDER BY workstream_run, entity_id', [repoKey]).map((row, index) => parseCoordinationWorktreeOperation(parseDatabasePayload(row, 'payload_json', `worktree operation ${String(index)}`)));
    const globalDrainBlockers: string[] = [];
    for (const row of boundedDatabaseRows(database, 'session_leases', "SELECT repo_id, workstream_run, session_lease_id, status FROM session_leases WHERE status IN ('attached','handoff-pending') ORDER BY repo_id, workstream_run, session_generation")) globalDrainBlockers.push(`coordinator session has not durably drained: ${sqlText(row, 'repo_id', 'session lease', 192)}:${sqlText(row, 'workstream_run', 'session lease', 192)}:${sqlText(row, 'session_lease_id', 'session lease', 192)}`);
    for (const row of boundedDatabaseRows(database, 'child_leases', "SELECT repo_id, workstream_run, child_lease_id, status FROM child_leases WHERE status IN ('preflight','starting','running','recovery-required') ORDER BY repo_id, workstream_run, unit_id, attempt")) globalDrainBlockers.push(`coordinator child has not durably drained: ${sqlText(row, 'repo_id', 'child lease', 192)}:${sqlText(row, 'workstream_run', 'child lease', 192)}:${sqlText(row, 'child_lease_id', 'child lease', 192)}`);
    const globalAttempts = boundedDatabaseRows(database, 'unit_attempts', 'SELECT payload_json FROM unit_attempts ORDER BY repo_id, workstream_run, entity_id').map((row, index) => parseCoordinationUnitAttempt(parseDatabasePayload(row, 'payload_json', `global unit attempt ${String(index)}`)));
    for (const attempt of globalAttempts) if (attempt.critical_section !== null) globalDrainBlockers.push(`coordinator attempt remains in an incompatible critical section: ${attempt.owner.repo_id}:${attempt.owner.workstream_run}:${stableJson(attempt.critical_section)}`);
    const globalOperations = boundedDatabaseRows(database, 'worktree_operations', 'SELECT payload_json FROM worktree_operations ORDER BY repo_id, workstream_run, entity_id').map((row, index) => parseCoordinationWorktreeOperation(parseDatabasePayload(row, 'payload_json', `global worktree operation ${String(index)}`)));
    for (const operation of globalOperations) if (!['committed', 'compensated', 'failed'].includes(operation.stage)) globalDrainBlockers.push(`coordinator worktree operation critical section is incomplete: ${operation.owner.repo_id}:${operation.owner.workstream_run}:${operation.operation_id}:${operation.stage}`);
    let migration: ReadonlyCoordinatorMigration | null = null;
    if (schemaVersion >= 7) {
      const migrationRows = boundedDatabaseRows(database, 'coordination_migrations', 'SELECT migration_id, snapshot_sha256, state, report_json FROM coordination_migrations WHERE repo_id=?', [repoKey]);
      if (migrationRows.length > 1) failure('blocked', 'coordinator migration record cardinality is invalid');
      const migrationRow = migrationRows[0];
      if (migrationRow !== undefined) {
        const snapshot = sqlText(migrationRow, 'snapshot_sha256', 'coordination migration', 71);
        if (!DIGEST.test(snapshot)) failure('blocked', 'coordinator migration snapshot digest is invalid');
        const migrationState = sqlText(migrationRow, 'state', 'coordination migration', 32);
        if (!['imported', 'verified', 'cutover-ready', 'cutover-committed', 'legacy-archived'].includes(migrationState)) failure('blocked', 'coordinator migration state is invalid');
        migration = { migration_id: sqlText(migrationRow, 'migration_id', 'coordination migration', 192), snapshot_sha256: snapshot as `sha256:${string}`, state: migrationState as CoordinationMigrationRecordState, report: parseDatabasePayload(migrationRow, 'report_json', 'coordination migration') };
      }
    }
    database.exec('ROLLBACK');
    return { schemaVersion, repositories: Object.freeze(repositories), runs: Object.freeze(runs), sessions: Object.freeze(sessions), children: Object.freeze(children), attempts: Object.freeze(attempts), editLeases: Object.freeze(editLeases), worktreeOperations: Object.freeze(worktreeOperations), globalDrainBlockers: Object.freeze(globalDrainBlockers.sort()), migration };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* The disposable read-only connection is being closed fail-closed. */ }
    throw error;
  } finally {
    try {
      database.close();
      assertCoordinatorDatabaseSourceStable(copied.source);
    } finally { rmSync(copied.root, { recursive: true, force: true }); }
  }
}

function repositoryIdentityFromRoot(repoRoot: string, repoKey: string): MigrationRepositoryIdentity {
  if (!isAbsolute(repoRoot) || !existsSync(repoRoot) || lstatSync(repoRoot).isSymbolicLink()) failure('blocked', 'migration repository root must be an existing canonical non-symbolic directory', [repoRoot]);
  const identity = resolveRepoIdentity(repoRoot);
  if (identity.repoKey !== repoKey) failure('blocked', 'canonical --repo-root does not match the requested repository key', [repoRoot, `expected=${repoKey}`, `actual=${identity.repoKey}`]);
  return { canonical_root: realpathSync(identity.repoRoot), git_common_dir: realpathSync(identity.gitCommonDir) };
}

function resolveMigrationRepositoryIdentity(paths: CoordinatorRuntimePaths, repoKey: string, repoRoot: string | undefined, coordinator: ReadonlyCoordinatorInspection | null, rows?: readonly ActiveAutopilotRow[]): MigrationRepositoryIdentity {
  const candidates: MigrationRepositoryIdentity[] = [];
  if (repoRoot !== undefined) candidates.push(repositoryIdentityFromRoot(repoRoot, repoKey));
  const legacyRows = rows ?? parseLegacyActiveAutopilots(parseJsonFile(join(paths.stateRoot, 'coordination', repoKey, 'active-autopilots.json'), []));
  if (legacyRows.length > 0) {
    const first = legacyRows[0];
    if (first === undefined) failure('blocked', 'legacy repository identity is unavailable');
    candidates.push({ canonical_root: realpathSync(first.source_repo), git_common_dir: realpathSync(first.git_common_dir) });
  }
  for (const row of coordinator?.repositories ?? []) {
    if (row.repo_id !== repoKey || row.repo_key !== repoKey) failure('blocked', 'coordinator repository identity does not match migration key');
    candidates.push({ canonical_root: realpathSync(row.canonical_root), git_common_dir: realpathSync(row.git_common_dir) });
  }
  const first = candidates[0];
  if (first === undefined) failure('blocked', 'empty legacy migration requires canonical --repo-root or an existing coordinator repository identity');
  for (const candidate of candidates.slice(1)) if (candidate.canonical_root !== first.canonical_root || candidate.git_common_dir !== first.git_common_dir) failure('blocked', 'legacy, explicit, and coordinator repository identities disagree', [stableJson(first), stableJson(candidate)]);
  const verified = repositoryIdentityFromRoot(first.canonical_root, repoKey);
  if (verified.git_common_dir !== first.git_common_dir) failure('blocked', 'migration repository Git common-dir identity changed', [first.git_common_dir, verified.git_common_dir]);
  return verified;
}

function inspectLegacy(paths: CoordinatorRuntimePaths, repoKey: string, repository: MigrationRepositoryIdentity): LegacyInspection {
  const coordinationRoot = join(paths.stateRoot, 'coordination', repoKey);
  const worktreeRoot = join(paths.stateRoot, 'worktrees', repoKey);
  const rows = parseLegacyActiveAutopilots(parseJsonFile(join(coordinationRoot, 'active-autopilots.json'), []));
  const claims = parseLegacyPathClaims(parseJsonFile(join(coordinationRoot, 'path-claims.json'), []));
  const findings = checkLegacyCoordinationInvariants({ repoKey, rows, claims });
  const auditRows: CoordinationMigrationAuditInput[] = [
    ...parseJsonl(join(coordinationRoot, 'claim-events.jsonl'), 'claim-event', 'autopilot.claim_event.v1'),
    ...parseJsonl(join(coordinationRoot, 'merge-log.jsonl'), 'merge-event', 'autopilot.merge_event.v1'),
    ...parseJsonl(join(coordinationRoot, 'foreign-merge-acks.jsonl'), 'foreign-merge-ack', 'autopilot.foreign_merge_ack.v1'),
    ...parseJsonl(join(worktreeRoot, '_ledger.jsonl'), 'worktree-ledger', 'autopilot.worktree_ledger.v1'),
  ];
  const terminalizedRuns = ledgerTerminalizedRuns(rows, auditRows);
  const runtimeRunStatuses = readRuntimeRunStatuses(rows);
  const unitMetadata = readUnitMetadata(rows);
  const mergeEvidence = readLegacyMergeEvidence(rows);
  const index = parseWorktreeIndex(join(worktreeRoot, '_index.json'));
  const terminalEvidence = readLegacyTerminalEvidence(rows, claims, unitMetadata, index);
  const blockers = findings.filter((finding) => finding.severity === 'error').map((finding) => `${finding.code}: ${finding.detail}`);
  blockers.push(...inspectGit(rows, terminalizedRuns), ...mergeEvidence.blockers);
  for (const run of unitMetadata.missingTaskInfoRuns) {
    const row = rows.find((candidate) => candidate.workstream_run === run);
    if (row !== undefined && row.status !== 'closed' && !terminalizedRuns.has(run)) blockers.push(`live run task metadata is missing and requires recovery: ${run}`);
  }
  const rowRuns = new Set(rows.map((row) => row.workstream_run));
  for (const indexed of index.filter((entry) => entry.status === 'active')) if (!rowRuns.has(indexed.workstream_run)) blockers.push(`active worktree index row has no durable run owner: ${indexed.workstream_run}`);
  const sourceEntries = snapshotEntries(paths.stateRoot, sourcePaths(paths.stateRoot, repoKey, rows, unitMetadata, mergeEvidence.merges, terminalEvidence.paths));
  const gitSnapshot = captureGitSnapshot(rows, repository);
  const terminalLeakKeys = new Set<string>();
  const recovery: CoordinationMigrationRecoveryInput[] = [];
  let reboundCount = 0;
  for (const claim of claims) {
    const owner = rows.find((row) => row.workstream_run === claim.workstream_run && row.autopilot_id === claim.autopilot_id);
    if (owner === undefined) {
      blockers.push(`legacy claim has no valid durable owner and cannot be discarded: ${claim.workstream_run}:${claim.unit_id}:${String(claim.attempt)}:${claim.path}`);
      recovery.push({ recovery_id: entityId('recovery', `invalid-owner\0${claimKey(claim)}`), workstream_run: claim.workstream_run, recovery_type: 'ambiguous-live-claim', detail: { claim_path: claim.path, claim_mode: claim.claim_type, unit_id: claim.unit_id, attempt: claim.attempt, edit_lease_id: entityId('migration-lease', claimKey(claim)), owner_status: 'missing', reason: 'legacy claim owner is invalid; migration is blocked and authority remains in legacy truth' } });
      continue;
    }
    if (claim.active_run_epoch !== owner.active_run_epoch) reboundCount += 1;
    const metadata = unitMetadata.by_attempt.get(attemptKey(claim.workstream_run, claim.unit_id, claim.attempt));
    const acceptedMerge = mergeEvidence.merges.some((entry) => entry.merge.workstream_run === claim.workstream_run && entry.merge.autopilot_id === claim.autopilot_id && entry.merge.unit_id === claim.unit_id && entry.merge.attempt === claim.attempt && entry.merge.changed_paths.some((changedPath) => pathOverlapsOrContains(claim.path, changedPath)));
    const attemptProof = terminalEvidence.attemptProof.get(attemptKey(claim.workstream_run, claim.unit_id, claim.attempt));
    const merge = mergeEvidence.merges.find((entry) => entry.merge.workstream_run === claim.workstream_run && entry.merge.autopilot_id === claim.autopilot_id && entry.merge.unit_id === claim.unit_id && entry.merge.attempt === claim.attempt && entry.merge.changed_paths.some((changedPath) => pathOverlapsOrContains(claim.path, changedPath)));
    let mergeExactGitObjects: readonly string[] = [];
    let mergeFilesystemPostconditions: readonly string[] = [];
    if (merge !== undefined) {
      mergeExactGitObjects = Object.freeze([merge.merge.integration_before, merge.merge.integration_after, merge.merge.merge_commit_sha, merge.merge.unit_head]);
      mergeFilesystemPostconditions = Object.freeze([`main-worktree-contains:${merge.merge.integration_after}`]);
    }
    const mergeProof: TerminalProof | null = acceptedMerge && merge !== undefined ? { source: 'unit-merge', mechanical_proof: 'accepted-unit-merge', evidence_ref: merge.ref, evidence_sha256: merge.sha256, exact_git_objects: mergeExactGitObjects, filesystem_postconditions: mergeFilesystemPostconditions } : null;
    const readProof = claim.claim_type === 'READ' ? terminalEvidence.readProof.get(attemptKey(claim.workstream_run, claim.unit_id, claim.attempt)) : undefined;
    const terminalProof = mergeProof ?? terminalEvidence.runProof.get(claim.workstream_run) ?? readProof ?? (metadata?.status === 'aborted' && attemptProof?.source === 'attempt-reset' ? attemptProof : metadata?.status === 'quarantined' && attemptProof?.source === 'quarantine-capture' ? attemptProof : null);
    if (terminalProof !== null) {
      terminalLeakKeys.add(claimKey(claim));
      auditRows.push({ audit_id: entityId('terminal-release', claimKey(claim)), source_kind: 'claim-event', payload: { schema_version: 'autopilot.migration_terminal_release.v1', repo_key: repoKey, workstream_run: claim.workstream_run, autopilot_id: claim.autopilot_id, unit_id: claim.unit_id, attempt: claim.attempt, path: claim.path, claim_type: claim.claim_type, mechanical_proof: terminalProof.mechanical_proof, evidence_source: terminalProof.source, evidence_ref: terminalProof.evidence_ref, evidence_sha256: terminalProof.evidence_sha256, ...(terminalProof.supporting_evidence === undefined ? {} : { supporting_evidence: terminalProof.supporting_evidence }), exact_git_objects: terminalProof.exact_git_objects, filesystem_postconditions: terminalProof.filesystem_postconditions, released_from_active_import: true } });
    } else if (owner.status === 'closed' || metadata === undefined || metadata.status !== 'active' || unitMetadata.orphanAttempts.has(attemptKey(claim.workstream_run, claim.unit_id, claim.attempt))) {
      recovery.push({ recovery_id: entityId('recovery', `ambiguous\0${claimKey(claim)}`), workstream_run: claim.workstream_run, recovery_type: 'ambiguous-live-claim', detail: { claim_path: claim.path, claim_mode: claim.claim_type, unit_id: claim.unit_id, attempt: claim.attempt, edit_lease_id: entityId('migration-lease', claimKey(claim)), owner_status: owner.status, reason: 'legacy terminal status lacks independently verified immutable release evidence; authority is preserved pending supervisor recovery' } });
    }
  }
  const frozenBlockers = Object.freeze([...new Set(blockers)].sort());
  const frozenRecovery = Object.freeze(recovery);
  const audit = Object.freeze(auditRows);
  return { rows, claims, unitMetadata, worktreeIndex: index, sourceEntries, gitSnapshot, audit, merges: mergeEvidence.merges, terminalEvidence, blockers: frozenBlockers, recovery: frozenRecovery, terminalLeakKeys, equivalentClaimKeys: new Set<string>(), reboundCount, totalBytes: sourceEntries.reduce((sum, entry) => sum + entry.size_bytes, 0), ledgerTerminalizedRuns: terminalizedRuns, runtimeRunStatuses };
}

function reconcileMixedCoordinatorAuthority(coordinator: ReadonlyCoordinatorInspection | null, inspection: LegacyInspection): LegacyInspection {
  if (coordinator === null) return inspection;
  const equivalent = new Set<string>();
  const recovery = [...inspection.recovery];
  const blockers = [...inspection.blockers];
  for (const claim of inspection.claims) {
    if (inspection.terminalLeakKeys.has(claimKey(claim))) continue;
    const run = coordinator.runs.find((candidate) => candidate.workstream_run === claim.workstream_run);
    if (run === undefined) continue;
    const leases = coordinator.editLeases.filter((lease) => lease.owner.workstream_run === claim.workstream_run);
    const exact = leases.find((lease) => lease.owner.unit_id === claim.unit_id && lease.owner.attempt === claim.attempt && lease.path === claim.path && lease.mode === claim.claim_type);
    if (exact !== undefined) { equivalent.add(claimKey(claim)); continue; }
    const attempt = coordinator.attempts.find((candidate) => candidate.owner.workstream_run === claim.workstream_run && candidate.owner.unit_id === claim.unit_id && candidate.owner.attempt === claim.attempt);
    const terminalRun = run.status === 'closed' || run.status === 'aborted';
    const terminalAttempt = ['transport-complete', 'merged', 'failed', 'reset', 'quarantined', 'superseded'].includes(String(attempt?.state));
    if (terminalRun || terminalAttempt) {
      const recoveryId = entityId('recovery', `mixed-terminal\0${claimKey(claim)}`);
      if (!recovery.some((entry) => entry.recovery_id === recoveryId)) recovery.push({ recovery_id: recoveryId, workstream_run: claim.workstream_run, recovery_type: 'ambiguous-live-claim', detail: { claim_path: claim.path, claim_mode: claim.claim_type, unit_id: claim.unit_id, attempt: claim.attempt, edit_lease_id: entityId('migration-lease', claimKey(claim)), owner_status: String(run['status']), reason: 'coordinator terminal state lacks accepted exact migration terminal evidence; authority remains fenced pending supervisor recovery' } });
    }
    const conflicting = leases.filter((lease) => lease.path === claim.path && (lease.mode !== 'READ' || claim.claim_type !== 'READ'));
    if (conflicting.length > 0) blockers.push(`legacy claim conflicts with non-equivalent coordinator authority and cannot be discarded: ${claim.workstream_run}:${claim.unit_id}:${String(claim.attempt)}:${claim.path}`);
  }
  return { ...inspection, equivalentClaimKeys: equivalent, recovery: Object.freeze(recovery), blockers: Object.freeze([...new Set(blockers)].sort()) };
}

function readFreezeAcknowledgements(stateRoot: string, migrationPaths: CoordinationMigrationPaths): readonly CoordinationFreezeAcknowledgement[] {
  assertMigrationPathSafe(stateRoot, migrationPaths.freezeAckRoot, 'migration freeze acknowledgement root');
  if (!existsSync(migrationPaths.freezeAckRoot)) return [];
  const acknowledgements: CoordinationFreezeAcknowledgement[] = [];
  for (const entry of readdirSync(migrationPaths.freezeAckRoot, { withFileTypes: true })) {
    const path = join(migrationPaths.freezeAckRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) failure('blocked', 'freeze acknowledgement root contains a non-regular entry', [path]);
    assertMigrationPathSafe(stateRoot, path, 'migration freeze acknowledgement');
    const row = object(parseJsonFile(path, null), path, ['acknowledged_at', 'boot_id', 'client_kind', 'critical_section', 'database_schema_version', 'drain_state', 'freeze_token', 'migration_id', 'package_build', 'pid', 'protocol_version', 'repo_key', 'schema_version']);
    if (row['schema_version'] !== COORDINATION_FREEZE_ACK_SCHEMA || row['client_kind'] !== 'legacy-package-client' || row['drain_state'] !== 'dispatch-stopped' || row['critical_section'] !== null || typeof row['pid'] !== 'number' || !Number.isSafeInteger(row['pid']) || typeof row['boot_id'] !== 'string' || typeof row['acknowledged_at'] !== 'string') failure('blocked', 'freeze acknowledgement has an invalid closed contract', [path]);
    acknowledgements.push({
      schema_version: COORDINATION_FREEZE_ACK_SCHEMA,
      repo_key: boundedString(row['repo_key'], `${path}.repo_key`, 192),
      migration_id: boundedString(row['migration_id'], `${path}.migration_id`, 192),
      freeze_token: boundedString(row['freeze_token'], `${path}.freeze_token`, 128),
      client_kind: 'legacy-package-client',
      pid: row['pid'],
      boot_id: row['boot_id'],
      package_build: boundedString(row['package_build'], `${path}.package_build`, 128),
      protocol_version: boundedString(row['protocol_version'], `${path}.protocol_version`, 32),
      database_schema_version: integer(row['database_schema_version'], `${path}.database_schema_version`, 1),
      drain_state: 'dispatch-stopped',
      critical_section: null,
      acknowledged_at: row['acknowledged_at'],
    });
  }
  return Object.freeze(acknowledgements);
}

function legacyDrainBlockers(paths: CoordinatorRuntimePaths, migrationPaths: CoordinationMigrationPaths, journal: CoordinationMigrationJournal | null, rows: readonly ActiveAutopilotRow[]): readonly string[] {
  const acknowledgements = journal === null ? [] : readFreezeAcknowledgements(paths.stateRoot, migrationPaths);
  const blockers: string[] = [];
  for (const row of rows) {
    if (row.status === 'closed' || row.boot_id !== currentBootId() || !isProcessAlive(row.pid)) continue;
    if (journal === null) { blockers.push(`reachable legacy client requires bounded freeze acknowledgement and drain: ${row.workstream_run} pid=${String(row.pid)}`); continue; }
    const exact = acknowledgements.find((ack) => ack.pid === row.pid && ack.boot_id === row.boot_id && ack.repo_key === journal.repo_key && ack.migration_id === journal.migration_id && ack.freeze_token === journal.freeze_token);
    if (exact === undefined) { blockers.push(`reachable legacy client has not durably acknowledged the bounded migration freeze: ${row.workstream_run} pid=${String(row.pid)}`); continue; }
    if (exact.package_build !== COORDINATOR_PACKAGE_BUILD || exact.protocol_version !== AUTOPILOT_COORDINATOR_PROTOCOL_VERSION || exact.database_schema_version !== COORDINATOR_DATABASE_SCHEMA_VERSION || exact.drain_state !== 'dispatch-stopped' || exact.critical_section !== null) blockers.push(`reachable legacy client is incompatible with migration freeze/drain protocol: ${row.workstream_run} pid=${String(row.pid)}`);
  }
  return Object.freeze(blockers.sort());
}

function coordinatorDrainBlockers(coordinator: ReadonlyCoordinatorInspection | null): readonly string[] {
  return coordinator?.globalDrainBlockers ?? [];
}

function runStatus(row: ActiveAutopilotRow, recoveryRuns: ReadonlySet<string>, terminalizedRuns: ReadonlySet<string>, runtimeStatuses: ReadonlyMap<string, CoordinationRunStatus>): CoordinationRunStatus {
  if (row.status === 'closed' || terminalizedRuns.has(row.workstream_run)) return 'closed';
  if (row.status === 'crashed' || recoveryRuns.has(row.workstream_run)) return 'recovering';
  const runtimeStatus = runtimeStatuses.get(row.workstream_run);
  if (runtimeStatus !== undefined) return runtimeStatus;
  return row.status === 'active' ? 'paused' : row.status;
}

function buildImportPlan(inspection: LegacyInspection, repositoryIdentity: MigrationRepositoryIdentity, repoKey: string, migrationId: string, snapshotSha: `sha256:${string}`, journalPath: string, report: CoordinationMigrationReport): CoordinationLegacyImportPlan {
  const repository: CoordinationRepository = { schema_version: 'autopilot.coordination_repository.v1', repo_id: repoKey, repo_key: repoKey, canonical_root: repositoryIdentity.canonical_root, git_common_dir: repositoryIdentity.git_common_dir, created_event_seq: 1, version: 1 };
  for (const row of inspection.rows) if (realpathSync(row.source_repo) !== repositoryIdentity.canonical_root || realpathSync(row.git_common_dir) !== repositoryIdentity.git_common_dir) failure('blocked', 'legacy rows disagree on repository identity');
  const recoveryRuns = new Set(inspection.recovery.map((entry) => entry.workstream_run));
  const runs: CoordinationRun[] = inspection.rows.map((row) => ({ schema_version: 'autopilot.coordination_run.v1', repo_id: repoKey, autopilot_id: row.autopilot_id, workstream: row.workstream, workstream_run: row.workstream_run, coordination_authority: 'coordinator-edit-leases-v1', status: runStatus(row, recoveryRuns, inspection.ledgerTerminalizedRuns, inspection.runtimeRunStatuses), active_session_generation: 0, created_event_seq: 1, version: 1 }));
  const runResources: CoordinationRunResource[] = inspection.rows.map((row) => ({
    schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoKey, workstream_run: row.workstream_run,
    source_repo: row.source_repo, git_common_dir: row.git_common_dir, worktree_root: row.worktree_root,
    main_worktree_path: row.main_worktree_path, runtime_root: row.runtime_root, branch: row.branch,
    target_branch: row.target_branch, target_base_sha: row.target_base_sha, origin_url: row.origin_url,
    started_at: row.started_at, version: 1,
  }));
  const liveClaims = inspection.claims.filter((claim) => !inspection.terminalLeakKeys.has(claimKey(claim)));
  const terminalReleases = inspection.claims.filter((claim) => inspection.terminalLeakKeys.has(claimKey(claim))).map((claim) => {
    const row = inspection.rows.find((candidate) => candidate.workstream_run === claim.workstream_run && candidate.autopilot_id === claim.autopilot_id);
    const audit = inspection.audit.find((candidate) => candidate.audit_id === entityId('terminal-release', claimKey(claim)));
    if (row === undefined || audit === undefined || typeof audit.payload['evidence_ref'] !== 'string' || typeof audit.payload['evidence_sha256'] !== 'string' || !DIGEST.test(audit.payload['evidence_sha256'])) failure('blocked', 'terminal claim release lacks exact retained migration evidence identity', [claimKey(claim)]);
    return { owner: { repo_id: repoKey, autopilot_id: row.autopilot_id, workstream_run: row.workstream_run, unit_id: claim.unit_id, attempt: claim.attempt }, path: claim.path, mode: claim.claim_type, evidence_ref: audit.payload['evidence_ref'], evidence_sha256: audit.payload['evidence_sha256'] as `sha256:${string}` };
  });
  const grouped = new Map<string, AutopilotPathClaim[]>();
  for (const claim of liveClaims) {
    const key = attemptKey(claim.workstream_run, claim.unit_id, claim.attempt);
    grouped.set(key, [...(grouped.get(key) ?? []), claim]);
  }
  const attempts: CoordinationUnitAttempt[] = [];
  const groups: CoordinationAcquisitionGroup[] = [];
  const leases: CoordinationEditLease[] = [];
  for (const [key, claims] of grouped) {
    const claim = claims[0];
    if (claim === undefined) continue;
    const row = inspection.rows.find((entry) => entry.workstream_run === claim.workstream_run && entry.autopilot_id === claim.autopilot_id);
    if (row === undefined) failure('blocked', 'live migration claim has no valid durable owner', [key]);
    const metadata = inspection.unitMetadata.by_attempt.get(key);
    const owner = { repo_id: repoKey, autopilot_id: row.autopilot_id, workstream_run: row.workstream_run, unit_id: claim.unit_id, attempt: claim.attempt };
    const specSha = digest(new TextEncoder().encode(`${snapshotSha}\0${key}`));
    const pendingRecovery = inspection.recovery.some((entry) => entry.workstream_run === claim.workstream_run && entry.detail['unit_id'] === claim.unit_id && entry.detail['attempt'] === claim.attempt);
    const importedAttemptState: CoordinationUnitAttempt['state'] = pendingRecovery ? 'queued' : metadata === undefined ? 'queued' : metadata.status === 'active' ? 'running' : metadata.status === 'merged' ? 'merged' : metadata.status === 'aborted' ? 'reset' : metadata.status === 'quarantined' ? 'quarantined' : 'superseded';
    attempts.push({ schema_version: 'autopilot.unit_attempt.v1', owner, state: importedAttemptState, role: 'unknown', spec: { ref: `migration/${migrationId}/legacy-attempt/${entityId('attempt', key)}.json`, sha256: specSha }, preemptible: claims.every((entry) => entry.claim_type === 'READ'), checkpoint_ordinal: 0, critical_section: null, version: 1 });
    const groupId = entityId('migration-group', key);
    const requested = claims.map((entry) => ({ path: entry.path, mode: entry.claim_type, purpose: entry.reason, ...(entry.claim_type === 'EXCLUSIVE' ? { exclusive_operation: legacyMigrationExclusiveOperation(entityId('legacy-exclusive', claimKey(entry))) } : {}) })).sort((left, right) => `${left.mode}\0${left.path}`.localeCompare(`${right.mode}\0${right.path}`));
    const condition = !pendingRecovery && claims.some((entry) => entry.claim_type === 'WRITE' || entry.claim_type === 'EXCLUSIVE')
      ? { condition_type: 'unit-merged' as const, target_id: `${claim.unit_id}:${String(claim.attempt)}`, evidence: null }
      : { condition_type: 'explicit-owner-release' as const, target_id: `${claim.unit_id}:${String(claim.attempt)}`, evidence: null };
    groups.push({ schema_version: 'autopilot.acquisition_group.v2', acquisition_group_id: groupId, owner, acquisition_kind: 'legacy-unknown', requested_leases: requested, reason: 'verified legacy path authority import', normal_release_condition: condition, state: 'granted', created_event_seq: 1, fairness_event_seq: 1, grant_event_seq: 1, offer_expires_at: null, offer_count: 0, bypass_count: 0, version: 1 });
    for (const entry of claims) leases.push({ schema_version: 'autopilot.edit_lease.v1', edit_lease_id: entityId('migration-lease', claimKey(entry)), owner, acquisition_group_id: groupId, path: entry.path, mode: entry.claim_type, purpose: entry.reason, ...(entry.claim_type === 'EXCLUSIVE' ? { exclusive_operation: legacyMigrationExclusiveOperation(entityId('legacy-exclusive', claimKey(entry))) } : {}), acquired_event_seq: 1, normal_release_condition: condition, version: 1 });
  }
  const reconciliationEvidence: CoordinationReconciliationEvidence[] = [];
  const reservations: CoordinationChangeReservation[] = [];
  const orderedMerges = inspection.merges.filter((entry) => inspection.rows.some((row) => row.workstream_run === entry.merge.workstream_run && row.status !== 'closed' && !inspection.ledgerTerminalizedRuns.has(row.workstream_run))).sort((left, right) => left.merge.merged_at.localeCompare(right.merge.merged_at) || left.path.localeCompare(right.path));
  for (const evidence of orderedMerges) {
    const acceptedRef = { ref: evidence.ref, sha256: evidence.sha256 };
    const targetId = `${evidence.merge.unit_id}:${String(evidence.merge.attempt)}`;
    reconciliationEvidence.push({ schema_version: 'autopilot.reconciliation_evidence.v1', reconciliation_evidence_id: entityId('migration-merge-evidence', evidence.path), repo_id: repoKey, autopilot_id: evidence.merge.autopilot_id, workstream_run: evidence.merge.workstream_run, source: 'unit-merge', release_condition: { condition_type: 'unit-merged', target_id: targetId, evidence: acceptedRef }, accepted_event_seq: 1, version: 1 });
    for (const changedPath of evidence.merge.changed_paths) reservations.push({ schema_version: 'autopilot.change_reservation.v1', reservation_id: entityId('migration-reservation', `${evidence.path}\0${changedPath}`), repo_id: repoKey, autopilot_id: evidence.merge.autopilot_id, workstream_run: evidence.merge.workstream_run, path: changedPath, merge_evidence: acceptedRef, created_event_seq: 1, released_event_seq: null, terminal_outcome: null, terminal_sha: null, version: 1 });
  }
  const obligations: CoordinationReservationObligation[] = [];
  for (let dependentIndex = 0; dependentIndex < reservations.length; dependentIndex += 1) {
    const dependent = reservations[dependentIndex];
    if (dependent === undefined) continue;
    for (let predecessorIndex = 0; predecessorIndex < dependentIndex; predecessorIndex += 1) {
      const predecessor = reservations[predecessorIndex];
      if (predecessor === undefined || predecessor.workstream_run === dependent.workstream_run || !pathOverlapsOrContains(predecessor.path, dependent.path)) continue;
      obligations.push({ schema_version: 'autopilot.reservation_obligation.v1', obligation_id: entityId('migration-obligation', `${dependent.reservation_id}\0${predecessor.reservation_id}`), repo_id: repoKey, workstream_run: dependent.workstream_run, reservation_id: dependent.reservation_id, predecessor_reservation_id: predecessor.reservation_id, overlapping_paths: [dependent.path], integration_conflict: legacyConservativeIntegrationConflict(entityId('migration-obligation', `${dependent.reservation_id}\0${predecessor.reservation_id}`), [dependent.path]), state: 'waiting-for-predecessor', created_event_seq: 1, predecessor_released_event_seq: null, predecessor_terminal_sha: null, integration_evidence: null, validation_evidence: null, resolved_event_seq: null, version: 1 });
    }
  }
  const worktrees: CoordinationWorktree[] = [];
  for (const row of inspection.rows) {
    const mainState: CoordinationWorktreeState = row.status === 'closed' || inspection.ledgerTerminalizedRuns.has(row.workstream_run) ? 'terminal' : existsSync(row.main_worktree_path) ? 'active' : 'dirty';
    const mainOwner = { repo_id: repoKey, autopilot_id: row.autopilot_id, workstream_run: row.workstream_run, unit_id: 'main', attempt: 1 } as const;
    worktrees.push({ schema_version: 'autopilot.coordination_worktree.v2', worktree_id: deterministicWorktreeId(mainOwner, 'main'), owner: mainOwner, kind: 'main', canonical_path: row.main_worktree_path, git_common_dir: row.git_common_dir, branch: row.branch, state: mainState, version: 1 });
    for (const unit of inspection.unitMetadata.worktrees.filter((entry) => isInside(dirname(row.main_worktree_path), entry.worktree_path))) {
      const state: CoordinationWorktreeState = unit.status === 'active' ? existsSync(unit.worktree_path) ? 'active' : 'dirty' : unit.status === 'quarantined' ? 'quarantined' : 'terminal';
      const unitOwner = { repo_id: repoKey, autopilot_id: row.autopilot_id, workstream_run: row.workstream_run, unit_id: unit.unit_id, attempt: unit.attempt } as const;
      worktrees.push({ schema_version: 'autopilot.coordination_worktree.v2', worktree_id: deterministicWorktreeId(unitOwner, 'unit'), owner: unitOwner, kind: 'unit', canonical_path: unit.worktree_path, git_common_dir: row.git_common_dir, branch: unit.branch, state, version: 1 });
    }
  }
  const frozenRuns = Object.freeze(runs);
  const frozenRunResources = Object.freeze(runResources);
  const frozenAttempts = Object.freeze(attempts);
  const frozenGroups = Object.freeze(groups);
  const frozenLeases = Object.freeze(leases);
  const frozenReservations = Object.freeze(reservations);
  const frozenObligations = Object.freeze(obligations);
  const frozenReconciliation = Object.freeze(reconciliationEvidence);
  const frozenWorktrees = Object.freeze(worktrees);
  const frozenTerminalReleases = Object.freeze(terminalReleases);
  return { migration_id: migrationId, snapshot_sha256: snapshotSha, journal_path: journalPath, repository, runs: frozenRuns, run_resources: frozenRunResources, unit_attempts: frozenAttempts, acquisition_groups: frozenGroups, edit_leases: frozenLeases, terminal_releases: frozenTerminalReleases, change_reservations: frozenReservations, reservation_obligations: frozenObligations, reconciliation_evidence: frozenReconciliation, worktrees: frozenWorktrees, recovery_work: inspection.recovery, legacy_audit: inspection.audit, report };
}

function baseReport(command: CoordinationMigrationCommand, repoKey: string, inspection: LegacyInspection, now: Date, state: CoordinationMigrationState, migrationId: string | null, snapshot: `sha256:${string}` | null, backupPath: string | null, markerPath: string | null): CoordinationMigrationReport {
  const liveClaims = inspection.claims.filter((claim) => !inspection.terminalLeakKeys.has(claimKey(claim)));
  const importedClaims = liveClaims.filter((claim) => !inspection.equivalentClaimKeys.has(claimKey(claim)));
  return Object.freeze({ schema_version: 'autopilot.coordination_migration_report.v1', command, repo_key: repoKey, migration_id: migrationId, state, dry_run: command === 'dry-run', source_file_count: inspection.sourceEntries.length, source_total_bytes: inspection.totalBytes, active_run_count: inspection.rows.length, legacy_claim_count: inspection.claims.length, classified_claim_count: liveClaims.length + inspection.terminalLeakKeys.size, equivalent_lease_count: inspection.equivalentClaimKeys.size, imported_run_count: inspection.rows.length, imported_attempt_count: new Set(importedClaims.map((claim) => attemptKey(claim.workstream_run, claim.unit_id, claim.attempt))).size, imported_lease_count: importedClaims.length, imported_reservation_count: inspection.merges.filter((entry) => inspection.rows.some((row) => row.workstream_run === entry.merge.workstream_run && row.status !== 'closed')).reduce((count, entry) => count + entry.merge.changed_paths.length, 0), imported_worktree_count: inspection.rows.length + inspection.unitMetadata.worktrees.length, imported_audit_count: inspection.audit.length, rebound_old_epoch_claim_count: inspection.reboundCount, terminal_leak_count: inspection.terminalLeakKeys.size, recovery_work_count: inspection.recovery.length, blockers: inspection.blockers, recovery: inspection.recovery.map((entry) => ({ recovery_id: entry.recovery_id, workstream_run: entry.workstream_run, recovery_type: entry.recovery_type, detail: entry.detail })), snapshot_sha256: snapshot, backup_path: backupPath, cutover_marker_path: markerPath, created_at: now.toISOString() });
}

function parseMigrationReport(value: unknown): CoordinationMigrationReport {
  const fields = ['active_run_count', 'backup_path', 'blockers', 'classified_claim_count', 'command', 'created_at', 'cutover_marker_path', 'dry_run', 'equivalent_lease_count', 'imported_attempt_count', 'imported_audit_count', 'imported_lease_count', 'imported_reservation_count', 'imported_run_count', 'imported_worktree_count', 'legacy_claim_count', 'migration_id', 'rebound_old_epoch_claim_count', 'recovery', 'recovery_work_count', 'repo_key', 'schema_version', 'snapshot_sha256', 'source_file_count', 'source_total_bytes', 'state', 'terminal_leak_count'];
  const row = object(value, 'migration report', fields);
  const command = boundedString(row['command'], 'migration report command', 16);
  const state = boundedString(row['state'], 'migration report state', 32);
  const commands: readonly CoordinationMigrationCommand[] = ['dry-run', 'apply', 'verify', 'rollback', 'cutover'];
  const states: readonly CoordinationMigrationState[] = ['planned', 'frozen', 'snapshotted', 'imported', 'verified', 'cutover-ready', 'cutover-committed', 'legacy-archived', 'rollback-restoring', 'rollback-restored', 'rollback-unfreezing', 'rolled-back'];
  if (row['schema_version'] !== 'autopilot.coordination_migration_report.v1' || !commands.includes(command as CoordinationMigrationCommand) || !states.includes(state as CoordinationMigrationState) || typeof row['dry_run'] !== 'boolean') failure('invalid', 'migration report discriminator is invalid');
  const nullableText = (field: 'backup_path' | 'cutover_marker_path' | 'migration_id'): string | null => row[field] === null ? null : boundedString(row[field], `migration report ${field}`);
  const snapshot = row['snapshot_sha256'];
  if (snapshot !== null && (typeof snapshot !== 'string' || !DIGEST.test(snapshot))) failure('invalid', 'migration report snapshot digest is invalid');
  const blockers = stringArray(row['blockers'], 'migration report blockers', 100_000);
  if (!Array.isArray(row['recovery']) || row['recovery'].length > 100_000) failure('invalid', 'migration report recovery must be a bounded array');
  const recovery = Object.freeze(row['recovery'].map((entry, index) => {
    const recoveryRow = object(entry, `migration report recovery ${String(index)}`, ['detail', 'recovery_id', 'recovery_type', 'workstream_run']);
    validateBoundedJson(recoveryRow['detail'], `migration report recovery ${String(index)} detail`);
    return { recovery_id: boundedString(recoveryRow['recovery_id'], 'recovery id', 192), workstream_run: boundedString(recoveryRow['workstream_run'], 'recovery run', 192), recovery_type: boundedString(recoveryRow['recovery_type'], 'recovery type', 64), detail: recoveryRow['detail'] };
  }));
  return {
    schema_version: 'autopilot.coordination_migration_report.v1', command: command as CoordinationMigrationCommand, repo_key: boundedString(row['repo_key'], 'migration report repo key', 192), migration_id: nullableText('migration_id'), state: state as CoordinationMigrationState, dry_run: row['dry_run'],
    source_file_count: integer(row['source_file_count'], 'source_file_count'), source_total_bytes: integer(row['source_total_bytes'], 'source_total_bytes'), active_run_count: integer(row['active_run_count'], 'active_run_count'), legacy_claim_count: integer(row['legacy_claim_count'], 'legacy_claim_count'), classified_claim_count: integer(row['classified_claim_count'], 'classified_claim_count'), equivalent_lease_count: integer(row['equivalent_lease_count'], 'equivalent_lease_count'), imported_run_count: integer(row['imported_run_count'], 'imported_run_count'), imported_attempt_count: integer(row['imported_attempt_count'], 'imported_attempt_count'), imported_lease_count: integer(row['imported_lease_count'], 'imported_lease_count'), imported_reservation_count: integer(row['imported_reservation_count'], 'imported_reservation_count'), imported_worktree_count: integer(row['imported_worktree_count'], 'imported_worktree_count'), imported_audit_count: integer(row['imported_audit_count'], 'imported_audit_count'), rebound_old_epoch_claim_count: integer(row['rebound_old_epoch_claim_count'], 'rebound_old_epoch_claim_count'), terminal_leak_count: integer(row['terminal_leak_count'], 'terminal_leak_count'), recovery_work_count: integer(row['recovery_work_count'], 'recovery_work_count'), blockers, recovery, snapshot_sha256: snapshot as `sha256:${string}` | null, backup_path: nullableText('backup_path'), cutover_marker_path: nullableText('cutover_marker_path'), created_at: boundedString(row['created_at'], 'migration report created_at', 64),
  };
}

function journalRecord(value: unknown, path: string): CoordinationMigrationJournal {
  const fields = ['backup_path', 'backup_sha256', 'completed_effects', 'created_at', 'database_existed_before', 'freeze_token', 'git_snapshot', 'migration_id', 'repo_key', 'report', 'repository_git_common_dir', 'repository_root', 'schema_version', 'snapshot_entries', 'snapshot_sha256', 'state', 'updated_at'];
  const row = object(value, 'migration journal', fields);
  if (row['schema_version'] !== COORDINATION_MIGRATION_JOURNAL_SCHEMA) failure('invalid', 'migration journal schema is invalid', [path]);
  const state = boundedString(row['state'], 'migration journal state', 32);
  const states: readonly CoordinationMigrationState[] = ['planned', 'frozen', 'snapshotted', 'imported', 'verified', 'cutover-ready', 'cutover-committed', 'legacy-archived', 'rollback-restoring', 'rollback-restored', 'rollback-unfreezing', 'rolled-back'];
  if (!states.includes(state as CoordinationMigrationState)) failure('invalid', 'migration journal state is invalid');
  const snapshot = row['snapshot_sha256'];
  const backupSha = row['backup_sha256'];
  if (snapshot !== null && (typeof snapshot !== 'string' || !DIGEST.test(snapshot))) failure('invalid', 'migration journal snapshot digest is invalid');
  if (backupSha !== null && (typeof backupSha !== 'string' || !DIGEST.test(backupSha))) failure('invalid', 'migration journal backup digest is invalid');
  if (!Array.isArray(row['snapshot_entries']) || row['snapshot_entries'].length > COORDINATION_MIGRATION_MAX_FILES || !Array.isArray(row['completed_effects']) || row['completed_effects'].some((entry) => typeof entry !== 'string')) failure('invalid', 'migration journal arrays are invalid');
  const report = parseMigrationReport(row['report']);
  const migrationId = boundedString(row['migration_id'], 'migration id', 192);
  const repoKey = boundedString(row['repo_key'], 'migration repo key', 192);
  const freezeToken = boundedString(row['freeze_token'], 'freeze token', 128);
  if (!ID.test(migrationId) || !ID.test(repoKey) || !/^[a-f0-9]{64}$/u.test(freezeToken)) failure('invalid', 'migration journal identity or freeze token is invalid');
  if (report.migration_id !== migrationId || report.repo_key !== repoKey || report.state !== state || report.snapshot_sha256 !== snapshot || report.backup_path !== (row['backup_path'] === null ? null : row['backup_path'])) failure('invalid', 'migration journal report disagrees with its durable envelope');
  const frozenEntries = Object.freeze(row['snapshot_entries'].map((entry, index) => parseSnapshotEntry(entry, index)));
  if (!Array.isArray(row['git_snapshot']) || row['git_snapshot'].length > 100_000) failure('invalid', 'migration journal Git snapshot is invalid');
  const gitSnapshot = Object.freeze(row['git_snapshot'].map((entry, index) => {
    const git = object(entry, `Git snapshot ${String(index)}`, ['main_branch', 'main_head', 'source_head', 'workstream_run']);
    return { workstream_run: boundedString(git['workstream_run'], 'Git snapshot run', 192), source_head: boundedString(git['source_head'], 'Git source HEAD', 128), main_head: git['main_head'] === null ? null : boundedString(git['main_head'], 'Git main HEAD', 128), main_branch: git['main_branch'] === null ? null : boundedString(git['main_branch'], 'Git main branch', 512) };
  }));
  const stateRoot = dirname(dirname(dirname(resolve(path))));
  const relativePaths = new Set<string>();
  for (const entry of frozenEntries) {
    const normalizedRelative = entry.relative_path.split('/').join(sep);
    if (isAbsolute(normalizedRelative) || normalizedRelative === '..' || normalizedRelative.startsWith(`..${sep}`) || relativePaths.has(entry.relative_path)) failure('invalid', 'migration journal snapshot path is escaped or duplicated', [entry.relative_path]);
    relativePaths.add(entry.relative_path);
    const derived = resolve(stateRoot, normalizedRelative);
    if (resolve(entry.source_path) !== derived || !isInside(stateRoot, derived)) failure('invalid', 'migration journal source path is not derived from its state-root relative path', [entry.source_path, entry.relative_path]);
  }
  if (snapshot !== null && aggregateDigest(frozenEntries, gitSnapshot) !== snapshot) failure('invalid', 'migration journal snapshot digest does not bind its parsed entries and Git snapshot');
  const frozenEffects = Object.freeze(row['completed_effects']);
  const repositoryRoot = boundedString(row['repository_root'], 'migration repository root');
  const repositoryGitCommonDir = boundedString(row['repository_git_common_dir'], 'migration repository Git common-dir');
  if (!isAbsolute(repositoryRoot) || !isAbsolute(repositoryGitCommonDir)) failure('invalid', 'migration journal repository identity must be absolute');
  return { schema_version: COORDINATION_MIGRATION_JOURNAL_SCHEMA, migration_id: migrationId, repo_key: repoKey, state: state as CoordinationMigrationState, freeze_token: freezeToken, created_at: boundedString(row['created_at'], 'created_at', 64), updated_at: boundedString(row['updated_at'], 'updated_at', 64), snapshot_sha256: snapshot as `sha256:${string}` | null, snapshot_entries: frozenEntries, git_snapshot: gitSnapshot, backup_path: row['backup_path'] === null ? null : boundedString(row['backup_path'], 'backup path'), backup_sha256: backupSha as `sha256:${string}` | null, database_existed_before: typeof row['database_existed_before'] === 'boolean' ? row['database_existed_before'] : failure('invalid', 'database_existed_before must be boolean'), repository_root: resolve(repositoryRoot), repository_git_common_dir: resolve(repositoryGitCommonDir), completed_effects: frozenEffects, report };
}

function parseSnapshotEntry(value: unknown, index: number): SnapshotEntry {
  const row = object(value, `snapshot entry ${String(index)}`, ['exists', 'relative_path', 'sha256', 'size_bytes', 'source_path']);
  const sha = boundedString(row['sha256'], 'snapshot entry sha256', 71);
  if (!DIGEST.test(sha) || typeof row['exists'] !== 'boolean') failure('invalid', 'snapshot entry digest or existence flag is invalid');
  return { source_path: boundedString(row['source_path'], 'snapshot source path'), relative_path: boundedString(row['relative_path'], 'snapshot relative path'), exists: row['exists'], size_bytes: integer(row['size_bytes'], 'snapshot size'), sha256: sha as `sha256:${string}` };
}

function fsyncParentDirectory(path: string): void {
  // Windows has no portable directory handle/fsync contract in Node. The file
  // itself is flushed before rename; Unix additionally flushes the containing
  // directory so the rename is durable. Do not catch/ignore Unix fsync errors.
  if (platform() === 'win32') return;
  const directory = openSync(dirname(path), fsConstants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function atomicJson(stateRoot: string, path: string, value: unknown, mode = 0o600): Promise<void> {
  assertMigrationPathSafe(stateRoot, path, 'migration atomic JSON destination');
  await ensurePrivateAuthorityDirectory(dirname(path));
  assertMigrationPathSafe(stateRoot, path, 'migration atomic JSON destination');
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) failure('blocked', 'migration atomic JSON destination is symbolic', [path]);
  const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`;
  const handle = await open(temporary, 'wx', mode);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await enforcePrivateAuthorityPath(temporary, false);
  assertMigrationPathSafe(stateRoot, temporary, 'migration atomic JSON temporary');
  assertMigrationPathSafe(stateRoot, path, 'migration atomic JSON destination');
  await rename(temporary, path);
  assertMigrationPathSafe(stateRoot, path, 'migration atomic JSON destination');
  if (platform() !== 'win32') await chmod(path, mode);
  else await enforcePrivateAuthorityPath(path, false);
  fsyncParentDirectory(path);
}

async function readJournal(stateRoot: string, path: string): Promise<CoordinationMigrationJournal | null> {
  assertMigrationPathSafe(stateRoot, path, 'migration journal');
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) failure('invalid', 'migration journal must be a regular non-symbolic file', [path]);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch { failure('invalid', 'migration journal is unreadable', [path]); }
  return journalRecord(parsed, path);
}

async function writeJournal(stateRoot: string, path: string, journal: CoordinationMigrationJournal): Promise<void> { await atomicJson(stateRoot, path, journal); }

function sameFileIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseMigrationLockBytes(bytes: Uint8Array, label: string): { readonly pid: number; readonly bootId: string; readonly token: string } {
  let parsed: unknown;
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); assertNoDuplicateJsonKeys(text, label); parsed = JSON.parse(text) as unknown; }
  catch (error) {
    if (error instanceof CoordinationRuntimeError) throw error;
    failure('blocked', `${label} is unreadable; stale ownership cannot be proved`);
  }
  const row = object(parsed, label, ['boot_id', 'created_at', 'pid', 'schema_version', 'token']);
  if (row['schema_version'] !== 'autopilot.coordination_migration_lock.v1' || typeof row['pid'] !== 'number' || !Number.isSafeInteger(row['pid']) || row['pid'] < 1 || typeof row['boot_id'] !== 'string' || typeof row['token'] !== 'string' || !/^[a-f0-9]{48}$/u.test(row['token']) || typeof row['created_at'] !== 'string') failure('blocked', `${label} has an invalid closed identity; reclamation is refused`);
  return { pid: row['pid'], bootId: row['boot_id'], token: row['token'] };
}

function migrationLockOwnerAlive(owner: { readonly pid: number; readonly bootId: string }): boolean {
  // Boot identity is supplementary evidence only. A live PID is never stale.
  return isProcessAlive(owner.pid);
}

function assertRegularMigrationLockResidue(stateRoot: string, path: string, label: string): ReturnType<typeof lstatSync> {
  assertMigrationPathSafe(stateRoot, path, label);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) failure('blocked', `${label} must be a regular non-symbolic file`, [path]);
  return info;
}

function unlinkExactMigrationLockResidue(path: string, identity: { readonly dev: number; readonly ino: number }, label: string): void {
  if (!existsSync(path) || !sameFileIdentity(lstatSync(path), identity)) failure('blocked', `${label} identity changed before cleanup`, [path]);
  unlinkSync(path);
}

/** Completes only identity-proved lock operations left by a dead process. */
function recoverMigrationLockResidues(stateRoot: string, path: string): void {
  const directory = dirname(path);
  const name = basename(path);
  const reclaimPath = `${path}.reclaim`;
  let mainIdentity = existsSync(path) ? assertRegularMigrationLockResidue(stateRoot, path, 'repository migration lock') : null;
  let changed = false;
  if (existsSync(reclaimPath)) {
    const reclaimIdentity = assertRegularMigrationLockResidue(stateRoot, reclaimPath, 'repository migration reclaim residue');
    const reclaimOwner = parseMigrationLockBytes(readFileSync(reclaimPath), 'repository migration reclaim residue');
    if (mainIdentity === null) {
      if (migrationLockOwnerAlive(reclaimOwner)) failure('blocked', 'live migration reclamation residue lost its elected pathname', [reclaimPath]);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.name.startsWith(`${name}.stale-${reclaimOwner.token}-`)) continue;
        const stalePath = join(directory, entry.name);
        const staleIdentity = assertRegularMigrationLockResidue(stateRoot, stalePath, 'stale migration lock quarantine residue');
        if (!sameFileIdentity(staleIdentity, reclaimIdentity)) failure('blocked', 'stale migration quarantine residue disagrees with its reclaim identity', [stalePath, reclaimPath]);
        unlinkExactMigrationLockResidue(stalePath, staleIdentity, 'stale migration lock quarantine residue');
      }
      unlinkExactMigrationLockResidue(reclaimPath, reclaimIdentity, 'stale migration reclaim residue');
      changed = true;
    } else if (!sameFileIdentity(mainIdentity, reclaimIdentity)) {
      if (migrationLockOwnerAlive(reclaimOwner)) failure('blocked', 'live migration reclaim residue conflicts with the elected lock identity', [path, reclaimPath]);
      unlinkExactMigrationLockResidue(reclaimPath, reclaimIdentity, 'stale migration reclaim residue');
      changed = true;
    }
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(`${name}.release-`) && !entry.name.startsWith(`${name}.released-`) && !entry.name.startsWith(`${name}.candidate-`) && !entry.name.startsWith(`${name}.stale-`)) continue;
    const residue = join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) failure('blocked', 'migration lock residue has an unsafe type', [residue]);
    const identity = assertRegularMigrationLockResidue(stateRoot, residue, 'migration lock crash residue');
    if (entry.name.startsWith(`${name}.candidate-`)) {
      const suffix = entry.name.slice(`${name}.candidate-`.length);
      const separator = suffix.indexOf('-');
      const candidatePid = separator < 1 ? null : Number(suffix.slice(0, separator));
      const candidateToken = separator < 1 ? '' : suffix.slice(separator + 1);
      if (candidatePid === null || !Number.isSafeInteger(candidatePid) || candidatePid < 1 || !/^[a-f0-9]{48}$/u.test(candidateToken)) failure('blocked', 'migration lock candidate residue name is invalid', [residue]);
      if (isProcessAlive(candidatePid)) continue;
      unlinkExactMigrationLockResidue(residue, identity, 'dead migration lock candidate residue');
      changed = true;
      continue;
    }
    const owner = parseMigrationLockBytes(readFileSync(residue), 'migration lock crash residue');
    if (migrationLockOwnerAlive(owner)) {
      if (mainIdentity === null) failure('blocked', 'live migration lock operation lost its elected pathname', [residue]);
      if (!sameFileIdentity(mainIdentity, identity) && entry.name.startsWith(`${name}.release-`)) failure('blocked', 'live migration release residue disagrees with the elected lock identity', [residue]);
      continue;
    }
    if (entry.name.startsWith(`${name}.release-`) && mainIdentity !== null && sameFileIdentity(mainIdentity, identity)) {
      unlinkExactMigrationLockResidue(path, mainIdentity, 'crash-resumed migration lock release');
      mainIdentity = null;
    }
    unlinkExactMigrationLockResidue(residue, identity, 'stale migration lock residue');
    changed = true;
  }
  if (changed) fsyncParentDirectory(path);
}

export interface CoordinationMigrationOperationLock {
  readonly path: string;
  readonly pid: number;
  readonly bootId: string;
  readonly token: string;
  readonly release: () => Promise<void>;
}

async function acquireMigrationLock(stateRoot: string, path: string, afterBoundary?: (boundary: CoordinationMigrationCrashBoundary) => void | Promise<void>, ensureParent = true): Promise<CoordinationMigrationOperationLock> {
  assertMigrationPathSafe(stateRoot, path, 'repository migration lock');
  if (ensureParent) await ensurePrivateAuthorityDirectory(dirname(path));
  else if (!existsSync(dirname(path))) failure('blocked', 'global migration lock state root does not exist', [dirname(path)]);
  assertMigrationPathSafe(stateRoot, path, 'repository migration lock');
  const reclaimPath = `${path}.reclaim`;
  assertMigrationPathSafe(stateRoot, reclaimPath, 'repository migration lock reclamation fence');
  recoverMigrationLockResidues(stateRoot, path);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let handle: FileHandle | null = null;
    const token = randomBytes(24).toString('hex');
    const candidatePath = `${path}.candidate-${String(process.pid)}-${token}`;
    assertMigrationPathSafe(stateRoot, candidatePath, 'repository migration lock candidate');
    try {
      handle = await open(candidatePath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ schema_version: 'autopilot.coordination_migration_lock.v1', pid: process.pid, boot_id: currentBootId(), token, created_at: new Date().toISOString() })}\n`, 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await enforcePrivateAuthorityPath(candidatePath, false);
      await afterBoundary?.('after-lock-candidate-synced');
      linkSync(candidatePath, path);
      await afterBoundary?.('after-lock-published');
      unlinkSync(candidatePath);
      fsyncParentDirectory(path);
      return { path, pid: process.pid, bootId: currentBootId(), token, release: async () => {
        assertMigrationPathSafe(stateRoot, path, 'repository migration lock release');
        const releasePath = `${path}.release-${token}`;
        assertMigrationPathSafe(stateRoot, releasePath, 'repository migration release fence');
        if (!existsSync(path)) {
          if (!existsSync(releasePath)) failure('blocked', 'migration lock elected pathname disappeared before release', [path]);
          const residue = parseMigrationLockBytes(readFileSync(releasePath), 'migration release fence');
          if (residue.token !== token) failure('blocked', 'migration release fence belongs to another lock identity', [releasePath]);
          unlinkSync(releasePath);
          fsyncParentDirectory(path);
          return;
        }
        const lockIdentity = assertRegularMigrationLockResidue(stateRoot, path, 'repository migration lock release');
        const owner = parseMigrationLockBytes(readFileSync(path), 'repository migration lock release');
        if (owner.token !== token) failure('blocked', 'migration lock ownership changed before release; no lock was removed', [path]);
        try { linkSync(path, releasePath); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        const releaseIdentity = assertRegularMigrationLockResidue(stateRoot, releasePath, 'repository migration release fence');
        if (!sameFileIdentity(lockIdentity, releaseIdentity) || parseMigrationLockBytes(readFileSync(releasePath), 'migration release fence').token !== token) failure('blocked', 'migration lock identity changed while release was fenced; no lock was removed', [path, releasePath]);
        await afterBoundary?.('after-lock-release-linked');
        unlinkExactMigrationLockResidue(path, lockIdentity, 'repository migration lock release');
        await afterBoundary?.('after-lock-release-unlinked');
        fsyncParentDirectory(path);
        unlinkExactMigrationLockResidue(releasePath, releaseIdentity, 'repository migration release fence');
        fsyncParentDirectory(path);
      } };
    } catch (error) {
      if (handle !== null) await handle.close();
      if (existsSync(candidatePath)) unlinkSync(candidatePath);
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      assertMigrationPathSafe(stateRoot, path, 'repository migration lock before reclamation');
      if (!existsSync(path)) { recoverMigrationLockResidues(stateRoot, path); continue; }
      let reclaimIdentity: ReturnType<typeof lstatSync>;
      if (existsSync(reclaimPath)) {
        reclaimIdentity = assertRegularMigrationLockResidue(stateRoot, reclaimPath, 'repository migration lock reclamation fence');
        const lockIdentity = assertRegularMigrationLockResidue(stateRoot, path, 'repository migration lock before reclamation');
        if (!sameFileIdentity(lockIdentity, reclaimIdentity)) {
          const residueOwner = parseMigrationLockBytes(readFileSync(reclaimPath), 'migration lock reclamation residue');
          if (migrationLockOwnerAlive(residueOwner)) failure('blocked', 'migration stale-lock reclamation is owned by a live process with a different identity', [reclaimPath]);
          unlinkExactMigrationLockResidue(reclaimPath, reclaimIdentity, 'stale migration reclaim residue');
          fsyncParentDirectory(path);
          continue;
        }
      } else {
        try { linkSync(path, reclaimPath); }
        catch (linkError) {
          if (linkError instanceof Error && 'code' in linkError && (linkError.code === 'EEXIST' || linkError.code === 'ENOENT')) continue;
          throw linkError;
        }
        reclaimIdentity = assertRegularMigrationLockResidue(stateRoot, reclaimPath, 'repository migration lock reclamation fence');
      }
      await afterBoundary?.('after-lock-reclaim-linked');
      const lockIdentity = assertRegularMigrationLockResidue(stateRoot, path, 'repository migration lock before reclamation');
      if (!sameFileIdentity(lockIdentity, reclaimIdentity)) failure('blocked', 'migration lock identity changed before stale-lock reclamation; no lock was removed', [path]);
      const owner = parseMigrationLockBytes(readFileSync(reclaimPath), 'migration lock reclamation fence');
      if (migrationLockOwnerAlive(owner)) {
        unlinkExactMigrationLockResidue(reclaimPath, reclaimIdentity, 'live migration reclaim fence');
        fsyncParentDirectory(path);
        failure('blocked', 'another migration process owns the repository migration lock', [path]);
      }
      const quarantined = `${path}.stale-${owner.token}-${randomBytes(8).toString('hex')}`;
      assertMigrationPathSafe(stateRoot, quarantined, 'stale migration lock quarantine');
      await rename(path, quarantined);
      await afterBoundary?.('after-lock-reclaim-quarantined');
      const quarantinedIdentity = assertRegularMigrationLockResidue(stateRoot, quarantined, 'stale migration lock quarantine');
      if (!sameFileIdentity(quarantinedIdentity, reclaimIdentity)) failure('blocked', 'migration lock identity changed during stale-lock reclamation; quarantined identities were preserved', [path]);
      unlinkExactMigrationLockResidue(reclaimPath, reclaimIdentity, 'migration reclaim fence');
      unlinkExactMigrationLockResidue(quarantined, quarantinedIdentity, 'stale migration lock quarantine');
      fsyncParentDirectory(path);
    }
  }
  failure('blocked', 'could not acquire repository migration lock', [path]);
}

export async function acquireCoordinationGlobalMigrationLock(stateRoot: string): Promise<CoordinationMigrationOperationLock> {
  // Elect in the existing parent so a dry-run of an empty state root does not
  // create authority state merely to host its transient operation lock.
  const lockRoot = dirname(resolve(stateRoot));
  const path = coordinationGlobalMigrationLockPath(stateRoot);
  const lock = await acquireMigrationLock(lockRoot, path, undefined, false);
  try {
    const staleAuthorization = join(stateRoot, 'migrations', '.recovery-operation.json');
    assertMigrationPathSafe(stateRoot, staleAuthorization, 'stale migration recovery operation authorization');
    if (existsSync(dirname(staleAuthorization))) {
      await rm(staleAuthorization, { force: true });
      fsyncParentDirectory(staleAuthorization);
    }
    return lock;
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export async function authorizeCoordinationMigrationRecovery(stateRoot: string, lock: CoordinationMigrationOperationLock): Promise<{ readonly token: string; readonly release: () => Promise<void> }> {
  const expectedPath = coordinationGlobalMigrationLockPath(stateRoot);
  if (lock.path !== expectedPath || lock.pid !== process.pid || lock.bootId !== currentBootId()) failure('blocked', 'recovery authorization does not own the exact global migration operation lock');
  const marker = join(stateRoot, 'migrations', '.recovery-operation.json');
  await atomicJson(stateRoot, marker, { schema_version: 'autopilot.coordination_recovery_operation.v1', pid: lock.pid, boot_id: lock.bootId, token: lock.token, created_at: new Date().toISOString() });
  let released = false;
  return { token: lock.token, release: async () => {
    if (released) return;
    const value = object(parseJsonFile(marker, null), marker, ['boot_id', 'created_at', 'pid', 'schema_version', 'token']);
    if (value['schema_version'] !== 'autopilot.coordination_recovery_operation.v1' || value['pid'] !== lock.pid || value['boot_id'] !== lock.bootId || value['token'] !== lock.token) failure('blocked', 'recovery authorization identity changed before release', [marker]);
    await rm(marker, { force: true });
    fsyncParentDirectory(marker);
    released = true;
  } };
}

async function createFreeze(stateRoot: string, path: string, repoKey: string, migrationId: string, token: string, now: Date): Promise<void> {
  assertMigrationPathSafe(stateRoot, path, 'migration freeze');
  if (existsSync(path)) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; }
    catch { failure('blocked', 'existing migration freeze is unreadable', [path]); }
    const row = object(parsed, 'migration freeze', ['acknowledgement_deadline_at', 'dispatch', 'freeze_token', 'frozen_at', 'migration_id', 'repo_key', 'required_database_schema_version', 'required_package_build', 'required_protocol_version', 'schema_version', 'writer_policy']);
    if (row['schema_version'] !== COORDINATION_FREEZE_SCHEMA || row['repo_key'] !== repoKey || row['migration_id'] !== migrationId || row['freeze_token'] !== token || row['required_package_build'] !== COORDINATOR_PACKAGE_BUILD || row['required_protocol_version'] !== AUTOPILOT_COORDINATOR_PROTOCOL_VERSION || row['required_database_schema_version'] !== COORDINATOR_DATABASE_SCHEMA_VERSION || row['dispatch'] !== 'stopped' || row['writer_policy'] !== 'fail-loudly') failure('blocked', 'existing migration freeze identity does not match the durable journal', [path]);
    return;
  }
  await atomicJson(stateRoot, path, { schema_version: COORDINATION_FREEZE_SCHEMA, repo_key: repoKey, migration_id: migrationId, freeze_token: token, frozen_at: now.toISOString(), acknowledgement_deadline_at: new Date(now.getTime() + 30_000).toISOString(), required_package_build: COORDINATOR_PACKAGE_BUILD, required_protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, required_database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION, dispatch: 'stopped', writer_policy: 'fail-loudly' });
}

async function copySnapshot(stateRoot: string, entries: readonly SnapshotEntry[], root: string): Promise<void> {
  assertMigrationPathSafe(stateRoot, root, 'migration snapshot destination');
  await rm(root, { recursive: true, force: true });
  assertMigrationPathSafe(stateRoot, root, 'migration snapshot destination');
  for (const entry of entries) {
    if (!entry.exists) continue;
    const target = resolve(root, ...entry.relative_path.split('/'));
    if (!isInside(root, target)) failure('invalid', 'snapshot target escapes snapshot root', [target]);
    assertMigrationPathSafe(stateRoot, target, 'migration snapshot file destination');
    await ensurePrivateAuthorityDirectory(dirname(target));
    assertMigrationPathSafe(stateRoot, target, 'migration snapshot file destination');
    await copyFile(entry.source_path, target, fsConstants.COPYFILE_EXCL);
    if (digest(await readFile(target)) !== entry.sha256) failure('blocked', 'snapshot copy hash verification failed', [entry.source_path]);
    if (platform() !== 'win32') await chmod(target, 0o400);
    else await enforcePrivateAuthorityPath(target, false);
  }
}

function recheckEntries(entries: readonly SnapshotEntry[]): readonly string[] {
  const drift: string[] = [];
  for (const entry of entries) {
    if (existsSync(entry.source_path) !== entry.exists) { drift.push(`${entry.relative_path}: existence changed`); continue; }
    if (!entry.exists) continue;
    const info = statSync(entry.source_path);
    if (!info.isFile() || info.size !== entry.size_bytes || digest(readBounded(entry.source_path)) !== entry.sha256) drift.push(`${entry.relative_path}: content hash changed`);
  }
  return Object.freeze(drift);
}

export function coordinationMigrationCoordinatorRunning(paths: CoordinatorRuntimePaths): boolean {
  for (const path of [paths.lockPath, paths.predecessorLockPath]) {
    if (!existsSync(path)) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const lock = parseCurrentCoordinatorLock(raw) ?? parsePriorSchema11CurrentCoordinatorLock(raw) ?? parsePriorSchema10CurrentCoordinatorLock(raw) ?? parsePriorSchema9CurrentCoordinatorLock(raw) ?? parsePredecessorCoordinatorLock(raw);
      if (lock === null || isProcessAlive(lock.pid)) return true;
    } catch { return true; }
  }
  return false;
}

export async function retireCoordinationMigrationCoordinator(paths: CoordinatorRuntimePaths, expectedIdentity?: CurrentCoordinatorLock): Promise<readonly string[]> {
  if (!existsSync(paths.lockPath)) return [];
  try { preflightProcessRetirementSupport(); }
  catch (error) { return Object.freeze([`coordinator process-retirement dependency preflight failed: ${error instanceof Error ? error.message : String(error)}`]); }
  let lock;
  try {
    const value = JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown;
    lock = parseCurrentCoordinatorLock(value) ?? parsePriorSchema11CurrentCoordinatorLock(value) ?? parsePriorSchema10CurrentCoordinatorLock(value) ?? parsePriorSchema9CurrentCoordinatorLock(value);
  }
  catch (error) { return Object.freeze([`coordinator lifecycle lock is unreadable during migration drain: ${error instanceof Error ? error.message : String(error)}`]); }
  if (lock === null || !isExactProcessAlive(lock.pid, lock.process_start_identity) || lock.pid === process.pid) return Object.freeze(['coordinator lifecycle identity is incompatible with exact automatic migration retirement']);
  if (expectedIdentity !== undefined && (lock.pid !== expectedIdentity.pid || lock.boot_id !== expectedIdentity.boot_id || lock.process_start_identity !== expectedIdentity.process_start_identity || lock.token !== expectedIdentity.token || lock.instance_id !== expectedIdentity.instance_id || lock.started_at !== expectedIdentity.started_at)) return Object.freeze(['coordinator lifecycle identity changed after the recovery client started its temporary process']);
  try { retireExactProcess(lock.pid, lock.process_start_identity); }
  catch (error) { return Object.freeze([`drained coordinator could not be retired: ${error instanceof Error ? error.message : String(error)}`]); }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!existsSync(paths.lockPath)) return [];
    if (!isProcessAlive(lock.pid)) {
      let election: ReturnType<typeof acquireSerializedProcessGuard>;
      try { election = acquireSerializedProcessGuard(paths.lifecycleElectionPath, 1_000, 'migration coordinator retirement'); }
      catch (error) { return Object.freeze([`coordinator lifecycle retirement could not acquire serialized election: ${error instanceof Error ? error.message : String(error)}`]); }
      try {
        const currentText = await readExactLockText(paths.lockPath);
        if (currentText === null) return [];
        let current;
        try {
          const value = JSON.parse(currentText) as unknown;
          current = parseCurrentCoordinatorLock(value) ?? parsePriorSchema11CurrentCoordinatorLock(value) ?? parsePriorSchema10CurrentCoordinatorLock(value) ?? parsePriorSchema9CurrentCoordinatorLock(value);
        }
        catch (error) { return Object.freeze([`coordinator lifecycle lock became unreadable while retiring for migration: ${error instanceof Error ? error.message : String(error)}`]); }
        if (current === null || current.pid !== lock.pid || current.boot_id !== lock.boot_id || current.process_start_identity !== lock.process_start_identity || current.token !== lock.token || current.instance_id !== lock.instance_id || current.started_at !== lock.started_at) return Object.freeze(['coordinator lifecycle identity changed while retiring for migration']);
        const tombstone = await quarantineExactLock(paths.lockPath, currentText, 'drained coordinator lifecycle lock');
        await discardLockTombstone(tombstone);
        return [];
      } finally { election.release(); }
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  return Object.freeze([`drained coordinator did not release its lifecycle lock before the migration deadline: pid=${String(lock.pid)}`]);
}

async function retireDrainedCoordinatorForMigration(paths: CoordinatorRuntimePaths, repoKey: string, label: string): Promise<void> {
  if (!coordinationMigrationCoordinatorRunning(paths)) return;
  const coordinator = inspectCoordinatorReadOnly(paths, repoKey);
  const blockers = coordinatorDrainBlockers(coordinator);
  if (blockers.length > 0) failure('blocked', `${label} refuses coordinator retirement until every durable session and child has drained`, blockers);
  const retirementBlockers = await retireCoordinationMigrationCoordinator(paths);
  if (retirementBlockers.length > 0) failure('blocked', `${label} could not retire the drained coordinator`, retirementBlockers);
  if (coordinationMigrationCoordinatorRunning(paths)) failure('blocked', `${label} coordinator lifecycle lock remains live after retirement`, [paths.lockPath]);
}

interface MigrationStoreAuthority {
  startupAdoption(): CoordinatorStartupAdoption;
  release(): Promise<void>;
}

/**
 * Holds the current lifecycle election and an aa3e377-compatible live fence for
 * the entire direct-store/archive critical section. Current startup blocks on
 * the election; the predecessor sees this process as the live lock owner.
 */
async function acquireMigrationStoreAuthority(paths: CoordinatorRuntimePaths, label: string): Promise<MigrationStoreAuthority> {
  await ensureCoordinatorPrivateRoots(paths);
  const election = acquireSerializedProcessGuard(paths.lifecycleElectionPath, 10_000, `${label} lifecycle election`);
  let currentTombstone: string | null = null;
  let predecessorTombstone: string | null = null;
  let fenceCreated = false;
  const fence = { schema_version: 'autopilot.coordinator_lock.v1' as const, pid: process.pid, boot_id: predecessorCompatibleBootId(), token: randomBytes(24).toString('hex'), started_at: new Date().toISOString() };
  try {
    const currentText = await readExactLockText(paths.lockPath);
    if (currentText !== null) {
      let current = null;
      try { current = parseCurrentCoordinatorLock(JSON.parse(currentText) as unknown); } catch { /* fail below */ }
      if (current === null) failure('blocked', `${label} found an unreadable current coordinator lifecycle lock`, [paths.lockPath]);
      if (isProcessAlive(current.pid)) failure('blocked', `${label} refuses direct store access while current coordinator pid ${String(current.pid)} is live`, [paths.lockPath]);
      currentTombstone = await quarantineExactLock(paths.lockPath, currentText, `dead current coordinator before ${label}`);
    }
    const predecessorText = await readExactLockText(paths.predecessorLockPath);
    if (predecessorText !== null) {
      let predecessor = null;
      try { predecessor = parsePredecessorCoordinatorLock(JSON.parse(predecessorText) as unknown); } catch { /* fail below */ }
      if (predecessor === null) failure('blocked', `${label} found an unreadable predecessor coordinator lifecycle lock`, [paths.predecessorLockPath]);
      if (isProcessAlive(predecessor.pid)) failure('blocked', `${label} refuses direct store access while predecessor coordinator pid ${String(predecessor.pid)} is live`, [paths.predecessorLockPath]);
      predecessorTombstone = await quarantineExactLock(paths.predecessorLockPath, predecessorText, `dead predecessor coordinator before ${label}`);
    }
    const handle = await open(paths.predecessorLockPath, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(fence)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await enforcePrivateAuthorityPath(paths.predecessorLockPath, false);
    fenceCreated = true;
    if (currentTombstone !== null) { await discardLockTombstone(currentTombstone); currentTombstone = null; }
    if (predecessorTombstone !== null) { await discardLockTombstone(predecessorTombstone); predecessorTombstone = null; }
    let released = false;
    let adopted = false;
    let electionReleased = false;
    const releaseElection = (): void => { if (!electionReleased) { electionReleased = true; election.release(); } };
    return {
      startupAdoption: () => ({
        predecessorFence: fence,
        releaseElection,
        adopted: () => { adopted = true; },
        restored: () => { adopted = false; },
      }),
      release: async () => {
        if (released || adopted) return;
        const text = await readExactLockText(paths.predecessorLockPath);
        if (text === null) failure('blocked', `${label} predecessor exclusion fence disappeared before release`, [paths.predecessorLockPath]);
        const observed = parsePredecessorCoordinatorLock(JSON.parse(text) as unknown);
        if (observed === null || observed.pid !== fence.pid || observed.token !== fence.token || observed.started_at !== fence.started_at) failure('blocked', `${label} predecessor exclusion fence changed ownership before release`, [paths.predecessorLockPath]);
        await discardLockTombstone(await quarantineExactLock(paths.predecessorLockPath, text, `${label} predecessor exclusion fence`));
        released = true;
        releaseElection();
      },
    };
  } catch (error) {
    try {
      if (fenceCreated) {
        const text = await readExactLockText(paths.predecessorLockPath);
        if (text !== null) {
          const observed = parsePredecessorCoordinatorLock(JSON.parse(text) as unknown);
          if (observed === null || observed.pid !== fence.pid || observed.token !== fence.token || observed.started_at !== fence.started_at) throw new CoordinationRuntimeError('system-fatal', `${label} failed and its predecessor exclusion fence changed ownership`, [paths.predecessorLockPath]);
          await discardLockTombstone(await quarantineExactLock(paths.predecessorLockPath, text, `failed ${label} predecessor fence`));
        }
      }
      if (predecessorTombstone !== null) await restoreLockTombstone(paths.predecessorLockPath, predecessorTombstone, `pre-${label} predecessor lock`);
      if (currentTombstone !== null) await restoreLockTombstone(paths.lockPath, currentTombstone, `pre-${label} current lock`);
    } finally { election.release(); }
    throw error;
  }
}

async function withMigrationStoreAuthority<T>(paths: CoordinatorRuntimePaths, label: string, operation: () => Promise<T>): Promise<T> {
  const authority = await acquireMigrationStoreAuthority(paths, label);
  try { return await operation(); }
  finally { await authority.release(); }
}

function verifyCoordinatorDatabaseFileReadOnly(path: string): 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 {
  const database = openImmutableCoordinatorDatabase(path);
  try { return assertReadOnlySchema(database); }
  finally { database.close(); }
}

async function createVerifiedPreImportBackup(paths: CoordinatorRuntimePaths, outputPath: string): Promise<{ readonly path: string; readonly sha256: `sha256:${string}` }> {
  const authorityDatabasePath = coordinatorAuthorityDatabasePath(paths);
  assertMigrationPathSafe(paths.stateRoot, authorityDatabasePath, 'pre-import coordinator database');
  assertMigrationPathSafe(paths.stateRoot, outputPath, 'migration database backup destination');
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  if (existsSync(outputPath)) await rm(outputPath, { force: true });
  const source = new DatabaseSync(authorityDatabasePath, { readOnly: true, timeout: 1_000, enableForeignKeyConstraints: false });
  try {
    assertReadOnlySchema(source);
    await backup(source, outputPath);
  } finally { source.close(); }
  const normalized = new DatabaseSync(outputPath, { timeout: 1_000, enableForeignKeyConstraints: false });
  try {
    const mode = normalized.prepare('PRAGMA journal_mode=DELETE').get() as SqliteRow | undefined;
    if (mode?.['journal_mode'] !== 'delete') failure('blocked', 'migration backup could not retire WAL journal authority', [outputPath]);
    assertReadOnlySchema(normalized);
  } finally { normalized.close(); }
  if (existsSync(`${outputPath}-wal`) || existsSync(`${outputPath}-shm`)) failure('blocked', 'migration backup retained WAL/SHM authority after close', [outputPath]);
  verifyCoordinatorDatabaseFileReadOnly(outputPath);
  const descriptor = openSync(outputPath, fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  fsyncParentDirectory(outputPath);
  await enforcePrivateAuthorityPath(outputPath, false);
  return { path: outputPath, sha256: digest(await readFile(outputPath)) };
}

async function restoreBackup(paths: CoordinatorRuntimePaths, journal: CoordinationMigrationJournal): Promise<void> {
  if (journal.backup_path === null || journal.backup_sha256 === null) failure('blocked', 'verified migration backup is unavailable');
  assertMigrationPathSafe(paths.stateRoot, journal.backup_path, 'migration database backup');
  if (!existsSync(journal.backup_path) || lstatSync(journal.backup_path).isSymbolicLink()) failure('blocked', 'verified migration backup is unavailable');
  if (digest(await readFile(journal.backup_path)) !== journal.backup_sha256) failure('blocked', 'migration backup hash verification failed', [journal.backup_path]);
  const backupSchema = verifyCoordinatorDatabaseFileReadOnly(journal.backup_path);
  if (existsSync(paths.currentStorePointerPath)) {
    if (backupSchema !== COORDINATOR_DATABASE_SCHEMA_VERSION && backupSchema !== COORDINATOR_STORE_SCHEMA_VERSION) failure('blocked', 'generation-addressed rollback requires an exact schema-12 or schema-13 backup', [journal.backup_path, `schema=${String(backupSchema)}`]);
    await CoordinatorStore.restoreGeneration(paths, journal.backup_path, journal.backup_sha256);
    return;
  }
  assertMigrationPathSafe(paths.stateRoot, paths.databasePath, 'migration database restore destination');
  await rm(`${paths.databasePath}-wal`, { force: true });
  await rm(`${paths.databasePath}-shm`, { force: true });
  const temporary = `${paths.databasePath}.restore-${randomBytes(8).toString('hex')}`;
  assertMigrationPathSafe(paths.stateRoot, temporary, 'migration database restore temporary');
  await copyFile(journal.backup_path, temporary);
  if (digest(await readFile(temporary)) !== journal.backup_sha256) failure('blocked', 'staged migration rollback differs from the verified backup', [temporary]);
  await rename(temporary, paths.databasePath);
  const descriptor = openSync(paths.databasePath, fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  fsyncParentDirectory(paths.databasePath);
  if (digest(await readFile(paths.databasePath)) !== journal.backup_sha256) failure('blocked', 'migration rollback did not restore the byte-exact verified backup', [paths.databasePath]);
  verifyCoordinatorDatabaseFileReadOnly(paths.databasePath);
}

async function restorePreImportBoundary(paths: CoordinatorRuntimePaths, journal: CoordinationMigrationJournal): Promise<void> {
  if (journal.backup_path !== null && journal.backup_sha256 !== null) {
    await restoreBackup(paths, journal);
    return;
  }
  if (existsSync(paths.currentStorePointerPath)) failure('blocked', 'generation-addressed rollback has no verified pre-import generation backup');
  if (journal.database_existed_before) failure('blocked', 'pre-generation rollback lost its verified database backup');
  assertMigrationPathSafe(paths.stateRoot, paths.databasePath, 'migration candidate database removal');
  await rm(`${paths.databasePath}-wal`, { force: true });
  await rm(`${paths.databasePath}-shm`, { force: true });
  await rm(paths.databasePath, { force: true });
}

async function promoteRuntimeProjections(stateRoot: string, entries: readonly SnapshotEntry[], repoKey: string): Promise<void> {
  for (const entry of entries.filter((candidate) => candidate.exists && candidate.relative_path.endsWith('/_task-info.json'))) {
    const parsed = parseJsonFile(entry.source_path, null);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) failure('blocked', 'runtime task-info projection is malformed during cutover', [entry.source_path]);
    const row = parsed as Readonly<Record<string, unknown>>;
    if ((row['schema_version'] !== 'autopilot.task_info.v1' && row['schema_version'] !== 'autopilot.task_info.v2') || row['repo_key'] !== repoKey || typeof row['workstream_run'] !== 'string' || typeof row['autopilot_id'] !== 'string') failure('blocked', 'runtime task-info identity is invalid during cutover', [entry.source_path]);
    await atomicJson(stateRoot, entry.source_path, { ...row, schema_version: 'autopilot.task_info.v2', coordination_authority: 'coordinator-edit-leases-v1' });
  }
}

async function archiveLegacy(stateRoot: string, entries: readonly SnapshotEntry[], migrationPaths: CoordinationMigrationPaths): Promise<void> {
  const mutable = new Set<string>([...TOP_LEVEL_COORDINATION_FILES.map((name) => `coordination/${name}`), ...TOP_LEVEL_WORKTREE_FILES.map((name) => `worktrees/${name}`)]);
  const archived: { readonly relative_path: string; readonly size_bytes: number; readonly sha256: `sha256:${string}` }[] = [];
  for (const entry of entries) {
    const segments = entry.relative_path.split('/');
    const category = segments[0];
    const key = category === 'coordination' ? `coordination/${segments[segments.length - 1] ?? ''}` : category === 'worktrees' ? `worktrees/${segments[segments.length - 1] ?? ''}` : '';
    if (!mutable.has(key) || !entry.exists) continue;
    const target = join(migrationPaths.archiveRoot, ...entry.relative_path.split('/'));
    assertMigrationPathSafe(stateRoot, target, 'legacy archive destination');
    await ensurePrivateAuthorityDirectory(dirname(target));
    assertMigrationPathSafe(stateRoot, target, 'legacy archive destination');
    if (existsSync(entry.source_path)) {
      if (digest(await readFile(entry.source_path)) !== entry.sha256) failure('blocked', 'legacy source drifted during archive', [entry.source_path]);
      await rename(entry.source_path, target);
    }
    if (!existsSync(target) || digest(await readFile(target)) !== entry.sha256) failure('blocked', 'legacy archive verification failed', [target]);
    if (platform() !== 'win32') await chmod(target, 0o400);
    else await enforcePrivateAuthorityPath(target, false);
    if (platform() === 'win32') {
      const readonly = spawnSync('attrib', ['+R', target], { encoding: 'utf8' });
      if (readonly.status !== 0) failure('blocked', 'failed to set Windows read-only archive attribute', [target, readonly.stderr]);
    }
    archived.push({ relative_path: entry.relative_path, size_bytes: entry.size_bytes, sha256: entry.sha256 });
  }
  const archiveManifestPath = join(migrationPaths.archiveRoot, 'manifest.json');
  const archiveManifest = { schema_version: 'autopilot.coordination_legacy_archive_manifest.v1', entries: archived.sort((left, right) => left.relative_path.localeCompare(right.relative_path)) };
  if (existsSync(archiveManifestPath)) {
    const existing = JSON.parse(await readFile(archiveManifestPath, 'utf8')) as unknown;
    if (stableJson(existing) !== stableJson(archiveManifest)) failure('blocked', 'legacy archive manifest disagrees with archived bytes', [archiveManifestPath]);
  } else await atomicJson(stateRoot, archiveManifestPath, archiveManifest, 0o400);
  if (platform() === 'win32') {
    const readonly = spawnSync('attrib', ['+R', archiveManifestPath], { encoding: 'utf8' });
    if (readonly.status !== 0) failure('blocked', 'failed to set Windows read-only archive manifest attribute', [archiveManifestPath, readonly.stderr]);
  }
  if (platform() !== 'win32' && existsSync(migrationPaths.archiveRoot)) await sealArchiveDirectories(migrationPaths.archiveRoot);
}

async function sealArchiveDirectories(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) if (entry.isDirectory()) await sealArchiveDirectories(join(root, entry.name));
  await chmod(root, 0o500);
}

async function archiveRolledBackGeneration(stateRoot: string, migrationPaths: CoordinationMigrationPaths, journal: CoordinationMigrationJournal): Promise<void> {
  const historyRoot = join(migrationPaths.root, 'history', journal.migration_id);
  assertMigrationPathSafe(stateRoot, historyRoot, 'rolled-back migration history destination');
  await ensurePrivateAuthorityDirectory(historyRoot);
  assertMigrationPathSafe(stateRoot, historyRoot, 'rolled-back migration history destination');
  const historicSnapshot = join(historyRoot, 'snapshot');
  if (existsSync(migrationPaths.snapshotRoot) && !existsSync(historicSnapshot)) await rename(migrationPaths.snapshotRoot, historicSnapshot);
  const historicJournal = join(historyRoot, 'journal.json');
  if (!existsSync(historicJournal)) await rename(migrationPaths.journalPath, historicJournal);
  await rm(migrationPaths.freezePath, { force: true });
}

function nextJournal(journal: CoordinationMigrationJournal, state: CoordinationMigrationState, report: CoordinationMigrationReport, now: Date, effects: readonly string[], patch: Partial<Pick<CoordinationMigrationJournal, 'snapshot_sha256' | 'snapshot_entries' | 'git_snapshot' | 'backup_path' | 'backup_sha256'>> = {}): CoordinationMigrationJournal {
  const completedEffects = Object.freeze([...new Set([...journal.completed_effects, ...effects])]);
  return { ...journal, ...patch, state, report, updated_at: now.toISOString(), completed_effects: completedEffects };
}

export async function runCoordinationMigration(input: { readonly command: CoordinationMigrationCommand; readonly repoKey: string; readonly repoRoot?: string; readonly env?: ProcessEnvLike; readonly clock?: MigrationClock; readonly afterBoundary?: (boundary: CoordinationMigrationCrashBoundary) => void | Promise<void> }): Promise<CoordinationMigrationReport> {
  if (!ID.test(input.repoKey)) failure('invalid', 'migration repo key is invalid');
  const clock = input.clock ?? systemClock;
  const now = clock.now();
  const paths = coordinatorRuntimePaths(input.env ?? process.env);
  const expectedFreezePath = join(paths.stateRoot, 'migrations', input.repoKey, 'freeze.json');
  assertMigrationPathSafe(paths.stateRoot, expectedFreezePath, 'expected repository migration freeze');
  if (input.command === 'dry-run') {
    // Inspection shares coordinator DB/WAL and authority paths with apply. Use
    // the same global operation election, while leaving no durable lock behind.
    const observedFreeze = activeCoordinationMigrationFreeze(paths.stateRoot);
    if (observedFreeze !== null) failure('blocked', 'migration dry-run is forbidden while a global coordination migration freeze is active', [observedFreeze]);
    let dryRunLock: CoordinationMigrationOperationLock | null = null;
    try {
      dryRunLock = await acquireCoordinationGlobalMigrationLock(paths.stateRoot);
      const existingFreeze = activeCoordinationMigrationFreeze(paths.stateRoot);
      if (existingFreeze !== null) failure('blocked', 'migration dry-run is forbidden while a global coordination migration freeze is active', [existingFreeze]);
      const migrationPaths = coordinationMigrationPaths(paths, input.repoKey);
      if (readCoordinationCutoverMarker(migrationPaths.cutoverMarkerPath, input.repoKey, paths.stateRoot) !== null) failure('blocked', 'repository coordination cutover is already committed; legacy dry-run is no longer valid', [migrationPaths.cutoverMarkerPath]);
      const coordinator = inspectCoordinatorReadOnly(paths, input.repoKey);
      const repository = resolveMigrationRepositoryIdentity(paths, input.repoKey, input.repoRoot, coordinator);
      let inspection = inspectLegacy(paths, input.repoKey, repository);
      inspection = reconcileMixedCoordinatorAuthority(coordinator, inspection);
      const dryRunBlockers = Object.freeze([...inspection.blockers, ...legacyDrainBlockers(paths, migrationPaths, null, inspection.rows), ...coordinatorDrainBlockers(coordinator)].sort());
      inspection = { ...inspection, blockers: dryRunBlockers };
      const drift = Object.freeze([...recheckEntries(inspection.sourceEntries), ...recheckGitSnapshot(inspection.gitSnapshot, inspection.rows, repository)]);
      if (drift.length > 0) failure('blocked', 'legacy source changed during dry-run inspection; rerun against a stable source', drift);
      return baseReport('dry-run', input.repoKey, inspection, now, 'planned', null, aggregateDigest(inspection.sourceEntries, inspection.gitSnapshot), null, null);
    } finally {
      if (dryRunLock !== null) await dryRunLock.release();
    }
  }
  const observedFreeze = activeCoordinationMigrationFreeze(paths.stateRoot);
  if (observedFreeze !== null && observedFreeze !== expectedFreezePath) failure('blocked', 'another repository already owns the global coordination migration freeze', [observedFreeze, expectedFreezePath]);
  const globalLock = await acquireCoordinationGlobalMigrationLock(paths.stateRoot);
  let lock: Awaited<ReturnType<typeof acquireMigrationLock>> | null = null;
  try {
    const existingFreeze = activeCoordinationMigrationFreeze(paths.stateRoot);
    if (existingFreeze !== null && existingFreeze !== expectedFreezePath) failure('blocked', 'another repository already owns the global coordination migration freeze', [existingFreeze, expectedFreezePath]);
    const migrationPaths = coordinationMigrationPaths(paths, input.repoKey);
    await ensureCoordinatorPrivateRoots(paths, input.env ?? process.env);
    for (const authorityRoot of [join(paths.stateRoot, 'migrations'), join(paths.stateRoot, 'cutovers'), join(paths.stateRoot, 'migration-recovery-evidence')]) await ensurePrivateAuthorityDirectory(authorityRoot, input.env ?? process.env);
    for (const existingAuthorityRoot of [join(paths.stateRoot, 'coordination'), join(paths.stateRoot, 'worktrees')]) if (existsSync(existingAuthorityRoot)) {
      if (platform() === 'win32') enforceWindowsPrivateTree(existingAuthorityRoot, input.env ?? process.env);
      else await enforcePrivateAuthorityPath(existingAuthorityRoot, true, input.env ?? process.env);
    }
    lock = await acquireMigrationLock(paths.stateRoot, migrationPaths.lockPath, input.afterBoundary);
    const marker = readCoordinationCutoverMarker(migrationPaths.cutoverMarkerPath, input.repoKey, paths.stateRoot);
    let journal = await readJournal(paths.stateRoot, migrationPaths.journalPath);
    if (journal?.state === 'rolled-back' && input.command === 'apply') {
      await archiveRolledBackGeneration(paths.stateRoot, migrationPaths, journal);
      journal = null;
    }
    if (marker !== null && (journal === null || journal.migration_id !== marker.migration_id || journal.snapshot_sha256 !== marker.snapshot_sha256)) failure('blocked', 'cutover marker identity does not match the durable migration journal', [migrationPaths.cutoverMarkerPath]);
    if (marker !== null) {
      const forward = inspectCoordinatorReadOnly(paths, input.repoKey, true);
      const migration = forward?.migration;
      if (migration === null || migration === undefined || migration.migration_id !== marker.migration_id || migration.snapshot_sha256 !== marker.snapshot_sha256) failure('blocked', 'cutover marker is not bound to the exact coordinator migration record');
      if (migration.state === 'cutover-ready') {
        const source = coordinatorDatabaseSourceIdentities(coordinatorAuthorityDatabasePath(paths));
        if (source[0]?.sha256 !== marker.database_sha256 || source[1]?.exists === true && (source[1]?.size ?? 0) > 0) failure('blocked', 'forward cutover resume database bytes disagree with the committed marker digest', [`expected=${marker.database_sha256}`, `actual=${source[0]?.sha256 ?? 'missing'}`]);
      } else if (migration.state !== 'cutover-committed' && migration.state !== 'legacy-archived') failure('blocked', 'cutover marker has an impossible forward database state', [migration.state]);
    }
    if (marker !== null && input.command === 'rollback') failure('blocked', 'rollback is forbidden after the one-way cutover marker; repair is forward-only', [migrationPaths.cutoverMarkerPath]);
    if (marker !== null && input.command !== 'cutover') failure('blocked', 'repository coordination cutover is already committed; legacy migration commands are no longer valid', [migrationPaths.cutoverMarkerPath]);
    if (journal === null) {
      if (input.command !== 'apply') failure('blocked', `${input.command} requires a prior migrate --apply journal`);
      const coordinator = inspectCoordinatorReadOnly(paths, input.repoKey);
      const repository = resolveMigrationRepositoryIdentity(paths, input.repoKey, input.repoRoot, coordinator);
      let inspection = inspectLegacy(paths, input.repoKey, repository);
      inspection = reconcileMixedCoordinatorAuthority(coordinator, inspection);
      const migrationId = `migration-${createHash('sha256').update(`${input.repoKey}\0${now.toISOString()}\0${randomBytes(16).toString('hex')}`, 'utf8').digest('hex').slice(0, 32)}`;
      const report = baseReport('apply', input.repoKey, inspection, now, 'planned', migrationId, null, null, null);
      journal = { schema_version: COORDINATION_MIGRATION_JOURNAL_SCHEMA, migration_id: migrationId, repo_key: input.repoKey, state: 'planned', freeze_token: randomBytes(32).toString('hex'), created_at: now.toISOString(), updated_at: now.toISOString(), snapshot_sha256: null, snapshot_entries: [], git_snapshot: [], backup_path: null, backup_sha256: null, database_existed_before: existsSync(paths.currentStorePointerPath) || existsSync(paths.databasePath), repository_root: repository.canonical_root, repository_git_common_dir: repository.git_common_dir, completed_effects: ['migration-authority-journaled-before-freeze'], report };
      await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
      await input.afterBoundary?.('after-plan');
    }
    if (journal.repo_key !== input.repoKey) failure('blocked', 'migration journal repository identity mismatch');
    const repository: MigrationRepositoryIdentity = { canonical_root: journal.repository_root, git_common_dir: journal.repository_git_common_dir };
    const writerAuthorityAcquired = journal.completed_effects.includes('single-writer-authority-acquired');
    const currentCoordinator = inspectCoordinatorReadOnly(paths, input.repoKey, writerAuthorityAcquired);
    const currentRepository = resolveMigrationRepositoryIdentity(paths, input.repoKey, input.repoRoot ?? journal.repository_root, currentCoordinator);
    if (stableJson(currentRepository) !== stableJson(repository)) failure('blocked', 'migration journal repository identity no longer matches canonical Git identity');
    if (input.command !== 'apply') await retireDrainedCoordinatorForMigration(paths, input.repoKey, `migration ${input.command}`);
    if (input.command === 'apply') {
      if (journal.state === 'imported' || journal.state === 'verified' || journal.state === 'cutover-ready') return journal.report;
      if (journal.state === 'rollback-restoring' || journal.state === 'rollback-restored' || journal.state === 'rollback-unfreezing') failure('blocked', 'apply is forbidden while durable rollback is incomplete; resume rollback first');
      if (journal.state === 'cutover-committed' || journal.state === 'legacy-archived') failure('blocked', 'apply is forbidden after cutover');
      await createFreeze(paths.stateRoot, migrationPaths.freezePath, input.repoKey, journal.migration_id, journal.freeze_token, now);
      await input.afterBoundary?.('after-freeze-written-before-journal');
      let coordinator = inspectCoordinatorReadOnly(paths, input.repoKey, writerAuthorityAcquired);
      let inspection = inspectLegacy(paths, input.repoKey, repository);
      inspection = reconcileMixedCoordinatorAuthority(coordinator, inspection);
      let drainBlockers = coordinatorDrainBlockers(coordinator);
      const legacyBlockers = legacyDrainBlockers(paths, migrationPaths, journal, inspection.rows);
      let writerBlockers: readonly string[] = coordinationMigrationCoordinatorRunning(paths)
        ? drainBlockers.length === 0 && legacyBlockers.length === 0 && inspection.blockers.length === 0
          ? await retireCoordinationMigrationCoordinator(paths)
          : [`coordinator process remains online until every session, child, and legacy client has durably drained: ${paths.lockPath}`]
        : [];
      let blockers = Object.freeze([...inspection.blockers, ...drainBlockers, ...legacyBlockers, ...writerBlockers].sort());
      inspection = { ...inspection, blockers };
      let report = baseReport('apply', input.repoKey, inspection, now, 'frozen', journal.migration_id, journal.snapshot_sha256, journal.backup_path, null);
      journal = nextJournal(journal, 'frozen', report, now, ['freeze-written-before-store-authority']); await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal); await input.afterBoundary?.('after-freeze');
      if (blockers.length > 0) return report;

      // Retirement is followed by a fresh read-only snapshot. Only this exact
      // post-drain/post-retirement observation grants this process store writer
      // authority; no CoordinatorStore.open call is reachable before it.
      if (coordinationMigrationCoordinatorRunning(paths)) failure('blocked', 'coordinator lifecycle lock remains live after retirement');
      coordinator = inspectCoordinatorReadOnly(paths, input.repoKey, true);
      inspection = reconcileMixedCoordinatorAuthority(coordinator, inspectLegacy(paths, input.repoKey, repository));
      drainBlockers = coordinatorDrainBlockers(coordinator);
      writerBlockers = coordinationMigrationCoordinatorRunning(paths) ? ['coordinator writer authority changed during migration retirement'] : [];
      blockers = Object.freeze([...inspection.blockers, ...drainBlockers, ...legacyDrainBlockers(paths, migrationPaths, journal, inspection.rows), ...writerBlockers].sort());
      inspection = { ...inspection, blockers };
      report = baseReport('apply', input.repoKey, inspection, now, 'frozen', journal.migration_id, journal.snapshot_sha256, journal.backup_path, null);
      journal = nextJournal(journal, 'frozen', report, now, ['freeze-drain-complete', 'single-writer-authority-acquired']); await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal); await input.afterBoundary?.('after-writer-authority');
      if (blockers.length > 0) return report;

      if (journal.snapshot_sha256 !== null && journal.backup_path !== null && journal.backup_sha256 !== null && coordinator?.migration !== null && coordinator?.migration !== undefined) {
        const imported = coordinator.migration;
        if (imported.migration_id !== journal.migration_id || imported.snapshot_sha256 !== journal.snapshot_sha256) failure('blocked', 'database migration effect disagrees with the durable journal');
        const importedReport = { ...parseMigrationReport(imported.report), command: 'apply' as const, state: 'imported' as const, dry_run: false };
        journal = nextJournal(journal, 'imported', importedReport, now, ['transactional-import-committed']);
        await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
        return importedReport;
      }
      const snapshotSha = aggregateDigest(inspection.sourceEntries, inspection.gitSnapshot);
      await copySnapshot(paths.stateRoot, inspection.sourceEntries, migrationPaths.snapshotRoot);
      await input.afterBoundary?.('after-snapshot-copied-before-journal');
      report = baseReport('apply', input.repoKey, inspection, now, 'snapshotted', journal.migration_id, snapshotSha, null, null);
      journal = nextJournal(journal, 'snapshotted', report, now, ['snapshot-copied-and-hashed'], { snapshot_sha256: snapshotSha, snapshot_entries: inspection.sourceEntries, git_snapshot: inspection.gitSnapshot }); await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal); await input.afterBoundary?.('after-snapshot');
      const drift = recheckEntries(journal.snapshot_entries);
      if (drift.length > 0) failure('blocked', 'legacy source drifted after snapshot; migration remains frozen', drift);
      const backupPath = join(paths.backupsRoot, `coordinator.pre-legacy-${journal.migration_id}.db`);
      assertMigrationPathSafe(paths.stateRoot, backupPath, 'migration database backup destination');
      const backupJournal = journal;
      const backupResult = await withMigrationStoreAuthority(paths, 'migration apply backup', async () => {
        if (backupJournal.backup_path !== null && backupJournal.backup_sha256 !== null) {
          if (backupJournal.backup_path !== backupPath || !existsSync(backupPath) || digest(await readFile(backupPath)) !== backupJournal.backup_sha256) failure('blocked', 'durable pre-import backup is missing or changed', [backupPath]);
          verifyCoordinatorDatabaseFileReadOnly(backupPath);
          return { path: backupPath, sha256: backupJournal.backup_sha256 };
        }
        if (!existsSync(paths.currentStorePointerPath) && !existsSync(paths.databasePath)) {
          // A brand-new candidate is permitted only under lifecycle election and
          // the live predecessor exclusion fence.
          const initializingStore = await CoordinatorStore.open(paths, clock);
          initializingStore.close();
        }
        return await createVerifiedPreImportBackup(paths, backupPath);
      });
      await input.afterBoundary?.('after-backup-created-before-journal');
      report = baseReport('apply', input.repoKey, inspection, now, 'snapshotted', journal.migration_id, snapshotSha, backupResult.path, null);
      journal = nextJournal(journal, 'snapshotted', report, now, ['database-backup-verified'], { backup_path: backupResult.path, backup_sha256: backupResult.sha256 }); await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal); await input.afterBoundary?.('after-backup');
      inspection = inspectLegacy(paths, input.repoKey, repository);
      inspection = reconcileMixedCoordinatorAuthority(inspectCoordinatorReadOnly(paths, input.repoKey, true), inspection);
      const secondDrift = recheckEntries(journal.snapshot_entries);
      if (secondDrift.length > 0 || aggregateDigest(inspection.sourceEntries, inspection.gitSnapshot) !== snapshotSha) failure('blocked', 'legacy source drifted before transactional import; migration remains frozen', secondDrift);
      const finalReport = baseReport('apply', input.repoKey, inspection, now, 'imported', journal.migration_id, snapshotSha, backupResult.path, null);
      const plan = buildImportPlan(inspection, repository, input.repoKey, journal.migration_id, snapshotSha, migrationPaths.journalPath, finalReport);
      const committedReport = await withMigrationStoreAuthority(paths, 'migration apply import', async () => {
        const importStore = await CoordinatorStore.open(paths, clock);
        try {
          const effect = importStore.importLegacyCoordination(plan);
          return parseMigrationReport(effect.payload['report']);
        } finally { importStore.close(); }
      });
      await input.afterBoundary?.('after-import-commit-before-journal');
      journal = nextJournal(journal, 'imported', committedReport, now, ['transactional-import-committed'], { snapshot_sha256: snapshotSha, snapshot_entries: inspection.sourceEntries, git_snapshot: inspection.gitSnapshot, backup_path: backupResult.path, backup_sha256: backupResult.sha256 }); await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal); await input.afterBoundary?.('after-import');
      return committedReport;
    }
    if (input.command === 'rollback') {
      if (journal.state === 'rolled-back') return journal.report;
      if (journal.state !== 'rollback-restoring' && journal.state !== 'rollback-restored' && journal.state !== 'rollback-unfreezing') {
        const restoringReport = { ...journal.report, command: 'rollback' as const, state: 'rollback-restoring' as const, dry_run: false, created_at: now.toISOString() };
        journal = nextJournal(journal, 'rollback-restoring', restoringReport, now, ['rollback-authority-intent-journaled', 'freeze-retained-through-restore']);
        await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
        await input.afterBoundary?.('after-rollback-intent');
      }
      if (journal.state === 'rollback-restoring') {
        const restoringJournal = journal;
        if (restoringJournal.backup_path !== null) await withMigrationStoreAuthority(paths, 'migration rollback restore', async () => { await restorePreImportBoundary(paths, restoringJournal); });
        await input.afterBoundary?.('after-rollback-restore-before-journal');
        const restoredReport = { ...journal.report, command: 'rollback' as const, state: 'rollback-restored' as const, dry_run: false, created_at: now.toISOString() };
        journal = nextJournal(journal, 'rollback-restored', restoredReport, now, journal.backup_path === null ? ['pre-import-database-was-never-mutated'] : ['database-backup-restored']);
        await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
        await input.afterBoundary?.('after-rollback-restore');
      }
      if (journal.state === 'rollback-restored') {
        const rollbackInspection = inspectLegacy(paths, input.repoKey, repository);
        const drift = Object.freeze([...recheckEntries(journal.snapshot_entries), ...recheckGitSnapshot(journal.git_snapshot, rollbackInspection.rows, repository)]);
        if (drift.length > 0) failure('blocked', 'database boundary is restored but legacy or Git state drifted while frozen; freeze remains active', drift);
        const unfreezingReport = { ...journal.report, command: 'rollback' as const, state: 'rollback-unfreezing' as const, dry_run: false, created_at: now.toISOString() };
        journal = nextJournal(journal, 'rollback-unfreezing', unfreezingReport, now, ['legacy-hashes-rechecked', 'rollback-verified-before-unfreeze']);
        await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
        await input.afterBoundary?.('after-rollback-verified');
      }
      await rm(migrationPaths.freezePath, { force: true });
      fsyncParentDirectory(migrationPaths.freezePath);
      await input.afterBoundary?.('after-rollback-unfreeze');
      const report = { ...journal.report, command: 'rollback' as const, state: 'rolled-back' as const, dry_run: false, created_at: now.toISOString() };
      journal = nextJournal(journal, 'rolled-back', report, now, ['legacy-unfrozen-after-restore']);
      await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
      return report;
    }
    if (input.command === 'verify') {
      if (journal.state !== 'imported' && journal.state !== 'verified' && journal.state !== 'cutover-ready') failure('blocked', 'verify requires a completed transactional import');
      const driftInspection = inspectLegacy(paths, input.repoKey, repository);
      const drift = Object.freeze([...recheckEntries(journal.snapshot_entries), ...recheckGitSnapshot(journal.git_snapshot, driftInspection.rows, repository)]);
      if (drift.length > 0) {
        const restoreIntentReport = { ...journal.report, command: 'verify' as const, state: 'frozen' as const, created_at: now.toISOString() };
        journal = nextJournal(journal, 'frozen', restoreIntentReport, now, ['source-drift-detected', 'verification-restore-intent-journaled', 'freeze-retained-through-restore']);
        await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
        const restoreJournal = journal;
        await withMigrationStoreAuthority(paths, 'migration verification restore', async () => { await restorePreImportBoundary(paths, restoreJournal); });
        const report = { ...journal.report, command: 'verify' as const, state: 'frozen' as const, snapshot_sha256: null, created_at: now.toISOString() };
        journal = nextJournal(journal, 'frozen', report, now, ['candidate-import-restored'], { snapshot_sha256: null, snapshot_entries: [], git_snapshot: [] });
        await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
        failure('blocked', 'legacy source hash drift rejected verification; fresh snapshot/apply is required', drift);
      }
      const inspection = inspectLegacy(paths, input.repoKey, repository);
      const fsBlockers = inspection.blockers.filter((blocker) => !blocker.startsWith('reachable legacy client'));
      if (fsBlockers.length > 0) failure('blocked', 'filesystem/Git verification failed', fsBlockers);
      const verifyJournal = journal;
      return await withMigrationStoreAuthority(paths, 'migration verify', async () => {
        const store = await CoordinatorStore.open(paths, clock);
        try {
          store.verifyMigrationImport(input.repoKey, verifyJournal.migration_id);
          const verifiedReport = { ...verifyJournal.report, command: 'verify' as const, state: 'verified' as const, dry_run: false, created_at: now.toISOString() };
          store.updateMigrationState(input.repoKey, verifyJournal.migration_id, 'verified', verifiedReport);
          await input.afterBoundary?.('after-verified-store-before-journal');
          const verifiedJournal = nextJournal(verifyJournal, 'verified', verifiedReport, now, ['source-hashes-rechecked-before-verify', 'database-invariants-verified', 'filesystem-git-verified']);
          journal = verifiedJournal; await writeJournal(paths.stateRoot, migrationPaths.journalPath, verifiedJournal); await input.afterBoundary?.('after-verified');
          const readyReport = { ...verifiedReport, state: 'cutover-ready' as const };
          store.updateMigrationState(input.repoKey, verifiedJournal.migration_id, 'cutover-ready', readyReport);
          await input.afterBoundary?.('after-cutover-ready-store-before-journal');
          const readyJournal = nextJournal(verifiedJournal, 'cutover-ready', readyReport, now, ['cutover-ready-recorded']);
          journal = readyJournal; await writeJournal(paths.stateRoot, migrationPaths.journalPath, readyJournal); await input.afterBoundary?.('after-cutover-ready');
          return readyReport;
        } finally { store.close(); }
      });
    }
    if (journal.state === 'legacy-archived') {
      await rm(migrationPaths.freezePath, { force: true });
      fsyncParentDirectory(migrationPaths.freezePath);
      if (!journal.completed_effects.includes('migration-freeze-removed-after-health')) {
        journal = nextJournal(journal, 'legacy-archived', journal.report, now, ['migration-freeze-removed-after-health']);
        await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
      }
      return journal.report;
    }
    if (journal.state !== 'cutover-ready' && journal.state !== 'cutover-committed') failure('blocked', 'cutover requires verified cutover-ready state');
    // This is acquired before the one-way marker. Therefore a live current or
    // predecessor coordinator fails cutover without committing the marker.
    const cutoverAuthority = await acquireMigrationStoreAuthority(paths, 'migration cutover');
    let finalReport: CoordinationMigrationReport;
    let healthServer: Awaited<ReturnType<typeof startCoordinatorServer>>;
    try {
    if (marker === null) {
      const driftInspection = inspectLegacy(paths, input.repoKey, repository);
      const drift = Object.freeze([...recheckEntries(journal.snapshot_entries), ...recheckGitSnapshot(journal.git_snapshot, driftInspection.rows, repository)]);
      if (drift.length > 0) failure('blocked', 'legacy source or Git state drift rejected cutover', drift);
      const store = await CoordinatorStore.open(paths, clock);
      let databaseSha: `sha256:${string}`;
      try { store.verifyMigrationImport(input.repoKey, journal.migration_id); databaseSha = store.databaseDigest(); }
      finally { store.close(); }
      if (journal.snapshot_sha256 === null) failure('blocked', 'cutover-ready journal lacks snapshot digest');
      const cutoverMarker: CoordinationCutoverMarker = { schema_version: COORDINATION_CUTOVER_MARKER_SCHEMA, repo_key: input.repoKey, snapshot_sha256: journal.snapshot_sha256, database_sha256: databaseSha, committed_at: now.toISOString(), migration_id: journal.migration_id };
      await atomicJson(paths.stateRoot, migrationPaths.cutoverMarkerPath, cutoverMarker, 0o400);
      await input.afterBoundary?.('after-cutover-marker-before-journal');
      const committedReport = { ...journal.report, command: 'cutover' as const, state: 'cutover-committed' as const, dry_run: false, cutover_marker_path: migrationPaths.cutoverMarkerPath, created_at: now.toISOString() };
      journal = nextJournal(journal, 'cutover-committed', committedReport, now, ['source-hashes-rechecked-before-cutover', 'cutover-marker-committed']); await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal); await input.afterBoundary?.('after-cutover-marker');
      const recordStore = await CoordinatorStore.open(paths, clock); try { recordStore.updateMigrationState(input.repoKey, journal.migration_id, 'cutover-committed', committedReport); } finally { recordStore.close(); }
      await input.afterBoundary?.('after-cutover-store');
    }
    await promoteRuntimeProjections(paths.stateRoot, journal.snapshot_entries, input.repoKey);
    await input.afterBoundary?.('after-runtime-projections');
    await archiveLegacy(paths.stateRoot, journal.snapshot_entries, migrationPaths);
    await input.afterBoundary?.('after-legacy-files-archived-before-store');
    const postStore = await CoordinatorStore.open(paths, clock);
    try {
      postStore.verifyMigrationImport(input.repoKey, journal.migration_id);
      finalReport = { ...journal.report, command: 'cutover', state: 'legacy-archived', dry_run: false, cutover_marker_path: migrationPaths.cutoverMarkerPath, created_at: now.toISOString() };
      postStore.updateMigrationState(input.repoKey, journal.migration_id, 'legacy-archived', finalReport);
    } finally { postStore.close(); }
    await input.afterBoundary?.('after-legacy-archive-store-before-journal');
    // Adopt the already-held lifecycle election and atomically replace its live
    // predecessor fence. There is no post-marker election or old-lock gap.
    healthServer = await startCoordinatorServer(paths, clock, cutoverAuthority.startupAdoption());
    } catch (error) {
      await cutoverAuthority.release();
      throw error;
    }
    try {
      const healthClient = new CoordinatorClient({ env: { ...(input.env ?? process.env), AUTOPILOT_STATE_ROOT: paths.stateRoot }, autoStart: false });
      const doctor = await healthClient.query('doctor');
      if (doctor.payload['integrity'] !== 'ok' || doctor.payload['healthy'] !== true) failure('blocked', 'post-cutover coordinator/client health verification failed');
      const status = await healthClient.query('status', input.repoKey, null);
      const repositories = status.payload['repositories'];
      const runs = status.payload['runs'];
      const resources = status.payload['run_resources'];
      if (!Array.isArray(repositories) || repositories.length !== 1 || !Array.isArray(runs) || !Array.isArray(resources) || resources.length !== runs.length) failure('blocked', 'post-cutover client cannot observe exact repository/run-resource identity');
    } finally { await healthServer.close(); }
    journal = nextJournal(journal, 'legacy-archived', finalReport, now, ['runtime-projections-rebound', 'legacy-files-archived-read-only', 'post-cutover-health-verified', 'migration-freeze-removal-pending']); await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal); await input.afterBoundary?.('after-legacy-archive');
    await rm(migrationPaths.freezePath, { force: true });
    fsyncParentDirectory(migrationPaths.freezePath);
    await input.afterBoundary?.('after-cutover-unfreeze');
    journal = nextJournal(journal, 'legacy-archived', finalReport, now, ['migration-freeze-removed-after-health']);
    await writeJournal(paths.stateRoot, migrationPaths.journalPath, journal);
    return finalReport;
  } finally {
    try { if (lock !== null) await lock.release(); }
    finally { await globalLock.release(); }
  }
}

export function coordinationMigrationUsage(): string {
  const repo = '[--repo-key <key> | --repo-root <absolute-path>]';
  return [`autopilot-coordinator migrate --dry-run ${repo} [--state-root <absolute-path>]`, `autopilot-coordinator migrate --apply ${repo} [--state-root <absolute-path>]`, `autopilot-coordinator verify ${repo} [--state-root <absolute-path>]`, `autopilot-coordinator rollback ${repo} [--state-root <absolute-path>]`, `autopilot-coordinator cutover ${repo} [--state-root <absolute-path>]`].join('\n');
}
