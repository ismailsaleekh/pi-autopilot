import {
  storeIntentCapsule,
  storeObservationCapsule,
} from "../../ports/contracts/store.capsule.js";
import type {
  StoreIntent,
  StoreObservation,
} from "../../ports/contracts/store.capsule.js";
import type { ArtifactRoot } from "../../authority/protocol/identifiers.js";
import { canonicalEncodeUnknown } from "../../authority/protocol/schema.js";
import { ArtifactCatalog } from "./artifacts.js";
import type { PortTraceSink, SimPortExecution } from "./port-types.js";
import { diagnostic, safeDecode } from "./port-types.js";
import { SimFileSystem } from "./sim-filesystem.js";
import { bytesEqual, pageCursorFor, pageCursorOffset } from "./values.js";

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function finalObjectPath(root: string): string {
  return `/cas/objects/${root}`;
}

function temporaryObjectPath(root: string, actionId: string): string {
  return `/cas/temp/${root}.${actionId}`;
}

/**
 * Models a content-addressed store as exact bytes installed in this order:
 * append temp, file fsync, atomic rename, directory fsync, acknowledge. Reads
 * and pages resolve immutable bytes. It does not model device caches, ENOSPC,
 * sector tearing, permission failures, or real-filesystem reordering; D3 must.
 */
export class SimStorePort {
  private readonly artifacts: ArtifactCatalog;
  private readonly fileSystem: SimFileSystem;
  private readonly trace: PortTraceSink;
  private readonly observations = new Map<string, StoreObservation>();

  public constructor(artifacts: ArtifactCatalog, fileSystem: SimFileSystem, trace: PortTraceSink) {
    this.artifacts = artifacts;
    this.fileSystem = fileSystem;
    this.trace = trace;
  }

  public execute(input: unknown): SimPortExecution<StoreObservation> {
    const decoded = safeDecode(storeIntentCapsule, input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    const cached = this.observations.get(decoded.value.actionId);
    if (cached !== undefined) {
      this.trace.recordContract("store", decoded.value.actionId, cached);
      return Object.freeze({ kind: "observation", observation: cached });
    }
    const result = this.apply(decoded.value);
    if (result.kind === "observation") {
      if (result.observation.result.kind === "ok") {
        this.observations.set(decoded.value.actionId, result.observation);
      }
      this.trace.recordContract("store", decoded.value.actionId, result.observation);
    }
    return result;
  }

  public isInstalled(rootInput: unknown): boolean {
    return typeof rootInput === "string" && this.fileSystem.exists(finalObjectPath(rootInput));
  }

  public readBytes(refInput: unknown): Uint8Array | null {
    const read = this.artifacts.read(refInput);
    return read.kind === "ok" ? read.bytes : null;
  }

  private apply(intent: StoreIntent): SimPortExecution<StoreObservation> {
    switch (intent.kind) {
      case "install-sealed-object":
        return this.install(intent);
      case "read-artifact-range": {
        if (intent.preconditions.expectedRoot !== intent.inputs.artifact.root) {
          return this.observation(intent, "artifact-range-read", Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("store.root-precondition-mismatch", "artifact root does not match the read precondition"),
          }));
        }
        const read = this.artifacts.read(intent.inputs.artifact);
        if (read.kind !== "ok" || !this.isInstalled(intent.inputs.artifact.root)) {
          return this.observation(intent, "artifact-range-read", Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("store.artifact-absent", "artifact bytes are not durably installed"),
          }));
        }
        return this.observation(intent, "artifact-range-read", Object.freeze({
          kind: "ok",
          value: Object.freeze({
            content: intent.inputs.artifact,
            root: intent.inputs.artifact.root,
          }),
        }));
      }
      case "list-artifact-page":
        return this.listPage(intent);
      case "observe-object-presence": {
        const digestMatches = String(intent.preconditions.expectedDigest) === String(intent.inputs.root);
        return this.observation(intent, "object-presence-observed", digestMatches
          ? Object.freeze({
              kind: "ok",
              value: Object.freeze({
                present: this.isInstalled(intent.inputs.root),
                root: intent.inputs.root,
              }),
            })
          : Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("store.digest-precondition-mismatch", "object root does not match expected digest"),
            }));
      }
    }
  }

  private install(intent: Extract<StoreIntent, { readonly kind: "install-sealed-object" }>): SimPortExecution<StoreObservation> {
    const serialized = this.artifacts.serialize(intent.inputs.sealedRoot);
    if (String(intent.preconditions.expectedDigest) !== String(intent.inputs.sealedRoot) || serialized === null) {
      return this.observation(intent, "sealed-object-installed", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("store.install-precondition", "sealed root is absent or does not match its expected digest"),
      }));
    }
    const finalPath = finalObjectPath(intent.inputs.sealedRoot);
    const existing = this.fileSystem.readFile(finalPath);
    if (existing.kind === "ok") {
      if (!bytesEqual(existing.bytes, serialized)) {
        return this.observation(intent, "sealed-object-installed", Object.freeze({
          kind: "retry",
          diagnostic: diagnostic("store.digest-collision", "installed object bytes disagree with the sealed root"),
        }));
      }
      this.recordInstalled(intent.inputs.sealedRoot, serialized.length);
      return this.observation(intent, "sealed-object-installed", Object.freeze({
        kind: "ok",
        value: Object.freeze({ alreadyPresent: true, root: intent.inputs.sealedRoot }),
      }));
    }
    const temporaryPath = temporaryObjectPath(intent.inputs.sealedRoot, intent.actionId);
    const appended = this.fileSystem.appendFile(temporaryPath, serialized, "store.install.append");
    if (appended.kind === "crashed") {
      return Object.freeze({ kind: "crashed", point: appended.point });
    }
    if (appended.kind !== "ok") {
      return this.installRetry(intent, appended.kind);
    }
    const synced = this.fileSystem.fsyncFile(temporaryPath, "store.install.file-fsync");
    if (synced.kind === "crashed") {
      return Object.freeze({ kind: "crashed", point: synced.point });
    }
    if (synced.kind !== "ok") {
      return this.installRetry(intent, synced.kind);
    }
    const renamed = this.fileSystem.rename(temporaryPath, finalPath, "store.install.rename");
    if (renamed.kind === "crashed") {
      return Object.freeze({ kind: "crashed", point: renamed.point });
    }
    if (renamed.kind !== "ok") {
      return this.installRetry(intent, renamed.kind);
    }
    const directorySynced = this.fileSystem.fsyncDirectory("/cas/objects", "store.install.directory-fsync");
    if (directorySynced.kind === "crashed") {
      return Object.freeze({ kind: "crashed", point: directorySynced.point });
    }
    if (directorySynced.kind !== "ok") {
      return this.installRetry(intent, directorySynced.kind);
    }
    this.recordInstalled(intent.inputs.sealedRoot, serialized.length);
    if (this.reachAck("store.install.ack", intent.actionId)) {
      return Object.freeze({ kind: "crashed", point: "store.install.ack" });
    }
    return this.observation(intent, "sealed-object-installed", Object.freeze({
      kind: "ok",
      value: Object.freeze({ alreadyPresent: false, root: intent.inputs.sealedRoot }),
    }));
  }

  private listPage(intent: Extract<StoreIntent, { readonly kind: "list-artifact-page" }>): SimPortExecution<StoreObservation> {
    if (
      intent.preconditions.expectedRoot !== intent.inputs.root
      || !this.isInstalled(intent.inputs.root)
      || intent.inputs.pageSize < 1
    ) {
      return this.observation(intent, "artifact-page-listed", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("store.list-precondition", "listing requires an installed expected root and positive page size"),
      }));
    }
    const tree = this.artifacts.get(intent.inputs.root);
    if (tree === null) {
      return this.observation(intent, "artifact-page-listed", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("store.list-root-absent", "artifact tree is absent"),
      }));
    }
    const directory = intent.inputs.directory;
    const binding = `${intent.inputs.root}:${directory}:${String(intent.inputs.pageSize)}`;
    const offset = intent.inputs.cursor === null ? 0 : pageCursorOffset(intent.inputs.cursor, binding);
    if (offset === null) {
      return this.observation(intent, "artifact-page-listed", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("store.cursor-mismatch", "page cursor is not bound to this root, directory, and page size"),
      }));
    }
    const prefix = `${directory}/`;
    const entries = tree.files
      .filter((file) => file.path.startsWith(prefix))
      .sort((left, right) => compareText(left.path, right.path));
    const page = entries.slice(offset, offset + intent.inputs.pageSize);
    const bytes = canonicalEncodeUnknown(Object.freeze({
      directory,
      entries: Object.freeze(page.map((file) => Object.freeze({
        length: file.bytes.length,
        path: file.path,
      }))),
      format: "pi-autopilot.sim-list-page.v1",
      root: intent.inputs.root,
    }));
    const created = this.artifacts.createBlob("store/list-page.json", bytes);
    if (created.kind !== "ok") {
      return this.observation(intent, "artifact-page-listed", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("store.list-result-invalid", created.diagnostic),
      }));
    }
    const persisted = this.persistListArtifact(created.tree.root, intent.actionId);
    if (persisted !== null) {
      return Object.freeze({ kind: "crashed", point: persisted });
    }
    const entriesRef = this.artifacts.reference(created.tree.root, "store/list-page.json");
    if (entriesRef === null) {
      return this.observation(intent, "artifact-page-listed", Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("store.list-result-missing", "list result reference could not be resolved"),
      }));
    }
    const nextOffset = offset + page.length;
    return this.observation(intent, "artifact-page-listed", Object.freeze({
      kind: "ok",
      value: Object.freeze({
        entries: entriesRef,
        nextCursor: nextOffset < entries.length ? pageCursorFor(nextOffset, binding) : null,
        root: intent.inputs.root,
      }),
    }));
  }

  private persistListArtifact(root: ArtifactRoot, actionId: string): "store.list.append" | "store.list.file-fsync" | "store.list.rename" | "store.list.directory-fsync" | "store.list.ack" | null {
    const bytes = this.artifacts.serialize(root);
    const finalPath = finalObjectPath(root);
    if (bytes === null || this.fileSystem.exists(finalPath)) {
      return null;
    }
    const temporaryPath = temporaryObjectPath(root, actionId);
    const append = this.fileSystem.appendFile(temporaryPath, bytes, "store.list.append");
    if (append.kind === "crashed") {
      return "store.list.append";
    }
    const fsync = this.fileSystem.fsyncFile(temporaryPath, "store.list.file-fsync");
    if (fsync.kind === "crashed") {
      return "store.list.file-fsync";
    }
    const rename = this.fileSystem.rename(temporaryPath, finalPath, "store.list.rename");
    if (rename.kind === "crashed") {
      return "store.list.rename";
    }
    const dirsync = this.fileSystem.fsyncDirectory("/cas/objects", "store.list.directory-fsync");
    if (dirsync.kind === "crashed") {
      return "store.list.directory-fsync";
    }
    this.recordInstalled(root, bytes.length);
    return this.reachAck("store.list.ack", actionId) ? "store.list.ack" : null;
  }

  private reachAck(point: "store.install.ack" | "store.list.ack", actionId: string): boolean {
    return this.trace.reachCrashPoint(point, Object.freeze({ actionId }));
  }

  private recordInstalled(root: ArtifactRoot, bytes: number): void {
    this.trace.recordSemantic("store", "object-installed", `store:${root}`, Object.freeze({ bytes, root }));
  }

  private installRetry(
    intent: Extract<StoreIntent, { readonly kind: "install-sealed-object" }>,
    operation: string,
  ): SimPortExecution<StoreObservation> {
    return this.observation(intent, "sealed-object-installed", Object.freeze({
      kind: "retry",
      diagnostic: diagnostic("store.install-operation", `store install ${operation}`),
    }));
  }

  private observation(
    intent: StoreIntent,
    kind: StoreObservation["kind"],
    result: unknown,
  ): SimPortExecution<StoreObservation> {
    const decoded = safeDecode(storeObservationCapsule, Object.freeze({
      actionId: intent.actionId,
      kind,
      result,
      runId: intent.runId,
    }));
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "observation", observation: decoded.value })
      : Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
  }
}
