import type {
  CoverageLinkState,
  RunState,
  SubmissionBindingState,
} from "../model/run-state.js";
import type {
  ArtifactRef,
  ArtifactRoot,
  PlanRootId,
  RequirementId,
  SourceAnchor,
  WorkItemId,
} from "../protocol/identifiers.js";
import { evidenceSatisfies } from "../evidence/index.js";

export type CoverageObligation =
  | {
      readonly kind: "requirements-unbound";
      readonly diagnostic: string;
    }
  | {
      readonly kind: "current-plan-unavailable";
      readonly diagnostic: string;
    }
  | {
      readonly kind: "anchor-index-unresolved";
      readonly diagnostic: string;
    }
  | {
      readonly kind: "disposition-unrepresented";
      readonly sourceAnchor: SourceAnchor;
      readonly requirementId: RequirementId;
      readonly workItemId: WorkItemId;
      readonly diagnostic: string;
    }
  | {
      readonly kind: "accepted-output-missing";
      readonly sourceAnchor: SourceAnchor;
      readonly requirementId: RequirementId;
      readonly workItemId: WorkItemId;
      readonly diagnostic: string;
    }
  | {
      readonly kind: "evidence-missing";
      readonly sourceAnchor: SourceAnchor;
      readonly requirementId: RequirementId;
      readonly workItemId: WorkItemId;
      readonly diagnostic: string;
    }
  | {
      readonly kind: "evidence-unsatisfied";
      readonly sourceAnchor: SourceAnchor;
      readonly requirementId: RequirementId;
      readonly workItemId: WorkItemId;
      readonly evidence: ArtifactRef;
      readonly diagnostic: string;
    };

export interface AnchorTraceLink {
  readonly requirementId: RequirementId;
  readonly planRootId: PlanRootId;
  readonly workItemId: WorkItemId;
  readonly implementationAccepted: boolean;
  readonly implementationRoot: CoverageLinkState["implementationRoot"];
  readonly evidence: ArtifactRef | null;
  readonly evidenceSatisfied: boolean;
  readonly disposition: "unrepresented";
}

export interface AnchorTrace {
  readonly anchor: SourceAnchor;
  readonly anchorIndexRoot: ArtifactRoot | null;
  readonly currentPlanRootId: PlanRootId | null;
  readonly links: readonly AnchorTraceLink[];
  readonly anchorMembershipResolved: false;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function linkKey(link: CoverageLinkState): string {
  return `${link.sourceAnchor}\u0000${link.requirementId}\u0000${link.workItemId}`;
}

function currentLinks(state: RunState): readonly CoverageLinkState[] {
  if (
    state.currentPlanRootId === null
    || state.supersededPlanRoots.some(
      (supersession) => supersession.priorPlanRootId === state.currentPlanRootId,
    )
  ) {
    return Object.freeze([]);
  }
  return Object.freeze(
    state.coverageLinks
      .filter((link) => link.planRootId === state.currentPlanRootId)
      .slice()
      .sort((left, right) => compareText(linkKey(left), linkKey(right))),
  );
}

function matchingSubmission(
  state: RunState,
  link: CoverageLinkState,
): SubmissionBindingState | null {
  const work = state.workItems.find((entry) => entry.workItemId === link.workItemId);
  if (work === undefined || work.workItem.planRootId !== link.planRootId) {
    return null;
  }
  return state.submissions.find((submission) => (
    submission.workItemId === link.workItemId
    && submission.planRootId === link.planRootId
    && submission.inputRoot === work.workItem.inputRoot
    && submission.outputRoot === link.implementationRoot
  )) ?? null;
}

function linkEvidenceSatisfied(state: RunState, link: CoverageLinkState): boolean {
  if (link.evidence === null) {
    return false;
  }
  return evidenceSatisfies(state, Object.freeze({
    evidenceId: null,
    workItemId: link.workItemId,
    tree: link.implementationRoot,
    kindId: null,
    output: link.evidence,
    requireSuccessfulExit: true,
  }));
}

/**
 * Return every obligation provable from reference-only state. The frozen state
 * exposes the anchor index only as a CAS root and CoverageLinked has no
 * disposition discriminant, so those two unresolved obligations remain loud;
 * neither is inferred from an existing link.
 */
export function coverageObligations(state: RunState): readonly CoverageObligation[] {
  const obligations: CoverageObligation[] = [];
  if (state.requirements === null) {
    obligations.push(Object.freeze({
      kind: "requirements-unbound",
      diagnostic: "requirements-unbound: source requirements and their anchor index are not journal-bound",
    }));
  } else {
    obligations.push(Object.freeze({
      kind: "anchor-index-unresolved",
      diagnostic: `anchor-index-unresolved: ${state.requirements.anchorIndexRoot} is reference-only; no fact enumerates its exact anchors`,
    }));
  }
  if (state.currentPlanRootId === null) {
    obligations.push(Object.freeze({
      kind: "current-plan-unavailable",
      diagnostic: "current-plan-unavailable: no accepted current plan root exists",
    }));
  }

  for (const link of currentLinks(state)) {
    obligations.push(Object.freeze({
      kind: "disposition-unrepresented",
      sourceAnchor: link.sourceAnchor,
      requirementId: link.requirementId,
      workItemId: link.workItemId,
      diagnostic: `disposition-unrepresented: ${link.sourceAnchor} has a trace link but no implemented-by/honored-by/guards/verified-by/N-A disposition fact`,
    }));
    if (matchingSubmission(state, link) === null) {
      obligations.push(Object.freeze({
        kind: "accepted-output-missing",
        sourceAnchor: link.sourceAnchor,
        requirementId: link.requirementId,
        workItemId: link.workItemId,
        diagnostic: `accepted-output-missing: ${link.workItemId} has no accepted output ${link.implementationRoot} against ${link.planRootId}`,
      }));
    }
    if (link.evidence === null) {
      obligations.push(Object.freeze({
        kind: "evidence-missing",
        sourceAnchor: link.sourceAnchor,
        requirementId: link.requirementId,
        workItemId: link.workItemId,
        diagnostic: `evidence-missing: ${link.sourceAnchor} has no evidence reference`,
      }));
    } else if (!linkEvidenceSatisfied(state, link)) {
      obligations.push(Object.freeze({
        kind: "evidence-unsatisfied",
        sourceAnchor: link.sourceAnchor,
        requirementId: link.requirementId,
        workItemId: link.workItemId,
        evidence: link.evidence,
        diagnostic: `evidence-unsatisfied: ${link.sourceAnchor} does not resolve to green evidence on ${link.implementationRoot}`,
      }));
    }
  }
  return Object.freeze(obligations);
}

/** C2 is complete only when no unresolved graph obligation remains. */
export function coverageComplete(state: RunState): boolean {
  return coverageObligations(state).length === 0;
}

/** Trace one exact anchor without assuming that it belongs to the opaque index. */
export function traceAnchor(state: RunState, anchor: SourceAnchor): AnchorTrace {
  const links = currentLinks(state)
    .filter((link) => link.sourceAnchor === anchor)
    .map((link): AnchorTraceLink => Object.freeze({
      requirementId: link.requirementId,
      planRootId: link.planRootId,
      workItemId: link.workItemId,
      implementationAccepted: matchingSubmission(state, link) !== null,
      implementationRoot: link.implementationRoot,
      evidence: link.evidence,
      evidenceSatisfied: linkEvidenceSatisfied(state, link),
      disposition: "unrepresented",
    }));
  return Object.freeze({
    anchor,
    anchorIndexRoot: state.requirements?.anchorIndexRoot ?? null,
    currentPlanRootId: state.currentPlanRootId,
    links: Object.freeze(links),
    anchorMembershipResolved: false,
  });
}
