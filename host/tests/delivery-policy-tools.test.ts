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
  createDeliveryWriteOperations,
  DELIVERY_POLICY_VERSION,
  deliveryPolicyDigest,
  loadDeliveryPolicyFromEnv,
  registerDeliveryPolicyTools,
  type DeliveryPolicy,
} from "../../child-runtime/child-extension-runtime.ts";

type RegisteredTool = {
  name: string;
  execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
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

test("delivery policy confines edit/write/bash at production tool overrides", { concurrency: false }, async () => {
  const fixture = makeFixture();
  try {
    const write = fixture.tools.get("write")!;
    const edit = fixture.tools.get("edit")!;
    const bash = fixture.tools.get("bash")!;

    await write.execute("write-ok", { path: "src/lib.rs", content: "pub fn ok() {}\n" });
    assert.equal(readFileSync(join(fixture.worktree, "src/lib.rs"), "utf8"), "pub fn ok() {}\n");
    await edit.execute("edit-ok", {
      path: "src/lib.rs",
      edits: [{ oldText: "pub fn ok() {}", newText: "pub fn ok() -> bool { true }" }],
    });
    assert.match(readFileSync(join(fixture.worktree, "src/lib.rs"), "utf8"), /true/);

    const bashResult = await bash.execute("bash-ok", { command: "printf approved" }) as { content: Array<{ text: string }> };
    assert.equal(bashResult.content[0]!.text, "approved");
    await assert.rejects(() => bash.execute("bash-diff", { command: "printf approvee" }), /unapproved bash command/);
    const denial = fixture.policy.denialLedger();
    assert.equal(denial.schema, "autopilot.delivery_policy_denials.v1");
    assert.equal(denial.overflowed, false);
    assert.deepEqual(
      denial.entries.map(({ denial_id, kind, tool, effected }) => ({ denial_id, kind, tool, effected })),
      [{ denial_id: "denial-1", kind: "unapproved-command", tool: "bash", effected: false }],
    );
    assert.match(denial.entries[0]!.request_digest, /^[0-9a-f]{64}$/);

    await write.execute("write-approved-new-file", { path: "new/allowed.txt", content: "new approved\n" });
    assert.equal(readFileSync(join(fixture.worktree, "new/allowed.txt"), "utf8"), "new approved\n");

    const foreignFile = join(fixture.foreign, "operator.txt");
    const beforeForeign = readFileSync(foreignFile, "utf8");
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
    const bash = fixture.tools.get("bash")!;
    for (let index = 0; index < 33; index += 1) {
      await assert.rejects(
        () => bash.execute(`denial-${index}`, { command: `printf denied-${index}` }),
        /unapproved bash command/,
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

test("delivery policy serializes parallel bash/edit/write race attempts", { concurrency: false }, async () => {
  const fixture = makeFixture();
  try {
    const raceDir = join(fixture.worktree, "race");
    mkdirSync(raceDir);
    writeFileSync(join(raceDir, "file.txt"), "safe\n");
    const foreignRaceFile = join(fixture.foreign, "file.txt");
    writeFileSync(foreignRaceFile, "foreign\n");
    const command = `rm -rf race && ln -s ${JSON.stringify(fixture.foreign)} race`;
    const bash = fixture.tools.get("bash")!;
    const write = fixture.tools.get("write")!;
    const edit = fixture.tools.get("edit")!;

    const results = await Promise.allSettled([
      bash.execute("race-bash", { command }),
      write.execute("race-write", { path: "race/file.txt", content: "escaped\n" }),
      edit.execute("race-edit", { path: "race/file.txt", edits: [{ oldText: "foreign", newText: "escaped" }] }),
    ]);
    assert.equal(results[0]!.status, "fulfilled");
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
    assert.equal(policy.receipt().approved_command_count, 1);
    const tools = new Map<string, RegisteredTool>();
    registerDeliveryPolicyTools({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never, policy);
    const result = await tools.get("bash")!.execute("repeat-ok", { command: "printf repeat" }) as { content: Array<{ text: string }> };
    assert.equal(result.content[0]!.text, "repeat");
  } finally {
    cleanup();
  }
});

test("delivery package checks require unique positive integer criterion ordinals", { concurrency: false }, () => {
  for (const ordinals of [[], [1, 1], [0], [1.5]]) {
    const fixture = makeFixture(false);
    try {
      const assignment = JSON.parse(readFileSync(fixture.assignmentPath, "utf8")) as Record<string, unknown>;
      const units = assignment["ordered_units"] as Array<Record<string, unknown>>;
      const checks = units[0]!["package_checks"] as Array<Record<string, unknown>>;
      checks[0]!["criterion_ordinals"] = ordinals;
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
        /invalid package check criterion ordinals/,
        JSON.stringify(ordinals),
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
function makeUnitFixture(files: string[], options?: { registerTools?: boolean }): MinimalFixture {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "autopilot-policy-mkdir-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  const { env } = makeEnv({ root, worktree, files });
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
  mkdirSync(join(worktree, "special.txt"));
  writeFileSync(join(worktree, "src/lib.rs"), "original\n");
  writeFileSync(join(foreign, "operator.txt"), "foreign\n");
  symlinkSync(join(foreign, "operator.txt"), join(worktree, "link.txt"));
  symlinkSync(foreign, join(worktree, "linked"));
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

function makeEnv(input: { root: string; worktree: string; files: string[]; commands?: string[] }): { env: Record<string, string>; assignmentPath: string } {
  const assignmentPath = join(input.root, `assignment-${createHash("sha1").update(input.files.join("|")).digest("hex")}.json`);
  const assignment = {
    schema: "autopilot.delivery_assignment.v2",
    workstream: "main",
    assignment_id: "assignment-main-L1",
    lane_id: "L1",
    attempt: 1,
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    worktree: input.worktree,
    ordered_units: [{ id: "U1", kind: "implementation", files: input.files, commands: (input.commands ?? ["printf approved"]).map((command) => ({ command })), package_checks: [{ check_id: "PKG-U1-TIP", kind: "clean-exact-package-tip", criterion_ordinals: [1], expected: "Core proves the exact clean package tip." }] }],
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
  assert.equal(DELIVERY_POLICY_VERSION, "autopilot.delivery_tool_policy.v2");
  return { env, assignmentPath };
}

function cleanup(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}
