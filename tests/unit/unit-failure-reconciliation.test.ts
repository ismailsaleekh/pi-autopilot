import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import type { CoordinationChildLease, CoordinationWorktree, CoordinationWorktreeOperation } from '../../src/core/coordination/types.ts';
import type { ActiveAutopilotContext } from '../../src/core/parallel-runtime.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import { acceptedTerminalVerdict, latestCommittedQuarantineOperationForWorktree } from '../../src/core/unit-failure.ts';

function digest(bytes: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

void it('selects a historical aliased quarantine operation through the current canonical worktree identity', () => {
  const owner = { repo_id: 'repo-alias', autopilot_id: 'auto-alias', workstream_run: 'run-alias', unit_id: 'unit-alias', attempt: 2 } as const;
  const worktree: CoordinationWorktree = {
    schema_version: 'autopilot.coordination_worktree.v2', worktree_id: deterministicWorktreeId(owner, 'unit'), owner, kind: 'unit', canonical_path: '/tmp/unit-alias', git_common_dir: '/tmp/repo-alias/.git', branch: 'autopilot/unit-alias', state: 'quarantined', version: 4,
  };
  const historical: CoordinationWorktreeOperation = {
    schema_version: 'autopilot.worktree_operation.v2', operation_id: 'operation-historical-quarantine', worktree_id: 'migration-worktree-historical-quarantine', owner, operation_type: 'quarantine', stage: 'committed', authority_version: 3, intent_event_seq: 41,
    intent: { repo_root: '/tmp/repo-alias', worktree_path: worktree.canonical_path, git_common_dir: worktree.git_common_dir, branch: worktree.branch, reason: 'retain failed work', base_sha: null, target_sha: null, archive_ref: 'refs/autopilot/archive/unit-alias', checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [] },
    completed_steps: ['preflight-probe', 'external-action', 'postcondition-verification'], current_step: null, recovery_attempts: 0, verification_evidence: { ref: '_saga-evidence/run-alias/operation-historical-quarantine.json', sha256: `sha256:${'a'.repeat(64)}` }, error_code: null, version: 4,
  };
  assert.equal(latestCommittedQuarantineOperationForWorktree(worktree, [historical]), historical);
  assert.throws(() => latestCommittedQuarantineOperationForWorktree({ ...worktree, worktree_id: historical.worktree_id }, [historical]), /current canonical worktree projection/u);
});

void it('distinguishes successful source terminal evidence from failure recovery before quarantine reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-terminal-verdict-'));
  try {
    const main = join(root, 'main');
    const runtimeRoot = join(main, '.pi', 'autopilot', 'work');
    const ref = '.pi/autopilot/work/terminal-acceptances/unit-a.implement.attempt-1.json';
    const path = join(main, ...ref.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    const context: ActiveAutopilotContext = {
      repo: { repoKey: 'repo-1', repoRoot: root, gitCommonDir: join(root, '.git'), headSha: 'a'.repeat(40), targetBranch: 'main', originUrl: null },
      active: {
        schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: 'auto-1', workstream: 'work', workstream_run: 'run-1', repo_key: 'repo-1', source_repo: root, git_common_dir: join(root, '.git'), worktree_root: join(root, 'worktrees'), main_worktree_path: main, branch: 'autopilot/run-1', runtime_root: runtimeRoot, target_branch: 'main', target_base_sha: 'a'.repeat(40), origin_url: null, pid: process.pid, boot_id: 'boot-1', status: 'active', started_at: '2026-07-14T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-14T00:00:00.000Z', active_run_receipt_id: 'receipt-run-1',
      },
      coordinationRoot: join(root, 'coordination'), claimsPath: join(root, 'claims.json'), claimEventsPath: join(root, 'events.jsonl'),
    };
    const owner = { repo_id: 'repo-1', autopilot_id: 'auto-1', workstream_run: 'run-1', unit_id: 'unit-a', attempt: 1 } as const;
    const acceptance = (verdict: 'DONE' | 'NEEDS_FIX') => ({
      schema_version: 'autopilot.child_terminal_acceptance.v1', repo_id: owner.repo_id, autopilot_id: owner.autopilot_id, workstream: 'work', workstream_run: owner.workstream_run, unit_id: owner.unit_id, role: 'implement', attempt: owner.attempt, child_lease_id: 'child-a', verdict, transport_result: 'accepted',
      spec: { ref: '.pi/autopilot/work/unit-specs/a.json', sha256: `sha256:${'1'.repeat(64)}` }, status: { ref: '.pi/autopilot/work/statuses/a.json', sha256: `sha256:${'2'.repeat(64)}` }, receipt: { ref: '.pi/autopilot/work/receipts/a.json', sha256: `sha256:${'3'.repeat(64)}` }, audit: { ref: '.pi/autopilot/work/execution-audits/a.json', sha256: `sha256:${'4'.repeat(64)}` }, tool_call_id: 'tool-a', carrier_status_sha256: `sha256:${'2'.repeat(64)}`, audit_disposition: verdict === 'DONE' ? 'accounted-changes' : 'zero-change', created_at: '2026-07-14T00:00:00.000Z',
    });
    const writeAcceptance = async (verdict: 'DONE' | 'NEEDS_FIX'): Promise<CoordinationChildLease> => {
      const bytes = `${JSON.stringify(acceptance(verdict), null, 2)}\n`;
      await writeFile(path, bytes, 'utf8');
      return { schema_version: 'autopilot.child_lease.v1', child_lease_id: 'child-a', owner, pid: process.pid, boot_id: 'boot-1', lease_expires_at: '2099-01-01T00:00:00.000Z', status: 'terminal', terminal_evidence: { ref, sha256: digest(bytes) }, version: 2 };
    };
    assert.equal(await acceptedTerminalVerdict(context, await writeAcceptance('DONE'), 'implement'), 'DONE');
    assert.equal(await acceptedTerminalVerdict(context, await writeAcceptance('NEEDS_FIX'), 'implement'), 'NEEDS_FIX');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
