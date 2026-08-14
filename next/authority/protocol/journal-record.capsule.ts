import { commandSchema } from "./command.capsule.js";
import type { Command } from "./command.capsule.js";
import { domainFactSchema } from "./domain-fact.capsule.js";
import type { DomainFact } from "./domain-fact.capsule.js";
import { expectedRefStateSchema } from "./git-values.js";
import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  commandIdSchema,
  decimalNaturalSchema,
  digestSchema,
  gitCommitIdSchema,
  gitRefSchema,
  gitTreeIdSchema,
  operatorRequestIdSchema,
  repositoryCapabilitySchema,
  runIdSchema,
} from "./identifiers.js";
import { subscriptionRouteSchema } from "./route.capsule.js";
import {
  arrayOf,
  canonicalDigestUnknown,
  canonicalEncodeUnknown,
  defineCapsule,
  literal,
  nullable,
  object,
  union,
} from "./schema.js";
import type { ArtifactRef } from "./identifiers.js";
import type { Digest, Infer } from "./schema.js";
import { indexMutationSchema, resolvedIndexPageSchema } from "./state-index.capsule.js";
import { terminalOutcomeSchema } from "./terminal-outcome.capsule.js";
import type { TerminalOutcome } from "./terminal-outcome.capsule.js";

export const runGenesisSchema = object({
  expectedPublication: expectedRefStateSchema,
  kind: literal("run-genesis"),
  policyRoot: artifactRootSchema,
  publicationRef: gitRefSchema,
  repository: repositoryCapabilitySchema,
  repositoryBase: gitCommitIdSchema,
  repositoryTree: gitTreeIdSchema,
  route: subscriptionRouteSchema,
  runId: runIdSchema,
  runtimeRoot: artifactRootSchema,
  sequence: decimalNaturalSchema,
  taskSnapshot: artifactRootSchema,
});

const semanticCommitFields = {
  actionId: actionIdSchema,
  factDigest: digestSchema,
  facts: arrayOf(domainFactSchema),
  mutations: arrayOf(indexMutationSchema),
  pages: arrayOf(resolvedIndexPageSchema),
  priorStateDigest: digestSchema,
  resultStateDigest: digestSchema,
  runId: runIdSchema,
  sequence: decimalNaturalSchema,
  stimulusDigest: digestSchema,
};

const commandCommitFields = {
  commandArtifact: artifactRefSchema,
  commandDigest: digestSchema,
  commands: arrayOf(commandSchema),
};

export const decisionCommittedSchema = object({
  ...semanticCommitFields,
  ...commandCommitFields,
  kind: literal("decision-committed"),
});

export const commandSettledSchema = object({
  ...semanticCommitFields,
  ...commandCommitFields,
  commandId: commandIdSchema,
  eligibilityStateDigest: nullable(digestSchema),
  kind: literal("command-settled"),
  observation: artifactRefSchema,
  observationDigest: digestSchema,
  outcome: nullable(terminalOutcomeSchema),
});

export const outcomeCommittedSchema = object({
  ...semanticCommitFields,
  eligibilityStateDigest: digestSchema,
  kind: literal("outcome-committed"),
  outcome: terminalOutcomeSchema,
});

export const runSuspendedSchema = object({
  actionId: actionIdSchema,
  kind: literal("run-suspended"),
  mutations: arrayOf(indexMutationSchema),
  operatorRequestId: operatorRequestIdSchema,
  pages: arrayOf(resolvedIndexPageSchema),
  priorStateDigest: digestSchema,
  reason: artifactRefSchema,
  resultStateDigest: digestSchema,
  runId: runIdSchema,
  sequence: decimalNaturalSchema,
  stimulusDigest: digestSchema,
});

export const runResumedSchema = object({
  actionId: actionIdSchema,
  kind: literal("run-resumed"),
  mutations: arrayOf(indexMutationSchema),
  operatorRequestId: operatorRequestIdSchema,
  pages: arrayOf(resolvedIndexPageSchema),
  priorStateDigest: digestSchema,
  resultStateDigest: digestSchema,
  resumeFromSequence: decimalNaturalSchema,
  runId: runIdSchema,
  sequence: decimalNaturalSchema,
  stimulusDigest: digestSchema,
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

export function canonicalCommandsDigest(commands: readonly Command[]): Digest {
  return canonicalDigestUnknown(commands);
}

const commandArtifactCapsule = defineCapsule("CanonicalCommandArtifact", artifactRefSchema);

/** Deterministic singleton CAS reference; runtime installs these exact bytes before append. */
export function canonicalCommandArtifact(commands: readonly Command[]): ArtifactRef | null {
  const bytes = canonicalEncodeUnknown(commands);
  const digest = canonicalCommandsDigest(commands);
  const decoded = commandArtifactCapsule.decode(Object.freeze({
    blob: digest,
    byteLength: String(bytes.byteLength),
    codec: "codec:pi-autopilot-commands",
    codecVersion: "version:2",
    digest,
    path: "semantic/commands.canonical.json",
    range: null,
    root: digest,
  }));
  return decoded.kind === "ok" ? decoded.value : null;
}

export function recordSemanticRootsMatch(
  record: DecisionCommitted | CommandSettled | OutcomeCommitted,
): boolean {
  if (record.factDigest !== canonicalDecisionFactsDigest(record.facts)) {
    return false;
  }
  if (record.kind === "outcome-committed") {
    return true;
  }
  const commandBytes = canonicalEncodeUnknown(record.commands);
  const commandArtifact = canonicalCommandArtifact(record.commands);
  const settlementMatches = record.kind !== "command-settled"
    || (record.observationDigest === record.observation.digest
      && String(record.observation.blob) === String(record.observationDigest));
  return commandArtifact !== null
    && record.commandDigest === canonicalCommandsDigest(record.commands)
    && canonicalDigestUnknown(record.commandArtifact) === canonicalDigestUnknown(commandArtifact)
    && record.commandArtifact.byteLength === String(commandBytes.byteLength)
    && settlementMatches;
}

export function decisionFactsMatchRoot(
  decision: Pick<DecisionCommitted, "factDigest" | "facts">,
): boolean {
  return decision.factDigest === canonicalDecisionFactsDigest(decision.facts);
}

export function recordOutcome(record: JournalRecord): TerminalOutcome | null {
  if (record.kind === "outcome-committed") {
    return record.outcome;
  }
  return record.kind === "command-settled" ? record.outcome : null;
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
