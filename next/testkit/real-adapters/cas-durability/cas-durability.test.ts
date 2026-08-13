import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  captureTree,
  materializeTree,
  openCas,
  putBlob,
  readBlob,
  walkTree,
} from "../../../storage/cas/index.js";
import type {
  BlobRef,
  CaptureTreeResult,
  CasDurabilityObserver,
  ContentAddressedStore,
  TreeEntry,
} from "../../../storage/cas/index.js";
import { digestBytes } from "../../../authority/protocol/schema.js";
import {
  TREE_MANIFEST_MAGIC,
  encodeTreeEntry,
  frameTreeEntry,
  parseArtifactRoot,
} from "../../../storage/cas/manifest.js";

const childModule = fileURLToPath(new URL("./cas-child.js", import.meta.url));
const KILL_BLOB_BYTES = 256 * 1024;
const KILL_BLOB_SEED = 91;

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

function waitForMessage(
  child: ChildProcess,
  event: string,
  timeoutMilliseconds: number = 15_000,
): Promise<unknown> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error(`timed out waiting for CAS child event ${event}`));
    }, timeoutMilliseconds);
    const onMessage = (message: unknown): void => {
      if (field(message, "event") === event) {
        cleanup();
        resolveMessage(message);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectMessage(new Error(`CAS child exited before ${event}: ${String(code)}/${String(signal)}`));
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

function deterministicBytes(seed: number, byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + index + 1) >>> 0;
    output[index] = state & 0xff;
  }
  return output;
}

async function* chunks(bytes: Uint8Array, chunkSize: number = 8191): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
  }
}

async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function refFor(bytes: Uint8Array): BlobRef {
  return Object.freeze({
    byteLength: BigInt(bytes.byteLength).toString(10).padStart(20, "0"),
    digest: digestBytes(bytes),
  });
}

function blobPath(casRoot: string, ref: BlobRef): string {
  const hex = String(ref.digest).slice(7);
  return join(casRoot, "blobs", "sha256", hex.slice(0, 2), hex.slice(2));
}

function treePath(casRoot: string, root: string): string {
  const hex = root.slice(7);
  return join(casRoot, "trees", "sha256", hex.slice(0, 2), `${hex.slice(2)}.tree`);
}

async function restoreCleanupMode(path: string): Promise<void> {
  try {
    await chmod(path, 0o700);
  } catch (error: unknown) {
    if (field(error, "code") !== "ENOENT") {
      throw error;
    }
  }
}

async function openedStore(casRoot: string): Promise<ContentAddressedStore> {
  const opened = await openCas(casRoot);
  if (opened.kind === "error") {
    throw new Error(opened.error.message);
  }
  return opened.store;
}

async function collectRange(
  store: ContentAddressedStore,
  ref: BlobRef,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const read = await readBlob(store, ref, { length, offset });
  if (read.kind === "error") {
    throw new Error(read.error.message);
  }
  const output = new Uint8Array(length);
  let written = 0;
  for await (const chunk of read.bytes) {
    output.set(chunk, written);
    written += chunk.byteLength;
  }
  assert.deepEqual(await read.bytes.completion, { byteLength: length, kind: "complete" });
  assert.equal(written, length);
  return output;
}

async function walkAll(
  store: ContentAddressedStore,
  root: CaptureTreeResult,
): Promise<readonly TreeEntry[]> {
  if (root.kind === "error") {
    throw new Error(root.error.message);
  }
  const rootValue = root.root;
  const entries: TreeEntry[] = [];
  let cursor: string | null = null;
  while (true) {
    const page = await walkTree(store, rootValue, cursor, 2);
    if (page.kind === "error") {
      throw new Error(page.error.message);
    }
    entries.push(...page.value.entries);
    cursor = page.value.nextCursor;
    if (cursor === null) {
      return Object.freeze(entries);
    }
  }
}

test("streaming blob install, exact ranges, and sequential double-put are content-idempotent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-basic-"));
  const casRoot = join(parent, "cas");
  try {
    const store = await openedStore(casRoot);
    const bytes = deterministicBytes(1, 300_003);
    const first = await putBlob(store, chunks(bytes));
    if (first.kind === "error") {
      throw new Error(first.error.message);
    }
    assert.equal(first.kind, "stored");
    assert.equal(first.alreadyPresent, false);
    const second = await putBlob(store, chunks(bytes, 1237));
    if (second.kind === "error") {
      throw new Error(second.error.message);
    }
    assert.equal(second.kind, "stored");
    assert.equal(second.alreadyPresent, true);
    assert.deepEqual(second.ref, first.ref);
    assert.deepEqual(
      await collectRange(store, first.ref, 99_999, 100_001),
      bytes.subarray(99_999, 200_000),
    );
    const cancelled = await readBlob(store, first.ref, { offset: 0, length: 200_000 });
    assert.equal(cancelled.kind, "ready");
    if (cancelled.kind === "ready") {
      for await (const firstChunk of cancelled.bytes) {
        assert.ok(firstChunk.byteLength > 0);
        break;
      }
      const cancelledCompletion = await cancelled.bytes.completion;
      assert.equal(cancelledCompletion.kind, "error");
      if (cancelledCompletion.kind === "error") {
        assert.equal(cancelledCompletion.error.code, "invalid-argument");
      }
    }
    const invalid = await readBlob(store, first.ref, { offset: bytes.byteLength, length: 1 });
    assert.equal(invalid.kind, "error");
    if (invalid.kind === "error") {
      assert.equal(invalid.error.disposition, "feedback");
    }

    const diskBytes = await readFile(blobPath(casRoot, first.ref));
    assert.deepEqual(diskBytes, Buffer.from(bytes));
    const corruptByte = Math.floor(diskBytes.byteLength / 2);
    diskBytes[corruptByte] = (diskBytes[corruptByte] ?? 0) ^ 0xff;
    await writeFile(blobPath(casRoot, first.ref), diskBytes);
    const corrupt = await readBlob(store, first.ref, { offset: 0, length: 1 });
    assert.equal(corrupt.kind, "error");
    if (corrupt.kind === "error") {
      assert.equal(corrupt.error.code, "blob-corrupt");
      assert.equal(corrupt.error.disposition, "fatal");
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("putBlob owns each yielded chunk before asynchronous writes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-owned-chunk-"));
  try {
    const mutable = deterministicBytes(6, 128 * 1024);
    const expected = Buffer.from(mutable);
    let mutated = false;
    const observer: CasDurabilityObserver = (event): void => {
      if (!mutated && event.objectKind === "blob" && event.point === "temp-mid-write") {
        mutated = true;
        mutable.fill(0xff);
      }
    };
    const opened = await openCas(join(parent, "cas"), { durabilityObserver: observer });
    if (opened.kind === "error") {
      throw new Error(opened.error.message);
    }
    const stored = await putBlob(opened.store, oneChunk(mutable));
    if (stored.kind === "error") {
      throw new Error(stored.error.message);
    }
    assert.equal(mutated, true);
    assert.equal(String(stored.ref.digest), String(digestBytes(expected)));
    assert.deepEqual(
      Buffer.from(await collectRange(opened.store, stored.ref, 0, expected.byteLength)),
      expected,
    );
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("verified ranged read remains bound to one inode across path replacement", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-read-race-"));
  const casRoot = join(parent, "cas");
  try {
    const store = await openedStore(casRoot);
    const original = deterministicBytes(7, 150_000);
    const stored = await putBlob(store, chunks(original));
    if (stored.kind === "error") {
      throw new Error(stored.error.message);
    }
    const ready = await readBlob(store, stored.ref, { offset: 0, length: original.byteLength });
    if (ready.kind === "error") {
      throw new Error(ready.error.message);
    }
    assert.equal(ready.kind, "ready");
    const target = blobPath(casRoot, stored.ref);
    const replacement = `${target}.replacement`;
    await writeFile(replacement, deterministicBytes(8, original.byteLength));
    await rename(replacement, target);
    const output = new Uint8Array(original.byteLength);
    let offset = 0;
    for await (const chunk of ready.bytes) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    assert.deepEqual(output, original);
    assert.deepEqual(
      await ready.bytes.completion,
      { byteLength: original.byteLength, kind: "complete" },
    );
    const corrupt = await readBlob(store, stored.ref, { offset: 0, length: 1 });
    assert.equal(corrupt.kind, "error");
    if (corrupt.kind === "error") {
      assert.equal(corrupt.error.code, "blob-corrupt");
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("real SIGKILL at every CAS install window exposes absent-or-complete digest objects only", async (context) => {
  const points = [
    "temp-created",
    "temp-mid-write",
    "temp-written",
    "temp-synced",
    "before-rename",
    "after-rename",
    "parent-directory-synced",
  ];
  const bytes = deterministicBytes(KILL_BLOB_SEED, KILL_BLOB_BYTES);
  const ref = refFor(bytes);
  for (const point of points) {
    await context.test(point, async () => {
      const parent = await mkdtemp(join(tmpdir(), `autopilot-cas-kill-${point}-`));
      const casRoot = join(parent, "cas");
      const child = fork(childModule, [
        "kill-put",
        casRoot,
        point,
        String(KILL_BLOB_SEED),
        String(KILL_BLOB_BYTES),
      ], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      try {
        await waitForMessage(child, "point");
        assert.equal(child.kill("SIGKILL"), true);
        await waitForExit(child);
        const store = await openedStore(casRoot);
        const read = await readBlob(store, ref, { offset: 0, length: bytes.byteLength });
        const renamed = point === "after-rename" || point === "parent-directory-synced";
        if (!renamed) {
          assert.equal(read.kind, "error");
          if (read.kind === "error") {
            assert.equal(read.error.code, "blob-not-found");
          }
        } else {
          assert.equal(read.kind, "ready");
          if (read.kind === "ready") {
            await read.bytes.close();
            assert.deepEqual(await collectRange(store, ref, 0, bytes.byteLength), bytes);
          }
        }
        let installed: Buffer | null = null;
        try {
          installed = await readFile(blobPath(casRoot, ref));
        } catch (error: unknown) {
          assert.equal(field(error, "code"), "ENOENT");
        }
        if (installed !== null) {
          assert.deepEqual(installed, Buffer.from(bytes));
        }
        const retry = await putBlob(store, chunks(bytes));
        assert.equal(retry.kind, "stored");
        if (retry.kind === "stored") {
          assert.equal(retry.alreadyPresent, renamed);
          assert.deepEqual(retry.ref, ref);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await rm(parent, { force: true, recursive: true });
      }
    });
  }
});

test("duplicate put fsyncs a digest name installed by a paused process", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-duplicate-dirsync-"));
  const casRoot = join(parent, "cas");
  const bytes = deterministicBytes(KILL_BLOB_SEED, KILL_BLOB_BYTES);
  const ref = refFor(bytes);
  const installer = fork(childModule, [
    "kill-put",
    casRoot,
    "after-rename",
    String(KILL_BLOB_SEED),
    String(KILL_BLOB_BYTES),
  ], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  try {
    await waitForMessage(installer, "point");
    let directorySynced = false;
    const observer: CasDurabilityObserver = (event): void => {
      if (event.objectKind === "blob" && event.point === "parent-directory-synced") {
        directorySynced = true;
      }
    };
    const opened = await openCas(casRoot, { durabilityObserver: observer });
    if (opened.kind === "error") {
      throw new Error(opened.error.message);
    }
    const duplicate = await putBlob(opened.store, chunks(bytes));
    assert.equal(duplicate.kind, "stored");
    if (duplicate.kind === "stored") {
      assert.equal(duplicate.alreadyPresent, true);
      assert.deepEqual(duplicate.ref, ref);
    }
    assert.equal(directorySynced, true);
    assert.equal(installer.kill("SIGKILL"), true);
    await waitForExit(installer);
    const reopened = await openedStore(casRoot);
    assert.deepEqual(await collectRange(reopened, ref, 0, bytes.byteLength), bytes);
  } finally {
    if (installer.exitCode === null && installer.signalCode === null) {
      installer.kill("SIGKILL");
    }
    await rm(parent, { force: true, recursive: true });
  }
});

test("concurrent puts converge on one digest path with exact bytes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-concurrent-"));
  const casRoot = join(parent, "cas");
  try {
    const store = await openedStore(casRoot);
    const bytes = deterministicBytes(10, 512 * 1024);
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, index) => putBlob(store, chunks(bytes, 4096 + index))),
    );
    assert.equal(outcomes.every((outcome) => outcome.kind === "stored"), true);
    const references = outcomes
      .filter((outcome) => outcome.kind === "stored")
      .map((outcome) => outcome.ref);
    assert.equal(references.length, 12);
    assert.equal(new Set(references.map((ref) => String(ref.digest))).size, 1);
    const first = references[0];
    assert.ok(first !== undefined);
    assert.deepEqual(await collectRange(store, first, 0, bytes.byteLength), bytes);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("captureTree manifest is deterministic, sorted, mode-aware, and symlink-not-following", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-tree-"));
  const casRoot = join(parent, "cas");
  const source = join(parent, "source");
  const outside = join(parent, "outside.bin");
  try {
    await mkdir(join(source, "bin"), { recursive: true });
    await mkdir(join(source, "docs"), { recursive: true });
    await mkdir(join(source, "readonly"), { recursive: true });
    await writeFile(join(source, "bin", "tool"), Buffer.from("#!/bin/sh\nexit 0\n"));
    await writeFile(join(source, "bin-child"), Buffer.from("component-order\n"));
    await chmod(join(source, "bin", "tool"), 0o751);
    await chmod(join(source, "bin"), 0o750);
    await writeFile(join(source, "docs", "readme.txt"), Buffer.from("deterministic\n"));
    await writeFile(join(source, "readonly", "inside.txt"), Buffer.from("still materializes\n"));
    await chmod(join(source, "readonly"), 0o555);
    await writeFile(outside, Buffer.from("outside-must-not-be-captured"));
    await symlink("../../outside.bin", join(source, "docs", "outside-link"));
    await symlink("bin/tool", join(source, "tool-link"));

    const store = await openedStore(casRoot);
    const first = await captureTree(store, source);
    if (first.kind === "error") {
      throw new Error(first.error.message);
    }
    assert.equal(first.kind, "captured");
    const second = await captureTree(store, source);
    if (second.kind === "error") {
      throw new Error(second.error.message);
    }
    assert.equal(second.kind, "captured");
    assert.equal(String(second.root), String(first.root));
    assert.equal(second.alreadyPresent, true);
    const entries = await walkAll(store, first);
    const paths = entries.map((entry) => entry.path);
    assert.deepEqual(paths, [
      "",
      "bin",
      "bin/tool",
      "bin-child",
      "docs",
      "docs/outside-link",
      "docs/readme.txt",
      "readonly",
      "readonly/inside.txt",
      "tool-link",
    ]);
    const executable = entries.find((entry) => entry.path === "bin/tool");
    assert.equal(executable?.kind, "file");
    assert.equal(executable?.mode, 0o751);
    const externalLink = entries.find((entry) => entry.path === "docs/outside-link");
    assert.equal(externalLink?.kind, "symlink");
    if (externalLink?.kind === "symlink") {
      assert.equal(externalLink.target, "../../outside.bin");
    }

    const destination = join(parent, "materialized");
    const materialized = await materializeTree(store, first.root, destination);
    assert.equal(materialized.kind, "materialized");
    assert.equal((await stat(join(destination, "bin", "tool"))).mode & 0o777, 0o751);
    assert.equal((await stat(join(destination, "bin"))).mode & 0o777, 0o750);
    assert.equal((await stat(join(destination, "readonly"))).mode & 0o777, 0o555);
    assert.deepEqual(
      await readFile(join(destination, "readonly", "inside.txt")),
      Buffer.from("still materializes\n"),
    );
    assert.equal((await lstat(join(destination, "docs", "outside-link"))).isSymbolicLink(), true);
    assert.equal(await readlink(join(destination, "docs", "outside-link")), "../../outside.bin");
    assert.deepEqual(
      await readFile(join(destination, "docs", "readme.txt")),
      Buffer.from("deterministic\n"),
    );
  } finally {
    await restoreCleanupMode(join(source, "readonly"));
    await restoreCleanupMode(join(parent, "materialized", "readonly"));
    await rm(parent, { force: true, recursive: true });
  }
});

test("walkTree is cursor-bound and pages a real multi-entry manifest", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-pages-"));
  const source = join(parent, "source");
  try {
    await mkdir(source);
    for (let index = 0; index < 137; index += 1) {
      await writeFile(
        join(source, `file-${String(index).padStart(4, "0")}.bin`),
        Buffer.from([index & 0xff]),
      );
    }
    const store = await openedStore(join(parent, "cas"));
    const captured = await captureTree(store, source);
    if (captured.kind === "error") {
      throw new Error(captured.error.message);
    }
    assert.equal(captured.kind, "captured");
    let cursor: string | null = null;
    let count = 0;
    do {
      const page = await walkTree(store, captured.root, cursor, 7);
      if (page.kind === "error") {
        throw new Error(page.error.message);
      }
      assert.equal(page.kind, "page");
      count += page.value.entries.length;
      cursor = page.value.nextCursor;
    } while (cursor !== null);
    assert.equal(count, 138);
    const wrongCursor = await walkTree(store, captured.root, "tree-cursor-v1:wrong:00000000000000000000", 7);
    assert.equal(wrongCursor.kind, "error");
    if (wrongCursor.kind === "error") {
      assert.equal(wrongCursor.error.code, "invalid-cursor");
    }
    const unbounded = await walkTree(store, captured.root, null, 100_000);
    assert.equal(unbounded.kind, "error");
    if (unbounded.kind === "error") {
      assert.equal(unbounded.error.disposition, "feedback");
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("tree manifest corruption is fatal and never partially materialized", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-manifest-corrupt-"));
  const source = join(parent, "source");
  const casRoot = join(parent, "cas");
  try {
    await mkdir(source);
    await writeFile(join(source, "a.txt"), "a");
    const store = await openedStore(casRoot);
    const captured = await captureTree(store, source);
    if (captured.kind === "error") {
      throw new Error(captured.error.message);
    }
    assert.equal(captured.kind, "captured");
    const path = treePath(casRoot, String(captured.root));
    const bytes = await readFile(path);
    const corruptByte = Math.floor(bytes.byteLength / 2);
    bytes[corruptByte] = (bytes[corruptByte] ?? 0) ^ 0x80;
    await writeFile(path, bytes);
    const walked = await walkTree(store, captured.root, null, 10);
    assert.equal(walked.kind, "error");
    if (walked.kind === "error") {
      assert.equal(walked.error.code, "manifest-corrupt");
      assert.equal(walked.error.disposition, "fatal");
    }
    const destination = join(parent, "destination");
    const materialized = await materializeTree(store, captured.root, destination);
    assert.equal(materialized.kind, "error");
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("manifest topology forbids traversal through a symlink parent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-topology-"));
  const casRoot = join(parent, "cas");
  const outside = join(parent, "outside");
  try {
    await mkdir(outside);
    const store = await openedStore(casRoot);
    const entries: readonly TreeEntry[] = Object.freeze([
      Object.freeze({ kind: "directory", mode: 0o700, path: "" }),
      Object.freeze({ kind: "symlink", mode: 0o777, path: "escape", target: "../outside" }),
      Object.freeze({ blob: refFor(Buffer.from("pwn")), kind: "file", mode: 0o600, path: "escape/pwn" }),
    ]);
    const chunksForManifest: Buffer[] = [Buffer.from(TREE_MANIFEST_MAGIC)];
    for (const entry of entries) {
      const encoded = encodeTreeEntry(entry);
      if (encoded.kind === "error") {
        throw new Error(encoded.error.message);
      }
      assert.equal(encoded.kind, "ok");
      const framed = frameTreeEntry(encoded.bytes);
      assert.ok(framed !== null);
      if (framed !== null) {
        chunksForManifest.push(framed);
      }
    }
    const manifest = Buffer.concat(chunksForManifest);
    const root = parseArtifactRoot(String(digestBytes(manifest)));
    assert.ok(root !== null);
    if (root === null) {
      throw new Error("manifest digest was not an ArtifactRoot");
    }
    const path = treePath(casRoot, String(root));
    await mkdir(join(casRoot, "trees", "sha256", String(root).slice(7, 9)), { recursive: true });
    await writeFile(path, manifest);
    const walked = await walkTree(store, root, null, 10);
    assert.equal(walked.kind, "error");
    if (walked.kind === "error") {
      assert.equal(walked.error.code, "manifest-corrupt");
    }
    const destination = join(parent, "destination");
    const materialized = await materializeTree(store, root, destination);
    assert.equal(materialized.kind, "error");
    await assert.rejects(lstat(join(outside, "pwn")), { code: "ENOENT" });
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("source mutation during capture is typed resumable feedback and installs no tree root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-source-race-"));
  const source = join(parent, "source");
  const file = join(source, "changing.bin");
  let changed = false;
  try {
    await mkdir(source);
    await writeFile(file, deterministicBytes(33, 200_000));
    const observer: CasDurabilityObserver = async (event): Promise<void> => {
      if (!changed && event.objectKind === "blob" && event.point === "temp-mid-write") {
        changed = true;
        await appendFile(file, Buffer.from([0xff]));
      }
    };
    const opened = await openCas(join(parent, "cas"), { durabilityObserver: observer });
    if (opened.kind === "error") {
      throw new Error(opened.error.message);
    }
    assert.equal(opened.kind, "opened");
    const captured = await captureTree(opened.store, source);
    assert.equal(captured.kind, "error");
    if (captured.kind === "error") {
      assert.equal(captured.error.code, "source-changed");
      assert.equal(captured.error.disposition, "resume");
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("injected ENOSPC at the real temp-write seam is loud and leaves no digest object", async () => {
  class FullFilesystemError extends Error {
    readonly code = "ENOSPC";
  }
  const parent = await mkdtemp(join(tmpdir(), "autopilot-cas-enospc-"));
  const bytes = deterministicBytes(44, 64 * 1024);
  const ref = refFor(bytes);
  try {
    const observer: CasDurabilityObserver = (event): void => {
      if (event.objectKind === "blob" && event.point === "temp-mid-write") {
        throw new FullFilesystemError("injected ENOSPC");
      }
    };
    const opened = await openCas(join(parent, "cas"), { durabilityObserver: observer });
    if (opened.kind === "error") {
      throw new Error(opened.error.message);
    }
    assert.equal(opened.kind, "opened");
    const result = await putBlob(opened.store, chunks(bytes));
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.error.code, "io-full");
      assert.equal(result.error.disposition, "resume");
    }
    const read = await readBlob(opened.store, ref, { offset: 0, length: 1 });
    assert.equal(read.kind, "error");
    if (read.kind === "error") {
      assert.equal(read.error.code, "blob-not-found");
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
