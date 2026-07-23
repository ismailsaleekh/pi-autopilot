import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUTOPILOT_RUNNER_BIN, AUTOPILOT_STATUS_TOOL } from '../../src/core/names.ts';
import { computeAutopilotRosterContractObjectHash } from '../../src/core/roster/contracts.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import {
  materializeNewRunUnitSpecV2,
  requestProfileFromAssignment,
  type AutopilotRosterSelectionV1,
  type AutopilotRosterUnitSpecV2,
  type AutopilotRosterV1,
} from '../../src/core/roster/runtime-spec.ts';
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
} from '../../src/core/prompt-renderer/index.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-prompt-renderer-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function spec(root: string, role: AutopilotRole): AutopilotRosterUnitSpecV2 {
  const sourceRole = role === 'implement' || role === 'fix';
  const validationRole = role === 'validate' || role === 'bughunt';
  const worktree = join(root, 'worktree');
  const runtimeRoot = join(worktree, '.pi', 'autopilot', 'demo');
  const { selection, roster, requestProfile } = pinnedFacts(role);
  return materializeNewRunUnitSpecV2({
    selection,
    roster,
    role,
    request_profile: requestProfile,
    workstream: 'demo',
    unit_id: `u01-${role}`,
    attempt: 1,
    objective: `Exercise the ${role} v2 template.`,
    cwd: worktree,
    owned_paths: sourceRole ? [`src/${role}.ts`] : [],
    read_only_paths: ['src/core/names.ts'],
    untouchable_paths: ['private/**', 'node_modules/**'],
    context_refs: [
      {
        path: 'docs/autopilot-architecture.md',
        purpose: 'Autopilot target architecture',
        sha256: null,
        byte_count: null,
      },
    ],
    validation_commands: validationRole ? ['npm run typecheck'] : [],
    status_output: join(runtimeRoot, 'statuses', `u01-${role}.${role}.attempt-1.json`),
    receipt_output: join(runtimeRoot, 'receipts', `u01-${role}.${role}.attempt-1.receipt.json`),
    evidence_dir: join(runtimeRoot, 'evidence', `u01-${role}`),
    stop_boundary: 'Stop instead of editing outside the declared ownership boundary.',
    quality_profile: null,
    risk_level: null,
    acceptance_criteria: [],
    verification_plan: null,
    closure_criteria: [],
    upstream_refs: [],
    timeout_seconds: 3600,
    render_prompt_snapshot: true,
  });
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

void describe('Autopilot v2 prompt templates', () => {
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

  void it('fails before model spend when v2 model or thinking drift from request_profile', async () => {
    await withTempDir(async (root) => {
      assert.throws(
        () =>
          renderAutopilotAgentPrompt({
            ...spec(root, 'implement'),
            model: 'openai-codex/gpt-5.6-sol',
          }),
        /unit_spec\.v2 model must equal request_profile\.model/u,
      );
      const validateSpec = spec(root, 'validate');
      assert.throws(
        () =>
          renderAutopilotAgentPrompt({
            ...validateSpec,
            thinking: validateSpec.thinking === 'high' ? 'xhigh' : 'high',
          }),
        /unit_spec\.v2 thinking must equal request_profile\.thinking/u,
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

function pinnedFacts(role: AutopilotRole): {
  readonly selection: AutopilotRosterSelectionV1;
  readonly roster: AutopilotRosterV1;
  readonly requestProfile: ReturnType<typeof requestProfileFromAssignment>;
} {
  const roster = SEED_ROSTERS.find((entry) => entry.assignments.some((assignment) => assignment.role === role));
  if (roster === undefined) throw new Error(`missing seed roster for ${role}`);
  const assignment = roster.assignments.find((entry) => entry.role === role);
  if (assignment === undefined) throw new Error(`missing assignment for ${role}`);
  const selectionWithoutHash = {
    schema_version: 'autopilot.pre_run_selection.v1' as const,
    repo_id: 'repo-prompt-renderer',
    workstream_run: 'run-prompt-renderer',
    scope: roster.scope,
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    roster_sha256: roster.roster_sha256,
    assignment_set_sha256: roster.assignment_set_sha256,
    config_sha256: 'sha256:7777777777777777777777777777777777777777777777777777777777777777',
    selected_at: '2026-07-23T12:00:00.000Z',
    selection_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  const selection = {
    ...selectionWithoutHash,
    selection_sha256: requiredHash('autopilot.pre_run_selection.v1', selectionWithoutHash),
  };
  return { selection, roster, requestProfile: requestProfileFromAssignment(assignment) };
}

function requiredHash(schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0], value: unknown): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash;
}
