import type { JsonValue } from "../../authority/protocol/schema.js";
import {
  isCrashPointId,
} from "../crash-matrix/registry.js";
import type { CrashPointId } from "../crash-matrix/registry.js";
import { bytesEqual, cloneBytes } from "./values.js";

interface Inode {
  readonly id: number;
  volatileBytes: Uint8Array;
  durableBytes: Uint8Array | null;
}

export interface DurableFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface FileSystemImage {
  readonly files: readonly DurableFile[];
}

export interface CrashPointSink {
  readonly reachCrashPoint: (point: CrashPointId, detail: JsonValue) => boolean;
}

export type FileSystemMutationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "crashed"; readonly point: CrashPointId }
  | { readonly kind: "invalid"; readonly diagnostic: string }
  | { readonly kind: "missing"; readonly path: string };

export type FileSystemReadResult =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "invalid"; readonly diagnostic: string };

function normalizedPath(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.includes("\u0000") || input.includes("\\")) {
    return null;
  }
  const absolute = input.startsWith("/") ? input : `/${input}`;
  const segments = absolute.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return `/${segments.join("/")}`;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function belowDirectory(path: string, directory: string): boolean {
  return directory === "/" || path === directory || path.startsWith(`${directory}/`);
}

/**
 * Byte-accurate inode/namespace model.
 *
 * Modelled: writes are visible before durable; file fsync stabilizes inode
 * bytes; rename changes the visible namespace atomically; directory fsync
 * stabilizes namespace changes; crash restores only the durable namespace and
 * durable inode bytes. Not modelled: device-specific writeback ordering,
 * sector tearing, hard links, permissions, quotas, or filesystem bugs.
 */
export class SimFileSystem {
  private readonly sink: CrashPointSink;
  private readonly inodes = new Map<number, Inode>();
  private readonly visibleNames = new Map<string, number>();
  private readonly durableNames = new Map<string, number>();
  private nextInode = 1;

  public constructor(sink: CrashPointSink, image?: unknown) {
    this.sink = sink;
    const files = decodeImage(image);
    for (const file of files) {
      const inode: Inode = {
        id: this.nextInode,
        volatileBytes: file.bytes.slice(),
        durableBytes: file.bytes.slice(),
      };
      this.nextInode += 1;
      this.inodes.set(inode.id, inode);
      this.visibleNames.set(file.path, inode.id);
      this.durableNames.set(file.path, inode.id);
    }
  }

  public writeFile(pathInput: unknown, bytesInput: unknown): FileSystemMutationResult {
    const path = normalizedPath(pathInput);
    const bytes = cloneBytes(bytesInput);
    if (path === null || bytes === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "write requires a normalized path and Uint8Array bytes" });
    }
    const existingId = this.visibleNames.get(path);
    if (existingId !== undefined) {
      const inode = this.inodes.get(existingId);
      if (inode === undefined) {
        return Object.freeze({ kind: "missing", path });
      }
      inode.volatileBytes = bytes;
      return Object.freeze({ kind: "ok" });
    }
    const inode: Inode = { id: this.nextInode, volatileBytes: bytes, durableBytes: null };
    this.nextInode += 1;
    this.inodes.set(inode.id, inode);
    this.visibleNames.set(path, inode.id);
    return Object.freeze({ kind: "ok" });
  }

  public appendFile(
    pathInput: unknown,
    bytesInput: unknown,
    pointInput: unknown = "filesystem.append",
  ): FileSystemMutationResult {
    const path = normalizedPath(pathInput);
    const bytes = cloneBytes(bytesInput);
    if (path === null || bytes === null || !isCrashPointId(pointInput)) {
      return Object.freeze({ kind: "invalid", diagnostic: "append requires a path, bytes, and registered crash point" });
    }
    const prior = this.readVisible(path);
    const combined = new Uint8Array((prior?.length ?? 0) + bytes.length);
    if (prior !== null) {
      combined.set(prior, 0);
    }
    combined.set(bytes, prior?.length ?? 0);
    const written = this.writeFile(path, combined);
    if (written.kind !== "ok") {
      return written;
    }
    const crashed = this.sink.reachCrashPoint(pointInput, Object.freeze({
      bytes: bytes.length,
      path,
    }));
    return crashed
      ? Object.freeze({ kind: "crashed", point: pointInput })
      : Object.freeze({ kind: "ok" });
  }

  public fsyncFile(
    pathInput: unknown,
    pointInput: unknown = "filesystem.file-fsync",
  ): FileSystemMutationResult {
    const path = normalizedPath(pathInput);
    if (path === null || !isCrashPointId(pointInput)) {
      return Object.freeze({ kind: "invalid", diagnostic: "fsync requires a path and registered crash point" });
    }
    const inodeId = this.visibleNames.get(path);
    const inode = inodeId === undefined ? undefined : this.inodes.get(inodeId);
    if (inode === undefined) {
      return Object.freeze({ kind: "missing", path });
    }
    inode.durableBytes = inode.volatileBytes.slice();
    const crashed = this.sink.reachCrashPoint(pointInput, Object.freeze({ path }));
    return crashed
      ? Object.freeze({ kind: "crashed", point: pointInput })
      : Object.freeze({ kind: "ok" });
  }

  public rename(
    fromInput: unknown,
    toInput: unknown,
    pointInput: unknown = "filesystem.rename",
  ): FileSystemMutationResult {
    const from = normalizedPath(fromInput);
    const to = normalizedPath(toInput);
    if (from === null || to === null || !isCrashPointId(pointInput)) {
      return Object.freeze({ kind: "invalid", diagnostic: "rename requires two paths and a registered crash point" });
    }
    const inodeId = this.visibleNames.get(from);
    if (inodeId === undefined) {
      return Object.freeze({ kind: "missing", path: from });
    }
    this.visibleNames.delete(from);
    this.visibleNames.set(to, inodeId);
    const crashed = this.sink.reachCrashPoint(pointInput, Object.freeze({ from, to }));
    return crashed
      ? Object.freeze({ kind: "crashed", point: pointInput })
      : Object.freeze({ kind: "ok" });
  }

  public fsyncDirectory(
    directoryInput: unknown,
    pointInput: unknown = "filesystem.directory-fsync",
  ): FileSystemMutationResult {
    const directory = normalizedPath(directoryInput);
    if (directory === null || !isCrashPointId(pointInput)) {
      return Object.freeze({ kind: "invalid", diagnostic: "directory fsync requires a path and registered crash point" });
    }
    for (const path of [...this.durableNames.keys()]) {
      if (belowDirectory(path, directory) && !this.visibleNames.has(path)) {
        this.durableNames.delete(path);
      }
    }
    for (const [path, inodeId] of this.visibleNames) {
      if (belowDirectory(path, directory)) {
        this.durableNames.set(path, inodeId);
      }
    }
    const crashed = this.sink.reachCrashPoint(pointInput, Object.freeze({ directory }));
    return crashed
      ? Object.freeze({ kind: "crashed", point: pointInput })
      : Object.freeze({ kind: "ok" });
  }

  public readFile(pathInput: unknown): FileSystemReadResult {
    const path = normalizedPath(pathInput);
    if (path === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "read requires a normalized path" });
    }
    const bytes = this.readVisible(path);
    return bytes === null
      ? Object.freeze({ kind: "missing", path })
      : Object.freeze({ kind: "ok", bytes });
  }

  public exists(pathInput: unknown): boolean {
    const path = normalizedPath(pathInput);
    return path !== null && this.visibleNames.has(path);
  }

  public listFiles(directoryInput: unknown): readonly string[] {
    const directory = normalizedPath(directoryInput);
    if (directory === null) {
      return Object.freeze([]);
    }
    return Object.freeze([...this.visibleNames.keys()]
      .filter((path) => belowDirectory(path, directory))
      .sort());
  }

  public crashRecover(): void {
    this.visibleNames.clear();
    const retained = new Set<number>();
    for (const [path, inodeId] of [...this.durableNames.entries()].sort((left, right) => compareText(left[0], right[0]))) {
      const inode = this.inodes.get(inodeId);
      if (inode?.durableBytes === null || inode === undefined) {
        this.durableNames.delete(path);
        continue;
      }
      inode.volatileBytes = inode.durableBytes.slice();
      this.visibleNames.set(path, inodeId);
      retained.add(inodeId);
    }
    for (const inodeId of [...this.inodes.keys()]) {
      if (!retained.has(inodeId)) {
        this.inodes.delete(inodeId);
      }
    }
  }

  public durableImage(): FileSystemImage {
    const files: DurableFile[] = [];
    for (const [path, inodeId] of [...this.durableNames.entries()].sort((left, right) => compareText(left[0], right[0]))) {
      const bytes = this.inodes.get(inodeId)?.durableBytes;
      if (bytes !== null && bytes !== undefined) {
        files.push(Object.freeze({ path, bytes: bytes.slice() }));
      }
    }
    return Object.freeze({ files: Object.freeze(files) });
  }

  public visibleEqualsDurable(pathInput: unknown): boolean {
    const path = normalizedPath(pathInput);
    if (path === null) {
      return false;
    }
    const visibleId = this.visibleNames.get(path);
    const durableId = this.durableNames.get(path);
    if (visibleId === undefined || durableId === undefined || visibleId !== durableId) {
      return false;
    }
    const inode = this.inodes.get(visibleId);
    return inode?.durableBytes !== null
      && inode?.durableBytes !== undefined
      && bytesEqual(inode.volatileBytes, inode.durableBytes);
  }

  public parentOf(pathInput: unknown): string | null {
    const path = normalizedPath(pathInput);
    return path === null ? null : parentDirectory(path);
  }

  private readVisible(path: string): Uint8Array | null {
    const inodeId = this.visibleNames.get(path);
    const inode = inodeId === undefined ? undefined : this.inodes.get(inodeId);
    return inode === undefined ? null : inode.volatileBytes.slice();
  }
}

function decodeImage(input: unknown): readonly DurableFile[] {
  try {
    if (input === undefined || input === null) {
      return Object.freeze([]);
    }
    if (typeof input !== "object" || Array.isArray(input)) {
      return Object.freeze([]);
    }
    const candidates = Reflect.get(input, "files");
    if (!Array.isArray(candidates)) {
      return Object.freeze([]);
    }
    const files: DurableFile[] = [];
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return Object.freeze([]);
      }
      const path = normalizedPath(Reflect.get(candidate, "path"));
      const bytes = cloneBytes(Reflect.get(candidate, "bytes"));
      if (path === null || bytes === null) {
        return Object.freeze([]);
      }
      files.push(Object.freeze({ path, bytes }));
    }
    return Object.freeze(files);
  } catch {
    return Object.freeze([]);
  }
}
