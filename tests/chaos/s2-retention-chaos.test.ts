import assert from 'node:assert/strict';
import { link, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { publishS2ColdTerminalProof } from '../../src/core/coordination/s2-retention-archive.ts';
import { runScheduledS2OwnedGc, type S2OwnedGcMarker } from '../../src/core/coordination/s2-owned-gc.ts';
import { defineS2RetentionPolicy, S2_RETENTION_OWNER_MARKER, S2_RETENTION_TRASH_DIR, type S2RetentionGcKind, type S2RetentionPolicy } from '../../src/core/coordination/s2-retention-policy.ts';

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('expected at least one result');
  return value;
}

async function tempRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${label}-`));
}

async function createOwnedCandidate(input: { readonly root: string; readonly candidatePath: string; readonly repoId: string; readonly ownerRun: string; readonly candidateId: string; readonly kind: S2RetentionGcKind; readonly policy: S2RetentionPolicy; readonly terminalEventSeq: number; readonly markerOwnerRun?: string; readonly markerCandidateId?: string }): Promise<void> {
  const archiveRoot = join(input.root, 'cold');
  const published = await publishS2ColdTerminalProof({ repoId: input.repoId, workstreamRun: input.ownerRun, terminalEventSeq: input.terminalEventSeq, terminalKind: 'closed', terminalProof: { terminal: true, candidate: input.candidateId }, archiveRoot, hotRoot: join(input.root, 'hot'), policy: input.policy, nowIso: '2026-07-22T00:00:00.000Z' });
  const marker: S2OwnedGcMarker = { schema_version: 'autopilot.s2_retention.owner.v1', created_by: 'autopilot-s2-retention', repo_id: input.repoId, owner_run: input.markerOwnerRun ?? input.ownerRun, candidate_id: input.markerCandidateId ?? input.candidateId, kind: input.kind, policy_id: input.policy.policy_id, terminal_event_seq: input.terminalEventSeq, terminal_kind: 'closed', cold_archive_sha256: published.coldArchiveSha256, cold_archive_relpath: published.coldArchiveRelpath, cold_archive_verified: true, active: false, dirty: false, quarantined: false, sole_copy_pin: false };
  await mkdir(input.candidatePath, { recursive: true });
  await writeFile(join(input.candidatePath, S2_RETENTION_OWNER_MARKER), canonicalJson(marker), { flag: 'wx', mode: 0o600 });
}

function gcInput(root: string, policy: S2RetentionPolicy, operationId: string, candidateIds?: readonly string[]) {
  return { retentionRoot: root, coldArchiveRoot: join(root, 'cold'), repoId: 'repo-chaos', ownerRun: 'run-chaos', policy, nowIso: '2026-07-22T00:00:08.000Z', operationId, ...(candidateIds === undefined ? {} : { candidateIds }) };
}

void describe('S2-E owned GC chaos refusals', () => {
  void it('checks operation-id containment before creating inflight directories', async () => {
    const root = await tempRoot('s2-retention-chaos-operation-escape');
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    await assert.rejects(() => runScheduledS2OwnedGc(gcInput(root, policy, '../../outside-created', [])), /path-escape/u);
    await assert.rejects(() => stat(join(root, '..', 'outside-created')));
  });

  void it('refuses foreign owner ambiguous marker hardlink symlink and explicit path escape cases', async () => {
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    const cases = [
      { candidateId: 'foreign-owned', reason: 'foreign-owner' },
      { candidateId: 'ambiguous-owned', reason: 'ambiguous-owner' },
      { candidateId: 'hardlink-owned', reason: 'hardlink-detected' },
      { candidateId: 'symlink-owned', reason: 'symlink-detected' },
      { candidateId: '../escape-owned', reason: 'path-escape' },
    ] as const;

    for (const entry of cases) {
      const root = await tempRoot(`s2-retention-chaos-${entry.reason}`);
      const candidatePath = join(root, S2_RETENTION_TRASH_DIR, entry.candidateId);
      if (entry.reason === 'path-escape') {
        const cycle = await runScheduledS2OwnedGc(gcInput(root, policy, `op-${entry.reason}`, [entry.candidateId]));
        assert.equal(first(cycle.results).refusalReason, entry.reason);
        continue;
      }
      if (entry.reason === 'symlink-detected') {
        await mkdir(join(root, S2_RETENTION_TRASH_DIR), { recursive: true });
        const outside = join(root, 'outside-owned');
        await mkdir(outside);
        await symlink(outside, candidatePath);
      } else {
        const ownerRun = entry.reason === 'foreign-owner' ? 'other-run' : 'run-chaos';
        await createOwnedCandidate({ root, candidatePath, repoId: 'repo-chaos', ownerRun: 'run-chaos', markerOwnerRun: ownerRun, candidateId: entry.candidateId, kind: 'trash', policy, terminalEventSeq: 31 });
        if (entry.reason === 'ambiguous-owner') {
          const nested = join(candidatePath, 'nested');
          await mkdir(nested, { recursive: true });
          await writeFile(join(nested, S2_RETENTION_OWNER_MARKER), await readFile(join(candidatePath, S2_RETENTION_OWNER_MARKER), 'utf8'), { flag: 'wx', mode: 0o600 });
        }
        if (entry.reason === 'hardlink-detected') {
          const source = join(candidatePath, 'payload');
          await writeFile(source, 'payload', 'utf8');
          await link(source, join(candidatePath, 'payload-hardlink'));
        }
      }
      const cycle = await runScheduledS2OwnedGc(gcInput(root, policy, `op-${entry.reason}`, [entry.candidateId]));
      const result = first(cycle.results);
      assert.equal(result.outcome, 'refused');
      assert.equal(result.refusalReason, entry.reason);
      assert.equal((await stat(join(root, S2_RETENTION_TRASH_DIR))).isDirectory(), true);
    }
  });
});
