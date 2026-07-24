// Serial↔fast parity comparator (Phase 40 / D70, change C5 adoption gate).
//
// Consumes two directories of per-lane identity JSONL streams (produced by
// scripts/test-identity-reporter.mjs) and proves the two execution paths ran the
// IDENTICAL set of logical tests with IDENTICAL terminal outcomes — the D70 §5
// adoption gate. It fails loudly on ANY divergence:
//   * a test present in one path but not the other (missing/added coverage);
//   * a status difference (pass/fail) for the same test id;
//   * ANY skip/todo flag (coverage must be immutable — no test may be skipped
//     or todo-marked to gain speed).
//
// Added infrastructure tests are allowed ONLY in the direction serial ⊆ fast
// when explicitly permitted with --allow-added (they must still be green); by
// default the sets must be exactly equal.
//
// Usage:
//   node scripts/test-parity-compare.mjs --serial <dir> --fast <dir> [--allow-added] [--json]

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const options = { serial: null, fast: null, allowAdded: false, json: false, logical: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--serial') { options.serial = argv[index + 1]; index += 1; continue; }
    if (arg === '--fast') { options.fast = argv[index + 1]; index += 1; continue; }
    if (arg === '--allow-added') { options.allowAdded = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    // --logical compares on the `<describe> > <it>` portion only (file-path
    // agnostic). Use it to prove the sharded current tree still covers every
    // pre-shard baseline test even though the sharded tests moved files.
    if (arg === '--logical') { options.logical = true; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (options.serial === null || options.fast === null) throw new Error('both --serial <dir> and --fast <dir> are required');
  return options;
}

/** Strip the `<relFile> :: ` prefix, leaving the file-agnostic logical identity. */
function logicalId(id) {
  const sep = id.indexOf(' :: ');
  return sep === -1 ? id : id.slice(sep + ' :: '.length);
}

/** Load all identity-*.jsonl in a dir into a Map<id, {status, flags}> plus a duplicate-id report. */
function loadIdentities(dir, logical = false) {
  const byId = new Map();
  const duplicates = [];
  const flagged = [];
  let lineCount = 0;
  const files = readdirSync(dir).filter((name) => /^identity-.*\.jsonl$/u.test(name)).sort();
  if (files.length === 0) throw new Error(`no identity-*.jsonl files found in ${dir}`);
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      lineCount += 1;
      const record = JSON.parse(line);
      if (typeof record.id !== 'string' || typeof record.status !== 'string' || !Array.isArray(record.flags)) {
        throw new Error(`malformed identity record in ${file}: ${line}`);
      }
      const id = logical ? logicalId(record.id) : record.id;
      if (record.flags.length > 0) flagged.push({ id, flags: record.flags });
      const existing = byId.get(id);
      if (existing !== undefined) {
        // A duplicate id within one path is only acceptable when both terminal
        // outcomes agree (e.g. a legitimately identical name across two files is
        // still one logical identity because the file prefix is part of the id;
        // a true intra-file duplicate name is surfaced here for inspection).
        if (existing.status !== record.status) duplicates.push({ id, statuses: [existing.status, record.status] });
      } else {
        byId.set(id, { status: record.status, flags: record.flags });
      }
    }
  }
  return { byId, duplicates, flagged, files, lineCount };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const serial = loadIdentities(options.serial, options.logical);
  const fast = loadIdentities(options.fast, options.logical);

  const missingInFast = []; // in serial, absent in fast
  const addedInFast = []; // in fast, absent in serial
  const statusMismatch = [];

  for (const [id, entry] of serial.byId) {
    const other = fast.byId.get(id);
    if (other === undefined) missingInFast.push(id);
    else if (other.status !== entry.status) statusMismatch.push({ id, serial: entry.status, fast: other.status });
  }
  for (const id of fast.byId.keys()) {
    if (!serial.byId.has(id)) addedInFast.push(id);
  }

  // No test may be skipped or todo-marked in EITHER path.
  const serialSkippedOrTodo = serial.flagged.filter((entry) => entry.flags.some((flag) => flag === 'skip' || flag === 'todo'));
  const fastSkippedOrTodo = fast.flagged.filter((entry) => entry.flags.some((flag) => flag === 'skip' || flag === 'todo'));

  // Any failing test in either path is a hard failure.
  const serialFailures = [...serial.byId].filter(([, entry]) => entry.status !== 'pass').map(([id, entry]) => ({ id, status: entry.status }));
  const fastFailures = [...fast.byId].filter(([, entry]) => entry.status !== 'pass').map(([id, entry]) => ({ id, status: entry.status }));

  const errors = [];
  if (missingInFast.length > 0) errors.push(`${String(missingInFast.length)} test(s) present in SERIAL but MISSING in FAST (coverage regression)`);
  if (!options.allowAdded && addedInFast.length > 0) errors.push(`${String(addedInFast.length)} test(s) present in FAST but ABSENT in SERIAL (unexpected added tests; pass --allow-added if these are new infrastructure tests)`);
  if (statusMismatch.length > 0) errors.push(`${String(statusMismatch.length)} test(s) with divergent pass/fail status between paths`);
  if (serialSkippedOrTodo.length > 0) errors.push(`${String(serialSkippedOrTodo.length)} test(s) skipped/todo in SERIAL (coverage must be immutable)`);
  if (fastSkippedOrTodo.length > 0) errors.push(`${String(fastSkippedOrTodo.length)} test(s) skipped/todo in FAST (coverage must be immutable)`);
  if (serialFailures.length > 0) errors.push(`${String(serialFailures.length)} FAILING test(s) in SERIAL`);
  if (fastFailures.length > 0) errors.push(`${String(fastFailures.length)} FAILING test(s) in FAST`);

  const passed = errors.length === 0;
  const report = {
    schema_version: 'autopilot.test_parity.v1',
    passed,
    serial: { files: serial.files.length, unique_ids: serial.byId.size, lines: serial.lineCount },
    fast: { files: fast.files.length, unique_ids: fast.byId.size, lines: fast.lineCount },
    missing_in_fast: missingInFast.sort(),
    added_in_fast: addedInFast.sort(),
    status_mismatch: statusMismatch,
    serial_skipped_or_todo: serialSkippedOrTodo,
    fast_skipped_or_todo: fastSkippedOrTodo,
    serial_failures: serialFailures,
    fast_failures: fastFailures,
    errors,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`[parity] serial unique=${String(serial.byId.size)} fast unique=${String(fast.byId.size)}\n`);
    for (const error of errors) process.stderr.write(`[parity] ERROR: ${error}\n`);
    for (const id of missingInFast.slice(0, 50)) process.stderr.write(`[parity]   missing-in-fast: ${id}\n`);
    for (const id of addedInFast.slice(0, 50)) process.stderr.write(`[parity]   added-in-fast: ${id}\n`);
    for (const entry of statusMismatch.slice(0, 50)) process.stderr.write(`[parity]   status-mismatch: ${entry.id} serial=${entry.serial} fast=${entry.fast}\n`);
    if (passed) process.stdout.write('[parity] PASS: identical logical test sets and terminal outcomes\n');
  }
  if (!passed) process.exitCode = 1;
}

main();
