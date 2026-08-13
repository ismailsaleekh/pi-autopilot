import {
  workspaceIntentCapsule,
} from "../../ports/contracts/workspace.capsule.js";
import type {
  WorkspaceIntent,
  WorkspaceObservation,
} from "../../ports/contracts/workspace.capsule.js";
import { childEpochSchema } from "../../authority/protocol/identifiers.js";
import type {
  ArtifactRoot,
  ChildEpoch,
  Digest,
  WorkspaceId,
} from "../../authority/protocol/identifiers.js";
import { defineCapsule } from "../../authority/protocol/schema.js";
import type { SimArtifactFile } from "./artifacts.js";
import { ArtifactCatalog } from "./artifacts.js";
import { SimLockManager } from "./sim-locks.js";
import type { PortTraceSink, SimPortExecution } from "./port-types.js";
import { diagnostic, safeDecode } from "./port-types.js";
import { artifactPath, cloneBytes } from "./values.js";

interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly baseRoot: ArtifactRoot;
  files: SimArtifactFile[];
  isolationPolicyDigest: Digest | null;
  childEpoch: ChildEpoch | null;
  occupied: boolean;
}

export interface WorkspaceImageEntry {
  readonly workspaceId: WorkspaceId;
  readonly baseRoot: ArtifactRoot;
  readonly files: readonly SimArtifactFile[];
  readonly isolationPolicyDigest: Digest | null;
  readonly childEpoch: ChildEpoch | null;
  readonly occupied: boolean;
}

export interface WorkspaceImage {
  readonly workspaces: readonly WorkspaceImageEntry[];
}

export type WorkspaceMutationResult =
  | { readonly kind: "ok"; readonly root: ArtifactRoot }
  | { readonly kind: "missing"; readonly diagnostic: string }
  | { readonly kind: "invalid"; readonly diagnostic: string };

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

const childEpochCapsule = defineCapsule("SimulationWorkspaceChildEpoch", childEpochSchema);

function cloneFiles(files: readonly SimArtifactFile[]): SimArtifactFile[] {
  return files.map((file) => Object.freeze({ path: file.path, bytes: file.bytes.slice() }));
}

function decodedChildEpoch(input: unknown): ChildEpoch | null {
  try {
    const encoded = childEpochCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = childEpochCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

function mutationDiagnostic(result: WorkspaceMutationResult | null): string {
  return result === null || result.kind === "ok" ? "workspace could not be allocated" : result.diagnostic;
}

/**
 * Models attempt-private mutable trees, isolation state, ownership leases,
 * occupied/ready inspection, epoch-fenced disposal, and sealed-root retention.
 * It cannot model kernel mount namespaces, permission races, or sandbox escape;
 * those remain mandatory real-suite concerns.
 */
export class SimWorkspacePort {
  private readonly artifacts: ArtifactCatalog;
  private readonly locks: SimLockManager;
  private readonly trace: PortTraceSink;
  private readonly workspaces = new Map<WorkspaceId, WorkspaceRecord>();
  private readonly observations = new Map<string, WorkspaceObservation>();

  public constructor(
    artifacts: ArtifactCatalog,
    locks: SimLockManager,
    trace: PortTraceSink,
    image?: WorkspaceImage,
  ) {
    this.artifacts = artifacts;
    this.locks = locks;
    this.trace = trace;
    if (image !== undefined) {
      for (const entry of image.workspaces) {
        this.workspaces.set(entry.workspaceId, {
          workspaceId: entry.workspaceId,
          baseRoot: entry.baseRoot,
          files: cloneFiles(entry.files),
          isolationPolicyDigest: entry.isolationPolicyDigest,
          childEpoch: entry.childEpoch,
          occupied: entry.occupied,
        });
      }
    }
  }

  public execute(input: unknown): SimPortExecution<WorkspaceObservation> {
    const decoded = safeDecode(workspaceIntentCapsule, input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    const cached = this.observations.get(decoded.value.actionId);
    if (cached !== undefined) {
      this.trace.recordContract("workspace", decoded.value.actionId, cached);
      return Object.freeze({ kind: "observation", observation: cached });
    }
    const observation = this.apply(decoded.value);
    if (observation.result.kind === "ok") {
      this.observations.set(decoded.value.actionId, observation);
    }
    this.trace.recordContract("workspace", decoded.value.actionId, observation);
    return Object.freeze({ kind: "observation", observation });
  }

  public materialize(workspaceId: WorkspaceId, baseRoot: ArtifactRoot): WorkspaceMutationResult {
    if (this.workspaces.has(workspaceId)) {
      return Object.freeze({ kind: "invalid", diagnostic: "workspace already exists" });
    }
    const tree = this.artifacts.get(baseRoot);
    if (tree === null) {
      return Object.freeze({ kind: "missing", diagnostic: "base artifact root is absent" });
    }
    this.workspaces.set(workspaceId, {
      workspaceId,
      baseRoot,
      files: cloneFiles(tree.files),
      isolationPolicyDigest: null,
      childEpoch: null,
      occupied: false,
    });
    return Object.freeze({ kind: "ok", root: baseRoot });
  }

  public writeFile(workspaceInput: unknown, pathInput: unknown, bytesInput: unknown): WorkspaceMutationResult {
    const workspaceId = typeof workspaceInput === "string" ? workspaceInput : "";
    const path = artifactPath(typeof pathInput === "string" ? pathInput : "");
    const bytes = cloneBytes(bytesInput);
    const record = [...this.workspaces.values()].find((candidate) => candidate.workspaceId === workspaceId);
    if (record === undefined) {
      return Object.freeze({ kind: "missing", diagnostic: "workspace is absent" });
    }
    if (path === null || bytes === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "workspace write requires a normalized path and Uint8Array bytes" });
    }
    const replacement = Object.freeze({ path, bytes });
    const priorIndex = record.files.findIndex((file) => file.path === path);
    if (priorIndex >= 0) {
      record.files[priorIndex] = replacement;
    } else {
      record.files.push(replacement);
      record.files.sort((left, right) => compareText(left.path, right.path));
    }
    const root = this.capture(record);
    return root === null
      ? Object.freeze({ kind: "invalid", diagnostic: "workspace tree could not be captured" })
      : Object.freeze({ kind: "ok", root });
  }

  public captureRoot(workspaceInput: unknown): ArtifactRoot | null {
    const workspaceId = typeof workspaceInput === "string" ? workspaceInput : "";
    const record = [...this.workspaces.values()].find((candidate) => candidate.workspaceId === workspaceId);
    return record === undefined ? null : this.capture(record);
  }

  public baseRoot(workspaceInput: unknown): ArtifactRoot | null {
    const workspaceId = typeof workspaceInput === "string" ? workspaceInput : "";
    const record = [...this.workspaces.values()].find((candidate) => candidate.workspaceId === workspaceId);
    return record?.baseRoot ?? null;
  }

  public files(workspaceInput: unknown): readonly SimArtifactFile[] {
    const workspaceId = typeof workspaceInput === "string" ? workspaceInput : "";
    const record = [...this.workspaces.values()].find((candidate) => candidate.workspaceId === workspaceId);
    return Object.freeze(record === undefined ? [] : cloneFiles(record.files));
  }

  public setChild(workspaceInput: unknown, epochInput: unknown, occupiedInput: unknown): boolean {
    const workspaceId = typeof workspaceInput === "string" ? workspaceInput : "";
    const epoch = decodedChildEpoch(epochInput);
    const record = [...this.workspaces.values()].find((candidate) => candidate.workspaceId === workspaceId);
    if (record === undefined || epoch === null || typeof occupiedInput !== "boolean") {
      return false;
    }
    record.childEpoch = epoch;
    record.occupied = occupiedInput;
    return true;
  }

  public markQuiescent(workspaceInput: unknown): boolean {
    const workspaceId = typeof workspaceInput === "string" ? workspaceInput : "";
    const record = [...this.workspaces.values()].find((candidate) => candidate.workspaceId === workspaceId);
    if (record === undefined) {
      return false;
    }
    record.occupied = false;
    return true;
  }

  public image(): WorkspaceImage {
    const workspaces = [...this.workspaces.values()]
      .sort((left, right) => compareText(left.workspaceId, right.workspaceId))
      .map((record) => Object.freeze({
        workspaceId: record.workspaceId,
        baseRoot: record.baseRoot,
        files: Object.freeze(cloneFiles(record.files)),
        isolationPolicyDigest: record.isolationPolicyDigest,
        childEpoch: record.childEpoch,
        occupied: record.occupied,
      }));
    return Object.freeze({ workspaces: Object.freeze(workspaces) });
  }

  private apply(intent: WorkspaceIntent): WorkspaceObservation {
    switch (intent.kind) {
      case "allocate-attempt-directory": {
        const acquired = this.locks.acquire(
          `workspace:${intent.inputs.workspaceId}`,
          intent.runId,
          intent.preconditions.leaseId,
        );
        const materialized = acquired.kind === "acquired"
          ? this.materialize(intent.inputs.workspaceId, intent.inputs.baseRoot)
          : null;
        if (acquired.kind !== "acquired" || materialized?.kind !== "ok") {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "attempt-directory-allocated",
            runId: intent.runId,
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic(
                "workspace.allocate-rejected",
                acquired.kind === "busy" ? "workspace lease is held by another owner" : mutationDiagnostic(materialized),
              ),
            }),
          });
        }
        return Object.freeze({
          actionId: intent.actionId,
          kind: "attempt-directory-allocated",
          runId: intent.runId,
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({
              materializedRoot: materialized.root,
              workspaceId: intent.inputs.workspaceId,
            }),
          }),
        });
      }
      case "apply-attempt-isolation": {
        const record = this.workspaces.get(intent.inputs.workspaceId);
        const root = record === undefined ? null : this.capture(record);
        if (
          record === undefined
          || root !== intent.preconditions.expectedWorkspaceRoot
          || !this.artifacts.has(intent.inputs.isolationPolicyRoot)
          || String(intent.inputs.isolationPolicyRoot) !== String(intent.preconditions.expectedPolicyDigest)
        ) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "attempt-isolation-applied",
            runId: intent.runId,
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic(
                "workspace.isolation-root-mismatch",
                "workspace or isolation-policy root does not match its explicit precondition",
              ),
            }),
          });
        }
        record.isolationPolicyDigest = intent.preconditions.expectedPolicyDigest;
        return Object.freeze({
          actionId: intent.actionId,
          kind: "attempt-isolation-applied",
          runId: intent.runId,
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({
              policyDigest: intent.preconditions.expectedPolicyDigest,
              workspaceId: intent.inputs.workspaceId,
            }),
          }),
        });
      }
      case "dispose-attempt-directory": {
        const record = this.workspaces.get(intent.inputs.workspaceId);
        if (record !== undefined && record.childEpoch !== null && record.childEpoch !== intent.preconditions.childEpoch) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "attempt-directory-disposed",
            runId: intent.runId,
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("workspace.stale-child-epoch", "stale child epoch cannot dispose the workspace"),
            }),
          });
        }
        const disposed = this.workspaces.delete(intent.inputs.workspaceId);
        if (disposed) {
          this.locks.releaseOwner(`workspace:${intent.inputs.workspaceId}`, intent.runId);
        }
        return Object.freeze({
          actionId: intent.actionId,
          kind: "attempt-directory-disposed",
          runId: intent.runId,
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({ disposed, workspaceId: intent.inputs.workspaceId }),
          }),
        });
      }
      case "inspect-attempt-directory": {
        const record = this.workspaces.get(intent.inputs.workspaceId);
        const root = record === undefined ? null : this.capture(record);
        return Object.freeze({
          actionId: intent.actionId,
          kind: "attempt-directory-inspected",
          runId: intent.runId,
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({
              observedRoot: root,
              state: record === undefined ? "absent" : record.occupied ? "occupied" : "ready",
              workspaceId: intent.inputs.workspaceId,
            }),
          }),
        });
      }
    }
  }

  private capture(record: WorkspaceRecord): ArtifactRoot | null {
    const created = this.artifacts.createTree(record.files);
    return created.kind === "ok" ? created.tree.root : null;
  }
}
