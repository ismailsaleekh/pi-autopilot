import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  parseAutopilotReceipt,
  parseAutopilotStatusEntry,
} from '../contracts/index.ts';
import type { AutopilotReceipt, AutopilotStatusEntry } from '../contracts/types.ts';
import type { AutopilotStatusToolContext } from './identity.ts';

export class AutopilotForcedOutputWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutopilotForcedOutputWriteError';
  }
}

export interface AutopilotEmitResult {
  readonly status: AutopilotStatusEntry;
  readonly receipt: AutopilotReceipt;
  readonly statusOutput: string;
  readonly receiptOutput: string;
  readonly statusSha256: `sha256:${string}`;
  readonly schemaSha256: `sha256:${string}`;
  readonly expectedIdentityHash: `sha256:${string}`;
}

export function emitAutopilotStatus(
  context: AutopilotStatusToolContext,
  statusValue: unknown,
  toolCallId: string,
): AutopilotEmitResult {
  const status = parseAutopilotStatusEntry(statusValue, {
    unitSpec: context.unit_spec,
    artifactRoot: context.artifact_root,
  });
  assertOutputPathsFresh(context);
  ensureWithinRoot(context.artifact_root, context.status_output, 'status_output');
  ensureWithinRoot(context.artifact_root, context.receipt_output, 'receipt_output');

  const statusBytes = `${JSON.stringify(status, null, 2)}\n`;
  const statusSha256 = sha256Text(statusBytes);
  const receipt: AutopilotReceipt = {
    schema_version: 'autopilot.receipt.v1',
    tool_name: 'autopilot_emit_status',
    workstream: context.unit_spec.workstream,
    unit_id: context.unit_spec.unit_id,
    role: context.unit_spec.role,
    attempt: context.unit_spec.attempt,
    emitted_at: new Date().toISOString(),
    status_output: context.status_output,
    status_sha256: statusSha256,
    schema_sha256: context.schema_sha256,
    tool_call_id: toolCallId,
    provider_identity: context.provider_identity,
    expected_identity_hash: context.expected_identity_hash,
  };
  parseAutopilotReceipt(receipt, {
    unitSpec: context.unit_spec,
    statusOutputPath: context.status_output,
  });

  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;

  let statusTemp: string;
  try {
    statusTemp = writeTempFileSync(context.status_output, statusBytes);
  } catch (error) {
    throw new AutopilotForcedOutputWriteError(
      `failed to write status temp: ${errorMessage(error)}`,
    );
  }

  let receiptTemp: string;
  try {
    receiptTemp = writeTempFileSync(context.receipt_output, receiptBytes);
  } catch (error) {
    rmSync(statusTemp, { force: true });
    throw new AutopilotForcedOutputWriteError(
      `failed to write receipt temp: ${errorMessage(error)}`,
    );
  }

  try {
    renameSync(statusTemp, context.status_output);
  } catch (error) {
    rmSync(statusTemp, { force: true });
    rmSync(receiptTemp, { force: true });
    throw new AutopilotForcedOutputWriteError(
      `failed to commit status: ${errorMessage(error)}`,
    );
  }

  try {
    renameSync(receiptTemp, context.receipt_output);
  } catch (error) {
    rmSync(context.status_output, { force: true });
    rmSync(receiptTemp, { force: true });
    throw new AutopilotForcedOutputWriteError(
      `failed to commit receipt: ${errorMessage(error)}`,
    );
  }

  return Object.freeze({
    status,
    receipt,
    statusOutput: context.status_output,
    receiptOutput: context.receipt_output,
    statusSha256,
    schemaSha256: context.schema_sha256,
    expectedIdentityHash: context.expected_identity_hash,
  });
}

export function assertOutputPathsFresh(context: AutopilotStatusToolContext): void {
  if (existsSync(context.status_output)) {
    throw new AutopilotForcedOutputWriteError(
      `stale Autopilot status_output already exists: ${context.status_output}`,
    );
  }
  if (existsSync(context.receipt_output)) {
    throw new AutopilotForcedOutputWriteError(
      `stale Autopilot receipt_output already exists: ${context.receipt_output}`,
    );
  }
}

export function ensureWithinRoot(root: string, path: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (
    rel === '' ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    rel.split(sep).includes('..')
  ) {
    throw new AutopilotForcedOutputWriteError(
      `${label} escapes Autopilot artifact root: ${path}`,
    );
  }
}

export function writeFileAtomicSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tempPath, text, { encoding: 'utf8', flag: 'wx' });
  try {
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function writeTempFileSync(targetPath: string, text: string): string {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tempPath, text, { encoding: 'utf8', flag: 'wx' });
  return tempPath;
}

function sha256Text(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
