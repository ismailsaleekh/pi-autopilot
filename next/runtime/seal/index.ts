import {
  actionIdSchema,
  artifactRootSchema,
  attemptIdSchema,
  planRootIdSchema,
  runIdSchema,
  workItemIdSchema,
} from "../../authority/protocol/identifiers.js";
import {
  arrayOf,
  defineCapsule,
  literal,
  object,
  text,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { submissionPayloadSchema } from "../../authority/protocol/stimulus.capsule.js";
import type { SubmissionReady } from "../../authority/protocol/stimulus.capsule.js";
import { resolvedIndexPageSchema } from "../../authority/protocol/state-index.capsule.js";
import {
  captureTree,
} from "../../storage/cas/index.js";
import type {
  CasErrorDisposition,
  ContentAddressedStore,
} from "../../storage/cas/index.js";
import {
  decodeBoundaryValue,
  decodeStimulus,
} from "../boundary-codecs/index.js";
import type { BoundaryFeedback } from "../boundary-codecs/index.js";

export const sealRequestSchema = object({
  actionId: actionIdSchema,
  attemptId: attemptIdSchema,
  pages: arrayOf(resolvedIndexPageSchema),
  inputRoot: artifactRootSchema,
  kind: literal("seal-submission"),
  planRootId: planRootIdSchema,
  runId: runIdSchema,
  sourceDirectory: text("non-empty"),
  submissionPayload: submissionPayloadSchema,
  workItemId: workItemIdSchema,
});

export type SealRequest = Infer<typeof sealRequestSchema>;

export type SealResult =
  | {
      readonly kind: "sealed";
      readonly stimulus: SubmissionReady;
      readonly alreadyPresent: boolean;
      readonly entryCount: number;
    }
  | (BoundaryFeedback & { readonly disposition?: CasErrorDisposition });

const sealRequestCapsule = defineCapsule("RuntimeSealRequest", sealRequestSchema);

function storageFeedback(
  disposition: CasErrorDisposition,
  diagnostic: string,
): BoundaryFeedback & { readonly disposition: CasErrorDisposition } {
  return Object.freeze({
    kind: "feedback",
    code: disposition === "feedback" ? "boundary-schema" : "boundary-hostile",
    path: "$.sourceDirectory",
    diagnostic,
    disposition,
  });
}

/**
 * Captures exactly one mutable directory into CAS and binds only the returned
 * immutable root. No path is read again after capture and no content semantics
 * are evaluated here.
 */
export async function sealSubmission(
  input: unknown,
  store: ContentAddressedStore,
): Promise<SealResult> {
  try {
    const request = decodeBoundaryValue(input, sealRequestCapsule);
    if (request.kind !== "ok") {
      return request;
    }
    const captured = await captureTree(store, request.value.sourceDirectory);
    if (captured.kind === "error") {
      return storageFeedback(captured.error.disposition, captured.error.message);
    }
    const candidate = Object.freeze({
      actionId: request.value.actionId,
      attemptId: request.value.attemptId,
      inputRoot: request.value.inputRoot,
      kind: "submission-ready",
      outputRoot: captured.root,
      pages: request.value.pages,
      planRootId: request.value.planRootId,
      runId: request.value.runId,
      submissionPayload: request.value.submissionPayload,
      workItemId: request.value.workItemId,
    });
    const decoded = decodeStimulus(candidate);
    if (decoded.kind !== "ok" || decoded.value.kind !== "submission-ready") {
      return decoded.kind === "ok"
        ? Object.freeze({
            kind: "feedback",
            code: "boundary-schema",
            path: "$.kind",
            diagnostic: "sealed binding did not decode as submission-ready",
          })
        : decoded;
    }
    return Object.freeze({
      kind: "sealed",
      stimulus: decoded.value,
      alreadyPresent: captured.alreadyPresent,
      entryCount: captured.entryCount,
    });
  } catch {
    return Object.freeze({
      kind: "feedback",
      code: "boundary-hostile",
      path: "$",
      diagnostic: "seal operation was exception-contained; retry from the same workspace",
    });
  }
}
