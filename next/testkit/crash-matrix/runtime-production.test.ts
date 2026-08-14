import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { commandActionId, commandCapsule, commandIdentity } from "../../authority/protocol/command.capsule.js";
import { evidenceEnvelopeDigest } from "../../authority/protocol/evidence-fact.capsule.js";
import type { ArtifactRef } from "../../authority/protocol/identifiers.js";
import { journalRecordCapsule } from "../../authority/protocol/journal-record.capsule.js";
import type { Stimulus } from "../../authority/protocol/stimulus.capsule.js";
import { stimulusCapsule } from "../../authority/protocol/stimulus.capsule.js";
import { workspaceIntentCapsule } from "../../ports/contracts/workspace.capsule.js";
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
import { PublicAuthorityScenario } from "../scenario-harness/full-run.js";
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

test("dispatcher alone mints class-bound evidence from a committed command and physical receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-evidence-"));
  try {
    const openedCas = await openCas(join(root, "cas"));
    assert.equal(openedCas.kind, "opened");
    if (openedCas.kind !== "opened") return;
    const scenario = new PublicAuthorityScenario(706);
    const template = commandCapsule.arbitrary.validForKind("execute-evidence", 706);
    assert.equal(template.kind, "execute-evidence");
    if (template.kind !== "execute-evidence") return;
    const candidateTree = scenario.install("dispatcher-evidence-tree", Object.freeze({ tree: true })).root;
    const commandSpec = scenario.install("dispatcher-evidence-command", Object.freeze({ command: true })).reference;
    const environment = scenario.install("dispatcher-evidence-environment", Object.freeze({ environment: true })).reference;
    const intentInputs = Object.freeze({
      attemptId: template.attemptId,
      candidateTree,
      commandSpec,
      cwd: template.cwd,
      environment,
      evidenceClass: "final-verification",
      kindId: template.kindId,
      ruleId: template.ruleId,
      workItemId: template.workItemId,
      workspaceCapability: template.workspaceCapability,
      workspaceId: template.workspaceId,
    });
    const intentPreconditions = Object.freeze({ deadlineTick: template.deadlineTick });
    const actionId = commandActionId("child", scenario.genesis.runId, "execute-evidence-command", intentInputs, intentPreconditions);
    const decoded = commandCapsule.decode(Object.freeze({
      ...template,
      actionId,
      candidateTree,
      commandId: commandIdentity("execute-evidence", actionId),
      commandSpec,
      environment,
      evidenceClass: "final-verification",
      runId: scenario.genesis.runId,
    }));
    assert.equal(decoded.kind, "ok");
    if (decoded.kind !== "ok" || decoded.value.kind !== "execute-evidence") return;
    const submitted: Stimulus[] = [];
    const result = await dispatchCommittedCommands(
      Object.freeze([decoded.value]),
      dispatcher(new SimLawDriver(706), canonicalRuntimeArtifactRecorder(canonicalArtifactInstaller(openedCas.store))),
      Object.freeze({ submit(stimulus: Stimulus) { submitted.push(stimulus); } }),
    );
    assert.equal(result.kind, "dispatched");
    assert.equal(submitted.length, 1, inspect(result, { depth: 8 }));
    const stimulus = submitted[0];
    assert.equal(stimulus?.kind, "command-observation-received");
    if (stimulus?.kind !== "command-observation-received" || stimulus.observationPayload.kind !== "evidence-observed-v2") return;
    const evidence = stimulus.observationPayload.evidence;
    assert.equal(evidence.envelope.class, "final-verification");
    assert.equal(evidence.envelope.acceptedOutput, candidateTree);
    assert.equal(evidence.envelope.tree, candidateTree);
    assert.deepEqual(evidence.envelope.command, commandSpec);
    assert.deepEqual(evidence.envelope.environment, environment);
    assert.equal(evidence.envelope.workItemId, decoded.value.workItemId);
    assert.equal(evidence.envelopeDigest, evidenceEnvelopeDigest(evidence.envelope));
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
    const lawDriver = new SimLawDriver(801);
    const dependencies: CommitLoopDependencies = Object.freeze({
      commands: canonicalCommandArtifactRepository(installer),
      dispatcher: dispatcher(lawDriver, canonicalRuntimeArtifactRecorder(installer)),
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
    const effectsAfterFirst = lawDriver.world.trace.snapshot().filter((entry) => entry.category === "contract" && entry.name === "observation").length;
    const duplicate = await opened.loop.ingest(scenario.stimulus);
    assert.equal(duplicate.kind, "already-committed");
    if (accepted.kind === "accepted" && duplicate.kind === "already-committed") {
      assert.equal(journalRecordCapsule.digest(duplicate.record), journalRecordCapsule.digest(accepted.record));
      assert.equal(duplicate.dispatch.kind, "dispatched");
      if (duplicate.dispatch.kind === "dispatched") assert.equal(duplicate.dispatch.reports.length, 0);
    }
    assert.equal(lawDriver.world.trace.snapshot().filter((entry) => entry.category === "contract" && entry.name === "observation").length, effectsAfterFirst);
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
      if (accepted.kind === "accepted" && replayDuplicate.kind === "already-committed") assert.equal(journalRecordCapsule.digest(replayDuplicate.record), journalRecordCapsule.digest(accepted.record));
      assert.equal(lawDriver.world.trace.snapshot().filter((entry) => entry.category === "contract" && entry.name === "observation").length, effectsAfterFirst);
      await restarted.loop.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("port retry leaves its command issued until reconciliation succeeds exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-retry-"));
  try {
    const openedCas = await openCas(join(root, "cas"));
    assert.equal(openedCas.kind, "opened");
    if (openedCas.kind !== "opened") return;
    const scenario = nonemptyScenario(811);
    assert.equal(scenario.commit.record.kind, "decision-committed");
    if (scenario.commit.record.kind !== "decision-committed") return;
    const command = scenario.commit.record.commands[0];
    assert.notEqual(command, undefined);
    if (command === undefined) return;
    const driver = new SimLawDriver(811);
    let calls = 0;
    const ports = Object.freeze({
      dispatch(port: Parameters<SimLawDriver["dispatch"]>[0], intent: Parameters<SimLawDriver["dispatch"]>[1]) {
        const workspaceIntent = port === "workspace" ? workspaceIntentCapsule.decode(intent) : null;
        if (workspaceIntent?.kind === "ok" && workspaceIntent.value.kind === "allocate-attempt-directory" && calls === 0) {
          calls += 1;
          return Object.freeze({ kind: "observation", observation: Object.freeze({
            actionId: workspaceIntent.value.actionId,
            kind: "attempt-directory-allocated",
            result: Object.freeze({ kind: "retry", diagnostic: Object.freeze({ code: "workspace.transient", message: "transient reservation failure", related: Object.freeze([]) }) }),
            runId: workspaceIntent.value.runId,
          }) });
        }
        calls += 1;
        return driver.dispatch(port, intent);
      },
    });
    const installer = canonicalArtifactInstaller(openedCas.store);
    const dependencies: CommitLoopDependencies = Object.freeze({
      commands: canonicalCommandArtifactRepository(installer),
      dispatcher: Object.freeze({ ports, artifacts: canonicalRuntimeArtifactRecorder(installer) }),
      journalOptions: undefined,
    });
    const journalDir = join(root, "journal");
    const opened = await openCommitLoop(Object.freeze({ genesis: scenario.genesis, journalDir }), dependencies);
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    const accepted = await opened.loop.ingest(scenario.stimulus);
    assert.equal(accepted.kind, "accepted");
    if (accepted.kind === "accepted") {
      assert.equal(accepted.dispatch.kind, "dispatched");
      if (accepted.dispatch.kind === "dispatched") assert.equal(accepted.dispatch.reports[0]?.kind, "feedback");
    }
    assert.equal(calls, 1);
    assert.equal((await journalKinds(journalDir)).includes("command-settled"), false);
    const reconciled = await opened.loop.reconcile();
    assert.equal(reconciled.kind, "dispatched");
    assert.equal(calls, 2);
    assert.equal((await journalKinds(journalDir)).filter((kind) => kind === "command-settled").length, 1);
    const repeated = await opened.loop.reconcile();
    assert.equal(repeated.kind, "dispatched");
    assert.equal(calls, 2);

    const forgedTemplate = stimulusCapsule.arbitrary.validForKind("command-observation-received", 812);
    assert.equal(forgedTemplate.kind, "command-observation-received");
    if (forgedTemplate.kind === "command-observation-received") {
      const forged = stimulusCapsule.decode(Object.freeze({
        ...forgedTemplate,
        actionId: command.actionId,
        commandId: command.commandId,
        observation: scenario.commit.record.commandArtifact,
        observationDigest: scenario.commit.record.commandArtifact.digest,
        observationPayload: Object.freeze({ kind: "command-observed-v2" }),
        pages: Object.freeze([]),
        runId: scenario.genesis.runId,
      }));
      assert.equal(forged.kind, "ok");
      if (forged.kind === "ok") {
        const rejected = await opened.loop.ingest(forged.value);
        assert.equal(rejected.kind, "feedback");
        if (rejected.kind === "feedback") assert.match(rejected.diagnostic, /private dispatcher sink/);
      }
    }
    await opened.loop.close();
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
