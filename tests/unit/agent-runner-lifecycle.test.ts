// Sharded from tests/unit/agent-runner.test.ts (Phase 40 / D70 change C4).
// Test bodies are byte-identical to the originals; only the file boundary and
// the shared-helper import changed. Same describe name preserves test identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { readCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationChildLease, parseCoordinationUnitAttempt } from '../../src/core/coordination/contracts.ts';
import { RunReconciliationClient } from '../../src/core/coordination/reconciliation.ts';
import { proveStructuredAttemptTerminal } from '../../src/core/coordination/terminal-attempt-proof.ts';
import { FAKE_PI_COMPLETION_TIMEOUT_MS, expectRejects, spec, withTempDir, writeFakePi, writeSpec } from '../helpers/agent-runner-harness.ts';

void describe('autopilot-agent-run wrapper', () => {
  void it('repairs a historical non-success leak only from an exact parent acceptance event', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root, {
        role: 'validate', template: 'validate', owned_paths: [], validation_commands: ['true'], unit_id: 'u02-historical-validate',
        status_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses', 'u02-historical-validate.validate.attempt-1.json'),
        receipt_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'receipts', 'u02-historical-validate.validate.attempt-1.receipt.json'),
        evidence_dir: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'evidence', 'u02-historical-validate'),
      });
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () => runAutopilotAgentFromSpecPath(specPath, { piExecutable: fakePi, env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'needs-fix-mismatched-carrier' }, timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS }),
        (error: unknown) => error instanceof AutopilotAgentRunError && error.failureClass === 'invalid-structured-output',
      );
      const contextPath = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
      if (contextPath === undefined) throw new Error('missing historical repair session context');
      const session = await readCoordinatorSessionContext(contextPath);
      const client = new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: session.state_root } });
      const childStatus = async (): Promise<ReturnType<typeof parseCoordinationChildLease>> => {
        const response = await client.query('status', session.repo_id, session.workstream_run);
        const child = (response.payload['child_leases'] as readonly unknown[]).map(parseCoordinationChildLease).find((candidate) => candidate.owner.unit_id === unitSpec.unit_id);
        if (child === undefined) throw new Error('historical repair child disappeared');
        return child;
      };
      assert.equal((await childStatus()).status, 'recovery-required');
      await (await RunReconciliationClient.fromEnvironment(process.env)).reconcile('prove artifact files alone cannot repair carrier acceptance');
      assert.equal((await childStatus()).status, 'recovery-required');

      const runtimeRoot = dirname(dirname(unitSpec.status_output));
      await appendFile(join(runtimeRoot, 'events.jsonl'), `${JSON.stringify({
        schema_version: 'autopilot.event.v1', id: 1, ts: new Date(Date.now() + 1_000).toISOString(), event: 'agent_completed', workstream: unitSpec.workstream,
        unit_id: unitSpec.unit_id, role: unitSpec.role, verdict: 'NEEDS_FIX', severity: 'major-local',
        status_ref: `statuses/${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.json`,
        receipt_ref: `receipts/${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.receipt.json`, summary: 'Parent accepted the exact historical forced-output carrier.',
      })}\n`, 'utf8');
      const beforeRepair = await client.query('status', session.repo_id, session.workstream_run);
      const durableAttempt = (beforeRepair.payload['unit_attempts'] as readonly unknown[]).map(parseCoordinationUnitAttempt).find((candidate) => candidate.owner.unit_id === unitSpec.unit_id);
      if (durableAttempt === undefined) throw new Error('historical repair attempt disappeared');
      const proof = proveStructuredAttemptTerminal({ mainWorktreePath: unitSpec.cwd, runtimeRoot, repoId: session.repo_id, autopilotId: session.autopilot_id, workstream: session.workstream, workstreamRun: session.workstream_run, unitId: unitSpec.unit_id, attempt: unitSpec.attempt, childLeaseId: (await childStatus()).child_lease_id, spec: durableAttempt.spec });
      assert.equal(proof.proven, true, proof.proven ? undefined : proof.reason);
      await (await RunReconciliationClient.fromEnvironment(process.env)).reconcile('repair exact historical parent-accepted non-success');
      const repaired = await childStatus();
      assert.equal(repaired.status, 'terminal');
      assert.match(repaired.terminal_evidence?.ref ?? '', /receipts\//u);
    });
  });


  void it('includes bounded Pi result diagnostics when Pi returns an error result', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'error-result' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'pi-spawn-failed' &&
          /provider="openai-codex"/u.test(error.details.reason) &&
          /model="gpt-5\.6-terra"/u.test(error.details.reason) &&
          /last_events/u.test(error.details.reason) &&
          /fake provider failure/u.test(error.details.reason),
      );
    });
  });


  void it('classifies fake Pi child exit as pi-spawn-failed', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'exit-after-prompt' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'pi-spawn-failed',
      );
    });
  });


  void it('classifies fake Pi wall timeout as pi-spawn-failed', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'hang-after-prompt' },
            timeoutMsOverride: 80,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'pi-spawn-failed',
      );
    });
  });


  void it('rejects stale status_output before launching live Pi while dry-run can inspect completed specs', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      await mkdir(dirname(unitSpec.status_output), { recursive: true });
      await writeFile(unitSpec.status_output, '{}\n', 'utf8');
      const dryRun = await runAutopilotAgentFromSpecPath(specPath, { dryRun: true });
      assert.equal(dryRun.status, 'dry-run');
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'success' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'spec-invalid',
      );
    });
  });
});
