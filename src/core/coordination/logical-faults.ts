import { CoordinationRuntimeError } from './failures.ts';

export const AUTOPILOT_RUN_SCOPED_FAULT_SCHEMA = 'autopilot.run_scoped_fault.v1' as const;
export const RUN_SCOPED_FAULT_STATUSES = ['active', 'resolved'] as const;

export interface RunScopedLogicalFault {
  readonly schema_version: typeof AUTOPILOT_RUN_SCOPED_FAULT_SCHEMA;
  readonly fault_id: string;
  readonly invariant_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly fault_code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly status: (typeof RUN_SCOPED_FAULT_STATUSES)[number];
  readonly created_event_seq: number;
  readonly resolved_event_seq: number | null;
  readonly version: number;
}

function text(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new CoordinationRuntimeError('store-corrupt', `run-scoped fault ${field} is invalid`);
  return value;
}

function integer(record: Readonly<Record<string, unknown>>, field: string, nullable = false): number | null {
  const value = record[field];
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new CoordinationRuntimeError('store-corrupt', `run-scoped fault ${field} is invalid`);
  return value;
}

export function parseRunScopedLogicalFault(value: unknown): RunScopedLogicalFault {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('store-corrupt', 'run-scoped fault must be an object');
  const record = value as Readonly<Record<string, unknown>>;
  const fields = ['created_event_seq', 'detail', 'entity_id', 'entity_type', 'fault_code', 'fault_id', 'invariant_id', 'repo_id', 'resolved_event_seq', 'schema_version', 'status', 'version', 'workstream_run'];
  const actual = Object.keys(record).sort();
  if (actual.length !== fields.length || actual.some((field, index) => field !== [...fields].sort()[index])) throw new CoordinationRuntimeError('store-corrupt', 'run-scoped fault fields are closed', actual);
  if (record['schema_version'] !== AUTOPILOT_RUN_SCOPED_FAULT_SCHEMA) throw new CoordinationRuntimeError('store-corrupt', 'run-scoped fault schema is invalid');
  const detail = record['detail'];
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) throw new CoordinationRuntimeError('store-corrupt', 'run-scoped fault detail is invalid');
  // The object/null/array guard above proves the JSON object boundary.
  const detailRecord = detail as Readonly<Record<string, unknown>>;
  const status = record['status'];
  if (status !== 'active' && status !== 'resolved') throw new CoordinationRuntimeError('store-corrupt', 'run-scoped fault status is invalid');
  const created = integer(record, 'created_event_seq');
  const resolved = integer(record, 'resolved_event_seq', true);
  const version = integer(record, 'version');
  if (created === null || version === null || resolved !== null && resolved < created) throw new CoordinationRuntimeError('store-corrupt', 'run-scoped fault event/version ordering is invalid');
  return Object.freeze({
    schema_version: AUTOPILOT_RUN_SCOPED_FAULT_SCHEMA,
    fault_id: text(record, 'fault_id'),
    invariant_id: text(record, 'invariant_id'),
    repo_id: text(record, 'repo_id'),
    workstream_run: text(record, 'workstream_run'),
    entity_type: text(record, 'entity_type'),
    entity_id: text(record, 'entity_id'),
    fault_code: text(record, 'fault_code'),
    detail: detailRecord,
    status,
    created_event_seq: created,
    resolved_event_seq: resolved,
    version,
  });
}

export const SOURCE_CHANGING_DISPATCH_ACTIONS = Object.freeze(new Set([
  'register-child',
  'acquire-group',
  'prepare-operation',
] as const));
