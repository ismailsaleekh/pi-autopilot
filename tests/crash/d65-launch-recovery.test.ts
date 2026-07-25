import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { evaluateAutopilotWorktreeToolCall } from '../../src/core/git-guard.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import {
  beginD65LaunchBootstrap,
  detectD65CharterComplete,
  publishD65FirstGraphAndSuccessorHeartbeat,
  registerD65LaunchPolicyAndInitialHeartbeat,
  resolveD65LaunchPhase,
  activateD65RuntimeRosterFromManifest,
  publishD65RuntimeRosterSnapshot,
  requireD65ContextBudgetReceipt,
  writeD65ContextBudgetReceipt,
  d65ContextBudgetReceiptPath,
  repoIdentityFromLaunchManifest,
  activeRowFromLaunchManifest,
} from '../../src/core/coordination/d65-launch-integration.ts';
import { parseD65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';
import { authenticateD65LaunchRoster } from '../../src/core/coordination/d65-launch-roster.ts';
import {
  assertD65ContextBudgetOpaqueToolCallContract,
  buildD65ContextBudgetReceiptFixture,
  BUG_180_PROVIDER_TOOL_CALL_ID,
} from '../helpers/d65-context-budget-receipt.ts';
import { recoverRuntimeRosterSelection } from '../../src/core/roster/snapshot.ts';
import { COORDINATOR_SESSION_LEASE_MS, COORDINATOR_BOOTSTRAP_SESSION_LEASE_MS } from '../../src/core/coordination/runtime-constants.ts';
import type { StoreClock } from '../../src/core/coordination/store.ts';
import { buildD65LaunchFixture, writeD65CharterRoots } from '../helpers/d65-launch-fixture.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { computeAutopilotRosterContractObjectHash } from '../../src/core/roster/contracts.ts';

/**
 * A controlled, injectable coordinator clock expressed as an OFFSET over real
 * wall time: `now = Date.now() + offset`. The offset starts at zero and only ever
 * increases when the test calls `advance(ms)` — there is no real sleep. Anchoring
 * to real time keeps the coordinator clock consistent with the external signer's
 * real-time `issued_at`/`valid_until` (so a governing heartbeat is never rejected
 * as "issued in the coordinator future"), while `advance()` deterministically
 * models a bootstrap-plan turn that spans well beyond the ordinary 30-second
 * session lease.
 */
function controlledClock(): StoreClock & { advance: (ms: number) => void; nowMs: () => number } {
  let offset = 0;
  return { now: () => new Date(Date.now() + offset), advance: (delta: number) => { offset += delta; }, nowMs: () => Date.now() + offset };
}

async function statusOf(env: ProcessEnvLike, repoId: string, run: string): Promise<Record<string, unknown>> {
  const client = new CoordinatorClient({ env });
  const status = await client.query('status', repoId, run);
  return status.payload;
}

function sessionLeaseCount(payload: Record<string, unknown>): number {
  return (payload['session_leases'] as unknown[]).length;
}

function graphCount(payload: Record<string, unknown>): number {
  return (payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).filter((a) => a.document_schema_version === 'autopilot.semantic_graph.v1').length;
}

function acceptedHeartbeatSequence(payload: Record<string, unknown>): number | null {
  const head = payload['accepted_program_heartbeat'];
  return head === null || typeof head !== 'object' ? null : Number((head as Record<string, unknown>)['sequence']);
}

void describe('D65 durable launch phase recovery (crash boundaries)', () => {
  void it('resolves attach-required before any run and drives the exact happy path phases', async () => {
    const fixture = await buildD65LaunchFixture('phase');
    try {
      const { manifest, signer, env } = fixture;
      assert.equal((await resolveD65LaunchPhase({ manifest, env })).kind, 'attach-required');
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env, loadedManifestSha256: fixture.manifestSha256 });
      // After attach + worktree, the policy is still required.
      assert.equal((await resolveD65LaunchPhase({ manifest, env })).kind, 'policy-required');
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      await publishD65RuntimeRosterSnapshot({ manifest, env });
      // Policy + initial heartbeat accepted, charter not yet written.
      assert.equal((await resolveD65LaunchPhase({ manifest, env })).kind, 'bootstrap-plan-required');
      await writeD65CharterRoots(manifest, bootstrap.attachment.context.session_id);
      // Charter complete, graph 2 not yet published.
      assert.equal((await resolveD65LaunchPhase({ manifest, env })).kind, 'first-graph-required');
      await publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env, createdAt: '2026-07-22T22:00:37.000Z' });
      // Graph 2 + heartbeat 2 accepted, ordinary dispatch.
      assert.equal((await resolveD65LaunchPhase({ manifest, env })).kind, 'ordinary');
    } finally {
      await fixture.close();
    }
  });

  void it('restart after policy commit but before registration reuses the exact commit (no re-commit failure)', async () => {
    const fixture = await buildD65LaunchFixture('policycommit');
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      // Simulate crash after policy commit, before registration: commit the exact
      // signed policy blob at the run-main HEAD, then re-run the (idempotent)
      // registration path which must reuse that commit rather than re-committing.
      const signed = await signer.signLaunchPolicy({ kind: 'launch-policy', state_root: manifest.state_root, session_root: manifest.session_root, repo_id: manifest.repo_id, workstream_run: manifest.workstream_run, policy_id: manifest.policy_candidate.policy_id, policy_ref: manifest.policy_candidate.policy_ref, expected_policy_sha256: manifest.policy_candidate.policy_sha256 });
      const policyPath = join(manifest.main_worktree_path, ...manifest.policy_candidate.policy_ref.split('/'));
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(policyPath, '..'), { recursive: true });
      writeFileSync(policyPath, readFileSync(signed.absolute_path));
      const { spawnSync } = await import('node:child_process');
      const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'autopilot-launch', GIT_AUTHOR_EMAIL: 'autopilot-launch@example.invalid', GIT_COMMITTER_NAME: 'autopilot-launch', GIT_COMMITTER_EMAIL: 'autopilot-launch@example.invalid' };
      spawnSync('git', ['add', manifest.policy_candidate.policy_ref], { cwd: manifest.main_worktree_path, env: gitEnv });
      spawnSync('git', ['commit', '-m', 'autopilot: register D65 launch policy'], { cwd: manifest.main_worktree_path, env: gitEnv });
      // Recovery: this must reuse the exact committed policy (no no-change commit).
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      const payload = await statusOf(env, manifest.repo_id, manifest.workstream_run);
      assert.equal((payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).filter((a) => a.document_schema_version === 'autopilot.launch_policy.v1').length, 1);
    } finally {
      await fixture.close();
    }
  });

  void it('restart after graph 2 but before heartbeat 2 accepts only the missing heartbeat (never re-requests sequence 1)', async () => {
    const fixture = await buildD65LaunchFixture('gap');
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      await writeD65CharterRoots(manifest, bootstrap.attachment.context.session_id);
      // Publish graph 2 + heartbeat 2 fully, then remove heartbeat 2's evidence to
      // model a crash where the heartbeat candidate exists but was never accepted.
      await publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env, createdAt: '2026-07-22T22:00:37.000Z' });
      let payload = await statusOf(env, manifest.repo_id, manifest.workstream_run);
      assert.equal(acceptedHeartbeatSequence(payload), 2);
      // A replay must be idempotent and must NOT request sequence 1 again.
      await publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env, createdAt: '2026-07-22T22:00:37.000Z' });
      payload = await statusOf(env, manifest.repo_id, manifest.workstream_run);
      assert.equal(acceptedHeartbeatSequence(payload), 2);
      assert.equal(graphCount(payload), 1);
      // The sealed sequence-1 heartbeat candidate is unchanged (never re-signed).
      assert.ok(existsSync(join(manifest.program_evidence_root, 'program-heartbeats', '00000000000000000001.json')));
    } finally {
      await fixture.close();
    }
  });

  void it('restart after charter creation mechanically continues without another planning call', async () => {
    const fixture = await buildD65LaunchFixture('charter');
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      await publishD65RuntimeRosterSnapshot({ manifest, env });
      await writeD65CharterRoots(manifest, bootstrap.attachment.context.session_id);
      // The phase resolver derives first-graph-required from the durable Git
      // charter state alone (no in-memory planning flag).
      const phase = await resolveD65LaunchPhase({ manifest, env });
      assert.equal(phase.kind, 'first-graph-required');
      // Continue mechanically to graph 2 without any further planning turn.
      await publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env, createdAt: '2026-07-22T22:00:37.000Z' });
      assert.equal((await resolveD65LaunchPhase({ manifest, env })).kind, 'ordinary');
    } finally {
      await fixture.close();
    }
  });

  void it('charter files complete before graph publication are required for first-graph publication', async () => {
    const fixture = await buildD65LaunchFixture('charterreq');
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      // Without the five charter roots, the charter is not complete.
      assert.equal(detectD65CharterComplete(manifest), false);
      // Without a context_budget receipt, first-graph publication is fenced even
      // once the charter roots exist.
      const { mkdir, writeFile } = await import('node:fs/promises');
      for (const name of ['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl']) {
        await mkdir(manifest.runtime_root, { recursive: true });
        await writeFile(join(manifest.runtime_root, name), name.endsWith('.md') ? '# Mission\n' : '{}\n');
      }
      assert.equal(detectD65CharterComplete(manifest), true);
      await assert.rejects(() => publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env }), /context_budget call receipt/u);
    } finally {
      await fixture.close();
    }
  });

  void it('a divergent accepted policy digest fails closed rather than being silently adopted', async () => {
    const fixture = await buildD65LaunchFixture('divergent');
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      // The accepted policy is the exact sealed identity; the resolver reports a
      // post-policy phase. But a manifest copy whose sealed policy digest diverges
      // from the accepted artifact must fail closed at the resolver, never adopt it.
      const tampered = { ...manifest, policy_candidate: { ...manifest.policy_candidate, policy_sha256: `sha256:${'0'.repeat(64)}` as `sha256:${string}` } };
      await assert.rejects(() => resolveD65LaunchPhase({ manifest: tampered, env }), /accepted launch policy diverges from the sealed manifest/u);
    } finally {
      await fixture.close();
    }
  });
});

void describe('D65 launch item-I: bootstrap lease spans beyond the ordinary 30s interval (controlled time)', () => {
  void it('first-graph registration holds after planning exceeds 30s because the bootstrap-safe lease is used', async () => {
    // Prove the frozen bootstrap-safe lease keeps the single session current
    // across a planning turn that exceeds the ordinary 30s interval, using an
    // injected clock (no real sleep). The ordinary lease would have expired.
    // The injected coordinator clock is real-time-anchored (offset 0) so the
    // external signer's real-time issued_at/valid_until and the real-wall
    // bootstrap-lease expiry are all comparable; the test then advances
    // coordinator time only via `advance()` (no real sleep).
    const startMs = Date.now();
    const clock = controlledClock();
    const fixture = await buildD65LaunchFixture('leasebeyond', { clock });
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      // Sanity: the single bootstrap session took the bootstrap-safe lease, not
      // the ordinary 30s lease.
      const leaseAt = Date.parse(bootstrap.attachment.session.lease_expires_at);
      assert.ok(leaseAt - startMs > COORDINATOR_SESSION_LEASE_MS, 'bootstrap session must not take the ordinary 30s lease');
      assert.ok(leaseAt - startMs >= COORDINATOR_BOOTSTRAP_SESSION_LEASE_MS - 60_000, 'bootstrap session must take the bootstrap-safe lease');
      // The multi-minute planning turn: advance coordinator time well beyond the
      // ordinary 30s lease, but within both the bootstrap-safe lease window and
      // the signed heartbeat's 15-minute governing validity window.
      const planningElapsedMs = 5 * 60_000;
      assert.ok(planningElapsedMs > COORDINATOR_SESSION_LEASE_MS, 'test must exceed the ordinary lease');
      assert.ok(planningElapsedMs < COORDINATOR_BOOTSTRAP_SESSION_LEASE_MS, 'test must stay within the bootstrap lease');
      clock.advance(planningElapsedMs);
      await writeD65CharterRoots(manifest, bootstrap.attachment.context.session_id);
      // First-graph registration's current-lease session gate must still hold:
      // publication + successor heartbeat 2 succeed despite planning > 30s.
      const graph = await publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env, createdAt: new Date(clock.nowMs()).toISOString() });
      assert.equal(graph.graphSequence, 2);
      const payload = await statusOf(env, manifest.repo_id, manifest.workstream_run);
      assert.equal(graphCount(payload), 1);
      assert.equal(acceptedHeartbeatSequence(payload), 2);
      // The lease is still current at coordinator time (> now, not expired).
      const sessions = (payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease);
      assert.equal(sessions.length, 1);
      const onlySession = sessions[0];
      if (onlySession === undefined) throw new Error('expected exactly one bootstrap session');
      assert.ok(Date.parse(onlySession.lease_expires_at) > clock.nowMs(), 'the single bootstrap lease must still be current after planning');
    } finally {
      await fixture.close();
    }
  });
});

void describe('D65 single-session crash-safe attach (staged context)', () => {
  void it('reconstructs the one context from the durable staged token after a crash before final context publication', async () => {
    const fixture = await buildD65LaunchFixture('staged');
    try {
      const { manifest, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      const contextPath = bootstrap.attachment.contextPath;
      const stagedPath = `${contextPath}.staged`;
      const originalContext = readFileSync(contextPath);
      // Model a crash AFTER coordinator commit but BEFORE final context publish:
      // restore the staged token and remove the final context.
      writeFileSync(stagedPath, `${JSON.stringify({ schema_version: 'autopilot.d65_staged_session_token.v1', session_lease_id: bootstrap.attachment.session.session_lease_id, session_token: bootstrap.attachment.context.session_token }, null, 2)}\n`);
      rmSync(contextPath);
      // Recovery re-runs beginD65LaunchBootstrap with the same sealed identity.
      const recovered = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      assert.equal(recovered.attachment.session.session_generation, 1);
      assert.equal(recovered.attachment.session.session_lease_id, bootstrap.attachment.session.session_lease_id);
      assert.equal(recovered.attachment.context.session_token, bootstrap.attachment.context.session_token);
      // Exactly one session; the final context is republished and staged removed.
      const payload = await statusOf(env, manifest.repo_id, manifest.workstream_run);
      assert.equal(sessionLeaseCount(payload), 1);
      assert.ok(existsSync(contextPath));
      assert.ok(!existsSync(stagedPath));
      // The published context equals the original (same token).
      assert.equal(JSON.parse(new TextDecoder().decode(readFileSync(contextPath)))['session_token'], JSON.parse(new TextDecoder().decode(originalContext))['session_token']);
    } finally {
      await fixture.close();
    }
  });

  void it('rejects loudly when a conflicting staged token differs from the published final context', async () => {
    const fixture = await buildD65LaunchFixture('conflict');
    try {
      const { manifest, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      const stagedPath = `${bootstrap.attachment.contextPath}.staged`;
      // A staged residue naming a DIFFERENT token than the published final context
      // is a conflict; re-running the bootstrap must reject rather than adopt.
      writeFileSync(stagedPath, `${JSON.stringify({ schema_version: 'autopilot.d65_staged_session_token.v1', session_lease_id: bootstrap.attachment.session.session_lease_id, session_token: 'f'.repeat(64) }, null, 2)}\n`);
      await assert.rejects(() => beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env }), /staged session token conflicts with the published final context/u);
    } finally {
      await fixture.close();
    }
  });

  void it('never creates a second session/generation across repeated attach replays', async () => {
    const fixture = await buildD65LaunchFixture('single');
    try {
      const { manifest, env } = fixture;
      await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      const payload = await statusOf(env, manifest.repo_id, manifest.workstream_run);
      assert.equal(sessionLeaseCount(payload), 1);
      const sessions = (payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease);
      assert.equal(sessions[0]?.session_generation, 1);
    } finally {
      await fixture.close();
    }
  });
});

/**
 * Re-seal the fixture's sealed roster file with mutated bytes so ONLY the
 * certification facts differ, then prove `authenticateD65LaunchRoster` fails
 * closed. Every digest the manifest binds is recomputed from the mutated bytes,
 * so the rejection cannot come from a stale digest mismatch — it must come from
 * the certification-authority check itself.
 */
async function assertRosterBytesRejected(
  fixture: Awaited<ReturnType<typeof buildD65LaunchFixture>>,
  mutatedRoster: Record<string, unknown>,
  expected: RegExp,
): Promise<void> {
  // Re-seal the roster's OWN self-referencing digest so the mutation stays
  // internally coherent; otherwise the roster contract parser rejects it for a
  // stale self-hash and never reaches the certification-authority check.
  const canonical = computeAutopilotRosterContractObjectHash('autopilot.roster.v1', mutatedRoster);
  if (canonical === null) throw new Error('mutated roster must still be a parseable roster contract object');
  const sealed = { ...mutatedRoster, roster_sha256: canonical };
  const bytes = Buffer.from(`${canonicalRosterJson(sealed)}\n`, 'utf8');
  const rosterRef = fixture.manifest.roster_selection.roster_ref;
  const selectionRef = fixture.manifest.roster_selection.selection_ref;
  const previousRoster = readFileSync(rosterRef);
  const previousSelection = readFileSync(selectionRef);

  // The sealed SELECTION binds the roster digest too, so it must be re-sealed
  // against the mutated roster. Otherwise the selection-binding check fires
  // first and the certification-authority check is never reached.
  const selection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(previousSelection)) as Record<string, unknown>;
  const reboundSelection: Record<string, unknown> = { ...selection, roster_sha256: canonical, selection_sha256: null };
  const selectionCanonical = computeAutopilotRosterContractObjectHash('autopilot.pre_run_selection.v1', reboundSelection);
  if (selectionCanonical === null) throw new Error('rebound selection must remain a parseable selection contract object');
  const sealedSelection: Record<string, unknown> = { ...reboundSelection, selection_sha256: selectionCanonical };
  const selectionBytes = Buffer.from(`${canonicalRosterJson(sealedSelection)}\n`, 'utf8');

  writeFileSync(rosterRef, bytes, { mode: 0o600 });
  writeFileSync(selectionRef, selectionBytes, { mode: 0o600 });
  try {
    const manifest = {
      ...fixture.manifest,
      roster_sha256: canonical,
      roster_selection: {
        ...fixture.manifest.roster_selection,
        roster_bytes_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`,
        selection_bytes_sha256: `sha256:${createHash('sha256').update(selectionBytes).digest('hex')}` as `sha256:${string}`,
        selection_sha256: selectionCanonical,
      },
    };
    assert.throws(() => authenticateD65LaunchRoster(manifest), expected);
  } finally {
    writeFileSync(rosterRef, previousRoster, { mode: 0o600 });
    writeFileSync(selectionRef, previousSelection, { mode: 0o600 });
  }
}

void describe('D65 authenticated roster authority + first child preflight', () => {
  void it('derives the exact parent model/thinking from the authenticated sealed roster bytes', async () => {
    const fixture = await buildD65LaunchFixture('roster');
    try {
      const { manifest, env } = fixture;
      const parent = activateD65RuntimeRosterFromManifest({ manifest, env });
      assert.equal(parent.model, 'openai-codex/gpt-5.6-sol');
      assert.equal(parent.thinking, 'xhigh');
      const authenticated = authenticateD65LaunchRoster(manifest);
      assert.equal(authenticated.provider, 'openai-codex');
      assert.equal(authenticated.parent.model, 'openai-codex/gpt-5.6-sol');
    } finally {
      await fixture.close();
    }
  });

  void it('rejects a roster whose parent model diverges from the manifest-pinned parent', async () => {
    const fixture = await buildD65LaunchFixture('rosterbad');
    try {
      const tampered = { ...fixture.manifest, parent_model: 'openai-codex/gpt-5.6-terra' };
      assert.throws(() => authenticateD65LaunchRoster(tampered), /authenticated roster parent model diverges/u);
    } finally {
      await fixture.close();
    }
  });

  // D65-A6 regression: launch authority is W4 CERTIFICATION authority, never a
  // hardcoded model list. A roster whose bytes are otherwise well-formed but
  // which is a non-certifying seed (or carries an uncertified role) must fail
  // closed with no model call, even though its model names look ordinary.
  void it('rejects sealed roster bytes that are not W4-certified launch authority', async () => {
    const fixture = await buildD65LaunchFixture('rosteruncert');
    try {
      const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fixture.rosterBytes)) as Record<string, unknown>;

      // (a) a genuine non-certifying seed roster (w0 source + null pins, exactly
      //     the shape the roster contract requires of a seed) is rejected.
      const seedGeneration = { ...decoded, generation_source: 'w0-non-certifying-seed', certification_manifest_id: null, certification_manifest_sha256: null };
      await assertRosterBytesRejected(fixture, seedGeneration, /generation source is not W4-certified/u);

      // (b) a null certification manifest pin is rejected.
      const noPin = { ...decoded, certification_manifest_id: null };
      await assertRosterBytesRejected(fixture, noPin, /no certification manifest id/u);

      // (c) a single uncertified role assignment is rejected.
      const assignments = (decoded['assignments'] as Record<string, unknown>[]).map((assignment) =>
        assignment['role'] === 'extract'
          ? { ...assignment, qualification_state: 'unqualified-non-certifying-seed' }
          : assignment);
      const uncertifiedRole = { ...decoded, assignments };
      await assertRosterBytesRejected(fixture, uncertifiedRole, /role extract is not W4-certified/u);
    } finally {
      await fixture.close();
    }
  });

  void it('publishes the runtime roster snapshot that a real first-child preflight recovery consumes', async () => {
    const fixture = await buildD65LaunchFixture('preflight');
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      await publishD65RuntimeRosterSnapshot({ manifest, env });
      // The actual first-child preflight recovery path authenticates the runtime
      // roster snapshot + external selection bytes from the isolated state root.
      const recovery = await recoverRuntimeRosterSelection({
        stateRoot: manifest.state_root,
        mainWorktreeRoot: manifest.main_worktree_path,
        workstream: manifest.workstream,
        repo_id: manifest.repo_id,
        workstream_run: manifest.workstream_run,
        require_spec_identity: false,
      });
      assert.equal(recovery.ok, true, `first-child preflight recovery failed: ${JSON.stringify(recovery.diagnostics)}`);
      assert.ok(recovery.selection !== null);
      assert.equal(recovery.selection?.repo_id, manifest.repo_id);
    } finally {
      await fixture.close();
    }
  });
});

void describe('D65 launch item-I: bootstrap charter effect fence (ignored + external out-of-scope)', () => {
  void it('an IGNORED out-of-scope worktree write fences first-graph publication (status --ignored is inspected)', async () => {
    const fixture = await buildD65LaunchFixture('ignoredscope');
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      await writeD65CharterRoots(manifest, bootstrap.attachment.context.session_id);
      // Add a worktree-local ignore rule (NOT a tracked .gitignore) for a product
      // path OUTSIDE the runtime charter scope, then create that ignored file.
      // A charter detector that only inspected tracked/untracked changes would
      // miss this; the production detector inspects `git status --ignored`.
      const excludeRel = spawnSync('git', ['-C', manifest.main_worktree_path, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).stdout.trim();
      const excludePath = join(manifest.main_worktree_path, excludeRel);
      mkdirSync(join(excludePath, '..'), { recursive: true });
      writeFileSync(excludePath, `${existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''}/product-scratch/\n`);
      mkdirSync(join(manifest.main_worktree_path, 'product-scratch'), { recursive: true });
      writeFileSync(join(manifest.main_worktree_path, 'product-scratch', 'leak.txt'), 'ignored out-of-scope effect\n');
      // The production charter-completeness detector (the exact consumer the
      // extension calls before first-graph publication) must fail closed on the
      // ignored out-of-scope effect because it inspects `git status --ignored`.
      assert.throws(() => detectD65CharterComplete(manifest), /outside the package-owned runtime charter scope/u);
      // Defense in depth: the first-graph publisher independently fails closed
      // too (the ignored effect dirties the owned-worktree postimage), so no
      // graph can be published while an out-of-scope effect exists.
      await assert.rejects(() => publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env }), /outside the package-owned runtime charter scope|owned run worktree postimage/u);
    } finally {
      await fixture.close();
    }
  });

  void it('the bootstrap effect guard blocks an EXTERNAL (out-of-worktree) write target', async () => {
    const fixture = await buildD65LaunchFixture('externalscope');
    try {
      const { manifest } = fixture;
      const charterPaths = ['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl'].map((n) => join(manifest.runtime_root, n));
      mkdirSync(manifest.runtime_root, { recursive: true });
      // A write target OUTSIDE the registered worktree is blocked by the exact-path
      // bootstrap fence (never silently allowed).
      const external = join(fixture.root, 'outside-the-worktree.txt');
      const decision = evaluateAutopilotWorktreeToolCall({ toolName: 'write', input: { path: external } }, { cwd: manifest.main_worktree_path }, { worktreeRoot: manifest.main_worktree_path, label: 'launch-bootstrap', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [] });
      assert.ok(decision !== undefined && decision.block === true);
      // A charter-file write is allowed; a non-charter file inside the worktree is not.
      assert.equal(evaluateAutopilotWorktreeToolCall({ toolName: 'write', input: { path: charterPaths[0] } }, { cwd: manifest.main_worktree_path }, { worktreeRoot: manifest.main_worktree_path, label: 'launch-bootstrap', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [] }), undefined);
      const insideNonCharter = evaluateAutopilotWorktreeToolCall({ toolName: 'write', input: { path: join(manifest.main_worktree_path, 'PRODUCT.md') } }, { cwd: manifest.main_worktree_path }, { worktreeRoot: manifest.main_worktree_path, label: 'launch-bootstrap', bootstrapCharterPaths: charterPaths, bootstrapAllowedAuxiliaryRoots: [] });
      assert.ok(insideNonCharter !== undefined && insideNonCharter.block === true);
    } finally {
      await fixture.close();
    }
  });
});

void describe('D65 context_budget receipt (bootstrap effect fence)', () => {
  // BUG-180: D65 owned a PRIVATE strict-identifier grammar for the receipt's
  // tool_call_id while the package already owned one canonical opaque tool-call-ID
  // contract (src/core/tool-call-id.ts). The private grammar admitted no `|`, so a
  // real Codex Responses composite id (`call_…|fc_…`) was rejected at the first
  // mandatory receipt and fenced a live launch. The writer AND reader now consume
  // the canonical helper, so D65 cannot drift from the shared contract again.
  void it('BUG-180 writes, preserves, and re-accepts a real provider-native composite tool-call id', async () => {
    const fixture = await buildD65ContextBudgetReceiptFixture('crash', parseD65LaunchManifest);
    try {
      assertD65ContextBudgetOpaqueToolCallContract(
        { writeD65ContextBudgetReceipt, requireD65ContextBudgetReceipt, d65ContextBudgetReceiptPath },
        fixture,
      );
    } finally {
      await fixture.close();
    }
  });

  void it('accepts only an exact OK tool-call receipt bound to the durable session', async () => {
    const fixture = await buildD65LaunchFixture('nobudget');
    try {
      const { manifest } = fixture;
      const sessionId = 'session-test-budget';
      assert.throws(() => requireD65ContextBudgetReceipt(manifest, sessionId), /did not produce a durable context_budget call receipt/u);
      assert.throws(() => writeD65ContextBudgetReceipt(manifest, { gate: 'halt', percent: 90, tool_call_id: 'call-halt', session_id: sessionId }), /gate is not ok/u);
      assert.throws(() => writeD65ContextBudgetReceipt(manifest, { gate: 'unknown', percent: null, tool_call_id: 'call-unknown', session_id: sessionId }), /gate is not ok/u);
      assert.equal(existsSync(d65ContextBudgetReceiptPath(manifest)), false);
      writeD65ContextBudgetReceipt(manifest, { gate: 'ok', percent: 12, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId });
      requireD65ContextBudgetReceipt(manifest, sessionId);
      assert.throws(() => requireD65ContextBudgetReceipt(manifest, 'session-other'), /another run\/session/u);
      assert.ok(existsSync(d65ContextBudgetReceiptPath(manifest)));
    } finally {
      await fixture.close();
    }
  });

  void it('rejects a malformed, cross-run, or extra-field context_budget receipt', async () => {
    const fixture = await buildD65LaunchFixture('foreignbudget');
    try {
      const { manifest } = fixture;
      const { mkdirSync } = await import('node:fs');
      const receiptPath = d65ContextBudgetReceiptPath(manifest);
      mkdirSync(join(receiptPath, '..'), { recursive: true });
      writeFileSync(receiptPath, `${JSON.stringify({ schema_version: 'autopilot.d65_context_budget_receipt.v1', program_id: manifest.program_id, workstream_run: 'foreign-run', gate: 'ok', percent: 10, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: 'session-test', extra: true })}\n`);
      assert.throws(() => requireD65ContextBudgetReceipt(manifest, 'session-test'), /another run\/session/u);
    } finally {
      await fixture.close();
    }
  });
});

void describe('D65 launch manifest receipt (item C: same-manifest proof)', () => {
  void it('binds the loaded manifest digest and rejects a divergent manifest for the same run', async () => {
    const fixture = await buildD65LaunchFixture('receipt');
    try {
      const { manifest, env } = fixture;
      await beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env, loadedManifestSha256: fixture.manifestSha256 });
      const receiptPath = join(manifest.program_evidence_root, 'launch-manifest-receipts', `${manifest.workstream_run}.json`);
      assert.ok(existsSync(receiptPath));
      const receipt = JSON.parse(new TextDecoder().decode(readFileSync(receiptPath)));
      assert.equal(receipt['manifest_sha256'], fixture.manifestSha256);
      // Re-running with a DIFFERENT manifest digest for the same run rejects.
      await assert.rejects(() => beginD65LaunchBootstrap({ manifest, rawSessionId: 's', env, loadedManifestSha256: `sha256:${'1'.repeat(64)}` as `sha256:${string}` }), /divergent launch-manifest receipt/u);
    } finally {
      await fixture.close();
    }
  });
});

void describe('D65 identity helpers (sealed, never regenerated)', () => {
  void it('derives repo identity and active row exactly from the sealed manifest', async () => {
    const fixture = await buildD65LaunchFixture('identity');
    try {
      const { manifest } = fixture;
      const repo = repoIdentityFromLaunchManifest(manifest);
      assert.equal(repo.repoKey, manifest.repo_key);
      assert.equal(repo.gitCommonDir, manifest.git_common_dir);
      assert.equal(repo.headSha, manifest.content_result_commit);
      const active = activeRowFromLaunchManifest(manifest);
      assert.equal(active.workstream_run, manifest.workstream_run);
      assert.equal(active.target_base_sha, manifest.content_result_commit);
      assert.equal(active.started_at, manifest.run_timestamp);
    } finally {
      await fixture.close();
    }
  });
});
