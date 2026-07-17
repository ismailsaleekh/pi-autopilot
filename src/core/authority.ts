import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AutopilotUnitSpec, AutopilotVerificationPlan, AutopilotWitnessSpec } from './contracts/types.ts';
import { gitQueryText } from './git-process.ts';
import {
  normalizeMaterializationPath,
  pathMatchesMaterializationPattern,
  scanTrackedTree,
  trackedEntriesForMaterializationPath,
  type AutopilotTrackedTreeEntry,
  type AutopilotTrackedTreeScan,
} from './checkout-profile.ts';
import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from './names.ts';
import { coordinationExclusiveOperation, type CoordinationRuntimeExclusiveOperationKind } from './coordination/exclusive-policy.ts';
import { parseCoordinationExclusiveOperation } from './coordination/contracts.ts';
import { deriveCoordinationObservationSourceIdentity } from './coordination/observations.ts';
import type { CoordinationExclusiveOperation, CoordinationObservationSourceIdentity } from './coordination/types.ts';

export const AUTOPILOT_AUTHORITY_SCHEMA = 'autopilot.authority.v1' as const;
export const AUTOPILOT_AUTHORITY_PATH_LIMIT = 512;
export const AUTOPILOT_AUTHORITY_BROAD_FILE_LIMIT = 4_096;
export const AUTOPILOT_AUTHORITY_BROAD_BYTE_LIMIT = 536_870_912;

export type AutopilotAuthoritySource = 'owned-path' | 'read-only-path' | 'context-ref' | 'verification-inspection-target' | 'runtime-exclusive';
export type AutopilotAuthorityScope = 'tracked-file' | 'tracked-directory' | 'tracked-subtree' | 'future-owned-file' | 'future-owned-directory';

export interface AutopilotObservationAuthority {
  readonly path: string;
  readonly purpose: string;
  readonly sources: readonly Exclude<AutopilotAuthoritySource, 'owned-path' | 'runtime-exclusive'>[];
  readonly scope: Exclude<AutopilotAuthorityScope, 'future-owned-file' | 'future-owned-directory'>;
  readonly tracked_file_count: number;
  readonly tracked_byte_count: number;
  readonly source_identity: CoordinationObservationSourceIdentity;
}

export interface AutopilotEditIntentAuthority {
  readonly path: string;
  readonly purpose: string;
  readonly sources: readonly ('owned-path')[];
  readonly scope: AutopilotAuthorityScope;
  readonly tracked_file_count: number;
  readonly tracked_byte_count: number;
}

export interface AutopilotExclusiveAuthority {
  readonly path: string;
  readonly purpose: string;
  readonly sources: readonly ('runtime-exclusive')[];
  readonly scope: 'tracked-file';
  readonly tracked_file_count: number;
  readonly tracked_byte_count: number;
  readonly operation: CoordinationExclusiveOperation;
  readonly critical_section: CoordinationRuntimeExclusiveOperationKind;
}

export interface AutopilotAuthorityArtifact {
  readonly schema_version: typeof AUTOPILOT_AUTHORITY_SCHEMA;
  readonly workstream: string;
  readonly unit_id: string;
  readonly attempt: number;
  readonly role: AutopilotUnitSpec['role'];
  readonly base_commit: string;
  readonly observations: readonly AutopilotObservationAuthority[];
  readonly edit_intentions: readonly AutopilotEditIntentAuthority[];
  readonly exclusives: readonly AutopilotExclusiveAuthority[];
}

export interface AutopilotRuntimeExclusiveIntent {
  readonly path: string;
  readonly purpose: string;
  readonly operationId: string;
  readonly operationKind: CoordinationRuntimeExclusiveOperationKind;
  readonly expectedDurationMs: number;
}

export interface AutopilotAuthorityDerivationLimits {
  readonly maxPaths?: number;
  readonly maxBroadTrackedFiles?: number;
  readonly maxBroadTrackedBytes?: number;
}

export class AutopilotAuthorityError extends Error {
  override readonly name = 'AutopilotAuthorityError';
  readonly code: string;
  readonly evidence: readonly string[];

  constructor(code: string, message: string, evidence: readonly string[] = []) {
    super(`AutopilotAuthorityError [${code}]: ${message}`);
    this.code = code;
    this.evidence = Object.freeze([...evidence]);
  }
}

function fail(code: string, message: string, evidence: readonly string[] = []): never {
  throw new AutopilotAuthorityError(code, message, evidence);
}

interface AuthorityCandidate {
  readonly path: string;
  readonly source: AutopilotAuthoritySource;
  readonly purpose: string;
  readonly exclusiveOperation: CoordinationExclusiveOperation | null;
}

interface GroundedPath {
  readonly path: string;
  readonly scope: AutopilotAuthorityScope;
  readonly entries: readonly AutopilotTrackedTreeEntry[];
  readonly trackedFileCount: number;
  readonly trackedByteCount: number;
}

/**
 * Canonical source-of-truth extraction. Worktree bootstrap, scheduler,
 * materialization, and runner authority derivation all consume this exact set;
 * no caller is allowed to independently infer context/witness READ authority.
 */
export function authorityCandidatesForSpec(
  spec: AutopilotUnitSpec,
  runtimeExclusives: readonly AutopilotRuntimeExclusiveIntent[] = [],
): readonly AuthorityCandidate[] {
  const candidates: AuthorityCandidate[] = [];
  const add = (path: string, source: AutopilotAuthoritySource, purpose: string, exclusiveOperation: CoordinationExclusiveOperation | null = null): void => {
    const normalized = normalizeMaterializationPath(path, `${source} authority`);
    if (isRuntimeRepoPath(normalized, spec.workstream)) return;
    candidates.push({ path: normalized, source, purpose, exclusiveOperation });
  };
  for (const path of spec.owned_paths) add(path, 'owned-path', `edit intention for ${spec.unit_id}`);
  for (const path of spec.read_only_paths) add(path, 'read-only-path', `declared observation for ${spec.unit_id}`);
  for (const ref of spec.context_refs) add(ref.path, 'context-ref', `context observation for ${spec.unit_id}: ${ref.purpose}`);
  for (const witness of witnessesFromVerificationPlan(spec.verification_plan)) {
    if (witness.inspection_target !== undefined) add(witness.inspection_target, 'verification-inspection-target', `verification observation for ${spec.unit_id}: ${witness.id}`);
  }
  for (const exclusive of runtimeExclusives) add(exclusive.path, 'runtime-exclusive', exclusive.purpose, coordinationExclusiveOperation({ operationId: exclusive.operationId, operationKind: exclusive.operationKind, expectedDurationMs: exclusive.expectedDurationMs }));
  return Object.freeze(candidates);
}

/**
 * Derive one immutable, repository-grounded authority artifact. OBSERVE entries
 * bind exact Git objects. EDIT_INTENT entries may name tracked surfaces or an
 * explicit future-owned path; arbitrary untracked read/prose paths are rejected.
 */
export async function deriveAutopilotAuthority(input: {
  readonly spec: AutopilotUnitSpec;
  readonly cwd?: string;
  readonly scan?: AutopilotTrackedTreeScan;
  readonly runtimeExclusives?: readonly AutopilotRuntimeExclusiveIntent[];
  readonly limits?: AutopilotAuthorityDerivationLimits;
}): Promise<AutopilotAuthorityArtifact> {
  const cwd = input.cwd ?? input.spec.cwd;
  const scan = input.scan ?? await scanTrackedTree(cwd);
  if (scan.head_sha.length < 40 || scan.head_sha.length > 64 || !/^[a-f0-9]+$/u.test(scan.head_sha)) fail('invalid-base-commit', 'authority derivation requires a full lowercase Git commit id', [scan.head_sha]);
  const candidates = authorityCandidatesForSpec(input.spec, input.runtimeExclusives ?? []);
  const runtimeExclusiveCount = candidates.filter((candidate) => candidate.source === 'runtime-exclusive').length;
  if (runtimeExclusiveCount > 1) fail('exclusive-operation-cap', 'one unit attempt may enter at most one bounded EXCLUSIVE critical operation', [`count=${String(runtimeExclusiveCount)}`]);
  if (runtimeExclusiveCount > 0 && input.spec.role !== 'implement' && input.spec.role !== 'fix') fail('exclusive-role-forbidden', 'only source-changing package runtime attempts may receive EXCLUSIVE authority', [input.spec.role]);
  const maxPaths = input.limits?.maxPaths ?? AUTOPILOT_AUTHORITY_PATH_LIMIT;
  const candidatePathCount = new Set(candidates.map((candidate) => candidate.path)).size;
  if (candidatePathCount > maxPaths) fail('authority-path-cap', 'canonical authority path count exceeds the bounded package limit', [`count=${String(candidatePathCount)}`, `cap=${String(maxPaths)}`]);

  const ownedPaths = candidates.filter((candidate) => candidate.source === 'owned-path').map((candidate) => candidate.path);
  const exclusivePaths = candidates.filter((candidate) => candidate.source === 'runtime-exclusive').map((candidate) => candidate.path);
  const observationsByPath = new Map<string, AuthorityCandidate[]>();
  const editsByPath = new Map<string, AuthorityCandidate[]>();
  const exclusivesByPath = new Map<string, AuthorityCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.source === 'runtime-exclusive') append(exclusivesByPath, candidate.path, candidate);
    else if (candidate.source === 'owned-path') append(editsByPath, candidate.path, candidate);
    else if (!ownedPaths.some((authorityPath) => authorityCoversPath(authorityPath, candidate.path)) && !exclusivePaths.some((authorityPath) => pathsOverlap(authorityPath, candidate.path))) append(observationsByPath, candidate.path, candidate);
  }

  // EXCLUSIVE is a transient critical-operation layer over the same exact
  // WRITE intention. Keeping WRITE preserves non-blocking edit attribution
  // after the critical section exits and before merge/reset/quarantine.
  for (const exclusivePath of exclusivePaths) {
    if (!ownedPaths.includes(exclusivePath)) fail('exclusive-owned-path-required', 'EXCLUSIVE authority must layer over one exact declared owned path', [exclusivePath]);
  }

  const observations: AutopilotObservationAuthority[] = [];
  for (const [path, grouped] of observationsByPath) {
    const grounded = groundPath(scan, path, false, input.limits);
    const sources = sortedUnique(grouped.map((candidate) => candidate.source)).filter(isObservationSource);
    const sourceIdentity = deriveCoordinationObservationSourceIdentity({ cwd, path });
    if (sourceIdentity.base_commit !== scan.head_sha) fail('authority-head-drift', 'repository HEAD changed while deriving observation authority', [`scan=${scan.head_sha}`, `observation=${sourceIdentity.base_commit}`, path]);
    observations.push({
      path,
      purpose: authorityPurpose(grouped, path),
      sources,
      scope: requireTrackedScope(grounded.scope),
      tracked_file_count: grounded.trackedFileCount,
      tracked_byte_count: grounded.trackedByteCount,
      source_identity: sourceIdentity,
    });
  }

  const editIntentions: AutopilotEditIntentAuthority[] = [];
  for (const [path, grouped] of editsByPath) {
    const grounded = groundPath(scan, path, true, input.limits);
    editIntentions.push({
      path,
      purpose: authorityPurpose(grouped, path),
      sources: Object.freeze(['owned-path'] as const),
      scope: grounded.scope,
      tracked_file_count: grounded.trackedFileCount,
      tracked_byte_count: grounded.trackedByteCount,
    });
  }

  const exclusives: AutopilotExclusiveAuthority[] = [];
  for (const [path, grouped] of exclusivesByPath) {
    if (path.endsWith('/**') || path.endsWith('/')) fail('exclusive-scope-forbidden', 'EXCLUSIVE authority requires one exact tracked file, never a directory or subtree', [path]);
    const grounded = groundPath(scan, path, false, input.limits);
    if (grounded.scope !== 'tracked-file' || grounded.trackedFileCount !== 1) fail('exclusive-scope-forbidden', 'EXCLUSIVE authority requires one exact tracked file', [path, grounded.scope, `files=${String(grounded.trackedFileCount)}`]);
    const operations = grouped.map((candidate) => candidate.exclusiveOperation).filter((operation): operation is CoordinationExclusiveOperation => operation !== null);
    const operationBytes = sortedUnique(operations.map((operation) => JSON.stringify(operation)));
    if (operations.length !== grouped.length || operationBytes.length !== 1 || operations[0] === undefined) fail('invalid-exclusive-operation', 'runtime EXCLUSIVE authority requires one identical closed package operation contract', [path]);
    const operation = operations[0];
    if (operation.operation_kind === 'legacy-migration-exclusive') fail('invalid-exclusive-operation', 'runtime authority cannot create a legacy migration EXCLUSIVE operation', [path]);
    exclusives.push({
      path,
      purpose: authorityPurpose(grouped, path),
      sources: Object.freeze(['runtime-exclusive'] as const),
      scope: 'tracked-file',
      tracked_file_count: grounded.trackedFileCount,
      tracked_byte_count: grounded.trackedByteCount,
      operation,
      critical_section: operation.operation_kind,
    });
  }

  if (observations.length + editIntentions.length + exclusives.length > maxPaths) fail('authority-path-cap', 'canonical authority artifact exceeds the bounded package path limit after grouping', [`count=${String(observations.length + editIntentions.length + exclusives.length)}`, `cap=${String(maxPaths)}`]);
  const finalHead = repositoryHead(cwd);
  if (finalHead !== scan.head_sha) fail('authority-head-drift', 'repository HEAD changed during canonical authority derivation', [`scan=${scan.head_sha}`, `final=${finalHead}`]);
  return Object.freeze({
    schema_version: AUTOPILOT_AUTHORITY_SCHEMA,
    workstream: input.spec.workstream,
    unit_id: input.spec.unit_id,
    attempt: input.spec.attempt,
    role: input.spec.role,
    base_commit: scan.head_sha,
    observations: Object.freeze(observations.sort(authorityPathOrder)),
    edit_intentions: Object.freeze(editIntentions.sort(authorityPathOrder)),
    exclusives: Object.freeze(exclusives.sort(authorityPathOrder)),
  });
}

export function authorityArtifactSha256(artifact: AutopilotAuthorityArtifact): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(authorityArtifactBytes(artifact), 'utf8').digest('hex')}`;
}

export function authorityArtifactPath(runtimeRoot: string, artifact: Pick<AutopilotAuthorityArtifact, 'unit_id' | 'role' | 'attempt'>): string {
  return join(runtimeRoot, 'authority', `${artifact.unit_id}.${artifact.role}.attempt-${String(artifact.attempt)}.json`);
}

/** Persist once or prove byte-equivalent canonical authority on replay. */
export async function persistAutopilotAuthority(runtimeRoot: string, artifact: AutopilotAuthorityArtifact): Promise<{ readonly path: string; readonly sha256: `sha256:${string}` }> {
  const path = authorityArtifactPath(runtimeRoot, artifact);
  const bytes = authorityArtifactBytes(artifact);
  const sha256 = authorityArtifactSha256(artifact);
  if (existsSync(path)) {
    const existingBytes = await readFile(path, 'utf8');
    parseAutopilotAuthority(JSON.parse(existingBytes) as unknown);
    const existingSha = `sha256:${createHash('sha256').update(existingBytes, 'utf8').digest('hex')}`;
    if (existingBytes !== bytes || existingSha !== sha256) fail('authority-artifact-drift', 'persisted authority bytes differ from current canonical derivation; create a new attempt instead of silently changing authority', [path, `existing=${existingSha}`, `derived=${sha256}`]);
    return { path, sha256 };
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    // rename() replaces an existing destination on POSIX, so it cannot enforce
    // immutable first-writer-wins evidence. A same-directory hard link is an
    // atomic no-replace publication; concurrent non-equivalent writers fail
    // closed instead of overwriting one another.
    try { await link(temporary, path); }
    catch (error) {
      if (!existsSync(path)) throw error;
      const existingBytes = await readFile(path, 'utf8');
      parseAutopilotAuthority(JSON.parse(existingBytes) as unknown);
      const existingSha = `sha256:${createHash('sha256').update(existingBytes, 'utf8').digest('hex')}`;
      if (existingBytes !== bytes || existingSha !== sha256) fail('authority-artifact-drift', 'concurrent authority publication differs from immutable persisted authority; create a new attempt', [path, `existing=${existingSha}`, `derived=${sha256}`]);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { path, sha256 };
}

export function parseAutopilotAuthority(value: unknown): AutopilotAuthorityArtifact {
  const row = record(value, 'authority artifact');
  exactKeys(row, ['attempt', 'base_commit', 'edit_intentions', 'exclusives', 'observations', 'role', 'schema_version', 'unit_id', 'workstream'], 'authority artifact');
  if (row['schema_version'] !== AUTOPILOT_AUTHORITY_SCHEMA) fail('invalid-authority-artifact', `schema_version must equal ${AUTOPILOT_AUTHORITY_SCHEMA}`);
  const role = text(row, 'role');
  if (!['strategy', 'implement', 'validate', 'fix', 'adjudicate', 'bughunt', 'extract'].includes(role)) fail('invalid-authority-artifact', 'authority role is invalid');
  const baseCommit = text(row, 'base_commit');
  if (!/^[a-f0-9]{40,64}$/u.test(baseCommit)) fail('invalid-authority-artifact', 'authority base_commit is invalid');
  const observations = array(row, 'observations').map(parseObservation);
  const editIntentions = array(row, 'edit_intentions').map(parseEditIntent);
  const exclusives = array(row, 'exclusives').map(parseExclusive);
  if (observations.length + editIntentions.length + exclusives.length > AUTOPILOT_AUTHORITY_PATH_LIMIT) fail('invalid-authority-artifact', 'authority artifact exceeds the total bounded path limit');
  if (observations.some((observation) => observation.source_identity.base_commit !== baseCommit)) fail('invalid-authority-artifact', 'every observation must bind the authority artifact base_commit');
  const artifact: AutopilotAuthorityArtifact = {
    schema_version: AUTOPILOT_AUTHORITY_SCHEMA,
    workstream: text(row, 'workstream'),
    unit_id: text(row, 'unit_id'),
    attempt: integer(row, 'attempt', 1),
    role: role as AutopilotUnitSpec['role'],
    base_commit: baseCommit,
    observations: Object.freeze(observations.sort(authorityPathOrder)),
    edit_intentions: Object.freeze(editIntentions.sort(authorityPathOrder)),
    exclusives: Object.freeze(exclusives.sort(authorityPathOrder)),
  };
  const identities = [...artifact.observations.map((entry) => `READ\0${entry.path}`), ...artifact.edit_intentions.map((entry) => `WRITE\0${entry.path}`), ...artifact.exclusives.map((entry) => `EXCLUSIVE\0${entry.path}`)];
  if (new Set(identities).size !== identities.length) fail('invalid-authority-artifact', 'authority artifact contains duplicate mode/path entries');
  if (artifact.observations.some((observation) => artifact.edit_intentions.some((entry) => authorityCoversPath(entry.path, observation.path)))) fail('invalid-authority-artifact', 'authority artifact duplicates an observation beneath edit authority');
  if (artifact.observations.some((observation) => artifact.exclusives.some((exclusive) => pathsOverlap(observation.path, exclusive.path)))) fail('invalid-authority-artifact', 'authority artifact overlaps observation and EXCLUSIVE authority');
  if (artifact.exclusives.length > 1) fail('invalid-authority-artifact', 'authority artifact may contain at most one EXCLUSIVE critical operation');
  for (const exclusive of artifact.exclusives) {
    if (!artifact.edit_intentions.some((edit) => edit.path === exclusive.path)) fail('invalid-authority-artifact', 'EXCLUSIVE authority must layer over an exact WRITE intention');
    if (artifact.edit_intentions.some((edit) => edit.path !== exclusive.path && pathsOverlap(edit.path, exclusive.path))) fail('invalid-authority-artifact', 'EXCLUSIVE authority cannot partially overlap a broader or narrower WRITE intention');
  }
  return Object.freeze(artifact);
}

export function materializationRowsForAuthority(artifact: AutopilotAuthorityArtifact): readonly { readonly path: string; readonly claim_type: 'READ' | 'WRITE' | 'EXCLUSIVE'; readonly reason: string }[] {
  return Object.freeze([
    ...artifact.observations.map((entry) => ({ path: entry.path, claim_type: 'READ' as const, reason: entry.purpose })),
    ...artifact.edit_intentions.map((entry) => ({ path: entry.path, claim_type: 'WRITE' as const, reason: entry.purpose })),
    ...artifact.exclusives.map((entry) => ({ path: entry.path, claim_type: 'EXCLUSIVE' as const, reason: entry.purpose })),
  ].sort((left, right) => `${left.claim_type}\0${left.path}`.localeCompare(`${right.claim_type}\0${right.path}`)));
}

function groundPath(scan: AutopilotTrackedTreeScan, path: string, allowFutureOwned: boolean, limits: AutopilotAuthorityDerivationLimits | undefined): GroundedPath {
  const normalized = normalizeMaterializationPath(path, 'canonical authority path');
  const base = normalized.endsWith('/**') ? normalized.slice(0, -3) : normalized;
  const entries = trackedEntriesForMaterializationPath(scan, normalized);
  const exact = entries.find((entry) => entry.path === base);
  const descendantEntries = entries.filter((entry) => entry.path !== base);
  let scope: AutopilotAuthorityScope;
  if (exact?.object_type === 'blob' || exact?.object_type === 'commit') scope = 'tracked-file';
  else if (entries.length > 0) scope = normalized.endsWith('/**') ? 'tracked-subtree' : 'tracked-directory';
  else {
    if (!allowFutureOwned) fail('untracked-observation', 'observation/context/witness authority must resolve to a tracked file or directory at the exact worktree commit', [normalized, scan.head_sha]);
    assertFutureOwnedPathGrounded(scan, normalized);
    scope = normalized.endsWith('/**') ? 'future-owned-directory' : inferFutureScope(normalized);
  }
  const fileEntries = (exact?.object_type === 'blob' || exact?.object_type === 'commit' ? [exact] : descendantEntries).filter((entry) => entry.object_type === 'blob' || entry.object_type === 'commit');
  const trackedFileCount = fileEntries.length;
  const trackedByteCount = fileEntries.reduce((sum, entry) => sum + entry.byte_count, 0);
  if (scope === 'tracked-directory' || scope === 'tracked-subtree') {
    const maxFiles = limits?.maxBroadTrackedFiles ?? AUTOPILOT_AUTHORITY_BROAD_FILE_LIMIT;
    const maxBytes = limits?.maxBroadTrackedBytes ?? AUTOPILOT_AUTHORITY_BROAD_BYTE_LIMIT;
    if (trackedFileCount > maxFiles || trackedByteCount > maxBytes) fail('broad-authority-cap', 'directory authority exceeds the bounded tracked scope cap; split the unit into narrower mechanically grounded surfaces', [normalized, `files=${String(trackedFileCount)}/${String(maxFiles)}`, `bytes=${String(trackedByteCount)}/${String(maxBytes)}`]);
  }
  return { path: normalized, scope, entries, trackedFileCount, trackedByteCount };
}

function assertFutureOwnedPathGrounded(scan: AutopilotTrackedTreeScan, path: string): void {
  const base = path.replace(/\/\*\*$/u, '');
  const segments = base.split('/');
  for (const segment of segments) {
    if (/\s/u.test(segment) || /[\u0000-\u001f\u007f]/u.test(segment)) fail('invalid-future-owned-path', 'future-owned authority contains whitespace/control prose rather than a bounded repository path', [path]);
  }
  const parent = dirname(base).replace(/\\/gu, '/');
  if (parent === '.' || parent.length === 0) return;
  let ancestor = parent;
  while (ancestor !== '.' && ancestor.length > 0) {
    if (scan.entries.some((entry) => entry.path === ancestor)) fail('ungrounded-future-owned-path', 'future-owned edit authority cannot create descendants beneath a tracked file or submodule', [path, `non-directory-ancestor=${ancestor}`, scan.head_sha]);
    if (scan.entries.some((entry) => entry.path.startsWith(`${ancestor}/`))) return;
    ancestor = dirname(ancestor).replace(/\\/gu, '/');
  }
  fail('ungrounded-future-owned-path', 'future-owned edit authority requires an existing tracked ancestor directory (or an explicit top-level path)', [path, `parent=${parent}`, scan.head_sha]);
}

function inferFutureScope(path: string): 'future-owned-file' | 'future-owned-directory' {
  const base = path.replace(/\/\*\*$/u, '');
  const last = base.split('/').at(-1) ?? '';
  return last.includes('.') ? 'future-owned-file' : 'future-owned-directory';
}

function parseObservation(value: unknown): AutopilotObservationAuthority {
  const row = record(value, 'observation authority');
  exactKeys(row, ['path', 'purpose', 'scope', 'source_identity', 'sources', 'tracked_byte_count', 'tracked_file_count'], 'observation authority');
  const scope = trackedScope(row['scope'], 'observation authority');
  const sources = stringArray(row, 'sources').map((source) => {
    if (!isObservationSource(source)) fail('invalid-authority-artifact', `invalid observation source ${source}`);
    return source;
  });
  if (sources.length === 0 || new Set(sources).size !== sources.length) fail('invalid-authority-artifact', 'observation sources must be non-empty and unique');
  const source = record(row['source_identity'], 'observation source identity');
  exactKeys(source, ['base_commit', 'object_id', 'object_kind'], 'observation source identity');
  const baseCommit = text(source, 'base_commit');
  const objectId = text(source, 'object_id');
  const kind = text(source, 'object_kind');
  if (!/^[a-f0-9]{40,64}$/u.test(baseCommit) || !/^[a-f0-9]{40,64}$/u.test(objectId) || (kind !== 'blob' && kind !== 'tree')) fail('invalid-authority-artifact', 'observation source identity must bind an exact tracked blob or tree');
  return { path: normalizeMaterializationPath(text(row, 'path')), purpose: boundedText(row, 'purpose', 512), sources: Object.freeze(sortedUnique(sources)), scope, tracked_file_count: integer(row, 'tracked_file_count', 0), tracked_byte_count: integer(row, 'tracked_byte_count', 0), source_identity: { base_commit: baseCommit, object_id: objectId, object_kind: kind } };
}

function parseEditIntent(value: unknown): AutopilotEditIntentAuthority {
  const row = record(value, 'edit intention authority');
  exactKeys(row, ['path', 'purpose', 'scope', 'sources', 'tracked_byte_count', 'tracked_file_count'], 'edit intention authority');
  const sources = stringArray(row, 'sources');
  if (sources.length !== 1 || sources[0] !== 'owned-path') fail('invalid-authority-artifact', 'edit intention source must be owned-path');
  return { path: normalizeMaterializationPath(text(row, 'path')), purpose: boundedText(row, 'purpose', 512), sources: Object.freeze(['owned-path']), scope: authorityScope(row['scope'], 'edit intention authority'), tracked_file_count: integer(row, 'tracked_file_count', 0), tracked_byte_count: integer(row, 'tracked_byte_count', 0) };
}

function parseExclusive(value: unknown): AutopilotExclusiveAuthority {
  const row = record(value, 'exclusive authority');
  exactKeys(row, ['critical_section', 'operation', 'path', 'purpose', 'scope', 'sources', 'tracked_byte_count', 'tracked_file_count'], 'exclusive authority');
  const sources = stringArray(row, 'sources');
  if (sources.length !== 1 || sources[0] !== 'runtime-exclusive') fail('invalid-authority-artifact', 'exclusive source must be runtime-exclusive');
  if (row['scope'] !== 'tracked-file' || integer(row, 'tracked_file_count', 0) !== 1) fail('invalid-authority-artifact', 'exclusive authority must bind one exact tracked file');
  let operation: CoordinationExclusiveOperation;
  try {
    operation = parseCoordinationExclusiveOperation(row['operation'], 'exclusive authority operation');
  } catch (error) {
    fail('invalid-authority-artifact', error instanceof Error ? error.message : 'exclusive operation is invalid');
  }
  const criticalSection = text(row, 'critical_section');
  if (operation.operation_kind === 'legacy-migration-exclusive' || criticalSection !== operation.critical_section) fail('invalid-authority-artifact', 'exclusive critical_section differs from its closed runtime operation');
  const path = normalizeMaterializationPath(text(row, 'path'));
  if (path.endsWith('/**') || path.endsWith('/')) fail('invalid-authority-artifact', 'exclusive path must be exact');
  return { path, purpose: boundedText(row, 'purpose', 512), sources: Object.freeze(['runtime-exclusive']), scope: 'tracked-file', tracked_file_count: 1, tracked_byte_count: integer(row, 'tracked_byte_count', 0), operation, critical_section: operation.operation_kind };
}

function authorityScope(value: unknown, label: string): AutopilotAuthorityScope {
  if (value === 'tracked-file' || value === 'tracked-directory' || value === 'tracked-subtree' || value === 'future-owned-file' || value === 'future-owned-directory') return value;
  fail('invalid-authority-artifact', `${label} scope is invalid`);
}

function trackedScope(value: unknown, label: string): 'tracked-file' | 'tracked-directory' | 'tracked-subtree' {
  const scope = authorityScope(value, label);
  return requireTrackedScope(scope);
}

function requireTrackedScope(scope: AutopilotAuthorityScope): 'tracked-file' | 'tracked-directory' | 'tracked-subtree' {
  if (scope === 'future-owned-file' || scope === 'future-owned-directory') fail('invalid-authority-artifact', 'observation/exclusive authority cannot use a future-owned scope');
  return scope;
}

function repositoryHead(cwd: string): string {
  const head = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: 'HEAD', verify: true }, cwd }).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(head)) fail('invalid-base-commit', 'authority derivation could not verify the final repository HEAD', [cwd]);
  return head;
}

function authorityPurpose(grouped: readonly AuthorityCandidate[], path: string): string {
  const purpose = sortedUnique(grouped.map((candidate) => candidate.purpose)).join('; ');
  if (purpose.length > 512) fail('authority-purpose-cap', 'combined canonical authority purpose exceeds the coordinator contract; remove duplicate prose or split the unit', [path, `length=${String(purpose.length)}`, 'cap=512']);
  return purpose;
}

function append(map: Map<string, AuthorityCandidate[]>, key: string, value: AuthorityCandidate): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function authorityCoversPath(authority: string, path: string): boolean {
  return pathMatchesMaterializationPattern(path, authority);
}

function pathsOverlap(left: string, right: string): boolean {
  return authorityCoversPath(left, right) || authorityCoversPath(right, left);
}

function isRuntimeRepoPath(path: string, workstream: string): boolean {
  const runtime = `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${workstream}`;
  return pathsOverlap(path, runtime);
}

function witnessesFromVerificationPlan(plan: AutopilotVerificationPlan | undefined): readonly AutopilotWitnessSpec[] {
  if (plan === undefined) return [];
  return Object.freeze([...plan.positive_witnesses, ...plan.negative_witnesses, ...plan.regression_witnesses, ...plan.real_boundary_witnesses, ...plan.blast_radius_checks, ...plan.docs_schema_prompt_checks, ...plan.dirty_tree_checks]);
}

function isObservationSource(source: string): source is 'read-only-path' | 'context-ref' | 'verification-inspection-target' {
  return source === 'read-only-path' || source === 'context-ref' || source === 'verification-inspection-target';
}

function authorityPathOrder<T extends { readonly path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function authorityArtifactBytes(artifact: AutopilotAuthorityArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('invalid-authority-artifact', `${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(row: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail('invalid-authority-artifact', `${label} has unknown or missing fields`, actual);
}

function text(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) fail('invalid-authority-artifact', `${key} must be bounded non-empty text`);
  return value;
}

function boundedText(row: Readonly<Record<string, unknown>>, key: string, maximum: number): string {
  const value = text(row, key);
  if (value.length > maximum) fail('invalid-authority-artifact', `${key} exceeds ${String(maximum)} characters`);
  return value;
}

function integer(row: Readonly<Record<string, unknown>>, key: string, minimum: number): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('invalid-authority-artifact', `${key} must be an integer >= ${String(minimum)}`);
  return value;
}

function array(row: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = row[key];
  if (!Array.isArray(value) || value.length > AUTOPILOT_AUTHORITY_PATH_LIMIT) fail('invalid-authority-artifact', `${key} must be a bounded array`);
  return value;
}

function stringArray(row: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const values = array(row, key);
  if (!values.every((value) => typeof value === 'string')) fail('invalid-authority-artifact', `${key} must contain only strings`);
  return values as readonly string[];
}
