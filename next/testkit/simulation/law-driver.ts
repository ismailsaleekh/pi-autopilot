import { childIntentCapsule, childObservationCapsule } from "../../ports/contracts/child.capsule.js";
import { clockIntentCapsule } from "../../ports/contracts/clock.capsule.js";
import { gitIntentCapsule } from "../../ports/contracts/git.capsule.js";
import { secretsIntentCapsule, secretsObservationCapsule } from "../../ports/contracts/secrets.capsule.js";
import { storeIntentCapsule } from "../../ports/contracts/store.capsule.js";
import { workspaceIntentCapsule } from "../../ports/contracts/workspace.capsule.js";
import type { ArtifactRef } from "../../authority/protocol/identifiers.js";
import { canonicalEncodeUnknown } from "../../authority/protocol/schema.js";
import type { JsonValue } from "../../authority/protocol/schema.js";
import type { LawDriver, LawFixture, LawFixtureResult, LawPortName } from "../../ports/laws/contract-vector.js";
import { SimWorld } from "./sim-world.js";
import { traceJson } from "./trace.js";

interface NamedTree { readonly root: string }
interface NamedWorkspace {
  readonly workspaceId: string;
  readonly workspaceCapability: string;
  readonly root: string;
  readonly leaseId: string;
  readonly state: "empty-reserved" | "materialized" | "absent";
}
interface NamedRepository {
  readonly runId: string;
  readonly repository: string;
  readonly publicationRef: string;
  readonly head: string;
  readonly tree: string;
}
interface ChildRecord {
  readonly childId: string;
  readonly childEpoch: string;
  readonly workspaceId: string;
  readonly processDescriptor: ArtifactRef;
  readonly process: JsonValue;
  readonly session: JsonValue;
  readonly processId: string;
  readonly processGroupId: string;
  fenced: boolean;
}

function launchedTemplate(seed: number) {
  for (let offset = 0; offset < 100; offset += 1) {
    const value = childObservationCapsule.arbitrary.validForKind("child-session-launched", seed + offset);
    if (value.kind === "child-session-launched" && value.result.kind === "ok") return value.result.value;
  }
  return null;
}

function authorizedTemplate(seed: number) {
  for (let offset = 0; offset < 100; offset += 1) {
    const value = secretsObservationCapsule.arbitrary.validForKind("secret-use-authorized", seed + offset);
    if (value.kind === "secret-use-authorized" && value.result.kind === "ok") return value.result.value;
  }
  return null;
}

function retryResult(code: string, message: string) {
  return Object.freeze({
    diagnostic: Object.freeze({ code, message, related: Object.freeze([]) }),
    kind: "retry",
  });
}

function execution(observation: unknown) {
  return Object.freeze({ kind: "observation", observation });
}

function validDecimal(input: string): boolean {
  return input === "0" || /^[1-9][0-9]*$/.test(input);
}

/** Deterministic Amendment-002 fake implementing the same closed six-port laws as real adapters. */
export class SimLawDriver implements LawDriver {
  public readonly world: SimWorld;
  private readonly trees = new Map<string, NamedTree>();
  private readonly workspaces = new Map<string, NamedWorkspace>();
  private readonly repositories = new Map<string, NamedRepository>();
  private readonly installed = new Set<string>();
  private readonly publications = new Map<string, string>();
  private readonly children = new Map<string, ChildRecord>();
  private readonly routes = new Map<string, JsonValue>();
  private readonly secrets = new Map<string, Uint8Array>();
  private readonly revokedLeases = new Set<string>();
  private clockTick = 0n;
  private fixtureSequence = 0;
  private captureSequence = 0;

  public constructor(seed: unknown = 1) {
    this.world = new SimWorld(seed);
  }

  public async fixture(request: LawFixture): Promise<LawFixtureResult> {
    this.fixtureSequence += 1;
    if (request.kind === "tree") {
      const created = this.world.artifacts.createTree(request.files);
      if (created.kind !== "ok" || created.tree.files.length === 0) return Object.freeze({ kind: "invalid", diagnostic: "tree fixture requires at least one valid file" });
      const manifest = this.createArtifact(`law/manifest-${String(this.fixtureSequence)}.json`, canonicalEncodeUnknown(Object.freeze({ files: created.tree.files.map((file) => Object.freeze({ path: file.path, bytes: String(file.bytes.byteLength) })), root: created.tree.root })));
      const firstFile = this.world.artifacts.reference(created.tree.root, created.tree.files[0]?.path ?? "");
      if (manifest === null || firstFile === null) return Object.freeze({ kind: "invalid", diagnostic: "tree fixture references were not installed" });
      this.trees.set(request.name, Object.freeze({ root: created.tree.root }));
      return Object.freeze({ kind: "tree", name: request.name, root: created.tree.root, manifest, firstFile });
    }
    if (request.kind === "workspace") {
      const tree = this.trees.get(request.treeName);
      const template = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 200 + this.fixtureSequence);
      if (tree === undefined || template.kind !== "allocate-attempt-directory") return Object.freeze({ kind: "invalid", diagnostic: "workspace fixture requires an installed tree" });
      const record: NamedWorkspace = Object.freeze({
        workspaceId: template.inputs.workspaceId,
        workspaceCapability: template.inputs.workspaceCapability,
        root: tree.root,
        leaseId: template.preconditions.leaseId,
        state: "materialized",
      });
      this.workspaces.set(record.workspaceId, record);
      this.workspaces.set(request.name, record);
      return Object.freeze({ kind: "workspace", name: request.name, workspaceId: record.workspaceId, workspaceCapability: record.workspaceCapability, root: record.root, leaseId: record.leaseId });
    }
    if (request.kind === "repository") {
      const tree = this.trees.get(request.treeName);
      const materialize = gitIntentCapsule.arbitrary.validForKind("materialize-workspace", 300 + this.fixtureSequence);
      const observe = gitIntentCapsule.arbitrary.validForKind("observe-repository-ref", 400 + this.fixtureSequence);
      if (tree === undefined || materialize.kind !== "materialize-workspace" || observe.kind !== "observe-repository-ref") return Object.freeze({ kind: "invalid", diagnostic: "repository fixture could not mint distinct Git identities" });
      const record: NamedRepository = Object.freeze({
        runId: request.runId,
        repository: materialize.inputs.repository,
        publicationRef: observe.inputs.publicationRef,
        head: materialize.inputs.baseCommit,
        tree: materialize.inputs.baseTree,
      });
      this.repositories.set(record.repository, record);
      return Object.freeze({ kind: "repository", name: request.name, ...record });
    }
    if (request.kind === "root-list") {
      const roots: string[] = [];
      for (const name of request.treeNames) {
        const tree = this.trees.get(name);
        if (tree === undefined) return Object.freeze({ kind: "invalid", diagnostic: "root-list names an absent tree" });
        roots.push(tree.root);
      }
      const reference = this.createArtifact(`law/root-list-${String(this.fixtureSequence)}.json`, canonicalEncodeUnknown(Object.freeze({ roots: Object.freeze(roots) })));
      return reference === null ? Object.freeze({ kind: "invalid", diagnostic: "root-list could not be installed" }) : Object.freeze({ kind: "root-list", name: request.name, reference });
    }
    if (request.kind === "child-script") return Object.freeze({ kind: "child-script", name: request.name });
    this.secrets.set(request.handle, request.bytes.slice());
    return Object.freeze({ kind: "secret", name: request.name, handle: request.handle });
  }

  public async dispatch(port: LawPortName, input: JsonValue): Promise<unknown> {
    try {
      switch (port) {
        case "workspace": return this.dispatchWorkspace(input);
        case "git": return this.dispatchGit(input);
        case "child": return this.dispatchChild(input);
        case "store": return this.dispatchStore(input);
        case "clock": return this.dispatchClock(input);
        case "secrets": return this.dispatchSecrets(input);
      }
    } catch {
      return Object.freeze({ kind: "rejected", diagnostic: Object.freeze({ code: "sim-boundary-error", message: "fake port rejected malformed input" }) });
    }
  }

  public async advance(ticks: string): Promise<void> {
    if (!validDecimal(ticks)) return;
    this.clockTick += BigInt(ticks);
    const numeric = Number(ticks);
    if (Number.isSafeInteger(numeric)) this.world.advance(numeric);
  }

  public async readArtifact(reference: JsonValue): Promise<Uint8Array | null> {
    const read = this.world.artifacts.read(reference);
    return read.kind === "ok" ? read.bytes : null;
  }

  public async containsSecretBytes(bytes: Uint8Array): Promise<boolean> {
    if (bytes.byteLength === 0) return false;
    const haystack = canonicalEncodeUnknown(this.world.trace.snapshot());
    outer: for (let start = 0; start + bytes.byteLength <= haystack.byteLength; start += 1) {
      for (let offset = 0; offset < bytes.byteLength; offset += 1) if (haystack[start + offset] !== bytes[offset]) continue outer;
      return true;
    }
    return false;
  }

  private dispatchWorkspace(input: JsonValue): unknown {
    const decoded = workspaceIntentCapsule.decode(input);
    if (decoded.kind === "error") return Object.freeze({ kind: "rejected" });
    const intent = decoded.value;
    if (intent.kind === "allocate-attempt-directory") {
      const prior = this.workspaces.get(intent.inputs.workspaceId);
      if (prior !== undefined) return this.emit(Object.freeze({ actionId: intent.actionId, kind: "attempt-directory-allocated", result: retryResult("workspace-exists", "workspace reservation already exists"), runId: intent.runId }));
      const record: NamedWorkspace = Object.freeze({ workspaceId: intent.inputs.workspaceId, workspaceCapability: intent.inputs.workspaceCapability, root: "", leaseId: intent.preconditions.leaseId, state: "empty-reserved" });
      this.workspaces.set(record.workspaceId, record);
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "attempt-directory-allocated", result: Object.freeze({ kind: "ok", value: Object.freeze({ empty: true, leaseId: record.leaseId, workspaceCapability: record.workspaceCapability, workspaceId: record.workspaceId }) }), runId: intent.runId }));
    }
    const record = this.workspaces.get(intent.inputs.workspaceId);
    if (intent.kind === "inspect-attempt-directory") {
      const state = record?.state ?? "absent";
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "attempt-directory-inspected", result: Object.freeze({ kind: "ok", value: Object.freeze({ childEpoch: intent.preconditions.childEpoch, leaseId: intent.preconditions.leaseId, observedRoot: record === undefined || record.root.length === 0 ? null : record.root, state, workspaceId: intent.inputs.workspaceId }) }), runId: intent.runId }));
    }
    if (record === undefined) return this.emit(Object.freeze({ actionId: intent.actionId, kind: intent.kind === "apply-attempt-isolation" ? "attempt-isolation-applied" : "attempt-directory-disposed", result: retryResult("workspace-absent", "workspace reservation is absent"), runId: intent.runId }));
    if (intent.kind === "apply-attempt-isolation") {
      const attestation = this.createCapture("workspace-isolation", Object.freeze({ policyDigest: intent.preconditions.expectedPolicyDigest, workspaceRoot: intent.preconditions.expectedWorkspaceRoot }));
      if (attestation === null) return Object.freeze({ kind: "rejected" });
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "attempt-isolation-applied", result: Object.freeze({ kind: "ok", value: Object.freeze({ attestation, policyDigest: intent.preconditions.expectedPolicyDigest, workspaceRoot: intent.preconditions.expectedWorkspaceRoot, workspaceId: intent.inputs.workspaceId }) }), runId: intent.runId }));
    }
    this.workspaces.delete(intent.inputs.workspaceId);
    return this.emit(Object.freeze({ actionId: intent.actionId, kind: "attempt-directory-disposed", result: Object.freeze({ kind: "ok", value: Object.freeze({ disposed: true, fencedChildEpoch: intent.preconditions.fencedChildEpoch, workspaceId: intent.inputs.workspaceId }) }), runId: intent.runId }));
  }

  private dispatchGit(input: JsonValue): unknown {
    const decoded = gitIntentCapsule.decode(input);
    if (decoded.kind === "error") return Object.freeze({ kind: "rejected" });
    const intent = decoded.value;
    if (intent.kind === "observe-repository-ref") {
      const repository = this.repositories.get(intent.inputs.repository);
      const published = this.publications.get(`${intent.inputs.repository}:${intent.inputs.publicationRef}`);
      const observed = published === undefined ? (repository === undefined ? Object.freeze({ kind: "unborn" }) : Object.freeze({ kind: "at", commit: repository.head })) : Object.freeze({ kind: "at", commit: published });
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "repository-ref-observed", result: Object.freeze({ kind: "ok", value: Object.freeze({ observed, publicationRef: intent.inputs.publicationRef, repository: intent.inputs.repository, tree: repository?.tree ?? null }) }), runId: intent.runId }));
    }
    if (intent.kind === "materialize-workspace") return this.emit(Object.freeze({ actionId: intent.actionId, kind: "workspace-materialized", result: Object.freeze({ kind: "ok", value: Object.freeze({ baseCommit: intent.inputs.baseCommit, baseTree: intent.inputs.baseTree, repository: intent.inputs.repository, workspaceId: intent.inputs.workspaceId }) }), runId: intent.runId }));
    if (intent.kind === "seal-workspace") {
      const artifact = this.createCapture("workspace-seal", Object.freeze({ workspaceId: intent.inputs.workspaceId }));
      const gitTree = this.repositories.get(intent.inputs.repository)?.tree;
      if (artifact === null || gitTree === undefined) return Object.freeze({ kind: "rejected" });
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "workspace-sealed", result: Object.freeze({ kind: "ok", value: Object.freeze({ capture: Object.freeze({ artifact, objectIds: Object.freeze([]) }), gitTree, workspaceId: intent.inputs.workspaceId }) }), runId: intent.runId }));
    }
    if (intent.kind === "compare-roots") {
      const artifact = this.createCapture("git-diff", Object.freeze({ left: intent.inputs.leftTree, right: intent.inputs.rightTree }));
      if (artifact === null) return Object.freeze({ kind: "rejected" });
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "roots-compared", result: Object.freeze({ kind: "ok", value: Object.freeze({ diff: Object.freeze({ artifact, objectIds: Object.freeze([]) }), equal: intent.inputs.leftTree === intent.inputs.rightTree, leftTree: intent.inputs.leftTree, rightTree: intent.inputs.rightTree }) }), runId: intent.runId }));
    }
    if (intent.kind === "integrate-candidate") {
      const diff = this.createCapture("integration-diff", Object.freeze({ candidateId: intent.inputs.candidateId }));
      const manifest = this.createCapture("integration-manifest", Object.freeze({ root: intent.preconditions.expectedIntegrationRoot }));
      const attestation = this.createCapture("integration-attestation", Object.freeze({ gitTree: intent.inputs.candidateTree, root: intent.preconditions.expectedIntegrationRoot }));
      if (diff === null || manifest === null || attestation === null) return Object.freeze({ kind: "rejected" });
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "candidate-integrated", result: Object.freeze({ kind: "ok", value: Object.freeze({ candidateId: intent.inputs.candidateId, commit: intent.inputs.candidateCommit, conflict: null, diff: Object.freeze({ artifact: diff, objectIds: Object.freeze([]) }), kind: "integrated", manifest: Object.freeze({ artifact: manifest, objectIds: Object.freeze([]) }), tree: intent.inputs.candidateTree, treeAttestation: Object.freeze({ artifactRoot: intent.preconditions.expectedIntegrationRoot, attestation, gitTree: intent.inputs.candidateTree }) }) }), runId: intent.runId }));
    }
    const key = `${intent.inputs.repository}:${intent.inputs.publicationRef}`;
    this.publications.set(key, intent.inputs.desiredHead);
    return this.emit(Object.freeze({ actionId: intent.actionId, kind: "head-publication-observed", result: Object.freeze({ kind: "ok", value: Object.freeze({ desiredHead: intent.inputs.desiredHead, gitTree: intent.preconditions.candidateTree, observedHead: intent.inputs.desiredHead, publicationId: intent.inputs.publicationId, status: "desired-head" }) }), runId: intent.runId }));
  }

  private dispatchChild(input: JsonValue): unknown {
    const decoded = childIntentCapsule.decode(input);
    if (decoded.kind === "error") return Object.freeze({ kind: "rejected" });
    const intent = decoded.value;
    if (intent.kind === "verify-pi-route") {
      const launch = childIntentCapsule.arbitrary.validForKind("launch-child-session", 611);
      if (launch.kind !== "launch-child-session") return Object.freeze({ kind: "rejected" });
      const route = Object.freeze({ ...intent.inputs.route, toolBundleAttestation: null });
      this.routes.set(launch.preconditions.routeObservationId, route);
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "pi-route-verified", result: Object.freeze({ kind: "ok", value: Object.freeze({ observationId: launch.preconditions.routeObservationId, route, verified: true }) }), runId: intent.runId }));
    }
    if (intent.kind === "launch-child-session") {
      const template = launchedTemplate(620);
      const descriptor = this.createCapture("child-process-descriptor", Object.freeze({ childEpoch: intent.preconditions.childEpoch, runId: intent.runId, workspaceId: intent.inputs.workspaceId }));
      if (template === null || descriptor === null) return Object.freeze({ kind: "rejected" });
      const process = Object.freeze({ ...template.process, captureId: intent.inputs.captureId, childEpoch: intent.preconditions.childEpoch, lifecycle: Object.freeze({ kind: "running" }), workspaceId: intent.inputs.workspaceId });
      const session = Object.freeze({ ...template.session, process });
      const record: ChildRecord = { childId: template.childId, childEpoch: intent.preconditions.childEpoch, workspaceId: intent.inputs.workspaceId, processDescriptor: descriptor, process, session, processId: template.process.processId, processGroupId: template.process.processGroupId, fenced: false };
      this.children.set(record.childId, record);
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "child-session-launched", result: Object.freeze({ kind: "ok", value: Object.freeze({ childEpoch: record.childEpoch, childId: record.childId, process, processDescriptor: descriptor, session, workspaceId: record.workspaceId }) }), runId: intent.runId }));
    }
    if (intent.kind === "inspect-child-session") {
      const record = this.children.get(intent.inputs.childId);
      if (record === undefined) return this.emit(Object.freeze({ actionId: intent.actionId, kind: "child-session-inspected", result: retryResult("child-absent", "durable child descriptor is absent"), runId: intent.runId }));
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "child-session-inspected", result: Object.freeze({ kind: "ok", value: Object.freeze({ childEpoch: record.childEpoch, childId: record.childId, sealedRoot: null, session: record.session, state: record.fenced ? "absent" : "quiescent" }) }), runId: intent.runId }));
    }
    if (intent.kind === "fence-child-session") {
      const record = this.children.get(intent.inputs.childId);
      if (record === undefined) return this.emit(Object.freeze({ actionId: intent.actionId, kind: "child-session-fenced", result: retryResult("child-absent", "durable child descriptor is absent"), runId: intent.runId }));
      record.fenced = true;
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "child-session-fenced", result: Object.freeze({ kind: "ok", value: Object.freeze({ childId: record.childId, observedEpoch: record.childEpoch, processGroupId: record.processGroupId, processId: record.processId, state: "fenced" }) }), runId: intent.runId }));
    }
    const capture = this.createCapture(intent.kind === "execute-evidence-command" ? "evidence-command" : "validation-command", Object.freeze({ ruleId: intent.inputs.ruleId, workItemId: intent.inputs.workItemId }));
    if (capture === null) return Object.freeze({ kind: "rejected" });
    return this.emit(Object.freeze({ actionId: intent.actionId, kind: intent.kind === "execute-evidence-command" ? "evidence-command-executed" : "validation-command-executed", result: Object.freeze({ kind: "ok", value: Object.freeze({ capture, exit: Object.freeze({ code: "0", kind: "exited" }), stderrBytes: "0", stdoutBytes: "0" }) }), runId: intent.runId }));
  }

  private dispatchStore(input: JsonValue): unknown {
    const decoded = storeIntentCapsule.decode(input);
    if (decoded.kind === "error") return Object.freeze({ kind: "rejected" });
    const intent = decoded.value;
    if (intent.kind === "install-sealed-object") {
      const key = intent.inputs.artifact.digest;
      const alreadyPresent = this.installed.has(key);
      this.installed.add(key);
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "sealed-object-installed", result: Object.freeze({ kind: "ok", value: Object.freeze({ alreadyPresent, artifact: intent.inputs.artifact }) }), runId: intent.runId }));
    }
    if (intent.kind === "read-artifact-range") {
      const read = this.world.artifacts.read(intent.inputs.artifact);
      return read.kind === "ok" ? this.emit(Object.freeze({ actionId: intent.actionId, kind: "artifact-range-read", result: Object.freeze({ kind: "ok", value: Object.freeze({ content: intent.inputs.artifact, requested: intent.inputs.artifact }) }), runId: intent.runId })) : this.emit(Object.freeze({ actionId: intent.actionId, kind: "artifact-range-read", result: retryResult("artifact-unproven", "requested artifact range is absent"), runId: intent.runId }));
    }
    if (intent.kind === "list-artifact-page") {
      const tree = this.world.artifacts.get(intent.inputs.root);
      if (tree === null) return this.emit(Object.freeze({ actionId: intent.actionId, kind: "artifact-page-listed", result: retryResult("page-unproven", "artifact root is absent"), runId: intent.runId }));
      const index = intent.inputs.cursor === null ? 0 : 1;
      const entry = tree.files[index] ?? null;
      const entries = this.createCapture(`artifact-page-${String(index)}`, Object.freeze({ directory: intent.inputs.directory, entry: entry === null ? null : Object.freeze({ path: entry.path, bytes: String(entry.bytes.byteLength) }), root: intent.inputs.root }));
      if (entries === null) return Object.freeze({ kind: "rejected" });
      const nextCursor = index + 1 < tree.files.length ? `cursor-${String(index + 1)}` : null;
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "artifact-page-listed", result: Object.freeze({ kind: "ok", value: Object.freeze({ entries, nextCursor, pageSize: intent.inputs.pageSize, previousPageProof: intent.inputs.previousPageProof, root: intent.inputs.root }) }), runId: intent.runId }));
    }
    const present = this.world.artifacts.read(intent.inputs.artifact).kind === "ok";
    return this.emit(Object.freeze({ actionId: intent.actionId, kind: "object-presence-observed", result: Object.freeze({ kind: "ok", value: Object.freeze({ artifact: intent.inputs.artifact, present }) }), runId: intent.runId }));
  }

  private dispatchClock(input: JsonValue): unknown {
    const decoded = clockIntentCapsule.decode(input);
    if (decoded.kind === "error") return Object.freeze({ kind: "rejected" });
    const intent = decoded.value;
    const notBefore = BigInt(intent.preconditions.notBeforeTick);
    const result = this.clockTick < notBefore ? retryResult("clock-not-ready", "monotonic clock has not reached notBeforeTick") : Object.freeze({ kind: "ok", value: Object.freeze({ clockId: intent.inputs.clockId, sourceDigest: intent.preconditions.sourceDigest, tick: this.clockTick.toString() }) });
    return this.emit(Object.freeze({ actionId: intent.actionId, kind: "clock-observed", result, runId: intent.runId }));
  }

  private dispatchSecrets(input: JsonValue): unknown {
    const decoded = secretsIntentCapsule.decode(input);
    if (decoded.kind === "error") return Object.freeze({ kind: "rejected" });
    const intent = decoded.value;
    if (intent.kind === "authorize-secret-use") {
      if (!this.secrets.has(intent.inputs.secretHandle)) return this.emit(Object.freeze({ actionId: intent.actionId, kind: "secret-use-authorized", result: retryResult("secret-absent", "opaque secret handle is absent"), runId: intent.runId }));
      const template = authorizedTemplate(710);
      if (template === null) return Object.freeze({ kind: "rejected" });
      return this.emit(Object.freeze({ actionId: intent.actionId, kind: "secret-use-authorized", result: Object.freeze({ kind: "ok", value: Object.freeze({ destination: intent.inputs.destination, leaseId: template.leaseId, purposeId: intent.inputs.purposeId, secretHandle: intent.inputs.secretHandle }) }), runId: intent.runId }));
    }
    const already = this.revokedLeases.has(intent.inputs.leaseId);
    this.revokedLeases.add(intent.inputs.leaseId);
    return this.emit(Object.freeze({ actionId: intent.actionId, kind: "secret-use-revoked", result: Object.freeze({ kind: "ok", value: Object.freeze({ leaseId: intent.inputs.leaseId, secretHandle: intent.inputs.secretHandle, state: already ? "already-revoked" : "revoked" }) }), runId: intent.runId }));
  }

  private createArtifact(path: string, bytes: Uint8Array): ArtifactRef | null {
    const created = this.world.artifacts.createBlob(path, bytes);
    return created.kind === "ok" ? this.world.artifacts.reference(created.tree.root, path) : null;
  }

  private createCapture(label: string, value: JsonValue): ArtifactRef | null {
    this.captureSequence += 1;
    return this.createArtifact(`law/capture-${String(this.captureSequence)}-${label}.json`, canonicalEncodeUnknown(value));
  }

  private emit(observation: unknown): unknown {
    const value = this.jsonObservation(observation);
    if (value !== null) this.world.trace.append(this.world.clock.now(), "contract", "law-driver", "observation", `observation:${String(this.world.trace.snapshot().length)}`, value);
    return execution(observation);
  }

  private jsonObservation(input: unknown): JsonValue | null {
    return traceJson(input);
  }

}
