import { initialState } from "../model/genesis.js";
import type {
  ActionCommitState,
  CommandSettlementState,
  RunState,
} from "../model/run-state.js";
import {
  canonicalDecisionFactsDigest,
} from "../protocol/journal-record.capsule.js";
import type {
  DecisionCommitted,
  JournalRecord,
  RunGenesis,
} from "../protocol/journal-record.capsule.js";
import { foldDomainFact } from "./domain-fact-fold.js";
import type { FoldError, FoldResult } from "./fold-result.js";

export type FoldInput = JournalRecord;

function rejected(state: RunState, record: JournalRecord, error: FoldError): FoldResult {
  return Object.freeze({
    kind: "rejected",
    state,
    recordKind: record.kind,
    error: Object.freeze(error),
  });
}

function applied(state: RunState): FoldResult {
  return Object.freeze({ kind: "applied", state });
}

function validateEnvelope(state: RunState, record: JournalRecord): FoldResult | null {
  if (state.terminal !== null) {
    return rejected(state, record, { code: "post-terminal" });
  }
  if (record.runId !== state.identity.runId) {
    return rejected(state, record, {
      code: "run-mismatch",
      expectedRunId: state.identity.runId,
      actualRunId: record.runId,
    });
  }
  if (record.sequence === state.lastSequence) {
    return rejected(state, record, {
      code: "duplicate-sequence",
      sequence: record.sequence,
    });
  }
  if (record.sequence < state.lastSequence) {
    return rejected(state, record, {
      code: "stale-sequence",
      lastSequence: state.lastSequence,
      actualSequence: record.sequence,
    });
  }
  const expectedSequence = state.lastSequence + 1;
  if (record.sequence !== expectedSequence) {
    return rejected(state, record, {
      code: "sequence-gap",
      expectedSequence,
      actualSequence: record.sequence,
    });
  }
  if (
    record.kind !== "run-genesis"
    && record.kind !== "command-settled"
    && state.actionCommits.some((entry) => entry.actionId === record.actionId)
  ) {
    return rejected(state, record, {
      code: "duplicate-action",
      actionId: record.actionId,
    });
  }
  return null;
}

function appendActionCommit(
  state: RunState,
  action: ActionCommitState,
): readonly ActionCommitState[] {
  return Object.freeze(
    [...state.actionCommits, action].sort((left, right) => {
      if (left.actionId < right.actionId) {
        return -1;
      }
      return left.actionId > right.actionId ? 1 : 0;
    }),
  );
}

function applyDecision(state: RunState, decision: DecisionCommitted): FoldResult {
  const actualFactDigest = canonicalDecisionFactsDigest(decision.facts);
  if (String(decision.factRoot) !== String(actualFactDigest)) {
    return rejected(state, decision, {
      code: "decision-fact-root-mismatch",
      expectedFactRoot: decision.factRoot,
      actualFactDigest,
    });
  }
  let candidate = state;
  for (const fact of decision.facts) {
    const factResult = foldDomainFact(candidate, fact);
    if (factResult.kind === "rejected") {
      return rejected(state, decision, factResult.error);
    }
    candidate = factResult.state;
  }
  const actionCommit: ActionCommitState = Object.freeze({
    actionId: decision.actionId,
    recordKind: decision.kind,
    sequence: decision.sequence,
  });
  return applied(Object.freeze({
    ...candidate,
    lastSequence: decision.sequence,
    actionCommits: appendActionCommit(candidate, actionCommit),
    lastDecision: Object.freeze({
      actionId: decision.actionId,
      sequence: decision.sequence,
      stimulusDigest: decision.stimulusDigest,
      factRoot: decision.factRoot,
      commandRoot: decision.commandRoot,
    }),
  }));
}

function applyCommandSettled(state: RunState, record: JournalRecord): FoldResult {
  if (record.kind !== "command-settled") {
    return rejected(state, record, { code: "unknown-journal-record-kind" });
  }
  if (state.commandSettlements.some((entry) => entry.commandId === record.commandId)) {
    return rejected(state, record, {
      code: "duplicate-command-settlement",
      commandId: record.commandId,
    });
  }
  const settlement: CommandSettlementState = Object.freeze({
    commandId: record.commandId,
    actionId: record.actionId,
    sequence: record.sequence,
    observation: record.observation,
    observationDigest: record.observationDigest,
  });
  const commandSettlements = Object.freeze(
    [...state.commandSettlements, settlement].sort((left, right) => {
      if (left.commandId < right.commandId) {
        return -1;
      }
      return left.commandId > right.commandId ? 1 : 0;
    }),
  );
  return applied(Object.freeze({
    ...state,
    lastSequence: record.sequence,
    commandSettlements,
  }));
}

function rejectUnknownRecord(
  state: RunState,
  record: never,
  fallback: JournalRecord,
): FoldResult {
  void record;
  return rejected(state, fallback, { code: "unknown-journal-record-kind" });
}

export function fold(state: RunState, record: FoldInput): FoldResult {
  const invalidEnvelope = validateEnvelope(state, record);
  if (invalidEnvelope !== null) {
    return invalidEnvelope;
  }
  switch (record.kind) {
    case "run-genesis":
      return rejected(state, record, { code: "unexpected-genesis" });
    case "decision-committed":
      return applyDecision(state, record);
    case "command-settled":
      return applyCommandSettled(state, record);
    case "outcome-committed": {
      if (record.outcome.kind === "t2" && state.phase !== "planning") {
        return rejected(state, record, { code: "planning-outcome-after-planning" });
      }
      const actionCommit: ActionCommitState = Object.freeze({
        actionId: record.actionId,
        recordKind: record.kind,
        sequence: record.sequence,
      });
      return applied(Object.freeze({
        ...state,
        lastSequence: record.sequence,
        actionCommits: appendActionCommit(state, actionCommit),
        terminal: Object.freeze({
          actionId: record.actionId,
          sequence: record.sequence,
          outcome: record.outcome,
        }),
      }));
    }
    case "run-suspended": {
      if (state.suspension.kind === "suspended") {
        return rejected(state, record, { code: "already-suspended" });
      }
      const actionCommit: ActionCommitState = Object.freeze({
        actionId: record.actionId,
        recordKind: record.kind,
        sequence: record.sequence,
      });
      return applied(Object.freeze({
        ...state,
        lastSequence: record.sequence,
        actionCommits: appendActionCommit(state, actionCommit),
        suspension: Object.freeze({
          kind: "suspended",
          actionId: record.actionId,
          operatorRequestId: record.operatorRequestId,
          reason: record.reason,
          sequence: record.sequence,
        }),
      }));
    }
    case "run-resumed": {
      if (state.suspension.kind !== "suspended") {
        return rejected(state, record, { code: "not-suspended" });
      }
      if (record.operatorRequestId !== state.suspension.operatorRequestId) {
        return rejected(state, record, { code: "resume-request-mismatch" });
      }
      if (record.resumeFromSequence !== state.suspension.sequence) {
        return rejected(state, record, { code: "resume-sequence-mismatch" });
      }
      const actionCommit: ActionCommitState = Object.freeze({
        actionId: record.actionId,
        recordKind: record.kind,
        sequence: record.sequence,
      });
      return applied(Object.freeze({
        ...state,
        lastSequence: record.sequence,
        actionCommits: appendActionCommit(state, actionCommit),
        suspension: Object.freeze({ kind: "active" }),
      }));
    }
    default:
      return rejectUnknownRecord(state, record, record);
  }
}

/** Apply one decoded finite chunk without retaining another copy. */
export function foldMany(state: RunState, records: readonly FoldInput[]): FoldResult {
  let current = state;
  for (const record of records) {
    const result = fold(current, record);
    if (result.kind === "rejected") {
      return result;
    }
    current = result.state;
  }
  return applied(current);
}

/** Replay one decoded journal chunk from genesis in a single pass. */
export function foldAll(genesis: RunGenesis, records: readonly FoldInput[]): FoldResult {
  return foldMany(initialState(genesis), records);
}
