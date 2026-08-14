import { expectedRefStateSchema, gitCaptureSchema, gitTreeCasAttestationSchema } from "../../authority/protocol/git-values.js";
import {
  actionIdSchema,
  artifactPathSchema,
  artifactRootSchema,
  candidateIdSchema,
  childEpochSchema,
  gitCommitIdSchema,
  gitObjectIdSchema,
  gitRefSchema,
  gitTreeIdSchema,
  kindIdSchema,
  leaseIdSchema,
  publicationIdSchema,
  repositoryCapabilitySchema,
  runIdSchema,
  workspaceCapabilitySchema,
  workspaceIdSchema,
} from "../../authority/protocol/identifiers.js";
import {
  booleanValue,
  canonicalEncodeUnknown,
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer, JsonValue } from "../../authority/protocol/schema.js";
export type { ArtifactPath, ArtifactRef, ArtifactRoot, KindId } from "../../authority/protocol/identifiers.js";
export type { GitCapture } from "../../authority/protocol/git-values.js";
import { toolResultSchemaFor } from "../../authority/protocol/tool-result.capsule.js";
import { defineIntentCapsule } from "./intent-capsule.js";

export const observeRepositoryRefSchema = object({
  actionId: actionIdSchema,
  inputs: object({ publicationRef: gitRefSchema, repository: repositoryCapabilitySchema }),
  kind: literal("observe-repository-ref"),
  preconditions: object({ expected: expectedRefStateSchema }),
  runId: runIdSchema,
});

export const materializeWorkspaceSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    baseCommit: gitCommitIdSchema,
    baseTree: gitTreeIdSchema,
    repository: repositoryCapabilitySchema,
    workspaceCapability: workspaceCapabilitySchema,
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("materialize-workspace"),
  preconditions: object({
    expectedEmptyReservation: literal(true),
    reservationLease: leaseIdSchema,
  }),
  runId: runIdSchema,
});

export const sealWorkspaceSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    repository: repositoryCapabilitySchema,
    workspaceCapability: workspaceCapabilitySchema,
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("seal-workspace"),
  preconditions: object({
    childEpoch: childEpochSchema,
    expectedInputRoot: artifactRootSchema,
    reservationLease: leaseIdSchema,
  }),
  runId: runIdSchema,
});

export const compareRootsSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    leftTree: gitTreeIdSchema,
    repository: repositoryCapabilitySchema,
    rightTree: gitTreeIdSchema,
  }),
  kind: literal("compare-roots"),
  preconditions: object({ boundedCapture: literal(true) }),
  runId: runIdSchema,
});

export const integrateCandidateSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    baseCommit: gitCommitIdSchema,
    baseTree: gitTreeIdSchema,
    candidateCommit: gitCommitIdSchema,
    candidateId: candidateIdSchema,
    candidateTree: gitTreeIdSchema,
    repository: repositoryCapabilitySchema,
    workspaceCapability: workspaceCapabilitySchema,
  }),
  kind: literal("integrate-candidate"),
  preconditions: object({
    expectedIntegrationRoot: artifactRootSchema,
    oneCandidate: literal(true),
  }),
  runId: runIdSchema,
});

export const publishIfExpectedHeadSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    desiredHead: gitCommitIdSchema,
    expected: expectedRefStateSchema,
    publicationId: publicationIdSchema,
    publicationRef: gitRefSchema,
    repository: repositoryCapabilitySchema,
  }),
  kind: literal("publish-if-expected-head"),
  preconditions: object({
    candidateTree: gitTreeIdSchema,
    publicationLease: leaseIdSchema,
    verifiedAttestation: gitTreeCasAttestationSchema,
  }),
  runId: runIdSchema,
});

export const gitIntentSchema = union([
  observeRepositoryRefSchema,
  materializeWorkspaceSchema,
  sealWorkspaceSchema,
  compareRootsSchema,
  integrateCandidateSchema,
  publishIfExpectedHeadSchema,
]);

const observedRepositoryRefResultSchema = object({
  observed: expectedRefStateSchema,
  publicationRef: gitRefSchema,
  repository: repositoryCapabilitySchema,
  tree: nullable(gitTreeIdSchema),
});
const materializedWorkspaceResultSchema = object({
  baseCommit: gitCommitIdSchema,
  baseTree: gitTreeIdSchema,
  repository: repositoryCapabilitySchema,
  workspaceId: workspaceIdSchema,
});
const sealedWorkspaceResultSchema = object({
  capture: gitCaptureSchema,
  gitTree: gitTreeIdSchema,
  workspaceId: workspaceIdSchema,
});
const comparedRootsResultSchema = object({
  diff: gitCaptureSchema,
  equal: booleanValue(),
  leftTree: gitTreeIdSchema,
  rightTree: gitTreeIdSchema,
});
const integrationResultSchema = union([
  object({
    candidateId: candidateIdSchema,
    commit: gitCommitIdSchema,
    conflict: nullable(gitCaptureSchema),
    diff: gitCaptureSchema,
    kind: literal("integrated"),
    manifest: gitCaptureSchema,
    tree: gitTreeIdSchema,
    treeAttestation: gitTreeCasAttestationSchema,
  }),
  object({
    candidateId: candidateIdSchema,
    conflict: gitCaptureSchema,
    kind: literal("conflict"),
  }),
]);
const publishedHeadResultSchema = object({
  desiredHead: gitCommitIdSchema,
  gitTree: gitTreeIdSchema,
  observedHead: nullable(gitCommitIdSchema),
  publicationId: publicationIdSchema,
  status: union([literal("desired-head"), literal("head-moved")]),
});

export const repositoryRefObservedSchema = object({
  actionId: actionIdSchema,
  kind: literal("repository-ref-observed"),
  result: toolResultSchemaFor(observedRepositoryRefResultSchema),
  runId: runIdSchema,
});
export const workspaceMaterializedSchema = object({
  actionId: actionIdSchema,
  kind: literal("workspace-materialized"),
  result: toolResultSchemaFor(materializedWorkspaceResultSchema),
  runId: runIdSchema,
});
export const workspaceSealedSchema = object({
  actionId: actionIdSchema,
  kind: literal("workspace-sealed"),
  result: toolResultSchemaFor(sealedWorkspaceResultSchema),
  runId: runIdSchema,
});
export const rootsComparedSchema = object({
  actionId: actionIdSchema,
  kind: literal("roots-compared"),
  result: toolResultSchemaFor(comparedRootsResultSchema),
  runId: runIdSchema,
});
export const candidateIntegratedSchema = object({
  actionId: actionIdSchema,
  kind: literal("candidate-integrated"),
  result: toolResultSchemaFor(integrationResultSchema),
  runId: runIdSchema,
});
export const headPublicationObservedSchema = object({
  actionId: actionIdSchema,
  kind: literal("head-publication-observed"),
  result: toolResultSchemaFor(publishedHeadResultSchema),
  runId: runIdSchema,
});

export const gitObservationSchema = union([
  repositoryRefObservedSchema,
  workspaceMaterializedSchema,
  workspaceSealedSchema,
  rootsComparedSchema,
  candidateIntegratedSchema,
  headPublicationObservedSchema,
]);

export type ObserveRepositoryRef = Infer<typeof observeRepositoryRefSchema>;
export type MaterializeWorkspace = Infer<typeof materializeWorkspaceSchema>;
export type SealWorkspace = Infer<typeof sealWorkspaceSchema>;
export type CompareRoots = Infer<typeof compareRootsSchema>;
export type IntegrateCandidate = Infer<typeof integrateCandidateSchema>;
export type PublishIfExpectedHead = Infer<typeof publishIfExpectedHeadSchema>;
export type GitIntent = Infer<typeof gitIntentSchema>;
export type RepositoryRefObserved = Infer<typeof repositoryRefObservedSchema>;
export type WorkspaceMaterialized = Infer<typeof workspaceMaterializedSchema>;
export type WorkspaceSealed = Infer<typeof workspaceSealedSchema>;
export type RootsCompared = Infer<typeof rootsComparedSchema>;
export type CandidateIntegrated = Infer<typeof candidateIntegratedSchema>;
export type HeadPublicationObserved = Infer<typeof headPublicationObservedSchema>;
export type GitObservation = Infer<typeof gitObservationSchema>;

export const gitIntentCapsule = defineIntentCapsule("GitIntent", "git", gitIntentSchema);
export const gitObservationCapsule = defineCapsule("GitObservation", gitObservationSchema);

const adapterArtifactPathCapsule = defineCapsule("GitAdapterArtifactPath", artifactPathSchema);
const adapterKindIdCapsule = defineCapsule("GitAdapterKindId", kindIdSchema);
const adapterObjectIdCapsule = defineCapsule("GitAdapterObjectId", gitObjectIdSchema);
const adapterTreeIdCapsule = defineCapsule("GitAdapterTreeId", gitTreeIdSchema);

export function decodeGitArtifactPath(value: string) {
  const decoded = adapterArtifactPathCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}
export function decodeGitKindId(value: string) {
  const decoded = adapterKindIdCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}
export function decodeGitObjectId(value: string) {
  const decoded = adapterObjectIdCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}
export function decodeGitTreeId(value: string) {
  const decoded = adapterTreeIdCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}
export function encodeGitCanonicalValue(value: JsonValue): Uint8Array {
  return canonicalEncodeUnknown(value);
}

export const gitIntentExhaustive = Object.freeze({
  "compare-roots": true,
  "integrate-candidate": true,
  "materialize-workspace": true,
  "observe-repository-ref": true,
  "publish-if-expected-head": true,
  "seal-workspace": true,
}) satisfies Readonly<Record<GitIntent["kind"], true>>;

export const gitObservationExhaustive = Object.freeze({
  "candidate-integrated": true,
  "head-publication-observed": true,
  "repository-ref-observed": true,
  "roots-compared": true,
  "workspace-materialized": true,
  "workspace-sealed": true,
}) satisfies Readonly<Record<GitObservation["kind"], true>>;
