import {
  actionIdSchema,
  artifactRefSchema,
  artifactRootSchema,
  commandIdSchema,
  diagnosticSchema,
  planRootIdSchema,
  ruleIdSchema,
  runIdSchema,
  workItemIdSchema,
} from "../../authority/protocol/identifiers.js";
import type { Digest } from "../../authority/protocol/identifiers.js";
import { commandSchema } from "../../authority/protocol/command.capsule.js";
import { evidenceEnvelopeSchema } from "../../authority/protocol/evidence-fact.capsule.js";
import {
  arrayOf,
  defineCapsule,
  digestBytes,
  literal,
  object,
  text,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { childObservationCapsule } from "../../ports/contracts/child.capsule.js";
import { clockObservationCapsule } from "../../ports/contracts/clock.capsule.js";
import { gitObservationCapsule } from "../../ports/contracts/git.capsule.js";
import { secretsObservationCapsule } from "../../ports/contracts/secrets.capsule.js";
import { storeObservationCapsule } from "../../ports/contracts/store.capsule.js";
import { workspaceObservationCapsule } from "../../ports/contracts/workspace.capsule.js";
import {
  decodeBoundaryValue,
} from "../boundary-codecs/index.js";
import type {
  BoundaryFeedback,
  BoundaryResult,
} from "../boundary-codecs/index.js";

export const mechanicalValidationReportSchema = object({
  actionId: actionIdSchema,
  commandId: commandIdSchema,
  kind: literal("mechanical-validation-report"),
  result: union([
    object({
      kind: literal("passed"),
      output: artifactRefSchema,
    }),
    object({
      kind: literal("challenged"),
      output: artifactRefSchema,
    }),
    object({
      diagnostic: diagnosticSchema,
      kind: literal("retry"),
    }),
  ]),
  ruleId: ruleIdSchema,
  runId: runIdSchema,
  subjectRoot: artifactRootSchema,
  workItemId: workItemIdSchema,
});

export const commandFailureObservationSchema = object({
  actionId: actionIdSchema,
  commandId: commandIdSchema,
  commandKind: text("non-empty"),
  diagnostic: diagnosticSchema,
  kind: literal("command-execution-feedback"),
  runId: runIdSchema,
});

export const minimalPlanArtifactSchema = object({
  format: literal("pi-autopilot.plan-artifact.v1"),
  index: artifactRefSchema,
  planRoot: artifactRootSchema,
  planRootId: planRootIdSchema,
});

export type MechanicalValidationReport = Infer<typeof mechanicalValidationReportSchema>;
export type CommandFailureObservation = Infer<typeof commandFailureObservationSchema>;
export type MinimalPlanArtifact = Infer<typeof minimalPlanArtifactSchema>;

export type ArtifactNormalizationKind =
  | "command-batch"
  | "workspace-observation"
  | "git-observation"
  | "child-observation"
  | "store-observation"
  | "clock-observation"
  | "secrets-observation"
  | "evidence-envelope"
  | "mechanical-validation-report"
  | "command-execution-feedback"
  | "plan-artifact";

export interface NormalizedArtifact {
  readonly kind: ArtifactNormalizationKind;
  readonly path: string;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Digest;
}

export type ArtifactNormalizationResult =
  | { readonly kind: "normalized"; readonly artifact: NormalizedArtifact }
  | BoundaryFeedback;

const commandBatchCapsule = defineCapsule("RuntimeNormalizedCommandBatch", arrayOf(commandSchema));
const evidenceEnvelopeCapsule = defineCapsule("RuntimeNormalizedEvidenceEnvelope", evidenceEnvelopeSchema);
const validationReportCapsule = defineCapsule("RuntimeMechanicalValidationReport", mechanicalValidationReportSchema);
const commandFailureCapsule = defineCapsule("RuntimeCommandFailureObservation", commandFailureObservationSchema);
const minimalPlanArtifactCapsule = defineCapsule("RuntimeMinimalPlanArtifact", minimalPlanArtifactSchema);

type Normalizer = (input: unknown) => BoundaryResult<unknown>;

type NormalizerMap = Readonly<Record<ArtifactNormalizationKind, Normalizer>>;

const normalizers = Object.freeze({
  "child-observation": (input: unknown) => decodeBoundaryValue(input, childObservationCapsule),
  "clock-observation": (input: unknown) => decodeBoundaryValue(input, clockObservationCapsule),
  "command-batch": (input: unknown) => decodeBoundaryValue(input, commandBatchCapsule),
  "command-execution-feedback": (input: unknown) => decodeBoundaryValue(input, commandFailureCapsule),
  "evidence-envelope": (input: unknown) => decodeBoundaryValue(input, evidenceEnvelopeCapsule),
  "git-observation": (input: unknown) => decodeBoundaryValue(input, gitObservationCapsule),
  "mechanical-validation-report": (input: unknown) => decodeBoundaryValue(input, validationReportCapsule),
  "plan-artifact": (input: unknown) => decodeBoundaryValue(input, minimalPlanArtifactCapsule),
  "secrets-observation": (input: unknown) => decodeBoundaryValue(input, secretsObservationCapsule),
  "store-observation": (input: unknown) => decodeBoundaryValue(input, storeObservationCapsule),
  "workspace-observation": (input: unknown) => decodeBoundaryValue(input, workspaceObservationCapsule),
}) satisfies NormalizerMap;

const artifactPaths = Object.freeze({
  "child-observation": "runtime/observations/child.json",
  "clock-observation": "runtime/observations/clock.json",
  "command-batch": "semantic/commands.canonical.json",
  "command-execution-feedback": "runtime/observations/command-feedback.json",
  "evidence-envelope": "runtime/evidence/envelope.json",
  "git-observation": "runtime/observations/git.json",
  "mechanical-validation-report": "runtime/validation/mechanical-report.json",
  "plan-artifact": "plan/index.json",
  "secrets-observation": "runtime/observations/secrets.json",
  "store-observation": "runtime/observations/store.json",
  "workspace-observation": "runtime/observations/workspace.json",
}) satisfies Readonly<Record<ArtifactNormalizationKind, string>>;

function isNormalizationKind(input: unknown): input is ArtifactNormalizationKind {
  return typeof input === "string" && Object.prototype.hasOwnProperty.call(normalizers, input);
}

/** Pure syntax normalization. It never decides whether artifact content is acceptable. */
export function normalizeArtifact(
  input: unknown,
  kindInput: unknown,
): ArtifactNormalizationResult {
  try {
    if (!isNormalizationKind(kindInput)) {
      return Object.freeze({
        kind: "feedback",
        code: "boundary-schema",
        path: "$.artifactKind",
        diagnostic: "artifact normalization kind is not in the closed runtime catalog",
      });
    }
    const decoded = normalizers[kindInput](input);
    if (decoded.kind !== "ok") {
      return decoded;
    }
    const digest = digestBytes(decoded.canonicalBytes);
    return Object.freeze({
      kind: "normalized",
      artifact: Object.freeze({
        kind: kindInput,
        path: artifactPaths[kindInput],
        canonicalBytes: decoded.canonicalBytes.slice(),
        digest,
      }),
    });
  } catch {
    return Object.freeze({
      kind: "feedback",
      code: "boundary-hostile",
      path: "$",
      diagnostic: "artifact normalization was exception-contained",
    });
  }
}
