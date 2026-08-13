import { createHash } from "node:crypto";
import { clockIntentCapsule, clockObservationCapsule } from "../../ports/contracts/clock.capsule.js";
import type { ClockIntent, ClockObservation } from "../../ports/contracts/clock.capsule.js";

export type ClockExecution =
  | { readonly kind: "observation"; readonly observation: ClockObservation }
  | { readonly diagnostic: ClockDiagnostic; readonly kind: "rejected" };

export interface ClockDiagnostic { readonly code: string; readonly message: string }
export interface ClockWaitObservation { readonly observedTick: string; readonly sourceDigest: string; readonly targetTick: string }
export type ClockWaitResult =
  | { readonly kind: "reached"; readonly observation: ClockWaitObservation }
  | { readonly diagnostic: ClockDiagnostic; readonly kind: "retry" };

/** Wait owner receives only explicitly bounded OS-call slices. */
export interface ClockWaiter { readonly wait: (milliseconds: number) => Promise<void> }
export interface SystemClockOptions {
  readonly monotonicNow: () => bigint;
  readonly sourceId: string;
  readonly tickNanoseconds: bigint;
  readonly waiter: ClockWaiter | null;
  readonly maxWaitSliceMilliseconds: number;
}
export type SystemClockCreateResult =
  | { readonly clock: SystemClockAdapter; readonly kind: "created" }
  | { readonly diagnostic: ClockDiagnostic; readonly kind: "rejected" };

function diagnostic(code: string, message: string): ClockDiagnostic {
  return Object.freeze({ code, message });
}
function contractDiagnostic(code: string, message: string) {
  return Object.freeze({ code, message, related: Object.freeze([]) });
}
function digestSource(sourceId: string, tickNanoseconds: bigint): string {
  return `sha256:${createHash("sha256").update("pi-autopilot.monotonic-clock.v2\0").update(sourceId).update("\0").update(String(tickNanoseconds)).digest("hex")}`;
}
function canonicalNatural(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  try { return BigInt(value); } catch { return null; }
}
function clockExecution(candidate: unknown): ClockExecution {
  const encoded = clockObservationCapsule.encodeUnknown(candidate);
  if (encoded.kind === "error") {
    return Object.freeze({ kind: "rejected", diagnostic: diagnostic("clock.observation-invariant", encoded.error.diagnostic) });
  }
  const decoded = clockObservationCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok"
    ? Object.freeze({ kind: "observation", observation: decoded.value })
    : Object.freeze({ kind: "rejected", diagnostic: diagnostic("clock.observation-invariant", decoded.error.diagnostic) });
}
function safeDecode(input: unknown): { readonly kind: "ok"; readonly value: ClockIntent } | { readonly kind: "error"; readonly diagnostic: ClockDiagnostic } {
  const encoded = clockIntentCapsule.encodeUnknown(input);
  if (encoded.kind === "error") {
    return Object.freeze({ kind: "error", diagnostic: diagnostic("clock.invalid-intent", encoded.error.diagnostic) });
  }
  const decoded = clockIntentCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok"
    ? Object.freeze({ kind: "ok", value: decoded.value })
    : Object.freeze({ kind: "error", diagnostic: diagnostic("clock.invalid-intent", decoded.error.diagnostic) });
}

/** Monotonic physical adapter; source/tick policy has no semantic default. */
export class SystemClockAdapter {
  readonly sourceDigest: string;
  private readonly origin: bigint;
  private constructor(private readonly options: SystemClockOptions, origin: bigint) {
    this.origin = origin;
    this.sourceDigest = digestSource(options.sourceId, options.tickNanoseconds);
  }
  public static create(input?: unknown): SystemClockCreateResult {
    try {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return Object.freeze({ kind: "rejected", diagnostic: diagnostic("clock.options-required", "all physical clock capabilities must be injected") });
      }
      const monotonicNow = Reflect.get(input, "monotonicNow");
      const sourceId = Reflect.get(input, "sourceId");
      const tickNanoseconds = Reflect.get(input, "tickNanoseconds");
      const waiter = Reflect.get(input, "waiter");
      const maxWaitSliceMilliseconds = Reflect.get(input, "maxWaitSliceMilliseconds");
      if (typeof monotonicNow !== "function" || typeof sourceId !== "string" || typeof tickNanoseconds !== "bigint" || tickNanoseconds <= 0n || !Number.isSafeInteger(maxWaitSliceMilliseconds) || maxWaitSliceMilliseconds <= 0) {
        return Object.freeze({ kind: "rejected", diagnostic: diagnostic("clock.invalid-options", "clock source, quantum, and bounded wait slice are required") });
      }
      const waitMethod = waiter === null ? null : typeof waiter === "object" && waiter !== null ? Reflect.get(waiter, "wait") : undefined;
      if (waiter !== null && typeof waitMethod !== "function") {
        return Object.freeze({ kind: "rejected", diagnostic: diagnostic("clock.invalid-options", "waiter must expose wait") });
      }
      const now = (): bigint => Reflect.apply(monotonicNow, undefined, []);
      const origin = now();
      if (typeof origin !== "bigint" || origin < 0n) {
        return Object.freeze({ kind: "rejected", diagnostic: diagnostic("clock.invalid-source", "monotonic source returned invalid origin") });
      }
      const options: SystemClockOptions = Object.freeze({
        monotonicNow: now,
        sourceId,
        tickNanoseconds,
        waiter: waitMethod === null ? null : Object.freeze({ wait: async (milliseconds: number): Promise<void> => { await Reflect.apply(waitMethod, waiter, [milliseconds]); } }),
        maxWaitSliceMilliseconds: maxWaitSliceMilliseconds as number,
      });
      return Object.freeze({ kind: "created", clock: new SystemClockAdapter(options, origin) });
    } catch {
      return Object.freeze({ kind: "rejected", diagnostic: diagnostic("clock.source-unavailable", "clock capabilities could not be inspected") });
    }
  }
  public now(): { readonly kind: "observed"; readonly tick: string } | { readonly kind: "retry"; readonly diagnostic: ClockDiagnostic } {
    try {
      const current = this.options.monotonicNow();
      if (current < this.origin) {
        return Object.freeze({ kind: "retry", diagnostic: diagnostic("clock.non-monotonic", "source moved before origin") });
      }
      return Object.freeze({ kind: "observed", tick: String((current - this.origin) / this.options.tickNanoseconds) });
    } catch {
      return Object.freeze({ kind: "retry", diagnostic: diagnostic("clock.source-unavailable", "clock source unavailable") });
    }
  }
  public execute(input: unknown): ClockExecution {
    const decoded = safeDecode(input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    if (decoded.value.preconditions.sourceDigest !== this.sourceDigest) {
      return clockExecution(Object.freeze({ actionId: decoded.value.actionId, kind: "clock-observed", result: Object.freeze({ kind: "retry", diagnostic: contractDiagnostic("clock.source-mismatch", "command source digest differs") }), runId: decoded.value.runId }));
    }
    const observed = this.now();
    const target = canonicalNatural(decoded.value.preconditions.notBeforeTick);
    if (observed.kind === "retry" || target === null || BigInt(observed.tick) < target) {
      return clockExecution(Object.freeze({ actionId: decoded.value.actionId, kind: "clock-observed", result: Object.freeze({ kind: "retry", diagnostic: contractDiagnostic(observed.kind === "retry" ? observed.diagnostic.code : "clock.not-before", observed.kind === "retry" ? observed.diagnostic.message : "clock has not reached target") }), runId: decoded.value.runId }));
    }
    return clockExecution(Object.freeze({ actionId: decoded.value.actionId, kind: "clock-observed", result: Object.freeze({ kind: "ok", value: Object.freeze({ clockId: decoded.value.inputs.clockId, sourceDigest: this.sourceDigest, tick: observed.tick }) }), runId: decoded.value.runId }));
  }
  public async waitUntil(targetInput: unknown): Promise<ClockWaitResult> {
    const target = canonicalNatural(targetInput);
    if (target === null) {
      return Object.freeze({ kind: "retry", diagnostic: diagnostic("clock.invalid-target", "target must be canonical decimal text") });
    }
    const before = this.now();
    if (before.kind === "retry") return before;
    if (BigInt(before.tick) < target) {
      if (this.options.waiter === null) return Object.freeze({ kind: "retry", diagnostic: diagnostic("clock.waiter-unavailable", "waiter unavailable") });
      const remainingNs = (target - BigInt(before.tick)) * this.options.tickNanoseconds;
      const requestedMs = (remainingNs + 999_999n) / 1_000_000n;
      const slice = requestedMs > BigInt(this.options.maxWaitSliceMilliseconds) ? this.options.maxWaitSliceMilliseconds : Number(requestedMs);
      try { await this.options.waiter.wait(slice); } catch { return Object.freeze({ kind: "retry", diagnostic: diagnostic("clock.waiter-rejected", "waiter rejected") }); }
    }
    const after = this.now();
    if (after.kind === "retry") return after;
    return BigInt(after.tick) < target
      ? Object.freeze({ kind: "retry", diagnostic: diagnostic("clock.wait-early", "bounded wait slice ended before target") })
      : Object.freeze({ kind: "reached", observation: Object.freeze({ observedTick: after.tick, sourceDigest: this.sourceDigest, targetTick: String(target) }) });
  }
}

