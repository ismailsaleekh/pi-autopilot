import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claimModesConflict } from '../../src/core/coordination/contracts.ts';
import { classifyCoordinationIntegrationConflict } from '../../src/core/coordination/integration-conflicts.ts';
import { mainWorktreeObservationBlockers } from '../../src/core/unit-merge.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' } });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(): Promise<{ readonly root: string; readonly base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-integration-classifier-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'shared.ts'), ['line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6', ''].join('\n'), 'utf8');
  await writeFile(join(root, 'config.json'), `${JSON.stringify({ feature: { mode: 'base', enabled: false }, other: 1 }, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'package-lock.json'), ['lock-1', 'lock-2', 'lock-3', 'lock-4', ''].join('\n'), 'utf8');
  git(root, ['init', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

async function branchCommit(root: string, base: string, branch: string, mutate: () => Promise<void>): Promise<string> {
  git(root, ['checkout', '-B', branch, base]);
  await mutate();
  git(root, ['add', '.']);
  git(root, ['commit', '-m', branch]);
  return git(root, ['rev-parse', 'HEAD']);
}

async function replaceLine(path: string, index: number, value: string): Promise<void> {
  const lines = (await readFile(path, 'utf8')).split('\n');
  lines[index] = value;
  await writeFile(path, lines.join('\n'), 'utf8');
}

void describe('integration-time conflict classification', () => {
  void it('treats WRITE as speculative worktree intent while retaining EXCLUSIVE launch blocking', () => {
    assert.equal(claimModesConflict('READ', 'WRITE'), false);
    assert.equal(claimModesConflict('WRITE', 'WRITE'), false);
    assert.equal(claimModesConflict('WRITE', 'EXCLUSIVE'), true);
    assert.equal(claimModesConflict('EXCLUSIVE', 'EXCLUSIVE'), true);
    assert.equal(claimModesConflict('READ', 'EXCLUSIVE'), true);
  });

  void it('blocks only physical main-worktree readers during mergeback, not source-unit observations in isolated worktrees', () => {
    const sourceOwner = { repo_id: 'repo-1', autopilot_id: 'auto-1', workstream_run: 'run-1', unit_id: 'source-reader', attempt: 1 } as const;
    const validatorOwner = { ...sourceOwner, unit_id: 'main-validator' } as const;
    const observation = (owner: typeof sourceOwner | typeof validatorOwner, id: string) => ({ schema_version: 'autopilot.observation.v1' as const, observation_id: id, owner, acquisition_group_id: `group-${id}`, path: 'src/shared.ts', purpose: 'stable source observation', source_identity: { base_commit: 'a'.repeat(40), object_id: 'b'.repeat(40), object_kind: 'blob' as const }, execution_state: 'active' as const, freshness: 'current' as const, recorded_event_seq: 1, released_event_seq: null, stale_event_seq: null, stale_by_reservation_id: null, stale_by_commit: null, version: 1 });
    const attempt = (owner: typeof sourceOwner | typeof validatorOwner, role: 'implement' | 'validate') => ({ schema_version: 'autopilot.unit_attempt.v1' as const, owner, state: 'running' as const, role, spec: { ref: 'unit-spec.json', sha256: `sha256:${'c'.repeat(64)}` as const }, preemptible: true, checkpoint_ordinal: 0, critical_section: null, version: 1 });
    const source = observation(sourceOwner, 'source-observation');
    const validator = observation(validatorOwner, 'validator-observation');
    assert.deepEqual(mainWorktreeObservationBlockers([source], [attempt(sourceOwner, 'implement')], 'run-1', ['src/shared.ts']), []);
    assert.equal(mainWorktreeObservationBlockers([source, validator], [attempt(sourceOwner, 'implement'), attempt(validatorOwner, 'validate')], 'run-1', ['src/shared.ts']).length, 1);
  });

  void it('proves same-file disjoint hunks merge cleanly and require only deterministic ordered integration', async () => {
    const value = await fixture();
    try {
      const path = join(value.root, 'src', 'shared.ts');
      const predecessor = await branchCommit(value.root, value.base, 'predecessor', async () => replaceLine(path, 1, 'line-2-from-predecessor'));
      const dependent = await branchCommit(value.root, value.base, 'dependent', async () => replaceLine(path, 4, 'line-5-from-dependent'));
      const classification = classifyCoordinationIntegrationConflict({ repoRoot: value.root, predecessorCommit: predecessor, dependentCommit: dependent, overlappingPaths: ['src/shared.ts'] });
      assert.equal(classification.kind, 'disjoint-hunks');
      assert.equal(classification.disposition, 'ordered-integration');
      assert.equal(classification.merge_tree_status, 'clean');
      assert.deepEqual(classification.overlapping_hunks, []);
      assert.deepEqual(classification.overlapping_paths, ['src/shared.ts']);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  void it('detects actual overlapping hunks as repair work rather than launch contention or silent merge', async () => {
    const value = await fixture();
    try {
      const path = join(value.root, 'src', 'shared.ts');
      const predecessor = await branchCommit(value.root, value.base, 'predecessor', async () => replaceLine(path, 1, 'predecessor-value'));
      const dependent = await branchCommit(value.root, value.base, 'dependent', async () => replaceLine(path, 1, 'dependent-value'));
      const classification = classifyCoordinationIntegrationConflict({ repoRoot: value.root, predecessorCommit: predecessor, dependentCommit: dependent, overlappingPaths: ['src/shared.ts'] });
      assert.equal(classification.kind, 'textual-merge-conflict');
      assert.equal(classification.disposition, 'repair-required');
      assert.equal(classification.merge_tree_status, 'conflict');
      assert.equal(classification.overlapping_hunks.length, 1);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  void it('classifies delete/modify from read-only three-tree analysis without writing merge objects', async () => {
    const value = await fixture();
    try {
      const path = join(value.root, 'src', 'shared.ts');
      const predecessor = await branchCommit(value.root, value.base, 'predecessor-delete', async () => rm(path));
      const dependent = await branchCommit(value.root, value.base, 'dependent-modify', async () => replaceLine(path, 2, 'dependent-keeps-and-modifies'));
      const objectsBefore = git(value.root, ['count-objects', '-v']);
      const classification = classifyCoordinationIntegrationConflict({ repoRoot: value.root, predecessorCommit: predecessor, dependentCommit: dependent, overlappingPaths: ['src/shared.ts'] });
      assert.equal(classification.kind, 'delete-modify-conflict');
      assert.equal(classification.merge_tree_status, 'conflict');
      assert.deepEqual(classification.overlapping_paths, ['src/shared.ts']);
      assert.equal(git(value.root, ['count-objects', '-v']), objectsBefore, 'classification must not use merge-tree --write-tree');
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  void it('fails closed when overlapping JSON cannot be parsed despite a clean textual merge', async () => {
    const value = await fixture();
    try {
      const config = join(value.root, 'config.json');
      const malformed = ['{', '  "left": 1,', '  "filler1": 1,', '  "filler2": 2,', '  "filler3": 3,', '  BROKEN_TOKEN,', '  "filler4": 4,', '  "filler5": 5,', '  "filler6": 6,', '  "right": 1', '}', ''].join('\n');
      git(value.root, ['checkout', '-B', 'malformed-base', value.base]);
      await writeFile(config, malformed, 'utf8');
      git(value.root, ['add', 'config.json']);
      git(value.root, ['commit', '-m', 'malformed json base']);
      const malformedBase = git(value.root, ['rev-parse', 'HEAD']);
      const predecessor = await branchCommit(value.root, malformedBase, 'malformed-predecessor', async () => replaceLine(config, 1, '  "left": 2,'));
      const dependent = await branchCommit(value.root, malformedBase, 'malformed-dependent', async () => replaceLine(config, 9, '  "right": 2'));
      const classification = classifyCoordinationIntegrationConflict({ repoRoot: value.root, predecessorCommit: predecessor, dependentCommit: dependent, overlappingPaths: ['config.json'] });
      assert.equal(classification.merge_tree_status, 'clean');
      assert.equal(classification.kind, 'semantic-key-conflict');
      assert.equal(classification.disposition, 'repair-required');
      assert.deepEqual(classification.semantic_keys, ['config.json#<uninspectable-json>']);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  void it('uses JSON semantic keys and protected surfaces even when textual integration could appear ordinary', async () => {
    const semantic = await fixture();
    try {
      const config = join(semantic.root, 'config.json');
      const predecessor = await branchCommit(semantic.root, semantic.base, 'predecessor', async () => writeFile(config, `${JSON.stringify({ feature: { mode: 'fast', enabled: false }, other: 1 }, null, 2)}\n`, 'utf8'));
      const dependent = await branchCommit(semantic.root, semantic.base, 'dependent', async () => writeFile(config, `${JSON.stringify({ feature: { mode: 'safe', enabled: false }, other: 1 }, null, 2)}\n`, 'utf8'));
      const classification = classifyCoordinationIntegrationConflict({ repoRoot: semantic.root, predecessorCommit: predecessor, dependentCommit: dependent, overlappingPaths: ['config.json'] });
      assert.equal(classification.kind, 'semantic-key-conflict');
      assert.equal(classification.disposition, 'repair-required');
      assert.ok(classification.semantic_keys.includes('config.json#/feature/mode'));
    } finally { await rm(semantic.root, { recursive: true, force: true }); }

    const semanticAncestor = await fixture();
    try {
      const config = join(semanticAncestor.root, 'config.json');
      const predecessor = await branchCommit(semanticAncestor.root, semanticAncestor.base, 'predecessor', async () => writeFile(config, `${JSON.stringify({ feature: { mode: 'fast', enabled: false }, other: 1 }, null, 2)}\n`, 'utf8'));
      const dependent = await branchCommit(semanticAncestor.root, semanticAncestor.base, 'dependent', async () => writeFile(config, `${JSON.stringify({ other: 1 }, null, 2)}\n`, 'utf8'));
      const classification = classifyCoordinationIntegrationConflict({ repoRoot: semanticAncestor.root, predecessorCommit: predecessor, dependentCommit: dependent, overlappingPaths: ['config.json'] });
      assert.equal(classification.kind, 'semantic-key-conflict');
      assert.ok(classification.semantic_keys.includes('config.json#/feature'));
    } finally { await rm(semanticAncestor.root, { recursive: true, force: true }); }

    const protectedFixture = await fixture();
    try {
      const lock = join(protectedFixture.root, 'package-lock.json');
      const predecessor = await branchCommit(protectedFixture.root, protectedFixture.base, 'predecessor', async () => replaceLine(lock, 0, 'lock-1-predecessor'));
      const dependent = await branchCommit(protectedFixture.root, protectedFixture.base, 'dependent', async () => replaceLine(lock, 3, 'lock-4-dependent'));
      const classification = classifyCoordinationIntegrationConflict({ repoRoot: protectedFixture.root, predecessorCommit: predecessor, dependentCommit: dependent, overlappingPaths: ['package-lock.json'] });
      assert.equal(classification.kind, 'protected-surface-conflict');
      assert.equal(classification.disposition, 'repair-required');
      assert.deepEqual(classification.protected_surfaces, ['package-lock.json']);
    } finally { await rm(protectedFixture.root, { recursive: true, force: true }); }
  });
});
