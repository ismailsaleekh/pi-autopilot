import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { GitWorktreeRegistrationFact } from '../../src/core/coordination/metadata-reconcile.ts';

interface JsonMap { readonly [key: string]: unknown }

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonMap;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) throw new Error(`${label} must be nonempty text`);
  return value;
}

function parseRegistration(value: unknown): GitWorktreeRegistrationFact {
  const row = record(value, 'C5 closed Git registration');
  const fields = ['branch_ref', 'head_sha', 'prunable', 'worktree_path'];
  if (Object.keys(row).sort().join('\u0000') !== fields.join('\u0000')) throw new Error('C5 closed Git registration has an unexpected field set');
  const branch = row['branch_ref'];
  if (branch !== null && typeof branch !== 'string') throw new Error('C5 closed Git registration branch must be text or null');
  if (typeof row['prunable'] !== 'boolean') throw new Error('C5 closed Git registration prunable flag must be boolean');
  return Object.freeze({ worktree_path: text(row['worktree_path'], 'C5 closed Git registration path'), head_sha: text(row['head_sha'], 'C5 closed Git registration HEAD'), branch_ref: branch, prunable: row['prunable'] });
}

export function closedGitWorktreeRegistrationFacts(repositoryRoot: string): readonly GitWorktreeRegistrationFact[] {
  const worker = fileURLToPath(new URL('closed-git-registration-worker.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', worker, repositoryRoot], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null || result.stderr !== '') throw new Error(`C5 closed Git registration measurement failed with status ${String(result.status)} and bounded diagnostics ${String(Buffer.byteLength(result.stderr ?? ''))}`);
  const parsed: unknown = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 100_000) throw new Error('C5 closed Git registration measurement is not a bounded array');
  return Object.freeze(parsed.map(parseRegistration));
}
