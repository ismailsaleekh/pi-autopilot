import type { JsonValue } from "../../authority/protocol/schema.js";
import { ArtifactCatalog } from "./artifacts.js";
import type { ArtifactCatalogImage, CreateTreeResult } from "./artifacts.js";
import { DeterministicRandom } from "./prng.js";
import { SimFileSystem } from "./sim-filesystem.js";
import type { FileSystemImage } from "./sim-filesystem.js";
import { SimLockManager } from "./sim-locks.js";
import type { LockManagerImage, LockResult } from "./sim-locks.js";
import { SimTrace, traceJson } from "./trace.js";
import type { TraceEvent } from "./trace.js";
import { VirtualClock } from "./virtual-clock.js";
import type { ClockWaitResult } from "./virtual-clock.js";
import { decodeCrashPoint, isCrashPointId } from "../crash-matrix/registry.js";
import type { CrashPoint, CrashPointId } from "../crash-matrix/registry.js";

export type SimPortName = "workspace" | "git" | "child" | "store" | "clock" | "secrets";
export type WorldDispatchResult =
  | { readonly kind: "rejected"; readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }> }
  | { readonly kind: "crashed"; readonly point: CrashPointId };
export type WorldAdvanceResult =
  | { readonly kind: "advanced"; readonly tick: number; readonly events: number }
  | { readonly kind: "crashed"; readonly tick: number; readonly point: CrashPointId }
  | { readonly kind: "invalid"; readonly diagnostic: string };
export type CrashArmResult =
  | { readonly kind: "armed"; readonly point: CrashPoint }
  | { readonly kind: "invalid"; readonly diagnostic: string };
export interface ReachedCrashPoint { readonly point: CrashPointId; readonly occurrence: number }

interface ScheduledOperation { readonly tick: number; readonly sequence: number; readonly key: string; readonly operation: () => void }
interface SimWorldImage {
  readonly seed: number;
  readonly tick: number;
  readonly restartCount: number;
  readonly fileSystem: FileSystemImage;
  readonly artifacts: ArtifactCatalogImage;
  readonly locks: LockManagerImage;
  readonly trace: readonly TraceEvent[];
}

const knownConfigurations = new WeakMap<object, SimWorldImage>();
function seedValue(input: unknown): number { return typeof input === "number" && Number.isFinite(input) ? Math.trunc(input) >>> 0 : 0; }
function configuration(input: unknown): SimWorldImage | null { return typeof input === "object" && input !== null ? knownConfigurations.get(input) ?? null : null; }

/** Minimal deterministic durability world; semantic port behavior lives in the law driver. */
export class SimWorld {
  public readonly seed: number;
  public readonly random: DeterministicRandom;
  public readonly clock: VirtualClock;
  public readonly trace: SimTrace;
  public readonly fileSystem: SimFileSystem;
  public readonly artifacts: ArtifactCatalog;
  public readonly locks: SimLockManager;
  private readonly restartCount: number;
  private readonly scheduled: ScheduledOperation[] = [];
  private scheduledSequence = 0;
  private alive = true;
  private armedCrash: CrashPoint | null = null;
  private lastCrashPoint: CrashPointId | null = null;
  private readonly reached = new Map<CrashPointId, number>();

  public constructor(seedInput: unknown, internalConfiguration?: unknown) {
    const prior = configuration(internalConfiguration);
    this.seed = prior?.seed ?? seedValue(seedInput);
    this.restartCount = prior?.restartCount ?? 0;
    this.random = new DeterministicRandom(this.seed);
    this.clock = new VirtualClock(this.seed, prior?.tick ?? 0);
    this.trace = new SimTrace(prior?.trace);
    const sink = Object.freeze({
      reachCrashPoint: (point: CrashPointId, detail: JsonValue) => this.reachCrashPoint(point, detail),
    });
    this.fileSystem = new SimFileSystem(sink, prior?.fileSystem);
    this.artifacts = new ArtifactCatalog(prior?.artifacts);
    this.locks = new SimLockManager(Object.freeze({
      lockTakeover: (stage: "before" | "after", resource: string, priorOwner: string, nextOwner: string, generation: number) => {
        this.trace.append(this.clock.now(), "operational", "locks", `takeover-${stage}`, `lock:${resource}:${String(generation)}:${stage}`, Object.freeze({ generation, nextOwner, priorOwner, resource }));
      },
    }), prior?.locks);
  }

  public dispatch(_port: unknown, _intent: unknown): WorldDispatchResult {
    return Object.freeze({ kind: "rejected", diagnostic: Object.freeze({ code: "sim.invalid-boundary", message: "minimal world has no semantic port dispatcher" }) });
  }
  public advance(delta: unknown): WorldAdvanceResult {
    if (!this.alive || typeof delta !== "number" || !Number.isSafeInteger(delta) || delta < 0 || delta > Number.MAX_SAFE_INTEGER - this.clock.now()) return Object.freeze({ kind: "invalid", diagnostic: "advance requires a live world and bounded nonnegative delta" });
    const target = this.clock.now() + delta;
    let events = 0;
    this.scheduled.sort((left, right) => left.tick - right.tick || left.sequence - right.sequence);
    while ((this.scheduled[0]?.tick ?? Number.POSITIVE_INFINITY) <= target) {
      const next = this.scheduled.shift();
      if (next === undefined) break;
      this.clock.advance(next.tick - this.clock.now());
      next.operation();
      events += 1;
      if (!this.alive) return Object.freeze({ kind: "crashed", tick: this.clock.now(), point: this.lastCrashPoint ?? "filesystem.append" });
    }
    const advanced = this.clock.advance(target - this.clock.now());
    return advanced.kind === "advanced" ? Object.freeze({ kind: "advanced", tick: this.clock.now(), events }) : advanced;
  }
  public waitUntil(target: unknown): ClockWaitResult { return this.clock.waitUntil(target); }
  public armCrash(input: unknown): CrashArmResult {
    const point = decodeCrashPoint(input);
    if (point === null || !this.alive) return Object.freeze({ kind: "invalid", diagnostic: "crash point is invalid or world is dead" });
    this.armedCrash = point;
    return Object.freeze({ kind: "armed", point });
  }
  public disarmCrash(): void { this.armedCrash = null; }
  public durabilityPoint(point: unknown, detail: unknown): boolean {
    const value = traceJson(detail);
    return isCrashPointId(point) && value !== null ? this.reachCrashPoint(point, value) : false;
  }
  public isAlive(): boolean { return this.alive; }
  public crashPointHistory(): readonly ReachedCrashPoint[] { return Object.freeze([...this.reached.entries()].map(([point, occurrence]) => Object.freeze({ point, occurrence }))); }
  public restart(): SimWorld {
    const image: SimWorldImage = Object.freeze({ seed: this.seed, tick: this.clock.now(), restartCount: this.restartCount + 1, fileSystem: this.fileSystem.durableImage(), artifacts: this.artifacts.image(), locks: this.locks.image(), trace: this.trace.snapshot() });
    knownConfigurations.set(image, image);
    return new SimWorld(this.seed, image);
  }
  public createArtifact(files: unknown): CreateTreeResult { return this.artifacts.createTree(files); }
  public acquireLock(resource: unknown, owner: unknown, lease: unknown): LockResult { return this.locks.acquire(resource, owner, lease); }
  public takeoverLock(resource: unknown, owner: unknown, lease: unknown): LockResult { return this.locks.takeover(resource, owner, lease); }
  public scheduleLockTakeover(tick: unknown, resource: unknown, owner: unknown, lease: unknown): boolean {
    if (typeof tick !== "number" || !Number.isSafeInteger(tick) || tick < this.clock.now()) return false;
    this.scheduled.push(Object.freeze({ tick, sequence: this.scheduledSequence++, key: `lock:${String(resource)}`, operation: () => { this.locks.takeover(resource, owner, lease); } }));
    return true;
  }
  public nextScheduledTick(): number | null { return this.scheduled.slice().sort((left, right) => left.tick - right.tick || left.sequence - right.sequence)[0]?.tick ?? null; }
  private reachCrashPoint(point: CrashPointId, detail: JsonValue): boolean {
    const occurrence = (this.reached.get(point) ?? 0) + 1;
    this.reached.set(point, occurrence);
    this.trace.append(this.clock.now(), "durability", "world", point, `${point}:${String(occurrence)}`, Object.freeze({ detail, occurrence, point }));
    if (this.armedCrash?.id !== point || this.armedCrash.occurrence !== occurrence) return false;
    this.alive = false;
    this.lastCrashPoint = point;
    this.trace.append(this.clock.now(), "operational", "world", "process-killed", `crash:${point}:${String(occurrence)}`, Object.freeze({ occurrence, point }));
    this.fileSystem.crashRecover();
    this.locks.crashRecover();
    this.scheduled.splice(0);
    return true;
  }
}

export function advanceWorld(world: unknown, delta: unknown): WorldAdvanceResult {
  return world instanceof SimWorld ? world.advance(delta) : Object.freeze({ kind: "invalid", diagnostic: "world must be a SimWorld" });
}
