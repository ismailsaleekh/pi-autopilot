import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitForDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defineCapsule, jsonValue } from "../../../authority/protocol/schema.js";
import {
  ProcessAdapter,
  ProcessHandle,
} from "../../../adapters/process/index.js";
import type {
  ProcessObservation,
  ProcessStartRequest,
} from "../../../adapters/process/index.js";
import {
  nodeFileCaptureSink,
  nodeProcessGraceWaiter,
} from "./node-process-capabilities.js";

const fixtureModule = fileURLToPath(new URL("./process-fixture.js", import.meta.url));
const GIBIBYTE = 1024 * 1024 * 1024;
const environmentCapsule = defineCapsule("ProcessFixtureEnvironment", jsonValue());

async function temporaryDirectory(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `autopilot-process-${label}-`));
}

function request(
  directory: string,
  captureId: string,
  argumentsInput: readonly string[],
  environment: Readonly<Record<string, string>> = Object.freeze({}),
  maximumBytes: number = 64 * 1024,
): ProcessStartRequest {
  return Object.freeze({
    arguments: Object.freeze([fixtureModule, ...argumentsInput]),
    captureDirectory: directory,
    captureId,
    cwd: directory,
    environment,
    executable: process.execPath,
    maxStderrBytes: maximumBytes,
    maxStdoutBytes: maximumBytes,
  });
}

async function started(
  adapter: ProcessAdapter,
  startRequest: ProcessStartRequest,
): Promise<ProcessHandle> {
  const result = await adapter.start(startRequest);
  if (result.kind === "rejected") {
    throw new Error(`${result.diagnostic.code}: ${result.diagnostic.message}`);
  }
  assert.equal(result.kind, "started");
  assert.ok(result.handle instanceof ProcessHandle);
  return result.handle;
}

async function eventually<Value>(
  observe: () => Value,
  accept: (value: Value) => boolean,
  timeoutMilliseconds: number = 15_000,
): Promise<Value> {
  const startedAt = process.hrtime.bigint();
  while (true) {
    const value = observe();
    if (accept(value)) {
      return value;
    }
    const elapsed = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    if (elapsed >= timeoutMilliseconds) {
      throw new Error(`condition was not observed within ${String(timeoutMilliseconds)}ms`);
    }
    await waitForDelay(10);
  }
}

async function eventuallyAsync<Value>(
  observe: () => Promise<Value>,
  accept: (value: Value) => boolean,
  timeoutMilliseconds: number = 15_000,
): Promise<Value> {
  const startedAt = process.hrtime.bigint();
  while (true) {
    const value = await observe();
    if (accept(value)) {
      return value;
    }
    const elapsed = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    if (elapsed >= timeoutMilliseconds) {
      throw new Error(`condition was not observed within ${String(timeoutMilliseconds)}ms`);
    }
    await waitForDelay(10);
  }
}

async function exited(adapter: ProcessAdapter, handle: ProcessHandle): Promise<ProcessObservation> {
  return eventually(
    () => {
      const result = adapter.observe(handle);
      if (result.kind === "rejected") {
        throw new Error(result.diagnostic.code);
      }
      return result.observation;
    },
    (value) => value.lifecycle.kind !== "running",
  );
}

async function outputText(
  adapter: ProcessAdapter,
  handle: ProcessHandle,
  stream: "stdout" | "stderr" = "stdout",
): Promise<string> {
  const result = await adapter.collectOutput(handle, {
    direction: "head",
    maxBytes: 1024 * 1024,
    stream,
  });
  if (result.kind === "rejected") {
    throw new Error(result.diagnostic.code);
  }
  return Buffer.from(result.observation.bytes).toString("utf8");
}

function processAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null) {
      try {
        return Reflect.get(error, "code") === "ESRCH";
      } catch {
        return false;
      }
    }
    return false;
  }
}

test("process lifecycle preserves exact exit code and signal observations", async (context) => {
  await context.test("exit code", async () => {
    const directory = await temporaryDirectory("exit");
    const adapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
    try {
      const handle = await started(adapter, request(directory, "exit-code", ["exit", "23"]));
      const observation = await exited(adapter, handle);
      assert.deepEqual(observation.lifecycle, { code: 23, kind: "exited" });
      await handle.capturesSettled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await context.test("signal", async () => {
    const directory = await temporaryDirectory("signal");
    const adapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
    try {
      const handle = await started(adapter, request(directory, "self-signal", ["signal-self", "SIGTERM"]));
      const observation = await exited(adapter, handle);
      assert.deepEqual(observation.lifecycle, { kind: "signalled", signal: "SIGTERM" });
      await handle.capturesSettled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

test("explicit environment allowlist excludes ambient parent variables", async () => {
  const directory = await temporaryDirectory("environment");
  const adapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
  process.env["AUTOPILOT_AMBIENT_SENTINEL"] = "must-not-cross";
  try {
    const handle = await started(adapter, request(
      directory,
      "environment",
      ["environment"],
      Object.freeze({ ALLOWED_ONLY: "present" }),
    ));
    const observation = await exited(adapter, handle);
    await handle.capturesSettled();
    assert.deepEqual(observation.environmentKeys, ["ALLOWED_ONLY"]);
    const decodedEnvironment = environmentCapsule.decodeCanonical(Buffer.from(await outputText(adapter, handle), "utf8"));
    assert.equal(decodedEnvironment.kind, "ok");
    const childEnvironment: unknown = decodedEnvironment.kind === "ok" ? decodedEnvironment.value : null;
    assert.equal(typeof childEnvironment, "object");
    assert.notEqual(childEnvironment, null);
    if (typeof childEnvironment !== "object" || childEnvironment === null) {
      throw new Error("child environment was not an object");
    }
    assert.equal(Reflect.get(childEnvironment, "ALLOWED_ONLY"), "present");
    assert.equal(Reflect.get(childEnvironment, "AUTOPILOT_AMBIENT_SENTINEL"), undefined);
  } finally {
    delete process.env["AUTOPILOT_AMBIENT_SENTINEL"];
    await rm(directory, { force: true, recursive: true });
  }
});

test("capture identities reject concurrent owners and safely truncate completed retries", async () => {
  const directory = await temporaryDirectory("capture-retry");
  const adapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
  let active: ProcessHandle | null = null;
  try {
    active = await started(adapter, request(directory, "active-action", ["group-child"]));
    assert.deepEqual(Reflect.ownKeys(active), []);
    assert.equal(Reflect.set(active, "pid", process.pid), false);
    assert.equal(Reflect.defineProperty(active, "pid", { value: process.pid }), false);
    const collision = await adapter.start(request(directory, "active-action", ["text", "must-not-run"]));
    assert.equal(collision.kind, "rejected");
    if (collision.kind === "rejected") {
      assert.equal(collision.diagnostic.code, "capture-acquire-in-use");
    }
    await adapter.terminate(active, { graceMilliseconds: 0 });
    await eventually(
      () => {
        const observed = adapter.observe(active);
        return observed.kind === "observed" ? observed.observation.processGroup.kind : "unobservable";
      },
      (kind) => kind === "absent",
    );
    await active.capturesSettled();
    active = null;

    const first = await started(adapter, request(directory, "same-action", ["text", "first-attempt"]));
    await adapter.waitForExit(first);
    assert.equal(await outputText(adapter, first), "first-attempt\n");

    const second = await started(adapter, request(directory, "same-action", ["text", "second-attempt"]));
    await adapter.waitForExit(second);
    assert.equal(await outputText(adapter, second), "second-attempt\n");

    const preservedStdout = join(directory, "pair-failure.stdout");
    await writeFile(preservedStdout, "prior-capture\n");
    await mkdir(join(directory, "pair-failure.stderr"));
    const pairFailure = await adapter.start(request(
      directory,
      "pair-failure",
      ["text", "must-not-run"],
    ));
    assert.equal(pairFailure.kind, "rejected");
    assert.equal(await readFile(preservedStdout, "utf8"), "prior-capture\n");

    if (process.platform !== "win32") {
      const outside = join(directory, "outside-must-not-change");
      await writeFile(outside, "preserved\n");
      await symlink(outside, join(directory, "symlink-action.stdout"));
      const symlinkAttempt = await adapter.start(request(
        directory,
        "symlink-action",
        ["text", "must-not-clobber"],
      ));
      assert.equal(symlinkAttempt.kind, "rejected");
      assert.equal(await readFile(outside, "utf8"), "preserved\n");
    }
  } finally {
    if (active !== null) {
      adapter.signal(active, "SIGKILL");
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("one-GiB stdout flood is drained into a bounded file with typed truncation", { timeout: 120_000 }, async () => {
  const directory = await temporaryDirectory("flood");
  const adapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
  try {
    const handle = await started(adapter, request(
      directory,
      "flood",
      ["flood", String(GIBIBYTE)],
      Object.freeze({}),
      64 * 1024,
    ));
    await exited(adapter, handle);
    await handle.capturesSettled();
    const observed = adapter.observe(handle);
    assert.equal(observed.kind, "observed");
    if (observed.kind !== "observed") {
      throw new Error("process observation unavailable");
    }
    assert.equal(observed.observation.stdout.observedBytes, String(GIBIBYTE));
    assert.equal(observed.observation.stdout.capturedBytes, String(64 * 1024));
    assert.equal(observed.observation.stdout.truncated, true);
    assert.equal((await stat(observed.observation.stdout.path)).size, 64 * 1024);
    const collected = await adapter.collectOutput(handle, {
      direction: "tail",
      maxBytes: 4096,
      stream: "stdout",
    });
    assert.equal(collected.kind, "collected");
    if (collected.kind === "collected") {
      assert.equal(collected.observation.bytes.byteLength, 4096);
      assert.equal(collected.observation.sourceTruncated, true);
      assert.equal(collected.observation.truncated, true);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("a surviving descendant is fenced after root exit and repeated fencing cannot reach a reused group", { timeout: 30_000 }, async () => {
  const directory = await temporaryDirectory("root-exit-descendant");
  const adapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
  let handle: ProcessHandle | null = null;
  try {
    const runningHandle = await started(adapter, request(directory, "root-exit", ["group-root-exits"]));
    handle = runningHandle;
    const descendantText = await eventuallyAsync(
      () => outputText(adapter, runningHandle),
      (value) => /[0-9]+\n/.test(value),
    );
    const descendantPid = Number(descendantText.trim());
    const rootExit = await exited(adapter, runningHandle);
    assert.deepEqual(rootExit.lifecycle, { code: 0, kind: "exited" });
    assert.equal(rootExit.processGroup.kind, "alive");

    const terminated = await adapter.terminate(runningHandle, { graceMilliseconds: 0 });
    assert.equal(terminated.kind, "terminated");
    if (terminated.kind === "terminated") {
      assert.equal(terminated.observation.gracefulSignal.state, "delivered");
      assert.equal(terminated.observation.killSignal?.state, "delivered");
    }
    await eventually(
      () => {
        const observed = adapter.observe(runningHandle);
        return observed.kind === "observed" ? observed.observation.processGroup.kind : "unobservable";
      },
      (kind) => kind === "absent",
    );
    await eventually(() => processAbsent(descendantPid), (absent) => absent);

    const repeated = await adapter.terminate(runningHandle, { graceMilliseconds: 0 });
    assert.equal(repeated.kind, "terminated");
    if (repeated.kind === "terminated") {
      assert.equal(repeated.observation.gracefulSignal.state, "already-absent");
      assert.equal(repeated.observation.killSignal, null);
      assert.equal(repeated.observation.after.processGroup.kind, "absent");
    }
  } finally {
    if (handle !== null) {
      adapter.signal(handle, "SIGKILL");
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("SIGKILL escalation targets the process group and leaves no descendant orphan", { timeout: 30_000 }, async () => {
  const directory = await temporaryDirectory("kill-storm");
  const adapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
  let handle: ProcessHandle | null = null;
  try {
    const runningHandle = await started(adapter, request(directory, "kill-storm", ["group-parent"]));
    handle = runningHandle;
    const descendantText = await eventuallyAsync(
      () => outputText(adapter, runningHandle),
      (value) => /[0-9]+\n/.test(value),
    );
    const descendantPid = Number(descendantText.trim());
    assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true);

    const terminated = await adapter.terminate(runningHandle, { graceMilliseconds: 50 });
    assert.equal(terminated.kind, "terminated");
    if (terminated.kind === "terminated") {
      assert.equal(terminated.observation.gracefulSignal.requestedSignal, "SIGTERM");
      assert.equal(terminated.observation.escalated, true);
      assert.equal(terminated.observation.killSignal?.requestedSignal, "SIGKILL");
    }
    const finalObservation = await eventually(
      () => {
        const result = adapter.observe(runningHandle);
        if (result.kind === "rejected") {
          throw new Error(result.diagnostic.code);
        }
        return result.observation;
      },
      (value) => value.processGroup.kind === "absent" && value.lifecycle.kind !== "running",
    );
    assert.deepEqual(finalObservation.lifecycle, { kind: "signalled", signal: "SIGKILL" });
    await eventually(() => processAbsent(descendantPid), (absent) => absent);
    await runningHandle.capturesSettled();
  } finally {
    if (handle !== null) {
      adapter.signal(handle, "SIGKILL");
    }
    await rm(directory, { force: true, recursive: true });
  }
});
