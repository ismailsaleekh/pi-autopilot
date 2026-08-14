import type {
  ApplyWorkspaceIsolation,
  BuildIntegratedCandidate,
  Command,
  ExecuteEvidence,
  ExecuteValidationRule,
  InspectChild,
  InstallArtifactCommand,
  LaunchChild,
  MaterializeWorkspace,
  ObserveClockCommand,
  PrepareWorkspace,
  PublishCompareAndSwap,
  VerifyChildRoute,
} from "../../authority/protocol/command.capsule.js";
import {
  childIntentCapsule,
} from "../../ports/contracts/child.capsule.js";
import type {
  ExecuteEvidenceCommand,
  ExecuteValidationCommand,
  InspectChildSession,
  LaunchChildSession,
  VerifyPiRoute,
} from "../../ports/contracts/child.capsule.js";
import { clockIntentCapsule } from "../../ports/contracts/clock.capsule.js";
import type { ObserveClock } from "../../ports/contracts/clock.capsule.js";
import { gitIntentCapsule } from "../../ports/contracts/git.capsule.js";
import type {
  IntegrateCandidate,
  MaterializeWorkspace as MaterializeWorkspaceIntent,
  PublishIfExpectedHead,
} from "../../ports/contracts/git.capsule.js";
import { storeIntentCapsule } from "../../ports/contracts/store.capsule.js";
import type { InstallSealedObject } from "../../ports/contracts/store.capsule.js";
import { workspaceIntentCapsule } from "../../ports/contracts/workspace.capsule.js";
import type {
  AllocateAttemptDirectory,
  ApplyAttemptIsolation,
} from "../../ports/contracts/workspace.capsule.js";
import type { BoundaryFeedback, BoundaryResult } from "../boundary-codecs/index.js";

function feedback(path: string, diagnostic: string): BoundaryFeedback {
  return Object.freeze({ kind: "feedback", code: "boundary-schema", path, diagnostic });
}

interface IntentCapsuleLike<Intent> {
  readonly encodeUnknown: (value: unknown) => { readonly kind: "ok"; readonly value: Uint8Array } | { readonly kind: "error"; readonly error: { readonly path: string; readonly diagnostic: string } };
  readonly decodeCanonical: (value: Uint8Array) => { readonly kind: "ok"; readonly value: Intent } | { readonly kind: "error"; readonly error: { readonly path: string; readonly diagnostic: string } };
}

function hasKind<Union extends { readonly kind: string }, Kind extends Union["kind"]>(
  value: Union,
  kind: Kind,
): value is Extract<Union, { readonly kind: Kind }> {
  return value.kind === kind;
}

function normalize<Union extends { readonly actionId: Command["actionId"]; readonly kind: string }, Kind extends Union["kind"]>(
  capsule: IntentCapsuleLike<Union>,
  input: unknown,
  expectedKind: Kind,
): BoundaryResult<Extract<Union, { readonly kind: Kind }>> {
  const encoded = capsule.encodeUnknown(input);
  if (encoded.kind === "error") {
    return feedback(encoded.error.path, encoded.error.diagnostic);
  }
  const decoded = capsule.decodeCanonical(encoded.value);
  if (decoded.kind === "error") {
    return feedback(decoded.error.path, decoded.error.diagnostic);
  }
  if (!hasKind(decoded.value, expectedKind)) {
    return feedback("$.kind", "intent capsule decoded a different closed operation");
  }
  return Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: encoded.value });
}

function envelope(command: Command, kind: string, inputs: object, preconditions: object) {
  return Object.freeze({
    actionId: command.actionId,
    inputs: Object.freeze(inputs),
    kind,
    preconditions: Object.freeze(preconditions),
    runId: command.runId,
  });
}

export function prepareWorkspaceIntent(command: PrepareWorkspace): BoundaryResult<AllocateAttemptDirectory> {
  return normalize(workspaceIntentCapsule, envelope(command, "allocate-attempt-directory", {
    workspaceCapability: command.workspaceCapability,
    workspaceId: command.workspaceId,
  }, {
    expectedAbsent: true,
    leaseId: command.leaseId,
  }), "allocate-attempt-directory");
}

export function applyWorkspaceIsolationIntent(command: ApplyWorkspaceIsolation): BoundaryResult<ApplyAttemptIsolation> {
  return normalize(workspaceIntentCapsule, envelope(command, "apply-attempt-isolation", {
    isolationPolicy: command.isolationPolicy,
    workspaceCapability: command.workspaceCapability,
    workspaceId: command.workspaceId,
  }, {
    childEpoch: command.childEpoch,
    expectedPolicyDigest: command.expectedPolicyDigest,
    expectedWorkspaceRoot: command.expectedWorkspaceRoot,
    leaseId: command.leaseId,
  }), "apply-attempt-isolation");
}

export function materializeWorkspaceIntent(command: MaterializeWorkspace): BoundaryResult<MaterializeWorkspaceIntent> {
  return normalize(gitIntentCapsule, envelope(command, "materialize-workspace", {
    baseCommit: command.baseCommit,
    baseTree: command.baseTree,
    repository: command.repository,
    workspaceCapability: command.workspaceCapability,
    workspaceId: command.workspaceId,
  }, {
    expectedEmptyReservation: true,
    reservationLease: command.reservationLease,
  }), "materialize-workspace");
}

export function verifyChildRouteIntent(command: VerifyChildRoute): BoundaryResult<VerifyPiRoute> {
  return normalize(childIntentCapsule, envelope(command, "verify-pi-route", {
    captureId: command.captureId,
    route: command.route,
  }, {
    deadlineTick: command.deadlineTick,
    oauthSubscriptionOnly: true,
  }), "verify-pi-route");
}

export function launchChildIntent(command: LaunchChild): BoundaryResult<LaunchChildSession> {
  return normalize(childIntentCapsule, envelope(command, "launch-child-session", {
    attemptId: command.attemptId,
    captureId: command.captureId,
    memorySeed: command.memorySeed,
    policyRoot: command.policyRoot,
    roleId: command.roleId,
    route: command.route,
    runtimeRoot: command.runtimeRoot,
    workItemId: command.workItemId,
    workspaceCapability: command.workspaceCapability,
    workspaceId: command.workspaceId,
  }, {
    childEpoch: command.childEpoch,
    deadlineTick: command.deadlineTick,
    expectedWorkspaceRoot: command.expectedWorkspaceRoot,
    maxStderrBytes: command.maxStderrBytes,
    maxStdoutBytes: command.maxStdoutBytes,
    routeObservation: command.routeObservation,
    routeObservationId: command.routeObservationId,
  }), "launch-child-session");
}

export function inspectChildIntent(command: InspectChild): BoundaryResult<InspectChildSession> {
  return normalize(childIntentCapsule, envelope(command, "inspect-child-session", {
    childId: command.childId,
    processDescriptor: command.processDescriptor,
  }, {
    childEpoch: command.childEpoch,
  }), "inspect-child-session");
}

export function evidenceIntent(command: ExecuteEvidence): BoundaryResult<ExecuteEvidenceCommand> {
  return normalize(childIntentCapsule, envelope(command, "execute-evidence-command", {
    candidateTree: command.candidateTree,
    commandSpec: command.commandSpec,
    ruleId: command.ruleId,
    workItemId: command.workItemId,
    workspaceCapability: command.workspaceCapability,
    workspaceId: command.workspaceId,
  }, { deadlineTick: command.deadlineTick }), "execute-evidence-command");
}

export function validationIntent(command: ExecuteValidationRule): BoundaryResult<ExecuteValidationCommand> {
  return normalize(childIntentCapsule, envelope(command, "execute-validation-command", {
    candidateTree: command.candidateTree,
    ruleId: command.ruleId,
    ruleInputs: command.inputs,
    workItemId: command.workItemId,
  }, { deadlineTick: command.deadlineTick }), "execute-validation-command");
}

export function integrateCandidateIntent(command: BuildIntegratedCandidate): BoundaryResult<IntegrateCandidate> {
  return normalize(gitIntentCapsule, envelope(command, "integrate-candidate", {
    baseCommit: command.baseCommit,
    baseTree: command.baseTree,
    candidateCommit: command.candidateCommit,
    candidateId: command.candidateId,
    candidateTree: command.candidateTree,
    repository: command.repository,
    workspaceCapability: command.integrationWorkspace,
  }, {
    expectedIntegrationRoot: command.baseRoot,
    oneCandidate: true,
  }), "integrate-candidate");
}

export function publishCandidateIntent(command: PublishCompareAndSwap): BoundaryResult<PublishIfExpectedHead> {
  return normalize(gitIntentCapsule, envelope(command, "publish-if-expected-head", {
    desiredHead: command.desiredHead,
    expected: command.expected,
    publicationId: command.publicationId,
    publicationRef: command.publicationRef,
    repository: command.repository,
  }, {
    candidateTree: command.candidateTree,
    publicationLease: command.publicationLease,
    verifiedAttestation: command.verifiedAttestation,
  }), "publish-if-expected-head");
}

export function observeClockIntent(command: ObserveClockCommand): BoundaryResult<ObserveClock> {
  return normalize(clockIntentCapsule, envelope(command, "observe-clock", {
    clockId: command.clockId,
  }, {
    notBeforeTick: command.notBeforeTick,
    sourceDigest: command.sourceDigest,
  }), "observe-clock");
}

export function installArtifactIntent(command: InstallArtifactCommand): BoundaryResult<InstallSealedObject> {
  return normalize(storeIntentCapsule, envelope(command, "install-sealed-object", {
    artifact: command.artifact,
  }, {
    expectedDigest: command.artifact.digest,
    objectFirst: true,
  }), "install-sealed-object");
}

void (workspaceIntentCapsule satisfies typeof workspaceIntentCapsule);
void (childIntentCapsule satisfies typeof childIntentCapsule);
void (gitIntentCapsule satisfies typeof gitIntentCapsule);
void (storeIntentCapsule satisfies typeof storeIntentCapsule);
void (clockIntentCapsule satisfies typeof clockIntentCapsule);
