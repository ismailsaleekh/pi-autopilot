import { indexValues } from "../model/authenticated-index.js";
import type { RunState } from "../model/run-state.js";
import type { Finding } from "../protocol/finding.capsule.js";
import type { FindingId, WorkItemId } from "../protocol/identifiers.js";
import type { FindingIndexValue, WorkIndexValue } from "../protocol/state-index.capsule.js";

export type CorrectionScope = "local" | "plan-wide" | "cross-lane";

export interface FindingOwner {
  readonly findingId: FindingId;
  readonly scope: CorrectionScope;
  readonly ownerWorkItemId: WorkItemId;
}

export type ReadyWorkResult =
  | { readonly kind: "ready"; readonly work: readonly WorkIndexValue[] }
  | { readonly kind: "unproven"; readonly diagnostic: string };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function completeWork(state: RunState): readonly WorkIndexValue[] | null {
  const values = indexValues(state.indexes.work, "work");
  return values === null
    ? null
    : Object.freeze(values.filter((value): value is WorkIndexValue => value.kind === "work"));
}

function completeFindings(state: RunState): readonly FindingIndexValue[] | null {
  const values = indexValues(state.indexes.findings, "finding");
  return values === null
    ? null
    : Object.freeze(values.filter((value): value is FindingIndexValue => value.kind === "finding"));
}

/** Deterministic frontier; incomplete authenticated pages are loud, never empty. */
export function readyWork(state: RunState): ReadyWorkResult {
  if (state.terminal !== null || state.suspension.kind === "suspended") {
    return Object.freeze({ kind: "ready", work: Object.freeze([]) });
  }
  const work = completeWork(state);
  const dependencies = indexValues(state.indexes.dependencies, "dependency");
  const findings = completeFindings(state);
  if (work === null || dependencies === null || findings === null) {
    return Object.freeze({
      kind: "unproven",
      diagnostic: "ready frontier requires complete bounded work, dependency, and finding pages",
    });
  }
  const workById = new Map<WorkItemId, WorkIndexValue>();
  for (const entry of work) {
    workById.set(entry.workItem.workItemId, entry);
  }
  const result: WorkIndexValue[] = [];
  for (const entry of work) {
    if (entry.acceptedOutput !== null) {
      continue;
    }
    if (state.phase === "execution" && entry.workItem.planRootId !== state.currentPlan?.planRootId) {
      continue;
    }
    const prerequisites = dependencies.filter((value) => value.kind === "dependency" && value.dependent === entry.workItem.workItemId);
    if (prerequisites.some((edge) => edge.kind === "dependency" && workById.get(edge.dependency)?.acceptedOutput === null)) {
      continue;
    }
    const item = entry.workItem;
    if (item.kind === "correct-artifact") {
      const finding = findings.find((value) => value.finding.findingId === item.findingId);
      if (finding?.status !== "open") {
        continue;
      }
    }
    if (entry.workItem.kind === "verify-candidate" && state.currentCandidate?.tree !== entry.workItem.candidateRoot) {
      continue;
    }
    result.push(entry);
  }
  result.sort((left, right) => compareText(left.workItem.workItemId, right.workItem.workItemId));
  return Object.freeze({ kind: "ready", work: Object.freeze(result) });
}

/** Owner selection is authority-derived solely from current plan and finding subject. */
export function ownerForFinding(state: RunState, finding: Finding): FindingOwner | null {
  if (finding.kind === "advisory") {
    return Object.freeze({
      findingId: finding.findingId,
      scope: "local",
      ownerWorkItemId: finding.raisedByWorkItemId,
    });
  }
  if (finding.kind === "planning-gap") {
    return state.currentPlan === null
      ? null
      : Object.freeze({
          findingId: finding.findingId,
          scope: "plan-wide",
          ownerWorkItemId: state.currentPlan.planAuthorWorkItemId,
        });
  }
  if (state.currentPlan === null) {
    return null;
  }
  return Object.freeze({
    findingId: finding.findingId,
    scope: finding.subjectWorkItemId === null ? "cross-lane" : "local",
    ownerWorkItemId: finding.subjectWorkItemId ?? state.currentPlan.integrationOwnerWorkItemId,
  });
}

export function ownersForFindings(state: RunState): readonly FindingOwner[] | null {
  const findings = completeFindings(state);
  if (findings === null) {
    return null;
  }
  const output: FindingOwner[] = [];
  for (const entry of findings) {
    const owner = ownerForFinding(state, entry.finding);
    if (owner !== null) {
      output.push(owner);
    }
  }
  output.sort((left, right) => compareText(left.findingId, right.findingId));
  return Object.freeze(output);
}
