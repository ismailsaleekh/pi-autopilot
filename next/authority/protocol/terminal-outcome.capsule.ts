import {
  artifactRefSchema,
  artifactRootSchema,
  revisionIdSchema,
  sourceAnchorSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  nonEmptyArrayOf,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const taskCompleteSchema = object({
  coverageRoot: artifactRootSchema,
  evidenceRoot: artifactRootSchema,
  finalTree: artifactRootSchema,
  kind: literal("t1"),
  publishedRevision: revisionIdSchema,
});

export const planningStopSchema = object({
  explanation: artifactRefSchema,
  kind: literal("t2"),
  reason: union([
    literal("substantial-path"),
    literal("contradiction"),
  ]),
  sourceAnchors: nonEmptyArrayOf(sourceAnchorSchema),
});

export const terminalOutcomeSchema = union([
  taskCompleteSchema,
  planningStopSchema,
]);

export type TaskComplete = Infer<typeof taskCompleteSchema>;
export type PlanningStop = Infer<typeof planningStopSchema>;
export type TerminalOutcome = Infer<typeof terminalOutcomeSchema>;

export const terminalOutcomeCapsule = defineCapsule("TerminalOutcome", terminalOutcomeSchema);

export const terminalOutcomeExhaustive = Object.freeze({
  t1: true,
  t2: true,
}) satisfies Readonly<Record<TerminalOutcome["kind"], true>>;
