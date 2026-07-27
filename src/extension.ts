import { registerAutopilotCommands, type CommandHostLike } from "./commands.ts";
import { applyCoreEffect, type HostEffectContext } from "./effects.ts";
import { guardToolCall, type GuardResult } from "./guard.ts";
import { corePlatformKey, CoreInstallError, resolveCoreBinary, type ResolveCoreOptions } from "./resolve-core.ts";
import { CoreTransport } from "./transport.ts";

export interface ExtensionEventRegistrar {
  (eventName: "tool_call", handler: (event: ToolCallEventLike, ctx: HostEffectContext) => Promise<ToolCallGuardReturn>): void;
  (eventName: "session_shutdown", handler: (event: Record<string, unknown>, ctx: HostEffectContext) => Promise<void>): void;
}

export interface ExtensionHostLike extends CommandHostLike {
  readonly on?: ExtensionEventRegistrar;
  readonly sendMessage?: (message: string, options?: unknown) => unknown;
  readonly ui?: { readonly notify?: (message: string, level?: string) => unknown } | { readonly notify?: (level: string, message: string) => unknown };
}

export interface ToolCallEventLike {
  readonly toolName?: string;
  readonly input?: Record<string, unknown>;
}

export type ToolCallGuardReturn = { readonly block: true; readonly reason: string } | undefined;

export interface AutopilotExtensionOptions extends ResolveCoreOptions {
  readonly transport?: CoreTransport;
}

const unavailableNotifications = new Set<string>();

export default function autopilotExtension(pi: ExtensionHostLike, options: AutopilotExtensionOptions = {}): void {
  notifyCoreUnavailabilityOnce(pi, options);
  const transport = options.transport ?? new CoreTransport({ packageJsonPath: options.packageJsonPath });
  registerAutopilotCommands(pi, { transport });
  pi.on?.("tool_call", async (event) => guardReturn(await guardToolCall({
    tool_name: String(event.toolName ?? ""),
    arguments: event.input ?? {},
  }, { transport, packageJsonPath: options.packageJsonPath })));
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

function notifyCoreUnavailabilityOnce(pi: ExtensionHostLike, options: ResolveCoreOptions): void {
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

function notify(pi: ExtensionHostLike, message: string): void {
  if (typeof pi.sendMessage === "function") {
    pi.sendMessage(message, { level: "error" });
    return;
  }
  const notifyFn = pi.ui?.notify;
  if (typeof notifyFn === "function") {
    notifyFn(message, "error");
  }
}

function shutdownReason(event: Record<string, unknown>): string | null {
  return typeof event["reason"] === "string" ? event["reason"] : null;
}
