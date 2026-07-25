import { createHash } from 'node:crypto';
import { readImmutableFileBytes } from "./immutable-file.js";
import { CoordinationRuntimeError } from "./failures.js";
import { computeAutopilotRosterContractObjectHash, parseAutopilotPreRunSelection, parseAutopilotRoster, } from "../roster/contracts.js";
import { parseRosterJsonWithDuplicateKeyRejection } from "../roster/canonical.js";
// D65 launch roster authority (freeze §9; fresh plan §2.3/§2.4/§3.2).
//
// The D65 launch path MUST consume the existing Phase 37 roster machinery, not
// duplicate unbound model fields. This module authenticates the sealed
// `autopilot.roster.v1` + `autopilot.pre_run_selection.v1` bytes named by the
// launch manifest, proves the exact fixed subscription roster (provider, model,
// thinking, and subscription channel per role), derives the authenticated parent
// assignment, and exposes the exact selection bytes for the runtime snapshot the
// ordinary unit-spec-v2 child path authors specs from.
//
// D65-A6 ROSTER AUTHORITY AMENDMENT (supersedes the hardcoded Phase 37 model
// list). The launch contract previously pinned literal model ids per role:
//   parent / strategy / validate / adjudicate / bughunt: gpt-5.6-sol @ xhigh
//   implement / fix: gpt-5.6-terra @ high; extract: gpt-5.6-luna @ high
// That list was written BEFORE any roster was live-certified, and it was both
// too strict and too weak:
//   - too strict: the operator's W4-certified roster
//     `cruise-codex-gpt55-heavy-subscription-51b6779e1472` (certification
//     manifest `codex-gpt55-heavy-sol-terra-w4-live-20260724`) assigns
//     gpt-5.5 to implement/validate/fix/extract and gpt-5.6-terra to
//     adjudicate, so five roles failed closed and NO certified roster could
//     launch;
//   - too weak: a `w0-non-certifying-seed` roster whose
//     `qualification_state` is `unqualified-non-certifying-seed` and whose
//     `certification_manifest_id` is null satisfied every literal model check
//     and WOULD have launched. Model-name equality was a proxy for
//     certification and is not one.
//
// The amendment replaces the model-name proxy with the real invariant: every
// role must be covered by W4 live-certification authority. The closed role set,
// the single subscription provider, the OAuth/plan-backed channel, the roster
// digest, and the selection binding are all UNCHANGED and still fail closed.
// This strictly increases what the launch path proves.
//
// Nothing here is inferred: a divergent digest, authority, provider, channel,
// certification pin, or role coverage fails closed with no model call.
/**
 * The closed D65 role registry. Every one of these roles must be present
 * exactly once in a sealed launch roster, and no other role may appear. Role
 * MODEL selection is certification authority (see
 * {@link D65_REQUIRED_ROSTER_QUALIFICATION_STATE}), not a hardcoded list.
 */
export const D65_REQUIRED_ROSTER_ROLES = Object.freeze([
    'parent', 'strategy', 'implement', 'validate', 'fix', 'adjudicate', 'bughunt', 'extract',
]);
/** The only qualification state a D65 launch roster assignment may carry. */
export const D65_REQUIRED_ROSTER_QUALIFICATION_STATE = 'w4-certified-ready';
/** The only roster generation source a D65 launch may consume. */
export const D65_REQUIRED_ROSTER_GENERATION_SOURCE = 'w4-certified-recipe';
/** The only thinking levels a certified D65 assignment may carry. */
const D65_ALLOWED_THINKING = Object.freeze(['high', 'xhigh']);
/** The only authorized subscription provider (no paid frontier API). */
export const D65_SUBSCRIPTION_PROVIDER = 'openai-codex';
function bytesSha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/**
 * Load and fully authenticate the sealed D65 roster + selection bytes named by
 * the launch manifest, proving the exact fixed subscription roster. Fails closed
 * on any divergence. Returns the authenticated parent assignment and the exact
 * bytes for the runtime snapshot.
 */
export function authenticateD65LaunchRoster(manifest) {
    const descriptor = manifest.roster_selection;
    // 1. Read the exact sealed roster + selection bytes (no-follow, one-link,
    //    bounded, mode-checked) and prove their raw-byte digests.
    const rosterBytes = readImmutableFileBytes({ path: descriptor.roster_ref, maximumBytes: 1_048_576, label: 'sealed roster authority', errorCode: 'invalid-state' });
    if (bytesSha256(rosterBytes) !== descriptor.roster_bytes_sha256)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster bytes diverge from the sealed roster digest', [descriptor.roster_ref]);
    const selectionBytes = readImmutableFileBytes({ path: descriptor.selection_ref, maximumBytes: 1_048_576, label: 'sealed roster selection authority', errorCode: 'invalid-state' });
    if (bytesSha256(selectionBytes) !== descriptor.selection_bytes_sha256)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection bytes diverge from the sealed selection digest', [descriptor.selection_ref]);
    // 2. Parse both through the exact closed Phase 37 contract parsers.
    const roster = parseAutopilotRoster(parseRosterJsonWithDuplicateKeyRejection(new TextDecoder('utf-8', { fatal: true }).decode(rosterBytes)));
    const selection = parseAutopilotPreRunSelection(parseRosterJsonWithDuplicateKeyRejection(new TextDecoder('utf-8', { fatal: true }).decode(selectionBytes)));
    // 3. The roster's canonical digest must equal the manifest-bound roster_sha256,
    //    which is the same digest the signed policy + heartbeat bind. Recompute it
    //    from the parsed bytes; a divergent roster is never silently adopted.
    const rosterCanonical = computeAutopilotRosterContractObjectHash('autopilot.roster.v1', roster);
    if (rosterCanonical === null || rosterCanonical !== manifest.roster_sha256)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster canonical digest diverges from the manifest-bound roster_sha256', [String(rosterCanonical), manifest.roster_sha256]);
    // 4. The selection must bind the exact same roster identity/digest and its own
    //    canonical selection digest must be self-consistent + equal the sealed one.
    if (selection.roster_id !== roster.roster_id || selection.roster_revision !== roster.roster_revision || selection.roster_sha256 !== roster.roster_sha256 || selection.assignment_set_sha256 !== roster.assignment_set_sha256) {
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection does not bind the exact sealed roster identity/digest', [selection.roster_id, String(selection.roster_revision)]);
    }
    const selectionCanonical = computeAutopilotRosterContractObjectHash('autopilot.pre_run_selection.v1', selection);
    if (selectionCanonical === null || selection.selection_sha256 !== selectionCanonical)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection digest is not self-consistent');
    if (selection.selection_sha256 !== descriptor.selection_sha256)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection digest diverges from the manifest descriptor');
    if (selection.repo_id !== manifest.repo_id || selection.workstream_run !== manifest.workstream_run)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection identity diverges from the sealed run identity', [selection.repo_id, selection.workstream_run]);
    // 5. Prove the EXACT fixed subscription roster: every role's provider, model,
    //    thinking, and subscription channel is the fixed value; no paid route.
    const provider = manifest.roster_selection.provider;
    if (provider !== D65_SUBSCRIPTION_PROVIDER)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster provider is not the authorized subscription provider', [provider]);
    const byRole = new Map();
    for (const assignment of roster.assignments) {
        if (byRole.has(assignment.role))
            throw new CoordinationRuntimeError('invalid-state', 'sealed roster contains a duplicate role assignment', [assignment.role]);
        byRole.set(assignment.role, assignment);
    }
    // The roster as a whole must be W4-certified authority with a real
    // certification manifest pin. A `w0-non-certifying-seed` roster (or any
    // roster with a null/blank certification pin) is never launch authority.
    if (roster.generation_source !== D65_REQUIRED_ROSTER_GENERATION_SOURCE)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster generation source is not W4-certified launch authority', [String(roster.generation_source), D65_REQUIRED_ROSTER_GENERATION_SOURCE]);
    if (typeof roster.certification_manifest_id !== 'string' || roster.certification_manifest_id.length === 0)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster carries no certification manifest id', [String(roster.certification_manifest_id)]);
    if (typeof roster.certification_manifest_sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(roster.certification_manifest_sha256))
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster carries no canonical certification manifest digest', [String(roster.certification_manifest_sha256)]);
    for (const role of D65_REQUIRED_ROSTER_ROLES) {
        const assignment = byRole.get(role);
        if (assignment === undefined)
            throw new CoordinationRuntimeError('invalid-state', 'sealed roster is missing a required role assignment', [role]);
        if (assignment.provider_id !== provider)
            throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not on the subscription provider`, [assignment.provider_id]);
        // The role's MODEL is whatever the W4 certification authorized, but it must
        // actually be certified: an uncertified/seed/blocked assignment fails closed.
        if (assignment.qualification_state !== D65_REQUIRED_ROSTER_QUALIFICATION_STATE)
            throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not W4-certified launch authority`, [String(assignment.qualification_state), D65_REQUIRED_ROSTER_QUALIFICATION_STATE]);
        if (typeof assignment.model_id !== 'string' || assignment.model_id.length === 0)
            throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} has no model id`, [String(assignment.model_id)]);
        if (!D65_ALLOWED_THINKING.includes(assignment.thinking))
            throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} thinking is out of range`, [String(assignment.thinking)]);
        if (assignment.model !== `${provider}/${assignment.model_id}`)
            throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} model identifier is malformed`, [assignment.model]);
        // Subscription channel: the billing route and auth class must be the OAuth
        // subscription channel (never a paid metered API key/gateway). This is the
        // exact structural proof that no role can run through a metered channel.
        if (assignment.billing_class !== 'plan-backed-subscription')
            throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not on a plan-backed subscription billing class`, [String(assignment.billing_class)]);
        if (assignment.billing_route_class !== 'subscription-oauth')
            throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not on the subscription-oauth billing route`, [String(assignment.billing_route_class)]);
        if (assignment.auth_class !== 'oauth')
            throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not on an OAuth subscription auth class`, [String(assignment.auth_class)]);
    }
    // Reject any extra role beyond the closed role registry.
    for (const role of byRole.keys()) {
        if (!D65_REQUIRED_ROSTER_ROLES.includes(role))
            throw new CoordinationRuntimeError('invalid-state', 'sealed roster contains an unexpected role', [role]);
    }
    // 6. Derive the authenticated parent assignment from the sealed bytes and
    //    cross-bind it to the manifest's pinned parent fields (they cannot disagree).
    const parentAssignment = byRole.get('parent');
    if (parentAssignment === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'sealed roster has no parent assignment');
    const parentModel = parentAssignment.model;
    const parentThinking = parentAssignment.thinking;
    if (parentModel !== manifest.parent_model)
        throw new CoordinationRuntimeError('invalid-state', 'authenticated roster parent model diverges from the manifest-pinned parent_model', [parentModel, manifest.parent_model]);
    if (parentThinking !== manifest.parent_thinking)
        throw new CoordinationRuntimeError('invalid-state', 'authenticated roster parent thinking diverges from the manifest-pinned parent_thinking', [parentThinking, manifest.parent_thinking]);
    if (parentThinking !== 'high' && parentThinking !== 'xhigh')
        throw new CoordinationRuntimeError('invalid-state', 'authenticated roster parent thinking is out of range', [parentThinking]);
    return Object.freeze({
        rosterBytes,
        selectionBytes,
        parent: { model: parentModel, thinking: parentThinking },
        selectionSha256: selection.selection_sha256,
        provider,
    });
}
