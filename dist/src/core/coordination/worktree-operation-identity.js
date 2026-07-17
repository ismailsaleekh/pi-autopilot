import { createHash } from 'node:crypto';
import { canonicalJson } from "./canonical-json.js";
import { CoordinationRuntimeError } from "./failures.js";
export const AUTOPILOT_WORKTREE_OPERATION_KEY_SCHEMA = 'autopilot.worktree_operation_key.v2';
export const AUTOPILOT_WORKTREE_OPERATION_KEY_DOMAIN = 'autopilot/worktree-operation-key/v2\0';
const CANONICAL_WORKTREE_ID_PATTERN = /^worktree-[a-f0-9]{32}$/u;
/**
 * Derives the frozen v2 operation identity from canonical worktree identity and
 * the complete immutable intent. Callers may use operation_key_sha256 as the
 * durable operation/idempotency digest without truncation.
 */
export function deriveWorktreeOperationKeyV2(input) {
    if (!CANONICAL_WORKTREE_ID_PATTERN.test(input.canonicalWorktreeId))
        throw new CoordinationRuntimeError('invalid-request', 'operation-key v2 requires a deterministic canonical worktree ID');
    const intentJson = canonicalJson(input.completeImmutableIntent);
    const intentHex = createHash('sha256').update(intentJson, 'utf8').digest('hex');
    const operationHex = createHash('sha256')
        .update(AUTOPILOT_WORKTREE_OPERATION_KEY_DOMAIN, 'utf8')
        .update(input.canonicalWorktreeId, 'utf8')
        .update('\0', 'utf8')
        .update(input.operationType, 'utf8')
        .update('\0', 'utf8')
        .update(intentHex, 'utf8')
        .digest('hex');
    return Object.freeze({
        schema_version: AUTOPILOT_WORKTREE_OPERATION_KEY_SCHEMA,
        canonical_worktree_id: input.canonicalWorktreeId,
        operation_type: input.operationType,
        immutable_intent_sha256: `sha256:${intentHex}`,
        operation_key_sha256: `sha256:${operationHex}`,
    });
}
export function operationIdFromWorktreeOperationKey(key) {
    return `operation-${key.operation_key_sha256.slice('sha256:'.length)}`;
}
