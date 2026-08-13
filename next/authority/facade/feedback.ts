import type { DecodeError } from "../protocol/schema.js";

export type SemanticFeedbackCode =
  | "action-already-committed"
  | "already-suspended"
  | "atom-inventory-invalid"
  | "command-not-issued"
  | "corrector-unavailable"
  | "dependency-cycle"
  | "duplicate-semantic-value"
  | "evidence-invalid"
  | "finding-invalid"
  | "invalid-accepted-commit"
  | "invalid-domain-transition"
  | "invalid-stimulus"
  | "noncurrent-plan-consequence"
  | "not-suspended"
  | "outcome-ineligible"
  | "page-unproven"
  | "plan-invalid"
  | "replay-mismatch"
  | "resume-binding-mismatch"
  | "route-invalid"
  | "run-already-terminal"
  | "run-mismatch"
  | "stale-input-root"
  | "superseded-plan-root"
  | "work-item-not-accepting";

export interface Feedback {
  readonly kind: "feedback";
  readonly code: SemanticFeedbackCode;
  readonly path: string;
  readonly diagnostic: string;
  readonly schemaCode: DecodeError["code"] | null;
}

export function semanticFeedback(
  code: SemanticFeedbackCode,
  path: string,
  diagnostic: string,
): Feedback {
  return Object.freeze({ kind: "feedback", code, path, diagnostic, schemaCode: null });
}

export function invalidStimulusFeedback(error: DecodeError): Feedback {
  return Object.freeze({
    kind: "feedback",
    code: "invalid-stimulus",
    schemaCode: error.code,
    path: error.path,
    diagnostic: error.diagnostic,
  });
}
