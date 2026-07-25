import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { SEED_CANDIDATES } from '../../src/core/roster/provider-recipes.ts';
import { preRunSelectionPath, resolveRosterScopePaths, type RosterSha256 } from '../../src/core/roster/storage.ts';

const CONFIG_SHA: RosterSha256 = 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const root = await realpath(tmpdir());
  const dir = await mkdtemp(join(root, 'roster-selection-race-'));
  try {
    await chmod(dir, 0o700);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cruiseAuthority() {
  const candidate = SEED_CANDIDATES.find((entry) => entry.candidate_id === 'codex-cruise-v1');
  if (candidate === undefined) throw new Error('missing codex cruise candidate');
  return {
    source: 'user-default',
    state: 'present',
    scope: 'user',
    roster_id: candidate.roster_id,
    roster_revision: candidate.roster_revision,
    roster_sha256: candidate.roster_sha256,
    assignment_set_sha256: candidate.assignment_set_sha256,
    config_sha256: CONFIG_SHA,
  };
}

interface ChildResult {
  readonly ok: boolean;
  readonly status: string;
  readonly write_count: number;
  readonly selection_sha256: string | null;
  readonly selected_at: string;
  readonly publish_status: string | null;
  readonly idempotent_replay: boolean | null;
  readonly diagnostics: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

async function runChild(scriptPath: string, env: Record<string, string>): Promise<ChildResult> {
  const child = spawn(process.execPath, ['--experimental-strip-types', scriptPath], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Uint8Array | string) => { stdout += Buffer.from(chunk).toString('utf8'); });
  child.stderr.on('data', (chunk: Uint8Array | string) => { stderr += Buffer.from(chunk).toString('utf8'); });
  const code = await new Promise<number | null>((resolve) => child.on('close', (exitCode) => resolve(exitCode)));
  assert.equal(code, 0, stderr);
  const parsed = JSON.parse(stdout) as Omit<ChildResult, 'stdout' | 'stderr'>;
  return { ...parsed, stdout, stderr };
}

void describe('D69 W3 multiprocess pre-run selection publication', () => {
  void it('allows exactly one real create-only writer and fails conflicting process writers closed', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const runSelectionUrl = pathToFileURL(join(process.cwd(), 'src/core/roster/run-selection.ts')).href;
      const scriptPath = join(dir, 'publish-selection-child.mjs');
      await writeFile(scriptPath, `
import { resolveAndCommitPreRunSelection } from ${JSON.stringify(runSelectionUrl)};
const authority = JSON.parse(process.env.AUTHORITY_JSON);
const selectedAt = process.env.SELECTED_AT;
const result = await resolveAndCommitPreRunSelection({
  stateRoot: process.env.STATE_ROOT,
  repo_id: 'repo-phase37-w0-fixtures',
  workstream_run: 'phase37-w0-race-001',
  user_default: authority,
  selected_at: selectedAt,
  issued_at: '2026-07-22T12:01:01.000Z',
});
process.stdout.write(JSON.stringify({
  ok: result.ok,
  status: result.status,
  write_count: result.write_count,
  selection_sha256: result.selection?.selection_sha256 ?? null,
  selected_at: selectedAt,
  publish_status: result.publish_result?.status ?? null,
  idempotent_replay: result.publish_result?.idempotent_replay ?? null,
  diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code),
}));
`, 'utf8');

      const authorityJson = JSON.stringify(cruiseAuthority());
      const selectedAtA = '2026-07-22T12:01:00.000Z';
      const selectedAtB = '2026-07-22T12:01:00.001Z';
      const children = Array.from({ length: 8 }, (_unused, index) => runChild(scriptPath, {
        STATE_ROOT: stateRoot,
        AUTHORITY_JSON: authorityJson,
        SELECTED_AT: index % 2 === 0 ? selectedAtA : selectedAtB,
      }));
      const results = await Promise.all(children);

      const created = results.filter((result) => result.ok && result.write_count === 1);
      assert.equal(created.length, 1, JSON.stringify(results, null, 2));
      const createdResult = created[0];
      if (createdResult === undefined) throw new Error('expected one created result');
      const winningSelectionSha = createdResult.selection_sha256;
      assert.equal(typeof winningSelectionSha, 'string');

      const okResults = results.filter((result) => result.ok);
      assert.ok(okResults.length >= 1);
      for (const result of okResults) {
        assert.equal(result.selection_sha256, winningSelectionSha);
        if (result.write_count === 0) {
          assert.equal(result.idempotent_replay, true);
          assert.deepEqual(result.diagnostics, ['ROSTER_SELECTION_IDEMPOTENT_REPLAY']);
        }
      }

      const closed = results.filter((result) => !result.ok);
      assert.ok(closed.length >= 1, JSON.stringify(results, null, 2));
      for (const result of closed) {
        assert.ok(result.status === 'blocked' || result.status === 'failed', JSON.stringify(result));
        assert.equal(result.write_count, 0);
        // The create-only race has exactly three legitimate fail-closed loser
        // outcomes, all of which leave zero authority written:
        //   - ROSTER_CREATE_ONLY_CONFLICT: the O_EXCL create lost;
        //   - ROSTER_READBACK_MISMATCH: the winner's bytes differ from ours;
        //   - ROSTER_STORAGE_AUTHORITY_UNSAFE: the selection file's dev/ino
        //     changed between lstat and fstat because a competing writer
        //     atomically renamed the winning file into place mid-read.
        // The third is a real, observable outcome of this exact concurrency
        // (it reproduces on unmodified package bytes), so omitting it made this
        // gate non-deterministic rather than strict.
        assert.ok(
          result.diagnostics.length === 1 &&
            (result.diagnostics[0] === 'ROSTER_CREATE_ONLY_CONFLICT' ||
              result.diagnostics[0] === 'ROSTER_READBACK_MISMATCH' ||
              result.diagnostics[0] === 'ROSTER_STORAGE_AUTHORITY_UNSAFE'),
          JSON.stringify(result),
        );
      }

      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      const selectionPath = preRunSelectionPath(paths, { repo_id: 'repo-phase37-w0-fixtures', workstream_run: 'phase37-w0-race-001' });
      const finalBytes = await readFile(selectionPath, 'utf8');
      assert.equal(finalBytes.includes(`"selection_sha256":"${String(winningSelectionSha)}"`), true);
      const winningSelectedAt = createdResult.selected_at;
      assert.equal(finalBytes.includes(`"selected_at":"${winningSelectedAt}"`), true);
    });
  });
});
