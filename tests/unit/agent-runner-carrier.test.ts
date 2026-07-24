// Sharded from tests/unit/agent-runner.test.ts (Phase 40 / D70 change C4).
// Test bodies are byte-identical to the originals; only the file boundary and
// the shared-helper import changed. Same describe name preserves test identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { FAKE_PI_COMPLETION_TIMEOUT_MS, expectRejects, initGitWorktree, spec, withTempDir, writeFakePi, writeSpec } from '../helpers/agent-runner-harness.ts';

void describe('autopilot-agent-run wrapper', () => {
  void it('rejects success status that omits audit-detected changed paths', async () => {
    await withTempDir(async (root) => {
      const worktree = join(root, 'worktree');
      await initGitWorktree(worktree);
      const unitSpec = spec(root, { cwd: worktree });
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'omitted-actual-change' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'invalid-structured-output' &&
          /success status omitted actual changed path/u.test(error.details.reason),
      );
    });
  });


  void it('accepts terminal status-tool completion when Pi stops on toolUse without a follow-up message', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'terminal-tool-use' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });


  void it('accepts Pi tool_execution_start/end framing without counting start as a status carrier', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'execution-events' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });


  void it('deduplicates repeated status carrier frames for the same tool call', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'duplicate-carrier-frame' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });


  void it('normalizes carrier tool identity from the Pi event when details omit tool_name', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'missing-details-tool-name' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });


  void it('normalizes carrier call identity from the Pi event when details omit tool_call_id', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'missing-details-tool-call-id' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });


  void it('rejects conflicting carrier tool identity inside details', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'conflicting-details-tool-name' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'invalid-structured-output' &&
          /tool_name mismatch/u.test(error.details.reason),
      );
    });
  });


  void it('accepts an error-marked carrier when valid status and receipt evidence join', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'error-marked-carrier' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });

});
