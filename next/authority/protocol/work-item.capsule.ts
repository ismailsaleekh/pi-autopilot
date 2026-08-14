import {
  artifactPathSchema,
  artifactRefSchema,
  artifactRootSchema,
  correctionAssignmentIdSchema,
  decimalNaturalSchema,
  findingIdSchema,
  gitCommitIdSchema,
  gitRefSchema,
  gitTreeIdSchema,
  indexRootSchema,
  kindIdSchema,
  planRootIdSchema,
  repositoryCapabilitySchema,
  roleIdSchema,
  runIdSchema,
  workItemIdSchema,
  workspaceCapabilitySchema,
  workspaceIdSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

const commonWorkFields = {
  dependencyCount: decimalNaturalSchema,
  dependencyRoot: indexRootSchema,
  inputRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
  prompt: artifactRefSchema,
  roleId: roleIdSchema,
  ruleInputs: artifactRefSchema,
  runId: runIdSchema,
  taskRoot: artifactRootSchema,
  topologicalRank: decimalNaturalSchema,
  workItemId: workItemIdSchema,
  workspaceCapability: workspaceCapabilitySchema,
  workspaceId: workspaceIdSchema,
};

export const produceArtifactWorkSchema = object({
  ...commonWorkFields,
  artifactKindId: kindIdSchema,
  kind: literal("produce-artifact"),
  outputPath: artifactPathSchema,
  sourceRoot: artifactRootSchema,
});

export const reviewArtifactWorkSchema = object({
  ...commonWorkFields,
  kind: literal("review-artifact"),
  reviewPolicy: artifactRefSchema,
  subjectRoot: artifactRootSchema,
});

export const correctionScopeSchema = union([
  literal("local"),
  literal("plan-wide"),
  literal("cross-lane"),
]);

export const correctArtifactWorkSchema = object({
  ...commonWorkFields,
  assignmentId: correctionAssignmentIdSchema,
  findingId: findingIdSchema,
  integratedInput: artifactRootSchema,
  kind: literal("correct-artifact"),
  originalOwnerWorkItemId: workItemIdSchema,
  priorOutputRoot: artifactRootSchema,
  scope: correctionScopeSchema,
  subjectRoot: artifactRootSchema,
});

export const integrateCandidateWorkSchema = object({
  ...commonWorkFields,
  acceptedOutputs: artifactRefSchema,
  baseCommit: gitCommitIdSchema,
  baseRoot: artifactRootSchema,
  baseTree: gitTreeIdSchema,
  kind: literal("integrate-candidate"),
  publicationRef: gitRefSchema,
  repository: repositoryCapabilitySchema,
  workspaceCapability: workspaceCapabilitySchema,
  workspaceId: workspaceIdSchema,
});

export const verifyCandidateWorkSchema = object({
  ...commonWorkFields,
  candidateRoot: artifactRootSchema,
  kind: literal("verify-candidate"),
  validationPlan: artifactRefSchema,
});

export const workItemSchema = union([
  produceArtifactWorkSchema,
  reviewArtifactWorkSchema,
  correctArtifactWorkSchema,
  integrateCandidateWorkSchema,
  verifyCandidateWorkSchema,
]);

export type ProduceArtifactWork = Infer<typeof produceArtifactWorkSchema>;
export type ReviewArtifactWork = Infer<typeof reviewArtifactWorkSchema>;
export type CorrectionScope = Infer<typeof correctionScopeSchema>;
export type CorrectArtifactWork = Infer<typeof correctArtifactWorkSchema>;
export type IntegrateCandidateWork = Infer<typeof integrateCandidateWorkSchema>;
export type VerifyCandidateWork = Infer<typeof verifyCandidateWorkSchema>;
export type WorkItem = Infer<typeof workItemSchema>;

export const workItemCapsule = defineCapsule("WorkItem", workItemSchema);

export const workItemExhaustive = Object.freeze({
  "correct-artifact": true,
  "integrate-candidate": true,
  "produce-artifact": true,
  "review-artifact": true,
  "verify-candidate": true,
}) satisfies Readonly<Record<WorkItem["kind"], true>>;
