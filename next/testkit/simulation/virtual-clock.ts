import { canonicalDigestUnknown } from "../../authority/protocol/schema.js";
import type { Digest } from "../../authority/protocol/schema.js";

export type ClockWaitResult =
  | { readonly kind: "ready"; readonly tick: number }
  | { readonly kind: "waiting"; readonly tick: number; readonly target: number }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export type ClockAdvanceResult =
  | { readonly kind: "advanced"; readonly priorTick: number; readonly tick: number }
  | { readonly kind: "invalid"; readonly diagnostic: string };

/** A monotonic clock with no ambient timer or implicit advancement. */
export class VirtualClock {
  private currentTick: number;
  public readonly sourceDigest: Digest;

  public constructor(seed: unknown, initialTick?: unknown) {
    this.currentTick = typeof initialTick === "number"
      && Number.isSafeInteger(initialTick)
      && initialTick >= 0
      ? initialTick
      : 0;
    const normalizedSeed = typeof seed === "number" && Number.isFinite(seed) ? Math.trunc(seed) : 0;
    this.sourceDigest = canonicalDigestUnknown(Object.freeze({
      clock: "pi-autopilot.sim-clock.v1",
      seed: normalizedSeed,
    }));
  }

  public now(): number {
    return this.currentTick;
  }

  public waitUntil(target: unknown): ClockWaitResult {
    if (typeof target !== "number" || !Number.isSafeInteger(target) || target < 0) {
      return Object.freeze({ kind: "invalid", diagnostic: "target tick must be a non-negative safe integer" });
    }
    if (this.currentTick >= target) {
      return Object.freeze({ kind: "ready", tick: this.currentTick });
    }
    return Object.freeze({ kind: "waiting", tick: this.currentTick, target });
  }

  public advance(delta: unknown): ClockAdvanceResult {
    if (typeof delta !== "number" || !Number.isSafeInteger(delta) || delta < 0) {
      return Object.freeze({ kind: "invalid", diagnostic: "advance delta must be a non-negative safe integer" });
    }
    if (delta > Number.MAX_SAFE_INTEGER - this.currentTick) {
      return Object.freeze({ kind: "invalid", diagnostic: "advance would exceed the safe monotonic tick range" });
    }
    const priorTick = this.currentTick;
    this.currentTick += delta;
    return Object.freeze({ kind: "advanced", priorTick, tick: this.currentTick });
  }
}
