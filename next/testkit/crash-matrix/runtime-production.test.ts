import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArtifactRef } from "../../authority/protocol/identifiers.js";
import type { Stimulus } from "../../authority/protocol/stimulus.capsule.js";
import { stimulusCapsule } from "../../authority/protocol/stimulus.capsule.js";
import { canonicalArtifactInstaller, openCas } from "../../storage/cas/index.js";
import { replayJournal } from "../../storage/journal/index.js";
import { normalizeArtifact } from "../../runtime/artifact-normalization/index.js";
import { decodeStimulus, inertJsonFromUnknown } from "../../runtime/boundary-codecs/index.js";
import { canonicalCommandArtifactRepository, openCommitLoop } from "../../runtime/commit-loop/index.js";
import type { CommitLoopDependencies } from "../../runtime/commit-loop/index.js";
import { canonicalRuntimeArtifactRecorder, dispatchCommittedCommands } from "../../runtime/dispatcher/index.js";
import type { DispatcherDependencies, RuntimeArtifactRecorder } from "../../runtime/dispatcher/index.js";
import { sealSubmission } from "../../runtime/seal/index.js";
import { nonemptyScenario } from "../scenario-harness/authority.js";
import { SimLawDriver } from "../simulation/law-driver.js";

function dispatcher(driver: SimLawDriver, artifacts: RuntimeArtifactRecorder): DispatcherDependencies {
  return Object.freeze({
    ports: Object.freeze({
      dispatch(port: Parameters<SimLawDriver["dispatch"]>[0], intent: Parameters<SimLawDriver["dispatch"]>[1]) {
        return driver.dispatch(port, intent);
      },
    }),
    artifacts,
  });
}

async function journalKinds(path: string): Promise<readonly string[]> {
  const replay = replayJournal(path);
  const kinds: string[] = [];
  for await (const record of replay) kinds.push(record.kind);
  const completion = await replay.completion;
  assert.equal(completion.kind, "complete");
  return Object.freeze(kinds);
}

test("runtime boundary codecs contain hostile JavaScript without invoking accessors", () => {
  let getterReads = 0;
  const hostile = Object.create(null, {
    runId: Object.freeze({
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("must remain inert");
      },
    }),
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const revoked = Proxy.revocable(Object.freeze({}), Object.freeze({}));
  revoked.revoke();
  const garbage = Object.freeze([
    null,
    undefined,
    true,
    -1,
    "not-a-stimulus",
    Uint8Array.from([255, 0]),
    hostile,
    cycle,
    revoked.proxy,
    Symbol("hostile"),
    () => 1,
  ]);
  for (const value of garbage) {
    assert.doesNotThrow(() => decodeStimulus(value));
    assert.notEqual(decodeStimulus(value).kind, "ok");
    assert.doesNotThrow(() => inertJsonFromUnknown(value));
  }
  assert.equal(getterReads, 0);
});

test("artifact normalization is canonical, strict, and command-kind independent", () => {
  const scenario = nonemptyScenario(601);
  const record = scenario.commit.record;
  assert.equal(record.kind, "decision-committed");
  if (record.kind !== "decision-committed") return;
  const first = normalizeArtifact(record.commands, "command-batch");
  const second = normalizeArtifact(record.commands, "command-batch");
  assert.equal(first.kind, "normalized");
  assert.equal(second.kind, "normalized");
  if (first.kind === "normalized" && second.kind === "normalized") {
    assert.equal(first.artifact.digest, second.artifact.digest);
    assert.deepEqual(first.artifact.canonicalBytes, second.artifact.canonicalBytes);
    assert.equal(first.artifact.digest, record.commandDigest);
  }
  assert.equal(normalizeArtifact(Object.freeze({ unexpected: true }), "command-batch").kind, "feedback");
  assert.equal(normalizeArtifact(record.commands, "not-a-kind").kind, "feedback");
});

test("public authority commands dispatch through closed port ingress with canonical CAS readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-dispatch-"));
  try {
    const openedCas = await openCas(join(root, "cas"));
    assert.equal(openedCas.kind, "opened");
    if (openedCas.kind !== "opened") return;
    const scenario = nonemptyScenario(701);
    assert.equal(scenario.commit.record.kind, "decision-committed");
    if (scenario.commit.record.kind !== "decision-committed") return;
    const driver = new SimLawDriver(701);
    const artifacts = canonicalRuntimeArtifactRecorder(canonicalArtifactInstaller(openedCas.store));
    const submitted: Stimulus[] = [];
    const result = await dispatchCommittedCommands(
      scenario.commit.record.commands,
      dispatcher(driver, artifacts),
      Object.freeze({ submit(stimulus: Stimulus) { submitted.push(stimulus); } }),
    );
    assert.equal(result.kind, "dispatched");
    if (result.kind === "dispatched") {
      assert.equal(result.reports.length, scenario.commit.record.commands.length);
      assert.equal(result.reports.every((report) => report.kind === "observation-submitted"), true);
    }
    assert.equal(submitted.length, scenario.commit.record.commands.length);
    for (const stimulus of submitted) {
      assert.equal(stimulus.kind, "command-observation-received");
      assert.equal(decodeStimulus(stimulus).kind, "ok");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("dispatcher rejects recorder references whose installed bytes cannot be read back exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-recorder-"));
  try {
    const openedCas = await openCas(join(root, "cas"));
    assert.equal(openedCas.kind, "opened");
    if (openedCas.kind !== "opened") return;
    const scenario = nonemptyScenario(711);
    if (scenario.commit.record.kind !== "decision-committed") return;
    const real = canonicalRuntimeArtifactRecorder(canonicalArtifactInstaller(openedCas.store));
    const unreadable: RuntimeArtifactRecorder = Object.freeze({
      record: real.record,
      async read(_reference: ArtifactRef, _maxBytes: number) {
        return Uint8Array.from([0]);
      },
    });
    const submitted: Stimulus[] = [];
    const result = await dispatchCommittedCommands(
      scenario.commit.record.commands,
      dispatcher(new SimLawDriver(711), unreadable),
      Object.freeze({ submit(stimulus: Stimulus) { submitted.push(stimulus); } }),
    );
    assert.equal(result.kind, "dispatched");
    if (result.kind === "dispatched") assert.equal(result.reports.every((report) => report.kind === "feedback"), true);
    assert.equal(submitted.length, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("commit loop installs command bytes before append, settles via public ingress, and is action-idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-loop-"));
  try {
    const openedCas = await openCas(join(root, "cas"));
    assert.equal(openedCas.kind, "opened");
    if (openedCas.kind !== "opened") return;
    const scenario = nonemptyScenario(801);
    const journalDir = join(root, "journal");
    const installer = canonicalArtifactInstaller(openedCas.store);
    const dependencies: CommitLoopDependencies = Object.freeze({
      commands: canonicalCommandArtifactRepository(installer),
      dispatcher: dispatcher(new SimLawDriver(801), canonicalRuntimeArtifactRecorder(installer)),
      journalOptions: undefined,
    });
    const opened = await openCommitLoop(Object.freeze({ genesis: scenario.genesis, journalDir }), dependencies);
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    assert.equal(opened.reconciliation.kind, "dispatched");
    const accepted = await opened.loop.ingest(scenario.stimulus);
    assert.equal(accepted.kind, "accepted");
    if (accepted.kind === "accepted") {
      assert.equal(accepted.record.kind, "decision-committed");
      assert.ok(accepted.record.kind === "decision-committed" && accepted.record.commands.length > 0);
      assert.equal(accepted.dispatch.kind, "dispatched");
    }
    const duplicate = await opened.loop.ingest(scenario.stimulus);
    assert.equal(duplicate.kind, "already-committed");
    await opened.loop.close();

    const kinds = await journalKinds(journalDir);
    assert.equal(kinds[0], "run-genesis");
    assert.equal(kinds.includes("decision-committed"), true);
    assert.equal(kinds.includes("command-settled"), true);

    const restarted = await openCommitLoop(Object.freeze({ genesis: scenario.genesis, journalDir }), dependencies);
    assert.equal(restarted.kind, "opened");
    if (restarted.kind === "opened") {
      assert.equal(restarted.reconciliation.kind, "dispatched");
      const replayDuplicate = await restarted.loop.ingest(scenario.stimulus);
      assert.equal(replayDuplicate.kind, "already-committed");
      await restarted.loop.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("commit loop rejects substituted command bytes on cold reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-substitution-"));
  try {
    const openedCas = await openCas(join(root, "cas"));
    assert.equal(openedCas.kind, "opened");
    if (openedCas.kind !== "opened") return;
    const scenario = nonemptyScenario(821);
    const journalDir = join(root, "journal");
    const installer = canonicalArtifactInstaller(openedCas.store);
    const canonicalRecorder = canonicalRuntimeArtifactRecorder(installer);
    const interruptedRecorder: RuntimeArtifactRecorder = Object.freeze({
      record: canonicalRecorder.record,
      async read(_reference: ArtifactRef, _maxBytes: number) {
        return Uint8Array.from([0]);
      },
    });
    const good: CommitLoopDependencies = Object.freeze({
      commands: canonicalCommandArtifactRepository(installer),
      dispatcher: dispatcher(new SimLawDriver(821), interruptedRecorder),
      journalOptions: undefined,
    });
    const opened = await openCommitLoop(Object.freeze({ genesis: scenario.genesis, journalDir }), good);
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    assert.equal((await opened.loop.ingest(scenario.stimulus)).kind, "accepted");
    await opened.loop.close();

    const canonical = canonicalCommandArtifactRepository(installer);
    const substituted: CommitLoopDependencies = Object.freeze({
      ...good,
      dispatcher: dispatcher(new SimLawDriver(821), canonicalRecorder),
      commands: Object.freeze({
        store: canonical.store,
        load(_reference: ArtifactRef) {
          return Object.freeze([]);
        },
      }),
    });
    const restarted = await openCommitLoop(Object.freeze({ genesis: scenario.genesis, journalDir }), substituted);
    assert.equal(restarted.kind, "opened");
    if (restarted.kind === "opened") {
      assert.equal(restarted.reconciliation.kind, "fatal");
      await restarted.loop.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("seal captures immutable CAS roots without mutable reread", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-seal-"));
  try {
    const openedCas = await openCas(join(root, "cas"));
    assert.equal(openedCas.kind, "opened");
    if (openedCas.kind !== "opened") return;
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "hostile.bin"), Buffer.from([0, 255, 1, 2]));
    const template = stimulusCapsule.arbitrary.validForKind("submission-ready", 901);
    assert.equal(template.kind, "submission-ready");
    if (template.kind !== "submission-ready") return;
    const request = Object.freeze({
      actionId: template.actionId,
      attemptId: template.attemptId,
      inputRoot: template.inputRoot,
      kind: "seal-submission",
      pages: template.pages,
      planRootId: template.planRootId,
      runId: template.runId,
      sourceDirectory: workspace,
      submissionPayload: template.submissionPayload,
      workItemId: template.workItemId,
    });
    const first = await sealSubmission(request, openedCas.store);
    const duplicate = await sealSubmission(request, openedCas.store);
    assert.equal(first.kind, "sealed");
    assert.equal(duplicate.kind, "sealed");
    if (first.kind === "sealed" && duplicate.kind === "sealed") {
      assert.equal(first.stimulus.outputRoot, duplicate.stimulus.outputRoot);
      assert.equal(duplicate.alreadyPresent, true);
      await writeFile(join(workspace, "hostile.bin"), Buffer.from([9, 9, 9]));
      const changed = await sealSubmission(request, openedCas.store);
      assert.equal(changed.kind, "sealed");
      if (changed.kind === "sealed") assert.notEqual(changed.stimulus.outputRoot, first.stimulus.outputRoot);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
