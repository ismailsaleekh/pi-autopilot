import { SimWorld } from "../simulation/sim-world.js";
import { assertTraceEquivalent } from "../simulation/trace.js";
import type { TraceEquivalenceResult } from "../simulation/trace.js";
import { injectCrashAt } from "./injector.js";
import { decodeCrashPoint } from "./registry.js";
import type { CrashPoint } from "./registry.js";

export type CrashDriveResult =
  | { readonly kind: "progress" }
  | { readonly kind: "complete" }
  | { readonly kind: "crashed" }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export interface CrashScenario {
  readonly id: string;
  readonly create: () => SimWorld;
  readonly drive: (world: SimWorld) => CrashDriveResult;
  readonly completed: (world: SimWorld) => boolean;
  readonly maxDrives?: number;
}

export type CrashVerificationResult =
  | {
      readonly kind: "verified";
      readonly scenario: string;
      readonly point: CrashPoint;
      readonly uninterruptedDrives: number;
      readonly resumedDrives: number;
      readonly equivalence: TraceEquivalenceResult;
    }
  | {
      readonly kind: "not-reached";
      readonly scenario: string;
      readonly point: CrashPoint;
      readonly diagnostic: string;
    }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export interface CrashMatrixResult {
  readonly kind: "matrix";
  readonly results: readonly CrashVerificationResult[];
  readonly verified: number;
  readonly notReached: number;
  readonly invalid: number;
}

interface RunResult {
  readonly kind: "complete" | "crashed" | "invalid";
  readonly world: SimWorld;
  readonly drives: number;
  readonly diagnostic: string;
}

interface DecodedScenario {
  readonly id: string;
  readonly create: Function;
  readonly drive: Function;
  readonly completed: Function;
  readonly maxDrives: number;
}

function decodeScenario(input: unknown): DecodedScenario | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const id = Reflect.get(input, "id");
    const create = Reflect.get(input, "create");
    const drive = Reflect.get(input, "drive");
    const completed = Reflect.get(input, "completed");
    const maxDrivesInput = Reflect.get(input, "maxDrives");
    if (
      typeof id !== "string"
      || id.length === 0
      || typeof create !== "function"
      || typeof drive !== "function"
      || typeof completed !== "function"
    ) {
      return null;
    }
    const maxDrives = typeof maxDrivesInput === "number"
      && Number.isSafeInteger(maxDrivesInput)
      && maxDrivesInput > 0
      ? Math.min(maxDrivesInput, 1_000_000)
      : 1_000;
    return Object.freeze({ id, create, drive, completed, maxDrives });
  } catch {
    return null;
  }
}

function createWorld(scenario: DecodedScenario): SimWorld | null {
  try {
    const value: unknown = Reflect.apply(scenario.create, undefined, Object.freeze([]));
    return value instanceof SimWorld ? value : null;
  } catch {
    return null;
  }
}

function completed(scenario: DecodedScenario, world: SimWorld): boolean {
  try {
    const value: unknown = Reflect.apply(scenario.completed, undefined, Object.freeze([world]));
    return value === true;
  } catch {
    return false;
  }
}

function driveOnce(scenario: DecodedScenario, world: SimWorld): CrashDriveResult {
  try {
    const value: unknown = Reflect.apply(scenario.drive, undefined, Object.freeze([world]));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return Object.freeze({ kind: "invalid", diagnostic: "scenario drive returned a non-result" });
    }
    const kind = Reflect.get(value, "kind");
    if (kind === "progress" || kind === "complete" || kind === "crashed") {
      return Object.freeze({ kind });
    }
    if (kind === "invalid") {
      const message = Reflect.get(value, "diagnostic");
      return Object.freeze({
        kind: "invalid",
        diagnostic: typeof message === "string" ? message : "scenario returned invalid without a diagnostic",
      });
    }
    return Object.freeze({ kind: "invalid", diagnostic: "scenario drive returned an unknown result kind" });
  } catch {
    return Object.freeze({ kind: "invalid", diagnostic: "scenario drive threw" });
  }
}

function run(scenario: DecodedScenario, initial: SimWorld): RunResult {
  let world = initial;
  for (let drives = 1; drives <= scenario.maxDrives; drives += 1) {
    const result = driveOnce(scenario, world);
    if (result.kind === "complete") {
      return completed(scenario, world)
        ? Object.freeze({ kind: "complete", world, drives, diagnostic: "" })
        : Object.freeze({
            kind: "invalid",
            world,
            drives,
            diagnostic: "scenario claimed completion without satisfying its completion invariant",
          });
    }
    if (!world.isAlive()) {
      return Object.freeze({ kind: "crashed", world, drives, diagnostic: "" });
    }
    if (result.kind === "crashed") {
      return Object.freeze({
        kind: "invalid",
        world,
        drives,
        diagnostic: "scenario claimed a crash while the simulated process remained alive",
      });
    }
    if (result.kind === "invalid") {
      return Object.freeze({ kind: "invalid", world, drives, diagnostic: result.diagnostic });
    }
  }
  return Object.freeze({
    kind: "invalid",
    world,
    drives: scenario.maxDrives,
    diagnostic: "scenario exceeded its drive bound",
  });
}

/** Runs an uninterrupted baseline, injects one crash, restarts fresh memory, and compares semantic traces. */
export function verifyCrashResume(scenarioInput: unknown, pointInput: unknown): CrashVerificationResult {
  const scenario = decodeScenario(scenarioInput);
  const point = decodeCrashPoint(pointInput);
  if (scenario === null || point === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "scenario or crash point is malformed" });
  }
  const uninterruptedWorld = createWorld(scenario);
  if (uninterruptedWorld === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "scenario did not create a SimWorld" });
  }
  const uninterrupted = run(scenario, uninterruptedWorld);
  if (uninterrupted.kind !== "complete") {
    return Object.freeze({ kind: "invalid", diagnostic: `uninterrupted scenario ${uninterrupted.kind}: ${uninterrupted.diagnostic}` });
  }

  const faultedWorld = createWorld(scenario);
  if (faultedWorld === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "scenario did not recreate a SimWorld" });
  }
  const armed = injectCrashAt(faultedWorld, point);
  if (armed.kind !== "armed") {
    return Object.freeze({ kind: "invalid", diagnostic: armed.diagnostic });
  }
  const faulted = run(scenario, faultedWorld);
  if (faulted.kind === "complete") {
    return Object.freeze({
      kind: "not-reached",
      scenario: scenario.id,
      point,
      diagnostic: "scenario completed before the selected point occurrence was reached",
    });
  }
  if (faulted.kind === "invalid") {
    return Object.freeze({ kind: "invalid", diagnostic: faulted.diagnostic });
  }
  const reached = faulted.world.crashPointHistory().find(
    (entry) => entry.point === point.id && entry.occurrence >= point.occurrence,
  );
  if (reached === undefined) {
    return Object.freeze({
      kind: "not-reached",
      scenario: scenario.id,
      point,
      diagnostic: "scenario reported a crash without reaching the selected point occurrence",
    });
  }

  const resumedWorld = faulted.world.restart();
  const resumed = run(scenario, resumedWorld);
  if (resumed.kind !== "complete") {
    return Object.freeze({ kind: "invalid", diagnostic: `resumed scenario ${resumed.kind}: ${resumed.diagnostic}` });
  }
  const equivalence = assertTraceEquivalent(uninterrupted.world.trace, resumed.world.trace);
  if (equivalence.kind !== "equivalent") {
    return Object.freeze({ kind: "invalid", diagnostic: `resumed trace is not semantically equivalent: ${equivalence.diagnostic}` });
  }
  if (equivalence.leftEvents === 0 || equivalence.rightEvents === 0) {
    return Object.freeze({ kind: "invalid", diagnostic: "crash equivalence requires a non-empty semantic completion trace" });
  }
  return Object.freeze({
    kind: "verified",
    scenario: scenario.id,
    point,
    uninterruptedDrives: uninterrupted.drives,
    resumedDrives: faulted.drives + resumed.drives,
    equivalence,
  });
}

export function verifyCrashMatrix(scenario: unknown, pointsInput: unknown): CrashMatrixResult {
  let points: readonly unknown[];
  try {
    points = Array.isArray(pointsInput) ? pointsInput : Object.freeze([]);
  } catch {
    points = Object.freeze([]);
  }
  const results: CrashVerificationResult[] = [];
  for (const point of points) {
    results.push(verifyCrashResume(scenario, point));
  }
  return Object.freeze({
    kind: "matrix",
    results: Object.freeze(results),
    verified: results.filter((result) => result.kind === "verified").length,
    notReached: results.filter((result) => result.kind === "not-reached").length,
    invalid: results.filter((result) => result.kind === "invalid").length,
  });
}
