import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitAdapter } from "../../../adapters/git/index.js";
import { WorkspaceAdapter } from "../../../adapters/workspace/index.js";
import { canonicalArtifactInstaller, openCas } from "../../../storage/cas/index.js";
import { gitIntentCapsule } from "../../../ports/contracts/git.capsule.js";
import { workspaceIntentCapsule } from "../../../ports/contracts/workspace.capsule.js";
import { gitLawVector } from "../../../ports/laws/git.vectors.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import { SimLawDriver } from "../../simulation/law-driver.js";
import { RealLawDriver } from "../real-law-driver.js";

const REPOSITORY_CAPABILITY = "repository:real-law";
const PUBLICATION_REF = "refs/autopilot/law";

interface GitResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }

function git(cwd: string, arguments_: readonly string[]): Promise<GitResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn("git", arguments_, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult(Object.freeze({ code, stdout: Buffer.concat(stdout).toString("utf8").trim(), stderr: Buffer.concat(stderr).toString("utf8") })));
  });
}

async function checkedGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await git(cwd, arguments_);
  assert.equal(result.code, 0, `git ${arguments_.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-git-real-"));
  const repository = join(root, "repository");
  const workspaces = join(root, "workspaces");
  const integrationRoot = join(root, "integration");
  await mkdir(repository);
  await mkdir(integrationRoot);
  await checkedGit(repository, ["init", "-b", "main"]);
  await checkedGit(repository, ["config", "user.name", "Adapter Test"]);
  await checkedGit(repository, ["config", "user.email", "adapter@test.invalid"]);
  const workspaceCreated = await WorkspaceAdapter.create({ workspaceRoot: workspaces });
  assert.equal(workspaceCreated.kind, "created");
  if (workspaceCreated.kind !== "created") throw new Error("workspace adapter fixture failed");
  const openedCas = await openCas(join(root, "cas"));
  assert.equal(openedCas.kind, "opened");
  if (openedCas.kind !== "opened") throw new Error("CAS fixture failed");
  const artifacts = canonicalArtifactInstaller(openedCas.store);
  const gitCreated = await GitAdapter.create({
    repositories: Object.freeze({ pathFor(capability: string) { return capability === REPOSITORY_CAPABILITY ? repository : null; } }),
    integrationRoot,
    workspace: Object.freeze({
      workspaceRoot: workspaceCreated.adapter.workspaceRoot,
      pathFor(_capability: string, workspaceId: string) { return workspaceCreated.adapter.pathFor(workspaceId); },
    }),
    maxOutputBytes: 1_048_576,
    artifacts,
  });
  assert.equal(gitCreated.kind, "created");
  if (gitCreated.kind !== "created") throw new Error("Git adapter fixture failed");
  return Object.freeze({ root, repository, integrationRoot, artifacts, adapter: gitCreated.adapter, workspace: workspaceCreated.adapter });
}

function behavioralTrace(result: Awaited<ReturnType<typeof gitLawVector.replay>>) {
  return result.trace.map((entry) => Object.freeze({ operation: entry.operation, observationKind: entry.observationKind, result: entry.result, evidenceVerified: entry.artifactEvidence.every((evidence) => evidence.verified) }));
}

test("real Git adapter replays the frozen Git law with fake-equivalent behavior", async () => {
  const value = await fixture();
  try {
    const real = new RealLawDriver({
      repository: value.repository,
      repositoryCapability: REPOSITORY_CAPABILITY,
      publicationRef: PUBLICATION_REF,
      git: value.adapter,
      workspace: value.workspace,
      artifacts: value.artifacts,
      runGit: checkedGit,
    });
    const result = await gitLawVector.replay(real);
    const simulated = await gitLawVector.replay(new SimLawDriver(1));
    assert.deepEqual(result.findings, [], result.findings.join("; "));
    assert.deepEqual(simulated.findings, []);
    assert.deepEqual(behavioralTrace(result), behavioralTrace(simulated));
    assert.equal(result.trace.every((entry) => entry.result === "ok"), true);
    assert.equal(result.trace.flatMap((entry) => entry.artifactEvidence).every((evidence) => evidence.verified), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("materialization consumes only an empty reserved directory and leaves source dirt untouched", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.repository, "base.txt"), "base\n");
    await checkedGit(value.repository, ["add", "-A"]);
    await checkedGit(value.repository, ["commit", "-m", "base"]);
    const baseCommit = await checkedGit(value.repository, ["rev-parse", "HEAD"]);
    const baseTree = await checkedGit(value.repository, ["rev-parse", "HEAD^{tree}"]);
    await writeFile(join(value.repository, "foreign.bin"), Uint8Array.from([9, 0, 7]));
    const before = await checkedGit(value.repository, ["status", "--porcelain=v1", "-z"]);
    const allocate = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 1001);
    const materialize = gitIntentCapsule.arbitrary.validForKind("materialize-workspace", 1002);
    assert.equal(allocate.kind, "allocate-attempt-directory");
    assert.equal(materialize.kind, "materialize-workspace");
    if (allocate.kind !== "allocate-attempt-directory" || materialize.kind !== "materialize-workspace") return;
    const allocatedIntent = bindLawIntent("workspace", Object.freeze({ inputs: allocate.inputs, kind: allocate.kind, preconditions: allocate.preconditions, runId: allocate.runId }));
    const allocated = await value.workspace.execute(allocatedIntent);
    assert.equal(allocated.kind, "observation");
    const bound = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({
        baseCommit,
        baseTree,
        repository: REPOSITORY_CAPABILITY,
        workspaceCapability: allocate.inputs.workspaceCapability,
        workspaceId: allocate.inputs.workspaceId,
      }),
      kind: "materialize-workspace",
      preconditions: Object.freeze({ expectedEmptyReservation: true, reservationLease: allocate.preconditions.leaseId }),
      runId: materialize.runId,
    }));
    const observed = await value.adapter.execute(bound);
    assert.equal(observed.kind, "observation");
    if (observed.kind === "observation") assert.equal(observed.observation.result.kind, "ok");
    const destination = value.workspace.pathFor(allocate.inputs.workspaceId);
    assert.notEqual(destination, null);
    if (destination !== null) assert.equal(await readFile(join(destination, "base.txt"), "utf8"), "base\n");
    assert.equal(await checkedGit(value.repository, ["status", "--porcelain=v1", "-z"]), before);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Git adapter contains malformed capabilities and never follows a repository symlink", async () => {
  const value = await fixture();
  try {
    const template = gitIntentCapsule.arbitrary.validForKind("observe-repository-ref", 1101);
    assert.equal(template.kind, "observe-repository-ref");
    if (template.kind !== "observe-repository-ref") return;
    const bound = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({ publicationRef: PUBLICATION_REF, repository: template.inputs.repository }),
      kind: template.kind,
      preconditions: template.preconditions,
      runId: template.runId,
    }));
    const result = await value.adapter.execute(bound);
    assert.equal(result.kind, "observation");
    if (result.kind === "observation") assert.equal(result.observation.result.kind, "retry");
    assert.doesNotThrow(() => value.adapter.execute(Object.freeze({ hostile: true })));
    assert.equal((await value.adapter.execute(Object.freeze({ hostile: true }))).kind, "rejected");
    assert.equal((await lstat(value.repository)).isDirectory(), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
