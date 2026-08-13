import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import type { EvidenceFact } from "../protocol/evidence-fact.capsule.js";
import type { Finding } from "../protocol/finding.capsule.js";
import type {
  ActionId,
  ArtifactRef,
  ArtifactRoot,
  AttemptId,
  CandidateId,
  CommandId,
  Digest,
  EvidenceId,
  FindingId,
  OperatorRequestId,
  PlanRootId,
  PublicationId,
  RequirementId,
  RevisionId,
  RunId,
  SourceAnchor,
  SubmissionId,
  WorkItemId,
} from "../protocol/identifiers.js";
import { canonicalDigestUnknown as digestCanonicalState } from "../protocol/schema.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type { WorkItem } from "../protocol/work-item.capsule.js";

export interface RunIdentity {
  readonly runId: RunId;
  readonly taskSnapshot: ArtifactRoot;
  readonly repositoryBase: RevisionId;
  readonly policyRoot: ArtifactRoot;
  readonly runtimeRoot: ArtifactRoot;
}

export interface RequirementsState {
  readonly sourceRoot: ArtifactRoot;
  readonly requirementsRoot: ArtifactRoot;
  readonly anchorIndexRoot: ArtifactRoot;
}

export type RunPhase = "planning" | "execution";

export type WorkItemStatus = "declared" | "submission-bound";

export interface WorkItemState {
  readonly workItemId: WorkItemId;
  readonly workItem: WorkItem;
  readonly status: WorkItemStatus;
  readonly latestSubmissionId: SubmissionId | null;
}

export interface SubmissionBindingState {
  readonly submissionId: SubmissionId;
  readonly workItemId: WorkItemId;
  readonly attemptId: AttemptId;
  readonly planRootId: PlanRootId;
  readonly inputRoot: ArtifactRoot;
  readonly outputRoot: ArtifactRoot;
}

export interface AcceptedPlanRootState {
  readonly planRootId: PlanRootId;
  readonly planRoot: ArtifactRoot;
  readonly coverageRoot: ArtifactRoot;
}

export interface SupersededPlanRootState {
  readonly priorPlanRootId: PlanRootId;
  readonly newPlanRootId: PlanRootId;
  readonly reason: ArtifactRef;
}

export interface CoverageLinkState {
  readonly requirementId: RequirementId;
  readonly sourceAnchor: SourceAnchor;
  readonly planRootId: PlanRootId;
  readonly workItemId: WorkItemId;
  readonly implementationRoot: ArtifactRoot;
  readonly evidence: ArtifactRef | null;
}

export interface FindingClearanceState {
  readonly correctedRoot: ArtifactRoot;
  readonly resolution: ArtifactRef;
}

export type FindingStatus = "open" | "cleared";

export interface FindingState {
  readonly findingId: FindingId;
  readonly finding: Finding;
  readonly status: FindingStatus;
  readonly clearance: FindingClearanceState | null;
}

export interface EvidenceRecordState {
  readonly evidenceId: EvidenceId;
  readonly evidence: EvidenceFact;
}

export interface CandidateState {
  readonly candidateId: CandidateId;
  readonly planRootId: PlanRootId;
  readonly tree: ArtifactRoot;
  readonly manifest: ArtifactRef;
}

export interface PublicationObservationState {
  readonly observedHead: RevisionId;
  readonly status: "desired-head" | "head-moved";
}

export interface PublicationState {
  readonly publicationId: PublicationId;
  readonly candidateId: CandidateId;
  readonly expectedHead: RevisionId;
  readonly desiredHead: RevisionId;
  readonly observation: PublicationObservationState | null;
}

export interface DecisionCommitState {
  readonly actionId: ActionId;
  readonly sequence: number;
  readonly stimulusDigest: Digest;
  readonly factRoot: ArtifactRoot;
  readonly commandRoot: ArtifactRoot;
}

export interface ActionCommitState {
  readonly actionId: ActionId;
  readonly recordKind:
    | "decision-committed"
    | "outcome-committed"
    | "run-suspended"
    | "run-resumed";
  readonly sequence: number;
}

export interface CommandSettlementState {
  readonly commandId: CommandId;
  readonly actionId: ActionId;
  readonly sequence: number;
  readonly observation: ArtifactRef;
  readonly observationDigest: Digest;
}

export type SuspensionState =
  | { readonly kind: "active" }
  | {
      readonly kind: "suspended";
      readonly actionId: ActionId;
      readonly operatorRequestId: OperatorRequestId;
      readonly reason: ArtifactRef;
      readonly sequence: number;
    };

export interface TerminalState {
  readonly actionId: ActionId;
  readonly sequence: number;
  readonly outcome: TerminalOutcome;
}

/**
 * The replayed semantic state. Every payload-bearing value is an immutable CAS
 * reference or a closed protocol record made only from IDs and references.
 * Journal history remains in the journal; these tables retain current control
 * state and the identities needed by later pure decisions.
 */
export interface RunState {
  readonly identity: RunIdentity;
  readonly phase: RunPhase;
  readonly lastSequence: number;
  readonly requirements: RequirementsState | null;
  readonly workItems: readonly WorkItemState[];
  readonly submissions: readonly SubmissionBindingState[];
  readonly planRoots: readonly AcceptedPlanRootState[];
  readonly currentPlanRootId: PlanRootId | null;
  readonly supersededPlanRoots: readonly SupersededPlanRootState[];
  readonly coverageLinks: readonly CoverageLinkState[];
  readonly findings: readonly FindingState[];
  readonly evidenceRecords: readonly EvidenceRecordState[];
  readonly candidates: readonly CandidateState[];
  readonly currentCandidateId: CandidateId | null;
  readonly publications: readonly PublicationState[];
  readonly currentPublicationId: PublicationId | null;
  readonly commandSettlements: readonly CommandSettlementState[];
  readonly actionCommits: readonly ActionCommitState[];
  readonly lastDecision: DecisionCommitState | null;
  readonly suspension: SuspensionState;
  readonly terminal: TerminalState | null;
}

export type DomainFactKind = DomainFact["kind"];

/** Canonical replay anchor; it never depends on locale, clock, or host JSON. */
export function stateDigest(state: RunState): Digest {
  return digestCanonicalState(state);
}
