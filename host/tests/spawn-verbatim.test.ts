import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCoreEffect } from "../src/effects.ts";

test("spawn executes the core descriptor without rewriting a byte", async () => {
  const action = backgroundAction();
  const expected = JSON.stringify(action);
  let actual = "";

  await applyCoreEffect(
    { v: 1, id: 1, kind: "spawn", payload: { action } },
    { bg_run(descriptor) { actual = JSON.stringify(descriptor); } },
  );

  assert.equal(actual, expected);
});

test("spawn byte comparison detects a one-byte mutation", async () => {
  const action = backgroundAction();
  const expected = JSON.stringify(action);
  let actual = "";

  await applyCoreEffect(
    { v: 1, id: 1, kind: "spawn", payload: { action } },
    { bg_run(descriptor) { actual = JSON.stringify(descriptor); } },
  );

  const mutated = `${expected.slice(0, -2)}X${expected.slice(-1)}`;
  assert.notEqual(mutated, expected);
  assert.throws(() => assert.equal(actual, mutated));
});

function backgroundAction() {
  return {
    action_id: "a-byte-exact",
    assignment_id: "unit-byte-exact",
    kind: "launch-background",
    command_bytes: "node -e \"process.stdout.write('byte-exact')\"",
    display_name: "byte exact launch",
    isAgent: false,
    timeout: "30m",
    notifyOnCompletion: false,
    triggerOnCompletion: true,
    run_revision: 12,
    expires_at: null,
    supersession_state: "active",
  };
}
