import type { RunGenesis } from "../protocol/journal-record.capsule.js";
import type { RunState } from "./run-state.js";

const EMPTY = Object.freeze([]);

/** Build the sole genesis state from the already-decoded journal genesis. */
export function initialState(genesis: RunGenesis): RunState {
  return Object.freeze({
    identity: Object.freeze({
      runId: genesis.runId,
      taskSnapshot: genesis.taskSnapshot,
      repositoryBase: genesis.repositoryBase,
      policyRoot: genesis.policyRoot,
      runtimeRoot: genesis.runtimeRoot,
    }),
    phase: "planning",
    lastSequence: genesis.sequence,
    requirements: null,
    workItems: EMPTY,
    submissions: EMPTY,
    planRoots: EMPTY,
    currentPlanRootId: null,
    supersededPlanRoots: EMPTY,
    coverageLinks: EMPTY,
    findings: EMPTY,
    evidenceRecords: EMPTY,
    candidates: EMPTY,
    currentCandidateId: null,
    publications: EMPTY,
    currentPublicationId: null,
    commandSettlements: EMPTY,
    actionCommits: EMPTY,
    lastDecision: null,
    suspension: Object.freeze({ kind: "active" }),
    terminal: null,
  });
}
