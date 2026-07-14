import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { writeJsonAtomic } from './parallel-runtime.ts';
import { parseAutopilotUnitMerge, type AutopilotUnitMerge } from './unit-merge.ts';

export interface AutopilotValidationEvidence {
  readonly schema_version: 'autopilot.validation_evidence.v1';
  readonly workstream: string;
  readonly source_unit_id: string;
  readonly source_attempt: number;
  readonly validation_unit_id: string;
  readonly validation_attempt: number;
  readonly unit_merge_ref: string;
  readonly integration_head: string;
  readonly covered_paths: readonly string[];
  readonly covered_path_groups: readonly string[];
  readonly witness_ids: readonly string[];
  readonly status_ref: string;
  readonly status_sha256: `sha256:${string}`;
  readonly receipt_ref: string;
  readonly receipt_sha256: `sha256:${string}`;
  readonly audit_ref: string;
  readonly audit_sha256: `sha256:${string}`;
  readonly verdict: 'PASS' | 'NEEDS_FIX' | 'BLOCKED';
  readonly validated_at: string;
}

export interface AutopilotValidationStaleness {
  readonly schema_version: 'autopilot.validation_staleness.v1';
  readonly workstream: string;
  readonly stale_validation_ref: string;
  readonly source_unit_id: string;
  readonly source_attempt: number;
  readonly invalidating_unit_merge_ref: string;
  readonly invalidating_unit_id: string;
  readonly invalidating_attempt: number;
  readonly overlapping_paths: readonly string[];
  readonly next_state: 'validation-ready' | 'revalidation-ready';
  readonly created_at: string;
}

export interface AutopilotReservationValidationStaleness {
  readonly schema_version: 'autopilot.validation_staleness.v2';
  readonly workstream: string;
  readonly stale_validation_ref: string;
  readonly source_unit_id: string;
  readonly source_attempt: number;
  readonly invalidating_kind: 'reservation-integration';
  readonly invalidating_ref: string;
  readonly invalidating_obligation_id: string;
  readonly overlapping_paths: readonly string[];
  readonly next_state: 'validation-ready' | 'revalidation-ready';
  readonly created_at: string;
}

export class AutopilotValidationStalenessError extends Error {
  override readonly name = 'AutopilotValidationStalenessError';
  readonly code: string;

  constructor(code: string, message: string) {
    super(`AutopilotValidationStalenessError [${code}]: ${message}`);
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new AutopilotValidationStalenessError(code, message);
}

export function parseValidationEvidence(value: unknown): AutopilotValidationEvidence {
  if (!isRecord(value)) fail('invalid-validation-evidence', 'validation evidence must be an object.');
  const parsed: AutopilotValidationEvidence = {
    schema_version: expectConst(value, 'schema_version', 'autopilot.validation_evidence.v1'),
    workstream: expectString(value, 'workstream'),
    source_unit_id: expectString(value, 'source_unit_id'),
    source_attempt: expectInteger(value, 'source_attempt'),
    validation_unit_id: expectString(value, 'validation_unit_id'),
    validation_attempt: expectInteger(value, 'validation_attempt'),
    unit_merge_ref: expectString(value, 'unit_merge_ref'),
    integration_head: expectString(value, 'integration_head'),
    covered_paths: expectStringArray(value, 'covered_paths'),
    covered_path_groups: expectStringArray(value, 'covered_path_groups'),
    witness_ids: expectStringArray(value, 'witness_ids'),
    status_ref: expectString(value, 'status_ref'),
    status_sha256: expectSha256(value, 'status_sha256'),
    receipt_ref: expectString(value, 'receipt_ref'),
    receipt_sha256: expectSha256(value, 'receipt_sha256'),
    audit_ref: expectString(value, 'audit_ref'),
    audit_sha256: expectSha256(value, 'audit_sha256'),
    verdict: expectVerdict(value),
    validated_at: expectString(value, 'validated_at'),
  };
  if (parsed.source_unit_id === parsed.validation_unit_id) fail('self-certifying-validation', 'source-changing work must be validated by an independent unit.');
  if (parsed.verdict === 'PASS' && parsed.witness_ids.length === 0) fail('witnessless-validation-pass', 'validation PASS requires at least one witness id.');
  return parsed;
}

export async function recordValidationStalenessForMerge(input: {
  readonly runtimeRoot: string;
  readonly workstream: string;
  readonly invalidatingMergeRef: string;
  readonly validationEvidenceRefs: readonly string[];
  readonly now?: Date;
}): Promise<readonly AutopilotValidationStaleness[]> {
  const now = input.now ?? new Date();
  const invalidatingMerge = parseAutopilotUnitMerge(await readRuntimeJson(input.runtimeRoot, input.invalidatingMergeRef));
  const records: AutopilotValidationStaleness[] = [];
  for (const ref of input.validationEvidenceRefs) {
    const validation = parseValidationEvidence(await readRuntimeJson(input.runtimeRoot, ref));
    if (validation.verdict !== 'PASS') continue;
    if (validation.source_unit_id === invalidatingMerge.unit_id && validation.source_attempt === invalidatingMerge.attempt) continue;
    const overlap = overlapping(validation.covered_paths, invalidatingMerge.changed_paths);
    if (overlap.length === 0) continue;
    const record: AutopilotValidationStaleness = {
      schema_version: 'autopilot.validation_staleness.v1',
      workstream: input.workstream,
      stale_validation_ref: ref,
      source_unit_id: validation.source_unit_id,
      source_attempt: validation.source_attempt,
      invalidating_unit_merge_ref: input.invalidatingMergeRef,
      invalidating_unit_id: invalidatingMerge.unit_id,
      invalidating_attempt: invalidatingMerge.attempt,
      overlapping_paths: overlap,
      next_state: validation.source_attempt > 1 ? 'revalidation-ready' : 'validation-ready',
      created_at: now.toISOString(),
    };
    const path = join(input.runtimeRoot, 'validation-staleness', `${validation.source_unit_id}.attempt-${String(validation.source_attempt)}.by-${invalidatingMerge.unit_id}.json`);
    await writeJsonAtomic(path, record);
    records.push(record);
  }
  return Object.freeze(records);
}

export async function recordValidationStalenessForReservationIntegration(input: {
  readonly runtimeRoot: string;
  readonly workstream: string;
  readonly obligationId: string;
  readonly invalidatingRef: string;
  readonly currentIntegrationHead: string;
  readonly changedPaths: readonly string[];
  readonly validationEvidenceRefs: readonly string[];
  readonly now?: Date;
}): Promise<readonly AutopilotReservationValidationStaleness[]> {
  const now = input.now ?? new Date();
  const records: AutopilotReservationValidationStaleness[] = [];
  for (const ref of input.validationEvidenceRefs) {
    const validation = parseValidationEvidence(await readRuntimeJson(input.runtimeRoot, ref));
    if (validation.verdict !== 'PASS' || validation.integration_head === input.currentIntegrationHead) continue;
    const overlap = overlapping(validation.covered_paths, input.changedPaths);
    if (overlap.length === 0) continue;
    const record: AutopilotReservationValidationStaleness = {
      schema_version: 'autopilot.validation_staleness.v2',
      workstream: input.workstream,
      stale_validation_ref: ref,
      source_unit_id: validation.source_unit_id,
      source_attempt: validation.source_attempt,
      invalidating_kind: 'reservation-integration',
      invalidating_ref: input.invalidatingRef,
      invalidating_obligation_id: input.obligationId,
      overlapping_paths: overlap,
      next_state: validation.source_attempt > 1 ? 'revalidation-ready' : 'validation-ready',
      created_at: now.toISOString(),
    };
    const path = reservationValidationStalenessPath(input.runtimeRoot, validation.source_unit_id, validation.source_attempt, input.obligationId, ref);
    if (existsSync(path)) {
      const existing = parseReservationValidationStaleness(await readRuntimeJson(input.runtimeRoot, relative(input.runtimeRoot, path).replace(/\\/gu, '/')));
      if (!sameReservationStaleness(existing, record)) fail('reservation-staleness-drift', `immutable reservation staleness evidence differs on replay: ${path}`);
      records.push(existing);
      continue;
    }
    await writeJsonAtomic(path, record);
    records.push(record);
  }
  return Object.freeze(records);
}

export function reservationValidationStalenessPath(runtimeRoot: string, sourceUnitId: string, sourceAttempt: number, obligationId: string, staleValidationRef: string): string {
  const refDigest = createHash('sha256').update(staleValidationRef, 'utf8').digest('hex').slice(0, 20);
  return join(runtimeRoot, 'validation-staleness', `${sourceUnitId}.attempt-${String(sourceAttempt)}.by-reservation-${obligationId}.${refDigest}.json`);
}

export function parseReservationValidationStaleness(value: unknown): AutopilotReservationValidationStaleness {
  if (!isRecord(value)) fail('invalid-reservation-staleness', 'reservation validation staleness must be an object.');
  const nextState = expectString(value, 'next_state');
  if (nextState !== 'validation-ready' && nextState !== 'revalidation-ready') fail('invalid-reservation-staleness', 'reservation validation staleness next_state is invalid.');
  return {
    schema_version: expectConst(value, 'schema_version', 'autopilot.validation_staleness.v2'),
    workstream: expectString(value, 'workstream'),
    stale_validation_ref: expectString(value, 'stale_validation_ref'),
    source_unit_id: expectString(value, 'source_unit_id'),
    source_attempt: expectInteger(value, 'source_attempt'),
    invalidating_kind: expectConst(value, 'invalidating_kind', 'reservation-integration'),
    invalidating_ref: expectString(value, 'invalidating_ref'),
    invalidating_obligation_id: expectString(value, 'invalidating_obligation_id'),
    overlapping_paths: expectStringArray(value, 'overlapping_paths'),
    next_state: nextState,
    created_at: expectString(value, 'created_at'),
  };
}

function sameReservationStaleness(left: AutopilotReservationValidationStaleness, right: AutopilotReservationValidationStaleness): boolean {
  return left.schema_version === right.schema_version && left.workstream === right.workstream && left.stale_validation_ref === right.stale_validation_ref && left.source_unit_id === right.source_unit_id && left.source_attempt === right.source_attempt && left.invalidating_kind === right.invalidating_kind && left.invalidating_ref === right.invalidating_ref && left.invalidating_obligation_id === right.invalidating_obligation_id && left.next_state === right.next_state && JSON.stringify(left.overlapping_paths) === JSON.stringify(right.overlapping_paths);
}

export function validationCanCloseSourceWork(input: {
  readonly validation: AutopilotValidationEvidence;
  readonly unitMerge: AutopilotUnitMerge;
}): boolean {
  return input.validation.verdict === 'PASS' &&
    input.validation.source_unit_id === input.unitMerge.unit_id &&
    input.validation.source_attempt === input.unitMerge.attempt &&
    input.validation.unit_merge_ref.length > 0 &&
    input.validation.integration_head === input.unitMerge.integration_after;
}

async function readRuntimeJson(runtimeRoot: string, ref: string): Promise<unknown> {
  const path = join(runtimeRoot, ref);
  if (!existsSync(path)) fail('missing-runtime-ref', `runtime ref is missing: ${ref}`);
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function overlapping(left: readonly string[], right: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const path of left) {
    if (right.some((other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`))) out.push(path);
  }
  return Object.freeze([...new Set(out)].sort((a, b) => a.localeCompare(b)));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail('invalid-validation-evidence', `${key} must be a non-empty string.`);
  return value;
}

function expectSha256(record: Readonly<Record<string, unknown>>, key: string): `sha256:${string}` {
  const value = expectString(record, key);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) fail('invalid-validation-evidence', `${key} must be a SHA-256 digest.`);
  return value as `sha256:${string}`;
}

function expectInteger(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) fail('invalid-validation-evidence', `${key} must be an integer.`);
  return value as number;
}

function expectConst<T extends string>(record: Readonly<Record<string, unknown>>, key: string, expected: T): T {
  const value = record[key];
  if (value !== expected) fail('invalid-validation-evidence', `${key} must equal ${expected}.`);
  return expected;
}

function expectStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) fail('invalid-validation-evidence', `${key} must be a string array.`);
  return Object.freeze([...value]);
}

function expectVerdict(record: Readonly<Record<string, unknown>>): 'PASS' | 'NEEDS_FIX' | 'BLOCKED' {
  const value = expectString(record, 'verdict');
  if (value !== 'PASS' && value !== 'NEEDS_FIX' && value !== 'BLOCKED') fail('invalid-validation-evidence', 'verdict is invalid.');
  return value;
}
