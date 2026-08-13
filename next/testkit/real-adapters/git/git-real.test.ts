import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitAdapter, gitArtifactRootForTreeOid } from "../../../adapters/git/index.js";
import { SimLawDriver } from "../../simulation/law-driver.js";
import { WorkspaceAdapter } from "../../../adapters/workspace/index.js";
import { gitIntentCapsule } from "../../../ports/contracts/git.capsule.js";
import { gitLawVector } from "../../../ports/laws/git.vectors.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import { RealLawDriver } from "../real-law-driver.js";

interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
}

function git(cwd: string, arguments_: readonly string[], environment?: Readonly<Record<string, string>>): Promise<GitResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn("git", arguments_, {
      cwd,
      env: Object.assign({}, process.env, environment ?? {}),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult(Object.freeze({
      code,
      stdout: Buffer.concat(chunks).toString("utf8").trim(),
    })));
  });
}

async function checkedGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await git(cwd, arguments_);
  assert.equal(result.code, 0, `git ${arguments_.join(" ")} failed`);
  return result.stdout;
}

async function commit(repository: string, message: string): Promise<string> {
  await checkedGit(repository, ["add", "-A"]);
  await checkedGit(repository, ["commit", "-m", message]);
  return checkedGit(repository, ["rev-parse", "HEAD"]);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-git-real-"));
  const repository = join(root, "repository");
  const workspaces = join(root, "workspaces");
  const integrationRoot = join(root, "integration");
  await mkdir(repository);
  await checkedGit(repository, ["init", "-b", "main"]);
  await checkedGit(repository, ["config", "user.name", "Adapter Test"]);
  await checkedGit(repository, ["config", "user.email", "adapter@test.invalid"]);
  await writeFile(join(repository, "base.txt"), "base\n");
  const base = await commit(repository, "base");
  const treeOid = await checkedGit(repository, ["rev-parse", "HEAD^{tree}"]);
  const tree = gitArtifactRootForTreeOid(treeOid);
  assert.notEqual(tree, null);
  if (tree === null) {
    throw new Error("tree root fixture failed");
  }
  await checkedGit(repository, ["update-ref", "refs/autopilot/test", base]);
  const workspaceCreated = await WorkspaceAdapter.create({ workspaceRoot: workspaces });
  assert.equal(workspaceCreated.kind, "created");
  if (workspaceCreated.kind !== "created") {
    throw new Error("workspace adapter fixture failed");
  }
  await mkdir(integrationRoot);
  const gitCreated = await GitAdapter.create({
    integrationRoot,
    publicationRef: "refs/autopilot/test",
    repository,
    workspace: workspaceCreated.adapter,
  });
  assert.equal(gitCreated.kind, "created");
  if (gitCreated.kind !== "created") {
    throw new Error("git adapter fixture failed");
  }
  return Object.freeze({
    adapter: gitCreated.adapter,
    base,
    integrationRoot,
    repository,
    root,
    tree,
    workspace: workspaceCreated.adapter,
    workspaces,
  });
}

function materializeIntent(runId: string, workspaceId: string, base: string, tree: string) {
  return bindLawIntent("git", Object.freeze({
    inputs: Object.freeze({ baseRevision: base, repositorySnapshot: tree, workspaceId }),
    kind: "materialize-workspace",
    preconditions: Object.freeze({ expectedAbsent: true, repositoryIdentity: tree }),
    runId,
  }));
}

function compareIntent(runId: string, leftRoot: string, rightRoot: string) {
  return bindLawIntent("git", Object.freeze({
    inputs: Object.freeze({ leftRoot, rightRoot }),
    kind: "compare-roots",
    preconditions: Object.freeze({ repositoryIdentity: leftRoot }),
    runId,
  }));
}

function publishIntent(
  runId: string,
  expectedHead: string,
  desiredHead: string,
  candidateTree: string,
  seed: number,
) {
  const template = gitIntentCapsule.arbitrary.validForKind("publish-if-expected-head", seed);
  assert.equal(template.kind, "publish-if-expected-head");
  if (template.kind !== "publish-if-expected-head") {
    throw new Error("publish template failed");
  }
  return bindLawIntent("git", Object.freeze({
    inputs: Object.freeze({
      desiredHead,
      expectedHead,
      publicationId: template.inputs.publicationId,
    }),
    kind: "publish-if-expected-head",
    preconditions: Object.freeze({
      candidateTree,
      publicationLease: template.preconditions.publicationLease,
      verifiedManifest: template.preconditions.verifiedManifest,
    }),
    runId,
  }));
}

test("real Git adapter replays the frozen Git law vector with fake-equivalent trace", async () => {
  const value = await fixture();
  try {
    const driver = new RealLawDriver({
      git: value.adapter,
      integrationRoot: value.integrationRoot,
      repository: value.repository,
      runGit: checkedGit,
      workspace: value.workspace,
    });
    const result = await gitLawVector.replay(driver);
    const simulated = await gitLawVector.replay(new SimLawDriver(1));
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.trace, simulated.trace);
    assert.equal(result.trace.every((entry) => entry.result === "ok"), true);
    const publishAgain = result.trace.find((entry) => entry.operation === "publish-idempotent");
    assert.equal(publishAgain?.result, "ok");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("materialization clones an exact revision and leaves dirty foreign source state untouched", async () => {
  const value = await fixture();
  const runId = "run:materialize";
  try {
    const hook = join(value.repository, ".git", "hooks", "post-checkout");
    const marker = join(value.root, "hook-ran");
    await writeFile(hook, `#!/bin/sh\necho ran > '${marker}'\n`);
    await chmod(hook, 0o755);
    await checkedGit(value.repository, ["config", "core.hooksPath", join(value.repository, ".git", "hooks")]);
    await writeFile(join(value.repository, "foreign.bin"), Uint8Array.from([9, 0, 7]));
    const before = await checkedGit(value.repository, ["status", "--porcelain=v1", "-z"]);
    const allocateTemplate = await import("../../../ports/contracts/workspace.capsule.js").then((module) =>
      module.workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 1));
    assert.equal(allocateTemplate.kind, "allocate-attempt-directory");
    if (allocateTemplate.kind !== "allocate-attempt-directory") {
      throw new Error("allocate template failed");
    }
    const allocate = bindLawIntent("workspace", Object.freeze({
      inputs: Object.freeze({ baseRoot: value.tree, workspaceId: "attempt-one" }),
      kind: "allocate-attempt-directory",
      preconditions: allocateTemplate.preconditions,
      runId,
    }));
    const allocated = await value.workspace.execute(allocate);
    assert.equal(allocated.kind, "observation");
    const materialized = await value.adapter.execute(materializeIntent(runId, "attempt-one", value.base, value.tree));
    assert.equal(materialized.kind, "observation");
    if (materialized.kind === "observation") {
      assert.equal(materialized.observation.result.kind, "ok");
    }
    assert.equal(await readFile(join(value.workspaces, "attempt-one", "base.txt"), "utf8"), "base\n");
    const after = await checkedGit(value.repository, ["status", "--porcelain=v1", "-z"]);
    assert.equal(after, before);
    await assert.rejects(lstat(marker));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("compare-roots normalizes renames, modes, symlinks, binary and Unicode paths", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.repository, "rename-me"), "same\n");
    await writeFile(join(value.repository, "mode.sh"), "#!/bin/sh\nexit 0\n");
    await writeFile(join(value.repository, "binary.bin"), Uint8Array.from([0, 255, 1]));
    await writeFile(join(value.repository, "unicodé-雪.txt"), "snow\n");
    await symlink("base.txt", join(value.repository, "link"));
    const leftCommit = await commit(value.repository, "complex-left");
    const leftTreeOid = await checkedGit(value.repository, ["rev-parse", `${leftCommit}^{tree}`]);
    const leftTree = gitArtifactRootForTreeOid(leftTreeOid);
    assert.notEqual(leftTree, null);
    if (leftTree === null) {
      throw new Error("left tree root failed");
    }
    await checkedGit(value.repository, ["mv", "rename-me", "renamed"]);
    await chmod(join(value.repository, "mode.sh"), 0o755);
    await writeFile(join(value.repository, "binary.bin"), Uint8Array.from([0, 2, 255]));
    await rm(join(value.repository, "link"));
    await symlink("renamed", join(value.repository, "link"));
    await writeFile(join(value.repository, "unicodé-雪.txt"), "ice\n");
    const rightCommit = await commit(value.repository, "complex-right");
    const rightTreeOid = await checkedGit(value.repository, ["rev-parse", `${rightCommit}^{tree}`]);
    const rightTree = gitArtifactRootForTreeOid(rightTreeOid);
    assert.notEqual(rightTree, null);
    if (rightTree === null) {
      throw new Error("right tree root failed");
    }
    const result = await value.adapter.compareTrees(leftTree, rightTree);
    assert.equal(result.kind, "compared");
    if (result.kind === "compared") {
      assert.equal(result.equal, false);
      assert.equal(result.entries.some((entry) => entry.kind === "renamed" && entry.path === "renamed"), true);
      assert.equal(result.entries.some((entry) => entry.path === "mode.sh" && entry.oldMode !== entry.newMode), true);
      assert.equal(result.entries.some((entry) => entry.path === "binary.bin"), true);
      assert.equal(result.entries.some((entry) =>
        entry.path === "link"
        && entry.oldEntryKind === "symlink"
        && entry.newEntryKind === "symlink"
        && entry.oldObject !== entry.newObject), true);
      assert.equal(result.entries.some((entry) => entry.path === "unicodé-雪.txt"), true);
    }
    const observation = await value.adapter.execute(compareIntent("run:compare", leftTree, rightTree));
    assert.equal(observation.kind, "observation");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("real merge conflicts normalize to an observation and leave the integration clone intact", async () => {
  const value = await fixture();
  try {
    await checkedGit(value.repository, ["checkout", "--detach", value.base]);
    await writeFile(join(value.repository, "base.txt"), "candidate\n");
    const candidate = await commit(value.repository, "candidate-conflict");
    await checkedGit(value.repository, ["checkout", "--detach", value.base]);
    await writeFile(join(value.repository, "base.txt"), "integration\n");
    const integrationBase = await commit(value.repository, "integration-conflict");
    const integrationTreeOid = await checkedGit(value.repository, ["rev-parse", `${integrationBase}^{tree}`]);
    const integrationTree = gitArtifactRootForTreeOid(integrationTreeOid);
    assert.notEqual(integrationTree, null);
    if (integrationTree === null) {
      throw new Error("integration root failed");
    }
    const outputs = new TextEncoder().encode(`${candidate}\n`);
    const outputsRoot = `sha256:${createHash("sha256").update(outputs).digest("hex")}`;
    const outputsDirectory = join(value.integrationRoot, "accepted-outputs");
    await mkdir(outputsDirectory);
    await writeFile(join(outputsDirectory, outputsRoot.slice(7)), outputs);
    const template = gitIntentCapsule.arbitrary.validForKind("integrate-candidate", 77);
    assert.equal(template.kind, "integrate-candidate");
    if (template.kind !== "integrate-candidate") {
      throw new Error("integrate template failed");
    }
    const bound = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({
        acceptedOutputs: Object.freeze({ path: "git/accepted-outputs.txt", range: null, root: outputsRoot }),
        baseRevision: integrationBase,
        candidateId: template.inputs.candidateId,
      }),
      kind: "integrate-candidate",
      preconditions: Object.freeze({
        expectedIntegrationRoot: integrationTree,
        repositoryIdentity: integrationTree,
      }),
      runId: template.runId,
    }));
    assert.notEqual(bound, null);
    if (bound === null || typeof bound !== "object" || Array.isArray(bound)) {
      throw new Error("integrate intent binding failed");
    }
    const actionId = Reflect.get(bound, "actionId");
    assert.equal(typeof actionId, "string");
    if (typeof actionId !== "string") {
      throw new Error("integrate action ID failed");
    }
    const result = await value.adapter.execute(bound);
    assert.equal(result.kind, "observation");
    if (result.kind === "observation") {
      assert.equal(result.observation.kind, "candidate-integrated");
      assert.equal(result.observation.result.kind, "retry");
      if (result.observation.result.kind === "retry") {
        assert.equal(result.observation.result.diagnostic.code, "git.integration-conflict");
      }
    }
    const integrationClone = join(value.integrationRoot, `integrate-${actionId.slice(14)}`);
    assert.equal((await lstat(integrationClone)).isDirectory(), true);
    const conflicted = await checkedGit(integrationClone, ["diff", "--name-only", "--diff-filter=U"]);
    assert.equal(conflicted, "base.txt");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("moved-head between read and update-ref is observed, never overwritten", async () => {
  const value = await fixture();
  try {
    await checkedGit(value.repository, ["checkout", "--detach", value.base]);
    await writeFile(join(value.repository, "desired"), "desired\n");
    const desired = await commit(value.repository, "desired-race");
    await checkedGit(value.repository, ["checkout", "--detach", value.base]);
    await writeFile(join(value.repository, "racer"), "racer\n");
    const racer = await commit(value.repository, "racer");
    const desiredTreeOid = await checkedGit(value.repository, ["rev-parse", `${desired}^{tree}`]);
    const desiredTree = gitArtifactRootForTreeOid(desiredTreeOid);
    assert.notEqual(desiredTree, null);
    if (desiredTree === null) {
      throw new Error("desired root failed");
    }
    const created = await GitAdapter.create({
      integrationRoot: value.integrationRoot,
      publicationObserver: async () => {
        await checkedGit(value.repository, ["update-ref", "refs/autopilot/test", racer, value.base]);
      },
      publicationRef: "refs/autopilot/test",
      repository: value.repository,
      workspace: value.workspace,
    });
    assert.equal(created.kind, "created");
    if (created.kind !== "created") {
      throw new Error("race adapter failed");
    }
    const result = await created.adapter.execute(publishIntent(
      "run:moved-between",
      value.base,
      desired,
      desiredTree,
      88,
    ));
    assert.equal(result.kind, "observation");
    if (
      result.kind === "observation"
      && result.observation.kind === "head-publication-observed"
      && result.observation.result.kind === "ok"
    ) {
      assert.equal(result.observation.result.value.status, "head-moved");
      assert.equal(result.observation.result.value.observedHead, racer);
    } else {
      assert.fail("moved-head observation was not returned");
    }
    assert.equal(await checkedGit(value.repository, ["rev-parse", "refs/autopilot/test"]), racer);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("atomic update-ref race reports one publisher and one moved head", async () => {
  const value = await fixture();
  try {
    await checkedGit(value.repository, ["checkout", "--detach", value.base]);
    await writeFile(join(value.repository, "one"), "one\n");
    const one = await commit(value.repository, "one");
    await checkedGit(value.repository, ["checkout", "--detach", value.base]);
    await writeFile(join(value.repository, "two"), "two\n");
    const two = await commit(value.repository, "two");
    const oneTreeOid = await checkedGit(value.repository, ["rev-parse", `${one}^{tree}`]);
    const twoTreeOid = await checkedGit(value.repository, ["rev-parse", `${two}^{tree}`]);
    const oneTree = gitArtifactRootForTreeOid(oneTreeOid);
    const twoTree = gitArtifactRootForTreeOid(twoTreeOid);
    assert.notEqual(oneTree, null);
    assert.notEqual(twoTree, null);
    if (oneTree === null || twoTree === null) {
      throw new Error("publication tree roots failed");
    }
    const first = publishIntent("run:publish", value.base, one, oneTree, 11);
    const second = publishIntent("run:publish", value.base, two, twoTree, 12);
    const results = await Promise.all([value.adapter.execute(first), value.adapter.execute(second)]);
    const statuses = results.map((result) => {
      assert.equal(result.kind, "observation");
      if (
        result.kind !== "observation"
        || result.observation.kind !== "head-publication-observed"
        || result.observation.result.kind !== "ok"
      ) {
        return "invalid";
      }
      return result.observation.result.value.status;
    }).sort();
    assert.deepEqual(statuses, ["head-moved", "published"]);
    const head = await checkedGit(value.repository, ["rev-parse", "refs/autopilot/test"]);
    assert.equal(head === one || head === two, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
