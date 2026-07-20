import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { parseD65AttachRunResultV2, D65_ALLOWED_BOOTSTRAP_OPERATIONS } from '../../src/core/coordination/d65-semantic-graph.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, type CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' } });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function sha256(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

interface Fixture {
  readonly repoId: string;
  readonly runId: string;
  readonly request: CoordinatorRequestEnvelope;
  readonly repository: string;
}

async function buildFixture(root: string, repository: string, suffix: string): Promise<Fixture> {
  const repoId = `graph-crash-${suffix}`;
  const runId = `run-${suffix}`;
  const autopilotId = `autopilot-${suffix}`;
  const workstream = `work-${suffix}`;
  const contentCommit = git(repository, ['rev-parse', 'HEAD']);
  const contentTree = git(repository, ['rev-parse', 'HEAD^{tree}']);

  const runResource = {
    schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId,
    source_repo: repository, git_common_dir: join(repository, '.git'), worktree_root: join(root, 'worktrees', repoId),
    main_worktree_path: join(root, 'worktrees', repoId, 'active', runId, 'main'), runtime_root: join(root, 'worktrees', repoId, 'active', runId, 'main', '.pi', 'autopilot', workstream),
    branch: `autopilot/${runId}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null, started_at: '2026-07-19T00:00:00.000Z', version: 1,
  };
  const prospectiveRun = {
    schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId,
    coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1,
  };

  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }) as unknown as Uint8Array);
  const trustRef = `.pi/autopilot-trust/d65/program-${suffix}/operator-ed25519.spki`;
  const trustSha256 = `sha256:${createHash('sha256').update(spki).digest('hex')}` as `sha256:${string}`;

  const bootstrapRef = `.pi/autopilot-bootstrap/${runId}/bootstrap.json`;
  const bootstrap = {
    schema_version: 'autopilot.semantic_graph_bootstrap.v1', program_id: `program-${suffix}`, graph_sequence: 1, prior_graph_sha256: null,
    repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId, run_timestamp: '2026-07-19T00:00:00.000Z', run_nonce: 'abcdef',
    content_commit: contentCommit, content_tree: contentTree, package_commit: 'a'.repeat(40), package_tree: 'b'.repeat(40),
    prospective_run: prospectiveRun, prospective_resource: runResource, covered_event_seq: 0,
    trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, allowed_bootstrap_operations: [...D65_ALLOWED_BOOTSTRAP_OPERATIONS], created_at: '2026-07-19T00:00:01.000Z',
  };
  const bootstrapBytes = `${JSON.stringify(bootstrap, null, 2)}\n`;

  git(repository, ['checkout', '-b', `autopilot/bootstrap/${runId}`, contentCommit]);
  await mkdir(join(repository, `.pi/autopilot-trust/d65/program-${suffix}`), { recursive: true });
  await writeFile(join(repository, trustRef), spki);
  await mkdir(join(repository, `.pi/autopilot-bootstrap/${runId}`), { recursive: true });
  await writeFile(join(repository, bootstrapRef), bootstrapBytes, 'utf8');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'bootstrap overlay']);
  const bootstrapCommit = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['checkout', 'main']);

  const request: CoordinatorRequestEnvelope = {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
    request_id: `attach-${suffix}`, action: 'attach-run', idempotency_key: `attach-${suffix}`, repo_id: repoId, workstream_run: runId,
    session_id: null, fencing_generation: null, expected_version: 0,
    payload: {
      repo_key: repoId, canonical_root: repository, git_common_dir: join(repository, '.git'), autopilot_id: autopilotId, workstream,
      coordination_authority: 'coordinator-edit-leases-v1', run_resource: runResource,
      bootstrap_graph: {
        schema_version: 'autopilot.semantic_graph_bootstrap.v1', ref: bootstrapRef, sha256: sha256(bootstrapBytes), byte_count: Buffer.byteLength(bootstrapBytes, 'utf8'),
        git_commit: bootstrapCommit, covered_event_seq: 0, prospective_run: prospectiveRun, prospective_resource: runResource,
        trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
      },
    },
  };
  return { repoId, runId, request, repository };
}

void describe('D65 bootstrap attach-run crash-safe atomicity', () => {
  void it('replays the exact committed bootstrap effect and persists the B rows across store reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-graph-crash-'));
    const repository = join(root, 'repository');
    await mkdir(repository, { recursive: true });
    git(repository, ['init', '-b', 'main']);
    await writeFile(join(repository, 'README.md'), 'content-result\n', 'utf8');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'content-result']);
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);

    try {
      const fixture = await buildFixture(root, repository, 'ok');
      let committedPayload: string;
      const store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-19T00:00:00.000Z') });
      try {
        const effect = store.handle(fixture.request);
        assert.equal(effect.ok, true);
        committedPayload = canonicalJson(effect.payload);
        const { event_type, entity_type, entity_id, ...bare } = effect.payload as Record<string, unknown>;
        void event_type; void entity_type; void entity_id;
        const result = parseD65AttachRunResultV2(bare);
        assert.equal(result.bootstrap_artifact['artifact_id'], `semantic-graph-bootstrap:${fixture.runId}`);
      } finally { store.close(); }

      // Reopen the store (simulating recovery after a lost response) and prove
      // the exact effect replays byte-identically from durable idempotency.
      const reopened = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-19T00:01:00.000Z') });
      try {
        const replay = reopened.handle(fixture.request);
        assert.equal(replay.ok, true);
        assert.equal(canonicalJson(replay.payload), committedPayload, 'bootstrap replay must be byte-identical');
        // The B rows are durably present: repository, run, resource, mailbox, artifact.
        const database = new DatabaseSync(reopened.currentGeneration().database_path, { readOnly: true });
        try {
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repo_id=?').get(fixture.repoId)?.['count'], 1);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM runs WHERE repo_id=? AND workstream_run=?').get(fixture.repoId, fixture.runId)?.['count'], 1);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_resources WHERE repo_id=?').get(fixture.repoId)?.['count'], 1);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM mailbox_cursors WHERE repo_id=?').get(fixture.repoId)?.['count'], 1);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(fixture.repoId, `semantic-graph-bootstrap:${fixture.runId}`)?.['count'], 1);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND idempotency_key=?').get(fixture.repoId, fixture.request.idempotency_key ?? '')?.['count'], 1);
        } finally { database.close(); }
      } finally { reopened.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rolls back every row when the committed bootstrap digest is wrong and leaves no rows across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-graph-crash-bad-'));
    const repository = join(root, 'repository');
    await mkdir(repository, { recursive: true });
    git(repository, ['init', '-b', 'main']);
    await writeFile(join(repository, 'README.md'), 'content-result\n', 'utf8');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'content-result']);
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);

    try {
      const fixture = await buildFixture(root, repository, 'bad');
      const badRequest: CoordinatorRequestEnvelope = {
        ...fixture.request,
        payload: { ...fixture.request.payload, bootstrap_graph: { ...(fixture.request.payload['bootstrap_graph'] as Record<string, unknown>), sha256: `sha256:${'0'.repeat(64)}` } },
      };
      const store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-19T00:00:00.000Z') });
      try {
        const rejected = store.handle(badRequest);
        assert.equal(rejected.ok, false);
        assert.match(String((rejected.payload as Record<string, unknown>)['message']), /sha256 does not match the committed blob/u);
      } finally { store.close(); }

      const reopened = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-19T00:01:00.000Z') });
      try {
        const database = new DatabaseSync(reopened.currentGeneration().database_path, { readOnly: true });
        try {
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repo_id=?').get(fixture.repoId)?.['count'], 0);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM runs WHERE repo_id=?').get(fixture.repoId)?.['count'], 0);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_resources WHERE repo_id=?').get(fixture.repoId)?.['count'], 0);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM authoritative_artifacts WHERE repo_id=?').get(fixture.repoId)?.['count'], 0);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM events WHERE repo_id=?').get(fixture.repoId)?.['count'], 0);
        } finally { database.close(); }
      } finally { reopened.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  advanceD65GraphPublicationResidue,
  cleanupD65GraphPublicationResidue,
  createD65GraphPublicationResidue,
  d65GraphPublicationLockPath,
  d65GraphPublicationPending,
  d65GraphPublicationResiduePath,
  readD65GraphPublicationResidue,
} from '../../src/core/coordination/d65-graph-publication-residue.ts';

function residue(stage: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    schema_version: 'autopilot.graph_publication.v1', publication_id: 'pub-1', program_id: 'program-1',
    repo_id: 'repo-1', autopilot_id: 'auto-1', workstream_run: 'run-1', graph_sequence: 2, artifact_id: 'semantic-graph:00000000000000000002',
    stage, prior_authority_kind: 'bootstrap', prior_graph_sha256: `sha256:${'a'.repeat(64)}`, prior_publication_commit: null,
    prior_registration_event_seq: 1, authority_base_commit: 'b'.repeat(40), authority_path_count: 5, authority_path_manifest_sha256: `sha256:${'c'.repeat(64)}`,
    authority_commit: null, authority_tree: null, covered_event_seq: 5, publication_commit: null, publication_tree: null,
    graph_ref: null, graph_sha256: null, graph_byte_count: null, registration_event_seq: null,
    created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

void describe('D65 graph publication residue saga lifecycle', () => {
  void it('walks the four monotonic stages with crash-safe recovery re-reads and descriptor-safe cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-graph-residue-'));
    try {
      const mainWorktree = join(root, 'active', 'run-1', 'main');
      mkdirSync(mainWorktree, { recursive: true });

      // prepared
      createD65GraphPublicationResidue(mainWorktree, residue('prepared') as never);
      assert.equal(d65GraphPublicationPending(mainWorktree), true);
      // A second create rejects.
      assert.throws(() => createD65GraphPublicationResidue(mainWorktree, residue('prepared') as never), /already exists/u);

      // Simulate a crash: recover by re-reading the residue, then advance.
      assert.equal(readD65GraphPublicationResidue(mainWorktree)?.stage, 'prepared');
      // prepared -> authority-committed
      advanceD65GraphPublicationResidue(mainWorktree, residue('authority-committed', { authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40) }) as never);
      // Skipping a stage rejects (monotonic one-step).
      assert.throws(() => advanceD65GraphPublicationResidue(mainWorktree, residue('registered', { authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40), publication_commit: 'f'.repeat(40), publication_tree: '0'.repeat(40), graph_ref: 'semantic-graphs/00000000000000000002/graph.json', graph_sha256: `sha256:${'1'.repeat(64)}`, graph_byte_count: 4096, registration_event_seq: 6 }) as never), /must advance exactly one step/u);
      // Changing an immutable identity field across a stage rejects (transition CAS).
      assert.throws(() => advanceD65GraphPublicationResidue(mainWorktree, residue('publication-committed', { publication_id: 'pub-2', authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40), publication_commit: 'f'.repeat(40), publication_tree: '0'.repeat(40), graph_ref: 'semantic-graphs/00000000000000000002/graph.json', graph_sha256: `sha256:${'1'.repeat(64)}`, graph_byte_count: 4096 }) as never), /field publication_id changed outside the authority-committed->publication-committed transition CAS/u);
      // Transition-specific field CAS: re-mutating an EARLIER transition's field
      // (authority_commit, sealed by the prepared->authority-committed advance)
      // during authority-committed->publication-committed rejects.
      assert.throws(() => advanceD65GraphPublicationResidue(mainWorktree, residue('publication-committed', { authority_commit: '9'.repeat(40), authority_tree: 'e'.repeat(40), publication_commit: 'f'.repeat(40), publication_tree: '0'.repeat(40), graph_ref: 'semantic-graphs/00000000000000000002/graph.json', graph_sha256: `sha256:${'1'.repeat(64)}`, graph_byte_count: 4096 }) as never), /field authority_commit changed outside the authority-committed->publication-committed transition CAS/u);

      // authority-committed -> publication-committed
      advanceD65GraphPublicationResidue(mainWorktree, residue('publication-committed', { authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40), publication_commit: 'f'.repeat(40), publication_tree: '0'.repeat(40), graph_ref: 'semantic-graphs/00000000000000000002/graph.json', graph_sha256: `sha256:${'1'.repeat(64)}`, graph_byte_count: 4096 }) as never);
      // Cleanup before registered is terminal.
      assert.throws(() => cleanupD65GraphPublicationResidue(mainWorktree), /cleanup requires the registered stage/u);
      // publication-committed -> registered
      advanceD65GraphPublicationResidue(mainWorktree, residue('registered', { authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40), publication_commit: 'f'.repeat(40), publication_tree: '0'.repeat(40), graph_ref: 'semantic-graphs/00000000000000000002/graph.json', graph_sha256: `sha256:${'1'.repeat(64)}`, graph_byte_count: 4096, registration_event_seq: 6 }) as never);
      assert.equal(d65GraphPublicationPending(mainWorktree), false);

      // Descriptor-safe cleanup removes the residue and proves absence.
      cleanupD65GraphPublicationResidue(mainWorktree);
      assert.equal(readD65GraphPublicationResidue(mainWorktree), null);
      assert.equal(d65GraphPublicationPending(mainWorktree), false);
      void d65GraphPublicationResiduePath;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('proves durable-write persistence, one-step CAS, and the package-owned per-run publication lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-graph-residue-durable-'));
    try {
      const mainWorktree = join(root, 'active', 'run-1', 'main');
      mkdirSync(mainWorktree, { recursive: true });
      const residueFile = d65GraphPublicationResiduePath(mainWorktree);
      const lockFile = d65GraphPublicationLockPath(mainWorktree);

      // Create writes canonical JSON + trailing LF and the durable write
      // survives a fresh read (post-write verification is internal).
      createD65GraphPublicationResidue(mainWorktree, residue('prepared') as never);
      const onDisk = readFileSync(residueFile, 'utf8');
      assert.equal(onDisk.endsWith('\n'), true);
      assert.equal(onDisk, `${canonicalJson(readD65GraphPublicationResidue(mainWorktree))}\n`);
      // The lock file is released after every rewrite (no leaked lock).
      assert.equal(existsSync(lockFile), false);

      // A held lock fails closed: a pre-existing lock file blocks create/advance.
      writeFileSync(lockFile, `${String(process.pid)}\n`, { encoding: 'utf8', mode: 0o600 });
      assert.throws(() => advanceD65GraphPublicationResidue(mainWorktree, residue('authority-committed', { authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40) }) as never), /per-run graph publication lock is already held/u);
      rmSync(lockFile);

      // Skipping a stage still rejects even with the lock free.
      assert.throws(() => advanceD65GraphPublicationResidue(mainWorktree, residue('publication-committed', { authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40), publication_commit: 'f'.repeat(40), publication_tree: '0'.repeat(40), graph_ref: 'semantic-graphs/00000000000000000002/graph.json', graph_sha256: `sha256:${'1'.repeat(64)}`, graph_byte_count: 4096 }) as never), /must advance exactly one step/u);

      // prepared -> authority-committed may change only G/tree; changing covered
      // authority (covered_event_seq is sealed at creation) is outside the CAS.
      assert.throws(() => advanceD65GraphPublicationResidue(mainWorktree, residue('authority-committed', { authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40), covered_event_seq: 9 }) as never), /field covered_event_seq changed outside the prepared->authority-committed transition CAS/u);

      // A clean one-step advance succeeds and releases the lock.
      advanceD65GraphPublicationResidue(mainWorktree, residue('authority-committed', { authority_commit: 'd'.repeat(40), authority_tree: 'e'.repeat(40) }) as never);
      assert.equal(existsSync(lockFile), false);
      assert.equal(readD65GraphPublicationResidue(mainWorktree)?.stage, 'authority-committed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
