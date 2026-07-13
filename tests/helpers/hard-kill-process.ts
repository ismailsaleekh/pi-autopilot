import { spawnSync, type ChildProcessLite } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Terminates a test subprocess without running JS signal/finally handlers.
 * Windows has no SIGKILL; taskkill /F is the equivalent hard process-tree
 * termination. Unix uses SIGKILL directly.
 */
export function hardKillProcess(child: ChildProcessLite): void {
  const pid = child.pid;
  if (pid === undefined) throw new Error('cannot hard-kill a subprocess without a pid');
  if (platform() === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
    if (killed.status !== 0 && !/not found|no running instance/iu.test(`${killed.stdout}\n${killed.stderr}`)) throw new Error(`taskkill failed for pid ${String(pid)}: ${killed.stderr}`);
    return;
  }
  process.kill(pid, 'SIGKILL');
}
