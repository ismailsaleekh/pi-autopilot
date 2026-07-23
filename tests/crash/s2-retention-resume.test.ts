import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { discardInterruptedS2ColdArchiveTemps, publishS2ColdTerminalProof, recoverS2ColdTerminalProofPublication } from '../../src/core/coordination/s2-retention-archive.ts';
import { runScheduledS2OwnedGc, type S2OwnedGcMarker, type S2ScheduledOwnedGcInput } from '../../src/core/coordination/s2-owned-gc.ts';
import { defineS2RetentionPolicy, S2_RETENTION_INFLIGHT_DIR, S2_RETENTION_OWNER_MARKER, S2_RETENTION_TRASH_DIR, type S2RetentionGcKind, type S2RetentionPolicy } from '../../src/core/coordination/s2-retention-policy.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';

async function tempRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${label}-`));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let poll = 0; poll < 1_000; poll += 1) {
    if (await exists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function hardKillAtBoundary(script: string, cwd: string, boundary: string): Promise<void> {
  const marker = join(cwd, `${boundary}.marker`);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: { ...process.env, AUTOPILOT_S2_RETENTION_TEST_BOUNDARY: boundary, AUTOPILOT_S2_RETENTION_TEST_MARKER: marker },
  });
  const childExit = new Promise((resolve) => child.once('close', resolve));
  await waitForFile(marker);
  try { hardKillProcess(child); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  await childExit;
}

async function createOwnedCandidate(input: { readonly root: string; readonly candidatePath: string; readonly repoId: string; readonly ownerRun: string; readonly candidateId: string; readonly kind: S2RetentionGcKind; readonly policy: S2RetentionPolicy; readonly terminalEventSeq: number }): Promise<void> {
  const archiveRoot = join(input.root, 'cold');
  const published = await publishS2ColdTerminalProof({ repoId: input.repoId, workstreamRun: input.ownerRun, terminalEventSeq: input.terminalEventSeq, terminalKind: 'closed', terminalProof: { terminal: true, candidate: input.candidateId }, archiveRoot, hotRoot: join(input.root, 'hot'), policy: input.policy, nowIso: '2026-07-22T00:00:00.000Z' });
  const marker: S2OwnedGcMarker = { schema_version: 'autopilot.s2_retention.owner.v1', created_by: 'autopilot-s2-retention', repo_id: input.repoId, owner_run: input.ownerRun, candidate_id: input.candidateId, kind: input.kind, policy_id: input.policy.policy_id, terminal_event_seq: input.terminalEventSeq, terminal_kind: 'closed', cold_archive_sha256: published.coldArchiveSha256, cold_archive_relpath: published.coldArchiveRelpath, cold_archive_verified: true, active: false, dirty: false, quarantined: false, sole_copy_pin: false };
  await mkdir(input.candidatePath, { recursive: true });
  await writeFile(join(input.candidatePath, S2_RETENTION_OWNER_MARKER), canonicalJson(marker), { flag: 'wx', mode: 0o600 });
}

function gcInput(root: string, repoId: string, ownerRun: string, policy: S2RetentionPolicy, nowIso: string, operationId: string, candidateIds?: readonly string[]): S2ScheduledOwnedGcInput {
  return { retentionRoot: root, coldArchiveRoot: join(root, 'cold'), repoId, ownerRun, policy, nowIso, operationId, ...(candidateIds === undefined ? {} : { candidateIds }) };
}

void describe('S2-E retention crash replay', () => {
  void it('replays cold proof publication after interruption and discards only archive temp files', async () => {
    const root = await tempRoot('s2-retention-crash-archive');
    const policy = defineS2RetentionPolicy();
    const input = {
      repoId: 'repo-crash',
      workstreamRun: 'run-crash',
      terminalEventSeq: 13,
      terminalKind: 'aborted' as const,
      terminalProof: { terminal: true, receipt: 'retained' },
      archiveRoot: join(root, 'cold'),
      hotRoot: join(root, 'hot'),
      policy,
      nowIso: '2026-07-22T00:00:04.000Z',
    };

    const published = await publishS2ColdTerminalProof(input);
    await writeFile(join(root, 'cold', 'terminal-proofs', 'interrupted.tmp'), 'partial', 'utf8');
    const removedTemps = await discardInterruptedS2ColdArchiveTemps(join(root, 'cold'));
    assert.equal(removedTemps.length, 1);
    await recoverS2ColdTerminalProofPublication(input);
    assert.equal((await stat(published.coldArchivePath)).isFile(), true);
    assert.equal((await stat(published.hotSummaryPath)).isFile(), true);
  });

  void it('hard-kills real archive publication at write fsync rename and hot-summary boundaries then restart verifies cold eligibility', async () => {
    for (const boundary of ['s2-cold-archive-after-write', 's2-cold-archive-after-fsync', 's2-cold-archive-after-rename', 's2-hot-summary-after-write', 's2-hot-summary-after-fsync', 's2-hot-summary-after-rename'] as const) {
      const root = await tempRoot(`s2-retention-hardkill-${boundary}`);
      const policy = defineS2RetentionPolicy();
      const input = { repoId: 'repo-crash-archive', workstreamRun: `run-${boundary}`, terminalEventSeq: 30, terminalKind: 'closed' as const, terminalProof: { terminal: true, boundary }, archiveRoot: join(root, 'cold'), hotRoot: join(root, 'hot'), policy, nowIso: '2026-07-22T00:00:04.000Z' };
      await hardKillAtBoundary(`import { publishS2ColdTerminalProof } from './src/core/coordination/s2-retention-archive.ts'; const input = ${JSON.stringify(input)}; await publishS2ColdTerminalProof(input);`, root, boundary);
      await discardInterruptedS2ColdArchiveTemps(join(root, 'cold'));
      const recovered = await recoverS2ColdTerminalProofPublication(input);
      assert.equal((await stat(recovered.coldArchivePath)).isFile(), true);
      assert.equal((await stat(recovered.hotSummaryPath)).isFile(), true);
    }
  });

  void it('refuses an unledgered inflight directory on restart and preserves its bytes', async () => {
    const root = await tempRoot('s2-retention-crash-unledgered-gc');
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    const candidateId = 'trash-unledgered-replay';
    const originalPath = join(root, S2_RETENTION_TRASH_DIR, candidateId);
    await createOwnedCandidate({ root, candidatePath: originalPath, repoId: 'repo-crash-gc', ownerRun: 'run-crash-gc', candidateId, kind: 'trash', policy, terminalEventSeq: 20 });
    const inflightPath = join(root, S2_RETENTION_INFLIGHT_DIR, 'interrupted-unledgered-op', `trash-${candidateId}`);
    await mkdir(join(root, S2_RETENTION_INFLIGHT_DIR, 'interrupted-unledgered-op'), { recursive: true });
    await rename(originalPath, inflightPath);

    const replay = await runScheduledS2OwnedGc(gcInput(root, 'repo-crash-gc', 'run-crash-gc', policy, '2026-07-22T00:00:05.500Z', 'restart-unledgered-op', []));
    assert.equal(replay.refused, 1);
    assert.equal(replay.results[0]?.refusalReason, 'missing-without-ledger');
    assert.equal((await stat(inflightPath)).isDirectory(), true);
  });

  void it('hard-kills real GC at ledger append fsync rename and rm boundaries with restart-safe replay', async () => {
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    for (const boundary of ['s2-ledger-after-candidate-verified-write', 's2-ledger-after-candidate-verified-fsync', 's2-gc-after-rename', 's2-ledger-after-candidate-renamed-write', 's2-ledger-after-candidate-renamed-fsync', 's2-ledger-after-candidate-removed-write', 's2-ledger-after-candidate-removed-fsync', 's2-gc-before-rm-after-authoritative-ledger', 's2-gc-after-rm'] as const) {
      const root = await tempRoot(`s2-retention-hardkill-gc-${boundary}`);
      const candidateId = `trash-${boundary.replace(/[^a-z0-9]+/gu, '-')}`;
      const originalPath = join(root, S2_RETENTION_TRASH_DIR, candidateId);
      await createOwnedCandidate({ root, candidatePath: originalPath, repoId: 'repo-crash-gc-boundary', ownerRun: 'run-crash-gc-boundary', candidateId, kind: 'trash', policy, terminalEventSeq: 70 });
      const input = gcInput(root, 'repo-crash-gc-boundary', 'run-crash-gc-boundary', policy, '2026-07-22T00:00:07.000Z', `op-${candidateId}`, [candidateId]);
      await hardKillAtBoundary(`import { runScheduledS2OwnedGc } from './src/core/coordination/s2-owned-gc.ts'; await runScheduledS2OwnedGc(${JSON.stringify(input)});`, root, boundary);
      const replay = await runScheduledS2OwnedGc(gcInput(root, 'repo-crash-gc-boundary', 'run-crash-gc-boundary', policy, '2026-07-22T00:00:08.000Z', `restart-${candidateId}`, [candidateId]));
      assert.equal(await exists(originalPath), false, boundary);
      if (boundary === 's2-gc-after-rename') {
        assert.equal(replay.refused >= 1, true, boundary);
        assert.equal(await exists(join(root, S2_RETENTION_INFLIGHT_DIR, `op-${candidateId}`, `trash-${candidateId}`)), true, boundary);
      } else assert.equal(replay.removed + replay.replayed + replay.duplicates >= 1, true, boundary);
    }
  });

  void it('hard-kills a real GC process after rename and restart replays the descriptor-verified inflight removal', async () => {
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    let replayed = false;
    for (let attempt = 0; attempt < 5 && !replayed; attempt += 1) {
      const root = await tempRoot('s2-retention-hardkill-gc');
      const candidateId = `trash-hardkill-${attempt}`;
      const operationId = `interrupted-op-${attempt}`;
      const originalPath = join(root, S2_RETENTION_TRASH_DIR, candidateId);
      await createOwnedCandidate({ root, candidatePath: originalPath, repoId: 'repo-crash-gc', ownerRun: 'run-crash-gc', candidateId, kind: 'trash', policy, terminalEventSeq: 21 + attempt });
      for (let index = 0; index < 4_000; index += 1) await writeFile(join(originalPath, `payload-${index}.txt`), 'payload', 'utf8');
      const input = gcInput(root, 'repo-crash-gc', 'run-crash-gc', policy, '2026-07-22T00:00:05.000Z', operationId, [candidateId]);
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import { runScheduledS2OwnedGc } from './src/core/coordination/s2-owned-gc.ts'; await runScheduledS2OwnedGc(${JSON.stringify(input)});`], { cwd: process.cwd(), stdio: 'ignore' });
      const childExit = new Promise((resolve) => child.once('close', resolve));
      const ledgerPath = join(root, '_retention-ledger.ndjson');
      const inflightPath = join(root, S2_RETENTION_INFLIGHT_DIR, operationId, `trash-${candidateId}`);
      for (let poll = 0; poll < 1_000; poll += 1) {
        if (await exists(ledgerPath)) {
          const ledger = await readFile(ledgerPath, 'utf8');
          if (ledger.includes('candidate-renamed')) {
            hardKillProcess(child);
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await childExit;
      if (!await exists(inflightPath)) continue;
      const replay = await runScheduledS2OwnedGc(gcInput(root, 'repo-crash-gc', 'run-crash-gc', policy, '2026-07-22T00:00:06.000Z', 'restart-op', []));
      assert.equal(replay.replayed, 1);
      await assert.rejects(() => stat(inflightPath));
      await assert.rejects(() => stat(originalPath));
      replayed = true;
    }
    assert.equal(replayed, true);
  });
});
