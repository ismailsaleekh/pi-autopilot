import { gitIntentCapsule } from "../../ports/contracts/git.capsule.js";
import { storeIntentCapsule } from "../../ports/contracts/store.capsule.js";
import type { InstallSealedObject } from "../../ports/contracts/store.capsule.js";
import type { ArtifactRef, ArtifactRoot } from "../../authority/protocol/identifiers.js";
import type { JsonValue } from "../../authority/protocol/schema.js";
import { bindLawIntent } from "../../ports/laws/contract-vector.js";
import { SimWorld } from "../simulation/sim-world.js";
import { encodeUtf8, revisionIdFor } from "../simulation/values.js";
import type { CrashDriveResult, CrashScenario } from "./harness.js";
import { SimJournal } from "./sim-journal.js";

interface ToyInputs {
  readonly root: ArtifactRoot;
  readonly manifest: ArtifactRef;
  readonly install: InstallSealedObject;
}

function toyInputs(world: SimWorld): ToyInputs | null {
  const tree = world.createArtifact(Object.freeze([
    Object.freeze({ path: "toy/value.bin", bytes: Uint8Array.from([0, 1, 2, 3, 255]) }),
  ]));
  const manifestTree = world.artifacts.createBlob(
    "toy/manifest.json",
    encodeUtf8("{\"format\":\"toy.v1\"}"),
  );
  if (tree.kind !== "ok" || manifestTree.kind !== "ok") {
    return null;
  }
  const manifest = world.artifacts.reference(manifestTree.tree.root, "toy/manifest.json");
  const template = storeIntentCapsule.arbitrary.validForKind("install-sealed-object", 91);
  if (manifest === null || template.kind !== "install-sealed-object") {
    return null;
  }
  const bound = bindLawIntent("store", Object.freeze({
    inputs: Object.freeze({
      manifest,
      sealedRoot: tree.tree.root,
      workspaceId: template.inputs.workspaceId,
    }),
    kind: "install-sealed-object",
    preconditions: Object.freeze({
      expectedDigest: tree.tree.root,
      objectFirst: true,
    }),
    runId: template.runId,
  }));
  if (bound === null) {
    return null;
  }
  const encoded = storeIntentCapsule.encodeUnknown(bound);
  if (encoded.kind === "error") {
    return null;
  }
  const decoded = storeIntentCapsule.decodeCanonical(encoded.value);
  if (decoded.kind === "error" || decoded.value.kind !== "install-sealed-object") {
    return null;
  }
  return Object.freeze({ root: tree.tree.root, manifest, install: decoded.value });
}

function recordKind(value: JsonValue): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate: unknown = Reflect.get(value, "kind");
  return typeof candidate === "string" ? candidate : null;
}

function driveToy(world: SimWorld): CrashDriveResult {
  const inputs = toyInputs(world);
  if (inputs === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "toy inputs could not be built" });
  }
  const journal = new SimJournal(world);
  if (!world.isAlive()) {
    return Object.freeze({ kind: "crashed" });
  }
  const replay = journal.replay();
  if (replay.kind === "invalid" || replay.tornSuffix) {
    return Object.freeze({ kind: "invalid", diagnostic: "toy journal does not have a valid complete prefix" });
  }
  const hasInstalled = replay.records.some((record) => recordKind(record) === "object-installed");
  const hasDone = replay.records.some((record) => recordKind(record) === "done");
  if (!hasInstalled) {
    const installed = world.dispatch("store", inputs.install);
    if (installed.kind === "crashed" || !world.isAlive()) {
      return Object.freeze({ kind: "crashed" });
    }
    if (
      installed.kind !== "observation"
      || installed.observation.kind !== "sealed-object-installed"
      || installed.observation.result.kind !== "ok"
    ) {
      return Object.freeze({ kind: "invalid", diagnostic: "toy object install did not produce an ok observation" });
    }
    const appended = journal.append(Object.freeze({ kind: "object-installed", root: inputs.root }));
    return appended.kind === "crashed"
      ? Object.freeze({ kind: "crashed" })
      : appended.kind === "invalid"
        ? Object.freeze({ kind: "invalid", diagnostic: appended.diagnostic })
        : Object.freeze({ kind: "progress" });
  }
  if (!hasDone) {
    const appended = journal.append(Object.freeze({ kind: "done", root: inputs.root }));
    return appended.kind === "crashed"
      ? Object.freeze({ kind: "crashed" })
      : appended.kind === "invalid"
        ? Object.freeze({ kind: "invalid", diagnostic: appended.diagnostic })
        : Object.freeze({ kind: "progress" });
  }
  world.trace.append(
    world.clock.now(),
    "semantic",
    "toy",
    "complete",
    `toy:complete:${inputs.root}`,
    Object.freeze({ root: inputs.root }),
  );
  return Object.freeze({ kind: "complete" });
}

export const toyCrashScenario: CrashScenario = Object.freeze({
  id: "toy-object-first-journal-second",
  create: () => new SimWorld(0x5eed_1234),
  drive: driveToy,
  completed: (world: SimWorld) => world.trace.snapshot().some((event) => (
    event.category === "semantic" && event.source === "toy" && event.name === "complete"
  )),
  maxDrives: 16,
});

export const TOY_CRASH_POINTS = Object.freeze([
  "store.install.append",
  "store.install.file-fsync",
  "store.install.rename",
  "store.install.directory-fsync",
  "store.install.ack",
  "journal.append",
  "journal.fsync",
  "journal.ack",
]);

function driveGitToy(world: SimWorld): CrashDriveResult {
  const base = world.createArtifact(Object.freeze([
    Object.freeze({ path: "toy/base.bin", bytes: Uint8Array.from([1]) }),
  ]));
  const candidate = world.createArtifact(Object.freeze([
    Object.freeze({ path: "toy/base.bin", bytes: Uint8Array.from([2]) }),
  ]));
  const materializeTemplate = gitIntentCapsule.arbitrary.validForKind("materialize-workspace", 181);
  const integrateTemplate = gitIntentCapsule.arbitrary.validForKind("integrate-candidate", 182);
  const publishTemplate = gitIntentCapsule.arbitrary.validForKind("publish-if-expected-head", 183);
  if (
    base.kind !== "ok"
    || candidate.kind !== "ok"
    || materializeTemplate.kind !== "materialize-workspace"
    || integrateTemplate.kind !== "integrate-candidate"
    || publishTemplate.kind !== "publish-if-expected-head"
  ) {
    return Object.freeze({ kind: "invalid", diagnostic: "git toy fixtures could not be built" });
  }
  const baseHead = revisionIdFor(Object.freeze({ base: base.tree.root, toy: "git" }));
  if (world.git.head(materializeTemplate.runId) === null) {
    const seeded = world.seedRepository(Object.freeze({
      head: baseHead,
      identity: base.tree.root,
      kind: "repository",
      runId: materializeTemplate.runId,
      tree: base.tree.root,
    }));
    if (seeded.kind !== "seeded") {
      return Object.freeze({ kind: "invalid", diagnostic: seeded.diagnostic });
    }
  }
  const roots = world.git.createAcceptedOutputs(Object.freeze([candidate.tree.root]));
  if (roots === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "git toy root list could not be built" });
  }
  const integrate = bindLawIntent("git", Object.freeze({
    inputs: Object.freeze({
      acceptedOutputs: roots,
      baseRevision: baseHead,
      candidateId: integrateTemplate.inputs.candidateId,
    }),
    kind: "integrate-candidate",
    preconditions: Object.freeze({
      expectedIntegrationRoot: base.tree.root,
      repositoryIdentity: base.tree.root,
    }),
    runId: materializeTemplate.runId,
  }));
  if (integrate === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "git toy integration intent could not be bound" });
  }
  const integrated = world.dispatch("git", integrate);
  if (integrated.kind === "crashed" || !world.isAlive()) {
    return Object.freeze({ kind: "crashed" });
  }
  if (
    integrated.kind !== "observation"
    || integrated.observation.kind !== "candidate-integrated"
    || integrated.observation.result.kind !== "ok"
  ) {
    return Object.freeze({ kind: "invalid", diagnostic: "git toy integration was rejected" });
  }
  const value = integrated.observation.result.value;
  const publish = bindLawIntent("git", Object.freeze({
    inputs: Object.freeze({
      desiredHead: value.revision,
      expectedHead: baseHead,
      publicationId: publishTemplate.inputs.publicationId,
    }),
    kind: "publish-if-expected-head",
    preconditions: Object.freeze({
      candidateTree: value.tree,
      publicationLease: publishTemplate.preconditions.publicationLease,
      verifiedManifest: value.manifest,
    }),
    runId: materializeTemplate.runId,
  }));
  if (publish === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "git toy publication intent could not be bound" });
  }
  const published = world.dispatch("git", publish);
  if (published.kind === "crashed" || !world.isAlive()) {
    return Object.freeze({ kind: "crashed" });
  }
  if (
    published.kind !== "observation"
    || published.observation.kind !== "head-publication-observed"
    || published.observation.result.kind !== "ok"
    || published.observation.result.value.status === "head-moved"
  ) {
    return Object.freeze({ kind: "invalid", diagnostic: "git toy publication was not observed" });
  }
  world.trace.append(
    world.clock.now(),
    "semantic",
    "toy-git",
    "complete",
    `toy-git:complete:${value.revision}`,
    Object.freeze({ revision: value.revision }),
  );
  return Object.freeze({ kind: "complete" });
}

export const toyGitCrashScenario: CrashScenario = Object.freeze({
  id: "toy-git-publication-cas",
  create: () => new SimWorld(0x5eed_5678),
  drive: driveGitToy,
  completed: (world: SimWorld) => world.trace.snapshot().some((event) => (
    event.category === "semantic" && event.source === "toy-git" && event.name === "complete"
  )),
  maxDrives: 8,
});

export const GIT_TOY_CRASH_POINTS = Object.freeze([
  "git.publish.before-read",
  "git.publish.after-read",
  "git.publish.before-cas",
  "git.publish.after-cas",
  "git.publish.ack",
]);
