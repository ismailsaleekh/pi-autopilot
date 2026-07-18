#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { closedGitWorktreeRegistrationFacts } from './closed-git-registration.ts';
import { parseCorpusCloneRequest, type CorpusCloneRequest, type Sha256Digest } from './contracts.ts';
import { compareCodeUnits, inspectRegularFileNoFollow, inventoryDigest, inventoryTree, readRegularFileNoFollow, sourcePathDigest } from './inventory.ts';

export interface LiveWitnessInventory {
  readonly corpus_id: string;
  readonly root_label: string;
  readonly root_path_sha256: Sha256Digest;
  readonly root_identity: { readonly device: string; readonly inode: string; readonly link_count: number };
  readonly file_count: number;
  readonly total_bytes: number;
  readonly tree_sha256: Sha256Digest;
  readonly inventory_sha256: Sha256Digest;
}

export interface LiveWitness {
  readonly schema_version: 'autopilot.s1_corpus_live_witness.v1';
  readonly rehearsal_id: string;
  readonly phase: 'before' | 'after';
  readonly roots: readonly LiveWitnessInventory[];
  readonly database_components_sha256: Sha256Digest;
  readonly evidence_sha256: Sha256Digest;
  readonly authority_objects_sha256: Sha256Digest;
  readonly git_refs_sha256: Sha256Digest;
  readonly registrations_sha256: Sha256Digest;
  readonly worktrees_sha256: Sha256Digest;
  readonly authority_sha256: Sha256Digest;
  readonly witness_sha256: Sha256Digest;
}

interface JsonObject { readonly [key: string]: unknown }

function strictObject(value: unknown, fields: readonly string[], label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`C5 ${label} must be an object`);
  const row = value as JsonObject;
  const actual = Object.keys(row).sort(compareCodeUnits);
  const expected = [...fields].sort(compareCodeUnits);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`C5 ${label} has an unknown or missing field`);
  return row;
}

function parsedDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`C5 ${label} must be a SHA-256 digest`);
  return value as Sha256Digest;
}

export function parseLiveWitness(value: unknown): LiveWitness {
  const row = strictObject(value, ['schema_version', 'rehearsal_id', 'phase', 'roots', 'database_components_sha256', 'evidence_sha256', 'authority_objects_sha256', 'git_refs_sha256', 'registrations_sha256', 'worktrees_sha256', 'authority_sha256', 'witness_sha256'], 'live witness');
  if (row['schema_version'] !== 'autopilot.s1_corpus_live_witness.v1' || typeof row['rehearsal_id'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(row['rehearsal_id']) || (row['phase'] !== 'before' && row['phase'] !== 'after') || !Array.isArray(row['roots'])) throw new Error('C5 live witness identity is malformed');
  const roots = row['roots'].map((entry, index): LiveWitnessInventory => {
    const root = strictObject(entry, ['corpus_id', 'root_label', 'root_path_sha256', 'root_identity', 'file_count', 'total_bytes', 'tree_sha256', 'inventory_sha256'], `live witness root ${String(index)}`);
    const identity = strictObject(root['root_identity'], ['device', 'inode', 'link_count'], `live witness root identity ${String(index)}`);
    if (typeof root['corpus_id'] !== 'string' || typeof root['root_label'] !== 'string' || typeof identity['device'] !== 'string' || typeof identity['inode'] !== 'string' || !Number.isSafeInteger(identity['link_count']) || !Number.isSafeInteger(root['file_count']) || !Number.isSafeInteger(root['total_bytes'])) throw new Error('C5 live witness root is malformed');
    return Object.freeze({ corpus_id: root['corpus_id'], root_label: root['root_label'], root_path_sha256: parsedDigest(root['root_path_sha256'], 'live witness root path'), root_identity: Object.freeze({ device: identity['device'], inode: identity['inode'], link_count: identity['link_count'] as number }), file_count: root['file_count'] as number, total_bytes: root['total_bytes'] as number, tree_sha256: parsedDigest(root['tree_sha256'], 'live witness root tree'), inventory_sha256: parsedDigest(root['inventory_sha256'], 'live witness root inventory') });
  });
  const sorted = [...roots].sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.root_label}`, `${right.corpus_id}\0${right.root_label}`));
  if (canonicalJson(roots) !== canonicalJson(sorted)) throw new Error('C5 live witness roots are not deterministically sorted');
  const databaseComponentsSha256 = parsedDigest(row['database_components_sha256'], 'live witness database components');
  const evidenceSha256 = parsedDigest(row['evidence_sha256'], 'live witness evidence');
  const authorityObjectsSha256 = parsedDigest(row['authority_objects_sha256'], 'live witness authority objects');
  const gitRefsSha256 = parsedDigest(row['git_refs_sha256'], 'live witness refs');
  const registrationsSha256 = parsedDigest(row['registrations_sha256'], 'live witness registrations');
  const worktreesSha256 = parsedDigest(row['worktrees_sha256'], 'live witness worktrees');
  const authoritySha256 = parsedDigest(row['authority_sha256'], 'live witness authority');
  if (authoritySha256 !== digest(canonicalJson({ roots, database_components_sha256: databaseComponentsSha256, evidence_sha256: evidenceSha256, authority_objects_sha256: authorityObjectsSha256, git_refs_sha256: gitRefsSha256, registrations_sha256: registrationsSha256, worktrees_sha256: worktreesSha256 }))) throw new Error('C5 live witness authority digest mismatch');
  const phase: LiveWitness['phase'] = row['phase'];
  const base = { schema_version: 'autopilot.s1_corpus_live_witness.v1' as const, rehearsal_id: row['rehearsal_id'], phase, roots: Object.freeze(roots), database_components_sha256: databaseComponentsSha256, evidence_sha256: evidenceSha256, authority_objects_sha256: authorityObjectsSha256, git_refs_sha256: gitRefsSha256, registrations_sha256: registrationsSha256, worktrees_sha256: worktreesSha256, authority_sha256: authoritySha256 };
  const witnessSha = parsedDigest(row['witness_sha256'], 'live witness digest');
  if (witnessSha !== digest(canonicalJson(base))) throw new Error('C5 live witness self-digest mismatch');
  return Object.freeze({ ...base, witness_sha256: witnessSha });
}

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function databaseComponents(request: CorpusCloneRequest): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const values: Readonly<Record<string, unknown>>[] = [];
  for (const corpus of request.corpora) {
    for (const role of ['database', 'journal', 'shm', 'wal'] as const) {
      const path = role === 'database' ? corpus.database_path : `${corpus.database_path}-${role}`;
      if (!existsSync(path)) {
        values.push(Object.freeze({ corpus_id: corpus.corpus_id, role, present: false, path_sha256: sourcePathDigest(request.rehearsal_id, path) }));
        continue;
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`C5 live witness database ${role} is not a physical regular file`);
      const inspected = await inspectRegularFileNoFollow(path);
      values.push(Object.freeze({ corpus_id: corpus.corpus_id, role, present: true, path_sha256: sourcePathDigest(request.rehearsal_id, path), identity: inspected.identity, size_bytes: inspected.size_bytes, sha256: inspected.sha256 }));
    }
  }
  return Object.freeze(values.sort((left, right) => compareCodeUnits(`${String(left['corpus_id'])}\0${String(left['role'])}`, `${String(right['corpus_id'])}\0${String(right['role'])}`)));
}

function gitRefs(request: CorpusCloneRequest): readonly Readonly<Record<string, string>>[] {
  const refs: Readonly<Record<string, string>>[] = [];
  for (const corpus of request.corpora) {
    const result = spawnSync('git', ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)'], { cwd: corpus.repository_root, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env['PATH'], GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (result.error !== undefined || result.status !== 0 || result.signal !== null) throw new Error('C5 live witness Git ref query failed or lost process truth');
    for (const line of result.stdout.split('\n').filter((entry) => entry.length > 0)) {
      const [ref, objectId, objectType, extra] = line.split('\u0000');
      if (ref === undefined || objectId === undefined || objectType === undefined || extra !== undefined || !ref.startsWith('refs/') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(objectId)) throw new Error('C5 live witness Git ref output is malformed');
      refs.push(Object.freeze({ corpus_id: corpus.corpus_id, ref, object_id: objectId, object_type: objectType }));
    }
  }
  return Object.freeze(refs.sort((left, right) => compareCodeUnits(`${left['corpus_id']}\0${left['ref']}`, `${right['corpus_id']}\0${right['ref']}`)));
}

function registrations(request: CorpusCloneRequest): readonly Readonly<Record<string, unknown>>[] {
  const values: Readonly<Record<string, unknown>>[] = [];
  for (const corpus of request.corpora) {
    for (const registration of closedGitWorktreeRegistrationFacts(corpus.repository_root)) values.push(Object.freeze({ corpus_id: corpus.corpus_id, worktree_path_sha256: sourcePathDigest(request.rehearsal_id, registration.worktree_path), head_sha: registration.head_sha, branch_ref: registration.branch_ref, prunable: registration.prunable, path_present: existsSync(registration.worktree_path) }));
  }
  return Object.freeze(values.sort((left, right) => compareCodeUnits(`${String(left['corpus_id'])}\0${String(left['worktree_path_sha256'])}`, `${String(right['corpus_id'])}\0${String(right['worktree_path_sha256'])}`)));
}

async function evidenceFacts(request: CorpusCloneRequest): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const values: Readonly<Record<string, unknown>>[] = [];
  for (const corpus of request.corpora) {
    const inventory = await inventoryTree(corpus.state_root);
    const entries = inventory.nodes.filter((node) => /(?:^|\/)(?:evidence|_saga-evidence)(?:\/|$)/u.test(node.relative_path)).map((node) => ({ path_sha256: sourcePathDigest(request.rehearsal_id, resolve(corpus.state_root, ...node.relative_path.split('/'))), kind: node.kind, mode: node.mode, size_bytes: node.size_bytes, sha256: node.sha256, symlink_target_sha256: node.symlink_target_sha256 }));
    values.push(Object.freeze({ corpus_id: corpus.corpus_id, entries }));
  }
  return Object.freeze(values);
}

async function authorityObjectFacts(request: CorpusCloneRequest): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const values: Readonly<Record<string, unknown>>[] = [];
  for (const corpus of request.corpora) {
    const paths = coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: corpus.state_root });
    const bases = [paths.writerGuardPath, paths.currentStorePointerPath, paths.runtimeIdentityPath, paths.lockPath, paths.lifecycleElectionPath, paths.startupLockPath, paths.startupElectionPath, paths.predecessorLockPath, paths.predecessorStartupLockPath, paths.socketPath, paths.predecessorSocketPath, paths.capabilityPath];
    const sqliteAuthorities = [paths.writerGuardPath, paths.lifecycleElectionPath, paths.startupElectionPath];
    const candidates = [...new Set([...bases, ...sqliteAuthorities.flatMap((path) => [`${path}-journal`, `${path}-wal`, `${path}-shm`])])].sort(compareCodeUnits);
    for (const path of candidates) {
      const base = { corpus_id: corpus.corpus_id, path_sha256: sourcePathDigest(request.rehearsal_id, path) };
      if (!existsSync(path)) { values.push(Object.freeze({ ...base, present: false })); continue; }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('C5 live witness authority object is a symbolic link');
      if (stat.isFile()) {
        const inspected = await inspectRegularFileNoFollow(path);
        values.push(Object.freeze({ ...base, present: true, kind: 'regular', identity: inspected.identity, mode: stat.mode & 0o777, size_bytes: inspected.size_bytes, sha256: inspected.sha256 }));
      } else if (stat.isSocket()) values.push(Object.freeze({ ...base, present: true, kind: 'socket', identity: { device: String(stat.dev), inode: String(stat.ino), link_count: stat.nlink }, mode: stat.mode & 0o777 }));
      else throw new Error('C5 live witness authority object has an unsupported filesystem kind');
    }
  }
  return Object.freeze(values.sort((left, right) => compareCodeUnits(`${String(left['corpus_id'])}\0${String(left['path_sha256'])}`, `${String(right['corpus_id'])}\0${String(right['path_sha256'])}`)));
}

async function worktreeFacts(request: CorpusCloneRequest): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const values: Readonly<Record<string, unknown>>[] = [];
  for (const corpus of request.corpora) {
    for (const registration of closedGitWorktreeRegistrationFacts(corpus.repository_root)) {
      const pathSha = sourcePathDigest(request.rehearsal_id, registration.worktree_path);
      if (!existsSync(registration.worktree_path)) { values.push(Object.freeze({ corpus_id: corpus.corpus_id, worktree_path_sha256: pathSha, present: false })); continue; }
      const inventory = await inventoryTree(registration.worktree_path);
      values.push(Object.freeze({ corpus_id: corpus.corpus_id, worktree_path_sha256: pathSha, present: true, tree_sha256: inventory.tree_sha256, inventory_sha256: inventoryDigest(inventory) }));
    }
  }
  return Object.freeze(values.sort((left, right) => compareCodeUnits(`${String(left['corpus_id'])}\0${String(left['worktree_path_sha256'])}`, `${String(right['corpus_id'])}\0${String(right['worktree_path_sha256'])}`)));
}

export async function captureLiveWitness(request: CorpusCloneRequest, phase: LiveWitness['phase']): Promise<LiveWitness> {
  const roots: LiveWitnessInventory[] = [];
  for (const corpus of request.corpora) {
    const entries = [
      { label: 'state', path: corpus.state_root },
      { label: 'repository', path: corpus.repository_root },
      ...corpus.retained_snapshot_roots.map((path, index) => ({ label: `retained-${String(index).padStart(2, '0')}`, path })),
    ];
    for (const entry of entries) {
      const inventory = await inventoryTree(entry.path);
      roots.push(Object.freeze({ corpus_id: corpus.corpus_id, root_label: entry.label, root_path_sha256: sourcePathDigest(request.rehearsal_id, inventory.canonical_root), root_identity: inventory.root_identity, file_count: inventory.file_count, total_bytes: inventory.total_bytes, tree_sha256: inventory.tree_sha256, inventory_sha256: inventoryDigest(inventory) }));
    }
  }
  roots.sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.root_label}`, `${right.corpus_id}\0${right.root_label}`));
  const componentFacts = await databaseComponents(request);
  const measuredEvidence = await evidenceFacts(request);
  const measuredAuthorityObjects = await authorityObjectFacts(request);
  const refFacts = gitRefs(request);
  const registrationFacts = registrations(request);
  const measuredWorktrees = await worktreeFacts(request);
  const authority = { roots, database_components_sha256: digest(canonicalJson(componentFacts)), evidence_sha256: digest(canonicalJson(measuredEvidence)), authority_objects_sha256: digest(canonicalJson(measuredAuthorityObjects)), git_refs_sha256: digest(canonicalJson(refFacts)), registrations_sha256: digest(canonicalJson(registrationFacts)), worktrees_sha256: digest(canonicalJson(measuredWorktrees)) };
  const authoritySha256 = digest(canonicalJson(authority));
  const base = { schema_version: 'autopilot.s1_corpus_live_witness.v1' as const, rehearsal_id: request.rehearsal_id, phase, roots: Object.freeze(roots), database_components_sha256: authority.database_components_sha256, evidence_sha256: authority.evidence_sha256, authority_objects_sha256: authority.authority_objects_sha256, git_refs_sha256: authority.git_refs_sha256, registrations_sha256: authority.registrations_sha256, worktrees_sha256: authority.worktrees_sha256, authority_sha256: authoritySha256 };
  return Object.freeze({ ...base, witness_sha256: digest(canonicalJson(base)) });
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 3 || (args[0] !== 'before' && args[0] !== 'after')) throw new Error('usage: live-witness-worker.ts before|after <private-request.json> <private-output.json>');
  const requestPath = args[1];
  const outputPath = args[2];
  if (requestPath === undefined || outputPath === undefined) throw new Error('C5 live witness arguments disappeared');
  const privateRequest = readRegularFileNoFollow(requestPath, 64 * 1024 * 1024);
  if (privateRequest.identity.link_count !== 1 || process.platform !== 'win32' && (privateRequest.mode & 0o077) !== 0) throw new Error('C5 live witness request must be a private single-link regular file');
  const request = parseCorpusCloneRequest(JSON.parse(Buffer.from(privateRequest.bytes).toString('utf8')) as unknown);
  const destination = resolve(request.destination_root);
  const output = resolve(outputPath);
  const rel = relative(destination, output);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('C5 live witness output must remain below the private destination root');
  const witness = await captureLiveWitness(request, args[0]);
  await writeFile(output, `${canonicalJson(witness)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

if (process.argv[1]?.endsWith('live-witness-worker.ts') === true || process.argv[1]?.endsWith('live-witness-worker.js') === true) await main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`C5 live witness failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
