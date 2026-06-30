import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  autopilotSchemaSha256,
  parseAutopilotReceipt,
  parseAutopilotStatusEntry,
  type AutopilotContractValidationError,
} from '../contracts/index.ts';
import type { AutopilotReceipt, AutopilotStatusEntry, AutopilotUnitSpec } from '../contracts/types.ts';
import {
  buildAutopilotProviderIdentity,
  deriveAutopilotArtifactRoot,
  expectedAutopilotStatusIdentityFromSpec,
  autopilotExpectedIdentityHash,
  type AutopilotProviderIdentity,
} from './identity.ts';

const parseJsonValue: (text: string) => unknown = globalThis.JSON.parse;

export type AutopilotForcedOutputEvidenceErrorCode =
  | 'missing-status'
  | 'missing-receipt'
  | 'status-invalid'
  | 'receipt-invalid'
  | 'receipt-identity-mismatch';

export interface AutopilotForcedOutputEvidenceErrorDetails {
  readonly reason: string;
  readonly status_output?: string;
  readonly receipt_output?: string;
  readonly field?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export class AutopilotForcedOutputEvidenceError extends Error {
  public readonly code: AutopilotForcedOutputEvidenceErrorCode;
  public readonly details: AutopilotForcedOutputEvidenceErrorDetails;

  constructor(
    code: AutopilotForcedOutputEvidenceErrorCode,
    details: AutopilotForcedOutputEvidenceErrorDetails,
  ) {
    super(`${code}: ${details.reason}`);
    this.name = 'AutopilotForcedOutputEvidenceError';
    this.code = code;
    this.details = details;
  }
}

export interface AutopilotValidatedStatusEvidence {
  readonly status: AutopilotStatusEntry;
  readonly receipt: AutopilotReceipt;
  readonly providerIdentity: AutopilotProviderIdentity;
  readonly expectedIdentityHash: `sha256:${string}`;
  readonly schemaSha256: `sha256:${string}`;
}

export async function validateAutopilotStatusEvidence(input: {
  readonly unitSpec: AutopilotUnitSpec;
  readonly artifactRoot?: string;
  readonly providerIdentity?: AutopilotProviderIdentity;
}): Promise<AutopilotValidatedStatusEvidence> {
  const spec = input.unitSpec;
  const artifactRoot = input.artifactRoot ?? deriveAutopilotArtifactRoot(spec);
  const providerIdentity =
    input.providerIdentity ?? buildAutopilotProviderIdentity(spec.model, spec.thinking);
  const schemaSha256 = autopilotSchemaSha256('statusEntry');
  const expectedIdentityHash = autopilotExpectedIdentityHash(
    expectedAutopilotStatusIdentityFromSpec(spec, providerIdentity),
  );

  if (!existsSync(spec.status_output)) {
    throw new AutopilotForcedOutputEvidenceError('missing-status', {
      reason: 'Autopilot status artifact is missing',
      status_output: spec.status_output,
    });
  }
  if (!existsSync(spec.receipt_output)) {
    throw new AutopilotForcedOutputEvidenceError('missing-receipt', {
      reason: 'Autopilot status receipt is missing',
      receipt_output: spec.receipt_output,
    });
  }

  const rawStatus = await readJsonObject(spec.status_output, 'status');
  let status: AutopilotStatusEntry;
  try {
    status = parseAutopilotStatusEntry(rawStatus, { unitSpec: spec, artifactRoot });
  } catch (error) {
    throw new AutopilotForcedOutputEvidenceError('status-invalid', {
      reason: errorMessage(error),
      status_output: spec.status_output,
    });
  }

  const rawReceipt = await readJsonObject(spec.receipt_output, 'receipt');
  let receipt: AutopilotReceipt;
  try {
    receipt = parseAutopilotReceipt(rawReceipt, {
      unitSpec: spec,
      statusOutputPath: spec.status_output,
    });
  } catch (error) {
    throw new AutopilotForcedOutputEvidenceError('receipt-invalid', {
      reason: errorMessage(error),
      receipt_output: spec.receipt_output,
    });
  }

  const mismatches = receiptMismatches({
    receipt,
    providerIdentity,
    schemaSha256,
    expectedIdentityHash,
  });
  if (mismatches.length > 0) {
    const [first] = mismatches;
    throw new AutopilotForcedOutputEvidenceError('receipt-identity-mismatch', {
      reason: mismatches.map((mismatch) => mismatch.reason).join('; '),
      receipt_output: spec.receipt_output,
      ...(first === undefined
        ? {}
        : { field: first.field, expected: first.expected, actual: first.actual }),
    });
  }

  return Object.freeze({
    status,
    receipt,
    providerIdentity,
    expectedIdentityHash,
    schemaSha256,
  });
}

interface ReceiptMismatch {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
  readonly reason: string;
}

function receiptMismatches(input: {
  readonly receipt: AutopilotReceipt;
  readonly providerIdentity: AutopilotProviderIdentity;
  readonly schemaSha256: `sha256:${string}`;
  readonly expectedIdentityHash: `sha256:${string}`;
}): readonly ReceiptMismatch[] {
  const mismatches: ReceiptMismatch[] = [];
  if (input.receipt.schema_sha256 !== input.schemaSha256) {
    mismatches.push({
      field: 'schema_sha256',
      expected: input.schemaSha256,
      actual: input.receipt.schema_sha256,
      reason: 'receipt schema_sha256 does not match current Autopilot status schema',
    });
  }
  if (input.receipt.expected_identity_hash !== input.expectedIdentityHash) {
    mismatches.push({
      field: 'expected_identity_hash',
      expected: input.expectedIdentityHash,
      actual: input.receipt.expected_identity_hash,
      reason: 'receipt expected_identity_hash does not match unit-spec identity',
    });
  }
  for (const key of Object.keys(input.providerIdentity) as Array<
    keyof AutopilotProviderIdentity
  >) {
    const expected = input.providerIdentity[key];
    const actual = input.receipt.provider_identity[key];
    if (actual !== expected) {
      mismatches.push({
        field: `provider_identity.${key}`,
        expected,
        actual,
        reason: `receipt provider_identity.${key} does not match expected provider identity`,
      });
    }
  }
  return mismatches;
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parseJsonValue(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} file is not valid JSON at ${path}: ${errorMessage(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} file must contain one JSON object at ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AutopilotContractValidationError };
