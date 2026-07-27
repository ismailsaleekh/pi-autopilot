import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  CoreToHostGuardDecisionPayload,
  HostToCoreGuardQueryPayload,
} from "./generated/index.ts";
import { CoreTimeoutError, CoreTransport, CoreUnavailableError } from "./transport.ts";

export interface GuardOptions {
  transport?: CoreTransport;
  timeoutMs?: number;
  contractsPath?: string;
}

export interface GuardResult {
  decision: "allow" | "deny";
  reason: string;
}

export async function guardToolCall(
  query: HostToCoreGuardQueryPayload,
  options: GuardOptions = {},
): Promise<GuardResult> {
  let timeoutMs: number;
  try {
    timeoutMs = options.timeoutMs ?? guardTimeoutDefaultMs(options.contractsPath);
  } catch (error) {
    return deny(`contract-timeout-unavailable:${errorMessage(error)}`);
  }
  const transport = options.transport ?? new CoreTransport();
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
    return deny(`core-error:${errorMessage(error)}`);
  }
}

export function guardTimeoutDefaultMs(contractsPath = defaultContractsPath()): number {
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

function deny(reason: string): GuardResult {
  return { decision: "deny", reason };
}

function defaultContractsPath(): string {
  return fileURLToPath(new URL("../../data/contracts.kdl", import.meta.url));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
