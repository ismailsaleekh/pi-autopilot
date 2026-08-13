import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  amendmentApprovalGranted,
  amendmentMarkerRelativePath,
  parseArchitectureAmendmentMarkdown,
  validateArchitectureAmendmentScope,
} from "./amendment-marker.js";
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
import { resolveGovernanceBaseline } from "./governance-baseline.js";
import { runNegativeCompileFixtures } from "./negative-compile.js";
import { checkPayloadShapes } from "./payload-checker.js";
import {
  checkProtectedFiles,
  checkRepositoryProtection,
  contentDigest,
} from "./protection-checker.js";
import type { ProtectionManifest } from "./protection-checker.js";
import {
  checkSuiteManifest,
  decodeSuiteManifest,
  registeredSuiteCommands,
} from "./suite-manifest-checker.js";
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

function runFixtureGit(directory: string, arguments_: readonly string[]): void {
  const child = spawnSync("git", ["-C", directory, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(child.status, 0, typeof child.stderr === "string" ? child.stderr : "git fixture failed");
}

function protectionFixtureText(entries: readonly { readonly path: string; readonly text: string }[]): string {
  const files: Record<string, string> = Object.create(null);
  for (const entry of entries.slice().sort((left, right) => left.path.localeCompare(right.path))) {
    files[entry.path] = contentDigest(entry.text);
  }
  const unsigned = `${JSON.stringify({ format: 1, files }, null, 2)}\n`;
  files["policy-root/protected-files.json"] = contentDigest(unsigned);
  return `${JSON.stringify({ format: 1, files }, null, 2)}\n`;
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

test("project graph covers referenced production and testkit real-adapters, and rejects orphan source", () => {
  temporaryDirectory((directory) => {
    mkdirSync(join(directory, "authority"), { recursive: true });
    mkdirSync(join(directory, "testkit", "real-adapters"), { recursive: true });
    mkdirSync(join(directory, "dist", "authority"), { recursive: true });
    mkdirSync(join(directory, "dist-testkit", "testkit", "real-adapters"), { recursive: true });
    writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
      files: [],
      references: [{ path: "./authority" }, { path: "./testkit" }],
    }));
    writeFileSync(join(directory, "authority", "tsconfig.json"), JSON.stringify({
      compilerOptions: strictCompilerOptions,
      include: ["**/*.ts"],
    }));
    writeFileSync(join(directory, "testkit", "tsconfig.json"), JSON.stringify({
      compilerOptions: strictCompilerOptions,
      include: ["**/*.ts"],
    }));
    writeFileSync(join(directory, "authority", "good.ts"), "export const good = 1;\n");
    writeFileSync(join(directory, "testkit", "real-adapters", "covered.test.ts"), "export const covered = true;\n");
    writeFileSync(join(directory, "dist", "authority", "good.js"), "export const good = 1;\n");
    writeFileSync(
      join(directory, "dist-testkit", "testkit", "real-adapters", "covered.test.js"),
      "export const covered = true;\n",
    );
    assert.equal(collectActualUnits(directory).projectFindings.length, 0);
    mkdirSync(join(directory, "runtime"));
    writeFileSync(join(directory, "runtime", "orphan.ts"), "export const orphan = 1;\n");
    assert.equal(collectActualUnits(directory).projectFindings.length > 0, true);
  });
});

test("compiler baseline accepts every strict referenced layer and rejects DOM authority", () => {
  temporaryDirectory((directory) => {
    const config = JSON.stringify({ compilerOptions: strictCompilerOptions });
    for (const project of ["authority", "ports", "storage", "runtime", "adapters", "apps", "testkit"]) {
      mkdirSync(join(directory, project), { recursive: true });
      writeFileSync(join(directory, project, "tsconfig.json"), config);
    }
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

test("two-phase one-append-edge law accepts pre-loop zero edge, rejects early edge, and enforces transition", () => {
  const journal = Object.freeze({
    path: "storage/journal/append.ts",
    text: "export function appendCommittedBatch(): void {}\n",
  });
  const commitLoop = Object.freeze({
    path: "runtime/commit-loop/commit.ts",
    text: "import { appendCommittedBatch } from '../../storage/journal/append.js'; export function commit(): void { appendCommittedBatch(); }\n",
  });
  assert.equal(rulesFor(Object.freeze([journal])).has("one-append-edge"), false);
  assert.equal(rulesFor(Object.freeze([
    journal,
    Object.freeze({
      path: "apps/worker/early.ts",
      text: "import { appendCommittedBatch } from '../../storage/journal/append.js'; appendCommittedBatch();\n",
    }),
  ])).has("one-append-edge"), true);
  assert.equal(rulesFor(Object.freeze([journal, commitLoop])).has("one-append-edge"), false);
  assert.equal(rulesFor(Object.freeze([
    journal,
    Object.freeze({ path: "runtime/commit-loop/empty.ts", text: "export const commitLoop = true;\n" }),
  ])).has("one-append-edge"), true);
  assert.equal(rulesFor(Object.freeze([
    journal,
    commitLoop,
    Object.freeze({
      path: "apps/worker/bad.ts",
      text: "import { appendCommittedBatch } from '../../storage/journal/append.js'; appendCommittedBatch();\n",
    }),
  ])).has("one-append-edge"), true);
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
  const typeConsumer = rulesFor(oneFile(
    "runtime/commit-loop/good.ts",
    "import type { AcceptedBatch } from '../../authority/protocol/accepted-batch.js'; export type Input = AcceptedBatch;\n",
  ));
  assert.equal(typeConsumer.has("constructor-capabilities"), false);
  const aliasedMint = rulesFor(oneFile(
    "apps/worker/bad-mint.ts",
    "import { mintAcceptedBatch as bypass } from '../../authority/protocol/accepted-batch.js'; void bypass;\n",
  ));
  assert.equal(aliasedMint.has("constructor-capabilities"), true);
  const facadeMint = rulesFor(oneFile(
    "authority/facade/good.ts",
    "import { mintAcceptedBatch } from '../protocol/accepted-batch.js'; void mintAcceptedBatch;\n",
  ));
  assert.equal(facadeMint.has("constructor-capabilities"), false);
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

test("suite command schema requires commands for registered, forbids them for pending, and exposes every registration", () => {
  const ids = [
    "D2.1-replay-determinism", "D2.2-full-run-scenarios", "D2.3-crash-matrix",
    "D2.4-third-outcome-hunt", "D2.5-idempotency", "D2.6-totality-fuzzing",
    "D2.7-yardstick-properties", "D3.1-adapter-contract-parity", "D3.2-journal-durability",
    "D3.3-real-git", "D3.4-process-reality", "D3.5-sandbox", "D3.6-scale",
    "D3.7-real-pi", "D3.8-w0-replay-corpus",
  ];
  const pending = decodeSuiteManifest({
    format: 1,
    suites: ids.map((id) => ({ id, owner: "lane", registration: "pending" })),
  });
  assert.notEqual(pending, null);
  if (pending !== null) {
    assert.equal(checkSuiteManifest(pending, false).length, 0);
    assert.equal(checkSuiteManifest(pending, true).length > 0, true);
    assert.deepEqual(registeredSuiteCommands(pending), []);
  }
  const registered = decodeSuiteManifest({
    format: 1,
    suites: ids.map((id) => ({ id, owner: "lane", registration: "registered", command: `node ${id}.js` })),
  });
  assert.notEqual(registered, null);
  if (registered !== null) {
    assert.equal(checkSuiteManifest(registered, true).length, 0);
    assert.deepEqual(registeredSuiteCommands(registered).map((suite) => suite.id), ids);
  }
  assert.equal(decodeSuiteManifest({
    format: 1,
    suites: [{ id: ids[0], owner: "lane", registration: "registered" }],
  }), null);
  assert.equal(decodeSuiteManifest({
    format: 1,
    suites: [{ id: ids[0], owner: "lane", registration: "pending", command: "node bad.js" }],
  }), null);
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
  assert.equal(checkProtectedFiles(
    nextRoot,
    fixtureManifest,
    Object.freeze([]),
    Object.freeze(["policy-root/fixtures/protected-good.json"]),
  ).length, 0);
});

test("incident-w1-l3-self-certification.rejected", () => {
  temporaryDirectory((directory) => {
    const fixtureNext = join(directory, "next");
    const fixturePolicy = join(fixtureNext, "policy-root");
    mkdirSync(fixturePolicy, { recursive: true });
    const checkerPath = "policy-root/protection-checker.ts";
    const suitePath = "policy-root/required-suites.json";
    const fingerprintPath = "policy-root/protocol-fingerprints.json";
    const gatePath = "policy-root/w0-gate.ts";
    const baselineChecker = "export const protectedGate = true;\n";
    const baselineSuites = "{\"suites\":[]}\n";
    const baselineFingerprints = "{\"format\":1}\n";
    const baselineGate = "export const runDefaultGate = true;\n";
    writeFileSync(join(fixtureNext, checkerPath), baselineChecker);
    writeFileSync(join(fixtureNext, suitePath), baselineSuites);
    writeFileSync(join(fixtureNext, fingerprintPath), baselineFingerprints);
    writeFileSync(join(fixtureNext, gatePath), baselineGate);
    writeFileSync(
      join(fixturePolicy, "protected-files.json"),
      protectionFixtureText(Object.freeze([
        Object.freeze({ path: checkerPath, text: baselineChecker }),
        Object.freeze({ path: fingerprintPath, text: baselineFingerprints }),
        Object.freeze({ path: gatePath, text: baselineGate }),
        Object.freeze({ path: suitePath, text: baselineSuites }),
      ])),
    );
    runFixtureGit(directory, ["init", "--quiet"]);
    runFixtureGit(directory, ["config", "user.name", "governance fixture"]);
    runFixtureGit(directory, ["config", "user.email", "governance-fixture@example.invalid"]);
    runFixtureGit(directory, ["add", "."]);
    runFixtureGit(directory, ["commit", "--quiet", "-m", "trusted baseline"]);
    runFixtureGit(directory, ["tag", "w0-trusted-baseline"]);
    const fixtureCommit = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

    const required = Object.freeze([checkerPath, fingerprintPath, gatePath, suitePath]);
    assert.deepEqual(checkRepositoryProtection(fixtureNext, required, fixtureCommit), []);

    const tamperedChecker = "export const protectedGate = false;\n";
    writeFileSync(join(fixtureNext, checkerPath), tamperedChecker);
    writeFileSync(join(fixtureNext, suitePath), "{\"suites\":[{\"skipped\":true}]}\n");
    writeFileSync(join(fixtureNext, fingerprintPath), "{\"format\":999}\n");
    writeFileSync(join(fixtureNext, gatePath), "export const runDefaultGate = false;\n");
    writeFileSync(
      join(fixturePolicy, "protected-files.json"),
      protectionFixtureText(Object.freeze([
        Object.freeze({ path: checkerPath, text: tamperedChecker }),
      ])),
    );
    const findings = checkRepositoryProtection(fixtureNext, required, fixtureCommit);
    assert.equal(findings.some((finding) => finding.path === checkerPath), true);
    assert.equal(findings.some((finding) => finding.path === fingerprintPath), true);
    assert.equal(findings.some((finding) => finding.path === gatePath), true);
    assert.equal(findings.some((finding) => finding.path === suitePath), true);
    assert.equal(
      findings.some((finding) => finding.detail.includes("cannot self-certify")),
      true,
    );
  });
});

test("governance tags accept trusted bootstrap and reject a manually-created lightweight successor", () => {
  temporaryDirectory((directory) => {
    const fixtureNext = join(directory, "next");
    mkdirSync(join(fixtureNext, "policy-root"), { recursive: true });
    writeFileSync(join(fixtureNext, "policy-root", "protected-files.json"), "{}\n");
    runFixtureGit(directory, ["init", "--quiet"]);
    runFixtureGit(directory, ["config", "user.name", "governance fixture"]);
    runFixtureGit(directory, ["config", "user.email", "governance-fixture@example.invalid"]);
    runFixtureGit(directory, ["add", "."]);
    runFixtureGit(directory, ["commit", "--quiet", "-m", "trusted baseline"]);
    runFixtureGit(directory, ["tag", "w0-trusted-baseline"]);
    const fixtureCommit = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    assert.notEqual(resolveGovernanceBaseline(fixtureNext, fixtureCommit).baseline, null);
    assert.equal(resolveGovernanceBaseline(fixtureNext, "0".repeat(40)).baseline, null);
    runFixtureGit(directory, ["tag", "governance-baseline-001"]);
    const rejected = resolveGovernanceBaseline(fixtureNext, fixtureCommit);
    assert.equal(rejected.baseline, null);
    assert.equal(rejected.findings.some((finding) => finding.includes("annotated tag")), true);
  });
});

test("amendment protocol requires flag, approval environment, exact marker scope, and old/new fingerprints", () => {
  assert.equal(amendmentApprovalGranted(["node", "tool"], "1"), false);
  assert.equal(amendmentApprovalGranted(["node", "tool", "--approved-amendment"], undefined), false);
  assert.equal(amendmentApprovalGranted(["node", "tool", "--approved-amendment"], "1"), true);

  const markerPath = amendmentMarkerRelativePath("001");
  const protectedFiles = Object.freeze([markerPath, "policy-root/protection-checker.ts"].sort());
  const markerText = `# Architecture Amendment 001\n\n\`\`\`architecture-amendment\n${JSON.stringify({
    format: 1,
    id: "001",
    operatorApproval: "operator-approved W1-R recovery prompt",
    rationale: "Close mutable-manifest self-certification.",
    protectedFiles,
    fingerprintChanges: [],
  })}\n\`\`\`\n`;
  const marker = parseArchitectureAmendmentMarkdown(markerText, "001");
  assert.notEqual(marker, null);
  if (marker !== null) {
    assert.deepEqual(validateArchitectureAmendmentScope(marker, protectedFiles, Object.freeze([])), []);
    assert.equal(validateArchitectureAmendmentScope(
      marker,
      Object.freeze([...protectedFiles, "policy-root/w0-gate.ts"].sort()),
      Object.freeze([]),
    ).length > 0, true);
  }
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
    ["accepted-batch-factory.compile-fail.ts", 2345],
    ["accepted-batch.compile-fail.ts", 2739],
    ["domain-fact-handler.compile-fail.ts", 1360],
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
