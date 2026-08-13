import type { ExecuteValidationRule } from "../../authority/protocol/command.capsule.js";
import {
  defineCapsule,
} from "../../authority/protocol/schema.js";
import {
  mechanicalValidationReportSchema,
} from "../artifact-normalization/index.js";
import type { MechanicalValidationReport } from "../artifact-normalization/index.js";
import {
  decodeBoundaryValue,
  decodeCommand,
} from "../boundary-codecs/index.js";
import type { BoundaryFeedback } from "../boundary-codecs/index.js";

export interface MechanicalRuleExecutor {
  readonly execute: (command: ExecuteValidationRule) => unknown | Promise<unknown>;
}

export type ValidationRunnerResult =
  | { readonly kind: "completed"; readonly report: MechanicalValidationReport }
  | BoundaryFeedback;

const validationReportCapsule = defineCapsule(
  "RuntimeValidationRunnerReport",
  mechanicalValidationReportSchema,
);

function unavailable(): BoundaryFeedback {
  return Object.freeze({
    kind: "feedback",
    code: "boundary-schema",
    path: "$.ruleId",
    diagnostic: "mechanical validation executor is unavailable; report the observation and let authority reschedule",
  });
}

/** Executes one mechanical rule exactly once. Retry policy remains authority-owned. */
export async function runMechanicalValidation(
  input: unknown,
  executor: MechanicalRuleExecutor | null,
): Promise<ValidationRunnerResult> {
  try {
    const command = decodeCommand(input);
    if (command.kind !== "ok") {
      return command;
    }
    if (command.value.kind !== "execute-validation-rule") {
      return Object.freeze({
        kind: "feedback",
        code: "boundary-schema",
        path: "$.kind",
        diagnostic: "validation runner accepts only execute-validation-rule commands",
      });
    }
    if (executor === null || typeof executor.execute !== "function") {
      return unavailable();
    }
    const raw: unknown = await executor.execute(command.value);
    const decoded = decodeBoundaryValue(raw, validationReportCapsule);
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "completed", report: decoded.value })
      : decoded;
  } catch {
    return Object.freeze({
      kind: "feedback",
      code: "boundary-hostile",
      path: "$",
      diagnostic: "mechanical validator invocation was exception-contained and may be rescheduled",
    });
  }
}
