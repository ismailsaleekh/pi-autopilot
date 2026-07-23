import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

function sha(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, '0')}`;
}

function proof(index: number): Readonly<Record<string, unknown>> {
  return { passed: true, evidence_sha256: sha(index) };
}

function proofs(): Readonly<Record<string, unknown>> {
  return {
    roots_disjoint: proof(1),
    no_shared_regular_file_identity: proof(2),
    no_live_symlink_hardlink_socket_route: proof(3),
    git_mirror_self_contained: proof(4),
    git_no_remote_alternate_hook_include: proof(5),
    capability_rotated: proof(6),
    worktree_paths_rebased: proof(7),
    no_live_lock_database_evidence_write_route: proof(8),
    sandbox_write_confinement: proof(9),
    live_before_after_equal: proof(10),
  };
}

function releaseResult(): Readonly<Record<string, unknown>> {
  const actions = ['attach', 'dispatch-dry-run', 'doctor', 'reconcile'].map((action, index) => ({ corpus_id: 'synthetic', run_id_sha256: sha(30), action, outcome: 'passed', evidence_sha256: sha(40 + index) }));
  return {
    schema_version: 'autopilot.s2_d_corpus_rehearsal_result.v1',
    rehearsal_id: 's2-d-package',
    candidate_build: 'phase36-s2',
    action_results: actions,
    live_unchanged: { source_witness_before_sha256: sha(90), source_witness_after_sha256: sha(90), database_witness_before_sha256: sha(91), database_witness_after_sha256: sha(91), git_witness_before_sha256: sha(92), git_witness_after_sha256: sha(92), database_components: true, git_refs: true, registrations: true, worktrees: true, files: true, passed: true },
    isolation_proofs: proofs(),
    new_blockers: [],
    completed_at: '2026-07-23T01:00:00.000Z',
  };
}

function parseJsonLine(stdout: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('command output is not a JSON object');
  return parsed as Readonly<Record<string, unknown>>;
}

function packFilename(stdout: string): string {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null || Array.isArray(parsed[0])) throw new Error('npm pack result is malformed');
  const filename = (parsed[0] as Readonly<Record<string, unknown>>)['filename'];
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('npm pack filename is malformed');
  return filename;
}

void describe('S2-D corpus package/release gate', () => {
  void it('ships only the generic S2-D harness and its installed status/result commands never touch a live corpus by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s2-d-package-'));
    try {
      const cache = join(root, 'npm-cache');
      const packRoot = join(root, 'pack');
      const installRoot = join(root, 'consumer');
      await mkdir(cache, { recursive: true });
      await mkdir(packRoot, { recursive: true });
      await mkdir(installRoot, { recursive: true });
      const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packRoot], { cwd: packageRoot, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: cache, NPM_CONFIG_OFFLINE: 'true' } });
      assert.equal(packed.status, 0, packed.stderr);
      const tarball = join(packRoot, packFilename(packed.stdout));
      const installed = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', tarball], { cwd: installRoot, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: cache, NPM_CONFIG_OFFLINE: 'true' } });
      assert.equal(installed.status, 0, installed.stderr);

      const packageDir = join(installRoot, 'node_modules', 'pi-autopilot');
      assert.equal(await readFile(join(packageDir, 'tools', 's2-corpus-rehearsal', 'contracts.ts'), 'utf8').then((text) => text.includes('autopilot.s2_d_corpus_clone_request.v1')), true);
      await assert.rejects(() => readFile(join(packageDir, 'tests', 'fixtures', 'releases', 'cf50', 'pi-autopilot-1.1.8-cf50.tgz')), /ENOENT/u);
      await assert.rejects(() => readFile(join(packageDir, 'tools', 's1-corpus-rehearsal', 'cli.ts')), /ENOENT/u);

      const bin = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'autopilot-s2-corpus-rehearsal.cmd' : 'autopilot-s2-corpus-rehearsal');
      const status = spawnSync(bin, ['status'], { cwd: installRoot, encoding: 'utf8', env: { ...process.env, S2_D_REHEARSAL_RESULT: '' } });
      assert.equal(status.status, 2, status.stderr);
      assert.equal(parseJsonLine(status.stdout)['reason'], 'private_rehearsal_result_unavailable');

      const resultPath = join(root, 'private-result.json');
      await writeFile(resultPath, `${canonicalJson(releaseResult())}\n`, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') await chmod(resultPath, 0o600);
      const result = spawnSync(bin, ['result', resultPath], { cwd: installRoot, encoding: 'utf8', env: process.env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(parseJsonLine(result.stdout)['kind'], 'result');
      const certified = spawnSync(bin, ['status'], { cwd: installRoot, encoding: 'utf8', env: { ...process.env, S2_D_REHEARSAL_RESULT: resultPath } });
      assert.equal(certified.status, 0, certified.stderr);
      assert.equal(parseJsonLine(certified.stdout)['status'], 'certified');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('wires explicit S2 release certification lanes into package scripts and CI', async () => {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { readonly scripts: Readonly<Record<string, string>> };
    assert.match(pkg.scripts['test:version-skew'] ?? '', /s2-version-skew\.test\.ts/u);
    assert.match(pkg.scripts['test:s2-corpus'] ?? '', /s2-corpus-synthetic-rehearsal\.test\.ts/u);
    assert.match(pkg.scripts['test:release'] ?? '', /npm run test:version-skew && npm run test:s2-corpus/u);
    const workflow = await readFile(join(packageRoot, '.github', 'workflows', 'release-certification.yml'), 'utf8');
    assert.match(workflow, /npm run test:version-skew/u);
    assert.match(workflow, /npm run test:s2-corpus/u);
  });
});
