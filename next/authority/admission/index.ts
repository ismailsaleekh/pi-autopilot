import type { RunState, WorkItemState } from "../model/run-state.js";
import { stateDigest } from "../model/run-state.js";
import { domainFactCapsule } from "../protocol/domain-fact.capsule.js";
import type { DomainFact, SubmissionBound } from "../protocol/domain-fact.capsule.js";
import { canonicalDigestUnknown as digestCanonicalValue } from "../protocol/schema.js";
import type {
  BoundaryRequestReceived,
  CommandObservationReceived,
  OperatorResumeRequested,
  OperatorSuspendRequested,
  RunReplayCompleted,
  SubmissionReady,
} from "../protocol/stimulus.capsule.js";
import type { WorkItem } from "../protocol/work-item.capsule.js";
import type { Feedback } from "../facade/feedback.js";
import type {
  AdmissionResult,
  AdmissionSeams,
  ProposedFacts,
} from "../facade/seams.js";

const EMPTY_FACTS: readonly DomainFact[] = Object.freeze([]);

function feedback(path: string, semanticCode: string, diagnostic: string): Feedback {
  return Object.freeze({
    kind: "feedback",
    code: "invalid-stimulus",
    schemaCode: "schema-mismatch",
    path,
    diagnostic: `${semanticCode}: ${diagnostic}`,
  });
}

function proposed(facts: readonly DomainFact[]): ProposedFacts {
  return Object.freeze({ kind: "proposed-facts", facts: Object.freeze(facts.slice()) });
}

function workValidationFailed(value: WorkItemState | Feedback): value is Feedback {
  return "kind" in value && value.kind === "feedback";
}

function consequenceFailed(
  value: readonly DomainFact[] | Feedback,
): value is Feedback {
  return !Array.isArray(value);
}

function universalRejection(
  state: RunState,
  stimulus: {
    readonly runId: SubmissionReady["runId"];
    readonly actionId: SubmissionReady["actionId"];
  },
): Feedback | null {
  if (stimulus.runId !== state.identity.runId) {
    return feedback(
      "$.runId",
      "run-mismatch",
      `stimulus run ${stimulus.runId} does not equal authoritative run ${state.identity.runId}`,
    );
  }
  if (state.terminal !== null) {
    return feedback(
      "$.actionId",
      "run-already-terminal",
      `run already committed ${state.terminal.outcome.kind}; no later semantic action is admissible`,
    );
  }
  if (state.actionCommits.some((entry) => entry.actionId === stimulus.actionId)) {
    return feedback(
      "$.actionId",
      "action-already-committed",
      `action ${stimulus.actionId} is already durable; replay must return its journaled result`,
    );
  }
  return null;
}

function unavailableBoundaryRequest(): Feedback {
  return feedback(
    "$.request",
    "opaque-boundary-request",
    "the frozen request carries only an ArtifactRef and digest, so authority cannot distinguish start-planning from an unknown command; provide a closed normalized request discriminant",
  );
}

export function admitBoundaryRequest(
  state: RunState,
  stimulus: BoundaryRequestReceived,
): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  return universal ?? unavailableBoundaryRequest();
}

function unavailableObservation(): Feedback {
  return feedback(
    "$.observation",
    "opaque-command-observation",
    "the frozen observation carries only an ArtifactRef and digest, so authority cannot prove workspace, child, evidence, candidate, validation, or publication semantics; provide a closed normalized observation",
  );
}

export function admitCommandObservation(
  state: RunState,
  stimulus: CommandObservationReceived,
): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  return universal ?? unavailableObservation();
}

export function admitRunReplayCompleted(
  state: RunState,
  stimulus: RunReplayCompleted,
): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  if (universal !== null) {
    return universal;
  }
  if (stimulus.lastSequence !== state.lastSequence) {
    return feedback(
      "$.lastSequence",
      "replay-sequence-mismatch",
      `replay reports ${String(stimulus.lastSequence)} but authoritative state ends at ${String(state.lastSequence)}`,
    );
  }
  const expectedDigest = stateDigest(state);
  if (stimulus.stateDigest !== expectedDigest) {
    return feedback(
      "$.stateDigest",
      "replay-state-digest-mismatch",
      `replay digest ${stimulus.stateDigest} does not equal authoritative digest ${expectedDigest}`,
    );
  }
  return proposed(EMPTY_FACTS);
}

export function admitOperatorSuspend(
  state: RunState,
  stimulus: OperatorSuspendRequested,
): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  if (universal !== null) {
    return universal;
  }
  if (state.suspension.kind === "suspended") {
    return feedback(
      "$.operatorRequestId",
      "already-suspended",
      `run is already suspended by ${state.suspension.operatorRequestId}`,
    );
  }
  return feedback(
    "$.kind",
    "lifecycle-record-unrepresentable",
    "AdmissionResult can propose only DomainFact values and AcceptedBatch cannot select run-suspended; the lifecycle journal action requires a frozen-seam amendment",
  );
}

export function admitOperatorResume(
  state: RunState,
  stimulus: OperatorResumeRequested,
): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  if (universal !== null) {
    return universal;
  }
  if (state.suspension.kind !== "suspended") {
    return feedback("$.kind", "not-suspended", "an active run cannot be resumed");
  }
  if (stimulus.operatorRequestId !== state.suspension.operatorRequestId) {
    return feedback(
      "$.operatorRequestId",
      "resume-request-mismatch",
      `resume request ${stimulus.operatorRequestId} does not match suspension request ${state.suspension.operatorRequestId}`,
    );
  }
  if (stimulus.resumeFromSequence !== state.suspension.sequence) {
    return feedback(
      "$.resumeFromSequence",
      "resume-sequence-mismatch",
      `resume sequence ${String(stimulus.resumeFromSequence)} does not match suspension sequence ${String(state.suspension.sequence)}`,
    );
  }
  return feedback(
    "$.kind",
    "lifecycle-record-unrepresentable",
    "AdmissionResult can propose only DomainFact values and AcceptedBatch cannot select run-resumed; the lifecycle journal action requires a frozen-seam amendment",
  );
}

function submissionIdText(stimulus: SubmissionReady): string {
  const digest = digestCanonicalValue(Object.freeze({
    attemptId: stimulus.attemptId,
    domain: "pi-autopilot.submission.v1",
    inputRoot: stimulus.inputRoot,
    outputRoot: stimulus.outputRoot,
    planRootId: stimulus.planRootId,
    runId: stimulus.runId,
    workItemId: stimulus.workItemId,
  }));
  return `submission:sha256:${digest.slice(7)}`;
}

function decodeSubmissionFact(
  stimulus: SubmissionReady,
): SubmissionBound | Feedback {
  const decoded = domainFactCapsule.decode(Object.freeze({
    attemptId: stimulus.attemptId,
    inputRoot: stimulus.inputRoot,
    kind: "submission-bound",
    outputRoot: stimulus.outputRoot,
    planRootId: stimulus.planRootId,
    runId: stimulus.runId,
    submissionId: submissionIdText(stimulus),
    workItemId: stimulus.workItemId,
  }));
  if (decoded.kind === "error" || decoded.value.kind !== "submission-bound") {
    const diagnostic = decoded.kind === "error"
      ? decoded.error.diagnostic
      : "decoded fact has the wrong closed-union kind";
    return feedback(
      "$.outputRoot",
      "submission-identity-unrepresentable",
      `deterministic submission binding could not be represented: ${diagnostic}`,
    );
  }
  return decoded.value;
}

function baseSubmissionFacts(
  stimulus: SubmissionReady,
): readonly DomainFact[] | Feedback {
  const binding = decodeSubmissionFact(stimulus);
  if (binding.kind === "feedback") {
    return binding;
  }
  return Object.freeze([binding]);
}

type WorkOfKind<Kind extends WorkItem["kind"]> = Extract<WorkItem, { readonly kind: Kind }>;
type SubmissionConsequenceHandlers = {
  readonly [Kind in WorkItem["kind"]]: (
    stimulus: SubmissionReady,
    work: WorkOfKind<Kind>,
  ) => readonly DomainFact[] | Feedback;
};

function bindProduceSubmission(
  stimulus: SubmissionReady,
  _work: WorkOfKind<"produce-artifact">,
): readonly DomainFact[] | Feedback {
  return baseSubmissionFacts(stimulus);
}

function bindReviewSubmission(
  stimulus: SubmissionReady,
  _work: WorkOfKind<"review-artifact">,
): readonly DomainFact[] | Feedback {
  return baseSubmissionFacts(stimulus);
}

function bindCorrectionSubmission(
  stimulus: SubmissionReady,
  _work: WorkOfKind<"correct-artifact">,
): readonly DomainFact[] | Feedback {
  return baseSubmissionFacts(stimulus);
}

function bindIntegrationSubmission(
  stimulus: SubmissionReady,
  _work: WorkOfKind<"integrate-candidate">,
): readonly DomainFact[] | Feedback {
  return baseSubmissionFacts(stimulus);
}

function bindVerificationSubmission(
  stimulus: SubmissionReady,
  _work: WorkOfKind<"verify-candidate">,
): readonly DomainFact[] | Feedback {
  return baseSubmissionFacts(stimulus);
}

const consequenceHandlers = Object.freeze({
  "correct-artifact": bindCorrectionSubmission,
  "integrate-candidate": bindIntegrationSubmission,
  "produce-artifact": bindProduceSubmission,
  "review-artifact": bindReviewSubmission,
  "verify-candidate": bindVerificationSubmission,
}) satisfies SubmissionConsequenceHandlers;

function consequencesFor(
  stimulus: SubmissionReady,
  work: WorkItem,
): readonly DomainFact[] | Feedback {
  switch (work.kind) {
    case "correct-artifact":
      return consequenceHandlers["correct-artifact"](stimulus, work);
    case "integrate-candidate":
      return consequenceHandlers["integrate-candidate"](stimulus, work);
    case "produce-artifact":
      return consequenceHandlers["produce-artifact"](stimulus, work);
    case "review-artifact":
      return consequenceHandlers["review-artifact"](stimulus, work);
    case "verify-candidate":
      return consequenceHandlers["verify-candidate"](stimulus, work);
  }
}

function validateSubmission(
  state: RunState,
  stimulus: SubmissionReady,
): WorkItemState | Feedback {
  const work = state.workItems.find((entry) => entry.workItemId === stimulus.workItemId);
  if (work === undefined) {
    return feedback(
      "$.workItemId",
      "unknown-work-item",
      `work item ${stimulus.workItemId} is not declared in this run`,
    );
  }
  if (work.status !== "declared") {
    return feedback(
      "$.workItemId",
      "work-item-not-accepting",
      `work item ${stimulus.workItemId} already has an accepted sealed submission`,
    );
  }
  if (stimulus.planRootId !== work.workItem.planRootId) {
    return feedback(
      "$.planRootId",
      "plan-root-mismatch",
      `submission plan ${stimulus.planRootId} does not equal issued plan ${work.workItem.planRootId}`,
    );
  }
  const supersession = state.supersededPlanRoots.find(
    (entry) => entry.priorPlanRootId === work.workItem.planRootId,
  );
  if (supersession !== undefined) {
    return feedback(
      "$.planRootId",
      "superseded-plan-root",
      `work item base ${work.workItem.planRootId} is superseded by ${supersession.newPlanRootId}; request newly issued work`,
    );
  }
  if (
    state.currentPlanRootId !== null
    && work.workItem.planRootId !== state.currentPlanRootId
  ) {
    return feedback(
      "$.planRootId",
      "superseded-plan-root",
      `work item base ${work.workItem.planRootId} is not current; request work issued against ${state.currentPlanRootId}`,
    );
  }
  if (stimulus.inputRoot !== work.workItem.inputRoot) {
    return feedback(
      "$.inputRoot",
      "stale-input-root",
      `submission input ${stimulus.inputRoot} is stale; work item ${stimulus.workItemId} was issued against ${work.workItem.inputRoot}`,
    );
  }
  return work;
}

export function admitSubmissionReady(
  state: RunState,
  stimulus: SubmissionReady,
): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  if (universal !== null) {
    return universal;
  }
  const validated = validateSubmission(state, stimulus);
  if (workValidationFailed(validated)) {
    return validated;
  }
  const facts = consequencesFor(stimulus, validated.workItem);
  if (consequenceFailed(facts)) {
    return facts;
  }
  return proposed(facts);
}

export { assembleSemanticBatch } from "./batch-assembly.js";

export const admissionSeams = Object.freeze({
  "boundary-request-received": admitBoundaryRequest,
  "command-observation-received": admitCommandObservation,
  "operator-resume-requested": admitOperatorResume,
  "operator-suspend-requested": admitOperatorSuspend,
  "run-replay-completed": admitRunReplayCompleted,
  "submission-ready": admitSubmissionReady,
}) satisfies AdmissionSeams;
