import { atomDispositionSchema, atomSchema } from "./atom.capsule.js";
import { evidenceFactSchema } from "./evidence-fact.capsule.js";
import { findingSchema } from "./finding.capsule.js";
import { expectedRefStateSchema, gitTreeCasAttestationSchema } from "./git-values.js";
import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  candidateIdSchema,
  childEpochSchema,
  childIdSchema,
  commandIdSchema,
  decimalNaturalSchema,
  diagnosticSchema,
  digestSchema,
  evidenceIdSchema,
  findingIdSchema,
  gitCommitIdSchema,
  gitRefSchema,
  gitTreeIdSchema,
  indexRootSchema,
  leaseIdSchema,
  operatorRequestIdSchema,
  planRootIdSchema,
  publicationIdSchema,
  repositoryCapabilitySchema,
  runIdSchema,
  submissionIdSchema,
  workItemIdSchema,
  workspaceCapabilitySchema,
  workspaceIdSchema,
} from "./identifiers.js";
import { routeVerificationSchema, sessionObservationSchema } from "./route.capsule.js";
import {
  arrayOf,
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";
import { resolvedIndexPageSchema } from "./state-index.capsule.js";
import { workItemSchema } from "./work-item.capsule.js";

const requestPayloadSchema = union([
  object({
    atomIndexRoot: indexRootSchema,
    declaredAtomCount: decimalNaturalSchema,
    kind: literal("bind-requirements-v2"),
    requirementsRoot: artifactRootSchema,
    sourceRoot: artifactRootSchema,
    taskRoot: artifactRootSchema,
  }),
  object({
    atom: atomSchema,
    kind: literal("declare-atom-v2"),
  }),
  object({
    atomCount: decimalNaturalSchema,
    atomIndexRoot: indexRootSchema,
    inventoryEvidence: artifactRefSchema,
    kind: literal("seal-atom-inventory-v2"),
  }),
  object({
    kind: literal("declare-work-v2"),
    workItem: workItemSchema,
  }),
  object({
    dependency: workItemIdSchema,
    dependent: workItemIdSchema,
    kind: literal("declare-dependency-v2"),
    planRootId: planRootIdSchema,
  }),
  object({
    candidateId: candidateIdSchema,
    desiredHead: gitCommitIdSchema,
    expected: expectedRefStateSchema,
    kind: literal("intend-publication-v2"),
    publicationId: publicationIdSchema,
    publicationLease: leaseIdSchema,
    publicationRef: gitRefSchema,
    repository: repositoryCapabilitySchema,
  }),
]);

export const submissionPayloadSchema = union([
  object({
    coverageRoot: artifactRootSchema,
    integrationOwnerWorkItemId: workItemIdSchema,
    kind: literal("accept-plan-v2"),
    planAuthorWorkItemId: workItemIdSchema,
    planRoot: artifactRootSchema,
    reviewedPlan: artifactRefSchema,
  }),
  object({
    disposition: atomDispositionSchema,
    kind: literal("disposition-atom-v2"),
  }),
  object({
    accountedDiff: artifactRefSchema,
    evidence: arrayOf(artifactRefSchema),
    kind: literal("accept-work-output-v2"),
    submissionId: submissionIdSchema,
  }),
  object({
    finding: findingSchema,
    kind: literal("accept-finding-v2"),
  }),
  object({
    correctedRoot: artifactRootSchema,
    evidence: arrayOf(evidenceIdSchema),
    findingId: findingIdSchema,
    kind: literal("clear-finding-v2"),
    resolution: artifactRefSchema,
  }),
  object({
    evidence: evidenceFactSchema,
    kind: literal("accept-evidence-v2"),
  }),
  object({
    candidateId: candidateIdSchema,
    gitRevision: gitCommitIdSchema,
    gitTree: gitTreeIdSchema,
    gitTreeCasAttestation: gitTreeCasAttestationSchema,
    kind: literal("accept-candidate-v2"),
    manifest: artifactRefSchema,
    reviewedDiff: artifactRefSchema,
    tree: artifactRootSchema,
  }),
  object({
    advisoryDisclosures: artifactRefSchema,
    c1ToC7Proof: artifactRefSchema,
    candidateId: candidateIdSchema,
    evidenceIndexRoot: indexRootSchema,
    finalManifest: artifactRefSchema,
    finalVerificationEvidence: evidenceIdSchema,
    kind: literal("record-final-attestations-v2"),
    publicationId: publicationIdSchema,
  }),
]);

const commandObservationPayloadSchema = union([
  object({
    kind: literal("workspace-reserved-v2"),
    leaseId: leaseIdSchema,
    workspaceCapability: workspaceCapabilitySchema,
    workspaceId: workspaceIdSchema,
  }),
  object({
    gitTree: gitTreeIdSchema,
    kind: literal("workspace-materialized-v2"),
    workspaceCapability: workspaceCapabilitySchema,
    workspaceId: workspaceIdSchema,
  }),
  object({
    kind: literal("route-verified-v2"),
    route: routeVerificationSchema,
  }),
  object({
    childEpoch: childEpochSchema,
    childId: childIdSchema,
    kind: literal("child-observed-v2"),
    sealedRoot: nullable(artifactRootSchema),
    session: sessionObservationSchema,
  }),
  object({
    evidence: evidenceFactSchema,
    kind: literal("evidence-observed-v2"),
  }),
  object({
    finding: findingSchema,
    kind: literal("validation-finding-v2"),
  }),
  object({
    candidateId: candidateIdSchema,
    gitRevision: gitCommitIdSchema,
    gitTree: gitTreeIdSchema,
    gitTreeCasAttestation: gitTreeCasAttestationSchema,
    kind: literal("candidate-integrated-v2"),
    manifest: artifactRefSchema,
    planRootId: planRootIdSchema,
    reviewedDiff: artifactRefSchema,
    tree: artifactRootSchema,
  }),
  object({
    conflict: artifactRefSchema,
    integrationOwnerWorkItemId: workItemIdSchema,
    kind: literal("integration-conflict-v2"),
    planRootId: planRootIdSchema,
    subjectRoot: artifactRootSchema,
  }),
  object({
    gitTree: gitTreeIdSchema,
    kind: literal("publication-observed-v2"),
    observedHead: nullable(gitCommitIdSchema),
    publicationId: publicationIdSchema,
    publicationTreeAttestation: gitTreeCasAttestationSchema,
    status: union([literal("desired-head"), literal("head-moved")]),
    tree: artifactRootSchema,
  }),
  object({
    kind: literal("clock-observed-v2"),
    tick: decimalNaturalSchema,
  }),
  object({
    artifact: artifactRefSchema,
    kind: literal("artifact-installed-v2"),
  }),
  object({
    kind: literal("command-observed-v2"),
  }),
  object({
    diagnostic: diagnosticSchema,
    kind: literal("command-retry-v2"),
  }),
]);

const proofPages = { pages: arrayOf(resolvedIndexPageSchema) };

export const boundaryRequestReceivedSchema = object({
  ...proofPages,
  actionId: actionIdSchema,
  kind: literal("boundary-request-received"),
  request: artifactRefSchema,
  requestDigest: digestSchema,
  requestPayload: requestPayloadSchema,
  runId: runIdSchema,
});

export const submissionReadySchema = object({
  ...proofPages,
  actionId: actionIdSchema,
  attemptId: attemptIdSchema,
  inputRoot: artifactRootSchema,
  kind: literal("submission-ready"),
  outputRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  submissionPayload: submissionPayloadSchema,
  workItemId: workItemIdSchema,
});

export const commandObservationReceivedSchema = object({
  ...proofPages,
  actionId: actionIdSchema,
  commandId: commandIdSchema,
  kind: literal("command-observation-received"),
  observation: artifactRefSchema,
  observationDigest: digestSchema,
  observationPayload: commandObservationPayloadSchema,
  runId: runIdSchema,
});

export const runReplayCompletedSchema = object({
  ...proofPages,
  actionId: actionIdSchema,
  kind: literal("run-replay-completed"),
  lastSequence: decimalNaturalSchema,
  runId: runIdSchema,
  stateDigest: digestSchema,
});

export const operatorSuspendRequestedSchema = object({
  ...proofPages,
  actionId: actionIdSchema,
  kind: literal("operator-suspend-requested"),
  operatorRequestId: operatorRequestIdSchema,
  reason: artifactRefSchema,
  runId: runIdSchema,
});

export const operatorResumeRequestedSchema = object({
  ...proofPages,
  actionId: actionIdSchema,
  kind: literal("operator-resume-requested"),
  operatorRequestId: operatorRequestIdSchema,
  resumeFromSequence: decimalNaturalSchema,
  runId: runIdSchema,
});

export const stimulusSchema = union([
  boundaryRequestReceivedSchema,
  submissionReadySchema,
  commandObservationReceivedSchema,
  runReplayCompletedSchema,
  operatorSuspendRequestedSchema,
  operatorResumeRequestedSchema,
]);

export type RequestPayload = Infer<typeof requestPayloadSchema>;
export type SubmissionPayload = Infer<typeof submissionPayloadSchema>;
export type CommandObservationPayload = Infer<typeof commandObservationPayloadSchema>;
export type BoundaryRequestReceived = Infer<typeof boundaryRequestReceivedSchema>;
export type SubmissionReady = Infer<typeof submissionReadySchema>;
export type CommandObservationReceived = Infer<typeof commandObservationReceivedSchema>;
export type RunReplayCompleted = Infer<typeof runReplayCompletedSchema>;
export type OperatorSuspendRequested = Infer<typeof operatorSuspendRequestedSchema>;
export type OperatorResumeRequested = Infer<typeof operatorResumeRequestedSchema>;
export type Stimulus = Infer<typeof stimulusSchema>;

export const stimulusCapsule = defineCapsule("Stimulus", stimulusSchema);

export const stimulusExhaustive = Object.freeze({
  "boundary-request-received": true,
  "command-observation-received": true,
  "operator-resume-requested": true,
  "operator-suspend-requested": true,
  "run-replay-completed": true,
  "submission-ready": true,
}) satisfies Readonly<Record<Stimulus["kind"], true>>;
