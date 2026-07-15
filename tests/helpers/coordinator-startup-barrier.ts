import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STARTUP_BARRIER_ENV = 'AUTOPILOT_COORDINATOR_STARTUP_BARRIER_ROOT';

export type StartupBoundary =
  | 'before-lifecycle-election'
  | 'after-lifecycle-lock-acquisition'
  | 'before-private-root-capability-setup'
  | 'after-private-root-capability-setup'
  | 'before-sqlite-open-reconciliation'
  | 'after-sqlite-open-reconciliation'
  | 'before-socket-bind'
  | 'after-listen-before-lifecycle-activation'
  | 'after-activation-before-first-handshake'
  | 'first-exact-handshake-served';

function marker(root: string, kind: 'pause' | 'reached' | 'release', boundary: StartupBoundary): string {
  return join(root, `${kind}.${boundary}`);
}

export async function armStartupBarrier(root: string, boundary: StartupBoundary): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(marker(root, 'pause', boundary), 'armed\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

export async function releaseStartupBarrier(root: string, boundary: StartupBoundary): Promise<void> {
  await writeFile(marker(root, 'release', boundary), 'release\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

export async function waitForStartupBarrier(root: string, boundary: StartupBoundary, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(marker(root, 'reached', boundary))) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`startup barrier ${boundary} was not reached before timeout`);
}
