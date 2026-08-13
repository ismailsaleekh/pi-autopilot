/*
 * Tree manifest v1 is a streaming deterministic wire format:
 *
 *   ASCII "PI-AUTOPILOT-TREE-MANIFEST-V1\n"
 *   repeated [u32 canonical-entry-length, big-endian][canonical entry bytes]
 *
 * Entries use component-wise ECMAScript code-unit order with parents before
 * descendants, so a reader validates topology with memory bounded by depth.
 * The root directory is path "" and appears first. Each entry payload uses the
 * W0 canonical codec; JSON.stringify is never used. Framing lets walkTree and
 * materializeTree consume one bounded entry at a time rather than loading an
 * unbounded manifest object.
 */

import { Buffer } from "node:buffer";
import {
  artifactRootSchema,
  digestSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ArtifactRoot,
  Digest,
} from "../../authority/protocol/identifiers.js";
import {
  defineCapsule,
  literal,
  natural,
  object,
  text,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { casError } from "./errors.js";
import type { CasError, TreeEntry } from "./types.js";

export const TREE_MANIFEST_MAGIC = Buffer.from("PI-AUTOPILOT-TREE-MANIFEST-V1\n", "ascii");
export const TREE_ENTRY_HEADER_BYTES = 4;
export const CAS_U64_WIDTH = 20;
export const CAS_U64_MAX = 18_446_744_073_709_551_615n;

const blobRefSchema = object({
  byteLength: text("plain"),
  digest: digestSchema,
});

const directoryEntrySchema = object({
  kind: literal("directory"),
  mode: natural(),
  path: text("plain"),
});

const fileEntrySchema = object({
  blob: blobRefSchema,
  kind: literal("file"),
  mode: natural(),
  path: text("plain"),
});

const symlinkEntrySchema = object({
  kind: literal("symlink"),
  mode: natural(),
  path: text("plain"),
  target: text("plain"),
});

const treeEntrySchema = union([
  directoryEntrySchema,
  fileEntrySchema,
  symlinkEntrySchema,
]);

const treeEntryCapsule = defineCapsule("CasTreeEntryV1", treeEntrySchema);
const digestCapsule = defineCapsule("CasDigest", digestSchema);
const artifactRootCapsule = defineCapsule("CasArtifactRoot", artifactRootSchema);

export type WireTreeEntry = Infer<typeof treeEntrySchema>;

export type ManifestEntryEncodeResult =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "error"; readonly error: CasError };

export type ManifestEntryDecodeResult =
  | { readonly kind: "ok"; readonly entry: TreeEntry }
  | { readonly kind: "error"; readonly error: CasError };

export function formatCasU64(value: bigint): string | null {
  if (value < 0n || value > CAS_U64_MAX) {
    return null;
  }
  return value.toString(10).padStart(CAS_U64_WIDTH, "0");
}

export function parseCasU64(value: string): bigint | null {
  if (value.length !== CAS_U64_WIDTH) {
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
    return parsed <= CAS_U64_MAX && formatCasU64(parsed) === value ? parsed : null;
  } catch {
    return null;
  }
}

export function validManifestPath(path: string, allowRoot: boolean): boolean {
  if (path === "") {
    return allowRoot;
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\u0000")) {
    return false;
  }
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      return false;
    }
  }
  return true;
}

function validateEntry(entry: TreeEntry): string | null {
  if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
    return "tree entry mode must be an integer from 0000 through 07777";
  }
  if (!validManifestPath(entry.path, entry.kind === "directory")) {
    return "tree entry path must be a normalized relative slash path";
  }
  if (entry.path === "" && entry.kind !== "directory") {
    return "only the root directory may use the empty path";
  }
  if (entry.kind === "file" && parseCasU64(entry.blob.byteLength) === null) {
    return "blob byteLength must be zero-padded unsigned-u64 decimal text";
  }
  return null;
}

export function encodeTreeEntry(entry: TreeEntry): ManifestEntryEncodeResult {
  const invalid = validateEntry(entry);
  if (invalid !== null) {
    return Object.freeze({
      kind: "error",
      error: casError("manifest-corrupt", "fatal", "encode-tree-entry", invalid, entry.path),
    });
  }
  const encoded = treeEntryCapsule.encodeUnknown(entry);
  if (encoded.kind === "error") {
    return Object.freeze({
      kind: "error",
      error: casError(
        "manifest-corrupt",
        "fatal",
        "encode-tree-entry",
        encoded.error.diagnostic,
        entry.path,
      ),
    });
  }
  return Object.freeze({ kind: "ok", bytes: encoded.value });
}

export function decodeTreeEntry(
  bytes: Uint8Array,
  manifestPath: string,
): ManifestEntryDecodeResult {
  const decoded = treeEntryCapsule.decodeCanonical(bytes);
  if (decoded.kind === "error") {
    return Object.freeze({
      kind: "error",
      error: casError(
        "manifest-corrupt",
        "fatal",
        "decode-tree-entry",
        decoded.error.diagnostic,
        manifestPath,
      ),
    });
  }
  const invalid = validateEntry(decoded.value);
  if (invalid !== null) {
    return Object.freeze({
      kind: "error",
      error: casError("manifest-corrupt", "fatal", "decode-tree-entry", invalid, manifestPath),
    });
  }
  return Object.freeze({ kind: "ok", entry: decoded.value });
}

export function frameTreeEntry(bytes: Uint8Array): Buffer | null {
  if (bytes.byteLength > 0xffff_ffff) {
    return null;
  }
  const output = Buffer.alloc(TREE_ENTRY_HEADER_BYTES + bytes.byteLength);
  output.writeUInt32BE(bytes.byteLength, 0);
  Buffer.from(bytes).copy(output, TREE_ENTRY_HEADER_BYTES);
  return output;
}

export function parseDigest(value: string): Digest | null {
  const decoded = digestCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}

export function parseArtifactRoot(value: string): ArtifactRoot | null {
  const decoded = artifactRootCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}

export function treeCursor(root: ArtifactRoot, offset: bigint): string | null {
  const encodedOffset = formatCasU64(offset);
  if (encodedOffset === null) {
    return null;
  }
  return `tree-cursor-v1:${String(root).slice(7)}:${encodedOffset}`;
}

export function parseTreeCursor(root: ArtifactRoot, cursor: string): bigint | null {
  const prefix = `tree-cursor-v1:${String(root).slice(7)}:`;
  if (!cursor.startsWith(prefix)) {
    return null;
  }
  return parseCasU64(cursor.slice(prefix.length));
}
