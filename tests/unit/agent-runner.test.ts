// Sharded from tests/unit/agent-runner.test.ts (Phase 40 / D70 change C4).
// Test bodies are byte-identical to the originals; only the file boundary and
// the shared-helper import changed. Same describe name preserves test identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { readCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationUnitAttempt } from '../../src/core/coordination/contracts.ts';
import { authorityArtifactPath, parseAutopilotAuthority } from '../../src/core/authority.ts';
import { FAKE_PI_COMPLETION_TIMEOUT_MS, expectRejects, git, runCli, spec, withTempDir, writeFakePi, writeSpec } from '../helpers/agent-runner-harness.ts';
import type { FakeReceipt } from '../helpers/agent-runner-harness.ts';

void describe('autopilot-agent-run wrapper', () => {
  void it('dry-runs by validating the spec and rendering a prompt without launching Pi', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const result = await runAutopilotAgentFromSpecPath(specPath, { dryRun: true });
      assert.equal(result.status, 'dry-run');
      assert.equal(result.statusEntry, null);
      const promptSnapshotPath = result.promptSnapshotPath;
      if (promptSnapshotPath === null) throw new Error('expected prompt snapshot path');
      const prompt = await readFile(promptSnapshotPath, 'utf8');
      assert.match(prompt, /autopilot_emit_status/u);
      assert.match(prompt, /Assistant-text JSON/u);
    });
  });


  void it('rejects model or thinking deviations from the fixed role roster before launch', async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, 'worktree'), { recursive: true });
      for (const [index, overrides] of [
        { model: 'openai-codex/gpt-5.6-sol' },
        { model: 'anthropic/claude-opus-4-8' },
        { thinking: 'xhigh' as const },
      ].entries()) {
        const unitId = `roster-mismatch-${String(index)}`;
        const unitSpec = spec(root, {
          unit_id: unitId,
          ...overrides,
          status_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses', `${unitId}.implement.attempt-1.json`),
          receipt_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'receipts', `${unitId}.implement.attempt-1.receipt.json`),
          evidence_dir: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'evidence', unitId),
        });
        const specPath = await writeSpec(root, unitSpec);
        await expectRejects(
          () => runAutopilotAgentFromSpecPath(specPath, { dryRun: true }),
          (error: unknown) =>
            error instanceof AutopilotAgentRunError &&
            error.failureClass === 'spec-invalid' &&
            /implement role requires fixed roster/u.test(error.details.reason),
        );
      }
    });
  });


  void it('CLI dry-run prints terse stdout without prompt body', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const result = runCli(['--dry-run', specPath]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /^autopilot-agent-run dry-run unit=u01-implement role=implement /u);
      assert.equal(result.stdout.trim().split('\n').length, 1);
      assert.equal(/Forced final status/u.test(result.stdout), false);
    });
  });


  void it('accepts a fake Pi run only when status, receipt, hash, identity, and tool carrier join', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'success' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
      assert.equal(typeof result.executionCommitSha, 'string');
      if (result.executionCommitOutput === null) throw new Error('expected execution-commit evidence');
      const executionCommit = JSON.parse(await readFile(result.executionCommitOutput, 'utf8')) as { schema_version?: string; edited_claimed_paths?: string[] };
      assert.equal(executionCommit.schema_version, 'autopilot.execution_commit.v1');
      assert.deepEqual(executionCommit.edited_claimed_paths, ['src/smoke.ts']);
      const authorityPath = authorityArtifactPath(dirname(dirname(unitSpec.status_output)), { unit_id: unitSpec.unit_id, role: unitSpec.role, attempt: unitSpec.attempt });
      const authority = parseAutopilotAuthority(JSON.parse(await readFile(authorityPath, 'utf8')) as unknown);
      assert.deepEqual(authority.edit_intentions.map((entry) => entry.path), ['src/smoke.ts']);
      assert.deepEqual(authority.observations, []);
      const receipt = JSON.parse(await readFile(unitSpec.receipt_output, 'utf8')) as FakeReceipt;
      assert.equal(receipt.tool_call_id, 'call-autopilot-fake-1');
      const contextPath = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
      if (contextPath === undefined) throw new Error('runner coordinator context path missing');
      const context = await readCoordinatorSessionContext(contextPath);
      const coordinationStatus = await new CoordinatorClient({ env: process.env, autoStart: false }).query('status', context.repo_id, context.workstream_run);
      const attempts = coordinationStatus.payload['unit_attempts'];
      if (!Array.isArray(attempts)) throw new Error('runner status unit_attempts is not an array');
      const durableAttempt = attempts.map(parseCoordinationUnitAttempt).find((attempt) => attempt.owner.unit_id === unitSpec.unit_id);
      assert.equal(durableAttempt?.state, 'transport-complete');
      assert.equal(durableAttempt?.checkpoint_ordinal, 1);
    });
  });


  void it('accepts a child-created git commit inside the registered worktree as execution evidence', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'child-commit' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.auditClassification, 'clean');
      if (result.executionCommitOutput === null) throw new Error('expected child commit evidence');
      const executionCommit = JSON.parse(await readFile(result.executionCommitOutput, 'utf8')) as {
        readonly commit_origin?: string;
        readonly commit_shas?: readonly string[];
        readonly edited_claimed_paths?: readonly string[];
      };
      assert.equal(executionCommit.commit_origin, 'child');
      assert.deepEqual(executionCommit.edited_claimed_paths, ['src/smoke.ts']);
      assert.equal((executionCommit.commit_shas ?? []).length, 1);
    });
  });


  void it('accepts fake Pi source-changing runs with more than the old 120 changed-path cap', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root, {
        owned_paths: ['src/generated'],
        stop_boundary: 'Edit only generated source files.',
      });
      const specPath = await writeSpec(root, unitSpec);
      git(unitSpec.cwd, ['rm', '-f', 'src/generated']);
      await mkdir(join(unitSpec.cwd, 'src', 'generated'), { recursive: true });
      await writeFile(join(unitSpec.cwd, 'src', 'generated', '.keep'), 'generated baseline\n', 'utf8');
      git(unitSpec.cwd, ['add', '.']);
      git(unitSpec.cwd, ['commit', '-m', 'generated directory baseline']);

      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'many-changed-paths' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });

      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.changed_paths.length, 121);
      assert.equal(result.auditClassification, 'clean');
      if (result.executionCommitOutput === null) throw new Error('expected execution-commit evidence');
      const executionCommit = JSON.parse(await readFile(result.executionCommitOutput, 'utf8')) as { edited_claimed_paths?: string[] };
      assert.equal(executionCommit.edited_claimed_paths?.length, 121);
    });
  });

});
