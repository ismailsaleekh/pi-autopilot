import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCoreEffect, UnknownCoreEffectError } from "../src/effects.ts";

test("applies every generated core-to-host effect kind", async () => {
  const calls = [];
  const ctx = {
    guardDecision(payload) { calls.push(["guard-decision", payload]); },
    ui: {
      notify(payload) { calls.push(["ui.notify", payload]); },
    },
    bg_run(payload) { calls.push(["bg_run", payload]); },
    session: {
      create(payload) { calls.push(["session.create", payload]); },
    },
    log(line) { calls.push(["log", line]); },
    done(status) { calls.push(["done", status]); },
  };

  const frames = [
    { v: 1, id: 1, kind: "guard-decision", payload: { decision: "allow", reason: "ok" } },
    { v: 1, id: 2, kind: "ui", payload: { ui_kind: "notify", content: { message: "hello", kind: "info" } } },
    { v: 1, id: 3, kind: "spawn", payload: { action: backgroundAction() } },
    { v: 1, id: 4, kind: "session", payload: { session_action: "create", payload: { id: "child-1" } } },
    { v: 1, id: 5, kind: "log", payload: { line: "diagnostic" } },
    { v: 1, id: 6, kind: "done", payload: { status: "ok" } },
  ];

  for (const frame of frames) {
    await applyCoreEffect(frame, ctx);
  }

  assert.deepEqual(calls, [
    ["guard-decision", { decision: "allow", reason: "ok" }],
    ["ui.notify", { message: "hello", kind: "info" }],
    ["bg_run", backgroundAction()],
    ["session.create", { id: "child-1" }],
    ["log", "diagnostic"],
    ["done", "ok"],
  ]);
});

test("unknown core-to-host effect kind raises", async () => {
  await assert.rejects(
    applyCoreEffect({ v: 1, id: 1, kind: "mystery", payload: {} }, {}),
    UnknownCoreEffectError,
  );
});

function backgroundAction() {
  return {
    action_id: "a1",
    assignment_id: "unit-1",
    kind: "launch-background",
    command_bytes: "printf 'exact'",
    display_name: "exact launch",
    isAgent: true,
    timeout: null,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
    run_revision: 7,
    expires_at: null,
    supersession_state: "active",
  };
}
