import { canonicalDigestUnknown } from "../../authority/protocol/schema.js";
import { SimWorld } from "../simulation/sim-world.js";
import { bytesEqual, encodeUtf8 } from "../simulation/values.js";
import type { CrashDriveResult, CrashScenario } from "./harness.js";
import { SimJournal } from "./sim-journal.js";

const OBJECT_TEMP = "/store/object.tmp";
const OBJECT_PATH = "/store/object.bin";
const OBJECT_DIRECTORY = "/store";
const GIT_HEAD = "/git/head";
const GIT_DIRECTORY = "/git";
const OBJECT_BYTES = Uint8Array.from([0, 1, 2, 3, 255]);
const BASE_HEAD = encodeUtf8("base-head\n");
const DESIRED_HEAD = encodeUtf8("desired-head\n");

function recordKind(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const kind = Reflect.get(value, "kind");
    return typeof kind === "string" ? kind : null;
  } catch {
    return null;
  }
}

function installObject(world: SimWorld): "installed" | "crashed" | "invalid" {
  if (!world.fileSystem.exists(OBJECT_PATH)) {
    const temporary = world.fileSystem.readFile(OBJECT_TEMP);
    if (temporary.kind !== "ok" || !bytesEqual(temporary.bytes, OBJECT_BYTES)) {
      const appended = world.fileSystem.appendFile(OBJECT_TEMP, OBJECT_BYTES, "store.install.append");
      if (appended.kind === "crashed" || !world.isAlive()) return "crashed";
      if (appended.kind !== "ok") return "invalid";
    }
    const fileSync = world.fileSystem.fsyncFile(OBJECT_TEMP, "store.install.file-fsync");
    if (fileSync.kind === "crashed" || !world.isAlive()) return "crashed";
    if (fileSync.kind !== "ok") return "invalid";
    const renamed = world.fileSystem.rename(OBJECT_TEMP, OBJECT_PATH, "store.install.rename");
    if (renamed.kind === "crashed" || !world.isAlive()) return "crashed";
    if (renamed.kind !== "ok") return "invalid";
    const directorySync = world.fileSystem.fsyncDirectory(OBJECT_DIRECTORY, "store.install.directory-fsync");
    if (directorySync.kind === "crashed" || !world.isAlive()) return "crashed";
    if (directorySync.kind !== "ok") return "invalid";
  }
  const installed = world.fileSystem.readFile(OBJECT_PATH);
  if (installed.kind !== "ok" || !bytesEqual(installed.bytes, OBJECT_BYTES)) return "invalid";
  if (world.durabilityPoint("store.install.ack", Object.freeze({ digest: canonicalDigestUnknown([...OBJECT_BYTES]) }))) return "crashed";
  return "installed";
}

function driveToy(world: SimWorld): CrashDriveResult {
  const objectRoot = canonicalDigestUnknown(Object.freeze({ bytes: [...OBJECT_BYTES], domain: "toy-object-v2" }));
  const journal = new SimJournal(world);
  if (!world.isAlive()) return Object.freeze({ kind: "crashed" });
  const replay = journal.replay();
  if (replay.kind === "invalid" || replay.tornSuffix) return Object.freeze({ kind: "invalid", diagnostic: "toy journal does not have a valid complete prefix" });
  const hasInstalled = replay.records.some((record) => recordKind(record) === "object-installed");
  const hasDone = replay.records.some((record) => recordKind(record) === "done");
  if (!hasInstalled) {
    const installed = installObject(world);
    if (installed === "crashed") return Object.freeze({ kind: "crashed" });
    if (installed === "invalid") return Object.freeze({ kind: "invalid", diagnostic: "object-first installation failed" });
    const appended = journal.append(Object.freeze({ kind: "object-installed", root: objectRoot }));
    return appended.kind === "crashed" ? Object.freeze({ kind: "crashed" }) : appended.kind === "invalid" ? Object.freeze({ kind: "invalid", diagnostic: appended.diagnostic }) : Object.freeze({ kind: "progress" });
  }
  if (!hasDone) {
    const appended = journal.append(Object.freeze({ kind: "done", root: objectRoot }));
    return appended.kind === "crashed" ? Object.freeze({ kind: "crashed" }) : appended.kind === "invalid" ? Object.freeze({ kind: "invalid", diagnostic: appended.diagnostic }) : Object.freeze({ kind: "progress" });
  }
  world.trace.append(world.clock.now(), "semantic", "toy", "complete", `toy:complete:${objectRoot}`, Object.freeze({ root: objectRoot }));
  return Object.freeze({ kind: "complete" });
}

export const toyCrashScenario: CrashScenario = Object.freeze({
  id: "toy-object-first-journal-second-v2",
  create: () => new SimWorld(0x5eed_1234),
  drive: driveToy,
  completed: (world: SimWorld) => world.trace.snapshot().some((event) => event.category === "semantic" && event.source === "toy" && event.name === "complete"),
  maxDrives: 16,
});

export const TOY_CRASH_POINTS = Object.freeze([
  "store.install.append",
  "store.install.file-fsync",
  "store.install.rename",
  "store.install.directory-fsync",
  "store.install.ack",
  "journal.append",
  "journal.fsync",
  "journal.ack",
]);

function initializeHead(world: SimWorld): boolean {
  if (world.fileSystem.exists(GIT_HEAD)) return true;
  if (world.fileSystem.writeFile(GIT_HEAD, BASE_HEAD).kind !== "ok") return false;
  if (world.fileSystem.fsyncFile(GIT_HEAD, "filesystem.file-fsync").kind !== "ok") return false;
  return world.fileSystem.fsyncDirectory(GIT_DIRECTORY, "filesystem.directory-fsync").kind === "ok";
}

function driveGitToy(world: SimWorld): CrashDriveResult {
  if (!initializeHead(world)) return world.isAlive() ? Object.freeze({ kind: "invalid", diagnostic: "Git head fixture could not be made durable" }) : Object.freeze({ kind: "crashed" });
  const current = world.fileSystem.readFile(GIT_HEAD);
  if (current.kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: "Git head could not be read" });
  if (!bytesEqual(current.bytes, DESIRED_HEAD)) {
    if (world.durabilityPoint("git.publish.before-read", Object.freeze({ ref: "refs/heads/main" }))) return Object.freeze({ kind: "crashed" });
    const observed = world.fileSystem.readFile(GIT_HEAD);
    if (observed.kind !== "ok" || !bytesEqual(observed.bytes, BASE_HEAD)) return Object.freeze({ kind: "invalid", diagnostic: "Git compare-and-swap observed an unexpected head" });
    if (world.durabilityPoint("git.publish.after-read", Object.freeze({ observed: "base-head" }))) return Object.freeze({ kind: "crashed" });
    if (world.durabilityPoint("git.publish.before-cas", Object.freeze({ desired: "desired-head" }))) return Object.freeze({ kind: "crashed" });
    if (world.fileSystem.writeFile(GIT_HEAD, DESIRED_HEAD).kind !== "ok" || world.fileSystem.fsyncFile(GIT_HEAD, "filesystem.file-fsync").kind !== "ok" || world.fileSystem.fsyncDirectory(GIT_DIRECTORY, "filesystem.directory-fsync").kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: "Git compare-and-swap was not durable" });
    if (world.durabilityPoint("git.publish.after-cas", Object.freeze({ desired: "desired-head" }))) return Object.freeze({ kind: "crashed" });
  }
  if (world.durabilityPoint("git.publish.ack", Object.freeze({ desired: "desired-head" }))) return Object.freeze({ kind: "crashed" });
  world.trace.append(world.clock.now(), "semantic", "toy-git", "complete", "toy-git:complete:desired-head", Object.freeze({ revision: "desired-head" }));
  return Object.freeze({ kind: "complete" });
}

export const toyGitCrashScenario: CrashScenario = Object.freeze({
  id: "toy-git-publication-cas-v2",
  create: () => new SimWorld(0x5eed_5678),
  drive: driveGitToy,
  completed: (world: SimWorld) => world.trace.snapshot().some((event) => event.category === "semantic" && event.source === "toy-git" && event.name === "complete"),
  maxDrives: 8,
});

export const GIT_TOY_CRASH_POINTS = Object.freeze([
  "git.publish.before-read",
  "git.publish.after-read",
  "git.publish.before-cas",
  "git.publish.after-cas",
  "git.publish.ack",
]);
