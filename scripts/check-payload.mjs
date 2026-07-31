#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MANIFEST = 'retain-port-delete.yaml';
const DISPOSITIONS = new Set(['retain', 'port', 'rewrite', 'delete']);
const TOP_KEYS = new Set(['schema', 'baseline', 'generated_at_wave', 'dispositions']);
const BASELINE_KEYS = new Set(['commit', 'tree', 'tracked_paths', 'total_loc']);
const ENTRY_KEYS = new Set(['path', 'kind', 'disposition', 'loc', 'reason', 'replacement_slice', 'replacement_consumer']);

function usage(exitCode = 2) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('Usage: node scripts/check-payload.mjs\n');
  process.exit(exitCode);
}

function failUsage(message) {
  process.stderr.write(`check-payload: ${message}\n`);
  usage(2);
}

function parseScalar(raw, lineNo) {
  const value = raw.trim();
  if (value === '') throw new Error(`line ${lineNo}: missing scalar value`);
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new Error(`line ${lineNo}: unterminated quoted scalar`);
    try { return JSON.parse(value); } catch (error) { throw new Error(`line ${lineNo}: invalid quoted scalar: ${error.message}`); }
  }
  if (/^[0-9]+$/u.test(value)) return Number(value);
  if (/^[A-Za-z0-9_.§/-]+$/u.test(value)) return value;
  throw new Error(`line ${lineNo}: unsupported scalar syntax: ${value}`);
}

function setUnique(target, key, value, lineNo, allowed) {
  if (!allowed.has(key)) throw new Error(`line ${lineNo}: unknown key ${key}`);
  if (Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`line ${lineNo}: duplicate key ${key}`);
  target[key] = value;
}

function parseDispositionManifest(text) {
  const manifest = {};
  let section = null;
  let currentEntry = null;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    let match = line.match(/^([a-z_]+):(.*)$/u);
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
    match = line.match(/^  ([a-z_]+):(.*)$/u);
    if (match && section === 'baseline') {
      const [, key, rest] = match;
      setUnique(manifest.baseline, key, parseScalar(rest, lineNo), lineNo, BASELINE_KEYS);
      continue;
    }
    match = line.match(/^  - ([a-z_]+):(.*)$/u);
    if (match && section === 'dispositions') {
      const [, key, rest] = match;
      currentEntry = {};
      setUnique(currentEntry, key, parseScalar(rest, lineNo), lineNo, ENTRY_KEYS);
      manifest.dispositions.push(currentEntry);
      continue;
    }
    match = line.match(/^    ([a-z_]+):(.*)$/u);
    if (match && section === 'dispositions' && currentEntry) {
      const [, key, rest] = match;
      setUnique(currentEntry, key, parseScalar(rest, lineNo), lineNo, ENTRY_KEYS);
      continue;
    }
    throw new Error(`line ${lineNo}: unsupported YAML subset syntax`);
  }
  if (manifest.schema !== 'autopilot.disposition.v1') throw new Error('schema must be autopilot.disposition.v1');
  if (!manifest.baseline || typeof manifest.baseline !== 'object') throw new Error('baseline object is required');
  for (const key of BASELINE_KEYS) if (!Object.prototype.hasOwnProperty.call(manifest.baseline, key)) throw new Error(`baseline.${key} is required`);
  if (!Array.isArray(manifest.dispositions) || manifest.dispositions.length === 0) throw new Error('dispositions array is required and must not be empty');
  for (const [index, entry] of manifest.dispositions.entries()) {
    const label = `dispositions[${index}]`;
    for (const key of ['path', 'kind', 'disposition']) if (!Object.prototype.hasOwnProperty.call(entry, key)) throw new Error(`${label}.${key} is required`);
    if (typeof entry.path !== 'string' || entry.path === '' || entry.path.startsWith('/')) throw new Error(`${label}.path must be non-absolute`);
    if (entry.kind !== 'exact' && entry.kind !== 'prefix') throw new Error(`${label}.kind must be exact or prefix`);
    if (entry.kind === 'prefix' && !entry.path.endsWith('/')) throw new Error(`${label}.path must end in / for prefix entries`);
    if (!DISPOSITIONS.has(entry.disposition)) throw new Error(`${label}.disposition invalid: ${entry.disposition}`);
  }
  return manifest;
}

function matches(entry, filePath) {
  return entry.kind === 'exact' ? entry.path === filePath : filePath.startsWith(entry.path);
}

function specificity(entry) {
  return entry.kind === 'exact' ? entry.path.length + 1_000_000 : entry.path.length;
}

function winningDisposition(entries, filePath) {
  const matched = entries.filter((entry) => matches(entry, filePath));
  if (matched.length === 0) return null;
  const best = Math.max(...matched.map(specificity));
  const winners = matched.filter((entry) => specificity(entry) === best);
  if (winners.length !== 1) throw new Error(`ambiguous disposition for payload path ${filePath}: ${winners.map((entry) => entry.path).join(', ')}`);
  return winners[0];
}

function packageMetadata() {
  const parsed = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('package.json root must be an object');
  return parsed;
}

function npmPackDryRun() {
  const cache = mkdtempSync(join(tmpdir(), 'pi-autopilot-pack-cache.'));
  try {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
    });
    if (result.error) throw new Error(`npm pack failed before exit: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`npm pack --dry-run --json --ignore-scripts failed with exit ${result.status}: ${result.stderr.trim()}`);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error(`npm pack returned non-JSON output: ${error.message}`); }
    if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) throw new Error('npm pack returned unexpected metadata shape');
    return parsed[0];
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function runtimeInputsFromSource(filePath) {
  const source = readFileSync(resolve(PACKAGE_ROOT, filePath), 'utf8');
  const inputs = [];
  for (const match of source.matchAll(/new URL\(['"]([^'"]+)['"], import\.meta\.url\)/gu)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const absolute = resolve(dirname(resolve(PACKAGE_ROOT, filePath)), specifier);
    const payloadPath = relative(PACKAGE_ROOT, absolute).replaceAll('\\', '/');
    if (payloadPath.startsWith('..')) throw new Error(`${filePath} reads outside package payload: ${specifier}`);
    inputs.push({ path: payloadPath, reason: `${filePath} runtime file URL` });
  }
  return inputs;
}

function allowedRuntimePath(path, binEntries) {
  if (path === 'package.json' || path === 'README.md' || path === 'LICENSE' || path === 'logo.png' || path === 'AUTOPILOT-INSTRUCTIONS.md') return true;
  if (binEntries.has(path)) return true;
  if (path === 'extensions/autopilot.ts') return true;
  if (path === 'src/resolve-runner.ts' || path === 'src/resolve-core-runtime.d.ts') return false;
  if (path === 'src/resolve-core-runtime.js') return true;
  if (path.startsWith('src/') && path.endsWith('.ts')) return true;
  if (path.startsWith('docs/generated/') && path.endsWith('.md')) return true;
  if (path === 'binaries/MANIFEST.json') return true;
  if (/^binaries\/(darwin-arm64|darwin-x64|linux-arm64|linux-x64)\/autopilot-core$/u.test(path)) return true;
  if (path === 'binaries/win32-x64/autopilot-core.exe') return true;
  return false;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) usage(0);
    failUsage(`unknown argument: ${args[0]}`);
  }
  const pkg = packageMetadata();
  const coreBinEntry = pkg.bin?.['autopilot-core'];
  const runnerBinEntry = pkg.bin?.['autopilot-agent-run'];
  if (coreBinEntry !== 'bin/autopilot-core.mjs') throw new Error('package.json bin.autopilot-core must be bin/autopilot-core.mjs');
  if (typeof runnerBinEntry !== 'string' || runnerBinEntry !== 'bin/autopilot-agent-run.mjs') throw new Error('package.json bin.autopilot-agent-run must be bin/autopilot-agent-run.mjs');
  const binEntries = new Set([coreBinEntry, runnerBinEntry]);
  const manifestPath = resolve(PACKAGE_ROOT, MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`${MANIFEST} is missing`);
  const manifest = parseDispositionManifest(readFileSync(manifestPath, 'utf8'));
  const packed = npmPackDryRun();
  const packFiles = Array.isArray(packed.files) ? packed.files : [];
  const files = new Set(packFiles.map((entry) => entry.path));
  const errors = [];
  const requireFile = (path, reason) => { if (!files.has(path)) errors.push(`missing required payload path ${path} (${reason})`); };
  const hostRuntimeSources = ['src/extension.ts', 'src/activation.ts', 'src/commands.ts', 'src/effects.ts', 'src/background-tasks.ts', 'src/resolve-core.ts', 'src/resolve-core-runtime.js', 'src/transport.ts'];
  const runtimeInputs = [
    { path: 'extensions/autopilot.ts', reason: 'package.json pi extension entrypoint' },
    { path: coreBinEntry, reason: 'package.json bin.autopilot-core' },
    { path: runnerBinEntry, reason: 'package.json bin.autopilot-agent-run' },
    { path: 'src/generated/index.ts', reason: 'generated seam types' },
    { path: 'src/generated/child-extension.ts', reason: 'generated child submit tools' },
    ...hostRuntimeSources.map((path) => ({ path, reason: 'Host runtime source' })),
    ...hostRuntimeSources.flatMap(runtimeInputsFromSource),
  ];
  for (const required of runtimeInputs) requireFile(required.path, required.reason);

  for (const path of files) {
    const disposition = winningDisposition(manifest.dispositions, path);
    if (disposition?.disposition === 'delete') errors.push(`delete-dispositioned payload path ${path} matched ${disposition.kind} ${disposition.path}`);
    if (!binEntries.has(path) && (path === 'target' || path.startsWith('target/'))) errors.push(`development target artifact shipped: ${path}`);
    if (path === 'tests/transcripts' || path.startsWith('tests/transcripts/')) errors.push(`development transcript shipped: ${path}`);
    if (path === 'plans' || path.startsWith('plans/')) errors.push(`private plan material shipped: ${path}`);
    if (path === '.pi' || path.startsWith('.pi/') || path.includes('/.pi/')) errors.push(`private .pi material shipped: ${path}`);
    if (!allowedRuntimePath(path, binEntries)) errors.push(`non-runtime payload path shipped: ${path}`);
  }

  if (errors.length > 0) {
    process.stderr.write(`payload:check FAILED with ${errors.length} finding(s):\n`);
    for (const error of errors) process.stderr.write(`  - ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`payload:check passed: ${files.size} files, bins=${[...binEntries].join(',')}, package size=${packed.size} bytes, unpacked=${packed.unpackedSize} bytes.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`check-payload: ${error.message}\n`);
  process.exitCode = 2;
}
