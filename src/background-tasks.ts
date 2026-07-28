import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { BackgroundActionBgRun, BackgroundCapabilities } from "./generated/index.ts";
import { validateBgRunDescriptorIdentity } from "./frame-validation.ts";

export const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
export const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
export const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
export const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";

const TRANSPORT_TIMEOUT_MS = 1000;
const MAX_DIAGNOSTIC_CHARS = 240;

export type BackgroundOperation = "capabilities" | "run" | "status" | "logs" | "kill";

export interface BgTaskSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly command: string;
  readonly status: "running" | "completed" | "failed" | "killed" | string;
  readonly outputPath: string;
  readonly [key: string]: unknown;
}

export interface BgLogsResult {
  readonly task: BgTaskSnapshot;
  readonly path: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly tail: boolean;
  readonly [key: string]: unknown;
}

export interface BgStatusResult {
  readonly tasks: BgTaskSnapshot[];
  readonly [key: string]: unknown;
}

export type TerminalHandler = (snapshot: BgTaskSnapshot) => void | Promise<void>;

interface PendingRequest {
  readonly operation: BackgroundOperation;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class PiBackgroundTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiBackgroundTaskError";
  }
}

export class PiBackgroundTaskTimeoutError extends PiBackgroundTaskError {
  constructor(operation: string) {
    super(`pi-background-tasks ${operation} request timed out after ${TRANSPORT_TIMEOUT_MS}ms`);
    this.name = "PiBackgroundTaskTimeoutError";
  }
}

export class PiBackgroundTaskClient {
  private nextRequest = 1;
  private closed = false;
  private readonly events: EventBus;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly terminalHandlers = new Set<TerminalHandler>();
  private readonly unsubscribeResponse: () => void;
  private readonly unsubscribeTerminal: () => void;
  private terminalDelivery: Promise<void> = Promise.resolve();
  private protocolError: Error | undefined;

  constructor(events: EventBus) {
    this.events = events;
    this.unsubscribeResponse = events.on(BG_RESPONSE_CHANNEL, (data) => this.receiveResponse(data));
    this.unsubscribeTerminal = events.on(BG_TERMINAL_CHANNEL, (data) => this.receiveTerminal(data));
  }

  async capabilities(): Promise<BackgroundCapabilities> {
    const result = await this.request("capabilities", {});
    return requireCapabilities(result);
  }

  async run(descriptor: BackgroundActionBgRun): Promise<BgTaskSnapshot> {
    validateBgRunDescriptorIdentity(descriptor);
    const result = await this.request("run", descriptor as unknown as Record<string, unknown>);
    return requireTaskSnapshot(result, "run result");
  }

  async status(taskId?: string): Promise<BgStatusResult> {
    const payload = taskId === undefined ? {} : { taskId };
    const result = await this.request("status", payload);
    if (!isRecord(result) || !Array.isArray(result.tasks)) {
      throw new PiBackgroundTaskError("pi-background-tasks status returned malformed result");
    }
    return { ...result, tasks: result.tasks.map((task) => requireTaskSnapshot(task, "status task")) } as BgStatusResult;
  }

  async logs(taskId: string, maxBytes?: number, tail?: boolean): Promise<BgLogsResult> {
    const payload: Record<string, unknown> = { taskId };
    if (maxBytes !== undefined) payload.maxBytes = maxBytes;
    if (tail !== undefined) payload.tail = tail;
    const result = await this.request("logs", payload);
    if (!isRecord(result)) throw new PiBackgroundTaskError("pi-background-tasks logs returned malformed result");
    return {
      ...result,
      task: requireTaskSnapshot(result.task, "logs task"),
      path: requireString(result.path, "logs.path"),
      bytesRead: requireNonNegativeNumber(result.bytesRead, "logs.bytesRead"),
      truncated: requireBoolean(result.truncated, "logs.truncated"),
      tail: requireBoolean(result.tail, "logs.tail"),
    } as BgLogsResult;
  }

  async kill(taskId: string): Promise<BgTaskSnapshot> {
    const result = await this.request("kill", { taskId });
    if (isRecord(result) && "task" in result) return requireTaskSnapshot(result.task, "kill.task");
    return requireTaskSnapshot(result, "kill result");
  }

  onTerminal(handler: TerminalHandler): () => void {
    if (this.closed) throw new PiBackgroundTaskError("pi-background-tasks client is closed");
    if (this.protocolError !== undefined) throw this.protocolError;
    this.terminalHandlers.add(handler);
    return () => {
      this.terminalHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.drainTerminalHandlers();
      return;
    }
    this.closed = true;
    this.unsubscribeResponse();
    this.unsubscribeTerminal();
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new PiBackgroundTaskError("pi-background-tasks client closed before response"));
    }
    this.terminalHandlers.clear();
    await this.drainTerminalHandlers();
  }

  async drainTerminalHandlers(): Promise<void> {
    await this.terminalDelivery;
    if (this.protocolError !== undefined) throw this.protocolError;
  }

  private request(operation: BackgroundOperation, payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new PiBackgroundTaskError("pi-background-tasks client is closed"));
    if (this.protocolError !== undefined) return Promise.reject(this.protocolError);
    const requestId = `autopilot-${Date.now().toString(36)}-${this.nextRequest.toString(36)}`;
    this.nextRequest += 1;
    const envelope = {
      schema_version: BG_REQUEST_SCHEMA,
      request_id: requestId,
      operation,
      payload,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PiBackgroundTaskTimeoutError(operation));
      }, TRANSPORT_TIMEOUT_MS);
      this.pending.set(requestId, { operation, resolve, reject, timer });
      try {
        this.events.emit(BG_REQUEST_CHANNEL, envelope);
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new PiBackgroundTaskError(`pi-background-tasks emit failed: ${errorMessage(error)}`));
      }
    });
  }

  private receiveResponse(data: unknown): void {
    let response: ValidResponse;
    try {
      response = validateResponse(data);
    } catch (error) {
      this.rememberProtocolError(new PiBackgroundTaskError(errorMessage(error)));
      return;
    }
    const pending = this.pending.get(response.request_id);
    if (pending === undefined) return;
    this.pending.delete(response.request_id);
    clearTimeout(pending.timer);
    if (response.operation !== pending.operation) {
      pending.reject(new PiBackgroundTaskError(`pi-background-tasks response operation mismatch: expected ${pending.operation}, got ${response.operation}`));
      return;
    }
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new PiBackgroundTaskError(`pi-background-tasks ${response.operation} failed: ${boundedDiagnostic(response.error)}`));
  }

  private receiveTerminal(data: unknown): void {
    let terminal: ValidTerminal;
    try {
      terminal = validateTerminal(data);
    } catch (error) {
      const framed = new PiBackgroundTaskError(errorMessage(error));
      this.rememberProtocolError(framed);
      throw framed;
    }
    const handlers = [...this.terminalHandlers];
    this.terminalDelivery = this.terminalDelivery
      .then(async () => {
        for (const handler of handlers) {
          await handler(terminal.task);
        }
      })
      .catch((error: unknown) => {
        const framed = new PiBackgroundTaskError(`pi-background-tasks terminal handler failed: ${errorMessage(error)}`);
        this.rememberProtocolError(framed);
      });
  }

  private rememberProtocolError(error: Error): void {
    this.protocolError = error;
    this.failAll(error);
  }

  private failAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export function unavailableCapabilities(): BackgroundCapabilities {
  return {
    api_version: 1,
    run: false,
    run_is_agent: false,
    run_completion_trigger: false,
    status: false,
    logs: false,
    logs_bounded: false,
    kill: false,
  };
}

export function boundedDiagnostic(error: unknown): string {
  const text = errorMessage(error).replace(/\s+/gu, " ").trim();
  return text.length <= MAX_DIAGNOSTIC_CHARS ? text : `${text.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`;
}

type ValidResponse =
  | { readonly schema_version: typeof BG_RESPONSE_SCHEMA; readonly request_id: string; readonly operation: BackgroundOperation; readonly ok: true; readonly result: unknown; readonly error?: never }
  | { readonly schema_version: typeof BG_RESPONSE_SCHEMA; readonly request_id: string; readonly operation: BackgroundOperation; readonly ok: false; readonly error: unknown; readonly result?: never };

interface ValidTerminal {
  readonly schema_version: typeof BG_TERMINAL_SCHEMA;
  readonly task: BgTaskSnapshot;
}

function validateResponse(value: unknown): ValidResponse {
  const object = requireClosedRecord(value, ["schema_version", "request_id", "operation", "ok", "result", "error"], "response");
  if (object.schema_version !== BG_RESPONSE_SCHEMA) throw new PiBackgroundTaskError("pi-background-tasks response schema mismatch");
  const requestId = requireString(object.request_id, "response.request_id");
  const operation = requireOperation(object.operation, "response.operation");
  const ok = requireBoolean(object.ok, "response.ok");
  const hasResult = Object.prototype.hasOwnProperty.call(object, "result");
  const hasError = Object.prototype.hasOwnProperty.call(object, "error");
  if (hasResult === hasError) throw new PiBackgroundTaskError("pi-background-tasks response must contain exactly one of result/error");
  if (ok && !hasResult) throw new PiBackgroundTaskError("pi-background-tasks ok response must contain result");
  if (!ok && !hasError) throw new PiBackgroundTaskError("pi-background-tasks error response must contain error");
  return ok
    ? { schema_version: BG_RESPONSE_SCHEMA, request_id: requestId, operation, ok: true, result: object.result }
    : { schema_version: BG_RESPONSE_SCHEMA, request_id: requestId, operation, ok: false, error: object.error };
}

function validateTerminal(value: unknown): ValidTerminal {
  const object = requireClosedRecord(value, ["schema_version", "task"], "terminal");
  if (object.schema_version !== BG_TERMINAL_SCHEMA) throw new PiBackgroundTaskError("pi-background-tasks terminal schema mismatch");
  return { schema_version: BG_TERMINAL_SCHEMA, task: requireTaskSnapshot(object.task, "terminal.task") };
}

function requireCapabilities(value: unknown): BackgroundCapabilities {
  const object = requireClosedRecord(value, ["api_version", "run", "run_is_agent", "run_completion_trigger", "status", "logs", "logs_bounded", "kill"], "capabilities");
  const apiVersion = requireNonNegativeNumber(object.api_version, "capabilities.api_version");
  if (apiVersion !== 1) throw new PiBackgroundTaskError(`capabilities.api_version must be 1, got ${String(apiVersion)}`);
  return {
    api_version: apiVersion,
    run: requireBoolean(object.run, "capabilities.run"),
    run_is_agent: requireBoolean(object.run_is_agent, "capabilities.run_is_agent"),
    run_completion_trigger: requireBoolean(object.run_completion_trigger, "capabilities.run_completion_trigger"),
    status: requireBoolean(object.status, "capabilities.status"),
    logs: requireBoolean(object.logs, "capabilities.logs"),
    logs_bounded: requireBoolean(object.logs_bounded, "capabilities.logs_bounded"),
    kill: requireBoolean(object.kill, "capabilities.kill"),
  };
}

function requireTaskSnapshot(value: unknown, label: string): BgTaskSnapshot {
  if (!isRecord(value)) throw new PiBackgroundTaskError(`${label} is not an object`);
  const id = requireString(value.id, `${label}.id`);
  const command = requireString(value.command, `${label}.command`);
  const status = requireString(value.status, `${label}.status`);
  const outputPath = requireString(value.outputPath, `${label}.outputPath`);
  return { ...value, id, command, status, outputPath } as BgTaskSnapshot;
}

function requireClosedRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new PiBackgroundTaskError(`${label} is not an object`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new PiBackgroundTaskError(`${label} contains unknown key ${key}`);
  }
  return value;
}

function requireOperation(value: unknown, label: string): BackgroundOperation {
  if (value === "capabilities" || value === "run" || value === "status" || value === "logs" || value === "kill") return value;
  throw new PiBackgroundTaskError(`${label} is not a supported operation`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new PiBackgroundTaskError(`${label} must be a non-empty string`);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  throw new PiBackgroundTaskError(`${label} must be boolean`);
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new PiBackgroundTaskError(`${label} must be a non-negative integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
