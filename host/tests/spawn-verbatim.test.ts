import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCoreEffect } from "../src/effects.ts";

test("spawn executes the exact Core bg_run descriptor object without rewriting", async () => {
  const action = backgroundAction();
  let actual;

  await applyCoreEffect(
    { v: 1, id: 1, kind: "spawn", payload: { action } },
    effectContext(),
    { backgroundTasks: { async run(descriptor) { actual = descriptor; return { id: "task-1", command: descriptor.command, status: "running", outputPath: "/tmp/out" }; } }, operatorMessage: async () => {} },
  );

  assert.equal(actual, action.bg_run);
  assert.deepEqual(actual, action.bg_run);
});

test("spawn validator rejects null timeout before event-bus mutation", async () => {
  const action = backgroundAction();
  action.bg_run.timeoutSeconds = null;
  let called = false;

  await assert.rejects(
    applyCoreEffect(
      { v: 1, id: 1, kind: "spawn", payload: { action } },
      effectContext(),
      { backgroundTasks: { async run() { called = true; throw new Error("must not run"); } }, operatorMessage: async () => {} },
    ),
    /bg_run.timeoutSeconds must be a positive integer/u,
  );

  assert.equal(called, false);
});

function effectContext() {
  return {
    hasUI: false,
    mode: "json",
    ui: { notify() { throw new Error("notify should not be used in this test"); } },
  };
}

function backgroundAction() {
  return {
    action_id: "a-byte-exact",
    assignment_id: "unit-byte-exact",
    kind: "launch-background",
    bg_run: {
      name: "byte exact launch",
      command: "node -e \"process.stdout.write('byte-exact')\"",
      isAgent: false,
      timeoutSeconds: 1800,
      notifyOnCompletion: false,
      triggerOnCompletion: true,
    },
    run_revision: 12,
    supersession_state: "active",
  };
}
