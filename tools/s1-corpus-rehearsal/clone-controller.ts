import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { gitWorktreeRegistrationFacts } from '../../src/core/coordination/worktree-postconditions.ts';
import type { GitWorktreeRegistrationFact } from '../../src/core/coordination/metadata-reconcile.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { buildImmutableArtifactCopy, buildIsolatedStateCopy, type StateCopyResult } from './copy-builder.ts';
import {
  parseCorpusCloneManifest,
  S1_CORPUS_CLONE_MANIFEST_SCHEMA,
  type CopyFileDigest,
  type CopyGitFact,
  type CopyRoot,
  type CorpusCloneManifest,
  type CorpusCloneRequest,
  type DatabaseComponent,
  type IsolationProof,
  type IsolationProofs,
  type PathRebase,
  type Sha256Digest,
  type SourceGitRef,
  type SourceNodeDigest,
  type SourceRegistration,
  type SourceRoot,
} from './contracts.ts';
import { buildCloneEnvironment, type CloneEnvironment } from './environment.ts';
import { buildIsolatedGitMirror, type GitMirrorResult } from './git-mirror.ts';
import { measureRequiredIncidents } from './incident-measurement.ts';
import { compareCodeUnits, copyRegularFileNoFollow, inventoryTree, readRegularFileNoFollow, sourcePathDigest, type TreeInventory } from './inventory.ts';
import { verifyCloneIsolation, type IsolationVerificationResult } from './isolation-verifier.ts';
import { parseLiveWitness, type LiveWitness } from './live-witness-worker.ts';
import { rebaseCorpusPaths, type CorpusPathMapping, type PathRebaseResult } from './path-rebase.ts';
import { preflightCorpusCloneRequest } from './request-preflight.ts';
import { createCoherentSqliteSnapshot, type CoherentSqliteSnapshot } from './sqlite-snapshot.ts';

const READ_ONLY_GIT_ENV = Object.freeze({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });

interface MeasuredSourceRoot {
  readonly corpus_id: string;
  readonly label: string;
  readonly kind: SourceRoot['kind'];
  readonly path: string;
  readonly inventory: TreeInventory;
}

export interface BuiltCorpusScenario {
  readonly corpus_id: string;
  readonly scenario_id: 'candidate-main';
  readonly scenario_root: string;
  readonly state_root: string;
  readonly repository_root: string;
  readonly database_path: string;
  readonly raw_snapshot_database_path: string;
  readonly candidate_tarball_path: string;
  readonly cf50_tarball_path: string;
  readonly environment: CloneEnvironment;
  readonly state_copy: StateCopyResult;
  readonly sqlite_snapshot: CoherentSqliteSnapshot;
  readonly git_mirror: GitMirrorResult;
  readonly path_rebase: PathRebaseResult;
  readonly mappings: readonly CorpusPathMapping[];
  readonly isolation: IsolationVerificationResult;
}

export interface BuiltCorpusClone {
  readonly request: CorpusCloneRequest;
  readonly manifest: CorpusCloneManifest;
  readonly clone_root: string;
  readonly private_request_path: string;
  readonly witness_before_path: string;
  readonly witness_before: LiveWitness;
  readonly scenarios: readonly BuiltCorpusScenario[];
  readonly source_inventories: readonly TreeInventory[];
}

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function cloneRelative(cloneRoot: string, path: string): string {
  const rel = relative(cloneRoot, path).split(sep).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('C5 clone-relative path escaped clone authority');
  return rel;
}

function parseRefLines(corpusId: string, lines: readonly string[]): readonly SourceGitRef[] {
  return Object.freeze(lines.map((line): SourceGitRef => {
    const [ref, objectId, objectType, extra] = line.split('\u0000');
    if (ref === undefined || objectId === undefined || extra !== undefined || (objectType !== 'commit' && objectType !== 'tag' && objectType !== 'tree' && objectType !== 'blob')) throw new Error('C5 Git ref measurement is malformed');
    return Object.freeze({ corpus_id: corpusId, repository_label: 'repository', ref, object_id: objectId, object_type: objectType });
  }).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.repository_label}\0${left.ref}`, `${right.corpus_id}\0${right.repository_label}\0${right.ref}`)));
}

function sourceRootRow(rehearsalId: string, source: MeasuredSourceRoot): SourceRoot {
  return Object.freeze({ corpus_id: source.corpus_id, label: source.label, kind: source.kind, path_sha256: sourcePathDigest(rehearsalId, source.path), identity: source.inventory.root_identity, file_count: source.inventory.file_count, total_bytes: source.inventory.total_bytes, tree_sha256: source.inventory.tree_sha256 });
}

function sourceNodeRows(rehearsalId: string, source: MeasuredSourceRoot): readonly SourceNodeDigest[] {
  return Object.freeze(source.inventory.nodes.map((node): SourceNodeDigest => Object.freeze({ corpus_id: source.corpus_id, root_label: source.label, path_sha256: sourcePathDigest(rehearsalId, resolve(source.path, ...node.relative_path.split('/'))), kind: node.kind, identity: node.identity, mode: node.mode, size_bytes: node.size_bytes, sha256: node.sha256, symlink_target_sha256: node.symlink_target_sha256 })));
}

function sourceRegistrationRows(rehearsalId: string, corpusId: string, facts: readonly GitWorktreeRegistrationFact[]): readonly SourceRegistration[] {
  return Object.freeze(facts.map((fact): SourceRegistration => Object.freeze({ corpus_id: corpusId, repository_label: 'repository', worktree_path_sha256: sourcePathDigest(rehearsalId, fact.worktree_path), head_sha: fact.head_sha, branch_ref: fact.branch_ref, prunable: fact.prunable, path_present: existsSync(fact.worktree_path) })).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.repository_label}\0${left.worktree_path_sha256}`, `${right.corpus_id}\0${right.repository_label}\0${right.worktree_path_sha256}`)));
}

function combineProofs(results: readonly IsolationVerificationResult[]): IsolationProofs {
  const combined = (key: keyof IsolationProofs): IsolationProof => {
    const evidence = results.map((result) => result.proofs[key].evidence_sha256).sort(compareCodeUnits);
    return Object.freeze({ passed: results.every((result) => result.proofs[key].passed), evidence_sha256: digest(canonicalJson(evidence)) });
  };
  return Object.freeze({
    roots_disjoint: combined('roots_disjoint'),
    no_shared_regular_file_identity: combined('no_shared_regular_file_identity'),
    no_live_symlink_or_hardlink: combined('no_live_symlink_or_hardlink'),
    coherent_sqlite_snapshot: combined('coherent_sqlite_snapshot'),
    git_objects_self_contained: combined('git_objects_self_contained'),
    git_no_alternates_or_shared_metadata: combined('git_no_alternates_or_shared_metadata'),
    no_live_writable_remote_or_config_include: combined('no_live_writable_remote_or_config_include'),
    authority_files_removed: combined('authority_files_removed'),
    capability_fresh: combined('capability_fresh'),
    actionable_paths_clone_contained: combined('actionable_paths_clone_contained'),
    environment_clone_only: combined('environment_clone_only'),
    sandbox_write_confinement: combined('sandbox_write_confinement'),
    construction_live_unchanged: combined('construction_live_unchanged'),
  });
}

function sourceForCopy(path: string, mappings: readonly { readonly copy: string; readonly source: string }[]): string | null {
  const ordered = [...mappings].sort((left, right) => right.copy.length - left.copy.length || compareCodeUnits(left.copy, right.copy));
  for (const mapping of ordered) {
    if (!inside(mapping.copy, path)) continue;
    return resolve(mapping.source, relative(mapping.copy, path));
  }
  return null;
}

function copyMethod(path: string, scenario: BuiltCorpusScenario): CopyFileDigest['copy_method'] {
  if (path === scenario.database_path || path === scenario.raw_snapshot_database_path || path === `${scenario.raw_snapshot_database_path}-wal`) return 'sqlite-backup';
  if (path === join(scenario.scenario_root, 'private', 'toolchain', 'node')) return 'stream-copy';
  if (inside(scenario.repository_root, path)) return 'git-materialization';
  const capabilityPath = coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: scenario.state_root }).capabilityPath;
  if (path === capabilityPath || ['home', 'tmp', 'npm-cache', 'private'].some((segment) => inside(join(scenario.scenario_root, segment), path))) return 'generated-clone-authority';
  return 'stream-copy';
}

export async function captureIndependentLiveWitness(phase: 'before' | 'after', requestPath: string, outputPath: string): Promise<LiveWitness> {
  const worker = resolve(dirname(fileURLToPath(import.meta.url)), 'live-witness-worker.ts');
  const result = spawnSync(process.execPath, ['--experimental-strip-types', worker, phase, requestPath, outputPath], { encoding: 'utf8', timeout: 60 * 60 * 1000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null || result.stdout !== '') throw new Error('C5 independent live witness worker failed or emitted unexpected output');
  const input = readRegularFileNoFollow(outputPath, 64 * 1024 * 1024);
  if (input.identity.link_count !== 1 || process.platform !== 'win32' && (input.mode & 0o077) !== 0) throw new Error('C5 independent live witness output is not private single-link evidence');
  return parseLiveWitness(JSON.parse(Buffer.from(input.bytes).toString('utf8')) as unknown);
}

async function sourceGitCommon(repositoryRoot: string): Promise<string> {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repositoryRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) throw new Error('C5 source Git common-directory measurement failed');
  return realpathSync(result.stdout.trim());
}

function mappingsForScenario(input: { readonly source_state: string; readonly source_repository: string; readonly source_git_common: string; readonly copy_state: string; readonly copy_repository: string; readonly copy_git_common: string }): readonly CorpusPathMapping[] {
  const values: CorpusPathMapping[] = [
    { source_path: input.source_git_common, copy_path: input.copy_git_common, source_label: 'git-common', kind: 'git-common-dir' },
    { source_path: input.source_repository, copy_path: input.copy_repository, source_label: 'repository', kind: 'repo-root' },
    { source_path: input.source_state, copy_path: input.copy_state, source_label: 'state', kind: 'state-root' },
  ];
  const sourceEvidence = join(input.source_state, 'evidence');
  if (existsSync(sourceEvidence)) values.push({ source_path: sourceEvidence, copy_path: join(input.copy_state, 'evidence'), source_label: 'evidence', kind: 'evidence' });
  return Object.freeze(values);
}

async function buildScenario(request: CorpusCloneRequest, corpusIndex: number, sourceRoots: readonly MeasuredSourceRoot[], registrations: readonly GitWorktreeRegistrationFact[]): Promise<BuiltCorpusScenario> {
  const corpus = request.corpora[corpusIndex];
  if (corpus === undefined) throw new Error('C5 corpus index disappeared');
  const scenarioId = 'candidate-main' as const;
  const scenarioRoot = join(request.destination_root, 'corpora', corpus.corpus_id, scenarioId);
  const stateRoot = join(scenarioRoot, 'state');
  const repositoryRoot = join(scenarioRoot, 'repository');
  const rawSnapshot = join(scenarioRoot, 'private', 'source-raw', 'coordinator.db');
  await mkdir(dirname(stateRoot), { recursive: true, mode: 0o700 });
  const stateCopy = await buildIsolatedStateCopy({ source_state_root: corpus.state_root, source_repository_root: corpus.repository_root, copy_state_root: stateRoot });
  const paths = coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  const snapshot = await createCoherentSqliteSnapshot({ rehearsal_id: request.rehearsal_id, corpus_id: corpus.corpus_id, source_database_path: corpus.database_path, raw_snapshot_database_path: rawSnapshot, copy_database_path: paths.databasePath, expected_user_version: 12 });
  const mirror = await buildIsolatedGitMirror({ source_repository_root: corpus.repository_root, source_state_root: corpus.state_root, copy_root: scenarioRoot, copy_repository_root: repositoryRoot, copy_state_root: stateRoot });
  const mappings = mappingsForScenario({ source_state: corpus.state_root, source_repository: corpus.repository_root, source_git_common: await sourceGitCommon(corpus.repository_root), copy_state: stateRoot, copy_repository: repositoryRoot, copy_git_common: mirror.git_common_dir });
  const pathRebase = await rebaseCorpusPaths({ database_path: paths.databasePath, state_root: stateRoot, clone_root: scenarioRoot, mappings, ledger_path: join(scenarioRoot, 'private', 'path-rebase-ledger.json'), expected_user_version: 12 });
  const releases = join(scenarioRoot, 'releases');
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const candidateTarball = join(releases, 'candidate.tgz');
  const cf50Tarball = join(releases, 'actual-cf50.tgz');
  await copyRegularFileNoFollow(request.candidate_tarball_path, candidateTarball, 0o600);
  await copyRegularFileNoFollow(request.cf50_tarball_path, cf50Tarball, 0o600);
  const environment = await buildCloneEnvironment({ clone_root: scenarioRoot, state_root: stateRoot, project_root: repositoryRoot, home_root: join(scenarioRoot, 'home'), temp_root: join(scenarioRoot, 'tmp'), npm_cache_root: join(scenarioRoot, 'npm-cache') });
  const retainedCopyRoots: string[] = [];
  for (let index = 0; index < corpus.retained_snapshot_roots.length; index += 1) {
    const source = corpus.retained_snapshot_roots[index];
    if (source === undefined) throw new Error('C5 retained source index disappeared');
    const destination = join(scenarioRoot, 'retained', String(index).padStart(2, '0'));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await buildImmutableArtifactCopy({ source_root: source, copy_root: destination });
    retainedCopyRoots.push(destination);
  }
  const sourceBefore = sourceRoots.map((entry) => entry.inventory);
  const sentinelRoot = join(request.destination_root, 'private', 'sandbox-sentinels', corpus.corpus_id);
  const sentinelPath = join(sentinelRoot, 'immutable-sentinel');
  await mkdir(sentinelRoot, { recursive: true, mode: 0o700 });
  await writeFile(sentinelPath, 'C5 harness-owned sandbox sentinel\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  let isolation: IsolationVerificationResult;
  try {
    isolation = await verifyCloneIsolation({ source_roots: sourceRoots.map((entry) => entry.path), source_state_roots: [corpus.state_root], clone_root: scenarioRoot, copy_state_roots: [stateRoot], copy_repository_roots: [repositoryRoot], copy_artifact_roots: retainedCopyRoots, copy_database_paths: [paths.databasePath], coherent_sqlite_snapshots: [snapshot], source_before: sourceBefore, clone_environment: environment, sandbox_clone_root: scenarioRoot, sandbox_cwd: repositoryRoot, sandbox_outside_sentinel_path: sentinelPath, sandbox_outside_sentinel_owner_root: request.destination_root });
  } finally { await rm(sentinelRoot, { recursive: true, force: true }); }
  if (registrations.length !== mirror.registrations.length) throw new Error('C5 source and mirror registration counts diverged');
  return Object.freeze({ corpus_id: corpus.corpus_id, scenario_id: scenarioId, scenario_root: scenarioRoot, state_root: stateRoot, repository_root: repositoryRoot, database_path: paths.databasePath, raw_snapshot_database_path: rawSnapshot, candidate_tarball_path: candidateTarball, cf50_tarball_path: cf50Tarball, environment, state_copy: stateCopy, sqlite_snapshot: snapshot, git_mirror: mirror, path_rebase: pathRebase, mappings, isolation });
}

export async function buildCorpusClone(inputRequest: CorpusCloneRequest): Promise<BuiltCorpusClone> {
  const request = await preflightCorpusCloneRequest(inputRequest);
  const cloneRoot = request.destination_root;
  let cloneCreated = false;
  try {
    await mkdir(cloneRoot, { mode: 0o700 });
    cloneCreated = true;
    await mkdir(join(cloneRoot, 'private'), { mode: 0o700 });
    const privateRequestPath = join(cloneRoot, 'private', 'request.json');
    await writeFile(privateRequestPath, `${canonicalJson(request)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const witnessBeforePath = join(cloneRoot, 'private', 'witness-before.json');
    const witnessBefore = await captureIndependentLiveWitness('before', privateRequestPath, witnessBeforePath);

    const measuredRoots: MeasuredSourceRoot[] = [];
    const rootsByCorpus = new Map<string, readonly MeasuredSourceRoot[]>();
    const registrations = new Map<string, readonly GitWorktreeRegistrationFact[]>();
    for (const corpus of request.corpora) {
      const roots: MeasuredSourceRoot[] = [
        { corpus_id: corpus.corpus_id, label: 'repository', kind: 'live-repository', path: corpus.repository_root, inventory: await inventoryTree(corpus.repository_root) },
        { corpus_id: corpus.corpus_id, label: 'state', kind: 'live-state', path: corpus.state_root, inventory: await inventoryTree(corpus.state_root) },
      ];
      for (let index = 0; index < corpus.retained_snapshot_roots.length; index += 1) {
        const path = corpus.retained_snapshot_roots[index];
        if (path === undefined) throw new Error('C5 retained source path disappeared');
        roots.push({ corpus_id: corpus.corpus_id, label: `retained-${String(index).padStart(2, '0')}`, kind: 'retained-snapshot', path, inventory: await inventoryTree(path) });
      }
      roots.sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.label}`, `${right.corpus_id}\0${right.label}`));
      rootsByCorpus.set(corpus.corpus_id, Object.freeze(roots));
      measuredRoots.push(...roots);
      registrations.set(corpus.corpus_id, gitWorktreeRegistrationFacts(corpus.repository_root, READ_ONLY_GIT_ENV));
    }

    const scenarios: BuiltCorpusScenario[] = [];
    const sourceRefs: SourceGitRef[] = [];
    const refSets = new Map<string, readonly string[]>();
    for (let index = 0; index < request.corpora.length; index += 1) {
      const corpus = request.corpora[index];
      if (corpus === undefined) throw new Error('C5 corpus disappeared during scenario construction');
      const scenario = await buildScenario(request, index, rootsByCorpus.get(corpus.corpus_id) ?? [], registrations.get(corpus.corpus_id) ?? []);
      scenarios.push(scenario);
      sourceRefs.push(...parseRefLines(corpus.corpus_id, scenario.git_mirror.refs));
      refSets.set(corpus.corpus_id, scenario.git_mirror.refs);
    }

    const incidentMeasurement = measureRequiredIncidents({ request, registrations, ref_sets: refSets, measurement_corpora: scenarios.map((scenario) => Object.freeze({ corpus_id: scenario.corpus_id, database_path: scenario.database_path, repository_root: scenario.repository_root })) });
    const sourceRoots = measuredRoots.map((entry) => sourceRootRow(request.rehearsal_id, entry)).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.label}`, `${right.corpus_id}\0${right.label}`));
    const sourceNodes = measuredRoots.flatMap((entry) => sourceNodeRows(request.rehearsal_id, entry)).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.root_label}\0${left.path_sha256}`, `${right.corpus_id}\0${right.root_label}\0${right.path_sha256}`));
    const sourceComponents = scenarios.flatMap((scenario) => scenario.sqlite_snapshot.source_components_before).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.role}`, `${right.corpus_id}\0${right.role}`));
    const sourceRegistrations = request.corpora.flatMap((corpus) => sourceRegistrationRows(request.rehearsal_id, corpus.corpus_id, registrations.get(corpus.corpus_id) ?? [])).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.repository_label}\0${left.worktree_path_sha256}`, `${right.corpus_id}\0${right.repository_label}\0${right.worktree_path_sha256}`));
    const copyRoots: CopyRoot[] = [];
    const copyFiles: CopyFileDigest[] = [];
    const copyGitFacts: CopyGitFact[] = [];
    const pathRebases: PathRebase[] = [];
    const capabilityDigests: Sha256Digest[] = [];
    for (const scenario of scenarios) {
      const corpus = request.corpora.find((entry) => entry.corpus_id === scenario.corpus_id);
      if (corpus === undefined) throw new Error('C5 scenario corpus disappeared');
      const inventory = await inventoryTree(scenario.scenario_root);
      copyRoots.push(Object.freeze({ corpus_id: scenario.corpus_id, scenario_id: scenario.scenario_id, label: 'scenario', clone_relative_path: cloneRelative(cloneRoot, scenario.scenario_root), identity: inventory.root_identity, file_count: inventory.file_count, total_bytes: inventory.total_bytes, tree_sha256: inventory.tree_sha256 }));
      const retainedMappings = corpus.retained_snapshot_roots.map((source, index) => ({ source, copy: join(scenario.scenario_root, 'retained', String(index).padStart(2, '0')) }));
      const sourceMappings = [{ source: corpus.state_root, copy: scenario.state_root }, { source: corpus.repository_root, copy: scenario.repository_root }, { source: corpus.database_path, copy: scenario.raw_snapshot_database_path }, { source: `${corpus.database_path}-wal`, copy: `${scenario.raw_snapshot_database_path}-wal` }, { source: process.execPath, copy: join(scenario.scenario_root, 'private', 'toolchain', 'node') }, ...retainedMappings, { source: request.candidate_tarball_path, copy: scenario.candidate_tarball_path }, { source: request.cf50_tarball_path, copy: scenario.cf50_tarball_path }];
      for (const node of inventory.nodes) {
        if (node.kind !== 'regular' || node.sha256 === null) continue;
        const absoluteCopy = resolve(scenario.scenario_root, ...node.relative_path.split('/'));
        const method = copyMethod(absoluteCopy, scenario);
        const source = method === 'generated-clone-authority' ? null : sourceForCopy(absoluteCopy, sourceMappings);
        copyFiles.push(Object.freeze({ corpus_id: scenario.corpus_id, scenario_id: scenario.scenario_id, root_label: 'scenario', clone_relative_path: cloneRelative(cloneRoot, absoluteCopy), source_path_sha256: source === null ? null : sourcePathDigest(request.rehearsal_id, source), identity: node.identity, mode: node.mode, size_bytes: node.size_bytes, sha256: node.sha256, copy_method: method }));
      }
      for (const ref of parseRefLines(scenario.corpus_id, scenario.git_mirror.refs)) copyGitFacts.push(Object.freeze({ kind: 'ref', corpus_id: ref.corpus_id, scenario_id: scenario.scenario_id, repository_label: ref.repository_label, ref: ref.ref, object_id: ref.object_id, object_type: ref.object_type }));
      for (const registration of scenario.git_mirror.registrations) copyGitFacts.push(Object.freeze({ kind: 'registration', corpus_id: scenario.corpus_id, scenario_id: scenario.scenario_id, repository_label: 'repository', worktree_relative_path: cloneRelative(cloneRoot, registration.worktree_path), head_sha: registration.head_sha, branch_ref: registration.branch_ref, prunable: registration.prunable, path_present: existsSync(registration.worktree_path) }));
      for (const mapping of scenario.mappings) pathRebases.push(Object.freeze({ corpus_id: scenario.corpus_id, source_path_sha256: sourcePathDigest(request.rehearsal_id, mapping.source_path), source_label: mapping.source_label, clone_relative_path: cloneRelative(cloneRoot, mapping.copy_path), kind: mapping.kind, rewrite_ledger_sha256: scenario.path_rebase.ledger_sha256 }));
      capabilityDigests.push(scenario.state_copy.capability_sha256);
    }
    copyRoots.sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.scenario_id}\0${left.label}`, `${right.corpus_id}\0${right.scenario_id}\0${right.label}`));
    copyFiles.sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.scenario_id}\0${left.root_label}\0${left.clone_relative_path}`, `${right.corpus_id}\0${right.scenario_id}\0${right.root_label}\0${right.clone_relative_path}`));
    copyGitFacts.sort((left, right) => compareCodeUnits(left.kind === 'ref' ? `${left.corpus_id}\0${left.scenario_id}\0ref\0${left.ref}` : `${left.corpus_id}\0${left.scenario_id}\0registration\0${left.worktree_relative_path}`, right.kind === 'ref' ? `${right.corpus_id}\0${right.scenario_id}\0ref\0${right.ref}` : `${right.corpus_id}\0${right.scenario_id}\0registration\0${right.worktree_relative_path}`));
    pathRebases.sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.source_path_sha256}`, `${right.corpus_id}\0${right.source_path_sha256}`));
    const manifestValue = {
      schema_version: S1_CORPUS_CLONE_MANIFEST_SCHEMA,
      rehearsal_id: request.rehearsal_id,
      created_at: request.created_at,
      source_roots: sourceRoots,
      source_database_components: sourceComponents,
      source_file_digests: sourceNodes,
      source_git_refs: sourceRefs.sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.repository_label}\0${left.ref}`, `${right.corpus_id}\0${right.repository_label}\0${right.ref}`)),
      source_worktree_registrations: sourceRegistrations,
      copy_roots: copyRoots,
      copy_file_digests: copyFiles,
      copy_git_refs: copyGitFacts,
      path_rebase_map: pathRebases,
      backup_coverage: incidentMeasurement.backup_coverage,
      capability_sha256: digest(canonicalJson(capabilityDigests.sort(compareCodeUnits))),
      isolation_proofs: combineProofs(scenarios.map((scenario) => scenario.isolation)),
      required_incidents: incidentMeasurement.requirements,
    };
    const manifest = parseCorpusCloneManifest(manifestValue);
    const manifestPath = join(cloneRoot, 'private', 'manifest.json');
    await writeFile(manifestPath, `${canonicalJson(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return Object.freeze({ request, manifest, clone_root: cloneRoot, private_request_path: privateRequestPath, witness_before_path: witnessBeforePath, witness_before: witnessBefore, scenarios: Object.freeze(scenarios), source_inventories: Object.freeze(measuredRoots.map((entry) => entry.inventory)) });
  } catch (error) {
    if (cloneCreated) {
      try { await rm(cloneRoot, { recursive: true, force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'C5 clone construction failed and private clone cleanup also failed'); }
    }
    throw error;
  }
}
