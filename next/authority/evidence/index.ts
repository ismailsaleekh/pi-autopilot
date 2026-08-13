import type { RunState } from "../model/run-state.js";
import type { EvidenceFact } from "../protocol/evidence-fact.capsule.js";
import type {
  ArtifactRef,
  ArtifactRoot,
  EvidenceId,
  ExitObservation,
  KindId,
  WorkItemId,
} from "../protocol/identifiers.js";
import { canonicalDigestUnknown as digestCanonicalValue } from "../protocol/schema.js";

export interface EvidenceClaim {
  readonly evidenceId: EvidenceId;
  readonly tree: ArtifactRoot;
  readonly exit: ExitObservation;
  readonly output: ArtifactRef;
}

export type ClaimRejectionCode =
  | "evidence-not-found"
  | "evidence-envelope-digest-mismatch"
  | "evidence-run-mismatch"
  | "evidence-tree-mismatch"
  | "evidence-exit-mismatch"
  | "evidence-output-mismatch";

export type ClaimCheck =
  | {
      readonly kind: "accepted";
      readonly evidence: EvidenceFact;
    }
  | {
      readonly kind: "rejected";
      readonly code: ClaimRejectionCode;
      readonly diagnostic: string;
    };

/**
 * An obligation may identify one exact evidence fact, or allow any observed
 * evidence for one work item. A null output/kind leaves that field unconstrained;
 * every non-null assertion is matched exactly.
 */
export interface EvidenceObligation {
  readonly evidenceId: EvidenceId | null;
  readonly workItemId: WorkItemId;
  readonly tree: ArtifactRoot;
  readonly kindId: KindId | null;
  readonly output: ArtifactRef | null;
  readonly requireSuccessfulExit: boolean;
}

function rejected(code: ClaimRejectionCode, diagnostic: string): ClaimCheck {
  return Object.freeze({ kind: "rejected", code, diagnostic });
}

function sameRange(
  left: ArtifactRef["range"],
  right: ArtifactRef["range"],
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.offset === right.offset && left.length === right.length;
}

export function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.root === right.root
    && left.path === right.path
    && sameRange(left.range, right.range);
}

function sameExit(left: ExitObservation, right: ExitObservation): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "exited" && right.kind === "exited") {
    return left.code === right.code;
  }
  if (left.kind === "signalled" && right.kind === "signalled") {
    return left.signal === right.signal;
  }
  return false;
}

function envelopeDigestMatches(evidence: EvidenceFact): boolean {
  return evidence.envelopeDigest === digestCanonicalValue(evidence.envelope);
}

function successful(exit: ExitObservation): boolean {
  return exit.kind === "exited" && exit.code === 0;
}

/** Resolve an exact mechanical claim against host-observed journal facts. */
export function checkClaim(state: RunState, claim: EvidenceClaim): ClaimCheck {
  const record = state.evidenceRecords.find((entry) => entry.evidenceId === claim.evidenceId);
  if (record === undefined) {
    return rejected(
      "evidence-not-found",
      `evidence-not-found: no evidence-observed fact exists for ${claim.evidenceId}`,
    );
  }
  if (!envelopeDigestMatches(record.evidence)) {
    return rejected(
      "evidence-envelope-digest-mismatch",
      `evidence-envelope-digest-mismatch: ${claim.evidenceId} is not bound to its recorded envelope`,
    );
  }
  const envelope = record.evidence.envelope;
  if (envelope.runId !== state.identity.runId) {
    return rejected(
      "evidence-run-mismatch",
      `evidence-run-mismatch: ${claim.evidenceId} belongs to ${envelope.runId}, not ${state.identity.runId}`,
    );
  }
  if (envelope.tree !== claim.tree) {
    return rejected(
      "evidence-tree-mismatch",
      `evidence-tree-mismatch: ${claim.evidenceId} covers ${envelope.tree}, not ${claim.tree}`,
    );
  }
  if (!sameExit(envelope.exit, claim.exit)) {
    return rejected(
      "evidence-exit-mismatch",
      `evidence-exit-mismatch: ${claim.evidenceId} does not have the asserted exit observation`,
    );
  }
  if (!sameArtifactRef(envelope.output, claim.output)) {
    return rejected(
      "evidence-output-mismatch",
      `evidence-output-mismatch: ${claim.evidenceId} does not have the asserted output reference`,
    );
  }
  return Object.freeze({ kind: "accepted", evidence: record.evidence });
}

/** Pure C3 predicate used by coverage and terminal eligibility. */
export function evidenceSatisfies(
  state: RunState,
  obligation: EvidenceObligation,
): boolean {
  return state.evidenceRecords.some((record) => {
    const evidence = record.evidence;
    const envelope = evidence.envelope;
    return (obligation.evidenceId === null || record.evidenceId === obligation.evidenceId)
      && envelopeDigestMatches(evidence)
      && envelope.runId === state.identity.runId
      && envelope.workItemId === obligation.workItemId
      && envelope.tree === obligation.tree
      && (obligation.kindId === null || envelope.kindId === obligation.kindId)
      && (obligation.output === null || sameArtifactRef(envelope.output, obligation.output))
      && (!obligation.requireSuccessfulExit || successful(envelope.exit));
  });
}
