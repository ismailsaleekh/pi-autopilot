import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { coordinatorRuntimePaths, windowsPrivateAclCommand } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore, stageCoordinatorSemanticReplay, stageCoordinatorSemanticReplayFile, type CoordinatorSemanticReplayRecord } from '../../src/core/coordination/store.ts';
import { readCurrentStoreGeneration } from '../../src/core/coordination/store-generation.ts';
import type { CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

const clock = { now: (): Date => new Date('2026-07-13T01:00:00.000Z') };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value !== 'object') throw new Error('non-JSON test value');
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function attachRun(stateRoot: string, suffix = 'primary'): CoordinatorRequestEnvelope {
  const repoId = 'semantic-replay-repo';
  const run = `semantic-replay-run-${suffix}`;
  const source = join(stateRoot, 'repository');
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: `semantic-replay-attach-request-${suffix}`,
    action: 'attach-run', idempotency_key: `semantic-replay-attach-${suffix}`, repo_id: repoId, workstream_run: run,
    session_id: null, fencing_generation: null, expected_version: 0,
    payload: {
      repo_key: repoId, canonical_root: source, git_common_dir: join(source, '.git'), autopilot_id: `semantic-replay-autopilot-${suffix}`,
      workstream: `semantic-replay-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1',
      run_resource: {
        schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: run,
        source_repo: source, git_common_dir: join(source, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId),
        main_worktree_path: join(stateRoot, 'worktrees', repoId, 'active', run, 'main'), runtime_root: join(stateRoot, 'worktrees', repoId, 'active', run, 'main', '.pi', 'autopilot', `semantic-replay-${suffix}`),
        branch: `autopilot/${run}`, target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null,
        started_at: '2026-07-13T00:00:00.000Z', version: 1,
      },
    },
  };
}

async function withRoot(run: (input: { readonly root: string; readonly stateRoot: string; readonly env: ProcessEnvLike; readonly paths: ReturnType<typeof coordinatorRuntimePaths> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-semantic-replay-'));
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
  try { await run({ root, stateRoot, env, paths: coordinatorRuntimePaths(env) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function rewriteCorpusRecord(path: string, recordIndex: number, replacement: string): Promise<void> {
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  assert.ok(lines.length > recordIndex + 1);
  lines[recordIndex + 1] = replacement;
  const parsedHeader = JSON.parse(lines[0] ?? '') as Readonly<Record<string, unknown>>;
  const body = `${lines.slice(1).join('\n')}\n`;
  lines[0] = canonicalJson({ ...parsedHeader, record_count: lines.length - 1, records_sha256: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}` });
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

function eventCount(paths: ReturnType<typeof coordinatorRuntimePaths>): number {
  const generation = readCurrentStoreGeneration(paths);
  const database = new DatabaseSync(generation?.database_path ?? paths.databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM events').get() as Readonly<Record<string, unknown>>;
    if (typeof row['count'] !== 'number') throw new Error('event count is not numeric');
    return row['count'];
  } finally { database.close(); }
}

void describe('production semantic replay startup recovery', () => {
  void it('orders mocked Windows root hardening before staging opens and explicitly secures every published file name', async () => {
    const source = await readFile(new URL('../../src/core/coordination/store.ts', import.meta.url), 'utf8');
    const rootHardening = source.indexOf('await ensureCoordinatorPrivateRoots(paths);');
    const bodyOpen = source.indexOf("body = await openFile(bodyPath, 'wx', 0o600);");
    const bodyAcl = source.indexOf('await enforcePrivateAuthorityPath(bodyPath, false);', bodyOpen);
    const candidateOpen = source.indexOf("candidate = await openFile(candidatePath, 'wx', 0o600);");
    const candidateAcl = source.indexOf('await enforcePrivateAuthorityPath(candidatePath, false);', candidateOpen);
    const finalLink = source.indexOf('await link(candidatePath, paths.semanticReplayPath);');
    const finalAcl = source.indexOf('await enforcePrivateAuthorityPath(paths.semanticReplayPath, false);', finalLink);
    assert.equal([rootHardening, bodyOpen, bodyAcl, candidateOpen, candidateAcl, finalLink, finalAcl].every((entry) => entry >= 0), true);
    assert.deepEqual([...new Set([rootHardening, bodyOpen, bodyAcl, candidateOpen, candidateAcl, finalLink, finalAcl])].sort((left, right) => left - right), [rootHardening, bodyOpen, bodyAcl, candidateOpen, candidateAcl, finalLink, finalAcl]);

    const invoked: string[] = [];
    const mockWindowsAcl = (path: string, directory: boolean): void => { invoked.push(windowsPrivateAclCommand(path, directory, { USERDOMAIN: 'TEST', USERNAME: 'operator' }).args[5] ?? ''); };
    mockWindowsAcl('C:\\permissive-override', true);
    mockWindowsAcl('C:\\permissive-override\\coordinator\\semantic-replay.body', false);
    mockWindowsAcl('C:\\permissive-override\\coordinator\\semantic-replay.candidate', false);
    mockWindowsAcl('C:\\permissive-override\\coordinator\\semantic-replay.jsonl', false);
    assert.match(invoked[0] ?? '', /DirectorySecurity.*CreateDirectory/u);
    assert.equal(invoked.slice(1).every((command) => /D:P\(A;;FA;;;\$sid\)/u.test(command) && /SetAccessControl/u.test(command)), true);
  });

  void it('fails closed on malformed, duplicate-key, and closed-schema violations even with a matching digest', async () => {
    const request = attachRun('/tmp/semantic-replay-malformed');
    for (const malformed of [
      canonicalJson({ ...request, unexpected: 'not-closed' }),
      canonicalJson(request).replace('"action":"attach-run"', '"action":"heartbeat","action":"attach-run"'),
      canonicalJson({ ...request, protocol_version: '0.0' }),
    ]) {
      await withRoot(async ({ stateRoot, paths }) => {
        await stageCoordinatorSemanticReplay(paths, 'malformed-corpus', [attachRun(stateRoot), attachRun(stateRoot, 'second')]);
        await rewriteCorpusRecord(paths.semanticReplayPath, 1, malformed);
        await assert.rejects(() => CoordinatorStore.open(paths, clock), /canonical JSON|valid coordinator request|current coordinator protocol/u);
        assert.equal(eventCount(paths), 0, 'a malformed corpus must not reduce its valid prefix');
        assert.equal(existsSync(paths.semanticReplayPath), true, 'a rejected corpus remains for operator recovery');
      });
    }
  });

  void it('offers no trusted or test-only bypass around production batch validation', async () => {
    await withRoot(async ({ stateRoot, paths }) => {
      const store = await CoordinatorStore.open(paths, clock);
      try {
        const malformed = Object.assign({}, attachRun(stateRoot), { unexpected: 'closed-schema-violation' });
        assert.throws(() => store.replaySemanticEventBatch([malformed]), /not a valid coordinator request/u);
        const runs = store.status('semantic-replay-repo', null).payload['runs'];
        assert.equal(Array.isArray(runs) ? runs.length : -1, 0);
      } finally { store.close(); }
      assert.equal(eventCount(paths), 0);
    });
  });

  void it('enforces a streaming per-record bound before parsing oversized input', async () => {
    await withRoot(async ({ stateRoot, paths }) => {
      await stageCoordinatorSemanticReplay(paths, 'oversized-record', [attachRun(stateRoot)]);
      const lines = (await readFile(paths.semanticReplayPath, 'utf8')).trimEnd().split('\n');
      const header = JSON.parse(lines[0] ?? '') as Readonly<Record<string, unknown>>;
      const oversized = `{"payload":"${'x'.repeat(1024 * 1024)}"}`;
      const body = `${oversized}\n`;
      lines[0] = canonicalJson({ ...header, record_count: 1, records_sha256: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}` });
      await writeFile(paths.semanticReplayPath, `${lines[0]}\n${body}`, 'utf8');
      await assert.rejects(() => CoordinatorStore.open(paths, clock), /per-record byte bound/u);
      assert.equal(eventCount(paths), 0);
    });
  });

  void it('rejects manifest digest drift before reducing events', async () => {
    await withRoot(async ({ stateRoot, paths }) => {
      await stageCoordinatorSemanticReplay(paths, 'digest-drift', [attachRun(stateRoot)]);
      const lines = (await readFile(paths.semanticReplayPath, 'utf8')).trimEnd().split('\n');
      const header = JSON.parse(lines[0] ?? '') as Readonly<Record<string, unknown>>;
      lines[0] = canonicalJson({ ...header, records_sha256: `sha256:${'f'.repeat(64)}` });
      await writeFile(paths.semanticReplayPath, `${lines.join('\n')}\n`, 'utf8');
      await assert.rejects(() => CoordinatorStore.open(paths, clock), /count or digest does not match/u);
      assert.equal(eventCount(paths), 0);
    });
  });

  void it('consumes an operator JSONL file through the shipped staging API and production startup path', async () => {
    await withRoot(async ({ root, stateRoot, paths }) => {
      const inputPath = join(root, 'operator-recovery.jsonl');
      await writeFile(inputPath, `${canonicalJson(attachRun(stateRoot))}\n`, { encoding: 'utf8', mode: 0o600 });
      const staged = await stageCoordinatorSemanticReplayFile(paths, 'operator-runtime-consumption', inputPath);
      assert.equal(staged.record_count, 1);
      const recovered = await CoordinatorStore.open(paths, clock);
      try {
        const runs = recovered.status('semantic-replay-repo', 'semantic-replay-run-primary').payload['runs'];
        assert.equal(Array.isArray(runs) ? runs.length : -1, 1);
        assert.equal(recovered.integrity(), 'ok');
      } finally { recovered.close(); }
      assert.equal(eventCount(paths), 1);
      assert.equal(existsSync(paths.semanticReplayPath), false);
      assert.equal(existsSync(join(paths.semanticReplayReceiptsRoot, 'operator-runtime-consumption.json')), true);
    });
  });

  void it('commits the complete validated corpus and DB completion atomically, then projects one derived receipt', async () => {
    await withRoot(async ({ stateRoot, paths }) => {
      const records: readonly CoordinatorSemanticReplayRecord[] = [attachRun(stateRoot), attachRun(stateRoot, 'second')];
      await stageCoordinatorSemanticReplay(paths, 'atomic-complete', records);
      const recovered = await CoordinatorStore.open(paths, clock);
      recovered.close();
      assert.equal(eventCount(paths), 2);
      assert.equal(existsSync(paths.semanticReplayPath), false);
      const receiptPath = join(paths.semanticReplayReceiptsRoot, 'atomic-complete.json');
      const receiptBefore = await readFile(receiptPath, 'utf8');
      const receiptMetadata = await lstat(receiptPath);
      assert.equal(receiptMetadata.isFile(), true);
      assert.equal(receiptMetadata.isSymbolicLink(), false);
      assert.equal(receiptBefore.trimEnd().split('\n').length, 1);

      await stageCoordinatorSemanticReplay(paths, 'atomic-complete', records);
      const replayed = await CoordinatorStore.open(paths, { now: () => new Date('2099-01-01T00:00:00.000Z') });
      replayed.close();
      assert.equal(eventCount(paths), 2);
      assert.equal(await readFile(receiptPath, 'utf8'), receiptBefore, 'DB completion deterministically re-projects the same receipt');
      assert.equal(existsSync(paths.semanticReplayPath), false);
    });
  });

  void it('never lets a stale filesystem receipt suppress replay after a database restore', async () => {
    await withRoot(async ({ root, stateRoot, paths }) => {
      const baseline = await CoordinatorStore.open(paths, clock);
      const baselinePath = join(root, 'baseline.db');
      const baselineBackup = await baseline.createVerifiedBackup(baselinePath);
      baseline.close();
      const records = [attachRun(stateRoot)] as const;
      await stageCoordinatorSemanticReplay(paths, 'restore-replay', records);
      const first = await CoordinatorStore.open(paths, clock);
      first.close();
      assert.equal(eventCount(paths), 1);
      assert.equal(existsSync(join(paths.semanticReplayReceiptsRoot, 'restore-replay.json')), true);

      await CoordinatorStore.restoreGeneration(paths, baselinePath, baselineBackup.sha256, clock);
      await stageCoordinatorSemanticReplay(paths, 'restore-replay', records);
      const restored = await CoordinatorStore.open(paths, clock);
      restored.close();
      assert.equal(eventCount(paths), 1, 'missing DB completion must force semantic replay despite a stale receipt');
      assert.equal(existsSync(paths.semanticReplayPath), false);
    });
  });

  void it('rejects symlinked replay ancestors and non-regular inbox files', async () => {
    await withRoot(async ({ root, paths }) => {
      await mkdir(paths.coordinatorRoot, { recursive: true });
      const outside = join(root, 'outside-receipts');
      await mkdir(outside);
      await symlink(outside, paths.semanticReplayReceiptsRoot, platform() === 'win32' ? 'junction' : 'dir');
      await assert.rejects(() => stageCoordinatorSemanticReplay(paths, 'symlinked-receipts', [attachRun(paths.stateRoot)]), /real directory|symlink or junction|symbolic-link/u);
    });
    await withRoot(async ({ root, paths }) => {
      const baseline = await CoordinatorStore.open(paths, clock);
      baseline.close();
      const target = join(root, 'outside-inbox.jsonl');
      await writeFile(target, '{}\n', 'utf8');
      await symlink(target, paths.semanticReplayPath, platform() === 'win32' ? 'file' : 'file');
      await assert.rejects(() => CoordinatorStore.open(paths, clock));
      assert.equal(eventCount(paths), 0);
    });
  });

  void it('rejects reuse of a durable replay id with a different digest', async () => {
    await withRoot(async ({ stateRoot, paths }) => {
      await stageCoordinatorSemanticReplay(paths, 'stable-replay-id', [attachRun(stateRoot)]);
      const first = await CoordinatorStore.open(paths, clock);
      first.close();
      await stageCoordinatorSemanticReplay(paths, 'stable-replay-id', [attachRun(stateRoot), attachRun(stateRoot, 'different-corpus')]);
      await assert.rejects(() => CoordinatorStore.open(paths, clock), /reused with a different corpus identity/u);
      assert.equal(eventCount(paths), 1);
      assert.equal(existsSync(paths.semanticReplayPath), true);
    });
  });
});
