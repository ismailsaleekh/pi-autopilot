import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appendCommittedBatch,
  closeJournal,
  crc32c,
  openJournal,
  openJournalReadOnly,
  replayJournal,
} from "../../../storage/journal/index.js";
import type {
  JournalDurabilityObserver,
  JournalWriterHandle,
} from "../../../storage/journal/index.js";
import type { JournalRecord } from "../../../authority/protocol/journal-record.capsule.js";
import {
  JOURNAL_GENESIS_HASH,
  encodeFrame,
} from "../../../storage/journal/wire.js";
import {
  canonicalDecisionFactsDigest,
  decisionFactsMatchRoot,
  journalRecordCapsule,
} from "../../../authority/protocol/journal-record.capsule.js";

const childModule = fileURLToPath(new URL("./journal-child.js", import.meta.url));

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    return Reflect.get(value, name);
  } catch {
    return undefined;
  }
}

function messageEvent(value: unknown): string | null {
  const event = field(value, "event");
  return typeof event === "string" ? event : null;
}

function waitForMessage(
  child: ChildProcess,
  event: string,
  timeoutMilliseconds: number = 15_000,
): Promise<unknown> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error(`timed out waiting for child event ${event}`));
    }, timeoutMilliseconds);
    const onMessage = (message: unknown): void => {
      if (messageEvent(message) === event) {
        cleanup();
        resolveMessage(message);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectMessage(new Error(`child exited before ${event}: code=${String(code)} signal=${String(signal)}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    child.once("exit", () => resolveExit());
  });
}

function spawnJournalChild(args: readonly string[], environment?: NodeJS.ProcessEnv): ChildProcess {
  return fork(childModule, args, {
    env: environment ?? process.env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

async function killAtPoint(
  journalDir: string,
  point: string,
  frameType: "any" | "control" | "record",
  appendAfterOpen: boolean,
  seed: number,
): Promise<void> {
  const child = spawnJournalChild([
    "kill-window",
    journalDir,
    point,
    frameType,
    appendAfterOpen ? "append" : "open-only",
    String(seed),
  ]);
  try {
    await waitForMessage(child, "point");
    assert.equal(child.kill("SIGKILL"), true);
    await waitForExit(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function recordForSeed(seed: number, kind?: JournalRecord["kind"]): JournalRecord {
  const record = kind === undefined
    ? journalRecordCapsule.arbitrary.valid(seed)
    : journalRecordCapsule.arbitrary.validForKind(kind, seed);
  if (record.kind !== "decision-committed") {
    return record;
  }
  const encoded = journalRecordCapsule.encodeUnknown(Object.freeze({
    ...record,
    factRoot: canonicalDecisionFactsDigest(record.facts),
  }));
  if (encoded.kind === "error") {
    throw new Error(encoded.error.diagnostic);
  }
  assert.equal(encoded.kind, "ok");
  const decoded = journalRecordCapsule.decodeCanonical(encoded.value);
  if (decoded.kind === "error") {
    throw new Error(decoded.error.diagnostic);
  }
  assert.equal(decoded.kind, "ok");
  return decoded.value;
}

async function acquired(journalDir: string): Promise<JournalWriterHandle> {
  const opened = await openJournal(journalDir);
  if (opened.kind !== "acquired") {
    throw new Error(`journal open failed: ${opened.kind}`);
  }
  assert.equal(opened.kind, "acquired");
  return opened.handle;
}

async function replayRecords(journalDir: string): Promise<readonly JournalRecord[]> {
  const replay = replayJournal(journalDir);
  const records: JournalRecord[] = [];
  for await (const record of replay) {
    records.push(record);
  }
  const completion = await replay.completion;
  if (completion.kind === "error") {
    throw new Error(completion.error.message);
  }
  assert.deepEqual(completion, { kind: "complete", recordCount: records.length });
  return Object.freeze(records);
}

async function seedJournal(journalDir: string, seed: number): Promise<JournalRecord> {
  const handle = await acquired(journalDir);
  const record = recordForSeed(seed, "run-genesis");
  const appended = await appendCommittedBatch(handle, record);
  assert.equal(appended.kind, "acknowledged");
  assert.equal((await closeJournal(handle)).kind, "closed");
  return record;
}

function segmentPath(journalDir: string, epoch: number): string {
  return join(
    journalDir,
    "segments",
    `journal.${String(epoch).padStart(20, "0")}.log`,
  );
}

function canonicalBytes(record: JournalRecord): Buffer {
  return Buffer.from(journalRecordCapsule.encode(record));
}

async function replayDigestInChild(
  journalDir: string,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const child = spawnJournalChild(["replay-digest", journalDir], environment);
  try {
    const message = await waitForMessage(child, "replay");
    await waitForExit(child);
    return message;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

test("wire v1 CRC32C vector and append/replay property preserve canonical records", async () => {
  assert.equal(crc32c(Buffer.from("123456789", "ascii")), 0xe306_9283);
  const journalDir = await temporaryDirectory("autopilot-journal-property-");
  try {
    const handle = await acquired(journalDir);
    const expected: JournalRecord[] = [];
    const appends: Array<Promise<unknown>> = [];
    for (let seed = 0; seed < 48; seed += 1) {
      const record = recordForSeed(seed);
      expected.push(record);
      appends.push(appendCommittedBatch(handle, record));
    }
    const outcomes = await Promise.all(appends);
    assert.equal(outcomes.every((outcome) => field(outcome, "kind") === "acknowledged"), true);
    await closeJournal(handle);
    const wire = await readFile(segmentPath(journalDir, 1));
    const firstRecord = expected[0];
    assert.ok(firstRecord !== undefined);
    const firstPayload = canonicalBytes(firstRecord);
    assert.equal(wire.readUInt32BE(0), firstPayload.byteLength);
    assert.equal(wire.readUInt32BE(4), crc32c(firstPayload));
    assert.equal(wire[40], 1);
    assert.deepEqual(wire.subarray(41, 41 + firstPayload.byteLength), firstPayload);
    assert.deepEqual(
      wire.subarray(8, 40),
      encodeFrame(JOURNAL_GENESIS_HASH, 1, firstPayload).chainHash,
    );
    const cancelled = replayJournal(journalDir);
    for await (const ignored of cancelled) {
      assert.ok(ignored.kind.length > 0);
      break;
    }
    const cancelledCompletion = await cancelled.completion;
    assert.equal(cancelledCompletion.kind, "error");
    if (cancelledCompletion.kind === "error") {
      assert.equal(cancelledCompletion.error.code, "invalid-argument");
    }
    const actual = await replayRecords(journalDir);
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      const left = actual[index];
      const right = expected[index];
      assert.ok(left !== undefined && right !== undefined);
      assert.deepEqual(canonicalBytes(left), canonicalBytes(right));
    }
  } finally {
    await rm(journalDir, { force: true, recursive: true });
  }
});

test("DecisionCommitted facts/factRoot mismatch is rejected before append and on replay", async () => {
  const journalDir = await temporaryDirectory("autopilot-journal-facts-");
  try {
    const mismatch = journalRecordCapsule.arbitrary.validForKind("decision-committed", 777);
    assert.equal(mismatch.kind, "decision-committed");
    if (mismatch.kind !== "decision-committed") {
      throw new Error("arbitrary did not produce DecisionCommitted");
    }
    assert.equal(decisionFactsMatchRoot(mismatch), false);
    const handle = await acquired(journalDir);
    const rejected = await appendCommittedBatch(handle, mismatch);
    assert.equal(rejected.kind, "rejected");
    if (rejected.kind === "rejected") {
      assert.equal(rejected.error.code, "decision-fact-root-mismatch");
      assert.equal(rejected.error.disposition, "feedback");
    }
    await closeJournal(handle);
    assert.equal((await replayRecords(journalDir)).length, 0);

    const payload = journalRecordCapsule.encode(mismatch);
    const frame = encodeFrame(JOURNAL_GENESIS_HASH, 1, payload);
    await writeFile(segmentPath(journalDir, 1), frame.bytes);
    const replayed = replayJournal(journalDir);
    for await (const ignored of replayed) {
      assert.fail(`mismatched facts replayed ${ignored.kind}`);
    }
    const completion = await replayed.completion;
    assert.equal(completion.kind, "error");
    if (completion.kind === "error") {
      assert.equal(completion.error.code, "decision-fact-root-mismatch");
    }
  } finally {
    await rm(journalDir, { force: true, recursive: true });
  }
});

test("oversize JournalRecord receives CAS-directed typed feedback", async () => {
  const journalDir = await temporaryDirectory("autopilot-journal-oversize-");
  try {
    const template = recordForSeed(2, "run-genesis");
    assert.equal(template.kind, "run-genesis");
    if (template.kind !== "run-genesis") {
      throw new Error("arbitrary did not produce RunGenesis");
    }
    const encoded = journalRecordCapsule.encodeUnknown(Object.freeze({
      ...template,
      repositoryBase: `revision-${"x".repeat(1024 * 1024)}`,
    }));
    if (encoded.kind === "error") {
      throw new Error(encoded.error.diagnostic);
    }
    assert.equal(encoded.kind, "ok");
    const decoded = journalRecordCapsule.decodeCanonical(encoded.value);
    if (decoded.kind === "error") {
      throw new Error(decoded.error.diagnostic);
    }
    assert.equal(decoded.kind, "ok");
    const handle = await acquired(journalDir);
    const outcome = await appendCommittedBatch(handle, decoded.value);
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") {
      assert.equal(outcome.error.code, "record-too-large");
      assert.match(outcome.error.message, /CAS/);
    }
    await closeJournal(handle);
  } finally {
    await rm(journalDir, { force: true, recursive: true });
  }
});

test("read-only opener creates nothing and its epoch snapshot is stale by design", async () => {
  const parent = await temporaryDirectory("autopilot-journal-readonly-");
  const journalDir = join(parent, "absent");
  try {
    const absent = await openJournalReadOnly(journalDir);
    assert.equal(absent.kind, "error");
    await assert.rejects(lstat(journalDir), { code: "ENOENT" });
    const first = await acquired(journalDir);
    const observer = await openJournalReadOnly(journalDir);
    assert.equal(observer.kind, "opened");
    const firstEpoch = first.epoch;
    await closeJournal(first);
    const second = await acquired(journalDir);
    assert.notEqual(second.epoch, firstEpoch);
    await closeJournal(second);
    if (observer.kind === "opened") {
      assert.equal(observer.journal.currentEpoch(), firstEpoch);
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("real SIGKILL acquisition windows retain every acknowledged prefix", async (context) => {
  const points = [
    "claim-created",
    "segment-before-first-frame",
    "frame-mid-write",
    "frame-written",
    "frame-datasynced",
  ];
  for (const point of points) {
    await context.test(point, async () => {
      const journalDir = await temporaryDirectory(`autopilot-journal-kill-${point}-`);
      try {
        const seed = await seedJournal(journalDir, 100);
        const frameType = point.startsWith("frame-") ? "control" : "any";
        await killAtPoint(journalDir, point, frameType, false, 0);
        const recovery = await acquired(journalDir);
        await closeJournal(recovery);
        const records = await replayRecords(journalDir);
        assert.deepEqual(records.map((record) => journalRecordCapsule.digest(record)), [
          journalRecordCapsule.digest(seed),
        ]);
      } finally {
        await rm(journalDir, { force: true, recursive: true });
      }
    });
  }
});

test("real SIGKILL append windows are prefix-safe and post-fdatasync record survives", async (context) => {
  const points = ["frame-mid-write", "frame-written", "frame-datasynced"];
  for (const point of points) {
    await context.test(point, async () => {
      const journalDir = await temporaryDirectory(`autopilot-journal-append-kill-${point}-`);
      try {
        const seed = await seedJournal(journalDir, 200);
        const childRecord = recordForSeed(201, "run-genesis");
        await killAtPoint(journalDir, point, "record", true, 201);
        const recovery = await acquired(journalDir);
        await closeJournal(recovery);
        const records = await replayRecords(journalDir);
        const digests = records.map((record) => journalRecordCapsule.digest(record));
        assert.equal(digests[0], journalRecordCapsule.digest(seed));
        assert.ok(digests.length === 1 || digests.length === 2);
        if (point === "frame-datasynced") {
          assert.deepEqual(digests, [
            journalRecordCapsule.digest(seed),
            journalRecordCapsule.digest(childRecord),
          ]);
        }
      } finally {
        await rm(journalDir, { force: true, recursive: true });
      }
    });
  }
});

test("N processes racing one scanned epoch produce one winner and typed contenders", async () => {
  const journalDir = await temporaryDirectory("autopilot-journal-contention-");
  const children: ChildProcess[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      children.push(spawnJournalChild(["contend", journalDir, String(300 + index)]));
    }
    await Promise.all(children.map((child) => waitForMessage(child, "ready")));
    const finished = children.map((child) => waitForMessage(child, "finished"));
    for (const child of children) {
      child.send(Object.freeze({ command: "go" }));
    }
    const outcomes = await Promise.all(finished);
    await Promise.all(children.map(waitForExit));
    assert.equal(outcomes.filter((value) => field(value, "kind") === "acquired").length, 1);
    assert.equal(outcomes.filter((value) => field(value, "kind") === "contended").length, 7);
    const records = await replayRecords(journalDir);
    assert.equal(records.length, 1);
    assert.equal((await readFile(segmentPath(journalDir, 1))).byteLength > 0, true);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    await rm(journalDir, { force: true, recursive: true });
  }
});

test("fencing crown jewel: stopped A late-appends only dead fork bytes beyond B cut", async () => {
  const journalDir = await temporaryDirectory("autopilot-journal-fencing-");
  const stale = spawnJournalChild(["stale-writer", journalDir, "401"]);
  try {
    const acquiredMessage = await waitForMessage(stale, "acquired");
    assert.equal(field(acquiredMessage, "epoch"), "00000000000000000001");
    assert.equal(stale.kill("SIGSTOP"), true);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    const successor = await acquired(journalDir);
    assert.equal(successor.epoch, "00000000000000000002");
    const successorRecord = recordForSeed(402, "run-genesis");
    assert.equal((await appendCommittedBatch(successor, successorRecord)).kind, "acknowledged");
    await closeJournal(successor);

    const staleFinished = waitForMessage(stale, "finished");
    stale.send(Object.freeze({ command: "append" }));
    assert.equal(stale.kill("SIGCONT"), true);
    const staleOutcome = await staleFinished;
    assert.equal(field(staleOutcome, "kind"), "rejected");
    assert.equal(field(staleOutcome, "code"), "superseded");
    await waitForExit(stale);

    const records = await replayRecords(journalDir);
    assert.deepEqual(records.map((record) => journalRecordCapsule.digest(record)), [
      journalRecordCapsule.digest(successorRecord),
    ]);
    const aBytes = await readFile(segmentPath(journalDir, 1));
    const bBytes = await readFile(segmentPath(journalDir, 2));
    assert.ok(aBytes.byteLength > 0);
    const controlLength = bBytes.readUInt32BE(0);
    const control = JSON.parse(
      bBytes.subarray(41, 41 + controlLength).toString("utf8"),
    );
    const cuts = field(control, "cuts");
    assert.ok(Array.isArray(cuts));
    assert.equal(field(Array.isArray(cuts) ? cuts[0] : null, "observedByteLength"), "00000000000000000000");
    const aPayloadLength = aBytes.readUInt32BE(0);
    const aPayload = aBytes.subarray(41, 41 + aPayloadLength);
    const aStoredHash = aBytes.subarray(8, 40);
    const bStoredHash = bBytes.subarray(8, 40);
    assert.deepEqual(aStoredHash, encodeFrame(JOURNAL_GENESIS_HASH, 1, aPayload).chainHash);
    assert.notDeepEqual(aStoredHash, bStoredHash);
    assert.notDeepEqual(aStoredHash, encodeFrame(bStoredHash, 1, aPayload).chainHash);
  } finally {
    if (stale.exitCode === null && stale.signalCode === null) {
      stale.kill("SIGKILL");
    }
    await rm(journalDir, { force: true, recursive: true });
  }
});

test("nonzero successor cut preserves A's accepted prefix and rejects A's late fork", async () => {
  const journalDir = await temporaryDirectory("autopilot-journal-nonzero-cut-");
  try {
    const first = await acquired(journalDir);
    const firstAccepted = recordForSeed(450, "run-genesis");
    assert.equal((await appendCommittedBatch(first, firstAccepted)).kind, "acknowledged");
    const successor = await acquired(journalDir);
    const successorAccepted = recordForSeed(451, "run-genesis");
    assert.equal((await appendCommittedBatch(successor, successorAccepted)).kind, "acknowledged");
    const staleLate = recordForSeed(452, "run-genesis");
    const staleResult = await appendCommittedBatch(first, staleLate);
    assert.equal(staleResult.kind, "rejected");
    if (staleResult.kind === "rejected") {
      assert.equal(staleResult.error.code, "superseded");
    }
    const third = await acquired(journalDir);
    const thirdAccepted = recordForSeed(453, "run-genesis");
    assert.equal((await appendCommittedBatch(third, thirdAccepted)).kind, "acknowledged");
    await closeJournal(first);
    await closeJournal(successor);
    await closeJournal(third);
    const records = await replayRecords(journalDir);
    assert.deepEqual(records.map((record) => journalRecordCapsule.digest(record)), [
      journalRecordCapsule.digest(firstAccepted),
      journalRecordCapsule.digest(successorAccepted),
      journalRecordCapsule.digest(thirdAccepted),
    ]);
    const successorBytes = await readFile(segmentPath(journalDir, 2));
    const controlLength = successorBytes.readUInt32BE(0);
    const control = JSON.parse(
      successorBytes.subarray(41, 41 + controlLength).toString("utf8"),
    );
    const cuts = field(control, "cuts");
    const cutText = field(Array.isArray(cuts) ? cuts[0] : null, "observedByteLength");
    assert.equal(typeof cutText, "string");
    const earliestCut = BigInt(typeof cutText === "string" ? cutText : "0");
    assert.equal(earliestCut > 0n, true);
    const thirdBytes = await readFile(segmentPath(journalDir, 3));
    const thirdControlLength = thirdBytes.readUInt32BE(0);
    const thirdControl = JSON.parse(
      thirdBytes.subarray(41, 41 + thirdControlLength).toString("utf8"),
    );
    const laterCuts = field(thirdControl, "cuts");
    const laterCutText = field(
      Array.isArray(laterCuts) ? laterCuts[0] : null,
      "observedByteLength",
    );
    assert.equal(typeof laterCutText, "string");
    assert.equal(
      BigInt(typeof laterCutText === "string" ? laterCutText : "0") > earliestCut,
      true,
    );
  } finally {
    await rm(journalDir, { force: true, recursive: true });
  }
});

test("torn tail is ignored, recovery truncation is crash-idempotent", async () => {
  const journalDir = await temporaryDirectory("autopilot-journal-torn-");
  try {
    const handle = await acquired(journalDir);
    const records = [recordForSeed(500), recordForSeed(501)];
    for (const record of records) {
      assert.equal((await appendCommittedBatch(handle, record)).kind, "acknowledged");
    }
    await closeJournal(handle);
    const validSize = (await stat(segmentPath(journalDir, 1))).size;
    await appendFile(segmentPath(journalDir, 1), Buffer.alloc(13, 0xa5));
    assert.equal((await replayRecords(journalDir)).length, records.length);

    await killAtPoint(journalDir, "tail-truncated", "any", false, 0);
    const recovery = await acquired(journalDir);
    await closeJournal(recovery);
    assert.equal((await stat(segmentPath(journalDir, 1))).size, validSize);
    const replayed = await replayRecords(journalDir);
    assert.deepEqual(
      replayed.map((record) => journalRecordCapsule.digest(record)),
      records.map((record) => journalRecordCapsule.digest(record)),
    );
  } finally {
    await rm(journalDir, { force: true, recursive: true });
  }
});

test("interior corruption and nonzero cut to missing segment fail loudly", async (context) => {
  await context.test("interior CRC corruption", async () => {
    const journalDir = await temporaryDirectory("autopilot-journal-corruption-");
    try {
      const handle = await acquired(journalDir);
      for (let seed = 600; seed < 603; seed += 1) {
        assert.equal((await appendCommittedBatch(handle, recordForSeed(seed))).kind, "acknowledged");
      }
      await closeJournal(handle);
      const path = segmentPath(journalDir, 1);
      const bytes = await readFile(path);
      const firstEnd = 41 + bytes.readUInt32BE(0);
      const secondPayload = firstEnd + 41;
      bytes[secondPayload + 3] = (bytes[secondPayload + 3] ?? 0) ^ 0xff;
      await writeFile(path, bytes);
      const replayed = replayJournal(journalDir);
      for await (const ignored of replayed) {
        assert.fail(`corrupt record replayed ${ignored.kind}`);
      }
      const completion = await replayed.completion;
      assert.equal(completion.kind, "error");
      if (completion.kind === "error") {
        assert.equal(completion.error.code, "corrupt-crc");
        assert.equal(completion.error.disposition, "fatal");
      }
    } finally {
      await rm(journalDir, { force: true, recursive: true });
    }
  });

  await context.test("missing cut segment", async () => {
    const journalDir = await temporaryDirectory("autopilot-journal-missing-");
    try {
      await seedJournal(journalDir, 610);
      const successor = await acquired(journalDir);
      await closeJournal(successor);
      await unlink(segmentPath(journalDir, 1));
      const replayed = replayJournal(journalDir);
      for await (const ignored of replayed) {
        assert.fail(`missing segment replayed ${ignored.kind}`);
      }
      const completion = await replayed.completion;
      assert.equal(completion.kind, "error");
      if (completion.kind === "error") {
        assert.equal(completion.error.code, "missing-segment");
      }
    } finally {
      await rm(journalDir, { force: true, recursive: true });
    }
  });
});

test("injected ENOSPC is loud, resumable, and leaves the valid prefix uncorrupted", async () => {
  class FullFilesystemError extends Error {
    readonly code = "ENOSPC";
  }
  const journalDir = await temporaryDirectory("autopilot-journal-enospc-");
  try {
    const observer: JournalDurabilityObserver = (event): void => {
      if (event.point === "frame-mid-write" && event.frameType === "record") {
        throw new FullFilesystemError("injected full filesystem at real write seam");
      }
    };
    const opened = await openJournal(journalDir, { durabilityObserver: observer });
    assert.equal(opened.kind, "acquired");
    if (opened.kind !== "acquired") {
      throw new Error("writer did not open");
    }
    const failed = await appendCommittedBatch(opened.handle, recordForSeed(700));
    assert.equal(failed.kind, "rejected");
    if (failed.kind === "rejected") {
      assert.equal(failed.error.code, "io-full");
      assert.equal(failed.error.disposition, "resume");
    }
    const poisoned = await appendCommittedBatch(opened.handle, recordForSeed(701));
    assert.equal(poisoned.kind, "rejected");
    await closeJournal(opened.handle);
    const recovery = await acquired(journalDir);
    await closeJournal(recovery);
    assert.equal((await replayRecords(journalDir)).length, 0);
  } finally {
    await rm(journalDir, { force: true, recursive: true });
  }
});

test("replay is byte-deterministic across processes, locales, and timezones", async () => {
  const journalDir = await temporaryDirectory("autopilot-journal-cross-process-");
  try {
    const handle = await acquired(journalDir);
    for (let seed = 800; seed < 816; seed += 1) {
      assert.equal((await appendCommittedBatch(handle, recordForSeed(seed))).kind, "acknowledged");
    }
    await closeJournal(handle);
    const utc = await replayDigestInChild(journalDir, {
      ...process.env,
      LC_ALL: "C",
      TZ: "UTC",
    });
    const pacific = await replayDigestInChild(journalDir, {
      ...process.env,
      LC_ALL: "en_US.UTF-8",
      TZ: "America/Los_Angeles",
    });
    assert.equal(field(utc, "kind"), "complete");
    assert.deepEqual(field(utc, "digests"), field(pacific, "digests"));
  } finally {
    await rm(journalDir, { force: true, recursive: true });
  }
});
