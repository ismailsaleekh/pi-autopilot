import { workspaceIntentCapsule } from "../contracts/workspace.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, lawCall } from "./vector-helpers.js";

export const workspaceLawVector: ContractVector = Object.freeze({
  id: "workspace.allocate-isolate-inspect-dispose.v1",
  port: "workspace",
  behaviors: Object.freeze([
    "attempt allocation is exclusive",
    "isolation binds the observed root and policy digest",
    "inspection reflects ready then absent",
    "epoch-fenced disposal preserves immutable roots",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const tree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "workspace-base",
      files: Object.freeze([
        Object.freeze({ path: "law/base.bin", bytes: Uint8Array.from([0, 255, 17]) }),
      ]),
    }));
    const allocateTemplate = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 11);
    if (tree.kind !== "tree" || allocateTemplate.kind !== "allocate-attempt-directory") {
      return lawTrace("workspace.allocate-isolate-inspect-dispose.v1", trace, Object.freeze(["workspace fixture failed"]));
    }
    const allocate = bindLawIntent("workspace", Object.freeze({
      inputs: Object.freeze({ baseRoot: tree.root, workspaceId: allocateTemplate.inputs.workspaceId }),
      kind: "allocate-attempt-directory",
      preconditions: allocateTemplate.preconditions,
      runId: allocateTemplate.runId,
    }));
    const allocated = await lawCall(driver, "workspace", "allocate", allocate, "attempt-directory-allocated", "ok");
    trace.push(allocated.trace);
    collectFinding(findings, allocated.finding);

    const inspectTemplate = workspaceIntentCapsule.arbitrary.validForKind("inspect-attempt-directory", 12);
    if (inspectTemplate.kind !== "inspect-attempt-directory") {
      findings.push("inspect template failed");
    } else {
      const inspect = bindLawIntent("workspace", Object.freeze({
        inputs: Object.freeze({ workspaceId: allocateTemplate.inputs.workspaceId }),
        kind: "inspect-attempt-directory",
        preconditions: Object.freeze({ leaseId: allocateTemplate.preconditions.leaseId }),
        runId: allocateTemplate.runId,
      }));
      const inspected = await lawCall(driver, "workspace", "inspect-ready", inspect, "attempt-directory-inspected", "ok");
      trace.push(inspected.trace);
      collectFinding(findings, inspected.finding);
    }

    const isolationTemplate = workspaceIntentCapsule.arbitrary.validForKind("apply-attempt-isolation", 13);
    if (isolationTemplate.kind !== "apply-attempt-isolation") {
      findings.push("isolation template failed");
    } else {
      const isolation = bindLawIntent("workspace", Object.freeze({
        inputs: Object.freeze({
          isolationPolicyRoot: tree.root,
          workspaceId: allocateTemplate.inputs.workspaceId,
        }),
        kind: "apply-attempt-isolation",
        preconditions: Object.freeze({
          expectedPolicyDigest: tree.root,
          expectedWorkspaceRoot: tree.root,
        }),
        runId: allocateTemplate.runId,
      }));
      const isolated = await lawCall(driver, "workspace", "apply-isolation", isolation, "attempt-isolation-applied", "ok");
      trace.push(isolated.trace);
      collectFinding(findings, isolated.finding);
    }

    const disposeTemplate = workspaceIntentCapsule.arbitrary.validForKind("dispose-attempt-directory", 14);
    if (disposeTemplate.kind !== "dispose-attempt-directory") {
      findings.push("dispose template failed");
    } else {
      const dispose = bindLawIntent("workspace", Object.freeze({
        inputs: Object.freeze({ workspaceId: allocateTemplate.inputs.workspaceId }),
        kind: "dispose-attempt-directory",
        preconditions: disposeTemplate.preconditions,
        runId: allocateTemplate.runId,
      }));
      const disposed = await lawCall(driver, "workspace", "dispose", dispose, "attempt-directory-disposed", "ok");
      trace.push(disposed.trace);
      collectFinding(findings, disposed.finding);
    }
    return lawTrace("workspace.allocate-isolate-inspect-dispose.v1", trace, findings);
  },
});
