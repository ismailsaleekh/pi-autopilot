import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  workspaceIntentCapsule,
  workspaceObservationCapsule,
} from "../../ports/contracts/workspace.capsule.js";
import type {
  WorkspaceIntent,
  WorkspaceObservation,
} from "../../ports/contracts/workspace.capsule.js";

export interface WorkspaceAdapterDiagnostic {
  readonly code: string;
  readonly message: string;
}

export type WorkspaceAdapterExecution =
  | { readonly kind: "observation"; readonly observation: WorkspaceObservation }
  | { readonly kind: "rejected"; readonly diagnostic: WorkspaceAdapterDiagnostic };

export interface WorkspaceAdapterOptions {
  /** Real directory owned by one run; every workspace path is derived below it. */
  readonly workspaceRoot: string;
}

export type WorkspaceAdapterCreateResult =
  | { readonly kind: "created"; readonly adapter: WorkspaceAdapter }
  | { readonly kind: "rejected"; readonly diagnostic: WorkspaceAdapterDiagnostic };

export type WorkspaceEntry =
  | {
      readonly kind: "directory";
      readonly mode: number;
      readonly path: string;
    }
  | {
      readonly bytes: Uint8Array;
      readonly kind: "file";
      readonly mode: number;
      readonly path: string;
    }
  | {
      readonly kind: "symlink";
      readonly mode: number;
      readonly path: string;
      readonly target: string;
    };

export type WorkspaceReadResult =
  | { readonly kind: "read"; readonly entries: readonly WorkspaceEntry[] }
  | { readonly kind: "retry"; readonly diagnostic: WorkspaceAdapterDiagnostic };

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function diagnostic(code: string, message: string): WorkspaceAdapterDiagnostic {
  return Object.freeze({ code, message });
}

function contractDiagnostic(code: string, message: string) {
  return Object.freeze({ code, message, related: Object.freeze([]) });
}

function systemCode(error: unknown): string | null {
  try {
    if (typeof error !== "object" || error === null) {
      return null;
    }
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function safeDecode(input: unknown):
  | { readonly kind: "ok"; readonly value: WorkspaceIntent }
  | { readonly kind: "error"; readonly diagnostic: WorkspaceAdapterDiagnostic } {
  try {
    const encoded = workspaceIntentCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return Object.freeze({
        kind: "error",
        diagnostic: diagnostic(
          "workspace.invalid-intent",
          "workspace intent does not satisfy the frozen contract",
        ),
      });
    }
    const decoded = workspaceIntentCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "ok", value: decoded.value })
      : Object.freeze({
          kind: "error",
          diagnostic: diagnostic(
            "workspace.invalid-intent",
            "workspace intent is not canonically encoded",
          ),
        });
  } catch {
    return Object.freeze({
      kind: "error",
      diagnostic: diagnostic(
        "workspace.uninspectable-intent",
        "workspace intent could not be inspected safely",
      ),
    });
  }
}

function validWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value) && value !== "." && value !== "..";
}

function isBelow(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

async function nearestExistingAncestor(path: string): Promise<string | null> {
  let probe = path;
  while (true) {
    try {
      await lstat(probe);
      return probe;
    } catch (error: unknown) {
      if (systemCode(error) !== "ENOENT") {
        return null;
      }
      const parent = dirname(probe);
      if (parent === probe) {
        return null;
      }
      probe = parent;
    }
  }
}

async function realDirectory(path: string): Promise<string | null> {
  try {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) {
      return null;
    }
    await stat(path);
    return await realpath(path);
  } catch {
    return null;
  }
}

async function collectEntries(
  root: string,
  relativePath: string,
  output: WorkspaceEntry[],
): Promise<WorkspaceAdapterDiagnostic | null> {
  const directory = relativePath === "" ? root : join(root, ...relativePath.split("/"));
  let names: string[];
  try {
    names = (await readdir(directory)).slice().sort(compareText);
  } catch {
    return diagnostic("workspace.read-failed", "workspace directory could not be enumerated");
  }
  for (const name of names) {
    const path = relativePath === "" ? name : `${relativePath}/${name}`;
    const absolute = join(directory, name);
    let status: Stats;
    try {
      status = await lstat(absolute);
    } catch {
      return diagnostic("workspace.read-failed", "workspace entry changed during enumeration");
    }
    if (status.isSymbolicLink()) {
      let target: string;
      try {
        target = await readlink(absolute);
      } catch {
        return diagnostic("workspace.read-failed", "workspace symlink changed during enumeration");
      }
      output.push(Object.freeze({
        kind: "symlink",
        mode: status.mode & 0o7777,
        path,
        target,
      }));
    } else if (status.isDirectory()) {
      output.push(Object.freeze({
        kind: "directory",
        mode: status.mode & 0o7777,
        path,
      }));
      const nested = await collectEntries(root, path, output);
      if (nested !== null) {
        return nested;
      }
    } else if (status.isFile()) {
      let handle;
      try {
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino) {
          await handle.close();
          return diagnostic("workspace.read-raced", "workspace file identity changed before reading");
        }
        const bytes = await readFile(handle);
        const completed = await handle.stat();
        await handle.close();
        if (
          completed.dev !== status.dev
          || completed.ino !== status.ino
          || completed.size !== status.size
          || completed.mtimeMs !== status.mtimeMs
        ) {
          return diagnostic("workspace.read-raced", "workspace file changed while being read");
        }
        output.push(Object.freeze({
          bytes: Uint8Array.from(bytes),
          kind: "file",
          mode: status.mode & 0o7777,
          path,
        }));
      } catch {
        if (handle !== undefined) {
          try {
            await handle.close();
          } catch {
            // The deterministic typed result below remains authoritative.
          }
        }
        return diagnostic("workspace.read-failed", "workspace file could not be read safely");
      }
    } else {
      return diagnostic(
        "workspace.unsupported-entry",
        "workspace contains an entry that cannot be sealed",
      );
    }
  }
  return null;
}

/**
 * Filesystem leaf for run-owned attempt directories.
 *
 * Allocation reserves only a fresh real directory. Git materialization owns clone
 * bytes. Isolation records no policy state here: W3 must enforce mounts, process
 * credentials, network rules, and child epochs at the OS/supervisor boundary.
 */
export class WorkspaceAdapter {
  readonly workspaceRoot: string;

  private constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  public static async create(options: WorkspaceAdapterOptions): Promise<WorkspaceAdapterCreateResult> {
    try {
      if (
        typeof options !== "object"
        || options === null
        || typeof options.workspaceRoot !== "string"
        || options.workspaceRoot.length === 0
        || options.workspaceRoot.includes("\u0000")
      ) {
        return Object.freeze({
          kind: "rejected",
          diagnostic: diagnostic(
            "workspace.invalid-root",
            "workspace root must be a nonempty filesystem path without NUL bytes",
          ),
        });
      }
      const requestedRoot = resolve(options.workspaceRoot);
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const rootStatus = await lstat(requestedRoot);
      if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
        return Object.freeze({
          kind: "rejected",
          diagnostic: diagnostic(
            "workspace.unsafe-root",
            "workspace root must be a real directory and never a symlink",
          ),
        });
      }
      const workspaceRoot = await realpath(requestedRoot);
      return Object.freeze({
        kind: "created",
        adapter: new WorkspaceAdapter(workspaceRoot),
      });
    } catch {
      return Object.freeze({
        kind: "rejected",
        diagnostic: diagnostic(
          "workspace.root-unavailable",
          "workspace root could not be prepared",
        ),
      });
    }
  }

  public pathFor(workspaceId: string): string | null {
    if (!validWorkspaceId(workspaceId)) {
      return null;
    }
    const candidate = resolve(this.workspaceRoot, workspaceId);
    return isBelow(this.workspaceRoot, candidate) ? candidate : null;
  }

  public async readWorkspace(workspaceId: string): Promise<WorkspaceReadResult> {
    const path = this.pathFor(workspaceId);
    if (path === null) {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("workspace.invalid-id", "workspace ID cannot name a private directory"),
      });
    }
    try {
      const status = await lstat(path);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        return Object.freeze({
          kind: "retry",
          diagnostic: diagnostic("workspace.unsafe-entry", "workspace path must be a real directory"),
        });
      }
    } catch {
      return Object.freeze({
        kind: "retry",
        diagnostic: diagnostic("workspace.absent", "workspace directory is absent"),
      });
    }
    const entries: WorkspaceEntry[] = [];
    const failure = await collectEntries(path, "", entries);
    return failure === null
      ? Object.freeze({ kind: "read", entries: Object.freeze(entries) })
      : Object.freeze({ kind: "retry", diagnostic: failure });
  }

  public async execute(input: unknown): Promise<WorkspaceAdapterExecution> {
    const decoded = safeDecode(input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    const intent = decoded.value;
    switch (intent.kind) {
      case "allocate-attempt-directory":
        return workspaceIntentHandlers["allocate-attempt-directory"](this, intent);
      case "apply-attempt-isolation":
        return workspaceIntentHandlers["apply-attempt-isolation"](this, intent);
      case "dispose-attempt-directory":
        return workspaceIntentHandlers["dispose-attempt-directory"](this, intent);
      case "inspect-attempt-directory":
        return workspaceIntentHandlers["inspect-attempt-directory"](this, intent);
    }
  }

  public async allocate(
    intent: Extract<WorkspaceIntent, { readonly kind: "allocate-attempt-directory" }>,
  ): Promise<WorkspaceAdapterExecution> {
    const path = this.pathFor(intent.inputs.workspaceId);
    if (path === null) {
      return this.observation(intent, "attempt-directory-allocated", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic(
          "workspace.invalid-id",
          "workspace ID cannot name a private directory",
        ),
      }));
    }
    try {
      await mkdir(path, { mode: 0o700 });
      return this.observation(intent, "attempt-directory-allocated", Object.freeze({
        kind: "ok",
        value: Object.freeze({
          empty: true,
          leaseId: intent.preconditions.leaseId,
          workspaceCapability: intent.inputs.workspaceCapability,
          workspaceId: intent.inputs.workspaceId,
        }),
      }));
    } catch (error: unknown) {
      const code = systemCode(error);
      return this.observation(intent, "attempt-directory-allocated", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic(
          code === "EEXIST" ? "workspace.already-exists" : "workspace.allocate-failed",
          code === "EEXIST"
            ? "workspace directory is already allocated"
            : "workspace directory could not be allocated",
        ),
      }));
    }
  }

  public async applyIsolation(
    intent: Extract<WorkspaceIntent, { readonly kind: "apply-attempt-isolation" }>,
  ): Promise<WorkspaceAdapterExecution> {
    const path = this.pathFor(intent.inputs.workspaceId);
    let present = false;
    if (path !== null) {
      try {
        const status = await lstat(path);
        present = status.isDirectory() && !status.isSymbolicLink();
      } catch {
        present = false;
      }
    }
    if (
      !present
      || intent.inputs.isolationPolicy.digest !== intent.preconditions.expectedPolicyDigest
      || intent.inputs.isolationPolicy.root !== intent.preconditions.expectedWorkspaceRoot
    ) {
      return this.observation(intent, "attempt-isolation-applied", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic(
          "workspace.isolation-precondition",
          "workspace or isolation policy does not match its explicit precondition",
        ),
      }));
    }
    return this.observation(intent, "attempt-isolation-applied", Object.freeze({
      kind: "retry",
      diagnostic: contractDiagnostic(
        "workspace.isolation-enforcement-unavailable",
        "filesystem adapter cannot claim OS isolation without an injected enforcement attestation",
      ),
    }));
  }

  public async inspect(
    intent: Extract<WorkspaceIntent, { readonly kind: "inspect-attempt-directory" }>,
  ): Promise<WorkspaceAdapterExecution> {
    const path = this.pathFor(intent.inputs.workspaceId);
    if (path === null) {
      return this.observation(intent, "attempt-directory-inspected", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("workspace.invalid-id", "workspace ID is unsafe"),
      }));
    }
    try {
      const status = await lstat(path);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        return this.observation(intent, "attempt-directory-inspected", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic(
            "workspace.unsafe-entry",
            "workspace path exists but is not a real directory",
          ),
        }));
      }
      return this.observation(intent, "attempt-directory-inspected", Object.freeze({
        kind: "ok",
        value: Object.freeze({
          childEpoch: intent.preconditions.childEpoch,
          leaseId: intent.preconditions.leaseId,
          observedRoot: null,
          state: (await readdir(path)).length === 0 ? "empty-reserved" : "occupied",
          workspaceId: intent.inputs.workspaceId,
        }),
      }));
    } catch (error: unknown) {
      if (systemCode(error) === "ENOENT") {
        return this.observation(intent, "attempt-directory-inspected", Object.freeze({
          kind: "ok",
          value: Object.freeze({
            childEpoch: intent.preconditions.childEpoch,
            leaseId: intent.preconditions.leaseId,
            observedRoot: null,
            state: "absent",
            workspaceId: intent.inputs.workspaceId,
          }),
        }));
      }
      return this.observation(intent, "attempt-directory-inspected", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic(
          "workspace.inspect-failed",
          "workspace directory could not be inspected",
        ),
      }));
    }
  }

  public async dispose(
    intent: Extract<WorkspaceIntent, { readonly kind: "dispose-attempt-directory" }>,
  ): Promise<WorkspaceAdapterExecution> {
    const path = this.pathFor(intent.inputs.workspaceId);
    if (path === null) {
      return this.observation(intent, "attempt-directory-disposed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic("workspace.invalid-id", "workspace ID is unsafe"),
      }));
    }
    try {
      const ancestor = await nearestExistingAncestor(path);
      const root = await realDirectory(this.workspaceRoot);
      if (ancestor === null || root === null) {
        return this.observation(intent, "attempt-directory-disposed", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic(
            "workspace.dispose-safety",
            "workspace deletion ancestry could not be proven safe",
          ),
        }));
      }
      const ancestorStatus = await lstat(ancestor);
      if (ancestorStatus.isSymbolicLink()) {
        return this.observation(intent, "attempt-directory-disposed", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic(
            "workspace.dispose-symlink",
            "workspace deletion refuses a symlink entry",
          ),
        }));
      }
      const resolvedAncestor = resolve(ancestor);
      if (resolvedAncestor !== root && !isBelow(root, resolvedAncestor)) {
        return this.observation(intent, "attempt-directory-disposed", Object.freeze({
          kind: "retry",
          diagnostic: contractDiagnostic(
            "workspace.dispose-escape",
            "workspace deletion would escape the run workspace root",
          ),
        }));
      }
      let disposed = true;
      try {
        const targetStatus = await lstat(path);
        if (targetStatus.isSymbolicLink()) {
          return this.observation(intent, "attempt-directory-disposed", Object.freeze({
            kind: "retry",
            diagnostic: contractDiagnostic(
              "workspace.dispose-symlink",
              "workspace deletion refuses a symlink target",
            ),
          }));
        }
        await rm(path, { recursive: true, force: false });
      } catch (error: unknown) {
        if (systemCode(error) === "ENOENT") {
          disposed = false;
        } else {
          return this.observation(intent, "attempt-directory-disposed", Object.freeze({
            kind: "retry",
            diagnostic: contractDiagnostic(
              "workspace.dispose-failed",
              "workspace directory could not be disposed",
            ),
          }));
        }
      }
      return this.observation(intent, "attempt-directory-disposed", Object.freeze({
        kind: "ok",
        value: Object.freeze({
          disposed,
          fencedChildEpoch: intent.preconditions.fencedChildEpoch,
          workspaceId: intent.inputs.workspaceId,
        }),
      }));
    } catch {
      return this.observation(intent, "attempt-directory-disposed", Object.freeze({
        kind: "retry",
        diagnostic: contractDiagnostic(
          "workspace.dispose-failed",
          "workspace directory could not be disposed safely",
        ),
      }));
    }
  }

  private observation(
    intent: WorkspaceIntent,
    kind: WorkspaceObservation["kind"],
    result: unknown,
  ): WorkspaceAdapterExecution {
    try {
      const encoded = workspaceObservationCapsule.encodeUnknown(Object.freeze({
        actionId: intent.actionId,
        kind,
        result,
        runId: intent.runId,
      }));
      if (encoded.kind === "error") {
        return Object.freeze({
          kind: "rejected",
          diagnostic: diagnostic(
            "workspace.invalid-observation",
            "workspace operation produced an invalid normalized observation",
          ),
        });
      }
      const decoded = workspaceObservationCapsule.decodeCanonical(encoded.value);
      return decoded.kind === "ok"
        ? Object.freeze({ kind: "observation", observation: decoded.value })
        : Object.freeze({
            kind: "rejected",
            diagnostic: diagnostic(
              "workspace.invalid-observation",
              "workspace operation produced a noncanonical observation",
            ),
          });
    } catch {
      return Object.freeze({
        kind: "rejected",
        diagnostic: diagnostic(
          "workspace.observation-failed",
          "workspace observation could not be normalized",
        ),
      });
    }
  }
}

type WorkspaceIntentHandlerMap = {
  readonly [Kind in WorkspaceIntent["kind"]]: (
    adapter: WorkspaceAdapter,
    intent: Extract<WorkspaceIntent, { readonly kind: Kind }>,
  ) => Promise<WorkspaceAdapterExecution>;
};

/** Closed one-filesystem-operation handler map. */
export const workspaceIntentHandlers = Object.freeze({
  "allocate-attempt-directory": (
    adapter: WorkspaceAdapter,
    intent: Extract<WorkspaceIntent, { readonly kind: "allocate-attempt-directory" }>,
  ) => adapter.allocate(intent),
  "apply-attempt-isolation": (
    adapter: WorkspaceAdapter,
    intent: Extract<WorkspaceIntent, { readonly kind: "apply-attempt-isolation" }>,
  ) => adapter.applyIsolation(intent),
  "dispose-attempt-directory": (
    adapter: WorkspaceAdapter,
    intent: Extract<WorkspaceIntent, { readonly kind: "dispose-attempt-directory" }>,
  ) => adapter.dispose(intent),
  "inspect-attempt-directory": (
    adapter: WorkspaceAdapter,
    intent: Extract<WorkspaceIntent, { readonly kind: "inspect-attempt-directory" }>,
  ) => adapter.inspect(intent),
}) satisfies WorkspaceIntentHandlerMap;
