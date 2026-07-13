import { CoordinationRuntimeError } from './failures.ts';

/** Exact one-hop compatibility path from the executable aa3e377 package. */
const COORDINATOR_UPGRADE_SOURCE = Object.freeze({
  package_build: '0.13.0-cf34',
  protocol_version: '1.2',
  database_schema_version: 6,
  lifecycle_lock_schema: 'autopilot.coordinator_lock.v1',
} as const);
const COORDINATOR_UPGRADE_TARGET = Object.freeze({
  package_build: '1.0.1-cf38',
  protocol_version: '1.3',
  database_schema_version: 9,
  lifecycle_lock_schema: 'autopilot.coordinator_lock.v2',
} as const);
export const COORDINATOR_UPGRADE_PATH = Object.freeze({ source: COORDINATOR_UPGRADE_SOURCE, target: COORDINATOR_UPGRADE_TARGET });

export const COORDINATOR_UPGRADE_INTENT_SCHEMA = 'autopilot.coordinator_upgrade_intent.v1' as const;
export const COORDINATOR_UPGRADE_BACKUP_SCHEMA = 'autopilot.coordinator_upgrade_backup.v1' as const;

export type CoordinatorUpgradeState =
  | 'prepared'
  | 'draining'
  | 'refused'
  | 'preflight-backed-up'
  | 'retiring'
  | 'retired'
  | 'final-backed-up'
  | 'barrier-installed'
  | 'migration-verified'
  | 'starting'
  | 'reconnect-verified'
  | 'committed'
  | 'rollback-restoring'
  | 'rollback-restored'
  | 'recovery-required';

/** Exact old-format record understood by aa3e377; also used as its live fence. */
export interface PredecessorCoordinatorLock {
  readonly schema_version: 'autopilot.coordinator_lock.v1';
  readonly pid: number;
  readonly boot_id: string;
  readonly token: string;
  readonly started_at: string;
}

export interface CurrentCoordinatorLock {
  readonly schema_version: 'autopilot.coordinator_lock.v2';
  readonly pid: number;
  readonly boot_id: string;
  readonly process_start_identity: string;
  readonly token: string;
  readonly instance_id: string;
  readonly package_build: '1.0.1-cf38';
  readonly protocol_version: '1.3';
  readonly database_schema_version: 9;
  readonly started_at: string;
}

export interface CoordinatorUpgradeBackup {
  readonly schema_version: typeof COORDINATOR_UPGRADE_BACKUP_SCHEMA;
  readonly path: string;
  readonly sha256: `sha256:${string}`;
  readonly source_database_schema_version: 6;
  readonly integrity: 'ok';
  readonly created_at: string;
}

export interface CoordinatorUpgradeIntent {
  readonly schema_version: typeof COORDINATOR_UPGRADE_INTENT_SCHEMA;
  readonly upgrade_id: string;
  readonly state: CoordinatorUpgradeState;
  readonly source: {
    readonly package_build: '0.13.0-cf34';
    readonly protocol_version: '1.2';
    readonly database_schema_version: 6;
    readonly pid: number;
    readonly boot_id: string;
    readonly process_start_identity: string;
    readonly lock_token: string;
    readonly lock_started_at: string;
  };
  readonly target: typeof COORDINATOR_UPGRADE_PATH.target;
  readonly safe_checkpoints: readonly string[];
  readonly blockers: readonly string[];
  readonly predecessor_fence: PredecessorCoordinatorLock | null;
  readonly backup: CoordinatorUpgradeBackup | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly failure: string | null;
}

export interface PredecessorStatus {
  readonly package_build: '0.13.0-cf34';
  readonly protocol_version: '1.2';
  readonly database_schema_version: 6;
  readonly runs: readonly { readonly repo_id: string; readonly workstream_run: string; readonly status: string }[];
  readonly unit_attempts: readonly {
    readonly owner: { readonly repo_id: string; readonly workstream_run: string; readonly unit_id: string; readonly attempt: number };
    readonly state: string;
    readonly preemptible: boolean;
    readonly checkpoint_ordinal: number;
    readonly critical_section: string | null;
  }[];
  readonly worktree_operations: readonly { readonly operation_id: string; readonly stage: string }[];
}

interface JsonRecord { readonly [key: string]: unknown }

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('schema-mismatch', `${label} must be an object`);
  return value as JsonRecord;
}

function exact(recordValue: JsonRecord, fields: readonly string[], label: string): void {
  const actual = Object.keys(recordValue).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) throw new CoordinationRuntimeError('schema-mismatch', `${label} fields are incompatible`, actual);
}

function text(recordValue: JsonRecord, field: string, label: string): string {
  const value = recordValue[field];
  if (typeof value !== 'string' || value.length === 0) throw new CoordinationRuntimeError('schema-mismatch', `${label}.${field} must be non-empty text`);
  return value;
}

function integer(recordValue: JsonRecord, field: string, label: string, minimum = 0): number {
  const value = recordValue[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new CoordinationRuntimeError('schema-mismatch', `${label}.${field} must be an integer >= ${String(minimum)}`);
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new CoordinationRuntimeError('schema-mismatch', `${label} must be a text array`);
  return Object.freeze(value as string[]);
}

function parseSource(value: unknown): CoordinatorUpgradeIntent['source'] {
  const source = record(value, 'upgrade intent source');
  exact(source, ['package_build', 'protocol_version', 'database_schema_version', 'pid', 'boot_id', 'process_start_identity', 'lock_token', 'lock_started_at'], 'upgrade intent source');
  if (source['package_build'] !== COORDINATOR_UPGRADE_PATH.source.package_build || source['protocol_version'] !== COORDINATOR_UPGRADE_PATH.source.protocol_version || source['database_schema_version'] !== COORDINATOR_UPGRADE_PATH.source.database_schema_version) throw new CoordinationRuntimeError('protocol-mismatch', 'upgrade intent source is not the locked predecessor');
  return {
    package_build: COORDINATOR_UPGRADE_PATH.source.package_build,
    protocol_version: COORDINATOR_UPGRADE_PATH.source.protocol_version,
    database_schema_version: COORDINATOR_UPGRADE_PATH.source.database_schema_version,
    pid: integer(source, 'pid', 'upgrade intent source', 1),
    boot_id: text(source, 'boot_id', 'upgrade intent source'),
    process_start_identity: text(source, 'process_start_identity', 'upgrade intent source'),
    lock_token: text(source, 'lock_token', 'upgrade intent source'),
    lock_started_at: text(source, 'lock_started_at', 'upgrade intent source'),
  };
}

export function parsePredecessorCoordinatorLock(value: unknown): PredecessorCoordinatorLock | null {
  try {
    const lock = record(value, 'predecessor lifecycle lock');
    exact(lock, ['schema_version', 'pid', 'boot_id', 'token', 'started_at'], 'predecessor lifecycle lock');
    if (lock['schema_version'] !== COORDINATOR_UPGRADE_PATH.source.lifecycle_lock_schema) return null;
    return { schema_version: COORDINATOR_UPGRADE_PATH.source.lifecycle_lock_schema, pid: integer(lock, 'pid', 'predecessor lifecycle lock', 1), boot_id: text(lock, 'boot_id', 'predecessor lifecycle lock'), token: text(lock, 'token', 'predecessor lifecycle lock'), started_at: text(lock, 'started_at', 'predecessor lifecycle lock') };
  } catch { return null; }
}

export function parseCurrentCoordinatorLock(value: unknown): CurrentCoordinatorLock | null {
  try {
    const lock = record(value, 'current lifecycle lock');
    exact(lock, ['schema_version', 'pid', 'boot_id', 'process_start_identity', 'token', 'instance_id', 'package_build', 'protocol_version', 'database_schema_version', 'started_at'], 'current lifecycle lock');
    if (lock['schema_version'] !== COORDINATOR_UPGRADE_PATH.target.lifecycle_lock_schema || lock['package_build'] !== COORDINATOR_UPGRADE_PATH.target.package_build || lock['protocol_version'] !== COORDINATOR_UPGRADE_PATH.target.protocol_version || lock['database_schema_version'] !== COORDINATOR_UPGRADE_PATH.target.database_schema_version) return null;
    return {
      schema_version: COORDINATOR_UPGRADE_PATH.target.lifecycle_lock_schema,
      pid: integer(lock, 'pid', 'current lifecycle lock', 1),
      boot_id: text(lock, 'boot_id', 'current lifecycle lock'),
      process_start_identity: text(lock, 'process_start_identity', 'current lifecycle lock'),
      token: text(lock, 'token', 'current lifecycle lock'),
      instance_id: text(lock, 'instance_id', 'current lifecycle lock'),
      package_build: COORDINATOR_UPGRADE_PATH.target.package_build,
      protocol_version: COORDINATOR_UPGRADE_PATH.target.protocol_version,
      database_schema_version: COORDINATOR_UPGRADE_PATH.target.database_schema_version,
      started_at: text(lock, 'started_at', 'current lifecycle lock'),
    };
  } catch { return null; }
}

export function parseCoordinatorUpgradeBackup(value: unknown): CoordinatorUpgradeBackup {
  const backup = record(value, 'upgrade backup');
  exact(backup, ['schema_version', 'path', 'sha256', 'source_database_schema_version', 'integrity', 'created_at'], 'upgrade backup');
  const digest = text(backup, 'sha256', 'upgrade backup');
  if (backup['schema_version'] !== COORDINATOR_UPGRADE_BACKUP_SCHEMA || !/^sha256:[a-f0-9]{64}$/u.test(digest) || backup['source_database_schema_version'] !== 6 || backup['integrity'] !== 'ok') throw new CoordinationRuntimeError('schema-mismatch', 'upgrade backup contract is incompatible');
  return { schema_version: COORDINATOR_UPGRADE_BACKUP_SCHEMA, path: text(backup, 'path', 'upgrade backup'), sha256: digest as `sha256:${string}`, source_database_schema_version: 6, integrity: 'ok', created_at: text(backup, 'created_at', 'upgrade backup') };
}

export function parseCoordinatorUpgradeIntent(value: unknown): CoordinatorUpgradeIntent {
  const intent = record(value, 'upgrade intent');
  exact(intent, ['schema_version', 'upgrade_id', 'state', 'source', 'target', 'safe_checkpoints', 'blockers', 'predecessor_fence', 'backup', 'created_at', 'updated_at', 'failure'], 'upgrade intent');
  if (intent['schema_version'] !== COORDINATOR_UPGRADE_INTENT_SCHEMA) throw new CoordinationRuntimeError('schema-mismatch', 'upgrade intent schema is incompatible');
  const states: readonly CoordinatorUpgradeState[] = ['prepared', 'draining', 'refused', 'preflight-backed-up', 'retiring', 'retired', 'final-backed-up', 'barrier-installed', 'migration-verified', 'starting', 'reconnect-verified', 'committed', 'rollback-restoring', 'rollback-restored', 'recovery-required'];
  if (typeof intent['state'] !== 'string' || !states.includes(intent['state'] as CoordinatorUpgradeState)) throw new CoordinationRuntimeError('schema-mismatch', 'upgrade intent state is incompatible');
  const target = record(intent['target'], 'upgrade intent target');
  exact(target, ['package_build', 'protocol_version', 'database_schema_version', 'lifecycle_lock_schema'], 'upgrade intent target');
  if (target['package_build'] !== COORDINATOR_UPGRADE_PATH.target.package_build || target['protocol_version'] !== COORDINATOR_UPGRADE_PATH.target.protocol_version || target['database_schema_version'] !== COORDINATOR_UPGRADE_PATH.target.database_schema_version || target['lifecycle_lock_schema'] !== COORDINATOR_UPGRADE_PATH.target.lifecycle_lock_schema) throw new CoordinationRuntimeError('protocol-mismatch', 'upgrade intent target differs from this package');
  const failure = intent['failure'];
  if (failure !== null && typeof failure !== 'string') throw new CoordinationRuntimeError('schema-mismatch', 'upgrade intent failure must be nullable text');
  const predecessorFence = intent['predecessor_fence'] === null ? null : parsePredecessorCoordinatorLock(intent['predecessor_fence']);
  if (intent['predecessor_fence'] !== null && predecessorFence === null) throw new CoordinationRuntimeError('schema-mismatch', 'upgrade intent predecessor fence is invalid');
  return { schema_version: COORDINATOR_UPGRADE_INTENT_SCHEMA, upgrade_id: text(intent, 'upgrade_id', 'upgrade intent'), state: intent['state'] as CoordinatorUpgradeState, source: parseSource(intent['source']), target: COORDINATOR_UPGRADE_PATH.target, safe_checkpoints: stringArray(intent['safe_checkpoints'], 'upgrade intent safe_checkpoints'), blockers: stringArray(intent['blockers'], 'upgrade intent blockers'), predecessor_fence: predecessorFence, backup: intent['backup'] === null ? null : parseCoordinatorUpgradeBackup(intent['backup']), created_at: text(intent, 'created_at', 'upgrade intent'), updated_at: text(intent, 'updated_at', 'upgrade intent'), failure };
}

export function parsePredecessorStatusEnvelope(value: unknown, expectedRequestId: string): PredecessorStatus {
  const response = record(value, 'predecessor response');
  exact(response, ['schema_version', 'protocol_version', 'request_id', 'ok', 'committed_event_seq', 'error_code', 'retryable', 'payload'], 'predecessor response');
  if (response['schema_version'] !== 'autopilot.coordinator_response.v1' || response['protocol_version'] !== COORDINATOR_UPGRADE_PATH.source.protocol_version || response['request_id'] !== expectedRequestId || response['ok'] !== true || response['committed_event_seq'] !== null || response['error_code'] !== null || response['retryable'] !== false) throw new CoordinationRuntimeError('protocol-mismatch', 'predecessor did not return an exact successful 1.2 status envelope');
  const payload = record(response['payload'], 'predecessor status payload');
  if (payload['schema_version'] !== 'autopilot.coordinator_status.v1' || payload['package_build'] !== COORDINATOR_UPGRADE_PATH.source.package_build || payload['protocol_version'] !== COORDINATOR_UPGRADE_PATH.source.protocol_version || payload['database_schema_version'] !== COORDINATOR_UPGRADE_PATH.source.database_schema_version) throw new CoordinationRuntimeError('protocol-mismatch', 'running coordinator is not the locked 1.2 predecessor');
  const runsValue = payload['runs'];
  const attemptsValue = payload['unit_attempts'];
  const operationsValue = payload['worktree_operations'];
  if (!Array.isArray(runsValue) || !Array.isArray(attemptsValue) || !Array.isArray(operationsValue)) throw new CoordinationRuntimeError('schema-mismatch', 'predecessor status omitted upgrade-readiness collections');
  const runs = runsValue.map((entry) => { const run = record(entry, 'predecessor run'); return { repo_id: text(run, 'repo_id', 'predecessor run'), workstream_run: text(run, 'workstream_run', 'predecessor run'), status: text(run, 'status', 'predecessor run') }; });
  const unitAttempts = attemptsValue.map((entry) => {
    const attempt = record(entry, 'predecessor unit attempt');
    const owner = record(attempt['owner'], 'predecessor unit owner');
    const criticalSection = attempt['critical_section'];
    if (typeof attempt['preemptible'] !== 'boolean' || (criticalSection !== null && typeof criticalSection !== 'string')) throw new CoordinationRuntimeError('schema-mismatch', 'predecessor unit checkpoint contract is invalid');
    return { owner: { repo_id: text(owner, 'repo_id', 'predecessor unit owner'), workstream_run: text(owner, 'workstream_run', 'predecessor unit owner'), unit_id: text(owner, 'unit_id', 'predecessor unit owner'), attempt: integer(owner, 'attempt', 'predecessor unit owner', 1) }, state: text(attempt, 'state', 'predecessor unit attempt'), preemptible: attempt['preemptible'], checkpoint_ordinal: integer(attempt, 'checkpoint_ordinal', 'predecessor unit attempt'), critical_section: criticalSection };
  });
  const worktreeOperations = operationsValue.map((entry) => { const operation = record(entry, 'predecessor worktree operation'); return { operation_id: text(operation, 'operation_id', 'predecessor worktree operation'), stage: text(operation, 'stage', 'predecessor worktree operation') }; });
  return { package_build: COORDINATOR_UPGRADE_PATH.source.package_build, protocol_version: COORDINATOR_UPGRADE_PATH.source.protocol_version, database_schema_version: 6, runs: Object.freeze(runs), unit_attempts: Object.freeze(unitAttempts), worktree_operations: Object.freeze(worktreeOperations) };
}
