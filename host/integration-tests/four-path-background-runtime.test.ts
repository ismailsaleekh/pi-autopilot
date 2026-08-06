import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";

const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BACKGROUND_SOURCE_ROOT = process.env.PI_BACKGROUND_TASKS_PACKAGE_ROOT ?? fileURLToPath(new URL("../../../pi-background-tasks", import.meta.url));
const PI_SDK_ROOT = resolvePiSdkRoot();
const PI_SDK_VERSION = readPackageVersion(PI_SDK_ROOT);
const piSdk = await import(pathToFileURL(join(PI_SDK_ROOT, "dist", "index.js")).href);
const {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = piSdk;

const FOUR_PATH_ARGS = "main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md";
const METERED_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
];
const packageSets = createRuntimePackageSets();
after(() => {
  for (const candidate of packageSets) candidate.cleanup();
});

for (const candidate of packageSets) {
  test(`four-path command reaches real background event-bus runtime without ctx.bg_run (${candidate.label})`, { timeout: 90000 }, async () => {
    assert.equal(PI_SDK_VERSION, "0.84.0", `runtime integration must use real Pi 0.84.0 SDK, got ${PI_SDK_VERSION}`);
    assertPackageCandidate(candidate.packageRoot, "pi-autopilot");
    assertBackgroundCandidate(candidate.backgroundRoot);
    assertCoreBinaryPresent(candidate.packageRoot);

    const harness = createRuntimeHarness(`pi-autopilot-runtime-${candidate.label}-`);
    const { eventBus, requests, networkCalls, restore } = installOfflineCanaries(harness.fakeBin, harness.fakePiCanary, harness.project);
    const terminalTasks = [];
    const probeClient = new BackgroundProbeClient(eventBus);
    const unsubscribeProbeTerminal = probeClient.onTerminal(async (task) => {
      terminalTasks.push(task);
    });

    const loader = createLoader(harness.project, harness.agentDir, eventBus, candidate);
    await loader.reload();

    try {
      const { session } = await createAgentSession({
        cwd: harness.project,
        agentDir: harness.agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(harness.project),
        settingsManager: SettingsManager.inMemory({}),
        noTools: "builtin",
      });
      await bindSession(session);
      try {
        const extensionResult = loader.getExtensions();
        assert.deepEqual(extensionResult.errors, []);
        const commandNames = extensionResult.extensions.flatMap((extension) => [...extension.commands.keys()]);
        assert.ok(commandNames.includes("autopilot-plan"), `commands=${JSON.stringify(commandNames)}`);
        assert.ok(extensionResult.extensions.some((extension) => extension.resolvedPath.startsWith(candidate.packageRoot)), `Autopilot extension did not load from package root ${candidate.packageRoot}`);
        assert.ok(extensionResult.extensions.some((extension) => extension.resolvedPath.startsWith(candidate.backgroundRoot)), `Background extension did not load from package root ${candidate.backgroundRoot}`);
        const toolNames = session.getAllTools().map((tool) => tool.name);
        assert.ok(toolNames.includes("bg_run"), `tools=${JSON.stringify(toolNames)}`);
        assert.ok(toolNames.includes("bg_status"), `tools=${JSON.stringify(toolNames)}`);
        assert.ok(toolNames.includes("bg_logs"), `tools=${JSON.stringify(toolNames)}`);
        assert.ok(toolNames.includes("bg_kill"), `tools=${JSON.stringify(toolNames)}`);

        assert.deepEqual(await probeClient.capabilities(), completeCapabilities());
        await session.prompt(`/autopilot-plan ${FOUR_PATH_ARGS}`);

        const manifestPath = join(harness.project, ".pi", "autopilot", "main", "planning-manifest.json");
        await waitFor(() => existsSync(manifestPath), "planning manifest creation");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        assertExactFourPathManifest(manifest, harness.project, "runtime-set");

        const capabilityRequests = requests.filter((request) => request.operation === "capabilities");
        assert.ok(capabilityRequests.length >= 1, "Autopilot must handshake background capabilities over pi.events");
        const runRequests = requests.filter((request) => request.operation === "run");
        assert.ok(runRequests.length >= 1, `missing run request: ${JSON.stringify(requests)}`);
        const firstDescriptor = runRequests[0].payload;
        assert.equal(firstDescriptor.isAgent, true);
        assert.equal(firstDescriptor.notifyOnCompletion, true);
        assert.equal(firstDescriptor.triggerOnCompletion, false);
        if (Object.prototype.hasOwnProperty.call(firstDescriptor, "timeoutSeconds")) {
          assert.equal(firstDescriptor.timeoutSeconds, 3600);
        }
        assert.match(firstDescriptor.command, / --spec /u);
        assert.ok(firstDescriptor.command.includes(join(candidate.packageRoot, "bin", "autopilot-agent-run.mjs")), firstDescriptor.command);

        const status = await probeClient.status();
        const tracked = status.tasks.find((task) => task.command === firstDescriptor.command);
        assert.ok(tracked, `tracked task metadata did not contain the exact Core descriptor command: ${JSON.stringify(status.tasks)}`);
        assert.equal(tracked.isAgent, true);
        assert.equal(tracked.notifyOnCompletion, true);
        assert.equal(tracked.triggerOnCompletion, false);

        await waitFor(() => terminalTasks.length >= 1, "terminal task publication");
        await probeClient.drainTerminalHandlers();
        await waitFor(() => requests.filter((request) => request.operation === "run").length >= 2, "terminal correlation next spawn");
        const secondRun = requests.filter((request) => request.operation === "run")[1];
        assert.match(secondRun.payload.name, /planning-main-task-extractor-02/u);
        assert.ok(readEventsIfPresent(harness.eventLog).some((event) => event.kind === "agent:spawn" && event.artifact_refs.includes("planning-main-task-extractor-02")));

        const fakePiInvocations = readJsonlIfPresent(harness.fakePiCanary);
        assert.ok(fakePiInvocations.length >= 1, "package-contained runner did not invoke fake pi");
        assert.ok(fakePiInvocations.every((entry) => entry.argv.includes("--mode") && entry.argv.includes("rpc")));
        assert.ok(fakePiInvocations.every((entry) => entry.meteredCredentials.length === 0), JSON.stringify(fakePiInvocations));
        assert.deepEqual(networkCalls, [], "runtime integration must not call provider/network fetch");
        assert.equal(Object.prototype.hasOwnProperty.call(session, "bg_run"), false);
      } finally {
        await shutdownSession(session);
      }
    } finally {
      unsubscribeProbeTerminal();
      await probeClient.close();
      restore();
    }
  });
}

/**
 * BUG-184 T2. Autopilot is installed globally, so its extension factory runs in
 * every Pi session. Through Pi's REAL loader and a REAL AgentSession, an
 * unactivated session must expose the background tools and ZERO `autopilot_*`
 * tools, and none of the 7 planning-tool prompt literals may reach the model's
 * tool metadata. After /autopilot-plan they must all appear.
 */
test("BUG-184: autopilot tools and prompt text are absent until an activating command runs", { timeout: 90000 }, async () => {
  const candidate = packageSets[0];
  assertBackgroundCandidate(candidate.backgroundRoot);
  assertCoreBinaryPresent(candidate.packageRoot);

  const harness = createRuntimeHarness("pi-autopilot-bug184-scoping-");
  const { eventBus, restore } = installOfflineCanaries(harness.fakeBin, harness.fakePiCanary, harness.project);
  const loader = createLoader(harness.project, harness.agentDir, eventBus, candidate);
  await loader.reload();

  try {
    const { session } = await createAgentSession({
      cwd: harness.project,
      agentDir: harness.agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(harness.project),
      settingsManager: SettingsManager.inMemory({}),
      noTools: "builtin",
    });
    await bindSession(session);
    try {
      const backgroundTools = ["bg_run", "bg_status", "bg_logs", "bg_kill"];
      const beforeNames = session.getAllTools().map((tool) => tool.name);
      for (const name of backgroundTools) {
        assert.ok(beforeNames.includes(name), `background tool ${name} must be present: ${JSON.stringify(beforeNames)}`);
      }
      assert.deepEqual(
        beforeNames.filter((name) => name.startsWith("autopilot_")).sort(),
        [],
        "an unactivated session must expose zero autopilot_* tools",
      );

      // Prompt assembly is not directly observable from this harness, so the
      // assertion is made on the tool metadata Pi uses to BUILD the prompt
      // (promptSnippet/promptGuidelines are only emitted for active tools).
      // GAP STATED: this proves the prompt inputs are absent, not the rendered
      // system-prompt string.
      const promptTextBefore = session.getAllTools()
        .flatMap((tool) => [...(tool.promptGuidelines ?? []), tool.promptSnippet ?? ""])
        .join("\n");
      assert.equal(promptTextBefore.includes("autopilot_submit_"), false, promptTextBefore);
      assert.equal(promptTextBefore.includes("typed Autopilot carrier"), false, promptTextBefore);

      await session.prompt(`/autopilot-plan ${FOUR_PATH_ARGS}`);

      const afterNames = session.getAllTools().map((tool) => tool.name);
      assert.deepEqual(afterNames.filter((name) => name.startsWith("autopilot_")).sort(), [
        "autopilot_submit_atoms",
        "autopilot_submit_context",
        "autopilot_submit_plan_cluster",
        "autopilot_submit_resolution",
        "autopilot_submit_review",
        "autopilot_submit_scout_report",
        "autopilot_submit_synthesis",
      ]);
      for (const name of backgroundTools) {
        assert.ok(afterNames.includes(name), `activation must not disturb ${name}`);
      }
    } finally {
      await shutdownSession(session);
    }
  } finally {
    restore();
  }
});

test("missing background service returns SupplyCapability with zero Autopilot mutation", { timeout: 30000 }, async () => {
  const candidate = packageSets[0];
  assertCoreBinaryPresent(candidate.packageRoot);
  const harness = createRuntimeHarness("pi-autopilot-missing-bg-");
  const { eventBus, requests, restore } = installOfflineCanaries(harness.fakeBin, harness.fakePiCanary, harness.project);
  const loader = createLoader(harness.project, harness.agentDir, eventBus, candidate, { includeBackground: false });
  await loader.reload();

  try {
    const { session } = await createAgentSession({
      cwd: harness.project,
      agentDir: harness.agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(harness.project),
      settingsManager: SettingsManager.inMemory({}),
      noTools: "builtin",
    });
    await bindSession(session);
    try {
      await session.prompt(`/autopilot-plan ${FOUR_PATH_ARGS}`);
      assert.equal(existsSync(join(harness.project, ".pi", "autopilot")), false, "missing background service must not mutate Autopilot state");
      assert.equal(requests.some((request) => request.operation === "run"), false);
      assert.deepEqual(readEventsIfPresent(harness.eventLog), []);
    } finally {
      await shutdownSession(session);
    }
  } finally {
    restore();
  }
});

test("historical and index controls reject before background spawn", { timeout: 60000 }, async () => {
  const candidate = packageSets[0];
  assertBackgroundCandidate(candidate.backgroundRoot);
  assertCoreBinaryPresent(candidate.packageRoot);

  for (const marker of ["[historical/non-authority]", "[index/non-authority]"]) {
    const harness = createRuntimeHarness(`pi-autopilot-${marker.slice(1, 6)}-`);
    writeFileSync(join(harness.project, "TASK-A.md"), `${marker}\nauthority_set_id: runtime-set\n\nforbidden control\n`, "utf8");
    git(harness.project, ["add", "TASK-A.md"]);
    git(harness.project, ["commit", "-m", `replace with ${marker}`]);
    const { eventBus, requests, restore } = installOfflineCanaries(harness.fakeBin, harness.fakePiCanary, harness.project);
    const loader = createLoader(harness.project, harness.agentDir, eventBus, candidate);
    await loader.reload();

    try {
      const { session } = await createAgentSession({
        cwd: harness.project,
        agentDir: harness.agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(harness.project),
        settingsManager: SettingsManager.inMemory({}),
        noTools: "builtin",
      });
      await bindSession(session);
      try {
        await session.prompt(`/autopilot-plan ${FOUR_PATH_ARGS}`);
        assert.equal(existsSync(join(harness.project, ".pi", "autopilot", "main", "planning-manifest.json")), false, `${marker} must not create a manifest`);
        assert.equal(requests.some((request) => request.operation === "run"), false, `${marker} must not spawn background work`);
      } finally {
        await shutdownSession(session);
      }
    } finally {
      restore();
    }
  }
});

async function bindSession(session) {
  const extensionErrors = [];
  await session.bindExtensions({
    mode: "json",
    uiContext: jsonUiContext(),
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {},
    },
    onError(error) {
      extensionErrors.push(error);
    },
  });
  assert.deepEqual(extensionErrors, []);
}

async function shutdownSession(session) {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

function createLoader(project, agentDir, eventBus, candidate, options = {}) {
  const includeBackground = options.includeBackground !== false;
  return new DefaultResourceLoader({
    cwd: project,
    agentDir,
    eventBus,
    additionalExtensionPaths: includeBackground ? [candidate.backgroundRoot, candidate.packageRoot] : [candidate.packageRoot],
  });
}

function createRuntimeHarness(prefix) {
  const project = mkdtempSync(join(tmpdir(), prefix));
  const agentDir = mkdtempSync(join(tmpdir(), `${prefix}agent-`));
  mkdirSync(join(project, "src"));
  writeTaskPack(project, "runtime-set");
  writeFileSync(join(project, "src", "fixture.ts"), "export const runtime = true;\n", "utf8");
  git(project, ["init"]);
  git(project, ["config", "user.email", "runtime@example.invalid"]);
  git(project, ["config", "user.name", "Runtime Test"]);
  git(project, ["add", "."]);
  git(project, ["commit", "-m", "runtime fixture"]);
  const eventLog = join(project, ".pi", "autopilot", "core-events.jsonl");
  const fakeBin = mkdtempSync(join(tmpdir(), `${prefix}fake-pi-`));
  const fakePiCanary = join(project, "fake-pi-invocations.jsonl");
  writeFakePi(fakeBin, fakePiCanary);
  return { project, agentDir, eventLog, fakeBin, fakePiCanary };
}

function installOfflineCanaries(fakeBin, fakePiCanary, project) {
  const eventBus = createEventBus();
  const requests = [];
  eventBus.on(BG_REQUEST_CHANNEL, (data) => {
    if (data && typeof data === "object") requests.push(data);
  });

  const previous = {
    cwd: process.cwd(),
    PATH: process.env.PATH,
    PI_OFFLINE: process.env.PI_OFFLINE,
    PI_BG_DISABLE_UPDATE_CHECK: process.env.PI_BG_DISABLE_UPDATE_CHECK,
    AUTOPILOT_CORE_EVENT_LOG: process.env.AUTOPILOT_CORE_EVENT_LOG,
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };
  const previousMetered = new Map(METERED_ENV.map((key) => [key, process.env[key]]));
  const networkCalls = [];
  const blockNetwork = (kind) => (...args) => {
    networkCalls.push(`${kind}:${String(args[0])}`);
    throw new Error(`network canary blocked ${kind}`);
  };
  globalThis.fetch = async (input) => {
    networkCalls.push(`fetch:${String(input)}`);
    throw new Error(`network canary blocked fetch ${String(input)}`);
  };
  http.request = blockNetwork("http.request");
  http.get = blockNetwork("http.get");
  https.request = blockNetwork("https.request");
  https.get = blockNetwork("https.get");
  process.env.PATH = `${fakeBin}:${previous.PATH ?? ""}`;
  process.env.PI_OFFLINE = "1";
  process.env.PI_BG_DISABLE_UPDATE_CHECK = "1";
  process.env.AUTOPILOT_CORE_EVENT_LOG = join(project, ".pi", "autopilot", "core-events.jsonl");
  process.chdir(project);
  for (const key of METERED_ENV) delete process.env[key];
  rmSync(fakePiCanary, { force: true });

  return {
    eventBus,
    requests,
    networkCalls,
    restore() {
      globalThis.fetch = previous.fetch;
      http.request = previous.httpRequest;
      http.get = previous.httpGet;
      https.request = previous.httpsRequest;
      https.get = previous.httpsGet;
      restoreEnv("PATH", previous.PATH);
      restoreEnv("PI_OFFLINE", previous.PI_OFFLINE);
      restoreEnv("PI_BG_DISABLE_UPDATE_CHECK", previous.PI_BG_DISABLE_UPDATE_CHECK);
      restoreEnv("AUTOPILOT_CORE_EVENT_LOG", previous.AUTOPILOT_CORE_EVENT_LOG);
      process.chdir(previous.cwd);
      for (const [key, value] of previousMetered) restoreEnv(key, value);
    },
  };
}

class BackgroundProbeClient {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.nextRequest = 1;
    this.pending = new Map();
    this.terminalHandlers = new Set();
    this.terminalDelivery = Promise.resolve();
    this.unsubscribeResponse = eventBus.on(BG_RESPONSE_CHANNEL, (data) => this.receiveResponse(data));
    this.unsubscribeTerminal = eventBus.on(BG_TERMINAL_CHANNEL, (data) => this.receiveTerminal(data));
  }

  async capabilities() {
    return this.request("capabilities", {});
  }

  async status(taskId) {
    const payload = taskId === undefined ? {} : { taskId };
    return this.request("status", payload);
  }

  onTerminal(handler) {
    this.terminalHandlers.add(handler);
    return () => this.terminalHandlers.delete(handler);
  }

  async drainTerminalHandlers() {
    await this.terminalDelivery;
  }

  async close() {
    this.unsubscribeResponse();
    this.unsubscribeTerminal();
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error("probe client closed"));
    }
    await this.drainTerminalHandlers();
  }

  request(operation, payload) {
    const requestId = `probe-${Date.now().toString(36)}-${this.nextRequest.toString(36)}`;
    this.nextRequest += 1;
    const envelope = { schema_version: BG_REQUEST_SCHEMA, request_id: requestId, operation, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`probe ${operation} timed out`));
      }, 5000);
      this.pending.set(requestId, { operation, resolve, reject, timer });
      this.eventBus.emit(BG_REQUEST_CHANNEL, envelope);
    });
  }

  receiveResponse(data) {
    assert.equal(data?.schema_version, BG_RESPONSE_SCHEMA);
    const pending = this.pending.get(data.request_id);
    if (!pending) return;
    this.pending.delete(data.request_id);
    clearTimeout(pending.timer);
    assert.equal(data.operation, pending.operation);
    if (data.ok) pending.resolve(data.result);
    else pending.reject(new Error(String(data.error)));
  }

  receiveTerminal(data) {
    assert.equal(data?.schema_version, BG_TERMINAL_SCHEMA);
    assert.equal(typeof data.task?.id, "string");
    const handlers = [...this.terminalHandlers];
    this.terminalDelivery = this.terminalDelivery.then(async () => {
      for (const handler of handlers) await handler(data.task);
    });
  }
}

function jsonUiContext() {
  return {
    async select() { return undefined; },
    async confirm() { return false; },
    async input() { return undefined; },
    notify() {},
    onTerminalInput() { return () => {}; },
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() { return undefined; },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() { return ""; },
    async editor() { return undefined; },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() { return undefined; },
    theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; }, italic(text) { return text; }, strikethrough(text) { return text; } },
    getAllThemes() { return []; },
    getTheme() { return undefined; },
    setTheme() { return { success: false, error: "json test ui has no themes" }; },
    getToolsExpanded() { return false; },
    setToolsExpanded() {},
  };
}

function assertExactFourPathManifest(manifest, project, authoritySetId) {
  assert.equal(manifest.workstream, "main");
  assert.equal(manifest.authority_set_id, authoritySetId);
  assert.deepEqual(manifest.authority_paths, ["TASK-A.md", "TASK-B.md", "TASK-C.md"]);
  assert.deepEqual(manifest.context, {
    path: "CONTEXT.md",
    class: "context/non-authority",
    digest: sha256(readFileSync(join(project, "CONTEXT.md"))),
  });
  assert.equal(manifest.atoms, 3);
  const exactFour = ["TASK-A.md", "TASK-B.md", "TASK-C.md", "CONTEXT.md"];
  assert.deepEqual(manifest.file_digests.map((entry) => entry.path), exactFour);
  assert.deepEqual(manifest.file_digests.map((entry) => entry.digest), exactFour.map((path) => sha256(readFileSync(join(project, path)))));
  assert.equal(manifest.file_digests.filter((entry) => entry.class === "Authority").length, 3);
  assert.equal(manifest.file_digests.filter((entry) => entry.class === "ContextNonAuthority").length, 1);
}

function writeTaskPack(root, authoritySetId) {
  const entries = [
    ["TASK-A.md", "[authority]", "A runtime atom\n"],
    ["TASK-B.md", "[authority]", "B runtime atom\n"],
    ["TASK-C.md", "[authority]", "C runtime atom\n"],
    ["CONTEXT.md", "[context/non-authority]", "runtime context sentinel\n"],
  ];
  for (const [name, marker, body] of entries) {
    writeFileSync(join(root, name), `${marker}\nauthority_set_id: ${authoritySetId}\n\n${body}`, "utf8");
  }
}

function writeFakePi(fakeBin, canaryPath) {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const valueAfter = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
const metered = ${JSON.stringify(METERED_ENV)}.filter((key) => Boolean(process.env[key]));
fs.appendFileSync(${JSON.stringify(canaryPath)}, JSON.stringify({ argv, provider: valueAfter('--provider'), model: valueAfter('--model'), meteredCredentials: metered }) + '\\n');
const prompt = argv[argv.length - 1] || '';
let content = 'atom: fake-pi task atom with source anchor';
if (prompt.includes('planning.scout-dossier.v1')) content = 'evidence: fake-pi repository evidence';
if (prompt.includes('planning.work-map.v1')) content = '### unit\\n- id: U1\\n- objective: deliver fake runtime unit\\n- acceptance criteria: pass\\n- atom-id: A1';
if (prompt.includes('planning.plan-review.v1')) content = 'verdict: pass';
if (prompt.includes('planning.questions.v1')) content = 'questions: []';
const provider = valueAfter('--provider');
const model = valueAfter('--model');
const message = {
  role: 'assistant',
  content: [{ type: 'text', text: content }],
  api: 'openai-codex-responses',
  provider,
  model,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: Date.now(),
};
console.log(JSON.stringify({ type: 'message_end', message }));
console.log(JSON.stringify({ type: 'agent_end', messages: [message], willRetry: false, status: 'completed', stop_reason: 'stop' }));
`;
  writeFileSync(join(fakeBin, process.platform === "win32" ? "pi.cmd" : "pi"), script, { mode: 0o755 });
}

function completeCapabilities() {
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
}

function createRuntimePackageSets() {
  return [createSourcePackageSet(), createPackedPackageSet()];
}

function createSourcePackageSet() {
  const consumerRoot = mkdtempSync(join(tmpdir(), "pi-autopilot-source-consumer-"));
  const nodeModules = join(consumerRoot, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  linkPiPeers(nodeModules);
  const backgroundRoot = installPackedPackage(BACKGROUND_SOURCE_ROOT, nodeModules, "pi-background-tasks");
  return {
    label: "source",
    packageRoot: SOURCE_ROOT,
    backgroundRoot,
    cleanup: () => rmSync(consumerRoot, { recursive: true, force: true }),
  };
}

function createPackedPackageSet() {
  const consumerRoot = mkdtempSync(join(tmpdir(), "pi-autopilot-packed-consumer-"));
  const nodeModules = join(consumerRoot, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  linkPiPeers(nodeModules);
  const backgroundRoot = installPackedPackage(BACKGROUND_SOURCE_ROOT, nodeModules, "pi-background-tasks");
  const packageRoot = installPackedPackage(SOURCE_ROOT, nodeModules, "pi-autopilot");
  assert.equal(packageRoot.includes("node_modules"), true, packageRoot);
  assert.equal(existsSync(join(packageRoot, "extensions", "autopilot.ts")), true, "packed package must include extension wrapper");
  return {
    label: "installed-tarball",
    packageRoot,
    backgroundRoot,
    cleanup: () => rmSync(consumerRoot, { recursive: true, force: true }),
  };
}

function installPackedPackage(sourceRoot, nodeModules, packageName) {
  const packDir = mkdtempSync(join(tmpdir(), `${packageName}-pack-`));
  const stdout = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });
  const packed = JSON.parse(stdout);
  const tarball = join(packDir, packed[0].filename);
  const extractDir = mkdtempSync(join(tmpdir(), `${packageName}-extract-`));
  execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "pipe" });
  const installedRoot = join(nodeModules, packageName);
  rmSync(installedRoot, { recursive: true, force: true });
  renameSync(join(extractDir, "package"), installedRoot);
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
  return installedRoot;
}

function linkPiPeers(nodeModules) {
  const scoped = join(nodeModules, "@earendil-works");
  mkdirSync(scoped, { recursive: true });
  linkDir(PI_SDK_ROOT, join(scoped, "pi-coding-agent"));
  for (const name of ["pi-ai", "pi-agent-core", "pi-tui"]) {
    linkDir(join(PI_SDK_ROOT, "node_modules", "@earendil-works", name), join(scoped, name));
  }
  linkDir(join(PI_SDK_ROOT, "node_modules", "typebox"), join(nodeModules, "typebox"));
}

function linkDir(target, destination) {
  rmSync(destination, { recursive: true, force: true });
  symlinkSync(target, destination, "dir");
}

function resolvePiSdkRoot() {
  const candidates = [
    process.env.PI_CODING_AGENT_PACKAGE_ROOT,
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
    join(SOURCE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "dist", "index.js"))) return candidate;
  }
  throw new Error(`Unable to locate @earendil-works/pi-coding-agent SDK root among ${JSON.stringify(candidates)}`);
}

function readPackageVersion(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

function assertPackageCandidate(root, name) {
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(metadata.name, name);
  assert.deepEqual(metadata.pi.extensions, ["./extensions/autopilot.ts"]);
}

function assertBackgroundCandidate(root) {
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(metadata.name, "pi-background-tasks");
  assert.equal(metadata.version, "2.1.2");
  assert.ok(existsSync(join(root, "src", "core", "extension-api.ts")), "background candidate must expose the 2.1.2 extension API source");
}

function assertCoreBinaryPresent(packageRoot) {
  const binary = coreBinaryPath(packageRoot);
  assert.ok(existsSync(binary), `Missing executable real Core binary at ${binary}. Build or pack before runtime integration.`);
  assert.ok(statSync(binary).isFile());
}

function coreBinaryPath(packageRoot) {
  const platformKey = `${process.platform}-${process.arch}`;
  const name = process.platform === "win32" ? "autopilot-core.exe" : "autopilot-core";
  return join(packageRoot, "binaries", platformKey, name);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function readEventsIfPresent(eventLog) {
  return readJsonlIfPresent(eventLog);
}

function readJsonlIfPresent(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
