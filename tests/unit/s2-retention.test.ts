import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { describe, it } from 'node:test';

import { publishS2ColdTerminalProof, readS2HotTerminalProofSummary, verifyS2ColdTerminalProof } from '../../src/core/coordination/s2-retention-archive.ts';
import { runScheduledS2OwnedGc, type S2OwnedGcMarker } from '../../src/core/coordination/s2-owned-gc.ts';
import { defineS2RetentionPolicy, S2_RETENTION_OWNER_MARKER, S2_RETENTION_TRANSITION_BACKUP_DIR, S2_RETENTION_TRASH_DIR, type S2RetentionGcKind, type S2RetentionPolicy } from '../../src/core/coordination/s2-retention-policy.ts';

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('expected at least one result');
  return value;
}

async function tempRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${label}-`));
}

async function createOwnedCandidate(input: {
  readonly root: string;
  readonly candidatePath: string;
  readonly repoId: string;
  readonly ownerRun: string;
  readonly candidateId: string;
  readonly kind: S2RetentionGcKind;
  readonly policy: S2RetentionPolicy;
  readonly terminalEventSeq: number;
  readonly active?: boolean;
  readonly dirty?: boolean;
  readonly quarantined?: boolean;
  readonly soleCopyPin?: boolean;
  readonly coldArchiveVerified?: boolean;
  readonly markerOwnerRun?: string;
  readonly markerCandidateId?: string;
  readonly markerKind?: S2RetentionGcKind;
  readonly markerPolicy?: S2RetentionPolicy;
}): Promise<void> {
  const archiveRoot = join(input.root, 'cold');
  const published = await publishS2ColdTerminalProof({
    repoId: input.repoId,
    workstreamRun: input.ownerRun,
    terminalEventSeq: input.terminalEventSeq,
    terminalKind: 'closed',
    terminalProof: { terminal: true, candidate: input.candidateId },
    archiveRoot,
    hotRoot: join(input.root, 'hot'),
    policy: input.policy,
    nowIso: '2026-07-22T00:00:00.000Z',
  });
  const marker: S2OwnedGcMarker = {
    schema_version: 'autopilot.s2_retention.owner.v1',
    created_by: 'autopilot-s2-retention',
    repo_id: input.repoId,
    owner_run: input.markerOwnerRun ?? input.ownerRun,
    candidate_id: input.markerCandidateId ?? input.candidateId,
    kind: input.markerKind ?? input.kind,
    policy_id: (input.markerPolicy ?? input.policy).policy_id,
    terminal_event_seq: input.terminalEventSeq,
    terminal_kind: 'closed',
    cold_archive_sha256: published.coldArchiveSha256,
    cold_archive_relpath: published.coldArchiveRelpath,
    cold_archive_verified: input.coldArchiveVerified ?? true,
    active: input.active ?? false,
    dirty: input.dirty ?? false,
    quarantined: input.quarantined ?? false,
    sole_copy_pin: input.soleCopyPin ?? false,
  };
  await mkdir(input.candidatePath, { recursive: true });
  await writeFile(join(input.candidatePath, S2_RETENTION_OWNER_MARKER), canonicalJson(marker), { flag: 'wx', mode: 0o600 });
}

function gcInput(root: string, repoId: string, ownerRun: string, policy: S2RetentionPolicy, nowIso: string, operationId: string, candidateIds?: readonly string[]) {
  return { retentionRoot: root, coldArchiveRoot: join(root, 'cold'), repoId, ownerRun, policy, nowIso, operationId, ...(candidateIds === undefined ? {} : { candidateIds }) };
}

void describe('S2-E retention archive and owned GC core', () => {
  void it('publishes deterministic hashed cold terminal proof before hot eligibility and retains only a minimal hot summary', async () => {
    const root = await tempRoot('s2-retention-archive');
    const policy = defineS2RetentionPolicy();
    const input = {
      repoId: 'repo-retention',
      workstreamRun: 'run-terminal',
      terminalEventSeq: 7,
      terminalKind: 'closed' as const,
      terminalProof: { terminal: true, accepted_units: ['u1', 'u2'], large_evidence: 'x'.repeat(8_000) },
      archiveRoot: join(root, 'cold'),
      hotRoot: join(root, 'hot'),
      policy,
      nowIso: '2026-07-22T00:00:00.000Z',
    };

    const published = await publishS2ColdTerminalProof(input);
    const repeated = await publishS2ColdTerminalProof(input);
    assert.equal(repeated.coldArchivePath, published.coldArchivePath);
    assert.equal(repeated.coldArchiveSha256, published.coldArchiveSha256);
    assert.equal(published.coldArchiveVerified, true);
    assert.equal(published.hotEligible, true);

    const summaryText = await readFile(published.hotSummaryPath, 'utf8');
    assert.equal(summaryText.includes('large_evidence'), false);
    assert.equal(summaryText.includes('accepted_units'), false);
    const coldSize = (await stat(published.coldArchivePath)).size;
    assert.ok(published.hotSummaryBytes < coldSize);
    assert.ok(published.hotSummaryBytes <= policy.hot_terminal_summary_max_bytes);

    const summary = await readS2HotTerminalProofSummary({ path: published.hotSummaryPath, policy });
    assert.equal(summary.cold_archive_sha256, published.coldArchiveSha256);
    assert.equal(summary.terminal_proof_sha256, published.terminalProofSha256);
    const replayedOnDifferentClock = await publishS2ColdTerminalProof({ ...input, nowIso: '2026-07-23T00:00:00.000Z' });
    assert.equal(replayedOnDifferentClock.coldArchiveSha256, published.coldArchiveSha256);
    await assert.rejects(() => publishS2ColdTerminalProof({ ...input, terminalProof: { terminal: true, accepted_units: ['u1'], large_evidence: 'changed' } }), /already binds a different verified cold archive/u);
  });

  void it('removes only scheduled owned trash and records duplicate GC as ledger evidence instead of deleting again', async () => {
    const root = await tempRoot('s2-owned-gc');
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    const candidateId = 'trash-owned';
    const candidatePath = join(root, S2_RETENTION_TRASH_DIR, candidateId);
    await createOwnedCandidate({ root, candidatePath, repoId: 'repo-gc', ownerRun: 'run-gc', candidateId, kind: 'trash', policy, terminalEventSeq: 9 });

    const firstCycle = await runScheduledS2OwnedGc(gcInput(root, 'repo-gc', 'run-gc', policy, '2026-07-22T00:00:01.000Z', 'gc-op-1', [candidateId]));
    assert.equal(firstCycle.removed, 1);
    await assert.rejects(() => stat(candidatePath));

    const secondCycle = await runScheduledS2OwnedGc(gcInput(root, 'repo-gc', 'run-gc', policy, '2026-07-22T00:00:02.000Z', 'gc-op-2', [candidateId]));
    assert.equal(secondCycle.duplicates, 1);
    assert.equal(first(secondCycle.results).outcome, 'duplicate-committed');
    const ledger = await readFile(join(root, '_retention-ledger.ndjson'), 'utf8');
    assert.equal(ledger.trim().split('\n').length, 4);
    assert.ok(ledger.includes('candidate-verified'));
    assert.ok(ledger.includes('candidate-renamed'));
    assert.ok(ledger.includes('candidate-removed'));
    assert.ok(ledger.includes('duplicate-committed'));
  });

  void it('removes eligible transition backups only through the scheduled owned GC path', async () => {
    const root = await tempRoot('s2-owned-gc-transition');
    const policy = defineS2RetentionPolicy();
    const candidateId = 'backup-owned';
    const candidatePath = join(root, S2_RETENTION_TRANSITION_BACKUP_DIR, candidateId);
    await createOwnedCandidate({ root, candidatePath, repoId: 'repo-transition', ownerRun: 'run-transition', candidateId, kind: 'transition-backup', policy, terminalEventSeq: 10 });

    const cycle = await runScheduledS2OwnedGc(gcInput(root, 'repo-transition', 'run-transition', policy, '2026-07-22T00:00:02.500Z', 'gc-transition'));
    assert.equal(cycle.removed, 1);
    assert.equal(first(cycle.results).kind, 'transition-backup');
    await assert.rejects(() => stat(candidatePath));
  });

  void it('does not replay a trash deletion as a different transition-backup duplicate', async () => {
    const root = await tempRoot('s2-owned-gc-kind-fence');
    const policy = defineS2RetentionPolicy();
    const candidateId = 'same-name-owned';
    const candidatePath = join(root, S2_RETENTION_TRASH_DIR, candidateId);
    await createOwnedCandidate({ root, candidatePath, repoId: 'repo-kind', ownerRun: 'run-kind', candidateId, kind: 'trash', policy, terminalEventSeq: 10 });

    assert.equal((await runScheduledS2OwnedGc(gcInput(root, 'repo-kind', 'run-kind', policy, '2026-07-22T00:00:02.700Z', 'gc-kind-1', [candidateId]))).removed, 1);
    const replay = await runScheduledS2OwnedGc(gcInput(root, 'repo-kind', 'run-kind', policy, '2026-07-22T00:00:02.800Z', 'gc-kind-2', [candidateId]));
    assert.equal(replay.duplicates, 1);
    assert.equal(replay.refused, 1);
    assert.equal(replay.results.find((result) => result.kind === 'transition-backup')?.refusalReason, 'missing-without-ledger');
  });

  void it('refuses malformed and hardlinked owner markers without deleting the candidate', async () => {
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    const malformedRoot = await tempRoot('s2-owned-gc-malformed-marker');
    const malformedId = 'malformed-owned';
    const malformedPath = join(malformedRoot, S2_RETENTION_TRASH_DIR, malformedId);
    await createOwnedCandidate({ root: malformedRoot, candidatePath: malformedPath, repoId: 'repo-marker', ownerRun: 'run-marker', candidateId: malformedId, kind: 'trash', policy, terminalEventSeq: 12 });
    await writeFile(join(malformedPath, S2_RETENTION_OWNER_MARKER), canonicalJson({ invalid: true }), 'utf8');
    const malformed = await runScheduledS2OwnedGc(gcInput(malformedRoot, 'repo-marker', 'run-marker', policy, '2026-07-22T00:00:02.900Z', 'gc-malformed', [malformedId]));
    assert.equal(first(malformed.results).refusalReason, 'malformed-owned-marker');
    assert.equal((await stat(malformedPath)).isDirectory(), true);

    const hardlinkRoot = await tempRoot('s2-owned-gc-marker-hardlink');
    const hardlinkId = 'marker-hardlink-owned';
    const hardlinkPath = join(hardlinkRoot, S2_RETENTION_TRASH_DIR, hardlinkId);
    await createOwnedCandidate({ root: hardlinkRoot, candidatePath: hardlinkPath, repoId: 'repo-marker', ownerRun: 'run-marker', candidateId: hardlinkId, kind: 'trash', policy, terminalEventSeq: 13 });
    await link(join(hardlinkPath, S2_RETENTION_OWNER_MARKER), join(hardlinkPath, 'owner-marker-hardlink'));
    const hardlinked = await runScheduledS2OwnedGc(gcInput(hardlinkRoot, 'repo-marker', 'run-marker', policy, '2026-07-22T00:00:02.950Z', 'gc-hardlinked-marker', [hardlinkId]));
    assert.equal(first(hardlinked.results).refusalReason, 'hardlink-detected');
    assert.equal((await stat(hardlinkPath)).isDirectory(), true);
  });

  void it('binds cold verification to exact repo run event terminal kind and policy', async () => {
    const root = await tempRoot('s2-retention-verify-bind');
    const policy = defineS2RetentionPolicy({ policy_id: 'policy-a' });
    const published = await publishS2ColdTerminalProof({ repoId: 'repo-bind', workstreamRun: 'run-bind', terminalEventSeq: 15, terminalKind: 'failed', terminalProof: { terminal: true }, archiveRoot: join(root, 'cold'), hotRoot: join(root, 'hot'), policy, nowIso: '2026-07-22T00:00:00.000Z' });
    verifyS2ColdTerminalProof({ archivePath: published.coldArchivePath, expectedColdArchiveSha256: published.coldArchiveSha256, policy, expected: { repoId: 'repo-bind', workstreamRun: 'run-bind', terminalEventSeq: 15, terminalKind: 'failed' } });
    await assert.rejects(async () => { verifyS2ColdTerminalProof({ archivePath: published.coldArchivePath, expectedColdArchiveSha256: published.coldArchiveSha256, policy: defineS2RetentionPolicy({ policy_id: 'policy-b' }), expected: { repoId: 'repo-bind', workstreamRun: 'run-bind', terminalEventSeq: 15, terminalKind: 'failed' } }); }, /policy_id mismatch|canonical sha256 mismatch/u);
    await assert.rejects(async () => { verifyS2ColdTerminalProof({ archivePath: published.coldArchivePath, expectedColdArchiveSha256: published.coldArchiveSha256, policy, expected: { repoId: 'repo-bind', workstreamRun: 'run-other', terminalEventSeq: 15, terminalKind: 'failed' } }); }, /workstream_run mismatch/u);
  });

  void it('refuses forged cold archive marker state unless the actual descriptor-pinned archive verifies', async () => {
    const root = await tempRoot('s2-owned-gc-forged-archive');
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    const candidateId = 'forged-archive-owned';
    const candidatePath = join(root, S2_RETENTION_TRASH_DIR, candidateId);
    const marker: S2OwnedGcMarker = { schema_version: 'autopilot.s2_retention.owner.v1', created_by: 'autopilot-s2-retention', repo_id: 'repo-forged', owner_run: 'run-forged', candidate_id: candidateId, kind: 'trash', policy_id: policy.policy_id, terminal_event_seq: 99, terminal_kind: 'closed', cold_archive_sha256: '0'.repeat(64), cold_archive_relpath: 'terminal-proofs/missing.json', cold_archive_verified: true, active: false, dirty: false, quarantined: false, sole_copy_pin: false };
    await mkdir(candidatePath, { recursive: true });
    await writeFile(join(candidatePath, S2_RETENTION_OWNER_MARKER), canonicalJson(marker), { flag: 'wx', mode: 0o600 });
    const cycle = await runScheduledS2OwnedGc(gcInput(root, 'repo-forged', 'run-forged', policy, '2026-07-22T00:00:03.500Z', 'gc-forged', [candidateId]));
    assert.equal(first(cycle.results).refusalReason, 'cold-archive-unverified');
    assert.equal((await stat(candidatePath)).isDirectory(), true);
  });

  void it('covers remaining declared refusal reasons without side-effect deletion', async () => {
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    const otherPolicy = defineS2RetentionPolicy({ policy_id: 'other-policy', allow_transition_backup_gc: false });

    const invalidRoot = await tempRoot('s2-owned-gc-invalid-id');
    const invalid = await runScheduledS2OwnedGc(gcInput(invalidRoot, 'repo-refusal2', 'run-refusal2', policy, '2026-07-22T00:00:03.600Z', 'gc-invalid', ['bad$id']));
    assert.equal(first(invalid.results).refusalReason, 'invalid-candidate-id');

    const missingMarkerRoot = await tempRoot('s2-owned-gc-missing-marker');
    const missingId = 'missing-marker-owned';
    const missingPath = join(missingMarkerRoot, S2_RETENTION_TRASH_DIR, missingId);
    await mkdir(missingPath, { recursive: true });
    const missing = await runScheduledS2OwnedGc(gcInput(missingMarkerRoot, 'repo-refusal2', 'run-refusal2', policy, '2026-07-22T00:00:03.610Z', 'gc-missing-marker', [missingId]));
    assert.equal(first(missing.results).refusalReason, 'missing-owned-marker');
    assert.equal((await stat(missingPath)).isDirectory(), true);

    const fileRoot = await tempRoot('s2-owned-gc-path-file');
    const fileId = 'path-file-owned';
    const filePath = join(fileRoot, S2_RETENTION_TRASH_DIR, fileId);
    await mkdir(join(fileRoot, S2_RETENTION_TRASH_DIR), { recursive: true });
    await writeFile(filePath, 'not-directory', 'utf8');
    const fileRefusal = await runScheduledS2OwnedGc(gcInput(fileRoot, 'repo-refusal2', 'run-refusal2', policy, '2026-07-22T00:00:03.620Z', 'gc-path-file', [fileId]));
    assert.equal(first(fileRefusal.results).refusalReason, 'path-not-owned-directory');

    const mismatchRoot = await tempRoot('s2-owned-gc-policy-mismatch');
    const mismatchId = 'policy-mismatch-owned';
    const mismatchPath = join(mismatchRoot, S2_RETENTION_TRASH_DIR, mismatchId);
    await createOwnedCandidate({ root: mismatchRoot, candidatePath: mismatchPath, repoId: 'repo-refusal2', ownerRun: 'run-refusal2', candidateId: mismatchId, kind: 'trash', policy, markerPolicy: otherPolicy, terminalEventSeq: 61 });
    const mismatch = await runScheduledS2OwnedGc(gcInput(mismatchRoot, 'repo-refusal2', 'run-refusal2', policy, '2026-07-22T00:00:03.630Z', 'gc-policy-mismatch', [mismatchId]));
    assert.equal(first(mismatch.results).refusalReason, 'policy-mismatch');

    const unexpectedRoot = await tempRoot('s2-owned-gc-unexpected-kind');
    const unexpectedId = 'unexpected-kind-owned';
    const unexpectedPath = join(unexpectedRoot, S2_RETENTION_TRASH_DIR, unexpectedId);
    await createOwnedCandidate({ root: unexpectedRoot, candidatePath: unexpectedPath, repoId: 'repo-refusal2', ownerRun: 'run-refusal2', candidateId: unexpectedId, kind: 'trash', policy, markerKind: 'transition-backup', terminalEventSeq: 62 });
    const unexpected = await runScheduledS2OwnedGc(gcInput(unexpectedRoot, 'repo-refusal2', 'run-refusal2', policy, '2026-07-22T00:00:03.640Z', 'gc-unexpected-kind', [unexpectedId]));
    assert.equal(first(unexpected.results).refusalReason, 'unexpected-kind');

    for (const markerFile of [
      { file: '.s2-retention-active', reason: 'active-run' },
      { file: '.s2-retention-dirty', reason: 'dirty-path' },
      { file: '.s2-retention-quarantined', reason: 'quarantined-path' },
      { file: '.s2-retention-sole-copy-pin', reason: 'sole-copy-pin' },
    ] as const) {
      const root = await tempRoot(`s2-owned-gc-marker-file-${markerFile.reason}`);
      const candidateId = `marker-file-${markerFile.reason}`;
      const candidatePath = join(root, S2_RETENTION_TRASH_DIR, candidateId);
      await createOwnedCandidate({ root, candidatePath, repoId: 'repo-refusal2', ownerRun: 'run-refusal2', candidateId, kind: 'trash', policy, terminalEventSeq: 63 });
      await writeFile(join(candidatePath, markerFile.file), '', 'utf8');
      const cycle = await runScheduledS2OwnedGc(gcInput(root, 'repo-refusal2', 'run-refusal2', policy, '2026-07-22T00:00:03.650Z', `gc-${candidateId}`, [candidateId]));
      assert.equal(first(cycle.results).refusalReason, markerFile.reason);
      assert.equal((await stat(candidatePath)).isDirectory(), true);
    }
  });

  void it('refuses dirty active quarantined sole-copy and unverified candidates without removing their paths', async () => {
    const policy = defineS2RetentionPolicy({ allow_transition_backup_gc: false });
    const cases = [
      { candidateId: 'active-owned', active: true, dirty: false, quarantined: false, soleCopyPin: false, coldArchiveVerified: true, reason: 'active-run' },
      { candidateId: 'dirty-owned', active: false, dirty: true, quarantined: false, soleCopyPin: false, coldArchiveVerified: true, reason: 'dirty-path' },
      { candidateId: 'quarantined-owned', active: false, dirty: false, quarantined: true, soleCopyPin: false, coldArchiveVerified: true, reason: 'quarantined-path' },
      { candidateId: 'sole-copy-owned', active: false, dirty: false, quarantined: false, soleCopyPin: true, coldArchiveVerified: true, reason: 'sole-copy-pin' },
      { candidateId: 'unverified-owned', active: false, dirty: false, quarantined: false, soleCopyPin: false, coldArchiveVerified: false, reason: 'cold-archive-unverified' },
    ] as const;

    for (const refusal of cases) {
      const root = await tempRoot(`s2-owned-gc-${refusal.candidateId}`);
      const candidatePath = join(root, S2_RETENTION_TRASH_DIR, refusal.candidateId);
      await createOwnedCandidate({ root, candidatePath, repoId: 'repo-refusal', ownerRun: 'run-refusal', candidateId: refusal.candidateId, kind: 'trash', policy, terminalEventSeq: 11, coldArchiveVerified: refusal.coldArchiveVerified, active: refusal.active, dirty: refusal.dirty, quarantined: refusal.quarantined, soleCopyPin: refusal.soleCopyPin });
      const cycle = await runScheduledS2OwnedGc(gcInput(root, 'repo-refusal', 'run-refusal', policy, '2026-07-22T00:00:03.000Z', `gc-op-${refusal.candidateId}`, [refusal.candidateId]));
      const result = first(cycle.results);
      assert.equal(result.outcome, 'refused');
      assert.equal(result.refusalReason, refusal.reason);
      assert.equal((await stat(candidatePath)).isDirectory(), true);
    }
  });
});
