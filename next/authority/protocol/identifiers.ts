import {
  arrayOf,
  brandedText,
  defineCapsule,
  literal,
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
export const casBlobIdSchema = brandedText("CasBlobId", "digest");
export const indexRootSchema = brandedText("IndexRoot", "artifact-root");
export const artifactPathSchema = brandedText("ArtifactPath", "path");
export const planRootIdSchema = brandedText("PlanRootId", "identifier");
export const planUnitIdSchema = brandedText("PlanUnitId", "identifier");
export const atomIdSchema = brandedText("AtomId", "identifier");
export const sourceAnchorSchema = brandedText("SourceAnchor", "source-anchor");
export const digestSchema = brandedText("Digest", "digest");
export const decimalNaturalSchema = brandedText("DecimalNatural", "decimal-natural");
export const requirementIdSchema = brandedText("RequirementId", "identifier");
export const submissionIdSchema = brandedText("SubmissionId", "identifier");
export const findingIdSchema = brandedText("FindingId", "identifier");
export const correctionAssignmentIdSchema = brandedText("CorrectionAssignmentId", "identifier");
export const evidenceIdSchema = brandedText("EvidenceId", "identifier");
export const evidenceObligationIdSchema = brandedText("EvidenceObligationId", "identifier");
export const candidateIdSchema = brandedText("CandidateId", "identifier");
export const publicationIdSchema = brandedText("PublicationId", "identifier");
export const roleIdSchema = brandedText("RoleId", "identifier");
export const ruleIdSchema = brandedText("RuleId", "identifier");
export const kindIdSchema = brandedText("KindId", "identifier");
export const workspaceIdSchema = brandedText("WorkspaceId", "identifier");
export const workspaceCapabilitySchema = brandedText("WorkspaceCapability", "identifier");
export const childIdSchema = brandedText("ChildId", "identifier");
export const childEpochSchema = brandedText("ChildEpoch", "decimal-natural");
export const writerEpochSchema = brandedText("WriterEpoch", "decimal-natural");
export const repositoryCapabilitySchema = brandedText("RepositoryCapability", "identifier");
export const gitObjectIdSchema = brandedText("GitObjectId", "git-oid");
export const gitCommitIdSchema = brandedText("GitCommitId", "git-oid");
export const gitTreeIdSchema = brandedText("GitTreeId", "git-oid");
export const gitRefSchema = brandedText("GitRef", "git-ref");
export const revisionIdSchema = gitCommitIdSchema;
export const secretHandleSchema = brandedText("SecretHandle", "identifier");
export const operatorRequestIdSchema = brandedText("OperatorRequestId", "identifier");
export const leaseIdSchema = brandedText("LeaseId", "identifier");
export const pageCursorSchema = brandedText("PageCursor", "identifier");
export const diagnosticCodeSchema = brandedText("DiagnosticCode", "identifier");

export function diagnosticCode(value: string): DiagnosticCode | null {
  const decoded = defineCapsule("DiagnosticCodeValue", diagnosticCodeSchema).decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}
export const workspaceRelativePathSchema = brandedText("WorkspaceRelativePath", "path");
export const routeObservationIdSchema = brandedText("RouteObservationId", "identifier");
export const routeCapabilitySchema = brandedText("RouteCapability", "identifier");
export const processIdSchema = brandedText("ProcessId", "identifier");
export const processGroupIdSchema = brandedText("ProcessGroupId", "identifier");
export const captureIdSchema = brandedText("CaptureId", "identifier");

export const byteRangeSchema = object({
  length: decimalNaturalSchema,
  offset: decimalNaturalSchema,
});

export const artifactRefSchema = object({
  blob: casBlobIdSchema,
  byteLength: decimalNaturalSchema,
  codec: kindIdSchema,
  codecVersion: kindIdSchema,
  digest: digestSchema,
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
    code: decimalNaturalSchema,
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
export type CasBlobId = Infer<typeof casBlobIdSchema>;
export type IndexRoot = Infer<typeof indexRootSchema>;
export type ArtifactPath = Infer<typeof artifactPathSchema>;
export type ArtifactRef = Infer<typeof artifactRefSchema>;
export type PlanRootId = Infer<typeof planRootIdSchema>;
export type PlanUnitId = Infer<typeof planUnitIdSchema>;
export type AtomId = Infer<typeof atomIdSchema>;
export type SourceAnchor = Infer<typeof sourceAnchorSchema>;
export type RequirementId = Infer<typeof requirementIdSchema>;
export type SubmissionId = Infer<typeof submissionIdSchema>;
export type FindingId = Infer<typeof findingIdSchema>;
export type CorrectionAssignmentId = Infer<typeof correctionAssignmentIdSchema>;
export type EvidenceId = Infer<typeof evidenceIdSchema>;
export type EvidenceObligationId = Infer<typeof evidenceObligationIdSchema>;
export type CandidateId = Infer<typeof candidateIdSchema>;
export type PublicationId = Infer<typeof publicationIdSchema>;
export type RoleId = Infer<typeof roleIdSchema>;
export type RuleId = Infer<typeof ruleIdSchema>;
export type KindId = Infer<typeof kindIdSchema>;
export type WorkspaceId = Infer<typeof workspaceIdSchema>;
export type WorkspaceCapability = Infer<typeof workspaceCapabilitySchema>;
export type ChildId = Infer<typeof childIdSchema>;
export type ChildEpoch = Infer<typeof childEpochSchema>;
export type WriterEpoch = Infer<typeof writerEpochSchema>;
export type RepositoryCapability = Infer<typeof repositoryCapabilitySchema>;
export type GitObjectId = Infer<typeof gitObjectIdSchema>;
export type GitCommitId = Infer<typeof gitCommitIdSchema>;
export type GitTreeId = Infer<typeof gitTreeIdSchema>;
export type GitRef = Infer<typeof gitRefSchema>;
export type RevisionId = GitCommitId;
export type SecretHandle = Infer<typeof secretHandleSchema>;
export type OperatorRequestId = Infer<typeof operatorRequestIdSchema>;
export type LeaseId = Infer<typeof leaseIdSchema>;
export type PageCursor = Infer<typeof pageCursorSchema>;
export type DiagnosticCode = Infer<typeof diagnosticCodeSchema>;
export type WorkspaceRelativePath = Infer<typeof workspaceRelativePathSchema>;
export type RouteObservationId = Infer<typeof routeObservationIdSchema>;
export type RouteCapability = Infer<typeof routeCapabilitySchema>;
export type ProcessId = Infer<typeof processIdSchema>;
export type ProcessGroupId = Infer<typeof processGroupIdSchema>;
export type CaptureId = Infer<typeof captureIdSchema>;
export type DecimalNatural = Infer<typeof decimalNaturalSchema>;
export type ByteRange = Infer<typeof byteRangeSchema>;
export type Diagnostic = Infer<typeof diagnosticSchema>;
export type ExitObservation = Infer<typeof exitObservationSchema>;

export type NonEmpty<Value> = readonly [Value, ...Value[]];

const decimalNaturalCapsule = defineCapsule("DecimalNaturalValue", decimalNaturalSchema);

export function decimalNatural(value: string): DecimalNatural | null {
  const decoded = decimalNaturalCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}

export function zeroDecimalNatural(): DecimalNatural {
  const decoded = decimalNaturalCapsule.decode("0");
  return decoded.kind === "ok" ? decoded.value : decimalNaturalCapsule.arbitrary.valid(0);
}

export function oneDecimalNatural(): DecimalNatural {
  const decoded = decimalNaturalCapsule.decode("1");
  return decoded.kind === "ok" ? decoded.value : decimalNaturalCapsule.arbitrary.valid(1);
}

export function compareDecimalNatural(left: DecimalNatural, right: DecimalNatural): -1 | 0 | 1 {
  if (left.length < right.length) {
    return -1;
  }
  if (left.length > right.length) {
    return 1;
  }
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

export function incrementDecimalNatural(value: DecimalNatural): DecimalNatural {
  const digits = value.split("");
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    const digit = digits[index];
    const numeric = digit === undefined ? 0 : digit.charCodeAt(0) - 48;
    if (numeric === 9) {
      digits[index] = "0";
    } else {
      digits[index] = String(numeric + 1);
      carry = 0;
    }
  }
  if (carry === 1) {
    digits.unshift("1");
  }
  const decoded = decimalNatural(digits.join(""));
  return decoded ?? value;
}

export function decrementDecimalNatural(value: DecimalNatural): DecimalNatural | null {
  if (value === "0") {
    return null;
  }
  const digits = value.split("");
  let borrow = 1;
  for (let index = digits.length - 1; index >= 0 && borrow === 1; index -= 1) {
    const digit = digits[index];
    const numeric = digit === undefined ? 0 : digit.charCodeAt(0) - 48;
    if (numeric === 0) {
      digits[index] = "9";
    } else {
      digits[index] = String(numeric - 1);
      borrow = 0;
    }
  }
  while (digits.length > 1 && digits[0] === "0") {
    digits.shift();
  }
  return decimalNatural(digits.join(""));
}

export function addDecimalNatural(left: DecimalNatural, right: DecimalNatural): DecimalNatural {
  const output: string[] = [];
  let leftIndex = left.length - 1;
  let rightIndex = right.length - 1;
  let carry = 0;
  while (leftIndex >= 0 || rightIndex >= 0 || carry > 0) {
    const leftDigit = leftIndex >= 0 ? left.charCodeAt(leftIndex) - 48 : 0;
    const rightDigit = rightIndex >= 0 ? right.charCodeAt(rightIndex) - 48 : 0;
    const sum = leftDigit + rightDigit + carry;
    output.push(String(sum % 10));
    carry = Math.floor(sum / 10);
    leftIndex -= 1;
    rightIndex -= 1;
  }
  output.reverse();
  const decoded = decimalNatural(output.join(""));
  return decoded ?? left;
}
