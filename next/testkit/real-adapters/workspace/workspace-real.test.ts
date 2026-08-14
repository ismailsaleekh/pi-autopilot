import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactPathSchema, artifactRefSchema, kindIdSchema } from "../../../authority/protocol/identifiers.js";
import type { ArtifactRef } from "../../../authority/protocol/identifiers.js";
import { canonicalEncodeUnknown, defineCapsule, digestBytes } from "../../../authority/protocol/schema.js";
import type { JsonValue } from "../../../authority/protocol/schema.js";
import { workspaceIntentCapsule } from "../../../ports/contracts/workspace.capsule.js";
import type { LawDriver, LawFixture, LawFixtureResult, LawPortName, LawVectorResult } from "../../../ports/laws/contract-vector.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import { workspaceLawVector } from "../../../ports/laws/workspace.vectors.js";
import { WorkspaceAdapter } from "../../../adapters/workspace/index.js";
import type { WorkspaceIsolationEnforcer, WorkspaceIsolationEnforcementRequest } from "../../../adapters/workspace/index.js";
import { canonicalArtifactInstaller, openCas, readBlob, walkTree } from "../../../storage/cas/index.js";
import type { CanonicalArtifactInstaller, ContentAddressedStore } from "../../../storage/cas/index.js";
import { SimLawDriver } from "../../simulation/law-driver.js";

const workspaceReferenceCapsule = defineCapsule("RealWorkspaceLawReference", artifactRefSchema);
const workspacePathCapsule = defineCapsule("RealWorkspaceLawPath", artifactPathSchema);
const workspaceKindCapsule = defineCapsule("RealWorkspaceLawKind", kindIdSchema);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-workspace-real-"));
  const workspaces = join(root, "workspaces");
  const created = await WorkspaceAdapter.create({ workspaceRoot: workspaces });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("workspace adapter fixture failed");
  return Object.freeze({ root, workspaces, adapter: created.adapter });
}

function intent(kind: "allocate-attempt-directory" | "inspect-attempt-directory" | "dispose-attempt-directory", seed: number, workspaceId: string) {
  const template = workspaceIntentCapsule.arbitrary.validForKind(kind, seed);
  assert.equal(template.kind, kind);
  if (template.kind !== kind) return null;
  return bindLawIntent("workspace", Object.freeze({
    inputs: Object.freeze({ ...template.inputs, workspaceId }),
    kind,
    preconditions: template.preconditions,
    runId: template.runId,
  }));
}

test("workspace allocation is exclusive and concurrent IDs remain private", async () => {
  const value = await fixture();
  try {
    const ids = Array.from({ length: 16 }, (_, index) => `attempt-${String(index)}`);
    const observations = await Promise.all(ids.map((workspaceId, index) => value.adapter.execute(intent("allocate-attempt-directory", 100 + index, workspaceId))));
    for (const observation of observations) {
      assert.equal(observation.kind, "observation");
      if (observation.kind === "observation") assert.equal(observation.observation.result.kind, "ok");
    }
    const duplicate = await value.adapter.execute(intent("allocate-attempt-directory", 999, ids[0] ?? "attempt-0"));
    assert.equal(duplicate.kind, "observation");
    if (duplicate.kind === "observation") assert.equal(duplicate.observation.result.kind, "retry");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("filesystem workspace adapter never fabricates an OS isolation attestation", async () => {
  const value = await fixture();
  try {
    const allocate = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 180);
    const isolation = workspaceIntentCapsule.arbitrary.validForKind("apply-attempt-isolation", 181);
    assert.equal(allocate.kind, "allocate-attempt-directory");
    assert.equal(isolation.kind, "apply-attempt-isolation");
    if (allocate.kind !== "allocate-attempt-directory" || isolation.kind !== "apply-attempt-isolation") return;
    const allocatedIntent = bindLawIntent("workspace", Object.freeze({ inputs: allocate.inputs, kind: allocate.kind, preconditions: allocate.preconditions, runId: allocate.runId }));
    const allocated = await value.adapter.execute(allocatedIntent);
    assert.equal(allocated.kind, "observation");
    const bound = bindLawIntent("workspace", Object.freeze({
      inputs: Object.freeze({ ...isolation.inputs, workspaceCapability: allocate.inputs.workspaceCapability, workspaceId: allocate.inputs.workspaceId }),
      kind: isolation.kind,
      preconditions: Object.freeze({
        ...isolation.preconditions,
        expectedPolicyDigest: isolation.inputs.isolationPolicy.digest,
        expectedWorkspaceRoot: isolation.inputs.isolationPolicy.root,
        leaseId: allocate.preconditions.leaseId,
      }),
      runId: isolation.runId,
    }));
    const result = await value.adapter.execute(bound);
    assert.equal(result.kind, "observation");
    if (result.kind === "observation") {
      assert.equal(result.observation.kind, "attempt-isolation-applied");
      assert.equal(result.observation.result.kind, "retry");
      if (result.observation.result.kind === "retry") assert.equal(result.observation.result.diagnostic.code, "workspace.isolation-enforcement-unavailable");
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace disposal rejects a symlink escape and preserves its target", async () => {
  const value = await fixture();
  const outside = join(value.root, "outside");
  try {
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve\n");
    await symlink(outside, join(value.workspaces, "escape"));
    const result = await value.adapter.execute(intent("dispose-attempt-directory", 201, "escape"));
    assert.equal(result.kind, "observation");
    if (result.kind === "observation") assert.equal(result.observation.result.kind, "retry");
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve\n");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace enumeration reads files and symlinks without following them", async () => {
  const value = await fixture();
  try {
    const allocated = await value.adapter.execute(intent("allocate-attempt-directory", 301, "readable"));
    assert.equal(allocated.kind, "observation");
    await writeFile(join(value.workspaces, "readable", "binary.bin"), Uint8Array.from([0, 255, 9]));
    await symlink("binary.bin", join(value.workspaces, "readable", "link"));
    const read = await value.adapter.readWorkspace("readable");
    assert.equal(read.kind, "read");
    if (read.kind === "read") assert.deepEqual(read.entries.map((entry) => [entry.kind, entry.path]), [["file", "binary.bin"], ["symlink", "link"]]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

async function readTreeReference(store: ContentAddressedStore, reference: ArtifactRef): Promise<Uint8Array | null> {
  const length = Number(reference.byteLength);
  if (!Number.isSafeInteger(length) || length < 0 || reference.range !== null) return null;
  let cursor: string | null = null;
  while (true) {
    const page = await walkTree(store, reference.root, cursor, 256);
    if (page.kind !== "page") return null;
    const entry = page.value.entries.find((candidate) => candidate.kind === "file" && candidate.path === reference.path);
    if (entry !== undefined && entry.kind === "file") {
      if (String(entry.blob.digest) !== String(reference.blob) || BigInt(entry.blob.byteLength).toString(10) !== String(reference.byteLength)) return null;
      const opened = await readBlob(store, entry.blob, Object.freeze({ offset: 0, length }));
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

function realIsolationEnforcer(store: ContentAddressedStore, installer: CanonicalArtifactInstaller): WorkspaceIsolationEnforcer {
  let sequence = 0;
  return Object.freeze({
    async enforce(request: WorkspaceIsolationEnforcementRequest) {
      sequence += 1;
      const policyBytes = await readTreeReference(store, request.isolationPolicy);
      if (policyBytes === null || String(digestBytes(policyBytes)) !== String(request.isolationPolicy.digest)) {
        return Object.freeze({ kind: "retry", diagnostic: Object.freeze({ code: "workspace.policy-unproven", message: "isolation policy was not installed beneath its declared tree" }) });
      }
      await chmod(request.workspacePath, 0o700);
      const status = await lstat(request.workspacePath);
      if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700) {
        return Object.freeze({ kind: "retry", diagnostic: Object.freeze({ code: "workspace.private-directory-unproven", message: "private directory enforcement could not be observed" }) });
      }
      const path = workspacePathCapsule.decode(`law/workspace-isolation-${String(sequence)}.json`);
      const codec = workspaceKindCapsule.decode("codec:workspace-isolation-attestation");
      const version = workspaceKindCapsule.decode("version:2");
      if (path.kind !== "ok" || codec.kind !== "ok" || version.kind !== "ok") {
        return Object.freeze({ kind: "retry", diagnostic: Object.freeze({ code: "workspace.attestation-coordinates", message: "isolation attestation coordinates were invalid" }) });
      }
      const installed = await installer.install(Object.freeze({
        bytes: canonicalEncodeUnknown(Object.freeze({
          childEpoch: request.childEpoch,
          enforcement: "private-directory-v1",
          mode: "0700",
          policyDigest: request.isolationPolicy.digest,
          policyRoot: request.workspaceRoot,
          workspaceCapability: request.workspaceCapability,
          workspaceId: request.workspaceId,
        })),
        codec: codec.value,
        codecVersion: version.value,
        path: path.value,
      }));
      return installed.kind === "installed"
        ? Object.freeze({ kind: "enforced", attestation: installed.reference })
        : Object.freeze({ kind: "retry", diagnostic: Object.freeze({ code: "workspace.attestation-install", message: "isolation attestation could not be installed" }) });
    },
  });
}

class RealWorkspaceLawDriver implements LawDriver {
  private readonly trees = new Map<string, string>();
  private sequence = 0;
  public constructor(private readonly adapter: WorkspaceAdapter, private readonly installer: CanonicalArtifactInstaller) {}
  public async fixture(request: LawFixture): Promise<LawFixtureResult> {
    this.sequence += 1;
    if (request.kind === "tree") {
      const first = request.files[0];
      if (first === undefined) return Object.freeze({ kind: "invalid", diagnostic: "workspace law tree requires a file" });
      const tree = await this.installer.installTree(Object.freeze(request.files.map((file) => Object.freeze({ bytes: file.bytes, kind: "file", mode: 0o600, path: file.path }))));
      const path = workspacePathCapsule.decode(`law/workspace-manifest-${String(this.sequence)}.json`);
      const codec = workspaceKindCapsule.decode("codec:workspace-law-manifest");
      const version = workspaceKindCapsule.decode("version:2");
      if (tree.kind !== "installed" || path.kind !== "ok" || codec.kind !== "ok" || version.kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: "workspace law tree coordinates were invalid" });
      const manifest = await this.installer.install(Object.freeze({ bytes: canonicalEncodeUnknown(Object.freeze({ files: request.files.map((file) => file.path), root: tree.root })), codec: codec.value, codecVersion: version.value, path: path.value }));
      const digest = digestBytes(first.bytes);
      const firstFile = workspaceReferenceCapsule.decode(Object.freeze({ blob: digest, byteLength: String(first.bytes.byteLength), codec: "codec:workspace-policy", codecVersion: "version:2", digest, path: first.path, range: null, root: tree.root }));
      if (manifest.kind !== "installed" || firstFile.kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: "workspace law evidence installation failed" });
      this.trees.set(request.name, tree.root);
      return Object.freeze({ kind: "tree", name: request.name, root: tree.root, manifest: manifest.reference, firstFile: firstFile.value });
    }
    if (request.kind === "workspace") {
      const root = this.trees.get(request.treeName);
      const allocate = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 900 + this.sequence);
      if (root === undefined || allocate.kind !== "allocate-attempt-directory") return Object.freeze({ kind: "invalid", diagnostic: "workspace law reservation fixture failed" });
      const bound = bindLawIntent("workspace", Object.freeze({ inputs: allocate.inputs, kind: allocate.kind, preconditions: allocate.preconditions, runId: allocate.runId }));
      const result = await this.adapter.execute(bound);
      if (result.kind !== "observation" || result.observation.kind !== "attempt-directory-allocated" || result.observation.result.kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: "workspace law reservation was not allocated" });
      return Object.freeze({ kind: "workspace", name: request.name, workspaceId: allocate.inputs.workspaceId, workspaceCapability: allocate.inputs.workspaceCapability, root, leaseId: allocate.preconditions.leaseId });
    }
    return Object.freeze({ kind: "invalid", diagnostic: `workspace law driver does not implement ${request.kind}` });
  }
  public async dispatch(port: LawPortName, value: JsonValue): Promise<unknown> { return port === "workspace" ? this.adapter.execute(value) : Object.freeze({ kind: "rejected" }); }
  public async advance(_ticks: string): Promise<void> { return; }
  public async readArtifact(value: JsonValue): Promise<Uint8Array | null> {
    const reference = workspaceReferenceCapsule.decode(value);
    if (reference.kind !== "ok") return null;
    const length = Number(reference.value.byteLength);
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const read = await this.installer.read(reference.value, length);
    return read.kind === "read" ? read.bytes : null;
  }
  public async containsSecretBytes(_bytes: Uint8Array): Promise<boolean> { return false; }
}

function workspaceBehavior(result: LawVectorResult) {
  return result.trace.map((entry) => Object.freeze({ operation: entry.operation, observationKind: entry.observationKind, result: entry.result, diagnosticCode: entry.diagnosticCode, evidenceVerified: entry.artifactEvidence.every((evidence) => evidence.verified) }));
}

test("real workspace adapter matches the central lease/isolation/fencing law", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-workspace-law-"));
  try {
    const opened = await openCas(join(root, "cas"));
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    const installer = canonicalArtifactInstaller(opened.store);
    const created = await WorkspaceAdapter.create({ workspaceRoot: join(root, "workspaces"), isolationEnforcer: realIsolationEnforcer(opened.store, installer) });
    assert.equal(created.kind, "created");
    if (created.kind !== "created") return;
    const real = await workspaceLawVector.replay(new RealWorkspaceLawDriver(created.adapter, installer));
    const simulated = await workspaceLawVector.replay(new SimLawDriver(11));
    assert.deepEqual(real.findings, [], real.findings.join("; "));
    assert.deepEqual(simulated.findings, []);
    assert.deepEqual(workspaceBehavior(real), workspaceBehavior(simulated));
    assert.equal(real.trace.flatMap((entry) => entry.artifactEvidence).every((evidence) => evidence.verified), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
