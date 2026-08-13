import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  candidateIdSchema,
  childEpochSchema,
  leaseIdSchema,
  publicationIdSchema,
  revisionIdSchema,
  runIdSchema,
  workspaceIdSchema,
} from "../../authority/protocol/identifiers.js";
import {
  booleanValue,
  defineCapsule,
  literal,
  object,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { toolResultSchemaFor } from "../../authority/protocol/tool-result.capsule.js";
import { defineIntentCapsule } from "./intent-capsule.js";

export const materializeWorkspaceSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    baseRevision: revisionIdSchema,
    repositorySnapshot: artifactRootSchema,
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("materialize-workspace"),
  preconditions: object({
    expectedAbsent: literal(true),
    repositoryIdentity: artifactRootSchema,
  }),
  runId: runIdSchema,
});

export const sealWorkspaceSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("seal-workspace"),
  preconditions: object({
    childEpoch: childEpochSchema,
    expectedInputRoot: artifactRootSchema,
  }),
  runId: runIdSchema,
});

export const compareRootsSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    leftRoot: artifactRootSchema,
    rightRoot: artifactRootSchema,
  }),
  kind: literal("compare-roots"),
  preconditions: object({
    repositoryIdentity: artifactRootSchema,
  }),
  runId: runIdSchema,
});

export const integrateCandidateSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    acceptedOutputs: artifactRefSchema,
    baseRevision: revisionIdSchema,
    candidateId: candidateIdSchema,
  }),
  kind: literal("integrate-candidate"),
  preconditions: object({
    expectedIntegrationRoot: artifactRootSchema,
    repositoryIdentity: artifactRootSchema,
  }),
  runId: runIdSchema,
});

export const publishIfExpectedHeadSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    desiredHead: revisionIdSchema,
    expectedHead: revisionIdSchema,
    publicationId: publicationIdSchema,
  }),
  kind: literal("publish-if-expected-head"),
  preconditions: object({
    candidateTree: artifactRootSchema,
    publicationLease: leaseIdSchema,
    verifiedManifest: artifactRefSchema,
  }),
  runId: runIdSchema,
});

export const gitIntentSchema = union([
  materializeWorkspaceSchema,
  sealWorkspaceSchema,
  compareRootsSchema,
  integrateCandidateSchema,
  publishIfExpectedHeadSchema,
]);

const materializedWorkspaceResultSchema = object({
  baseRevision: revisionIdSchema,
  materializedRoot: artifactRootSchema,
  workspaceId: workspaceIdSchema,
});
const sealedWorkspaceResultSchema = object({
  manifest: artifactRefSchema,
  outputRoot: artifactRootSchema,
  workspaceId: workspaceIdSchema,
});
const comparedRootsResultSchema = object({
  diff: artifactRefSchema,
  equal: booleanValue(),
  leftRoot: artifactRootSchema,
  rightRoot: artifactRootSchema,
});
const integratedCandidateResultSchema = object({
  candidateId: candidateIdSchema,
  manifest: artifactRefSchema,
  revision: revisionIdSchema,
  tree: artifactRootSchema,
});
const publishedHeadResultSchema = object({
  desiredHead: revisionIdSchema,
  observedHead: revisionIdSchema,
  publicationId: publicationIdSchema,
  status: union([
    literal("published"),
    literal("already-published"),
    literal("head-moved"),
  ]),
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
  result: toolResultSchemaFor(integratedCandidateResultSchema),
  runId: runIdSchema,
});
export const headPublicationObservedSchema = object({
  actionId: actionIdSchema,
  kind: literal("head-publication-observed"),
  result: toolResultSchemaFor(publishedHeadResultSchema),
  runId: runIdSchema,
});

export const gitObservationSchema = union([
  workspaceMaterializedSchema,
  workspaceSealedSchema,
  rootsComparedSchema,
  candidateIntegratedSchema,
  headPublicationObservedSchema,
]);

export type MaterializeWorkspace = Infer<typeof materializeWorkspaceSchema>;
export type SealWorkspace = Infer<typeof sealWorkspaceSchema>;
export type CompareRoots = Infer<typeof compareRootsSchema>;
export type IntegrateCandidate = Infer<typeof integrateCandidateSchema>;
export type PublishIfExpectedHead = Infer<typeof publishIfExpectedHeadSchema>;
export type GitIntent = Infer<typeof gitIntentSchema>;
export type WorkspaceMaterialized = Infer<typeof workspaceMaterializedSchema>;
export type WorkspaceSealed = Infer<typeof workspaceSealedSchema>;
export type RootsCompared = Infer<typeof rootsComparedSchema>;
export type CandidateIntegrated = Infer<typeof candidateIntegratedSchema>;
export type HeadPublicationObserved = Infer<typeof headPublicationObservedSchema>;
export type GitObservation = Infer<typeof gitObservationSchema>;

export const gitIntentCapsule = defineIntentCapsule("GitIntent", "git", gitIntentSchema);
export const gitObservationCapsule = defineCapsule("GitObservation", gitObservationSchema);

export const gitIntentExhaustive = Object.freeze({
  "compare-roots": true,
  "integrate-candidate": true,
  "materialize-workspace": true,
  "publish-if-expected-head": true,
  "seal-workspace": true,
}) satisfies Readonly<Record<GitIntent["kind"], true>>;

export const gitObservationExhaustive = Object.freeze({
  "candidate-integrated": true,
  "head-publication-observed": true,
  "roots-compared": true,
  "workspace-materialized": true,
  "workspace-sealed": true,
}) satisfies Readonly<Record<GitObservation["kind"], true>>;
