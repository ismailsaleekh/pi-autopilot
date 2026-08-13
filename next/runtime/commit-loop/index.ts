import {
  initial,
  prepare,
  project,
  replay,
} from "../../authority/facade/index.js";
import type { Feedback as AuthorityFeedback } from "../../authority/facade/index.js";
import { commandCapsule } from "../../authority/protocol/command.capsule.js";
import type { Command } from "../../authority/protocol/command.capsule.js";
import type {
  ActionId,
  ArtifactRoot,
  CommandId,
} from "../../authority/protocol/identifiers.js";
import {
  decisionFactsMatchRoot,
  journalRecordCapsule,
  runGenesisSchema,
} from "../../authority/protocol/journal-record.capsule.js";
import type {
  DecisionCommitted,
  JournalRecord,
  RunGenesis,
} from "../../authority/protocol/journal-record.capsule.js";
import {
  defineCapsule,
  digestBytes,
  object,
  text,
} from "../../authority/protocol/schema.js";
import type { Stimulus } from "../../authority/protocol/stimulus.capsule.js";
import {
  appendCommittedBatch,
  closeJournal,
  openJournal,
  replayJournal,
  type JournalAppendResult,
  type JournalError,
  type JournalOpenOptions,
  type JournalWriterHandle,
} from "../../storage/journal/index.js";
import {
  normalizeArtifact,
} from "../artifact-normalization/index.js";
import type { NormalizedArtifact } from "../artifact-normalization/index.js";
import {
  decodeCommandBatch,
  decodeBoundaryValue,
  decodeStimulus,
} from "../boundary-codecs/index.js";
import type { BoundaryFeedback } from "../boundary-codecs/index.js";
import {
  dispatchCommittedCommands,
} from "../dispatcher/index.js";
import type {
  CommandObservationSink,
  DispatcherDependencies,
  DispatcherResult,
} from "../dispatcher/index.js";

export type CommandArtifactStoreResult =
  | { readonly kind: "stored"; readonly root: ArtifactRoot }
  | {
      readonly kind: "feedback";
      readonly disposition: "feedback" | "resume" | "fatal";
      readonly diagnostic: string;
    };

export interface CommandArtifactRepository {
  readonly store: (
    artifact: NormalizedArtifact,
    expectedRoot: ArtifactRoot,
  ) => CommandArtifactStoreResult | Promise<CommandArtifactStoreResult>;
  readonly load: (root: ArtifactRoot) => unknown | Promise<unknown>;
}

export interface CommitLoopDependencies {
  readonly commands: CommandArtifactRepository;
  readonly dispatcher: DispatcherDependencies;
  readonly journalOptions: JournalOpenOptions | undefined;
}

export const commitLoopOpenSchema = object({
  genesis: runGenesisSchema,
  journalDir: text("non-empty"),
});

export interface CommitLoopAccepted {
  readonly kind: "accepted";
  readonly record: DecisionCommitted;
  readonly dispatch: DispatcherResult;
}

export type CommitLoopResult =
  | CommitLoopAccepted
  | {
      readonly kind: "already-committed";
      readonly record: JournalRecord;
      readonly dispatch: DispatcherResult;
    }
  | {
      readonly kind: "feedback";
      readonly source: "boundary" | "authority" | "commands" | "journal";
      readonly diagnostic: string;
    }
  | {
      readonly kind: "resume";
      readonly diagnostic: string;
    }
  | {
      readonly kind: "fatal";
      readonly diagnostic: string;
    };

type CommitLoopFailure = Extract<
  CommitLoopResult,
  { readonly kind: "feedback" | "resume" | "fatal" }
>;
type SuccessfulDispatch = Extract<DispatcherResult, { readonly kind: "dispatched" }>;

export interface RuntimeCommitLoop {
  readonly ingest: (input: unknown) => Promise<CommitLoopResult>;
  readonly reconcile: () => Promise<SuccessfulDispatch | CommitLoopFailure>;
  readonly view: () => ReturnType<typeof project>;
  readonly close: () => Promise<CommitLoopResult>;
}

export type OpenCommitLoopResult =
  | {
      readonly kind: "opened";
      readonly loop: RuntimeCommitLoop;
      readonly reconciliation: SuccessfulDispatch | CommitLoopFailure;
    }
  | {
      readonly kind: "feedback" | "resume" | "fatal";
      readonly diagnostic: string;
    };

interface CommitLoopOpenValue {
  readonly genesis: RunGenesis;
  readonly journalDir: string;
}

interface ReplaySnapshot {
  readonly state: ReturnType<typeof initial>;
  readonly actions: ReadonlyMap<ActionId, JournalRecord>;
  readonly decisions: readonly DecisionCommitted[];
  readonly settlements: ReadonlySet<CommandId>;
  readonly hasGenesis: boolean;
}

interface PendingAccepted {
  readonly kind: "pending-accepted";
  readonly record: DecisionCommitted;
  readonly commands: readonly Command[];
}

interface PendingReconciliation {
  readonly kind: "pending-reconciliation";
  readonly record: JournalRecord;
}

interface ReconciliationCandidate {
  readonly command: Command;
  readonly settled: boolean;
}

type TransactionResult = CommitLoopFailure | PendingAccepted | PendingReconciliation;

const openCapsule = defineCapsule("RuntimeCommitLoopOpen", commitLoopOpenSchema);

function authorityFeedback(value: AuthorityFeedback): CommitLoopFailure {
  return Object.freeze({
    kind: "feedback",
    source: "authority",
    diagnostic: value.diagnostic,
  });
}

function boundaryResult(value: BoundaryFeedback): CommitLoopFailure {
  return Object.freeze({
    kind: "feedback",
    source: "boundary",
    diagnostic: value.diagnostic,
  });
}

function journalResult(error: JournalError): CommitLoopFailure {
  if (error.disposition === "fatal") {
    return Object.freeze({ kind: "fatal", diagnostic: error.message });
  }
  if (error.disposition === "resume" || error.disposition === "contended") {
    return Object.freeze({ kind: "resume", diagnostic: error.message });
  }
  return Object.freeze({ kind: "feedback", source: "journal", diagnostic: error.message });
}

function sameCommand(left: Command, right: Command): boolean {
  const leftBytes = commandCapsule.encode(left);
  const rightBytes = commandCapsule.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }
  return true;
}

function sameGenesis(left: RunGenesis, right: RunGenesis): boolean {
  const leftBytes = journalRecordCapsule.encode(left);
  const rightBytes = journalRecordCapsule.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }
  return true;
}

async function replaySnapshot(
  journalDir: string,
  expectedGenesis: RunGenesis,
): Promise<ReplaySnapshot | CommitLoopFailure> {
  const stream = replayJournal(journalDir);
  let state = initial(expectedGenesis);
  let hasGenesis = false;
  let semanticFailure: CommitLoopFailure | null = null;
  const actions = new Map<ActionId, JournalRecord>();
  const decisions: DecisionCommitted[] = [];
  const settlements = new Set<CommandId>();
  for await (const record of stream) {
    if (semanticFailure !== null) {
      continue;
    }
    if (!hasGenesis) {
      if (record.kind !== "run-genesis" || !sameGenesis(record, expectedGenesis)) {
        semanticFailure = Object.freeze({
          kind: "fatal",
          diagnostic: "journal genesis does not match the configured immutable run identity",
        });
        continue;
      }
      state = initial(record);
      hasGenesis = true;
      continue;
    }
    const folded = replay(state, Object.freeze([record]));
    if (folded.kind !== "applied") {
      semanticFailure = Object.freeze({
        kind: "fatal",
        diagnostic: `journal replay rejected ${record.kind}: ${folded.error.code}`,
      });
      continue;
    }
    state = folded.state;
    if (record.kind !== "run-genesis") {
      if (!actions.has(record.actionId)) {
        actions.set(record.actionId, record);
      }
      if (record.kind === "decision-committed") {
        decisions.push(record);
      }
      if (record.kind === "command-settled") {
        settlements.add(record.commandId);
      }
    }
  }
  const completion = await stream.completion;
  if (completion.kind === "error") {
    return journalResult(completion.error);
  }
  if (semanticFailure !== null) {
    return semanticFailure;
  }
  return Object.freeze({
    state,
    actions,
    decisions: Object.freeze(decisions),
    settlements,
    hasGenesis,
  });
}

class CommitLoopEngine implements RuntimeCommitLoop {
  private readonly openValue: CommitLoopOpenValue;
  private readonly dependencies: CommitLoopDependencies;
  private handle: JournalWriterHandle;
  private state: ReturnType<typeof initial>;
  private actions: Map<ActionId, JournalRecord>;
  private decisions: readonly DecisionCommitted[];
  private settlements: Set<CommandId>;
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    openValue: CommitLoopOpenValue,
    dependencies: CommitLoopDependencies,
    handle: JournalWriterHandle,
    snapshot: ReplaySnapshot,
  ) {
    this.openValue = openValue;
    this.dependencies = dependencies;
    this.handle = handle;
    this.state = snapshot.state;
    this.actions = new Map(snapshot.actions);
    this.decisions = snapshot.decisions;
    this.settlements = new Set(snapshot.settlements);
  }

  public view(): ReturnType<typeof project> {
    return project(this.state);
  }

  public async ingest(input: unknown): Promise<CommitLoopResult> {
    const operation = this.queue.then(
      () => this.commitInput(input),
      () => this.commitInput(input),
    );
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    let transaction: TransactionResult;
    try {
      transaction = await operation;
    } catch {
      return Object.freeze({
        kind: "resume",
        diagnostic: "commit transaction was interrupted before a typed result; replay the same action identity",
      });
    }
    if (transaction.kind === "pending-reconciliation") {
      const reconciled = await this.reconcile();
      if (reconciled.kind !== "dispatched") {
        return reconciled;
      }
      return Object.freeze({
        kind: "already-committed",
        record: transaction.record,
        dispatch: reconciled,
      });
    }
    if (transaction.kind !== "pending-accepted") {
      return transaction;
    }
    const sink: CommandObservationSink = Object.freeze({
      submit: (stimulus: Stimulus) => this.ingest(stimulus),
    });
    const dispatched = await dispatchCommittedCommands(
      transaction.commands,
      this.dependencies.dispatcher,
      sink,
    );
    return Object.freeze({
      kind: "accepted",
      record: transaction.record,
      dispatch: dispatched,
    });
  }

  public async reconcile(): Promise<SuccessfulDispatch | CommitLoopFailure> {
    const candidates = new Map<ActionId, ReconciliationCandidate>();
    for (const decision of this.decisions) {
      let raw: unknown;
      try {
        raw = await this.dependencies.commands.load(decision.commandRoot);
      } catch {
        return Object.freeze({
          kind: "resume",
          diagnostic: "committed command root could not be loaded; retain the journal and retry",
        });
      }
      const decoded = decodeCommandBatch(raw);
      if (decoded.kind !== "ok") {
        return boundaryResult(decoded);
      }
      if (String(digestBytes(decoded.canonicalBytes)) !== String(decision.commandRoot)) {
        return Object.freeze({
          kind: "fatal",
          diagnostic: "loaded command batch bytes do not bind to the journaled command root",
        });
      }
      for (const command of decoded.value) {
        const settled = this.settlements.has(command.commandId);
        const prior = candidates.get(command.actionId);
        if (prior !== undefined && !sameCommand(prior.command, command)) {
          return Object.freeze({
            kind: "fatal",
            diagnostic: "one durable action identity resolves to conflicting committed commands",
          });
        }
        if (prior === undefined || (settled && !prior.settled)) {
          candidates.set(command.actionId, Object.freeze({ command, settled }));
        }
      }
    }
    const sink: CommandObservationSink = Object.freeze({
      submit: (stimulus: Stimulus) => this.ingest(stimulus),
    });
    const pending: Command[] = [];
    for (const candidate of candidates.values()) {
      if (!candidate.settled) {
        pending.push(candidate.command);
      }
    }
    const dispatched = await dispatchCommittedCommands(
      Object.freeze(pending),
      this.dependencies.dispatcher,
      sink,
    );
    return dispatched.kind === "dispatched" ? dispatched : boundaryResult(dispatched);
  }

  public async close(): Promise<CommitLoopResult> {
    try {
      await this.queue;
      const closed = await closeJournal(this.handle);
      return closed.kind === "closed"
        ? Object.freeze({ kind: "resume", diagnostic: "commit loop closed cleanly and can be reopened" })
        : journalResult(closed.error);
    } catch {
      return Object.freeze({ kind: "resume", diagnostic: "journal close was interrupted; successor replay is authoritative" });
    }
  }

  public async ensureGenesis(): Promise<CommitLoopFailure | null> {
    const appended = await this.appendRecord(this.openValue.genesis);
    if (appended.kind !== "acknowledged") {
      return journalResult(appended.error);
    }
    return null;
  }

  private async commitInput(input: unknown): Promise<TransactionResult> {
    const decoded = decodeStimulus(input);
    if (decoded.kind !== "ok") {
      return boundaryResult(decoded);
    }
    const prior = this.actions.get(decoded.value.actionId);
    if (prior !== undefined) {
      return Object.freeze({ kind: "pending-reconciliation", record: prior });
    }
    const prepared = prepare(this.state, decoded.value);
    if (prepared.kind !== "accepted") {
      return authorityFeedback(prepared);
    }
    const normalized = normalizeArtifact(prepared.batch.commands, "command-batch");
    if (normalized.kind !== "normalized") {
      return boundaryResult(normalized);
    }
    if (String(normalized.artifact.digest) !== String(prepared.batch.commandRoot)) {
      return Object.freeze({
        kind: "fatal",
        diagnostic: "canonical command bytes do not bind to authority's command root",
      });
    }
    let stored: CommandArtifactStoreResult;
    try {
      stored = await this.dependencies.commands.store(
        normalized.artifact,
        prepared.batch.commandRoot,
      );
    } catch {
      return Object.freeze({
        kind: "resume",
        diagnostic: "command CAS installation was interrupted before journal append",
      });
    }
    if (stored.kind !== "stored") {
      if (stored.disposition === "fatal") {
        return Object.freeze({ kind: "fatal", diagnostic: stored.diagnostic });
      }
      return stored.disposition === "resume"
        ? Object.freeze({ kind: "resume", diagnostic: stored.diagnostic })
        : Object.freeze({ kind: "feedback", source: "commands", diagnostic: stored.diagnostic });
    }
    if (stored.root !== prepared.batch.commandRoot) {
      return Object.freeze({
        kind: "fatal",
        diagnostic: "command artifact store acknowledged a root different from authority's command root",
      });
    }
    const view = project(this.state);
    if (prepared.batch.runId !== view.runId) {
      return Object.freeze({ kind: "fatal", diagnostic: "accepted batch run identity changed across the facade" });
    }
    const record: DecisionCommitted = Object.freeze({
      actionId: decoded.value.actionId,
      commandRoot: prepared.batch.commandRoot,
      factRoot: prepared.batch.factRoot,
      facts: prepared.batch.facts,
      kind: "decision-committed",
      runId: prepared.batch.runId,
      sequence: view.lastSequence + 1,
      stimulusDigest: digestBytes(decoded.canonicalBytes),
    });
    if (!decisionFactsMatchRoot(record)) {
      return Object.freeze({ kind: "fatal", diagnostic: "authority facts do not bind to the accepted fact root" });
    }
    const appended = await this.appendRecord(record);
    if (appended.kind !== "acknowledged") {
      if (appended.error.disposition !== "resume") {
        return journalResult(appended.error);
      }
      return this.recoverAfterUncertainAppend(decoded.value.actionId);
    }
    const folded = replay(this.state, Object.freeze([record]));
    if (folded.kind !== "applied") {
      return Object.freeze({
        kind: "fatal",
        diagnostic: `acknowledged decision could not replay: ${folded.error.code}`,
      });
    }
    this.state = folded.state;
    this.actions.set(record.actionId, record);
    this.decisions = Object.freeze([...this.decisions, record]);
    return Object.freeze({
      kind: "pending-accepted",
      record,
      commands: prepared.batch.commands,
    });
  }

  private async recoverAfterUncertainAppend(actionId: ActionId): Promise<TransactionResult> {
    await closeJournal(this.handle);
    const opened = await openJournal(this.openValue.journalDir, this.dependencies.journalOptions);
    if (opened.kind === "contended") {
      return Object.freeze({ kind: "resume", diagnostic: opened.error.message });
    }
    if (opened.kind === "error") {
      return journalResult(opened.error);
    }
    this.handle = opened.handle;
    const snapshot = await replaySnapshot(this.openValue.journalDir, this.openValue.genesis);
    if (!("hasGenesis" in snapshot)) {
      return snapshot;
    }
    this.state = snapshot.state;
    this.actions = new Map(snapshot.actions);
    this.decisions = snapshot.decisions;
    this.settlements = new Set(snapshot.settlements);
    const committed = this.actions.get(actionId);
    return committed === undefined
      ? Object.freeze({
          kind: "resume",
          diagnostic: "uncertain append was not selected by replay; retry the same action identity",
        })
      : Object.freeze({ kind: "pending-reconciliation", record: committed });
  }

  private async appendRecord(record: JournalRecord): Promise<JournalAppendResult> {
    return appendCommittedBatch(this.handle, record);
  }
}

/** Opens a successor writer, replays the selected prefix, and reconciles commands. */
export async function openCommitLoop(
  input: unknown,
  dependencies: CommitLoopDependencies,
): Promise<OpenCommitLoopResult> {
  try {
    const decoded = decodeBoundaryValue(input, openCapsule);
    if (decoded.kind !== "ok") {
      return Object.freeze({ kind: "feedback", diagnostic: decoded.diagnostic });
    }
    const openValue: CommitLoopOpenValue = Object.freeze({
      genesis: decoded.value.genesis,
      journalDir: decoded.value.journalDir,
    });
    const opened = await openJournal(openValue.journalDir, dependencies.journalOptions);
    if (opened.kind === "contended") {
      return Object.freeze({ kind: "resume", diagnostic: opened.error.message });
    }
    if (opened.kind === "error") {
      const result = journalResult(opened.error);
      return Object.freeze({ kind: result.kind, diagnostic: result.diagnostic });
    }
    const snapshot = await replaySnapshot(openValue.journalDir, openValue.genesis);
    if (!("hasGenesis" in snapshot)) {
      await closeJournal(opened.handle);
      return Object.freeze({ kind: snapshot.kind, diagnostic: snapshot.diagnostic });
    }
    const engine = new CommitLoopEngine(openValue, dependencies, opened.handle, snapshot);
    if (!snapshot.hasGenesis) {
      const genesisResult = await engine.ensureGenesis();
      if (genesisResult !== null) {
        await engine.close();
        return Object.freeze({
          kind: genesisResult.kind,
          diagnostic: genesisResult.diagnostic,
        });
      }
    }
    const reconciliation = await engine.reconcile();
    return Object.freeze({ kind: "opened", loop: engine, reconciliation });
  } catch {
    return Object.freeze({
      kind: "resume",
      diagnostic: "commit-loop open was exception-contained; retry against the durable journal",
    });
  }
}
