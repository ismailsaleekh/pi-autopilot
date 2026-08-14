import assert from "node:assert/strict";
import test from "node:test";
import { prepare, replay } from "../../authority/facade/index.js";
import { stateDigest } from "../../authority/model/run-state.js";
import { journalRecordCapsule } from "../../authority/protocol/journal-record.capsule.js";
import { decimalNatural } from "../../authority/protocol/identifiers.js";
import { stimulusCapsule } from "../../authority/protocol/stimulus.capsule.js";
import { decodeStimulus } from "../../runtime/boundary-codecs/index.js";
import {
  blockingFinding,
  buildPlannedScenario,
  buildT1Scenario,
  buildT2Scenario,
  planningGap,
  submitBlockingFinding,
  workOutputSubmission,
} from "../scenario-harness/full-run.js";

function terminalRecord(result: ReturnType<typeof buildT1Scenario> | ReturnType<typeof buildT2Scenario>) {
  const record = result.terminalCommit.record;
  assert.ok(record.kind === "command-settled" || record.kind === "outcome-committed");
  return record;
}

test("public plan→execute flow commits a replay-derived T1 after serial publication", () => {
  const result = buildT1Scenario(10_000);
  const terminal = result.scenario.state.terminal;
  assert.equal(terminal?.outcome.kind, "t1");
  const record = terminalRecord(result);
  assert.equal(record.kind, "command-settled");
  if (record.kind !== "command-settled" || record.outcome?.kind !== "t1" || terminal?.outcome.kind !== "t1") return;
  assert.equal(record.commandId, result.publicationCommand.commandId);
  assert.equal(record.outcome.candidateId, result.scenario.state.currentCandidate?.candidateId);
  assert.equal(record.outcome.publicationId, result.scenario.state.currentPublication?.publicationId);
  assert.equal(record.outcome.finalTree, result.candidateTree);
  for (const reference of [
    record.outcome.advisoryDisclosures,
    record.outcome.c1ToC7Proof,
    record.outcome.finalManifest,
    record.outcome.gitTreeCasAttestation,
    record.outcome.publicationTreeAttestation,
    record.outcome.reviewedDiff,
  ]) assert.equal(result.scenario.artifacts.read(reference).kind, "ok");
  assert.equal(result.scenario.records.some((entry) => entry.kind === "outcome-committed"), false);
});

test("public planning review commits substantial-path T2 with exact anchors and evidence", () => {
  const result = buildT2Scenario(11_000, "substantial-path");
  const terminal = result.scenario.state.terminal;
  assert.equal(terminal?.outcome.kind, "t2");
  if (terminal?.outcome.kind !== "t2") return;
  assert.equal(terminal.outcome.reason, "substantial-path");
  assert.deepEqual(terminal.outcome.sourceAnchors, result.finding.sourceAnchors);
  assert.deepEqual(terminal.outcome.sourceEvidence, result.finding.sourceEvidence);
  assert.equal(result.scenario.artifacts.read(terminal.outcome.explanation).kind, "ok");
  assert.equal(result.scenario.artifacts.read(terminal.outcome.sourceEvidence[0]).kind, "ok");
});

test("public planning review commits contradiction T2 with exact anchors and evidence", () => {
  const result = buildT2Scenario(12_000, "contradiction");
  const terminal = result.scenario.state.terminal;
  assert.equal(terminal?.outcome.kind, "t2");
  if (terminal?.outcome.kind !== "t2") return;
  assert.equal(terminal.outcome.reason, "contradiction");
  assert.deepEqual(terminal.outcome.sourceAnchors, result.finding.sourceAnchors);
  assert.deepEqual(terminal.outcome.sourceEvidence, result.finding.sourceEvidence);
  assert.equal(terminalRecord(result).kind, "outcome-committed");
});

test("local, plan-wide, and cross-lane blockers atomically mint deterministic authority-owned correctors", () => {
  const planned = buildPlannedScenario(13_000);
  const cases = Object.freeze([
    Object.freeze({ scope: "local" as const, owner: planned.laneA.workItemId, kind: "integrity" as const }),
    Object.freeze({ scope: "plan-wide" as const, owner: planned.author.workItemId, kind: "definition-of-done" as const }),
    Object.freeze({ scope: "cross-lane" as const, owner: planned.integrator.workItemId, kind: "integrity" as const }),
  ]);
  for (let index = 0; index < cases.length; index += 1) {
    const expected = cases[index];
    assert.notEqual(expected, undefined);
    if (expected === undefined) continue;
    const finding = blockingFinding(planned, expected.kind, expected.scope, 13_100 + index * 100);
    const stimulus = planned.scenario.submission(planned.integrator, Object.freeze({ finding, kind: "accept-finding-v2" }), planned.planRoot);
    const first = planned.scenario.inspect(stimulus);
    const second = planned.scenario.inspect(stimulus);
    assert.notEqual(first.kind, "feedback", first.kind === "feedback" ? `${expected.scope}: ${first.code}: ${first.diagnostic}` : undefined);
    assert.notEqual(second.kind, "feedback", second.kind === "feedback" ? `${expected.scope}: ${second.code}: ${second.diagnostic}` : undefined);
    if (first.kind === "feedback" || second.kind === "feedback") continue;
    assert.equal(journalRecordCapsule.digest(first.record), journalRecordCapsule.digest(second.record));
    const committed = planned.scenario.commit(stimulus);
    assert.ok(committed.record.kind === "decision-committed");
    if (committed.record.kind !== "decision-committed") continue;
    const accepted = committed.record.facts.find((fact) => fact.kind === "finding-accepted");
    assert.notEqual(accepted, undefined);
    if (accepted === undefined || accepted.kind !== "finding-accepted" || accepted.acceptance.kind !== "blocking-with-correction") continue;
    const correction = accepted.acceptance.correction;
    assert.equal(correction.scope, expected.scope);
    assert.equal(correction.originalOwnerWorkItemId, expected.owner);
    const retained = planned.scenario.state.indexes.work.hot.find((entry) => entry.value.kind === "work" && entry.value.workItem.workItemId === correction.correctorWorkItemId);
    assert.notEqual(retained, undefined);
    assert.equal(planned.scenario.state.terminal, null);
  }
});

test("malformed submission is contained, then the same owning lane receives repair work", () => {
  const planned = buildPlannedScenario(14_000);
  const finding = blockingFinding(planned, "integrity", "local", 14_100);
  const valid = planned.scenario.submission(planned.integrator, Object.freeze({ finding, kind: "accept-finding-v2" }), planned.planRoot);
  const malformed = Object.freeze({ ...valid, submissionPayload: Object.freeze({ kind: "accept-work-output-v2" }) });
  const before = stateDigest(planned.scenario.state);
  assert.equal(decodeStimulus(malformed).kind, "feedback");
  assert.equal(stateDigest(planned.scenario.state), before);
  const committed = submitBlockingFinding(planned, finding);
  assert.equal(committed.record.kind, "decision-committed");
  if (committed.record.kind !== "decision-committed") return;
  const accepted = committed.record.facts.find((fact) => fact.kind === "finding-accepted");
  assert.ok(accepted?.kind === "finding-accepted" && accepted.acceptance.kind === "blocking-with-correction");
  if (accepted?.kind === "finding-accepted" && accepted.acceptance.kind === "blocking-with-correction") {
    assert.equal(accepted.acceptance.correction.originalOwnerWorkItemId, planned.laneA.workItemId);
    assert.equal(accepted.acceptance.correction.scope, "local");
  }
});

test("concurrent lane preparations require serial re-prepare before one integrated candidate", () => {
  const planned = buildPlannedScenario(15_000);
  const rootA = planned.scenario.install("concurrent-a", Object.freeze({ lane: "a" })).root;
  const rootB = planned.scenario.install("concurrent-b", Object.freeze({ lane: "b" })).root;
  const inputA = workOutputSubmission(planned, planned.laneA, "concurrent-a", rootA);
  const inputB = workOutputSubmission(planned, planned.laneB, "concurrent-b", rootB);
  const speculativeA = planned.scenario.inspect(inputA);
  const speculativeB = planned.scenario.inspect(inputB);
  assert.notEqual(speculativeA.kind, "feedback");
  assert.notEqual(speculativeB.kind, "feedback");
  planned.scenario.commit(inputA);
  if (speculativeB.kind !== "feedback") {
    const replayed = replay(planned.scenario.state, Object.freeze([speculativeB.record]));
    assert.equal(replayed.kind, "rejected");
    if (replayed.kind === "rejected") assert.equal(replayed.error.code, "stale-sequence");
  }
  planned.scenario.commit(inputB);
  assert.equal(planned.scenario.state.counters.acceptedWork, "2");

  const completed = buildT1Scenario(15_500);
  const candidateIndex = completed.scenario.records.findIndex((record) => record.kind !== "run-genesis" && "facts" in record && record.facts.some((fact) => fact.kind === "candidate-accepted"));
  const laneIndexes = completed.scenario.records.map((record, index) => record.kind !== "run-genesis" && "facts" in record && record.facts.some((fact) => fact.kind === "work-output-accepted") ? index : -1).filter((index) => index >= 0);
  assert.equal(laneIndexes.length, 5);
  assert.ok(candidateIndex > (laneIndexes[2] ?? Number.MAX_SAFE_INTEGER));
  assert.ok(candidateIndex < (laneIndexes[3] ?? -1));
  assert.equal(completed.scenario.state.indexes.candidates.count, "1");
});

test("cross-wired command observations cannot settle or inject consequences", () => {
  const planned = buildPlannedScenario(15_800);
  const commands = planned.scenario.records.flatMap((record) => record.kind === "decision-committed" ? record.commands : Object.freeze([]));
  const first = commands.find((command) => command.kind === "prepare-workspace" && command.workItemId === planned.author.workItemId);
  const second = commands.find((command) => command.kind === "prepare-workspace" && command.workItemId === planned.integrator.workItemId);
  assert.notEqual(first, undefined);
  assert.notEqual(second, undefined);
  if (first === undefined || second === undefined || first.kind !== "prepare-workspace") return;
  const valid = planned.scenario.observation(first, Object.freeze({ kind: "workspace-reserved-v2", leaseId: first.leaseId, workspaceCapability: first.workspaceCapability, workspaceId: first.workspaceId }));
  const crossWired = stimulusCapsule.decode(Object.freeze({ ...valid, commandId: second.commandId }));
  assert.equal(crossWired.kind, "ok");
  if (crossWired.kind !== "ok") return;
  const before = stateDigest(planned.scenario.state);
  const rejected = planned.scenario.inspect(crossWired.value);
  assert.equal(rejected.kind, "feedback");
  if (rejected.kind === "feedback") assert.equal(rejected.code, "command-not-issued");
  assert.equal(stateDigest(planned.scenario.state), before);
});

test("execution-phase planning gaps are rejected instead of permanently poisoning C7", () => {
  const planned = buildPlannedScenario(15_900);
  const finding = planningGap(planned.scenario, Object.freeze([planned.atom]), planned.planId, "substantial-path", 15_901);
  const stimulus = planned.scenario.submission(planned.integrator, Object.freeze({ finding, kind: "accept-finding-v2" }), planned.planRoot);
  const before = stateDigest(planned.scenario.state);
  const rejected = planned.scenario.inspect(stimulus);
  assert.equal(rejected.kind, "feedback");
  if (rejected.kind === "feedback") assert.equal(rejected.code, "finding-invalid");
  assert.equal(stateDigest(planned.scenario.state), before);
  assert.equal(planned.scenario.state.planningGap, null);
});

test("T2 anchors are authenticated against sealed atoms and contradiction needs two anchors", () => {
  const substantial = buildT2Scenario(15_950, "substantial-path");
  const foreignEvidence = substantial.scenario.install("foreign-t2-source", Object.freeze({ foreign: true })).reference;
  const tamperedSubstantial = stimulusCapsule.decode(Object.freeze({
    ...substantial.stimulus,
    actionId: substantial.scenario.action(),
    submissionPayload: Object.freeze({ kind: "accept-finding-v2", finding: Object.freeze({ ...substantial.finding, sourceEvidence: Object.freeze([foreignEvidence]) }) }),
  }));
  assert.equal(tamperedSubstantial.kind, "ok");
  if (tamperedSubstantial.kind === "ok") {
    const rejected = prepare(substantial.preterminalState, tamperedSubstantial.value);
    assert.equal(rejected.kind, "feedback");
    if (rejected.kind === "feedback") assert.equal(rejected.code, "invalid-domain-transition");
  }

  const contradiction = buildT2Scenario(15_975, "contradiction");
  const oneAtom = contradiction.finding.atomIds[0];
  const oneAnchor = contradiction.finding.sourceAnchors[0];
  const oneEvidence = contradiction.finding.sourceEvidence[0];
  assert.notEqual(oneAtom, undefined);
  assert.notEqual(oneAnchor, undefined);
  assert.notEqual(oneEvidence, undefined);
  if (oneAtom === undefined || oneAnchor === undefined || oneEvidence === undefined) return;
  const tamperedContradiction = stimulusCapsule.decode(Object.freeze({
    ...contradiction.stimulus,
    actionId: contradiction.scenario.action(),
    submissionPayload: Object.freeze({ kind: "accept-finding-v2", finding: Object.freeze({ ...contradiction.finding, atomIds: Object.freeze([oneAtom]), sourceAnchors: Object.freeze([oneAnchor]), sourceEvidence: Object.freeze([oneEvidence]) }) }),
  }));
  assert.equal(tamperedContradiction.kind, "ok");
  if (tamperedContradiction.kind === "ok") {
    const rejected = prepare(contradiction.preterminalState, tamperedContradiction.value);
    assert.equal(rejected.kind, "feedback");
    if (rejected.kind === "feedback") assert.equal(rejected.code, "invalid-domain-transition");
  }
});

test("stale immutable input roots are inert and do not mutate authority", () => {
  const planned = buildPlannedScenario(16_000);
  const output = planned.scenario.install("stale-output", Object.freeze({ output: true })).root;
  const valid = workOutputSubmission(planned, planned.laneA, "stale", output);
  const staleRoot = planned.scenario.install("stale-input", Object.freeze({ stale: true })).root;
  const decoded = stimulusCapsule.decode(Object.freeze({ ...valid, inputRoot: staleRoot, actionId: planned.scenario.action() }));
  assert.equal(decoded.kind, "ok");
  if (decoded.kind !== "ok") return;
  const before = stateDigest(planned.scenario.state);
  const rejected = planned.scenario.inspect(decoded.value);
  assert.equal(rejected.kind, "feedback");
  if (rejected.kind === "feedback") assert.equal(rejected.code, "stale-input-root");
  assert.equal(stateDigest(planned.scenario.state), before);
});

test("context exhaustion uses exact suspend/resume binding and continues on the current plan", () => {
  const planned = buildPlannedScenario(17_000);
  const suspended = planned.scenario.commit(planned.scenario.suspend("context-exhaustion"));
  assert.equal(suspended.record.kind, "run-suspended");
  assert.equal(planned.scenario.state.suspension.kind, "suspended");
  const candidateResume = planned.scenario.resume();
  const zero = decimalNatural("0");
  assert.notEqual(zero, null);
  if (zero === null) return;
  const mismatched = stimulusCapsule.decode(Object.freeze({ ...candidateResume, actionId: planned.scenario.action(), resumeFromSequence: zero }));
  assert.equal(mismatched.kind, "ok");
  if (mismatched.kind === "ok") {
    const feedback = planned.scenario.inspect(mismatched.value);
    assert.equal(feedback.kind, "feedback");
    if (feedback.kind === "feedback") assert.equal(feedback.code, "resume-binding-mismatch");
  }
  const resumed = planned.scenario.commit(planned.scenario.resume());
  assert.equal(resumed.record.kind, "run-resumed");
  assert.deepEqual(planned.scenario.state.suspension, Object.freeze({ kind: "active" }));
  const continuation = planned.scenario.produceWork(planned.planId, "post-resume", "9");
  const continued = planned.scenario.commit(planned.scenario.boundary(Object.freeze({ kind: "declare-work-v2", workItem: continuation })));
  assert.equal(continued.record.kind, "decision-committed");
  assert.equal(planned.scenario.state.terminal, null);
});
