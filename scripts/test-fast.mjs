// Fast offline test orchestrator (Phase 40 / D70, change C5 + C1 + C2 driver).
//
// Runs the COMPLETE deterministic offline pi-autopilot test suite — the exact
// same lanes, files, and assertions as the serial `test:serial` path — but:
//   * builds dist/ ONCE (the serial scripts rebuild it up to 8× per full run);
//   * routes TMPDIR/TMP/TEMP, npm cache, Node compile cache, and every SQLite/
//     WAL/git/pack fixture onto a RAM-backed root (scripts/test-ram-root.mjs);
//   * enables NODE_COMPILE_CACHE so the many strip-types subprocess launches
//     reuse compiled bytecode;
//   * runs independent lanes as concurrent child processes under a global
//     worker budget, with per-lane `--test-concurrency` from a measured
//     allowlist, keeping the multiprocess release-trace as the exclusive long
//     pole and the package lane globally exclusive (dist/prepack race safety);
//   * writes a full per-lane TAP log plus a concise final summary and emits the
//     same per-test identity stream as the serial path for the parity oracle.
//
// It is FAIL-CLOSED: the first lane failure is surfaced with that lane's full
// TAP output, all started lanes are aggregated, and the process exits non-zero.
// No silent fallback, no swallowed error, no retry-to-green, no fake-green.
//
// SIGINT/SIGTERM stop NEW scheduling, let in-flight lanes finish their own exact
// teardown (each lane's node:test after() hooks prove no coordinator leaked),
// then unmount/remove the RAM root. Sibling lanes are never abruptly killed
// because their coordinator process trees are only proven-clean by their own
// teardown; abrupt kills could strand detached coordinators.
//
// This file changes ZERO test content and ZERO production source. Durability
// PRAGMAs, wire protocol, store schema, and coordinator authority are untouched.

import { spawn } from 'node:child_process';
import { closeSync, globSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireTestRamRoot } from './test-ram-root.mjs';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const IDENTITY_REPORTER = join(PACKAGE_ROOT, 'scripts', 'test-identity-reporter.mjs');

// ---- Lane definitions -------------------------------------------------------
//
// Each lane maps 1:1 to a serial `test:<lane>` script's file set and node args.
// `concurrency` is the per-lane `--test-concurrency` (cross-FILE parallelism;
// node:test still runs one process per file, so per-file isolation is intact).
// `weight` is the global worker-budget cost used by the scheduler.
// `exclusive: true` lanes run alone (no other lane concurrent):
//   * multiprocess — real-process startup deadlines + the O(1)-cadence 32-client
//     release trace are performance-sensitive and must not contend for cores;
//   * package — its `npm pack` witnesses execute `prepack` (rm -rf dist && tsc),
//     which would race any lane importing/spawning the live dist/ tree.
//
// The per-lane concurrency values are the MEASURED allowlist (C2): lanes whose
// files are all per-file-isolated run at core count; the exclusive lanes stay at
// 1 exactly as the serial scripts require.

const CORES = Math.max(1, availableParallelism?.() ?? cpus().length);
const LANE_CONCURRENCY = Math.max(2, Math.min(8, CORES));

// Explicit serial allowlist (D70 change C2): the ONLY unit-lane file that reads
// the global OS process table via `assertNoLeakedCoordinators`. It is measured
// self-scoped (its sweep only touches roots this suite tracked), but per the
// design it stays in its own serial sub-lane until a regression proves it can
// share the field — fail-safe, not fail-open. The other five process-table
// files live in the already-exclusive multiprocess/package lanes.
const UNIT_SERIAL_ALLOWLIST = ['tests/unit/coordinator-readiness-window.test.ts'];

// Build-mutating e2e file (D70 change C5/§5): it runs `npm run build`
// (rm -rf dist && tsc) in the LIVE package root, so it must never run
// concurrently with any lane importing/spawning the live dist/. It is pulled
// out of the parallel e2e lane and scheduled globally exclusive, like package.
const E2E_BUILD_MUTATING = ['tests/e2e/s1-corpus-synthetic-worker.test.ts'];

// The 5/10/32-client persistent release-trace cohorts (D70 C3+C4). Each sibling
// file drives one cohort against its own coordinator/sockets/state root, so they
// run concurrently in a dedicated exclusive sub-lane instead of serially in one
// giant file. The 32-client trace remains the honest floor.
const MULTIPROCESS_TRACE_COHORTS = [
  'tests/multiprocess/coordinator-release-trace-5.test.ts',
  'tests/multiprocess/coordinator-release-trace-10.test.ts',
  'tests/multiprocess/coordinator-release-trace-32.test.ts',
];

// Multiprocess files that stay STRICTLY SERIAL even inside the exclusive
// multiprocess window, because they either read the global OS process table via
// assertNoLeakedCoordinators or assert on fixed real-process startup/election
// deadlines that a contended CPU could invalidate. Everything else in the
// multiprocess directory is measured parallel-safe (proven: a concurrency-3 run
// of the other 11 files passed 62/62 with zero leaks) and runs in a concurrent
// sub-lane. `coordinator-process` (lifecycle election/restart, global sweep) and
// `coordinator-startup-state-machine` (fixed deadlines + global sweep) stay
// serial; the cf50/s2 skew files hold global sweeps; `semantic-graph-authority`
// asserts on real-process deadlines.
const MULTIPROCESS_SERIAL = [
  'tests/multiprocess/cf50-s1-version-skew.test.ts',
  'tests/multiprocess/coordinator-process.test.ts',
  'tests/multiprocess/coordinator-startup-state-machine.test.ts',
  'tests/multiprocess/s2-version-skew.test.ts',
  'tests/multiprocess/semantic-graph-authority.test.ts',
  // Measurement-driven addition (D70): a conflicting-process-writer race test.
  // It spawns concurrent processes racing to create the SAME roster authority
  // file and asserts exactly one create-only winner; under a contended CPU the
  // create-only hardlink-proof timing shifted and it transiently reported
  // ROSTER_STORAGE_AUTHORITY_UNSAFE in a full concurrent run. A conflicting-writer
  // timing test must not share CPU with sibling lane files — it stays serial.
  'tests/multiprocess/roster-selection-publication.test.ts',
];

/** @typedef {{ name: string, nodeArgs: string[], files: string | string[], exclude?: string[], concurrency: number, weight: number, exclusive: boolean }} Lane */

/** @type {Lane[]} */
const LANES = [
  // Pure/typed unit files: fully per-file isolated (§2.1). Parallel at core count.
  // The global-process-table allowlist file is excluded and run in unit-serial.
  { name: 'unit', nodeArgs: [], files: 'tests/unit/*.test.ts', exclude: UNIT_SERIAL_ALLOWLIST, concurrency: LANE_CONCURRENCY, weight: LANE_CONCURRENCY, exclusive: false },
  // Unit serial allowlist: the lone global-process-table unit file, run serially
  // in its own slot so its sweep never observes a concurrent file's coordinator.
  { name: 'unit-serial', nodeArgs: [], files: UNIT_SERIAL_ALLOWLIST, concurrency: 1, weight: 1, exclusive: false },
  // E2E fake-Pi witnesses: own mkdtemp roots + private sockets. Parallel, minus
  // the build-mutating file which is scheduled globally exclusive below.
  { name: 'e2e', nodeArgs: [], files: 'tests/e2e/*.test.ts', exclude: E2E_BUILD_MUTATING, concurrency: LANE_CONCURRENCY, weight: LANE_CONCURRENCY, exclusive: false },
  // E2E build-mutating file: exclusive because it rebuilds the live dist tree.
  { name: 'e2e-build', nodeArgs: [], files: E2E_BUILD_MUTATING, concurrency: 1, weight: CORES, exclusive: true },
  // Model/property: pure. Serial script had no concurrency flag (node default);
  // keep node default here too (do not force it lower or higher than serial).
  { name: 'model', nodeArgs: [], files: 'tests/model/*.test.ts', concurrency: null, weight: 2, exclusive: false },
  // Crash-injection: own roots + real SIGKILL of own subprocesses. Parallel.
  { name: 'crash', nodeArgs: [], files: 'tests/crash/*.test.ts', concurrency: LANE_CONCURRENCY, weight: LANE_CONCURRENCY, exclusive: false },
  // Chaos: byte/git drift + symlink refusal on own roots. Parallel.
  { name: 'chaos', nodeArgs: [], files: 'tests/chaos/*.test.ts', concurrency: LANE_CONCURRENCY, weight: 3, exclusive: false },
  // Scale: 100k-event replay under a 256 MiB old-space ceiling. Serial (1) and
  // memory-capped exactly as the serial script. Runs concurrently with others
  // but counts heavy weight so the budget accounts for its RSS.
  { name: 'scale', nodeArgs: ['--max-old-space-size=256'], files: 'tests/scale/*.test.ts', concurrency: 1, weight: 2, exclusive: false },
  // SDK: real Pi extension load, isolated temp cwd/agentDir. Parallel.
  { name: 'sdk', nodeArgs: [], files: 'tests/sdk/*.test.ts', concurrency: LANE_CONCURRENCY, weight: 3, exclusive: false },
  // RPC: offline pi --mode rpc, isolated HOME/session. Serial script had no flag.
  { name: 'rpc', nodeArgs: [], files: 'tests/rpc/*.test.ts', concurrency: null, weight: 2, exclusive: false },
  // Multiprocess SERIAL sub-lane: the global-process-table + fixed-deadline files
  // that must not share CPU with a sibling. Serial and exclusive vs all lanes.
  { name: 'multiprocess-serial', nodeArgs: [], files: MULTIPROCESS_SERIAL, concurrency: 1, weight: CORES, exclusive: true },
  // Multiprocess PARALLEL sub-lane: every other multiprocess file (measured
  // parallel-safe). Exclusive vs OTHER lanes (still timing-sensitive real
  // process work), but its own files run concurrently — the ~300s serial sum
  // collapses to ~60s at concurrency 3.
  { name: 'multiprocess-parallel', nodeArgs: [], files: 'tests/multiprocess/*.test.ts', exclude: [...MULTIPROCESS_TRACE_COHORTS, ...MULTIPROCESS_SERIAL], concurrency: 3, weight: CORES, exclusive: true },
  // Release-trace cohorts (5/10/32): each an independent coordinator + sockets +
  // state root, so the three sibling files run CONCURRENTLY (Phase 40 / D70
  // C3+C4). Exclusive vs other lanes; wall time collapses from 5+10+32 serial to
  // the 32-client time. Their self-scoped leak sweeps are proven (a concurrency-3
  // cohort run passed with zero leaks) not to observe each other's coordinators.
  { name: 'multiprocess-trace', nodeArgs: [], files: MULTIPROCESS_TRACE_COHORTS, concurrency: MULTIPROCESS_TRACE_COHORTS.length, weight: CORES, exclusive: true },
  // Package: exclusive — its pack witnesses run prepack (rm -rf dist && tsc).
  { name: 'package', nodeArgs: [], files: 'tests/package/*.test.ts', concurrency: 1, weight: CORES, exclusive: true },
];

// The standalone type-safety lane (`test:type-safety`) is a strict subset of the
// package lane's type-safety.test.ts and runs inside it; the serial `npm run test`
// chain also runs it standalone first. We run it standalone too for exact parity.
/** @type {Lane} */
const TYPE_SAFETY_LANE = { name: 'type-safety', nodeArgs: [], files: 'tests/package/type-safety.test.ts', concurrency: null, weight: 1, exclusive: false };

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const options = { identityDir: null, only: null, keepRoot: false, laneTimeoutMs: 20 * 60 * 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--identity-dir') { options.identityDir = argv[index + 1] ?? null; index += 1; continue; }
    if (arg === '--only') { options.only = (argv[index + 1] ?? '').split(',').filter((entry) => entry.length > 0); index += 1; continue; }
    if (arg === '--keep-root') { options.keepRoot = true; continue; }
    if (arg === '--lane-timeout-ms') { options.laneTimeoutMs = Number(argv[index + 1] ?? '0'); index += 1; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

// ---- Build once ------------------------------------------------------------

function runToCompletion(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} exited ${String(code)}\n${stderr}`));
    });
  });
}

async function buildDistOnce(env, logDir) {
  const started = Date.now();
  process.stdout.write('[test-fast] building dist/ once…\n');
  // Exactly the package `build` script: rm -rf dist && tsc -p tsconfig.build.json.
  rmSync(join(PACKAGE_ROOT, 'dist'), { recursive: true, force: true });
  const out = openSync(join(logDir, 'build.log'), 'w');
  try {
    await runToCompletion(process.execPath, [join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
      cwd: PACKAGE_ROOT, env, stdio: ['ignore', out, out],
    });
  } finally {
    closeSync(out);
  }
  process.stdout.write(`[test-fast] dist/ built in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

// ---- Lane execution --------------------------------------------------------

function laneArgv(lane, env) {
  const args = [...lane.nodeArgs, '--experimental-strip-types', '--test'];
  // Reporters MUST precede the file glob (node applies reporters declared before
  // positional test paths). Identity reporter → file; spec → the lane TAP log.
  args.push(`--test-reporter=${IDENTITY_REPORTER}`, `--test-reporter-destination=${env.__AP_IDENTITY_STDOUT__}`);
  args.push('--test-reporter=spec', `--test-reporter-destination=${env.__AP_TAP__}`);
  if (lane.concurrency !== null) args.push(`--test-concurrency=${String(lane.concurrency)}`);
  // Resolve the file set ourselves so we never rely on a shell.
  for (const file of laneFiles(lane)) args.push(file);
  return args;
}

function laneFiles(lane) {
  const excluded = new Set((lane.exclude ?? []).map((rel) => join(PACKAGE_ROOT, rel)));
  let files;
  if (Array.isArray(lane.files)) {
    files = lane.files.map((rel) => join(PACKAGE_ROOT, rel));
  } else {
    files = globSync(lane.files, { cwd: PACKAGE_ROOT }).map((entry) => join(PACKAGE_ROOT, entry));
  }
  files = files.filter((file) => !excluded.has(file)).sort();
  if (files.length === 0) throw new Error(`lane resolved no files: ${JSON.stringify(lane.files)}`);
  return files;
}

function startLane(lane, baseEnv, identityDir, logDir, laneTimeoutMs) {
  const tapPath = join(logDir, `tap-${lane.name}.log`);
  const identityOut = identityDir === null ? join(logDir, `identity-${lane.name}.jsonl`) : join(identityDir, `identity-${lane.name}.jsonl`);
  writeFileSync(identityOut, '');
  const identityStdout = join(logDir, `identity-stdout-${lane.name}.log`);
  const env = {
    ...baseEnv,
    AUTOPILOT_TEST_IDENTITY_OUT: identityOut,
    AUTOPILOT_TEST_IDENTITY_ROOT: PACKAGE_ROOT,
    __AP_TAP__: tapPath,
    __AP_IDENTITY_STDOUT__: identityStdout,
  };
  const args = laneArgv(lane, env);
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: PACKAGE_ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
  let stderr = '';
  if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let timedOut = false;
  const timer = laneTimeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, laneTimeoutMs) : null;
  const done = new Promise((resolveLane) => {
    child.on('error', (error) => { if (timer) clearTimeout(timer); resolveLane({ lane, code: null, error, stderr, tapPath, identityOut, durationMs: Date.now() - started, timedOut }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolveLane({ lane, code, error: null, stderr, tapPath, identityOut, durationMs: Date.now() - started, timedOut }); });
  });
  return { lane, child, done };
}

// ---- Scheduler -------------------------------------------------------------

async function scheduleLanes(lanes, baseEnv, identityDir, logDir, laneTimeoutMs, budget) {
  const pending = [...lanes];
  // Each running slot is a promise that resolves to { slot, result }, where
  // `slot` is a stable identity so we can remove exactly the finished slot from
  // the running set (racing a bare result object would lose that identity).
  const running = new Set();
  const results = [];
  let usedBudget = 0;
  let stopScheduling = false;
  let runningExclusive = false;

  const onSignal = (signal) => {
    process.stdout.write(`\n[test-fast] received ${signal}: stopping new scheduling; letting in-flight lanes finish their own teardown…\n`);
    stopScheduling = true;
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const canStart = (lane) => {
    if (running.size === 0) return true; // empty field: any lane (incl. exclusive) may start.
    if (lane.exclusive) return false; // an exclusive lane needs an empty field.
    if (runningExclusive) return false; // an exclusive lane is already running.
    return usedBudget + lane.weight <= budget;
  };

  while ((pending.length > 0 && !stopScheduling) || running.size > 0) {
    // Start every eligible pending lane the budget/exclusivity currently allows.
    if (!stopScheduling) {
      let startedAny = true;
      while (startedAny) {
        startedAny = false;
        for (let index = 0; index < pending.length; index += 1) {
          const lane = pending[index];
          if (!canStart(lane)) continue;
          pending.splice(index, 1);
          const entry = startLane(lane, baseEnv, identityDir, logDir, laneTimeoutMs);
          const slot = { entry, promise: null };
          slot.promise = entry.done.then((result) => ({ slot, result }));
          running.add(slot);
          usedBudget += lane.weight;
          if (lane.exclusive) runningExclusive = true;
          process.stdout.write(`[test-fast] ▶ lane ${lane.name} started (${String(running.size)} running, budget ${String(usedBudget)}/${String(budget)})\n`);
          startedAny = true;
          break; // re-evaluate from the top so exclusive gating stays correct.
        }
      }
    }
    if (running.size === 0) break; // nothing running and (stopScheduling or nothing eligible)
    const { slot, result } = await Promise.race([...running].map((entry) => entry.promise));
    running.delete(slot);
    usedBudget -= result.lane.weight;
    if (result.lane.exclusive) runningExclusive = false;
    results.push(result);
    const status = result.code === 0 && !result.timedOut && result.error === null ? 'PASS' : 'FAIL';
    process.stdout.write(`[test-fast] ${status === 'PASS' ? '✔' : '✗'} lane ${result.lane.name} ${status} in ${(result.durationMs / 1000).toFixed(1)}s\n`);
  }

  // If we stopped scheduling due to a signal, record the never-started lanes so
  // the run is reported as incomplete rather than silently green.
  const notStarted = pending.map((lane) => ({ lane, code: null, error: new Error('lane not started (scheduling stopped by signal)'), stderr: '', tapPath: null, identityOut: null, durationMs: 0, timedOut: false }));
  return { results, notStarted, stoppedBySignal: stopScheduling };
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = options.only === null
    ? [TYPE_SAFETY_LANE, ...LANES]
    : [TYPE_SAFETY_LANE, ...LANES].filter((lane) => options.only.includes(lane.name));
  if (selected.length === 0) throw new Error(`--only matched no lanes: ${String(options.only)}`);

  const logDir = join(PACKAGE_ROOT, 'artifacts', 'test-fast');
  mkdirSync(logDir, { recursive: true });
  if (options.identityDir !== null) mkdirSync(options.identityDir, { recursive: true });

  const totalStart = Date.now();
  process.stdout.write(`[test-fast] cores=${String(CORES)} lane-concurrency=${String(LANE_CONCURRENCY)} totalmem=${(totalmem() / 1024 / 1024 / 1024).toFixed(1)}GiB freemem=${(freemem() / 1024 / 1024 / 1024).toFixed(1)}GiB\n`);

  const ram = acquireTestRamRoot();
  process.stdout.write(`[test-fast] RAM root: ${ram.root} [${ram.backend}]\n`);

  // Safety net: if the orchestrator dies abnormally (OOM, uncaught error) the
  // `finally` teardown may be skipped, which would leak a RAM device/mount. A
  // best-effort synchronous release on process exit prevents a stranded mount.
  let ramReleased = false;
  const releaseRamOnce = () => {
    if (ramReleased || options.keepRoot) return;
    ramReleased = true;
    try { ram.release(); } catch { /* reported by the primary path or already gone */ }
  };
  process.once('exit', releaseRamOnce);

  // Route every temp/cache/state consumer into the RAM root.
  const tmp = join(ram.root, 'tmp');
  const npmCache = join(ram.root, 'npm-cache');
  const compileCache = join(ram.root, 'node-compile-cache');
  for (const dir of [tmp, npmCache, compileCache]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const baseEnv = {
    ...process.env,
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', CI: '1',
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    NPM_CONFIG_CACHE: npmCache, npm_config_cache: npmCache,
    NODE_COMPILE_CACHE: compileCache,
  };

  let buildError = null;
  const laneRun = { results: [], notStarted: [], stoppedBySignal: false };
  try {
    await buildDistOnce(baseEnv, logDir);
    const budget = CORES; // global worker budget = physical cores.
    const scheduled = await scheduleLanes(selected, baseEnv, options.identityDir, logDir, options.laneTimeoutMs, budget);
    laneRun.results = scheduled.results;
    laneRun.notStarted = scheduled.notStarted;
    laneRun.stoppedBySignal = scheduled.stoppedBySignal;
  } catch (error) {
    buildError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (!options.keepRoot) {
      try { ram.release(); ramReleased = true; process.stdout.write(`[test-fast] RAM root released\n`); }
      catch (error) { process.stderr.write(`[test-fast] WARNING: RAM root release failed: ${error instanceof Error ? error.message : String(error)}\n`); }
    } else {
      process.stdout.write(`[test-fast] --keep-root set: RAM root retained at ${ram.root}\n`);
    }
  }

  // ---- Summary + fail-closed exit ------------------------------------------
  const totalMs = Date.now() - totalStart;
  process.stdout.write('\n[test-fast] ===== summary =====\n');
  if (buildError !== null) {
    process.stderr.write(`[test-fast] BUILD FAILED: ${buildError.message}\n`);
    process.exitCode = 1;
    return;
  }
  const failures = [];
  for (const result of laneRun.results.sort((a, b) => b.durationMs - a.durationMs)) {
    const ok = result.code === 0 && !result.timedOut && result.error === null;
    process.stdout.write(`[test-fast]   ${ok ? 'PASS' : 'FAIL'} ${result.lane.name.padEnd(14)} ${(result.durationMs / 1000).toFixed(1)}s\n`);
    if (!ok) failures.push(result);
  }
  for (const notStarted of laneRun.notStarted) {
    process.stdout.write(`[test-fast]   NOT-STARTED ${notStarted.lane.name}\n`);
    failures.push(notStarted);
  }
  process.stdout.write(`[test-fast] total wall: ${(totalMs / 1000).toFixed(1)}s (${(totalMs / 60000).toFixed(2)} min)\n`);

  if (failures.length > 0 || laneRun.stoppedBySignal) {
    for (const failure of failures) {
      process.stderr.write(`\n[test-fast] ===== FAILED lane: ${failure.lane.name} =====\n`);
      if (failure.timedOut) process.stderr.write(`[test-fast] lane timed out\n`);
      if (failure.error !== null) process.stderr.write(`[test-fast] ${failure.error.message}\n`);
      if (failure.tapPath !== null) {
        try { process.stderr.write(printTail(failure.tapPath, 200)); }
        catch { process.stderr.write('[test-fast] (no TAP log captured)\n'); }
      }
      if (failure.stderr && failure.stderr.length > 0) process.stderr.write(`[test-fast] lane stderr:\n${failure.stderr.slice(-4000)}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('[test-fast] ALL LANES PASSED\n');
}

function printTail(path, lines) {
  const text = readFileSync(path, 'utf8');
  const split = text.split('\n');
  return split.slice(Math.max(0, split.length - lines)).join('\n') + '\n';
}

await main();
