import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { HOST_ENV_DENY } from "../src/generated/host-runtime-tables.ts";
import { redactedEnv } from "../src/host-runtime.ts";
import { CoreTransport, coreLaunchEnvironment } from "../src/transport.ts";

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

test("CoreTransport sanitizes then re-adds only exact broker facts and reuses them across Core restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-core-transport-"));
  const output = join(root, "env.jsonl");
  const child = join(root, "core-child.cjs");
  const launcher = join(root, "core-child");
  const capability = "a".repeat(64);
  const socketPath = "/tmp/.pi-ap/0123456789/s";
  const base = Object.fromEntries(HOST_ENV_DENY.map((name) => [name, `inherited-${name}`]));
  base.CORE_ENV_OUTPUT = output;
  base.KEEP_ME = "yes";
  writeFileSync(child, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.CORE_ENV_OUTPUT, JSON.stringify(process.env) + '\\n');",
    "process.stderr.write('broker=' + process.env.AUTOPILOT_CHILD_CONTROL_BROKER_CAPABILITY + '\\n');",
    "let input = '';",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk;",
    "  for (;;) { const newline = input.indexOf('\\n'); if (newline < 0) break; const frame = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1); process.stdout.write(JSON.stringify({ v: 1, id: frame.id, kind: 'done', payload: { status: 'ok' } }) + '\\n'); }",
    "});",
  ].join("\n"), "utf8");
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(child)}\n`, "utf8");
  chmodSync(launcher, 0o700);
  const transport = new CoreTransport({ binaryPath: launcher, baseEnv: base });
  try {
    await assert.rejects(transport.request("shutdown", {}), /before activation binds private child-control broker facts/u);
    transport.bindChildControlBroker({ socketPath, capability });
    await transport.request("shutdown", {});
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await transport.request("shutdown", {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    const launches = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(launches.length, 2);
    for (const env of launches) {
      for (const denied of HOST_ENV_DENY) {
        if (denied === "AUTOPILOT_CHILD_CONTROL_SOCKET_PATH" || denied === "AUTOPILOT_CHILD_CONTROL_BROKER_CAPABILITY") continue;
        assert.equal(env[denied], undefined, denied);
      }
      assert.equal(env.AUTOPILOT_CHILD_CONTROL_SOCKET_PATH, socketPath);
      assert.equal(env.AUTOPILOT_CHILD_CONTROL_BROKER_CAPABILITY, capability);
      assert.equal(env.KEEP_ME, "yes");
    }
    assert.doesNotMatch(transport.lastDiagnostics(), new RegExp(capability, "u"));
    assert.match(transport.lastDiagnostics(), /core-stderr/u);
  } finally {
    transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CoreTransport binds only the exact private broker fact", () => {
  const transport = new CoreTransport();
  assert.throws(
    () => transport.bindChildControlBroker({ socketPath: "/tmp/.pi-ap/ABCDEF0123/s", capability: "a".repeat(64) }),
    /exact private child-control broker launch facts/u,
  );
  assert.throws(
    () => transport.bindChildControlBroker({ socketPath: "/tmp/.pi-ap/abcdef0123/s", capability: "A".repeat(64) }),
    /exact private child-control broker launch facts/u,
  );
});

test("coreLaunchEnvironment re-adds broker values only after generated denial", () => {
  const capability = "b".repeat(64);
  const env = coreLaunchEnvironment(
    { nodeExecutable: "/node", runnerWrapper: "/runner", childAddon: "/addon" },
    { socketPath: "/tmp/.pi-ap/abcdef0123/s", capability },
    {
      AUTOPILOT_CHILD_CONTROL_SOCKET_PATH: "/tmp/foreign",
      AUTOPILOT_CHILD_CONTROL_BROKER_CAPABILITY: "foreign",
      OPENAI_API_KEY: "inherited",
    },
  );
  assert.deepEqual(env, {
    AUTOPILOT_NODE_EXECUTABLE: "/node",
    AUTOPILOT_AGENT_RUNNER_WRAPPER: "/runner",
    AUTOPILOT_CHILD_ADDON_PATH: "/addon",
    AUTOPILOT_CHILD_CONTROL_SOCKET_PATH: "/tmp/.pi-ap/abcdef0123/s",
    AUTOPILOT_CHILD_CONTROL_BROKER_CAPABILITY: capability,
  });
});
