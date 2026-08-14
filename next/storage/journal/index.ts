/*
 * Durability contract (Linux and macOS, local filesystems): file data is
 * acknowledged only after FileHandle.datasync(); newly created names are
 * acknowledged only after fsync of the containing directory. Claim/segment
 * creation uses O_CREAT|O_EXCL (`wx`). Node exposes neither fcntl(F_FULLFSYNC)
 * nor a portable equivalent, so this implementation intentionally does not
 * claim sudden-power-loss durability beyond the operating system's fsync/
 * fdatasync contract. The certified D3.2 boundary is process crash/SIGKILL on
 * supported local filesystems. On macOS, storage devices that require
 * F_FULLFSYNC for power-fail cache flush are outside that narrower claim.
 */

import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  open,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPreparedCommit } from "../../authority/protocol/accepted-batch.js";
import type { PreparedCommit } from "../../authority/protocol/accepted-batch.js";
import {
  journalRecordCapsule,
  recordSemanticRootsMatch,
} from "../../authority/protocol/journal-record.capsule.js";
import type { JournalRecord } from "../../authority/protocol/journal-record.capsule.js";
import {
  errorSystemCode,
  journalError,
  journalIoError,
} from "./errors.js";
import {
  buildJournalScanPlan,
  replayPlanSteps,
  scanJournalLayout,
} from "./scan.js";
import type { TailTruncation } from "./scan.js";
import type {
  JournalAppendResult,
  JournalCloseResult,
  JournalDurabilityEvent,
  JournalDurabilityObserver,
  JournalEpoch,
  JournalError,
  JournalOpenOptions,
  JournalOpenResult,
  JournalReadOnly,
  JournalReadOnlyOpenResult,
  JournalReplay,
  JournalReplayCompletion,
  JournalWriterHandle,
} from "./types.js";
import {
  FRAME_TYPE_CONTROL,
  FRAME_TYPE_RECORD,
  MAX_RECORD_PAYLOAD_BYTES,
  U64_MAX,
  chainHashText,
  encodeFrame,
  encodeTakeoverControl,
  epochClaimName,
  epochSegmentName,
  formatU64,
} from "./wire.js";

export type {
  JournalAppendResult,
  JournalCloseResult,
  JournalDurabilityEvent,
  JournalDurabilityObserver,
  JournalDurabilityPoint,
  JournalEpoch,
  JournalError,
  JournalErrorCode,
  JournalErrorDisposition,
  JournalOpenOptions,
  JournalOpenResult,
  JournalReadOnly,
  JournalReadOnlyOpenResult,
  JournalReplay,
  JournalReplayCompletion,
  JournalWriterHandle,
} from "./types.js";

export {
  EPOCH_DECIMAL_WIDTH,
  FRAME_HEADER_BYTES,
  MAX_RECORD_PAYLOAD_BYTES,
  crc32c,
} from "./wire.js";

const DEFAULT_CLAIM_RETRY_LIMIT = 8;
const MAX_CLAIM_RETRY_LIMIT = 1024;

interface WriterState {
  readonly epoch: JournalEpoch;
  readonly file: FileHandle;
  readonly journalDir: string;
  readonly observer: JournalDurabilityObserver | null;
  readonly path: string;
  previousHash: Buffer;
  byteLength: bigint;
  closed: boolean;
  poisoned: boolean;
  superseded: boolean;
  queue: Promise<void>;
}

/*
 * Fencing invariant: a handle contains no path-switching capability and its
 * hidden state owns exactly one fd for exactly one epoch segment. A successor
 * exclusively creates a different segment and durably records the predecessor
 * cuts before returning. A stale process can therefore write only beyond its
 * already-fixed cut in the old inode. A post-fdatasync epoch rescan rejects
 * that frame as superseded before acknowledgment. Its bytes form a divergent
 * hash branch that replay never selects; the stale fd cannot address successor.
 */
const writerStates = new WeakMap<JournalWriterHandle, WriterState>();

interface DirectoryPreparation {
  readonly journalDir: string;
  readonly epochsDir: string;
  readonly segmentsDir: string;
}

type DirectoryPreparationResult =
  | { readonly kind: "ok"; readonly value: DirectoryPreparation }
  | { readonly kind: "error"; readonly error: JournalError };

interface ClaimedEpoch {
  readonly kind: "claimed";
  readonly epoch: JournalEpoch;
  readonly claimPath: string;
}

type SimpleClaimResult = ClaimedEpoch
  | {
      readonly kind: "contended";
      readonly attemptedEpoch: JournalEpoch;
      readonly currentEpoch: JournalEpoch;
      readonly error: JournalError;
    }
  | { readonly kind: "error"; readonly error: JournalError };

function validDirectoryArgument(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function retryLimit(options: JournalOpenOptions | undefined): number | null {
  const value = options?.claimRetryLimit ?? DEFAULT_CLAIM_RETRY_LIMIT;
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_CLAIM_RETRY_LIMIT
    ? value
    : null;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (errorSystemCode(error) !== "EEXIST") {
      throw error;
    }
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error(`${path} is not a real directory`);
    }
  }
}

async function prepareDirectories(journalDirInput: string): Promise<DirectoryPreparationResult> {
  if (!validDirectoryArgument(journalDirInput)) {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "invalid-argument",
        "feedback",
        "open-journal",
        "journalDir must be a nonempty filesystem path without NUL bytes",
      ),
    });
  }
  const journalDir = resolve(journalDirInput);
  const epochsDir = join(journalDir, "epochs");
  const segmentsDir = join(journalDir, "segments");
  try {
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    const root = await lstat(journalDir);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      return Object.freeze({
        kind: "error",
        error: journalError(
          "corrupt-layout",
          "fatal",
          "open-journal",
          "journal root must be a real directory, not a symlink",
          journalDir,
        ),
      });
    }
    await syncDirectory(dirname(journalDir));
    await ensureRealDirectory(epochsDir);
    await ensureRealDirectory(segmentsDir);
    await syncDirectory(journalDir);
    return Object.freeze({
      kind: "ok",
      value: Object.freeze({ epochsDir, journalDir, segmentsDir }),
    });
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: journalIoError("prepare-journal-directories", journalDir, error),
    });
  }
}

async function notify(
  observer: JournalDurabilityObserver | null,
  event: JournalDurabilityEvent,
): Promise<JournalError | null> {
  if (observer === null) {
    return null;
  }
  try {
    await observer(event);
    return null;
  } catch (error: unknown) {
    const code = errorSystemCode(error);
    if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG") {
      return journalIoError(`observe-${event.point}`, event.path, error, event.epoch);
    }
    return journalError(
      "observer-failure",
      "resume",
      `observe-${event.point}`,
      "durability observer failed before the operation could acknowledge",
      event.path,
      event.epoch,
      code,
    );
  }
}

function durabilityEvent(
  point: JournalDurabilityEvent["point"],
  epoch: JournalEpoch,
  path: string,
  frameType: "control" | "record" | null,
): JournalDurabilityEvent {
  return Object.freeze({ epoch, frameType, path, point });
}

function currentEpochOf(
  epochs: readonly { readonly epoch: JournalEpoch }[],
): JournalEpoch | null {
  const last = epochs[epochs.length - 1];
  return last?.epoch ?? null;
}

async function claimEpoch(
  paths: DirectoryPreparation,
  options: JournalOpenOptions | undefined,
): Promise<SimpleClaimResult> {
  const retries = retryLimit(options);
  if (retries === null) {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "invalid-argument",
        "feedback",
        "claim-writer-epoch",
        `claimRetryLimit must be an integer from 1 through ${String(MAX_CLAIM_RETRY_LIMIT)}`,
        paths.epochsDir,
      ),
    });
  }
  const initial = await scanJournalLayout(paths.journalDir);
  if (initial.kind === "error") {
    return initial;
  }
  const current = initial.epochs[initial.epochs.length - 1];
  const nextValue = (current?.epochValue ?? 0n) + 1n;
  if (nextValue > U64_MAX) {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "epoch-exhausted",
        "fatal",
        "claim-writer-epoch",
        "the unsigned-u64 journal epoch space is exhausted",
        paths.epochsDir,
        current?.epoch ?? null,
      ),
    });
  }
  const epoch = formatU64(nextValue);
  if (epoch === null) {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "epoch-exhausted",
        "fatal",
        "claim-writer-epoch",
        "the next epoch could not be encoded as unsigned-u64",
        paths.epochsDir,
      ),
    });
  }
  const observer = options?.durabilityObserver ?? null;
  const scanNotification = await notify(
    observer,
    durabilityEvent("epoch-scan-complete", epoch, paths.epochsDir, null),
  );
  if (scanNotification !== null) {
    return Object.freeze({ kind: "error", error: scanNotification });
  }
  const claimPath = join(paths.epochsDir, epochClaimName(epoch));
  for (let attempt = 0; attempt < retries; attempt += 1) {
    let claimFile: FileHandle | null = null;
    try {
      claimFile = await open(claimPath, "wx", 0o600);
      const createdNotification = await notify(
        observer,
        durabilityEvent("claim-created", epoch, claimPath, null),
      );
      if (createdNotification !== null) {
        await claimFile.close();
        return Object.freeze({ kind: "error", error: createdNotification });
      }
      await claimFile.sync();
      const fileNotification = await notify(
        observer,
        durabilityEvent("claim-file-synced", epoch, claimPath, null),
      );
      if (fileNotification !== null) {
        await claimFile.close();
        return Object.freeze({ kind: "error", error: fileNotification });
      }
      await claimFile.close();
      claimFile = null;
      await syncDirectory(paths.epochsDir);
      const directoryNotification = await notify(
        observer,
        durabilityEvent("claim-directory-synced", epoch, paths.epochsDir, null),
      );
      if (directoryNotification !== null) {
        return Object.freeze({ kind: "error", error: directoryNotification });
      }
      return Object.freeze({ claimPath, epoch, kind: "claimed" });
    } catch (error: unknown) {
      if (claimFile !== null) {
        try {
          await claimFile.close();
        } catch {
          // The exclusive-create result below remains authoritative.
        }
      }
      if (errorSystemCode(error) !== "EEXIST") {
        return Object.freeze({
          kind: "error",
          error: journalIoError("claim-writer-epoch", claimPath, error, epoch),
        });
      }
      const rescanned = await scanJournalLayout(paths.journalDir);
      if (rescanned.kind === "error") {
        return rescanned;
      }
      const observed = currentEpochOf(rescanned.epochs);
      if (observed !== null && observed >= epoch) {
        return Object.freeze({
          attemptedEpoch: epoch,
          currentEpoch: observed,
          error: journalError(
            "contended",
            "contended",
            "claim-writer-epoch",
            "another process won the kernel-atomic exclusive create for this epoch",
            claimPath,
            epoch,
            "EEXIST",
          ),
          kind: "contended",
        });
      }
      // A directory visibility race may transiently hide the EEXIST winner.
      // Retry is bounded and never sleeps or probes process liveness.
    }
  }
  return Object.freeze({
    attemptedEpoch: epoch,
    currentEpoch: epoch,
    error: journalError(
      "contended",
      "contended",
      "claim-writer-epoch",
      `exclusive-create remained contended after ${String(retries)} bounded attempts`,
      claimPath,
      epoch,
      "EEXIST",
    ),
    kind: "contended",
  });
}

async function applyTailTruncation(
  truncation: TailTruncation,
  observer: JournalDurabilityObserver | null,
): Promise<JournalError | null> {
  if (truncation.toByteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    return journalError(
      "io-failure",
      "resume",
      "truncate-torn-tail",
      "Node cannot represent this journal truncation offset safely; resume on a platform with a wider truncate API",
      truncation.path,
      truncation.epoch,
    );
  }
  let file: FileHandle | null = null;
  try {
    file = await open(truncation.path, "r+");
    await file.truncate(Number(truncation.toByteLength));
    const truncated = await notify(
      observer,
      durabilityEvent("tail-truncated", truncation.epoch, truncation.path, null),
    );
    if (truncated !== null) {
      await file.close();
      return truncated;
    }
    await file.sync();
    const synced = await notify(
      observer,
      durabilityEvent("tail-truncate-synced", truncation.epoch, truncation.path, null),
    );
    await file.close();
    file = null;
    return synced;
  } catch (error: unknown) {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // The primary typed error remains authoritative.
      }
    }
    return journalIoError("truncate-torn-tail", truncation.path, error, truncation.epoch);
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) {
      throw new Error("write returned zero bytes");
    }
    offset += result.bytesWritten;
  }
}

async function writeDurableFrame(
  state: WriterState,
  frameType: 0 | 1,
  payload: Uint8Array,
): Promise<JournalError | null> {
  const frameName = frameType === FRAME_TYPE_CONTROL ? "control" : "record";
  const encoded = encodeFrame(state.previousHash, frameType, payload);
  const midpoint = Math.max(1, Math.floor(encoded.bytes.byteLength / 2));
  try {
    await writeAll(state.file, encoded.bytes.subarray(0, midpoint));
    const middle = await notify(
      state.observer,
      durabilityEvent("frame-mid-write", state.epoch, state.path, frameName),
    );
    if (middle !== null) {
      state.poisoned = true;
      return middle;
    }
    await writeAll(state.file, encoded.bytes.subarray(midpoint));
    const written = await notify(
      state.observer,
      durabilityEvent("frame-written", state.epoch, state.path, frameName),
    );
    if (written !== null) {
      state.poisoned = true;
      return written;
    }
    await state.file.datasync();
    state.byteLength += BigInt(encoded.bytes.byteLength);
    state.previousHash = encoded.chainHash;
    const synced = await notify(
      state.observer,
      durabilityEvent("frame-datasynced", state.epoch, state.path, frameName),
    );
    if (synced !== null) {
      state.poisoned = true;
      return synced;
    }
    return null;
  } catch (error: unknown) {
    state.poisoned = true;
    return journalIoError("append-journal-frame", state.path, error, state.epoch);
  }
}

async function verifyWriterStillCurrent(state: WriterState): Promise<JournalError | null> {
  const layout = await scanJournalLayout(state.journalDir);
  if (layout.kind === "error") {
    state.poisoned = true;
    return layout.error;
  }
  const current = currentEpochOf(layout.epochs);
  if (current !== null && current > state.epoch) {
    state.superseded = true;
    return journalError(
      "superseded",
      "resume",
      "acknowledge-journal-frame",
      "a higher writer epoch exists; this durable frame is not acknowledged and recovery selects the successor cut",
      state.path,
      state.epoch,
    );
  }
  return null;
}

function appendRejection(error: JournalError): JournalAppendResult {
  return Object.freeze({ error, kind: "rejected" });
}

async function appendRecord(
  state: WriterState,
  record: JournalRecord,
): Promise<JournalAppendResult> {
  if (state.closed) {
    return appendRejection(journalError(
      "closed-handle",
      "resume",
      "append-committed-batch",
      "journal writer handle is closed",
      state.path,
      state.epoch,
    ));
  }
  if (state.superseded) {
    return appendRejection(journalError(
      "superseded",
      "resume",
      "append-committed-batch",
      "journal writer epoch was superseded; acquire the current epoch and resume",
      state.path,
      state.epoch,
    ));
  }
  if (state.poisoned) {
    return appendRejection(journalError(
      "io-failure",
      "resume",
      "append-committed-batch",
      "a prior uncertain write poisoned this epoch; acquire a successor and resume",
      state.path,
      state.epoch,
    ));
  }
  try {
    if (
      (record.kind === "decision-committed"
        || record.kind === "command-settled"
        || record.kind === "outcome-committed")
      && !recordSemanticRootsMatch(record)
    ) {
      return appendRejection(journalError(
        "semantic-root-mismatch",
        "feedback",
        "append-committed-batch",
        "semantic record facts, commands, and installed artifact bindings must match",
        state.path,
        state.epoch,
      ));
    }
    const encoded = journalRecordCapsule.encodeUnknown(record);
    if (encoded.kind === "error") {
      return appendRejection(journalError(
        "corrupt-frame",
        "feedback",
        "append-committed-batch",
        encoded.error.diagnostic,
        state.path,
        state.epoch,
      ));
    }
    if (encoded.value.byteLength > MAX_RECORD_PAYLOAD_BYTES) {
      return appendRejection(journalError(
        "record-too-large",
        "feedback",
        "append-committed-batch",
        "canonical JournalRecord exceeds 1 MiB; put payload bytes in CAS and journal only references",
        state.path,
        state.epoch,
      ));
    }
    const writeError = await writeDurableFrame(state, FRAME_TYPE_RECORD, encoded.value);
    if (writeError !== null) {
      return appendRejection(writeError);
    }
    const supersededError = await verifyWriterStillCurrent(state);
    if (supersededError !== null) {
      return appendRejection(supersededError);
    }
    return Object.freeze({
      chainHash: chainHashText(state.previousHash),
      endByteLength: state.byteLength.toString(10),
      epoch: state.epoch,
      kind: "acknowledged",
    });
  } catch (error: unknown) {
    state.poisoned = true;
    return appendRejection(journalIoError("append-committed-batch", state.path, error, state.epoch));
  }
}

/**
 * Sole acknowledged JournalRecord sink. Runtime/commit-loop will own the only
 * production call edge when that lane lands. The function serializes every
 * operation for this opaque handle and acknowledges only after fdatasync.
 */
export async function appendCommittedBatch(
  handle: JournalWriterHandle,
  batch: PreparedCommit,
): Promise<JournalAppendResult> {
  const state = writerStates.get(handle);
  if (state === undefined) {
    return appendRejection(journalError(
      "unknown-handle",
      "feedback",
      "append-committed-batch",
      "writer capability was not minted by openJournal in this process",
    ));
  }
  if (!isPreparedCommit(batch)) {
    return appendRejection(journalError(
      "invalid-argument",
      "feedback",
      "append-committed-batch",
      "journal append accepts only authority-minted PreparedCommit capabilities",
      state.path,
      state.epoch,
    ));
  }
  if (
    batch.kind === "prepared-genesis"
    && (state.byteLength !== 0n || state.epoch !== "00000000000000000001")
  ) {
    return appendRejection(journalError(
      "invalid-argument",
      "feedback",
      "append-committed-batch",
      "genesis may be appended only to an empty first epoch",
      state.path,
      state.epoch,
    ));
  }
  if (batch.kind !== "prepared-genesis" && state.byteLength === 0n) {
    return appendRejection(journalError(
      "invalid-argument",
      "feedback",
      "append-committed-batch",
      "the first durable record must be authority-minted genesis",
      state.path,
      state.epoch,
    ));
  }
  const operation = state.queue.then(
    () => appendRecord(state, batch.record),
    () => appendRecord(state, batch.record),
  );
  state.queue = operation.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await operation;
  } catch (error: unknown) {
    state.poisoned = true;
    return appendRejection(journalIoError("append-committed-batch", state.path, error, state.epoch));
  }
}

export async function closeJournal(
  handle: JournalWriterHandle,
): Promise<JournalCloseResult> {
  const state = writerStates.get(handle);
  if (state === undefined) {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "unknown-handle",
        "feedback",
        "close-journal",
        "writer capability was not minted by openJournal in this process",
      ),
    });
  }
  if (state.closed) {
    return Object.freeze({ kind: "closed" });
  }
  state.closed = true;
  try {
    await state.queue;
    await state.file.close();
    writerStates.delete(handle);
    return Object.freeze({ kind: "closed" });
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: journalIoError("close-journal", state.path, error, state.epoch),
    });
  }
}

async function openJournalInternal(
  journalDir: string,
  options?: JournalOpenOptions,
): Promise<JournalOpenResult> {
  const prepared = await prepareDirectories(journalDir);
  if (prepared.kind === "error") {
    return prepared;
  }
  const claimed = await claimEpoch(prepared.value, options);
  if (claimed.kind === "error") {
    return claimed;
  }
  if (claimed.kind === "contended") {
    return claimed;
  }
  const observer = options?.durabilityObserver ?? null;
  let segmentFile: FileHandle | null = null;
  try {
    const layout = await scanJournalLayout(prepared.value.journalDir);
    if (layout.kind === "error") {
      return layout;
    }
    const priorEpochs = layout.epochs.filter((entry) => entry.epoch < claimed.epoch);
    const scanned = await buildJournalScanPlan(prepared.value.journalDir, priorEpochs);
    if (scanned.kind === "error") {
      return scanned;
    }
    for (const truncation of scanned.plan.tailTruncations) {
      const truncationError = await applyTailTruncation(truncation, observer);
      if (truncationError !== null) {
        return Object.freeze({ kind: "error", error: truncationError });
      }
    }

    const segmentPath = join(prepared.value.segmentsDir, epochSegmentName(claimed.epoch));
    segmentFile = await open(segmentPath, "wx+", 0o600);
    const created = await notify(
      observer,
      durabilityEvent("segment-created", claimed.epoch, segmentPath, null),
    );
    if (created !== null) {
      await segmentFile.close();
      return Object.freeze({ kind: "error", error: created });
    }
    await segmentFile.sync();
    const fileSynced = await notify(
      observer,
      durabilityEvent("segment-file-synced", claimed.epoch, segmentPath, null),
    );
    if (fileSynced !== null) {
      await segmentFile.close();
      return Object.freeze({ kind: "error", error: fileSynced });
    }
    await syncDirectory(prepared.value.segmentsDir);
    const directorySynced = await notify(
      observer,
      durabilityEvent("segment-directory-synced", claimed.epoch, prepared.value.segmentsDir, null),
    );
    if (directorySynced !== null) {
      await segmentFile.close();
      return Object.freeze({ kind: "error", error: directorySynced });
    }
    const beforeFirst = await notify(
      observer,
      durabilityEvent("segment-before-first-frame", claimed.epoch, segmentPath, null),
    );
    if (beforeFirst !== null) {
      await segmentFile.close();
      return Object.freeze({ kind: "error", error: beforeFirst });
    }

    const state: WriterState = {
      byteLength: 0n,
      closed: false,
      epoch: claimed.epoch,
      file: segmentFile,
      journalDir: prepared.value.journalDir,
      observer,
      path: segmentPath,
      poisoned: false,
      previousHash: Buffer.from(scanned.plan.chainHead),
      superseded: false,
      queue: Promise.resolve(),
    };
    if (priorEpochs.length > 0) {
      const predecessor = priorEpochs[priorEpochs.length - 1];
      const predecessorCut = predecessor === undefined
        ? undefined
        : scanned.plan.observedCuts.find((entry) => entry.epoch === predecessor.epoch);
      if (predecessor === undefined || predecessorCut === undefined) {
        await segmentFile.close();
        return Object.freeze({
          kind: "error",
          error: journalError(
            "corrupt-control",
            "fatal",
            "open-journal-writer",
            "successor epoch could not bind its immediate predecessor cut",
            segmentPath,
            claimed.epoch,
          ),
        });
      }
      const control = encodeTakeoverControl(
        predecessor.epoch,
        predecessorCut.observedByteLength,
        segmentPath,
        claimed.epoch,
      );
      if (control.kind === "error") {
        await segmentFile.close();
        return control;
      }
      const controlError = await writeDurableFrame(state, FRAME_TYPE_CONTROL, control.bytes);
      if (controlError !== null) {
        await segmentFile.close();
        return Object.freeze({ kind: "error", error: controlError });
      }
    }
    const supersededError = await verifyWriterStillCurrent(state);
    if (supersededError !== null) {
      await segmentFile.close();
      return Object.freeze({ kind: "error", error: supersededError });
    }
    const handle: JournalWriterHandle = Object.freeze({
      epoch: claimed.epoch,
      segmentPath,
    });
    writerStates.set(handle, state);
    segmentFile = null;
    return Object.freeze({ handle, kind: "acquired" });
  } catch (error: unknown) {
    if (segmentFile !== null) {
      try {
        await segmentFile.close();
      } catch {
        // The primary typed error remains authoritative.
      }
    }
    return Object.freeze({
      kind: "error",
      error: journalIoError(
        "open-journal-writer",
        prepared.value.journalDir,
        error,
        claimed.epoch,
      ),
    });
  }
}

export async function openJournal(
  journalDir: string,
  options?: JournalOpenOptions,
): Promise<JournalOpenResult> {
  try {
    return await openJournalInternal(journalDir, options);
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: journalIoError(
        "open-journal",
        typeof journalDir === "string" ? journalDir : null,
        error,
      ),
    });
  }
}

async function openJournalReadOnlyInternal(
  journalDirInput: string,
): Promise<JournalReadOnlyOpenResult> {
  if (!validDirectoryArgument(journalDirInput)) {
    return Object.freeze({
      kind: "error",
      error: journalError(
        "invalid-argument",
        "feedback",
        "open-journal-read-only",
        "journalDir must be a nonempty filesystem path without NUL bytes",
      ),
    });
  }
  const journalDir = resolve(journalDirInput);
  const layout = await scanJournalLayout(journalDir);
  if (layout.kind === "error") {
    return layout;
  }
  const snapshot = currentEpochOf(layout.epochs);
  const journal: JournalReadOnly = Object.freeze({
    currentEpoch() {
      return snapshot;
    },
  });
  return Object.freeze({ journal, kind: "opened" });
}

export async function openJournalReadOnly(
  journalDirInput: string,
): Promise<JournalReadOnlyOpenResult> {
  try {
    return await openJournalReadOnlyInternal(journalDirInput);
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: journalIoError(
        "open-journal-read-only",
        typeof journalDirInput === "string" ? journalDirInput : null,
        error,
      ),
    });
  }
}

class ReplayStream implements JournalReplay {
  readonly completion: Promise<JournalReplayCompletion>;
  private readonly journalDirInput: string;
  private completionResolver: ((value: JournalReplayCompletion) => void) | null = null;
  private started = false;

  constructor(journalDirInput: string) {
    this.journalDirInput = journalDirInput;
    this.completion = new Promise((resolveCompletion) => {
      this.completionResolver = resolveCompletion;
    });
  }

  private finish(value: JournalReplayCompletion): void {
    const resolver = this.completionResolver;
    if (resolver !== null) {
      this.completionResolver = null;
      resolver(value);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JournalRecord> {
    if (this.started) {
      this.finish(Object.freeze({
        kind: "error",
        error: journalError(
          "invalid-argument",
          "feedback",
          "iterate-journal-replay",
          "a JournalReplay stream is single-consumer and cannot be iterated twice",
        ),
      }));
      return;
    }
    this.started = true;
    let count = 0;
    let finished = false;
    try {
      if (!validDirectoryArgument(this.journalDirInput)) {
        finished = true;
        this.finish(Object.freeze({
          kind: "error",
          error: journalError(
            "invalid-argument",
            "feedback",
            "replay-journal",
            "journalDir must be a nonempty filesystem path without NUL bytes",
          ),
        }));
        return;
      }
      const scanned = await buildJournalScanPlan(resolve(this.journalDirInput));
      if (scanned.kind === "error") {
        finished = true;
        this.finish(Object.freeze({ error: scanned.error, kind: "error" }));
        return;
      }
      for await (const step of replayPlanSteps(scanned.plan)) {
        if (step.kind === "error") {
          finished = true;
          this.finish(Object.freeze({ error: step.error, kind: "error" }));
          return;
        }
        count += 1;
        yield step.record;
      }
      finished = true;
      this.finish(Object.freeze({ kind: "complete", recordCount: count }));
    } catch (error: unknown) {
      finished = true;
      this.finish(Object.freeze({
        kind: "error",
        error: journalIoError("iterate-journal-replay", null, error),
      }));
    } finally {
      if (!finished) {
        this.finish(Object.freeze({
          kind: "error",
          error: journalError(
            "invalid-argument",
            "feedback",
            "iterate-journal-replay",
            "journal replay ended before the snapshotted prefix was fully consumed",
          ),
        }));
      }
    }
  }
}

export function replayJournal(journalDirInput: string): JournalReplay {
  return new ReplayStream(journalDirInput);
}
