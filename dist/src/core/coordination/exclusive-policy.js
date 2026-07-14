import { CoordinationRuntimeError } from "./failures.js";
import { COORDINATION_EXCLUSIVE_OPERATION_KINDS, } from "./types.js";
export const COORDINATION_EXCLUSIVE_MAX_EXPECTED_DURATION_MS = 300_000;
/**
 * Build the closed EXCLUSIVE operation contract used by canonical authority,
 * acquisition, persisted leases, diagnostics, and crash replay. Callers cannot
 * supply a free-form critical-section name or broad resource scope.
 */
export function coordinationExclusiveOperation(input) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u.test(input.operationId)) {
        throw new CoordinationRuntimeError('invalid-request', 'EXCLUSIVE operation_id must be one bounded package identity', [input.operationId]);
    }
    if (!COORDINATION_EXCLUSIVE_OPERATION_KINDS.includes(input.operationKind)) {
        throw new CoordinationRuntimeError('invalid-request', 'EXCLUSIVE operation_kind is outside the closed package policy', [input.operationKind]);
    }
    if (!Number.isSafeInteger(input.expectedDurationMs) || input.expectedDurationMs < 1 || input.expectedDurationMs > COORDINATION_EXCLUSIVE_MAX_EXPECTED_DURATION_MS) {
        throw new CoordinationRuntimeError('invalid-request', 'EXCLUSIVE expected duration must be a positive bounded critical-section interval', [
            `duration=${String(input.expectedDurationMs)}`,
            `maximum=${String(COORDINATION_EXCLUSIVE_MAX_EXPECTED_DURATION_MS)}`,
        ]);
    }
    return Object.freeze({
        schema_version: 'autopilot.exclusive_operation.v1',
        operation_id: input.operationId,
        operation_kind: input.operationKind,
        critical_section: input.operationKind,
        resource_scope: 'exact-repository-path',
        expected_duration_ms: input.expectedDurationMs,
        release_trigger: 'critical-section-exit',
    });
}
/** Preserve ambiguous historical EXCLUSIVE authority without blessing it as a new operation. */
export function legacyMigrationExclusiveOperation(operationId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u.test(operationId)) {
        throw new CoordinationRuntimeError('invalid-request', 'legacy EXCLUSIVE operation_id must be one bounded migration identity', [operationId]);
    }
    return Object.freeze({
        schema_version: 'autopilot.exclusive_operation.v1',
        operation_id: operationId,
        operation_kind: 'legacy-migration-exclusive',
        critical_section: 'legacy-migration-exclusive',
        resource_scope: 'exact-repository-path',
        expected_duration_ms: COORDINATION_EXCLUSIVE_MAX_EXPECTED_DURATION_MS,
        release_trigger: 'critical-section-exit',
    });
}
export function assertExactExclusiveRepositoryPath(path) {
    if (path.endsWith('/**') || path.endsWith('/') || path === '.' || path.length === 0) {
        throw new CoordinationRuntimeError('invalid-request', 'EXCLUSIVE authority requires one exact repository file path; directory and subtree scopes are forbidden', [path]);
    }
}
