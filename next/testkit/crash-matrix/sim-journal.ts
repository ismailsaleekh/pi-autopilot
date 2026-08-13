import {
  defineCapsule,
  jsonValue,
} from "../../authority/protocol/schema.js";
import type { Digest, JsonValue } from "../../authority/protocol/schema.js";
import { SimWorld } from "../simulation/sim-world.js";
import { concatenateBytes, decodeUtf8, digestForBytes, encodeUtf8 } from "../simulation/values.js";

export type JournalAppendResult =
  | { readonly kind: "appended"; readonly digest: Digest; readonly bytes: number }
  | { readonly kind: "crashed"; readonly point: "journal.append" | "journal.fsync" | "journal.ack" }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export type JournalReplayResult =
  | {
      readonly kind: "valid-prefix";
      readonly records: readonly JsonValue[];
      readonly validBytes: number;
      readonly totalBytes: number;
      readonly tornSuffix: boolean;
    }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const jsonCapsule = defineCapsule("SimulationJournalJson", jsonValue());
const JOURNAL_PATH = "/journal/run.log";
const DIGEST_TEXT_BYTES = 71;

function uint32Bytes(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function readUint32(bytes: Uint8Array, offset: number): number | null {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  return b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined
    ? null
    : (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0);
}

function frame(payload: Uint8Array): Uint8Array {
  return concatenateBytes(Object.freeze([
    uint32Bytes(payload.length),
    encodeUtf8(digestForBytes(payload)),
    payload,
  ]));
}

/** Framed append/fsync/ack journal used only by the crash harness demonstration. */
export class SimJournal {
  private readonly world: SimWorld;

  public constructor(world: SimWorld) {
    this.world = world;
    if (!world.fileSystem.exists(JOURNAL_PATH) && world.isAlive()) {
      world.fileSystem.writeFile(JOURNAL_PATH, new Uint8Array());
      world.fileSystem.fsyncFile(JOURNAL_PATH, "filesystem.file-fsync");
      world.fileSystem.fsyncDirectory("/journal", "filesystem.directory-fsync");
    }
  }

  public append(recordInput: unknown): JournalAppendResult {
    let payload: Uint8Array;
    try {
      const encoded = jsonCapsule.encodeUnknown(recordInput);
      if (encoded.kind === "error") {
        return Object.freeze({ kind: "invalid", diagnostic: encoded.error.diagnostic });
      }
      payload = encoded.value;
    } catch {
      return Object.freeze({ kind: "invalid", diagnostic: "journal record could not be inspected" });
    }
    const framed = frame(payload);
    const appended = this.world.fileSystem.appendFile(JOURNAL_PATH, framed, "journal.append");
    if (appended.kind === "crashed") {
      return Object.freeze({ kind: "crashed", point: "journal.append" });
    }
    if (appended.kind !== "ok") {
      return Object.freeze({ kind: "invalid", diagnostic: `journal append ${appended.kind}` });
    }
    const synced = this.world.fileSystem.fsyncFile(JOURNAL_PATH, "journal.fsync");
    if (synced.kind === "crashed") {
      return Object.freeze({ kind: "crashed", point: "journal.fsync" });
    }
    if (synced.kind !== "ok") {
      return Object.freeze({ kind: "invalid", diagnostic: `journal fsync ${synced.kind}` });
    }
    const digest = digestForBytes(payload);
    this.world.trace.append(
      this.world.clock.now(),
      "semantic",
      "journal",
      "record-durable",
      `journal:${digest}`,
      Object.freeze({ digest }),
    );
    if (this.world.durabilityPoint("journal.ack", Object.freeze({ digest }))) {
      return Object.freeze({ kind: "crashed", point: "journal.ack" });
    }
    return Object.freeze({ kind: "appended", digest, bytes: framed.length });
  }

  public replay(): JournalReplayResult {
    const read = this.world.fileSystem.readFile(JOURNAL_PATH);
    if (read.kind === "missing") {
      return Object.freeze({
        kind: "valid-prefix",
        records: Object.freeze([]),
        validBytes: 0,
        totalBytes: 0,
        tornSuffix: false,
      });
    }
    if (read.kind !== "ok") {
      return Object.freeze({ kind: "invalid", diagnostic: read.diagnostic });
    }
    const records: JsonValue[] = [];
    let offset = 0;
    while (offset < read.bytes.length) {
      const payloadLength = readUint32(read.bytes, offset);
      if (payloadLength === null) {
        break;
      }
      const digestStart = offset + 4;
      const payloadStart = digestStart + DIGEST_TEXT_BYTES;
      const end = payloadStart + payloadLength;
      if (end > read.bytes.length) {
        break;
      }
      const digestText = decodeUtf8(read.bytes.slice(digestStart, payloadStart));
      const payload = read.bytes.slice(payloadStart, end);
      if (digestText === null || digestText !== digestForBytes(payload)) {
        break;
      }
      const decoded = jsonCapsule.decodeCanonical(payload);
      if (decoded.kind === "error") {
        break;
      }
      records.push(decoded.value);
      const digest = digestForBytes(payload);
      this.world.trace.append(
        this.world.clock.now(),
        "semantic",
        "journal",
        "record-durable",
        `journal:${digest}`,
        Object.freeze({ digest }),
      );
      offset = end;
    }
    return Object.freeze({
      kind: "valid-prefix",
      records: Object.freeze(records),
      validBytes: offset,
      totalBytes: read.bytes.length,
      tornSuffix: offset !== read.bytes.length,
    });
  }

  public canonicalRecordBytes(recordInput: unknown): Uint8Array | null {
    try {
      const encoded = jsonCapsule.encodeUnknown(recordInput);
      return encoded.kind === "ok" ? encoded.value.slice() : null;
    } catch {
      return null;
    }
  }
}
