import {
  artifactRefSchema,
  artifactRootSchema,
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
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const planningGapFindingSchema = object({
  explanation: artifactRefSchema,
  findingId: findingIdSchema,
  kind: literal("planning-gap"),
  planAuthorWorkItemId: workItemIdSchema,
  planRootId: planRootIdSchema,
  reason: union([
    literal("substantial-path"),
    literal("contradiction"),
  ]),
  runId: runIdSchema,
  sourceAnchors: nonEmptyArrayOf(sourceAnchorSchema),
});

export const integrityFindingSchema = object({
  correctionOwner: workItemIdSchema,
  evidence: nonEmptyArrayOf(artifactRefSchema),
  findingId: findingIdSchema,
  kind: literal("integrity"),
  report: artifactRefSchema,
  ruleId: ruleIdSchema,
  runId: runIdSchema,
  subjectRoot: artifactRootSchema,
});

export const definitionOfDoneFindingSchema = object({
  correctionOwner: workItemIdSchema,
  evidence: nonEmptyArrayOf(artifactRefSchema),
  findingId: findingIdSchema,
  kind: literal("definition-of-done"),
  report: artifactRefSchema,
  ruleId: ruleIdSchema,
  runId: runIdSchema,
  subjectRoot: artifactRootSchema,
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
