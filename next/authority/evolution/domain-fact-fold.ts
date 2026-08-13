import type {
  CandidateAccepted,
  CoverageLinked,
  DomainFact,
  EvidenceObserved,
  FindingCleared,
  FindingRaised,
  PlanRootAccepted,
  PlanRootSuperseded,
  PublicationIntended,
  PublicationObserved,
  RequirementsBound,
  SubmissionBound,
  WorkDeclared,
} from "../protocol/domain-fact.capsule.js";
import type { RunId } from "../protocol/identifiers.js";
import type {
  AcceptedPlanRootState,
  CandidateState,
  CoverageLinkState,
  EvidenceRecordState,
  FindingState,
  PublicationState,
  RunState,
  SubmissionBindingState,
  SupersededPlanRootState,
  WorkItemState,
} from "../model/run-state.js";
import type { FoldError } from "./fold-result.js";

export type DomainFactFoldResult =
  | { readonly kind: "applied"; readonly state: RunState }
  | { readonly kind: "rejected"; readonly state: RunState; readonly error: FoldError };

type FactOfKind<Kind extends DomainFact["kind"]> = Extract<DomainFact, { readonly kind: Kind }>;
type DomainFactHandlerMap = {
  readonly [Kind in DomainFact["kind"]]: (
    state: RunState,
    fact: FactOfKind<Kind>,
  ) => DomainFactFoldResult;
};

function applied(state: RunState): DomainFactFoldResult {
  return Object.freeze({ kind: "applied", state });
}

function rejected(state: RunState, error: FoldError): DomainFactFoldResult {
  return Object.freeze({ kind: "rejected", state, error: Object.freeze(error) });
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function sortedBy<Value>(
  values: readonly Value[],
  key: (value: Value) => string,
): readonly Value[] {
  return Object.freeze(values.slice().sort((left, right) => compareText(key(left), key(right))));
}

function nestedRunMatches(
  state: RunState,
  factKind: DomainFact["kind"],
  actualRunId: RunId,
): DomainFactFoldResult | null {
  if (actualRunId === state.identity.runId) {
    return null;
  }
  return rejected(state, {
    code: "fact-run-mismatch",
    factKind,
    expectedRunId: state.identity.runId,
    actualRunId,
  });
}

function applyRequirementsBound(state: RunState, fact: RequirementsBound): DomainFactFoldResult {
  if (state.requirements !== null) {
    return rejected(state, { code: "duplicate-requirements-binding" });
  }
  return applied(Object.freeze({
    ...state,
    requirements: Object.freeze({
      sourceRoot: fact.sourceRoot,
      requirementsRoot: fact.requirementsRoot,
      anchorIndexRoot: fact.anchorIndexRoot,
    }),
  }));
}

function applyWorkDeclared(state: RunState, fact: WorkDeclared): DomainFactFoldResult {
  const nestedMismatch = nestedRunMatches(state, fact.kind, fact.workItem.runId);
  if (nestedMismatch !== null) {
    return nestedMismatch;
  }
  if (state.workItems.some((entry) => entry.workItemId === fact.workItem.workItemId)) {
    return rejected(state, {
      code: "duplicate-work-item",
      workItemId: fact.workItem.workItemId,
    });
  }
  const entry: WorkItemState = Object.freeze({
    workItemId: fact.workItem.workItemId,
    workItem: fact.workItem,
    status: "declared",
    latestSubmissionId: null,
  });
  return applied(Object.freeze({
    ...state,
    workItems: sortedBy([...state.workItems, entry], (value) => value.workItemId),
  }));
}

function applySubmissionBound(state: RunState, fact: SubmissionBound): DomainFactFoldResult {
  const workItem = state.workItems.find((entry) => entry.workItemId === fact.workItemId);
  if (workItem === undefined) {
    return rejected(state, { code: "unknown-work-item", workItemId: fact.workItemId });
  }
  if (workItem.workItem.planRootId !== fact.planRootId) {
    return rejected(state, { code: "unknown-plan-root", planRootId: fact.planRootId });
  }
  if (state.submissions.some((entry) => entry.submissionId === fact.submissionId)) {
    return rejected(state, { code: "duplicate-submission", submissionId: fact.submissionId });
  }
  const binding: SubmissionBindingState = Object.freeze({
    submissionId: fact.submissionId,
    workItemId: fact.workItemId,
    attemptId: fact.attemptId,
    planRootId: fact.planRootId,
    inputRoot: fact.inputRoot,
    outputRoot: fact.outputRoot,
  });
  const workItems = Object.freeze(state.workItems.map((entry): WorkItemState => {
    if (entry.workItemId !== fact.workItemId) {
      return entry;
    }
    return Object.freeze({
      ...entry,
      status: "submission-bound",
      latestSubmissionId: fact.submissionId,
    });
  }));
  return applied(Object.freeze({
    ...state,
    workItems,
    submissions: sortedBy([...state.submissions, binding], (value) => value.submissionId),
  }));
}

function applyPlanRootAccepted(state: RunState, fact: PlanRootAccepted): DomainFactFoldResult {
  if (state.planRoots.some((entry) => entry.planRootId === fact.planRootId)) {
    return rejected(state, { code: "duplicate-plan-root", planRootId: fact.planRootId });
  }
  const planRoot: AcceptedPlanRootState = Object.freeze({
    planRootId: fact.planRootId,
    planRoot: fact.planRoot,
    coverageRoot: fact.coverageRoot,
  });
  return applied(Object.freeze({
    ...state,
    phase: "execution",
    planRoots: sortedBy([...state.planRoots, planRoot], (value) => value.planRootId),
    currentPlanRootId: fact.planRootId,
  }));
}

function applyPlanRootSuperseded(state: RunState, fact: PlanRootSuperseded): DomainFactFoldResult {
  if (!state.planRoots.some((entry) => entry.planRootId === fact.priorPlanRootId)) {
    return rejected(state, { code: "unknown-plan-root", planRootId: fact.priorPlanRootId });
  }
  if (
    fact.newPlanRootId === fact.priorPlanRootId
    || !state.planRoots.some((entry) => entry.planRootId === fact.newPlanRootId)
  ) {
    return rejected(state, { code: "unknown-plan-root", planRootId: fact.newPlanRootId });
  }
  if (state.supersededPlanRoots.some((entry) => entry.priorPlanRootId === fact.priorPlanRootId)) {
    return rejected(state, {
      code: "duplicate-plan-supersession",
      planRootId: fact.priorPlanRootId,
    });
  }
  const supersession: SupersededPlanRootState = Object.freeze({
    priorPlanRootId: fact.priorPlanRootId,
    newPlanRootId: fact.newPlanRootId,
    reason: fact.reason,
  });
  return applied(Object.freeze({
    ...state,
    currentPlanRootId: state.currentPlanRootId === fact.priorPlanRootId
      ? fact.newPlanRootId
      : state.currentPlanRootId,
    supersededPlanRoots: sortedBy(
      [...state.supersededPlanRoots, supersession],
      (value) => value.priorPlanRootId,
    ),
  }));
}

function sameCoverageIdentity(left: CoverageLinkState, right: CoverageLinked): boolean {
  return left.requirementId === right.requirementId
    && left.sourceAnchor === right.sourceAnchor
    && left.planRootId === right.planRootId
    && left.workItemId === right.workItemId;
}

function coverageKey(value: CoverageLinkState): string {
  return `${value.requirementId}\u0000${value.sourceAnchor}\u0000${value.planRootId}\u0000${value.workItemId}`;
}

function applyCoverageLinked(state: RunState, fact: CoverageLinked): DomainFactFoldResult {
  if (!state.workItems.some((entry) => entry.workItemId === fact.workItemId)) {
    return rejected(state, { code: "unknown-work-item", workItemId: fact.workItemId });
  }
  if (!state.planRoots.some((entry) => entry.planRootId === fact.planRootId)) {
    return rejected(state, { code: "unknown-plan-root", planRootId: fact.planRootId });
  }
  if (state.coverageLinks.some((entry) => sameCoverageIdentity(entry, fact))) {
    return rejected(state, { code: "duplicate-coverage-link" });
  }
  const workItem = state.workItems.find((entry) => entry.workItemId === fact.workItemId);
  if (workItem?.workItem.planRootId !== fact.planRootId) {
    return rejected(state, { code: "unknown-plan-root", planRootId: fact.planRootId });
  }
  const link: CoverageLinkState = Object.freeze({
    requirementId: fact.requirementId,
    sourceAnchor: fact.sourceAnchor,
    planRootId: fact.planRootId,
    workItemId: fact.workItemId,
    implementationRoot: fact.implementationRoot,
    evidence: fact.evidence,
  });
  return applied(Object.freeze({
    ...state,
    coverageLinks: sortedBy([...state.coverageLinks, link], coverageKey),
  }));
}

function applyFindingRaised(state: RunState, fact: FindingRaised): DomainFactFoldResult {
  const nestedMismatch = nestedRunMatches(state, fact.kind, fact.finding.runId);
  if (nestedMismatch !== null) {
    return nestedMismatch;
  }
  if (state.findings.some((entry) => entry.findingId === fact.finding.findingId)) {
    return rejected(state, { code: "duplicate-finding", findingId: fact.finding.findingId });
  }
  const finding: FindingState = Object.freeze({
    findingId: fact.finding.findingId,
    finding: fact.finding,
    status: "open",
    clearance: null,
  });
  return applied(Object.freeze({
    ...state,
    findings: sortedBy([...state.findings, finding], (value) => value.findingId),
  }));
}

function applyFindingCleared(state: RunState, fact: FindingCleared): DomainFactFoldResult {
  const existing = state.findings.find((entry) => entry.findingId === fact.findingId);
  if (existing === undefined) {
    return rejected(state, { code: "unknown-finding", findingId: fact.findingId });
  }
  if (existing.status === "cleared") {
    return rejected(state, { code: "finding-already-cleared", findingId: fact.findingId });
  }
  const findings = Object.freeze(state.findings.map((entry): FindingState => {
    if (entry.findingId !== fact.findingId) {
      return entry;
    }
    return Object.freeze({
      ...entry,
      status: "cleared",
      clearance: Object.freeze({
        correctedRoot: fact.correctedRoot,
        resolution: fact.resolution,
      }),
    });
  }));
  return applied(Object.freeze({ ...state, findings }));
}

function applyEvidenceObserved(state: RunState, fact: EvidenceObserved): DomainFactFoldResult {
  const envelope = fact.evidence.envelope;
  const nestedMismatch = nestedRunMatches(state, fact.kind, envelope.runId);
  if (nestedMismatch !== null) {
    return nestedMismatch;
  }
  if (!state.workItems.some((entry) => entry.workItemId === envelope.workItemId)) {
    return rejected(state, { code: "unknown-work-item", workItemId: envelope.workItemId });
  }
  if (state.evidenceRecords.some((entry) => entry.evidenceId === envelope.evidenceId)) {
    return rejected(state, { code: "duplicate-evidence", evidenceId: envelope.evidenceId });
  }
  const evidence: EvidenceRecordState = Object.freeze({
    evidenceId: envelope.evidenceId,
    evidence: fact.evidence,
  });
  return applied(Object.freeze({
    ...state,
    evidenceRecords: sortedBy(
      [...state.evidenceRecords, evidence],
      (value) => value.evidenceId,
    ),
  }));
}

function applyCandidateAccepted(state: RunState, fact: CandidateAccepted): DomainFactFoldResult {
  if (!state.planRoots.some((entry) => entry.planRootId === fact.planRootId)) {
    return rejected(state, { code: "unknown-plan-root", planRootId: fact.planRootId });
  }
  if (state.candidates.some((entry) => entry.candidateId === fact.candidateId)) {
    return rejected(state, { code: "duplicate-candidate", candidateId: fact.candidateId });
  }
  const candidate: CandidateState = Object.freeze({
    candidateId: fact.candidateId,
    planRootId: fact.planRootId,
    tree: fact.tree,
    manifest: fact.manifest,
  });
  return applied(Object.freeze({
    ...state,
    candidates: sortedBy([...state.candidates, candidate], (value) => value.candidateId),
    currentCandidateId: fact.candidateId,
  }));
}

function applyPublicationIntended(state: RunState, fact: PublicationIntended): DomainFactFoldResult {
  if (!state.candidates.some((entry) => entry.candidateId === fact.candidateId)) {
    return rejected(state, { code: "unknown-candidate", candidateId: fact.candidateId });
  }
  if (state.publications.some((entry) => entry.publicationId === fact.publicationId)) {
    return rejected(state, { code: "duplicate-publication", publicationId: fact.publicationId });
  }
  const publication: PublicationState = Object.freeze({
    publicationId: fact.publicationId,
    candidateId: fact.candidateId,
    expectedHead: fact.expectedHead,
    desiredHead: fact.desiredHead,
    observation: null,
  });
  return applied(Object.freeze({
    ...state,
    publications: sortedBy(
      [...state.publications, publication],
      (value) => value.publicationId,
    ),
    currentPublicationId: fact.publicationId,
  }));
}

function applyPublicationObserved(state: RunState, fact: PublicationObserved): DomainFactFoldResult {
  const existing = state.publications.find((entry) => entry.publicationId === fact.publicationId);
  if (existing === undefined) {
    return rejected(state, { code: "unknown-publication", publicationId: fact.publicationId });
  }
  if (existing.observation !== null) {
    return rejected(state, {
      code: "publication-already-observed",
      publicationId: fact.publicationId,
    });
  }
  if (
    (fact.status === "desired-head" && fact.observedHead !== existing.desiredHead)
    || (fact.status === "head-moved" && fact.observedHead === existing.desiredHead)
  ) {
    return rejected(state, { code: "unknown-publication", publicationId: fact.publicationId });
  }
  const publications = Object.freeze(state.publications.map((entry): PublicationState => {
    if (entry.publicationId !== fact.publicationId) {
      return entry;
    }
    return Object.freeze({
      ...entry,
      observation: Object.freeze({
        observedHead: fact.observedHead,
        status: fact.status,
      }),
    });
  }));
  return applied(Object.freeze({ ...state, publications }));
}

export const domainFactBookkeepingHandlers = Object.freeze({
  "candidate-accepted": applyCandidateAccepted,
  "coverage-linked": applyCoverageLinked,
  "evidence-observed": applyEvidenceObserved,
  "finding-cleared": applyFindingCleared,
  "finding-raised": applyFindingRaised,
  "plan-root-accepted": applyPlanRootAccepted,
  "plan-root-superseded": applyPlanRootSuperseded,
  "publication-intended": applyPublicationIntended,
  "publication-observed": applyPublicationObserved,
  "requirements-bound": applyRequirementsBound,
  "submission-bound": applySubmissionBound,
  "work-declared": applyWorkDeclared,
}) satisfies DomainFactHandlerMap;

function rejectUnknownDomainFact(state: RunState, fact: never): DomainFactFoldResult {
  void fact;
  return rejected(state, { code: "unknown-domain-fact-kind" });
}

export function foldDomainFact(state: RunState, fact: DomainFact): DomainFactFoldResult {
  if (fact.runId !== state.identity.runId) {
    return rejected(state, {
      code: "fact-run-mismatch",
      factKind: fact.kind,
      expectedRunId: state.identity.runId,
      actualRunId: fact.runId,
    });
  }
  switch (fact.kind) {
    case "candidate-accepted":
      return domainFactBookkeepingHandlers["candidate-accepted"](state, fact);
    case "coverage-linked":
      return domainFactBookkeepingHandlers["coverage-linked"](state, fact);
    case "evidence-observed":
      return domainFactBookkeepingHandlers["evidence-observed"](state, fact);
    case "finding-cleared":
      return domainFactBookkeepingHandlers["finding-cleared"](state, fact);
    case "finding-raised":
      return domainFactBookkeepingHandlers["finding-raised"](state, fact);
    case "plan-root-accepted":
      return domainFactBookkeepingHandlers["plan-root-accepted"](state, fact);
    case "plan-root-superseded":
      return domainFactBookkeepingHandlers["plan-root-superseded"](state, fact);
    case "publication-intended":
      return domainFactBookkeepingHandlers["publication-intended"](state, fact);
    case "publication-observed":
      return domainFactBookkeepingHandlers["publication-observed"](state, fact);
    case "requirements-bound":
      return domainFactBookkeepingHandlers["requirements-bound"](state, fact);
    case "submission-bound":
      return domainFactBookkeepingHandlers["submission-bound"](state, fact);
    case "work-declared":
      return domainFactBookkeepingHandlers["work-declared"](state, fact);
    default:
      return rejectUnknownDomainFact(state, fact);
  }
}
