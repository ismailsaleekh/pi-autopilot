#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));
function fail(message) { throw new Error(`packed-consumer-release-invalid: ${message}`); }
function under(parent, candidate) { const rel = relative(parent, candidate); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
function run(command, args, cwd, env, timeout) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) fail(`${command} ${args.join(' ')} failed status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? '<none>'}\n${result.stderr}`);
  return result.stdout;
}

function main() {
  if (process.argv.length !== 2) fail('this release gate accepts no arguments');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-autopilot-packed-release-')));
  chmodSync(root, 0o700);
  if (under(sourceRoot, root) || under(root, sourceRoot)) fail('release witness root must be outside the source clone');
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  mkdirSync(join(root, 'npm-cache'), { mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: root, TMP: root, TEMP: root,
    npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, '.npmrc'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', CI: '1',
  };
  try {
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], sourceRoot, env, 900_000));
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0] !== 'object' || packed[0] === null || typeof packed[0].filename !== 'string') fail('npm pack did not return exactly one filename');
    const tarball = realpathSync(join(root, packed[0].filename));
    const info = lstatSync(tarball);
    if (!info.isFile() || info.isSymbolicLink() || !under(root, tarball)) fail('npm pack result is not one regular owned tarball');
    const witness = run(process.execPath, [join(sourceRoot, 'scripts', 'verify-packed-consumer.mjs'), tarball], sourceRoot, env, 1_800_000);
    const parsed = JSON.parse(witness);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || parsed.passed !== true) fail('packed consumer witness did not return passed=true');
    process.stdout.write(witness);
  } finally {
    rmSync(root, { recursive: true, force: false });
  }
}

try { main(); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; }
