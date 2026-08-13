import { dispositionIsLegal } from "../protocol/atom.capsule.js";
import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import {
  decrementDecimalNatural,
  incrementDecimalNatural,
} from "../protocol/identifiers.js";
import type { Digest } from "../protocol/identifiers.js";
import { indexMutationDigest } from "../protocol/state-index.capsule.js";
import type {
  IndexMutation,
  IndexName,
  IndexValue,
  ResolvedIndexPage,
} from "../protocol/state-index.capsule.js";
import type { RunIndexes, RunState } from "../model/run-state.js";
import {
  applyIndexMutation,
  indexKey,
  lookupIndex,
  prepareIndexMutation,
} from "../model/authenticated-index.js";
import type { AuthenticatedIndexState } from "../model/authenticated-index.js";

export type DomainFactFoldResult =
  | {
      readonly kind: "applied";
      readonly state: RunState;
      readonly mutations: readonly IndexMutation[];
    }
  | { readonly kind: "rejected"; readonly state: RunState; readonly code: string; readonly diagnostic: string };

interface TransitionContext {
  readonly pages: readonly ResolvedIndexPage[];
  readonly supplied: readonly IndexMutation[] | null;
  readonly produced: IndexMutation[];
  cursor: number;
}

type NextValue =
  | { readonly kind: "next"; readonly value: IndexValue | null }
  | { readonly kind: "rejected"; readonly code: string; readonly diagnostic: string };

function rejected(state: RunState, code: string, diagnostic: string): DomainFactFoldResult {
  return Object.freeze({ kind: "rejected", state, code, diagnostic });
}

function indexOf(indexes: RunIndexes, name: IndexName): AuthenticatedIndexState {
  switch (name) {
    case "actions": return indexes.actions;
    case "atoms": return indexes.atoms;
    case "candidates": return indexes.candidates;
    case "commands": return indexes.commands;
    case "dependencies": return indexes.dependencies;
    case "dispositions": return indexes.dispositions;
    case "evidence": return indexes.evidence;
    case "findings": return indexes.findings;
    case "plans": return indexes.plans;
    case "publications": return indexes.publications;
    case "submissions": return indexes.submissions;
    case "work": return indexes.work;
  }
}

function replaceIndex(indexes: RunIndexes, name: IndexName, value: AuthenticatedIndexState): RunIndexes {
  switch (name) {
    case "actions": return Object.freeze({ ...indexes, actions: value });
    case "atoms": return Object.freeze({ ...indexes, atoms: value });
    case "candidates": return Object.freeze({ ...indexes, candidates: value });
    case "commands": return Object.freeze({ ...indexes, commands: value });
    case "dependencies": return Object.freeze({ ...indexes, dependencies: value });
    case "dispositions": return Object.freeze({ ...indexes, dispositions: value });
    case "evidence": return Object.freeze({ ...indexes, evidence: value });
    case "findings": return Object.freeze({ ...indexes, findings: value });
    case "plans": return Object.freeze({ ...indexes, plans: value });
    case "publications": return Object.freeze({ ...indexes, publications: value });
    case "submissions": return Object.freeze({ ...indexes, submissions: value });
    case "work": return Object.freeze({ ...indexes, work: value });
  }
}

function sameMutation(left: IndexMutation, right: IndexMutation): boolean {
  return indexMutationDigest(left) === indexMutationDigest(right);
}

function mutate(
  state: RunState,
  context: TransitionContext,
  name: IndexName,
  identity: string,
  deriveNext: (prior: IndexValue | null) => NextValue,
): DomainFactFoldResult {
  const index = indexOf(state.indexes, name);
  const key = indexKey(name, identity);
  const lookup = lookupIndex(index, key, context.pages);
  if (lookup.kind !== "proved") {
    return rejected(state, "page-unproven", lookup.diagnostic);
  }
  const next = deriveNext(lookup.value);
  if (next.kind === "rejected") {
    return rejected(state, next.code, next.diagnostic);
  }
  const prepared = prepareIndexMutation(index, key, next.value, context.pages);
  if (prepared.kind !== "prepared") {
    return rejected(state, "page-unproven", prepared.diagnostic);
  }
  const supplied = context.supplied?.[context.cursor];
  if (context.supplied !== null && (supplied === undefined || !sameMutation(supplied, prepared.mutation))) {
    return rejected(state, "index-mutation-mismatch", `mutation ${String(context.cursor)} does not match ${name}/${identity}`);
  }
  const mutation = supplied ?? prepared.mutation;
  const applied = applyIndexMutation(index, mutation, lookup.value, next.value);
  if (applied.kind !== "applied") {
    return rejected(state, "index-proof-invalid", applied.diagnostic);
  }
  context.produced.push(mutation);
  context.cursor += 1;
  return Object.freeze({
    kind: "applied",
    state: Object.freeze({ ...state, indexes: replaceIndex(state.indexes, name, applied.state) }),
    mutations: Object.freeze(context.produced.slice()),
  });
}

function lookupValue(
  state: RunState,
  pages: readonly ResolvedIndexPage[],
  name: IndexName,
  identity: string,
): IndexValue | null | "unproven" {
  const found = lookupIndex(indexOf(state.indexes, name), indexKey(name, identity), pages);
  return found.kind === "proved" ? found.value : "unproven";
}

function incrementCounter(state: RunState, name: keyof RunState["counters"]): RunState {
  return Object.freeze({
    ...state,
    counters: Object.freeze({
      ...state.counters,
      [name]: incrementDecimalNatural(state.counters[name]),
    }),
  });
}

function decrementCounter(state: RunState, name: keyof RunState["counters"]): RunState | null {
  const next = decrementDecimalNatural(state.counters[name]);
  return next === null
    ? null
    : Object.freeze({ ...state, counters: Object.freeze({ ...state.counters, [name]: next }) });
}

function blockingKind(kind: DomainFact extends never ? never : string): boolean {
  return kind === "integrity" || kind === "definition-of-done";
}

function applySemanticFact(
  state: RunState,
  fact: DomainFact,
  pages: readonly ResolvedIndexPage[],
  context: TransitionContext,
): DomainFactFoldResult {
  if (fact.runId !== state.identity.runId) {
    return rejected(state, "fact-run-mismatch", `${fact.kind} belongs to another run`);
  }
  switch (fact.kind) {
    case "requirements-bound": {
      if (state.requirements !== null || fact.taskRoot !== state.identity.taskSnapshot) {
        return rejected(state, "requirements-binding-invalid", "requirements may bind once and must name immutable task authority");
      }
      return Object.freeze({
        kind: "applied",
        state: Object.freeze({
          ...state,
          requirements: Object.freeze({
            sourceRoot: fact.sourceRoot,
            requirementsRoot: fact.requirementsRoot,
            taskRoot: fact.taskRoot,
            atomIndexRoot: state.indexes.atoms.root,
            declaredAtomCount: fact.declaredAtomCount,
            inventorySealed: false,
            inventoryEvidence: null,
          }),
        }),
        mutations: Object.freeze(context.produced.slice()),
      });
    }
    case "atom-declared": {
      if (state.requirements === null || state.requirements.inventorySealed || fact.atom.runId !== state.identity.runId) {
        return rejected(state, "atom-inventory-closed", "atoms require an open task-bound inventory");
      }
      const value: IndexValue = Object.freeze({ kind: "atom", atom: fact.atom });
      const transitioned = mutate(state, context, "atoms", fact.atom.atomId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value })
        : Object.freeze({ kind: "rejected", code: "duplicate-atom", diagnostic: `atom ${fact.atom.atomId} already exists` }));
      return transitioned.kind === "applied"
        ? Object.freeze({ ...transitioned, state: incrementCounter(transitioned.state, "declaredAtoms") })
        : transitioned;
    }
    case "atom-inventory-sealed": {
      if (
        state.requirements === null
        || state.requirements.inventorySealed
        || fact.atomIndexRoot !== state.indexes.atoms.root
        || fact.atomCount !== state.indexes.atoms.count
        || fact.atomCount !== state.requirements.declaredAtomCount
      ) {
        return rejected(state, "atom-inventory-unproven", "sealed atom root and count must equal the task-bound authenticated inventory");
      }
      return Object.freeze({
        kind: "applied",
        state: Object.freeze({
          ...state,
          requirements: Object.freeze({
            ...state.requirements,
            atomIndexRoot: fact.atomIndexRoot,
            inventorySealed: true,
            inventoryEvidence: fact.inventoryEvidence,
          }),
        }),
        mutations: Object.freeze(context.produced.slice()),
      });
    }
    case "atom-dispositioned": {
      if (state.requirements === null || !state.requirements.inventorySealed) {
        return rejected(state, "atom-inventory-unsealed", "dispositions require the immutable sealed atom inventory");
      }
      const atomValue = lookupValue(state, pages, "atoms", fact.disposition.atomId);
      if (atomValue === "unproven") {
        return rejected(state, "page-unproven", "atom membership page is missing");
      }
      if (atomValue === null || atomValue.kind !== "atom" || !dispositionIsLegal(atomValue.atom, fact.disposition)) {
        return rejected(state, "illegal-disposition", "disposition is not legal for the authoritative atom kind");
      }
      const value: IndexValue = Object.freeze({ kind: "disposition", disposition: fact.disposition });
      const transitioned = mutate(state, context, "dispositions", fact.disposition.atomId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value })
        : Object.freeze({ kind: "rejected", code: "duplicate-disposition", diagnostic: "atom already has a disposition" }));
      return transitioned.kind === "applied"
        ? Object.freeze({ ...transitioned, state: incrementCounter(transitioned.state, "dispositionedAtoms") })
        : transitioned;
    }
    case "work-declared": {
      if (fact.workItem.runId !== state.identity.runId || fact.workItem.taskRoot !== state.identity.taskSnapshot) {
        return rejected(state, "work-authority-mismatch", "work must bind the current run and immutable task root");
      }
      if (state.phase === "execution" && state.currentPlan?.planRootId !== fact.workItem.planRootId) {
        return rejected(state, "noncurrent-plan-consequence", "execution work must bind the current plan");
      }
      const value: IndexValue = Object.freeze({ kind: "work", workItem: fact.workItem, acceptedOutput: null });
      const transitioned = mutate(state, context, "work", fact.workItem.workItemId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value })
        : Object.freeze({ kind: "rejected", code: "duplicate-work-item", diagnostic: "work item already exists" }));
      return transitioned.kind === "applied"
        ? Object.freeze({ ...transitioned, state: incrementCounter(transitioned.state, "declaredWork") })
        : transitioned;
    }
    case "dependency-declared": {
      if (fact.dependency === fact.dependent) {
        return rejected(state, "dependency-cycle", "a work item cannot depend on itself");
      }
      const dependent = lookupValue(state, pages, "work", fact.dependent);
      const dependency = lookupValue(state, pages, "work", fact.dependency);
      if (dependent === "unproven" || dependency === "unproven") {
        return rejected(state, "page-unproven", "dependency endpoint page is missing");
      }
      if (
        dependent === null || dependent.kind !== "work"
        || dependency === null || dependency.kind !== "work"
        || dependent.workItem.planRootId !== fact.planRootId
        || dependency.workItem.planRootId !== fact.planRootId
      ) {
        return rejected(state, "dependency-endpoint-invalid", "dependency endpoints must be current-plan work");
      }
      const reverse = lookupValue(state, pages, "dependencies", `${fact.dependent}\u0000${fact.dependency}`);
      if (reverse === "unproven") {
        return rejected(state, "page-unproven", "dependency-cycle proof page is missing");
      }
      if (reverse !== null) {
        return rejected(state, "dependency-cycle", "dependency would close a cycle");
      }
      const value: IndexValue = Object.freeze({
        kind: "dependency",
        dependency: fact.dependency,
        dependent: fact.dependent,
        planRootId: fact.planRootId,
        runId: fact.runId,
      });
      return mutate(state, context, "dependencies", `${fact.dependency}\u0000${fact.dependent}`, (prior) => prior === null
        ? Object.freeze({ kind: "next", value })
        : Object.freeze({ kind: "rejected", code: "duplicate-dependency", diagnostic: "dependency edge already exists" }));
    }
    case "work-output-accepted": {
      if (state.currentPlan?.planRootId !== fact.planRootId) {
        return rejected(state, "noncurrent-plan-consequence", "accepted output must bind the current plan");
      }
      const acceptedOutput = Object.freeze({
        accountedDiff: fact.accountedDiff,
        evidence: fact.evidence,
        outputRoot: fact.outputRoot,
        submissionId: fact.submissionId,
      });
      const workTransition = mutate(state, context, "work", fact.workItemId, (prior) => {
        if (prior === null || prior.kind !== "work" || prior.workItem.inputRoot !== fact.inputRoot) {
          return Object.freeze({ kind: "rejected", code: "stale-work-input", diagnostic: "work input is absent or stale" });
        }
        if (prior.acceptedOutput !== null) {
          return Object.freeze({ kind: "rejected", code: "work-output-already-accepted", diagnostic: "work already has an accepted output" });
        }
        const value: IndexValue = Object.freeze({ ...prior, acceptedOutput });
        return Object.freeze({ kind: "next", value });
      });
      if (workTransition.kind !== "applied") {
        return workTransition;
      }
      const submissionValue: IndexValue = Object.freeze({
        kind: "submission",
        acceptedOutput,
        planRootId: fact.planRootId,
        runId: fact.runId,
        workItemId: fact.workItemId,
      });
      const submissionTransition = mutate(workTransition.state, context, "submissions", fact.submissionId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value: submissionValue })
        : Object.freeze({ kind: "rejected", code: "duplicate-submission", diagnostic: "submission already exists" }));
      return submissionTransition.kind === "applied"
        ? Object.freeze({ ...submissionTransition, state: incrementCounter(submissionTransition.state, "acceptedWork") })
        : submissionTransition;
    }
    case "plan-root-accepted": {
      if (state.phase !== "planning" || state.currentPlan !== null) {
        return rejected(state, "plan-phase-invalid", "an initial plan can be accepted only once during planning");
      }
      const author = lookupValue(state, pages, "work", fact.planAuthorWorkItemId);
      const integrator = lookupValue(state, pages, "work", fact.integrationOwnerWorkItemId);
      if (author === "unproven" || integrator === "unproven") {
        return rejected(state, "page-unproven", "plan owner page is missing");
      }
      if (author === null || author.kind !== "work" || integrator === null || integrator.kind !== "work") {
        return rejected(state, "plan-owner-unavailable", "plan author and integration owner must be declared work");
      }
      const value: IndexValue = Object.freeze({
        kind: "plan",
        coverageRoot: fact.coverageRoot,
        integrationOwnerWorkItemId: fact.integrationOwnerWorkItemId,
        planAuthorWorkItemId: fact.planAuthorWorkItemId,
        planRoot: fact.planRoot,
        planRootId: fact.planRootId,
        reviewedPlan: fact.reviewedPlan,
        runId: fact.runId,
        supersededBy: null,
      });
      const transitioned = mutate(state, context, "plans", fact.planRootId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value })
        : Object.freeze({ kind: "rejected", code: "duplicate-plan-root", diagnostic: "plan root already exists" }));
      return transitioned.kind === "applied"
        ? Object.freeze({
            ...transitioned,
            state: Object.freeze({
              ...transitioned.state,
              phase: "execution",
              currentPlan: Object.freeze({
                planRootId: fact.planRootId,
                planRoot: fact.planRoot,
                coverageRoot: fact.coverageRoot,
                reviewedPlan: fact.reviewedPlan,
                planAuthorWorkItemId: fact.planAuthorWorkItemId,
                integrationOwnerWorkItemId: fact.integrationOwnerWorkItemId,
              }),
            }),
          })
        : transitioned;
    }
    case "plan-root-superseded": {
      if (state.currentPlan?.planRootId !== fact.priorPlanRootId || fact.newPlanRootId === fact.priorPlanRootId) {
        return rejected(state, "noncurrent-plan-consequence", "only the current plan can be superseded by a distinct plan");
      }
      const target = lookupValue(state, pages, "plans", fact.newPlanRootId);
      if (target === "unproven") {
        return rejected(state, "page-unproven", "new-plan page is missing");
      }
      if (target === null || target.kind !== "plan" || target.supersededBy !== null) {
        return rejected(state, "supersession-cycle", "supersession target is absent or already superseded");
      }
      const priorTransition = mutate(state, context, "plans", fact.priorPlanRootId, (prior) => {
        if (prior === null || prior.kind !== "plan" || prior.supersededBy !== null) {
          return Object.freeze({ kind: "rejected", code: "supersession-cycle", diagnostic: "prior plan is absent or superseded" });
        }
        const value: IndexValue = Object.freeze({ ...prior, supersededBy: fact.newPlanRootId });
        return Object.freeze({ kind: "next", value });
      });
      return priorTransition.kind === "applied"
        ? Object.freeze({
            ...priorTransition,
            state: Object.freeze({
              ...priorTransition.state,
              currentPlan: Object.freeze({
                planRootId: target.planRootId,
                planRoot: target.planRoot,
                coverageRoot: target.coverageRoot,
                reviewedPlan: target.reviewedPlan,
                planAuthorWorkItemId: target.planAuthorWorkItemId,
                integrationOwnerWorkItemId: target.integrationOwnerWorkItemId,
              }),
              currentCandidate: null,
              currentPublication: null,
              finalAttestations: null,
            }),
          })
        : priorTransition;
    }
    case "finding-accepted": {
      const finding = fact.acceptance.finding;
      if (finding.runId !== state.identity.runId) {
        return rejected(state, "finding-run-mismatch", "finding belongs to another run");
      }
      const isBlocking = blockingKind(finding.kind);
      if (isBlocking !== (fact.acceptance.kind === "blocking-with-correction")) {
        return rejected(state, "correction-atomicity", "blocking findings require one atomic correction assignment and work item");
      }
      let current = state;
      let correctionWorkItemId = null;
      if (fact.acceptance.kind === "blocking-with-correction") {
        if (state.currentPlan === null || fact.acceptance.correction.work.planRootId !== state.currentPlan.planRootId) {
          return rejected(state, "corrector-unavailable", "correction work must bind the current plan");
        }
        const expectedOwner = finding.kind === "integrity" || finding.kind === "definition-of-done"
          ? finding.subjectWorkItemId ?? state.currentPlan.integrationOwnerWorkItemId
          : state.currentPlan.planAuthorWorkItemId;
        if (fact.acceptance.correction.originalOwnerWorkItemId !== expectedOwner) {
          return rejected(state, "corrector-unavailable", "correction owner is not authority-derived from the current finding subject");
        }
        const owner = lookupValue(state, pages, "work", expectedOwner);
        if (owner === "unproven") {
          return rejected(state, "page-unproven", "corrector page is missing");
        }
        if (owner === null || owner.kind !== "work") {
          return rejected(state, "corrector-unavailable", "current correction owner is not declared work");
        }
        const workValue: IndexValue = Object.freeze({
          kind: "work",
          workItem: fact.acceptance.correction.work,
          acceptedOutput: null,
        });
        const workTransition = mutate(current, context, "work", fact.acceptance.correction.correctorWorkItemId, (prior) => prior === null
          ? Object.freeze({ kind: "next", value: workValue })
          : Object.freeze({ kind: "rejected", code: "duplicate-work-item", diagnostic: "correction work already exists" }));
        if (workTransition.kind !== "applied") {
          return workTransition;
        }
        current = incrementCounter(workTransition.state, "declaredWork");
        correctionWorkItemId = fact.acceptance.correction.correctorWorkItemId;
      }
      const findingValue: IndexValue = Object.freeze({
        kind: "finding",
        finding,
        correctionWorkItemId,
        status: "open",
        resolution: null,
      });
      const findingTransition = mutate(current, context, "findings", finding.findingId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value: findingValue })
        : Object.freeze({ kind: "rejected", code: "duplicate-finding", diagnostic: "finding already exists" }));
      if (findingTransition.kind !== "applied") {
        return findingTransition;
      }
      if (isBlocking) {
        return Object.freeze({ ...findingTransition, state: incrementCounter(findingTransition.state, "openBlockingFindings") });
      }
      if (finding.kind === "advisory") {
        return Object.freeze({ ...findingTransition, state: incrementCounter(findingTransition.state, "openAdvisoryFindings") });
      }
      if (finding.kind === "planning-gap") {
        return Object.freeze({
          ...findingTransition,
          state: Object.freeze({ ...findingTransition.state, planningGap: finding }),
        });
      }
      return findingTransition;
    }
    case "finding-cleared": {
      const transition = mutate(state, context, "findings", fact.findingId, (prior) => {
        if (prior === null || prior.kind !== "finding" || prior.status !== "open") {
          return Object.freeze({ kind: "rejected", code: "finding-not-open", diagnostic: "finding is absent or already cleared" });
        }
        const value: IndexValue = Object.freeze({ ...prior, status: "cleared", resolution: fact.resolution });
        return Object.freeze({ kind: "next", value });
      });
      if (transition.kind !== "applied") {
        return transition;
      }
      const prior = lookupValue(state, pages, "findings", fact.findingId);
      if (prior === "unproven" || prior === null || prior.kind !== "finding") {
        return rejected(state, "page-unproven", "cleared finding page is missing");
      }
      const counter = blockingKind(prior.finding.kind) ? "openBlockingFindings" : prior.finding.kind === "advisory" ? "openAdvisoryFindings" : null;
      if (counter === null) {
        return transition;
      }
      const decremented = decrementCounter(transition.state, counter);
      return decremented === null
        ? rejected(state, "finding-counter-underflow", "finding counter cannot underflow")
        : Object.freeze({ ...transition, state: decremented });
    }
    case "evidence-observed": {
      if (fact.evidence.envelope.runId !== state.identity.runId) {
        return rejected(state, "evidence-run-mismatch", "evidence belongs to another run");
      }
      const value: IndexValue = Object.freeze({ kind: "evidence", evidence: fact.evidence });
      const transitioned = mutate(state, context, "evidence", fact.evidence.envelope.evidenceId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value })
        : Object.freeze({ kind: "rejected", code: "duplicate-evidence", diagnostic: "evidence already exists" }));
      return transitioned.kind === "applied"
        ? Object.freeze({ ...transitioned, state: incrementCounter(transitioned.state, "observedEvidence") })
        : transitioned;
    }
    case "route-verification-observed":
      return fact.observationId === fact.observation.observationId && fact.observation.route.channel === "subscription"
        ? Object.freeze({ kind: "applied", state, mutations: Object.freeze(context.produced.slice()) })
        : rejected(state, "route-attestation-mismatch", "route observation ID and subscription route must match");
    case "candidate-accepted": {
      if (state.currentPlan?.planRootId !== fact.planRootId) {
        return rejected(state, "noncurrent-plan-consequence", "candidate must bind the current plan");
      }
      const value: IndexValue = Object.freeze({
        kind: "candidate",
        candidateId: fact.candidateId,
        gitRevision: fact.gitRevision,
        gitTree: fact.gitTree,
        gitTreeCasAttestation: fact.gitTreeCasAttestation,
        manifest: fact.manifest,
        planRootId: fact.planRootId,
        reviewedDiff: fact.reviewedDiff,
        runId: fact.runId,
        tree: fact.tree,
      });
      const transitioned = mutate(state, context, "candidates", fact.candidateId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value })
        : Object.freeze({ kind: "rejected", code: "duplicate-candidate", diagnostic: "candidate already exists" }));
      return transitioned.kind === "applied"
        ? Object.freeze({
            ...transitioned,
            state: Object.freeze({
              ...transitioned.state,
              currentCandidate: Object.freeze({
                candidateId: fact.candidateId,
                planRootId: fact.planRootId,
                tree: fact.tree,
                gitRevision: fact.gitRevision,
                gitTree: fact.gitTree,
                manifest: fact.manifest,
                reviewedDiff: fact.reviewedDiff,
                gitTreeCasAttestation: fact.gitTreeCasAttestation,
              }),
              finalAttestations: null,
            }),
          })
        : transitioned;
    }
    case "publication-intended": {
      if (state.currentCandidate?.candidateId !== fact.candidateId || fact.repository !== state.identity.repository || fact.publicationRef !== state.identity.publicationRef) {
        return rejected(state, "publication-candidate-mismatch", "publication must bind the current candidate and genesis repository/ref");
      }
      const value: IndexValue = Object.freeze({
        kind: "publication",
        candidateId: fact.candidateId,
        desiredHead: fact.desiredHead,
        expected: fact.expected,
        observedHead: null,
        publicationId: fact.publicationId,
        publicationTreeAttestation: null,
        runId: fact.runId,
        status: "intended",
      });
      const transitioned = mutate(state, context, "publications", fact.publicationId, (prior) => prior === null
        ? Object.freeze({ kind: "next", value })
        : Object.freeze({ kind: "rejected", code: "duplicate-publication", diagnostic: "publication already exists" }));
      return transitioned.kind === "applied"
        ? Object.freeze({
            ...transitioned,
            state: Object.freeze({
              ...transitioned.state,
              currentPublication: Object.freeze({
                publicationId: fact.publicationId,
                candidateId: fact.candidateId,
                repository: fact.repository,
                publicationRef: fact.publicationRef,
                expected: fact.expected,
                desiredHead: fact.desiredHead,
                status: "intended",
                observedHead: null,
                tree: null,
                gitTree: null,
                publicationTreeAttestation: null,
              }),
            }),
          })
        : transitioned;
    }
    case "publication-observed": {
      if (state.currentPublication?.publicationId !== fact.publicationId || state.currentCandidate === null) {
        return rejected(state, "publication-not-current", "publication observation is stale");
      }
      if (fact.tree !== state.currentCandidate.tree || fact.gitTree !== state.currentCandidate.gitTree) {
        return rejected(state, "publication-tree-mismatch", "publication tree must equal the exact current Git/CAS candidate");
      }
      if ((fact.status === "desired-head" && fact.observedHead !== state.currentPublication.desiredHead) || (fact.status === "head-moved" && fact.observedHead === state.currentPublication.desiredHead)) {
        return rejected(state, "publication-status-mismatch", "publication status and observed head disagree");
      }
      const transitioned = mutate(state, context, "publications", fact.publicationId, (prior) => {
        if (prior === null || prior.kind !== "publication" || prior.status !== "intended") {
          return Object.freeze({ kind: "rejected", code: "publication-not-current", diagnostic: "publication is absent or already observed" });
        }
        const value: IndexValue = Object.freeze({
          ...prior,
          observedHead: fact.observedHead,
          publicationTreeAttestation: fact.publicationTreeAttestation,
          status: fact.status,
        });
        return Object.freeze({ kind: "next", value });
      });
      return transitioned.kind === "applied"
        ? Object.freeze({
            ...transitioned,
            state: Object.freeze({
              ...transitioned.state,
              currentPublication: Object.freeze({
                ...state.currentPublication,
                observedHead: fact.observedHead,
                status: fact.status,
                tree: fact.tree,
                gitTree: fact.gitTree,
                publicationTreeAttestation: fact.publicationTreeAttestation,
              }),
              finalAttestations: fact.status === "head-moved" ? null : state.finalAttestations,
            }),
          })
        : transitioned;
    }
    case "final-attestations-recorded": {
      if (
        state.currentCandidate?.candidateId !== fact.candidateId
        || state.currentPublication?.publicationId !== fact.publicationId
        || fact.evidenceIndexRoot !== state.indexes.evidence.root
      ) {
        return rejected(state, "final-attestation-stale", "final attestations must bind current candidate, publication, and evidence index");
      }
      return Object.freeze({
        kind: "applied",
        state: Object.freeze({
          ...state,
          finalAttestations: Object.freeze({
            candidateId: fact.candidateId,
            publicationId: fact.publicationId,
            c1ToC7Proof: fact.c1ToC7Proof,
            finalManifest: fact.finalManifest,
            evidenceIndexRoot: fact.evidenceIndexRoot,
            finalVerificationEvidence: fact.finalVerificationEvidence,
            advisoryDisclosures: fact.advisoryDisclosures,
          }),
        }),
        mutations: Object.freeze(context.produced.slice()),
      });
    }
  }
}

/**
 * Applies one fact with authenticated index mutations. With `supplied=null` it
 * prepares the exact mutations; replay passes the committed mutations and gets
 * the same transition or a typed rejection.
 */
export function foldDomainFact(
  state: RunState,
  fact: DomainFact,
  pages: readonly ResolvedIndexPage[] = Object.freeze([]),
  supplied: readonly IndexMutation[] | null = null,
): DomainFactFoldResult {
  const context: TransitionContext = {
    pages,
    supplied,
    produced: [],
    cursor: 0,
  };
  const result = applySemanticFact(state, fact, pages, context);
  if (result.kind === "rejected") {
    return result;
  }
  if (supplied !== null && context.cursor !== supplied.length) {
    return rejected(state, "unexpected-index-mutation", "record carries mutations not consumed by the fact transition");
  }
  return Object.freeze({ kind: "applied", state: result.state, mutations: Object.freeze(context.produced) });
}
