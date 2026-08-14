import assert from "node:assert/strict";
import test from "node:test";
import { prepareGenesis } from "../../authority/facade/index.js";
import { isPreparedCommit } from "../../authority/protocol/accepted-batch.js";
import { recordSemanticRootsMatch } from "../../authority/protocol/journal-record.capsule.js";
import { nonemptyScenario, scenarioGenesis } from "../scenario-harness/authority.js";

test("facade genesis and semantic preparation mint opaque PreparedCommit capabilities", () => {
  const genesis = prepareGenesis(scenarioGenesis(400));
  assert.notEqual(genesis, null);
  assert.equal(isPreparedCommit(genesis), true);
  const semantic = nonemptyScenario(401).commit;
  assert.equal(isPreparedCommit(semantic), true);
  assert.equal(semantic.record.kind, "decision-committed");
  if (semantic.record.kind === "decision-committed") assert.equal(recordSemanticRootsMatch(semantic.record), true);
});

test("spread, JSON round-trip, and lookalike objects cannot forge PreparedCommit", () => {
  const commit = nonemptyScenario(402).commit;
  const spread = Object.freeze({ ...commit });
  const encoded = JSON.stringify(commit);
  const parsed: unknown = JSON.parse(encoded);
  const lookalike = Object.freeze({ kind: commit.kind, record: commit.record });
  assert.equal(isPreparedCommit(spread), false);
  assert.equal(isPreparedCommit(parsed), false);
  assert.equal(isPreparedCommit(lookalike), false);
  assert.equal(Object.getOwnPropertySymbols(commit).length, 1);
  assert.deepEqual(Object.keys(commit).sort(), ["kind", "record"]);
});

test("PreparedCommit record cannot be changed without losing authority capability", () => {
  const commit = nonemptyScenario(403).commit;
  const changed = Object.freeze({ ...commit, record: scenarioGenesis(404) });
  assert.equal(isPreparedCommit(changed), false);
  assert.equal(isPreparedCommit(commit), true);
});
