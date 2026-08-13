import { SimWorld } from "./sim-world.js";

export interface RunUntilOptions {
  readonly maxAdvances: number;
  readonly idleAdvance: number;
}

export type RunUntilResult =
  | { readonly kind: "condition-met"; readonly advances: number; readonly tick: number }
  | { readonly kind: "exhausted"; readonly advances: number; readonly tick: number }
  | { readonly kind: "crashed"; readonly advances: number; readonly tick: number }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export interface ScheduleStep {
  readonly actor: string;
  readonly step: string;
  readonly actorIndex: number;
}

export interface ScheduleActor {
  readonly id: string;
  readonly steps: readonly string[];
}

export interface ScheduleScenario {
  readonly actors: readonly ScheduleActor[];
  readonly maxSchedules: number;
}

export type ScheduleEnumerationResult =
  | {
      readonly kind: "enumerated";
      readonly schedules: readonly (readonly ScheduleStep[])[];
      readonly complete: boolean;
      readonly totalSteps: number;
      readonly scheduleBound: number;
    }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export const SCHEDULE_EXPLORATION_MAX_STEPS = 10;
export const SCHEDULE_EXPLORATION_MAX_SCHEDULES = 10_000;

function options(input: unknown): RunUntilOptions {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return Object.freeze({ maxAdvances: 1_000, idleAdvance: 1 });
    }
    const maxAdvances = Reflect.get(input, "maxAdvances");
    const idleAdvance = Reflect.get(input, "idleAdvance");
    return Object.freeze({
      maxAdvances: typeof maxAdvances === "number" && Number.isSafeInteger(maxAdvances) && maxAdvances >= 0
        ? Math.min(maxAdvances, 1_000_000)
        : 1_000,
      idleAdvance: typeof idleAdvance === "number" && Number.isSafeInteger(idleAdvance) && idleAdvance > 0
        ? idleAdvance
        : 1,
    });
  } catch {
    return Object.freeze({ maxAdvances: 1_000, idleAdvance: 1 });
  }
}

function conditionValue(condition: unknown, world: SimWorld): boolean | null {
  if (typeof condition !== "function") {
    return null;
  }
  try {
    const value: unknown = Reflect.apply(condition, undefined, Object.freeze([world]));
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** Drives only by explicit calls to `world.advance`; it never reads ambient time. */
export function runUntil(worldInput: unknown, condition: unknown, optionsInput?: unknown): RunUntilResult {
  let world: SimWorld;
  try {
    if (!(worldInput instanceof SimWorld)) {
      return Object.freeze({ kind: "invalid", diagnostic: "runUntil requires a SimWorld" });
    }
    world = worldInput;
  } catch {
    return Object.freeze({ kind: "invalid", diagnostic: "world could not be inspected" });
  }
  const configured = options(optionsInput);
  const initial = conditionValue(condition, world);
  if (initial === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "condition must return a boolean without throwing" });
  }
  if (initial) {
    return Object.freeze({ kind: "condition-met", advances: 0, tick: world.clock.now() });
  }
  for (let advances = 1; advances <= configured.maxAdvances; advances += 1) {
    const nextTick = world.nextScheduledTick();
    const delta = nextTick === null
      ? configured.idleAdvance
      : Math.max(0, nextTick - world.clock.now());
    const advanced = world.advance(delta);
    if (advanced.kind === "crashed") {
      return Object.freeze({ kind: "crashed", advances, tick: world.clock.now() });
    }
    if (advanced.kind === "invalid") {
      return Object.freeze({ kind: "invalid", diagnostic: advanced.diagnostic });
    }
    const met = conditionValue(condition, world);
    if (met === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "condition stopped returning a boolean" });
    }
    if (met) {
      return Object.freeze({ kind: "condition-met", advances, tick: world.clock.now() });
    }
  }
  return Object.freeze({ kind: "exhausted", advances: configured.maxAdvances, tick: world.clock.now() });
}

function decodeScenario(input: unknown): ScheduleScenario | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const actorInputs = Reflect.get(input, "actors");
    const boundInput = Reflect.get(input, "maxSchedules");
    if (!Array.isArray(actorInputs)) {
      return null;
    }
    const actors: ScheduleActor[] = [];
    const ids = new Set<string>();
    for (const actorInput of actorInputs) {
      if (typeof actorInput !== "object" || actorInput === null || Array.isArray(actorInput)) {
        return null;
      }
      const id = Reflect.get(actorInput, "id");
      const stepInputs = Reflect.get(actorInput, "steps");
      if (
        typeof id !== "string"
        || id.length === 0
        || ids.has(id)
        || !Array.isArray(stepInputs)
        || !stepInputs.every((step) => typeof step === "string" && step.length > 0)
      ) {
        return null;
      }
      ids.add(id);
      const steps: string[] = [];
      for (const step of stepInputs) {
        if (typeof step === "string") {
          steps.push(step);
        }
      }
      actors.push(Object.freeze({ id, steps: Object.freeze(steps) }));
    }
    const maxSchedules = typeof boundInput === "number"
      && Number.isSafeInteger(boundInput)
      && boundInput > 0
      ? Math.min(boundInput, SCHEDULE_EXPLORATION_MAX_SCHEDULES)
      : SCHEDULE_EXPLORATION_MAX_SCHEDULES;
    return Object.freeze({ actors: Object.freeze(actors), maxSchedules });
  } catch {
    return null;
  }
}

/**
 * Enumerates all actor-order-preserving interleavings for at most ten total
 * steps, stopping after 10,000 schedules. Inputs beyond the step bound return
 * an explicit incomplete result instead of silently sampling schedules.
 */
export function enumerateSchedules(input: unknown): ScheduleEnumerationResult {
  const scenario = decodeScenario(input);
  if (scenario === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "scenario requires unique actors with string step labels" });
  }
  const totalSteps = scenario.actors.reduce((sum, actor) => sum + actor.steps.length, 0);
  if (totalSteps > SCHEDULE_EXPLORATION_MAX_STEPS) {
    return Object.freeze({
      kind: "enumerated",
      schedules: Object.freeze([]),
      complete: false,
      totalSteps,
      scheduleBound: scenario.maxSchedules,
    });
  }
  const positions = scenario.actors.map(() => 0);
  const current: ScheduleStep[] = [];
  const schedules: (readonly ScheduleStep[])[] = [];
  let complete = true;

  const visit = (): void => {
    if (schedules.length >= scenario.maxSchedules) {
      complete = false;
      return;
    }
    if (current.length === totalSteps) {
      schedules.push(Object.freeze(current.slice()));
      return;
    }
    for (let actorIndex = 0; actorIndex < scenario.actors.length; actorIndex += 1) {
      const actor = scenario.actors[actorIndex];
      const position = positions[actorIndex];
      if (actor === undefined || position === undefined || position >= actor.steps.length) {
        continue;
      }
      const step = actor.steps[position];
      if (step === undefined) {
        continue;
      }
      positions[actorIndex] = position + 1;
      current.push(Object.freeze({ actor: actor.id, step, actorIndex }));
      visit();
      current.pop();
      positions[actorIndex] = position;
      if (!complete && schedules.length >= scenario.maxSchedules) {
        return;
      }
    }
  };

  visit();
  return Object.freeze({
    kind: "enumerated",
    schedules: Object.freeze(schedules),
    complete,
    totalSteps,
    scheduleBound: scenario.maxSchedules,
  });
}
