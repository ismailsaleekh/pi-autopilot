import { evidenceFactSchema } from "./evidence-fact.capsule.js";
import { findingSchema } from "./finding.capsule.js";
import {
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  candidateIdSchema,
  findingIdSchema,
  planRootIdSchema,
  publicationIdSchema,
  requirementIdSchema,
  revisionIdSchema,
  runIdSchema,
  sourceAnchorSchema,
  submissionIdSchema,
  workItemIdSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";
import { workItemSchema } from "./work-item.capsule.js";

export const requirementsBoundSchema = object({
  anchorIndexRoot: artifactRootSchema,
  kind: literal("requirements-bound"),
  requirementsRoot: artifactRootSchema,
  runId: runIdSchema,
  sourceRoot: artifactRootSchema,
});

export const workDeclaredSchema = object({
  kind: literal("work-declared"),
  runId: runIdSchema,
  workItem: workItemSchema,
});

export const submissionBoundSchema = object({
  attemptId: attemptIdSchema,
  inputRoot: artifactRootSchema,
  kind: literal("submission-bound"),
  outputRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  submissionId: submissionIdSchema,
  workItemId: workItemIdSchema,
});

export const planRootAcceptedSchema = object({
  coverageRoot: artifactRootSchema,
  kind: literal("plan-root-accepted"),
  planRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
  runId: runIdSchema,
});

export const planRootSupersededSchema = object({
  kind: literal("plan-root-superseded"),
  newPlanRootId: planRootIdSchema,
  priorPlanRootId: planRootIdSchema,
  reason: artifactRefSchema,
  runId: runIdSchema,
});

export const coverageLinkedSchema = object({
  evidence: nullable(artifactRefSchema),
  implementationRoot: artifactRootSchema,
  kind: literal("coverage-linked"),
  planRootId: planRootIdSchema,
  requirementId: requirementIdSchema,
  runId: runIdSchema,
  sourceAnchor: sourceAnchorSchema,
  workItemId: workItemIdSchema,
});

export const findingRaisedSchema = object({
  finding: findingSchema,
  kind: literal("finding-raised"),
  runId: runIdSchema,
});

export const findingClearedSchema = object({
  correctedRoot: artifactRootSchema,
  findingId: findingIdSchema,
  kind: literal("finding-cleared"),
  resolution: artifactRefSchema,
  runId: runIdSchema,
});

export const evidenceObservedSchema = object({
  evidence: evidenceFactSchema,
  kind: literal("evidence-observed"),
  runId: runIdSchema,
});

export const candidateAcceptedSchema = object({
  candidateId: candidateIdSchema,
  kind: literal("candidate-accepted"),
  manifest: artifactRefSchema,
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  tree: artifactRootSchema,
});

export const publicationIntendedSchema = object({
  candidateId: candidateIdSchema,
  desiredHead: revisionIdSchema,
  expectedHead: revisionIdSchema,
  kind: literal("publication-intended"),
  publicationId: publicationIdSchema,
  runId: runIdSchema,
});

export const publicationObservedSchema = object({
  kind: literal("publication-observed"),
  observedHead: revisionIdSchema,
  publicationId: publicationIdSchema,
  runId: runIdSchema,
  status: union([
    literal("desired-head"),
    literal("head-moved"),
  ]),
});

export const domainFactSchema = union([
  requirementsBoundSchema,
  workDeclaredSchema,
  submissionBoundSchema,
  planRootAcceptedSchema,
  planRootSupersededSchema,
  coverageLinkedSchema,
  findingRaisedSchema,
  findingClearedSchema,
  evidenceObservedSchema,
  candidateAcceptedSchema,
  publicationIntendedSchema,
  publicationObservedSchema,
]);

export type RequirementsBound = Infer<typeof requirementsBoundSchema>;
export type WorkDeclared = Infer<typeof workDeclaredSchema>;
export type SubmissionBound = Infer<typeof submissionBoundSchema>;
export type PlanRootAccepted = Infer<typeof planRootAcceptedSchema>;
export type PlanRootSuperseded = Infer<typeof planRootSupersededSchema>;
export type CoverageLinked = Infer<typeof coverageLinkedSchema>;
export type FindingRaised = Infer<typeof findingRaisedSchema>;
export type FindingCleared = Infer<typeof findingClearedSchema>;
export type EvidenceObserved = Infer<typeof evidenceObservedSchema>;
export type CandidateAccepted = Infer<typeof candidateAcceptedSchema>;
export type PublicationIntended = Infer<typeof publicationIntendedSchema>;
export type PublicationObserved = Infer<typeof publicationObservedSchema>;
export type DomainFact = Infer<typeof domainFactSchema>;

export const domainFactCapsule = defineCapsule("DomainFact", domainFactSchema);

export const domainFactExhaustive = Object.freeze({
  "candidate-accepted": true,
  "coverage-linked": true,
  "evidence-observed": true,
  "finding-cleared": true,
  "finding-raised": true,
  "plan-root-accepted": true,
  "plan-root-superseded": true,
  "publication-intended": true,
  "publication-observed": true,
  "requirements-bound": true,
  "submission-bound": true,
  "work-declared": true,
}) satisfies Readonly<Record<DomainFact["kind"], true>>;
