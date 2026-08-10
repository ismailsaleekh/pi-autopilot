import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { BackgroundAction, CoreToHostFrame, CoreToHostUiPayload } from "./generated/index.ts";
import { validateCoreToHostFrame } from "./generated/frame-validation.ts";
import { HOST_EFFECTS } from "./generated/host-runtime-tables.ts";
import type { BgTaskSnapshot, PiBackgroundTaskClient } from "./background-tasks.ts";
import { boundedDiagnostic } from "./host-runtime.ts";

export class UnknownCoreEffectError extends Error { constructor(kind: string) { super(`autopilot-core returned unknown effect kind: ${kind}`); this.name = "UnknownCoreEffectError"; } }
export type OperatorMessageLevel = "info" | "warning" | "error";
export type OperatorMessageSink = (message: string, level: OperatorMessageLevel) => unknown | Promise<unknown>;
export type StatusEntrySink = (status: string) => unknown | Promise<unknown>;
export type HostEffectContext = Pick<ExtensionContext, "ui" | "hasUI" | "mode">;
export interface BackgroundLaunchGate {
  assertOpen(): void;
  /** Optional scheduling-only entry that remains held through durable ownership. */
  enterLaunch?(): () => void;
}
export interface BackgroundActionLaunchDedupe {
  launch(action: BackgroundAction, run: () => Promise<BgTaskSnapshot>): Promise<{ readonly task: BgTaskSnapshot; readonly firstLaunch: boolean }>;
}
export interface HostEffectServices { readonly backgroundTasks: Pick<PiBackgroundTaskClient, "run">; readonly launchGate?: BackgroundLaunchGate; readonly actionLaunchDedupe?: BackgroundActionLaunchDedupe; readonly onSpawn?: (binding: { readonly action: BackgroundAction; readonly task: BgTaskSnapshot }) => void | Promise<void>; readonly operatorMessage: OperatorMessageSink; readonly statusEntry: StatusEntrySink; }
export interface LaunchedBackgroundTask { readonly action: BackgroundAction; readonly task: BgTaskSnapshot; readonly firstLaunch: boolean; }
export interface BackgroundLaunchFailure { readonly action: BackgroundAction; readonly diagnostic: string; }
export type CoreEffectResult = { readonly kind: "spawn"; readonly acknowledge: boolean; readonly launched: readonly LaunchedBackgroundTask[]; readonly failures: readonly BackgroundLaunchFailure[] } | undefined;

type HostEffectKind = (typeof HOST_EFFECTS)[number]["kind"];
const EFFECTS = new Map(HOST_EFFECTS.map((row) => [row.kind, row]));

export async function applyCoreEffect(frame: CoreToHostFrame, ctx: HostEffectContext, services: HostEffectServices): Promise<CoreEffectResult> {
  const validFrame = validateCoreToHostFrame(frame);
  const effect = effectFor(validFrame.kind);
  switch (validFrame.kind) {
    case "ui": await applyUiEffect(validFrame.payload, effect.operator_level_default, ctx, services); return undefined;
    case "spawn": {
      const launched = await launchBackground(validFrame.payload.action, services);
      return { kind: "spawn", acknowledge: effect.acknowledge, launched: [{ action: validFrame.payload.action, ...launched }], failures: [] };
    }
    case "spawn-wave": return launchWave(validFrame.payload.actions, effect.acknowledge, services);
    case "session": await failClosed(ctx, services, `Autopilot requested unsupported Pi session effect ${validFrame.payload.session_action}. The installed Pi ExtensionCommandContext has only explicit session-control methods; Autopilot stopped instead of calling a fictional generic session API.`); return undefined;
    case "log": await emitOperatorMessage(ctx, services, `Autopilot log: ${validFrame.payload.line}`, effect.operator_level_default); return undefined;
    case "done": await services.statusEntry(validFrame.payload.status); await emitOperatorMessage(ctx, services, `Autopilot done: ${validFrame.payload.status}`, effect.operator_level_default); return undefined;
    default: throw new UnknownCoreEffectError(String((validFrame as { readonly kind: string }).kind));
  }
}

function effectFor(kind: string) {
  const effect = EFFECTS.get(kind as HostEffectKind);
  if (effect === undefined) throw new UnknownCoreEffectError(kind);
  return effect;
}

async function launchWave(actions: readonly BackgroundAction[], acknowledge: boolean, services: HostEffectServices): Promise<CoreEffectResult> {
  const settled = await Promise.allSettled(actions.map((action) => Promise.resolve().then(() => launchBackground(action, services))));
  const launched: LaunchedBackgroundTask[] = [];
  const failures: BackgroundLaunchFailure[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const action = actions[index];
    const outcome = settled[index];
    if (action === undefined || outcome === undefined) throw new Error(`spawn-wave internal index drift at ${index}`);
    if (outcome.status === "fulfilled") launched.push({ action, ...outcome.value });
    else failures.push({ action, diagnostic: boundedDiagnostic(outcome.reason) });
  }
  return { kind: "spawn", acknowledge, launched, failures };
}

function launchBackground(action: BackgroundAction, services: HostEffectServices): Promise<{ readonly task: BgTaskSnapshot; readonly firstLaunch: boolean }> {
  const run = async (): Promise<BgTaskSnapshot> => {
    // The launch coordinator entry and the one permitted run() invocation are
    // adjacent. Its completion is deliberately delayed through onSpawn's
    // journal fsync, so a BLOCKED snapshot drains returned runs completely.
    const complete = services.launchGate?.enterLaunch?.();
    if (complete === undefined) services.launchGate?.assertOpen();
    try {
      const task = await services.backgroundTasks.run(action.bg_run);
      await services.onSpawn?.({ action, task });
      return task;
    } finally {
      complete?.();
    }
  };
  if (services.actionLaunchDedupe !== undefined) return services.actionLaunchDedupe.launch(action, run);
  return run().then((task) => ({ task, firstLaunch: true }));
}

async function applyUiEffect(payload: CoreToHostUiPayload, level: OperatorMessageLevel, ctx: HostEffectContext, services: HostEffectServices): Promise<void> {
  if (payload.ui_kind === "notify") { await emitOperatorMessage(ctx, services, contentMessage(payload.content), level); return; }
  if (payload.ui_kind === "text") { await emitOperatorMessage(ctx, services, `Autopilot: ${contentMessage(payload.content)}`, level); return; }
  await failClosed(ctx, services, `Autopilot requested unsupported Pi UI effect ${payload.ui_kind}. Supported Host routes are ctx.ui.notify and pi.sendMessage; Autopilot stopped instead of calling a fictional ctx.ui.${payload.ui_kind}.`);
}

async function failClosed(ctx: HostEffectContext, services: HostEffectServices, message: string): Promise<never> { await emitOperatorMessage(ctx, services, message, "error"); throw new Error(message); }
async function emitOperatorMessage(ctx: HostEffectContext, services: HostEffectServices, message: string, level: OperatorMessageLevel): Promise<void> { if (ctx.hasUI) ctx.ui.notify(message, level); await services.operatorMessage(message, level); }

function contentMessage(content: Record<string, unknown>): string {
  for (const key of ["message", "text", "status", "detail"] as const) { const value = content[key]; if (typeof value === "string" && value.length > 0) return value; }
  return JSON.stringify(content);
}

