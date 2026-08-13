import type { FoldError } from "../evolution/fold-result.js";
import type { DecodeError } from "../protocol/schema.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";

export type Feedback =
  | {
      readonly kind: "feedback";
      readonly code: "invalid-stimulus";
      readonly schemaCode: DecodeError["code"];
      readonly path: string;
      readonly diagnostic: string;
    }
  | {
      readonly kind: "feedback";
      readonly code: "admission-not-implemented";
      readonly stimulusKind: Stimulus["kind"];
      readonly diagnostic: string;
    }
  | {
      readonly kind: "feedback";
      readonly code: "invalid-accepted-batch";
      readonly diagnostic: string;
    }
  | {
      readonly kind: "feedback";
      readonly code: "invalid-domain-transition";
      readonly error: FoldError;
      readonly diagnostic: string;
    };

export function invalidStimulusFeedback(error: DecodeError): Feedback {
  return Object.freeze({
    kind: "feedback",
    code: "invalid-stimulus",
    schemaCode: error.code,
    path: error.path,
    diagnostic: error.diagnostic,
  });
}

export function unavailableAdmissionFeedback(stimulusKind: Stimulus["kind"]): Feedback {
  return Object.freeze({
    kind: "feedback",
    code: "admission-not-implemented",
    stimulusKind,
    diagnostic: `not yet implemented: ${stimulusKind}`,
  });
}
