import type { CoreToHostFrame } from "./generated/index.ts";
import { applyCoreEffect, type HostEffectContext } from "./effects.ts";
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
  handler(args: string, ctx: HostEffectContext): Promise<void>;
}

export interface CommandHostLike {
  registerCommand(name: string, definition: CommandDefinitionLike): void;
}

export interface CommandTransportLike {
  request(kind: "command", payload: { raw: string }): Promise<CoreToHostFrame>;
}

export interface RegisterCommandOptions {
  readonly transport: CommandTransportLike | CoreTransport;
}

export function registerAutopilotCommands(pi: CommandHostLike, options: RegisterCommandOptions): void {
  for (const name of AUTOPILOT_COMMANDS) {
    pi.registerCommand(name, {
      description: `Forward /${name} to autopilot-core.`,
      handler: async (args, ctx) => forwardCommand(args, ctx, options.transport),
    });
  }
}

async function forwardCommand(raw: string, ctx: HostEffectContext, transport: CommandTransportLike | CoreTransport): Promise<void> {
  const frame = await transport.request("command", { raw });
  await applyCoreEffect(frame, ctx);
}
