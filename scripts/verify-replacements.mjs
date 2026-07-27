#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DISPOSITIONS = new Set(['retain', 'port', 'rewrite', 'delete']);
const TOP_KEYS = new Set(['schema', 'baseline', 'generated_at_wave', 'dispositions']);
const BASELINE_KEYS = new Set(['commit', 'tree', 'tracked_paths', 'total_loc']);
const ENTRY_KEYS = new Set(['path', 'kind', 'disposition', 'loc', 'reason', 'replacement_slice', 'replacement_consumer']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist']);
const SOURCE_EXTENSIONS = new Set(['.rs', '.ts', '.js', '.mjs', '.mts', '.tsx']);
const TEXT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, '.json', '.kdl', '.md', '.sh', '.toml', '.yaml', '.yml', '.txt']);
const TEST_DIRS = ['tests', 'drivers/tests', 'codegen/tests', 'modelcheck/tests', 'kernel/tests', 'host/tests'];

function usage(exitCode = 2) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write('Usage: node scripts/verify-replacements.mjs [--selftest] [--root DIR] [--manifest FILE]\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { selftest: false, root: null, manifest: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--selftest') args.selftest = true;
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
      process.stderr.write(`verify-replacements: unknown argument: ${arg}\n`);
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
  if (/^[0-9]+$/u.test(value)) return Number(value);
  if (/^[A-Za-z0-9_.§/-]+$/u.test(value)) return value;
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
      currentEntry = { index: manifest.dispositions.length };
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
  return manifest;
}

function validateManifest(manifest) {
  if (manifest.schema !== 'autopilot.disposition.v1') throw new Error('manifest.schema must be autopilot.disposition.v1');
  if (!manifest.baseline || typeof manifest.baseline !== 'object') throw new Error('manifest.baseline object is required');
  for (const key of BASELINE_KEYS) if (!Object.hasOwn(manifest.baseline, key)) throw new Error(`manifest.baseline.${key} is required`);
  if (!Array.isArray(manifest.dispositions)) throw new Error('manifest.dispositions array is required');
  if (manifest.dispositions.length === 0) throw new Error('manifest.dispositions must not be empty');

  for (const entry of manifest.dispositions) {
    const label = `dispositions[${entry.index}] (${typeof entry.path === 'string' ? entry.path : '<missing path>'})`;
    for (const key of ['path', 'kind', 'disposition', 'loc', 'reason']) {
      if (!Object.hasOwn(entry, key)) throw new Error(`${label}.${key} is required`);
    }
    if (typeof entry.path !== 'string' || entry.path === '' || entry.path.startsWith('/')) throw new Error(`${label}.path must be a non-absolute path`);
    if (entry.kind !== 'exact' && entry.kind !== 'prefix') throw new Error(`${label}.kind must be exact or prefix`);
    if (entry.kind === 'prefix' && !entry.path.endsWith('/')) throw new Error(`${label}.path must end in / for prefix entries`);
    if (!DISPOSITIONS.has(entry.disposition)) throw new Error(`${label}.disposition has invalid value ${String(entry.disposition)}`);
    if (!Number.isInteger(entry.loc) || entry.loc < 0) throw new Error(`${label}.loc must be a non-negative integer`);
    if (typeof entry.reason !== 'string' || entry.reason === '') throw new Error(`${label}.reason must be a non-empty string`);
    if (entry.disposition === 'delete') {
      if (typeof entry.replacement_consumer !== 'string' || entry.replacement_consumer === '' || entry.replacement_consumer.startsWith('/')) {
        throw new Error(`${label}.replacement_consumer is required for delete entries and must be a non-absolute path`);
      }
    }
  }
}

function toRel(root, absPath) {
  return normalize(relative(root, absPath)).split(sep).join('/');
}

function isInsideOrEqual(candidate, container) {
  return candidate === container || candidate.startsWith(`${container}/`);
}

function safeRead(root, relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

function listFiles(root, relPath) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) return [];
  const stat = lstatSync(abs);
  if (stat.isFile()) return [normalize(relPath).split(sep).join('/')];
  if (!stat.isDirectory()) return [];
  const files = [];
  const visit = (dirAbs) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.cargo') continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const child = join(dirAbs, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(toRel(root, child));
    }
  };
  visit(abs);
  return files.sort();
}

function substantiveText(text, ext) {
  if (ext === '.md') return text.split(/\r?\n/u).filter((line) => line.trim() !== '' && !line.trim().startsWith('<!--')).join('\n');
  if (['.rs', '.ts', '.js', '.mjs', '.mts', '.tsx'].includes(ext)) {
    return text
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split(/\r?\n/u)
      .map((line) => line.replace(/\/\/.*$/u, '').trim())
      .filter(Boolean)
      .join('\n');
  }
  if (ext === '.sh' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.kdl') {
    return text.split(/\r?\n/u).map((line) => line.replace(/#.*$/u, '').trim()).filter(Boolean).join('\n');
  }
  return text.trim();
}

function nonTrivialEvidence(root, consumer) {
  const files = listFiles(root, consumer).filter((file) => TEXT_EXTENSIONS.has(extname(file)));
  let substantiveLines = 0;
  let bytes = 0;
  const placeholder = /\b(todo|stub|placeholder|not implemented|unimplemented|to be implemented)\b/iu;
  let placeholderOnly = false;
  for (const file of files) {
    const text = safeRead(root, file);
    bytes += Buffer.byteLength(text);
    const body = substantiveText(text, extname(file));
    if (body !== '' && placeholder.test(body) && body.split(/\r?\n/u).length <= 3) placeholderOnly = true;
    substantiveLines += body.split(/\r?\n/u).filter(Boolean).length;
  }
  const ok = files.length > 0 && substantiveLines >= 3 && bytes >= 40 && !placeholderOnly;
  return { ok, detail: ok ? `${String(files.length)} text file(s), ${String(substantiveLines)} substantive line(s)` : `non-trivial content not found (${String(files.length)} text file(s), ${String(substantiveLines)} substantive line(s))` };
}

function parseRustMods(text) {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//gu, '');
  const mods = [];
  for (const line of withoutBlocks.split(/\r?\n/u)) {
    const stripped = line.replace(/\/\/.*$/u, '').trim();
    const match = stripped.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/u);
    if (match) mods.push(match[1]);
  }
  return mods;
}

function resolveRustMod(root, parentFile, name) {
  const parentDir = dirname(parentFile);
  const baseDir = basename(parentFile) === 'mod.rs' ? parentDir : parentDir;
  const candidates = [join(baseDir, `${name}.rs`), join(baseDir, name, 'mod.rs')].map((p) => normalize(p).split(sep).join('/'));
  return candidates.find((relPath) => existsSync(join(root, relPath))) ?? null;
}

function collectRustGraph(root, rootFiles) {
  const reachable = new Set();
  const stack = rootFiles.filter((file) => existsSync(join(root, file)));
  for (const file of stack) reachable.add(file);
  while (stack.length > 0) {
    const file = stack.pop();
    const text = safeRead(root, file);
    for (const modName of parseRustMods(text)) {
      const resolved = resolveRustMod(root, file, modName);
      if (resolved && !reachable.has(resolved)) {
        reachable.add(resolved);
        stack.push(resolved);
      }
    }
  }
  return reachable;
}

function parseTsImports(text) {
  const imports = [];
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gu,
    /import\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) imports.push(match[1]);
  }
  return imports.filter((specifier) => specifier.startsWith('.'));
}

function resolveTsImport(root, fromFile, specifier) {
  const base = normalize(join(dirname(fromFile), specifier)).split(sep).join('/');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, 'index.ts').split(sep).join('/'),
    join(base, 'index.mts').split(sep).join('/'),
    join(base, 'index.js').split(sep).join('/'),
    join(base, 'index.mjs').split(sep).join('/'),
  ];
  return candidates.find((relPath) => existsSync(join(root, relPath)) && lstatSync(join(root, relPath)).isFile()) ?? null;
}

function collectTsGraph(root, rootFiles) {
  const reachable = new Set();
  const stack = rootFiles.filter((file) => existsSync(join(root, file)));
  for (const file of stack) reachable.add(file);
  while (stack.length > 0) {
    const file = stack.pop();
    const text = safeRead(root, file);
    for (const specifier of parseTsImports(text)) {
      const resolved = resolveTsImport(root, file, specifier);
      if (resolved && !reachable.has(resolved)) {
        reachable.add(resolved);
        stack.push(resolved);
      }
    }
  }
  return reachable;
}

function packageRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty package-relative path`);
  const relPath = normalize(value).split(sep).join('/');
  if (value.startsWith('/') || relPath === '..' || relPath.startsWith('../')) throw new Error(`${label} must be a non-absolute path inside the package, got ${value}`);
  return relPath.replace(/^\.\//u, '');
}

function packageProductionFiles(root) {
  const files = new Set(['package.json']);
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) return files;
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  for (const value of Object.values(pkg.bin ?? {})) if (typeof value === 'string') files.add(packageRelativePath(value, 'package.json bin entry'));
  if (pkg.pi?.extensions !== undefined) {
    if (!Array.isArray(pkg.pi.extensions)) throw new Error('package.json pi.extensions must be an array when present');
    for (const [index, value] of pkg.pi.extensions.entries()) files.add(packageRelativePath(value, `package.json pi.extensions[${index}]`));
  }
  for (const command of Object.values(pkg.scripts ?? {})) {
    if (typeof command !== 'string') continue;
    const matches = command.matchAll(/(?:node|tsx|tsc|bash|sh)\s+(?:--[A-Za-z0-9_=.-]+\s+)*(?:--test\s+)?([^\s&|;]+\.(?:mjs|js|ts|mts|sh))/gu);
    for (const match of matches) {
      const relPath = match[1].replace(/^['"]|['"]$/gu, '');
      if (!relPath.startsWith('-') && existsSync(join(root, relPath))) files.add(relPath);
    }
  }
  return files;
}

function buildReachability(root) {
  const rustRoots = [];
  for (const candidate of ['drivers/src/lib.rs', 'kernel/src/lib.rs', 'codegen/src/main.rs', 'codegen/src/lib.rs', 'modelcheck/src/main.rs', 'modelcheck/src/lib.rs']) {
    if (existsSync(join(root, candidate))) rustRoots.push(candidate);
  }
  const binDir = join(root, 'drivers/src/bin');
  if (existsSync(binDir)) {
    for (const entry of readdirSync(binDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.rs')) rustRoots.push(`drivers/src/bin/${entry.name}`);
    }
  }

  const productionFiles = packageProductionFiles(root);
  const tsRoots = Array.from(productionFiles).filter((file) => SOURCE_EXTENSIONS.has(extname(file)) && existsSync(join(root, file)));
  const reachableFiles = new Set([...collectRustGraph(root, rustRoots), ...collectTsGraph(root, tsRoots), ...productionFiles]);
  const packagePath = join(root, 'package.json');
  let packageText = '';
  if (existsSync(packagePath)) packageText = readFileSync(packagePath, 'utf8');
  return { reachableFiles, packageText };
}

function consumerReachable(root, consumer, reachability) {
  const files = listFiles(root, consumer);
  const fileHit = files.some((file) => reachability.reachableFiles.has(file));
  if (fileHit) return { ok: true, detail: 'reachable production file/module' };

  if (existsSync(join(root, consumer)) && lstatSync(join(root, consumer)).isFile() && reachability.reachableFiles.has(consumer)) {
    return { ok: true, detail: 'reachable production file' };
  }

  for (const file of reachability.reachableFiles) {
    if (isInsideOrEqual(file, consumer)) return { ok: true, detail: `reachable via ${file}` };
  }

  const needles = [consumer, consumer.endsWith('/') ? consumer : `${consumer}/`, basename(consumer)];
  for (const file of reachability.reachableFiles) {
    if (!existsSync(join(root, file)) || !TEXT_EXTENSIONS.has(extname(file))) continue;
    const text = safeRead(root, file);
    if (needles.some((needle) => needle !== '' && text.includes(needle))) return { ok: true, detail: `referenced by production ${file}` };
  }
  if (needles.some((needle) => needle !== '' && reachability.packageText.includes(needle))) return { ok: true, detail: 'referenced by package.json' };

  return { ok: false, detail: 'no production root/import/module/package reference found' };
}

function publicNames(root, consumer) {
  const names = new Set();
  const files = listFiles(root, consumer).filter((file) => TEXT_EXTENSIONS.has(extname(file)));
  const consumerAbs = join(root, consumer);
  const isDir = existsSync(consumerAbs) && lstatSync(consumerAbs).isDirectory();
  names.add(consumer);
  if (isDir) names.add(`${consumer.replace(/\/$/u, '')}/`);
  else {
    names.add(basename(consumer));
    names.add(basename(consumer, extname(consumer)));
  }
  if (isDir && existsSync(join(root, consumer, 'Cargo.toml'))) names.add(basename(consumer));
  for (const file of files) {
    names.add(file);
    const text = safeRead(root, file);
    if (extname(file) === '.rs') {
      for (const match of text.matchAll(/\bpub\s+(?:async\s+)?(?:struct|enum|fn|const|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) names.add(match[1]);
      const parts = file.replace(/^drivers\/src\//u, '').replace(/\/mod\.rs$/u, '').replace(/\.rs$/u, '').split('/').filter(Boolean);
      if (parts.length > 0) names.add(`drivers::${parts.join('::')}`);
      if (parts.length > 0) names.add(`${parts.join('::')}::`);
    } else if (['.ts', '.js', '.mjs', '.mts', '.tsx'].includes(extname(file))) {
      for (const match of text.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) names.add(match[1]);
    }
  }
  return Array.from(names).filter((name) => name.length >= 3);
}

function testFiles(root) {
  const files = [];
  for (const dir of TEST_DIRS) {
    if (existsSync(join(root, dir))) files.push(...listFiles(root, dir));
  }
  return Array.from(new Set(files)).filter((file) => TEXT_EXTENSIONS.has(extname(file))).sort();
}

function shellSelftestFiles(root) {
  if (!existsSync(join(root, 'scripts'))) return [];
  return listFiles(root, 'scripts')
    .filter((file) => extname(file) === '.sh' && /(?:^|[-_.])selftest(?:[-_.]|$)/iu.test(basename(file)))
    .sort();
}

function shellSelftestNames(root, consumer, selftestFile) {
  const names = new Set();
  for (const file of listFiles(root, consumer).filter((candidate) => TEXT_EXTENSIONS.has(extname(candidate)))) {
    if (file === selftestFile) continue;
    names.add(file);
    names.add(basename(file));
  }
  return Array.from(names).filter((name) => name.length >= 3);
}

function scriptConsumerSelftested(root, consumer) {
  const normalized = consumer.replace(/\/+$/u, '');
  if (!isInsideOrEqual(normalized, 'scripts')) return null;
  for (const file of shellSelftestFiles(root)) {
    const text = safeRead(root, file);
    for (const name of shellSelftestNames(root, consumer, file)) {
      if (text.includes(name)) return { ok: true, detail: `${file} references ${name}` };
    }
  }
  return null;
}

function consumerTested(root, consumer) {
  const tests = testFiles(root).filter((file) => !isInsideOrEqual(file, consumer));
  const names = publicNames(root, consumer);
  for (const file of tests) {
    const text = safeRead(root, file);
    for (const name of names) {
      if (text.includes(name)) return { ok: true, detail: `${file} references ${name}` };
    }
  }
  const selftested = scriptConsumerSelftested(root, consumer);
  if (selftested) return selftested;
  return { ok: false, detail: 'no test reference to consumer path/module/public item found' };
}

function assessEntry(root, entry, reachability) {
  const consumer = entry.replacement_consumer;
  const exists = existsSync(join(root, consumer));
  const nontrivial = exists ? nonTrivialEvidence(root, consumer) : { ok: false, detail: 'consumer path is missing' };
  const reachable = exists ? consumerReachable(root, consumer, reachability) : { ok: false, detail: 'consumer path is missing' };
  const tested = exists ? consumerTested(root, consumer) : { ok: false, detail: 'consumer path is missing' };
  return { entry, exists: { ok: exists, detail: exists ? 'path exists' : 'path is missing' }, nontrivial, reachable, tested };
}

function statusWord(ok, good, bad) {
  return ok ? good : bad;
}

function renderAssessment(assessment) {
  const checks = [
    `EXISTS=${statusWord(assessment.exists.ok, 'OK', 'MISSING')}`,
    `NONTRIVIAL=${statusWord(assessment.nontrivial.ok, 'OK', 'STUB_OR_EMPTY')}`,
    `REACHABLE=${statusWord(assessment.reachable.ok, 'OK', 'ORPHANED')}`,
    `TESTED=${statusWord(assessment.tested.ok, 'OK', 'UNTESTED')}`,
  ].join(' ');
  return `${assessment.entry.path} -> ${assessment.entry.replacement_consumer} -> ${checks}`;
}

function failingChecks(assessment) {
  return [
    ['EXISTS', assessment.exists],
    ['NONTRIVIAL', assessment.nontrivial],
    ['REACHABLE', assessment.reachable],
    ['TESTED', assessment.tested],
  ].filter(([, result]) => !result.ok).map(([name, result]) => `${name}: ${result.detail}`);
}

function runCheck(options) {
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = resolve(options.root ?? scriptRoot);
  const manifestPath = resolve(root, options.manifest ?? 'retain-port-delete.yaml');
  let manifest;
  try {
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
    validateManifest(manifest);
  } catch (error) {
    error.usage = true;
    throw error;
  }
  const deleteEntries = manifest.dispositions.filter((entry) => entry.disposition === 'delete');
  if (deleteEntries.length === 0) throw new Error('manifest contains no delete entries to verify');

  const reachability = buildReachability(root);
  const assessments = deleteEntries.map((entry) => assessEntry(root, entry, reachability));
  const ready = assessments.filter((assessment) => failingChecks(assessment).length === 0);
  const notReady = assessments.filter((assessment) => failingChecks(assessment).length > 0);

  process.stdout.write('Replacement consumer verification\n');
  process.stdout.write(`Manifest: ${toRel(root, manifestPath)}\n`);
  process.stdout.write(`Delete entries assessed: ${String(assessments.length)}\n`);
  process.stdout.write(`Ready to delete: ${String(ready.length)}\n`);
  process.stdout.write(`NOT ready: ${String(notReady.length)}\n\n`);
  process.stdout.write('Per-entry results:\n');
  for (const assessment of assessments) process.stdout.write(`  ${renderAssessment(assessment)}\n`);

  if (notReady.length > 0) {
    process.stdout.write('\nNOT-ready entries:\n');
    for (const assessment of notReady) {
      process.stdout.write(`  - ${assessment.entry.path} -> ${assessment.entry.replacement_consumer}\n`);
      for (const failure of failingChecks(assessment)) process.stdout.write(`      ${failure}\n`);
    }
    return 1;
  }

  process.stdout.write('\nAll delete entries have live, non-trivial, reachable, tested replacement consumers.\n');
  return 0;
}

function manifest(entries) {
  const body = entries.map((entry) => {
    const lines = [
      `  - path: ${JSON.stringify(entry.path)}`,
      `    kind: ${entry.kind ?? 'exact'}`,
      `    disposition: ${entry.disposition ?? 'delete'}`,
      `    loc: ${String(entry.loc ?? 1)}`,
      `    reason: ${JSON.stringify(entry.reason ?? 'D77 §7 selftest')}`,
    ];
    if (entry.replacement_slice !== false) lines.push(`    replacement_slice: ${entry.replacement_slice ?? 'slice-7'}`);
    if (entry.replacement_consumer !== undefined) lines.push(`    replacement_consumer: ${entry.replacement_consumer}`);
    return lines.join('\n');
  }).join('\n');
  return `schema: autopilot.disposition.v1\nbaseline:\n  commit: selftest\n  tree: selftest\n  tracked_paths: 1\n  total_loc: 1\ngenerated_at_wave: W8\ndispositions:\n${body}\n`;
}

function writeFixture(root, options) {
  mkdirSync(join(root, 'drivers/src/live'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'drivers/src/lib.rs'), options.reachable ? 'pub mod live;\n' : '// orphan fixture\n');
  if (options.consumer) writeFileSync(join(root, 'drivers/src/live/mod.rs'), `pub struct LiveReplacement;\npub fn live_replacement() -> LiveReplacement { LiveReplacement }\npub fn live_label() -> &'static str { "live" }\n`);
  if (options.tested) writeFileSync(join(root, 'tests/live.rs'), 'use drivers::live::{live_replacement, LiveReplacement};\n#[test]\nfn covers_live_replacement() { let _: LiveReplacement = live_replacement(); }\n');
  writeFileSync(join(root, 'retain-port-delete.yaml'), manifest([{ path: 'legacy.ts', replacement_consumer: options.malformed ? undefined : 'drivers/src/live' }]));
}

function writeUntestedScriptFixture(root) {
  mkdirSync(join(root, 'scripts/uncovered'), { recursive: true });
  writeFileSync(join(root, 'scripts/uncovered/run.sh'), '#!/usr/bin/env sh\nset -eu\nprintf "%s\\n" uncovered\n');
  writeFileSync(join(root, 'package.json'), '{"scripts":{"uncovered":"sh scripts/uncovered/run.sh"}}\n');
  writeFileSync(join(root, 'retain-port-delete.yaml'), manifest([{ path: 'legacy-script.ts', replacement_consumer: 'scripts/uncovered' }]));
}

function execNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function runSelftest() {
  const script = fileURLToPath(import.meta.url);
  const tmp = mkdtempSync(join(tmpdir(), 'autopilot-replacements-selftest.'));
  let passes = 0;
  let failures = 0;
  const expect = (want, label, args, cwd) => {
    const wants = Array.isArray(want) ? want : [want];
    const got = execNode(script, args, cwd);
    if (wants.includes(got.status)) {
      process.stdout.write(`  ok    ${label} (exit ${got.status})\n`);
      passes += 1;
    } else {
      process.stderr.write(`  FAIL  ${label} — expected exit ${wants.join(' or ')}, got ${got.status}\n`);
      process.stderr.write(`${got.stdout}${got.stderr}`.split('\n').map((line) => `          ${line}`).join('\n'));
      process.stderr.write('\n');
      failures += 1;
    }
  };

  try {
    process.stdout.write('verify-replacements selftest\n');

    const missing = join(tmp, 'missing');
    mkdirSync(missing, { recursive: true });
    writeFixture(missing, { consumer: false, reachable: false, tested: false });
    expect(1, 'missing consumer path is rejected', ['--root', missing], missing);

    const orphaned = join(tmp, 'orphaned');
    mkdirSync(orphaned, { recursive: true });
    writeFixture(orphaned, { consumer: true, reachable: false, tested: true });
    expect(1, 'orphaned consumer is rejected', ['--root', orphaned], orphaned);

    const untested = join(tmp, 'untested');
    mkdirSync(untested, { recursive: true });
    writeFixture(untested, { consumer: true, reachable: true, tested: false });
    expect(1, 'reachable but untested consumer is rejected', ['--root', untested], untested);

    const untestedScript = join(tmp, 'untested-script');
    mkdirSync(untestedScript, { recursive: true });
    writeUntestedScriptFixture(untestedScript);
    expect(1, 'scripts consumer without shell selftest coverage is rejected', ['--root', untestedScript], untestedScript);

    const valid = join(tmp, 'valid');
    mkdirSync(valid, { recursive: true });
    writeFixture(valid, { consumer: true, reachable: true, tested: true });
    expect(0, 'fully valid manifest is accepted', ['--root', valid], valid);

    const malformed = join(tmp, 'malformed');
    mkdirSync(malformed, { recursive: true });
    writeFixture(malformed, { consumer: true, reachable: true, tested: true, malformed: true });
    expect([1, 2], 'malformed delete entry fails loudly', ['--root', malformed], malformed);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(`\nselftest: ${String(passes)} passed, ${String(failures)} failed\n`);
  return failures === 0 ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
try {
  const code = args.selftest ? runSelftest() : runCheck(args);
  process.exit(code);
} catch (error) {
  const exitCode = error.usage ? 2 : 2;
  process.stderr.write(`verify-replacements: ${error.message}\n`);
  process.exit(exitCode);
}
