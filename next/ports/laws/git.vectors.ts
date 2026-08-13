import { gitIntentCapsule } from "../contracts/git.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, json, lawCall } from "./vector-helpers.js";

export const gitLawVector: ContractVector = Object.freeze({
  id: "git.materialize-seal-integrate-cas.v1",
  port: "git",
  behaviors: Object.freeze([
    "materialization binds repository identity and immutable base",
    "seal captures the exact workspace root",
    "root comparison is byte-derived",
    "integration creates a deterministic commit",
    "publication is compare-and-swap and retry-idempotent",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const tree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "git-base",
      files: Object.freeze([
        Object.freeze({ path: "law/repository.bin", bytes: Uint8Array.from([7, 0, 9]) }),
      ]),
    }));
    const materializeTemplate = gitIntentCapsule.arbitrary.validForKind("materialize-workspace", 41);
    if (tree.kind !== "tree" || materializeTemplate.kind !== "materialize-workspace") {
      return lawTrace("git.materialize-seal-integrate-cas.v1", trace, Object.freeze(["git fixture failed"]));
    }
    const repository = await driver.fixture(Object.freeze({
      kind: "repository",
      name: "git-repository",
      runId: materializeTemplate.runId,
      treeName: "git-base",
    }));
    if (repository.kind !== "repository") {
      return lawTrace(
        "git.materialize-seal-integrate-cas.v1",
        trace,
        Object.freeze([repository.kind === "invalid" ? repository.diagnostic : "repository fixture returned the wrong kind"]),
      );
    }
    const materialize = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({
        baseRevision: repository.head,
        repositorySnapshot: repository.tree,
        workspaceId: materializeTemplate.inputs.workspaceId,
      }),
      kind: "materialize-workspace",
      preconditions: Object.freeze({ expectedAbsent: true, repositoryIdentity: repository.identity }),
      runId: repository.runId,
    }));
    const materialized = await lawCall(driver, "git", "materialize", materialize, "workspace-materialized", "ok");
    trace.push(materialized.trace);
    collectFinding(findings, materialized.finding);

    const sealTemplate = gitIntentCapsule.arbitrary.validForKind("seal-workspace", 42);
    if (sealTemplate.kind !== "seal-workspace") {
      findings.push("seal template failed");
    } else {
      const seal = bindLawIntent("git", Object.freeze({
        inputs: Object.freeze({ workspaceId: materializeTemplate.inputs.workspaceId }),
        kind: "seal-workspace",
        preconditions: Object.freeze({
          childEpoch: sealTemplate.preconditions.childEpoch,
          expectedInputRoot: repository.tree,
        }),
        runId: repository.runId,
      }));
      const sealed = await lawCall(driver, "git", "seal", seal, "workspace-sealed", "ok");
      trace.push(sealed.trace);
      collectFinding(findings, sealed.finding);
    }

    const compare = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({ leftRoot: repository.tree, rightRoot: repository.tree }),
      kind: "compare-roots",
      preconditions: Object.freeze({ repositoryIdentity: repository.identity }),
      runId: repository.runId,
    }));
    const compared = await lawCall(driver, "git", "compare", compare, "roots-compared", "ok");
    trace.push(compared.trace);
    collectFinding(findings, compared.finding);
    if (field(compared.value, "equal") !== true) {
      findings.push("compare: identical roots were not equal");
    }

    const rootList = await driver.fixture(Object.freeze({
      kind: "root-list",
      name: "git-outputs",
      treeNames: Object.freeze(["git-base"]),
    }));
    const integrateTemplate = gitIntentCapsule.arbitrary.validForKind("integrate-candidate", 43);
    if (rootList.kind !== "root-list" || integrateTemplate.kind !== "integrate-candidate") {
      findings.push("integration fixture failed");
      return lawTrace("git.materialize-seal-integrate-cas.v1", trace, findings);
    }
    const integrate = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({
        acceptedOutputs: rootList.reference,
        baseRevision: repository.head,
        candidateId: integrateTemplate.inputs.candidateId,
      }),
      kind: "integrate-candidate",
      preconditions: Object.freeze({
        expectedIntegrationRoot: repository.tree,
        repositoryIdentity: repository.identity,
      }),
      runId: repository.runId,
    }));
    const integrated = await lawCall(driver, "git", "integrate", integrate, "candidate-integrated", "ok");
    trace.push(integrated.trace);
    collectFinding(findings, integrated.finding);
    const revision = field(integrated.value, "revision");
    const candidateTree = field(integrated.value, "tree");
    const manifest = json(field(integrated.value, "manifest"));
    const publishTemplate = gitIntentCapsule.arbitrary.validForKind("publish-if-expected-head", 44);
    if (
      publishTemplate.kind !== "publish-if-expected-head"
      || typeof revision !== "string"
      || typeof candidateTree !== "string"
      || manifest === null
    ) {
      findings.push("publication inputs were not produced by integration");
      return lawTrace("git.materialize-seal-integrate-cas.v1", trace, findings);
    }
    const publish = bindLawIntent("git", Object.freeze({
      inputs: Object.freeze({
        desiredHead: revision,
        expectedHead: repository.head,
        publicationId: publishTemplate.inputs.publicationId,
      }),
      kind: "publish-if-expected-head",
      preconditions: Object.freeze({
        candidateTree,
        publicationLease: publishTemplate.preconditions.publicationLease,
        verifiedManifest: manifest,
      }),
      runId: repository.runId,
    }));
    const published = await lawCall(driver, "git", "publish", publish, "head-publication-observed", "ok");
    trace.push(published.trace);
    collectFinding(findings, published.finding);
    const publishedAgain = await lawCall(driver, "git", "publish-idempotent", publish, "head-publication-observed", "ok");
    trace.push(publishedAgain.trace);
    collectFinding(findings, publishedAgain.finding);
    return lawTrace("git.materialize-seal-integrate-cas.v1", trace, findings);
  },
});
