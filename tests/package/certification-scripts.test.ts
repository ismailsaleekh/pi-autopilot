import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const wrapper = join(root, 'scripts', 'run-certified-command.mjs');
const gitScanner = join(root, 'scripts', 'check-production-git-spawns.mjs');

function isolatedEnv(): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:OPENAI|ANTHROPIC|OPENROUTER|GOOGLE|GEMINI|MISTRAL|GROQ|XAI|AZURE_OPENAI|AWS_BEDROCK)/u.test(key)));
}

function run(command: string, args: readonly string[], cwd = root): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: isolatedEnv(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
}

function jsonObject(text: string, label: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

void describe('literal certification scripts', () => {
  void it('runs literal argv in an isolated lane and atomically seals hashes/process-tree evidence', async () => {
    const evidence = await mkdtemp(join(tmpdir(), 'autopilot-certified-wrapper-'));
    await chmod(evidence, 0o700);
    try {
      const invocation = run(process.execPath, [wrapper, '--evidence-dir', evidence, '--id', 'package-success', '--timeout-ms', '5000', '--max-rss-bytes', '536870912', '--', process.execPath, '-e', 'process.stdout.write("certified-output\\n")']);
      assert.equal(invocation.status, 0, invocation.stderr);
      const report = jsonObject(await readFile(join(evidence, 'package-success.json'), 'utf8'), 'certified report');
      assert.equal(report['schema_version'], 'autopilot.certified_command.v1');
      assert.equal(report['passed'], true);
      assert.equal(report['breach'], null);
      assert.equal(report['close_observed'], true);
      assert.equal(report['cleanup_error'], null);
      assert.equal(typeof report['process_tree_peak_rss_bytes'], 'number');
      if (process.platform === 'darwin') {
        assert.equal(typeof report['kernel_descendant_max_rss_bytes'], 'number');
        assert.equal(report['process_discovery'], 'cumulative-10ms-plus-kernel-rusage');
      }
      const stdout = report['stdout'];
      if (typeof stdout !== 'object' || stdout === null || Array.isArray(stdout)) throw new TypeError('stdout evidence must be an object');
      const stdoutEvidence = Object.fromEntries(Object.entries(stdout));
      assert.equal(stdoutEvidence['byte_count'], 17);
      assert.match(String(stdoutEvidence['sha256']), /^sha256:[a-f0-9]{64}$/u);
      assert.equal(await readFile(join(evidence, 'package-success.stdout.log'), 'utf8'), 'certified-output\n');
      const replay = run(process.execPath, [wrapper, '--evidence-dir', evidence, '--id', 'package-success', '--timeout-ms', '5000', '--max-rss-bytes', '536870912', '--', process.execPath, '-e', '']);
      assert.notEqual(replay.status, 0);
      assert.match(replay.stderr, /evidence report already exists/u);
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });

  void it('retains every observed descendant identity after a child exits', async () => {
    const evidence = await mkdtemp(join(tmpdir(), 'autopilot-certified-descendant-'));
    await chmod(evidence, 0o700);
    try {
      const program = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},150)'],{stdio:'ignore'});setTimeout(()=>{},350)`;
      const invocation = run(process.execPath, [wrapper, '--evidence-dir', evidence, '--id', 'package-descendant', '--timeout-ms', '5000', '--max-rss-bytes', '536870912', '--', process.execPath, '-e', program]);
      assert.equal(invocation.status, 0, invocation.stderr);
      const report = jsonObject(await readFile(join(evidence, 'package-descendant.json'), 'utf8'), 'descendant report');
      const identities = report['process_identities'];
      if (!Array.isArray(identities)) throw new TypeError('process identities must be an array');
      assert.equal(identities.length >= 2, true, 'the cumulative process-tree witness must retain the exited descendant');
    } finally { await rm(evidence, { recursive: true, force: true }); }
  });

  void it('fails a forbidden-network lane even when the child catches the canary error', async () => {
    const evidence = await mkdtemp(join(tmpdir(), 'autopilot-certified-network-'));
    await chmod(evidence, 0o700);
    try {
      const invocation = run(process.execPath, [wrapper, '--evidence-dir', evidence, '--id', 'package-network', '--timeout-ms', '5000', '--max-rss-bytes', '536870912', '--', process.execPath, '-e', 'fetch("https://example.invalid").catch(()=>{})']);
      assert.equal(invocation.status, 1, invocation.stderr);
      const report = jsonObject(await readFile(join(evidence, 'package-network.json'), 'utf8'), 'network report');
      assert.equal(report['breach'], 'network-access');
      assert.equal(report['passed'], false);
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });

  void it('fails if a lane mutates the sealed candidate tree', async () => {
    const evidence = await mkdtemp(join(tmpdir(), 'autopilot-certified-mutation-'));
    const marker = join(root, `.certified-mutation-${String(process.pid)}`);
    await chmod(evidence, 0o700);
    try {
      const invocation = run(process.execPath, [wrapper, '--evidence-dir', evidence, '--id', 'package-mutation', '--timeout-ms', '5000', '--max-rss-bytes', '536870912', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'mutation')`]);
      assert.equal(invocation.status, 1, invocation.stderr);
      const report = jsonObject(await readFile(join(evidence, 'package-mutation.json'), 'utf8'), 'mutation report');
      assert.equal(report['breach'], 'candidate-mutated');
      assert.equal((report['candidate'] as Record<string, unknown>)['post_command_equal'], false);
    } finally {
      await rm(marker, { force: true });
      await rm(evidence, { recursive: true, force: true });
    }
  });

  void it('kills/reaps an ignoring child at the inclusive timeout and records a failed lane', async () => {
    const evidence = await mkdtemp(join(tmpdir(), 'autopilot-certified-timeout-'));
    await chmod(evidence, 0o700);
    try {
      const invocation = run(process.execPath, [wrapper, '--evidence-dir', evidence, '--id', 'package-timeout', '--timeout-ms', '100', '--max-rss-bytes', '536870912', '--', process.execPath, '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)']);
      assert.equal(invocation.status, 1, invocation.stderr);
      const report = jsonObject(await readFile(join(evidence, 'package-timeout.json'), 'utf8'), 'timeout report');
      assert.equal(report['breach'], 'timeout');
      assert.equal(report['close_observed'], true);
      assert.equal(report['passed'], false);
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });

  void it('requires an external exact mode-0700 evidence directory', async () => {
    const evidence = await mkdtemp(join(tmpdir(), 'autopilot-certified-mode-'));
    await chmod(evidence, 0o755);
    try {
      const invocation = run(process.execPath, [wrapper, '--evidence-dir', evidence, '--id', 'bad-mode', '--timeout-ms', '1000', '--max-rss-bytes', '536870912', '--', process.execPath, '-e', '']);
      assert.notEqual(invocation.status, 0);
      assert.match(invocation.stderr, /mode-700/u);
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });

  void it('keeps certification and the real packed witness in the release gate', async () => {
    const manifest = jsonObject(await readFile(join(root, 'package.json'), 'utf8'), 'package manifest');
    const scriptsValue = manifest['scripts'];
    if (typeof scriptsValue !== 'object' || scriptsValue === null || Array.isArray(scriptsValue)) throw new TypeError('package scripts must be an object');
    const scripts = Object.fromEntries(Object.entries(scriptsValue));
    assert.equal(scripts['certify:command'], 'node scripts/run-certified-command.mjs');
    assert.equal(scripts['verify:packed-consumer'], 'node scripts/verify-packed-consumer.mjs');
    assert.equal(scripts['test:packed-consumer'], 'node scripts/test-packed-consumer-release.mjs');
    assert.match(String(scripts['test:release']), /npm run test:packed-consumer/u);
    const packedReleaseSource = await readFile(join(root, 'scripts', 'test-packed-consumer-release.mjs'), 'utf8');
    assert.match(packedReleaseSource, /\['pack', '--ignore-scripts', '--json', '--pack-destination', root\]/u, 'real packed witness must not execute candidate lifecycle scripts');
  });

  void it('accepts the installed production tree and rejects a raw Git spawn outside git-process', async () => {
    const clean = run(process.execPath, [gitScanner, root]);
    assert.equal(clean.status, 0, clean.stderr);
    const cleanResult = jsonObject(clean.stdout, 'clean scanner result');
    assert.equal(cleanResult['passed'], true);
    assert.deepEqual(cleanResult['scanned_roots'], ['src', 'dist/src', 'dist/extensions', 'bin', 'extensions', 'scripts']);
    const fixture = await mkdtemp(join(tmpdir(), 'autopilot-git-spawn-scan-'));
    try {
      await mkdir(join(fixture, 'src', 'core'), { recursive: true });
      await mkdir(join(fixture, 'dist', 'src', 'core'), { recursive: true });
      await mkdir(join(fixture, 'dist', 'extensions'), { recursive: true });
      await mkdir(join(fixture, 'scripts'), { recursive: true });
      await mkdir(join(fixture, 'bin'), { recursive: true });
      await mkdir(join(fixture, 'extensions'), { recursive: true });
      await writeFile(join(fixture, 'src', 'core', 'git-process.ts'), '// allowed owner\n');
      await writeFile(join(fixture, 'dist', 'src', 'core', 'git-process.js'), '// allowed owner\n');
      await writeFile(join(fixture, 'src', 'core', 'forbidden.ts'), "import { spawnSync } from 'node:child_process'; spawnSync('git', ['status']);\n");
      await writeFile(join(fixture, 'src', 'core', 'agent-runner.ts'), "import { spawnSync as invoke } from 'node:child_process'; const executable = 'git'; invoke(executable, ['status']);\n");
      await writeFile(join(fixture, 'src', 'core', 'disk-gate.ts'), "import * as cp from 'node:child_process'; const executable = 'git'; cp.spawnSync(executable, ['status']);\n");
      await writeFile(join(fixture, 'src', 'core', 'private-path.ts'), "import { spawnSync } from 'node:child_process'; function run(executable: string) { return spawnSync(executable, ['status']); } run('git');\n");
      await writeFile(join(fixture, 'scripts', 'forbidden.mjs'), "import { spawnSync as invoke } from 'node:child_process'; const executable = 'git'; invoke(executable, ['status']);\n");
      await writeFile(join(fixture, 'bin', 'forbidden.mjs'), "import * as cp from 'node:child_process'; const executable = 'git'; cp.spawnSync(executable, ['status']);\n");
      await writeFile(join(fixture, 'dist', 'extensions', 'forbidden.js'), "import { spawnSync } from 'node:child_process'; const executable = 'git'; spawnSync(executable, ['status']);\n");
      await writeFile(join(fixture, 'dist', 'src', 'core', 'forbidden.js'), "import { spawnSync } from 'node:child_process'; const executable = 'git'; spawnSync(executable, ['status']);\n");
      await writeFile(join(fixture, 'extensions', 'forbidden.ts'), "import { spawnSync } from 'node:child_process'; const executable = 'git'; spawnSync(executable, ['status']);\n");
      const rejected = run(process.execPath, [gitScanner, fixture]);
      assert.equal(rejected.status, 1, rejected.stderr);
      const result = jsonObject(rejected.stdout, 'rejected scanner result');
      assert.equal(result['passed'], false);
      const violations = result['violations'];
      if (!Array.isArray(violations)) throw new TypeError('scanner violations must be an array');
      assert.equal(violations.length, 9);
      assert.deepEqual(violations.map((entry) => (entry as Record<string, unknown>)['reason']).sort(), ['raw-git-executable-token-outside-owner', 'raw-git-executable-token-outside-owner', 'raw-git-executable-token-outside-owner', 'unapproved-production-process-owner', 'unapproved-production-process-owner', 'unapproved-production-process-owner', 'unapproved-production-process-owner', 'unapproved-production-process-owner', 'unapproved-production-process-owner']);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
