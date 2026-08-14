import { stateDigest } from "../model/run-state.js";
import { commandIdentity } from "../protocol/command.capsule.js";
import type { Command } from "../protocol/command.capsule.js";
import { evidenceEnvelopeDigest } from "../protocol/evidence-fact.capsule.js";
import type { RunState } from "../model/run-state.js";
import { indexKey, lookupIndex } from "../model/authenticated-index.js";
import { domainFactCapsule } from "../protocol/domain-fact.capsule.js";
import { subscriptionRoutesEqual } from "../protocol/route.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import { findingCapsule } from "../protocol/finding.capsule.js";
import type { Finding } from "../protocol/finding.capsule.js";
import { artifactRefsEqual, incrementDecimalNatural, zeroDecimalNatural } from "../protocol/identifiers.js";
import type { ArtifactRoot, WorkItemId } from "../protocol/identifiers.js";
import type {
  BoundaryRequestReceived,
  CommandObservationPayload,
  CommandObservationReceived,
  OperatorResumeRequested,
  OperatorSuspendRequested,
  RunReplayCompleted,
  SubmissionReady,
} from "../protocol/stimulus.capsule.js";
import type { IndexValue } from "../protocol/state-index.capsule.js";
import { workItemCapsule } from "../protocol/work-item.capsule.js";
import type { Feedback } from "../facade/feedback.js";
import { semanticFeedback } from "../facade/feedback.js";
import type { AdmissionResult, AdmissionSeams, ProposedFacts } from "../facade/seams.js";

const EMPTY_FACTS: readonly DomainFact[] = Object.freeze([]);

function proposed(facts: readonly DomainFact[]): ProposedFacts {
  return Object.freeze({ kind: "proposed-facts", facts: Object.freeze(facts.slice()) });
}

function fact(input: unknown): DomainFact | Feedback {
  const encoded = domainFactCapsule.encodeUnknown(input);
  if (encoded.kind === "error") {
    return semanticFeedback("invalid-domain-transition", encoded.error.path, encoded.error.diagnostic);
  }
  const decoded = domainFactCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok"
    ? decoded.value
    : semanticFeedback("invalid-domain-transition", decoded.error.path, decoded.error.diagnostic);
}

function isFeedback(value: DomainFact | Feedback): value is Feedback {
  return value.kind === "feedback";
}

function universalRejection(
  state: RunState,
  stimulus: { readonly runId: SubmissionReady["runId"]; readonly actionId: SubmissionReady["actionId"]; readonly pages: SubmissionReady["pages"] },
): Feedback | null {
  if (stimulus.runId !== state.identity.runId) {
    return semanticFeedback("run-mismatch", "$.runId", "stimulus does not name the authoritative run");
  }
  if (state.terminal !== null) {
    return semanticFeedback("run-already-terminal", "$.actionId", "no semantic action is admissible after T1/T2");
  }
  const action = lookupIndex(state.indexes.actions, indexKey("actions", stimulus.actionId), stimulus.pages);
  if (action.kind !== "proved") {
    return semanticFeedback("page-unproven", "$.pages", action.diagnostic);
  }
  if (action.value !== null) {
    return semanticFeedback("action-already-committed", "$.actionId", "return the durable original result for this action identity");
  }
  return null;
}

function requestFacts(stimulus: BoundaryRequestReceived): AdmissionResult {
  const payload = stimulus.requestPayload;
  let candidate: DomainFact | Feedback;
  switch (payload.kind) {
    case "bind-requirements-v2":
      candidate = fact(Object.freeze({
        kind: "requirements-bound",
        runId: stimulus.runId,
        sourceRoot: payload.sourceRoot,
        requirementsRoot: payload.requirementsRoot,
        taskRoot: payload.taskRoot,
        atomIndexRoot: payload.atomIndexRoot,
        atomInventorySealed: false,
        declaredAtomCount: payload.declaredAtomCount,
      }));
      break;
    case "declare-atom-v2":
      candidate = fact(Object.freeze({ kind: "atom-declared", runId: stimulus.runId, atom: payload.atom }));
      break;
    case "seal-atom-inventory-v2":
      candidate = fact(Object.freeze({
        kind: "atom-inventory-sealed",
        runId: stimulus.runId,
        atomCount: payload.atomCount,
        atomIndexRoot: payload.atomIndexRoot,
        inventoryEvidence: payload.inventoryEvidence,
      }));
      break;
    case "declare-work-v2":
      candidate = fact(Object.freeze({ kind: "work-declared", runId: stimulus.runId, workItem: payload.workItem }));
      break;
    case "declare-dependency-v2":
      candidate = fact(Object.freeze({
        kind: "dependency-declared",
        runId: stimulus.runId,
        dependency: payload.dependency,
        dependent: payload.dependent,
        planRootId: payload.planRootId,
      }));
      break;
    case "intend-publication-v2":
      candidate = fact(Object.freeze({
        kind: "publication-intended",
        runId: stimulus.runId,
        candidateId: payload.candidateId,
        desiredHead: payload.desiredHead,
        expected: payload.expected,
        publicationId: payload.publicationId,
        publicationRef: payload.publicationRef,
        repository: payload.repository,
      }));
      break;
  }
  return isFeedback(candidate) ? candidate : proposed(Object.freeze([candidate]));
}

export function admitBoundaryRequest(state: RunState, stimulus: BoundaryRequestReceived): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  return universal ?? requestFacts(stimulus);
}

function workValue(state: RunState, stimulus: SubmissionReady): IndexValue | Feedback {
  const found = lookupIndex(state.indexes.work, indexKey("work", stimulus.workItemId), stimulus.pages);
  if (found.kind !== "proved") {
    return semanticFeedback("page-unproven", "$.pages", found.diagnostic);
  }
  if (found.value === null || found.value.kind !== "work") {
    return semanticFeedback("work-item-not-accepting", "$.workItemId", "work item is not declared");
  }
  if (found.value.workItem.planRootId !== stimulus.planRootId) {
    return semanticFeedback("superseded-plan-root", "$.planRootId", "submission does not bind its issued plan root");
  }
  if (found.value.workItem.inputRoot !== stimulus.inputRoot) {
    return semanticFeedback("stale-input-root", "$.inputRoot", "submission input does not equal the immutable issued input");
  }
  if (found.value.acceptedOutput !== null) {
    return semanticFeedback("work-item-not-accepting", "$.workItemId", "work item already has an accepted output");
  }
  return found.value;
}

function isFeedbackValue(value: IndexValue | Feedback): value is Feedback {
  return value.kind === "feedback";
}

function derivedFindingId(stimulus: CommandObservationReceived, suffix: string): string {
  return `finding:${suffix}:${stimulus.observationDigest.slice(7)}`;
}

function decodedFinding(input: unknown): Finding | Feedback {
  const encoded = findingCapsule.encodeUnknown(input);
  if (encoded.kind === "error") {
    return semanticFeedback("finding-invalid", encoded.error.path, encoded.error.diagnostic);
  }
  const decoded = findingCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok"
    ? decoded.value
    : semanticFeedback("finding-invalid", decoded.error.path, decoded.error.diagnostic);
}

function isFindingFeedback(value: Finding | Feedback): value is Feedback {
  return value.kind === "feedback";
}

function correctionFact(
  state: RunState,
  stimulus: SubmissionReady | CommandObservationReceived,
  finding: Finding,
): DomainFact | Feedback {
  if (finding.kind === "planning-gap" && state.phase !== "planning") {
    return semanticFeedback("finding-invalid", "$.finding.kind", "planning gaps are terminal planning-phase rulings and cannot poison execution");
  }
  if (finding.kind === "planning-gap" || finding.kind === "advisory") {
    return fact(Object.freeze({
      kind: "finding-accepted",
      runId: state.identity.runId,
      acceptance: Object.freeze({ kind: "nonblocking", finding }),
    }));
  }
  const plan = state.currentPlan;
  if (plan === null) {
    return semanticFeedback("corrector-unavailable", "$.finding", "blocking finding has no current plan authority");
  }
  let scope: "local" | "plan-wide" | "cross-lane";
  let ownerId: WorkItemId;
  if (finding.subjectWorkItemId !== null) {
    scope = "local";
    ownerId = finding.subjectWorkItemId;
  } else if (finding.subjectRoot === plan.planRoot) {
    scope = "plan-wide";
    ownerId = plan.planAuthorWorkItemId;
  } else {
    scope = "cross-lane";
    ownerId = plan.integrationOwnerWorkItemId;
  }
  const owner = lookupIndex(state.indexes.work, indexKey("work", ownerId), stimulus.pages);
  if (owner.kind !== "proved") {
    return semanticFeedback("page-unproven", "$.pages", owner.diagnostic);
  }
  if (owner.value === null || owner.value.kind !== "work") {
    return semanticFeedback("corrector-unavailable", "$.finding", "authority-derived corrector is not current declared work");
  }
  const digestSuffix = stimulus.actionId.slice("action:sha256:".length);
  const correctionWorkId = `work:correction:${digestSuffix}`;
  const assignmentId = `assignment:${digestSuffix}`;
  const integratedInput: ArtifactRoot = state.currentCandidate?.tree ?? finding.subjectRoot;
  const decodedWork = workItemCapsule.encodeUnknown(Object.freeze({
    assignmentId,
    dependencyCount: zeroDecimalNatural(),
    dependencyRoot: state.indexes.dependencies.root,
    findingId: finding.findingId,
    inputRoot: integratedInput,
    integratedInput,
    kind: "correct-artifact",
    originalOwnerWorkItemId: ownerId,
    planRootId: plan.planRootId,
    priorOutputRoot: finding.subjectRoot,
    prompt: finding.report,
    roleId: owner.value.workItem.roleId,
    ruleInputs: finding.report,
    runId: state.identity.runId,
    scope,
    subjectRoot: finding.subjectRoot,
    taskRoot: state.identity.taskSnapshot,
    topologicalRank: incrementDecimalNatural(owner.value.workItem.topologicalRank),
    workItemId: correctionWorkId,
    workspaceCapability: owner.value.workItem.workspaceCapability,
    workspaceId: owner.value.workItem.workspaceId,
  }));
  if (decodedWork.kind === "error") {
    return semanticFeedback("corrector-unavailable", decodedWork.error.path, decodedWork.error.diagnostic);
  }
  const work = workItemCapsule.decodeCanonical(decodedWork.value);
  if (work.kind === "error" || work.value.kind !== "correct-artifact") {
    return semanticFeedback("corrector-unavailable", "$.finding", "correction work could not be normalized");
  }
  return fact(Object.freeze({
    kind: "finding-accepted",
    runId: state.identity.runId,
    acceptance: Object.freeze({
      kind: "blocking-with-correction",
      finding,
      correction: Object.freeze({
        assignmentId,
        correctorWorkItemId: work.value.workItemId,
        originalOwnerWorkItemId: ownerId,
        scope,
        work: work.value,
      }),
    }),
  }));
}

function submissionFacts(state: RunState, stimulus: SubmissionReady): AdmissionResult {
  const work = workValue(state, stimulus);
  if (isFeedbackValue(work)) {
    return work;
  }
  const payload = stimulus.submissionPayload;
  let candidate: DomainFact | Feedback;
  switch (payload.kind) {
    case "accept-plan-v2":
      candidate = fact(Object.freeze({
        kind: "plan-root-accepted",
        runId: stimulus.runId,
        planRootId: stimulus.planRootId,
        planRoot: payload.planRoot,
        coverageRoot: payload.coverageRoot,
        reviewedPlan: payload.reviewedPlan,
        planAuthorWorkItemId: payload.planAuthorWorkItemId,
        integrationOwnerWorkItemId: payload.integrationOwnerWorkItemId,
      }));
      break;
    case "disposition-atom-v2":
      candidate = fact(Object.freeze({ kind: "atom-dispositioned", runId: stimulus.runId, disposition: payload.disposition }));
      break;
    case "accept-work-output-v2":
      candidate = fact(Object.freeze({
        kind: "work-output-accepted",
        runId: stimulus.runId,
        submissionId: payload.submissionId,
        workItemId: stimulus.workItemId,
        planRootId: stimulus.planRootId,
        inputRoot: stimulus.inputRoot,
        outputRoot: stimulus.outputRoot,
        accountedDiff: payload.accountedDiff,
        evidence: payload.evidence,
      }));
      break;
    case "accept-finding-v2":
      candidate = correctionFact(state, stimulus, payload.finding);
      break;
    case "clear-finding-v2":
      candidate = fact(Object.freeze({
        kind: "finding-cleared",
        runId: stimulus.runId,
        findingId: payload.findingId,
        correctedRoot: payload.correctedRoot,
        resolution: payload.resolution,
        evidence: payload.evidence,
      }));
      break;
    case "accept-evidence-v2":
      candidate = semanticFeedback("evidence-invalid", "$.submissionPayload", "semantic evidence must arrive through settlement of its issued dispatcher command");
      break;
    case "accept-candidate-v2":
      if (
        payload.gitTreeCasAttestation.gitTree !== payload.gitTree
        || payload.gitTreeCasAttestation.artifactRoot !== payload.tree
      ) {
        return semanticFeedback("invalid-domain-transition", "$.submissionPayload.gitTreeCasAttestation", "candidate Git/CAS attestation must bind the exact separate Git tree and CAS root");
      }
      candidate = fact(Object.freeze({
        kind: "candidate-accepted",
        runId: stimulus.runId,
        planRootId: stimulus.planRootId,
        candidateId: payload.candidateId,
        tree: payload.tree,
        gitRevision: payload.gitRevision,
        gitTree: payload.gitTree,
        manifest: payload.manifest,
        reviewedDiff: payload.reviewedDiff,
        gitTreeCasAttestation: payload.gitTreeCasAttestation,
      }));
      break;
    case "record-final-attestations-v2":
      candidate = fact(Object.freeze({
        kind: "final-attestations-recorded",
        runId: stimulus.runId,
        candidateId: payload.candidateId,
        publicationId: payload.publicationId,
        c1ToC7Proof: payload.c1ToC7Proof,
        finalManifest: payload.finalManifest,
        evidenceIndexRoot: payload.evidenceIndexRoot,
        finalVerificationEvidence: payload.finalVerificationEvidence,
        advisoryDisclosures: payload.advisoryDisclosures,
      }));
      break;
  }
  return isFeedback(candidate) ? candidate : proposed(Object.freeze([candidate]));
}

export function admitSubmissionReady(state: RunState, stimulus: SubmissionReady): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  return universal ?? submissionFacts(state, stimulus);
}

function issuedObservationCommand(state: RunState, stimulus: CommandObservationReceived): Command | Feedback {
  const found = lookupIndex(state.indexes.commands, indexKey("commands", stimulus.commandId), stimulus.pages);
  if (found.kind !== "proved") return semanticFeedback("page-unproven", "$.pages", found.diagnostic);
  if (found.value === null || found.value.kind !== "command" || found.value.status !== "issued") return semanticFeedback("command-not-issued", "$.commandId", "observation must name one proved issued command");
  const command = found.value.command;
  if (command.actionId !== stimulus.actionId || command.commandId !== stimulus.commandId || command.commandId !== commandIdentity(command.kind, command.actionId)) {
    return semanticFeedback("command-not-issued", "$.actionId", "observation action and command identities must equal the issued command");
  }
  return command;
}

function evidencePayloadMatches(command: Extract<Command, { readonly kind: "execute-evidence" }>, payload: Extract<CommandObservationPayload, { readonly kind: "evidence-observed-v2" }>): boolean {
  const evidence = payload.evidence;
  const envelope = evidence.envelope;
  return evidence.envelopeDigest === evidenceEnvelopeDigest(envelope)
    && envelope.actionId === command.actionId
    && envelope.attemptId === command.attemptId
    && envelope.acceptedOutput === command.candidateTree
    && envelope.class === command.evidenceClass
    && artifactRefsEqual(envelope.command, command.commandSpec)
    && envelope.cwd === command.cwd
    && artifactRefsEqual(envelope.environment, command.environment)
    && envelope.kindId === command.kindId
    && envelope.obligationId === `evidence-obligation:${command.commandId}`
    && envelope.ruleId === command.ruleId
    && envelope.runId === command.runId
    && envelope.tree === command.candidateTree
    && envelope.workItemId === command.workItemId;
}

function commandPayloadMatches(command: Command, payload: CommandObservationPayload): boolean {
  if (payload.kind === "command-retry-v2") return false;
  switch (command.kind) {
    case "prepare-workspace":
      return payload.kind === "workspace-reserved-v2"
        && payload.leaseId === command.leaseId
        && payload.workspaceCapability === command.workspaceCapability
        && payload.workspaceId === command.workspaceId;
    case "apply-workspace-isolation":
      return payload.kind === "command-observed-v2";
    case "materialize-workspace":
      return payload.kind === "workspace-materialized-v2"
        && payload.gitTree === command.baseTree
        && payload.workspaceCapability === command.workspaceCapability
        && payload.workspaceId === command.workspaceId;
    case "verify-child-route":
      return payload.kind === "route-verified-v2"
        && subscriptionRoutesEqual(payload.route.route, command.route);
    case "launch-child":
      return payload.kind === "child-observed-v2"
        && payload.childEpoch === command.childEpoch
        && payload.session["process"].captureId === command.captureId
        && payload.session["process"].workspaceId === command.workspaceId;
    case "inspect-child":
      return payload.kind === "child-observed-v2"
        && payload.childEpoch === command.childEpoch
        && payload.childId === command.childId;
    case "execute-evidence":
      return payload.kind === "evidence-observed-v2" && evidencePayloadMatches(command, payload);
    case "execute-validation-rule":
      if (payload.kind === "command-observed-v2") return true;
      if (payload.kind !== "validation-finding-v2" || payload.finding.kind === "planning-gap") return false;
      return payload.finding.runId === command.runId
        && payload.finding.subjectRoot === command.candidateTree
        && (payload.finding.kind === "advisory"
          ? payload.finding.raisedByWorkItemId === command.workItemId
          : payload.finding.observedByWorkItemId === command.workItemId);
    case "build-integrated-candidate":
      return payload.kind === "candidate-integrated-v2"
        ? payload.candidateId === command.candidateId
          && payload.planRootId === command.planRootId
          && payload.gitRevision === command.candidateCommit
          && payload.gitTree === command.candidateTree
        : payload.kind === "integration-conflict-v2"
          && payload.integrationOwnerWorkItemId === command.workItemId
          && payload.planRootId === command.planRootId
          && payload.subjectRoot === command.candidateRoot;
    case "publish-compare-and-swap":
      return payload.kind === "publication-observed-v2"
        && payload.publicationId === command.publicationId
        && payload.gitTree === command.candidateTree
        && payload.tree === command.verifiedAttestation.artifactRoot
        && payload.publicationTreeAttestation.gitTree === command.verifiedAttestation.gitTree
        && payload.publicationTreeAttestation.artifactRoot === command.verifiedAttestation.artifactRoot
        && artifactRefsEqual(payload.publicationTreeAttestation.attestation, command.verifiedAttestation.attestation);
    case "observe-clock":
      return payload.kind === "clock-observed-v2";
    case "install-artifact":
      return payload.kind === "artifact-installed-v2" && artifactRefsEqual(payload.artifact, command.artifact);
  }
}

function observationFacts(state: RunState, stimulus: CommandObservationReceived): AdmissionResult {
  const payload = stimulus.observationPayload;
  let candidate: DomainFact | Feedback | null = null;
  switch (payload.kind) {
    case "route-verified-v2":
      candidate = fact(Object.freeze({
        kind: "route-verification-observed",
        runId: stimulus.runId,
        observation: payload.route,
        observationId: payload.route.observationId,
        rawObservation: stimulus.observation,
      }));
      break;
    case "evidence-observed-v2":
      candidate = fact(Object.freeze({ kind: "evidence-observed", runId: stimulus.runId, evidence: payload.evidence }));
      break;
    case "validation-finding-v2":
      candidate = correctionFact(state, stimulus, payload.finding);
      break;
    case "candidate-integrated-v2":
      if (
        payload.gitTreeCasAttestation.gitTree !== payload.gitTree
        || payload.gitTreeCasAttestation.artifactRoot !== payload.tree
      ) {
        return semanticFeedback("invalid-domain-transition", "$.observationPayload.gitTreeCasAttestation", "integrated candidate attestation must bind the exact Git tree and CAS root");
      }
      candidate = fact(Object.freeze({
        kind: "candidate-accepted",
        runId: stimulus.runId,
        candidateId: payload.candidateId,
        planRootId: payload.planRootId,
        tree: payload.tree,
        gitRevision: payload.gitRevision,
        gitTree: payload.gitTree,
        manifest: payload.manifest,
        reviewedDiff: payload.reviewedDiff,
        gitTreeCasAttestation: payload.gitTreeCasAttestation,
      }));
      break;
    case "integration-conflict-v2": {
      const finding = decodedFinding(Object.freeze({
        evidence: Object.freeze([stimulus.observation]),
        findingId: derivedFindingId(stimulus, "conflict"),
        kind: "integrity",
        observedByWorkItemId: payload.integrationOwnerWorkItemId,
        report: payload.conflict,
        ruleId: "rule:git-conflict",
        runId: stimulus.runId,
        subjectRoot: payload.subjectRoot,
        subjectWorkItemId: null,
      }));
      candidate = isFindingFeedback(finding) ? finding : correctionFact(state, stimulus, finding);
      break;
    }
    case "publication-observed-v2": {
      if (
        payload.publicationTreeAttestation.gitTree !== payload.gitTree
        || payload.publicationTreeAttestation.artifactRoot !== payload.tree
      ) {
        return semanticFeedback("invalid-domain-transition", "$.observationPayload.publicationTreeAttestation", "publication attestation must bind the exact published Git tree and CAS root");
      }
      const publication = fact(Object.freeze({
        kind: "publication-observed",
        runId: stimulus.runId,
        publicationId: payload.publicationId,
        observedHead: payload.observedHead,
        status: payload.status,
        tree: payload.tree,
        gitTree: payload.gitTree,
        publicationTreeAttestation: payload.publicationTreeAttestation,
      }));
      if (isFeedback(publication)) {
        candidate = publication;
        break;
      }
      if (payload.status === "desired-head") {
        return proposed(Object.freeze([publication]));
      }
      const plan = state.currentPlan;
      if (plan === null || state.currentCandidate === null) {
        candidate = semanticFeedback("corrector-unavailable", "$.observationPayload", "moved head has no current integration authority");
        break;
      }
      const finding = decodedFinding(Object.freeze({
        evidence: Object.freeze([stimulus.observation]),
        findingId: derivedFindingId(stimulus, "moved-head"),
        kind: "definition-of-done",
        observedByWorkItemId: plan.integrationOwnerWorkItemId,
        report: stimulus.observation,
        ruleId: "rule:moved-head",
        runId: stimulus.runId,
        subjectRoot: state.currentCandidate.tree,
        subjectWorkItemId: null,
      }));
      if (isFindingFeedback(finding)) {
        candidate = finding;
        break;
      }
      const correction = correctionFact(state, stimulus, finding);
      if (isFeedback(correction)) {
        candidate = correction;
        break;
      }
      return proposed(Object.freeze([publication, correction]));
    }
    case "workspace-reserved-v2":
    case "workspace-materialized-v2":
    case "child-observed-v2":
    case "clock-observed-v2":
    case "artifact-installed-v2":
    case "command-observed-v2":
    case "command-retry-v2":
      return proposed(EMPTY_FACTS);
  }
  if (candidate === null) {
    return proposed(EMPTY_FACTS);
  }
  return isFeedback(candidate) ? candidate : proposed(Object.freeze([candidate]));
}

export function admitCommandObservation(state: RunState, stimulus: CommandObservationReceived): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  if (universal !== null) return universal;
  const command = issuedObservationCommand(state, stimulus);
  if ("kind" in command && command.kind === "feedback") return command;
  return commandPayloadMatches(command, stimulus.observationPayload)
    ? observationFacts(state, stimulus)
    : semanticFeedback("invalid-stimulus", "$.observationPayload", "observation payload does not match the exact issued command");
}

export function admitRunReplayCompleted(state: RunState, stimulus: RunReplayCompleted): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  if (universal !== null) {
    return universal;
  }
  return stimulus.lastSequence === state.lastSequence && stimulus.stateDigest === stateDigest(state)
    ? proposed(EMPTY_FACTS)
    : semanticFeedback("replay-mismatch", "$.stateDigest", "replay sequence and digest must equal authoritative state");
}

export function admitOperatorSuspend(state: RunState, stimulus: OperatorSuspendRequested): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  if (universal !== null) {
    return universal;
  }
  return state.suspension.kind === "active"
    ? proposed(EMPTY_FACTS)
    : semanticFeedback("already-suspended", "$.operatorRequestId", "run is already suspended");
}

export function admitOperatorResume(state: RunState, stimulus: OperatorResumeRequested): AdmissionResult {
  const universal = universalRejection(state, stimulus);
  if (universal !== null) {
    return universal;
  }
  if (state.suspension.kind !== "suspended") {
    return semanticFeedback("not-suspended", "$.kind", "active run cannot be resumed");
  }
  return stimulus.operatorRequestId === state.suspension.operatorRequestId
    && stimulus.resumeFromSequence === state.suspension.sequence
    ? proposed(EMPTY_FACTS)
    : semanticFeedback("resume-binding-mismatch", "$.resumeFromSequence", "resume must bind exact suspension request and sequence");
}

export const admissionSeams = Object.freeze({
  "boundary-request-received": admitBoundaryRequest,
  "command-observation-received": admitCommandObservation,
  "operator-resume-requested": admitOperatorResume,
  "operator-suspend-requested": admitOperatorSuspend,
  "run-replay-completed": admitRunReplayCompleted,
  "submission-ready": admitSubmissionReady,
}) satisfies AdmissionSeams;
