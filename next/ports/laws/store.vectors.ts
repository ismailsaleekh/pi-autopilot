import { storeIntentCapsule } from "../contracts/store.capsule.js";
import type { ContractVector, LawDriver, LawTraceEntry } from "./contract-vector.js";
import { bindLawIntent, lawTrace } from "./contract-vector.js";
import { collectFinding, field, json, lawCall } from "./vector-helpers.js";

function rangedReference(reference: unknown, offset: number, length: number) {
  const value = json(reference);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const root: unknown = Reflect.get(value, "root");
  const path: unknown = Reflect.get(value, "path");
  return typeof root === "string" && typeof path === "string"
    ? Object.freeze({ path, range: Object.freeze({ offset, length }), root })
    : null;
}

export const storeLawVector: ContractVector = Object.freeze({
  id: "store.atomic-install-range-page-presence.v1",
  port: "store",
  behaviors: Object.freeze([
    "object bytes become visible only at an atomic installed name",
    "duplicate install is content-addressed and idempotent",
    "range references preserve exact bytes",
    "listing is sorted, cursor-bound, and paged",
  ]),
  async replay(driver: LawDriver) {
    const findings: string[] = [];
    const trace: LawTraceEntry[] = [];
    const tree = await driver.fixture(Object.freeze({
      kind: "tree",
      name: "store-tree",
      files: Object.freeze([
        Object.freeze({ path: "law/a.bin", bytes: Uint8Array.from([0, 128, 255, 10]) }),
        Object.freeze({ path: "law/b.bin", bytes: Uint8Array.from([4, 3, 2, 1]) }),
      ]),
    }));
    const installTemplate = storeIntentCapsule.arbitrary.validForKind("install-sealed-object", 21);
    if (tree.kind !== "tree" || installTemplate.kind !== "install-sealed-object") {
      return lawTrace("store.atomic-install-range-page-presence.v1", trace, Object.freeze(["store fixture failed"]));
    }
    const install = bindLawIntent("store", Object.freeze({
      inputs: Object.freeze({
        manifest: tree.manifest,
        sealedRoot: tree.root,
        workspaceId: installTemplate.inputs.workspaceId,
      }),
      kind: "install-sealed-object",
      preconditions: Object.freeze({ expectedDigest: tree.root, objectFirst: true }),
      runId: installTemplate.runId,
    }));
    const installed = await lawCall(driver, "store", "install", install, "sealed-object-installed", "ok");
    trace.push(installed.trace);
    collectFinding(findings, installed.finding);
    const duplicateInstall = bindLawIntent("store", Object.freeze({
      inputs: Object.freeze({
        manifest: tree.manifest,
        sealedRoot: tree.root,
        workspaceId: `${installTemplate.inputs.workspaceId}-duplicate`,
      }),
      kind: "install-sealed-object",
      preconditions: Object.freeze({ expectedDigest: tree.root, objectFirst: true }),
      runId: installTemplate.runId,
    }));
    const installedAgain = await lawCall(driver, "store", "install-idempotent", duplicateInstall, "sealed-object-installed", "ok");
    trace.push(installedAgain.trace);
    collectFinding(findings, installedAgain.finding);
    if (field(installedAgain.value, "alreadyPresent") !== true) {
      findings.push("install-idempotent: duplicate content was not reported already present");
    }

    const presence = bindLawIntent("store", Object.freeze({
      inputs: Object.freeze({ root: tree.root }),
      kind: "observe-object-presence",
      preconditions: Object.freeze({ expectedDigest: tree.root }),
      runId: installTemplate.runId,
    }));
    const present = await lawCall(driver, "store", "observe-presence", presence, "object-presence-observed", "ok");
    trace.push(present.trace);
    collectFinding(findings, present.finding);
    if (field(present.value, "present") !== true) {
      findings.push("observe-presence: installed object was not present");
    }

    const range = rangedReference(tree.firstFile, 1, 2);
    const read = bindLawIntent("store", Object.freeze({
      inputs: Object.freeze({ artifact: range }),
      kind: "read-artifact-range",
      preconditions: Object.freeze({ expectedRoot: tree.root }),
      runId: installTemplate.runId,
    }));
    const readResult = await lawCall(driver, "store", "read-range", read, "artifact-range-read", "ok");
    trace.push(readResult.trace);
    collectFinding(findings, readResult.finding);
    const content = json(field(readResult.value, "content"));
    const bytes = content === null ? null : await driver.readArtifact(content);
    if (bytes === null || bytes.length !== 2 || bytes[0] !== 128 || bytes[1] !== 255) {
      findings.push("read-range: exact binary range bytes were not preserved");
    }

    const listTemplate = storeIntentCapsule.arbitrary.validForKind("list-artifact-page", 22);
    if (listTemplate.kind !== "list-artifact-page") {
      findings.push("list template failed");
    } else {
      const list = bindLawIntent("store", Object.freeze({
        inputs: Object.freeze({ cursor: null, directory: "law", pageSize: 1, root: tree.root }),
        kind: "list-artifact-page",
        preconditions: Object.freeze({ expectedRoot: tree.root }),
        runId: installTemplate.runId,
      }));
      const listed = await lawCall(driver, "store", "list-page", list, "artifact-page-listed", "ok");
      trace.push(listed.trace);
      collectFinding(findings, listed.finding);
      const nextCursor = field(listed.value, "nextCursor");
      if (typeof nextCursor !== "string") {
        findings.push("list-page: first one-entry page did not expose a cursor for the second entry");
      } else {
        const entriesRef = json(field(listed.value, "entries"));
        const firstPage = entriesRef === null ? null : await driver.readArtifact(entriesRef);
        const next = bindLawIntent("store", Object.freeze({
          inputs: Object.freeze({ cursor: nextCursor, directory: "law", pageSize: 1, root: tree.root }),
          kind: "list-artifact-page",
          preconditions: Object.freeze({ expectedRoot: tree.root }),
          runId: installTemplate.runId,
        }));
        const nextListed = await lawCall(driver, "store", "list-second-page", next, "artifact-page-listed", "ok");
        trace.push(nextListed.trace);
        collectFinding(findings, nextListed.finding);
        const nextEntriesRef = json(field(nextListed.value, "entries"));
        const secondPage = nextEntriesRef === null ? null : await driver.readArtifact(nextEntriesRef);
        if (
          firstPage === null
          || secondPage === null
          || firstPage.length === 0
          || secondPage.length === 0
          || firstPage.every((byte, index) => byte === secondPage[index])
        ) {
          findings.push("list-page: sorted page contents were absent or repeated");
        }
        if (field(nextListed.value, "nextCursor") !== null) {
          findings.push("list-page: second and final page retained a cursor");
        }
      }
    }
    return lawTrace("store.atomic-install-range-page-presence.v1", trace, findings);
  },
});
