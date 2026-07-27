#!/usr/bin/env node
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));

function fail(message) {
  throw new Error(`packed-consumer-invalid: ${message}`);
}

function under(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function run(command, args, cwd, env, timeout) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout });
  if (result.error) fail(`${command} ${args.join(' ')} failed before exit: ${result.error.message}`);
  if (result.status !== 0 || result.signal !== null) fail(`${command} ${args.join(' ')} failed status=${result.status} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout;
}

function jsonRun(command, args, cwd, env, timeout) {
  const out = run(command, args, cwd, env, timeout);
  try { return JSON.parse(out); } catch (error) { fail(`${command} ${args.join(' ')} returned non-JSON output: ${error.message}\n${out}`); }
}

function assertFile(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not one regular file: ${path}`);
}

function assertExecutable(path, label) {
  assertFile(path, label);
  try { accessSync(path, constants.X_OK); } catch (error) { fail(`${label} is not executable at ${path}: ${error.message}`); }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0) fail(`this gate accepts no arguments, got ${args.join(' ')}`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-autopilot-packed-consumer.')));
  chmodSync(root, 0o700);
  if (under(PACKAGE_ROOT, root) || under(root, PACKAGE_ROOT)) fail('witness root must be outside the source checkout');
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, '.npmrc'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    CI: '1',
  };
  mkdirSync(env.HOME, { mode: 0o700 });
  mkdirSync(env.npm_config_cache, { mode: 0o700 });
  try {
    const pack = jsonRun('npm', ['pack', '--json', '--pack-destination', root], PACKAGE_ROOT, env, 900_000);
    if (!Array.isArray(pack) || pack.length !== 1 || typeof pack[0]?.filename !== 'string') fail('npm pack did not report exactly one tarball filename');
    const tarball = realpathSync(join(root, pack[0].filename));
    assertFile(tarball, 'packed tarball');
    if (!under(root, tarball)) fail(`tarball escaped witness root: ${tarball}`);

    const consumer = join(root, 'consumer');
    mkdirSync(consumer, { mode: 0o700 });
    run('npm', ['init', '-y'], consumer, env, 120_000);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', tarball], consumer, env, 300_000);

    const installed = realpathSync(join(consumer, 'node_modules', 'pi-autopilot'));
    if (!under(consumer, installed)) fail(`installed package is outside the consumer tree: ${installed}`);
    const packageJsonPath = join(installed, 'package.json');
    const metadata = JSON.parse(run(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(packageJsonPath)}).bin['autopilot-core']))`], consumer, env, 60_000));
    if (typeof metadata !== 'string' || metadata.length === 0) fail('installed package.json bin.autopilot-core is absent');
    const binPath = resolve(installed, metadata);
    assertExecutable(binPath, 'installed bin.autopilot-core target');

    const hostEntry = join(installed, 'host', 'src', 'extension.ts');
    assertFile(hostEntry, 'Host extension entry point');
    const loaderPath = join(root, 'strip-installed-types-loader.mjs');
    writeFileSync(loaderPath, `
      import { readFile } from 'node:fs/promises';
      import { stripTypeScriptTypes } from 'node:module';
      export async function load(url, context, nextLoad) {
        if (url.endsWith('.ts')) {
          const source = await readFile(new URL(url), 'utf8');
          return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(source, { mode: 'transform' }) };
        }
        return nextLoad(url, context);
      }
    `, 'utf8');
    const loadScript = `
      import { pathToFileURL } from 'node:url';
      const mod = await import(pathToFileURL(${JSON.stringify(hostEntry)}).href);
      if (typeof mod.default !== 'function') throw new Error('default export is not a function');
      const resolver = await import(pathToFileURL(${JSON.stringify(join(installed, 'host', 'src', 'resolve-core.ts'))}).href);
      const actual = resolver.resolveCoreBinary({ packageJsonPath: ${JSON.stringify(packageJsonPath)} });
      if (actual !== ${JSON.stringify(binPath)}) throw new Error('core resolver returned ' + actual);
      console.log(JSON.stringify({ host_entry_loaded: true, resolved_core: actual }));
    `;
    const loadResult = JSON.parse(run(process.execPath, ['--experimental-loader', loaderPath, '--input-type=module', '--eval', loadScript], consumer, env, 120_000));
    const report = {
      schema: 'autopilot.packed_consumer_check.v1',
      passed: true,
      installed_package: relative(root, installed),
      host_entry: relative(installed, hostEntry),
      bin_entry: metadata,
      resolved_core: relative(installed, loadResult.resolved_core),
      does_not_prove: 'This offline witness does not drive Pi headlessly or prove extension registration inside a live Pi process; it proves the installed package layout exposes the Host entry and package.json bin path a loader would use.',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: false });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
