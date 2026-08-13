import assert from "node:assert/strict";
import test from "node:test";
import { admitSubmissionReady } from "../../authority/admission/index.js";
import { assembleSemanticBatch } from "../../authority/admission/batch-assembly.js";
import {
  coverageComplete,
  coverageObligations,
  traceAnchor,
} from "../../authority/coverage/index.js";
import {
  checkClaim,
  evidenceSatisfies,
} from "../../authority/evidence/index.js";
import {
  fold,
  foldDomainFact,
} from "../../authority/evolution/index.js";
import type { FoldResult } from "../../authority/evolution/index.js";
import { prepare } from "../../authority/facade/index.js";
import { prepareWithSeams } from "../../authority/facade/prepare.js";
import type { SemanticSeams } from "../../authority/facade/seams.js";
import { initialState, stateDigest } from "../../authority/model/index.js";
import type { RunState } from "../../authority/model/index.js";
import {
  determineTerminalOutcome,
  t1Eligibility,
  t1Predicate,
  t2Predicate,
} from "../../authority/outcome/index.js";
import {
  domainFactCapsule,
  findingCapsule,
  journalRecordCapsule,
  stimulusCapsule,
  workItemCapsule,
} from "../../authority/protocol/aggregate.generated.js";
import type { DomainFact } from "../../authority/protocol/domain-fact.capsule.js";
import type { Finding } from "../../authority/protocol/finding.capsule.js";
import {
  canonicalDecisionFactsDigest,
} from "../../authority/protocol/journal-record.capsule.js";
import type {
  DecisionCommitted,
  RunGenesis,
} from "../../authority/protocol/journal-record.capsule.js";
import { canonicalDigestUnknown } from "../../authority/protocol/schema.js";
import type { SubmissionReady } from "../../authority/protocol/stimulus.capsule.js";
import type { WorkItem } from "../../authority/protocol/work-item.capsule.js";
import { deriveReaction } from "../../authority/reaction/index.js";
import {
  ownerForFinding,
  readyWork,
} from "../../authority/scheduling/index.js";

function genesis(seed: number): RunGenesis {
  const generated = journalRecordCapsule.arbitrary.validForKind("run-genesis", seed);
  return generated.kind === "run-genesis" ? generated : genesis(seed + 1);
}

function generatedPlan(seed: number, runId: RunGenesis["runId"]): Extract<DomainFact, { readonly kind: "plan-root-accepted" }> {
  const generated = domainFactCapsule.arbitrary.validForKind("plan-root-accepted", seed);
  if (generated.kind !== "plan-root-accepted") {
    return generatedPlan(seed + 1, runId);
  }
  return Object.freeze({ ...generated, runId });
}

function generatedRequirements(seed: number, runId: RunGenesis["runId"]): Extract<DomainFact, { readonly kind: "requirements-bound" }> {
  const generated = domainFactCapsule.arbitrary.validForKind("requirements-bound", seed);
  if (generated.kind !== "requirements-bound") {
    return generatedRequirements(seed + 1, runId);
  }
  return Object.freeze({ ...generated, runId });
}

function generatedWork(
  kind: "produce-artifact",
  seed: number,
): Extract<WorkItem, { readonly kind: "produce-artifact" }>;
function generatedWork(
  kind: "review-artifact",
  seed: number,
): Extract<WorkItem, { readonly kind: "review-artifact" }>;
function generatedWork(
  kind: "correct-artifact",
  seed: number,
): Extract<WorkItem, { readonly kind: "correct-artifact" }>;
function generatedWork(
  kind: "integrate-candidate",
  seed: number,
): Extract<WorkItem, { readonly kind: "integrate-candidate" }>;
function generatedWork(
  kind: "verify-candidate",
  seed: number,
): Extract<WorkItem, { readonly kind: "verify-candidate" }>;
function generatedWork(kind: WorkItem["kind"], seed: number): WorkItem;
function generatedWork(kind: WorkItem["kind"], seed: number): WorkItem {
  const generated = workItemCapsule.arbitrary.validForKind(kind, seed);
  return generated.kind === kind ? generated : generatedWork(kind, seed + 1);
}

function generatedSubmission(seed: number): SubmissionReady {
  const generated = stimulusCapsule.arbitrary.validForKind("submission-ready", seed);
  return generated.kind === "submission-ready" ? generated : generatedSubmission(seed + 1);
}

function applyFact(state: RunState, fact: DomainFact): RunState {
  const result = foldDomainFact(state, fact);
  assert.equal(result.kind, "applied");
  return result.state;
}

function appliedState(result: FoldResult): RunState {
  assert.equal(result.kind, "applied");
  return result.state;
}

function declareWork(state: RunState, workItem: WorkItem): RunState {
  return applyFact(state, Object.freeze({
    kind: "work-declared",
    runId: state.identity.runId,
    workItem,
  }));
}

interface ExecutionFixture {
  readonly state: RunState;
  readonly plan: Extract<DomainFact, { readonly kind: "plan-root-accepted" }>;
  readonly work: Extract<WorkItem, { readonly kind: "produce-artifact" }>;
}

function executionFixture(seed: number): ExecutionFixture {
  const runGenesis = genesis(seed);
  let state = initialState(runGenesis);
  state = applyFact(state, generatedRequirements(seed + 1, runGenesis.runId));
  const plan = generatedPlan(seed + 2, runGenesis.runId);
  state = applyFact(state, plan);
  const generated = generatedWork("produce-artifact", seed + 3);
  const work = Object.freeze({
    ...generated,
    runId: runGenesis.runId,
    planRootId: plan.planRootId,
  });
  state = declareWork(state, work);
  return Object.freeze({ state, plan, work });
}

function submissionFor(
  fixture: ExecutionFixture,
  seed: number,
  actionId: SubmissionReady["actionId"] | null,
): SubmissionReady {
  const generated = generatedSubmission(seed);
  return Object.freeze({
    ...generated,
    actionId: actionId ?? generated.actionId,
    attemptId: generated.attemptId,
    inputRoot: fixture.work.inputRoot,
    outputRoot: generated.outputRoot,
    planRootId: fixture.plan.planRootId,
    runId: fixture.state.identity.runId,
    workItemId: fixture.work.workItemId,
  });
}

function committedDecision(
  state: RunState,
  stimulus: SubmissionReady,
  facts: readonly DomainFact[],
  sequence: number,
): DecisionCommitted {
  const template = journalRecordCapsule.arbitrary.validForKind("decision-committed", sequence + 9000);
  if (template.kind !== "decision-committed") {
    return committedDecision(state, stimulus, facts, sequence + 1);
  }
  const decoded = journalRecordCapsule.decode(Object.freeze({
    ...template,
    actionId: stimulus.actionId,
    factRoot: canonicalDecisionFactsDigest(facts),
    facts,
    kind: "decision-committed",
    runId: state.identity.runId,
    sequence,
    stimulusDigest: stimulusCapsule.digest(stimulus),
  }));
  if (decoded.kind === "ok" && decoded.value.kind === "decision-committed") {
    return decoded.value;
  }
  return committedDecision(state, stimulus, facts, sequence + 1);
}

test("submission admission is deterministic and seal-idempotent independently of actionId", () => {
  const fixture = executionFixture(100);
  const first = submissionFor(fixture, 110, null);
  const secondAction = generatedSubmission(111).actionId;
  const second = submissionFor(fixture, 110, secondAction);
  const left = admitSubmissionReady(fixture.state, first);
  const right = admitSubmissionReady(fixture.state, second);
  assert.equal(left.kind, "proposed-facts");
  assert.equal(right.kind, "proposed-facts");
  if (left.kind !== "proposed-facts" || right.kind !== "proposed-facts") {
    return;
  }
  assert.deepEqual(left.facts, right.facts);
  assert.equal(left.facts.length, 1);
  assert.equal(left.facts[0]?.kind, "submission-bound");
  const repeated = admitSubmissionReady(fixture.state, first);
  assert.deepEqual(repeated, left);
});

test("duplicate accepted action is fold-inert before duplicate submission bookkeeping", () => {
  const fixture = executionFixture(200);
  const stimulus = submissionFor(fixture, 210, null);
  const admitted = admitSubmissionReady(fixture.state, stimulus);
  assert.equal(admitted.kind, "proposed-facts");
  if (admitted.kind !== "proposed-facts") {
    return;
  }
  const firstRecord = committedDecision(
    fixture.state,
    stimulus,
    admitted.facts,
    fixture.state.lastSequence + 1,
  );
  const accepted = appliedState(fold(fixture.state, firstRecord));
  const duplicateRecord = committedDecision(
    accepted,
    stimulus,
    admitted.facts,
    accepted.lastSequence + 1,
  );
  const duplicate = fold(accepted, duplicateRecord);
  assert.equal(duplicate.kind, "rejected");
  assert.equal(duplicate.state, accepted);
  if (duplicate.kind === "rejected") {
    assert.equal(duplicate.error.code, "duplicate-action");
  }
});

test("stale input and superseded plan roots return exact actionable feedback", () => {
  const fixture = executionFixture(300);
  const staleTemplate = generatedSubmission(310);
  const stale = Object.freeze({
    ...submissionFor(fixture, 311, null),
    inputRoot: staleTemplate.inputRoot === fixture.work.inputRoot
      ? staleTemplate.outputRoot
      : staleTemplate.inputRoot,
  });
  const staleResult = admitSubmissionReady(fixture.state, stale);
  assert.equal(staleResult.kind, "feedback");
  if (staleResult.kind === "feedback") {
    assert.equal(staleResult.diagnostic.startsWith("stale-input-root:"), true);
    assert.equal(staleResult.diagnostic.includes(fixture.work.inputRoot), true);
  }

  const newPlan = generatedPlan(312, fixture.state.identity.runId);
  const supersededState = applyFact(fixture.state, newPlan);
  const oldSubmission = submissionFor(fixture, 313, null);
  const superseded = admitSubmissionReady(supersededState, oldSubmission);
  assert.equal(superseded.kind, "feedback");
  if (superseded.kind === "feedback") {
    assert.equal(superseded.diagnostic.startsWith("superseded-plan-root:"), true);
    assert.equal(superseded.diagnostic.includes(newPlan.planRootId), true);
  }
  assert.equal(determineTerminalOutcome(supersededState, []), null);
});

test("supersession cycles cannot reactivate stale-plan admission or readiness", () => {
  const fixture = executionFixture(350);
  const secondPlan = generatedPlan(351, fixture.state.identity.runId);
  let state = applyFact(fixture.state, secondPlan);
  const firstTemplate = domainFactCapsule.arbitrary.validForKind("plan-root-superseded", 352);
  const secondTemplate = domainFactCapsule.arbitrary.validForKind("plan-root-superseded", 353);
  if (
    firstTemplate.kind !== "plan-root-superseded"
    || secondTemplate.kind !== "plan-root-superseded"
  ) {
    return;
  }
  state = applyFact(state, Object.freeze({
    ...firstTemplate,
    runId: state.identity.runId,
    priorPlanRootId: fixture.plan.planRootId,
    newPlanRootId: secondPlan.planRootId,
  }));
  state = applyFact(state, Object.freeze({
    ...secondTemplate,
    runId: state.identity.runId,
    priorPlanRootId: secondPlan.planRootId,
    newPlanRootId: fixture.plan.planRootId,
  }));
  assert.equal(state.currentPlanRootId, fixture.plan.planRootId);
  const stale = admitSubmissionReady(state, submissionFor(fixture, 354, null));
  assert.equal(stale.kind, "feedback");
  if (stale.kind === "feedback") {
    assert.equal(stale.diagnostic.startsWith("superseded-plan-root:"), true);
  }
  assert.deepEqual(readyWork(state), []);
  assert.deepEqual(deriveReaction(state, []).commands, []);
  assert.equal(t1Predicate(state, []), false);
});

test("production prepare uses W2 seams and preserves canonical batch roots", () => {
  const fixture = executionFixture(400);
  const stimulus = submissionFor(fixture, 410, null);
  const result = prepare(fixture.state, stimulus);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }
  assert.equal(result.batch.factRoot, canonicalDecisionFactsDigest(result.batch.facts));
  assert.equal(result.batch.commandRoot, canonicalDigestUnknown(result.batch.commands));
  assert.equal(result.batch.stateDigest, stateDigest(fixture.state));
  assert.equal(result.batch.commands.some((command) => command.kind === "prepare-workspace"), false);
});

test("batch assembly binds facts, commands, and stimulus without value loss", () => {
  const fixture = executionFixture(500);
  const stimulus = submissionFor(fixture, 510, null);
  const admitted = admitSubmissionReady(fixture.state, stimulus);
  assert.equal(admitted.kind, "proposed-facts");
  if (admitted.kind !== "proposed-facts") {
    return;
  }
  const reaction = deriveReaction(fixture.state, admitted.facts);
  const assembled = assembleSemanticBatch(
    fixture.state,
    stimulus,
    admitted.facts,
    reaction.commands,
    null,
  );
  assert.equal(assembled.kind, "prepared-semantic-roots");
  if (assembled.kind !== "prepared-semantic-roots") {
    return;
  }
  assert.equal(assembled.factRoot, canonicalDecisionFactsDigest(admitted.facts));
  assert.equal(assembled.commandRoot, canonicalDigestUnknown(reaction.commands));
  assert.equal(assembled.stimulusDigest, stimulusCapsule.digest(stimulus));
});

test("all six admission boundaries are deterministic and total over inert garbage", () => {
  const runGenesis = genesis(600);
  const state = initialState(runGenesis);
  const garbage = Object.freeze([
    null,
    false,
    0,
    "garbage",
    Object.freeze([]),
    Object.freeze({ kind: "unknown" }),
    Object.freeze({ unexpected: "field" }),
  ]);
  for (const value of garbage) {
    assert.doesNotThrow(() => prepare(state, value));
    const first = prepare(state, value);
    const second = prepare(state, value);
    assert.deepEqual(first, second);
    assert.equal(first.kind, "feedback");
  }
  for (const kind of stimulusCapsule.kinds) {
    const generated = stimulusCapsule.arbitrary.validForKind(kind, 620 + kind.length);
    const stimulus = Object.freeze({ ...generated, runId: state.identity.runId });
    assert.doesNotThrow(() => prepare(state, stimulus));
    assert.deepEqual(prepare(state, stimulus), prepare(state, stimulus));
  }
});

test("opaque semantic inputs and lifecycle requests fail loudly rather than inventing facts", () => {
  const runGenesis = genesis(700);
  const state = initialState(runGenesis);
  const cases = Object.freeze([
    Object.freeze({ kind: "boundary-request-received", prefix: "opaque-boundary-request:" }),
    Object.freeze({ kind: "command-observation-received", prefix: "opaque-command-observation:" }),
    Object.freeze({ kind: "operator-resume-requested", prefix: "not-suspended:" }),
    Object.freeze({ kind: "operator-suspend-requested", prefix: "lifecycle-record-unrepresentable:" }),
  ]);
  for (const entry of cases) {
    const generated = stimulusCapsule.arbitrary.validForKind(entry.kind, 710 + entry.kind.length);
    const stimulus = Object.freeze({ ...generated, runId: state.identity.runId });
    const result = prepare(state, stimulus);
    assert.equal(result.kind, "feedback");
    if (result.kind === "feedback") {
      assert.equal(result.diagnostic.startsWith(entry.prefix), true);
    }
  }
});

test("replay wakeup accepts only the exact replayed sequence and state digest", () => {
  const fixture = executionFixture(800);
  const template = stimulusCapsule.arbitrary.validForKind("run-replay-completed", 810);
  assert.equal(template.kind, "run-replay-completed");
  if (template.kind !== "run-replay-completed") {
    return;
  }
  const exact = Object.freeze({
    ...template,
    runId: fixture.state.identity.runId,
    lastSequence: fixture.state.lastSequence,
    stateDigest: stateDigest(fixture.state),
  });
  const result = prepare(fixture.state, exact);
  assert.equal(result.kind, "accepted");
  const stale = prepare(fixture.state, Object.freeze({
    ...exact,
    lastSequence: fixture.state.lastSequence + 1,
  }));
  assert.equal(stale.kind, "feedback");
  if (stale.kind === "feedback") {
    assert.equal(stale.diagnostic.startsWith("replay-sequence-mismatch:"), true);
  }
});

interface EvidenceFixture {
  readonly state: RunState;
  readonly evidenceFact: Extract<DomainFact, { readonly kind: "evidence-observed" }>;
  readonly coverageFact: Extract<DomainFact, { readonly kind: "coverage-linked" }>;
}

function evidenceFixture(seed: number): EvidenceFixture {
  const execution = executionFixture(seed);
  const submission = submissionFor(execution, seed + 10, null);
  const admitted = admitSubmissionReady(execution.state, submission);
  assert.equal(admitted.kind, "proposed-facts");
  if (admitted.kind !== "proposed-facts") {
    return evidenceFixture(seed + 100);
  }
  let state = execution.state;
  for (const fact of admitted.facts) {
    state = applyFact(state, fact);
  }
  const binding = state.submissions.find((entry) => entry.workItemId === execution.work.workItemId);
  assert.notEqual(binding, undefined);
  if (binding === undefined) {
    return evidenceFixture(seed + 100);
  }
  const evidenceTemplate = domainFactCapsule.arbitrary.validForKind("evidence-observed", seed + 20);
  if (evidenceTemplate.kind !== "evidence-observed") {
    return evidenceFixture(seed + 100);
  }
  const envelope = Object.freeze({
    ...evidenceTemplate.evidence.envelope,
    runId: state.identity.runId,
    workItemId: execution.work.workItemId,
    tree: binding.outputRoot,
    exit: Object.freeze({ kind: "exited", code: 0 }),
  });
  const evidenceFact = Object.freeze({
    ...evidenceTemplate,
    runId: state.identity.runId,
    evidence: Object.freeze({
      ...evidenceTemplate.evidence,
      envelope,
      envelopeDigest: canonicalDigestUnknown(envelope),
    }),
  });
  state = applyFact(state, evidenceFact);
  const coverageTemplate = domainFactCapsule.arbitrary.validForKind("coverage-linked", seed + 30);
  if (coverageTemplate.kind !== "coverage-linked") {
    return evidenceFixture(seed + 100);
  }
  const coverageFact = Object.freeze({
    ...coverageTemplate,
    runId: state.identity.runId,
    planRootId: execution.plan.planRootId,
    workItemId: execution.work.workItemId,
    implementationRoot: binding.outputRoot,
    evidence: envelope.output,
  });
  state = applyFact(state, coverageFact);
  return Object.freeze({ state, evidenceFact, coverageFact });
}

test("claim checking requires exact observed envelope digest, tree, exit, and output", () => {
  const fixture = evidenceFixture(900);
  const envelope = fixture.evidenceFact.evidence.envelope;
  const claim = Object.freeze({
    evidenceId: envelope.evidenceId,
    tree: envelope.tree,
    exit: envelope.exit,
    output: envelope.output,
  });
  const accepted = checkClaim(fixture.state, claim);
  assert.equal(accepted.kind, "accepted");
  const wrongTree = fixture.state.identity.taskSnapshot === envelope.tree
    ? fixture.state.identity.policyRoot
    : fixture.state.identity.taskSnapshot;
  const mismatch = checkClaim(fixture.state, Object.freeze({ ...claim, tree: wrongTree }));
  assert.equal(mismatch.kind, "rejected");
  if (mismatch.kind === "rejected") {
    assert.equal(mismatch.code, "evidence-tree-mismatch");
  }
  assert.equal(evidenceSatisfies(fixture.state, Object.freeze({
    evidenceId: envelope.evidenceId,
    workItemId: envelope.workItemId,
    tree: envelope.tree,
    kindId: envelope.kindId,
    output: envelope.output,
    requireSuccessfulExit: envelope.exit.kind === "exited" && envelope.exit.code === 0,
  })), true);
});

test("coverage traces known links but refuses to infer anchor inventory or dispositions", () => {
  const fixture = evidenceFixture(1000);
  const trace = traceAnchor(fixture.state, fixture.coverageFact.sourceAnchor);
  assert.equal(trace.links.length, 1);
  assert.equal(trace.links[0]?.implementationAccepted, true);
  assert.equal(trace.links[0]?.evidenceSatisfied, true);
  assert.equal(trace.links[0]?.disposition, "unrepresented");
  const obligations = coverageObligations(fixture.state);
  assert.equal(obligations.some((entry) => entry.kind === "anchor-index-unresolved"), true);
  assert.equal(obligations.some((entry) => entry.kind === "disposition-unrepresented"), true);
  assert.equal(coverageComplete(fixture.state), false);
});

test("ready work has a stable WorkItemId tie-break and suspension freezes readiness", () => {
  const fixture = executionFixture(1100);
  const secondGenerated = generatedWork("review-artifact", 1110);
  const second = Object.freeze({
    ...secondGenerated,
    runId: fixture.state.identity.runId,
    planRootId: fixture.plan.planRootId,
  });
  const state = declareWork(fixture.state, second);
  const ready = readyWork(state);
  const ids = ready.map((entry) => entry.workItemId);
  assert.deepEqual(ids, ids.slice().sort());
  assert.equal(ids.length, 2);

  const suspension = journalRecordCapsule.arbitrary.validForKind("run-suspended", 1120);
  assert.equal(suspension.kind, "run-suspended");
  if (suspension.kind !== "run-suspended") {
    return;
  }
  const suspended = appliedState(fold(state, Object.freeze({
    ...suspension,
    runId: state.identity.runId,
    sequence: state.lastSequence + 1,
  })));
  assert.deepEqual(readyWork(suspended), []);
  assert.deepEqual(deriveReaction(suspended, []).commands, []);
});

function findingForKind(
  kind: Finding["kind"],
  seed: number,
  runId: RunGenesis["runId"],
): Finding {
  const generated = findingCapsule.arbitrary.validForKind(kind, seed);
  return generated.kind === kind
    ? Object.freeze({ ...generated, runId })
    : findingForKind(kind, seed + 1, runId);
}

function bindFindingOwner(fixture: ExecutionFixture, finding: Finding): Finding {
  switch (finding.kind) {
    case "planning-gap":
      return Object.freeze({
        ...finding,
        planAuthorWorkItemId: fixture.work.workItemId,
        planRootId: fixture.plan.planRootId,
      });
    case "integrity":
    case "definition-of-done":
      return Object.freeze({ ...finding, correctionOwner: fixture.work.workItemId });
    case "advisory":
      return Object.freeze({ ...finding, raisedByWorkItemId: fixture.work.workItemId });
  }
}

test("every generated finding has exactly one deterministic declared correction owner", () => {
  const fixture = executionFixture(1200);
  for (let seed = 0; seed < 128; seed += 1) {
    for (const kind of findingCapsule.kinds) {
      const generated = findingForKind(kind, 1210 + seed + kind.length, fixture.state.identity.runId);
      const finding = bindFindingOwner(fixture, generated);
      const first = ownerForFinding(fixture.state, finding);
      const second = ownerForFinding(fixture.state, finding);
      assert.deepEqual(first, second);
      assert.equal(first.findingId, finding.findingId);
      assert.equal(
        fixture.state.workItems.some((entry) => entry.workItemId === first.ownerWorkItemId),
        true,
      );
      assert.equal(["local", "plan-wide", "cross-lane"].includes(first.scope), true);
    }
  }
});

test("T2 is constructible only for an open planning gap with exact anchors", () => {
  const runGenesis = genesis(1300);
  const state = initialState(runGenesis);
  const gap = findingForKind("planning-gap", 1310, runGenesis.runId);
  assert.equal(gap.kind, "planning-gap");
  if (gap.kind !== "planning-gap") {
    return;
  }
  const raised = Object.freeze({
    kind: "finding-raised",
    runId: runGenesis.runId,
    finding: gap,
  });
  const outcome = determineTerminalOutcome(state, [raised]);
  assert.notEqual(outcome, null);
  if (outcome === null) {
    return;
  }
  assert.equal(outcome.kind, "t2");
  if (outcome.kind === "t2") {
    assert.equal(outcome.reason, gap.reason);
    assert.deepEqual(outcome.sourceAnchors, gap.sourceAnchors);
    assert.deepEqual(outcome.explanation, gap.explanation);
    assert.equal(outcome.sourceAnchors.length > 0, true);
  }
  assert.equal(t2Predicate(state, [raised]), true);

  const execution = applyFact(state, generatedPlan(1320, runGenesis.runId));
  assert.equal(determineTerminalOutcome(execution, [raised]), null);
  assert.equal(t2Predicate(execution, [raised]), false);
});

test("terminal predicates are inert after any outcome is already committed", () => {
  const runGenesis = genesis(1330);
  let state = initialState(runGenesis);
  const gap = findingForKind("planning-gap", 1331, runGenesis.runId);
  assert.equal(gap.kind, "planning-gap");
  if (gap.kind !== "planning-gap") {
    return;
  }
  state = applyFact(state, Object.freeze({
    kind: "finding-raised",
    runId: runGenesis.runId,
    finding: gap,
  }));
  const outcome = determineTerminalOutcome(state, []);
  assert.equal(outcome?.kind, "t2");
  if (outcome === null) {
    return;
  }
  const record = journalRecordCapsule.arbitrary.validForKind("outcome-committed", 1332);
  assert.equal(record.kind, "outcome-committed");
  if (record.kind !== "outcome-committed") {
    return;
  }
  const terminal = appliedState(fold(state, Object.freeze({
    ...record,
    runId: runGenesis.runId,
    sequence: state.lastSequence + 1,
    outcome,
  })));
  assert.equal(determineTerminalOutcome(terminal, []), null);
  assert.equal(t1Predicate(terminal, []), false);
  assert.equal(t2Predicate(terminal, []), false);
});

test("facade suppresses effect commands when the same fact batch constructs T2", () => {
  const runGenesis = genesis(1350);
  let state = initialState(runGenesis);
  const planningWorkGenerated = generatedWork("produce-artifact", 1351);
  const planningWork = Object.freeze({
    ...planningWorkGenerated,
    runId: runGenesis.runId,
  });
  state = declareWork(state, planningWork);
  const gap = findingForKind("planning-gap", 1352, runGenesis.runId);
  assert.equal(gap.kind, "planning-gap");
  if (gap.kind !== "planning-gap") {
    return;
  }
  const facts: readonly DomainFact[] = Object.freeze([Object.freeze({
    kind: "finding-raised",
    runId: runGenesis.runId,
    finding: gap,
  })]);
  const proposed = Object.freeze({ kind: "proposed-facts", facts });
  const seams = Object.freeze({
    admission: Object.freeze({
      "boundary-request-received"() { return proposed; },
      "command-observation-received"() { return proposed; },
      "operator-resume-requested"() { return proposed; },
      "operator-suspend-requested"() { return proposed; },
      "run-replay-completed"() { return proposed; },
      "submission-ready"() { return proposed; },
    }),
    reaction: deriveReaction,
    outcome: determineTerminalOutcome,
    assemble: assembleSemanticBatch,
  }) satisfies SemanticSeams;
  const replayTemplate = stimulusCapsule.arbitrary.validForKind("run-replay-completed", 1353);
  assert.equal(replayTemplate.kind, "run-replay-completed");
  if (replayTemplate.kind !== "run-replay-completed") {
    return;
  }
  const replay = Object.freeze({
    ...replayTemplate,
    runId: runGenesis.runId,
    lastSequence: state.lastSequence,
    stateDigest: stateDigest(state),
  });
  assert.equal(deriveReaction(state, facts).commands.length > 0, true);
  const result = prepareWithSeams(state, replay, seams);
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") {
    assert.equal(result.batch.outcome?.kind, "t2");
    assert.deepEqual(result.batch.commands, []);
  }
});

test("terminal construction never produces a value outside its complete predicate", () => {
  let constructed = 0;
  for (let seed = 0; seed < 128; seed += 1) {
    const runGenesis = genesis(1400 + seed);
    const planning = initialState(runGenesis);
    const gap = findingForKind("planning-gap", 1600 + seed, runGenesis.runId);
    assert.equal(gap.kind, "planning-gap");
    if (gap.kind !== "planning-gap") {
      continue;
    }
    const facts: readonly DomainFact[] = Object.freeze([Object.freeze({
      kind: "finding-raised",
      runId: runGenesis.runId,
      finding: gap,
    })]);
    const planningOutcome = determineTerminalOutcome(planning, facts);
    if (planningOutcome !== null) {
      constructed += 1;
      assert.equal(planningOutcome.kind, "t2");
      assert.equal(planning.phase, "planning");
      if (planningOutcome.kind === "t2") {
        assert.equal(planningOutcome.sourceAnchors.length > 0, true);
        assert.equal(
          planningOutcome.reason === "substantial-path"
            || planningOutcome.reason === "contradiction",
          true,
        );
      }
    }
    const execution = applyFact(planning, generatedPlan(1800 + seed, runGenesis.runId));
    const executionOutcome = determineTerminalOutcome(execution, facts);
    if (executionOutcome !== null && executionOutcome.kind === "t1") {
      const eligibility = t1Eligibility(execution, facts);
      assert.equal(eligibility.eligible, true);
      if (eligibility.eligible) {
        assert.equal(Object.values(eligibility.checks).every(Boolean), true);
      }
    } else {
      assert.equal(executionOutcome, null);
    }
  }
  assert.equal(constructed, 128);
});

function terminalCandidateState(seed: number): RunState {
  const runGenesis = genesis(seed);
  let state = initialState(runGenesis);
  state = applyFact(state, generatedRequirements(seed + 1, runGenesis.runId));
  const plan = generatedPlan(seed + 2, runGenesis.runId);
  state = applyFact(state, plan);

  const integrationGenerated = generatedWork("integrate-candidate", seed + 3);
  const integration = Object.freeze({
    ...integrationGenerated,
    runId: runGenesis.runId,
    planRootId: plan.planRootId,
  });
  state = declareWork(state, integration);
  const integrationSubmission = domainFactCapsule.arbitrary.validForKind("submission-bound", seed + 4);
  if (integrationSubmission.kind !== "submission-bound") {
    return terminalCandidateState(seed + 100);
  }
  state = applyFact(state, Object.freeze({
    ...integrationSubmission,
    runId: runGenesis.runId,
    workItemId: integration.workItemId,
    planRootId: plan.planRootId,
    inputRoot: integration.inputRoot,
  }));

  const candidateTemplate = domainFactCapsule.arbitrary.validForKind("candidate-accepted", seed + 5);
  if (candidateTemplate.kind !== "candidate-accepted") {
    return terminalCandidateState(seed + 100);
  }
  const candidate = Object.freeze({
    ...candidateTemplate,
    runId: runGenesis.runId,
    planRootId: plan.planRootId,
  });
  state = applyFact(state, candidate);

  const verificationGenerated = generatedWork("verify-candidate", seed + 6);
  const verification = Object.freeze({
    ...verificationGenerated,
    runId: runGenesis.runId,
    planRootId: plan.planRootId,
    candidateRoot: candidate.tree,
  });
  state = declareWork(state, verification);
  const verificationSubmission = domainFactCapsule.arbitrary.validForKind("submission-bound", seed + 7);
  if (verificationSubmission.kind !== "submission-bound") {
    return terminalCandidateState(seed + 100);
  }
  state = applyFact(state, Object.freeze({
    ...verificationSubmission,
    runId: runGenesis.runId,
    workItemId: verification.workItemId,
    planRootId: plan.planRootId,
    inputRoot: verification.inputRoot,
  }));

  const evidenceTemplate = domainFactCapsule.arbitrary.validForKind("evidence-observed", seed + 8);
  if (evidenceTemplate.kind !== "evidence-observed") {
    return terminalCandidateState(seed + 100);
  }
  const envelope = Object.freeze({
    ...evidenceTemplate.evidence.envelope,
    runId: runGenesis.runId,
    workItemId: verification.workItemId,
    tree: candidate.tree,
    exit: Object.freeze({ kind: "exited", code: 0 }),
  });
  state = applyFact(state, Object.freeze({
    ...evidenceTemplate,
    runId: runGenesis.runId,
    evidence: Object.freeze({
      ...evidenceTemplate.evidence,
      envelope,
      envelopeDigest: canonicalDigestUnknown(envelope),
    }),
  }));

  const intendedTemplate = domainFactCapsule.arbitrary.validForKind("publication-intended", seed + 9);
  if (intendedTemplate.kind !== "publication-intended") {
    return terminalCandidateState(seed + 100);
  }
  const intended = Object.freeze({
    ...intendedTemplate,
    runId: runGenesis.runId,
    candidateId: candidate.candidateId,
  });
  state = applyFact(state, intended);
  const observedTemplate = domainFactCapsule.arbitrary.validForKind("publication-observed", seed + 10);
  if (observedTemplate.kind !== "publication-observed") {
    return terminalCandidateState(seed + 100);
  }
  return applyFact(state, Object.freeze({
    ...observedTemplate,
    runId: runGenesis.runId,
    publicationId: intended.publicationId,
    status: "desired-head",
    observedHead: intended.desiredHead,
  }));
}

test("T1 component checks bind accepted work, blocking findings, evidence tree, and publication", () => {
  const state = terminalCandidateState(2000);
  const eligibility = t1Eligibility(state, []);
  assert.equal(eligibility.eligible, false);
  assert.deepEqual(eligibility.checks, Object.freeze({
    c1RequirementsBound: true,
    c2CoverageComplete: false,
    c3FinalEvidenceGreen: true,
    c4CandidateManifestBound: true,
    c5CurrentRootBindings: true,
    c6AcceptedWorkRetained: true,
    c7NoPlanningGap: true,
    noOpenIntegrityOrDefinitionOfDoneFinding: true,
    publicationContainsCandidate: true,
  }));

  const advisory = findingForKind("advisory", 2020, state.identity.runId);
  assert.equal(advisory.kind, "advisory");
  if (advisory.kind !== "advisory") {
    return;
  }
  const advisoryState = applyFact(state, Object.freeze({
    kind: "finding-raised",
    runId: state.identity.runId,
    finding: advisory,
  }));
  assert.equal(
    t1Eligibility(advisoryState, []).checks.noOpenIntegrityOrDefinitionOfDoneFinding,
    true,
  );

  const integrity = findingForKind("integrity", 2021, state.identity.runId);
  assert.equal(integrity.kind, "integrity");
  if (integrity.kind !== "integrity") {
    return;
  }
  const blockedState = applyFact(state, Object.freeze({
    kind: "finding-raised",
    runId: state.identity.runId,
    finding: integrity,
  }));
  assert.equal(
    t1Eligibility(blockedState, []).checks.noOpenIntegrityOrDefinitionOfDoneFinding,
    false,
  );
  assert.equal(t1Predicate(state, []), false);
  assert.equal(determineTerminalOutcome(state, []), null);
});

test("reaction is deterministic, valid, settled-command-aware, and never decides success", () => {
  const fixture = executionFixture(2100);
  const first = deriveReaction(fixture.state, []);
  const second = deriveReaction(fixture.state, []);
  assert.deepEqual(first, second);
  assert.equal(first.commands.length, 1);
  assert.equal(first.commands[0]?.kind, "prepare-workspace");
  for (const command of first.commands) {
    assert.match(command.actionId, /^action:sha256:[0-9a-f]{64}$/);
    assert.equal(command.runId, fixture.state.identity.runId);
  }
  assert.equal(determineTerminalOutcome(fixture.state, []), null);
});

test("reaction derives integration and final-evidence commands only after semantic barriers", () => {
  const runGenesis = genesis(2200);
  let state = initialState(runGenesis);
  const plan = generatedPlan(2201, runGenesis.runId);
  state = applyFact(state, plan);
  const integrationGenerated = generatedWork("integrate-candidate", 2202);
  const integration = Object.freeze({
    ...integrationGenerated,
    runId: runGenesis.runId,
    planRootId: plan.planRootId,
  });
  state = declareWork(state, integration);
  const integrationCommands = deriveReaction(state, []).commands;
  assert.equal(integrationCommands.some((entry) => entry.kind === "build-integrated-candidate"), true);

  const integrationSubmissionTemplate = domainFactCapsule.arbitrary.validForKind("submission-bound", 2203);
  if (integrationSubmissionTemplate.kind !== "submission-bound") {
    return;
  }
  state = applyFact(state, Object.freeze({
    ...integrationSubmissionTemplate,
    runId: runGenesis.runId,
    workItemId: integration.workItemId,
    planRootId: plan.planRootId,
    inputRoot: integration.inputRoot,
  }));
  const candidateTemplate = domainFactCapsule.arbitrary.validForKind("candidate-accepted", 2204);
  if (candidateTemplate.kind !== "candidate-accepted") {
    return;
  }
  const candidate = Object.freeze({
    ...candidateTemplate,
    runId: runGenesis.runId,
    planRootId: plan.planRootId,
  });
  state = applyFact(state, candidate);
  const verificationGenerated = generatedWork("verify-candidate", 2205);
  const verification = Object.freeze({
    ...verificationGenerated,
    runId: runGenesis.runId,
    planRootId: plan.planRootId,
    candidateRoot: candidate.tree,
  });
  state = declareWork(state, verification);
  const verificationCommands = deriveReaction(state, []).commands;
  assert.equal(verificationCommands.some((entry) => entry.kind === "execute-evidence"), true);
});
