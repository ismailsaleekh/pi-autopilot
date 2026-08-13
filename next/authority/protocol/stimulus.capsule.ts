import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  attemptIdSchema,
  commandIdSchema,
  digestSchema,
  operatorRequestIdSchema,
  planRootIdSchema,
  runIdSchema,
  workItemIdSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  natural,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const boundaryRequestReceivedSchema = object({
  actionId: actionIdSchema,
  kind: literal("boundary-request-received"),
  request: artifactRefSchema,
  requestDigest: digestSchema,
  runId: runIdSchema,
});

export const submissionReadySchema = object({
  actionId: actionIdSchema,
  attemptId: attemptIdSchema,
  inputRoot: artifactRootSchema,
  kind: literal("submission-ready"),
  outputRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  workItemId: workItemIdSchema,
});

export const commandObservationReceivedSchema = object({
  actionId: actionIdSchema,
  commandId: commandIdSchema,
  kind: literal("command-observation-received"),
  observation: artifactRefSchema,
  observationDigest: digestSchema,
  runId: runIdSchema,
});

export const runReplayCompletedSchema = object({
  actionId: actionIdSchema,
  kind: literal("run-replay-completed"),
  lastSequence: natural(),
  runId: runIdSchema,
  stateDigest: digestSchema,
});

export const operatorSuspendRequestedSchema = object({
  actionId: actionIdSchema,
  kind: literal("operator-suspend-requested"),
  operatorRequestId: operatorRequestIdSchema,
  reason: artifactRefSchema,
  runId: runIdSchema,
});

export const operatorResumeRequestedSchema = object({
  actionId: actionIdSchema,
  kind: literal("operator-resume-requested"),
  operatorRequestId: operatorRequestIdSchema,
  resumeFromSequence: natural(),
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
