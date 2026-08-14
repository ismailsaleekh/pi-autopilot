import { t1Checks } from "../model/eligibility.js";
import type { T1Checks } from "../model/eligibility.js";
import type { RunState } from "../model/run-state.js";
import type { ResolvedIndexPage } from "../protocol/state-index.capsule.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type { OutcomeSeam } from "../facade/seams.js";

export { t1Checks };
export type { T1Checks };

export type Eligibility =
  | { readonly kind: "ineligible"; readonly checks: T1Checks }
  | { readonly kind: "eligible"; readonly outcome: TerminalOutcome; readonly checks: T1Checks };

/** Sole replayable T1/T2 eligibility and construction path. */
export function eligibleOutcomeForState(
  state: RunState,
  pages: readonly ResolvedIndexPage[],
): Eligibility {
  if (state.phase === "planning" && state.planningGap !== null && state.indexes.commands.hotComplete && state.indexes.commands.hot.every((entry) => entry.value.kind !== "command" || entry.value.status === "settled")) {
    const gap = state.planningGap;
    return Object.freeze({
      kind: "eligible",
      checks: t1Checks(state, pages),
      outcome: Object.freeze({
        kind: "t2",
        reason: gap.reason,
        sourceAnchors: gap.sourceAnchors,
        sourceEvidence: gap.sourceEvidence,
        explanation: gap.explanation,
      }),
    });
  }
  const checks = t1Checks(state, pages);
  const eligible = checks.c1RequirementsBound
    && checks.c2AtomsDispositioned
    && checks.c3FinalEvidenceGreen
    && checks.c4ReviewedDiffAndManifest
    && checks.c5IdentityBindings
    && checks.c6AcceptedWorkRetained
    && checks.c7NoProductGap
    && checks.noBlockingFindings
    && checks.publicationContainsCandidate
    && checks.finalAttestationsBound;
  if (!eligible || state.currentPlan === null || state.currentCandidate === null || state.currentPublication === null || state.finalAttestations === null || state.currentPublication.observedHead === null || state.currentPublication.publicationTreeAttestation === null) {
    return Object.freeze({ kind: "ineligible", checks });
  }
  return Object.freeze({
    kind: "eligible",
    checks,
    outcome: Object.freeze({
      kind: "t1",
      advisoryDisclosures: state.finalAttestations.advisoryDisclosures,
      c1ToC7Proof: state.finalAttestations.c1ToC7Proof,
      candidateId: state.currentCandidate.candidateId,
      coverageRoot: state.currentPlan.coverageRoot,
      evidenceIndexRoot: state.finalAttestations.evidenceIndexRoot,
      finalManifest: state.finalAttestations.finalManifest,
      finalTree: state.currentCandidate.tree,
      gitTree: state.currentCandidate.gitTree,
      gitTreeCasAttestation: state.currentCandidate.gitTreeCasAttestation.attestation,
      publicationId: state.currentPublication.publicationId,
      publicationTreeAttestation: state.currentPublication.publicationTreeAttestation.attestation,
      publishedRevision: state.currentPublication.observedHead,
      reviewedDiff: state.currentCandidate.reviewedDiff,
    }),
  });
}

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
