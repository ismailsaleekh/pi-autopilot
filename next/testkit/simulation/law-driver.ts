import { workspaceIntentCapsule } from "../../ports/contracts/workspace.capsule.js";
import type {
  LawDriver,
  LawFixture,
  LawFixtureResult,
  LawPortName,
} from "../../ports/laws/contract-vector.js";
import type {
  ArtifactRoot,
  LeaseId,
  WorkspaceId,
} from "../../authority/protocol/identifiers.js";
import { canonicalEncodeUnknown } from "../../authority/protocol/schema.js";
import type { JsonValue } from "../../authority/protocol/schema.js";
import { SimWorld } from "./sim-world.js";
import { encodeUtf8, revisionIdFor } from "./values.js";

interface NamedTree {
  readonly root: ArtifactRoot;
}

interface NamedWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly root: ArtifactRoot;
  readonly leaseId: LeaseId;
}

/** Fake-side law driver. Real adapter suites implement the same laws-only interface. */
export class SimLawDriver implements LawDriver {
  public readonly world: SimWorld;
  private readonly trees = new Map<string, NamedTree>();
  private readonly workspaces = new Map<string, NamedWorkspace>();

  public constructor(seed: unknown = 1) {
    this.world = new SimWorld(seed);
  }

  public async fixture(request: LawFixture): Promise<LawFixtureResult> {
    if (request.kind === "tree") {
      const created = this.world.createArtifact(request.files);
      if (created.kind !== "ok" || created.tree.files.length === 0) {
        return Object.freeze({ kind: "invalid", diagnostic: "tree fixture could not be created" });
      }
      const manifestTree = this.world.artifacts.createBlob(
        "law/manifest.json",
        encodeUtf8(`law-tree:${request.name}:${created.tree.root}`),
      );
      const firstPath = created.tree.files[0]?.path;
      const manifest = manifestTree.kind === "ok"
        ? this.world.artifacts.reference(manifestTree.tree.root, "law/manifest.json")
        : null;
      const firstFile = firstPath === undefined
        ? null
        : this.world.artifacts.reference(created.tree.root, firstPath);
      if (manifest === null || firstFile === null) {
        return Object.freeze({ kind: "invalid", diagnostic: "tree fixture references could not be created" });
      }
      this.trees.set(request.name, Object.freeze({ root: created.tree.root }));
      return Object.freeze({
        kind: "tree",
        name: request.name,
        root: created.tree.root,
        manifest,
        firstFile,
      });
    }
    if (request.kind === "workspace") {
      const tree = this.trees.get(request.treeName);
      const template = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 217);
      if (tree === undefined || template.kind !== "allocate-attempt-directory") {
        return Object.freeze({ kind: "invalid", diagnostic: "workspace fixture tree or contract template is absent" });
      }
      const materialized = this.world.workspace.materialize(template.inputs.workspaceId, tree.root);
      if (materialized.kind !== "ok") {
        return Object.freeze({ kind: "invalid", diagnostic: materialized.diagnostic });
      }
      const value = Object.freeze({
        workspaceId: template.inputs.workspaceId,
        root: materialized.root,
        leaseId: template.preconditions.leaseId,
      });
      this.workspaces.set(request.name, value);
      return Object.freeze({ kind: "workspace", name: request.name, ...value });
    }
    if (request.kind === "repository") {
      const tree = this.trees.get(request.treeName);
      if (tree === undefined) {
        return Object.freeze({ kind: "invalid", diagnostic: "repository fixture tree is absent" });
      }
      const head = revisionIdFor(Object.freeze({ law: request.name, tree: tree.root }));
      const seeded = this.world.seedRepository(Object.freeze({
        head,
        identity: tree.root,
        kind: "repository",
        runId: request.runId,
        tree: tree.root,
      }));
      return seeded.kind === "seeded"
        ? Object.freeze({
            kind: "repository",
            name: request.name,
            runId: seeded.runId,
            identity: tree.root,
            head,
            tree: tree.root,
          })
        : Object.freeze({ kind: "invalid", diagnostic: seeded.diagnostic });
    }
    if (request.kind === "root-list") {
      const roots: string[] = [];
      for (const name of request.treeNames) {
        const tree = this.trees.get(name);
        if (tree === undefined) {
          return Object.freeze({ kind: "invalid", diagnostic: "root-list fixture names an absent tree" });
        }
        roots.push(tree.root);
      }
      const reference = this.world.git.createAcceptedOutputs(roots);
      return reference === null
        ? Object.freeze({ kind: "invalid", diagnostic: "root-list fixture could not be created" })
        : Object.freeze({ kind: "root-list", name: request.name, reference });
    }
    if (request.kind === "child-script") {
      const workspace = this.workspaces.get(request.workspaceName);
      if (workspace === undefined) {
        return Object.freeze({ kind: "invalid", diagnostic: "child script workspace fixture is absent" });
      }
      const events: unknown[] = request.writes.map((write) => Object.freeze({
        kind: "write",
        atTick: write.tick,
        path: write.path,
        bytes: write.bytes,
      }));
      if (request.sealTick !== null) {
        events.push(Object.freeze({ kind: "seal", atTick: request.sealTick }));
      }
      events.push(request.terminal === "exit"
        ? Object.freeze({ kind: "exit", atTick: request.terminalTick, code: 0 })
        : Object.freeze({ kind: request.terminal, atTick: request.terminalTick }));
      const registered = this.world.registerChildScript(Object.freeze({
        key: Object.freeze({ kind: "work-item-id", workItemId: request.workItemId }),
        events: Object.freeze(events),
      }));
      return registered.kind === "registered"
        ? Object.freeze({ kind: "child-script", name: request.name })
        : Object.freeze({ kind: "invalid", diagnostic: registered.diagnostic });
    }
    const registered = this.world.registerSecret(request.handle, request.bytes);
    return registered.kind === "registered"
      ? Object.freeze({ kind: "secret", name: request.name, handle: registered.handle })
      : Object.freeze({ kind: "invalid", diagnostic: registered.diagnostic });
  }

  public async dispatch(port: LawPortName, intent: JsonValue): Promise<unknown> {
    return this.world.dispatch(port, intent);
  }

  public async advance(ticks: number): Promise<void> {
    this.world.advance(ticks);
  }

  public async readArtifact(reference: JsonValue): Promise<Uint8Array | null> {
    return this.world.store.readBytes(reference);
  }

  public async containsSecretBytes(bytes: Uint8Array): Promise<boolean> {
    if (bytes.length === 0) {
      return false;
    }
    const haystack = canonicalEncodeUnknown(this.world.trace.snapshot());
    outer: for (let start = 0; start + bytes.length <= haystack.length; start += 1) {
      for (let offset = 0; offset < bytes.length; offset += 1) {
        if (haystack[start + offset] !== bytes[offset]) {
          continue outer;
        }
      }
      return true;
    }
    return false;
  }
}
