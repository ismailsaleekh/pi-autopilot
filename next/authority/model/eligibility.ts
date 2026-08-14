import { compareDecimalNatural, zeroDecimalNatural } from "../protocol/identifiers.js";
import type { ResolvedIndexPage } from "../protocol/state-index.capsule.js";
import type { TerminalOutcome } from "../protocol/terminal-outcome.capsule.js";
import { indexKey, lookupIndex } from "./authenticated-index.js";
import type { RunState } from "./run-state.js";

export interface T1Checks {
  readonly c1RequirementsBound: boolean;
  readonly c2AtomsDispositioned: boolean;
  readonly c3FinalEvidenceGreen: boolean;
  readonly c4ReviewedDiffAndManifest: boolean;
  readonly c5IdentityBindings: boolean;
  readonly c6AcceptedWorkRetained: boolean;
  readonly c7NoProductGap: boolean;
  readonly noBlockingFindings: boolean;
  readonly publicationContainsCandidate: boolean;
  readonly finalAttestationsBound: boolean;
}

export type Eligibility =
  | { readonly kind: "ineligible"; readonly checks: T1Checks }
  | { readonly kind: "eligible"; readonly outcome: TerminalOutcome; readonly checks: T1Checks };

function zero(value: RunState["counters"]["declaredAtoms"]): boolean {
  return compareDecimalNatural(value, zeroDecimalNatural()) === 0;
}

function equal(left: RunState["counters"]["declaredAtoms"], right: RunState["counters"]["declaredAtoms"]): boolean {
  return compareDecimalNatural(left, right) === 0;
}

function finalEvidenceGreen(state: RunState, pages: readonly ResolvedIndexPage[]): boolean {
  if (state.finalAttestations === null || state.currentCandidate === null) {
    return false;
  }
  const evidenceId = state.finalAttestations.finalVerificationEvidence;
  const found = lookupIndex(state.indexes.evidence, indexKey("evidence", evidenceId), pages);
  if (found.kind !== "proved" || found.value === null || found.value.kind !== "evidence") {
    return false;
  }
  const envelope = found.value.evidence.envelope;
  return envelope.evidenceId === evidenceId
    && envelope.class === "final-verification"
    && envelope.runId === state.identity.runId
    && envelope.tree === state.currentCandidate.tree
    && envelope.acceptedOutput === state.currentCandidate.tree
    && envelope.exit.kind === "exited"
    && envelope.exit.code === "0";
}

export function t1Checks(state: RunState, pages: readonly ResolvedIndexPage[]): T1Checks {
  const requirements = state.requirements;
  const plan = state.currentPlan;
  const candidate = state.currentCandidate;
  const publication = state.currentPublication;
  const attestations = state.finalAttestations;
  const c1 = requirements !== null
    && requirements.taskRoot === state.identity.taskSnapshot
    && requirements.inventorySealed
    && requirements.atomIndexRoot === state.indexes.atoms.root;
  const c2 = c1
    && !zero(state.counters.declaredAtoms)
    && equal(state.counters.declaredAtoms, state.counters.dispositionedAtoms)
    && requirements?.declaredAtomCount === state.counters.declaredAtoms;
  const c3 = finalEvidenceGreen(state, pages);
  const c4 = candidate !== null
    && candidate.reviewedDiff.digest.length > 0
    && candidate.manifest.digest.length > 0
    && candidate.gitTreeCasAttestation.gitTree === candidate.gitTree
    && candidate.gitTreeCasAttestation.artifactRoot === candidate.tree;
  const c5 = state.phase === "execution"
    && plan !== null
    && candidate !== null
    && candidate.planRootId === plan.planRootId
    && publication?.candidateId === candidate.candidateId;
  const c6 = !zero(state.counters.declaredWork)
    && equal(state.counters.declaredWork, state.counters.acceptedWork);
  const c7 = state.planningGap === null;
  const noBlocking = zero(state.counters.openBlockingFindings);
  const published = candidate !== null
    && publication !== null
    && publication.status === "desired-head"
    && publication.observedHead === publication.desiredHead
    && publication.tree === candidate.tree
    && publication.gitTree === candidate.gitTree
    && publication.publicationTreeAttestation !== null
    && publication.publicationTreeAttestation.gitTree === candidate.gitTree
    && publication.publicationTreeAttestation.artifactRoot === candidate.tree;
  const finalBound = attestations !== null
    && candidate !== null
    && publication !== null
    && attestations.candidateId === candidate.candidateId
    && attestations.publicationId === publication.publicationId
    && attestations.evidenceIndexRoot === state.indexes.evidence.root;
  return Object.freeze({
    c1RequirementsBound: c1,
    c2AtomsDispositioned: c2,
    c3FinalEvidenceGreen: c3,
    c4ReviewedDiffAndManifest: c4,
    c5IdentityBindings: c5,
    c6AcceptedWorkRetained: c6,
    c7NoProductGap: c7,
    noBlockingFindings: noBlocking,
    publicationContainsCandidate: published,
    finalAttestationsBound: finalBound,
  });
}

export function eligibleOutcomeForState(
  state: RunState,
  pages: readonly ResolvedIndexPage[],
): Eligibility {
  if (state.phase === "planning" && state.planningGap !== null) {
    const gap = state.planningGap;
    return Object.freeze({
      kind: "eligible",
      checks: t1Checks(state, pages),
      outcome: Object.freeze({
        kind: "t2",
        reason: gap.reason,
        sourceAnchors: gap.sourceAnchors,
        sourceEvidence: gap.sourceEvidence,
        explanation: gap.explanation,
      }),
    });
  }
  const checks = t1Checks(state, pages);
  const eligible = checks.c1RequirementsBound
    && checks.c2AtomsDispositioned
    && checks.c3FinalEvidenceGreen
    && checks.c4ReviewedDiffAndManifest
    && checks.c5IdentityBindings
    && checks.c6AcceptedWorkRetained
    && checks.c7NoProductGap
    && checks.noBlockingFindings
    && checks.publicationContainsCandidate
    && checks.finalAttestationsBound;
  if (!eligible || state.currentPlan === null || state.currentCandidate === null || state.currentPublication === null || state.finalAttestations === null || state.currentPublication.observedHead === null || state.currentPublication.publicationTreeAttestation === null) {
    return Object.freeze({ kind: "ineligible", checks });
  }
  return Object.freeze({
    kind: "eligible",
    checks,
    outcome: Object.freeze({
      kind: "t1",
      advisoryDisclosures: state.finalAttestations.advisoryDisclosures,
      c1ToC7Proof: state.finalAttestations.c1ToC7Proof,
      candidateId: state.currentCandidate.candidateId,
      coverageRoot: state.currentPlan.coverageRoot,
      evidenceIndexRoot: state.finalAttestations.evidenceIndexRoot,
      finalManifest: state.finalAttestations.finalManifest,
      finalTree: state.currentCandidate.tree,
      gitTree: state.currentCandidate.gitTree,
      gitTreeCasAttestation: state.currentCandidate.gitTreeCasAttestation.attestation,
      publicationId: state.currentPublication.publicationId,
      publicationTreeAttestation: state.currentPublication.publicationTreeAttestation.attestation,
      publishedRevision: state.currentPublication.observedHead,
      reviewedDiff: state.currentCandidate.reviewedDiff,
    }),
  });
}
