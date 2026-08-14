import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { artifactPathSchema, artifactRefSchema, kindIdSchema } from "../../authority/protocol/identifiers.js";
import type { ArtifactRef } from "../../authority/protocol/identifiers.js";
import { canonicalEncodeUnknown, defineCapsule } from "../../authority/protocol/schema.js";
import type { JsonValue } from "../../authority/protocol/schema.js";
import { workspaceIntentCapsule } from "../../ports/contracts/workspace.capsule.js";
import type { LawDriver, LawFixture, LawFixtureResult, LawPortName } from "../../ports/laws/contract-vector.js";
import { bindLawIntent } from "../../ports/laws/contract-vector.js";
import type { CanonicalArtifactInstaller } from "../../storage/cas/index.js";
import type { GitAdapter } from "../../adapters/git/index.js";
import type { WorkspaceAdapter } from "../../adapters/workspace/index.js";

interface NamedTree {
  readonly root: string;
  readonly revision: string;
  readonly gitTree: string;
}

export interface RealLawDriverOptions {
  readonly repository: string;
  readonly repositoryCapability: string;
  readonly publicationRef: string;
  readonly git: GitAdapter;
  readonly workspace: WorkspaceAdapter;
  readonly artifacts: CanonicalArtifactInstaller;
  readonly runGit: (cwd: string, arguments_: readonly string[]) => Promise<string>;
}

const pathCapsule = defineCapsule("RealLawArtifactPath", artifactPathSchema);
const kindCapsule = defineCapsule("RealLawArtifactKind", kindIdSchema);
const referenceCapsule = defineCapsule("RealLawArtifactReference", artifactRefSchema);

/** Real Git/workspace law driver backed by immutable CAS artifacts, never simulation state. */
export class RealLawDriver implements LawDriver {
  private readonly options: RealLawDriverOptions;
  private readonly trees = new Map<string, NamedTree>();
  private fixtureSequence = 0;

  public constructor(options: RealLawDriverOptions) {
    this.options = options;
  }

  public async fixture(request: LawFixture): Promise<LawFixtureResult> {
    this.fixtureSequence += 1;
    if (request.kind === "tree") {
      if (request.files.length === 0) return Object.freeze({ kind: "invalid", diagnostic: "real tree fixture requires a file" });
      for (const file of request.files) {
        const path = join(this.options.repository, ...file.path.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes);
      }
      await this.options.runGit(this.options.repository, ["add", "-A"]);
      await this.options.runGit(this.options.repository, ["commit", "-m", `law tree ${request.name}`]);
      const revision = await this.options.runGit(this.options.repository, ["rev-parse", "HEAD"]);
      const gitTree = await this.options.runGit(this.options.repository, ["rev-parse", "HEAD^{tree}"]);
      const installedTree = await this.options.artifacts.installTree(Object.freeze(request.files.map((file) => Object.freeze({ bytes: file.bytes, kind: "file", mode: 0o644, path: file.path }))));
      const manifest = await this.installArtifact(`law/manifest-${String(this.fixtureSequence)}.json`, canonicalEncodeUnknown(Object.freeze({ gitTree, revision })));
      const first = request.files[0];
      const firstFile = first === undefined ? null : await this.installArtifact(`law/file-${String(this.fixtureSequence)}.bin`, first.bytes);
      if (installedTree.kind !== "installed" || manifest === null || firstFile === null) return Object.freeze({ kind: "invalid", diagnostic: "real tree fixture could not install CAS evidence" });
      const tree = Object.freeze({ root: installedTree.root, revision, gitTree });
      this.trees.set(request.name, tree);
      return Object.freeze({ kind: "tree", name: request.name, root: tree.root, manifest, firstFile });
    }
    if (request.kind === "workspace") {
      const tree = this.trees.get(request.treeName);
      const template = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 900 + this.fixtureSequence);
      if (tree === undefined || template.kind !== "allocate-attempt-directory") return Object.freeze({ kind: "invalid", diagnostic: "real workspace fixture tree is absent" });
      const bound = bindLawIntent("workspace", Object.freeze({ inputs: template.inputs, kind: template.kind, preconditions: template.preconditions, runId: template.runId }));
      const allocated = await this.options.workspace.execute(bound);
      if (allocated.kind !== "observation" || allocated.observation.kind !== "attempt-directory-allocated" || allocated.observation.result.kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: "real workspace reservation failed" });
      return Object.freeze({
        kind: "workspace",
        name: request.name,
        workspaceId: template.inputs.workspaceId,
        workspaceCapability: template.inputs.workspaceCapability,
        root: tree.root,
        leaseId: template.preconditions.leaseId,
      });
    }
    if (request.kind === "repository") {
      const tree = this.trees.get(request.treeName);
      if (tree === undefined) return Object.freeze({ kind: "invalid", diagnostic: "real repository fixture tree is absent" });
      await this.options.runGit(this.options.repository, ["update-ref", this.options.publicationRef, tree.revision]);
      return Object.freeze({
        kind: "repository",
        name: request.name,
        runId: request.runId,
        repository: this.options.repositoryCapability,
        publicationRef: this.options.publicationRef,
        head: tree.revision,
        tree: tree.gitTree,
      });
    }
    if (request.kind === "repository-history") {
      const base = this.trees.get(request.baseTreeName);
      const candidate = this.trees.get(request.candidateTreeName);
      if (base === undefined || candidate === undefined) return Object.freeze({ kind: "invalid", diagnostic: "real repository history is incomplete" });
      await this.options.runGit(this.options.repository, ["update-ref", this.options.publicationRef, base.revision]);
      return Object.freeze({
        kind: "repository-history",
        name: request.name,
        runId: request.runId,
        repository: this.options.repositoryCapability,
        baseCommit: base.revision,
        baseTree: base.gitTree,
        candidateCommit: candidate.revision,
        candidateTree: candidate.gitTree,
        publicationRef: this.options.publicationRef,
      });
    }
    if (request.kind === "root-list") {
      const roots: string[] = [];
      for (const name of request.treeNames) {
        const tree = this.trees.get(name);
        if (tree === undefined) return Object.freeze({ kind: "invalid", diagnostic: "real root-list fixture tree is absent" });
        roots.push(tree.root);
      }
      const reference = await this.installArtifact(`law/root-list-${String(this.fixtureSequence)}.json`, canonicalEncodeUnknown(Object.freeze({ roots: Object.freeze(roots) })));
      return reference === null ? Object.freeze({ kind: "invalid", diagnostic: "real root-list artifact failed" }) : Object.freeze({ kind: "root-list", name: request.name, reference });
    }
    return Object.freeze({ kind: "invalid", diagnostic: `real Git/workspace driver does not implement ${request.kind} fixtures` });
  }

  public async dispatch(port: LawPortName, intent: JsonValue): Promise<unknown> {
    if (port === "git") return this.options.git.execute(intent);
    if (port === "workspace") return this.options.workspace.execute(intent);
    return Object.freeze({ kind: "rejected" });
  }

  public async advance(_ticks: string): Promise<void> {
    return;
  }

  public async readArtifact(reference: JsonValue): Promise<Uint8Array | null> {
    const decoded = referenceCapsule.decode(reference);
    if (decoded.kind !== "ok") return null;
    const numeric = Number(decoded.value.byteLength);
    if (!Number.isSafeInteger(numeric) || numeric < 0) return null;
    const read = await this.options.artifacts.read(decoded.value, numeric);
    return read.kind === "read" ? read.bytes : null;
  }

  public async containsSecretBytes(_bytes: Uint8Array): Promise<boolean> {
    return false;
  }

  private async installArtifact(pathText: string, bytes: Uint8Array): Promise<ArtifactRef | null> {
    const path = pathCapsule.decode(pathText);
    const codec = kindCapsule.decode("codec:real-law-artifact");
    const version = kindCapsule.decode("version:2");
    if (path.kind !== "ok" || codec.kind !== "ok" || version.kind !== "ok") return null;
    const installed = await this.options.artifacts.install(Object.freeze({ bytes, codec: codec.value, codecVersion: version.value, path: path.value }));
    return installed.kind === "installed" ? installed.reference : null;
  }
}
