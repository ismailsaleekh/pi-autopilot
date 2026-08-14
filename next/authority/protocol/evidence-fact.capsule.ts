import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  digestSchema,
  evidenceIdSchema,
  evidenceObligationIdSchema,
  exitObservationSchema,
  kindIdSchema,
  ruleIdSchema,
  runIdSchema,
  workItemIdSchema,
  workspaceRelativePathSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const evidenceClassSchema = union([
  literal("mechanical"),
  literal("planning-review"),
  literal("final-verification"),
  literal("advisory-review"),
]);

export const evidenceEnvelopeSchema = object({
  acceptedOutput: artifactRootSchema,
  actionId: actionIdSchema,
  attemptId: attemptIdSchema,
  class: evidenceClassSchema,
  command: artifactRefSchema,
  cwd: workspaceRelativePathSchema,
  environment: artifactRefSchema,
  evidenceId: evidenceIdSchema,
  exit: exitObservationSchema,
  kindId: kindIdSchema,
  obligationId: evidenceObligationIdSchema,
  output: artifactRefSchema,
  ruleId: ruleIdSchema,
  runId: runIdSchema,
  tree: artifactRootSchema,
  workItemId: workItemIdSchema,
});

export type EvidenceEnvelope = Infer<typeof evidenceEnvelopeSchema>;

export const evidenceObservedFactSchema = object({
  envelope: evidenceEnvelopeSchema,
  envelopeDigest: digestSchema,
  kind: literal("evidence-fact"),
});

export const evidenceFactSchema = union([
  evidenceObservedFactSchema,
]);

export type EvidenceClass = Infer<typeof evidenceClassSchema>;
export type EvidenceObservedFact = Infer<typeof evidenceObservedFactSchema>;
export type EvidenceFact = Infer<typeof evidenceFactSchema>;

export const evidenceFactCapsule = defineCapsule("EvidenceFact", evidenceFactSchema);

export const evidenceFactExhaustive = Object.freeze({
  "evidence-fact": true,
}) satisfies Readonly<Record<EvidenceFact["kind"], true>>;
