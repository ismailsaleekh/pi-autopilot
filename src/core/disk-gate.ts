import { spawnSync } from 'node:child_process';

import { checkedAdd, checkedCeilMultiply, checkedMultiply, GitStreamingQueryError } from './git-process.ts';
import type { AutopilotCheckoutDiskGateConfig, AutopilotCheckoutMode } from './checkout-profile.ts';

export interface AutopilotDiskGateProjectionInput {
  readonly profileMode: AutopilotCheckoutMode;
  readonly diskGate: AutopilotCheckoutDiskGateConfig;
  readonly perWorktreeEstimateBytes: number;
  readonly expectedParallelUnits?: number;
  readonly additionalMaterializationBytes?: number;
  readonly worktreeCount?: number;
}

export interface AutopilotDiskGateProjection {
  readonly profile_mode: AutopilotCheckoutMode;
  readonly expected_worktree_count: number;
  readonly per_worktree_estimate_bytes: number;
  readonly additional_materialization_bytes: number;
  readonly headroom_factor: number;
  readonly floor_free_bytes: number;
  readonly projected_required_bytes: number;
}

export interface AutopilotDiskGateCheck {
  readonly free_bytes: number;
  readonly projection: AutopilotDiskGateProjection;
}

export class AutopilotDiskGateError extends Error {
  override readonly name = 'AutopilotDiskGateError';
  readonly code: string;
  readonly evidence: readonly string[];

  constructor(code: string, message: string, evidence: readonly string[] = []) {
    super(`AutopilotDiskGateError [${code}]: ${message}`);
    this.code = code;
    this.evidence = Object.freeze([...evidence]);
  }
}

function fail(code: string, message: string, evidence: readonly string[] = []): never {
  throw new AutopilotDiskGateError(code, message, evidence);
}

export function assertAutopilotDiskGate(input: {
  readonly path: string;
  readonly projection: AutopilotDiskGateProjectionInput;
}): AutopilotDiskGateCheck {
  const projection = projectAutopilotDiskUse(input.projection);
  const freeBytes = probeFilesystemFreeBytes(input.path);
  if (freeBytes < projection.projected_required_bytes) {
    fail('insufficient-space', 'Autopilot sparse worktree disk gate refused before mutation: projected worktree footprint exceeds available space.', [
      `free_bytes=${String(freeBytes)}`,
      `projected_required_bytes=${String(projection.projected_required_bytes)}`,
      `profile_mode=${projection.profile_mode}`,
      `expected_worktree_count=${String(projection.expected_worktree_count)}`,
      `per_worktree_estimate_bytes=${String(projection.per_worktree_estimate_bytes)}`,
      `additional_materialization_bytes=${String(projection.additional_materialization_bytes)}`,
      'remediation=close/abort stale Autopilot runs, run worktree GC, free disk space, split large claims, or explicitly tune .autopilot/checkout-profile.json disk_gate values',
    ]);
  }
  return Object.freeze({ free_bytes: freeBytes, projection });
}

export function projectAutopilotDiskUse(input: AutopilotDiskGateProjectionInput): AutopilotDiskGateProjection {
  try {
    const expectedParallelUnits = input.expectedParallelUnits ?? input.diskGate.expected_parallel_units;
    const expectedWorktreeCount = input.worktreeCount ?? checkedAdd(1, expectedParallelUnits, 'disk-projection-overflow');
    const perWorktreeEstimate = Math.max(1_048_576, Math.ceil(input.perWorktreeEstimateBytes));
    const additionalMaterialization = Math.max(0, Math.ceil(input.additionalMaterializationBytes ?? 0));
    if (!Number.isSafeInteger(perWorktreeEstimate) || !Number.isSafeInteger(additionalMaterialization) || !Number.isSafeInteger(expectedWorktreeCount)) {
      fail('disk-projection-overflow', 'disk projection rejected a non-safe-integer operand.');
    }
    const { numerator, denominator } = parseHeadroomFactor(input.diskGate.headroom_factor);
    const variableBytes = checkedAdd(checkedMultiply(perWorktreeEstimate, expectedWorktreeCount, 'disk-projection-overflow'), additionalMaterialization, 'disk-projection-overflow');
    const headroomBytes = checkedCeilMultiply(variableBytes, numerator, denominator, 'disk-projection-overflow');
    const projected = checkedAdd(headroomBytes, input.diskGate.floor_free_bytes, 'disk-projection-overflow');
    const headroom = input.diskGate.headroom_factor;
    return Object.freeze({
      profile_mode: input.profileMode,
      expected_worktree_count: expectedWorktreeCount,
      per_worktree_estimate_bytes: perWorktreeEstimate,
      additional_materialization_bytes: additionalMaterialization,
      headroom_factor: headroom,
      floor_free_bytes: input.diskGate.floor_free_bytes,
      projected_required_bytes: projected,
    });
  } catch (error) {
    if (error instanceof AutopilotDiskGateError) throw error;
    if (error instanceof GitStreamingQueryError) fail(error.code, error.message);
    throw error;
  }
}

function parseHeadroomFactor(headroom: number): { readonly numerator: number; readonly denominator: number } {
  if (!Number.isFinite(headroom) || headroom <= 0) fail('disk-projection-overflow', 'headroom_factor must be a finite positive number.', [String(headroom)]);
  const text = String(headroom);
  if (text.startsWith('-')) fail('disk-projection-overflow', 'headroom_factor must be positive.', [text]);
  const parts = text.split('.');
  const intDigits = parts[0] ?? '';
  const fracDigits = parts.length > 1 ? (parts[1] ?? '') : '';
  if (parts.length > 2 || !/^\d*$/u.test(intDigits) || !/^\d*$/u.test(fracDigits)) {
    fail('disk-projection-overflow', 'headroom_factor must be a finite decimal number.', [text]);
  }
  if (fracDigits.length > 15) fail('disk-projection-overflow', 'headroom_factor has too many fractional digits for exact projection.', [text]);
  const denominator = fracDigits.length === 0 ? 1 : 10 ** fracDigits.length;
  const numerator = (Number(intDigits.length === 0 ? '0' : intDigits) * denominator) + (fracDigits.length === 0 ? 0 : Number(fracDigits.length === 0 ? '0' : fracDigits));
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    fail('disk-projection-overflow', 'headroom_factor numerator/denominator exceeded the safe-integer range.', [text]);
  }
  return Object.freeze({ numerator, denominator });
}

export function probeFilesystemFreeBytes(path: string): number {
  const result = spawnSync('df', ['-Pk', path], { encoding: 'utf8' });
  if (result.error !== undefined) fail('df-spawn-failed', `df failed to spawn: ${result.error.message}`);
  if ((result.status ?? -1) !== 0) fail('df-failed', 'failed to inspect filesystem free space.', [result.stderr.trim(), result.stdout.trim()]);
  const lines = result.stdout.trim().split('\n').filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) fail('df-invalid-output', 'df returned no output.');
  const fields = last.trim().split(/\s+/u);
  const availableKb = fields[3];
  if (availableKb === undefined || !/^\d+$/u.test(availableKb)) {
    fail('df-invalid-output', 'df output did not contain POSIX available-kilobyte field.', [last]);
  }
  return Number(availableKb) * 1024;
}
