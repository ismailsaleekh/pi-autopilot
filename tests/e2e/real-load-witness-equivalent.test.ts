import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildAutopilotStatusToolContext,
  validateAutopilotStatusEvidence,
} from '../../src/core/forced-output/index.ts';
import {
  createAutopilotEmitStatusTool,
  loadAutopilotStatusToolContextFromEnv,
} from '../../src/internal/status-extension.ts';
import type { AutopilotStatusEntry, AutopilotUnitSpec } from '../../src/core/contracts/types.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-witness-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sha256Text(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function makeSpec(root: string): AutopilotUnitSpec {
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'autopilot-witness',
    unit_id: 'w01-implement',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Witness status emission.',
    cwd: root,
    model: 'opencode-go/kimi-k2.6',
    thinking: 'high',
    owned_paths: ['src/witness.ts'],
    read_only_paths: [],
    untouchable_paths: ['private/**'],
    context_refs: [],
    validation_commands: [],
    status_output: join(root, '.pi', 'autopilot', 'autopilot-witness', 'statuses', 'w01-implement.implement.attempt-1.json'),
    receipt_output: join(root, '.pi', 'autopilot', 'autopilot-witness', 'receipts', 'w01-implement.implement.attempt-1.receipt.json'),
    evidence_dir: join(root, '.pi', 'autopilot', 'autopilot-witness', 'evidence', 'w01-implement'),
    stop_boundary: 'Edit only src/witness.ts.',
    timeout_seconds: 3600,
    render_prompt_snapshot: true,
  };
}

function makeStatus(): AutopilotStatusEntry {
  return {
    schema_version: 'autopilot.status.v1',
    workstream: 'autopilot-witness',
    unit_id: 'w01-implement',
    role: 'implement',
    attempt: 1,
    verdict: 'DONE',
    severity: 'clean',
    summary: 'Witness status emitted.',
    changed_paths: ['src/witness.ts'],
    findings: [],
    commands: [],
    evidence_refs: [],
    report_ref: null,
    next_action: 'Witness complete.',
  };
}

void describe('real-load-witness-equivalent', () => {
  void it('loads the extension natively, registers the tool, and writes status+receipt', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const contextPath = join(root, 'context.json');
      await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

      const originalEnv = process.env['AUTOPILOT_AGENT_STATUS_CONTEXT'];
      process.env['AUTOPILOT_AGENT_STATUS_CONTEXT'] = contextPath;
      try {
        const tool = createAutopilotEmitStatusTool(
          loadAutopilotStatusToolContextFromEnv({
            AUTOPILOT_AGENT_STATUS_CONTEXT: contextPath,
          }),
        );

        if (tool.name !== 'autopilot_emit_status') {
          throw new Error(
            `expected autopilot_emit_status tool, got ${JSON.stringify(tool.name)}`,
          );
        }

        const result = await tool.execute('witness-call', makeStatus());
        if (result.details['tool_name'] !== 'autopilot_emit_status') {
          throw new Error('tool result details missing tool_name');
        }
        if (result.terminate !== true) {
          throw new Error('expected terminate: true');
        }

        const statusText = await readFile(spec.status_output, 'utf8');
        const receipt = JSON.parse(await readFile(spec.receipt_output, 'utf8')) as {
          status_sha256: string;
          tool_call_id: string;
        };
        const expectedHash = sha256Text(statusText);
        if (receipt.status_sha256 !== expectedHash) {
          throw new Error('receipt hash mismatch');
        }
        if (receipt.tool_call_id !== 'witness-call') {
          throw new Error('receipt tool_call_id mismatch');
        }

        const evidence = await validateAutopilotStatusEvidence({ unitSpec: spec });
        assert.equal(evidence.status.verdict, 'DONE');
        assert.equal(evidence.receipt.tool_call_id, 'witness-call');
      } finally {
        if (originalEnv === undefined) {
          delete process.env['AUTOPILOT_AGENT_STATUS_CONTEXT'];
        } else {
          process.env['AUTOPILOT_AGENT_STATUS_CONTEXT'] = originalEnv;
        }
      }
    });
  });

  void it('loads context from env and parses it before tool registration', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const contextPath = join(root, 'context.json');
      await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

      const loaded = loadAutopilotStatusToolContextFromEnv({
        AUTOPILOT_AGENT_STATUS_CONTEXT: contextPath,
      });
      assert.equal(loaded.unit_spec.unit_id, spec.unit_id);
      assert.equal(loaded.expected_identity_hash, context.expected_identity_hash);
    });
  });
});
