import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { PiBackgroundTaskClient } from "./background-tasks.ts";
import type { OperatorMessageSink } from "./effects.ts";
import { resolveCoreBinary, type ResolveCoreOptions } from "./resolve-core.ts";
import { CoreTransport } from "./transport.ts";

/**
 * AUTOPILOT ACTIVATION INVARIANT
 * =============================
 *
 * A filesystem read may only ever WITHHOLD or REVOKE Autopilot authority.
 * It may NEVER GRANT it. Authority is granted only inside an operator-initiated
 * command handler in the current process. Any persisted record is a
 * RESTATEMENT of that grant, keyed to the identity that made it.
 *
 * Concretely: reading `sessions/<session-id>.json` can never be the reason
 * Autopilot becomes active. The record is admissible only to restate a grant
 * that THIS process already made, which is why every record carries the
 * granting process identity (pid + process start boundary) and is rejected
 * when that identity does not match. `/reload` re-evaluates the extension
 * module inside the same process, so the restatement succeeds; `/resume` of a
 * crashed session in a NEW process reuses the same Pi session id
 * (SessionManager restores `id` from the file header) but cannot match the
 * process identity, so it stays inert. That is the whole reason the process
 * identity is part of the key rather than the session id alone.
 *
 * Autopilot is INERT until an operator runs one of the activating commands.
 * Inert narrows JURISDICTION, never STRICTNESS: an inert session does fewer
 * things, but everything it still does fails exactly as loudly as before.
 */

/** Commands whose handlers are permitted to grant activation. */
export const ACTIVATING_COMMANDS = Object.freeze([
  "autopilot-plan",
  "autopilot",
  "autopilot-onboard",
  "autopilot-inject",
] as const);

/** Commands that operate on an already-armed session but may never arm one. */
export const OPERATING_COMMANDS = Object.freeze([
  "autopilot-status",
  "autopilot-config",
  "autopilot-handoff",
  "autopilot-close",
  "autopilot-abort",
  "autopilot-answer",
] as const);

export const ACTIVATION_RECORD_SCHEMA = "autopilot.host_activation.v1" as const;

export type ActivationState = "inert" | "activating" | "active" | "failed";

export class AutopilotInertError extends Error {
  constructor(command: string) {
    super(
      `/${command} requires an active Autopilot session, but this session is inert. `
      + `Autopilot activates only from an operator-initiated command: `
      + `${ACTIVATING_COMMANDS.map((name) => `/${name}`).join(", ")}. `
      + `Run one of those first; ${`/${command}`} will not activate implicitly.`,
    );
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
  /**
   * The activating command that granted authority. The Host knows this name
   * because it registered the command; it is NOT parsed out of operator
   * arguments. Autopilot deliberately records no workstream: `/autopilot-onboard`
   * takes free-form request text with no workstream argument, and workstream
   * semantics (including refusing a second concurrent run via
   * `StateRoot::reserve` -> `ActiveRun`) belong to Core, not the Host.
   */
  readonly granted_by_command: string;
  readonly activated_at_unix_ms: number;
}

export interface ActivationServices {
  readonly transport: CoreTransport;
  readonly backgroundTasks: PiBackgroundTaskClient;
}

export interface ActivationDeps extends ResolveCoreOptions {
  /** Injected only by tests that must not spawn a real Core child. */
  readonly transport?: CoreTransport;
  readonly backgroundTasks?: PiBackgroundTaskClient;
  /** Overrides the `~/.pi/agent/autopilot/v2` root. Absolute path. */
  readonly stateRoot?: string;
  /** Overrides the process identity. Exists so tests can model a foreign process. */
  readonly processIdentity?: string;
}

/**
 * Identity of THIS process. `pid` alone is reusable by the OS after exit, so it
 * is paired with the process start boundary. Both come from the running process
 * itself — never from the filesystem, a directory name, or an environment sniff.
 */
function currentProcessIdentity(deps: ActivationDeps): string {
  if (deps.processIdentity !== undefined) return deps.processIdentity;
  const startedAtMs = Math.trunc(Date.now() - Math.trunc(process.uptime() * 1000));
  return `pid:${String(process.pid)}:started:${String(startedAtMs)}`;
}

function defaultStateRoot(): string {
  return join(homedir(), ".pi", "agent", "autopilot", "v2");
}

/**
 * The record address for exactly one session. `sessionId` is supplied by Pi
 * (`ctx.sessionManager.getSessionId()`); it is never derived from a directory
 * listing, and this function never enumerates a directory.
 */
export function activationRecordPath(sessionId: string, deps: ActivationDeps = {}): string {
  assertUsableSessionId(sessionId);
  const root = deps.stateRoot ?? defaultStateRoot();
  return join(root, "sessions", `${sessionId}.json`);
}

function assertUsableSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ActivationRecordError("Autopilot activation requires a non-empty Pi session id");
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(sessionId)) {
    throw new ActivationRecordError(
      `Autopilot activation session id is not a bare path segment: ${sessionId}`,
    );
  }
}

/**
 * Reads the record at THIS session's exact address.
 *
 * Read rules — each is a stated terminal outcome, never a silent fallback:
 *   - no record at this address                 -> undefined (caller stays INERT)
 *   - present, identity matches, schema valid   -> record (caller RE-ACTIVATES)
 *   - present, session_id mismatch              -> LOUD FAILURE
 *   - present, foreign process identity         -> undefined (WITHHOLD, stated)
 *   - malformed / unparseable                   -> LOUD FAILURE
 *
 * A malformed record is never treated as "assume inert": silently disarming a
 * live run is the mirror image of BUG-183's silently-arming probe.
 */
export function readActivationRecord(sessionId: string, deps: ActivationDeps = {}): ActivationRecord | undefined {
  const path = activationRecordPath(sessionId, deps);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new ActivationRecordError(
      `Autopilot activation record at ${path} could not be read: ${errorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ActivationRecordError(
      `Autopilot activation record at ${path} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const record = requireActivationRecord(parsed, path);

  if (record.session_id !== sessionId) {
    throw new ActivationRecordError(
      `Autopilot activation record at ${path} is keyed to session ${record.session_id} but was read for session ${sessionId}`,
    );
  }

  // WITHHOLD (never grant): a record written by a different process cannot
  // restate a grant this process made. Stated outcome, not a fallback.
  if (record.process_identity !== currentProcessIdentity(deps)) return undefined;

  return record;
}

function requireActivationRecord(value: unknown, path: string): ActivationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ActivationRecordError(`Autopilot activation record at ${path} is not a JSON object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(["schema_version", "session_id", "process_identity", "granted_by_command", "activated_at_unix_ms"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ActivationRecordError(`Autopilot activation record at ${path} contains unknown key ${key}`);
    }
  }
  if (object["schema_version"] !== ACTIVATION_RECORD_SCHEMA) {
    throw new ActivationRecordError(
      `Autopilot activation record at ${path} has schema_version ${String(object["schema_version"])}, expected ${ACTIVATION_RECORD_SCHEMA}`,
    );
  }
  return {
    schema_version: ACTIVATION_RECORD_SCHEMA,
    session_id: requireRecordString(object["session_id"], "session_id", path),
    process_identity: requireRecordString(object["process_identity"], "process_identity", path),
    granted_by_command: requireGrantingCommand(object["granted_by_command"], path),
    activated_at_unix_ms: requireRecordInteger(object["activated_at_unix_ms"], "activated_at_unix_ms", path),
  };
}

function requireGrantingCommand(value: unknown, path: string): string {
  const command = requireRecordString(value, "granted_by_command", path);
  if (!(ACTIVATING_COMMANDS as readonly string[]).includes(command)) {
    throw new ActivationRecordError(
      `Autopilot activation record at ${path} names ${command}, which is not an activating command`,
    );
  }
  return command;
}

function requireRecordString(value: unknown, field: string, path: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ActivationRecordError(`Autopilot activation record at ${path} field ${field} must be a non-empty string`);
}

function requireRecordInteger(value: unknown, field: string, path: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new ActivationRecordError(`Autopilot activation record at ${path} field ${field} must be a non-negative integer`);
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

/**
 * Removes the record for exactly one session id. Single-key removal: this never
 * enumerates or sweeps the sessions directory.
 */
export function pruneActivationRecord(sessionId: string, deps: ActivationDeps = {}): void {
  rmSync(activationRecordPath(sessionId, deps), { force: true });
}

/**
 * The single activation seam. There is exactly one implementation, and the only
 * legitimate callers are the four activating command handlers plus the
 * `session_start` reload restatement path.
 */
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

  constructor(
    pi: ExtensionAPI,
    deps: ActivationDeps,
    onActivated: (services: ActivationServices) => void | Promise<void>,
  ) {
    this.pi = pi;
    this.deps = deps;
    this.onActivated = onActivated;
  }

  get state(): ActivationState {
    return this.currentState;
  }

  get grantingCommand(): string | undefined {
    return this.grantedByCommand;
  }

  /** Session identity is supplied by Pi and latched for the life of the instance. */
  bindSession(sessionId: string): void {
    assertUsableSessionId(sessionId);
    this.sessionId = sessionId;
  }

  boundSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Structural inertness: the transport is unreachable unless activation
   * succeeded. Callers cannot accidentally use a half-built Autopilot, which is
   * what makes inertness mechanically testable rather than conventional.
   */
  requireTransport(): CoreTransport {
    return this.requireServices().transport;
  }

  requireBackgroundTasks(): PiBackgroundTaskClient {
    return this.requireServices().backgroundTasks;
  }

  requireServices(): ActivationServices {
    if (this.currentState === "failed" && this.failure !== undefined) throw this.failure;
    if (this.currentState !== "active" || this.services === undefined) {
      throw new Error(
        "Autopilot is inert in this session: no transport or background client exists. "
        + `Activation happens only inside ${ACTIVATING_COMMANDS.map((name) => `/${name}`).join(", ")}.`,
      );
    }
    return this.services;
  }

  /** Loud refusal for operating commands invoked in an unarmed session. */
  requireActiveForCommand(command: string): ActivationServices {
    if (this.currentState === "failed" && this.failure !== undefined) throw this.failure;
    if (this.currentState !== "active" || this.services === undefined) throw new AutopilotInertError(command);
    return this.services;
  }

  /**
   * Idempotent, memoized, transactional activation.
   *
   * Memoized: concurrent activating commands await the SAME promise, so the
   * EventBus is subscribed once and at most one Core child exists.
   *
   * Transactional: acquire -> verify -> record. The record is written LAST, so a
   * failure anywhere leaves nothing persisted, nothing subscribed, and rethrows.
   * No partial activation is representable.
   */
  async ensureActivated(command: string): Promise<ActivationServices> {
    if (this.currentState === "failed" && this.failure !== undefined) throw this.failure;
    if (this.currentState === "active" && this.services !== undefined) return this.services;
    if (this.inFlight !== undefined) return this.inFlight;

    assertActivatingCommand(command);
    this.currentState = "activating";
    this.inFlight = this.activate(command, /* persist */ true);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  /**
   * Restates an existing grant after `/reload`. Never grants: the caller has
   * already proven a record exists at this session's exact address AND that the
   * record was written by this process.
   */
  async reactivateFromRecord(record: ActivationRecord): Promise<ActivationServices> {
    if (this.currentState === "active" && this.services !== undefined) return this.services;
    this.currentState = "activating";
    this.inFlight = this.activate(record.granted_by_command, /* persist */ false);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async activate(command: string, persist: boolean): Promise<ActivationServices> {
    const sessionId = this.sessionId;
    if (sessionId === undefined) {
      throw this.fail(new Error(
        "Autopilot cannot activate before Pi supplied a session identity via session_start.",
      ));
    }

    let transport: CoreTransport | undefined;
    let backgroundTasks: PiBackgroundTaskClient | undefined;
    try {
      // 1. ACQUIRE. A missing or unsupported-platform Core binary is a blocking
      //    failure at the point of use, not a load-time notification.
      if (this.deps.transport === undefined) resolveCoreBinary(this.deps);
      transport = this.deps.transport ?? new CoreTransport({ packageJsonPath: this.deps.packageJsonPath });
      backgroundTasks = this.deps.backgroundTasks ?? new PiBackgroundTaskClient(this.pi.events);

      // 2. VERIFY. Subscription is established by onActivated BEFORE any launch
      //    command frame can be sent, so no Autopilot-owned launch can precede
      //    its own subscription.
      const services: ActivationServices = { transport, backgroundTasks };
      await this.onActivated(services);

      // 3. RECORD — last, so nothing is persisted unless every step succeeded.
      if (persist) {
        writeActivationRecord({
          schema_version: ACTIVATION_RECORD_SCHEMA,
          session_id: sessionId,
          process_identity: currentProcessIdentity(this.deps),
          granted_by_command: command,
          activated_at_unix_ms: Date.now(),
        }, this.deps);
      }

      this.services = services;
      this.grantedByCommand = command;
      this.currentState = "active";
      return services;
    } catch (error) {
      // ROLL BACK: release anything acquired, persist nothing, rethrow loudly.
      if (backgroundTasks !== undefined && this.deps.backgroundTasks === undefined) {
        try {
          await backgroundTasks.close();
        } catch { /* rollback must surface the original failure, not a teardown error */ }
      }
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
  throw new Error(
    `Autopilot activation was requested by /${command}, which is not an activating command. `
    + `Only ${ACTIVATING_COMMANDS.map((name) => `/${name}`).join(", ")} may grant Autopilot authority.`,
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
