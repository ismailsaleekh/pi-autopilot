import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workspaceIntentCapsule } from "../../../ports/contracts/workspace.capsule.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import { WorkspaceAdapter } from "../../../adapters/workspace/index.js";

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
