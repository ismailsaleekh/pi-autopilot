import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, writeSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { createCoherentSqliteSnapshot, type CoherentSqliteSnapshot } from './sqlite-snapshot.ts';

export type ControlledCloneInjection = 'none' | 'counter-behind' | 'counter-ahead' | 'payload-owner-ambiguous' | 'physical-integrity';

export interface ForkedScenarioState {
  readonly scenario_id: string;
  readonly state_root: string;
  readonly database_path: string;
  readonly snapshot: CoherentSqliteSnapshot;
  readonly selected_repo_id: string;
  readonly faulted_run: string;
  readonly healthy_run: string;
  readonly injection: ControlledCloneInjection;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function trySelectI4Subjects(database: DatabaseSync): { readonly repo_id: string; readonly faulted_run: string; readonly healthy_run: string } | null {
  for (const repository of database.prepare('SELECT repo_id FROM repositories ORDER BY repo_id').all()) {
    const repoId = repository['repo_id'];
    if (typeof repoId !== 'string') throw new Error('C5 I4 repository identity is malformed');
    const rows = database.prepare('SELECT workstream_run FROM runs WHERE repo_id=? ORDER BY workstream_run LIMIT 2').all(repoId);
    const first = rows[0]?.['workstream_run'];
    const second = rows[1]?.['workstream_run'];
    if (rows.length === 2 && typeof first === 'string' && typeof second === 'string') return Object.freeze({ repo_id: repoId, faulted_run: first, healthy_run: second });
  }
  return null;
}

export function selectI4Subjects(database: DatabaseSync): { readonly repo_id: string; readonly faulted_run: string; readonly healthy_run: string } {
  const selected = trySelectI4Subjects(database);
  if (selected === null) throw new Error('C5 I4 clone has no repository with two well-formed durable runs');
  return selected;
}

function injectLogical(databasePath: string, injection: Exclude<ControlledCloneInjection, 'none' | 'physical-integrity'>): { readonly repo_id: string; readonly faulted_run: string; readonly healthy_run: string } {
  const database = new DatabaseSync(databasePath, { timeout: 30_000 });
  try {
    database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const selected = selectI4Subjects(database);
    const maximumRow = database.prepare('SELECT MAX(event_seq) AS maximum FROM events WHERE repo_id=?').get(selected.repo_id);
    const maximum = maximumRow?.['maximum'];
    if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error('C5 I4 repository lacks bounded immutable event history');
    if (injection === 'counter-behind') database.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(maximum - 1, selected.repo_id);
    else if (injection === 'counter-ahead') database.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(maximum + 1, selected.repo_id);
    else {
      const row = database.prepare('SELECT payload_json FROM run_resources WHERE repo_id=? AND workstream_run=?').get(selected.repo_id, selected.faulted_run);
      const payloadText = row?.['payload_json'];
      if (typeof payloadText !== 'string') throw new Error('C5 I4 owner-ambiguity run has no exact run-resource row');
      const payload: unknown = JSON.parse(payloadText);
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('C5 I4 owner-ambiguity source payload is malformed');
      const changed = database.prepare('UPDATE run_resources SET payload_json=? WHERE repo_id=? AND workstream_run=?').run(JSON.stringify({ ...payload, workstream_run: selected.healthy_run }), selected.repo_id, selected.faulted_run);
      if (changed.changes !== 1) throw new Error('C5 I4 owner-ambiguity injection did not target one row');
    }
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    return selected;
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally { database.close(); }
}

function injectPhysical(databasePath: string): void {
  const descriptor = openSync(databasePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 4096) throw new Error('C5 physical-fault scenario database is not a bounded independent regular file');
    const corruption = new Uint8Array(64).fill(0xff);
    const written = writeSync(descriptor, corruption, 0, corruption.byteLength, 100);
    if (written !== corruption.byteLength) throw new Error('C5 physical-fault injection was incomplete');
  } finally { closeSync(descriptor); }
}

export async function forkScenarioState(input: {
  readonly rehearsal_id: string;
  readonly corpus_id: string;
  readonly sandbox_root: string;
  readonly base_database_path: string;
  readonly scenario_id: string;
  readonly injection: ControlledCloneInjection;
}): Promise<ForkedScenarioState> {
  const sandboxRoot = resolve(input.sandbox_root);
  const stateRoot = resolve(sandboxRoot, 'incident-states', input.scenario_id, 'state');
  if (!inside(sandboxRoot, stateRoot) || existsSync(stateRoot)) throw new Error('C5 incident scenario state destination is outside authority or already exists');
  const paths = coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  const rawSnapshot = join(sandboxRoot, 'incident-states', input.scenario_id, 'private', 'source-raw', 'coordinator.db');
  await mkdir(paths.coordinatorRoot, { recursive: true, mode: 0o700 });
  const snapshot = await createCoherentSqliteSnapshot({ rehearsal_id: input.rehearsal_id, corpus_id: input.corpus_id, source_database_path: input.base_database_path, raw_snapshot_database_path: rawSnapshot, copy_database_path: paths.databasePath, expected_user_version: 12 });
  const capability = await open(paths.capabilityPath, 'wx', 0o600);
  try { await capability.writeFile(`${randomBytes(32).toString('hex')}\n`, 'utf8'); await capability.sync(); }
  finally { await capability.close(); }
  const inspect = new DatabaseSync(paths.databasePath, { readOnly: true, timeout: 30_000 });
  let selected: { readonly repo_id: string; readonly faulted_run: string; readonly healthy_run: string };
  try { inspect.exec('PRAGMA query_only=ON'); selected = selectI4Subjects(inspect); }
  finally { inspect.close(); }
  if (input.injection === 'counter-behind' || input.injection === 'counter-ahead' || input.injection === 'payload-owner-ambiguous') selected = injectLogical(paths.databasePath, input.injection);
  else if (input.injection === 'physical-integrity') injectPhysical(paths.databasePath);
  return Object.freeze({ scenario_id: input.scenario_id, state_root: stateRoot, database_path: paths.databasePath, snapshot, selected_repo_id: selected.repo_id, faulted_run: selected.faulted_run, healthy_run: selected.healthy_run, injection: input.injection });
}
