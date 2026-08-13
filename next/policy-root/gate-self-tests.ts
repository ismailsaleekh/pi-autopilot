import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";
import {
  checkArchitectureUnits,
  checkCompilerBaseline,
  checkLegacyReferenceText,
  collectActualUnits,
  fixtureUnits,
} from "./architecture-checker.js";
import { checkHygiene } from "./hygiene-checker.js";
import {
  checkFingerprintChange,
  currentFingerprintManifest,
  diffFingerprints,
} from "./fingerprint-checker.js";
import { runNegativeCompileFixtures } from "./negative-compile.js";
import { checkPayloadShapes } from "./payload-checker.js";
import {
  checkProtectedFiles,
  contentDigest,
} from "./protection-checker.js";
import type { ProtectionManifest } from "./protection-checker.js";
import { checkSuiteManifest, decodeSuiteManifest } from "./suite-manifest-checker.js";
import { scanSuppressionText } from "./suppression-checker.js";
import { defineCapsule, literal, object, union } from "../authority/protocol/schema.js";

const modulePolicyRoot = dirname(fileURLToPath(import.meta.url));
const moduleParent = dirname(modulePolicyRoot);
const nextRoot = basename(moduleParent) === "dist-policy" ? dirname(moduleParent) : moduleParent;
const policyRoot = join(nextRoot, "policy-root");

function rulesFor(files: Readonly<{ readonly path: string; readonly text: string }[]>): ReadonlySet<string> {
  return new Set(checkArchitectureUnits(fixtureUnits(files)).map((finding) => finding.rule));
}

function oneFile(path: string, text: string): ReadonlyArray<{ readonly path: string; readonly text: string }> {
  return Object.freeze([Object.freeze({ path, text })]);
}

function temporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-autopilot-w0-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

const strictCompilerOptions = Object.freeze({
  composite: true,
  exactOptionalPropertyTypes: true,
  lib: ["ES2022"],
  noFallthroughCasesInSwitch: true,
  noImplicitReturns: true,
  noUncheckedIndexedAccess: true,
  strict: true,
  types: [],
  useUnknownInCatchVariables: true,
});

test("project graph accepts referenced fresh emission and rejects orphan source", () => {
  temporaryDirectory((directory) => {
    mkdirSync(join(directory, "authority"), { recursive: true });
    mkdirSync(join(directory, "dist", "authority"), { recursive: true });
    writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./authority" }] }));
    writeFileSync(join(directory, "authority", "tsconfig.json"), JSON.stringify({
      compilerOptions: strictCompilerOptions,
      include: ["**/*.ts"],
    }));
    writeFileSync(join(directory, "authority", "good.ts"), "export const good = 1;\n");
    writeFileSync(join(directory, "dist", "authority", "good.js"), "export const good = 1;\n");
    assert.equal(collectActualUnits(directory).projectFindings.length, 0);
    mkdirSync(join(directory, "runtime"));
    writeFileSync(join(directory, "runtime", "orphan.ts"), "export const orphan = 1;\n");
    assert.equal(collectActualUnits(directory).projectFindings.length > 0, true);
  });
});

test("compiler baseline accepts strict projects and rejects DOM authority", () => {
  temporaryDirectory((directory) => {
    mkdirSync(join(directory, "authority"), { recursive: true });
    mkdirSync(join(directory, "ports"), { recursive: true });
    const config = JSON.stringify({ compilerOptions: strictCompilerOptions });
    writeFileSync(join(directory, "authority", "tsconfig.json"), config);
    writeFileSync(join(directory, "ports", "tsconfig.json"), config);
    writeFileSync(join(directory, "tsconfig.tests.json"), config);
    writeFileSync(join(directory, "tsconfig.policy.json"), config);
    assert.equal(checkCompilerBaseline(directory).length, 0);
    writeFileSync(join(directory, "authority", "tsconfig.json"), JSON.stringify({
      compilerOptions: { ...strictCompilerOptions, lib: ["ES2022", "DOM"] },
    }));
    assert.equal(checkCompilerBaseline(directory).length > 0, true);
  });
});

test("authority purity accepts pure code and rejects ambient effects", () => {
  assert.equal(rulesFor(oneFile("authority/model/good.ts", "export const fold = (value: number): number => value + 1;\n")).has("authority-purity"), false);
  assert.equal(rulesFor(oneFile("authority/model/bad.ts", "export async function bad(): Promise<number> { return Date.now(); }\n")).has("authority-purity"), true);
  assert.equal(rulesFor(oneFile("authority/model/bad-constructor.ts", "declare function defineCapsule(): unknown; export const bad = defineCapsule();\n")).has("authority-purity"), true);
});

test("one append edge accepts commit-loop and rejects a second caller", () => {
  const good = rulesFor(Object.freeze([
    Object.freeze({ path: "storage/journal/append.ts", text: "export function appendCommittedBatch(): void {}\n" }),
    Object.freeze({ path: "runtime/commit-loop/commit.ts", text: "import { appendCommittedBatch } from '../../storage/journal/append.js'; export function commit(): void { appendCommittedBatch(); }\n" }),
  ]));
  assert.equal(good.has("one-append-edge"), false);
  const bad = rulesFor(Object.freeze([
    Object.freeze({ path: "storage/journal/append.ts", text: "export function appendCommittedBatch(): void {}\n" }),
    Object.freeze({ path: "runtime/commit-loop/commit.ts", text: "import { appendCommittedBatch } from '../../storage/journal/append.js'; export function commit(): void { appendCommittedBatch(); }\n" }),
    Object.freeze({ path: "apps/worker/bad.ts", text: "import { appendCommittedBatch } from '../../storage/journal/append.js'; appendCommittedBatch();\n" }),
  ]));
  assert.equal(bad.has("one-append-edge"), true);
});

test("adapters are leaves", () => {
  assert.equal(rulesFor(oneFile("adapters/git/good.ts", "import type { GitIntent } from '../../ports/contracts/git.capsule.js'; export type Input = GitIntent;\n")).has("adapters-are-leaves"), false);
  assert.equal(rulesFor(oneFile("adapters/git/bad.ts", "import { prepare } from '../../authority/facade/index.js'; setTimeout(prepare, 1);\n")).has("adapters-are-leaves"), true);
});

test("constructor capabilities accept owners and reject outsiders", () => {
  const owner = rulesFor(oneFile("authority/outcome/good.ts", "export const complete = { kind: 't1', finalTree: 'x' };\n"));
  assert.equal(owner.has("constructor-capabilities"), false);
  const outsider = rulesFor(oneFile("runtime/commit-loop/bad.ts", "import type { TerminalOutcome } from '../../authority/protocol/terminal-outcome.capsule.js'; const value: TerminalOutcome = { kind: 't1', finalTree: 'x' }; void value;\n"));
  assert.equal(outsider.has("constructor-capabilities"), true);
  const evidence = rulesFor(oneFile("apps/worker/bad.ts", "import type { EvidenceEnvelope } from '../../authority/protocol/evidence-fact.capsule.js'; const value: EvidenceEnvelope = { actionId: 'x' }; void value;\n"));
  assert.equal(evidence.has("constructor-capabilities"), true);
  const batch = rulesFor(oneFile("runtime/commit-loop/bad.ts", "interface AcceptedBatch { readonly value: string } const batch: AcceptedBatch = { value: 'x' }; void batch;\n"));
  assert.equal(batch.has("constructor-capabilities"), true);
});

test("extensions import SDK only", () => {
  assert.equal(rulesFor(oneFile("extensions/roles/good.ts", "import type { Descriptor } from '../sdk/index.js'; export type Role = Descriptor;\n")).has("extensions-sdk-only"), false);
  assert.equal(rulesFor(oneFile("extensions/roles/bad.ts", "import { append } from '../../storage/journal/index.js'; append();\n")).has("extensions-sdk-only"), true);
});

test("durable writes are restricted", () => {
  assert.equal(rulesFor(oneFile("storage/cas/good.ts", "import { writeFileSync } from 'node:fs'; export function install(): void { writeFileSync('x', 'y'); }\n")).has("durable-write-boundary"), false);
  assert.equal(rulesFor(oneFile("apps/relay/bad.ts", "import { writeFileSync } from 'node:fs'; writeFileSync('status', 'x');\n")).has("durable-write-boundary"), true);
});

test("boundary entry accepts unknown decoder and rejects direct parse", () => {
  assert.equal(rulesFor(oneFile("runtime/boundary-codecs/good.ts", "export function decode(input: unknown): unknown { return input; }\n")).has("boundary-entry"), false);
  assert.equal(rulesFor(oneFile("apps/relay/bad.ts", "export const value = JSON.parse('{}');\n")).has("boundary-entry"), true);
});

test("old and new implementation trees are isolated", () => {
  assert.equal(rulesFor(oneFile("runtime/dispatcher/good.ts", "import type { Command } from '../../authority/protocol/command.capsule.js'; export type Value = Command;\n")).has("old-new-isolation"), false);
  assert.equal(rulesFor(oneFile("runtime/dispatcher/bad.ts", "import { old } from '../../../../src/old.js'; old();\n")).has("old-new-isolation"), true);
  assert.equal(checkLegacyReferenceText("../package.json", "{ \"main\": \"dist/index.js\" }").length, 0);
  assert.equal(checkLegacyReferenceText("../package.json", "{ \"main\": \"next/apps/worker.js\" }").length, 1);
});

test("suppression scanner accepts strict source and rejects every escape hatch", () => {
  assert.equal(scanSuppressionText("good.ts", "const value = { key: 1 } as const;\n").length, 0);
  const bad = scanSuppressionText("bad.ts", "// @ts-ignore\n// @ts-expect-error\nconst x: any = value as string;\nconst y = x!;\n");
  assert.deepEqual(new Set(bad.map((finding) => finding.kind)), new Set(["ts-ignore", "ts-expect-error", "any", "as-cast", "non-null"]));
});

test("fingerprints accept exact baseline and reject changes without amendment", () => {
  const originalCapsule = defineCapsule("FixtureUnion", union([object({ kind: literal("one") }), object({ kind: literal("two") })]));
  const changedCapsule = defineCapsule("FixtureUnion", union([object({ kind: literal("one") }), object({ kind: literal("two") }), object({ kind: literal("three") })]));
  const expected = currentFingerprintManifest(Object.freeze([originalCapsule]));
  const unchanged = currentFingerprintManifest(Object.freeze([originalCapsule]));
  const changed = currentFingerprintManifest(Object.freeze([changedCapsule]));
  assert.equal(diffFingerprints(expected, unchanged).length, 0);
  assert.equal(checkFingerprintChange(expected, changed, Object.freeze([])).length > 0, true);
  assert.equal(checkFingerprintChange(expected, changed, Object.freeze(["ARCHITECTURE-AMENDMENT-test.md"])).length > 0, true);
});

test("third terminal variant changes fingerprint and fails compilation", () => {
  const two = currentFingerprintManifest(Object.freeze([
    defineCapsule("TerminalOutcome", union([object({ kind: literal("t1") }), object({ kind: literal("t2") })])),
  ]));
  const three = currentFingerprintManifest(Object.freeze([
    defineCapsule("TerminalOutcome", union([object({ kind: literal("t1") }), object({ kind: literal("t2") }), object({ kind: literal("blocked") })])),
  ]));
  assert.equal(diffFingerprints(two, three).length, 1);
  const compiled = runNegativeCompileFixtures(join(policyRoot, "fixtures"));
  const terminal = compiled.find((fixture) => fixture.path.endsWith("third-terminal.compile-fail.ts"));
  assert.equal(terminal?.failedAsRequired, true);
});

test("required-suite manifest accepts complete skeleton and rejects missing/skipped registered suite", () => {
  const complete = decodeSuiteManifest({
    format: 1,
    suites: [
      "D2.1-replay-determinism", "D2.2-full-run-scenarios", "D2.3-crash-matrix",
      "D2.4-third-outcome-hunt", "D2.5-idempotency", "D2.6-totality-fuzzing",
      "D2.7-yardstick-properties", "D3.1-adapter-contract-parity", "D3.2-journal-durability",
      "D3.3-real-git", "D3.4-process-reality", "D3.5-sandbox", "D3.6-scale",
      "D3.7-real-pi", "D3.8-w0-replay-corpus",
    ].map((id) => ({ id, owner: "lane", registration: "pending" })),
  });
  assert.notEqual(complete, null);
  if (complete !== null) {
    assert.equal(checkSuiteManifest(complete, false).length, 0);
    assert.equal(checkSuiteManifest(complete, true).length > 0, true);
  }
  const incomplete = decodeSuiteManifest({ format: 1, suites: [] });
  assert.notEqual(incomplete, null);
  if (incomplete !== null) {
    assert.equal(checkSuiteManifest(incomplete, false).length > 0, true);
  }
});

test("policy protection accepts baseline and rejects unmarked change", () => {
  const manifest: ProtectionManifest = Object.freeze({
    format: 1,
    files: Object.freeze({ "policy-root/required-suites.json": contentDigest("baseline") }),
  });
  assert.equal(checkProtectedFiles(nextRoot, manifest, Object.freeze([])).length > 0, true);
  const actualText = "{\n  \"fixture\": true\n}\n";
  const fixtureManifest: ProtectionManifest = Object.freeze({
    format: 1,
    files: Object.freeze({ "policy-root/fixtures/protected-good.json": contentDigest(actualText) }),
  });
  assert.equal(checkProtectedFiles(nextRoot, fixtureManifest, Object.freeze([])).length, 0);
});

test("hygiene accepts finished files and rejects unfinished-work markers", () => {
  assert.equal(checkHygiene(nextRoot).length, 0);
  const unfinishedWord = `FIX${"ME"}`;
  const markerRule = new RegExp(`\\b${unfinishedWord}\\b`, "i");
  assert.equal(markerRule.test("finished implementation"), false);
  assert.equal(markerRule.test(`${unfinishedWord} repair later`), true);
});

test("payload shape gate accepts contracts and rejects open bags", () => {
  assert.equal(checkPayloadShapes(nextRoot).length, 0);
  const forbidden = /Record\s*<\s*string\s*,\s*unknown\s*>/;
  assert.equal(forbidden.test("type Explicit = { readonly value: string }"), false);
  assert.equal(forbidden.test("type Open = Record<string, unknown>"), true);
});

test("negative compilation fixtures all fire for their intended reason", () => {
  const results = runNegativeCompileFixtures(join(policyRoot, "fixtures"));
  const expectedCodes = new Map([
    ["accepted-batch.compile-fail.ts", 2741],
    ["evidence-envelope.compile-fail.ts", 2741],
    ["exhaustiveness.compile-fail.ts", 1360],
    ["third-terminal.compile-fail.ts", 2322],
  ]);
  assert.equal(results.length, expectedCodes.size);
  for (const result of results) {
    assert.equal(result.failedAsRequired, true, result.path);
    const name = result.path.slice(result.path.lastIndexOf("/") + 1);
    assert.deepEqual(result.diagnosticCodes, [expectedCodes.get(name)], result.path);
  }
});
