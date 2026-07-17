import assert from 'node:assert/strict';
import { spawn, type ChildProcessLite } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import type { StorePublicationBoundary } from '../../src/core/coordination/store-generation.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';

const RESTORE_BOUNDARIES = ['staging-created', 'source-captured', 'integrity-verified', 'database-fsynced', 'publication-fsynced', 'generation-renamed', 'pointer-replaced', 'coordinator-directory-fsynced'] as const satisfies readonly StorePublicationBoundary[];
const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const helper = join(packageRoot, 'tests', 'helpers', 'generation-restore-process.ts');

async function lineFrom(child: ChildProcessLite): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => rejectLine(new Error(`restore helper timed out: ${stderr}`)), 15_000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolveLine(stdout.slice(0, newline));
    });
    child.once('close', (code) => {
      if (stdout.includes('\n')) return;
      clearTimeout(timer);
      rejectLine(new Error(`restore helper exited ${String(code)}: ${stderr}`));
    });
  });
}

async function waitForClose(child: ChildProcessLite): Promise<void> {
  await new Promise<void>((resolveClose) => {
    if (child.exitCode !== null) { resolveClose(); return; }
    child.once('close', () => resolveClose());
  });
}

void describe('S1 fresh-generation restore hard-death recovery', () => {
  for (const boundary of RESTORE_BOUNDARIES) {
    void it(`selects the complete old or restored generation after ${boundary}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `pi-autopilot-s1-restore-${boundary}-`));
      const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
      const initial = await CoordinatorStore.open(paths);
      const oldGeneration = initial.currentGeneration().pointer.generation_id;
      const backup = join(paths.backupsRoot, 'restore-hard-death-source.db');
      let backupSha256: `sha256:${string}`;
      try { backupSha256 = (await initial.createVerifiedBackup(backup)).sha256; }
      finally { initial.close(); }
      const child = spawn(process.execPath, ['--experimental-strip-types', helper, boundary, backup, backupSha256], { cwd: packageRoot, env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let killed = false;
      try {
        const reached: unknown = JSON.parse(await lineFrom(child)) as unknown;
        assert.deepEqual(reached, { state: 'boundary', boundary, pid: child.pid });
        hardKillProcess(child);
        await waitForClose(child);
        killed = true;
        const recovered = await CoordinatorStore.open(paths);
        try {
          const current = recovered.currentGeneration();
          const pointerWasPublished = boundary === 'pointer-replaced' || boundary === 'coordinator-directory-fsynced';
          assert.equal(current.pointer.generation_id === oldGeneration, !pointerWasPublished);
          if (pointerWasPublished) {
            assert.equal(current.pointer.previous_generation_id, oldGeneration);
            assert.equal(current.publication.source_kind, 's1-generation-restore');
            assert.equal(current.publication.source_generation_id, oldGeneration);
          }
          assert.equal(recovered.integrity(), 'ok');
        } finally { recovered.close(); }
      } finally {
        if (!killed) { hardKillProcess(child); await waitForClose(child); }
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
