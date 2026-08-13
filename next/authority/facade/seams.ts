import type { RunState } from "../model/run-state.js";
import type { Digest } from "../protocol/schema.js";
import type { Command } from "../protocol/command.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import type { ArtifactRoot } from "../protocol/identifiers.js";
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

export interface PreparedSemanticRoots {
  readonly kind: "prepared-semantic-roots";
  readonly factRoot: ArtifactRoot;
  readonly commandRoot: ArtifactRoot;
  readonly stimulusDigest: Digest;
}

type StimulusOfKind<Kind extends Stimulus["kind"]> = Extract<Stimulus, { readonly kind: Kind }>;

/** W2 implements every value in this exhaustive pure admission table. */
export type AdmissionSeams = {
  readonly [Kind in Stimulus["kind"]]: (
    state: RunState,
    stimulus: StimulusOfKind<Kind>,
  ) => AdmissionResult;
};

/** W2 derives closed effect intents from facts; it performs no effects. */
export type ReactionSeam = (
  state: RunState,
  facts: readonly DomainFact[],
) => ReactionResult;

/** W2 outcome owns the only semantic terminal constructors. */
export type OutcomeSeam = (
  state: RunState,
  facts: readonly DomainFact[],
) => TerminalOutcome | null;

/** W2 binds exact accepted values to their canonical artifact roots. */
export type BatchAssemblySeam = (
  state: RunState,
  stimulus: Stimulus,
  facts: readonly DomainFact[],
  commands: readonly Command[],
  outcome: TerminalOutcome | null,
) => PreparedSemanticRoots | Feedback;

export interface SemanticSeams {
  readonly admission: AdmissionSeams;
  readonly reaction: ReactionSeam;
  readonly outcome: OutcomeSeam;
  readonly assemble: BatchAssemblySeam;
}
