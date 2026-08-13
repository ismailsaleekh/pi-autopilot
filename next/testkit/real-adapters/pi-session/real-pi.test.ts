import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as waitForDelay } from "node:timers/promises";
import test from "node:test";
import { ProcessAdapter } from "../../../adapters/process/index.js";
import type { ProcessHandle } from "../../../adapters/process/index.js";
import {
  PI_ISOLATED_SETTINGS_TEXT,
  PiSessionAdapter,
  createPiCliSubscriptionRouteVerifier,
} from "../../../adapters/pi-session/index.js";
import type {
  PiSessionBindingResolver,
  PiSessionChildReference,
  PiSessionExecution,
} from "../../../adapters/pi-session/index.js";
import { childIntentCapsule } from "../../../ports/contracts/child.capsule.js";
import type { LaunchChildSession } from "../../../ports/contracts/child.capsule.js";
import {
  nodeFileCaptureSink,
  nodeProcessGraceWaiter,
} from "../process/node-process-capabilities.js";
import { NodeProbeDeadline } from "./node-probe-deadline.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";

const realPiEnabled = process.env["PI_AUTOPILOT_REAL_PI"] === "1";
const expectedPiVersion = process.env["PI_AUTOPILOT_PI_VERSION"] ?? "0.84.1";
const piExecutable = process.env["PI_AUTOPILOT_PI_BIN"] ?? "/usr/local/bin/pi";
const provider = process.env["PI_AUTOPILOT_PI_PROVIDER"] ?? "openai-codex";
const model = process.env["PI_AUTOPILOT_PI_MODEL"] ?? "gpt-5.6-sol";

function hashRoot(value: string): string {
  return `sha256:${Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

function field(input: unknown, name: string): unknown {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  try {
    return Reflect.get(input, name);
  } catch {
    return undefined;
  }
}

function textField(input: unknown, name: string): string | null {
  const value = field(input, name);
  return typeof value === "string" ? value : null;
}

async function commandVersion(
  processes: ProcessAdapter,
  deadline: NodeProbeDeadline,
  executable: string,
  environment: Readonly<Record<string, string>>,
  cwd: string,
  captureDirectory: string,
): Promise<string> {
  const started = await processes.start(Object.freeze({
    arguments: Object.freeze(["--version"]),
    captureDirectory,
    captureId: "pi-version",
    cwd,
    environment,
    executable,
    maxStderrBytes: 1024,
    maxStdoutBytes: 1024,
  }));
  if (started.kind === "rejected") {
    throw new Error(`real Pi version probe did not start: ${started.diagnostic.code}`);
  }
  const completion = await deadline.race(processes.waitForExit(started.handle), 10_000);
  if (completion.kind === "time-bound") {
    await processes.terminate(started.handle, { graceMilliseconds: 0 });
    throw new Error("real Pi version probe exceeded its deadline");
  }
  if (
    completion.value.kind === "rejected"
    || completion.value.observation.lifecycle.kind !== "exited"
    || completion.value.observation.lifecycle.code !== 0
    || completion.value.observation.stdout.truncated
    || completion.value.observation.stderr.truncated
  ) {
    throw new Error("real Pi version probe did not exit cleanly within its output bounds");
  }
  const output = await processes.collectOutput(started.handle, Object.freeze({
    direction: "head",
    maxBytes: 1024,
    stream: "stdout",
  }));
  if (output.kind === "rejected" || output.observation.truncated) {
    throw new Error("real Pi version output was unavailable or truncated");
  }
  return Buffer.from(output.observation.bytes).toString("utf8").trim();
}

async function eventuallyInspect(
  adapter: PiSessionAdapter<ProcessHandle>,
  inspectIntent: unknown,
  timeoutMilliseconds: number,
): Promise<PiSessionExecution> {
  const startedAt = process.hrtime.bigint();
  while (true) {
    const result = await adapter.execute(inspectIntent);
    if (
      result.kind === "observation"
      && result.physical.sessionFile !== null
      && result.physical.process?.lifecycle.kind === "running"
    ) {
      return result;
    }
    const elapsed = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    if (elapsed >= timeoutMilliseconds) {
      throw new Error("real Pi session file plus running process were not observed before the deadline");
    }
    await waitForDelay(5);
  }
}

test(
  "real subscription-backed headless Pi creates a durable session file and terminates without escalation",
  {
    skip: realPiEnabled
      ? false
      : "environment-gated: set PI_AUTOPILOT_REAL_PI=1 only where pinned Pi OAuth is available",
    timeout: 60_000,
  },
  async () => {
    assert.equal(isAbsolute(piExecutable), true);
    const home = process.env["HOME"];
    if (home === undefined) {
      throw new Error("HOME is required to locate the pinned Pi OAuth store");
    }
    const directory = await mkdtemp(join(tmpdir(), "autopilot-real-pi-"));
    try {
    const agentDirectory = join(directory, "agent");
    const workspacePath = join(directory, "workspace");
    const captureDirectory = join(directory, "captures");
    const sessionDirectory = join(directory, "sessions");
    const promptFilePath = join(directory, "prompt.md");
    await Promise.all([
      mkdir(agentDirectory, { mode: 0o700, recursive: true }),
      mkdir(workspacePath, { recursive: true }),
      mkdir(captureDirectory, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
      writeFile(
        promptFilePath,
        "Without tools, write a 50,000-word numbered essay about why process observations are not semantic completion. Do not summarize or stop early.\n",
      ),
    ]);
    const sourceAgentDirectory = process.env["PI_CODING_AGENT_DIR"] ?? join(home, ".pi", "agent");
    await copyFile(join(sourceAgentDirectory, "auth.json"), join(agentDirectory, "auth.json"));
    await chmod(join(agentDirectory, "auth.json"), 0o600);
    await writeFile(
      join(agentDirectory, "settings.json"),
      PI_ISOLATED_SETTINGS_TEXT,
      { mode: 0o600 },
    );
    const environment = Object.freeze({
      HOME: home,
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
    const processes = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
    const probeDeadline = new NodeProbeDeadline();
    const version = await commandVersion(
      processes,
      probeDeadline,
      piExecutable,
      environment,
      workspacePath,
      captureDirectory,
    );
    assert.equal(version, expectedPiVersion);

    const launchTemplate = childIntentCapsule.arbitrary.validForKind("launch-child-session", 9001);
    assert.equal(launchTemplate.kind, "launch-child-session");
    if (launchTemplate.kind !== "launch-child-session") {
      throw new Error("launch template unavailable");
    }
    const promptRoot = hashRoot("real-pi-prompt");
    const workspaceRoot = hashRoot("real-pi-workspace");
    const runtimeRoot = hashRoot(`pi-runtime-${version}`);
    const launchIntent = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({
        attemptId: launchTemplate.inputs.attemptId,
        prompt: Object.freeze({ path: "prompt.md", range: null, root: promptRoot }),
        roleId: launchTemplate.inputs.roleId,
        runtimeRoot,
        workItemId: launchTemplate.inputs.workItemId,
        workspaceId: launchTemplate.inputs.workspaceId,
      }),
      kind: "launch-child-session",
      preconditions: Object.freeze({
        childEpoch: launchTemplate.preconditions.childEpoch,
        expectedWorkspaceRoot: workspaceRoot,
        runtimeDigest: runtimeRoot,
      }),
      runId: launchTemplate.runId,
    }));
    assert.notEqual(launchIntent, null);

    const resolver: PiSessionBindingResolver = Object.freeze({
      resolveLaunch: async (intent: LaunchChildSession) => Object.freeze({
        captureDirectory,
        environment,
        extensionPaths: Object.freeze([]),
        maxStderrBytes: 256 * 1024,
        maxStdoutBytes: 256 * 1024,
        piCommand: Object.freeze({ executable: piExecutable, prefixArguments: Object.freeze([]) }),
        promptArtifactPath: intent.inputs.prompt.path,
        promptArtifactRoot: intent.inputs.prompt.root,
        promptFilePath,
        route: Object.freeze({
          channel: "subscription",
          model,
          provider,
          thinking: "low",
        }),
        runtimeRoot: intent.inputs.runtimeRoot,
        sessionDirectory,
        toolNames: Object.freeze([]),
        workspaceId: intent.inputs.workspaceId,
        workspacePath,
        workspaceRoot,
      }),
      observeSealedRoot: async (_child: PiSessionChildReference) => null,
    });
    const adapter = new PiSessionAdapter(
      processes,
      resolver,
      {
        allowedRoutes: Object.freeze([Object.freeze({
          channel: "subscription",
          model,
          provider,
          thinking: "low",
        })]),
        routeVerifier: createPiCliSubscriptionRouteVerifier(
          processes,
          probeDeadline,
        ),
        terminationGraceMilliseconds: 1_000,
      },
    );
    let fenceIntent: unknown = null;
    let fenced = false;
    try {
      const launched = await adapter.execute(launchIntent);
      if (launched.kind === "rejected") {
        throw new Error(launched.diagnostic.code);
      }
      assert.equal(launched.kind, "observation");
      assert.equal(launched.observation.kind, "child-session-launched");
      assert.equal(launched.observation.result.kind, "ok");
      assert.equal(launched.physical.route.kind, "verified");
      const launchValue = field(launched.observation.result, "value");
      const childId = textField(launchValue, "childId");
      const childEpoch = textField(launchValue, "childEpoch");
      if (childId === null || childEpoch === null) {
        throw new Error("real Pi launch omitted child identity");
      }
      fenceIntent = bindLawIntent("child", Object.freeze({
        inputs: Object.freeze({ childId }),
        kind: "fence-child-session",
        preconditions: Object.freeze({
          childEpoch,
          replacementEpoch: `${childEpoch}-replacement`,
        }),
        runId: launchTemplate.runId,
      }));
      assert.notEqual(fenceIntent, null);
      const inspectIntent = bindLawIntent("child", Object.freeze({
        inputs: Object.freeze({ childId }),
        kind: "inspect-child-session",
        preconditions: Object.freeze({ childEpoch }),
        runId: launchTemplate.runId,
      }));
      assert.notEqual(inspectIntent, null);
      const running = await eventuallyInspect(adapter, inspectIntent, 20_000);
      assert.equal(running.kind, "observation");
      if (running.kind !== "observation" || running.physical.sessionFile === null) {
        throw new Error("real Pi physical observation was absent");
      }
      assert.equal((await stat(running.physical.sessionFile)).size > 0, true);
      assert.equal(running.physical.sessionFiles.length, 1);
      assert.equal(running.physical.sessionScanCode, null);

      const terminated = await adapter.execute(fenceIntent);
      if (terminated.kind === "rejected") {
        throw new Error(terminated.diagnostic.code);
      }
      assert.equal(terminated.kind, "observation");
      fenced = true;
      assert.equal(terminated.observation.kind, "child-session-fenced");
      assert.equal(terminated.observation.result.kind, "ok");
      assert.deepEqual(terminated.physical.termination, { escalated: false });
      assert.equal(terminated.physical.process?.lifecycle.kind === "running", false);
      assert.equal(terminated.physical.process?.processGroup.kind, "absent");
    } finally {
      if (!fenced && fenceIntent !== null) {
        await adapter.execute(fenceIntent);
      }
    }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);
