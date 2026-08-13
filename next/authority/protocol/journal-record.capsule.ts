import { domainFactSchema } from "./domain-fact.capsule.js";
import type { DomainFact } from "./domain-fact.capsule.js";
import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  commandIdSchema,
  digestSchema,
  operatorRequestIdSchema,
  revisionIdSchema,
  runIdSchema,
} from "./identifiers.js";
import {
  arrayOf,
  canonicalDigestUnknown,
  defineCapsule,
  literal,
  natural,
  object,
  union,
} from "./schema.js";
import type { Digest, Infer } from "./schema.js";
import { terminalOutcomeSchema } from "./terminal-outcome.capsule.js";

export const runGenesisSchema = object({
  kind: literal("run-genesis"),
  policyRoot: artifactRootSchema,
  repositoryBase: revisionIdSchema,
  runId: runIdSchema,
  runtimeRoot: artifactRootSchema,
  sequence: natural(),
  taskSnapshot: artifactRootSchema,
});

// Binding law: facts are canonical and ordered. Runtime must require
// canonicalDigestUnknown(facts) === factRoot before append and again before
// replay. commandRoot remains a CAS reference and is not embedded here.
export const decisionCommittedSchema = object({
  actionId: actionIdSchema,
  commandRoot: artifactRootSchema,
  factRoot: artifactRootSchema,
  facts: arrayOf(domainFactSchema),
  kind: literal("decision-committed"),
  runId: runIdSchema,
  sequence: natural(),
  stimulusDigest: digestSchema,
});

export const commandSettledSchema = object({
  actionId: actionIdSchema,
  commandId: commandIdSchema,
  kind: literal("command-settled"),
  observation: artifactRefSchema,
  observationDigest: digestSchema,
  runId: runIdSchema,
  sequence: natural(),
});

export const outcomeCommittedSchema = object({
  actionId: actionIdSchema,
  kind: literal("outcome-committed"),
  outcome: terminalOutcomeSchema,
  runId: runIdSchema,
  sequence: natural(),
});

export const runSuspendedSchema = object({
  actionId: actionIdSchema,
  kind: literal("run-suspended"),
  operatorRequestId: operatorRequestIdSchema,
  reason: artifactRefSchema,
  runId: runIdSchema,
  sequence: natural(),
});

export const runResumedSchema = object({
  actionId: actionIdSchema,
  kind: literal("run-resumed"),
  operatorRequestId: operatorRequestIdSchema,
  resumeFromSequence: natural(),
  runId: runIdSchema,
  sequence: natural(),
});

export const journalRecordSchema = union([
  runGenesisSchema,
  decisionCommittedSchema,
  commandSettledSchema,
  outcomeCommittedSchema,
  runSuspendedSchema,
  runResumedSchema,
]);

export type RunGenesis = Infer<typeof runGenesisSchema>;
export type DecisionCommitted = Infer<typeof decisionCommittedSchema>;
export type CommandSettled = Infer<typeof commandSettledSchema>;
export type OutcomeCommitted = Infer<typeof outcomeCommittedSchema>;
export type RunSuspended = Infer<typeof runSuspendedSchema>;
export type RunResumed = Infer<typeof runResumedSchema>;
export type JournalRecord = Infer<typeof journalRecordSchema>;

export function canonicalDecisionFactsDigest(facts: readonly DomainFact[]): Digest {
  return canonicalDigestUnknown(facts);
}

export function decisionFactsMatchRoot(
  decision: Pick<DecisionCommitted, "factRoot" | "facts">,
): boolean {
  return String(decision.factRoot) === String(canonicalDecisionFactsDigest(decision.facts));
}

export const journalRecordCapsule = defineCapsule("JournalRecord", journalRecordSchema);

export const journalRecordExhaustive = Object.freeze({
  "command-settled": true,
  "decision-committed": true,
  "outcome-committed": true,
  "run-genesis": true,
  "run-resumed": true,
  "run-suspended": true,
}) satisfies Readonly<Record<JournalRecord["kind"], true>>;
