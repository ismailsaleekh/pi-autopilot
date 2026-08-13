import { foldDomainFact } from "../evolution/domain-fact-fold.js";
import { indexKey, lookupIndex } from "../model/authenticated-index.js";
import type { RunState } from "../model/run-state.js";
import {
  commandActionId,
  commandCapsule,
  commandIdentity,
} from "../protocol/command.capsule.js";
import type { Command } from "../protocol/command.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import type { Stimulus } from "../protocol/stimulus.capsule.js";
import type { IndexValue } from "../protocol/state-index.capsule.js";
import { semanticFeedback } from "../facade/feedback.js";
import type { Feedback } from "../facade/feedback.js";
import type { ReactionResult, ReactionSeam } from "../facade/seams.js";

function decodeCommand(input: unknown): Command | null {
  const encoded = commandCapsule.encodeUnknown(input);
  if (encoded.kind === "error") {
    return null;
  }
  const decoded = commandCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok" ? decoded.value : null;
}

function stateAfterFacts(state: RunState, facts: readonly DomainFact[], stimulus: Stimulus): RunState | Feedback {
  let current = state;
  for (const fact of facts) {
    const result = foldDomainFact(current, fact, stimulus.pages, null);
    if (result.kind !== "applied") {
      return semanticFeedback("invalid-domain-transition", "$.facts", result.diagnostic);
    }
    current = result.state;
  }
  return current;
}

function commandKnown(state: RunState, command: Command, stimulus: Stimulus): boolean | Feedback {
  const found = lookupIndex(state.indexes.commands, indexKey("commands", command.commandId), stimulus.pages);
  if (found.kind !== "proved") {
    return semanticFeedback("page-unproven", "$.pages", found.diagnostic);
  }
  return found.value !== null;
}

function reserveCommand(work: Extract<IndexValue, { readonly kind: "work" }>): Command | null {
  const item = work.workItem;
  const leaseId = `lease:${item.workItemId}`;
  const inputs = Object.freeze({
    workspaceCapability: item.workspaceCapability,
    workspaceId: item.workspaceId,
  });
  const preconditions = Object.freeze({ expectedAbsent: true, leaseId });
  const actionId = commandActionId(
    "workspace",
    item.runId,
    "allocate-attempt-directory",
    inputs,
    preconditions,
  );
  return decodeCommand(Object.freeze({
    actionId,
    commandId: commandIdentity("prepare-workspace", actionId),
    kind: "prepare-workspace",
    leaseId,
    planRootId: item.planRootId,
    runId: item.runId,
    workItemId: item.workItemId,
    workspaceCapability: item.workspaceCapability,
    workspaceId: item.workspaceId,
  }));
}

function publicationCommand(state: RunState): Command | null {
  const publication = state.currentPublication;
  const candidate = state.currentCandidate;
  if (publication === null || candidate === null || publication.status !== "intended") {
    return null;
  }
  const inputs = Object.freeze({
    desiredHead: publication.desiredHead,
    expected: publication.expected,
    publicationId: publication.publicationId,
    publicationRef: publication.publicationRef,
    repository: publication.repository,
  });
  const preconditions = Object.freeze({
    candidateTree: candidate.gitTree,
    publicationLease: `lease:publication:${publication.publicationId}`,
    verifiedAttestation: candidate.gitTreeCasAttestation,
  });
  const actionId = commandActionId("git", state.identity.runId, "publish-if-expected-head", inputs, preconditions);
  return decodeCommand(Object.freeze({
    actionId,
    candidateId: candidate.candidateId,
    candidateTree: candidate.gitTree,
    commandId: commandIdentity("publish-compare-and-swap", actionId),
    desiredHead: publication.desiredHead,
    expected: publication.expected,
    kind: "publish-compare-and-swap",
    publicationId: publication.publicationId,
    publicationLease: preconditions.publicationLease,
    publicationRef: publication.publicationRef,
    repository: publication.repository,
    runId: state.identity.runId,
    verifiedAttestation: candidate.gitTreeCasAttestation,
  }));
}

/** Every returned command maps to exactly one port intent and physical operation. */
export function deriveReaction(
  state: RunState,
  facts: readonly DomainFact[],
  stimulus: Stimulus,
): ReactionResult | Feedback {
  const prospective = stateAfterFacts(state, facts, stimulus);
  if ("kind" in prospective && prospective.kind === "feedback") {
    return prospective;
  }
  if (prospective.suspension.kind === "suspended" || prospective.terminal !== null) {
    return Object.freeze({ commands: Object.freeze([]) });
  }
  if (!prospective.indexes.work.hotComplete) {
    return semanticFeedback("page-unproven", "$.pages", "ready-work page is required when the authenticated work index exceeds the bounded hot page");
  }
  const commands: Command[] = [];
  for (const entry of prospective.indexes.work.hot) {
    if (entry.value.kind !== "work" || entry.value.acceptedOutput !== null) {
      continue;
    }
    const command = reserveCommand(entry.value);
    if (command === null) {
      return semanticFeedback("invalid-domain-transition", "$.work", "authority could not normalize workspace reservation command");
    }
    const known = commandKnown(prospective, command, stimulus);
    if (typeof known !== "boolean") {
      return known;
    }
    if (!known && !commands.some((existing) => existing.commandId === command.commandId)) {
      commands.push(command);
    }
  }
  const publish = publicationCommand(prospective);
  if (publish !== null) {
    const known = commandKnown(prospective, publish, stimulus);
    if (typeof known !== "boolean") {
      return known;
    }
    if (!known && !commands.some((existing) => existing.commandId === publish.commandId)) {
      commands.push(publish);
    }
  }
  return Object.freeze({ commands: Object.freeze(commands) });
}

void (deriveReaction satisfies ReactionSeam);
