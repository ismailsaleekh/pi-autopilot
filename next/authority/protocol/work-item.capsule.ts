import {
  artifactPathSchema,
  artifactRefSchema,
  artifactRootSchema,
  findingIdSchema,
  kindIdSchema,
  planRootIdSchema,
  roleIdSchema,
  runIdSchema,
  workItemIdSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const produceArtifactWorkSchema = object({
  artifactKindId: kindIdSchema,
  inputRoot: artifactRootSchema,
  kind: literal("produce-artifact"),
  outputPath: artifactPathSchema,
  planRootId: planRootIdSchema,
  roleId: roleIdSchema,
  runId: runIdSchema,
  sourceRoot: artifactRootSchema,
  workItemId: workItemIdSchema,
});

export const reviewArtifactWorkSchema = object({
  inputRoot: artifactRootSchema,
  kind: literal("review-artifact"),
  planRootId: planRootIdSchema,
  reviewPolicy: artifactRefSchema,
  roleId: roleIdSchema,
  runId: runIdSchema,
  subjectRoot: artifactRootSchema,
  workItemId: workItemIdSchema,
});

export const correctArtifactWorkSchema = object({
  findingId: findingIdSchema,
  inputRoot: artifactRootSchema,
  kind: literal("correct-artifact"),
  planRootId: planRootIdSchema,
  priorOutputRoot: artifactRootSchema,
  roleId: roleIdSchema,
  runId: runIdSchema,
  subjectRoot: artifactRootSchema,
  workItemId: workItemIdSchema,
});

export const integrateCandidateWorkSchema = object({
  acceptedOutputs: artifactRefSchema,
  baseRoot: artifactRootSchema,
  inputRoot: artifactRootSchema,
  kind: literal("integrate-candidate"),
  planRootId: planRootIdSchema,
  roleId: roleIdSchema,
  runId: runIdSchema,
  workItemId: workItemIdSchema,
});

export const verifyCandidateWorkSchema = object({
  candidateRoot: artifactRootSchema,
  inputRoot: artifactRootSchema,
  kind: literal("verify-candidate"),
  planRootId: planRootIdSchema,
  roleId: roleIdSchema,
  runId: runIdSchema,
  validationPlan: artifactRefSchema,
  workItemId: workItemIdSchema,
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
