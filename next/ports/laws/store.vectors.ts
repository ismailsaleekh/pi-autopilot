import { storeIntentCapsule } from "../contracts/store.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, json, lawCall } from "./vector-helpers.js";

function rangedReference(reference: unknown, offset: string, length: string) {
  const value = json(reference);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.freeze({ ...value, range: Object.freeze({ offset, length }) });
}

export const storeLawVector: ContractVector = Object.freeze({
  id: "store.codec-decimal-proof-paging.v2",
  port: "store",
  behaviors: Object.freeze([
    "references bind blob/root/codec/version/digest/decimal length and optional decimal range",
    "duplicate install is content-addressed and idempotent",
    "page cursors bind root, directory, codec, size, and predecessor proof",
    "missing or forged pages retry as unproven rather than appearing empty",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const tree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "store-v2-tree",
      files: Object.freeze([
        Object.freeze({ path: "law/a.bin", bytes: Uint8Array.from([0, 128, 255, 10]) }),
        Object.freeze({ path: "law/b.bin", bytes: Uint8Array.from([4, 3, 2, 1]) }),
      ]),
    }));
    const template = storeIntentCapsule.arbitrary.validForKind("install-sealed-object", 21);
    if (tree.kind !== "tree" || template.kind !== "install-sealed-object") {
      return lawTrace(this.id, trace, ["store fixture failed"]);
    }
    const install = bindLawIntent("store", Object.freeze({
      inputs: Object.freeze({ artifact: tree.manifest }),
      kind: "install-sealed-object",
      preconditions: Object.freeze({ expectedDigest: field(tree.manifest, "digest"), objectFirst: true }),
      runId: template.runId,
    }));
    const installed = await lawCall(driver, "store", "install", install, "sealed-object-installed", "ok");
    trace.push(installed.trace);
    collectFinding(findings, installed.finding);
    const repeated = await lawCall(driver, "store", "install-idempotent", install, "sealed-object-installed", "ok");
    trace.push(repeated.trace);
    collectFinding(findings, repeated.finding);
    if (field(repeated.value, "alreadyPresent") !== true) {
      findings.push("install-idempotent: alreadyPresent was false");
    }

    const range = rangedReference(tree.firstFile, "1", "2");
    const read = bindLawIntent("store", Object.freeze({
      inputs: Object.freeze({ artifact: range }),
      kind: "read-artifact-range",
      preconditions: Object.freeze({ expectedRoot: tree.root }),
      runId: template.runId,
    }));
    const readResult = await lawCall(driver, "store", "read-decimal-range", read, "artifact-range-read", "ok");
    trace.push(readResult.trace);
    collectFinding(findings, readResult.finding);
    const content = json(field(readResult.value, "content"));
    const bytes = content === null ? null : await driver.readArtifact(content);
    if (bytes === null || bytes.length !== 2 || bytes[0] !== 128 || bytes[1] !== 255) {
      findings.push("read-decimal-range: exact bytes differed");
    }

    const listTemplate = storeIntentCapsule.arbitrary.validForKind("list-artifact-page", 22);
    if (listTemplate.kind === "list-artifact-page") {
      const list = bindLawIntent("store", Object.freeze({
        inputs: Object.freeze({
          codec: listTemplate.inputs.codec,
          codecVersion: listTemplate.inputs.codecVersion,
          cursor: null,
          directory: "law",
          pageSize: "1",
          previousPageProof: null,
          root: tree.root,
        }),
        kind: "list-artifact-page",
        preconditions: Object.freeze({ expectedRoot: tree.root }),
        runId: template.runId,
      }));
      const listed = await lawCall(driver, "store", "list-first-page", list, "artifact-page-listed", "ok");
      trace.push(listed.trace);
      collectFinding(findings, listed.finding);
      const cursor = field(listed.value, "nextCursor");
      const proof = json(field(listed.value, "entries"));
      if (typeof cursor === "string" && proof !== null) {
        const next = bindLawIntent("store", Object.freeze({
          inputs: Object.freeze({
            codec: listTemplate.inputs.codec,
            codecVersion: listTemplate.inputs.codecVersion,
            cursor,
            directory: "law",
            pageSize: "1",
            previousPageProof: proof,
            root: tree.root,
          }),
          kind: "list-artifact-page",
          preconditions: Object.freeze({ expectedRoot: tree.root }),
          runId: template.runId,
        }));
        const second = await lawCall(driver, "store", "list-second-page", next, "artifact-page-listed", "ok");
        trace.push(second.trace);
        collectFinding(findings, second.finding);
      } else {
        findings.push("list-first-page: cursor/proof absent");
      }
    }
    return lawTrace(this.id, trace, findings);
  },
});
