import { workspaceIntentCapsule } from "../contracts/workspace.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, lawCall } from "./vector-helpers.js";

export const workspaceLawVector: ContractVector = Object.freeze({
  id: "workspace.empty-reservation-lease-epoch.v2",
  port: "workspace",
  behaviors: Object.freeze([
    "allocation creates an empty private reservation and duplicate allocation retries",
    "lease, capability, root, and child epoch are checked on every transition",
    "isolation success carries an enforcement attestation",
    "disposal requires a fenced epoch and inspection proves absence",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const allocateTemplate = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 11);
    if (allocateTemplate.kind !== "allocate-attempt-directory") {
      return lawTrace(this.id, trace, ["allocation template failed"]);
    }
    const allocate = bindLawIntent("workspace", Object.freeze({
      inputs: allocateTemplate.inputs,
      kind: allocateTemplate.kind,
      preconditions: allocateTemplate.preconditions,
      runId: allocateTemplate.runId,
    }));
    const allocated = await lawCall(driver, "workspace", "allocate-empty", allocate, "attempt-directory-allocated", "ok");
    trace.push(allocated.trace);
    collectFinding(findings, allocated.finding);
    if (field(allocated.value, "empty") !== true) {
      findings.push("allocate-empty: reservation was not proved empty");
    }
    const duplicate = await lawCall(driver, "workspace", "allocate-duplicate", allocate, "attempt-directory-allocated", "retry");
    trace.push(duplicate.trace);
    collectFinding(findings, duplicate.finding);

    const inspectTemplate = workspaceIntentCapsule.arbitrary.validForKind("inspect-attempt-directory", 12);
    if (inspectTemplate.kind === "inspect-attempt-directory") {
      const inspect = bindLawIntent("workspace", Object.freeze({
        inputs: allocateTemplate.inputs,
        kind: "inspect-attempt-directory",
        preconditions: Object.freeze({
          childEpoch: inspectTemplate.preconditions.childEpoch,
          leaseId: allocateTemplate.preconditions.leaseId,
        }),
        runId: allocateTemplate.runId,
      }));
      const inspected = await lawCall(driver, "workspace", "inspect-empty", inspect, "attempt-directory-inspected", "ok");
      trace.push(inspected.trace);
      collectFinding(findings, inspected.finding);
      if (field(inspected.value, "state") !== "empty-reserved") {
        findings.push("inspect-empty: state was not empty-reserved");
      }
    }

    const isolationTree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "workspace-law-tree",
      files: Object.freeze([Object.freeze({ path: "law/workspace.bin", bytes: Uint8Array.from([1, 3, 5]) })]),
    }));
    if (isolationTree.kind !== "tree") {
      return lawTrace(this.id, trace, [...findings, "workspace isolation tree failed"]);
    }
    const materialized = await driver.fixture(Object.freeze({
      kind: "workspace",
      name: "workspace-isolation-target",
      treeName: isolationTree.name,
    }));
    const isolationTemplate = workspaceIntentCapsule.arbitrary.validForKind("apply-attempt-isolation", 13);
    if (materialized.kind === "workspace" && isolationTemplate.kind === "apply-attempt-isolation") {
      const isolation = bindLawIntent("workspace", Object.freeze({
        inputs: Object.freeze({
          isolationPolicy: isolationTemplate.inputs.isolationPolicy,
          workspaceCapability: materialized.workspaceCapability,
          workspaceId: materialized.workspaceId,
        }),
        kind: "apply-attempt-isolation",
        preconditions: Object.freeze({
          childEpoch: isolationTemplate.preconditions.childEpoch,
          expectedPolicyDigest: isolationTemplate.preconditions.expectedPolicyDigest,
          expectedWorkspaceRoot: materialized.root,
          leaseId: materialized.leaseId,
        }),
        runId: isolationTemplate.runId,
      }));
      const isolated = await lawCall(driver, "workspace", "apply-isolation", isolation, "attempt-isolation-applied", "ok");
      trace.push(isolated.trace);
      collectFinding(findings, isolated.finding);
      if (field(isolated.value, "attestation") === null) {
        findings.push("apply-isolation: enforcement attestation was absent");
      }
    }

    const disposeTemplate = workspaceIntentCapsule.arbitrary.validForKind("dispose-attempt-directory", 14);
    if (disposeTemplate.kind === "dispose-attempt-directory") {
      const dispose = bindLawIntent("workspace", Object.freeze({
        inputs: allocateTemplate.inputs,
        kind: "dispose-attempt-directory",
        preconditions: Object.freeze({
          fencedChildEpoch: disposeTemplate.preconditions.fencedChildEpoch,
          leaseId: allocateTemplate.preconditions.leaseId,
          preserveSealedRoots: true,
        }),
        runId: allocateTemplate.runId,
      }));
      const disposed = await lawCall(driver, "workspace", "dispose-fenced", dispose, "attempt-directory-disposed", "ok");
      trace.push(disposed.trace);
      collectFinding(findings, disposed.finding);
    }
    return lawTrace(this.id, trace, findings);
  },
});
