import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  digestSchema,
  evidenceIdSchema,
  exitObservationSchema,
  kindIdSchema,
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

export const evidenceEnvelopeSchema = object({
  actionId: actionIdSchema,
  attemptId: attemptIdSchema,
  command: artifactRefSchema,
  cwd: workspaceRelativePathSchema,
  environment: artifactRefSchema,
  evidenceId: evidenceIdSchema,
  exit: exitObservationSchema,
  kindId: kindIdSchema,
  output: artifactRefSchema,
  runId: runIdSchema,
  tree: artifactRootSchema,
  workItemId: workItemIdSchema,
});

type DerivedEvidenceEnvelope = Infer<typeof evidenceEnvelopeSchema>;
declare const evidenceEnvelopeCapability: unique symbol;

export interface EvidenceEnvelope extends DerivedEvidenceEnvelope {
  readonly [evidenceEnvelopeCapability]: true;
}

export const evidenceObservedFactSchema = object({
  envelope: evidenceEnvelopeSchema,
  envelopeDigest: digestSchema,
  kind: literal("evidence-fact"),
});

export const evidenceFactSchema = union([
  evidenceObservedFactSchema,
]);

export type EvidenceObservedFact = Infer<typeof evidenceObservedFactSchema>;
export type EvidenceFact = Infer<typeof evidenceFactSchema>;

export const evidenceFactCapsule = defineCapsule("EvidenceFact", evidenceFactSchema);

export const evidenceFactExhaustive = Object.freeze({
  "evidence-fact": true,
}) satisfies Readonly<Record<EvidenceFact["kind"], true>>;
