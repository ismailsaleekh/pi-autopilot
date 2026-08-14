import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { JsonValue } from "../../authority/protocol/schema.js";
import { bytesEqual } from "../../authority/protocol/schema.js";
import { portContractCapsules } from "../../ports/contracts/aggregate.generated.js";
import { workspaceIntentCapsule } from "../../ports/contracts/workspace.capsule.js";
import { PORT_LAW_VECTORS } from "../../ports/laws/vectors.js";
import type { CrashPointId } from "../crash-matrix/registry.js";
import { enumerateSchedules, runUntil } from "./control.js";
import { SimLawDriver } from "./law-driver.js";
import { DeterministicRandom } from "./prng.js";
import { SimFileSystem } from "./sim-filesystem.js";
import { SimWorld } from "./sim-world.js";
import { assertTraceEquivalent, SimTrace } from "./trace.js";

function noCrashSink(): { readonly reachCrashPoint: (point: CrashPointId, detail: JsonValue) => boolean } {
  return Object.freeze({
    reachCrashPoint: (_point: CrashPointId, _detail: JsonValue) => false,
  });
}

test("xoshiro128** stream is stable and seed-sensitive", () => {
  const first = new DeterministicRandom(1234);
  const second = new DeterministicRandom(1234);
  const third = new DeterministicRandom(1235);
  const left = Array.from({ length: 32 }, () => first.nextUint32());
  const right = Array.from({ length: 32 }, () => second.nextUint32());
  const other = Array.from({ length: 32 }, () => third.nextUint32());
  assert.deepEqual(left, right);
  assert.notDeepEqual(left, other);
  assert.equal(new DeterministicRandom(Symbol("garbage")).nextBounded(-1), 0);
});

test("filesystem exposes atomic rename visibility and explicit durability boundaries", () => {
  const fileSystem = new SimFileSystem(noCrashSink());
  assert.deepEqual(fileSystem.writeFile("tmp/object", Uint8Array.from([0, 255, 1])), { kind: "ok" });
  assert.equal(fileSystem.fsyncFile("tmp/object").kind, "ok");
  assert.equal(fileSystem.rename("tmp/object", "objects/final").kind, "ok");
  assert.equal(fileSystem.exists("tmp/object"), false);
  assert.equal(fileSystem.exists("objects/final"), true);
  fileSystem.crashRecover();
  assert.equal(fileSystem.exists("objects/final"), false, "rename is not durable before directory fsync");

  assert.equal(fileSystem.writeFile("tmp/object", Uint8Array.from([0, 255, 1])).kind, "ok");
  assert.equal(fileSystem.fsyncFile("tmp/object").kind, "ok");
  assert.equal(fileSystem.rename("tmp/object", "objects/final").kind, "ok");
  assert.equal(fileSystem.fsyncDirectory("objects").kind, "ok");
  fileSystem.crashRecover();
  const read = fileSystem.readFile("objects/final");
  assert.equal(read.kind, "ok");
  if (read.kind === "ok") {
    assert.deepEqual([...read.bytes], [0, 255, 1]);
  }
});

test("all six centrally owned law vectors replay green against fakes", async () => {
  assert.equal(PORT_LAW_VECTORS.length, 6);
  for (let index = 0; index < PORT_LAW_VECTORS.length; index += 1) {
    const vector = PORT_LAW_VECTORS[index];
    assert.notEqual(vector, undefined);
    if (vector !== undefined) {
      const result = await vector.replay(new SimLawDriver(700 + index));
      assert.deepEqual(result.findings, [], `${vector.id}: ${result.findings.join("; ")}`);
      assert.ok(result.trace.length > 0);
    }
  }
});

test("same seed and law scripts produce byte-identical complete traces", async () => {
  for (const vector of PORT_LAW_VECTORS) {
    const first = new SimLawDriver(9123);
    const second = new SimLawDriver(9123);
    const firstResult = await vector.replay(first);
    const secondResult = await vector.replay(second);
    assert.deepEqual(firstResult, secondResult);
    assert.equal(bytesEqual(first.world.trace.canonicalBytes(), second.world.trace.canonicalBytes()), true, vector.id);
  }
});

test("trace determinism holds across processes, locales, and timezones", () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const fixture = join(directory, "determinism-fixture.js");
  const first = spawnSync(process.execPath, [fixture, "4411"], {
    encoding: "utf8",
    env: Object.freeze({ ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" }),
  });
  const second = spawnSync(process.execPath, [fixture, "4411"], {
    encoding: "utf8",
    env: Object.freeze({ ...process.env, LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8", TZ: "Pacific/Chatham" }),
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.length > 100);
});

test("virtual time waits without ambient progress and runUntil advances explicitly", () => {
  const world = new SimWorld(3);
  assert.deepEqual(world.waitUntil(5), { kind: "waiting", tick: 0, target: 5 });
  const result = runUntil(world, (candidate: SimWorld) => candidate.clock.now() >= 5, Object.freeze({
    maxAdvances: 5,
    idleAdvance: 1,
  }));
  assert.deepEqual(result, { kind: "condition-met", advances: 5, tick: 5 });
  assert.deepEqual(world.waitUntil(5), { kind: "ready", tick: 5 });
});

test("schedule enumeration covers every bounded order-preserving interleaving", () => {
  const result = enumerateSchedules(Object.freeze({
    actors: Object.freeze([
      Object.freeze({ id: "a", steps: Object.freeze(["a1", "a2"]) }),
      Object.freeze({ id: "b", steps: Object.freeze(["b1", "b2"]) }),
    ]),
    maxSchedules: 100,
  }));
  assert.equal(result.kind, "enumerated");
  if (result.kind === "enumerated") {
    assert.equal(result.complete, true);
    assert.equal(result.schedules.length, 6);
    assert.equal(new Set(result.schedules.map((schedule) => schedule.map((step) => step.step).join(","))).size, 6);
  }
  const beyond = enumerateSchedules(Object.freeze({
    actors: Object.freeze([
      Object.freeze({ id: "a", steps: Object.freeze(Array.from({ length: 11 }, (_, index) => `a${String(index)}`)) }),
    ]),
  }));
  assert.equal(beyond.kind, "enumerated");
  if (beyond.kind === "enumerated") {
    assert.equal(beyond.complete, false);
    assert.equal(beyond.schedules.length, 0);
  }
});

test("bounded schedule explorer enumerates only the two modeled terminal labels", () => {
  const enumerated = enumerateSchedules(Object.freeze({
    actors: Object.freeze([
      Object.freeze({ id: "authority", steps: Object.freeze(["accept-t1", "late-authority-work"]) }),
      Object.freeze({ id: "planner", steps: Object.freeze(["accept-t2", "late-planner-work"]) }),
      Object.freeze({ id: "process", steps: Object.freeze(["exit-1", "restart"]) }),
    ]),
    maxSchedules: 10_000,
  }));
  assert.equal(enumerated.kind, "enumerated");
  if (enumerated.kind === "enumerated") {
    assert.equal(enumerated.complete, true);
    const terminals = new Set<string>();
    for (const schedule of enumerated.schedules) {
      let terminal: "t1" | "t2" | null = null;
      for (const step of schedule) {
        if (terminal === null && step.step === "accept-t1") {
          terminal = "t1";
        } else if (terminal === null && step.step === "accept-t2") {
          terminal = "t2";
        }
      }
      assert.notEqual(terminal, null);
      if (terminal !== null) {
        terminals.add(terminal);
      }
    }
    assert.deepEqual([...terminals].sort(), ["t1", "t2"]);
  }
});

test("lock takeover advances a durable epoch and fences the former lease", () => {
  const world = new SimWorld(4);
  const firstTemplate = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 71);
  const secondTemplate = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 72);
  assert.equal(firstTemplate.kind, "allocate-attempt-directory");
  assert.equal(secondTemplate.kind, "allocate-attempt-directory");
  if (firstTemplate.kind === "allocate-attempt-directory" && secondTemplate.kind === "allocate-attempt-directory") {
    const acquired = world.acquireLock("writer", "worker-a", firstTemplate.preconditions.leaseId);
    const taken = world.takeoverLock("writer", "worker-b", secondTemplate.preconditions.leaseId);
    assert.equal(acquired.kind, "acquired");
    assert.equal(taken.kind, "acquired");
    if (acquired.kind === "acquired" && taken.kind === "acquired") {
      assert.ok(taken.generation > acquired.generation);
      assert.notEqual(taken.epoch, acquired.epoch);
      assert.equal(world.locks.validates("writer", firstTemplate.preconditions.leaseId, acquired.epoch), false);
      assert.equal(world.locks.validates("writer", secondTemplate.preconditions.leaseId, taken.epoch), true);
    }
  }
});

test("all fake port boundaries reject adversarial garbage without throwing or mutating terminals", () => {
  const ports = Object.freeze(["workspace", "git", "child", "store", "clock", "secrets"]);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const throwing = Object.create(null, {
    runId: Object.freeze({
      enumerable: true,
      get(): never {
        throw new Error("hostile getter");
      },
    }),
  });
  const revoked = Proxy.revocable(Object.freeze({}), Object.freeze({}));
  revoked.revoke();
  const garbage = Object.freeze([
    null,
    undefined,
    true,
    1,
    "garbage",
    Uint8Array.from([255]),
    cyclic,
    throwing,
    revoked.proxy,
  ]);
  const world = new SimWorld(5);
  for (const port of ports) {
    for (const value of garbage) {
      assert.doesNotThrow(() => world.dispatch(port, value));
      assert.equal(world.dispatch(port, value).kind, "rejected");
    }
  }
  assert.equal(world.isAlive(), true);
  assert.equal(world.trace.snapshot().some((event) => event.name === "outcome"), false);
});

test("simulation and laws preserve the anti-lie dependency direction", () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const nextRoot = resolve(directory, "../../..");
  const simulationRoot = join(nextRoot, "testkit", "simulation");
  const lawRoot = join(nextRoot, "ports", "laws");
  const sourceFiles = (root: string): readonly string[] => Object.freeze(readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(root, entry.name)));
  for (const file of sourceFiles(simulationRoot)) {
    const source = readFileSync(file, "utf8");
    assert.equal(/from\s+["'][^"']*adapters\//.test(source), false, file);
  }
  for (const file of sourceFiles(lawRoot)) {
    const source = readFileSync(file, "utf8");
    assert.equal(/from\s+["'][^"']*testkit\/simulation/.test(source), false, file);
  }
});

test("deterministic mutation smoke is total across every simulation entry surface", () => {
  const world = new SimWorld(991);
  const random = new DeterministicRandom(991);
  const garbage: unknown[] = [null, undefined, false, -1, "", Object.freeze({})];
  for (const capsule of portContractCapsules) {
    for (let index = 0; index < 16; index += 1) {
      garbage.push(capsule.arbitrary.malformedValue(random.nextUint32()));
      garbage.push(capsule.arbitrary.arbitraryBytes(random.nextUint32(), random.nextBounded(64)));
    }
  }
  const ports = Object.freeze(["workspace", "git", "child", "store", "clock", "secrets"]);
  for (const value of garbage) {
    for (const port of ports) {
      assert.doesNotThrow(() => world.dispatch(port, value));
      assert.equal(world.dispatch(port, value).kind, "rejected");
    }
    assert.doesNotThrow(() => world.dispatch(value, value));
    assert.doesNotThrow(() => world.advance(value));
    assert.doesNotThrow(() => world.waitUntil(value));
    assert.doesNotThrow(() => world.armCrash(value));
    assert.doesNotThrow(() => world.acquireLock(value, value, value));
    assert.doesNotThrow(() => world.takeoverLock(value, value, value));
    assert.doesNotThrow(() => world.fileSystem.writeFile(value, value));
    assert.doesNotThrow(() => enumerateSchedules(value));
    assert.doesNotThrow(() => runUntil(value, value));
  }
  assert.equal(world.isAlive(), true);
});

test("semantic trace comparison ignores operational crash noise but detects changed effects", () => {
  const first = new SimTrace();
  const second = new SimTrace();
  first.append(0, "semantic", "toy", "accepted", "same", Object.freeze({ root: "a" }));
  second.append(9, "operational", "world", "restarted", "restart", Object.freeze({ count: 1 }));
  second.append(10, "semantic", "toy", "accepted", "same", Object.freeze({ root: "a" }));
  assert.equal(assertTraceEquivalent(first, second).kind, "equivalent");
  second.append(11, "semantic", "toy", "accepted", "same", Object.freeze({ root: "b" }));
  assert.equal(assertTraceEquivalent(first, second).kind, "different");
  assert.equal(assertTraceEquivalent(null, second).kind, "invalid");
});
