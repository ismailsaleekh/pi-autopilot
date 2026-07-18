import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { parseCoordinationEditLease, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationUnitAttempt, parseCoordinationWorktree, parseCoordinationWorktreeOperation } from '../../src/core/coordination/contracts.ts';
import { parseLegacyActiveAutopilots } from '../../src/core/coordination/legacy-preflight.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import type { CoordinationOwnerIdentity, CoordinationRun, CoordinationRunResource, CoordinationWorktree } from '../../src/core/coordination/types.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import { captureIndependentLiveWitness, type BuiltCorpusClone, type BuiltCorpusScenario } from './clone-controller.ts';
import { closedGitWorktreeRegistrationFacts } from './closed-git-registration.ts';
import { forkScenarioState, type ForkedScenarioState } from './clone-injections.ts';
import { historicalSemanticTwinAliases } from './incident-measurement.ts';
import {
  parseCorpusRehearsalResult,
  S1_CORPUS_REHEARSAL_RESULT_SCHEMA,
  S1_I2_OPERATION_ID,
  type CorpusRehearsalResult,
  type Sha256Digest,
} from './contracts.ts';
import { compareCodeUnits, copyRegularFileNoFollow, inventoryTree, readRegularFileNoFollow, sourcePathDigest } from './inventory.ts';
import { installPackedRelease, type InstalledPackedRelease } from './release-install.ts';
import { runSandboxed } from './sandbox.ts';
import { logicalSqliteDigest } from './sqlite-snapshot.ts';


interface JsonObject { readonly [key: string]: unknown }
interface RunDescriptor { readonly repo: JsonObject; readonly run: CoordinationRun; readonly resource: CoordinationRunResource; readonly active: JsonObject; readonly active_source: 'rebased-metadata' | 'durable-projection' }
export interface ScenarioWorkerScenarioAuthority extends Pick<BuiltCorpusScenario, 'corpus_id' | 'scenario_id' | 'scenario_root' | 'state_root' | 'repository_root' | 'database_path' | 'candidate_tarball_path' | 'cf50_tarball_path' | 'environment' | 'git_mirror'> {}

export interface ScenarioWorkerCloneAuthority {
  readonly request: BuiltCorpusClone['request'];
  readonly manifest: Pick<BuiltCorpusClone['manifest'], 'required_incidents' | 'backup_coverage'>;
}

export interface WorkerOutput {
  readonly rehearsal_id: string;
  readonly corpus_id: string;
  readonly scenario_id: string;
  readonly generation_id: string;
  readonly attach_results: readonly unknown[];
  readonly doctor_results: readonly unknown[];
  readonly reconciliation_results: readonly unknown[];
  readonly dispatch_dry_run_results: readonly unknown[];
  readonly incident_results: readonly unknown[];
}

function digest(value: string | Uint8Array | unknown): Sha256Digest {
  const bytes = typeof value === 'string' || value instanceof Uint8Array ? value : canonicalJson(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function record(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) throw new Error(`${label} must be nonempty text`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.['count'] === 1;
}

function runKey(repoId: string, run: string): string { return `${repoId}\u0000${run}`; }
export function corpusRunIdentityDigest(repoId: string, run: string): Sha256Digest { return digest(runKey(repoId, run)); }

function activeStatus(status: CoordinationRun['status']): 'active' | 'paused' | 'merging' | 'blocked' | 'closed' {
  return status === 'recovering' ? 'blocked' : status === 'closed' || status === 'aborted' ? 'closed' : status;
}

function rebasedActiveRows(stateRoot: string): readonly JsonObject[] {
  const paths: string[] = [];
  const pending = [stateRoot];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) throw new Error('C5 active metadata traversal underflow');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
      visited += 1;
      if (visited > 1_000_000) throw new Error('C5 active metadata traversal exceeds bounded limits');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === 'active-autopilots.json') paths.push(path);
    }
    if (paths.length > 10_000 || pending.length > 1_000_000) throw new Error('C5 active metadata traversal exceeds bounded limits');
  }
  const rows: JsonObject[] = [];
  for (const path of paths.sort(compareCodeUnits)) {
    const input = readRegularFileNoFollow(path, 64 * 1024 * 1024);
    if (input.identity.link_count !== 1) throw new Error('C5 active metadata is not a bounded single-link physical file');
    const value: unknown = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as unknown;
    rows.push(...parseLegacyActiveAutopilots(value).map((row) => record(row, 'C5 rebased active metadata row')));
  }
  return Object.freeze(rows);
}

function readRunDescriptors(databasePath: string, stateRoot: string): readonly RunDescriptor[] {
  const activeRows = rebasedActiveRows(stateRoot);
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 30_000 });
  try {
    database.exec('PRAGMA query_only=ON');
    const repositories = new Map<string, JsonObject>();
    for (const row of database.prepare('SELECT repo_id,repo_key,canonical_root,git_common_dir,created_event_seq,version FROM repositories ORDER BY repo_id').all()) {
      const repoId = text(row['repo_id'], 'repository ID');
      repositories.set(repoId, Object.freeze({ repo_id: repoId, repo_key: text(row['repo_key'], 'repository key'), canonical_root: text(row['canonical_root'], 'repository root'), git_common_dir: text(row['git_common_dir'], 'Git common directory'), created_event_seq: integer(row['created_event_seq'], 'repository created event'), version: integer(row['version'], 'repository version') }));
    }
    const output: RunDescriptor[] = [];
    for (const row of database.prepare('SELECT * FROM runs ORDER BY repo_id,workstream_run').all()) {
      const run = parseCoordinationRun({ schema_version: 'autopilot.coordination_run.v1', repo_id: row['repo_id'], autopilot_id: row['autopilot_id'], workstream: row['workstream'], workstream_run: row['workstream_run'], coordination_authority: row['coordination_authority'], status: row['status'], active_session_generation: row['active_session_generation'], created_event_seq: row['created_event_seq'], version: row['version'] });
      const resourceRow = database.prepare('SELECT payload_json FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run);
      const resourceText = text(resourceRow?.['payload_json'], 'run-resource payload');
      const resource = parseCoordinationRunResource(JSON.parse(resourceText) as unknown);
      const repository = repositories.get(run.repo_id);
      if (repository === undefined) throw new Error('C5 durable run repository disappeared');
      const repoKey = text(repository['repo_key'], 'repository key');
      const repo = Object.freeze({ repoRoot: repository['canonical_root'], gitCommonDir: repository['git_common_dir'], repoKey, headSha: resource.target_base_sha, targetBranch: resource.target_branch, originUrl: resource.origin_url });
      const matchingActive = activeRows.filter((entry) => entry['autopilot_id'] === run.autopilot_id && entry['workstream_run'] === run.workstream_run && entry['repo_key'] === repoKey);
      if (matchingActive.length > 1) throw new Error('C5 rebased active metadata has duplicate durable-run authority');
      const measuredActive = matchingActive[0];
      const activeSource = measuredActive === undefined ? 'durable-projection' as const : 'rebased-metadata' as const;
      const active = measuredActive === undefined
        ? Object.freeze({ schema_version: 'autopilot.active_parent.v2', coordination_authority: run.coordination_authority, autopilot_id: run.autopilot_id, workstream: run.workstream, workstream_run: run.workstream_run, repo_key: repoKey, source_repo: resource.source_repo, git_common_dir: resource.git_common_dir, worktree_root: resource.worktree_root, main_worktree_path: resource.main_worktree_path, branch: resource.branch, runtime_root: resource.runtime_root, target_branch: resource.target_branch, target_base_sha: resource.target_base_sha, origin_url: resource.origin_url, pid: 0, boot_id: 'c5-worker-rebound', status: activeStatus(run.status), started_at: resource.started_at, active_run_epoch: 1, active_epoch_started_at: resource.started_at, active_run_receipt_id: `c5-${digest(runKey(run.repo_id, run.workstream_run)).slice(7, 39)}` })
        : Object.freeze({ ...measuredActive, pid: 0, boot_id: 'c5-worker-rebound' });
      output.push(Object.freeze({ repo, run, resource, active, active_source: activeSource }));
    }
    return Object.freeze(output);
  } finally { database.close(); }
}

function descriptorByRun(runs: readonly RunDescriptor[]): ReadonlyMap<string, RunDescriptor> {
  return new Map(runs.map((entry) => [runKey(entry.run.repo_id, entry.run.workstream_run), entry]));
}

function buildI2Descriptor(scenario: ScenarioWorkerScenarioAuthority, runs: ReadonlyMap<string, RunDescriptor>, manifest: ScenarioWorkerCloneAuthority['manifest']): JsonObject {
  const requirement = manifest.required_incidents[1];
  if (requirement.corpus_id !== scenario.corpus_id) return Object.freeze({});
  const database = new DatabaseSync(scenario.database_path, { readOnly: true, timeout: 30_000 });
  try {
    database.exec('PRAGMA query_only=ON');
    const row = database.prepare('SELECT payload_json FROM worktree_operations WHERE entity_id=?').get(S1_I2_OPERATION_ID);
    const operation = parseCoordinationWorktreeOperation(JSON.parse(text(row?.['payload_json'], 'I2 operation payload')) as unknown);
    if (operation.operation_type === 'metadata-reconcile') throw new Error('C5 I2 operation has the wrong intent family');
    if (operation.intent.repo_root !== scenario.repository_root || !operation.intent.worktree_path.startsWith(`${scenario.scenario_root}${sep}`)) throw new Error('C5 I2 operation paths differ from isolated scenario authority');
    const key = runKey(operation.owner.repo_id, operation.owner.workstream_run);
    const run = runs.get(key);
    if (run === undefined) throw new Error('C5 I2 durable run disappeared');
    const leases = database.prepare('SELECT payload_json FROM edit_leases ORDER BY entity_id').all().map((lease) => parseCoordinationEditLease(JSON.parse(text(lease['payload_json'], 'I2 edit lease')) as unknown)).filter((lease) => lease.mode === 'WRITE' && canonicalJson(lease.owner) === canonicalJson(operation.owner));
    if (leases.length !== 42) throw new Error('C5 I2 clone does not retain the exact 42-WRITE-lease authority shape');
    const leaseIds = leases.map((lease) => lease.edit_lease_id).sort(compareCodeUnits);
    if (digest(canonicalJson(operation.owner)) !== requirement.owner_sha256 || digest(canonicalJson([...operation.intent.paths].sort(compareCodeUnits))) !== requirement.exact_path_set_sha256 || digest(canonicalJson(leaseIds)) !== requirement.historical_write_lease_ids_sha256) throw new Error('C5 I2 clone authority differs from the exact measured owner/path/lease manifest');
    return Object.freeze({ run_key: key, operation_id: operation.operation_id, capture_sha: requirement.capture_sha, branch_ref: `refs/heads/${operation.intent.branch}`, worktree_path: operation.intent.worktree_path, parent_sha: requirement.parent_sha, path_set_sha256: requirement.exact_path_set_sha256, historical_lease_ids: Object.freeze(leaseIds) });
  } finally { database.close(); }
}

function buildI3Descriptor(scenario: ScenarioWorkerScenarioAuthority, runs: ReadonlyMap<string, RunDescriptor>, manifest: ScenarioWorkerCloneAuthority['manifest']): JsonObject {
  const requirement = manifest.required_incidents[2];
  if (requirement.corpus_id !== scenario.corpus_id) return Object.freeze({});
  const database = new DatabaseSync(scenario.database_path, { readOnly: true, timeout: 30_000 });
  try {
    database.exec('PRAGMA query_only=ON');
    const worktrees = database.prepare('SELECT payload_json FROM worktrees ORDER BY entity_id').all().map((row) => parseCoordinationWorktree(JSON.parse(text(row['payload_json'], 'I3 worktree')) as unknown));
    const aliases = historicalSemanticTwinAliases(worktrees);
    if (aliases.length !== 46) throw new Error('C5 I3 clone does not retain exactly 46 semantic twins');
    const aliasIds = new Set(aliases.map((worktree) => worktree.worktree_id));
    const operations = database.prepare('SELECT payload_json FROM worktree_operations ORDER BY entity_id').all().map((row) => parseCoordinationWorktreeOperation(JSON.parse(text(row['payload_json'], 'I3 operation')) as unknown)).filter((operation) => aliasIds.has(operation.worktree_id)).sort((left, right) => compareCodeUnits(left.operation_id, right.operation_id));
    const semanticIds = aliases.map((worktree) => deterministicWorktreeId(worktree.owner, worktree.kind)).sort(compareCodeUnits);
    if (new Set(semanticIds).size !== 46) throw new Error('C5 I3 clone aliases do not represent 46 distinct semantic identities');
    if (digest(canonicalJson(semanticIds)) !== requirement.semantic_identity_set_sha256 || digest(canonicalJson(operations.map((operation) => operation.operation_id))) !== requirement.operation_history_set_sha256) throw new Error('C5 I3 clone semantic identity/history differs from the measured manifest');
    const attempts = tableExists(database, 'unit_attempts') ? database.prepare('SELECT payload_json FROM unit_attempts ORDER BY entity_id').all().map((row) => parseCoordinationUnitAttempt(JSON.parse(text(row['payload_json'], 'I3 unit attempt')) as unknown)) : [];
    const nextExists = (owner: CoordinationOwnerIdentity): boolean => attempts.some((attempt) => attempt.owner.repo_id === owner.repo_id && attempt.owner.workstream_run === owner.workstream_run && attempt.owner.unit_id === owner.unit_id && attempt.owner.attempt === owner.attempt + 1);
    const safe = aliases.find((worktree) => {
      const run = runs.get(runKey(worktree.owner.repo_id, worktree.owner.workstream_run));
      return run !== undefined && run.run.status !== 'closed' && run.run.status !== 'aborted' && existsSync(text(run.active['main_worktree_path'], 'I3 main worktree')) && !nextExists(worktree.owner);
    });
    if (safe === undefined) throw new Error('C5 I3 has no mechanically safe next-attempt owner with a surviving main worktree');
    const safeKey = runKey(safe.owner.repo_id, safe.owner.workstream_run);
    const safeRun = runs.get(safeKey);
    if (safeRun === undefined) throw new Error('C5 I3 safe run disappeared');
    if (digest(canonicalJson({ ...safe.owner, attempt: safe.owner.attempt + 1 })) !== requirement.next_attempt_owner_sha256) throw new Error('C5 I3 safe next-attempt owner differs from measured manifest authority');
    const runKeys = [...new Set(aliases.map((worktree) => runKey(worktree.owner.repo_id, worktree.owner.workstream_run)))].sort(compareCodeUnits);
    return Object.freeze({ run_keys: Object.freeze(runKeys), alias_ids: Object.freeze(aliases.map((worktree) => worktree.worktree_id)), safe_run_key: safeKey, safe_unit_id: safe.owner.unit_id, safe_attempt: safe.owner.attempt + 1 });
  } finally { database.close(); }
}

export function durableWorktreeForRegistration(worktrees: readonly CoordinationWorktree[], registration: { readonly worktree_path: string; readonly branch_ref: string | null }): CoordinationWorktree {
  const branchRef = registration.branch_ref;
  if (branchRef === null || !branchRef.startsWith('refs/heads/')) throw new Error('C5 I5 registration omits an owned branch ref');
  const branch = branchRef.slice('refs/heads/'.length);
  const matching = worktrees.filter((worktree) => worktree.canonical_path === registration.worktree_path && worktree.branch === branch && worktree.worktree_id === deterministicWorktreeId(worktree.owner, worktree.kind));
  if (matching.length !== 1) throw new Error('C5 I5 registration does not map to exactly one real canonical durable worktree row');
  const worktree = matching[0];
  if (worktree === undefined) throw new Error('C5 I5 durable worktree disappeared');
  return worktree;
}

function parseMirrorRef(lines: readonly string[]): readonly { readonly ref: string; readonly sha: string }[] {
  return Object.freeze(lines.map((line) => {
    const [ref, sha, _type, extra] = line.split('\u0000');
    if (ref === undefined || sha === undefined || extra !== undefined) throw new Error('C5 mirror ref is malformed');
    return Object.freeze({ ref, sha });
  }));
}

function sourcePathForMirrorRegistration(scenario: ScenarioWorkerScenarioAuthority, sourceState: string, sourceRepository: string, path: string): string {
  if (path === scenario.repository_root) return sourceRepository;
  const rel = relative(scenario.state_root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('C5 I5 mirror registration is outside mapped state/repository roots');
  return resolve(sourceState, rel);
}

async function buildI5Descriptor(input: { readonly clone: ScenarioWorkerCloneAuthority; readonly scenario: ScenarioWorkerScenarioAuthority; readonly runs: ReadonlyMap<string, RunDescriptor> }): Promise<JsonObject> {
  const requirement = input.clone.manifest.required_incidents[4];
  if (requirement.corpus_id !== input.scenario.corpus_id) return Object.freeze({ approvals: [], before_registrations: [], expected_after_registrations: [], preserved_refs: [] });
  const corpus = input.clone.request.corpora.find((entry) => entry.corpus_id === input.scenario.corpus_id);
  if (corpus === undefined) throw new Error('C5 I5 source corpus disappeared');
  const database = new DatabaseSync(input.scenario.database_path, { readOnly: true, timeout: 30_000 });
  let durableWorktrees: readonly CoordinationWorktree[];
  try {
    database.exec('PRAGMA query_only=ON');
    durableWorktrees = Object.freeze(database.prepare('SELECT payload_json FROM worktrees ORDER BY entity_id').all().map((row) => parseCoordinationWorktree(JSON.parse(text(row['payload_json'], 'I5 durable worktree')) as unknown)));
  } finally { database.close(); }
  const before = input.scenario.git_mirror.registrations;
  const prunable = before.filter((entry) => entry.prunable);
  if (prunable.length !== 34 || prunable.some((entry) => existsSync(entry.worktree_path))) throw new Error('C5 I5 clone does not retain exact 34 path-missing prunable registrations');
  const approvedPaths = prunable.map((entry) => entry.worktree_path).sort(compareCodeUnits);
  const after = before.filter((entry) => !entry.prunable);
  const preservedRefs = parseMirrorRef(input.scenario.git_mirror.refs).filter((entry) => /^refs\/(?:heads|autopilot|tags)\//u.test(entry.ref)).sort((left, right) => compareCodeUnits(left.ref, right.ref));
  const measuredRegistrations = prunable.map((entry) => ({ worktree_path_sha256: sourcePathDigest(input.clone.request.rehearsal_id, sourcePathForMirrorRegistration(input.scenario, corpus.state_root, corpus.repository_root, entry.worktree_path)), head_sha: entry.head_sha, branch_ref: entry.branch_ref, prunable: entry.prunable })).sort((left, right) => compareCodeUnits(left.worktree_path_sha256, right.worktree_path_sha256));
  if (digest(canonicalJson(measuredRegistrations)) !== requirement.registration_set_sha256 || digest(canonicalJson([...input.scenario.git_mirror.refs].sort(compareCodeUnits))) !== requirement.preserved_ref_set_sha256) throw new Error('C5 I5 clone registration/ref authority differs from the measured manifest');
  const coverage = new Map(input.clone.manifest.backup_coverage.filter((entry) => entry.incident_id === 'I5' && entry.corpus_id === input.scenario.corpus_id).map((entry) => [entry.subject_id_sha256, entry]));
  const approvals: JsonObject[] = [];
  const canonicalIds = new Set<string>();
  const approvalRepositories = new Set<string>();
  for (const registration of prunable) {
    const branchRef = registration.branch_ref;
    const worktree = durableWorktreeForRegistration(durableWorktrees, registration);
    if (branchRef === null) throw new Error('C5 I5 durable worktree registration lost its branch ref');
    const branch = branchRef.slice('refs/heads/'.length);
    const owner = worktree.owner;
    const kind = worktree.kind;
    const canonicalId = worktree.worktree_id;
    if (canonicalIds.has(canonicalId)) throw new Error('C5 I5 approvals contain duplicate canonical identity');
    canonicalIds.add(canonicalId);
    const sourcePath = sourcePathForMirrorRegistration(input.scenario, corpus.state_root, corpus.repository_root, registration.worktree_path);
    const subject = sourcePathDigest(input.clone.request.rehearsal_id, sourcePath);
    const measuredCoverage = coverage.get(subject);
    if (measuredCoverage === undefined) throw new Error('C5 I5 approval lacks exact backup coverage evidence');
    const evidencePath = join(input.scenario.scenario_root, 'private', 'recovery-approvals', `${canonicalId}.json`);
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    const evidenceBytes = `${canonicalJson({ schema_version: 'autopilot.s1_corpus_reconcile_approval_evidence.v1', subject_id_sha256: subject, coverage: measuredCoverage.coverage, snapshot_label: measuredCoverage.snapshot_label, branch_ref: branchRef, head_sha: registration.head_sha, path_missing: true })}\n`;
    await writeFile(evidencePath, evidenceBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const recoverySha = digest(evidenceBytes);
    if (worktree.git_common_dir !== input.scenario.git_mirror.git_common_dir) throw new Error('C5 I5 durable worktree does not bind the isolated Git mirror');
    const runKeyValue = runKey(owner.repo_id, owner.workstream_run);
    const run = input.runs.get(runKeyValue);
    if (run === undefined) throw new Error('C5 I5 worktree owner run disappeared');
    approvalRepositories.add(owner.repo_id);
    const expectedWorktreeRoot = join(input.scenario.state_root, 'worktrees', text(run.repo['repoKey'], 'I5 repository key'));
    if (resolve(run.resource.worktree_root) !== resolve(expectedWorktreeRoot)) throw new Error('C5 I5 production batch requires the exact repository coordination worktree root');
    approvals.push(Object.freeze({ run_key: runKeyValue, worktree_root: run.resource.worktree_root, approval: Object.freeze({ semantic_identity: Object.freeze({ ...owner, kind }), worktree, recovery_evidence_path: evidencePath, intent: Object.freeze({ schema_version: 'autopilot.worktree_metadata_reconcile_intent.v1', repo_id: owner.repo_id, canonical_worktree_id: canonicalId, git_common_dir: input.scenario.git_mirror.git_common_dir, target_registration_path: registration.worktree_path, approved_before_registrations: before, approved_prunable_registration_paths: approvedPaths, expected_after_registrations: after, preserved_refs: preservedRefs, recovery_evidence_sha256: recoverySha }) }) }));
  }
  if (approvalRepositories.size !== 1) throw new Error('C5 I5 production metadata batch must be owned by exactly one repository');
  approvals.sort((left, right) => compareCodeUnits(text(record(left['approval'], 'I5 approval')['worktree'] === undefined ? '' : record(record(left['approval'], 'I5 approval')['worktree'], 'I5 worktree')['worktree_id'], 'I5 canonical ID'), text(record(right['approval'], 'I5 approval')['worktree'] === undefined ? '' : record(record(right['approval'], 'I5 approval')['worktree'], 'I5 worktree')['worktree_id'], 'I5 canonical ID')));
  return Object.freeze({ approvals: Object.freeze(approvals), before_registrations: before, expected_after_registrations: after, preserved_refs: preservedRefs });
}

function buildI4Descriptor(scenario: ScenarioWorkerScenarioAuthority, runs: ReadonlyMap<string, RunDescriptor>, fork: ForkedScenarioState | null, manifest: ScenarioWorkerCloneAuthority['manifest']): JsonObject {
  const requirement = manifest.required_incidents[3];
  if (requirement.corpus_id !== scenario.corpus_id) return Object.freeze({});
  if (fork === null) throw new Error('C5 I4 scenario fork is missing');
  const faultedKey = runKey(fork.selected_repo_id, fork.faulted_run);
  const healthyKey = runKey(fork.selected_repo_id, fork.healthy_run);
  if (!runs.has(faultedKey) || !runs.has(healthyKey) || digest(fork.selected_repo_id) !== requirement.counter_behind_repo_sha256 || digest(fork.faulted_run) !== requirement.faulted_run_sha256 || digest(fork.healthy_run) !== requirement.healthy_run_sha256) throw new Error('C5 I4 controlled scenarios differ from the measured manifest subjects');
  return Object.freeze({ faulted_run_key: faultedKey, healthy_run_key: healthyKey });
}

function assertWorkerSocketPathReachable(stateRoot: string, environment: Readonly<Record<string, string>>): void {
  if (process.platform === 'win32') return;
  const temporaryRoot = text(environment['TMPDIR'], 'C5 clone TMPDIR');
  const preferred = [join(stateRoot, 'coordinator', 'coordinator.sock'), join(stateRoot, 'coordinator', 'coordinator.protocol-1.3-schema-9.sock')];
  const fallback = join(temporaryRoot, `pi-autopilot-${'0'.repeat(32)}.sock`);
  if (preferred.some((path) => Buffer.byteLength(path, 'utf8') > 100) && Buffer.byteLength(fallback, 'utf8') > 100) throw new Error('C5 incident fork has no bounded Unix coordinator socket path');
}

function installedDescriptor(release: InstalledPackedRelease): Readonly<Record<string, string>> {
  const root = release.package_root;
  return Object.freeze({ package_root: root, coordinator_cli_path: release.coordinator_cli_path, client_module_path: release.client_module_path, supervisor_module_path: join(root, 'dist', 'src', 'core', 'coordination', 'supervisor.js'), worktree_saga_module_path: join(root, 'dist', 'src', 'core', 'coordination', 'worktree-saga.js'), parallel_runtime_module_path: join(root, 'dist', 'src', 'core', 'parallel-runtime.js'), identity_resolution_module_path: join(root, 'dist', 'src', 'core', 'coordination', 'identity-fault-resolution.js'), metadata_reconcile_module_path: join(root, 'dist', 'src', 'core', 'coordination', 'metadata-reconcile-operation.js'), scheduler_module_path: join(root, 'dist', 'src', 'core', 'scheduler.js'), contract_validate_module_path: join(root, 'dist', 'src', 'core', 'contracts', 'validate.js'), scheduler_config_module_path: join(root, 'dist', 'src', 'core', 'scheduler-config.js'), reservations_module_path: join(root, 'dist', 'src', 'core', 'coordination', 'reservations.js') });
}

function parseWorkerOutput(value: unknown, expected: { readonly rehearsal_id: string; readonly corpus_id: string; readonly scenario_id: string }): WorkerOutput {
  const row = record(value, 'C5 incident worker output');
  const fields = ['schema_version', 'rehearsal_id', 'corpus_id', 'scenario_id', 'generation_id', 'attach_results', 'doctor_results', 'reconciliation_results', 'dispatch_dry_run_results', 'incident_results'];
  if (canonicalJson(Object.keys(row).sort()) !== canonicalJson(fields.sort()) || row['schema_version'] !== 'autopilot.s1_corpus_incident_worker_output.v1' || row['rehearsal_id'] !== expected.rehearsal_id || row['corpus_id'] !== expected.corpus_id || row['scenario_id'] !== expected.scenario_id || typeof row['generation_id'] !== 'string' || !/^generation-[a-f0-9]{32}$/u.test(row['generation_id'])) throw new Error('C5 incident worker output identity is malformed');
  for (const field of ['attach_results', 'doctor_results', 'reconciliation_results', 'dispatch_dry_run_results', 'incident_results'] as const) if (!Array.isArray(row[field])) throw new Error(`C5 incident worker output ${field} is not an array`);
  return Object.freeze({ rehearsal_id: expected.rehearsal_id, corpus_id: expected.corpus_id, scenario_id: expected.scenario_id, generation_id: row['generation_id'], attach_results: row['attach_results'] as readonly unknown[], doctor_results: row['doctor_results'] as readonly unknown[], reconciliation_results: row['reconciliation_results'] as readonly unknown[], dispatch_dry_run_results: row['dispatch_dry_run_results'] as readonly unknown[], incident_results: row['incident_results'] as readonly unknown[] });
}

export async function runScenarioWorker(clone: ScenarioWorkerCloneAuthority, scenario: ScenarioWorkerScenarioAuthority): Promise<WorkerOutput> {
  const corpus = clone.request.corpora.find((entry) => entry.corpus_id === scenario.corpus_id);
  if (corpus === undefined) throw new Error('C5 worker source corpus disappeared');
  const deniedRoots = clone.request.corpora.flatMap((entry) => [entry.state_root, entry.repository_root, ...entry.retained_snapshot_roots]);
  const candidate = await installPackedRelease({ scenario_root: scenario.scenario_root, project_root: scenario.repository_root, environment: scenario.environment.env, denied_source_roots: deniedRoots, tarball_path: scenario.candidate_tarball_path, expected_tarball_sha256: clone.request.candidate_tarball_sha256, release_kind: 'candidate' });
  const cf50 = await installPackedRelease({ scenario_root: scenario.scenario_root, project_root: scenario.repository_root, environment: scenario.environment.env, denied_source_roots: deniedRoots, tarball_path: scenario.cf50_tarball_path, expected_tarball_sha256: clone.request.cf50_tarball_sha256, release_kind: 'actual-cf50' });
  const enabled = clone.manifest.required_incidents.filter((requirement) => requirement.corpus_id === scenario.corpus_id).map((requirement) => requirement.incident_id).sort(compareCodeUnits);
  const states: Record<string, string> = {};
  for (const id of enabled.includes('I1') ? ['i1-cf50-to-s1', 'i1-s1-to-cf50', 'i1-mixed-election'] : []) states[id] = (await forkScenarioState({ rehearsal_id: clone.request.rehearsal_id, corpus_id: scenario.corpus_id, sandbox_root: scenario.scenario_root, base_database_path: scenario.database_path, scenario_id: id, injection: 'none' })).state_root;
  let i4Base: ForkedScenarioState | null = null;
  if (enabled.includes('I4')) {
    i4Base = await forkScenarioState({ rehearsal_id: clone.request.rehearsal_id, corpus_id: scenario.corpus_id, sandbox_root: scenario.scenario_root, base_database_path: scenario.database_path, scenario_id: 'i4-counter-behind', injection: 'counter-behind' });
    states['i4-counter-behind'] = i4Base.state_root;
    states['i4-counter-ahead'] = (await forkScenarioState({ rehearsal_id: clone.request.rehearsal_id, corpus_id: scenario.corpus_id, sandbox_root: scenario.scenario_root, base_database_path: scenario.database_path, scenario_id: 'i4-counter-ahead', injection: 'counter-ahead' })).state_root;
    states['i4-payload-owner-ambiguous'] = (await forkScenarioState({ rehearsal_id: clone.request.rehearsal_id, corpus_id: scenario.corpus_id, sandbox_root: scenario.scenario_root, base_database_path: scenario.database_path, scenario_id: 'i4-payload-owner-ambiguous', injection: 'payload-owner-ambiguous' })).state_root;
    states['i4-scoped-logical-row-fault'] = (await forkScenarioState({ rehearsal_id: clone.request.rehearsal_id, corpus_id: scenario.corpus_id, sandbox_root: scenario.scenario_root, base_database_path: scenario.database_path, scenario_id: 'i4-scoped-logical-row-fault', injection: 'none' })).state_root;
    states['i4-physical-integrity'] = (await forkScenarioState({ rehearsal_id: clone.request.rehearsal_id, corpus_id: scenario.corpus_id, sandbox_root: scenario.scenario_root, base_database_path: scenario.database_path, scenario_id: 'i4-physical-integrity', injection: 'physical-integrity' })).state_root;
  }
  for (const stateRoot of Object.values(states)) assertWorkerSocketPathReachable(stateRoot, scenario.environment.env);
  const lockPaths = Object.freeze(Object.fromEntries(Object.entries(states).map(([key, stateRoot]) => [key, coordinatorRuntimePaths({ ...scenario.environment.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }).lockPath])));
  const socketPaths = Object.freeze(Object.fromEntries(Object.entries(states).map(([key, stateRoot]) => [key, coordinatorRuntimePaths({ ...scenario.environment.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }).socketPath])));
  const runs = readRunDescriptors(scenario.database_path, scenario.state_root);
  const runMap = descriptorByRun(runs);
  const i5 = await buildI5Descriptor({ clone, scenario, runs: runMap });
  const descriptor = {
    schema_version: 'autopilot.s1_corpus_incident_worker_input.v1', rehearsal_id: clone.request.rehearsal_id, corpus_id: scenario.corpus_id, scenario_id: scenario.scenario_id,
    scenario_root: scenario.scenario_root, repository_root: scenario.repository_root, base_state_root: scenario.state_root, base_lock_path: coordinatorRuntimePaths({ ...scenario.environment.env, [AUTOPILOT_STATE_ROOT_ENV]: scenario.state_root }).lockPath, base_socket_path: coordinatorRuntimePaths({ ...scenario.environment.env, [AUTOPILOT_STATE_ROOT_ENV]: scenario.state_root }).socketPath, candidate: installedDescriptor(candidate), cf50: installedDescriptor(cf50), environment: scenario.environment.env, states, lock_paths: lockPaths, socket_paths: socketPaths, enabled_incidents: enabled, runs,
    i2: buildI2Descriptor(scenario, runMap, clone.manifest), i3: buildI3Descriptor(scenario, runMap, clone.manifest), i4: buildI4Descriptor(scenario, runMap, i4Base, clone.manifest), i5,
    current_pointer_path: coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: scenario.state_root }).currentStorePointerPath,
    output_path: join(scenario.scenario_root, 'private', 'incident-worker-output.json'),
  };
  const descriptorPath = join(scenario.scenario_root, 'private', 'incident-worker-input.json');
  await writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const sourceWorker = fileURLToPath(new URL('incident-worker.ts', import.meta.url));
  const workerPath = join(scenario.scenario_root, 'private', 'incident-worker.ts');
  await copyRegularFileNoFollow(sourceWorker, workerPath, 0o600);
  const sandboxNode = join(scenario.scenario_root, 'private', 'toolchain', 'node');
  const result = await runSandboxed({ clone_root: scenario.scenario_root, denied_source_roots: deniedRoots, cwd: scenario.repository_root, env: scenario.environment.env, command: sandboxNode, args: ['--experimental-strip-types', workerPath, descriptorPath], timeout_ms: 4 * 60 * 60 * 1000 });
  if (result.exit_code !== 0 || result.stdout !== '' || result.stderr !== '') throw new Error(`C5 incident worker failed with exit ${String(result.exit_code)} and bounded output ${String(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr))}`);
  const workerOutput = readRegularFileNoFollow(descriptor.output_path, 64 * 1024 * 1024);
  if (workerOutput.identity.link_count !== 1 || process.platform !== 'win32' && (workerOutput.mode & 0o077) !== 0) throw new Error('C5 incident worker output is not private single-link evidence');
  const value: unknown = JSON.parse(Buffer.from(workerOutput.bytes).toString('utf8')) as unknown;
  const output = parseWorkerOutput(value, { rehearsal_id: clone.request.rehearsal_id, corpus_id: scenario.corpus_id, scenario_id: scenario.scenario_id });
  const expectedRuns = runs.map((entry) => corpusRunIdentityDigest(entry.run.repo_id, entry.run.workstream_run)).sort(compareCodeUnits);
  const coveredRuns = (values: readonly unknown[], label: string, consumer?: string): readonly string[] => values.map((entry) => record(entry, label)).filter((entry) => consumer === undefined || entry['consumer'] === consumer).map((entry) => text(entry['run_id_sha256'], `${label} run digest`)).sort(compareCodeUnits);
  if (canonicalJson(coveredRuns(output.attach_results, 'attach result')) !== canonicalJson(expectedRuns)
    || canonicalJson(coveredRuns(output.dispatch_dry_run_results, 'dispatch result')) !== canonicalJson(expectedRuns)
    || canonicalJson(coveredRuns(output.reconciliation_results, 'run reconciliation result', 'run-reconcile')) !== canonicalJson(expectedRuns)) throw new Error('C5 worker did not attach, reconcile, and dispatch-dry-run every exact durable run');
  if (output.doctor_results.length !== 2) throw new Error('C5 worker did not run doctor after migration and reconciliation');
  return output;
}

function rootsDigest(witness: BuiltCorpusClone['witness_before']): Sha256Digest {
  return digest(witness.roots.map((root) => ({ corpus_id: root.corpus_id, root_label: root.root_label, root_path_sha256: root.root_path_sha256, root_identity: root.root_identity, file_count: root.file_count, total_bytes: root.total_bytes, tree_sha256: root.tree_sha256, inventory_sha256: root.inventory_sha256 })));
}

function currentGitRefs(repositoryRoot: string): readonly string[] {
  const result = spawnSync('git', ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)'], { cwd: repositoryRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) throw new Error('C5 copy-post Git ref measurement failed');
  return Object.freeze(result.stdout.split('\n').filter((value) => value.length > 0).sort(compareCodeUnits));
}

async function copyPostDigests(scenarios: readonly BuiltCorpusScenario[]): Promise<Readonly<Record<string, Sha256Digest>>> {
  const rootFacts: unknown[] = [];
  const databaseFacts: unknown[] = [];
  const evidenceFacts: unknown[] = [];
  const refFacts: unknown[] = [];
  const registrationFacts: unknown[] = [];
  const worktreeFacts: unknown[] = [];
  for (const scenario of scenarios) {
    const inventory = await inventoryTree(scenario.scenario_root);
    rootFacts.push({ corpus_id: scenario.corpus_id, scenario_id: scenario.scenario_id, tree_sha256: inventory.tree_sha256 });
    const pointer = record(JSON.parse(await readFile(coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: scenario.state_root }).currentStorePointerPath, 'utf8')) as unknown, 'copy-post store pointer');
    const generationId = text(pointer['generation_id'], 'copy-post generation ID');
    const generationDatabase = join(scenario.state_root, 'coordinator', 'stores', generationId, 'coordinator.db');
    databaseFacts.push({ corpus_id: scenario.corpus_id, logical_sha256: logicalSqliteDigest(generationDatabase).logical_sha256 });
    evidenceFacts.push({ corpus_id: scenario.corpus_id, entries: inventory.nodes.filter((node) => /(?:^|\/)(?:evidence|_saga-evidence)(?:\/|$)/u.test(node.relative_path)).map((node) => ({ path: digest(node.relative_path), sha256: node.sha256 })) });
    refFacts.push({ corpus_id: scenario.corpus_id, refs: currentGitRefs(scenario.repository_root) });
    const registrations = closedGitWorktreeRegistrationFacts(scenario.git_mirror.git_common_dir);
    registrationFacts.push({ corpus_id: scenario.corpus_id, registrations: registrations.map((entry) => ({ path_sha256: digest(entry.worktree_path), head_sha: entry.head_sha, branch_ref: entry.branch_ref, prunable: entry.prunable })) });
    const present = registrations.filter((entry) => existsSync(entry.worktree_path));
    for (const registration of present) worktreeFacts.push({ corpus_id: scenario.corpus_id, path_sha256: digest(registration.worktree_path), inventory_sha256: (await inventoryTree(registration.worktree_path)).tree_sha256 });
  }
  return Object.freeze({ roots_sha256: digest(rootFacts), databases_sha256: digest(databaseFacts), evidence_sha256: digest(evidenceFacts), git_refs_sha256: digest(refFacts), registrations_sha256: digest(registrationFacts), worktrees_sha256: digest(worktreeFacts) });
}

export async function runCorpusRehearsal(clone: BuiltCorpusClone): Promise<CorpusRehearsalResult> {
  if (existsSync(clone.request.result_path)) throw new Error('C5 result path must remain absent until complete certification');
  const workerOutputs: WorkerOutput[] = [];
  for (const scenario of clone.scenarios) workerOutputs.push(await runScenarioWorker(clone, scenario));
  const incidentRows = workerOutputs.flatMap((output) => output.incident_results).map((value) => record(value, 'worker incident result')).sort((left, right) => compareCodeUnits(text(left['incident_id'], 'incident ID'), text(right['incident_id'], 'incident ID')));
  if (incidentRows.length !== 5 || incidentRows.map((row) => row['incident_id']).join(',') !== 'I1,I2,I3,I4,I5') throw new Error('C5 workers did not produce exactly one I1-I5 result each');
  const witnessAfterPath = join(clone.clone_root, 'private', 'witness-after.json');
  const witnessAfter = await captureIndependentLiveWitness('after', clone.private_request_path, witnessAfterPath);
  const beforeRoots = rootsDigest(clone.witness_before);
  const afterRoots = rootsDigest(witnessAfter);
  const databaseUnchanged = clone.witness_before.database_components_sha256 === witnessAfter.database_components_sha256;
  const evidenceUnchanged = clone.witness_before.evidence_sha256 === witnessAfter.evidence_sha256;
  const authorityObjectsUnchanged = clone.witness_before.authority_objects_sha256 === witnessAfter.authority_objects_sha256;
  const refsUnchanged = clone.witness_before.git_refs_sha256 === witnessAfter.git_refs_sha256;
  const registrationsUnchanged = clone.witness_before.registrations_sha256 === witnessAfter.registrations_sha256;
  const worktreesUnchanged = clone.witness_before.worktrees_sha256 === witnessAfter.worktrees_sha256;
  const rootsUnchanged = beforeRoots === afterRoots;
  if (!databaseUnchanged || !evidenceUnchanged || !authorityObjectsUnchanged || !refsUnchanged || !registrationsUnchanged || !worktreesUnchanged || !rootsUnchanged || clone.witness_before.authority_sha256 !== witnessAfter.authority_sha256) throw new Error('C5 live source changed during the mutable clone rehearsal');
  const copyDigests = await copyPostDigests(clone.scenarios);
  const livePost = Object.freeze({ database_components_sha256: witnessAfter.database_components_sha256, evidence_sha256: witnessAfter.evidence_sha256, authority_objects_sha256: witnessAfter.authority_objects_sha256, git_refs_sha256: witnessAfter.git_refs_sha256, registrations_sha256: witnessAfter.registrations_sha256, worktrees_sha256: witnessAfter.worktrees_sha256 });
  const sortedRows = (values: readonly unknown[], fields: readonly string[]): readonly unknown[] => Object.freeze([...values].sort((left, right) => {
    const leftRow = record(left, 'result row');
    const rightRow = record(right, 'result row');
    return compareCodeUnits(fields.map((field) => text(leftRow[field], `result ${field}`)).join('\u0000'), fields.map((field) => text(rightRow[field], `result ${field}`)).join('\u0000'));
  }));
  const resultValue = {
    schema_version: S1_CORPUS_REHEARSAL_RESULT_SCHEMA,
    rehearsal_id: clone.request.rehearsal_id,
    candidate_build: '1.2.0-s1',
    store_generation_id: workerOutputs.map((output) => ({ corpus_id: output.corpus_id, scenario_id: output.scenario_id, generation_id: output.generation_id })).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.scenario_id}`, `${right.corpus_id}\0${right.scenario_id}`)),
    attach_results: sortedRows(workerOutputs.flatMap((output) => output.attach_results), ['corpus_id', 'scenario_id', 'repo_id_sha256', 'run_id_sha256', 'attachment_kind']),
    doctor_results: sortedRows(workerOutputs.flatMap((output) => output.doctor_results), ['corpus_id', 'scenario_id', 'phase']),
    reconciliation_results: sortedRows(workerOutputs.flatMap((output) => output.reconciliation_results), ['corpus_id', 'scenario_id', 'run_id_sha256', 'consumer']),
    dispatch_dry_run_results: sortedRows(workerOutputs.flatMap((output) => output.dispatch_dry_run_results), ['corpus_id', 'scenario_id', 'run_id_sha256']),
    incident_results: incidentRows,
    copy_post_digests: copyDigests,
    live_post_digests: livePost,
    live_unchanged: { baseline_inventory_sha256: beforeRoots, post_inventory_sha256: afterRoots, database_components: databaseUnchanged, evidence: evidenceUnchanged, authority_objects: authorityObjectsUnchanged, git_refs: refsUnchanged, registrations: registrationsUnchanged, worktrees: worktreesUnchanged, passed: true },
    new_blockers: [],
    completed_at: new Date().toISOString(),
  };
  const result = parseCorpusRehearsalResult(resultValue);
  await mkdir(dirname(clone.request.result_path), { recursive: true, mode: 0o700 });
  await writeFile(clone.request.result_path, `${canonicalJson(result)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return result;
}
