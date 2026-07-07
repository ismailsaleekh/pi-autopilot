import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AutopilotMasterPlan, AutopilotState, AutopilotUnitSpec } from './contracts/types.ts';
import { parseAutopilotUnitSpec } from './contracts/validate.ts';
import { matchesRepoPathPattern, pathOverlapsOrContains, writeJsonAtomic, type AutopilotClaimType } from './parallel-runtime.ts';
import type { AutopilotSchedulerConfig } from './scheduler-config.ts';

export type AutopilotSchedulerSkipCode =
  | 'context-not-ok'
  | 'workstream-not-launchable'
  | 'unit-not-in-plan'
  | 'dependency-not-satisfied'
  | 'unit-not-ready'
  | 'missing-spec'
  | 'invalid-spec'
  | 'governing-blocker'
  | 'running-cap-reached'
  | 'path-conflict'
  | 'worktree-unavailable';

export interface AutopilotSchedulerCandidate {
  readonly unit_id: string;
  readonly attempt: number;
  readonly spec: unknown | null;
  readonly governing_blockers?: readonly string[];
  readonly worktree_available?: boolean;
}

export interface AutopilotSchedulerRunningAttempt {
  readonly unit_id: string;
  readonly attempt: number;
}

export interface AutopilotSchedulerClaimView {
  readonly path: string;
  readonly claim_type: AutopilotClaimType;
  readonly unit_id: string;
  readonly attempt: number;
}

export interface AutopilotSchedulerInput {
  readonly workstream: string;
  readonly runtimeRoot: string;
  readonly contextGate: 'ok' | 'halt' | 'unknown';
  readonly state: AutopilotState;
  readonly masterPlan: AutopilotMasterPlan;
  readonly config: AutopilotSchedulerConfig;
  readonly candidates: readonly AutopilotSchedulerCandidate[];
  readonly runningAttempts: readonly AutopilotSchedulerRunningAttempt[];
  readonly activeClaims: readonly AutopilotSchedulerClaimView[];
  readonly now?: Date;
}

export interface AutopilotSchedulerSelectedUnit {
  readonly unit_id: string;
  readonly attempt: number;
  readonly spec: AutopilotUnitSpec;
  readonly order_key: string;
}

export interface AutopilotSchedulerSkippedUnit {
  readonly unit_id: string;
  readonly attempt: number;
  readonly reasons: readonly AutopilotSchedulerSkipCode[];
  readonly details: readonly string[];
}

export interface AutopilotDispatchPlan {
  readonly schema_version: 'autopilot.dispatch.v1';
  readonly workstream: string;
  readonly dispatch_id: string;
  readonly parallel_cap: number;
  readonly running_count: number;
  readonly selected: readonly AutopilotSchedulerSelectedUnit[];
  readonly skipped: readonly AutopilotSchedulerSkippedUnit[];
  readonly created_at: string;
}

export interface AutopilotClaimSnapshot {
  readonly schema_version: 'autopilot.claim_snapshot.v1';
  readonly workstream: string;
  readonly dispatch_id: string;
  readonly claims: readonly AutopilotSchedulerClaimView[];
  readonly created_at: string;
}

export async function writeDispatchArtifacts(input: {
  readonly runtimeRoot: string;
  readonly dispatch: AutopilotDispatchPlan;
  readonly claims: readonly AutopilotSchedulerClaimView[];
}): Promise<{ readonly dispatchPath: string; readonly claimSnapshotPath: string }> {
  const dispatchPath = join(input.runtimeRoot, 'dispatches', `${input.dispatch.dispatch_id}.json`);
  const claimSnapshotPath = join(input.runtimeRoot, 'claim-snapshots', `${input.dispatch.dispatch_id}.json`);
  await mkdir(join(input.runtimeRoot, 'dispatches'), { recursive: true });
  await mkdir(join(input.runtimeRoot, 'claim-snapshots'), { recursive: true });
  await writeJsonAtomic(dispatchPath, input.dispatch);
  const snapshot: AutopilotClaimSnapshot = {
    schema_version: 'autopilot.claim_snapshot.v1',
    workstream: input.dispatch.workstream,
    dispatch_id: input.dispatch.dispatch_id,
    claims: input.claims,
    created_at: input.dispatch.created_at,
  };
  await writeJsonAtomic(claimSnapshotPath, snapshot);
  return { dispatchPath, claimSnapshotPath };
}

export function planNextDispatch(input: AutopilotSchedulerInput): AutopilotDispatchPlan {
  const createdAt = (input.now ?? new Date()).toISOString();
  const runningCount = input.runningAttempts.length;
  const capacity = Math.max(0, input.config.parallel_cap - runningCount);
  const selected: AutopilotSchedulerSelectedUnit[] = [];
  const skipped: AutopilotSchedulerSkippedUnit[] = [];
  const acceptedClaims: AutopilotSchedulerClaimView[] = [...input.activeClaims];

  const ordered = [...input.candidates].sort((left, right) => orderKey(input.masterPlan, left.unit_id).localeCompare(orderKey(input.masterPlan, right.unit_id)) || left.unit_id.localeCompare(right.unit_id));
  for (const candidate of ordered) {
    const reasons: AutopilotSchedulerSkipCode[] = [];
    const details: string[] = [];
    if (input.contextGate !== 'ok') {
      reasons.push('context-not-ok');
      details.push(`context gate is ${input.contextGate}`);
    }
    if (input.state.status !== 'running') {
      reasons.push('workstream-not-launchable');
      details.push(`state.status is ${input.state.status}`);
    }
    const planUnit = input.masterPlan.units[candidate.unit_id];
    if (planUnit === undefined) {
      reasons.push('unit-not-in-plan');
      details.push('unit is absent from master-plan units');
    } else {
      if (planUnit.state !== 'ready' && planUnit.state !== 'queued') {
        reasons.push('unit-not-ready');
        details.push(`master-plan unit state is ${planUnit.state}`);
      }
      for (const dependency of planUnit.dependencies) {
        const depState = input.state.units[dependency]?.state ?? input.masterPlan.units[dependency]?.state;
        if (depState !== 'completed') {
          reasons.push('dependency-not-satisfied');
          details.push(`dependency ${dependency} is ${depState ?? 'missing'}`);
        }
      }
    }
    const stateUnit = input.state.units[candidate.unit_id];
    if (stateUnit !== undefined && stateUnit.state !== 'queued' && stateUnit.state !== 'ready') {
      reasons.push('unit-not-ready');
      details.push(`state unit state is ${stateUnit.state}`);
    }
    if ((candidate.governing_blockers ?? []).length > 0) {
      reasons.push('governing-blocker');
      details.push(...(candidate.governing_blockers ?? []));
    }
    if (candidate.worktree_available === false) {
      reasons.push('worktree-unavailable');
      details.push('unit worktree cannot be created or resumed');
    }
    let spec: AutopilotUnitSpec | null = null;
    if (candidate.spec === null) {
      reasons.push('missing-spec');
      details.push('candidate attempt has no schema-valid spec artifact');
    } else {
      try {
        spec = parseAutopilotUnitSpec(candidate.spec);
      } catch (error) {
        reasons.push('invalid-spec');
        details.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (selected.length >= capacity) {
      reasons.push('running-cap-reached');
      details.push(`parallel cap ${String(input.config.parallel_cap)} with ${String(runningCount)} already running`);
    }
    if (spec !== null) {
      const requestedClaims = schedulerClaimsForSpec(spec);
      const blockers = findSchedulerClaimBlockers(acceptedClaims, requestedClaims, spec.unit_id, spec.attempt);
      if (blockers.length > 0) {
        reasons.push('path-conflict');
        details.push(...blockers);
      }
    }
    const uniqueReasons = unique(reasons);
    if (uniqueReasons.length > 0 || spec === null) {
      skipped.push({ unit_id: candidate.unit_id, attempt: candidate.attempt, reasons: uniqueReasons, details: unique(details) });
      continue;
    }
    selected.push({ unit_id: candidate.unit_id, attempt: candidate.attempt, spec, order_key: orderKey(input.masterPlan, candidate.unit_id) });
    acceptedClaims.push(...schedulerClaimsForSpec(spec));
  }

  return {
    schema_version: 'autopilot.dispatch.v1',
    workstream: input.workstream,
    dispatch_id: `dispatch-${createdAt.replace(/[-:.]/gu, '').replace(/Z$/u, 'Z')}`,
    parallel_cap: input.config.parallel_cap,
    running_count: runningCount,
    selected,
    skipped,
    created_at: createdAt,
  };
}

function orderKey(masterPlan: AutopilotMasterPlan, unitId: string): string {
  for (const [laneIndex, lane] of masterPlan.lanes.entries()) {
    const unitIndex = lane.unit_ids.indexOf(unitId);
    if (unitIndex >= 0) return `${String(laneIndex).padStart(6, '0')}:${String(unitIndex).padStart(6, '0')}:${unitId}`;
  }
  return `999999:999999:${unitId}`;
}

function schedulerClaimsForSpec(spec: AutopilotUnitSpec): readonly AutopilotSchedulerClaimView[] {
  const claims: AutopilotSchedulerClaimView[] = [];
  for (const path of spec.owned_paths) claims.push({ path, claim_type: 'WRITE', unit_id: spec.unit_id, attempt: spec.attempt });
  for (const path of spec.read_only_paths) claims.push({ path, claim_type: 'READ', unit_id: spec.unit_id, attempt: spec.attempt });
  return claims;
}

function findSchedulerClaimBlockers(
  existing: readonly AutopilotSchedulerClaimView[],
  requested: readonly AutopilotSchedulerClaimView[],
  unitId: string,
  attempt: number,
): readonly string[] {
  const blockers: string[] = [];
  for (const req of requested) {
    for (const claim of existing) {
      if (claim.unit_id === unitId && claim.attempt === attempt && claim.path === req.path && claim.claim_type === req.claim_type) continue;
      if (!pathOverlapsOrContains(req.path, claim.path) && !matchesRepoPathPattern(req.path, claim.path) && !matchesRepoPathPattern(claim.path, req.path)) continue;
      if (req.claim_type === 'READ' && claim.claim_type === 'READ') continue;
      blockers.push(`${req.claim_type} ${req.path} conflicts with ${claim.claim_type} ${claim.path} from ${claim.unit_id} attempt ${String(claim.attempt)}`);
    }
  }
  return unique(blockers);
}

function unique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)]);
}
