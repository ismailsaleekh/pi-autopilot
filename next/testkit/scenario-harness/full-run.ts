import { initial, prepare, replay } from "../../authority/facade/index.js";
import type { Feedback } from "../../authority/facade/index.js";
import type { RunState } from "../../authority/model/run-state.js";
import { atomCapsule } from "../../authority/protocol/atom.capsule.js";
import type { Atom, AtomDisposition } from "../../authority/protocol/atom.capsule.js";
import type { PreparedCommit } from "../../authority/protocol/accepted-batch.js";
import { commandActionId, commandCapsule, commandIdentity } from "../../authority/protocol/command.capsule.js";
import type { Command, ExecuteEvidence, PublishCompareAndSwap } from "../../authority/protocol/command.capsule.js";
import { evidenceEnvelopeDigest, evidenceFactCapsule } from "../../authority/protocol/evidence-fact.capsule.js";
import type { EvidenceFact } from "../../authority/protocol/evidence-fact.capsule.js";
import { findingCapsule } from "../../authority/protocol/finding.capsule.js";
import type { Finding, PlanningGapFinding } from "../../authority/protocol/finding.capsule.js";
import type { ArtifactRef, ArtifactRoot, PlanRootId } from "../../authority/protocol/identifiers.js";
import { decimalNatural, oneDecimalNatural, submissionIdSchema } from "../../authority/protocol/identifiers.js";
import { journalRecordCapsule } from "../../authority/protocol/journal-record.capsule.js";
import type { JournalRecord, RunGenesis } from "../../authority/protocol/journal-record.capsule.js";
import { canonicalDigestUnknown, canonicalEncodeUnknown, defineCapsule } from "../../authority/protocol/schema.js";
import { stimulusCapsule } from "../../authority/protocol/stimulus.capsule.js";
import type { BoundaryRequestReceived, CommandObservationPayload, CommandObservationReceived, OperatorResumeRequested, OperatorSuspendRequested, RequestPayload, Stimulus, SubmissionPayload, SubmissionReady } from "../../authority/protocol/stimulus.capsule.js";
import { workItemCapsule } from "../../authority/protocol/work-item.capsule.js";
import type { ProduceArtifactWork } from "../../authority/protocol/work-item.capsule.js";
import { makeEvidenceEnvelope } from "../../runtime/dispatcher/evidence.js";
import { ArtifactCatalog } from "../simulation/artifacts.js";
import { actionIdFor, scenarioGenesis } from "./authority.js";

const scenarioSubmissionIdCapsule = defineCapsule("PublicScenarioSubmissionId", submissionIdSchema);

export interface InstalledScenarioArtifact {
  readonly reference: ArtifactRef;
  readonly root: ArtifactRoot;
}

export class PublicAuthorityScenario {
  public readonly artifacts = new ArtifactCatalog();
  public readonly genesis: RunGenesis;
  public state: RunState;
  public readonly records: JournalRecord[] = [];
  private artifactSequence = 0;
  private actionSequence = 0;
  private readonly seed: number;

  public constructor(seed: number) {
    this.seed = seed;
    const template = scenarioGenesis(seed);
    const task = this.install("task-snapshot", Object.freeze({ seed, kind: "task" }));
    const policy = this.install("policy-root", Object.freeze({ seed, kind: "policy" }));
    const runtime = this.install("runtime-root", Object.freeze({ seed, kind: "runtime" }));
    const decoded = journalRecordCapsule.decode(Object.freeze({
      ...template,
      policyRoot: policy.root,
      runtimeRoot: runtime.root,
      taskSnapshot: task.root,
    }));
    if (decoded.kind !== "ok" || decoded.value.kind !== "run-genesis") throw new Error("canonical scenario genesis could not be decoded");
    this.genesis = decoded.value;
    this.state = initial(this.genesis);
  }

  public install(label: string, value: unknown): InstalledScenarioArtifact {
    this.artifactSequence += 1;
    const path = `scenario/${String(this.seed)}-${String(this.artifactSequence)}-${label}.bin`;
    const created = this.artifacts.createBlob(path, canonicalEncodeUnknown(value));
    if (created.kind !== "ok") throw new Error(created.diagnostic);
    const reference = this.artifacts.reference(created.tree.root, path);
    if (reference === null) throw new Error("installed scenario artifact has no canonical reference");
    return Object.freeze({ reference, root: created.tree.root });
  }

  public action(): ReturnType<typeof actionIdFor> {
    this.actionSequence += 1;
    return actionIdFor(this.genesis.runId, this.seed * 1000 + this.actionSequence);
  }

  public commit(stimulus: Stimulus): PreparedCommit {
    const prepared = prepare(this.state, stimulus);
    if (prepared.kind === "feedback") throw new Error(`${prepared.code}: ${prepared.diagnostic}`);
    const applied = replay(this.state, Object.freeze([prepared.record]));
    if (applied.kind !== "applied") throw new Error(`${applied.error.code}: ${applied.error.diagnostic}`);
    this.state = applied.state;
    this.records.push(prepared.record);
    return prepared;
  }

  public inspect(stimulus: Stimulus): PreparedCommit | Feedback {
    return prepare(this.state, stimulus);
  }

  public boundary(payload: RequestPayload): BoundaryRequestReceived {
    const template = stimulusCapsule.arbitrary.validForKind("boundary-request-received", this.seed + this.actionSequence + 100);
    const request = this.install("boundary-request", payload).reference;
    const decoded = stimulusCapsule.decode(Object.freeze({
      ...template,
      actionId: this.action(),
      kind: "boundary-request-received",
      pages: Object.freeze([]),
      request,
      requestDigest: request.digest,
      requestPayload: payload,
      runId: this.genesis.runId,
    }));
    if (decoded.kind !== "ok" || decoded.value.kind !== "boundary-request-received") throw new Error("boundary request could not be decoded");
    return decoded.value;
  }

  public submission(work: ProduceArtifactWork, payload: SubmissionPayload, outputRoot: ArtifactRoot): SubmissionReady {
    const template = stimulusCapsule.arbitrary.validForKind("submission-ready", this.seed + this.actionSequence + 200);
    const decoded = stimulusCapsule.decode(Object.freeze({
      ...template,
      actionId: this.action(),
      inputRoot: work.inputRoot,
      kind: "submission-ready",
      outputRoot,
      pages: Object.freeze([]),
      planRootId: work.planRootId,
      runId: this.genesis.runId,
      submissionPayload: payload,
      workItemId: work.workItemId,
    }));
    if (decoded.kind !== "ok" || decoded.value.kind !== "submission-ready") throw new Error("submission could not be decoded");
    return decoded.value;
  }

  public observation(command: Command, payload: CommandObservationPayload): CommandObservationReceived {
    const template = stimulusCapsule.arbitrary.validForKind("command-observation-received", this.seed + this.actionSequence + 300);
    const observation = this.install("command-observation", payload).reference;
    const decoded = stimulusCapsule.decode(Object.freeze({
      ...template,
      actionId: command.actionId,
      commandId: command.commandId,
      kind: "command-observation-received",
      observation,
      observationDigest: observation.digest,
      observationPayload: payload,
      pages: Object.freeze([]),
      runId: this.genesis.runId,
    }));
    if (decoded.kind !== "ok" || decoded.value.kind !== "command-observation-received") throw new Error("command observation could not be decoded");
    return decoded.value;
  }

  public suspend(label: string): OperatorSuspendRequested {
    const template = stimulusCapsule.arbitrary.validForKind("operator-suspend-requested", this.seed + this.actionSequence + 400);
    const reason = this.install("suspension-reason", Object.freeze({ label })).reference;
    const decoded = stimulusCapsule.decode(Object.freeze({
      ...template,
      actionId: this.action(),
      kind: "operator-suspend-requested",
      pages: Object.freeze([]),
      reason,
      runId: this.genesis.runId,
    }));
    if (decoded.kind !== "ok" || decoded.value.kind !== "operator-suspend-requested") throw new Error("suspend request could not be decoded");
    return decoded.value;
  }

  public resume(): OperatorResumeRequested {
    if (this.state.suspension.kind !== "suspended") throw new Error("scenario is not suspended");
    const template = stimulusCapsule.arbitrary.validForKind("operator-resume-requested", this.seed + this.actionSequence + 500);
    const decoded = stimulusCapsule.decode(Object.freeze({
      ...template,
      actionId: this.action(),
      kind: "operator-resume-requested",
      operatorRequestId: this.state.suspension.operatorRequestId,
      pages: Object.freeze([]),
      resumeFromSequence: this.state.suspension.sequence,
      runId: this.genesis.runId,
    }));
    if (decoded.kind !== "ok" || decoded.value.kind !== "operator-resume-requested") throw new Error("resume request could not be decoded");
    return decoded.value;
  }

  public produceWork(planRootId: PlanRootId, label: string, rankText: string): ProduceArtifactWork {
    const template = workItemCapsule.arbitrary.validForKind("produce-artifact", this.seed + this.actionSequence + this.artifactSequence + 600);
    const rank = decimalNatural(rankText);
    const prompt = this.install(`${label}-prompt`, Object.freeze({ label, kind: "prompt" })).reference;
    const rules = this.install(`${label}-rules`, Object.freeze({ label, kind: "rules" })).reference;
    if (template.kind !== "produce-artifact" || rank === null) throw new Error("work template could not be created");
    const decoded = workItemCapsule.decode(Object.freeze({
      ...template,
      dependencyCount: "0",
      dependencyRoot: this.state.indexes.dependencies.root,
      inputRoot: this.genesis.taskSnapshot,
      planRootId,
      prompt,
      ruleInputs: rules,
      runId: this.genesis.runId,
      sourceRoot: this.genesis.taskSnapshot,
      taskRoot: this.genesis.taskSnapshot,
      topologicalRank: rank,
    }));
    if (decoded.kind !== "ok" || decoded.value.kind !== "produce-artifact") throw new Error("work item could not be decoded");
    return decoded.value;
  }
}

function planRootId(seed: number): PlanRootId {
  const template = workItemCapsule.arbitrary.validForKind("produce-artifact", seed);
  if (template.kind !== "produce-artifact") return planRootId(seed + 1);
  return template.planRootId;
}

function workAtom(scenario: PublicAuthorityScenario, seed: number): Atom {
  const template = atomCapsule.arbitrary.validForKind("atom", seed);
  if (template.kind !== "atom") return workAtom(scenario, seed + 1);
  const evidence = scenario.install("atom-source", Object.freeze({ seed, kind: "atom-source" })).reference;
  const decoded = atomCapsule.decode(Object.freeze({
    kind: "atom",
    value: Object.freeze({ ...template.value, kind: "WORK", runId: scenario.genesis.runId, sourceEvidence: evidence }),
  }));
  if (decoded.kind !== "ok" || decoded.value.kind !== "atom") throw new Error("work atom could not be decoded");
  return decoded.value.value;
}

function implementedDisposition(scenario: PublicAuthorityScenario, atom: Atom, planId: PlanRootId, work: ProduceArtifactWork, seed: number): AtomDisposition {
  const template = atomCapsule.arbitrary.validForKind("disposition", seed);
  if (template.kind !== "disposition" || template.value.meaning.kind !== "implemented-by") return implementedDisposition(scenario, atom, planId, work, seed + 1);
  const evidence = scenario.install("atom-disposition", Object.freeze({ seed, kind: "atom-disposition" })).reference;
  const decoded = atomCapsule.decode(Object.freeze({
    kind: "disposition",
    value: Object.freeze({
      atomId: atom.atomId,
      meaning: Object.freeze({ ...template.value.meaning, evidence: Object.freeze([evidence]), planRootId: planId, workItems: Object.freeze([work.workItemId]) }),
      runId: scenario.genesis.runId,
    }),
  }));
  if (decoded.kind !== "ok" || decoded.value.kind !== "disposition") throw new Error("atom disposition could not be decoded");
  return decoded.value.value;
}

function finalEvidence(scenario: PublicAuthorityScenario, candidateTree: ArtifactRoot, work: ProduceArtifactWork, seed: number): EvidenceFact {
  const template = commandCapsule.arbitrary.validForKind("execute-evidence", seed);
  if (template.kind !== "execute-evidence") return finalEvidence(scenario, candidateTree, work, seed + 1);
  const commandSpec = scenario.install("final-command", Object.freeze({ seed, kind: "final-command" })).reference;
  const environment = scenario.install("final-environment", Object.freeze({ seed, kind: "final-environment" })).reference;
  const intentInputs = Object.freeze({
    attemptId: template.attemptId,
    candidateTree,
    commandSpec,
    cwd: template.cwd,
    environment,
    evidenceClass: "final-verification",
    kindId: template.kindId,
    ruleId: template.ruleId,
    workItemId: work.workItemId,
    workspaceCapability: work.workspaceCapability,
    workspaceId: work.workspaceId,
  });
  const actionId = commandActionId("child", scenario.genesis.runId, "execute-evidence-command", intentInputs, Object.freeze({ deadlineTick: template.deadlineTick }));
  const decodedCommand = commandCapsule.decode(Object.freeze({
    ...template,
    actionId,
    candidateTree,
    commandId: commandIdentity("execute-evidence", actionId),
    commandSpec,
    environment,
    evidenceClass: "final-verification",
    runId: scenario.genesis.runId,
    workItemId: work.workItemId,
    workspaceCapability: work.workspaceCapability,
    workspaceId: work.workspaceId,
  }));
  if (decodedCommand.kind !== "ok" || decodedCommand.value.kind !== "execute-evidence") throw new Error("final evidence command could not be decoded");
  const output = scenario.install("final-evidence-output", Object.freeze({ seed, candidateTree })).reference;
  const minted = makeEvidenceEnvelope(decodedCommand.value, Object.freeze({ exit: Object.freeze({ kind: "exited", code: "0" }), output }));
  if (minted.kind !== "minted") throw new Error(minted.diagnostic);
  const encoded = evidenceFactCapsule.encodeUnknown(Object.freeze({ kind: "evidence-fact", envelope: minted.transport, envelopeDigest: evidenceEnvelopeDigest(minted.transport) }));
  if (encoded.kind !== "ok") throw new Error(encoded.error.diagnostic);
  const decoded = evidenceFactCapsule.decodeCanonical(encoded.value);
  if (decoded.kind !== "ok") throw new Error(decoded.error.diagnostic);
  return decoded.value;
}

function planningGap(scenario: PublicAuthorityScenario, atom: Atom, planId: PlanRootId, reason: PlanningGapFinding["reason"], seed: number): PlanningGapFinding {
  const template = findingCapsule.arbitrary.validForKind("planning-gap", seed);
  if (template.kind !== "planning-gap") return planningGap(scenario, atom, planId, reason, seed + 1);
  const explanation = scenario.install("planning-gap-explanation", Object.freeze({ seed, reason })).reference;
  const review = scenario.install("planning-gap-review", Object.freeze({ seed, kind: "independent-review" })).reference;
  const source = scenario.install("planning-gap-source", Object.freeze({ seed, kind: "source" })).reference;
  const decoded = findingCapsule.decode(Object.freeze({
    ...template,
    atomIds: Object.freeze([atom.atomId]),
    explanation,
    independentReview: review,
    planRootId: planId,
    reason,
    runId: scenario.genesis.runId,
    sourceAnchors: Object.freeze([atom.sourceAnchor]),
    sourceEvidence: Object.freeze([source]),
  }));
  if (decoded.kind !== "ok" || decoded.value.kind !== "planning-gap") throw new Error("planning gap could not be decoded");
  return decoded.value;
}

export interface PlannedScenario {
  readonly scenario: PublicAuthorityScenario;
  readonly planId: PlanRootId;
  readonly planRoot: ArtifactRoot;
  readonly coverageRoot: ArtifactRoot;
  readonly atom: Atom;
  readonly author: ProduceArtifactWork;
  readonly integrator: ProduceArtifactWork;
  readonly laneA: ProduceArtifactWork;
  readonly laneB: ProduceArtifactWork;
}

export function buildPlannedScenario(seed: number): PlannedScenario {
  const scenario = new PublicAuthorityScenario(seed);
  const planId = planRootId(seed + 10);
  const planRoot = scenario.install("accepted-plan", Object.freeze({ seed, kind: "plan" })).root;
  const coverageRoot = scenario.install("coverage", Object.freeze({ seed, kind: "coverage" })).root;
  const atom = workAtom(scenario, seed + 20);
  scenario.commit(scenario.boundary(Object.freeze({
    atomIndexRoot: scenario.state.indexes.atoms.root,
    declaredAtomCount: oneDecimalNatural(),
    kind: "bind-requirements-v2",
    requirementsRoot: scenario.install("requirements", Object.freeze({ seed, kind: "requirements" })).root,
    sourceRoot: scenario.install("requirements-source", Object.freeze({ seed, kind: "source" })).root,
    taskRoot: scenario.genesis.taskSnapshot,
  })));
  scenario.commit(scenario.boundary(Object.freeze({ atom, kind: "declare-atom-v2" })));
  scenario.commit(scenario.boundary(Object.freeze({
    atomCount: scenario.state.indexes.atoms.count,
    atomIndexRoot: scenario.state.indexes.atoms.root,
    inventoryEvidence: scenario.install("inventory-evidence", Object.freeze({ seed, kind: "inventory" })).reference,
    kind: "seal-atom-inventory-v2",
  })));
  const author = scenario.produceWork(planId, "plan-author", "1");
  const integrator = scenario.produceWork(planId, "integration-owner", "2");
  const laneA = scenario.produceWork(planId, "lane-a", "3");
  const laneB = scenario.produceWork(planId, "lane-b", "4");
  for (const workItem of [author, integrator, laneA, laneB]) scenario.commit(scenario.boundary(Object.freeze({ kind: "declare-work-v2", workItem })));
  const disposition = implementedDisposition(scenario, atom, planId, laneA, seed + 30);
  scenario.commit(scenario.submission(author, Object.freeze({ disposition, kind: "disposition-atom-v2" }), planRoot));
  scenario.commit(scenario.submission(author, Object.freeze({
    coverageRoot,
    integrationOwnerWorkItemId: integrator.workItemId,
    kind: "accept-plan-v2",
    planAuthorWorkItemId: author.workItemId,
    planRoot,
    reviewedPlan: scenario.install("reviewed-plan", Object.freeze({ seed, kind: "reviewed-plan" })).reference,
  }), planRoot));
  return Object.freeze({ scenario, planId, planRoot, coverageRoot, atom, author, integrator, laneA, laneB });
}

export function workOutputSubmission(planned: PlannedScenario, work: ProduceArtifactWork, label: string, outputRoot: ArtifactRoot): SubmissionReady {
  const scenario = planned.scenario;
  const digest = canonicalDigestUnknown(Object.freeze({ domain: "pi-autopilot.public-scenario-submission.v2", label, runId: scenario.genesis.runId, sequence: scenario.records.length }));
  const submissionId = scenarioSubmissionIdCapsule.decode(`submission:sha256:${digest.slice(7)}`);
  if (submissionId.kind !== "ok") throw new Error(submissionId.error.diagnostic);
  return scenario.submission(work, Object.freeze({
    accountedDiff: scenario.install(`${label}-diff`, Object.freeze({ label, kind: "diff" })).reference,
    evidence: Object.freeze([scenario.install(`${label}-evidence`, Object.freeze({ label, kind: "evidence" })).reference]),
    kind: "accept-work-output-v2",
    submissionId: submissionId.value,
  }), outputRoot);
}

export function acceptWorkOutput(planned: PlannedScenario, work: ProduceArtifactWork, label: string, outputRoot: ArtifactRoot): PreparedCommit {
  return planned.scenario.commit(workOutputSubmission(planned, work, label, outputRoot));
}

export interface T1ScenarioResult extends PlannedScenario {
  readonly candidateTree: ArtifactRoot;
  readonly finalEvidence: EvidenceFact;
  readonly terminalCommit: PreparedCommit;
  readonly publicationCommand: PublishCompareAndSwap;
}

export function buildT1Scenario(seed: number): T1ScenarioResult {
  const planned = buildPlannedScenario(seed);
  const scenario = planned.scenario;
  const laneARoot = scenario.install("lane-a-output", Object.freeze({ seed, lane: "a" })).root;
  const laneBRoot = scenario.install("lane-b-output", Object.freeze({ seed, lane: "b" })).root;
  const authorRoot = scenario.install("author-output", Object.freeze({ seed, lane: "author" })).root;
  acceptWorkOutput(planned, planned.laneA, "lane-a", laneARoot);
  acceptWorkOutput(planned, planned.laneB, "lane-b", laneBRoot);
  acceptWorkOutput(planned, planned.author, "author", authorRoot);

  const candidateTree = scenario.install("candidate-tree", Object.freeze({ seed, inputs: Object.freeze([laneARoot, laneBRoot]) })).root;
  let candidatePayload: Extract<SubmissionPayload, { readonly kind: "accept-candidate-v2" }> | null = null;
  for (let offset = 0; candidatePayload === null && offset < 100; offset += 1) {
    const template = stimulusCapsule.arbitrary.validForKind("submission-ready", seed + 1000 + offset);
    if (template.kind === "submission-ready" && template.submissionPayload.kind === "accept-candidate-v2") candidatePayload = template.submissionPayload;
  }
  if (candidatePayload === null) throw new Error("candidate payload template was unavailable");
  const manifest = scenario.install("candidate-manifest", Object.freeze({ seed, kind: "manifest" })).reference;
  const reviewedDiff = scenario.install("candidate-reviewed-diff", Object.freeze({ seed, kind: "reviewed-diff" })).reference;
  const treeAttestation = scenario.install("candidate-tree-attestation", Object.freeze({ seed, candidateTree })).reference;
  scenario.commit(scenario.submission(planned.integrator, Object.freeze({
    ...candidatePayload,
    gitTreeCasAttestation: Object.freeze({ artifactRoot: candidateTree, attestation: treeAttestation, gitTree: candidatePayload.gitTree }),
    kind: "accept-candidate-v2",
    manifest,
    reviewedDiff,
    tree: candidateTree,
  }), candidateTree));
  const candidate = scenario.state.currentCandidate;
  if (candidate === null) throw new Error("candidate was not accepted");

  let publicationPayload: Extract<RequestPayload, { readonly kind: "intend-publication-v2" }> | null = null;
  for (let offset = 0; publicationPayload === null && offset < 100; offset += 1) {
    const template = stimulusCapsule.arbitrary.validForKind("boundary-request-received", seed + 1100 + offset);
    if (template.kind === "boundary-request-received" && template.requestPayload.kind === "intend-publication-v2") publicationPayload = template.requestPayload;
  }
  if (publicationPayload === null) throw new Error("publication payload template was unavailable");
  const publicationCommit = scenario.commit(scenario.boundary(Object.freeze({
    ...publicationPayload,
    candidateId: candidate.candidateId,
    desiredHead: candidate.gitRevision,
    expected: scenario.genesis.expectedPublication,
    kind: "intend-publication-v2",
    publicationRef: scenario.genesis.publicationRef,
    repository: scenario.genesis.repository,
  })));
  const publicationCommand = publicationCommit.record.kind === "decision-committed"
    ? publicationCommit.record.commands.find((command): command is PublishCompareAndSwap => command.kind === "publish-compare-and-swap")
    : undefined;
  if (publicationCommand === undefined) throw new Error("publication command was not issued");

  const evidence = finalEvidence(scenario, candidateTree, planned.integrator, seed + 1200);
  scenario.commit(scenario.submission(planned.integrator, Object.freeze({ evidence, kind: "accept-evidence-v2" }), candidateTree));
  const publication = scenario.state.currentPublication;
  if (publication === null) throw new Error("publication intent was not retained");
  scenario.commit(scenario.submission(planned.integrator, Object.freeze({
    advisoryDisclosures: scenario.install("advisory-disclosures", Object.freeze({ seed, kind: "advisories" })).reference,
    c1ToC7Proof: scenario.install("c1-c7-proof", Object.freeze({ seed, kind: "yardstick-proof" })).reference,
    candidateId: candidate.candidateId,
    evidenceIndexRoot: scenario.state.indexes.evidence.root,
    finalManifest: scenario.install("final-manifest", Object.freeze({ seed, candidateTree })).reference,
    finalVerificationEvidence: evidence.envelope.evidenceId,
    kind: "record-final-attestations-v2",
    publicationId: publication.publicationId,
  }), candidateTree));
  acceptWorkOutput(planned, planned.integrator, "integrator", candidateTree);

  const terminalCommit = scenario.commit(scenario.observation(publicationCommand, Object.freeze({
    gitTree: candidate.gitTree,
    kind: "publication-observed-v2",
    observedHead: publication.desiredHead,
    publicationId: publication.publicationId,
    publicationTreeAttestation: Object.freeze({
      artifactRoot: candidateTree,
      attestation: scenario.install("publication-tree-attestation", Object.freeze({ seed, candidateTree })).reference,
      gitTree: candidate.gitTree,
    }),
    status: "desired-head",
    tree: candidateTree,
  })));
  if (scenario.state.terminal?.outcome.kind !== "t1") throw new Error("full scenario did not reach T1");
  return Object.freeze({ ...planned, candidateTree, finalEvidence: evidence, terminalCommit, publicationCommand });
}

export interface T2ScenarioResult {
  readonly scenario: PublicAuthorityScenario;
  readonly atom: Atom;
  readonly finding: PlanningGapFinding;
  readonly terminalCommit: PreparedCommit;
}

export function buildT2Scenario(seed: number, reason: PlanningGapFinding["reason"]): T2ScenarioResult {
  const scenario = new PublicAuthorityScenario(seed);
  const planId = planRootId(seed + 10);
  const atom = workAtom(scenario, seed + 20);
  scenario.commit(scenario.boundary(Object.freeze({
    atomIndexRoot: scenario.state.indexes.atoms.root,
    declaredAtomCount: oneDecimalNatural(),
    kind: "bind-requirements-v2",
    requirementsRoot: scenario.install("t2-requirements", Object.freeze({ seed, kind: "requirements" })).root,
    sourceRoot: scenario.install("t2-source", Object.freeze({ seed, kind: "source" })).root,
    taskRoot: scenario.genesis.taskSnapshot,
  })));
  scenario.commit(scenario.boundary(Object.freeze({ atom, kind: "declare-atom-v2" })));
  scenario.commit(scenario.boundary(Object.freeze({
    atomCount: scenario.state.indexes.atoms.count,
    atomIndexRoot: scenario.state.indexes.atoms.root,
    inventoryEvidence: scenario.install("t2-inventory", Object.freeze({ seed, kind: "inventory" })).reference,
    kind: "seal-atom-inventory-v2",
  })));
  const reviewer = scenario.produceWork(planId, "planning-reviewer", "1");
  scenario.commit(scenario.boundary(Object.freeze({ kind: "declare-work-v2", workItem: reviewer })));
  const finding = planningGap(scenario, atom, planId, reason, seed + 30);
  const terminalCommit = scenario.commit(scenario.submission(reviewer, Object.freeze({ finding, kind: "accept-finding-v2" }), scenario.genesis.taskSnapshot));
  if (scenario.state.terminal?.outcome.kind !== "t2") throw new Error("planning scenario did not reach T2");
  return Object.freeze({ scenario, atom, finding, terminalCommit });
}

export function blockingFinding(planned: PlannedScenario, kind: "integrity" | "definition-of-done", scope: "local" | "plan-wide" | "cross-lane", seed: number): Finding {
  const scenario = planned.scenario;
  const template = findingCapsule.arbitrary.validForKind(kind, seed);
  if (template.kind !== kind) return blockingFinding(planned, kind, scope, seed + 1);
  const subjectRoot = scope === "plan-wide" ? planned.planRoot : scope === "local" ? scenario.genesis.taskSnapshot : scenario.install("cross-lane-subject", Object.freeze({ seed, scope })).root;
  const decoded = findingCapsule.decode(Object.freeze({
    ...template,
    evidence: Object.freeze([scenario.install(`${scope}-finding-evidence`, Object.freeze({ seed, scope })).reference]),
    report: scenario.install(`${scope}-finding-report`, Object.freeze({ seed, scope })).reference,
    runId: scenario.genesis.runId,
    subjectRoot,
    subjectWorkItemId: scope === "local" ? planned.laneA.workItemId : null,
  }));
  if (decoded.kind !== "ok") throw new Error(decoded.error.diagnostic);
  return decoded.value;
}

export function submitBlockingFinding(planned: PlannedScenario, finding: Finding): PreparedCommit {
  return planned.scenario.commit(planned.scenario.submission(planned.integrator, Object.freeze({ finding, kind: "accept-finding-v2" }), planned.planRoot));
}

export function executeEvidenceTemplate(command: ExecuteEvidence): ExecuteEvidence {
  return command;
}
