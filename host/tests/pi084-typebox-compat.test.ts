import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";

import { TERMINAL_TOOL_SCHEMAS } from "../../src/generated/tool-schemas.ts";

const root = new URL("../../", import.meta.url);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(bytes: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes);
  assert.equal(isRecord(value), true, `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function requiredKeys(schema: unknown, label: string): string[] {
  assert.equal(isRecord(schema), true, `${label} must be an object schema`);
  const keys = (schema as { required?: unknown }).required;
  assert.equal(Array.isArray(keys), true, `${label}.required must be an array`);
  assert.equal(keys.length > 0, true, `${label} must have required keys`);
  for (const key of keys) assert.equal(typeof key, "string", `${label}.required entries must be strings`);
  return keys as string[];
}

function firstRequiredArrayKey(schema: unknown, label: string): string {
  assert.equal(isRecord(schema), true, `${label} must be an object schema`);
  const properties = (schema as { properties?: unknown }).properties;
  assert.equal(isRecord(properties), true, `${label}.properties must be an object`);
  const found = requiredKeys(schema, label).find((key) => isRecord(properties[key]) && properties[key].type === "array");
  assert.equal(typeof found, "string", `${label} must have a required array container`);
  return found!;
}

const validSamples: Record<string, Record<string, unknown>> = {
  "planning.task-atoms.v1": {
    atoms: [{ id: "atom-1", kind: "work", text: "implement the slice", sources: ["TASK.md"] }],
  },
  "planning.scout-dossier.v1": {
    findings: [{ path: "src/extension.ts", observation: "entrypoint is inert before activation", evidence_ref: "audit#1" }],
  },
  "planning.questions.v1": {
    questions: [{ class: "dod-hole", evidence: "criterion missing", consequence: "cannot validate" }],
  },
  "planning.work-map.v1": {
    units: [{
      id: "unit-1",
      kind: "implementation",
      objective: "fix metadata",
      criteria: ["lock updated"],
      depends_on: [],
      files: ["package.json"],
      commands: [{
        command: "verify-unit --isolated",
        expected: "exit 0",
        effect: "unknown-generated",
        generated_paths: [],
        handling: "run-isolated",
        scope_preservation: "Verification runs outside the candidate repository and preserves approved final scope.",
      }],
      package_checks: [{
        check_id: "PKG-unit-1-TIP",
        kind: "clean-exact-package-tip",
        criterion_ordinals: [1],
        expected: "Core proves the exact clean package tip.",
      }],
      links: ["atom-1"],
    }],
  },
  "planning.plan-review.v1": {
    verdicts: [{ criterion_id: "c-1", verdict: "pass", finding: "covered" }],
  },
  "autopilot.delivery_submission.v2": {
    actual_changed_paths: ["package.json"],
    execution_audit_ref: "reports/pi084.md",
    focused_evidence_refs: ["host/tests/pi084-typebox-compat.test.ts"],
    terminal_status: "succeeded",
    hard_boundary_violations: [],
  },
  "autopilot.validation_submission.v2": {
    schema: "autopilot.validation_submission.v2",
    validation_id: "validation-1",
    assignment_id: "assignment-1",
    scope: "final",
    exact_commit: "HEAD",
    exact_tree: "tree",
    outcome: "PASS",
    criterion_results: [{
      criterion_id: "criterion-1",
      verdict: "PASS",
      evidence_refs: ["evidence#1"],
      finding_ids: [],
      covered_paths: ["package.json"],
      semantic_surface_ids: [],
      forward_edge_ids: [],
      blocker_kind: "missing-evidence",
    }],
    findings: [],
  },
};

const emptyArraySamples: Record<string, Record<string, unknown>> = {
  "planning.task-atoms.v1": { atoms: [] },
  "planning.scout-dossier.v1": { findings: [] },
  "planning.questions.v1": { questions: [] },
  "planning.work-map.v1": { units: [] },
  "planning.plan-review.v1": { verdicts: [] },
  "autopilot.delivery_submission.v2": {
    actual_changed_paths: [],
    execution_audit_ref: "reports/pi084.md",
    focused_evidence_refs: [],
    terminal_status: "succeeded",
    hard_boundary_violations: [],
  },
  "autopilot.validation_submission.v2": {
    schema: "autopilot.validation_submission.v2",
    validation_id: "validation-1",
    assignment_id: "assignment-1",
    scope: "final",
    exact_commit: "HEAD",
    exact_tree: "tree",
    outcome: "PASS",
    criterion_results: [],
    findings: [],
  },
};

test("Pi 0.84 package metadata keeps Pi SDK and TypeBox as public peers only", async () => {
  const pkg = readJsonRecord(await readFile(new URL("package.json", root), "utf8"), "package.json");
  const lock = readJsonRecord(await readFile(new URL("package-lock.json", root), "utf8"), "package-lock.json");
  assert.deepEqual(pkg.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    typebox: "*",
  });
  assert.equal(isRecord(pkg.dependencies) && "typebox" in pkg.dependencies, false, "typebox must not be a runtime dependency");
  assert.equal(Array.isArray(pkg.bundledDependencies) && pkg.bundledDependencies.includes("typebox"), false, "typebox must not be bundled");
  assert.equal((pkg.devDependencies as Record<string, unknown>)["@earendil-works/pi-coding-agent"], "0.84.0");
  assert.equal((pkg.devDependencies as Record<string, unknown>).typebox, "1.3.7");

  assert.equal(isRecord(lock.packages), true, "lock.packages must be an object");
  const packages = lock.packages as Record<string, Record<string, unknown>>;
  const rootLock = packages[""]!;
  assert.deepEqual(rootLock.peerDependencies, pkg.peerDependencies);
  assert.equal(isRecord(rootLock.dependencies) && "typebox" in rootLock.dependencies, false, "lock root must not have runtime typebox");
  assert.equal((rootLock.devDependencies as Record<string, unknown>)["@earendil-works/pi-coding-agent"], "0.84.0");
  assert.equal((rootLock.devDependencies as Record<string, unknown>).typebox, "1.3.7");
  assert.equal(packages["node_modules/@earendil-works/pi-coding-agent"]?.version, "0.84.0");
  assert.equal(packages["node_modules/typebox"]?.version, "1.3.7");
  assert.equal(packages["node_modules/@earendil-works/pi-coding-agent/node_modules/typebox"]?.version, "1.3.7");
});

test("Pi 0.84 Bash adapter preserves the hidden-shell no-session-environment boundary", async () => {
  const sessionKeys = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;
  const previous = new Map(sessionKeys.map((key) => [key, process.env[key]]));
  let observed: { command: string; cwd: string; env: NodeJS.ProcessEnv } | undefined;
  try {
    for (const key of sessionKeys) process.env[key] = `ambient-${key.toLowerCase()}`;
    const tool = createBashTool("/fixed-package-worktree", {
      exposeSessionEnvironment: false,
      operations: {
        async exec(command, cwd, options) {
          observed = { command, cwd, env: { ...options.env } };
          options.onData(Buffer.from("approved output\n"));
          return { exitCode: 0 };
        },
      },
    });
    assert.equal(tool.promptGuidelines, undefined, "disabled session exposure must not advertise PI_* inspection");
    const result = await tool.execute(
      "pi084-approved-command",
      { command: "cargo test --locked" },
      undefined,
      undefined,
      {
        sessionManager: { getSessionId: () => "secret-session", getSessionFile: () => "/secret/session.jsonl" },
        model: { provider: "secret-provider", id: "secret-model" },
        thinkingLevel: "secret-level",
      },
    ) as { content: Array<{ type: string; text: string }> };
    assert.deepEqual({ command: observed?.command, cwd: observed?.cwd }, {
      command: "cargo test --locked",
      cwd: "/fixed-package-worktree",
    });
    for (const key of sessionKeys) assert.equal(observed?.env[key], undefined, `${key} must be stripped before execution`);
    assert.equal(result.content[0]?.text, "approved output\n");
  } finally {
    for (const key of sessionKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("TypeBox 1.3.7 under Pi 0.84 compiles every terminal schema with strict null/array semantics", () => {
  const entries = Object.entries(TERMINAL_TOOL_SCHEMAS);
  assert.equal(entries.length, 7, "all terminal boundary schemas must be covered");
  for (const [boundary, descriptor] of entries) {
    const valid = validSamples[boundary];
    const empty = emptyArraySamples[boundary];
    assert.ok(valid, `missing valid sample for ${boundary}`);
    assert.ok(empty, `missing empty-array sample for ${boundary}`);
    const check = Compile(descriptor.parameters);
    const required = requiredKeys(descriptor.parameters, boundary);
    const arrayKey = firstRequiredArrayKey(descriptor.parameters, boundary);

    const omitted = clone(valid); delete omitted[required[0]!];
    assert.equal(check.Check(omitted), false, `${boundary}: omitted required container must fail`);

    const nullArray = clone(valid); nullArray[arrayKey] = null;
    assert.equal(check.Check(nullArray), false, `${boundary}: null array container must fail`);

    assert.equal(check.Check(clone(empty)), true, `${boundary}: empty arrays remain valid`);
    assert.equal(check.Check(clone(valid)), true, `${boundary}: valid sample must pass`);

    const nullItem = clone(valid); nullItem[arrayKey] = [null];
    assert.equal(check.Check(nullItem), false, `${boundary}: [null] array item must fail`);

    const wrongScalar = clone(valid); wrongScalar[required[0]!] = 42;
    assert.equal(check.Check(wrongScalar), false, `${boundary}: wrong scalar top value must fail`);

    const wrongObjectItem = clone(valid); wrongObjectItem[arrayKey] = [{}];
    assert.equal(check.Check(wrongObjectItem), false, `${boundary}: wrong object/missing item fields must fail`);

    const extra = { ...clone(valid), unexpected_pi084_field: true };
    assert.equal(check.Check(extra), descriptor.parameters.additionalProperties !== false, `${boundary}: extra top field must match schema additionalProperties`);
  }

  const planReview = Compile(TERMINAL_TOOL_SCHEMAS["planning.plan-review.v1"].parameters);
  assert.equal(planReview.Check({ verdicts: [{ criterion_id: "c-1", verdict: "pass" }] }), true, "optional finding omitted must pass");
  assert.equal(planReview.Check({ verdicts: [{ criterion_id: "c-1", verdict: "pass", finding: null }] }), false, "optional finding null must fail");

  const validation = Compile(TERMINAL_TOOL_SCHEMAS["autopilot.validation_submission.v2"].parameters);
  const withoutBlockerKind = clone(validSamples["autopilot.validation_submission.v2"]);
  delete ((withoutBlockerKind.criterion_results as Record<string, unknown>[])[0]!).blocker_kind;
  assert.equal(validation.Check(withoutBlockerKind), true, "optional blocker_kind omitted must pass");
  const nullBlockerKind = clone(validSamples["autopilot.validation_submission.v2"]);
  ((nullBlockerKind.criterion_results as Record<string, unknown>[])[0]!).blocker_kind = null;
  assert.equal(validation.Check(nullBlockerKind), false, "optional blocker_kind null must fail");
});
