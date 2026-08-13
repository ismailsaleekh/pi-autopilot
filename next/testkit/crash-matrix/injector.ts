import { SimWorld } from "../simulation/sim-world.js";
import type { CrashArmResult } from "../simulation/sim-world.js";
import { decodeCrashPoint } from "./registry.js";

export type InjectCrashResult = CrashArmResult;

/** Arms one exact point/occurrence; reaching it atomically kills the simulated process. */
export function injectCrashAt(worldInput: unknown, pointInput: unknown): InjectCrashResult {
  try {
    if (!(worldInput instanceof SimWorld)) {
      return Object.freeze({ kind: "invalid", diagnostic: "injectCrashAt requires a SimWorld" });
    }
    const point = decodeCrashPoint(pointInput);
    return point === null
      ? Object.freeze({ kind: "invalid", diagnostic: "crash point is not registered or occurrence is invalid" })
      : worldInput.armCrash(point);
  } catch {
    return Object.freeze({ kind: "invalid", diagnostic: "world or crash point could not be inspected" });
  }
}
