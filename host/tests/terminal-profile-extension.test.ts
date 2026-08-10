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

import childExtension from "../../src/generated/child-extension.ts";
import { ValidationReadPolicy } from "../../child-runtime/child-extension-runtime.ts";
import { BLOCKED_REPORT_TOOL, SUBMIT_TOOLS } from "../../src/generated/tool-schemas.ts";
import { startChildControlBroker } from "../../src/child-control-broker.ts";

interface RegisteredTool {
  name: string;
  description?: string;
  promptGuidelines?: string[];
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
const DELIVERY_POLICY_VERSION = "autopilot.delivery_tool_policy.v4";
const deliveryTempDirs: string[] = [];
const validationTempDirs: string[] = [];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("terminal schema contains a non-JSON value");
  return encoded;
}

const UUID_V7 = "018f0f00-0000-7000-8000-000000000001";
const DIGEST = "a".repeat(64);

function completeAcceptReceipt(kind: "submit" | "blocked") {
  const submit = {
    schema: "autopilot.submit_receipt.v1", receipt_id: UUID_V7, run_id: "run-1", run_revision: 1,
    workstream: "workstream-1", action_id: "action-1", assignment_id: "assignment-1", attempt: 1,
    profile_id: "profile-1", tool_name: "tool-1", boundary_id: "boundary-1", result_contract: "result-1",
    schema_digest: DIGEST, spec_digest: DIGEST, carrier_binding_digest: DIGEST, authority_digest: DIGEST,
    frozen_validator_versions: [{ validator_id: "validator-1", version: "v1", digest: DIGEST }],
    raw_payload_digest: DIGEST, raw_payload_byte_count: 0, request_id: "request-1", tool_call_id: "call-1",
    prepared_transition: {
      schema: "autopilot.prepared_submit_transition.v1", transition_ref: "transition-1", transition_digest: DIGEST,
      carrier: { artifact_ref: "carrier-1", artifact_schema: "artifact-1", sha256: DIGEST, byte_count: 0 },
      artifact_refs: [], issued_actions: [], deferred_host_effect: { kind: "done", payload: { status: "done" } },
    },
  };
  const blocked = {
    schema: "autopilot.blocked_receipt.v1", receipt_id: UUID_V7, run_id: "run-1", run_revision: 1,
    workstream: "workstream-1", action_id: "action-1", assignment_id: "assignment-1", attempt: 1,
    profile_id: "profile-1", tool_name: "tool-1", request_id: "request-1", tool_call_id: "call-1",
    report_digest: DIGEST, reason_code: "infrastructure", cancellation_set_digest: DIGEST,
  };
  return { kind, schema: "autopilot.child_control_accept_receipt.v1", receipt: kind === "submit" ? submit : blocked };
}

const EXPECTED_TERMINAL_PROFILES = [
  ["delivery-status.v2", "autopilot_emit_status", "autopilot.delivery_submission.v2", "autopilot.delivery_result.v2"],
  ["planning.plan-review.v1:autopilot_submit_review", "autopilot_submit_review", "planning.plan-review.v1", "planning.plan-review.v1"],
  ["planning.questions.v1:autopilot_submit_resolution", "autopilot_submit_resolution", "planning.questions.v1", "planning.questions.v1"],
  ["planning.scout-dossier.v1:autopilot_submit_context", "autopilot_submit_context", "planning.scout-dossier.v1", "planning.scout-dossier.v1"],
  ["planning.scout-dossier.v1:autopilot_submit_scout_report", "autopilot_submit_scout_report", "planning.scout-dossier.v1", "planning.scout-dossier.v1"],
  ["planning.task-atoms.v1:autopilot_submit_atoms", "autopilot_submit_atoms", "planning.task-atoms.v1", "planning.task-atoms.v1"],
  ["planning.work-map.v1:autopilot_submit_plan_cluster", "autopilot_submit_plan_cluster", "planning.work-map.v1", "planning.work-map.v1"],
  ["planning.work-map.v1:autopilot_submit_synthesis", "autopilot_submit_synthesis", "planning.work-map.v1", "planning.work-map.v1"],
  ["planning.work-map.v2:autopilot_submit_plan_cluster", "autopilot_submit_plan_cluster", "planning.work-map.v2", "planning.work-map.v2"],
  ["planning.work-map.v2:autopilot_submit_synthesis", "autopilot_submit_synthesis", "planning.work-map.v2", "planning.work-map.v2"],
  ["recovery-work-map.v1", "autopilot_emit_status", "planning.work-map.v1", "planning.work-map.v1"],
  ["recovery-work-map.v2", "autopilot_emit_status", "planning.work-map.v2", "planning.work-map.v2"],
  ["validation-status.v2", "autopilot_emit_status", "autopilot.validation_submission.v2", "autopilot.validation_result.v2"],
  ["validation-status.v3", "autopilot_emit_status", "autopilot.validation_submission.v3", "autopilot.validation_result.v3"],
] as const;

test("terminal profiles carry the exact hard-coded descriptor tuples and schema digests", () => {
  assert.equal(SUBMIT_TOOLS.length, 14);
  assert.deepEqual(
    SUBMIT_TOOLS.map(({ profile_id, name, boundary_id, result_contract }) =>
      [profile_id, name, boundary_id, result_contract]),
    EXPECTED_TERMINAL_PROFILES,
  );
  for (const descriptor of SUBMIT_TOOLS) {
    const digest = createHash("sha256").update(canonicalJson(descriptor.parameters)).digest("hex");
    assert.equal(descriptor.schema_digest, digest, descriptor.profile_id);
  }
  const duplicatePublicNames = SUBMIT_TOOLS
    .map((tool) => tool.name)
    .filter((name, index, names) => names.indexOf(name) !== index)
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
  assert.deepEqual(duplicatePublicNames, ["autopilot_emit_status", "autopilot_submit_plan_cluster", "autopilot_submit_synthesis"]);
  const regular = SUBMIT_TOOLS.find(
    (tool) => tool.profile_id === "planning.work-map.v1:autopilot_submit_synthesis",
  );
  const recovery = SUBMIT_TOOLS.find((tool) => tool.profile_id === "recovery-work-map.v1");
  assert.ok(regular);
  assert.ok(recovery);
  assert.equal((regular.parameters as Record<string, unknown>).additionalProperties, true);
  assert.equal((recovery.parameters as Record<string, unknown>).additionalProperties, false);
  assert.notEqual(recovery.schema_digest, regular.schema_digest);
});

test("fresh child-control registration exposes every submit profile plus the exact universal blocked description", { concurrency: false }, () => {
  const prior = new Map([
    ["AUTOPILOT_CONTROL_SOCK", process.env.AUTOPILOT_CONTROL_SOCK],
    ["AUTOPILOT_CONTROL_TOKEN", process.env.AUTOPILOT_CONTROL_TOKEN],
    ["AUTOPILOT_CONTROL_RUN_ID", process.env.AUTOPILOT_CONTROL_RUN_ID],
    ["AUTOPILOT_CONTROL_ASSIGNMENT", process.env.AUTOPILOT_CONTROL_ASSIGNMENT],
    ["AUTOPILOT_CONTROL_ATTEMPT", process.env.AUTOPILOT_CONTROL_ATTEMPT],
    ["AUTOPILOT_TERMINAL_PROFILE", process.env.AUTOPILOT_TERMINAL_PROFILE],
  ]);
  try {
    process.env.AUTOPILOT_CONTROL_SOCK = "/tmp/.pi-ap/0000000000/s";
    process.env.AUTOPILOT_CONTROL_TOKEN = "a".repeat(64);
    process.env.AUTOPILOT_CONTROL_RUN_ID = "run-1";
    process.env.AUTOPILOT_CONTROL_ASSIGNMENT = "assignment-1";
    process.env.AUTOPILOT_CONTROL_ATTEMPT = "1";
    for (const descriptor of SUBMIT_TOOLS) {
      process.env.AUTOPILOT_TERMINAL_PROFILE = descriptor.profile_id;
      clearDeliveryPolicyEnv();
      clearValidationPolicyEnv();
      const delivery = descriptor.profile_id === "delivery-status.v2" ? installDeliveryPolicyEnv() : undefined;
      const validation = descriptor.profile_id === "validation-status.v3" ? installValidationPolicyEnv() : undefined;
      const tools: RegisteredTool[] = [];
      const pi = { registerTool(tool: RegisteredTool) { tools.push(tool); }, on() {}, appendEntry() {}, getActiveTools() { return tools.map((tool) => tool.name); } };
      const cwd = process.cwd();
      if (delivery) process.chdir(delivery.worktree);
      if (validation) process.chdir(validation.worktree);
      try {
        childExtension(pi as never);
      } finally {
        process.chdir(cwd);
      }
      const blocked = tools.find((tool) => tool.name === BLOCKED_REPORT_TOOL.name);
      const submit = tools.find((tool) => tool.name === descriptor.name);
      assert.ok(submit, descriptor.profile_id);
      assert.deepEqual(submit.promptGuidelines, [`Call ${descriptor.name} when the payload is ready. If it returns RETRY, correct the reported diagnostic and call ${descriptor.name} again in this same session. Only ACCEPT terminalizes. Do not return the payload as assistant prose or markdown.`], descriptor.profile_id);
      assert.equal(blocked?.description, BLOCKED_REPORT_TOOL.description, descriptor.profile_id);
      assert.equal(tools.length, descriptor.profile_id === "delivery-status.v2" ? 5 : descriptor.profile_id === "validation-status.v3" ? 3 : 2);
    }
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearDeliveryPolicyEnv();
    clearValidationPolicyEnv();
  }
});

test("fresh delivery snapshots exact ledgers beside raw payload and blocked always carries explicit nulls", { concurrency: false }, async () => {
  const prior = new Map([
    ["AUTOPILOT_CONTROL_SOCK", process.env.AUTOPILOT_CONTROL_SOCK],
    ["AUTOPILOT_CONTROL_TOKEN", process.env.AUTOPILOT_CONTROL_TOKEN],
    ["AUTOPILOT_CONTROL_RUN_ID", process.env.AUTOPILOT_CONTROL_RUN_ID],
    ["AUTOPILOT_CONTROL_ASSIGNMENT", process.env.AUTOPILOT_CONTROL_ASSIGNMENT],
    ["AUTOPILOT_CONTROL_ATTEMPT", process.env.AUTOPILOT_CONTROL_ATTEMPT],
    ["AUTOPILOT_TERMINAL_PROFILE", process.env.AUTOPILOT_TERMINAL_PROFILE],
  ]);
  const forwarded: Array<Record<string, unknown>> = [];
  const broker = await startChildControlBroker({
    transport: {
      async request(_kind, payload) {
        const request = (payload as { request: Record<string, unknown> }).request;
        forwarded.push(request);
        const blocked = request.kind === "blocked";
        return {
          v: 1, id: 1, kind: "child-control",
          payload: {
            response: {
              schema: "autopilot.child_control_response.v1", request_id: request.request_id,
              outcome: "ACCEPT", receipt: completeAcceptReceipt(request.kind as "submit" | "blocked"),
            },
            blocked_gate: blocked ? {
              schema: "autopilot.child_control_blocked_gate.v1",
              latch_id: UUID_V7,
              run_id: "run-1",
              cancellations: [{ task_id: "task-reporter", action_id: "action-1", assignment_id: "assignment-1", reporter: true }],
            } : null,
          },
        };
      },
    } as never,
    async applyBlockedGate() {
      return {
        reporterTaskId: "task-reporter",
        async afterChildResponseWritten() {},
        async blockedObservationArrived() {},
        restoredBlockedObservation() { return undefined; },
        async afterBlockedResultAcknowledged() {},
      };
    },
  });
  try {
    const delivery = installDeliveryPolicyEnv();
    process.env.AUTOPILOT_CONTROL_SOCK = broker.socketPath;
    process.env.AUTOPILOT_CONTROL_TOKEN = "a".repeat(64);
    process.env.AUTOPILOT_CONTROL_RUN_ID = "run-1";
    process.env.AUTOPILOT_CONTROL_ASSIGNMENT = "assignment-1";
    process.env.AUTOPILOT_CONTROL_ATTEMPT = "1";
    process.env.AUTOPILOT_TERMINAL_PROFILE = "delivery-status.v2";
    const tools: RegisteredTool[] = [];
    const pi = { registerTool(tool: RegisteredTool) { tools.push(tool); }, on() {}, appendEntry() {}, getActiveTools() { return tools.map((tool) => tool.name); } };
    const cwd = process.cwd();
    process.chdir(delivery.worktree);
    try {
      childExtension(pi as never);
    } finally {
      process.chdir(cwd);
    }
    const submit = tools.find((tool) => tool.name === "autopilot_emit_status")!;
    const blocked = tools.find((tool) => tool.name === BLOCKED_REPORT_TOOL.name)!;
    const submitRaw = { explicit: null };
    const submitResult = await submit.execute("delivery-call", submit.prepareArguments!(submitRaw));
    const blockedRaw = { schema: "autopilot.blocked_report.v1", reason_code: "infrastructure", summary: "blocked", evidence: [{ kind: "observation", value: "socket" }], last_attempted_action: "submit" };
    const blockedResult = await blocked.execute("blocked-call", blocked.prepareArguments!(blockedRaw));
    assert.deepEqual(submitResult.details, completeAcceptReceipt("submit"));
    assert.deepEqual(blockedResult.details, completeAcceptReceipt("blocked"));
    assert.deepEqual(forwarded[0]!.raw_payload, { explicit: null });
    assert.deepEqual(forwarded[0]!.runtime_evidence, {
      schema: "autopilot.child_control_runtime_evidence.v1",
      delivery_policy_denials: { schema: "autopilot.delivery_policy_denials.v2", overflowed: false, entries: [] },
      approved_command_executions: { schema: "autopilot.approved_command_executions.v1", overflowed: false, entries: [] },
    });
    assert.deepEqual(forwarded[1]!.raw_payload, blockedRaw);
    assert.deepEqual(forwarded[1]!.runtime_evidence, {
      schema: "autopilot.child_control_runtime_evidence.v1", delivery_policy_denials: null, approved_command_executions: null,
    });
  } finally {
    await broker.stop();
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearDeliveryPolicyEnv();
  }
});

test("no parent bulk planning terminal registration remains", () => {
  const runtime = readFileSync(
    new URL("../../child-runtime/child-extension-runtime.ts", import.meta.url),
    "utf8",
  );
  const wrapper = readFileSync(
    new URL("../../src/generated/child-extension.ts", import.meta.url),
    "utf8",
  );
  const parent = readFileSync(new URL("../../extensions/autopilot.ts", import.meta.url), "utf8");
  assert(!runtime.includes("registerSubmitTools"));
  assert(!wrapper.includes("registerSubmitTools"));
  assert(!parent.includes("registerSubmitTools"));
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
      { id: "U1", kind: "implementation", files: ["README.md"], commands: [{ command, expected: "Command exits successfully.", effect: "no-effect", generated_paths: [], handling: "none", scope_preservation: "The persistent candidate worktree is unchanged by verification." }], package_checks: [{ check_id: "PKG-U1-TIP", kind: "clean-exact-package-tip", criterion_ordinals: [1], expected: "Core proves the exact clean package tip." }] },
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

test("V2 package proof receipt citations are rejected before validation read exposure", () => {
  assert.throws(
    () => new ValidationReadPolicy("context", "0".repeat(64), process.cwd(), [{
      evidence_ref: "v2-package-proof-receipt:proof:deadbeef",
      kind: "delivery-v2-package-proof",
      source_path: "src.txt",
      blob_digest: "0".repeat(64),
      line_count: 1,
    }]),
    /source\/diff-only/,
  );
});

test("selected terminal profile registers exactly one same-name schema", { concurrency: false }, async () => {
  const previousProfile = process.env.AUTOPILOT_TERMINAL_PROFILE;
  const previousBinding = process.env.AUTOPILOT_CARRIER_BINDING;
  try {
    const wrapperUrl = new URL("../../src/generated/child-extension.ts", import.meta.url);
    const runtimeUrl = new URL("../../child-runtime/child-extension-runtime.ts", import.meta.url);
    const wrapperDigest = createHash("sha256")
      .update(Buffer.concat([readFileSync(wrapperUrl), Buffer.from([0]), readFileSync(runtimeUrl)]))
      .digest("hex");
    assert.equal(SUBMIT_TOOLS.length, 14);
    for (const [profileId, name, boundaryId, resultContract] of EXPECTED_TERMINAL_PROFILES) {
      const expected = SUBMIT_TOOLS.find((descriptor) =>
        descriptor.profile_id === profileId
        && descriptor.name === name
        && descriptor.boundary_id === boundaryId
        && descriptor.result_contract === resultContract,
      );
      assert.ok(expected, `missing hard-coded descriptor ${profileId}`);
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
      if (validationEnv) assert.notEqual(submitTool.prepareArguments, undefined, "replay_v0 V3 uses generated nonce-correlated raw capture");
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

test("replay_v0 V3 raw capture preserves malformed trees across reversed calls without a BLOCKED fallback", { concurrency: false }, async () => {
  const controlKeys = ["AUTOPILOT_CONTROL_SOCK", "AUTOPILOT_CONTROL_TOKEN", "AUTOPILOT_CONTROL_RUN_ID", "AUTOPILOT_CONTROL_ASSIGNMENT", "AUTOPILOT_CONTROL_ATTEMPT", "AUTOPILOT_TERMINAL_PROFILE"] as const;
  const prior = new Map(controlKeys.map((key) => [key, process.env[key]]));
  const validation = installValidationPolicyEnv();
  try {
    for (const key of controlKeys) delete process.env[key];
    process.env.AUTOPILOT_TERMINAL_PROFILE = "validation-status.v3";
    const tools: RegisteredTool[] = [];
    const cwd = process.cwd();
    process.chdir(validation.worktree);
    try {
      childExtension({ registerTool(tool: RegisteredTool) { tools.push(tool); }, on() {}, appendEntry() {}, getActiveTools() { return tools.map((tool) => tool.name); } } as never);
    } finally {
      process.chdir(cwd);
    }
    const submit = tools.find((tool) => tool.name === "autopilot_emit_status")!;
    // replay_v0 has no authenticated ChildControl; registering BLOCKED here would be silent/nonfunctional.
    assert.equal(tools.some((tool) => tool.name === BLOCKED_REPORT_TOOL.name), false);
    assert.notEqual(submit.prepareArguments, undefined);
    const firstRaw = ["malformed-top-level", { null_value: null }];
    const secondRaw = null;
    const first = submit.prepareArguments!(firstRaw);
    const second = submit.prepareArguments!(secondRaw);
    const secondResult = await submit.execute("replay-second", second);
    const firstResult = await submit.execute("replay-first", first);
    assert.deepEqual(secondResult.details?.payload, secondRaw);
    assert.deepEqual(firstResult.details?.payload, firstRaw);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
