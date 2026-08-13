/*
 * pi-autopilot journal wire v1 — frozen byte layout
 *
 *   offset  width  meaning
 *   0       4      payload byte length, unsigned u32, big-endian
 *   4       4      CRC32C (Castagnoli) of payload only, unsigned u32, big-endian
 *   8       32     SHA-256(prevChainHash || payload)
 *   40      1      frame type: 0x00 control, 0x01 JournalRecord
 *   41      length payload bytes
 *
 * The type byte is deliberately outside the v1 checksum/hash preimage because
 * the operator-approved v1 formula binds exactly `prevChainHash || payload`.
 * Control and record decoders remain disjoint and reject a changed type.
 * Epoch-1 genesis is the fixed 32-byte value
 * 488c991a7cf04f0d123840237f70e19dd35a26d52ae71d68fa8a14b5091582d4,
 * the SHA-256 of the ASCII domain string
 * `pi-autopilot.journal.chain.genesis.v1`.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  journalRecordCapsule,
  recordSemanticRootsMatch,
} from "../../authority/protocol/journal-record.capsule.js";
import type { JournalRecord } from "../../authority/protocol/journal-record.capsule.js";
import {
  defineCapsule,
  literal,
  object,
  text,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { journalError } from "./errors.js";
import type { JournalEpoch, JournalError } from "./types.js";

export const FRAME_HEADER_BYTES = 41;
export const MAX_RECORD_PAYLOAD_BYTES = 1024 * 1024;
export const EPOCH_DECIMAL_WIDTH = 20;
export const U64_MAX = 18_446_744_073_709_551_615n;
export const FRAME_TYPE_CONTROL = 0;
export const FRAME_TYPE_RECORD = 1;

export const JOURNAL_GENESIS_HASH = Buffer.from(
  "488c991a7cf04f0d123840237f70e19dd35a26d52ae71d68fa8a14b5091582d4",
  "hex",
);

const takeoverControlSchema = object({
  kind: literal("epoch-continuation-v2"),
  predecessorEpoch: text("plain"),
  predecessorObservedByteLength: text("plain"),
});

const takeoverControlCapsule = defineCapsule(
  "JournalTakeoverControlV1",
  takeoverControlSchema,
);

export type TakeoverControl = Infer<typeof takeoverControlSchema>;


export type WirePayload =
  | { readonly kind: "control"; readonly control: TakeoverControl }
  | { readonly kind: "record"; readonly record: JournalRecord };

export type WireDecodeResult =
  | { readonly kind: "ok"; readonly value: WirePayload }
  | { readonly kind: "error"; readonly error: JournalError };

export type ControlEncodeResult =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "error"; readonly error: JournalError };

export function formatU64(value: bigint): string | null {
  if (value < 0n || value > U64_MAX) {
    return null;
  }
  return value.toString(10).padStart(EPOCH_DECIMAL_WIDTH, "0");
}

export function parseU64(value: string): bigint | null {
  if (value.length !== EPOCH_DECIMAL_WIDTH) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return null;
    }
  }
  try {
    const parsed = BigInt(value);
    return parsed <= U64_MAX && formatU64(parsed) === value ? parsed : null;
  } catch {
    return null;
  }
}

export function epochClaimName(epoch: JournalEpoch): string {
  return `epoch.${epoch}`;
}

export function epochSegmentName(epoch: JournalEpoch): string {
  return `journal.${epoch}.log`;
}

function validateControl(control: TakeoverControl): string | null {
  if (parseU64(control.predecessorEpoch) === null) {
    return "continuation predecessor epoch is not canonical unsigned-u64 decimal";
  }
  if (parseU64(control.predecessorObservedByteLength) === null) {
    return "continuation predecessor byte length is not canonical unsigned-u64 decimal";
  }
  return null;
}

export function encodeTakeoverControl(
  predecessorEpoch: JournalEpoch,
  predecessorObservedByteLength: bigint,
  path: string,
  epoch: JournalEpoch,
): ControlEncodeResult {
  const byteLength = formatU64(predecessorObservedByteLength);
  if (parseU64(predecessorEpoch) === null || byteLength === null || predecessorEpoch >= epoch) {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "corrupt-control",
        "fatal",
        "encode-epoch-continuation",
        "continuation must bind one canonical predecessor and observed byte length",
        path,
        epoch,
      ),
    });
  }
  const encoded = takeoverControlCapsule.encodeUnknown(Object.freeze({
    kind: "epoch-continuation-v2",
    predecessorEpoch,
    predecessorObservedByteLength: byteLength,
  }));
  if (encoded.kind === "error") {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "corrupt-control",
        "fatal",
        "encode-takeover-control",
        encoded.error.diagnostic,
        path,
        epoch,
      ),
    });
  }
  return Object.freeze({ kind: "ok", bytes: encoded.value });
}

export function decodeWirePayload(
  frameType: number,
  payload: Uint8Array,
  path: string,
  epoch: JournalEpoch,
): WireDecodeResult {
  if (frameType === FRAME_TYPE_CONTROL) {
    const decoded = takeoverControlCapsule.decodeCanonical(payload);
    if (decoded.kind === "error") {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-control",
          "fatal",
          "decode-control-frame",
          decoded.error.diagnostic,
          path,
          epoch,
        ),
      });
    }
    const invalid = validateControl(decoded.value);
    if (invalid !== null) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-control",
          "fatal",
          "decode-control-frame",
          invalid,
          path,
          epoch,
        ),
      });
    }
    return Object.freeze({
      kind: "ok",
      value: Object.freeze({ kind: "control", control: decoded.value }),
    });
  }
  if (frameType === FRAME_TYPE_RECORD) {
    if (payload.byteLength > MAX_RECORD_PAYLOAD_BYTES) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "record-too-large",
          "fatal",
          "decode-record-frame",
          "wire-v1 record payload exceeds 1 MiB",
          path,
          epoch,
        ),
      });
    }
    const decoded = journalRecordCapsule.decodeCanonical(payload);
    if (decoded.kind === "error") {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-frame",
          "fatal",
          "decode-record-frame",
          decoded.error.diagnostic,
          path,
          epoch,
        ),
      });
    }
    if (
      (decoded.value.kind === "decision-committed"
        || decoded.value.kind === "command-settled"
        || decoded.value.kind === "outcome-committed")
      && !recordSemanticRootsMatch(decoded.value)
    ) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "semantic-root-mismatch",
          "fatal",
          "decode-record-frame",
          "semantic record facts, commands, and artifact bindings do not match",
          path,
          epoch,
        ),
      });
    }
    return Object.freeze({
      kind: "ok",
      value: Object.freeze({ kind: "record", record: decoded.value }),
    });
  }
  return Object.freeze({
    kind: "error",
    error: journalError(
      "corrupt-frame",
      "fatal",
      "decode-frame-type",
      `wire-v1 frame type ${String(frameType)} is not control or record`,
      path,
      epoch,
    ),
  });
}

/** Castagnoli CRC32C, reflected polynomial 0x82f63b78, no dependency/table. */
export function crc32c(payload: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0x82f6_3b78 & mask);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function chainHash(previous: Uint8Array, payload: Uint8Array): Buffer {
  return createHash("sha256").update(previous).update(payload).digest();
}

export interface EncodedFrame {
  readonly bytes: Buffer;
  readonly chainHash: Buffer;
}

export function encodeFrame(
  previous: Uint8Array,
  frameType: 0 | 1,
  payload: Uint8Array,
): EncodedFrame {
  const nextHash = chainHash(previous, payload);
  const output = Buffer.alloc(FRAME_HEADER_BYTES + payload.byteLength);
  output.writeUInt32BE(payload.byteLength, 0);
  output.writeUInt32BE(crc32c(payload), 4);
  nextHash.copy(output, 8);
  output[40] = frameType;
  Buffer.from(payload).copy(output, FRAME_HEADER_BYTES);
  return Object.freeze({ bytes: output, chainHash: nextHash });
}

export function chainHashText(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
