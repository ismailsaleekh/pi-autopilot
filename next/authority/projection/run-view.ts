import type {
  AcceptedPlanRootState,
  CandidateState,
  PublicationState,
  RunState,
  WorkItemStatus,
} from "../model/run-state.js";
import type { Finding } from "../protocol/finding.capsule.js";
import type {
  ArtifactRef,
  ArtifactRoot,
  CandidateId,
  FindingId,
  OperatorRequestId,
  PlanRootId,
  PublicationId,
  RequirementId,
  RevisionId,
  RoleId,
  RunId,
  WorkItemId,
} from "../protocol/identifiers.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";

export type RunViewPhase = "planning" | "execution" | "terminal";

export interface WorkItemView {
  readonly workItemId: WorkItemId;
  readonly kind: "produce-artifact" | "review-artifact" | "correct-artifact" | "integrate-candidate" | "verify-candidate";
  readonly roleId: RoleId;
  readonly planRootId: PlanRootId;
  readonly status: WorkItemStatus;
}

export interface OpenFindingView {
  readonly findingId: FindingId;
  readonly kind: Finding["kind"];
  readonly ownerWorkItemId: WorkItemId;
  readonly detail: ArtifactRef;
  readonly subjectRoot: ArtifactRoot | null;
}

export interface CoverageSummary {
  readonly linkCount: number;
  readonly evidencedLinkCount: number;
  readonly requirementCount: number;
  readonly workItemCount: number;
}

export interface SuspensionView {
  readonly operatorRequestId: OperatorRequestId;
  readonly reason: ArtifactRef;
}

export interface CandidateView {
  readonly candidateId: CandidateId;
  readonly planRootId: PlanRootId;
  readonly tree: ArtifactRoot;
  readonly manifest: ArtifactRef;
}

export interface PublicationView {
  readonly publicationId: PublicationId;
  readonly candidateId: CandidateId;
  readonly expectedHead: RevisionId;
  readonly desiredHead: RevisionId;
  readonly observedHead: RevisionId | null;
  readonly status: "pending" | "desired-head" | "head-moved";
}

export interface TerminalView {
  readonly sequence: number;
  readonly outcome: TerminalOutcome;
}

export interface RunView {
  readonly runId: RunId;
  readonly lastSequence: number;
  readonly phase: RunViewPhase;
  readonly suspended: SuspensionView | null;
  readonly currentPlanRoot: AcceptedPlanRootState | null;
  readonly workItems: readonly WorkItemView[];
  readonly openFindings: readonly OpenFindingView[];
  readonly coverage: CoverageSummary;
  readonly currentCandidate: CandidateView | null;
  readonly currentPublication: PublicationView | null;
  readonly terminal: TerminalView | null;
}

type FindingOfKind<Kind extends Finding["kind"]> = Extract<Finding, { readonly kind: Kind }>;
type FindingProjectionMap = {
  readonly [Kind in Finding["kind"]]: (finding: FindingOfKind<Kind>) => OpenFindingView;
};

const findingProjectors = Object.freeze({
  advisory(finding) {
    return Object.freeze({
      findingId: finding.findingId,
      kind: finding.kind,
      ownerWorkItemId: finding.raisedByWorkItemId,
      detail: finding.report,
      subjectRoot: finding.subjectRoot,
    });
  },
  "definition-of-done"(finding) {
    return Object.freeze({
      findingId: finding.findingId,
      kind: finding.kind,
      ownerWorkItemId: finding.correctionOwner,
      detail: finding.report,
      subjectRoot: finding.subjectRoot,
    });
  },
  integrity(finding) {
    return Object.freeze({
      findingId: finding.findingId,
      kind: finding.kind,
      ownerWorkItemId: finding.correctionOwner,
      detail: finding.report,
      subjectRoot: finding.subjectRoot,
    });
  },
  "planning-gap"(finding) {
    return Object.freeze({
      findingId: finding.findingId,
      kind: finding.kind,
      ownerWorkItemId: finding.planAuthorWorkItemId,
      detail: finding.explanation,
      subjectRoot: null,
    });
  },
}) satisfies FindingProjectionMap;

function projectFinding(finding: Finding): OpenFindingView {
  switch (finding.kind) {
    case "advisory":
      return findingProjectors.advisory(finding);
    case "definition-of-done":
      return findingProjectors["definition-of-done"](finding);
    case "integrity":
      return findingProjectors.integrity(finding);
    case "planning-gap":
      return findingProjectors["planning-gap"](finding);
  }
}

function uniqueCount<Value>(values: readonly Value[]): number {
  const seen: Value[] = [];
  for (const value of values) {
    if (!seen.includes(value)) {
      seen.push(value);
    }
  }
  return seen.length;
}

function currentPlan(state: RunState): AcceptedPlanRootState | null {
  if (state.currentPlanRootId === null) {
    return null;
  }
  return state.planRoots.find((entry) => entry.planRootId === state.currentPlanRootId) ?? null;
}

function candidateView(candidate: CandidateState | undefined): CandidateView | null {
  if (candidate === undefined) {
    return null;
  }
  return Object.freeze({
    candidateId: candidate.candidateId,
    planRootId: candidate.planRootId,
    tree: candidate.tree,
    manifest: candidate.manifest,
  });
}

function publicationView(publication: PublicationState | undefined): PublicationView | null {
  if (publication === undefined) {
    return null;
  }
  return Object.freeze({
    publicationId: publication.publicationId,
    candidateId: publication.candidateId,
    expectedHead: publication.expectedHead,
    desiredHead: publication.desiredHead,
    observedHead: publication.observation?.observedHead ?? null,
    status: publication.observation?.status ?? "pending",
  });
}

function phase(state: RunState): RunViewPhase {
  return state.terminal === null ? state.phase : "terminal";
}

/** A deletable read model. No authority decision imports or consults this view. */
export function projectRunState(state: RunState): RunView {
  const workItems = Object.freeze(state.workItems.map((entry): WorkItemView => Object.freeze({
    workItemId: entry.workItemId,
    kind: entry.workItem.kind,
    roleId: entry.workItem.roleId,
    planRootId: entry.workItem.planRootId,
    status: entry.status,
  })));
  const openFindings = Object.freeze(
    state.findings
      .filter((entry) => entry.status === "open")
      .map((entry) => projectFinding(entry.finding)),
  );
  const requirementIds: RequirementId[] = state.coverageLinks.map((link) => link.requirementId);
  const coveredWorkItemIds: WorkItemId[] = state.coverageLinks.map((link) => link.workItemId);
  const currentCandidate = state.currentCandidateId === null
    ? undefined
    : state.candidates.find((entry) => entry.candidateId === state.currentCandidateId);
  const currentPublication = state.currentPublicationId === null
    ? undefined
    : state.publications.find((entry) => entry.publicationId === state.currentPublicationId);
  return Object.freeze({
    runId: state.identity.runId,
    lastSequence: state.lastSequence,
    phase: phase(state),
    suspended: state.suspension.kind === "active"
      ? null
      : Object.freeze({
          operatorRequestId: state.suspension.operatorRequestId,
          reason: state.suspension.reason,
        }),
    currentPlanRoot: currentPlan(state),
    workItems,
    openFindings,
    coverage: Object.freeze({
      linkCount: state.coverageLinks.length,
      evidencedLinkCount: state.coverageLinks.filter((link) => link.evidence !== null).length,
      requirementCount: uniqueCount(requirementIds),
      workItemCount: uniqueCount(coveredWorkItemIds),
    }),
    currentCandidate: candidateView(currentCandidate),
    currentPublication: publicationView(currentPublication),
    terminal: state.terminal === null
      ? null
      : Object.freeze({
          sequence: state.terminal.sequence,
          outcome: state.terminal.outcome,
        }),
  });
}
