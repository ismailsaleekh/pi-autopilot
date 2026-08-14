import { eligibleOutcomeForState } from "../outcome/index.js";
import { initialState } from "../model/genesis.js";
import { stateDigest } from "../model/run-state.js";
import type { RunIndexes, RunState } from "../model/run-state.js";
import {
  applyIndexMutation,
  indexKey,
  indexMutationDigest,
  lookupIndex,
  prepareIndexMutation,
} from "../model/authenticated-index.js";
import type { AuthenticatedIndexState } from "../model/authenticated-index.js";
import type { Command } from "../protocol/command.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import {
  compareDecimalNatural,
  incrementDecimalNatural,
} from "../protocol/identifiers.js";
import type {
  ActionId,
  ArtifactRef,
  CommandId,
  DecimalNatural,
  Digest,
} from "../protocol/identifiers.js";
import {
  recordOutcome,
  recordSemanticRootsMatch,
} from "../protocol/journal-record.capsule.js";
import type {
  CommandSettled,
  DecisionCommitted,
  JournalRecord,
  OutcomeCommitted,
  RunGenesis,
} from "../protocol/journal-record.capsule.js";
import type {
  IndexMutation,
  IndexName,
  IndexValue,
  ResolvedIndexPage,
} from "../protocol/state-index.capsule.js";
import { terminalOutcomeCapsule } from "../protocol/terminal-outcome.capsule.js";
import { foldDomainFact } from "./domain-fact-fold.js";
import type { FoldResult } from "./fold-result.js";

export type FoldInput = JournalRecord;

interface IndexTransitionResult {
  readonly kind: "applied";
  readonly state: RunState;
  readonly mutation: IndexMutation;
}

interface IndexTransitionFailure {
  readonly kind: "rejected";
  readonly code: string;
  readonly diagnostic: string;
}

function rejected(state: RunState, record: JournalRecord, code: string, diagnostic: string): FoldResult {
  return Object.freeze({
    kind: "rejected",
    state,
    recordKind: record.kind,
    error: Object.freeze({ code, diagnostic }),
  });
}

function applied(state: RunState): FoldResult {
  return Object.freeze({ kind: "applied", state });
}

function indexOf(indexes: RunIndexes, name: IndexName): AuthenticatedIndexState {
  switch (name) {
    case "actions": return indexes.actions;
    case "atoms": return indexes.atoms;
    case "candidates": return indexes.candidates;
    case "commands": return indexes.commands;
    case "dependencies": return indexes.dependencies;
    case "dispositions": return indexes.dispositions;
    case "evidence": return indexes.evidence;
    case "findings": return indexes.findings;
    case "plans": return indexes.plans;
    case "publications": return indexes.publications;
    case "submissions": return indexes.submissions;
    case "work": return indexes.work;
  }
}

function replaceIndex(indexes: RunIndexes, name: IndexName, value: AuthenticatedIndexState): RunIndexes {
  switch (name) {
    case "actions": return Object.freeze({ ...indexes, actions: value });
    case "atoms": return Object.freeze({ ...indexes, atoms: value });
    case "candidates": return Object.freeze({ ...indexes, candidates: value });
    case "commands": return Object.freeze({ ...indexes, commands: value });
    case "dependencies": return Object.freeze({ ...indexes, dependencies: value });
    case "dispositions": return Object.freeze({ ...indexes, dispositions: value });
    case "evidence": return Object.freeze({ ...indexes, evidence: value });
    case "findings": return Object.freeze({ ...indexes, findings: value });
    case "plans": return Object.freeze({ ...indexes, plans: value });
    case "publications": return Object.freeze({ ...indexes, publications: value });
    case "submissions": return Object.freeze({ ...indexes, submissions: value });
    case "work": return Object.freeze({ ...indexes, work: value });
  }
}

function transitionIndex(
  state: RunState,
  name: IndexName,
  identity: string,
  next: IndexValue,
  pages: readonly ResolvedIndexPage[],
  expectedPriorKind: IndexValue["kind"] | null,
): IndexTransitionResult | IndexTransitionFailure {
  const index = indexOf(state.indexes, name);
  const key = indexKey(name, identity);
  const found = lookupIndex(index, key, pages);
  if (found.kind !== "proved") {
    return Object.freeze({ kind: "rejected", code: "page-unproven", diagnostic: found.diagnostic });
  }
  if (
    (expectedPriorKind === null && found.value !== null)
    || (expectedPriorKind !== null && (found.value === null || found.value.kind !== expectedPriorKind))
  ) {
    return Object.freeze({ kind: "rejected", code: "index-prior-mismatch", diagnostic: `${name}/${identity} has an unexpected prior value` });
  }
  const prepared = prepareIndexMutation(index, key, next, pages);
  if (prepared.kind !== "prepared") {
    return Object.freeze({ kind: "rejected", code: "page-unproven", diagnostic: prepared.diagnostic });
  }
  const changed = applyIndexMutation(index, prepared.mutation, found.value, next);
  if (changed.kind !== "applied") {
    return Object.freeze({ kind: "rejected", code: "index-proof-invalid", diagnostic: changed.diagnostic });
  }
  return Object.freeze({
    kind: "applied",
    state: Object.freeze({ ...state, indexes: replaceIndex(state.indexes, name, changed.state) }),
    mutation: prepared.mutation,
  });
}

function insertCommands(
  state: RunState,
  commands: readonly Command[],
  pages: readonly ResolvedIndexPage[],
): { readonly kind: "applied"; readonly state: RunState; readonly mutations: readonly IndexMutation[] }
  | IndexTransitionFailure {
  let current = state;
  const mutations: IndexMutation[] = [];
  for (const command of commands) {
    const value: IndexValue = Object.freeze({
      kind: "command",
      command,
      commandId: command.commandId,
      observation: null,
      status: "issued",
    });
    const transitioned = transitionIndex(current, "commands", command.commandId, value, pages, null);
    if (transitioned.kind !== "applied") {
      return transitioned;
    }
    current = transitioned.state;
    mutations.push(transitioned.mutation);
  }
  return Object.freeze({ kind: "applied", state: current, mutations: Object.freeze(mutations) });
}

function insertAction(
  state: RunState,
  actionId: Exclude<JournalRecord, RunGenesis>["actionId"],
  recordKind: Exclude<JournalRecord, RunGenesis>["kind"],
  sequence: Exclude<JournalRecord, RunGenesis>["sequence"],
  pages: readonly ResolvedIndexPage[],
): IndexTransitionResult | IndexTransitionFailure {
  const value: IndexValue = Object.freeze({
    actionId,
    kind: "action",
    recordKind,
    sequence,
  });
  return transitionIndex(state, "actions", actionId, value, pages, null);
}

function mutationsEqual(left: readonly IndexMutation[], right: readonly IndexMutation[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => {
      const other = right[index];
      return other !== undefined && indexMutationDigest(entry) === indexMutationDigest(other);
    });
}

function sameOutcome(left: ReturnType<typeof recordOutcome>, right: ReturnType<typeof recordOutcome>): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return terminalOutcomeCapsule.digest(left) === terminalOutcomeCapsule.digest(right);
}

function validateEnvelope(state: RunState, record: JournalRecord): FoldResult | null {
  if (state.terminal !== null) {
    return rejected(state, record, "post-terminal", "no record is admissible after a committed terminal");
  }
  if (record.runId !== state.identity.runId) {
    return rejected(state, record, "run-mismatch", "record belongs to another run");
  }
  const expected = incrementDecimalNatural(state.lastSequence);
  const comparison = compareDecimalNatural(record.sequence, expected);
  if (comparison < 0) {
    return rejected(state, record, "stale-sequence", "record sequence is stale or duplicate");
  }
  if (comparison > 0) {
    return rejected(state, record, "sequence-gap", "record sequence skips the exact successor");
  }
  if (record.kind !== "run-genesis" && record.priorStateDigest !== stateDigest(state)) {
    return rejected(state, record, "prior-state-mismatch", "record was prepared against a different authoritative state");
  }
  return null;
}

export interface ActionTransitionDraft {
  readonly kind: Exclude<JournalRecord["kind"], "run-genesis">;
  readonly actionId: ActionId;
  readonly sequence: DecimalNatural;
  readonly pages: readonly ResolvedIndexPage[];
}

export type ActionTransitionResult =
  | { readonly kind: "derived"; readonly state: RunState; readonly mutation: IndexMutation }
  | IndexTransitionFailure;

export function deriveActionTransition(
  state: RunState,
  draft: ActionTransitionDraft,
): ActionTransitionResult {
  const action = insertAction(state, draft.actionId, draft.kind, draft.sequence, draft.pages);
  return action.kind === "applied"
    ? Object.freeze({ kind: "derived", state: action.state, mutation: action.mutation })
    : action;
}

export interface SemanticTransitionDraft {
  readonly kind: "decision-committed" | "command-settled" | "outcome-committed";
  readonly actionId: ActionId;
  readonly sequence: DecimalNatural;
  readonly facts: readonly DomainFact[];
  readonly commands: readonly Command[];
  readonly pages: readonly ResolvedIndexPage[];
  readonly settlement: null | {
    readonly commandId: CommandId;
    readonly observation: ArtifactRef;
    readonly observationDigest: Digest;
  };
}

export type SemanticTransitionResult =
  | { readonly kind: "derived"; readonly state: RunState; readonly mutations: readonly IndexMutation[] }
  | IndexTransitionFailure;

export function deriveSemanticTransition(
  state: RunState,
  draft: SemanticTransitionDraft,
): SemanticTransitionResult {
  let current = state;
  const mutations: IndexMutation[] = [];
  if (draft.kind === "command-settled") {
    if (draft.settlement === null) {
      return Object.freeze({ kind: "rejected", code: "settlement-missing", diagnostic: "command settlement requires its exact observation" });
    }
    const settlementRecord = Object.freeze({
      actionId: draft.actionId,
      commandId: draft.settlement.commandId,
      kind: "command-settled" as const,
      observation: draft.settlement.observation,
      pages: draft.pages,
      runId: state.identity.runId,
    });
    const index = current.indexes.commands;
    const key = indexKey("commands", settlementRecord.commandId);
    const found = lookupIndex(index, key, draft.pages);
    if (found.kind !== "proved" || found.value === null || found.value.kind !== "command" || found.value.status !== "issued" || found.value.command.actionId !== draft.actionId || found.value.command.commandId !== draft.settlement.commandId) {
      return Object.freeze({ kind: "rejected", code: "command-not-issued", diagnostic: "settlement does not bind the exact proved issued command action" });
    }
    const next: IndexValue = Object.freeze({ ...found.value, observation: settlementRecord.observation, status: "settled" });
    const prepared = prepareIndexMutation(index, key, next, draft.pages);
    if (prepared.kind !== "prepared") {
      return Object.freeze({ kind: "rejected", code: "page-unproven", diagnostic: prepared.diagnostic });
    }
    const changed = applyIndexMutation(index, prepared.mutation, found.value, next);
    if (changed.kind !== "applied") {
      return Object.freeze({ kind: "rejected", code: "index-proof-invalid", diagnostic: changed.diagnostic });
    }
    current = Object.freeze({ ...current, indexes: replaceIndex(current.indexes, "commands", changed.state) });
    mutations.push(prepared.mutation);
  } else if (draft.settlement !== null) {
    return Object.freeze({ kind: "rejected", code: "unexpected-settlement", diagnostic: "only command-settled may carry a settlement" });
  }
  for (const fact of draft.facts) {
    const transitioned = foldDomainFact(current, fact, draft.pages, null);
    if (transitioned.kind !== "applied") {
      return Object.freeze({ kind: "rejected", code: transitioned.code, diagnostic: transitioned.diagnostic });
    }
    current = transitioned.state;
    mutations.push(...transitioned.mutations);
  }
  const commands = draft.kind === "outcome-committed" ? Object.freeze([]) : draft.commands;
  const issued = insertCommands(current, commands, draft.pages);
  if (issued.kind !== "applied") {
    return issued;
  }
  current = issued.state;
  mutations.push(...issued.mutations);
  const action = deriveActionTransition(current, draft);
  if (action.kind !== "derived") {
    return action;
  }
  current = action.state;
  mutations.push(action.mutation);
  return Object.freeze({ kind: "derived", state: current, mutations: Object.freeze(mutations) });
}

function applySemanticRecord(
  state: RunState,
  record: DecisionCommitted | CommandSettled | OutcomeCommitted,
): FoldResult {
  if (!recordSemanticRootsMatch(record)) {
    return rejected(state, record, "semantic-root-mismatch", "facts, commands, and canonical artifact bindings do not match");
  }
  const derived = deriveSemanticTransition(state, Object.freeze({
    kind: record.kind,
    actionId: record.actionId,
    sequence: record.sequence,
    facts: record.facts,
    commands: record.kind === "outcome-committed" ? Object.freeze([]) : record.commands,
    pages: record.pages,
    settlement: record.kind === "command-settled"
      ? Object.freeze({
          commandId: record.commandId,
          observation: record.observation,
          observationDigest: record.observationDigest,
        })
      : null,
  }));
  if (derived.kind !== "derived") {
    return rejected(state, record, derived.code, derived.diagnostic);
  }
  let current = derived.state;
  if (!mutationsEqual(derived.mutations, record.mutations)) {
    return rejected(state, record, "index-mutation-mismatch", "committed index mutations do not equal the exact prospective transition");
  }
  const outcome = recordOutcome(record);
  if (outcome !== null) {
    if (record.kind === "decision-committed") {
      return rejected(state, record, "outcome-record-family-invalid", "decision records cannot smuggle a terminal outcome");
    }
    const eligibility = eligibleOutcomeForState(current, record.pages);
    const eligibilityDigest = stateDigest(current);
    if (eligibility.kind !== "eligible" || !sameOutcome(eligibility.outcome, outcome) || record.eligibilityStateDigest !== eligibilityDigest) {
      return rejected(state, record, "outcome-ineligible", "replay recomputation rejects stale or forged outcome eligibility");
    }
    current = Object.freeze({
      ...current,
      terminal: Object.freeze({ actionId: record.actionId, sequence: record.sequence, outcome }),
    });
  } else {
    if (record.kind === "command-settled" && record.eligibilityStateDigest !== null) {
      return rejected(state, record, "outcome-binding-without-outcome", "eligibility digest cannot appear without an atomic outcome");
    }
    if (eligibleOutcomeForState(current, record.pages).kind === "eligible") {
      return rejected(state, record, "eligible-outcome-omitted", "an eligible T1/T2 must commit atomically with its enabling consequences");
    }
  }
  current = Object.freeze({ ...current, lastSequence: record.sequence });
  if (stateDigest(current) !== record.resultStateDigest) {
    return rejected(state, record, "result-state-mismatch", "committed result state digest does not match replay");
  }
  return applied(current);
}

function applyLifecycle(state: RunState, record: Exclude<JournalRecord, RunGenesis | DecisionCommitted | CommandSettled | OutcomeCommitted>): FoldResult {
  if (record.kind === "run-suspended" && state.suspension.kind !== "active") {
    return rejected(state, record, "already-suspended", "run is already suspended");
  }
  if (record.kind === "run-resumed") {
    if (state.suspension.kind !== "suspended") {
      return rejected(state, record, "not-suspended", "active run cannot be resumed");
    }
    if (record.operatorRequestId !== state.suspension.operatorRequestId || record.resumeFromSequence !== state.suspension.sequence) {
      return rejected(state, record, "resume-binding-mismatch", "resume must bind the exact suspension request and sequence");
    }
  }
  const action = insertAction(state, record.actionId, record.kind, record.sequence, record.pages);
  if (action.kind !== "applied") {
    return rejected(state, record, action.code, action.diagnostic);
  }
  if (!mutationsEqual(Object.freeze([action.mutation]), record.mutations)) {
    return rejected(state, record, "index-mutation-mismatch", "lifecycle action mutation is not exact");
  }
  let current = record.kind === "run-suspended"
    ? Object.freeze({
        ...action.state,
        suspension: Object.freeze({
          kind: "suspended" as const,
          actionId: record.actionId,
          operatorRequestId: record.operatorRequestId,
          reason: record.reason,
          sequence: record.sequence,
        }),
      })
    : Object.freeze({ ...action.state, suspension: Object.freeze({ kind: "active" as const }) });
  current = Object.freeze({ ...current, lastSequence: record.sequence });
  if (stateDigest(current) !== record.resultStateDigest) {
    return rejected(state, record, "result-state-mismatch", "lifecycle result digest does not match replay");
  }
  return applied(current);
}

export function fold(state: RunState, record: FoldInput): FoldResult {
  const invalid = validateEnvelope(state, record);
  if (invalid !== null) {
    return invalid;
  }
  switch (record.kind) {
    case "run-genesis":
      return rejected(state, record, "unexpected-genesis", "genesis is accepted only by initial()");
    case "decision-committed":
    case "command-settled":
    case "outcome-committed":
      return applySemanticRecord(state, record);
    case "run-suspended":
    case "run-resumed":
      return applyLifecycle(state, record);
  }
}

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

export function foldAll(genesis: RunGenesis, records: readonly FoldInput[]): FoldResult {
  return foldMany(initialState(genesis), records);
}
