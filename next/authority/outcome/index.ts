import { eligibleOutcomeForState, t1Checks } from "../model/eligibility.js";
import type { T1Checks } from "../model/eligibility.js";
import type { RunState } from "../model/run-state.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type { OutcomeSeam } from "../facade/seams.js";

export { t1Checks };
export type { T1Checks };

export function t1Predicate(state: RunState, stimulus: Stimulus): boolean {
  const result = eligibleOutcomeForState(state, stimulus.pages);
  return result.kind === "eligible" && result.outcome.kind === "t1";
}

export function t2Predicate(state: RunState, stimulus: Stimulus): boolean {
  const result = eligibleOutcomeForState(state, stimulus.pages);
  return result.kind === "eligible" && result.outcome.kind === "t2";
}

/** Sole semantic TerminalOutcome construction path. */
export function determineTerminalOutcome(
  prospectiveState: RunState,
  stimulus: Stimulus,
): TerminalOutcome | null {
  const result = eligibleOutcomeForState(prospectiveState, stimulus.pages);
  return result.kind === "eligible" ? result.outcome : null;
}

void (determineTerminalOutcome satisfies OutcomeSeam);
