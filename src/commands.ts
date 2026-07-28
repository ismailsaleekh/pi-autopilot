import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { BackgroundAction, CoreToHostFrame, HostToCoreCommandPayload } from "./generated/index.ts";
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

export interface CommandDefinitionLike {
  readonly description: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

export interface CommandHostLike {
  registerCommand(name: string, definition: CommandDefinitionLike): void;
}

export interface CommandTransportLike {
  request(kind: "command", payload: HostToCoreCommandPayload): Promise<CoreToHostFrame>;
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
}

async function forwardCommand(name: string, args: string, ctx: ExtensionCommandContext, options: RegisterCommandOptions): Promise<void> {
  const payload = await commandPayload(name, args, options.backgroundTasks);
  const frame = await options.transport.request("command", payload);
  await applyAndRecord(frame, ctx, options);
}

export async function applyAndRecord(frame: CoreToHostFrame, ctx: HostEffectContext, options: Pick<RegisterCommandOptions, "backgroundTasks" | "operatorMessage" | "onSpawn">): Promise<CoreEffectResult> {
  const result = await applyCoreEffect(frame, ctx, { backgroundTasks: options.backgroundTasks, operatorMessage: options.operatorMessage } satisfies HostEffectServices);
  if (result?.kind === "spawn") await options.onSpawn?.({ action: result.action, task: result.task });
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

function frameRawCommand(name: string, args: string): string {
  const separator = args.length > 0 && !/^\s/u.test(args) ? " " : "";
  return `${name}${separator}${args}`;
}
