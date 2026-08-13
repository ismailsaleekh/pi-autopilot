import type { RunState } from "../model/run-state.js";
import type { Command } from "../protocol/command.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import type { PreparedCommit } from "../protocol/accepted-batch.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type { Feedback } from "./feedback.js";

export interface ProposedFacts {
  readonly kind: "proposed-facts";
  readonly facts: readonly DomainFact[];
}

export type AdmissionResult = ProposedFacts | Feedback;

export interface ReactionResult {
  readonly commands: readonly Command[];
}

type StimulusOfKind<Kind extends Stimulus["kind"]> = Extract<Stimulus, { readonly kind: Kind }>;

export type AdmissionSeams = {
  readonly [Kind in Stimulus["kind"]]: (
    state: RunState,
    stimulus: StimulusOfKind<Kind>,
  ) => AdmissionResult;
};

export type ReactionSeam = (
  state: RunState,
  facts: readonly DomainFact[],
  stimulus: Stimulus,
) => ReactionResult | Feedback;

export type OutcomeSeam = (
  prospectiveState: RunState,
  stimulus: Stimulus,
) => TerminalOutcome | null;

export type CommitAssemblySeam = (
  state: RunState,
  stimulus: Stimulus,
  facts: readonly DomainFact[],
  commands: readonly Command[],
  outcome: TerminalOutcome | null,
) => PreparedCommit | Feedback;

export interface SemanticSeams {
  readonly admission: AdmissionSeams;
  readonly reaction: ReactionSeam;
  readonly outcome: OutcomeSeam;
  readonly assemble: CommitAssemblySeam;
}
