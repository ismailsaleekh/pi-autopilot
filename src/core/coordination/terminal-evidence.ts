import { parseAutopilotExecutionAudit, parseAutopilotReceipt, parseAutopilotStatusEntry } from '../contracts/index.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA, parseAutopilotChildTerminalAcceptance } from './terminal-acceptance.ts';
import type { CoordinationReconciliationSource } from './types.ts';

interface JsonMap {
  readonly [key: string]: unknown;
}

export interface UnitMergeReservationFacts {
  readonly changedPaths: readonly string[];
  readonly integrationBefore: string;
  readonly integrationAfter: string;
  readonly mergeCommitSha: string;
  readonly executionCommitRef: string;
}

export interface ReservationResolutionIdentity {
  readonly repoId: string;
  readonly autopilotId: string;
  readonly workstream: string;
  readonly workstreamRun: string;
  readonly obligationId: string;
  readonly reservationId: string;
  readonly predecessorReservationId: string;
  readonly predecessorReleasedEventSeq: number;
  readonly predecessorTerminalSha: string;
  readonly dependentUnitId: string;
  readonly dependentAttempt: number;
  readonly dependentMergeRef: string;
  readonly overlappingPaths: readonly string[];
}

export interface ReservationValidationFacts {
  readonly validationUnitId: string;
  readonly validationAttempt: number;
  readonly statusRef: string;
  readonly statusSha256: `sha256:${string}`;
  readonly receiptRef: string;
  readonly receiptSha256: `sha256:${string}`;
  readonly auditRef: string;
  readonly auditSha256: `sha256:${string}`;
}

export interface UnitFailureEvidenceFacts {
  readonly action: 'quarantine' | 'reset' | 'preserve' | 'abort';
  readonly unitWorktreePath: string;
  readonly captureCommitSha: string | null;
  readonly captureRef: string | null;
  readonly gitHeadBefore: string;
  readonly gitHeadAfter: string;
  readonly gitCommonDir: string;
  readonly branch: string;
}

export interface ReconciliationEvidenceIdentity {
  readonly repoKey: string;
  readonly autopilotId: string;
  readonly workstream: string;
  readonly workstreamRun: string;
  readonly source: CoordinationReconciliationSource;
  readonly targetId: string;
  readonly unitId: string | null;
  readonly attempt: number | null;
}

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `${label} must be a JSON object`);
  return value as JsonMap;
}

function text(value: JsonMap, field: string, label: string, maximum = 2048): string {
  const entry = value[field];
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > maximum) throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be bounded non-empty text`);
  return entry;
}

function integer(value: JsonMap, field: string, label: string): number {
  const entry = value[field];
  if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 1) throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be a positive integer`);
  return entry;
}

function stringArray(value: JsonMap, field: string, label: string): readonly string[] {
  const entry = value[field];
  if (!Array.isArray(entry) || entry.length > 4096 || entry.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 1024)) throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be a bounded non-empty string array`);
  const normalized = entry.map((item) => (item as string).replace(/\\/gu, '/'));
  if (new Set(normalized).size !== normalized.length || normalized.some((path) => path.startsWith('/') || path.startsWith('./') || path.startsWith('../') || path.endsWith('/') || path.includes('//') || path.includes('/../') || path === '..' || /^[A-Za-z]:/u.test(path) || path.includes('\u0000') || /^\s/u.test(path))) throw new CoordinationRuntimeError('invalid-state', `${label}.${field} contains duplicate or unsafe repository-relative paths`);
  return Object.freeze(normalized);
}

function jsonDocument(bytes: Uint8Array, label: string): JsonMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-state', `${label} is not valid UTF-8 JSON`, [error instanceof Error ? error.message : String(error)]);
  }
  return record(parsed, label);
}

function assertIdentity(document: JsonMap, expected: ReconciliationEvidenceIdentity, includeAutopilot: boolean): void {
  if (text(document, 'workstream_run', 'reconciliation evidence') !== expected.workstreamRun) throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence workstream_run does not match durable ownership');
  if (includeAutopilot && text(document, 'autopilot_id', 'reconciliation evidence') !== expected.autopilotId) throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence autopilot_id does not match durable ownership');
  if (expected.unitId !== null && text(document, 'unit_id', 'reconciliation evidence') !== expected.unitId) throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence unit_id does not match its release target');
  if (expected.attempt !== null && integer(document, 'attempt', 'reconciliation evidence') !== expected.attempt) throw new CoordinationRuntimeError('invalid-state', 'reconciliation evidence attempt does not match its release target');
}

export function parseUnitAttemptTarget(targetId: string): { readonly unitId: string; readonly attempt: number } {
  const split = targetId.lastIndexOf(':');
  if (split <= 0) throw new CoordinationRuntimeError('invalid-request', 'unit terminal evidence target must be unit-id:attempt');
  const attempt = Number(targetId.slice(split + 1));
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new CoordinationRuntimeError('invalid-request', 'unit terminal evidence target attempt is invalid');
  return { unitId: targetId.slice(0, split), attempt };
}

export function parseUnitMergeReservationFacts(bytes: Uint8Array): UnitMergeReservationFacts {
  const document = jsonDocument(bytes, 'unit-merge reservation evidence');
  if (text(document, 'schema_version', 'unit-merge reservation evidence') !== 'autopilot.unit_merge.v1') throw new CoordinationRuntimeError('invalid-state', 'reservation conversion requires autopilot.unit_merge.v1 evidence');
  const integrationBefore = text(document, 'integration_before', 'unit-merge reservation evidence');
  const integrationAfter = text(document, 'integration_after', 'unit-merge reservation evidence');
  const mergeCommitSha = text(document, 'merge_commit_sha', 'unit-merge reservation evidence');
  const executionCommitRef = text(document, 'execution_commit_ref', 'unit-merge reservation evidence');
  if (!/^[a-f0-9]{7,64}$/u.test(integrationBefore) || !/^[a-f0-9]{7,64}$/u.test(integrationAfter) || !/^[a-f0-9]{7,64}$/u.test(mergeCommitSha)) throw new CoordinationRuntimeError('invalid-state', 'unit-merge integration heads must be lowercase Git object ids');
  if (executionCommitRef.startsWith('/') || executionCommitRef.startsWith('../') || executionCommitRef.includes('/../') || executionCommitRef.includes('\\')) throw new CoordinationRuntimeError('invalid-state', 'unit-merge execution_commit_ref is unsafe');
  return { changedPaths: stringArray(document, 'changed_paths', 'unit-merge reservation evidence'), integrationBefore, integrationAfter, mergeCommitSha, executionCommitRef };
}

export function parseUnitFailureEvidenceFacts(bytes: Uint8Array, expected: ReconciliationEvidenceIdentity): UnitFailureEvidenceFacts {
  const document = jsonDocument(bytes, 'unit failure evidence');
  if (text(document, 'schema_version', 'unit failure evidence') !== 'autopilot.unit_failure.v1') throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence schema is incompatible');
  assertIdentity(document, expected, false);
  const action = text(document, 'action', 'unit failure evidence');
  if (action !== 'quarantine' && action !== 'reset' && action !== 'preserve' && action !== 'abort') throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence action is invalid');
  const nullableText = (field: string): string | null => {
    const value = document[field];
    if (value === null) return null;
    if (typeof value !== 'string' || value.length < 1 || value.length > 1024) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be bounded text or null`);
    return value;
  };
  const commit = (field: string): string => {
    const value = text(document, field, 'unit failure evidence', 64);
    if (!/^[a-f0-9]{40,64}$/u.test(value)) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} is not a full Git object id`);
    return value;
  };
  const captureCommitSha = nullableText('capture_commit_sha');
  if (captureCommitSha !== null && !/^[a-f0-9]{40,64}$/u.test(captureCommitSha)) throw new CoordinationRuntimeError('invalid-state', 'unit failure capture_commit_sha is invalid');
  const captureRef = nullableText('capture_ref');
  if ((action === 'quarantine' || action === 'preserve') && (captureCommitSha === null || captureRef === null)) throw new CoordinationRuntimeError('invalid-state', 'quarantine/preserve evidence requires an immutable capture commit and ref');
  if ((action === 'reset' || action === 'abort') && (captureCommitSha !== null || captureRef !== null)) throw new CoordinationRuntimeError('invalid-state', 'clean reset/abort evidence cannot claim quarantine capture fields');
  if (document['postcondition_worktree_clean'] !== true) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence must assert a clean postcondition');
  return {
    action,
    unitWorktreePath: text(document, 'unit_worktree_path', 'unit failure evidence', 1024),
    captureCommitSha,
    captureRef,
    gitHeadBefore: commit('git_head_before'), gitHeadAfter: commit('git_head_after'),
    gitCommonDir: text(document, 'git_common_dir', 'unit failure evidence', 1024), branch: text(document, 'branch', 'unit failure evidence', 512),
  };
}

export function parseRunTerminalSha(bytes: Uint8Array): string {
  const document = jsonDocument(bytes, 'run terminal evidence');
  const terminalSha = text(document, 'terminal_sha', 'run terminal evidence');
  if (!/^[a-f0-9]{7,64}$/u.test(terminalSha)) throw new CoordinationRuntimeError('invalid-state', 'run terminal evidence lacks a valid terminal Git object id');
  return terminalSha;
}

export function validateReservationIntegrationEvidenceDocument(bytes: Uint8Array, expected: ReservationResolutionIdentity): string {
  const document = jsonDocument(bytes, 'reservation integration evidence');
  if (text(document, 'schema_version', 'reservation integration evidence') !== 'autopilot.reservation_integration.v1' || text(document, 'repo_id', 'reservation integration evidence') !== expected.repoId || text(document, 'autopilot_id', 'reservation integration evidence') !== expected.autopilotId || text(document, 'workstream', 'reservation integration evidence') !== expected.workstream || text(document, 'workstream_run', 'reservation integration evidence') !== expected.workstreamRun || text(document, 'obligation_id', 'reservation integration evidence') !== expected.obligationId || text(document, 'reservation_id', 'reservation integration evidence') !== expected.reservationId || text(document, 'predecessor_reservation_id', 'reservation integration evidence') !== expected.predecessorReservationId) throw new CoordinationRuntimeError('invalid-state', 'reservation integration evidence identity does not match its obligation');
  if (integer(document, 'predecessor_released_event_seq', 'reservation integration evidence') !== expected.predecessorReleasedEventSeq || text(document, 'predecessor_terminal_sha', 'reservation integration evidence') !== expected.predecessorTerminalSha) throw new CoordinationRuntimeError('invalid-state', 'reservation integration evidence does not bind the predecessor release event and terminal commit');
  const covered = stringArray(document, 'covered_paths', 'reservation integration evidence');
  if (expected.overlappingPaths.some((path) => !covered.some((candidate) => candidate === path || candidate.startsWith(`${path}/`) || path.startsWith(`${candidate}/`)))) throw new CoordinationRuntimeError('invalid-state', 'reservation integration evidence does not cover every overlapping path');
  const integrationHead = text(document, 'integration_head', 'reservation integration evidence');
  if (!/^[a-f0-9]{7,64}$/u.test(integrationHead)) throw new CoordinationRuntimeError('invalid-state', 'reservation integration evidence lacks a valid integration head');
  text(document, 'integrated_at', 'reservation integration evidence');
  return integrationHead;
}

export function validateReservationValidationEvidenceDocument(bytes: Uint8Array, expected: ReservationResolutionIdentity, integrationHead: string): ReservationValidationFacts {
  const document = jsonDocument(bytes, 'reservation validation evidence');
  if (text(document, 'schema_version', 'reservation validation evidence') !== 'autopilot.validation_evidence.v1' || text(document, 'workstream', 'reservation validation evidence') !== expected.workstream || text(document, 'verdict', 'reservation validation evidence') !== 'PASS' || text(document, 'integration_head', 'reservation validation evidence') !== integrationHead) throw new CoordinationRuntimeError('invalid-state', 'reservation validation evidence is not a current PASS for the integrated head');
  const sourceUnitId = text(document, 'source_unit_id', 'reservation validation evidence');
  if (sourceUnitId !== expected.dependentUnitId || integer(document, 'source_attempt', 'reservation validation evidence') !== expected.dependentAttempt || text(document, 'unit_merge_ref', 'reservation validation evidence') !== expected.dependentMergeRef) throw new CoordinationRuntimeError('invalid-state', 'reservation validation evidence is not bound to the dependent accepted merge');
  const validationUnitId = text(document, 'validation_unit_id', 'reservation validation evidence');
  if (sourceUnitId === validationUnitId) throw new CoordinationRuntimeError('invalid-state', 'reservation validation must be produced by an independent unit');
  const validationAttempt = integer(document, 'validation_attempt', 'reservation validation evidence');
  const covered = stringArray(document, 'covered_paths', 'reservation validation evidence');
  if (expected.overlappingPaths.some((path) => !covered.some((candidate) => candidate === path || candidate.startsWith(`${path}/`) || path.startsWith(`${candidate}/`)))) throw new CoordinationRuntimeError('invalid-state', 'reservation validation evidence does not cover every overlapping path');
  if (stringArray(document, 'witness_ids', 'reservation validation evidence').length === 0) throw new CoordinationRuntimeError('invalid-state', 'reservation validation PASS requires at least one witness');
  for (const field of ['unit_merge_ref', 'status_ref', 'receipt_ref', 'audit_ref'] as const) {
    const ref = text(document, field, 'reservation validation evidence');
    if (ref.startsWith('/') || ref.startsWith('../') || ref.includes('/../') || ref.includes('\\')) throw new CoordinationRuntimeError('invalid-state', `reservation validation ${field} is unsafe`);
  }
  const digest = (field: string): `sha256:${string}` => {
    const value = text(document, field, 'reservation validation evidence');
    if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new CoordinationRuntimeError('invalid-state', `reservation validation ${field} is not a SHA-256 digest`);
    return value as `sha256:${string}`;
  };
  return {
    validationUnitId,
    validationAttempt,
    statusRef: text(document, 'status_ref', 'reservation validation evidence'), statusSha256: digest('status_sha256'),
    receiptRef: text(document, 'receipt_ref', 'reservation validation evidence'), receiptSha256: digest('receipt_sha256'),
    auditRef: text(document, 'audit_ref', 'reservation validation evidence'), auditSha256: digest('audit_sha256'),
  };
}

export function validateReservationValidationArtifactChain(input: {
  readonly facts: ReservationValidationFacts;
  readonly workstream: string;
  readonly statusBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
  readonly auditBytes: Uint8Array;
}): void {
  let status: ReturnType<typeof parseAutopilotStatusEntry>;
  let receipt: ReturnType<typeof parseAutopilotReceipt>;
  let audit: ReturnType<typeof parseAutopilotExecutionAudit>;
  try {
    status = parseAutopilotStatusEntry(JSON.parse(Buffer.from(input.statusBytes).toString('utf8')) as unknown);
    receipt = parseAutopilotReceipt(JSON.parse(Buffer.from(input.receiptBytes).toString('utf8')) as unknown);
    audit = parseAutopilotExecutionAudit(JSON.parse(Buffer.from(input.auditBytes).toString('utf8')) as unknown);
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-state', 'reservation validator status/receipt/audit contract is invalid', [error instanceof Error ? error.message : String(error)]);
  }
  if (status.workstream !== input.workstream || status.unit_id !== input.facts.validationUnitId || status.attempt !== input.facts.validationAttempt || status.verdict !== 'PASS') throw new CoordinationRuntimeError('invalid-state', 'reservation validator status identity or verdict is invalid');
  if (status.role !== 'validate' && status.role !== 'bughunt') throw new CoordinationRuntimeError('invalid-state', 'reservation validator status must come from an independent validation role');
  if (receipt.tool_name !== 'autopilot_emit_status' || receipt.workstream !== input.workstream || receipt.unit_id !== input.facts.validationUnitId || receipt.attempt !== input.facts.validationAttempt || receipt.status_sha256 !== input.facts.statusSha256 || receipt.role !== status.role) throw new CoordinationRuntimeError('invalid-state', 'reservation validator receipt does not bind the PASS status');
  if (audit.workstream !== input.workstream || audit.unit_id !== input.facts.validationUnitId || audit.attempt !== input.facts.validationAttempt || audit.role !== status.role || audit.classification !== 'clean') throw new CoordinationRuntimeError('invalid-state', 'reservation validator audit is not a clean independent execution audit');
}

export function validateReconciliationEvidenceDocument(bytes: Uint8Array, expected: ReconciliationEvidenceIdentity): void {
  const document = jsonDocument(bytes, 'reconciliation evidence');
  const schema = text(document, 'schema_version', 'reconciliation evidence');
  switch (expected.source) {
    case 'child-process':
      if (schema === AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA) {
        const acceptance = parseAutopilotChildTerminalAcceptance(document);
        if (acceptance.repo_id !== expected.repoKey || acceptance.autopilot_id !== expected.autopilotId || acceptance.workstream !== expected.workstream || acceptance.workstream_run !== expected.workstreamRun || acceptance.child_lease_id !== expected.targetId || expected.unitId === null || expected.attempt === null || acceptance.unit_id !== expected.unitId || acceptance.attempt !== expected.attempt) throw new CoordinationRuntimeError('invalid-state', 'child terminal acceptance identity does not match durable ownership');
        return;
      }
      // Receipt evidence is admitted only for the coordinator's closed historical
      // repair path. New complete-child mutations require the parent-owned
      // acceptance artifact before this generic validator is reached.
      if (schema !== 'autopilot.receipt.v1') throw new CoordinationRuntimeError('invalid-state', 'child-terminal evidence must be a terminal acceptance or historical receipt artifact');
      if (text(document, 'workstream', 'reconciliation evidence') !== expected.workstream) throw new CoordinationRuntimeError('invalid-state', 'historical child receipt workstream does not match durable ownership');
      if (expected.unitId === null || expected.attempt === null || text(document, 'unit_id', 'reconciliation evidence') !== expected.unitId || integer(document, 'attempt', 'reconciliation evidence') !== expected.attempt) throw new CoordinationRuntimeError('invalid-state', 'historical child receipt identity does not match its process lease');
      if (text(document, 'tool_name', 'reconciliation evidence') !== 'autopilot_emit_status') throw new CoordinationRuntimeError('invalid-state', 'historical child receipt does not bind the forced status tool');
      return;
    case 'unit-merge':
      if (schema !== 'autopilot.unit_merge.v1') throw new CoordinationRuntimeError('invalid-state', 'unit-merge release requires autopilot.unit_merge.v1 evidence');
      assertIdentity(document, expected, true);
      if (text(document, 'merge_commit_sha', 'reconciliation evidence').length < 7) throw new CoordinationRuntimeError('invalid-state', 'unit-merge evidence lacks a commit identity');
      parseUnitMergeReservationFacts(bytes);
      return;
    case 'attempt-reset': {
      if (schema !== 'autopilot.unit_failure.v1') throw new CoordinationRuntimeError('invalid-state', 'attempt-reset release requires autopilot.unit_failure.v1 evidence');
      assertIdentity(document, expected, false);
      const action = text(document, 'action', 'reconciliation evidence');
      if (action !== 'reset' && action !== 'abort') throw new CoordinationRuntimeError('invalid-state', 'attempt-reset evidence action must be reset or abort');
      return;
    }
    case 'quarantine-capture': {
      if (schema !== 'autopilot.unit_failure.v1') throw new CoordinationRuntimeError('invalid-state', 'quarantine release requires autopilot.unit_failure.v1 evidence');
      assertIdentity(document, expected, false);
      const action = text(document, 'action', 'reconciliation evidence');
      if (action !== 'quarantine' && action !== 'preserve') throw new CoordinationRuntimeError('invalid-state', 'quarantine evidence action must be quarantine or preserve');
      text(document, 'capture_commit_sha', 'reconciliation evidence');
      return;
    }
    case 'run-close':
    case 'run-abort': {
      if (schema !== 'autopilot.run_terminal.v1') throw new CoordinationRuntimeError('invalid-state', 'run terminal release requires autopilot.run_terminal.v1 evidence');
      if (text(document, 'repo_key', 'reconciliation evidence') !== expected.repoKey || text(document, 'autopilot_id', 'reconciliation evidence') !== expected.autopilotId || text(document, 'workstream_run', 'reconciliation evidence') !== expected.workstreamRun) throw new CoordinationRuntimeError('invalid-state', 'run terminal evidence identity does not match durable ownership');
      const expectedOutcome = expected.source === 'run-close' ? 'closed' : 'aborted';
      if (text(document, 'outcome', 'reconciliation evidence') !== expectedOutcome) throw new CoordinationRuntimeError('invalid-state', `run terminal evidence outcome must be ${expectedOutcome}`);
      text(document, 'terminal_sha', 'reconciliation evidence');
      return;
    }
  }
}
