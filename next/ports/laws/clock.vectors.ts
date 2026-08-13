import { clockIntentCapsule } from "../contracts/clock.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, lawCall } from "./vector-helpers.js";

export const clockLawVector: ContractVector = Object.freeze({
  id: "clock.decimal-monotonic-source.v2",
  port: "clock",
  behaviors: Object.freeze([
    "not-before retries without implicit time advance",
    "ticks are canonical arbitrary-precision decimal text",
    "source identity is command-bound and stable",
    "no safe-integer exhaustion changes correctness",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const template = clockIntentCapsule.arbitrary.validForKind("observe-clock", 31);
    if (template.kind !== "observe-clock") {
      return lawTrace(this.id, trace, ["clock template failed"]);
    }
    const intent = bindLawIntent("clock", Object.freeze({
      inputs: template.inputs,
      kind: "observe-clock",
      preconditions: Object.freeze({
        notBeforeTick: "900719925474099312345",
        sourceDigest: template.preconditions.sourceDigest,
      }),
      runId: template.runId,
    }));
    const waiting = await lawCall(driver, "clock", "observe-before", intent, "clock-observed", "retry");
    trace.push(waiting.trace);
    collectFinding(findings, waiting.finding);
    await driver.advance("900719925474099312345");
    const ready = await lawCall(driver, "clock", "observe-after", intent, "clock-observed", "ok");
    trace.push(ready.trace);
    collectFinding(findings, ready.finding);
    if (field(ready.value, "tick") !== "900719925474099312345") {
      findings.push("observe-after: huge decimal tick differed");
    }
    if (field(ready.value, "sourceDigest") !== template.preconditions.sourceDigest) {
      findings.push("observe-after: source digest differed");
    }
    return lawTrace(this.id, trace, findings);
  },
});
