import { registerAutopilotCommands, type CommandHostLike } from "./commands.ts";
import { applyCoreEffect, type HostEffectContext } from "./effects.ts";
import { guardToolCall, type GuardResult } from "./guard.ts";
import { CoreTransport } from "./transport.ts";

export interface ExtensionEventRegistrar {
  (eventName: "tool_call", handler: (event: ToolCallEventLike, ctx: HostEffectContext) => Promise<ToolCallGuardReturn>): void;
  (eventName: "session_shutdown", handler: (event: Record<string, unknown>, ctx: HostEffectContext) => Promise<void>): void;
}

export interface ExtensionHostLike extends CommandHostLike {
  readonly on?: ExtensionEventRegistrar;
}

export interface ToolCallEventLike {
  readonly toolName?: string;
  readonly input?: Record<string, unknown>;
}

export type ToolCallGuardReturn = { readonly block: true; readonly reason: string } | undefined;

export interface AutopilotExtensionOptions {
  readonly transport?: CoreTransport;
}

export default function autopilotExtension(pi: ExtensionHostLike, options: AutopilotExtensionOptions = {}): void {
  const transport = options.transport ?? new CoreTransport();
  registerAutopilotCommands(pi, { transport });
  pi.on?.("tool_call", async (event) => guardReturn(await guardToolCall({
    tool_name: String(event.toolName ?? ""),
    arguments: event.input ?? {},
  }, { transport })));
  pi.on?.("session_shutdown", async (event, ctx) => {
    try {
      const frame = await transport.request("shutdown", { reason: shutdownReason(event) }, 2000);
      await applyCoreEffect(frame, ctx);
    } finally {
      transport.close();
    }
  });
}

function guardReturn(result: GuardResult): ToolCallGuardReturn {
  return result.decision === "allow" ? undefined : { block: true, reason: result.reason };
}

function shutdownReason(event: Record<string, unknown>): string | null {
  return typeof event["reason"] === "string" ? event["reason"] : null;
}
