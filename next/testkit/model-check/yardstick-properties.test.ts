import assert from "node:assert/strict";
import test from "node:test";
import { initial, prepare, replay } from "../../authority/facade/index.js";
import { t1Checks } from "../../authority/outcome/index.js";
import { MAX_HOT_INDEX_VALUES } from "../../authority/model/authenticated-index.js";
import { stateDigest } from "../../authority/model/run-state.js";
import { commandCapsule, commandExhaustive } from "../../authority/protocol/command.capsule.js";
import { decimalNatural, incrementDecimalNatural } from "../../authority/protocol/identifiers.js";
import { journalRecordCapsule } from "../../authority/protocol/journal-record.capsule.js";
import { stimulusCapsule, stimulusExhaustive } from "../../authority/protocol/stimulus.capsule.js";
import { terminalOutcomeCapsule } from "../../authority/protocol/terminal-outcome.capsule.js";
import { workItemCapsule, workItemExhaustive } from "../../authority/protocol/work-item.capsule.js";
import { applyScenarioCommit, declaredWorkStimulus, nonemptyScenario, prepareScenarioCommit, scenarioGenesis } from "../scenario-harness/authority.js";
import { blockingFinding, buildPlannedScenario, buildT1Scenario, buildT2Scenario } from "../scenario-harness/full-run.js";

test("prepared mutations are exact and tampering fails closed", () => {
  const fixture = nonemptyScenario(5100);
  assert.equal(fixture.commit.record.kind, "decision-committed");
  if (fixture.commit.record.kind !== "decision-committed") return;
  const mutation = fixture.commit.record.mutations[0];
  assert.notEqual(mutation, undefined);
  if (mutation === undefined) return;
  const tampered = Object.freeze({
    ...fixture.commit.record,
    mutations: Object.freeze([
      Object.freeze({ ...mutation, siblings: Object.freeze(mutation.siblings.slice().reverse()) }),
      ...fixture.commit.record.mutations.slice(1),
    ]),
  });
  const result = replay(fixture.initialState, Object.freeze([tampered]));
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.ok(["index-mutation-mismatch", "index-proof-invalid", "result-state-mismatch"].includes(result.error.code));
});

test("bounded authenticated work state fails closed before exceeding the hot cap", () => {
  const genesis = scenarioGenesis(5200);
  let state = initial(genesis);
  for (let index = 0; index < MAX_HOT_INDEX_VALUES; index += 1) {
    const stimulus = declaredWorkStimulus(state, 5210 + index * 3);
    state = applyScenarioCommit(state, prepareScenarioCommit(state, stimulus));
    assert.ok(state.indexes.work.hot.length <= MAX_HOT_INDEX_VALUES);
  }
  assert.equal(state.indexes.work.hot.length, MAX_HOT_INDEX_VALUES);
  const overflow = prepare(state, declaredWorkStimulus(state, 5900));
  assert.equal(overflow.kind, "feedback");
  if (overflow.kind === "feedback") assert.equal(overflow.code, "page-unproven");
  assert.equal(state.indexes.work.hot.length, MAX_HOT_INDEX_VALUES);
});

test("decimal sequencing remains exact beyond Number.MAX_SAFE_INTEGER", () => {
  const template = scenarioGenesis(5300);
  const huge = decimalNatural("900719925474099312345678901234567890");
  assert.notEqual(huge, null);
  if (huge === null) return;
  const decoded = journalRecordCapsule.decode(Object.freeze({ ...template, sequence: huge }));
  assert.equal(decoded.kind, "ok");
  if (decoded.kind !== "ok" || decoded.value.kind !== "run-genesis") return;
  const state = initial(decoded.value);
  assert.equal(incrementDecimalNatural(state.lastSequence), "900719925474099312345678901234567891");
});

test("duplicate action identity is rejected without state mutation", () => {
  const fixture = nonemptyScenario(5400);
  const before = stateDigest(fixture.state);
  const duplicate = prepare(fixture.state, fixture.stimulus);
  assert.equal(duplicate.kind, "feedback");
  if (duplicate.kind === "feedback") assert.equal(duplicate.code, "action-already-committed");
  assert.equal(stateDigest(fixture.state), before);
});

test("closed public unions expose no third terminal and exhaustive handler maps match", () => {
  assert.deepEqual(terminalOutcomeCapsule.kinds, Object.freeze(["t1", "t2"]));
  assert.deepEqual(Object.keys(commandExhaustive).sort(), commandCapsule.kinds.slice().sort());
  assert.deepEqual(Object.keys(stimulusExhaustive).sort(), stimulusCapsule.kinds.slice().sort());
  assert.deepEqual(Object.keys(workItemExhaustive).sort(), workItemCapsule.kinds.slice().sort());
});

test("command identity is deterministic and a committed command is not reissued", () => {
  const first = nonemptyScenario(5500);
  assert.equal(first.commit.record.kind, "decision-committed");
  if (first.commit.record.kind !== "decision-committed") return;
  const commandIds = first.commit.record.commands.map((command) => command.commandId);
  assert.equal(new Set(commandIds).size, commandIds.length);
  const next = declaredWorkStimulus(first.state, 5577);
  const committed = prepareScenarioCommit(first.state, next);
  assert.equal(committed.record.kind, "decision-committed");
  if (committed.record.kind === "decision-committed") {
    const nextIds = committed.record.commands.map((command) => command.commandId);
    assert.equal(nextIds.some((id) => commandIds.includes(id)), false);
  }
});

test("every generated public T1 satisfies C1–C7 and exact publication/evidence bindings", () => {
  for (const seed of [20_000, 20_101, 20_303]) {
    const result = buildT1Scenario(seed);
    const terminal = result.scenario.state.terminal;
    assert.equal(terminal?.outcome.kind, "t1");
    if (terminal?.outcome.kind !== "t1") continue;
    const checks = t1Checks(result.scenario.state, Object.freeze([]));
    assert.equal(Object.values(checks).every((value) => value), true, `T1 checks failed for seed ${String(seed)}`);
    const candidate = result.scenario.state.currentCandidate;
    const publication = result.scenario.state.currentPublication;
    const attestations = result.scenario.state.finalAttestations;
    assert.notEqual(candidate, null);
    assert.notEqual(publication, null);
    assert.notEqual(attestations, null);
    if (candidate === null || publication === null || attestations === null) continue;
    assert.equal(terminal.outcome.candidateId, candidate.candidateId);
    assert.equal(terminal.outcome.finalTree, candidate.tree);
    assert.equal(terminal.outcome.gitTree, candidate.gitTree);
    assert.equal(terminal.outcome.publicationId, publication.publicationId);
    assert.equal(terminal.outcome.publishedRevision, publication.observedHead);
    assert.equal(terminal.outcome.evidenceIndexRoot, result.scenario.state.indexes.evidence.root);
    assert.equal(result.finalEvidence.envelope.class, "final-verification");
    assert.equal(result.finalEvidence.envelope.acceptedOutput, candidate.tree);
    assert.equal(result.finalEvidence.envelope.exit.kind, "exited");
    if (result.finalEvidence.envelope.exit.kind === "exited") assert.equal(result.finalEvidence.envelope.exit.code, "0");
  }
});

test("generated T2 outcomes cover exactly both ruled conditions and preserve exact anchors", () => {
  const observed = new Set<string>();
  for (let index = 0; index < 8; index += 1) {
    const reason = index % 2 === 0 ? "substantial-path" : "contradiction";
    const result = buildT2Scenario(21_000 + index * 17, reason);
    const terminal = result.scenario.state.terminal;
    assert.equal(terminal?.outcome.kind, "t2");
    if (terminal?.outcome.kind !== "t2") continue;
    observed.add(terminal.outcome.reason);
    assert.equal(terminal.outcome.reason, reason);
    assert.deepEqual(terminal.outcome.sourceAnchors, result.finding.sourceAnchors);
    assert.deepEqual(terminal.outcome.sourceEvidence, result.finding.sourceEvidence);
    assert.deepEqual(result.finding.atomIds, Object.freeze([result.atom.atomId]));
    assert.equal(result.scenario.artifacts.read(terminal.outcome.explanation).kind, "ok");
    assert.equal(terminal.outcome.sourceEvidence.every((reference) => result.scenario.artifacts.read(reference).kind === "ok"), true);
  }
  assert.deepEqual([...observed].sort(), ["contradiction", "substantial-path"]);
});

test("every generated blocker scope has one deterministic authority-derived A3 corrector", () => {
  const planned = buildPlannedScenario(22_000);
  const cases = Object.freeze([
    Object.freeze({ kind: "integrity", scope: "local", owner: planned.laneA.workItemId }),
    Object.freeze({ kind: "definition-of-done", scope: "local", owner: planned.laneA.workItemId }),
    Object.freeze({ kind: "integrity", scope: "plan-wide", owner: planned.author.workItemId }),
    Object.freeze({ kind: "definition-of-done", scope: "plan-wide", owner: planned.author.workItemId }),
    Object.freeze({ kind: "integrity", scope: "cross-lane", owner: planned.integrator.workItemId }),
    Object.freeze({ kind: "definition-of-done", scope: "cross-lane", owner: planned.integrator.workItemId }),
  ]);
  for (let index = 0; index < cases.length; index += 1) {
    const expected = cases[index];
    if (expected === undefined) continue;
    const finding = blockingFinding(planned, expected.kind, expected.scope, 22_100 + index * 31);
    const stimulus = planned.scenario.submission(planned.integrator, Object.freeze({ finding, kind: "accept-finding-v2" }), planned.planRoot);
    const first = planned.scenario.inspect(stimulus);
    const repeated = planned.scenario.inspect(stimulus);
    assert.notEqual(first.kind, "feedback");
    assert.notEqual(repeated.kind, "feedback");
    if (first.kind === "feedback" || repeated.kind === "feedback") continue;
    assert.equal(journalRecordCapsule.digest(first.record), journalRecordCapsule.digest(repeated.record));
    const accepted = first.record.kind === "decision-committed" ? first.record.facts.find((fact) => fact.kind === "finding-accepted") : undefined;
    assert.ok(accepted?.kind === "finding-accepted" && accepted.acceptance.kind === "blocking-with-correction");
    if (accepted?.kind !== "finding-accepted" || accepted.acceptance.kind !== "blocking-with-correction") continue;
    assert.equal(accepted.acceptance.correction.scope, expected.scope);
    assert.equal(accepted.acceptance.correction.originalOwnerWorkItemId, expected.owner);
    assert.equal(accepted.acceptance.correction.work.originalOwnerWorkItemId, expected.owner);
    assert.equal(accepted.acceptance.correction.work.findingId, finding.findingId);
    planned.scenario.commit(stimulus);
  }
  assert.equal(planned.scenario.state.counters.openBlockingFindings, "6");
  assert.equal(planned.scenario.state.terminal, null);
});
