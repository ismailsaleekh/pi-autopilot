import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import autopilotExtension from "../src/extension.ts";
import { AUTOPILOT_COMMANDS, AUTOPILOT_OPERATOR_ANSWER_COMMAND, registerAutopilotCommands } from "../src/commands.ts";

const D76_PUBLIC_COMMANDS = Object.freeze([
  "autopilot-plan",
  "autopilot",
  "autopilot-onboard",
  "autopilot-inject",
  "autopilot-status",
  "autopilot-config",
  "autopilot-handoff",
  "autopilot-close",
  "autopilot-abort",
]);

const W1_HOST_ONLY_COMMANDS = Object.freeze(["autopilot-answer"]);
const PROMPTED_EXTRA_COMMANDS = Object.freeze(["autopilot-resume", "autopilot-help"]);

test("registers the retained D76 public commands", () => {
  const pi = fakePi();
  registerAutopilotCommands(pi, { transport: fakeTransport(), backgroundTasks: fakeBackgroundTasks(), operatorMessage: fakeOperatorMessage() });

  assert.deepEqual([...AUTOPILOT_COMMANDS], D76_PUBLIC_COMMANDS);
  assert.equal(AUTOPILOT_OPERATOR_ANSWER_COMMAND, "autopilot-answer");
  assert.deepEqual([...pi.registrations.keys()], [...D76_PUBLIC_COMMANDS, ...W1_HOST_ONLY_COMMANDS]);
  for (const name of PROMPTED_EXTRA_COMMANDS) {
    assert.equal(pi.registrations.has(name), false, `${name} is not in D76 §21 public surface`);
  }
});

test("each command forwards one command frame with command name and raw argument bytes", async () => {
  for (const command of AUTOPILOT_COMMANDS) {
    const pi = fakePi();
    const transport = fakeTransport();
    registerAutopilotCommands(pi, { transport, backgroundTasks: fakeBackgroundTasks(), operatorMessage: fakeOperatorMessage() });

    const rawArgs = "  keep  spacing --and-bytes=✓  ";
    await pi.registrations.get(command).handler(rawArgs, fakeCtx());

    assert.deepEqual(transport.calls, [{ kind: "command", payload: { raw: `${command}${rawArgs}`, background_capabilities: completeCapabilities() } }], command);
  }
});

test("command framing inserts only the missing delimiter before raw arguments", async () => {
  const pi = fakePi();
  const transport = fakeTransport();
  registerAutopilotCommands(pi, { transport, backgroundTasks: fakeBackgroundTasks(), operatorMessage: fakeOperatorMessage() });

  const rawArgs = "keep  spacing --and-bytes=✓";
  await pi.registrations.get("autopilot-onboard").handler(rawArgs, fakeCtx());

  assert.deepEqual(transport.calls, [{ kind: "command", payload: { raw: `autopilot-onboard ${rawArgs}`, background_capabilities: completeCapabilities() } }]);
});

test("registered command handlers contain no local control branch", () => {
  const pi = fakePi();
  registerAutopilotCommands(pi, { transport: fakeTransport(), backgroundTasks: fakeBackgroundTasks(), operatorMessage: fakeOperatorMessage() });

  for (const [name, definition] of pi.registrations) {
    if (name === AUTOPILOT_OPERATOR_ANSWER_COMMAND) continue;
    const body = definition.handler.toString();
    assert.doesNotMatch(body, /\b(if|switch|case)\b/u, name);
    assert.doesNotMatch(body, /runPhase|laneState|candidateState|parallelCap|FORWARD_READY|NEEDS_FIX/u, name);
  }
});

// Autopilot owns no public Pi tool call. Core-issued launches travel
// Core -> Host -> the pi-background-tasks EventBus service, and child agents run
// with `--no-extensions`. Registering a `tool_call` interceptor would therefore
// place every operator/model/other-extension tool call (notably `bg_run`) under
// Autopilot authority it cannot legitimately claim, so no such hook may exist.
test("extension registers no tool_call interceptor over foreign tool calls", async () => {
  const pi = fakePi();
  const transport = fakeTransport();
  autopilotExtension(pi, { transport, backgroundTasks: fakeBackgroundTasks() });

  assert.equal(pi.events.has("tool_call"), false);
  assert.deepEqual([...pi.events.keys()].sort(), ["session_shutdown", "session_start"]);
  assert.deepEqual(transport.calls.filter((call) => call.kind === "guard-query"), []);
});

test("extension never emits a guard-query frame for any tool call", async () => {
  const pi = fakePi();
  const transport = fakeTransport();
  autopilotExtension(pi, { transport, backgroundTasks: fakeBackgroundTasks() });

  await pi.events.get("session_start")({ reason: "startup" }, fakeCtx());
  await pi.events.get("session_shutdown")({ reason: "quit" }, fakeCtx());

  assert.deepEqual(transport.calls.map((call) => call.kind), ["shutdown"]);
});

test("extension shutdown sends core shutdown and closes transport", async () => {
  const pi = fakePi();
  const transport = fakeTransport();
  autopilotExtension(pi, { transport, backgroundTasks: fakeBackgroundTasks() });

  await pi.events.get("session_shutdown")({ reason: "quit" }, fakeCtx());

  assert.deepEqual(transport.calls.at(-1), {
    kind: "shutdown",
    payload: { reason: "quit" },
    timeoutMs: 2000,
  });
  assert.equal(transport.closed, true);
});

test("operator-answer command sends a typed operator-answer frame", async () => {
  const pi = fakePi();
  const transport = fakeTransport();
  registerAutopilotCommands(pi, { transport, backgroundTasks: fakeBackgroundTasks(), operatorMessage: fakeOperatorMessage() });

  await pi.registrations.get("autopilot-answer").handler('q-1 {"decision":"answered","notes":["real sender"]}', fakeCtx());

  assert.deepEqual(transport.calls, [{ kind: "operator-answer", payload: { question_id: "q-1", answer: { decision: "answered", notes: ["real sender"] } } }]);
});

test("completed planning terminal sends task-completed then agent-result with real carrier identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-host-agent-result-"));
  const specPath = join(dir, "spec.json");
  const carrierPath = join(dir, "carrier.json");
  const action = terminalAction("action-plan", "assignment-plan", "planning task", `node wrapper --spec '${specPath}'`);
  const carrier = {
    schema: "autopilot.planning_carrier.v1",
    action_id: action.action_id,
    assignment_id: action.assignment_id,
    boundary_id: "planning.task-atoms.v1",
    raw_output: "atom: host sender",
  };
  await writeFile(specPath, JSON.stringify({
    action_id: action.action_id,
    assignment_id: action.assignment_id,
    boundary_id: carrier.boundary_id,
    result_contract: carrier.boundary_id,
    carrier_path: carrierPath,
  }), "utf8");
  await writeFile(carrierPath, JSON.stringify(carrier), "utf8");
  const pi = fakePi();
  let terminalHandler;
  const transport = {
    calls: [],
    async request(kind, payload) {
      this.calls.push({ kind, payload });
      if (kind === "command") return { v: 1, id: this.calls.length, kind: "spawn", payload: { action } };
      return { v: 1, id: this.calls.length, kind: "done", payload: { status: "ok" } };
    },
    close() {},
  };
  const backgroundTasks = {
    async capabilities() { return completeCapabilities(); },
    async run(descriptor) { return taskFromDescriptor(descriptor, "task-plan", "running"); },
    onTerminal(handler) { terminalHandler = handler; return () => {}; },
    async close() {},
  };

  autopilotExtension(pi, { transport, backgroundTasks });
  await pi.events.get("session_start")({}, fakeCtx());
  await pi.registrations.get("autopilot-plan").handler("main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md", fakeCtx());
  await terminalHandler(taskFromDescriptor(action.bg_run, "task-plan", "completed"));

  assert.deepEqual(transport.calls.map((call) => call.kind), ["command", "task-completed", "agent-result"]);
  assert.deepEqual(transport.calls.at(-1).payload, { assignment_id: action.assignment_id, carrier });
});

test("extension buffers an immediate terminal task until its exact action binding is recorded", async () => {
  const pi = fakePi();
  const firstAction = terminalAction("action-1", "assignment-1", "first exact task", "node first");
  const secondAction = terminalAction("action-2", "assignment-2", "second exact task", "node second");
  const transport = {
    calls: [],
    closed: false,
    async request(kind, payload, timeoutMs) {
      const call = timeoutMs === undefined ? { kind, payload } : { kind, payload, timeoutMs };
      this.calls.push(call);
      if (kind === "command") return { v: 1, id: this.calls.length, kind: "spawn", payload: { action: firstAction } };
      if (kind === "task-completed") {
        assert.deepEqual(payload, {
          task_id: "task-immediate",
          action_id: firstAction.action_id,
          assignment_id: firstAction.assignment_id,
          status: "failed",
        });
        return { v: 1, id: this.calls.length, kind: "spawn", payload: { action: secondAction } };
      }
      return { v: 1, id: this.calls.length, kind: "done", payload: { status: "ok" } };
    },
    close() { this.closed = true; },
  };
  let terminalHandler;
  const started = [];
  const backgroundTasks = {
    async capabilities() { return completeCapabilities(); },
    async run(descriptor) {
      started.push(descriptor);
      const task = taskFromDescriptor(descriptor, descriptor === firstAction.bg_run ? "task-immediate" : "task-second", descriptor === firstAction.bg_run ? "failed" : "running");
      if (descriptor === firstAction.bg_run) await terminalHandler(task);
      return task;
    },
    onTerminal(handler) { terminalHandler = handler; return () => {}; },
    async close() {},
  };

  autopilotExtension(pi, { transport, backgroundTasks });
  await pi.events.get("session_start")({ reason: "startup" }, fakeCtx());
  await pi.registrations.get("autopilot-plan").handler("main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md", fakeCtx());

  assert.deepEqual(started, [firstAction.bg_run, secondAction.bg_run]);
  assert.deepEqual(transport.calls.map((call) => call.kind), ["command", "task-completed"]);
});

function fakePi() {
  const registrations = new Map();
  const events = new Map();
  const messages = [];
  return {
    events,
    registrations,
    messages,
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, definition) {
      registrations.set(name, definition);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
}

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

function fakeBackgroundTasks() {
  return {
    async capabilities() { return completeCapabilities(); },
    async run(descriptor) { return { id: "task-1", command: descriptor.command, status: "running", outputPath: "/tmp/out" }; },
    onTerminal() { return () => {}; },
    close() {},
  };
}

function fakeTransport(options = {}) {
  const calls = [];
  return {
    calls,
    closed: false,
    async request(kind, payload, timeoutMs) {
      const call = timeoutMs === undefined ? { kind, payload } : { kind, payload, timeoutMs };
      calls.push(call);
      return { v: 1, id: calls.length, kind: "done", payload: { status: "ok" } };
    },
    close() {
      this.closed = true;
    },
  };
}

function fakeCtx() {
  return {
    hasUI: false,
    mode: "json",
    ui: { notify() { throw new Error("fakeCtx is non-UI"); } },
  };
}

function terminalAction(actionId, assignmentId, name, command) {
  return {
    action_id: actionId,
    assignment_id: assignmentId,
    kind: "launch-background",
    bg_run: {
      name,
      command,
      isAgent: true,
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    },
    run_revision: 1,
    supersession_state: "live",
  };
}

function taskFromDescriptor(descriptor, id, status) {
  return {
    id,
    name: descriptor.name,
    command: descriptor.command,
    status,
    outputPath: `/tmp/${id}.out`,
    isAgent: descriptor.isAgent,
    notifyOnCompletion: descriptor.notifyOnCompletion,
    triggerOnCompletion: descriptor.triggerOnCompletion,
  };
}

function fakeOperatorMessage() {
  return async () => {};
}
