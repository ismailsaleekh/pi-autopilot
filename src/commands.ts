import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { BackgroundAction, CoreToHostFrame, HostToCoreCommandPayload, HostToCoreOperatorAnswerPayload, HostToCoreSpawnResultPayload } from "./generated/index.ts";
import { applyCoreEffect, type CoreEffectResult, type HostEffectContext, type HostEffectServices, type OperatorMessageSink } from "./effects.ts";
import type { BgTaskSnapshot, PiBackgroundTaskClient } from "./background-tasks.ts";
import { boundedDiagnostic, unavailableCapabilities } from "./background-tasks.ts";
import type { CoreTransport } from "./transport.ts";

export const AUTOPILOT_COMMANDS = Object.freeze([
  "autopilot-plan",
  "autopilot",
  "autopilot-onboard",
  "autopilot-inject",
  "autopilot-status",
  "autopilot-config",
  "autopilot-handoff",
  "autopilot-close",
  "autopilot-abort",
] as const);

export const AUTOPILOT_OPERATOR_ANSWER_COMMAND = "autopilot-answer" as const;

export interface CommandDefinitionLike {
  readonly description: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

export interface CommandHostLike {
  registerCommand(name: string, definition: CommandDefinitionLike): void;
}

export interface CommandTransportLike {
  request(kind: "command", payload: HostToCoreCommandPayload): Promise<CoreToHostFrame>;
  request(kind: "operator-answer", payload: HostToCoreOperatorAnswerPayload): Promise<CoreToHostFrame>;
  request(kind: "spawn-result", payload: HostToCoreSpawnResultPayload): Promise<CoreToHostFrame>;
}

export interface RegisterCommandOptions {
  readonly transport: CommandTransportLike | CoreTransport;
  readonly backgroundTasks: Pick<PiBackgroundTaskClient, "capabilities" | "run">;
  readonly operatorMessage: OperatorMessageSink;
  readonly onSpawn?: (binding: { readonly action: BackgroundAction; readonly task: BgTaskSnapshot }) => void | Promise<void>;
}

export function registerAutopilotCommands(pi: CommandHostLike, options: RegisterCommandOptions): void {
  for (const name of AUTOPILOT_COMMANDS) {
    pi.registerCommand(name, {
      description: `Forward /${name} to autopilot-core.`,
      handler: async (args, ctx) => forwardCommand(name, args, ctx, options),
    });
  }
  pi.registerCommand(AUTOPILOT_OPERATOR_ANSWER_COMMAND, {
    description: "Send a D72 operator-answer frame to autopilot-core: /autopilot-answer <question-id> <json-object>.",
    handler: async (args, ctx) => forwardOperatorAnswer(args, ctx, options),
  });
}

async function forwardOperatorAnswer(args: string, ctx: ExtensionCommandContext, options: RegisterCommandOptions): Promise<void> {
  const frame = await options.transport.request("operator-answer", operatorAnswerPayload(args));
  await applyAndRecord(frame, ctx, options);
}

async function forwardCommand(name: string, args: string, ctx: ExtensionCommandContext, options: RegisterCommandOptions): Promise<void> {
  const payload = await commandPayload(name, args, options.backgroundTasks);
  const frame = await options.transport.request("command", payload);
  await applyAndRecord(frame, ctx, options);
}

export async function applyAndRecord(frame: CoreToHostFrame, ctx: HostEffectContext, options: Pick<RegisterCommandOptions, "transport" | "backgroundTasks" | "operatorMessage" | "onSpawn">): Promise<CoreEffectResult> {
  const result = await applyCoreEffect(frame, ctx, { backgroundTasks: options.backgroundTasks, operatorMessage: options.operatorMessage } satisfies HostEffectServices);
  if (result?.kind !== "spawn") return result;
  if (!result.acknowledge) {
    for (const launched of result.launched) {
      await options.onSpawn?.({ action: launched.action, task: launched.task });
    }
    return result;
  }
  for (const launched of result.launched) {
    const ack = await options.transport.request("spawn-result", {
      action_id: launched.action.action_id,
      assignment_id: launched.action.assignment_id,
      status: "launched",
      task_id: launched.task.id,
    });
    await applyCoreEffect(ack, ctx, { backgroundTasks: options.backgroundTasks, operatorMessage: options.operatorMessage } satisfies HostEffectServices);
    await options.onSpawn?.({ action: launched.action, task: launched.task });
  }
  for (const failure of result.failures) {
    const ack = await options.transport.request("spawn-result", {
      action_id: failure.action.action_id,
      assignment_id: failure.action.assignment_id,
      status: "launch-failed",
      diagnostic: failure.diagnostic,
    });
    await applyCoreEffect(ack, ctx, { backgroundTasks: options.backgroundTasks, operatorMessage: options.operatorMessage } satisfies HostEffectServices);
  }
  if (result.failures.length > 0) {
    throw new Error(`spawn-wave launch failures: ${result.failures.map((failure) => `${failure.action.assignment_id}:${failure.diagnostic}`).join("; ")}`);
  }
  return result;
}

async function commandPayload(name: string, args: string, backgroundTasks: Pick<PiBackgroundTaskClient, "capabilities">): Promise<HostToCoreCommandPayload> {
  try {
    return {
      raw: frameRawCommand(name, args),
      background_capabilities: await backgroundTasks.capabilities(),
    };
  } catch (error) {
    return {
      raw: frameRawCommand(name, args),
      background_capabilities: unavailableCapabilities(),
      background_capability_diagnostic: boundedDiagnostic(error),
    };
  }
}

function operatorAnswerPayload(args: string): HostToCoreOperatorAnswerPayload {
  const trimmed = args.trim();
  const separator = trimmed.search(/\s/u);
  if (separator <= 0) {
    throw new Error("/autopilot-answer requires <question-id> followed by a JSON object answer");
  }
  const questionId = trimmed.slice(0, separator);
  const answerText = trimmed.slice(separator).trim();
  if (!validId(questionId)) throw new Error(`/autopilot-answer question-id is invalid: ${questionId}`);
  let answer: unknown;
  try {
    answer = JSON.parse(answerText);
  } catch (error) {
    throw new Error(`/autopilot-answer answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new Error("/autopilot-answer answer must be a JSON object");
  }
  return { question_id: questionId, answer: answer as Record<string, unknown> };
}

function validId(value: string): boolean {
  return value.length > 0 && !/[\\/\0]/u.test(value);
}

function frameRawCommand(name: string, args: string): string {
  const separator = args.length > 0 && !/^\s/u.test(args) ? " " : "";
  return `${name}${separator}${args}`;
}
