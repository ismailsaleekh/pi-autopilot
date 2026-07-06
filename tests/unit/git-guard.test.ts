import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluateAutopilotWorktreeToolCall } from '../../src/core/git-guard.ts';

async function withRoots<T>(run: (roots: { readonly root: string; readonly worktree: string; readonly outside: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-git-guard-'));
  const worktree = join(root, 'worktree');
  const outside = join(root, 'source');
  try {
    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(worktree, 'inside.txt'), 'inside\n', 'utf8');
    await writeFile(join(outside, 'outside.txt'), 'outside\n', 'utf8');
    return await run({ root, worktree, outside });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function guard(command: string, cwd: string, worktree: string) {
  return evaluateAutopilotWorktreeToolCall(
    { toolName: 'bash', input: { command } },
    { cwd },
    { worktreeRoot: worktree, label: 'test guard' },
  );
}

void describe('Autopilot worktree git guard', () => {
  void it('allows local git commands whose effective cwd is the registered worktree', async () => {
    await withRoots(async ({ worktree }) => {
      assert.equal(guard('git status', worktree, worktree), undefined);
      assert.equal(guard('git add inside.txt && git commit -m ok', worktree, worktree), undefined);
      assert.equal(guard('git reset --hard HEAD', worktree, worktree), undefined);
      assert.equal(guard(`bash -lc 'git -C ${worktree} status'`, worktree, worktree), undefined);
    });
  });

  void it('blocks git commands that resolve outside the registered worktree', async () => {
    await withRoots(async ({ worktree, outside }) => {
      assert.match(guard('git status', outside, worktree)?.reason ?? '', /outside the registered Autopilot worktree/u);
      assert.match(guard(`git -C ${outside} status`, worktree, worktree)?.reason ?? '', /outside the registered Autopilot worktree/u);
      assert.match(guard(`cd ${outside} && git status`, worktree, worktree)?.reason ?? '', /outside the registered Autopilot worktree/u);
      assert.match(guard(`bash -lc 'git -C ${outside} status'`, worktree, worktree)?.reason ?? '', /outside the registered Autopilot worktree/u);
      assert.match(guard(`echo $(git -C ${outside} status)`, worktree, worktree)?.reason ?? '', /outside the registered Autopilot worktree/u);
    });
  });

  void it('blocks git remapping and remote/external subcommands', async () => {
    await withRoots(async ({ worktree }) => {
      assert.match(guard('GIT_WORK_TREE=/tmp git status', worktree, worktree)?.reason ?? '', /GIT_WORK_TREE/u);
      assert.match(guard('GIT_CONFIG_PARAMETERS=core.worktree=/tmp git status', worktree, worktree)?.reason ?? '', /GIT_CONFIG_PARAMETERS/u);
      assert.match(guard('env GIT_DIR=/tmp/repo git status', worktree, worktree)?.reason ?? '', /GIT_DIR/u);
      assert.match(guard('git --git-dir .git status', worktree, worktree)?.reason ?? '', /--git-dir/u);
      assert.match(guard('git --work-tree . status', worktree, worktree)?.reason ?? '', /--work-tree/u);
      assert.match(guard('git -c core.worktree=/tmp status', worktree, worktree)?.reason ?? '', /core\.worktree/u);
      assert.match(guard('git --config-env=core.worktree=WT status', worktree, worktree)?.reason ?? '', /config-env/u);
      assert.match(guard('git fetch origin', worktree, worktree)?.reason ?? '', /not local/u);
      assert.match(guard('git remote -v', worktree, worktree)?.reason ?? '', /not local/u);
      assert.match(guard('git worktree list', worktree, worktree)?.reason ?? '', /not local/u);
      assert.equal(guard(`git -C ${worktree} branch`, worktree, worktree), undefined);
      assert.match(guard('git branch new-branch', worktree, worktree)?.reason ?? '', /branch mutation/u);
      assert.match(guard('git branch -D main', worktree, worktree)?.reason ?? '', /branch mutation/u);
      assert.equal(guard('git tag --list', worktree, worktree), undefined);
      assert.match(guard('git tag release-test', worktree, worktree)?.reason ?? '', /tag mutation/u);
    });
  });

  void it('blocks write and edit tool targets outside the worktree and allowed artifact roots', async () => {
    await withRoots(async ({ root, worktree, outside }) => {
      const artifactRoot = join(root, 'runtime');
      await mkdir(artifactRoot, { recursive: true });
      assert.equal(
        evaluateAutopilotWorktreeToolCall(
          { toolName: 'write', input: { path: join(worktree, 'ok.txt') } },
          { cwd: worktree },
          { worktreeRoot: worktree, label: 'test guard' },
        ),
        undefined,
      );
      assert.equal(
        evaluateAutopilotWorktreeToolCall(
          { toolName: 'write', input: { path: join(artifactRoot, 'unit-spec.json') } },
          { cwd: worktree },
          { worktreeRoot: worktree, label: 'test guard', allowedWriteRoots: [artifactRoot] },
        ),
        undefined,
      );
      assert.match(
        evaluateAutopilotWorktreeToolCall(
          { toolName: 'edit', input: { path: join(outside, 'bad.txt') } },
          { cwd: worktree },
          { worktreeRoot: worktree, label: 'test guard', allowedWriteRoots: [artifactRoot] },
        )?.reason ?? '',
        /outside the registered Autopilot worktree/u,
      );
    });
  });
});
