import {
  artifactRefSchema,
  artifactRootSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ArtifactPath,
  ArtifactRef,
  ArtifactRoot,
} from "../../authority/protocol/identifiers.js";
import {
  canonicalEncodeUnknown,
  defineCapsule,
} from "../../authority/protocol/schema.js";
import { artifactPath, artifactRootFor, bytesEqual, bytesHex, cloneBytes, digestForBytes } from "./values.js";

export interface SimArtifactFile {
  readonly path: ArtifactPath;
  readonly bytes: Uint8Array;
}

export interface SimArtifactTree {
  readonly root: ArtifactRoot;
  readonly files: readonly SimArtifactFile[];
}

export interface ArtifactCatalogImage {
  readonly trees: readonly SimArtifactTree[];
}

export type CreateTreeResult =
  | { readonly kind: "ok"; readonly tree: SimArtifactTree }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export type ReadArtifactResult =
  | { readonly kind: "ok"; readonly bytes: Uint8Array; readonly root: ArtifactRoot; readonly path: ArtifactPath }
  | { readonly kind: "missing"; readonly diagnostic: string }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const artifactRefCapsule = defineCapsule("SimulationArtifactRef", artifactRefSchema);
const artifactRootCapsule = defineCapsule("SimulationArtifactRootLookup", artifactRootSchema);

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function cloneFile(file: SimArtifactFile): SimArtifactFile {
  return Object.freeze({ path: file.path, bytes: file.bytes.slice() });
}

function sameFiles(left: readonly SimArtifactFile[], right: readonly SimArtifactFile[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftFile = left[index];
    const rightFile = right[index];
    if (
      leftFile === undefined
      || rightFile === undefined
      || leftFile.path !== rightFile.path
      || !bytesEqual(leftFile.bytes, rightFile.bytes)
    ) {
      return false;
    }
  }
  return true;
}

function decodedFile(input: unknown): SimArtifactFile | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const path = artifactPath(Reflect.get(input, "path"));
    const bytes = cloneBytes(Reflect.get(input, "bytes"));
    return path === null || bytes === null ? null : Object.freeze({ path, bytes });
  } catch {
    return null;
  }
}

function decodedFiles(input: unknown): readonly SimArtifactFile[] | null {
  try {
    if (!Array.isArray(input)) {
      return null;
    }
    const byPath = new Map<string, SimArtifactFile>();
    for (const candidate of input) {
      const file = decodedFile(candidate);
      if (file === null || byPath.has(file.path)) {
        return null;
      }
      byPath.set(file.path, file);
    }
    return Object.freeze([...byPath.values()]
      .sort((left, right) => compareText(left.path, right.path))
      .map(cloneFile));
  } catch {
    return null;
  }
}

function treeRoot(files: readonly SimArtifactFile[]): ArtifactRoot {
  return artifactRootFor(Object.freeze({
    format: "pi-autopilot.sim-tree.v1",
    files: Object.freeze(files.map((file) => Object.freeze({
      digest: digestForBytes(file.bytes),
      length: file.bytes.length,
      path: file.path,
    }))),
  }));
}

/** Immutable, byte-preserving roots used by workspaces, git, and the fake CAS. */
export class ArtifactCatalog {
  private readonly trees = new Map<ArtifactRoot, readonly SimArtifactFile[]>();

  public constructor(image?: unknown) {
    const decoded = decodeCatalogImage(image);
    for (const tree of decoded.trees) {
      this.trees.set(tree.root, Object.freeze(tree.files.map(cloneFile)));
    }
  }

  public createTree(input: unknown): CreateTreeResult {
    const files = decodedFiles(input);
    if (files === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "tree files must be unique normalized paths with Uint8Array bytes" });
    }
    const root = treeRoot(files);
    const prior = this.trees.get(root);
    if (prior !== undefined && !sameFiles(prior, files)) {
      return Object.freeze({ kind: "invalid", diagnostic: "tree digest collision with different bytes" });
    }
    this.trees.set(root, files);
    return Object.freeze({
      kind: "ok",
      tree: Object.freeze({ root, files: Object.freeze(files.map(cloneFile)) }),
    });
  }

  public createBlob(pathInput: unknown, bytesInput: unknown): CreateTreeResult {
    const path = artifactPath(typeof pathInput === "string" ? pathInput : "");
    const bytes = cloneBytes(bytesInput);
    return path === null || bytes === null
      ? Object.freeze({ kind: "invalid", diagnostic: "blob requires a normalized artifact path and Uint8Array bytes" })
      : this.createTree(Object.freeze([Object.freeze({ path, bytes })]));
  }

  public has(rootInput: unknown): boolean {
    const root = this.decodeRoot(rootInput);
    return root !== null && this.trees.has(root);
  }

  public get(rootInput: unknown): SimArtifactTree | null {
    const root = this.decodeRoot(rootInput);
    const files = root === null ? undefined : this.trees.get(root);
    return root === null || files === undefined
      ? null
      : Object.freeze({ root, files: Object.freeze(files.map(cloneFile)) });
  }

  public read(refInput: unknown): ReadArtifactResult {
    const ref = this.decodeReference(refInput);
    if (ref === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "artifact reference could not be decoded" });
    }
    const files = this.trees.get(ref.root);
    const file = files?.find((candidate) => candidate.path === ref.path);
    if (file === undefined) {
      return Object.freeze({ kind: "missing", diagnostic: "artifact root or path is absent" });
    }
    const offset = ref.range?.offset ?? 0;
    const length = ref.range?.length ?? file.bytes.length;
    if (offset > file.bytes.length || length > file.bytes.length - offset) {
      return Object.freeze({ kind: "invalid", diagnostic: "artifact byte range exceeds the file" });
    }
    return Object.freeze({
      kind: "ok",
      bytes: file.bytes.slice(offset, offset + length),
      root: ref.root,
      path: ref.path,
    });
  }

  public reference(rootInput: unknown, pathInput: unknown): ArtifactRef | null {
    const root = this.decodeRoot(rootInput);
    const path = artifactPath(typeof pathInput === "string" ? pathInput : "");
    if (root === null || path === null || !this.trees.get(root)?.some((file) => file.path === path)) {
      return null;
    }
    return Object.freeze({ root, path, range: null });
  }

  public serialize(rootInput: unknown): Uint8Array | null {
    const tree = this.get(rootInput);
    if (tree === null) {
      return null;
    }
    return canonicalEncodeUnknown(Object.freeze({
      format: "pi-autopilot.sim-object.v1",
      root: tree.root,
      files: Object.freeze(tree.files.map((file) => Object.freeze({
        bytes: bytesHex(file.bytes),
        path: file.path,
      }))),
    }));
  }

  public image(): ArtifactCatalogImage {
    const trees = [...this.trees.entries()]
      .sort((left, right) => compareText(left[0], right[0]))
      .map(([root, files]) => Object.freeze({
        root,
        files: Object.freeze(files.map(cloneFile)),
      }));
    return Object.freeze({ trees: Object.freeze(trees) });
  }

  private decodeRoot(input: unknown): ArtifactRoot | null {
    try {
      const encoded = artifactRootCapsule.encodeUnknown(input);
      if (encoded.kind === "error") {
        return null;
      }
      const result = artifactRootCapsule.decodeCanonical(encoded.value);
      return result.kind === "ok" ? result.value : null;
    } catch {
      return null;
    }
  }

  private decodeReference(input: unknown): ArtifactRef | null {
    try {
      const encoded = artifactRefCapsule.encodeUnknown(input);
      if (encoded.kind === "error") {
        return null;
      }
      const result = artifactRefCapsule.decodeCanonical(encoded.value);
      return result.kind === "ok" ? result.value : null;
    } catch {
      return null;
    }
  }
}

function decodeCatalogImage(input: unknown): ArtifactCatalogImage {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return Object.freeze({ trees: Object.freeze([]) });
    }
    const candidates = Reflect.get(input, "trees");
    if (!Array.isArray(candidates)) {
      return Object.freeze({ trees: Object.freeze([]) });
    }
    const trees: SimArtifactTree[] = [];
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return Object.freeze({ trees: Object.freeze([]) });
      }
      const encodedRoot = artifactRootCapsule.encodeUnknown(Reflect.get(candidate, "root"));
      const files = decodedFiles(Reflect.get(candidate, "files"));
      if (encodedRoot.kind === "error" || files === null) {
        return Object.freeze({ trees: Object.freeze([]) });
      }
      const rootResult = artifactRootCapsule.decodeCanonical(encodedRoot.value);
      if (rootResult.kind === "error" || treeRoot(files) !== rootResult.value) {
        return Object.freeze({ trees: Object.freeze([]) });
      }
      trees.push(Object.freeze({ root: rootResult.value, files }));
    }
    return Object.freeze({ trees: Object.freeze(trees) });
  } catch {
    return Object.freeze({ trees: Object.freeze([]) });
  }
}
