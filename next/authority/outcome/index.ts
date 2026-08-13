import { coverageComplete } from "../coverage/index.js";
import { evidenceSatisfies } from "../evidence/index.js";
import { foldDomainFact } from "../evolution/domain-fact-fold.js";
import type { RunState } from "../model/run-state.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import type {
  ArtifactRef,
  ArtifactRoot,
  RevisionId,
} from "../protocol/identifiers.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type { OutcomeSeam } from "../facade/seams.js";

export interface T1PredicateChecks {
  readonly c1RequirementsBound: boolean;
  readonly c2CoverageComplete: boolean;
  readonly c3FinalEvidenceGreen: boolean;
  readonly c4CandidateManifestBound: boolean;
  readonly c5CurrentRootBindings: boolean;
  readonly c6AcceptedWorkRetained: boolean;
  readonly c7NoPlanningGap: boolean;
  readonly noOpenIntegrityOrDefinitionOfDoneFinding: boolean;
  readonly publicationContainsCandidate: boolean;
}

export type T1Eligibility =
  | {
      readonly eligible: false;
      readonly checks: T1PredicateChecks;
    }
  | {
      readonly eligible: true;
      readonly checks: T1PredicateChecks;
      readonly finalTree: ArtifactRoot;
      readonly publishedRevision: RevisionId;
      readonly coverageRoot: ArtifactRoot;
      readonly evidenceRoot: ArtifactRoot;
    };

export type T2Eligibility =
  | { readonly eligible: false }
  | {
      readonly eligible: true;
      readonly reason: "substantial-path" | "contradiction";
      readonly sourceAnchors: Extract<TerminalOutcome, { readonly kind: "t2" }>["sourceAnchors"];
      readonly explanation: ArtifactRef;
    };

function stateAfterFacts(
  state: RunState,
  facts: readonly DomainFact[],
): RunState | null {
  let candidate = state;
  for (const fact of facts) {
    const folded = foldDomainFact(candidate, fact);
    if (folded.kind === "rejected") {
      return null;
    }
    candidate = folded.state;
  }
  return candidate;
}

function currentPlanIsSuperseded(state: RunState): boolean {
  return state.currentPlanRootId !== null && state.supersededPlanRoots.some(
    (supersession) => supersession.priorPlanRootId === state.currentPlanRootId,
  );
}

function activeWorkAccepted(state: RunState): boolean {
  if (state.currentPlanRootId === null || currentPlanIsSuperseded(state)) {
    return false;
  }
  const active = state.workItems.filter(
    (entry) => entry.workItem.planRootId === state.currentPlanRootId,
  );
  return active.length > 0 && active.every((entry) => (
    entry.status === "submission-bound"
    && state.submissions.some((submission) => (
      submission.workItemId === entry.workItemId
      && submission.planRootId === state.currentPlanRootId
      && submission.inputRoot === entry.workItem.inputRoot
      && submission.submissionId === entry.latestSubmissionId
    ))
  ));
}

function openFindingChecks(state: RunState): {
  readonly noIntegrityOrDod: boolean;
  readonly noPlanningGap: boolean;
} {
  let noIntegrityOrDod = true;
  let noPlanningGap = true;
  for (const entry of state.findings) {
    if (entry.status !== "open") {
      continue;
    }
    if (entry.finding.kind === "integrity" || entry.finding.kind === "definition-of-done") {
      noIntegrityOrDod = false;
    } else if (entry.finding.kind === "planning-gap") {
      noPlanningGap = false;
    }
  }
  return Object.freeze({ noIntegrityOrDod, noPlanningGap });
}

function finalEvidence(
  state: RunState,
  candidateTree: ArtifactRoot,
): readonly ArtifactRef[] {
  if (state.currentPlanRootId === null) {
    return Object.freeze([]);
  }
  const verificationWork = state.workItems.filter((entry) => (
    entry.workItem.kind === "verify-candidate"
    && entry.workItem.planRootId === state.currentPlanRootId
    && entry.workItem.candidateRoot === candidateTree
  ));
  if (verificationWork.length === 0) {
    return Object.freeze([]);
  }
  const outputs: ArtifactRef[] = [];
  for (const work of verificationWork) {
    const satisfied = evidenceSatisfies(state, Object.freeze({
      evidenceId: null,
      workItemId: work.workItemId,
      tree: candidateTree,
      kindId: null,
      output: null,
      requireSuccessfulExit: true,
    }));
    if (!satisfied) {
      return Object.freeze([]);
    }
    const record = state.evidenceRecords.find((entry) => (
      entry.evidence.envelope.workItemId === work.workItemId
      && entry.evidence.envelope.tree === candidateTree
      && entry.evidence.envelope.exit.kind === "exited"
      && entry.evidence.envelope.exit.code === 0
      && evidenceSatisfies(state, Object.freeze({
        evidenceId: entry.evidenceId,
        workItemId: work.workItemId,
        tree: candidateTree,
        kindId: null,
        output: entry.evidence.envelope.output,
        requireSuccessfulExit: true,
      }))
    ));
    if (record === undefined) {
      return Object.freeze([]);
    }
    outputs.push(record.evidence.envelope.output);
  }
  return Object.freeze(outputs);
}

/** Pure journal-derived T1 predicate with no process/queue/time input. */
export function t1Eligibility(
  state: RunState,
  facts: readonly DomainFact[],
): T1Eligibility {
  const candidateState = stateAfterFacts(state, facts);
  if (candidateState === null || candidateState.terminal !== null) {
    const checks: T1PredicateChecks = Object.freeze({
      c1RequirementsBound: false,
      c2CoverageComplete: false,
      c3FinalEvidenceGreen: false,
      c4CandidateManifestBound: false,
      c5CurrentRootBindings: false,
      c6AcceptedWorkRetained: false,
      c7NoPlanningGap: false,
      noOpenIntegrityOrDefinitionOfDoneFinding: false,
      publicationContainsCandidate: false,
    });
    return Object.freeze({ eligible: false, checks });
  }

  const plan = candidateState.planRoots.find(
    (entry) => entry.planRootId === candidateState.currentPlanRootId,
  );
  const candidate = candidateState.candidates.find(
    (entry) => entry.candidateId === candidateState.currentCandidateId,
  );
  const publication = candidateState.publications.find(
    (entry) => entry.publicationId === candidateState.currentPublicationId,
  );
  const findingChecks = openFindingChecks(candidateState);
  const currentBindings = candidateState.phase === "execution"
    && !currentPlanIsSuperseded(candidateState)
    && plan !== undefined
    && candidate !== undefined
    && candidate.planRootId === plan.planRootId;
  const evidence = candidate === undefined
    ? Object.freeze([])
    : finalEvidence(candidateState, candidate.tree);
  const publicationContainsCandidate = candidate !== undefined
    && publication !== undefined
    && publication.candidateId === candidate.candidateId
    && publication.observation?.status === "desired-head"
    && publication.observation.observedHead === publication.desiredHead;
  const checks: T1PredicateChecks = Object.freeze({
    c1RequirementsBound: candidateState.requirements !== null,
    c2CoverageComplete: coverageComplete(candidateState),
    c3FinalEvidenceGreen: evidence.length > 0,
    c4CandidateManifestBound: candidate !== undefined,
    c5CurrentRootBindings: currentBindings,
    c6AcceptedWorkRetained: activeWorkAccepted(candidateState),
    c7NoPlanningGap: findingChecks.noPlanningGap,
    noOpenIntegrityOrDefinitionOfDoneFinding: findingChecks.noIntegrityOrDod,
    publicationContainsCandidate,
  });
  const eligible = checks.c1RequirementsBound
    && checks.c2CoverageComplete
    && checks.c3FinalEvidenceGreen
    && checks.c4CandidateManifestBound
    && checks.c5CurrentRootBindings
    && checks.c6AcceptedWorkRetained
    && checks.c7NoPlanningGap
    && checks.noOpenIntegrityOrDefinitionOfDoneFinding
    && checks.publicationContainsCandidate;
  if (
    !eligible
    || plan === undefined
    || candidate === undefined
    || publication === undefined
    || publication.observation === null
  ) {
    return Object.freeze({ eligible: false, checks });
  }
  const firstEvidence = evidence[0];
  if (firstEvidence === undefined) {
    return Object.freeze({ eligible: false, checks });
  }
  return Object.freeze({
    eligible: true,
    checks,
    finalTree: candidate.tree,
    publishedRevision: publication.observation.observedHead,
    coverageRoot: plan.coverageRoot,
    evidenceRoot: firstEvidence.root,
  });
}

/** Pure journal-derived T2 predicate; execution state is structurally ineligible. */
export function t2Eligibility(
  state: RunState,
  facts: readonly DomainFact[],
): T2Eligibility {
  const candidateState = stateAfterFacts(state, facts);
  if (
    candidateState === null
    || candidateState.terminal !== null
    || candidateState.phase !== "planning"
  ) {
    return Object.freeze({ eligible: false });
  }
  const gap = candidateState.findings.find((entry) => (
    entry.status === "open" && entry.finding.kind === "planning-gap"
  ));
  if (gap === undefined || gap.finding.kind !== "planning-gap") {
    return Object.freeze({ eligible: false });
  }
  return Object.freeze({
    eligible: true,
    reason: gap.finding.reason,
    sourceAnchors: gap.finding.sourceAnchors,
    explanation: gap.finding.explanation,
  });
}

export function t1Predicate(state: RunState, facts: readonly DomainFact[]): boolean {
  return t1Eligibility(state, facts).eligible;
}

export function t2Predicate(state: RunState, facts: readonly DomainFact[]): boolean {
  return t2Eligibility(state, facts).eligible;
}

/** Sole semantic TerminalOutcome construction path. */
export function determineTerminalOutcome(
  state: RunState,
  facts: readonly DomainFact[],
): TerminalOutcome | null {
  const t2 = t2Eligibility(state, facts);
  if (t2.eligible) {
    return Object.freeze({
      kind: "t2",
      reason: t2.reason,
      sourceAnchors: t2.sourceAnchors,
      explanation: t2.explanation,
    });
  }
  const t1 = t1Eligibility(state, facts);
  if (t1.eligible) {
    return Object.freeze({
      kind: "t1",
      finalTree: t1.finalTree,
      publishedRevision: t1.publishedRevision,
      coverageRoot: t1.coverageRoot,
      evidenceRoot: t1.evidenceRoot,
    });
  }
  return null;
}

void (determineTerminalOutcome satisfies OutcomeSeam);
