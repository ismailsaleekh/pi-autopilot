import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CoreToHostFrame, BackgroundAction, CoreToHostUiPayload } from "./generated/index.ts";
import type { BgTaskSnapshot, PiBackgroundTaskClient } from "./background-tasks.ts";
import { validateCoreToHostFrame } from "./frame-validation.ts";

export class UnknownCoreEffectError extends Error {
  constructor(kind: string) {
    super(`autopilot-core returned unknown effect kind: ${kind}`);
    this.name = "UnknownCoreEffectError";
  }
}

export type OperatorMessageLevel = "info" | "warning" | "error";
export type OperatorMessageSink = (message: string, level: OperatorMessageLevel) => unknown | Promise<unknown>;

export type HostEffectContext = Pick<ExtensionContext, "ui" | "hasUI" | "mode">;

export interface HostEffectServices {
  readonly backgroundTasks: Pick<PiBackgroundTaskClient, "run">;
  readonly operatorMessage: OperatorMessageSink;
}

export type CoreEffectResult = { readonly kind: "spawn"; readonly action: BackgroundAction; readonly task: BgTaskSnapshot } | undefined;

export async function applyCoreEffect(frame: CoreToHostFrame, ctx: HostEffectContext, services: HostEffectServices): Promise<CoreEffectResult> {
  const validFrame = validateCoreToHostFrame(frame);
  switch (validFrame.kind) {
    case "guard-decision":
      await emitOperatorMessage(
        ctx,
        services,
        `Autopilot guard decision: ${validFrame.payload.decision} (${validFrame.payload.reason})`,
        validFrame.payload.decision === "allow" ? "info" : "warning",
      );
      return undefined;
    case "ui":
      await applyUiEffect(validFrame.payload, ctx, services);
      return undefined;
    case "spawn": {
      const task = await services.backgroundTasks.run(validFrame.payload.action.bg_run);
      return { kind: "spawn", action: validFrame.payload.action, task };
    }
    case "session":
      await failClosed(
        ctx,
        services,
        `Autopilot requested unsupported Pi session effect ${validFrame.payload.session_action}. The installed Pi ExtensionCommandContext has only explicit session-control methods; Autopilot stopped instead of calling a fictional generic session API.`,
      );
      return undefined;
    case "log":
      await emitOperatorMessage(ctx, services, `Autopilot log: ${validFrame.payload.line}`, "info");
      return undefined;
    case "done":
      await emitOperatorMessage(ctx, services, `Autopilot done: ${validFrame.payload.status}`, severityForStatus(validFrame.payload.status));
      return undefined;
    default:
      throw new UnknownCoreEffectError(String((validFrame as { readonly kind: string }).kind));
  }
}

async function applyUiEffect(payload: CoreToHostUiPayload, ctx: HostEffectContext, services: HostEffectServices): Promise<void> {
  if (payload.ui_kind === "notify") {
    await emitOperatorMessage(ctx, services, contentMessage(payload.content), contentLevel(payload.content));
    return;
  }
  if (payload.ui_kind === "text") {
    await emitOperatorMessage(ctx, services, `Autopilot: ${contentMessage(payload.content)}`, "info");
    return;
  }
  await failClosed(
    ctx,
    services,
    `Autopilot requested unsupported Pi UI effect ${payload.ui_kind}. Supported Host routes are ctx.ui.notify and pi.sendMessage; Autopilot stopped instead of calling a fictional ctx.ui.${payload.ui_kind}.`,
  );
}

async function failClosed(ctx: HostEffectContext, services: HostEffectServices, message: string): Promise<never> {
  await emitOperatorMessage(ctx, services, message, "error");
  throw new Error(message);
}

async function emitOperatorMessage(ctx: HostEffectContext, services: HostEffectServices, message: string, level: OperatorMessageLevel): Promise<void> {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
  await services.operatorMessage(message, level);
}

function contentMessage(content: Record<string, unknown>): string {
  for (const key of ["message", "text", "status", "detail"] as const) {
    const value = content[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return JSON.stringify(content);
}

function contentLevel(content: Record<string, unknown>): OperatorMessageLevel {
  const value = content["type"] ?? content["kind"] ?? content["level"];
  return value === "warning" || value === "error" || value === "info" ? value : "info";
}

function severityForStatus(status: string): OperatorMessageLevel {
  const lower = status.toLowerCase();
  if (lower.startsWith("rejection:") || lower.includes("context_gap") || lower.includes("paused") || lower.includes("supplycapability")) {
    return "warning";
  }
  if (lower.includes("error") || lower.includes("failed") || lower.includes("unsafe")) return "error";
  return "info";
}
