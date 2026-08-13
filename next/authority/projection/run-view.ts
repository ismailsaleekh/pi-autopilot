import type {
  CurrentPlanState,
  RunState,
} from "../model/run-state.js";
import { indexValues } from "../model/authenticated-index.js";
import type { Finding } from "../protocol/finding.capsule.js";
import type { ExpectedRefState } from "../protocol/git-values.js";
import type {
  ArtifactRef,
  ArtifactRoot,
  CandidateId,
  DecimalNatural,
  FindingId,
  GitCommitId,
  GitTreeId,
  OperatorRequestId,
  PlanRootId,
  PublicationId,
  RoleId,
  RunId,
  WorkItemId,
} from "../protocol/identifiers.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type { WorkItem } from "../protocol/work-item.capsule.js";

export type RunViewPhase = "planning" | "execution" | "terminal";

export interface WorkItemView {
  readonly workItemId: WorkItemId;
  readonly kind: WorkItem["kind"];
  readonly roleId: RoleId;
  readonly planRootId: PlanRootId;
  readonly status: "declared" | "accepted";
}

export interface OpenFindingView {
  readonly findingId: FindingId;
  readonly kind: Finding["kind"];
  readonly ownerWorkItemId: WorkItemId | null;
  readonly detail: ArtifactRef;
  readonly subjectRoot: ArtifactRoot | null;
}

export interface CoverageSummary {
  readonly declaredAtoms: DecimalNatural;
  readonly dispositionedAtoms: DecimalNatural;
  readonly declaredWork: DecimalNatural;
  readonly acceptedWork: DecimalNatural;
}

export interface SuspensionView {
  readonly operatorRequestId: OperatorRequestId;
  readonly reason: ArtifactRef;
}

export interface CandidateView {
  readonly candidateId: CandidateId;
  readonly planRootId: PlanRootId;
  readonly tree: ArtifactRoot;
  readonly gitRevision: GitCommitId;
  readonly gitTree: GitTreeId;
  readonly manifest: ArtifactRef;
}

export interface PublicationView {
  readonly publicationId: PublicationId;
  readonly candidateId: CandidateId;
  readonly expected: ExpectedRefState;
  readonly desiredHead: GitCommitId;
  readonly observedHead: GitCommitId | null;
  readonly status: "intended" | "desired-head" | "head-moved";
}

export interface TerminalView {
  readonly sequence: DecimalNatural;
  readonly outcome: TerminalOutcome;
}

export interface RunView {
  readonly runId: RunId;
  readonly lastSequence: DecimalNatural;
  readonly phase: RunViewPhase;
  readonly suspended: SuspensionView | null;
  readonly currentPlan: CurrentPlanState | null;
  readonly workItems: readonly WorkItemView[];
  readonly workItemsComplete: boolean;
  readonly openFindings: readonly OpenFindingView[];
  readonly findingsComplete: boolean;
  readonly coverage: CoverageSummary;
  readonly currentCandidate: CandidateView | null;
  readonly currentPublication: PublicationView | null;
  readonly terminal: TerminalView | null;
}

function findingDetail(finding: Finding): ArtifactRef {
  return finding.kind === "planning-gap" ? finding.explanation : finding.report;
}

function findingSubject(finding: Finding): ArtifactRoot | null {
  return finding.kind === "planning-gap" ? null : finding.subjectRoot;
}

function findingOwner(state: RunState, finding: Finding): WorkItemId | null {
  if (finding.kind === "advisory") {
    return finding.raisedByWorkItemId;
  }
  if (finding.kind === "planning-gap") {
    return state.currentPlan?.planAuthorWorkItemId ?? null;
  }
  return finding.subjectWorkItemId ?? state.currentPlan?.integrationOwnerWorkItemId ?? null;
}

/** Bounded deletable read model; incomplete hot pages are marked explicitly. */
export function projectRunState(state: RunState): RunView {
  const workValues = indexValues(state.indexes.work, "work");
  const findingValues = indexValues(state.indexes.findings, "finding");
  const workItems = Object.freeze((workValues ?? Object.freeze([]))
    .filter((value) => value.kind === "work")
    .map((value): WorkItemView => Object.freeze({
      workItemId: value.workItem.workItemId,
      kind: value.workItem.kind,
      roleId: value.workItem.roleId,
      planRootId: value.workItem.planRootId,
      status: value.acceptedOutput === null ? "declared" : "accepted",
    })));
  const openFindings = Object.freeze((findingValues ?? Object.freeze([]))
    .filter((value) => value.kind === "finding" && value.status === "open")
    .map((value): OpenFindingView => {
      if (value.kind !== "finding") {
        throw new Error("closed index kind narrowing failed");
      }
      return Object.freeze({
        findingId: value.finding.findingId,
        kind: value.finding.kind,
        ownerWorkItemId: findingOwner(state, value.finding),
        detail: findingDetail(value.finding),
        subjectRoot: findingSubject(value.finding),
      });
    }));
  return Object.freeze({
    runId: state.identity.runId,
    lastSequence: state.lastSequence,
    phase: state.terminal === null ? state.phase : "terminal",
    suspended: state.suspension.kind === "active"
      ? null
      : Object.freeze({
          operatorRequestId: state.suspension.operatorRequestId,
          reason: state.suspension.reason,
        }),
    currentPlan: state.currentPlan,
    workItems,
    workItemsComplete: workValues !== null,
    openFindings,
    findingsComplete: findingValues !== null,
    coverage: Object.freeze({
      declaredAtoms: state.counters.declaredAtoms,
      dispositionedAtoms: state.counters.dispositionedAtoms,
      declaredWork: state.counters.declaredWork,
      acceptedWork: state.counters.acceptedWork,
    }),
    currentCandidate: state.currentCandidate === null
      ? null
      : Object.freeze({ ...state.currentCandidate }),
    currentPublication: state.currentPublication === null
      ? null
      : Object.freeze({
          publicationId: state.currentPublication.publicationId,
          candidateId: state.currentPublication.candidateId,
          expected: state.currentPublication.expected,
          desiredHead: state.currentPublication.desiredHead,
          observedHead: state.currentPublication.observedHead,
          status: state.currentPublication.status,
        }),
    terminal: state.terminal === null
      ? null
      : Object.freeze({ sequence: state.terminal.sequence, outcome: state.terminal.outcome }),
  });
}
