import { childIntentCapsule } from "../contracts/child.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, lawCall } from "./vector-helpers.js";

export const childLawVector: ContractVector = Object.freeze({
  id: "child.route-before-launch-continuation-reseed.v2",
  port: "child",
  behaviors: Object.freeze([
    "Pi subscription route verification is a separately journalable operation",
    "launch binds exact route/version/catalog/policy/tool attestation and capture limits",
    "initial and continuation seeds are closed explicit shapes",
    "inspect/fence use durable descriptors and epochs rather than an adapter registry",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const launchTemplate = childIntentCapsule.arbitrary.validForKind("launch-child-session", 51);
    const routeTemplate = childIntentCapsule.arbitrary.validForKind("verify-pi-route", 50);
    const tree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "child-v2-base",
      files: Object.freeze([Object.freeze({ path: "law/child.bin", bytes: Uint8Array.from([2, 4, 6]) })]),
    }));
    if (tree.kind !== "tree") {
      return lawTrace(this.id, trace, ["child tree fixture failed"]);
    }
    const workspace = await driver.fixture(Object.freeze({ kind: "workspace", name: "child-v2-workspace", treeName: tree.name }));
    if (workspace.kind !== "workspace" || launchTemplate.kind !== "launch-child-session" || routeTemplate.kind !== "verify-pi-route") {
      return lawTrace(this.id, trace, ["child fixtures failed"]);
    }
    const verifiedRoute = Object.freeze({ ...routeTemplate.inputs.route, toolBundleAttestation: null });
    await driver.fixture(Object.freeze({
      kind: "child-script",
      name: "child-v2-script",
      workItemId: launchTemplate.inputs.workItemId,
      workspaceName: workspace.name,
      writes: Object.freeze([]),
      sealTick: "2",
      terminal: "exit",
      terminalTick: "3",
    }));
    const verify = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({ captureId: routeTemplate.inputs.captureId, route: verifiedRoute }),
      kind: "verify-pi-route",
      preconditions: routeTemplate.preconditions,
      runId: launchTemplate.runId,
    }));
    const verified = await lawCall(driver, "child", "verify-route", verify, "pi-route-verified", "ok");
    trace.push(verified.trace);
    collectFinding(findings, verified.finding);
    const verification = field(verified.value, "observationId");
    if (typeof verification !== "string") {
      return lawTrace(this.id, trace, [...findings, "verify-route: observation ID absent"]);
    }
    const launch = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({
        ...launchTemplate.inputs,
        memorySeed: Object.freeze({ initialPrompt: tree.manifest, kind: "initial" }),
        policyRoot: tree.root,
        route: verifiedRoute,
        runtimeRoot: tree.root,
        workspaceCapability: workspace.workspaceCapability,
        workspaceId: workspace.workspaceId,
      }),
      kind: "launch-child-session",
      preconditions: Object.freeze({
        ...launchTemplate.preconditions,
        expectedWorkspaceRoot: workspace.root,
        routeObservation: tree.firstFile,
        routeObservationId: verification,
      }),
      runId: launchTemplate.runId,
    }));
    const launched = await lawCall(driver, "child", "launch-bound-route", launch, "child-session-launched", "ok");
    trace.push(launched.trace);
    collectFinding(findings, launched.finding);
    const childId = field(launched.value, "childId");
    const descriptor = field(launched.value, "processDescriptor");
    if (typeof childId !== "string" || descriptor === null || descriptor === undefined) {
      return lawTrace(this.id, trace, [...findings, "launch: durable child descriptor absent"]);
    }
    await driver.advance("3");
    const inspectTemplate = childIntentCapsule.arbitrary.validForKind("inspect-child-session", 52);
    if (inspectTemplate.kind === "inspect-child-session") {
      const inspect = bindLawIntent("child", Object.freeze({
        inputs: Object.freeze({ childId, processDescriptor: descriptor }),
        kind: "inspect-child-session",
        preconditions: Object.freeze({ childEpoch: launchTemplate.preconditions.childEpoch }),
        runId: launchTemplate.runId,
      }));
      const inspected = await lawCall(driver, "child", "inspect-descriptor", inspect, "child-session-inspected", "ok");
      trace.push(inspected.trace);
      collectFinding(findings, inspected.finding);
    }
    const fenceTemplate = childIntentCapsule.arbitrary.validForKind("fence-child-session", 53);
    if (fenceTemplate.kind === "fence-child-session") {
      const fence = bindLawIntent("child", Object.freeze({
        inputs: Object.freeze({ childId, processDescriptor: descriptor }),
        kind: "fence-child-session",
        preconditions: Object.freeze({
          childEpoch: launchTemplate.preconditions.childEpoch,
          replacementEpoch: String(BigInt(launchTemplate.preconditions.childEpoch) + 1n),
        }),
        runId: launchTemplate.runId,
      }));
      const fenced = await lawCall(driver, "child", "fence-descriptor", fence, "child-session-fenced", "ok");
      trace.push(fenced.trace);
      collectFinding(findings, fenced.finding);
      if (field(fenced.value, "state") !== "fenced" && field(fenced.value, "state") !== "already-absent") {
        findings.push("fence-descriptor: closed fence state absent");
      }
    }
    return lawTrace(this.id, trace, findings);
  },
});
