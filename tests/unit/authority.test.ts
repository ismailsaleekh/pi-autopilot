import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { authorityArtifactPath, authorityArtifactSha256, deriveAutopilotAuthority, materializationRowsForAuthority, parseAutopilotAuthority, persistAutopilotAuthority } from '../../src/core/authority.ts';
import type { AutopilotUnitSpec } from '../../src/core/contracts/types.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' } });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function repository(): Promise<{ readonly root: string; readonly runtimeRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-authority-'));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'src', 'core.ts'), 'export const core = true;\n', 'utf8');
  await writeFile(join(root, 'src', 'nested', 'one.ts'), 'one\n', 'utf8');
  await writeFile(join(root, 'src', 'nested', 'two.ts'), 'two\n', 'utf8');
  await writeFile(join(root, 'docs', 'guide.md'), 'guide\n', 'utf8');
  git(root, ['init', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'authority fixture']);
  return { root, runtimeRoot: join(root, '.pi', 'autopilot', 'authority-test') };
}

function spec(root: string, runtimeRoot: string, patch: Partial<AutopilotUnitSpec> = {}): AutopilotUnitSpec {
  return {
    schema_version: 'autopilot.unit_spec.v1', workstream: 'authority-test', unit_id: 'unit-a', role: 'implement', template: 'implement', attempt: 1,
    objective: 'Exercise canonical authority.', cwd: root, model: 'openai-codex/gpt-5.6-sol', thinking: 'high',
    owned_paths: ['src/generated/new.ts'], read_only_paths: ['src/core.ts'], untouchable_paths: [], context_refs: [{ path: 'docs/guide.md', purpose: 'documentation context' }], validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', 'unit-a.json'), receipt_output: join(runtimeRoot, 'receipts', 'unit-a.json'), evidence_dir: join(runtimeRoot, 'evidence', 'unit-a'), stop_boundary: 'Stop after canonical authority is proven.',
    verification_plan: { positive_witnesses: [{ id: 'nested-source', expected_signal: 'tracked tree exists', required: true, inspection_target: 'src/nested' }], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] },
    ...patch,
  };
}

void describe('canonical Autopilot authority derivation', () => {
  void it('derives one deterministic repository-grounded observation/edit artifact and persists it immutably', async () => {
    const fixture = await repository();
    try {
      const unit = spec(fixture.root, fixture.runtimeRoot);
      const first = await deriveAutopilotAuthority({ spec: unit });
      const second = await deriveAutopilotAuthority({ spec: unit });
      assert.equal(authorityArtifactSha256(first), authorityArtifactSha256(second));
      assert.equal(first.base_commit, git(fixture.root, ['rev-parse', 'HEAD']));
      assert.deepEqual(first.observations.map((entry) => [entry.path, entry.scope]), [['docs/guide.md', 'tracked-file'], ['src/core.ts', 'tracked-file'], ['src/nested', 'tracked-directory']]);
      assert.equal(first.observations.every((entry) => entry.source_identity.base_commit === first.base_commit), true);
      assert.deepEqual(first.edit_intentions.map((entry) => [entry.path, entry.scope]), [['src/generated/new.ts', 'future-owned-file']]);
      assert.deepEqual(first.exclusives, []);
      assert.deepEqual(materializationRowsForAuthority(first).map((entry) => `${entry.claim_type}:${entry.path}`), ['READ:docs/guide.md', 'READ:src/core.ts', 'READ:src/nested', 'WRITE:src/generated/new.ts']);

      const persisted = await persistAutopilotAuthority(fixture.runtimeRoot, first);
      assert.equal(persisted.path, authorityArtifactPath(fixture.runtimeRoot, first));
      assert.equal(existsSync(persisted.path), true);
      const parsed = parseAutopilotAuthority(JSON.parse(await readFile(persisted.path, 'utf8')) as unknown);
      assert.equal(authorityArtifactSha256(parsed), persisted.sha256);
      await persistAutopilotAuthority(fixture.runtimeRoot, second);
      await writeFile(persisted.path, `${await readFile(persisted.path, 'utf8')}\n`, 'utf8');
      await assert.rejects(() => persistAutopilotAuthority(fixture.runtimeRoot, second), /authority bytes differ/u);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  void it('publishes authority with atomic no-replace semantics under concurrent drift', async () => {
    const fixture = await repository();
    try {
      const canonical = await deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot) });
      const drifted = { ...canonical, edit_intentions: canonical.edit_intentions.map((entry) => ({ ...entry, purpose: `${entry.purpose}; conflicting concurrent derivation` })) };
      const outcomes = await Promise.allSettled([
        persistAutopilotAuthority(fixture.runtimeRoot, canonical),
        persistAutopilotAuthority(fixture.runtimeRoot, drifted),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
      const persisted = parseAutopilotAuthority(JSON.parse(await readFile(authorityArtifactPath(fixture.runtimeRoot, canonical), 'utf8')) as unknown);
      assert.equal([authorityArtifactSha256(canonical), authorityArtifactSha256(drifted)].includes(authorityArtifactSha256(persisted)), true);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  void it('rejects forged observation identity and malformed persisted EXCLUSIVE authority', async () => {
    const fixture = await repository();
    try {
      const canonical = await deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot), runtimeExclusives: [{ path: 'src/core.ts', purpose: 'critical replacement', criticalSection: 'critical-replacement' }] });
      const wrongBase = { ...canonical, observations: canonical.observations.map((entry, index) => index === 0 ? { ...entry, source_identity: { ...entry.source_identity, base_commit: 'f'.repeat(40) } } : entry) };
      assert.throws(() => parseAutopilotAuthority(wrongBase), /every observation must bind/u);
      const missingObject = { ...canonical, observations: canonical.observations.map((entry, index) => index === 0 ? { ...entry, source_identity: { ...entry.source_identity, object_kind: 'missing' } } : entry) };
      assert.throws(() => parseAutopilotAuthority(missingObject), /exact tracked blob or tree/u);
      const malformedExclusive = { ...canonical, exclusives: canonical.exclusives.map((entry) => ({ ...entry, critical_section: 'x' })) };
      assert.throws(() => parseAutopilotAuthority(malformedExclusive), /critical_section is invalid/u);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  void it('rejects prose/untracked observations and ungrounded future edit paths before acquisition', async () => {
    const fixture = await repository();
    try {
      await assert.rejects(() => deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot, { read_only_paths: ['all source files'] }) }), /untracked-observation/u);
      await assert.rejects(() => deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot, { owned_paths: ['missing-parent/new.ts'] }) }), /ungrounded-future-owned-path/u);
      await assert.rejects(() => deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot, { owned_paths: ['main worktree'] }) }), /whitespace\/control prose/u);
      await assert.rejects(() => deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot, { owned_paths: ['src/core.ts/impossible-child.ts'] }) }), /tracked file or submodule/u);
      await assert.rejects(() => deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot, { context_refs: [{ path: 'eight owned files', purpose: 'prose must never become authority' }] }) }), /untracked-observation/u);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  void it('classifies and caps broad tracked directory authority instead of silently expanding it', async () => {
    const fixture = await repository();
    try {
      const broad = await deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot, { read_only_paths: ['src'] }) });
      const observation = broad.observations.find((entry) => entry.path === 'src');
      assert.equal(observation?.scope, 'tracked-directory');
      assert.equal(observation?.tracked_file_count, 3);
      await assert.rejects(() => deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot, { read_only_paths: ['src'] }), limits: { maxBroadTrackedFiles: 2 } }), /broad-authority-cap/u);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  void it('accepts only explicit runtime exclusives with a tracked bounded surface and named critical section', async () => {
    const fixture = await repository();
    try {
      const artifact = await deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot), runtimeExclusives: [{ path: 'src/core.ts', purpose: 'replace canonical authority atomically', criticalSection: 'canonical-authority-replacement' }] });
      assert.deepEqual(artifact.exclusives.map((entry) => [entry.path, entry.critical_section]), [['src/core.ts', 'canonical-authority-replacement']]);
      assert.equal(artifact.observations.some((entry) => entry.path === 'src/core.ts'), false);
      await assert.rejects(() => deriveAutopilotAuthority({ spec: spec(fixture.root, fixture.runtimeRoot), runtimeExclusives: [{ path: 'src/core.ts', purpose: 'invalid', criticalSection: 'x' }] }), /invalid-exclusive-critical-section/u);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});
