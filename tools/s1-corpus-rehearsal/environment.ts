import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import type { Sha256Digest } from './contracts.ts';
import { compareCodeUnits } from './inventory.ts';

export interface CloneEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly proof_sha256: Sha256Digest;
}

const EXACT_ENVIRONMENT_KEYS = Object.freeze([
  'AUTOPILOT_COORDINATOR_AUTOSTART_DISABLED', 'AUTOPILOT_STATE_ROOT', 'CI', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT',
  'HOME', 'NODE_OPTIONS', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_OFFLINE', 'PATH', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'PYTHONNOUSERSITE',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
].sort(compareCodeUnits));

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function systemToolPath(): string {
  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

export function verifyCloneEnvironment(cloneRootPath: string, env: Readonly<Record<string, string>>): Sha256Digest {
  const cloneRoot = realpathSync(cloneRootPath);
  const keys = Object.keys(env).sort(compareCodeUnits);
  if (canonicalJson(keys) !== canonicalJson(EXACT_ENVIRONMENT_KEYS)) throw new Error('C5 environment differs from the closed clone-only key set');
  const pathKeys = ['AUTOPILOT_STATE_ROOT', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP', 'NPM_CONFIG_CACHE', 'GIT_CONFIG_GLOBAL'] as const;
  for (const key of pathKeys) {
    const value = env[key];
    if (value === undefined || !inside(cloneRoot, value)) throw new Error(`C5 environment ${key} escapes clone authority`);
  }
  if (env['PATH'] !== systemToolPath() || env['GIT_CONFIG_NOSYSTEM'] !== '1' || env['GIT_OPTIONAL_LOCKS'] !== '0' || env['GIT_TERMINAL_PROMPT'] !== '0' || env['NPM_CONFIG_OFFLINE'] !== 'true' || env['PI_OFFLINE'] !== '1' || env['PI_TELEMETRY'] !== '0' || env['PYTHONNOUSERSITE'] !== '1') throw new Error('C5 environment safety controls differ from the closed values');
  return `sha256:${createHash('sha256').update(canonicalJson(env)).digest('hex')}`;
}

export async function buildCloneEnvironment(input: {
  readonly clone_root: string;
  readonly state_root: string;
  readonly project_root: string;
  readonly home_root: string;
  readonly temp_root: string;
  readonly npm_cache_root: string;
}): Promise<CloneEnvironment> {
  const cloneRoot = realpathSync(input.clone_root);
  const cloneStat = lstatSync(cloneRoot);
  if (!cloneStat.isDirectory() || cloneStat.isSymbolicLink()) throw new Error('C5 environment clone root must be a physical directory');
  await chmod(cloneRoot, 0o700);
  const paths = [input.state_root, input.project_root, input.home_root, input.temp_root, input.npm_cache_root].map((path) => resolve(path));
  if (paths.some((path) => !inside(cloneRoot, path))) throw new Error('C5 environment path escapes clone root');
  for (const path of paths) await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const stateRoot = resolve(input.state_root);
    const tempRoot = resolve(input.temp_root);
    const preferredSockets = [join(stateRoot, 'coordinator', 'coordinator.sock'), join(stateRoot, 'coordinator', 'coordinator.protocol-1.3-schema-9.sock')];
    const fallbackSocket = join(tempRoot, `pi-autopilot-${'0'.repeat(32)}.sock`);
    if (preferredSockets.some((path) => Buffer.byteLength(path, 'utf8') > 100) && Buffer.byteLength(fallbackSocket, 'utf8') > 100) throw new Error('C5 clone path is too long for both preferred and fallback Unix coordinator sockets');
  }
  const gitConfig = join(resolve(input.home_root), 'gitconfig');
  if (!existsSync(gitConfig)) await writeFile(gitConfig, '[credential]\n\thelper =\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const env = Object.freeze({
    AUTOPILOT_COORDINATOR_AUTOSTART_DISABLED: '1',
    AUTOPILOT_STATE_ROOT: resolve(input.state_root),
    HOME: resolve(input.home_root),
    USERPROFILE: resolve(input.home_root),
    XDG_CONFIG_HOME: join(resolve(input.home_root), '.config'),
    XDG_CACHE_HOME: join(resolve(input.home_root), '.cache'),
    XDG_DATA_HOME: join(resolve(input.home_root), '.local', 'share'),
    TMPDIR: resolve(input.temp_root),
    TMP: resolve(input.temp_root),
    TEMP: resolve(input.temp_root),
    NPM_CONFIG_CACHE: resolve(input.npm_cache_root),
    NPM_CONFIG_OFFLINE: 'true',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PYTHONNOUSERSITE: '1',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    PATH: systemToolPath(),
    NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
  });
  return Object.freeze({ env, proof_sha256: verifyCloneEnvironment(cloneRoot, env) });
}
