import "./runtime-production.test.js";
import assert from "node:assert/strict";
import test from "node:test";
import { SimWorld } from "../simulation/sim-world.js";
import { verifyCrashMatrix, verifyCrashResume } from "./harness.js";
import { injectCrashAt } from "./injector.js";
import {
  CRASH_POINT_IDS,
  CRASH_POINT_REGISTRY,
} from "./registry.js";
import { SimJournal } from "./sim-journal.js";
import {
  GIT_TOY_CRASH_POINTS,
  TOY_CRASH_POINTS,
  toyCrashScenario,
  toyGitCrashScenario,
} from "./toy-machine.js";

test("crash-point registry is complete, unique, and classifies every exposed durable window", () => {
  assert.equal(new Set(CRASH_POINT_IDS).size, CRASH_POINT_IDS.length);
  assert.equal(CRASH_POINT_REGISTRY.length, CRASH_POINT_IDS.length);
  const required = Object.freeze([
    "store.install.append",
    "store.install.file-fsync",
    "store.install.rename",
    "store.install.directory-fsync",
    "store.install.ack",
    "journal.append",
    "journal.fsync",
    "journal.ack",
    "git.publish.before-read",
    "git.publish.after-read",
    "git.publish.before-cas",
    "git.publish.after-cas",
    "git.publish.ack",
  ]);
  for (const point of required) {
    assert.equal(CRASH_POINT_IDS.some((candidate) => candidate === point), true, point);
  }
});

test("toy object-first machine resumes equivalently at every demonstrated store and journal point", () => {
  const matrix = verifyCrashMatrix(toyCrashScenario, TOY_CRASH_POINTS);
  assert.equal(matrix.invalid, 0);
  assert.equal(matrix.notReached, 0);
  assert.equal(matrix.verified, TOY_CRASH_POINTS.length);
  for (const result of matrix.results) {
    assert.equal(result.kind, "verified");
    if (result.kind === "verified") {
      assert.equal(result.equivalence.kind, "equivalent");
    }
  }
});

test("toy git publication resumes equivalently at every compare-and-swap window", () => {
  const matrix = verifyCrashMatrix(toyGitCrashScenario, GIT_TOY_CRASH_POINTS);
  assert.equal(matrix.invalid, 0);
  assert.equal(matrix.notReached, 0);
  assert.equal(matrix.verified, GIT_TOY_CRASH_POINTS.length);
});

test("an exact crash occurrence is selected and an unreachable occurrence is reported", () => {
  const reached = verifyCrashResume(toyCrashScenario, Object.freeze({ id: "journal.append", occurrence: 1 }));
  const unreachable = verifyCrashResume(toyCrashScenario, Object.freeze({ id: "journal.append", occurrence: 99 }));
  assert.equal(reached.kind, "verified");
  assert.equal(unreachable.kind, "not-reached");
});

test("injector and harness are total over malformed inputs and reject vacuous completion", () => {
  const world = new SimWorld(1);
  assert.equal(injectCrashAt(null, "journal.append").kind, "invalid");
  assert.equal(injectCrashAt(world, "unknown.point").kind, "invalid");
  assert.equal(verifyCrashResume(null, null).kind, "invalid");
  assert.doesNotThrow(() => verifyCrashMatrix(Object.freeze({}), Object.freeze([null, 1, "bad"])));
  const vacuous = verifyCrashResume(Object.freeze({
    id: "vacuous",
    create: () => new SimWorld(2),
    drive: () => Object.freeze({ kind: "complete" }),
    completed: () => true,
  }), Object.freeze({ id: "journal.append", occurrence: 1 }));
  assert.equal(vacuous.kind, "not-reached");
  const lying = verifyCrashResume(Object.freeze({
    id: "lying",
    create: () => new SimWorld(3),
    drive: () => Object.freeze({ kind: "complete" }),
    completed: () => false,
  }), Object.freeze({ id: "journal.append", occurrence: 1 }));
  assert.equal(lying.kind, "invalid");
});

test("journal replay accepts the longest framed prefix and marks a torn suffix", () => {
  const world = new SimWorld(2);
  const journal = new SimJournal(world);
  assert.equal(journal.append(Object.freeze({ kind: "first", value: 1 })).kind, "appended");
  assert.equal(world.fileSystem.appendFile("/journal/run.log", Uint8Array.from([0, 0, 0]), "filesystem.append").kind, "ok");
  assert.equal(world.fileSystem.fsyncFile("/journal/run.log", "filesystem.file-fsync").kind, "ok");
  const replay = journal.replay();
  assert.equal(replay.kind, "valid-prefix");
  if (replay.kind === "valid-prefix") {
    assert.equal(replay.records.length, 1);
    assert.equal(replay.tornSuffix, true);
    assert.ok(replay.validBytes < replay.totalBytes);
  }
});
