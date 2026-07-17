import assert from 'node:assert/strict';
import { spawn, type ChildProcessLite } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { STORE_GENERATION_ID_PATTERN, STORE_PUBLICATION_BOUNDARIES, type StorePublicationBoundary } from '../../src/core/coordination/store-generation.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const helper = join(packageRoot, 'tests', 'helpers', 'generation-publication-process.ts');

function startPublisher(stateRoot: string, boundary: StorePublicationBoundary): ChildProcessLite {
  return spawn(process.execPath, ['--experimental-strip-types', helper, boundary], {
    cwd: packageRoot,
    env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
}

async function firstLine(child: ChildProcessLite): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => rejectLine(new Error(`publisher timed out: ${stderr}`)), 15_000);
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
      rejectLine(new Error(`publisher exited ${String(code)}: ${stderr}`));
    });
  });
}

async function waitForClose(child: ChildProcessLite): Promise<void> {
  await new Promise<void>((resolveClose) => {
    if (child.exitCode !== null) { resolveClose(); return; }
    child.once('close', () => resolveClose());
  });
}

void describe('S1 store publication hard-death recovery', () => {
  for (const boundary of STORE_PUBLICATION_BOUNDARIES) {
    void it(`recovers complete authority after process death at ${boundary}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `pi-autopilot-s1-hard-publish-${boundary}-`));
      const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
      const child = startPublisher(root, boundary);
      let killed = false;
      try {
        const reached: unknown = JSON.parse(await firstLine(child)) as unknown;
        assert.deepEqual(reached, { state: 'boundary', boundary, pid: child.pid });
        hardKillProcess(child);
        await waitForClose(child);
        killed = true;
        const recovered = await CoordinatorStore.open(paths);
        try {
          assert.equal(recovered.integrity(), 'ok');
          assert.equal(recovered.currentGeneration().pointer.store_schema_version, 13);
          const entries = await readdir(paths.storesRoot);
          assert.deepEqual(entries.filter((name) => name.startsWith('.staging-')), []);
          assert.deepEqual((await readdir(paths.coordinatorRoot)).filter((name) => name.startsWith('.current-store.') && name.endsWith('.tmp')), []);
          for (const name of entries.filter((entry) => STORE_GENERATION_ID_PATTERN.test(entry))) {
            assert.equal(existsSync(join(paths.storesRoot, name, 'coordinator.db')), true, `${name} lacks a database`);
            assert.equal(existsSync(join(paths.storesRoot, name, 'publication.json')), true, `${name} lacks publication evidence`);
          }
        } finally { recovered.close(); }
      } finally {
        if (!killed) { hardKillProcess(child); await waitForClose(child); }
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
