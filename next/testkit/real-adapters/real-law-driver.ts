import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LawDriver,
  LawFixture,
  LawFixtureResult,
  LawPortName,
} from "../../ports/laws/contract-vector.js";
import type { JsonValue } from "../../authority/protocol/schema.js";
import { gitArtifactRootForTreeOid } from "../../adapters/git/index.js";
import type { GitAdapter } from "../../adapters/git/index.js";
import type { WorkspaceAdapter } from "../../adapters/workspace/index.js";

interface NamedTree {
  readonly root: string;
  readonly revision: string;
}

export interface RealLawDriverOptions {
  readonly repository: string;
  readonly integrationRoot: string;
  readonly git: GitAdapter;
  readonly workspace: WorkspaceAdapter;
  readonly runGit: (cwd: string, arguments_: readonly string[]) => Promise<string>;
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Independent real fixture driver; it imports no simulation implementation. */
export class RealLawDriver implements LawDriver {
  private readonly repository: string;
  private readonly integrationRoot: string;
  private readonly git: GitAdapter;
  private readonly workspace: WorkspaceAdapter;
  private readonly runGitCommand: (cwd: string, arguments_: readonly string[]) => Promise<string>;
  private readonly trees = new Map<string, NamedTree>();

  public constructor(options: RealLawDriverOptions) {
    this.repository = options.repository;
    this.integrationRoot = options.integrationRoot;
    this.git = options.git;
    this.workspace = options.workspace;
    this.runGitCommand = options.runGit;
  }

  public async fixture(request: LawFixture): Promise<LawFixtureResult> {
    if (request.kind === "tree") {
      for (const file of request.files) {
        const path = join(this.repository, ...file.path.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes);
      }
      await this.runGitCommand(this.repository, ["add", "-A"]);
      await this.runGitCommand(this.repository, ["commit", "-m", `law tree ${request.name}`]);
      const revision = await this.runGitCommand(this.repository, ["rev-parse", "HEAD"]);
      const treeOid = await this.runGitCommand(this.repository, ["rev-parse", "HEAD^{tree}"]);
      const root = gitArtifactRootForTreeOid(treeOid);
      if (root === null || request.files.length === 0) {
        return Object.freeze({ kind: "invalid", diagnostic: "real tree fixture failed" });
      }
      this.trees.set(request.name, Object.freeze({ revision, root }));
      return Object.freeze({
        kind: "tree",
        name: request.name,
        root,
        manifest: Object.freeze({ path: "git/tree-manifest.json", range: null, root }),
        firstFile: Object.freeze({ path: request.files[0]?.path ?? "law/absent", range: null, root }),
      });
    }
    if (request.kind === "repository") {
      const tree = this.trees.get(request.treeName);
      if (tree === undefined) {
        return Object.freeze({ kind: "invalid", diagnostic: "real repository fixture tree is absent" });
      }
      await this.runGitCommand(this.repository, [
        "update-ref",
        this.git.publicationRef,
        tree.revision,
      ]);
      return Object.freeze({
        kind: "repository",
        name: request.name,
        runId: request.runId,
        identity: tree.root,
        head: tree.revision,
        tree: tree.root,
      });
    }
    if (request.kind === "root-list") {
      const revisions: string[] = [];
      for (const name of request.treeNames) {
        const tree = this.trees.get(name);
        if (tree === undefined) {
          return Object.freeze({ kind: "invalid", diagnostic: "real root-list fixture tree is absent" });
        }
        revisions.push(tree.revision);
      }
      const bytes = new TextEncoder().encode(`${revisions.join("\n")}\n`);
      const root = hash(bytes);
      const directory = join(this.integrationRoot, "accepted-outputs");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, root.slice(7)), bytes);
      return Object.freeze({
        kind: "root-list",
        name: request.name,
        reference: Object.freeze({ path: "git/accepted-outputs.txt", range: null, root }),
      });
    }
    return Object.freeze({
      kind: "invalid",
      diagnostic: `real L6 law driver does not implement ${request.kind} fixtures`,
    });
  }

  public async dispatch(port: LawPortName, intent: JsonValue): Promise<unknown> {
    if (port === "git") {
      return this.git.execute(intent);
    }
    if (port === "workspace") {
      return this.workspace.execute(intent);
    }
    return Object.freeze({ kind: "rejected" });
  }

  public async advance(_ticks: number): Promise<void> {
    return;
  }

  public async readArtifact(reference: JsonValue): Promise<Uint8Array | null> {
    if (typeof reference !== "object" || reference === null || Array.isArray(reference)) {
      return null;
    }
    const root = Reflect.get(reference, "root");
    const path = Reflect.get(reference, "path");
    if (typeof root !== "string" || typeof path !== "string") {
      return null;
    }
    if (path === "git/accepted-outputs.txt") {
      try {
        return Uint8Array.from(await readFile(join(this.integrationRoot, "accepted-outputs", root.slice(7))));
      } catch {
        return null;
      }
    }
    return null;
  }

  public async containsSecretBytes(_bytes: Uint8Array): Promise<boolean> {
    return false;
  }
}
