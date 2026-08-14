import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initial, project, replay } from "../../authority/facade/index.js";
import { incrementDecimalNatural } from "../../authority/protocol/identifiers.js";
import { journalRecordCapsule } from "../../authority/protocol/journal-record.capsule.js";
import { stateDigest } from "../../authority/model/run-state.js";
import { declaredWorkStimulus, nonemptyScenario, prepareScenarioCommit, scenarioGenesis } from "../scenario-harness/authority.js";

for (let seed = 0; seed < 32; seed += 1) {
  test(`same nonempty journal has one replay digest seed=${String(seed)}`, () => {
    const fixture = nonemptyScenario(seed * 17 + 1);
    const left = replay(initial(fixture.genesis), Object.freeze([fixture.commit.record]));
    const right = replay(initial(fixture.genesis), Object.freeze([fixture.commit.record]));
    assert.equal(left.kind, "applied");
    assert.equal(right.kind, "applied");
    assert.equal(stateDigest(left.state), stateDigest(right.state));
    assert.ok(fixture.commit.record.kind === "decision-committed" && fixture.commit.record.facts.length > 0 && fixture.commit.record.commands.length > 0);
  });
}

test("nonempty replay digest is stable across processes, locales, and timezones", () => {
  const helper = fileURLToPath(new URL("./replay-digest-process.js", import.meta.url));
  const environments = Object.freeze([
    Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" }),
    Object.freeze({ LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8", TZ: "Pacific/Chatham" }),
    Object.freeze({ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "Asia/Tokyo" }),
  ]);
  const digests = environments.map((environment) => {
    const child = spawnSync(process.execPath, [helper, "901"], { encoding: "utf8", env: Object.freeze({ ...process.env, ...environment }) });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  });
  assert.equal(new Set(digests).size, 1);
  assert.match(digests[0] ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("exact successor, stale sequence, gaps, and run mismatch fail closed", () => {
  const fixture = nonemptyScenario(1200);
  const record = fixture.commit.record;
  assert.notEqual(record.kind, "run-genesis");
  if (record.kind === "run-genesis") return;
  const stale = replay(fixture.state, Object.freeze([Object.freeze({ ...record, sequence: fixture.state.lastSequence })]));
  assert.equal(stale.kind, "rejected");
  if (stale.kind === "rejected") assert.equal(stale.error.code, "stale-sequence");
  const gapSequence = incrementDecimalNatural(incrementDecimalNatural(fixture.state.lastSequence));
  const gap = replay(fixture.state, Object.freeze([Object.freeze({ ...record, sequence: gapSequence })]));
  assert.equal(gap.kind, "rejected");
  if (gap.kind === "rejected") assert.equal(gap.error.code, "sequence-gap");
  const other = scenarioGenesis(1201);
  const wrongRun = replay(initial(other), Object.freeze([record]));
  assert.equal(wrongRun.kind, "rejected");
  if (wrongRun.kind === "rejected") assert.equal(wrongRun.error.code, "run-mismatch");
});

test("record order is state-bound and projection does not affect replay", () => {
  const first = nonemptyScenario(1300);
  const secondStimulus = declaredWorkStimulus(first.state, 1310);
  const secondCommit = prepareScenarioCommit(first.state, secondStimulus);
  const forward = replay(initial(first.genesis), Object.freeze([first.commit.record, secondCommit.record]));
  const reverse = replay(initial(first.genesis), Object.freeze([secondCommit.record, first.commit.record]));
  assert.equal(forward.kind, "applied");
  assert.equal(reverse.kind, "rejected");
  const beforeProjection = stateDigest(forward.state);
  const view = project(forward.state);
  assert.equal(view.runId, first.genesis.runId);
  assert.equal(stateDigest(forward.state), beforeProjection);
});

test("journal arbitrary exposes exactly the six closed record families", () => {
  assert.deepEqual(journalRecordCapsule.kinds, Object.freeze([
    "command-settled",
    "decision-committed",
    "outcome-committed",
    "run-genesis",
    "run-resumed",
    "run-suspended",
  ]));
});
