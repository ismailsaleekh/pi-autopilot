import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import childExtension from "../../src/generated/child-extension.ts";
import { SUBMIT_TOOLS } from "../../src/generated/tool-schemas.ts";

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    details: Record<string, unknown>;
    terminate: boolean;
  }>;
}

test("selected terminal profile registers exactly one same-name schema", { concurrency: false }, async () => {
  const previousProfile = process.env.AUTOPILOT_TERMINAL_PROFILE;
  const previousBinding = process.env.AUTOPILOT_CARRIER_BINDING;
  try {
    const wrapperUrl = new URL("../../src/generated/child-extension.ts", import.meta.url);
    const wrapperDigest = createHash("sha256").update(readFileSync(wrapperUrl)).digest("hex");
    assert.equal(SUBMIT_TOOLS.length, 9);
    for (const expected of SUBMIT_TOOLS) {
      process.env.AUTOPILOT_TERMINAL_PROFILE = expected.profile_id;
      process.env.AUTOPILOT_CARRIER_BINDING = "binding-test";
      const tools: RegisteredTool[] = [];
      const hooks = new Map<string, () => Promise<void>>();
      const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
      const pi = {
        registerTool(tool: RegisteredTool) { tools.push(tool); },
        on(name: string, handler: () => Promise<void>) { hooks.set(name, handler); },
        appendEntry(type: string, data: Record<string, unknown>) { entries.push({ type, data }); },
        getActiveTools() { return ["read", ...tools.map((tool) => tool.name)]; },
      };
      childExtension(pi as never);
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.name, expected.name);
      await hooks.get("session_start")!();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.data.self_digest, wrapperDigest);
      assert.equal(entries[0]!.data.profile_id, expected.profile_id);
      assert.equal(entries[0]!.data.boundary_id, expected.boundary_id);
      assert.equal(entries[0]!.data.result_contract, expected.result_contract);
      const result = await tools[0]!.execute("opaque-call", {});
      assert.equal(result.terminate, true);
      assert.equal(result.details.profile_id, expected.profile_id);
      assert.equal(result.details.boundary_id, expected.boundary_id);
      assert.equal(result.details.result_contract, expected.result_contract);
      assert.equal(result.details.binding, "binding-test");
    }
  } finally {
    if (previousProfile === undefined) delete process.env.AUTOPILOT_TERMINAL_PROFILE;
    else process.env.AUTOPILOT_TERMINAL_PROFILE = previousProfile;
    if (previousBinding === undefined) delete process.env.AUTOPILOT_CARRIER_BINDING;
    else process.env.AUTOPILOT_CARRIER_BINDING = previousBinding;
  }
});

test("missing terminal profile fails before registration", { concurrency: false }, () => {
  const previous = process.env.AUTOPILOT_TERMINAL_PROFILE;
  try {
    delete process.env.AUTOPILOT_TERMINAL_PROFILE;
    assert.throws(
      () => childExtension({ registerTool() {}, on() {} } as never),
      /resolved 0 descriptors/,
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOPILOT_TERMINAL_PROFILE;
    else process.env.AUTOPILOT_TERMINAL_PROFILE = previous;
  }
});
