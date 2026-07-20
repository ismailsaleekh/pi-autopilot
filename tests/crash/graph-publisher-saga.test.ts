import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, it } from 'node:test';

import {
  runGitPlumbing,
  type GitCommitIdentity,
} from '../../src/core/git-process.ts';
import { buildD65CompleteGraph, type D65AuthorityInput, type D65GraphBody, type D65GraphHeader } from '../../src/core/coordination/d65-graph-producer.ts';
import {
  publishD65CompleteGraph,
  type D65GraphGitOps,
  type D65GraphPublicationPlan,
  type D65GraphPublicationStoreGateway,
} from '../../src/core/coordination/d65-graph-publisher.ts';
import { readD65GraphPublicationResidue } from '../../src/core/coordination/d65-graph-publication-residue.ts';
import { bytesSha256 } from '../../src/core/coordination/d65-semantic-graph.ts';

const IDENTITY: GitCommitIdentity = Object.freeze({ name: 'autopilot', email: 'autopilot@invalid', date: '1700000000 +0000' });
const OID = (char: string): string => char.repeat(40);
const DIGEST = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}` as const;

function git(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A real-git D65GraphGitOps backed by the actual isolated-index plumbing. */
function realGitOps(repoRoot: string, indexFile: string): D65GraphGitOps {
  return {
    hashObject(bytes) {
      const oid = runGitPlumbing({ descriptor: { kind: 'hash-object-write', bytes }, cwd: repoRoot, indexFile }).oid;
      if (oid === null) throw new Error('hash-object produced no oid');
      return oid;
    },
    commitTreeWithBlobs(input) {
      runGitPlumbing({ descriptor: { kind: 'read-tree', tree: input.baseTree }, cwd: repoRoot, indexFile });
      runGitPlumbing({ descriptor: { kind: 'update-index-cacheinfo', entries: input.entries.map((entry) => ({ oid: entry.oid, path: entry.path })) }, cwd: repoRoot, indexFile });
      const tree = runGitPlumbing({ descriptor: { kind: 'write-tree' }, cwd: repoRoot, indexFile }).oid;
      if (tree === null) throw new Error('write-tree produced no oid');
      const commit = runGitPlumbing({ descriptor: { kind: 'commit-tree', tree, parents: [input.parent], message: input.message, identity: IDENTITY }, cwd: repoRoot, indexFile }).oid;
      if (commit === null) throw new Error('commit-tree produced no oid');
      return { commit, tree };
    },
    commitTree(input) {
      const commit = runGitPlumbing({ descriptor: { kind: 'commit-tree', tree: input.tree, parents: [input.parent], message: input.message, identity: IDENTITY }, cwd: repoRoot, indexFile }).oid;
      if (commit === null) throw new Error('commit-tree produced no oid');
      return commit;
    },
    resolveTree(commit) {
      return git(repoRoot, ['rev-parse', `${commit}^{tree}`]);
    },
    revListParents(commit) {
      return git(repoRoot, ['rev-list', '--parents', '-n', '1', commit]).split(/\s+/u).filter((entry) => entry.length > 0);
    },
    diffPaths(from, to) {
      const out = git(repoRoot, ['diff', '--name-only', '-z', from, to]);
      return out.split('\0').filter((entry) => entry.length > 0);
    },
    updateRefCas(input) {
      // Drive update-ref CAS directly (create from the zero oid) in the test.
      const result = spawnSync('git', ['update-ref', input.ref, input.target, input.expectedOld], { cwd: repoRoot, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`update-ref CAS failed: ${result.stderr}`);
    },
  };
}

async function withRun<T>(run: (ctx: { repoRoot: string; mainWorktreePath: string; indexFile: string; base: string; baseTree: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-graph-saga-'));
  try {
    const repoRoot = join(root, 'repo');
    await mkdir(repoRoot, { recursive: true });
    git(repoRoot, ['init']);
    git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(repoRoot, ['config', 'user.email', 'seed@example.invalid']);
    git(repoRoot, ['config', 'user.name', 'Seed']);
    await writeFile(join(repoRoot, 'product.txt'), 'product\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'base']);
    const base = git(repoRoot, ['rev-parse', 'HEAD']);
    const baseTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
    // The residue lives at the sibling of the main worktree path.
    const mainWorktreePath = join(root, 'state', 'main');
    await mkdir(dirname(mainWorktreePath), { recursive: true });
    const indexFile = join(root, 'iso.index');
    return await run({ repoRoot, mainWorktreePath, indexFile, base, baseTree });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function producedGraph(base: string, baseTree: string) {
  const header: D65GraphHeader = {
    program_id: 'program-1', repo_id: 'repo-1', autopilot_id: 'auto-1', workstream: 'kbg', workstream_run: 'run-1',
    graph_sequence: 2, prior_graph_sha256: DIGEST('a'), prior_event_seq: 1,
    covered_authority_commit: base, covered_authority_tree: baseTree, covered_event_seq: 5,
    created_at: '2026-07-19T00:00:00.000Z',
    bootstrap_charter: { repository: {}, run: {}, run_resource: {}, mailbox_cursor: {}, bootstrap_graph: {}, bootstrap_artifact: {}, trust_anchor: {}, attach_event: {}, attach_result: {} },
  };
  const collections = {} as Record<string, readonly D65AuthorityInput[]>;
  for (const key of ['authorities', 'specs', 'statuses', 'receipts', 'audits', 'execution_commits', 'terminal_acceptances', 'unit_merge_intents', 'unit_merges', 'integration_analyses', 'quarantine', 'reconciliation', 'evidence']) collections[key] = [];
  const core = (schema: string | null, records: number | null, body: string): Record<string, unknown> => ({ ref: `runtime/${schema ?? 'mission'}.f`, git_mode: '100644', git_blob_oid: OID('a'), sha256: bytesSha256(Buffer.from(body, 'utf8')), byte_count: Buffer.byteLength(body, 'utf8'), record_count: records, document_schema_version: schema });
  const body: D65GraphBody = {
    core: { mission: core(null, null, '# m\n') as never, master_plan: core('autopilot.master_plan.v1', 1, '{}\n') as never, state: core('autopilot.state.v1', 1, '{}\n') as never, decision_log: core('autopilot.decision.v1', 1, '{}\n') as never, events: core('autopilot.event.v1', 1, '{}\n') as never } as never,
    collections: collections as never,
    projections: { work_items: [], bughunt: [], exceptions: [], coordinator_projection: [] } as never,
    queues: { unit_ready: [{ identity: 'unit-1', kind: 'unit_ready', value: { identity: 'unit-1' } }], unit_running: [], unit_blocked: [], unit_completed: [], unit_held: [], work_audit_review: [], work_validation_ready: [] } as never,
    closure: null,
  };
  return buildD65CompleteGraph(header, body);
}

function plan(base: string, baseTree: string): D65GraphPublicationPlan {
  return {
    publicationId: 'pub-1', programId: 'program-1', repoId: 'repo-1', autopilotId: 'auto-1', workstreamRun: 'run-1',
    priorAuthorityKind: 'bootstrap', priorGraphSha256: DIGEST('a'), priorPublicationCommit: null, priorRegistrationEventSeq: 1,
    authorityBaseCommit: base, authorityBaseTree: baseTree,
    authorityPathManifest: [], authorityPathManifestSha256: DIGEST('f'), coveredEventSeq: 5,
    now: () => '2026-07-19T00:00:00.000Z',
  };
}

/** A store gateway recording register calls and whether it should simulate loss. */
class FakeStore implements D65GraphPublicationStoreGateway {
  registerCalls = 0;
  lookupCalls = 0;
  committed: { readonly artifactId: string; readonly publicationCommit: string; readonly graphSha256: string; readonly coveredEventSeq: number; readonly registrationEventSeq: number } | null = null;
  mode: 'ok' | 'lose-response' | 'reject' = 'ok';

  registerGraph(input: { artifactId: string; publicationCommit: string; graphRef: string; graphSha256: `sha256:${string}`; coveredEventSeq: number }): { registrationEventSeq: number } {
    this.registerCalls += 1;
    if (this.mode === 'reject') throw new Error('store rejected the registration (validation failure)');
    // The store transaction commits WITHOUT any residue write (SR-1): record it.
    this.committed = { artifactId: input.artifactId, publicationCommit: input.publicationCommit, graphSha256: input.graphSha256, coveredEventSeq: input.coveredEventSeq, registrationEventSeq: 6 };
    if (this.mode === 'lose-response') throw new Error('response lost after commit');
    return { registrationEventSeq: 6 };
  }

  lookupCommittedRegistration(input: { artifactId: string; publicationCommit: string; graphSha256: `sha256:${string}`; coveredEventSeq: number }): { registrationEventSeq: number } | null {
    this.lookupCalls += 1;
    if (this.committed === null) return null;
    if (this.committed.artifactId !== input.artifactId || this.committed.publicationCommit !== input.publicationCommit || this.committed.graphSha256 !== input.graphSha256 || this.committed.coveredEventSeq !== input.coveredEventSeq) {
      throw new Error('committed registration mismatch (terminal)');
    }
    return { registrationEventSeq: this.committed.registrationEventSeq };
  }
}

void describe('D65 graph-publication saga runtime consumer', () => {
  void it('drives prepared -> G -> H -> register -> registered and cleans up, with real isolated-index Git', async () => {
    await withRun(async (ctx) => {
      const produced = producedGraph(ctx.base, ctx.baseTree);
      const store = new FakeStore();
      const result = publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, produced, plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store });
      // R is the committed registration event; H is a real commit.
      assert.equal(result.registrationEventSeq, 6);
      assert.equal(store.registerCalls, 1);
      assert.ok(/^[0-9a-f]{40}$/u.test(result.publicationCommit));
      assert.equal(result.graphSha256, bytesSha256(produced.rootBytes));
      // The residue is cleaned up after registration (descriptor-safe cleanup).
      assert.equal(readD65GraphPublicationResidue(ctx.mainWorktreePath), null);
      // The shared working tree is untouched (isolated index only).
      assert.equal(git(ctx.repoRoot, ['status', '--porcelain=v1']), '');
      // G exists with sole parent = base, and its tree carries the graph root blob.
      const g = git(ctx.repoRoot, ['rev-list', '--parents', '-n', '1', `${result.publicationCommit}^`]);
      const gParts = g.split(/\s+/u);
      assert.equal(gParts[1], ctx.base, 'G sole parent is the authority base commit');
      assert.equal(git(ctx.repoRoot, ['cat-file', 'blob', `${result.publicationCommit}:${produced.rootRef}`]), new TextDecoder().decode(produced.rootBytes).replace(/\n$/u, ''));
    });
  });

  void it('recovers from a lost register response by proving the immutable committed registration', async () => {
    await withRun(async (ctx) => {
      const produced = producedGraph(ctx.base, ctx.baseTree);
      const store = new FakeStore();
      store.mode = 'lose-response';
      const result = publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, produced, plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store });
      // Register threw (response lost) but the store DID commit; recovery proves R.
      assert.equal(store.registerCalls, 1);
      assert.equal(store.lookupCalls, 1);
      assert.equal(result.registrationEventSeq, 6);
      assert.equal(readD65GraphPublicationResidue(ctx.mainWorktreePath), null);
    });
  });

  void it('stays fenced (never registered) when the store rejects, preserving the immutable provisional G/H residue', async () => {
    await withRun(async (ctx) => {
      const produced = producedGraph(ctx.base, ctx.baseTree);
      const store = new FakeStore();
      store.mode = 'reject';
      assert.throws(() => publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, produced, plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store }), /store rejected the registration/u);
      // The residue is preserved at publication-committed (G and H exist, R absent):
      // a rollback can never coexist with a registered residue.
      const residue = readD65GraphPublicationResidue(ctx.mainWorktreePath);
      assert.ok(residue !== null);
      assert.equal(residue?.stage, 'publication-committed');
      assert.equal(residue?.registration_event_seq, null);
      assert.ok(residue?.publication_commit !== null);
    });
  });

  void it('resumes idempotently from an existing publication-committed residue to registered', async () => {
    await withRun(async (ctx) => {
      const produced = producedGraph(ctx.base, ctx.baseTree);
      const store = new FakeStore();
      store.mode = 'reject';
      // First drive fails at register, leaving a publication-committed residue.
      assert.throws(() => publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, produced, plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store }));
      const beforeH = readD65GraphPublicationResidue(ctx.mainWorktreePath)?.publication_commit;
      // The store recovers; a second drive RESUMES from publication-committed
      // (does NOT rebuild G/H) and completes registration.
      store.mode = 'ok';
      const result = publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, produced, plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store });
      assert.equal(result.publicationCommit, beforeH, 'resume reuses the immutable provisional H (no rebuild)');
      assert.equal(result.registrationEventSeq, 6);
      assert.equal(readD65GraphPublicationResidue(ctx.mainWorktreePath), null);
    });
  });

  void it('rejects a residue that binds a different authority base commit (no silent takeover)', async () => {
    await withRun(async (ctx) => {
      const produced = producedGraph(ctx.base, ctx.baseTree);
      const store = new FakeStore();
      store.mode = 'reject';
      assert.throws(() => publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, produced, plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store }));
      // A second publish with a DIFFERENT authority base must reject against the
      // existing residue rather than silently taking it over.
      const otherPlan = { ...plan(ctx.base, ctx.baseTree), authorityBaseCommit: OID('9') };
      assert.throws(
        () => publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, produced, plan: otherPlan, git: realGitOps(ctx.repoRoot, ctx.indexFile), store }),
        /existing residue binds a different authority base commit/u,
      );
    });
  });
});
