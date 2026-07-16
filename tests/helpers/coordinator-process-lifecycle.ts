import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import type { ChildProcessLite } from 'node:child_process';

import { isExactProcessAlive, isProcessAlive, processStartIdentity, retireExactProcess } from '../../src/core/coordination/process-identity.ts';

/**
 * Centralized coordinator process-lifecycle helper for test suites (S0-B).
 *
 * Root cause of the 2026-07-16 leak (program doc §12.1): client auto-start
 * spawns the coordinator `detached: true` + `unref()`, so the coordinator
 * outlives the test process by design; suite teardown paths that threw,
 * timed out, or asserted before their `stopCoordinator`/`stopSpawnedCoordinator`
 * call stranded live coordinators against already-deleted temp state roots.
 * Five such processes survived for days.
 *
 * This helper provides:
 *  - `stopCoordinatorByLock`   — shared graceful-then-forced stop for lock-published coordinators;
 *  - `stopSpawnedChild`        — shared graceful-then-forced stop for directly spawned children;
 *  - `stopTestCoordinatorsForStateRoot` — closes the pre-lock detached-startup window by exact temp-root argv;
 *  - `assertNoLeakedCoordinators` — a process-table sweep that fails the suite loudly when a
 *    coordinator serving a temp-dir state root survives, then kills it so one
 *    red run cannot strand processes for days.
 *
 * The sweep matches only `autopilot-coordinator*.js serve --state-root <tmpdir>/…`
 * argv shapes, so it can never touch a production coordinator (whose state
 * root lives under `~/.pi/agent/autopilot`), other users' processes, or
 * unrelated node programs. This is test infrastructure: identity here is the
 * exact argv + temp-root containment, deliberately independent of the
 * package's own lock files, because a leaked coordinator's state root (and
 * lock) has usually already been deleted.
 */

const trackedPids = new Set<number>();
const trackedStateRoots = new Set<string>();

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !isProcessAlive(pid);
}

async function terminateExactPid(pid: number, identity: string, label: string): Promise<void> {
  if (!isExactProcessAlive(pid, identity)) return;
  retireExactProcess(pid, identity);
  if (await waitForExit(pid, 2_000)) return;
  // The process may be blocked before signal handlers are installed. Re-attest
  // process birth immediately before the forced test-only kill.
  assert.equal(isExactProcessAlive(pid, identity), true, `${label} pid ${String(pid)} changed identity during cleanup`);
  process.kill(pid, 'SIGKILL');
  assert.equal(await waitForExit(pid, 5_000), true, `${label} pid ${String(pid)} did not exit during test cleanup`);
}

/** Graceful-then-forced stop for a coordinator that published the given lifecycle lock. */
export async function stopCoordinatorByLock(lockPath: string): Promise<void> {
  let text: string;
  try { text = await readFile(lockPath, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  let pid: unknown;
  let identity: unknown;
  try {
    const parsed = JSON.parse(text) as { readonly pid?: unknown; readonly process_start_identity?: unknown };
    pid = parsed.pid;
    identity = parsed.process_start_identity;
  } catch { return; }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof identity !== 'string') return;
  trackedPids.add(pid);
  await terminateExactPid(pid, identity, 'lock-published coordinator');
}

/** Graceful-then-forced stop for a directly spawned coordinator child. */
export async function stopSpawnedChild(child: ChildProcessLite | null): Promise<void> {
  const pid = child?.pid;
  if (child === null || pid === undefined || child.exitCode !== null || !isProcessAlive(pid)) return;
  trackedPids.add(pid);
  const identity = processStartIdentity(pid);
  // A directly spawned child can be a kernel-reaped/zombie edge where kill(0)
  // still succeeds while libproc no longer reports birth identity. Fail closed:
  // do not signal without identity. The exact temp-state-root sweep handles a
  // distinct still-live detached replacement, and the after-hook proves none
  // survives.
  if (identity === null) return;
  await terminateExactPid(pid, identity, 'spawned coordinator child');
}

interface LeakedCoordinator {
  readonly pid: number;
  readonly process_start_identity: string;
  readonly command: string;
}

function normalizedPath(path: string): string {
  const resolved = resolve(path);
  // macOS reports the same temporary path as /var/... or /private/var/...
  // depending on whether it came from tmpdir(), argv, or a symlink-resolved cwd.
  const normalized = resolved.startsWith('/private/var/') ? resolved.slice('/private'.length) : resolved;
  return platform() === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isContainedInTemp(path: string): boolean {
  const root = normalizedPath(tmpdir());
  const candidate = normalizedPath(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function processTable(): string {
  if (platform() === 'win32') {
    // tasklist omits command lines; CIM supplies the exact argv needed for the
    // state-root ownership fence. This is test-only, read-only enumeration.
    return execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }",
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  }
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function listCoordinatorProcesses(stateRootFilter?: string): readonly LeakedCoordinator[] {
  // The process table is read-only; identity/kill decisions match on the exact
  // coordinator argv shape plus temp-root containment only.
  const output = processTable();
  const expectedStateRoot = stateRootFilter === undefined ? null : normalizedPath(stateRootFilter);
  const leaked: LeakedCoordinator[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? '';
    if (pid === process.pid) continue;
    if (!/autopilot-coordinator(?:-bootstrap)?\.(?:js|ts) serve --state-root /u.test(command)) continue;
    const stateRootMatch = / serve --state-root (?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command);
    const stateRoot = stateRootMatch?.[1] ?? stateRootMatch?.[2] ?? stateRootMatch?.[3];
    if (stateRoot === undefined) continue;
    const normalizedStateRoot = normalizedPath(stateRoot);
    if (expectedStateRoot !== null && normalizedStateRoot !== expectedStateRoot) continue;
    const ownedByThisSuite = trackedStateRoots.has(normalizedStateRoot) || trackedPids.has(pid);
    if (expectedStateRoot === null && !ownedByThisSuite) continue;
    if (!isContainedInTemp(normalizedStateRoot) && !trackedPids.has(pid)) continue;
    const identity = processStartIdentity(pid);
    if (identity === null) {
      if (isProcessAlive(pid)) throw new Error(`matching test coordinator pid ${String(pid)} has no exact process-birth identity`);
      continue;
    }
    leaked.push({ pid, process_start_identity: identity, command });
  }
  return leaked;
}

/**
 * Stop every coordinator whose exact argv names one isolated test state root.
 * This closes the pre-lock startup window: a tiny client readiness timeout can
 * expire before the detached child publishes its lifecycle lock, so lock-only
 * teardown cannot find it. Production roots are rejected before process-table
 * inspection.
 */
export async function stopTestCoordinatorsForStateRoot(stateRoot: string): Promise<void> {
  assert.equal(isContainedInTemp(stateRoot), true, `test coordinator state root must stay inside ${tmpdir()}`);
  trackedStateRoots.add(normalizedPath(stateRoot));
  for (const entry of listCoordinatorProcesses(stateRoot)) await terminateExactPid(entry.pid, entry.process_start_identity, 'test-state-root coordinator');
}

/**
 * Final sweep: fail loudly when a coordinator serving a state root registered
 * by this suite (or an explicitly registered pid) survived, then terminate it
 * so a failing run cannot strand processes. It deliberately ignores other
 * concurrently-running test files' temp roots. Call from a root `after()` hook
 * in every suite that can spawn coordinators (directly or through client
 * auto-start).
 */
export async function assertNoLeakedCoordinators(): Promise<void> {
  const leaked = listCoordinatorProcesses();
  for (const entry of leaked) await terminateExactPid(entry.pid, entry.process_start_identity, 'leaked coordinator');
  trackedPids.clear();
  trackedStateRoots.clear();
  assert.equal(
    leaked.length,
    0,
    `coordinator process leak: ${leaked.map((entry) => `pid=${String(entry.pid)} cmd=${entry.command}`).join('; ')} — a spawn/teardown path skipped its stop call`,
  );
}
