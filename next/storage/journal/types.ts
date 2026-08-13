import type { JournalRecord } from "../../authority/protocol/journal-record.capsule.js";

/** Twenty decimal digits encode the complete unsigned-u64 epoch domain. */
export type JournalEpoch = string;

export type JournalErrorCode =
  | "closed-handle"
  | "contended"
  | "corrupt-chain"
  | "corrupt-control"
  | "corrupt-crc"
  | "corrupt-frame"
  | "corrupt-layout"
  | "decision-fact-root-mismatch"
  | "semantic-root-mismatch"
  | "epoch-exhausted"
  | "invalid-argument"
  | "io-denied"
  | "io-full"
  | "io-failure"
  | "missing-segment"
  | "observer-failure"
  | "record-too-large"
  | "superseded"
  | "unknown-handle";

export type JournalErrorDisposition = "contended" | "fatal" | "feedback" | "resume";

export interface JournalError {
  readonly code: JournalErrorCode;
  readonly disposition: JournalErrorDisposition;
  readonly message: string;
  readonly operation: string;
  readonly path: string | null;
  readonly epoch: JournalEpoch | null;
  readonly systemCode: string | null;
}

export type JournalDurabilityPoint =
  | "epoch-scan-complete"
  | "claim-created"
  | "claim-file-synced"
  | "claim-directory-synced"
  | "tail-truncated"
  | "tail-truncate-synced"
  | "segment-created"
  | "segment-file-synced"
  | "segment-directory-synced"
  | "segment-before-first-frame"
  | "frame-mid-write"
  | "frame-written"
  | "frame-datasynced";

export interface JournalDurabilityEvent {
  readonly point: JournalDurabilityPoint;
  readonly epoch: JournalEpoch;
  readonly frameType: "control" | "record" | null;
  readonly path: string;
}

export type JournalDurabilityObserver = (
  event: JournalDurabilityEvent,
) => void | Promise<void>;

export interface JournalOpenOptions {
  /** Bounded retry count for an exclusive-create visibility race. Default: 8. */
  readonly claimRetryLimit?: number;
  /** Optional durability-point observer used by the real-filesystem fault suite. */
  readonly durabilityObserver?: JournalDurabilityObserver;
}

/**
 * An opaque writer capability. A handle remains bound to one epoch and one
 * segment for its entire lifetime. A successor never retargets this handle.
 */
export interface JournalWriterHandle {
  readonly epoch: JournalEpoch;
  readonly segmentPath: string;
}

export type JournalOpenResult =
  | { readonly kind: "acquired"; readonly handle: JournalWriterHandle }
  | {
      readonly kind: "contended";
      readonly attemptedEpoch: JournalEpoch;
      readonly currentEpoch: JournalEpoch;
      readonly error: JournalError;
    }
  | { readonly kind: "error"; readonly error: JournalError };

export type JournalAppendResult =
  | {
      readonly kind: "acknowledged";
      readonly epoch: JournalEpoch;
      readonly endByteLength: string;
      readonly chainHash: string;
    }
  | { readonly kind: "rejected"; readonly error: JournalError };

export type JournalCloseResult =
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly error: JournalError };

export interface JournalReadOnly {
  /** Snapshot observation. It intentionally does not refresh and may be stale. */
  readonly currentEpoch: () => JournalEpoch | null;
}

export type JournalReadOnlyOpenResult =
  | { readonly kind: "opened"; readonly journal: JournalReadOnly }
  | { readonly kind: "error"; readonly error: JournalError };

export type JournalReplayCompletion =
  | { readonly kind: "complete"; readonly recordCount: number }
  | { readonly kind: "error"; readonly error: JournalError };

/**
 * Replay validates the complete snapshot before yielding its first record,
 * then decodes the immutable prefixes a second time. Iteration never throws an I/O or
 * corruption exception: such a failure ends the stream and resolves
 * `completion` to a typed error. Consumers must inspect `completion` after the
 * `for await` loop.
 */
export interface JournalReplay extends AsyncIterable<JournalRecord> {
  readonly completion: Promise<JournalReplayCompletion>;
}
