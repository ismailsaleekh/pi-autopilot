import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore, historicalStoreConservationSnapshot } from '../../src/core/coordination/store.ts';
import type { CoordinationOwnerIdentity, CoordinationWorktree, CoordinationWorktreeOperation } from '../../src/core/coordination/types.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('fixture value is not JSON');
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

async function retireTestPublicationToExactSchema12(paths: ReturnType<typeof coordinatorRuntimePaths>): Promise<void> {
  const store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-16T00:00:00.000Z') });
  store.close();
  const fixed = new DatabaseSync(paths.databasePath);
  try {
    for (const row of fixed.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'autopilot_s1_deny_%' ORDER BY name").all()) {
      const name = row['name'];
      if (typeof name !== 'string' || !/^autopilot_s1_deny_[a-f0-9]{20}_(insert|update|delete)$/u.test(name)) throw new Error('fixture found an unknown fixed-path trigger');
      fixed.exec(`DROP TRIGGER "${name}"`);
    }
    fixed.exec('DROP TABLE autopilot_s1_fixed_path_barrier');
  } finally { fixed.close(); }
  await rm(paths.currentStorePointerPath, { force: true });
  await rm(paths.storesRoot, { recursive: true, force: true });
  await mkdir(paths.storesRoot, { recursive: true, mode: 0o700 });
}

void describe('S1 schema-13 historical twin migration', () => {
  void it('classifies all 46 semantic twins without changing one historical payload/content byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-twins-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    await retireTestPublicationToExactSchema12(paths);
    const repoId = 'repo-s1-twin-corpus';
    const run = 'run-s1-twin-corpus';
    const autopilot = 'autopilot-s1-twin-corpus';
    const initialDigest = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
    const operationPayloads = new Map<string, string>();
    const fixed = new DatabaseSync(paths.databasePath);
    try {
      fixed.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      fixed.prepare('INSERT INTO repositories(repo_id,repo_key,canonical_root,git_common_dir,event_seq,created_event_seq,version) VALUES(?,?,?,?,1,1,1)').run(repoId, repoId, join(root, 'repository'), join(root, 'repository', '.git'));
      fixed.prepare("INSERT INTO runs(repo_id,autopilot_id,workstream,workstream_run,status,active_session_generation,created_event_seq,version,coordination_authority) VALUES(?,?,?,?,'recovering',0,1,1,'coordinator-edit-leases-v1')").run(repoId, autopilot, 's1-twins', run);
      fixed.prepare("INSERT INTO events(repo_id,event_seq,event_type,entity_type,entity_id,idempotency_key,request_sha256,occurred_at) VALUES(?,1,'historical-seed','repository',?,'historical-seed',?,'2026-07-15T23:59:59.000Z')").run(repoId, repoId, initialDigest);
      fixed.prepare('INSERT INTO idempotency_results(repo_id,idempotency_key,request_sha256,committed_event_seq,payload_json) VALUES(?,?,?,?,?)').run(repoId, 'historical-result', initialDigest, 1, '{"historical":true}');
      fixed.prepare('INSERT INTO evidence_artifacts(entity_id,repo_id,sha256,ref,label,content,size_bytes,created_event_seq) VALUES(?,?,?,?,?,?,?,1)').run('historical-evidence', repoId, initialDigest, 'historical/evidence.bin', 'historical evidence', new TextEncoder().encode('immutable-historical-evidence\0bytes'), 35);
      for (let index = 0; index < 46; index += 1) {
        const owner: CoordinationOwnerIdentity = { repo_id: repoId, autopilot_id: autopilot, workstream_run: run, unit_id: `unit-${String(index).padStart(2, '0')}`, attempt: 1 };
        const canonicalId = deterministicWorktreeId(owner, 'unit');
        const historicalId = `migration-worktree-twin-${String(index).padStart(2, '0')}`;
        const common = { owner, kind: 'unit' as const, canonical_path: join(root, 'worktrees', owner.unit_id), git_common_dir: join(root, 'repository', '.git'), branch: `autopilot/unit/${run}/${owner.unit_id}/attempt-1`, state: 'active' as const, version: 1 };
        const canonical: CoordinationWorktree = { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: canonicalId, ...common };
        const historical: CoordinationWorktree = { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: historicalId, ...common };
        for (const worktree of [canonical, historical]) fixed.prepare('INSERT INTO worktrees(entity_id,repo_id,workstream_run,payload_json,version) VALUES(?,?,?,?,1)').run(worktree.worktree_id, repoId, run, canonicalJson(worktree));
        const operation: CoordinationWorktreeOperation = {
          schema_version: 'autopilot.worktree_operation.v2', operation_id: `historical-operation-${String(index).padStart(2, '0')}`, worktree_id: historicalId, owner, operation_type: 'materialize', stage: 'committed', authority_version: 1, intent_event_seq: 1,
          intent: { repo_root: join(root, 'repository'), worktree_path: common.canonical_path, git_common_dir: common.git_common_dir, branch: common.branch, reason: 'historical twin corpus', base_sha: 'b'.repeat(40), target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
          completed_steps: ['registered'], current_step: null, recovery_attempts: 0, verification_evidence: { ref: 'historical/evidence.bin', sha256: initialDigest }, error_code: null, version: 1,
        };
        const payload = canonicalJson(operation);
        operationPayloads.set(operation.operation_id, payload);
        fixed.prepare('INSERT INTO worktree_operations(entity_id,repo_id,workstream_run,payload_json,version) VALUES(?,?,?,?,1)').run(operation.operation_id, repoId, run, payload);
      }
      fixed.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    } catch (error) {
      if (fixed.isTransaction) fixed.exec('ROLLBACK');
      throw error;
    } finally { fixed.close(); }

    const before = historicalStoreConservationSnapshot(paths.databasePath);
    const migrated = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-16T00:00:01.000Z') });
    const generationPath = migrated.currentGeneration().database_path;
    try {
      const faults = migrated.negotiatedRunScopedFaults(repoId, run);
      assert.equal(faults.length, 46);
      assert.equal(faults.every((fault) => fault.invariant_id === 'F3-SEMANTIC-UNIQUENESS' && fault.fault_code === 'identity-recovery-pending'), true);
      const currentOperations = migrated.status(repoId, run).payload['worktree_operations'];
      if (!Array.isArray(currentOperations)) throw new Error('migrated current operations are missing');
      for (let index = 0; index < 46; index += 1) {
        const suffix = String(index).padStart(2, '0');
        const owner: CoordinationOwnerIdentity = { repo_id: repoId, autopilot_id: autopilot, workstream_run: run, unit_id: `unit-${suffix}`, attempt: 1 };
        assert.deepEqual(migrated.canonicalWorktreeIdentity(repoId, `migration-worktree-twin-${suffix}`), { canonical_worktree_id: deterministicWorktreeId(owner, 'unit'), resolution_state: 'identity-recovery-pending', workstream_run: run });
        const operation = currentOperations.find((entry) => isRecord(entry) && entry['operation_id'] === `historical-operation-${suffix}`);
        assert.equal(isRecord(operation) ? operation['worktree_id'] : null, `migration-worktree-twin-${suffix}`, 'current routing must not rewrite immutable historical operation identity');
      }
    } finally { migrated.close(); }

    const after = historicalStoreConservationSnapshot(generationPath);
    assert.deepEqual(after.worktree_operations, before.worktree_operations);
    assert.deepEqual(after.idempotency_results, before.idempotency_results);
    const inspect = new DatabaseSync(generationPath, { readOnly: true });
    try {
      assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM worktrees').get()?.['count'], 92);
      assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM worktree_aliases').get()?.['count'], 46);
      assert.equal(inspect.prepare('SELECT payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, 'historical-result')?.['payload_json'], '{"historical":true}');
      assert.equal(canonicalJson(inspect.prepare('SELECT event_type,entity_type,entity_id,idempotency_key,request_sha256,occurred_at FROM events WHERE repo_id=? AND event_seq=1').get(repoId)), canonicalJson({ event_type: 'historical-seed', entity_type: 'repository', entity_id: repoId, idempotency_key: 'historical-seed', request_sha256: initialDigest, occurred_at: '2026-07-15T23:59:59.000Z' }));
      assert.deepEqual(inspect.prepare('SELECT content FROM evidence_artifacts WHERE entity_id=?').get('historical-evidence')?.['content'], new TextEncoder().encode('immutable-historical-evidence\0bytes'));
      for (const [operationId, payload] of operationPayloads) assert.equal(inspect.prepare('SELECT payload_json FROM worktree_operations WHERE entity_id=?').get(operationId)?.['payload_json'], payload);
    } finally { inspect.close(); }
    const immutabilityProbe = new DatabaseSync(generationPath);
    try {
      assert.throws(() => immutabilityProbe.prepare("UPDATE worktree_aliases SET reason='legacy-migration-id' WHERE alias_worktree_id='migration-worktree-twin-00'").run(), /immutable/u);
      assert.throws(() => immutabilityProbe.prepare("DELETE FROM worktree_aliases WHERE alias_worktree_id='migration-worktree-twin-00'").run(), /immutable/u);
    } finally { immutabilityProbe.close(); }

    const reopened = await CoordinatorStore.open(paths);
    try { assert.equal(reopened.negotiatedRunScopedFaults(repoId, run).length, 46); }
    finally { reopened.close(); await rm(root, { recursive: true, force: true }); }
  });

  void it('scopes a malformed but indexed operation row to its provable run during migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-malformed-operation-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    await retireTestPublicationToExactSchema12(paths);
    const repoId = 'repo-malformed-operation';
    const run = 'run-malformed-operation';
    const owner: CoordinationOwnerIdentity = { repo_id: repoId, autopilot_id: 'autopilot-malformed-operation', workstream_run: run, unit_id: 'unit-malformed-operation', attempt: 1 };
    const worktreeId = deterministicWorktreeId(owner, 'unit');
    const worktree: CoordinationWorktree = { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: worktreeId, owner, kind: 'unit', canonical_path: join(root, 'worktrees', 'unit'), git_common_dir: join(root, 'repository', '.git'), branch: `autopilot/unit/${run}/${owner.unit_id}/attempt-1`, state: 'active', version: 1 };
    const fixed = new DatabaseSync(paths.databasePath);
    try {
      fixed.exec('BEGIN IMMEDIATE');
      fixed.prepare('INSERT INTO repositories(repo_id,repo_key,canonical_root,git_common_dir,event_seq,created_event_seq,version) VALUES(?,?,?,?,1,1,1)').run(repoId, repoId, join(root, 'repository'), join(root, 'repository', '.git'));
      fixed.prepare("INSERT INTO runs(repo_id,autopilot_id,workstream,workstream_run,status,active_session_generation,created_event_seq,version,coordination_authority) VALUES(?,?,?,?,'recovering',0,1,1,'coordinator-edit-leases-v1')").run(repoId, owner.autopilot_id, 'malformed-operation', run);
      fixed.prepare("INSERT INTO events(repo_id,event_seq,event_type,entity_type,entity_id,idempotency_key,request_sha256,occurred_at) VALUES(?,1,'historical-seed','repository',?,'historical-seed',?,'2026-07-15T23:59:59.000Z')").run(repoId, repoId, `sha256:${'c'.repeat(64)}`);
      fixed.prepare('INSERT INTO worktrees(entity_id,repo_id,workstream_run,payload_json,version) VALUES(?,?,?,?,1)').run(worktreeId, repoId, run, canonicalJson(worktree));
      fixed.prepare('INSERT INTO worktree_operations(entity_id,repo_id,workstream_run,payload_json,version) VALUES(?,?,?,?,1)').run('malformed-operation', repoId, run, canonicalJson({ worktree_id: worktreeId, owner }));
      fixed.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    } catch (error) {
      if (fixed.isTransaction) fixed.exec('ROLLBACK');
      throw error;
    } finally { fixed.close(); }

    const migrated = await CoordinatorStore.open(paths);
    try {
      const faults = migrated.negotiatedRunScopedFaults(repoId, run);
      assert.equal(faults.some((fault) => fault.invariant_id === 'F4-PAYLOAD-INDEX-AMBIGUITY' && fault.entity_type === 'worktree_operations' && fault.entity_id === 'malformed-operation'), true);
      const currentOperations = migrated.status(repoId, run).payload['worktree_operations'];
      assert.equal(Array.isArray(currentOperations) ? currentOperations.length : -1, 0);
    } finally { migrated.close(); }
    const reopened = await CoordinatorStore.open(paths);
    const generationPath = reopened.currentGeneration().database_path;
    try { assert.equal(reopened.negotiatedRunScopedFaults(repoId, run).some((fault) => fault.entity_id === 'malformed-operation'), true); }
    finally { reopened.close(); }

    const uncoveredOperation: CoordinationWorktreeOperation = {
      schema_version: 'autopilot.worktree_operation.v2', operation_id: 'uncovered-operation', worktree_id: worktreeId, owner,
      operation_type: 'materialize', stage: 'prepared', authority_version: 1, intent_event_seq: 1,
      intent: { repo_root: join(root, 'repository'), worktree_path: worktree.canonical_path, git_common_dir: worktree.git_common_dir, branch: worktree.branch, reason: 'uncovered projection proof', base_sha: 'd'.repeat(40), target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
      completed_steps: [], current_step: null, recovery_attempts: 0, verification_evidence: null, error_code: null, version: 1,
    };
    const tamper = new DatabaseSync(generationPath);
    try { tamper.prepare('INSERT INTO worktree_operations(entity_id,repo_id,workstream_run,payload_json,version,canonical_worktree_id) VALUES(?,?,?,?,1,NULL)').run(uncoveredOperation.operation_id, repoId, run, canonicalJson(uncoveredOperation)); }
    finally { tamper.close(); }
    try {
      await assert.rejects(() => CoordinatorStore.open(paths), /operation lacks canonical projection without an exact scoped fault/u);
      const inspect = new DatabaseSync(generationPath, { readOnly: true });
      try { assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM run_scoped_faults WHERE entity_id='uncovered-operation'").get()?.['count'], 0); }
      finally { inspect.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
