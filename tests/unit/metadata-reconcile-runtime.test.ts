import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { reconcileApprovedMissingWorktreeMetadata, type MetadataReconcileApproval } from '../../src/core/coordination/metadata-reconcile-runtime.ts';
import { gitWorktreeRegistrationFacts } from '../../src/core/coordination/worktree-postconditions.ts';
import { deterministicWorktreeId, type CanonicalWorktreeSemanticIdentity } from '../../src/core/coordination/worktree-identity.ts';
import type { GitWorktreeRegistrationFact, MetadataReconcileIntent, PreservedGitRefFact } from '../../src/core/coordination/metadata-reconcile.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

interface Corpus {
  readonly root: string;
  readonly repo: string;
  readonly common: string;
  readonly paths: readonly string[];
  readonly branches: readonly PreservedGitRefFact[];
}

async function corpus(count: number, label: string): Promise<Corpus> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `pi-autopilot-metadata-${label}-`)));
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'autopilot@example.invalid']);
  git(repo, ['config', 'user.name', 'Autopilot Test']);
  await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const paths: string[] = [];
  const branches: PreservedGitRefFact[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = resolve(root, 'worktrees', `missing-${String(index).padStart(2, '0')}`);
    const branch = `autopilot/unit/run-${label}/unit-${String(index).padStart(2, '0')}/attempt-1`;
    await mkdir(join(path, '..'), { recursive: true });
    git(repo, ['worktree', 'add', '-b', branch, path, head]);
    paths.push(path);
    branches.push({ ref: `refs/heads/${branch}`, sha: head });
  }
  for (const path of paths) await rm(path, { recursive: true, force: false });
  return { root, repo, common: resolve(repo, '.git'), paths: Object.freeze(paths), branches: Object.freeze(branches.sort((left, right) => left.ref < right.ref ? -1 : 1)) };
}

async function approvals(value: Corpus, repoId: string): Promise<readonly MetadataReconcileApproval[]> {
  const before = gitWorktreeRegistrationFacts(value.repo);
  const approved = before.filter((entry) => entry.prunable).map((entry) => entry.worktree_path).sort();
  const after = before.filter((entry) => !entry.prunable);
  assert.deepEqual(approved, [...value.paths].sort());
  const output: MetadataReconcileApproval[] = [];
  for (let index = 0; index < value.paths.length; index += 1) {
    const path = value.paths[index];
    if (path === undefined) throw new Error('corpus path disappeared');
    const semanticIdentity: CanonicalWorktreeSemanticIdentity = {
      repo_id: repoId,
      autopilot_id: `autopilot-${String(index)}`,
      workstream_run: `run-${String(index)}`,
      unit_id: `unit-${String(index)}`,
      attempt: 1,
      kind: 'unit',
    };
    const canonicalId = deterministicWorktreeId({ repo_id: semanticIdentity.repo_id, autopilot_id: semanticIdentity.autopilot_id, workstream_run: semanticIdentity.workstream_run, unit_id: semanticIdentity.unit_id, attempt: semanticIdentity.attempt }, semanticIdentity.kind);
    const recoveryPath = join(value.root, 'recovery', `${String(index)}.json`);
    const recoveryBytes = `${JSON.stringify({ schema_version: 'autopilot.test_metadata_recovery.v1', db_state: 'active', backup_coverage: index < 7 ? 'exact-snapshot-path' : 'git-ref-only', target_path: path })}\n`;
    await mkdir(join(recoveryPath, '..'), { recursive: true });
    await writeFile(recoveryPath, recoveryBytes, 'utf8');
    const intent: MetadataReconcileIntent = {
      schema_version: 'autopilot.worktree_metadata_reconcile_intent.v1',
      repo_id: repoId,
      canonical_worktree_id: canonicalId,
      git_common_dir: value.common,
      target_registration_path: path,
      approved_before_registrations: before,
      approved_prunable_registration_paths: approved,
      expected_after_registrations: after,
      preserved_refs: value.branches,
      recovery_evidence_sha256: `sha256:${createHash('sha256').update(recoveryBytes, 'utf8').digest('hex')}`,
    };
    output.push({ semantic_identity: semanticIdentity, intent, recovery_evidence_path: recoveryPath });
  }
  return Object.freeze(output);
}

function registrationPaths(values: readonly GitWorktreeRegistrationFact[]): readonly string[] {
  return values.map((entry) => entry.worktree_path).sort();
}

void describe('I5 metadata-only worktree registration reconciliation', () => {
  void it('reconciles the exact 34-registration corpus while preserving every branch head, object, and missing path', async () => {
    const value = await corpus(34, 'corpus');
    try {
      const rows = await approvals(value, 'repo-corpus');
      const result = await reconcileApprovedMissingWorktreeMetadata({ approvals: rows, evidence_root: join(value.root, 'audit') });
      assert.equal(result.approved_prunable_paths.length, 34);
      assert.equal(result.evidence_paths.length, 34);
      assert.deepEqual(registrationPaths(result.after_registrations), [resolve(value.repo)]);
      for (const branch of value.branches) {
        assert.equal(git(value.repo, ['rev-parse', '--verify', branch.ref]), branch.sha);
        assert.equal(git(value.repo, ['cat-file', '-t', branch.sha]), 'commit');
      }
      for (const path of value.paths) assert.equal(gitWorktreeRegistrationFacts(value.repo).some((entry) => entry.worktree_path === path), false);
      const replay = await reconcileApprovedMissingWorktreeMetadata({ approvals: rows, evidence_root: join(value.root, 'audit') });
      assert.equal(replay.mutation_report, 'already-satisfied');
      assert.deepEqual(replay.evidence_paths, result.evidence_paths);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('refuses proof/action drift without pruning approved registrations', async () => {
    const value = await corpus(2, 'drift');
    try {
      const rows = await approvals(value, 'repo-drift');
      const extra = resolve(value.root, 'worktrees', 'foreign-live');
      await assert.rejects(() => reconcileApprovedMissingWorktreeMetadata({
        approvals: rows,
        evidence_root: join(value.root, 'audit'),
        observe_before_final_drift_check: () => { git(value.repo, ['worktree', 'add', '-b', 'foreign/live', extra, 'HEAD']); },
      }), /changed between proof and action/u);
      const current = gitWorktreeRegistrationFacts(value.repo);
      for (const path of value.paths) assert.equal(current.some((entry) => entry.worktree_path === path && entry.prunable), true);
      assert.equal(current.some((entry) => entry.worktree_path === extra && !entry.prunable), true);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('refuses a partial approval when another registration is globally prunable', async () => {
    const value = await corpus(2, 'partial-approval');
    try {
      const rows = await approvals(value, 'repo-partial-approval');
      const selected = rows[0];
      if (selected === undefined) throw new Error('partial-approval row disappeared');
      const target = selected.intent.target_registration_path;
      const partial: MetadataReconcileApproval = {
        ...selected,
        intent: {
          ...selected.intent,
          approved_prunable_registration_paths: [target],
          expected_after_registrations: selected.intent.approved_before_registrations.filter((registration) => registration.worktree_path !== target),
        },
      };
      await assert.rejects(
        () => reconcileApprovedMissingWorktreeMetadata({ approvals: [partial], evidence_root: join(value.root, 'audit') }),
        /complete pre-reconcile prunable set|every currently prunable registration has one approved row/u,
      );
      assert.equal(gitWorktreeRegistrationFacts(value.repo).filter((registration) => registration.prunable).length, 2);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('refuses preserved-ref drift and dangling filesystem entries before global prune', async () => {
    const refDrift = await corpus(1, 'ref-drift');
    try {
      const rows = await approvals(refDrift, 'repo-ref-drift');
      const head = git(refDrift.repo, ['rev-parse', 'HEAD']);
      const tree = git(refDrift.repo, ['rev-parse', 'HEAD^{tree}']);
      const alternate = git(refDrift.repo, ['commit-tree', tree, '-p', head, '-m', 'unapproved ref movement']);
      const ref = refDrift.branches[0]?.ref;
      if (ref === undefined) throw new Error('ref-drift branch disappeared');
      await assert.rejects(() => reconcileApprovedMissingWorktreeMetadata({
        approvals: rows,
        evidence_root: join(refDrift.root, 'audit'),
        observe_before_final_drift_check: () => { git(refDrift.repo, ['update-ref', ref, alternate, head]); },
      }), /preserved ref moved/u);
      assert.equal(gitWorktreeRegistrationFacts(refDrift.repo).some((entry) => entry.prunable), true);
    } finally {
      await rm(refDrift.root, { recursive: true, force: true });
    }

    const dangling = await corpus(1, 'dangling');
    try {
      const rows = await approvals(dangling, 'repo-dangling');
      const path = dangling.paths[0];
      if (path === undefined) throw new Error('dangling corpus path disappeared');
      await mkdir(join(path, '..'), { recursive: true });
      await symlink(join(dangling.root, 'absent-target'), path);
      await assert.rejects(() => reconcileApprovedMissingWorktreeMetadata({ approvals: rows, evidence_root: join(dangling.root, 'audit') }), /physical or symbolic filesystem entry/u);
      assert.equal(gitWorktreeRegistrationFacts(dangling.repo).some((entry) => entry.worktree_path === path && entry.prunable), true);
    } finally {
      await rm(dangling.root, { recursive: true, force: true });
    }
  });

  void it('rejects a substituted evidence directory before pruning registration metadata', async () => {
    const value = await corpus(1, 'evidence-symlink');
    try {
      const rows = await approvals(value, 'repo-evidence-symlink');
      const auditRoot = join(value.root, 'audit');
      const external = join(value.root, 'external-evidence-target');
      await mkdir(auditRoot);
      await mkdir(external);
      await symlink(external, join(auditRoot, 'metadata-reconcile'));
      await assert.rejects(
        () => reconcileApprovedMissingWorktreeMetadata({ approvals: rows, evidence_root: auditRoot }),
        /evidence directory is a symbolic or non-directory entry/u,
      );
      assert.equal(gitWorktreeRegistrationFacts(value.repo).filter((registration) => registration.prunable).length, 1);
      const canonicalId = rows[0]?.intent.canonical_worktree_id;
      if (canonicalId === undefined) throw new Error('evidence-symlink canonical row disappeared');
      assert.equal(existsSync(join(external, `${canonicalId}.json`)), false);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('isolates a foreign repository completely', async () => {
    const owned = await corpus(1, 'owned');
    const foreign = await corpus(1, 'foreign');
    try {
      const foreignBefore = gitWorktreeRegistrationFacts(foreign.repo);
      const foreignRefs = foreign.branches.map((entry) => `${entry.ref}=${git(foreign.repo, ['rev-parse', entry.ref])}`);
      await reconcileApprovedMissingWorktreeMetadata({ approvals: await approvals(owned, 'repo-owned'), evidence_root: join(owned.root, 'audit') });
      assert.deepEqual(gitWorktreeRegistrationFacts(foreign.repo), foreignBefore);
      assert.deepEqual(foreign.branches.map((entry) => `${entry.ref}=${git(foreign.repo, ['rev-parse', entry.ref])}`), foreignRefs);
    } finally {
      await rm(owned.root, { recursive: true, force: true });
      await rm(foreign.root, { recursive: true, force: true });
    }
  });
});
