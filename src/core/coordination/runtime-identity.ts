import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { open, readdir, rename, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, resolve } from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { COORDINATOR_API_SCHEMA_VERSION, COORDINATOR_IMPLEMENTATION_BUILD, COORDINATOR_LEGACY_FACADE_BUILD, COORDINATOR_STORE_SCHEMA_VERSION, COORDINATOR_WIRE_LINEAGE, enforcePrivateAuthorityPath, type CoordinatorRuntimePaths } from './runtime-paths.ts';
import type { CurrentStoreGeneration } from './store-generation.ts';
import { CoordinatorWriterGuard } from './writer-guard.ts';

export const COORDINATOR_RUNTIME_IDENTITY_SCHEMA = 'autopilot.coordinator_runtime_identity.v1' as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GENERATION_PATTERN = /^generation-[a-f0-9]{32}$/u;

export interface RuntimeLifecycleIdentity {
  readonly pid: number;
  readonly boot_id: string;
  readonly process_start_identity: string;
  readonly instance_id: string;
}

export interface CoordinatorRuntimeIdentity {
  readonly schema_version: typeof COORDINATOR_RUNTIME_IDENTITY_SCHEMA;
  readonly implementation_build: typeof COORDINATOR_IMPLEMENTATION_BUILD;
  readonly wire_lineage: typeof COORDINATOR_WIRE_LINEAGE;
  readonly api_schema_version: typeof COORDINATOR_API_SCHEMA_VERSION;
  readonly store_schema_version: typeof COORDINATOR_STORE_SCHEMA_VERSION;
  readonly legacy_facade_build: typeof COORDINATOR_LEGACY_FACADE_BUILD;
  readonly lifecycle_pid: number;
  readonly lifecycle_boot_id: string;
  readonly lifecycle_process_start_identity: string;
  readonly lifecycle_instance_id: string;
  readonly store_generation_id: string;
  readonly current_store_pointer_sha256: `sha256:${string}`;
  readonly published_at: string;
}

export interface PublishedRuntimeIdentity {
  readonly identity: CoordinatorRuntimeIdentity;
  readonly sha256: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity must be an object');
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity fields are closed', actual);
  return record;
}

function text(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new CoordinationRuntimeError('store-corrupt', `runtime identity ${field} is invalid`);
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity published_at is invalid');
  try { if (new Date(value).toISOString() !== value) throw new Error('noncanonical'); }
  catch { throw new CoordinationRuntimeError('store-corrupt', 'runtime identity published_at is invalid'); }
  return value;
}

export function parseCoordinatorRuntimeIdentity(value: unknown): CoordinatorRuntimeIdentity {
  const record = exactRecord(value, ['api_schema_version', 'current_store_pointer_sha256', 'implementation_build', 'legacy_facade_build', 'lifecycle_boot_id', 'lifecycle_instance_id', 'lifecycle_pid', 'lifecycle_process_start_identity', 'published_at', 'schema_version', 'store_generation_id', 'store_schema_version', 'wire_lineage']);
  if (record['schema_version'] !== COORDINATOR_RUNTIME_IDENTITY_SCHEMA
    || record['implementation_build'] !== COORDINATOR_IMPLEMENTATION_BUILD
    || record['wire_lineage'] !== COORDINATOR_WIRE_LINEAGE
    || record['api_schema_version'] !== COORDINATOR_API_SCHEMA_VERSION
    || record['store_schema_version'] !== COORDINATOR_STORE_SCHEMA_VERSION
    || record['legacy_facade_build'] !== COORDINATOR_LEGACY_FACADE_BUILD) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity build/wire/API/store split is invalid');
  const pid = record['lifecycle_pid'];
  const generation = record['store_generation_id'];
  const pointerDigest = record['current_store_pointer_sha256'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity lifecycle_pid is invalid');
  if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity store_generation_id is invalid');
  if (typeof pointerDigest !== 'string' || !SHA256_PATTERN.test(pointerDigest)) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity pointer digest is invalid');
  return Object.freeze({
    schema_version: COORDINATOR_RUNTIME_IDENTITY_SCHEMA,
    implementation_build: COORDINATOR_IMPLEMENTATION_BUILD,
    wire_lineage: COORDINATOR_WIRE_LINEAGE,
    api_schema_version: COORDINATOR_API_SCHEMA_VERSION,
    store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION,
    legacy_facade_build: COORDINATOR_LEGACY_FACADE_BUILD,
    lifecycle_pid: pid,
    lifecycle_boot_id: text(record, 'lifecycle_boot_id'),
    lifecycle_process_start_identity: text(record, 'lifecycle_process_start_identity'),
    lifecycle_instance_id: text(record, 'lifecycle_instance_id'),
    store_generation_id: generation,
    current_store_pointer_sha256: pointerDigest as `sha256:${string}`,
    published_at: canonicalTimestamp(record['published_at']),
  });
}

function sha256(bytes: Uint8Array): `sha256:${string}` { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

function syncDirectory(path: string): void {
  if (platform() === 'win32') return;
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function assertRegularSingleLink(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new CoordinationRuntimeError('system-fatal', 'runtime identity must be a private regular single-link file', [path]);
}

export async function publishCoordinatorRuntimeIdentity(paths: CoordinatorRuntimePaths, generation: CurrentStoreGeneration, lifecycle: RuntimeLifecycleIdentity, writerGuard: CoordinatorWriterGuard, now: Date = new Date()): Promise<PublishedRuntimeIdentity> {
  writerGuard.assertHeldFor(paths);
  const pointerBytes = readFileSync(paths.currentStorePointerPath);
  if (sha256(pointerBytes) !== generation.pointer_sha256) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity publication pointer changed after generation selection');
  for (const name of await readdir(paths.coordinatorRoot)) {
    if (!/^\.runtime-identity\.\d+\.[a-f0-9]{16}\.tmp$/u.test(name)) continue;
    const stale = resolve(paths.coordinatorRoot, name);
    assertRegularSingleLink(stale);
    await unlink(stale);
  }
  if (existsSync(paths.runtimeIdentityPath)) assertRegularSingleLink(paths.runtimeIdentityPath);
  const identity: CoordinatorRuntimeIdentity = {
    schema_version: COORDINATOR_RUNTIME_IDENTITY_SCHEMA,
    implementation_build: COORDINATOR_IMPLEMENTATION_BUILD,
    wire_lineage: COORDINATOR_WIRE_LINEAGE,
    api_schema_version: COORDINATOR_API_SCHEMA_VERSION,
    store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION,
    legacy_facade_build: COORDINATOR_LEGACY_FACADE_BUILD,
    lifecycle_pid: lifecycle.pid,
    lifecycle_boot_id: lifecycle.boot_id,
    lifecycle_process_start_identity: lifecycle.process_start_identity,
    lifecycle_instance_id: lifecycle.instance_id,
    store_generation_id: generation.pointer.generation_id,
    current_store_pointer_sha256: generation.pointer_sha256,
    published_at: now.toISOString(),
  };
  const bytes = Buffer.from(`${canonicalJson(identity)}\n`, 'utf8');
  const temporary = resolve(paths.coordinatorRoot, `.runtime-identity.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const written = await handle.write(bytes);
      if (written.bytesWritten !== bytes.byteLength) throw new CoordinationRuntimeError('system-fatal', 'runtime identity publication made a short write');
      await handle.sync();
    } finally { await handle.close(); }
    await enforcePrivateAuthorityPath(temporary, false);
    writerGuard.assertHeld();
    await rename(temporary, paths.runtimeIdentityPath);
    await enforcePrivateAuthorityPath(paths.runtimeIdentityPath, false);
    assertRegularSingleLink(paths.runtimeIdentityPath);
    syncDirectory(dirname(paths.runtimeIdentityPath));
    return Object.freeze({ identity, sha256: sha256(bytes), bytes });
  } finally {
    if (existsSync(temporary)) await unlink(temporary);
  }
}

export function readAndVerifyCoordinatorRuntimeIdentity(paths: CoordinatorRuntimePaths, generation: CurrentStoreGeneration, lifecycle: RuntimeLifecycleIdentity): PublishedRuntimeIdentity {
  assertRegularSingleLink(paths.runtimeIdentityPath);
  const bytes = readFileSync(paths.runtimeIdentityPath);
  const identity = parseCoordinatorRuntimeIdentity(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown);
  const canonicalBytes = Buffer.from(`${canonicalJson(identity)}\n`, 'utf8');
  if (bytes.byteLength !== canonicalBytes.byteLength || bytes.some((byte, index) => canonicalBytes[index] !== byte)) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity bytes are not exact canonical publication bytes');
  if (identity.store_generation_id !== generation.pointer.generation_id
    || identity.current_store_pointer_sha256 !== generation.pointer_sha256
    || identity.lifecycle_pid !== lifecycle.pid
    || identity.lifecycle_boot_id !== lifecycle.boot_id
    || identity.lifecycle_process_start_identity !== lifecycle.process_start_identity
    || identity.lifecycle_instance_id !== lifecycle.instance_id) throw new CoordinationRuntimeError('store-corrupt', 'runtime identity is not bound to the current pointer and lifecycle identity');
  return Object.freeze({ identity, sha256: sha256(bytes), bytes });
}
