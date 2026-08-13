import { createHash } from "node:crypto";
import { hrtime } from "node:process";
import {
  clockIntentCapsule,
  clockObservationCapsule,
} from "../../ports/contracts/clock.capsule.js";
import type {
  ClockIntent,
  ClockObservation,
} from "../../ports/contracts/clock.capsule.js";

export type ClockExecution =
  | { readonly kind: "observation"; readonly observation: ClockObservation }
  | { readonly diagnostic: ClockDiagnostic; readonly kind: "rejected" };

export interface ClockDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface ClockWaitObservation {
  readonly observedTick: number;
  readonly sourceDigest: string;
  readonly targetTick: number;
}

export type ClockWaitResult =
  | { readonly kind: "reached"; readonly observation: ClockWaitObservation }
  | { readonly diagnostic: ClockDiagnostic; readonly kind: "retry" };

export interface ClockWaiter {
  readonly wait: (milliseconds: number) => Promise<void>;
}

export interface SystemClockOptions {
  readonly monotonicNow?: () => bigint;
  readonly sourceId?: string;
  readonly tickMilliseconds?: number;
  readonly waiter?: ClockWaiter;
}

export type SystemClockCreateResult =
  | { readonly clock: SystemClockAdapter; readonly kind: "created" }
  | { readonly diagnostic: ClockDiagnostic; readonly kind: "rejected" };

const DEFAULT_TICK_MILLISECONDS = 100;
const MAX_TICK_MILLISECONDS = 60_000;

function physicalDiagnostic(code: string, message: string): ClockDiagnostic {
  return Object.freeze({ code, message });
}

function contractDiagnostic(code: string, message: string) {
  return Object.freeze({ code, message, related: Object.freeze([]) });
}

function clockExecution(candidate: unknown): ClockExecution {
  try {
    const encoded = clockObservationCapsule.encodeUnknown(candidate);
    if (encoded.kind === "error") {
      return Object.freeze({
        diagnostic: physicalDiagnostic("clock.observation-invariant", "clock observation did not satisfy the frozen contract"),
        kind: "rejected",
      });
    }
    const decoded = clockObservationCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "observation", observation: decoded.value })
      : Object.freeze({
          diagnostic: physicalDiagnostic("clock.observation-invariant", "clock observation was not canonical"),
          kind: "rejected",
        });
  } catch {
    return Object.freeze({
      diagnostic: physicalDiagnostic("clock.observation-invariant", "clock observation could not be inspected"),
      kind: "rejected",
    });
  }
}

function safeDecode(input: unknown):
  | { readonly kind: "ok"; readonly value: ClockIntent }
  | { readonly diagnostic: ClockDiagnostic; readonly kind: "error" } {
  try {
    const encoded = clockIntentCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return Object.freeze({
        diagnostic: physicalDiagnostic("clock.invalid-intent", "clock intent does not satisfy the frozen contract"),
        kind: "error",
      });
    }
    const decoded = clockIntentCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "ok", value: decoded.value })
      : Object.freeze({
          diagnostic: physicalDiagnostic("clock.invalid-intent", "clock intent is not canonically encoded"),
          kind: "error",
        });
  } catch {
    return Object.freeze({
      diagnostic: physicalDiagnostic("clock.uninspectable-intent", "clock intent could not be inspected safely"),
      kind: "error",
    });
  }
}

function decodeOptions(input: unknown):
  | {
      readonly kind: "ok";
      readonly monotonicNow: () => bigint;
      readonly sourceId: string;
      readonly tickMilliseconds: number;
      readonly waiter: ClockWaiter | null;
    }
  | { readonly diagnostic: ClockDiagnostic; readonly kind: "error" } {
  if (input === undefined) {
    return Object.freeze({
      kind: "ok",
      monotonicNow: hrtime.bigint,
      sourceId: "node-hrtime",
      tickMilliseconds: DEFAULT_TICK_MILLISECONDS,
      waiter: null,
    });
  }
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return Object.freeze({
        diagnostic: physicalDiagnostic("clock.invalid-options", "system clock options must be an object"),
        kind: "error",
      });
    }
    const tickInput = Reflect.get(input, "tickMilliseconds");
    const sourceInput = Reflect.get(input, "sourceId");
    const monotonicInput = Reflect.get(input, "monotonicNow");
    const waiterInput = Reflect.get(input, "waiter");
    const waitMethod = typeof waiterInput === "object" && waiterInput !== null
      ? Reflect.get(waiterInput, "wait")
      : undefined;
    const tickMilliseconds = tickInput === undefined ? DEFAULT_TICK_MILLISECONDS : tickInput;
    const sourceId = sourceInput === undefined ? "node-hrtime" : sourceInput;
    const monotonicNow = monotonicInput === undefined ? hrtime.bigint : monotonicInput;
    if (
      typeof tickMilliseconds !== "number"
      || !Number.isSafeInteger(tickMilliseconds)
      || tickMilliseconds < 1
      || tickMilliseconds > MAX_TICK_MILLISECONDS
      || typeof sourceId !== "string"
      || !/^[A-Za-z0-9._-]+$/.test(sourceId)
      || typeof monotonicNow !== "function"
      || (waiterInput !== undefined && typeof waitMethod !== "function")
    ) {
      return Object.freeze({
        diagnostic: physicalDiagnostic("clock.invalid-options", "system clock options contain an invalid tick, source, or monotonic reader"),
        kind: "error",
      });
    }
    const waiter: ClockWaiter | null = typeof waitMethod !== "function"
      ? null
      : Object.freeze({
          wait: async (milliseconds: number): Promise<void> => {
            await Reflect.apply(waitMethod, waiterInput, [milliseconds]);
          },
        });
    return Object.freeze({ kind: "ok", monotonicNow, sourceId, tickMilliseconds, waiter });
  } catch {
    return Object.freeze({
      diagnostic: physicalDiagnostic("clock.uninspectable-options", "system clock options could not be inspected safely"),
      kind: "error",
    });
  }
}

function digestSource(sourceId: string, tickMilliseconds: number): string {
  const digest = createHash("sha256")
    .update("pi-autopilot.monotonic-clock.v1\u0000")
    .update(sourceId)
    .update("\u0000")
    .update(String(tickMilliseconds))
    .digest("hex");
  return `sha256:${digest}`;
}

/** A monotonic physical clock. It never reads wall time or constructs policy. */
export class SystemClockAdapter {
  readonly sourceDigest: string;
  private readonly monotonicNow: () => bigint;
  private readonly origin: bigint;
  private readonly tickNanoseconds: bigint;
  private readonly waiter: ClockWaiter | null;

  private constructor(
    monotonicNow: () => bigint,
    sourceId: string,
    tickMilliseconds: number,
    origin: bigint,
    waiter: ClockWaiter | null,
  ) {
    this.monotonicNow = monotonicNow;
    this.origin = origin;
    this.tickNanoseconds = BigInt(tickMilliseconds) * 1_000_000n;
    this.sourceDigest = digestSource(sourceId, tickMilliseconds);
    this.waiter = waiter;
  }

  public static create(options?: unknown): SystemClockCreateResult {
    const decoded = decodeOptions(options);
    if (decoded.kind === "error") {
      return Object.freeze({ diagnostic: decoded.diagnostic, kind: "rejected" });
    }
    try {
      const origin = decoded.monotonicNow();
      if (typeof origin !== "bigint" || origin < 0n) {
        return Object.freeze({
          diagnostic: physicalDiagnostic("clock.invalid-source", "monotonic clock source did not return a non-negative bigint"),
          kind: "rejected",
        });
      }
      return Object.freeze({
        clock: new SystemClockAdapter(
          decoded.monotonicNow,
          decoded.sourceId,
          decoded.tickMilliseconds,
          origin,
          decoded.waiter,
        ),
        kind: "created",
      });
    } catch {
      return Object.freeze({
        diagnostic: physicalDiagnostic("clock.source-unavailable", "monotonic clock source was unavailable during construction"),
        kind: "rejected",
      });
    }
  }

  public now():
    | { readonly kind: "observed"; readonly tick: number }
    | { readonly diagnostic: ClockDiagnostic; readonly kind: "retry" } {
    try {
      const current = this.monotonicNow();
      if (typeof current !== "bigint" || current < this.origin) {
        return Object.freeze({
          diagnostic: physicalDiagnostic("clock.non-monotonic", "monotonic source moved before its adapter origin"),
          kind: "retry",
        });
      }
      const tick = (current - this.origin) / this.tickNanoseconds;
      if (tick > BigInt(Number.MAX_SAFE_INTEGER)) {
        return Object.freeze({
          diagnostic: physicalDiagnostic("clock.tick-overflow", "monotonic tick exceeds the frozen natural-number boundary"),
          kind: "retry",
        });
      }
      return Object.freeze({ kind: "observed", tick: Number(tick) });
    } catch {
      return Object.freeze({
        diagnostic: physicalDiagnostic("clock.source-unavailable", "monotonic clock source could not be observed"),
        kind: "retry",
      });
    }
  }

  public execute(input: unknown): ClockExecution {
    const decoded = safeDecode(input);
    if (decoded.kind === "error") {
      return Object.freeze({ diagnostic: decoded.diagnostic, kind: "rejected" });
    }
    const observed = this.now();
    if (observed.kind === "retry") {
      return clockExecution(Object.freeze({
        actionId: decoded.value.actionId,
        kind: "clock-observed",
        result: Object.freeze({
          diagnostic: contractDiagnostic(observed.diagnostic.code, observed.diagnostic.message),
          kind: "retry",
        }),
        runId: decoded.value.runId,
      }));
    }
    if (observed.tick < decoded.value.preconditions.notBeforeTick) {
      return clockExecution(Object.freeze({
        actionId: decoded.value.actionId,
        kind: "clock-observed",
        result: Object.freeze({
          diagnostic: contractDiagnostic("clock.not-before", "monotonic clock has not reached the requested tick"),
          kind: "retry",
        }),
        runId: decoded.value.runId,
      }));
    }
    return clockExecution(Object.freeze({
      actionId: decoded.value.actionId,
      kind: "clock-observed",
      result: Object.freeze({
        kind: "ok",
        value: Object.freeze({
          clockId: decoded.value.inputs.clockId,
          sourceDigest: this.sourceDigest,
          tick: observed.tick,
        }),
      }),
      runId: decoded.value.runId,
    }));
  }

  public async waitUntil(targetTick: unknown): Promise<ClockWaitResult> {
    if (
      typeof targetTick !== "number"
      || !Number.isSafeInteger(targetTick)
      || targetTick < 0
    ) {
      return Object.freeze({
        diagnostic: physicalDiagnostic("clock.invalid-target", "clock wait target must be a non-negative safe integer"),
        kind: "retry",
      });
    }
    const before = this.now();
    if (before.kind === "retry") {
      return before;
    }
    if (before.tick < targetTick) {
      if (this.waiter === null) {
        return Object.freeze({
          diagnostic: physicalDiagnostic("clock.waiter-unavailable", "clock wait requires an injected physical waiter"),
          kind: "retry",
        });
      }
      const remainingTicks = BigInt(targetTick - before.tick);
      const remainingNanoseconds = remainingTicks * this.tickNanoseconds;
      const delayMilliseconds = Number((remainingNanoseconds + 999_999n) / 1_000_000n);
      try {
        await this.waiter.wait(delayMilliseconds);
      } catch {
        return Object.freeze({
          diagnostic: physicalDiagnostic("clock.waiter-rejected", "injected physical clock waiter was unavailable"),
          kind: "retry",
        });
      }
    }
    const after = this.now();
    if (after.kind === "retry") {
      return after;
    }
    if (after.tick < targetTick) {
      return Object.freeze({
        diagnostic: physicalDiagnostic("clock.wait-early", "real timer returned before the requested monotonic tick"),
        kind: "retry",
      });
    }
    return Object.freeze({
      kind: "reached",
      observation: Object.freeze({
        observedTick: after.tick,
        sourceDigest: this.sourceDigest,
        targetTick,
      }),
    });
  }
}
