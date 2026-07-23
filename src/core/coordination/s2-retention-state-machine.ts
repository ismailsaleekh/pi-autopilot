import { createHash } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { readImmutableFileBytes } from './immutable-file.ts';

export type S2RetentionRunLaneStatus = 'running' | 'paused';
export type S2RetentionPublicationLaneStatus = 'open' | 'blocked';

export interface S2RetentionRunLane {
  readonly workstream_run: string;
  readonly new_worktree_creation: S2RetentionRunLaneStatus;
  readonly evidence_publication: S2RetentionPublicationLaneStatus;
  readonly diagnostics_publication: S2RetentionPublicationLaneStatus;
  readonly disk_pressure_reason: string | null;
  readonly disk_pressure_event_seq: number | null;
}

export interface S2RetentionProgressModel {
  readonly schema_version: 'autopilot.s2_retention.progress_model.v1';
  readonly lanes: readonly S2RetentionRunLane[];
}

export interface S2RetentionDiskPressureEvent {
  readonly offendingRun: string;
  readonly reason: string;
  readonly eventSeq: number;
}

const S2_PRESSURE_STATE_MAX_BYTES = 64 * 1024;
const S2_PRESSURE_STATE_FILE = '_s2-retention-pressure-state.json';

function laneFor(run: string): S2RetentionRunLane {
  return {
    workstream_run: run,
    new_worktree_creation: 'running',
    evidence_publication: 'open',
    diagnostics_publication: 'open',
    disk_pressure_reason: null,
    disk_pressure_event_seq: null,
  };
}

function compareLanes(left: S2RetentionRunLane, right: S2RetentionRunLane): number {
  return left.workstream_run < right.workstream_run ? -1 : left.workstream_run > right.workstream_run ? 1 : 0;
}

function sha256HexUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function nullableString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string or null`);
  return value;
}

function nullableSeq(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative safe integer or null`);
  return value;
}

function parseRunLaneStatus(value: string): S2RetentionRunLaneStatus {
  if (value === 'running' || value === 'paused') return value;
  throw new Error('new_worktree_creation is invalid');
}

function parsePublicationLaneStatus(value: string): S2RetentionPublicationLaneStatus {
  if (value === 'open' || value === 'blocked') return value;
  throw new Error('publication lane status is invalid');
}

function parseProgressModel(bytes: Uint8Array): S2RetentionProgressModel {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isJsonRecord(parsed)) throw new Error('s2 pressure state must be a JSON object');
  if (requiredString(parsed, 'schema_version') !== 'autopilot.s2_retention.progress_model.v1') throw new Error('s2 pressure state schema_version is invalid');
  const lanesValue = parsed['lanes'];
  if (!Array.isArray(lanesValue)) throw new Error('s2 pressure state lanes must be an array');
  const lanes: S2RetentionRunLane[] = lanesValue.map((value: unknown): S2RetentionRunLane => {
    if (!isJsonRecord(value)) throw new Error('s2 pressure state lane must be a JSON object');
    return {
      workstream_run: requiredString(value, 'workstream_run'),
      new_worktree_creation: parseRunLaneStatus(requiredString(value, 'new_worktree_creation')),
      evidence_publication: parsePublicationLaneStatus(requiredString(value, 'evidence_publication')),
      diagnostics_publication: parsePublicationLaneStatus(requiredString(value, 'diagnostics_publication')),
      disk_pressure_reason: nullableString(value, 'disk_pressure_reason'),
      disk_pressure_event_seq: nullableSeq(value, 'disk_pressure_event_seq'),
    };
  });
  return { schema_version: 'autopilot.s2_retention.progress_model.v1', lanes: lanes.sort(compareLanes) };
}

async function atomicWriteUtf8(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const parentStat = await lstat(dirname(path));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('s2 pressure state parent must be a non-symbolic directory');
  const temporary = join(dirname(path), `.${basename(path)}.${sha256HexUtf8(`${path}:${contents}`).slice(0, 16)}.tmp`);
  await rm(temporary, { force: true });
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  const file = await open(temporary, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export function createS2RetentionProgressModel(runs: readonly string[]): S2RetentionProgressModel {
  const uniqueRuns = [...new Set(runs)];
  return { schema_version: 'autopilot.s2_retention.progress_model.v1', lanes: uniqueRuns.map(laneFor).sort(compareLanes) };
}

export function applyS2RetentionDiskPressure(model: S2RetentionProgressModel, event: S2RetentionDiskPressureEvent): S2RetentionProgressModel {
  if (!Number.isSafeInteger(event.eventSeq) || event.eventSeq < 0) throw new Error('disk pressure eventSeq must be a non-negative safe integer');
  if (event.offendingRun.length === 0) throw new Error('offendingRun must be non-empty');
  const lanes = new Map<string, S2RetentionRunLane>();
  for (const lane of model.lanes) lanes.set(lane.workstream_run, lane);
  const previous = lanes.get(event.offendingRun) ?? laneFor(event.offendingRun);
  lanes.set(event.offendingRun, {
    ...previous,
    new_worktree_creation: 'paused',
    evidence_publication: 'open',
    diagnostics_publication: 'open',
    disk_pressure_reason: event.reason,
    disk_pressure_event_seq: event.eventSeq,
  });
  return { schema_version: 'autopilot.s2_retention.progress_model.v1', lanes: [...lanes.values()].sort(compareLanes) };
}

export function clearS2RetentionDiskPressure(model: S2RetentionProgressModel, run: string, observedEventSeq: number): S2RetentionProgressModel {
  if (!Number.isSafeInteger(observedEventSeq) || observedEventSeq < 0) throw new Error('observedEventSeq must be a non-negative safe integer');
  return {
    schema_version: 'autopilot.s2_retention.progress_model.v1',
    lanes: model.lanes.map((lane): S2RetentionRunLane => {
      if (lane.workstream_run !== run) return lane;
      if (lane.disk_pressure_event_seq !== observedEventSeq) return lane;
      return {
        ...lane,
        new_worktree_creation: 'running',
        disk_pressure_reason: null,
        disk_pressure_event_seq: null,
      };
    }).sort(compareLanes),
  };
}

export function s2RetentionRunsPausedForWorktreeCreation(model: S2RetentionProgressModel): readonly string[] {
  return model.lanes.filter((lane) => lane.new_worktree_creation === 'paused').map((lane) => lane.workstream_run);
}

export function s2RetentionPressureStatePath(retentionRoot: string): string {
  return join(resolve(retentionRoot), S2_PRESSURE_STATE_FILE);
}

export async function readS2RetentionProgressState(path: string): Promise<S2RetentionProgressModel> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return createS2RetentionProgressModel([]);
    throw error;
  }
  return parseProgressModel(readImmutableFileBytes({ path, maximumBytes: S2_PRESSURE_STATE_MAX_BYTES, label: 's2 retention pressure state' }));
}

export async function writeS2RetentionProgressState(path: string, model: S2RetentionProgressModel): Promise<void> {
  const bytes = canonicalJson(model);
  if (Buffer.byteLength(bytes, 'utf8') > S2_PRESSURE_STATE_MAX_BYTES) throw new Error('s2 retention pressure state exceeds byte limit');
  parseProgressModel(new TextEncoder().encode(bytes));
  await atomicWriteUtf8(path, bytes);
}

export async function recordS2RetentionDiskPressure(path: string, event: S2RetentionDiskPressureEvent): Promise<S2RetentionProgressModel> {
  const next = applyS2RetentionDiskPressure(await readS2RetentionProgressState(path), event);
  await writeS2RetentionProgressState(path, next);
  return next;
}

export async function clearDurableS2RetentionDiskPressure(path: string, run: string, observedEventSeq: number): Promise<S2RetentionProgressModel> {
  const next = clearS2RetentionDiskPressure(await readS2RetentionProgressState(path), run, observedEventSeq);
  await writeS2RetentionProgressState(path, next);
  return next;
}
