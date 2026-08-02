import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { BackgroundAction, CoreToHostFrame, HostToCoreCommandPayload, HostToCoreOperatorAnswerPayload, HostToCoreSpawnResultPayload } from "./generated/index.ts";
import { ACTIVATING_COMMANDS, HOST_COMMANDS } from "./generated/host-runtime-tables.ts";
import { boundedDiagnostic, unavailableCapabilities, type BgTaskSnapshot, type PiBackgroundTaskClient } from "./background-tasks.ts";
import { applyCoreEffect, type CoreEffectResult, type HostEffectContext, type HostEffectServices, type OperatorMessageSink } from "./effects.ts";
import { parseCommandAdapterPayload } from "./host-runtime.ts";
import type { CoreTransport } from "./transport.ts";

export const AUTOPILOT_COMMANDS = Object.freeze(HOST_COMMANDS.filter((row) => row.frame === "command").map((row) => row.name));
const OPERATOR_ANSWER_DESCRIPTOR = operatorAnswerDescriptor();
export const AUTOPILOT_OPERATOR_ANSWER_COMMAND = OPERATOR_ANSWER_DESCRIPTOR.name;

export interface CommandDefinitionLike { readonly description: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void>; }
export interface CommandHostLike { registerCommand(name: string, definition: CommandDefinitionLike): void; }
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
export interface CommandServiceResolver {
  activate(command: string): Promise<RegisterCommandOptions>;
  requireActive(command: string): RegisterCommandOptions;
}

export function registerAutopilotCommands(pi: CommandHostLike, resolver: CommandServiceResolver): void {
  for (const row of HOST_COMMANDS) {
    const acquire = serviceAcquirer(resolver, row.name);
    pi.registerCommand(row.name, row.frame === "operator-answer" ? {
      description: row.description,
      handler: async (args, ctx) => forwardOperatorAnswer(args, ctx, await acquire()),
    } : {
      description: row.description,
      handler: async (args, ctx) => forwardCommand(row.name, args, ctx, await acquire()),
    });
  }
}

function operatorAnswerDescriptor(): (typeof HOST_COMMANDS)[number] {
  const descriptor = HOST_COMMANDS.find((row) => row.frame === "operator-answer");
  if (descriptor === undefined) throw new Error("operator-answer command descriptor missing");
  return descriptor;
}

function serviceAcquirer(resolver: CommandServiceResolver, name: string): () => Promise<RegisterCommandOptions> {
  return (ACTIVATING_COMMANDS as readonly string[]).includes(name) ? async () => resolver.activate(name) : async () => resolver.requireActive(name);
}

export function fixedServiceResolver(options: RegisterCommandOptions): CommandServiceResolver {
  return { async activate() { return options; }, requireActive() { return options; } };
}

async function forwardOperatorAnswer(args: string, ctx: ExtensionCommandContext, options: RegisterCommandOptions): Promise<void> {
  const parsed = parseCommandAdapterPayload(OPERATOR_ANSWER_DESCRIPTOR, args);
  const questionId = parsed.question_id;
  const answer = parsed.answer;
  if (typeof questionId !== "string") throw new Error("operator-answer question_id must be a string");
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw new Error("operator-answer answer must be a JSON object");
  const payload: HostToCoreOperatorAnswerPayload = { question_id: questionId, answer: answer as Record<string, unknown> };
  await applyAndRecord(await options.transport.request("operator-answer", payload), ctx, options);
}

async function forwardCommand(name: string, args: string, ctx: ExtensionCommandContext, options: RegisterCommandOptions): Promise<void> {
  await applyAndRecord(await options.transport.request("command", await commandPayload(name, args, options.backgroundTasks)), ctx, options);
}

export async function applyAndRecord(frame: CoreToHostFrame, ctx: HostEffectContext, options: Pick<RegisterCommandOptions, "transport" | "backgroundTasks" | "operatorMessage" | "onSpawn">): Promise<CoreEffectResult> {
  const services = { backgroundTasks: options.backgroundTasks, operatorMessage: options.operatorMessage } satisfies HostEffectServices;
  const result = await applyCoreEffect(frame, ctx, services);
  if (result?.kind !== "spawn") return result;
  if (!result.acknowledge) {
    for (const launched of result.launched) await options.onSpawn?.({ action: launched.action, task: launched.task });
    return result;
  }
  for (const launched of result.launched) {
    const ack = await options.transport.request("spawn-result", { action_id: launched.action.action_id, assignment_id: launched.action.assignment_id, status: "launched", task_id: launched.task.id });
    await applyCoreEffect(ack, ctx, services);
    await options.onSpawn?.({ action: launched.action, task: launched.task });
  }
  for (const failure of result.failures) {
    const ack = await options.transport.request("spawn-result", { action_id: failure.action.action_id, assignment_id: failure.action.assignment_id, status: "launch-failed", diagnostic: failure.diagnostic });
    await applyCoreEffect(ack, ctx, services);
  }
  if (result.failures.length > 0) throw new Error(`spawn-wave launch failures: ${result.failures.map((failure) => `${failure.action.assignment_id}:${failure.diagnostic}`).join("; ")}`);
  return result;
}

async function commandPayload(name: string, args: string, backgroundTasks: Pick<PiBackgroundTaskClient, "capabilities">): Promise<HostToCoreCommandPayload> {
  try { return { raw: frameRawCommand(name, args), background_capabilities: await backgroundTasks.capabilities() }; }
  catch (error) { return { raw: frameRawCommand(name, args), background_capabilities: unavailableCapabilities(), background_capability_diagnostic: boundedDiagnostic(error) }; }
}

function frameRawCommand(name: string, args: string): string { return `${name}${args.length > 0 && !/^\s/u.test(args) ? " " : ""}${args}`; }
