import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../names.ts';
import type { ProcessEnvLike } from '../parallel-runtime.ts';
import { parseAutopilotReceipt, parseAutopilotState, parseAutopilotUnitSpec } from '../contracts/index.ts';
import { runGitMutation, runGitQuery } from '../git-process.ts';
import { canonicalJson } from './canonical-json.ts';
import { CoordinatorClient } from './client.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun, parseCoordinationRunResource } from './contracts.ts';
import { parseD65ContinuationEvent, parseD65ParentLoss } from './d65-continuation.ts';
import { parseD65SubscriptionProbe } from './d65-launch-policy.ts';
import { readImmutableFileBytes } from './immutable-file.ts';
import { assertD65RecoveryBoundaryFromEnvironment, ensureD65ProgramHeartbeatForGraphFromEnvironment } from './d65-runtime-dispatch.ts';
import { canonicalSha256 } from './d65-semantic-graph.ts';
import { prepareD65CoordinatorOnlySuccessor, prepareD65FirstCompleteGraphPublication } from './d65-graph-successor.ts';
import { createD65GraphGitOps, createD65GraphPublicationStoreGateway } from './d65-graph-runtime.ts';
import { publishD65CompleteGraph, type D65GraphPathManifestRow } from './d65-graph-publisher.ts';
import { decodeUnpaddedBase64Url, encodeUnpaddedBase64Url } from './d65-trust.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { readCoordinatorSessionContext } from './supervisor.ts';

function gitText(cwd: string, descriptor: Parameters<typeof runGitQuery>[0]['descriptor'], label: string): string {
  const result = runGitQuery({ cwd, descriptor });
  const value = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim();
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new CoordinationRuntimeError('invalid-state', `${label} did not resolve to one full 40-hex Git object id`, [value]);
  return value;
}

async function cleanupIsolatedIndex(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new CoordinationRuntimeError('invalid-state', 'D65 graph isolated index cleanup refuses a non-regular or aliased path', [path]);
  await unlink(path);
  if (existsSync(path)) throw new CoordinationRuntimeError('invalid-state', 'D65 graph isolated index remained after cleanup', [path]);
}

const D65_FIRST_GRAPH_CORE_FILENAMES = Object.freeze(['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl'] as const);

function standardBase64(pathText: string): string {
  return encodeUnpaddedBase64Url(new TextEncoder().encode(pathText)).replace(/-/gu, '+').replace(/_/gu, '/');
}

/**
 * Publish the exact FIRST complete graph (sequence 2) through the full
 * production saga. Preconditions: the bootstrap charter is complete through the
 * initial governing heartbeat; parent planning has written exactly the five
 * previously absent core charter files into the run-main worktree; run-main
 * HEAD is the accepted one-parent policy commit. The publisher then creates G
 * (sole parent = policy commit; diff = exactly the five core paths), graph-only
 * H, registers R against the bootstrap prior tuple, and finalizes run-main to H.
 */
export async function publishD65FirstCompleteGraphFromEnvironment(input: { readonly env?: ProcessEnvLike; readonly createdAt?: string } = {}): Promise<Readonly<{ graphSha256: `sha256:${string}`; publicationCommit: string; registrationEventSeq: number; graphSequence: number }>> {
  const env = input.env ?? process.env;
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('invalid-state', 'D65 first graph publication requires a durable coordinator session context');
  const session = await readCoordinatorSessionContext(contextPath);
  const client = new CoordinatorClient({ env });
  const createdAt = input.createdAt ?? new Date().toISOString();
  const prepared = await prepareD65FirstCompleteGraphPublication({ client, session, createdAt });
  const mainWorktreePath = prepared.mainWorktreePath;
  const isolatedIndexPath = join(dirname(mainWorktreePath), `_graph-publication-${String(prepared.graphSequence).padStart(20, '0')}.index`);
  const git = createD65GraphGitOps({ repoRoot: mainWorktreePath, isolatedIndexPath });
  try {
    // Seal the exact five-core-path manifest from the parent-planning postimage
    // bytes in the run-main worktree. Every path must be previously absent at
    // the policy commit (the publisher's manifest preimage proof enforces it).
    const manifestRows: D65GraphPathManifestRow[] = D65_FIRST_GRAPH_CORE_FILENAMES.map((name) => {
      const ref = `${prepared.runtimePrefix}/${name}`;
      const absolute = join(mainWorktreePath, ...ref.split('/'));
      let bytes: Uint8Array;
      try { bytes = readFileSync(absolute); }
      catch (error) { throw new CoordinationRuntimeError('invalid-state', 'first graph publication requires the exact parent-planning core postimage file', [ref, error instanceof Error ? error.message : String(error)]); }
      const oid = git.hashObject(bytes);
      return Object.freeze({ path_b64: standardBase64(ref), pre_exists: false, pre_mode: null, pre_type: null, pre_oid: null, post_exists: true, post_mode: '100644', post_type: 'blob', post_oid: oid });
    }).sort((left, right) => compareBase64Paths(left.path_b64, right.path_b64));
    const publicationIdentity = { schema: 'd65-graph-publication-id.v1', program_id: prepared.programId, repo_id: prepared.repoId, workstream_run: prepared.workstreamRun, graph_sequence: prepared.graphSequence, prior_graph_sha256: prepared.priorGraphSha256, prior_publication_commit: null, prior_registration_event_seq: prepared.priorRegistrationEventSeq, covered_event_seq: prepared.coveredEventSeq };
    const publicationId = `publication:${createHash('sha256').update(`${canonicalJson(publicationIdentity)}\n`, 'utf8').digest('hex')}`;
    const policyTree = git.resolveTree(prepared.policyCommit);
    const result = await publishD65CompleteGraph({
      mainWorktreePath,
      buildGraph: prepared.buildGraph,
      plan: {
        publicationId,
        programId: prepared.programId,
        repoId: prepared.repoId,
        autopilotId: prepared.autopilotId,
        workstreamRun: prepared.workstreamRun,
        graphSequence: prepared.graphSequence,
        priorAuthorityKind: 'bootstrap',
        priorGraphSha256: prepared.priorGraphSha256,
        priorPublicationCommit: null,
        priorRegistrationEventSeq: prepared.priorRegistrationEventSeq,
        authorityBaseCommit: prepared.policyCommit,
        authorityRef: prepared.authorityRef,
        authorityBaseTree: policyTree,
        authorityPathManifest: Object.freeze(manifestRows),
        authorityPathManifestSha256: canonicalSha256(manifestRows),
        coveredEventSeq: prepared.coveredEventSeq,
        now: () => new Date().toISOString(),
      },
      git,
      store: createD65GraphPublicationStoreGateway({ client, session }),
    });
    return Object.freeze({ ...result, graphSequence: prepared.graphSequence });
  } finally {
    await cleanupIsolatedIndex(isolatedIndexPath);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function persistExactPrivateAuthorityFile(authorityRoot: string, path: string, bytes: Uint8Array, label: string): Promise<void> {
  const lexicalRoot = resolve(authorityRoot);
  const lexicalPath = resolve(path);
  const rel = relative(lexicalRoot, lexicalPath);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CoordinationRuntimeError('unauthorized-client', `${label} path escapes run-main authority`, [path, authorityRoot]);
  await mkdir(dirname(lexicalPath), { recursive: true, mode: 0o700 });
  const rootReal = realpathSync(lexicalRoot);
  const parentReal = realpathSync(dirname(lexicalPath));
  if (parentReal !== resolve(rootReal, dirname(rel))) throw new CoordinationRuntimeError('unauthorized-client', `${label} parent path contains an aliased or escaping segment`, [path, parentReal]);
  if (!existsSync(path)) {
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code !== 'EEXIST') throw new CoordinationRuntimeError('invalid-state', `${label} could not be exclusively created`, [path, error instanceof Error ? error.message : String(error)]);
    }
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new CoordinationRuntimeError('invalid-state', `${label} must remain a one-link no-follow regular mode-0600 file`, [path, `mode=${(metadata.mode & 0o777).toString(8)}`, `nlink=${String(metadata.nlink)}`]);
  const existing = readImmutableFileBytes({ path, maximumBytes: 1_048_576, label });
  if (!equalBytes(existing, bytes)) throw new CoordinationRuntimeError('idempotency-conflict', `${label} already exists with different immutable bytes`, [path]);
}

interface D65BoundRecoveryFile {
  readonly ref: string;
  readonly bytes: Uint8Array;
  readonly mutable: boolean;
}

function persistExactMutableAuthorityFile(authorityRoot: string, path: string, bytes: Uint8Array, label: string): void {
  const lexicalRoot = resolve(authorityRoot);
  const lexicalPath = resolve(path);
  const rel = relative(lexicalRoot, lexicalPath);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CoordinationRuntimeError('unauthorized-client', `${label} path escapes run-main authority`, [path, authorityRoot]);
  const rootReal = realpathSync(lexicalRoot);
  const parentReal = realpathSync(dirname(lexicalPath));
  if (parentReal !== resolve(rootReal, dirname(rel))) throw new CoordinationRuntimeError('unauthorized-client', `${label} parent path contains an aliased or escaping segment`, [path, parentReal]);
  const before = lstatSync(lexicalPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || ((before.mode & 0o777) !== 0o600 && (before.mode & 0o777) !== 0o644)) throw new CoordinationRuntimeError('invalid-state', `${label} must be a one-link no-follow regular authority file`, [path]);
  const temporary = `${lexicalPath}.d65-recovery.tmp`;
  if (existsSync(temporary)) {
    const residue = lstatSync(temporary);
    if (!residue.isFile() || residue.isSymbolicLink() || residue.nlink !== 1) throw new CoordinationRuntimeError('invalid-state', `${label} temporary residue is unsafe`, [temporary]);
    const residueBytes = readImmutableFileBytes({ path: temporary, maximumBytes: 1_048_576, label: `${label} temporary residue` });
    if (!equalBytes(residueBytes, bytes)) throw new CoordinationRuntimeError('idempotency-conflict', `${label} temporary residue contains different bytes`, [temporary]);
    unlinkSync(temporary);
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), before.mode & 0o777);
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.byteLength) throw new CoordinationRuntimeError('invalid-state', `${label} temporary write postcondition failed`, [temporary]);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  renameSync(temporary, lexicalPath);
  const parentDescriptor = openSync(parentReal, fsConstants.O_RDONLY);
  try { fsyncSync(parentDescriptor); } finally { closeSync(parentDescriptor); }
  const persisted = readImmutableFileBytes({ path: lexicalPath, maximumBytes: 1_048_576, label });
  if (!equalBytes(persisted, bytes)) throw new CoordinationRuntimeError('invalid-state', `${label} persisted bytes differ after atomic replacement`, [path]);
}

async function commitAndRegisterD65RecoveryArtifact(input: {
  readonly client: CoordinatorClient;
  readonly session: Awaited<ReturnType<typeof readCoordinatorSessionContext>>;
  readonly resource: ReturnType<typeof parseCoordinationRunResource>;
  readonly env: ProcessEnvLike;
  readonly artifactId: string;
  readonly schema: 'autopilot.parent_loss.v1' | 'autopilot.continuation_event.v1' | 'autopilot.subscription_probe.v1';
  readonly ref: string;
  readonly bytes: Uint8Array;
  readonly boundFiles?: readonly D65BoundRecoveryFile[];
  readonly message: string;
  readonly commitDate: string;
}): Promise<void> {
  const digest = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}` as `sha256:${string}`;
  const status = await input.client.query('status', input.session.repo_id, input.session.workstream_run);
  const rawArtifacts = status.payload['authoritative_artifacts'];
  const rawRuns = status.payload['runs'];
  if (!Array.isArray(rawArtifacts) || !Array.isArray(rawRuns) || rawRuns.length !== 1 || rawRuns[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 recovery artifact stage lacks exact run/artifact projections');
  const artifacts = rawArtifacts.map(parseCoordinationAuthoritativeArtifact).filter((artifact) => artifact.artifact_id === input.artifactId);
  if (artifacts.length > 1) throw new CoordinationRuntimeError('invalid-state', 'D65 recovery artifact identity is duplicated', [input.artifactId]);
  const boundFiles = input.boundFiles ?? Object.freeze([]);
  const allFiles = [{ ref: input.ref, bytes: input.bytes, mutable: false }, ...boundFiles];
  const refs = allFiles.map((entry) => entry.ref);
  if (new Set(refs).size !== refs.length) throw new CoordinationRuntimeError('invalid-request', 'D65 recovery artifact bound file refs must be unique', refs);
  const accepted = artifacts[0];
  if (accepted !== undefined) {
    if (accepted.source_type !== 'task' || accepted.source_scope !== 'run-main' || accepted.document_schema_version !== input.schema || accepted.evidence.ref !== input.ref || accepted.evidence.sha256 !== digest) throw new CoordinationRuntimeError('idempotency-conflict', 'accepted D65 recovery artifact differs from the resumed exact stage', [input.artifactId]);
    for (const file of allFiles) {
      const committedBytes = runGitQuery({ cwd: input.resource.main_worktree_path, descriptor: { kind: 'show-file', revision: accepted.git_commit, path: file.ref } }).stdout;
      if (!equalBytes(committedBytes, file.bytes)) throw new CoordinationRuntimeError('invalid-state', 'accepted D65 recovery artifact Git bytes differ from its resumed exact bound stage', [input.artifactId, file.ref]);
    }
    return;
  }
  for (const file of allFiles) {
    const absolute = join(input.resource.main_worktree_path, ...file.ref.split('/'));
    if (file.mutable) persistExactMutableAuthorityFile(input.resource.main_worktree_path, absolute, file.bytes, `${input.schema} mutable bound authority`);
    else if (existsSync(absolute)) {
      const existing = readImmutableFileBytes({ path: absolute, maximumBytes: 1_048_576, label: `${input.schema} bound authority` });
      if (!equalBytes(existing, file.bytes)) throw new CoordinationRuntimeError('idempotency-conflict', 'D65 immutable bound authority file already exists with different bytes', [file.ref]);
    } else await persistExactPrivateAuthorityFile(input.resource.main_worktree_path, absolute, file.bytes, input.schema);
  }
  let head = gitText(input.resource.main_worktree_path, { kind: 'head' }, `${input.schema} HEAD`);
  const changedRefs = allFiles.filter((file) => {
    const tracked = runGitQuery({ cwd: input.resource.main_worktree_path, descriptor: { kind: 'show-file', revision: head, path: file.ref, allowAbsent: true } });
    return tracked.negative || !equalBytes(tracked.stdout, file.bytes);
  }).map((file) => file.ref);
  if (changedRefs.length > 0) {
    if (!changedRefs.includes(input.ref)) throw new CoordinationRuntimeError('idempotency-conflict', 'D65 recovery bound files changed without the immutable primary artifact path', changedRefs);
    if (runGitQuery({ cwd: input.resource.main_worktree_path, descriptor: { kind: 'staged-clean' } }).negative) throw new CoordinationRuntimeError('invalid-state', 'D65 recovery artifact refuses to commit over a nonempty shared index', refs);
    const gitEnv: ProcessEnvLike = { ...input.env, GIT_AUTHOR_NAME: 'autopilot-runtime', GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid', GIT_COMMITTER_NAME: 'autopilot-runtime', GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid', GIT_AUTHOR_DATE: input.commitDate, GIT_COMMITTER_DATE: input.commitDate };
    const staged = await runGitMutation({ cwd: input.resource.main_worktree_path, descriptor: { kind: 'stage-paths', paths: changedRefs, sparse: true }, env: gitEnv });
    if (staged.kind !== 'reported' || staged.exitCode !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 recovery artifact staging failed', [staged.kind === 'reported' ? staged.diagnostic : staged.reason]);
    const committed = await runGitMutation({ cwd: input.resource.main_worktree_path, descriptor: { kind: 'commit', message: input.message }, env: gitEnv });
    if (committed.kind !== 'reported' || committed.exitCode !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 recovery artifact commit failed', [committed.kind === 'reported' ? committed.diagnostic : committed.reason]);
    head = gitText(input.resource.main_worktree_path, { kind: 'head' }, `${input.schema} committed HEAD`);
  }
  for (const file of allFiles) {
    const tracked = runGitQuery({ cwd: input.resource.main_worktree_path, descriptor: { kind: 'show-file', revision: head, path: file.ref, allowAbsent: true } });
    if (tracked.negative || !equalBytes(tracked.stdout, file.bytes)) throw new CoordinationRuntimeError('idempotency-conflict', 'current HEAD does not contain exact D65 recovery bound bytes', [file.ref]);
  }
  const run = parseCoordinationRun(rawRuns[0]);
  const response = await input.client.mutate('register-authoritative-artifact', { repoId: input.session.repo_id, workstreamRun: input.session.workstream_run, sessionId: input.session.session_id, fencingGeneration: input.session.session_generation, expectedVersion: run.version, idempotencyKey: `register-recovery-artifact:${input.artifactId}:${digest}` }, {
    artifact_id: input.artifactId, source_type: 'task', source_scope: 'run-main', document_schema_version: input.schema, git_commit: head, ref: input.ref, sha256: digest, session_lease_id: input.session.session_lease_id, session_token: input.session.session_token,
  });
  const registered = parseCoordinationAuthoritativeArtifact(response.payload['authoritative_artifact']);
  if (registered.artifact_id !== input.artifactId || registered.git_commit !== head || registered.evidence.ref !== input.ref || registered.evidence.sha256 !== digest) throw new CoordinationRuntimeError('invalid-state', 'D65 recovery artifact registration response differs from the exact committed stage', [input.artifactId]);
}

/**
 * The frozen parent-loss recovery cadence after the exact-once sealed-candidate
 * attach (fresh plan §3.1 parent-loss row): while dispatch remains false the
 * successor session first publishes the attach-only graph, then byte-
 * identically commits/registers the parent-loss artifact at
 * `authority/continuation/<20-digit-sequence>-parent-loss.json` and publishes
 * its graph, then (separately) the continuation event follows the same commit/
 * register/graph edge. Each step is one frozen recovery edge; each graph is the
 * exact one-event successor; each requires a governing heartbeat before the
 * next edge. This driver performs NO model call, product mutation, or new-work
 * claim; a missing candidate or any digest divergence fails loudly.
 */
export async function driveD65ParentLossRecoveryFromEnvironment(input: { readonly env?: ProcessEnvLike; readonly continuationSequence?: number; readonly expectedCandidateSha256: `sha256:${string}` }): Promise<void> {
  const env = input.env ?? process.env;
  const sequence = input.continuationSequence ?? 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new CoordinationRuntimeError('invalid-request', 'D65 parent-loss continuation sequence must be a positive safe integer');
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('invalid-state', 'D65 parent-loss recovery requires a durable coordinator session context');
  const session = await readCoordinatorSessionContext(contextPath);
  const client = new CoordinatorClient({ env });
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const resources = status.payload['run_resources'];
  const rawArtifacts = status.payload['authoritative_artifacts'];
  if (!Array.isArray(resources) || resources.length !== 1 || resources[0] === undefined || !Array.isArray(rawArtifacts)) throw new CoordinationRuntimeError('invalid-state', 'parent-loss recovery lacks one exact run resource/artifact projection');
  const resource = parseCoordinationRunResource(resources[0]);
  const policyArtifact = rawArtifacts.map(parseCoordinationAuthoritativeArtifact).find((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
  if (policyArtifact === undefined) throw new CoordinationRuntimeError('invalid-state', 'parent-loss recovery requires the accepted launch policy');
  const policyBytes = runGitQuery({ cwd: resource.main_worktree_path, descriptor: { kind: 'show-file', revision: policyArtifact.git_commit, path: policyArtifact.evidence.ref } }).stdout;
  const policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(policyBytes)) as Record<string, unknown>;
  const evidenceRoot = policy['program_evidence_root'];
  if (typeof evidenceRoot !== 'string') throw new CoordinationRuntimeError('invalid-state', 'accepted policy lacks its program evidence root');
  const candidatePath = join(evidenceRoot, 'parent-loss', session.workstream_run, 'candidate.json');
  const candidateBytes = readImmutableFileBytes({ path: candidatePath, maximumBytes: 1_048_576, label: 'sealed parent-loss candidate' });
  const candidateSha256 = `sha256:${createHash('sha256').update(candidateBytes).digest('hex')}` as `sha256:${string}`;
  if (candidateSha256 !== input.expectedCandidateSha256) throw new CoordinationRuntimeError('idempotency-conflict', 'sealed parent-loss candidate no longer equals the digest consumed by attach-session', [input.expectedCandidateSha256, candidateSha256]);
  const candidate = parseD65ParentLoss(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes)) as unknown);
  if (candidate.repo_id !== session.repo_id || candidate.workstream_run !== session.workstream_run || candidate.successor_session_id !== session.session_id || candidate.successor_session_lease_id !== session.session_lease_id || candidate.successor_generation !== session.session_generation || candidate.successor_pid !== session.pid || candidate.successor_boot_id !== session.boot_id) throw new CoordinationRuntimeError('invalid-state', 'sealed parent-loss candidate does not name the attached recovery session');
  const runtimePrefix = resource.runtime_root.startsWith(`${resource.main_worktree_path}/`) ? resource.runtime_root.slice(resource.main_worktree_path.length + 1) : null;
  if (runtimePrefix === null) throw new CoordinationRuntimeError('invalid-state', 'run runtime root is not a descendant of its main worktree');
  const paddedSequence = String(sequence).padStart(20, '0');
  const parentArtifactId = `parent-loss:${session.workstream_run}:${paddedSequence}`;
  const continuationArtifactId = `continuation:${session.workstream_run}:${paddedSequence}:${candidate.event_id}`;
  const acceptedIds = new Set(rawArtifacts.map(parseCoordinationAuthoritativeArtifact).map((artifact) => artifact.artifact_id));

  // 1. Settle exactly the pending recovery edge (fresh attach, parent artifact,
  // or continuation artifact) into its one-event graph, then require heartbeat.
  const attachGraph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: candidate.issued_at });
  const allowedArtifactEvent = attachGraph.semanticEventType === 'authoritative-artifact-registered' && (acceptedIds.has(parentArtifactId) || acceptedIds.has(continuationArtifactId));
  if (attachGraph.semanticEventType !== null && attachGraph.semanticEventType !== 'session-attached' && !allowedArtifactEvent) throw new CoordinationRuntimeError('invalid-state', 'parent-loss recovery settled a foreign semantic event', [attachGraph.semanticEventType]);
  await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: attachGraph.graphSequence, graphSha256: attachGraph.graphSha256, env });

  // 2. Byte-identical candidate commit/registration → graph → heartbeat.
  const parentLossRef = `${runtimePrefix}/authority/continuation/${paddedSequence}-parent-loss.json`;
  await commitAndRegisterD65RecoveryArtifact({ client, session, resource, env, artifactId: parentArtifactId, schema: 'autopilot.parent_loss.v1', ref: parentLossRef, bytes: candidateBytes, message: 'autopilot: parent-loss continuation artifact', commitDate: candidate.issued_at });
  const artifactGraph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: candidate.issued_at });
  if (artifactGraph.semanticEventType !== null && artifactGraph.semanticEventType !== 'authoritative-artifact-registered') throw new CoordinationRuntimeError('invalid-state', 'parent-loss artifact graph covered a foreign semantic event', [artifactGraph.semanticEventType]);
  await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: artifactGraph.graphSequence, graphSha256: artifactGraph.graphSha256, env });

  // 3. The continuation for the SAME incident sequence/event is a separate
  // immutable registration. On recovery, an already-accepted continuation is
  // loaded and revalidated rather than re-derived against a later graph head.
  const statusBeforeContinuation = await client.query('status', session.repo_id, session.workstream_run);
  const continuationArtifactsValue = statusBeforeContinuation.payload['authoritative_artifacts'];
  if (!Array.isArray(continuationArtifactsValue)) throw new CoordinationRuntimeError('invalid-state', 'parent-loss continuation recovery lacks artifact projection');
  const existingContinuations = continuationArtifactsValue.map(parseCoordinationAuthoritativeArtifact).filter((artifact) => artifact.artifact_id === continuationArtifactId);
  const existingContinuation = existingContinuations[0];
  if (existingContinuations.length > 1) throw new CoordinationRuntimeError('invalid-state', 'parent-loss continuation artifact identity is duplicated', [continuationArtifactId]);
  if (existingContinuation !== undefined) {
    if (existingContinuation.document_schema_version !== 'autopilot.continuation_event.v1') throw new CoordinationRuntimeError('idempotency-conflict', 'parent-loss continuation artifact id was accepted under a different schema', [continuationArtifactId]);
    const existingBytes = runGitQuery({ cwd: resource.main_worktree_path, descriptor: { kind: 'show-file', revision: existingContinuation.git_commit, path: existingContinuation.evidence.ref } }).stdout;
    const existingDigest = `sha256:${createHash('sha256').update(existingBytes).digest('hex')}`;
    const existingEvent = parseD65ContinuationEvent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(existingBytes)));
    if (existingDigest !== existingContinuation.evidence.sha256 || existingEvent.event_id !== candidate.event_id || existingEvent.event_sequence !== sequence || existingEvent.trigger !== 'parent-loss' || existingEvent.class !== 'parent-recovering' || existingEvent.session_lease_id !== session.session_lease_id || existingEvent.successor_id !== session.session_lease_id || existingEvent.evidence_refs.length !== 1 || existingEvent.evidence_refs[0]?.ref !== parentLossRef || existingEvent.evidence_refs[0]?.sha256 !== candidateSha256) throw new CoordinationRuntimeError('idempotency-conflict', 'accepted parent-loss continuation differs from the resumed incident authority', [continuationArtifactId]);
    const settled = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: candidate.issued_at });
    if (settled.graphSequence !== existingEvent.result_graph_sequence) throw new CoordinationRuntimeError('invalid-state', 'accepted parent-loss continuation result graph sequence differs from its settled graph', [String(existingEvent.result_graph_sequence), String(settled.graphSequence)]);
    await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: settled.graphSequence, graphSha256: settled.graphSha256, env });
    return;
  }
  const continuationEvent = parseD65ContinuationEvent({
    schema_version: 'autopilot.continuation_event.v1', program_id: candidate.program_id, event_id: candidate.event_id,
    event_sequence: sequence, repo_id: session.repo_id, workstream_run: session.workstream_run,
    trigger: 'parent-loss', class: 'parent-recovering', provider: null, failed_spec_ref: null, failed_receipt_ref: null,
    unit_id: null, attempt: null, session_lease_id: candidate.successor_session_lease_id, child_lease_id: null,
    observed_at: candidate.observed_at, cooldown_until: null, retry_ordinal: null, successor_id: candidate.successor_session_lease_id,
    evidence_refs: [{ ref: parentLossRef, sha256: candidateSha256, byte_count: candidateBytes.byteLength }],
    prior_graph_sha256: artifactGraph.graphSha256, result_graph_sequence: artifactGraph.graphSequence + 1, operator_decision_ref: null,
  });
  const continuationBytes = Buffer.from(`${canonicalJson(continuationEvent)}\n`, 'utf8');
  const continuationRef = `${runtimePrefix}/authority/continuation/${paddedSequence}-${continuationEvent.event_id}.json`;
  await commitAndRegisterD65RecoveryArtifact({ client, session, resource, env, artifactId: continuationArtifactId, schema: 'autopilot.continuation_event.v1', ref: continuationRef, bytes: continuationBytes, message: 'autopilot: parent-loss continuation event', commitDate: candidate.issued_at });
  const continuationGraph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: candidate.issued_at });
  if (continuationGraph.semanticEventType !== null && continuationGraph.semanticEventType !== 'authoritative-artifact-registered') throw new CoordinationRuntimeError('invalid-state', 'parent-loss continuation graph covered a foreign semantic event', [continuationGraph.semanticEventType]);
  if (continuationGraph.graphSequence !== continuationEvent.result_graph_sequence) throw new CoordinationRuntimeError('invalid-state', 'parent-loss continuation result graph sequence differs from its immutable event', [String(continuationGraph.graphSequence), String(continuationEvent.result_graph_sequence)]);
  await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: continuationGraph.graphSequence, graphSha256: continuationGraph.graphSha256, env });
}

function compareBase64Paths(left: string, right: string): number {
  const decode = (value: string): Uint8Array => {
    const bytes = decodeUnpaddedBase64Url(value.replace(/\+/gu, '-').replace(/\//gu, '_'));
    if (bytes === null) throw new CoordinationRuntimeError('invalid-state', 'first graph manifest path_b64 is not canonical base64', [value]);
    return bytes;
  };
  const leftBytes = decode(left);
  const rightBytes = decode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

/**
 * The exact crash-safe per-stage cadence for complete-mode semantic worktree
 * events (fresh plan: every semantic coordinator event requires N+1 before the
 * next semantic effect). After each accepted worktree-operation stage event the
 * saga calls this to: publish the exact one-event successor graph (or recognize
 * the already-published graph without fabricating a no-event N+1), then require
 * the externally signed governing heartbeat naming that graph. Legacy and
 * bootstrap-mode runs return without effect: bootstrap cadence is owned by the
 * frozen B→E charter matrix, never by this complete-mode path.
 */
export async function ensureD65WorktreeStageCadenceFromEnvironment(env: ProcessEnvLike = process.env): Promise<void> {
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) return; // explicit legacy classification
  const session = await readCoordinatorSessionContext(contextPath);
  const client = new CoordinatorClient({ env });
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const rawArtifacts = status.payload['authoritative_artifacts'];
  if (!Array.isArray(rawArtifacts)) throw new CoordinationRuntimeError('invalid-state', 'D65 worktree cadence classification lacks committed artifact projection');
  const artifacts = rawArtifacts.map(parseCoordinationAuthoritativeArtifact);
  const bootstrapPresent = artifacts.some((artifact) => artifact.artifact_id === `semantic-graph-bootstrap:${session.workstream_run}` && artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1');
  const completePresent = artifacts.some((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1');
  if (!bootstrapPresent) {
    if (completePresent) throw new CoordinationRuntimeError('invalid-state', 'D65 complete graph exists without the deterministic bootstrap artifact');
    return; // legacy non-D65 run
  }
  if (!completePresent) return; // bootstrap charter owns pre-first-graph cadence
  const published = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env });
  await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: published.graphSequence, graphSha256: published.graphSha256, env });
}

/**
 * Publish one coordinator-only N+1 using the exact accepted H as pre-G base.
 * This is the production consumer for semantic coordinator events whose Git
 * authority is byte-stable (notably terminal-intent preparation). It never
 * fabricates package projections: every non-coordinator member is loaded from
 * the accepted prior graph, while coordinator state is rebuilt from one exact
 * transactional export at E.
 */
export async function publishD65CoordinatorOnlySuccessorFromEnvironment(input: { readonly env?: ProcessEnvLike; readonly createdAt?: string } = {}): Promise<Readonly<{ graphSha256: `sha256:${string}`; publicationCommit: string; registrationEventSeq: number; graphSequence: number; semanticEventType: string | null }>> {
  const env = input.env ?? process.env;
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('invalid-state', 'D65 successor publication requires a durable coordinator session context');
  const session = await readCoordinatorSessionContext(contextPath);
  const client = new CoordinatorClient({ env });
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const resources = status.payload['run_resources'];
  if (!Array.isArray(resources) || resources.length !== 1 || resources[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 successor publication requires one exact run resource');
  const mainWorktreePath = parseCoordinationRunResource(resources[0]).main_worktree_path;
  const authorityBaseCommit = gitText(mainWorktreePath, { kind: 'head' }, 'D65 successor authority base HEAD');
  const authorityBaseTree = gitText(mainWorktreePath, { kind: 'resolve-tree', revision: authorityBaseCommit }, 'D65 successor authority base tree');
  const createdAt = input.createdAt ?? new Date().toISOString();
  const prepared = await prepareD65CoordinatorOnlySuccessor({ client, session, authorityBaseCommit, authorityBaseTree, createdAt });
  if (prepared.mainWorktreePath !== mainWorktreePath) throw new CoordinationRuntimeError('invalid-state', 'D65 successor export resource changed across preparation', [prepared.mainWorktreePath, mainWorktreePath]);
  if (prepared.state === 'already-current') return Object.freeze({ graphSha256: prepared.priorGraphSha256, publicationCommit: prepared.priorPublicationCommit, registrationEventSeq: prepared.priorRegistrationEventSeq, graphSequence: prepared.graphSequence, semanticEventType: null });
  const publicationIdentity = { schema: 'd65-graph-publication-id.v1', program_id: prepared.programId, repo_id: prepared.repoId, workstream_run: prepared.workstreamRun, graph_sequence: prepared.graphSequence, prior_graph_sha256: prepared.priorGraphSha256, prior_publication_commit: prepared.priorPublicationCommit, prior_registration_event_seq: prepared.priorRegistrationEventSeq, covered_event_seq: prepared.coveredEventSeq };
  const publicationId = `publication:${createHash('sha256').update(`${canonicalJson(publicationIdentity)}\n`, 'utf8').digest('hex')}`;
  const isolatedIndexPath = join(dirname(mainWorktreePath), `_graph-publication-${String(prepared.graphSequence).padStart(20, '0')}.index`);
  try {
    const result = await publishD65CompleteGraph({
      mainWorktreePath,
      buildGraph: prepared.buildGraph,
      plan: {
        publicationId,
        programId: prepared.programId,
        repoId: prepared.repoId,
        autopilotId: prepared.autopilotId,
        workstreamRun: prepared.workstreamRun,
        graphSequence: prepared.graphSequence,
        priorAuthorityKind: 'complete',
        priorGraphSha256: prepared.priorGraphSha256,
        priorPublicationCommit: prepared.priorPublicationCommit,
        priorRegistrationEventSeq: prepared.priorRegistrationEventSeq,
        authorityBaseCommit,
        authorityRef: prepared.authorityRef,
        authorityBaseTree,
        authorityPathManifest: Object.freeze([]),
        authorityPathManifestSha256: canonicalSha256([]),
        coveredEventSeq: prepared.coveredEventSeq,
        now: () => new Date().toISOString(),
      },
      git: createD65GraphGitOps({ repoRoot: mainWorktreePath, isolatedIndexPath }),
      store: createD65GraphPublicationStoreGateway({ client, session }),
    });
    return Object.freeze({ ...result, graphSequence: prepared.graphSequence, semanticEventType: prepared.semanticEventType });
  } finally {
    await cleanupIsolatedIndex(isolatedIndexPath);
  }
}

// ---- D65 subscription-failure / probe recovery saga -------------------------
//
// Frozen contract: freeze §9.4 subscription probe, continuation §3.1.
// This is the production crash-resume exact immutable-stage saga for a
// subscription failure on `retry_ordinal=0`. The exact stages are:
//
//  1. Graph the failed-attempt/child/reset event(s).
//  2. Commit/register the subscription-failure continuation event plus
//     cryptographically bound failed receipt/current state/successor spec.
//  3. Graph it.
//  4. Commit/register the correctly signed externally supplied subscription
//     probe (never self-sign operator authority).
//  5. Graph it.
//  6. Pause fail-closed until governing retry-authorized heartbeat.
//
// After step 6 the caller's `register-attempt` consumes the probe once;
// graph/projection and healthy heartbeat retain the consumed tuple.
//
// Public inputs that need immutable externally signed bytes define a narrow
// production API: `D65SubscriptionFailureRecoveryInput` requires the exact
// continuation bytes (JSON, canonical, validated by `parseD65ContinuationEvent`)
// and the exact probe bytes (JSON, canonical, validated by
// `parseD65SubscriptionProbe`). Both are validated here; neither is synthesized.

/** Narrow production API for externally supplied immutable recovery inputs. */
export interface D65SubscriptionFailureRecoveryInput {
  /** The immutable continuation-event JSON bytes (canonical + LF). */
  readonly continuationBytes: Uint8Array;
  /** The immutable, externally purpose-signed subscription-probe JSON bytes. */
  readonly probeBytes: Uint8Array;
  /** Exact bytes for continuation-bound files not already present at accepted H. */
  readonly boundAuthorityFiles: readonly Readonly<{ readonly ref: string; readonly bytes: Uint8Array }>[];
  /** The continuation sequence (≥1). */
  readonly continuationSequence: number;
}

/**
 * Drive the subscription-failure/probe recovery saga to completion through
 * crash-resume exact immutable stages. Each stage is idempotent: an
 * already-accepted artifact is revalidated against its sealed identity.
 *
 * The caller is responsible for:
 *  - the worktree reset/quarantine and its graph BEFORE calling this;
 *  - the `register-attempt` consumption AFTER this returns;
 *  - the healthy heartbeat after consumption.
 *
 * This saga never self-signs the probe: it only commits/registers the
 * externally supplied bytes whose signature is validated by the store's
 * existing `register-authoritative-artifact` transaction.
 */
export async function driveD65SubscriptionFailureRecoveryFromEnvironment(input: {
  readonly env?: ProcessEnvLike;
  readonly recovery: D65SubscriptionFailureRecoveryInput;
}): Promise<Readonly<{ readonly continuationGraphSequence: number; readonly continuationGraphSha256: `sha256:${string}`; readonly probeGraphSequence: number; readonly probeGraphSha256: `sha256:${string}` }>> {
  const env = input.env ?? process.env;
  const { continuationBytes, probeBytes, boundAuthorityFiles, continuationSequence } = input.recovery;
  if (!Number.isSafeInteger(continuationSequence) || continuationSequence < 1) throw new CoordinationRuntimeError('invalid-request', 'D65 subscription-failure continuation sequence must be a positive safe integer');
  const parseCanonical = <T>(bytes: Uint8Array, label: string, parser: (value: unknown) => T): T => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch (error) { throw new CoordinationRuntimeError('invalid-request', `${label} is not canonical UTF-8 JSON`, [error instanceof Error ? error.message : String(error)]); }
    const parsed = parser(value);
    const canonical = new TextEncoder().encode(`${canonicalJson(parsed)}\n`);
    if (!equalBytes(bytes, canonical)) throw new CoordinationRuntimeError('invalid-request', `${label} bytes are not exact RFC-8785-plus-LF encoding`);
    return parsed;
  };
  const continuation = parseCanonical(continuationBytes, 'subscription-failure continuation', parseD65ContinuationEvent);
  const probe = parseCanonical(probeBytes, 'subscription probe', parseD65SubscriptionProbe);
  if (continuation.trigger !== 'subscription-failure' || continuation.class !== 'provider-capacity-blocked' || continuation.provider === null || continuation.failed_spec_ref === null || continuation.failed_receipt_ref === null || continuation.unit_id === null || continuation.attempt === null || continuation.cooldown_until === null || continuation.retry_ordinal !== 1) throw new CoordinationRuntimeError('invalid-request', 'D65 subscription-failure recovery requires the exact first provider-capacity failure tuple');
  if (continuation.event_sequence !== continuationSequence) throw new CoordinationRuntimeError('invalid-state', 'subscription-failure continuation event_sequence differs from the expected sequence', [String(continuation.event_sequence), String(continuationSequence)]);
  const resultGraphSequence = continuation.result_graph_sequence;
  if (resultGraphSequence === null) throw new CoordinationRuntimeError('invalid-request', 'subscription-failure continuation requires its exact result graph sequence');
  if (Date.parse(continuation.cooldown_until) !== Date.parse(continuation.observed_at) + 15 * 60 * 1000) throw new CoordinationRuntimeError('invalid-request', 'subscription-failure cooldown must equal observed_at plus exactly 15 minutes');
  const continuationDigest = `sha256:${createHash('sha256').update(continuationBytes).digest('hex')}` as `sha256:${string}`;
  if (probe.provider !== continuation.provider || probe.unit_id !== continuation.unit_id || probe.failed_attempt !== continuation.attempt || probe.retry_ordinal !== continuation.retry_ordinal || probe.cooldown_until !== continuation.cooldown_until || probe.trigger_continuation_sha256 !== continuationDigest) throw new CoordinationRuntimeError('invalid-state', 'subscription probe differs from the exact continuation failure tuple');

  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('invalid-state', 'D65 subscription-failure recovery requires a durable coordinator session context');
  const session = await readCoordinatorSessionContext(contextPath);
  const client = new CoordinatorClient({ env });
  if (continuation.repo_id !== session.repo_id || continuation.workstream_run !== session.workstream_run || probe.repo_id !== session.repo_id || probe.workstream_run !== session.workstream_run) throw new CoordinationRuntimeError('invalid-state', 'subscription recovery inputs do not bind the current session run');

  const initialStatus = await client.query('status', session.repo_id, session.workstream_run);
  const resources = initialStatus.payload['run_resources'];
  const rawArtifacts = initialStatus.payload['authoritative_artifacts'];
  if (!Array.isArray(resources) || resources.length !== 1 || resources[0] === undefined || !Array.isArray(rawArtifacts)) throw new CoordinationRuntimeError('invalid-state', 'subscription-failure recovery lacks one exact run resource/artifact projection');
  const resource = parseCoordinationRunResource(resources[0]);
  const runtimePrefix = resource.runtime_root.startsWith(`${resource.main_worktree_path}/`) ? resource.runtime_root.slice(resource.main_worktree_path.length + 1) : null;
  if (runtimePrefix === null) throw new CoordinationRuntimeError('invalid-state', 'run runtime root is not a descendant of its main worktree');
  const paddedSequence = String(continuationSequence).padStart(20, '0');
  const continuationArtifactId = `continuation:${session.workstream_run}:${paddedSequence}:${continuation.event_id}`;
  const probeArtifactId = `subscription-probe:${session.workstream_run}:${paddedSequence}:${probe.probe_id}`;
  const continuationRef = `${runtimePrefix}/authority/continuation/${paddedSequence}-${continuation.event_id}.json`;
  const probeRef = `authority/subscription-probes/${String(probe.probe_sequence).padStart(20, '0')}-${probe.probe_id}.json`;
  if (probe.trigger_continuation_ref !== continuationRef) throw new CoordinationRuntimeError('invalid-request', 'subscription probe trigger ref is not the exact continuation artifact path', [probe.trigger_continuation_ref, continuationRef]);

  const supplied = new Map<string, Uint8Array>();
  for (const file of boundAuthorityFiles) {
    if (supplied.has(file.ref)) throw new CoordinationRuntimeError('invalid-request', 'subscription recovery bound authority refs must be unique', [file.ref]);
    supplied.set(file.ref, file.bytes);
  }
  const descriptors = [continuation.failed_spec_ref, continuation.failed_receipt_ref, ...continuation.evidence_refs];
  if (new Set(descriptors.map((entry) => entry.ref)).size !== descriptors.length) throw new CoordinationRuntimeError('invalid-request', 'subscription continuation contains duplicate bound authority refs');
  for (const ref of supplied.keys()) if (!descriptors.some((entry) => entry.ref === ref)) throw new CoordinationRuntimeError('invalid-request', 'subscription recovery supplied an unbound authority file', [ref]);
  const head = gitText(resource.main_worktree_path, { kind: 'head' }, 'subscription recovery accepted authority HEAD');
  const resolvedFiles = descriptors.map((descriptor) => {
    const suppliedBytes = supplied.get(descriptor.ref);
    const bytes = suppliedBytes ?? runGitQuery({ cwd: resource.main_worktree_path, descriptor: { kind: 'show-file', revision: head, path: descriptor.ref } }).stdout;
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== descriptor.sha256 || bytes.byteLength !== descriptor.byte_count) throw new CoordinationRuntimeError('invalid-request', 'subscription continuation bound authority bytes differ from their exact descriptor', [descriptor.ref, descriptor.sha256, digest]);
    return Object.freeze({ ref: descriptor.ref, bytes, supplied: suppliedBytes !== undefined });
  });
  const stateRef = `${runtimePrefix}/state.json`;
  const stateFiles = resolvedFiles.filter((entry) => entry.ref === stateRef);
  if (stateFiles.length !== 1 || stateFiles[0] === undefined || !stateFiles[0].supplied) throw new CoordinationRuntimeError('invalid-request', 'subscription continuation must supply exactly one updated runtime state authority', [stateRef]);
  const successorSpecs = resolvedFiles.map((entry) => {
    try { return { entry, spec: parseAutopilotUnitSpec(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)) as unknown) }; }
    catch { return null; }
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry.spec.unit_id === probe.unit_id && entry.spec.attempt === probe.successor_attempt);
  if (successorSpecs.length !== 1 || successorSpecs[0] === undefined || !successorSpecs[0].entry.supplied) throw new CoordinationRuntimeError('invalid-request', 'subscription continuation must supply exactly one successor unit spec authority');
  const failedSpecEntry = resolvedFiles.find((entry) => entry.ref === continuation.failed_spec_ref?.ref);
  const failedReceiptEntry = resolvedFiles.find((entry) => entry.ref === continuation.failed_receipt_ref?.ref);
  if (failedSpecEntry === undefined || failedReceiptEntry === undefined) throw new CoordinationRuntimeError('invalid-state', 'subscription continuation failed authority resolution is incomplete');
  const failedSpec = parseAutopilotUnitSpec(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(failedSpecEntry.bytes)) as unknown);
  const failedReceipt = parseAutopilotReceipt(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(failedReceiptEntry.bytes)) as unknown);
  const successorSpec = successorSpecs[0].spec;
  if (failedSpec.unit_id !== probe.unit_id || failedSpec.attempt !== probe.failed_attempt || failedReceipt.unit_id !== probe.unit_id || failedReceipt.attempt !== probe.failed_attempt || failedReceipt.provider_identity.provider_id !== probe.provider || failedReceipt.provider_identity.requested_model_id !== failedSpec.model || failedReceipt.provider_identity.executed_model_id !== failedSpec.model || successorSpec.model !== failedSpec.model) throw new CoordinationRuntimeError('invalid-request', 'subscription continuation spec/receipt/provider/model authority is not exact');
  const state = parseAutopilotState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateFiles[0].bytes)) as unknown);
  const stateUnit = state.units[probe.unit_id];
  const successorStateRef = relative(resource.runtime_root, resolve(resource.main_worktree_path, ...successorSpecs[0].entry.ref.split('/'))).replace(/\\/gu, '/');
  const workItems = Object.values(state.work_items ?? {}).filter((item) => item.unit_ids.includes(probe.unit_id));
  if (stateUnit === undefined || stateUnit.attempt !== probe.successor_attempt || stateUnit.spec_ref !== successorStateRef || workItems.length !== 1) throw new CoordinationRuntimeError('invalid-request', 'subscription continuation updated state does not authorize exactly one successor spec/work-item tuple');

  const accepted = rawArtifacts.map(parseCoordinationAuthoritativeArtifact);
  const continuationAccepted = accepted.some((artifact) => artifact.artifact_id === continuationArtifactId);
  const probeAccepted = accepted.some((artifact) => artifact.artifact_id === probeArtifactId);
  const continuationAtHead = runGitQuery({ cwd: resource.main_worktree_path, descriptor: { kind: 'show-file', revision: head, path: continuationRef, allowAbsent: true } });
  const continuationCommitPending = !continuationAtHead.negative && equalBytes(continuationAtHead.stdout, continuationBytes);
  const probeAtHead = runGitQuery({ cwd: resource.main_worktree_path, descriptor: { kind: 'show-file', revision: head, path: probeRef, allowAbsent: true } });
  const probeCommitPending = !probeAtHead.negative && equalBytes(probeAtHead.stdout, probeBytes);
  let continuationGraph: Readonly<{ graphSequence: number; graphSha256: `sha256:${string}` }>;
  if (probeAccepted || probeCommitPending) {
    const artifact = accepted.find((candidate) => candidate.artifact_id === `semantic-graph:${String(resultGraphSequence).padStart(20, '0')}`);
    if (artifact === undefined) throw new CoordinationRuntimeError('invalid-state', 'subscription probe stage lacks the immutable continuation result graph');
    continuationGraph = Object.freeze({ graphSequence: resultGraphSequence, graphSha256: artifact.evidence.sha256 });
  } else if (!continuationAccepted) {
    const priorGraphs = accepted.filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1').sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
    const priorGraph = priorGraphs[priorGraphs.length - 1];
    if (priorGraph === undefined) throw new CoordinationRuntimeError('invalid-state', 'subscription recovery requires an accepted complete prior graph');
    const priorSequence = Number(priorGraph.artifact_id.slice(-20));
    if (!Number.isSafeInteger(priorSequence) || continuation.prior_graph_sha256 !== priorGraph.evidence.sha256 || resultGraphSequence !== priorSequence + 1) throw new CoordinationRuntimeError('invalid-state', 'subscription continuation prior/result graph tuple is not exact', [String(resultGraphSequence), String(priorSequence)]);
    const boundFiles = resolvedFiles.filter((entry) => entry.supplied).map((entry) => Object.freeze({ ref: entry.ref, bytes: entry.bytes, mutable: entry.ref === stateRef }));
    if (!continuationCommitPending) {
      const settled = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: continuation.observed_at });
      if (settled.semanticEventType !== null) throw new CoordinationRuntimeError('invalid-state', 'subscription recovery began before prior failed-attempt recovery cadence was settled', [settled.semanticEventType]);
      await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: settled.graphSequence, graphSha256: settled.graphSha256, env });
      if (settled.graphSha256 !== priorGraph.evidence.sha256 || settled.graphSequence !== priorSequence) throw new CoordinationRuntimeError('invalid-state', 'subscription recovery settled graph differs from the immutable continuation prior', [String(settled.graphSequence), String(priorSequence)]);
    }
    await commitAndRegisterD65RecoveryArtifact({ client, session, resource, env, artifactId: continuationArtifactId, schema: 'autopilot.continuation_event.v1', ref: continuationRef, bytes: continuationBytes, boundFiles, message: 'autopilot: subscription-failure continuation event', commitDate: continuation.observed_at });
    const graph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: continuation.observed_at });
    if (graph.semanticEventType !== 'authoritative-artifact-registered' || graph.graphSequence !== resultGraphSequence) throw new CoordinationRuntimeError('invalid-state', 'subscription continuation graph did not cover exactly its registration event', [String(graph.semanticEventType), String(graph.graphSequence)]);
    await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, env });
    continuationGraph = graph;
  } else {
    const graph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: continuation.observed_at });
    if (graph.semanticEventType !== null && graph.semanticEventType !== 'authoritative-artifact-registered') throw new CoordinationRuntimeError('invalid-state', 'subscription continuation resume encountered a foreign semantic event', [graph.semanticEventType]);
    if (graph.graphSequence !== resultGraphSequence) throw new CoordinationRuntimeError('invalid-state', 'resumed subscription continuation graph sequence differs from immutable result_graph_sequence');
    await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, env });
    continuationGraph = graph;
  }

  let probeGraph: Readonly<{ graphSequence: number; graphSha256: `sha256:${string}` }>;
  if (!probeAccepted) {
    await commitAndRegisterD65RecoveryArtifact({ client, session, resource, env, artifactId: probeArtifactId, schema: 'autopilot.subscription_probe.v1', ref: probeRef, bytes: probeBytes, message: 'autopilot: subscription probe', commitDate: probe.issued_at });
    const graph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: probe.issued_at });
    if (graph.semanticEventType !== 'authoritative-artifact-registered') throw new CoordinationRuntimeError('invalid-state', 'subscription probe graph did not cover exactly its registration event', [String(graph.semanticEventType)]);
    await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, env });
    probeGraph = graph;
  } else {
    const graph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt: probe.issued_at });
    if (graph.semanticEventType !== null && graph.semanticEventType !== 'authoritative-artifact-registered') throw new CoordinationRuntimeError('invalid-state', 'subscription probe resume encountered a foreign semantic event', [graph.semanticEventType]);
    await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, env });
    probeGraph = graph;
  }
  await assertD65RecoveryBoundaryFromEnvironment('register-attempt', { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false }, env);
  return Object.freeze({ continuationGraphSequence: continuationGraph.graphSequence, continuationGraphSha256: continuationGraph.graphSha256, probeGraphSequence: probeGraph.graphSequence, probeGraphSha256: probeGraph.graphSha256 });
}
