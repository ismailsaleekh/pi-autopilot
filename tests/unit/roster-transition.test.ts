import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  authorizeExistingRunRosterTransitionInput,
  buildExistingRunRosterTransitionProposal,
  commitApprovedExistingRunRosterTransition,
  consumeCommittedExistingRunRosterTransition,
  listCommittedExistingRunRosterTransitions,
  resolveCommittedExistingRunRosterTransitionChain,
  type AutopilotSavedRosterRefV1,
  type ExistingRunRosterTransitionRunRef,
} from '../../src/core/roster/transition.ts';
import { autopilotRosterContractCanonicalJson, parseAutopilotRosterContractJson } from '../../src/core/roster/contracts.ts';

const NOW = '2026-07-23T00:00:00.000Z';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const root = await realpath(tmpdir());
  const dir = await mkdtemp(join(root, 'roster-transition-'));
  try {
    await chmod(dir, 0o700);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ref(label: 'from' | 'to'): AutopilotSavedRosterRefV1 {
  const a = label === 'from' ? 'a' : 'b';
  const c = label === 'from' ? 'c' : 'd';
  return {
    roster_id: `${label}-roster`,
    roster_revision: 1,
    roster_sha256: `sha256:${a.repeat(64)}`,
    assignment_set_sha256: `sha256:${c.repeat(64)}`,
    path: `/authority/rosters/${label}-roster/revision-1.json`,
  };
}

function runRef(dir: string): ExistingRunRosterTransitionRunRef {
  return {
    repo_id: 'repo-transition-test',
    workstream: 'demo',
    workstream_run: 'demo-20260723t000000z-abc123',
    main_worktree_path: join(dir, 'main'),
    runtime_root: join(dir, 'main', '.pi', 'autopilot', 'demo'),
    source_repo: join(dir, 'project'),
  };
}

function proposal(dir: string, stateRoot = join(dir, 'state')) {
  return buildExistingRunRosterTransitionProposal({
    stateRoot,
    run: runRef(dir),
    from_roster: ref('from'),
    to_roster: ref('to'),
    reason: 'unit test explicit transition',
    approved_at: NOW,
  });
}

void describe('W5 existing-run roster transition service', () => {
  void it('commits create-only canonical transition bytes, reads back, lists history, and consumes successor attempt authority', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const prepared = proposal(dir, stateRoot);
      const authorized = authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: prepared.approval_phrase });
      assert.equal(authorized.ok, true);
      assert.notEqual(authorized.approval, null);
      if (authorized.approval === null) throw new Error('missing approval');

      const committed = await commitApprovedExistingRunRosterTransition({ stateRoot, run: runRef(dir), proposal: prepared, approval: authorized.approval, expected_active_run: runRef(dir) });
      assert.equal(committed.ok, true);
      assert.equal(committed.status, 'committed');
      assert.equal(committed.write_count, 1);
      assert.deepEqual(committed.diagnostics, []);
      assert.equal(committed.successor_attempt_authority?.creates_new_attempts, true);
      assert.equal(committed.successor_attempt_authority?.invalidates_prior_validation, true);
      assert.equal(committed.successor_attempt_authority?.requires_fresh_independent_validation_before_closure, true);
      assert.equal(existsSync(committed.transition_path), true);

      const bytes = await readFile(committed.transition_path);
      assert.equal(Buffer.from(bytes).toString('utf8'), autopilotRosterContractCanonicalJson(prepared.transition));
      const parsed = parseAutopilotRosterContractJson('autopilot.roster_transition.v1', Buffer.from(bytes).toString('utf8'));
      assert.equal(parsed.transition_sha256, prepared.transition.transition_sha256);

      const listed = await listCommittedExistingRunRosterTransitions({ stateRoot, repo_id: runRef(dir).repo_id, workstream_run: runRef(dir).workstream_run });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.transition.transition_sha256, prepared.transition.transition_sha256);

      const consumed = await consumeCommittedExistingRunRosterTransition({ stateRoot, run: runRef(dir), from_roster: ref('from'), to_roster: ref('to') });
      assert.equal(consumed.ok, true);
      assert.equal(consumed.transition?.transition_sha256, prepared.transition.transition_sha256);
      assert.equal(consumed.successor_attempt_authority?.preserves_external_selection, true);

      const replay = await commitApprovedExistingRunRosterTransition({ stateRoot, run: runRef(dir), proposal: prepared, approval: authorized.approval, expected_active_run: runRef(dir) });
      assert.equal(replay.ok, true);
      assert.equal(replay.status, 'inspected');
      assert.equal(replay.idempotent_replay, true);
      assert.equal(replay.write_count, 0);
    });
  });

  void it('rejects forged/non-user approval and foreign active-run authority without writing', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const prepared = proposal(dir, stateRoot);
      const extensionAttempt = authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'extension', text: prepared.approval_phrase });
      assert.equal(extensionAttempt.ok, false);

      const userApproval = authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: prepared.approval_phrase });
      if (userApproval.approval === null) throw new Error('missing approval');
      const forged = { ...userApproval.approval, approval_token: 'transition-approval-forged' };
      const forgedCommit = await commitApprovedExistingRunRosterTransition({ stateRoot, run: runRef(dir), proposal: prepared, approval: forged, expected_active_run: runRef(dir) });
      assert.equal(forgedCommit.ok, false);
      assert.equal(forgedCommit.write_count, 0);
      assert.equal(existsSync(forgedCommit.transition_path), false);

      const foreign = await commitApprovedExistingRunRosterTransition({
        stateRoot,
        run: runRef(dir),
        proposal: prepared,
        approval: userApproval.approval,
        expected_active_run: { ...runRef(dir), workstream_run: 'foreign-20260723t000000z-abc123' },
      });
      assert.equal(foreign.ok, false);
      assert.equal(foreign.write_count, 0);
      assert.equal(existsSync(foreign.transition_path), false);
    });
  });

  void it('fails closed on create-only collisions and state-root symlink aliases', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const prepared = proposal(dir, stateRoot);
      const approval = authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: prepared.approval_phrase }).approval;
      if (approval === null) throw new Error('missing approval');

      await mkdir(dirname(prepared.transition_path), { recursive: true, mode: 0o700 });
      await writeFile(prepared.transition_path, '{"forged":true}\n', { mode: 0o600 });
      await chmod(prepared.transition_path, 0o600);
      const collision = await commitApprovedExistingRunRosterTransition({ stateRoot, run: runRef(dir), proposal: prepared, approval, expected_active_run: runRef(dir) });
      assert.equal(collision.ok, false);
      assert.equal(collision.status, 'blocked');
      assert.deepEqual(collision.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_CREATE_ONLY_CONFLICT']);
      assert.equal(Buffer.from(await readFile(prepared.transition_path)).toString('utf8'), '{"forged":true}\n');

      const realRoot = join(dir, 'real-state');
      const linkRoot = join(dir, 'state-link');
      await mkdir(realRoot, { recursive: true, mode: 0o700 });
      await symlink(realRoot, linkRoot, 'dir');
      const linked = proposal(dir, linkRoot);
      const linkedApproval = authorizeExistingRunRosterTransitionInput({ proposal: linked, source: 'user', text: linked.approval_phrase }).approval;
      if (linkedApproval === null) throw new Error('missing linked approval');
      const symlinked = await commitApprovedExistingRunRosterTransition({ stateRoot: linkRoot, run: runRef(dir), proposal: linked, approval: linkedApproval, expected_active_run: runRef(dir) });
      assert.equal(symlinked.ok, false);
      assert.equal(symlinked.write_count, 0);
      assert.ok(symlinked.diagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_STORAGE_AUTHORITY_UNSAFE' || diagnostic.code === 'ROSTER_READBACK_MISMATCH'));
    });
  });

  void it('uses exact approval bytes and full-strength transition ids', async () => {
    await withTempDir(async (dir) => {
      const prepared = proposal(dir, join(dir, 'state'));
      assert.match(prepared.transition.transition_id, /^transition-[a-f0-9]{64}$/u);
      assert.equal(authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: ` ${prepared.approval_phrase}` }).ok, false);
      assert.equal(authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: `${prepared.approval_phrase}\n` }).ok, false);
      assert.equal(authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'extension', text: prepared.approval_phrase }).ok, false);
      assert.equal(authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: prepared.approval_phrase }).ok, true);
    });
  });

  void it('fails consumption when the byte-identical runtime transition mirror is missing', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const prepared = proposal(dir, stateRoot);
      const approval = authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: prepared.approval_phrase }).approval;
      if (approval === null) throw new Error('missing approval');
      const committed = await commitApprovedExistingRunRosterTransition({ stateRoot, run: runRef(dir), proposal: prepared, approval, expected_active_run: runRef(dir) });
      assert.equal(committed.ok, true);
      await unlink(committed.runtime_transition_path);
      const consumed = await consumeCommittedExistingRunRosterTransition({ stateRoot, run: runRef(dir), from_roster: ref('from'), to_roster: ref('to') });
      assert.equal(consumed.ok, false);
      assert.equal(consumed.status, 'failed');
      assert.ok(consumed.diagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_READBACK_MISMATCH'));
    });
  });

  void it('reports the external authority write when runtime mirror publication fails', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const prepared = proposal(dir, stateRoot);
      const approval = authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: prepared.approval_phrase }).approval;
      if (approval === null) throw new Error('missing approval');
      let externalPublished = false;
      const failed = await commitApprovedExistingRunRosterTransition({
        stateRoot,
        run: runRef(dir),
        proposal: prepared,
        approval,
        expected_active_run: runRef(dir),
        hooks: { onTransactionStage: (event) => {
          if (event.path === prepared.transition_path && event.stage === 'after-temp-unlink') externalPublished = true;
          if (externalPublished && event.path !== prepared.transition_path && event.stage === 'before-link') throw new Error('simulated runtime mirror persistence failure');
        } },
      });
      assert.equal(failed.ok, false);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.write_count, 1);
      assert.deepEqual(failed.files_touched, [prepared.transition_display_path]);
      assert.equal(existsSync(prepared.transition_path), true);
      assert.equal(existsSync(failed.runtime_transition_path), false);
    });
  });

  void it('rejects forked transition history instead of picking latest by mtime', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const first = proposal(dir, stateRoot);
      const approval = authorizeExistingRunRosterTransitionInput({ proposal: first, source: 'user', text: first.approval_phrase }).approval;
      if (approval === null) throw new Error('missing approval');
      assert.equal((await commitApprovedExistingRunRosterTransition({ stateRoot, run: runRef(dir), proposal: first, approval, expected_active_run: runRef(dir) })).ok, true);
      const forkTarget: AutopilotSavedRosterRefV1 = { ...ref('to'), roster_id: 'fork-roster', roster_sha256: `sha256:${'e'.repeat(64)}`, assignment_set_sha256: `sha256:${'f'.repeat(64)}`, path: '/authority/rosters/fork-roster/revision-1.json' };
      const fork = buildExistingRunRosterTransitionProposal({ stateRoot, run: runRef(dir), from_roster: ref('from'), to_roster: forkTarget, reason: 'fork attempt', approved_at: NOW });
      const forkApproval = authorizeExistingRunRosterTransitionInput({ proposal: fork, source: 'user', text: fork.approval_phrase }).approval;
      if (forkApproval === null) throw new Error('missing fork approval');
      assert.equal((await commitApprovedExistingRunRosterTransition({ stateRoot, run: runRef(dir), proposal: fork, approval: forkApproval, expected_active_run: runRef(dir) })).ok, true);
      const chain = await resolveCommittedExistingRunRosterTransitionChain({ stateRoot, run: runRef(dir), initial_from_roster: ref('from') });
      assert.equal(chain.ok, false);
      assert.equal(chain.status, 'blocked');
    });
  });

  void it('recovers a post-link partial publication only by exact replay', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const prepared = proposal(dir, stateRoot);
      const approval = authorizeExistingRunRosterTransitionInput({ proposal: prepared, source: 'user', text: prepared.approval_phrase }).approval;
      if (approval === null) throw new Error('missing approval');
      let injected = false;
      const interrupted = await commitApprovedExistingRunRosterTransition({
        stateRoot,
        run: runRef(dir),
        proposal: prepared,
        approval,
        expected_active_run: runRef(dir),
        hooks: { onTransactionStage: (event) => { if (!injected && event.stage === 'after-link') { injected = true; throw new Error('simulated response loss'); } } },
      });
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.status, 'failed');

      const replay = await commitApprovedExistingRunRosterTransition({ stateRoot, run: runRef(dir), proposal: prepared, approval, expected_active_run: runRef(dir) });
      assert.equal(replay.ok, true);
      assert.equal(replay.status, 'committed');
      assert.equal(replay.idempotent_replay, false);
      assert.equal(replay.write_count, 1);
      assert.equal(existsSync(replay.runtime_transition_path), true);
    });
  });
});
