import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { assertNoSharedRegularFileIdentity, copyTreeWithoutLinks, inventoryTree } from '../../tools/s2-corpus-rehearsal/inventory.ts';
import { rebaseCorpusPaths } from '../../tools/s2-corpus-rehearsal/path-rebase.ts';
import { preflightCloneRequest } from '../../tools/s2-corpus-rehearsal/release-gate.ts';

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.status, 0, result.stderr);
}

void describe('S2-D corpus isolation helpers', () => {
  void it('preflights canonical physical sources and rejects destination containment and stale capability formats', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-s2-d-preflight-')));
    const state = join(root, 'state');
    const repo = join(root, 'repo');
    const database = join(state, 'coordinator', 'coordinator.db');
    const capability = join(state, 'coordinator', 'capability');
    try {
      await mkdir(join(database, '..'), { recursive: true });
      await mkdir(repo, { recursive: true });
      git(repo, ['init']);
      await writeFile(database, 'db\n', { encoding: 'utf8', mode: 0o600 });
      await writeFile(capability, `${'b'.repeat(64)}\n`, { encoding: 'utf8', mode: 0o600 });
      const request = { schema_version: 'autopilot.s2_d_corpus_clone_request.v1' as const, rehearsal_id: 's2-d-preflight', created_at: '2026-07-23T00:00:00.000Z', destination_root: join(root, 'clone'), result_path: join(root, 'clone', 'private', 'result.json'), candidate_build: 'phase36-s2', corpora: [{ corpus_id: 'corpus', state_root: state, repository_root: repo, database_path: database, capability_path: capability, retained_snapshot_roots: [] }] };
      assert.equal((await preflightCloneRequest(request)).destination_root, join(root, 'clone'));
      await assert.rejects(() => preflightCloneRequest({ ...request, destination_root: join(state, 'nested-clone'), result_path: join(state, 'nested-clone', 'result.json') }), /not disjoint/u);
      await writeFile(capability, 'historical-token\n', { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(() => preflightCloneRequest(request), /current 64-hex format/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('copies regular files without shared identity and rejects symlink or hardlink routes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-s2-d-copy-')));
    const source = join(root, 'source');
    const copy = join(root, 'copy');
    const hardlinked = join(root, 'hardlinked');
    const symlinked = join(root, 'symlinked');
    try {
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'authority.txt'), 'source authority\n', { encoding: 'utf8', mode: 0o600 });
      await copyTreeWithoutLinks(source, copy);
      assertNoSharedRegularFileIdentity(await inventoryTree(source), await inventoryTree(copy));
      await mkdir(hardlinked, { recursive: true });
      const linkResult = spawnSync('ln', [join(source, 'authority.txt'), join(hardlinked, 'authority.txt')]);
      assert.equal(linkResult.status, 0);
      const sourceInventory = await inventoryTree(source);
      const hardlinkedInventory = await inventoryTree(hardlinked);
      assert.throws(() => assertNoSharedRegularFileIdentity(sourceInventory, hardlinkedInventory), /hardlinked|shares a regular-file identity/u);
      await mkdir(symlinked, { recursive: true });
      const symlinkResult = spawnSync('ln', ['-s', join(source, 'authority.txt'), join(symlinked, 'live-link')]);
      assert.equal(symlinkResult.status, 0);
      await assert.rejects(() => copyTreeWithoutLinks(symlinked, join(root, 'copy-symlinked')), /live-routable symlink/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('rebases actionable JSON paths and neutralizes writable remotes without storing old paths', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-s2-d-rebase-')));
    const source = join(root, 'source');
    const clone = join(root, 'clone');
    const state = join(clone, 'state');
    const copyRepo = join(clone, 'repo');
    try {
      await mkdir(source, { recursive: true });
      await mkdir(state, { recursive: true });
      await mkdir(copyRepo, { recursive: true });
      await writeFile(join(state, 'metadata.json'), `${canonicalJson({ source_repo: source, target_registration_path: join(source, '.git', 'worktrees', 'target'), approved_prunable_registration_paths: [join(source, '.git', 'worktrees', 'old')], origin_url: `file://${source}` })}\n`, { encoding: 'utf8', mode: 0o600 });
      const result = await rebaseCorpusPaths({ clone_root: clone, state_root: state, ledger_path: join(clone, 'private', 'path-rebase-ledger.json'), rehearsal_id: 's2-d-rebase', mappings: [{ corpus_id: 'corpus', source_path: source, copy_path: copyRepo, source_label: 'repository' }] });
      assert.equal(result.entries.length, 4);
      const ledger = await readFile(join(clone, 'private', 'path-rebase-ledger.json'), 'utf8');
      assert.equal(ledger.includes(source), false);
      assert.equal(ledger.includes('file://'), false);
      assert.equal((await readFile(join(state, 'metadata.json'), 'utf8')).includes(source), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('refuses unknown absolute paths during structural rebase post-scan', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-s2-d-rebase-unknown-')));
    const source = join(root, 'source');
    const unknown = join(root, 'unknown');
    const clone = join(root, 'clone');
    const state = join(clone, 'state');
    const copyRepo = join(clone, 'repo');
    try {
      await mkdir(source, { recursive: true });
      await mkdir(unknown, { recursive: true });
      await mkdir(state, { recursive: true });
      await mkdir(copyRepo, { recursive: true });
      await writeFile(join(state, 'metadata.json'), `${canonicalJson({ nested: { path: join(unknown, 'live-write-route') } })}\n`, { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(() => rebaseCorpusPaths({ clone_root: clone, state_root: state, ledger_path: join(clone, 'private', 'path-rebase-ledger.json'), rehearsal_id: 's2-d-rebase', mappings: [{ corpus_id: 'corpus', source_path: source, copy_path: copyRepo, source_label: 'repository' }] }), /escapes declared source authority/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
