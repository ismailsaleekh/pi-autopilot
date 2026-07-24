// Sharded from tests/unit/agent-runner.test.ts (Phase 40 / D70 change C4).
// Test bodies are byte-identical to the originals; only the file boundary and
// the shared-helper import changed. Same describe name preserves test identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { readCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationChildLease, parseCoordinationEditLease, parseCoordinationObservation } from '../../src/core/coordination/contracts.ts';
import { parseAutopilotChildTerminalAcceptance } from '../../src/core/coordination/terminal-acceptance.ts';
import { FAKE_PI_COMPLETION_TIMEOUT_MS, expectRejects, spec, withTempDir, writeFakePi, writeSpec } from '../helpers/agent-runner-harness.ts';

void describe('autopilot-agent-run wrapper', () => {
  void it('rejects an error-marked carrier without matching status details', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'error-marked-carrier-missing-details' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'invalid-structured-output' &&
          /details are missing/u.test(error.details.reason),
      );
    });
  });


  void it('selects the receipt-matching carrier when a stale mismatched carrier is also present', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'stale-carrier-before-valid' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });


  void it('rejects status evidence when no carrier matches the accepted receipt', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'mismatched-only-carrier' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'invalid-structured-output' &&
          /no autopilot_emit_status carrier matched accepted receipt\/status evidence/u.test(error.details.reason) &&
          /tool_call_id mismatch/u.test(error.details.reason),
      );
    });
  });


  void it('rejects assistant-text JSON without forced tool output', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'assistant-json-only' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'missing-structured-output',
      );
    });
  });


  void it('rejects invalid status artifacts even when a fake receipt exists', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'invalid-status' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'invalid-structured-output',
      );
    });
  });


  void it('classifies BLOCKED or NEEDS_FIX valid statuses as non-success', async () => {
    for (const scenario of ['blocked-status', 'needs-fix-status']) {
      await withTempDir(async (root) => {
        const unitSpec = scenario === 'needs-fix-status'
          ? spec(root, {
              role: 'validate',
              template: 'validate',
              owned_paths: [],
              validation_commands: ['true'],
              unit_id: 'u01-validate',
              status_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses', 'u01-validate.validate.attempt-1.json'),
              receipt_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'receipts', 'u01-validate.validate.attempt-1.receipt.json'),
              evidence_dir: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'evidence', 'u01-validate'),
            })
          : spec(root);
        const specPath = await writeSpec(root, unitSpec);
        const fakePi = await writeFakePi(root);
        let terminalError: AutopilotAgentRunError | null = null;
        await expectRejects(
          () =>
            runAutopilotAgentFromSpecPath(specPath, {
              piExecutable: fakePi,
              env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: scenario },
              timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
            }),
          (error: unknown) => {
            if (error instanceof AutopilotAgentRunError) terminalError = error;
            return error instanceof AutopilotAgentRunError && error.failureClass === 'status-non-success';
          },
        );
        if (terminalError === null) throw new Error('status-non-success did not expose its typed terminal error');
        const acceptedError = terminalError as AutopilotAgentRunError;
        const acceptancePath = acceptedError.details.terminalAcceptanceOutput;
        assert.equal(typeof acceptancePath, 'string');
        const acceptance = parseAutopilotChildTerminalAcceptance(JSON.parse(await readFile(acceptancePath ?? '', 'utf8')) as unknown);
        assert.equal(acceptance.verdict, scenario === 'blocked-status' ? 'BLOCKED' : 'NEEDS_FIX');
        assert.equal(acceptance.transport_result, 'accepted');
        const contextPath = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        if (contextPath === undefined) throw new Error('missing coordinator test session context');
        const session = await readCoordinatorSessionContext(contextPath);
        const coordinatorStatus = await new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: session.state_root } }).query('status', session.repo_id, session.workstream_run);
        const children = (coordinatorStatus.payload['child_leases'] as readonly unknown[]).map(parseCoordinationChildLease);
        const child = children.find((candidate) => candidate.owner.unit_id === unitSpec.unit_id && candidate.owner.attempt === unitSpec.attempt);
        assert.equal(child?.status, 'terminal');
        assert.equal(child?.terminal_evidence?.sha256, acceptedError.details.terminalAcceptanceSha256);
        const observations = (coordinatorStatus.payload['observations'] as readonly unknown[]).map(parseCoordinationObservation).filter((entry) => entry.owner.unit_id === unitSpec.unit_id && entry.owner.attempt === unitSpec.attempt);
        assert.equal(observations.every((entry) => entry.execution_state === 'released'), true);
        const editLeases = (coordinatorStatus.payload['edit_leases'] as readonly unknown[]).map(parseCoordinationEditLease).filter((entry) => entry.owner.unit_id === unitSpec.unit_id && entry.owner.attempt === unitSpec.attempt);
        assert.equal(editLeases.length, 0, 'clean terminal non-success must not retain edit authority');
      });
    }
  });

});
