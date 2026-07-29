import { readFile } from "node:fs/promises";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PiBackgroundTaskClient, type BgTaskSnapshot } from "./background-tasks.ts";
import { registerAutopilotCommands, applyAndRecord, type RegisterCommandOptions } from "./commands.ts";
import type { OperatorMessageLevel, OperatorMessageSink } from "./effects.ts";
import {
  AutopilotActivation,
  pruneActivationRecord,
  readActivationRecord,
  type ActivationDeps,
  type ActivationServices,
} from "./activation.ts";
import type { ResolveCoreOptions } from "./resolve-core.ts";
import { CoreTransport } from "./transport.ts";
import type { BackgroundAction } from "./generated/index.ts";

export interface AutopilotExtensionOptions extends ResolveCoreOptions {
  readonly transport?: CoreTransport;
  readonly backgroundTasks?: PiBackgroundTaskClient;
  /** Overrides the `~/.pi/agent/autopilot/v2` activation-record root. */
  readonly stateRoot?: string;
  /** Overrides this process's identity. Exists so tests can model a foreign process. */
  readonly processIdentity?: string;
  /**
   * Runs once, inside the activation transaction, when Autopilot becomes
   * active. The packaged entrypoint uses this to register its planning-submit
   * tools lazily. Throwing here fails activation and rolls it back.
   */
  readonly onActivated?: () => void | Promise<void>;
}

const MAX_UNMATCHED_TERMINALS = 100;

interface TaskBinding {
  readonly task_id: string;
  readonly action: BackgroundAction;
}

export default function autopilotExtension(pi: ExtensionAPI, options: AutopilotExtensionOptions = {}): void {
  const operatorMessage = operatorMessageSink(pi);
  const taskBindings = new Map<string, TaskBinding>();
  const unmatchedTerminalTasks = new Map<string, BgTaskSnapshot>();
  /**
   * Every task id Autopilot itself launched, append-only for the session. This
   * is the jurisdiction test: it is a record of Autopilot's OWN actions, not an
   * inference about foreign ones.
   */
  const launchedTaskIds = new Set<string>();
  const droppedForeignTerminals: string[] = [];
  let currentCtx: ExtensionContext | undefined;
  let unsubscribeTerminal: (() => void) | undefined;

  const activationDeps: ActivationDeps = activationDepsFrom(options);

  // Subscription is established INSIDE activation and BEFORE any command frame
  // can be sent, so no Autopilot-owned launch can precede its own subscription.
  const activation = new AutopilotActivation(pi, activationDeps, async (services) => {
    unsubscribeTerminal = services.backgroundTasks.onTerminal(handleTerminal);
    await options.onActivated?.();
  });

  function commandOptions(services: ActivationServices): RegisterCommandOptions {
    return {
      transport: services.transport,
      backgroundTasks: services.backgroundTasks,
      operatorMessage,
      onSpawn: rememberSpawn,
    };
  }

  async function rememberSpawn({ action, task }: { readonly action: BackgroundAction; readonly task: BgTaskSnapshot }): Promise<void> {
    const binding = bindTaskToAction(task, action);
    taskBindings.set(task.id, binding);
    launchedTaskIds.add(task.id);
    const buffered = unmatchedTerminalTasks.get(task.id);
    if (buffered === undefined) return;
    unmatchedTerminalTasks.delete(task.id);
    await handleTerminal(buffered);
  }

  async function handleTerminal(task: BgTaskSnapshot): Promise<void> {
    const binding = taskBindings.get(task.id);
    if (binding === undefined) {
      // Buffer EVERY unmatched terminal, including foreign ones.
      //
      // Jurisdiction cannot be decided here: a task's id exists only after
      // `backgroundTasks.run()` resolves, and a fast task can go terminal
      // BEFORE that return value is bound (the immediate-terminal race). A
      // jurisdiction test at this point would discard Autopilot's own task and
      // silently stall the run. Classification therefore happens at report
      // time, where the launched set is complete.
      //
      // Buffering unconditionally also preserves the MAX_UNMATCHED_TERMINALS
      // overflow contract exactly as it was.
      bufferUnmatchedTerminal(task, unmatchedTerminalTasks);
      return;
    }
    taskBindings.delete(task.id);
    validateTaskActionCorrelation(task, binding.action);
    const ctx = currentCtx;
    if (ctx === undefined) {
      const message = `Autopilot received terminal background task ${correlationLabel(binding)} before Pi supplied a session context; terminal correlation was not forwarded.`;
      await operatorMessage(message, "error");
      throw new Error(message);
    }
    try {
      // A terminal event can only reach this point via a subscription created
      // inside activation, so the services are necessarily present. The
      // accessor still throws rather than assuming, keeping inertness structural.
      const services = activation.requireServices();
      const agentResult = task.status === "completed" ? await completedPlanningAgentResult(binding) : undefined;
      const frame = await services.transport.request("task-completed", {
        task_id: task.id,
        action_id: binding.action.action_id,
        assignment_id: binding.action.assignment_id,
        status: task.status,
      });
      await applyAndRecord(frame, ctx, commandOptions(services));
      if (agentResult !== undefined) {
        const resultFrame = await services.transport.request("agent-result", agentResult);
        await applyAndRecord(resultFrame, ctx, commandOptions(services));
      }
    } catch (error) {
      await operatorMessage(`Autopilot terminal handling failed for ${correlationLabel(binding)}: ${boundedError(error)}`, "error");
      throw error;
    }
  }

  /**
   * Partitions the buffered terminals by JURISDICTION, which is now decidable
   * because every launch this session performed has been recorded.
   *
   * A task is Autopilot's iff Autopilot itself launched it (`launchedTaskIds`
   * is a record of Autopilot's OWN actions, never an inference about foreign
   * ones). Only those produce the genuine launched-and-lost warning. Terminal
   * events for tasks Autopilot never launched — the operator's own `bg_run`,
   * another extension's work — are out of jurisdiction and get one bounded
   * structured diagnostic instead of a warning per task.
   */
  async function reportUnmatchedTerminals(): Promise<void> {
    for (const task of unmatchedTerminalTasks.values()) {
      if (!launchedTaskIds.has(task.id)) {
        if (droppedForeignTerminals.length < MAX_DROPPED_FOREIGN_DIAGNOSTICS) droppedForeignTerminals.push(task.id);
        continue;
      }
      await operatorMessage(
        `Autopilot observed terminal background task ${task.id} but no exact Autopilot action binding was ever recorded; command=${boundedError(task.command)}`,
        "warning",
      );
    }
    unmatchedTerminalTasks.clear();
  }

  // The ONLY load-time effect: a command that is not registered cannot be
  // typed, so registration is the irreducible activation entrypoint. No tool,
  // no transport, no EventBus subscription, and no Core process yet exists.
  registerAutopilotCommands(pi, {
    activate: async (command) => commandOptions(await activation.ensureActivated(command)),
    requireActive: (command) => commandOptions(activation.requireActiveForCommand(command)),
  });

  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    activation.bindSession(sessionId);

    // Exact-key lookup on THIS session's Pi-supplied identity. A hit can only
    // RESTATE a grant this process already made; it can never create one.
    const record = readActivationRecord(sessionId, activationDeps);
    if (record === undefined) return;

    if (sessionStartIsReplacement(event)) {
      // new/resume/fork are genuinely different sessions and must never inherit
      // authority, even when they reuse the session id from a file header.
      pruneActivationRecord(sessionId, activationDeps);
      await operatorMessage(
        `Autopilot did not inherit activation into this ${String(shutdownReason(event) ?? "replacement")} session; the prior activation record was discarded. Run an activating command to arm this session.`,
        "info",
      );
      return;
    }

    try {
      await activation.reactivateFromRecord(record);
    } catch (error) {
      // Record-hit-but-activation-failed: loud, record PRESERVED, state=failed.
      // Never silently inert — that would disarm a live run.
      await operatorMessage(
        `Autopilot could not re-establish its recorded activation for session ${sessionId}: ${boundedError(error)}. The activation record was preserved; Autopilot is in a failed state and will not silently continue.`,
        "error",
      );
      throw error;
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const reason = shutdownReason(event);
    const sessionId = activation.boundSessionId();

    // Prune on every non-reload teardown so new/resume/fork/quit cannot inherit
    // activation. Runs even when inert, because a prior activation in this same
    // session must not outlive it.
    if (reason !== "reload" && sessionId !== undefined) {
      pruneActivationRecord(sessionId, activationDeps);
    }

    // LAYER 1: the shutdown body is gated on activation. An inert session sends
    // no `shutdown` frame, so it never spawns Core at exit and never renders
    // `Autopilot done: ok:shutdown`. This is causal — the frame is not sent —
    // rather than filtering Core's status string, which is exactly the
    // heuristic shape BUG-183 taught against.
    if (activation.state !== "active") return;

    const services = activation.requireServices();
    try {
      const payload = reason === undefined ? {} : { reason };
      const frame = await services.transport.request("shutdown", payload, 2000);
      await applyAndRecord(frame, ctx, commandOptions(services));
    } finally {
      try {
        // Partition first, then emit the single bounded foreign diagnostic.
        await reportUnmatchedTerminals();
        await reportForeignTerminalDiagnostic(operatorMessage, droppedForeignTerminals);
      } finally {
        unsubscribeTerminal?.();
        unsubscribeTerminal = undefined;
        try {
          await services.backgroundTasks.close();
        } finally {
          services.transport.close();
        }
      }
    }
  });
}

const MAX_DROPPED_FOREIGN_DIAGNOSTICS = 20;

function activationDepsFrom(options: AutopilotExtensionOptions): ActivationDeps {
  const deps: {
    -readonly [K in keyof ActivationDeps]: ActivationDeps[K];
  } = {};
  if (options.packageJsonPath !== undefined) deps.packageJsonPath = options.packageJsonPath;
  if (options.platform !== undefined) deps.platform = options.platform;
  if (options.arch !== undefined) deps.arch = options.arch;
  if (options.transport !== undefined) deps.transport = options.transport;
  if (options.backgroundTasks !== undefined) deps.backgroundTasks = options.backgroundTasks;
  if (options.stateRoot !== undefined) deps.stateRoot = options.stateRoot;
  if (options.processIdentity !== undefined) deps.processIdentity = options.processIdentity;
  return deps;
}

/**
 * `/reload` emits session_shutdown{reason:"reload"} then session_start
 * {reason:"reload"} for the SAME session. new/resume/fork are different
 * sessions and carry `previousSessionFile`. Comparison is exact equality on
 * Pi-supplied fields — never a prefix or substring match.
 */
function sessionStartIsReplacement(event: unknown): boolean {
  const record = event as Record<string, unknown>;
  const reason = record["reason"];
  if (reason === "reload") return false;
  if (reason === "new" || reason === "resume" || reason === "fork") return true;
  return record["previousSessionFile"] !== undefined;
}

async function reportForeignTerminalDiagnostic(operatorMessage: OperatorMessageSink, dropped: readonly string[]): Promise<void> {
  if (dropped.length === 0) return;
  await operatorMessage(
    `Autopilot ignored ${String(dropped.length)} terminal background task event(s) outside its jurisdiction (not launched by Autopilot): ${dropped.join(", ")}`,
    "info",
  );
}

function bindTaskToAction(task: BgTaskSnapshot, action: BackgroundAction): TaskBinding {
  validateTaskActionCorrelation(task, action);
  return { task_id: task.id, action };
}

function validateTaskActionCorrelation(task: BgTaskSnapshot, action: BackgroundAction): void {
  const descriptor = action.bg_run;
  assertEqual(task.command, descriptor.command, "command", task, action);
  assertEqual(task.name, descriptor.name, "name", task, action);
  assertOptionalEqual(task["isAgent"], descriptor.isAgent, "isAgent", task, action);
  assertOptionalEqual(task["notifyOnCompletion"], descriptor.notifyOnCompletion, "notifyOnCompletion", task, action);
  assertOptionalEqual(task["triggerOnCompletion"], descriptor.triggerOnCompletion, "triggerOnCompletion", task, action);
  assertOptionalEqual(task["timeoutSeconds"], descriptor.timeoutSeconds, "timeoutSeconds", task, action);
}

function assertEqual(actual: unknown, expected: unknown, field: string, task: BgTaskSnapshot, action: BackgroundAction): void {
  if (actual === expected) return;
  throw new Error(`Autopilot terminal correlation mismatch for task=${task.id} action=${action.action_id} assignment=${action.assignment_id}: ${field} expected ${String(expected)}, got ${String(actual)}`);
}

function assertOptionalEqual(actual: unknown, expected: unknown, field: string, task: BgTaskSnapshot, action: BackgroundAction): void {
  if (actual === undefined && expected === undefined) return;
  if (actual === undefined) return;
  assertEqual(actual, expected, field, task, action);
}

function bufferUnmatchedTerminal(task: BgTaskSnapshot, unmatchedTerminalTasks: Map<string, BgTaskSnapshot>): void {
  if (unmatchedTerminalTasks.size >= MAX_UNMATCHED_TERMINALS && !unmatchedTerminalTasks.has(task.id)) {
    throw new Error(`Autopilot unmatched terminal buffer overflow at ${String(MAX_UNMATCHED_TERMINALS)} tasks; latest task=${task.id}`);
  }
  unmatchedTerminalTasks.set(task.id, task);
}

async function completedPlanningAgentResult(binding: TaskBinding): Promise<{ readonly assignment_id: string; readonly carrier: Record<string, unknown> } | undefined> {
  const specPath = specPathFromCommand(binding.action.bg_run.command);
  const spec = requireRecord(JSON.parse(await readFile(specPath, "utf8")), "agent-run spec");
  const actionId = requireString(spec["action_id"], "agent-run spec.action_id");
  const assignmentId = requireString(spec["assignment_id"], "agent-run spec.assignment_id");
  const boundaryId = requireString(spec["boundary_id"], "agent-run spec.boundary_id");
  const resultContract = requireString(spec["result_contract"], "agent-run spec.result_contract");
  if (actionId !== binding.action.action_id || assignmentId !== binding.action.assignment_id) {
    throw new Error(`Autopilot completed task binding drift: action/assignment expected ${binding.action.action_id}/${binding.action.assignment_id}, got ${actionId}/${assignmentId}`);
  }
  if (resultContract === "autopilot.delivery_result.v1") return undefined;
  const carrierPath = requireString(spec["carrier_path"], "agent-run spec.carrier_path");
  const carrier = requireRecord(JSON.parse(await readFile(carrierPath, "utf8")), "planning carrier");
  if (requireString(carrier["action_id"], "planning carrier.action_id") !== actionId
    || requireString(carrier["assignment_id"], "planning carrier.assignment_id") !== assignmentId
    || requireString(carrier["boundary_id"], "planning carrier.boundary_id") !== boundaryId) {
    throw new Error(`Autopilot planning carrier identity drift for ${actionId}/${assignmentId}/${boundaryId}`);
  }
  return { assignment_id: assignmentId, carrier };
}

function specPathFromCommand(command: string): string {
  const argv = shellWords(command);
  const index = argv.indexOf("--spec");
  const specPath = argv[index + 1];
  if (index < 0 || specPath === undefined || specPath.length === 0) {
    throw new Error(`Autopilot agent command has no --spec path: ${command}`);
  }
  return specPath;
}

function shellWords(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? "";
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && ch === "\\") {
        index += 1;
        if (index >= command.length) throw new Error("Autopilot agent command ends with an escape");
        current += command[index] ?? "";
      } else current += ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      index += 1;
      if (index >= command.length) throw new Error("Autopilot agent command ends with an escape");
      current += command[index] ?? "";
      continue;
    }
    current += ch;
  }
  if (quote !== undefined) throw new Error("Autopilot agent command has an unterminated quote");
  if (current.length > 0) out.push(current);
  return out;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`Autopilot ${label} is not a JSON object`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Autopilot ${label} must be a non-empty string`);
}

function correlationLabel(binding: TaskBinding): string {
  return `task=${binding.task_id} action=${binding.action.action_id} assignment=${binding.action.assignment_id}`;
}

function operatorMessageSink(pi: ExtensionAPI): OperatorMessageSink {
  return (message: string, level: OperatorMessageLevel) => {
    pi.sendMessage(
      { customType: "pi-autopilot", content: message, display: true, details: { level } },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
  };
}

function shutdownReason(event: unknown): string | undefined {
  const record = event as Record<string, unknown>;
  return typeof record["reason"] === "string" ? record["reason"] : undefined;
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}
