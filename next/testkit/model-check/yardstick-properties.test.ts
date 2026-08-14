import assert from "node:assert/strict";
import test from "node:test";
import { initial, prepare, replay } from "../../authority/facade/index.js";
import { MAX_HOT_INDEX_VALUES } from "../../authority/model/authenticated-index.js";
import { stateDigest } from "../../authority/model/run-state.js";
import { commandCapsule, commandExhaustive } from "../../authority/protocol/command.capsule.js";
import { decimalNatural, incrementDecimalNatural } from "../../authority/protocol/identifiers.js";
import { journalRecordCapsule } from "../../authority/protocol/journal-record.capsule.js";
import { stimulusCapsule, stimulusExhaustive } from "../../authority/protocol/stimulus.capsule.js";
import { terminalOutcomeCapsule } from "../../authority/protocol/terminal-outcome.capsule.js";
import { workItemCapsule, workItemExhaustive } from "../../authority/protocol/work-item.capsule.js";
import { applyScenarioCommit, declaredWorkStimulus, nonemptyScenario, prepareScenarioCommit, scenarioGenesis } from "../scenario-harness/authority.js";

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
  const next = declaredWorkStimulus(first.state, 5510);
  const committed = prepareScenarioCommit(first.state, next);
  assert.equal(committed.record.kind, "decision-committed");
  if (committed.record.kind === "decision-committed") {
    const nextIds = committed.record.commands.map((command) => command.commandId);
    assert.equal(nextIds.some((id) => commandIds.includes(id)), false);
  }
});
