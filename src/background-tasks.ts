import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { BackgroundActionBgRun, BackgroundCapabilities } from "./generated/index.ts";
import { validateBgRunDescriptorIdentity } from "./generated/frame-validation.ts";
import { BACKGROUND_OPERATIONS, BACKGROUND_PROTOCOL, BACKGROUND_STATUSES, UNAVAILABLE_BACKGROUND_CAPABILITIES } from "./generated/host-runtime-tables.ts";
import { boolValue, boundedDiagnostic, closedRecord, nonEmptyString, nonNegativeInteger, oneOf } from "./host-runtime.ts";

export { boundedDiagnostic };
export const BG_REQUEST_CHANNEL = BACKGROUND_PROTOCOL.request.channel;
export const BG_RESPONSE_CHANNEL = BACKGROUND_PROTOCOL.response.channel;
export const BG_TERMINAL_CHANNEL = BACKGROUND_PROTOCOL.terminal.channel;
export const BG_REQUEST_SCHEMA = BACKGROUND_PROTOCOL.request.schema;
export const BG_RESPONSE_SCHEMA = BACKGROUND_PROTOCOL.response.schema;
export const BG_TERMINAL_SCHEMA = BACKGROUND_PROTOCOL.terminal.schema;

const TRANSPORT_TIMEOUT_MS = 1000;
const TERMINAL_STATUSES = BACKGROUND_STATUSES.filter((row) => row.terminal).map((row) => row.name);

export type BackgroundOperation = (typeof BACKGROUND_OPERATIONS)[number];
export type BgTaskStatus = (typeof BACKGROUND_STATUSES)[number]["name"];
export type BgTerminalTaskStatus = (typeof TERMINAL_STATUSES)[number];

export interface BgTaskSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly command: string;
  readonly status: BgTaskStatus;
  readonly outputPath: string;
  readonly [key: string]: unknown;
}
export interface BgLogsResult { readonly task: BgTaskSnapshot; readonly path: string; readonly bytesRead: number; readonly truncated: boolean; readonly tail: boolean; readonly [key: string]: unknown; }
export interface BgStatusResult { readonly tasks: BgTaskSnapshot[]; readonly [key: string]: unknown; }
export type TerminalHandler = (snapshot: BgTaskSnapshot) => void | Promise<void>;

interface PendingRequest {
  readonly operation: BackgroundOperation;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class PiBackgroundTaskError extends Error { constructor(message: string) { super(message); this.name = "PiBackgroundTaskError"; } }
export class PiBackgroundTaskTimeoutError extends PiBackgroundTaskError { constructor(operation: string) { super(`pi-background-tasks ${operation} request timed out after ${TRANSPORT_TIMEOUT_MS}ms`); this.name = "PiBackgroundTaskTimeoutError"; } }

export class PiBackgroundTaskClient {
  private nextRequest = 1;
  private closed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly terminalHandlers = new Set<TerminalHandler>();
  private readonly unsubscribeResponse: () => void;
  private readonly unsubscribeTerminal: () => void;
  private terminalDelivery: Promise<void> = Promise.resolve();
  private protocolError: Error | undefined;
  private readonly events: EventBus;

  constructor(events: EventBus) {
    this.events = events;
    this.unsubscribeResponse = events.on(BG_RESPONSE_CHANNEL, (data) => this.receiveResponse(data));
    this.unsubscribeTerminal = events.on(BG_TERMINAL_CHANNEL, (data) => this.receiveTerminal(data));
  }

  async capabilities(): Promise<BackgroundCapabilities> { return requireCapabilities(await this.request("capabilities", {})); }
  async run(descriptor: BackgroundActionBgRun): Promise<BgTaskSnapshot> { validateBgRunDescriptorIdentity(descriptor); return requireTaskSnapshot(await this.request("run", descriptor as unknown as Record<string, unknown>), "run result"); }
  async status(taskId?: string): Promise<BgStatusResult> {
    const result = await this.request("status", taskId === undefined ? {} : { taskId });
    if (!isRecord(result) || !Array.isArray(result.tasks)) throw new PiBackgroundTaskError("pi-background-tasks status returned malformed result");
    return { ...result, tasks: result.tasks.map((task) => requireTaskSnapshot(task, "status task")) } as BgStatusResult;
  }
  async logs(taskId: string, maxBytes?: number, tail?: boolean): Promise<BgLogsResult> {
    const payload: Record<string, unknown> = { taskId };
    if (maxBytes !== undefined) payload.maxBytes = maxBytes;
    if (tail !== undefined) payload.tail = tail;
    const result = await this.request("logs", payload);
    if (!isRecord(result)) throw new PiBackgroundTaskError("pi-background-tasks logs returned malformed result");
    return { ...result, task: requireTaskSnapshot(result.task, "logs task"), path: nonEmptyString(result.path, "logs.path", PiBackgroundTaskError), bytesRead: nonNegativeInteger(result.bytesRead, "logs.bytesRead", PiBackgroundTaskError), truncated: boolValue(result.truncated, "logs.truncated", PiBackgroundTaskError), tail: boolValue(result.tail, "logs.tail", PiBackgroundTaskError) } as BgLogsResult;
  }
  async kill(taskId: string): Promise<BgTaskSnapshot> {
    const result = await this.request("kill", { taskId });
    return requireTaskSnapshot(isRecord(result) && "task" in result ? result.task : result, isRecord(result) && "task" in result ? "kill.task" : "kill result");
  }

  onTerminal(handler: TerminalHandler): () => void {
    if (this.closed) throw new PiBackgroundTaskError("pi-background-tasks client is closed");
    if (this.protocolError !== undefined) throw this.protocolError;
    this.terminalHandlers.add(handler);
    return () => this.terminalHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.unsubscribeResponse();
      this.unsubscribeTerminal();
      this.failAll(new PiBackgroundTaskError("pi-background-tasks client closed before response"));
      this.terminalHandlers.clear();
    }
    await this.drainTerminalHandlers();
  }

  async drainTerminalHandlers(): Promise<void> { await this.terminalDelivery; if (this.protocolError !== undefined) throw this.protocolError; }

  private request(operation: BackgroundOperation, payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new PiBackgroundTaskError("pi-background-tasks client is closed"));
    if (this.protocolError !== undefined) return Promise.reject(this.protocolError);
    const requestId = `autopilot-${Date.now().toString(36)}-${this.nextRequest.toString(36)}`;
    this.nextRequest += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new PiBackgroundTaskTimeoutError(operation)); }, TRANSPORT_TIMEOUT_MS);
      this.pending.set(requestId, { operation, resolve, reject, timer });
      try { this.events.emit(BG_REQUEST_CHANNEL, { schema_version: BG_REQUEST_SCHEMA, request_id: requestId, operation, payload }); }
      catch (error) { this.pending.delete(requestId); clearTimeout(timer); reject(new PiBackgroundTaskError(`pi-background-tasks emit failed: ${errorMessage(error)}`)); }
    });
  }

  private receiveResponse(data: unknown): void {
    let response: ValidResponse;
    try { response = validateResponse(data); } catch (error) { this.rememberProtocolError(new PiBackgroundTaskError(errorMessage(error))); return; }
    const pending = this.pending.get(response.request_id);
    if (pending === undefined) return;
    this.pending.delete(response.request_id);
    clearTimeout(pending.timer);
    if (response.operation !== pending.operation) { pending.reject(new PiBackgroundTaskError(`pi-background-tasks response operation mismatch: expected ${pending.operation}, got ${response.operation}`)); return; }
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new PiBackgroundTaskError(`pi-background-tasks ${response.operation} failed: ${boundedDiagnostic(response.error)}`));
  }

  private receiveTerminal(data: unknown): void {
    let terminal: ValidTerminal;
    try { terminal = validateTerminal(data); } catch (error) { const framed = new PiBackgroundTaskError(errorMessage(error)); this.rememberProtocolError(framed); throw framed; }
    const handlers = [...this.terminalHandlers];
    this.terminalDelivery = this.terminalDelivery.then(async () => { for (const handler of handlers) await handler(terminal.task); }).catch((error: unknown) => this.rememberProtocolError(new PiBackgroundTaskError(`pi-background-tasks terminal handler failed: ${errorMessage(error)}`)));
  }

  private rememberProtocolError(error: Error): void { this.protocolError = error; this.failAll(error); }
  private failAll(error: Error): void { for (const [requestId, pending] of this.pending) { this.pending.delete(requestId); clearTimeout(pending.timer); pending.reject(error); } }
}

export function unavailableCapabilities(): BackgroundCapabilities { return { ...UNAVAILABLE_BACKGROUND_CAPABILITIES }; }

type ValidResponse = { readonly schema_version: typeof BG_RESPONSE_SCHEMA; readonly request_id: string; readonly operation: BackgroundOperation; readonly ok: true; readonly result: unknown; readonly error?: never } | { readonly schema_version: typeof BG_RESPONSE_SCHEMA; readonly request_id: string; readonly operation: BackgroundOperation; readonly ok: false; readonly error: unknown; readonly result?: never };
interface ValidTerminal { readonly schema_version: typeof BG_TERMINAL_SCHEMA; readonly task: BgTaskSnapshot; }

function validateResponse(value: unknown): ValidResponse {
  const object = closedRecord(value, ["schema_version", "request_id", "operation", "ok", "result", "error"], "response", PiBackgroundTaskError);
  if (object.schema_version !== BG_RESPONSE_SCHEMA) throw new PiBackgroundTaskError("pi-background-tasks response schema mismatch");
  const requestId = nonEmptyString(object.request_id, "response.request_id", PiBackgroundTaskError);
  const operation = oneOf(object.operation, BACKGROUND_OPERATIONS, "response.operation", PiBackgroundTaskError);
  const ok = boolValue(object.ok, "response.ok", PiBackgroundTaskError);
  const hasResult = Object.prototype.hasOwnProperty.call(object, "result");
  const hasError = Object.prototype.hasOwnProperty.call(object, "error");
  if (hasResult === hasError) throw new PiBackgroundTaskError("pi-background-tasks response must contain exactly one of result/error");
  if (ok && !hasResult) throw new PiBackgroundTaskError("pi-background-tasks ok response must contain result");
  if (!ok && !hasError) throw new PiBackgroundTaskError("pi-background-tasks error response must contain error");
  return ok ? { schema_version: BG_RESPONSE_SCHEMA, request_id: requestId, operation, ok: true, result: object.result } : { schema_version: BG_RESPONSE_SCHEMA, request_id: requestId, operation, ok: false, error: object.error };
}

function validateTerminal(value: unknown): ValidTerminal {
  const object = closedRecord(value, ["schema_version", "task"], "terminal", PiBackgroundTaskError);
  if (object.schema_version !== BG_TERMINAL_SCHEMA) throw new PiBackgroundTaskError("pi-background-tasks terminal schema mismatch");
  return { schema_version: BG_TERMINAL_SCHEMA, task: requireTaskSnapshot(object.task, "terminal.task", true) };
}

function requireCapabilities(value: unknown): BackgroundCapabilities {
  const keys = Object.keys(UNAVAILABLE_BACKGROUND_CAPABILITIES);
  const object = closedRecord(value, keys, "capabilities", PiBackgroundTaskError);
  const apiVersion = nonNegativeInteger(object.api_version, "capabilities.api_version", PiBackgroundTaskError);
  if (apiVersion !== 1) throw new PiBackgroundTaskError(`capabilities.api_version must be 1, got ${String(apiVersion)}`);
  return Object.fromEntries(keys.map((key) => [key, key === "api_version" ? apiVersion : boolValue(object[key], `capabilities.${key}`, PiBackgroundTaskError)])) as unknown as BackgroundCapabilities;
}

function requireTaskSnapshot(value: unknown, label: string, terminal = false): BgTaskSnapshot {
  if (!isRecord(value)) throw new PiBackgroundTaskError(`${label} is not an object`);
  const status = requireTaskStatus(value.status, `${label}.status`, terminal);
  return { ...value, id: nonEmptyString(value.id, `${label}.id`, PiBackgroundTaskError), command: nonEmptyString(value.command, `${label}.command`, PiBackgroundTaskError), status, outputPath: nonEmptyString(value.outputPath, `${label}.outputPath`, PiBackgroundTaskError) } as BgTaskSnapshot;
}

function requireTaskStatus(value: unknown, label: string, terminal: boolean): BgTaskStatus {
  const allowed = terminal ? TERMINAL_STATUSES : BACKGROUND_STATUSES.map((row) => row.name);
  const status = nonEmptyString(value, label, PiBackgroundTaskError);
  if ((allowed as readonly string[]).includes(status)) return status as BgTaskStatus;
  throw new PiBackgroundTaskError(`${label} must be one of ${allowed.join(", ")}; got ${status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
