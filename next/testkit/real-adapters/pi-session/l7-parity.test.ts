import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SystemClockAdapter } from "../../../adapters/clock/index.js";
import {
  PI_ISOLATED_SETTINGS_TEXT,
  PiSessionAdapter,
  createPiCliSubscriptionRouteVerifier,
} from "../../../adapters/pi-session/index.js";
import { ProcessAdapter } from "../../../adapters/process/index.js";
import { SecretsAdapter } from "../../../adapters/secrets/index.js";
import { childIntentCapsule } from "../../../ports/contracts/child.capsule.js";
import type { LaunchChildSession } from "../../../ports/contracts/child.capsule.js";
import { clockIntentCapsule } from "../../../ports/contracts/clock.capsule.js";
import { secretsIntentCapsule } from "../../../ports/contracts/secrets.capsule.js";
import {
  childLawVector,
  clockLawVector,
  secretsLawVector,
} from "../../../ports/laws/vectors.js";
import type { ContractVector } from "../../../ports/laws/contract-vector.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import { SimLawDriver } from "../../simulation/law-driver.js";
import { RealL7LawDriver } from "./l7-law-driver.js";
import { NodeProbeDeadline } from "./node-probe-deadline.js";
import {
  nodeFileCaptureSink,
  nodeProcessGraceWaiter,
} from "../process/node-process-capabilities.js";

const stubPiModule = fileURLToPath(new URL("./stub-pi.js", import.meta.url));

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

async function replayParity(vector: ContractVector): Promise<RealL7LawDriver> {
  const fake = new SimLawDriver(71);
  const real = await RealL7LawDriver.create();
  const fakeResult = await vector.replay(fake);
  const realResult = await vector.replay(real);
  assert.deepEqual(fakeResult.findings, [], `fake findings for ${vector.id}`);
  assert.deepEqual(realResult.findings, [], `real findings for ${vector.id}`);
  assert.deepEqual(realResult.trace, fakeResult.trace, `normalized trace divergence for ${vector.id}`);
  return real;
}

test("child, clock, and secrets law vectors replay with fake/real trace parity", async (context) => {
  for (const vector of [childLawVector, clockLawVector, secretsLawVector]) {
    await context.test(vector.id, async () => {
      const real = await replayParity(vector);
      try {
        if (vector.id === childLawVector.id) {
          assert.equal(real.sessionFileObservations().length, 1);
          assert.deepEqual(real.verifiedRouteObservations(), ["openai-codex/gpt-5.6-sol"]);
        }
      } finally {
        await real.dispose();
      }
    });
  }
});

test("secret bytes cross only the private lease callback and never serialized returns or errors", async () => {
  const bytes = Buffer.from("L7-SECRET-VALUE-MUST-NEVER-SERIALIZE-83f1", "utf8");
  const expectedBytes = Buffer.from(bytes);
  const publicValues: unknown[] = [];
  let childActive = true;
  const adapter = new SecretsAdapter(Object.freeze({ isActive: () => childActive }));
  const registration = adapter.register("secret:opaque-roundtrip", bytes);
  publicValues.push(registration);
  assert.equal(registration.kind, "registered");

  const template = secretsIntentCapsule.arbitrary.validForKind("authorize-secret-use", 8301);
  assert.equal(template.kind, "authorize-secret-use");
  if (template.kind !== "authorize-secret-use") {
    throw new Error("authorize template unavailable");
  }
  const authorize = bindLawIntent("secrets", Object.freeze({
    inputs: Object.freeze({
      childId: template.inputs.childId,
      purposeId: template.inputs.purposeId,
      secretHandle: "secret:opaque-roundtrip",
    }),
    kind: "authorize-secret-use",
    preconditions: template.preconditions,
    runId: template.runId,
  }));
  assert.notEqual(authorize, null);
  const authorized = adapter.execute(authorize);
  publicValues.push(authorized);
  assert.equal(authorized.kind, "observation");
  const leaseId = field(field(field(authorized, "observation"), "result"), "value");
  const lease = field(leaseId, "leaseId");
  assert.equal(typeof lease, "string");
  if (typeof lease !== "string") {
    throw new Error("opaque lease id was absent");
  }

  bytes.fill(0x78);
  let privateBytes: Uint8Array | null = null;
  const used = await adapter.useLease(lease, (value: unknown) => {
    if (value instanceof Uint8Array) {
      privateBytes = Uint8Array.from(value);
      value.fill(0x79);
    }
  });
  publicValues.push(used);
  assert.equal(
    privateBytes === null ? null : Buffer.from(privateBytes).toString("hex"),
    expectedBytes.toString("hex"),
  );
  let secondLeaseBytes: Uint8Array | null = null;
  await adapter.useLease(lease, (value: unknown) => {
    if (value instanceof Uint8Array) {
      secondLeaseBytes = Uint8Array.from(value);
    }
  });
  assert.equal(
    secondLeaseBytes === null ? null : Buffer.from(secondLeaseBytes).toString("hex"),
    expectedBytes.toString("hex"),
  );
  childActive = false;
  let inactiveCallbackCalled = false;
  const inactive = await adapter.useLease(lease, () => {
    inactiveCallbackCalled = true;
  });
  publicValues.push(inactive);
  assert.equal(inactive.kind, "rejected");
  assert.equal(inactiveCallbackCalled, false);
  childActive = true;
  assert.deepEqual(Reflect.ownKeys(adapter), []);
  assert.doesNotMatch(inspect(adapter, { showHidden: true }), /L7-SECRET|83f1|secret:opaque/);

  const consumerRejected = await adapter.useLease(lease, () => {
    throw new Error(expectedBytes.toString("utf8"));
  });
  publicValues.push(consumerRejected);
  assert.equal(consumerRejected.kind, "rejected");

  const revokeTemplate = secretsIntentCapsule.arbitrary.validForKind("revoke-secret-use", 8302);
  assert.equal(revokeTemplate.kind, "revoke-secret-use");
  if (revokeTemplate.kind !== "revoke-secret-use") {
    throw new Error("revoke template unavailable");
  }
  const revoke = bindLawIntent("secrets", Object.freeze({
    inputs: Object.freeze({ leaseId: lease, secretHandle: "secret:opaque-roundtrip" }),
    kind: "revoke-secret-use",
    preconditions: Object.freeze({ childEpoch: template.preconditions.childEpoch }),
    runId: template.runId,
  }));
  const revoked = adapter.execute(revoke);
  publicValues.push(revoked);
  const unavailable = await adapter.useLease(lease, () => undefined);
  publicValues.push(unavailable);
  assert.equal(unavailable.kind, "rejected");

  const serialized = Buffer.from(JSON.stringify(publicValues), "utf8");
  assert.equal(serialized.includes(expectedBytes), false);
  assert.doesNotMatch(serialized.toString("utf8"), /L7-SECRET-VALUE-MUST-NEVER-SERIALIZE/);
});

test("Pi route probe accepts isolated OAuth and refuses API-key/config/environment drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autopilot-route-probe-"));
  const agentDirectory = join(directory, "agent");
  const captureDirectory = join(directory, "captures");
  const route = Object.freeze({
    channel: "subscription" as const,
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    thinking: "low" as const,
  });
  const environment = Object.freeze({
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
  try {
    await Promise.all([
      mkdir(agentDirectory, { mode: 0o700 }),
      mkdir(captureDirectory),
    ]);
    await Promise.all([
      writeFile(join(agentDirectory, "auth.json"), "{}\n", { mode: 0o600 }),
      writeFile(join(agentDirectory, "settings.json"), PI_ISOLATED_SETTINGS_TEXT, { mode: 0o600 }),
    ]);
    const deadline = new NodeProbeDeadline();
    const verifier = createPiCliSubscriptionRouteVerifier(
      new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter),
      deadline,
    );
    const request = Object.freeze({
      captureDirectory,
      captureId: "oauth-ready",
      command: Object.freeze({ executable: process.execPath, prefixArguments: Object.freeze([stubPiModule]) }),
      cwd: directory,
      environment,
      route,
    });
    const verified = await verifier.verify(request);
    assert.deepEqual(verified, {
      authType: "oauth",
      kind: "verified",
      model: "gpt-5.6-sol",
      provider: "openai-codex",
    });
    assert.equal(deadline.activeCount(), 0, "completed OAuth probe retained a deadline timer");
    const refused = await verifier.verify(Object.freeze({
      ...request,
      captureId: "api-key-refused",
      command: Object.freeze({
        executable: process.execPath,
        prefixArguments: Object.freeze([stubPiModule, "--stub-auth-type", "api_key"]),
      }),
    }));
    assert.deepEqual(refused, {
      code: "pi-route.auth-not-oauth",
      kind: "refused",
      model: "gpt-5.6-sol",
      provider: "openai-codex",
    });
    const environmentRefused = await verifier.verify(Object.freeze({
      ...request,
      captureId: "environment-refused",
      environment: Object.freeze({ ...environment, http_proxy: "http://metered.invalid" }),
    }));
    assert.equal(field(environmentRefused, "code"), "pi-route.environment-key");
    const mixedCaseCredentialRefused = await verifier.verify(Object.freeze({
      ...request,
      captureId: "credential-refused",
      environment: Object.freeze({ ...environment, OpenAI_Api_Key: "must-not-cross" }),
    }));
    assert.equal(field(mixedCaseCredentialRefused, "code"), "pi-route.environment-key");
    await writeFile(join(agentDirectory, "models.json"), "{}\n", { mode: 0o600 });
    const configRefused = await verifier.verify(Object.freeze({
      ...request,
      captureId: "config-refused",
    }));
    assert.equal(field(configRefused, "code"), "pi-route.agent-directory-shape");
    await rm(join(agentDirectory, "models.json"));
    await writeFile(
      join(agentDirectory, "settings.json"),
      PI_ISOLATED_SETTINGS_TEXT.replace("never", "other"),
      { mode: 0o600 },
    );
    const settingsRefused = await verifier.verify(Object.freeze({
      ...request,
      captureId: "settings-refused",
    }));
    assert.equal(field(settingsRefused, "code"), "pi-route.agent-directory-content");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("Pi launch fails closed on scan bounds, route drift, and provider-capable extensions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autopilot-session-bound-"));
  const captures = join(directory, "captures");
  const sessions = join(directory, "sessions");
  const workspace = join(directory, "workspace");
  const route = Object.freeze({
    channel: "subscription" as const,
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    thinking: "low" as const,
  });
  try {
    await Promise.all([mkdir(captures), mkdir(sessions), mkdir(workspace)]);
    for (let first = 0; first < 4_097; first += 256) {
      const writes: Promise<void>[] = [];
      for (let index = first; index < Math.min(first + 256, 4_097); index += 1) {
        writes.push(writeFile(join(sessions, `foreign-${String(index).padStart(4, "0")}`), ""));
      }
      await Promise.all(writes);
    }
    const template = childIntentCapsule.arbitrary.validForKind("launch-child-session", 8_501);
    assert.equal(template.kind, "launch-child-session");
    if (template.kind !== "launch-child-session") {
      throw new Error("launch template unavailable");
    }
    const launch = bindLawIntent("child", Object.freeze({
      inputs: template.inputs,
      kind: "launch-child-session",
      preconditions: Object.freeze({
        ...template.preconditions,
        runtimeDigest: template.inputs.runtimeRoot,
      }),
      runId: template.runId,
    }));
    assert.notEqual(launch, null);
    const processes = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter);
    const adapter = new PiSessionAdapter(
      processes,
      Object.freeze({
        observeSealedRoot: async () => null,
        resolveLaunch: async (intent: LaunchChildSession) => Object.freeze({
          captureDirectory: captures,
          environment: Object.freeze({}),
          extensionPaths: Object.freeze([]),
          maxStderrBytes: 1024,
          maxStdoutBytes: 1024,
          piCommand: Object.freeze({ executable: process.execPath, prefixArguments: Object.freeze([]) }),
          promptArtifactPath: intent.inputs.prompt.path,
          promptArtifactRoot: intent.inputs.prompt.root,
          promptFilePath: join(directory, "prompt.md"),
          route,
          runtimeRoot: intent.inputs.runtimeRoot,
          sessionDirectory: sessions,
          toolNames: Object.freeze([]),
          workspaceId: intent.inputs.workspaceId,
          workspacePath: workspace,
          workspaceRoot: intent.preconditions.expectedWorkspaceRoot,
        }),
      }),
      Object.freeze({
        allowedRoutes: Object.freeze([route]),
        routeVerifier: Object.freeze({
          verify: async () => Object.freeze({
            code: "pi-route.test-refusal",
            kind: "refused" as const,
            model: route.model,
            provider: route.provider,
          }),
        }),
      }),
    );
    const result = await adapter.execute(launch);
    assert.equal(result.kind, "observation");
    if (result.kind === "observation") {
      assert.equal(result.physical.sessionScanCode, "session-directory-bound");
      assert.equal(result.physical.sessionFiles.length, 0);
    }

    let verifierCalled = false;
    const driftedRoute = Object.freeze({ ...route, model: "gpt-5.6-sol-drift" });
    const driftedAdapter = new PiSessionAdapter(
      processes,
      Object.freeze({
        observeSealedRoot: async () => null,
        resolveLaunch: async (intent: LaunchChildSession) => Object.freeze({
          captureDirectory: captures,
          environment: Object.freeze({}),
          extensionPaths: Object.freeze([]),
          maxStderrBytes: 1024,
          maxStdoutBytes: 1024,
          piCommand: Object.freeze({ executable: process.execPath, prefixArguments: Object.freeze([]) }),
          promptArtifactPath: intent.inputs.prompt.path,
          promptArtifactRoot: intent.inputs.prompt.root,
          promptFilePath: join(directory, "prompt.md"),
          route: driftedRoute,
          runtimeRoot: intent.inputs.runtimeRoot,
          sessionDirectory: sessions,
          toolNames: Object.freeze([]),
          workspaceId: intent.inputs.workspaceId,
          workspacePath: workspace,
          workspaceRoot: intent.preconditions.expectedWorkspaceRoot,
        }),
      }),
      Object.freeze({
        allowedRoutes: Object.freeze([route]),
        routeVerifier: Object.freeze({
          verify: async () => {
            verifierCalled = true;
            return Object.freeze({
              authType: "oauth" as const,
              kind: "verified" as const,
              model: driftedRoute.model,
              provider: driftedRoute.provider,
            });
          },
        }),
      }),
    );
    const drifted = await driftedAdapter.execute(launch);
    assert.equal(verifierCalled, false);
    assert.equal(field(field(field(drifted, "observation"), "result"), "kind"), "retry");
    assert.equal(
      field(field(field(field(drifted, "observation"), "result"), "diagnostic"), "code"),
      "pi-route.not-pinned",
    );

    const mismatchedVerificationAdapter = new PiSessionAdapter(
      processes,
      Object.freeze({
        observeSealedRoot: async () => null,
        resolveLaunch: async (intent: LaunchChildSession) => Object.freeze({
          captureDirectory: captures,
          environment: Object.freeze({}),
          extensionPaths: Object.freeze([]),
          maxStderrBytes: 1024,
          maxStdoutBytes: 1024,
          piCommand: Object.freeze({ executable: process.execPath, prefixArguments: Object.freeze([]) }),
          promptArtifactPath: intent.inputs.prompt.path,
          promptArtifactRoot: intent.inputs.prompt.root,
          promptFilePath: join(directory, "prompt.md"),
          route,
          runtimeRoot: intent.inputs.runtimeRoot,
          sessionDirectory: sessions,
          toolNames: Object.freeze([]),
          workspaceId: intent.inputs.workspaceId,
          workspacePath: workspace,
          workspaceRoot: intent.preconditions.expectedWorkspaceRoot,
        }),
      }),
      Object.freeze({
        allowedRoutes: Object.freeze([route]),
        routeVerifier: Object.freeze({
          verify: async () => Object.freeze({
            authType: "oauth" as const,
            kind: "verified" as const,
            model: "different-model",
            provider: route.provider,
          }),
        }),
      }),
    );
    const mismatchedVerification = await mismatchedVerificationAdapter.execute(launch);
    assert.equal(
      field(
        field(field(field(mismatchedVerification, "observation"), "result"), "diagnostic"),
        "code",
      ),
      "pi-route.verification-drift",
    );

    let extensionVerifierCalled = false;
    const extensionAdapter = new PiSessionAdapter(
      processes,
      Object.freeze({
        observeSealedRoot: async () => null,
        resolveLaunch: async (intent: LaunchChildSession) => Object.freeze({
          captureDirectory: captures,
          environment: Object.freeze({}),
          extensionPaths: Object.freeze([join(directory, "provider-replacement.js")]),
          maxStderrBytes: 1024,
          maxStdoutBytes: 1024,
          piCommand: Object.freeze({ executable: process.execPath, prefixArguments: Object.freeze([]) }),
          promptArtifactPath: intent.inputs.prompt.path,
          promptArtifactRoot: intent.inputs.prompt.root,
          promptFilePath: join(directory, "prompt.md"),
          route,
          runtimeRoot: intent.inputs.runtimeRoot,
          sessionDirectory: sessions,
          toolNames: Object.freeze([]),
          workspaceId: intent.inputs.workspaceId,
          workspacePath: workspace,
          workspaceRoot: intent.preconditions.expectedWorkspaceRoot,
        }),
      }),
      Object.freeze({
        allowedRoutes: Object.freeze([route]),
        routeVerifier: Object.freeze({
          verify: async () => {
            extensionVerifierCalled = true;
            return Object.freeze({
              authType: "oauth" as const,
              kind: "verified" as const,
              model: route.model,
              provider: route.provider,
            });
          },
        }),
      }),
    );
    const extensionRefused = await extensionAdapter.execute(launch);
    assert.equal(extensionVerifierCalled, false);
    assert.equal(
      field(field(field(field(extensionRefused, "observation"), "result"), "diagnostic"), "code"),
      "pi-session.route-extension",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("L7 production sources import no hidden timer or durable-write primitive", async () => {
  const sourcePaths = Object.freeze([
    join(process.cwd(), "adapters", "clock", "clock-adapter.ts"),
    join(process.cwd(), "adapters", "pi-session", "pi-session-adapter.ts"),
    join(process.cwd(), "adapters", "pi-session", "route-verifier.ts"),
    join(process.cwd(), "adapters", "process", "bounded-capture.ts"),
    join(process.cwd(), "adapters", "process", "process-adapter.ts"),
    join(process.cwd(), "adapters", "secrets", "secrets-adapter.ts"),
  ]);
  for (const path of sourcePaths) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /from\s+["']node:timers(?:\/promises)?["']/u, path);
    assert.doesNotMatch(
      source,
      /import[\s\S]*?\b(?:appendFile|createWriteStream|fdatasync|fsync|open|rename|writeFile)\b[\s\S]*?from\s+["']node:fs(?:\/promises)?["']/u,
      path,
    );
  }
});

test("all four adapter boundaries contain hostile unknown values without throwing", async () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const hostile = Object.freeze([
    null,
    undefined,
    Symbol("hostile"),
    cyclic,
    new Proxy({}, { get: () => { throw new Error("hostile getter"); } }),
  ]);
  const clockCreated = SystemClockAdapter.create();
  if (clockCreated.kind === "rejected") {
    throw new Error(clockCreated.diagnostic.code);
  }
  const secrets = new SecretsAdapter(Object.freeze({ isActive: () => false }));
  const piSession = new PiSessionAdapter(
    new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter),
    Object.freeze({
      resolveLaunch: async () => null,
      observeSealedRoot: async () => null,
    }),
  );
  for (const value of hostile) {
    assert.doesNotThrow(() => clockCreated.clock.execute(value));
    assert.doesNotThrow(() => secrets.execute(value));
    const processResult = await new ProcessAdapter(
      nodeFileCaptureSink,
      nodeProcessGraceWaiter,
    ).start(value);
    assert.equal(processResult.kind, "rejected");
    const piResult = await piSession.execute(value);
    assert.equal(piResult.kind, "rejected");
  }
});

test("clock normalizes an injected monotonic source and fails closed without a waiter", async () => {
  let nanoseconds = 0n;
  const created = SystemClockAdapter.create({
    monotonicNow: () => nanoseconds,
    sourceId: "controlled-monotonic",
    tickMilliseconds: 1,
  });
  if (created.kind === "rejected") {
    throw new Error(created.diagnostic.code);
  }
  assert.equal(created.kind, "created");
  const unavailableWait = await created.clock.waitUntil(1);
  assert.equal(unavailableWait.kind, "retry");
  if (unavailableWait.kind === "retry") {
    assert.equal(unavailableWait.diagnostic.code, "clock.waiter-unavailable");
  }
  const template = clockIntentCapsule.arbitrary.validForKind("observe-clock", 8401);
  assert.equal(template.kind, "observe-clock");
  if (template.kind !== "observe-clock") {
    throw new Error("clock template unavailable");
  }
  const intent = bindLawIntent("clock", Object.freeze({
    inputs: template.inputs,
    kind: "observe-clock",
    preconditions: Object.freeze({ notBeforeTick: 2 }),
    runId: template.runId,
  }));
  const waiting = created.clock.execute(intent);
  assert.equal(field(field(waiting, "observation"), "result") !== undefined, true);
  assert.equal(field(field(field(waiting, "observation"), "result"), "kind"), "retry");
  nanoseconds = 2_000_000n;
  const observed = created.clock.execute(intent);
  assert.equal(field(field(field(observed, "observation"), "result"), "kind"), "ok");
  assert.equal(field(field(field(field(observed, "observation"), "result"), "value"), "tick"), 2);
  nanoseconds = -1n;
  assert.equal(created.clock.now().kind, "retry");
});
