import {
  clockIntentCapsule,
} from "../../ports/contracts/clock.capsule.js";
import type { ClockObservation } from "../../ports/contracts/clock.capsule.js";
import type { PortTraceSink, SimPortExecution } from "./port-types.js";
import { diagnostic, safeDecode } from "./port-types.js";
import { VirtualClock } from "./virtual-clock.js";

/** Models monotonic observations only; wall time, drift, leap time, and OS timer jitter are intentionally absent. */
export class SimClockPort {
  private readonly clock: VirtualClock;
  private readonly trace: PortTraceSink;
  private readonly observations = new Map<string, ClockObservation>();

  public constructor(clock: VirtualClock, trace: PortTraceSink) {
    this.clock = clock;
    this.trace = trace;
  }

  public execute(input: unknown): SimPortExecution<ClockObservation> {
    const decoded = safeDecode(clockIntentCapsule, input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    const cached = this.observations.get(decoded.value.actionId);
    if (cached !== undefined) {
      this.trace.recordContract("clock", decoded.value.actionId, cached);
      return Object.freeze({ kind: "observation", observation: cached });
    }
    let observation: ClockObservation;
    if (this.clock.now() < decoded.value.preconditions.notBeforeTick) {
      observation = Object.freeze({
        actionId: decoded.value.actionId,
        kind: "clock-observed",
        result: Object.freeze({
          kind: "retry",
          diagnostic: diagnostic("clock.not-before", "virtual clock has not reached the requested tick; call world.advance explicitly"),
        }),
        runId: decoded.value.runId,
      });
    } else {
      observation = Object.freeze({
        actionId: decoded.value.actionId,
        kind: "clock-observed",
        result: Object.freeze({
          kind: "ok",
          value: Object.freeze({
            clockId: decoded.value.inputs.clockId,
            sourceDigest: this.clock.sourceDigest,
            tick: this.clock.now(),
          }),
        }),
        runId: decoded.value.runId,
      });
      this.observations.set(decoded.value.actionId, observation);
    }
    this.trace.recordContract("clock", decoded.value.actionId, observation);
    return Object.freeze({ kind: "observation", observation });
  }
}
