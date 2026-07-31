import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { PiBackgroundTaskClient } from "./background-tasks.ts";
import { ACTIVATING_COMMANDS, ACTIVATION_RECORD, OPERATING_COMMANDS } from "./generated/host-runtime-tables.ts";
import { closedRecord, nonEmptyString, nonNegativeInteger } from "./host-runtime.ts";
import { resolveCoreBinary, type ResolveCoreOptions } from "./resolve-core.ts";
import { CoreTransport } from "./transport.ts";

export { ACTIVATING_COMMANDS, OPERATING_COMMANDS };
export const ACTIVATION_RECORD_SCHEMA = ACTIVATION_RECORD.schema_version;

export type ActivationState = "inert" | "activating" | "active" | "failed";

export class AutopilotInertError extends Error {
  constructor(command: string) {
    super(`/${command} requires an active Autopilot session, but this session is inert. Autopilot activates only from an operator-initiated command: ${ACTIVATING_COMMANDS.map((name) => `/${name}`).join(", ")}. Run one of those first; /${command} will not activate implicitly.`);
    this.name = "AutopilotInertError";
  }
}

export class ActivationRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivationRecordError";
  }
}

export interface ActivationRecord {
  readonly schema_version: typeof ACTIVATION_RECORD_SCHEMA;
  readonly session_id: string;
  readonly process_identity: string;
  readonly granted_by_command: string;
  readonly activated_at_unix_ms: number;
}

export interface ActivationServices {
  readonly transport: CoreTransport;
  readonly backgroundTasks: PiBackgroundTaskClient;
}

export interface ActivationDeps extends ResolveCoreOptions {
  readonly transport?: CoreTransport;
  readonly backgroundTasks?: PiBackgroundTaskClient;
  readonly stateRoot?: string;
  readonly processIdentity?: string;
}

function currentProcessIdentity(deps: ActivationDeps): string {
  if (deps.processIdentity !== undefined) return deps.processIdentity;
  return `pid:${String(process.pid)}:started:${String(Math.trunc(Date.now() - Math.trunc(process.uptime() * 1000)))}`;
}

export function activationRecordPath(sessionId: string, deps: ActivationDeps = {}): string {
  assertUsableSessionId(sessionId);
  return join(deps.stateRoot ?? join(homedir(), ".pi", "agent", "autopilot", "v2"), "sessions", `${sessionId}.json`);
}

function assertUsableSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new ActivationRecordError("Autopilot activation requires a non-empty Pi session id");
  if (!/^[A-Za-z0-9._-]+$/u.test(sessionId)) throw new ActivationRecordError(`Autopilot activation session id is not a bare path segment: ${sessionId}`);
}

export function readActivationRecord(sessionId: string, deps: ActivationDeps = {}): ActivationRecord | undefined {
  const path = activationRecordPath(sessionId, deps);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new ActivationRecordError(`Autopilot activation record at ${path} could not be read: ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ActivationRecordError(`Autopilot activation record at ${path} is not valid JSON: ${errorMessage(error)}`);
  }
  const record = requireActivationRecord(parsed, path);
  if (record.session_id !== sessionId) throw new ActivationRecordError(`Autopilot activation record at ${path} is keyed to session ${record.session_id} but was read for session ${sessionId}`);
  return record.process_identity === currentProcessIdentity(deps) ? record : undefined;
}

function requireActivationRecord(value: unknown, path: string): ActivationRecord {
  const object = closedRecord(value, ACTIVATION_RECORD.fields, `Autopilot activation record at ${path}`, ActivationRecordError);
  if (object.schema_version !== ACTIVATION_RECORD_SCHEMA) throw new ActivationRecordError(`Autopilot activation record at ${path} has schema_version ${String(object.schema_version)}, expected ${ACTIVATION_RECORD_SCHEMA}`);
  const command = nonEmptyString(object.granted_by_command, `Autopilot activation record at ${path} field granted_by_command`, ActivationRecordError);
  if (!(ACTIVATING_COMMANDS as readonly string[]).includes(command)) throw new ActivationRecordError(`Autopilot activation record at ${path} names ${command}, which is not an activating command`);
  return {
    schema_version: ACTIVATION_RECORD_SCHEMA,
    session_id: nonEmptyString(object.session_id, `Autopilot activation record at ${path} field session_id`, ActivationRecordError),
    process_identity: nonEmptyString(object.process_identity, `Autopilot activation record at ${path} field process_identity`, ActivationRecordError),
    granted_by_command: command,
    activated_at_unix_ms: nonNegativeInteger(object.activated_at_unix_ms, `Autopilot activation record at ${path} field activated_at_unix_ms`, ActivationRecordError),
  };
}

function writeActivationRecord(record: ActivationRecord, deps: ActivationDeps): void {
  const path = activationRecordPath(record.session_id, deps);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const handle = openSync(path, "w", 0o600);
  try {
    writeSync(handle, JSON.stringify(record));
  } finally {
    closeSync(handle);
  }
}

export function pruneActivationRecord(sessionId: string, deps: ActivationDeps = {}): void {
  rmSync(activationRecordPath(sessionId, deps), { force: true });
}

export class AutopilotActivation {
  private currentState: ActivationState = "inert";
  private services: ActivationServices | undefined;
  private inFlight: Promise<ActivationServices> | undefined;
  private sessionId: string | undefined;
  private grantedByCommand: string | undefined;
  private failure: Error | undefined;
  private readonly pi: ExtensionAPI;
  private readonly deps: ActivationDeps;
  private readonly onActivated: (services: ActivationServices) => void | Promise<void>;

  constructor(pi: ExtensionAPI, deps: ActivationDeps, onActivated: (services: ActivationServices) => void | Promise<void>) {
    this.pi = pi;
    this.deps = deps;
    this.onActivated = onActivated;
  }

  get state(): ActivationState { return this.currentState; }
  get grantingCommand(): string | undefined { return this.grantedByCommand; }

  bindSession(sessionId: string): void { assertUsableSessionId(sessionId); this.sessionId = sessionId; }
  boundSessionId(): string | undefined { return this.sessionId; }
  requireTransport(): CoreTransport { return this.requireServices().transport; }
  requireBackgroundTasks(): PiBackgroundTaskClient { return this.requireServices().backgroundTasks; }

  requireServices(): ActivationServices {
    if (this.currentState === "failed" && this.failure !== undefined) throw this.failure;
    if (this.currentState === "active" && this.services !== undefined) return this.services;
    throw new Error(`Autopilot is inert in this session: no transport or background client exists. Activation happens only inside ${ACTIVATING_COMMANDS.map((name) => `/${name}`).join(", ")}.`);
  }

  requireActiveForCommand(command: string): ActivationServices {
    if (this.currentState === "failed" && this.failure !== undefined) throw this.failure;
    if (this.currentState !== "active" || this.services === undefined) throw new AutopilotInertError(command);
    return this.services;
  }

  async ensureActivated(command: string): Promise<ActivationServices> {
    if (this.currentState === "failed" && this.failure !== undefined) throw this.failure;
    if (this.currentState === "active" && this.services !== undefined) return this.services;
    if (this.inFlight !== undefined) return this.inFlight;
    assertActivatingCommand(command);
    this.currentState = "activating";
    this.inFlight = this.activate(command, true);
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }

  async reactivateFromRecord(record: ActivationRecord): Promise<ActivationServices> {
    if (this.currentState === "active" && this.services !== undefined) return this.services;
    this.currentState = "activating";
    this.inFlight = this.activate(record.granted_by_command, false);
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }

  private async activate(command: string, persist: boolean): Promise<ActivationServices> {
    const sessionId = this.sessionId;
    if (sessionId === undefined) throw this.fail(new Error("Autopilot cannot activate before Pi supplied a session identity via session_start."));
    let transport: CoreTransport | undefined;
    let backgroundTasks: PiBackgroundTaskClient | undefined;
    try {
      if (this.deps.transport === undefined) resolveCoreBinary(this.deps);
      transport = this.deps.transport ?? new CoreTransport({ packageJsonPath: this.deps.packageJsonPath });
      backgroundTasks = this.deps.backgroundTasks ?? new PiBackgroundTaskClient(this.pi.events);
      const services = { transport, backgroundTasks };
      await this.onActivated(services);
      if (persist) writeActivationRecord({ schema_version: ACTIVATION_RECORD_SCHEMA, session_id: sessionId, process_identity: currentProcessIdentity(this.deps), granted_by_command: command, activated_at_unix_ms: Date.now() }, this.deps);
      this.services = services;
      this.grantedByCommand = command;
      this.currentState = "active";
      return services;
    } catch (error) {
      if (backgroundTasks !== undefined && this.deps.backgroundTasks === undefined) { try { await backgroundTasks.close(); } catch {} }
      if (transport !== undefined && this.deps.transport === undefined) transport.close();
      this.services = undefined;
      throw this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): Error {
    this.currentState = "failed";
    this.failure = error;
    return error;
  }
}

function assertActivatingCommand(command: string): void {
  if ((ACTIVATING_COMMANDS as readonly string[]).includes(command)) return;
  throw new Error(`Autopilot activation was requested by /${command}, which is not an activating command. Only ${ACTIVATING_COMMANDS.map((name) => `/${name}`).join(", ")} may grant Autopilot authority.`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
