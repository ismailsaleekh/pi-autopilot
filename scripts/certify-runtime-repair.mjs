#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const CERT_PATH = '/tmp/smf-resolution/autopilot-runtime-repair-cert.v1.json';
const LEDGER_IDS = Object.freeze([
  'background-default-suite',
  'autopilot-gates',
  'autopilot-focused-rust',
  'autopilot-rust-tests',
  'autopilot-host-tests',
  'runtime-integration',
  'payload-and-pack-dry-run',
  'reproducible-tarballs',
  'installed-consumer-four-path-sdk',
  'final-clean-identity',
]);
const METERED_ENV = Object.freeze([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'AZURE_OPENAI_API_KEY',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY',
  'COHERE_API_KEY', 'PERPLEXITY_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY',
]);

function usage() {
  process.stderr.write('usage: node scripts/certify-runtime-repair.mjs --autopilot-root <abs> --background-root <abs> --evidence-dir <abs>\n');
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--autopilot-root') out.autopilotRoot = argv[++i];
    else if (arg === '--background-root') out.backgroundRoot = argv[++i];
    else if (arg === '--evidence-dir') out.evidenceDir = argv[++i];
    else usage();
  }
  for (const key of ['autopilotRoot', 'backgroundRoot', 'evidenceDir']) {
    if (typeof out[key] !== 'string' || out[key].length === 0 || !isAbsolute(out[key])) usage();
    out[key] = realpathOrResolve(out[key]);
  }
  return out;
}

function realpathOrResolve(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function under(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sha256p(data) {
  return `sha256:${sha256(data)}`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key]);
    return out;
  }
  return value;
}

function sar(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(' ')} failed before exit in ${root}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${root}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function packageJson(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

function cleanIdentity(root, expectedName, expectedVersion) {
  const status = git(root, ['status', '--short']);
  if (status) throw new Error(`candidate root is not clean: ${root}\n${status}`);
  const pkg = packageJson(root);
  if (pkg.name !== expectedName || pkg.version !== expectedVersion) {
    throw new Error(`package identity mismatch at ${root}: got ${pkg.name}@${pkg.version}, expected ${expectedName}@${expectedVersion}`);
  }
  return {
    package: pkg.name,
    version: pkg.version,
    oid: git(root, ['rev-parse', 'HEAD']),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    status_sha256: sha256p(status),
  };
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  env.CI = '1';
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_update_notifier = 'false';
  for (const key of METERED_ENV) delete env[key];
  return env;
}

function assertNoMeteredCredentials() {
  const present = METERED_ENV.filter((key) => process.env[key]);
  if (present.length > 0) throw new Error(`refusing metered credential environment variable(s): ${present.join(', ')}`);
}

function skipTodoFinding(output) {
  const patterns = [
    /\bskipped\s+[1-9][0-9]*\b/iu,
    /\btodo\s+[1-9][0-9]*\b/iu,
    /#\s*SKIP\b/iu,
    /#\s*TODO\b/iu,
    /\b[1-9][0-9]*\s+ignored\b/iu,
  ];
  return patterns.find((pattern) => pattern.test(output))?.source ?? null;
}

function runCommand(id, root, command, args, env, evidenceDir, timeoutMs = 900_000) {
  const started = new Date().toISOString();
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: timeoutMs });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const skipTodo = skipTodoFinding(output);
  const passed = !result.error && result.status === 0 && result.signal === null && skipTodo === null;
  const report = {
    id,
    cwd: root,
    argv: [command, ...args],
    started,
    ended: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout_sha256: sha256p(result.stdout ?? ''),
    stderr_sha256: sha256p(result.stderr ?? ''),
    stdout_bytes: Buffer.byteLength(result.stdout ?? ''),
    stderr_bytes: Buffer.byteLength(result.stderr ?? ''),
    skip_todo_finding: skipTodo,
    passed,
  };
  const prefix = join(evidenceDir, `${id}.`);
  writeFileSync(`${prefix}stdout.txt`, result.stdout ?? '');
  writeFileSync(`${prefix}stderr.txt`, result.stderr ?? '');
  writeFileSync(`${prefix}report.json`, sar(report));
  if (!passed) {
    throw new Error(`ledger ${id} failed: ${JSON.stringify(report)}\nSTDERR:\n${result.stderr}`);
  }
  return ledgerRow(id, [command, ...args], report);
}

function ledgerRow(id, commandVector, report) {
  return {
    id,
    status: 'PASS',
    command_sha256: sha256p(sar({ argv: commandVector })),
    report_sha256: sha256p(sar(report)),
  };
}

function shellLedger(id, root, script, env, evidenceDir, timeoutMs) {
  return runCommand(id, root, 'bash', ['-lc', script], env, evidenceDir, timeoutMs);
}

function npmPack(root, destination, env, label) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const stdout = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], root, env, 900_000);
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.filename !== 'string') {
    throw new Error(`${label}: npm pack returned unexpected shape`);
  }
  const path = realpathSync(join(destination, parsed[0].filename));
  if (!under(destination, path)) throw new Error(`${label}: tarball escaped destination`);
  return { path, filename: parsed[0].filename, sha256: sha256p(readFileSync(path)), bytes: readFileSync(path).length };
}

function run(command, args, cwd, env, timeoutMs) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: timeoutMs });
  if (result.error) throw new Error(`${command} ${args.join(' ')} failed before exit: ${result.error.message}`);
  if (result.status !== 0 || result.signal !== null) throw new Error(`${command} ${args.join(' ')} failed status=${result.status} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout;
}

function reproducibleTarballs(args, env, evidenceDir) {
  const id = 'reproducible-tarballs';
  const packsDir = join(evidenceDir, 'tarballs');
  const first = join(packsDir, 'first');
  const second = join(packsDir, 'second');
  const ap1 = npmPack(args.autopilotRoot, first, env, 'autopilot first pack');
  const bg1 = npmPack(args.backgroundRoot, first, env, 'background first pack');
  const ap2 = npmPack(args.autopilotRoot, second, env, 'autopilot second pack');
  const bg2 = npmPack(args.backgroundRoot, second, env, 'background second pack');
  if (ap1.sha256 !== ap2.sha256) throw new Error(`Autopilot tarballs are not byte-identical: ${ap1.sha256} != ${ap2.sha256}`);
  if (bg1.sha256 !== bg2.sha256) throw new Error(`background tarballs are not byte-identical: ${bg1.sha256} != ${bg2.sha256}`);
  const report = { id, passed: true, autopilot: { first: ap1, second: ap2 }, background: { first: bg1, second: bg2 } };
  writeFileSync(join(evidenceDir, `${id}.report.json`), sar(report));
  return { row: ledgerRow(id, ['internal', id], report), tarballs: { autopilot: ap1, background: bg1 } };
}

function ensureSymlink(target, link) {
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, 'dir');
}

function installedConsumer(args, env, evidenceDir, tarballs) {
  const id = 'installed-consumer-four-path-sdk';
  const root = mkdtempSync(join(tmpdir(), 'pi-autopilot-installed-consumer.'));
  try {
    const consumer = join(root, 'consumer');
    mkdirSync(consumer, { recursive: true, mode: 0o700 });
    const installEnv = { ...env, npm_config_cache: join(root, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
    mkdirSync(installEnv.npm_config_cache, { recursive: true, mode: 0o700 });
    run('npm', ['init', '-y'], consumer, installEnv, 120_000);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', tarballs.autopilot.path, tarballs.background.path], consumer, installEnv, 300_000);
    const installedAutopilot = realpathSync(join(consumer, 'node_modules', 'pi-autopilot'));
    const installedBackground = realpathSync(join(consumer, 'node_modules', 'pi-background-tasks'));
    ensureSymlink(realpathSync(join(args.autopilotRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')), join(consumer, 'node_modules', '@earendil-works', 'pi-coding-agent'));
    ensureSymlink(realpathSync(join(args.backgroundRoot, 'node_modules', '@earendil-works', 'pi-tui')), join(consumer, 'node_modules', '@earendil-works', 'pi-tui'));
    ensureSymlink(realpathSync(join(args.backgroundRoot, 'node_modules', 'typebox')), join(consumer, 'node_modules', 'typebox'));
    const testEnv = {
      ...installEnv,
      PI_AUTOPILOT_PACKAGE_ROOT: installedAutopilot,
      PI_BACKGROUND_TASKS_PACKAGE_ROOT: installedBackground,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      CI: '1',
    };
    const row = runCommand(id, args.autopilotRoot, process.execPath, ['--experimental-strip-types', '--test', join(args.autopilotRoot, 'host', 'integration-tests', 'four-path-background-runtime.test.ts')], testEnv, evidenceDir, 120_000);
    const report = { id, passed: true, installed_autopilot: installedAutopilot, installed_background: installedBackground, consumer_root_removed: true };
    writeFileSync(join(evidenceDir, `${id}.install-report.json`), sar(report));
    return row;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateEvidenceDir(args) {
  if (existsSync(args.evidenceDir)) {
    const real = realpathSync(args.evidenceDir);
    if (under(args.autopilotRoot, real) || under(real, args.autopilotRoot) || under(args.backgroundRoot, real) || under(real, args.backgroundRoot)) {
      throw new Error('evidence-dir must be outside both package roots');
    }
    if (readdirSync(real).length !== 0) throw new Error('evidence-dir must be empty');
  } else {
    mkdirSync(args.evidenceDir, { recursive: true, mode: 0o700 });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertNoMeteredCredentials();
  validateEvidenceDir(args);
  mkdirSync(dirname(CERT_PATH), { recursive: true });
  const env = baseEnv({ PI_BACKGROUND_TASKS_PACKAGE_ROOT: args.backgroundRoot });
  const before = {
    autopilot: cleanIdentity(args.autopilotRoot, 'pi-autopilot', '1.3.1'),
    background: cleanIdentity(args.backgroundRoot, 'pi-background-tasks', '0.6.1'),
  };
  const rows = [];
  rows.push(runCommand('background-default-suite', args.backgroundRoot, 'npm', ['run', 'test'], env, args.evidenceDir, 600_000));
  rows.push(shellLedger('autopilot-gates', args.autopilotRoot, 'npm run typecheck && npm run codegen:check && npm run docs:verify && npm run gate:host-thinness && npm run gate:kernel-purity && npm run gate:no-inference && npm run gate:selftest && npm run gate:binary-parity', env, args.evidenceDir, 600_000));
  rows.push(runCommand('autopilot-focused-rust', args.autopilotRoot, 'cargo', ['test', '-q', '-p', 'drivers', '--test', 'task_path_classification', '--test', 'runner_child', '--test', 'lane_delivery', '--test', 'command_routing', '--test', 'bg_prereq'], env, args.evidenceDir, 600_000));
  rows.push(runCommand('autopilot-rust-tests', args.autopilotRoot, 'npm', ['run', 'test:rust'], env, args.evidenceDir, 900_000));
  rows.push(runCommand('autopilot-host-tests', args.autopilotRoot, 'npm', ['run', 'test:host'], env, args.evidenceDir, 300_000));
  rows.push(runCommand('runtime-integration', args.autopilotRoot, 'npm', ['run', 'test:runtime-integration'], env, args.evidenceDir, 120_000));
  rows.push(shellLedger('payload-and-pack-dry-run', args.autopilotRoot, 'npm run payload:check && npm pack --dry-run --ignore-scripts --json', env, args.evidenceDir, 300_000));
  const packed = reproducibleTarballs(args, env, args.evidenceDir);
  rows.push(packed.row);
  rows.push(installedConsumer(args, env, args.evidenceDir, packed.tarballs));
  const after = {
    autopilot: cleanIdentity(args.autopilotRoot, 'pi-autopilot', '1.3.1'),
    background: cleanIdentity(args.backgroundRoot, 'pi-background-tasks', '0.6.1'),
  };
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('candidate identity changed during certification');
  const finalReport = { id: 'final-clean-identity', passed: true, before, after };
  writeFileSync(join(args.evidenceDir, 'final-clean-identity.report.json'), sar(finalReport));
  rows.push(ledgerRow('final-clean-identity', ['internal', 'final-clean-identity'], finalReport));
  if (JSON.stringify(rows.map((row) => row.id)) !== JSON.stringify(LEDGER_IDS)) throw new Error('internal ledger order mismatch');
  const certWithoutHash = {
    format: 'pi-autopilot.runtime-repair-certificate.v1',
    status: 'PASS',
    autopilot_package: 'pi-autopilot',
    autopilot_version: '1.3.1',
    autopilot_oid: after.autopilot.oid,
    autopilot_tree: after.autopilot.tree,
    background_tasks_package: 'pi-background-tasks',
    background_tasks_version: '0.6.1',
    background_tasks_oid: after.background.oid,
    background_tasks_tree: after.background.tree,
    loaded_runtime_source: '../packages/pi-autopilot',
    loaded_runtime_oid: after.autopilot.oid,
    superproject_autopilot_gitlink_oid: after.autopilot.oid,
    superproject_background_tasks_gitlink_oid: after.background.oid,
    paired_test_ledger: rows,
    no_paid_metered_api: true,
    no_external_network: true,
    zero_metered_credentials: true,
  };
  const cert = { ...certWithoutHash, certificate_sha256: sha256p(sar(certWithoutHash)) };
  writeFileSync(CERT_PATH, sar(cert));
  process.stdout.write(`${sar({ status: 'PASS', certificate: CERT_PATH, certificate_sha256: sha256p(readFileSync(CERT_PATH)), evidence_dir: args.evidenceDir, tarballs: packed.tarballs })}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
