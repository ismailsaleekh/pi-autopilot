import {
  artifactRefSchema,
  attemptIdSchema,
  evidenceIdSchema,
  evidenceObligationIdSchema,
  exitObservationSchema,
  kindIdSchema,
  workspaceRelativePathSchema,
} from "../../authority/protocol/identifiers.js";
import type { EvidenceId } from "../../authority/protocol/identifiers.js";
import type { ExecuteEvidence } from "../../authority/protocol/command.capsule.js";
import type { EvidenceEnvelope } from "../../authority/protocol/evidence-fact.capsule.js";
import {
  canonicalDigestUnknown,
  defineCapsule,
  object,
} from "../../authority/protocol/schema.js";
import {
  decodeBoundaryValue,
} from "../boundary-codecs/index.js";
import type { BoundaryFeedback } from "../boundary-codecs/index.js";

const hostEvidenceReceiptSchema = object({
  attemptId: attemptIdSchema,
  cwd: workspaceRelativePathSchema,
  environment: artifactRefSchema,
  exit: exitObservationSchema,
  kindId: kindIdSchema,
  output: artifactRefSchema,
});

const hostEvidenceReceiptCapsule = defineCapsule(
  "RuntimeHostEvidenceReceipt",
  hostEvidenceReceiptSchema,
);
const evidenceIdCapsule = defineCapsule("RuntimeEvidenceId", evidenceIdSchema);
const evidenceObligationIdCapsule = defineCapsule("RuntimeEvidenceObligationId", evidenceObligationIdSchema);

export type EvidenceMintResult =
  | { readonly kind: "minted"; readonly envelope: EvidenceEnvelope }
  | BoundaryFeedback;

function evidenceId(command: ExecuteEvidence, receipt: unknown): EvidenceId | null {
  const digest = canonicalDigestUnknown(Object.freeze({
    commandId: command.commandId,
    domain: "pi-autopilot.evidence-envelope.v1",
    receipt,
    runId: command.runId,
    tree: command.candidateTree,
    workItemId: command.workItemId,
  }));
  const decoded = evidenceIdCapsule.decode(`evidence:sha256:${digest.slice(7)}`);
  return decoded.kind === "ok" ? decoded.value : null;
}

/**
 * Sole semantic mint. The executor supplies only raw host observations; all
 * authoritative identity and command/tree bindings come from the committed
 * command inside the dispatcher.
 */
export function makeEvidenceEnvelope(
  command: ExecuteEvidence,
  receiptInput: unknown,
): EvidenceMintResult;
export function makeEvidenceEnvelope(command: ExecuteEvidence, receiptInput: unknown) {
  const receipt = decodeBoundaryValue(receiptInput, hostEvidenceReceiptCapsule);
  if (receipt.kind !== "ok") {
    return receipt;
  }
  const derivedEvidenceId = evidenceId(command, receipt.value);
  const obligationId = evidenceObligationIdCapsule.decode(`evidence-obligation:${command.commandId}`);
  if (derivedEvidenceId === null || obligationId.kind !== "ok") {
    return Object.freeze({
      kind: "feedback",
      code: "boundary-schema",
      path: "$.evidenceId",
      diagnostic: "evidence identity could not be derived from the committed command and host receipt",
    });
  }
  return Object.freeze({
    kind: "minted",
    envelope: Object.freeze({
      acceptedOutput: command.candidateTree,
      actionId: command.actionId,
      attemptId: receipt.value.attemptId,
      class: "mechanical",
      command: command.commandSpec,
      cwd: receipt.value.cwd,
      environment: receipt.value.environment,
      evidenceId: derivedEvidenceId,
      exit: receipt.value.exit,
      kindId: receipt.value.kindId,
      obligationId: obligationId.value,
      output: receipt.value.output,
      ruleId: command.ruleId,
      runId: command.runId,
      tree: command.candidateTree,
      workItemId: command.workItemId,
    }),
  });
}
