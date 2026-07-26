#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const DISPOSITIONS = new Set(['retain', 'port', 'rewrite', 'delete']);
const SLICES = new Set(['slice-1', 'slice-2', 'slice-3', 'slice-4', 'slice-5', 'slice-6', 'slice-7']);
const TOP_KEYS = new Set(['schema', 'baseline', 'generated_at_wave', 'dispositions']);
const BASELINE_KEYS = new Set(['commit', 'tree', 'tracked_paths', 'total_loc']);
const ENTRY_KEYS = new Set(['path', 'kind', 'disposition', 'loc', 'reason', 'replacement_slice', 'replacement_consumer']);
const SELF_PATHS = new Set(['retain-port-delete.yaml', 'scripts/check-disposition.mjs']);

function usage(exitCode = 2) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage: node scripts/check-disposition.mjs [--baseline-only] [--selftest] [--root DIR] [--manifest FILE]\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { baselineOnly: false, selftest: false, root: null, manifest: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline-only') args.baselineOnly = true;
    else if (arg === '--selftest') args.selftest = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--root') {
      i += 1;
      if (i >= argv.length) usage(2);
      args.root = argv[i];
    } else if (arg === '--manifest') {
      i += 1;
      if (i >= argv.length) usage(2);
      args.manifest = argv[i];
    } else {
      process.stderr.write(`check-disposition: unknown argument: ${arg}\n`);
      usage(2);
    }
  }
  return args;
}

function parseScalar(raw, lineNo) {
  const value = raw.trim();
  if (value === '') throw new Error(`line ${lineNo}: missing scalar value`);
  if (value.startsWith('"')) {
    try {
      if (!value.endsWith('"')) throw new Error('unterminated quoted scalar');
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`line ${lineNo}: invalid quoted scalar: ${error.message}`);
    }
  }
  if (/^[0-9]+$/.test(value)) return Number(value);
  if (/^[A-Za-z0-9_.§/-]+$/.test(value)) return value;
  throw new Error(`line ${lineNo}: unsupported scalar syntax: ${value}`);
}

function setUnique(target, key, value, lineNo, allowed) {
  if (!allowed.has(key)) throw new Error(`line ${lineNo}: unknown key ${key}`);
  if (Object.hasOwn(target, key)) throw new Error(`line ${lineNo}: duplicate key ${key}`);
  target[key] = value;
}

function parseManifest(text) {
  const manifest = {};
  let section = null;
  let currentEntry = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    let match = line.match(/^([a-z_]+):(.*)$/);
    if (match) {
      const [, key, rest] = match;
      if (!TOP_KEYS.has(key)) throw new Error(`line ${lineNo}: unknown top-level key ${key}`);
      if (rest.trim() === '') {
        if (key === 'baseline') {
          setUnique(manifest, key, {}, lineNo, TOP_KEYS);
          section = 'baseline';
          currentEntry = null;
          continue;
        }
        if (key === 'dispositions') {
          setUnique(manifest, key, [], lineNo, TOP_KEYS);
          section = 'dispositions';
          currentEntry = null;
          continue;
        }
        throw new Error(`line ${lineNo}: top-level scalar ${key} requires a value`);
      }
      setUnique(manifest, key, parseScalar(rest, lineNo), lineNo, TOP_KEYS);
      section = null;
      currentEntry = null;
      continue;
    }

    match = line.match(/^  ([a-z_]+):(.*)$/);
    if (match && section === 'baseline') {
      const [, key, rest] = match;
      setUnique(manifest.baseline, key, parseScalar(rest, lineNo), lineNo, BASELINE_KEYS);
      continue;
    }

    match = line.match(/^  - ([a-z_]+):(.*)$/);
    if (match && section === 'dispositions') {
      const [, key, rest] = match;
      currentEntry = {};
      setUnique(currentEntry, key, parseScalar(rest, lineNo), lineNo, ENTRY_KEYS);
      manifest.dispositions.push(currentEntry);
      continue;
    }

    match = line.match(/^    ([a-z_]+):(.*)$/);
    if (match && section === 'dispositions' && currentEntry) {
      const [, key, rest] = match;
      setUnique(currentEntry, key, parseScalar(rest, lineNo), lineNo, ENTRY_KEYS);
      continue;
    }

    throw new Error(`line ${lineNo}: unsupported YAML subset syntax`);
  }
  return manifest;
}

function runGit(root, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : error.message;
    const rendered = ['git', ...args].join(' ');
    const wrapped = new Error(`failed to run ${rendered}: ${stderr.trim()}`);
    wrapped.usage = true;
    throw wrapped;
  }
}

function splitLines(output) {
  return output.split('\n').filter(Boolean);
}

function listBaselinePaths(root, tree) {
  return splitLines(runGit(root, ['ls-tree', '-r', '--name-only', tree]));
}

function listWorkingPaths(root) {
  const tracked = splitLines(runGit(root, ['ls-files']));
  const untracked = splitLines(runGit(root, ['ls-files', '--others', '--exclude-standard']));
  return { tracked, untracked, all: Array.from(new Set([...tracked, ...untracked])).sort() };
}

function countBlobLines(root, tree, filePath) {
  const content = runGit(root, ['show', `${tree}:${filePath}`], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
  let lines = 0;
  for (const byte of content) if (byte === 10) lines += 1;
  return lines;
}

function validateManifest(manifest) {
  if (manifest.schema !== 'autopilot.disposition.v1') throw new Error('schema must be autopilot.disposition.v1');
  if (!manifest.baseline || typeof manifest.baseline !== 'object') throw new Error('baseline object is required');
  for (const key of BASELINE_KEYS) if (!Object.hasOwn(manifest.baseline, key)) throw new Error(`baseline.${key} is required`);
  if (!Array.isArray(manifest.dispositions)) throw new Error('dispositions array is required');
  if (manifest.dispositions.length === 0) throw new Error('dispositions array must not be empty');

  const seenEntryKeys = new Set();
  for (const [index, entry] of manifest.dispositions.entries()) {
    const label = `dispositions[${index}]`;
    for (const key of ['path', 'kind', 'disposition', 'loc', 'reason']) {
      if (!Object.hasOwn(entry, key)) throw new Error(`${label}.${key} is required`);
    }
    if (typeof entry.path !== 'string' || entry.path === '' || entry.path.startsWith('/')) throw new Error(`${label}.path must be a non-absolute path`);
    if (entry.kind !== 'exact' && entry.kind !== 'prefix') throw new Error(`${label}.kind must be exact or prefix`);
    if (entry.kind === 'prefix' && !entry.path.endsWith('/')) throw new Error(`${label}.path must end in / for prefix entries`);
    if (!DISPOSITIONS.has(entry.disposition)) throw new Error(`${label}.disposition has invalid value ${entry.disposition}`);
    if (!Number.isInteger(entry.loc) || entry.loc < 0) throw new Error(`${label}.loc must be a non-negative integer`);
    if (typeof entry.reason !== 'string' || !/(D76|D77|D78|D79|refactor-task)/.test(entry.reason)) {
      throw new Error(`${label}.reason must cite D76, D77, D78, D79, or refactor-task authority`);
    }
    if (entry.disposition === 'port' || entry.disposition === 'rewrite' || entry.disposition === 'delete') {
      if (!SLICES.has(entry.replacement_slice)) throw new Error(`${label}.replacement_slice is required and must be slice-1..slice-7`);
    }
    if (entry.disposition === 'delete') {
      if (typeof entry.replacement_consumer !== 'string' || entry.replacement_consumer === '') throw new Error(`${label}.replacement_consumer is required for delete entries`);
    }
    const signature = `${entry.kind}\0${entry.path}`;
    if (seenEntryKeys.has(signature)) throw new Error(`${label} duplicates a disposition entry for ${entry.path}`);
    seenEntryKeys.add(signature);
  }
}

function matches(entry, filePath) {
  if (entry.kind === 'exact') return entry.path === filePath;
  return filePath.startsWith(entry.path);
}

function specificity(entry) {
  return entry.kind === 'exact' ? entry.path.length + 1_000_000 : entry.path.length;
}

function winningEntries(entries, filePath) {
  const matched = entries.filter((entry) => matches(entry, filePath));
  if (matched.length === 0) return { matched, winners: [] };
  const max = Math.max(...matched.map(specificity));
  return { matched, winners: matched.filter((entry) => specificity(entry) === max) };
}

function formatRows(rows) {
  const header = ['disposition', 'paths', 'loc'];
  const widths = [11, 5, 7];
  const line = (cols) => cols.map((col, i) => String(col).padStart(widths[i])).join('  ');
  return [line(header), line(['-----------', '-----', '-------']), ...rows.map((row) => line(row))].join('\n');
}

function runCheck(options) {
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = resolve(options.root ?? scriptRoot);
  const manifestPath = resolve(root, options.manifest ?? 'retain-port-delete.yaml');

  let text;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    error.usage = true;
    throw error;
  }

  let manifest;
  try {
    manifest = parseManifest(text);
  } catch (error) {
    throw new Error(`manifest parse failed: ${error.message}`);
  }
  try {
    validateManifest(manifest);
  } catch (error) {
    process.stderr.write('Disposition check failed:\n');
    process.stderr.write(`  - manifest validation failed: ${error.message}\n`);
    return 1;
  }

  const baselinePaths = listBaselinePaths(root, manifest.baseline.tree);
  const baselineSet = new Set(baselinePaths);
  const working = listWorkingPaths(root);
  const selfExisting = Array.from(SELF_PATHS).filter((p) => existsSync(join(root, p)));
  const matchUniverse = new Set(options.baselineOnly ? [...baselinePaths, ...selfExisting] : [...baselinePaths, ...working.all]);

  const errors = [];
  if (manifest.baseline.tracked_paths !== baselinePaths.length) {
    errors.push(`baseline.tracked_paths=${manifest.baseline.tracked_paths} but pinned tree contains ${baselinePaths.length}`);
  }

  const assignment = new Map();
  for (const filePath of baselinePaths) {
    const { winners } = winningEntries(manifest.dispositions, filePath);
    if (winners.length === 0) errors.push(`missing disposition: ${filePath}`);
    else if (winners.length > 1) errors.push(`ambiguous equal-specificity disposition for ${filePath}: ${winners.map((entry) => entry.path).join(', ')}`);
    else assignment.set(filePath, winners[0]);
  }

  for (const entry of manifest.dispositions) {
    const matched = Array.from(matchUniverse).filter((filePath) => matches(entry, filePath));
    if (matched.length === 0) errors.push(`stale disposition entry matches no path: ${entry.kind} ${entry.path}`);
  }

  const entryLoc = new Map(manifest.dispositions.map((entry) => [entry, 0]));
  const summary = new Map(Array.from(DISPOSITIONS).map((d) => [d, { paths: 0, loc: 0 }]));
  let sourceTsLoc = 0;
  for (const filePath of baselinePaths) {
    const loc = countBlobLines(root, manifest.baseline.tree, filePath);
    if ((filePath.startsWith('src/') && filePath.endsWith('.ts'))) sourceTsLoc += loc;
    const entry = assignment.get(filePath);
    if (!entry) continue;
    entryLoc.set(entry, entryLoc.get(entry) + loc);
    const bucket = summary.get(entry.disposition);
    bucket.paths += 1;
    bucket.loc += loc;
  }

  for (const entry of manifest.dispositions) {
    const actual = entryLoc.get(entry) ?? 0;
    if (entry.loc !== actual) errors.push(`loc mismatch for ${entry.kind} ${entry.path}: manifest=${entry.loc} actual=${actual}`);
  }

  if (manifest.baseline.total_loc !== sourceTsLoc) {
    errors.push(`baseline.total_loc=${manifest.baseline.total_loc} but pinned src/*.ts + src/**/*.ts LOC is ${sourceTsLoc}`);
  }

  if (errors.length > 0) {
    process.stderr.write('Disposition check failed:\n');
    for (const error of errors.slice(0, 200)) process.stderr.write(`  - ${error}\n`);
    if (errors.length > 200) process.stderr.write(`  ... ${errors.length - 200} more errors\n`);
    return 1;
  }

  const rows = ['retain', 'port', 'rewrite', 'delete'].map((d) => [d, summary.get(d).paths, summary.get(d).loc]);
  process.stdout.write(`Disposition check passed (${options.baselineOnly ? 'baseline-only' : 'working-tree'} mode).\n`);
  process.stdout.write(`Pinned baseline: ${manifest.baseline.commit} / ${manifest.baseline.tree}\n`);
  process.stdout.write(`Baseline paths covered: ${baselinePaths.length}\n`);
  process.stdout.write(`Disposition entries: ${manifest.dispositions.length}\n`);
  process.stdout.write(`Delete entries with replacement_consumer: ${manifest.dispositions.filter((entry) => entry.disposition === 'delete' && entry.replacement_consumer).length}\n`);
  process.stdout.write('Disposition summary (pinned baseline paths):\n');
  process.stdout.write(`${formatRows(rows)}\n`);
  process.stdout.write(`Baseline source TS LOC (src/*.ts + src/**/*.ts): ${sourceTsLoc}\n`);

  if (!options.baselineOnly) {
    const newSinceBaseline = working.all.filter((filePath) => !baselineSet.has(filePath));
    process.stdout.write('New since baseline (not required to be dispositioned in W0):\n');
    if (newSinceBaseline.length === 0) process.stdout.write('  (none)\n');
    else {
      for (const filePath of newSinceBaseline.slice(0, 100)) process.stdout.write(`  ${filePath}\n`);
      if (newSinceBaseline.length > 100) process.stdout.write(`  ... ${newSinceBaseline.length - 100} more\n`);
    }
  }
  return 0;
}

function execNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function initRepo(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'selftest@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Disposition Selftest'], { cwd: root });
}

function commitAll(root) {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
  return { commit, tree };
}

function fixtureManifest({ commit, tree, entries, trackedPaths = 2, totalLoc = 0 }) {
  const rendered = entries.map((entry) => {
    const fields = [
      `  - path: ${JSON.stringify(entry.path)}`,
      `    kind: ${entry.kind}`,
      `    disposition: ${entry.disposition}`,
      `    loc: ${entry.loc}`,
      `    reason: ${JSON.stringify(entry.reason ?? 'D76 §11 — selftest fixture authority.')}`,
    ];
    if (entry.replacement_slice) fields.push(`    replacement_slice: ${entry.replacement_slice}`);
    if (entry.replacement_consumer) fields.push(`    replacement_consumer: ${entry.replacement_consumer}`);
    return fields.join('\n');
  }).join('\n');
  return `schema: autopilot.disposition.v1\nbaseline:\n  commit: ${commit}\n  tree: ${tree}\n  tracked_paths: ${trackedPaths}\n  total_loc: ${totalLoc}\ngenerated_at_wave: W0\ndispositions:\n${rendered}\n`;
}

function runSelftest() {
  const script = fileURLToPath(import.meta.url);
  const tmp = mkdtempSync(join(tmpdir(), 'autopilot-disposition-selftest.'));
  let passes = 0;
  let failures = 0;
  const expect = (want, label, args, cwd) => {
    const got = execNode(script, args, cwd);
    if (got.status === want) {
      process.stdout.write(`  ok    ${label} (exit ${got.status})\n`);
      passes += 1;
    } else {
      process.stderr.write(`  FAIL  ${label} — expected exit ${want}, got ${got.status}\n`);
      process.stderr.write(`${got.stdout}${got.stderr}`.split('\n').map((line) => `          ${line}`).join('\n'));
      process.stderr.write('\n');
      failures += 1;
    }
  };

  try {
    const makeFixture = (name, manifestBuilder) => {
      const root = join(tmp, name);
      mkdirSync(root, { recursive: true });
      initRepo(root);
      writeFileSync(join(root, 'a.ts'), 'a\n');
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub/b.ts'), 'b\n');
      const baseline = commitAll(root);
      writeFileSync(join(root, 'retain-port-delete.yaml'), manifestBuilder(baseline));
      return root;
    };

    process.stdout.write('check-disposition selftest\n');
    const complete = makeFixture('complete', (baseline) => fixtureManifest({ ...baseline, entries: [
      { path: 'a.ts', kind: 'exact', disposition: 'retain', loc: 1 },
      { path: 'sub/', kind: 'prefix', disposition: 'delete', loc: 1, replacement_slice: 'slice-7', replacement_consumer: 'drivers/src/integration' },
    ] }));
    expect(0, 'complete manifest passes', ['--root', complete, '--baseline-only'], complete);

    const missing = makeFixture('missing', (baseline) => fixtureManifest({ ...baseline, entries: [
      { path: 'a.ts', kind: 'exact', disposition: 'retain', loc: 1 },
    ] }));
    expect(1, 'missing tracked path fails', ['--root', missing, '--baseline-only'], missing);

    const stale = makeFixture('stale', (baseline) => fixtureManifest({ ...baseline, entries: [
      { path: 'a.ts', kind: 'exact', disposition: 'retain', loc: 1 },
      { path: 'sub/', kind: 'prefix', disposition: 'delete', loc: 1, replacement_slice: 'slice-7', replacement_consumer: 'drivers/src/integration' },
      { path: 'gone.ts', kind: 'exact', disposition: 'retain', loc: 0 },
    ] }));
    expect(1, 'stale entry fails', ['--root', stale, '--baseline-only'], stale);

    const deleteNoConsumer = makeFixture('delete-no-consumer', (baseline) => fixtureManifest({ ...baseline, entries: [
      { path: 'a.ts', kind: 'exact', disposition: 'retain', loc: 1 },
      { path: 'sub/', kind: 'prefix', disposition: 'delete', loc: 1, replacement_slice: 'slice-7' },
    ] }));
    expect(1, 'delete without replacement_consumer fails', ['--root', deleteNoConsumer, '--baseline-only'], deleteNoConsumer);

    const malformed = makeFixture('malformed', (baseline) => `${fixtureManifest({ ...baseline, entries: [
      { path: 'a.ts', kind: 'exact', disposition: 'retain', loc: 1 },
      { path: 'sub/', kind: 'prefix', disposition: 'delete', loc: 1, replacement_slice: 'slice-7', replacement_consumer: 'drivers/src/integration' },
    ] })}this line is not yaml\n`);
    expect(2, 'malformed parser input fails loudly', ['--root', malformed, '--baseline-only'], malformed);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(`\nselftest: ${passes} passed, ${failures} failed\n`);
  return failures === 0 ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
try {
  const code = args.selftest ? runSelftest() : runCheck(args);
  process.exit(code);
} catch (error) {
  const exitCode = error.usage ? 2 : 2;
  process.stderr.write(`check-disposition: ${error.message}\n`);
  process.exit(exitCode);
}
