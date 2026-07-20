import { array, boolean, fail, gitOid, identifier, integer, literal, nullableGitOid, nullableSha256Field, nullableStr, object, oneOf, repoRelativePath, sha256Field, str, timestamp, } from "./d65-semantic-graph.js";
// D65-A4 cap-one launch policy and monitor consumer (freeze §9.2/§9.4, fresh
// plan §2.3/§3.2). These are the closed, versioned, size-bounded, lowest-layer
// parsers owned by the cap-one consumer: the immutable launch policy, the
// capacity decision (only path to raise the maximum), the one-use subscription
// probe, the signed program heartbeat, the durable heartbeat-acceptance result,
// and the reconstructable-cache high-water record. Signatures are verified
// separately against the frozen trust anchor with domain separation.
// ---- autopilot.launch_policy.v1 ---------------------------------------------
export const D65_LAUNCH_POLICY_SCHEMA = 'autopilot.launch_policy.v1';
function absolutePathField(record, field, label) {
    const value = str(record, field, label, 1024);
    if (!value.startsWith('/') || value.includes('\u0000') || value.includes('/../') || value.endsWith('/..') || value.includes('//'))
        fail(label, `${field} must be a normalized absolute path`);
    return value;
}
function unpaddedBase64Url(record, field, label) {
    const value = str(record, field, label, 128);
    if (!/^[A-Za-z0-9_-]+$/u.test(value))
        fail(label, `${field} must be unpadded base64url`);
    return value;
}
export function parseD65LaunchPolicy(value) {
    const label = D65_LAUNCH_POLICY_SCHEMA;
    const record = object(value, label, [
        'schema_version', 'program_id', 'policy_id', 'policy_version', 'repo_id', 'workstream_run',
        'package_commit', 'package_tree', 'base_commit', 'base_tree', 'bootstrap_graph_sha256',
        'bootstrap_receipt_event_seq', 'roster_sha256', 'parallel_cap', 'maximum_parallel_cap',
        'expected_checkout_units', 'program_evidence_root', 'trust_anchor_ref', 'trust_anchor_sha256',
        'prior_policy_sha256', 'capacity_decision_ref', 'capacity_decision_sha256', 'issued_at',
        'signer_key_id', 'signature',
    ]);
    literal(record, 'schema_version', D65_LAUNCH_POLICY_SCHEMA, label);
    const policyVersion = integer(record, 'policy_version', label, 1);
    // All three limits are exactly 1 under D65 (parallel_cap and
    // expected_checkout_units always; maximum_parallel_cap for version 1).
    if (record['parallel_cap'] !== 1)
        fail(label, 'parallel_cap must be exactly 1');
    if (record['expected_checkout_units'] !== 1)
        fail(label, 'expected_checkout_units must be exactly 1');
    const maximumParallelCap = integer(record, 'maximum_parallel_cap', label, 1);
    const priorPolicy = nullableSha256Field(record, 'prior_policy_sha256', label);
    const capacityDecisionRef = record['capacity_decision_ref'] === null ? null : repoRelativePath(record, 'capacity_decision_ref', label);
    const capacityDecisionSha = nullableSha256Field(record, 'capacity_decision_sha256', label);
    if (policyVersion === 1) {
        // Initial version: prior/decision fields are null and maximum is exactly 1.
        if (priorPolicy !== null || capacityDecisionRef !== null || capacityDecisionSha !== null)
            fail(label, 'initial policy version 1 must have null prior/decision fields');
        if (maximumParallelCap !== 1)
            fail(label, 'initial policy maximum_parallel_cap must be exactly 1');
    }
    else {
        if (priorPolicy === null)
            fail(label, 'a superseding policy must name the prior policy digest');
        if (capacityDecisionRef === null || capacityDecisionSha === null)
            fail(label, 'a superseding policy requires an exact capacity decision reference');
    }
    return {
        schema_version: D65_LAUNCH_POLICY_SCHEMA,
        program_id: identifier(record, 'program_id', label),
        policy_id: identifier(record, 'policy_id', label),
        policy_version: policyVersion,
        repo_id: identifier(record, 'repo_id', label),
        workstream_run: identifier(record, 'workstream_run', label),
        package_commit: gitOid(record, 'package_commit', label),
        package_tree: gitOid(record, 'package_tree', label),
        base_commit: gitOid(record, 'base_commit', label),
        base_tree: gitOid(record, 'base_tree', label),
        bootstrap_graph_sha256: sha256Field(record, 'bootstrap_graph_sha256', label),
        bootstrap_receipt_event_seq: integer(record, 'bootstrap_receipt_event_seq', label, 1),
        roster_sha256: sha256Field(record, 'roster_sha256', label),
        parallel_cap: 1,
        maximum_parallel_cap: maximumParallelCap,
        expected_checkout_units: 1,
        program_evidence_root: absolutePathField(record, 'program_evidence_root', label),
        trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label),
        trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
        prior_policy_sha256: priorPolicy,
        capacity_decision_ref: capacityDecisionRef,
        capacity_decision_sha256: capacityDecisionSha,
        issued_at: timestamp(record, 'issued_at', label),
        signer_key_id: sha256Field(record, 'signer_key_id', label),
        signature: unpaddedBase64Url(record, 'signature', label),
    };
}
// ---- autopilot.capacity_decision.v1 -----------------------------------------
export const D65_CAPACITY_DECISION_SCHEMA = 'autopilot.capacity_decision.v1';
export function parseD65CapacityDecision(value) {
    const label = D65_CAPACITY_DECISION_SCHEMA;
    const record = object(value, label, [
        'schema_version', 'program_id', 'decision_id', 'policy_id', 'from_version', 'to_version', 'repo_id',
        'workstream_run', 'prior_policy_sha256', 'requested_parallel_cap', 'requested_maximum_parallel_cap',
        'requested_expected_checkout_units', 'reason', 'audit_ref', 'audit_sha256', 'issued_at',
        'trust_anchor_ref', 'trust_anchor_sha256', 'signer_key_id', 'signature',
    ]);
    literal(record, 'schema_version', D65_CAPACITY_DECISION_SCHEMA, label);
    const fromVersion = integer(record, 'from_version', label, 1);
    const toVersion = integer(record, 'to_version', label, 2);
    // Contiguous versions only.
    if (toVersion !== fromVersion + 1)
        fail(label, 'capacity decision versions must be contiguous (to_version = from_version + 1)');
    return {
        schema_version: D65_CAPACITY_DECISION_SCHEMA,
        program_id: identifier(record, 'program_id', label),
        decision_id: identifier(record, 'decision_id', label),
        policy_id: identifier(record, 'policy_id', label),
        from_version: fromVersion,
        to_version: toVersion,
        repo_id: identifier(record, 'repo_id', label),
        workstream_run: identifier(record, 'workstream_run', label),
        prior_policy_sha256: sha256Field(record, 'prior_policy_sha256', label),
        requested_parallel_cap: integer(record, 'requested_parallel_cap', label, 1),
        requested_maximum_parallel_cap: integer(record, 'requested_maximum_parallel_cap', label, 1),
        requested_expected_checkout_units: integer(record, 'requested_expected_checkout_units', label, 1),
        reason: str(record, 'reason', label, 1024),
        audit_ref: repoRelativePath(record, 'audit_ref', label),
        audit_sha256: sha256Field(record, 'audit_sha256', label),
        issued_at: timestamp(record, 'issued_at', label),
        trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label),
        trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
        signer_key_id: sha256Field(record, 'signer_key_id', label),
        signature: unpaddedBase64Url(record, 'signature', label),
    };
}
// ---- autopilot.capacity_decision result codes -------------------------------
/** Closed launch-policy verification failure reasons (fresh plan §2.3). */
export const D65_LAUNCH_POLICY_FAILURES = [
    'launch-policy-invalid',
    'launch-policy-cap-unauthorized',
    'launch-policy-cas-conflict',
];
// ---- autopilot.subscription_probe.v1 ----------------------------------------
export const D65_SUBSCRIPTION_PROBE_SCHEMA = 'autopilot.subscription_probe.v1';
export function parseD65SubscriptionProbe(value) {
    const label = D65_SUBSCRIPTION_PROBE_SCHEMA;
    const record = object(value, label, [
        'schema_version', 'probe_id', 'program_id', 'probe_sequence', 'prior_probe_sha256', 'provider',
        'trigger_continuation_ref', 'trigger_continuation_sha256', 'repo_id', 'workstream_run', 'unit_id',
        'failed_attempt', 'retry_ordinal', 'successor_attempt', 'observed_at', 'cooldown_until', 'issued_at',
        'not_before', 'expires_at', 'healthy', 'cooldown_completed', 'evidence_refs', 'trust_anchor_ref',
        'trust_anchor_sha256', 'signer_key_id', 'signature',
    ]);
    literal(record, 'schema_version', D65_SUBSCRIPTION_PROBE_SCHEMA, label);
    const probeSequence = integer(record, 'probe_sequence', label, 1);
    const priorProbe = nullableSha256Field(record, 'prior_probe_sha256', label);
    if (probeSequence === 1 && priorProbe !== null)
        fail(label, 'probe_sequence 1 must have null prior_probe_sha256');
    if (probeSequence > 1 && priorProbe === null)
        fail(label, 'a chained probe must name the prior probe digest');
    const failedAttempt = integer(record, 'failed_attempt', label, 1);
    const successorAttempt = integer(record, 'successor_attempt', label, 2);
    if (successorAttempt !== failedAttempt + 1)
        fail(label, 'successor_attempt must equal failed_attempt + 1');
    if (record['retry_ordinal'] !== 1)
        fail(label, 'retry_ordinal must be exactly 1 (a second/exhausted failure has no probe-authorized successor)');
    if (record['healthy'] !== true)
        fail(label, 'healthy must be true');
    if (record['cooldown_completed'] !== true)
        fail(label, 'cooldown_completed must be true');
    const observedAt = timestamp(record, 'observed_at', label);
    const cooldownUntil = timestamp(record, 'cooldown_until', label);
    const notBefore = timestamp(record, 'not_before', label);
    const issuedAt = timestamp(record, 'issued_at', label);
    const expiresAt = timestamp(record, 'expires_at', label);
    // not_before = cooldown_until; not_before <= observed_at <= issued_at; expires_at = issued_at + 5m.
    if (notBefore !== cooldownUntil)
        fail(label, 'not_before must equal cooldown_until');
    if (!(Date.parse(notBefore) <= Date.parse(observedAt) && Date.parse(observedAt) <= Date.parse(issuedAt)))
        fail(label, 'timestamps must satisfy not_before <= observed_at <= issued_at');
    if (Date.parse(expiresAt) - Date.parse(issuedAt) !== 5 * 60 * 1000)
        fail(label, 'expires_at must be exactly issued_at + 5 minutes');
    const evidenceRefs = array(record['evidence_refs'], `${label}.evidence_refs`, 64).map((entry, index) => {
        if (typeof entry !== 'string')
            fail(label, `evidence_refs[${String(index)}] must be a repository-relative path`);
        return repoRelativePath({ ref: entry }, 'ref', `${label}.evidence_refs[${String(index)}]`);
    });
    return {
        schema_version: D65_SUBSCRIPTION_PROBE_SCHEMA,
        probe_id: identifier(record, 'probe_id', label),
        program_id: identifier(record, 'program_id', label),
        probe_sequence: probeSequence,
        prior_probe_sha256: priorProbe,
        provider: identifier(record, 'provider', label),
        trigger_continuation_ref: repoRelativePath(record, 'trigger_continuation_ref', label),
        trigger_continuation_sha256: sha256Field(record, 'trigger_continuation_sha256', label),
        repo_id: identifier(record, 'repo_id', label),
        workstream_run: identifier(record, 'workstream_run', label),
        unit_id: identifier(record, 'unit_id', label),
        failed_attempt: failedAttempt,
        retry_ordinal: 1,
        successor_attempt: successorAttempt,
        observed_at: observedAt,
        cooldown_until: cooldownUntil,
        issued_at: issuedAt,
        not_before: notBefore,
        expires_at: expiresAt,
        healthy: true,
        cooldown_completed: true,
        evidence_refs: Object.freeze(evidenceRefs),
        trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label),
        trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
        signer_key_id: sha256Field(record, 'signer_key_id', label),
        signature: unpaddedBase64Url(record, 'signature', label),
    };
}
// ---- autopilot.heartbeat_high_water.v1 (reconstructable cache) ---------------
export const D65_HEARTBEAT_HIGH_WATER_SCHEMA = 'autopilot.heartbeat_high_water.v1';
export function parseD65HeartbeatHighWater(value) {
    const label = D65_HEARTBEAT_HIGH_WATER_SCHEMA;
    const record = object(value, label, [
        'schema_version', 'program_id', 'repo_id', 'workstream_run', 'sequence', 'heartbeat_sha256',
        'issued_at', 'valid_until', 'updated_at',
    ]);
    literal(record, 'schema_version', D65_HEARTBEAT_HIGH_WATER_SCHEMA, label);
    return {
        schema_version: D65_HEARTBEAT_HIGH_WATER_SCHEMA,
        program_id: identifier(record, 'program_id', label),
        repo_id: identifier(record, 'repo_id', label),
        workstream_run: identifier(record, 'workstream_run', label),
        sequence: integer(record, 'sequence', label, 1),
        heartbeat_sha256: sha256Field(record, 'heartbeat_sha256', label),
        issued_at: timestamp(record, 'issued_at', label),
        valid_until: timestamp(record, 'valid_until', label),
        updated_at: timestamp(record, 'updated_at', label),
    };
}
export const HEARTBEAT_ADVANCE_MAX_RECORDS = 1024;
// ---- autopilot.program_heartbeat_acceptance_result.v1 -----------------------
export const D65_HEARTBEAT_ACCEPTANCE_RESULT_SCHEMA = 'autopilot.program_heartbeat_acceptance_result.v1';
export const D65_HEARTBEAT_ACCEPTANCE_KINDS = ['catch-up', 'governing'];
export function parseD65HeartbeatAcceptanceResult(value) {
    const label = D65_HEARTBEAT_ACCEPTANCE_RESULT_SCHEMA;
    const record = object(value, label, [
        'schema_version', 'program_id', 'repo_id', 'workstream_run', 'sequence', 'heartbeat_ref',
        'heartbeat_sha256', 'acceptance_kind', 'prior_sha256', 'issued_at', 'valid_until', 'coordinator_time',
    ]);
    literal(record, 'schema_version', D65_HEARTBEAT_ACCEPTANCE_RESULT_SCHEMA, label);
    const sequence = integer(record, 'sequence', label, 1);
    const prior = nullableSha256Field(record, 'prior_sha256', label);
    if (sequence === 1 && prior !== null)
        fail(label, 'sequence 1 acceptance must have null prior_sha256');
    if (sequence > 1 && prior === null)
        fail(label, 'a later acceptance must name the prior heartbeat digest');
    return {
        schema_version: D65_HEARTBEAT_ACCEPTANCE_RESULT_SCHEMA,
        program_id: identifier(record, 'program_id', label),
        repo_id: identifier(record, 'repo_id', label),
        workstream_run: identifier(record, 'workstream_run', label),
        sequence,
        heartbeat_ref: repoRelativePath(record, 'heartbeat_ref', label),
        heartbeat_sha256: sha256Field(record, 'heartbeat_sha256', label),
        acceptance_kind: oneOf(record, 'acceptance_kind', D65_HEARTBEAT_ACCEPTANCE_KINDS, label),
        prior_sha256: prior,
        issued_at: timestamp(record, 'issued_at', label),
        valid_until: timestamp(record, 'valid_until', label),
        coordinator_time: timestamp(record, 'coordinator_time', label),
    };
}
// Re-export a couple of primitives so consumers can build with one import.
export { boolean, nullableGitOid, nullableStr };
// ---- autopilot.program_heartbeat.v1 -----------------------------------------
export const D65_PROGRAM_HEARTBEAT_SCHEMA = 'autopilot.program_heartbeat.v1';
/** The closed program/row stop-reason enum (fresh plan §3.2). */
export const D65_STOP_REASONS = [
    'operator-stop', 'row-not-launched', 'row-closed', 'terminal-tail', 'heartbeat-stale', 'progress-stale',
    'identity-drift', 'graph-incomplete', 'graph-drift', 'graph-publication-pending', 'graph-cas-conflict',
    'policy-invalid', 'cap-violation', 'provider-blocked', 'provider-exhausted', 'coordinator-transient',
    'coordinator-blocked', 'coordinator-terminal', 'lease-invalid', 'handoff-pending', 'parent-recovering',
    'parent-recovery-exhausted', 'unit-recovering', 'unit-retry-exhausted', 'continuation-unclassified',
    'external-credential-blocked',
];
export const D65_PROVIDER_STATES = ['healthy', 'blocked', 'retry-authorized', 'exhausted'];
export const D65_ROW_STATES = ['planned', 'active', 'recovering', 'parked', 'blocked', 'closed'];
function stopReasons(value, label) {
    const entries = array(value, label, D65_STOP_REASONS.length);
    const out = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (typeof entry !== 'string' || !D65_STOP_REASONS.includes(entry))
            fail(label, `entry ${String(index)} is not a known stop reason`);
        out.push(entry);
    }
    // Decoded-byte-sorted unique.
    for (let index = 1; index < out.length; index += 1)
        if (!((out[index - 1] ?? '') < (out[index] ?? '')))
            fail(label, 'stop reasons must be decoded-byte-sorted and unique');
    return Object.freeze(out);
}
function heartbeatRow(value, label) {
    const record = object(value, label, [
        'workstream', 'workstream_run', 'parent_session_file_sha256', 'coordinator_session_lease_id',
        'accepted_graph_sequence', 'accepted_graph_sha256', 'status_sha256', 'doctor_sha256',
        'session_lease_state', 'child_lease_ids', 'launch_policy_sha256', 'last_progress_event_seq',
        'last_handoff_sha256', 'row_state', 'dispatch_allowed', 'stop_reasons',
    ]);
    const childLeaseIds = array(record['child_lease_ids'], `${label}.child_lease_ids`, 64).map((entry, index) => {
        if (typeof entry !== 'string' || entry.length === 0 || entry.length > 192)
            fail(label, `child_lease_ids[${String(index)}] must be a bounded identifier`);
        return entry;
    });
    const dispatchAllowed = boolean(record, 'dispatch_allowed', label);
    const reasons = stopReasons(record['stop_reasons'], `${label}.stop_reasons`);
    // A row has dispatch_allowed=true iff its reasons are empty.
    if (dispatchAllowed && reasons.length > 0)
        fail(label, 'a dispatch-allowed row must have empty stop_reasons');
    if (!dispatchAllowed && reasons.length === 0)
        fail(label, 'a non-dispatch row must carry at least one stop reason');
    const accSeq = record['accepted_graph_sequence'] === null ? null : integer(record, 'accepted_graph_sequence', label, 1);
    const lastProgress = record['last_progress_event_seq'] === null ? null : integer(record, 'last_progress_event_seq', label, 1);
    return {
        workstream: identifier(record, 'workstream', label),
        workstream_run: identifier(record, 'workstream_run', label),
        parent_session_file_sha256: nullableSha256Field(record, 'parent_session_file_sha256', label),
        coordinator_session_lease_id: nullableStr(record, 'coordinator_session_lease_id', label, 192),
        accepted_graph_sequence: accSeq,
        accepted_graph_sha256: nullableSha256Field(record, 'accepted_graph_sha256', label),
        status_sha256: nullableSha256Field(record, 'status_sha256', label),
        doctor_sha256: nullableSha256Field(record, 'doctor_sha256', label),
        session_lease_state: nullableStr(record, 'session_lease_state', label, 64),
        child_lease_ids: Object.freeze(childLeaseIds),
        launch_policy_sha256: nullableSha256Field(record, 'launch_policy_sha256', label),
        last_progress_event_seq: lastProgress,
        last_handoff_sha256: nullableSha256Field(record, 'last_handoff_sha256', label),
        row_state: oneOf(record, 'row_state', D65_ROW_STATES, label),
        dispatch_allowed: dispatchAllowed,
        stop_reasons: reasons,
    };
}
function providerHealth(value, label) {
    const record = object(value, label, [
        'provider', 'state', 'observation_ref', 'observation_sha256', 'cooldown_until', 'probe_workstream_run',
        'probe_ref', 'probe_sha256', 'consumption_event_seq',
    ]);
    const state = oneOf(record, 'state', D65_PROVIDER_STATES, label);
    const cooldownUntil = record['cooldown_until'] === null ? null : timestamp(record, 'cooldown_until', label);
    const probeRun = nullableStr(record, 'probe_workstream_run', label, 192);
    const consumption = record['consumption_event_seq'] === null ? null : integer(record, 'consumption_event_seq', label, 1);
    // State-specific nullability (fresh plan §3.2).
    if (state === 'healthy' && (cooldownUntil !== null || probeRun !== null))
        fail(label, 'initial healthy provider must have null cooldown/probe-run');
    if (state === 'retry-authorized' && probeRun === null)
        fail(label, 'retry-authorized provider must cite one accepted probe run');
    if (state === 'exhausted' && cooldownUntil !== null)
        fail(label, 'exhausted provider must have null cooldown');
    return {
        provider: identifier(record, 'provider', label),
        state,
        observation_ref: record['observation_ref'] === null ? null : repoRelativePath(record, 'observation_ref', label),
        observation_sha256: nullableSha256Field(record, 'observation_sha256', label),
        cooldown_until: cooldownUntil,
        probe_workstream_run: probeRun,
        probe_ref: record['probe_ref'] === null ? null : repoRelativePath(record, 'probe_ref', label),
        probe_sha256: nullableSha256Field(record, 'probe_sha256', label),
        consumption_event_seq: consumption,
    };
}
export function parseD65ProgramHeartbeat(value) {
    const label = D65_PROGRAM_HEARTBEAT_SCHEMA;
    const record = object(value, label, [
        'schema_version', 'program_id', 'sequence', 'prior_sha256', 'issued_at', 'valid_until',
        'package_commit', 'package_tree', 'base_commit', 'base_tree', 'rows', 'provider_health',
        'dispatch_allowed', 'stop_reasons', 'trust_anchor_ref', 'trust_anchor_sha256', 'signer_key_id', 'signature',
    ]);
    literal(record, 'schema_version', D65_PROGRAM_HEARTBEAT_SCHEMA, label);
    const sequence = integer(record, 'sequence', label, 1);
    const prior = nullableSha256Field(record, 'prior_sha256', label);
    if (sequence === 1 && prior !== null)
        fail(label, 'sequence 1 must have null prior_sha256');
    if (sequence > 1 && prior === null)
        fail(label, 'a later heartbeat must name the prior digest');
    const issuedAt = timestamp(record, 'issued_at', label);
    const validUntil = timestamp(record, 'valid_until', label);
    // valid_until = issued_at + 15m exactly.
    if (Date.parse(validUntil) - Date.parse(issuedAt) !== 15 * 60 * 1000)
        fail(label, 'valid_until must be exactly issued_at + 15 minutes');
    const rowEntries = array(record['rows'], `${label}.rows`, 64).map((entry, index) => heartbeatRow(entry, `${label}.rows[${String(index)}]`));
    // Rows are identity-sorted by workstream and unique.
    for (let index = 1; index < rowEntries.length; index += 1)
        if (!((rowEntries[index - 1]?.workstream ?? '') < (rowEntries[index]?.workstream ?? '')))
            fail(label, 'rows must be identity-sorted by workstream with no duplicates');
    const providerEntries = array(record['provider_health'], `${label}.provider_health`, 32).map((entry, index) => providerHealth(entry, `${label}.provider_health[${String(index)}]`));
    for (let index = 1; index < providerEntries.length; index += 1)
        if (!((providerEntries[index - 1]?.provider ?? '') < (providerEntries[index]?.provider ?? '')))
            fail(label, 'provider_health must be provider-byte-sorted with no duplicates');
    const dispatchAllowed = boolean(record, 'dispatch_allowed', label);
    const globalReasons = stopReasons(record['stop_reasons'], `${label}.stop_reasons`);
    if (dispatchAllowed && globalReasons.length > 0)
        fail(label, 'global dispatch_allowed requires empty global stop_reasons');
    if (!dispatchAllowed && globalReasons.length === 0)
        fail(label, 'a false global dispatch value requires at least one global reason');
    return {
        schema_version: D65_PROGRAM_HEARTBEAT_SCHEMA,
        program_id: identifier(record, 'program_id', label),
        sequence,
        prior_sha256: prior,
        issued_at: issuedAt,
        valid_until: validUntil,
        package_commit: gitOid(record, 'package_commit', label),
        package_tree: gitOid(record, 'package_tree', label),
        base_commit: gitOid(record, 'base_commit', label),
        base_tree: gitOid(record, 'base_tree', label),
        rows: Object.freeze(rowEntries),
        provider_health: Object.freeze(providerEntries),
        dispatch_allowed: dispatchAllowed,
        stop_reasons: globalReasons,
        trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label),
        trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
        signer_key_id: sha256Field(record, 'signer_key_id', label),
        signature: unpaddedBase64Url(record, 'signature', label),
    };
}
