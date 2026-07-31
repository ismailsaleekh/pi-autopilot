import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import autopilotExtension from "../src/extension.ts";
import extensionEntrypoint from "../../extensions/autopilot.ts";
import {
  ACTIVATING_COMMANDS,
  ACTIVATION_RECORD_SCHEMA,
  AutopilotInertError,
  activationRecordPath,
} from "../src/activation.ts";

/**
 * BUG-184 — pi-autopilot ran its full runtime at load time in every Pi session.
 *
 * `pi-autopilot` is installed globally, so its extension factory executed in
 * EVERY session in EVERY directory. That registered 7 LLM tools carrying
 * promptSnippet/promptGuidelines into the system prompt of unrelated sessions,
 * subscribed to the shared background EventBus, and unconditionally sent a
 * `shutdown` frame at exit — spawning the Rust Core child and rendering
 * "[pi-autopilot] Autopilot done: ok:shutdown" in sessions that never used
 * Autopilot.
 *
 * These tests pin the activation seam: Autopilot keeps ONLY its 10 slash
 * commands at load, and everything else happens inside an operator-initiated
 * activating command.
 */

const EXACT_COMMANDS = Object.freeze([
  "autopilot",
  "autopilot-abort",
  "autopilot-answer",
  "autopilot-close",
  "autopilot-config",
  "autopilot-handoff",
  "autopilot-inject",
  "autopilot-onboard",
  "autopilot-plan",
  "autopilot-status",
]);

const EXACT_TOOLS = Object.freeze([
  "autopilot_submit_atoms",
  "autopilot_submit_context",
  "autopilot_submit_plan_cluster",
  "autopilot_submit_resolution",
  "autopilot_submit_review",
  "autopilot_submit_scout_report",
  "autopilot_submit_synthesis",
]);

const SESSION_A = "019faf00-0000-7000-8000-00000000000a";
const SESSION_B = "019faf00-0000-7000-8000-00000000000b";
const PROCESS_IDENTITY = "pid:test:started:1";

// ---------------------------------------------------------------- T1

test("BUG-184 T1: a session that never invokes a command leaves zero Autopilot footprint", async () => {
  const state = tempStateRoot();
  // A deliberately missing binary: if any load-time path still resolves Core,
  // it would emit an operator message and fail the messages assertion below.
  const missingBinaryPackage = packageWithoutBinary();
  const pi = recordingPi();

  try {
    extensionEntrypoint.length; // entrypoint is the REAL packaged surface
    autopilotExtension(pi as never, {
      packageJsonPath: join(missingBinaryPackage, "package.json"),
      platform: "darwin",
      arch: "arm64",
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    });

    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));
    await pi.emit("session_shutdown", { reason: "quit" }, ctxFor(SESSION_A));

    // Each reintroduced load-time effect fails a DISTINCT assertion.
    assert.deepEqual(pi.toolNames, [], "no tool may be registered before activation");
    assert.deepEqual([...pi.hooks.keys()].sort(), ["session_shutdown", "session_start"]);
    assert.deepEqual([...pi.commands.keys()].sort(), EXACT_COMMANDS);
    assert.deepEqual(pi.eventSubscriptions, [], "no EventBus channel may be subscribed before activation");
    assert.deepEqual(pi.messages, [], "an unused session must produce no operator message");
    assert.equal(existsSync(join(state.root, "sessions")), false, "no activation record may be written");
  } finally {
    state.cleanup();
    rmSync(missingBinaryPackage, { recursive: true, force: true });
  }
});

test("BUG-184 T1b: the packaged entrypoint registers its 7 tools only after activation", async () => {
  const state = tempStateRoot();
  const pi = recordingPi();
  const transport = fakeTransport();
  try {
    extensionEntrypoint(pi as never, {
      transport,
      backgroundTasks: fakeBackgroundTasks(),
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    } as never);

    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));
    assert.deepEqual(pi.toolNames, [], "packaged entrypoint must not register tools at load");

    await pi.commands.get("autopilot-plan").handler("main A.md B.md C.md CTX.md", commandCtx(SESSION_A));
    assert.deepEqual([...pi.toolNames].sort(), EXACT_TOOLS);
  } finally {
    state.cleanup();
  }
});

// ---------------------------------------------------------------- T3 / T4 / T10

test("BUG-184 T3+T4: activation subscribes exactly once, before the first Core request, and records exact state", async () => {
  const state = tempStateRoot();
  const pi = recordingPi();
  // One shared log across both services makes the ordering claim real rather
  // than an artifact of comparing two independent counters.
  const callLog = [];
  const transport = fakeTransport(callLog);
  const background = fakeBackgroundTasks(callLog);
  try {
    autopilotExtension(pi as never, {
      transport,
      backgroundTasks: background,
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    });
    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));
    await pi.commands.get("autopilot-plan").handler("main A.md B.md C.md CTX.md", commandCtx(SESSION_A));

    assert.equal(background.terminalSubscriptions, 1, "exactly one terminal subscription");
    assert.equal(transport.calls.length, 1, "activation must contact Core exactly once");

    // T4 ordering: subscription strictly precedes the first Core frame.
    const subscribeIndex = callLog.indexOf("bg:onTerminal");
    const firstRequestIndex = callLog.findIndex((entry) => entry.startsWith("core:"));
    assert.notEqual(subscribeIndex, -1, `no subscription in ${JSON.stringify(callLog)}`);
    assert.notEqual(firstRequestIndex, -1, `no core request in ${JSON.stringify(callLog)}`);
    assert.ok(subscribeIndex < firstRequestIndex, `subscribe(${subscribeIndex}) must precede first core request(${firstRequestIndex}) in ${JSON.stringify(callLog)}`);

    const record = JSON.parse(readFileSync(activationRecordPath(SESSION_A, { stateRoot: state.root }), "utf8"));
    assert.deepEqual(Object.keys(record).sort(), [
      "activated_at_unix_ms",
      "granted_by_command",
      "process_identity",
      "schema_version",
      "session_id",
    ]);
    assert.equal(record.schema_version, ACTIVATION_RECORD_SCHEMA);
    assert.equal(record.session_id, SESSION_A);
    assert.equal(record.process_identity, PROCESS_IDENTITY);
    assert.equal(record.granted_by_command, "autopilot-plan");
  } finally {
    state.cleanup();
  }
});

test("BUG-184 T10: concurrent and repeated activation yields one subscription and one Core child", async () => {
  const state = tempStateRoot();
  const pi = recordingPi();
  const background = fakeBackgroundTasks();
  try {
    autopilotExtension(pi as never, {
      transport: fakeTransport(),
      backgroundTasks: background,
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    });
    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));

    // Concurrent activating commands must await the SAME memoized promise.
    await Promise.all([
      pi.commands.get("autopilot-plan").handler("main A.md B.md C.md CTX.md", commandCtx(SESSION_A)),
      pi.commands.get("autopilot").handler("main", commandCtx(SESSION_A)),
    ]);
    await pi.commands.get("autopilot-inject").handler("main", commandCtx(SESSION_A));

    assert.equal(background.terminalSubscriptions, 1);
    assert.equal(background.closeCalls, 0);

    await pi.emit("session_shutdown", { reason: "quit" }, ctxFor(SESSION_A));
    await pi.emit("session_shutdown", { reason: "quit" }, ctxFor(SESSION_A));
  } finally {
    state.cleanup();
  }
});

// ---------------------------------------------------------------- T5 reload survival

test("BUG-184 T5: activation survives /reload and never reads a run-state root", async () => {
  const state = tempStateRoot();
  // Sentinel run history: BUG-183's probe read exactly this shape. It must
  // never be consulted again.
  const runsRoot = join(state.root, "runs");
  mkdirSync(join(runsRoot, "sentinel-run-directory"), { recursive: true });

  const background = fakeBackgroundTasks();
  const first = recordingPi();
  try {
    extensionEntrypoint(first as never, {
      transport: fakeTransport(),
      backgroundTasks: background,
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    } as never);
    await first.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));
    await first.commands.get("autopilot-plan").handler("main A.md B.md C.md CTX.md", commandCtx(SESSION_A));
    assert.deepEqual([...first.toolNames].sort(), EXACT_TOOLS);

    await first.emit("session_shutdown", { reason: "reload" }, ctxFor(SESSION_A));
    // reload must PRESERVE the record
    assert.equal(existsSync(activationRecordPath(SESSION_A, { stateRoot: state.root })), true);

    // A genuinely fresh extension instance, as produced by jiti re-evaluation.
    const second = recordingPi();
    extensionEntrypoint(second as never, {
      transport: fakeTransport(),
      backgroundTasks: fakeBackgroundTasks(),
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    } as never);
    assert.deepEqual(second.toolNames, [], "tools must not exist before session_start restates the grant");

    await second.emit("session_start", { reason: "reload" }, ctxFor(SESSION_A));
    assert.deepEqual([...second.toolNames].sort(), EXACT_TOOLS, "reload must re-arm the exact 7 tools");

    assert.deepEqual(readdirSync(join(runsRoot)), ["sentinel-run-directory"], "run history must be untouched");
  } finally {
    state.cleanup();
  }
});

// ---------------------------------------------------------------- T6 fork/new isolation

for (const reason of ["fork", "new", "resume"]) {
  test(`BUG-184 T6: a ${reason} session never inherits activation from the same record`, async () => {
    const state = tempStateRoot();
    const pi = recordingPi();
    const transport = fakeTransport();
    try {
      autopilotExtension(pi as never, {
        transport,
        backgroundTasks: fakeBackgroundTasks(),
        stateRoot: state.root,
        processIdentity: PROCESS_IDENTITY,
      });
      writeRecord(state.root, SESSION_A, PROCESS_IDENTITY);

      await pi.emit("session_start", { reason, previousSessionFile: "/tmp/prior.jsonl" }, ctxFor(SESSION_A));

      assert.deepEqual(transport.calls, [], "replacement session must not contact Core");
      assert.deepEqual(pi.toolNames, [], "replacement session must not gain tools");
      assert.deepEqual(pi.messages.map((entry) => entry.level), ["info"]);
      assert.match(pi.messages[0].content, /did not inherit activation/u);
      assert.equal(
        existsSync(activationRecordPath(SESSION_A, { stateRoot: state.root })),
        false,
        "the inherited record must be pruned",
      );
    } finally {
      state.cleanup();
    }
  });
}

test("BUG-184 T6b: a record written by a different process never grants activation", async () => {
  const state = tempStateRoot();
  const pi = recordingPi();
  const transport = fakeTransport();
  try {
    autopilotExtension(pi as never, {
      transport,
      backgroundTasks: fakeBackgroundTasks(),
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    });
    // Same session id (as /resume after a crash reuses it), foreign process.
    writeRecord(state.root, SESSION_A, "pid:9999:started:1");

    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));

    assert.deepEqual(transport.calls, []);
    assert.deepEqual(pi.toolNames, []);
    assert.deepEqual(pi.messages, []);
  } finally {
    state.cleanup();
  }
});

// ---------------------------------------------------------------- T7 cross-session isolation

test("BUG-184 T7: activating one session leaves a concurrent session inert", async () => {
  const state = tempStateRoot();
  const armed = recordingPi();
  const bystander = recordingPi();
  const bystanderTransport = fakeTransport();
  const bystanderBackground = fakeBackgroundTasks();
  try {
    extensionEntrypoint(armed as never, {
      transport: fakeTransport(),
      backgroundTasks: fakeBackgroundTasks(),
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    } as never);
    extensionEntrypoint(bystander as never, {
      transport: bystanderTransport,
      backgroundTasks: bystanderBackground,
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    } as never);

    await armed.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));
    await bystander.emit("session_start", { reason: "startup" }, ctxFor(SESSION_B));
    await armed.commands.get("autopilot-plan").handler("main A.md B.md C.md CTX.md", commandCtx(SESSION_A));

    assert.deepEqual([...armed.toolNames].sort(), EXACT_TOOLS);
    assert.deepEqual(bystander.toolNames, []);
    assert.deepEqual(bystanderTransport.calls, []);
    assert.equal(bystanderBackground.terminalSubscriptions, 0);

    // The bystander's own shutdown must stay silent and send no frame.
    await bystander.emit("session_shutdown", { reason: "quit" }, ctxFor(SESSION_B));
    assert.deepEqual(bystanderTransport.calls, []);
    assert.deepEqual(bystander.messages, []);
  } finally {
    state.cleanup();
  }
});

// ---------------------------------------------------------------- T9 loud-failure matrix

test("BUG-184 T9: operating commands refuse loudly in an unarmed session and never activate", async () => {
  const state = tempStateRoot();
  const transport = fakeTransport();
  const background = fakeBackgroundTasks();
  try {
    const pi = recordingPi();
    autopilotExtension(pi as never, {
      transport,
      backgroundTasks: background,
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    });
    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));

    for (const command of ["autopilot-status", "autopilot-config", "autopilot-close", "autopilot-abort", "autopilot-handoff", "autopilot-answer"]) {
      await assert.rejects(
        () => pi.commands.get(command).handler("", commandCtx(SESSION_A)),
        (error) => {
          assert.ok(error instanceof AutopilotInertError, `${command} must raise AutopilotInertError`);
          for (const activating of ACTIVATING_COMMANDS) {
            assert.ok(error.message.includes(`/${activating}`), `${command} error must name /${activating}`);
          }
          return true;
        },
        command,
      );
    }

    assert.deepEqual(transport.calls, [], "a refused operating command must not reach Core");
    assert.equal(background.terminalSubscriptions, 0, "a refused operating command must not subscribe");
  } finally {
    state.cleanup();
  }
});

test("BUG-184 T9b: a missing Core binary is a blocking failure at activation, not a load-time notice", async () => {
  const state = tempStateRoot();
  const root = packageWithoutBinary();
  const pi = recordingPi();
  try {
    autopilotExtension(pi as never, {
      packageJsonPath: join(root, "package.json"),
      platform: "darwin",
      arch: "arm64",
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    });
    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));
    assert.deepEqual(pi.messages, [], "load and start must stay silent");

    await assert.rejects(
      () => pi.commands.get("autopilot-plan").handler("main A.md B.md C.md CTX.md", commandCtx(SESSION_A)),
      /autopilot-core is not installed/u,
    );
    assert.equal(
      existsSync(activationRecordPath(SESSION_A, { stateRoot: state.root })),
      false,
      "a failed activation must write no record",
    );
  } finally {
    state.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("BUG-184 T9c: a corrupt or foreign-keyed activation record fails loudly instead of assuming inert", async () => {
  for (const [label, body] of [
    ["malformed", "{not json"],
    ["unknown-schema", JSON.stringify({ schema_version: "autopilot.host_activation.v0", session_id: SESSION_A, process_identity: PROCESS_IDENTITY, granted_by_command: "autopilot-plan", activated_at_unix_ms: 1 })],
    ["session-mismatch", JSON.stringify({ schema_version: ACTIVATION_RECORD_SCHEMA, session_id: SESSION_B, process_identity: PROCESS_IDENTITY, granted_by_command: "autopilot-plan", activated_at_unix_ms: 1 })],
    ["non-activating-command", JSON.stringify({ schema_version: ACTIVATION_RECORD_SCHEMA, session_id: SESSION_A, process_identity: PROCESS_IDENTITY, granted_by_command: "autopilot-status", activated_at_unix_ms: 1 })],
  ]) {
    const state = tempStateRoot();
    const pi = recordingPi();
    try {
      autopilotExtension(pi as never, {
        transport: fakeTransport(),
        backgroundTasks: fakeBackgroundTasks(),
        stateRoot: state.root,
        processIdentity: PROCESS_IDENTITY,
      });
      const path = activationRecordPath(SESSION_A, { stateRoot: state.root });
      mkdirSync(join(state.root, "sessions"), { recursive: true });
      writeFileSync(path, body, "utf8");

      await assert.rejects(
        () => pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A)),
        /activation record/u,
        label,
      );
      assert.equal(existsSync(path), true, `${label}: the record must be preserved for forensics`);
    } finally {
      state.cleanup();
    }
  }
});

// ---------------------------------------------------------------- T11 companion defect

test("BUG-184 T11: foreign terminal events are out of jurisdiction while launched-and-lost still warns", async () => {
  const state = tempStateRoot();
  const pi = recordingPi();
  const background = fakeBackgroundTasks();
  const action = terminalAction("action-1", "assignment-1", "autopilot task", "node autopilot-run");
  const transport = {
    calls: [],
    closed: false,
    async request(kind, payload, timeoutMs) {
      this.calls.push(timeoutMs === undefined ? { kind, payload } : { kind, payload, timeoutMs });
      if (kind === "command") return { v: 1, id: this.calls.length, kind: "spawn", payload: { action } };
      return { v: 1, id: this.calls.length, kind: "done", payload: { status: "ok" } };
    },
    close() { this.closed = true; },
  };
  try {
    autopilotExtension(pi as never, {
      transport: transport as never,
      backgroundTasks: background,
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    });
    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));
    await pi.commands.get("autopilot-plan").handler("main A.md B.md C.md CTX.md", commandCtx(SESSION_A));

    // A foreign task the operator launched with bg_run.
    await background.emitTerminal({
      id: "foreign-task-1",
      name: "Simple Background Check",
      command: "node -e \"console.log('unrelated')\"",
      status: "completed",
      outputPath: "/tmp/foreign.out",
    });

    await pi.emit("session_shutdown", { reason: "quit" }, ctxFor(SESSION_A));

    const warnings = pi.messages.filter((entry) => entry.level === "warning");
    assert.deepEqual(warnings, [], "a foreign bg_run must produce no Autopilot warning");
    const jurisdiction = pi.messages.filter((entry) => entry.content.includes("outside its jurisdiction"));
    assert.equal(jurisdiction.length, 1);
    assert.match(jurisdiction[0].content, /foreign-task-1/u);
    assert.equal(jurisdiction[0].level, "info");
  } finally {
    state.cleanup();
  }
});

test("BUG-184 T11b: a task Autopilot launched and lost still produces an operator warning", async () => {
  const state = tempStateRoot();
  const pi = recordingPi();
  const background = fakeBackgroundTasks();
  const action = terminalAction("action-1", "assignment-1", "autopilot task", "node autopilot-run");
  let capturedTask;
  const transport = {
    calls: [],
    async request(kind, payload, timeoutMs) {
      this.calls.push(timeoutMs === undefined ? { kind, payload } : { kind, payload, timeoutMs });
      if (kind === "command") return { v: 1, id: this.calls.length, kind: "spawn", payload: { action } };
      // Force the binding to be dropped so the task becomes launched-and-lost.
      return { v: 1, id: this.calls.length, kind: "done", payload: { status: "ok" } };
    },
    close() {},
  };
  try {
    autopilotExtension(pi as never, {
      transport: transport as never,
      backgroundTasks: background,
      stateRoot: state.root,
      processIdentity: PROCESS_IDENTITY,
    });
    await pi.emit("session_start", { reason: "startup" }, ctxFor(SESSION_A));
    await pi.commands.get("autopilot-plan").handler("main A.md B.md C.md CTX.md", commandCtx(SESSION_A));
    capturedTask = background.lastRunTask;

    // Terminal arrives twice: the first consumes the binding, the second is a
    // genuine Autopilot-launched task with no binding left — launched-and-lost.
    // `failed` (not `completed`) keeps this on the correlation path without
    // pulling in agent-run spec/carrier file reads, which this test does not model.
    await background.emitTerminal({ ...capturedTask, status: "failed" });
    await background.emitTerminal({ ...capturedTask, status: "failed" });

    await pi.emit("session_shutdown", { reason: "quit" }, ctxFor(SESSION_A));

    const warnings = pi.messages.filter((entry) => entry.level === "warning");
    assert.equal(warnings.length, 1, JSON.stringify(pi.messages));
    assert.match(warnings[0].content, /no exact Autopilot action binding was ever recorded/u);
    assert.match(warnings[0].content, new RegExp(capturedTask.id, "u"));
  } finally {
    state.cleanup();
  }
});

// ---------------------------------------------------------------- helpers

function tempStateRoot() {
  const root = mkdtempSync(join(tmpdir(), "autopilot-activation-state-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function packageWithoutBinary() {
  const root = mkdtempSync(join(tmpdir(), "autopilot-activation-nobin-"));
  mkdirSync(join(root, "binaries", "darwin-arm64"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", bin: { "autopilot-core": "bin/autopilot-core.mjs" } }), "utf8");
  return root;
}

function writeRecord(stateRoot, sessionId, processIdentity) {
  mkdirSync(join(stateRoot, "sessions"), { recursive: true });
  writeFileSync(activationRecordPath(sessionId, { stateRoot }), JSON.stringify({
    schema_version: ACTIVATION_RECORD_SCHEMA,
    session_id: sessionId,
    process_identity: processIdentity,
    granted_by_command: "autopilot-plan",
    activated_at_unix_ms: 1,
  }), "utf8");
}

function recordingPi() {
  const hooks = new Map();
  const commands = new Map();
  const toolNames = [];
  const messages = [];
  const eventSubscriptions = [];
  return {
    hooks,
    commands,
    toolNames,
    messages,
    eventSubscriptions,
    events: {
      on(channel) {
        eventSubscriptions.push(channel);
        return () => {};
      },
      emit() {},
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool(definition) {
      toolNames.push(definition.name);
    },
    sendMessage(message) {
      messages.push({ content: String(message.content), level: message.details?.level ?? "info" });
    },
    appendEntry() {},
    async emit(name, event, ctx) {
      const handler = hooks.get(name);
      if (handler === undefined) throw new Error(`no handler registered for ${name}`);
      await handler(event, ctx);
    },
  };
}

function ctxFor(sessionId) {
  return {
    hasUI: false,
    mode: "json",
    ui: { notify() { throw new Error("non-UI context"); } },
    sessionManager: { getSessionId: () => sessionId },
  };
}

function commandCtx(sessionId) {
  return ctxFor(sessionId);
}

function fakeTransport(callLog = []) {
  const calls = [];
  return {
    calls,
    callLog,
    closed: false,
    async request(kind, payload, timeoutMs) {
      callLog.push(`core:${kind}`);
      calls.push(timeoutMs === undefined ? { kind, payload } : { kind, payload, timeoutMs });
      return { v: 1, id: calls.length, kind: "done", payload: { status: "ok" } };
    },
    close() { this.closed = true; },
  };
}

function fakeBackgroundTasks(callLog = []) {
  const handlers = new Set();
  return {
    terminalSubscriptions: 0,
    closeCalls: 0,
    callLog,
    lastRunTask: undefined,
    async capabilities() {
      this.callLog.push("bg:capabilities");
      return {
        api_version: 1,
        run: true,
        run_is_agent: true,
        run_completion_trigger: true,
        status: true,
        logs: true,
        logs_bounded: true,
        kill: true,
      };
    },
    async run(descriptor) {
      this.callLog.push("bg:run");
      const task = {
        id: `task-${String(this.callLog.length)}`,
        name: descriptor.name,
        command: descriptor.command,
        status: "running",
        outputPath: "/tmp/out",
        isAgent: descriptor.isAgent,
        notifyOnCompletion: descriptor.notifyOnCompletion,
        triggerOnCompletion: descriptor.triggerOnCompletion,
      };
      this.lastRunTask = task;
      return task;
    },
    onTerminal(handler) {
      this.terminalSubscriptions += 1;
      this.callLog.push("bg:onTerminal");
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async emitTerminal(task) {
      for (const handler of [...handlers]) await handler(task);
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

function terminalAction(actionId, assignmentId, name, command) {
  return {
    action_id: actionId,
    assignment_id: assignmentId,
    kind: "launch-background",
    bg_run: { name, command, isAgent: true, notifyOnCompletion: true, triggerOnCompletion: true },
    run_revision: 1,
    supersession_state: "live",
  };
}
