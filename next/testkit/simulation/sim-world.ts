import type {
  ChildObservation,
} from "../../ports/contracts/child.capsule.js";
import type { ClockObservation } from "../../ports/contracts/clock.capsule.js";
import type { GitObservation } from "../../ports/contracts/git.capsule.js";
import type { SecretsObservation } from "../../ports/contracts/secrets.capsule.js";
import type { StoreObservation } from "../../ports/contracts/store.capsule.js";
import type { WorkspaceObservation } from "../../ports/contracts/workspace.capsule.js";
import type { JsonValue } from "../../authority/protocol/schema.js";
import { ArtifactCatalog } from "./artifacts.js";
import type { ArtifactCatalogImage, CreateTreeResult } from "./artifacts.js";
import { SimChildPort } from "./fake-child.js";
import type { ChildImage, ChildScript, RegisterChildScriptResult } from "./fake-child.js";
import { SimClockPort } from "./fake-clock.js";
import { SimGitPort } from "./fake-git.js";
import type { GitImage, GitRaceHookResult, SeedRepositoryResult } from "./fake-git.js";
import { SimSecretsPort } from "./fake-secrets.js";
import type { RegisterSecretResult, SecretsImage } from "./fake-secrets.js";
import { SimStorePort } from "./fake-store.js";
import { SimWorkspacePort } from "./fake-workspace.js";
import type { WorkspaceImage } from "./fake-workspace.js";
import type { PortTraceSink, SimPortExecution } from "./port-types.js";
import { diagnostic } from "./port-types.js";
import { DeterministicRandom } from "./prng.js";
import { SimFileSystem } from "./sim-filesystem.js";
import type { FileSystemImage } from "./sim-filesystem.js";
import { SimLockManager } from "./sim-locks.js";
import type { LockManagerImage, LockResult } from "./sim-locks.js";
import { SimTrace, traceJson } from "./trace.js";
import type { TraceEvent } from "./trace.js";
import { VirtualClock } from "./virtual-clock.js";
import type { ClockWaitResult } from "./virtual-clock.js";
import {
  decodeCrashPoint,
  isCrashPointId,
} from "../crash-matrix/registry.js";
import type { CrashPoint, CrashPointId } from "../crash-matrix/registry.js";

export type SimPortName = "workspace" | "git" | "child" | "store" | "clock" | "secrets";
export type SimObservation =
  | WorkspaceObservation
  | GitObservation
  | ChildObservation
  | StoreObservation
  | ClockObservation
  | SecretsObservation;

export type WorldDispatchResult = SimPortExecution<SimObservation>;

export type WorldAdvanceResult =
  | { readonly kind: "advanced"; readonly tick: number; readonly events: number }
  | { readonly kind: "crashed"; readonly tick: number; readonly point: CrashPointId }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export type CrashArmResult =
  | { readonly kind: "armed"; readonly point: CrashPoint }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export interface ReachedCrashPoint {
  readonly point: CrashPointId;
  readonly occurrence: number;
}

interface ScheduledOperation {
  readonly tick: number;
  readonly sequence: number;
  readonly key: string;
  readonly operation: () => void;
}

export interface SimWorldImage {
  readonly seed: number;
  readonly tick: number;
  readonly restartCount: number;
  readonly fileSystem: FileSystemImage;
  readonly artifacts: ArtifactCatalogImage;
  readonly locks: LockManagerImage;
  readonly workspaces: WorkspaceImage;
  readonly children: ChildImage;
  readonly childScripts: readonly ChildScript[];
  readonly git: GitImage;
  readonly secrets: SecretsImage;
  readonly trace: readonly TraceEvent[];
}

const knownConfigurations = new WeakMap<object, SimWorldImage>();

function normalizedSeed(seed: unknown): number {
  return typeof seed === "number" && Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

function configuration(input: unknown): SimWorldImage | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  return knownConfigurations.get(input) ?? null;
}

function compareScheduled(left: ScheduledOperation, right: ScheduledOperation): number {
  if (left.tick !== right.tick) {
    return left.tick - right.tick;
  }
  return left.sequence - right.sequence;
}

/**
 * One deterministic process/world boundary. Production orchestration can bind
 * its six intent ports to `dispatch` without importing any adapter. All ambient
 * time, child activity, races, faults, locks, repository state, and secrets are
 * owned here and driven from one seed.
 */
export class SimWorld {
  public readonly seed: number;
  public readonly random: DeterministicRandom;
  public readonly clock: VirtualClock;
  public readonly trace: SimTrace;
  public readonly fileSystem: SimFileSystem;
  public readonly artifacts: ArtifactCatalog;
  public readonly locks: SimLockManager;
  public readonly workspace: SimWorkspacePort;
  public readonly git: SimGitPort;
  public readonly child: SimChildPort;
  public readonly store: SimStorePort;
  public readonly clockPort: SimClockPort;
  public readonly secrets: SimSecretsPort;

  private readonly restartCount: number;
  private readonly scheduled: ScheduledOperation[] = [];
  private scheduledSequence = 0;
  private alive = true;
  private armedCrash: CrashPoint | null = null;
  private lastCrashPoint: CrashPointId | null = null;
  private readonly reached = new Map<CrashPointId, number>();

  public constructor(seedInput: unknown, internalConfiguration?: unknown) {
    const prior = configuration(internalConfiguration);
    this.seed = prior?.seed ?? normalizedSeed(seedInput);
    this.restartCount = prior?.restartCount ?? 0;
    this.random = new DeterministicRandom(this.seed);
    this.clock = new VirtualClock(this.seed, prior?.tick ?? 0);
    this.trace = new SimTrace(prior?.trace);

    const traceSink: PortTraceSink = Object.freeze({
      currentTick: () => this.clock.now(),
      recordContract: (port: string, actionId: string, value: unknown) => {
        this.trace.append(
          this.clock.now(),
          "contract",
          port,
          "observation",
          `${port}:${actionId}:${String(this.trace.snapshot().length)}`,
          value,
        );
      },
      recordSemantic: (source: string, name: string, key: string, value: unknown) => {
        this.trace.append(this.clock.now(), "semantic", source, name, key, value);
      },
      reachCrashPoint: (point: CrashPointId, detail: JsonValue) => this.reachCrashPoint(point, detail),
    });

    this.fileSystem = new SimFileSystem(traceSink, prior?.fileSystem);
    this.artifacts = new ArtifactCatalog(prior?.artifacts);
    this.locks = new SimLockManager(Object.freeze({
      lockTakeover: (
        stage: "before" | "after",
        resource: string,
        priorOwner: string,
        nextOwner: string,
        generation: number,
      ) => {
        this.trace.append(
          this.clock.now(),
          "operational",
          "locks",
          `takeover-${stage}`,
          `lock:${resource}:${String(generation)}:${stage}`,
          Object.freeze({ generation, nextOwner, priorOwner, resource }),
        );
      },
    }), prior?.locks);
    this.workspace = new SimWorkspacePort(this.artifacts, this.locks, traceSink, prior?.workspaces);

    const scheduler = Object.freeze({
      schedule: (tick: number, key: string, operation: () => void) => {
        this.schedule(tick, key, operation);
      },
      cancel: (keyPrefix: string) => {
        this.cancelScheduled(keyPrefix);
      },
    });
    this.child = new SimChildPort(
      this.artifacts,
      this.fileSystem,
      this.workspace,
      traceSink,
      scheduler,
      prior?.childScripts,
      prior?.children,
    );
    this.git = new SimGitPort(
      this.artifacts,
      this.fileSystem,
      this.locks,
      this.workspace,
      traceSink,
      prior?.git,
    );
    this.store = new SimStorePort(this.artifacts, this.fileSystem, traceSink);
    this.clockPort = new SimClockPort(this.clock, traceSink);
    this.secrets = new SimSecretsPort(this.child, traceSink, prior?.secrets);

    if (prior !== null) {
      this.trace.append(
        this.clock.now(),
        "operational",
        "world",
        "restarted",
        `restart:${String(this.restartCount)}`,
        Object.freeze({ restartCount: this.restartCount }),
      );
    }
  }

  public dispatch(portInput: unknown, intent: unknown): WorldDispatchResult {
    if (!this.alive) {
      return Object.freeze({
        kind: "rejected",
        diagnostic: diagnostic("sim.process-dead", "simulated process is dead; restart before dispatch"),
      });
    }
    if (portInput === "workspace") {
      return this.workspace.execute(intent);
    }
    if (portInput === "git") {
      return this.git.execute(intent);
    }
    if (portInput === "child") {
      return this.child.execute(intent);
    }
    if (portInput === "store") {
      return this.store.execute(intent);
    }
    if (portInput === "clock") {
      return this.clockPort.execute(intent);
    }
    if (portInput === "secrets") {
      return this.secrets.execute(intent);
    }
    return Object.freeze({
      kind: "rejected",
      diagnostic: diagnostic("sim.unknown-port", "port must be workspace, git, child, store, clock, or secrets"),
    });
  }

  public advance(delta: unknown): WorldAdvanceResult {
    if (!this.alive) {
      return Object.freeze({ kind: "invalid", diagnostic: "simulated process is dead; restart before advancing" });
    }
    if (typeof delta !== "number" || !Number.isSafeInteger(delta) || delta < 0 || delta > Number.MAX_SAFE_INTEGER - this.clock.now()) {
      return Object.freeze({ kind: "invalid", diagnostic: "advance delta must fit the non-negative safe monotonic range" });
    }
    const target = this.clock.now() + delta;
    let events = 0;
    this.scheduled.sort(compareScheduled);
    while (this.scheduled.length > 0) {
      const next = this.scheduled[0];
      if (next === undefined || next.tick > target) {
        break;
      }
      this.scheduled.shift();
      const advance = this.clock.advance(next.tick - this.clock.now());
      if (advance.kind === "invalid") {
        return Object.freeze({ kind: "invalid", diagnostic: advance.diagnostic });
      }
      try {
        next.operation();
      } catch {
        this.trace.append(
          this.clock.now(),
          "operational",
          "world",
          "scheduled-operation-rejected",
          `scheduled:${next.sequence}`,
          Object.freeze({ key: next.key }),
        );
        return Object.freeze({
          kind: "invalid",
          diagnostic: `scheduled operation rejected at tick ${String(this.clock.now())}`,
        });
      }
      events += 1;
      if (!this.alive) {
        return Object.freeze({
          kind: "crashed",
          tick: this.clock.now(),
          point: this.lastCrashPoint ?? "filesystem.append",
        });
      }
      this.scheduled.sort(compareScheduled);
    }
    const finalAdvance = this.clock.advance(target - this.clock.now());
    return finalAdvance.kind === "invalid"
      ? Object.freeze({ kind: "invalid", diagnostic: finalAdvance.diagnostic })
      : Object.freeze({ kind: "advanced", tick: this.clock.now(), events });
  }

  public waitUntil(target: unknown): ClockWaitResult {
    return this.clock.waitUntil(target);
  }

  public armCrash(pointInput: unknown): CrashArmResult {
    const point = decodeCrashPoint(pointInput);
    if (point === null || !this.alive) {
      return Object.freeze({ kind: "invalid", diagnostic: "crash point is invalid or process is not alive" });
    }
    this.armedCrash = point;
    return Object.freeze({ kind: "armed", point });
  }

  public disarmCrash(): void {
    this.armedCrash = null;
  }

  /** Crash-matrix instrumentation; scenarios reach it only through operation sites. */
  public durabilityPoint(pointInput: unknown, detailInput: unknown): boolean {
    const detail = traceJson(detailInput);
    return isCrashPointId(pointInput) && detail !== null
      ? this.reachCrashPoint(pointInput, detail)
      : false;
  }

  public isAlive(): boolean {
    return this.alive;
  }

  public crashPointHistory(): readonly ReachedCrashPoint[] {
    return Object.freeze([...this.reached.entries()]
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
      .map(([point, occurrence]) => Object.freeze({ point, occurrence })));
  }

  public restart(): SimWorld {
    const image = this.imageForRestart();
    knownConfigurations.set(image, image);
    return new SimWorld(this.seed, image);
  }

  public createArtifact(files: unknown): CreateTreeResult {
    return this.artifacts.createTree(files);
  }

  public registerChildScript(script: unknown): RegisterChildScriptResult {
    return this.child.registerScript(script);
  }

  public seedRepository(input: unknown): SeedRepositoryResult {
    return this.git.seedRepository(input);
  }

  public registerGitRace(input: unknown): GitRaceHookResult {
    return this.git.registerRaceHook(input);
  }

  public registerSecret(handle: unknown, bytes: unknown): RegisterSecretResult {
    return this.secrets.register(handle, bytes);
  }

  public acquireLock(resource: unknown, owner: unknown, lease: unknown): LockResult {
    return this.locks.acquire(resource, owner, lease);
  }

  public takeoverLock(resource: unknown, owner: unknown, lease: unknown): LockResult {
    return this.locks.takeover(resource, owner, lease);
  }

  public scheduleLockTakeover(
    tickInput: unknown,
    resource: unknown,
    owner: unknown,
    lease: unknown,
  ): boolean {
    if (
      typeof tickInput !== "number"
      || !Number.isSafeInteger(tickInput)
      || tickInput < this.clock.now()
    ) {
      return false;
    }
    this.schedule(tickInput, `lock-takeover:${String(resource)}`, () => {
      this.locks.takeover(resource, owner, lease);
    });
    return true;
  }

  public nextScheduledTick(): number | null {
    this.scheduled.sort(compareScheduled);
    return this.scheduled[0]?.tick ?? null;
  }

  private reachCrashPoint(point: CrashPointId, detail: JsonValue): boolean {
    if (!isCrashPointId(point)) {
      return false;
    }
    const occurrence = (this.reached.get(point) ?? 0) + 1;
    this.reached.set(point, occurrence);
    this.trace.append(
      this.clock.now(),
      "durability",
      "world",
      point,
      `${point}:${String(occurrence)}`,
      Object.freeze({ detail, occurrence, point }),
    );
    if (this.armedCrash?.id !== point || this.armedCrash.occurrence !== occurrence) {
      return false;
    }
    this.alive = false;
    this.lastCrashPoint = point;
    this.trace.append(
      this.clock.now(),
      "operational",
      "world",
      "process-killed",
      `crash:${point}:${String(occurrence)}`,
      Object.freeze({ occurrence, point }),
    );
    this.fileSystem.crashRecover();
    this.locks.crashRecover();
    this.scheduled.splice(0, this.scheduled.length);
    return true;
  }

  private schedule(tick: number, key: string, operation: () => void): void {
    if (!Number.isSafeInteger(tick) || tick < this.clock.now() || key.length === 0) {
      return;
    }
    this.scheduled.push(Object.freeze({
      tick,
      sequence: this.scheduledSequence,
      key,
      operation,
    }));
    this.scheduledSequence += 1;
  }

  private cancelScheduled(keyPrefix: string): void {
    for (let index = this.scheduled.length - 1; index >= 0; index -= 1) {
      if (this.scheduled[index]?.key.startsWith(keyPrefix)) {
        this.scheduled.splice(index, 1);
      }
    }
  }

  private imageForRestart(): SimWorldImage {
    const image: SimWorldImage = Object.freeze({
      seed: this.seed,
      tick: this.clock.now(),
      restartCount: this.restartCount + 1,
      fileSystem: this.fileSystem.durableImage(),
      artifacts: this.artifacts.image(),
      locks: this.locks.image(),
      workspaces: this.workspace.image(),
      children: this.child.image(),
      childScripts: this.child.scriptsSnapshot(),
      git: this.git.image(),
      secrets: this.secrets.image(),
      trace: this.trace.snapshot(),
    });
    return image;
  }
}

export function advanceWorld(world: unknown, delta: unknown): WorldAdvanceResult {
  try {
    return world instanceof SimWorld
      ? world.advance(delta)
      : Object.freeze({ kind: "invalid", diagnostic: "world must be a SimWorld" });
  } catch {
    return Object.freeze({ kind: "invalid", diagnostic: "world could not be inspected" });
  }
}
