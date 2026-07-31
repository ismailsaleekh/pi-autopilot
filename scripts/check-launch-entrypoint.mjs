#!/usr/bin/env node
// Current Rust-Core launch gate.
//
// This checker is intentionally tied to the package's production Host resolver:
// src/resolve-core-runtime.js is consumed by Host activation/transport, the npm
// autopilot-core wrapper, and this gate. There is no dist/, signer, PATH, cwd,
// target/, or source-tree fallback.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unavailableCapabilities } from '../src/background-tasks.ts';
import { validateCoreToHostFrame } from '../src/generated/frame-validation.ts';
import {
  AGENT_RUNNER_BIN_ENTRY,
  CHILD_ADDON_ENTRY,
  CORE_BIN_ENTRY,
  SUPPORTED_CORE_BINARIES,
  corePlatformKey,
  resolveAgentRunner,
  resolveCoreBinary,
  resolveCoreWrapper,
  resolveRunnerTransport,
} from '../src/resolve-core-runtime.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const STATUS_STDIO_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_STATUS_REQUEST_ID = 731;
const EXPECTED_PI_EXTENSIONS = Object.freeze(['./extensions/autopilot.ts']);
const EXPECTED_BIN = Object.freeze({
  'autopilot-agent-run': AGENT_RUNNER_BIN_ENTRY,
  'autopilot-core': CORE_BIN_ENTRY,
});

class LaunchEntrypointError extends Error {
  constructor(message) {
    super(`launch-entrypoint check failed: ${message}`);
    this.name = 'LaunchEntrypointError';
  }
}

export function certifyLaunchEntrypoint(options = {}) {
  const packageRoot = resolve(options.packageRoot ?? fileURLToPath(new URL('..', import.meta.url)));
  const packageJsonPath = resolve(options.packageJsonPath ?? join(packageRoot, 'package.json'));
  assertInside(packageRoot, packageJsonPath, 'package.json');
  const packageJson = readJsonFile(packageJsonPath, 'package.json');

  const metadata = validatePackageEntrypointMetadata(packageRoot, packageJson);
  const extensionStat = assertReadableRegularFile(metadata.extensionPath, 'package.json pi.extensions[0] Host entrypoint');

  const coreWrapper = resolveCoreWrapper({ packageJsonPath });
  const agentRunnerWrapper = resolveAgentRunner({ packageJsonPath });
  const runnerTransport = resolveRunnerTransport({ packageJsonPath });
  if (coreWrapper !== metadata.binPaths['autopilot-core']) {
    throw new LaunchEntrypointError(`production Core wrapper resolver diverged from package metadata: ${coreWrapper} !== ${metadata.binPaths['autopilot-core']}`);
  }
  if (agentRunnerWrapper !== metadata.binPaths['autopilot-agent-run']) {
    throw new LaunchEntrypointError(`production agent runner resolver diverged from package metadata: ${agentRunnerWrapper} !== ${metadata.binPaths['autopilot-agent-run']}`);
  }
  if (runnerTransport.runnerWrapper !== agentRunnerWrapper) {
    throw new LaunchEntrypointError(`runner transport wrapper diverged from agent resolver: ${runnerTransport.runnerWrapper} !== ${agentRunnerWrapper}`);
  }
  assertCliWrappersReuseCoreResolver(coreWrapper, agentRunnerWrapper);

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformKey = corePlatformKey({ platform, arch });
  const binary = resolveCoreBinary({ packageJsonPath, platform, arch });
  assertInside(packageRoot, binary, 'resolved autopilot-core binary');
  const binaryStat = assertExecutableRegularFile(binary, `autopilot-core binary for ${platformKey}`);
  const manifest = validateManifestForBinary({ packageRoot, platformKey, binary, binaryStat });

  const stateRoot = mkdtempSync(join(tmpdir(), 'pi-autopilot-launch-gate-state.'));
  let statusProbe;
  try {
    statusProbe = runStatusFrameLaunch({
      command: binary,
      cwd: packageRoot,
      env: statusProbeEnvironment(stateRoot),
      requestId: options.requestId ?? DEFAULT_STATUS_REQUEST_ID,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }

  return {
    schema_version: 'autopilot.launch_entrypoint_check.v2',
    passed: true,
    package_root: packageRoot,
    package_json: packageJsonPath,
    pi_extensions: [...EXPECTED_PI_EXTENSIONS],
    bin: { ...EXPECTED_BIN },
    extension_entrypoint: {
      path: metadata.extensionPath,
      size_bytes: extensionStat.size,
    },
    core_resolver: 'src/resolve-core-runtime.js',
    core_wrapper: coreWrapper,
    agent_runner_wrapper: agentRunnerWrapper,
    child_addon: { path: runnerTransport.childAddon, entry: CHILD_ADDON_ENTRY },
    platform_key: platformKey,
    supported_platforms: Object.keys(SUPPORTED_CORE_BINARIES).sort(),
    core_binary: {
      path: binary,
      relative_path: packageRelativePath(packageRoot, binary, 'resolved autopilot-core binary'),
      size_bytes: binaryStat.size,
      sha256: manifest.binary_sha256,
    },
    manifest,
    status_probe: statusProbe,
    host_consumers: ['src/resolve-core.ts', 'src/activation.ts', 'src/transport.ts'],
  };
}

export function runStatusFrameLaunch(options) {
  const requestId = options.requestId ?? DEFAULT_STATUS_REQUEST_ID;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const input = `${JSON.stringify(statusProbeFrame(requestId))}\n`;
  const result = spawnSync(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? STATUS_STDIO_LIMIT_BYTES,
    timeout: timeoutMs,
  });

  if (result.error !== undefined) {
    const code = result.error && typeof result.error === 'object' ? result.error.code : undefined;
    if (code === 'ETIMEDOUT') {
      throw new LaunchEntrypointError(`status-frame launch timed out after ${timeoutMs}ms: ${options.command}`);
    }
    if (code === 'ENOBUFS') {
      throw new LaunchEntrypointError(`status-frame launch exceeded ${options.maxBuffer ?? STATUS_STDIO_LIMIT_BYTES} stdio bytes: ${options.command}`);
    }
    throw new LaunchEntrypointError(`status-frame launch failed before exit: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new LaunchEntrypointError(`status-frame launch terminated by signal ${result.signal}: ${options.command}`);
  }
  if (result.status !== 0) {
    throw new LaunchEntrypointError(
      `status-frame launch exited nonzero status=${String(result.status)}: ${options.command}\nstdout:\n${bounded(result.stdout)}\nstderr:\n${bounded(result.stderr)}`,
    );
  }

  const stdout = result.stdout ?? '';
  const frameLine = singleStdoutFrameLine(stdout);
  let parsed;
  try {
    parsed = JSON.parse(frameLine);
  } catch (error) {
    throw new LaunchEntrypointError(`malformed status frame JSON: ${errorMessage(error)}; stdout=${bounded(stdout)}`);
  }
  let frame;
  try {
    frame = validateCoreToHostFrame(parsed);
  } catch (error) {
    throw new LaunchEntrypointError(`malformed status frame: ${errorMessage(error)}; stdout=${bounded(stdout)}`);
  }
  if (frame.kind !== 'done') {
    throw new LaunchEntrypointError(`expected one done status frame, got kind=${frame.kind}`);
  }
  if (frame.id !== requestId) {
    throw new LaunchEntrypointError(`status-frame id drift: expected ${requestId}, got ${frame.id}`);
  }

  return {
    request_id: requestId,
    status: frame.payload.status,
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(result.stderr ?? ''),
    timeout_ms: timeoutMs,
  };
}

export function statusProbeFrame(id = DEFAULT_STATUS_REQUEST_ID) {
  return {
    v: 1,
    id,
    kind: 'command',
    payload: {
      raw: 'autopilot-status',
      background_capabilities: unavailableCapabilities(),
    },
  };
}

function validatePackageEntrypointMetadata(packageRoot, packageJson) {
  if (!isRecord(packageJson)) throw new LaunchEntrypointError('package.json root must be an object');
  const bin = packageJson.bin;
  if (!isRecord(bin)) throw new LaunchEntrypointError('package.json bin must be an object');
  assertExactKeys(bin, Object.keys(EXPECTED_BIN).sort(), 'package.json bin');
  const binPaths = {};
  for (const [command, expectedEntry] of Object.entries(EXPECTED_BIN)) {
    const entry = bin[command];
    const resolved = resolveDeclaredPackagePath(packageRoot, entry, `package.json bin.${command}`);
    if (entry !== expectedEntry) {
      throw new LaunchEntrypointError(`package.json bin.${command} must be exactly ${expectedEntry}, got ${String(entry)}`);
    }
    const stat = assertReadableRegularFile(resolved, `package.json bin.${command} wrapper`);
    if (stat.size === 0) throw new LaunchEntrypointError(`package.json bin.${command} wrapper is zero-length: ${resolved}`);
    binPaths[command] = resolved;
  }

  const extensions = packageJson.pi?.extensions;
  if (!Array.isArray(extensions)) throw new LaunchEntrypointError('package.json pi.extensions must be an array');
  if (JSON.stringify(extensions) !== JSON.stringify(EXPECTED_PI_EXTENSIONS)) {
    throw new LaunchEntrypointError(`package.json pi.extensions must be exactly ${JSON.stringify(EXPECTED_PI_EXTENSIONS)}, got ${JSON.stringify(extensions)}`);
  }
  const extensionPath = resolveDeclaredPackagePath(packageRoot, extensions[0], 'package.json pi.extensions[0]');
  return { binPaths, extensionPath };
}

function assertCliWrappersReuseCoreResolver(coreWrapper, agentRunnerWrapper) {
  const coreText = readFileSync(coreWrapper, 'utf8');
  if (!coreText.includes("../src/resolve-core-runtime.js") || !/\bresolveCoreBinary\b/u.test(coreText)) {
    throw new LaunchEntrypointError('bin/autopilot-core.mjs must import and call src/resolve-core-runtime.js resolveCoreBinary');
  }
  if (/\bconst\s+supported\s*=|darwin-arm64|linux-x64|win32-x64/u.test(coreText)) {
    throw new LaunchEntrypointError('bin/autopilot-core.mjs must not carry a duplicate platform dispatch map');
  }

  const agentText = readFileSync(agentRunnerWrapper, 'utf8');
  if (!agentText.includes("../src/resolve-core-runtime.js") || !/\bresolveCoreWrapper\b/u.test(agentText)) {
    throw new LaunchEntrypointError('bin/autopilot-agent-run.mjs must resolve the sibling core wrapper through src/resolve-core-runtime.js');
  }
  if (/target\s*[,)]|target\/release|devCore|optionalExecutable|process\.env\.PATH|\bPATH\b/u.test(agentText)) {
    throw new LaunchEntrypointError('bin/autopilot-agent-run.mjs must not contain PATH/cwd/target/source-tree fallback logic');
  }
}

function validateManifestForBinary({ packageRoot, platformKey, binary, binaryStat }) {
  const manifestPath = join(packageRoot, 'binaries', 'MANIFEST.json');
  assertReadableRegularFile(manifestPath, 'binaries/MANIFEST.json');
  const manifest = readJsonFile(manifestPath, 'binaries/MANIFEST.json');
  if (!isRecord(manifest)) throw new LaunchEntrypointError('binaries/MANIFEST.json root must be an object');
  if (manifest.schema !== 1) throw new LaunchEntrypointError(`binaries/MANIFEST.json schema must be 1, got ${String(manifest.schema)}`);
  const source = manifest.source;
  if (!isRecord(source) || typeof source.hash !== 'string' || source.hash.length === 0) {
    throw new LaunchEntrypointError('binaries/MANIFEST.json source.hash must be a non-empty string');
  }
  const binaries = manifest.binaries;
  if (!isRecord(binaries)) throw new LaunchEntrypointError('binaries/MANIFEST.json binaries must be an object');
  const entry = binaries[platformKey];
  if (!isRecord(entry)) throw new LaunchEntrypointError(`binaries/MANIFEST.json missing binaries.${platformKey} entry`);

  const binaryRel = packageRelativePath(packageRoot, binary, `autopilot-core binary for ${platformKey}`);
  const binaryBytes = readFileSync(binary);
  const binarySha256 = sha256Hex(binaryBytes);
  if (entry.path !== binaryRel) {
    throw new LaunchEntrypointError(`manifest path mismatch for ${platformKey}: recorded ${String(entry.path)}, current ${binaryRel}`);
  }
  if (entry.sha256 !== binarySha256) {
    throw new LaunchEntrypointError(`manifest sha256 mismatch for ${platformKey}: recorded ${String(entry.sha256)}, current ${binarySha256}`);
  }
  if (entry.sizeBytes !== binaryStat.size) {
    throw new LaunchEntrypointError(`manifest sizeBytes mismatch for ${platformKey}: recorded ${String(entry.sizeBytes)}, current ${binaryStat.size}`);
  }
  if (entry.sourceHash !== source.hash) {
    throw new LaunchEntrypointError(`manifest sourceHash mismatch for ${platformKey}: recorded ${String(entry.sourceHash)}, manifest source.hash ${source.hash}`);
  }

  return {
    path: manifestPath,
    platform_entry: platformKey,
    binary_path: entry.path,
    binary_sha256: binarySha256,
    binary_size_bytes: binaryStat.size,
    source_hash: source.hash,
  };
}

function statusProbeEnvironment(stateRoot) {
  const env = { ...process.env };
  for (const name of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
  ]) {
    delete env[name];
  }
  env.AUTOPILOT_STATE_ROOT = stateRoot;
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  env.CI = env.CI ?? '1';
  return env;
}

function resolveDeclaredPackagePath(packageRoot, entry, label) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new LaunchEntrypointError(`${label} must be a non-empty package-relative string`);
  }
  if (entry.includes('\0')) throw new LaunchEntrypointError(`${label} contains a NUL byte`);
  if (isAbsolute(entry)) throw new LaunchEntrypointError(`${label} must be package-relative, got ${entry}`);
  const resolved = resolve(packageRoot, entry);
  assertInside(packageRoot, resolved, label);
  return resolved;
}

function assertInside(packageRoot, candidate, label) {
  const rel = relative(packageRoot, candidate);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
  throw new LaunchEntrypointError(`${label} escapes package root: ${candidate}`);
}

function packageRelativePath(packageRoot, candidate, label) {
  assertInside(packageRoot, candidate, label);
  return relative(packageRoot, candidate).replaceAll('\\', '/');
}

function assertReadableRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new LaunchEntrypointError(`${label} is missing: ${path}: ${errorMessage(error)}`);
  }
  if (stat.isSymbolicLink()) throw new LaunchEntrypointError(`${label} must not be a symlink: ${path}`);
  if (!stat.isFile()) throw new LaunchEntrypointError(`${label} must be a regular file: ${path}`);
  try {
    accessSync(path, constants.R_OK);
  } catch (error) {
    throw new LaunchEntrypointError(`${label} is not readable: ${path}: ${errorMessage(error)}`);
  }
  return stat;
}

function assertExecutableRegularFile(path, label) {
  const stat = assertReadableRegularFile(path, label);
  try {
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new LaunchEntrypointError(`${label} is not executable: ${path}: ${errorMessage(error)}`);
  }
  return stat;
}

function singleStdoutFrameLine(stdout) {
  if (!stdout.endsWith('\n')) {
    throw new LaunchEntrypointError(`expected exactly one LF-terminated status frame on stdout, but stdout was not LF-terminated: ${bounded(stdout)}`);
  }
  const lines = stdout.slice(0, -1).split('\n');
  if (lines.length !== 1 || lines[0].length === 0) {
    throw new LaunchEntrypointError(`expected exactly one LF-terminated status frame on stdout, got ${lines.length} frame line(s): ${bounded(stdout)}`);
  }
  return lines[0];
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LaunchEntrypointError(`${label} is not readable JSON at ${path}: ${errorMessage(error)}`);
  }
}

function assertExactKeys(record, expectedKeys, label) {
  const actual = Object.keys(record).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedKeys)) {
    throw new LaunchEntrypointError(`${label} keys must be exactly ${expectedKeys.join(',')}, got ${actual.join(',')}`);
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value, limit = 4096) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…<truncated ${text.length - limit} chars>`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  process.stderr.write('usage: node scripts/check-launch-entrypoint.mjs [--json]\n');
}

function main(argv = process.argv.slice(2)) {
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      return;
    } else {
      usage();
      throw new LaunchEntrypointError(`unknown argument: ${arg}`);
    }
  }
  const report = certifyLaunchEntrypoint();
  // npm forwards prepack stdout into `npm pack --json` stdout. Default success
  // MUST remain silent so npm's JSON document stays parseable.
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
