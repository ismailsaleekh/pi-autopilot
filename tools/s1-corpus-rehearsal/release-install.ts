import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { Sha256Digest } from './contracts.ts';
import { compareCodeUnits, hashRegularFile, inventoryTree } from './inventory.ts';
import { runSandboxed } from './sandbox.ts';

export interface InstalledPackedRelease {
  readonly package_root: string;
  readonly coordinator_cli_path: string;
  readonly client_module_path: string;
  readonly package_version: string;
  readonly package_build: '1.1.8-cf50' | '1.2.0-s1';
}

interface JsonObject { readonly [key: string]: unknown }

function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function validateArchiveEntries(stdout: string): readonly string[] {
  const entries = stdout.split('\n').filter((value) => value.length > 0);
  if (entries.length === 0 || entries.length > 100_000) throw new Error('C5 packed release has an empty or unbounded archive index');
  const unique = new Set<string>();
  for (const entry of entries) {
    const normalized = entry.replace(/\\/gu, '/');
    const segments = normalized.split('/').filter((segment) => segment.length > 0);
    if (!normalized.startsWith('package/') || isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || segments.includes('..') || segments.includes('.') || normalized.includes('\u0000')) throw new Error('C5 packed release archive contains a path outside its package root');
    if (unique.has(normalized)) throw new Error('C5 packed release archive contains duplicate entries');
    unique.add(normalized);
  }
  return Object.freeze([...unique].sort(compareCodeUnits));
}

async function assertInstalledTree(packageRoot: string): Promise<void> {
  const inventory = await inventoryTree(packageRoot);
  for (const node of inventory.nodes) {
    if (node.kind === 'symlink' || node.kind === 'socket') throw new Error('C5 packed release extracted a symbolic or socket filesystem node');
    if (node.kind === 'regular' && node.identity.link_count !== 1) throw new Error('C5 packed release extracted a hardlinked regular file');
  }
}

export async function installPackedRelease(input: {
  readonly scenario_root: string;
  readonly project_root: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly denied_source_roots: readonly string[];
  readonly tarball_path: string;
  readonly expected_tarball_sha256: Sha256Digest;
  readonly release_kind: 'candidate' | 'actual-cf50';
}): Promise<InstalledPackedRelease> {
  if (await hashRegularFile(input.tarball_path) !== input.expected_tarball_sha256) throw new Error('C5 packed release digest changed after clone construction');
  const installRoot = join(input.scenario_root, 'consumers', input.release_kind);
  if (existsSync(installRoot)) throw new Error('C5 packed release installation root must be absent');
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  const listed = await runSandboxed({ clone_root: input.scenario_root, denied_source_roots: input.denied_source_roots, cwd: input.project_root, env: input.environment, command: '/usr/bin/tar', args: ['-tzf', input.tarball_path] });
  if (listed.exit_code !== 0 || listed.stderr !== '') throw new Error('C5 packed release archive listing failed or emitted diagnostics');
  validateArchiveEntries(listed.stdout);
  const extracted = await runSandboxed({ clone_root: input.scenario_root, denied_source_roots: input.denied_source_roots, cwd: input.project_root, env: input.environment, command: '/usr/bin/tar', args: ['-xzf', input.tarball_path, '-C', installRoot, '--no-same-owner', '--no-same-permissions'] });
  if (extracted.exit_code !== 0 || extracted.stdout !== '' || extracted.stderr !== '') throw new Error('C5 packed release extraction failed or emitted diagnostics');
  const packageRoot = join(installRoot, 'package');
  const rootStat = lstatSync(packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('C5 packed release did not produce one physical package root');
  const topEntries = (await readdir(installRoot)).sort(compareCodeUnits);
  if (topEntries.length !== 1 || topEntries[0] !== 'package') throw new Error('C5 packed release extracted files outside the package root');
  await assertInstalledTree(packageRoot);
  const manifest = jsonObject(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as unknown, 'C5 installed package manifest');
  const expectedVersion = input.release_kind === 'candidate' ? '1.2.0' : '1.1.8';
  if (manifest['name'] !== 'pi-autopilot' || manifest['version'] !== expectedVersion) throw new Error('C5 installed package identity differs from its expected release');
  const constants = await readFile(join(packageRoot, 'dist', 'src', 'core', 'coordination', 'runtime-constants.js'), 'utf8');
  const expectedBuild = input.release_kind === 'candidate' ? '1.2.0-s1' : '1.1.8-cf50';
  const identityLiterals = input.release_kind === 'candidate'
    ? ["COORDINATOR_IMPLEMENTATION_BUILD = '1.2.0-s1'", "COORDINATOR_PACKAGE_VERSION = '1.2.0'", 'COORDINATOR_STORE_SCHEMA_VERSION = 13', 'COORDINATOR_API_SCHEMA_VERSION = 12', 'COORDINATOR_DATABASE_SCHEMA_VERSION = 12']
    : ["COORDINATOR_PACKAGE_BUILD = '1.1.8-cf50'", 'COORDINATOR_DATABASE_SCHEMA_VERSION = 12'];
  if (identityLiterals.some((literal) => !constants.includes(literal))) throw new Error('C5 installed release runtime identity differs from the frozen implementation/API/store contract');
  const coordinatorCli = join(packageRoot, 'dist', 'src', 'cli', 'autopilot-coordinator.js');
  const clientModule = join(packageRoot, 'dist', 'src', 'core', 'coordination', 'client.js');
  for (const path of [coordinatorCli, clientModule]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('C5 installed release omits a physical runtime entrypoint');
  }
  return Object.freeze({ package_root: packageRoot, coordinator_cli_path: coordinatorCli, client_module_path: clientModule, package_version: expectedVersion, package_build: expectedBuild });
}
