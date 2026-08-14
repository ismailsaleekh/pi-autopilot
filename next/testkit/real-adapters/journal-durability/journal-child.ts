import { fileURLToPath } from "node:url";
import {
  appendCommittedBatch,
  closeJournal,
  openJournal,
  replayJournal,
} from "../../../storage/journal/index.js";
import type {
  JournalDurabilityEvent,
  JournalDurabilityObserver,
} from "../../../storage/journal/index.js";
import {
  canonicalCommandArtifact,
  canonicalCommandsDigest,
  canonicalDecisionFactsDigest,
  journalRecordCapsule,
} from "../../../authority/protocol/journal-record.capsule.js";
import type { JournalRecord } from "../../../authority/protocol/journal-record.capsule.js";
import { preparedCommitTestHarness } from "../../../authority/protocol/accepted-batch.js";

const preparedCommits = preparedCommitTestHarness();
function prepared(record: JournalRecord) {
  const result = preparedCommits.prepareRecord(record);
  if (result.kind !== "minted") throw new Error(result.error.diagnostic);
  return result.commit;
}

function recordForSeed(seed: number, kind: "run-genesis" | "decision-committed"): JournalRecord {
  const record = journalRecordCapsule.arbitrary.validForKind(kind, seed);
  if (record.kind !== "decision-committed") return record;
  const encoded = journalRecordCapsule.encodeUnknown(Object.freeze({
    ...record,
    commandArtifact: canonicalCommandArtifact(record.commands),
    commandDigest: canonicalCommandsDigest(record.commands),
    factDigest: canonicalDecisionFactsDigest(record.facts),
  }));
  if (encoded.kind === "error") throw new Error(encoded.error.diagnostic);
  const decoded = journalRecordCapsule.decodeCanonical(encoded.value);
  if (decoded.kind === "error") throw new Error(decoded.error.diagnostic);
  return decoded.value;
}

function send(message: unknown): void {
  if (process.send !== undefined) {
    process.send(message);
  }
}

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

function waitFor(command: string): Promise<void> {
  return new Promise((resolveCommand) => {
    const listener = (message: unknown): void => {
      if (field(message, "command") === command) {
        process.off("message", listener);
        resolveCommand();
      }
    };
    process.on("message", listener);
  });
}

function forever(): Promise<void> {
  return new Promise(() => {
    // The IPC channel remains live until the parent deliberately sends SIGKILL.
  });
}

function durabilityObserver(
  selectedPoint: string,
  selectedFrameType: string,
): JournalDurabilityObserver {
  return async (event: JournalDurabilityEvent): Promise<void> => {
    const frameMatches = selectedFrameType === "any" || event.frameType === selectedFrameType;
    if (event.point === selectedPoint && frameMatches) {
      send(Object.freeze({ event: "point", point: event.point, frameType: event.frameType }));
      await forever();
    }
  };
}

async function killWindow(
  journalDir: string,
  point: string,
  frameType: string,
  appendAfterOpen: boolean,
  seed: number,
): Promise<void> {
  const opened = await openJournal(journalDir, {
    durabilityObserver: durabilityObserver(point, frameType),
  });
  if (opened.kind !== "acquired") {
    send(Object.freeze({ event: "result", kind: opened.kind }));
    return;
  }
  if (appendAfterOpen) {
    const record = recordForSeed(seed, "decision-committed");
    const result = await appendCommittedBatch(opened.handle, prepared(record));
    send(Object.freeze({ event: "result", kind: result.kind }));
  } else {
    send(Object.freeze({ event: "result", kind: "acquired" }));
  }
  await closeJournal(opened.handle);
}

async function contend(journalDir: string, seed: number): Promise<void> {
  const observer: JournalDurabilityObserver = async (event): Promise<void> => {
    if (event.point === "epoch-scan-complete") {
      send(Object.freeze({ event: "ready" }));
      await waitFor("go");
    }
  };
  const opened = await openJournal(journalDir, { durabilityObserver: observer });
  if (opened.kind !== "acquired") {
    send(Object.freeze({ event: "finished", kind: opened.kind }));
    return;
  }
  const record = recordForSeed(seed, "run-genesis");
  const appended = await appendCommittedBatch(opened.handle, prepared(record));
  await closeJournal(opened.handle);
  send(Object.freeze({
    event: "finished",
    kind: "acquired",
    appendKind: appended.kind,
    seed,
  }));
}

async function staleWriter(journalDir: string, seed: number): Promise<void> {
  const opened = await openJournal(journalDir);
  if (opened.kind !== "acquired") {
    send(Object.freeze({ event: "finished", kind: opened.kind }));
    return;
  }
  send(Object.freeze({ event: "acquired", epoch: opened.handle.epoch }));
  await waitFor("append");
  const record = recordForSeed(seed, "run-genesis");
  const appended = await appendCommittedBatch(opened.handle, prepared(record));
  await closeJournal(opened.handle);
  send(Object.freeze({
    code: appended.kind === "rejected" ? appended.error.code : null,
    event: "finished",
    kind: appended.kind,
    seed,
  }));
}

async function replayDigest(journalDir: string): Promise<void> {
  const replay = replayJournal(journalDir);
  const digests: string[] = [];
  for await (const record of replay) {
    digests.push(journalRecordCapsule.digest(record));
  }
  const completion = await replay.completion;
  send(Object.freeze({
    code: completion.kind === "error" ? completion.error.code : null,
    digests: Object.freeze(digests),
    event: "replay",
    kind: completion.kind,
  }));
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  const journalDir = process.argv[3] ?? "";
  if (mode === "kill-window") {
    await killWindow(
      journalDir,
      process.argv[4] ?? "",
      process.argv[5] ?? "any",
      process.argv[6] === "append",
      Number(process.argv[7] ?? "0"),
    );
  } else if (mode === "contend") {
    await contend(journalDir, Number(process.argv[4] ?? "0"));
  } else if (mode === "stale-writer") {
    await staleWriter(journalDir, Number(process.argv[4] ?? "0"));
  } else if (mode === "replay-digest") {
    await replayDigest(journalDir);
  } else {
    send(Object.freeze({ event: "error", message: "unknown child mode" }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
