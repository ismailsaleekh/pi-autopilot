import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluateAutopilotWorktreeToolCall } from '../../src/core/git-guard.ts';
import { parseAutopilotArgs, parseAutopilotLaunchArgs } from '../../src/core/paths.ts';

function tempWorktree(): { readonly root: string; readonly runtimeDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'd65-guard-')));
  const runtimeDir = join(root, '.pi', 'autopilot', 'wk');
  mkdirSync(runtimeDir, { recursive: true });
  return { root, runtimeDir };
}

void describe('D65 bootstrap-only effect fence (git guard)', () => {
  void it('allows a write to exactly one of the five charter paths', () => {
    const { root, runtimeDir } = tempWorktree();
    const charterPaths = ['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl'].map((n) => join(runtimeDir, n));
    for (const path of charterPaths) {
      const decision = evaluateAutopilotWorktreeToolCall({ toolName: 'write', input: { path } }, { cwd: root }, { worktreeRoot: root, label: 'fence', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [] });
      assert.equal(decision, undefined, `charter path ${path} must be allowed`);
    }
  });

  void it('blocks a write to a product/source path outside the five charter paths', () => {
    const { root, runtimeDir } = tempWorktree();
    const charterPaths = ['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl'].map((n) => join(runtimeDir, n));
    const productPath = join(root, 'src', 'product.ts');
    const decision = evaluateAutopilotWorktreeToolCall({ toolName: 'write', input: { path: productPath } }, { cwd: root }, { worktreeRoot: root, label: 'fence', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [] });
    if (decision === undefined || decision.block !== true) throw new Error('product-path write must be blocked');
    assert.match(decision.reason, /outside the exactly-five charter paths/u);
  });

  void it('blocks a write to a non-charter file inside the runtime dir (not the whole runtime root)', () => {
    const { root, runtimeDir } = tempWorktree();
    const charterPaths = ['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl'].map((n) => join(runtimeDir, n));
    // A file INSIDE the runtime dir but not one of the five is still blocked when
    // no auxiliary root is granted (the fence is exact-path, not runtime-wide).
    const extra = join(runtimeDir, 'scratch.txt');
    const decision = evaluateAutopilotWorktreeToolCall({ toolName: 'write', input: { path: extra } }, { cwd: root }, { worktreeRoot: root, label: 'fence', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [] });
    assert.ok(decision !== undefined && decision.block === true);
  });

  void it('blocks an external (absolute out-of-worktree) write target', () => {
    const { root, runtimeDir } = tempWorktree();
    const charterPaths = ['mission.md'].map((n) => join(runtimeDir, n));
    const external = join(realpathSync(tmpdir()), 'elsewhere-d65.txt');
    const decision = evaluateAutopilotWorktreeToolCall({ toolName: 'write', input: { path: external } }, { cwd: root }, { worktreeRoot: root, label: 'fence', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [] });
    assert.ok(decision !== undefined && decision.block === true);
  });

  void it('blocks every bash command during bootstrap, including product/external/runtime/child/coordinator effects', () => {
    const { root, runtimeDir } = tempWorktree();
    const charterPaths = ['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl'].map((name) => join(runtimeDir, name));
    const commands = [
      'printf pwn > PRODUCT.md',
      `printf pwn > ${join(runtimeDir, 'scratch.txt')}`,
      `printf pwn > ${join(realpathSync(tmpdir()), 'd65-outside.txt')}`,
      'node child-worker.mjs',
      'autopilot-coordinator start',
      'git status --short',
    ];
    for (const command of commands) {
      const decision = evaluateAutopilotWorktreeToolCall({ toolName: 'bash', input: { command } }, { cwd: root }, { worktreeRoot: root, label: 'fence', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [] });
      if (decision === undefined || decision.block !== true) throw new Error(`bootstrap bash must be blocked: ${command}`);
      assert.match(decision.reason, /bash is disabled during the D65 bootstrap-only/u);
    }
  });

  void it('allows a write under an explicit package-owned auxiliary root', () => {
    const { root, runtimeDir } = tempWorktree();
    const charterPaths = ['mission.md'].map((n) => join(runtimeDir, n));
    const auxRoot = join(root, '.pi', 'autopilot', 'wk', 'aux');
    mkdirSync(auxRoot, { recursive: true });
    const decision = evaluateAutopilotWorktreeToolCall({ toolName: 'write', input: { path: join(auxRoot, 'roster-snapshot.json') } }, { cwd: root }, { worktreeRoot: root, label: 'fence', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [auxRoot] });
    assert.equal(decision, undefined);
  });
});

void describe('legacy /autopilot arg parser byte-shape stability (item H)', () => {
  void it('returns exactly {workstream, remainder, rosterId} with no launchManifestPath field', () => {
    const parsed = parseAutopilotArgs('legacy-work --roster codex focus text');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const keys = Object.keys(parsed.value).sort();
    assert.deepEqual(keys, ['remainder', 'rosterId', 'workstream']);
    assert.ok(!('launchManifestPath' in parsed.value));
    assert.equal(parsed.value.workstream, 'legacy-work');
    assert.equal(parsed.value.rosterId, 'codex');
    assert.equal(parsed.value.remainder, 'focus text');
  });

  void it('the launch parser exposes launchManifestPath as a superset without changing the legacy result', () => {
    const legacy = parseAutopilotArgs('demo build the thing');
    const launch = parseAutopilotLaunchArgs('demo build the thing');
    assert.equal(legacy.ok, true);
    assert.equal(launch.ok, true);
    if (!legacy.ok || !launch.ok) return;
    // Legacy result has exactly three fields; launch result adds launchManifestPath.
    assert.deepEqual(Object.keys(legacy.value).sort(), ['remainder', 'rosterId', 'workstream']);
    assert.deepEqual(Object.keys(launch.value).sort(), ['launchManifestPath', 'remainder', 'rosterId', 'workstream']);
    assert.equal(launch.value.launchManifestPath, null);
    // The three shared value fields are identical.
    assert.equal(legacy.value.workstream, launch.value.workstream);
    assert.equal(legacy.value.remainder, launch.value.remainder);
    assert.equal(legacy.value.rosterId, launch.value.rosterId);
  });

  void it('the launch parser accepts --launch-manifest before and after --roster', () => {
    const before = parseAutopilotLaunchArgs('demo --launch-manifest /abs/manifest.json --roster codex intro');
    const after = parseAutopilotLaunchArgs('demo --roster codex --launch-manifest /abs/manifest.json intro');
    assert.equal(before.ok, true);
    assert.equal(after.ok, true);
    if (!before.ok || !after.ok) return;
    assert.equal(before.value.launchManifestPath, '/abs/manifest.json');
    assert.equal(after.value.launchManifestPath, '/abs/manifest.json');
    assert.equal(before.value.rosterId, 'codex');
    assert.equal(after.value.rosterId, 'codex');
    assert.equal(before.value.remainder, 'intro');
  });

  void it('rejects misplaced or duplicate manifest flags instead of silently entering legacy mode', () => {
    for (const input of [
      'demo task --launch-manifest /abs/manifest.json',
      'demo --foo --launch-manifest=/abs/manifest.json',
      'demo --launch-manifest /abs/one.json task --launch-manifest /abs/two.json',
    ]) {
      const parsed = parseAutopilotLaunchArgs(input);
      assert.equal(parsed.ok, false, input);
      if (!parsed.ok) assert.match(parsed.message, /must appear before task text/u);
    }
    const escaped = parseAutopilotLaunchArgs('demo -- --launch-manifest /literal/task/text');
    assert.equal(escaped.ok, true);
    if (escaped.ok) {
      assert.equal(escaped.value.launchManifestPath, null);
      assert.equal(escaped.value.remainder, '-- --launch-manifest /literal/task/text');
    }
  });

  void it('rejects a relative --launch-manifest path in the launch parser only', () => {
    const launch = parseAutopilotLaunchArgs('demo --launch-manifest relative/path.json');
    assert.equal(launch.ok, false);
    // The legacy parser never sees --launch-manifest; it treats it as remainder.
    const legacy = parseAutopilotArgs('demo --launch-manifest relative/path.json');
    assert.equal(legacy.ok, true);
    if (!legacy.ok) return;
    assert.equal(legacy.value.remainder, '--launch-manifest relative/path.json');
  });
});
