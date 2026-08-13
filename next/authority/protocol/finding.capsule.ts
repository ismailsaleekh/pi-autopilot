import {
  artifactRefSchema,
  artifactRootSchema,
  atomIdSchema,
  findingIdSchema,
  planRootIdSchema,
  ruleIdSchema,
  runIdSchema,
  sourceAnchorSchema,
  workItemIdSchema,
} from "./identifiers.js";
import {
  defineCapsule,
  literal,
  nonEmptyArrayOf,
  nullable,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const planningGapFindingSchema = object({
  atomIds: nonEmptyArrayOf(atomIdSchema),
  explanation: artifactRefSchema,
  findingId: findingIdSchema,
  independentReview: artifactRefSchema,
  kind: literal("planning-gap"),
  planRootId: planRootIdSchema,
  reason: union([
    literal("substantial-path"),
    literal("contradiction"),
  ]),
  runId: runIdSchema,
  sourceAnchors: nonEmptyArrayOf(sourceAnchorSchema),
  sourceEvidence: nonEmptyArrayOf(artifactRefSchema),
});

const blockingFindingFields = {
  evidence: nonEmptyArrayOf(artifactRefSchema),
  findingId: findingIdSchema,
  observedByWorkItemId: workItemIdSchema,
  report: artifactRefSchema,
  ruleId: ruleIdSchema,
  runId: runIdSchema,
  subjectRoot: artifactRootSchema,
  subjectWorkItemId: nullable(workItemIdSchema),
};

export const integrityFindingSchema = object({
  ...blockingFindingFields,
  kind: literal("integrity"),
});

export const definitionOfDoneFindingSchema = object({
  ...blockingFindingFields,
  kind: literal("definition-of-done"),
});

export const advisoryFindingSchema = object({
  disclosure: artifactRefSchema,
  evidence: nonEmptyArrayOf(artifactRefSchema),
  findingId: findingIdSchema,
  kind: literal("advisory"),
  raisedByWorkItemId: workItemIdSchema,
  report: artifactRefSchema,
  ruleId: ruleIdSchema,
  runId: runIdSchema,
  subjectRoot: artifactRootSchema,
});

export const findingSchema = union([
  planningGapFindingSchema,
  integrityFindingSchema,
  definitionOfDoneFindingSchema,
  advisoryFindingSchema,
]);

export type PlanningGapFinding = Infer<typeof planningGapFindingSchema>;
export type IntegrityFinding = Infer<typeof integrityFindingSchema>;
export type DefinitionOfDoneFinding = Infer<typeof definitionOfDoneFindingSchema>;
export type AdvisoryFinding = Infer<typeof advisoryFindingSchema>;
export type Finding = Infer<typeof findingSchema>;

export const findingCapsule = defineCapsule("Finding", findingSchema);

export const findingExhaustive = Object.freeze({
  advisory: true,
  "definition-of-done": true,
  integrity: true,
  "planning-gap": true,
}) satisfies Readonly<Record<Finding["kind"], true>>;
