import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { buildCloneEnvironment } from '../../tools/s1-corpus-rehearsal/environment.ts';
import { installPackedRelease } from '../../tools/s1-corpus-rehearsal/release-install.ts';
import { proveSandboxWriteConfinement, runSandboxed } from '../../tools/s1-corpus-rehearsal/sandbox.ts';

void it('proves C5 clone-only writes or fails loudly when the platform backend is unavailable', async () => {
  const root = await realpath(await mkdtemp(join(platform() === 'win32' ? tmpdir() : '/tmp', 'pi-c5-sandbox-')));
  const cloneRoot = join(root, 'clone');
  const sentinelOwner = join(root, 'harness-sentinel');
  const outsideSentinel = join(sentinelOwner, 'outside-sentinel');
  const deniedSource = join(root, 'live-source-read-denied');
  try {
    await mkdir(cloneRoot, { recursive: true });
    await mkdir(sentinelOwner, { mode: 0o700 });
    await writeFile(outsideSentinel, 'outside authority must remain immutable\n', { encoding: 'utf8', mode: 0o600 });
    await mkdir(deniedSource, { mode: 0o700 });
    await writeFile(join(deniedSource, 'live-secret'), 'must not be visible\n', { encoding: 'utf8', mode: 0o600 });
    const environment = await buildCloneEnvironment({
      clone_root: cloneRoot,
      state_root: join(cloneRoot, 'state'),
      project_root: join(cloneRoot, 'project'),
      home_root: join(cloneRoot, 'home'),
      temp_root: join(cloneRoot, 'tmp'),
      npm_cache_root: join(cloneRoot, 'npm-cache'),
    });
    assert.equal(Object.hasOwn(environment.env, 'AUTOPILOT_COORDINATOR_SESSION_CONTEXT'), false);
    if (platform() !== 'win32') {
      const longClone = join(root, 'x'.repeat(80));
      await mkdir(longClone, { mode: 0o700 });
      await assert.rejects(() => buildCloneEnvironment({ clone_root: longClone, state_root: join(longClone, 'state'), project_root: join(longClone, 'project'), home_root: join(longClone, 'home'), temp_root: join(longClone, 'tmp'), npm_cache_root: join(longClone, 'npm-cache') }), /too long.*Unix coordinator sockets/u);
    }
    await assert.rejects(() => proveSandboxWriteConfinement({ clone_root: cloneRoot, cwd: join(cloneRoot, 'project'), env: environment.env, outside_sentinel_path: outsideSentinel, outside_sentinel_owner_root: sentinelOwner, denied_source_roots: [sentinelOwner] }), /sentinel owner must be disjoint/u);
    const backendAvailable = platform() === 'darwin' ? existsSync('/usr/bin/sandbox-exec') : platform() === 'linux' ? existsSync('/usr/bin/bwrap') && process.getuid?.() !== 0 : false;
    if (!backendAvailable) {
      await assert.rejects(() => proveSandboxWriteConfinement({ clone_root: cloneRoot, cwd: join(cloneRoot, 'project'), env: environment.env, outside_sentinel_path: outsideSentinel, outside_sentinel_owner_root: sentinelOwner, denied_source_roots: [deniedSource] }), /backend is unavailable|Windows execution requires|refuses root execution/u);
      assert.equal(await readFile(outsideSentinel, 'utf8'), 'outside authority must remain immutable\n');
      return;
    }
    const proof = await proveSandboxWriteConfinement({ clone_root: cloneRoot, cwd: join(cloneRoot, 'project'), env: environment.env, outside_sentinel_path: outsideSentinel, outside_sentinel_owner_root: sentinelOwner, denied_source_roots: [deniedSource] });
    assert.match(proof, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(await readFile(outsideSentinel, 'utf8'), 'outside authority must remain immutable\n');
    assert.equal(await readFile(join(cloneRoot, 'private', 'sandbox-write-probe'), 'utf8'), 'clone-write-ok\n');

    const releaseSource = join(root, 'release-source');
    await mkdir(releaseSource, { recursive: true });
    const releaseTarball = join(cloneRoot, 'actual-cf50.tgz');
    await copyFile(join(process.cwd(), 'tests', 'fixtures', 'releases', 'cf50', 'pi-autopilot-1.1.8-cf50.tgz'), releaseTarball);
    const installed = await installPackedRelease({ scenario_root: cloneRoot, project_root: join(cloneRoot, 'project'), environment: environment.env, denied_source_roots: [releaseSource], tarball_path: releaseTarball, expected_tarball_sha256: 'sha256:e98ccee99e95d5ba9c958c91c354eef40326fa21cf89a8ba37bd10e6650485a7', release_kind: 'actual-cf50' });
    assert.equal(installed.package_build, '1.1.8-cf50');

    const roundTripWorker = join(cloneRoot, 'private', 'sandbox-coordinator-roundtrip.mjs');
    await writeFile(roundTripWorker, `
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [cli,modulePath,packageRoot,stateRoot]=process.argv.slice(2);
if(!cli||!modulePath||!packageRoot||!stateRoot) throw new Error('roundtrip arguments missing');
const loaded=await import(pathToFileURL(modulePath).href);
const Client=loaded.CoordinatorClient;
if(typeof Client!=='function') throw new Error('CoordinatorClient missing');
const env={...process.env,AUTOPILOT_STATE_ROOT:stateRoot};
const child=spawn(process.execPath,[cli,'serve','--state-root',stateRoot],{cwd:packageRoot,env,stdio:['ignore','ignore','pipe']});
let diagnostics=''; child.stderr.on('data',(chunk)=>{if(diagnostics.length<65536)diagnostics+=chunk.toString('utf8')});
const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
try {
  const client=new Client({env,autoStart:false,startupTimeoutMs:30000,readinessTimeoutMs:60000});
  const deadline=Date.now()+90000; let response=null; let lastClientError='none';
  while(Date.now()<deadline&&response===null){if(child.exitCode!==null)throw new Error('coordinator exited '+String(child.exitCode)+' '+String(diagnostics.length));try{const value=await client.query('handshake');if(value.ok)response=value;else lastClientError=String(value.error_code)}catch(error){lastClientError=error instanceof Error?error.message:String(error)}if(response===null)await wait(50)}
  if(response===null||response.payload?.package_build!=='1.1.8-cf50')throw new Error('sandboxed coordinator handshake failed '+String(lastClientError.length));
  process.stdout.write('sandbox-coordinator-roundtrip-ok\\n');
} finally {
  if(child.exitCode===null)child.kill('SIGTERM');
  const deadline=Date.now()+30000;while(child.exitCode===null&&Date.now()<deadline)await wait(25);
  if(child.exitCode===null){child.kill('SIGKILL');throw new Error('sandboxed coordinator leaked')}
}
`, { encoding: 'utf8', mode: 0o600 });
    const roundTrip = await runSandboxed({ clone_root: cloneRoot, denied_source_roots: [releaseSource], cwd: join(cloneRoot, 'project'), env: environment.env, command: join(cloneRoot, 'private', 'toolchain', 'node'), args: [roundTripWorker, installed.coordinator_cli_path, installed.client_module_path, installed.package_root, join(cloneRoot, 'state')], timeout_ms: 120_000 });
    assert.equal(roundTrip.exit_code, 0, roundTrip.stderr);
    assert.equal(roundTrip.stdout, 'sandbox-coordinator-roundtrip-ok\n');
    assert.equal(roundTrip.stderr, '');

    const abortMarker = join(cloneRoot, 'private', 'sandbox-abort-child-pid');
    const abortWorker = join(cloneRoot, 'private', 'sandbox-process-abort.mjs');
    await writeFile(abortWorker, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const marker=process.argv[2];
if(!marker) throw new Error('abort marker missing');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
if(child.pid===undefined) throw new Error('abort child pid missing');
writeFileSync(marker,String(child.pid),{flag:'wx',mode:0o600});
process.abort();
`, { encoding: 'utf8', mode: 0o600 });
    await assert.rejects(() => runSandboxed({ clone_root: cloneRoot, denied_source_roots: [deniedSource], cwd: join(cloneRoot, 'project'), env: environment.env, command: join(cloneRoot, 'private', 'toolchain', 'node'), args: [abortWorker, abortMarker], timeout_ms: 30_000 }), /lost bounded process truth/u);
    const abortedChildPid = Number.parseInt(await readFile(abortMarker, 'utf8'), 10);
    assert.equal(Number.isSafeInteger(abortedChildPid), true);
    const reapDeadline = Date.now() + 5_000;
    while (isProcessAlive(abortedChildPid) && Date.now() < reapDeadline) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    assert.equal(isProcessAlive(abortedChildPid), false, 'macOS sandbox process-group teardown must reap descendants after an uncatchable worker abort');
  } finally { await rm(root, { recursive: true, force: true }); }
});
