import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA,
  AutopilotContractValidationError,
  assertAutopilotStatusJsonSchemaCompiles,
  autopilotSchemaSha256,
  parseAutopilotDecisionRow,
  parseAutopilotEventRow,
  parseAutopilotExecutionAudit,
  parseAutopilotHandoff,
  parseAutopilotMasterPlan,
  parseAutopilotReceipt,
  parseAutopilotState,
  parseAutopilotStatusEntry,
  parseAutopilotUnitSpec,
  type AutopilotReceipt,
  type AutopilotStatusEntry,
  type AutopilotVerificationPlan,
} from '../../src/core/contracts/index.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURE_DIR = join(PACKAGE_ROOT, 'tests', 'fixtures', 'contracts');

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURE_DIR, name), 'utf8')) as unknown;
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-contracts-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sha256Text(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function verificationPlan(): AutopilotVerificationPlan {
  return {
    positive_witnesses: [
      {
        id: 'positive-typecheck',
        command: 'npm run typecheck',
        expected_signal: 'typecheck exits zero',
        required: true,
      },
    ],
    negative_witnesses: [],
    regression_witnesses: [],
    real_boundary_witnesses: [],
    blast_radius_checks: [],
    docs_schema_prompt_checks: [],
    dirty_tree_checks: [],
  };
}

void describe('Autopilot contracts', () => {
  void it('parses valid unit spec fixtures', async () => {
    assert.equal(
      parseAutopilotUnitSpec(await fixture('valid-unit-spec.implement.json')).role,
      'implement',
    );
    assert.equal(
      parseAutopilotUnitSpec(await fixture('valid-unit-spec.validate.json')).role,
      'validate',
    );
  });

  void it('requires unit-spec outputs to stay under the workstream runtime artifact root', async () => {
    const spec = parseAutopilotUnitSpec(await fixture('valid-unit-spec.implement.json'));

    assert.throws(
      () =>
        parseAutopilotUnitSpec({
          ...spec,
          status_output:
            '/tmp/autopilot-smoke-worktree/.pi/autopilot/other/statuses/u01-implement.implement.attempt-1.json',
        }),
      /status_output must be under runtime artifact root/u,
    );
    assert.throws(
      () =>
        parseAutopilotUnitSpec({
          ...spec,
          receipt_output:
            '/tmp/autopilot-smoke-worktree/.pi/autopilot/autopilot-smoke/statuses/u01-implement.implement.attempt-1.receipt.json',
        }),
      /receipt_output must be under runtime artifact root/u,
    );
    assert.throws(
      () =>
        parseAutopilotUnitSpec({
          ...spec,
          evidence_dir:
            '/tmp/autopilot-smoke-worktree/.pi/autopilot/autopilot-smoke/receipts/u01-implement',
        }),
      /evidence_dir must be under runtime artifact root/u,
    );
  });

  void it('parses valid status/event/state/receipt/handoff fixtures', async () => {
    assert.equal(
      parseAutopilotStatusEntry(await fixture('valid-status.implement.json')).verdict,
      'DONE',
    );
    assert.equal(
      parseAutopilotStatusEntry(await fixture('valid-status.validate.json')).verdict,
      'PASS',
    );
    assert.equal(
      parseAutopilotEventRow(await fixture('valid-event.agent-completed.json')).event,
      'agent_completed',
    );
    assert.equal(parseAutopilotState(await fixture('valid-state.json')).status, 'running');
    assert.equal(
      parseAutopilotReceipt(await fixture('valid-receipt.json')).tool_name,
      'autopilot_emit_status',
    );
    const handoff = parseAutopilotHandoff(await fixture('valid-handoff.json'));
    assert.equal(handoff.reason, 'operator-pause');
    assert.equal(handoff.latest_decision_id, 1);
    assert.deepEqual(handoff.audit_refs, ['execution-audits/u01-implement.implement.attempt-1.json']);
  });

  void it('parses quality unit-spec fields and new Quality vNext contracts', async () => {
    await withTempDir(async (root) => {
      const baseSpec = parseAutopilotUnitSpec(await fixture('valid-unit-spec.implement.json'));
      const spec = parseAutopilotUnitSpec({
        ...baseSpec,
        quality_profile: 'source-change',
        risk_level: 'medium',
        acceptance_criteria: ['root-cause implementation is complete'],
        verification_plan: verificationPlan(),
        closure_criteria: ['independent validation passes'],
        upstream_refs: [
          {
            unit_id: 'strategy-1',
            status_ref: 'statuses/strategy-1.strategy.attempt-1.json',
            audit_ref: 'execution-audits/strategy-1.strategy.attempt-1.json',
            purpose: 'strategy baseline',
          },
        ],
      });
      assert.equal(spec.quality_profile, 'source-change');
      assert.equal(spec.verification_plan?.positive_witnesses[0]?.id, 'positive-typecheck');

      const masterPlan = parseAutopilotMasterPlan({
        schema_version: 'autopilot.master_plan.v1',
        workstream: 'demo',
        mission_ref: 'mission.md',
        goal_summary: 'Ship a root-cause package upgrade.',
        non_goals: ['no live provider run in default gate'],
        definition_of_done: ['package gate passes'],
        risk_level: 'medium',
        lanes: [{ lane_id: 'lane-1', summary: 'core quality lane', unit_ids: ['u01'] }],
        units: {
          u01: {
            unit_id: 'u01',
            role: 'implement',
            state: 'ready',
            dependencies: [],
            summary: 'implement quality contracts',
          },
        },
        ownership_matrix: {
          owned_paths: ['packages/pi-autopilot/src'],
          read_only_paths: ['packages/pi-autopilot/README.md'],
          untouchable_paths: ['private'],
          held_paths: ['products'],
        },
        verification_matrix: verificationPlan(),
        closure_criteria: ['validation passes'],
        current_focus: 'quality contracts',
        last_decision_id: 1,
        last_event_id: 2,
        updated_at: '2026-07-02T00:00:00.000Z',
      });
      assert.equal(masterPlan.schema_version, 'autopilot.master_plan.v1');

      const decision = parseAutopilotDecisionRow({
        schema_version: 'autopilot.decision.v1',
        id: 1,
        ts: '2026-07-02T00:00:00.000Z',
        event: 'master_plan_created',
        workstream: 'demo',
        summary: 'Created durable plan.',
        decision: 'Use Quality vNext contracts for semantic closure.',
        master_plan_ref: 'master-plan.json',
      });
      assert.equal(decision.event, 'master_plan_created');

      const audit = parseAutopilotExecutionAudit({
        schema_version: 'autopilot.execution_audit.v1',
        workstream: 'demo',
        unit_id: 'u01',
        role: 'implement',
        attempt: 1,
        audited_at: '2026-07-02T00:00:00.000Z',
        cwd: root,
        git_head: null,
        dirty_baseline: false,
        dirty_baseline_paths: [],
        dirty_relevant_paths: [],
        actual_changed_paths: ['packages/pi-autopilot/src/core/contracts/types.ts'],
        status_reported_changed_paths: ['packages/pi-autopilot/src/core/contracts/types.ts'],
        omitted_status_changes: [],
        reported_but_not_actual_changes: [],
        outside_owned_paths: [],
        read_only_touched_paths: [],
        untouchable_touched_paths: [],
        path_counts: {
          dirty_baseline_paths: 0,
          dirty_relevant_paths: 0,
          actual_changed_paths: 1,
          status_reported_changed_paths: 1,
          omitted_status_changes: 0,
          reported_but_not_actual_changes: 0,
          outside_owned_paths: 0,
          read_only_touched_paths: 0,
          untouchable_touched_paths: 0,
        },
        truncated_path_sets: [],
        declared_validation_commands: ['npm run typecheck'],
        status_reported_commands: ['npm run typecheck'],
        command_coverage_gaps: [],
        classification: 'clean',
        evidence_refs: [],
        summary: 'Audit clean.',
      });
      assert.equal(audit.classification, 'clean');
    });
  });

  void it('rejects malformed Quality vNext contracts loudly', async () => {
    assert.throws(
      () =>
        parseAutopilotMasterPlan({
          schema_version: 'autopilot.master_plan.v1',
          workstream: 'demo',
          mission_ref: '../mission.md',
        }),
      AutopilotContractValidationError,
    );
    assert.throws(
      () =>
        parseAutopilotDecisionRow({
          schema_version: 'autopilot.decision.v1',
          id: 1,
          ts: '2026-07-02T00:00:00.000Z',
          event: 'scope_exception_ratified',
          workstream: 'demo',
          summary: 'missing decision',
        }),
      AutopilotContractValidationError,
    );
    assert.throws(
      () =>
        parseAutopilotExecutionAudit({
          schema_version: 'autopilot.execution_audit.v1',
          workstream: 'demo',
          unit_id: 'u01',
          role: 'implement',
          attempt: 1,
          audited_at: '2026-07-02T00:00:00.000Z',
          cwd: 'relative',
          git_head: null,
          dirty_baseline: null,
          dirty_baseline_paths: [],
          dirty_relevant_paths: [],
          actual_changed_paths: [],
          status_reported_changed_paths: [],
          omitted_status_changes: [],
          reported_but_not_actual_changes: [],
          outside_owned_paths: [],
          read_only_touched_paths: [],
          untouchable_touched_paths: [],
          declared_validation_commands: [],
          status_reported_commands: [],
          command_coverage_gaps: [],
          classification: 'clean',
          evidence_refs: [],
          summary: 'bad cwd',
        }),
      AutopilotContractValidationError,
    );
  });

  void it('rejects invalid contract fixtures loudly', async () => {
    const invalidCases: ReadonlyArray<readonly [string, (value: unknown) => unknown]> = [
      ['invalid-status.pass-with-finding.json', parseAutopilotStatusEntry],
      ['invalid-status.implement-pass.json', parseAutopilotStatusEntry],
      ['invalid-unit-spec.relative-cwd.json', parseAutopilotUnitSpec],
      ['invalid-unit-spec.no-owned.json', parseAutopilotUnitSpec],
      ['invalid-unit-spec.parent-traversal.json', parseAutopilotUnitSpec],
      ['invalid-event.missing-status-ref.json', parseAutopilotEventRow],
      ['invalid-state.duplicate-queues.json', parseAutopilotState],
      ['invalid-receipt.wrong-tool.json', parseAutopilotReceipt],
      ['invalid-handoff.parent-state-ref.json', parseAutopilotHandoff],
    ];

    for (const [name, parser] of invalidCases) {
      const value = await fixture(name);
      assert.throws(() => parser(value), AutopilotContractValidationError, name);
    }
  });

  void it('rejects prose-shaped JSON as a status carrier', () => {
    assert.throws(
      () =>
        parseAutopilotStatusEntry({
          message: 'PASS',
          artifact: 'statuses/u02-validate.validate.attempt-1.json',
          json: '{"verdict":"PASS"}',
        }),
      AutopilotContractValidationError,
    );
  });

  void it('enforces unit-spec identity and changed-path ownership for status entries', async () => {
    const spec = parseAutopilotUnitSpec(await fixture('valid-unit-spec.implement.json'));
    const status = parseAutopilotStatusEntry(await fixture('valid-status.implement.json'), {
      unitSpec: spec,
    });
    assert.deepEqual(status.changed_paths, ['src/smoke.ts']);

    const outsideOwned: AutopilotStatusEntry = {
      ...status,
      changed_paths: ['src/other.ts'],
    };
    assert.throws(
      () => parseAutopilotStatusEntry(outsideOwned, { unitSpec: spec }),
      /outside unit owned_paths/u,
    );

    const wrongAttempt: AutopilotStatusEntry = {
      ...status,
      attempt: 2,
    };
    assert.throws(
      () => parseAutopilotStatusEntry(wrongAttempt, { unitSpec: spec }),
      /attempt does not match/u,
    );
  });

  void it('enforces relative command evidence refs for status entries', async () => {
    const validStatus = parseAutopilotStatusEntry(await fixture('valid-status.validate.json'));
    const command = validStatus.commands[0];
    if (command === undefined) {
      throw new Error('valid-status.validate.json fixture must include a command');
    }

    const withRelativeEvidenceRef: AutopilotStatusEntry = {
      ...validStatus,
      commands: [{ ...command, evidence_ref: 'evidence/u02-validate/test.log' }],
    };
    assert.equal(
      parseAutopilotStatusEntry(withRelativeEvidenceRef).commands[0]?.evidence_ref,
      'evidence/u02-validate/test.log',
    );

    const withAbsoluteEvidenceRef: AutopilotStatusEntry = {
      ...validStatus,
      commands: [{ ...command, evidence_ref: '/tmp/evil' }],
    };
    assert.throws(
      () => parseAutopilotStatusEntry(withAbsoluteEvidenceRef),
      /commands\[0\]\.evidence_ref must be repo\/runtime relative/u,
    );
  });

  void it('requires sha256 and byte_count for evidence refs when files exist', async () => {
    const validStatus = parseAutopilotStatusEntry(await fixture('valid-status.validate.json'));
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'evidence', 'u02-validate'), { recursive: true });
      const evidenceRel = 'evidence/u02-validate/log.txt';
      const evidenceText = 'validation evidence\n';
      await writeFile(join(dir, evidenceRel), evidenceText, 'utf8');

      const missingHash: AutopilotStatusEntry = {
        ...validStatus,
        evidence_refs: [{ path: evidenceRel }],
      };
      assert.throws(
        () => parseAutopilotStatusEntry(missingHash, { artifactRoot: dir }),
        /requires sha256/u,
      );

      const withHash: AutopilotStatusEntry = {
        ...validStatus,
        evidence_refs: [
          {
            path: evidenceRel,
            sha256: sha256Text(evidenceText),
            byte_count: Buffer.byteLength(evidenceText, 'utf8'),
          },
        ],
      };
      assert.equal(
        parseAutopilotStatusEntry(withHash, { artifactRoot: dir }).evidence_refs.length,
        1,
      );

      const wrongHash: AutopilotStatusEntry = {
        ...withHash,
        evidence_refs: [
          {
            path: evidenceRel,
            sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            byte_count: Buffer.byteLength(evidenceText, 'utf8'),
          },
        ],
      };
      assert.throws(
        () => parseAutopilotStatusEntry(wrongHash, { artifactRoot: dir }),
        /sha256 mismatch/u,
      );
    });
  });

  void it('validates receipt status hashes when the status artifact exists', async () => {
    const receipt = parseAutopilotReceipt(await fixture('valid-receipt.json'));
    await withTempDir(async (dir) => {
      const statusPath = join(dir, 'status.json');
      const statusText = JSON.stringify(await fixture('valid-status.implement.json'));
      await writeFile(statusPath, statusText, 'utf8');

      const matchingReceipt: AutopilotReceipt = {
        ...receipt,
        status_output: statusPath,
        status_sha256: sha256Text(statusText),
      };
      assert.equal(
        parseAutopilotReceipt(matchingReceipt, { statusOutputPath: statusPath }).status_sha256,
        sha256Text(statusText),
      );

      const wrongReceipt: AutopilotReceipt = {
        ...matchingReceipt,
        status_sha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      };
      assert.throws(
        () => parseAutopilotReceipt(wrongReceipt, { statusOutputPath: statusPath }),
        /does not match status file/u,
      );
    });
  });

  void it('exports a forced-output JSON Schema and enforces role/verdict coherence', async () => {
    assertAutopilotStatusJsonSchemaCompiles();
    assert.match(autopilotSchemaSha256('statusEntry'), /^sha256:[a-f0-9]{64}$/u);
    assert.equal(AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA.properties.schema_version.const, 'autopilot.status.v1');
    assert.equal(parseAutopilotStatusEntry(await fixture('valid-status.validate.json')).verdict, 'PASS');
    const invalidStatus = await fixture('invalid-status.implement-pass.json');
    assert.throws(
      () => parseAutopilotStatusEntry(invalidStatus),
      AutopilotContractValidationError,
    );
  });
});
