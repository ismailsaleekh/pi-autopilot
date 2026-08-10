import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import {
  CHILD_CONTROL_TOOL_METADATA,
  createChildControlBridge,
  createEnvironmentChildControlBridge,
} from "../src/generated/child-control-bridge.ts";
import { startChildControlBroker } from "../src/child-control-broker.ts";

const CONTROL_ENV = [
  "AUTOPILOT_CONTROL_SOCK",
  "AUTOPILOT_CONTROL_TOKEN",
  "AUTOPILOT_CONTROL_RUN_ID",
  "AUTOPILOT_CONTROL_ASSIGNMENT",
  "AUTOPILOT_CONTROL_ATTEMPT",
] as const;
const evidence = {
  schema: "autopilot.child_control_runtime_evidence.v1",
  delivery_policy_denials: null,
  approved_command_executions: null,
} as const;

function accept(requestId: string, kind: "submit" | "blocked" = "submit") {
  return {
    schema: "autopilot.child_control_response.v1",
    request_id: requestId,
    outcome: "ACCEPT",
    receipt: {
      kind,
      schema: "autopilot.child_control_accept_receipt.v1",
      receipt: {},
    },
  };
}

function fixedRetry(error: unknown, code: string): void {
  assert(error instanceof Error);
  const diagnostic = JSON.parse(error.message);
  assert.equal(diagnostic.schema, "autopilot.submit_diagnostic.v1");
  assert.equal(diagnostic.code, "AUTOPILOT_SUBMIT_RETRY");
  assert.equal(diagnostic.error_count, 1);
  assert.equal(diagnostic.errors[0].code, `child-control.${code}`);
  assert.equal(diagnostic.errors[0].actual.redacted, true);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value)!;
}

function injectedBridge(requests: unknown[]) {
  return createChildControlBridge({
    token: "a".repeat(64), run_id: "run-1", assignment_id: "assignment-1", attempt: 1,
  }, {
    async request(request) {
      requests.push(request);
      return accept(request.request_id, request.kind);
    },
  });
}

test("generated bridge preserves every profile raw tree and correlates reversed calls by nonce", async () => {
  assert.equal(CHILD_CONTROL_TOOL_METADATA.length, 15);
  assert.equal(CHILD_CONTROL_TOOL_METADATA.filter((tool) => tool.kind === "submit").length, 14);
  const requests: Array<Record<string, unknown>> = [];
  const bridge = injectedBridge(requests);
  const first = CHILD_CONTROL_TOOL_METADATA[1]!;
  const second = CHILD_CONTROL_TOOL_METADATA[2]!;
  const rawFirst = { null_value: null, nested: [{ value: "first" }] };
  const rawSecond = ["malformed-top-level", { value: "second" }];
  const firstPlaceholder = bridge.prepareArguments(first.profile_id, rawFirst);
  const secondPlaceholder = bridge.prepareArguments(second.profile_id, rawSecond);

  await bridge.execute("call-second", secondPlaceholder, evidence);
  await bridge.execute("call-first", firstPlaceholder, evidence);

  assert.deepEqual(requests.map((request) => request.raw_payload), [rawSecond, rawFirst]);
  assert.equal(Object.hasOwn(requests[1]!.raw_payload as object, "absent"), false);
  assert.equal((requests[1]!.raw_payload as { null_value: unknown }).null_value, null);
  assert.deepEqual(requests.map((request) => request.tool_call_id), ["call-second", "call-first"]);
  assert.deepEqual(requests.map((request) => request.runtime_evidence), [evidence, evidence]);
});

test("generated bridge returns fixed RETRY diagnostics for placeholder, nonce, and duplicate-call faults", async () => {
  const metadata = CHILD_CONTROL_TOOL_METADATA[1]!;
  {
    const bridge = injectedBridge([]);
    const placeholder = bridge.prepareArguments(metadata.profile_id, {});
    placeholder.tampered = true;
    await assert.rejects(bridge.execute("tampered", placeholder, evidence), (error) => {
      fixedRetry(error, "placeholder"); return true;
    });
  }
  {
    const bridge = injectedBridge([]);
    const placeholder = bridge.prepareArguments(metadata.profile_id, {});
    await bridge.execute("once", placeholder, evidence);
    await assert.rejects(bridge.execute("twice", placeholder, evidence), (error) => {
      fixedRetry(error, "nonce"); return true;
    });
  }
  {
    const bridge = injectedBridge([]);
    const first = bridge.prepareArguments(metadata.profile_id, {});
    const second = bridge.prepareArguments(metadata.profile_id, {});
    await bridge.execute("same-call", first, evidence);
    await assert.rejects(bridge.execute("same-call", second, evidence), (error) => {
      fixedRetry(error, "nonce"); return true;
    });
  }
});

test("generated bridge throws the canonical Core RETRY diagnostic unchanged", async () => {
  const diagnostic = {
    schema: "autopilot.submit_diagnostic.v1",
    code: "AUTOPILOT_SUBMIT_RETRY",
    error_count: 1,
    errors: [{ index: 0, code: "core.value", pointer: "/x", expected: "value", actual: { preview: "x", redacted: false, truncated: false, sha256: "a".repeat(64), byte_count: 1, item_count: 1 }, fix: "Retry." }],
  };
  const bridge = createChildControlBridge({
    token: "a".repeat(64), run_id: "run-1", assignment_id: "assignment-1", attempt: 1,
  }, {
    async request(request) {
      return { schema: "autopilot.child_control_response.v1", request_id: request.request_id, outcome: "RETRY", diagnostic };
    },
  });
  const placeholder = bridge.prepareArguments(CHILD_CONTROL_TOOL_METADATA[1]!.profile_id, {});
  await assert.rejects(bridge.execute("core-retry", placeholder, evidence), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, canonicalJson(diagnostic));
    return true;
  });
});

test("generated environment reader rejects absent, partial, empty, and malformed five-variable bindings", { concurrency: false }, async () => {
  for (const patch of [
    {},
    { AUTOPILOT_CONTROL_SOCK: "/tmp/.pi-ap/0000000000/s" },
    { AUTOPILOT_CONTROL_SOCK: "", AUTOPILOT_CONTROL_TOKEN: "a".repeat(64), AUTOPILOT_CONTROL_RUN_ID: "run-1", AUTOPILOT_CONTROL_ASSIGNMENT: "assignment-1", AUTOPILOT_CONTROL_ATTEMPT: "1" },
    { AUTOPILOT_CONTROL_SOCK: "/tmp/not-a-capability", AUTOPILOT_CONTROL_TOKEN: "A".repeat(64), AUTOPILOT_CONTROL_RUN_ID: "bad space", AUTOPILOT_CONTROL_ASSIGNMENT: "assignment-1", AUTOPILOT_CONTROL_ATTEMPT: "0" },
  ]) {
    await withPatchedControlEnvironment(patch, async () => {
      const bridge = createEnvironmentChildControlBridge();
      const placeholder = bridge.prepareArguments(CHILD_CONTROL_TOOL_METADATA[1]!.profile_id, {});
      await assert.rejects(bridge.execute("invalid-binding", placeholder, evidence), (error) => {
        fixedRetry(error, "transport"); return true;
      });
    });
  }
});

test("generated AF_UNIX client sends separate runtime evidence and receives receipt-only ACCEPT", { concurrency: false }, async () => {
  const forwarded: Array<Record<string, unknown>> = [];
  const broker = await startChildControlBroker({
    transport: {
      async request(_kind, payload) {
        const request = (payload as { request: Record<string, unknown> }).request;
        forwarded.push(request);
        return { v: 1, id: 1, kind: "child-control", payload: { response: accept(request.request_id as string), blocked_gate: null } };
      },
    } as never,
  });
  await withControlEnvironment(broker.socketPath, async () => {
    const bridge = createEnvironmentChildControlBridge();
    const placeholder = bridge.prepareArguments(CHILD_CONTROL_TOOL_METADATA[1]!.profile_id, { raw: null });
    const receipt = await bridge.execute("socket-accept", placeholder, evidence);
    assert.deepEqual(receipt, { kind: "submit", schema: "autopilot.child_control_accept_receipt.v1", receipt: {} });
  });
  try {
    assert.deepEqual(forwarded[0]!.raw_payload, { raw: null });
    assert.deepEqual(forwarded[0]!.runtime_evidence, evidence);
    assert.equal("payload" in (forwarded[0]!.runtime_evidence as object), false);
  } finally {
    await broker.stop();
  }
});

test("generated AF_UNIX client rejects unavailable, truncated, extra, malformed, and unknown responses", { concurrency: false }, async () => {
  const unavailable = "/tmp/.pi-ap/0000000000/s";
  await withControlEnvironment(unavailable, async () => {
    const bridge = createEnvironmentChildControlBridge();
    const placeholder = bridge.prepareArguments(CHILD_CONTROL_TOOL_METADATA[1]!.profile_id, {});
    await assert.rejects(bridge.execute("unavailable", placeholder, evidence), (error) => {
      fixedRetry(error, "transport"); return true;
    });
  });

  for (const [label, reply] of [
    ["truncated", framed(Buffer.from("{}"), 12)],
    ["extra", Buffer.concat([framedJson(accept("wrong")), Buffer.from("extra")])],
    ["malformed", framed(Buffer.from("not-json"))],
    ["unknown", framedJson({ schema: "autopilot.child_control_response.v1", request_id: "wrong", outcome: "FATAL" })],
  ] as const) {
    const socket = await rawSocket(reply);
    try {
      await withControlEnvironment(socket.path, async () => {
        const bridge = createEnvironmentChildControlBridge();
        const placeholder = bridge.prepareArguments(CHILD_CONTROL_TOOL_METADATA[1]!.profile_id, {});
        await assert.rejects(bridge.execute(`socket-${label}`, placeholder, evidence), (error) => {
          fixedRetry(error, "protocol"); return true;
        });
      });
    } finally {
      await socket.stop();
    }
  }
});

async function withControlEnvironment<T>(socketPath: string, action: () => Promise<T>): Promise<T> {
  return withPatchedControlEnvironment({
    AUTOPILOT_CONTROL_SOCK: socketPath,
    AUTOPILOT_CONTROL_TOKEN: "a".repeat(64),
    AUTOPILOT_CONTROL_RUN_ID: "run-1",
    AUTOPILOT_CONTROL_ASSIGNMENT: "assignment-1",
    AUTOPILOT_CONTROL_ATTEMPT: "1",
  }, action);
}

async function withPatchedControlEnvironment<T>(patch: Record<string, string>, action: () => Promise<T>): Promise<T> {
  const prior = new Map(CONTROL_ENV.map((key) => [key, process.env[key]]));
  for (const key of CONTROL_ENV) delete process.env[key];
  Object.assign(process.env, patch);
  try {
    return await action();
  } finally {
    for (const key of CONTROL_ENV) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function framed(body: Buffer, declared = body.length): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(declared, 0);
  return Buffer.concat([header, body]);
}

function framedJson(value: unknown): Buffer {
  return framed(Buffer.from(JSON.stringify(value), "utf8"));
}

async function rawSocket(reply: Buffer): Promise<{ path: string; stop(): Promise<void> }> {
  const directory = join("/tmp/.pi-ap", randomBytes(5).toString("hex"));
  const socketPath = join(directory, "s");
  mkdirSync(directory, { mode: 0o700 });
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.once("data", () => socket.end(reply));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return {
    path: socketPath,
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
