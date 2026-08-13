import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  candidateIdSchema,
  childEpochSchema,
  childIdSchema,
  commandIdSchema,
  planRootIdSchema,
  publicationIdSchema,
  revisionIdSchema,
  roleIdSchema,
  ruleIdSchema,
  runIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const prepareWorkspaceSchema = object({
  actionId: actionIdSchema,
  baseRoot: artifactRootSchema,
  commandId: commandIdSchema,
  kind: literal("prepare-workspace"),
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  workspaceId: workspaceIdSchema,
  workItemId: workItemIdSchema,
});

export const launchChildSchema = object({
  actionId: actionIdSchema,
  attemptId: attemptIdSchema,
  commandId: commandIdSchema,
  kind: literal("launch-child"),
  planRootId: planRootIdSchema,
  policyRoot: artifactRootSchema,
  prompt: artifactRefSchema,
  roleId: roleIdSchema,
  runId: runIdSchema,
  runtimeRoot: artifactRootSchema,
  workItemId: workItemIdSchema,
  workspaceId: workspaceIdSchema,
});

export const inspectChildSchema = object({
  actionId: actionIdSchema,
  childEpoch: childEpochSchema,
  childId: childIdSchema,
  commandId: commandIdSchema,
  kind: literal("inspect-child"),
  runId: runIdSchema,
  workItemId: workItemIdSchema,
});

export const executeEvidenceSchema = object({
  actionId: actionIdSchema,
  candidateTree: artifactRootSchema,
  commandId: commandIdSchema,
  commandSpec: artifactRefSchema,
  kind: literal("execute-evidence"),
  runId: runIdSchema,
  workItemId: workItemIdSchema,
  workspaceId: workspaceIdSchema,
});

export const executeValidationRuleSchema = object({
  actionId: actionIdSchema,
  candidateTree: artifactRootSchema,
  commandId: commandIdSchema,
  inputs: artifactRefSchema,
  kind: literal("execute-validation-rule"),
  ruleId: ruleIdSchema,
  runId: runIdSchema,
  workItemId: workItemIdSchema,
});

export const buildIntegratedCandidateSchema = object({
  acceptedOutputs: artifactRefSchema,
  actionId: actionIdSchema,
  baseRoot: artifactRootSchema,
  candidateId: candidateIdSchema,
  commandId: commandIdSchema,
  kind: literal("build-integrated-candidate"),
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  workItemId: workItemIdSchema,
});

export const publishCompareAndSwapSchema = object({
  actionId: actionIdSchema,
  candidateId: candidateIdSchema,
  candidateTree: artifactRootSchema,
  commandId: commandIdSchema,
  desiredHead: revisionIdSchema,
  expectedHead: revisionIdSchema,
  kind: literal("publish-compare-and-swap"),
  publicationId: publicationIdSchema,
  runId: runIdSchema,
});

export const commandSchema = union([
  prepareWorkspaceSchema,
  launchChildSchema,
  inspectChildSchema,
  executeEvidenceSchema,
  executeValidationRuleSchema,
  buildIntegratedCandidateSchema,
  publishCompareAndSwapSchema,
]);

export type PrepareWorkspace = Infer<typeof prepareWorkspaceSchema>;
export type LaunchChild = Infer<typeof launchChildSchema>;
export type InspectChild = Infer<typeof inspectChildSchema>;
export type ExecuteEvidence = Infer<typeof executeEvidenceSchema>;
export type ExecuteValidationRule = Infer<typeof executeValidationRuleSchema>;
export type BuildIntegratedCandidate = Infer<typeof buildIntegratedCandidateSchema>;
export type PublishCompareAndSwap = Infer<typeof publishCompareAndSwapSchema>;
export type Command = Infer<typeof commandSchema>;

export const commandCapsule = defineCapsule("Command", commandSchema);

export const commandExhaustive = Object.freeze({
  "build-integrated-candidate": true,
  "execute-evidence": true,
  "execute-validation-rule": true,
  "inspect-child": true,
  "launch-child": true,
  "prepare-workspace": true,
  "publish-compare-and-swap": true,
}) satisfies Readonly<Record<Command["kind"], true>>;
