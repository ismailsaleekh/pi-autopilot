import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from "./parallel-runtime.js";
import { assertD65OrdinaryBoundaryFromEnvironment } from "./coordination/d65-runtime-dispatch.js";
export const AUTOPILOT_DEFAULT_PARALLEL_CAP = 8;
export const AUTOPILOT_MIN_PARALLEL_CAP = 1;
export const AUTOPILOT_MAX_PARALLEL_CAP = 32;
export const AUTOPILOT_SCHEDULER_CONFIG_FILE = 'scheduler-config.json';
export class AutopilotSchedulerConfigError extends Error {
    name = 'AutopilotSchedulerConfigError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotSchedulerConfigError [${code}]: ${message}`);
        this.code = code;
        this.evidence = Object.freeze([...evidence]);
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotSchedulerConfigError(code, message, evidence);
}
export function schedulerConfigPath(runtimeRoot) {
    return join(runtimeRoot, AUTOPILOT_SCHEDULER_CONFIG_FILE);
}
export function assertValidParallelCap(value) {
    if (!Number.isInteger(value) || value < AUTOPILOT_MIN_PARALLEL_CAP || value > AUTOPILOT_MAX_PARALLEL_CAP) {
        fail('invalid-parallel-cap', `parallel_cap must be an integer in range ${String(AUTOPILOT_MIN_PARALLEL_CAP)}..${String(AUTOPILOT_MAX_PARALLEL_CAP)}.`, [String(value)]);
    }
}
export function defaultSchedulerConfig(workstream, now = new Date()) {
    return {
        schema_version: 'autopilot.scheduler_config.v1',
        workstream,
        parallel_cap: AUTOPILOT_DEFAULT_PARALLEL_CAP,
        updated_at: now.toISOString(),
        updated_by: 'default',
    };
}
export async function readSchedulerConfig(input) {
    const path = schedulerConfigPath(input.runtimeRoot);
    if (!existsSync(path))
        return defaultSchedulerConfig(input.workstream, input.now ?? new Date());
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        fail('scheduler-config-read-failed', `failed to read scheduler config: ${errorMessage(error)}`, [path]);
    }
    return parseSchedulerConfig(parsed, input.workstream);
}
export async function writeSchedulerConfig(input) {
    assertValidParallelCap(input.parallelCap);
    const d65 = await assertD65OrdinaryBoundaryFromEnvironment('config-write', input.env ?? process.env);
    if (d65 && input.parallelCap !== 1)
        fail('launch-policy-cap-unauthorized', 'D65 scheduler parallel_cap must remain exactly 1.', [String(input.parallelCap)]);
    const config = {
        schema_version: 'autopilot.scheduler_config.v1',
        workstream: input.workstream,
        parallel_cap: input.parallelCap,
        updated_at: (input.now ?? new Date()).toISOString(),
        updated_by: input.updatedBy,
    };
    await writeJsonAtomic(schedulerConfigPath(input.runtimeRoot), config);
    return config;
}
export function parseSchedulerConfig(value, expectedWorkstream) {
    if (!isRecord(value))
        fail('invalid-scheduler-config', 'scheduler config must be an object.');
    const schemaVersion = expectString(value, 'schema_version');
    if (schemaVersion !== 'autopilot.scheduler_config.v1')
        fail('invalid-scheduler-config', 'scheduler config schema_version is invalid.', [schemaVersion]);
    const workstream = expectString(value, 'workstream');
    if (expectedWorkstream !== undefined && workstream !== expectedWorkstream) {
        fail('scheduler-config-workstream-mismatch', 'scheduler config workstream does not match active workstream.', [workstream, expectedWorkstream]);
    }
    const parallelCap = expectInteger(value, 'parallel_cap');
    assertValidParallelCap(parallelCap);
    const updatedAt = expectString(value, 'updated_at');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(updatedAt))
        fail('invalid-scheduler-config', 'updated_at must be an ISO timestamp.');
    const updatedBy = expectString(value, 'updated_by');
    if (updatedBy !== 'default' && updatedBy !== 'autopilot-config' && updatedBy !== 'runtime-test') {
        fail('invalid-scheduler-config', 'updated_by is invalid.', [updatedBy]);
    }
    return {
        schema_version: 'autopilot.scheduler_config.v1',
        workstream,
        parallel_cap: parallelCap,
        updated_at: updatedAt,
        updated_by: updatedBy,
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function expectString(record, key) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0)
        fail('invalid-scheduler-config', `${key} must be a non-empty string.`);
    return value;
}
function expectInteger(record, key) {
    const value = record[key];
    if (!Number.isInteger(value))
        fail('invalid-scheduler-config', `${key} must be an integer.`);
    return value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
