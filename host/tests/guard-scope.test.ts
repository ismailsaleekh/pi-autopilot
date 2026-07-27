import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { guardToolCall, isAutopilotScope } from "../src/guard.ts";

class CountingTransport {
  calls = 0;
  async request(): Promise<never> {
    this.calls += 1;
    throw new Error("core must not be contacted");
  }
}

test("H5 core absent allows non-Autopilot Pi tools without contacting Core", async () => {
  for (const tool_name of ["read", "bash", "edit", "write"]) {
    const transport = new CountingTransport();
    const result = await guardToolCall(
      { tool_name, arguments: {} },
      { transport, timeoutMs: 25 },
    );
    assert.equal(result.decision, "allow", tool_name);
    assert.equal(transport.calls, 0, `${tool_name} contacted Core`);
  }
});

test("H6 core absent with active run denies bg_run inside Autopilot authority", async () => {
  const runStateRoot = mkdtempSync(join(tmpdir(), "autopilot-active-run-"));
  mkdirSync(join(runStateRoot, "repo", "run"), { recursive: true });
  try {
    const result = await guardToolCall(
      { tool_name: "bg_run", arguments: { name: "issued by autopilot" } },
      { binaryPath: join(tmpdir(), "autopilot-core-absent"), timeoutMs: 25, runStateRoot },
    );
    assert.equal(result.decision, "deny");
    assert.match(result.reason, /core-unavailable/);
  } finally {
    rmSync(runStateRoot, { recursive: true, force: true });
  }
});

test("active run directory uncertainty is scoped to bg_run and never blocks bash", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "autopilot-runs-"));
  try {
    const transport = new CountingTransport();
    const result = await guardToolCall(
      { tool_name: "bash", arguments: { command: "true" } },
      { transport, runStateRoot: stateRoot },
    );
    assert.equal(result.decision, "allow");
    assert.equal(transport.calls, 0);
    assert.equal(isAutopilotScope({ tool_name: "bash", arguments: {} }, { runStateRoot: stateRoot }), false);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
