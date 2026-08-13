import {
  actionIdSchema,
  artifactRootSchema,
  diagnosticSchema,
  digestSchema,
  runIdSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const acceptIngestSchema = object({
  acceptedRoot: artifactRootSchema,
  actionId: actionIdSchema,
  commandRoot: artifactRootSchema,
  factRoot: artifactRootSchema,
  kind: literal("accept"),
  runId: runIdSchema,
  stateDigest: digestSchema,
});

export const retryIngestSchema = object({
  diagnostic: diagnosticSchema,
  kind: literal("retry"),
});

export const ingestDecisionSchema = union([
  acceptIngestSchema,
  retryIngestSchema,
]);

export type AcceptIngest = Infer<typeof acceptIngestSchema>;
export type RetryIngest = Infer<typeof retryIngestSchema>;
export type IngestDecision = Infer<typeof ingestDecisionSchema>;

export const ingestDecisionCapsule = defineCapsule("IngestDecision", ingestDecisionSchema);

export const ingestDecisionExhaustive = Object.freeze({
  accept: true,
  retry: true,
}) satisfies Readonly<Record<IngestDecision["kind"], true>>;
