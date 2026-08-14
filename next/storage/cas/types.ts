import type {
  ArtifactPath,
  ArtifactRef,
  ArtifactRoot,
  KindId,
  Digest,
} from "../../authority/protocol/identifiers.js";

export interface BlobRef {
  readonly digest: Digest;
  /** Unsigned-u64 decimal text, preserving sizes outside JS safe integers. */
  readonly byteLength: string;
}

export interface BlobByteRange {
  readonly offset: number;
  readonly length: number;
}

export type TreeEntry =
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly mode: number;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly mode: number;
      readonly blob: BlobRef;
    }
  | {
      readonly kind: "symlink";
      readonly path: string;
      readonly mode: number;
      readonly target: string;
    };

export type CasErrorCode =
  | "blob-corrupt"
  | "blob-not-found"
  | "destination-exists"
  | "digest-collision"
  | "invalid-argument"
  | "invalid-cursor"
  | "io-denied"
  | "io-full"
  | "io-failure"
  | "manifest-corrupt"
  | "observer-failure"
  | "source-changed"
  | "unsupported-entry"
  | "unknown-store";

export type CasErrorDisposition = "fatal" | "feedback" | "resume";

export interface CasError {
  readonly code: CasErrorCode;
  readonly disposition: CasErrorDisposition;
  readonly message: string;
  readonly operation: string;
  readonly path: string | null;
  readonly systemCode: string | null;
}

export type CasDurabilityPoint =
  | "temp-created"
  | "temp-mid-write"
  | "temp-written"
  | "temp-synced"
  | "before-rename"
  | "after-rename"
  | "parent-directory-synced";

export interface CasDurabilityEvent {
  readonly point: CasDurabilityPoint;
  readonly objectKind: "blob" | "tree";
  readonly path: string;
  readonly digest: Digest | null;
}

export type CasDurabilityObserver = (
  event: CasDurabilityEvent,
) => void | Promise<void>;

export interface CasOpenOptions {
  /** Optional internal durability observer used by the real-filesystem suite. */
  readonly durabilityObserver?: CasDurabilityObserver;
}

/** Opaque process-local capability for one CAS root. */
export interface ContentAddressedStore {
  readonly root: string;
}

export type CasOpenResult =
  | { readonly kind: "opened"; readonly store: ContentAddressedStore }
  | { readonly kind: "error"; readonly error: CasError };

export type PutBlobResult =
  | {
      readonly kind: "stored";
      readonly ref: BlobRef;
      readonly alreadyPresent: boolean;
    }
  | { readonly kind: "error"; readonly error: CasError };

export type CaptureTreeResult =
  | {
      readonly kind: "captured";
      readonly root: ArtifactRoot;
      readonly entryCount: number;
      readonly alreadyPresent: boolean;
    }
  | { readonly kind: "error"; readonly error: CasError };

export type CasReadCompletion =
  | { readonly kind: "complete"; readonly byteLength: number }
  | { readonly kind: "error"; readonly error: CasError };

export interface CasByteStream extends AsyncIterable<Uint8Array> {
  readonly completion: Promise<CasReadCompletion>;
  /** Releases the verified object handle when a caller chooses not to iterate. */
  readonly close: () => Promise<CasReadCompletion>;
}

export type ReadBlobResult =
  | { readonly kind: "ready"; readonly bytes: CasByteStream }
  | { readonly kind: "error"; readonly error: CasError };

export interface WalkTreePage {
  readonly entries: readonly TreeEntry[];
  readonly nextCursor: string | null;
}

export type WalkTreeResult =
  | { readonly kind: "page"; readonly value: WalkTreePage }
  | { readonly kind: "error"; readonly error: CasError };

export type MaterializeTreeResult =
  | { readonly kind: "materialized"; readonly destination: string }
  | { readonly kind: "error"; readonly error: CasError };

export type CanonicalTreeSourceEntry =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly mode: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "symlink";
      readonly path: string;
      readonly mode: number;
      readonly target: string;
    };

export interface CanonicalArtifactInstallRequest {
  readonly bytes: Uint8Array;
  readonly codec: KindId;
  readonly codecVersion: KindId;
  readonly path: ArtifactPath;
}

export interface CanonicalArtifactInstaller {
  readonly install: (request: CanonicalArtifactInstallRequest) => Promise<CanonicalArtifactInstallResult>;
  readonly installTree: (entries: readonly CanonicalTreeSourceEntry[]) => Promise<CanonicalTreeInstallResult>;
  readonly read: (reference: ArtifactRef, maxBytes: number) => Promise<CanonicalArtifactReadResult>;
}

export type CanonicalArtifactInstallResult =
  | {
      readonly kind: "installed";
      readonly alreadyPresent: boolean;
      readonly reference: ArtifactRef;
    }
  | { readonly kind: "error"; readonly error: CasError };

export type CanonicalTreeInstallResult =
  | {
      readonly kind: "installed";
      readonly alreadyPresent: boolean;
      readonly root: ArtifactRoot;
    }
  | { readonly kind: "error"; readonly error: CasError };

export type CanonicalArtifactReadResult =
  | { readonly kind: "read"; readonly bytes: Uint8Array }
  | { readonly kind: "error"; readonly error: CasError };
