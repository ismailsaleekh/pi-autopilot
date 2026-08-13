import { childIntentCapsule } from "../contracts/child.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, lawCall } from "./vector-helpers.js";

export const childLawVector: ContractVector = Object.freeze({
  id: "child.script-write-seal-exit-fence.v1",
  port: "child",
  behaviors: Object.freeze([
    "scripts are selected by immutable work-item/action identity",
    "writes happen only at explicit virtual ticks",
    "seal captures immutable output before exit",
    "inspection normalizes exit and fencing rejects stale epochs",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const tree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "child-base",
      files: Object.freeze([
        Object.freeze({ path: "law/input.bin", bytes: Uint8Array.from([1]) }),
      ]),
    }));
    const workspace = await driver.fixture(Object.freeze({
      kind: "workspace",
      name: "child-workspace",
      treeName: "child-base",
    }));
    const launchTemplate = childIntentCapsule.arbitrary.validForKind("launch-child-session", 51);
    if (tree.kind !== "tree" || workspace.kind !== "workspace" || launchTemplate.kind !== "launch-child-session") {
      return lawTrace("child.script-write-seal-exit-fence.v1", trace, Object.freeze(["child fixture failed"]));
    }
    const script = await driver.fixture(Object.freeze({
      kind: "child-script",
      name: "child-script",
      workItemId: launchTemplate.inputs.workItemId,
      workspaceName: "child-workspace",
      writes: Object.freeze([
        Object.freeze({ tick: 1, path: "law/output.bin", bytes: Uint8Array.from([0, 2, 255]) }),
      ]),
      sealTick: 2,
      terminal: "exit",
      terminalTick: 3,
    }));
    if (script.kind !== "child-script") {
      return lawTrace("child.script-write-seal-exit-fence.v1", trace, Object.freeze(["child script registration failed"]));
    }
    const launch = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({
        attemptId: launchTemplate.inputs.attemptId,
        prompt: launchTemplate.inputs.prompt,
        roleId: launchTemplate.inputs.roleId,
        runtimeRoot: launchTemplate.inputs.runtimeRoot,
        workItemId: launchTemplate.inputs.workItemId,
        workspaceId: workspace.workspaceId,
      }),
      kind: "launch-child-session",
      preconditions: Object.freeze({
        childEpoch: launchTemplate.preconditions.childEpoch,
        expectedWorkspaceRoot: workspace.root,
        runtimeDigest: launchTemplate.inputs.runtimeRoot,
      }),
      runId: launchTemplate.runId,
    }));
    const launched = await lawCall(driver, "child", "launch", launch, "child-session-launched", "ok");
    trace.push(launched.trace);
    collectFinding(findings, launched.finding);
    const childId = field(launched.value, "childId");
    const childEpoch = field(launched.value, "childEpoch");
    if (typeof childId !== "string" || typeof childEpoch !== "string") {
      findings.push("launch: child identity was absent");
      return lawTrace("child.script-write-seal-exit-fence.v1", trace, findings);
    }
    await driver.advance(3);
    const inspect = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({ childId }),
      kind: "inspect-child-session",
      preconditions: Object.freeze({ childEpoch }),
      runId: launchTemplate.runId,
    }));
    const inspected = await lawCall(driver, "child", "inspect", inspect, "child-session-inspected", "ok");
    trace.push(inspected.trace);
    collectFinding(findings, inspected.finding);
    if (field(inspected.value, "state") !== "quiescent" || field(inspected.value, "sealedRoot") === null) {
      findings.push("inspect: child did not exit quiescent with a sealed root");
    }

    const fenceTemplate = childIntentCapsule.arbitrary.validForKind("fence-child-session", 52);
    if (fenceTemplate.kind !== "fence-child-session") {
      findings.push("fence template failed");
    } else {
      const fence = bindLawIntent("child", Object.freeze({
        inputs: Object.freeze({ childId }),
        kind: "fence-child-session",
        preconditions: Object.freeze({
          childEpoch,
          replacementEpoch: fenceTemplate.preconditions.replacementEpoch,
        }),
        runId: launchTemplate.runId,
      }));
      const fenced = await lawCall(driver, "child", "fence", fence, "child-session-fenced", "ok");
      trace.push(fenced.trace);
      collectFinding(findings, fenced.finding);
    }
    return lawTrace("child.script-write-seal-exit-fence.v1", trace, findings);
  },
});
