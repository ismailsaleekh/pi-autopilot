#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { EOL, platform, release, type as osType } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGitQuery } from '../dist/src/core/git-process.js';

const packageRoot = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));
const encoder = new TextEncoder();
const METERED_CREDENTIAL = /^(?:OPENAI|ANTHROPIC|OPENROUTER|GOOGLE|GEMINI|MISTRAL|GROQ|XAI|AZURE_OPENAI|AWS_BEDROCK).*(?:API_KEY|TOKEN|SECRET|CREDENTIAL|PROFILE)$/iu;
const EXPLICIT_METERED_CREDENTIALS = Object.freeze(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']);
const NETWORK_LANES = new Set(['install', 'security-audit']);

function fail(message) {
  throw new Error(`certified-command-invalid: ${message}`);
}

function positiveInteger(value, label) {
  if (!/^\d+$/u.test(value)) fail(`${label} must be a positive decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} must be a positive safe integer`);
  return parsed;
}

function parseArgs(argv) {
  let evidenceDir;
  let id;
  let timeoutMs;
  let maxRssBytes;
  const artifacts = [];
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') { index += 1; break; }
    const value = argv[index + 1];
    if (value === undefined) fail(`${String(arg)} requires a value`);
    if (arg === '--evidence-dir') evidenceDir = value;
    else if (arg === '--id') id = value;
    else if (arg === '--timeout-ms') timeoutMs = positiveInteger(value, 'timeout-ms');
    else if (arg === '--max-rss-bytes') maxRssBytes = positiveInteger(value, 'max-rss-bytes');
    else if (arg === '--artifact') artifacts.push(value);
    else fail(`unknown option ${String(arg)}`);
    index += 1;
  }
  const command = argv.slice(index);
  if (evidenceDir === undefined || id === undefined || timeoutMs === undefined || maxRssBytes === undefined) fail('evidence-dir, id, timeout-ms, and max-rss-bytes are required');
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(id)) fail('id must be a bounded lowercase filesystem-safe identifier');
  if (command.length === 0) fail('literal command argv is required after --');
  if (!isAbsolute(evidenceDir)) fail('evidence-dir must be absolute');
  for (const artifact of artifacts) if (!isAbsolute(artifact)) fail('declared artifact paths must be absolute');
  return Object.freeze({ evidenceDir, id, timeoutMs, maxRssBytes, command: Object.freeze(command), artifacts: Object.freeze(artifacts) });
}

function exactMode(path, mode) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== mode) fail(`${path} must be a non-symlink mode-${mode.toString(8)} directory`);
}

function under(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function checkedEvidenceRoot(path) {
  exactMode(path, 0o700);
  const root = realpathSync(path);
  if (under(packageRoot, root) || under(root, packageRoot)) fail('evidence-dir must be outside and must not contain the candidate clone');
  return root;
}

function gitQueryBytes(descriptor, home) {
  const result = runGitQuery({ cwd: packageRoot, descriptor, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: platform() === 'win32' ? 'NUL' : '/dev/null' } });
  if (result.negative) fail(`${descriptor.kind} returned a negative Git query while sealing candidate identity`);
  return result.stdout;
}

function candidateSeal(home) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const status = gitQueryBytes({ kind: 'status-porcelain-lines' }, home);
  return Object.freeze({ commit: decoder.decode(gitQueryBytes({ kind: 'head' }, home)).trim(), tree: decoder.decode(gitQueryBytes({ kind: 'resolve-tree', revision: 'HEAD' }, home)).trim(), status_sha256: `sha256:${createHash('sha256').update(status).digest('hex')}` });
}

function sha256File(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`declared artifact is not one regular non-symlink file: ${path}`);
  const bytes = readFileSync(path);
  return Object.freeze({ path: realpathSync(path), byte_count: bytes.byteLength, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
}

function writeChunk(fd, hash, counts, chunk) {
  const bytes = chunk instanceof Uint8Array ? chunk : encoder.encode(String(chunk));
  hash.update(bytes);
  counts.value += bytes.byteLength;
  writeAll(fd, bytes);
}

function processSnapshot(rootPid) {
  const rows = [];
  if (platform() === 'win32') {
    const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    if (result.status !== 0 || result.error !== undefined || result.stdout.trim().length === 0) return null;
    try {
      const parsed = JSON.parse(result.stdout);
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        const pid = Number(entry.ProcessId); const ppid = Number(entry.ParentProcessId); const rssBytes = Number(entry.WorkingSetSize);
        if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 && Number.isSafeInteger(rssBytes) && rssBytes >= 0) rows.push({ pid, ppid, rssBytes });
      }
    } catch { return null; }
  } else {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    if (result.status !== 0 || result.error !== undefined) return null;
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
      if (match === null) continue;
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024 });
    }
  }
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  }
  let rssBytes = 0;
  const identities = [];
  for (const row of rows) if (descendants.has(row.pid)) { rssBytes += row.rssBytes; identities.push(Object.freeze({ pid: row.pid, ppid: row.ppid })); }
  return Object.freeze({ rssBytes, identities: Object.freeze(identities.sort((left, right) => left.pid - right.pid)) });
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'EPERM'; }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) { return error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'ESRCH'; }
}

function windowsTreeSignal(pid, force) {
  const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  if (result.error !== undefined) return false;
  if (result.status === 0) return true;
  try { process.kill(pid, 0); return false; }
  catch { return true; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'EPERM'; }
}

function childEnvironment(runtimeRoot, id) {
  const network = NETWORK_LANES.has(id);
  const networkMarker = join(runtimeRoot, 'network-canary-invoked');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    CI: '1',
    HOME: join(runtimeRoot, 'home'),
    USERPROFILE: join(runtimeRoot, 'home'),
    TMPDIR: join(runtimeRoot, 'tmp'),
    TMP: join(runtimeRoot, 'tmp'),
    TEMP: join(runtimeRoot, 'tmp'),
    npm_config_cache: join(runtimeRoot, 'npm-cache'),
    npm_config_userconfig: join(runtimeRoot, 'home', '.npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: network ? 'true' : 'false',
    npm_config_offline: network ? 'false' : 'true',
    PI_OFFLINE: network ? '0' : '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    AUTOPILOT_CERTIFIED_NETWORK: network ? 'registry-only' : 'forbidden',
  };
  if (!network) {
    const preload = join(runtimeRoot, 'deny-network.cjs');
    writeFileSync(preload, `'use strict';\nconst fs=require('node:fs');\nconst marker=${JSON.stringify(networkMarker)};\nconst deny=(label)=>{fs.writeFileSync(marker,label+'\\n',{flag:'a'});throw new Error('certified network access forbidden: '+label)};\nconst net=require('node:net');\nfor(const field of ['connect','createConnection']){const original=net[field];net[field]=function(...args){const first=args[0];const tcp=typeof first==='number'||(first!==null&&typeof first==='object'&&('port'in first||'host'in first));if(tcp)return deny('node:net.'+field);return original.apply(this,args)}}\nfor(const [name,fields] of [['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']],['node:dgram',['createSocket']]]){const mod=require(name);for(const field of fields)mod[field]=(..._args)=>deny(name+'.'+field)}\nglobalThis.fetch=async(..._args)=>deny('global.fetch');\n`, { mode: 0o600 });
    env.NODE_OPTIONS = `--require=${preload}`;
  }
  if (network) {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NPM_CONFIG_REGISTRY']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return Object.freeze({ env: Object.freeze(env), networkMarker });
}

function assertNoMeteredCredentials() {
  const present = Object.entries(process.env).filter(([key, value]) => value !== undefined && value.length > 0 && (METERED_CREDENTIAL.test(key) || EXPLICIT_METERED_CREDENTIALS.includes(key))).map(([key]) => key).sort();
  if (present.length > 0) fail(`metered-model credentials are present: ${present.join(',')}`);
  return Object.freeze([...new Set([...EXPLICIT_METERED_CREDENTIALS, ...Object.keys(process.env).filter((key) => METERED_CREDENTIAL.test(key))])].sort().map((key) => Object.freeze({ name: key, present: false })));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceRoot = checkedEvidenceRoot(args.evidenceDir);
  const reportPath = join(evidenceRoot, `${args.id}.json`);
  if (existsSync(reportPath)) fail(`evidence report already exists: ${reportPath}`);
  const credentialProof = assertNoMeteredCredentials();
  const runtimeRoot = join(evidenceRoot, `.runtime-${args.id}-${String(process.pid)}-${randomUUID()}`);
  mkdirSync(runtimeRoot, { mode: 0o700 });
  mkdirSync(join(runtimeRoot, 'home'), { mode: 0o700 });
  mkdirSync(join(runtimeRoot, 'tmp'), { mode: 0o700 });
  mkdirSync(join(runtimeRoot, 'npm-cache'), { mode: 0o700 });
  const candidateBefore = candidateSeal(join(runtimeRoot, 'home'));
  const stdoutPath = join(evidenceRoot, `${args.id}.stdout.log`);
  const stderrPath = join(evidenceRoot, `${args.id}.stderr.log`);
  const stdoutFd = openSync(stdoutPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const stderrFd = openSync(stderrPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  const stdoutCount = { value: 0 };
  const stderrCount = { value: 0 };
  const childAuthority = childEnvironment(runtimeRoot, args.id);
  const env = childAuthority.env;
  const startedAt = new Date().toISOString();
  const startedMonotonic = performance.now();
  let child;
  let spawnError = null;
  const kernelRusagePath = platform() === 'darwin' ? join(runtimeRoot, 'kernel-rusage.txt') : null;
  let exitCode = null;
  let exitSignal = null;
  let closeObserved = false;
  let breach = null;
  let peakRssBytes = 0;
  const observedProcessIdentities = new Map();
  let processIdentities = [];
  let psFailures = 0;
  let termination = Object.freeze({ term_sent: false, kill_sent: false });
  try {
    const executable = kernelRusagePath === null ? args.command[0] : '/usr/bin/time';
    const commandArgs = kernelRusagePath === null ? args.command.slice(1) : ['-l', '-o', kernelRusagePath, ...args.command];
    child = spawn(executable, commandArgs, { cwd: packageRoot, env, detached: platform() !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  }
  if (child !== undefined) {
    child.stdout.on('data', (chunk) => writeChunk(stdoutFd, stdoutHash, stdoutCount, chunk));
    child.stderr.on('data', (chunk) => writeChunk(stderrFd, stderrHash, stderrCount, chunk));
    child.once('error', (error) => { if (spawnError === null) spawnError = error.message; });
    const closed = new Promise((resolveClose) => child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; closeObserved = true; resolveClose(); }));
    const pid = child.pid;
    if (pid === undefined) breach = 'spawn-unconfirmed';
    while (!closeObserved && breach === null) {
      const elapsed = performance.now() - startedMonotonic;
      if (elapsed >= args.timeoutMs) breach = 'timeout';
      if (pid !== undefined) {
        const snapshot = processSnapshot(pid);
        if (snapshot === null) { psFailures += 1; breach = 'process-discovery-failed'; }
        else {
          if (snapshot.rssBytes > peakRssBytes) peakRssBytes = snapshot.rssBytes;
          for (const identity of snapshot.identities) observedProcessIdentities.set(identity.pid, identity);
          processIdentities = Object.freeze([...observedProcessIdentities.values()].sort((left, right) => left.pid - right.pid));
          if (snapshot.rssBytes > args.maxRssBytes) breach = 'rss-limit';
        }
      }
      if (breach === null) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (breach !== null && pid !== undefined && !closeObserved) {
      const termSent = platform() === 'win32' ? windowsTreeSignal(pid, false) : signalGroup(pid, 'SIGTERM');
      await Promise.race([closed, new Promise((resolveWait) => setTimeout(resolveWait, 1000))]);
      let killSent = false;
      if (!closeObserved) {
        killSent = platform() === 'win32' ? windowsTreeSignal(pid, true) : signalGroup(pid, 'SIGKILL');
        await Promise.race([closed, new Promise((resolveWait) => setTimeout(resolveWait, 2000))]);
      }
      termination = Object.freeze({ term_sent: termSent, kill_sent: killSent });
    }
    if (!closeObserved) {
      breach = breach ?? 'containment-failed';
      await Promise.race([closed, new Promise((resolveWait) => setTimeout(resolveWait, 1000))]);
    }
    if (breach === null && performance.now() - startedMonotonic >= args.timeoutMs) breach = 'timeout';
    if (pid !== undefined && platform() !== 'win32' && groupAlive(pid)) {
      signalGroup(pid, 'SIGKILL');
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      if (groupAlive(pid)) breach = 'descendant-survived';
    }
    if (platform() === 'win32') {
      const survivors = processIdentities.map((identity) => identity.pid).filter(pidAlive);
      for (const survivor of survivors) windowsTreeSignal(survivor, true);
      if (survivors.length > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      if (survivors.some(pidAlive)) breach = 'descendant-survived';
    }
  }
  let kernelMaxRssBytes = null;
  if (kernelRusagePath !== null && existsSync(kernelRusagePath)) {
    const match = /^\s*(\d+)\s+maximum resident set size\s*$/mu.exec(readFileSync(kernelRusagePath, 'utf8'));
    if (match === null) breach = breach ?? 'kernel-rusage-invalid';
    else {
      kernelMaxRssBytes = Number(match[1]);
      if (!Number.isSafeInteger(kernelMaxRssBytes) || kernelMaxRssBytes < 0) breach = breach ?? 'kernel-rusage-invalid';
      else {
        peakRssBytes = Math.max(peakRssBytes, kernelMaxRssBytes);
        if (kernelMaxRssBytes > args.maxRssBytes) breach = breach ?? 'rss-limit';
      }
    }
  }
  fsyncSync(stdoutFd);
  fsyncSync(stderrFd);
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const artifacts = args.artifacts.map(sha256File);
  if (existsSync(childAuthority.networkMarker)) breach = breach ?? 'network-access';
  const candidateAfter = candidateSeal(join(runtimeRoot, 'home'));
  if (candidateAfter.commit !== candidateBefore.commit || candidateAfter.tree !== candidateBefore.tree || candidateAfter.status_sha256 !== candidateBefore.status_sha256) breach = breach ?? 'candidate-mutated';
  let cleanupError = null;
  try { rmSync(runtimeRoot, { recursive: true, force: false }); }
  catch (error) { cleanupError = error instanceof Error ? error.message : String(error); }
  const endedAt = new Date().toISOString();
  const report = {
    schema_version: 'autopilot.certified_command.v1',
    id: args.id,
    argv: args.command,
    candidate: { ...candidateBefore, post_command_equal: candidateAfter.commit === candidateBefore.commit && candidateAfter.tree === candidateBefore.tree && candidateAfter.status_sha256 === candidateBefore.status_sha256 },
    environment: { allowlist: Object.keys(env).sort(), metered_credentials: credentialProof, network: NETWORK_LANES.has(args.id) ? 'registry-only' : 'forbidden' },
    platform: { node: process.version, os_type: osType(), os_release: release(), platform: platform(), arch: process.arch },
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: Math.ceil(performance.now() - startedMonotonic),
    timeout_ms: args.timeoutMs,
    max_rss_bytes: args.maxRssBytes,
    process_tree_peak_rss_bytes: peakRssBytes,
    kernel_descendant_max_rss_bytes: kernelMaxRssBytes,
    process_discovery: platform() === 'darwin' ? 'cumulative-10ms-plus-kernel-rusage' : 'cumulative-10ms',
    process_identities: processIdentities,
    process_snapshot_failures: psFailures,
    exit_code: exitCode,
    signal: exitSignal,
    spawn_error: spawnError,
    breach,
    close_observed: closeObserved,
    termination,
    cleanup_error: cleanupError,
    stdout: { path: basename(stdoutPath), byte_count: stdoutCount.value, sha256: `sha256:${stdoutHash.digest('hex')}` },
    stderr: { path: basename(stderrPath), byte_count: stderrCount.value, sha256: `sha256:${stderrHash.digest('hex')}` },
    declared_artifacts: artifacts,
    passed: spawnError === null && breach === null && cleanupError === null && closeObserved && exitCode === 0 && exitSignal === null,
  };
  const temporaryReport = join(evidenceRoot, `.${args.id}.${randomUUID()}.tmp`);
  const reportFd = openSync(temporaryReport, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const reportBytes = encoder.encode(`${JSON.stringify(report, null, 2)}${EOL}`);
  writeAll(reportFd, reportBytes);
  fsyncSync(reportFd);
  closeSync(reportFd);
  renameSync(temporaryReport, reportPath);
  const dirFd = openSync(evidenceRoot, constants.O_RDONLY);
  fsyncSync(dirFd);
  closeSync(dirFd);
  process.stdout.write(`${JSON.stringify({ id: args.id, report: reportPath, passed: report.passed })}\n`);
  if (!report.passed) process.exitCode = 1;
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
