import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  gitIntentCapsule,
  gitObservationCapsule,
} from "../../ports/contracts/git.capsule.js";
import type {
  GitIntent,
  GitObservation,
} from "../../ports/contracts/git.capsule.js";
import {
  DEFAULT_GIT_OUTPUT_LIMIT,
  runGit,
} from "./git-process.js";

export interface GitAdapterDiagnostic {
  readonly code: string;
  readonly message: string;
}

export type GitAdapterExecution =
  | { readonly kind: "observation"; readonly observation: GitObservation }
  | { readonly kind: "rejected"; readonly diagnostic: GitAdapterDiagnostic };

export interface GitWorkspaceLocator {
  readonly workspaceRoot: string;
  readonly pathFor: (workspaceId: string) => string | null;
}

export interface GitAdapterOptions {
  /** Read-only source checkout used only as a local clone object source/ref target. */
  readonly repository: string;
  /** Frozen publication target required because GitIntent carries no repo/ref fields. */
  readonly publicationRef: string;
  /** Run-owned private directory used for disposable integration clones. */
  readonly integrationRoot: string;
  readonly workspace: GitWorkspaceLocator;
  readonly maxOutputBytes?: number;
  /** Test-only observation at the physical CAS window; never changes semantics. */
  readonly publicationObserver?: (point: "before-update-ref") => void | Promise<void>;
}

export type GitAdapterCreateResult =
  | { readonly kind: "created"; readonly adapter: GitAdapter }
  | { readonly kind: "rejected"; readonly diagnostic: GitAdapterDiagnostic };

export type GitTreeEntry =
  | {
      readonly kind: "directory";
      readonly mode: number;
      readonly path: string;
    }
  | {
      readonly bytes: Uint8Array;
      readonly kind: "file";
      readonly mode: number;
      readonly path: string;
    }
  | {
      readonly kind: "symlink";
      readonly mode: number;
      readonly path: string;
      readonly target: string;
    };

export interface GitDiffEntry {
  readonly kind: "added" | "deleted" | "modified" | "renamed" | "type-changed";
  readonly newEntryKind: "file" | "gitlink" | "symlink" | null;
  readonly newMode: string | null;
  readonly newObject: string | null;
  readonly oldEntryKind: "file" | "gitlink" | "symlink" | null;
  readonly oldMode: string | null;
  readonly oldObject: string | null;
  readonly oldPath: string | null;
  readonly path: string;
  readonly similarity: number | null;
}

export interface GitSealRead {
  readonly entries: readonly GitTreeEntry[];
  readonly manifestBytes: Uint8Array;
  readonly root: string;
}

export type GitSealReadResult =
  | { readonly kind: "read"; readonly value: GitSealRead }
  | { readonly kind: "retry"; readonly diagnostic: GitAdapterDiagnostic };

export type GitCompareReadResult =
  | {
      readonly kind: "compared";
      readonly diffBytes: Uint8Array;
      readonly entries: readonly GitDiffEntry[];
      readonly equal: boolean;
    }
  | { readonly kind: "retry"; readonly diagnostic: GitAdapterDiagnostic };

const GIT_OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
type GitObjectFormat = "sha1" | "sha256";
const AUTHOR_ENV = Object.freeze({
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_AUTHOR_EMAIL: "autopilot@invalid",
  GIT_AUTHOR_NAME: "Pi Autopilot",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_EMAIL: "autopilot@invalid",
  GIT_COMMITTER_NAME: "Pi Autopilot",
});

interface TreeListRecord {
  readonly mode: string;
  readonly object: string;
  readonly path: string;
  readonly type: string;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function diagnostic(code: string, message: string): GitAdapterDiagnostic {
  return Object.freeze({ code, message });
}

function contractDiagnostic(code: string, message: string) {
  return Object.freeze({ code, message, related: Object.freeze([]) });
}

function systemCode(error: unknown): string | null {
  try {
    if (typeof error !== "object" || error === null) {
      return null;
    }
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Reversible within one repository's pinned Git object format. */
export function gitArtifactRootForTreeOid(
  tree: string,
  format?: GitObjectFormat,
): string | null {
  const selected = format ?? (tree.length === 40 ? "sha1" : tree.length === 64 ? "sha256" : null);
  if (
    selected === null
    || !GIT_OID.test(tree)
    || (selected === "sha1" && tree.length !== 40)
    || (selected === "sha256" && tree.length !== 64)
  ) {
    return null;
  }
  return selected === "sha1" ? `sha256:${tree}${"0".repeat(24)}` : `sha256:${tree}`;
}

function treeOidFromArtifactRoot(root: string, format: GitObjectFormat): string | null {
  if (!/^sha256:[0-9a-f]{64}$/.test(root)) {
    return null;
  }
  const hex = root.slice(7);
  if (format === "sha256") {
    return hex;
  }
  return hex.slice(40) === "0".repeat(24) ? hex.slice(0, 40) : null;
}

function canonicalText(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalText(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const fields = Object.keys(value).sort(compareText).map((field) => {
      let child: unknown;
      try {
        child = Reflect.get(value, field);
      } catch {
        child = null;
      }
      return `${JSON.stringify(field)}:${canonicalText(child)}`;
    });
    return `{${fields.join(",")}}`;
  }
  return "null";
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalText(value));
}

function artifactReference(root: string, path: string) {
  return Object.freeze({ path, range: null, root });
}

function safeDecode(input: unknown):
  | { readonly kind: "ok"; readonly value: GitIntent }
  | { readonly kind: "error"; readonly diagnostic: GitAdapterDiagnostic } {
  try {
    const encoded = gitIntentCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return Object.freeze({
        kind: "error",
        diagnostic: diagnostic("git.invalid-intent", "git intent does not satisfy the frozen contract"),
      });
    }
    const decoded = gitIntentCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "ok", value: decoded.value })
      : Object.freeze({
          kind: "error",
          diagnostic: diagnostic("git.invalid-intent", "git intent is not canonically encoded"),
        });
  } catch {
    return Object.freeze({
      kind: "error",
      diagnostic: diagnostic("git.uninspectable-intent", "git intent could not be inspected safely"),
    });
  }
}

function splitNul(bytes: Uint8Array): readonly string[] | null {
  const text = decodeUtf8(bytes);
  if (text === null) {
    return null;
  }
  const fields = text.split("\u0000");
  if (fields[fields.length - 1] === "") {
    fields.pop();
  }
  return Object.freeze(fields);
}

function parseTreeList(bytes: Uint8Array): readonly TreeListRecord[] | null {
  const fields = splitNul(bytes);
  if (fields === null) {
    return null;
  }
  const records: TreeListRecord[] = [];
  for (const field of fields) {
    const separator = field.indexOf("\t");
    if (separator < 0) {
      return null;
    }
    const header = field.slice(0, separator).split(" ");
    if (header.length !== 3) {
      return null;
    }
    const mode = header[0];
    const type = header[1];
    const object = header[2];
    if (mode === undefined || type === undefined || object === undefined || !GIT_OID.test(object)) {
      return null;
    }
    records.push(Object.freeze({
      mode,
      object,
      path: field.slice(separator + 1),
      type,
    }));
  }
  return Object.freeze(records);
}

function entryKindForMode(mode: string): "file" | "gitlink" | "symlink" | null {
  if (mode === "000000") {
    return null;
  }
  if (mode === "120000") {
    return "symlink";
  }
  return mode === "160000" ? "gitlink" : "file";
}

function parseRawDiff(bytes: Uint8Array): readonly GitDiffEntry[] | null {
  const fields = splitNul(bytes);
  if (fields === null) {
    return null;
  }
  const entries: GitDiffEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const record = fields[index];
    if (record === undefined || !record.startsWith(":")) {
      return null;
    }
    const separator = record.indexOf("\t");
    const header = separator < 0 ? record : record.slice(0, separator);
    const inlinePath = separator < 0 ? null : record.slice(separator + 1);
    const parts = header.slice(1).split(" ");
    if (parts.length !== 5) {
      return null;
    }
    const oldMode = parts[0];
    const newMode = parts[1];
    const oldObject = parts[2];
    const newObject = parts[3];
    const status = parts[4];
    if (
      oldMode === undefined
      || newMode === undefined
      || oldObject === undefined
      || newObject === undefined
      || status === undefined
      || !GIT_OID.test(oldObject)
      || !GIT_OID.test(newObject)
    ) {
      return null;
    }
    const letter = status[0];
    const scoreText = status.slice(1);
    const score = scoreText.length === 0 ? null : Number(scoreText);
    if (letter === "R" || letter === "C") {
      const oldPath = inlinePath ?? fields[index + 1];
      const oldPathOffset = inlinePath === null ? 1 : 0;
      const newPath = fields[index + oldPathOffset + 1];
      if (oldPath === undefined || newPath === undefined || !Number.isSafeInteger(score)) {
        return null;
      }
      entries.push(Object.freeze({
        kind: letter === "R" ? "renamed" : "added",
        newEntryKind: entryKindForMode(newMode),
        newMode,
        newObject,
        oldEntryKind: entryKindForMode(oldMode),
        oldMode,
        oldObject,
        oldPath,
        path: newPath,
        similarity: score,
      }));
      index += oldPathOffset + 2;
      continue;
    }
    const path = inlinePath ?? fields[index + 1];
    if (path === undefined) {
      return null;
    }
    const kind = letter === "A"
      ? "added"
      : letter === "D"
        ? "deleted"
        : oldMode !== newMode && (oldMode === "120000" || newMode === "120000")
          ? "type-changed"
          : "modified";
    entries.push(Object.freeze({
      kind,
      newEntryKind: entryKindForMode(newMode),
      newMode: newMode === "000000" ? null : newMode,
      newObject: newMode === "000000" ? null : newObject,
      oldEntryKind: entryKindForMode(oldMode),
      oldMode: oldMode === "000000" ? null : oldMode,
      oldObject: oldMode === "000000" ? null : oldObject,
      oldPath: letter === "D" ? path : null,
      path,
      similarity: null,
    }));
    index += inlinePath === null ? 2 : 1;
  }
  return Object.freeze(entries);
}

function revisionText(bytes: Uint8Array): string | null {
  const text = decodeUtf8(bytes)?.trim() ?? "";
  return GIT_OID.test(text) ? text : null;
}

async function ensureRealDirectory(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return status.isDirectory() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Git CLI leaf. Runtime supplies one immutable repository/ref binding because the
 * frozen intents do not carry a repository locator or publication ref.
 *
 * Seal split: this adapter reads an exact Git tree/workspace tree and emits stable
 * manifest bytes. runtime/seal + storage/CAS own durable capture and ArtifactRef
 * installation; this adapter never writes the CAS or journal.
 */
export class GitAdapter {
  readonly repository: string;
  readonly publicationRef: string;
  readonly integrationRoot: string;
  private readonly workspace: GitWorkspaceLocator;
  private readonly maxOutputBytes: number;
  private readonly objectFormat: GitObjectFormat;
  private readonly publicationObserver: ((point: "before-update-ref") => void | Promise<void>) | null;

  private constructor(options: GitAdapterOptions, objectFormat: GitObjectFormat) {
    this.repository = resolve(options.repository);
    this.publicationRef = options.publicationRef;
    this.integrationRoot = resolve(options.integrationRoot);
    this.workspace = options.workspace;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT;
    this.objectFormat = objectFormat;
    this.publicationObserver = options.publicationObserver ?? null;
  }

  public static async create(options: GitAdapterOptions): Promise<GitAdapterCreateResult> {
    try {
      if (
        typeof options !== "object"
        || options === null
        || typeof options.repository !== "string"
        || options.repository.length === 0
        || typeof options.integrationRoot !== "string"
        || options.integrationRoot.length === 0
        || typeof options.publicationRef !== "string"
        || !REF_PATTERN.test(options.publicationRef)
        || options.publicationRef.includes("..")
        || options.publicationRef.endsWith("/")
        || !Number.isSafeInteger(options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT)
        || (options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT) < 1024
      ) {
        return Object.freeze({
          kind: "rejected",
          diagnostic: diagnostic("git.invalid-options", "git adapter options are invalid"),
        });
      }
      const repository = resolve(options.repository);
      const integrationRoot = resolve(options.integrationRoot);
      if (!await ensureRealDirectory(repository)) {
        return Object.freeze({
          kind: "rejected",
          diagnostic: diagnostic("git.repository-unavailable", "repository must be a real directory"),
        });
      }
      if (!await ensureRealDirectory(integrationRoot)) {
        return Object.freeze({
          kind: "rejected",
          diagnostic: diagnostic("git.integration-root-unsafe", "integration root must be a real directory"),
        });
      }
      const probe = await runGit(["rev-parse", "--git-dir"], {
        cwd: repository,
        maxOutputBytes: options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT,
      });
      const formatProbe = await runGit(["rev-parse", "--show-object-format"], {
        cwd: repository,
        maxOutputBytes: options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT,
      });
      const objectFormatText = formatProbe.kind === "exited" && formatProbe.code === 0
        ? decodeUtf8(formatProbe.stdout)?.trim()
        : null;
      const objectFormat: GitObjectFormat | null = objectFormatText === "sha1" || objectFormatText === "sha256"
        ? objectFormatText
        : null;
      if (
        probe.kind !== "exited"
        || probe.code !== 0
        || probe.stdoutTruncated
        || objectFormat === null
      ) {
        return Object.freeze({
          kind: "rejected",
          diagnostic: diagnostic("git.repository-invalid", "repository is not a readable Git repository"),
        });
      }
      return Object.freeze({ kind: "created", adapter: new GitAdapter(options, objectFormat) });
    } catch {
      return Object.freeze({
        kind: "rejected",
        diagnostic: diagnostic("git.create-failed", "git adapter could not be created"),
      });
    }
  }

  public async execute(input: unknown): Promise<GitAdapterExecution> {
    const decoded = safeDecode(input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    switch (decoded.value.kind) {
      case "materialize-workspace":
        return gitIntentHandlers["materialize-workspace"](this, decoded.value);
      case "seal-workspace":
        return gitIntentHandlers["seal-workspace"](this, decoded.value);
      case "compare-roots":
        return gitIntentHandlers["compare-roots"](this, decoded.value);
      case "integrate-candidate":
        return gitIntentHandlers["integrate-candidate"](this, decoded.value);
      case "publish-if-expected-head":
        return gitIntentHandlers["publish-if-expected-head"](this, decoded.value);
    }
  }

  public async readTree(rootInput: string): Promise<GitSealReadResult> {
    const tree = await this.resolveTree(rootInput);
    if (tree === null) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.tree-absent", "requested Git tree is absent"),
      });
    }
    const listed = await runGit(["ls-tree", "-r", "-t", "-z", "--full-tree", tree], {
      cwd: this.repository,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (
      listed.kind !== "exited"
      || listed.code !== 0
      || listed.stdoutTruncated
    ) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.tree-read-failed", "Git tree could not be enumerated within the configured output bound"),
      });
    }
    const records = parseTreeList(listed.stdout);
    if (records === null) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.tree-invalid", "Git tree listing could not be normalized"),
      });
    }
    const entries: GitTreeEntry[] = [];
    for (const record of records) {
      if (record.type === "tree") {
        entries.push(Object.freeze({
          kind: "directory",
          mode: Number.parseInt(record.mode, 8),
          path: record.path,
        }));
      } else if (record.type === "blob" && record.mode === "120000") {
        const blob = await runGit(["cat-file", "blob", record.object], {
          cwd: this.repository,
          maxOutputBytes: this.maxOutputBytes,
        });
        if (blob.kind !== "exited" || blob.code !== 0 || blob.stdoutTruncated) {
          return Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("git.symlink-read-failed", "Git symlink target could not be read"),
          });
        }
        const target = decodeUtf8(blob.stdout);
        if (target === null) {
          return Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("git.symlink-invalid", "Git symlink target is not valid UTF-8"),
          });
        }
        entries.push(Object.freeze({
          kind: "symlink",
          mode: 0o777,
          path: record.path,
          target,
        }));
      } else if (record.type === "blob") {
        const blob = await runGit(["cat-file", "blob", record.object], {
          cwd: this.repository,
          maxOutputBytes: this.maxOutputBytes,
        });
        if (blob.kind !== "exited" || blob.code !== 0 || blob.stdoutTruncated) {
          return Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("git.blob-read-failed", "Git blob could not be read within the configured output bound"),
          });
        }
        entries.push(Object.freeze({
          bytes: blob.stdout,
          kind: "file",
          mode: record.mode === "100755" ? 0o755 : 0o644,
          path: record.path,
        }));
      } else {
        return Object.freeze({
          kind: "retry",
          diagnostic: diagnostic("git.unsupported-entry", "Git tree contains an unsupported entry type"),
        });
      }
    }
    const manifestBytes = canonicalBytes(Object.freeze({
      entries: Object.freeze(entries.map((entry) => entry.kind === "file"
        ? Object.freeze({
            digest: hashBytes(entry.bytes),
            kind: entry.kind,
            mode: entry.mode,
            path: entry.path,
          })
        : entry)),
      format: "pi-autopilot.git-tree-read.v1",
      tree,
    }));
    const root = gitArtifactRootForTreeOid(tree, this.objectFormat);
    return root === null
      ? Object.freeze({
          kind: "retry",
          diagnostic: diagnostic("git.tree-root-invalid", "Git tree cannot be represented by ArtifactRoot"),
        })
      : Object.freeze({
          kind: "read",
          value: Object.freeze({
            entries: Object.freeze(entries),
            manifestBytes,
            root,
          }),
        });
  }

  public async compareTrees(left: string, right: string): Promise<GitCompareReadResult> {
    const leftTree = await this.resolveTree(left);
    const rightTree = await this.resolveTree(right);
    if (leftTree === null || rightTree === null) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.compare-root-absent", "one or both compared Git trees are absent"),
      });
    }
    const compared = await runGit([
      "diff-tree",
      "--no-commit-id",
      "--root",
      "--raw",
      "-z",
      "-r",
      "-M",
      "--no-ext-diff",
      leftTree,
      rightTree,
    ], {
      cwd: this.repository,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (compared.kind !== "exited" || compared.code !== 0 || compared.stdoutTruncated) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.compare-failed", "Git trees could not be compared within the configured output bound"),
      });
    }
    const entries = parseRawDiff(compared.stdout);
    if (entries === null) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.diff-invalid", "Git diff could not be normalized"),
      });
    }
    const diffBytes = canonicalBytes(Object.freeze({
      entries,
      format: "pi-autopilot.git-diff.v1",
      leftTree,
      rightTree,
    }));
    return Object.freeze({
      kind: "compared",
      diffBytes,
      entries,
      equal: leftTree === rightTree,
    });
  }

  public async materialize(
    intent: Extract<GitIntent, { readonly kind: "materialize-workspace" }>,
  ): Promise<GitAdapterExecution> {
    const destination = this.workspace.pathFor(intent.inputs.workspaceId);
    if (destination === null) {
      return this.observation(intent, "workspace-materialized", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.workspace-invalid", "workspace ID cannot name a private clone"),
      }));
    }
    try {
      const destinationStatus = await lstat(destination);
      if (!destinationStatus.isDirectory() || destinationStatus.isSymbolicLink()) {
        return this.observation(intent, "workspace-materialized", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.workspace-unsafe", "workspace clone destination is not a real directory"),
        }));
      }
      try {
        await lstat(join(destination, ".git"));
        return this.observation(intent, "workspace-materialized", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.workspace-not-empty", "workspace clone destination is already materialized"),
        }));
      } catch (error: unknown) {
        if (systemCode(error) !== "ENOENT") {
          return this.observation(intent, "workspace-materialized", Object.freeze({
            kind: "retry",
            diagnostic: contractDiagnostic("git.workspace-inspect", "workspace clone destination could not be inspected"),
          }));
        }
      }
    } catch (error: unknown) {
      if (systemCode(error) !== "ENOENT") {
        return this.observation(intent, "workspace-materialized", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.workspace-inspect", "workspace clone destination could not be inspected"),
        }));
      }
    }
    const revision = await this.resolveRevision(intent.inputs.baseRevision);
    if (revision === null) {
      return this.observation(intent, "workspace-materialized", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.base-absent", "base revision is absent from the repository"),
      }));
    }
    const tree = await this.resolveTree(revision);
    const snapshotTree = await this.resolveTree(intent.inputs.repositorySnapshot);
    const identityTree = await this.resolveTree(intent.preconditions.repositoryIdentity);
    if (tree === null || snapshotTree !== tree || identityTree !== tree) {
      return this.observation(intent, "workspace-materialized", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.snapshot-mismatch", "base revision does not match the requested repository snapshot"),
      }));
    }
    const clone = await runGit([
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      "--no-tags",
      "--",
      this.repository,
      destination,
    ], {
      cwd: this.workspace.workspaceRoot,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (clone.kind !== "exited" || clone.code !== 0) {
      return this.observation(intent, "workspace-materialized", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.clone-failed", "repository could not be cloned into the private workspace"),
      }));
    }
    const checkout = await runGit(["checkout", "--detach", "--force", revision], {
      cwd: destination,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (checkout.kind !== "exited" || checkout.code !== 0) {
      return this.observation(intent, "workspace-materialized", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.checkout-failed", "exact base revision could not be checked out"),
      }));
    }
    return this.observation(intent, "workspace-materialized", Object.freeze({
      kind: "ok",
      value: Object.freeze({
        baseRevision: intent.inputs.baseRevision,
        materializedRoot: intent.inputs.repositorySnapshot,
        workspaceId: intent.inputs.workspaceId,
      }),
    }));
  }

  public async seal(
    intent: Extract<GitIntent, { readonly kind: "seal-workspace" }>,
  ): Promise<GitAdapterExecution> {
    const destination = this.workspace.pathFor(intent.inputs.workspaceId);
    if (destination === null) {
      return this.observation(intent, "workspace-sealed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.workspace-invalid", "workspace ID is unsafe"),
      }));
    }
    const headTree = await runGit(["rev-parse", "HEAD^{tree}"], {
      cwd: destination,
      maxOutputBytes: this.maxOutputBytes,
    });
    const baseTree = headTree.kind === "exited" && headTree.code === 0
      ? revisionText(headTree.stdout)
      : null;
    const expectedRoot = baseTree === null ? null : gitArtifactRootForTreeOid(baseTree, this.objectFormat);
    if (
      baseTree === null
      || expectedRoot === null
      || expectedRoot !== intent.preconditions.expectedInputRoot
    ) {
      return this.observation(intent, "workspace-sealed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.seal-precondition", "workspace input tree does not match the expected root"),
      }));
    }
    const staged = await runGit(["add", "-A", "--", "."], {
      cwd: destination,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (staged.kind !== "exited" || staged.code !== 0) {
      return this.observation(intent, "workspace-sealed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.seal-index", "workspace tree could not be read into an isolated Git index"),
      }));
    }
    const written = await runGit(["write-tree"], {
      cwd: destination,
      maxOutputBytes: this.maxOutputBytes,
    });
    const tree = written.kind === "exited" && written.code === 0 ? revisionText(written.stdout) : null;
    if (tree === null) {
      return this.observation(intent, "workspace-sealed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.seal-tree", "workspace tree could not be normalized"),
      }));
    }
    const read = await this.readTreeFrom(destination, tree);
    if (read.kind === "retry") {
      return this.observation(intent, "workspace-sealed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic(read.diagnostic.code, read.diagnostic.message),
      }));
    }
    const outputRoot = read.value.root;
    if (outputRoot.length === 0) {
      return this.observation(intent, "workspace-sealed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.seal-root", "sealed Git tree cannot be represented by ArtifactRoot"),
      }));
    }
    return this.observation(intent, "workspace-sealed", Object.freeze({
      kind: "ok",
      value: Object.freeze({
        manifest: artifactReference(hashBytes(read.value.manifestBytes), "git/tree-manifest.json"),
        outputRoot,
        workspaceId: intent.inputs.workspaceId,
      }),
    }));
  }

  public async compare(
    intent: Extract<GitIntent, { readonly kind: "compare-roots" }>,
  ): Promise<GitAdapterExecution> {
    const repositoryIdentity = await this.resolveTree(intent.preconditions.repositoryIdentity);
    if (repositoryIdentity === null) {
      return this.observation(intent, "roots-compared", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.repository-identity", "repository identity is absent from the configured repository"),
      }));
    }
    const compared = await this.compareTrees(intent.inputs.leftRoot, intent.inputs.rightRoot);
    if (compared.kind === "retry") {
      return this.observation(intent, "roots-compared", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic(compared.diagnostic.code, compared.diagnostic.message),
      }));
    }
    return this.observation(intent, "roots-compared", Object.freeze({
      kind: "ok",
      value: Object.freeze({
        diff: artifactReference(hashBytes(compared.diffBytes), "git/diff.json"),
        equal: compared.equal,
        leftRoot: intent.inputs.leftRoot,
        rightRoot: intent.inputs.rightRoot,
      }),
    }));
  }

  public async integrate(
    intent: Extract<GitIntent, { readonly kind: "integrate-candidate" }>,
  ): Promise<GitAdapterExecution> {
    const base = await this.resolveRevision(intent.inputs.baseRevision);
    const expectedTree = base === null ? null : await this.resolveTree(base);
    const contractTree = await this.resolveTree(intent.preconditions.expectedIntegrationRoot);
    const repositoryIdentity = await this.resolveTree(intent.preconditions.repositoryIdentity);
    if (
      base === null
      || expectedTree === null
      || contractTree !== expectedTree
      || repositoryIdentity !== expectedTree
    ) {
      return this.observation(intent, "candidate-integrated", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.integrate-precondition", "integration base does not match the expected repository tree"),
      }));
    }
    const accepted = await this.readAcceptedOutputs(intent.inputs.acceptedOutputs);
    if (accepted === null || accepted.length === 0) {
      return this.observation(intent, "candidate-integrated", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.accepted-outputs", "accepted output manifest is absent or invalid"),
      }));
    }
    const privateClone = join(this.integrationRoot, `integrate-${intent.actionId.slice(14)}`);
    {
      const clone = await runGit([
        "clone",
        "--no-local",
        "--no-hardlinks",
        "--no-checkout",
        "--no-tags",
        "--",
        this.repository,
        privateClone,
      ], {
        cwd: this.integrationRoot,
        maxOutputBytes: this.maxOutputBytes,
      });
      if (clone.kind !== "exited" || clone.code !== 0) {
        return this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.integration-clone", "integration repository clone failed"),
        }));
      }
      const checkout = await runGit(["checkout", "--detach", "--force", base], {
        cwd: privateClone,
        maxOutputBytes: this.maxOutputBytes,
      });
      if (checkout.kind !== "exited" || checkout.code !== 0) {
        return this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.integration-checkout", "integration base could not be checked out"),
        }));
      }
      let parent = base;
      for (const candidate of accepted) {
        const fetched = await runGit(["fetch", "--no-write-fetch-head", "--no-tags", "--", this.repository, candidate], {
          cwd: privateClone,
          maxOutputBytes: this.maxOutputBytes,
        });
        if (fetched.kind !== "exited" || fetched.code !== 0) {
          return this.observation(intent, "candidate-integrated", Object.freeze({
            kind: "retry",
            diagnostic: contractDiagnostic("git.candidate-fetch", "accepted candidate revision could not be imported"),
          }));
        }
        const revision = await this.resolveRevisionIn(privateClone, candidate);
        if (revision === null) {
          return this.observation(intent, "candidate-integrated", Object.freeze({
            kind: "retry",
            diagnostic: contractDiagnostic("git.candidate-absent", "accepted candidate revision is absent"),
          }));
        }
        const merge = await runGit(["merge", "--no-ff", "--no-edit", revision], {
          cwd: privateClone,
          extraEnvironment: AUTHOR_ENV,
          maxOutputBytes: this.maxOutputBytes,
        });
        if (merge.kind !== "exited" || merge.code !== 0) {
          const conflicts = await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], {
            cwd: privateClone,
            maxOutputBytes: this.maxOutputBytes,
          });
          const paths = conflicts.kind === "exited" && conflicts.code === 0 && !conflicts.stdoutTruncated
            ? splitNul(conflicts.stdout)
            : null;
          const detail = canonicalBytes(Object.freeze({
            format: "pi-autopilot.git-conflict.v1",
            paths: paths ?? Object.freeze([]),
          }));
          return this.observation(intent, "candidate-integrated", Object.freeze({
            kind: "retry",
            diagnostic: Object.freeze({
              code: "git.integration-conflict",
              message: "candidate integration produced conflicts",
              related: Object.freeze([artifactReference(hashBytes(detail), "git/conflict.json")]),
            }),
          }));
        }
        const head = await runGit(["rev-parse", "HEAD"], {
          cwd: privateClone,
          maxOutputBytes: this.maxOutputBytes,
        });
        const merged = head.kind === "exited" && head.code === 0 ? revisionText(head.stdout) : null;
        if (merged === null) {
          return this.observation(intent, "candidate-integrated", Object.freeze({
            kind: "retry",
            diagnostic: contractDiagnostic("git.integration-revision", "integrated revision could not be observed"),
          }));
        }
        parent = merged;
      }
      const treeOutput = await runGit(["rev-parse", `${parent}^{tree}`], {
        cwd: privateClone,
        maxOutputBytes: this.maxOutputBytes,
      });
      const treeOid = treeOutput.kind === "exited" && treeOutput.code === 0
        ? revisionText(treeOutput.stdout)
        : null;
      if (treeOid === null) {
        return this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.integration-tree", "integrated tree could not be observed"),
        }));
      }
      const parentArguments = parent === base
        ? ["commit-tree", treeOid, "-p", base, "-m", `Pi Autopilot integration ${intent.inputs.candidateId}`]
        : [
            "commit-tree",
            treeOid,
            "-p",
            base,
            "-p",
            parent,
            "-m",
            `Pi Autopilot integration ${intent.inputs.candidateId}`,
          ];
      const committed = await runGit(parentArguments, {
        cwd: privateClone,
        extraEnvironment: AUTHOR_ENV,
        maxOutputBytes: this.maxOutputBytes,
      });
      const integratedRevision = committed.kind === "exited" && committed.code === 0
        ? revisionText(committed.stdout)
        : null;
      if (integratedRevision === null) {
        return this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.integration-commit", "deterministic integration commit could not be created"),
        }));
      }
      parent = integratedRevision;
      const integratedRead = await this.readTreeFrom(privateClone, treeOid);
      if (integratedRead.kind !== "read") {
        return this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.integration-read", "integrated tree could not be normalized"),
        }));
      }
      const importCommit = await runGit([
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        "--",
        privateClone,
        parent,
      ], {
        cwd: this.repository,
        maxOutputBytes: this.maxOutputBytes,
      });
      if (importCommit.kind !== "exited" || importCommit.code !== 0) {
        return this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.integration-import", "integrated commit could not be imported into the publication repository"),
        }));
      }
      const integratedRoot = gitArtifactRootForTreeOid(treeOid, this.objectFormat);
      if (integratedRoot === null) {
        return this.observation(intent, "candidate-integrated", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.integration-root", "integrated tree cannot be represented by ArtifactRoot"),
        }));
      }
      const manifestBytes = canonicalBytes(Object.freeze({
        base,
        candidateId: intent.inputs.candidateId,
        format: "pi-autopilot.integrated-candidate.v1",
        revision: parent,
        tree: integratedRoot,
      }));
      return this.observation(intent, "candidate-integrated", Object.freeze({
        kind: "ok",
        value: Object.freeze({
          candidateId: intent.inputs.candidateId,
          manifest: artifactReference(hashBytes(manifestBytes), "git/integration-manifest.json"),
          revision: parent,
          tree: integratedRoot,
        }),
      }));
    }
  }

  public async publish(
    intent: Extract<GitIntent, { readonly kind: "publish-if-expected-head" }>,
  ): Promise<GitAdapterExecution> {
    const expected = await this.resolveRevision(intent.inputs.expectedHead);
    const desired = await this.resolveRevision(intent.inputs.desiredHead);
    if (expected === null || desired === null) {
      return this.observation(intent, "head-publication-observed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.publish-revision", "expected or desired publication revision is absent"),
      }));
    }
    const desiredTree = await this.resolveTree(desired);
    const candidateTree = await this.resolveTree(intent.preconditions.candidateTree);
    if (desiredTree === null || candidateTree !== desiredTree) {
      return this.observation(intent, "head-publication-observed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("git.publish-tree", "desired revision does not match the verified candidate tree"),
      }));
    }
    const observedBefore = await this.readPublicationHead();
    if (observedBefore === desired) {
      return this.publicationObservation(intent, "already-published", desired);
    }
    if (observedBefore !== expected) {
      return this.publicationObservation(intent, "head-moved", observedBefore ?? expected);
    }
    if (this.publicationObserver !== null) {
      try {
        await this.publicationObserver("before-update-ref");
      } catch {
        return this.observation(intent, "head-publication-observed", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic("git.publish-observer", "publication test observer interrupted the CAS window"),
        }));
      }
    }
    const updated = await runGit([
      "update-ref",
      this.publicationRef,
      desired,
      expected,
    ], {
      cwd: this.repository,
      maxOutputBytes: this.maxOutputBytes,
    });
    const observedAfter = await this.readPublicationHead();
    if (updated.kind === "exited" && updated.code === 0 && observedAfter === desired) {
      return this.publicationObservation(intent, "published", desired);
    }
    if (observedAfter === desired) {
      return this.publicationObservation(intent, "already-published", desired);
    }
    return this.publicationObservation(intent, "head-moved", observedAfter ?? expected);
  }

  private publicationObservation(
    intent: Extract<GitIntent, { readonly kind: "publish-if-expected-head" }>,
    status: "published" | "already-published" | "head-moved",
    observedHead: string,
  ): GitAdapterExecution {
    return this.observation(intent, "head-publication-observed", Object.freeze({
      kind: "ok",
      value: Object.freeze({
        desiredHead: intent.inputs.desiredHead,
        observedHead,
        publicationId: intent.inputs.publicationId,
        status,
      }),
    }));
  }

  private async readPublicationHead(): Promise<string | null> {
    const result = await runGit(["rev-parse", "--verify", this.publicationRef], {
      cwd: this.repository,
      maxOutputBytes: this.maxOutputBytes,
    });
    return result.kind === "exited" && result.code === 0 ? revisionText(result.stdout) : null;
  }

  private async resolveRevision(value: string): Promise<string | null> {
    return this.resolveRevisionIn(this.repository, value);
  }

  private async resolveRevisionIn(repository: string, value: string): Promise<string | null> {
    if (!GIT_OID.test(value)) {
      return null;
    }
    const result = await runGit(["rev-parse", "--verify", `${value}^{commit}`], {
      cwd: repository,
      maxOutputBytes: this.maxOutputBytes,
    });
    return result.kind === "exited" && result.code === 0 ? revisionText(result.stdout) : null;
  }

  private async resolveTree(value: string): Promise<string | null> {
    const treeish = GIT_OID.test(value) ? value : treeOidFromArtifactRoot(value, this.objectFormat);
    if (treeish === null) {
      return null;
    }
    const result = await runGit(["rev-parse", "--verify", `${treeish}^{tree}`], {
      cwd: this.repository,
      maxOutputBytes: this.maxOutputBytes,
    });
    return result.kind === "exited" && result.code === 0 ? revisionText(result.stdout) : null;
  }

  private async readTreeFrom(repository: string, tree: string): Promise<GitSealReadResult> {
    const listed = await runGit(["ls-tree", "-r", "-t", "-z", "--full-tree", tree], {
      cwd: repository,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (listed.kind !== "exited" || listed.code !== 0 || listed.stdoutTruncated) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.tree-read-failed", "workspace Git tree could not be enumerated"),
      });
    }
    const records = parseTreeList(listed.stdout);
    if (records === null) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("git.tree-invalid", "workspace Git tree listing is invalid"),
      });
    }
    const entries: GitTreeEntry[] = [];
    for (const record of records) {
      if (record.type === "tree") {
        entries.push(Object.freeze({ kind: "directory", mode: Number.parseInt(record.mode, 8), path: record.path }));
      } else if (record.type === "blob" && record.mode === "120000") {
        const blob = await runGit(["cat-file", "blob", record.object], {
          cwd: repository,
          maxOutputBytes: this.maxOutputBytes,
        });
        const target = blob.kind === "exited" && blob.code === 0 && !blob.stdoutTruncated
          ? decodeUtf8(blob.stdout)
          : null;
        if (target === null) {
          return Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("git.symlink-read-failed", "workspace symlink target could not be normalized"),
          });
        }
        entries.push(Object.freeze({ kind: "symlink", mode: 0o777, path: record.path, target }));
      } else if (record.type === "blob") {
        const blob = await runGit(["cat-file", "blob", record.object], {
          cwd: repository,
          maxOutputBytes: this.maxOutputBytes,
        });
        if (blob.kind !== "exited" || blob.code !== 0 || blob.stdoutTruncated) {
          return Object.freeze({
            kind: "retry",
            diagnostic: diagnostic("git.blob-read-failed", "workspace blob could not be read"),
          });
        }
        entries.push(Object.freeze({
          bytes: blob.stdout,
          kind: "file",
          mode: record.mode === "100755" ? 0o755 : 0o644,
          path: record.path,
        }));
      } else {
        return Object.freeze({
          kind: "retry",
          diagnostic: diagnostic("git.unsupported-entry", "workspace tree has an unsupported Git entry"),
        });
      }
    }
    const manifestBytes = canonicalBytes(Object.freeze({
      entries: Object.freeze(entries.map((entry) => entry.kind === "file"
        ? Object.freeze({ digest: hashBytes(entry.bytes), kind: entry.kind, mode: entry.mode, path: entry.path })
        : entry)),
      format: "pi-autopilot.git-tree-read.v1",
      tree,
    }));
    const root = gitArtifactRootForTreeOid(tree, this.objectFormat);
    return root === null
      ? Object.freeze({
          kind: "retry",
          diagnostic: diagnostic("git.tree-root-invalid", "workspace Git tree cannot be represented by ArtifactRoot"),
        })
      : Object.freeze({
          kind: "read",
          value: Object.freeze({ entries: Object.freeze(entries), manifestBytes, root }),
        });
  }

  private async readAcceptedOutputs(reference: {
    readonly path: string;
    readonly range: { readonly length: number; readonly offset: number } | null;
    readonly root: string;
  }): Promise<readonly string[] | null> {
    if (reference.path !== "git/accepted-outputs.txt" || reference.range !== null) {
      return null;
    }
    const path = join(this.integrationRoot, "accepted-outputs", reference.root.slice(7));
    try {
      const bytes = await readFile(path);
      const text = decodeUtf8(bytes);
      if (text === null || hashBytes(bytes) !== reference.root) {
        return null;
      }
      const revisions = text.split("\n").filter((entry) => entry.length > 0);
      return revisions.length > 0 && revisions.every((entry) => GIT_OID.test(entry))
        ? Object.freeze(revisions)
        : null;
    } catch {
      return null;
    }
  }

  private observation(
    intent: GitIntent,
    kind: GitObservation["kind"],
    result: unknown,
  ): GitAdapterExecution {
    try {
      const encoded = gitObservationCapsule.encodeUnknown(Object.freeze({
        actionId: intent.actionId,
        kind,
        result,
        runId: intent.runId,
      }));
      if (encoded.kind === "error") {
        return Object.freeze({
          kind: "rejected",
          diagnostic: diagnostic("git.invalid-observation", "git operation produced an invalid normalized observation"),
        });
      }
      const decoded = gitObservationCapsule.decodeCanonical(encoded.value);
      return decoded.kind === "ok"
        ? Object.freeze({ kind: "observation", observation: decoded.value })
        : Object.freeze({
            kind: "rejected",
            diagnostic: diagnostic("git.invalid-observation", "git operation produced a noncanonical observation"),
          });
    } catch {
      return Object.freeze({
        kind: "rejected",
        diagnostic: diagnostic("git.observation-failed", "git observation could not be normalized"),
      });
    }
  }
}

type GitIntentHandlerMap = {
  readonly [Kind in GitIntent["kind"]]: (
    adapter: GitAdapter,
    intent: Extract<GitIntent, { readonly kind: Kind }>,
  ) => Promise<GitAdapterExecution>;
};

/** Closed one-domain-operation handler map; no raw command surface is exported. */
export const gitIntentHandlers = Object.freeze({
  "compare-roots": (
    adapter: GitAdapter,
    intent: Extract<GitIntent, { readonly kind: "compare-roots" }>,
  ) => adapter.compare(intent),
  "integrate-candidate": (
    adapter: GitAdapter,
    intent: Extract<GitIntent, { readonly kind: "integrate-candidate" }>,
  ) => adapter.integrate(intent),
  "materialize-workspace": (
    adapter: GitAdapter,
    intent: Extract<GitIntent, { readonly kind: "materialize-workspace" }>,
  ) => adapter.materialize(intent),
  "publish-if-expected-head": (
    adapter: GitAdapter,
    intent: Extract<GitIntent, { readonly kind: "publish-if-expected-head" }>,
  ) => adapter.publish(intent),
  "seal-workspace": (
    adapter: GitAdapter,
    intent: Extract<GitIntent, { readonly kind: "seal-workspace" }>,
  ) => adapter.seal(intent),
}) satisfies GitIntentHandlerMap;
