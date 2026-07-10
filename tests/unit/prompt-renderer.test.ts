import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUTOPILOT_RUNNER_BIN, AUTOPILOT_STATUS_TOOL } from '../../src/core/names.ts';
import { autopilotModelAssignmentForRole } from '../../src/core/model-roster.ts';
import {
  AUTOPILOT_ROLE_VALUES,
  AutopilotPromptTemplateError,
  DEFAULT_AUTOPILOT_TEMPLATE_DIR,
  autopilotTemplatePath,
  deriveAutopilotPromptSnapshotPath,
  renderAndMaybeWriteAutopilotPromptSnapshot,
  renderAutopilotAgentPrompt,
  validateAutopilotPromptTemplateSource,
  type AutopilotRole,
  type AutopilotUnitSpec,
} from '../../src/core/prompt-renderer/index.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-prompt-renderer-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function spec(root: string, role: AutopilotRole): AutopilotUnitSpec {
  const sourceRole = role === 'implement' || role === 'fix';
  const validationRole = role === 'validate' || role === 'bughunt';
  const worktree = join(root, 'worktree');
  const runtimeRoot = join(worktree, '.pi', 'autopilot', 'demo');
  const assignment = autopilotModelAssignmentForRole(role);
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'demo',
    unit_id: `u01-${role}`,
    role,
    template: role,
    attempt: 1,
    objective: `Exercise the ${role} fixed template.`,
    cwd: worktree,
    model: assignment.model,
    thinking: assignment.thinking,
    owned_paths: sourceRole ? [`src/${role}.ts`] : [],
    read_only_paths: ['src/core/names.ts'],
    untouchable_paths: ['private/**', 'node_modules/**'],
    context_refs: [
      {
        path: 'docs/autopilot-architecture.md',
        purpose: 'Autopilot target architecture',
      },
    ],
    validation_commands: validationRole ? ['npm run typecheck'] : [],
    status_output: join(runtimeRoot, 'statuses', `u01-${role}.${role}.attempt-1.json`),
    receipt_output: join(runtimeRoot, 'receipts', `u01-${role}.${role}.attempt-1.receipt.json`),
    evidence_dir: join(runtimeRoot, 'evidence', `u01-${role}`),
    stop_boundary: 'Stop instead of editing outside the declared ownership boundary.',
    timeout_seconds: 3600,
    render_prompt_snapshot: true,
  };
}

function requiredSlotFixture(extra: string): string {
  return [
    '{{workstream}}{{unit_id}}{{role}}{{attempt}}{{model}}{{thinking}}',
    '{{objective}}{{cwd}}{{owned_paths}}{{read_only_paths}}{{untouchable_paths}}',
    '{{context_refs}}{{validation_commands}}{{evidence_dir}}{{artifact_root}}',
    '{{stop_boundary}}{{quality_rules}}{{role_specific_instructions}}',
    '{{status_payload_contract}}{{status_output}}{{receipt_output}}',
    '{{forced_output_contract_json}}{{verdict_guidance}}',
    extra,
  ].join('\n');
}

void describe('Autopilot fixed prompt templates', () => {
  void it('resolves default templates from the package directory', () => {
    assert.equal(DEFAULT_AUTOPILOT_TEMPLATE_DIR.endsWith('/templates/'), true);
    assert.equal(autopilotTemplatePath('implement').endsWith('/templates/implement.md'), true);
  });

  void it('validates and renders every role template with Autopilot surfaces', async () => {
    await withTempDir(async (root) => {
      for (const role of AUTOPILOT_ROLE_VALUES) {
        const source = await readFile(autopilotTemplatePath(role), 'utf8');
        const validation = validateAutopilotPromptTemplateSource({
          template: role,
          source,
          templatePath: autopilotTemplatePath(role),
        });
        assert.deepEqual(validation.issues, [], role);

        const prompt = renderAutopilotAgentPrompt(spec(root, role));
        assert.ok(prompt.includes(`unit_id: \`u01-${role}\``));
        assert.match(prompt, /Autopilot/u);
        assert.match(prompt, new RegExp(AUTOPILOT_STATUS_TOOL, 'u'));
        assert.match(prompt, /Assistant-text JSON/u);
        assert.match(prompt, /band-aids/u);
        assert.match(prompt, /hacks/u);
        assert.match(prompt, /silent fallbacks/u);
        assert.match(prompt, /fake-green tests/u);
        assert.match(prompt, /fixture tampering/u);
        assert.match(prompt, /deferred consumers/u);
        assert.match(prompt, /self-certifying/u);
        assert.match(prompt, /### Owned paths/u);
        assert.match(prompt, /### Read-only paths/u);
        assert.match(prompt, /### Untouchable paths/u);
        assert.match(prompt, /Stop instead of editing outside/u);
        assert.match(prompt, /"schema_version": "autopilot.status.v1"/u);
        assert.match(prompt, new RegExp(AUTOPILOT_RUNNER_BIN, 'u'));
        assert.equal(/high-level-orchestrator-playbook\.md/u.test(prompt), false);
        assert.equal(/ledger\.md/u.test(prompt), false);
        assert.ok(
          new TextEncoder().encode(prompt).length < 16_000,
          `${role} rendered prompt should stay compact`,
        );
      }
    });
  });

  void it('writes rendered prompt snapshots under the Autopilot runtime root', async () => {
    await withTempDir(async (root) => {
      const unit = spec(root, 'implement');
      const result = await renderAndMaybeWriteAutopilotPromptSnapshot({ spec: unit });
      const expectedPath = deriveAutopilotPromptSnapshotPath(unit);
      assert.equal(result.snapshotPath, expectedPath);
      assert.equal(
        expectedPath.endsWith('/worktree/.pi/autopilot/demo/rendered-prompts/u01-implement.implement.attempt-1.md'),
        true,
      );
      const snapshot = await readFile(expectedPath, 'utf8');
      assert.equal(snapshot, `${result.text}\n`);
    });
  });

  void it('fails before model spend when a role deviates from the fixed model roster', async () => {
    await withTempDir(async (root) => {
      assert.throws(
        () =>
          renderAutopilotAgentPrompt({
            ...spec(root, 'implement'),
            model: 'openai-codex/gpt-5.6-sol',
          }),
        /implement role requires fixed roster model openai-codex\/gpt-5\.6-terra/u,
      );
      assert.throws(
        () =>
          renderAutopilotAgentPrompt({
            ...spec(root, 'validate'),
            thinking: 'high',
          }),
        /validate role requires fixed roster thinking xhigh/u,
      );
    });
  });

  void it('fails before model spend when a template is missing required slots', async () => {
    await withTempDir(async (root) => {
      const templatesDir = join(root, 'templates');
      await mkdir(templatesDir, { recursive: true });
      const source = await readFile(autopilotTemplatePath('implement'), 'utf8');
      await writeFile(
        join(templatesDir, 'implement.md'),
        source.replace('{{stop_boundary}}', 'missing stop boundary slot'),
        'utf8',
      );

      assert.throws(
        () => renderAutopilotAgentPrompt(spec(root, 'implement'), { templatesDir }),
        (error: unknown) =>
          error instanceof AutopilotPromptTemplateError &&
          error.message.includes('missing required slot {{stop_boundary}}'),
      );
    });
  });

  void it('rejects unknown slots and raw child prompt-launch instructions', () => {
    const validation = validateAutopilotPromptTemplateSource({
      template: 'validate',
      source: requiredSlotFixture('{{unknown_slot}}\npi -p "bad"\npi --model openai-codex/gpt-5.5 -p "bad"'),
    });

    assert.ok(validation.issues.some((issue) => issue.includes('unknown slot {{unknown_slot}}')));
    assert.ok(validation.issues.some((issue) => issue.includes('raw child Pi prompt launches')));
  });

  void it('rejects overlarge fixed templates', () => {
    const validation = validateAutopilotPromptTemplateSource({
      template: 'strategy',
      source: requiredSlotFixture('x'.repeat(14_100)),
    });

    assert.ok(validation.issues.some((issue) => issue.includes('fixed Autopilot prompts must stay compact')));
  });
});
