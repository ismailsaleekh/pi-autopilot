import { foldMany } from "../evolution/fold.js";
import type { FoldInput } from "../evolution/fold.js";
import type { FoldResult } from "../evolution/fold-result.js";
import { initialState } from "../model/genesis.js";
import type { RunState } from "../model/run-state.js";
import type { RunGenesis } from "../protocol/journal-record.capsule.js";
import { projectRunState } from "../projection/run-view.js";
import type { RunView } from "../projection/run-view.js";

export { prepare } from "./prepare.js";
export type { PrepareResult } from "./prepare.js";
export type { Feedback } from "./feedback.js";
export type {
  AdmissionResult,
  AdmissionSeams,
  BatchAssemblySeam,
  OutcomeSeam,
  PreparedSemanticRoots,
  ProposedFacts,
  ReactionResult,
  ReactionSeam,
  SemanticSeams,
} from "./seams.js";

/** Function 1: construct immutable genesis state. */
export function initial(genesis: RunGenesis): RunState {
  return initialState(genesis);
}

/** Function 3: replay an already-decoded committed suffix in one pass. */
export function replay(state: RunState, batch: readonly FoldInput[]): FoldResult {
  return foldMany(state, batch);
}

/** Function 4: build the deletable operator view. */
export function project(state: RunState): RunView {
  return projectRunState(state);
}
