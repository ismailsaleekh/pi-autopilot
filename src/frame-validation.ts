import type {
  ActionKind,
  BackgroundAction,
  BackgroundActionBgRun,
  CoreToHostFrame,
  CoreToHostGuardDecisionPayload,
  CoreToHostSessionPayload,
  CoreToHostSpawnWavePayload,
  CoreToHostUiPayload,
  JsonObject,
} from "./generated/index.ts";

export class CoreFrameValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreFrameValidationError";
  }
}

const ACTION_KINDS = new Set<ActionKind>([
  "launch-background",
  "reconcile-background",
  "read-failure-log",
  "stop-background",
  "request-operator",
  "return-idle",
]);

export function validateCoreToHostFrame(value: unknown): CoreToHostFrame {
  const frame = requireClosedRecord(value, ["v", "id", "kind", "payload"], "core frame");
  if (frame.v !== 1) throw new CoreFrameValidationError("core frame v must be 1");
  const id = requireNonNegativeInteger(frame.id, "core frame id");
  const kind = requireString(frame.kind, "core frame kind");
  switch (kind) {
    case "done":
      return { v: 1, id, kind, payload: validateDonePayload(frame.payload) };
    case "guard-decision":
      return { v: 1, id, kind, payload: validateGuardDecisionPayload(frame.payload) };
    case "log":
      return { v: 1, id, kind, payload: validateLogPayload(frame.payload) };
    case "session":
      return { v: 1, id, kind, payload: validateSessionPayload(frame.payload) };
    case "spawn":
      return { v: 1, id, kind, payload: validateSpawnPayload(frame.payload) };
    case "spawn-wave":
      return { v: 1, id, kind, payload: validateSpawnWavePayload(frame.payload) };
    case "ui":
      return { v: 1, id, kind, payload: validateUiPayload(frame.payload) };
    default:
      throw new CoreFrameValidationError(`unsupported core frame kind: ${kind}`);
  }
}

export function validateBackgroundAction(value: unknown): BackgroundAction {
  const action = requireClosedRecord(
    value,
    ["action_id", "assignment_id", "kind", "bg_run", "run_revision", "expires_at", "supersession_state"],
    "background action",
  );
  const kind = requireString(action.kind, "background action kind");
  if (!ACTION_KINDS.has(kind as ActionKind)) throw new CoreFrameValidationError(`unsupported background action kind: ${kind}`);
  const out: BackgroundAction = {
    action_id: requireString(action.action_id, "background action action_id"),
    assignment_id: requireString(action.assignment_id, "background action assignment_id"),
    kind: kind as ActionKind,
    bg_run: validateBgRunDescriptorIdentity(action.bg_run as BackgroundActionBgRun),
    run_revision: requireNonNegativeInteger(action.run_revision, "background action run_revision"),
    supersession_state: requireString(action.supersession_state, "background action supersession_state"),
  };
  if (Object.prototype.hasOwnProperty.call(action, "expires_at")) {
    const expiresAt = action.expires_at;
    if (expiresAt !== null && typeof expiresAt !== "string") {
      throw new CoreFrameValidationError("background action expires_at must be string or null when present");
    }
    out.expires_at = expiresAt;
  }
  return out;
}

export function validateBgRunDescriptorIdentity<T extends BackgroundActionBgRun>(value: T): T {
  const descriptor = requireClosedRecord(
    value,
    ["name", "command", "isAgent", "timeoutSeconds", "notifyOnCompletion", "triggerOnCompletion"],
    "bg_run",
  );
  requireString(descriptor.name, "bg_run.name");
  requireString(descriptor.command, "bg_run.command");
  requireBoolean(descriptor.isAgent, "bg_run.isAgent");
  requireBoolean(descriptor.notifyOnCompletion, "bg_run.notifyOnCompletion");
  requireBoolean(descriptor.triggerOnCompletion, "bg_run.triggerOnCompletion");
  if (Object.prototype.hasOwnProperty.call(descriptor, "timeoutSeconds")) {
    requirePositiveInteger(descriptor.timeoutSeconds, "bg_run.timeoutSeconds");
  }
  return value;
}

function validateDonePayload(value: unknown): { status: string } {
  const payload = requireClosedRecord(value, ["status"], "done payload");
  return { status: requireString(payload.status, "done.status") };
}

function validateGuardDecisionPayload(value: unknown): CoreToHostGuardDecisionPayload {
  const payload = requireClosedRecord(value, ["decision", "reason"], "guard-decision payload");
  return {
    decision: requireString(payload.decision, "guard-decision.decision"),
    reason: requireString(payload.reason, "guard-decision.reason"),
  };
}

function validateLogPayload(value: unknown): { line: string } {
  const payload = requireClosedRecord(value, ["line"], "log payload");
  return { line: requireString(payload.line, "log.line") };
}

function validateSessionPayload(value: unknown): CoreToHostSessionPayload {
  const payload = requireClosedRecord(value, ["session_action", "payload"], "session payload");
  return {
    session_action: requireString(payload.session_action, "session.session_action"),
    payload: requireJsonObject(payload.payload, "session.payload"),
  };
}

function validateSpawnPayload(value: unknown): { action: BackgroundAction } {
  const payload = requireClosedRecord(value, ["action"], "spawn payload");
  return { action: validateBackgroundAction(payload.action) };
}

function validateSpawnWavePayload(value: unknown): CoreToHostSpawnWavePayload {
  const payload = requireClosedRecord(value, ["actions"], "spawn-wave payload");
  const actions = requireArray(payload.actions, "spawn-wave.actions").map((action) => validateBackgroundAction(action));
  if (actions.length === 0) throw new CoreFrameValidationError("spawn-wave.actions must be non-empty");
  if (actions.length > 64) throw new CoreFrameValidationError("spawn-wave.actions exceeds maximum 64");
  requireUnique(actions.map((action) => action.action_id), "spawn-wave action_id");
  requireUnique(actions.map((action) => action.assignment_id), "spawn-wave assignment_id");
  return { actions };
}

function validateUiPayload(value: unknown): CoreToHostUiPayload {
  const payload = requireClosedRecord(value, ["ui_kind", "content"], "ui payload");
  return {
    ui_kind: requireString(payload.ui_kind, "ui.ui_kind"),
    content: requireJsonObject(payload.content, "ui.content"),
  };
}

function requireClosedRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreFrameValidationError(`${label} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CoreFrameValidationError(`${label} contains unknown key ${key}`);
  }
  return value as Record<string, unknown>;
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreFrameValidationError(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new CoreFrameValidationError(`${label} must be an array`);
}

function requireUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new CoreFrameValidationError(`${label} must be unique: ${value}`);
    seen.add(value);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new CoreFrameValidationError(`${label} must be a non-empty string`);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  throw new CoreFrameValidationError(`${label} must be boolean`);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new CoreFrameValidationError(`${label} must be a non-negative integer`);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new CoreFrameValidationError(`${label} must be a positive integer`);
}
