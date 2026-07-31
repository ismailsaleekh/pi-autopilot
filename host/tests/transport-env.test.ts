import { test } from "node:test";
import assert from "node:assert/strict";

import { HOST_ENV_DENY } from "../src/generated/host-runtime-tables.ts";
import { redactedEnv } from "../src/host-runtime.ts";

test("Core child env removes generated metered/API-key deny list and keeps Autopilot runner vars", () => {
  const base = Object.fromEntries(HOST_ENV_DENY.map((name) => [name, `secret-${name}`]));
  const env = redactedEnv(HOST_ENV_DENY, {
    AUTOPILOT_NODE_EXECUTABLE: "/node",
    AUTOPILOT_AGENT_RUNNER_WRAPPER: "/runner",
    AUTOPILOT_CHILD_ADDON_PATH: "/addon",
  }, { ...base, KEEP_ME: "yes" });

  for (const denied of HOST_ENV_DENY) assert.equal(env[denied], undefined, denied);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.AUTOPILOT_NODE_EXECUTABLE, "/node");
  assert.equal(env.AUTOPILOT_AGENT_RUNNER_WRAPPER, "/runner");
  assert.equal(env.AUTOPILOT_CHILD_ADDON_PATH, "/addon");
});
