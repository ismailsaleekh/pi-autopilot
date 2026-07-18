import { spawn, type ChildProcessDataChunk } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { gitWorktreeRegistrationFacts } from '../../src/core/coordination/worktree-postconditions.ts';
import type { GitWorktreeRegistrationFact } from '../../src/core/coordination/metadata-reconcile.ts';
import { assertNoSharedRegularFileIdentity, compareCodeUnits, copyRegularFileNoFollow, inventoryTree } from './inventory.ts';

const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 120_000;

interface ToolGitResult {
  readonly stdout: string;
  readonly stderr: string;
}

function cloneOnlyGitEnvironment(): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_') || /(?:SSH|CREDENTIAL|ASKPASS)/iu.test(key)) continue;
    env[key] = value;
  }
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  return env;
}

async function runToolGit(cwd: string, args: readonly string[], acceptedExitCodes: readonly number[] = [0]): Promise<ToolGitResult> {
  return await new Promise<ToolGitResult>((resolveRun, rejectRun) => {
    const child = spawn('git', args, { cwd, env: cloneOnlyGitEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const capture = (target: Uint8Array[], chunk: ChildProcessDataChunk, current: number): number => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const remaining = Math.max(0, MAX_DIAGNOSTIC_BYTES - current);
      if (bytes.byteLength > remaining) overflow = true;
      if (remaining > 0) target.push(bytes.subarray(0, remaining));
      return current + Math.min(bytes.byteLength, remaining);
    };
    child.stdout?.on('data', (chunk: ChildProcessDataChunk) => { stdoutBytes = capture(stdout, chunk, stdoutBytes); });
    child.stderr?.on('data', (chunk: ChildProcessDataChunk) => { stderrBytes = capture(stderr, chunk, stderrBytes); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error('C5 Git command timed out'));
    }, GIT_TIMEOUT_MS);
    child.once('error', () => { clearTimeout(timer); rejectRun(new Error('C5 Git command could not be spawned')); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === null || !acceptedExitCodes.includes(code) || signal !== null || overflow) rejectRun(new Error(`C5 Git command failed or lost bounded diagnostics: code=${String(code)} signal=${String(signal)} overflow=${String(overflow)} stderr_bytes=${String(Buffer.byteLength(err, 'utf8'))}`));
      else resolveRun({ stdout: out, stderr: err });
    });
  });
}

function assertInside(root: string, path: string, label: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} escapes its clone root`);
}

async function removeHooks(gitCommonDir: string): Promise<void> {
  const hooks = join(gitCommonDir, 'hooks');
  await rm(hooks, { recursive: true, force: true });
  await mkdir(hooks, { recursive: true, mode: 0o700 });
}

async function removeSourceBearingGitMetadata(gitCommonDir: string): Promise<void> {
  await rm(join(gitCommonDir, 'FETCH_HEAD'), { force: true });
  await rm(join(gitCommonDir, 'logs'), { recursive: true, force: true });
}

async function sanitizeGitConfig(gitCommonDir: string): Promise<string> {
  const extensionNames = (await runToolGit(gitCommonDir, ['--git-dir', gitCommonDir, 'config', '--local', '--name-only', '--get-regexp', '^extensions\\.'], [0, 1])).stdout.split('\n').filter((value) => value.length > 0).sort(compareCodeUnits);
  const allowed = new Set(['extensions.objectformat', 'extensions.refstorage']);
  const unsupported = extensionNames.filter((name) => !allowed.has(name.toLowerCase()));
  if (unsupported.length > 0) throw new Error(`C5 Git mirror encountered unsupported repository extensions: ${unsupported.join(',')}`);
  const getExtension = async (name: string): Promise<string> => (await runToolGit(gitCommonDir, ['--git-dir', gitCommonDir, 'config', '--local', '--get', name], [0, 1])).stdout.trim();
  const objectFormat = await getExtension('extensions.objectformat');
  const refStorage = await getExtension('extensions.refstorage');
  if (objectFormat !== '' && objectFormat !== 'sha256') throw new Error(`C5 Git mirror encountered unsupported object format ${objectFormat}`);
  if (refStorage !== '' && refStorage !== 'reftable') throw new Error(`C5 Git mirror encountered unsupported ref storage ${refStorage}`);
  const formatVersion = objectFormat === '' && refStorage === '' ? '0' : '1';
  const config = [
    '[core]',
    `\trepositoryformatversion = ${formatVersion}`,
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = false',
    ...(objectFormat !== '' || refStorage !== '' ? ['[extensions]', ...(objectFormat === 'sha256' ? ['\tobjectformat = sha256'] : []), ...(refStorage === 'reftable' ? ['\trefstorage = reftable'] : [])] : []),
    '',
  ].join('\n');
  writeFileSync(join(gitCommonDir, 'config'), config, { encoding: 'utf8', mode: 0o600 });
  await removeHooks(gitCommonDir);
  return config;
}

async function refs(cwd: string, gitCommonDir?: string): Promise<readonly string[]> {
  const prefix = gitCommonDir === undefined ? [] : ['--git-dir', gitCommonDir];
  const output = await runToolGit(cwd, [...prefix, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)']);
  return Object.freeze(output.stdout.split('\n').filter((line) => line.length > 0).sort(compareCodeUnits));
}

function isClosedGeneratedConfig(config: string): boolean {
  const base = ['[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = false', ''].join('\n');
  if (config === base) return true;
  for (const objectFormat of ['', '\tobjectformat = sha256']) for (const refStorage of ['', '\trefstorage = reftable']) {
    if (objectFormat === '' && refStorage === '') continue;
    const candidate = ['[core]', '\trepositoryformatversion = 1', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = false', '[extensions]', ...(objectFormat === '' ? [] : [objectFormat]), ...(refStorage === '' ? [] : [refStorage]), ''].join('\n');
    if (config === candidate) return true;
  }
  return false;
}

export async function verifyGitObjectClosure(gitCommonDir: string, expectedConfig?: string): Promise<void> {
  const forbidden = [join(gitCommonDir, 'objects', 'info', 'alternates'), join(gitCommonDir, 'objects', 'info', 'grafts'), join(gitCommonDir, 'shallow'), join(gitCommonDir, 'config.worktree'), join(gitCommonDir, 'FETCH_HEAD'), join(gitCommonDir, 'logs')];
  if (forbidden.some(existsSync)) throw new Error('C5 Git mirror retained alternates, grafts, shallow, worktree-local config, FETCH_HEAD, or reflog authority');
  const packRoot = join(gitCommonDir, 'objects', 'pack');
  if (existsSync(packRoot) && (await readdir(packRoot)).some((name) => name.endsWith('.promisor'))) throw new Error('C5 Git mirror retained partial-clone promisor metadata');
  const config = readFileSync(join(gitCommonDir, 'config'), 'utf8');
  if ((expectedConfig !== undefined && config !== expectedConfig) || !isClosedGeneratedConfig(config)) throw new Error('C5 Git mirror config differs from the closed generated allowlist');
  const missing = await runToolGit(gitCommonDir, ['--git-dir', gitCommonDir, 'rev-list', '--objects', '--all', '--missing=print']);
  if (missing.stdout.split('\n').some((line) => line.startsWith('?'))) throw new Error('C5 Git mirror has missing reachable objects');
  await runToolGit(gitCommonDir, ['--git-dir', gitCommonDir, 'fsck', '--full', '--strict']);
}

async function copyWorktreeBytes(sourceRoot: string, destinationRoot: string, sourcePath = sourceRoot, destinationPath = destinationRoot): Promise<void> {
  const entries = (await readdir(sourcePath, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === '.git') {
      if (sourcePath === sourceRoot) continue;
      throw new Error(`C5 Git worktree contains nested Git/submodule metadata requiring a separate isolated mirror: ${join(sourcePath, entry.name)}`);
    }
    const source = join(sourcePath, entry.name);
    const destination = join(destinationPath, entry.name);
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      await mkdir(destination, { mode: stat.mode & 0o777 });
      await copyWorktreeBytes(sourceRoot, destinationRoot, source, destination);
    } else if (stat.isFile()) {
      await copyRegularFileNoFollow(source, destination, stat.mode);
    } else if (stat.isSymbolicLink()) {
      let sourceTarget: string;
      try { sourceTarget = realpathSync(source); }
      catch { throw new Error('C5 Git worktree symlink is dangling or cannot be resolved safely'); }
      const rel = relative(sourceRoot, sourceTarget);
      if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('C5 Git worktree symlink escapes its isolated worktree');
      const destinationTarget = resolve(destinationRoot, rel);
      await symlink(relative(dirname(destination), destinationTarget), destination);
    } else {
      throw new Error('C5 Git worktree source contains an unsupported filesystem node');
    }
  }
}

function mappedWorktreePath(input: {
  readonly source_repository_root: string;
  readonly source_state_root: string;
  readonly copy_repository_root: string;
  readonly copy_state_root: string;
}, sourcePath: string): string {
  const sourceRepository = resolve(input.source_repository_root);
  const sourceState = resolve(input.source_state_root);
  const path = resolve(sourcePath);
  if (path === sourceRepository) return resolve(input.copy_repository_root);
  const rel = relative(sourceState, path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('C5 Git worktree path is outside the declared source roots');
  return resolve(input.copy_state_root, rel);
}

export interface GitMirrorResult {
  readonly git_common_dir: string;
  readonly refs: readonly string[];
  readonly registrations: readonly GitWorktreeRegistrationFact[];
}

export async function buildIsolatedGitMirror(input: {
  readonly source_repository_root: string;
  readonly source_state_root: string;
  readonly copy_root: string;
  readonly copy_repository_root: string;
  readonly copy_state_root: string;
}): Promise<GitMirrorResult> {
  const sourceRepository = resolve(input.source_repository_root);
  const copyRoot = resolve(input.copy_root);
  const copyRepository = resolve(input.copy_repository_root);
  const gitCommonDir = resolve(copyRepository, '.git');
  assertInside(copyRoot, gitCommonDir, 'C5 Git mirror');
  assertInside(copyRoot, copyRepository, 'C5 repository worktree');
  assertInside(copyRoot, input.copy_state_root, 'C5 state root');
  if (existsSync(gitCommonDir) || existsSync(copyRepository)) throw new Error('C5 Git mirror destinations must be absent');
  const sourceRegistrations = gitWorktreeRegistrationFacts(sourceRepository, cloneOnlyGitEnvironment());
  const sourceRefs = await refs(sourceRepository);
  const sourceCommonOutput = await runToolGit(sourceRepository, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const sourceGitRoot = realpathSync(sourceCommonOutput.stdout.trim());
  const createdWorktrees: string[] = [];
  await mkdir(dirname(copyRepository), { recursive: true, mode: 0o700 });
  try {
    await runToolGit(copyRoot, ['clone', '--no-checkout', '--no-hardlinks', sourceRepository, copyRepository]);
    await runToolGit(copyRepository, ['remote', 'remove', 'origin']);
    await runToolGit(copyRepository, ['fetch', '--update-head-ok', '--prune', '--no-tags', sourceRepository, '+refs/*:refs/*']);
    if (existsSync(join(gitCommonDir, 'objects', 'info', 'alternates'))) throw new Error('C5 Git clone unexpectedly retained object alternates');
    const expectedConfig = await sanitizeGitConfig(gitCommonDir);
    if (canonicalRefSet(await refs(copyRepository)) !== canonicalRefSet(sourceRefs)) throw new Error('C5 Git mirror refs differ from the source ref set');
    for (const registration of sourceRegistrations) {
      const destination = mappedWorktreePath(input, registration.worktree_path);
      assertInside(copyRoot, destination, 'C5 rebased Git worktree');
      if (destination === copyRepository) {
        if (!existsSync(registration.worktree_path)) throw new Error('C5 source repository root registration is unexpectedly path-missing');
        await copyWorktreeBytes(registration.worktree_path, destination);
        continue;
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      createdWorktrees.push(destination);
      const branch = registration.branch_ref?.startsWith('refs/heads/') === true ? registration.branch_ref.slice('refs/heads/'.length) : null;
      const args = ['--git-dir', gitCommonDir, 'worktree', 'add', '--no-checkout'];
      if (branch === null) args.push('--detach', destination, registration.head_sha);
      else args.push(destination, branch);
      await runToolGit(copyRoot, args);
      if (existsSync(registration.worktree_path)) await copyWorktreeBytes(registration.worktree_path, destination);
      else await rm(destination, { recursive: true, force: false });
    }
    await removeSourceBearingGitMetadata(gitCommonDir);
    const copiedRegistrations = gitWorktreeRegistrationFacts(gitCommonDir, cloneOnlyGitEnvironment());
    const expectedRegistrations = sourceRegistrations.map((registration) => ({ ...registration, worktree_path: mappedWorktreePath(input, registration.worktree_path) })).sort((left, right) => compareCodeUnits(left.worktree_path, right.worktree_path));
    if (JSON.stringify(copiedRegistrations) !== JSON.stringify(expectedRegistrations)) throw new Error(`C5 rebased Git worktree registrations differ from exact source facts: expected=${JSON.stringify(expectedRegistrations)} actual=${JSON.stringify(copiedRegistrations)}`);
    if ((await readdir(join(gitCommonDir, 'hooks'))).length !== 0) throw new Error('C5 Git mirror retained executable hooks');
    await verifyGitObjectClosure(gitCommonDir, expectedConfig);
    assertNoSharedRegularFileIdentity(await inventoryTree(sourceGitRoot), await inventoryTree(gitCommonDir));
    return Object.freeze({ git_common_dir: gitCommonDir, refs: await refs(copyRepository), registrations: copiedRegistrations });
  } catch (error) {
    const cleanupFailures: string[] = [];
    for (const destination of [...createdWorktrees].reverse()) {
      try { await rm(destination, { recursive: true, force: true }); }
      catch { cleanupFailures.push('linked-worktree'); }
    }
    try { await rm(copyRepository, { recursive: true, force: true }); }
    catch { cleanupFailures.push('primary-repository'); }
    if (cleanupFailures.length > 0) throw new AggregateError([error], `C5 Git mirror failed and cleanup also failed for ${cleanupFailures.join(',')}`);
    throw error;
  }
}

function canonicalRefSet(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}
