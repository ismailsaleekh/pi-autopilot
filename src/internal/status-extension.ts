import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  evaluateAutopilotWorktreeToolCall,
  type AutopilotGuardDecision,
  type AutopilotToolCallContextLike,
  type AutopilotToolCallEventLike,
} from '../core/git-guard.ts';
import { AUTOPILOT_STATUS_CONTEXT_ENV, AUTOPILOT_STATUS_TOOL } from '../core/names.ts';
import { AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA } from '../core/contracts/schemas.ts';
import {
  parseAutopilotStatusToolContext,
  type AutopilotStatusToolContext,
} from '../core/forced-output/identity.ts';
import { emitAutopilotStatus, type AutopilotEmitResult } from '../core/forced-output/writer.ts';

export interface PiToolTextResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly details: { readonly [key: string]: unknown };
  readonly terminate?: true;
}

export interface PiToolDefinitionLike {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: { readonly [key: string]: unknown };
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<PiToolTextResult>;
}

export type PiStatusToolCallHandler = (
  event: AutopilotToolCallEventLike,
  ctx: AutopilotToolCallContextLike,
) => AutopilotGuardDecision | Promise<AutopilotGuardDecision>;

export interface PiExtensionHostLike {
  registerTool(tool: PiToolDefinitionLike): void;
  on?(eventName: 'tool_call', handler: PiStatusToolCallHandler): void;
}

export function loadAutopilotStatusToolContextFromEnv(
  env: { readonly [key: string]: string | undefined } = process.env,
): AutopilotStatusToolContext {
  const contextPath = env[AUTOPILOT_STATUS_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) {
    throw new Error(
      `${AUTOPILOT_STATUS_CONTEXT_ENV} is required; autopilot_emit_status loads only through autopilot-agent-run with an explicit context file`,
    );
  }
  if (!isAbsolute(contextPath)) {
    throw new Error(
      `${AUTOPILOT_STATUS_CONTEXT_ENV} must be an absolute path, got ${contextPath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(contextPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `failed to read Autopilot status tool context ${contextPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseAutopilotStatusToolContext(parsed);
}

export function createAutopilotEmitStatusTool(
  context: AutopilotStatusToolContext,
): PiToolDefinitionLike {
  return {
    name: AUTOPILOT_STATUS_TOOL,
    label: 'Autopilot Status Output',
    description:
      'Emit the final Autopilot structured status for this unit. This writes the status artifact and receipt; assistant-text JSON is invalid.',
    promptSnippet: 'Emit final Autopilot status via autopilot_emit_status',
    promptGuidelines: [
      'Use autopilot_emit_status exactly once as the final action for this Autopilot unit.',
      'The payload must be the complete AutopilotStatusEntry object for the assigned unit identity.',
      'Do not answer with assistant-text JSON; autopilot_emit_status is the only valid success carrier.',
    ],
    parameters: AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA,
    async execute(toolCallId: string, params: unknown): Promise<PiToolTextResult> {
      const result = emitAutopilotStatus(context, params, toolCallId);
      return buildToolResult(result, toolCallId);
    },
  };
}

function buildToolResult(
  result: AutopilotEmitResult,
  toolCallId: string,
): PiToolTextResult {
  return {
    content: [
      {
        type: 'text',
        text: `Autopilot status emitted: verdict=${result.status.verdict} status=${result.statusOutput}`,
      },
    ],
    details: {
      schema_version: 'autopilot.status_tool_result.v1',
      tool_name: AUTOPILOT_STATUS_TOOL,
      tool_call_id: toolCallId,
      terminating: true,
      workstream: result.status.workstream,
      unit_id: result.status.unit_id,
      role: result.status.role,
      attempt: result.status.attempt,
      verdict: result.status.verdict,
      severity: result.status.severity,
      status_output: result.statusOutput,
      receipt_output: result.receiptOutput,
      status_sha256: result.statusSha256,
      schema_sha256: result.schemaSha256,
      expected_identity_hash: result.expectedIdentityHash,
    },
    terminate: true,
  };
}

export default function autopilotStatusExtension(pi: PiExtensionHostLike): void {
  if (typeof pi.registerTool !== 'function') {
    throw new Error(
      'autopilot-status-extension: refusing to load on a host without registerTool()',
    );
  }
  const context = loadAutopilotStatusToolContextFromEnv();
  pi.registerTool(createAutopilotEmitStatusTool(context));
  if (pi.on !== undefined) {
    pi.on('tool_call', (event, toolCtx) =>
      evaluateAutopilotWorktreeToolCall(event, toolCtx, {
        worktreeRoot: context.unit_spec.cwd,
        label: 'Autopilot child worktree guard',
        allowedWriteRoots: [context.artifact_root],
      }),
    );
  }
}
