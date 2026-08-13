import {
  actionIdSchema,
  childEpochSchema,
  digestSchema,
  leaseIdSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ActionId,
  ArtifactRef,
  ArtifactRoot,
  ChildEpoch,
  Digest,
  LeaseId,
  RevisionId,
  RunId,
} from "../../authority/protocol/identifiers.js";
import type {
  BuildIntegratedCandidate,
  InspectChild,
  LaunchChild,
  PrepareWorkspace,
  PublishCompareAndSwap,
} from "../../authority/protocol/command.capsule.js";
import {
  canonicalDigestUnknown,
  defineCapsule,
} from "../../authority/protocol/schema.js";
import type {
  JsonValue,
  SchemaCapsule,
} from "../../authority/protocol/schema.js";
import {
  childIntentCapsule,
} from "../../ports/contracts/child.capsule.js";
import type {
  ChildIntent,
  InspectChildSession,
  LaunchChildSession,
} from "../../ports/contracts/child.capsule.js";
import {
  gitIntentCapsule,
} from "../../ports/contracts/git.capsule.js";
import type {
  GitIntent,
  IntegrateCandidate,
  PublishIfExpectedHead,
} from "../../ports/contracts/git.capsule.js";
import {
  workspaceIntentCapsule,
} from "../../ports/contracts/workspace.capsule.js";
import type {
  AllocateAttemptDirectory,
  ApplyAttemptIsolation,
  InspectAttemptDirectory,
  WorkspaceIntent,
} from "../../ports/contracts/workspace.capsule.js";
import type {
  BoundaryFeedback,
  BoundaryResult,
  RuntimePortName,
} from "../boundary-codecs/index.js";

interface JsonObject {
  readonly [field: string]: JsonValue;
}

interface IntentSeed {
  readonly runId: RunId;
  readonly kind: string;
  readonly inputs: JsonObject;
  readonly preconditions: JsonObject;
}

export interface GitDispatchBinding {
  readonly repositoryBase: RevisionId;
  readonly repositoryIdentity: ArtifactRoot;
}

const actionIdCapsule = defineCapsule("RuntimePortActionId", actionIdSchema);
const leaseIdCapsule = defineCapsule("RuntimePortLeaseId", leaseIdSchema);
const childEpochCapsule = defineCapsule("RuntimePortChildEpoch", childEpochSchema);
const digestCapsule = defineCapsule("RuntimePortDigest", digestSchema);

function buildFeedback(path: string, diagnostic: string): BoundaryFeedback {
  return Object.freeze({
    kind: "feedback",
    code: "boundary-schema",
    path,
    diagnostic,
  });
}

function derivedActionId(port: RuntimePortName, seed: IntentSeed): ActionId | null {
  const digest = canonicalDigestUnknown(Object.freeze({
    domain: "pi-autopilot.action.v1",
    inputs: seed.inputs,
    kind: seed.kind,
    port,
    preconditions: seed.preconditions,
    runId: seed.runId,
  }));
  const decoded = actionIdCapsule.decode(`action:sha256:${digest.slice(7)}`);
  return decoded.kind === "ok" ? decoded.value : null;
}

function derivedLease(label: JsonValue): LeaseId | null {
  const digest = canonicalDigestUnknown(Object.freeze({
    domain: "pi-autopilot.dispatch-lease.v1",
    label,
  }));
  const decoded = leaseIdCapsule.decode(`lease:sha256:${digest.slice(7)}`);
  return decoded.kind === "ok" ? decoded.value : null;
}

function derivedEpoch(label: JsonValue): ChildEpoch | null {
  const digest = canonicalDigestUnknown(Object.freeze({
    domain: "pi-autopilot.child-epoch.v1",
    label,
  }));
  const decoded = childEpochCapsule.decode(`epoch:sha256:${digest.slice(7)}`);
  return decoded.kind === "ok" ? decoded.value : null;
}

function digestFromRoot(root: ArtifactRoot): Digest | null {
  const decoded = digestCapsule.decode(String(root));
  return decoded.kind === "ok" ? decoded.value : null;
}

function bindIntent<Name extends string, Value>(
  port: RuntimePortName,
  seed: IntentSeed,
  capsule: SchemaCapsule<Name, Value>,
): BoundaryResult<Value> {
  const actionId = derivedActionId(port, seed);
  if (actionId === null) {
    return buildFeedback("$.actionId", "port action identity could not be derived");
  }
  const encoded = capsule.encodeUnknown(Object.freeze({
    actionId,
    inputs: seed.inputs,
    kind: seed.kind,
    preconditions: seed.preconditions,
    runId: seed.runId,
  }));
  if (encoded.kind === "error") {
    return buildFeedback(encoded.error.path, encoded.error.diagnostic);
  }
  const decoded = capsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok"
    ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: encoded.value.slice() })
    : buildFeedback(decoded.error.path, decoded.error.diagnostic);
}

function workspaceIntent(seed: IntentSeed): BoundaryResult<WorkspaceIntent> {
  return bindIntent("workspace", seed, workspaceIntentCapsule);
}

function childIntent(seed: IntentSeed): BoundaryResult<ChildIntent> {
  return bindIntent("child", seed, childIntentCapsule);
}

function gitIntent(seed: IntentSeed): BoundaryResult<GitIntent> {
  return bindIntent("git", seed, gitIntentCapsule);
}

export function prepareWorkspaceIntent(
  command: PrepareWorkspace,
): BoundaryResult<AllocateAttemptDirectory> {
  const leaseId = derivedLease(Object.freeze({ commandId: command.commandId, workspaceId: command.workspaceId }));
  if (leaseId === null) {
    return buildFeedback("$.preconditions.leaseId", "workspace lease identity could not be derived");
  }
  const decoded = workspaceIntent(Object.freeze({
    runId: command.runId,
    kind: "allocate-attempt-directory",
    inputs: Object.freeze({
      baseRoot: command.baseRoot,
      workspaceId: command.workspaceId,
    }),
    preconditions: Object.freeze({
      expectedAbsent: true,
      leaseId,
    }),
  }));
  if (decoded.kind !== "ok") {
    return decoded;
  }
  return decoded.value.kind === "allocate-attempt-directory"
    ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: decoded.canonicalBytes })
    : buildFeedback("$.kind", "workspace constructor produced the wrong intent kind");
}

export function inspectWorkspaceIntent(
  command: LaunchChild,
): BoundaryResult<InspectAttemptDirectory> {
  const leaseId = derivedLease(Object.freeze({ commandId: command.commandId, workspaceId: command.workspaceId }));
  if (leaseId === null) {
    return buildFeedback("$.preconditions.leaseId", "workspace inspection lease could not be derived");
  }
  const decoded = workspaceIntent(Object.freeze({
    runId: command.runId,
    kind: "inspect-attempt-directory",
    inputs: Object.freeze({ workspaceId: command.workspaceId }),
    preconditions: Object.freeze({ leaseId }),
  }));
  if (decoded.kind !== "ok") {
    return decoded;
  }
  return decoded.value.kind === "inspect-attempt-directory"
    ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: decoded.canonicalBytes })
    : buildFeedback("$.kind", "workspace constructor produced the wrong inspection kind");
}

export function isolateWorkspaceIntent(
  command: LaunchChild,
  expectedWorkspaceRoot: ArtifactRoot,
): BoundaryResult<ApplyAttemptIsolation> {
  const expectedPolicyDigest = digestFromRoot(command.policyRoot);
  if (expectedPolicyDigest === null) {
    return buildFeedback("$.preconditions.expectedPolicyDigest", "policy root is not a canonical digest");
  }
  const decoded = workspaceIntent(Object.freeze({
    runId: command.runId,
    kind: "apply-attempt-isolation",
    inputs: Object.freeze({
      isolationPolicyRoot: command.policyRoot,
      workspaceId: command.workspaceId,
    }),
    preconditions: Object.freeze({
      expectedPolicyDigest,
      expectedWorkspaceRoot,
    }),
  }));
  if (decoded.kind !== "ok") {
    return decoded;
  }
  return decoded.value.kind === "apply-attempt-isolation"
    ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: decoded.canonicalBytes })
    : buildFeedback("$.kind", "workspace constructor produced the wrong isolation kind");
}

export function launchChildIntent(
  command: LaunchChild,
  expectedWorkspaceRoot: ArtifactRoot,
): BoundaryResult<LaunchChildSession> {
  const childEpoch = derivedEpoch(Object.freeze({
    attemptId: command.attemptId,
    commandId: command.commandId,
    workspaceId: command.workspaceId,
  }));
  const runtimeDigest = digestFromRoot(command.runtimeRoot);
  if (childEpoch === null || runtimeDigest === null) {
    return buildFeedback("$.preconditions", "child epoch or runtime digest could not be derived");
  }
  const decoded = childIntent(Object.freeze({
    runId: command.runId,
    kind: "launch-child-session",
    inputs: Object.freeze({
      attemptId: command.attemptId,
      prompt: command.prompt,
      roleId: command.roleId,
      runtimeRoot: command.runtimeRoot,
      workItemId: command.workItemId,
      workspaceId: command.workspaceId,
    }),
    preconditions: Object.freeze({
      childEpoch,
      expectedWorkspaceRoot,
      runtimeDigest,
    }),
  }));
  if (decoded.kind !== "ok") {
    return decoded;
  }
  return decoded.value.kind === "launch-child-session"
    ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: decoded.canonicalBytes })
    : buildFeedback("$.kind", "child constructor produced the wrong launch kind");
}

export function inspectChildIntent(
  command: InspectChild,
): BoundaryResult<InspectChildSession> {
  const decoded = childIntent(Object.freeze({
    runId: command.runId,
    kind: "inspect-child-session",
    inputs: Object.freeze({ childId: command.childId }),
    preconditions: Object.freeze({ childEpoch: command.childEpoch }),
  }));
  if (decoded.kind !== "ok") {
    return decoded;
  }
  return decoded.value.kind === "inspect-child-session"
    ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: decoded.canonicalBytes })
    : buildFeedback("$.kind", "child constructor produced the wrong inspection kind");
}

export function integrateCandidateIntent(
  command: BuildIntegratedCandidate,
  binding: GitDispatchBinding,
): BoundaryResult<IntegrateCandidate> {
  const decoded = gitIntent(Object.freeze({
    runId: command.runId,
    kind: "integrate-candidate",
    inputs: Object.freeze({
      acceptedOutputs: command.acceptedOutputs,
      baseRevision: binding.repositoryBase,
      candidateId: command.candidateId,
    }),
    preconditions: Object.freeze({
      expectedIntegrationRoot: command.baseRoot,
      repositoryIdentity: binding.repositoryIdentity,
    }),
  }));
  if (decoded.kind !== "ok") {
    return decoded;
  }
  return decoded.value.kind === "integrate-candidate"
    ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: decoded.canonicalBytes })
    : buildFeedback("$.kind", "git constructor produced the wrong integration kind");
}

export function publishCandidateIntent(
  command: PublishCompareAndSwap,
  manifest: ArtifactRef,
): BoundaryResult<PublishIfExpectedHead> {
  const publicationLease = derivedLease(Object.freeze({
    commandId: command.commandId,
    publicationId: command.publicationId,
  }));
  if (publicationLease === null) {
    return buildFeedback("$.preconditions.publicationLease", "publication lease could not be derived");
  }
  const decoded = gitIntent(Object.freeze({
    runId: command.runId,
    kind: "publish-if-expected-head",
    inputs: Object.freeze({
      desiredHead: command.desiredHead,
      expectedHead: command.expectedHead,
      publicationId: command.publicationId,
    }),
    preconditions: Object.freeze({
      candidateTree: command.candidateTree,
      publicationLease,
      verifiedManifest: manifest,
    }),
  }));
  if (decoded.kind !== "ok") {
    return decoded;
  }
  return decoded.value.kind === "publish-if-expected-head"
    ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: decoded.canonicalBytes })
    : buildFeedback("$.kind", "git constructor produced the wrong publication kind");
}
