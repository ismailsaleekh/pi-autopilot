import { coverageComplete } from "../coverage/index.js";
import { commandIdentity } from "../protocol/command.capsule.js";
import { evidenceEnvelopeDigest } from "../protocol/evidence-fact.capsule.js";
import { artifactRefsEqual, compareDecimalNatural, zeroDecimalNatural } from "../protocol/identifiers.js";
import type { ResolvedIndexPage } from "../protocol/state-index.capsule.js";
import { indexKey, indexValues, lookupIndex } from "./authenticated-index.js";
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
  const evidence = found.value.evidence;
  const envelope = evidence.envelope;
  const commandId = commandIdentity("execute-evidence", envelope.actionId);
  const commandValue = lookupIndex(state.indexes.commands, indexKey("commands", commandId), pages);
  if (commandValue.kind !== "proved" || commandValue.value === null || commandValue.value.kind !== "command" || commandValue.value.status !== "settled" || commandValue.value.command.kind !== "execute-evidence") return false;
  const command = commandValue.value.command;
  return evidence.envelopeDigest === evidenceEnvelopeDigest(envelope)
    && envelope.evidenceId === evidenceId
    && envelope.actionId === command.actionId
    && envelope.attemptId === command.attemptId
    && envelope.class === "final-verification"
    && envelope.class === command.evidenceClass
    && envelope.runId === state.identity.runId
    && envelope.tree === state.currentCandidate.tree
    && envelope.tree === command.candidateTree
    && envelope.acceptedOutput === state.currentCandidate.tree
    && artifactRefsEqual(envelope.command, command.commandSpec)
    && envelope.cwd === command.cwd
    && artifactRefsEqual(envelope.environment, command.environment)
    && envelope.kindId === command.kindId
    && envelope.obligationId === `evidence-obligation:${command.commandId}`
    && envelope.ruleId === command.ruleId
    && envelope.workItemId === command.workItemId
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
    && requirements?.declaredAtomCount === state.counters.declaredAtoms
    && coverageComplete(state);
  const c3 = finalEvidenceGreen(state, pages);
  const workValues = indexValues(state.indexes.work, "work");
  const integrationOwner = plan === null ? null : lookupIndex(state.indexes.work, indexKey("work", plan.integrationOwnerWorkItemId), pages);
  const integrationOutput = integrationOwner?.kind === "proved" && integrationOwner.value?.kind === "work"
    ? integrationOwner.value.acceptedOutput
    : null;
  const c4 = candidate !== null
    && attestations !== null
    && artifactRefsEqual(attestations.finalManifest, candidate.manifest)
    && candidate.gitTreeCasAttestation.gitTree === candidate.gitTree
    && candidate.gitTreeCasAttestation.artifactRoot === candidate.tree
    && integrationOutput !== null
    && integrationOutput.outputRoot === candidate.tree
    && artifactRefsEqual(integrationOutput.accountedDiff, candidate.reviewedDiff);
  const c5 = state.phase === "execution"
    && plan !== null
    && candidate !== null
    && candidate.planRootId === plan.planRootId
    && publication?.candidateId === candidate.candidateId;
  const c6 = !zero(state.counters.declaredWork)
    && equal(state.counters.declaredWork, state.counters.acceptedWork)
    && workValues !== null
    && workValues.every((value) => value.kind !== "work" || value.acceptedOutput !== null);
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
