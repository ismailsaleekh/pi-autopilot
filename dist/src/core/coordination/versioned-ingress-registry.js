import { createHash } from 'node:crypto';

import { AUTOPILOT_JSON_SCHEMAS } from '../contracts/schemas.js';
import { AUTOPILOT_SCHEMA_NAMES } from '../names.js';
import { AUTOPILOT_COORDINATION_JSON_SCHEMAS,                             } from './schemas.js';
import { COORDINATOR_IMPLEMENTATION_BUILD } from './runtime-constants.js';
import { CoordinationRuntimeError } from './failures.js';
import { BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS, UNIT_FAILURE_CURRENT_PRODUCER_GENERATION } from './unit-failure-producer-provenance.js';
export { BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS, UNIT_FAILURE_CURRENT_PRODUCER_GENERATION } from './unit-failure-producer-provenance.js';

                                                                       
                                                                                                                                                                            

                                                     
                         
                                                   
 

                                                
                                    
                                   
                                  
                                           
                                              
                                                                                
                                                                    
                            
 

                                                    
                          
                                  
                                                        
                         
                                                                     
 

                                            
                                                     
                                                
                                       
 

                      
                                  
 

                                                    
                          
                                  
                                  
                                       
                            
                                               
                                      
                                
                                           
                                              
                                             
                                                                           
 

                                             
                              
                                 
                          
                           
 

                                                   
                                                                 
                                    
                                           
                                     
                                              
                                             
                                                                          
 

                                              
                                
                                                      
                                                   
 

const CURRENT_PRODUCER_PROVENANCE_FIELDS = Object.freeze(['producer_build', 'producer_generation']         );

const CURRENT_UNIT_FAILURE_FIELDS = Object.freeze([
  'action', 'attempt', 'branch', 'capture_commit_sha', 'capture_ref', 'created_at', 'dirty_paths', 'git_common_dir', 'git_head_after', 'git_head_before',
  'postcondition_worktree_clean', ...CURRENT_PRODUCER_PROVENANCE_FIELDS, 'schema_version', 'summary', 'unit_id', 'unit_worktree_path', 'workstream', 'workstream_run',
].sort());
const HISTORICAL_INITIAL_UNIT_FAILURE_FIELDS = Object.freeze([
  'action', 'attempt', 'created_at', 'dirty_paths', 'schema_version', 'summary', 'unit_id', 'unit_worktree_path', 'workstream', 'workstream_run',
].sort());
const HISTORICAL_CAPTURE_COMMIT_UNIT_FAILURE_FIELDS = Object.freeze([...HISTORICAL_INITIAL_UNIT_FAILURE_FIELDS, 'capture_commit_sha'].sort());

function sortedUnique(values                   )                    {
  return Object.freeze([...new Set(values)].sort());
}

function isRecord(value         )                      {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value         , label        )             {
  if (!isRecord(value)) throw new CoordinationRuntimeError('invalid-state', `${label} must be a JSON object`);
  return value;
}

function stringField(record            , field        , label        , maxLength        )         {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be bounded non-empty text`);
  return value;
}

function integerField(record            , field        , label        )         {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new CoordinationRuntimeError('invalid-state', `${label}.${field} must be a positive integer`);
  return value;
}

function digest(bytes            )                     {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeJsonDocument(bytes            , label        )             {
  let parsed         ;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))           ;
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-state', `${label} is not valid UTF-8 JSON`, [error instanceof Error ? error.message : String(error)]);
  }
  return asRecord(parsed, label);
}

function schemaConst(schema                        , label        )         {
  const properties = asRecord(schema['properties'], `${label}.properties`);
  const schemaVersion = asRecord(properties['schema_version'], `${label}.properties.schema_version`)['const'];
  if (typeof schemaVersion !== 'string' || schemaVersion.length === 0) throw new CoordinationRuntimeError('invalid-state', `${label} lacks an exact schema_version const`);
  return schemaVersion;
}

function fieldNamesFromJsonSchema(schema                                   )                    {
  const properties = schema['properties'];
  if (!isRecord(properties)) return Object.freeze(['schema_version']);
  return sortedUnique(Object.keys(properties));
}

function requiredFieldNamesFromJsonSchema(schema                                   )                    {
  const required = schema['required'];
  if (!Array.isArray(required)) return Object.freeze(['schema_version']);
  return sortedUnique(required.filter((field)                  => typeof field === 'string'));
}

function currentRange(exactFields                   , requiredFields                    = exactFields)                                {
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

function currentOnlyFamily(schemaVersion        , persistence                                 , fields                   , required                   , notes        )                                    {
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

function coordinationSchemaVersion(name        , schema                        )         {
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
]         );

const SOURCE_ANCHORED_EXTRA_PERSISTED_ARTIFACT_FIELDS = Object.freeze({
  'autopilot.active_parent.v1': ['active_epoch_started_at', 'active_run_epoch', 'active_run_receipt_id', 'autopilot_id', 'boot_id', 'branch', 'git_common_dir', 'main_worktree_path', 'origin_url', 'pid', 'repo_key', 'runtime_root', 'schema_version', 'source_repo', 'started_at', 'status', 'target_base_sha', 'target_branch', 'workstream', 'workstream_run', 'worktree_root'],
  'autopilot.active_parent.v2': ['active_epoch_started_at', 'active_run_epoch', 'active_run_receipt_id', 'autopilot_id', 'boot_id', 'branch', 'coordination_authority', 'git_common_dir', 'main_worktree_path', 'origin_url', 'pid', 'repo_key', 'runtime_root', 'schema_version', 'source_repo', 'started_at', 'status', 'target_base_sha', 'target_branch', 'workstream', 'workstream_run', 'worktree_root'],
  'autopilot.cf50_fixed_path_barrier.v1': ['generation_id', 'publication_sha256', 'schema_version', 'source_database_sha256'],
  'autopilot.coordinator_store_generation.v1': ['created_at', 'generation_id', 'migration_checksums', 'publication_database_sha256', 'schema_version', 'source_database_sha256', 'source_generation_id', 'source_kind', 'store_schema_version'],
  'autopilot.coordinator_store_pointer.v1': ['generation_id', 'previous_generation_id', 'publication_sha256', 'published_at', 'relative_generation_path', 'schema_version', 'store_schema_version'],
  'autopilot.reconciliation_intent.v1': ['autopilot_id', 'evidence_path', 'evidence_ref', 'evidence_sha256', 'repo_id', 'schema_version', 'source', 'target_id', 'workstream_run'],
  'autopilot.reconciliation_intent_supersession.v1': ['autopilot_id', 'disposition', 'evidence_ref', 'evidence_sha256', 'historical_action', 'historical_generation', 'pending_intent_sha256', 'repo_id', 'schema_version', 'source', 'target_id', 'workstream_run'],
  'autopilot.schema9_read_recovery_retirement.v1': ['disposition', 'edit_lease_id', 'observation_id', 'repo_id', 'retired_event_seq', 'retired_recovery_work', 'schema_version', 'source_identity', 'workstream_run'],
  'autopilot.schema9_read_retirement.v1': ['acquisition_group_id', 'disposition', 'edit_lease_id', 'original_lease_payload', 'original_payload_sha256', 'owner', 'repo_id', 'requested_read', 'retired_event_seq', 'retired_recovery_work', 'revalidation_required', 'schema_version', 'workstream_run'],
  'autopilot.unit_failure.v1': CURRENT_UNIT_FAILURE_FIELDS,
}                                                               );

function sourceAnchoredExtraArtifactFields(schemaVersion        )                    {
  return SOURCE_ANCHORED_EXTRA_PERSISTED_ARTIFACT_FIELDS[schemaVersion                                                                ] ?? Object.freeze(['schema_version']);
}

const extraFamilies = EXTRA_PERSISTED_ARTIFACT_SCHEMAS
  .filter((schemaVersion) => schemaVersion !== 'autopilot.unit_failure.v1')
  .map((schemaVersion) => currentOnlyFamily(schemaVersion, schemaVersion.includes('coordinator_') ? 'transport-or-page' : 'runtime-evidence', sourceAnchoredExtraArtifactFields(schemaVersion), sourceAnchoredExtraArtifactFields(schemaVersion), 'schema-bearing persisted artifact inventoried from source-anchored producer/consumer definitions'));

const UNIT_FAILURE_FAMILY                                    = Object.freeze({
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

function dedupeFamilies(families                                              )                                               {
  const byFamily = new Map                                           ();
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

export function assertPersistedArtifactFamilyRegistryWellFormed(registry                                               = VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY)       {
  const familyIds = new Set        ();
  for (const family of registry) {
    if (familyIds.has(family.family)) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry has a duplicate family', [family.family]);
    familyIds.add(family.family);
    if (family.schema_version.length === 0 || family.producer_ranges.length === 0) throw new CoordinationRuntimeError('invalid-state', 'versioned ingress registry family is incomplete', [family.family]);
    const ranges = [...family.producer_ranges].sort((left, right) => left.first_generation - right.first_generation || left.last_generation - right.last_generation);
    let expectedFirst = 1;
    const producerBuilds = new Set        ();
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

export function persistedArtifactFamily(family        , registry                                               = VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY)                                    {
  const matches = registry.filter((candidate) => candidate.family === family);
  if (matches.length !== 1 || matches[0] === undefined) throw new CoordinationRuntimeError('invalid-request', 'unsupported persisted artifact family', [family]);
  return matches[0];
}

export function selectVersionedIngressProducer(input   
                          
                                  
                                       
                                                                   
 )                            {
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

export function parseVersionedPersistedArtifact(input   
                          
                                  
                             
                                       
                                                                   
 )                                    {
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
  const normalized                          = { ...document };
  const applied                                       = [];
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

export function roundTripPersistedArtifactIngress(ingress                                   )             {
  return new Uint8Array(ingress.original_bytes);
}

function parseUnitFailureAction(document            )                                                {
  const action = stringField(document, 'action', 'unit failure evidence', 32);
  if (action !== 'quarantine' && action !== 'reset' && action !== 'preserve' && action !== 'abort') throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence action is invalid');
  return action;
}

function stringArrayField(document            , field        )                    {
  const value = document[field];
  if (!Array.isArray(value) || value.length > 4096 || value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 1024)) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be a bounded string array`);
  return Object.freeze(value.map((entry) => String(entry)));
}

function nullableText(document            , field        )                {
  const value = document[field];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be bounded text or null`);
  return value;
}

export function parseVersionedUnitFailureIngress(input   
                             
                                  
                                                
                                       
 )                              {
  const ingress = parseVersionedPersistedArtifact({ family: 'autopilot.unit_failure.v1', producer_build: input.producer_build, bytes: input.bytes, producer_generation: input.producer_generation });
  const document = ingress.normalized_document;
  if (stringField(document, 'workstream', 'unit failure evidence', 192) !== input.identity.workstream) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence workstream does not match durable ownership');
  if (stringField(document, 'workstream_run', 'unit failure evidence', 192) !== input.identity.workstreamRun) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence workstream_run does not match durable ownership');
  if (stringField(document, 'unit_id', 'unit failure evidence', 192) !== input.identity.unitId) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence unit_id does not match durable ownership');
  if (integerField(document, 'attempt', 'unit failure evidence') !== input.identity.attempt) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence attempt does not match durable ownership');
  stringArrayField(document, 'dirty_paths');
  const action = parseUnitFailureAction(document);
  const unitWorktreePath = stringField(document, 'unit_worktree_path', 'unit failure evidence', 1024);
  const captureCommitSha = nullableText(document, 'capture_commit_sha');
  const captureRef = nullableText(document, 'capture_ref');
  if (ingress.current) {
    if ((action === 'quarantine' || action === 'preserve') && (captureCommitSha === null || captureRef === null)) throw new CoordinationRuntimeError('invalid-state', 'current quarantine/preserve unit failure evidence requires an immutable capture commit and ref');
    if ((action === 'reset' || action === 'abort') && (captureCommitSha !== null || captureRef !== null)) throw new CoordinationRuntimeError('invalid-state', 'current clean reset/abort unit failure evidence cannot claim quarantine capture fields');
    if (document['postcondition_worktree_clean'] !== true) throw new CoordinationRuntimeError('invalid-state', 'current unit failure evidence must assert a clean postcondition');
    stringField(document, 'git_head_before', 'unit failure evidence', 64);
    stringField(document, 'git_head_after', 'unit failure evidence', 64);
    stringField(document, 'git_common_dir', 'unit failure evidence', 1024);
    stringField(document, 'branch', 'unit failure evidence', 512);
  } else {
    if (action === 'quarantine' || action === 'preserve') throw new CoordinationRuntimeError('recovery-required', 'historical quarantine/preserve unit failure evidence lacks an exact capture ref; edit authority remains retained');
    if (captureCommitSha !== null || captureRef !== null) throw new CoordinationRuntimeError('invalid-state', 'historical reset/abort unit failure evidence cannot carry capture fields after generation defaults');
  }
  return Object.freeze({
    kind: 'unit_failure',
    ingress,
    facts: Object.freeze({
      action,
      unitWorktreePath,
      captureCommitSha,
      captureRef,
      originalSha256: ingress.original_sha256,
      originalFields: ingress.original_fields,
      appliedDefaults: ingress.applied_defaults,
    }),
  });
}
