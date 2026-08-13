import {
  artifactRefSchema,
  atomIdSchema,
  evidenceIdSchema,
  planRootIdSchema,
  planUnitIdSchema,
  requirementIdSchema,
  runIdSchema,
  sourceAnchorSchema,
  workItemIdSchema,
} from "./identifiers.js";
import {
  arrayOf,
  defineCapsule,
  literal,
  nonEmptyArrayOf,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const atomKindSchema = union([
  literal("WORK"),
  literal("DECISION"),
  literal("CONSTRAINT"),
  literal("ACCEPTANCE"),
  literal("PREMISE"),
  literal("QUESTION"),
  literal("REFERENCE"),
]);

export const atomSchema = object({
  atomId: atomIdSchema,
  kind: atomKindSchema,
  requirementId: requirementIdSchema,
  runId: runIdSchema,
  sourceAnchor: sourceAnchorSchema,
  sourceEvidence: artifactRefSchema,
});

const dispositionEvidenceFields = {
  evidence: nonEmptyArrayOf(artifactRefSchema),
  planRootId: planRootIdSchema,
};

export const dispositionMeaningSchema = union([
  object({
    ...dispositionEvidenceFields,
    kind: literal("implemented-by"),
    planUnits: nonEmptyArrayOf(planUnitIdSchema),
    workItems: nonEmptyArrayOf(workItemIdSchema),
  }),
  object({
    ...dispositionEvidenceFields,
    criteria: nonEmptyArrayOf(artifactRefSchema),
    kind: literal("honored-by"),
    planUnits: nonEmptyArrayOf(planUnitIdSchema),
  }),
  object({
    ...dispositionEvidenceFields,
    kind: literal("invalidated-premise-to-operator-question"),
    operatorQuestion: atomIdSchema,
  }),
  object({
    ...dispositionEvidenceFields,
    kind: literal("guards"),
    planUnits: nonEmptyArrayOf(planUnitIdSchema),
  }),
  object({
    ...dispositionEvidenceFields,
    guard: artifactRefSchema,
    kind: literal("run-level-guard"),
  }),
  object({
    ...dispositionEvidenceFields,
    criteria: nonEmptyArrayOf(artifactRefSchema),
    kind: literal("verified-by"),
  }),
  object({
    ...dispositionEvidenceFields,
    kind: literal("verified"),
  }),
  object({
    ...dispositionEvidenceFields,
    kind: literal("refuted-to-operator-question"),
    operatorQuestion: atomIdSchema,
  }),
  object({
    ...dispositionEvidenceFields,
    assumption: artifactRefSchema,
    kind: literal("unverifiable-to-recorded-assumption"),
  }),
  object({
    ...dispositionEvidenceFields,
    kind: literal("answered-by-operator-atom"),
    operatorAtom: atomIdSchema,
  }),
  object({
    ...dispositionEvidenceFields,
    assumption: artifactRefSchema,
    kind: literal("nonmaterial-assumption"),
  }),
  object({
    ...dispositionEvidenceFields,
    consumedBy: nonEmptyArrayOf(planUnitIdSchema),
    kind: literal("consumed"),
  }),
  object({
    ...dispositionEvidenceFields,
    exclusionEvidence: artifactRefSchema,
    kind: literal("excluded-historical"),
  }),
  object({
    ...dispositionEvidenceFields,
    independentPlanningReview: evidenceIdSchema,
    kind: literal("n-a-with-reason"),
    reason: artifactRefSchema,
  }),
]);

export const atomDispositionSchema = object({
  atomId: atomIdSchema,
  meaning: dispositionMeaningSchema,
  runId: runIdSchema,
});

export type AtomKind = Infer<typeof atomKindSchema>;
export type Atom = Infer<typeof atomSchema>;
export type DispositionMeaning = Infer<typeof dispositionMeaningSchema>;
export type AtomDisposition = Infer<typeof atomDispositionSchema>;

export const atomCapsule = defineCapsule("Atom", union([
  object({ kind: literal("atom"), value: atomSchema }),
  object({ kind: literal("disposition"), value: atomDispositionSchema }),
]));

export const LEGAL_DISPOSITIONS = Object.freeze({
  ACCEPTANCE: Object.freeze(["verified-by", "n-a-with-reason"] as const),
  CONSTRAINT: Object.freeze(["guards", "run-level-guard", "n-a-with-reason"] as const),
  DECISION: Object.freeze(["honored-by", "invalidated-premise-to-operator-question", "n-a-with-reason"] as const),
  PREMISE: Object.freeze(["verified", "refuted-to-operator-question", "unverifiable-to-recorded-assumption", "n-a-with-reason"] as const),
  QUESTION: Object.freeze(["answered-by-operator-atom", "nonmaterial-assumption", "n-a-with-reason"] as const),
  REFERENCE: Object.freeze(["consumed", "excluded-historical", "n-a-with-reason"] as const),
  WORK: Object.freeze(["implemented-by", "n-a-with-reason"] as const),
}) satisfies Readonly<Record<AtomKind, readonly DispositionMeaning["kind"][]>>;

export function dispositionIsLegal(atom: Atom, disposition: AtomDisposition): boolean {
  return atom.atomId === disposition.atomId
    && atom.runId === disposition.runId
    && LEGAL_DISPOSITIONS[atom.kind].includes(disposition.meaning.kind);
}

void arrayOf;
