import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveAutopilotAuthority, persistAutopilotAuthority } from "./authority.js";
import { parseAutopilotUnitSpec } from "./contracts/validate.js";
import { matchesRepoPathPattern, pathOverlapsOrContains, writeJsonAtomic } from "./parallel-runtime.js";
import { assertD65OrdinaryBoundaryFromEnvironment } from "./coordination/d65-runtime-dispatch.js";
import { reservationSchedulingBlockers } from "./coordination/reservations.js";
export async function writeDispatchArtifacts(input) {
    await assertD65OrdinaryBoundaryFromEnvironment('scheduler-dispatch', input.env ?? process.env);
    const dispatchPath = join(input.runtimeRoot, 'dispatches', `${input.dispatch.dispatch_id}.json`);
    const claimSnapshotPath = join(input.runtimeRoot, 'claim-snapshots', `${input.dispatch.dispatch_id}.json`);
    await mkdir(join(input.runtimeRoot, 'dispatches'), { recursive: true });
    await mkdir(join(input.runtimeRoot, 'claim-snapshots'), { recursive: true });
    for (const selected of input.dispatch.selected)
        await persistAutopilotAuthority(input.runtimeRoot, selected.authority);
    await writeJsonAtomic(dispatchPath, input.dispatch);
    const snapshot = {
        schema_version: 'autopilot.claim_snapshot.v1',
        workstream: input.dispatch.workstream,
        dispatch_id: input.dispatch.dispatch_id,
        claims: input.claims,
        created_at: input.dispatch.created_at,
    };
    await writeJsonAtomic(claimSnapshotPath, snapshot);
    return { dispatchPath, claimSnapshotPath };
}
export async function planNextDispatch(input) {
    const createdAt = (input.now ?? new Date()).toISOString();
    const runningCount = input.runningAttempts.length;
    const capacity = Math.max(0, input.config.parallel_cap - runningCount);
    const selected = [];
    const skipped = [];
    const acceptedClaims = [...input.activeClaims];
    const ordered = [...input.candidates].sort((left, right) => orderKey(input.masterPlan, left.unit_id).localeCompare(orderKey(input.masterPlan, right.unit_id)) || left.unit_id.localeCompare(right.unit_id));
    for (const candidate of ordered) {
        const reasons = [];
        const details = [];
        if (input.contextGate !== 'ok') {
            reasons.push('context-not-ok');
            details.push(`context gate is ${input.contextGate}`);
        }
        if (input.state.status !== 'running') {
            reasons.push('workstream-not-launchable');
            details.push(`state.status is ${input.state.status}`);
        }
        if (input.s2RetentionPressure !== null && input.s2RetentionPressure !== undefined && input.s2RetentionPressure.pausedRuns.includes(input.s2RetentionPressure.workstreamRun)) {
            reasons.push('worktree-unavailable');
            details.push(`S2 retention disk pressure pauses new worktree creation only for ${input.s2RetentionPressure.workstreamRun}`);
        }
        const planUnit = input.masterPlan.units[candidate.unit_id];
        if (planUnit === undefined) {
            reasons.push('unit-not-in-plan');
            details.push('unit is absent from master-plan units');
        }
        else {
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
        if ((candidate.peer_claim_request_refs ?? []).length > 0) {
            reasons.push('waiting-for-peer-release');
            details.push(...(candidate.peer_claim_request_refs ?? []).map((ref) => `claim request ${ref}`));
        }
        if (candidate.worktree_available === false) {
            reasons.push('worktree-unavailable');
            details.push('unit worktree cannot be created or resumed');
        }
        let spec = null;
        let authority = null;
        if (candidate.spec === null) {
            reasons.push('missing-spec');
            details.push('candidate attempt has no schema-valid spec artifact');
        }
        else {
            try {
                spec = parseAutopilotUnitSpec(candidate.spec);
                authority = await deriveAutopilotAuthority({ spec });
            }
            catch (error) {
                reasons.push('invalid-spec');
                details.push(error instanceof Error ? error.message : String(error));
            }
        }
        if (selected.length >= capacity) {
            reasons.push('running-cap-reached');
            details.push(`parallel cap ${String(input.config.parallel_cap)} with ${String(runningCount)} already running`);
        }
        if (spec !== null && authority !== null) {
            const requestedClaims = schedulerClaimsForAuthority(spec, authority);
            const blockers = findSchedulerClaimBlockers(acceptedClaims, requestedClaims, spec.unit_id, spec.attempt);
            if (blockers.length > 0) {
                reasons.push('path-conflict');
                details.push(...blockers);
            }
            if (input.reservationCoordination !== null) {
                const reservationBlockers = reservationSchedulingBlockers({
                    workstreamRun: input.reservationCoordination.workstreamRun,
                    requestedPaths: requestedClaims.map((claim) => claim.path),
                    view: input.reservationCoordination.view,
                });
                if (reservationBlockers.ordering.length > 0) {
                    reasons.push('reservation-ordering');
                    details.push(...reservationBlockers.ordering);
                }
                if (reservationBlockers.integration.length > 0) {
                    reasons.push('reservation-integration-required');
                    details.push(...reservationBlockers.integration);
                }
            }
        }
        const uniqueReasons = unique(reasons);
        if (uniqueReasons.length > 0 || spec === null || authority === null) {
            skipped.push({ unit_id: candidate.unit_id, attempt: candidate.attempt, reasons: uniqueReasons, details: unique(details) });
            continue;
        }
        selected.push({ unit_id: candidate.unit_id, attempt: candidate.attempt, spec, authority, order_key: orderKey(input.masterPlan, candidate.unit_id) });
        acceptedClaims.push(...schedulerClaimsForAuthority(spec, authority));
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
function orderKey(masterPlan, unitId) {
    for (const [laneIndex, lane] of masterPlan.lanes.entries()) {
        const unitIndex = lane.unit_ids.indexOf(unitId);
        if (unitIndex >= 0)
            return `${String(laneIndex).padStart(6, '0')}:${String(unitIndex).padStart(6, '0')}:${unitId}`;
    }
    return `999999:999999:${unitId}`;
}
function schedulerClaimsForAuthority(spec, authority) {
    return Object.freeze([
        ...authority.observations.map((entry) => ({ path: entry.path, claim_type: 'READ', unit_id: spec.unit_id, attempt: spec.attempt })),
        ...authority.edit_intentions.map((entry) => ({ path: entry.path, claim_type: 'WRITE', unit_id: spec.unit_id, attempt: spec.attempt })),
        ...authority.exclusives.map((entry) => ({ path: entry.path, claim_type: 'EXCLUSIVE', unit_id: spec.unit_id, attempt: spec.attempt })),
    ]);
}
function findSchedulerClaimBlockers(existing, requested, unitId, attempt) {
    const blockers = [];
    for (const req of requested) {
        for (const claim of existing) {
            if (claim.unit_id === unitId && claim.attempt === attempt && claim.path === req.path && claim.claim_type === req.claim_type)
                continue;
            if (!pathOverlapsOrContains(req.path, claim.path) && !matchesRepoPathPattern(req.path, claim.path) && !matchesRepoPathPattern(claim.path, req.path))
                continue;
            // A previously selected/active READ already owns immutable worktree bytes
            // and may finish while a new EXCLUSIVE starts. An active EXCLUSIVE blocks
            // a new READ, and WRITE/EXCLUSIVE pairs remain incompatible.
            if (claim.claim_type === 'READ')
                continue;
            if (req.claim_type !== 'EXCLUSIVE' && claim.claim_type !== 'EXCLUSIVE')
                continue;
            blockers.push(`${req.claim_type} ${req.path} conflicts with ${claim.claim_type} ${claim.path} from ${claim.unit_id} attempt ${String(claim.attempt)}`);
        }
    }
    return unique(blockers);
}
function unique(values) {
    return Object.freeze([...new Set(values)]);
}
