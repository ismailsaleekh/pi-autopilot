import type { AcceptedBatch } from "../../authority/protocol/accepted-batch.js";
import { ingestDecisionCapsule } from "../../authority/protocol/ingest-decision.capsule.js";

const accepted = ingestDecisionCapsule.arbitrary.validForKind("accept", 401);
if (accepted.kind !== "accept") {
  throw new Error("fixture generator did not return accept");
}

const forbiddenBatch: AcceptedBatch = {
  runId: accepted.runId,
  factRoot: accepted.factRoot,
  commandRoot: accepted.commandRoot,
  stateDigest: accepted.stateDigest,
};

void forbiddenBatch;
