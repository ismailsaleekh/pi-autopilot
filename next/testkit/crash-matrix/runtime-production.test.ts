import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initial } from "../../authority/facade/index.js";
import { stateDigest } from "../../authority/model/run-state.js";
import { commandCapsule } from "../../authority/protocol/command.capsule.js";
import type { Command } from "../../authority/protocol/command.capsule.js";
import { childObservationCapsule } from "../../ports/contracts/child.capsule.js";
import { evidenceFactCapsule } from "../../authority/protocol/evidence-fact.capsule.js";
import {
  canonicalDecisionFactsDigest,
  journalRecordCapsule,
} from "../../authority/protocol/journal-record.capsule.js";
import { artifactRootSchema } from "../../authority/protocol/identifiers.js";
import type {
  ArtifactRoot,
  Digest,
  RunId,
} from "../../authority/protocol/identifiers.js";
import type { RunGenesis } from "../../authority/protocol/journal-record.capsule.js";
import { defineCapsule } from "../../authority/protocol/schema.js";
import { stimulusCapsule } from "../../authority/protocol/stimulus.capsule.js";
import type { Stimulus } from "../../authority/protocol/stimulus.capsule.js";
import { openCas, putBlob } from "../../storage/cas/index.js";
import type { ContentAddressedStore } from "../../storage/cas/index.js";
import { replayJournal } from "../../storage/journal/index.js";
import type { JournalDurabilityEvent } from "../../storage/journal/index.js";
import {
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_TYPE_RECORD,
} from "../../storage/journal/wire.js";
import { normalizeArtifact } from "../../runtime/artifact-normalization/index.js";
import type { NormalizedArtifact } from "../../runtime/artifact-normalization/index.js";
import {
  decodeEvidenceEnvelopeWire,
  decodePortObservation,
  decodeStimulus,
  inertJsonFromUnknown,
} from "../../runtime/boundary-codecs/index.js";
import {
  openCommitLoop,
} from "../../runtime/commit-loop/index.js";
import type {
  CommandArtifactRepository,
  CommitLoopDependencies,
} from "../../runtime/commit-loop/index.js";
import {
  dispatchCommittedCommands,
} from "../../runtime/dispatcher/index.js";
import type {
  CommandObservationSink,
  DispatcherDependencies,
  RuntimeArtifactRecorder,
  RuntimePortExecutor,
  RuntimePortIntent,
} from "../../runtime/dispatcher/index.js";
import type { RuntimePortName } from "../../runtime/boundary-codecs/index.js";
import { sealSubmission } from "../../runtime/seal/index.js";
import { SimWorld } from "../simulation/sim-world.js";
import { assertTraceEquivalent, SimTrace } from "../simulation/trace.js";

const testArtifactRootCapsule = defineCapsule("RuntimeTestArtifactRoot", artifactRootSchema);

function artifactRootForDigest(digest: Digest): ArtifactRoot {
  const decoded = testArtifactRootCapsule.decode(String(digest));
  if (decoded.kind !== "ok") {
    throw new Error(decoded.error.diagnostic);
  }
  return decoded.value;
}

function commandForRun(kind: Command["kind"], seed: number, runId: RunId): Command {
  const template = commandCapsule.arbitrary.validForKind(kind, seed);
  const encoded = commandCapsule.encodeUnknown(Object.freeze({ ...template, runId }));
  if (encoded.kind === "error") {
    throw new Error(encoded.error.diagnostic);
  }
  const decoded = commandCapsule.decodeCanonical(encoded.value);
  if (decoded.kind !== "ok") {
    throw new Error(decoded.error.diagnostic);
  }
  return decoded.value;
}

function validGenesis(seed: number): RunGenesis {
  const value = journalRecordCapsule.arbitrary.validForKind("run-genesis", seed);
  assert.equal(value.kind, "run-genesis");
  if (value.kind !== "run-genesis") {
    throw new Error("run genesis arbitrary returned the wrong kind");
  }
  return value;
}

function simDispatcher(world: SimWorld, genesis: RunGenesis): DispatcherDependencies {
  const ports: RuntimePortExecutor = Object.freeze({
    dispatch(port: RuntimePortName, intent: RuntimePortIntent) {
      return world.dispatch(port, intent);
    },
  });
  const artifacts: RuntimeArtifactRecorder = Object.freeze({
    record(artifact: NormalizedArtifact, expectedDigest: Digest) {
      const created = world.artifacts.createBlob(artifact.path, artifact.canonicalBytes);
      if (created.kind !== "ok") {
        return null;
      }
      const reference = world.artifacts.reference(created.tree.root, artifact.path);
      return reference === null
        ? null
        : Object.freeze({ kind: "recorded", digest: expectedDigest, reference });
    },
  });
  return Object.freeze({
    ports,
    artifacts,
    repositoryBase: genesis.repositoryBase,
    repositoryIdentity: genesis.taskSnapshot,
    evidenceExecutor: null,
    validationExecutor: null,
    candidateManifest: null,
  });
}

function commandRepository(): CommandArtifactRepository {
  return Object.freeze({
    store(_artifact: NormalizedArtifact, expectedRoot: ArtifactRoot) {
      return Object.freeze({ kind: "stored", root: expectedRoot });
    },
    load(_root: ArtifactRoot) {
      return Object.freeze([]);
    },
  });
}

function bytesStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return Object.freeze({
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      yield bytes.slice();
    },
  });
}

function realEmptyCommandRepository(store: ContentAddressedStore): CommandArtifactRepository {
  return Object.freeze({
    async store(artifact: NormalizedArtifact, expectedRoot: ArtifactRoot) {
      const stored = await putBlob(store, bytesStream(artifact.canonicalBytes));
      if (stored.kind !== "stored" || String(stored.ref.digest) !== String(expectedRoot)) {
        return Object.freeze({
          kind: "feedback",
          disposition: "fatal",
          diagnostic: "real CAS command bytes did not bind to authority commandRoot",
        });
      }
      return Object.freeze({ kind: "stored", root: expectedRoot });
    },
    async load(root: ArtifactRoot) {
      const normalized = normalizeArtifact(Object.freeze([]), "command-batch");
      if (normalized.kind !== "normalized" || String(normalized.artifact.digest) !== String(root)) {
        return Object.freeze({ invalid: true });
      }
      const stored = await putBlob(store, bytesStream(normalized.artifact.canonicalBytes));
      return stored.kind === "stored" && String(stored.ref.digest) === String(root)
        ? Object.freeze([])
        : Object.freeze({ invalid: true });
    },
  });
}

function commitDependencies(
  world: SimWorld,
  genesis: RunGenesis,
  journalOptions: CommitLoopDependencies["journalOptions"],
  commands: CommandArtifactRepository = commandRepository(),
): CommitLoopDependencies {
  return Object.freeze({
    commands,
    dispatcher: simDispatcher(world, genesis),
    journalOptions,
  });
}

function openInput(journalDir: string, genesis: RunGenesis): object {
  return Object.freeze({ journalDir, genesis });
}

async function journalRecords(path: string): Promise<readonly string[]> {
  const replay = replayJournal(path);
  const kinds: string[] = [];
  for await (const record of replay) {
    kinds.push(record.kind);
  }
  const completion = await replay.completion;
  assert.equal(completion.kind, "complete");
  return Object.freeze(kinds);
}

function replayCompletedStimulus(genesis: RunGenesis, seed: number): Stimulus {
  const template = stimulusCapsule.arbitrary.validForKind("run-replay-completed", seed);
  assert.equal(template.kind, "run-replay-completed");
  if (template.kind !== "run-replay-completed") {
    throw new Error("replay-completed arbitrary returned the wrong kind");
  }
  const decoded = stimulusCapsule.decode(Object.freeze({
    ...template,
    lastSequence: genesis.sequence,
    runId: genesis.runId,
    stateDigest: stateDigest(initial(genesis)),
  }));
  if (decoded.kind !== "ok") {
    throw new Error(decoded.error.diagnostic);
  }
  assert.equal(decoded.kind, "ok");
  return decoded.value;
}

async function semanticJournalTrace(path: string): Promise<SimTrace> {
  const trace = new SimTrace();
  const replay = replayJournal(path);
  for await (const record of replay) {
    trace.append(
      0,
      "semantic",
      "production-commit-loop",
      "journal-record",
      record.kind === "run-genesis"
        ? `record:${String(record.sequence)}:${record.kind}:${record.runId}`
        : `record:${String(record.sequence)}:${record.kind}:${record.actionId}`,
      Object.freeze({ record }),
    );
  }
  const completion = await replay.completion;
  assert.equal(completion.kind, "complete");
  return trace;
}

function lazyDeepObject(depth: number): object {
  const target = Object.create(null);
  return new Proxy(target, Object.freeze({
    getPrototypeOf(): null {
      return null;
    },
    ownKeys(): readonly string[] {
      return Object.freeze(["next"]);
    },
    getOwnPropertyDescriptor(_target: object, property: string | symbol): PropertyDescriptor | undefined {
      return property === "next"
        ? Object.freeze({
            configurable: true,
            enumerable: true,
            value: depth === 1_000_000 ? 0 : lazyDeepObject(depth + 1),
            writable: false,
          })
        : undefined;
    },
  }));
}

test("boundary codecs contain hostile JavaScript values and preserve valid stimuli", () => {
  const valid = stimulusCapsule.arbitrary.validForKind("submission-ready", 501);
  const decoded = decodeStimulus(valid);
  assert.equal(decoded.kind, "ok");

  let getterReads = 0;
  const poisonedGetter = Object.create(null, {
    kind: Object.freeze({
      enumerable: true,
      get(): string {
        getterReads += 1;
        throw new Error("poisoned getter");
      },
    }),
  });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const throwingKeys = new Proxy(Object.freeze({}), Object.freeze({
    ownKeys(): never {
      throw new Error("ownKeys trap");
    },
  }));
  const mutatingGetterTarget: { changed?: boolean } = {};
  Object.defineProperty(mutatingGetterTarget, "value", Object.freeze({
    enumerable: true,
    get(): number {
      mutatingGetterTarget.changed = true;
      return 1;
    },
  }));
  const revoked = Proxy.revocable(Object.freeze({}), Object.freeze({}));
  revoked.revoke();
  const garbage: readonly unknown[] = Object.freeze([
    poisonedGetter,
    cyclic,
    throwingKeys,
    mutatingGetterTarget,
    revoked.proxy,
    1n,
    Symbol("hostile"),
    () => 1,
  ]);
  for (const value of garbage) {
    assert.doesNotThrow(() => decodeStimulus(value));
    assert.equal(decodeStimulus(value).kind, "feedback");
    assert.doesNotThrow(() => inertJsonFromUnknown(value));
  }
  assert.equal(getterReads, 0, "boundary capture must never invoke accessors");
  assert.equal(mutatingGetterTarget.changed, undefined, "getter mutation must remain inert");

  const deepObject = inertJsonFromUnknown(lazyDeepObject(0));
  assert.equal(deepObject.kind, "feedback");
  if (deepObject.kind === "feedback") {
    assert.equal(deepObject.code, "boundary-limit");
  }

  const millionDeepPrefix = Buffer.alloc(1_000_001, "[".charCodeAt(0));
  millionDeepPrefix[millionDeepPrefix.length - 1] = "0".charCodeAt(0);
  assert.doesNotThrow(() => decodeStimulus(millionDeepPrefix));
  assert.equal(decodeStimulus(millionDeepPrefix).kind, "feedback");
});

test("artifact normalization is canonical, strict, and command-kind independent", () => {
  const command = commandCapsule.arbitrary.validForKind("prepare-workspace", 601);
  const first = normalizeArtifact(Object.freeze([command]), "command-batch");
  const second = normalizeArtifact(Object.freeze([command]), "command-batch");
  assert.equal(first.kind, "normalized");
  assert.equal(second.kind, "normalized");
  if (first.kind === "normalized" && second.kind === "normalized") {
    assert.equal(first.artifact.digest, second.artifact.digest);
    assert.deepEqual(first.artifact.canonicalBytes, second.artifact.canonicalBytes);
  }
  assert.equal(normalizeArtifact(Object.freeze({ unexpected: true }), "command-batch").kind, "feedback");
  assert.equal(normalizeArtifact(command, "not-a-kind").kind, "feedback");
});

test("dispatcher constructs evidence identity and bindings from the committed command", async () => {
  const world = new SimWorld(701);
  const genesis = validGenesis(701);
  const command = commandCapsule.arbitrary.validForKind("execute-evidence", 702);
  const fact = evidenceFactCapsule.arbitrary.validForKind("evidence-fact", 703);
  assert.equal(command.kind, "execute-evidence");
  assert.equal(fact.kind, "evidence-fact");
  if (command.kind !== "execute-evidence" || fact.kind !== "evidence-fact") {
    return;
  }
  const recorded: NormalizedArtifact[] = [];
  const base = simDispatcher(world, genesis);
  const dependencies: DispatcherDependencies = Object.freeze({
    ...base,
    artifacts: Object.freeze({
      record(artifact: NormalizedArtifact, expectedDigest: Digest) {
        recorded.push(artifact);
        return base.artifacts.record(artifact, expectedDigest);
      },
    }),
    evidenceExecutor: Object.freeze({
      execute() {
        return Object.freeze({
          attemptId: fact.envelope.attemptId,
          cwd: fact.envelope.cwd,
          environment: fact.envelope.environment,
          exit: fact.envelope.exit,
          kindId: fact.envelope.kindId,
          output: fact.envelope.output,
        });
      },
    }),
  });
  const submitted: Stimulus[] = [];
  const result = await dispatchCommittedCommands(
    Object.freeze([command]),
    dependencies,
    Object.freeze({ submit(stimulus: Stimulus) { submitted.push(stimulus); } }),
  );
  assert.equal(result.kind, "dispatched");
  assert.equal(recorded.length, 1);
  const artifact = recorded[0];
  assert.notEqual(artifact, undefined);
  if (artifact !== undefined) {
    const envelope = decodeEvidenceEnvelopeWire(artifact.canonicalBytes);
    assert.equal(envelope.kind, "ok");
    if (envelope.kind === "ok") {
      assert.equal(envelope.value.actionId, command.actionId);
      assert.deepEqual(envelope.value.command, command.commandSpec);
      assert.equal(envelope.value.runId, command.runId);
      assert.equal(envelope.value.tree, command.candidateTree);
      assert.equal(envelope.value.workItemId, command.workItemId);
      assert.notEqual(envelope.value.evidenceId, fact.envelope.evidenceId);
    }
  }
  assert.equal(submitted.length, 1);
});

test("seal captures immutable CAS roots without content validation or mutable reread", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-seal-"));
  try {
    const cas = await openCas(join(root, "cas"));
    assert.equal(cas.kind, "opened");
    if (cas.kind !== "opened") {
      return;
    }
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "hostile.bin"), Buffer.from([0, 255, 1, 2]));
    const template = stimulusCapsule.arbitrary.validForKind("submission-ready", 801);
    assert.equal(template.kind, "submission-ready");
    if (template.kind !== "submission-ready") {
      return;
    }
    const request = Object.freeze({
      actionId: template.actionId,
      attemptId: template.attemptId,
      inputRoot: template.inputRoot,
      kind: "seal-submission",
      planRootId: template.planRootId,
      runId: template.runId,
      sourceDirectory: workspace,
      workItemId: template.workItemId,
    });
    const first = await sealSubmission(request, cas.store);
    const duplicate = await sealSubmission(request, cas.store);
    assert.equal(first.kind, "sealed");
    assert.equal(duplicate.kind, "sealed");
    if (first.kind === "sealed" && duplicate.kind === "sealed") {
      assert.equal(first.stimulus.outputRoot, duplicate.stimulus.outputRoot);
      assert.equal(duplicate.alreadyPresent, true);
      const sealedRoot = first.stimulus.outputRoot;
      await writeFile(join(workspace, "hostile.bin"), Buffer.from([9, 9, 9]));
      assert.equal(first.stimulus.outputRoot, sealedRoot, "mutable writes cannot change the captured binding");
      const changed = await sealSubmission(request, cas.store);
      assert.equal(changed.kind, "sealed");
      if (changed.kind === "sealed") {
        assert.notEqual(changed.stimulus.outputRoot, sealedRoot);
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("dispatcher exhaustively handles all seven committed command kinds through SimWorld", async () => {
  const world = new SimWorld(0x5a5a);
  const genesis = validGenesis(901);
  const dependencies = simDispatcher(world, genesis);
  const submitted: Stimulus[] = [];
  const sink: CommandObservationSink = Object.freeze({
    submit(stimulus: Stimulus) {
      submitted.push(stimulus);
    },
  });
  const kinds = Object.freeze([
    "prepare-workspace",
    "launch-child",
    "inspect-child",
    "execute-evidence",
    "execute-validation-rule",
    "build-integrated-candidate",
    "publish-compare-and-swap",
  ]);
  const commands = kinds.map((kind, index) => commandCapsule.arbitrary.validForKind(kind, 1000 + index));
  const result = await dispatchCommittedCommands(Object.freeze(commands), dependencies, sink);
  assert.equal(result.kind, "dispatched");
  if (result.kind === "dispatched") {
    assert.equal(result.reports.length, 7);
    assert.equal(result.reports.every((report) => report.kind === "observation-submitted"), true);
  }
  assert.equal(submitted.length, 7);
  for (const stimulus of submitted) {
    assert.equal(stimulus.kind, "command-observation-received");
    assert.equal(decodeStimulus(stimulus).kind, "ok");
  }
});

test("dispatcher rejects mismatched observation variants and unbound recorder receipts", async () => {
  const world = new SimWorld(1041);
  const genesis = validGenesis(1041);
  const command = commandCapsule.arbitrary.validForKind("inspect-child", 1042);
  assert.equal(command.kind, "inspect-child");
  if (command.kind !== "inspect-child") {
    return;
  }
  const wrong = childObservationCapsule.arbitrary.validForKind("child-session-launched", 1043);
  assert.equal(wrong.kind, "child-session-launched");
  if (wrong.kind !== "child-session-launched") {
    return;
  }
  const recorded: NormalizedArtifact[] = [];
  const base = simDispatcher(world, genesis);
  const dependencies: DispatcherDependencies = Object.freeze({
    ...base,
    ports: Object.freeze({
      dispatch(_port: RuntimePortName, intent: RuntimePortIntent) {
        const encoded = childObservationCapsule.encodeUnknown(Object.freeze({
          ...wrong,
          actionId: intent.actionId,
          runId: intent.runId,
        }));
        if (encoded.kind === "error") {
          return Object.freeze({ kind: "rejected" });
        }
        const decoded = childObservationCapsule.decodeCanonical(encoded.value);
        return decoded.kind === "ok"
          ? Object.freeze({ kind: "observation", observation: decoded.value })
          : Object.freeze({ kind: "rejected" });
      },
    }),
    artifacts: Object.freeze({
      record(artifact: NormalizedArtifact, expectedDigest: Digest) {
        recorded.push(artifact);
        const reference = world.artifacts.createBlob(artifact.path, artifact.canonicalBytes);
        if (reference.kind !== "ok") {
          return null;
        }
        const artifactReference = world.artifacts.reference(reference.tree.root, artifact.path);
        return artifactReference === null
          ? null
          : Object.freeze({
              kind: "recorded",
              digest: expectedDigest,
              reference: artifactReference,
            });
      },
    }),
  });
  const submitted: Stimulus[] = [];
  const result = await dispatchCommittedCommands(
    Object.freeze([command]),
    dependencies,
    Object.freeze({ submit(stimulus: Stimulus) { submitted.push(stimulus); } }),
  );
  assert.equal(result.kind, "dispatched");
  assert.equal(recorded.length, 1);
  const observed = recorded[0];
  assert.notEqual(observed, undefined);
  if (observed !== undefined) {
    const decoded = decodePortObservation(observed.canonicalBytes, "child");
    assert.equal(decoded.kind, "ok");
    if (decoded.kind === "ok") {
      assert.equal(decoded.value.kind, "child-session-inspected");
      assert.equal(decoded.value.result.kind, "retry");
    }
  }
  assert.equal(submitted.length, 1);

  const wrongNormalized = normalizeArtifact(Object.freeze([]), "command-batch");
  assert.equal(wrongNormalized.kind, "normalized");
  if (wrongNormalized.kind !== "normalized") {
    return;
  }
  const mismatchedRecorder: DispatcherDependencies = Object.freeze({
    ...simDispatcher(new SimWorld(1044), genesis),
    artifacts: Object.freeze({
      record(artifact: NormalizedArtifact) {
        const created = world.artifacts.createBlob(artifact.path, artifact.canonicalBytes);
        if (created.kind !== "ok") {
          return null;
        }
        const reference = world.artifacts.reference(created.tree.root, artifact.path);
        return reference === null
          ? null
          : Object.freeze({
              kind: "recorded",
              digest: wrongNormalized.artifact.digest,
              reference,
            });
      },
    }),
  });
  const rejectedSink: Stimulus[] = [];
  const recorderResult = await dispatchCommittedCommands(
    Object.freeze([command]),
    mismatchedRecorder,
    Object.freeze({ submit(stimulus: Stimulus) { rejectedSink.push(stimulus); } }),
  );
  assert.equal(recorderResult.kind, "dispatched");
  if (recorderResult.kind === "dispatched") {
    assert.equal(recorderResult.reports[0]?.kind, "feedback");
  }
  assert.equal(rejectedSink.length, 0);
});

test("post-dispatch pre-observation interruption replays the same port action identity", async () => {
  const genesis = validGenesis(1051);
  const command = commandCapsule.arbitrary.validForKind("inspect-child", 1052);

  const tracedDependencies = (world: SimWorld): DispatcherDependencies => {
    const base = simDispatcher(world, genesis);
    const artifacts: RuntimeArtifactRecorder = Object.freeze({
      async record(artifact: NormalizedArtifact, expectedDigest: Digest) {
        world.trace.append(
          world.clock.now(),
          "semantic",
          "production-dispatcher",
          "observation-recorded",
          `observation:${artifact.digest}`,
          Object.freeze({ digest: artifact.digest, kind: artifact.kind }),
        );
        return base.artifacts.record(artifact, expectedDigest);
      },
    });
    return Object.freeze({ ...base, artifacts });
  };

  const baselineWorld = new SimWorld(1051);
  const baselineSink: CommandObservationSink = Object.freeze({
    submit(_stimulus: Stimulus) {
      return undefined;
    },
  });
  const baseline = await dispatchCommittedCommands(
    Object.freeze([command]),
    tracedDependencies(baselineWorld),
    baselineSink,
  );
  assert.equal(baseline.kind, "dispatched");

  const faultedWorld = new SimWorld(1051);
  let interrupted = false;
  const interruptedSink: CommandObservationSink = Object.freeze({
    submit(_stimulus: Stimulus) {
      interrupted = true;
      throw new Error("injected loss before observation commit");
    },
  });
  const first = await dispatchCommittedCommands(
    Object.freeze([command]),
    tracedDependencies(faultedWorld),
    interruptedSink,
  );
  assert.equal(first.kind, "dispatched");
  assert.equal(interrupted, true);
  const restartedWorld = faultedWorld.restart();
  const resumed = await dispatchCommittedCommands(
    Object.freeze([command]),
    tracedDependencies(restartedWorld),
    baselineSink,
  );
  assert.equal(resumed.kind, "dispatched");
  assert.equal(assertTraceEquivalent(baselineWorld.trace, restartedWorld.trace).kind, "equivalent");
});

test("real commit loop persists genesis, contains malformed input, and resumes current facade feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-loop-"));
  try {
    const journalDir = join(root, "journal");
    const genesis = validGenesis(1101);
    const world = new SimWorld(1101);
    const first = await openCommitLoop(
      openInput(journalDir, genesis),
      commitDependencies(world, genesis, undefined),
    );
    assert.equal(first.kind, "opened");
    if (first.kind !== "opened") {
      return;
    }
    assert.deepEqual(await journalRecords(journalDir), ["run-genesis"]);
    const revoked = Proxy.revocable(Object.freeze({}), Object.freeze({}));
    revoked.revoke();
    const malformed = await first.loop.ingest(revoked.proxy);
    assert.equal(malformed.kind, "feedback");

    const stimulusTemplate = stimulusCapsule.arbitrary.validForKind("submission-ready", 1102);
    assert.equal(stimulusTemplate.kind, "submission-ready");
    if (stimulusTemplate.kind === "submission-ready") {
      const stimulus = stimulusCapsule.decode(Object.freeze({
        ...stimulusTemplate,
        runId: genesis.runId,
      }));
      assert.equal(stimulus.kind, "ok");
      if (stimulus.kind === "ok") {
        const result = await first.loop.ingest(stimulus.value);
        assert.equal(result.kind, "feedback");
        if (result.kind === "feedback") {
          assert.equal(result.source, "authority");
          assert.ok(result.diagnostic.length > 0);
        }
      }
    }
    await first.loop.close();

    const restarted = await openCommitLoop(
      openInput(journalDir, genesis),
      commitDependencies(world, genesis, undefined),
    );
    assert.equal(restarted.kind, "opened");
    if (restarted.kind === "opened") {
      assert.equal(restarted.loop.view().lastSequence, genesis.sequence);
      await restarted.loop.close();
    }
    assert.deepEqual(await journalRecords(journalDir), ["run-genesis"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepted no-effect decision is CAS-first, journal-idempotent, and replay-derived", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-idempotent-"));
  try {
    const cas = await openCas(join(root, "cas"));
    assert.equal(cas.kind, "opened");
    if (cas.kind !== "opened") {
      return;
    }
    const genesis = validGenesis(1151);
    const world = new SimWorld(1151);
    const stimulus = replayCompletedStimulus(genesis, 1152);
    const dependencies = commitDependencies(
      world,
      genesis,
      undefined,
      realEmptyCommandRepository(cas.store),
    );
    const opened = await openCommitLoop(openInput(join(root, "journal"), genesis), dependencies);
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") {
      return;
    }
    const accepted = await opened.loop.ingest(stimulus);
    assert.equal(accepted.kind, "accepted");
    const duplicate = await opened.loop.ingest(stimulus);
    assert.equal(duplicate.kind, "already-committed");
    await opened.loop.close();
    assert.deepEqual(await journalRecords(join(root, "journal")), ["run-genesis", "decision-committed"]);

    const restarted = await openCommitLoop(openInput(join(root, "journal"), genesis), dependencies);
    assert.equal(restarted.kind, "opened");
    if (restarted.kind === "opened") {
      assert.equal(restarted.loop.view().lastSequence, genesis.sequence + 1);
      const replayDuplicate = await restarted.loop.ingest(stimulus);
      assert.equal(replayDuplicate.kind, "already-committed");
      await restarted.loop.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reconciliation verifies command roots, deduplicates actions, and services duplicate ingest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-reconcile-"));
  try {
    const journalDir = join(root, "journal");
    const genesis = validGenesis(1161);
    const command = commandForRun("inspect-child", 1162, genesis.runId);
    const normalized = normalizeArtifact(Object.freeze([command]), "command-batch");
    assert.equal(normalized.kind, "normalized");
    if (normalized.kind !== "normalized") {
      return;
    }
    const commandRoot = artifactRootForDigest(normalized.artifact.digest);
    const factRoot = artifactRootForDigest(canonicalDecisionFactsDigest(Object.freeze([])));
    const firstStimulus = stimulusCapsule.arbitrary.validForKind("run-replay-completed", 1163);
    const secondStimulus = stimulusCapsule.arbitrary.validForKind("run-replay-completed", 1164);
    assert.equal(firstStimulus.kind, "run-replay-completed");
    assert.equal(secondStimulus.kind, "run-replay-completed");
    if (firstStimulus.kind !== "run-replay-completed" || secondStimulus.kind !== "run-replay-completed") {
      return;
    }
    const firstDecision = journalRecordCapsule.decode(Object.freeze({
      actionId: firstStimulus.actionId,
      commandRoot,
      factRoot,
      facts: Object.freeze([]),
      kind: "decision-committed",
      runId: genesis.runId,
      sequence: genesis.sequence + 1,
      stimulusDigest: stimulusCapsule.digest(firstStimulus),
    }));
    const secondDecision = journalRecordCapsule.decode(Object.freeze({
      actionId: secondStimulus.actionId,
      commandRoot,
      factRoot,
      facts: Object.freeze([]),
      kind: "decision-committed",
      runId: genesis.runId,
      sequence: genesis.sequence + 2,
      stimulusDigest: stimulusCapsule.digest(secondStimulus),
    }));
    assert.equal(firstDecision.kind, "ok");
    assert.equal(secondDecision.kind, "ok");
    if (
      firstDecision.kind !== "ok"
      || firstDecision.value.kind !== "decision-committed"
      || secondDecision.kind !== "ok"
      || secondDecision.value.kind !== "decision-committed"
    ) {
      return;
    }
    // The frozen authority cannot currently issue a nonempty command batch.
    // Seed a canonical read-only replay fixture without adding a second
    // appendCommittedBatch capability edge outside the production commit loop.
    const seedWorld = new SimWorld(1160);
    const initialized = await openCommitLoop(
      openInput(journalDir, genesis),
      commitDependencies(seedWorld, genesis, undefined),
    );
    assert.equal(initialized.kind, "opened");
    if (initialized.kind !== "opened") {
      return;
    }
    await initialized.loop.close();
    const segmentNames = await readdir(join(journalDir, "segments"));
    assert.equal(segmentNames.length, 1);
    const segmentName = segmentNames[0];
    assert.notEqual(segmentName, undefined);
    if (segmentName === undefined) {
      return;
    }
    const segmentPath = join(journalDir, "segments", segmentName);
    const genesisFrame = await readFile(segmentPath);
    assert.equal(genesisFrame[40], FRAME_TYPE_RECORD);
    assert.equal(
      genesisFrame.byteLength,
      FRAME_HEADER_BYTES + genesisFrame.readUInt32BE(0),
      "fixture starts from exactly one selected genesis frame",
    );
    const firstFrame = encodeFrame(
      genesisFrame.subarray(8, 40),
      FRAME_TYPE_RECORD,
      journalRecordCapsule.encode(firstDecision.value),
    );
    const secondFrame = encodeFrame(
      firstFrame.chainHash,
      FRAME_TYPE_RECORD,
      journalRecordCapsule.encode(secondDecision.value),
    );
    await appendFile(segmentPath, Buffer.concat([firstFrame.bytes, secondFrame.bytes]));

    const world = new SimWorld(1161);
    const base = simDispatcher(world, genesis);
    let portCalls = 0;
    const dispatcher: DispatcherDependencies = Object.freeze({
      ...base,
      ports: Object.freeze({
        dispatch(port: RuntimePortName, intent: RuntimePortIntent) {
          portCalls += 1;
          return base.ports.dispatch(port, intent);
        },
      }),
    });
    const repository: CommandArtifactRepository = Object.freeze({
      store(_artifact: NormalizedArtifact, expectedRoot: ArtifactRoot) {
        return Object.freeze({ kind: "stored", root: expectedRoot });
      },
      load(rootValue: ArtifactRoot) {
        return rootValue === commandRoot ? Object.freeze([command]) : Object.freeze({ missing: true });
      },
    });
    const dependencies: CommitLoopDependencies = Object.freeze({
      commands: repository,
      dispatcher,
      journalOptions: undefined,
    });
    const opened = await openCommitLoop(openInput(journalDir, genesis), dependencies);
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") {
      return;
    }
    assert.equal(opened.reconciliation.kind, "dispatched");
    assert.equal(portCalls, 1, "two committed occurrences of one action reconcile once");

    const duplicateStimulus = stimulusCapsule.decode(Object.freeze({
      ...firstStimulus,
      runId: genesis.runId,
    }));
    assert.equal(duplicateStimulus.kind, "ok");
    if (duplicateStimulus.kind === "ok") {
      const duplicate = await opened.loop.ingest(duplicateStimulus.value);
      assert.equal(duplicate.kind, "already-committed");
      if (duplicate.kind === "already-committed") {
        assert.equal(duplicate.dispatch.kind, "dispatched");
      }
      assert.equal(portCalls, 2, "duplicate ingest services pending reconciliation outside the commit queue");
    }
    await opened.loop.close();

    const corrupt = await openCommitLoop(
      openInput(journalDir, genesis),
      Object.freeze({
        ...dependencies,
        commands: Object.freeze({
          store: repository.store,
          load() {
            return Object.freeze([]);
          },
        }),
      }),
    );
    assert.equal(corrupt.kind, "opened");
    if (corrupt.kind === "opened") {
      assert.equal(corrupt.reconciliation.kind, "fatal");
      assert.equal(portCalls, 2, "substituted command bytes never dispatch");
      await corrupt.loop.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("expressible no-effect transaction windows converge to the uninterrupted journal trace", async () => {
  const baselineRoot = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-baseline-"));
  const crashRoots: string[] = [];
  try {
    const baselineCas = await openCas(join(baselineRoot, "cas"));
    assert.equal(baselineCas.kind, "opened");
    if (baselineCas.kind !== "opened") {
      return;
    }
    const genesis = validGenesis(1171);
    const stimulus = replayCompletedStimulus(genesis, 1172);
    const baselineWorld = new SimWorld(1171);
    const baselineDependencies = commitDependencies(
      baselineWorld,
      genesis,
      undefined,
      realEmptyCommandRepository(baselineCas.store),
    );
    const baseline = await openCommitLoop(
      openInput(join(baselineRoot, "journal"), genesis),
      baselineDependencies,
    );
    assert.equal(baseline.kind, "opened");
    if (baseline.kind !== "opened") {
      return;
    }
    assert.equal((await baseline.loop.ingest(stimulus)).kind, "accepted");
    await baseline.loop.close();
    const expectedTrace = await semanticJournalTrace(join(baselineRoot, "journal"));

    for (const crashCase of Object.freeze(["pre-prepare", "post-prepare", "mid-append", "post-append"])) {
      const caseRoot = await mkdtemp(join(tmpdir(), `pi-autopilot-runtime-${crashCase}-`));
      crashRoots.push(caseRoot);
      const cas = await openCas(join(caseRoot, "cas"));
      assert.equal(cas.kind, "opened");
      if (cas.kind !== "opened") {
        continue;
      }
      const world = new SimWorld(1171);
      const baseCommands = realEmptyCommandRepository(cas.store);
      let commandStoreInterrupted = crashCase === "post-prepare";
      const commands: CommandArtifactRepository = Object.freeze({
        async store(artifact: NormalizedArtifact, expectedRoot: ArtifactRoot) {
          if (commandStoreInterrupted) {
            commandStoreInterrupted = false;
            return Object.freeze({
              kind: "feedback",
              disposition: "resume",
              diagnostic: "injected process loss after prepare and before append",
            });
          }
          return baseCommands.store(artifact, expectedRoot);
        },
        load(root: ArtifactRoot) {
          return baseCommands.load(root);
        },
      });
      let recordPointOccurrences = 0;
      let journalInterrupted = false;
      const targetPoint = crashCase === "mid-append"
        ? "frame-mid-write"
        : crashCase === "post-append"
          ? "frame-datasynced"
          : null;
      const options = targetPoint === null
        ? undefined
        : Object.freeze({
            durabilityObserver(event: JournalDurabilityEvent) {
              if (event.point === targetPoint && event.frameType === "record") {
                recordPointOccurrences += 1;
                if (recordPointOccurrences === 2 && !journalInterrupted) {
                  journalInterrupted = true;
                  throw new Error(`injected ${crashCase}`);
                }
              }
            },
          });
      const dependencies = commitDependencies(world, genesis, options, commands);
      let opened = await openCommitLoop(openInput(join(caseRoot, "journal"), genesis), dependencies);
      assert.equal(opened.kind, "opened", crashCase);
      if (opened.kind !== "opened") {
        continue;
      }
      if (crashCase === "pre-prepare") {
        const revoked = Proxy.revocable(Object.freeze({}), Object.freeze({}));
        revoked.revoke();
        assert.equal((await opened.loop.ingest(revoked.proxy)).kind, "feedback");
        await opened.loop.close();
        opened = await openCommitLoop(openInput(join(caseRoot, "journal"), genesis), dependencies);
        assert.equal(opened.kind, "opened");
        if (opened.kind !== "opened") {
          continue;
        }
      }
      const firstAttempt = await opened.loop.ingest(stimulus);
      if (crashCase === "post-prepare") {
        assert.equal(firstAttempt.kind, "resume");
        await opened.loop.close();
        opened = await openCommitLoop(openInput(join(caseRoot, "journal"), genesis), dependencies);
        assert.equal(opened.kind, "opened");
        if (opened.kind !== "opened") {
          continue;
        }
        assert.equal((await opened.loop.ingest(stimulus)).kind, "accepted");
      } else if (crashCase === "mid-append") {
        assert.equal(journalInterrupted, true);
        assert.equal(firstAttempt.kind, "resume");
        assert.equal((await opened.loop.ingest(stimulus)).kind, "accepted");
      } else if (crashCase === "post-append") {
        assert.equal(journalInterrupted, true);
        assert.equal(firstAttempt.kind, "already-committed");
      } else {
        assert.equal(firstAttempt.kind, "accepted");
      }
      await opened.loop.close();
      const actualTrace = await semanticJournalTrace(join(caseRoot, "journal"));
      assert.equal(assertTraceEquivalent(expectedTrace, actualTrace).kind, "equivalent", crashCase);
    }
  } finally {
    await rm(baselineRoot, { force: true, recursive: true });
    for (const root of crashRoots) {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("post-fdatasync uncertainty replays one durable genesis through a successor epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-autopilot-runtime-uncertain-"));
  try {
    const journalDir = join(root, "journal");
    const genesis = validGenesis(1201);
    const world = new SimWorld(1201);
    let injected = false;
    const uncertain = await openCommitLoop(
      openInput(journalDir, genesis),
      commitDependencies(world, genesis, Object.freeze({
        durabilityObserver(event: JournalDurabilityEvent) {
          if (!injected && event.point === "frame-datasynced" && event.frameType === "record") {
            injected = true;
            throw new Error("simulated process loss after fdatasync");
          }
        },
      })),
    );
    assert.equal(injected, true);
    assert.equal(uncertain.kind, "resume");

    const resumed = await openCommitLoop(
      openInput(journalDir, genesis),
      commitDependencies(world, genesis, undefined),
    );
    assert.equal(resumed.kind, "opened");
    if (resumed.kind === "opened") {
      assert.equal(resumed.loop.view().lastSequence, genesis.sequence);
      await resumed.loop.close();
    }
    assert.deepEqual(await journalRecords(journalDir), ["run-genesis"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("commit loop is mechanically domain-blind and owns the sole append call", async () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const nextRoot = resolve(directory, "../../..");
  const source = await readFile(join(nextRoot, "runtime", "commit-loop", "index.ts"), "utf8");
  const forbidden = Object.freeze([
    "artifactKind",
    "roleId",
    "finding",
    "outcome",
    "planning-gap",
    "definition-of-done",
    "advisory",
    "integrity",
    "t1",
    "t2",
  ]);
  for (const term of forbidden) {
    assert.equal(source.includes(term), false, `domain term leaked into commit-loop: ${term}`);
  }
  assert.equal((source.match(/appendCommittedBatch\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/from\s+"\.\.\/\.\.\/storage\/journal\/index\.js"/g) ?? []).length, 1);
});
