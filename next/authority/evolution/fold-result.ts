import type { JournalRecord } from "../protocol/journal-record.capsule.js";
import type { RunState } from "../model/run-state.js";

export interface FoldError {
  readonly code: string;
  readonly diagnostic: string;
}

export type FoldResult =
  | { readonly kind: "applied"; readonly state: RunState }
  | {
      readonly kind: "rejected";
      readonly state: RunState;
      readonly recordKind: JournalRecord["kind"];
      readonly error: FoldError;
    };
