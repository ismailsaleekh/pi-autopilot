import { foldMany } from "../evolution/fold.js";
import type { FoldInput } from "../evolution/fold.js";
import type { FoldResult } from "../evolution/fold-result.js";
import { initialState } from "../model/genesis.js";
import type { RunState } from "../model/run-state.js";
import { mintPreparedCommit } from "../protocol/accepted-batch.js";
import type { PreparedCommit } from "../protocol/accepted-batch.js";
import type { RunGenesis } from "../protocol/journal-record.capsule.js";
import { projectRunState } from "../projection/run-view.js";
import type { RunView } from "../projection/run-view.js";

export { prepare } from "./prepare.js";
export type { PrepareResult } from "./prepare.js";
export type { Feedback, SemanticFeedbackCode } from "./feedback.js";
export type {
  AdmissionResult,
  AdmissionSeams,
  CommitAssemblySeam,
  OutcomeSeam,
  ProposedFacts,
  ReactionResult,
  ReactionSeam,
  SemanticSeams,
} from "./seams.js";

export function initial(genesis: RunGenesis): RunState {
  return initialState(genesis);
}

/** Authority-owned bootstrap mint; storage still accepts only PreparedCommit. */
export function prepareGenesis(genesis: RunGenesis): PreparedCommit {
  const minted = mintPreparedCommit(Object.freeze({ kind: "prepared-genesis", record: genesis }));
  if (minted.kind !== "minted") {
    throw new Error(`run genesis invariant failed: ${minted.error.diagnostic}`);
  }
  return minted.commit;
}

export function replay(state: RunState, batch: readonly FoldInput[]): FoldResult {
  return foldMany(state, batch);
}

export function project(state: RunState): RunView {
  return projectRunState(state);
}
