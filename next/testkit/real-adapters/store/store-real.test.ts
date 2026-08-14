import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactPathSchema, artifactRefSchema, kindIdSchema } from "../../../authority/protocol/identifiers.js";
import type { ArtifactRef } from "../../../authority/protocol/identifiers.js";
import { canonicalEncodeUnknown, defineCapsule, digestBytes } from "../../../authority/protocol/schema.js";
import type { JsonValue } from "../../../authority/protocol/schema.js";
import { StoreAdapter } from "../../../adapters/store/index.js";
import type { StoreAdapterBackend } from "../../../adapters/store/index.js";
import type { LawDriver, LawFixture, LawFixtureResult, LawPortName, LawVectorResult } from "../../../ports/laws/contract-vector.js";
import { storeLawVector } from "../../../ports/laws/store.vectors.js";
import { canonicalArtifactInstaller, openCas, readBlob, walkTree } from "../../../storage/cas/index.js";
import type { CanonicalArtifactInstaller, ContentAddressedStore, TreeEntry } from "../../../storage/cas/index.js";
import { SimLawDriver } from "../../simulation/law-driver.js";

const referenceCapsule = defineCapsule("RealStoreFixtureReference", artifactRefSchema);
const pathCapsule = defineCapsule("RealStoreFixturePath", artifactPathSchema);
const kindCapsule = defineCapsule("RealStoreFixtureKind", kindIdSchema);

function jsonTreeEntry(entry: TreeEntry): JsonValue {
  switch (entry.kind) {
    case "directory": return Object.freeze({ kind: entry.kind, mode: entry.mode, path: entry.path });
    case "file": return Object.freeze({
      blob: Object.freeze({ byteLength: entry.blob.byteLength, digest: String(entry.blob.digest) }),
      kind: entry.kind,
      mode: entry.mode,
      path: entry.path,
    });
    case "symlink": return Object.freeze({ kind: entry.kind, mode: entry.mode, path: entry.path, target: entry.target });
  }
}

async function readReference(store: ContentAddressedStore, installer: CanonicalArtifactInstaller, reference: ArtifactRef, maxBytes: number): Promise<Uint8Array | null> {
  const fullLength = Number(reference.byteLength);
  const offset = reference.range === null ? 0 : Number(reference.range.offset);
  const length = reference.range === null ? fullLength : Number(reference.range.length);
  if (!Number.isSafeInteger(fullLength) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || fullLength < 0 || offset < 0 || length < 0 || length > maxBytes) return null;
  if (String(reference.root) === String(reference.blob)) {
    const read = await installer.read(reference, maxBytes);
    return read.kind === "read" ? read.bytes : null;
  }
  let cursor: string | null = null;
  while (true) {
    const page = await walkTree(store, reference.root, cursor, 256);
    if (page.kind !== "page") return null;
    const entry = page.value.entries.find((candidate) => candidate.kind === "file" && candidate.path === reference.path);
    if (entry !== undefined && entry.kind === "file") {
      if (String(entry.blob.digest) !== String(reference.blob) || BigInt(entry.blob.byteLength).toString(10) !== String(reference.byteLength)) return null;
      const opened = await readBlob(store, entry.blob, Object.freeze({ offset, length }));
      if (opened.kind !== "ready") return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of opened.bytes) {
        total += chunk.byteLength;
        if (total > length) {
          await opened.bytes.close();
          return null;
        }
        chunks.push(chunk);
      }
      const completion = await opened.bytes.completion;
      return completion.kind === "complete" && total === length ? Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)) : null;
    }
    cursor = page.value.nextCursor;
    if (cursor === null) return null;
  }
}

function backend(store: ContentAddressedStore, installer: CanonicalArtifactInstaller): StoreAdapterBackend {
  return Object.freeze({
    async install(request: Parameters<StoreAdapterBackend["install"]>[0]) {
      const installed = await installer.install(request);
      return installed.kind === "installed" ? installed : Object.freeze({ kind: "error", code: installed.error.code, message: installed.error.message });
    },
    async list(root: Parameters<StoreAdapterBackend["list"]>[0], cursor: string | null, pageSize: number) {
      const page = await walkTree(store, root, cursor, pageSize);
      return page.kind === "page"
        ? Object.freeze({ kind: "page", entries: Object.freeze(page.value.entries.map(jsonTreeEntry)), nextCursor: page.value.nextCursor })
        : Object.freeze({ kind: "error", code: page.error.code, message: page.error.message });
    },
    async read(reference: ArtifactRef, maxBytes: number) {
      const bytes = await readReference(store, installer, reference, maxBytes);
      return bytes === null ? Object.freeze({ kind: "error", code: "store.read", message: "reference was unavailable" }) : Object.freeze({ kind: "read", bytes });
    },
  });
}

class RealStoreLawDriver implements LawDriver {
  private sequence = 0;
  public constructor(private readonly adapter: StoreAdapter, private readonly backend: StoreAdapterBackend, private readonly installer: CanonicalArtifactInstaller) {}
  public async fixture(request: LawFixture): Promise<LawFixtureResult> {
    this.sequence += 1;
    if (request.kind !== "tree" || request.files.length === 0) return Object.freeze({ kind: "invalid", diagnostic: "real store driver supports nonempty tree fixtures" });
    const installedTree = await this.installer.installTree(Object.freeze(request.files.map((file) => Object.freeze({ bytes: file.bytes, kind: "file", mode: 0o644, path: file.path }))));
    const manifestPath = pathCapsule.decode(`law/store-manifest-${String(this.sequence)}.json`);
    const manifestCodec = kindCapsule.decode("codec:real-store-manifest");
    const manifestVersion = kindCapsule.decode("version:2");
    const first = request.files[0];
    if (installedTree.kind !== "installed" || manifestPath.kind !== "ok" || manifestCodec.kind !== "ok" || manifestVersion.kind !== "ok" || first === undefined) return Object.freeze({ kind: "invalid", diagnostic: "real store tree installation coordinates were invalid" });
    const manifest = await this.installer.install(Object.freeze({ bytes: canonicalEncodeUnknown(Object.freeze({ files: request.files.map((file) => file.path) })), codec: manifestCodec.value, codecVersion: manifestVersion.value, path: manifestPath.value }));
    if (manifest.kind !== "installed") return Object.freeze({ kind: "invalid", diagnostic: "real store manifest installation failed" });
    const digest = digestBytes(first.bytes);
    const decoded = referenceCapsule.decode(Object.freeze({
      blob: digest,
      byteLength: String(first.bytes.byteLength),
      codec: "codec:real-store-file",
      codecVersion: "version:2",
      digest,
      path: first.path,
      range: null,
      root: installedTree.root,
    }));
    if (decoded.kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: decoded.error.diagnostic });
    return Object.freeze({ kind: "tree", name: request.name, root: installedTree.root, manifest: manifest.reference, firstFile: decoded.value });
  }
  public async dispatch(port: LawPortName, intent: JsonValue): Promise<unknown> { return port === "store" ? this.adapter.execute(intent) : Object.freeze({ kind: "rejected" }); }
  public async advance(_ticks: string): Promise<void> { return; }
  public async readArtifact(reference: JsonValue): Promise<Uint8Array | null> {
    const decoded = referenceCapsule.decode(reference);
    if (decoded.kind !== "ok") return null;
    const read = await this.backend.read(decoded.value, 16 * 1024 * 1024);
    return read.kind === "read" ? read.bytes : null;
  }
  public async containsSecretBytes(_bytes: Uint8Array): Promise<boolean> { return false; }
}

function behavior(result: LawVectorResult) {
  return result.trace.map((entry) => Object.freeze({ operation: entry.operation, observationKind: entry.observationKind, result: entry.result, diagnosticCode: entry.diagnosticCode, evidenceVerified: entry.artifactEvidence.every((evidence) => evidence.verified) }));
}

test("real CAS-backed store adapter matches the central paging/range/idempotency law", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-store-real-"));
  try {
    const opened = await openCas(join(root, "cas"));
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    const installer = canonicalArtifactInstaller(opened.store);
    const physical = backend(opened.store, installer);
    const created = StoreAdapter.create({ backend: physical, maxReadBytes: 16 * 1024 * 1024, maxPageSize: 256 });
    assert.equal(created.kind, "created");
    if (created.kind !== "created") return;
    const real = await storeLawVector.replay(new RealStoreLawDriver(created.adapter, physical, installer));
    const simulated = await storeLawVector.replay(new SimLawDriver(21));
    assert.deepEqual(real.findings, [], real.findings.join("; "));
    assert.deepEqual(simulated.findings, []);
    assert.deepEqual(behavior(real), behavior(simulated));
    assert.equal(real.trace.flatMap((entry) => entry.artifactEvidence).every((evidence) => evidence.verified), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
