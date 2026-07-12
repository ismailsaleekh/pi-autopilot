import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  LEGACY_PREFLIGHT_MAX_FINDINGS,
  parseLegacyActiveAutopilots,
  parseLegacyPathClaims,
  runLegacyCoordinationPreflight,
  type LegacyCoordinationPreflightResult,
} from '../../src/core/coordination/index.ts';
import {
  AUTOPILOT_STATE_ROOT_ENV,
  coordinationRootForRepo,
  prepareAutopilotWorkstream,
  readActiveAutopilots,
  writeActiveAutopilots,
  writePathClaims,
  type ActiveAutopilotRow,
  type AutopilotPathClaim,
} from '../../src/core/parallel-runtime.ts';

void describe('legacy coordination canonical preflight', () => {
  void it('accepts coherent authority, writes bounded diagnostics, and leaves authority bytes unchanged', async () => {
    await withTempDir(async (root) => {
      const coordinationRoot = join(root, 'coordination');
      await mkdir(coordinationRoot, { recursive: true });
      const row = legacyRow(root);
      const claim = legacyClaim(row);
      const activeText = `${JSON.stringify([row], null, 2)}\n`;
      const claimsText = `${JSON.stringify([claim], null, 2)}\n`;
      await writeFile(join(coordinationRoot, 'active-autopilots.json'), activeText, 'utf8');
      await writeFile(join(coordinationRoot, 'path-claims.json'), claimsText, 'utf8');
      const result = await runLegacyCoordinationPreflight({
        coordinationRoot,
        repoKey: 'repo-key-1',
        mode: 'claim-gc-dry-run',
        now: new Date('2026-07-11T15:10:00.000Z'),
      });
      assert.equal(result.safe, true);
      assert.equal(result.active_row_count, 1);
      assert.equal(result.claim_count, 1);
      assert.equal(existsSync(result.diagnostic_path), true);
      assert.equal(await readFile(join(coordinationRoot, 'active-autopilots.json'), 'utf8'), activeText);
      assert.equal(await readFile(join(coordinationRoot, 'path-claims.json'), 'utf8'), claimsText);
    });
  });

  void it('retains old-epoch claims by durable run ownership and records a warning', async () => {
    await withTempDir(async (root) => {
      const coordinationRoot = await writeLegacyAuthority(root, [{ ...legacyClaim(legacyRow(root)), active_run_epoch: 1 }], { ...legacyRow(root), active_run_epoch: 2 });
      const now = new Date('2026-07-11T15:11:00.000Z');
      const result = await runLegacyCoordinationPreflight({ coordinationRoot, repoKey: 'repo-key-1', mode: 'claim-gc-dry-run', now });
      const diagnostic = await readDiagnosticFor(coordinationRoot, '20260711T151100000Z.claim-gc-dry-run.');
      assert.equal(result.safe, true);
      assert.equal(diagnostic.findings.some((finding) => finding.code === 'legacy-old-epoch-claim' && finding.severity === 'warning'), true);
    });
  });

  void it('classifies session replacement as durable claim retention without mutation', async () => {
    await withTempDir(async (root) => {
      const row = legacyRow(root);
      const coordinationRoot = await writeLegacyAuthority(root, [legacyClaim(row)], row);
      const result = await runLegacyCoordinationPreflight({
        coordinationRoot,
        repoKey: row.repo_key,
        mode: 'activation',
        activationWorkstream: row.workstream,
        currentPid: row.pid + 1,
        currentBootId: 'replacement-boot',
        now: new Date('2026-07-11T15:12:00.000Z'),
      });
      assert.equal(result.safe, true);
      assert.equal(result.findings.some((finding) => finding.code === 'legacy-resume-retains-durable-claims'), true);
      const storedRows = parseLegacyActiveAutopilots(JSON.parse(await readFile(join(coordinationRoot, 'active-autopilots.json'), 'utf8')) as unknown);
      assert.equal(storedRows[0]?.active_run_epoch, row.active_run_epoch);
    });
  });

  void it('resumes a real workstream while preserving its old-session claim identity', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const previousStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
      process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'state');
      try {
        const prepared = await prepareAutopilotWorkstream({ workstream: 'production-preflight', sourceCwd: source, now: new Date('2026-07-11T15:12:30.000Z') });
        const simulatedPriorProcess = { ...prepared.active, pid: prepared.active.pid + 10, boot_id: 'prior-process-boot' };
        const coordinationRoot = coordinationRootForRepo(prepared.active.repo_key);
        const durableClaim = legacyClaim(simulatedPriorProcess);
        await writeActiveAutopilots(coordinationRoot, [simulatedPriorProcess]);
        await writePathClaims(coordinationRoot, [durableClaim]);
        const resumed = await prepareAutopilotWorkstream({ workstream: 'production-preflight', sourceCwd: source, now: new Date('2026-07-11T15:12:31.000Z') });
        const rows = await readActiveAutopilots(coordinationRoot);
        const claims = await readFile(join(coordinationRoot, 'path-claims.json'), 'utf8');
        assert.equal(rows[0]?.pid, process.pid);
        assert.equal(rows[0]?.active_run_epoch, simulatedPriorProcess.active_run_epoch + 1);
        assert.equal(resumed.active.workstream_run, simulatedPriorProcess.workstream_run);
        assert.match(claims, new RegExp(`"active_run_epoch": ${String(durableClaim.active_run_epoch)}`, 'u'));
      } finally {
        if (previousStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
        else process.env[AUTOPILOT_STATE_ROOT_ENV] = previousStateRoot;
      }
    });
  });

  void it('rejects malformed ownership shapes through canonical unknown parsers', () => {
    const row = legacyRow('/tmp/generic');
    assert.throws(() => parseLegacyActiveAutopilots([{ ...row, undeclared_field: true }]), /unknown fields: undeclared_field/u);
    assert.throws(() => parseLegacyPathClaims([{ ...legacyClaim(row), path: '../escape.ts' }]), /repository-relative and normalized/u);
  });

  void it('caps persisted findings without hiding the rejected result', async () => {
    await withTempDir(async (root) => {
      const row = legacyRow(root);
      const claims = Array.from({ length: LEGACY_PREFLIGHT_MAX_FINDINGS + 5 }, () => legacyClaim(row));
      const coordinationRoot = await writeLegacyAuthority(root, claims, row);
      const now = new Date('2026-07-11T15:13:00.000Z');
      await expectRejects(() => runLegacyCoordinationPreflight({ coordinationRoot, repoKey: row.repo_key, mode: 'claim-gc-dry-run', now }), /refused inconsistent authority/u);
      const diagnostic = await readDiagnosticFor(coordinationRoot, '20260711T151300000Z.claim-gc-dry-run.');
      assert.equal(diagnostic.findings.length, LEGACY_PREFLIGHT_MAX_FINDINGS);
      assert.equal(diagnostic.truncated_findings > 0, true);
    });
  });
});

function legacyRow(root: string): ActiveAutopilotRow {
  return {
    schema_version: 'autopilot.active_parent.v2',
    coordination_authority: 'legacy-path-claims-v1',
    autopilot_id: 'autopilot-1',
    workstream: 'generic-work',
    workstream_run: 'generic-work-run-1',
    repo_key: 'repo-key-1',
    source_repo: join(root, 'source'),
    git_common_dir: join(root, 'source', '.git'),
    worktree_root: join(root, 'state', 'worktrees', 'repo-key-1'),
    main_worktree_path: join(root, 'state', 'worktrees', 'repo-key-1', 'active', 'generic-work-run-1', 'main'),
    branch: 'autopilot/work/generic-work-run-1',
    runtime_root: join(root, 'state', 'worktrees', 'repo-key-1', 'active', 'generic-work-run-1', 'main', '.pi', 'autopilot', 'generic-work'),
    target_branch: 'main',
    target_base_sha: '0123456789abcdef',
    origin_url: null,
    pid: 100,
    boot_id: 'boot-1',
    status: 'active',
    started_at: '2026-07-11T15:00:00.000Z',
    active_run_epoch: 1,
    active_epoch_started_at: '2026-07-11T15:00:00.000Z',
    active_run_receipt_id: 'receipt-1',
  };
}

function legacyClaim(row: ActiveAutopilotRow): AutopilotPathClaim {
  return {
    schema_version: 'autopilot.path_claim.v1',
    path: 'src/shared.ts',
    autopilot_id: row.autopilot_id,
    workstream: row.workstream,
    workstream_run: row.workstream_run,
    unit_id: 'unit-1',
    attempt: 1,
    claim_type: 'WRITE',
    acquired_at: '2026-07-11T15:00:01.000Z',
    active_run_epoch: row.active_run_epoch,
    reason: 'generic fixture',
  };
}

async function initGitSource(source: string): Promise<void> {
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'README.md'), '# generic repository\n', 'utf8');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'autopilot@example.invalid'],
    ['config', 'user.name', 'Autopilot Test'],
    ['add', '.'],
    ['commit', '-m', 'baseline'],
  ]) {
    const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}

async function writeLegacyAuthority(root: string, claims: readonly AutopilotPathClaim[], row: ActiveAutopilotRow): Promise<string> {
  const coordinationRoot = join(root, 'coordination');
  await mkdir(coordinationRoot, { recursive: true });
  await writeFile(join(coordinationRoot, 'active-autopilots.json'), `${JSON.stringify([row], null, 2)}\n`, 'utf8');
  await writeFile(join(coordinationRoot, 'path-claims.json'), `${JSON.stringify(claims, null, 2)}\n`, 'utf8');
  return coordinationRoot;
}

async function readDiagnosticFor(coordinationRoot: string, prefix: string): Promise<LegacyCoordinationPreflightResult> {
  const preflightRoot = join(coordinationRoot, 'preflight');
  const files = await readdir(preflightRoot, { withFileTypes: true });
  const match = files.find((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.json'));
  if (match === undefined) throw new Error(`missing preflight diagnostic with prefix ${prefix}`);
  const parsed: unknown = JSON.parse(await readFile(join(preflightRoot, match.name), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('schema_version' in parsed) || parsed.schema_version !== 'autopilot.coordination_preflight.v1') throw new Error('invalid preflight diagnostic');
  return parsed as LegacyCoordinationPreflightResult;
}

async function expectRejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) throw new Error('expected legacy preflight rejection');
  assert.match(caught.message, pattern);
}

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-coordination-preflight-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
