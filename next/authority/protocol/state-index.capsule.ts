import { atomDispositionSchema, atomSchema } from "./atom.capsule.js";
import { commandSchema } from "./command.capsule.js";
import { expectedRefStateSchema } from "./git-values.js";
import { evidenceFactSchema } from "./evidence-fact.capsule.js";
import { findingSchema } from "./finding.capsule.js";
import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  candidateIdSchema,
  commandIdSchema,
  decimalNaturalSchema,
  digestSchema,
  gitCommitIdSchema,
  gitTreeIdSchema,
  indexRootSchema,
  planRootIdSchema,
  publicationIdSchema,
  runIdSchema,
  submissionIdSchema,
  workItemIdSchema,
} from "./identifiers.js";
import {
  arrayOf,
  canonicalDigestUnknown,
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";
import { workItemSchema } from "./work-item.capsule.js";

export const indexNameSchema = union([
  literal("actions"),
  literal("atoms"),
  literal("candidates"),
  literal("commands"),
  literal("dependencies"),
  literal("dispositions"),
  literal("evidence"),
  literal("findings"),
  literal("plans"),
  literal("publications"),
  literal("submissions"),
  literal("work"),
]);

const acceptedOutputSchema = object({
  accountedDiff: artifactRefSchema,
  evidence: arrayOf(artifactRefSchema),
  outputRoot: artifactRootSchema,
  submissionId: submissionIdSchema,
});

const workIndexValueSchema = object({
  acceptedOutput: nullable(acceptedOutputSchema),
  kind: literal("work"),
  workItem: workItemSchema,
});

const submissionIndexValueSchema = object({
  acceptedOutput: acceptedOutputSchema,
  kind: literal("submission"),
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  workItemId: workItemIdSchema,
});

const planIndexValueSchema = object({
  coverageRoot: artifactRootSchema,
  integrationOwnerWorkItemId: workItemIdSchema,
  kind: literal("plan"),
  planAuthorWorkItemId: workItemIdSchema,
  planRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
  reviewedPlan: artifactRefSchema,
  runId: runIdSchema,
  supersededBy: nullable(planRootIdSchema),
});

const findingIndexValueSchema = object({
  correctionWorkItemId: nullable(workItemIdSchema),
  finding: findingSchema,
  kind: literal("finding"),
  resolution: nullable(artifactRefSchema),
  status: union([literal("open"), literal("cleared")]),
});

const candidateIndexValueSchema = object({
  candidateId: candidateIdSchema,
  gitRevision: gitCommitIdSchema,
  gitTree: gitTreeIdSchema,
  gitTreeCasAttestation: artifactRefSchema,
  kind: literal("candidate"),
  manifest: artifactRefSchema,
  planRootId: planRootIdSchema,
  reviewedDiff: artifactRefSchema,
  runId: runIdSchema,
  tree: artifactRootSchema,
});

const publicationIndexValueSchema = object({
  candidateId: candidateIdSchema,
  desiredHead: gitCommitIdSchema,
  expected: expectedRefStateSchema,
  kind: literal("publication"),
  observedHead: nullable(gitCommitIdSchema),
  publicationId: publicationIdSchema,
  publicationTreeAttestation: nullable(artifactRefSchema),
  runId: runIdSchema,
  status: union([literal("intended"), literal("desired-head"), literal("head-moved")]),
});

const actionIndexValueSchema = object({
  actionId: actionIdSchema,
  kind: literal("action"),
  recordKind: union([
    literal("decision-committed"),
    literal("command-settled"),
    literal("outcome-committed"),
    literal("run-suspended"),
    literal("run-resumed"),
  ]),
  sequence: decimalNaturalSchema,
});

const commandIndexValueSchema = object({
  command: commandSchema,
  commandId: commandIdSchema,
  kind: literal("command"),
  observation: nullable(artifactRefSchema),
  status: union([literal("issued"), literal("settled")]),
});

const dependencyIndexValueSchema = object({
  dependency: workItemIdSchema,
  dependent: workItemIdSchema,
  kind: literal("dependency"),
  planRootId: planRootIdSchema,
  runId: runIdSchema,
});

export const indexValueSchema = union([
  object({ atom: atomSchema, kind: literal("atom") }),
  object({ disposition: atomDispositionSchema, kind: literal("disposition") }),
  workIndexValueSchema,
  submissionIndexValueSchema,
  planIndexValueSchema,
  findingIndexValueSchema,
  object({ evidence: evidenceFactSchema, kind: literal("evidence") }),
  candidateIndexValueSchema,
  publicationIndexValueSchema,
  commandIndexValueSchema,
  actionIndexValueSchema,
  dependencyIndexValueSchema,
]);

export const sparseWitnessSchema = object({
  key: digestSchema,
  siblings: arrayOf(digestSchema),
  value: nullable(indexValueSchema),
});

export const resolvedIndexPageSchema = object({
  index: indexNameSchema,
  root: indexRootSchema,
  witnesses: arrayOf(sparseWitnessSchema),
});

export const indexMutationSchema = object({
  index: indexNameSchema,
  key: digestSchema,
  nextValueDigest: nullable(digestSchema),
  priorValueDigest: nullable(digestSchema),
  siblings: arrayOf(digestSchema),
});

export type AcceptedOutput = Infer<typeof acceptedOutputSchema>;
export type WorkIndexValue = Infer<typeof workIndexValueSchema>;
export type PlanIndexValue = Infer<typeof planIndexValueSchema>;
export type FindingIndexValue = Infer<typeof findingIndexValueSchema>;
export type CandidateIndexValue = Infer<typeof candidateIndexValueSchema>;
export type PublicationIndexValue = Infer<typeof publicationIndexValueSchema>;
export type ExpectedRefState = Infer<typeof expectedRefStateSchema>;
export type IndexName = Infer<typeof indexNameSchema>;
export type IndexValue = Infer<typeof indexValueSchema>;
export type SparseWitness = Infer<typeof sparseWitnessSchema>;
export type ResolvedIndexPage = Infer<typeof resolvedIndexPageSchema>;
export type IndexMutation = Infer<typeof indexMutationSchema>;

export const stateIndexCapsule = defineCapsule("StateIndex", union([
  object({ kind: literal("page"), value: resolvedIndexPageSchema }),
  object({ kind: literal("mutation"), value: indexMutationSchema }),
]));

export function indexValueDigest(value: IndexValue) {
  return canonicalDigestUnknown(value);
}

export function indexKeyDigest(index: IndexName, identity: string) {
  return canonicalDigestUnknown(Object.freeze({
    domain: "pi-autopilot.index-key.v2",
    identity,
    index,
  }));
}

export function sparseEmptyLeafDigest() {
  return canonicalDigestUnknown(Object.freeze({ domain: "pi-autopilot.sparse-index.empty.v2" }));
}

export function sparsePresentLeafDigest(key: string, valueDigest: string) {
  return canonicalDigestUnknown(Object.freeze({
    domain: "pi-autopilot.sparse-index.leaf.v2",
    key,
    valueDigest,
  }));
}

export function sparseNodeDigest(left: string, right: string) {
  return canonicalDigestUnknown(Object.freeze({
    domain: "pi-autopilot.sparse-index.node.v2",
    left,
    right,
  }));
}

export function indexMutationDigest(value: IndexMutation) {
  return canonicalDigestUnknown(value);
}
