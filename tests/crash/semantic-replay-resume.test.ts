import assert from 'node:assert/strict';
import { spawn, type ChildProcessLite } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore, stageCoordinatorSemanticReplay, type CoordinatorSemanticReplayBoundary } from '../../src/core/coordination/store.ts';
import type { CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const helper = join(packageRoot, 'tests', 'helpers', 'semantic-replay-process.ts');
const boundaries: readonly CoordinatorSemanticReplayBoundary[] = ['stage-validated', 'batch-applied', 'records-applied', 'database-completed', 'receipt-projected', 'inbox-cleaned'];

function attachRun(stateRoot: string, suffix: string): CoordinatorRequestEnvelope {
  const repository = 'semantic-crash-repo';
  const run = `semantic-crash-run-${suffix}`;
  const source = join(stateRoot, 'repository');
  const digest = createHash('sha256').update(suffix).digest('hex');
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: `semantic-crash-request-${suffix}`,
    action: 'attach-run', idempotency_key: `semantic-crash-attach-${suffix}`, repo_id: repository, workstream_run: run,
    session_id: null, fencing_generation: null, expected_version: 0,
    payload: {
      repo_key: repository, canonical_root: source, git_common_dir: join(source, '.git'), autopilot_id: `semantic-crash-${suffix}`,
      workstream: `semantic-crash-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1',
      run_resource: {
        schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repository, workstream_run: run, source_repo: source,
        git_common_dir: join(source, '.git'), worktree_root: join(stateRoot, 'worktrees', repository),
        main_worktree_path: join(stateRoot, 'worktrees', repository, 'active', run, 'main'),
        runtime_root: join(stateRoot, 'worktrees', repository, 'active', run, 'main', '.pi', 'autopilot', suffix),
        branch: `autopilot/${run}`, target_branch: null, target_base_sha: digest.slice(0, 40), origin_url: null,
        started_at: '2026-07-13T00:00:00.000Z', version: 1,
      },
    },
  };
}

function closed(child: ChildProcessLite): Promise<void> {
  return new Promise((resolveClose) => child.once('close', () => resolveClose()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('timed out waiting for semantic replay crash boundary');
}

void describe('semantic replay hard-kill recovery', () => {
  for (const boundary of boundaries) {
    void it(`restarts idempotently after a real hard kill at ${boundary}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `pi-autopilot-semantic-${boundary}-`));
      const stateRoot = join(root, 'state');
      const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
      const paths = coordinatorRuntimePaths(env);
      let child: ChildProcessLite | null = null;
      try {
        await stageCoordinatorSemanticReplay(paths, `crash-${boundary}`, [attachRun(stateRoot, 'one'), attachRun(stateRoot, 'two')]);
        child = spawn(process.execPath, ['--experimental-strip-types', helper, stateRoot, boundary], { cwd: packageRoot, env: { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        let stderr = '';
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        const childClosed = closed(child);
        await waitFor(() => existsSync(join(stateRoot, `semantic-replay-${boundary}.ready`)) || child?.exitCode !== null);
        assert.equal(child.exitCode, null, `semantic replay helper exited before boundary: ${stderr}`);
        hardKillProcess(child);
        await childClosed;
        child = null;

        const recovered = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-13T03:00:00.000Z') });
        const status = recovered.status('semantic-crash-repo', null);
        const runs = status.payload['runs'];
        assert.equal(Array.isArray(runs) ? runs.length : -1, 2, 'restart must expose the complete corpus exactly once');
        const doctor = recovered.doctor();
        assert.equal(doctor.payload['healthy'], true);
        assert.equal(doctor.payload['invariant_error_count'], 0);
        recovered.close();
        assert.equal(existsSync(paths.semanticReplayPath), false);
        assert.equal(existsSync(join(paths.semanticReplayReceiptsRoot, `crash-${boundary}.json`)), true);
      } finally {
        if (child !== null && child.exitCode === null) hardKillProcess(child);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
