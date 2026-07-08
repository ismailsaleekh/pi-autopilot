import { spawnSync } from 'node:child_process';
export class AutopilotDiskGateError extends Error {
    name = 'AutopilotDiskGateError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotDiskGateError [${code}]: ${message}`);
        this.code = code;
        this.evidence = Object.freeze([...evidence]);
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotDiskGateError(code, message, evidence);
}
export function assertAutopilotDiskGate(input) {
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
export function projectAutopilotDiskUse(input) {
    const expectedWorktreeCount = input.worktreeCount ?? 1 + (input.expectedParallelUnits ?? input.diskGate.expected_parallel_units);
    const perWorktreeEstimate = Math.max(1_048_576, Math.ceil(input.perWorktreeEstimateBytes));
    const additionalMaterialization = Math.max(0, Math.ceil(input.additionalMaterializationBytes ?? 0));
    const headroom = input.diskGate.headroom_factor;
    const variableBytes = (perWorktreeEstimate * expectedWorktreeCount) + additionalMaterialization;
    const projected = Math.ceil(variableBytes * headroom) + input.diskGate.floor_free_bytes;
    return Object.freeze({
        profile_mode: input.profileMode,
        expected_worktree_count: expectedWorktreeCount,
        per_worktree_estimate_bytes: perWorktreeEstimate,
        additional_materialization_bytes: additionalMaterialization,
        headroom_factor: headroom,
        floor_free_bytes: input.diskGate.floor_free_bytes,
        projected_required_bytes: projected,
    });
}
export function probeFilesystemFreeBytes(path) {
    const result = spawnSync('df', ['-Pk', path], { encoding: 'utf8' });
    if (result.error !== undefined)
        fail('df-spawn-failed', `df failed to spawn: ${result.error.message}`);
    if ((result.status ?? -1) !== 0)
        fail('df-failed', 'failed to inspect filesystem free space.', [result.stderr.trim(), result.stdout.trim()]);
    const lines = result.stdout.trim().split('\n').filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined)
        fail('df-invalid-output', 'df returned no output.');
    const fields = last.trim().split(/\s+/u);
    const availableKb = fields[3];
    if (availableKb === undefined || !/^\d+$/u.test(availableKb)) {
        fail('df-invalid-output', 'df output did not contain POSIX available-kilobyte field.', [last]);
    }
    return Number(availableKb) * 1024;
}
