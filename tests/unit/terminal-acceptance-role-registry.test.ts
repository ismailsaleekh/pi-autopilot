import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  parseAutopilotExecutionAudit,
  parseAutopilotReceipt,
  parseAutopilotStatusEntry,
} from '../../src/core/contracts/index.ts';
import { AUTOPILOT_ROLE_VALUES, type AutopilotRole } from '../../src/core/contracts/types.ts';
import {
  assertAutopilotChildTerminalAcceptanceChain,
  parseAutopilotChildTerminalAcceptance,
  writeAutopilotChildTerminalAcceptance,
} from '../../src/core/coordination/terminal-acceptance.ts';
import type { CoordinationChildLease } from '../../src/core/coordination/types.ts';

// D65-I2: terminal acceptance consumes the ONE shared package role registry
// (AUTOPILOT_ROLE_VALUES) rather than a private terminal-role list. Every
// declared role — including `extract` — is admissible terminal evidence; the
// private allow-list that omitted `extract` is removed. These regressions pin
// that unification and prove malformed/identity evidence still fails loudly.

const HEAD = 'c'.repeat(40);

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface RoleFacts {
  readonly verdict: 'DONE' | 'PASS';
  readonly ownedPaths: readonly string[];
  readonly validationCommands: readonly string[];
  readonly qualityProfile: string;
  readonly reportRef?: { readonly path: string; readonly sha256: `sha256:${string}`; readonly byte_count: number };
}

// The read/coordinator success verdict differs by role; source roles emit DONE,
// validators emit PASS. Every role must be admissible terminal evidence.
function roleFacts(role: AutopilotRole): RoleFacts {
  switch (role) {
    case 'implement':
    case 'fix':
      return { verdict: 'DONE', ownedPaths: ['src/unit.ts'], validationCommands: [], qualityProfile: 'source-change' };
    case 'strategy':
      return { verdict: 'DONE', ownedPaths: [], validationCommands: [], qualityProfile: 'strategy', reportRef: { path: 'evidence/plan.md', sha256: `sha256:${'f'.repeat(64)}`, byte_count: 128 } };
    case 'adjudicate':
      return { verdict: 'DONE', ownedPaths: [], validationCommands: [], qualityProfile: 'adjudication' };
    case 'extract':
      return { verdict: 'DONE', ownedPaths: [], validationCommands: [], qualityProfile: 'extract' };
    case 'validate':
    case 'bughunt':
      return { verdict: 'PASS', ownedPaths: [], validationCommands: ['npm test'], qualityProfile: 'validation-only', reportRef: { path: 'evidence/validation.md', sha256: `sha256:${'f'.repeat(64)}`, byte_count: 96 } };
  }
}

interface QuartetPaths {
  readonly runtimeRoot: string;
  readonly mainWorktree: string;
  readonly specPath: string;
  readonly statusPath: string;
  readonly receiptPath: string;
  readonly auditPath: string;
}

async function writeRoleQuartet(root: string, role: AutopilotRole, unitId: string, attempt: number): Promise<{
  readonly paths: QuartetPaths;
  readonly child: CoordinationChildLease;
}> {
  const facts = roleFacts(role);
  const mainWorktree = join(root, 'main');
  const runtimeRoot = join(mainWorktree, '.pi', 'autopilot', 'extract-registry');
  const workstream = 'extract-registry';
  const workstreamRun = 'run-extract-registry';
  const repoId = 'repo-extract-registry';
  const autopilotId = 'autopilot-extract-registry';
  const cwd = join(root, 'unit-worktree');
  await mkdir(cwd, { recursive: true });

  const specPath = join(runtimeRoot, 'unit-specs', `${unitId}.${role}.attempt-${String(attempt)}.json`);
  const statusPath = join(runtimeRoot, 'statuses', `${unitId}.${role}.attempt-${String(attempt)}.json`);
  const receiptPath = join(runtimeRoot, 'receipts', `${unitId}.${role}.attempt-${String(attempt)}.receipt.json`);
  const auditPath = join(runtimeRoot, 'execution-audits', `${unitId}.${role}.attempt-${String(attempt)}.json`);

  const spec = {
    schema_version: 'autopilot.unit_spec.v1', workstream, unit_id: unitId, role, template: role, attempt,
    objective: `Prove the ${role} terminal chain.`, cwd, model: 'openai-codex/gpt-5.6-luna', thinking: 'high',
    owned_paths: [...facts.ownedPaths], read_only_paths: [], untouchable_paths: ['private/**'],
    context_refs: [], validation_commands: [...facts.validationCommands],
    status_output: statusPath, receipt_output: receiptPath, evidence_dir: join(runtimeRoot, 'evidence', unitId),
    stop_boundary: 'Do only the assigned work.', quality_profile: facts.qualityProfile, risk_level: 'low',
    acceptance_criteria: [`${role} completes`], closure_criteria: [`${role} closed`], upstream_refs: [],
  } as const;
  await mkdir(dirname(specPath), { recursive: true });
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  const statusDocument = {
    schema_version: 'autopilot.status.v1', workstream, unit_id: unitId, role, attempt, verdict: facts.verdict,
    severity: 'clean', summary: `The ${role} unit completed cleanly.`, changed_paths: [], findings: [],
    commands: facts.validationCommands.map((command) => ({ command, status: 'passed', exit_code: 0, summary: 'ok' })),
    evidence_refs: [], report_ref: facts.reportRef ?? null, next_action: 'advance work',
  } as const;
  await mkdir(dirname(statusPath), { recursive: true });
  await writeFile(statusPath, `${JSON.stringify(statusDocument, null, 2)}\n`, 'utf8');
  const statusBytes = await readFile(statusPath);
  const statusSha = sha256(statusBytes);

  const receiptDocument = {
    schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream, unit_id: unitId, role,
    attempt, emitted_at: '2026-07-14T10:00:00.000Z', status_output: statusPath, status_sha256: statusSha,
    schema_sha256: `sha256:${'d'.repeat(64)}`, tool_call_id: `tool-${unitId}-${role}`,
    provider_identity: { provider_id: 'openai-codex', requested_model_id: spec.model, executed_model_id: spec.model, api: 'openai-codex-responses', thinking_level: spec.thinking },
    expected_identity_hash: `sha256:${'e'.repeat(64)}`,
  } as const;
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receiptDocument, null, 2)}\n`, 'utf8');

  const auditDocument = {
    schema_version: 'autopilot.execution_audit.v1', workstream, unit_id: unitId, role, attempt,
    audited_at: '2026-07-14T10:00:00.000Z', cwd, git_head: HEAD, baseline_head: HEAD, post_run_head: HEAD,
    head_change_kind: 'none', committed_changed_paths: [], dirty_baseline: false, dirty_baseline_paths: [],
    dirty_relevant_paths: [], actual_changed_paths: [], status_reported_changed_paths: [], omitted_status_changes: [],
    reported_but_not_actual_changes: [], outside_owned_paths: [], read_only_touched_paths: [], untouchable_touched_paths: [],
    path_counts: { dirty_baseline_paths: 0, dirty_relevant_paths: 0, actual_changed_paths: 0, status_reported_changed_paths: 0, omitted_status_changes: 0, reported_but_not_actual_changes: 0, outside_owned_paths: 0, read_only_touched_paths: 0, untouchable_touched_paths: 0 },
    truncated_path_sets: [], declared_validation_commands: [...facts.validationCommands], status_reported_commands: [...facts.validationCommands],
    command_coverage_gaps: [], classification: 'clean', evidence_refs: [], summary: `The ${role} execution audit is clean.`,
  } as const;
  await mkdir(dirname(auditPath), { recursive: true });
  await writeFile(auditPath, `${JSON.stringify(auditDocument, null, 2)}\n`, 'utf8');

  const child: CoordinationChildLease = {
    schema_version: 'autopilot.child_lease.v1',
    child_lease_id: `child-${workstreamRun}-${unitId}-${String(attempt)}`,
    owner: { repo_id: repoId, autopilot_id: autopilotId, workstream_run: workstreamRun, unit_id: unitId, attempt },
    pid: 4321, boot_id: 'boot-extract-registry', lease_expires_at: '2026-07-14T10:05:00.000Z',
    status: 'running', terminal_evidence: null, version: 1,
  };

  return { paths: { runtimeRoot, mainWorktree, specPath, statusPath, receiptPath, auditPath }, child };
}

async function loadQuartetBytes(paths: QuartetPaths): Promise<{ readonly specBytes: Uint8Array; readonly statusBytes: Uint8Array; readonly receiptBytes: Uint8Array; readonly auditBytes: Uint8Array }> {
  const [specBytes, statusBytes, receiptBytes, auditBytes] = await Promise.all([
    readFile(paths.specPath), readFile(paths.statusPath), readFile(paths.receiptPath), readFile(paths.auditPath),
  ]);
  return { specBytes, statusBytes, receiptBytes, auditBytes };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-terminal-role-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void describe('D65-I2 terminal acceptance consumes the shared role registry', () => {
  void it('admits every shared-registry role including extract as terminal evidence', async () => {
    for (const role of AUTOPILOT_ROLE_VALUES) {
      await withTempDir(async (root) => {
        const { paths, child } = await writeRoleQuartet(root, role, `unit-${role}`, 1);
        const facts = roleFacts(role);
        const bytes = await loadQuartetBytes(paths);
        const audit = parseAutopilotExecutionAudit(JSON.parse(new TextDecoder().decode(bytes.auditBytes)) as unknown);
        const spec = JSON.parse(new TextDecoder().decode(bytes.specBytes)) as { readonly [k: string]: unknown };
        const status = parseAutopilotStatusEntry(JSON.parse(new TextDecoder().decode(bytes.statusBytes)) as unknown, { unitSpec: spec as never, executionAudit: audit });
        const receipt = parseAutopilotReceipt(JSON.parse(new TextDecoder().decode(bytes.receiptBytes)) as unknown);
        const written = await writeAutopilotChildTerminalAcceptance({
          mainWorktreePath: paths.mainWorktree, runtimeRoot: paths.runtimeRoot, workstream: 'extract-registry',
          child, specPath: paths.specPath, statusPath: paths.statusPath, receiptPath: paths.receiptPath,
          auditPath: paths.auditPath, status, receipt, audit,
        });
        assert.equal(written.acceptance.role, role);
        assert.equal(written.acceptance.verdict, facts.verdict);
        assert.deepEqual(parseAutopilotChildTerminalAcceptance(JSON.parse(JSON.stringify(written.acceptance)) as unknown), written.acceptance);
        assert.doesNotThrow(() => assertAutopilotChildTerminalAcceptanceChain({ acceptance: written.acceptance, child, ...bytes }));
      });
    }
  });

  void it('produces and re-parses a complete extract terminal acceptance end to end', async () => {
    await withTempDir(async (root) => {
      const { paths, child } = await writeRoleQuartet(root, 'extract', 'unit-operator-packet', 3);
      const bytes = await loadQuartetBytes(paths);
      const audit = parseAutopilotExecutionAudit(JSON.parse(new TextDecoder().decode(bytes.auditBytes)) as unknown);
      const spec = JSON.parse(new TextDecoder().decode(bytes.specBytes)) as { readonly [k: string]: unknown };
      const status = parseAutopilotStatusEntry(JSON.parse(new TextDecoder().decode(bytes.statusBytes)) as unknown, { unitSpec: spec as never, executionAudit: audit });
      const receipt = parseAutopilotReceipt(JSON.parse(new TextDecoder().decode(bytes.receiptBytes)) as unknown);
      const written = await writeAutopilotChildTerminalAcceptance({
        mainWorktreePath: paths.mainWorktree, runtimeRoot: paths.runtimeRoot, workstream: 'extract-registry',
        child, specPath: paths.specPath, statusPath: paths.statusPath, receiptPath: paths.receiptPath,
        auditPath: paths.auditPath, status, receipt, audit,
      });
      assert.equal(written.acceptance.role, 'extract');
      assert.equal(written.acceptance.attempt, 3);
      assert.equal(written.acceptance.audit_disposition, 'zero-change');
      // Idempotent re-creation returns the exact same durable artifact.
      const again = await writeAutopilotChildTerminalAcceptance({
        mainWorktreePath: paths.mainWorktree, runtimeRoot: paths.runtimeRoot, workstream: 'extract-registry',
        child, specPath: paths.specPath, statusPath: paths.statusPath, receiptPath: paths.receiptPath,
        auditPath: paths.auditPath, status, receipt, audit,
      });
      assert.deepEqual(again.acceptance, written.acceptance);
      assert.equal(again.evidence.sha256, written.evidence.sha256);
    });
  });

  void it('rejects an unknown role and a tampered non-registry role loudly', () => {
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const acceptance = {
      schema_version: 'autopilot.child_terminal_acceptance.v1', repo_id: 'repo-1', autopilot_id: 'auto-1',
      workstream: 'work-1', workstream_run: 'run-1', unit_id: 'unit-1', role: 'extract', attempt: 1,
      child_lease_id: 'child-run-1-unit-1-1', verdict: 'DONE', transport_result: 'accepted',
      spec: { ref: 'unit-specs/unit-1.extract.attempt-1.json', sha256: digest },
      status: { ref: 'statuses/unit-1.extract.attempt-1.json', sha256: digest },
      receipt: { ref: 'receipts/unit-1.extract.attempt-1.receipt.json', sha256: digest },
      audit: { ref: 'execution-audits/unit-1.extract.attempt-1.json', sha256: digest },
      tool_call_id: 'call-1', carrier_status_sha256: digest, audit_disposition: 'zero-change', created_at: '2026-07-14T00:00:00.000Z',
    } as const;
    // The exact contract role registry is the sole gate; extract passes.
    assert.equal(parseAutopilotChildTerminalAcceptance(JSON.parse(JSON.stringify(acceptance)) as unknown).role, 'extract');
    // A role outside AUTOPILOT_ROLE_VALUES is rejected — no fallback, no private allow-list.
    assert.throws(() => parseAutopilotChildTerminalAcceptance({ ...acceptance, role: 'unknown' }), /terminal acceptance role is invalid/u);
    assert.throws(() => parseAutopilotChildTerminalAcceptance({ ...acceptance, role: 'analyst' }), /terminal acceptance role is invalid/u);
    assert.throws(() => parseAutopilotChildTerminalAcceptance({ ...acceptance, role: 42 }), /must be bounded non-empty text/u);
  });

  void it('fences extract terminal acceptance whose identity diverges from the child lease', async () => {
    await withTempDir(async (root) => {
      const { paths, child } = await writeRoleQuartet(root, 'extract', 'unit-mismatch', 1);
      const bytes = await loadQuartetBytes(paths);
      const audit = parseAutopilotExecutionAudit(JSON.parse(new TextDecoder().decode(bytes.auditBytes)) as unknown);
      const spec = JSON.parse(new TextDecoder().decode(bytes.specBytes)) as { readonly [k: string]: unknown };
      const status = parseAutopilotStatusEntry(JSON.parse(new TextDecoder().decode(bytes.statusBytes)) as unknown, { unitSpec: spec as never, executionAudit: audit });
      const receipt = parseAutopilotReceipt(JSON.parse(new TextDecoder().decode(bytes.receiptBytes)) as unknown);
      const written = await writeAutopilotChildTerminalAcceptance({
        mainWorktreePath: paths.mainWorktree, runtimeRoot: paths.runtimeRoot, workstream: 'extract-registry',
        child, specPath: paths.specPath, statusPath: paths.statusPath, receiptPath: paths.receiptPath,
        auditPath: paths.auditPath, status, receipt, audit,
      });
      const foreignChild: CoordinationChildLease = { ...child, owner: { ...child.owner, attempt: 9 } };
      assert.throws(
        () => assertAutopilotChildTerminalAcceptanceChain({ acceptance: written.acceptance, child: foreignChild, ...bytes }),
        /terminal acceptance identity differs from the authenticated child lease/u,
      );
      // Corrupting the bound status bytes breaks the cryptographic chain.
      const tamperedStatus = new TextEncoder().encode(new TextDecoder().decode(bytes.statusBytes).replace('completed cleanly', 'tampered'));
      assert.throws(
        () => assertAutopilotChildTerminalAcceptanceChain({ acceptance: written.acceptance, child, ...bytes, statusBytes: tamperedStatus }),
        /terminal acceptance status hash differs from its artifact bytes/u,
      );
    });
  });
});
