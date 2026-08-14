import assert from "node:assert/strict";
import test from "node:test";
import { childIntentCapsule } from "../../../ports/contracts/child.capsule.js";
import { childLawVector } from "../../../ports/laws/child.vectors.js";
import { clockLawVector } from "../../../ports/laws/clock.vectors.js";
import { secretsLawVector } from "../../../ports/laws/secrets.vectors.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import type { LawVectorResult } from "../../../ports/laws/contract-vector.js";
import { SimLawDriver } from "../../simulation/law-driver.js";
import { RealL7LawDriver } from "./l7-law-driver.js";

function field(input: unknown, name: string): unknown {
  try { return typeof input === "object" && input !== null ? Reflect.get(input, name) : undefined; } catch { return undefined; }
}

function behavioralTrace(result: LawVectorResult) {
  return result.trace.map((entry) => Object.freeze({
    operation: entry.operation,
    observationKind: entry.observationKind,
    result: entry.result,
    diagnosticCode: entry.diagnosticCode,
    evidenceVerified: entry.artifactEvidence.every((evidence) => evidence.verified),
  }));
}

async function assertRealParity(
  vector: typeof childLawVector | typeof clockLawVector | typeof secretsLawVector,
  seed: number,
): Promise<void> {
  const real = await RealL7LawDriver.create();
  try {
    const realResult = await vector.replay(real);
    const simulated = await vector.replay(new SimLawDriver(seed));
    assert.deepEqual(realResult.findings, [], realResult.findings.join("; "));
    assert.deepEqual(simulated.findings, []);
    assert.deepEqual(behavioralTrace(realResult), behavioralTrace(simulated));
    assert.equal(realResult.trace.length > 0, true);
    assert.equal(realResult.trace.flatMap((entry) => entry.artifactEvidence).every((evidence) => evidence.verified), true);
  } finally {
    await real.dispose();
  }
}

test("real Pi child adapter matches the frozen child law through shell-free process groups", { timeout: 30_000 }, async () => {
  await assertRealParity(childLawVector, 51);
});

test("real monotonic clock adapter matches arbitrary-precision decimal law behavior", async () => {
  await assertRealParity(clockLawVector, 31);
});

test("real descriptor-bound secrets adapter matches opaque authorize/revoke behavior", { timeout: 30_000 }, async () => {
  await assertRealParity(secretsLawVector, 62);
});

test("cold Pi adapter restart inspects and fences solely from CAS descriptor and epoch", { timeout: 30_000 }, async () => {
  const driver = await RealL7LawDriver.create();
  try {
    const child = await driver.fixture(Object.freeze({ kind: "active-child", name: "cold-restart" }));
    assert.equal(child.kind, "active-child");
    if (child.kind !== "active-child") return;
    driver.restartChildAdapter();
    const inspectTemplate = childIntentCapsule.arbitrary.validForKind("inspect-child-session", 301);
    assert.equal(inspectTemplate.kind, "inspect-child-session");
    if (inspectTemplate.kind !== "inspect-child-session") return;
    const inspect = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({ childId: child.childId, processDescriptor: child.processDescriptor }),
      kind: "inspect-child-session",
      preconditions: Object.freeze({ childEpoch: child.childEpoch }),
      runId: child.runId,
    }));
    const inspected = await driver.dispatch("child", inspect ?? null);
    assert.equal(typeof inspected, "object");
    assert.equal(field(inspected, "kind"), "observation");
    const inspectionObservation = field(inspected, "observation");
    assert.equal(field(inspectionObservation, "kind"), "child-session-inspected");
    assert.equal(field(field(inspectionObservation, "result"), "kind"), "ok");

    const fence = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({ childId: child.childId, processDescriptor: child.processDescriptor }),
      kind: "fence-child-session",
      preconditions: Object.freeze({ childEpoch: child.childEpoch, replacementEpoch: String(BigInt(child.childEpoch) + 1n) }),
      runId: child.runId,
    }));
    const fenced = await driver.dispatch("child", fence ?? null);
    assert.equal(field(fenced, "kind"), "observation");
    const fenceObservation = field(fenced, "observation");
    assert.equal(field(fenceObservation, "kind"), "child-session-fenced");
    assert.equal(field(field(fenceObservation, "result"), "kind"), "ok");

    driver.restartChildAdapter();
    const after = await driver.dispatch("child", inspect ?? null);
    assert.equal(field(after, "kind"), "observation");
    const afterValue = field(field(field(after, "observation"), "result"), "value");
    assert.equal(field(afterValue, "state"), "absent");
  } finally {
    await driver.dispose();
  }
});

test("wrong descriptor metadata cannot become cold child authority", { timeout: 30_000 }, async () => {
  const driver = await RealL7LawDriver.create();
  try {
    const child = await driver.fixture(Object.freeze({ kind: "active-child", name: "descriptor-mismatch" }));
    assert.equal(child.kind, "active-child");
    if (child.kind !== "active-child") return;
    const template = childIntentCapsule.arbitrary.validForKind("inspect-child-session", 401);
    assert.equal(template.kind, "inspect-child-session");
    if (template.kind !== "inspect-child-session") return;
    const wrong = childIntentCapsule.arbitrary.validForKind("launch-child-session", 402);
    assert.equal(wrong.kind, "launch-child-session");
    if (wrong.kind !== "launch-child-session") return;
    const inspect = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({ childId: wrong.inputs.workItemId, processDescriptor: child.processDescriptor }),
      kind: "inspect-child-session",
      preconditions: Object.freeze({ childEpoch: child.childEpoch }),
      runId: child.runId,
    }));
    const result = await driver.dispatch("child", inspect ?? null);
    assert.equal(field(result, "kind"), "observation");
    const observation = field(result, "observation");
    assert.equal(field(observation, "kind"), "child-session-inspected");
    const toolResult = field(observation, "result");
    assert.equal(field(toolResult, "kind"), "retry");
  } finally {
    await driver.dispose();
  }
});
