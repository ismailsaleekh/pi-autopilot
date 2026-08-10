import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PiBackgroundTaskClient, type BgTaskSnapshot } from "./background-tasks.ts";
import { registerAutopilotCommands, applyAndRecord, type RegisterCommandOptions } from "./commands.ts";
import type { BackgroundActionLaunchDedupe, BackgroundLaunchGate, OperatorMessageLevel, OperatorMessageSink } from "./effects.ts";
import {
  AutopilotActivation,
  pruneActivationRecord,
  readActivationRecord,
  type ActivationDeps,
  type ActivationServices,
} from "./activation.ts";
import type { ResolveCoreOptions } from "./resolve-core.ts";
import { CoreTransport } from "./transport.ts";
import {
  startChildControlBroker,
  stopChildControlBroker,
  type BlockedGateApplication,
  type ChildControlBroker,
  type ChildControlBrokerDiagnostic,
} from "./child-control-broker.ts";
import type { BackgroundAction, ChildControlBlockedGate } from "./generated/index.ts";
import { AUTOPILOT_STATUS_CUSTOM_TYPE, buildAutopilotStatusEntryData } from "./status-channel.ts";

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
  /** Test/lifecycle seam; production uses the sole AF_UNIX broker factory. */
  readonly startChildControlBroker?: typeof startChildControlBroker;
}

const MAX_UNMATCHED_TERMINALS = 100;

interface TaskBinding {
  readonly task_id: string;
  readonly action: BackgroundAction;
}

class SessionLaunchGate implements BackgroundLaunchGate {
  private closed = false;

  close(): void { this.closed = true; }
  assertOpen(): void {
    if (this.closed) throw new Error("Autopilot launch gate is closed by a blocked workstream");
  }
}

interface ActionLaunchEntry {
  readonly descriptor: string;
  readonly launch: Promise<BgTaskSnapshot>;
  task?: BgTaskSnapshot;
}

/**
 * Host-process exact action-id dedupe. Entries survive Core restarts but only
 * successful `backgroundTasks.run` results become append-only task ownership.
 */
class SessionActionLaunchDedupe implements BackgroundActionLaunchDedupe {
  private readonly entries = new Map<string, ActionLaunchEntry>();

  launch(action: BackgroundAction, run: () => Promise<BgTaskSnapshot>): Promise<{ readonly task: BgTaskSnapshot; readonly firstLaunch: boolean }> {
    const descriptor = JSON.stringify(action);
    if (descriptor === undefined) return Promise.reject(new Error(`Autopilot action descriptor is not serializable for action_id=${action.action_id}`));
    const existing = this.entries.get(action.action_id);
    if (existing !== undefined) {
      if (existing.descriptor !== descriptor) {
        return Promise.reject(new Error(`Autopilot action descriptor drift for action_id=${action.action_id}`));
      }
      if (existing.task !== undefined) return Promise.resolve({ task: existing.task, firstLaunch: false });
      return existing.launch.then((task) => ({ task, firstLaunch: false }));
    }
    const launch = Promise.resolve().then(run);
    const entry: ActionLaunchEntry = { descriptor, launch };
    this.entries.set(action.action_id, entry);
    return launch.then(
      (task) => {
        entry.task = task;
        return { task, firstLaunch: true };
      },
      (error: unknown) => {
        if (this.entries.get(action.action_id) === entry) this.entries.delete(action.action_id);
        throw error;
      },
    );
  }
}

export default function autopilotExtension(pi: ExtensionAPI, options: AutopilotExtensionOptions = {}): void {
  const operatorMessage = operatorMessageSink(pi);
  const statusEntry = async (status: string) => pi.appendEntry(AUTOPILOT_STATUS_CUSTOM_TYPE, buildAutopilotStatusEntryData(status));
  const taskBindings = new Map<string, TaskBinding>();
  // This append-only map is the sole cancellation jurisdiction source. A
  // terminal removes its pending completion binding, never its launch fact.
  const ownedTaskBindings = new Map<string, TaskBinding>();
  const unmatchedTerminalTasks = new Map<string, BgTaskSnapshot>();
  /**
   * Every task id Autopilot itself launched, append-only for the session. This
   * is the jurisdiction test: it is a record of Autopilot's OWN actions, not an
   * inference about foreign ones.
   */
  const launchedTaskIds = new Set<string>();
  const droppedForeignTerminals: string[] = [];
  const brokerConnectionDiagnostics = new Map<string, number>();
  const actionLaunchDedupe = new SessionActionLaunchDedupe();
  let currentCtx: ExtensionContext | undefined;
  let unsubscribeTerminal: (() => void) | undefined;
  let broker: ChildControlBroker | undefined;
  const launchGate = new SessionLaunchGate();

  const activationDeps: ActivationDeps = activationDepsFrom(options);

  // Subscription is established INSIDE activation and BEFORE any command frame
  // can be sent, so no Autopilot-owned launch can precede its own subscription.
  const activation = new AutopilotActivation(pi, activationDeps, async (services) => {
    const startBroker = options.startChildControlBroker ?? startChildControlBroker;
    const started = await startBroker({
      transport: services.transport,
      applyBlockedGate: async (gate) => applyBlockedGate(gate, services.backgroundTasks),
      onConnectionFailure: noteBrokerConnectionFailure,
    });
    try {
      // Broker facts are bound before any command can start Core. Core reuses
      // this one activation-owned broker across its own child-process restarts.
      if (services.transport instanceof CoreTransport) services.transport.bindChildControlBroker(started.launchFacts);
      unsubscribeTerminal = services.backgroundTasks.onTerminal(handleTerminal);
      await options.onActivated?.();
      broker = started;
    } catch (error) {
      unsubscribeTerminal?.();
      unsubscribeTerminal = undefined;
      const cleanupFailure = await stopFailure(started);
      if (cleanupFailure !== undefined) throw combinedLifecycleFailure("Autopilot activation broker cleanup failed", error, cleanupFailure);
      throw error;
    }
  });

  function noteBrokerConnectionFailure(diagnostic: ChildControlBrokerDiagnostic): void {
    if (!brokerConnectionDiagnostics.has(diagnostic.code) && brokerConnectionDiagnostics.size >= 8) return;
    brokerConnectionDiagnostics.set(diagnostic.code, Math.min(100, diagnostic.count));
  }

  function commandOptions(services: ActivationServices): RegisterCommandOptions {
    return {
      transport: services.transport,
      backgroundTasks: services.backgroundTasks,
      operatorMessage,
      statusEntry,
      onSpawn: rememberSpawn,
      launchGate,
      actionLaunchDedupe,
    };
  }

  async function rememberSpawn({ action, task }: { readonly action: BackgroundAction; readonly task: BgTaskSnapshot }): Promise<void> {
    const binding = bindTaskToAction(task, action);
    taskBindings.set(task.id, binding);
    ownedTaskBindings.set(task.id, binding);
    launchedTaskIds.add(task.id);
    const buffered = unmatchedTerminalTasks.get(task.id);
    if (buffered === undefined) return;
    unmatchedTerminalTasks.delete(task.id);
    await handleTerminal(buffered);
  }

  async function applyBlockedGate(
    gate: ChildControlBlockedGate,
    backgroundTasks: PiBackgroundTaskClient,
  ): Promise<BlockedGateApplication> {
    // The durable Core latch was committed before this typed directive. Close
    // the local process gate before looking at any task or issuing any kill.
    launchGate.close();
    const nonReporterTaskIds: string[] = [];
    let reporterTaskId: string | undefined;
    let reporterCount = 0;
    const seen = new Set<string>();
    for (const cancellation of gate.cancellations) {
      if (seen.has(cancellation.task_id)) throw new Error(`blocked gate repeats task id ${cancellation.task_id}`);
      seen.add(cancellation.task_id);
      if (!ownedTaskBindings.has(cancellation.task_id)) {
        throw new Error(`blocked gate named task outside Host Autopilot jurisdiction: ${cancellation.task_id}`);
      }
      if (cancellation.reporter) {
        reporterCount += 1;
        reporterTaskId = cancellation.task_id;
      } else nonReporterTaskIds.push(cancellation.task_id);
    }
    if (reporterCount !== 1) throw new Error("blocked gate must identify exactly one reporter task");

    if (reporterTaskId === undefined) throw new Error("blocked gate reporter task is absent");
    const exactReporterTaskId = reporterTaskId;
    return {
      reporterTaskId: exactReporterTaskId,
      async afterChildResponseWritten(): Promise<void> {
        // No status/enumeration/inference: only the exact Core-derived ids are
        // sent through the existing correlated kill operation.
        await backgroundTasks.killMany(nonReporterTaskIds);
      },
      async afterBlockedResultAcknowledged(): Promise<void> {
        // The broker has authenticated receipt/latch/reporter correlation. The
        // Host still rechecks its append-only own-launch record before naming
        // the reporter to EventBus; no foreign task can be canceled here.
        if (!ownedTaskBindings.has(exactReporterTaskId)) {
          throw new Error(`blocked reporter task left Host Autopilot jurisdiction: ${exactReporterTaskId}`);
        }
        await backgroundTasks.killMany([exactReporterTaskId]);
      },
    };
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
    try {
      validateTaskActionCorrelation(task, binding.action);
      const ctx = currentCtx;
      if (ctx === undefined) throw new Error(`Autopilot received terminal background task ${correlationLabel(binding)} before Pi supplied a session context; terminal correlation was not forwarded.`);
      // A terminal event can only reach this point via a subscription created
      // inside activation, so the services are necessarily present. The
      // accessor still throws rather than assuming, keeping inertness structural.
      const services = activation.requireServices();
      const frame = await services.transport.request("task-completed", {
        task_id: task.id,
        action_id: binding.action.action_id,
        assignment_id: binding.action.assignment_id,
        status: task.status,
      });
      await applyAndRecord(frame, ctx, commandOptions(services));
    } catch (error) {
      const detail = boundedError(error);
      await statusEntry(`rejection:host-terminal:${detail}`).catch(async (statusError) => {
        await operatorMessage(`Status publication failed: ${boundedError(statusError)}; terminal: ${detail}`, "error");
        throw error;
      });
      await operatorMessage(`Autopilot terminal handling failed for ${correlationLabel(binding)}: ${detail}`, "error");
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
        // Stop accepting/fail broker calls before tearing down the EventBus or
        // Core transport. This is idempotent for repeated session shutdown.
        await stopChildControlBroker(broker);
        broker = undefined;
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

function correlationLabel(binding: TaskBinding): string { return `task=${binding.task_id} action=${binding.action.action_id} assignment=${binding.action.assignment_id}`; }

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

async function stopFailure(broker: ChildControlBroker): Promise<unknown | undefined> {
  try {
    await stopChildControlBroker(broker);
    return undefined;
  } catch (error) {
    return error;
  }
}

function combinedLifecycleFailure(prefix: string, primary: unknown, cleanup: unknown): Error {
  return new Error(`${prefix}: ${boundedError(primary)}; cleanup: ${boundedError(cleanup)}`);
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}
