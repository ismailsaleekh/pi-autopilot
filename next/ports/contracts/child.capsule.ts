import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  captureIdSchema,
  childEpochSchema,
  childIdSchema,
  decimalNaturalSchema,
  exitObservationSchema,
  processGroupIdSchema,
  processIdSchema,
  roleIdSchema,
  routeObservationIdSchema,
  ruleIdSchema,
  runIdSchema,
  workItemIdSchema,
  workspaceCapabilitySchema,
  workspaceIdSchema,
} from "../../authority/protocol/identifiers.js";
import {
  childMemorySeedSchema,
  processObservationSchema,
  routeVerificationSchema,
  sessionObservationSchema,
  subscriptionRouteSchema,
} from "../../authority/protocol/route.capsule.js";
import {
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { toolResultSchemaFor } from "../../authority/protocol/tool-result.capsule.js";
import { defineIntentCapsule } from "./intent-capsule.js";

export const verifyPiRouteSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    captureId: captureIdSchema,
    route: subscriptionRouteSchema,
  }),
  kind: literal("verify-pi-route"),
  preconditions: object({
    deadlineTick: decimalNaturalSchema,
    oauthSubscriptionOnly: literal(true),
  }),
  runId: runIdSchema,
});

export const launchChildSessionSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    attemptId: attemptIdSchema,
    captureId: captureIdSchema,
    memorySeed: childMemorySeedSchema,
    policyRoot: artifactRootSchema,
    roleId: roleIdSchema,
    route: subscriptionRouteSchema,
    runtimeRoot: artifactRootSchema,
    workItemId: workItemIdSchema,
    workspaceCapability: workspaceCapabilitySchema,
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("launch-child-session"),
  preconditions: object({
    childEpoch: childEpochSchema,
    deadlineTick: decimalNaturalSchema,
    expectedWorkspaceRoot: artifactRootSchema,
    maxStderrBytes: decimalNaturalSchema,
    maxStdoutBytes: decimalNaturalSchema,
    routeObservation: artifactRefSchema,
    routeObservationId: routeObservationIdSchema,
  }),
  runId: runIdSchema,
});

export const inspectChildSessionSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    childId: childIdSchema,
    processDescriptor: artifactRefSchema,
  }),
  kind: literal("inspect-child-session"),
  preconditions: object({ childEpoch: childEpochSchema }),
  runId: runIdSchema,
});

export const fenceChildSessionSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    childId: childIdSchema,
    processDescriptor: artifactRefSchema,
  }),
  kind: literal("fence-child-session"),
  preconditions: object({
    childEpoch: childEpochSchema,
    replacementEpoch: childEpochSchema,
  }),
  runId: runIdSchema,
});

export const executeEvidenceCommandSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    candidateTree: artifactRootSchema,
    commandSpec: artifactRefSchema,
    ruleId: ruleIdSchema,
    workItemId: workItemIdSchema,
    workspaceCapability: workspaceCapabilitySchema,
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("execute-evidence-command"),
  preconditions: object({ deadlineTick: decimalNaturalSchema }),
  runId: runIdSchema,
});

export const executeValidationCommandSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    candidateTree: artifactRootSchema,
    ruleId: ruleIdSchema,
    ruleInputs: artifactRefSchema,
    workItemId: workItemIdSchema,
  }),
  kind: literal("execute-validation-command"),
  preconditions: object({ deadlineTick: decimalNaturalSchema }),
  runId: runIdSchema,
});

export const childIntentSchema = union([
  verifyPiRouteSchema,
  launchChildSessionSchema,
  inspectChildSessionSchema,
  fenceChildSessionSchema,
  executeEvidenceCommandSchema,
  executeValidationCommandSchema,
]);

const launchedChildResultSchema = object({
  childEpoch: childEpochSchema,
  childId: childIdSchema,
  process: processObservationSchema,
  processDescriptor: artifactRefSchema,
  session: sessionObservationSchema,
  workspaceId: workspaceIdSchema,
});
const inspectedChildResultSchema = object({
  childEpoch: childEpochSchema,
  childId: childIdSchema,
  sealedRoot: nullable(artifactRootSchema),
  session: sessionObservationSchema,
  state: union([literal("running"), literal("quiescent"), literal("absent")]),
});
const fencedChildResultSchema = object({
  childId: childIdSchema,
  observedEpoch: childEpochSchema,
  processGroupId: processGroupIdSchema,
  processId: processIdSchema,
  state: union([literal("fenced"), literal("already-absent")]),
});
const executedCommandResultSchema = object({
  capture: artifactRefSchema,
  exit: exitObservationSchema,
  stderrBytes: decimalNaturalSchema,
  stdoutBytes: decimalNaturalSchema,
});

export const piRouteVerifiedSchema = object({
  actionId: actionIdSchema,
  kind: literal("pi-route-verified"),
  result: toolResultSchemaFor(routeVerificationSchema),
  runId: runIdSchema,
});
export const childSessionLaunchedSchema = object({
  actionId: actionIdSchema,
  kind: literal("child-session-launched"),
  result: toolResultSchemaFor(launchedChildResultSchema),
  runId: runIdSchema,
});
export const childSessionInspectedSchema = object({
  actionId: actionIdSchema,
  kind: literal("child-session-inspected"),
  result: toolResultSchemaFor(inspectedChildResultSchema),
  runId: runIdSchema,
});
export const childSessionFencedSchema = object({
  actionId: actionIdSchema,
  kind: literal("child-session-fenced"),
  result: toolResultSchemaFor(fencedChildResultSchema),
  runId: runIdSchema,
});
export const evidenceCommandExecutedSchema = object({
  actionId: actionIdSchema,
  kind: literal("evidence-command-executed"),
  result: toolResultSchemaFor(executedCommandResultSchema),
  runId: runIdSchema,
});
export const validationCommandExecutedSchema = object({
  actionId: actionIdSchema,
  kind: literal("validation-command-executed"),
  result: toolResultSchemaFor(executedCommandResultSchema),
  runId: runIdSchema,
});

export const childObservationSchema = union([
  piRouteVerifiedSchema,
  childSessionLaunchedSchema,
  childSessionInspectedSchema,
  childSessionFencedSchema,
  evidenceCommandExecutedSchema,
  validationCommandExecutedSchema,
]);

export type VerifyPiRoute = Infer<typeof verifyPiRouteSchema>;
export type LaunchChildSession = Infer<typeof launchChildSessionSchema>;
export type InspectChildSession = Infer<typeof inspectChildSessionSchema>;
export type FenceChildSession = Infer<typeof fenceChildSessionSchema>;
export type ExecuteEvidenceCommand = Infer<typeof executeEvidenceCommandSchema>;
export type ExecuteValidationCommand = Infer<typeof executeValidationCommandSchema>;
export type ChildIntent = Infer<typeof childIntentSchema>;
export type PiRouteVerified = Infer<typeof piRouteVerifiedSchema>;
export type ChildSessionLaunched = Infer<typeof childSessionLaunchedSchema>;
export type ChildSessionInspected = Infer<typeof childSessionInspectedSchema>;
export type ChildSessionFenced = Infer<typeof childSessionFencedSchema>;
export type EvidenceCommandExecuted = Infer<typeof evidenceCommandExecutedSchema>;
export type ValidationCommandExecuted = Infer<typeof validationCommandExecutedSchema>;
export type ChildObservation = Infer<typeof childObservationSchema>;

export const childIntentCapsule = defineIntentCapsule("ChildIntent", "child", childIntentSchema);
export const childObservationCapsule = defineCapsule("ChildObservation", childObservationSchema);

export const childIntentExhaustive = Object.freeze({
  "execute-evidence-command": true,
  "execute-validation-command": true,
  "fence-child-session": true,
  "inspect-child-session": true,
  "launch-child-session": true,
  "verify-pi-route": true,
}) satisfies Readonly<Record<ChildIntent["kind"], true>>;

export const childObservationExhaustive = Object.freeze({
  "child-session-fenced": true,
  "child-session-inspected": true,
  "child-session-launched": true,
  "evidence-command-executed": true,
  "pi-route-verified": true,
  "validation-command-executed": true,
}) satisfies Readonly<Record<ChildObservation["kind"], true>>;
