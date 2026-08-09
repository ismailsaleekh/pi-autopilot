import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import type {
  ChildControlBlockedGate,
  ChildControlRequest,
  ChildControlResponse,
  CoreToHostChildControlPayload,
  CoreToHostFrame,
  HostToCoreBlockedResultObservedPayload,
  HostToCoreChildControlPayload,
} from "./generated/index.ts";
import { validateCoreToHostFrame } from "./generated/frame-validation.ts";

/** The sole, fixed parent for Host-owned child-control AF_UNIX sockets. */
export const CHILD_CONTROL_BROKER_ROOT = "/tmp/.pi-ap";
/** Matches the generated runner/RPC terminal frame ceiling. */
export const CHILD_CONTROL_BROKER_MAX_FRAME_BYTES = 4 * 1024 * 1024;

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
  /** Must run only after the accepted child response frame was written. */
  afterChildResponseWritten(): Promise<void>;
}

export interface ChildControlBrokerOptions {
  readonly transport: ChildControlBrokerTransport;
  /**
   * Host-only cancellation hook. It closes the lifecycle launch gate and
   * verifies Host task jurisdiction before the child receives ACCEPT.
   */
  readonly applyBlockedGate?: (gate: ChildControlBlockedGate) => Promise<BlockedGateApplication>;
}

export interface ChildControlBroker {
  readonly socketPath: string;
  readonly launchFacts: ChildControlBrokerLaunchFacts;
  /**
   * Wave 6 reconciliation entrypoint. A future Core replay supplies the same
   * typed directive; Host does not invent a latch or a cancellation set.
   */
  reconcileBlockedGate(gate: ChildControlBlockedGate): Promise<void>;
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

type WireRequest =
  | { readonly kind: "child-control"; readonly request: ChildControlRequest }
  | { readonly kind: "blocked-result-observed"; readonly payload: HostToCoreBlockedResultObservedPayload };

/**
 * Starts one activation-scoped, private AF_UNIX broker. This function is never
 * called at module load: extension lifecycle activation owns that decision.
 */
export async function startChildControlBroker(options: ChildControlBrokerOptions): Promise<ChildControlBroker> {
  ensurePrivateDirectory(CHILD_CONTROL_BROKER_ROOT, true);
  const directory = createFreshBrokerDirectory();
  const socketPath = join(directory, "s");
  assertAbsent(socketPath);
  const launchFacts: ChildControlBrokerLaunchFacts = {
    socketPath,
    capability: randomBytes(32).toString("hex"),
  };
  const connections = new Set<Socket>();
  const inFlight = new Set<InFlightCall>();
  let accepting = true;
  let stopPromise: Promise<void> | undefined;
  let server: Server | undefined;

  try {
    server = createServer({ allowHalfOpen: true }, (socket) => {
      connections.add(socket);
      socket.unref();
      handleConnection(socket, options, () => accepting, inFlight).finally(() => connections.delete(socket));
    });
    server.unref();
    await listen(server, socketPath);
    // This is a newly bound socket in our freshly-created private directory;
    // chmod is initialization, never repair of a preexisting object.
    chmodSync(socketPath, 0o600);
    ensurePrivateSocket(socketPath);
  } catch (error) {
    if (server !== undefined) await closeServer(server).catch(() => {});
    try { cleanupOwnedBrokerDirectory(directory); } catch {}
    throw brokerError("could not bind the required child-control AF_UNIX socket", error);
  }

  const liveServer = server;
  return {
    socketPath,
    launchFacts,
    async reconcileBlockedGate(gate: ChildControlBlockedGate): Promise<void> {
      if (!accepting) throw new ChildControlBrokerError("child-control broker is stopped");
      const apply = options.applyBlockedGate;
      if (apply === undefined) throw new ChildControlBrokerError("child-control blocked-gate hook is unavailable");
      const application = await apply(gate);
      await application.afterChildResponseWritten();
    },
    stop(): Promise<void> {
      if (stopPromise === undefined) {
        stopPromise = stopBroker(liveServer, connections, inFlight, socketPath, directory, () => { accepting = false; });
      }
      return stopPromise;
    },
  };
}

/** Idempotent convenience wrapper for lifecycle callers. */
export async function stopChildControlBroker(broker: ChildControlBroker | undefined): Promise<void> {
  await broker?.stop();
}

/**
 * The one submit bridge path. It validates the generated Core frame wrapper,
 * accepts no Core effect other than child-control, and does not admit or
 * normalize any child payload.
 */
export async function forwardToCore(
  transport: ChildControlBrokerTransport,
  request: ChildControlRequest,
): Promise<CoreToHostChildControlPayload> {
  const frame = validateCoreToHostFrame(await transport.request("child-control", { request }));
  if (frame.kind !== "child-control") {
    throw new ChildControlBrokerProtocolError(`child-control request received Core effect ${frame.kind}`);
  }
  const payload = frame.payload;
  if (!isRecord(payload.response) || payload.response.request_id !== request.request_id) {
    throw new ChildControlBrokerProtocolError("child-control response request_id drift");
  }
  return payload;
}

async function handleConnection(
  socket: Socket,
  options: ChildControlBrokerOptions,
  accepting: () => boolean,
  inFlight: Set<InFlightCall>,
): Promise<void> {
  try {
    if (!accepting()) throw new ChildControlBrokerError("child-control broker is stopped");
    const wire = await readExactlyOneFrame(socket);
    const request = parseWireRequest(wire);
    if (!accepting()) throw new ChildControlBrokerError("child-control broker is stopped");

    if (request.kind === "blocked-result-observed") {
      await forwardBlockedResultObserved(options.transport, request.payload, inFlight, socket);
      return;
    }

    const payload = await withInFlight(
      inFlight,
      socket,
      () => forwardToCore(options.transport, request.request),
    );
    const response = payload.response;
    const gate = payload.blocked_gate;
    let afterWrite: BlockedGateApplication | undefined;
    if (gate !== null) {
      if (!isAcceptedBlockedResponse(response)) {
        throw new ChildControlBrokerProtocolError("blocked_gate requires an accepted blocked child-control response");
      }
      const apply = options.applyBlockedGate;
      if (apply === undefined) throw new ChildControlBrokerProtocolError("blocked_gate received without a Host gate hook");
      afterWrite = await apply(gate);
    }

    // The only bytes the nested child can observe are its generated response.
    await writeFrame(socket, response);
    if (afterWrite !== undefined) await afterWrite.afterChildResponseWritten();
  } catch {
    // Socket protocol, Core-unavailable, and shutdown failures intentionally
    // close the connection. The generated child maps this transport failure to
    // RETRY; Host never manufactures an admission result.
    socket.destroy();
  }
}

async function forwardBlockedResultObserved(
  transport: ChildControlBrokerTransport,
  payload: HostToCoreBlockedResultObservedPayload,
  inFlight: Set<InFlightCall>,
  socket: Socket,
): Promise<never> {
  await withInFlight(inFlight, socket, () => transport.request("blocked-result-observed", payload));
  // Wave 1 generated the request but no closed Core-to-Host acknowledgment
  // payload for this route. A generic done status is not an authenticated
  // blocked-result acknowledgment and must not be aliased to child ACCEPT.
  throw new ChildControlBrokerProtocolError(
    "blocked-result-observed has no generated closed acknowledgment contract",
  );
}

function isAcceptedBlockedResponse(response: ChildControlResponse): boolean {
  if (response.outcome !== "ACCEPT") return false;
  return response.receipt.kind === "blocked";
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
      "schema", "request_id", "token", "run_id", "assignment_id", "attempt", "tool_call_id", "kind", "tool_name", "profile_id", "raw_payload",
    ], "child-control request");
    // The generated Host-to-Core frame owns field/type/semantic admission. The
    // broker deliberately checks only the closed wire envelope and forwards
    // this exact parsed JSON tree unchanged as the typed generated payload.
    return { kind: "child-control", request: record as unknown as ChildControlRequest };
  }
  if (schema === "autopilot.blocked_result_observed.v1") {
    assertClosedRequired(record, [
      "schema", "token", "run_id", "assignment_id", "attempt", "receipt_id", "tool_call_id",
    ], "blocked-result-observed request");
    return { kind: "blocked-result-observed", payload: record as unknown as HostToCoreBlockedResultObservedPayload };
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
  await new Promise<void>((resolve, reject) => {
    socket.end(Buffer.concat([header, json]), (error?: Error | null) => {
      if (error == null) resolve();
      else reject(new ChildControlBrokerError(`child-control response write failed: ${error.message}`));
    });
  });
}

interface InFlightCall {
  fail(error: Error): void;
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
  await closeServer(server);
  cleanupOwnedBrokerDirectory(directory, socketPath);
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
    try {
      mkdirSync(directory, { mode: 0o700 });
      ensurePrivateDirectory(directory, false);
      return directory;
    } catch (error) {
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
    if (!isCode(error, "ENOENT")) throw error;
    return;
  }
  try {
    ensurePrivateSocket(socketPath);
    unlinkSync(socketPath);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  try {
    ensurePrivateDirectory(directory, false);
    rmdirSync(directory);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
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
    // Cleanup treats only ENOENT as harmless. Preserve its code rather than
    // wrapping it into a generic Error that could be mistaken for success.
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
