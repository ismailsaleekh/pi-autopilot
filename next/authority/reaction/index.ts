import { evidenceSatisfies } from "../evidence/index.js";
import { foldDomainFact } from "../evolution/domain-fact-fold.js";
import type { RunState, WorkItemState } from "../model/run-state.js";
import { commandCapsule } from "../protocol/command.capsule.js";
import type { Command } from "../protocol/command.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import type { JsonValue } from "../protocol/schema.js";
import { canonicalDigestUnknown as digestCanonicalValue } from "../protocol/schema.js";
import type { WorkItem } from "../protocol/work-item.capsule.js";
import { readyWork } from "../scheduling/index.js";
import type { ReactionResult, ReactionSeam } from "../facade/seams.js";

const EMPTY_COMMANDS: readonly Command[] = Object.freeze([]);

type WorkOfKind<Kind extends WorkItem["kind"]> = Extract<WorkItem, { readonly kind: Kind }>;
type WorkReactionHandlers = {
  readonly [Kind in WorkItem["kind"]]: (
    state: RunState,
    entry: WorkItemState & { readonly workItem: WorkOfKind<Kind> },
  ) => readonly Command[];
};

function stateAfterFacts(
  state: RunState,
  facts: readonly DomainFact[],
): RunState | null {
  let candidate = state;
  for (const fact of facts) {
    const folded = foldDomainFact(candidate, fact);
    if (folded.kind === "rejected") {
      return null;
    }
    candidate = folded.state;
  }
  return candidate;
}

function identityDigest(value: JsonValue): string {
  return digestCanonicalValue(value).slice(7);
}

function actionId(
  port: string,
  runId: string,
  kind: string,
  inputs: JsonValue,
  preconditions: JsonValue,
): string {
  const digest = identityDigest(Object.freeze({
    domain: "pi-autopilot.action.v1",
    inputs,
    kind,
    port,
    preconditions,
    runId,
  }));
  return `action:sha256:${digest}`;
}

function commandId(kind: string, semanticIdentity: JsonValue): string {
  return `command:${kind}:sha256:${identityDigest(semanticIdentity)}`;
}

function workspaceId(entry: WorkItemState): string {
  return `workspace:sha256:${identityDigest(Object.freeze({
    domain: "pi-autopilot.workspace.v1",
    planRootId: entry.workItem.planRootId,
    runId: entry.workItem.runId,
    workItemId: entry.workItemId,
  }))}`;
}

function decodeCommand(candidate: JsonValue): Command | null {
  const decoded = commandCapsule.decode(candidate);
  return decoded.kind === "ok" ? decoded.value : null;
}

function prepareWorkspaceCommand(entry: WorkItemState): Command | null {
  const workspace = workspaceId(entry);
  const inputs = Object.freeze({
    baseRoot: entry.workItem.inputRoot,
    planRootId: entry.workItem.planRootId,
    workItemId: entry.workItemId,
    workspaceId: workspace,
  });
  const preconditions = Object.freeze({ inputRoot: entry.workItem.inputRoot });
  const derivedAction = actionId(
    "workspace",
    entry.workItem.runId,
    "prepare-workspace",
    inputs,
    preconditions,
  );
  return decodeCommand(Object.freeze({
    actionId: derivedAction,
    baseRoot: entry.workItem.inputRoot,
    commandId: commandId("prepare-workspace", Object.freeze({
      actionId: derivedAction,
      inputs,
      preconditions,
    })),
    kind: "prepare-workspace",
    planRootId: entry.workItem.planRootId,
    runId: entry.workItem.runId,
    workspaceId: workspace,
    workItemId: entry.workItemId,
  }));
}

function executeEvidenceCommand(
  work: WorkOfKind<"verify-candidate">,
  entry: WorkItemState,
): Command | null {
  const workspace = workspaceId(entry);
  const inputs = Object.freeze({
    candidateTree: work.candidateRoot,
    commandSpec: work.validationPlan,
    workItemId: work.workItemId,
    workspaceId: workspace,
  });
  const preconditions = Object.freeze({ planRootId: work.planRootId });
  const derivedAction = actionId(
    "child",
    work.runId,
    "execute-evidence",
    inputs,
    preconditions,
  );
  return decodeCommand(Object.freeze({
    actionId: derivedAction,
    candidateTree: work.candidateRoot,
    commandId: commandId("execute-evidence", Object.freeze({
      actionId: derivedAction,
      inputs,
      preconditions,
    })),
    commandSpec: work.validationPlan,
    kind: "execute-evidence",
    runId: work.runId,
    workItemId: work.workItemId,
    workspaceId: workspace,
  }));
}

function buildCandidateCommand(work: WorkOfKind<"integrate-candidate">): Command | null {
  const candidateId = `candidate:sha256:${identityDigest(Object.freeze({
    acceptedOutputs: work.acceptedOutputs,
    baseRoot: work.baseRoot,
    domain: "pi-autopilot.candidate.v1",
    planRootId: work.planRootId,
    runId: work.runId,
  }))}`;
  const inputs = Object.freeze({
    acceptedOutputs: work.acceptedOutputs,
    baseRoot: work.baseRoot,
    candidateId,
    planRootId: work.planRootId,
    workItemId: work.workItemId,
  });
  const preconditions = Object.freeze({ inputRoot: work.inputRoot });
  const derivedAction = actionId(
    "git",
    work.runId,
    "build-integrated-candidate",
    inputs,
    preconditions,
  );
  return decodeCommand(Object.freeze({
    acceptedOutputs: work.acceptedOutputs,
    actionId: derivedAction,
    baseRoot: work.baseRoot,
    candidateId,
    commandId: commandId("build-integrated-candidate", Object.freeze({
      actionId: derivedAction,
      inputs,
      preconditions,
    })),
    kind: "build-integrated-candidate",
    planRootId: work.planRootId,
    runId: work.runId,
    workItemId: work.workItemId,
  }));
}

function commandsWithPreparation(entry: WorkItemState): Command[] {
  const output: Command[] = [];
  const prepare = prepareWorkspaceCommand(entry);
  if (prepare !== null) {
    output.push(prepare);
  }
  return output;
}

function reactProduce(
  _state: RunState,
  entry: WorkItemState & { readonly workItem: WorkOfKind<"produce-artifact"> },
): readonly Command[] {
  return Object.freeze(commandsWithPreparation(entry));
}

function reactReview(
  _state: RunState,
  entry: WorkItemState & { readonly workItem: WorkOfKind<"review-artifact"> },
): readonly Command[] {
  return Object.freeze(commandsWithPreparation(entry));
}

function reactCorrection(
  _state: RunState,
  entry: WorkItemState & { readonly workItem: WorkOfKind<"correct-artifact"> },
): readonly Command[] {
  return Object.freeze(commandsWithPreparation(entry));
}

function reactIntegration(
  _state: RunState,
  entry: WorkItemState & { readonly workItem: WorkOfKind<"integrate-candidate"> },
): readonly Command[] {
  const output = commandsWithPreparation(entry);
  const build = buildCandidateCommand(entry.workItem);
  if (build !== null) {
    output.push(build);
  }
  return Object.freeze(output);
}

function reactVerification(
  _state: RunState,
  entry: WorkItemState & { readonly workItem: WorkOfKind<"verify-candidate"> },
): readonly Command[] {
  const output = commandsWithPreparation(entry);
  const evidence = executeEvidenceCommand(entry.workItem, entry);
  if (evidence !== null) {
    output.push(evidence);
  }
  return Object.freeze(output);
}

const workReactionHandlers = Object.freeze({
  "correct-artifact": reactCorrection,
  "integrate-candidate": reactIntegration,
  "produce-artifact": reactProduce,
  "review-artifact": reactReview,
  "verify-candidate": reactVerification,
}) satisfies WorkReactionHandlers;

function commandsForReadyWork(state: RunState, entry: WorkItemState): readonly Command[] {
  switch (entry.workItem.kind) {
    case "correct-artifact":
      return workReactionHandlers["correct-artifact"](state, Object.freeze({
        ...entry,
        workItem: entry.workItem,
      }));
    case "integrate-candidate":
      return workReactionHandlers["integrate-candidate"](state, Object.freeze({
        ...entry,
        workItem: entry.workItem,
      }));
    case "produce-artifact":
      return workReactionHandlers["produce-artifact"](state, Object.freeze({
        ...entry,
        workItem: entry.workItem,
      }));
    case "review-artifact":
      return workReactionHandlers["review-artifact"](state, Object.freeze({
        ...entry,
        workItem: entry.workItem,
      }));
    case "verify-candidate":
      return workReactionHandlers["verify-candidate"](state, Object.freeze({
        ...entry,
        workItem: entry.workItem,
      }));
  }
}

function candidateVerified(state: RunState, candidateId: string): boolean {
  const candidate = state.candidates.find((entry) => entry.candidateId === candidateId);
  if (candidate === undefined) {
    return false;
  }
  const verificationWork = state.workItems.filter((entry) => (
    entry.workItem.kind === "verify-candidate"
    && entry.workItem.planRootId === candidate.planRootId
    && entry.workItem.candidateRoot === candidate.tree
  ));
  return verificationWork.length > 0 && verificationWork.every((entry) => (
    evidenceSatisfies(state, Object.freeze({
      evidenceId: null,
      workItemId: entry.workItemId,
      tree: candidate.tree,
      kindId: null,
      output: null,
      requireSuccessfulExit: true,
    }))
  ));
}

function publicationCommand(state: RunState): Command | null {
  const publication = state.publications.find(
    (entry) => entry.publicationId === state.currentPublicationId,
  );
  if (
    publication === undefined
    || publication.observation !== null
    || !candidateVerified(state, publication.candidateId)
  ) {
    return null;
  }
  const candidate = state.candidates.find((entry) => entry.candidateId === publication.candidateId);
  if (candidate === undefined || candidate.planRootId !== state.currentPlanRootId) {
    return null;
  }
  const inputs = Object.freeze({
    candidateId: candidate.candidateId,
    candidateTree: candidate.tree,
    desiredHead: publication.desiredHead,
    publicationId: publication.publicationId,
  });
  const preconditions = Object.freeze({ expectedHead: publication.expectedHead });
  const derivedAction = actionId(
    "git",
    state.identity.runId,
    "publish-compare-and-swap",
    inputs,
    preconditions,
  );
  return decodeCommand(Object.freeze({
    actionId: derivedAction,
    candidateId: candidate.candidateId,
    candidateTree: candidate.tree,
    commandId: commandId("publish-compare-and-swap", Object.freeze({
      actionId: derivedAction,
      inputs,
      preconditions,
    })),
    desiredHead: publication.desiredHead,
    expectedHead: publication.expectedHead,
    kind: "publish-compare-and-swap",
    publicationId: publication.publicationId,
    runId: state.identity.runId,
  }));
}

function commandAlreadySettled(state: RunState, command: Command): boolean {
  return state.commandSettlements.some((settlement) => settlement.commandId === command.commandId);
}

/** Map prospective journal facts to deterministic physical effect intents only. */
export function deriveReaction(
  state: RunState,
  facts: readonly DomainFact[],
): ReactionResult {
  const candidateState = stateAfterFacts(state, facts);
  if (
    candidateState === null
    || candidateState.terminal !== null
    || candidateState.suspension.kind === "suspended"
  ) {
    return Object.freeze({ commands: EMPTY_COMMANDS });
  }
  const commands: Command[] = [];
  for (const entry of readyWork(candidateState)) {
    for (const command of commandsForReadyWork(candidateState, entry)) {
      if (
        !commandAlreadySettled(candidateState, command)
        && !commands.some((existing) => existing.commandId === command.commandId)
      ) {
        commands.push(command);
      }
    }
  }
  const publish = publicationCommand(candidateState);
  if (
    publish !== null
    && !commandAlreadySettled(candidateState, publish)
    && !commands.some((existing) => existing.commandId === publish.commandId)
  ) {
    commands.push(publish);
  }
  return Object.freeze({ commands: Object.freeze(commands) });
}

void (deriveReaction satisfies ReactionSeam);
