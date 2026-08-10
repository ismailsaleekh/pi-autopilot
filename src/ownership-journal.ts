import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  constants as fsConstants,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import type { BackgroundAction, ChildControlBlockedGate } from "./generated/index.ts";
import { validateBackgroundAction } from "./generated/frame-validation.ts";
import type { BgTaskSnapshot } from "./background-tasks.ts";
import type { BackgroundLaunchGate } from "./effects.ts";

/** Private, append-only Host ownership journal format. */
export const OWNERSHIP_JOURNAL_SCHEMA = "autopilot.host_ownership_journal.v1";
export const OWNERSHIP_JOURNAL_VERSION = 1;
export const OWNERSHIP_JOURNAL_MAX_BYTES = 1024 * 1024;
export const OWNERSHIP_JOURNAL_MAX_RECORD_BYTES = 64 * 1024;
export const OWNERSHIP_JOURNAL_MAX_RECORDS = 128;
export const OWNERSHIP_JOURNAL_MAX_STRING_BYTES = 16 * 1024;

const ZERO_HASH = "0".repeat(64);
const TERMINAL_STATUSES = new Set(["completed", "failed", "killed"]);
const JOURNAL_DIRECTORY = "host-ownership";

type RowKind =
  | "launch"
  | "launch-ack"
  | "terminal-tombstone"
  | "terminal-forwarded"
  | "blocked-hold"
  | "blocked-hold-release"
  | "blocked-gate"
  | "blocked-observation-arrived"
  | "blocked-observation-observed"
  | "blocked-cancelled";

type JournalRow = Record<string, unknown> & {
  readonly schema: typeof OWNERSHIP_JOURNAL_SCHEMA;
  readonly version: typeof OWNERSHIP_JOURNAL_VERSION;
  readonly sequence: number;
  readonly previous_sha256: string;
  readonly kind: RowKind;
  readonly row_sha256: string;
};

export interface OwnedTaskBinding {
  readonly task: BgTaskSnapshot;
  readonly action: BackgroundAction;
  readonly descriptor: string;
  readonly actionSha256: string;
  readonly acknowledged: boolean;
  readonly terminal: boolean;
  readonly terminalForwarded: boolean;
}

export interface BlockedGateDirective {
  readonly receiptId: string;
  readonly gate: ChildControlBlockedGate;
  readonly reporterObserved: boolean;
}

export interface BlockedObservationWire {
  readonly schema: "autopilot.blocked_result_observed.v1";
  readonly token: string;
  readonly run_id: string;
  readonly assignment_id: string;
  readonly attempt: number;
  readonly receipt_id: string;
  readonly tool_call_id: string;
}

export class OwnershipJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipJournalError";
  }
}

/** A run really happened but its ownership row could not be made durable. */
export class OwnershipPersistenceError extends OwnershipJournalError {
  readonly action: BackgroundAction;
  readonly task: BgTaskSnapshot;

  constructor(action: BackgroundAction, task: BgTaskSnapshot, cause: unknown) {
    super(`Autopilot launched task ${task.id} but could not durably record Host ownership: ${errorMessage(cause)}`);
    this.name = "OwnershipPersistenceError";
    this.action = action;
    this.task = task;
  }
}

/** Canonical JSON is deliberately local to this Host-only journal format. */
export function canonicalJournalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw new OwnershipJournalError("journal canonical JSON permits only non-negative integer numbers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJournalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort(compareUtf8);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJournalJson(value[key])}`).join(",")}}`;
  }
  throw new OwnershipJournalError("journal canonical JSON contains an unsupported value");
}

export function ownershipJournalPath(stateRoot: string, sessionId: string): string {
  assertBareSessionId(sessionId);
  if (typeof stateRoot !== "string" || stateRoot.length === 0) throw new OwnershipJournalError("Host ownership journal requires a configured state root");
  return join(stateRoot, JOURNAL_DIRECTORY, `${sessionId}.jsonl`);
}

/**
 * The only Host authority over a task is a validated row in this journal.
 * It also provides the scheduling-only blocked hold used around Core snapshots.
 */
export class HostOwnershipCoordinator implements BackgroundLaunchGate {
  private readonly journal: OwnershipJournal;
  private readonly owned = new Map<string, OwnedTaskBinding>();
  private readonly actionTasks = new Map<string, OwnedTaskBinding>();
  private readonly cancellationRows = new Set<string>();
  private readonly observations = new Map<string, BlockedObservationWire>();
  private readonly observed = new Set<string>();
  private activeGate: BlockedGateDirective | undefined;
  private hold: "open" | "provisional" | "permanent" = "open";
  private activationHold = true;
  private readonly flights = new Set<Promise<void>>();

  private constructor(journal: OwnershipJournal) {
    this.journal = journal;
    for (const row of journal.rows()) this.restore(row);
  }

  static open(stateRoot: string, sessionId: string): HostOwnershipCoordinator {
    return new HostOwnershipCoordinator(OwnershipJournal.open(stateRoot, sessionId));
  }

  get path(): string { return this.journal.path; }
  get isDurablyBlocked(): boolean { return this.hold === "permanent"; }
  get hasPendingAdmission(): boolean { return this.hold === "provisional"; }
  get gate(): BlockedGateDirective | undefined { return this.activeGate; }
  get ownership(): readonly OwnedTaskBinding[] { return [...this.owned.values()]; }
  get pendingAcknowledgements(): readonly OwnedTaskBinding[] { return [...this.owned.values()].filter((binding) => !binding.acknowledged); }
  get pendingTerminals(): readonly OwnedTaskBinding[] { return [...this.owned.values()].filter((binding) => binding.terminal && !binding.terminalForwarded); }

  /** This is the immediate effects.ts launch-coordinator entry. */
  enterLaunch(): () => void {
    this.assertOpen();
    let resolve: (() => void) | undefined;
    const settled = new Promise<void>((done) => { resolve = done; });
    this.flights.add(settled);
    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      this.flights.delete(settled);
      resolve?.();
    };
  }

  assertOpen(): void {
    if (this.activationHold || this.hold !== "open") throw new OwnershipJournalError("Autopilot launch gate is closed by durable blocked ownership state");
  }

  /** Restored ownership is exact descriptor data, never a task inventory lookup. */
  bindingForTask(taskId: string): OwnedTaskBinding | undefined { return this.owned.get(taskId); }
  bindingForAction(actionId: string): OwnedTaskBinding | undefined { return this.actionTasks.get(actionId); }

  registerSuccessfulRun(action: BackgroundAction, task: BgTaskSnapshot): void {
    assertTaskMatchesAction(task, action);
    const descriptor = descriptorFor(action);
    const actionSha256 = sha256(descriptor);
    const existing = this.owned.get(task.id);
    if (existing !== undefined) {
      if (!sameBinding(existing, action, descriptor, task)) throw new OwnershipJournalError(`journal task ownership conflict for task_id=${task.id}`);
      return;
    }
    const byAction = this.actionTasks.get(action.action_id);
    if (byAction !== undefined) {
      if (byAction.descriptor !== descriptor || byAction.task.id !== task.id) throw new OwnershipJournalError(`journal action ownership conflict for action_id=${action.action_id}`);
      return;
    }
    const binding: OwnedTaskBinding = { task: snapshotForJournal(task), action, descriptor, actionSha256, acknowledged: false, terminal: false, terminalForwarded: false };
    // Retain jurisdiction before surfacing a persistence failure. The caller's
    // action-id dedupe will retain this same task and the launch gate closes.
    this.install(binding);
    try {
      this.journal.append("launch", {
        task: journalTask(binding.task),
        action: binding.action,
        action_descriptor: descriptor,
        action_sha256: actionSha256,
        action_id: action.action_id,
        assignment_id: action.assignment_id,
        run_revision: action.run_revision,
        acknowledged: false,
      });
    } catch (error) {
      this.hold = "permanent";
      throw new OwnershipPersistenceError(action, task, error);
    }
  }

  markLaunchAcknowledged(action: BackgroundAction, task: BgTaskSnapshot): void {
    const binding = this.requireExactBinding(task.id, action);
    if (binding.acknowledged) return;
    this.journal.append("launch-ack", correlation(binding));
    this.replace(binding, { ...binding, acknowledged: true });
  }

  recordTerminal(task: BgTaskSnapshot, action: BackgroundAction): void {
    const binding = this.requireExactBinding(task.id, action);
    if (binding.terminal) return;
    if (!TERMINAL_STATUSES.has(task.status)) throw new OwnershipJournalError(`terminal tombstone has nonterminal status for task_id=${task.id}`);
    this.journal.append("terminal-tombstone", { ...correlation(binding), task: journalTask(task), status: task.status });
    this.replace(binding, { ...binding, task: snapshotForJournal(task), terminal: true });
  }

  markTerminalForwarded(taskId: string): void {
    const binding = this.owned.get(taskId);
    if (binding === undefined || !binding.terminal) throw new OwnershipJournalError(`terminal-forwarded has no durable terminal task_id=${taskId}`);
    if (binding.terminalForwarded) return;
    this.journal.append("terminal-forwarded", correlation(binding));
    this.replace(binding, { ...binding, terminalForwarded: true });
  }

  /** Close, fsync the provisional fact, then wait until every run is resolved or journaled. */
  async acquireBlockedAdmission(): Promise<void> {
    if (this.hold === "open") {
      // If this append fails the in-memory gate remains closed; the caller must
      // close the child connection and no later launch can pass this session.
      this.hold = "provisional";
      this.journal.append("blocked-hold", {});
    }
    await Promise.all([...this.flights]);
  }

  releaseBlockedAdmissionOnRetry(): void {
    if (this.hold !== "provisional") return;
    this.journal.append("blocked-hold-release", {});
    this.hold = "open";
  }

  /** Any activation/replay fault is durable scheduling uncertainty, never open. */
  retainFailClosedHold(): void {
    if (this.hold !== "open") return;
    this.hold = "provisional";
    this.journal.append("blocked-hold", {});
  }

  promoteBlockedGate(directive: BlockedGateDirective): void {
    validateDirective(directive);
    this.assertGateMembership(directive.gate);
    if (this.activeGate !== undefined) {
      if (!sameDirective(this.activeGate, directive)) throw new OwnershipJournalError("blocked gate conflicts with durable Host gate");
      this.hold = "permanent";
      return;
    }
    // The provisional hold is already closed. Make the exact Core directive
    // durable before promoting it to the permanent local gate.
    this.journal.append("blocked-gate", {
      receipt_id: directive.receiptId,
      gate: directive.gate,
    });
    this.activeGate = { ...directive, reporterObserved: this.observed.has(gateKey(directive.receiptId, directive.gate.latch_id)) };
    this.hold = "permanent";
  }

  recordObservationArrived(observation: BlockedObservationWire, directive: BlockedGateDirective): void {
    validateObservation(observation);
    const key = gateKey(directive.receiptId, directive.gate.latch_id);
    if (observation.receipt_id !== directive.receiptId) throw new OwnershipJournalError("blocked observation receipt does not match durable Host gate");
    const previous = this.observations.get(key);
    if (previous !== undefined) {
      if (canonicalJournalJson(previous) !== canonicalJournalJson(observation)) throw new OwnershipJournalError("blocked observation correlation conflicts with durable Host observation");
      return;
    }
    this.journal.append("blocked-observation-arrived", { receipt_id: directive.receiptId, latch_id: directive.gate.latch_id, observation });
    this.observations.set(key, observation);
  }

  markObservationObserved(directive: BlockedGateDirective): void {
    const key = gateKey(directive.receiptId, directive.gate.latch_id);
    if (this.observed.has(key)) return;
    this.journal.append("blocked-observation-observed", { receipt_id: directive.receiptId, latch_id: directive.gate.latch_id });
    this.observed.add(key);
    if (this.activeGate !== undefined && sameDirective(this.activeGate, directive)) this.activeGate = { ...this.activeGate, reporterObserved: true };
  }

  wasObserved(directive: BlockedGateDirective): boolean { return this.observed.has(gateKey(directive.receiptId, directive.gate.latch_id)); }

  wasCancelled(directive: BlockedGateDirective, taskId: string): boolean {
    return this.cancellationRows.has(cancellationKey(directive.receiptId, directive.gate.latch_id, taskId));
  }

  markCancelled(directive: BlockedGateDirective, cancellation: { readonly task_id: string; readonly action_id: string; readonly assignment_id: string; readonly reporter: boolean }): void {
    this.assertGateMembership(directive.gate);
    const inGate = directive.gate.cancellations.find((item) => item.task_id === cancellation.task_id);
    if (inGate === undefined || !sameCancellation(inGate, cancellation)) throw new OwnershipJournalError(`cancellation result is not in the exact durable Host gate: ${cancellation.task_id}`);
    const key = cancellationKey(directive.receiptId, directive.gate.latch_id, cancellation.task_id);
    if (this.cancellationRows.has(key)) return;
    this.journal.append("blocked-cancelled", {
      receipt_id: directive.receiptId,
      latch_id: directive.gate.latch_id,
      task_id: cancellation.task_id,
      action_id: cancellation.action_id,
      assignment_id: cancellation.assignment_id,
      reporter: cancellation.reporter,
    });
    this.cancellationRows.add(key);
  }

  /** Reconciliation is authoritative only when it intersects this exact journal. */
  assertReconciled(records: readonly BlockedGateDirective[]): void {
    if (this.activeGate === undefined) return;
    const matching = records.filter((record) => sameDirective(this.activeGate as BlockedGateDirective, record));
    if (matching.length !== 1) throw new OwnershipJournalError("Core blocked reconciliation lacks the exact durable Host gate");
    if (this.wasObserved(this.activeGate) && !matching[0]?.reporterObserved) throw new OwnershipJournalError("Core blocked reconciliation lost durable reporter observation");
  }

  /** Activation keeps scheduling closed through replay/reconciliation. */
  finishActivation(records: readonly BlockedGateDirective[]): void {
    this.assertReconciled(records);
    if (this.hold === "provisional" && records.length === 0) this.releaseBlockedAdmissionOnRetry();
    this.activationHold = false;
  }

  private restore(row: JournalRow): void {
    switch (row.kind) {
      case "launch": {
        const storedAction = actionFromRow(row);
        const task = taskFromRow(row.task, "launch task");
        const descriptor = textField(row, "action_descriptor");
        const action = actionFromDescriptor(descriptor);
        if (canonicalJournalJson(storedAction) !== canonicalJournalJson(action) || sha256(descriptor) !== textField(row, "action_sha256")) throw new OwnershipJournalError("launch action descriptor/hash drift");
        if (textField(row, "action_id") !== action.action_id || textField(row, "assignment_id") !== action.assignment_id || numberField(row, "run_revision") !== action.run_revision || row.acknowledged !== false) throw new OwnershipJournalError("launch ownership correlation drift");
        if (this.owned.has(task.id) || this.actionTasks.has(action.action_id)) throw new OwnershipJournalError("duplicate launch ownership row");
        this.install({ task, action, descriptor, actionSha256: sha256(descriptor), acknowledged: false, terminal: false, terminalForwarded: false });
        return;
      }
      case "launch-ack": {
        const binding = this.requireCorrelationRow(row, "launch-ack");
        if (binding.acknowledged) throw new OwnershipJournalError("duplicate launch acknowledgement row");
        this.replace(binding, { ...binding, acknowledged: true });
        return;
      }
      case "terminal-tombstone": {
        const binding = this.requireCorrelationRow(row, "terminal-tombstone");
        if (binding.terminal) throw new OwnershipJournalError("duplicate terminal tombstone row");
        const task = taskFromRow(row.task, "terminal tombstone task");
        if (task.id !== binding.task.id || task.status !== textField(row, "status") || !TERMINAL_STATUSES.has(task.status)) throw new OwnershipJournalError("terminal tombstone task drift");
        this.replace(binding, { ...binding, task, terminal: true });
        return;
      }
      case "terminal-forwarded": {
        const binding = this.requireCorrelationRow(row, "terminal-forwarded");
        if (!binding.terminal || binding.terminalForwarded) throw new OwnershipJournalError("duplicate or unpaired terminal-forwarded row");
        this.replace(binding, { ...binding, terminalForwarded: true });
        return;
      }
      case "blocked-hold":
        if (this.hold !== "open" || this.activeGate !== undefined) throw new OwnershipJournalError("duplicate/conflicting blocked hold row");
        this.hold = "provisional";
        return;
      case "blocked-hold-release":
        if (this.hold !== "provisional" || this.activeGate !== undefined) throw new OwnershipJournalError("unpaired blocked hold release row");
        this.hold = "open";
        return;
      case "blocked-gate": {
        const directive: BlockedGateDirective = { receiptId: textField(row, "receipt_id"), gate: gateFromRow(row.gate), reporterObserved: false };
        validateDirective(directive);
        this.assertGateMembership(directive.gate);
        if (this.activeGate !== undefined) throw new OwnershipJournalError("duplicate blocked gate row");
        this.activeGate = directive;
        this.hold = "permanent";
        return;
      }
      case "blocked-observation-arrived": {
        const receiptId = textField(row, "receipt_id");
        const latchId = textField(row, "latch_id");
        this.requireActiveGate(receiptId, latchId);
        const observation = observationFromRow(row.observation);
        if (observation.receipt_id !== receiptId) throw new OwnershipJournalError("blocked observation receipt drift");
        const key = gateKey(receiptId, latchId);
        if (this.observations.has(key)) throw new OwnershipJournalError("duplicate blocked observation row");
        this.observations.set(key, observation);
        return;
      }
      case "blocked-observation-observed": {
        const receiptId = textField(row, "receipt_id");
        const latchId = textField(row, "latch_id");
        this.requireActiveGate(receiptId, latchId);
        const key = gateKey(receiptId, latchId);
        if (this.observed.has(key)) throw new OwnershipJournalError("duplicate blocked observed row");
        this.observed.add(key);
        if (this.activeGate !== undefined) this.activeGate = { ...this.activeGate, reporterObserved: true };
        return;
      }
      case "blocked-cancelled": {
        const receiptId = textField(row, "receipt_id");
        const latchId = textField(row, "latch_id");
        const gate = this.requireActiveGate(receiptId, latchId);
        const cancellation = {
          task_id: textField(row, "task_id"),
          action_id: textField(row, "action_id"),
          assignment_id: textField(row, "assignment_id"),
          reporter: booleanField(row, "reporter"),
        };
        const member = gate.cancellations.find((item) => item.task_id === cancellation.task_id);
        const key = cancellationKey(receiptId, latchId, cancellation.task_id);
        if (member === undefined || !sameCancellation(member, cancellation) || this.cancellationRows.has(key)) throw new OwnershipJournalError("duplicate/conflicting blocked cancellation row");
        this.cancellationRows.add(key);
        return;
      }
      default: throw new OwnershipJournalError("journal row has an unsupported kind");
    }
  }

  private requireExactBinding(taskId: string, action: BackgroundAction): OwnedTaskBinding {
    const binding = this.owned.get(taskId);
    if (binding === undefined || binding.action.action_id !== action.action_id || binding.action.assignment_id !== action.assignment_id || binding.action.run_revision !== action.run_revision || binding.descriptor !== descriptorFor(action)) {
      throw new OwnershipJournalError(`task/action ownership correlation drift for task_id=${taskId}`);
    }
    return binding;
  }

  private requireCorrelationRow(row: JournalRow, label: string): OwnedTaskBinding {
    const taskId = textField(row, "task_id");
    const binding = this.owned.get(taskId);
    if (binding === undefined || textField(row, "action_id") !== binding.action.action_id || textField(row, "assignment_id") !== binding.action.assignment_id || numberField(row, "run_revision") !== binding.action.run_revision) throw new OwnershipJournalError(`${label} ownership correlation drift`);
    return binding;
  }

  private requireActiveGate(receiptId: string, latchId: string): ChildControlBlockedGate {
    if (this.activeGate === undefined || this.activeGate.receiptId !== receiptId || this.activeGate.gate.latch_id !== latchId) throw new OwnershipJournalError("blocked journal row lacks its exact active gate");
    return this.activeGate.gate;
  }

  private assertGateMembership(gate: ChildControlBlockedGate): void {
    const seen = new Set<string>();
    let reporters = 0;
    for (const cancellation of gate.cancellations) {
      if (seen.has(cancellation.task_id)) throw new OwnershipJournalError(`blocked gate repeats task id ${cancellation.task_id}`);
      seen.add(cancellation.task_id);
      const binding = this.owned.get(cancellation.task_id);
      if (binding === undefined || binding.action.action_id !== cancellation.action_id || binding.action.assignment_id !== cancellation.assignment_id) {
        throw new OwnershipJournalError(`blocked gate named task outside exact durable Host ownership: ${cancellation.task_id}`);
      }
      if (cancellation.reporter) reporters += 1;
    }
    if (reporters !== 1) throw new OwnershipJournalError("blocked gate must identify exactly one reporter");
  }

  private install(binding: OwnedTaskBinding): void {
    this.owned.set(binding.task.id, binding);
    this.actionTasks.set(binding.action.action_id, binding);
  }

  private replace(previous: OwnedTaskBinding, next: OwnedTaskBinding): void {
    if (this.owned.get(previous.task.id) !== previous || this.actionTasks.get(previous.action.action_id) !== previous) throw new OwnershipJournalError("in-memory ownership replacement drift");
    this.owned.set(next.task.id, next);
    this.actionTasks.set(next.action.action_id, next);
  }
}

interface FileIdentity { readonly dev: number; readonly ino: number; }
interface VerifiedJournalFile { readonly bytes: Buffer; readonly identity: FileIdentity; }

class OwnershipJournal {
  readonly path: string;
  private readonly chain: JournalRow[];
  private readonly identity: FileIdentity;

  private constructor(path: string, chain: JournalRow[], identity: FileIdentity) {
    this.path = path;
    this.chain = chain;
    this.identity = identity;
  }

  static open(stateRoot: string, sessionId: string): OwnershipJournal {
    const path = ownershipJournalPath(stateRoot, sessionId);
    ensureJournalDirectory(dirname(path));
    let verified: VerifiedJournalFile;
    try {
      verified = readVerifiedJournal(path);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      verified = { bytes: Buffer.alloc(0), identity: createJournal(path) };
    }
    if (verified.bytes.length > OWNERSHIP_JOURNAL_MAX_BYTES) throw new OwnershipJournalError("ownership journal exceeds hard byte bound");
    const chain = parseRows(verified.bytes);
    return new OwnershipJournal(path, chain, verified.identity);
  }

  rows(): readonly JournalRow[] { return this.chain; }

  append(kind: RowKind, payload: Record<string, unknown>): void {
    if (this.chain.length >= OWNERSHIP_JOURNAL_MAX_RECORDS) throw new OwnershipJournalError("ownership journal exceeds hard record-count bound");
    const previous = this.chain.at(-1)?.row_sha256 ?? ZERO_HASH;
    const preimage = { schema: OWNERSHIP_JOURNAL_SCHEMA, version: OWNERSHIP_JOURNAL_VERSION, sequence: this.chain.length + 1, previous_sha256: previous, kind, ...payload };
    const row = { ...preimage, row_sha256: sha256(canonicalJournalJson(preimage)) } as JournalRow;
    validateRow(row);
    const line = `${canonicalJournalJson(row)}\n`;
    const bytes = Buffer.from(line, "utf8");
    if (bytes.length > OWNERSHIP_JOURNAL_MAX_RECORD_BYTES) throw new OwnershipJournalError("ownership journal row exceeds hard byte bound");
    const currentBytes = this.chain.length === 0 ? 0 : journalFileSize(this.path, this.identity);
    if (currentBytes + bytes.length > OWNERSHIP_JOURNAL_MAX_BYTES) throw new OwnershipJournalError("ownership journal append exceeds hard byte bound");
    appendVerifiedJournal(this.path, this.identity, bytes);
    this.chain.push(row);
  }
}

function parseRows(bytes: Buffer): JournalRow[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0x0a) throw new OwnershipJournalError("ownership journal is truncated (missing final newline)");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new OwnershipJournalError("ownership journal is not valid UTF-8"); }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > OWNERSHIP_JOURNAL_MAX_RECORDS) throw new OwnershipJournalError("ownership journal exceeds hard record-count bound");
  const rows: JournalRow[] = [];
  let previous = ZERO_HASH;
  for (const [index, line] of lines.entries()) {
    const rowBytes = Buffer.byteLength(line, "utf8") + 1;
    if (line.length === 0 || rowBytes > OWNERSHIP_JOURNAL_MAX_RECORD_BYTES) throw new OwnershipJournalError("ownership journal has an empty or oversized row");
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new OwnershipJournalError(`ownership journal row ${index + 1} is malformed JSON`); }
    if (canonicalJournalJson(parsed) !== line) throw new OwnershipJournalError(`ownership journal row ${index + 1} is not canonical JSON`);
    const row = parsed as JournalRow;
    validateRow(row);
    if (row.sequence !== index + 1 || row.previous_sha256 !== previous) throw new OwnershipJournalError(`ownership journal row ${index + 1} sequence/hash-chain drift`);
    const { row_sha256: rowHash, ...preimage } = row;
    if (sha256(canonicalJournalJson(preimage)) !== rowHash) throw new OwnershipJournalError(`ownership journal row ${index + 1} hash drift`);
    previous = rowHash;
    rows.push(row);
  }
  return rows;
}

function validateRow(row: JournalRow): void {
  if (!isRecord(row) || row.schema !== OWNERSHIP_JOURNAL_SCHEMA || row.version !== OWNERSHIP_JOURNAL_VERSION || !Number.isInteger(row.sequence) || row.sequence < 1 || !isHash(row.previous_sha256) || !isHash(row.row_sha256)) throw new OwnershipJournalError("ownership journal row header is invalid");
  const fields: Record<RowKind, readonly string[]> = {
    "launch": ["schema", "version", "sequence", "previous_sha256", "kind", "task", "action", "action_descriptor", "action_sha256", "action_id", "assignment_id", "run_revision", "acknowledged", "row_sha256"],
    "launch-ack": ["schema", "version", "sequence", "previous_sha256", "kind", "task_id", "action_id", "assignment_id", "run_revision", "row_sha256"],
    "terminal-tombstone": ["schema", "version", "sequence", "previous_sha256", "kind", "task_id", "action_id", "assignment_id", "run_revision", "task", "status", "row_sha256"],
    "terminal-forwarded": ["schema", "version", "sequence", "previous_sha256", "kind", "task_id", "action_id", "assignment_id", "run_revision", "row_sha256"],
    "blocked-hold": ["schema", "version", "sequence", "previous_sha256", "kind", "row_sha256"],
    "blocked-hold-release": ["schema", "version", "sequence", "previous_sha256", "kind", "row_sha256"],
    "blocked-gate": ["schema", "version", "sequence", "previous_sha256", "kind", "receipt_id", "gate", "row_sha256"],
    "blocked-observation-arrived": ["schema", "version", "sequence", "previous_sha256", "kind", "receipt_id", "latch_id", "observation", "row_sha256"],
    "blocked-observation-observed": ["schema", "version", "sequence", "previous_sha256", "kind", "receipt_id", "latch_id", "row_sha256"],
    "blocked-cancelled": ["schema", "version", "sequence", "previous_sha256", "kind", "receipt_id", "latch_id", "task_id", "action_id", "assignment_id", "reporter", "row_sha256"],
  };
  if (!Object.prototype.hasOwnProperty.call(fields, row.kind)) throw new OwnershipJournalError("ownership journal row kind is invalid");
  assertExactKeys(row, fields[row.kind]);
  // Bound every arbitrary string before it can enter Host memory. Descriptor
  // and snapshot/action validation below keep nested values equally closed.
  assertBoundedStrings(row);
  switch (row.kind) {
    case "launch":
      actionFromRow(row);
      taskFromRow(row.task, "launch task");
      if (typeof row.action_descriptor !== "string" || !isHash(row.action_sha256) || typeof row.action_id !== "string" || typeof row.assignment_id !== "string" || typeof row.run_revision !== "number" || !Number.isInteger(row.run_revision) || row.run_revision < 0 || row.acknowledged !== false) throw new OwnershipJournalError("launch row fields are invalid");
      break;
    case "blocked-gate": validateDirective({ receiptId: textField(row, "receipt_id"), gate: gateFromRow(row.gate), reporterObserved: false }); break;
    case "blocked-observation-arrived": observationFromRow(row.observation); break;
    case "blocked-cancelled": if (typeof row.reporter !== "boolean") throw new OwnershipJournalError("blocked cancellation reporter is invalid"); break;
    default: break;
  }
}

function ensureJournalDirectory(path: string): void {
  const parent = dirname(path);
  // The configured activation root is the only recursive creation boundary;
  // both Host-owned descendants are created one segment at a time below.
  try { mkdirSync(parent, { recursive: true, mode: 0o700 }); }
  catch (error) { throw new OwnershipJournalError(`could not create ownership journal root ${parent}: ${errorMessage(error)}`); }
  ensurePrivateDirectory(parent, false);
  ensurePrivateDirectory(path, true);
}

function ensurePrivateDirectory(path: string, create: boolean): void {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (!isCode(error, "EEXIST")) throw new OwnershipJournalError(`could not create ownership journal directory ${path}: ${errorMessage(error)}`); }
  }
  const stat = lstatVerified(path, "ownership journal directory");
  if (!stat.isDirectory() || stat.uid !== effectiveUid() || (stat.mode & 0o777) !== 0o700) throw new OwnershipJournalError(`ownership journal directory ${path} is not an owner-only 0700 directory`);
  // New and existing journal directories are synchronization boundaries. This
  // is harmless for existing private directories and avoids a create gap.
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readVerifiedJournal(path: string): VerifiedJournalFile {
  const stat = lstatVerified(path, "ownership journal");
  if (!stat.isFile() || stat.uid !== effectiveUid() || (stat.mode & 0o777) !== 0o600) throw new OwnershipJournalError("ownership journal is not an owner-only 0600 regular file");
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const opened = fstatSync(fd);
    verifyFileStat(opened);
    return { bytes: readFileSync(fd), identity: fileIdentity(opened) };
  } finally { closeSync(fd); }
}

function createJournal(path: string): FileIdentity {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
  let identity: FileIdentity;
  try { const stat = fstatSync(fd); verifyFileStat(stat); identity = fileIdentity(stat); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), fsConstants.O_RDONLY | noFollowFlag());
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return identity!;
}

function appendVerifiedJournal(path: string, expected: FileIdentity, bytes: Buffer): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollowFlag());
  try {
    const stat = fstatSync(fd);
    verifyFileStat(stat);
    if (!sameFileIdentity(expected, stat)) throw new OwnershipJournalError("ownership journal append file identity drift");
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
      if (wrote <= 0) throw new OwnershipJournalError("ownership journal append made no progress");
      offset += wrote;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function journalFileSize(path: string, expected: FileIdentity): number {
  const stat = lstatVerified(path, "ownership journal");
  verifyFileStat(stat);
  if (!sameFileIdentity(expected, stat)) throw new OwnershipJournalError("ownership journal file identity drift");
  return stat.size;
}
function lstatVerified(path: string, label: string): Stats {
  try { return lstatSync(path); } catch (error) { throw error instanceof OwnershipJournalError ? error : error; }
}
function verifyFileStat(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== effectiveUid() || (stat.mode & 0o777) !== 0o600) throw new OwnershipJournalError("ownership journal file descriptor identity/mode drift");
}
function fileIdentity(stat: Stats): FileIdentity { return { dev: Number(stat.dev), ino: Number(stat.ino) }; }
function sameFileIdentity(expected: FileIdentity, stat: Stats): boolean { return expected.dev === Number(stat.dev) && expected.ino === Number(stat.ino); }
function noFollowFlag(): number { return fsConstants.O_NOFOLLOW ?? 0; }
function effectiveUid(): number {
  if (typeof process.geteuid !== "function") throw new OwnershipJournalError("ownership journal requires an effective uid");
  return process.geteuid();
}

function actionFromRow(row: Record<string, unknown>): BackgroundAction {
  try { return validateBackgroundAction(row.action); } catch (error) { throw new OwnershipJournalError(`ownership journal action is invalid: ${errorMessage(error)}`); }
}
function actionFromDescriptor(descriptor: string): BackgroundAction {
  let value: unknown;
  try { value = JSON.parse(descriptor); } catch { throw new OwnershipJournalError("ownership journal action descriptor is malformed JSON"); }
  if (JSON.stringify(value) !== descriptor) throw new OwnershipJournalError("ownership journal action descriptor is not exact JSON");
  try { return validateBackgroundAction(value); } catch (error) { throw new OwnershipJournalError(`ownership journal action descriptor is invalid: ${errorMessage(error)}`); }
}
function gateFromRow(value: unknown): ChildControlBlockedGate {
  if (!isRecord(value)) throw new OwnershipJournalError("ownership journal gate is not an object");
  assertExactKeys(value, ["schema", "latch_id", "run_id", "cancellations"]);
  if (value.schema !== "autopilot.child_control_blocked_gate.v1" || typeof value.latch_id !== "string" || typeof value.run_id !== "string" || !Array.isArray(value.cancellations) || value.cancellations.length === 0 || value.cancellations.length > OWNERSHIP_JOURNAL_MAX_RECORDS) throw new OwnershipJournalError("ownership journal gate is invalid");
  for (const item of value.cancellations) {
    if (!isRecord(item)) throw new OwnershipJournalError("ownership journal gate cancellation is invalid");
    assertExactKeys(item, ["task_id", "action_id", "assignment_id", "reporter"]);
    if (typeof item.task_id !== "string" || typeof item.action_id !== "string" || typeof item.assignment_id !== "string" || typeof item.reporter !== "boolean") throw new OwnershipJournalError("ownership journal gate cancellation fields are invalid");
  }
  return value as unknown as ChildControlBlockedGate;
}
function observationFromRow(value: unknown): BlockedObservationWire {
  if (!isRecord(value)) throw new OwnershipJournalError("ownership journal blocked observation is invalid");
  assertExactKeys(value, ["schema", "token", "run_id", "assignment_id", "attempt", "receipt_id", "tool_call_id"]);
  const observation = value as unknown as BlockedObservationWire;
  validateObservation(observation);
  return observation;
}
function taskFromRow(value: unknown, label: string): BgTaskSnapshot {
  if (!isRecord(value)) throw new OwnershipJournalError(`${label} is invalid`);
  assertExactKeys(value, ["id", "name", "command", "status", "outputPath", "isAgent", "notifyOnCompletion", "triggerOnCompletion", "timeoutSeconds"]);
  if (typeof value.id !== "string" || (value.name !== null && typeof value.name !== "string") || typeof value.command !== "string" || typeof value.status !== "string" || typeof value.outputPath !== "string" || (value.isAgent !== null && typeof value.isAgent !== "boolean") || (value.notifyOnCompletion !== null && typeof value.notifyOnCompletion !== "boolean") || (value.triggerOnCompletion !== null && typeof value.triggerOnCompletion !== "boolean") || (value.timeoutSeconds !== null && (typeof value.timeoutSeconds !== "number" || !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 0))) throw new OwnershipJournalError(`${label} fields are invalid`);
  return {
    id: value.id,
    ...(value.name === null ? {} : { name: value.name }),
    command: value.command,
    status: value.status as BgTaskSnapshot["status"],
    outputPath: value.outputPath,
    ...(value.isAgent === null ? {} : { isAgent: value.isAgent }),
    ...(value.notifyOnCompletion === null ? {} : { notifyOnCompletion: value.notifyOnCompletion }),
    ...(value.triggerOnCompletion === null ? {} : { triggerOnCompletion: value.triggerOnCompletion }),
    ...(value.timeoutSeconds === null ? {} : { timeoutSeconds: value.timeoutSeconds }),
  };
}
function journalTask(task: BgTaskSnapshot): Record<string, unknown> {
  const snapshot = snapshotForJournal(task);
  return {
    id: snapshot.id,
    name: typeof snapshot.name === "string" ? snapshot.name : null,
    command: snapshot.command,
    status: snapshot.status,
    outputPath: snapshot.outputPath,
    isAgent: typeof snapshot.isAgent === "boolean" ? snapshot.isAgent : null,
    notifyOnCompletion: typeof snapshot.notifyOnCompletion === "boolean" ? snapshot.notifyOnCompletion : null,
    triggerOnCompletion: typeof snapshot.triggerOnCompletion === "boolean" ? snapshot.triggerOnCompletion : null,
    timeoutSeconds: typeof snapshot.timeoutSeconds === "number" ? snapshot.timeoutSeconds : null,
  };
}
function assertTaskMatchesAction(task: BgTaskSnapshot, action: BackgroundAction): void {
  const descriptor = action.bg_run;
  if (task.command !== descriptor.command || task.name !== undefined && task.name !== descriptor.name || task.isAgent !== undefined && task.isAgent !== descriptor.isAgent || task.notifyOnCompletion !== undefined && task.notifyOnCompletion !== descriptor.notifyOnCompletion || task.triggerOnCompletion !== undefined && task.triggerOnCompletion !== descriptor.triggerOnCompletion || task.timeoutSeconds !== undefined && task.timeoutSeconds !== descriptor.timeoutSeconds) {
    throw new OwnershipJournalError(`background task ownership facts drift for task_id=${task.id} action_id=${action.action_id}`);
  }
}
function snapshotForJournal(task: BgTaskSnapshot): BgTaskSnapshot {
  if (typeof task.id !== "string" || typeof task.command !== "string" || typeof task.status !== "string" || typeof task.outputPath !== "string") throw new OwnershipJournalError("background run returned incomplete task ownership facts");
  return task;
}
function descriptorFor(action: BackgroundAction): string {
  try { validateBackgroundAction(action); } catch (error) { throw new OwnershipJournalError(`background action descriptor is invalid: ${errorMessage(error)}`); }
  const descriptor = JSON.stringify(action);
  if (descriptor === undefined || Buffer.byteLength(descriptor, "utf8") > OWNERSHIP_JOURNAL_MAX_RECORD_BYTES) throw new OwnershipJournalError("background action descriptor is unserializable or overbound");
  return descriptor;
}
function correlation(binding: OwnedTaskBinding): Record<string, unknown> {
  return { task_id: binding.task.id, action_id: binding.action.action_id, assignment_id: binding.action.assignment_id, run_revision: binding.action.run_revision };
}
function validateDirective(directive: BlockedGateDirective): void {
  if (typeof directive.receiptId !== "string" || directive.receiptId.length === 0 || typeof directive.reporterObserved !== "boolean") throw new OwnershipJournalError("blocked directive is invalid");
  gateFromRow(directive.gate);
}
function validateObservation(observation: BlockedObservationWire): void {
  if (observation.schema !== "autopilot.blocked_result_observed.v1" || typeof observation.token !== "string" || typeof observation.run_id !== "string" || typeof observation.assignment_id !== "string" || !Number.isInteger(observation.attempt) || observation.attempt < 0 || typeof observation.receipt_id !== "string" || typeof observation.tool_call_id !== "string") throw new OwnershipJournalError("blocked observation is invalid");
}
function sameBinding(left: OwnedTaskBinding, action: BackgroundAction, descriptor: string, task: BgTaskSnapshot): boolean {
  return left.action.action_id === action.action_id && left.action.assignment_id === action.assignment_id && left.action.run_revision === action.run_revision && left.descriptor === descriptor && canonicalJournalJson(journalTask(left.task)) === canonicalJournalJson(journalTask(task));
}
function sameCancellation(left: { readonly task_id: string; readonly action_id: string; readonly assignment_id: string; readonly reporter: boolean }, right: { readonly task_id: string; readonly action_id: string; readonly assignment_id: string; readonly reporter: boolean }): boolean {
  return left.task_id === right.task_id && left.action_id === right.action_id && left.assignment_id === right.assignment_id && left.reporter === right.reporter;
}
function sameDirective(left: BlockedGateDirective, right: BlockedGateDirective): boolean {
  // reporter_observed is a durable Core state transition after the immutable
  // receipt/gate identity; it may advance during reconciliation.
  return left.receiptId === right.receiptId && left.gate.latch_id === right.gate.latch_id && left.gate.run_id === right.gate.run_id && canonicalJournalJson(left.gate) === canonicalJournalJson(right.gate);
}
function gateKey(receiptId: string, latchId: string): string { return `${receiptId}\u0000${latchId}`; }
function cancellationKey(receiptId: string, latchId: string, taskId: string): string { return `${receiptId}\u0000${latchId}\u0000${taskId}`; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function textField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) throw new OwnershipJournalError(`ownership journal ${field} is invalid`);
  return candidate;
}
function numberField(value: Record<string, unknown>, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0) throw new OwnershipJournalError(`ownership journal ${field} is invalid`);
  return candidate;
}
function booleanField(value: Record<string, unknown>, field: string): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") throw new OwnershipJournalError(`ownership journal ${field} is invalid`);
  return candidate;
}
function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) throw new OwnershipJournalError("ownership journal row is not closed");
}
function assertBoundedStrings(value: unknown): void {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > OWNERSHIP_JOURNAL_MAX_STRING_BYTES) throw new OwnershipJournalError("ownership journal string exceeds hard bound");
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertBoundedStrings(item); return; }
  if (isRecord(value)) for (const item of Object.values(value)) assertBoundedStrings(item);
}
function assertBareSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]+$/u.test(sessionId)) throw new OwnershipJournalError("ownership journal requires an exact bare Pi session identity");
}
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
