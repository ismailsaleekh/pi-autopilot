import {
  deriveActionTransition,
  deriveSemanticTransition,
} from "../evolution/fold.js";
import { eligibleOutcomeForState } from "../outcome/index.js";
import { stateDigest } from "../model/run-state.js";
import type { RunState } from "../model/run-state.js";
import { semanticFeedback } from "../facade/feedback.js";
import type { Feedback } from "../facade/feedback.js";
import type { Command } from "../protocol/command.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import { incrementDecimalNatural } from "../protocol/identifiers.js";
import {
  canonicalCommandArtifact,
  canonicalCommandsDigest,
  canonicalDecisionFactsDigest,
  journalRecordCapsule,
} from "../protocol/journal-record.capsule.js";
import type {
  CommandSettled,
  DecisionCommitted,
  OutcomeCommitted,
  RunResumed,
  RunSuspended,
} from "../protocol/journal-record.capsule.js";
import {
  mintPreparedCommit,
} from "../protocol/accepted-batch.js";
import type {
  PreparedCommit,
  PreparedCommitFields,
} from "../protocol/accepted-batch.js";
import { stimulusCapsule } from "../protocol/stimulus.capsule.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";
import { terminalOutcomeCapsule } from "../protocol/terminal-outcome.capsule.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type { CommitAssemblySeam } from "../facade/seams.js";

export const MAX_FACTS_PER_COMMIT = 32;
export const MAX_COMMANDS_PER_COMMIT = 32;
export const MAX_PROOF_PAGES_PER_COMMIT = 32;

function assemblyFeedback(path: string, diagnostic: string): Feedback {
  return semanticFeedback("invalid-accepted-commit", path, diagnostic);
}

function sameOutcome(left: TerminalOutcome, right: TerminalOutcome): boolean {
  return terminalOutcomeCapsule.digest(left) === terminalOutcomeCapsule.digest(right);
}

function decodeRecord(input: unknown, expected: "run-suspended"): RunSuspended | Feedback;
function decodeRecord(input: unknown, expected: "run-resumed"): RunResumed | Feedback;
function decodeRecord(input: unknown, expected: "decision-committed"): DecisionCommitted | Feedback;
function decodeRecord(input: unknown, expected: "command-settled"): CommandSettled | Feedback;
function decodeRecord(input: unknown, expected: "outcome-committed"): OutcomeCommitted | Feedback;
function decodeRecord(input: unknown, expected: "run-suspended" | "run-resumed" | "decision-committed" | "command-settled" | "outcome-committed"): DecisionCommitted | CommandSettled | OutcomeCommitted | RunSuspended | RunResumed | Feedback {
  const encoded = journalRecordCapsule.encodeUnknown(input);
  if (encoded.kind === "error") return assemblyFeedback(encoded.error.path, encoded.error.diagnostic);
  const decoded = journalRecordCapsule.decodeCanonical(encoded.value);
  if (decoded.kind === "error") return assemblyFeedback(decoded.error.path, decoded.error.diagnostic);
  if (decoded.value.kind === expected) return decoded.value;
  return assemblyFeedback("$.kind", "record decoded to a different family");
}

function mint(fields: PreparedCommitFields): PreparedCommit | Feedback {
  const minted = mintPreparedCommit(fields);
  return minted.kind === "minted"
    ? minted.commit
    : assemblyFeedback(minted.error.path, minted.error.diagnostic);
}

function commonChecks(
  state: RunState,
  stimulus: Stimulus,
  facts: readonly DomainFact[],
  commands: readonly Command[],
): Feedback | null {
  if (stimulus.runId !== state.identity.runId) {
    return assemblyFeedback("$.runId", "stimulus belongs to another run");
  }
  if (facts.length > MAX_FACTS_PER_COMMIT || commands.length > MAX_COMMANDS_PER_COMMIT || stimulus.pages.length > MAX_PROOF_PAGES_PER_COMMIT) {
    return assemblyFeedback("$", "prepared commit exceeds the closed bounded fact, command, or proof-page envelope");
  }
  const foreignFact = facts.find((fact) => fact.runId !== state.identity.runId);
  if (foreignFact !== undefined) {
    return assemblyFeedback("$.facts", `${foreignFact.kind} belongs to another run`);
  }
  const foreignCommand = commands.find((command) => command.runId !== state.identity.runId);
  return foreignCommand === undefined
    ? null
    : assemblyFeedback("$.commands", `${foreignCommand.kind} belongs to another run`);
}

function assembleLifecycle(
  state: RunState,
  stimulus: Extract<Stimulus, { readonly kind: "operator-suspend-requested" | "operator-resume-requested" }>,
  facts: readonly DomainFact[],
  commands: readonly Command[],
  outcome: TerminalOutcome | null,
): PreparedCommit | Feedback {
  if (facts.length !== 0 || commands.length !== 0 || outcome !== null) {
    return assemblyFeedback("$", "operator lifecycle commits cannot carry semantic consequences or a terminal");
  }
  const sequence = incrementDecimalNatural(state.lastSequence);
  const recordKind = stimulus.kind === "operator-suspend-requested" ? "run-suspended" : "run-resumed";
  const action = deriveActionTransition(state, Object.freeze({
    actionId: stimulus.actionId,
    kind: recordKind,
    pages: stimulus.pages,
    sequence,
  }));
  if (action.kind !== "derived") {
    return assemblyFeedback("$.pages", action.diagnostic);
  }
  const nextState: RunState = stimulus.kind === "operator-suspend-requested"
    ? Object.freeze({
        ...action.state,
        lastSequence: sequence,
        suspension: Object.freeze({
          kind: "suspended",
          actionId: stimulus.actionId,
          operatorRequestId: stimulus.operatorRequestId,
          reason: stimulus.reason,
          sequence,
        }),
      })
    : Object.freeze({
        ...action.state,
        lastSequence: sequence,
        suspension: Object.freeze({ kind: "active" }),
      });
  const base = Object.freeze({
    actionId: stimulus.actionId,
    mutations: Object.freeze([action.mutation]),
    operatorRequestId: stimulus.operatorRequestId,
    pages: stimulus.pages,
    priorStateDigest: stateDigest(state),
    resultStateDigest: stateDigest(nextState),
    runId: state.identity.runId,
    sequence,
    stimulusDigest: stimulusCapsule.digest(stimulus),
  });
  if (stimulus.kind === "operator-suspend-requested") {
    const decoded = decodeRecord(Object.freeze({
      ...base,
      kind: "run-suspended",
      reason: stimulus.reason,
    }), "run-suspended");
    return decoded.kind === "feedback"
      ? decoded
      : mint(Object.freeze({ kind: "prepared-suspension", record: decoded }));
  }
  const decoded = decodeRecord(Object.freeze({
    ...base,
    kind: "run-resumed",
    resumeFromSequence: stimulus.resumeFromSequence,
  }), "run-resumed");
  return decoded.kind === "feedback"
    ? decoded
    : mint(Object.freeze({ kind: "prepared-resumption", record: decoded }));
}

function assembleSemantic(
  state: RunState,
  stimulus: Exclude<Stimulus, { readonly kind: "operator-suspend-requested" | "operator-resume-requested" }>,
  facts: readonly DomainFact[],
  commands: readonly Command[],
  proposedOutcome: TerminalOutcome | null,
): PreparedCommit | Feedback {
  const sequence = incrementDecimalNatural(state.lastSequence);
  const isSettlement = stimulus.kind === "command-observation-received";
  if (isSettlement && (
    stimulus.observationDigest !== stimulus.observation.digest
    || String(stimulus.observation.blob) !== String(stimulus.observationDigest)
  )) {
    return assemblyFeedback("$.observationDigest", "settlement observation must bind installed canonical CAS bytes");
  }
  const recordKind = isSettlement
    ? "command-settled"
    : proposedOutcome === null ? "decision-committed" : "outcome-committed";
  const effectiveCommands = proposedOutcome === null ? commands : Object.freeze([]);
  const transition = deriveSemanticTransition(state, Object.freeze({
    actionId: stimulus.actionId,
    commands: effectiveCommands,
    facts,
    kind: recordKind,
    pages: stimulus.pages,
    sequence,
    settlement: isSettlement
      ? Object.freeze({
          commandId: stimulus.commandId,
          observation: stimulus.observation,
          observationDigest: stimulus.observationDigest,
        })
      : null,
  }));
  if (transition.kind !== "derived") {
    return assemblyFeedback("$.facts", `${transition.code}: ${transition.diagnostic}`);
  }
  const eligibility = eligibleOutcomeForState(transition.state, stimulus.pages);
  const outcome = eligibility.kind === "eligible" ? eligibility.outcome : null;
  if (
    (proposedOutcome === null && outcome !== null)
    || (proposedOutcome !== null && (outcome === null || !sameOutcome(proposedOutcome, outcome)))
  ) {
    return assemblyFeedback("$.outcome", "outcome seam disagrees with replayable exact T1/T2 eligibility");
  }
  const eligibilityStateDigest = outcome === null ? null : stateDigest(transition.state);
  let result = transition.state;
  if (outcome !== null) {
    result = Object.freeze({
      ...result,
      terminal: Object.freeze({ actionId: stimulus.actionId, outcome, sequence }),
    });
  }
  result = Object.freeze({ ...result, lastSequence: sequence });
  const common = Object.freeze({
    actionId: stimulus.actionId,
    factDigest: canonicalDecisionFactsDigest(facts),
    facts,
    mutations: transition.mutations,
    pages: stimulus.pages,
    priorStateDigest: stateDigest(state),
    resultStateDigest: stateDigest(result),
    runId: state.identity.runId,
    sequence,
    stimulusDigest: stimulusCapsule.digest(stimulus),
  });
  if (recordKind === "outcome-committed" && outcome !== null && eligibilityStateDigest !== null) {
    const decoded = decodeRecord(Object.freeze({
      ...common,
      eligibilityStateDigest,
      kind: "outcome-committed",
      outcome,
    }), "outcome-committed");
    return decoded.kind === "feedback"
      ? decoded
      : mint(Object.freeze({ kind: "prepared-outcome", record: decoded }));
  }
  const commandArtifact = canonicalCommandArtifact(effectiveCommands);
  if (commandArtifact === null) {
    return assemblyFeedback("$.commands", "canonical command artifact could not be represented");
  }
  const commandFields = Object.freeze({
    commandArtifact,
    commandDigest: canonicalCommandsDigest(effectiveCommands),
    commands: effectiveCommands,
  });
  if (recordKind === "command-settled" && isSettlement) {
    const decoded = decodeRecord(Object.freeze({
      ...common,
      ...commandFields,
      commandId: stimulus.commandId,
      eligibilityStateDigest,
      kind: "command-settled",
      observation: stimulus.observation,
      observationDigest: stimulus.observationDigest,
      outcome,
    }), "command-settled");
    return decoded.kind === "feedback"
      ? decoded
      : mint(Object.freeze({ kind: "prepared-command-settlement", record: decoded }));
  }
  if (outcome !== null) {
    return assemblyFeedback("$.outcome", "eligible outcome was not bound to an atomic terminal record");
  }
  const decoded = decodeRecord(Object.freeze({
    ...common,
    ...commandFields,
    kind: "decision-committed",
  }), "decision-committed");
  return decoded.kind === "feedback"
    ? decoded
    : mint(Object.freeze({ kind: "prepared-decision", record: decoded }));
}

/** Sole authority-owned assembly and PreparedCommit mint composition edge. */
export function assemblePreparedCommit(
  state: RunState,
  stimulus: Stimulus,
  facts: readonly DomainFact[],
  commands: readonly Command[],
  outcome: TerminalOutcome | null,
): PreparedCommit | Feedback {
  const invalid = commonChecks(state, stimulus, facts, commands);
  if (invalid !== null) {
    return invalid;
  }
  return stimulus.kind === "operator-suspend-requested" || stimulus.kind === "operator-resume-requested"
    ? assembleLifecycle(state, stimulus, facts, commands, outcome)
    : assembleSemantic(state, stimulus, facts, commands, outcome);
}

void (assemblePreparedCommit satisfies CommitAssemblySeam);
