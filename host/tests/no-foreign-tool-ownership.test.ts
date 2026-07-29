import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import autopilotExtension from "../src/extension.ts";
import { validateCoreToHostFrame } from "../src/frame-validation.ts";
import extensionEntrypoint from "../../extensions/autopilot.ts";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/**
 * Autopilot must never claim ownership of a Pi tool call it does not itself
 * register. Its launches travel Core -> Host -> the pi-background-tasks
 * EventBus service, and its child agents run with `--no-extensions`, so no
 * Autopilot-owned `bg_run` tool call can exist. These tests fail loudly if any
 * ownership-policy implementation, guard-query transport, or `tool_call`
 * interceptor is reintroduced anywhere in the shipped package.
 */

function sourceFiles(): string[] {
  const roots = ["src", "extensions", "bin"];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:ts|mjs)$/u.test(path)) out.push(path);
    }
  };
  for (const root of roots) walk(join(packageRoot, root));
  assert.ok(out.length > 0, "no shipped host sources discovered");
  return out;
}

test("no shipped host source registers a tool_call or tool_result interceptor", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    if (/\bon\(\s*["'`](?:tool_call|tool_result)["'`]/u.test(source)) {
      offenders.push(relative(packageRoot, path));
    }
  }
  assert.deepEqual(offenders, []);
});

test("no shipped host source implements a guard-query ownership policy", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    for (const marker of ["guard-query", "guard-decision", "isAutopilotScope", "hasHostLocalActiveRun"]) {
      if (source.includes(marker)) offenders.push(`${relative(packageRoot, path)}:${marker}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("no shipped host source infers ownership from run-state filesystem observation", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    if (source.includes("autopilot") && source.includes("v2") && /readdirSync|existsSync/u.test(source)) {
      if (/["'`]runs["'`]/u.test(source)) offenders.push(relative(packageRoot, path));
    }
  }
  assert.deepEqual(offenders, []);
});

test("extension registers exactly the session lifecycle hooks and no tool interceptor", () => {
  const events = new Map<string, unknown>();
  const pi = {
    events,
    on(name: string, handler: unknown) {
      assert.equal(events.has(name), false, `duplicate registration for ${name}`);
      events.set(name, handler);
    },
    registerCommand() {},
    registerTool() {},
    sendMessage() {},
    appendEntry() {},
  };

  autopilotExtension(pi as never, {
    transport: { async request() { throw new Error("Core must not be contacted during registration"); }, close() {} } as never,
    backgroundTasks: { onTerminal: () => () => {}, async close() {} } as never,
  });

  assert.deepEqual([...events.keys()].sort(), ["session_shutdown", "session_start"]);
});

test("packaged extension entrypoint registers only autopilot-prefixed tools", () => {
  const toolNames: string[] = [];
  const hookNames: string[] = [];
  const pi = {
    events: { on: () => () => {}, emit() {} },
    on(name: string) { hookNames.push(name); },
    registerCommand() {},
    registerTool(definition: { name: string }) { toolNames.push(definition.name); },
    sendMessage() {},
    appendEntry() {},
  };

  extensionEntrypoint(pi as never);

  assert.deepEqual(hookNames.filter((name) => name.startsWith("tool_")), []);

  assert.ok(toolNames.length > 0, "entrypoint registered no tools");
  assert.deepEqual(toolNames.filter((name) => !name.startsWith("autopilot_")), []);
});

test("guard-decision is no longer an admissible Core-to-Host frame", () => {
  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "guard-decision", payload: { decision: "allow", reason: "ok" } }),
    /unsupported core frame kind: guard-decision/u,
  );
});
