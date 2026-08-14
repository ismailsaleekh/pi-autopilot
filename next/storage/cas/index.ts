/*
 * CAS durability contract (Linux/macOS local filesystems): every object is
 * written to a same-filesystem temp, fully written, fsync'd, atomically renamed
 * to its digest path, and acknowledged only after the target parent directory
 * is fsync'd. Node has no F_FULLFSYNC binding; as with the journal, certification
 * covers process crash/SIGKILL under fsync semantics, not every device's
 * sudden-power-loss cache behavior. Presence is never workflow authority: the
 * journal decides reachability, while CAS reads independently verify digest.
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  artifactRefSchema,
  casBlobIdSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ArtifactRef,
  ArtifactRoot,
  Digest,
} from "../../authority/protocol/identifiers.js";
import { defineCapsule, digestBytes } from "../../authority/protocol/schema.js";
import { casError, casIoError, casSystemCode } from "./errors.js";
import {
  CAS_U64_MAX,
  TREE_ENTRY_HEADER_BYTES,
  TREE_MANIFEST_MAGIC,
  decodeTreeEntry,
  encodeTreeEntry,
  formatCasU64,
  frameTreeEntry,
  parseArtifactRoot,
  parseCasU64,
  parseDigest,
  parseTreeCursor,
  treeCursor,
  validManifestPath,
} from "./manifest.js";
import type {
  BlobByteRange,
  BlobRef,
  CanonicalArtifactInstallRequest,
  CanonicalArtifactInstallResult,
  CanonicalArtifactInstaller,
  CanonicalArtifactReadResult,
  CanonicalTreeInstallResult,
  CanonicalTreeSourceEntry,
  CaptureTreeResult,
  CasByteStream,
  CasDurabilityEvent,
  CasDurabilityObserver,
  CasError,
  CasOpenOptions,
  CasOpenResult,
  CasReadCompletion,
  ContentAddressedStore,
  MaterializeTreeResult,
  PutBlobResult,
  ReadBlobResult,
  TreeEntry,
  WalkTreeResult,
} from "./types.js";

export type {
  BlobByteRange,
  BlobRef,
  CanonicalArtifactInstallRequest,
  CanonicalArtifactInstallResult,
  CanonicalArtifactInstaller,
  CanonicalArtifactReadResult,
  CanonicalTreeInstallResult,
  CanonicalTreeSourceEntry,
  CaptureTreeResult,
  CasByteStream,
  CasDurabilityEvent,
  CasDurabilityObserver,
  CasDurabilityPoint,
  CasError,
  CasErrorCode,
  CasErrorDisposition,
  CasOpenOptions,
  CasOpenResult,
  CasReadCompletion,
  ContentAddressedStore,
  MaterializeTreeResult,
  PutBlobResult,
  ReadBlobResult,
  TreeEntry,
  WalkTreePage,
  WalkTreeResult,
} from "./types.js";

export { CAS_U64_WIDTH, TREE_MANIFEST_MAGIC } from "./manifest.js";

const IO_CHUNK_BYTES = 64 * 1024;
const MAX_WALK_PAGE_SIZE = 1024;
const MAX_TREE_ENTRY_PAYLOAD_BYTES = 1024 * 1024;
const canonicalArtifactRefCapsule = defineCapsule("CasCanonicalArtifactRef", artifactRefSchema);
const canonicalBlobIdCapsule = defineCapsule("CasCanonicalBlobId", casBlobIdSchema);

interface StoreState {
  readonly root: string;
  readonly blobRoot: string;
  readonly treeRoot: string;
  readonly tempRoot: string;
  readonly observer: CasDurabilityObserver | null;
}

const storeStates = new WeakMap<ContentAddressedStore, StoreState>();

type StoreLookup =
  | { readonly kind: "ok"; readonly state: StoreState }
  | { readonly kind: "error"; readonly error: CasError };

type InstallObjectResult =
  | {
      readonly kind: "stored";
      readonly digest: Digest;
      readonly byteLength: bigint;
      readonly alreadyPresent: boolean;
      readonly path: string;
    }
  | { readonly kind: "error"; readonly error: CasError };

type OpenVerifiedObjectResult =
  | { readonly kind: "ok"; readonly byteLength: bigint; readonly file: FileHandle }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly error: CasError };

type VerifyObjectResult =
  | { readonly kind: "ok"; readonly byteLength: bigint }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly error: CasError };

interface CollectedTree {
  readonly entries: readonly TreeEntry[];
}

type CollectTreeResult =
  | { readonly kind: "ok"; readonly tree: CollectedTree }
  | { readonly kind: "error"; readonly error: CasError };

function validPathArgument(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function compareManifestPaths(left: string, right: string): number {
  const leftParts = left === "" ? [] : left.split("/");
  const rightParts = right === "" ? [] : right.split("/");
  const sharedLength = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart !== undefined && rightPart !== undefined) {
      const comparison = compareText(leftPart, rightPart);
      if (comparison !== 0) {
        return comparison;
      }
    }
  }
  return leftParts.length - rightParts.length;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function finalizeDirectory(path: string, mode: number): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.chmod(mode);
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (casSystemCode(error) !== "EEXIST") {
      throw error;
    }
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) {
      throw new Error(`${path} is not a real directory`);
    }
  }
}

function lookupStore(store: ContentAddressedStore): StoreLookup {
  const state = storeStates.get(store);
  if (state === undefined) {
    return Object.freeze({
      kind: "error",
      error: casError(
        "unknown-store",
        "feedback",
        "use-cas",
        "store capability was not minted by openCas in this process",
      ),
    });
  }
  return Object.freeze({ kind: "ok", state });
}

function durabilityEvent(
  point: CasDurabilityEvent["point"],
  objectKind: "blob" | "tree",
  path: string,
  digest: Digest | null,
): CasDurabilityEvent {
  return Object.freeze({ digest, objectKind, path, point });
}

async function notify(
  observer: CasDurabilityObserver | null,
  event: CasDurabilityEvent,
): Promise<CasError | null> {
  if (observer === null) {
    return null;
  }
  try {
    await observer(event);
    return null;
  } catch (error: unknown) {
    const code = casSystemCode(error);
    if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG") {
      return casIoError(`observe-${event.point}`, event.path, error);
    }
    return casError(
      "observer-failure",
      "resume",
      `observe-${event.point}`,
      "CAS durability observer failed before the operation could acknowledge",
      event.path,
      code,
    );
  }
}

async function openCasInternal(
  rootInput: string,
  options?: CasOpenOptions,
): Promise<CasOpenResult> {
  if (!validPathArgument(rootInput)) {
    return Object.freeze({
      kind: "error",
      error: casError(
        "invalid-argument",
        "feedback",
        "open-cas",
        "CAS root must be a nonempty filesystem path without NUL bytes",
      ),
    });
  }
  const root = resolve(rootInput);
  const blobContainer = join(root, "blobs");
  const treeContainer = join(root, "trees");
  const blobRoot = join(blobContainer, "sha256");
  const treeRoot = join(treeContainer, "sha256");
  const tempRoot = join(root, "tmp");
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStatus = await lstat(root);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      return Object.freeze({
        kind: "error",
        error: casError(
          "io-failure",
          "fatal",
          "open-cas",
          "CAS root must be a real directory, not a symlink",
          root,
        ),
      });
    }
    await syncDirectory(dirname(root));
    await ensureRealDirectory(blobContainer);
    await ensureRealDirectory(treeContainer);
    await ensureRealDirectory(tempRoot);
    await syncDirectory(root);
    await ensureRealDirectory(blobRoot);
    await ensureRealDirectory(treeRoot);
    await syncDirectory(blobContainer);
    await syncDirectory(treeContainer);
    const store: ContentAddressedStore = Object.freeze({ root });
    storeStates.set(store, Object.freeze({
      blobRoot,
      observer: options?.durabilityObserver ?? null,
      root,
      tempRoot,
      treeRoot,
    }));
    return Object.freeze({ kind: "opened", store });
  } catch (error: unknown) {
    return Object.freeze({ kind: "error", error: casIoError("open-cas", root, error) });
  }
}

export async function openCas(
  rootInput: string,
  options?: CasOpenOptions,
): Promise<CasOpenResult> {
  try {
    return await openCasInternal(rootInput, options);
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: casIoError(
        "open-cas",
        typeof rootInput === "string" ? rootInput : null,
        error,
      ),
    });
  }
}

function digestPath(
  state: StoreState,
  digest: Digest | ArtifactRoot,
  objectKind: "blob" | "tree",
): string {
  const hex = String(digest).slice(7);
  const base = objectKind === "blob" ? state.blobRoot : state.treeRoot;
  const suffix = objectKind === "blob" ? hex.slice(2) : `${hex.slice(2)}.tree`;
  return join(base, hex.slice(0, 2), suffix);
}

async function ensureDigestParent(path: string, base: string): Promise<void> {
  const parent = dirname(path);
  await ensureRealDirectory(parent);
  await syncDirectory(base);
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

async function openVerifiedObject(
  path: string,
  digest: Digest | ArtifactRoot,
  expectedByteLength: bigint | null,
): Promise<OpenVerifiedObjectResult> {
  let file: FileHandle | null = null;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const objectStatus = await file.stat({ bigint: true });
    if (!objectStatus.isFile()) {
      await file.close();
      file = null;
      return Object.freeze({
        kind: "error",
        error: casError(
          "blob-corrupt",
          "fatal",
          "verify-cas-object",
          "CAS digest path must be a regular file and never a symlink",
          path,
        ),
      });
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(IO_CHUNK_BYTES);
    let byteLength = 0n;
    while (true) {
      const result = await file.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      byteLength += BigInt(result.bytesRead);
    }
    const actual = parseDigest(`sha256:${hash.digest("hex")}`);
    if (
      actual === null
      || String(actual) !== String(digest)
      || (expectedByteLength !== null && byteLength !== expectedByteLength)
    ) {
      await file.close();
      file = null;
      return Object.freeze({
        kind: "error",
        error: casError(
          "blob-corrupt",
          "fatal",
          "verify-cas-object",
          "CAS object bytes do not match their digest path or declared byte length",
          path,
        ),
      });
    }
    const verifiedFile = file;
    file = null;
    return Object.freeze({ byteLength, file: verifiedFile, kind: "ok" });
  } catch (error: unknown) {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // The primary typed result below remains authoritative.
      }
    }
    const code = casSystemCode(error);
    if (code === "ENOENT") {
      return Object.freeze({ kind: "missing" });
    }
    if (code === "ELOOP") {
      return Object.freeze({
        kind: "error",
        error: casError(
          "blob-corrupt",
          "fatal",
          "verify-cas-object",
          "CAS digest path must not be a symlink",
          path,
          code,
        ),
      });
    }
    return Object.freeze({ kind: "error", error: casIoError("verify-cas-object", path, error) });
  }
}

async function verifyObject(
  path: string,
  digest: Digest | ArtifactRoot,
  expectedByteLength: bigint | null,
): Promise<VerifyObjectResult> {
  const opened = await openVerifiedObject(path, digest, expectedByteLength);
  if (opened.kind !== "ok") {
    return opened;
  }
  try {
    await opened.file.close();
    return Object.freeze({ byteLength: opened.byteLength, kind: "ok" });
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: casIoError("close-verified-cas-object", path, error),
    });
  }
}

async function installObject(
  state: StoreState,
  objectKind: "blob" | "tree",
  chunks: AsyncIterable<Uint8Array>,
): Promise<InstallObjectResult> {
  let tempPath: string;
  try {
    tempPath = join(
      state.tempRoot,
      `${objectKind}.${String(process.pid)}.${randomBytes(16).toString("hex")}.tmp`,
    );
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: casIoError("create-cas-temp-name", state.tempRoot, error),
    });
  }
  let file: FileHandle | null = null;
  let renamed = false;
  let targetPath: string | null = null;
  try {
    file = await open(tempPath, "wx", 0o600);
    const created = await notify(
      state.observer,
      durabilityEvent("temp-created", objectKind, tempPath, null),
    );
    if (created !== null) {
      await file.close();
      file = null;
      return Object.freeze({ kind: "error", error: created });
    }
    const hash = createHash("sha256");
    let byteLength = 0n;
    let middleObserved = false;
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) {
        return Object.freeze({
          kind: "error",
          error: casError(
            "invalid-argument",
            "feedback",
            "put-cas-object",
            "blob stream must yield Uint8Array chunks",
            tempPath,
          ),
        });
      }
      const ownedChunk = Buffer.from(chunk);
      if (ownedChunk.byteLength === 0) {
        continue;
      }
      if (byteLength + BigInt(ownedChunk.byteLength) > CAS_U64_MAX) {
        return Object.freeze({
          kind: "error",
          error: casError(
            "invalid-argument",
            "feedback",
            "put-cas-object",
            "CAS object exceeds the unsigned-u64 byte-length wire domain",
            tempPath,
          ),
        });
      }
      if (!middleObserved) {
        const midpoint = Math.max(1, Math.floor(ownedChunk.byteLength / 2));
        const first = ownedChunk.subarray(0, midpoint);
        const second = ownedChunk.subarray(midpoint);
        await writeAll(file, first);
        hash.update(first);
        byteLength += BigInt(first.byteLength);
        const middle = await notify(
          state.observer,
          durabilityEvent("temp-mid-write", objectKind, tempPath, null),
        );
        if (middle !== null) {
          return Object.freeze({ kind: "error", error: middle });
        }
        middleObserved = true;
        if (second.byteLength > 0) {
          await writeAll(file, second);
          hash.update(second);
          byteLength += BigInt(second.byteLength);
        }
      } else {
        await writeAll(file, ownedChunk);
        hash.update(ownedChunk);
        byteLength += BigInt(ownedChunk.byteLength);
      }
    }
    const written = await notify(
      state.observer,
      durabilityEvent("temp-written", objectKind, tempPath, null),
    );
    if (written !== null) {
      return Object.freeze({ kind: "error", error: written });
    }
    await file.sync();
    const digest = parseDigest(`sha256:${hash.digest("hex")}`);
    if (digest === null) {
      return Object.freeze({
        kind: "error",
        error: casError(
          "io-failure",
          "fatal",
          "put-cas-object",
          "SHA-256 implementation returned an invalid digest",
          tempPath,
        ),
      });
    }
    const synced = await notify(
      state.observer,
      durabilityEvent("temp-synced", objectKind, tempPath, digest),
    );
    if (synced !== null) {
      return Object.freeze({ kind: "error", error: synced });
    }
    await file.close();
    file = null;
    targetPath = digestPath(state, digest, objectKind);
    await ensureDigestParent(
      targetPath,
      objectKind === "blob" ? state.blobRoot : state.treeRoot,
    );
    const existing = await verifyObject(targetPath, digest, byteLength);
    if (existing.kind === "ok") {
      await unlink(tempPath);
      await syncDirectory(state.tempRoot);
      await syncDirectory(dirname(targetPath));
      const existingDirectorySynced = await notify(
        state.observer,
        durabilityEvent(
          "parent-directory-synced",
          objectKind,
          dirname(targetPath),
          digest,
        ),
      );
      if (existingDirectorySynced !== null) {
        return Object.freeze({ kind: "error", error: existingDirectorySynced });
      }
      return Object.freeze({
        alreadyPresent: true,
        byteLength,
        digest,
        kind: "stored",
        path: targetPath,
      });
    }
    if (existing.kind === "error") {
      if (existing.error.code !== "blob-corrupt") {
        return existing;
      }
      return Object.freeze({
        kind: "error",
        error: casError(
          "digest-collision",
          "fatal",
          "put-cas-object",
          "digest path already exists with different bytes",
          targetPath,
        ),
      });
    }
    const beforeRename = await notify(
      state.observer,
      durabilityEvent("before-rename", objectKind, tempPath, digest),
    );
    if (beforeRename !== null) {
      return Object.freeze({ kind: "error", error: beforeRename });
    }
    await rename(tempPath, targetPath);
    renamed = true;
    const afterRename = await notify(
      state.observer,
      durabilityEvent("after-rename", objectKind, targetPath, digest),
    );
    if (afterRename !== null) {
      return Object.freeze({ kind: "error", error: afterRename });
    }
    await syncDirectory(dirname(targetPath));
    const directorySynced = await notify(
      state.observer,
      durabilityEvent("parent-directory-synced", objectKind, dirname(targetPath), digest),
    );
    if (directorySynced !== null) {
      return Object.freeze({ kind: "error", error: directorySynced });
    }
    return Object.freeze({
      alreadyPresent: false,
      byteLength,
      digest,
      kind: "stored",
      path: targetPath,
    });
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: casIoError("put-cas-object", targetPath ?? tempPath, error),
    });
  } finally {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // The operation result remains authoritative.
      }
    }
    if (!renamed) {
      try {
        await unlink(tempPath);
        await syncDirectory(state.tempRoot);
      } catch (cleanupError: unknown) {
        if (casSystemCode(cleanupError) !== "ENOENT") {
          // Orphan temps are unreachable and never appear under a digest path.
        }
      }
    }
  }
}

function blobRef(digest: Digest, byteLength: bigint): BlobRef | null {
  const encodedLength = formatCasU64(byteLength);
  return encodedLength === null
    ? null
    : Object.freeze({ byteLength: encodedLength, digest });
}

export async function putBlob(
  store: ContentAddressedStore,
  stream: AsyncIterable<Uint8Array>,
): Promise<PutBlobResult> {
  const lookup = lookupStore(store);
  if (lookup.kind === "error") {
    return lookup;
  }
  try {
    const installed = await installObject(lookup.state, "blob", stream);
    if (installed.kind === "error") {
      return installed;
    }
    const ref = blobRef(installed.digest, installed.byteLength);
    if (ref === null) {
      return Object.freeze({
        kind: "error",
        error: casError(
          "invalid-argument",
          "feedback",
          "put-blob",
          "blob byte length exceeds unsigned-u64",
          installed.path,
        ),
      });
    }
    return Object.freeze({
      alreadyPresent: installed.alreadyPresent,
      kind: "stored",
      ref,
    });
  } catch (error: unknown) {
    return Object.freeze({ kind: "error", error: casIoError("put-blob", lookup.state.root, error) });
  }
}

class SourceChangedError extends Error {
  readonly code = "ESTALE";
}

async function* fileChunks(
  path: string,
  expected: BigIntStats,
): AsyncGenerator<Uint8Array> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (casSystemCode(error) === "ELOOP") {
      throw new SourceChangedError("source file became a symlink before capture");
    }
    throw error;
  }
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(expected, opened)) {
      throw new SourceChangedError("source file identity changed before capture");
    }
    const buffer = Buffer.alloc(IO_CHUNK_BYTES);
    while (true) {
      const result = await file.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) {
        break;
      }
      yield Buffer.from(buffer.subarray(0, result.bytesRead));
    }
    const completed = await file.stat({ bigint: true });
    if (!sameFileSnapshot(expected, completed)) {
      throw new SourceChangedError("source file changed during capture");
    }
  } finally {
    await file.close();
  }
}

function sameFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function collectDirectory(
  state: StoreState,
  sourceRoot: string,
  relativePath: string,
  output: TreeEntry[],
): Promise<CasError | null> {
  const absolute = relativePath === "" ? sourceRoot : join(sourceRoot, ...relativePath.split("/"));
  const before = await lstat(absolute, { bigint: true });
  if (!before.isDirectory()) {
    return casError(
      "source-changed",
      "resume",
      "capture-tree",
      "directory changed type during capture",
      absolute,
    );
  }
  output.push(Object.freeze({
    kind: "directory",
    mode: Number(before.mode & 0o7777n),
    path: relativePath,
  }));
  const initialEntries = await readdir(absolute, { withFileTypes: true });
  const names = initialEntries.map((entry) => entry.name).sort(compareText);
  for (const name of names) {
    if (!validManifestPath(name, false) || name.includes("/")) {
      return casError(
        "unsupported-entry",
        "feedback",
        "capture-tree",
        "filesystem entry name cannot be represented by tree manifest v1",
        join(absolute, name),
      );
    }
    const childRelative = relativePath === "" ? name : `${relativePath}/${name}`;
    const childAbsolute = join(absolute, name);
    const childBefore = await lstat(childAbsolute, { bigint: true });
    if (childBefore.isSymbolicLink()) {
      const target = await readlink(childAbsolute);
      const childAfter = await lstat(childAbsolute, { bigint: true });
      if (!sameFileSnapshot(childBefore, childAfter)) {
        return casError(
          "source-changed",
          "resume",
          "capture-tree",
          "symlink changed during capture",
          childAbsolute,
        );
      }
      output.push(Object.freeze({
        kind: "symlink",
        mode: Number(childBefore.mode & 0o7777n),
        path: childRelative,
        target,
      }));
    } else if (childBefore.isDirectory()) {
      const nestedError = await collectDirectory(state, sourceRoot, childRelative, output);
      if (nestedError !== null) {
        return nestedError;
      }
    } else if (childBefore.isFile()) {
      const installed = await installObject(
        state,
        "blob",
        fileChunks(childAbsolute, childBefore),
      );
      if (installed.kind === "error") {
        return installed.error;
      }
      const childAfter = await lstat(childAbsolute, { bigint: true });
      if (!sameFileSnapshot(childBefore, childAfter)) {
        return casError(
          "source-changed",
          "resume",
          "capture-tree",
          "file changed while its bytes were captured",
          childAbsolute,
        );
      }
      const ref = blobRef(installed.digest, installed.byteLength);
      if (ref === null) {
        return casError(
          "invalid-argument",
          "feedback",
          "capture-tree",
          "file exceeds unsigned-u64 byte length",
          childAbsolute,
        );
      }
      output.push(Object.freeze({
        blob: ref,
        kind: "file",
        mode: Number(childBefore.mode & 0o7777n),
        path: childRelative,
      }));
    } else {
      return casError(
        "unsupported-entry",
        "feedback",
        "capture-tree",
        "sockets, devices, and FIFOs are not tree-manifest entries",
        childAbsolute,
      );
    }
  }
  const finalNames = (await readdir(absolute)).slice().sort(compareText);
  if (names.length !== finalNames.length || names.some((name, index) => name !== finalNames[index])) {
    return casError(
      "source-changed",
      "resume",
      "capture-tree",
      "directory entries changed during capture",
      absolute,
    );
  }
  const after = await lstat(absolute, { bigint: true });
  return sameFileSnapshot(before, after)
    ? null
    : casError(
        "source-changed",
        "resume",
        "capture-tree",
        "directory metadata changed during capture",
        absolute,
      );
}

async function collectTree(state: StoreState, sourceDir: string): Promise<CollectTreeResult> {
  try {
    const status = await lstat(sourceDir, { bigint: true });
    if (!status.isDirectory() || status.isSymbolicLink()) {
      return Object.freeze({
        kind: "error",
        error: casError(
          "invalid-argument",
          "feedback",
          "capture-tree",
          "captureTree source must be a real directory and is never symlink-followed",
          sourceDir,
        ),
      });
    }
    const entries: TreeEntry[] = [];
    const collectionError = await collectDirectory(state, sourceDir, "", entries);
    if (collectionError !== null) {
      return Object.freeze({ kind: "error", error: collectionError });
    }
    entries.sort((left, right) => compareManifestPaths(left.path, right.path));
    return Object.freeze({
      kind: "ok",
      tree: Object.freeze({ entries: Object.freeze(entries) }),
    });
  } catch (error: unknown) {
    return Object.freeze({ kind: "error", error: casIoError("capture-tree", sourceDir, error) });
  }
}

async function* bytesChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes.slice();
}

async function installCanonicalTreeEntries(
  store: ContentAddressedStore,
  entries: readonly CanonicalTreeSourceEntry[],
): Promise<CanonicalTreeInstallResult> {
  const lookup = lookupStore(store);
  if (lookup.kind === "error") {
    return lookup;
  }
  const manifestEntries: TreeEntry[] = [Object.freeze({ kind: "directory", mode: 0o700, path: "" })];
  const directories = new Set<string>();
  let alreadyPresent = true;
  for (const entry of entries) {
    if (!validManifestPath(entry.path, false) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
      return Object.freeze({ kind: "error", error: casError("invalid-argument", "feedback", "install-canonical-tree", "canonical tree entry has an invalid path or mode") });
    }
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
    if (entry.kind === "file") {
      const installed = await installObject(lookup.state, "blob", bytesChunks(entry.bytes));
      if (installed.kind === "error") {
        return installed;
      }
      alreadyPresent = alreadyPresent && installed.alreadyPresent;
      const ref = blobRef(installed.digest, installed.byteLength);
      if (ref === null) {
        return Object.freeze({ kind: "error", error: casError("invalid-argument", "feedback", "install-canonical-tree", "canonical file exceeds the CAS byte-length domain") });
      }
      manifestEntries.push(Object.freeze({ blob: ref, kind: "file", mode: entry.mode, path: entry.path }));
    } else {
      manifestEntries.push(Object.freeze({ kind: "symlink", mode: entry.mode, path: entry.path, target: entry.target }));
    }
  }
  for (const path of directories) {
    manifestEntries.push(Object.freeze({ kind: "directory", mode: 0o700, path }));
  }
  manifestEntries.sort((left, right) => compareManifestPaths(left.path, right.path));
  for (let index = 1; index < manifestEntries.length; index += 1) {
    if (manifestEntries[index - 1]?.path === manifestEntries[index]?.path) {
      return Object.freeze({ kind: "error", error: casError("invalid-argument", "feedback", "install-canonical-tree", "canonical tree paths must be unique") });
    }
  }
  const installed = await installObject(lookup.state, "tree", manifestChunks(manifestEntries));
  if (installed.kind === "error") {
    return installed;
  }
  const root = parseArtifactRoot(String(installed.digest));
  return root === null
    ? Object.freeze({ kind: "error", error: casError("manifest-corrupt", "fatal", "install-canonical-tree", "tree digest could not be decoded as an ArtifactRoot") })
    : Object.freeze({ alreadyPresent: alreadyPresent && installed.alreadyPresent, kind: "installed", root });
}

async function* manifestChunks(entries: readonly TreeEntry[]): AsyncGenerator<Uint8Array> {
  yield TREE_MANIFEST_MAGIC;
  let previous: string | null = null;
  for (const entry of entries) {
    if (previous !== null && compareManifestPaths(entry.path, previous) <= 0) {
      throw new Error("tree entries are not strictly sorted");
    }
    const encoded = encodeTreeEntry(entry);
    if (encoded.kind === "error") {
      throw new Error(encoded.error.message);
    }
    const framed = frameTreeEntry(encoded.bytes);
    if (framed === null) {
      throw new Error("tree entry exceeds u32 framing");
    }
    yield framed;
    previous = entry.path;
  }
}

async function captureTreeInternal(
  store: ContentAddressedStore,
  sourceDirInput: string,
): Promise<CaptureTreeResult> {
  const lookup = lookupStore(store);
  if (lookup.kind === "error") {
    return lookup;
  }
  if (!validPathArgument(sourceDirInput)) {
    return Object.freeze({
      kind: "error",
      error: casError(
        "invalid-argument",
        "feedback",
        "capture-tree",
        "source directory must be a nonempty path without NUL bytes",
      ),
    });
  }
  const sourceDir = resolve(sourceDirInput);
  const collected = await collectTree(lookup.state, sourceDir);
  if (collected.kind === "error") {
    return collected;
  }
  const installed = await installObject(
    lookup.state,
    "tree",
    manifestChunks(collected.tree.entries),
  );
  if (installed.kind === "error") {
    return installed;
  }
  const root = parseArtifactRoot(String(installed.digest));
  if (root === null) {
    return Object.freeze({
      kind: "error",
      error: casError(
        "manifest-corrupt",
        "fatal",
        "capture-tree",
        "tree manifest digest is not an ArtifactRoot",
        installed.path,
      ),
    });
  }
  return Object.freeze({
    alreadyPresent: installed.alreadyPresent,
    entryCount: collected.tree.entries.length,
    kind: "captured",
    root,
  });
}

export async function captureTree(
  store: ContentAddressedStore,
  sourceDirInput: string,
): Promise<CaptureTreeResult> {
  try {
    return await captureTreeInternal(store, sourceDirInput);
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: casIoError(
        "capture-tree",
        typeof sourceDirInput === "string" ? sourceDirInput : null,
        error,
      ),
    });
  }
}

/** Installs exact caller-owned bytes as a deterministic CAS tree without a filesystem staging path. */
export async function installCanonicalTree(
  store: ContentAddressedStore,
  entries: readonly CanonicalTreeSourceEntry[],
): Promise<CanonicalTreeInstallResult> {
  try {
    if (!Array.isArray(entries)) {
      return Object.freeze({ kind: "error", error: casError("invalid-argument", "feedback", "install-canonical-tree", "entries must be a bounded array") });
    }
    return await installCanonicalTreeEntries(store, entries);
  } catch (error: unknown) {
    return Object.freeze({ kind: "error", error: casIoError("install-canonical-tree", store.root, error) });
  }
}

/** Canonical bytes become a real blob and containing tree before an ArtifactRef is returned. */
export async function installCanonicalArtifact(
  store: ContentAddressedStore,
  request: CanonicalArtifactInstallRequest,
): Promise<CanonicalArtifactInstallResult> {
  try {
    if (!(request.bytes instanceof Uint8Array)) {
      return Object.freeze({ kind: "error", error: casError("invalid-argument", "feedback", "install-canonical-artifact", "artifact bytes must be Uint8Array") });
    }
    const bytes = request.bytes.slice();
    const digest = digestBytes(bytes);
    const blob = canonicalBlobIdCapsule.decode(String(digest));
    if (blob.kind !== "ok") {
      return Object.freeze({ kind: "error", error: casError("invalid-argument", "fatal", "install-canonical-artifact", "canonical digest is not a CAS blob identity") });
    }
    const installed = await installCanonicalTreeEntries(store, Object.freeze([
      Object.freeze({ bytes, kind: "file", mode: 0o600, path: request.path }),
    ]));
    if (installed.kind === "error") {
      return installed;
    }
    const decoded = canonicalArtifactRefCapsule.decode(Object.freeze({
      blob: blob.value,
      byteLength: String(bytes.byteLength),
      codec: request.codec,
      codecVersion: request.codecVersion,
      digest,
      path: request.path,
      range: null,
      root: installed.root,
    }));
    return decoded.kind === "ok"
      ? Object.freeze({ alreadyPresent: installed.alreadyPresent, kind: "installed", reference: decoded.value })
      : Object.freeze({ kind: "error", error: casError("manifest-corrupt", "fatal", "install-canonical-artifact", decoded.error.diagnostic) });
  } catch (error: unknown) {
    return Object.freeze({ kind: "error", error: casIoError("install-canonical-artifact", store.root, error) });
  }
}

/** Reads and re-derives the deterministic containing tree, rejecting fabricated references. */
export async function readCanonicalArtifact(
  store: ContentAddressedStore,
  reference: ArtifactRef,
  maxBytes: number,
): Promise<CanonicalArtifactReadResult> {
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || reference.range !== null) {
      return Object.freeze({ kind: "error", error: casError("invalid-argument", "feedback", "read-canonical-artifact", "full artifact read requires a nonnegative safe bound and null range") });
    }
    const length = Number(reference.byteLength);
    const digest = parseDigest(String(reference.blob));
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes || digest === null || String(digest) !== String(reference.digest)) {
      return Object.freeze({ kind: "error", error: casError("invalid-argument", "feedback", "read-canonical-artifact", "artifact identity or byte bound is invalid") });
    }
    const ready = await readBlob(store, Object.freeze({ byteLength: formatCasU64(BigInt(length)) ?? "", digest }), Object.freeze({ length, offset: 0 }));
    if (ready.kind === "error") {
      return ready;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of ready.bytes) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        await ready.bytes.close();
        return Object.freeze({ kind: "error", error: casError("invalid-argument", "feedback", "read-canonical-artifact", "artifact exceeded its declared read bound") });
      }
      chunks.push(chunk.slice());
    }
    const completion = await ready.bytes.completion;
    if (completion.kind === "error") {
      return completion;
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
    if (String(digestBytes(bytes)) !== String(reference.digest)) {
      return Object.freeze({ kind: "error", error: casError("blob-corrupt", "fatal", "read-canonical-artifact", "artifact bytes differ from the declared digest") });
    }
    const installed = await installCanonicalArtifact(store, Object.freeze({ bytes, codec: reference.codec, codecVersion: reference.codecVersion, path: reference.path }));
    if (installed.kind === "error") {
      return installed;
    }
    const expected = canonicalArtifactRefCapsule.digest(reference);
    return canonicalArtifactRefCapsule.digest(installed.reference) === expected
      ? Object.freeze({ bytes: Uint8Array.from(bytes), kind: "read" })
      : Object.freeze({ kind: "error", error: casError("manifest-corrupt", "fatal", "read-canonical-artifact", "artifact containing tree or metadata was fabricated") });
  } catch (error: unknown) {
    return Object.freeze({ kind: "error", error: casIoError("read-canonical-artifact", store.root, error) });
  }
}

export function canonicalArtifactInstaller(store: ContentAddressedStore): CanonicalArtifactInstaller {
  return Object.freeze({
    install: (request: CanonicalArtifactInstallRequest) => installCanonicalArtifact(store, request),
    installTree: (entries: readonly CanonicalTreeSourceEntry[]) => installCanonicalTree(store, entries),
    read: (reference: ArtifactRef, maxBytes: number) => readCanonicalArtifact(store, reference, maxBytes),
  });
}

function safeArtifactRoot(value: unknown): ArtifactRoot | null {
  try {
    return parseArtifactRoot(String(value));
  } catch {
    return null;
  }
}

function validBlobRef(ref: BlobRef): { readonly digest: Digest; readonly byteLength: bigint } | null {
  if (typeof ref !== "object" || ref === null) {
    return null;
  }
  try {
    const digest = parseDigest(String(ref.digest));
    const byteLength = parseCasU64(ref.byteLength);
    return digest === null || byteLength === null
      ? null
      : Object.freeze({ byteLength, digest });
  } catch {
    return null;
  }
}

function validByteRange(
  value: BlobByteRange,
): { readonly offset: number; readonly length: number } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  try {
    return Number.isSafeInteger(value.offset)
      && Number.isSafeInteger(value.length)
      && value.offset >= 0
      && value.length >= 0
      ? Object.freeze({ length: value.length, offset: value.offset })
      : null;
  } catch {
    return null;
  }
}

class BlobReadStream implements CasByteStream {
  readonly completion: Promise<CasReadCompletion>;
  private readonly path: string;
  private readonly offset: bigint;
  private readonly byteLength: number;
  private file: FileHandle | null;
  private completionResolver: ((value: CasReadCompletion) => void) | null = null;
  private started = false;

  constructor(path: string, file: FileHandle, offset: bigint, byteLength: number) {
    this.path = path;
    this.file = file;
    this.offset = offset;
    this.byteLength = byteLength;
    this.completion = new Promise((resolveCompletion) => {
      this.completionResolver = resolveCompletion;
    });
  }

  private finish(value: CasReadCompletion): void {
    const resolver = this.completionResolver;
    if (resolver !== null) {
      this.completionResolver = null;
      resolver(value);
    }
  }

  async close(): Promise<CasReadCompletion> {
    const file = this.file;
    this.file = null;
    if (file !== null) {
      try {
        await file.close();
      } catch (error: unknown) {
        this.finish(Object.freeze({
          kind: "error",
          error: casIoError("close-blob-range", this.path, error),
        }));
        return this.completion;
      }
    }
    this.finish(Object.freeze({
      kind: "error",
      error: casError(
        "invalid-argument",
        "feedback",
        "read-blob-range",
        "verified blob range was closed before complete consumption",
        this.path,
      ),
    }));
    return this.completion;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.started) {
      this.finish(Object.freeze({
        kind: "error",
        error: casError(
          "invalid-argument",
          "feedback",
          "read-blob",
          "a ranged blob stream is single-consumer",
          this.path,
        ),
      }));
      return;
    }
    this.started = true;
    let file = this.file;
    let emitted = 0;
    let finished = false;
    try {
      if (file === null) {
        throw new Error("verified blob handle is already closed");
      }
      while (emitted < this.byteLength) {
        const requested = Math.min(IO_CHUNK_BYTES, this.byteLength - emitted);
        const buffer = Buffer.alloc(requested);
        let filled = 0;
        while (filled < requested) {
          const result = await file.read(
            buffer,
            filled,
            requested - filled,
            this.offset + BigInt(emitted + filled),
          );
          if (result.bytesRead === 0) {
            throw new Error("blob became shorter than its verified range");
          }
          filled += result.bytesRead;
        }
        emitted += requested;
        yield buffer;
      }
      await file.close();
      file = null;
      this.file = null;
      finished = true;
      this.finish(Object.freeze({ byteLength: emitted, kind: "complete" }));
    } catch (error: unknown) {
      finished = true;
      this.finish(Object.freeze({
        kind: "error",
        error: casIoError("read-blob-range", this.path, error),
      }));
    } finally {
      if (file !== null) {
        try {
          await file.close();
          this.file = null;
        } catch (error: unknown) {
          if (!finished) {
            finished = true;
            this.finish(Object.freeze({
              kind: "error",
              error: casIoError("close-blob-range", this.path, error),
            }));
          }
        }
      }
      if (!finished) {
        this.finish(Object.freeze({
          kind: "error",
          error: casError(
            "invalid-argument",
            "feedback",
            "read-blob-range",
            "blob range iteration ended before the requested bytes were consumed",
            this.path,
          ),
        }));
      }
    }
  }
}

export async function readBlob(
  store: ContentAddressedStore,
  ref: BlobRef,
  byteRange: BlobByteRange,
): Promise<ReadBlobResult> {
  const lookup = lookupStore(store);
  if (lookup.kind === "error") {
    return lookup;
  }
  const validatedRef = validBlobRef(ref);
  const validatedRange = validByteRange(byteRange);
  if (validatedRef === null || validatedRange === null) {
    return Object.freeze({
      kind: "error",
      error: casError(
        "invalid-argument",
        "feedback",
        "read-blob",
        "BlobRef and byteRange must be canonical; ranges require nonnegative safe integers",
      ),
    });
  }
  const offset = BigInt(validatedRange.offset);
  const end = offset + BigInt(validatedRange.length);
  if (end > validatedRef.byteLength) {
    return Object.freeze({
      kind: "error",
      error: casError(
        "invalid-argument",
        "feedback",
        "read-blob",
        "requested byte range extends beyond BlobRef byteLength",
      ),
    });
  }
  const path = digestPath(lookup.state, validatedRef.digest, "blob");
  const verified = await openVerifiedObject(path, validatedRef.digest, validatedRef.byteLength);
  if (verified.kind === "missing") {
    return Object.freeze({
      kind: "error",
      error: casError("blob-not-found", "resume", "read-blob", "blob is absent", path, "ENOENT"),
    });
  }
  if (verified.kind === "error") {
    return verified;
  }
  return Object.freeze({
    bytes: new BlobReadStream(path, verified.file, offset, validatedRange.length),
    kind: "ready",
  });
}

async function readExactAt(
  file: FileHandle,
  byteLength: number,
  position: bigint,
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(byteLength);
  let filled = 0;
  while (filled < byteLength) {
    const result = await file.read(buffer, filled, byteLength - filled, position + BigInt(filled));
    if (result.bytesRead === 0) {
      return null;
    }
    filled += result.bytesRead;
  }
  return buffer;
}

async function verifyManifestMagic(file: FileHandle, path: string): Promise<CasError | null> {
  const magic = await readExactAt(file, TREE_MANIFEST_MAGIC.byteLength, 0n);
  return magic !== null && magic.equals(TREE_MANIFEST_MAGIC)
    ? null
    : casError(
        "manifest-corrupt",
        "fatal",
        "walk-tree",
        "tree manifest magic/version is invalid",
        path,
      );
}

export async function walkTree(
  store: ContentAddressedStore,
  root: ArtifactRoot,
  cursor: string | null,
  pageSize: number = 256,
): Promise<WalkTreeResult> {
  const lookup = lookupStore(store);
  if (lookup.kind === "error") {
    return lookup;
  }
  const validatedRoot = safeArtifactRoot(root);
  if (
    validatedRoot === null
    || (cursor !== null && typeof cursor !== "string")
    || !Number.isSafeInteger(pageSize)
    || pageSize <= 0
    || pageSize > MAX_WALK_PAGE_SIZE
  ) {
    return Object.freeze({
      kind: "error",
      error: casError(
        "invalid-argument",
        "feedback",
        "walk-tree",
        `root must be canonical and pageSize must be 1 through ${String(MAX_WALK_PAGE_SIZE)}; narrow the page instead of requesting an unbounded listing`,
      ),
    });
  }
  const path = digestPath(lookup.state, validatedRoot, "tree");
  const verified = await openVerifiedObject(path, validatedRoot, null);
  if (verified.kind === "missing") {
    return Object.freeze({
      kind: "error",
      error: casError("blob-not-found", "resume", "walk-tree", "tree manifest is absent", path, "ENOENT"),
    });
  }
  if (verified.kind === "error") {
    return Object.freeze({
      kind: "error",
      error: casError(
        "manifest-corrupt",
        "fatal",
        "walk-tree",
        verified.error.message,
        path,
        verified.error.systemCode,
      ),
    });
  }
  const requestedOffset = cursor === null
    ? BigInt(TREE_MANIFEST_MAGIC.byteLength)
    : parseTreeCursor(validatedRoot, cursor);
  if (
    requestedOffset === null
    || requestedOffset < BigInt(TREE_MANIFEST_MAGIC.byteLength)
    || requestedOffset > verified.byteLength
  ) {
    try {
      await verified.file.close();
    } catch (error: unknown) {
      return Object.freeze({
        kind: "error",
        error: casIoError("close-invalid-tree-cursor", path, error),
      });
    }
    return Object.freeze({
      kind: "error",
      error: casError(
        "invalid-cursor",
        "feedback",
        "walk-tree",
        "cursor is not bound to this tree or is outside the manifest",
        path,
      ),
    });
  }
  let file: FileHandle | null = verified.file;
  try {
    const magicError = await verifyManifestMagic(file, path);
    if (magicError !== null) {
      await file.close();
      return Object.freeze({ kind: "error", error: magicError });
    }
    let offset = BigInt(TREE_MANIFEST_MAGIC.byteLength);
    let previousPath: string | null = null;
    let entryIndex = 0;
    const directoryStack: string[] = [];
    const entries: TreeEntry[] = [];
    while (offset < verified.byteLength) {
      const header = await readExactAt(file, TREE_ENTRY_HEADER_BYTES, offset);
      if (header === null) {
        await file.close();
        return Object.freeze({
          kind: "error",
          error: casError(
            "manifest-corrupt",
            "fatal",
            "walk-tree",
            "tree entry header is truncated",
            path,
          ),
        });
      }
      const payloadLength = header.readUInt32BE(0);
      const end = offset + BigInt(TREE_ENTRY_HEADER_BYTES) + BigInt(payloadLength);
      if (payloadLength > MAX_TREE_ENTRY_PAYLOAD_BYTES) {
        await file.close();
        return Object.freeze({
          kind: "error",
          error: casError(
            "manifest-corrupt",
            "fatal",
            "walk-tree",
            "tree entry exceeds the bounded manifest-v1 entry envelope",
            path,
          ),
        });
      }
      if (end > verified.byteLength) {
        await file.close();
        return Object.freeze({
          kind: "error",
          error: casError(
            "manifest-corrupt",
            "fatal",
            "walk-tree",
            "tree entry payload is truncated",
            path,
          ),
        });
      }
      if (offset < requestedOffset && end > requestedOffset) {
        await file.close();
        return Object.freeze({
          kind: "error",
          error: casError(
            "invalid-cursor",
            "feedback",
            "walk-tree",
            "cursor does not point to a tree entry boundary",
            path,
          ),
        });
      }
      const payload = await readExactAt(file, payloadLength, offset + BigInt(TREE_ENTRY_HEADER_BYTES));
      if (payload === null) {
        await file.close();
        return Object.freeze({
          kind: "error",
          error: casError(
            "manifest-corrupt",
            "fatal",
            "walk-tree",
            "tree entry bytes disappeared below verified size",
            path,
          ),
        });
      }
      const decoded = decodeTreeEntry(payload, path);
      if (decoded.kind === "error") {
        await file.close();
        return decoded;
      }
      if (
        (entryIndex === 0 && (decoded.entry.kind !== "directory" || decoded.entry.path !== ""))
        || (entryIndex > 0 && decoded.entry.path === "")
        || (
          previousPath !== null
          && compareManifestPaths(decoded.entry.path, previousPath) <= 0
        )
      ) {
        await file.close();
        return Object.freeze({
          kind: "error",
          error: casError(
            "manifest-corrupt",
            "fatal",
            "walk-tree",
            "manifest must start with one root directory and remain strictly path-sorted",
            path,
          ),
        });
      }
      if (decoded.entry.path === "") {
        directoryStack.push("");
      } else {
        const separator = decoded.entry.path.lastIndexOf("/");
        const parentPath = separator < 0 ? "" : decoded.entry.path.slice(0, separator);
        while (
          directoryStack.length > 0
          && directoryStack[directoryStack.length - 1] !== parentPath
        ) {
          directoryStack.pop();
        }
        if (directoryStack[directoryStack.length - 1] !== parentPath) {
          await file.close();
          return Object.freeze({
            kind: "error",
            error: casError(
              "manifest-corrupt",
              "fatal",
              "walk-tree",
              "every tree entry parent must be an earlier directory entry",
              path,
            ),
          });
        }
        if (decoded.entry.kind === "directory") {
          directoryStack.push(decoded.entry.path);
        }
      }
      previousPath = decoded.entry.path;
      if (offset >= requestedOffset && entries.length < pageSize) {
        entries.push(decoded.entry);
      }
      offset = end;
      entryIndex += 1;
      if (entries.length === pageSize) {
        break;
      }
    }
    if (offset < requestedOffset) {
      await file.close();
      return Object.freeze({
        kind: "error",
        error: casError(
          "invalid-cursor",
          "feedback",
          "walk-tree",
          "cursor is not a reachable entry boundary",
          path,
        ),
      });
    }
    const nextCursor = offset < verified.byteLength ? treeCursor(validatedRoot, offset) : null;
    if (offset < verified.byteLength && nextCursor === null) {
      await file.close();
      return Object.freeze({
        kind: "error",
        error: casError(
          "manifest-corrupt",
          "fatal",
          "walk-tree",
          "next manifest offset exceeds unsigned-u64 cursor domain",
          path,
        ),
      });
    }
    await file.close();
    file = null;
    return Object.freeze({
      kind: "page",
      value: Object.freeze({ entries: Object.freeze(entries), nextCursor }),
    });
  } catch (error: unknown) {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // The primary typed result below remains authoritative.
      }
    }
    return Object.freeze({ kind: "error", error: casIoError("walk-tree", path, error) });
  }
}

async function copyBlobToFile(
  state: StoreState,
  ref: BlobRef,
  destination: string,
  mode: number,
): Promise<CasError | null> {
  const validated = validBlobRef(ref);
  if (validated === null) {
    return casError(
      "manifest-corrupt",
      "fatal",
      "materialize-tree",
      "manifest contains an invalid BlobRef",
      destination,
    );
  }
  const source = digestPath(state, validated.digest, "blob");
  const verified = await verifyObject(source, validated.digest, validated.byteLength);
  if (verified.kind === "missing") {
    return casError(
      "blob-not-found",
      "resume",
      "materialize-tree",
      "tree references a missing blob",
      source,
      "ENOENT",
    );
  }
  if (verified.kind === "error") {
    return verified.error;
  }
  let input: FileHandle | null = null;
  let output: FileHandle | null = null;
  try {
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const inputStatus = await input.stat({ bigint: true });
    if (!inputStatus.isFile()) {
      await input.close();
      input = null;
      return casError(
        "blob-corrupt",
        "fatal",
        "materialize-blob",
        "tree blob path is not a regular file",
        source,
      );
    }
    output = await open(destination, "wx", mode);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(IO_CHUNK_BYTES);
    let copiedByteLength = 0n;
    while (true) {
      const read = await input.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) {
        break;
      }
      const bytes = buffer.subarray(0, read.bytesRead);
      hash.update(bytes);
      copiedByteLength += BigInt(read.bytesRead);
      await writeAll(output, bytes);
    }
    const copiedDigest = parseDigest(`sha256:${hash.digest("hex")}`);
    if (
      copiedDigest === null
      || String(copiedDigest) !== String(validated.digest)
      || copiedByteLength !== validated.byteLength
    ) {
      await input.close();
      input = null;
      await output.close();
      output = null;
      return casError(
        "blob-corrupt",
        "fatal",
        "materialize-blob",
        "blob changed between verification and materialization",
        source,
      );
    }
    await output.chmod(mode);
    await output.sync();
    await input.close();
    input = null;
    await output.close();
    output = null;
    return null;
  } catch (error: unknown) {
    if (input !== null) {
      try {
        await input.close();
      } catch {
        // The primary typed error remains authoritative.
      }
    }
    if (output !== null) {
      try {
        await output.close();
      } catch {
        // The primary typed error remains authoritative.
      }
    }
    return casIoError("materialize-blob", destination, error);
  }
}

export async function materializeTree(
  store: ContentAddressedStore,
  root: ArtifactRoot,
  destinationInput: string,
): Promise<MaterializeTreeResult> {
  const lookup = lookupStore(store);
  if (lookup.kind === "error") {
    return lookup;
  }
  const validatedRoot = safeArtifactRoot(root);
  if (validatedRoot === null || !validPathArgument(destinationInput)) {
    return Object.freeze({
      kind: "error",
      error: casError(
        "invalid-argument",
        "feedback",
        "materialize-tree",
        "root and destination must be canonical",
      ),
    });
  }
  let destination: string;
  let parent: string;
  let temporary: string;
  try {
    destination = resolve(destinationInput);
    parent = dirname(destination);
    temporary = join(
      parent,
      `.${basename(destination)}.${String(process.pid)}.${randomBytes(12).toString("hex")}.tmp`,
    );
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: casIoError("prepare-materialize-tree", destinationInput, error),
    });
  }
  let temporaryCreated = false;
  try {
    try {
      await lstat(destination);
      return Object.freeze({
        kind: "error",
        error: casError(
          "destination-exists",
          "feedback",
          "materialize-tree",
          "destination already exists",
          destination,
        ),
      });
    } catch (error: unknown) {
      if (casSystemCode(error) !== "ENOENT") {
        return Object.freeze({
          kind: "error",
          error: casIoError("inspect-materialize-destination", destination, error),
        });
      }
    }
    await mkdir(temporary, { mode: 0o700 });
    temporaryCreated = true;
    let cursor: string | null = null;
    let rootMode: number | null = null;
    const directories: Array<{ readonly mode: number; readonly path: string }> = [];
    while (true) {
      const page = await walkTree(store, validatedRoot, cursor, MAX_WALK_PAGE_SIZE);
      if (page.kind === "error") {
        return page;
      }
      for (const entry of page.value.entries) {
        if (entry.path === "") {
          if (entry.kind !== "directory") {
            return Object.freeze({
              kind: "error",
              error: casError(
                "manifest-corrupt",
                "fatal",
                "materialize-tree",
                "root tree entry is not a directory",
                destination,
              ),
            });
          }
          rootMode = entry.mode;
          continue;
        }
        const target = join(temporary, ...entry.path.split("/"));
        if (entry.kind === "directory") {
          await mkdir(target, { mode: 0o700 });
          directories.push(Object.freeze({ mode: entry.mode, path: target }));
        } else if (entry.kind === "file") {
          const copyError = await copyBlobToFile(lookup.state, entry.blob, target, entry.mode);
          if (copyError !== null) {
            return Object.freeze({ kind: "error", error: copyError });
          }
        } else {
          await symlink(entry.target, target);
        }
      }
      cursor = page.value.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    if (rootMode === null) {
      return Object.freeze({
        kind: "error",
        error: casError(
          "manifest-corrupt",
          "fatal",
          "materialize-tree",
          "tree manifest omitted its root directory",
          destination,
        ),
      });
    }
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const directory = directories[index];
      if (directory !== undefined) {
        await finalizeDirectory(directory.path, directory.mode);
      }
    }
    await finalizeDirectory(temporary, rootMode);
    await rename(temporary, destination);
    temporaryCreated = false;
    await syncDirectory(parent);
    return Object.freeze({ destination, kind: "materialized" });
  } catch (error: unknown) {
    return Object.freeze({
      kind: "error",
      error: casIoError("materialize-tree", destination, error),
    });
  } finally {
    if (temporaryCreated) {
      try {
        await rm(temporary, { force: true, recursive: true });
        await syncDirectory(parent);
      } catch {
        // A crash orphan is unreachable; later GC may reclaim it.
      }
    }
  }
}
