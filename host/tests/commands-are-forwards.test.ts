import { test } from "node:test";
import assert from "node:assert/strict";

import autopilotExtension from "../src/extension.ts";
import { AUTOPILOT_COMMANDS, registerAutopilotCommands } from "../src/commands.ts";

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

const PROMPTED_EXTRA_COMMANDS = Object.freeze(["autopilot-resume", "autopilot-help"]);

test("registers the retained D76 public commands", () => {
  const pi = fakePi();
  registerAutopilotCommands(pi, { transport: fakeTransport() });

  assert.deepEqual([...AUTOPILOT_COMMANDS], D76_PUBLIC_COMMANDS);
  assert.deepEqual([...pi.registrations.keys()], D76_PUBLIC_COMMANDS);
  for (const name of PROMPTED_EXTRA_COMMANDS) {
    assert.equal(pi.registrations.has(name), false, `${name} is not in D76 §21 public surface`);
  }
});

test("each command forwards one command frame with the raw argument bytes", async () => {
  for (const command of AUTOPILOT_COMMANDS) {
    const pi = fakePi();
    const transport = fakeTransport();
    registerAutopilotCommands(pi, { transport });

    const raw = "  keep  spacing --and-bytes=✓  ";
    await pi.registrations.get(command).handler(raw, fakeCtx());

    assert.deepEqual(transport.calls, [{ kind: "command", payload: { raw } }], command);
  }
});

test("registered command handlers contain no local control branch", () => {
  const pi = fakePi();
  registerAutopilotCommands(pi, { transport: fakeTransport() });

  for (const [name, definition] of pi.registrations) {
    const body = definition.handler.toString();
    assert.doesNotMatch(body, /\b(if|switch|case)\b/u, name);
    assert.doesNotMatch(body, /runPhase|laneState|candidateState|parallelCap|FORWARD_READY|NEEDS_FIX/u, name);
  }
});

test("extension registers tool_call guard as a core frame forward", async () => {
  const pi = fakePi();
  const transport = fakeTransport({ guard: "deny" });
  autopilotExtension(pi, { transport });

  const input = { command: "do-not-rewrite" };
  const result = await pi.events.get("tool_call")({ toolName: "bg_run", input }, fakeCtx());

  assert.deepEqual(transport.calls.at(-1), {
    kind: "guard-query",
    payload: { tool_name: "bg_run", arguments: input },
    timeoutMs: 5000,
  });
  assert.deepEqual(result, { block: true, reason: "guarded" });
});

test("extension shutdown sends core shutdown and closes transport", async () => {
  const pi = fakePi();
  const transport = fakeTransport();
  autopilotExtension(pi, { transport });

  await pi.events.get("session_shutdown")({ reason: "quit" }, fakeCtx());

  assert.deepEqual(transport.calls.at(-1), {
    kind: "shutdown",
    payload: { reason: "quit" },
    timeoutMs: 2000,
  });
  assert.equal(transport.closed, true);
});

function fakePi() {
  const registrations = new Map();
  const events = new Map();
  return {
    events,
    registrations,
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, definition) {
      registrations.set(name, definition);
    },
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
      if (kind === "guard-query") {
        return { v: 1, id: calls.length, kind: "guard-decision", payload: { decision: options.guard ?? "allow", reason: "guarded" } };
      }
      return { v: 1, id: calls.length, kind: "done", payload: { status: "ok" } };
    },
    close() {
      this.closed = true;
    },
  };
}

function fakeCtx() {
  return { done() {} };
}
