import { initial, prepare, replay } from "../../authority/facade/index.js";
import type { PreparedCommit } from "../../authority/protocol/accepted-batch.js";
import { decimalNatural } from "../../authority/protocol/identifiers.js";
import type { RunGenesis } from "../../authority/protocol/journal-record.capsule.js";
import { journalRecordCapsule } from "../../authority/protocol/journal-record.capsule.js";
import { stimulusCapsule } from "../../authority/protocol/stimulus.capsule.js";
import type { BoundaryRequestReceived, Stimulus } from "../../authority/protocol/stimulus.capsule.js";
import { workItemCapsule } from "../../authority/protocol/work-item.capsule.js";
import type { RunState } from "../../authority/model/run-state.js";

export function scenarioGenesis(seed: number): RunGenesis {
  const value = journalRecordCapsule.arbitrary.validForKind("run-genesis", seed);
  return value.kind === "run-genesis" ? value : scenarioGenesis(seed + 1);
}

export function decodeScenarioStimulus(input: unknown): Stimulus {
  const encoded = stimulusCapsule.encodeUnknown(input);
  if (encoded.kind === "error") throw new Error(encoded.error.diagnostic);
  const decoded = stimulusCapsule.decodeCanonical(encoded.value);
  if (decoded.kind === "error") throw new Error(decoded.error.diagnostic);
  return decoded.value;
}

export function declaredWorkStimulus(state: RunState, seed: number): BoundaryRequestReceived {
  const stimulus = stimulusCapsule.arbitrary.validForKind("boundary-request-received", seed);
  if (stimulus.kind !== "boundary-request-received") throw new Error("arbitrary stimulus family mismatch");
  const generated = workItemCapsule.arbitrary.validForKind("produce-artifact", seed + 1);
  if (generated.kind !== "produce-artifact") throw new Error("arbitrary work family mismatch");
  const topologicalRank = decimalNatural(String(seed + 1)) ?? generated.topologicalRank;
  const workItem = Object.freeze({
    ...generated,
    runId: state.identity.runId,
    taskRoot: state.identity.taskSnapshot,
    topologicalRank,
  });
  const decoded = decodeScenarioStimulus(Object.freeze({
    ...stimulus,
    actionId: stimulus.actionId,
    pages: Object.freeze([]),
    requestDigest: stimulus.request.digest,
    requestPayload: Object.freeze({ kind: "declare-work-v2", workItem }),
    runId: state.identity.runId,
  }));
  if (decoded.kind !== "boundary-request-received") throw new Error("scenario stimulus family mismatch");
  return decoded;
}

export function prepareScenarioCommit(state: RunState, stimulus: Stimulus): PreparedCommit {
  const prepared = prepare(state, stimulus);
  if (prepared.kind === "feedback") throw new Error(`${prepared.code}: ${prepared.diagnostic}`);
  return prepared;
}

export function applyScenarioCommit(state: RunState, commit: PreparedCommit): RunState {
  const applied = replay(state, Object.freeze([commit.record]));
  if (applied.kind !== "applied") throw new Error(`${applied.error.code}: ${applied.error.diagnostic}`);
  return applied.state;
}

export function nonemptyScenario(seed: number): Readonly<{
  readonly genesis: RunGenesis;
  readonly initialState: RunState;
  readonly stimulus: BoundaryRequestReceived;
  readonly commit: PreparedCommit;
  readonly state: RunState;
}> {
  const genesis = scenarioGenesis(seed);
  const initialState = initial(genesis);
  const stimulus = declaredWorkStimulus(initialState, seed + 10);
  const commit = prepareScenarioCommit(initialState, stimulus);
  if (commit.record.kind !== "decision-committed" || commit.record.facts.length === 0 || commit.record.commands.length === 0) throw new Error("scenario must commit facts and commands");
  const state = applyScenarioCommit(initialState, commit);
  return Object.freeze({ genesis, initialState, stimulus, commit, state });
}
