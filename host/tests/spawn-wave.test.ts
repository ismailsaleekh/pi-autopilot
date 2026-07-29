import { test } from "node:test";
import assert from "node:assert/strict";

import { applyAndRecord } from "../src/commands.ts";

function action(index: number) {
  return {
    action_id: `action-${index}`,
    assignment_id: `assignment-${index}`,
    kind: "launch-background",
    bg_run: {
      name: `wave ${index}`,
      command: `printf ${index}`,
      isAgent: true,
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    },
    run_revision: 10,
    supersession_state: "live",
  };
}

function ctx() {
  return { hasUI: false, mode: "json", ui: { notify() { throw new Error("no ui"); } } };
}

test("spawn_wave_launches_all_before_await_and_records_partial_failure", async () => {
  const actions = Array.from({ length: 7 }, (_, index) => action(index));
  const pending: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [];
  const runCalls: string[] = [];
  const remembered: Array<{ action: string; task: string }> = [];
  const transportCalls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const transport = {
    async request(kind: string, payload: Record<string, unknown>) {
      transportCalls.push({ kind, payload });
      return { v: 1, id: 200 + transportCalls.length, kind: "done", payload: { status: `ack:${String(payload.action_id)}` } };
    },
  };
  const promise = applyAndRecord(
    { v: 1, id: 1, kind: "spawn-wave", payload: { actions } } as never,
    ctx() as never,
    {
      transport: transport as never,
      operatorMessage: async () => {},
      onSpawn: async ({ action, task }) => remembered.push({ action: action.action_id, task: task.id }),
      backgroundTasks: {
        run(descriptor) {
          runCalls.push(descriptor.command);
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        },
      },
    } as never,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runCalls.length, 7, "every run must be invoked before any launch promise settles");
  assert.equal(pending.length, 7);

  for (let index = 0; index < pending.length; index += 1) {
    if (index === 3) pending[index].reject(new Error("controlled boom"));
    else pending[index].resolve({ id: `task-${index}`, command: actions[index].bg_run.command, name: actions[index].bg_run.name, status: "running", outputPath: `/tmp/${index}` });
  }

  await assert.rejects(promise, /spawn-wave launch failures/u);
  assert.equal(remembered.length, 6, "one failed launch must not discard six successful bindings");
  assert.deepEqual(remembered.map((item) => item.action), actions.filter((_, index) => index !== 3).map((item) => item.action_id));
  assert.equal(transportCalls.length, 7, "every launch settlement must be acknowledged");
  assert.equal(transportCalls.filter((call) => call.kind === "spawn-result" && call.payload.status === "launched").length, 6);
  assert.equal(transportCalls.filter((call) => call.kind === "spawn-result" && call.payload.status === "launch-failed").length, 1);
});
