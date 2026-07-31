import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCoreEffect } from "../src/effects.ts";
import { CoreFrameValidationError, validateCoreToHostFrame } from "../src/generated/frame-validation.ts";

test("routes generated Core effects through supported Pi Host APIs", async () => {
  const calls = [];
  const ctx = effectContext(calls, false);
  const services = effectServices(calls);

  const frames = [
    { v: 1, id: 2, kind: "ui", payload: { ui_kind: "text", content: { message: "hello" } } },
    { v: 1, id: 3, kind: "spawn", payload: { action: backgroundAction() } },
    { v: 1, id: 4, kind: "log", payload: { line: "diagnostic" } },
    { v: 1, id: 5, kind: "done", payload: { status: "ok" } },
  ];

  for (const frame of frames) {
    await applyCoreEffect(frame, ctx, services);
  }

  assert.deepEqual(calls, [
    ["operator", "info", "Autopilot: hello"],
    ["bg_run", backgroundAction().bg_run],
    ["operator", "info", "Autopilot log: diagnostic"],
    ["operator", "info", "Autopilot done: ok"],
  ]);
});

test("uses ctx.ui.notify with generated default levels only when Pi reports UI availability", async () => {
  const calls = [];
  await applyCoreEffect(
    { v: 1, id: 1, kind: "done", payload: { status: "rejection:example" } },
    effectContext(calls, true),
    effectServices(calls),
  );
  assert.deepEqual(calls, [
    ["notify", "info", "Autopilot done: rejection:example"],
    ["operator", "info", "Autopilot done: rejection:example"],
  ]);
});

test("unsupported fictional session/UI effects fail closed with operator-visible messages", async () => {
  const sessionCalls = [];
  await assert.rejects(
    applyCoreEffect(
      { v: 1, id: 1, kind: "session", payload: { session_action: "create", payload: { id: "child-1" } } },
      effectContext(sessionCalls, false),
      effectServices(sessionCalls),
    ),
    /unsupported Pi session effect/u,
  );
  assert.equal(sessionCalls[0][0], "operator");
  assert.equal(sessionCalls[0][1], "error");

  const uiCalls = [];
  await assert.rejects(
    applyCoreEffect(
      { v: 1, id: 2, kind: "ui", payload: { ui_kind: "textPane", content: { message: "bad" } } },
      effectContext(uiCalls, false),
      effectServices(uiCalls),
    ),
    /unsupported Pi UI effect/u,
  );
  assert.equal(uiCalls[0][0], "operator");
  assert.equal(uiCalls[0][1], "error");
});

test("malformed core-to-host frames are rejected before side effects", async () => {
  const calls = [];
  await assert.rejects(
    applyCoreEffect(
      { v: 1, id: 1, kind: "done", payload: { status: "ok", extra: true } },
      effectContext(calls, false),
      effectServices(calls),
    ),
    CoreFrameValidationError,
  );
  assert.deepEqual(calls, []);

  await assert.rejects(
    applyCoreEffect(
      { v: 1, id: 1, kind: "mystery", payload: {} },
      effectContext(calls, false),
      effectServices(calls),
    ),
    CoreFrameValidationError,
  );
  assert.deepEqual(calls, []);

  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "done", payload: { status: "ok" }, extra: true }),
    /core frame contains unknown key extra/u,
  );
  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "spawn-attested", payload: { action: {} } }),
    /generated seam posture unsupported/u,
  );
});

test("generated validator rejects malformed background actions and spawn-wave constraints", () => {
  const valid = backgroundAction();
  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "spawn", payload: { action: { ...valid, extra: true } } }),
    /background action contains unknown key extra/u,
  );
  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "spawn", payload: { action: { ...valid, bg_run: { ...valid.bg_run, timeoutSeconds: 0 } } } }),
    /bg_run\.timeoutSeconds must be a positive integer/u,
  );
  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "spawn-wave", payload: { actions: [] } }),
    /spawn-wave\.actions must be non-empty/u,
  );
  assert.throws(
    () => validateCoreToHostFrame({
      v: 1,
      id: 1,
      kind: "spawn-wave",
      payload: { actions: Array.from({ length: 65 }, (_, index) => ({ ...backgroundAction(), action_id: `a-${index}`, assignment_id: `u-${index}` })) },
    }),
    /spawn-wave\.actions exceeds maximum 64/u,
  );
  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "spawn-wave", payload: { actions: [{ ...valid }, { ...valid, assignment_id: "unit-2" }] } }),
    /spawn-wave action_id must be unique/u,
  );
  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "spawn-wave", payload: { actions: [{ ...valid }, { ...valid, action_id: "a2" }] } }),
    /spawn-wave assignment_id must be unique/u,
  );
});

function effectContext(calls, hasUI) {
  return {
    hasUI,
    mode: hasUI ? "tui" : "json",
    ui: {
      notify(message, level) {
        calls.push(["notify", level, message]);
      },
    },
  };
}

function effectServices(calls) {
  return {
    async operatorMessage(message, level) {
      calls.push(["operator", level, message]);
    },
    backgroundTasks: {
      async run(payload) {
        calls.push(["bg_run", payload]);
        return { id: "task-1", command: payload.command, status: "running", outputPath: "/tmp/out" };
      },
    },
  };
}

function backgroundAction() {
  return {
    action_id: "a1",
    assignment_id: "unit-1",
    kind: "launch-background",
    bg_run: {
      name: "exact launch",
      command: "printf 'exact'",
      isAgent: true,
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    },
    run_revision: 7,
    supersession_state: "active",
  };
}
