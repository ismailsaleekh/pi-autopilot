#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));
const EXPECTED_COMMANDS = Object.freeze(['autopilot-plan', 'autopilot', 'autopilot-onboard', 'autopilot-inject', 'autopilot-status', 'autopilot-config', 'autopilot-handoff', 'autopilot-close', 'autopilot-abort', 'autopilot-answer']);
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
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0]?.filename !== 'string') fail('npm pack must return exactly one filename');
  const path = join(directory, value[0].filename);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`npm pack output is not one regular file: ${path}`);
  return { path, result: value[0] };
}
function packageJson(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.name !== 'string' || typeof value.version !== 'string') fail(`package manifest is malformed: ${path}`);
  return value;
}
function walkManifest(root) {
  const entries = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name); const rel = relative(root, path).replace(/\\/gu, '/'); const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) visit(path);
      else if (info.isFile() && !info.isSymbolicLink()) entries.set(rel, { kind: 'file', byte_count: info.size, sha256: sha256(readFileSync(path)), mode: info.mode & 0o777 });
      else if (info.isSymbolicLink()) entries.set(rel, { kind: 'symlink', target: readlinkSync(path) });
      else fail(`package tree contains a non-regular entry: ${path}`);
    }
  };
  visit(root); return entries;
}
function assertInstalledManifest(expectedRoot, installedRoot, packFiles) {
  const expected = walkManifest(expectedRoot); const installed = walkManifest(installedRoot);
  const declared = packFiles.map((entry) => entry.path).sort(); const expectedNames = [...expected.keys()].sort(); const installedNames = [...installed.keys()].sort();
  if (JSON.stringify(declared) !== JSON.stringify(expectedNames)) fail('extracted tarball manifest differs from npm pack --json manifest');
  if (JSON.stringify(expectedNames) !== JSON.stringify(installedNames)) fail('installed package manifest differs from the exact tarball manifest');
  for (const path of expectedNames) if (JSON.stringify(expected.get(path)) !== JSON.stringify(installed.get(path))) fail(`installed package bytes/mode differ at ${path}`);
  return { file_count: expectedNames.length, manifest_sha256: sha256(Buffer.from(JSON.stringify(expectedNames.map((path) => [path, expected.get(path)])))) };
}
async function extensionCommands(factory) {
  const commands = []; let providerCalls = 0;
  const host = { registerCommand: (name) => { commands.push(name); }, registerTool: () => {}, sendUserMessage: () => {}, sendMessage: () => {}, on: () => {}, setModel: async () => { providerCalls += 1; throw new Error('provider canary invoked'); }, events: { backgroundTasks: { capabilities: async () => ({ available: true }), run: async () => { throw new Error('registration must not run tasks'); }, onTerminal: () => () => {} } } };
  await factory(host);
  if (providerCalls !== 0) fail('extension invoked a provider during registration');
  if (JSON.stringify(commands) !== JSON.stringify(EXPECTED_COMMANDS)) fail(`extension commands are not exact: ${commands.join(',')}`);
  if (new Set(commands).size !== commands.length) fail('extension registered a command more than once');
}
function installNetworkCanary(marker) {
  const require = createRequire(import.meta.url); const originals = [];
  const deny = (label) => { writeFileSync(marker, `${label}\n`, { flag: 'a' }); throw new Error(`network canary invoked: ${label}`); };
  for (const [moduleName, names] of [['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']], ['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:dgram', ['createSocket']]]) {
    const mod = require(moduleName); for (const name of names) { const original = mod[name]; originals.push(() => { mod[name] = original; }); mod[name] = () => deny(`${moduleName}.${name}`); }
  }
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => deny('global.fetch'); syncBuiltinESMExports();
  return () => { for (const restore of originals.reverse()) restore(); globalThis.fetch = originalFetch; syncBuiltinESMExports(); };
}
async function main() {
  const tarballArg = process.argv[2];
  if (tarballArg === undefined || process.argv.length !== 3 || !isAbsolute(tarballArg)) fail('usage: node scripts/verify-packed-consumer.mjs <absolute-candidate-tarball>');
  const tarInfo = lstatSync(tarballArg); if (!tarInfo.isFile() || tarInfo.isSymbolicLink()) fail('candidate tarball must be one regular non-symlink file');
  const tarball = realpathSync(tarballArg); if (under(sourceRoot, tarball)) fail('candidate tarball must be outside the source clone');
  const root = mkdtempSync(join(tmpdir(), 'pi-autopilot-packed-consumer-')); chmodSync(root, 0o700);
  const networkMarker = join(root, 'network-canary-invoked'); const networkPreload = join(root, 'deny-network.cjs');
  writeFileSync(networkPreload, `'use strict';\nconst fs=require('node:fs');const marker=${JSON.stringify(networkMarker)};const deny=(label)=>{fs.writeFileSync(marker,label+'\\n',{flag:'a'});throw new Error('network canary invoked: '+label)};for(const [n,fsx] of [['node:net',['connect','createConnection']],['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']],['node:dgram',['createSocket']]]){const m=require(n);for(const f of fsx)m[f]=()=>deny(n+'.'+f)}globalThis.fetch=async()=>deny('global.fetch');\n`);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'home', '.npmrc'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', CI: '1', AUTOPILOT_STATE_ROOT: join(root, 'state'), NODE_OPTIONS: `--require=${networkPreload}` };
  for (const p of [env.HOME, env.TMPDIR, env.npm_config_cache, env.AUTOPILOT_STATE_ROOT]) mkdirSync(p, { recursive: true, mode: 0o700 });
  let summary;
  try {
    const project = join(root, 'project'); mkdirSync(project, { recursive: true, mode: 0o700 });
    const localPeerRoot = realpathSync(join(sourceRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')); const localPeer = packageJson(join(localPeerRoot, 'package.json'));
    const bundledPeerRoot = join(root, 'bundled-pi-peer'); cpSync(localPeerRoot, bundledPeerRoot, { recursive: true });
    const packs = join(root, 'packs'); mkdirSync(packs, { mode: 0o700 }); const peerPacked = onePack(checkedRun('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packs], bundledPeerRoot, env), packs);
    checkedRun('npm', ['init', '-y'], project, env); checkedRun('npm', ['install', '--offline', '--ignore-scripts', peerPacked.path, tarball], project, env);
    const installedRoot = realpathSync(join(project, 'node_modules', 'pi-autopilot'));
    const manifestValue = JSON.parse(checkedRun('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], sourceRoot, env));
    if (!Array.isArray(manifestValue) || manifestValue.length !== 1 || !Array.isArray(manifestValue[0]?.files)) fail('candidate npm pack manifest is malformed');
    const extracted = join(root, 'extracted'); mkdirSync(extracted, { mode: 0o700 }); checkedRun('tar', ['-xzf', tarball, '-C', extracted], root, env);
    const installedManifest = assertInstalledManifest(join(extracted, 'package'), installedRoot, manifestValue[0].files);
    const restore = installNetworkCanary(networkMarker);
    try { const peerRequire = createRequire(join(project, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')); const { createJiti } = peerRequire('jiti'); const jiti = createJiti(import.meta.url, { moduleCache: false }); await extensionCommands(await jiti.import(join(installedRoot, 'extensions', 'autopilot.ts'), { default: true })); }
    finally { restore(); }
    if (existsSync(networkMarker)) fail(`packed witness attempted network access: ${readFileSync(networkMarker, 'utf8').trim()}`);
    const statusInput = '{"v":1,"id":1,"kind":"command","payload":{"raw":"autopilot-status"}}\n';
    const coreStatus = spawnSync(join(project, 'node_modules', '.bin', 'autopilot-core'), [], { cwd: project, env, input: statusInput, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (coreStatus.error !== undefined || coreStatus.status !== 0 || coreStatus.signal !== null) fail(`installed autopilot-core status probe failed status=${String(coreStatus.status)} signal=${String(coreStatus.signal)} error=${coreStatus.error?.message ?? '<none>'}\n${coreStatus.stderr}`);
    const frame = JSON.parse(coreStatus.stdout.trim()); if (frame?.kind !== 'done' || typeof frame?.status !== 'string') fail('installed autopilot-core status probe did not return done');
    const agentHelp = spawnSync(join(project, 'node_modules', '.bin', 'autopilot-agent-run'), ['--help'], { cwd: project, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (agentHelp.error !== undefined || agentHelp.status !== 0 || agentHelp.signal !== null) fail(`installed autopilot-agent-run --help failed status=${String(agentHelp.status)} signal=${String(agentHelp.signal)} error=${agentHelp.error?.message ?? '<none>'}\n${agentHelp.stderr}`);
    summary = { schema_version: 'autopilot.packed_consumer_witness.v2', candidate_tarball: { path: tarball, byte_count: tarInfo.size, sha256: sha256(readFileSync(tarball)) }, pi_peer: { name: localPeer.name, version: localPeer.version, sha256: sha256(readFileSync(peerPacked.path)) }, installed_manifest: installedManifest, commands: EXPECTED_COMMANDS, core_status_probe: true, agent_run_help: true, network_calls: 0, passed: true };
  } finally { rmSync(root, { recursive: true, force: false }); }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
