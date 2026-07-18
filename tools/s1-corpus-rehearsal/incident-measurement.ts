import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { parseCoordinationEditLease, parseCoordinationRunResource, parseCoordinationUnitAttempt, parseCoordinationWorktree, parseCoordinationWorktreeOperation } from '../../src/core/coordination/contracts.ts';
import type { GitWorktreeRegistrationFact } from '../../src/core/coordination/metadata-reconcile.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import type { CoordinationOwnerIdentity } from '../../src/core/coordination/types.ts';
import {
  S1_ACTUAL_CF50_TARBALL_SHA256,
  S1_I2_CAPTURE_SHA,
  S1_I2_OPERATION_ID,
  type BackupCoverage,
  type CorpusCloneRequest,
  type I1Requirement,
  type I2Requirement,
  type I3Requirement,
  type I4Requirement,
  type I5Requirement,
  type Sha256Digest,
} from './contracts.ts';
import { trySelectI4Subjects } from './clone-injections.ts';
import { compareCodeUnits, sourcePathDigest } from './inventory.ts';

export interface IncidentMeasurementCorpus {
  readonly corpus_id: string;
  readonly database_path: string;
  readonly repository_root: string;
}

const MAX_ROWS = 1_000_000;

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.['count'] === 1;
}

function payloads(database: DatabaseSync, table: string): readonly string[] {
  if (!tableExists(database, table)) throw new Error(`C5 retained corpus omits required ${table} facts`);
  const rows = database.prepare(`SELECT payload_json FROM "${table}" ORDER BY entity_id LIMIT ${String(MAX_ROWS + 1)}`).all();
  if (rows.length > MAX_ROWS) throw new Error(`C5 retained corpus ${table} exceeds the bounded row limit`);
  return Object.freeze(rows.map((row) => {
    const value = row['payload_json'];
    if (typeof value !== 'string') throw new Error(`C5 retained corpus ${table} has malformed payload storage`);
    return value;
  }));
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) throw new Error('C5 retained-corpus Git measurement failed or lost process truth');
  return result.stdout;
}

interface I2Candidate {
  readonly corpus_id: string;
  readonly requirement: I2Requirement;
}

function measureI2(corpora: readonly IncidentMeasurementCorpus[]): I2Requirement {
  const candidates: I2Candidate[] = [];
  for (const corpus of corpora) {
    const database = new DatabaseSync(corpus.database_path, { readOnly: true, timeout: 30_000 });
    try {
      database.exec('PRAGMA query_only=ON');
      if (!tableExists(database, 'worktree_operations') || !tableExists(database, 'edit_leases')) continue;
      const operationRow = database.prepare('SELECT payload_json FROM worktree_operations WHERE entity_id=?').get(S1_I2_OPERATION_ID);
      if (typeof operationRow?.['payload_json'] !== 'string') continue;
      const operation = parseCoordinationWorktreeOperation(JSON.parse(operationRow['payload_json']) as unknown);
      if (operation.operation_type === 'metadata-reconcile') throw new Error('C5 I2 operation unexpectedly uses metadata-reconcile intent');
      const nonterminalOwnedOperations = payloads(database, 'worktree_operations').map((payload) => parseCoordinationWorktreeOperation(JSON.parse(payload) as unknown)).filter((candidate) => canonicalJson(candidate.owner) === canonicalJson(operation.owner) && candidate.stage !== 'committed' && candidate.stage !== 'compensated' && candidate.stage !== 'failed');
      if (nonterminalOwnedOperations.length !== 1 || nonterminalOwnedOperations[0]?.operation_id !== S1_I2_OPERATION_ID) throw new Error('C5 I2 proof-withheld control requires the frozen operation to be its owner run’s only nonterminal worktree operation');
      const captureBranch = git(corpus.repository_root, ['rev-parse', '--verify', `refs/heads/${operation.intent.branch}^{commit}`]).trim();
      if (captureBranch !== S1_I2_CAPTURE_SHA) throw new Error('C5 I2 owned capture branch does not resolve to the frozen capture SHA');
      const parentLine = git(corpus.repository_root, ['rev-list', '--parents', '-n', '1', S1_I2_CAPTURE_SHA]).trim();
      const parents = parentLine.split(' ');
      if (parents[0] !== S1_I2_CAPTURE_SHA || parents.length !== 2 || parents[1] === undefined) throw new Error('C5 I2 capture does not have the exact one-parent shape');
      const changedPaths = git(corpus.repository_root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parents[1], S1_I2_CAPTURE_SHA]).split('\u0000').filter((value) => value.length > 0).sort(compareCodeUnits);
      const expectedPaths = [...operation.intent.paths].sort(compareCodeUnits);
      if (canonicalJson(changedPaths) !== canonicalJson(expectedPaths)) throw new Error('C5 I2 capture path set differs from the persisted operation intent');
      const leases = payloads(database, 'edit_leases').map((payload) => parseCoordinationEditLease(JSON.parse(payload) as unknown)).filter((lease) => lease.mode === 'WRITE' && canonicalJson(lease.owner) === canonicalJson(operation.owner));
      if (leases.length !== 42) continue;
      const leaseIds = leases.map((lease) => lease.edit_lease_id).sort(compareCodeUnits);
      candidates.push(Object.freeze({ corpus_id: corpus.corpus_id, requirement: Object.freeze({
        incident_id: 'I2', corpus_id: corpus.corpus_id, operation_id: S1_I2_OPERATION_ID, capture_sha: S1_I2_CAPTURE_SHA,
        parent_sha: parents[1], exact_path_set_sha256: digest(canonicalJson(changedPaths)), owner_sha256: digest(canonicalJson(operation.owner)),
        historical_write_lease_count: 42, historical_write_lease_ids_sha256: digest(canonicalJson(leaseIds)),
      }) }));
    } finally { database.close(); }
  }
  if (candidates.length !== 1) throw new Error(`C5 requires exactly one measured I2 42-WRITE-lease corpus; observed ${String(candidates.length)}`);
  return candidates[0]?.requirement ?? (() => { throw new Error('C5 I2 candidate disappeared'); })();
}

interface I3Candidate { readonly requirement: I3Requirement }

function nextOwner(owner: CoordinationOwnerIdentity): CoordinationOwnerIdentity {
  return Object.freeze({ ...owner, attempt: owner.attempt + 1 });
}

export function historicalSemanticTwinAliases(worktrees: readonly ReturnType<typeof parseCoordinationWorktree>[]): readonly ReturnType<typeof parseCoordinationWorktree>[] {
  const canonicalIds = new Set(worktrees.filter((worktree) => worktree.worktree_id === deterministicWorktreeId(worktree.owner, worktree.kind)).map((worktree) => worktree.worktree_id));
  return Object.freeze(worktrees.filter((worktree) => worktree.worktree_id !== deterministicWorktreeId(worktree.owner, worktree.kind) && canonicalIds.has(deterministicWorktreeId(worktree.owner, worktree.kind))).sort((left, right) => compareCodeUnits(left.worktree_id, right.worktree_id)));
}

function measureI3(corpora: readonly IncidentMeasurementCorpus[]): I3Requirement {
  const candidates: I3Candidate[] = [];
  for (const corpus of corpora) {
    const database = new DatabaseSync(corpus.database_path, { readOnly: true, timeout: 30_000 });
    try {
      database.exec('PRAGMA query_only=ON');
      if (!tableExists(database, 'worktrees') || !tableExists(database, 'worktree_operations')) continue;
      const worktrees = payloads(database, 'worktrees').map((payload) => parseCoordinationWorktree(JSON.parse(payload) as unknown));
      const aliases = historicalSemanticTwinAliases(worktrees);
      if (aliases.length !== 46) continue;
      const aliasIds = new Set(aliases.map((worktree) => worktree.worktree_id));
      const operations = payloads(database, 'worktree_operations').map((payload) => parseCoordinationWorktreeOperation(JSON.parse(payload) as unknown)).filter((operation) => aliasIds.has(operation.worktree_id)).sort((left, right) => compareCodeUnits(left.operation_id, right.operation_id));
      if (operations.length === 0) throw new Error('C5 I3 aliases have no immutable operation history');
      const attempts = tableExists(database, 'unit_attempts') ? payloads(database, 'unit_attempts').map((payload) => parseCoordinationUnitAttempt(JSON.parse(payload) as unknown)) : [];
      const resources = tableExists(database, 'run_resources') ? payloads(database, 'run_resources').map((payload) => parseCoordinationRunResource(JSON.parse(payload) as unknown)) : [];
      const runStatuses = new Map(database.prepare('SELECT repo_id,workstream_run,status FROM runs').all().map((row) => [`${String(row['repo_id'])}\0${String(row['workstream_run'])}`, row['status']]));
      const safeAlias = aliases.find((worktree) => {
        const resource = resources.find((entry) => entry.repo_id === worktree.owner.repo_id && entry.workstream_run === worktree.owner.workstream_run);
        const status = runStatuses.get(`${worktree.owner.repo_id}\0${worktree.owner.workstream_run}`);
        const nextAttemptExists = attempts.some((attempt) => attempt.owner.repo_id === worktree.owner.repo_id && attempt.owner.workstream_run === worktree.owner.workstream_run && attempt.owner.unit_id === worktree.owner.unit_id && attempt.owner.attempt === worktree.owner.attempt + 1);
        return resource !== undefined && existsSync(resource.main_worktree_path) && status !== 'closed' && status !== 'aborted' && !nextAttemptExists;
      });
      if (safeAlias === undefined) throw new Error('C5 I3 corpus has no safe next-attempt owner with a surviving main worktree');
      const semanticIds = aliases.map((worktree) => deterministicWorktreeId(worktree.owner, worktree.kind)).sort(compareCodeUnits);
      if (new Set(semanticIds).size !== 46) throw new Error('C5 I3 twins do not represent 46 distinct semantic identities');
      candidates.push(Object.freeze({ requirement: Object.freeze({ incident_id: 'I3', corpus_id: corpus.corpus_id, semantic_twin_count: 46, semantic_identity_set_sha256: digest(canonicalJson(semanticIds)), operation_history_set_sha256: digest(canonicalJson(operations.map((operation) => operation.operation_id))), next_attempt_owner_sha256: digest(canonicalJson(nextOwner(safeAlias.owner))) }) }));
    } finally { database.close(); }
  }
  if (candidates.length !== 1) throw new Error(`C5 requires exactly one measured 46-twin corpus; observed ${String(candidates.length)}`);
  return candidates[0]?.requirement ?? (() => { throw new Error('C5 I3 candidate disappeared'); })();
}

function measureI4(corpora: readonly IncidentMeasurementCorpus[]): I4Requirement {
  const candidates: I4Requirement[] = [];
  for (const corpus of corpora) {
    const database = new DatabaseSync(corpus.database_path, { readOnly: true, timeout: 30_000 });
    try {
      database.exec('PRAGMA query_only=ON');
      if (!tableExists(database, 'repositories') || !tableExists(database, 'runs')) continue;
      const selected = trySelectI4Subjects(database);
      if (selected === null) continue;
      candidates.push(Object.freeze({ incident_id: 'I4', corpus_id: corpus.corpus_id, counter_behind_repo_sha256: digest(selected.repo_id), faulted_run_sha256: digest(selected.faulted_run), healthy_run_sha256: digest(selected.healthy_run), fatal_negative_kinds: Object.freeze(['counter-ahead', 'payload-owner-ambiguous', 'physical-integrity'] as const) }));
    } finally { database.close(); }
  }
  if (candidates.length !== 1) throw new Error(`C5 requires exactly one measured corpus with at least two durable runs for I4; observed ${String(candidates.length)}`);
  return candidates[0] ?? (() => { throw new Error('C5 I4 candidate disappeared'); })();
}

function measureI5(request: CorpusCloneRequest, registrations: ReadonlyMap<string, readonly GitWorktreeRegistrationFact[]>, refSets: ReadonlyMap<string, readonly string[]>): { readonly requirement: I5Requirement; readonly coverage: readonly BackupCoverage[] } {
  const candidates: { requirement: I5Requirement; coverage: readonly BackupCoverage[] }[] = [];
  for (const corpus of request.corpora) {
    const missing = (registrations.get(corpus.corpus_id) ?? []).filter((entry) => entry.prunable && !existsSync(entry.worktree_path)).sort((left, right) => compareCodeUnits(left.worktree_path, right.worktree_path));
    if (missing.length !== 34) continue;
    const coverage = missing.map((registration): BackupCoverage => {
      if (!inside(corpus.state_root, registration.worktree_path)) throw new Error('C5 I5 registration is outside its measured source-state authority');
      const relativePath = relative(corpus.state_root, registration.worktree_path);
      const matches = corpus.retained_snapshot_roots.flatMap((root, index) => [
        { path: join(root, relativePath), index },
        { path: join(root, 'autopilot-state', relativePath), index },
      ]).filter((entry) => existsSync(entry.path));
      if (matches.length > 1) throw new Error('C5 I5 registration has ambiguous exact-filesystem backup coverage');
      const subject = sourcePathDigest(request.rehearsal_id, registration.worktree_path);
      const match = matches[0];
      return Object.freeze({ corpus_id: corpus.corpus_id, incident_id: 'I5', subject_id_sha256: subject, coverage: match === undefined ? 'absent' : 'exact-filesystem', snapshot_label: match === undefined ? 'no-exact-snapshot' : `retained-${String(match.index).padStart(2, '0')}`, evidence_sha256: digest(canonicalJson({ subject_id_sha256: subject, registration_head: registration.head_sha, coverage: match === undefined ? 'absent' : 'exact-filesystem', snapshot_index: match?.index ?? null })) });
    }).sort((left, right) => compareCodeUnits(`${left.corpus_id}\0${left.incident_id}\0${left.subject_id_sha256}`, `${right.corpus_id}\0${right.incident_id}\0${right.subject_id_sha256}`));
    const exactCount = coverage.filter((entry) => entry.coverage === 'exact-filesystem').length;
    const absentCount = coverage.filter((entry) => entry.coverage === 'absent').length;
    if (exactCount !== 7 || absentCount !== 27) continue;
    const registrationFacts = missing.map((entry) => ({ worktree_path_sha256: sourcePathDigest(request.rehearsal_id, entry.worktree_path), head_sha: entry.head_sha, branch_ref: entry.branch_ref, prunable: entry.prunable })).sort((left, right) => compareCodeUnits(left.worktree_path_sha256, right.worktree_path_sha256));
    const refs = [...(refSets.get(corpus.corpus_id) ?? [])].sort(compareCodeUnits);
    candidates.push(Object.freeze({ requirement: Object.freeze({ incident_id: 'I5', corpus_id: corpus.corpus_id, missing_registration_count: 34, registration_set_sha256: digest(canonicalJson(registrationFacts)), preserved_ref_set_sha256: digest(canonicalJson(refs)), exact_filesystem_coverage_count: 7, absence_coverage_count: 27 }), coverage: Object.freeze(coverage) }));
  }
  if (candidates.length !== 1) throw new Error(`C5 requires exactly one measured I5 34/7/27 corpus; observed ${String(candidates.length)}`);
  return candidates[0] ?? (() => { throw new Error('C5 I5 candidate disappeared'); })();
}

function assertMeasuredCorpusPreconditions(corpora: readonly IncidentMeasurementCorpus[]): void {
  for (const corpus of corpora) {
    const database = new DatabaseSync(corpus.database_path, { readOnly: true, timeout: 30_000 });
    try {
      database.exec('PRAGMA query_only=ON');
      if (tableExists(database, 'migration_recovery_work') && database.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE status='pending'").get()?.['count'] !== 0) throw new Error('C5 measured corpus already contains pending migration recovery authority');
      if (!tableExists(database, 'runs') || !tableExists(database, 'run_resources')) throw new Error('C5 measured corpus omits durable run-resource authority');
      const missingResourceCount = database.prepare('SELECT COUNT(*) AS count FROM runs WHERE NOT EXISTS(SELECT 1 FROM run_resources resources WHERE resources.repo_id=runs.repo_id AND resources.workstream_run=runs.workstream_run)').get()?.['count'];
      if (missingResourceCount !== 0) throw new Error('C5 measured corpus has a durable run without exact run-resource authority');
    } finally { database.close(); }
  }
}

export function measureRequiredIncidents(input: {
  readonly request: CorpusCloneRequest;
  readonly registrations: ReadonlyMap<string, readonly GitWorktreeRegistrationFact[]>;
  readonly ref_sets: ReadonlyMap<string, readonly string[]>;
  readonly measurement_corpora: readonly IncidentMeasurementCorpus[];
}): { readonly requirements: readonly [I1Requirement, I2Requirement, I3Requirement, I4Requirement, I5Requirement]; readonly backup_coverage: readonly BackupCoverage[] } {
  assertMeasuredCorpusPreconditions(input.measurement_corpora);
  const first = input.request.corpora[0];
  if (first === undefined) throw new Error('C5 request has no corpus for I1');
  const i1: I1Requirement = Object.freeze({ incident_id: 'I1', corpus_id: first.corpus_id, cf50_tarball_sha256: S1_ACTUAL_CF50_TARBALL_SHA256, directions: Object.freeze(['cf50-client-to-s1', 's1-client-to-cf50', 'mixed-election'] as const), actions: Object.freeze(['attach', 'heartbeat', 'idempotent-replay', 'natural-restart'] as const) });
  const i2 = measureI2(input.measurement_corpora);
  const i3 = measureI3(input.measurement_corpora);
  const i4 = measureI4(input.measurement_corpora);
  const i5 = measureI5(input.request, input.registrations, input.ref_sets);
  const requirements: readonly [I1Requirement, I2Requirement, I3Requirement, I4Requirement, I5Requirement] = Object.freeze([i1, i2, i3, i4, i5.requirement]);
  return Object.freeze({ requirements, backup_coverage: i5.coverage });
}
