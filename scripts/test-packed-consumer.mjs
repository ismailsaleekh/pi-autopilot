#!/usr/bin/env node
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));
const GLOBAL_PI_ROOT = realpathSync('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent');
const GLOBAL_TYPEBOX_ROOT = realpathSync(join(GLOBAL_PI_ROOT, 'node_modules', 'typebox'));

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
  let info;
  try { info = lstatSync(path); } catch (error) { fail(`${label} is missing at ${path}: ${error.message}`); }
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not one regular file: ${path}`);
}

function assertExecutable(path, label) {
  assertFile(path, label);
  try { accessSync(path, constants.X_OK); } catch (error) { fail(`${label} is not executable at ${path}: ${error.message}`); }
}

function packageRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is absent`);
  const resolved = resolve('/package', value);
  const rel = relative('/package', resolved);
  if (value.startsWith('/') || rel === '..' || rel.startsWith(`..${sep}`)) fail(`${label} must be package-relative, got ${value}`);
  return rel;
}

function readPackageJson(packageJsonPath, label) {
  try { return JSON.parse(readFileSync(packageJsonPath, 'utf8')); } catch (error) { fail(`${label} is not readable JSON at ${packageJsonPath}: ${error.message}`); }
}

function resolveHostEntry(installed, packageJsonPath) {
  const pkg = readPackageJson(packageJsonPath, 'installed package.json');
  if (!Array.isArray(pkg.pi?.extensions) || pkg.pi.extensions.length !== 1) fail('installed package.json pi.extensions must declare exactly one Host entry point');
  const rel = packageRelativePath(pkg.pi.extensions[0], 'installed package.json pi.extensions[0] Host entry point');
  return { path: resolve(installed, rel), rel };
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
    const pack = jsonRun('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], PACKAGE_ROOT, env, 900_000);
    if (!Array.isArray(pack) || pack.length !== 1 || typeof pack[0]?.filename !== 'string') fail('npm pack did not report exactly one tarball filename');
    const tarball = realpathSync(join(root, pack[0].filename));
    assertFile(tarball, 'packed tarball');
    if (!under(root, tarball)) fail(`tarball escaped witness root: ${tarball}`);

    const consumer = join(root, 'consumer');
    mkdirSync(consumer, { mode: 0o700 });
    run('npm', ['init', '-y'], consumer, env, 120_000);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', tarball], consumer, env, 300_000);
    const publicPi = readPackageJson(join(GLOBAL_PI_ROOT, 'package.json'), 'global Pi public alias package.json');
    const publicTypebox = readPackageJson(join(GLOBAL_TYPEBOX_ROOT, 'package.json'), 'global TypeBox public alias package.json');
    if (publicPi.name !== '@earendil-works/pi-coding-agent' || publicPi.version !== '0.83.0') fail(`global Pi public alias must be 0.83.0, got ${publicPi.name}@${publicPi.version}`);
    if (publicTypebox.name !== 'typebox' || publicTypebox.version !== '1.3.7') fail(`global TypeBox public alias must be 1.3.7, got ${publicTypebox.name}@${publicTypebox.version}`);
    mkdirSync(join(consumer, 'node_modules', '@earendil-works'), { recursive: true });
    symlinkSync(GLOBAL_PI_ROOT, join(consumer, 'node_modules', '@earendil-works', 'pi-coding-agent'), 'dir');
    symlinkSync(GLOBAL_TYPEBOX_ROOT, join(consumer, 'node_modules', 'typebox'), 'dir');

    const installed = realpathSync(join(consumer, 'node_modules', 'pi-autopilot'));
    if (!under(consumer, installed)) fail(`installed package is outside the consumer tree: ${installed}`);
    for (const rel of [join('node_modules', 'typebox'), join('node_modules', '@earendil-works', 'pi-coding-agent')]) {
      if (lstatSync(join(installed, rel), { throwIfNoEntry: false })) fail(`packed runtime contains private peer copy: ${rel}`);
    }
    const packageJsonPath = join(installed, 'package.json');
    const metadata = JSON.parse(run(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(packageJsonPath)}).bin['autopilot-core']))`], consumer, env, 60_000));
    if (typeof metadata !== 'string' || metadata.length === 0) fail('installed package.json bin.autopilot-core is absent');
    const binPath = resolve(installed, metadata);
    assertExecutable(binPath, 'installed bin.autopilot-core target');

    const hostEntry = resolveHostEntry(installed, packageJsonPath);
    assertFile(hostEntry.path, `Host extension entry point declared by package.json pi.extensions[0] (${hostEntry.rel})`);
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
      import { dirname, join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const hostEntry = ${JSON.stringify(hostEntry.path)};
      const mod = await import(pathToFileURL(hostEntry).href);
      if (typeof mod.default !== 'function') throw new Error('default export is not a function');
      const resolver = await import(pathToFileURL(join(dirname(hostEntry), '..', 'src', 'resolve-core.ts')).href);
      const platformKey = resolver.corePlatformKey();
      const expected = join(dirname(hostEntry), '..', 'binaries', platformKey, resolver.SUPPORTED_CORE_BINARIES[platformKey]);
      const actual = resolver.resolveCoreBinary({ packageJsonPath: ${JSON.stringify(packageJsonPath)} });
      if (actual !== expected) throw new Error('core resolver returned ' + actual + ', expected ' + expected);
      console.log(JSON.stringify({ host_entry_loaded: true, resolved_core: actual }));
    `;
    const loadResult = JSON.parse(run(process.execPath, ['--experimental-loader', loaderPath, '--input-type=module', '--eval', loadScript], consumer, env, 120_000));
    const report = {
      schema: 'autopilot.packed_consumer_check.v1',
      passed: true,
      installed_package: relative(root, installed),
      host_entry: relative(installed, hostEntry.path),
      bin_entry: metadata,
      resolved_core: relative(installed, loadResult.resolved_core),
      pi_peer: `${publicPi.name}@${publicPi.version}`,
      typebox_peer: `${publicTypebox.name}@${publicTypebox.version}`,
      runtime_private_peer_copies: 0,
      does_not_prove: 'This offline witness does not drive Pi headlessly; it proves the installed package layout loads through Pi 0.83 public peer aliases and exposes the Host entry and package.json bin path a loader would use.',
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
