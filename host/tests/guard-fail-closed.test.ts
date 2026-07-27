import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { guardToolCall } from "../src/guard.ts";
import { CoreTransport } from "../src/transport.ts";

test("guard denies when core times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-guard-timeout-"));
  const script = join(dir, "silent-core.js");
  writeFileSync(script, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n");
  chmodSync(script, 0o755);
  const transport = new CoreTransport({ binaryPath: script });
  try {
    const result = await guardToolCall(
      { tool_name: "autopilot_emit_status", arguments: { name: "unissued" } },
      { transport, timeoutMs: 25 },
    );
    assert.equal(result.decision, "deny");
    assert.match(result.reason, /core-timeout/);
  } finally {
    transport.close();
  }
});

test("guard denies when core is absent inside Autopilot scope", async () => {
  const transport = new CoreTransport({ binaryPath: join(tmpdir(), "autopilot-core-absent") });
  const result = await guardToolCall(
    { tool_name: "autopilot_materialize_context", arguments: { path: "../outside" } },
    { transport, timeoutMs: 25 },
  );
  assert.equal(result.decision, "deny");
  assert.match(result.reason, /core-unavailable/);
});
