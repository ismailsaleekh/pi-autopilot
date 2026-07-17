import assert from 'node:assert/strict';
import { existsSync, linkSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { parseCoordinatorRuntimeIdentity, readAndVerifyCoordinatorRuntimeIdentity } from '../../src/core/coordination/runtime-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { parseStoreGenerationPublication, parseStorePointer } from '../../src/core/coordination/store-generation.ts';
import { CoordinatorStore, historicalStoreConservationSnapshot } from '../../src/core/coordination/store.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

function json(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Readonly<Record<string, unknown>>;
}

void describe('S1 generation-addressed schema-13 store', () => {
  void it('publishes schema 13 behind a schema-12 fixed barrier and truthful private identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-generation-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    const running = await startCoordinatorServer(paths);
    const generation = running.store.currentGeneration();
    try {
      assert.equal(parseStorePointer(json(paths.currentStorePointerPath)).generation_id, generation.pointer.generation_id);
      const publication = parseStoreGenerationPublication(json(generation.publication_path));
      assert.equal(publication.store_schema_version, 13);
      assert.equal(publication.source_kind, 'cf50-fixed-schema12');
      assert.equal(publication.source_generation_id, null);
      assert.match(publication.publication_database_sha256, /^sha256:[a-f0-9]{64}$/u);
      const fixed = new DatabaseSync(paths.databasePath);
      try {
        const fixedVersion = fixed.prepare('PRAGMA user_version').get()?.['user_version'];
        assert.equal(fixedVersion, 12);
        assert.throws(() => fixed.prepare("INSERT INTO repositories(repo_id,repo_key,canonical_root,git_common_dir,event_seq,created_event_seq,version) VALUES('stale','stale','/tmp/stale','/tmp/stale/.git',1,1,1)").run(), /cf50 fixed store retired/u);
      } finally { fixed.close(); }
      const current = new DatabaseSync(generation.database_path, { readOnly: true });
      try { assert.equal(current.prepare('PRAGMA user_version').get()?.['user_version'], 13); }
      finally { current.close(); }
      assert.deepEqual(historicalStoreConservationSnapshot(paths.databasePath), historicalStoreConservationSnapshot(generation.database_path));
      assert.deepEqual(running.store.negotiatedIdentityObservability(), {
        implementation_build: '1.2.0-s1', wire_lineage: 'protocol-1.6-api-schema-12', api_schema_version: 12, store_schema_version: 13,
        legacy_facade_build: '1.1.8-cf50', store_generation_id: generation.pointer.generation_id, current_store_pointer_sha256: generation.pointer_sha256,
      });
      assert.equal(running.store.handshake().payload['database_schema_version'], 12);
      assert.equal(running.store.handshake().payload['package_build'], '1.1.8-cf50');
      const sidecarBefore = readFileSync(paths.runtimeIdentityPath);
      const sidecar = parseCoordinatorRuntimeIdentity(json(paths.runtimeIdentityPath));
      const lock = record(json(paths.lockPath), 'lifecycle lock');
      const verified = readAndVerifyCoordinatorRuntimeIdentity(paths, generation, {
        pid: typeof lock['pid'] === 'number' ? lock['pid'] : 0,
        boot_id: typeof lock['boot_id'] === 'string' ? lock['boot_id'] : '',
        process_start_identity: typeof lock['process_start_identity'] === 'string' ? lock['process_start_identity'] : '',
        instance_id: typeof lock['instance_id'] === 'string' ? lock['instance_id'] : '',
      });
      assert.equal(sidecar.current_store_pointer_sha256, generation.pointer_sha256);
      assert.equal(verified.identity.implementation_build, '1.2.0-s1');
      assert.deepEqual(readFileSync(paths.runtimeIdentityPath), sidecarBefore);
      writeFileSync(paths.runtimeIdentityPath, `${Buffer.from(sidecarBefore).toString('utf8')} `, { mode: 0o600 });
      assert.throws(() => readAndVerifyCoordinatorRuntimeIdentity(paths, generation, { pid: typeof lock['pid'] === 'number' ? lock['pid'] : 0, boot_id: typeof lock['boot_id'] === 'string' ? lock['boot_id'] : '', process_start_identity: typeof lock['process_start_identity'] === 'string' ? lock['process_start_identity'] : '', instance_id: typeof lock['instance_id'] === 'string' ? lock['instance_id'] : '' }), /canonical publication/u);
      writeFileSync(paths.runtimeIdentityPath, sidecarBefore, { mode: 0o600 });
    } finally {
      await running.close();
      assert.equal(existsSync(`${generation.database_path}-wal`), false);
      assert.equal(existsSync(`${generation.database_path}-shm`), false);
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('restores only by publishing a fresh generation without WAL/SHM overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-generation-restore-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    const store = await CoordinatorStore.open(paths);
    const sourceGeneration = store.currentGeneration();
    const backupPath = join(paths.backupsRoot, 'restore-source.db');
    let backupSha256: `sha256:${string}`;
    try { backupSha256 = (await store.createVerifiedBackup(backupPath)).sha256; }
    finally { store.close(); }
    try {
      const backupBytes = readFileSync(backupPath);
      const changedBackup = new Uint8Array(backupBytes.byteLength + 1);
      changedBackup.set(backupBytes);
      writeFileSync(backupPath, changedBackup, { mode: 0o600 });
      await assert.rejects(() => CoordinatorStore.restoreGeneration(paths, backupPath, backupSha256), /digest does not match/u);
      writeFileSync(backupPath, backupBytes, { mode: 0o600 });
      const restored = await CoordinatorStore.restoreGeneration(paths, backupPath, backupSha256);
      assert.notEqual(restored.pointer.generation_id, sourceGeneration.pointer.generation_id);
      assert.equal(restored.pointer.previous_generation_id, sourceGeneration.pointer.generation_id);
      assert.equal(restored.publication.source_kind, 's1-generation-restore');
      assert.equal(restored.publication.source_generation_id, sourceGeneration.pointer.generation_id);
      assert.equal(existsSync(`${restored.database_path}-wal`), false);
      assert.equal(existsSync(`${restored.database_path}-shm`), false);
      const reopened = await CoordinatorStore.open(paths);
      try { assert.equal(reopened.currentGeneration().pointer.generation_id, restored.pointer.generation_id); }
      finally { reopened.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('rejects fixed-path barrier tamper before writable generation open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-barrier-tamper-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    const store = await CoordinatorStore.open(paths);
    store.close();
    try {
      const fixed = new DatabaseSync(paths.databasePath);
      try {
        const trigger = fixed.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'autopilot_s1_deny_%' ORDER BY name LIMIT 1").get()?.['name'];
        if (typeof trigger !== 'string' || !/^autopilot_s1_deny_[a-f0-9]{20}_(insert|update|delete)$/u.test(trigger)) throw new Error('barrier trigger fixture is missing');
        fixed.exec(`DROP TRIGGER "${trigger}"`);
      } finally { fixed.close(); }
      await assert.rejects(() => CoordinatorStore.open(paths), /does not deny every user-table mutation/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('rejects schema-13 authority index and alias-trigger tamper before writable open', async () => {
    for (const shape of ['index', 'trigger'] as const) {
      const root = await mkdtemp(join(tmpdir(), `pi-autopilot-s1-schema13-${shape}-tamper-`));
      const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
      const store = await CoordinatorStore.open(paths);
      const databasePath = store.currentGeneration().database_path;
      store.close();
      try {
        const tamper = new DatabaseSync(databasePath);
        try {
          if (shape === 'index') tamper.exec('DROP INDEX idx_worktrees_current_semantic');
          else tamper.exec('DROP TRIGGER worktree_aliases_deny_update');
        } finally { tamper.close(); }
        await assert.rejects(() => CoordinatorStore.open(paths), shape === 'index' ? /authority index is missing or changed/u : /alias immutability trigger is missing or changed/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  void it('rejects pointer/publication tamper and live-generation hardlink aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-generation-tamper-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    const running = await startCoordinatorServer(paths);
    const generation = running.store.currentGeneration();
    await running.close();
    try {
      const pointerBytes = readFileSync(paths.currentStorePointerPath);
      const publicationBytes = readFileSync(generation.publication_path);
      writeFileSync(generation.publication_path, `${Buffer.from(publicationBytes).toString('utf8')} `, { mode: 0o600 });
      await assert.rejects(() => CoordinatorStore.open(paths), /publication digest/u);
      writeFileSync(generation.publication_path, publicationBytes, { mode: 0o600 });
      const alias = join(root, 'forbidden-live-generation-hardlink.db');
      linkSync(generation.database_path, alias);
      await assert.rejects(() => CoordinatorStore.open(paths), /hardlink aliases/u);
      await rm(alias, { force: true });
      writeFileSync(paths.currentStorePointerPath, Buffer.from(pointerBytes).toString('utf8').replace('stores/', 'stores/../stores/'), { mode: 0o600 });
      await assert.rejects(() => CoordinatorStore.open(paths), /relative_generation_path/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
