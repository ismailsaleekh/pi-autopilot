import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BG_REQUEST_CHANNEL,
  BG_RESPONSE_CHANNEL,
  BG_TERMINAL_CHANNEL,
  BG_REQUEST_SCHEMA,
  BG_RESPONSE_SCHEMA,
  BG_TERMINAL_SCHEMA,
  PiBackgroundTaskClient,
  unavailableCapabilities,
} from "../src/background-tasks.ts";

function eventBus() {
  const listeners = new Map();
  return {
    emitted: [],
    emit(channel, data) {
      this.emitted.push({ channel, data });
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
  };
}

test("PiBackgroundTaskClient uses the documented event-bus request/response protocol", async () => {
  const bus = eventBus();
  bus.on(BG_REQUEST_CHANNEL, (request) => {
    assert.equal(request.schema_version, BG_REQUEST_SCHEMA);
    assert.equal(request.operation, "capabilities");
    bus.emit(BG_RESPONSE_CHANNEL, {
      schema_version: BG_RESPONSE_SCHEMA,
      request_id: request.request_id,
      operation: request.operation,
      ok: true,
      result: completeCapabilities(),
    });
  });
  const client = new PiBackgroundTaskClient(bus);
  assert.deepEqual(await client.capabilities(), completeCapabilities());
  await client.close();
});

test("PiBackgroundTaskClient preserves bg_run descriptor identity and omits absent timeout", async () => {
  const bus = eventBus();
  const descriptor = bgRunDescriptor();
  bus.on(BG_REQUEST_CHANNEL, (request) => {
    assert.equal(request.operation, "run");
    assert.equal(request.payload, descriptor, "run payload must be the validated Core descriptor object, not a rewrite");
    assert.equal(request.payload.triggerOnCompletion, true, "the generic background client must remain policy-neutral");
    assert.equal(Object.prototype.hasOwnProperty.call(request.payload, "timeoutSeconds"), false);
    bus.emit(BG_RESPONSE_CHANNEL, {
      schema_version: BG_RESPONSE_SCHEMA,
      request_id: request.request_id,
      operation: "run",
      ok: true,
      result: taskSnapshot("running"),
    });
  });
  const client = new PiBackgroundTaskClient(bus);
  assert.deepEqual(await client.run(descriptor), taskSnapshot("running"));
  await client.close();
});

test("PiBackgroundTaskClient awaits terminal handlers and rejects malformed terminal frames", async () => {
  const bus = eventBus();
  const client = new PiBackgroundTaskClient(bus);
  const terminals = [];
  client.onTerminal(async (task) => {
    terminals.push(task);
  });

  bus.emit(BG_TERMINAL_CHANNEL, { schema_version: BG_TERMINAL_SCHEMA, task: taskSnapshot("completed") });
  await client.drainTerminalHandlers();
  assert.deepEqual(terminals, [taskSnapshot("completed")]);

  assert.throws(
    () => bus.emit(BG_TERMINAL_CHANNEL, { schema_version: BG_TERMINAL_SCHEMA, task: taskSnapshot("completed"), extra: true }),
    /unknown key extra/u,
  );
  await assert.rejects(client.drainTerminalHandlers(), /unknown key extra/u);
  await assert.rejects(client.close(), /unknown key extra/u);
});

test("PiBackgroundTaskClient rejects unmapped background-task statuses", async () => {
  const bus = eventBus();
  const client = new PiBackgroundTaskClient(bus);
  assert.throws(
    () => bus.emit(BG_TERMINAL_CHANNEL, { schema_version: BG_TERMINAL_SCHEMA, task: taskSnapshot("interrupted") }),
    /terminal\.task\.status must be one of completed, failed, killed; got interrupted/u,
  );
  await assert.rejects(client.close(), /terminal\.task\.status/u);
});

test("PiBackgroundTaskClient surfaces terminal handler rejection", async () => {
  const bus = eventBus();
  const client = new PiBackgroundTaskClient(bus);
  client.onTerminal(async () => {
    throw new Error("handler exploded");
  });
  bus.emit(BG_TERMINAL_CHANNEL, { schema_version: BG_TERMINAL_SCHEMA, task: taskSnapshot("failed") });
  await assert.rejects(client.drainTerminalHandlers(), /handler exploded/u);
  await assert.rejects(client.capabilities(), /handler exploded/u);
  assert.throws(() => client.onTerminal(async () => {}), /handler exploded/u);
  await assert.rejects(client.close(), /handler exploded/u);
});


test("PiBackgroundTaskClient latches malformed response frames even without a pending request", async () => {
  const bus = eventBus();
  const client = new PiBackgroundTaskClient(bus);
  bus.emit(BG_RESPONSE_CHANNEL, {
    schema_version: BG_RESPONSE_SCHEMA,
    request_id: "orphan",
    operation: "capabilities",
    ok: true,
    result: completeCapabilities(),
    extra: true,
  });
  await assert.rejects(client.capabilities(), /unknown key extra/u);
  await assert.rejects(client.close(), /unknown key extra/u);
});

test("PiBackgroundTaskClient fails loud on malformed, drifted, or absent responders", async () => {
  const malformed = eventBus();
  malformed.on(BG_REQUEST_CHANNEL, (request) => malformed.emit(BG_RESPONSE_CHANNEL, {
    schema_version: BG_RESPONSE_SCHEMA,
    request_id: request.request_id,
    operation: request.operation,
    ok: true,
    result: completeCapabilities(),
    extra: true,
  }));
  const malformedClient = new PiBackgroundTaskClient(malformed);
  await assert.rejects(malformedClient.capabilities(), /unknown key extra/u);
  await assert.rejects(malformedClient.close(), /unknown key extra/u);

  const drifted = eventBus();
  drifted.on(BG_REQUEST_CHANNEL, (request) => drifted.emit(BG_RESPONSE_CHANNEL, {
    schema_version: BG_RESPONSE_SCHEMA,
    request_id: request.request_id,
    operation: "run",
    ok: true,
    result: completeCapabilities(),
  }));
  const driftedClient = new PiBackgroundTaskClient(drifted);
  await assert.rejects(driftedClient.capabilities(), /operation mismatch/u);
  await driftedClient.close();

  const missing = new PiBackgroundTaskClient(eventBus());
  await assert.rejects(missing.capabilities(), /timed out/u);
  await missing.close();
});

test("PiBackgroundTaskClient rejects null timeout instead of forwarding it", async () => {
  const bus = eventBus();
  const client = new PiBackgroundTaskClient(bus);
  await assert.rejects(client.run({ ...bgRunDescriptor(), timeoutSeconds: null }), /bg_run.timeoutSeconds must be a positive integer/u);
  assert.equal(bus.emitted.length, 0, "invalid descriptors must not mutate the event bus");
  await client.close();
});

test("unavailableCapabilities is fail-closed and contains no silent partial fallback", () => {
  assert.deepEqual(unavailableCapabilities(), {
    api_version: 1,
    run: false,
    run_is_agent: false,
    run_completion_trigger: false,
    status: false,
    logs: false,
    logs_bounded: false,
    kill: false,
  });
});

function completeCapabilities() {
  return {
    api_version: 1,
    run: true,
    run_is_agent: true,
    run_completion_trigger: true,
    status: true,
    logs: true,
    logs_bounded: true,
    kill: true,
  };
}

function bgRunDescriptor() {
  return {
    name: "Exact Runner",
    command: "'node' '/pkg/bin/autopilot-agent-run.mjs' --spec '/tmp/spec.json'",
    isAgent: true,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
  };
}

function taskSnapshot(status) {
  return {
    id: "task-1",
    name: "Exact Runner",
    command: bgRunDescriptor().command,
    status,
    outputPath: "/tmp/task.output",
  };
}
