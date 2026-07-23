import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseS2ReleaseSkewFixtureManifest, type S2ReleaseSkewFixtureManifest } from '../../src/core/coordination/s2-version-skew.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import {
  installActualCf50Package,
  loadActualCf50Client,
  startActualCf50Coordinator,
  verifyActualCf50Fixture,
  type ActualCf50CoordinatorProcess,
  type InstalledActualCf50Package,
  type VersionSkewClient,
  type VersionSkewMutationIdentity,
  type VersionSkewResponse,
} from './actual-cf50-package.ts';

export type { VersionSkewClient } from './actual-cf50-package.ts';

const releaseFixtureRoot = resolve(fileURLToPath(new URL('../fixtures/releases/', import.meta.url)));
const s2FixtureRoot = join(releaseFixtureRoot, 's2');
const s2FixtureManifestPath = join(s2FixtureRoot, 'manifest.json');

interface JsonMap {
  readonly [key: string]: unknown;
}

export interface VerifiedS2PreviousReleaseFixture {
  readonly manifest: S2ReleaseSkewFixtureManifest;
  readonly fixtureManifestPath: string;
  readonly previousTarballPath: string;
}

export interface S2AttachedJourney {
  readonly client: VersionSkewClient;
  readonly heartbeatIdentity: VersionSkewMutationIdentity;
  readonly heartbeatPayload: Readonly<Record<string, unknown>>;
  readonly firstHeartbeat: VersionSkewResponse;
}

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonMap;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} is not an integer`);
  return value;
}

function sessionToken(seed: string): string {
  const code = seed.codePointAt(0) ?? 1;
  return (code % 16).toString(16).repeat(64);
}

async function assertContainedRegularFile(root: string, path: string, label: string): Promise<void> {
  const rootPhysical = await realpath(root);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symbolic file`);
  const physical = await realpath(path);
  const rel = relative(rootPhysical, physical);
  if (rel.length === 0 || rel.startsWith('..') || resolve(rootPhysical, rel) !== physical) throw new Error(`${label} escapes the release fixture root`);
}

function resolveFixturePath(path: string): string {
  return resolve(s2FixtureRoot, path);
}

export async function verifyS2PreviousReleaseFixture(): Promise<VerifiedS2PreviousReleaseFixture> {
  await assertContainedRegularFile(releaseFixtureRoot, s2FixtureManifestPath, 'S2 release skew fixture manifest');
  const manifest = parseS2ReleaseSkewFixtureManifest(JSON.parse(await readFile(s2FixtureManifestPath, 'utf8')) as unknown);
  const previousManifestPath = resolveFixturePath(manifest.previous_fixture_manifest);
  const previousTarballPath = resolveFixturePath(manifest.previous_tarball);
  await assertContainedRegularFile(releaseFixtureRoot, previousManifestPath, 'S2 previous release fixture manifest');
  await assertContainedRegularFile(releaseFixtureRoot, previousTarballPath, 'S2 previous release tarball');
  const previousTarball = await readFile(previousTarballPath);
  assert.equal(previousTarball.byteLength, manifest.previous_tarball_size_bytes);
  assert.equal(`sha256:${createHash('sha256').update(previousTarball).digest('hex')}`, manifest.previous_tarball_sha256);

  const cf50 = await verifyActualCf50Fixture();
  assert.equal(cf50.tarballPath, previousTarballPath);
  assert.equal(cf50.manifest.version, manifest.previous_version);
  assert.equal(cf50.manifest.implementation_build, manifest.previous_implementation_build);
  assert.equal(cf50.manifest.wire_protocol_version, manifest.previous_wire_protocol_version);
  assert.equal(cf50.manifest.api_schema_version, manifest.previous_api_schema_version);
  assert.equal(cf50.manifest.tarball_size_bytes, manifest.previous_tarball_size_bytes);
  assert.equal(cf50.manifest.tarball_sha256, manifest.previous_tarball_sha256);
  return { manifest, fixtureManifestPath: s2FixtureManifestPath, previousTarballPath };
}

export async function installS2PreviousReleasePackage(destination: string): Promise<InstalledActualCf50Package> {
  await verifyS2PreviousReleaseFixture();
  return await installActualCf50Package(destination);
}

export async function loadS2PreviousReleaseClient(input: { readonly installation: InstalledActualCf50Package; readonly env: ProcessEnvLike; readonly autoStart: boolean }): Promise<VersionSkewClient> {
  await verifyS2PreviousReleaseFixture();
  return await loadActualCf50Client(input);
}

export async function startS2PreviousReleaseCoordinator(input: { readonly installation: InstalledActualCf50Package; readonly stateRoot: string }): Promise<ActualCf50CoordinatorProcess> {
  await verifyS2PreviousReleaseFixture();
  return await startActualCf50Coordinator(input);
}

export function s2RunPayload(root: string, prefix: string): Readonly<Record<string, unknown>> {
  const repoRoot = join(root, `${prefix}-repository`);
  const worktreeRoot = join(root, `${prefix}-worktrees`);
  const main = join(worktreeRoot, 'active', `${prefix}-run`, 'main');
  return {
    repo_key: `${prefix}-repo`, canonical_root: repoRoot, git_common_dir: join(repoRoot, '.git'), autopilot_id: `${prefix}-autopilot`, workstream: `${prefix}-work`, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: `${prefix}-repo`, workstream_run: `${prefix}-run`,
      source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: worktreeRoot,
      main_worktree_path: main, runtime_root: join(main, '.pi', 'autopilot', `${prefix}-work`),
      branch: `autopilot/${prefix}-run`, target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null,
      started_at: '2026-07-22T00:00:00.000Z', version: 1,
    },
  };
}

export async function s2AttachAndHeartbeat(client: VersionSkewClient, root: string, prefix: string): Promise<S2AttachedJourney> {
  const repoId = `${prefix}-repo`;
  const workstreamRun = `${prefix}-run`;
  const sessionId = `${prefix}-session`;
  const leaseId = `${prefix}-session-lease`;
  const token = sessionToken(prefix);
  const attachedRunResponse = await client.mutate('attach-run', {
    repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `${prefix}-attach-run`,
  }, s2RunPayload(root, prefix));
  const attachedRun = record(attachedRunResponse.payload['run'], `${prefix} attached run`);
  const attachedSessionResponse = await client.mutate('attach-session', {
    repoId, workstreamRun, sessionId, fencingGeneration: 1, expectedVersion: integer(attachedRun['version'], `${prefix} run version`), idempotencyKey: `${prefix}-attach-session`,
  }, {
    session_lease_id: leaseId, session_token: token, pid: process.pid, boot_id: `${prefix}-boot`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedSession = record(attachedSessionResponse.payload['session'], `${prefix} attached session`);
  const heartbeatIdentity: VersionSkewMutationIdentity = {
    repoId, workstreamRun, sessionId, fencingGeneration: 1,
    expectedVersion: integer(attachedSession['version'], `${prefix} session version`),
    idempotencyKey: `${prefix}-heartbeat-replay`,
  };
  const heartbeatPayload = { session_lease_id: leaseId, session_token: token, lease_expires_at: '2099-01-02T00:00:00.000Z' };
  const firstHeartbeat = await client.mutate('heartbeat', heartbeatIdentity, heartbeatPayload);
  assert.equal(record(firstHeartbeat.payload['session'], `${prefix} heartbeat session`)['status'], 'attached');
  return { client, heartbeatIdentity, heartbeatPayload, firstHeartbeat };
}

export async function assertS2IdempotentHeartbeatReplay(journey: S2AttachedJourney): Promise<void> {
  const replay = await journey.client.mutate('heartbeat', journey.heartbeatIdentity, journey.heartbeatPayload);
  assert.equal(replay.committed_event_seq, journey.firstHeartbeat.committed_event_seq);
  assert.deepEqual(replay.payload, journey.firstHeartbeat.payload);
}

export function assertS2PreviousReleaseHandshake(response: VersionSkewResponse): void {
  assert.equal(response.ok, true);
  assert.equal(response.payload['schema_version'], 'autopilot.coordinator_handshake.v1');
  assert.equal(response.payload['package_build'], '1.1.8-cf50');
  assert.equal(response.payload['protocol_version'], '1.6');
  assert.equal(response.payload['database_schema_version'], 12);
}
