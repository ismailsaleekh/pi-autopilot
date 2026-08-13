import type { PlanningGapFinding } from "../protocol/finding.capsule.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import type {
  ActionId,
  ArtifactRef,
  ArtifactRoot,
  CandidateId,
  DecimalNatural,
  Digest,
  EvidenceId,
  GitCommitId,
  GitRef,
  GitTreeId,
  OperatorRequestId,
  PlanRootId,
  PublicationId,
  RepositoryCapability,
  RunId,
  WorkItemId,
} from "../protocol/identifiers.js";
import type { ExpectedRefState } from "../protocol/git-values.js";
import type { SubscriptionRoute } from "../protocol/route.capsule.js";
import { canonicalDigestUnknown as digestCanonicalState } from "../protocol/schema.js";
import type { AuthenticatedIndexState } from "./authenticated-index.js";

export interface RunIdentity {
  readonly runId: RunId;
  readonly taskSnapshot: ArtifactRoot;
  readonly repository: RepositoryCapability;
  readonly repositoryBase: GitCommitId;
  readonly repositoryTree: GitTreeId;
  readonly publicationRef: GitRef;
  readonly expectedPublication: ExpectedRefState;
  readonly policyRoot: ArtifactRoot;
  readonly runtimeRoot: ArtifactRoot;
  readonly route: SubscriptionRoute;
}

export interface RequirementsState {
  readonly sourceRoot: ArtifactRoot;
  readonly requirementsRoot: ArtifactRoot;
  readonly taskRoot: ArtifactRoot;
  readonly atomIndexRoot: AuthenticatedIndexState["root"];
  readonly declaredAtomCount: DecimalNatural;
  readonly inventorySealed: boolean;
  readonly inventoryEvidence: ArtifactRef | null;
}

export type RunPhase = "planning" | "execution";

export interface CurrentPlanState {
  readonly planRootId: PlanRootId;
  readonly planRoot: ArtifactRoot;
  readonly coverageRoot: ArtifactRoot;
  readonly reviewedPlan: ArtifactRef;
  readonly planAuthorWorkItemId: WorkItemId;
  readonly integrationOwnerWorkItemId: WorkItemId;
}

export interface CurrentCandidateState {
  readonly candidateId: CandidateId;
  readonly planRootId: PlanRootId;
  readonly tree: ArtifactRoot;
  readonly gitRevision: GitCommitId;
  readonly gitTree: GitTreeId;
  readonly manifest: ArtifactRef;
  readonly reviewedDiff: ArtifactRef;
  readonly gitTreeCasAttestation: ArtifactRef;
}

export interface CurrentPublicationState {
  readonly publicationId: PublicationId;
  readonly candidateId: CandidateId;
  readonly repository: RepositoryCapability;
  readonly publicationRef: GitRef;
  readonly expected: ExpectedRefState;
  readonly desiredHead: GitCommitId;
  readonly status: "intended" | "desired-head" | "head-moved";
  readonly observedHead: GitCommitId | null;
  readonly tree: ArtifactRoot | null;
  readonly gitTree: GitTreeId | null;
  readonly publicationTreeAttestation: ArtifactRef | null;
}

export interface FinalAttestationState {
  readonly candidateId: CandidateId;
  readonly publicationId: PublicationId;
  readonly c1ToC7Proof: ArtifactRef;
  readonly finalManifest: ArtifactRef;
  readonly evidenceIndexRoot: AuthenticatedIndexState["root"];
  readonly finalVerificationEvidence: EvidenceId;
  readonly advisoryDisclosures: ArtifactRef;
}

export interface RunCounters {
  readonly declaredAtoms: DecimalNatural;
  readonly dispositionedAtoms: DecimalNatural;
  readonly declaredWork: DecimalNatural;
  readonly acceptedWork: DecimalNatural;
  readonly openBlockingFindings: DecimalNatural;
  readonly openAdvisoryFindings: DecimalNatural;
  readonly observedEvidence: DecimalNatural;
}

export interface RunIndexes {
  readonly actions: AuthenticatedIndexState;
  readonly atoms: AuthenticatedIndexState;
  readonly candidates: AuthenticatedIndexState;
  readonly commands: AuthenticatedIndexState;
  readonly dependencies: AuthenticatedIndexState;
  readonly dispositions: AuthenticatedIndexState;
  readonly evidence: AuthenticatedIndexState;
  readonly findings: AuthenticatedIndexState;
  readonly plans: AuthenticatedIndexState;
  readonly publications: AuthenticatedIndexState;
  readonly submissions: AuthenticatedIndexState;
  readonly work: AuthenticatedIndexState;
}

export type SuspensionState =
  | { readonly kind: "active" }
  | {
      readonly kind: "suspended";
      readonly actionId: ActionId;
      readonly operatorRequestId: OperatorRequestId;
      readonly reason: ArtifactRef;
      readonly sequence: DecimalNatural;
    };

export interface TerminalState {
  readonly actionId: ActionId;
  readonly sequence: DecimalNatural;
  readonly outcome: TerminalOutcome;
}

/**
 * Bounded replay state. Complete history lives only in the journal and the
 * authenticated indexes. Every in-memory index keeps at most a fixed hot page;
 * decisions require root-bound proof pages when the needed value is not hot.
 */
export interface RunState {
  readonly identity: RunIdentity;
  readonly phase: RunPhase;
  readonly lastSequence: DecimalNatural;
  readonly requirements: RequirementsState | null;
  readonly currentPlan: CurrentPlanState | null;
  readonly currentCandidate: CurrentCandidateState | null;
  readonly currentPublication: CurrentPublicationState | null;
  readonly finalAttestations: FinalAttestationState | null;
  readonly planningGap: PlanningGapFinding | null;
  readonly counters: RunCounters;
  readonly indexes: RunIndexes;
  readonly suspension: SuspensionState;
  readonly terminal: TerminalState | null;
}

/** Canonical replay anchor; it never depends on locale, clock, or host JSON. */
export function stateDigest(state: RunState): Digest {
  return digestCanonicalState(state);
}
