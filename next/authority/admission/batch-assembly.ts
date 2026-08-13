import type { RunState } from "../model/run-state.js";
import type { Command } from "../protocol/command.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import {
  canonicalDecisionFactsDigest,
  journalRecordCapsule,
} from "../protocol/journal-record.capsule.js";
import { canonicalDigestUnknown as digestCanonicalValue } from "../protocol/schema.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";
import { stimulusCapsule } from "../protocol/stimulus.capsule.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type { Feedback } from "../facade/feedback.js";
import type {
  BatchAssemblySeam,
  PreparedSemanticRoots,
} from "../facade/seams.js";

function assemblyFeedback(diagnostic: string): Feedback {
  return Object.freeze({
    kind: "feedback",
    code: "invalid-accepted-batch",
    diagnostic,
  });
}

/** Bind exact semantic arrays to W0 canonical SHA-256 roots. */
export function assembleSemanticBatch(
  state: RunState,
  stimulus: Stimulus,
  facts: readonly DomainFact[],
  commands: readonly Command[],
  outcome: TerminalOutcome | null,
): PreparedSemanticRoots | Feedback {
  void outcome;
  if (stimulus.runId !== state.identity.runId) {
    return assemblyFeedback(
      `batch run mismatch: stimulus ${stimulus.runId} does not equal ${state.identity.runId}`,
    );
  }
  const foreignFact = facts.find((fact) => fact.runId !== state.identity.runId);
  if (foreignFact !== undefined) {
    return assemblyFeedback(
      `batch fact run mismatch: ${foreignFact.kind} belongs to ${foreignFact.runId}`,
    );
  }
  const foreignCommand = commands.find((command) => command.runId !== state.identity.runId);
  if (foreignCommand !== undefined) {
    return assemblyFeedback(
      `batch command run mismatch: ${foreignCommand.kind} belongs to ${foreignCommand.runId}`,
    );
  }
  const sequence = state.lastSequence + 1;
  if (!Number.isSafeInteger(sequence)) {
    return assemblyFeedback(
      "journal sequence cannot advance within the frozen safe-integer field",
    );
  }
  const stimulusDigest = stimulusCapsule.digest(stimulus);
  const factDigest = canonicalDecisionFactsDigest(facts);
  const commandDigest = digestCanonicalValue(commands);
  const binding = journalRecordCapsule.decode(Object.freeze({
    actionId: stimulus.actionId,
    commandRoot: commandDigest,
    factRoot: factDigest,
    facts,
    kind: "decision-committed",
    runId: state.identity.runId,
    sequence,
    stimulusDigest,
  }));
  if (binding.kind === "error" || binding.value.kind !== "decision-committed") {
    const diagnostic = binding.kind === "error"
      ? binding.error.diagnostic
      : "canonical binding decoded to the wrong journal variant";
    return assemblyFeedback(`canonical semantic-root binding failed: ${diagnostic}`);
  }
  return Object.freeze({
    kind: "prepared-semantic-roots",
    factRoot: binding.value.factRoot,
    commandRoot: binding.value.commandRoot,
    stimulusDigest: binding.value.stimulusDigest,
  });
}

void (assembleSemanticBatch satisfies BatchAssemblySeam);
