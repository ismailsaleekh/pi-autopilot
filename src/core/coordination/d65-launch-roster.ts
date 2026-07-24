import { createHash } from 'node:crypto';

import { readImmutableFileBytes } from './immutable-file.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type { D65LaunchManifest } from './d65-launch-manifest.ts';
import {
  computeAutopilotRosterContractObjectHash,
  parseAutopilotPreRunSelection,
  parseAutopilotRoster,
} from '../roster/contracts.ts';
import { parseRosterJsonWithDuplicateKeyRejection } from '../roster/canonical.ts';

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
// The fixed Phase 37 subscription roster (fresh plan §2.4):
//   parent / strategy / validate / adjudicate / bughunt: <provider>/gpt-5.6-sol @ xhigh
//   implement / fix:                                      <provider>/gpt-5.6-terra @ high
//   extract:                                              <provider>/gpt-5.6-luna @ high
//   provider = openai-codex subscription only.
//
// Nothing here is inferred: a divergent digest, authority, provider, channel,
// or assignment fails closed with no model call.

/** The exact fixed subscription role assignments (fresh plan §2.4). */
export const D65_FIXED_ROSTER_ASSIGNMENTS = Object.freeze({
  parent: { model_id: 'gpt-5.6-sol', thinking: 'xhigh' },
  strategy: { model_id: 'gpt-5.6-sol', thinking: 'xhigh' },
  validate: { model_id: 'gpt-5.6-sol', thinking: 'xhigh' },
  adjudicate: { model_id: 'gpt-5.6-sol', thinking: 'xhigh' },
  bughunt: { model_id: 'gpt-5.6-sol', thinking: 'xhigh' },
  implement: { model_id: 'gpt-5.6-terra', thinking: 'high' },
  fix: { model_id: 'gpt-5.6-terra', thinking: 'high' },
  extract: { model_id: 'gpt-5.6-luna', thinking: 'high' },
} as const);

/** The only authorized subscription provider (no paid frontier API). */
export const D65_SUBSCRIPTION_PROVIDER = 'openai-codex' as const;

export interface D65AuthenticatedRoster {
  /** The exact sealed roster file bytes (raw, as loaded). */
  readonly rosterBytes: Uint8Array;
  /** The exact sealed pre-run selection file bytes (raw, as loaded). */
  readonly selectionBytes: Uint8Array;
  /** The authenticated parent assignment derived from the sealed roster. */
  readonly parent: { readonly model: string; readonly thinking: 'high' | 'xhigh' };
  /** The canonical selection sha256 recorded inside the selection object. */
  readonly selectionSha256: `sha256:${string}`;
  /** The roster subscription provider (equals the sealed manifest provider). */
  readonly provider: string;
}

function bytesSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Load and fully authenticate the sealed D65 roster + selection bytes named by
 * the launch manifest, proving the exact fixed subscription roster. Fails closed
 * on any divergence. Returns the authenticated parent assignment and the exact
 * bytes for the runtime snapshot.
 */
export function authenticateD65LaunchRoster(manifest: D65LaunchManifest): D65AuthenticatedRoster {
  const descriptor = manifest.roster_selection;
  // 1. Read the exact sealed roster + selection bytes (no-follow, one-link,
  //    bounded, mode-checked) and prove their raw-byte digests.
  const rosterBytes = readImmutableFileBytes({ path: descriptor.roster_ref, maximumBytes: 1_048_576, label: 'sealed roster authority', errorCode: 'invalid-state' });
  if (bytesSha256(rosterBytes) !== descriptor.roster_bytes_sha256) throw new CoordinationRuntimeError('invalid-state', 'sealed roster bytes diverge from the sealed roster digest', [descriptor.roster_ref]);
  const selectionBytes = readImmutableFileBytes({ path: descriptor.selection_ref, maximumBytes: 1_048_576, label: 'sealed roster selection authority', errorCode: 'invalid-state' });
  if (bytesSha256(selectionBytes) !== descriptor.selection_bytes_sha256) throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection bytes diverge from the sealed selection digest', [descriptor.selection_ref]);

  // 2. Parse both through the exact closed Phase 37 contract parsers.
  const roster = parseAutopilotRoster(parseRosterJsonWithDuplicateKeyRejection(new TextDecoder('utf-8', { fatal: true }).decode(rosterBytes)));
  const selection = parseAutopilotPreRunSelection(parseRosterJsonWithDuplicateKeyRejection(new TextDecoder('utf-8', { fatal: true }).decode(selectionBytes)));

  // 3. The roster's canonical digest must equal the manifest-bound roster_sha256,
  //    which is the same digest the signed policy + heartbeat bind. Recompute it
  //    from the parsed bytes; a divergent roster is never silently adopted.
  const rosterCanonical = computeAutopilotRosterContractObjectHash('autopilot.roster.v1', roster);
  if (rosterCanonical === null || rosterCanonical !== manifest.roster_sha256) throw new CoordinationRuntimeError('invalid-state', 'sealed roster canonical digest diverges from the manifest-bound roster_sha256', [String(rosterCanonical), manifest.roster_sha256]);

  // 4. The selection must bind the exact same roster identity/digest and its own
  //    canonical selection digest must be self-consistent + equal the sealed one.
  if (selection.roster_id !== roster.roster_id || selection.roster_revision !== roster.roster_revision || selection.roster_sha256 !== roster.roster_sha256 || selection.assignment_set_sha256 !== roster.assignment_set_sha256) {
    throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection does not bind the exact sealed roster identity/digest', [selection.roster_id, String(selection.roster_revision)]);
  }
  const selectionCanonical = computeAutopilotRosterContractObjectHash('autopilot.pre_run_selection.v1', selection);
  if (selectionCanonical === null || selection.selection_sha256 !== selectionCanonical) throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection digest is not self-consistent');
  if (selection.selection_sha256 !== descriptor.selection_sha256) throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection digest diverges from the manifest descriptor');
  if (selection.repo_id !== manifest.repo_id || selection.workstream_run !== manifest.workstream_run) throw new CoordinationRuntimeError('invalid-state', 'sealed roster selection identity diverges from the sealed run identity', [selection.repo_id, selection.workstream_run]);

  // 5. Prove the EXACT fixed subscription roster: every role's provider, model,
  //    thinking, and subscription channel is the fixed value; no paid route.
  const provider = manifest.roster_selection.provider;
  if (provider !== D65_SUBSCRIPTION_PROVIDER) throw new CoordinationRuntimeError('invalid-state', 'sealed roster provider is not the authorized subscription provider', [provider]);
  const byRole = new Map<string, (typeof roster.assignments)[number]>();
  for (const assignment of roster.assignments) {
    if (byRole.has(assignment.role)) throw new CoordinationRuntimeError('invalid-state', 'sealed roster contains a duplicate role assignment', [assignment.role]);
    byRole.set(assignment.role, assignment);
  }
  for (const [role, expected] of Object.entries(D65_FIXED_ROSTER_ASSIGNMENTS)) {
    const assignment = byRole.get(role);
    if (assignment === undefined) throw new CoordinationRuntimeError('invalid-state', 'sealed roster is missing a fixed role assignment', [role]);
    if (assignment.provider_id !== provider) throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not on the subscription provider`, [assignment.provider_id]);
    if (assignment.model_id !== expected.model_id) throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} model diverges from the fixed subscription roster`, [assignment.model_id, expected.model_id]);
    if (assignment.thinking !== expected.thinking) throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} thinking diverges from the fixed subscription roster`, [assignment.thinking, expected.thinking]);
    if (assignment.model !== `${provider}/${expected.model_id}`) throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} model identifier is malformed`, [assignment.model]);
    // Subscription channel: the billing route and auth class must be the OAuth
    // subscription channel (never a paid metered API key/gateway). This is the
    // exact structural proof that no role can run through a metered channel.
    if (assignment.billing_class !== 'plan-backed-subscription') throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not on a plan-backed subscription billing class`, [String(assignment.billing_class)]);
    if (assignment.billing_route_class !== 'subscription-oauth') throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not on the subscription-oauth billing route`, [String(assignment.billing_route_class)]);
    if (assignment.auth_class !== 'oauth') throw new CoordinationRuntimeError('invalid-state', `sealed roster role ${role} is not on an OAuth subscription auth class`, [String(assignment.auth_class)]);
  }
  // Reject any extra role beyond the fixed set (the closed role registry).
  for (const role of byRole.keys()) {
    if (!(role in D65_FIXED_ROSTER_ASSIGNMENTS)) throw new CoordinationRuntimeError('invalid-state', 'sealed roster contains an unexpected role', [role]);
  }

  // 6. Derive the authenticated parent assignment from the sealed bytes and
  //    cross-bind it to the manifest's pinned parent fields (they cannot disagree).
  const parentAssignment = byRole.get('parent');
  if (parentAssignment === undefined) throw new CoordinationRuntimeError('invalid-state', 'sealed roster has no parent assignment');
  const parentModel = parentAssignment.model;
  const parentThinking = parentAssignment.thinking;
  if (parentModel !== manifest.parent_model) throw new CoordinationRuntimeError('invalid-state', 'authenticated roster parent model diverges from the manifest-pinned parent_model', [parentModel, manifest.parent_model]);
  if (parentThinking !== manifest.parent_thinking) throw new CoordinationRuntimeError('invalid-state', 'authenticated roster parent thinking diverges from the manifest-pinned parent_thinking', [parentThinking, manifest.parent_thinking]);
  if (parentThinking !== 'high' && parentThinking !== 'xhigh') throw new CoordinationRuntimeError('invalid-state', 'authenticated roster parent thinking is out of range', [parentThinking]);

  return Object.freeze({
    rosterBytes,
    selectionBytes,
    parent: { model: parentModel, thinking: parentThinking },
    selectionSha256: selection.selection_sha256 as `sha256:${string}`,
    provider,
  });
}
