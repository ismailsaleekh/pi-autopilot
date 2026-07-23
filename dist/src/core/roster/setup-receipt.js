import { createHash } from 'node:crypto';
import { autopilotRosterContractCanonicalJson, autopilotRosterContractSha256OmittingOwnField, parseAutopilotRosterContract, } from "./contracts.js";
export class RosterSetupReceiptError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'RosterSetupReceiptError';
        this.code = code;
    }
}
const UTC_MS_Z_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const RECEIPT_ID_PATTERN = /^[a-z][a-z0-9-]{0,119}$/u;
const FORBIDDEN_ORIGINAL_COMMAND_PATTERN = /(?:^|\s)(?:--?(?:api[-_]?key|access[-_]?token|token|secret|password|credential|authorization|system[-_]?prompt|prompt)(?:=|\s|$)|[A-Z0-9_]*(?:API[-_]?KEY|ACCESS[-_]?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)[A-Z0-9_]*=)/u;
export function createRosterSetupReceipt(input, options = {}) {
    assertReceiptInputIsSecretFree(input);
    const issuedAt = issuedAtFromClock(options.clock);
    const receiptId = receiptIdFromOptions(input, issuedAt, options.receiptId);
    const receiptWithoutHash = {
        schema_version: 'autopilot.roster_setup_receipt.v1',
        receipt_id: receiptId,
        scope: input.scope,
        saved_rosters: materializeSavedRosterRefs(input.scope, input.saved_rosters),
        default_roster_id: input.default_roster_id,
        default_roster_revision: input.default_roster_revision,
        default_roster_sha256: input.default_roster_sha256,
        approved_candidate_set_sha256: input.approved_candidate_set_sha256,
        approved_roster_sha256s: Object.freeze([...input.approved_roster_sha256s]),
        config_sha256: input.config_sha256,
        original_command: input.original_command,
        fresh_session_required: true,
        zero_secrets: true,
        issued_at: issuedAt,
    };
    const receipt = {
        ...receiptWithoutHash,
        receipt_sha256: autopilotRosterContractSha256OmittingOwnField({ ...receiptWithoutHash, receipt_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }, 'receipt_sha256'),
    };
    const parsed = parseAutopilotRosterContract('autopilot.roster_setup_receipt.v1', receipt);
    const receiptBytes = new TextEncoder().encode(autopilotRosterContractCanonicalJson(parsed));
    return Object.freeze({
        receipt: parsed,
        receipt_sha256: parsed.receipt_sha256,
        receipt_bytes: receiptBytes,
    });
}
export function createRosterSetupReceiptFactory(options = {}) {
    return (input) => createRosterSetupReceipt(input, options);
}
export function isOriginalAutopilotCommandReceiptSafe(originalCommand) {
    return originalCommand.length > 0 &&
        originalCommand.length <= 4096 &&
        !originalCommand.includes('\0') &&
        !FORBIDDEN_ORIGINAL_COMMAND_PATTERN.test(originalCommand);
}
function assertReceiptInputIsSecretFree(input) {
    if (!isOriginalAutopilotCommandReceiptSafe(input.original_command)) {
        throw new RosterSetupReceiptError('ROSTER_AUTH_CHANNEL_FORBIDDEN', 'original_command is not safe for secret-free setup receipt emission');
    }
}
function issuedAtFromClock(clock) {
    const value = clock === undefined ? new Date() : clock();
    const issuedAt = value instanceof Date ? value.toISOString() : value;
    if (!UTC_MS_Z_PATTERN.test(issuedAt)) {
        throw new RosterSetupReceiptError('ROSTER_READBACK_MISMATCH', 'setup receipt issued_at must be an exact UTC millisecond timestamp');
    }
    return issuedAt;
}
function receiptIdFromOptions(input, issuedAt, receiptId) {
    const materialized = typeof receiptId === 'function'
        ? receiptId({ ...input, issued_at: issuedAt })
        : receiptId ?? defaultReceiptId(input, issuedAt);
    if (!RECEIPT_ID_PATTERN.test(materialized)) {
        throw new RosterSetupReceiptError('ROSTER_READBACK_MISMATCH', 'setup receipt_id is outside the closed receipt contract');
    }
    return materialized;
}
function defaultReceiptId(input, issuedAt) {
    const preimage = {
        schema_version: 'autopilot.roster_setup_receipt_id_preimage.v1',
        scope: input.scope,
        saved_rosters: input.saved_rosters,
        default_roster_id: input.default_roster_id,
        default_roster_revision: input.default_roster_revision,
        default_roster_sha256: input.default_roster_sha256,
        approved_candidate_set_sha256: input.approved_candidate_set_sha256,
        approved_roster_sha256s: input.approved_roster_sha256s,
        config_sha256: input.config_sha256,
        original_command: input.original_command,
        issued_at: issuedAt,
    };
    const hex = createHash('sha256').update(autopilotRosterContractCanonicalJson(preimage), 'utf8').digest('hex');
    return `receipt-${hex.slice(0, 32)}`;
}
function materializeSavedRosterRefs(_scope, refs) {
    const materialized = refs.map((ref) => {
        if (typeof ref.path !== 'string' || ref.path.length === 0) {
            throw new RosterSetupReceiptError('ROSTER_READBACK_MISMATCH', 'saved roster refs must include readback authority paths before receipt emission');
        }
        return Object.freeze({
            roster_id: ref.roster_id,
            roster_revision: ref.roster_revision,
            roster_sha256: ref.roster_sha256,
            assignment_set_sha256: ref.assignment_set_sha256,
            path: ref.path,
        });
    });
    return Object.freeze(materialized);
}
