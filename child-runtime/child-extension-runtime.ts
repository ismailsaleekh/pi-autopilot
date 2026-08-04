import { createHash } from "node:crypto";
import { constants, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBashTool,
  createEditTool,
  createLocalBashOperations,
  createWriteTool,
  defineTool,
  type BashOperations,
  type EditOperations,
  type ExtensionAPI,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import type { SubmitToolDescriptor } from "../src/generated/tool-schemas.ts";

export const CHILD_RECEIPT_ENTRY = "pi-autopilot:child-tools";
export const DELIVERY_POLICY_VERSION = "autopilot.delivery_tool_policy.v1";
export const DELIVERY_POLICY_OVERRIDES = ["bash", "edit", "write"] as const;

const DELIVERY_PROFILE_ID = "delivery-status.v2";
const MAX_DELIVERY_ASSIGNMENT_BYTES = 256 * 1024;
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

type SubmitTools = readonly SubmitToolDescriptor[];

type DeliveryEnv = Record<(typeof DELIVERY_ENV_KEYS)[number], string>;

type DeliveryAssignmentArtifact = {
  schema: string;
  workstream: string;
  assignment_id: string;
  lane_id: string;
  attempt: number;
  base_commit: string;
  worktree: string;
  ordered_units: DeliveryUnit[];
};

type DeliveryUnit = {
  id: string;
  kind: string;
  files: string[];
  commands: Array<{ command: string }>;
};

type DeliveryPolicyReceipt = {
  version: string;
  assignment_path: string;
  assignment_digest: string;
  worktree: string;
  cwd: string;
  policy_digest: string;
  allowed_unit_file_count: number;
  approved_command_count: number;
  active_overrides: string[];
};

class SerialPolicyQueue {
  private current: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.current.catch(() => undefined).then(() => Promise.resolve(operation()));
    this.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export class DeliveryPolicy {
  readonly assignmentPath: string;
  readonly assignmentDigest: string;
  readonly worktree: string;
  readonly cwd: string;
  readonly policyDigest: string;
  readonly allowedRelativePaths: Set<string>;
  readonly allowedAbsolutePaths: Set<string>;
  readonly allowedParentDirectories: Set<string>;
  readonly approvedCommands: Set<string>;
  readonly queue = new SerialPolicyQueue();

  constructor(input: {
    assignmentPath: string;
    assignmentDigest: string;
    worktree: string;
    cwd: string;
    policyDigest: string;
    allowedRelativePaths: Set<string>;
    approvedCommands: Set<string>;
  }) {
    this.assignmentPath = input.assignmentPath;
    this.assignmentDigest = input.assignmentDigest;
    this.worktree = input.worktree;
    this.cwd = input.cwd;
    this.policyDigest = input.policyDigest;
    this.allowedRelativePaths = input.allowedRelativePaths;
    this.approvedCommands = input.approvedCommands;
    this.allowedAbsolutePaths = new Set(
      [...this.allowedRelativePaths].map((relativePath) => path.resolve(this.worktree, relativePath)),
    );
    this.allowedParentDirectories = new Set(
      [...this.allowedAbsolutePaths].flatMap((absolutePath) => ancestorDirectoryChain(this.worktree, absolutePath)),
    );
  }

  receipt(): DeliveryPolicyReceipt {
    return {
      version: DELIVERY_POLICY_VERSION,
      assignment_path: this.assignmentPath,
      assignment_digest: this.assignmentDigest,
      worktree: this.worktree,
      cwd: this.cwd,
      policy_digest: this.policyDigest,
      allowed_unit_file_count: this.allowedRelativePaths.size,
      approved_command_count: this.approvedCommands.size,
      active_overrides: [...DELIVERY_POLICY_OVERRIDES],
    };
  }
}

export function runAutopilotChild(
  pi: ExtensionAPI,
  tools: SubmitTools,
  wrapperUrl: string,
): void {
  const tool = selectedTerminalTool(tools);
  const deliveryPolicy = loadDeliveryPolicyForProfile(tool.profile_id);
  if (deliveryPolicy) registerDeliveryPolicyTools(pi, deliveryPolicy);
  registerTool(pi, tool);
  pi.on("session_start", async () => {
    const receipt: Record<string, unknown> = {
      self_digest: selfDigest(wrapperUrl),
      profile_id: tool.profile_id,
      tool_name: tool.name,
      boundary_id: tool.boundary_id,
      result_contract: tool.result_contract,
      schema_digest: tool.schema_digest,
      binding: process.env["AUTOPILOT_CARRIER_BINDING"] ?? "",
      active_tools: [...pi.getActiveTools()].sort(),
    };
    if (deliveryPolicy) receipt["delivery_policy"] = deliveryPolicy.receipt();
    pi.appendEntry(CHILD_RECEIPT_ENTRY, receipt);
  });
}

export function registerSubmitTools(pi: ExtensionAPI, tools: SubmitTools, _wrapperUrl: string): void {
  for (const tool of tools) {
    if (tool.boundary_id.startsWith("planning.")) registerTool(pi, tool);
  }
}

export function registerDeliveryPolicyTools(pi: ExtensionAPI, policy: DeliveryPolicy): void {
  const bashTool = createBashTool(policy.cwd, { operations: createDeliveryBashOperations(policy) });
  const editTool = createEditTool(policy.cwd, { operations: createDeliveryEditOperations(policy) });
  const writeTool = createWriteTool(policy.cwd, { operations: createDeliveryWriteOperations(policy) });

  pi.registerTool({
    ...bashTool,
    async execute(id, params, signal, onUpdate, ctx) {
      return policy.queue.run(() => bashTool.execute(id, params, signal, onUpdate, ctx));
    },
  });
  pi.registerTool({
    ...editTool,
    async execute(id, params, signal, onUpdate, ctx) {
      assertRawMutationPath(policy, params);
      return policy.queue.run(() => editTool.execute(id, params, signal, onUpdate, ctx));
    },
  });
  pi.registerTool({
    ...writeTool,
    async execute(id, params, signal, onUpdate, ctx) {
      assertRawMutationPath(policy, params);
      return policy.queue.run(() => writeTool.execute(id, params, signal, onUpdate, ctx));
    },
  });
}

function selectedTerminalTool(tools: SubmitTools): SubmitToolDescriptor {
  const profileId = process.env["AUTOPILOT_TERMINAL_PROFILE"] ?? "";
  const matches = tools.filter((tool) => tool.profile_id === profileId);
  if (matches.length !== 1) {
    const quoted = JSON.stringify(profileId);
    throw new Error(`autopilot child terminal profile ${quoted} resolved ${matches.length} descriptors`);
  }
  const match = matches[0];
  if (match === undefined) throw new Error("autopilot child terminal profile selection disappeared");
  return match;
}

function registerTool(pi: ExtensionAPI, tool: SubmitToolDescriptor): void {
  const computed = createHash("sha256").update(canonicalJson(tool.parameters)).digest("hex");
  if (computed !== tool.schema_digest) {
    throw new Error(
      `autopilot child tool ${tool.name} parameter digest drift: declared ${tool.schema_digest}, computed ${computed}`,
    );
  }
  const description = `Submit the final ${tool.boundary_id} payload. Use this as the final action;`;
  pi.registerTool(defineTool({
    name: tool.name,
    label: tool.label,
    description: `${description} assistant prose is not a carrier.`,
    promptSnippet: `Submit ${tool.boundary_id} as a terminating typed Autopilot carrier`,
    promptGuidelines: [
      `Call ${tool.name} exactly once as the final action for ${tool.boundary_id}.`,
      "Do not return the payload as assistant prose or markdown.",
    ],
    parameters: tool.parameters,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Submitted ${tool.boundary_id}` }],
        details: {
          profile_id: tool.profile_id,
          tool_name: tool.name,
          boundary_id: tool.boundary_id,
          result_contract: tool.result_contract,
          schema_digest: tool.schema_digest,
          binding: process.env["AUTOPILOT_CARRIER_BINDING"] ?? "",
          payload: params as Record<string, unknown>,
        },
        terminate: true,
      };
    },
  }));
}

function loadDeliveryPolicyForProfile(profileId: string): DeliveryPolicy | undefined {
  const present = DELIVERY_ENV_KEYS.filter((key) => process.env[key] !== undefined);
  if (profileId !== DELIVERY_PROFILE_ID) {
    if (present.length > 0) {
      throw new Error(`autopilot delivery policy env present for non-delivery profile: ${present.join(",")}`);
    }
    return undefined;
  }
  if (present.length !== DELIVERY_ENV_KEYS.length) {
    throw new Error(
      `autopilot delivery policy env must be all-or-none: present ${present.length}/${DELIVERY_ENV_KEYS.length}`,
    );
  }
  const env = Object.fromEntries(
    DELIVERY_ENV_KEYS.map((key) => {
      const value = process.env[key];
      if (value === undefined || value.trim() === "") throw new Error(`autopilot delivery policy env ${key} is empty`);
      return [key, value];
    }),
  ) as DeliveryEnv;
  return loadDeliveryPolicyFromEnv(env, process.cwd());
}

export function loadDeliveryPolicyFromEnv(env: DeliveryEnv, processCwd: string): DeliveryPolicy {
  const assignmentPath = canonicalRegularFile("assignment_path", env.AUTOPILOT_DELIVERY_ASSIGNMENT_PATH);
  const worktree = canonicalDirectory("worktree", env.AUTOPILOT_DELIVERY_WORKTREE);
  const cwd = canonicalDirectory("cwd", env.AUTOPILOT_DELIVERY_CWD);
  const actualProcessCwd = canonicalDirectory("process.cwd", processCwd);
  if (cwd !== worktree || actualProcessCwd !== worktree) {
    throw new Error(`autopilot delivery policy cwd/worktree mismatch: cwd=${cwd} worktree=${worktree} process=${actualProcessCwd}`);
  }

  const assignmentBytes = readFileSync(assignmentPath);
  if (assignmentBytes.length > MAX_DELIVERY_ASSIGNMENT_BYTES) {
    throw new Error(
      `autopilot delivery assignment oversized: ${assignmentBytes.length} bytes exceeds ${MAX_DELIVERY_ASSIGNMENT_BYTES}`,
    );
  }
  const assignmentDigest = sha256Hex(assignmentBytes);
  if (assignmentDigest !== env.AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST) {
    throw new Error("autopilot delivery assignment digest drift");
  }
  const artifact = parseDeliveryAssignment(assignmentBytes);
  assertAssignmentIdentity(artifact, env, worktree);
  const allowedRelativePaths = new Set<string>();
  const approvedCommands = new Set<string>();
  const seenUnitIds = new Set<string>();
  const seenUnitFilePaths = new Set<string>();
  for (const unit of artifact.ordered_units) {
    if (seenUnitIds.has(unit.id)) throw new Error(`autopilot delivery duplicate unit id: ${unit.id}`);
    seenUnitIds.add(unit.id);
    if (unit.kind !== "implementation") throw new Error(`autopilot delivery unit is not implementation: ${unit.id}`);
    for (const filePath of unit.files) {
      if (!isSafeRelativeUnitPath(filePath)) throw new Error(`autopilot delivery unsafe unit file path: ${filePath}`);
      if (seenUnitFilePaths.has(filePath)) throw new Error(`autopilot delivery duplicate unit file path: ${filePath}`);
      seenUnitFilePaths.add(filePath);
      allowedRelativePaths.add(filePath);
    }
    for (const command of unit.commands) {
      if (typeof command.command !== "string" || command.command.trim() === "") {
        throw new Error(`autopilot delivery empty approved command: ${unit.id}`);
      }
      approvedCommands.add(command.command);
    }
  }
  if (allowedRelativePaths.size === 0 || approvedCommands.size === 0) {
    throw new Error("autopilot delivery policy has no unit files or commands");
  }
  const policyDigest = deliveryPolicyDigest({ assignmentPath, assignmentDigest, worktree, cwd });
  if (policyDigest !== env.AUTOPILOT_DELIVERY_POLICY_DIGEST) {
    throw new Error("autopilot delivery policy digest drift");
  }
  return new DeliveryPolicy({
    assignmentPath,
    assignmentDigest,
    worktree,
    cwd,
    policyDigest,
    allowedRelativePaths,
    approvedCommands,
  });
}

export function deliveryPolicyDigest(input: {
  assignmentPath: string;
  assignmentDigest: string;
  worktree: string;
  cwd: string;
}): string {
  return sha256Hex(
    Buffer.from(
      `${DELIVERY_POLICY_VERSION}\0${input.assignmentPath}\0${input.assignmentDigest}\0${input.worktree}\0${input.cwd}`,
      "utf8",
    ),
  );
}

function createDeliveryBashOperations(policy: DeliveryPolicy): BashOperations {
  const local = createLocalBashOperations();
  return {
    async exec(command, cwd, options) {
      if (!policy.approvedCommands.has(command)) {
        throw new Error("Delivery policy blocked unapproved bash command");
      }
      const actualCwd = canonicalDirectory("bash cwd", cwd);
      if (actualCwd !== policy.worktree) {
        throw new Error(`Delivery policy blocked bash cwd mismatch: ${actualCwd}`);
      }
      return local.exec(command, policy.worktree, options);
    },
  };
}

function createDeliveryEditOperations(policy: DeliveryPolicy): EditOperations {
  return {
    async access(absolutePath) {
      assertMutationTopology(policy, absolutePath, true);
      await access(absolutePath, constants.R_OK | constants.W_OK);
    },
    async readFile(absolutePath) {
      assertMutationTopology(policy, absolutePath, true);
      return readFile(absolutePath);
    },
    async writeFile(absolutePath, content) {
      assertMutationTopology(policy, absolutePath, true);
      await writeFile(absolutePath, content, "utf8");
    },
  };
}

export function createDeliveryWriteOperations(policy: DeliveryPolicy): WriteOperations {
  return {
    async mkdir(dir) {
      createApprovedDirectoryChain(policy, dir);
    },
    async writeFile(absolutePath, content) {
      assertMutationTopology(policy, absolutePath, false);
      await writeFile(absolutePath, content, "utf8");
    },
  };
}

function assertRawMutationPath(policy: DeliveryPolicy, params: unknown): void {
  if (params === null || typeof params !== "object") {
    throw new Error("Delivery policy blocked malformed mutation parameters");
  }
  const raw = (params as { path?: unknown }).path;
  if (typeof raw !== "string" || !policy.allowedRelativePaths.has(raw)) {
    throw new Error(`Delivery policy blocked unapproved mutation path: ${String(raw)}`);
  }
}

// Enumerates the full ancestor directory chain (top-down, exclusive of the
// worktree root itself, exclusive of the file's own basename) for a single
// approved absolute file path. This is the only source of mkdir authority:
// no directory outside this enumerated, assignment-derived set may ever be
// created by the delivery write tool.
function ancestorDirectoryChain(worktree: string, absolutePath: string): string[] {
  const parentRelative = path.relative(worktree, path.dirname(absolutePath));
  if (parentRelative === "" || parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
    return [];
  }
  const parts = parentRelative.split(path.sep);
  const chain: string[] = [];
  let current = worktree;
  for (const part of parts) {
    current = path.join(current, part);
    chain.push(current);
  }
  return chain;
}

// Creates every missing directory level in the approved ancestor chain
// leading to `dir`, top-down, one level at a time. Every level is
// re-verified for exact approved-ancestor membership (no prefix widening),
// worktree containment, and reserved-name exclusion before it is touched.
// After creating (or finding) each level, it is re-lstat'd and rejected if
// it is not a real, non-symlink directory, closing the swap-a-symlink race.
function createApprovedDirectoryChain(policy: DeliveryPolicy, dir: string): void {
  const resolved = path.resolve(dir);
  if (!policy.allowedParentDirectories.has(resolved)) {
    throw new Error(`Delivery policy blocked unapproved parent directory: ${dir}`);
  }
  const relative = path.relative(policy.worktree, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Delivery policy blocked parent outside worktree: ${dir}`);
  }
  const parts = relative.split(path.sep);
  let current = policy.worktree;
  for (const part of parts) {
    if (part === ".git" || part === ".pi") {
      throw new Error(`Delivery policy blocked reserved parent: ${dir}`);
    }
    const next = path.join(current, part);
    if (!policy.allowedParentDirectories.has(next)) {
      throw new Error(`Delivery policy blocked unapproved parent directory: ${next}`);
    }
    ensureApprovedDirectoryLevel(next);
    current = next;
  }
}

function ensureApprovedDirectoryLevel(dir: string): void {
  let metadata;
  try {
    metadata = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dir);
    const created = lstatSync(dir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`Delivery policy blocked non-directory after mkdir: ${dir}`);
    }
    return;
  }
  if (metadata.isSymbolicLink()) throw new Error(`Delivery policy blocked symlink parent: ${dir}`);
  if (!metadata.isDirectory()) throw new Error(`Delivery policy blocked non-directory parent: ${dir}`);
}

function assertMutationTopology(policy: DeliveryPolicy, absolutePath: string, requireExistingFile: boolean): void {
  const resolved = path.resolve(absolutePath);
  if (!policy.allowedAbsolutePaths.has(resolved)) {
    throw new Error(`Delivery policy blocked unapproved mutation target: ${absolutePath}`);
  }
  const relative = path.relative(policy.worktree, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Delivery policy blocked path outside worktree: ${absolutePath}`);
  }
  const parts = relative.split(path.sep);
  if (parts.some((part) => part === ".git" || part === ".pi")) {
    throw new Error(`Delivery policy blocked reserved path: ${absolutePath}`);
  }
  let current = policy.worktree;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      // Only tolerate a not-yet-existing directory once it has already
      // passed approved-ancestor membership (i.e. it is a directory this
      // delivery is authorized to create via mkdir). This never widens
      // authority: unapproved directories still raise their raw ENOENT.
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        !requireExistingFile &&
        policy.allowedParentDirectories.has(current)
      ) {
        continue;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`Delivery policy blocked symlink parent: ${current}`);
    if (!metadata.isDirectory()) throw new Error(`Delivery policy blocked non-directory parent: ${current}`);
  }
  try {
    const metadata = lstatSync(resolved);
    if (metadata.isSymbolicLink()) throw new Error(`Delivery policy blocked symlink file: ${resolved}`);
    if (!metadata.isFile()) throw new Error(`Delivery policy blocked non-regular file: ${resolved}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !requireExistingFile) return;
    throw error;
  }
}

function parseDeliveryAssignment(bytes: Buffer): DeliveryAssignmentArtifact {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`autopilot delivery assignment malformed JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (value === null || typeof value !== "object") throw new Error("autopilot delivery assignment is not an object");
  const object = value as Record<string, unknown>;
  const ordered = object["ordered_units"];
  if (!Array.isArray(ordered) || ordered.length === 0) throw new Error("autopilot delivery assignment has no ordered_units");
  return {
    schema: requiredString(object, "schema"),
    workstream: requiredString(object, "workstream"),
    assignment_id: requiredString(object, "assignment_id"),
    lane_id: requiredString(object, "lane_id"),
    attempt: requiredNumber(object, "attempt"),
    base_commit: requiredString(object, "base_commit"),
    worktree: requiredString(object, "worktree"),
    ordered_units: ordered.map((unit, index) => parseDeliveryUnit(unit, index)),
  };
}

function parseDeliveryUnit(value: unknown, index: number): DeliveryUnit {
  if (value === null || typeof value !== "object") throw new Error(`autopilot delivery unit ${index} is not an object`);
  const object = value as Record<string, unknown>;
  const files = object["files"];
  const commands = object["commands"];
  if (!Array.isArray(files) || files.length === 0) throw new Error(`autopilot delivery unit ${index} has no files`);
  if (!Array.isArray(commands) || commands.length === 0) throw new Error(`autopilot delivery unit ${index} has no commands`);
  return {
    id: requiredString(object, "id"),
    kind: requiredString(object, "kind"),
    files: files.map((item) => {
      if (typeof item !== "string") throw new Error(`autopilot delivery unit ${index} has non-string file`);
      return item;
    }),
    commands: commands.map((item, commandIndex) => {
      if (item === null || typeof item !== "object") {
        throw new Error(`autopilot delivery unit ${index} command ${commandIndex} is not an object`);
      }
      return { command: requiredString(item as Record<string, unknown>, "command") };
    }),
  };
}

function assertAssignmentIdentity(artifact: DeliveryAssignmentArtifact, env: DeliveryEnv, worktree: string): void {
  if (artifact.schema !== "autopilot.delivery_assignment.v1") throw new Error("autopilot delivery assignment schema drift");
  if (
    artifact.assignment_id !== env.AUTOPILOT_DELIVERY_ASSIGNMENT_ID ||
    artifact.workstream !== env.AUTOPILOT_DELIVERY_WORKSTREAM ||
    artifact.lane_id !== env.AUTOPILOT_DELIVERY_LANE_ID ||
    String(artifact.attempt) !== env.AUTOPILOT_DELIVERY_ATTEMPT ||
    artifact.base_commit !== env.AUTOPILOT_DELIVERY_BASE_COMMIT ||
    canonicalDirectory("artifact.worktree", artifact.worktree) !== worktree
  ) {
    throw new Error("autopilot delivery assignment identity drift");
  }
}

function requiredString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`autopilot delivery assignment missing string ${key}`);
  return value;
}

function requiredNumber(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`autopilot delivery assignment missing number ${key}`);
  }
  return value;
}

function isSafeRelativeUnitPath(value: string): boolean {
  if (value === "" || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) return false;
  return value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git" && part !== ".pi");
}

function canonicalRegularFile(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`autopilot delivery ${label} must be absolute: ${value}`);
  rejectSymlinkComponents(value);
  const metadata = lstatSync(value);
  if (!metadata.isFile()) throw new Error(`autopilot delivery ${label} is not a regular file: ${value}`);
  return realpathSync.native(value);
}

function canonicalDirectory(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`autopilot delivery ${label} must be absolute: ${value}`);
  rejectSymlinkComponents(value);
  const metadata = lstatSync(value);
  if (!metadata.isDirectory()) throw new Error(`autopilot delivery ${label} is not a directory: ${value}`);
  return realpathSync.native(value);
}

function rejectSymlinkComponents(value: string): void {
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  const relativeParts = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`autopilot delivery symlink authority component refused: ${current}`);
  }
}

function selfDigest(wrapperUrl: string): string {
  const wrapperPath = fileURLToPath(wrapperUrl);
  const runtimePath = fileURLToPath(new URL("../../child-runtime/child-extension-runtime.ts", wrapperUrl));
  return sha256Hex(Buffer.concat([readFileSync(wrapperPath), Buffer.from([0]), readFileSync(runtimePath)]));
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
