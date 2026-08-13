import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mintAcceptedBatch } from "../../authority/protocol/accepted-batch.js";
import {
  commandCapsule,
  domainFactCapsule,
  journalRecordCapsule,
} from "../../authority/protocol/aggregate.generated.js";
import { canonicalDecisionFactsDigest } from "../../authority/protocol/journal-record.capsule.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const nextRoot = join(moduleDirectory, "..", "..", "..");

function fixtureValues() {
  const genesis = journalRecordCapsule.arbitrary.validForKind("run-genesis", 8100);
  const fact = domainFactCapsule.arbitrary.validForKind("requirements-bound", 8101);
  const command = commandCapsule.arbitrary.validForKind("prepare-workspace", 8102);
  const decision = journalRecordCapsule.arbitrary.validForKind("decision-committed", 8103);
  if (
    genesis.kind !== "run-genesis"
    || fact.kind !== "requirements-bound"
    || command.kind !== "prepare-workspace"
    || decision.kind !== "decision-committed"
  ) {
    return null;
  }
  const normalizedFact = Object.freeze({ ...fact, runId: genesis.runId });
  const normalizedCommand = Object.freeze({ ...command, runId: genesis.runId });
  const boundDecision = journalRecordCapsule.decode({
    ...decision,
    runId: genesis.runId,
    facts: [normalizedFact],
    factRoot: canonicalDecisionFactsDigest([normalizedFact]),
  });
  if (boundDecision.kind === "error" || boundDecision.value.kind !== "decision-committed") {
    return null;
  }
  return Object.freeze({
    genesis,
    fact: normalizedFact,
    command: normalizedCommand,
    decision: boundDecision.value,
  });
}

test("AcceptedBatch value mint is restricted to facade, including aliased imports", () => {
  const checker = readFileSync(
    join(nextRoot, "policy-root", "architecture-checker.ts"),
    "utf8",
  );
  assert.equal(checker.includes("AcceptedBatch mint capability may be value-imported only"), true);
  assert.equal(checker.includes("importEdgeIsTypeOnly"), true);
  assert.equal(checker.includes('name === "mintAcceptedBatch"'), true);
});

test("AcceptedBatch canonical mint owns aliases and rejects facts/factRoot mismatch", () => {
  const values = fixtureValues();
  assert.notEqual(values, null);
  if (values === null) {
    return;
  }
  const mutableFacts = [values.fact];
  const mutableCommands = [values.command];
  const minted = mintAcceptedBatch(Object.freeze({
    runId: values.genesis.runId,
    facts: mutableFacts,
    commands: mutableCommands,
    outcome: null,
    factRoot: values.decision.factRoot,
    commandRoot: values.command.baseRoot,
    stateDigest: journalRecordCapsule.digest(values.genesis),
  }));
  assert.equal(minted.kind, "minted");
  if (minted.kind !== "minted") {
    return;
  }
  assert.notEqual(minted.batch.facts, mutableFacts);
  assert.notEqual(minted.batch.commands, mutableCommands);
  assert.notEqual(minted.batch.facts[0], mutableFacts[0]);
  assert.notEqual(minted.batch.commands[0], mutableCommands[0]);
  mutableFacts.length = 0;
  mutableCommands.length = 0;
  assert.equal(minted.batch.facts.length, 1);
  assert.equal(minted.batch.commands.length, 1);
  assert.equal(Object.isFrozen(minted.batch), true);
  assert.equal(Object.isFrozen(minted.batch.facts), true);
  assert.equal(Object.isFrozen(minted.batch.commands), true);
  assert.equal(Object.isFrozen(minted.batch.facts[0]), true);
  assert.equal(Object.isFrozen(minted.batch.commands[0]), true);
  const spreadClone = { ...minted.batch };
  const assignedClone = Object.assign({}, minted.batch);
  assert.equal(Reflect.ownKeys(spreadClone).some((key) => typeof key === "symbol"), false);
  assert.equal(Reflect.ownKeys(assignedClone).some((key) => typeof key === "symbol"), false);

  assert.notEqual(values.command.baseRoot, values.decision.factRoot);
  const mismatch = mintAcceptedBatch(Object.freeze({
    runId: values.genesis.runId,
    facts: [values.fact],
    commands: [values.command],
    outcome: null,
    factRoot: values.command.baseRoot,
    commandRoot: values.command.baseRoot,
    stateDigest: journalRecordCapsule.digest(values.genesis),
  }));
  assert.equal(mismatch.kind, "invalid");
  if (mismatch.kind === "invalid") {
    assert.equal(mismatch.member, "factRoot");
    assert.equal(mismatch.error.diagnostic, "canonical ordered facts do not hash to factRoot");
  }
});
