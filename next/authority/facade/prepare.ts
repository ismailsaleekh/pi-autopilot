import {
  admissionSeams,
} from "../admission/index.js";
import { assemblePreparedCommit } from "./assembly.js";
import { foldDomainFact } from "../evolution/domain-fact-fold.js";
import type { RunState } from "../model/run-state.js";
import { determineTerminalOutcome } from "../outcome/index.js";
import type { PreparedCommit } from "../protocol/accepted-batch.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";
import { deriveReaction } from "../reaction/index.js";
import { semanticFeedback } from "./feedback.js";
import type { Feedback } from "./feedback.js";
import type {
  AdmissionResult,
  AdmissionSeams,
  SemanticSeams,
} from "./seams.js";

export type PrepareResult = PreparedCommit | Feedback;

const productionSemanticSeams = Object.freeze({
  admission: admissionSeams,
  reaction: deriveReaction,
  outcome: determineTerminalOutcome,
  assemble: assemblePreparedCommit,
}) satisfies SemanticSeams;

function dispatchAdmission(
  state: RunState,
  stimulus: Stimulus,
  admission: AdmissionSeams,
): AdmissionResult {
  switch (stimulus.kind) {
    case "boundary-request-received":
      return admission["boundary-request-received"](state, stimulus);
    case "command-observation-received":
      return admission["command-observation-received"](state, stimulus);
    case "operator-resume-requested":
      return admission["operator-resume-requested"](state, stimulus);
    case "operator-suspend-requested":
      return admission["operator-suspend-requested"](state, stimulus);
    case "run-replay-completed":
      return admission["run-replay-completed"](state, stimulus);
    case "submission-ready":
      return admission["submission-ready"](state, stimulus);
  }
}

function prospectiveFactsState(
  state: RunState,
  stimulus: Stimulus,
  admission: Extract<AdmissionResult, { readonly kind: "proposed-facts" }>,
): RunState | Feedback {
  let current = state;
  for (const fact of admission.facts) {
    const transition = foldDomainFact(current, fact, stimulus.pages, null);
    if (transition.kind === "rejected") {
      return semanticFeedback(
        "invalid-domain-transition",
        "$.facts",
        `${transition.code}: ${transition.diagnostic}`,
      );
    }
    current = transition.state;
  }
  return current;
}

function isFeedback(value: RunState | Feedback): value is Feedback {
  return "kind" in value && value.kind === "feedback";
}

function isReactionFeedback(
  value: { readonly commands: readonly never[] } | Feedback | import("./seams.js").ReactionResult,
): value is Feedback {
  return "kind" in value && value.kind === "feedback";
}

function prepareDecoded(
  state: RunState,
  stimulus: Stimulus,
  seams: SemanticSeams,
): PrepareResult {
  const proposed = dispatchAdmission(state, stimulus, seams.admission);
  if (proposed.kind !== "proposed-facts") {
    return proposed;
  }
  const prospective = prospectiveFactsState(state, stimulus, proposed);
  if (isFeedback(prospective)) {
    return prospective;
  }
  const lifecycle = stimulus.kind === "operator-suspend-requested"
    || stimulus.kind === "operator-resume-requested";
  const outcome = lifecycle ? null : seams.outcome(prospective, stimulus);
  const reaction = outcome === null && !lifecycle
    ? seams.reaction(state, proposed.facts, stimulus)
    : Object.freeze({ commands: Object.freeze([]) });
  if (isReactionFeedback(reaction)) {
    return reaction;
  }
  return seams.assemble(
    state,
    stimulus,
    proposed.facts,
    reaction.commands,
    outcome,
  );
}

/** Authority receives only a closed decoded Stimulus; hostile unknown stops in runtime. */
export function prepare(state: RunState, stimulus: Stimulus): PrepareResult {
  return prepareDecoded(state, stimulus, productionSemanticSeams);
}

/** Test composition edge; production uses the fixed semantic seams above. */
export function prepareWithSeams(
  state: RunState,
  stimulus: Stimulus,
  seams: SemanticSeams,
): PrepareResult {
  return prepareDecoded(state, stimulus, seams);
}
