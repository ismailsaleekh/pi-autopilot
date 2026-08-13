import {
  actionIdSchema,
  artifactRootSchema,
  childEpochSchema,
  digestSchema,
  leaseIdSchema,
  runIdSchema,
  workspaceIdSchema,
} from "../../authority/protocol/identifiers.js";
import {
  booleanValue,
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { toolResultSchemaFor } from "../../authority/protocol/tool-result.capsule.js";
import { defineIntentCapsule } from "./intent-capsule.js";

export const allocateAttemptDirectorySchema = object({
  actionId: actionIdSchema,
  inputs: object({
    baseRoot: artifactRootSchema,
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("allocate-attempt-directory"),
  preconditions: object({
    expectedAbsent: literal(true),
    leaseId: leaseIdSchema,
  }),
  runId: runIdSchema,
});

export const applyAttemptIsolationSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    isolationPolicyRoot: artifactRootSchema,
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("apply-attempt-isolation"),
  preconditions: object({
    expectedPolicyDigest: digestSchema,
    expectedWorkspaceRoot: artifactRootSchema,
  }),
  runId: runIdSchema,
});

export const disposeAttemptDirectorySchema = object({
  actionId: actionIdSchema,
  inputs: object({
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("dispose-attempt-directory"),
  preconditions: object({
    childEpoch: childEpochSchema,
    preserveSealedRoots: literal(true),
  }),
  runId: runIdSchema,
});

export const inspectAttemptDirectorySchema = object({
  actionId: actionIdSchema,
  inputs: object({
    workspaceId: workspaceIdSchema,
  }),
  kind: literal("inspect-attempt-directory"),
  preconditions: object({
    leaseId: leaseIdSchema,
  }),
  runId: runIdSchema,
});

export const workspaceIntentSchema = union([
  allocateAttemptDirectorySchema,
  applyAttemptIsolationSchema,
  disposeAttemptDirectorySchema,
  inspectAttemptDirectorySchema,
]);

const allocationResultSchema = object({
  materializedRoot: artifactRootSchema,
  workspaceId: workspaceIdSchema,
});
const isolationResultSchema = object({
  policyDigest: digestSchema,
  workspaceId: workspaceIdSchema,
});
const disposalResultSchema = object({
  disposed: booleanValue(),
  workspaceId: workspaceIdSchema,
});
const inspectionResultSchema = object({
  observedRoot: nullable(artifactRootSchema),
  state: union([
    literal("absent"),
    literal("ready"),
    literal("occupied"),
  ]),
  workspaceId: workspaceIdSchema,
});

export const attemptDirectoryAllocatedSchema = object({
  actionId: actionIdSchema,
  kind: literal("attempt-directory-allocated"),
  result: toolResultSchemaFor(allocationResultSchema),
  runId: runIdSchema,
});
export const attemptIsolationAppliedSchema = object({
  actionId: actionIdSchema,
  kind: literal("attempt-isolation-applied"),
  result: toolResultSchemaFor(isolationResultSchema),
  runId: runIdSchema,
});
export const attemptDirectoryDisposedSchema = object({
  actionId: actionIdSchema,
  kind: literal("attempt-directory-disposed"),
  result: toolResultSchemaFor(disposalResultSchema),
  runId: runIdSchema,
});
export const attemptDirectoryInspectedSchema = object({
  actionId: actionIdSchema,
  kind: literal("attempt-directory-inspected"),
  result: toolResultSchemaFor(inspectionResultSchema),
  runId: runIdSchema,
});

export const workspaceObservationSchema = union([
  attemptDirectoryAllocatedSchema,
  attemptIsolationAppliedSchema,
  attemptDirectoryDisposedSchema,
  attemptDirectoryInspectedSchema,
]);

export type AllocateAttemptDirectory = Infer<typeof allocateAttemptDirectorySchema>;
export type ApplyAttemptIsolation = Infer<typeof applyAttemptIsolationSchema>;
export type DisposeAttemptDirectory = Infer<typeof disposeAttemptDirectorySchema>;
export type InspectAttemptDirectory = Infer<typeof inspectAttemptDirectorySchema>;
export type WorkspaceIntent = Infer<typeof workspaceIntentSchema>;
export type AttemptDirectoryAllocated = Infer<typeof attemptDirectoryAllocatedSchema>;
export type AttemptIsolationApplied = Infer<typeof attemptIsolationAppliedSchema>;
export type AttemptDirectoryDisposed = Infer<typeof attemptDirectoryDisposedSchema>;
export type AttemptDirectoryInspected = Infer<typeof attemptDirectoryInspectedSchema>;
export type WorkspaceObservation = Infer<typeof workspaceObservationSchema>;

export const workspaceIntentCapsule = defineIntentCapsule("WorkspaceIntent", "workspace", workspaceIntentSchema);
export const workspaceObservationCapsule = defineCapsule("WorkspaceObservation", workspaceObservationSchema);

export const workspaceIntentExhaustive = Object.freeze({
  "allocate-attempt-directory": true,
  "apply-attempt-isolation": true,
  "dispose-attempt-directory": true,
  "inspect-attempt-directory": true,
}) satisfies Readonly<Record<WorkspaceIntent["kind"], true>>;

export const workspaceObservationExhaustive = Object.freeze({
  "attempt-directory-allocated": true,
  "attempt-directory-disposed": true,
  "attempt-directory-inspected": true,
  "attempt-isolation-applied": true,
}) satisfies Readonly<Record<WorkspaceObservation["kind"], true>>;
