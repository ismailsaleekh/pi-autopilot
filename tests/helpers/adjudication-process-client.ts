import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAdjudicationAssignment, parseCoordinationChildLease } from '../../src/core/coordination/contracts.ts';
import { parseAutopilotExecutionAudit, parseAutopilotReceipt, parseAutopilotStatusEntry, parseAutopilotUnitSpec } from '../../src/core/contracts/index.ts';
import { writeAutopilotChildTerminalAcceptance } from '../../src/core/coordination/terminal-acceptance.ts';

function argument(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}

function integerArgument(index: number, label: string): number {
  const value = Number(argument(index, label));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

const stateRoot = argument(2, 'state root');
const repoId = argument(3, 'repo id');
const workstreamRun = argument(4, 'workstream run');
const assignmentId = argument(5, 'assignment id');
const autopilotId = argument(6, 'autopilot id');
const sessionId = argument(7, 'session id');
const sessionGeneration = integerArgument(8, 'session generation');
const runVersion = integerArgument(9, 'run version');
const sessionLeaseId = argument(10, 'session lease id');
const sessionToken = argument(11, 'session token');
const bootId = argument(12, 'boot id');
const unitWorktree = argument(13, 'unit worktree');
const unitId = argument(14, 'unit id');
const workstream = argument(15, 'workstream');

const client = new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot }, autoStart: false });
const bundleResponse = await client.mutate('claim-adjudication-assignment', { repoId, workstreamRun, sessionId, fencingGeneration: sessionGeneration, expectedVersion: runVersion, idempotencyKey: `claim-adjudication-process:${assignmentId}` }, { unit_id: unitId, attempt: 1, session_lease_id: sessionLeaseId, session_token: sessionToken });
const assignment = parseCoordinationAdjudicationAssignment(bundleResponse.payload['adjudication_assignment']);
if (assignment.assignment_id !== assignmentId) throw new Error(`assignment ${assignmentId} was not claimed exactly`);
const rawDocuments = bundleResponse.payload['authoritative_documents'];
if (!Array.isArray(rawDocuments)) throw new Error('assignment bundle has no authoritative documents');
for (const clause of assignment.conflicting_clauses) {
  const matching = rawDocuments.find((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const artifact = value['artifact'];
    if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) return false;
    const evidence = artifact['evidence'];
    return typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence) && evidence['ref'] === clause.authoritative_ref.ref && evidence['sha256'] === clause.authoritative_ref.sha256;
  });
  if (typeof matching !== 'object' || matching === null || Array.isArray(matching) || typeof matching['content_utf8'] !== 'string' || !matching['content_utf8'].includes(clause.exact_requirement)) throw new Error(`assigned authoritative document does not contain clause ${clause.clause_id}`);
}
const childId = `child-${workstreamRun}-${unitId}-1`;
const childToken = createHash('sha256').update(`${assignmentId}\0${String(process.pid)}`, 'utf8').digest('hex');
const registered = await client.mutate('register-child', {
  repoId,
  workstreamRun,
  sessionId,
  fencingGeneration: sessionGeneration,
  expectedVersion: runVersion,
  idempotencyKey: `register-adjudicator-process:${assignmentId}`,
}, {
  child_lease_id: childId,
  autopilot_id: autopilotId,
  unit_id: unitId,
  attempt: 1,
  pid: process.pid,
  boot_id: bootId,
  child_token: childToken,
  session_lease_id: sessionLeaseId,
  session_token: sessionToken,
  lease_expires_at: '2099-01-01T00:00:00.000Z',
});
const childLease = parseCoordinationChildLease(registered.payload['child']);
const mainWorktree = join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main');
const specPath = join(mainWorktree, '.pi', 'autopilot', workstream, 'unit-specs', `${unitId}.json`);
const spec = parseAutopilotUnitSpec(JSON.parse(await readFile(specPath, 'utf8')) as unknown);
const runtimeRoot = dirname(dirname(spec.status_output));
const adjudication = {
  schema_version: 'autopilot.planning_contradiction_adjudication.v1',
  adjudication_id: assignment.assignment_id,
  adjudicator: assignment.adjudicator,
  adjudicator_role: 'adjudicate',
  independent_from_runs: assignment.participating_runs,
  verdict: 'major-contradiction',
  conflicting_clauses: assignment.conflicting_clauses,
  sequencing_can_satisfy_both: false,
  partitioning_can_satisfy_both: false,
  ownership_transfer_can_satisfy_both: false,
  rebase_revalidation_can_satisfy_both: false,
  replanning_can_preserve_both: false,
  operational_reasons: [],
  decision_options: assignment.decision_options,
} as const;
const adjudicationPath = join(unitWorktree, 'adjudications', `${assignment.assignment_id}.json`);
await mkdir(dirname(adjudicationPath), { recursive: true });
await writeFile(adjudicationPath, `${JSON.stringify(adjudication, null, 2)}\n`, 'utf8');
const head = 'c'.repeat(40);
const statusDocument = { schema_version: 'autopilot.status.v1', workstream: spec.workstream, unit_id: spec.unit_id, role: spec.role, attempt: spec.attempt, verdict: 'DONE', severity: 'clean', summary: 'Assigned contradiction was independently adjudicated.', changed_paths: [], findings: [], commands: [], evidence_refs: [], report_ref: null, next_action: 'submit accepted adjudication' };
await mkdir(dirname(spec.status_output), { recursive: true });
await writeFile(spec.status_output, `${JSON.stringify(statusDocument, null, 2)}\n`, 'utf8');
const statusBytes = await readFile(spec.status_output);
const statusSha = `sha256:${createHash('sha256').update(statusBytes).digest('hex')}` as const;
const receiptDocument = { schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: spec.workstream, unit_id: spec.unit_id, role: spec.role, attempt: spec.attempt, emitted_at: '2026-07-14T10:00:00.000Z', status_output: spec.status_output, status_sha256: statusSha, schema_sha256: `sha256:${'d'.repeat(64)}`, tool_call_id: `tool-${unitId}`, provider_identity: { provider_id: 'openai-codex', requested_model_id: spec.model, executed_model_id: spec.model, api: 'openai-codex-responses', thinking_level: spec.thinking }, expected_identity_hash: `sha256:${'e'.repeat(64)}` };
await mkdir(dirname(spec.receipt_output), { recursive: true });
await writeFile(spec.receipt_output, `${JSON.stringify(receiptDocument, null, 2)}\n`, 'utf8');
const auditPath = join(runtimeRoot, 'execution-audits', `${unitId}.adjudicate.attempt-1.json`);
const auditDocument = { schema_version: 'autopilot.execution_audit.v1', workstream: spec.workstream, unit_id: spec.unit_id, role: spec.role, attempt: spec.attempt, audited_at: '2026-07-14T10:00:00.000Z', cwd: spec.cwd, git_head: head, baseline_head: head, post_run_head: head, head_change_kind: 'none', committed_changed_paths: [], dirty_baseline: false, dirty_baseline_paths: [], dirty_relevant_paths: [], actual_changed_paths: [], status_reported_changed_paths: [], omitted_status_changes: [], reported_but_not_actual_changes: [], outside_owned_paths: [], read_only_touched_paths: [], untouchable_touched_paths: [], path_counts: { dirty_baseline_paths: 0, dirty_relevant_paths: 0, actual_changed_paths: 0, status_reported_changed_paths: 0, omitted_status_changes: 0, reported_but_not_actual_changes: 0, outside_owned_paths: 0, read_only_touched_paths: 0, untouchable_touched_paths: 0 }, truncated_path_sets: [], declared_validation_commands: [], status_reported_commands: [], command_coverage_gaps: [], classification: 'clean', evidence_refs: [], summary: 'Adjudication execution audit is clean.' };
await mkdir(dirname(auditPath), { recursive: true });
await writeFile(auditPath, `${JSON.stringify(auditDocument, null, 2)}\n`, 'utf8');
const audit = parseAutopilotExecutionAudit(auditDocument);
const status = parseAutopilotStatusEntry(statusDocument, { unitSpec: spec, executionAudit: audit });
const receipt = parseAutopilotReceipt(receiptDocument);
const terminalAcceptance = await writeAutopilotChildTerminalAcceptance({ mainWorktreePath: mainWorktree, runtimeRoot, workstream: spec.workstream, child: childLease, specPath, statusPath: spec.status_output, receiptPath: spec.receipt_output, auditPath, status, receipt, audit });
await client.mutate('complete-adjudication', {
  repoId,
  workstreamRun,
  sessionId: null,
  fencingGeneration: null,
  expectedVersion: 1,
  idempotencyKey: `complete-adjudication-process:${assignment.assignment_id}`,
}, {
  assignment_id: assignment.assignment_id,
  adjudication_path: adjudicationPath,
  terminal_evidence_ref: terminalAcceptance.evidence.ref,
  terminal_evidence_sha256: terminalAcceptance.evidence.sha256,
  child_lease_id: childId,
  child_token: childToken,
  pid: process.pid,
  boot_id: bootId,
});
console.log(JSON.stringify({ assignment_id: assignment.assignment_id, adjudication_path: adjudicationPath }));
