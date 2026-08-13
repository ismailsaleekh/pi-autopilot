import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workspaceIntentCapsule } from "../../../ports/contracts/workspace.capsule.js";
import { workspaceLawVector } from "../../../ports/laws/workspace.vectors.js";
import type {
  LawDriver,
  LawFixture,
  LawFixtureResult,
  LawPortName,
} from "../../../ports/laws/contract-vector.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import type { JsonValue } from "../../../authority/protocol/schema.js";
import { SimLawDriver } from "../../simulation/law-driver.js";
import { WorkspaceAdapter } from "../../../adapters/workspace/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-workspace-real-"));
  const workspaces = join(root, "workspaces");
  const created = await WorkspaceAdapter.create({ workspaceRoot: workspaces });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") {
    throw new Error("workspace adapter fixture failed");
  }
  return Object.freeze({ root, workspaces, adapter: created.adapter });
}

function intent(kind: "allocate-attempt-directory" | "inspect-attempt-directory" | "dispose-attempt-directory", seed: number, workspaceId: string) {
  const template = workspaceIntentCapsule.arbitrary.validForKind(kind, seed);
  assert.equal(template.kind, kind);
  if (template.kind === "allocate-attempt-directory") {
    return bindLawIntent("workspace", Object.freeze({
      inputs: Object.freeze({ baseRoot: template.inputs.baseRoot, workspaceId }),
      kind,
      preconditions: template.preconditions,
      runId: template.runId,
    }));
  }
  if (template.kind === "inspect-attempt-directory") {
    return bindLawIntent("workspace", Object.freeze({
      inputs: Object.freeze({ workspaceId }),
      kind,
      preconditions: template.preconditions,
      runId: template.runId,
    }));
  }
  assert.equal(template.kind, "dispose-attempt-directory");
  return bindLawIntent("workspace", Object.freeze({
    inputs: Object.freeze({ workspaceId }),
    kind,
    preconditions: template.preconditions,
    runId: template.runId,
  }));
}

test("workspace adapter replays the frozen workspace law vector with fake-equivalent trace", async () => {
  const value = await fixture();
  try {
    const driver: LawDriver = Object.freeze({
      fixture: async (request: LawFixture): Promise<LawFixtureResult> => {
        if (request.kind !== "tree") {
          return Object.freeze({ kind: "invalid", diagnostic: "unsupported fixture" });
        }
        const root = `sha256:${"1".repeat(64)}`;
        return Object.freeze({
          kind: "tree",
          name: request.name,
          root,
          manifest: Object.freeze({ path: "law/manifest", range: null, root }),
          firstFile: Object.freeze({ path: request.files[0]?.path ?? "law/missing", range: null, root }),
        });
      },
      dispatch: async (port: LawPortName, bound: JsonValue) =>
        port === "workspace" ? value.adapter.execute(bound) : Object.freeze({ kind: "rejected" }),
      advance: async (_ticks: number) => undefined,
      readArtifact: async (_reference: JsonValue) => null,
      containsSecretBytes: async (_bytes: Uint8Array) => false,
    });
    const result = await workspaceLawVector.replay(driver);
    const simulated = await workspaceLawVector.replay(new SimLawDriver(1));
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.trace, simulated.trace);
    assert.equal(result.trace.every((entry) => entry.result === "ok"), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace allocation is exclusive and concurrent IDs remain private", async () => {
  const value = await fixture();
  try {
    const ids = Array.from({ length: 16 }, (_, index) => `attempt-${String(index)}`);
    const observations = await Promise.all(ids.map((workspaceId, index) => {
      const bound = intent("allocate-attempt-directory", 100 + index, workspaceId);
      assert.notEqual(bound, null);
      return value.adapter.execute(bound);
    }));
    for (const observation of observations) {
      assert.equal(observation.kind, "observation");
      if (observation.kind === "observation") {
        assert.equal(observation.observation.result.kind, "ok");
      }
    }
    const duplicate = intent("allocate-attempt-directory", 999, ids[0] ?? "attempt-0");
    const rejected = await value.adapter.execute(duplicate);
    assert.equal(rejected.kind, "observation");
    if (rejected.kind === "observation") {
      assert.equal(rejected.observation.result.kind, "retry");
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
    const dispose = intent("dispose-attempt-directory", 201, "escape");
    const result = await value.adapter.execute(dispose);
    assert.equal(result.kind, "observation");
    if (result.kind === "observation") {
      assert.equal(result.observation.result.kind, "retry");
    }
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve\n");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace enumeration reads files and symlinks without following them", async () => {
  const value = await fixture();
  try {
    const allocate = intent("allocate-attempt-directory", 301, "readable");
    const allocated = await value.adapter.execute(allocate);
    assert.equal(allocated.kind, "observation");
    await writeFile(join(value.workspaces, "readable", "binary.bin"), Uint8Array.from([0, 255, 9]));
    await symlink("binary.bin", join(value.workspaces, "readable", "link"));
    const read = await value.adapter.readWorkspace("readable");
    assert.equal(read.kind, "read");
    if (read.kind === "read") {
      assert.deepEqual(read.entries.map((entry) => [entry.kind, entry.path]), [
        ["file", "binary.bin"],
        ["symlink", "link"],
      ]);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
