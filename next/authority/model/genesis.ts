import type { RunGenesis } from "../protocol/journal-record.capsule.js";
import { zeroDecimalNatural } from "../protocol/identifiers.js";
import { initialAuthenticatedIndex } from "./authenticated-index.js";
import type { RunState } from "./run-state.js";

/** Build the sole bounded genesis state from the decoded journal genesis. */
export function initialState(genesis: RunGenesis): RunState {
  const initialCount = zeroDecimalNatural();
  return Object.freeze({
    identity: Object.freeze({
      runId: genesis.runId,
      taskSnapshot: genesis.taskSnapshot,
      repository: genesis.repository,
      repositoryBase: genesis.repositoryBase,
      repositoryTree: genesis.repositoryTree,
      publicationRef: genesis.publicationRef,
      expectedPublication: genesis.expectedPublication,
      policyRoot: genesis.policyRoot,
      runtimeRoot: genesis.runtimeRoot,
      route: genesis.route,
    }),
    phase: "planning",
    lastSequence: genesis.sequence,
    requirements: null,
    currentPlan: null,
    currentCandidate: null,
    currentPublication: null,
    finalAttestations: null,
    planningGap: null,
    counters: Object.freeze({
      declaredAtoms: initialCount,
      dispositionedAtoms: initialCount,
      declaredWork: initialCount,
      acceptedWork: initialCount,
      openBlockingFindings: initialCount,
      openAdvisoryFindings: initialCount,
      observedEvidence: initialCount,
    }),
    indexes: Object.freeze({
      actions: initialAuthenticatedIndex("actions"),
      atoms: initialAuthenticatedIndex("atoms"),
      candidates: initialAuthenticatedIndex("candidates"),
      commands: initialAuthenticatedIndex("commands"),
      dependencies: initialAuthenticatedIndex("dependencies"),
      dispositions: initialAuthenticatedIndex("dispositions"),
      evidence: initialAuthenticatedIndex("evidence"),
      findings: initialAuthenticatedIndex("findings"),
      plans: initialAuthenticatedIndex("plans"),
      publications: initialAuthenticatedIndex("publications"),
      submissions: initialAuthenticatedIndex("submissions"),
      work: initialAuthenticatedIndex("work"),
    }),
    suspension: Object.freeze({ kind: "active" }),
    terminal: null,
  });
}
