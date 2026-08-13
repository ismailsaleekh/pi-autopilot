import {
  artifactRefSchema,
  captureIdSchema,
  childEpochSchema,
  digestSchema,
  kindIdSchema,
  processGroupIdSchema,
  processIdSchema,
  routeCapabilitySchema,
  routeObservationIdSchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from "./identifiers.js";
import {
  arrayOf,
  booleanValue,
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const thinkingLevelSchema = union([
  literal("off"),
  literal("minimal"),
  literal("low"),
  literal("medium"),
  literal("high"),
  literal("xhigh"),
  literal("max"),
]);

export const subscriptionRouteSchema = object({
  catalogDigest: digestSchema,
  channel: literal("subscription"),
  model: kindIdSchema,
  piVersion: kindIdSchema,
  policyDigest: digestSchema,
  provider: kindIdSchema,
  routeCapability: routeCapabilitySchema,
  thinking: thinkingLevelSchema,
  toolBundleAttestation: nullable(artifactRefSchema),
});

export const compactionContractSchema = union([
  object({
    kind: literal("disabled"),
  }),
  object({
    instructions: artifactRefSchema,
    kind: literal("sealed-summary"),
    priorSummary: artifactRefSchema,
  }),
]);

export const childMemorySeedSchema = union([
  object({
    initialPrompt: artifactRefSchema,
    kind: literal("initial"),
  }),
  object({
    compaction: compactionContractSchema,
    continuationPrompt: artifactRefSchema,
    evidencePages: arrayOf(artifactRefSchema),
    kind: literal("continuation"),
    predecessorAttempt: kindIdSchema,
    sealedScratch: artifactRefSchema,
  }),
]);

export const processLifecycleSchema = union([
  object({ kind: literal("running") }),
  object({ code: kindIdSchema, kind: literal("exited") }),
  object({ kind: literal("signalled"), signal: kindIdSchema }),
  object({ kind: literal("absent") }),
]);

export const processObservationSchema = object({
  captureId: captureIdSchema,
  childEpoch: childEpochSchema,
  lifecycle: processLifecycleSchema,
  processGroupId: processGroupIdSchema,
  processId: processIdSchema,
  stderr: workspaceRelativePathSchema,
  stderrTruncated: booleanValue(),
  stdout: workspaceRelativePathSchema,
  stdoutTruncated: booleanValue(),
  workspaceId: workspaceIdSchema,
});

export const routeVerificationSchema = object({
  observationId: routeObservationIdSchema,
  route: subscriptionRouteSchema,
  verified: literal(true),
});

export const sessionObservationSchema = object({
  process: processObservationSchema,
  sessionFile: nullable(workspaceRelativePathSchema),
  sessionId: kindIdSchema,
  sessionFiles: arrayOf(workspaceRelativePathSchema),
});

export type ThinkingLevel = Infer<typeof thinkingLevelSchema>;
export type SubscriptionRoute = Infer<typeof subscriptionRouteSchema>;
export type CompactionContract = Infer<typeof compactionContractSchema>;
export type ChildMemorySeed = Infer<typeof childMemorySeedSchema>;
export type ProcessObservation = Infer<typeof processObservationSchema>;
export type RouteVerification = Infer<typeof routeVerificationSchema>;
export type SessionObservation = Infer<typeof sessionObservationSchema>;

export const routeContractSchema = union([
  object({ kind: literal("route"), value: subscriptionRouteSchema }),
  object({ kind: literal("memory-seed"), value: childMemorySeedSchema }),
  object({ kind: literal("process-observation"), value: processObservationSchema }),
  object({ kind: literal("route-verification"), value: routeVerificationSchema }),
]);

export const routeCapsule = defineCapsule("RouteContract", routeContractSchema);

export const routeContractExhaustive = Object.freeze({
  "memory-seed": true,
  "process-observation": true,
  "route-verification": true,
  route: true,
}) satisfies Readonly<Record<Infer<typeof routeContractSchema>["kind"], true>>;
