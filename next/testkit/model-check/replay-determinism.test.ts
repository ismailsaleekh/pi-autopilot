import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fold,
  foldAll,
  foldDomainFact,
} from "../../authority/evolution/index.js";
import type {
  FoldInput,
  FoldResult,
} from "../../authority/evolution/index.js";
import { initialState, stateDigest } from "../../authority/model/index.js";
import type { RunState } from "../../authority/model/index.js";
import {
  commandCapsule,
  domainFactCapsule,
  journalRecordCapsule,
  stimulusCapsule,
} from "../../authority/protocol/aggregate.generated.js";
import type { DomainFact } from "../../authority/protocol/domain-fact.capsule.js";
import { canonicalDecisionFactsDigest } from "../../authority/protocol/journal-record.capsule.js";
import type {
  DecisionCommitted,
  RunGenesis,
} from "../../authority/protocol/journal-record.capsule.js";
import { terminalOutcomeCapsule } from "../../authority/protocol/terminal-outcome.capsule.js";
import type { TerminalOutcome } from "../../authority/protocol/terminal-outcome.capsule.js";
import { prepare, project } from "../../authority/facade/index.js";
import { prepareWithSeams } from "../../authority/facade/prepare.js";
import type { SemanticSeams } from "../../authority/facade/seams.js";

function genesis(seed: number): RunGenesis {
  const generated = journalRecordCapsule.arbitrary.validForKind("run-genesis", seed);
  if (generated.kind !== "run-genesis") {
    return genesis(seed + 1);
  }
  return generated;
}

function requirementsFact(seed: number, runId: RunGenesis["runId"]): Extract<DomainFact, { readonly kind: "requirements-bound" }> {
  const generated = domainFactCapsule.arbitrary.validForKind("requirements-bound", seed);
  if (generated.kind !== "requirements-bound") {
    return requirementsFact(seed + 1, runId);
  }
  return Object.freeze({ ...generated, runId });
}

function workFact(seed: number, runId: RunGenesis["runId"]): Extract<DomainFact, { readonly kind: "work-declared" }> {
  const generated = domainFactCapsule.arbitrary.validForKind("work-declared", seed);
  if (generated.kind !== "work-declared") {
    return workFact(seed + 1, runId);
  }
  return Object.freeze({ ...generated, runId });
}

function planFact(seed: number, runId: RunGenesis["runId"]): Extract<DomainFact, { readonly kind: "plan-root-accepted" }> {
  const generated = domainFactCapsule.arbitrary.validForKind("plan-root-accepted", seed);
  if (generated.kind !== "plan-root-accepted") {
    return planFact(seed + 1, runId);
  }
  return Object.freeze({ ...generated, runId });
}

function committedDecision(
  state: RunState,
  sequence: number,
  facts: readonly DomainFact[],
  seed: number,
): DecisionCommitted {
  const generated = journalRecordCapsule.arbitrary.validForKind("decision-committed", seed);
  if (generated.kind !== "decision-committed") {
    return committedDecision(state, sequence, facts, seed + 1);
  }
  const decoded = journalRecordCapsule.decode({
    ...generated,
    runId: state.identity.runId,
    sequence,
    facts,
    factRoot: canonicalDecisionFactsDigest(facts),
  });
  if (decoded.kind === "ok" && decoded.value.kind === "decision-committed") {
    return decoded.value;
  }
  return committedDecision(state, sequence, facts, seed + 1);
}

function appliedState(result: FoldResult): RunState {
  assert.equal(result.kind, "applied");
  return result.state;
}

function appliedFactState(state: RunState, domainFact: DomainFact): RunState {
  const result = foldDomainFact(state, domainFact);
  assert.equal(result.kind, "applied");
  return result.state;
}

function replayFixture(seed: number): {
  readonly genesis: RunGenesis;
  readonly records: readonly FoldInput[];
} {
  const runGenesis = genesis(seed);
  let state = initialState(runGenesis);
  const requirements = requirementsFact(seed + 10, runGenesis.runId);
  const first = committedDecision(state, state.lastSequence + 1, [requirements], seed + 20);
  state = appliedState(fold(state, first));
  const work = workFact(seed + 30, runGenesis.runId);
  const normalizedWork = Object.freeze({
    ...work,
    workItem: Object.freeze({ ...work.workItem, runId: runGenesis.runId }),
  });
  const second = committedDecision(state, state.lastSequence + 1, [normalizedWork], seed + 40);
  return Object.freeze({
    genesis: runGenesis,
    records: Object.freeze([first, second]),
  });
}

for (let seed = 0; seed < 32; seed += 1) {
  test(`identical replay has one digest seed=${String(seed)}`, () => {
    const fixture = replayFixture(seed);
    const left = foldAll(fixture.genesis, fixture.records);
    const right = foldAll(fixture.genesis, fixture.records);
    assert.equal(left.kind, "applied");
    assert.equal(right.kind, "applied");
    assert.equal(stateDigest(left.state), stateDigest(right.state));
  });
}

test("state digest is byte-stable across separate processes", () => {
  const helper = fileURLToPath(new URL("./replay-digest-process.js", import.meta.url));
  const runs = [
    Object.freeze({ locale: "C", timezone: "UTC" }),
    Object.freeze({ locale: "en_US.UTF-8", timezone: "Pacific/Honolulu" }),
    Object.freeze({ locale: "tr_TR.UTF-8", timezone: "Asia/Tokyo" }),
  ];
  const digests = runs.map(({ locale, timezone }) => {
    const child = spawnSync(process.execPath, [helper, "901"], {
      encoding: "utf8",
      env: Object.freeze({ ...process.env, LANG: locale, LC_ALL: locale, TZ: timezone }),
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  });
  assert.equal(new Set(digests).size, 1);
  assert.match(digests[0] ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("fold order is deliberately sensitive through sequence and current pointers", () => {
  const runGenesis = genesis(2000);
  const state = initialState(runGenesis);
  const planA = planFact(2001, runGenesis.runId);
  const planB = planFact(2002, runGenesis.runId);
  const forward = foldAll(runGenesis, [
    committedDecision(state, state.lastSequence + 1, [planA, planB], 2003),
  ]);
  const reverse = foldAll(runGenesis, [
    committedDecision(state, state.lastSequence + 1, [planB, planA], 2004),
  ]);
  assert.equal(forward.kind, "applied");
  assert.equal(reverse.kind, "applied");
  assert.notEqual(forward.state.currentPlanRootId, reverse.state.currentPlanRootId);
  assert.notEqual(stateDigest(forward.state), stateDigest(reverse.state));
});

test("sequence duplicates, stale records, and gaps are typed and inert", () => {
  const runGenesis = genesis(3000);
  const state = initialState(runGenesis);
  const duplicate = journalRecordCapsule.arbitrary.validForKind("run-suspended", 3001);
  const duplicateResult = fold(state, Object.freeze({
    ...duplicate,
    runId: runGenesis.runId,
    sequence: state.lastSequence,
  }));
  assert.equal(duplicateResult.kind, "rejected");
  assert.equal(duplicateResult.error.code, "duplicate-sequence");
  assert.equal(duplicateResult.state, state);

  const gapResult = fold(state, Object.freeze({
    ...duplicate,
    runId: runGenesis.runId,
    sequence: state.lastSequence + 2,
  }));
  assert.equal(gapResult.kind, "rejected");
  assert.equal(gapResult.error.code, "sequence-gap");
  assert.equal(gapResult.state, state);
});

test("duplicate action IDs are rejected after sequence validation", () => {
  const runGenesis = genesis(3250);
  const state = initialState(runGenesis);
  const firstRecord = journalRecordCapsule.arbitrary.validForKind("run-suspended", 3251);
  assert.equal(firstRecord.kind, "run-suspended");
  if (firstRecord.kind !== "run-suspended") {
    return;
  }
  const first = appliedState(fold(state, Object.freeze({
    ...firstRecord,
    runId: runGenesis.runId,
    sequence: state.lastSequence + 1,
  })));
  const secondRecord = journalRecordCapsule.arbitrary.validForKind("run-resumed", 3252);
  assert.equal(secondRecord.kind, "run-resumed");
  if (secondRecord.kind !== "run-resumed") {
    return;
  }
  const duplicate = fold(first, Object.freeze({
    ...secondRecord,
    actionId: firstRecord.actionId,
    runId: runGenesis.runId,
    sequence: first.lastSequence + 1,
  }));
  assert.equal(duplicate.kind, "rejected");
  assert.equal(duplicate.error.code, "duplicate-action");
  assert.equal(duplicate.state, first);
});

test("embedded decision facts take the real fold path and a factRoot mismatch is typed and inert", () => {
  const runGenesis = genesis(3500);
  const state = initialState(runGenesis);
  const fact = requirementsFact(3501, runGenesis.runId);
  const record = committedDecision(state, state.lastSequence + 1, [fact], 3502);
  const result = fold(state, record);
  assert.equal(result.kind, "applied");
  assert.equal(result.state.requirements?.requirementsRoot, fact.requirementsRoot);

  assert.notEqual(record.commandRoot, record.factRoot);
  const mismatch = fold(state, Object.freeze({ ...record, factRoot: record.commandRoot }));
  assert.equal(mismatch.kind, "rejected");
  assert.equal(mismatch.error.code, "decision-fact-root-mismatch");
  assert.equal(mismatch.state, state);
});

test("every record after terminal is rejected and state-identical", () => {
  const runGenesis = genesis(4000);
  const state = initialState(runGenesis);
  const terminalRecord = journalRecordCapsule.arbitrary.validForKind("outcome-committed", 4001);
  const terminal = appliedState(fold(state, Object.freeze({
    ...terminalRecord,
    runId: runGenesis.runId,
    sequence: state.lastSequence + 1,
  })));
  for (const kind of journalRecordCapsule.kinds) {
    const arbitrary = journalRecordCapsule.arbitrary.validForKind(kind, 4100 + kind.length);
    const result = fold(terminal, Object.freeze({
      ...arbitrary,
      runId: runGenesis.runId,
      sequence: terminal.lastSequence + 1,
    }));
    assert.equal(result.kind, "rejected");
    assert.equal(result.error.code, "post-terminal");
    assert.equal(result.state, terminal);
    assert.equal(stateDigest(result.state), stateDigest(terminal));
  }
});

test("prepare validates shape and exhaustively dispatches every wired admission seam", () => {
  const runGenesis = genesis(4750);
  const state = initialState(runGenesis);
  for (const kind of stimulusCapsule.kinds) {
    const stimulus = stimulusCapsule.arbitrary.validForKind(kind, 4750 + kind.length);
    const first = prepare(state, stimulus);
    const second = prepare(state, stimulus);
    assert.deepEqual(first, second);
    if (first.kind === "feedback") {
      assert.notEqual(first.code, "admission-not-implemented");
    }
  }
  const malformed = prepare(state, Object.freeze({ kind: "not-a-stimulus" }));
  assert.equal(malformed.kind, "feedback");
  if (malformed.kind === "feedback") {
    assert.equal(malformed.code, "invalid-stimulus");
  }
});

test("accepted preparation preserves exact semantic values without caller aliases", () => {
  const runGenesis = genesis(4900);
  const state = initialState(runGenesis);
  const stimulusValue = stimulusCapsule.arbitrary.validForKind("boundary-request-received", 4901);
  const factValue = domainFactCapsule.arbitrary.validForKind("requirements-bound", 4902);
  const commandValue = commandCapsule.arbitrary.validForKind("prepare-workspace", 4903);
  if (
    stimulusValue.kind !== "boundary-request-received"
    || factValue.kind !== "requirements-bound"
    || commandValue.kind !== "prepare-workspace"
  ) {
    assert.fail("W0 arbitrary returned a different protocol kind");
  }
  const stimulus = Object.freeze({ ...stimulusValue, runId: runGenesis.runId });
  const mutableFacts = [Object.freeze({ ...factValue, runId: runGenesis.runId })];
  const mutableCommands = [Object.freeze({ ...commandValue, runId: runGenesis.runId })];
  const boundDecision = committedDecision(state, state.lastSequence + 1, mutableFacts, 4904);
  const proposed = Object.freeze({ kind: "proposed-facts" as const, facts: mutableFacts });
  const assemble: SemanticSeams["assemble"] = (
    _state,
    _stimulus,
    acceptedFacts,
    acceptedCommands,
    outcome,
  ) => {
    void acceptedFacts;
    void acceptedCommands;
    void outcome;
    return Object.freeze({
      kind: "prepared-semantic-roots",
      factRoot: boundDecision.factRoot,
      commandRoot: commandValue.baseRoot,
      stimulusDigest: journalRecordCapsule.digest(boundDecision),
    });
  };
  const seams = Object.freeze({
    admission: Object.freeze({
      "boundary-request-received"() { return proposed; },
      "command-observation-received"() { return proposed; },
      "operator-resume-requested"() { return proposed; },
      "operator-suspend-requested"() { return proposed; },
      "run-replay-completed"() { return proposed; },
      "submission-ready"() { return proposed; },
    }),
    reaction() { return Object.freeze({ commands: mutableCommands }); },
    outcome() { return null; },
    assemble,
  }) satisfies SemanticSeams;
  const result = prepareWithSeams(state, stimulus, seams);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }
  assert.notEqual(result.batch.facts, mutableFacts);
  assert.notEqual(result.batch.commands, mutableCommands);
  assert.notEqual(result.batch.facts[0], mutableFacts[0]);
  assert.notEqual(result.batch.commands[0], mutableCommands[0]);
  mutableFacts.length = 0;
  mutableCommands.length = 0;
  assert.equal(result.batch.facts.length, 1);
  assert.equal(result.batch.commands.length, 1);
  assert.equal(result.batch.outcome, null);
  assert.equal(result.batch.factRoot, boundDecision.factRoot);
  assert.equal(result.batch.commandRoot, commandValue.baseRoot);
  assert.equal(result.batch.stateDigest, stateDigest(state));
});

test("facade rejects a schema-valid but impossible fact batch before mint", () => {
  const runGenesis = genesis(4950);
  const state = initialState(runGenesis);
  const stimulusValue = stimulusCapsule.arbitrary.validForKind("submission-ready", 4951);
  const impossible = domainFactCapsule.arbitrary.validForKind("submission-bound", 4952);
  if (stimulusValue.kind !== "submission-ready" || impossible.kind !== "submission-bound") {
    assert.fail("W0 arbitrary returned a different protocol kind");
  }
  const fact = Object.freeze({ ...impossible, runId: runGenesis.runId });
  const proposed = Object.freeze({ kind: "proposed-facts" as const, facts: Object.freeze([fact]) });
  const bound = committedDecision(state, state.lastSequence + 1, [fact], 4953);
  const seams = Object.freeze({
    admission: Object.freeze({
      "boundary-request-received"() { return proposed; },
      "command-observation-received"() { return proposed; },
      "operator-resume-requested"() { return proposed; },
      "operator-suspend-requested"() { return proposed; },
      "run-replay-completed"() { return proposed; },
      "submission-ready"() { return proposed; },
    }),
    reaction() { return Object.freeze({ commands: Object.freeze([]) }); },
    outcome() { return null; },
    assemble() {
      return Object.freeze({
        kind: "prepared-semantic-roots",
        factRoot: bound.factRoot,
        commandRoot: impossible.inputRoot,
        stimulusDigest: journalRecordCapsule.digest(runGenesis),
      });
    },
  }) satisfies SemanticSeams;
  const result = prepareWithSeams(state, stimulusValue, seams);
  assert.equal(result.kind, "feedback");
  if (result.kind === "feedback") {
    assert.equal(result.code, "invalid-domain-transition");
  }
});

test("lifecycle rejects invalid resume and execution-phase T2 without advancing state", () => {
  const runGenesis = genesis(4970);
  const state = initialState(runGenesis);
  const resume = journalRecordCapsule.arbitrary.validForKind("run-resumed", 4971);
  const resumeWhileActive = fold(state, Object.freeze({
    ...resume,
    runId: runGenesis.runId,
    sequence: state.lastSequence + 1,
  }));
  assert.equal(resumeWhileActive.kind, "rejected");
  assert.equal(resumeWhileActive.error.code, "not-suspended");
  assert.equal(resumeWhileActive.state, state);

  const plan = planFact(4972, runGenesis.runId);
  const execution = appliedState(fold(state, committedDecision(
    state,
    state.lastSequence + 1,
    [plan],
    4973,
  )));
  const outcome = journalRecordCapsule.arbitrary.validForKind("outcome-committed", 4974);
  if (outcome.kind !== "outcome-committed") {
    assert.fail("W0 arbitrary returned a different journal kind");
  }
  const t2 = terminalOutcomeCapsule.arbitrary.validForKind("t2", 4975);
  if (t2.kind !== "t2") {
    assert.fail("W0 arbitrary returned a different outcome kind");
  }
  const invalidT2 = fold(execution, Object.freeze({
    ...outcome,
    runId: runGenesis.runId,
    sequence: execution.lastSequence + 1,
    outcome: t2,
  }));
  assert.equal(invalidT2.kind, "rejected");
  assert.equal(invalidT2.error.code, "planning-outcome-after-planning");
  assert.equal(invalidT2.state, execution);
});

test("projection cannot affect a subsequent fold", () => {
  const fixture = replayFixture(5000);
  const replayed = foldAll(fixture.genesis, fixture.records);
  assert.equal(replayed.kind, "applied");
  const before = stateDigest(replayed.state);
  const view = project(replayed.state);
  assert.equal(stateDigest(replayed.state), before);
  assert.equal(view.runId, replayed.state.identity.runId);

  const suspension = journalRecordCapsule.arbitrary.validForKind("run-suspended", 5001);
  const nextRecord = Object.freeze({
    ...suspension,
    runId: replayed.state.identity.runId,
    sequence: replayed.state.lastSequence + 1,
  });
  const withoutProjection = fold(replayed.state, nextRecord);
  const afterProjection = fold(replayed.state, nextRecord);
  assert.equal(withoutProjection.kind, "applied");
  assert.equal(afterProjection.kind, "applied");
  assert.equal(stateDigest(withoutProjection.state), stateDigest(afterProjection.state));
});

for (let seed = 0; seed < 64; seed += 1) {
  test(`genesis digest stability seed=${String(seed)}`, () => {
    const runGenesis = genesis(6000 + seed);
    const left = stateDigest(initialState(runGenesis));
    const right = stateDigest(initialState(runGenesis));
    assert.equal(left, right);
  });
}

test("all twelve DomainFact kinds perform reference-only bookkeeping", () => {
  const runGenesis = genesis(6800);
  let state = initialState(runGenesis);

  const requirements = domainFactCapsule.arbitrary.validForKind("requirements-bound", 6801);
  const work = domainFactCapsule.arbitrary.validForKind("work-declared", 6802);
  const oldPlan = domainFactCapsule.arbitrary.validForKind("plan-root-accepted", 6803);
  const submission = domainFactCapsule.arbitrary.validForKind("submission-bound", 6804);
  const newPlan = domainFactCapsule.arbitrary.validForKind("plan-root-accepted", 6805);
  const coverage = domainFactCapsule.arbitrary.validForKind("coverage-linked", 6806);
  const raised = domainFactCapsule.arbitrary.validForKind("finding-raised", 6807);
  const cleared = domainFactCapsule.arbitrary.validForKind("finding-cleared", 6808);
  const evidence = domainFactCapsule.arbitrary.validForKind("evidence-observed", 6809);
  const candidate = domainFactCapsule.arbitrary.validForKind("candidate-accepted", 6810);
  const intended = domainFactCapsule.arbitrary.validForKind("publication-intended", 6811);
  const observed = domainFactCapsule.arbitrary.validForKind("publication-observed", 6812);
  const superseded = domainFactCapsule.arbitrary.validForKind("plan-root-superseded", 6813);
  if (
    requirements.kind !== "requirements-bound"
    || work.kind !== "work-declared"
    || oldPlan.kind !== "plan-root-accepted"
    || submission.kind !== "submission-bound"
    || newPlan.kind !== "plan-root-accepted"
    || coverage.kind !== "coverage-linked"
    || raised.kind !== "finding-raised"
    || cleared.kind !== "finding-cleared"
    || evidence.kind !== "evidence-observed"
    || candidate.kind !== "candidate-accepted"
    || intended.kind !== "publication-intended"
    || observed.kind !== "publication-observed"
    || superseded.kind !== "plan-root-superseded"
  ) {
    assert.fail("W0 arbitrary returned a different fact kind");
  }

  state = appliedFactState(state, Object.freeze({ ...requirements, runId: runGenesis.runId }));
  const normalizedWork = Object.freeze({
    ...work,
    runId: runGenesis.runId,
    workItem: Object.freeze({
      ...work.workItem,
      runId: runGenesis.runId,
      planRootId: oldPlan.planRootId,
    }),
  });
  state = appliedFactState(state, normalizedWork);
  const normalizedOldPlan = Object.freeze({ ...oldPlan, runId: runGenesis.runId });
  state = appliedFactState(state, normalizedOldPlan);
  state = appliedFactState(state, Object.freeze({
    ...submission,
    runId: runGenesis.runId,
    workItemId: normalizedWork.workItem.workItemId,
    planRootId: normalizedOldPlan.planRootId,
  }));
  const normalizedNewPlan = Object.freeze({ ...newPlan, runId: runGenesis.runId });
  state = appliedFactState(state, normalizedNewPlan);
  state = appliedFactState(state, Object.freeze({
    ...coverage,
    runId: runGenesis.runId,
    workItemId: normalizedWork.workItem.workItemId,
    planRootId: normalizedOldPlan.planRootId,
  }));
  const normalizedRaised = Object.freeze({
    ...raised,
    runId: runGenesis.runId,
    finding: raised.finding.kind === "planning-gap"
      ? Object.freeze({
          ...raised.finding,
          runId: runGenesis.runId,
          planAuthorWorkItemId: normalizedWork.workItem.workItemId,
          planRootId: normalizedNewPlan.planRootId,
        })
      : raised.finding.kind === "advisory"
        ? Object.freeze({
            ...raised.finding,
            runId: runGenesis.runId,
            raisedByWorkItemId: normalizedWork.workItem.workItemId,
          })
        : Object.freeze({
            ...raised.finding,
            runId: runGenesis.runId,
            correctionOwner: normalizedWork.workItem.workItemId,
          }),
  });
  state = appliedFactState(state, normalizedRaised);
  state = appliedFactState(state, Object.freeze({
    ...cleared,
    runId: runGenesis.runId,
    findingId: normalizedRaised.finding.findingId,
  }));
  state = appliedFactState(state, Object.freeze({
    ...evidence,
    runId: runGenesis.runId,
    evidence: Object.freeze({
      ...evidence.evidence,
      envelope: Object.freeze({
        ...evidence.evidence.envelope,
        runId: runGenesis.runId,
        workItemId: normalizedWork.workItem.workItemId,
      }),
    }),
  }));
  const normalizedCandidate = Object.freeze({
    ...candidate,
    runId: runGenesis.runId,
    planRootId: normalizedNewPlan.planRootId,
  });
  state = appliedFactState(state, normalizedCandidate);
  const normalizedIntended = Object.freeze({
    ...intended,
    runId: runGenesis.runId,
    candidateId: normalizedCandidate.candidateId,
  });
  state = appliedFactState(state, normalizedIntended);
  const normalizedObserved = Object.freeze({
    ...observed,
    runId: runGenesis.runId,
    publicationId: normalizedIntended.publicationId,
    observedHead: observed.status === "desired-head"
      ? normalizedIntended.desiredHead
      : observed.observedHead === normalizedIntended.desiredHead
        ? normalizedIntended.expectedHead
        : observed.observedHead,
  });
  state = appliedFactState(state, normalizedObserved);
  state = appliedFactState(state, Object.freeze({
    ...superseded,
    runId: runGenesis.runId,
    priorPlanRootId: normalizedOldPlan.planRootId,
    newPlanRootId: normalizedNewPlan.planRootId,
  }));

  assert.equal(state.phase, "execution");
  assert.equal(state.requirements?.requirementsRoot, requirements.requirementsRoot);
  assert.equal(state.workItems[0]?.status, "submission-bound");
  assert.equal(state.planRoots.length, 2);
  assert.equal(state.supersededPlanRoots.length, 1);
  assert.equal(state.coverageLinks.length, 1);
  assert.equal(state.findings[0]?.status, "cleared");
  assert.equal(state.evidenceRecords.length, 1);
  assert.equal(state.currentCandidateId, normalizedCandidate.candidateId);
  assert.equal(state.publications[0]?.observation?.observedHead, normalizedObserved.observedHead);
});

test("the twelve-fact handler map is executable and exact", () => {
  assert.deepEqual(
    domainFactCapsule.kinds,
    Object.freeze([
      "candidate-accepted",
      "coverage-linked",
      "evidence-observed",
      "finding-cleared",
      "finding-raised",
      "plan-root-accepted",
      "plan-root-superseded",
      "publication-intended",
      "publication-observed",
      "requirements-bound",
      "submission-bound",
      "work-declared",
    ]),
  );
  const runGenesis = genesis(7000);
  const state = initialState(runGenesis);
  const requirements = requirementsFact(7001, runGenesis.runId);
  assert.equal(foldDomainFact(state, requirements).kind, "applied");
});

void (undefined satisfies TerminalOutcome | undefined);
