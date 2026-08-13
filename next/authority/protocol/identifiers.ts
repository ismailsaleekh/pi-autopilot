import {
  arrayOf,
  brandedText,
  literal,
  natural,
  nullable,
  object,
  text,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export type { Digest } from "./schema.js";

export const runIdSchema = brandedText("RunId", "identifier");
export const workItemIdSchema = brandedText("WorkItemId", "identifier");
export const actionIdSchema = brandedText("ActionId", "action-id");
export const attemptIdSchema = brandedText("AttemptId", "identifier");
export const commandIdSchema = brandedText("CommandId", "identifier");
export const artifactRootSchema = brandedText("ArtifactRoot", "artifact-root");
export const artifactPathSchema = brandedText("ArtifactPath", "path");
export const planRootIdSchema = brandedText("PlanRootId", "identifier");
export const sourceAnchorSchema = brandedText("SourceAnchor", "source-anchor");
export const digestSchema = brandedText("Digest", "digest");
export const requirementIdSchema = brandedText("RequirementId", "identifier");
export const submissionIdSchema = brandedText("SubmissionId", "identifier");
export const findingIdSchema = brandedText("FindingId", "identifier");
export const evidenceIdSchema = brandedText("EvidenceId", "identifier");
export const candidateIdSchema = brandedText("CandidateId", "identifier");
export const publicationIdSchema = brandedText("PublicationId", "identifier");
export const roleIdSchema = brandedText("RoleId", "identifier");
export const ruleIdSchema = brandedText("RuleId", "identifier");
export const kindIdSchema = brandedText("KindId", "identifier");
export const workspaceIdSchema = brandedText("WorkspaceId", "identifier");
export const childIdSchema = brandedText("ChildId", "identifier");
export const childEpochSchema = brandedText("ChildEpoch", "identifier");
export const revisionIdSchema = brandedText("RevisionId", "identifier");
export const secretHandleSchema = brandedText("SecretHandle", "identifier");
export const operatorRequestIdSchema = brandedText("OperatorRequestId", "identifier");
export const leaseIdSchema = brandedText("LeaseId", "identifier");
export const pageCursorSchema = brandedText("PageCursor", "identifier");
export const diagnosticCodeSchema = brandedText("DiagnosticCode", "identifier");
export const workspaceRelativePathSchema = brandedText("WorkspaceRelativePath", "path");

export const byteRangeSchema = object({
  length: natural(),
  offset: natural(),
});

export const artifactRefSchema = object({
  path: artifactPathSchema,
  range: nullable(byteRangeSchema),
  root: artifactRootSchema,
});

export const diagnosticSchema = object({
  code: diagnosticCodeSchema,
  message: text("non-empty"),
  related: arrayOf(artifactRefSchema),
});

export const exitObservationSchema = union([
  object({
    code: natural(),
    kind: literal("exited"),
  }),
  object({
    kind: literal("signalled"),
    signal: brandedText("SignalName", "identifier"),
  }),
]);

export type RunId = Infer<typeof runIdSchema>;
export type WorkItemId = Infer<typeof workItemIdSchema>;
export type ActionId = Infer<typeof actionIdSchema>;
export type AttemptId = Infer<typeof attemptIdSchema>;
export type CommandId = Infer<typeof commandIdSchema>;
export type ArtifactRoot = Infer<typeof artifactRootSchema>;
export type ArtifactPath = Infer<typeof artifactPathSchema>;
export type ArtifactRef = Infer<typeof artifactRefSchema>;
export type PlanRootId = Infer<typeof planRootIdSchema>;
export type SourceAnchor = Infer<typeof sourceAnchorSchema>;
export type RequirementId = Infer<typeof requirementIdSchema>;
export type SubmissionId = Infer<typeof submissionIdSchema>;
export type FindingId = Infer<typeof findingIdSchema>;
export type EvidenceId = Infer<typeof evidenceIdSchema>;
export type CandidateId = Infer<typeof candidateIdSchema>;
export type PublicationId = Infer<typeof publicationIdSchema>;
export type RoleId = Infer<typeof roleIdSchema>;
export type RuleId = Infer<typeof ruleIdSchema>;
export type KindId = Infer<typeof kindIdSchema>;
export type WorkspaceId = Infer<typeof workspaceIdSchema>;
export type ChildId = Infer<typeof childIdSchema>;
export type ChildEpoch = Infer<typeof childEpochSchema>;
export type RevisionId = Infer<typeof revisionIdSchema>;
export type SecretHandle = Infer<typeof secretHandleSchema>;
export type OperatorRequestId = Infer<typeof operatorRequestIdSchema>;
export type LeaseId = Infer<typeof leaseIdSchema>;
export type PageCursor = Infer<typeof pageCursorSchema>;
export type DiagnosticCode = Infer<typeof diagnosticCodeSchema>;
export type WorkspaceRelativePath = Infer<typeof workspaceRelativePathSchema>;
export type ByteRange = Infer<typeof byteRangeSchema>;
export type Diagnostic = Infer<typeof diagnosticSchema>;
export type ExitObservation = Infer<typeof exitObservationSchema>;

export type NonEmpty<Value> = readonly [Value, ...Value[]];
