import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { SubmitToolDescriptor } from "./generated/tool-schemas.ts";

export const CHILD_RECEIPT_ENTRY = "pi-autopilot:child-tools";

type SubmitTools = readonly SubmitToolDescriptor[];

export function runAutopilotChild(
  pi: ExtensionAPI,
  tools: SubmitTools,
  wrapperUrl: string,
): void {
  const tool = selectedTerminalTool(tools);
  registerTool(pi, tool);
  pi.on("session_start", async () => {
    pi.appendEntry(CHILD_RECEIPT_ENTRY, {
      self_digest: selfDigest(wrapperUrl),
      profile_id: tool.profile_id,
      tool_name: tool.name,
      boundary_id: tool.boundary_id,
      result_contract: tool.result_contract,
      schema_digest: tool.schema_digest,
      binding: process.env["AUTOPILOT_CARRIER_BINDING"] ?? "",
      active_tools: [...pi.getActiveTools()].sort(),
    });
  });
}

export function registerSubmitTools(pi: ExtensionAPI, tools: SubmitTools, _wrapperUrl: string): void {
  for (const tool of tools) {
    if (tool.boundary_id.startsWith("planning.")) registerTool(pi, tool);
  }
}

function selectedTerminalTool(tools: SubmitTools): SubmitToolDescriptor {
  const profileId = process.env["AUTOPILOT_TERMINAL_PROFILE"] ?? "";
  const matches = tools.filter((tool) => tool.profile_id === profileId);
  if (matches.length !== 1) {
    const quoted = JSON.stringify(profileId);
    throw new Error(`autopilot child terminal profile ${quoted} resolved ${matches.length} descriptors`);
  }
  const match = matches[0];
  if (match === undefined) throw new Error("autopilot child terminal profile selection disappeared");
  return match;
}

function registerTool(pi: ExtensionAPI, tool: SubmitToolDescriptor): void {
  const computed = createHash("sha256").update(canonicalJson(tool.parameters)).digest("hex");
  if (computed !== tool.schema_digest) {
    throw new Error(
      `autopilot child tool ${tool.name} parameter digest drift: declared ${tool.schema_digest}, computed ${computed}`,
    );
  }
  const description = `Submit the final ${tool.boundary_id} payload. Use this as the final action;`;
  pi.registerTool(defineTool({
    name: tool.name,
    label: tool.label,
    description: `${description} assistant prose is not a carrier.`,
    promptSnippet: `Submit ${tool.boundary_id} as a terminating typed Autopilot carrier`,
    promptGuidelines: [
      `Call ${tool.name} exactly once as the final action for ${tool.boundary_id}.`,
      "Do not return the payload as assistant prose or markdown.",
    ],
    parameters: tool.parameters,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Submitted ${tool.boundary_id}` }],
        details: {
          profile_id: tool.profile_id,
          tool_name: tool.name,
          boundary_id: tool.boundary_id,
          result_contract: tool.result_contract,
          schema_digest: tool.schema_digest,
          binding: process.env["AUTOPILOT_CARRIER_BINDING"] ?? "",
          payload: params as Record<string, unknown>,
        },
        terminate: true,
      };
    },
  }));
}

function selfDigest(wrapperUrl: string): string {
  return createHash("sha256").update(readFileSync(fileURLToPath(wrapperUrl))).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
