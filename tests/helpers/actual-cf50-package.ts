import { spawn, spawnSync, type ChildProcessDataChunk, type ChildProcessLite } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths, type CoordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { stopSpawnedChild } from './coordinator-process-lifecycle.ts';

const fixtureRoot = resolve(fileURLToPath(new URL('../fixtures/releases/cf50/', import.meta.url)));
const fixtureManifestPath = join(fixtureRoot, 'manifest.json');
const expectedTarballName = 'pi-autopilot-1.1.8-cf50.tgz';
const expectedTarballSha256 = 'sha256:e98ccee99e95d5ba9c958c91c354eef40326fa21cf89a8ba37bd10e6650485a7';
const expectedTarballSize = 1_090_668;

interface JsonMap { readonly [key: string]: unknown }

export interface ActualCf50FixtureManifest {
  readonly schema_version: 'autopilot.actual_release_fixture.v1';
  readonly package: 'pi-autopilot';
  readonly version: '1.1.8';
  readonly implementation_build: '1.1.8-cf50';
  readonly wire_protocol_version: '1.6';
  readonly api_schema_version: 12;
  readonly source_commit: '55b9d2381d9c889babde500ce035709c825450f1';
  readonly tarball: typeof expectedTarballName;
  readonly tarball_size_bytes: typeof expectedTarballSize;
  readonly tarball_sha256: typeof expectedTarballSha256;
  readonly source_release_manifest_schema: 'autopilot.local_release.v1';
  readonly source_release_id: 'cf50-20260715T211057Z';
}

export interface InstalledActualCf50Package {
  readonly packageRoot: string;
  readonly clientModuleUrl: string;
  readonly coordinatorCliPath: string;
  readonly manifest: ActualCf50FixtureManifest;
}

export interface ActualCf50CoordinatorProcess {
  readonly child: ChildProcessLite;
  readonly paths: CoordinatorRuntimePaths;
  close(): Promise<void>;
}

export type VersionSkewMutationAction = 'attach-run' | 'attach-session' | 'heartbeat';

export interface VersionSkewMutationIdentity {
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly sessionId: string | null;
  readonly fencingGeneration: number | null;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface VersionSkewResponse {
  readonly schema_version: string;
  readonly protocol_version: string;
  readonly request_id: string;
  readonly ok: boolean;
  readonly committed_event_seq: number | null;
  readonly error_code: string | null;
  readonly retryable: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface VersionSkewClient {
  query(action: 'handshake' | 'status'): Promise<VersionSkewResponse>;
  mutate(action: VersionSkewMutationAction, identity: VersionSkewMutationIdentity, payload: Readonly<Record<string, unknown>>): Promise<VersionSkewResponse>;
}

interface VersionSkewClientConstructor {
  new(options: { readonly env: ProcessEnvLike; readonly autoStart: boolean; readonly startupTimeoutMs?: number; readonly readinessTimeoutMs?: number }): VersionSkewClient;
}

function jsonMap(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonMap;
}

function exactString(record: JsonMap, field: string, expected: string): string {
  const value = record[field];
  if (value !== expected) throw new Error(`cf50 fixture ${field} mismatch: expected ${expected}, observed ${String(value)}`);
  return value;
}

function exactNumber(record: JsonMap, field: string, expected: number): number {
  const value = record[field];
  if (value !== expected) throw new Error(`cf50 fixture ${field} mismatch: expected ${String(expected)}, observed ${String(value)}`);
  return value;
}

function parseManifest(value: unknown): ActualCf50FixtureManifest {
  const record = jsonMap(value, 'cf50 fixture manifest');
  const expectedFields = [
    'api_schema_version', 'implementation_build', 'package', 'schema_version', 'source_commit',
    'source_release_id', 'source_release_manifest_schema', 'tarball', 'tarball_sha256',
    'tarball_size_bytes', 'version', 'wire_protocol_version',
  ].sort();
  const actualFields = Object.keys(record).sort();
  if (actualFields.length !== expectedFields.length || actualFields.some((field, index) => field !== expectedFields[index])) throw new Error(`cf50 fixture manifest field set mismatch: ${actualFields.join(',')}`);
  exactString(record, 'schema_version', 'autopilot.actual_release_fixture.v1');
  exactString(record, 'package', 'pi-autopilot');
  exactString(record, 'version', '1.1.8');
  exactString(record, 'implementation_build', '1.1.8-cf50');
  exactString(record, 'wire_protocol_version', '1.6');
  exactNumber(record, 'api_schema_version', 12);
  exactString(record, 'source_commit', '55b9d2381d9c889babde500ce035709c825450f1');
  exactString(record, 'tarball', expectedTarballName);
  exactNumber(record, 'tarball_size_bytes', expectedTarballSize);
  exactString(record, 'tarball_sha256', expectedTarballSha256);
  exactString(record, 'source_release_manifest_schema', 'autopilot.local_release.v1');
  exactString(record, 'source_release_id', 'cf50-20260715T211057Z');
  return {
    schema_version: 'autopilot.actual_release_fixture.v1',
    package: 'pi-autopilot',
    version: '1.1.8',
    implementation_build: '1.1.8-cf50',
    wire_protocol_version: '1.6',
    api_schema_version: 12,
    source_commit: '55b9d2381d9c889babde500ce035709c825450f1',
    tarball: expectedTarballName,
    tarball_size_bytes: expectedTarballSize,
    tarball_sha256: expectedTarballSha256,
    source_release_manifest_schema: 'autopilot.local_release.v1',
    source_release_id: 'cf50-20260715T211057Z',
  };
}

async function assertContainedRegularFile(root: string, path: string, label: string): Promise<void> {
  const rootPhysical = await realpath(root);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symbolic file`);
  const physical = await realpath(path);
  const rel = relative(rootPhysical, physical);
  if (rel.length === 0 || rel.startsWith('..') || resolve(rootPhysical, rel) !== physical) throw new Error(`${label} escapes its fixture/package root`);
}

export async function verifyActualCf50Fixture(): Promise<{ readonly manifest: ActualCf50FixtureManifest; readonly tarballPath: string }> {
  await assertContainedRegularFile(fixtureRoot, fixtureManifestPath, 'cf50 fixture manifest');
  const manifestValue: unknown = JSON.parse(await readFile(fixtureManifestPath, 'utf8')) as unknown;
  const manifest = parseManifest(manifestValue);
  const tarballPath = join(fixtureRoot, manifest.tarball);
  await assertContainedRegularFile(fixtureRoot, tarballPath, 'cf50 fixture tarball');
  const bytes = await readFile(tarballPath);
  if (bytes.byteLength !== manifest.tarball_size_bytes) throw new Error(`cf50 fixture size mismatch: expected ${String(manifest.tarball_size_bytes)}, observed ${String(bytes.byteLength)}`);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== manifest.tarball_sha256) throw new Error(`cf50 fixture digest mismatch: expected ${manifest.tarball_sha256}, observed ${digest}`);
  return { manifest, tarballPath };
}

export async function installActualCf50Package(destination: string): Promise<InstalledActualCf50Package> {
  const verified = await verifyActualCf50Fixture();
  const consumerRoot = join(destination, 'actual-cf50-consumer');
  const cacheRoot = join(destination, 'actual-cf50-npm-cache');
  await mkdir(consumerRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const installed = spawnSync('npm', [
    'install', '--offline', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false', verified.tarballPath,
  ], {
    cwd: consumerRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NPM_CONFIG_CACHE: cacheRoot, NPM_CONFIG_OFFLINE: 'true' },
  });
  if (installed.error !== undefined || installed.status !== 0) throw new Error(`actual cf50 fixture install failed: ${installed.error?.message ?? ''}\n${installed.stderr}`);

  const packageRoot = join(consumerRoot, 'node_modules', 'pi-autopilot');
  const packageJsonPath = join(packageRoot, 'package.json');
  const constantsPath = join(packageRoot, 'dist', 'src', 'core', 'coordination', 'runtime-constants.js');
  const clientPath = join(packageRoot, 'dist', 'src', 'core', 'coordination', 'client.js');
  const coordinatorCliPath = join(packageRoot, 'dist', 'src', 'cli', 'autopilot-coordinator.js');
  for (const [path, label] of [[packageJsonPath, 'package manifest'], [constantsPath, 'runtime constants'], [clientPath, 'client entrypoint'], [coordinatorCliPath, 'coordinator entrypoint']] as const) await assertContainedRegularFile(packageRoot, path, `installed cf50 ${label}`);

  const packageJson = jsonMap(JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown, 'installed cf50 package manifest');
  if (packageJson['name'] !== verified.manifest.package || packageJson['version'] !== verified.manifest.version) throw new Error('installed cf50 package identity disagrees with the digest-pinned fixture manifest');
  const constants = await readFile(constantsPath, 'utf8');
  for (const literal of ["COORDINATOR_PACKAGE_BUILD = '1.1.8-cf50'", 'COORDINATOR_DATABASE_SCHEMA_VERSION = 12']) {
    if (!constants.includes(literal)) throw new Error(`installed cf50 runtime constants omit ${literal}`);
  }
  await verifyActualCf50Fixture();
  return { packageRoot, clientModuleUrl: pathToFileURL(clientPath).href, coordinatorCliPath, manifest: verified.manifest };
}

export async function loadActualCf50Client(input: { readonly installation: InstalledActualCf50Package; readonly env: ProcessEnvLike; readonly autoStart: boolean }): Promise<VersionSkewClient> {
  const loaded: unknown = await import(input.installation.clientModuleUrl);
  const module = jsonMap(loaded, 'actual cf50 client module');
  const constructor = module['CoordinatorClient'];
  if (typeof constructor !== 'function') throw new Error('actual cf50 client module has no CoordinatorClient constructor');
  return new (constructor as VersionSkewClientConstructor)({ env: input.env, autoStart: input.autoStart, startupTimeoutMs: 10_000, readinessTimeoutMs: 30_000 });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function endpointReachable(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveReachable) => {
    const socket = connect(path);
    const finish = (reachable: boolean): void => { clearTimeout(timer); socket.destroy(); resolveReachable(reachable); };
    const timer = setTimeout(() => finish(false), 250);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForActualCf50Ready(child: ChildProcessLite, paths: CoordinatorRuntimePaths, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`actual cf50 coordinator exited ${String(child.exitCode)} before readiness: ${stderr()}`);
    try {
      const lock = jsonMap(JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown, 'actual cf50 lifecycle lock');
      if (lock['pid'] === child.pid && lock['package_build'] === '1.1.8-cf50' && await endpointReachable(paths.socketPath)) return;
    } catch { /* readiness remains pending */ }
    await sleep(25);
  }
  throw new Error(`actual cf50 coordinator did not become ready: ${stderr()}`);
}

export async function startActualCf50Coordinator(input: { readonly installation: InstalledActualCf50Package; readonly stateRoot: string }): Promise<ActualCf50CoordinatorProcess> {
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: input.stateRoot };
  const paths = coordinatorRuntimePaths(env);
  const child = spawn(process.execPath, [input.installation.coordinatorCliPath, 'serve', '--state-root', input.stateRoot], {
    cwd: input.installation.packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: ChildProcessDataChunk) => {
    if (stderr.length < 16_384) stderr += chunk.toString('utf8').slice(0, 16_384 - stderr.length);
  });
  try {
    await waitForActualCf50Ready(child, paths, () => stderr);
  } catch (error) {
    await stopSpawnedChild(child);
    throw error;
  }
  return {
    child,
    paths,
    close: async () => {
      const pid = child.pid;
      await stopSpawnedChild(child);
      if (pid !== undefined && isProcessAlive(pid)) throw new Error(`actual cf50 coordinator pid ${String(pid)} survived cleanup`);
    },
  };
}
