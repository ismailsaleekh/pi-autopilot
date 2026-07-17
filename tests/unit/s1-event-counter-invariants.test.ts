import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';

async function seededStore(prefix: string): Promise<{ readonly root: string; readonly paths: ReturnType<typeof coordinatorRuntimePaths>; readonly database: string; readonly repoId: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
  const repoId = `${prefix}repo`;
  const store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-16T01:00:00.000Z') });
  const attached = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: 'attach-counter-run', action: 'attach-run', idempotency_key: 'attach-counter-run', repo_id: repoId, workstream_run: 'run-counter', session_id: null, fencing_generation: null, expected_version: 0, payload: { repo_key: repoId, canonical_root: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), autopilot_id: 'autopilot-counter', workstream: 'counter', coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: 'run-counter', source_repo: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), worktree_root: join(root, 'worktrees'), main_worktree_path: join(root, 'worktrees', 'main'), runtime_root: join(root, 'runtime'), branch: 'autopilot/counter', target_branch: null, target_base_sha: 'd'.repeat(40), origin_url: null, started_at: '2026-07-16T01:00:00.000Z', version: 1 } } });
  assert.equal(attached.ok, true, JSON.stringify(attached.payload));
  const database = store.currentGeneration().database_path;
  store.close();
  return { root, paths, database, repoId };
}

void describe('S1 event-counter invariant repair', () => {
  void it('repairs counter-behind and appends one immutable audit event in the same transaction', async () => {
    const fixture = await seededStore('pi-autopilot-s1-counter-behind-');
    try {
      const tamper = new DatabaseSync(fixture.database);
      const beforeMaximum = tamper.prepare('SELECT MAX(event_seq) AS maximum FROM events WHERE repo_id=?').get(fixture.repoId)?.['maximum'];
      if (typeof beforeMaximum !== 'number') throw new Error('fixture event maximum is missing');
      tamper.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(beforeMaximum - 1, fixture.repoId);
      tamper.close();
      const repaired = await CoordinatorStore.open(fixture.paths, { now: () => new Date('2026-07-16T01:01:00.000Z') });
      repaired.close();
      const inspect = new DatabaseSync(fixture.database, { readOnly: true });
      try {
        const repositoryCounter = inspect.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(fixture.repoId)?.['event_seq'];
        const event = inspect.prepare("SELECT event_seq,event_type,entity_type,entity_id FROM events WHERE repo_id=? AND event_type='store-invariant-repaired'").get(fixture.repoId);
        assert.equal(repositoryCounter, beforeMaximum + 1);
        assert.equal(event?.['event_seq'], beforeMaximum + 1);
        assert.equal(event?.['event_type'], 'store-invariant-repaired');
        assert.equal(event?.['entity_type'], 'repository');
        assert.equal(event?.['entity_id'], fixture.repoId);
        const evidence = inspect.prepare("SELECT label,content,created_event_seq FROM evidence_artifacts WHERE repo_id=? AND label='event counter behind repair'").get(fixture.repoId);
        assert.equal(evidence?.['created_event_seq'], beforeMaximum + 1);
        const content = evidence?.['content'];
        if (!(content instanceof Uint8Array)) throw new Error('counter repair evidence content is not bytes');
        assert.match(new TextDecoder().decode(content), /"invariant_id":"F4-EVENT-COUNTER-BEHIND"/u);
      } finally { inspect.close(); }
      const replay = await CoordinatorStore.open(fixture.paths);
      replay.close();
      const final = new DatabaseSync(fixture.database, { readOnly: true });
      try { assert.equal(final.prepare("SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND event_type='store-invariant-repaired'").get(fixture.repoId)?.['count'], 1); }
      finally { final.close(); }
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  void it('rolls back a derivable repair when a later authority invariant rejects the store', async () => {
    const fixture = await seededStore('pi-autopilot-s1-counter-repair-rollback-');
    try {
      const tamper = new DatabaseSync(fixture.database);
      const maximum = tamper.prepare('SELECT MAX(event_seq) AS maximum FROM events WHERE repo_id=?').get(fixture.repoId)?.['maximum'];
      if (typeof maximum !== 'number') throw new Error('fixture event maximum is missing');
      tamper.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(maximum - 1, fixture.repoId);
      tamper.exec('DROP TRIGGER worktree_aliases_deny_update');
      tamper.close();
      await assert.rejects(() => CoordinatorStore.open(fixture.paths), /alias immutability trigger is missing or changed/u);
      const inspect = new DatabaseSync(fixture.database, { readOnly: true });
      try {
        assert.equal(inspect.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(fixture.repoId)?.['event_seq'], maximum - 1);
        assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND event_type='store-invariant-repaired'").get(fixture.repoId)?.['count'], 0);
        assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts WHERE repo_id=? AND label='event counter behind repair'").get(fixture.repoId)?.['count'], 0);
      } finally { inspect.close(); }
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  void it('refuses counter-ahead and missing immutable event history without guessing', async () => {
    for (const shape of ['counter-ahead', 'missing-history'] as const) {
      const fixture = await seededStore(`pi-autopilot-s1-${shape}-`);
      try {
        const tamper = new DatabaseSync(fixture.database);
        const maximum = tamper.prepare('SELECT MAX(event_seq) AS maximum FROM events WHERE repo_id=?').get(fixture.repoId)?.['maximum'];
        if (typeof maximum !== 'number') throw new Error('fixture event maximum is missing');
        if (shape === 'counter-ahead') tamper.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(maximum + 1, fixture.repoId);
        else {
          tamper.prepare("INSERT INTO events(repo_id,event_seq,event_type,entity_type,entity_id,idempotency_key,request_sha256,occurred_at) VALUES(?,?,'history-gap-witness','repository',?,'history-gap-witness',?,'2026-07-16T01:00:01.000Z')").run(fixture.repoId, maximum + 1, fixture.repoId, `sha256:${'e'.repeat(64)}`);
          tamper.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(maximum + 1, fixture.repoId);
          tamper.prepare('DELETE FROM events WHERE repo_id=? AND event_seq=1').run(fixture.repoId);
        }
        tamper.close();
        await assert.rejects(() => CoordinatorStore.open(fixture.paths), shape === 'counter-ahead' ? /ahead of immutable event history/u : /missing sequence/u);
        const inspect = new DatabaseSync(fixture.database, { readOnly: true });
        try {
          assert.equal(inspect.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(fixture.repoId)?.['event_seq'], maximum + 1);
          assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND event_type='store-invariant-repaired'").get(fixture.repoId)?.['count'], 0);
        } finally { inspect.close(); }
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
  });
});
