import { Buffer } from "node:buffer";
import {
  lstat,
  open,
  readdir,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { JournalRecord } from "../../authority/protocol/journal-record.capsule.js";
import { journalError, journalIoError } from "./errors.js";
import type { JournalEpoch, JournalError } from "./types.js";
import {
  EPOCH_DECIMAL_WIDTH,
  FRAME_HEADER_BYTES,
  JOURNAL_GENESIS_HASH,
  MAX_RECORD_PAYLOAD_BYTES,
  chainHash,
  crc32c,
  decodeWirePayload,
  epochSegmentName,
  parseU64,
} from "./wire.js";
import type { TakeoverControl } from "./wire.js";

export interface EpochLayout {
  readonly epoch: JournalEpoch;
  readonly epochValue: bigint;
  readonly claimPath: string;
  readonly segmentPath: string;
  readonly segmentExists: boolean;
}

export interface SegmentReplayPlan {
  readonly epoch: JournalEpoch;
  readonly path: string;
  readonly byteLength: bigint;
}

export interface TailTruncation {
  readonly epoch: JournalEpoch;
  readonly path: string;
  readonly fromByteLength: bigint;
  readonly toByteLength: bigint;
}

export interface JournalScanPlan {
  readonly epochs: readonly EpochLayout[];
  readonly segments: readonly SegmentReplayPlan[];
  readonly observedCuts: readonly {
    readonly epoch: JournalEpoch;
    readonly observedByteLength: bigint;
  }[];
  readonly tailTruncations: readonly TailTruncation[];
  readonly chainHead: Buffer;
}

export type LayoutScanResult =
  | { readonly kind: "ok"; readonly epochs: readonly EpochLayout[] }
  | { readonly kind: "error"; readonly error: JournalError };

export type JournalScanResult =
  | { readonly kind: "ok"; readonly plan: JournalScanPlan }
  | { readonly kind: "error"; readonly error: JournalError };

interface DecodedFrameRead {
  readonly kind: "frame";
  readonly end: bigint;
  readonly chainHash: Buffer;
  readonly value:
    | { readonly kind: "control"; readonly control: TakeoverControl }
    | { readonly kind: "record"; readonly record: JournalRecord };
}

interface InvalidFrameRead {
  readonly kind: "invalid";
  readonly error: JournalError;
  readonly interior: boolean;
}

type FrameReadResult = DecodedFrameRead | InvalidFrameRead;

interface RawSegmentScan {
  readonly kind: "ok";
  readonly path: string;
  readonly epoch: JournalEpoch;
  readonly size: bigint;
  readonly validPrefix: bigint;
  readonly firstFrameEnd: bigint | null;
  readonly firstFrameType: "control" | "record" | null;
  readonly invalid: InvalidFrameRead | null;
}

interface RawSegmentError {
  readonly kind: "error";
  readonly error: JournalError;
}

type RawSegmentResult = RawSegmentScan | RawSegmentError;

interface CutAssignment {
  readonly successor: JournalEpoch;
  readonly byteLength: bigint;
}

export type ReplayStep =
  | { readonly kind: "record"; readonly record: JournalRecord }
  | { readonly kind: "error"; readonly error: JournalError };

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function parseClaimFileName(name: string): JournalEpoch | null {
  const prefix = "epoch.";
  if (!name.startsWith(prefix)) {
    return null;
  }
  const epoch = name.slice(prefix.length);
  return epoch.length === EPOCH_DECIMAL_WIDTH && parseU64(epoch) !== null ? epoch : null;
}

function parseSegmentFileName(name: string): JournalEpoch | null {
  const prefix = "journal.";
  const suffix = ".log";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
    return null;
  }
  const epoch = name.slice(prefix.length, name.length - suffix.length);
  return epoch.length === EPOCH_DECIMAL_WIDTH && parseU64(epoch) !== null ? epoch : null;
}

async function regularFileSize(path: string): Promise<bigint | null> {
  const value = await stat(path, { bigint: true });
  return value.isFile() ? value.size : null;
}

export async function scanJournalLayout(journalDir: string): Promise<LayoutScanResult> {
  const epochsDir = join(journalDir, "epochs");
  const segmentsDir = join(journalDir, "segments");
  try {
    const rootStatus = await lstat(journalDir);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-layout",
          "fatal",
          "scan-journal-layout",
          "journal root must be a real directory, not a symlink",
          journalDir,
        ),
      });
    }
    const epochDirectoryStatus = await lstat(epochsDir);
    const segmentDirectoryStatus = await lstat(segmentsDir);
    if (
      !epochDirectoryStatus.isDirectory()
      || epochDirectoryStatus.isSymbolicLink()
      || !segmentDirectoryStatus.isDirectory()
      || segmentDirectoryStatus.isSymbolicLink()
    ) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-layout",
          "fatal",
          "scan-journal-layout",
          "epochs and segments must be real directories",
          journalDir,
        ),
      });
    }

    const claimEntries = await readdir(epochsDir, { withFileTypes: true });
    const segmentEntries = await readdir(segmentsDir, { withFileTypes: true });
    const claims = new Map<JournalEpoch, string>();
    const segments = new Map<JournalEpoch, string>();

    for (const entry of claimEntries) {
      const epoch = parseClaimFileName(entry.name);
      if (epoch === null || !entry.isFile() || entry.isSymbolicLink()) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-layout",
            "fatal",
            "scan-journal-layout",
            `unexpected epochs entry '${entry.name}'`,
            join(epochsDir, entry.name),
          ),
        });
      }
      const claimPath = join(epochsDir, entry.name);
      const claimSize = await regularFileSize(claimPath);
      if (claimSize !== 0n || claims.has(epoch)) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-layout",
            "fatal",
            "scan-journal-layout",
            "epoch claims must be unique zero-byte regular files",
            claimPath,
            epoch,
          ),
        });
      }
      claims.set(epoch, claimPath);
    }

    for (const entry of segmentEntries) {
      const epoch = parseSegmentFileName(entry.name);
      if (epoch === null || !entry.isFile() || entry.isSymbolicLink()) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-layout",
            "fatal",
            "scan-journal-layout",
            `unexpected segments entry '${entry.name}'`,
            join(segmentsDir, entry.name),
          ),
        });
      }
      const segmentPath = join(segmentsDir, entry.name);
      if (segments.has(epoch) || await regularFileSize(segmentPath) === null) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-layout",
            "fatal",
            "scan-journal-layout",
            "journal segments must be unique regular files",
            segmentPath,
            epoch,
          ),
        });
      }
      segments.set(epoch, segmentPath);
    }

    for (const [epoch, segmentPath] of segments) {
      if (!claims.has(epoch)) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-layout",
            "fatal",
            "scan-journal-layout",
            "a journal segment exists without its epoch claim",
            segmentPath,
            epoch,
          ),
        });
      }
    }

    const orderedEpochs = Array.from(claims.keys()).sort(compareText);
    for (let index = 0; index < orderedEpochs.length; index += 1) {
      const epoch = orderedEpochs[index];
      if (epoch === undefined) {
        continue;
      }
      const expected = BigInt(index + 1);
      if (parseU64(epoch) !== expected) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-layout",
            "fatal",
            "scan-journal-layout",
            "epoch claims must start at one and remain contiguous",
            claims.get(epoch) ?? epochsDir,
            epoch,
          ),
        });
      }
    }

    const output: EpochLayout[] = [];
    for (const epoch of orderedEpochs) {
      const epochValue = parseU64(epoch);
      const claimPath = claims.get(epoch);
      if (epochValue === null || claimPath === undefined) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-layout",
            "fatal",
            "scan-journal-layout",
            "validated epoch metadata became unavailable",
            epochsDir,
            epoch,
          ),
        });
      }
      output.push(Object.freeze({
        claimPath,
        epoch,
        epochValue,
        segmentExists: segments.has(epoch),
        segmentPath: segments.get(epoch) ?? join(segmentsDir, epochSegmentName(epoch)),
      }));
    }
    return Object.freeze({ kind: "ok", epochs: Object.freeze(output) });
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: journalIoError("scan-journal-layout", journalDir, error),
    });
  }
}

async function readExactAt(
  file: FileHandle,
  byteLength: number,
  position: bigint,
): Promise<Buffer | null> {
  const output = Buffer.alloc(byteLength);
  let filled = 0;
  while (filled < byteLength) {
    const read = await file.read(output, filled, byteLength - filled, position + BigInt(filled));
    if (read.bytesRead === 0) {
      return null;
    }
    filled += read.bytesRead;
  }
  return output;
}

async function readFrameAt(
  file: FileHandle,
  path: string,
  epoch: JournalEpoch,
  offset: bigint,
  limit: bigint,
  expectedPrevious: Buffer | null,
): Promise<FrameReadResult> {
  try {
    const remaining = limit - offset;
    if (remaining < BigInt(FRAME_HEADER_BYTES)) {
      return Object.freeze({
        kind: "invalid",
        error: journalError(
          "corrupt-frame",
          "fatal",
          "read-frame",
          "truncated wire-v1 frame header",
          path,
          epoch,
        ),
        interior: false,
      });
    }
    const header = await readExactAt(file, FRAME_HEADER_BYTES, offset);
    if (header === null) {
      return Object.freeze({
        kind: "invalid",
        error: journalError(
          "corrupt-frame",
          "fatal",
          "read-frame",
          "frame header disappeared below the snapshotted prefix",
          path,
          epoch,
        ),
        interior: false,
      });
    }
    const payloadLength = header.readUInt32BE(0);
    const frameType = header[40] ?? -1;
    if (frameType !== 0 && frameType !== 1) {
      return Object.freeze({
        kind: "invalid",
        error: journalError(
          "corrupt-frame",
          "fatal",
          "read-frame",
          `wire-v1 frame type ${String(frameType)} is not control or record`,
          path,
          epoch,
        ),
        interior: true,
      });
    }
    if (frameType === 1 && payloadLength > MAX_RECORD_PAYLOAD_BYTES) {
      return Object.freeze({
        kind: "invalid",
        error: journalError(
          "record-too-large",
          "fatal",
          "read-frame",
          "wire-v1 record payload exceeds 1 MiB",
          path,
          epoch,
        ),
        interior: true,
      });
    }
    const frameEnd = offset + BigInt(FRAME_HEADER_BYTES) + BigInt(payloadLength);
    if (frameEnd > limit) {
      return Object.freeze({
        kind: "invalid",
        error: journalError(
          "corrupt-frame",
          "fatal",
          "read-frame",
          "truncated wire-v1 frame payload",
          path,
          epoch,
        ),
        interior: false,
      });
    }
    const payload = await readExactAt(file, payloadLength, offset + BigInt(FRAME_HEADER_BYTES));
    if (payload === null) {
      return Object.freeze({
        kind: "invalid",
        error: journalError(
          "corrupt-frame",
          "fatal",
          "read-frame",
          "frame payload disappeared below the snapshotted prefix",
          path,
          epoch,
        ),
        interior: frameEnd < limit,
      });
    }
    const expectedCrc = header.readUInt32BE(4);
    if (crc32c(payload) !== expectedCrc) {
      return Object.freeze({
        kind: "invalid",
        error: journalError(
          "corrupt-crc",
          "fatal",
          "read-frame",
          "CRC32C mismatch in journal frame",
          path,
          epoch,
        ),
        interior: true,
      });
    }
    const storedHash = Buffer.from(header.subarray(8, 40));
    if (expectedPrevious !== null) {
      const calculated = chainHash(expectedPrevious, payload);
      if (!storedHash.equals(calculated)) {
        return Object.freeze({
          kind: "invalid",
          error: journalError(
            "corrupt-chain",
            "fatal",
            "read-frame",
            "SHA-256 journal chain mismatch",
            path,
            epoch,
          ),
          interior: true,
        });
      }
    }
    const decoded = decodeWirePayload(frameType, payload, path, epoch);
    if (decoded.kind === "error") {
      return Object.freeze({
        kind: "invalid",
        error: decoded.error,
        interior: true,
      });
    }
    return Object.freeze({
      kind: "frame",
      chainHash: storedHash,
      end: frameEnd,
      value: decoded.value,
    });
  } catch (error: unknown) {
    return Object.freeze({
      kind: "invalid",
      error: journalIoError("read-frame", path, error, epoch),
      interior: true,
    });
  }
}

async function scanRawSegment(layout: EpochLayout): Promise<RawSegmentResult> {
  let file: FileHandle | null = null;
  try {
    const size = (await stat(layout.segmentPath, { bigint: true })).size;
    file = await open(layout.segmentPath, "r");
    let offset = 0n;
    let previous: Buffer | null = null;
    let firstFrameEnd: bigint | null = null;
    let firstFrameType: "control" | "record" | null = null;
    let invalid: InvalidFrameRead | null = null;
    while (offset < size) {
      const frame = await readFrameAt(file, layout.segmentPath, layout.epoch, offset, size, previous);
      if (frame.kind === "invalid") {
        invalid = frame;
        break;
      }
      if (offset === 0n) {
        firstFrameEnd = frame.end;
        firstFrameType = frame.value.kind;
      }
      previous = frame.chainHash;
      offset = frame.end;
    }
    await file.close();
    file = null;
    return Object.freeze({
      kind: "ok",
      epoch: layout.epoch,
      firstFrameEnd,
      firstFrameType,
      invalid,
      path: layout.segmentPath,
      size,
      validPrefix: offset,
    });
  } catch (error: unknown) {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // The primary typed error below remains authoritative.
      }
    }
    return Object.freeze({
      kind: "error",
      error: journalIoError("scan-segment", layout.segmentPath, error, layout.epoch),
    });
  }
}

function predecessorCut(
  control: TakeoverControl,
  predecessor: EpochLayout,
  successor: EpochLayout,
): { readonly kind: "ok"; readonly cut: CutAssignment }
  | { readonly kind: "error"; readonly error: JournalError } {
  const byteLength = parseU64(control.predecessorObservedByteLength);
  if (control.predecessorEpoch !== predecessor.epoch || byteLength === null) {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "corrupt-control",
        "fatal",
        "validate-epoch-continuation",
        "continuation must bind exactly the immediately preceding epoch",
        successor.segmentPath,
        successor.epoch,
      ),
    });
  }
  return Object.freeze({
    kind: "ok",
    cut: Object.freeze({ byteLength, successor: successor.epoch }),
  });
}

function rawFor(
  rawSegments: ReadonlyMap<JournalEpoch, RawSegmentScan>,
  epoch: JournalEpoch,
): RawSegmentScan | null {
  return rawSegments.get(epoch) ?? null;
}

async function readTakeoverControl(
  raw: RawSegmentScan,
  limit: bigint,
): Promise<{ readonly kind: "ok"; readonly control: TakeoverControl }
  | { readonly kind: "error"; readonly error: JournalError }> {
  let file: FileHandle | null = null;
  try {
    file = await open(raw.path, "r");
    const frame = await readFrameAt(file, raw.path, raw.epoch, 0n, limit, null);
    await file.close();
    file = null;
    if (frame.kind === "invalid") {
      return Object.freeze({ kind: "error", error: frame.error });
    }
    if (frame.value.kind !== "control") {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-control",
          "fatal",
          "read-takeover-control",
          "successor segment does not begin with a takeover control frame",
          raw.path,
          raw.epoch,
        ),
      });
    }
    return Object.freeze({ control: frame.value.control, kind: "ok" });
  } catch (error: unknown) {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // The primary typed error remains authoritative.
      }
    }
    return Object.freeze({
      kind: "error",
      error: journalIoError("read-takeover-control", raw.path, error, raw.epoch),
    });
  }
}

export async function buildJournalScanPlan(
  journalDir: string,
  selectedEpochs?: readonly EpochLayout[],
): Promise<JournalScanResult> {
  const layout = selectedEpochs === undefined
    ? await scanJournalLayout(journalDir)
    : Object.freeze({ kind: "ok", epochs: selectedEpochs });
  if (layout.kind === "error") {
    return layout;
  }
  const epochs = layout.epochs;
  const rawSegments = new Map<JournalEpoch, RawSegmentScan>();
  for (const epoch of epochs) {
    if (!epoch.segmentExists) {
      continue;
    }
    const raw = await scanRawSegment(epoch);
    if (raw.kind === "error") {
      return raw;
    }
    rawSegments.set(epoch.epoch, raw);
  }

  const assignments = new Map<JournalEpoch, CutAssignment>();
  const limits = new Map<JournalEpoch, bigint>();
  for (let index = epochs.length - 1; index >= 0; index -= 1) {
    const epoch = epochs[index];
    if (epoch === undefined) {
      continue;
    }
    const assignment = assignments.get(epoch.epoch);
    const raw = rawFor(rawSegments, epoch.epoch);
    let limit = 0n;
    if (raw === null) {
      if (assignment !== undefined && assignment.byteLength > 0n) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "missing-segment",
            "fatal",
            "plan-journal-replay",
            "a successor recorded a nonzero cut for a missing claimed segment",
            epoch.segmentPath,
            epoch.epoch,
          ),
        });
      }
    } else if (assignment !== undefined) {
      if (assignment.byteLength > raw.validPrefix) {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-frame",
            "fatal",
            "plan-journal-replay",
            "successor cut extends beyond the segment's valid frame prefix",
            epoch.segmentPath,
            epoch.epoch,
          ),
        });
      }
      limit = assignment.byteLength;
    } else {
      if (raw.invalid !== null && raw.invalid.interior) {
        return Object.freeze({ kind: "error", error: raw.invalid.error });
      }
      limit = raw.validPrefix;
    }
    limits.set(epoch.epoch, limit);

    if (limit === 0n) {
      continue;
    }
    const firstEpoch = epochs[0];
    if (firstEpoch === undefined) {
      continue;
    }
    if (epoch.epoch === firstEpoch.epoch) {
      if (raw !== null && raw.firstFrameType === "control") {
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-control",
            "fatal",
            "plan-journal-replay",
            "the first epoch must not begin with a takeover control frame",
            epoch.segmentPath,
            epoch.epoch,
          ),
        });
      }
      continue;
    }
    if (
      raw === null
      || raw.firstFrameType !== "control"
      || raw.firstFrameEnd === null
      || raw.firstFrameEnd > limit
    ) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-control",
          "fatal",
          "plan-journal-replay",
          "every nonempty successor segment must begin with a complete takeover control frame",
          epoch.segmentPath,
          epoch.epoch,
        ),
      });
    }
    const takeover = await readTakeoverControl(raw, limit);
    if (takeover.kind === "error") {
      return takeover;
    }
    const predecessor = epochs[index - 1];
    if (predecessor === undefined) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-control",
          "fatal",
          "plan-journal-replay",
          "noninitial continuation has no predecessor epoch",
          epoch.segmentPath,
          epoch.epoch,
        ),
      });
    }
    const decodedCut = predecessorCut(takeover.control, predecessor, epoch);
    if (decodedCut.kind === "error") {
      return decodedCut;
    }
    assignments.set(predecessor.epoch, decodedCut.cut);
  }

  const segmentPlans: SegmentReplayPlan[] = [];
  const observedCuts: Array<{ readonly epoch: JournalEpoch; readonly observedByteLength: bigint }> = [];
  const truncations: TailTruncation[] = [];
  let chainHead: Buffer = Buffer.from(JOURNAL_GENESIS_HASH);
  for (const epoch of epochs) {
    const raw = rawFor(rawSegments, epoch.epoch);
    const limit = limits.get(epoch.epoch) ?? 0n;
    observedCuts.push(Object.freeze({
      epoch: epoch.epoch,
      observedByteLength: raw === null ? 0n : raw.validPrefix,
    }));
    if (raw !== null && !assignments.has(epoch.epoch) && raw.size > limit) {
      truncations.push(Object.freeze({
        epoch: epoch.epoch,
        fromByteLength: raw.size,
        path: epoch.segmentPath,
        toByteLength: limit,
      }));
    }
    if (limit === 0n) {
      continue;
    }
    if (raw === null) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "missing-segment",
          "fatal",
          "plan-journal-replay",
          "nonempty replay prefix has no segment file",
          epoch.segmentPath,
          epoch.epoch,
        ),
      });
    }
    let file: FileHandle | null = null;
    try {
      file = await open(epoch.segmentPath, "r");
      let offset = 0n;
      let previous = chainHead;
      let first = true;
      while (offset < limit) {
        const frame = await readFrameAt(file, epoch.segmentPath, epoch.epoch, offset, limit, previous);
        if (frame.kind === "invalid") {
          await file.close();
          file = null;
          return Object.freeze({ kind: "error", error: frame.error });
        }
        if (first) {
          const shouldBeControl = epoch.epoch !== epochs[0]?.epoch;
          if (
            (shouldBeControl && frame.value.kind !== "control")
            || (!shouldBeControl && frame.value.kind === "control")
          ) {
            await file.close();
            file = null;
            return Object.freeze({
              kind: "error",
              error: journalError(
                "corrupt-control",
                "fatal",
                "validate-segment-boundary",
                shouldBeControl
                  ? "successor segment does not begin with a takeover frame"
                  : "first epoch begins with an illegal takeover frame",
                epoch.segmentPath,
                epoch.epoch,
              ),
            });
          }
        }
        previous = frame.chainHash;
        offset = frame.end;
        first = false;
      }
      if (offset !== limit) {
        await file.close();
        file = null;
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-frame",
            "fatal",
            "validate-segment-boundary",
            "successor cut is not on a complete frame boundary",
            epoch.segmentPath,
            epoch.epoch,
          ),
        });
      }
      chainHead = previous;
      await file.close();
      file = null;
      segmentPlans.push(Object.freeze({ byteLength: limit, epoch: epoch.epoch, path: epoch.segmentPath }));
    } catch (error: unknown) {
      if (file !== null) {
        try {
          await file.close();
        } catch {
          // The primary typed error remains authoritative.
        }
      }
      return Object.freeze({
        kind: "error",
        error: journalIoError("validate-segment", epoch.segmentPath, error, epoch.epoch),
      });
    }
  }

  return Object.freeze({
    kind: "ok",
    plan: Object.freeze({
      chainHead,
      epochs: Object.freeze(epochs.slice()),
      observedCuts: Object.freeze(observedCuts),
      segments: Object.freeze(segmentPlans),
      tailTruncations: Object.freeze(truncations),
    }),
  });
}

export async function* replayPlanSteps(plan: JournalScanPlan): AsyncGenerator<ReplayStep> {
  let previous: Buffer = Buffer.from(JOURNAL_GENESIS_HASH);
  for (const segment of plan.segments) {
    let file: FileHandle | null = null;
    try {
      file = await open(segment.path, "r");
      let offset = 0n;
      while (offset < segment.byteLength) {
        const frame = await readFrameAt(
          file,
          segment.path,
          segment.epoch,
          offset,
          segment.byteLength,
          previous,
        );
        if (frame.kind === "invalid") {
          await file.close();
          file = null;
          yield Object.freeze({ kind: "error", error: frame.error });
          return;
        }
        previous = frame.chainHash;
        offset = frame.end;
        if (frame.value.kind === "record") {
          yield Object.freeze({ kind: "record", record: frame.value.record });
        }
      }
      await file.close();
      file = null;
    } catch (error: unknown) {
      yield Object.freeze({
        kind: "error",
        error: journalIoError("replay-segment", segment.path, error, segment.epoch),
      });
      return;
    } finally {
      if (file !== null) {
        try {
          await file.close();
        } catch {
          // ReplayStream reports the primary typed completion.
        }
      }
    }
  }
}
