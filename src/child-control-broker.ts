import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import type {
  BlockedReconcileRecord,
  ChildControlBlockedGate,
  ChildControlRequest,
  ChildControlResponse,
  CoreToHostBlockedResultObservedPayload,
  CoreToHostChildControlPayload,
  CoreToHostFrame,
  HostToCoreBlockedResultObservedPayload,
  HostToCoreChildControlPayload,
} from "./generated/index.ts";
import type { BlockedGateDirective, BlockedObservationWire } from "./ownership-journal.ts";
import { validateCoreToHostFrame } from "./generated/frame-validation.ts";

/** The sole, fixed parent for Host-owned child-control AF_UNIX sockets. */
export const CHILD_CONTROL_BROKER_ROOT = "/tmp/.pi-ap";
/** Matches the generated runner/RPC terminal frame ceiling. */
export const CHILD_CONTROL_BROKER_MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** A bounded process-local hold for reporter-last observations. */
export const CHILD_CONTROL_BROKER_MAX_PENDING_OBSERVATIONS = 100;

export interface ChildControlBrokerLaunchFacts {
  readonly socketPath: string;
  /** A Host/Core-only 256-bit capability. Never send this to a model. */
  readonly capability: string;
}

export interface ChildControlBrokerTransport {
  request(kind: "child-control", payload: HostToCoreChildControlPayload): Promise<CoreToHostFrame>;
  request(kind: "blocked-result-observed", payload: HostToCoreBlockedResultObservedPayload): Promise<CoreToHostFrame>;
}

export interface BlockedGateApplication {
  /** The one already-validated Host-owned reporter from this Core gate. */
  readonly reporterTaskId: string;
  /** Must run only after the accepted child response frame was written. */
  afterChildResponseWritten(): Promise<void>;
  /** Persist this exact outer-runner observation before forwarding it to Core. */
  blockedObservationArrived(observation: BlockedObservationWire): Promise<void>;
  /** Exact arrived observation restored from the Host journal, if any. */
  restoredBlockedObservation(): BlockedObservationWire | undefined;
  /** Must run only after the exact Core observation acknowledgment. */
  afterBlockedResultAcknowledged(): Promise<void>;
}

export interface ChildControlBrokerDiagnostic {
  /** Secret-free machine category; never a frame, token, or capability. */
  readonly code: string;
  /** Saturating count for this category in this broker lifetime. */
  readonly count: number;
}

export interface ChildControlBrokerOptions {
  readonly transport: ChildControlBrokerTransport;
  /**
   * Host-only cancellation hook. It closes the lifecycle launch gate and
   * verifies Host task jurisdiction before the child receives ACCEPT.
   */
  readonly applyBlockedGate?: (directive: BlockedGateDirective) => Promise<BlockedGateApplication>;
  /** Scheduling-only hold: no child semantics are inspected by this hook. */
  readonly beforeBlockedForward?: () => Promise<void>;
  /** Explicit Core RETRY is the sole reversible-hold release authority. */
  readonly releaseBlockedHoldOnRetry?: () => void;
  /** Host-owned, bounded diagnostic state receives only secret-free codes. */
  readonly onConnectionFailure?: (diagnostic: ChildControlBrokerDiagnostic) => void;
}

export interface ChildControlBroker {
  readonly socketPath: string;
  readonly launchFacts: ChildControlBrokerLaunchFacts;
  /**
   * Wave 6 reconciliation entrypoint. A future Core replay supplies the same
   * typed directive; Host does not invent a latch or a cancellation set.
   */
  reconcileBlockedGate(record: BlockedReconcileRecord): Promise<void>;
  stop(): Promise<void>;
}

export class ChildControlBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildControlBrokerError";
  }
}

export class ChildControlBrokerProtocolError extends ChildControlBrokerError {
  constructor(message: string) {
    super(message);
    this.name = "ChildControlBrokerProtocolError";
  }
}

/** The nested child never has the Host/Core broker capability. */
export type ChildBlockedResultObservedWire = Omit<HostToCoreBlockedResultObservedPayload, "broker_capability">;
type WireRequest =
  | { readonly kind: "child-control"; readonly request: ChildControlRequest }
  | { readonly kind: "blocked-result-observed"; readonly observation: ChildBlockedResultObservedWire };

interface InFlightCall {
  fail(error: Error): void;
}

interface PendingBlockedObservation {
  readonly key: string;
  readonly receiptId: string;
  readonly latchId: string;
  readonly reporterTaskId: string;
  readonly gate: ChildControlBlockedGate;
  readonly directive: BlockedGateDirective;
  readonly application: BlockedGateApplication;
  /** Rejections reset: an exact replay/reconcile retries the same ids. */
  cancelNonReporters(): Promise<void>;
  cancelReporter(): Promise<void>;
  forwardObservation(observation: BlockedObservationWire, forward: () => Promise<void>): Promise<void>;
}

interface PendingBlockedAdmissions {
  readonly pending: Promise<PendingBlockedObservation>;
  readonly receiptId: string;
  readonly latchId: string;
  readonly reporterTaskId: string;
  readonly gate: ChildControlBlockedGate;
}

/**
 * Starts one activation-scoped, private AF_UNIX broker. This function is never
 * called at module load: extension lifecycle activation owns that decision.
 */
export async function startChildControlBroker(options: ChildControlBrokerOptions): Promise<ChildControlBroker> {
  ensurePrivateDirectory(CHILD_CONTROL_BROKER_ROOT, true);
  let directory: string | undefined;
  let socketPath: string | undefined;
  let launchFacts: ChildControlBrokerLaunchFacts | undefined;
  const connections = new Set<Socket>();
  const inFlight = new Set<InFlightCall>();
  const pendingObservations = new Map<string, PendingBlockedObservation>();
  const pendingByReceipt = new Map<string, PendingBlockedObservation>();
  const pendingAdmissions = new Map<string, PendingBlockedAdmissions>();
  const diagnostics = new Map<string, number>();
  const noteConnectionFailure = (error: unknown): void => {
    const code = connectionFailureCode(error);
    const next = Math.min(100, (diagnostics.get(code) ?? 0) + 1);
    diagnostics.set(code, next);
    options.onConnectionFailure?.({ code, count: next });
  };
  let accepting = true;
  let stopPromise: Promise<void> | undefined;
  let server: Server | undefined;

  try {
    directory = createFreshBrokerDirectory();
    socketPath = join(directory, "s");
    assertAbsent(socketPath);
    launchFacts = {
      socketPath,
      capability: randomBytes(32).toString("hex"),
    };
    const brokerCapability = launchFacts.capability;
    server = createServer({ allowHalfOpen: true }, (socket) => {
      connections.add(socket);
      socket.unref();
      void handleConnection(
        socket,
        options,
        brokerCapability,
        () => accepting,
        inFlight,
        pendingObservations,
        pendingByReceipt,
        pendingAdmissions,
        noteConnectionFailure,
      ).then(
        () => connections.delete(socket),
        (error: unknown) => {
          connections.delete(socket);
          noteConnectionFailure(error);
          socket.destroy();
        },
      );
    });
    server.unref();
    await listen(server, socketPath);
    // This is a newly bound socket in our freshly-created private directory;
    // chmod is initialization, never repair of a preexisting object.
    chmodSync(socketPath, 0o600);
    ensurePrivateSocket(socketPath);
  } catch (error) {
    const listeningServer = server !== undefined && server.listening ? server : undefined;
    const closeFailure = listeningServer === undefined ? undefined : await failureOf(() => closeServer(listeningServer));
    const ownedDirectory = directory;
    const cleanupFailure = ownedDirectory === undefined ? undefined : failureOfSync(() => cleanupOwnedBrokerDirectory(ownedDirectory));
    throw combinedBrokerError("could not bind the required child-control AF_UNIX socket", error, closeFailure, cleanupFailure);
  }

  if (server === undefined || socketPath === undefined || launchFacts === undefined || directory === undefined) {
    throw new ChildControlBrokerError("child-control broker startup completed without owned launch facts");
  }
  const liveServer = server;
  const liveSocketPath = socketPath;
  const liveDirectory = directory;
  const liveBrokerCapability = launchFacts.capability;
  return {
    socketPath: liveSocketPath,
    launchFacts,
    async reconcileBlockedGate(record: BlockedReconcileRecord): Promise<void> {
      if (!accepting) throw new ChildControlBrokerError("child-control broker is stopped");
      const blocked = blockedReconcileCorrelation(record);
      const pending = await acquirePendingBlockedObservation(
        blocked,
        record.blocked_gate,
        record.reporter_observed,
        options.applyBlockedGate,
        pendingObservations,
        pendingByReceipt,
        pendingAdmissions,
      );
      await pending.cancelNonReporters();
      if (record.reporter_observed) {
        await pending.cancelReporter();
        return;
      }
      const restored = pending.application.restoredBlockedObservation();
      if (restored !== undefined) {
        await pending.forwardObservation(restored, async () => {
          const frame = validateCoreToHostFrame(await options.transport.request("blocked-result-observed", {
            broker_capability: liveBrokerCapability,
            ...restored,
          }));
          validateBlockedResultObservedAcknowledgment(frame, pending);
        });
      }
    },
    stop(): Promise<void> {
      if (stopPromise === undefined) {
        stopPromise = stopBroker(liveServer, connections, inFlight, liveSocketPath, liveDirectory, () => { accepting = false; });
      }
      return stopPromise;
    },
  };
}

/** Idempotent convenience wrapper for lifecycle callers. */
export async function stopChildControlBroker(broker: ChildControlBroker | undefined): Promise<void> {
  if (broker !== undefined) await broker.stop();
}

/**
 * The one submit bridge path. It accepts no Core effect other than
 * child-control and does not admit or normalize any child payload.
 */
export async function forwardToCore(
  transport: ChildControlBrokerTransport,
  request: ChildControlRequest,
  brokerCapability: string,
): Promise<CoreToHostChildControlPayload> {
  const frame = validateCoreToHostFrame(await transport.request("child-control", {
    broker_capability: brokerCapability,
    request,
  }));
  if (frame.kind !== "child-control") {
    throw new ChildControlBrokerProtocolError(`child-control request received Core effect ${frame.kind}`);
  }
  const payload = frame.payload;
  validateChildControlResponseCorrelation(payload.response, request);
  return payload;
}

async function handleConnection(
  socket: Socket,
  options: ChildControlBrokerOptions,
  brokerCapability: string,
  accepting: () => boolean,
  inFlight: Set<InFlightCall>,
  pendingObservations: Map<string, PendingBlockedObservation>,
  pendingByReceipt: Map<string, PendingBlockedObservation>,
  pendingAdmissions: Map<string, PendingBlockedAdmissions>,
  noteConnectionFailure: (error: unknown) => void,
): Promise<void> {
  let pending: PendingBlockedObservation | undefined;
  let blockedForward = false;
  try {
    if (!accepting()) throw new ChildControlBrokerError("child-control broker is stopped");
    const wire = await readExactlyOneFrame(socket);
    const request = parseWireRequest(wire);
    if (!accepting()) throw new ChildControlBrokerError("child-control broker is stopped");

    if (request.kind === "blocked-result-observed") {
      await forwardBlockedResultObserved(
        options.transport,
        request.observation,
        brokerCapability,
        inFlight,
        socket,
        pendingObservations,
        pendingByReceipt,
      );
      return;
    }

    if (request.request.kind === "blocked") {
      blockedForward = true;
      await options.beforeBlockedForward?.();
    }
    const payload = await withInFlight(
      inFlight,
      socket,
      () => forwardToCore(options.transport, request.request, brokerCapability),
    );
    const response = payload.response;
    const gate = payload.blocked_gate;
    validateRequestReceiptGateCorrelation(request.request, response, gate);
    if (gate !== null) {
      const blocked = blockedResponseCorrelation(response, gate);
      pending = await acquirePendingBlockedObservation(
        blocked,
        gate,
        false,
        options.applyBlockedGate,
        pendingObservations,
        pendingByReceipt,
        pendingAdmissions,
      );
    }

    // The only bytes the nested child can observe are its generated response.
    await writeFrame(socket, response);
    // Only a completely written explicit Core RETRY releases the scheduling
    // hold. Transport, frame, and write ambiguity stays fail-closed.
    if (blockedForward && response.outcome === "RETRY") options.releaseBlockedHoldOnRetry?.();
    if (pending !== undefined) await pending.cancelNonReporters();
  } catch (error) {
    // A pre- or post-write fault never removes a pending gate. The application
    // already retained its provisional/permanent durable hold; exact replay or
    // reconciliation is the sole retry path.
    // The generated client treats this close as RETRY. Keep only a bounded
    // secret-free machine code on the Host; never turn an infrastructure fault
    // into a child-visible admission response.
    noteConnectionFailure(error);
    socket.destroy();
  }
}

async function forwardBlockedResultObserved(
  transport: ChildControlBrokerTransport,
  observation: ChildBlockedResultObservedWire,
  brokerCapability: string,
  inFlight: Set<InFlightCall>,
  socket: Socket,
  _pendingObservations: Map<string, PendingBlockedObservation>,
  pendingByReceipt: Map<string, PendingBlockedObservation>,
): Promise<void> {
  const pending = pendingByReceipt.get(observation.receipt_id);
  if (pending === undefined) throw new ChildControlBrokerProtocolError("blocked-result-observed receipt has no pending Host reporter");
  await pending.forwardObservation(observation as BlockedObservationWire, async () => {
    const frame = validateCoreToHostFrame(await withInFlight(inFlight, socket, () => transport.request("blocked-result-observed", {
      broker_capability: brokerCapability,
      ...observation,
    })));
    validateBlockedResultObservedAcknowledgment(frame, pending);
  });
  // This outer-runner observation has no nested-model response. A clean close
  // is its only success signal; malformed/unavailable paths close identically.
  await endSocket(socket);
}

function validateBlockedResultObservedAcknowledgment(
  frame: CoreToHostFrame,
  pending: PendingBlockedObservation,
): CoreToHostBlockedResultObservedPayload {
  if (frame.kind !== "blocked-result-observed") {
    throw new ChildControlBrokerProtocolError(`blocked-result-observed received Core effect ${frame.kind}`);
  }
  const payload = frame.payload;
  if (
    payload.schema !== "autopilot.blocked_result_observed_ack.v1"
    || payload.status !== "acknowledged"
    || payload.receipt_id !== pending.receiptId
    || payload.latch_id !== pending.latchId
    || payload.reporter_task_id !== pending.reporterTaskId
  ) {
    throw new ChildControlBrokerProtocolError("blocked-result-observed acknowledgment correlation drift");
  }
  return payload;
}

function validateChildControlResponseCorrelation(response: ChildControlResponse, request: ChildControlRequest): void {
  if (!isRecord(response) || response.schema !== "autopilot.child_control_response.v1" || response.request_id !== request.request_id) {
    throw new ChildControlBrokerProtocolError("child-control response request/schema drift");
  }
  if (response.outcome === "RETRY") {
    if (!isRecord(response.diagnostic) || response.diagnostic.schema !== "autopilot.submit_diagnostic.v1") {
      throw new ChildControlBrokerProtocolError("child-control RETRY diagnostic schema drift");
    }
    return;
  }
  if (
    response.outcome !== "ACCEPT"
    || !isRecord(response.receipt)
    || response.receipt.schema !== "autopilot.child_control_accept_receipt.v1"
    || (response.receipt.kind !== "submit" && response.receipt.kind !== "blocked" && response.receipt.kind !== "checkpoint")
    || !isRecord(response.receipt.receipt)
  ) {
    throw new ChildControlBrokerProtocolError("child-control response is not a generated ACCEPT or RETRY");
  }
  // Receipt fields retain the original accepted transport correlation on an
  // idempotent replay. The response's request_id above is the current wire
  // correlation; Host must not reject Core's receipt alias as a new admission.
}

function validateRequestReceiptGateCorrelation(
  request: ChildControlRequest,
  response: ChildControlResponse,
  gate: ChildControlBlockedGate | null,
): void {
  if (response.outcome === "RETRY") {
    if (gate !== null) throw new ChildControlBrokerProtocolError("child-control RETRY must not carry a blocked gate");
    return;
  }
  if (request.kind === "blocked") {
    if (response.receipt.kind !== "blocked" || gate === null) {
      throw new ChildControlBrokerProtocolError("blocked request requires a blocked ACCEPT receipt and exact blocked gate");
    }
    return;
  }
  if (request.kind === "submit") {
    if (response.receipt.kind !== "submit" || gate !== null) {
      throw new ChildControlBrokerProtocolError("submit request requires a submit ACCEPT receipt and no blocked gate");
    }
    return;
  }
  if (request.kind === "checkpoint") {
    if (response.receipt.kind !== "checkpoint" || gate !== null) {
      throw new ChildControlBrokerProtocolError("checkpoint request requires a checkpoint ACCEPT receipt and no blocked gate");
    }
    return;
  }
  throw new ChildControlBrokerProtocolError("child-control request kind is invalid");
}

function blockedResponseCorrelation(
  response: ChildControlResponse,
  gate: ChildControlBlockedGate,
): { readonly receiptId: string; readonly latchId: string; readonly reporterTaskId: string } {

  if (response.outcome !== "ACCEPT" || response.receipt.kind !== "blocked") {
    throw new ChildControlBrokerProtocolError("blocked_gate requires an accepted blocked child-control response");
  }
  validateGateWire(gate);
  const receipt = response.receipt.receipt;
  if (!isRecord(receipt)) throw new ChildControlBrokerProtocolError("blocked_gate response has no blocked receipt id");
  assertClosedRequired(receipt, [
    "schema", "receipt_id", "run_id", "run_revision", "workstream", "action_id", "assignment_id", "attempt", "profile_id", "tool_name", "request_id", "tool_call_id", "report_digest", "reason_code", "cancellation_set_digest",
  ], "blocked receipt");
  validateBlockedReceiptWire(receipt as Record<string, unknown>);
  if (receipt.run_id !== gate.run_id) {
    throw new ChildControlBrokerProtocolError("blocked_gate receipt/gate run correlation drift");
  }
  const reporters = gate.cancellations.filter((cancellation) => cancellation.reporter);
  const reporter = reporters[0];
  if (reporters.length !== 1 || reporter === undefined || typeof gate.latch_id !== "string" || gate.latch_id.length === 0) {
    throw new ChildControlBrokerProtocolError("blocked_gate must identify one reporter and one latch");
  }
  return { receiptId: receipt.receipt_id, latchId: gate.latch_id, reporterTaskId: reporter.task_id };
}

function blockedReconcileCorrelation(record: BlockedReconcileRecord): { readonly receiptId: string; readonly latchId: string; readonly reporterTaskId: string } {
  if (!isRecord(record) || record.schema !== "autopilot.blocked_reconcile_record.v1" || typeof record.reporter_observed !== "boolean" || !isRecord(record.blocked_receipt)) {
    throw new ChildControlBrokerProtocolError("blocked-reconcile record is not closed/generated");
  }
  assertClosedRequired(record, ["schema", "blocked_receipt", "blocked_gate", "reporter_observed"], "blocked-reconcile record");
  const receipt = record.blocked_receipt;
  assertClosedRequired(receipt as unknown as Record<string, unknown>, [
    "schema", "receipt_id", "run_id", "run_revision", "workstream", "action_id", "assignment_id", "attempt", "profile_id", "tool_name", "request_id", "tool_call_id", "report_digest", "reason_code", "cancellation_set_digest",
  ], "blocked-reconcile receipt");
  validateGateWire(record.blocked_gate);
  validateBlockedReceiptWire(receipt as unknown as Record<string, unknown>);
  if (receipt.run_id !== record.blocked_gate.run_id) {
    throw new ChildControlBrokerProtocolError("blocked-reconcile receipt/gate correlation drift");
  }
  const reporters = record.blocked_gate.cancellations.filter((item) => item.reporter);
  const reporter = reporters[0];
  if (reporters.length !== 1 || reporter === undefined) throw new ChildControlBrokerProtocolError("blocked-reconcile gate must identify one reporter");
  return { receiptId: receipt.receipt_id, latchId: record.blocked_gate.latch_id, reporterTaskId: reporter.task_id };
}

function validateBlockedReceiptWire(receipt: Record<string, unknown>): void {
  const strings = ["receipt_id", "run_id", "workstream", "action_id", "assignment_id", "profile_id", "tool_name", "request_id", "tool_call_id", "report_digest", "reason_code", "cancellation_set_digest"] as const;
  if (receipt.schema !== "autopilot.blocked_receipt.v1") throw new ChildControlBrokerProtocolError("blocked receipt schema drift");
  for (const field of strings) {
    if (typeof receipt[field] !== "string" || receipt[field].length === 0) throw new ChildControlBrokerProtocolError(`blocked receipt ${field} drift`);
  }
  if (typeof receipt.run_revision !== "number" || !Number.isInteger(receipt.run_revision) || receipt.run_revision < 0 || typeof receipt.attempt !== "number" || !Number.isInteger(receipt.attempt) || receipt.attempt < 0) throw new ChildControlBrokerProtocolError("blocked receipt revision/attempt drift");
}

function validateGateWire(gate: ChildControlBlockedGate): void {
  if (!isRecord(gate) || gate.schema !== "autopilot.child_control_blocked_gate.v1" || typeof gate.latch_id !== "string" || gate.latch_id.length === 0 || typeof gate.run_id !== "string" || gate.run_id.length === 0 || !Array.isArray(gate.cancellations) || gate.cancellations.length === 0 || gate.cancellations.length > CHILD_CONTROL_BROKER_MAX_PENDING_OBSERVATIONS) {
    throw new ChildControlBrokerProtocolError("blocked gate is malformed");
  }
  const seen = new Set<string>();
  for (const cancellation of gate.cancellations) {
    if (!isRecord(cancellation)) throw new ChildControlBrokerProtocolError("blocked gate cancellation is malformed");
    assertClosedRequired(cancellation, ["task_id", "action_id", "assignment_id", "reporter"], "blocked gate cancellation");
    if (typeof cancellation.task_id !== "string" || cancellation.task_id.length === 0 || typeof cancellation.action_id !== "string" || cancellation.action_id.length === 0 || typeof cancellation.assignment_id !== "string" || cancellation.assignment_id.length === 0 || typeof cancellation.reporter !== "boolean" || seen.has(cancellation.task_id)) {
      throw new ChildControlBrokerProtocolError("blocked gate cancellation correlation drift");
    }
    seen.add(cancellation.task_id);
  }
}

async function acquirePendingBlockedObservation(
  blocked: { readonly receiptId: string; readonly latchId: string; readonly reporterTaskId: string },
  gate: ChildControlBlockedGate,
  reporterObserved: boolean,
  apply: ChildControlBrokerOptions["applyBlockedGate"],
  pendingObservations: Map<string, PendingBlockedObservation>,
  pendingByReceipt: Map<string, PendingBlockedObservation>,
  pendingAdmissions: Map<string, PendingBlockedAdmissions>,
): Promise<PendingBlockedObservation> {
  const key = blockedObservationKey(blocked.receiptId, blocked.latchId);
  const existing = pendingObservations.get(key);
  if (existing !== undefined) {
    assertSamePendingObservation(existing, blocked, gate);
    return existing;
  }
  const receiptPending = pendingByReceipt.get(blocked.receiptId);
  if (receiptPending !== undefined) throw new ChildControlBrokerProtocolError("blocked receipt is already paired with a different latch");
  const admission = pendingAdmissions.get(key);
  if (admission !== undefined) {
    assertSamePendingAdmission(admission, blocked, gate);
    return admission.pending;
  }
  for (const queued of pendingAdmissions.values()) {
    if (queued.receiptId === blocked.receiptId) throw new ChildControlBrokerProtocolError("blocked receipt is already being paired with a different latch");
  }
  if (pendingObservations.size + pendingAdmissions.size >= CHILD_CONTROL_BROKER_MAX_PENDING_OBSERVATIONS) throw new ChildControlBrokerError("child-control pending blocked-observation capacity is exhausted");
  if (apply === undefined) throw new ChildControlBrokerProtocolError("blocked_gate received without a Host gate hook");
  const directive: BlockedGateDirective = { receiptId: blocked.receiptId, gate, reporterObserved };
  const pendingPromise = (async (): Promise<PendingBlockedObservation> => {
    const application = await apply(directive);
    if (application.reporterTaskId !== blocked.reporterTaskId) throw new ChildControlBrokerProtocolError("blocked gate reporter is outside the exact Host-owned reporter binding");
    const byReceipt = pendingByReceipt.get(blocked.receiptId);
    if (byReceipt !== undefined) throw new ChildControlBrokerProtocolError("blocked receipt is already paired with a different latch");
    let nonReporterAttempt: Promise<void> | undefined;
    let reporterAttempt: Promise<void> | undefined;
    let observationAttempt: Promise<void> | undefined;
    let arrivedObservation: BlockedObservationWire | undefined;
    let nonReportersCancelled = false;
    let reporterCancelled = false;
    const cancelNonReporters = (): Promise<void> => {
      if (nonReportersCancelled) return Promise.resolve();
      if (nonReporterAttempt !== undefined) return nonReporterAttempt;
      nonReporterAttempt = Promise.resolve().then(application.afterChildResponseWritten).then(
        () => { nonReporterAttempt = undefined; nonReportersCancelled = true; },
        (error: unknown) => { nonReporterAttempt = undefined; throw error; },
      );
      return nonReporterAttempt;
    };
    const cancelReporter = (): Promise<void> => {
      if (reporterCancelled) return Promise.resolve();
      if (reporterAttempt !== undefined) return reporterAttempt;
      reporterAttempt = cancelNonReporters().then(application.afterBlockedResultAcknowledged).then(
        () => { reporterAttempt = undefined; reporterCancelled = true; },
        (error: unknown) => { reporterAttempt = undefined; throw error; },
      );
      return reporterAttempt;
    };
    const forwardObservation = async (observation: BlockedObservationWire, forward: () => Promise<void>): Promise<void> => {
      // Persist/compare every outer observation before joining an in-flight
      // attempt. A different authenticated identity must never borrow a clean
      // success signal from the first connection.
      await application.blockedObservationArrived(observation);
      if (arrivedObservation !== undefined && !sameBlockedObservation(arrivedObservation, observation)) {
        throw new ChildControlBrokerProtocolError("blocked-result-observed correlation drift during an in-flight attempt");
      }
      if (arrivedObservation === undefined) arrivedObservation = observation;
      if (observationAttempt !== undefined) return observationAttempt;
      observationAttempt = Promise.resolve().then(async () => {
        await cancelNonReporters();
        await forward();
        await cancelReporter();
      }).then(
        () => { observationAttempt = undefined; },
        (error: unknown) => { observationAttempt = undefined; throw error; },
      );
      return observationAttempt;
    };
    const pending: PendingBlockedObservation = {
      key,
      ...blocked,
      gate,
      directive,
      application,
      cancelNonReporters,
      cancelReporter,
      forwardObservation,
    };
    pendingObservations.set(key, pending);
    pendingByReceipt.set(blocked.receiptId, pending);
    return pending;
  })();
  pendingAdmissions.set(key, { pending: pendingPromise, ...blocked, gate });
  try { return await pendingPromise; } finally { pendingAdmissions.delete(key); }
}

function assertSamePendingObservation(
  pending: PendingBlockedObservation,
  blocked: { readonly receiptId: string; readonly latchId: string; readonly reporterTaskId: string },
  gate: ChildControlBlockedGate,
): void {
  if (pending.receiptId !== blocked.receiptId || pending.latchId !== blocked.latchId || pending.reporterTaskId !== blocked.reporterTaskId || !sameBlockedGate(pending.gate, gate)) {
    throw new ChildControlBrokerProtocolError("blocked receipt/latch pending correlation drift");
  }
}

function assertSamePendingAdmission(
  pending: PendingBlockedAdmissions,
  blocked: { readonly receiptId: string; readonly latchId: string; readonly reporterTaskId: string },
  gate: ChildControlBlockedGate,
): void {
  if (pending.receiptId !== blocked.receiptId || pending.latchId !== blocked.latchId || pending.reporterTaskId !== blocked.reporterTaskId || !sameBlockedGate(pending.gate, gate)) {
    throw new ChildControlBrokerProtocolError("blocked receipt/latch admission correlation drift");
  }
}

function sameBlockedObservation(left: BlockedObservationWire, right: BlockedObservationWire): boolean {
  return left.schema === right.schema
    && left.token === right.token
    && left.run_id === right.run_id
    && left.assignment_id === right.assignment_id
    && left.attempt === right.attempt
    && left.receipt_id === right.receipt_id
    && left.tool_call_id === right.tool_call_id;
}

function sameBlockedGate(left: ChildControlBlockedGate, right: ChildControlBlockedGate): boolean {
  return left.schema === right.schema
    && left.latch_id === right.latch_id
    && left.run_id === right.run_id
    && left.cancellations.length === right.cancellations.length
    && left.cancellations.every((cancellation, index) => {
      const other = right.cancellations[index];
      return other !== undefined
        && other.task_id === cancellation.task_id
        && other.action_id === cancellation.action_id
        && other.assignment_id === cancellation.assignment_id
        && other.reporter === cancellation.reporter;
    });
}

async function readExactlyOneFrame(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let expected: number | undefined;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.on("error", (error) => fail(new ChildControlBrokerError(`child-control socket error: ${error.message}`)));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (total + chunk.length > CHILD_CONTROL_BROKER_MAX_FRAME_BYTES + 4) {
        fail(new ChildControlBrokerProtocolError("child-control frame exceeds the hard ceiling"));
        return;
      }
      total += chunk.length;
      chunks.push(chunk);
      if (expected === undefined && total >= 4) {
        const all = Buffer.concat(chunks, total);
        expected = all.readUInt32BE(0);
        if (expected === 0 || expected > CHILD_CONTROL_BROKER_MAX_FRAME_BYTES) {
          fail(new ChildControlBrokerProtocolError("child-control frame length is invalid"));
          return;
        }
      }
      if (expected !== undefined && total > expected + 4) {
        fail(new ChildControlBrokerProtocolError("child-control connection carried extra frame data"));
      }
    });
    socket.on("end", () => {
      if (settled) return;
      if (expected === undefined || total !== expected + 4) {
        fail(new ChildControlBrokerProtocolError("child-control frame was truncated"));
        return;
      }
      const bytes = Buffer.concat(chunks, total).subarray(4);
      try {
        const text = bytes.toString("utf8");
        const parsed: unknown = JSON.parse(text);
        settled = true;
        resolve(parsed);
      } catch (error) {
        fail(new ChildControlBrokerProtocolError(`child-control frame is not valid JSON: ${errorMessage(error)}`));
      }
    });
  });
}

function parseWireRequest(value: unknown): WireRequest {
  const record = requireRecord(value, "child-control request");
  const schema = record.schema;
  if (schema === "autopilot.child_control_request.v1") {
    assertClosedRequired(record, [
      "schema", "request_id", "token", "run_id", "assignment_id", "attempt", "tool_call_id", "kind", "tool_name", "profile_id", "raw_payload", "runtime_evidence",
    ], "child-control request");
    // Core owns field/type/semantic admission. The broker deliberately checks
    // only the closed wire envelope and forwards this parsed JSON tree exactly.
    return { kind: "child-control", request: record as unknown as ChildControlRequest };
  }
  if (schema === "autopilot.blocked_result_observed.v1") {
    assertClosedRequired(record, [
      "schema", "token", "run_id", "assignment_id", "attempt", "receipt_id", "tool_call_id",
    ], "blocked-result-observed request");
    return { kind: "blocked-result-observed", observation: record as ChildBlockedResultObservedWire };
  }
  throw new ChildControlBrokerProtocolError("child-control request schema is unknown");
}

async function writeFrame(socket: Socket, value: ChildControlResponse): Promise<void> {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length === 0 || json.length > CHILD_CONTROL_BROKER_MAX_FRAME_BYTES) {
    throw new ChildControlBrokerProtocolError("child-control response frame exceeds the hard ceiling");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.length, 0);
  await endSocket(socket, Buffer.concat([header, json]));
}

function endSocket(socket: Socket, bytes?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error | null): void => {
      if (error == null) resolve();
      else reject(new ChildControlBrokerError(`child-control socket write failed: ${error.message}`));
    };
    if (bytes === undefined) socket.end(done);
    else socket.end(bytes, done);
  });
}

async function withInFlight<T>(
  inFlight: Set<InFlightCall>,
  socket: Socket,
  operation: () => Promise<T>,
): Promise<T> {
  let fail: ((error: Error) => void) | undefined;
  const closed = new Promise<never>((_resolve, reject) => { fail = reject; });
  const call: InFlightCall = { fail(error) { fail?.(error); } };
  inFlight.add(call);
  try {
    return await Promise.race([operation(), closed]);
  } finally {
    inFlight.delete(call);
  }
}

async function stopBroker(
  server: Server,
  connections: Set<Socket>,
  inFlight: Set<InFlightCall>,
  socketPath: string,
  directory: string,
  stopAccepting: () => void,
): Promise<void> {
  stopAccepting();
  const unavailable = new ChildControlBrokerError("child-control broker stopped before Core response");
  for (const call of inFlight) call.fail(unavailable);
  for (const socket of connections) socket.destroy(unavailable);
  const closeFailure = await failureOf(() => closeServer(server));
  const cleanupFailure = failureOfSync(() => cleanupOwnedBrokerDirectory(directory, socketPath));
  if (closeFailure !== undefined || cleanupFailure !== undefined) {
    throw combinedBrokerError("could not stop child-control AF_UNIX broker", closeFailure, cleanupFailure);
  }
}

function ensurePrivateDirectory(path: string, create: boolean): void {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw brokerError(`could not create ${path}`, error);
    }
  }
  const stat = lstatExact(path, `directory ${path}`);
  if (!stat.isDirectory()) throw new ChildControlBrokerError(`child-control ${path} is not a directory`);
  if (stat.uid !== effectiveUid()) throw new ChildControlBrokerError(`child-control ${path} is not owned by the effective uid`);
  if ((stat.mode & 0o777) !== 0o700) throw new ChildControlBrokerError(`child-control ${path} mode is not 0700`);
}

function createFreshBrokerDirectory(): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const directory = join(CHILD_CONTROL_BROKER_ROOT, randomBytes(5).toString("hex"));
    let created = false;
    try {
      mkdirSync(directory, { mode: 0o700 });
      created = true;
      ensurePrivateDirectory(directory, false);
      return directory;
    } catch (error) {
      if (created) {
        const cleanupFailure = failureOfSync(() => cleanupOwnedBrokerDirectory(directory));
        throw combinedBrokerError("could not create a private child-control directory", error, cleanupFailure);
      }
      if (isCode(error, "EEXIST")) continue;
      throw brokerError("could not create a private child-control directory", error);
    }
  }
  throw new ChildControlBrokerError("could not allocate a fresh child-control directory");
}

function ensurePrivateSocket(path: string): void {
  const stat = lstatExact(path, `socket ${path}`);
  if (!stat.isSocket()) throw new ChildControlBrokerError("child-control socket path is not a socket");
  if (stat.uid !== effectiveUid()) throw new ChildControlBrokerError("child-control socket is not owned by the effective uid");
  if ((stat.mode & 0o777) !== 0o600) throw new ChildControlBrokerError("child-control socket mode is not 0600");
}

function cleanupOwnedBrokerDirectory(directory: string, socketPath = join(directory, "s")): void {
  try {
    ensurePrivateDirectory(CHILD_CONTROL_BROKER_ROOT, false);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  const socketFailure = cleanupFailureOf(() => {
    ensurePrivateSocket(socketPath);
    unlinkSync(socketPath);
  });
  const directoryFailure = cleanupFailureOf(() => {
    ensurePrivateDirectory(directory, false);
    rmdirSync(directory);
  });
  if (socketFailure !== undefined || directoryFailure !== undefined) {
    throw combinedBrokerError("could not clean up child-control AF_UNIX broker", socketFailure, directoryFailure);
  }
}

function assertAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw brokerError(`child-control socket path ${path} could not be lstat'd`, error);
  }
  throw new ChildControlBrokerError("child-control socket path already exists");
}

function lstatExact(path: string, label: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) throw error;
    throw brokerError(`child-control ${label} could not be lstat'd`, error);
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(new ChildControlBrokerError(`child-control socket listen failed: ${error.message}`));
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(new ChildControlBrokerError(`child-control server close failed: ${error.message}`));
    });
  });
}

function assertClosedRequired(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new ChildControlBrokerProtocolError(`${label} contains unknown key ${key}`);
  }
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new ChildControlBrokerProtocolError(`${label} is missing required key ${key}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new ChildControlBrokerProtocolError(`${label} must be an object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockedObservationKey(receiptId: string, latchId: string): string {
  return `${receiptId}\u0000${latchId}`;
}

function connectionFailureCode(error: unknown): string {
  if (error instanceof ChildControlBrokerProtocolError) return "child-control-protocol";
  if (error instanceof ChildControlBrokerError) return "child-control-unavailable";
  return "child-control-internal";
}

function effectiveUid(): number {
  if (typeof process.geteuid !== "function") throw new ChildControlBrokerError("child-control AF_UNIX broker requires an effective uid");
  return process.geteuid();
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function brokerError(prefix: string, error: unknown): ChildControlBrokerError {
  return new ChildControlBrokerError(`${prefix}: ${errorMessage(error)}`);
}

function combinedBrokerError(prefix: string, ...errors: readonly (unknown | undefined)[]): ChildControlBrokerError {
  const details = errors.filter((error): error is unknown => error !== undefined).map(errorMessage);
  return new ChildControlBrokerError(`${prefix}: ${details.join("; cleanup: ")}`);
}

async function failureOf(action: () => void | Promise<void>): Promise<unknown | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

function failureOfSync(action: () => void): unknown | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

function cleanupFailureOf(action: () => void): unknown | undefined {
  const error = failureOfSync(action);
  return isCode(error, "ENOENT") ? undefined : error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
