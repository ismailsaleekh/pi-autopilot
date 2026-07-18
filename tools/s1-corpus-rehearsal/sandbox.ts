import { spawn, spawnSync, type ChildProcessDataChunk } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import type { Sha256Digest } from './contracts.ts';
import { compareCodeUnits, copyRegularFileNoFollow, readRegularFileNoFollow } from './inventory.ts';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface SandboxedResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
  readonly policy_sha256: Sha256Digest;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function shellAvailable(path: string): boolean {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0 || (path.endsWith('sandbox-exec') && result.status !== null);
}

function escapedSeatbeltPath(path: string): string {
  const value = resolve(path);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('C5 sandbox path contains control characters');
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function normalizedDeniedRoots(cloneRoot: string, roots: readonly string[]): readonly string[] {
  const operatorHome = process.env['HOME'];
  const privateRoots = [...roots, ...(operatorHome !== undefined && existsSync(operatorHome) ? [operatorHome] : [])];
  const candidates = [...new Set(privateRoots.map((path) => realpathSync(path)))].sort((left, right) => left.length - right.length || compareCodeUnits(left, right));
  if (candidates.length === 0) throw new Error('C5 sandbox requires explicit live/source read-deny roots');
  for (const path of candidates) if (inside(path, cloneRoot) || inside(cloneRoot, path)) throw new Error('C5 sandbox live/source deny root overlaps clone authority');
  const output = candidates.filter((path, index) => !candidates.some((parent, parentIndex) => parentIndex < index && inside(parent, path)));
  return Object.freeze(output.sort(compareCodeUnits));
}

function macDeveloperReadRoot(): string {
  const selected = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  if (selected.error !== undefined || selected.status !== 0 || selected.signal !== null) throw new Error('C5 macOS sandbox cannot resolve its Python/libproc developer runtime');
  const developer = resolve(selected.stdout.trim());
  const appMarker = developer.indexOf('.app/');
  const root = appMarker >= 0 ? developer.slice(0, appMarker + 4) : developer;
  if (!inside('/Applications', root) && !inside('/Library/Developer', root)) throw new Error('C5 macOS developer runtime is outside trusted system roots');
  return realpathSync(root);
}

function sandboxProfile(cloneRoot: string, deniedRoots: readonly string[]): string {
  const clone = escapedSeatbeltPath(cloneRoot);
  const systemReadRoots = [...new Set(['/System', '/usr', '/Library', '/etc', '/var', '/private/etc', '/private/var', macDeveloperReadRoot()].filter(existsSync).flatMap((path) => [resolve(path), realpathSync(path)]))].sort(compareCodeUnits);
  const allows = systemReadRoots.map((path) => `(allow file-read* (subpath "${escapedSeatbeltPath(path)}"))`);
  const readAncestors: string[] = [];
  for (const root of [cloneRoot, ...systemReadRoots]) for (let cursor = dirname(root); cursor !== dirname(cursor); cursor = dirname(cursor)) readAncestors.push(cursor);
  const ancestorMetadata = [...new Set(readAncestors)].sort(compareCodeUnits).map((path) => `(allow file-read-metadata (literal "${escapedSeatbeltPath(path)}"))`);
  const denies = deniedRoots.map((path) => {
    const escaped = escapedSeatbeltPath(path);
    return lstatSync(path).isDirectory() ? `(deny file-read* file-write* (subpath "${escaped}"))` : `(deny file-read* file-write* (literal "${escaped}"))`;
  });
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target children))',
    '(allow file-read* (literal "/"))',
    ...ancestorMetadata,
    `(allow file-read* file-write* (subpath "${clone}"))`,
    '(allow file-read* (subpath "/dev"))',
    '(allow file-write-data (literal "/dev/null"))',
    ...allows,
    '(allow sysctl-read)',
    '(allow network-bind network-inbound (local unix-socket))',
    '(allow network-outbound (remote unix-socket))',
    ...denies,
    '',
  ].join('\n');
}

async function commandForSandbox(input: {
  readonly clone_root: string;
  readonly denied_source_roots: readonly string[];
  readonly command: string;
  readonly args: readonly string[];
}): Promise<{ readonly executable: string; readonly args: readonly string[]; readonly cleanup_paths: readonly string[]; readonly policy_sha256: Sha256Digest }> {
  const cloneRoot = realpathSync(input.clone_root);
  const deniedRoots = normalizedDeniedRoots(cloneRoot, input.denied_source_roots);
  if (platform() === 'darwin') {
    const executable = '/usr/bin/sandbox-exec';
    if (!existsSync(executable) || !shellAvailable(executable)) throw new Error('C5 macOS sandbox-exec backend is unavailable');
    const profilePath = join(cloneRoot, 'private', 'c5-sandbox.sb');
    await mkdir(join(cloneRoot, 'private'), { recursive: true, mode: 0o700 });
    const profile = sandboxProfile(cloneRoot, deniedRoots);
    await writeFile(profilePath, profile, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return Object.freeze({ executable, args: Object.freeze(['-f', profilePath, '--', input.command, ...input.args]), cleanup_paths: Object.freeze([profilePath]), policy_sha256: `sha256:${createHash('sha256').update(profile).digest('hex')}` });
  }
  if (platform() === 'linux') {
    if (process.getuid?.() === 0) throw new Error('C5 Linux bubblewrap confinement refuses root execution');
    const executable = '/usr/bin/bwrap';
    if (!existsSync(executable) || !shellAvailable(executable)) throw new Error('C5 Linux bubblewrap backend is unavailable');
    const maskRoot = await mkdtemp(join(tmpdir(), 'pi-c5-bwrap-deny-'));
    const maskFile = join(maskRoot, 'unreadable-file');
    const maskDirectory = join(maskRoot, 'unreadable-directory');
    await writeFile(maskFile, '', { flag: 'wx', mode: 0o000 });
    await mkdir(maskDirectory, { mode: 0o000 });
    await chmod(maskRoot, 0o700);
    const masks = deniedRoots.flatMap((path) => lstatSync(path).isDirectory() ? ['--ro-bind', maskDirectory, path] : ['--ro-bind', maskFile, path]);
    const policy = canonicalJson({ backend: 'linux-bwrap', isolation: ['die-with-parent', 'new-session', 'unshare-net', 'unshare-pid', 'unshare-ipc', 'unshare-uts', 'unshare-cgroup'], deny_semantics: 'unreadable-read-only-bind', denied_root_sha256: deniedRoots.map((path) => `sha256:${createHash('sha256').update(path).digest('hex')}`) });
    return Object.freeze({ executable, args: Object.freeze(['--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--ro-bind', '/', '/', '--bind', cloneRoot, cloneRoot, ...masks, '--chdir', cloneRoot, '--proc', '/proc', '--dev', '/dev', input.command, ...input.args]), cleanup_paths: Object.freeze([maskRoot]), policy_sha256: `sha256:${createHash('sha256').update(policy).digest('hex')}` });
  }
  throw new Error('C5 Windows execution requires a separately provisioned Windows Sandbox or ephemeral VM backend');
}

export async function runSandboxed(input: {
  readonly clone_root: string;
  readonly denied_source_roots: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout_ms?: number;
}): Promise<SandboxedResult> {
  const cloneRoot = realpathSync(input.clone_root);
  const cwd = realpathSync(input.cwd);
  if (!inside(cloneRoot, cwd)) throw new Error('C5 sandbox cwd escapes clone root');
  const invocation = await commandForSandbox({ clone_root: cloneRoot, denied_source_roots: input.denied_source_roots, command: input.command, args: input.args });
  try {
    return await new Promise<SandboxedResult>((resolveRun, rejectRun) => {
      const detached = platform() === 'darwin';
      const child = spawn(invocation.executable, invocation.args, { cwd, env: input.env, shell: false, detached, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflow = false;
      const capture = (target: Uint8Array[], chunk: ChildProcessDataChunk, current: number): number => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - current);
        if (bytes.byteLength > remaining) overflow = true;
        if (remaining > 0) target.push(bytes.subarray(0, remaining));
        return current + Math.min(bytes.byteLength, remaining);
      };
      child.stdout?.on('data', (chunk: ChildProcessDataChunk) => { stdoutBytes = capture(stdout, chunk, stdoutBytes); });
      child.stderr?.on('data', (chunk: ChildProcessDataChunk) => { stderrBytes = capture(stderr, chunk, stderrBytes); });
      const terminateProcessAuthority = (): void => {
        if (detached && child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { if (child.exitCode === null) child.kill('SIGKILL'); }
        } else if (child.exitCode === null) child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        terminateProcessAuthority();
        rejectRun(new Error('C5 sandbox command timed out'));
      }, input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
      child.once('error', (error) => { clearTimeout(timer); terminateProcessAuthority(); rejectRun(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        terminateProcessAuthority();
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        if (signal !== null || code === null || overflow) rejectRun(new Error(`C5 sandbox command lost bounded process truth: signal=${String(signal)} code=${String(code)} overflow=${String(overflow)}`));
        else resolveRun(Object.freeze({ stdout: out, stderr: err, exit_code: code, policy_sha256: invocation.policy_sha256 }));
      });
    });
  } finally {
    for (const path of invocation.cleanup_paths) await rm(path, { recursive: true, force: true });
  }
}

export async function proveSandboxWriteConfinement(input: {
  readonly clone_root: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly outside_sentinel_path: string;
  readonly outside_sentinel_owner_root: string;
  readonly denied_source_roots?: readonly string[];
}): Promise<Sha256Digest> {
  const cloneRoot = realpathSync(input.clone_root);
  const sentinel = realpathSync(input.outside_sentinel_path);
  const sentinelOwner = realpathSync(input.outside_sentinel_owner_root);
  const sourceRoots = (input.denied_source_roots ?? []).map((path) => realpathSync(path));
  if (inside(cloneRoot, sentinel) || !inside(sentinelOwner, sentinel)) throw new Error('C5 sandbox sentinel must be harness-owned and outside clone authority');
  for (const source of sourceRoots) if (inside(source, sentinelOwner) || inside(sentinelOwner, source)) throw new Error('C5 sandbox sentinel owner must be disjoint from every live/source root');
  const before = readRegularFileNoFollow(sentinel, 64 * 1024);
  if (before.identity.link_count !== 1 || process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new Error('C5 sandbox sentinel must be a private harness-owned single-link file');
  const sentinelDirectory = realpathSync(resolve(sentinel, '..'));
  const deniedRoots = [...sourceRoots, sentinelDirectory];
  const probePath = join(cloneRoot, 'private', 'sandbox-write-probe');
  const deniedDirectoryWriteProbe = join(sentinelDirectory, 'sandbox-must-not-create');
  await mkdir(join(cloneRoot, 'private'), { recursive: true, mode: 0o700 });
  const script = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(probePath)},'clone-write-ok\\n',{flag:'wx'});`,
    `const liveRoots=${JSON.stringify(sourceRoots)};`,
    'let readDenied=false;try{fs.readFileSync(', JSON.stringify(sentinel), ")}catch{readDenied=true}",
    'let writeDenied=false;try{fs.writeFileSync(', JSON.stringify(sentinel), ",'forbidden\\n')}catch{writeDenied=true}",
    'let directoryWriteDenied=false;try{fs.writeFileSync(', JSON.stringify(deniedDirectoryWriteProbe), ",'forbidden\\n',{flag:'wx'})}catch{directoryWriteDenied=true}",
    "let deniedLiveReads=0;for(const root of liveRoots){try{const stat=fs.lstatSync(root);if(stat.isDirectory())fs.readdirSync(root);else fs.readFileSync(root)}catch{deniedLiveReads+=1}}const liveReadDenied=deniedLiveReads===liveRoots.length;",
    "if(!readDenied||!writeDenied||!directoryWriteDenied||!liveReadDenied){process.stderr.write('outside read/write unexpectedly succeeded\\n');process.exit(3)}",
    "process.stdout.write('sandbox-confined\\n');",
  ].join('');
  const sandboxNode = join(cloneRoot, 'private', 'toolchain', 'node');
  await mkdir(join(cloneRoot, 'private', 'toolchain'), { recursive: true, mode: 0o700 });
  await copyRegularFileNoFollow(process.execPath, sandboxNode, 0o700);
  const result = await runSandboxed({ clone_root: cloneRoot, denied_source_roots: deniedRoots, cwd: input.cwd, env: input.env, command: sandboxNode, args: ['-e', script] });
  if (result.exit_code !== 0 || result.stdout !== 'sandbox-confined\n' || !existsSync(probePath)) throw new Error(`C5 sandbox confinement probe failed with code ${String(result.exit_code)}`);
  const after = readRegularFileNoFollow(sentinel, 64 * 1024);
  if (existsSync(deniedDirectoryWriteProbe) || before.identity.device !== after.identity.device || before.identity.inode !== after.identity.inode || before.size_bytes !== after.size_bytes || Buffer.from(before.bytes).toString('hex') !== Buffer.from(after.bytes).toString('hex')) throw new Error('C5 sandbox changed its harness-owned outside sentinel');
  const deniedPathDigests = normalizedDeniedRoots(cloneRoot, deniedRoots).map((path) => `sha256:${createHash('sha256').update(path).digest('hex')}`);
  return `sha256:${createHash('sha256').update(canonicalJson({ backend: platform(), policy_sha256: result.policy_sha256, denied_path_sha256: deniedPathDigests, clone_probe_sha256: `sha256:${createHash('sha256').update(readFileSync(probePath)).digest('hex')}`, outside_sha256: `sha256:${createHash('sha256').update(after.bytes).digest('hex')}` })).digest('hex')}`;
}
