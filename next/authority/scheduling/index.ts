import type {
  FindingState,
  RunState,
  WorkItemState,
} from "../model/run-state.js";
import type { Finding } from "../protocol/finding.capsule.js";
import type { ArtifactRoot, WorkItemId } from "../protocol/identifiers.js";

export type CorrectionScope = "local" | "plan-wide" | "cross-lane";

export interface FindingOwner {
  readonly findingId: Finding["findingId"];
  readonly scope: CorrectionScope;
  readonly ownerWorkItemId: WorkItemId;
}

type FindingOfKind<Kind extends Finding["kind"]> = Extract<Finding, { readonly kind: Kind }>;
type OwnerHandlerMap = {
  readonly [Kind in Finding["kind"]]: (
    state: RunState,
    finding: FindingOfKind<Kind>,
  ) => FindingOwner;
};

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function activePlanWork(state: RunState): readonly WorkItemState[] {
  if (state.phase === "planning") {
    return Object.freeze(state.workItems.filter((entry) => !state.supersededPlanRoots.some(
      (supersession) => supersession.priorPlanRootId === entry.workItem.planRootId,
    )));
  }
  if (
    state.currentPlanRootId === null
    || state.supersededPlanRoots.some(
      (supersession) => supersession.priorPlanRootId === state.currentPlanRootId,
    )
  ) {
    return Object.freeze([]);
  }
  return Object.freeze(state.workItems.filter(
    (entry) => (
      entry.workItem.planRootId === state.currentPlanRootId
      && !state.supersededPlanRoots.some(
        (supersession) => supersession.priorPlanRootId === entry.workItem.planRootId,
      )
    ),
  ));
}

function priorWorkClosed(active: readonly WorkItemState[]): boolean {
  return active.every((entry) => (
    entry.workItem.kind === "integrate-candidate"
    || entry.workItem.kind === "verify-candidate"
    || entry.status === "submission-bound"
  ));
}

function integrationsClosed(active: readonly WorkItemState[]): boolean {
  const integrations = active.filter((entry) => entry.workItem.kind === "integrate-candidate");
  return integrations.length === 0 || integrations.every((entry) => entry.status === "submission-bound");
}

function workReady(
  state: RunState,
  active: readonly WorkItemState[],
  entry: WorkItemState,
): boolean {
  if (entry.status !== "declared") {
    return false;
  }
  switch (entry.workItem.kind) {
    case "produce-artifact":
    case "review-artifact":
      return true;
    case "correct-artifact": {
      const findingId = entry.workItem.findingId;
      const finding = state.findings.find(
        (findingEntry) => findingEntry.findingId === findingId,
      );
      return finding !== undefined && finding.status === "open";
    }
    case "integrate-candidate":
      return priorWorkClosed(active);
    case "verify-candidate": {
      if (!integrationsClosed(active)) {
        return false;
      }
      const candidate = state.candidates.find(
        (candidateEntry) => candidateEntry.candidateId === state.currentCandidateId,
      );
      return candidate !== undefined
        && candidate.planRootId === entry.workItem.planRootId
        && candidate.tree === entry.workItem.candidateRoot;
    }
  }
}

/**
 * Return the deterministic ready frontier. Tie-break is locale-independent
 * ascending WorkItemId. The frozen WorkItem contract has no dependency edges;
 * declaration is therefore the only dependency-ready signal available, with
 * explicit integration and verification barriers derived from current facts.
 */
export function readyWork(state: RunState): readonly WorkItemState[] {
  if (state.terminal !== null || state.suspension.kind === "suspended") {
    return Object.freeze([]);
  }
  const active = activePlanWork(state);
  return Object.freeze(
    active
      .filter((entry) => workReady(state, active, entry))
      .slice()
      .sort((left, right) => compareText(left.workItemId, right.workItemId)),
  );
}

function submissionsForRoot(state: RunState, root: ArtifactRoot): readonly WorkItemId[] {
  const active = activePlanWork(state);
  return Object.freeze(
    state.submissions
      .filter((submission) => (
        submission.outputRoot === root
        && active.some((entry) => entry.workItemId === submission.workItemId)
      ))
      .map((submission) => submission.workItemId)
      .sort(compareText),
  );
}

function integratedOwner(state: RunState, fallback: WorkItemId): WorkItemId {
  const candidates = activePlanWork(state)
    .filter((entry) => entry.workItem.kind === "integrate-candidate")
    .slice()
    .sort((left, right) => compareText(left.workItemId, right.workItemId));
  return candidates[0]?.workItemId ?? fallback;
}

function subjectScope(
  state: RunState,
  subjectRoot: ArtifactRoot,
  fallback: WorkItemId,
): FindingOwner["scope"] {
  const currentPlan = state.planRoots.find((entry) => entry.planRootId === state.currentPlanRootId);
  if (currentPlan?.planRoot === subjectRoot) {
    return "plan-wide";
  }
  const currentCandidate = state.candidates.find(
    (entry) => entry.candidateId === state.currentCandidateId,
  );
  if (currentCandidate?.tree === subjectRoot) {
    return "cross-lane";
  }
  const localOwners = submissionsForRoot(state, subjectRoot);
  return localOwners.includes(fallback) || localOwners.length > 0 ? "local" : "cross-lane";
}

function ownerForPlanningGap(
  _state: RunState,
  finding: FindingOfKind<"planning-gap">,
): FindingOwner {
  return Object.freeze({
    findingId: finding.findingId,
    scope: "plan-wide",
    ownerWorkItemId: finding.planAuthorWorkItemId,
  });
}

function ownerForIntegrity(
  state: RunState,
  finding: FindingOfKind<"integrity">,
): FindingOwner {
  const scope = subjectScope(state, finding.subjectRoot, finding.correctionOwner);
  const localOwners = submissionsForRoot(state, finding.subjectRoot);
  const localOwner = localOwners[0] ?? finding.correctionOwner;
  return Object.freeze({
    findingId: finding.findingId,
    scope,
    ownerWorkItemId: scope === "cross-lane"
      ? integratedOwner(state, finding.correctionOwner)
      : scope === "local"
        ? localOwner
        : finding.correctionOwner,
  });
}

function ownerForDefinitionOfDone(
  state: RunState,
  finding: FindingOfKind<"definition-of-done">,
): FindingOwner {
  const scope = subjectScope(state, finding.subjectRoot, finding.correctionOwner);
  const localOwners = submissionsForRoot(state, finding.subjectRoot);
  const localOwner = localOwners[0] ?? finding.correctionOwner;
  return Object.freeze({
    findingId: finding.findingId,
    scope,
    ownerWorkItemId: scope === "cross-lane"
      ? integratedOwner(state, finding.correctionOwner)
      : scope === "local"
        ? localOwner
        : finding.correctionOwner,
  });
}

function ownerForAdvisory(
  state: RunState,
  finding: FindingOfKind<"advisory">,
): FindingOwner {
  const scope = subjectScope(state, finding.subjectRoot, finding.raisedByWorkItemId);
  const localOwners = submissionsForRoot(state, finding.subjectRoot);
  const localOwner = localOwners[0] ?? finding.raisedByWorkItemId;
  return Object.freeze({
    findingId: finding.findingId,
    scope,
    ownerWorkItemId: scope === "cross-lane"
      ? integratedOwner(state, finding.raisedByWorkItemId)
      : localOwner,
  });
}

const ownerHandlers = Object.freeze({
  advisory: ownerForAdvisory,
  "definition-of-done": ownerForDefinitionOfDone,
  integrity: ownerForIntegrity,
  "planning-gap": ownerForPlanningGap,
}) satisfies OwnerHandlerMap;

/** Every closed Finding variant maps to exactly one stable correction owner. */
export function ownerForFinding(state: RunState, finding: Finding): FindingOwner {
  switch (finding.kind) {
    case "advisory":
      return ownerHandlers.advisory(state, finding);
    case "definition-of-done":
      return ownerHandlers["definition-of-done"](state, finding);
    case "integrity":
      return ownerHandlers.integrity(state, finding);
    case "planning-gap":
      return ownerHandlers["planning-gap"](state, finding);
  }
}

/** Convenience query over journal-derived finding state, preserving key order. */
export function ownersForFindings(state: RunState): readonly FindingOwner[] {
  return Object.freeze(state.findings.map((entry: FindingState) => (
    ownerForFinding(state, entry.finding)
  )));
}
