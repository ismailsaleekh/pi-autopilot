import { foldDomainFact } from "../evolution/domain-fact-fold.js";
import type { FoldError } from "../evolution/fold-result.js";
import type { RunState } from "../model/run-state.js";
import { mintAcceptedBatch } from "../protocol/accepted-batch.js";
import type { AcceptedBatch } from "../protocol/accepted-batch.js";
import type { JsonValue } from "../protocol/schema.js";
import { stimulusCapsule } from "../protocol/stimulus.capsule.js";
import { stateDigest } from "../model/run-state.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";
import {
  invalidStimulusFeedback,
  unavailableAdmissionFeedback,
} from "./feedback.js";
import type { Feedback } from "./feedback.js";
import type {
  AdmissionResult,
  AdmissionSeams,
  SemanticSeams,
} from "./seams.js";

export type PrepareResult =
  | { readonly kind: "accepted"; readonly batch: AcceptedBatch }
  | Feedback;

type StubAdmissionMap = {
  readonly [Kind in Stimulus["kind"]]: (
    state: RunState,
    stimulus: Extract<Stimulus, { readonly kind: Kind }>,
  ) => AdmissionResult;
};

const admissionSkeleton = Object.freeze({
  "boundary-request-received"(_state, stimulus) {
    return unavailableAdmissionFeedback(stimulus.kind);
  },
  "command-observation-received"(_state, stimulus) {
    return unavailableAdmissionFeedback(stimulus.kind);
  },
  "operator-resume-requested"(_state, stimulus) {
    return unavailableAdmissionFeedback(stimulus.kind);
  },
  "operator-suspend-requested"(_state, stimulus) {
    return unavailableAdmissionFeedback(stimulus.kind);
  },
  "run-replay-completed"(_state, stimulus) {
    return unavailableAdmissionFeedback(stimulus.kind);
  },
  "submission-ready"(_state, stimulus) {
    return unavailableAdmissionFeedback(stimulus.kind);
  },
}) satisfies StubAdmissionMap;

function invalidTransitionFeedback(error: FoldError): Feedback {
  return Object.freeze({
    kind: "feedback",
    code: "invalid-domain-transition",
    error: Object.freeze(error),
    diagnostic: `proposed fact batch is not admissible: ${error.code}`,
  });
}

function invalidAcceptedBatchFeedback(diagnostic: string): Feedback {
  return Object.freeze({
    kind: "feedback",
    code: "invalid-accepted-batch",
    diagnostic,
  });
}

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

function prepareDecoded(
  state: RunState,
  stimulus: Stimulus,
  seams: SemanticSeams,
): PrepareResult {
  const proposed = dispatchAdmission(state, stimulus, seams.admission);
  if (proposed.kind !== "proposed-facts") {
    return proposed;
  }
  let candidate = state;
  for (const fact of proposed.facts) {
    const transition = foldDomainFact(candidate, fact);
    if (transition.kind === "rejected") {
      return invalidTransitionFeedback(transition.error);
    }
    candidate = transition.state;
  }
  const reaction = seams.reaction(state, proposed.facts);
  const outcome = seams.outcome(state, proposed.facts);
  const assembled = seams.assemble(
    state,
    stimulus,
    proposed.facts,
    reaction.commands,
    outcome,
  );
  if (assembled.kind !== "prepared-semantic-roots") {
    return assembled;
  }
  const minted = mintAcceptedBatch(Object.freeze({
    runId: state.identity.runId,
    facts: proposed.facts,
    commands: reaction.commands,
    outcome,
    factRoot: assembled.factRoot,
    commandRoot: assembled.commandRoot,
    stateDigest: stateDigest(state),
  }));
  if (minted.kind === "invalid") {
    return invalidAcceptedBatchFeedback(minted.error.diagnostic);
  }
  return Object.freeze({ kind: "accepted", batch: minted.batch });
}

/**
 * W1 skeleton: validates inert JSON and returns actionable typed feedback for
 * every closed stimulus kind. It never manufactures a decision.
 */
export function prepare(state: RunState, stimulus: JsonValue): PrepareResult {
  const decoded = stimulusCapsule.decode(stimulus);
  if (decoded.kind === "error") {
    return invalidStimulusFeedback(decoded.error);
  }
  const result = dispatchAdmission(state, decoded.value, admissionSkeleton);
  if (result.kind !== "proposed-facts") {
    return result;
  }
  return unavailableAdmissionFeedback(decoded.value.kind);
}

/** W2 composition entry; policy-root permits this capability only in facade. */
export function prepareWithSeams(
  state: RunState,
  stimulus: JsonValue,
  seams: SemanticSeams,
): PrepareResult {
  const decoded = stimulusCapsule.decode(stimulus);
  if (decoded.kind === "error") {
    return invalidStimulusFeedback(decoded.error);
  }
  return prepareDecoded(state, decoded.value, seams);
}
