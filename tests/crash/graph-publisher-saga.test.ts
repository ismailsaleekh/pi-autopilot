import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, it } from 'node:test';

import { buildD65CompleteGraph, type D65AuthorityInput, type D65GraphBody, type D65GraphHeader } from '../../src/core/coordination/d65-graph-producer.ts';
import {
  publishD65CompleteGraph,
  type D65GraphGitOps,
  type D65GraphPathManifestRow,
  type D65GraphPublicationPlan,
  type D65GraphPublicationStoreGateway,
} from '../../src/core/coordination/d65-graph-publisher.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { readD65GraphPublicationResidue } from '../../src/core/coordination/d65-graph-publication-residue.ts';
import { createD65GraphGitOps } from '../../src/core/coordination/d65-graph-runtime.ts';
import { bytesSha256, canonicalSha256 } from '../../src/core/coordination/d65-semantic-graph.ts';
import { encodeUnpaddedBase64Url } from '../../src/core/coordination/d65-trust.ts';
import { d65BootstrapCharterFixture } from '../helpers/d65-graph-charter-fixture.ts';
const OID = (char: string): string => char.repeat(40);
const DIGEST = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}` as const;
const BOOTSTRAP_CHARTER = d65BootstrapCharterFixture({ repoId: 'repo-1', autopilotId: 'auto-1', workstream: 'kbg', workstreamRun: 'run-1', programId: 'program-1' });

function git(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Use the production git-process.ts adapter; test-only raw Git only inspects results. */
function realGitOps(repoRoot: string, indexFile: string): D65GraphGitOps {
  return createD65GraphGitOps({ repoRoot, isolatedIndexPath: indexFile });
}

async function withRun<T>(run: (ctx: { repoRoot: string; mainWorktreePath: string; indexFile: string; base: string; baseTree: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-graph-saga-'));
  try {
    const repoRoot = join(root, 'repo');
    await mkdir(repoRoot, { recursive: true });
    git(repoRoot, ['init']);
    git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/autopilot/run-1']);
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
    bootstrap_charter: BOOTSTRAP_CHARTER,
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

function plan(base: string, baseTree: string, authorityPathManifest: readonly D65GraphPathManifestRow[] = []): D65GraphPublicationPlan {
  return {
    publicationId: 'pub-1', programId: 'program-1', repoId: 'repo-1', autopilotId: 'auto-1', workstreamRun: 'run-1', graphSequence: 2,
    priorAuthorityKind: 'bootstrap', priorGraphSha256: DIGEST('a'), priorPublicationCommit: null, priorRegistrationEventSeq: 1,
    authorityBaseCommit: base, authorityRef: 'refs/heads/autopilot/run-1', authorityBaseTree: baseTree,
    authorityPathManifest, authorityPathManifestSha256: canonicalSha256(authorityPathManifest), coveredEventSeq: 5,
    now: () => '2026-07-19T00:00:00.000Z',
  };
}

/** A store gateway recording register calls and whether it should simulate loss. */
class FakeStore implements D65GraphPublicationStoreGateway {
  registerCalls = 0;
  lookupCalls = 0;
  committed: { readonly artifactId: string; readonly publicationCommit: string; readonly graphSha256: string; readonly coveredEventSeq: number; readonly registrationEventSeq: number } | null = null;
  mode: 'ok' | 'lose-before-commit' | 'lose-response' | 'reject' = 'ok';

  registerGraph(input: { artifactId: string; publicationCommit: string; graphRef: string; graphSha256: `sha256:${string}`; coveredEventSeq: number }): { registrationEventSeq: number } {
    this.registerCalls += 1;
    if (this.mode === 'reject') throw new CoordinationRuntimeError('invalid-request', 'store rejected the registration (validation failure)');
    if (this.mode === 'lose-before-commit') { this.mode = 'ok'; throw new Error('transport lost before the registration reached the store'); }
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
      const store = new FakeStore();
      const result = await publishD65CompleteGraph({
        mainWorktreePath: ctx.mainWorktreePath,
        buildGraph: ({ commit, tree }) => producedGraph(commit, tree),
        plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store,
      });
      assert.equal(result.registrationEventSeq, 6);
      assert.equal(store.registerCalls, 1);
      assert.ok(/^[0-9a-f]{40}$/u.test(result.publicationCommit));
      assert.equal(readD65GraphPublicationResidue(ctx.mainWorktreePath), null);
      assert.equal(git(ctx.repoRoot, ['status', '--porcelain=v1']), '');
      const hParts = git(ctx.repoRoot, ['rev-list', '--parents', '-n', '1', result.publicationCommit]).split(/\s+/u);
      const authorityCommit = hParts[1];
      assert.equal(typeof authorityCommit, 'string');
      if (authorityCommit === undefined) throw new Error('H omitted authority G parent');
      assert.deepEqual(git(ctx.repoRoot, ['rev-list', '--parents', '-n', '1', authorityCommit]).split(/\s+/u), [authorityCommit, ctx.base]);
      const authorityTree = git(ctx.repoRoot, ['rev-parse', `${authorityCommit}^{tree}`]);
      const produced = producedGraph(authorityCommit, authorityTree);
      assert.equal(result.graphSha256, bytesSha256(produced.rootBytes));
      assert.equal(git(ctx.repoRoot, ['ls-tree', '-r', '--name-only', authorityCommit]).split('\n').includes(produced.rootRef), false);
      assert.equal(git(ctx.repoRoot, ['cat-file', 'blob', `${result.publicationCommit}:${produced.rootRef}`]), new TextDecoder().decode(produced.rootBytes).replace(/\n$/u, ''));
    });
  });

  void it('creates G from exact sealed add/delete/mode postimages before creating graph-only H', async () => {
    await withRun(async (ctx) => {
      const ops = realGitOps(ctx.repoRoot, ctx.indexFile);
      const productOid = git(ctx.repoRoot, ['rev-parse', `${ctx.base}:product.txt`]);
      const linkBytes = new TextEncoder().encode('product-target');
      const linkOid = ops.hashObject(linkBytes);
      const pathB64 = (path: string): string => encodeUnpaddedBase64Url(new TextEncoder().encode(path)).replace(/-/gu, '+').replace(/_/gu, '/');
      const manifest: readonly D65GraphPathManifestRow[] = [
        { path_b64: pathB64('link.txt'), pre_exists: false, pre_mode: null, pre_type: null, pre_oid: null, post_exists: true, post_mode: '120000', post_type: 'blob', post_oid: linkOid },
        { path_b64: pathB64('product.txt'), pre_exists: true, pre_mode: '100644', pre_type: 'blob', pre_oid: productOid, post_exists: false, post_mode: null, post_type: null, post_oid: null },
      ];
      // The sealed postimages already exist in the owned worktree; G records
      // exactly those bytes, then reset-mixed aligns only the shared index.
      await unlink(join(ctx.repoRoot, 'product.txt'));
      await symlink('product-target', join(ctx.repoRoot, 'link.txt'));
      const result = await publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, buildGraph: ({ commit, tree }) => producedGraph(commit, tree), plan: plan(ctx.base, ctx.baseTree, manifest), git: ops, store: new FakeStore() });
      const hParts = git(ctx.repoRoot, ['rev-list', '--parents', '-n', '1', result.publicationCommit]).split(/\s+/u);
      const g = hParts[1];
      if (g === undefined) throw new Error('H omitted G');
      assert.deepEqual(git(ctx.repoRoot, ['rev-list', '--parents', '-n', '1', g]).split(/\s+/u), [g, ctx.base]);
      assert.equal(git(ctx.repoRoot, ['ls-tree', g, '--', 'product.txt']), '');
      assert.match(git(ctx.repoRoot, ['ls-tree', g, '--', 'link.txt']), /^120000 blob [0-9a-f]{40}\tlink\.txt$/u);
      assert.equal(git(ctx.repoRoot, ['cat-file', 'blob', `${g}:link.txt`]), 'product-target');
      assert.equal(git(ctx.repoRoot, ['status', '--porcelain=v1']), '');
    });
  });

  void it('recovers from a lost register response by proving the immutable committed registration', async () => {
    await withRun(async (ctx) => {
      const store = new FakeStore();
      store.mode = 'lose-response';
      const result = await publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, buildGraph: ({ commit, tree }) => producedGraph(commit, tree), plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store });
      assert.equal(store.registerCalls, 1);
      assert.equal(store.lookupCalls, 1);
      assert.equal(result.registrationEventSeq, 6);
      assert.equal(readD65GraphPublicationResidue(ctx.mainWorktreePath), null);
    });
  });

  void it('retries exactly once after effect-unknown plus proven clean absence', async () => {
    await withRun(async (ctx) => {
      const store = new FakeStore();
      store.mode = 'lose-before-commit';
      const result = await publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, buildGraph: ({ commit, tree }) => producedGraph(commit, tree), plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store });
      assert.equal(result.registrationEventSeq, 6);
      assert.equal(store.registerCalls, 2);
      assert.equal(store.lookupCalls, 1);
    });
  });

  void it('resumes exact H after crash between graph-ref CAS and publication-residue advance', async () => {
    await withRun(async (ctx) => {
      const ops = realGitOps(ctx.repoRoot, ctx.indexFile);
      const store = new FakeStore();
      await assert.rejects(
        () => publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, buildGraph: () => { throw new Error('injected stop after durable G'); }, plan: plan(ctx.base, ctx.baseTree), git: ops, store }),
        /injected stop after durable G/u,
      );
      const authorityResidue = readD65GraphPublicationResidue(ctx.mainWorktreePath);
      if (authorityResidue?.stage !== 'authority-committed' || authorityResidue.authority_commit === null || authorityResidue.authority_tree === null) throw new Error('fixture did not stop at durable authority G');
      const produced = producedGraph(authorityResidue.authority_commit, authorityResidue.authority_tree);
      const graphEntries = [{ path: produced.rootRef, bytes: produced.rootBytes }, ...produced.shards.map((shard) => ({ path: shard.ref, bytes: shard.bytes }))];
      const h = ops.commitTreeWithBlobs({ baseTree: authorityResidue.authority_tree, parent: authorityResidue.authority_commit, entries: graphEntries.map((entry) => ({ path: entry.path, oid: ops.hashObject(entry.bytes) })), message: 'autopilot: graph publication commit H\n' });
      const publicationRef = `refs/heads/autopilot/graph/${dirname(produced.rootRef)}`;
      await ops.updateRefCas({ ref: publicationRef, target: h.commit, expectedOld: OID('0') });
      // This is the exact crash window: Git effect exists, durable residue has
      // not advanced. Replay must prove and reuse H instead of retrying zero-old.
      assert.equal(readD65GraphPublicationResidue(ctx.mainWorktreePath)?.stage, 'authority-committed');
      const result = await publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, buildGraph: ({ commit, tree }) => producedGraph(commit, tree), plan: plan(ctx.base, ctx.baseTree), git: ops, store });
      assert.equal(result.publicationCommit, h.commit);
      assert.equal(store.registerCalls, 1);
      assert.equal(readD65GraphPublicationResidue(ctx.mainWorktreePath), null);
    });
  });

  void it('stays fenced when the store rejects, preserving immutable provisional G/H residue', async () => {
    await withRun(async (ctx) => {
      const store = new FakeStore();
      store.mode = 'reject';
      await assert.rejects(() => publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, buildGraph: ({ commit, tree }) => producedGraph(commit, tree), plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store }), /store rejected the registration/u);
      assert.equal(store.registerCalls, 1);
      assert.equal(store.lookupCalls, 0);
      const residue = readD65GraphPublicationResidue(ctx.mainWorktreePath);
      if (residue === null) throw new Error('publication failure removed the durable residue');
      assert.equal(residue.stage, 'publication-committed');
      assert.equal(residue.registration_event_seq, null);
      assert.ok(residue.publication_commit !== null);
    });
  });

  void it('resumes idempotently from an existing publication-committed residue to registered', async () => {
    await withRun(async (ctx) => {
      const store = new FakeStore();
      store.mode = 'reject';
      const publish = (): ReturnType<typeof publishD65CompleteGraph> => publishD65CompleteGraph({ mainWorktreePath: ctx.mainWorktreePath, buildGraph: ({ commit, tree }) => producedGraph(commit, tree), plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store });
      await assert.rejects(publish);
      const beforeH = readD65GraphPublicationResidue(ctx.mainWorktreePath)?.publication_commit;
      store.mode = 'ok';
      const result = await publish();
      assert.equal(result.publicationCommit, beforeH, 'resume reuses immutable provisional H');
      assert.equal(result.registrationEventSeq, 6);
      assert.equal(readD65GraphPublicationResidue(ctx.mainWorktreePath), null);
    });
  });

  void it('rejects a residue that binds a different pre-G authority base commit', async () => {
    await withRun(async (ctx) => {
      const store = new FakeStore();
      store.mode = 'reject';
      const baseInput = { mainWorktreePath: ctx.mainWorktreePath, buildGraph: ({ commit, tree }: { commit: string; tree: string }) => producedGraph(commit, tree), plan: plan(ctx.base, ctx.baseTree), git: realGitOps(ctx.repoRoot, ctx.indexFile), store };
      await assert.rejects(() => publishD65CompleteGraph(baseInput));
      const otherPlan = { ...plan(ctx.base, ctx.baseTree), authorityBaseCommit: OID('9') };
      await assert.rejects(
        () => publishD65CompleteGraph({ ...baseInput, plan: otherPlan }),
        /existing residue binds a different authority base commit/u,
      );
    });
  });
});
