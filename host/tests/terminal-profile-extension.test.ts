import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Compile } from "typebox/compile";

import childExtension from "../../src/generated/child-extension.ts";
import { registerSubmitTools } from "../../child-runtime/child-extension-runtime.ts";
import { SUBMIT_TOOLS } from "../../src/generated/tool-schemas.ts";

interface RegisteredTool {
  name: string;
  parameters?: unknown;
  prepareArguments?: (params: unknown) => Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: Record<string, unknown>;
    terminate?: boolean;
  }>;
}

const DELIVERY_ENV_KEYS = [
  "AUTOPILOT_DELIVERY_ASSIGNMENT_PATH",
  "AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST",
  "AUTOPILOT_DELIVERY_WORKTREE",
  "AUTOPILOT_DELIVERY_CWD",
  "AUTOPILOT_DELIVERY_ASSIGNMENT_ID",
  "AUTOPILOT_DELIVERY_WORKSTREAM",
  "AUTOPILOT_DELIVERY_LANE_ID",
  "AUTOPILOT_DELIVERY_ATTEMPT",
  "AUTOPILOT_DELIVERY_BASE_COMMIT",
  "AUTOPILOT_DELIVERY_POLICY_DIGEST",
] as const;
const VALIDATION_ENV_KEYS = [
  "AUTOPILOT_VALIDATION_CONTEXT_PATH",
  "AUTOPILOT_VALIDATION_CONTEXT_DIGEST",
  "AUTOPILOT_VALIDATION_CWD",
] as const;
const DELIVERY_POLICY_VERSION = "autopilot.delivery_tool_policy.v3";
const deliveryTempDirs: string[] = [];
const validationTempDirs: string[] = [];

test("parent planning registration excludes the Recovery Engineer child-only terminal", () => {
  const names: string[] = [];
  registerSubmitTools(
    { registerTool(tool: { name: string }) { names.push(tool.name); } } as never,
    SUBMIT_TOOLS,
    import.meta.url,
  );
  assert.deepEqual(
    names,
    SUBMIT_TOOLS
      .filter((tool) => tool.boundary_id.startsWith("planning.") && tool.name !== "autopilot_emit_status")
      .map((tool) => tool.name),
  );
  assert(!names.includes("autopilot_emit_status"));
});

function installDeliveryPolicyEnv(): { assignmentPath: string; assignmentDigest: string; policyDigest: string; worktree: string } {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "autopilot-delivery-policy-"));
  deliveryTempDirs.push(root);
  const worktree = join(root, "worktree");
  const assignmentPath = join(root, "assignment.json");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "README.md"), "fixture\n");
  const command = "true";
  const assignment = {
    schema: "autopilot.delivery_assignment.v3",
    workstream: "main",
    assignment_id: "assignment-main-L1",
    lane_id: "L1",
    attempt: 1,
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    worktree,
    ordered_units: [
      { id: "U1", kind: "implementation", files: ["README.md"], commands: [{ command, expected: "Command exits successfully." }], package_checks: [{ check_id: "PKG-U1-TIP", kind: "clean-exact-package-tip", criterion_ordinals: [1], expected: "Core proves the exact clean package tip." }] },
    ],
    approved_commands: [{
      command_id: "CMD-U1-1",
      unit_id: "U1",
      command_ordinal: 1,
      command_digest: createHash("sha256")
        .update(`autopilot.approved_command.v1\0U1\0${1}\0${command}`, "utf8")
        .digest("hex"),
    }],
  };
  const assignmentBytes = Buffer.from(JSON.stringify(assignment, null, 2));
  writeFileSync(assignmentPath, assignmentBytes);
  const assignmentDigest = createHash("sha256").update(assignmentBytes).digest("hex");
  const policyDigest = createHash("sha256")
    .update(`${DELIVERY_POLICY_VERSION}\0${assignmentPath}\0${assignmentDigest}\0${worktree}\0${worktree}`)
    .digest("hex");
  process.env.AUTOPILOT_DELIVERY_ASSIGNMENT_PATH = assignmentPath;
  process.env.AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST = assignmentDigest;
  process.env.AUTOPILOT_DELIVERY_WORKTREE = worktree;
  process.env.AUTOPILOT_DELIVERY_CWD = worktree;
  process.env.AUTOPILOT_DELIVERY_ASSIGNMENT_ID = assignment.assignment_id;
  process.env.AUTOPILOT_DELIVERY_WORKSTREAM = assignment.workstream;
  process.env.AUTOPILOT_DELIVERY_LANE_ID = assignment.lane_id;
  process.env.AUTOPILOT_DELIVERY_ATTEMPT = String(assignment.attempt);
  process.env.AUTOPILOT_DELIVERY_BASE_COMMIT = assignment.base_commit;
  process.env.AUTOPILOT_DELIVERY_POLICY_DIGEST = policyDigest;
  return { assignmentPath, assignmentDigest, policyDigest, worktree };
}

function clearDeliveryPolicyEnv(): void {
  for (const key of DELIVERY_ENV_KEYS) delete process.env[key];
  while (deliveryTempDirs.length > 0) rmSync(deliveryTempDirs.pop()!, { recursive: true, force: true });
}

function installValidationPolicyEnv(): { contextPath: string; contextDigest: string; authorityPath: string; worktree: string } {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "autopilot-validation-policy-"));
  validationTempDirs.push(root);
  const worktree = join(root, "worktree");
  const evidence = join(worktree, "src.txt");
  const image = join(worktree, "image.png");
  const diff = join(root, "candidate.v3.diff");
  const contextPath = join(root, "context.v3.json");
  const authorityPath = join(root, "authority.v3.json");
  mkdirSync(worktree);
  writeFileSync(evidence, "source evidence\n");
  writeFileSync(
    image,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  writeFileSync(diff, "diff evidence\n");
  writeFileSync(join(worktree, "Capture’s.txt"), "unauthorized curly variant\n");
  writeFileSync(join(worktree, "café.txt"), "unauthorized NFD variant\n");
  writeFileSync(join(worktree, "Shot AM.png"), "unauthorized AM variant\n");
  writeFileSync(authorityPath, '{"receipt_json":"must-not-reach-model"}\n');
  const sourceDigest = createHash("sha256").update(readFileSync(evidence)).digest("hex");
  const imageDigest = createHash("sha256").update(readFileSync(image)).digest("hex");
  const diffDigest = createHash("sha256").update(readFileSync(diff)).digest("hex");
  const context = {
    schema: "autopilot.validation_context.v3",
    validation_id: "validation-test",
    assignment_id: "validator-assignment-test",
    authority_digest: "0".repeat(64),
    criteria: [],
    citation_records: [
      { evidence_ref: "validation-source:test", kind: "source-snapshot", source_path: "src.txt", blob_digest: sourceDigest, line_count: 1 },
      { evidence_ref: "validation-source:image", kind: "source-snapshot", source_path: "image.png", blob_digest: imageDigest, line_count: 1 },
      { evidence_ref: "validation-diff:test", kind: "candidate-diff", diff_digest: diffDigest, diff_path: diff },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(context, null, 2));
  writeFileSync(contextPath, bytes);
  const contextDigest = createHash("sha256").update(bytes).digest("hex");
  process.env.AUTOPILOT_VALIDATION_CONTEXT_PATH = contextPath;
  process.env.AUTOPILOT_VALIDATION_CONTEXT_DIGEST = contextDigest;
  process.env.AUTOPILOT_VALIDATION_CWD = worktree;
  return { contextPath, contextDigest, authorityPath, worktree };
}

function clearValidationPolicyEnv(): void {
  for (const key of VALIDATION_ENV_KEYS) delete process.env[key];
  while (validationTempDirs.length > 0) rmSync(validationTempDirs.pop()!, { recursive: true, force: true });
}

test("selected terminal profile registers exactly one same-name schema", { concurrency: false }, async () => {
  const previousProfile = process.env.AUTOPILOT_TERMINAL_PROFILE;
  const previousBinding = process.env.AUTOPILOT_CARRIER_BINDING;
  try {
    const wrapperUrl = new URL("../../src/generated/child-extension.ts", import.meta.url);
    const runtimeUrl = new URL("../../child-runtime/child-extension-runtime.ts", import.meta.url);
    const wrapperDigest = createHash("sha256")
      .update(Buffer.concat([readFileSync(wrapperUrl), Buffer.from([0]), readFileSync(runtimeUrl)]))
      .digest("hex");
    assert.equal(SUBMIT_TOOLS.length, 11);
    for (const expected of SUBMIT_TOOLS) {
      process.env.AUTOPILOT_TERMINAL_PROFILE = expected.profile_id;
      process.env.AUTOPILOT_CARRIER_BINDING = "binding-test";
      clearDeliveryPolicyEnv();
      clearValidationPolicyEnv();
      const deliveryEnv = expected.profile_id === "delivery-status.v2" ? installDeliveryPolicyEnv() : undefined;
      const validationEnv = expected.profile_id === "validation-status.v3" ? installValidationPolicyEnv() : undefined;
      const tools: RegisteredTool[] = [];
      const hooks = new Map<string, () => Promise<void>>();
      const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
      const pi = {
        registerTool(tool: RegisteredTool) { tools.push(tool); },
        on(name: string, handler: () => Promise<void>) { hooks.set(name, handler); },
        appendEntry(type: string, data: Record<string, unknown>) { entries.push({ type, data }); },
        getActiveTools() { return [...new Set(["read", ...tools.map((tool) => tool.name)])]; },
      };
      const previousCwd = process.cwd();
      if (deliveryEnv) process.chdir(deliveryEnv.worktree);
      if (validationEnv) process.chdir(validationEnv.worktree);
      try {
        childExtension(pi as never);
      } finally {
        process.chdir(previousCwd);
      }
      assert.equal(tools.map((tool) => tool.name).includes(expected.name), true);
      assert.equal(
        tools.length,
        expected.profile_id === "delivery-status.v2" ? 4 : expected.profile_id === "validation-status.v3" ? 2 : 1,
      );
      const submitTool = tools.find((tool) => tool.name === expected.name)!;
      await hooks.get("session_start")!();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.data.self_digest, wrapperDigest);
      assert.equal(entries[0]!.data.profile_id, expected.profile_id);
      assert.equal(entries[0]!.data.boundary_id, expected.boundary_id);
      assert.equal(entries[0]!.data.result_contract, expected.result_contract);
      if (deliveryEnv) {
        assert.deepEqual(entries[0]!.data.active_tools, ["autopilot_emit_status", "autopilot_run_approved_command", "edit", "read", "write"]);
        assert.deepEqual(entries[0]!.data.delivery_policy, {
          version: DELIVERY_POLICY_VERSION,
          assignment_path: deliveryEnv.assignmentPath,
          assignment_digest: deliveryEnv.assignmentDigest,
          worktree: deliveryEnv.worktree,
          cwd: deliveryEnv.worktree,
          policy_digest: deliveryEnv.policyDigest,
          allowed_unit_file_count: 1,
          approved_command_count: 1,
          active_overrides: ["autopilot_run_approved_command", "edit", "write"],
        });
      }
      if (validationEnv) {
        assert.deepEqual(entries[0]!.data.validation_evidence_policy, {
          context_path: validationEnv.contextPath,
          context_digest: validationEnv.contextDigest,
          cwd: validationEnv.worktree,
          evidence_count: 3,
          active_override: "read",
        });
        const readTool = tools.find((tool) => tool.name === "read")!;
        const readResult = await readTool.execute("read-source", { path: "src.txt" });
        assert.match(readResult.content?.[0]?.text ?? "", /source evidence/);
        const imageResult = await readTool.execute("read-image", { path: "image.png" });
        assert.equal(
          imageResult.content?.some((content) =>
            content.type === "image" && content.mimeType === "image/png"),
          true,
          JSON.stringify(imageResult),
        );
        await assert.rejects(
          readTool.execute("read-authority", { path: validationEnv.authorityPath }),
          /outside citation authority/,
        );
        if (process.platform !== "win32") {
          symlinkSync("src.txt", join(validationEnv.worktree, "src-alias.txt"));
          await assert.rejects(
            readTool.execute("read-symlink-alias", { path: "src-alias.txt" }),
            /outside citation authority/,
          );
        }
        for (const alias of ["Capture's.txt", "café.txt", "Shot AM.png"]) {
          await assert.rejects(
            readTool.execute("read-filename-variant", { path: alias }),
            /outside citation authority/,
          );
        }
        writeFileSync(join(validationEnv.worktree, "src.txt"), "tampered evidence\n");
        await assert.rejects(
          readTool.execute("read-tampered-source", { path: "src.txt" }),
          /evidence content digest drift/,
        );
        writeFileSync(
          join(validationEnv.worktree, "src.txt"),
          "x".repeat(2 * 1024 * 1024 + 1),
        );
        await assert.rejects(
          readTool.execute("read-oversized-source", { path: "src.txt" }),
          /exceeds regular-file byte authority/,
        );
      }
      const rawPayload = {};
      const prepared = submitTool.prepareArguments?.(rawPayload) ?? rawPayload;
      if (validationEnv) assert.equal(Compile(submitTool.parameters as never).Check(prepared), true);
      const result = await submitTool.execute("opaque-call", prepared);
      assert.equal(result.terminate, true);
      assert.equal(result.details?.profile_id, expected.profile_id);
      assert.equal(result.details?.boundary_id, expected.boundary_id);
      assert.equal(result.details?.result_contract, expected.result_contract);
      assert.equal(result.details?.binding, "binding-test");
      if (validationEnv) assert.deepEqual(result.details?.payload, rawPayload);
      if (deliveryEnv) {
        assert.deepEqual(result.details?.delivery_policy_denials, {
          schema: "autopilot.delivery_policy_denials.v2",
          overflowed: false,
          entries: [],
        });
        assert.deepEqual(result.details?.approved_command_executions, {
          schema: "autopilot.approved_command_executions.v1",
          overflowed: false,
          entries: [],
        });
      } else {
        assert.equal(result.details?.delivery_policy_denials, undefined);
        assert.equal(result.details?.approved_command_executions, undefined);
      }
    }
  } finally {
    if (previousProfile === undefined) delete process.env.AUTOPILOT_TERMINAL_PROFILE;
    else process.env.AUTOPILOT_TERMINAL_PROFILE = previousProfile;
    if (previousBinding === undefined) delete process.env.AUTOPILOT_CARRIER_BINDING;
    else process.env.AUTOPILOT_CARRIER_BINDING = previousBinding;
    clearDeliveryPolicyEnv();
    clearValidationPolicyEnv();
  }
});

test("missing terminal profile fails before registration", { concurrency: false }, () => {
  const previous = process.env.AUTOPILOT_TERMINAL_PROFILE;
  try {
    delete process.env.AUTOPILOT_TERMINAL_PROFILE;
    assert.throws(
      () => childExtension({ registerTool() {}, on() {} } as never),
      /resolved 0 descriptors/,
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOPILOT_TERMINAL_PROFILE;
    else process.env.AUTOPILOT_TERMINAL_PROFILE = previous;
  }
});
