import { atomDispositionSchema, atomSchema } from "./atom.capsule.js";
import { evidenceFactSchema } from "./evidence-fact.capsule.js";
import { findingSchema } from "./finding.capsule.js";
import { expectedRefStateSchema } from "./git-values.js";
import {
  artifactRefSchema,
  artifactRootSchema,
  candidateIdSchema,
  correctionAssignmentIdSchema,
  decimalNaturalSchema,
  evidenceIdSchema,
  findingIdSchema,
  gitCommitIdSchema,
  gitRefSchema,
  gitTreeIdSchema,
  indexRootSchema,
  planRootIdSchema,
  publicationIdSchema,
  repositoryCapabilitySchema,
  routeObservationIdSchema,
  runIdSchema,
  submissionIdSchema,
  workItemIdSchema,
} from "./identifiers.js";
import { routeVerificationSchema } from "./route.capsule.js";
import {
  arrayOf,
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";
import { correctionScopeSchema, correctArtifactWorkSchema, workItemSchema } from "./work-item.capsule.js";

export const requirementsBoundSchema = object({
  atomIndexRoot: indexRootSchema,
  atomInventorySealed: literal(false),
  declaredAtomCount: decimalNaturalSchema,
  kind: literal("requirements-bound"),
  requirementsRoot: artifactRootSchema,
  runId: runIdSchema,
  sourceRoot: artifactRootSchema,
  taskRoot: artifactRootSchema,
});

export const atomDeclaredSchema = object({
  atom: atomSchema,
  kind: literal("atom-declared"),
  runId: runIdSchema,
});

export const atomInventorySealedSchema = object({
  atomCount: decimalNaturalSchema,
  atomIndexRoot: indexRootSchema,
  inventoryEvidence: artifactRefSchema,
  kind: literal("atom-inventory-sealed"),
  runId: runIdSchema,
});

export const atomDispositionedSchema = object({
  disposition: atomDispositionSchema,
  kind: literal("atom-dispositioned"),
  runId: runIdSchema,
});

export const workDeclaredSchema = object({
  kind: literal("work-declared"),
  runId: runIdSchema,
  workItem: workItemSchema,
});

export const dependencyDeclaredSchema = object({
  dependency: workItemIdSchema,
  dependent: workItemIdSchema,
  kind: literal("dependency-declared"),
  planRootId: planRootIdSchema,
  runId: runIdSchema,
});

export const workOutputAcceptedSchema = object({
  accountedDiff: artifactRefSchema,
  evidence: arrayOf(artifactRefSchema),
  inputRoot: artifactRootSchema,
  kind: literal("work-output-accepted"),
  outputRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  submissionId: submissionIdSchema,
  workItemId: workItemIdSchema,
});

export const planRootAcceptedSchema = object({
  coverageRoot: artifactRootSchema,
  integrationOwnerWorkItemId: workItemIdSchema,
  kind: literal("plan-root-accepted"),
  planAuthorWorkItemId: workItemIdSchema,
  planRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
  reviewedPlan: artifactRefSchema,
  runId: runIdSchema,
});

export const planRootSupersededSchema = object({
  kind: literal("plan-root-superseded"),
  newPlanRootId: planRootIdSchema,
  priorPlanRootId: planRootIdSchema,
  reason: artifactRefSchema,
  runId: runIdSchema,
});

const correctionAssignmentSchema = object({
  assignmentId: correctionAssignmentIdSchema,
  correctorWorkItemId: workItemIdSchema,
  originalOwnerWorkItemId: workItemIdSchema,
  scope: correctionScopeSchema,
  work: correctArtifactWorkSchema,
});

const acceptedFindingSchema = union([
  object({
    correction: correctionAssignmentSchema,
    finding: findingSchema,
    kind: literal("blocking-with-correction"),
  }),
  object({
    finding: findingSchema,
    kind: literal("nonblocking"),
  }),
]);

export const findingAcceptedSchema = object({
  acceptance: acceptedFindingSchema,
  kind: literal("finding-accepted"),
  runId: runIdSchema,
});

export const findingClearedSchema = object({
  correctedRoot: artifactRootSchema,
  evidence: arrayOf(evidenceIdSchema),
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

export const routeVerificationObservedSchema = object({
  kind: literal("route-verification-observed"),
  observation: routeVerificationSchema,
  observationId: routeObservationIdSchema,
  rawObservation: artifactRefSchema,
  runId: runIdSchema,
});

export const candidateAcceptedSchema = object({
  candidateId: candidateIdSchema,
  gitRevision: gitCommitIdSchema,
  gitTree: gitTreeIdSchema,
  gitTreeCasAttestation: artifactRefSchema,
  kind: literal("candidate-accepted"),
  manifest: artifactRefSchema,
  planRootId: planRootIdSchema,
  reviewedDiff: artifactRefSchema,
  runId: runIdSchema,
  tree: artifactRootSchema,
});

export const publicationIntendedSchema = object({
  candidateId: candidateIdSchema,
  desiredHead: gitCommitIdSchema,
  expected: expectedRefStateSchema,
  kind: literal("publication-intended"),
  publicationId: publicationIdSchema,
  publicationRef: gitRefSchema,
  repository: repositoryCapabilitySchema,
  runId: runIdSchema,
});

export const publicationObservedSchema = object({
  gitTree: gitTreeIdSchema,
  kind: literal("publication-observed"),
  observedHead: nullable(gitCommitIdSchema),
  publicationId: publicationIdSchema,
  publicationTreeAttestation: artifactRefSchema,
  runId: runIdSchema,
  status: union([literal("desired-head"), literal("head-moved")]),
  tree: artifactRootSchema,
});

export const finalAttestationsRecordedSchema = object({
  advisoryDisclosures: artifactRefSchema,
  c1ToC7Proof: artifactRefSchema,
  candidateId: candidateIdSchema,
  evidenceIndexRoot: indexRootSchema,
  finalManifest: artifactRefSchema,
  finalVerificationEvidence: evidenceIdSchema,
  kind: literal("final-attestations-recorded"),
  publicationId: publicationIdSchema,
  runId: runIdSchema,
});

export const domainFactSchema = union([
  requirementsBoundSchema,
  atomDeclaredSchema,
  atomInventorySealedSchema,
  atomDispositionedSchema,
  workDeclaredSchema,
  dependencyDeclaredSchema,
  workOutputAcceptedSchema,
  planRootAcceptedSchema,
  planRootSupersededSchema,
  findingAcceptedSchema,
  findingClearedSchema,
  evidenceObservedSchema,
  routeVerificationObservedSchema,
  candidateAcceptedSchema,
  publicationIntendedSchema,
  publicationObservedSchema,
  finalAttestationsRecordedSchema,
]);

export type RequirementsBound = Infer<typeof requirementsBoundSchema>;
export type AtomDeclared = Infer<typeof atomDeclaredSchema>;
export type AtomInventorySealed = Infer<typeof atomInventorySealedSchema>;
export type AtomDispositioned = Infer<typeof atomDispositionedSchema>;
export type WorkDeclared = Infer<typeof workDeclaredSchema>;
export type DependencyDeclared = Infer<typeof dependencyDeclaredSchema>;
export type WorkOutputAccepted = Infer<typeof workOutputAcceptedSchema>;
export type PlanRootAccepted = Infer<typeof planRootAcceptedSchema>;
export type PlanRootSuperseded = Infer<typeof planRootSupersededSchema>;
export type FindingAccepted = Infer<typeof findingAcceptedSchema>;
export type FindingCleared = Infer<typeof findingClearedSchema>;
export type EvidenceObserved = Infer<typeof evidenceObservedSchema>;
export type RouteVerificationObserved = Infer<typeof routeVerificationObservedSchema>;
export type CandidateAccepted = Infer<typeof candidateAcceptedSchema>;
export type PublicationIntended = Infer<typeof publicationIntendedSchema>;
export type PublicationObserved = Infer<typeof publicationObservedSchema>;
export type FinalAttestationsRecorded = Infer<typeof finalAttestationsRecordedSchema>;
export type CorrectionAssignment = Infer<typeof correctionAssignmentSchema>;
export type DomainFact = Infer<typeof domainFactSchema>;

export const domainFactCapsule = defineCapsule("DomainFact", domainFactSchema);

export const domainFactExhaustive = Object.freeze({
  "atom-declared": true,
  "atom-dispositioned": true,
  "atom-inventory-sealed": true,
  "candidate-accepted": true,
  "dependency-declared": true,
  "evidence-observed": true,
  "final-attestations-recorded": true,
  "finding-accepted": true,
  "finding-cleared": true,
  "plan-root-accepted": true,
  "plan-root-superseded": true,
  "publication-intended": true,
  "publication-observed": true,
  "requirements-bound": true,
  "route-verification-observed": true,
  "work-declared": true,
  "work-output-accepted": true,
}) satisfies Readonly<Record<DomainFact["kind"], true>>;
