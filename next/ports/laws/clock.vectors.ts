import { clockIntentCapsule } from "../contracts/clock.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, lawCall } from "./vector-helpers.js";

export const clockLawVector: ContractVector = Object.freeze({
  id: "clock.explicit-monotonic-advance.v1",
  port: "clock",
  behaviors: Object.freeze([
    "not-before observations retry without advancing time",
    "time changes only when the driver explicitly advances",
    "ticks are monotonic and source identity is stable",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const template = clockIntentCapsule.arbitrary.validForKind("observe-clock", 31);
    if (template.kind !== "observe-clock") {
      return lawTrace("clock.explicit-monotonic-advance.v1", trace, Object.freeze(["clock template failed"]));
    }
    const intent = bindLawIntent("clock", Object.freeze({
      inputs: template.inputs,
      kind: "observe-clock",
      preconditions: Object.freeze({ notBeforeTick: 5 }),
      runId: template.runId,
    }));
    const waiting = await lawCall(driver, "clock", "observe-before", intent, "clock-observed", "retry");
    trace.push(waiting.trace);
    collectFinding(findings, waiting.finding);
    await driver.advance(5);
    const ready = await lawCall(driver, "clock", "observe-after", intent, "clock-observed", "ok");
    trace.push(ready.trace);
    collectFinding(findings, ready.finding);
    if (field(ready.value, "tick") !== 5) {
      findings.push("observe-after: tick did not equal the explicit advance target");
    }
    return lawTrace("clock.explicit-monotonic-advance.v1", trace, findings);
  },
});
