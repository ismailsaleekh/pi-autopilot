import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  HostOwnershipCoordinator,
  canonicalJournalJson,
  OwnershipJournalError,
  ownershipJournalPath,
} from "../src/ownership-journal.ts";

const SESSION = "019faf00-0000-7000-8000-0000000000aa";

function action(id = "action-1", assignment = "assignment-1") {
  return {
    action_id: id,
    assignment_id: assignment,
    kind: "launch-background",
    bg_run: { name: "exact", command: "node exact", isAgent: true, notifyOnCompletion: true, triggerOnCompletion: false },
    run_revision: 1,
    supersession_state: "live",
  };
}
function task(id = "task-1", status = "running") {
  return { id, name: "exact", command: "node exact", status, outputPath: `/tmp/${id}`, isAgent: true, notifyOnCompletion: true, triggerOnCompletion: false };
}
function root() {
  const path = mkdtempSync(join(tmpdir(), "autopilot-ownership-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test("Host ownership journal fsyncs canonical launch/ack/tombstone rows and restores exact dedupe facts", () => {
  const state = root();
  try {
    const first = HostOwnershipCoordinator.open(state.path, SESSION);
    first.finishActivation([]);
    first.registerSuccessfulRun(action(), task());
    first.markLaunchAcknowledged(action(), task());
    first.recordTerminal(task("task-1", "killed"), action());
    const path = ownershipJournalPath(state.path, SESSION);
    const stat = lstatSync(path);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    const bytes = readFileSync(path, "utf8");
    assert.ok(bytes.endsWith("\n"));
    for (const line of bytes.trimEnd().split("\n")) assert.equal(line, canonicalJournalJson(JSON.parse(line)), "row is canonical");

    const reopened = HostOwnershipCoordinator.open(state.path, SESSION);
    assert.equal(reopened.ownership.length, 1);
    assert.equal(reopened.bindingForAction("action-1")?.task.id, "task-1");
    assert.equal(reopened.bindingForTask("task-1")?.terminal, true);
    assert.deepEqual(reopened.pendingAcknowledgements, []);
  } finally { state.cleanup(); }
});

test("unacknowledged successful runs replay exactly one launch ownership row", () => {
  const state = root();
  try {
    const first = HostOwnershipCoordinator.open(state.path, SESSION);
    first.finishActivation([]);
    first.registerSuccessfulRun(action(), task());
    const reopened = HostOwnershipCoordinator.open(state.path, SESSION);
    const pending = reopened.pendingAcknowledgements;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.task.id, "task-1");
    reopened.markLaunchAcknowledged(action(), task());
    assert.equal(reopened.pendingAcknowledgements.length, 0);
    assert.equal(readFileSync(ownershipJournalPath(state.path, SESSION), "utf8").match(/"kind":"launch"/gu)?.length, 1);
  } finally { state.cleanup(); }
});

test("Host ownership journal rejects truncation, duplicate rows, and a symlink without repair", () => {
  const state = root();
  try {
    const coordinator = HostOwnershipCoordinator.open(state.path, SESSION);
    coordinator.registerSuccessfulRun(action(), task());
    const path = ownershipJournalPath(state.path, SESSION);
    writeFileSync(path, readFileSync(path, "utf8").trimEnd(), "utf8");
    assert.throws(() => HostOwnershipCoordinator.open(state.path, SESSION), OwnershipJournalError);

    const wrongMode = root();
    try {
      const valid = HostOwnershipCoordinator.open(wrongMode.path, SESSION);
      valid.registerSuccessfulRun(action(), task());
      chmodSync(ownershipJournalPath(wrongMode.path, SESSION), 0o644);
      assert.throws(() => HostOwnershipCoordinator.open(wrongMode.path, SESSION), /0600|mode/u);
    } finally { wrongMode.cleanup(); }

    const other = root();
    try {
      mkdirSync(join(other.path, "host-ownership"), { mode: 0o700 });
      symlinkSync(path, ownershipJournalPath(other.path, SESSION));
      assert.throws(() => HostOwnershipCoordinator.open(other.path, SESSION), /journal|symlink|regular/u);
    } finally { other.cleanup(); }
  } finally { state.cleanup(); }
});

test("provisional blocked hold drains in-flight ownership, rejects post-hold launches, and restart begins fail-closed", async () => {
  const state = root();
  try {
    const coordinator = HostOwnershipCoordinator.open(state.path, SESSION);
    coordinator.finishActivation([]);
    const complete = coordinator.enterLaunch();
    let settled = false;
    const held = coordinator.acquireBlockedAdmission().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "BLOCKED snapshot waits through the run/journal boundary");
    assert.throws(() => coordinator.enterLaunch(), /closed/u);
    complete();
    await held;
    assert.equal(coordinator.hasPendingAdmission, true);
    const reopened = HostOwnershipCoordinator.open(state.path, SESSION);
    assert.throws(() => reopened.enterLaunch(), /closed/u, "every restart remains held through reconciliation");
    reopened.finishActivation([]);
    assert.doesNotThrow(() => reopened.enterLaunch());
  } finally { state.cleanup(); }
});

test("Host ownership journal refuses a duplicate action/task and never enumerates a task inventory", () => {
  const state = root();
  try {
    const coordinator = HostOwnershipCoordinator.open(state.path, SESSION);
    coordinator.finishActivation([]);
    coordinator.registerSuccessfulRun(action(), task());
    assert.throws(() => coordinator.registerSuccessfulRun(action(), task("other-task")), /action ownership conflict/u);
    assert.throws(() => coordinator.registerSuccessfulRun(action("other-action"), task()), /task ownership conflict/u);
    const rows = readFileSync(ownershipJournalPath(state.path, SESSION), "utf8").trimEnd().split("\n");
    assert.equal(rows.length, 1);
  } finally { state.cleanup(); }
});

test("production-shaped 0755 state root is accepted unchanged while symlink, foreign, and non-directory roots fail", () => {
  const state = root();
  const link = `${state.path}-link`;
  const file = `${state.path}-file`;
  try {
    chmodSync(state.path, 0o755);
    const coordinator = HostOwnershipCoordinator.open(state.path, SESSION);
    assert.equal(lstatSync(state.path).mode & 0o777, 0o755, "existing configured state root is never repaired");
    assert.equal(lstatSync(join(state.path, "host-ownership")).mode & 0o777, 0o700);
    assert.equal(coordinator.path, ownershipJournalPath(state.path, SESSION));

    symlinkSync(state.path, link);
    assert.throws(() => HostOwnershipCoordinator.open(link, SESSION), /state root|nonsymlink/u);
    writeFileSync(file, "not a directory", "utf8");
    assert.throws(() => HostOwnershipCoordinator.open(file, SESSION), /state root|directory/u);

    // /private/tmp is a system-owned exact directory in the supported Unix
    // runtime. Validation happens before any child path can be created.
    assert.notEqual(lstatSync("/private/tmp").uid, process.geteuid?.());
    assert.throws(() => HostOwnershipCoordinator.open("/private/tmp", SESSION), /state root|owner-controlled/u);
  } finally {
    rmSync(link, { force: true });
    rmSync(file, { force: true });
    state.cleanup();
  }
});

test("one coordinator rejects duplicate and conflicting multi-record reconciliation", () => {
  const state = root();
  try {
    const coordinator = HostOwnershipCoordinator.open(state.path, SESSION);
    coordinator.registerSuccessfulRun(action(), task());
    const directive = {
      receiptId: "receipt-1",
      reporterObserved: false,
      gate: {
        schema: "autopilot.child_control_blocked_gate.v1",
        latch_id: "latch-1",
        run_id: "run-1",
        cancellations: [{ task_id: "task-1", action_id: "action-1", assignment_id: "assignment-1", reporter: true }],
      },
    };
    coordinator.promoteBlockedGate(directive);
    assert.throws(() => coordinator.assertReconciliationCapacity([directive, directive]), /more than one whole-process gate/u);
    assert.throws(() => coordinator.assertReconciled([{ ...directive, receiptId: "receipt-2" }]), /lacks the exact durable Host gate/u);
  } finally { state.cleanup(); }
});

test("more than 128 normal rows and 1,000 explicit BLOCKED RETRY cycles never grow or exhaust the journal", async () => {
  const state = root();
  try {
    const coordinator = HostOwnershipCoordinator.open(state.path, SESSION);
    coordinator.finishActivation([]);
    for (let index = 0; index < 130; index += 1) {
      const item = action(`action-${index}`, `assignment-${index}`);
      const snapshot = task(`task-${index}`);
      coordinator.registerSuccessfulRun(item, snapshot);
      coordinator.markLaunchAcknowledged(item, snapshot);
    }
    const path = ownershipJournalPath(state.path, SESSION);
    const before = readFileSync(path);
    assert.ok(before.toString("utf8").trimEnd().split("\n").length > 128);
    for (let index = 0; index < 1000; index += 1) {
      await coordinator.acquireBlockedAdmission();
      coordinator.releaseBlockedAdmissionOnRetry();
    }
    assert.deepEqual(readFileSync(path), before, "provisional RETRY holds are in-memory scheduling only");
    assert.doesNotThrow(() => coordinator.enterLaunch());
  } finally { state.cleanup(); }
});
