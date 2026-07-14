import { AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA } from "./terminal-acceptance.js";
import { AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA, AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, AUTOPILOT_COORDINATOR_REQUEST_SCHEMA, AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA, COORDINATION_ACQUISITION_KINDS, COORDINATION_ACQUISITION_STATES, COORDINATION_CHILD_STATUSES, COORDINATION_CLAIM_MODES, COORDINATION_EXCLUSIVE_OPERATION_KINDS, COORDINATION_EXCLUSIVE_RELEASE_TRIGGERS, COORDINATION_EXCLUSIVE_RESOURCE_SCOPES, COORDINATION_MESSAGE_STATUSES, COORDINATION_INTEGRATION_CONFLICT_KINDS, COORDINATION_INTEGRATION_DISPOSITIONS, COORDINATION_MERGE_TREE_STATUSES, COORDINATION_OPERATIONAL_ESCALATION_REASONS, COORDINATION_OPERATION_STAGES, COORDINATION_OPERATION_TYPES, COORDINATION_OBSERVATION_EXECUTION_STATES, COORDINATION_OBSERVATION_FRESHNESS_STATES, COORDINATION_OBSERVATION_OBJECT_KINDS, COORDINATION_RELEASE_CONDITION_TYPES, COORDINATION_RECONCILIATION_DETAIL_KINDS, COORDINATION_RECONCILIATION_SOURCES, COORDINATION_REQUEST_STATUSES, COORDINATION_RESERVATION_OBLIGATION_STATES, COORDINATION_MESSAGE_TYPES, COORDINATION_RUN_STATUSES, COORDINATION_SESSION_STATUSES, COORDINATION_SESSION_ATTACHMENT_KINDS, COORDINATION_MIGRATION_RECOVERY_RESOLUTIONS, COORDINATION_MIGRATION_RECOVERY_STATUSES, COORDINATION_MIGRATION_RECOVERY_TYPES, COORDINATION_UNIT_ROLES, COORDINATION_UNIT_STATES, COORDINATION_WORKTREE_KINDS, COORDINATION_WORKTREE_STATES, COORDINATION_WAIT_EDGE_STATES, COORDINATION_DEADLOCK_ACTIONS, COORDINATION_DEADLOCK_STATES, } from "./types.js";
const boundedString = (maxLength = 512) => ({ type: 'string', minLength: 1, maxLength });
const identifier = () => ({ type: 'string', minLength: 1, maxLength: 192, pattern: '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$' });
const pathSegmentIdentifier = () => ({ type: 'string', minLength: 1, maxLength: 192, pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,191}$' });
const integer = (minimum = 0) => ({ type: 'integer', minimum });
const nullable = (schema) => ({ oneOf: [schema, { type: 'null' }] });
const enumeration = (values) => ({ type: 'string', enum: [...values] });
const exactObject = (schemaVersion, properties, required = Object.keys(properties)) => ({
    $id: `urn:pi-autopilot:coordination:${schemaVersion}`,
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', ...required],
    properties: {
        schema_version: { const: schemaVersion },
        ...properties,
    },
});
const evidence = () => ({
    type: 'object', additionalProperties: false, required: ['ref', 'sha256'], properties: {
        ref: boundedString(1024), sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    },
});
const owner = () => ({
    type: 'object', additionalProperties: false, required: ['repo_id', 'autopilot_id', 'workstream_run', 'unit_id', 'attempt'], properties: {
        repo_id: pathSegmentIdentifier(), autopilot_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), unit_id: identifier(), attempt: integer(1),
    },
});
const condition = () => ({
    type: 'object', additionalProperties: false, required: ['condition_type', 'target_id', 'evidence'], properties: {
        condition_type: enumeration(COORDINATION_RELEASE_CONDITION_TYPES), target_id: identifier(), evidence: nullable(evidence()),
    },
});
const observationSourceIdentity = () => ({
    type: 'object', additionalProperties: false, required: ['base_commit', 'object_id', 'object_kind'], properties: {
        base_commit: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
        object_id: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
        object_kind: enumeration(COORDINATION_OBSERVATION_OBJECT_KINDS),
    },
});
const exclusiveOperation = () => ({
    type: 'object', additionalProperties: false,
    required: ['schema_version', 'operation_id', 'operation_kind', 'critical_section', 'resource_scope', 'expected_duration_ms', 'release_trigger'],
    properties: {
        schema_version: { const: 'autopilot.exclusive_operation.v1' }, operation_id: identifier(),
        operation_kind: enumeration(COORDINATION_EXCLUSIVE_OPERATION_KINDS), critical_section: enumeration(COORDINATION_EXCLUSIVE_OPERATION_KINDS),
        resource_scope: enumeration(COORDINATION_EXCLUSIVE_RESOURCE_SCOPES), expected_duration_ms: { type: 'integer', minimum: 1, maximum: 300000 },
        release_trigger: enumeration(COORDINATION_EXCLUSIVE_RELEASE_TRIGGERS),
    },
});
const requestedLease = () => ({
    type: 'object', additionalProperties: false, required: ['path', 'mode', 'purpose'], properties: {
        path: boundedString(512), mode: enumeration(COORDINATION_CLAIM_MODES), purpose: boundedString(512), source_identity: observationSourceIdentity(), exclusive_operation: exclusiveOperation(),
    },
    allOf: [
        { if: { properties: { mode: { const: 'EXCLUSIVE' } }, required: ['mode'] }, then: { required: ['exclusive_operation'] }, else: { not: { required: ['exclusive_operation'] } } },
        { if: { not: { properties: { mode: { const: 'READ' } }, required: ['mode'] } }, then: { not: { required: ['source_identity'] } } },
    ],
});
const table = (items, maxItems = 10_000) => ({ type: 'array', maxItems, items });
const boundedPageValue = { oneOf: [{ type: 'null' }, { type: 'boolean' }, { type: 'number' }, boundedString(524_288), { type: 'array', maxItems: 1024 }, { type: 'object', maxProperties: 256 }] };
export const COORDINATION_REPOSITORY_SCHEMA = exactObject('autopilot.coordination_repository.v1', {
    repo_id: pathSegmentIdentifier(), repo_key: pathSegmentIdentifier(), canonical_root: boundedString(1024), git_common_dir: boundedString(1024), created_event_seq: integer(), version: integer(1),
});
export const COORDINATION_RUN_SCHEMA = exactObject('autopilot.coordination_run.v1', {
    repo_id: pathSegmentIdentifier(), autopilot_id: pathSegmentIdentifier(), workstream: identifier(), workstream_run: pathSegmentIdentifier(), coordination_authority: enumeration(['legacy-path-claims-v1', 'coordinator-edit-leases-v1']), status: enumeration(COORDINATION_RUN_STATUSES), active_session_generation: integer(), created_event_seq: integer(), version: integer(1),
});
export const COORDINATION_RUN_RESOURCE_SCHEMA = exactObject('autopilot.coordination_run_resource.v1', {
    repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), source_repo: boundedString(1024), git_common_dir: boundedString(1024), worktree_root: boundedString(1024), main_worktree_path: boundedString(1024), runtime_root: boundedString(1024), branch: boundedString(512), target_branch: nullable(boundedString(512)), target_base_sha: boundedString(128), origin_url: nullable(boundedString(2048)), started_at: boundedString(32), version: integer(1),
});
export const COORDINATION_SESSION_LEASE_SCHEMA = exactObject('autopilot.session_lease.v2', {
    session_lease_id: identifier(), repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), session_id: identifier(), session_generation: integer(1), pid: integer(1), boot_id: identifier(), lease_expires_at: boundedString(32), attachment_kind: enumeration(COORDINATION_SESSION_ATTACHMENT_KINDS), status: enumeration(COORDINATION_SESSION_STATUSES), attached_event_seq: integer(), version: integer(1),
});
export const CHILD_TERMINAL_ACCEPTANCE_SCHEMA = exactObject(AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA, {
    repo_id: pathSegmentIdentifier(), autopilot_id: pathSegmentIdentifier(), workstream: identifier(), workstream_run: pathSegmentIdentifier(), unit_id: identifier(), role: enumeration(COORDINATION_UNIT_ROLES.filter((role) => role !== 'unknown')), attempt: integer(1), child_lease_id: identifier(), verdict: enumeration(['DONE', 'PASS', 'NEEDS_FIX', 'BLOCKED']), transport_result: { const: 'accepted' }, spec: evidence(), status: evidence(), receipt: evidence(), audit: evidence(), tool_call_id: identifier(), carrier_status_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, audit_disposition: enumeration(['zero-change', 'accounted-changes']), created_at: boundedString(32),
});
export const COORDINATION_CHILD_LEASE_SCHEMA = exactObject('autopilot.child_lease.v1', {
    child_lease_id: identifier(), owner: owner(), pid: integer(1), boot_id: identifier(), lease_expires_at: boundedString(32), status: enumeration(COORDINATION_CHILD_STATUSES), terminal_evidence: nullable(evidence()), version: integer(1),
});
export const COORDINATION_UNIT_ATTEMPT_SCHEMA = exactObject('autopilot.unit_attempt.v1', {
    owner: owner(), state: enumeration(COORDINATION_UNIT_STATES), role: enumeration(COORDINATION_UNIT_ROLES), spec: evidence(), preemptible: { type: 'boolean' }, checkpoint_ordinal: integer(), critical_section: nullable(boundedString(128)), version: integer(1),
});
export const COORDINATION_ACQUISITION_GROUP_SCHEMA = exactObject('autopilot.acquisition_group.v2', {
    acquisition_group_id: identifier(), owner: owner(), acquisition_kind: enumeration(COORDINATION_ACQUISITION_KINDS), requested_leases: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: requestedLease() }, reason: boundedString(1024), normal_release_condition: condition(), state: enumeration(COORDINATION_ACQUISITION_STATES), created_event_seq: integer(), fairness_event_seq: integer(), grant_event_seq: nullable(integer()), offer_expires_at: nullable(boundedString(32)), offer_count: integer(), bypass_count: integer(), version: integer(1),
});
export const COORDINATION_OBSERVATION_SCHEMA = exactObject('autopilot.observation.v1', {
    observation_id: identifier(), owner: owner(), acquisition_group_id: identifier(), path: boundedString(512), purpose: boundedString(512), source_identity: observationSourceIdentity(),
    execution_state: enumeration(COORDINATION_OBSERVATION_EXECUTION_STATES), freshness: enumeration(COORDINATION_OBSERVATION_FRESHNESS_STATES), recorded_event_seq: integer(1),
    released_event_seq: nullable(integer(1)), stale_event_seq: nullable(integer(1)), stale_by_reservation_id: nullable(identifier()), stale_by_commit: nullable(boundedString(64)), version: integer(1),
});
export const COORDINATION_EDIT_LEASE_SCHEMA = {
    ...exactObject('autopilot.edit_lease.v1', {
        edit_lease_id: identifier(), owner: owner(), acquisition_group_id: identifier(), path: boundedString(512), mode: enumeration(['WRITE', 'EXCLUSIVE']), purpose: boundedString(512), exclusive_operation: exclusiveOperation(), acquired_event_seq: integer(), normal_release_condition: condition(), version: integer(1),
    }, ['edit_lease_id', 'owner', 'acquisition_group_id', 'path', 'mode', 'purpose', 'acquired_event_seq', 'normal_release_condition', 'version']),
    allOf: [{ if: { properties: { mode: { const: 'EXCLUSIVE' } }, required: ['mode'] }, then: { required: ['exclusive_operation'] }, else: { not: { required: ['exclusive_operation'] } } }],
};
export const COORDINATION_CHANGE_RESERVATION_SCHEMA = exactObject('autopilot.change_reservation.v1', {
    reservation_id: identifier(), repo_id: pathSegmentIdentifier(), autopilot_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), path: boundedString(512), merge_evidence: evidence(), created_event_seq: integer(), released_event_seq: nullable(integer()), terminal_outcome: nullable(enumeration(['closed', 'aborted'])), terminal_sha: nullable(boundedString(64)), version: integer(1),
});
export const COORDINATION_INTEGRATION_CONFLICT_SCHEMA = exactObject('autopilot.integration_conflict.v1', {
    classification_id: identifier(), kind: enumeration(COORDINATION_INTEGRATION_CONFLICT_KINDS), disposition: enumeration(COORDINATION_INTEGRATION_DISPOSITIONS),
    merge_base: nullable({ type: 'string', pattern: '^[a-f0-9]{40,64}$' }), predecessor_commit: nullable({ type: 'string', pattern: '^[a-f0-9]{40,64}$' }), dependent_commit: nullable({ type: 'string', pattern: '^[a-f0-9]{40,64}$' }), merge_tree_status: enumeration(COORDINATION_MERGE_TREE_STATUSES),
    overlapping_paths: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: boundedString(512) }, overlapping_hunks: { type: 'array', maxItems: 1024, uniqueItems: true, items: boundedString(512) }, semantic_keys: { type: 'array', maxItems: 1024, uniqueItems: true, items: boundedString(512) }, protected_surfaces: { type: 'array', maxItems: 1024, uniqueItems: true, items: boundedString(512) }, evidence: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: boundedString(1024) },
});
export const COORDINATION_RESERVATION_OBLIGATION_SCHEMA = exactObject('autopilot.reservation_obligation.v1', {
    obligation_id: identifier(), repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), reservation_id: identifier(), predecessor_reservation_id: identifier(),
    overlapping_paths: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: boundedString(512) }, integration_conflict: COORDINATION_INTEGRATION_CONFLICT_SCHEMA, state: enumeration(COORDINATION_RESERVATION_OBLIGATION_STATES),
    created_event_seq: integer(1), predecessor_released_event_seq: nullable(integer(1)), predecessor_terminal_sha: nullable(boundedString(64)), integration_evidence: nullable(evidence()), validation_evidence: nullable(evidence()), resolved_event_seq: nullable(integer(1)), version: integer(1),
});
export const COORDINATION_RUN_TERMINAL_INTENT_SCHEMA = exactObject('autopilot.run_terminal_intent.v1', {
    terminal_intent_id: identifier(), repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), outcome: enumeration(['closed', 'aborted']), state: enumeration(['prepared', 'committed', 'cancelled']), reservation_ids: { type: 'array', maxItems: 10000, uniqueItems: true, items: identifier() }, prepared_event_seq: integer(1), terminal_event_seq: nullable(integer(1)), version: integer(1),
});
export const COORDINATION_CLAIM_REQUEST_SCHEMA = exactObject('autopilot.claim_request.v1', {
    request_id: identifier(), acquisition_group_id: identifier(), requester: owner(), owner: owner(), blocking_lease_ids: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: identifier() }, requested_leases: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: requestedLease() }, reason: boundedString(1024), created_event_seq: integer(), status: enumeration(COORDINATION_REQUEST_STATUSES), owner_reason: nullable(boundedString(1024)), release_condition: nullable(condition()), release_event_seq: nullable(integer()), grant_event_seq: nullable(integer()), version: integer(1),
});
export const COORDINATION_MAILBOX_CURSOR_SCHEMA = exactObject('autopilot.mailbox_cursor.v1', {
    repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), delivered_through_event_seq: integer(), acknowledged_through_event_seq: integer(), version: integer(1),
});
export const COORDINATION_RECONCILIATION_EVIDENCE_SCHEMA = exactObject('autopilot.reconciliation_evidence.v1', {
    reconciliation_evidence_id: identifier(), repo_id: pathSegmentIdentifier(), autopilot_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), source: enumeration(COORDINATION_RECONCILIATION_SOURCES), release_condition: condition(), accepted_event_seq: integer(1), version: integer(1),
});
export const COORDINATION_RECONCILIATION_RECEIPT_SCHEMA = exactObject('autopilot.reconciliation_receipt.v1', {
    reconciliation_receipt_id: identifier(), repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), source_action: identifier(), committed_event_seq: integer(1), detail_count: integer(), details_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    counts: { type: 'object', additionalProperties: false, required: [...COORDINATION_RECONCILIATION_DETAIL_KINDS], properties: Object.fromEntries(COORDINATION_RECONCILIATION_DETAIL_KINDS.map((kind) => [kind, integer()])) }, version: integer(1),
});
export const COORDINATION_RECONCILIATION_DETAIL_SCHEMA = exactObject('autopilot.reconciliation_detail.v1', {
    reconciliation_receipt_id: identifier(), ordinal: integer(1), kind: enumeration(COORDINATION_RECONCILIATION_DETAIL_KINDS), entity_id: identifier(),
});
export const COORDINATION_MAILBOX_DELIVERY_RECEIPT_SCHEMA = exactObject('autopilot.mailbox_delivery_receipt.v1', {
    delivery_id: identifier(), repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), session_lease_id: identifier(), snapshot_through_event_seq: integer(), message_count: integer(), message_ids_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, completed: { type: 'boolean' }, version: integer(1),
});
export const COORDINATION_RESULT_RECEIPT_SCHEMA = exactObject('autopilot.result_receipt.v1', {
    result_receipt_id: identifier(), repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), source_action: identifier(), committed_event_seq: integer(1), detail_count: integer(), details_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    collections: { type: 'object', minProperties: 1, maxProperties: 64, additionalProperties: { type: 'object', additionalProperties: false, required: ['item_count', 'items_sha256'], properties: { item_count: integer(), items_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } } } }, version: integer(1),
});
export const COORDINATION_RESULT_DETAIL_SCHEMA = exactObject('autopilot.result_detail.v1', {
    result_receipt_id: identifier(), ordinal: integer(1), collection: identifier(), collection_ordinal: integer(1), value: boundedPageValue,
});
export const COORDINATION_MESSAGE_SCHEMA = exactObject('autopilot.coordination_message.v1', {
    message_id: identifier(), repo_id: pathSegmentIdentifier(), recipient_workstream_run: pathSegmentIdentifier(), message_type: enumeration(COORDINATION_MESSAGE_TYPES), correlation_id: identifier(), payload: { type: 'object', maxProperties: 256 }, status: enumeration(COORDINATION_MESSAGE_STATUSES), created_event_seq: integer(), delivered_event_seq: nullable(integer()), acknowledged_event_seq: nullable(integer()), version: integer(1),
});
export const COORDINATION_WORKTREE_SCHEMA = exactObject('autopilot.coordination_worktree.v2', {
    worktree_id: identifier(), owner: owner(), kind: enumeration(COORDINATION_WORKTREE_KINDS), canonical_path: boundedString(1024), git_common_dir: boundedString(1024), branch: boundedString(512), state: enumeration(COORDINATION_WORKTREE_STATES), version: integer(1),
});
const operationIntent = () => ({
    type: 'object', additionalProperties: false,
    required: ['repo_root', 'worktree_path', 'git_common_dir', 'branch', 'reason', 'base_sha', 'target_sha', 'archive_ref', 'checkout_mode', 'sparse_patterns', 'paths', 'metadata_refs'],
    properties: {
        repo_root: boundedString(1024), worktree_path: boundedString(1024), git_common_dir: boundedString(1024), branch: boundedString(512), reason: boundedString(1024),
        base_sha: nullable(boundedString(128)), target_sha: nullable(boundedString(128)), archive_ref: nullable(boundedString(512)),
        checkout_mode: nullable(enumeration(['full', 'claim-minimal', 'exclude-heavy'])),
        sparse_patterns: { type: 'array', maxItems: 4096, uniqueItems: true, items: boundedString(1024) },
        paths: { type: 'array', maxItems: 4096, uniqueItems: true, items: boundedString(1024) },
        metadata_refs: { type: 'array', maxItems: 256, uniqueItems: true, items: boundedString(1024) },
    },
});
export const COORDINATION_WORKTREE_OPERATION_SCHEMA = exactObject('autopilot.worktree_operation.v2', {
    operation_id: identifier(), worktree_id: identifier(), owner: owner(), operation_type: enumeration(COORDINATION_OPERATION_TYPES), stage: enumeration(COORDINATION_OPERATION_STAGES), authority_version: integer(1), intent_event_seq: integer(), intent: operationIntent(), completed_steps: { type: 'array', maxItems: 128, uniqueItems: true, items: identifier() }, current_step: nullable(identifier()), recovery_attempts: integer(), verification_evidence: nullable(evidence()), error_code: nullable(boundedString(128)), version: integer(1),
});
const contradictionClause = () => ({
    type: 'object', additionalProperties: false, required: ['authoritative_ref', 'source_type', 'source_scope', 'source_run', 'schema_version', 'clause_id', 'exact_requirement', 'artifact_or_invariant', 'demanded_outcome'], properties: {
        authoritative_ref: evidence(), source_type: enumeration(['mission', 'master-plan', 'task']), source_scope: enumeration(['repository', 'run-main']), source_run: pathSegmentIdentifier(), schema_version: boundedString(128), clause_id: identifier(), exact_requirement: boundedString(2048), artifact_or_invariant: boundedString(512), demanded_outcome: boundedString(1024),
    },
});
export const COORDINATION_WAIT_FOR_EDGE_SCHEMA = exactObject('autopilot.wait_for_edge.v1', {
    edge_id: identifier(), repo_id: pathSegmentIdentifier(), request_id: identifier(), requester: owner(), blocker: owner(), state: enumeration(COORDINATION_WAIT_EDGE_STATES), created_event_seq: integer(1), resolved_event_seq: nullable(integer(1)), version: integer(1),
});
export const COORDINATION_DEADLOCK_RESOLUTION_SCHEMA = exactObject('autopilot.deadlock_resolution.v1', {
    resolution_id: identifier(), repo_id: pathSegmentIdentifier(), cycle_edge_ids: { type: 'array', minItems: 2, maxItems: 256, uniqueItems: true, items: identifier() }, participant_owners: { type: 'array', minItems: 2, maxItems: 32, items: owner() }, state: enumeration(COORDINATION_DEADLOCK_STATES), victim: nullable(owner()), victim_class: nullable({ type: 'integer', enum: [1, 2, 3] }), action: enumeration(COORDINATION_DEADLOCK_ACTIONS), reason: boundedString(1024), created_event_seq: integer(1), resolved_event_seq: nullable(integer(1)), version: integer(1),
});
export const COORDINATION_CONTRADICTION_ADJUDICATION_SCHEMA = exactObject('autopilot.planning_contradiction_adjudication.v1', {
    adjudication_id: identifier(), adjudicator: owner(), adjudicator_role: { const: 'adjudicate' }, independent_from_runs: { type: 'array', minItems: 2, maxItems: 32, uniqueItems: true, items: identifier() }, verdict: { const: 'major-contradiction' }, conflicting_clauses: { type: 'array', minItems: 2, maxItems: 32, items: contradictionClause() }, sequencing_can_satisfy_both: { const: false }, partitioning_can_satisfy_both: { const: false }, ownership_transfer_can_satisfy_both: { const: false }, rebase_revalidation_can_satisfy_both: { const: false }, replanning_can_preserve_both: { const: false }, operational_reasons: { type: 'array', maxItems: COORDINATION_OPERATIONAL_ESCALATION_REASONS.length, uniqueItems: true, items: enumeration(COORDINATION_OPERATIONAL_ESCALATION_REASONS) }, decision_options: { type: 'array', minItems: 2, maxItems: 16, uniqueItems: true, items: boundedString(1024) },
});
export const COORDINATION_AUTHORITATIVE_ARTIFACT_SCHEMA = exactObject('autopilot.authoritative_artifact.v1', {
    artifact_id: identifier(), repo_id: pathSegmentIdentifier(), source_run: pathSegmentIdentifier(), source_type: enumeration(['mission', 'master-plan', 'task']), source_scope: enumeration(['repository', 'run-main']), document_schema_version: boundedString(128), git_commit: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, evidence: evidence(), registered_event_seq: integer(1), version: integer(1),
});
export const COORDINATION_ADJUDICATION_ASSIGNMENT_SCHEMA = exactObject('autopilot.adjudication_assignment.v1', {
    assignment_id: identifier(), repo_id: pathSegmentIdentifier(), requesting_run: pathSegmentIdentifier(), participating_runs: { type: 'array', minItems: 2, maxItems: 32, uniqueItems: true, items: pathSegmentIdentifier() }, authoritative_artifact_ids: { type: 'array', minItems: 2, maxItems: 32, uniqueItems: true, items: identifier() }, conflicting_clauses: { type: 'array', minItems: 2, maxItems: 32, items: contradictionClause() }, adjudicator: owner(), decision_options: { type: 'array', minItems: 2, maxItems: 16, uniqueItems: true, items: boundedString(1024) }, state: enumeration(['assigned', 'accepted']), adjudication: nullable(evidence()), child_lease_id: nullable(identifier()), assigned_event_seq: integer(), accepted_event_seq: nullable(integer(1)), version: integer(1),
});
export const COORDINATION_ESCALATION_SCHEMA = exactObject('autopilot.planning_contradiction.v1', {
    escalation_id: identifier(), repo_id: pathSegmentIdentifier(), participating_runs: { type: 'array', minItems: 2, maxItems: 32, uniqueItems: true, items: identifier() }, authoritative_refs: { type: 'array', minItems: 2, maxItems: 32, items: evidence() }, conflicting_clauses: { type: 'array', minItems: 2, maxItems: 32, items: contradictionClause() }, exhausted_alternatives: { type: 'array', minItems: 5, maxItems: 5, uniqueItems: true, items: enumeration(['sequencing', 'partitioning', 'ownership-transfer', 'rebase-revalidation', 'replanning']) }, adjudication: evidence(), decision_options: { type: 'array', minItems: 2, maxItems: 16, uniqueItems: true, items: boundedString(1024) }, created_event_seq: integer(), version: integer(1),
});
const migrationRecoveryResolution = () => ({
    type: 'object', additionalProperties: false, required: ['resolution_type', 'evidence', 'release_source', 'release_target_id', 'exact_postconditions'], properties: {
        resolution_type: enumeration(COORDINATION_MIGRATION_RECOVERY_RESOLUTIONS), evidence: evidence(),
        release_source: nullable(enumeration(COORDINATION_RECONCILIATION_SOURCES.filter((source) => source !== 'child-process'))), release_target_id: nullable(identifier()),
        exact_postconditions: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: boundedString(1024) },
    },
});
export const COORDINATION_MIGRATION_RECOVERY_WORK_SCHEMA = exactObject('autopilot.migration_recovery_work.v2', {
    recovery_id: identifier(), repo_id: pathSegmentIdentifier(), workstream_run: pathSegmentIdentifier(), recovery_type: enumeration(COORDINATION_MIGRATION_RECOVERY_TYPES), detail: { type: 'object', maxProperties: 128 }, status: enumeration(COORDINATION_MIGRATION_RECOVERY_STATUSES), resolution: nullable(migrationRecoveryResolution()), created_event_seq: integer(1), resolved_event_seq: nullable(integer(1)), version: integer(1),
});
export const COORDINATION_MIGRATION_RECORD_SCHEMA = exactObject('autopilot.coordination_migration_record.v1', {
    repo_id: pathSegmentIdentifier(), migration_id: identifier(), snapshot_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, journal_path: boundedString(1024), state: enumeration(['imported', 'verified', 'cutover-ready', 'cutover-committed', 'legacy-archived']), report: { type: 'object', maxProperties: 64 }, imported_at: boundedString(32), updated_at: boundedString(32), version: integer(1),
});
export const COORDINATION_CUTOVER_MARKER_JSON_SCHEMA = exactObject('autopilot.coordination_cutover.v1', {
    repo_key: pathSegmentIdentifier(), snapshot_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, database_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, committed_at: boundedString(32), migration_id: identifier(),
});
export const COORDINATION_EVENT_SCHEMA = exactObject('autopilot.coordination_event.v1', {
    repo_id: pathSegmentIdentifier(), event_seq: integer(1), event_type: identifier(), entity_type: identifier(), entity_id: identifier(), idempotency_key: identifier(), request_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, occurred_at: boundedString(32),
});
export const COORDINATION_SNAPSHOT_SCHEMA = exactObject(AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA, {
    repository_event_seq: integer(), repositories: table(COORDINATION_REPOSITORY_SCHEMA), runs: table(COORDINATION_RUN_SCHEMA), session_leases: table(COORDINATION_SESSION_LEASE_SCHEMA), child_leases: table(COORDINATION_CHILD_LEASE_SCHEMA), unit_attempts: table(COORDINATION_UNIT_ATTEMPT_SCHEMA), acquisition_groups: table(COORDINATION_ACQUISITION_GROUP_SCHEMA), observations: table(COORDINATION_OBSERVATION_SCHEMA), edit_leases: table(COORDINATION_EDIT_LEASE_SCHEMA), change_reservations: table(COORDINATION_CHANGE_RESERVATION_SCHEMA), reservation_obligations: table(COORDINATION_RESERVATION_OBLIGATION_SCHEMA), run_terminal_intents: table(COORDINATION_RUN_TERMINAL_INTENT_SCHEMA), claim_requests: table(COORDINATION_CLAIM_REQUEST_SCHEMA), mailbox_cursors: table(COORDINATION_MAILBOX_CURSOR_SCHEMA), reconciliation_evidence: table(COORDINATION_RECONCILIATION_EVIDENCE_SCHEMA), migration_recovery_work: table(COORDINATION_MIGRATION_RECOVERY_WORK_SCHEMA), messages: table(COORDINATION_MESSAGE_SCHEMA, 100_000), worktrees: table(COORDINATION_WORKTREE_SCHEMA), worktree_operations: table(COORDINATION_WORKTREE_OPERATION_SCHEMA), wait_for_edges: table(COORDINATION_WAIT_FOR_EDGE_SCHEMA), deadlock_resolutions: table(COORDINATION_DEADLOCK_RESOLUTION_SCHEMA), authoritative_artifacts: table(COORDINATION_AUTHORITATIVE_ARTIFACT_SCHEMA), adjudication_assignments: table(COORDINATION_ADJUDICATION_ASSIGNMENT_SCHEMA), escalations: table(COORDINATION_ESCALATION_SCHEMA), events: table(COORDINATION_EVENT_SCHEMA, 100_000),
});
export const COORDINATOR_REQUEST_SCHEMA = {
    $id: 'urn:pi-autopilot:coordination:coordinator-request-v1', type: 'object', additionalProperties: false,
    required: ['schema_version', 'protocol_version', 'request_id', 'action', 'idempotency_key', 'repo_id', 'workstream_run', 'session_id', 'fencing_generation', 'expected_version', 'payload'],
    properties: {
        schema_version: { const: AUTOPILOT_COORDINATOR_REQUEST_SCHEMA }, protocol_version: { const: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION }, request_id: identifier(), action: enumeration(['handshake', 'status', 'doctor', 'export', 'migration-recovery', 'run-catalog', 'reconciliation-details', 'result-details', 'attach-run', 'attach-session', 'attach-terminal-recovery', 'attach-migration-recovery', 'resolve-migration-recovery', 'detach-session', 'prepare-handoff', 'heartbeat', 'register-attempt', 'register-child', 'heartbeat-child', 'checkpoint-child', 'complete-child', 'drain-mailbox', 'acquire-group', 'acknowledge-grant', 'respond-claim-request', 'cancel-claim-request', 'cancel-acquisition-group', 'supersede-attempt', 'acknowledge-message', 'record-release-evidence', 'resolve-reservation-obligation', 'prepare-run-terminal', 'cancel-run-terminal', 'reconcile-run', 'prepare-operation', 'transition-operation', 'register-authoritative-artifact', 'assign-adjudication', 'claim-adjudication-assignment', 'complete-adjudication', 'submit-planning-contradiction']), idempotency_key: nullable(identifier()), repo_id: pathSegmentIdentifier(), workstream_run: nullable(pathSegmentIdentifier()), session_id: nullable(identifier()), fencing_generation: nullable(integer()), expected_version: nullable(integer()), payload: { type: 'object' },
    },
};
export const COORDINATOR_RESPONSE_SCHEMA = {
    $id: 'urn:pi-autopilot:coordination:coordinator-response-v1', type: 'object', additionalProperties: false,
    required: ['schema_version', 'protocol_version', 'request_id', 'ok', 'committed_event_seq', 'error_code', 'retryable', 'payload'],
    properties: {
        schema_version: { const: AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA }, protocol_version: { const: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION }, request_id: identifier(), ok: { type: 'boolean' }, committed_event_seq: nullable(integer()), error_code: nullable(boundedString(128)), retryable: { type: 'boolean' }, payload: { type: 'object' },
    },
};
const projectionPageSchema = (kind) => exactObject(`autopilot.coordinator_${kind}_page.v1`, {
    projection_schema_version: boundedString(192), section: identifier(), scan_token: boundedString(192), observed_at: nullable(boundedString(32)),
    section_counts: { type: 'object', maxProperties: 64, additionalProperties: integer() }, projection: { type: 'object', maxProperties: 256 }, items: table(boundedPageValue, 1024), next_cursor: nullable(boundedString(2048)),
});
export const COORDINATOR_STATUS_PAGE_SCHEMA = projectionPageSchema('status');
export const COORDINATOR_DOCTOR_PAGE_SCHEMA = projectionPageSchema('doctor');
export const COORDINATOR_RUN_CATALOG_PAGE_SCHEMA = exactObject('autopilot.coordinator_run_catalog.v1', {
    package_build: boundedString(192), protocol_version: { const: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION }, database_schema_version: integer(1), runs: table(COORDINATION_RUN_SCHEMA, 1024), run_resources: table(COORDINATION_RUN_RESOURCE_SCHEMA, 1024), next_cursor: nullable(boundedString(2048)), pending_migration_recovery_count: integer(),
});
export const COORDINATOR_MIGRATION_RECOVERY_PAGE_SCHEMA = exactObject('autopilot.migration_recovery_query.v1', {
    package_build: boundedString(192), protocol_version: { const: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION }, database_schema_version: integer(1), recovery: table(COORDINATION_MIGRATION_RECOVERY_WORK_SCHEMA, 1024), runs: table(COORDINATION_RUN_SCHEMA, 1024), pending_migration_recovery_count: integer(),
    next_cursor: nullable({ type: 'object', additionalProperties: false, required: ['cursor_run', 'cursor_recovery_id'], properties: { cursor_run: boundedString(1024), cursor_recovery_id: boundedString(1024) } }),
});
export const COORDINATOR_RECONCILIATION_DETAIL_PAGE_SCHEMA = exactObject('autopilot.reconciliation_detail_page.v1', { reconciliation_receipt: COORDINATION_RECONCILIATION_RECEIPT_SCHEMA, details: table(COORDINATION_RECONCILIATION_DETAIL_SCHEMA, 1024), next_cursor: nullable(boundedString(2048)) });
export const COORDINATOR_RESULT_DETAIL_PAGE_SCHEMA = exactObject('autopilot.result_detail_page.v1', { result_receipt: COORDINATION_RESULT_RECEIPT_SCHEMA, details: table(COORDINATION_RESULT_DETAIL_SCHEMA, 1024), next_cursor: nullable(boundedString(2048)) });
export const COORDINATOR_MAILBOX_PAGE_SCHEMA = { $id: 'urn:pi-autopilot:coordination:coordinator-mailbox-page-v1', type: 'object', additionalProperties: false, required: ['delivery_receipt', 'session_version', 'mailbox_cursor', 'messages', 'next_cursor', 'event_type', 'entity_type', 'entity_id'], properties: { delivery_receipt: COORDINATION_MAILBOX_DELIVERY_RECEIPT_SCHEMA, session_version: integer(1), mailbox_cursor: COORDINATION_MAILBOX_CURSOR_SCHEMA, messages: table(COORDINATION_MESSAGE_SCHEMA, 1024), next_cursor: nullable(boundedString(2048)), event_type: identifier(), entity_type: identifier(), entity_id: identifier() } };
export const AUTOPILOT_COORDINATION_JSON_SCHEMAS = Object.freeze({
    repository: COORDINATION_REPOSITORY_SCHEMA,
    run: COORDINATION_RUN_SCHEMA,
    run_resource: COORDINATION_RUN_RESOURCE_SCHEMA,
    session_lease: COORDINATION_SESSION_LEASE_SCHEMA,
    child_terminal_acceptance: CHILD_TERMINAL_ACCEPTANCE_SCHEMA,
    child_lease: COORDINATION_CHILD_LEASE_SCHEMA,
    unit_attempt: COORDINATION_UNIT_ATTEMPT_SCHEMA,
    acquisition_group: COORDINATION_ACQUISITION_GROUP_SCHEMA,
    observation: COORDINATION_OBSERVATION_SCHEMA,
    edit_lease: COORDINATION_EDIT_LEASE_SCHEMA,
    change_reservation: COORDINATION_CHANGE_RESERVATION_SCHEMA,
    integration_conflict: COORDINATION_INTEGRATION_CONFLICT_SCHEMA,
    reservation_obligation: COORDINATION_RESERVATION_OBLIGATION_SCHEMA,
    run_terminal_intent: COORDINATION_RUN_TERMINAL_INTENT_SCHEMA,
    claim_request: COORDINATION_CLAIM_REQUEST_SCHEMA,
    mailbox_cursor: COORDINATION_MAILBOX_CURSOR_SCHEMA,
    reconciliation_evidence: COORDINATION_RECONCILIATION_EVIDENCE_SCHEMA,
    reconciliation_receipt: COORDINATION_RECONCILIATION_RECEIPT_SCHEMA,
    reconciliation_detail: COORDINATION_RECONCILIATION_DETAIL_SCHEMA,
    mailbox_delivery_receipt: COORDINATION_MAILBOX_DELIVERY_RECEIPT_SCHEMA,
    result_receipt: COORDINATION_RESULT_RECEIPT_SCHEMA,
    result_detail: COORDINATION_RESULT_DETAIL_SCHEMA,
    message: COORDINATION_MESSAGE_SCHEMA,
    worktree: COORDINATION_WORKTREE_SCHEMA,
    worktree_operation: COORDINATION_WORKTREE_OPERATION_SCHEMA,
    wait_for_edge: COORDINATION_WAIT_FOR_EDGE_SCHEMA,
    deadlock_resolution: COORDINATION_DEADLOCK_RESOLUTION_SCHEMA,
    contradiction_adjudication: COORDINATION_CONTRADICTION_ADJUDICATION_SCHEMA,
    authoritative_artifact: COORDINATION_AUTHORITATIVE_ARTIFACT_SCHEMA,
    adjudication_assignment: COORDINATION_ADJUDICATION_ASSIGNMENT_SCHEMA,
    escalation: COORDINATION_ESCALATION_SCHEMA,
    migration_recovery_work: COORDINATION_MIGRATION_RECOVERY_WORK_SCHEMA,
    migration_record: COORDINATION_MIGRATION_RECORD_SCHEMA,
    cutover_marker: COORDINATION_CUTOVER_MARKER_JSON_SCHEMA,
    event: COORDINATION_EVENT_SCHEMA,
    snapshot: COORDINATION_SNAPSHOT_SCHEMA,
    coordinator_request: COORDINATOR_REQUEST_SCHEMA,
    coordinator_response: COORDINATOR_RESPONSE_SCHEMA,
    coordinator_status_page: COORDINATOR_STATUS_PAGE_SCHEMA,
    coordinator_doctor_page: COORDINATOR_DOCTOR_PAGE_SCHEMA,
    coordinator_run_catalog_page: COORDINATOR_RUN_CATALOG_PAGE_SCHEMA,
    coordinator_migration_recovery_page: COORDINATOR_MIGRATION_RECOVERY_PAGE_SCHEMA,
    coordinator_reconciliation_detail_page: COORDINATOR_RECONCILIATION_DETAIL_PAGE_SCHEMA,
    coordinator_result_detail_page: COORDINATOR_RESULT_DETAIL_PAGE_SCHEMA,
    coordinator_mailbox_page: COORDINATOR_MAILBOX_PAGE_SCHEMA,
});
