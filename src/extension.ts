import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PiBackgroundTaskClient, type BgTaskSnapshot } from "./background-tasks.ts";
import { registerAutopilotCommands, applyAndRecord } from "./commands.ts";
import type { OperatorMessageLevel, OperatorMessageSink } from "./effects.ts";
import { guardToolCall, type GuardResult } from "./guard.ts";
import { corePlatformKey, CoreInstallError, resolveCoreBinary, type ResolveCoreOptions } from "./resolve-core.ts";
import { CoreTransport } from "./transport.ts";
import type { BackgroundAction } from "./generated/index.ts";

export interface ToolCallEventLike {
  readonly toolName?: string;
  readonly input?: Record<string, unknown>;
}

export type ToolCallGuardReturn = { readonly block: true; readonly reason: string } | undefined;

export interface AutopilotExtensionOptions extends ResolveCoreOptions {
  readonly transport?: CoreTransport;
  readonly backgroundTasks?: PiBackgroundTaskClient;
}

const unavailableNotifications = new Set<string>();
const MAX_UNMATCHED_TERMINALS = 100;

interface TaskBinding {
  readonly task_id: string;
  readonly action: BackgroundAction;
}

export default function autopilotExtension(pi: ExtensionAPI, options: AutopilotExtensionOptions = {}): void {
  notifyCoreUnavailabilityOnce(pi, options);
  const transport = options.transport ?? new CoreTransport({ packageJsonPath: options.packageJsonPath });
  const backgroundTasks = options.backgroundTasks ?? new PiBackgroundTaskClient(pi.events);
  const operatorMessage = operatorMessageSink(pi);
  const taskBindings = new Map<string, TaskBinding>();
  const unmatchedTerminalTasks = new Map<string, BgTaskSnapshot>();
  let currentCtx: ExtensionContext | undefined;

  async function rememberSpawn({ action, task }: { readonly action: BackgroundAction; readonly task: BgTaskSnapshot }): Promise<void> {
    const binding = bindTaskToAction(task, action);
    taskBindings.set(task.id, binding);
    const buffered = unmatchedTerminalTasks.get(task.id);
    if (buffered === undefined) return;
    unmatchedTerminalTasks.delete(task.id);
    await handleTerminal(buffered);
  }

  async function handleTerminal(task: BgTaskSnapshot): Promise<void> {
    const binding = taskBindings.get(task.id);
    if (binding === undefined) {
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
      const frame = await transport.request("task-completed", {
        task_id: task.id,
        action_id: binding.action.action_id,
        assignment_id: binding.action.assignment_id,
        status: task.status,
      });
      await applyAndRecord(frame, ctx, { backgroundTasks, operatorMessage, onSpawn: rememberSpawn });
    } catch (error) {
      await operatorMessage(`Autopilot terminal handling failed for ${correlationLabel(binding)}: ${boundedError(error)}`, "error");
      throw error;
    }
  }

  async function reportUnmatchedTerminals(): Promise<void> {
    for (const task of unmatchedTerminalTasks.values()) {
      await operatorMessage(
        `Autopilot observed terminal background task ${task.id} but no exact Autopilot action binding was ever recorded; command=${boundedError(task.command)}`,
        "warning",
      );
    }
    unmatchedTerminalTasks.clear();
  }

  registerAutopilotCommands(pi, { transport, backgroundTasks, operatorMessage, onSpawn: rememberSpawn });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on("tool_call", async (event) => guardReturn(await guardToolCall({
    tool_name: String((event as ToolCallEventLike).toolName ?? ""),
    arguments: ((event as ToolCallEventLike).input ?? {}) as Record<string, unknown>,
  }, { transport, packageJsonPath: options.packageJsonPath })));

  const unsubscribeTerminal = backgroundTasks.onTerminal(handleTerminal);

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      const reason = shutdownReason(event);
      const payload = reason === undefined ? {} : { reason };
      const frame = await transport.request("shutdown", payload, 2000);
      await applyAndRecord(frame, ctx, { backgroundTasks, operatorMessage, onSpawn: rememberSpawn });
    } finally {
      try {
        await reportUnmatchedTerminals();
      } finally {
        unsubscribeTerminal();
        try {
          await backgroundTasks.close();
        } finally {
          transport.close();
        }
      }
    }
  });
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

function correlationLabel(binding: TaskBinding): string {
  return `task=${binding.task_id} action=${binding.action.action_id} assignment=${binding.action.assignment_id}`;
}

function guardReturn(result: GuardResult): ToolCallGuardReturn {
  return result.decision === "allow" ? undefined : { block: true, reason: result.reason };
}

function notifyCoreUnavailabilityOnce(pi: ExtensionAPI, options: ResolveCoreOptions): void {
  try {
    resolveCoreBinary(options);
  } catch (error) {
    if (!(error instanceof CoreInstallError)) return;
    if (error.code !== "missing-binary" && error.code !== "unsupported-platform") return;
    const platformKey = error.platformKey ?? corePlatformKey(options);
    const key = `${options.packageJsonPath ?? "default"}:${platformKey}`;
    if (unavailableNotifications.has(key)) return;
    unavailableNotifications.add(key);
    notify(pi, `Autopilot unavailable: core binary missing for ${platformKey}. Reinstall pi-autopilot.`);
  }
}

function notify(pi: ExtensionAPI, message: string): void {
  pi.sendMessage({ customType: "pi-autopilot", content: message, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
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
