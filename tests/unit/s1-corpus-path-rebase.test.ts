import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { rebaseCorpusPaths, type CorpusPathMapping } from '../../tools/s1-corpus-rehearsal/path-rebase.ts';

function createSchema12(path: string, sourceRepo: string, sourceGit: string, sourceState: string, foreignWorktree = false): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA user_version=12;
      CREATE TABLE repositories(repo_id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL, git_common_dir TEXT NOT NULL) STRICT;
      CREATE TABLE run_resources(entity_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
      CREATE TABLE worktrees(entity_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
      CREATE TABLE worktree_operations(entity_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
    `);
    database.prepare('INSERT INTO repositories VALUES(?,?,?)').run('repo', sourceRepo, sourceGit);
    database.prepare('INSERT INTO run_resources VALUES(?,?)').run('resource', canonicalJson({ source_repo: sourceRepo, git_common_dir: sourceGit, worktree_root: join(sourceState, 'worktrees'), main_worktree_path: join(sourceState, 'worktrees', 'run', 'main'), runtime_root: join(sourceState, 'worktrees', 'run', 'main', '.pi', 'autopilot'), historical_path: join(sourceState, 'historical-only'), origin_url: `file://${sourceRepo}`, remote_url: 'ssh://example.invalid/repository' }));
    database.prepare('INSERT INTO worktrees VALUES(?,?)').run('worktree', canonicalJson({ canonical_path: foreignWorktree ? '/foreign/live/worktree' : join(sourceState, 'worktrees', 'run', 'unit'), git_common_dir: sourceGit }));
    database.prepare('INSERT INTO worktree_operations VALUES(?,?)').run('operation', canonicalJson({ intent: { repo_root: sourceRepo, worktree_path: join(sourceState, 'worktrees', 'run', 'unit'), git_common_dir: sourceGit, paths: ['src/file.ts'] } }));
  } finally { database.close(); }
}

void it('rebases only closed actionable clone fields, neutralizes remotes, and emits a path-hashed ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-c5-rebase-'));
  const cloneRoot = join(root, 'clone');
  const stateRoot = join(cloneRoot, 'state');
  const databasePath = join(stateRoot, 'coordinator', 'coordinator.db');
  const sourceState = join(root, 'live-state');
  const sourceRepo = join(root, 'live-repository');
  const sourceGit = join(sourceRepo, '.git');
  const copyRepo = join(cloneRoot, 'repository');
  const copyGit = join(copyRepo, '.git');
  const ledgerPath = join(cloneRoot, 'private', 'path-rebase-ledger.json');
  try {
    await mkdir(join(databasePath, '..'), { recursive: true });
    await mkdir(join(stateRoot, 'coordination'), { recursive: true });
    await mkdir(join(stateRoot, 'evidence'), { recursive: true });
    createSchema12(databasePath, sourceRepo, sourceGit, sourceState);
    await writeFile(join(stateRoot, 'coordination', 'active-autopilots.json'), `${canonicalJson([{ source_repo: sourceRepo, git_common_dir: sourceGit, main_worktree_path: join(sourceState, 'worktrees', 'run', 'main'), origin_url: `file://${sourceRepo}` }])}\n`, 'utf8');
    const evidencePath = join(stateRoot, 'evidence', 'immutable-evidence.json');
    const evidenceStatePath = join(stateRoot, 'evidence', 'state.json');
    const evidenceBytes = `${canonicalJson({ historical_path: join(sourceState, 'worktrees', 'removed') })}\n`;
    const evidenceStateBytes = `${canonicalJson({ source_repo: sourceRepo, origin_url: `file://${sourceRepo}` })}\n`;
    await writeFile(evidencePath, evidenceBytes, 'utf8');
    await writeFile(evidenceStatePath, evidenceStateBytes, 'utf8');
    const mappings: readonly CorpusPathMapping[] = [
      { source_path: sourceGit, copy_path: copyGit, source_label: 'git', kind: 'git-common-dir' },
      { source_path: sourceRepo, copy_path: copyRepo, source_label: 'repository', kind: 'repo-root' },
      { source_path: join(sourceState, 'evidence'), copy_path: join(stateRoot, 'evidence'), source_label: 'evidence', kind: 'evidence' },
      { source_path: sourceState, copy_path: stateRoot, source_label: 'state', kind: 'state-root' },
    ];
    const result = await rebaseCorpusPaths({ database_path: databasePath, state_root: stateRoot, clone_root: cloneRoot, mappings, ledger_path: ledgerPath, expected_user_version: 12 });
    assert.ok(result.entries.length >= 10);
    const inspect = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const repository = inspect.prepare('SELECT canonical_root,git_common_dir FROM repositories').get();
      assert.equal(repository?.['canonical_root'], copyRepo);
      assert.equal(repository?.['git_common_dir'], copyGit);
      const resource = JSON.parse(String(inspect.prepare('SELECT payload_json FROM run_resources').get()?.['payload_json'])) as Record<string, unknown>;
      assert.equal(resource['source_repo'], copyRepo);
      assert.equal(resource['origin_url'], null);
      assert.equal(resource['remote_url'], null);
      assert.equal(resource['historical_path'], join(sourceState, 'historical-only'), 'non-actionable historical bytes must not be reinterpreted');
      assert.equal(String(inspect.prepare('SELECT payload_json FROM worktrees').get()?.['payload_json']).includes(sourceState), false);
      assert.equal(String(inspect.prepare('SELECT payload_json FROM worktree_operations').get()?.['payload_json']).includes(sourceRepo), false);
    } finally { inspect.close(); }
    const metadata = await readFile(join(stateRoot, 'coordination', 'active-autopilots.json'), 'utf8');
    assert.equal(metadata.includes(sourceRepo), false);
    assert.equal(metadata.includes(copyRepo), true);
    assert.equal(await readFile(evidencePath, 'utf8'), evidenceBytes, 'immutable evidence content must not be rebased');
    assert.equal(await readFile(evidenceStatePath, 'utf8'), evidenceStateBytes, 'evidence named like mutable metadata must remain byte-exact');
    const ledger = await readFile(ledgerPath, 'utf8');
    assert.equal(ledger.includes(sourceRepo), false);
    assert.equal(ledger.includes(sourceState), false);
    assert.match(result.ledger_sha256, /^sha256:[a-f0-9]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

void it('rolls back the clone database when an actionable absolute path has no declared rebase authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-c5-rebase-refusal-'));
  const cloneRoot = join(root, 'clone');
  const stateRoot = join(cloneRoot, 'state');
  const databasePath = join(stateRoot, 'coordinator', 'coordinator.db');
  const sourceState = join(root, 'live-state');
  const sourceRepo = join(root, 'live-repository');
  const sourceGit = join(sourceRepo, '.git');
  try {
    await mkdir(join(databasePath, '..'), { recursive: true });
    createSchema12(databasePath, sourceRepo, sourceGit, sourceState, true);
    await assert.rejects(() => rebaseCorpusPaths({
      database_path: databasePath,
      state_root: stateRoot,
      clone_root: cloneRoot,
      mappings: [
        { source_path: sourceGit, copy_path: join(cloneRoot, 'repository', '.git'), source_label: 'git', kind: 'git-common-dir' },
        { source_path: sourceRepo, copy_path: join(cloneRoot, 'repository'), source_label: 'repository', kind: 'repo-root' },
        { source_path: sourceState, copy_path: stateRoot, source_label: 'state', kind: 'state-root' },
      ],
      ledger_path: join(cloneRoot, 'private', 'ledger.json'),
      expected_user_version: 12,
    }), /outside the declared source corpus/u);
    const inspect = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(inspect.prepare('SELECT canonical_root FROM repositories').get()?.['canonical_root'], sourceRepo); }
    finally { inspect.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
