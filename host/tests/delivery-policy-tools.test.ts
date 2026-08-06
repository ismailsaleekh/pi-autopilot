import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  APPROVED_COMMAND_TOOL,
  createDeliveryWriteOperations,
  DELIVERY_POLICY_VERSION,
  deliveryPolicyDigest,
  loadDeliveryPolicyFromEnv,
  registerDeliveryPolicyTools,
  type DeliveryPolicy,
} from "../../child-runtime/child-extension-runtime.ts";

type RegisteredTool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  execute(id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<unknown>;
};

type Fixture = {
  root: string;
  worktree: string;
  foreign: string;
  assignmentPath: string;
  env: Record<string, string>;
  policy: DeliveryPolicy;
  tools: Map<string, RegisteredTool>;
};

const roots: string[] = [];

test("delivery policy confines edit/write and package-approved command references", { concurrency: false }, async () => {
  const fixture = makeFixture();
  try {
    const write = fixture.tools.get("write")!;
    const edit = fixture.tools.get("edit")!;
    const approvedCommand = fixture.tools.get(APPROVED_COMMAND_TOOL)!;
    assert.equal(fixture.tools.has("bash"), false);
    const approvedMetadata = JSON.stringify({
      description: approvedCommand.description,
      promptSnippet: approvedCommand.promptSnippet,
      promptGuidelines: approvedCommand.promptGuidelines,
      parameters: approvedCommand.parameters,
    });
    assert.match(approvedMetadata, /CMD-U1-1/);
    assert.doesNotMatch(approvedMetadata, /PI_/);
    assert.doesNotMatch(approvedMetadata, /Bash command|bash commands/);

    await write.execute("write-ok", { path: "src/lib.rs", content: "pub fn ok() {}\n" });
    assert.equal(readFileSync(join(fixture.worktree, "src/lib.rs"), "utf8"), "pub fn ok() {}\n");
    await edit.execute("edit-ok", {
      path: "src/lib.rs",
      edits: [{ oldText: "pub fn ok() {}", newText: "pub fn ok() -> bool { true }" }],
    });
    assert.match(readFileSync(join(fixture.worktree, "src/lib.rs"), "utf8"), /true/);

    const commandResult = await approvedCommand.execute("command-ok", { command_id: "CMD-U1-1" }) as { content: Array<{ text: string }> };
    assert.equal(commandResult.content[0]!.text, "approved");
    await assert.rejects(
      () => approvedCommand.execute("command-text", { command: "printf approvee" }),
      /exactly one command_id|accepts no shell text/,
    );
    await assert.rejects(
      () => approvedCommand.execute("command-extra-shell", {
        command_id: "CMD-U1-1",
        command: "printf attacker-controlled",
      }),
      /exactly one command_id|accepts no shell text/,
    );
    await assert.rejects(
      () => approvedCommand.execute("command-unknown", { command_id: "CMD-U1-999" }),
      /denied pre-effect/,
    );
    const denial = fixture.policy.denialLedger();
    assert.equal(denial.schema, "autopilot.delivery_policy_denials.v2");
    assert.equal(denial.overflowed, false);
    assert.deepEqual(
      denial.entries.map(({ denial_id, kind, tool, effected }) => ({ denial_id, kind, tool, effected })),
      [{ denial_id: "denial-1", kind: "unapproved-command", tool: APPROVED_COMMAND_TOOL, effected: false }],
    );
    assert.match(denial.entries[0]!.request_digest, /^[0-9a-f]{64}$/);
    const executions = fixture.policy.executionLedger();
    assert.equal(executions.schema, "autopilot.approved_command_executions.v1");
    assert.equal(executions.overflowed, false);
    assert.equal(executions.entries.length, 1);
    assert.equal(executions.entries[0]!.command_id, "CMD-U1-1");
    assert.equal(executions.entries[0]!.outcome, "succeeded");
    assert.match(executions.entries[0]!.scope_snapshot_digest, /^[0-9a-f]{64}$/);

    await write.execute("write-approved-new-file", { path: "new/allowed.txt", content: "new approved\n" });
    assert.equal(readFileSync(join(fixture.worktree, "new/allowed.txt"), "utf8"), "new approved\n");
    await approvedCommand.execute("command-after-final-edit", { command_id: "CMD-U1-1" });
    const finalExecutions = fixture.policy.executionLedger();
    assert.equal(finalExecutions.entries.length, 2);
    assert.notEqual(
      finalExecutions.entries[0]!.scope_snapshot_digest,
      finalExecutions.entries[1]!.scope_snapshot_digest,
      "approved-file content changes must change command snapshot evidence",
    );

    const foreignFile = join(fixture.foreign, "operator.txt");
    const beforeForeign = readFileSync(foreignFile, "utf8");
    symlinkSync(foreignFile, join(fixture.worktree, "link.txt"));
    symlinkSync(fixture.foreign, join(fixture.worktree, "linked"));
    mkdirSync(join(fixture.worktree, "special.txt"));
    const writeBlockCases = [
      ["absolute", { path: foreignFile, content: "bad" }],
      ["parent escape", { path: "../foreign/operator.txt", content: "bad" }],
      ["unapproved in worktree", { path: "other.txt", content: "bad" }],
      ["symlink file", { path: "link.txt", content: "bad" }],
      ["symlink parent", { path: "linked/file.txt", content: "bad" }],
      ["special target", { path: "special.txt", content: "bad" }],
    ] as const;
    for (const [label, params] of writeBlockCases) {
      await assert.rejects(() => write.execute(`blocked-write-${label}`, params), /Delivery policy blocked/);
      assert.equal(readFileSync(foreignFile, "utf8"), beforeForeign, `write ${label}`);
    }
    const editBlockCases = [
      ["absolute", { path: foreignFile, edits: [{ oldText: "foreign", newText: "bad" }] }],
      ["parent escape", { path: "../foreign/operator.txt", edits: [{ oldText: "foreign", newText: "bad" }] }],
      ["unapproved in worktree", { path: "other.txt", edits: [{ oldText: "", newText: "bad" }] }],
      ["symlink file", { path: "link.txt", edits: [{ oldText: "foreign", newText: "bad" }] }],
      ["symlink parent", { path: "linked/file.txt", edits: [{ oldText: "foreign", newText: "bad" }] }],
      ["special target", { path: "special.txt", edits: [{ oldText: "", newText: "bad" }] }],
    ] as const;
    for (const [label, params] of editBlockCases) {
      await assert.rejects(() => edit.execute(`blocked-edit-${label}`, params), /Delivery policy blocked/);
      assert.equal(readFileSync(foreignFile, "utf8"), beforeForeign, `edit ${label}`);
    }
    assert.equal(fixture.policy.denialLedger().entries.every((entry) => entry.effected === false), true);
    assert.equal(fixture.policy.denialLedger().overflowed, false);

    for (const reserved of [".git/config", ".pi/config"]) {
      assert.throws(
        () => loadDeliveryPolicyFromEnv(makeEnv({ files: [reserved], root: fixture.root, worktree: fixture.worktree }).env as never, fixture.worktree),
        /unsafe unit file path/,
        reserved,
      );
    }
  } finally {
    cleanup();
  }
});

test("delivery policy denial ledger is bounded and reports overflow", { concurrency: false }, async () => {
  const fixture = makeFixture();
  try {
    const approvedCommand = fixture.tools.get(APPROVED_COMMAND_TOOL)!;
    for (let index = 0; index < 33; index += 1) {
      await assert.rejects(
        () => approvedCommand.execute(`denial-${index}`, { command_id: `CMD-U1-${index + 99}` }),
        /denied pre-effect/,
      );
    }
    const ledger = fixture.policy.denialLedger();
    assert.equal(ledger.entries.length, 32);
    assert.equal(ledger.overflowed, true);
    assert.equal(ledger.entries[31]!.denial_id, "denial-32");
    assert.equal(ledger.entries.every((entry) => entry.kind === "unapproved-command"), true);
  } finally {
    cleanup();
  }
});

test("approved-command backend does not expose Pi session environment", { concurrency: false }, async () => {
  const command = `node -e ${JSON.stringify("process.exit(process.env.PI_SESSION_ID ? 42 : 0)")}`;
  const fixture = makeUnitFixture(["src/lib.rs"], { commands: [command] });
  try {
    const approvedCommand = fixture.tools.get(APPROVED_COMMAND_TOOL)!;
    await approvedCommand.execute(
      "session-env-hidden",
      { command_id: "CMD-U1-1" },
      undefined,
      undefined,
      {
        model: { provider: "provider-probe", id: "model-probe" },
        thinkingLevel: "high",
        sessionManager: {
          getSessionId: () => "session-probe",
          getSessionFile: () => "/tmp/session-probe.jsonl",
        },
      },
    );
  } finally {
    cleanup();
  }
});

test("approved-command execution ledger is bounded and reports overflow", { concurrency: false }, async () => {
  const fixture = makeUnitFixture(["src/lib.rs"]);
  try {
    const approvedCommand = fixture.tools.get(APPROVED_COMMAND_TOOL)!;
    for (let index = 0; index < 65; index += 1) {
      await approvedCommand.execute(`execution-${index}`, { command_id: "CMD-U1-1" });
    }
    const ledger = fixture.policy.executionLedger();
    assert.equal(ledger.entries.length, 64);
    assert.equal(ledger.overflowed, true);
    assert.equal(ledger.entries[63]!.execution_id, "execution-64");
    assert.equal(ledger.entries.every((entry) => entry.outcome === "succeeded"), true);
  } finally {
    cleanup();
  }
});

test("delivery policy serializes parallel approved-command/edit/write race attempts", { concurrency: false }, async () => {
  const fixture = makeFixture();
  try {
    const raceDir = join(fixture.worktree, "race");
    mkdirSync(raceDir);
    writeFileSync(join(raceDir, "file.txt"), "safe\n");
    const foreignRaceFile = join(fixture.foreign, "file.txt");
    writeFileSync(foreignRaceFile, "foreign\n");
    const approvedCommand = fixture.tools.get(APPROVED_COMMAND_TOOL)!;
    const write = fixture.tools.get("write")!;
    const edit = fixture.tools.get("edit")!;

    const results = await Promise.allSettled([
      approvedCommand.execute("race-command", { command_id: "CMD-U1-2" }),
      write.execute("race-write", { path: "race/file.txt", content: "escaped\n" }),
      edit.execute("race-edit", { path: "race/file.txt", edits: [{ oldText: "foreign", newText: "escaped" }] }),
    ]);
    assert.equal(results[0]!.status, "rejected", "unsafe command-created topology must fail closed");
    assert.equal(results[1]!.status, "rejected");
    assert.equal(results[2]!.status, "rejected");
    assert.equal(readFileSync(foreignRaceFile, "utf8"), "foreign\n");
  } finally {
    cleanup();
  }
});

test("delivery policy rejects duplicate unit file authority but permits repeated opaque commands", { concurrency: false }, async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "autopilot-policy-dupes-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src/lib.rs"), "original\n");
  try {
    assert.throws(
      () => loadDeliveryPolicyFromEnv(makeEnv({ root, worktree, files: ["src/lib.rs", "src/lib.rs"] }).env as never, worktree),
      /duplicate unit file path: src\/lib\.rs/,
    );

    const { env } = makeEnv({ root, worktree, files: ["src/lib.rs"], commands: ["printf repeat", "printf repeat"] });
    const policy = loadDeliveryPolicyFromEnv(env as never, worktree);
    assert.equal(policy.receipt().allowed_unit_file_count, 1);
    assert.equal(policy.receipt().approved_command_count, 2);
    const tools = new Map<string, RegisteredTool>();
    registerDeliveryPolicyTools({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never, policy);
    const result = await tools.get(APPROVED_COMMAND_TOOL)!.execute("repeat-ok", { command_id: "CMD-U1-1" }) as { content: Array<{ text: string }> };
    assert.equal(result.content[0]!.text, "repeat");
  } finally {
    cleanup();
  }
});

test("delivery package checks fail closed on every executable-boundary shape defect", { concurrency: false }, () => {
  const mutations: Array<[string, (unit: Record<string, unknown>, check: Record<string, unknown>) => void]> = [
    ["missing package_checks", (unit) => { delete unit["package_checks"]; }],
    ["unknown kind", (_unit, check) => { check["kind"] = "model-shell"; }],
    ["blank expectation", (_unit, check) => { check["expected"] = " "; }],
    ["duplicate check id", (unit, check) => { unit["package_checks"] = [check, { ...check }]; }],
    ["empty ordinals", (_unit, check) => { check["criterion_ordinals"] = []; }],
    ["duplicate ordinals", (_unit, check) => { check["criterion_ordinals"] = [1, 1]; }],
    ["zero ordinal", (_unit, check) => { check["criterion_ordinals"] = [0]; }],
    ["fractional ordinal", (_unit, check) => { check["criterion_ordinals"] = [1.5]; }],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = makeFixture(false);
    try {
      const assignment = JSON.parse(readFileSync(fixture.assignmentPath, "utf8")) as Record<string, unknown>;
      const unit = (assignment["ordered_units"] as Array<Record<string, unknown>>)[0]!;
      const check = (unit["package_checks"] as Array<Record<string, unknown>>)[0]!;
      mutate(unit, check);
      const bytes = Buffer.from(JSON.stringify(assignment, null, 2));
      writeFileSync(fixture.assignmentPath, bytes);
      const assignmentDigest = createHash("sha256").update(bytes).digest("hex");
      const env = { ...fixture.env, AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST: assignmentDigest };
      env.AUTOPILOT_DELIVERY_POLICY_DIGEST = deliveryPolicyDigest({
        assignmentPath: fixture.assignmentPath,
        assignmentDigest,
        worktree: fixture.worktree,
        cwd: fixture.worktree,
      });
      assert.throws(() => loadDeliveryPolicyFromEnv(env as never, fixture.worktree), /package check|package_checks|missing string expected|invalid check ordinals/, label);
    } finally {
      cleanup();
    }
  }
});

test("delivery approved-command bindings fail closed on every identity defect", { concurrency: false }, () => {
  const mutations: Array<[string, (assignment: Record<string, unknown>, bindings: Array<Record<string, unknown>>) => void]> = [
    ["missing bindings", (assignment) => { delete assignment["approved_commands"]; }],
    ["duplicate command id", (_assignment, bindings) => { bindings.push({ ...bindings[0] }); }],
    ["unknown unit", (_assignment, bindings) => { bindings[0]!["unit_id"] = "U404"; }],
    ["zero ordinal", (_assignment, bindings) => { bindings[0]!["command_ordinal"] = 0; }],
    ["out of range ordinal", (_assignment, bindings) => { bindings[0]!["command_ordinal"] = 99; }],
    ["digest drift", (_assignment, bindings) => { bindings[0]!["command_digest"] = "0".repeat(64); }],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = makeFixture(false);
    try {
      const assignment = JSON.parse(readFileSync(fixture.assignmentPath, "utf8")) as Record<string, unknown>;
      const bindings = assignment["approved_commands"] as Array<Record<string, unknown>>;
      mutate(assignment, bindings);
      const bytes = Buffer.from(JSON.stringify(assignment, null, 2));
      writeFileSync(fixture.assignmentPath, bytes);
      const assignmentDigest = createHash("sha256").update(bytes).digest("hex");
      const env = { ...fixture.env, AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST: assignmentDigest };
      env.AUTOPILOT_DELIVERY_POLICY_DIGEST = deliveryPolicyDigest({
        assignmentPath: fixture.assignmentPath,
        assignmentDigest,
        worktree: fixture.worktree,
        cwd: fixture.worktree,
      });
      assert.throws(
        () => loadDeliveryPolicyFromEnv(env as never, fixture.worktree),
        /approved_commands|approved command binding|approved command digest/,
        label,
      );
    } finally {
      cleanup();
    }
  }
});

test("delivery policy launch authority fails closed before tool registration", { concurrency: false }, () => {
  const fixture = makeFixture(false);
  try {
    const env = fixture.env;
    assert.throws(() => loadDeliveryPolicyFromEnv({ ...env, AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST: "0".repeat(64) } as never, fixture.worktree), /digest drift/);
    assert.throws(() => loadDeliveryPolicyFromEnv({ ...env, AUTOPILOT_DELIVERY_ASSIGNMENT_PATH: join(fixture.root, "missing.json") } as never, fixture.worktree), /ENOENT/);
    assert.throws(() => loadDeliveryPolicyFromEnv({ ...env, AUTOPILOT_DELIVERY_WORKTREE: fixture.foreign } as never, fixture.worktree), /cwd\/worktree mismatch|identity drift/);
    assert.throws(() => loadDeliveryPolicyFromEnv({ ...env, AUTOPILOT_DELIVERY_CWD: fixture.foreign } as never, fixture.worktree), /cwd\/worktree mismatch/);
    writeFileSync(fixture.assignmentPath, "{not json");
    assert.throws(() => loadDeliveryPolicyFromEnv(env as never, fixture.worktree), /digest drift|malformed JSON/);

    const big = Buffer.alloc(256 * 1024 + 1, "x");
    writeFileSync(fixture.assignmentPath, big);
    const bigDigest = createHash("sha256").update(big).digest("hex");
    assert.throws(
      () => loadDeliveryPolicyFromEnv({ ...env, AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST: bigDigest } as never, fixture.worktree),
      /oversized/,
    );
  } finally {
    cleanup();
  }
});

type MinimalFixture = {
  root: string;
  worktree: string;
  policy: DeliveryPolicy;
  tools: Map<string, RegisteredTool>;
};

// Builds a fixture with only the worktree root pre-created (never the
// directories an approved unit file lives in). This is the shape the real
// framework write tool sees on a fresh delivery: it is what proves mkdir
// actually creates directories rather than merely validating them.
function makeUnitFixture(files: string[], options?: { registerTools?: boolean; commands?: string[] }): MinimalFixture {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "autopilot-policy-mkdir-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  const { env } = makeEnv({ root, worktree, files, commands: options?.commands });
  const policy = loadDeliveryPolicyFromEnv(env as never, worktree);
  const tools = new Map<string, RegisteredTool>();
  if (options?.registerTools !== false) {
    registerDeliveryPolicyTools({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never, policy);
  }
  return { root, worktree, policy, tools };
}

test("T1: write creates missing nested parent directories for an approved unit file", { concurrency: false }, async () => {
  const fixture = makeUnitFixture(["src/newmod/thing.rs"]);
  try {
    assert.equal(existsSync(join(fixture.worktree, "src")), false, "precondition: src must not pre-exist");
    assert.equal(existsSync(join(fixture.worktree, "src", "newmod")), false, "precondition: newmod must not pre-exist");
    const write = fixture.tools.get("write")!;
    await write.execute("t1-write", { path: "src/newmod/thing.rs", content: "pub fn thing() {}\n" });
    assert.equal(readFileSync(join(fixture.worktree, "src/newmod/thing.rs"), "utf8"), "pub fn thing() {}\n");
    const stat = lstatSync(join(fixture.worktree, "src", "newmod"));
    assert.equal(stat.isDirectory(), true, "newmod must be a real directory");
    assert.equal(stat.isSymbolicLink(), false, "newmod must not be a symlink");
  } finally {
    cleanup();
  }
});

test("T2: mkdir rejects a directory that is not an approved ancestor and creates nothing", { concurrency: false }, async () => {
  const fixture = makeUnitFixture(["src/lib.rs"], { registerTools: false });
  try {
    const ops = createDeliveryWriteOperations(fixture.policy);
    const evilDir = join(fixture.worktree, "src", "evil");
    await assert.rejects(() => ops.mkdir(evilDir), /Delivery policy blocked/);
    assert.equal(existsSync(evilDir), false);
  } finally {
    cleanup();
  }
});

test("T3: mkdir rejects escaping the worktree and creates nothing outside it", { concurrency: false }, async () => {
  const fixture = makeUnitFixture(["src/lib.rs"], { registerTools: false });
  try {
    const ops = createDeliveryWriteOperations(fixture.policy);
    const outside = join(fixture.worktree, "..", "outside");
    await assert.rejects(() => ops.mkdir(outside), /Delivery policy blocked/);
    assert.equal(existsSync(join(fixture.root, "outside")), false);
  } finally {
    cleanup();
  }
});

test("T4: mkdir refuses to traverse an existing symlink component", { concurrency: false }, async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "autopilot-policy-mkdir-symlink-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(worktree);
  mkdirSync(elsewhere);
  mkdirSync(join(worktree, "src"));
  symlinkSync(elsewhere, join(worktree, "src", "link"));
  const { env } = makeEnv({ root, worktree, files: ["src/link/f.rs"] });
  const policy = loadDeliveryPolicyFromEnv(env as never, worktree);
  const tools = new Map<string, RegisteredTool>();
  registerDeliveryPolicyTools({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never, policy);
  try {
    const write = tools.get("write")!;
    await assert.rejects(() => write.execute("t4-write", { path: "src/link/f.rs", content: "bad\n" }), /Delivery policy blocked/);
    assert.equal(existsSync(join(elsewhere, "f.rs")), false, "symlink target must not receive the file");
    assert.equal(lstatSync(join(worktree, "src", "link")).isSymbolicLink(), true, "symlink itself must be untouched");
  } finally {
    cleanup();
  }
});

test("T5: mkdir creates exactly the enumerated ancestor chain for a deeply nested unit", { concurrency: false }, async () => {
  const fixture = makeUnitFixture(["a/b/c/f.rs"]);
  try {
    assert.equal(existsSync(join(fixture.worktree, "a")), false, "precondition: a must not pre-exist");
    const write = fixture.tools.get("write")!;
    await write.execute("t5-write", { path: "a/b/c/f.rs", content: "ok\n" });
    assert.equal(readFileSync(join(fixture.worktree, "a/b/c/f.rs"), "utf8"), "ok\n");
    for (const dir of ["a", "a/b", "a/b/c"]) {
      const stat = lstatSync(join(fixture.worktree, dir));
      assert.equal(stat.isDirectory(), true, dir);
      assert.equal(stat.isSymbolicLink(), false, dir);
    }
    assert.deepEqual(readdirSync(fixture.worktree).sort(), ["a"]);
    assert.deepEqual(readdirSync(join(fixture.worktree, "a")).sort(), ["b"]);
    assert.deepEqual(readdirSync(join(fixture.worktree, "a", "b")).sort(), ["c"]);
    assert.deepEqual(readdirSync(join(fixture.worktree, "a", "b", "c")).sort(), ["f.rs"]);
  } finally {
    cleanup();
  }
});

test("T6: enumerated-ancestor authority does not widen back into prefix authority", { concurrency: false }, async () => {
  const fixture = makeUnitFixture(["a/b/f.rs"], { registerTools: false });
  try {
    const ops = createDeliveryWriteOperations(fixture.policy);
    await ops.mkdir(join(fixture.worktree, "a"));
    assert.equal(lstatSync(join(fixture.worktree, "a")).isDirectory(), true);
    const siblingDir = join(fixture.worktree, "a", "z");
    await assert.rejects(() => ops.mkdir(siblingDir), /Delivery policy blocked/);
    assert.equal(existsSync(siblingDir), false);
  } finally {
    cleanup();
  }
});

test("T7: mkdir throws loudly when an ancestor already exists as a regular file", { concurrency: false }, async () => {
  const fixture = makeUnitFixture(["a/b/f.rs"], { registerTools: false });
  try {
    writeFileSync(join(fixture.worktree, "a"), "not a directory\n");
    const ops = createDeliveryWriteOperations(fixture.policy);
    await assert.rejects(() => ops.mkdir(join(fixture.worktree, "a", "b")), /Delivery policy blocked/);
  } finally {
    cleanup();
  }
});

test("T8: mkdir is idempotent when the approved parent chain already exists", { concurrency: false }, async () => {
  const fixture = makeUnitFixture(["a/b/f.rs"], { registerTools: false });
  try {
    mkdirSync(join(fixture.worktree, "a"));
    mkdirSync(join(fixture.worktree, "a", "b"));
    const ops = createDeliveryWriteOperations(fixture.policy);
    await ops.mkdir(join(fixture.worktree, "a", "b"));
    assert.equal(lstatSync(join(fixture.worktree, "a", "b")).isDirectory(), true);
  } finally {
    cleanup();
  }
});

function makeFixture(registerTools = true): Fixture {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "autopilot-policy-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  const foreign = join(root, "foreign");
  mkdirSync(worktree);
  mkdirSync(foreign);
  mkdirSync(join(worktree, "src"));
  mkdirSync(join(worktree, "new"));
  mkdirSync(join(worktree, "linked-target"));
  writeFileSync(join(worktree, "src/lib.rs"), "original\n");
  writeFileSync(join(foreign, "operator.txt"), "foreign\n");
  const { env, assignmentPath } = makeEnv({
    root,
    worktree,
    files: ["src/lib.rs", "new/allowed.txt", "link.txt", "linked/file.txt", "special.txt", "race/file.txt"],
    commands: ["printf approved", `rm -rf race && ln -s ${JSON.stringify(foreign)} race`],
  });
  const policy = loadDeliveryPolicyFromEnv(env as never, worktree);
  const tools = new Map<string, RegisteredTool>();
  if (registerTools) {
    registerDeliveryPolicyTools({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never, policy);
  }
  return { root, worktree, foreign, assignmentPath, env, policy, tools };
}

function approvedCommandDigest(unitId: string, ordinal: number, command: string): string {
  return createHash("sha256")
    .update(`autopilot.approved_command.v1\0${unitId}\0${ordinal}\0${command}`, "utf8")
    .digest("hex");
}

function makeEnv(input: { root: string; worktree: string; files: string[]; commands?: string[] }): { env: Record<string, string>; assignmentPath: string } {
  const assignmentPath = join(input.root, `assignment-${createHash("sha1").update(input.files.join("|")).digest("hex")}.json`);
  const commands = input.commands ?? ["printf approved"];
  const assignment = {
    schema: "autopilot.delivery_assignment.v3",
    workstream: "main",
    assignment_id: "assignment-main-L1",
    lane_id: "L1",
    attempt: 1,
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    worktree: input.worktree,
    ordered_units: [{ id: "U1", kind: "implementation", files: input.files, commands: commands.map((command) => ({ command, expected: `Command ${command} exits successfully.` })), package_checks: [{ check_id: "PKG-U1-TIP", kind: "clean-exact-package-tip", criterion_ordinals: [1], expected: "Core proves the exact clean package tip." }] }],
    approved_commands: commands.map((command, index) => ({
      command_id: `CMD-U1-${index + 1}`,
      unit_id: "U1",
      command_ordinal: index + 1,
      command_digest: approvedCommandDigest("U1", index + 1, command),
    })),
  };
  const bytes = Buffer.from(JSON.stringify(assignment, null, 2));
  writeFileSync(assignmentPath, bytes);
  const assignmentDigest = createHash("sha256").update(bytes).digest("hex");
  const env = {
    AUTOPILOT_DELIVERY_ASSIGNMENT_PATH: assignmentPath,
    AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST: assignmentDigest,
    AUTOPILOT_DELIVERY_WORKTREE: input.worktree,
    AUTOPILOT_DELIVERY_CWD: input.worktree,
    AUTOPILOT_DELIVERY_ASSIGNMENT_ID: assignment.assignment_id,
    AUTOPILOT_DELIVERY_WORKSTREAM: assignment.workstream,
    AUTOPILOT_DELIVERY_LANE_ID: assignment.lane_id,
    AUTOPILOT_DELIVERY_ATTEMPT: String(assignment.attempt),
    AUTOPILOT_DELIVERY_BASE_COMMIT: assignment.base_commit,
    AUTOPILOT_DELIVERY_POLICY_DIGEST: deliveryPolicyDigest({ assignmentPath, assignmentDigest, worktree: input.worktree, cwd: input.worktree }),
  };
  assert.equal(DELIVERY_POLICY_VERSION, "autopilot.delivery_tool_policy.v3");
  return { env, assignmentPath };
}

function cleanup(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}
