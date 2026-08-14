import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProcessAdapter } from "../../../adapters/process/index.js";
import { PI_ISOLATED_SETTINGS_TEXT, createPiCliSubscriptionRouteVerifier } from "../../../adapters/pi-session/index.js";
import { childIntentCapsule } from "../../../ports/contracts/child.capsule.js";
import { nodeFileCaptureSink, nodeProcessGraceWaiter, nodeProcessIdentityInspector } from "../process/node-process-capabilities.js";
import { NodeProbeDeadline } from "./node-probe-deadline.js";

const stubPiModule = fileURLToPath(new URL("./stub-pi.js", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autopilot-route-real-"));
  const agent = join(root, "agent");
  const captures = join(root, "captures");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(agent, { mode: 0o700 }), mkdir(captures), mkdir(workspace)]);
  await Promise.all([
    writeFile(join(agent, "auth.json"), "{}\n", { mode: 0o600 }),
    writeFile(join(agent, "settings.json"), PI_ISOLATED_SETTINGS_TEXT, { mode: 0o600 }),
  ]);
  const config = join(root, "stub.json");
  await writeFile(config, "{\"seal\":null,\"terminal\":{\"atMilliseconds\":0,\"code\":0,\"kind\":\"exit\"},\"writes\":[]}\n");
  const processAdapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter, nodeProcessIdentityInspector);
  const verifier = createPiCliSubscriptionRouteVerifier(processAdapter, new NodeProbeDeadline());
  const template = childIntentCapsule.arbitrary.validForKind("verify-pi-route", 9001);
  assert.equal(template.kind, "verify-pi-route");
  if (template.kind !== "verify-pi-route") throw new Error("route template failed");
  const route = Object.freeze({ ...template.inputs.route, toolBundleAttestation: null });
  const environment = Object.freeze({
    HOME: root,
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    PI_CODING_AGENT_DIR: agent,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
  const request = Object.freeze({
    captureDirectory: captures,
    captureId: template.inputs.captureId,
    command: Object.freeze({ executable: process.execPath, prefixArguments: Object.freeze([stubPiModule, "--stub-config", config]) }),
    cwd: workspace,
    environment,
    route,
  });
  return Object.freeze({ root, agent, verifier, request });
}

test("shell-free Pi route probe proves an OAuth subscription route", { timeout: 15_000 }, async () => {
  const value = await fixture();
  try {
    const observed = await value.verifier.verify(value.request);
    assert.deepEqual(observed, Object.freeze({ authType: "oauth", kind: "verified", model: value.request.route.model, provider: value.request.route.provider }));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("route guard refuses metered credential environment before process launch", async () => {
  const value = await fixture();
  try {
    const observed = await value.verifier.verify(Object.freeze({
      ...value.request,
      environment: Object.freeze({ ...value.request.environment, OPENAI_API_KEY: "must-not-cross" }),
    }));
    assert.equal(observed.kind, "refused");
    if (observed.kind === "refused") assert.equal(observed.code, "pi-route.environment-key");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("route guard fails closed when isolated Pi settings drift", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.agent, "settings.json"), "{}\n", { mode: 0o600 });
    const observed = await value.verifier.verify(value.request);
    assert.equal(observed.kind, "refused");
    if (observed.kind === "refused") assert.equal(observed.code, "pi-route.agent-directory-content");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
