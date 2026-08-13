import { secretsIntentCapsule } from "../contracts/secrets.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, lawCall } from "./vector-helpers.js";

export const secretsLawVector: ContractVector = Object.freeze({
  id: "secrets.opaque-purpose-destination-revoke.v2",
  port: "secrets",
  behaviors: Object.freeze([
    "observations expose only opaque handles and leases",
    "authorization binds exact purpose, closed injection destination, child epoch, and policy",
    "stale/inactive epochs retry and revocation is idempotent",
    "secret canaries never enter observations, diagnostics, CAS, prompts, or captures",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const secretBytes = Uint8Array.from([115, 117, 98, 115, 99, 114, 105, 112, 116, 105, 111, 110]);
    const secret = await driver.fixture(Object.freeze({
      kind: "secret",
      name: "model-route-v2",
      handle: "secret:law-model-route-v2",
      bytes: secretBytes,
    }));
    const template = secretsIntentCapsule.arbitrary.validForKind("authorize-secret-use", 62);
    if (secret.kind !== "secret" || template.kind !== "authorize-secret-use") {
      return lawTrace(this.id, trace, ["secret fixture failed"]);
    }
    const authorize = bindLawIntent("secrets", Object.freeze({
      inputs: Object.freeze({
        childId: template.inputs.childId,
        destination: template.inputs.destination,
        purposeId: template.inputs.purposeId,
        secretHandle: secret.handle,
      }),
      kind: "authorize-secret-use",
      preconditions: template.preconditions,
      runId: template.runId,
    }));
    const authorized = await lawCall(driver, "secrets", "authorize", authorize, "secret-use-authorized", "ok");
    trace.push(authorized.trace);
    collectFinding(findings, authorized.finding);
    const leaseId = field(authorized.value, "leaseId");
    if (typeof leaseId !== "string") {
      return lawTrace(this.id, trace, [...findings, "authorize: lease absent"]);
    }
    const revokeTemplate = secretsIntentCapsule.arbitrary.validForKind("revoke-secret-use", 63);
    if (revokeTemplate.kind === "revoke-secret-use") {
      const revoke = bindLawIntent("secrets", Object.freeze({
        inputs: Object.freeze({ leaseId, secretHandle: secret.handle }),
        kind: "revoke-secret-use",
        preconditions: Object.freeze({ childEpoch: template.preconditions.childEpoch }),
        runId: template.runId,
      }));
      const revoked = await lawCall(driver, "secrets", "revoke", revoke, "secret-use-revoked", "ok");
      trace.push(revoked.trace);
      collectFinding(findings, revoked.finding);
      const repeated = await lawCall(driver, "secrets", "revoke-idempotent", revoke, "secret-use-revoked", "ok");
      trace.push(repeated.trace);
      collectFinding(findings, repeated.finding);
    }
    if (await driver.containsSecretBytes(secretBytes)) {
      findings.push("secret canary appeared in a normalized observation, diagnostic, artifact, prompt, or capture");
    }
    return lawTrace(this.id, trace, findings);
  },
});
