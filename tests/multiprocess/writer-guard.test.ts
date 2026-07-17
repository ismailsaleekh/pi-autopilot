import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessLite } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const helper = join(packageRoot, 'tests', 'helpers', 'writer-guard-process.ts');

function startHolder(stateRoot: string): ChildProcessLite {
  return spawn(process.execPath, ['--experimental-strip-types', helper, '5000', 'hold'], {
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
    const timer = setTimeout(() => rejectLine(new Error(`writer guard holder timed out: ${stderr}`)), 10_000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolveLine(stdout.slice(0, newline));
    });
    child.once('close', (code) => {
      if (stdout.indexOf('\n') >= 0) return;
      clearTimeout(timer);
      rejectLine(new Error(`writer guard holder exited ${String(code)}: ${stderr}`));
    });
  });
}

async function waitForClose(child: ChildProcessLite): Promise<void> {
  await new Promise<void>((resolveClose) => {
    if (child.exitCode !== null) { resolveClose(); return; }
    child.once('close', () => resolveClose());
  });
}

void describe('S1 SQLite process-lifetime writer guard', () => {
  void it('excludes a second process and recovers only after hard process death', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'pi-autopilot-writer-guard-'));
    const holder = startHolder(stateRoot);
    let holderRetired = false;
    try {
      const acquired: unknown = JSON.parse(await firstLine(holder)) as unknown;
      assert.deepEqual(acquired, { state: 'acquired', pid: holder.pid });
      const contender = spawnSync(process.execPath, ['--experimental-strip-types', helper, '100', 'once'], {
        cwd: packageRoot,
        env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(contender.status, 70, contender.stderr);
      assert.match(contender.stdout, /SQLite writer guard acquisition failed/u);
      hardKillProcess(holder);
      await waitForClose(holder);
      holderRetired = true;
      const recovered = spawnSync(process.execPath, ['--experimental-strip-types', helper, '5000', 'once'], {
        cwd: packageRoot,
        env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.match(recovered.stdout, /"state":"acquired"/u);
    } finally {
      if (!holderRetired) {
        hardKillProcess(holder);
        await waitForClose(holder);
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
