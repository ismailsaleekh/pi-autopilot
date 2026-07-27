import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { GUARD_TIMEOUT_DEFAULT_MS } from "./generated/index.ts";
import type {
  CoreToHostGuardDecisionPayload,
  HostToCoreGuardQueryPayload,
} from "./generated/index.ts";
import { CoreTimeoutError, CoreTransport, CoreUnavailableError } from "./transport.ts";

export interface GuardOptions {
  transport?: CoreTransport | GuardTransportLike;
  binaryPath?: string;
  packageJsonPath?: string;
  timeoutMs?: number;
  contractsPath?: string;
  runStateRoot?: string;
}

export interface GuardTransportLike {
  request(kind: "guard-query", payload: HostToCoreGuardQueryPayload, timeoutMs?: number): Promise<{ readonly kind: string; readonly payload: unknown }>;
}

export interface GuardResult {
  decision: "allow" | "deny";
  reason: string;
}

export async function guardToolCall(
  query: HostToCoreGuardQueryPayload,
  options: GuardOptions = {},
): Promise<GuardResult> {
  if (!isAutopilotScope(query, options)) {
    return { decision: "allow", reason: "outside-autopilot-scope" };
  }

  let timeoutMs: number;
  try {
    timeoutMs = options.timeoutMs ?? guardTimeoutDefaultMs(options.contractsPath);
  } catch (error) {
    return deny(`contract-timeout-unavailable:${errorMessage(error)}`);
  }
  const transport = options.transport ?? new CoreTransport({ binaryPath: options.binaryPath, packageJsonPath: options.packageJsonPath });
  try {
    const frame = await transport.request("guard-query", query, timeoutMs);
    if (frame.kind !== "guard-decision") {
      return deny(`core-unexpected-frame:${frame.kind}`);
    }
    const payload = frame.payload as CoreToHostGuardDecisionPayload;
    return payload.decision === "allow"
      ? { decision: "allow", reason: payload.reason }
      : deny(payload.reason);
  } catch (error) {
    if (error instanceof CoreTimeoutError) {
      return deny(`core-timeout:${error.message}`);
    }
    if (error instanceof CoreUnavailableError) {
      return deny(`core-unavailable:${error.message}`);
    }
    return deny(`core-unavailable:${errorMessage(error)}`);
  }
}

const BG_TOOLS = new Set(["bg_run"]);

export function isAutopilotScope(
  query: HostToCoreGuardQueryPayload,
  ctx: Pick<GuardOptions, "runStateRoot" | "transport"> = {},
): boolean {
  if (query.tool_name.startsWith("autopilot_")) return true;
  if (BG_TOOLS.has(query.tool_name) && hasHostLocalActiveRun(ctx)) return true;
  return false;
}

export function hasHostLocalActiveRun(ctx: Pick<GuardOptions, "runStateRoot" | "transport"> = {}): boolean {
  if (ctx.transport instanceof CoreTransport && ctx.transport.hasLiveChild()) return true;
  return activeRunDirectoryExists(ctx.runStateRoot ?? defaultRunStateRoot());
}

export function guardTimeoutDefaultMs(contractsPath?: string): number {
  if (contractsPath === undefined) return GUARD_TIMEOUT_DEFAULT_MS;
  const source = readFileSync(contractsPath, "utf8");
  const match = source.match(/constant\s+"guard_timeout_default"\s+value="([^"]+)"/);
  if (match === null || match[1] === undefined) {
    throw new Error(`guard_timeout_default absent from ${contractsPath}`);
  }
  const seconds = match[1].match(/^(\d+)s$/);
  if (seconds === null || seconds[1] === undefined) {
    throw new Error(`guard_timeout_default has unsupported duration ${match[1]}`);
  }
  return Number(seconds[1]) * 1000;
}

function activeRunDirectoryExists(root: string): boolean {
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return false;
    return readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

function defaultRunStateRoot(): string {
  return join(homedir(), ".pi", "agent", "autopilot", "v2", "runs");
}

function deny(reason: string): GuardResult {
  return { decision: "deny", reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
