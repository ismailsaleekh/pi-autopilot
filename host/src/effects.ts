import type { CoreToHostFrame } from "./generated/index.ts";

export class UnknownCoreEffectError extends Error {
  constructor(kind: string) {
    super(`autopilot-core returned unknown effect kind: ${kind}`);
    this.name = "UnknownCoreEffectError";
  }
}

export interface HostEffectContext {
  readonly ui?: Record<string, unknown>;
  readonly bg_run?: (descriptor: unknown) => unknown | Promise<unknown>;
  readonly session?: Record<string, unknown>;
  readonly log?: (line: string) => unknown | Promise<unknown>;
  readonly done?: (status: string) => unknown | Promise<unknown>;
  readonly guardDecision?: (payload: unknown) => unknown | Promise<unknown>;
}

export async function applyCoreEffect(frame: CoreToHostFrame, ctx: HostEffectContext): Promise<void> {
  switch (frame.kind) {
    case "guard-decision":
      await optionalCall(ctx.guardDecision, frame.payload);
      return;
    case "ui":
      await callMember(ctx.ui, frame.payload.ui_kind, frame.payload.content, "ctx.ui");
      return;
    case "spawn":
      await requiredCall(ctx.bg_run, frame.payload.action, "ctx.bg_run");
      return;
    case "session":
      await callMember(ctx.session, frame.payload.session_action, frame.payload.payload, "ctx.session");
      return;
    case "log":
      await optionalCall(ctx.log, frame.payload.line);
      return;
    case "done":
      await optionalCall(ctx.done, frame.payload.status);
      return;
    default:
      throw new UnknownCoreEffectError(String((frame as { readonly kind: string }).kind));
  }
}

async function callMember(target: Record<string, unknown> | undefined, name: string, payload: unknown, label: string): Promise<void> {
  const member = target?.[name];
  await requiredCall(member, payload, `${label}.${name}`);
}

async function requiredCall(member: unknown, payload: unknown, label: string): Promise<void> {
  if (typeof member !== "function") {
    throw new Error(`autopilot host effect target unavailable: ${label}`);
  }
  await member(payload);
}

async function optionalCall(member: unknown, payload: unknown): Promise<void> {
  if (typeof member === "function") {
    await member(payload);
  }
}
