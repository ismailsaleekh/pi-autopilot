import {
  gitIntentCapsule,
  gitObservationCapsule,
} from "../../ports/contracts/git.capsule.js";
import type {
  GitIntent,
  GitObservation,
} from "../../ports/contracts/git.capsule.js";
import {
  artifactRootSchema,
  revisionIdSchema,
  runIdSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ArtifactRef,
  ArtifactRoot,
  RevisionId,
  RunId,
} from "../../authority/protocol/identifiers.js";
import {
  canonicalEncodeUnknown,
  defineCapsule,
  literal,
  object,
} from "../../authority/protocol/schema.js";
import { ArtifactCatalog } from "./artifacts.js";
import type { SimArtifactFile } from "./artifacts.js";
import { SimFileSystem } from "./sim-filesystem.js";
import { SimLockManager } from "./sim-locks.js";
import { SimWorkspacePort } from "./fake-workspace.js";
import type { PortTraceSink, SimPortExecution } from "./port-types.js";
import { diagnostic, safeDecode } from "./port-types.js";
import { decodeUtf8, revisionIdFor } from "./values.js";
import type { CrashPointId } from "../crash-matrix/registry.js";

interface CommitRecord {
  readonly revision: RevisionId;
  readonly tree: ArtifactRoot;
}

interface RepositoryRecord {
  readonly runId: RunId;
  readonly identity: ArtifactRoot;
  head: RevisionId;
  readonly commits: Map<RevisionId, ArtifactRoot>;
}

export interface GitRepositoryImage {
  readonly runId: RunId;
  readonly identity: ArtifactRoot;
  readonly head: RevisionId;
  readonly commits: readonly CommitRecord[];
}

export interface GitImage {
  readonly repositories: readonly GitRepositoryImage[];
}

export type SeedRepositoryResult =
  | { readonly kind: "seeded"; readonly runId: RunId; readonly head: RevisionId }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export type GitRacePoint = "after-read" | "before-cas";

interface GitRaceHook {
  readonly point: GitRacePoint;
  readonly runId: RunId;
  readonly newHead: RevisionId;
  fired: boolean;
}

export type GitRaceHookResult =
  | { readonly kind: "registered"; readonly point: GitRacePoint }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const repositorySeedSchema = object({
  head: revisionIdSchema,
  identity: artifactRootSchema,
  kind: literal("repository"),
  runId: runIdSchema,
  tree: artifactRootSchema,
});
const repositorySeedCapsule = defineCapsule("SimulationGitRepositorySeed", repositorySeedSchema);
const artifactRootCapsule = defineCapsule("SimulationGitRootListItem", artifactRootSchema);
const revisionCapsule = defineCapsule("SimulationGitRaceRevision", revisionIdSchema);
const runCapsule = defineCapsule("SimulationGitRaceRun", runIdSchema);

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Models immutable trees/commits, one canonical ref per run, exact root
 * comparison, deterministic integration, and atomic compare-and-swap with
 * race hooks. It does not model Git's object encoding, hooks/config, index,
 * file modes, symlinks, merge algorithms, or multiple refs; D3 real-git does.
 */
export class SimGitPort {
  private readonly artifacts: ArtifactCatalog;
  private readonly fileSystem: SimFileSystem;
  private readonly locks: SimLockManager;
  private readonly workspaces: SimWorkspacePort;
  private readonly trace: PortTraceSink;
  private readonly repositories = new Map<RunId, RepositoryRecord>();
  private readonly observations = new Map<string, GitObservation>();
  private readonly raceHooks: GitRaceHook[] = [];

  public constructor(
    artifacts: ArtifactCatalog,
    fileSystem: SimFileSystem,
    locks: SimLockManager,
    workspaces: SimWorkspacePort,
    trace: PortTraceSink,
    image?: GitImage,
  ) {
    this.artifacts = artifacts;
    this.fileSystem = fileSystem;
    this.locks = locks;
    this.workspaces = workspaces;
    this.trace = trace;
    if (image !== undefined) {
      for (const entry of image.repositories) {
        this.repositories.set(entry.runId, {
          runId: entry.runId,
          identity: entry.identity,
          head: entry.head,
          commits: new Map(entry.commits.map((commit) => [commit.revision, commit.tree])),
        });
      }
    }
  }

  public seedRepository(input: unknown): SeedRepositoryResult {
    const decoded = safeDecode(repositorySeedCapsule, input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "invalid", diagnostic: decoded.diagnostic.message });
    }
    if (!this.artifacts.has(decoded.value.tree)) {
      return Object.freeze({ kind: "invalid", diagnostic: "repository tree root is absent from the artifact catalog" });
    }
    const prior = this.repositories.get(decoded.value.runId);
    if (prior !== undefined && (prior.identity !== decoded.value.identity || prior.head !== decoded.value.head)) {
      return Object.freeze({ kind: "invalid", diagnostic: "run already names a different repository or head" });
    }
    this.repositories.set(decoded.value.runId, {
      runId: decoded.value.runId,
      identity: decoded.value.identity,
      head: decoded.value.head,
      commits: new Map([[decoded.value.head, decoded.value.tree]]),
    });
    return Object.freeze({ kind: "seeded", runId: decoded.value.runId, head: decoded.value.head });
  }

  public registerRaceHook(input: unknown): GitRaceHookResult {
    try {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return Object.freeze({ kind: "invalid", diagnostic: "git race hook must be an object" });
      }
      const point = Reflect.get(input, "point");
      const run = decodeSingle(runCapsule, Reflect.get(input, "runId"));
      const revision = decodeSingle(revisionCapsule, Reflect.get(input, "newHead"));
      if ((point !== "after-read" && point !== "before-cas") || run === null || revision === null) {
        return Object.freeze({ kind: "invalid", diagnostic: "git race hook requires a valid point, run ID, and revision" });
      }
      this.raceHooks.push({ point, runId: run, newHead: revision, fired: false });
      return Object.freeze({ kind: "registered", point });
    } catch {
      return Object.freeze({ kind: "invalid", diagnostic: "git race hook could not be inspected" });
    }
  }

  public createAcceptedOutputs(rootsInput: unknown): ArtifactRef | null {
    try {
      if (!Array.isArray(rootsInput)) {
        return null;
      }
      const roots: ArtifactRoot[] = [];
      for (const candidate of rootsInput) {
        const root = decodeSingle(artifactRootCapsule, candidate);
        if (root === null || !this.artifacts.has(root)) {
          return null;
        }
        roots.push(root);
      }
      const bytes = canonicalEncodeUnknown(Object.freeze({
        format: "pi-autopilot.sim-root-list.v1",
        roots: Object.freeze(roots),
      }));
      const created = this.artifacts.createBlob("git/accepted-outputs.json", bytes);
      return created.kind === "ok"
        ? this.artifacts.reference(created.tree.root, "git/accepted-outputs.json")
        : null;
    } catch {
      return null;
    }
  }

  public execute(input: unknown): SimPortExecution<GitObservation> {
    const decoded = safeDecode(gitIntentCapsule, input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    const cached = this.observations.get(decoded.value.actionId);
    if (cached !== undefined) {
      this.trace.recordContract("git", decoded.value.actionId, cached);
      return Object.freeze({ kind: "observation", observation: cached });
    }
    const result = this.apply(decoded.value);
    if (result.kind === "observation" && result.observation.result.kind === "ok") {
      this.observations.set(decoded.value.actionId, result.observation);
      this.trace.recordContract("git", decoded.value.actionId, result.observation);
    } else if (result.kind === "observation") {
      this.trace.recordContract("git", decoded.value.actionId, result.observation);
    }
    return result;
  }

  public head(runInput: unknown): RevisionId | null {
    const run = decodeSingle(runCapsule, runInput);
    return run === null ? null : this.repositories.get(run)?.head ?? null;
  }

  public image(): GitImage {
    const repositories = [...this.repositories.values()]
      .sort((left, right) => compareText(left.runId, right.runId))
      .map((repository) => Object.freeze({
        runId: repository.runId,
        identity: repository.identity,
        head: repository.head,
        commits: Object.freeze([...repository.commits.entries()]
          .sort((left, right) => compareText(left[0], right[0]))
          .map(([revision, tree]) => Object.freeze({ revision, tree }))),
      }));
    return Object.freeze({ repositories: Object.freeze(repositories) });
  }

  private apply(intent: GitIntent): SimPortExecution<GitObservation> {
    switch (intent.kind) {
      case "materialize-workspace": {
        const repository = this.repositories.get(intent.runId);
        const tree = repository?.commits.get(intent.inputs.baseRevision);
        const result = repository !== undefined
          && repository.identity === intent.preconditions.repositoryIdentity
          && tree === intent.inputs.repositorySnapshot
          ? this.workspaces.materialize(intent.inputs.workspaceId, intent.inputs.repositorySnapshot)
          : null;
        return result?.kind === "ok"
          ? this.observation(intent, "workspace-materialized", Object.freeze({
              kind: "ok",
              value: Object.freeze({
                baseRevision: intent.inputs.baseRevision,
                materializedRoot: result.root,
                workspaceId: intent.inputs.workspaceId,
              }),
            }))
          : this.observation(intent, "workspace-materialized", Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("git.materialize-precondition", result?.diagnostic ?? "repository identity, revision, or snapshot does not match"),
            }));
      }
      case "seal-workspace": {
        const baseRoot = this.workspaces.baseRoot(intent.inputs.workspaceId);
        const outputRoot = this.workspaces.captureRoot(intent.inputs.workspaceId);
        if (baseRoot !== intent.preconditions.expectedInputRoot || outputRoot === null) {
          return this.observation(intent, "workspace-sealed", Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("git.seal-precondition", "workspace input root is stale or workspace is absent"),
          }));
        }
        const persisted = this.persistRoot(outputRoot, intent.actionId, "seal");
        if (persisted !== null) {
          return Object.freeze({ kind: "crashed", point: persisted });
        }
        const manifest = this.manifestFor("sealed-workspace", outputRoot, intent.inputs.workspaceId);
        return manifest === null
          ? this.observation(intent, "workspace-sealed", Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("git.seal-manifest", "sealed workspace manifest could not be captured"),
            }))
          : this.observation(intent, "workspace-sealed", Object.freeze({
              kind: "ok",
              value: Object.freeze({ manifest, outputRoot, workspaceId: intent.inputs.workspaceId }),
            }));
      }
      case "compare-roots": {
        const left = this.artifacts.get(intent.inputs.leftRoot);
        const right = this.artifacts.get(intent.inputs.rightRoot);
        if (left === null || right === null) {
          return this.observation(intent, "roots-compared", Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("git.compare-root-absent", "one or both compared roots are absent"),
          }));
        }
        const changed = changedPaths(left.files, right.files);
        const diff = this.artifactFor("git/diff.json", Object.freeze({
          changed,
          format: "pi-autopilot.sim-diff.v1",
          leftRoot: left.root,
          rightRoot: right.root,
        }));
        return diff === null
          ? this.observation(intent, "roots-compared", Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("git.diff-artifact", "diff artifact could not be captured"),
            }))
          : this.observation(intent, "roots-compared", Object.freeze({
              kind: "ok",
              value: Object.freeze({
                diff,
                equal: changed.length === 0,
                leftRoot: left.root,
                rightRoot: right.root,
              }),
            }));
      }
      case "integrate-candidate":
        return this.integrate(intent);
      case "publish-if-expected-head":
        return this.publish(intent);
    }
  }

  private integrate(intent: Extract<GitIntent, { readonly kind: "integrate-candidate" }>): SimPortExecution<GitObservation> {
    const repository = this.repositories.get(intent.runId);
    const baseTree = repository?.commits.get(intent.inputs.baseRevision);
    const roots = this.readRootList(intent.inputs.acceptedOutputs);
    if (
      repository === undefined
      || repository.identity !== intent.preconditions.repositoryIdentity
      || baseTree !== intent.preconditions.expectedIntegrationRoot
      || roots === null
    ) {
      return this.observation(intent, "candidate-integrated", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.integrate-precondition", "repository, integration root, or accepted-output list is invalid"),
      }));
    }
    const merged = mergeTrees(this.artifacts, baseTree, roots);
    if (merged === null) {
      return this.observation(intent, "candidate-integrated", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.integration-conflict", "accepted roots change the same path to different bytes"),
      }));
    }
    const created = this.artifacts.createTree(merged);
    if (created.kind !== "ok") {
      return this.observation(intent, "candidate-integrated", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.integration-tree", created.diagnostic),
      }));
    }
    const revision = revisionIdFor(Object.freeze({
      baseRevision: intent.inputs.baseRevision,
      candidateId: intent.inputs.candidateId,
      tree: created.tree.root,
    }));
    const persisted = this.persistRoot(created.tree.root, intent.actionId, "integrate");
    if (persisted !== null) {
      return Object.freeze({ kind: "crashed", point: persisted });
    }
    repository.commits.set(revision, created.tree.root);
    const manifest = this.manifestFor("integrated-candidate", created.tree.root, intent.inputs.candidateId);
    return manifest === null
      ? this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "retry",
          diagnostic: diagnostic("git.integration-manifest", "integrated manifest could not be captured"),
        }))
      : this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "ok",
          value: Object.freeze({
            candidateId: intent.inputs.candidateId,
            manifest,
            revision,
            tree: created.tree.root,
          }),
        }));
  }

  private publish(intent: Extract<GitIntent, { readonly kind: "publish-if-expected-head" }>): SimPortExecution<GitObservation> {
    const repository = this.repositories.get(intent.runId);
    const desiredTree = repository?.commits.get(intent.inputs.desiredHead);
    const manifestPresent = this.artifacts.read(intent.preconditions.verifiedManifest).kind === "ok";
    const lock = this.locks.acquire(
      `git-publication:${intent.runId}`,
      intent.runId,
      intent.preconditions.publicationLease,
    );
    if (
      repository === undefined
      || desiredTree !== intent.preconditions.candidateTree
      || !manifestPresent
      || lock.kind !== "acquired"
    ) {
      return this.observation(intent, "head-publication-observed", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.publish-precondition", "publication repository, candidate, manifest, or lease is invalid"),
      }));
    }
    if (this.trace.reachCrashPoint("git.publish.before-read", Object.freeze({ publicationId: intent.inputs.publicationId }))) {
      return Object.freeze({ kind: "crashed", point: "git.publish.before-read" });
    }
    const observed = repository.head;
    if (this.trace.reachCrashPoint("git.publish.after-read", Object.freeze({ observed }))) {
      return Object.freeze({ kind: "crashed", point: "git.publish.after-read" });
    }
    this.fireRace("after-read", repository);
    if (observed === intent.inputs.desiredHead || repository.head === intent.inputs.desiredHead) {
      return this.publishedObservation(intent, "already-published", repository.head);
    }
    if (observed !== intent.inputs.expectedHead) {
      return this.publishedObservation(intent, "head-moved", repository.head);
    }
    if (this.trace.reachCrashPoint("git.publish.before-cas", Object.freeze({ expected: intent.inputs.expectedHead }))) {
      return Object.freeze({ kind: "crashed", point: "git.publish.before-cas" });
    }
    this.fireRace("before-cas", repository);
    if (repository.head !== intent.inputs.expectedHead) {
      return this.publishedObservation(intent, "head-moved", repository.head);
    }
    repository.head = intent.inputs.desiredHead;
    this.trace.recordSemantic(
      "git",
      "head-published",
      `publication:${intent.inputs.publicationId}`,
      Object.freeze({ desiredHead: intent.inputs.desiredHead, publicationId: intent.inputs.publicationId }),
    );
    if (this.trace.reachCrashPoint("git.publish.after-cas", Object.freeze({ desired: intent.inputs.desiredHead }))) {
      return Object.freeze({ kind: "crashed", point: "git.publish.after-cas" });
    }
    if (this.trace.reachCrashPoint("git.publish.ack", Object.freeze({ publicationId: intent.inputs.publicationId }))) {
      return Object.freeze({ kind: "crashed", point: "git.publish.ack" });
    }
    return this.publishedObservation(intent, "published", repository.head);
  }

  private publishedObservation(
    intent: Extract<GitIntent, { readonly kind: "publish-if-expected-head" }>,
    status: "published" | "already-published" | "head-moved",
    observedHead: RevisionId,
  ): SimPortExecution<GitObservation> {
    return this.observation(intent, "head-publication-observed", Object.freeze({
      kind: "ok",
      value: Object.freeze({
        desiredHead: intent.inputs.desiredHead,
        observedHead,
        publicationId: intent.inputs.publicationId,
        status,
      }),
    }));
  }

  private persistRoot(root: ArtifactRoot, actionId: string, phase: "seal" | "integrate"): CrashPointId | null {
    const bytes = this.artifacts.serialize(root);
    if (bytes === null) {
      return null;
    }
    const finalPath = `/git/${phase}/${root}`;
    if (this.fileSystem.exists(finalPath)) {
      return null;
    }
    const temporaryPath = `/git/temp/${phase}.${actionId}.${root}`;
    const appendPoint = phase === "seal" ? "git.seal.append" : "git.integrate.append";
    const fsyncPoint = phase === "seal" ? "git.seal.file-fsync" : "git.integrate.file-fsync";
    const renamePoint = phase === "seal" ? "git.seal.rename" : "git.integrate.rename";
    const dirsyncPoint = phase === "seal" ? "git.seal.directory-fsync" : "git.integrate.directory-fsync";
    const ackPoint = phase === "seal" ? "git.seal.ack" : "git.integrate.ack";
    const append = this.fileSystem.appendFile(temporaryPath, bytes, appendPoint);
    if (append.kind === "crashed") {
      return append.point;
    }
    const fsync = this.fileSystem.fsyncFile(temporaryPath, fsyncPoint);
    if (fsync.kind === "crashed") {
      return fsync.point;
    }
    const rename = this.fileSystem.rename(temporaryPath, finalPath, renamePoint);
    if (rename.kind === "crashed") {
      return rename.point;
    }
    const dirsync = this.fileSystem.fsyncDirectory(`/git/${phase}`, dirsyncPoint);
    if (dirsync.kind === "crashed") {
      return dirsync.point;
    }
    this.trace.recordSemantic("git", `${phase}-root-durable`, `git:${phase}:${root}`, Object.freeze({ root }));
    return this.trace.reachCrashPoint(ackPoint, Object.freeze({ root })) ? ackPoint : null;
  }

  private manifestFor(kind: string, root: ArtifactRoot, identity: string): ArtifactRef | null {
    return this.artifactFor("git/manifest.json", Object.freeze({
      format: "pi-autopilot.sim-git-manifest.v1",
      identity,
      kind,
      root,
    }));
  }

  private artifactFor(path: string, value: unknown): ArtifactRef | null {
    const created = this.artifacts.createBlob(path, canonicalEncodeUnknown(value));
    return created.kind === "ok" ? this.artifacts.reference(created.tree.root, path) : null;
  }

  private readRootList(ref: ArtifactRef): readonly ArtifactRoot[] | null {
    const read = this.artifacts.read(ref);
    if (read.kind !== "ok") {
      return null;
    }
    const text = decodeUtf8(read.bytes);
    if (text === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const format = Reflect.get(parsed, "format");
    const candidates = Reflect.get(parsed, "roots");
    if (format !== "pi-autopilot.sim-root-list.v1" || !Array.isArray(candidates)) {
      return null;
    }
    const roots: ArtifactRoot[] = [];
    for (const candidate of candidates) {
      const root = decodeSingle(artifactRootCapsule, candidate);
      if (root === null || !this.artifacts.has(root)) {
        return null;
      }
      roots.push(root);
    }
    return Object.freeze(roots);
  }

  private fireRace(point: GitRacePoint, repository: RepositoryRecord): void {
    const hook = this.raceHooks.find((candidate) => !candidate.fired && candidate.point === point && candidate.runId === repository.runId);
    if (hook === undefined) {
      return;
    }
    hook.fired = true;
    repository.head = hook.newHead;
  }

  private observation(
    intent: GitIntent,
    kind: GitObservation["kind"],
    result: unknown,
  ): SimPortExecution<GitObservation> {
    const decoded = safeDecode(gitObservationCapsule, Object.freeze({
      actionId: intent.actionId,
      kind,
      result,
      runId: intent.runId,
    }));
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "observation", observation: decoded.value })
      : Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
  }
}

function decodeSingle<Value>(
  capsule: { readonly encodeUnknown: (value: unknown) => { readonly kind: "ok"; readonly value: Uint8Array } | { readonly kind: "error" }; readonly decodeCanonical: (value: Uint8Array) => { readonly kind: "ok"; readonly value: Value } | { readonly kind: "error" } },
  input: unknown,
): Value | null {
  try {
    const encoded = capsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = capsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

function changedPaths(left: readonly SimArtifactFile[], right: readonly SimArtifactFile[]): readonly string[] {
  const paths = new Set([...left.map((file) => file.path), ...right.map((file) => file.path)]);
  const changed: string[] = [];
  for (const path of [...paths].sort(compareText)) {
    const leftFile = left.find((file) => file.path === path);
    const rightFile = right.find((file) => file.path === path);
    if (
      leftFile === undefined
      || rightFile === undefined
      || leftFile.bytes.length !== rightFile.bytes.length
      || leftFile.bytes.some((byte, index) => byte !== rightFile.bytes[index])
    ) {
      changed.push(path);
    }
  }
  return Object.freeze(changed);
}

function mergeTrees(
  artifacts: ArtifactCatalog,
  baseRoot: ArtifactRoot,
  roots: readonly ArtifactRoot[],
): readonly SimArtifactFile[] | null {
  const base = artifacts.get(baseRoot);
  if (base === null) {
    return null;
  }
  const files = new Map(base.files.map((file) => [file.path, Object.freeze({ path: file.path, bytes: file.bytes.slice() })]));
  const changedBy = new Map<string, Uint8Array>();
  for (const root of roots) {
    const tree = artifacts.get(root);
    if (tree === null) {
      return null;
    }
    for (const file of tree.files) {
      const priorChange = changedBy.get(file.path);
      if (priorChange !== undefined && (
        priorChange.length !== file.bytes.length
        || priorChange.some((byte, index) => byte !== file.bytes[index])
      )) {
        return null;
      }
      changedBy.set(file.path, file.bytes);
      files.set(file.path, Object.freeze({ path: file.path, bytes: file.bytes.slice() }));
    }
  }
  return Object.freeze([...files.values()].sort((left, right) => compareText(left.path, right.path)));
}
