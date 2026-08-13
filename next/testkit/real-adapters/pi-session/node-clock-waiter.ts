import { setTimeout as waitForDelay } from "node:timers/promises";
import type { ClockWaiter } from "../../../adapters/clock/index.js";

/** Test-suite platform capability; W3 owns the production clock composition. */
export const nodeClockWaiter: ClockWaiter = Object.freeze({
  wait: async (milliseconds: number): Promise<void> => {
    await waitForDelay(milliseconds);
  },
});
