import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

import {
  fail,
  gitOid,
  identifier,
  integer,
  isJsonObject,
  literal,
  object,
  repoRelativePath,
  sha256Field,
  str,
  timestamp,
  type JsonObject,
} from './d65-semantic-graph.ts';

// D65 sealed prelaunch package (freeze §9; fresh plan §§2.3/3.2/2.4). This is
// the ONE closed, versioned, size-bounded manifest the human `/autopilot`
// startup path consumes to bind a fixed prelaunch identity rather than
// regenerate it. Like `autopilot.bootstrap_projection.v1`, it is EXTERNAL
// private launch authority: it is never coordinator-registered, never an
// npm/store vocabulary, and never a package "consumer" schema. The launcher
// reads exactly these sealed bytes; every value is consumed, never inferred.
//
// The manifest binds all prelaunch facts required by the frozen plan:
//   - program / workstream / workstream_run;
//   - run timestamp + nonce;
//   - source clone, canonical root, Git common dir, repo identity;
//   - B0 commit/tree;
//   - content-result commit/tree;
//   - package commit/tree;
//   - run branch, target branch, state root, session root, worktree paths;
//   - bootstrap overlay commit/tree/ref/hash/byte count;
//   - trust anchor ref/hash/blob identity;
//   - exact prospective run/resource;
//   - roster authority/selection/hash;
//   - policy candidate ref/hash and required idempotency identities;
//   - program evidence root;
//   - launch audit/seal references.
//
// Unknown fields, wrong types, out-of-range values, non-canonical digests, and
// any inferred default all reject. There is NO lower-precedence fallback after
// a supplied manifest fails.

export const D65_LAUNCH_MANIFEST_SCHEMA = 'autopilot.launch_manifest.v1' as const;

/** Absolute normalized filesystem path (no NUL, no `/../`, no trailing slash). */
function absolutePathField(record: JsonObject, field: string, label: string, maxLength = 4096): string {
  const value = str(record, field, label, maxLength);
  if (!isAbsolute(value) || value.includes('\u0000') || normalize(value) !== value || (value.length > 1 && value.endsWith('/'))) fail(label, `${field} must be a normalized absolute path`);
  return value;
}

function unpaddedBase64Url(record: JsonObject, field: string, label: string): string {
  const value = str(record, field, label, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail(label, `${field} must be unpadded base64url`);
  return value;
}

function parentModel(record: JsonObject, label: string): string {
  const value = str(record, 'parent_model', label, 256);
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1 || value.includes(' ')) fail(label, 'parent_model must be a provider/model identifier');
  return value;
}

function parentThinking(record: JsonObject, label: string): 'high' | 'xhigh' {
  const value = record['parent_thinking'];
  if (value !== 'high' && value !== 'xhigh') fail(label, 'parent_thinking must be high or xhigh');
  return value;
}

/** A bounded closed prospective canonical object image (run or resource row). */
function prospectiveObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) fail(label, 'must be an object');
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 64) fail(label, 'prospective object field count is out of range');
  return value;
}

// ---- bootstrap overlay descriptor -------------------------------------------

export interface D65LaunchManifestBootstrapOverlay {
  readonly overlay_commit: string;
  readonly overlay_tree: string;
  readonly overlay_ref: string;
  readonly bootstrap_ref: string;
  readonly bootstrap_sha256: `sha256:${string}`;
  readonly bootstrap_byte_count: number;
}

function bootstrapOverlay(value: unknown, label: string): D65LaunchManifestBootstrapOverlay {
  const record = object(value, label, [
    'overlay_commit', 'overlay_tree', 'overlay_ref', 'bootstrap_ref', 'bootstrap_sha256', 'bootstrap_byte_count',
  ]);
  return {
    overlay_commit: gitOid(record, 'overlay_commit', label),
    overlay_tree: gitOid(record, 'overlay_tree', label),
    overlay_ref: repoRelativePath(record, 'overlay_ref', label, 256),
    bootstrap_ref: repoRelativePath(record, 'bootstrap_ref', label, 256),
    bootstrap_sha256: sha256Field(record, 'bootstrap_sha256', label),
    bootstrap_byte_count: integer(record, 'bootstrap_byte_count', label, 1),
  };
}

// ---- trust anchor descriptor ------------------------------------------------

export interface D65LaunchManifestTrustAnchor {
  readonly trust_anchor_ref: string;
  readonly trust_anchor_sha256: `sha256:${string}`;
  readonly trust_anchor_blob_oid: string;
  readonly byte_count: 44;
}

function trustAnchor(value: unknown, label: string): D65LaunchManifestTrustAnchor {
  const record = object(value, label, ['trust_anchor_ref', 'trust_anchor_sha256', 'trust_anchor_blob_oid', 'byte_count']);
  if (record['byte_count'] !== 44) fail(label, 'trust anchor byte_count must be exactly 44');
  return {
    trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label, 256),
    trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
    trust_anchor_blob_oid: gitOid(record, 'trust_anchor_blob_oid', label),
    byte_count: 44,
  };
}

// ---- policy candidate + idempotency descriptor ------------------------------

export interface D65LaunchManifestPolicyCandidate {
  readonly policy_id: string;
  readonly policy_ref: string;
  readonly policy_sha256: `sha256:${string}`;
  readonly registration_idempotency_key: string;
  readonly heartbeat_acceptance_idempotency_key: string;
}

function policyCandidate(value: unknown, label: string): D65LaunchManifestPolicyCandidate {
  const record = object(value, label, [
    'policy_id', 'policy_ref', 'policy_sha256', 'registration_idempotency_key', 'heartbeat_acceptance_idempotency_key',
  ]);
  return {
    policy_id: identifier(record, 'policy_id', label),
    policy_ref: repoRelativePath(record, 'policy_ref', label, 256),
    policy_sha256: sha256Field(record, 'policy_sha256', label),
    registration_idempotency_key: str(record, 'registration_idempotency_key', label, 256),
    heartbeat_acceptance_idempotency_key: str(record, 'heartbeat_acceptance_idempotency_key', label, 256),
  };
}

// ---- launch seal / audit descriptor -----------------------------------------

export interface D65LaunchManifestLaunchSeal {
  readonly launch_commit: string;
  readonly launch_tree: string;
  readonly launch_audit_ref: string;
  readonly launch_audit_sha256: `sha256:${string}`;
  readonly launch_seal_sha256: `sha256:${string}`;
  readonly bootstrap_projection_ref: string;
  readonly bootstrap_projection_sha256: `sha256:${string}`;
}

function launchSeal(value: unknown, label: string): D65LaunchManifestLaunchSeal {
  const record = object(value, label, [
    'launch_commit', 'launch_tree', 'launch_audit_ref', 'launch_audit_sha256', 'launch_seal_sha256',
    'bootstrap_projection_ref', 'bootstrap_projection_sha256',
  ]);
  return {
    launch_commit: gitOid(record, 'launch_commit', label),
    launch_tree: gitOid(record, 'launch_tree', label),
    launch_audit_ref: absolutePathField(record, 'launch_audit_ref', label),
    launch_audit_sha256: sha256Field(record, 'launch_audit_sha256', label),
    launch_seal_sha256: sha256Field(record, 'launch_seal_sha256', label),
    bootstrap_projection_ref: absolutePathField(record, 'bootstrap_projection_ref', label),
    bootstrap_projection_sha256: sha256Field(record, 'bootstrap_projection_sha256', label),
  };
}

// ---- top-level manifest -----------------------------------------------------

export interface D65LaunchManifest {
  readonly schema_version: typeof D65_LAUNCH_MANIFEST_SCHEMA;
  readonly manifest_id: string;
  readonly program_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly autopilot_id: string;
  readonly run_timestamp: string;
  readonly run_nonce: string;
  readonly source_clone: string;
  readonly canonical_root: string;
  readonly git_common_dir: string;
  readonly repo_id: string;
  readonly repo_key: string;
  readonly b0_commit: string;
  readonly b0_tree: string;
  readonly content_result_commit: string;
  readonly content_result_tree: string;
  readonly package_commit: string;
  readonly package_tree: string;
  readonly run_branch: string;
  readonly target_branch: string;
  readonly state_root: string;
  readonly session_root: string;
  readonly worktree_root: string;
  readonly main_worktree_path: string;
  readonly runtime_root: string;
  readonly bootstrap_overlay: D65LaunchManifestBootstrapOverlay;
  readonly trust_anchor: D65LaunchManifestTrustAnchor;
  readonly prospective_run: JsonObject;
  readonly prospective_resource: JsonObject;
  readonly coordination_authority: 'coordinator-edit-leases-v1';
  readonly roster_authority: string;
  readonly roster_selection_ref: string;
  readonly roster_sha256: `sha256:${string}`;
  /** The exact pinned parent model (`provider/model`) and thinking level. */
  readonly parent_model: string;
  readonly parent_thinking: 'high' | 'xhigh';
  readonly policy_candidate: D65LaunchManifestPolicyCandidate;
  readonly program_evidence_root: string;
  readonly launch_seal: D65LaunchManifestLaunchSeal;
  readonly attach_run_idempotency_key: string;
  readonly attach_session_idempotency_key: string;
  readonly created_at: string;
}

/** The exact frozen top-level manifest fields (no unknown-field tolerance). */
const MANIFEST_FIELDS = Object.freeze([
  'schema_version', 'manifest_id', 'program_id', 'workstream', 'workstream_run', 'autopilot_id',
  'run_timestamp', 'run_nonce', 'source_clone', 'canonical_root', 'git_common_dir', 'repo_id', 'repo_key',
  'b0_commit', 'b0_tree', 'content_result_commit', 'content_result_tree', 'package_commit', 'package_tree',
  'run_branch', 'target_branch', 'state_root', 'session_root', 'worktree_root', 'main_worktree_path',
  'runtime_root', 'bootstrap_overlay', 'trust_anchor', 'prospective_run', 'prospective_resource',
  'coordination_authority', 'roster_authority', 'roster_selection_ref', 'roster_sha256', 'parent_model', 'parent_thinking', 'policy_candidate',
  'program_evidence_root', 'launch_seal', 'attach_run_idempotency_key', 'attach_session_idempotency_key',
  'created_at',
] as const);

const RUN_NONCE = /^[a-f0-9]{6}$/u;
export const D65_LAUNCH_MANIFEST_MAX_BYTES = 262_144 as const;

/**
 * Parse and cross-validate a sealed D65 launch manifest. This is the closed,
 * lowest-layer, no-fallback parser. It proves internal consistency of the
 * sealed identities; the launcher separately proves that the sealed identities
 * agree with the physical clone/overlay/policy bytes at load time.
 */
export function parseD65LaunchManifest(value: unknown): D65LaunchManifest {
  const label = D65_LAUNCH_MANIFEST_SCHEMA;
  const record = object(value, label, MANIFEST_FIELDS);
  literal(record, 'schema_version', D65_LAUNCH_MANIFEST_SCHEMA, label);
  const runNonce = str(record, 'run_nonce', label, 6);
  if (!RUN_NONCE.test(runNonce)) fail(label, 'run_nonce must be exactly six lowercase hex characters');
  if (record['coordination_authority'] !== 'coordinator-edit-leases-v1') fail(label, 'coordination_authority must be exactly coordinator-edit-leases-v1');

  const manifest: D65LaunchManifest = {
    schema_version: D65_LAUNCH_MANIFEST_SCHEMA,
    manifest_id: identifier(record, 'manifest_id', label),
    program_id: identifier(record, 'program_id', label),
    workstream: identifier(record, 'workstream', label),
    workstream_run: identifier(record, 'workstream_run', label),
    autopilot_id: identifier(record, 'autopilot_id', label),
    run_timestamp: timestamp(record, 'run_timestamp', label),
    run_nonce: runNonce,
    source_clone: absolutePathField(record, 'source_clone', label),
    canonical_root: absolutePathField(record, 'canonical_root', label),
    git_common_dir: absolutePathField(record, 'git_common_dir', label),
    repo_id: identifier(record, 'repo_id', label),
    repo_key: identifier(record, 'repo_key', label),
    b0_commit: gitOid(record, 'b0_commit', label),
    b0_tree: gitOid(record, 'b0_tree', label),
    content_result_commit: gitOid(record, 'content_result_commit', label),
    content_result_tree: gitOid(record, 'content_result_tree', label),
    package_commit: gitOid(record, 'package_commit', label),
    package_tree: gitOid(record, 'package_tree', label),
    run_branch: str(record, 'run_branch', label, 256),
    target_branch: str(record, 'target_branch', label, 256),
    state_root: absolutePathField(record, 'state_root', label),
    session_root: absolutePathField(record, 'session_root', label),
    worktree_root: absolutePathField(record, 'worktree_root', label),
    main_worktree_path: absolutePathField(record, 'main_worktree_path', label),
    runtime_root: absolutePathField(record, 'runtime_root', label),
    bootstrap_overlay: bootstrapOverlay(record['bootstrap_overlay'], `${label}.bootstrap_overlay`),
    trust_anchor: trustAnchor(record['trust_anchor'], `${label}.trust_anchor`),
    prospective_run: prospectiveObject(record['prospective_run'], `${label}.prospective_run`),
    prospective_resource: prospectiveObject(record['prospective_resource'], `${label}.prospective_resource`),
    coordination_authority: 'coordinator-edit-leases-v1',
    roster_authority: str(record, 'roster_authority', label, 256),
    roster_selection_ref: repoRelativePath(record, 'roster_selection_ref', label, 256),
    roster_sha256: sha256Field(record, 'roster_sha256', label),
    parent_model: parentModel(record, label),
    parent_thinking: parentThinking(record, label),
    policy_candidate: policyCandidate(record['policy_candidate'], `${label}.policy_candidate`),
    program_evidence_root: absolutePathField(record, 'program_evidence_root', label),
    launch_seal: launchSeal(record['launch_seal'], `${label}.launch_seal`),
    attach_run_idempotency_key: str(record, 'attach_run_idempotency_key', label, 256),
    attach_session_idempotency_key: str(record, 'attach_session_idempotency_key', label, 256),
    created_at: timestamp(record, 'created_at', label),
  };

  // Internal identity binding: the prospective run/resource images must name
  // the exact sealed run identity; the resource main worktree/branch/roots must
  // equal the top-level sealed paths; target_base_sha must be the content
  // result (never B0 or the launch/bootstrap overlay). These are the same
  // frozen relations the store re-verifies at attach-run and policy
  // registration, checked here before any mutation so a malformed manifest
  // rejects up front.
  requireProspectiveRun(manifest);
  requireProspectiveResource(manifest);

  // B0 and content-result must be distinct commits/trees (content_result is a
  // one-parent child of B0; equal commits would collapse the frozen ancestry).
  if (manifest.b0_commit === manifest.content_result_commit) fail(label, 'b0_commit and content_result_commit must be distinct');

  // The bootstrap/launch overlay commit is a sibling of the content result and
  // NEVER the run base: the run resource target_base_sha must be the content
  // result, and the overlay commit must differ from both B0 and content result.
  if (manifest.bootstrap_overlay.overlay_commit === manifest.b0_commit || manifest.bootstrap_overlay.overlay_commit === manifest.content_result_commit) fail(label, 'bootstrap overlay commit must be a sibling, never B0 or the content-result base');
  if (manifest.launch_seal.launch_commit !== manifest.bootstrap_overlay.overlay_commit) fail(label, 'launch_seal.launch_commit must equal the bootstrap overlay commit');
  if (manifest.launch_seal.launch_tree !== manifest.bootstrap_overlay.overlay_tree) fail(label, 'launch_seal.launch_tree must equal the bootstrap overlay tree');

  // Roots must be authority-distinct: state/session roots outside the clone,
  // program evidence root outside every clone/state/session/worktree root.
  requireAuthorityDistinctRoots(manifest);

  return Object.freeze(manifest);
}

function stringField(row: JsonObject, field: string, label: string): string {
  const value = row[field];
  if (typeof value !== 'string') fail(label, `${field} must be a string`);
  return value;
}

function requireProspectiveRun(manifest: D65LaunchManifest): void {
  const label = `${D65_LAUNCH_MANIFEST_SCHEMA}.prospective_run`;
  const run = manifest.prospective_run;
  if (stringField(run, 'schema_version', label) !== 'autopilot.coordination_run.v1') fail(label, 'prospective_run schema must be autopilot.coordination_run.v1');
  if (stringField(run, 'repo_id', label) !== manifest.repo_id) fail(label, 'prospective_run repo_id differs from the sealed repo_id');
  if (stringField(run, 'workstream_run', label) !== manifest.workstream_run) fail(label, 'prospective_run workstream_run differs from the sealed workstream_run');
  if (stringField(run, 'workstream', label) !== manifest.workstream) fail(label, 'prospective_run workstream differs from the sealed workstream');
  if (stringField(run, 'autopilot_id', label) !== manifest.autopilot_id) fail(label, 'prospective_run autopilot_id differs from the sealed autopilot_id');
  if (stringField(run, 'coordination_authority', label) !== manifest.coordination_authority) fail(label, 'prospective_run coordination_authority differs from the sealed authority');
  if (run['status'] !== 'active' || run['active_session_generation'] !== 0 || run['created_event_seq'] !== 1 || run['version'] !== 1) fail(label, 'prospective_run must be the exact fresh active generation-0 version-1 row');
}

function requireProspectiveResource(manifest: D65LaunchManifest): void {
  const label = `${D65_LAUNCH_MANIFEST_SCHEMA}.prospective_resource`;
  const resource = manifest.prospective_resource;
  if (stringField(resource, 'schema_version', label) !== 'autopilot.coordination_run_resource.v1') fail(label, 'prospective_resource schema must be autopilot.coordination_run_resource.v1');
  if (stringField(resource, 'repo_id', label) !== manifest.repo_id) fail(label, 'prospective_resource repo_id differs from the sealed repo_id');
  if (stringField(resource, 'workstream_run', label) !== manifest.workstream_run) fail(label, 'prospective_resource workstream_run differs from the sealed workstream_run');
  if (stringField(resource, 'source_repo', label) !== manifest.canonical_root) fail(label, 'prospective_resource source_repo differs from the sealed canonical_root');
  if (stringField(resource, 'git_common_dir', label) !== manifest.git_common_dir) fail(label, 'prospective_resource git_common_dir differs from the sealed git_common_dir');
  if (stringField(resource, 'worktree_root', label) !== manifest.worktree_root) fail(label, 'prospective_resource worktree_root differs from the sealed worktree_root');
  if (stringField(resource, 'main_worktree_path', label) !== manifest.main_worktree_path) fail(label, 'prospective_resource main_worktree_path differs from the sealed main_worktree_path');
  if (stringField(resource, 'runtime_root', label) !== manifest.runtime_root) fail(label, 'prospective_resource runtime_root differs from the sealed runtime_root');
  if (stringField(resource, 'branch', label) !== manifest.run_branch) fail(label, 'prospective_resource branch differs from the sealed run_branch');
  if (stringField(resource, 'target_branch', label) !== manifest.target_branch) fail(label, 'prospective_resource target_branch differs from the sealed target_branch');
  if (stringField(resource, 'target_base_sha', label) !== manifest.content_result_commit) fail(label, 'prospective_resource target_base_sha must be the content-result commit (never B0 or the launch overlay)');
  if (resource['version'] !== 1) fail(label, 'prospective_resource version must be exactly 1');
}

function requireAuthorityDistinctRoots(manifest: D65LaunchManifest): void {
  const label = D65_LAUNCH_MANIFEST_SCHEMA;
  const withSep = (root: string): string => (root.endsWith('/') ? root : `${root}/`);
  const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(withSep(parent));
  // State/session/worktree/program-evidence roots must not live inside the
  // source clone; the program evidence root must be outside every other root.
  const clone = manifest.source_clone;
  for (const [name, root] of [['state_root', manifest.state_root], ['session_root', manifest.session_root], ['program_evidence_root', manifest.program_evidence_root]] as const) {
    if (isInside(root, clone)) fail(label, `${name} must live outside the source clone`);
  }
  if (!isInside(manifest.canonical_root, clone) && manifest.canonical_root !== clone) fail(label, 'canonical_root must be the source clone or a descendant of it');
  for (const other of [manifest.source_clone, manifest.state_root, manifest.session_root, manifest.worktree_root, manifest.main_worktree_path]) {
    if (isInside(manifest.program_evidence_root, other) || isInside(other, manifest.program_evidence_root)) fail(label, 'program_evidence_root must be authority-distinct from every clone/state/session/worktree root');
  }
}

/** The exact SHA-256 of a manifest's canonical UTF-8 bytes (as loaded). */
export function launchManifestBytesSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
