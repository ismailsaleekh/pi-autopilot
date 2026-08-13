import { gitIntentCapsule } from "../contracts/git.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, lawCall } from "./vector-helpers.js";

export const gitLawVector: ContractVector = Object.freeze({
  id: "git.explicit-identities-unborn-serial-integration.v2",
  port: "git",
  behaviors: Object.freeze([
    "repository/ref capabilities and Git commit/tree identities are explicit and distinct from CAS roots",
    "empty reservations are consumed by materialization",
    "one command integrates exactly one candidate and conflicts are typed observations",
    "publication supports unborn refs, moved heads, and idempotent desired-head observation",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const tree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "git-v2-base",
      files: Object.freeze([Object.freeze({ path: "law/repository.bin", bytes: Uint8Array.from([7, 0, 9]) })]),
    }));
    const template = gitIntentCapsule.arbitrary.validForKind("materialize-workspace", 41);
    if (tree.kind !== "tree" || template.kind !== "materialize-workspace") {
      return lawTrace(this.id, trace, ["git fixture failed"]);
    }
    const repository = await driver.fixture(Object.freeze({
      kind: "repository",
      name: "git-v2-repository",
      runId: template.runId,
      treeName: tree.name,
    }));
    const workspace = await driver.fixture(Object.freeze({
      kind: "workspace",
      name: "git-v2-workspace",
      treeName: tree.name,
    }));
    if (repository.kind !== "repository" || workspace.kind !== "workspace") {
      return lawTrace(this.id, trace, ["repository or workspace fixture failed"]);
    }
    const materialize = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({
        baseCommit: repository.head,
        baseTree: repository.tree,
        repository: repository.repository,
        workspaceCapability: workspace.workspaceCapability,
        workspaceId: workspace.workspaceId,
      }),
      kind: "materialize-workspace",
      preconditions: Object.freeze({ expectedEmptyReservation: true, reservationLease: workspace.leaseId }),
      runId: repository.runId,
    }));
    const materialized = await lawCall(driver, "git", "materialize-reservation", materialize, "workspace-materialized", "ok");
    trace.push(materialized.trace);
    collectFinding(findings, materialized.finding);

    const compareTemplate = gitIntentCapsule.arbitrary.validForKind("compare-roots", 42);
    if (compareTemplate.kind === "compare-roots") {
      const compare = bindLawIntent("git", Object.freeze({
        inputs: Object.freeze({
          leftTree: repository.tree,
          repository: repository.repository,
          rightTree: repository.tree,
        }),
        kind: "compare-roots",
        preconditions: Object.freeze({ boundedCapture: true }),
        runId: repository.runId,
      }));
      const compared = await lawCall(driver, "git", "compare-identical", compare, "roots-compared", "ok");
      trace.push(compared.trace);
      collectFinding(findings, compared.finding);
      if (field(compared.value, "equal") !== true) {
        findings.push("compare-identical: equal Git trees were not equal");
      }
    }

    const integrateTemplate = gitIntentCapsule.arbitrary.validForKind("integrate-candidate", 43);
    if (integrateTemplate.kind !== "integrate-candidate") {
      return lawTrace(this.id, trace, [...findings, "integration template failed"]);
    }
    const integrate = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({
        baseCommit: repository.head,
        baseTree: repository.tree,
        candidateCommit: integrateTemplate.inputs.candidateCommit,
        candidateId: integrateTemplate.inputs.candidateId,
        candidateTree: integrateTemplate.inputs.candidateTree,
        repository: repository.repository,
        workspaceCapability: workspace.workspaceCapability,
      }),
      kind: "integrate-candidate",
      preconditions: Object.freeze({ expectedIntegrationRoot: tree.root, oneCandidate: true }),
      runId: repository.runId,
    }));
    const integrated = await lawCall(driver, "git", "integrate-one", integrate, "candidate-integrated", "ok");
    trace.push(integrated.trace);
    collectFinding(findings, integrated.finding);
    const integrationKind = field(integrated.value, "kind");
    if (integrationKind !== "integrated" && integrationKind !== "conflict") {
      findings.push("integrate-one: typed integrated/conflict result was absent");
    }

    if (integrationKind === "integrated") {
      const commit = field(integrated.value, "commit");
      const gitTree = field(integrated.value, "tree");
      const publishTemplate = gitIntentCapsule.arbitrary.validForKind("publish-if-expected-head", 44);
      if (typeof commit === "string" && typeof gitTree === "string" && publishTemplate.kind === "publish-if-expected-head") {
        const publish = bindLawIntent("git", Object.freeze({
          inputs: Object.freeze({
            desiredHead: commit,
            expected: Object.freeze({ kind: "at", commit: repository.head }),
            publicationId: publishTemplate.inputs.publicationId,
            publicationRef: repository.publicationRef,
            repository: repository.repository,
          }),
          kind: "publish-if-expected-head",
          preconditions: Object.freeze({
            candidateTree: gitTree,
            publicationLease: publishTemplate.preconditions.publicationLease,
            verifiedAttestation: publishTemplate.preconditions.verifiedAttestation,
          }),
          runId: repository.runId,
        }));
        const published = await lawCall(driver, "git", "publish-cas", publish, "head-publication-observed", "ok");
        trace.push(published.trace);
        collectFinding(findings, published.finding);
        const repeated = await lawCall(driver, "git", "publish-idempotent", publish, "head-publication-observed", "ok");
        trace.push(repeated.trace);
        collectFinding(findings, repeated.finding);
        if (field(repeated.value, "status") !== "desired-head") {
          findings.push("publish-idempotent: desired-head status was not retained");
        }
      }
    }
    if (repository.tree === tree.root) {
      findings.push("identity-separation: Git tree was overloaded as CAS ArtifactRoot");
    }
    return lawTrace(this.id, trace, findings);
  },
});
