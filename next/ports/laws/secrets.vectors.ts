import { childIntentCapsule } from "../contracts/child.capsule.js";
import { secretsIntentCapsule } from "../contracts/secrets.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, lawCall } from "./vector-helpers.js";

export const secretsLawVector: ContractVector = Object.freeze({
  id: "secrets.opaque-authorize-revoke.v1",
  port: "secrets",
  behaviors: Object.freeze([
    "observations expose handles and leases but never secret bytes",
    "authorization binds an active child epoch and policy digest",
    "revocation is idempotent",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const tree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "secret-base",
      files: Object.freeze([Object.freeze({ path: "law/input.bin", bytes: Uint8Array.from([1]) })]),
    }));
    const workspace = await driver.fixture(Object.freeze({
      kind: "workspace",
      name: "secret-workspace",
      treeName: "secret-base",
    }));
    const launchTemplate = childIntentCapsule.arbitrary.validForKind("launch-child-session", 61);
    if (tree.kind !== "tree" || workspace.kind !== "workspace" || launchTemplate.kind !== "launch-child-session") {
      return lawTrace("secrets.opaque-authorize-revoke.v1", trace, Object.freeze(["secret child fixture failed"]));
    }
    const script = await driver.fixture(Object.freeze({
      kind: "child-script",
      name: "secret-child",
      workItemId: launchTemplate.inputs.workItemId,
      workspaceName: "secret-workspace",
      writes: Object.freeze([]),
      sealTick: null,
      terminal: "hang",
      terminalTick: 100,
    }));
    const secretBytes = Uint8Array.from([115, 117, 98, 115, 99, 114, 105, 112, 116, 105, 111, 110]);
    const secret = await driver.fixture(Object.freeze({
      kind: "secret",
      name: "model-route",
      handle: "secret:law-model-route",
      bytes: secretBytes,
    }));
    if (script.kind !== "child-script" || secret.kind !== "secret") {
      return lawTrace("secrets.opaque-authorize-revoke.v1", trace, Object.freeze(["secret fixture registration failed"]));
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
    const launched = await lawCall(driver, "child", "secret-child-launch", launch, "child-session-launched", "ok");
    const childId = field(launched.value, "childId");
    const childEpoch = field(launched.value, "childEpoch");
    if (typeof childId !== "string" || typeof childEpoch !== "string") {
      return lawTrace("secrets.opaque-authorize-revoke.v1", trace, Object.freeze(["secret child did not launch"]));
    }

    const authorizeTemplate = secretsIntentCapsule.arbitrary.validForKind("authorize-secret-use", 62);
    if (authorizeTemplate.kind !== "authorize-secret-use") {
      return lawTrace("secrets.opaque-authorize-revoke.v1", trace, Object.freeze(["authorize template failed"]));
    }
    const authorize = bindLawIntent("secrets", Object.freeze({
      inputs: Object.freeze({
        childId,
        purposeId: authorizeTemplate.inputs.purposeId,
        secretHandle: secret.handle,
      }),
      kind: "authorize-secret-use",
      preconditions: Object.freeze({
        childEpoch,
        policyDigest: authorizeTemplate.preconditions.policyDigest,
      }),
      runId: launchTemplate.runId,
    }));
    const authorized = await lawCall(driver, "secrets", "authorize", authorize, "secret-use-authorized", "ok");
    trace.push(authorized.trace);
    collectFinding(findings, authorized.finding);
    const leaseId = field(authorized.value, "leaseId");
    if (typeof leaseId !== "string") {
      findings.push("authorize: opaque lease was absent");
      return lawTrace("secrets.opaque-authorize-revoke.v1", trace, findings);
    }
    const revoke = bindLawIntent("secrets", Object.freeze({
      inputs: Object.freeze({ leaseId, secretHandle: secret.handle }),
      kind: "revoke-secret-use",
      preconditions: Object.freeze({ childEpoch }),
      runId: launchTemplate.runId,
    }));
    const revoked = await lawCall(driver, "secrets", "revoke", revoke, "secret-use-revoked", "ok");
    trace.push(revoked.trace);
    collectFinding(findings, revoked.finding);
    const revokedAgain = await lawCall(driver, "secrets", "revoke-idempotent", revoke, "secret-use-revoked", "ok");
    trace.push(revokedAgain.trace);
    collectFinding(findings, revokedAgain.finding);
    if (await driver.containsSecretBytes(secretBytes)) {
      findings.push("secret bytes appeared in a normalized observation or trace");
    }
    return lawTrace("secrets.opaque-authorize-revoke.v1", trace, findings);
  },
});
