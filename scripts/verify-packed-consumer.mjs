#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));
const EXPECTED_COMMANDS = Object.freeze(['autopilot', 'autopilot-inject', 'autopilot-close', 'autopilot-abort', 'autopilot-config', 'autopilot-claim-gc', 'autopilot-coordination', 'autopilot-onboard', 'autopilot-handoff']);

function fail(message) { throw new Error(`packed-consumer-invalid: ${message}`); }
function sha256(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function under(parent, candidate) { const rel = relative(parent, candidate); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
function checkedRun(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) fail(`${command} ${args.join(' ')} failed status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? '<none>'}\n${result.stderr}`);
  return result.stdout;
}
function onePack(stdout, directory) {
  const value = JSON.parse(stdout);
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'object' || value[0] === null) fail('npm pack must return exactly one result');
  const filename = value[0].filename;
  if (typeof filename !== 'string' || filename.length === 0) fail('npm pack result omitted filename');
  const path = join(directory, filename);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`npm pack output is not one regular file: ${path}`);
  return { path, result: value[0] };
}
function packageJson(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.name !== 'string' || typeof value.version !== 'string') fail(`package manifest is malformed: ${path}`);
  return value;
}
function resolveDependency(ownerRoot, name) {
  let current = ownerRoot;
  for (;;) {
    const candidate = join(current, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(current);
    if (parent === current || !under(sourceRoot, parent)) return null;
    current = parent;
  }
}
function dependencyNames(manifest, field) {
  const value = manifest[field];
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${manifest.name} ${field} is malformed`);
  return Object.keys(value).sort();
}
function collectDependencyClosure(peerRoot) {
  const queue = [peerRoot];
  const packages = [];
  const seen = new Set();
  while (queue.length > 0) {
    const root = queue.shift();
    const manifest = packageJson(join(root, 'package.json'));
    const identity = `${manifest.name}@${manifest.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    packages.push({ root, manifest });
    for (const name of dependencyNames(manifest, 'dependencies')) {
      const resolved = resolveDependency(root, name);
      if (resolved === null) fail(`required lockfile-resolved dependency is absent: ${identity} -> ${name}`);
      queue.push(resolved);
    }
    for (const name of dependencyNames(manifest, 'optionalDependencies')) {
      const resolved = resolveDependency(root, name);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return packages;
}
function walkManifest(root) {
  const entries = new Map();
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path).replace(/\\/gu, '/');
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) visit(path);
      else if (info.isFile() && !info.isSymbolicLink()) entries.set(rel, { kind: 'file', byte_count: info.size, sha256: sha256(readFileSync(path)), mode: info.mode & 0o777 });
      else if (info.isSymbolicLink()) entries.set(rel, { kind: 'symlink', target: readlinkSync(path) });
      else fail(`package tree contains a non-regular entry: ${path}`);
    }
  };
  visit(root);
  return entries;
}
function assertInstalledManifest(expectedRoot, installedRoot, packFiles) {
  const expected = walkManifest(expectedRoot);
  const installed = walkManifest(installedRoot);
  const declared = [...packFiles].map((entry) => {
    if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string') fail('npm pack files entry is malformed');
    return entry.path;
  }).sort();
  const expectedNames = [...expected.keys()].sort();
  const installedNames = [...installed.keys()].sort();
  if (JSON.stringify(declared) !== JSON.stringify(expectedNames)) fail('extracted tarball manifest differs from npm pack --json manifest');
  if (JSON.stringify(expectedNames) !== JSON.stringify(installedNames)) fail('installed package manifest differs from the exact tarball manifest');
  for (const path of expectedNames) {
    const left = expected.get(path);
    const right = installed.get(path);
    if (JSON.stringify(left) !== JSON.stringify(right)) fail(`installed package bytes/mode differ at ${path}`);
  }
  return { file_count: expectedNames.length, manifest_sha256: sha256(Buffer.from(JSON.stringify(expectedNames.map((path) => [path, expected.get(path)])))) };
}
async function extensionCommands(factory, label) {
  if (typeof factory !== 'function') fail(`${label} extension default export is not a function`);
  const commands = [];
  let providerCalls = 0;
  const host = {
    registerCommand: (name) => { commands.push(name); },
    registerTool: () => {},
    sendUserMessage: () => {},
    sendMessage: () => {},
    on: () => {},
    setModel: async () => { providerCalls += 1; throw new Error('provider canary invoked'); },
  };
  await factory(host);
  if (providerCalls !== 0) fail(`${label} extension invoked a provider during registration`);
  if (JSON.stringify(commands) !== JSON.stringify(EXPECTED_COMMANDS)) fail(`${label} extension commands are not the exact nine-command sequence: ${commands.join(',')}`);
  if (new Set(commands).size !== commands.length) fail(`${label} extension registered a command more than once`);
  return commands;
}
function installNetworkCanary(marker) {
  const require = createRequire(import.meta.url);
  const originals = [];
  const deny = (label) => {
    writeFileSync(marker, label, { flag: 'a' });
    throw new Error(`network canary invoked: ${label}`);
  };
  for (const [moduleName, names] of [['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']], ['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:dgram', ['createSocket']]]) {
    const module = require(moduleName);
    for (const name of names) {
      const original = module[name];
      if (typeof original !== 'function') fail(`network canary cannot patch ${moduleName}.${name}`);
      originals.push(() => { module[name] = original; });
      module[name] = (..._args) => deny(`${moduleName}.${name}`);
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (..._args) => deny('global.fetch');
  syncBuiltinESMExports();
  return () => {
    for (const restore of originals.reverse()) restore();
    globalThis.fetch = originalFetch;
    syncBuiltinESMExports();
  };
}

function manifestProjection(module, label) {
  const manifest = module.D65_CONTRACT_MANIFEST;
  if (!Array.isArray(manifest)) fail(`${label} contract manifest is absent`);
  return manifest.map((entry) => {
    if (typeof entry !== 'object' || entry === null || typeof entry.schema_version !== 'string' || typeof entry.owner !== 'string' || typeof entry.parse !== 'function') fail(`${label} contract manifest entry is malformed`);
    return { schema_version: entry.schema_version, owner: entry.owner };
  });
}

async function main() {
  const tarballArg = process.argv[2];
  if (tarballArg === undefined || process.argv.length !== 3 || !isAbsolute(tarballArg)) fail('usage: node scripts/verify-packed-consumer.mjs <absolute-candidate-tarball>');
  const tarInfo = lstatSync(tarballArg);
  if (!tarInfo.isFile() || tarInfo.isSymbolicLink()) fail('candidate tarball must be one regular non-symlink file');
  const tarball = realpathSync(tarballArg);
  if (under(sourceRoot, tarball)) fail('candidate tarball must be outside the source clone');
  const root = mkdtempSync(join(tmpdir(), 'pi-autopilot-packed-consumer-'));
  chmodSync(root, 0o700);
  if (under(sourceRoot, realpathSync(root)) || under(realpathSync(root), sourceRoot)) fail('witness root must be outside the source clone');
  const networkMarker = join(root, 'network-canary-invoked');
  const networkPreload = join(root, 'deny-network.cjs');
  writeFileSync(networkPreload, `'use strict';\nconst fs=require('node:fs');\nconst marker=${JSON.stringify(networkMarker)};\nconst deny=(label)=>{fs.writeFileSync(marker,label+'\\n',{flag:'a'});throw new Error('network canary invoked: '+label)};\nfor(const [name,fields] of [['node:net',['connect','createConnection']],['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']],['node:dgram',['createSocket']]]){const mod=require(name);for(const field of fields)mod[field]=(..._args)=>deny(name+'.'+field)}\nglobalThis.fetch=async(..._args)=>deny('global.fetch');\n`);
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'home', '.npmrc'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', CI: '1', AUTOPILOT_STATE_ROOT: join(root, 'state'), NODE_OPTIONS: `--require=${networkPreload}`,
  };
  for (const path of [env.HOME, env.TMPDIR, env.npm_config_cache, env.AUTOPILOT_STATE_ROOT]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const discoveryMarker = join(root, 'forbidden-discovery-marker');
  const project = join(root, 'project');
  const globalExtensions = join(env.HOME, '.pi', 'agent', 'extensions');
  const projectExtensions = join(project, '.pi', 'extensions');
  mkdirSync(globalExtensions, { recursive: true, mode: 0o700 });
  mkdirSync(projectExtensions, { recursive: true, mode: 0o700 });
  writeFileSync(join(globalExtensions, 'forbidden.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(discoveryMarker)},'global');\n`);
  writeFileSync(join(projectExtensions, 'forbidden.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(discoveryMarker)},'project');\n`);
  let summary;
  try {
    const localPeerRoot = realpathSync(join(sourceRoot, 'node_modules', '@earendil-works', 'pi-coding-agent'));
    const localPeer = packageJson(join(localPeerRoot, 'package.json'));
    const packageLock = packageJson(join(sourceRoot, 'package-lock.json'));
    const lockPeer = packageLock.packages?.['node_modules/@earendil-works/pi-coding-agent'];
    if (typeof lockPeer !== 'object' || lockPeer === null || lockPeer.version !== localPeer.version) fail('local Pi peer version differs from the exact package-lock resolution');
    const dependencyClosure = collectDependencyClosure(localPeerRoot);
    const bundledPeerRoot = join(root, 'bundled-pi-peer');
    cpSync(localPeerRoot, bundledPeerRoot, { recursive: true });
    const bundledManifest = packageJson(join(bundledPeerRoot, 'package.json'));
    const directNames = [...dependencyNames(localPeer, 'dependencies'), ...dependencyNames(localPeer, 'optionalDependencies')];
    bundledManifest.bundledDependencies = [...new Set(directNames.filter((name) => existsSync(join(localPeerRoot, 'node_modules', ...name.split('/')))))].sort();
    writeFileSync(join(bundledPeerRoot, 'package.json'), `${JSON.stringify(bundledManifest, null, 2)}\n`);
    const packs = join(root, 'packs');
    mkdirSync(packs, { mode: 0o700 });
    const peerPacked = onePack(checkedRun('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packs], bundledPeerRoot, env), packs);
    const peerSeal = { name: localPeer.name, version: localPeer.version, byte_count: statSync(peerPacked.path).size, sha256: sha256(readFileSync(peerPacked.path)), bundled_dependency_count: dependencyClosure.length - 1 };

    mkdirSync(project, { recursive: true, mode: 0o700 });
    checkedRun('npm', ['init', '-y'], project, env);
    checkedRun('npm', ['install', '--offline', '--ignore-scripts', peerPacked.path, tarball], project, env);
    const installedRoot = realpathSync(join(project, 'node_modules', 'pi-autopilot'));
    const installedPeer = packageJson(join(project, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'));
    if (installedPeer.version !== localPeer.version) fail('installed Pi peer version differs from the sealed local peer');

    const manifestOutput = checkedRun('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], sourceRoot, env);
    const manifestValue = JSON.parse(manifestOutput);
    if (!Array.isArray(manifestValue) || manifestValue.length !== 1 || !Array.isArray(manifestValue[0]?.files)) fail('candidate npm pack manifest is malformed');
    const extracted = join(root, 'extracted');
    mkdirSync(extracted, { mode: 0o700 });
    checkedRun('tar', ['-xzf', tarball, '-C', extracted], root, env);
    const installedManifest = assertInstalledManifest(join(extracted, 'package'), installedRoot, manifestValue[0].files);

    const restoreNetworkCanary = installNetworkCanary(networkMarker);
    try {
      const peerRequire = createRequire(join(project, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'));
      const { createJiti } = peerRequire('jiti');
      const jiti = createJiti(import.meta.url, { moduleCache: false });
      const sourceFactory = await jiti.import(join(installedRoot, 'extensions', 'autopilot.ts'), { default: true });
      const distModule = await import(`${pathToFileURL(join(installedRoot, 'dist', 'src', 'extension.js')).href}?witness=${randomUUID()}`);
      const sourceCommands = await extensionCommands(sourceFactory, 'source');
      const distCommands = await extensionCommands(distModule.default, 'dist');
      if (JSON.stringify(sourceCommands) !== JSON.stringify(distCommands)) fail('source/dist extension commands differ');
      const sourceContracts = await jiti.import(join(installedRoot, 'src', 'core', 'coordination', 'd65-contract-manifest.ts'));
      const distContracts = await import(`${pathToFileURL(join(installedRoot, 'dist', 'src', 'core', 'coordination', 'd65-contract-manifest.js')).href}?witness=${randomUUID()}`);
      if (JSON.stringify(manifestProjection(sourceContracts, 'source')) !== JSON.stringify(manifestProjection(distContracts, 'dist'))) fail('source/dist D65 contract manifests differ');
    } finally {
      restoreNetworkCanary();
    }
    if (existsSync(networkMarker)) fail(`packed witness attempted network access: ${readFileSync(networkMarker, 'utf8').trim()}`);
    if (existsSync(discoveryMarker)) fail('source/dist extension load performed forbidden project/global discovery');

    const agentHelp = checkedRun(process.execPath, [join(installedRoot, 'bin', 'autopilot-agent-run.mjs'), '--help'], project, env);
    const coordinatorHelp = checkedRun(process.execPath, [join(installedRoot, 'bin', 'autopilot-coordinator.mjs'), '--help'], project, env);
    if (!/^usage: autopilot-agent-run/mu.test(agentHelp)) fail('installed autopilot-agent-run --help output is missing');
    if (!/^usage: autopilot-coordinator/mu.test(coordinatorHelp)) fail('installed autopilot-coordinator --help output is missing');
    const gitSpawnCheck = JSON.parse(checkedRun(process.execPath, [join(installedRoot, 'scripts', 'check-production-git-spawns.mjs'), installedRoot], project, env));
    if (gitSpawnCheck.passed !== true || !Array.isArray(gitSpawnCheck.violations) || gitSpawnCheck.violations.length !== 0) fail('installed raw production Git spawn check failed');
    if (existsSync(discoveryMarker)) fail('installed CLI help performed forbidden discovery');
    if (existsSync(networkMarker)) fail(`installed CLI help attempted network access: ${readFileSync(networkMarker, 'utf8').trim()}`);
    summary = { schema_version: 'autopilot.packed_consumer_witness.v1', candidate_tarball: { path: tarball, byte_count: tarInfo.size, sha256: sha256(readFileSync(tarball)) }, pi_peer: peerSeal, installed_manifest: installedManifest, commands: EXPECTED_COMMANDS, source_dist_contract_parity: true, network_calls: 0, discovery_canary_touched: false, raw_production_git_spawns: 0, passed: true };
  } finally {
    rmSync(root, { recursive: true, force: false });
  }
  if (existsSync(root)) fail('packed consumer temporary root survived cleanup');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
