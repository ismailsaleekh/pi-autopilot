import { expectedRefStateSchema, gitTreeCasAttestationSchema } from "./git-values.js";
import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  candidateIdSchema,
  captureIdSchema,
  childEpochSchema,
  childIdSchema,
  commandIdSchema,
  decimalNaturalSchema,
  digestSchema,
  gitCommitIdSchema,
  gitRefSchema,
  gitTreeIdSchema,
  leaseIdSchema,
  planRootIdSchema,
  publicationIdSchema,
  repositoryCapabilitySchema,
  roleIdSchema,
  routeObservationIdSchema,
  ruleIdSchema,
  runIdSchema,
  workItemIdSchema,
  workspaceCapabilitySchema,
  workspaceIdSchema,
} from "./identifiers.js";
import { childMemorySeedSchema, subscriptionRouteSchema } from "./route.capsule.js";
import {
  canonicalDigestUnknown,
  defineCapsule,
  literal,
  object,
  union,
} from "./schema.js";
import type { Infer, JsonValue } from "./schema.js";

const commandEnvelope = {
  actionId: actionIdSchema,
  commandId: commandIdSchema,
  runId: runIdSchema,
};

export const prepareWorkspaceSchema = object({
  ...commandEnvelope,
  kind: literal("prepare-workspace"),
  leaseId: leaseIdSchema,
  planRootId: planRootIdSchema,
  workspaceCapability: workspaceCapabilitySchema,
  workspaceId: workspaceIdSchema,
  workItemId: workItemIdSchema,
});

export const applyWorkspaceIsolationSchema = object({
  ...commandEnvelope,
  childEpoch: childEpochSchema,
  expectedPolicyDigest: digestSchema,
  expectedWorkspaceRoot: artifactRootSchema,
  isolationPolicy: artifactRefSchema,
  kind: literal("apply-workspace-isolation"),
  leaseId: leaseIdSchema,
  workspaceCapability: workspaceCapabilitySchema,
  workspaceId: workspaceIdSchema,
});

export const materializeWorkspaceSchema = object({
  ...commandEnvelope,
  baseCommit: gitCommitIdSchema,
  baseTree: gitTreeIdSchema,
  kind: literal("materialize-workspace"),
  repository: repositoryCapabilitySchema,
  reservationLease: leaseIdSchema,
  workspaceCapability: workspaceCapabilitySchema,
  workspaceId: workspaceIdSchema,
});

export const verifyChildRouteSchema = object({
  ...commandEnvelope,
  captureId: captureIdSchema,
  deadlineTick: decimalNaturalSchema,
  kind: literal("verify-child-route"),
  route: subscriptionRouteSchema,
});

export const launchChildSchema = object({
  ...commandEnvelope,
  attemptId: attemptIdSchema,
  captureId: captureIdSchema,
  childEpoch: childEpochSchema,
  deadlineTick: decimalNaturalSchema,
  expectedWorkspaceRoot: artifactRootSchema,
  kind: literal("launch-child"),
  maxStderrBytes: decimalNaturalSchema,
  maxStdoutBytes: decimalNaturalSchema,
  memorySeed: childMemorySeedSchema,
  planRootId: planRootIdSchema,
  policyRoot: artifactRootSchema,
  roleId: roleIdSchema,
  route: subscriptionRouteSchema,
  routeObservation: artifactRefSchema,
  routeObservationId: routeObservationIdSchema,
  runId: runIdSchema,
  runtimeRoot: artifactRootSchema,
  workItemId: workItemIdSchema,
  workspaceCapability: workspaceCapabilitySchema,
  workspaceId: workspaceIdSchema,
});

export const inspectChildSchema = object({
  ...commandEnvelope,
  childEpoch: childEpochSchema,
  childId: childIdSchema,
  kind: literal("inspect-child"),
  processDescriptor: artifactRefSchema,
  workItemId: workItemIdSchema,
});

export const executeEvidenceSchema = object({
  ...commandEnvelope,
  candidateTree: artifactRootSchema,
  commandSpec: artifactRefSchema,
  deadlineTick: decimalNaturalSchema,
  kind: literal("execute-evidence"),
  ruleId: ruleIdSchema,
  workItemId: workItemIdSchema,
  workspaceCapability: workspaceCapabilitySchema,
  workspaceId: workspaceIdSchema,
});

export const executeValidationRuleSchema = object({
  ...commandEnvelope,
  candidateTree: artifactRootSchema,
  deadlineTick: decimalNaturalSchema,
  inputs: artifactRefSchema,
  kind: literal("execute-validation-rule"),
  ruleId: ruleIdSchema,
  workItemId: workItemIdSchema,
});

export const buildIntegratedCandidateSchema = object({
  ...commandEnvelope,
  baseCommit: gitCommitIdSchema,
  baseRoot: artifactRootSchema,
  baseTree: gitTreeIdSchema,
  candidateCommit: gitCommitIdSchema,
  candidateId: candidateIdSchema,
  candidateTree: gitTreeIdSchema,
  integrationWorkspace: workspaceCapabilitySchema,
  kind: literal("build-integrated-candidate"),
  planRootId: planRootIdSchema,
  repository: repositoryCapabilitySchema,
  workItemId: workItemIdSchema,
});

export const publishCompareAndSwapSchema = object({
  ...commandEnvelope,
  candidateId: candidateIdSchema,
  candidateTree: gitTreeIdSchema,
  desiredHead: gitCommitIdSchema,
  expected: expectedRefStateSchema,
  kind: literal("publish-compare-and-swap"),
  publicationId: publicationIdSchema,
  publicationLease: leaseIdSchema,
  publicationRef: gitRefSchema,
  repository: repositoryCapabilitySchema,
  verifiedAttestation: gitTreeCasAttestationSchema,
});

export const observeClockCommandSchema = object({
  ...commandEnvelope,
  clockId: ruleIdSchema,
  kind: literal("observe-clock"),
  notBeforeTick: decimalNaturalSchema,
  sourceDigest: digestSchema,
});

export const installArtifactCommandSchema = object({
  ...commandEnvelope,
  artifact: artifactRefSchema,
  kind: literal("install-artifact"),
});

export const commandSchema = union([
  prepareWorkspaceSchema,
  applyWorkspaceIsolationSchema,
  materializeWorkspaceSchema,
  verifyChildRouteSchema,
  launchChildSchema,
  inspectChildSchema,
  executeEvidenceSchema,
  executeValidationRuleSchema,
  buildIntegratedCandidateSchema,
  publishCompareAndSwapSchema,
  observeClockCommandSchema,
  installArtifactCommandSchema,
]);

export type PrepareWorkspace = Infer<typeof prepareWorkspaceSchema>;
export type ApplyWorkspaceIsolation = Infer<typeof applyWorkspaceIsolationSchema>;
export type MaterializeWorkspace = Infer<typeof materializeWorkspaceSchema>;
export type VerifyChildRoute = Infer<typeof verifyChildRouteSchema>;
export type LaunchChild = Infer<typeof launchChildSchema>;
export type InspectChild = Infer<typeof inspectChildSchema>;
export type ExecuteEvidence = Infer<typeof executeEvidenceSchema>;
export type ExecuteValidationRule = Infer<typeof executeValidationRuleSchema>;
export type BuildIntegratedCandidate = Infer<typeof buildIntegratedCandidateSchema>;
export type PublishCompareAndSwap = Infer<typeof publishCompareAndSwapSchema>;
export type ObserveClockCommand = Infer<typeof observeClockCommandSchema>;
export type InstallArtifactCommand = Infer<typeof installArtifactCommandSchema>;
export type Command = Infer<typeof commandSchema>;

export const commandCapsule = defineCapsule("Command", commandSchema);

const actionIdentityCapsule = defineCapsule("CommandActionIdentity", actionIdSchema);
const commandIdentityCapsule = defineCapsule("CommandIdentity", commandIdSchema);

export function commandActionId(
  port: string,
  runId: string,
  kind: string,
  inputs: JsonValue,
  preconditions: JsonValue,
) {
  const digest = canonicalDigestUnknown(Object.freeze({
    domain: "pi-autopilot.action.v2",
    inputs,
    kind,
    port,
    preconditions,
    runId,
  }));
  const decoded = actionIdentityCapsule.decode(`action:sha256:${digest.slice(7)}`);
  return decoded.kind === "ok" ? decoded.value : actionIdentityCapsule.arbitrary.valid(0);
}

export function commandIdentity(kind: string, actionId: string) {
  const digest = canonicalDigestUnknown(Object.freeze({
    actionId,
    domain: "pi-autopilot.command.v2",
    kind,
  }));
  const decoded = commandIdentityCapsule.decode(`command:${kind}:sha256:${digest.slice(7)}`);
  return decoded.kind === "ok" ? decoded.value : commandIdentityCapsule.arbitrary.valid(0);
}

export const commandExhaustive = Object.freeze({
  "apply-workspace-isolation": true,
  "build-integrated-candidate": true,
  "execute-evidence": true,
  "execute-validation-rule": true,
  "inspect-child": true,
  "install-artifact": true,
  "launch-child": true,
  "materialize-workspace": true,
  "observe-clock": true,
  "prepare-workspace": true,
  "publish-compare-and-swap": true,
  "verify-child-route": true,
}) satisfies Readonly<Record<Command["kind"], true>>;
