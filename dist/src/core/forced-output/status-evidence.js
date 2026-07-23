import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { autopilotSchemaSha256, parseAutopilotReceipt, parseAutopilotReceiptV2, parseAutopilotStatusEntry, } from "../contracts/index.js";
import { autopilotExpectedIdentityHash, autopilotObservedProfileMismatches, buildAutopilotObservedProfile, buildAutopilotProviderIdentity, buildAutopilotProviderIdentityFromRequestProfile, buildAutopilotReceiptV2, deriveAutopilotArtifactRoot, expectedAutopilotStatusIdentityFromSpec, providerIdentityFromObservedProfile, } from "./identity.js";
const parseJsonValue = globalThis.JSON.parse;
export class AutopilotForcedOutputEvidenceError extends Error {
    code;
    details;
    constructor(code, details) {
        super(`${code}: ${details.reason}`);
        this.name = 'AutopilotForcedOutputEvidenceError';
        this.code = code;
        this.details = details;
    }
}
export async function validateAutopilotStatusEvidence(input) {
    const spec = input.unitSpec;
    const artifactRoot = input.artifactRoot ?? deriveAutopilotArtifactRoot(spec);
    const providerIdentity = input.providerIdentity ?? (input.rosterExecutionIdentity === undefined
        ? buildAutopilotProviderIdentity(spec.model, spec.thinking)
        : buildAutopilotProviderIdentityFromRequestProfile(input.rosterExecutionIdentity.request_profile));
    const schemaSha256 = autopilotSchemaSha256('statusEntry');
    const expectedIdentityHash = autopilotExpectedIdentityHash(expectedAutopilotStatusIdentityFromSpec(spec, providerIdentity, input.rosterExecutionIdentity));
    if (!existsSync(spec.status_output)) {
        throw new AutopilotForcedOutputEvidenceError('missing-status', {
            reason: 'Autopilot status artifact is missing',
            status_output: spec.status_output,
        });
    }
    if (!existsSync(spec.receipt_output)) {
        throw new AutopilotForcedOutputEvidenceError('missing-receipt', {
            reason: 'Autopilot status receipt is missing',
            receipt_output: spec.receipt_output,
        });
    }
    const statusText = await readFile(spec.status_output, 'utf8');
    const statusSha256 = sha256Text(statusText);
    const rawStatus = parseJsonObjectText(statusText, spec.status_output, 'status');
    let status;
    try {
        status = parseAutopilotStatusEntry(rawStatus, { unitSpec: spec, artifactRoot });
    }
    catch (error) {
        throw new AutopilotForcedOutputEvidenceError('status-invalid', {
            reason: errorMessage(error),
            status_output: spec.status_output,
        });
    }
    const rawReceipt = await readJsonObject(spec.receipt_output, 'receipt');
    if (input.rosterExecutionIdentity !== undefined) {
        return await validateRosterReceiptEvidence({
            spec,
            rawReceipt,
            providerIdentity,
            schemaSha256,
            expectedIdentityHash,
            statusSha256,
            rosterExecutionIdentity: input.rosterExecutionIdentity,
            observedExecution: input.observedExecution ?? null,
            status,
        });
    }
    let receipt;
    try {
        receipt = parseAutopilotReceipt(rawReceipt, {
            unitSpec: spec,
            statusOutputPath: spec.status_output,
        });
    }
    catch (error) {
        throw new AutopilotForcedOutputEvidenceError('receipt-invalid', {
            reason: errorMessage(error),
            receipt_output: spec.receipt_output,
        });
    }
    const mismatches = receiptMismatches({
        receipt,
        providerIdentity,
        schemaSha256,
        expectedIdentityHash,
    });
    if (mismatches.length > 0) {
        const [first] = mismatches;
        throw new AutopilotForcedOutputEvidenceError('receipt-identity-mismatch', {
            reason: mismatches.map((mismatch) => mismatch.reason).join('; '),
            receipt_output: spec.receipt_output,
            ...(first === undefined
                ? {}
                : { field: first.field, expected: first.expected, actual: first.actual }),
        });
    }
    return Object.freeze({
        status,
        receipt,
        providerIdentity,
        expectedIdentityHash,
        schemaSha256,
        finalModelMetadata: null,
    });
}
async function validateRosterReceiptEvidence(input) {
    let carrierReceipt;
    try {
        carrierReceipt = parseAutopilotReceiptV2(input.rawReceipt);
    }
    catch (error) {
        throw new AutopilotForcedOutputEvidenceError('receipt-invalid', {
            reason: errorMessage(error),
            receipt_output: input.spec.receipt_output,
        });
    }
    const carrierMismatches = rosterCarrierReceiptMismatches({
        receipt: carrierReceipt,
        spec: input.spec,
        schemaSha256: input.schemaSha256,
        expectedIdentityHash: input.expectedIdentityHash,
        statusSha256: input.statusSha256,
        rosterExecutionIdentity: input.rosterExecutionIdentity,
    });
    if (carrierMismatches.length > 0) {
        const [first] = carrierMismatches;
        throw new AutopilotForcedOutputEvidenceError('receipt-identity-mismatch', {
            reason: carrierMismatches.map((mismatch) => mismatch.reason).join('; '),
            receipt_output: input.spec.receipt_output,
            ...(first === undefined
                ? {}
                : { field: first.field, expected: first.expected, actual: first.actual }),
        });
    }
    if (input.observedExecution === null) {
        throw new AutopilotForcedOutputEvidenceError('receipt-identity-mismatch', {
            reason: 'missing observed execution identity evidence for receipt.v2; runtime did not prove final provider/model/API/thinking/service/cache/prompt profile',
            receipt_output: input.spec.receipt_output,
        });
    }
    const observedProfile = buildAutopilotObservedProfile(input.observedExecution);
    const observedMismatches = autopilotObservedProfileMismatches({
        requestProfile: input.rosterExecutionIdentity.request_profile,
        observedProfile,
    });
    if (observedMismatches.length > 0) {
        const first = observedMismatches[0];
        throw new AutopilotForcedOutputEvidenceError('receipt-identity-mismatch', {
            reason: observedMismatches.join('; '),
            receipt_output: input.spec.receipt_output,
            ...(first === undefined ? {} : { field: first.split(' mismatch:')[0] ?? 'observed_profile' }),
        });
    }
    const observedProviderIdentity = providerIdentityFromObservedProfile(observedProfile);
    const finalReceipt = buildAutopilotReceiptV2({
        unitSpec: input.spec,
        emittedAt: carrierReceipt.emitted_at,
        statusSha256: input.statusSha256,
        schemaSha256: input.schemaSha256,
        toolCallId: carrierReceipt.tool_call_id,
        providerIdentity: observedProviderIdentity,
        expectedIdentityHash: input.expectedIdentityHash,
        rosterExecutionIdentity: input.rosterExecutionIdentity,
        observedProfile,
    });
    await writeReceiptJson(input.spec.receipt_output, finalReceipt);
    return Object.freeze({
        status: input.status,
        receipt: finalReceipt,
        providerIdentity: observedProviderIdentity,
        expectedIdentityHash: input.expectedIdentityHash,
        schemaSha256: input.schemaSha256,
        finalModelMetadata: input.observedExecution.final_model_metadata ?? null,
    });
}
function receiptMismatches(input) {
    const mismatches = [];
    if (input.receipt.schema_sha256 !== input.schemaSha256) {
        mismatches.push({
            field: 'schema_sha256',
            expected: input.schemaSha256,
            actual: input.receipt.schema_sha256,
            reason: 'receipt schema_sha256 does not match current Autopilot status schema',
        });
    }
    if (input.receipt.expected_identity_hash !== input.expectedIdentityHash) {
        mismatches.push({
            field: 'expected_identity_hash',
            expected: input.expectedIdentityHash,
            actual: input.receipt.expected_identity_hash,
            reason: 'receipt expected_identity_hash does not match unit-spec identity',
        });
    }
    for (const key of Object.keys(input.providerIdentity)) {
        const expected = input.providerIdentity[key];
        const actual = input.receipt.provider_identity[key];
        if (actual !== expected) {
            mismatches.push({
                field: `provider_identity.${key}`,
                expected,
                actual,
                reason: `receipt provider_identity.${key} does not match expected provider identity`,
            });
        }
    }
    return mismatches;
}
function rosterCarrierReceiptMismatches(input) {
    const mismatches = [];
    pushMismatch(mismatches, 'workstream', input.spec.workstream, input.receipt.workstream, 'receipt workstream does not match unit spec');
    pushMismatch(mismatches, 'unit_id', input.spec.unit_id, input.receipt.unit_id, 'receipt unit_id does not match unit spec');
    pushMismatch(mismatches, 'role', input.spec.role, input.receipt.role, 'receipt role does not match unit spec');
    pushMismatch(mismatches, 'attempt', String(input.spec.attempt), String(input.receipt.attempt), 'receipt attempt does not match unit spec');
    pushMismatch(mismatches, 'status_output', input.spec.status_output, input.receipt.status_output, 'receipt status_output does not match unit spec');
    pushMismatch(mismatches, 'status_sha256', input.statusSha256, input.receipt.status_sha256, 'receipt status_sha256 does not match status file');
    pushMismatch(mismatches, 'schema_sha256', input.schemaSha256, input.receipt.schema_sha256, 'receipt schema_sha256 does not match current Autopilot status schema');
    pushMismatch(mismatches, 'expected_identity_hash', input.expectedIdentityHash, input.receipt.expected_identity_hash, 'receipt expected_identity_hash does not match context identity');
    pushMismatch(mismatches, 'roster_id', input.rosterExecutionIdentity.roster_id, input.receipt.roster_id, 'receipt roster_id does not match pinned roster identity');
    pushMismatch(mismatches, 'roster_revision', String(input.rosterExecutionIdentity.roster_revision), String(input.receipt.roster_revision), 'receipt roster_revision does not match pinned roster identity');
    pushMismatch(mismatches, 'roster_sha256', input.rosterExecutionIdentity.roster_sha256, input.receipt.roster_sha256, 'receipt roster_sha256 does not match pinned roster identity');
    pushMismatch(mismatches, 'assignment_sha256', input.rosterExecutionIdentity.assignment_sha256, input.receipt.assignment_sha256, 'receipt assignment_sha256 does not match pinned assignment identity');
    pushMismatch(mismatches, 'pre_run_selection_sha256', input.rosterExecutionIdentity.pre_run_selection_sha256, input.receipt.pre_run_selection_sha256, 'receipt pre_run_selection_sha256 does not match pinned selection identity');
    pushMismatch(mismatches, 'request_profile_sha256', input.rosterExecutionIdentity.request_profile_sha256, input.receipt.request_profile.request_profile_sha256, 'receipt request_profile does not match pinned request profile');
    return mismatches;
}
function pushMismatch(mismatches, field, expected, actual, reason) {
    if (expected === actual)
        return;
    mismatches.push({ field, expected, actual, reason });
}
async function readJsonObject(path, label) {
    return parseJsonObjectText(await readFile(path, 'utf8'), path, label);
}
function parseJsonObjectText(text, path, label) {
    let parsed;
    try {
        parsed = parseJsonValue(text);
    }
    catch (error) {
        throw new Error(`${label} file is not valid JSON at ${path}: ${errorMessage(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${label} file must contain one JSON object at ${path}`);
    }
    return parsed;
}
async function writeReceiptJson(path, receipt) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}
function sha256Text(text) {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
