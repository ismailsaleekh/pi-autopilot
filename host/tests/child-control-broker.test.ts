import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { test } from "node:test";

import {
  CHILD_CONTROL_BROKER_MAX_FRAME_BYTES,
  startChildControlBroker,
} from "../src/child-control-broker.ts";

function retryResponse(requestId: string) {
  return {
    schema: "autopilot.child_control_response.v1",
    request_id: requestId,
    outcome: "RETRY",
    diagnostic: { schema: "autopilot.submit_diagnostic.v1", code: "AUTOPILOT_SUBMIT_RETRY", error_count: 0, errors: [] },
  };
}

function request(requestId = "request-1") {
  return {
    schema: "autopilot.child_control_request.v1",
    request_id: requestId,
    token: "run-token",
    run_id: "run-1",
    assignment_id: "assignment-1",
    attempt: 1,
    tool_call_id: "call-1",
    kind: "submit",
    tool_name: "autopilot_submit_atoms",
    profile_id: "planning.task-atoms.v1:autopilot_submit_atoms",
    raw_payload: { absent_is_not_null: null, nested: ["raw"] },
  };
}

function framed(value: unknown, extra = Buffer.alloc(0)): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body, extra]);
}

async function exchange(path: string, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("connect", () => socket.end(bytes));
    socket.once("close", () => resolve(Buffer.concat(chunks)));
  });
}

test("ChildControlBroker creates one private fixed-root AF_UNIX socket and forwards one closed request", async () => {
  const calls: unknown[] = [];
  const broker = await startChildControlBroker({
    transport: {
      async request(kind, payload) {
        calls.push({ kind, payload });
        assert.equal(kind, "child-control");
        const child = payload as { request: { request_id: string } };
        return {
          v: 1,
          id: 1,
          kind: "child-control",
          payload: { response: retryResponse(child.request.request_id), blocked_gate: null },
        };
      },
    } as never,
  });

  try {
    assert.match(broker.socketPath, /^\/tmp\/\.pi-ap\/[0-9a-f]{10}\/s$/u);
    const socketStat = lstatSync(broker.socketPath);
    const directoryStat = lstatSync(broker.socketPath.slice(0, -2));
    assert.equal(socketStat.isSocket(), true);
    assert.equal(socketStat.uid, process.geteuid?.());
    assert.equal(socketStat.mode & 0o777, 0o600);
    assert.equal(directoryStat.isDirectory(), true);
    assert.equal(directoryStat.uid, process.geteuid?.());
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.match(broker.launchFacts.capability, /^[a-f0-9]{64}$/u);

    const input = request();
    const reply = await exchange(broker.socketPath, framed(input));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { kind: "child-control", payload: { request: input } });
    assert.equal(reply.readUInt32BE(0), reply.length - 4);
    assert.deepEqual(JSON.parse(reply.subarray(4).toString("utf8")), retryResponse(input.request_id));
  } finally {
    await broker.stop();
    await broker.stop();
  }

  assert.throws(() => lstatSync(broker.socketPath), /ENOENT/u, "stop removes only its verified socket");
});

test("ChildControlBroker rejects extra frames before Core and applies a blocked gate only after response write", async () => {
  const order: string[] = [];
  const blockedRequest = { ...request("blocked-request"), kind: "blocked", tool_name: "autopilot_report_blocked", profile_id: "autopilot.blocked_report.v1:autopilot_report_blocked" };
  const broker = await startChildControlBroker({
    transport: {
      async request(kind, payload) {
        order.push(`core:${kind}`);
        const child = payload as { request: { request_id: string } };
        return {
          v: 1,
          id: 2,
          kind: "child-control",
          payload: {
            response: {
              schema: "autopilot.child_control_response.v1",
              request_id: child.request.request_id,
              outcome: "ACCEPT",
              receipt: { kind: "blocked", schema: "autopilot.child_control_accept_receipt.v1", receipt: {} },
            },
            blocked_gate: {
              schema: "autopilot.child_control_blocked_gate.v1",
              latch_id: "latch-1",
              run_id: "run-1",
              cancellations: [{ task_id: "task-reporter", reporter: true }],
            },
          },
        };
      },
    } as never,
    async applyBlockedGate() {
      order.push("gate");
      return { async afterChildResponseWritten() { order.push("after-write"); } };
    },
  });

  try {
    const unknownField = await exchange(broker.socketPath, framed({ ...request("unknown"), unexpected: true }));
    assert.equal(unknownField.length, 0, "unknown wire fields close rather than reaching Core");
    const malformed = await exchange(broker.socketPath, framed(request("extra"), Buffer.from("extra")));
    assert.equal(malformed.length, 0, "extra data closes rather than producing a retry alias");
    assert.deepEqual(order, [], "malformed data never reaches Core");

    const reply = await exchange(broker.socketPath, framed(blockedRequest));
    assert.notEqual(reply.length, 0);
    assert.deepEqual(order, ["core:child-control", "gate", "after-write"]);
  } finally {
    await broker.stop();
  }
});

test("ChildControlBroker keeps the 4 MiB frame ceiling closed", async () => {
  const broker = await startChildControlBroker({ transport: { async request() { throw new Error("must not forward"); } } as never });
  try {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(CHILD_CONTROL_BROKER_MAX_FRAME_BYTES + 1, 0);
    assert.equal((await exchange(broker.socketPath, header)).length, 0);
  } finally {
    await broker.stop();
  }
});
