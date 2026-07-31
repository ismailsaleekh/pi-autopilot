import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import autopilotExtension from "../src/extension.ts";
import { validateCoreToHostFrame } from "../src/generated/frame-validation.ts";
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

/**
 * BUG-184 REPLACEMENT. This test previously asserted `toolNames.length > 0`
 * immediately after loading the packaged entrypoint, which PINNED the defect:
 * it required the 7 planning tools to be registered eagerly, in every session,
 * including sessions that never use Autopilot. The surviving obligation is that
 * whenever tools DO exist they are all `autopilot_`-prefixed and no tool hook
 * is registered; the zero-at-load and exact-7-after-activation claims live in
 * host/tests/activation-scoping.test.ts.
 */
test("BUG-184: packaged entrypoint registers no tool at load and only autopilot-prefixed tools ever", async () => {
  const toolNames: string[] = [];
  const hookNames: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const stateRoot = mkdtempSync(join(tmpdir(), "autopilot-ownership-state-"));
  const pi = {
    events: { on: () => () => {}, emit() {} },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) { hookNames.push(name); hooks.set(name, handler); },
    registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, definition); },
    registerTool(definition: { name: string }) { toolNames.push(definition.name); },
    sendMessage() {},
    appendEntry() {},
  };

  try {
    extensionEntrypoint(pi as never, {
      transport: { async request() { return { v: 1, id: 1, kind: "done", payload: { status: "ok" } }; }, close() {} },
      backgroundTasks: {
        async capabilities() { return { api_version: 1, run: true, run_is_agent: true, run_completion_trigger: true, status: true, logs: true, logs_bounded: true, kill: true }; },
        async run() { return { id: "t1", command: "c", status: "running", outputPath: "/tmp/o" }; },
        onTerminal() { return () => {}; },
        async close() {},
      },
      stateRoot,
      processIdentity: "pid:test:started:1",
    } as never);

    assert.deepEqual(hookNames.filter((name) => name.startsWith("tool_")), []);
    assert.deepEqual(toolNames, [], "entrypoint must register no tool at load time");

    const ctx = { hasUI: false, mode: "json", ui: { notify() {} }, sessionManager: { getSessionId: () => "019faf00-0000-7000-8000-0000000000cc" } };
    await hooks.get("session_start")?.({ reason: "startup" }, ctx);
    await commands.get("autopilot-plan")?.handler("main A.md B.md C.md CTX.md", ctx);

    assert.equal(toolNames.length, 7);
    assert.deepEqual(toolNames.filter((name) => !name.startsWith("autopilot_")), []);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

/**
 * BUG-184 T8 static corpus audit. Autopilot's activation state must be reached
 * only by an exact single-key path built from a Pi-supplied session id. Any
 * directory enumeration or home-directory sweep over its own state root would
 * reintroduce BUG-183's "observe the filesystem, conclude authority" shape.
 */
test("BUG-184: no shipped host source enumerates or sweeps an Autopilot state root", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    const rel = relative(packageRoot, path);
    for (const marker of ["readdirSync", "readdir(", "globSync", "opendirSync"]) {
      if (source.includes(marker)) offenders.push(`${rel}:${marker}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("BUG-184: exactly one activation implementation exists and it is not reachable at module load", () => {
  const implementations: string[] = [];
  const eagerRegistrations: string[] = [];
  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    const rel = relative(packageRoot, path);
    if (/\bclass\s+AutopilotActivation\b/u.test(source)) implementations.push(rel);
    // `registerTool` may appear only inside a function body, never at the top
    // level of a module, where it would run on import.
    for (const line of source.split("\n")) {
      if (/^(?:pi|api)\.registerTool\(/u.test(line)) eagerRegistrations.push(`${rel}:${line.trim()}`);
    }
  }
  assert.deepEqual(implementations, ["src/activation.ts"]);
  assert.deepEqual(eagerRegistrations, []);
});

test("BUG-184: every activation-state read is a single-key path from a Pi session id", () => {
  const source = readFileSync(join(packageRoot, "src", "activation.ts"), "utf8");
  // The one and only address builder.
  const builders = source.match(/export function activationRecordPath\(/gu) ?? [];
  assert.equal(builders.length, 1);
  // It must validate the session id as a bare path segment before joining.
  assert.match(source, /assertUsableSessionId\(sessionId\);/u);
  // And it must never reach for run history.
  assert.equal(source.includes('"runs"'), false);
  assert.equal(source.includes("process.env"), false);
});

test("guard-decision is no longer an admissible Core-to-Host frame", () => {
  assert.throws(
    () => validateCoreToHostFrame({ v: 1, id: 1, kind: "guard-decision", payload: { decision: "allow", reason: "ok" } }),
    /unsupported core frame kind: guard-decision/u,
  );
});
