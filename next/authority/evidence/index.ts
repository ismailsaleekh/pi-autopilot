import { indexKey, indexValues, lookupIndex } from "../model/authenticated-index.js";
import type { RunState } from "../model/run-state.js";
import { evidenceEnvelopeDigest } from "../protocol/evidence-fact.capsule.js";
import type { EvidenceFact } from "../protocol/evidence-fact.capsule.js";
import { artifactRefsEqual, exitObservationsEqual } from "../protocol/identifiers.js";
import type {
  ArtifactRef,
  ArtifactRoot,
  EvidenceId,
  ExitObservation,
  KindId,
  WorkItemId,
} from "../protocol/identifiers.js";
import type { ResolvedIndexPage } from "../protocol/state-index.capsule.js";

export interface EvidenceClaim {
  readonly evidenceId: EvidenceId;
  readonly tree: ArtifactRoot;
  readonly exit: ExitObservation;
  readonly output: ArtifactRef;
}

export type ClaimRejectionCode =
  | "evidence-not-found"
  | "evidence-unproven"
  | "evidence-envelope-digest-mismatch"
  | "evidence-run-mismatch"
  | "evidence-tree-mismatch"
  | "evidence-exit-mismatch"
  | "evidence-output-mismatch";

export type ClaimCheck =
  | { readonly kind: "accepted"; readonly evidence: EvidenceFact }
  | { readonly kind: "rejected"; readonly code: ClaimRejectionCode; readonly diagnostic: string };

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

export function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return artifactRefsEqual(left, right);
}

function sameExit(left: ExitObservation, right: ExitObservation): boolean {
  return exitObservationsEqual(left, right);
}

function envelopeDigestMatches(evidence: EvidenceFact): boolean {
  return evidence.envelopeDigest === evidenceEnvelopeDigest(evidence.envelope);
}

function successful(exit: ExitObservation): boolean {
  return exit.kind === "exited" && exit.code === "0";
}

function satisfiesFact(state: RunState, evidence: EvidenceFact, obligation: EvidenceObligation): boolean {
  const envelope = evidence.envelope;
  return (obligation.evidenceId === null || envelope.evidenceId === obligation.evidenceId)
    && envelopeDigestMatches(evidence)
    && envelope.runId === state.identity.runId
    && envelope.workItemId === obligation.workItemId
    && envelope.tree === obligation.tree
    && (obligation.kindId === null || envelope.kindId === obligation.kindId)
    && (obligation.output === null || sameArtifactRef(envelope.output, obligation.output))
    && (!obligation.requireSuccessfulExit || successful(envelope.exit));
}

/** Exact evidence checks require a root-bound membership or absence witness. */
export function checkClaim(
  state: RunState,
  claim: EvidenceClaim,
  pages: readonly ResolvedIndexPage[] = Object.freeze([]),
): ClaimCheck {
  const found = lookupIndex(state.indexes.evidence, indexKey("evidence", claim.evidenceId), pages);
  if (found.kind !== "proved") {
    return rejected("evidence-unproven", found.diagnostic);
  }
  if (found.value === null || found.value.kind !== "evidence") {
    return rejected("evidence-not-found", `no proved evidence exists for ${claim.evidenceId}`);
  }
  const evidence = found.value.evidence;
  if (!envelopeDigestMatches(evidence)) {
    return rejected("evidence-envelope-digest-mismatch", "evidence envelope digest is stale");
  }
  if (evidence.envelope.runId !== state.identity.runId) {
    return rejected("evidence-run-mismatch", "evidence belongs to another run");
  }
  if (evidence.envelope.tree !== claim.tree) {
    return rejected("evidence-tree-mismatch", "evidence covers another tree");
  }
  if (!sameExit(evidence.envelope.exit, claim.exit)) {
    return rejected("evidence-exit-mismatch", "evidence exit observation differs");
  }
  if (!sameArtifactRef(evidence.envelope.output, claim.output)) {
    return rejected("evidence-output-mismatch", "evidence output reference differs");
  }
  return Object.freeze({ kind: "accepted", evidence });
}

/** General searches are permitted only over a complete bounded hot index. */
export function evidenceSatisfies(state: RunState, obligation: EvidenceObligation): boolean {
  if (obligation.evidenceId !== null) {
    const checked = lookupIndex(
      state.indexes.evidence,
      indexKey("evidence", obligation.evidenceId),
      Object.freeze([]),
    );
    return checked.kind === "proved"
      && checked.value !== null
      && checked.value.kind === "evidence"
      && satisfiesFact(state, checked.value.evidence, obligation);
  }
  const values = indexValues(state.indexes.evidence, "evidence");
  return values !== null && values.some((value) => value.kind === "evidence" && satisfiesFact(state, value.evidence, obligation));
}
