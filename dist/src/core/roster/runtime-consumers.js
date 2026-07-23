import { parseAutopilotReceipt, parseAutopilotUnitSpec, } from "../contracts/validate.js";
import { parseAutopilotReceiptV2, parseAutopilotUnitSpecV2, } from "./contracts.js";
import { canonicalRosterJson } from "./canonical.js";
import { assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter, artifactSchemaVersionFromBytes, } from "./artifact-compatibility.js";
import { assertReceiptMatchesUnitSpecAndPinnedFacts, assertUnitSpecMatchesPinnedFacts, resolvePinnedRoleRuntimeFacts, } from "./runtime-spec.js";
export class AutopilotRuntimeConsumerError extends Error {
    reason;
    constructor(reason) {
        super(reason);
        this.name = 'AutopilotRuntimeConsumerError';
        this.reason = reason;
    }
}
export function parseNewRunRuntimeUnitSpec(value, options = {}) {
    const schemaVersion = schemaVersionOf(value, 'unit spec');
    if (schemaVersion !== 'autopilot.unit_spec.v2') {
        throw new AutopilotRuntimeConsumerError('Phase37 new-run planning and retry require autopilot.unit_spec.v2; unit_spec.v1 is historical evidence only');
    }
    const unitSpec = parseAutopilotUnitSpecV2(value);
    const pinnedFacts = options.pinned === undefined
        ? null
        : resolvePinnedRoleRuntimeFacts({
            selection: options.pinned.selection,
            roster: options.pinned.roster,
            role: unitSpec.role,
            request_profile: options.pinned.request_profile,
        });
    if (pinnedFacts !== null)
        assertUnitSpecMatchesPinnedFacts(unitSpec, pinnedFacts);
    return Object.freeze({
        kind: 'phase37-new-run-v2',
        schema_version: 'autopilot.unit_spec.v2',
        unit_spec: unitSpec,
        authority_spec: unitSpecAuthorityProjection(unitSpec),
        roster_identity: rosterRuntimeIdentityFromUnitSpec(unitSpec),
        pinned_facts: pinnedFacts,
    });
}
export function parseHistoricalRuntimeUnitSpecV1(input) {
    const schemaVersion = artifactSchemaVersionFromBytes('unit-spec', input.unit_spec_bytes_utf8);
    if (schemaVersion !== 'autopilot.unit_spec.v1') {
        throw new AutopilotRuntimeConsumerError('historical unit spec admission requires byte-identical autopilot.unit_spec.v1 bytes');
    }
    assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter({
        kind: 'unit-spec',
        bytes_utf8: input.unit_spec_bytes_utf8,
        adapter_result: input.historical_adapter_result,
    });
    const unitSpec = parseAutopilotUnitSpec(parseJsonObject(input.unit_spec_bytes_utf8, 'historical unit_spec.v1'));
    return Object.freeze({
        kind: 'historical-grandfathered-v1',
        schema_version: 'autopilot.unit_spec.v1',
        unit_spec: unitSpec,
        authority_spec: unitSpec,
        roster_identity: null,
        unit_spec_bytes_utf8: input.unit_spec_bytes_utf8,
        historical_adapter_result: input.historical_adapter_result,
    });
}
export function parseNewRunRuntimeReceipt(value, options = {}) {
    const schemaVersion = schemaVersionOf(value, 'receipt');
    if (schemaVersion !== 'autopilot.receipt.v2') {
        throw new AutopilotRuntimeConsumerError('Phase37 new-run execution requires autopilot.receipt.v2; receipt.v1 is historical evidence only');
    }
    const receipt = parseAutopilotReceiptV2(value);
    const identity = rosterRuntimeIdentityFromReceipt(receipt);
    if (options.unitSpec !== undefined)
        assertRuntimeReceiptMatchesUnitSpec({ unitSpec: options.unitSpec, receipt: { kind: 'phase37-new-run-v2', schema_version: 'autopilot.receipt.v2', receipt, roster_identity: identity } });
    if (options.pinned !== undefined) {
        const facts = resolvePinnedRoleRuntimeFacts({
            selection: options.pinned.selection,
            roster: options.pinned.roster,
            role: receipt.role,
            request_profile: options.pinned.request_profile,
        });
        assertReceiptMatchesUnitSpecAndPinnedFacts(receipt, options.unitSpec?.unit_spec ?? receiptToSyntheticUnitSpec(receipt), facts);
    }
    return Object.freeze({
        kind: 'phase37-new-run-v2',
        schema_version: 'autopilot.receipt.v2',
        receipt,
        roster_identity: identity,
    });
}
export function parseHistoricalRuntimeReceiptV1(input) {
    const schemaVersion = artifactSchemaVersionFromBytes('receipt', input.receipt_bytes_utf8);
    if (schemaVersion !== 'autopilot.receipt.v1') {
        throw new AutopilotRuntimeConsumerError('historical receipt admission requires byte-identical autopilot.receipt.v1 bytes');
    }
    assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter({
        kind: 'receipt',
        bytes_utf8: input.receipt_bytes_utf8,
        adapter_result: input.historical_adapter_result,
    });
    const receipt = parseAutopilotReceipt(parseJsonObject(input.receipt_bytes_utf8, 'historical receipt.v1'), {
        ...(input.unitSpec === undefined ? {} : { unitSpec: input.unitSpec.authority_spec }),
        ...(input.statusOutputPath === undefined ? {} : { statusOutputPath: input.statusOutputPath }),
    });
    return Object.freeze({
        kind: 'historical-grandfathered-v1',
        schema_version: 'autopilot.receipt.v1',
        receipt,
        roster_identity: null,
        receipt_bytes_utf8: input.receipt_bytes_utf8,
        historical_adapter_result: input.historical_adapter_result,
    });
}
export function assertRuntimeReceiptMatchesUnitSpec(input) {
    if (input.unitSpec.kind !== input.receipt.kind) {
        throw new AutopilotRuntimeConsumerError(`mixed runtime artifact schemas are forbidden: ${input.unitSpec.schema_version} with ${input.receipt.schema_version}`);
    }
    if (input.unitSpec.kind === 'historical-grandfathered-v1' && input.receipt.kind === 'historical-grandfathered-v1') {
        const unit = input.unitSpec.unit_spec;
        const receipt = input.receipt.receipt;
        for (const field of ['workstream', 'unit_id', 'role', 'attempt', 'status_output']) {
            if (receipt[field] !== unit[field])
                throw new AutopilotRuntimeConsumerError(`historical receipt.v1 ${field} does not match unit_spec.v1`);
        }
        return;
    }
    if (input.unitSpec.kind !== 'phase37-new-run-v2' || input.receipt.kind !== 'phase37-new-run-v2') {
        throw new AutopilotRuntimeConsumerError('runtime artifact schema discriminants are inconsistent');
    }
    const unit = input.unitSpec.unit_spec;
    const receipt = input.receipt.receipt;
    for (const field of ['workstream', 'unit_id', 'role', 'attempt', 'status_output']) {
        if (receipt[field] !== unit[field])
            throw new AutopilotRuntimeConsumerError(`receipt.v2 ${field} does not match unit_spec.v2`);
    }
    for (const field of ['roster_id', 'roster_revision', 'roster_sha256', 'assignment_sha256', 'pre_run_selection_sha256']) {
        if (receipt[field] !== unit[field])
            throw new AutopilotRuntimeConsumerError(`receipt.v2 ${field} does not match unit_spec.v2`);
    }
    if (canonicalRosterJson(receipt.request_profile) !== canonicalRosterJson(unit.request_profile)) {
        throw new AutopilotRuntimeConsumerError('receipt.v2 request_profile does not match unit_spec.v2 request_profile');
    }
    const left = input.unitSpec.roster_identity;
    const right = input.receipt.roster_identity;
    if (canonicalRosterJson(left) !== canonicalRosterJson(right)) {
        throw new AutopilotRuntimeConsumerError('receipt.v2 roster runtime identity does not match unit_spec.v2');
    }
}
export function runtimeUnitSpecAuthorityProjection(context) {
    return context.authority_spec;
}
export function runtimeSpecRosterIdentity(spec) {
    if (spec.schema_version !== 'autopilot.unit_spec.v2')
        return null;
    return rosterRuntimeIdentityFromUnitSpec(spec);
}
export function runtimeReceiptRosterIdentity(receipt) {
    if (receipt.schema_version !== 'autopilot.receipt.v2')
        return null;
    return rosterRuntimeIdentityFromReceipt(receipt);
}
export function unitSpecAuthorityProjection(unitSpec) {
    return Object.freeze({
        schema_version: 'autopilot.unit_spec.v1',
        workstream: unitSpec.workstream,
        unit_id: unitSpec.unit_id,
        role: unitSpec.role,
        template: unitSpec.template,
        attempt: unitSpec.attempt,
        objective: unitSpec.objective,
        cwd: unitSpec.cwd,
        model: unitSpec.model,
        thinking: unitSpec.thinking,
        owned_paths: unitSpec.owned_paths,
        read_only_paths: unitSpec.read_only_paths,
        untouchable_paths: unitSpec.untouchable_paths,
        context_refs: unitSpec.context_refs.filter((ref) => !isRuntimeTransitionContextRef(ref.path)).map((ref) => ({
            path: ref.path,
            purpose: ref.purpose,
            ...(ref.sha256 === null ? {} : { sha256: ref.sha256 }),
            ...(ref.byte_count === null ? {} : { byte_count: ref.byte_count }),
        })),
        validation_commands: unitSpec.validation_commands,
        status_output: unitSpec.status_output,
        receipt_output: unitSpec.receipt_output,
        evidence_dir: unitSpec.evidence_dir,
        stop_boundary: unitSpec.stop_boundary,
        ...(unitSpec.quality_profile === null ? {} : { quality_profile: unitSpec.quality_profile }),
        ...(unitSpec.risk_level === null ? {} : { risk_level: unitSpec.risk_level }),
        ...(unitSpec.acceptance_criteria.length === 0 ? {} : { acceptance_criteria: unitSpec.acceptance_criteria }),
        ...(unitSpec.verification_plan === null ? {} : { verification_plan: unitSpec.verification_plan }),
        ...(unitSpec.closure_criteria.length === 0 ? {} : { closure_criteria: unitSpec.closure_criteria }),
        ...(unitSpec.upstream_refs.length === 0 ? {} : { upstream_refs: unitSpec.upstream_refs }),
        ...(unitSpec.timeout_seconds === null ? {} : { timeout_seconds: unitSpec.timeout_seconds }),
        ...(unitSpec.render_prompt_snapshot === null ? {} : { render_prompt_snapshot: unitSpec.render_prompt_snapshot }),
    });
}
export function rosterRuntimeIdentityFromUnitSpec(unitSpec) {
    return Object.freeze({
        schema_version: 'autopilot.roster_runtime_identity.v1',
        workstream: unitSpec.workstream,
        unit_id: unitSpec.unit_id,
        role: unitSpec.role,
        attempt: unitSpec.attempt,
        roster_id: unitSpec.roster_id,
        roster_revision: unitSpec.roster_revision,
        roster_sha256: unitSpec.roster_sha256,
        assignment_sha256: unitSpec.assignment_sha256,
        pre_run_selection_sha256: unitSpec.pre_run_selection_sha256,
        request_profile_sha256: unitSpec.request_profile.request_profile_sha256,
        provider_id: unitSpec.request_profile.provider_id,
        model_id: unitSpec.request_profile.model_id,
        model: unitSpec.request_profile.model,
        api: unitSpec.request_profile.api,
        thinking: unitSpec.request_profile.thinking,
        service_tier: unitSpec.request_profile.service_tier,
        cache_policy: unitSpec.request_profile.cache_policy,
        system_prompt_profile: unitSpec.request_profile.system_prompt_profile,
        route_policy_id: unitSpec.request_profile.route_policy_id,
        route_policy_revision: unitSpec.request_profile.route_policy_revision,
    });
}
export function rosterRuntimeIdentityFromReceipt(receipt) {
    return Object.freeze({
        schema_version: 'autopilot.roster_runtime_identity.v1',
        workstream: receipt.workstream,
        unit_id: receipt.unit_id,
        role: receipt.role,
        attempt: receipt.attempt,
        roster_id: receipt.roster_id,
        roster_revision: receipt.roster_revision,
        roster_sha256: receipt.roster_sha256,
        assignment_sha256: receipt.assignment_sha256,
        pre_run_selection_sha256: receipt.pre_run_selection_sha256,
        request_profile_sha256: receipt.request_profile.request_profile_sha256,
        provider_id: receipt.request_profile.provider_id,
        model_id: receipt.request_profile.model_id,
        model: receipt.request_profile.model,
        api: receipt.request_profile.api,
        thinking: receipt.request_profile.thinking,
        service_tier: receipt.request_profile.service_tier,
        cache_policy: receipt.request_profile.cache_policy,
        system_prompt_profile: receipt.request_profile.system_prompt_profile,
        route_policy_id: receipt.request_profile.route_policy_id,
        route_policy_revision: receipt.request_profile.route_policy_revision,
    });
}
function isRuntimeTransitionContextRef(path) {
    return /^roster-transitions\/transition-[a-f0-9]{64}\.json$/u.test(path);
}
function schemaVersionOf(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new AutopilotRuntimeConsumerError(`${label} must be a JSON object with schema_version`);
    }
    const schemaVersion = value['schema_version'];
    if (typeof schemaVersion !== 'string')
        throw new AutopilotRuntimeConsumerError(`${label} schema_version must be a string`);
    return schemaVersion;
}
function parseJsonObject(bytes, label) {
    try {
        const parsed = JSON.parse(bytes);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new AutopilotRuntimeConsumerError(`${label} bytes must decode to a JSON object`);
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof AutopilotRuntimeConsumerError)
            throw error;
        throw new AutopilotRuntimeConsumerError(`${label} bytes are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function receiptToSyntheticUnitSpec(receipt) {
    return {
        schema_version: 'autopilot.unit_spec.v2',
        workstream: receipt.workstream,
        unit_id: receipt.unit_id,
        role: receipt.role,
        template: receipt.role,
        attempt: receipt.attempt,
        objective: 'receipt.v2 pinned-facts validation placeholder',
        cwd: '/',
        model: receipt.request_profile.model,
        thinking: receipt.request_profile.thinking,
        owned_paths: [],
        read_only_paths: [],
        untouchable_paths: [],
        context_refs: [],
        validation_commands: [],
        status_output: receipt.status_output,
        receipt_output: '/receipt-output-unavailable-for-receipt-only-validation',
        evidence_dir: '/',
        stop_boundary: 'receipt-only validation',
        quality_profile: null,
        risk_level: null,
        acceptance_criteria: [],
        verification_plan: null,
        closure_criteria: [],
        upstream_refs: [],
        timeout_seconds: null,
        render_prompt_snapshot: null,
        roster_id: receipt.roster_id,
        roster_revision: receipt.roster_revision,
        roster_sha256: receipt.roster_sha256,
        assignment_sha256: receipt.assignment_sha256,
        pre_run_selection_sha256: receipt.pre_run_selection_sha256,
        request_profile: receipt.request_profile,
    };
}
