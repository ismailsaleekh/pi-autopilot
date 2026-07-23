import { createHash } from 'node:crypto';

import { AUTOPILOT_JSON_SCHEMAS } from '../contracts/schemas.ts';
import { AUTOPILOT_SCHEMA_NAMES } from '../names.ts';
import { AUTOPILOT_COORDINATION_JSON_SCHEMAS, type CoordinationJsonSchema } from './schemas.ts';
import { COORDINATOR_IMPLEMENTATION_BUILD } from './runtime-constants.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS, UNIT_FAILURE_CURRENT_PRODUCER_GENERATION } from './unit-failure-producer-provenance.ts';
import { parseCentralVersionedUnitFailureIngress } from './unit-failure-ingress.ts';
export { BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS, UNIT_FAILURE_CURRENT_PRODUCER_GENERATION } from './unit-failure-producer-provenance.ts';

export type VersionedIngressUnknownFieldPolicy = 'reject' | 'preserve';
export type VersionedIngressPersistenceKind = 'package-contract' | 'coordination-store' | 'runtime-evidence' | 'runtime-state' | 'migration-artifact' | 'transport-or-page';

export interface VersionedIngressAbsentFieldDefault {
  readonly field: string;
  readonly value: string | number | boolean | null;
}

export interface VersionedIngressProducerRange {
  readonly first_generation: number;
  readonly last_generation: number;
  readonly producer_build: string;
  readonly exact_fields: readonly string[];
  readonly required_fields: readonly string[];
  readonly absent_field_defaults: readonly VersionedIngressAbsentFieldDefault[];
  readonly unknown_field_policy: VersionedIngressUnknownFieldPolicy;
  readonly current: boolean;
}

export interface PersistedArtifactFamilyDefinition {
  readonly family: string;
  readonly schema_version: string;
  readonly persistence: VersionedIngressPersistenceKind;
  readonly notes: string;
  readonly producer_ranges: readonly VersionedIngressProducerRange[];
}

export interface VersionedIngressSelection {
  readonly family: PersistedArtifactFamilyDefinition;
  readonly range: VersionedIngressProducerRange;
  readonly producer_generation: number;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

export interface VersionedPersistedArtifactIngress {
  readonly family: string;
  readonly schema_version: string;
  readonly producer_build: string;
  readonly producer_generation: number;
  readonly current: boolean;
  readonly original_sha256: `sha256:${string}`;
  readonly original_bytes: Uint8Array;
  readonly document: JsonRecord;
  readonly normalized_document: JsonRecord;
  readonly original_fields: readonly string[];
  readonly unknown_fields: readonly string[];
  readonly applied_defaults: readonly VersionedIngressAbsentFieldDefault[];
}

export interface UnitFailureIngressIdentity {
  readonly workstream: string;
  readonly workstreamRun: string;
  readonly unitId: string;
  readonly attempt: number;
}

export interface UnitFailureVersionedIngressFacts {
  readonly action: 'quarantine' | 'reset' | 'preserve' | 'abort';
  readonly unitWorktreePath: string;
  readonly captureCommitSha: string | null;
  readonly captureRef: string | null;
  readonly originalSha256: `sha256:${string}`;
  readonly originalFields: readonly string[];
  readonly appliedDefaults: readonly VersionedIngressAbsentFieldDefault[];
}

export interface UnitFailureVersionedIngress {
  readonly kind: 'unit_failure';
  readonly ingress: VersionedPersistedArtifactIngress;
  readonly facts: UnitFailureVersionedIngressFacts;
}

const CURRENT_PRODUCER_PROVENANCE_FIELDS = Object.freeze(['producer_build', 'producer_generation'] as const);

const CURRENT_UNIT_FAILURE_FIELDS = Object.freeze([
  'action', 'attempt', 'branch', 'capture_commit_sha', 'capture_ref', 'created_at', 'dirty_paths', 'git_common_dir', 'git_head_after', 'git_head_before',
  'postcondition_worktree_clean', ...CURRENT_PRODUCER_PROVENANCE_FIELDS, 'schema_version', 'summary', 'unit_id', 'unit_worktree_path', 'workstream', 'workstream_run',
].sort());
const HISTORICAL_INITIAL_UNIT_FAILURE_FIELDS = Object.freeze([
  'action', 'attempt', 'created_at', 'dirty_paths', 'schema_version', 'summary', 'unit_id', 'unit_worktree_path', 'workstream', 'workstream_run',
].sort());
const HISTORICAL_CAPTURE_COMMIT_UNIT_FAILURE_FIELDS = Object.freeze([...HISTORICAL_INITIAL_UNIT_FAILURE_FIELDS, 'capture_commit_sha'].sort());

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new CoordinationRuntimeError('invalid-state', `${label} must be a JSON object`);
  return value;
}

function stringField(record: JsonRecord, field: string, label: string, maxLength: number): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be bounded non-empty text`);
  return value;
}

function integerField(record: JsonRecord, field: string, label: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be a positive integer`);
  return value;
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeJsonDocument(bytes: Uint8Array, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-state', `${label} is not valid UTF-8 JSON`, [error instanceof Error ? error.message : String(error)]);
  }
  return asRecord(parsed, label);
}

function schemaConst(schema: CoordinationJsonSchema, label: string): string {
  const properties = asRecord(schema['properties'], `${label}.properties`);
  const schemaVersion = asRecord(properties['schema_version'], `${label}.properties.schema_version`)['const'];
  if (typeof schemaVersion !== 'string' || schemaVersion.length === 0) throw new CoordinationRuntimeError('invalid-state', `${label} lacks an exact schema_version const`);
  return schemaVersion;
}

function fieldNamesFromJsonSchema(schema: Readonly<Record<string, unknown>>): readonly string[] {
  const properties = schema['properties'];
  if (!isRecord(properties)) return Object.freeze(['schema_version']);
  return sortedUnique(Object.keys(properties));
}

function requiredFieldNamesFromJsonSchema(schema: Readonly<Record<string, unknown>>): readonly string[] {
  const required = schema['required'];
  if (!Array.isArray(required)) return Object.freeze(['schema_version']);
  return sortedUnique(required.filter((field): field is string => typeof field === 'string'));
}

function currentRange(exactFields: readonly string[], requiredFields: readonly string[] = exactFields): VersionedIngressProducerRange {
  return Object.freeze({
    first_generation: 1,
    last_generation: 1,
    producer_build: COORDINATOR_IMPLEMENTATION_BUILD,
    exact_fields: sortedUnique([...exactFields, ...CURRENT_PRODUCER_PROVENANCE_FIELDS]),
    required_fields: sortedUnique([...requiredFields, ...CURRENT_PRODUCER_PROVENANCE_FIELDS]),
    absent_field_defaults: Object.freeze([]),
    unknown_field_policy: 'reject',
    current: true,
  });
}

function currentOnlyFamily(schemaVersion: string, persistence: VersionedIngressPersistenceKind, fields: readonly string[], required: readonly string[], notes: string): PersistedArtifactFamilyDefinition {
  return Object.freeze({
    family: schemaVersion,
    schema_version: schemaVersion,
    persistence,
    notes,
    producer_ranges: Object.freeze([currentRange(fields, required)]),
  });
}

const packageContractFamilies = AUTOPILOT_SCHEMA_NAMES.map((schemaVersion) => {
  const schema = Object.values(AUTOPILOT_JSON_SCHEMAS).find((candidate) => schemaConst(candidate, `package schema ${schemaVersion}`) === schemaVersion);
  const fields = schema === undefined ? Object.freeze(['schema_version']) : fieldNamesFromJsonSchema(schema);
  const required = schema === undefined ? Object.freeze(['schema_version']) : requiredFieldNamesFromJsonSchema(schema);
  return currentOnlyFamily(schemaVersion, 'package-contract', fields, required, 'package contract artifact inventoried from AUTOPILOT_SCHEMA_NAMES');
});

function coordinationSchemaVersion(name: string, schema: CoordinationJsonSchema): string {
  const properties = schema['properties'];
  if (isRecord(properties)) {
    const schemaVersion = properties['schema_version'];
    if (isRecord(schemaVersion) && typeof schemaVersion['const'] === 'string') return schemaVersion['const'];
  }
  if (name === 'coordinator_mailbox_page') return 'autopilot.coordinator_mailbox_page.v1';
  throw new CoordinationRuntimeError('invalid-state', 'coordination schema lacks an inventoried schema_version const', [name]);
}

const coordinationFamilies = Object.entries(AUTOPILOT_COORDINATION_JSON_SCHEMAS).map(([name, schema]) => currentOnlyFamily(
  coordinationSchemaVersion(name, schema),
  name.includes('request') || name.includes('response') || name.includes('page') ? 'transport-or-page' : 'coordination-store',
  fieldNamesFromJsonSchema(schema),
  requiredFieldNamesFromJsonSchema(schema),
  `coordination schema inventory key ${name}`,
));

const EXTRA_PERSISTED_ARTIFACT_SCHEMAS = Object.freeze([
  'autopilot.active_parent.v1', 'autopilot.active_parent.v2', 'autopilot.archive_info.v1', 'autopilot.attach_run_result.v2', 'autopilot.authority.v1',
  'autopilot.branches.v1', 'autopilot.capacity_decision.v1', 'autopilot.checkout_profile.v1', 'autopilot.checkout_profile_snapshot.v1',
  'autopilot.claim_event.v1', 'autopilot.claim_gc.v1', 'autopilot.claim_response_tool_result.v1', 'autopilot.claim_snapshot.v1',
  'autopilot.close_attempt.v1', 'autopilot.close_result.v1', 'autopilot.continuation_event.v1', 'autopilot.coordination_freeze.v1',
  'autopilot.coordination_freeze_ack.v1', 'autopilot.coordination_legacy_archive_manifest.v1', 'autopilot.coordination_migration_import_result.v1',
  'autopilot.coordination_migration_journal.v1', 'autopilot.coordination_migration_lock.v1', 'autopilot.coordination_migration_report.v1',
  'autopilot.coordination_preflight.v1', 'autopilot.coordination_recovery_operation.v1', 'autopilot.cf50_fixed_path_barrier.v1', 'autopilot.coordinator_cursor.v1',
  'autopilot.coordinator_export.v1', 'autopilot.coordinator_export_result.v1', 'autopilot.coordinator_handshake.v1', 'autopilot.coordinator_lock.v1',
  'autopilot.coordinator_lock.v2', 'autopilot.coordinator_runtime_identity.v1', 'autopilot.coordinator_semantic_replay.v1',
  'autopilot.coordinator_semantic_replay_receipt.v1', 'autopilot.coordinator_session_context.v1', 'autopilot.coordinator_startup_lock.v1',
  'autopilot.coordinator_startup_report.v1', 'autopilot.coordinator_status.v1', 'autopilot.coordinator_store_generation.v1',
  'autopilot.coordinator_store_pointer.v1', 'autopilot.coordinator_transport.v1', 'autopilot.coordinator_upgrade_backup.v1',
  'autopilot.coordinator_upgrade_intent.v1', 'autopilot.dispatch.v1', 'autopilot.expected_status_identity.v1', 'autopilot.foreign_merge_ack.v1',
  'autopilot.graph_publication.v1', 'autopilot.heartbeat_high_water.v1', 'autopilot.identity_fault_resolution_evidence.v1',
  'autopilot.integration_analysis.v1', 'autopilot.launch_policy.v1', 'autopilot.lock.v1', 'autopilot.mailbox_delivery_receipt.v1',
  'autopilot.manual_worktree_reconcile.v1', 'autopilot.materialization_event.v1', 'autopilot.materialized_paths.v1', 'autopilot.merge_conflict.v1',
  'autopilot.merge_event.v1', 'autopilot.migration_authority_recovery.v1', 'autopilot.migration_terminal_release.v1', 'autopilot.mission.v1',
  'autopilot.operator_trust_anchor.v1', 'autopilot.parent_loss.v1', 'autopilot.path_claim.v1', 'autopilot.post_cutover_terminal_repair.v1',
  'autopilot.program_heartbeat.v1', 'autopilot.program_heartbeat_acceptance_result.v1', 'autopilot.reconciliation_intent.v1',
  'autopilot.reconciliation_intent_supersession.v1', 'autopilot.repo_key.v1', 'autopilot.reservation_integration.v1',
  'autopilot.reservation_repair.v1', 'autopilot.run_scoped_fault.v1', 'autopilot.run_terminal.v1', 'autopilot.run_terminal_intent.v2',
  'autopilot.saga_execution_lock.v1', 'autopilot.scheduler_config.v1', 'autopilot.schema9_read_recovery_retirement.v1', 'autopilot.schema9_read_retirement.v1',
  'autopilot.schema11_retirement.v1', 'autopilot.semantic_graph.v1', 'autopilot.semantic_graph_authority_shard.v1',
  'autopilot.semantic_graph_bootstrap.v1', 'autopilot.semantic_graph_projection_shard.v1', 'autopilot.status_tool_context.v1',
  'autopilot.store_invariant_repair.v1', 'autopilot.subscription_probe.v1', 'autopilot.task_info.v1', 'autopilot.task_info.v2',
  'autopilot.terminal_cleanup.v1', 'autopilot.unit_failure.v1', 'autopilot.unit_index.v1', 'autopilot.unit_index_adjudication.v1',
  'autopilot.unit_info.v1', 'autopilot.unit_merge.v1', 'autopilot.unit_merge_intent.v1', 'autopilot.validation_evidence.v1',
  'autopilot.validation_staleness.v1', 'autopilot.validation_staleness.v2', 'autopilot.worktree_alias.v1', 'autopilot.worktree_alias_migration_evidence.v1',
  'autopilot.worktree_bootstrap.v1', 'autopilot.worktree_cleanup_result.v1', 'autopilot.worktree_index.v1', 'autopilot.worktree_ledger.v1',
  'autopilot.worktree_metadata_reconcile_evidence.v1', 'autopilot.worktree_metadata_reconcile_intent.v1', 'autopilot.worktree_operation_evidence.v1',
  'autopilot.worktree_operation_key.v2', 'autopilot.worktree_rollback_supersession.v1',
] as const);

const SOURCE_ANCHORED_EXTRA_PERSISTED_ARTIFACT_FIELDS = Object.freeze({
  'autopilot.active_parent.v1': ['active_epoch_started_at', 'active_run_epoch', 'active_run_receipt_id', 'autopilot_id', 'boot_id', 'branch', 'git_common_dir', 'main_worktree_path', 'origin_url', 'pid', 'repo_key', 'runtime_root', 'schema_version', 'source_repo', 'started_at', 'status', 'target_base_sha', 'target_branch', 'workstream', 'workstream_run', 'worktree_root'],
  'autopilot.active_parent.v2': ['active_epoch_started_at', 'active_run_epoch', 'active_run_receipt_id', 'autopilot_id', 'boot_id', 'branch', 'coordination_authority', 'git_common_dir', 'main_worktree_path', 'origin_url', 'pid', 'repo_key', 'runtime_root', 'schema_version', 'source_repo', 'started_at', 'status', 'target_base_sha', 'target_branch', 'workstream', 'workstream_run', 'worktree_root'],
  'autopilot.archive_info.v1': ['archive_ref', 'archived_at', 'autopilot_id', 'branch', 'schema_version', 'workstream', 'workstream_run'],
  'autopilot.attach_run_result.v2': ['bootstrap_artifact', 'bootstrap_graph', 'mailbox_cursor', 'repository', 'run', 'run_resource', 'schema_version', 'trust_anchor'],
  'autopilot.authority.v1': ['attempt', 'base_commit', 'edit_intentions', 'exclusives', 'observations', 'role', 'schema_version', 'unit_id', 'workstream'],
  'autopilot.branches.v1': ['active_branch', 'archive_ref', 'base_sha', 'current_sha', 'schema_version', 'unit_branches'],
  'autopilot.capacity_decision.v1': ['audit_ref', 'audit_sha256', 'decision_id', 'from_version', 'issued_at', 'policy_id', 'prior_policy_sha256', 'program_id', 'reason', 'repo_id', 'requested_expected_checkout_units', 'requested_maximum_parallel_cap', 'requested_parallel_cap', 'schema_version', 'signature', 'signer_key_id', 'to_version', 'trust_anchor_ref', 'trust_anchor_sha256', 'workstream_run'],
  'autopilot.checkout_profile.v1': ['always_include', 'auto_profile', 'disk_gate', 'exclude', 'materialization', 'mode', 'schema_version'],
  'autopilot.checkout_profile_snapshot.v1': ['base_checkout_bytes', 'base_patterns', 'created_at', 'full_checkout_bytes', 'profile', 'profile_origin', 'profile_sha256', 'profile_source_path', 'schema_version', 'tracked_head_sha'],
  'autopilot.claim_event.v1': ['active_run_epoch', 'attempt', 'autopilot_id', 'blockers', 'claim_type', 'event', 'path', 'reason', 'repo_key', 'schema_version', 'ts', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.claim_gc.v1': ['candidates', 'created_at', 'evidence_path', 'mode', 'released_claims', 'repo_key', 'schema_version'],
  'autopilot.claim_response_tool_result.v1': ['owner_reason', 'release_condition', 'request_id', 'schema_version', 'status', 'version'],
  'autopilot.claim_snapshot.v1': ['claims', 'created_at', 'dispatch_id', 'schema_version', 'workstream'],
  'autopilot.close_attempt.v1': ['autopilot_id', 'branch', 'created_at', 'repo_key', 'schema_version', 'source_repo', 'target_branch', 'workstream', 'workstream_run', 'worktree_path'],
  'autopilot.close_result.v1': ['archive_ref', 'archived_runtime_path', 'autopilot_id', 'blockers', 'branch', 'changed_paths', 'close_result_path', 'created_at', 'integration_commit_sha', 'merge_id', 'outcome', 'released_claims', 'repo_key', 'schema_version', 'target_after', 'target_before', 'target_branch', 'workstream', 'workstream_after', 'workstream_before', 'workstream_run'],
  'autopilot.continuation_event.v1': ['attempt', 'child_lease_id', 'class', 'cooldown_until', 'event_id', 'event_sequence', 'evidence_refs', 'failed_receipt_ref', 'failed_spec_ref', 'observed_at', 'operator_decision_ref', 'prior_graph_sha256', 'program_id', 'provider', 'repo_id', 'result_graph_sequence', 'retry_ordinal', 'schema_version', 'session_lease_id', 'successor_id', 'trigger', 'unit_id', 'workstream_run'],
  'autopilot.coordination_freeze.v1': ['acknowledgement_deadline_at', 'dispatch', 'freeze_token', 'frozen_at', 'migration_id', 'repo_key', 'required_database_schema_version', 'required_package_build', 'required_protocol_version', 'schema_version', 'writer_policy'],
  'autopilot.coordination_freeze_ack.v1': ['acknowledged_at', 'boot_id', 'client_kind', 'critical_section', 'database_schema_version', 'drain_state', 'freeze_token', 'migration_id', 'package_build', 'pid', 'protocol_version', 'repo_key', 'schema_version'],
  'autopilot.coordination_legacy_archive_manifest.v1': ['entries', 'schema_version'],
  'autopilot.coordination_migration_import_result.v1': ['replayed', 'report', 'schema_version'],
  'autopilot.coordination_migration_journal.v1': ['backup_path', 'backup_sha256', 'completed_effects', 'created_at', 'database_existed_before', 'freeze_token', 'git_snapshot', 'migration_id', 'repo_key', 'report', 'repository_git_common_dir', 'repository_root', 'schema_version', 'snapshot_entries', 'snapshot_sha256', 'state', 'updated_at'],
  'autopilot.coordination_migration_lock.v1': ['boot_id', 'created_at', 'pid', 'schema_version', 'token'],
  'autopilot.coordination_migration_report.v1': ['active_run_count', 'backup_path', 'blockers', 'classified_claim_count', 'command', 'created_at', 'cutover_marker_path', 'dry_run', 'equivalent_lease_count', 'imported_attempt_count', 'imported_audit_count', 'imported_lease_count', 'imported_reservation_count', 'imported_run_count', 'imported_worktree_count', 'legacy_claim_count', 'migration_id', 'rebound_old_epoch_claim_count', 'recovery', 'recovery_work_count', 'repo_key', 'schema_version', 'snapshot_sha256', 'source_file_count', 'source_total_bytes', 'state', 'terminal_leak_count'],
  'autopilot.coordination_preflight.v1': ['active_row_count', 'active_rows_sha256', 'claim_count', 'created_at', 'diagnostic_path', 'findings', 'mode', 'path_claims_sha256', 'repo_key', 'safe', 'schema_version', 'truncated_findings', 'workstream'],
  'autopilot.coordination_recovery_operation.v1': ['boot_id', 'created_at', 'pid', 'schema_version', 'token'],
  'autopilot.cf50_fixed_path_barrier.v1': ['generation_id', 'publication_sha256', 'schema_version', 'source_database_sha256'],
  'autopilot.coordinator_cursor.v1': ['kind', 'offset', 'revision_sha256', 'schema_version', 'scope_sha256', 'section', 'snapshot'],
  'autopilot.coordinator_export.v1': ['database_schema_version', 'exported_at', 'package_build', 'protocol_version', 'schema_version', 'snapshot'],
  'autopilot.coordinator_export_result.v1': ['output_path', 'schema_version', 'sha256'],
  'autopilot.coordinator_handshake.v1': ['admission_upgrade', 'database_schema_version', 'lifecycle_boot_id', 'lifecycle_instance_id', 'lifecycle_lock_schema', 'lifecycle_pid', 'lifecycle_process_start_identity', 'lifecycle_started_at', 'package_build', 'protocol_version', 'schema_version'],
  'autopilot.coordinator_lock.v1': ['boot_id', 'pid', 'schema_version', 'started_at', 'token'],
  'autopilot.coordinator_lock.v2': ['boot_id', 'database_schema_version', 'instance_id', 'package_build', 'pid', 'process_start_identity', 'protocol_version', 'schema_version', 'started_at', 'token'],
  'autopilot.coordinator_runtime_identity.v1': ['api_schema_version', 'current_store_pointer_sha256', 'implementation_build', 'legacy_facade_build', 'lifecycle_boot_id', 'lifecycle_instance_id', 'lifecycle_pid', 'lifecycle_process_start_identity', 'published_at', 'schema_version', 'store_generation_id', 'store_schema_version', 'wire_lineage'],
  'autopilot.coordinator_semantic_replay.v1': ['database_schema_version', 'header_sha256', 'package_build', 'protocol_version', 'record_count', 'records_sha256', 'replay_id', 'schema_version'],
  'autopilot.coordinator_semantic_replay_receipt.v1': ['applied_at', 'record_count', 'records_sha256', 'replay_id', 'schema_version'],
  'autopilot.coordinator_session_context.v1': ['autopilot_id', 'boot_id', 'pid', 'repo_id', 'repo_key', 'run_version', 'schema_version', 'session_generation', 'session_id', 'session_lease_id', 'session_token', 'session_version', 'state_root', 'workstream', 'workstream_run'],
  'autopilot.coordinator_startup_lock.v1': ['acquired_at', 'boot_id', 'pid', 'schema_version', 'token'],
  'autopilot.coordinator_startup_report.v1': ['attempt_id', 'diagnostics_truncated', 'error', 'exact_competing_lifecycle_owner_observed', 'failure_class', 'failure_code', 'lifecycle', 'omitted_code_points', 'outcome', 'phase', 'schema_version', 'selected_compiled_entrypoint', 'spawned_pid', 'updated_at'],
  'autopilot.coordinator_status.v1': ['accepted_program_heartbeat', 'acquisition_groups', 'adjudication_assignments', 'authoritative_artifacts', 'change_reservations', 'child_leases', 'claim_requests', 'coordination_migration_report_recovery_omitted', 'coordination_migrations', 'coordinator_time', 'database_schema_version', 'deadlock_resolutions', 'edit_leases', 'escalations', 'healthy', 'mailbox_cursors', 'mailbox_deliveries', 'migration_recovery_total_count', 'migration_recovery_work', 'migration_recovery_work_complete', 'negotiated_coordinator_identity', 'observations', 'package_build', 'pending_messages', 'pending_migration_recovery_count', 'protocol_version', 'reconciliation_evidence', 'reconciliation_receipts', 'repositories', 'reservation_obligations', 'result_receipts', 'run_resources', 'run_scoped_logical_faults', 'run_terminal_intents', 'runs', 'schema_version', 'semantic_snapshot_sha256', 'session_leases', 'unit_attempts', 'wait_for_edges', 'worktree_operations', 'worktrees'],
  'autopilot.coordinator_store_generation.v1': ['created_at', 'generation_id', 'migration_checksums', 'publication_database_sha256', 'schema_version', 'source_database_sha256', 'source_generation_id', 'source_kind', 'store_schema_version'],
  'autopilot.coordinator_store_pointer.v1': ['generation_id', 'previous_generation_id', 'publication_sha256', 'published_at', 'relative_generation_path', 'schema_version', 'store_schema_version'],
  'autopilot.coordinator_transport.v1': ['capability_ref', 'endpoint', 'generation', 'schema_version', 'transport_kind'],
  'autopilot.coordinator_upgrade_backup.v1': ['created_at', 'integrity', 'path', 'schema_version', 'sha256', 'source_database_schema_version'],
  'autopilot.coordinator_upgrade_intent.v1': ['backup', 'blockers', 'created_at', 'failure', 'predecessor_fence', 'safe_checkpoints', 'schema_version', 'source', 'state', 'target', 'updated_at', 'upgrade_id'],
  'autopilot.dispatch.v1': ['created_at', 'dispatch_id', 'parallel_cap', 'running_count', 'schema_version', 'selected', 'skipped', 'workstream'],
  'autopilot.expected_status_identity.v1': ['attempt', 'provider_identity', 'receipt_output', 'role', 'schema_sha256', 'schema_version', 'status_output', 'tool_name', 'unit_id', 'workstream'],
  'autopilot.foreign_merge_ack.v1': ['ack_id', 'acked_at', 'acknowledging_autopilot_id', 'acknowledging_workstream_run', 'action', 'foreign_autopilot_id', 'foreign_workstream_run', 'intersection_paths', 'merge_id', 'repo_key', 'schema_version'],
  'autopilot.graph_publication.v1': ['artifact_id', 'authority_base_commit', 'authority_commit', 'authority_path_count', 'authority_path_manifest_sha256', 'authority_tree', 'autopilot_id', 'covered_event_seq', 'created_at', 'graph_byte_count', 'graph_ref', 'graph_sequence', 'graph_sha256', 'prior_authority_kind', 'prior_graph_sha256', 'prior_publication_commit', 'prior_registration_event_seq', 'program_id', 'publication_commit', 'publication_id', 'publication_tree', 'registration_event_seq', 'repo_id', 'schema_version', 'stage', 'updated_at', 'workstream_run'],
  'autopilot.heartbeat_high_water.v1': ['heartbeat_sha256', 'issued_at', 'program_id', 'repo_id', 'schema_version', 'sequence', 'updated_at', 'valid_until', 'workstream_run'],
  'autopilot.identity_fault_resolution_evidence.v1': ['canonical_entity_id', 'evidence', 'fault_id', 'resolved_at', 'resolved_by', 'schema_version'],
  'autopilot.integration_analysis.v1': ['attempt', 'classification', 'created_at', 'integration_before', 'schema_version', 'unit_head', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.launch_policy.v1': ['base_commit', 'base_tree', 'bootstrap_graph_sha256', 'bootstrap_receipt_event_seq', 'capacity_decision_ref', 'capacity_decision_sha256', 'expected_checkout_units', 'issued_at', 'maximum_parallel_cap', 'package_commit', 'package_tree', 'parallel_cap', 'policy_id', 'policy_version', 'prior_policy_sha256', 'program_evidence_root', 'program_id', 'repo_id', 'roster_sha256', 'schema_version', 'signature', 'signer_key_id', 'trust_anchor_ref', 'trust_anchor_sha256', 'workstream_run'],
  'autopilot.lock.v1': ['acquired_at', 'boot_id', 'holder_id', 'pid', 'schema_version', 'token'],
  'autopilot.mailbox_delivery_receipt.v1': ['completed', 'delivery_id', 'message_count', 'message_ids_sha256', 'repo_id', 'schema_version', 'session_lease_id', 'snapshot_through_event_seq', 'version', 'workstream_run'],
  'autopilot.manual_worktree_reconcile.v1': ['approved_by', 'canonical_path', 'created_at', 'evidence', 'reason', 'schema_version', 'worktree_id'],
  'autopilot.materialization_event.v1': ['attempt', 'automatic', 'byte_count', 'claim_type', 'event', 'paths', 'reason', 'schema_version', 'targets', 'ts', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.materialized_paths.v1': ['attempt', 'paths', 'schema_version', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.merge_conflict.v1': ['abort_status', 'attempt', 'classification', 'created_at', 'dirty_paths', 'error', 'integration_analysis_ref', 'integration_head', 'schema_version', 'unit_branch', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.merge_event.v1': ['autopilot_id', 'branch', 'changed_paths', 'integration_commit_sha', 'merge_id', 'merged_at', 'repo_key', 'schema_version', 'target_after', 'target_before', 'target_branch', 'workstream', 'workstream_after', 'workstream_before', 'workstream_run'],
  'autopilot.migration_authority_recovery.v1': ['attempt', 'autopilot_id', 'claim_mode', 'claim_path', 'edit_lease_id', 'recorded_event_seq', 'recovery_id', 'repo_id', 'resolution_type', 'schema_version', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.migration_terminal_release.v1': ['attempt', 'autopilot_id', 'claim_type', 'evidence_ref', 'evidence_sha256', 'evidence_source', 'exact_git_objects', 'filesystem_postconditions', 'mechanical_proof', 'path', 'released_from_active_import', 'released_post_cutover', 'repo_key', 'schema_version', 'supporting_evidence', 'unit_id', 'workstream_run'],
  'autopilot.mission.v1': ['artifact_or_invariant', 'authoritative_ref', 'clause_id', 'demanded_outcome', 'exact_requirement', 'schema_version', 'source_run', 'source_scope', 'source_type'],
  'autopilot.operator_trust_anchor.v1': ['key_id', 'key_kind', 'public_key_spki_sha256', 'schema_version', 'subject', 'valid_from', 'valid_until'],
  'autopilot.parent_loss.v1': ['doctor_ref', 'event_id', 'issued_at', 'last_graph', 'last_heartbeat', 'last_policy', 'lost_coordinator_session_identity', 'lost_physical_session_file_identity', 'observed_at', 'operator_decision_ref', 'program_id', 'repo_id', 'schema_version', 'signature', 'signer_key_id', 'status_ref', 'successor_boot_id', 'successor_budget', 'successor_generation', 'successor_physical_session_file_identity', 'successor_pid', 'successor_session_id', 'successor_session_lease_id', 'trust_anchor_ref', 'trust_anchor_sha256', 'workstream_run'],
  'autopilot.path_claim.v1': ['acquired_at', 'active_run_epoch', 'attempt', 'autopilot_id', 'claim_type', 'path', 'reason', 'schema_version', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.post_cutover_terminal_repair.v1': ['accepted_event_seq', 'attempt', 'audit_ref', 'audit_sha256', 'autopilot_id', 'child_lease_id', 'clean_zero_change_edit_release', 'mechanical_proof', 'receipt_ref', 'receipt_sha256', 'repo_id', 'schema_version', 'status_ref', 'status_sha256', 'transport_terminalized', 'unit_id', 'verdict', 'workstream_run'],
  'autopilot.program_heartbeat.v1': ['base_commit', 'base_tree', 'dispatch_allowed', 'issued_at', 'package_commit', 'package_tree', 'prior_sha256', 'program_id', 'provider_health', 'rows', 'schema_version', 'sequence', 'signature', 'signer_key_id', 'stop_reasons', 'trust_anchor_ref', 'trust_anchor_sha256', 'valid_until'],
  'autopilot.program_heartbeat_acceptance_result.v1': ['acceptance_kind', 'coordinator_time', 'heartbeat_ref', 'heartbeat_sha256', 'issued_at', 'prior_sha256', 'program_id', 'repo_id', 'schema_version', 'sequence', 'valid_until', 'workstream_run'],
  'autopilot.reconciliation_intent.v1': ['autopilot_id', 'evidence_path', 'evidence_ref', 'evidence_sha256', 'repo_id', 'schema_version', 'source', 'target_id', 'workstream_run'],
  'autopilot.reconciliation_intent_supersession.v1': ['autopilot_id', 'disposition', 'evidence_ref', 'evidence_sha256', 'historical_action', 'historical_generation', 'pending_intent_sha256', 'repo_id', 'schema_version', 'source', 'target_id', 'workstream_run'],
  'autopilot.repo_key.v1': ['git_common_dir', 'repo_key', 'schema_version'],
  'autopilot.reservation_integration.v1': ['autopilot_id', 'changed_paths', 'classification', 'covered_paths', 'integrated_at', 'integration_before', 'integration_head', 'obligation_id', 'predecessor_released_event_seq', 'predecessor_reservation_id', 'predecessor_terminal_sha', 'repo_id', 'reservation_id', 'schema_version', 'workstream', 'workstream_run'],
  'autopilot.reservation_repair.v1': ['autopilot_id', 'classification', 'created_at', 'current_head', 'obligation_id', 'overlapping_paths', 'predecessor_reservation_id', 'predecessor_terminal_sha', 'repo_id', 'required_next_state', 'reservation_id', 'schema_version', 'state', 'workstream', 'workstream_run'],
  'autopilot.run_scoped_fault.v1': ['created_event_seq', 'detail', 'entity_id', 'entity_type', 'fault_code', 'fault_id', 'invariant_id', 'repo_id', 'resolved_event_seq', 'schema_version', 'status', 'version', 'workstream_run'],
  'autopilot.run_terminal.v1': ['accepted_at', 'autopilot_id', 'cleanup_manifest_ref', 'cleanup_manifest_sha256', 'outcome', 'repo_key', 'schema_version', 'terminal_sha', 'workstream', 'workstream_run'],
  'autopilot.run_terminal_intent.v2': ['intent_attempt', 'outcome', 'prepared_event_seq', 'prior_terminal_intent_id', 'prior_terminal_intent_sha256', 'repo_id', 'reservation_ids', 'schema_version', 'state', 'terminal_effect_sets', 'terminal_event_seq', 'terminal_intent_id', 'version', 'workstream_run'],
  'autopilot.saga_execution_lock.v1': ['boot_id', 'pid', 'schema_version', 'token'],
  'autopilot.scheduler_config.v1': ['parallel_cap', 'schema_version', 'updated_at', 'updated_by', 'workstream'],
  'autopilot.schema9_read_recovery_retirement.v1': ['disposition', 'edit_lease_id', 'observation_id', 'repo_id', 'retired_event_seq', 'retired_recovery_work', 'schema_version', 'source_identity', 'workstream_run'],
  'autopilot.schema9_read_retirement.v1': ['acquisition_group_id', 'disposition', 'edit_lease_id', 'original_lease_payload', 'original_payload_sha256', 'owner', 'repo_id', 'requested_read', 'retired_event_seq', 'retired_recovery_work', 'revalidation_required', 'schema_version', 'workstream_run'],
  'autopilot.schema11_retirement.v1': ['backup_path', 'backup_sha256', 'database_schema_version', 'outcome', 'retired_package_build', 'retired_pid', 'schema_version'],
  'autopilot.semantic_graph.v1': ['autopilot_id', 'bootstrap_charter', 'bughunt', 'closure', 'collections', 'coordinator_projection', 'core', 'covered_authority_commit', 'covered_authority_tree', 'covered_event_seq', 'created_at', 'exceptions', 'graph_sequence', 'mode', 'prior_event_seq', 'prior_graph_sha256', 'program_id', 'queue_projection', 'repo_id', 'schema_version', 'work_items', 'workstream', 'workstream_run'],
  'autopilot.semantic_graph_authority_shard.v1': ['collection', 'entries', 'entry_count', 'first_identity', 'graph_sequence', 'last_identity', 'program_id', 'repo_id', 'schema_version', 'total_bytes', 'workstream_run'],
  'autopilot.semantic_graph_bootstrap.v1': ['allowed_bootstrap_operations', 'autopilot_id', 'byte_count', 'content_commit', 'content_tree', 'covered_event_seq', 'created_at', 'git_commit', 'graph_sequence', 'package_commit', 'package_tree', 'prior_graph_sha256', 'program_id', 'prospective_resource', 'prospective_run', 'ref', 'repo_id', 'run_nonce', 'run_timestamp', 'schema_version', 'sha256', 'trust_anchor_ref', 'trust_anchor_sha256', 'workstream', 'workstream_run'],
  'autopilot.semantic_graph_projection_shard.v1': ['entries', 'entry_count', 'first_identity', 'graph_sequence', 'last_identity', 'program_id', 'projection_kind', 'repo_id', 'schema_version', 'total_bytes', 'workstream_run'],
  'autopilot.status_tool_context.v1': ['artifact_root', 'expected_identity_hash', 'provider_identity', 'receipt_output', 'schema_sha256', 'schema_version', 'status_output', 'unit_spec'],
  'autopilot.store_invariant_repair.v1': ['invariant_id', 'observed_counter', 'observed_maximum_event_seq', 'repair', 'repo_id', 'schema_version'],
  'autopilot.subscription_probe.v1': ['cooldown_completed', 'cooldown_until', 'evidence_refs', 'expires_at', 'failed_attempt', 'healthy', 'issued_at', 'not_before', 'observed_at', 'prior_probe_sha256', 'probe_id', 'probe_sequence', 'program_id', 'provider', 'repo_id', 'retry_ordinal', 'schema_version', 'signature', 'signer_key_id', 'successor_attempt', 'trigger_continuation_ref', 'trigger_continuation_sha256', 'trust_anchor_ref', 'trust_anchor_sha256', 'unit_id', 'workstream_run'],
  'autopilot.task_info.v1': ['autopilot_id', 'base_sha', 'branch', 'git_common_dir', 'repo_key', 'runtime_root', 'schema_version', 'source_repo', 'started_at', 'status', 'target_base_sha', 'target_branch', 'workstream', 'workstream_run', 'worktree_path'],
  'autopilot.task_info.v2': ['autopilot_id', 'base_sha', 'branch', 'checkout_mode', 'checkout_profile_origin', 'checkout_profile_ref', 'checkout_profile_sha256', 'closed_at', 'coordination_authority', 'git_common_dir', 'repo_key', 'runtime_root', 'schema_version', 'source_repo', 'started_at', 'status', 'target_base_sha', 'target_branch', 'workstream', 'workstream_run', 'worktree_path'],
  'autopilot.terminal_cleanup.v1': ['archive_ref', 'archive_runtime_path', 'autopilot_id', 'outcome', 'prepared_at', 'repo_key', 'result', 'result_path', 'schema_version', 'terminal_sha', 'workstream', 'workstream_run'],
  'autopilot.unit_failure.v1': CURRENT_UNIT_FAILURE_FIELDS,
  'autopilot.unit_index.v1': ['schema_version', 'units'],
  'autopilot.unit_index_adjudication.v1': ['action', 'attempt', 'branches_ref', 'created_at', 'reason', 'schema_version', 'transport_failure_ref', 'unit_id', 'unit_index_ref', 'unit_info_ref', 'workstream', 'workstream_run'],
  'autopilot.unit_info.v1': ['archive_ref', 'attempt', 'autopilot_id', 'base_sha', 'branch', 'checkout_mode', 'checkout_profile_ref', 'created_at', 'current_sha', 'materialized_paths_ref', 'runtime_root', 'schema_version', 'status', 'unit_id', 'workstream', 'workstream_run', 'worktree_path'],
  'autopilot.unit_merge.v1': ['active_run_epoch', 'attempt', 'audit_ref', 'autopilot_id', 'changed_paths', 'execution_commit_ref', 'integration_after', 'integration_before', 'main_branch', 'merge_commit_sha', 'merged_at', 'receipt_ref', 'role', 'schema_version', 'status_ref', 'unit_branch', 'unit_head', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.unit_merge_intent.v1': ['attempt', 'autopilot_id', 'created_at', 'integration_before', 'role', 'schema_version', 'unit_head', 'unit_id', 'workstream', 'workstream_run'],
  'autopilot.validation_evidence.v1': ['audit_ref', 'audit_sha256', 'covered_path_groups', 'covered_paths', 'integration_head', 'receipt_ref', 'receipt_sha256', 'schema_version', 'source_attempt', 'source_unit_id', 'status_ref', 'status_sha256', 'unit_merge_ref', 'validated_at', 'validation_attempt', 'validation_unit_id', 'verdict', 'witness_ids', 'workstream'],
  'autopilot.validation_staleness.v1': ['created_at', 'invalidating_attempt', 'invalidating_unit_id', 'invalidating_unit_merge_ref', 'next_state', 'overlapping_paths', 'schema_version', 'source_attempt', 'source_unit_id', 'stale_validation_ref', 'workstream'],
  'autopilot.validation_staleness.v2': ['created_at', 'invalidating_kind', 'invalidating_obligation_id', 'invalidating_ref', 'next_state', 'overlapping_paths', 'schema_version', 'source_attempt', 'source_unit_id', 'stale_validation_ref', 'workstream'],
  'autopilot.worktree_alias.v1': ['alias_worktree_id', 'attempt', 'autopilot_id', 'canonical_worktree_id', 'created_event_seq', 'evidence_sha256', 'kind', 'reason', 'repo_id', 'resolution_state', 'schema_version', 'unit_id', 'workstream_run'],
  'autopilot.worktree_alias_migration_evidence.v1': ['alias_worktree_id', 'candidate_ids', 'canonical_worktree_id', 'classification', 'external_git_registration_branch_ref_facts', 'operation_counts', 'schema_version', 'semantic_identity'],
  'autopilot.worktree_bootstrap.v1': ['active', 'branches', 'profile_snapshot', 'schema_version', 'task_info'],
  'autopilot.worktree_cleanup_result.v1': ['active_task_dir_removed', 'autopilot_id', 'created_at', 'ledger_path', 'mode', 'pruned_git_metadata', 'reconciled_missing_paths', 'removed_paths', 'repo_key', 'retired_branches', 'schema_version', 'workstream', 'workstream_run'],
  'autopilot.worktree_index.v1': ['active', 'archive', 'schema_version'],
  'autopilot.worktree_ledger.v1': ['attempt', 'autopilot_id', 'base_sha', 'branch', 'event', 'main_path', 'mode', 'reason', 'repo_key', 'schema_version', 'ts', 'unit_id', 'unit_path', 'workstream', 'workstream_run'],
  'autopilot.worktree_metadata_reconcile_evidence.v1': ['approved_prunable_registration_paths', 'canonical_worktree_id', 'observed_after_registrations', 'observed_before_registrations', 'operation_key_sha256', 'preserved_refs_after', 'preserved_refs_before', 'schema_version'],
  'autopilot.worktree_metadata_reconcile_intent.v1': ['approved_before_registrations', 'approved_prunable_registration_paths', 'canonical_worktree_id', 'expected_after_registrations', 'git_common_dir', 'preserved_refs', 'recovery_evidence_sha256', 'repo_id', 'schema_version', 'target_registration_path'],
  'autopilot.worktree_operation_evidence.v1': ['capture_sha', 'completed_steps', 'error_code', 'intent_sha256', 'operation_id', 'operation_type', 'owner', 'proof', 'proof_source', 'schema_version', 'terminal_stage', 'worktree_id'],
  'autopilot.worktree_operation_key.v2': ['canonical_worktree_id', 'immutable_intent_sha256', 'operation_key_sha256', 'operation_type', 'schema_version'],
  'autopilot.worktree_rollback_supersession.v1': ['disposition', 'later_package_operations', 'owner', 'schema_version', 'superseded_operation', 'terminal_archive', 'worktree_id'],
} as const satisfies Readonly<Record<string, readonly string[]>>);

function sourceAnchoredExtraArtifactFields(schemaVersion: string): readonly string[] {
  return SOURCE_ANCHORED_EXTRA_PERSISTED_ARTIFACT_FIELDS[schemaVersion as keyof typeof SOURCE_ANCHORED_EXTRA_PERSISTED_ARTIFACT_FIELDS] ?? Object.freeze(['schema_version']);
}

const extraFamilies = EXTRA_PERSISTED_ARTIFACT_SCHEMAS
  .filter((schemaVersion) => schemaVersion !== 'autopilot.unit_failure.v1')
  .map((schemaVersion) => currentOnlyFamily(schemaVersion, schemaVersion.includes('coordinator_') ? 'transport-or-page' : 'runtime-evidence', sourceAnchoredExtraArtifactFields(schemaVersion), sourceAnchoredExtraArtifactFields(schemaVersion), 'schema-bearing persisted artifact inventoried from source-anchored producer/consumer definitions'));

const UNIT_FAILURE_FAMILY: PersistedArtifactFamilyDefinition = Object.freeze({
  family: 'autopilot.unit_failure.v1',
  schema_version: 'autopilot.unit_failure.v1',
  persistence: 'runtime-evidence',
  notes: 'BUG-177 fenced unit_failure evidence ingress; historical bytes are consumed only under explicit producer_build generations and are never rewritten',
  producer_ranges: Object.freeze([
    Object.freeze({
      first_generation: 1,
      last_generation: 1,
      producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.phase2Initial,
      exact_fields: HISTORICAL_INITIAL_UNIT_FAILURE_FIELDS,
      required_fields: HISTORICAL_INITIAL_UNIT_FAILURE_FIELDS,
      absent_field_defaults: Object.freeze([{ field: 'capture_commit_sha', value: null }, { field: 'capture_ref', value: null }]),
      unknown_field_policy: 'reject',
      current: false,
    }),
    Object.freeze({
      first_generation: 2,
      last_generation: 2,
      producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.captureCommitOnly,
      exact_fields: HISTORICAL_CAPTURE_COMMIT_UNIT_FAILURE_FIELDS,
      required_fields: HISTORICAL_CAPTURE_COMMIT_UNIT_FAILURE_FIELDS,
      absent_field_defaults: Object.freeze([{ field: 'capture_ref', value: null }]),
      unknown_field_policy: 'reject',
      current: false,
    }),
    Object.freeze({
      first_generation: UNIT_FAILURE_CURRENT_PRODUCER_GENERATION,
      last_generation: UNIT_FAILURE_CURRENT_PRODUCER_GENERATION,
      producer_build: COORDINATOR_IMPLEMENTATION_BUILD,
      exact_fields: CURRENT_UNIT_FAILURE_FIELDS,
      required_fields: CURRENT_UNIT_FAILURE_FIELDS,
      absent_field_defaults: Object.freeze([]),
      unknown_field_policy: 'reject',
      current: true,
    }),
  ]),
});

function dedupeFamilies(families: readonly PersistedArtifactFamilyDefinition[]): readonly PersistedArtifactFamilyDefinition[] {
  const byFamily = new Map<string, PersistedArtifactFamilyDefinition>();
  for (const family of families) {
    if (!byFamily.has(family.family)) byFamily.set(family.family, family);
  }
  return Object.freeze([...byFamily.values()].sort((left, right) => left.family.localeCompare(right.family)));
}

export const VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY = dedupeFamilies([
  UNIT_FAILURE_FAMILY,
  ...packageContractFamilies,
  ...coordinationFamilies,
  ...extraFamilies,
]);

export const VERSIONED_PERSISTED_ARTIFACT_FAMILY_IDS = Object.freeze(VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY.map((family) => family.family));

export function assertPersistedArtifactFamilyRegistryWellFormed(registry: readonly PersistedArtifactFamilyDefinition[] = VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY): void {
  const familyIds = new Set<string>();
  for (const family of registry) {
    if (familyIds.has(family.family)) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry has a duplicate family', [family.family]);
    familyIds.add(family.family);
    if (family.schema_version.length === 0 || family.producer_ranges.length === 0) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry family is incomplete', [family.family]);
    const ranges = [...family.producer_ranges].sort((left, right) => left.first_generation - right.first_generation || left.last_generation - right.last_generation);
    let expectedFirst = 1;
    const producerBuilds = new Set<string>();
    for (const range of ranges) {
      if (!Number.isSafeInteger(range.first_generation) || !Number.isSafeInteger(range.last_generation) || range.first_generation < 1 || range.last_generation < range.first_generation) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry has an invalid producer generation range', [family.family, JSON.stringify(range)]);
      if (range.first_generation !== expectedFirst) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry has a producer generation gap or overlap', [family.family, `expected=${String(expectedFirst)}`, `actual=${String(range.first_generation)}-${String(range.last_generation)}`]);
      expectedFirst = range.last_generation + 1;
      if (producerBuilds.has(range.producer_build)) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry has an ambiguous producer_build', [family.family, range.producer_build]);
      producerBuilds.add(range.producer_build);
      if (range.current && range.producer_build !== COORDINATOR_IMPLEMENTATION_BUILD) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry current range does not use the exact package implementation build', [family.family, range.producer_build]);
      const exactFields = sortedUnique(range.exact_fields);
      if (exactFields.length !== range.exact_fields.length || exactFields.some((field, index) => field !== range.exact_fields[index])) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry fields must be sorted and unique', [family.family, range.producer_build]);
      for (const required of range.required_fields) {
        if (!range.exact_fields.includes(required)) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry required field is outside exact field inventory', [family.family, required]);
      }
    }
  }
}

export function persistedArtifactFamily(family: string, registry: readonly PersistedArtifactFamilyDefinition[] = VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY): PersistedArtifactFamilyDefinition {
  const matches = registry.filter((candidate) => candidate.family === family);
  if (matches.length !== 1 || matches[0] === undefined) throw new CoordinationRuntimeError('invalid-request', 'unsupported persisted artifact family', [family]);
  return matches[0];
}

export function selectVersionedIngressProducer(input: {
  readonly family: string;
  readonly producer_build: string;
  readonly producer_generation: number;
  readonly registry?: readonly PersistedArtifactFamilyDefinition[];
}): VersionedIngressSelection {
  const family = persistedArtifactFamily(input.family, input.registry ?? VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY);
  const buildMatches = family.producer_ranges.filter((range) => range.producer_build === input.producer_build);
  if (buildMatches.length === 0) throw new CoordinationRuntimeError('protocol-mismatch', 'unsupported persisted artifact producer_build; compatibility is not inferred from semver or shape', [family.family, input.producer_build]);
  if (buildMatches.length > 1) throw new CoordinationRuntimeError('protocol-mismatch', 'ambiguous persisted artifact producer_build', [family.family, input.producer_build]);
  const range = buildMatches[0];
  if (range === undefined) throw new CoordinationRuntimeError('protocol-mismatch', 'unsupported persisted artifact producer_build', [family.family, input.producer_build]);
  const generation = input.producer_generation;
  if (!Number.isSafeInteger(generation)) throw new CoordinationRuntimeError('protocol-mismatch', 'persisted artifact producer generation is required explicitly and is never inferred', [family.family, input.producer_build]);
  if (generation < range.first_generation || generation > range.last_generation) throw new CoordinationRuntimeError('protocol-mismatch', 'persisted artifact producer generation is outside its exact producer_build fence', [family.family, input.producer_build, String(generation)]);
  return { family, range, producer_generation: generation };
}

export function parseVersionedPersistedArtifact(input: {
  readonly family: string;
  readonly producer_build: string;
  readonly bytes: Uint8Array;
  readonly producer_generation: number;
  readonly registry?: readonly PersistedArtifactFamilyDefinition[];
}): VersionedPersistedArtifactIngress {
  const selection = selectVersionedIngressProducer({ family: input.family, producer_build: input.producer_build, producer_generation: input.producer_generation, ...(input.registry === undefined ? {} : { registry: input.registry }) });
  const document = decodeJsonDocument(input.bytes, selection.family.family);
  if (stringField(document, 'schema_version', selection.family.family, 192) !== selection.family.schema_version) throw new CoordinationRuntimeError('schema-mismatch', 'persisted artifact schema_version does not match its selected family', [selection.family.family]);
  if (Object.hasOwn(document, 'producer_build') && stringField(document, 'producer_build', selection.family.family, 192) !== input.producer_build) throw new CoordinationRuntimeError('protocol-mismatch', 'persisted artifact producer_build field differs from selected provenance', [selection.family.family]);
  if (Object.hasOwn(document, 'producer_generation') && integerField(document, 'producer_generation', selection.family.family) !== input.producer_generation) throw new CoordinationRuntimeError('protocol-mismatch', 'persisted artifact producer_generation field differs from selected provenance', [selection.family.family]);
  const fields = sortedUnique(Object.keys(document));
  const unknownFields = fields.filter((field) => !selection.range.exact_fields.includes(field));
  if (selection.range.unknown_field_policy === 'reject' && unknownFields.length > 0) throw new CoordinationRuntimeError('schema-mismatch', 'persisted artifact has unknown fields for its exact producer generation', [selection.family.family, ...unknownFields]);
  for (const field of selection.range.required_fields) {
    if (!fields.includes(field)) throw new CoordinationRuntimeError('schema-mismatch', 'persisted artifact is missing a required field for its exact producer generation', [selection.family.family, field]);
  }
  const normalized: Record<string, unknown> = { ...document };
  const applied: VersionedIngressAbsentFieldDefault[] = [];
  for (const defaultField of selection.range.absent_field_defaults) {
    if (!fields.includes(defaultField.field)) {
      normalized[defaultField.field] = defaultField.value;
      applied.push(defaultField);
    }
  }
  return Object.freeze({
    family: selection.family.family,
    schema_version: selection.family.schema_version,
    producer_build: input.producer_build,
    producer_generation: selection.producer_generation,
    current: selection.range.current,
    original_sha256: digest(input.bytes),
    original_bytes: new Uint8Array(input.bytes),
    document,
    normalized_document: Object.freeze(normalized),
    original_fields: fields,
    unknown_fields: Object.freeze(unknownFields),
    applied_defaults: Object.freeze(applied),
  });
}

export function roundTripPersistedArtifactIngress(ingress: VersionedPersistedArtifactIngress): Uint8Array {
  return new Uint8Array(ingress.original_bytes);
}

function parseUnitFailureAction(document: JsonRecord): 'quarantine' | 'reset' | 'preserve' | 'abort' {
  const action = stringField(document, 'action', 'unit failure evidence', 32);
  if (action !== 'quarantine' && action !== 'reset' && action !== 'preserve' && action !== 'abort') throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence action is invalid');
  return action;
}

function stringArrayField(document: JsonRecord, field: string): readonly string[] {
  const value = document[field];
  if (!Array.isArray(value) || value.length > 4096 || value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 1024)) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be a bounded string array`);
  return Object.freeze(value.map((entry) => String(entry)));
}

function nullableText(document: JsonRecord, field: string): string | null {
  const value = document[field];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be bounded text or null`);
  return value;
}

export function parseVersionedUnitFailureIngress(input: {
  readonly bytes: Uint8Array;
  readonly producer_build: string;
  readonly identity: UnitFailureIngressIdentity;
  readonly producer_generation: number;
}): UnitFailureVersionedIngress {
  return parseCentralVersionedUnitFailureIngress(input) as UnitFailureVersionedIngress;
}
