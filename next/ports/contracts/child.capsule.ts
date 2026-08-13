import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  childEpochSchema,
  childIdSchema,
  digestSchema,
  roleIdSchema,
  runIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from "../../authority/protocol/identifiers.js";
import {
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { toolResultSchemaFor } from "../../authority/protocol/tool-result.capsule.js";
import { defineIntentCapsule } from "./intent-capsule.js";

export const launchChildSessionSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    attemptId: attemptIdSchema,
    prompt: artifactRefSchema,
    roleId: roleIdSchema,
    runtimeRoot: artifactRootSchema,
    workItemId: workItemIdSchema,
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("launch-child-session"),
  preconditions: object({
    childEpoch: childEpochSchema,
    expectedWorkspaceRoot: artifactRootSchema,
    runtimeDigest: digestSchema,
  }),
  runId: runIdSchema,
});

export const inspectChildSessionSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    childId: childIdSchema,
  }),
  kind: literal("inspect-child-session"),
  preconditions: object({
    childEpoch: childEpochSchema,
  }),
  runId: runIdSchema,
});

export const fenceChildSessionSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    childId: childIdSchema,
  }),
  kind: literal("fence-child-session"),
  preconditions: object({
    childEpoch: childEpochSchema,
    replacementEpoch: childEpochSchema,
  }),
  runId: runIdSchema,
});

export const childIntentSchema = union([
  launchChildSessionSchema,
  inspectChildSessionSchema,
  fenceChildSessionSchema,
]);

const launchedChildResultSchema = object({
  childEpoch: childEpochSchema,
  childId: childIdSchema,
  workspaceId: workspaceIdSchema,
});
const inspectedChildResultSchema = object({
  childEpoch: childEpochSchema,
  childId: childIdSchema,
  sealedRoot: nullable(artifactRootSchema),
  state: union([
    literal("running"),
    literal("quiescent"),
    literal("absent"),
  ]),
});
const fencedChildResultSchema = object({
  childId: childIdSchema,
  observedEpoch: childEpochSchema,
  state: union([
    literal("fenced"),
    literal("already-absent"),
  ]),
});

export const childSessionLaunchedSchema = object({
  actionId: actionIdSchema,
  kind: literal("child-session-launched"),
  result: toolResultSchemaFor(launchedChildResultSchema),
  runId: runIdSchema,
});
export const childSessionInspectedSchema = object({
  actionId: actionIdSchema,
  kind: literal("child-session-inspected"),
  result: toolResultSchemaFor(inspectedChildResultSchema),
  runId: runIdSchema,
});
export const childSessionFencedSchema = object({
  actionId: actionIdSchema,
  kind: literal("child-session-fenced"),
  result: toolResultSchemaFor(fencedChildResultSchema),
  runId: runIdSchema,
});

export const childObservationSchema = union([
  childSessionLaunchedSchema,
  childSessionInspectedSchema,
  childSessionFencedSchema,
]);

export type LaunchChildSession = Infer<typeof launchChildSessionSchema>;
export type InspectChildSession = Infer<typeof inspectChildSessionSchema>;
export type FenceChildSession = Infer<typeof fenceChildSessionSchema>;
export type ChildIntent = Infer<typeof childIntentSchema>;
export type ChildSessionLaunched = Infer<typeof childSessionLaunchedSchema>;
export type ChildSessionInspected = Infer<typeof childSessionInspectedSchema>;
export type ChildSessionFenced = Infer<typeof childSessionFencedSchema>;
export type ChildObservation = Infer<typeof childObservationSchema>;

export const childIntentCapsule = defineIntentCapsule("ChildIntent", "child", childIntentSchema);
export const childObservationCapsule = defineCapsule("ChildObservation", childObservationSchema);

export const childIntentExhaustive = Object.freeze({
  "fence-child-session": true,
  "inspect-child-session": true,
  "launch-child-session": true,
}) satisfies Readonly<Record<ChildIntent["kind"], true>>;

export const childObservationExhaustive = Object.freeze({
  "child-session-fenced": true,
  "child-session-inspected": true,
  "child-session-launched": true,
}) satisfies Readonly<Record<ChildObservation["kind"], true>>;
