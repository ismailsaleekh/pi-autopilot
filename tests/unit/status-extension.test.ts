import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildAutopilotProviderIdentity,
  buildAutopilotStatusToolContext,
  parseAutopilotStatusToolContext,
  autopilotExpectedIdentityHash,
  expectedAutopilotStatusIdentityFromSpec,
  AutopilotForcedOutputIdentityError,
} from '../../src/core/forced-output/identity.ts';
import {
  validateAutopilotStatusEvidence,
} from '../../src/core/forced-output/status-evidence.ts';
import {
  emitAutopilotStatus,
  writeFileAtomicSync,
} from '../../src/core/forced-output/writer.ts';
import {
  loadAutopilotStatusToolContextFromEnv,
  createAutopilotEmitStatusTool,
} from '../../src/internal/status-extension.ts';
import autopilotStatusExtension from '../../src/internal/status-extension.ts';
import type { AutopilotStatusEntry, AutopilotUnitSpec } from '../../src/core/contracts/types.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-status-test-'));
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
    workstream: 'autopilot-smoke',
    unit_id: 'u01-implement',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Create the minimal smoke fixture.',
    cwd: root,
    model: 'openai-codex/gpt-5.5',
    thinking: 'high',
    owned_paths: ['src/smoke.ts'],
    read_only_paths: ['README.md'],
    untouchable_paths: ['private/**'],
    context_refs: [],
    validation_commands: [],
    status_output: join(root, '.pi', 'autopilot', 'autopilot-smoke', 'statuses', 'u01-implement.implement.attempt-1.json'),
    receipt_output: join(root, '.pi', 'autopilot', 'autopilot-smoke', 'receipts', 'u01-implement.implement.attempt-1.receipt.json'),
    evidence_dir: join(root, '.pi', 'autopilot', 'autopilot-smoke', 'evidence', 'u01-implement'),
    stop_boundary: 'Edit only src/smoke.ts.',
    timeout_seconds: 3600,
    render_prompt_snapshot: true,
  };
}

function makeStatus(): AutopilotStatusEntry {
  return {
    schema_version: 'autopilot.status.v1',
    workstream: 'autopilot-smoke',
    unit_id: 'u01-implement',
    role: 'implement',
    attempt: 1,
    verdict: 'DONE',
    severity: 'clean',
    summary: 'Implemented the smoke fixture.',
    changed_paths: ['src/smoke.ts'],
    findings: [],
    commands: [
      {
        command: 'npm test',
        status: 'passed',
        exit_code: 0,
        summary: 'Smoke test passed.',
      },
    ],
    evidence_refs: [],
    report_ref: null,
    next_action: 'Launch independent validation.',
  };
}

void describe('forced-output identity', () => {
  void it('builds provider identity for subscription provider wildcard routes', () => {
    const cases = [
      ['openai-codex/gpt-5.3-codex-spark', 'openai-codex', 'openai-codex-responses'],
      ['openai-codex/gpt-5.5', 'openai-codex', 'openai-codex-responses'],
      ['anthropic/claude-opus-4-8', 'anthropic', 'anthropic-messages'],
      ['opencode-go/kimi-k2.7-code', 'opencode-go', 'openai-completions'],
      ['opencode-go/minimax-m3', 'opencode-go', 'anthropic-messages'],
      ['opencode-go/qwen3.7-plus', 'opencode-go', 'anthropic-messages'],
      ['kimi-coding/kimi-for-coding', 'kimi-coding', 'anthropic-messages'],
      ['zai/glm-5.2', 'zai', 'openai-completions'],
    ] as const;

    for (const [model, provider, api] of cases) {
      const identity = buildAutopilotProviderIdentity(model, 'high');
      assert.equal(identity.provider_id, provider);
      assert.equal(identity.requested_model_id, model);
      assert.equal(identity.executed_model_id, model);
      assert.equal(identity.api, api);
      assert.equal(identity.thinking_level, 'high');
    }
  });

  void it('rejects unsupported model prefixes', () => {
    for (const model of ['openrouter/gpt-4', 'openai/gpt-5', 'github-copilot/claude-sonnet', 'missing-slash']) {
      assert.throws(
        () => buildAutopilotProviderIdentity(model, 'high'),
        (error: unknown) =>
          error instanceof AutopilotForcedOutputIdentityError &&
          /unsupported Autopilot subscription model/u.test(error.message),
        model,
      );
    }
  });

  void it('produces a stable expected identity hash', () => {
    const spec = makeSpec('/tmp/autopilot-smoke-worktree');
    const identity = expectedAutopilotStatusIdentityFromSpec(spec);
    const hash1 = autopilotExpectedIdentityHash(identity);
    const hash2 = autopilotExpectedIdentityHash(identity);
    assert.equal(hash1, hash2);
    assert.match(hash1, /^sha256:[a-f0-9]{64}$/u);
  });

  void it('builds and parses a status tool context', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      assert.equal(context.unit_spec.unit_id, spec.unit_id);
      assert.equal(context.status_output, spec.status_output);
      assert.equal(context.receipt_output, spec.receipt_output);
      assert.match(context.schema_sha256, /^sha256:[a-f0-9]{64}$/u);
      assert.match(context.expected_identity_hash, /^sha256:[a-f0-9]{64}$/u);

      const parsed = parseAutopilotStatusToolContext(context);
      assert.deepEqual(parsed.unit_spec, context.unit_spec);
      assert.equal(parsed.expected_identity_hash, context.expected_identity_hash);
    });
  });

  void it('parses a context with an explicit artifact root', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec, artifactRoot: root });
      assert.equal(context.artifact_root, root);
      const parsed = parseAutopilotStatusToolContext(context);
      assert.equal(parsed.artifact_root, root);
    });
  });

  void it('rejects a context with mismatched schema sha256', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const tampered = { ...context, schema_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
      assert.throws(() => parseAutopilotStatusToolContext(tampered), /schema_sha256/u);
    });
  });

  void it('rejects a context with mismatched expected identity hash', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const tampered = { ...context, expected_identity_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
      assert.throws(() => parseAutopilotStatusToolContext(tampered), /expected_identity_hash/u);
    });
  });

  void it('rejects a context with mismatched provider identity', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const tampered = {
        ...context,
        provider_identity: { ...context.provider_identity, provider_id: 'evil' },
      };
      assert.throws(() => parseAutopilotStatusToolContext(tampered), /provider_identity/u);
    });
  });
});

void describe('forced-output writer', () => {
  void it('writes status and receipt atomically with correct hashes', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const status = makeStatus();

      const result = emitAutopilotStatus(context, status, 'call-1');
      assert.equal(result.statusOutput, spec.status_output);
      assert.equal(result.receiptOutput, spec.receipt_output);
      assert.match(result.statusSha256, /^sha256:[a-f0-9]{64}$/u);

      const statusText = await readFile(spec.status_output, 'utf8');
      const receiptText = await readFile(spec.receipt_output, 'utf8');
      assert.equal(result.statusSha256, sha256Text(statusText));

      const receipt = JSON.parse(receiptText) as { status_sha256: string; tool_call_id: string };
      assert.equal(receipt.status_sha256, result.statusSha256);
      assert.equal(receipt.tool_call_id, 'call-1');

      const evidence = await validateAutopilotStatusEvidence({ unitSpec: spec });
      assert.equal(evidence.status.verdict, 'DONE');
      assert.equal(evidence.receipt.tool_call_id, 'call-1');
    });
  });

  void it('refuses to overwrite stale status_output', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      await mkdir(dirname(spec.status_output), { recursive: true });
      await writeFile(spec.status_output, '{}\n', 'utf8');
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      assert.throws(
        () => emitAutopilotStatus(context, makeStatus(), 'call-2'),
        /stale Autopilot status_output/u,
      );
    });
  });

  void it('refuses to overwrite stale receipt_output', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      await mkdir(dirname(spec.receipt_output), { recursive: true });
      await writeFile(spec.receipt_output, '{}\n', 'utf8');
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      assert.throws(
        () => emitAutopilotStatus(context, makeStatus(), 'call-3'),
        /stale Autopilot receipt_output/u,
      );
    });
  });

  void it('rejects status_output that escapes the artifact root', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const tamperedContext = { ...context, status_output: '/tmp/escaped.json' };
      assert.throws(
        () => emitAutopilotStatus(tamperedContext, makeStatus(), 'call-4'),
        /escapes Autopilot artifact root/u,
      );
    });
  });

  void it('rejects receipt_output that escapes the artifact root', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const tamperedContext = { ...context, receipt_output: '/tmp/escaped.json' };
      assert.throws(
        () => emitAutopilotStatus(tamperedContext, makeStatus(), 'call-5'),
        /escapes Autopilot artifact root/u,
      );
    });
  });

  void it('rolls back status when receipt temp write fails', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      // Make a path component a file so mkdirSync throws ENOTDIR
      const fileAsParent = join(root, '.pi', 'autopilot', 'autopilot-smoke', 'receipts-file');
      await mkdir(dirname(fileAsParent), { recursive: true });
      await writeFile(fileAsParent, 'not-a-dir', 'utf8');
      const tamperedContext = {
        ...context,
        receipt_output: join(fileAsParent, 'nested', 'receipt.json'),
      };
      assert.throws(
        () => emitAutopilotStatus(tamperedContext, makeStatus(), 'call-6'),
        /failed to write receipt temp/u,
      );
      // Neither target should exist
      assert.equal(existsSync(tamperedContext.status_output), false);
      assert.equal(existsSync(tamperedContext.receipt_output), false);
    });
  });

  void it('performs single-file atomic write', async () => {
    await withTempDir(async (root) => {
      const target = join(root, 'atomic.txt');
      writeFileAtomicSync(target, 'hello\n');
      assert.equal(await readFile(target, 'utf8'), 'hello\n');
    });
  });
});

void describe('status-extension loader', () => {
  void it('fails closed without the context env var', () => {
    assert.throws(
      () => loadAutopilotStatusToolContextFromEnv({}),
      /AUTOPILOT_AGENT_STATUS_CONTEXT is required/u,
    );
  });

  void it('fails closed with a non-absolute context path', () => {
    assert.throws(
      () => loadAutopilotStatusToolContextFromEnv({ AUTOPILOT_AGENT_STATUS_CONTEXT: 'relative.json' }),
      /must be an absolute path/u,
    );
  });

  void it('fails closed with unreadable context file', async () => {
    await withTempDir(async (root) => {
      const badPath = join(root, 'missing.json');
      assert.throws(
        () =>
          loadAutopilotStatusToolContextFromEnv({
            AUTOPILOT_AGENT_STATUS_CONTEXT: badPath,
          }),
        /failed to read Autopilot status tool context/u,
      );
    });
  });

  void it('parses wrapper-authored context from env', async () => {
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

void describe('status-extension tool', () => {
  void it('returns terminating: true on success', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const tool = createAutopilotEmitStatusTool(context);
      const result = await tool.execute('call-7', makeStatus());
      assert.equal(result.terminate, true);
      assert.equal(result.details['tool_call_id'], 'call-7');
      assert.equal(result.details['terminating'], true);
    });
  });

  void it('rejects wrong unit identity through the tool', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const tool = createAutopilotEmitStatusTool(context);
      let caughtMessage = '';
      try {
        await tool.execute('call-8', { ...makeStatus(), unit_id: 'wrong-unit' });
      } catch (error) {
        caughtMessage = error instanceof Error ? error.message : String(error);
      }
      assert.ok(caughtMessage.length > 0);
      assert.match(caughtMessage, /unit_id does not match/u);
    });
  });

  void it('registers the tool on a fake host when context is present', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const contextPath = join(root, 'context.json');
      await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

      // The extension uses process.env by default.
      const original = process.env['AUTOPILOT_AGENT_STATUS_CONTEXT'];
      process.env['AUTOPILOT_AGENT_STATUS_CONTEXT'] = contextPath;
      try {
        const hostTools: ReturnType<typeof createAutopilotEmitStatusTool>[] = [];
        autopilotStatusExtension({
          registerTool(tool: ReturnType<typeof createAutopilotEmitStatusTool>) {
            hostTools.push(tool);
          },
        });
        assert.equal(hostTools.length, 1);
        assert.equal(hostTools[0]?.name, 'autopilot_emit_status');
      } finally {
        process.env['AUTOPILOT_AGENT_STATUS_CONTEXT'] = original;
      }
    });
  });
});

void describe('status-extension evidence', () => {
  void it('validates written status and receipt evidence', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      const status = makeStatus();
      emitAutopilotStatus(context, status, 'call-9');

      const evidence = await validateAutopilotStatusEvidence({ unitSpec: spec });
      assert.equal(evidence.status.verdict, 'DONE');
      assert.equal(evidence.receipt.tool_call_id, 'call-9');
      assert.equal(evidence.providerIdentity.provider_id, 'openai-codex');
    });
  });

  void it('rejects evidence when status is missing', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      let caughtMessage = '';
      try {
        await validateAutopilotStatusEvidence({ unitSpec: spec });
      } catch (error) {
        caughtMessage = error instanceof Error ? error.message : String(error);
      }
      assert.ok(caughtMessage.length > 0);
      assert.match(caughtMessage, /missing-status/u);
    });
  });

  void it('rejects evidence when receipt hash does not match status file', async () => {
    await withTempDir(async (root) => {
      const spec = makeSpec(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: spec });
      emitAutopilotStatus(context, makeStatus(), 'call-10');

      // Tamper with the receipt file
      const receiptPath = spec.receipt_output;
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
      receipt['status_sha256'] = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

      let caughtMessage = '';
      try {
        await validateAutopilotStatusEvidence({ unitSpec: spec });
      } catch (error) {
        caughtMessage = error instanceof Error ? error.message : String(error);
      }
      assert.ok(caughtMessage.length > 0);
      assert.match(caughtMessage, /does not match status file/u);
    });
  });
});
