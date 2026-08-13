import {
  childIntentCapsule,
} from "../../ports/contracts/child.capsule.js";
import type {
  ChildIntent,
  ChildObservation,
} from "../../ports/contracts/child.capsule.js";
import {
  actionIdSchema,
  workItemIdSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ActionId,
  ArtifactPath,
  ArtifactRoot,
  ChildEpoch,
  ChildId,
  WorkItemId,
  WorkspaceId,
} from "../../authority/protocol/identifiers.js";
import { defineCapsule } from "../../authority/protocol/schema.js";
import { ArtifactCatalog } from "./artifacts.js";
import { SimFileSystem } from "./sim-filesystem.js";
import { SimWorkspacePort } from "./fake-workspace.js";
import type { PortTraceSink, SimPortExecution } from "./port-types.js";
import { diagnostic, safeDecode } from "./port-types.js";
import { artifactPath, childIdFor, cloneBytes, digestForBytes } from "./values.js";

export type ChildScriptKey =
  | { readonly kind: "action-id"; readonly actionId: ActionId }
  | { readonly kind: "work-item-id"; readonly workItemId: WorkItemId };

export type ChildScriptEvent =
  | { readonly kind: "write"; readonly atTick: number; readonly path: ArtifactPath; readonly bytes: Uint8Array }
  | { readonly kind: "seal"; readonly atTick: number }
  | { readonly kind: "exit"; readonly atTick: number; readonly code: number }
  | { readonly kind: "hang"; readonly atTick: number }
  | { readonly kind: "kill"; readonly atTick: number };

export interface ChildScript {
  readonly key: ChildScriptKey;
  readonly events: readonly ChildScriptEvent[];
}

export type RegisterChildScriptResult =
  | { readonly kind: "registered"; readonly key: string; readonly events: number }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export interface ChildScheduler {
  readonly schedule: (tick: number, key: string, operation: () => void) => void;
  readonly cancel: (keyPrefix: string) => void;
}

interface ChildRecord {
  readonly childId: ChildId;
  readonly childEpoch: ChildEpoch;
  readonly workspaceId: WorkspaceId;
  readonly script: ChildScript;
  readonly launchedTick: number;
  nextEvent: number;
  state: "running" | "quiescent" | "absent";
  sealedRoot: ArtifactRoot | null;
}

export interface ChildImageEntry {
  readonly childId: ChildId;
  readonly childEpoch: ChildEpoch;
  readonly workspaceId: WorkspaceId;
  readonly scriptKey: string;
  readonly launchedTick: number;
  readonly nextEvent: number;
  readonly state: "running" | "quiescent" | "absent";
  readonly sealedRoot: ArtifactRoot | null;
}

export interface ChildImage {
  readonly children: readonly ChildImageEntry[];
}

const actionIdCapsule = defineCapsule("SimulationChildScriptActionId", actionIdSchema);
const workItemIdCapsule = defineCapsule("SimulationChildScriptWorkItemId", workItemIdSchema);

function scriptKey(key: ChildScriptKey): string {
  return key.kind === "action-id" ? `action:${key.actionId}` : `work:${key.workItemId}`;
}

function decodeActionId(input: unknown): ActionId | null {
  try {
    const encoded = actionIdCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = actionIdCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

function decodeWorkItemId(input: unknown): WorkItemId | null {
  try {
    const encoded = workItemIdCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = workItemIdCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

function decodeScript(input: unknown): ChildScript | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const keyInput = Reflect.get(input, "key");
    const eventInputs = Reflect.get(input, "events");
    if (typeof keyInput !== "object" || keyInput === null || Array.isArray(keyInput) || !Array.isArray(eventInputs)) {
      return null;
    }
    const keyKind = Reflect.get(keyInput, "kind");
    let key: ChildScriptKey;
    if (keyKind === "action-id") {
      const value = decodeActionId(Reflect.get(keyInput, "actionId"));
      if (value === null) {
        return null;
      }
      key = Object.freeze({ kind: "action-id", actionId: value });
    } else if (keyKind === "work-item-id") {
      const value = decodeWorkItemId(Reflect.get(keyInput, "workItemId"));
      if (value === null) {
        return null;
      }
      key = Object.freeze({ kind: "work-item-id", workItemId: value });
    } else {
      return null;
    }
    const events: ChildScriptEvent[] = [];
    let terminalCount = 0;
    let sealCount = 0;
    for (const eventInput of eventInputs) {
      if (typeof eventInput !== "object" || eventInput === null || Array.isArray(eventInput)) {
        return null;
      }
      const kind = Reflect.get(eventInput, "kind");
      const atTick = Reflect.get(eventInput, "atTick");
      if (typeof atTick !== "number" || !Number.isSafeInteger(atTick) || atTick < 0) {
        return null;
      }
      if (kind === "write") {
        const path = artifactPath(Reflect.get(eventInput, "path"));
        const bytes = cloneBytes(Reflect.get(eventInput, "bytes"));
        if (path === null || bytes === null) {
          return null;
        }
        events.push(Object.freeze({ kind, atTick, path, bytes }));
      } else if (kind === "seal") {
        sealCount += 1;
        events.push(Object.freeze({ kind, atTick }));
      } else if (kind === "exit") {
        const code = Reflect.get(eventInput, "code");
        if (typeof code !== "number" || !Number.isSafeInteger(code) || code < 0) {
          return null;
        }
        terminalCount += 1;
        events.push(Object.freeze({ kind, atTick, code }));
      } else if (kind === "hang" || kind === "kill") {
        terminalCount += 1;
        events.push(Object.freeze({ kind, atTick }));
      } else {
        return null;
      }
    }
    events.sort((left, right) => left.atTick - right.atTick);
    const terminalIndex = events.findIndex((event) => event.kind === "exit" || event.kind === "hang" || event.kind === "kill");
    if (
      terminalCount !== 1
      || sealCount > 1
      || terminalIndex !== events.length - 1
      || events.some((event, index) => event.kind === "write" && events.slice(0, index).some((prior) => prior.kind === "seal"))
    ) {
      return null;
    }
    return Object.freeze({ key, events: Object.freeze(events) });
  } catch {
    return null;
  }
}

/**
 * Models deterministic child writes, seal timing, exit, hangs, kill, fencing,
 * and late inspection. OS process groups, signal delivery races, model routes,
 * and sandbox escape are outside this fake and belong to D3 reality suites.
 */
export class SimChildPort {
  private readonly artifacts: ArtifactCatalog;
  private readonly fileSystem: SimFileSystem;
  private readonly workspaces: SimWorkspacePort;
  private readonly trace: PortTraceSink;
  private readonly scheduler: ChildScheduler;
  private readonly scripts = new Map<string, ChildScript>();
  private readonly children = new Map<ChildId, ChildRecord>();
  private readonly observations = new Map<string, ChildObservation>();

  public constructor(
    artifacts: ArtifactCatalog,
    fileSystem: SimFileSystem,
    workspaces: SimWorkspacePort,
    trace: PortTraceSink,
    scheduler: ChildScheduler,
    scripts?: readonly ChildScript[],
    image?: ChildImage,
  ) {
    this.artifacts = artifacts;
    this.fileSystem = fileSystem;
    this.workspaces = workspaces;
    this.trace = trace;
    this.scheduler = scheduler;
    if (scripts !== undefined) {
      for (const script of scripts) {
        this.scripts.set(scriptKey(script.key), script);
      }
    }
    if (image !== undefined) {
      for (const entry of image.children) {
        const script = this.scripts.get(entry.scriptKey);
        if (script === undefined) {
          continue;
        }
        const record: ChildRecord = {
          childId: entry.childId,
          childEpoch: entry.childEpoch,
          workspaceId: entry.workspaceId,
          script,
          launchedTick: entry.launchedTick,
          nextEvent: entry.nextEvent,
          state: entry.state,
          sealedRoot: entry.sealedRoot,
        };
        this.children.set(record.childId, record);
        if (record.state === "running") {
          this.schedulePending(record);
        }
      }
    }
  }

  public registerScript(input: unknown): RegisterChildScriptResult {
    const script = decodeScript(input);
    if (script === null) {
      return Object.freeze({
        kind: "invalid",
        diagnostic: "child script requires one terminal event, at most one seal, ordered non-negative ticks, and no writes after seal",
      });
    }
    const key = scriptKey(script.key);
    this.scripts.set(key, script);
    return Object.freeze({ kind: "registered", key, events: script.events.length });
  }

  public execute(input: unknown): SimPortExecution<ChildObservation> {
    const decoded = safeDecode(childIntentCapsule, input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    const cached = this.observations.get(decoded.value.actionId);
    if (cached !== undefined) {
      this.trace.recordContract("child", decoded.value.actionId, cached);
      return Object.freeze({ kind: "observation", observation: cached });
    }
    const observation = this.apply(decoded.value);
    if (observation.result.kind === "ok") {
      this.observations.set(decoded.value.actionId, observation);
    }
    this.trace.recordContract("child", decoded.value.actionId, observation);
    return Object.freeze({ kind: "observation", observation });
  }

  public isChildActive(childId: ChildId, epoch: ChildEpoch): boolean {
    const record = this.children.get(childId);
    return record !== undefined && record.childEpoch === epoch && record.state === "running";
  }

  public image(): ChildImage {
    const children = [...this.children.values()]
      .sort((left, right) => left.childId < right.childId ? -1 : left.childId > right.childId ? 1 : 0)
      .map((record) => Object.freeze({
        childId: record.childId,
        childEpoch: record.childEpoch,
        workspaceId: record.workspaceId,
        scriptKey: scriptKey(record.script.key),
        launchedTick: record.launchedTick,
        nextEvent: record.nextEvent,
        state: record.state,
        sealedRoot: this.durableSealedRoot(record),
      }));
    return Object.freeze({ children: Object.freeze(children) });
  }

  public scriptsSnapshot(): readonly ChildScript[] {
    return Object.freeze([...this.scripts.values()].sort((left, right) => {
      const leftKey = scriptKey(left.key);
      const rightKey = scriptKey(right.key);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }));
  }

  private apply(intent: ChildIntent): ChildObservation {
    switch (intent.kind) {
      case "launch-child-session": {
        const currentRoot = this.workspaces.captureRoot(intent.inputs.workspaceId);
        const script = this.scripts.get(`action:${intent.actionId}`)
          ?? this.scripts.get(`work:${intent.inputs.workItemId}`);
        if (
          currentRoot !== intent.preconditions.expectedWorkspaceRoot
          || String(intent.inputs.runtimeRoot) !== String(intent.preconditions.runtimeDigest)
          || script === undefined
        ) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "child-session-launched",
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("child.launch-precondition", "workspace, runtime digest, or child script precondition is not satisfied"),
            }),
            runId: intent.runId,
          });
        }
        const childId = childIdFor(Object.freeze({ actionId: intent.actionId, attemptId: intent.inputs.attemptId }));
        const prior = this.children.get(childId);
        if (prior !== undefined) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "child-session-launched",
            result: Object.freeze({
              kind: "ok",
              value: Object.freeze({ childEpoch: prior.childEpoch, childId, workspaceId: prior.workspaceId }),
            }),
            runId: intent.runId,
          });
        }
        const record: ChildRecord = {
          childId,
          childEpoch: intent.preconditions.childEpoch,
          workspaceId: intent.inputs.workspaceId,
          script,
          launchedTick: this.trace.currentTick(),
          nextEvent: 0,
          state: "running",
          sealedRoot: null,
        };
        this.children.set(childId, record);
        this.workspaces.setChild(record.workspaceId, record.childEpoch, true);
        this.schedulePending(record);
        return Object.freeze({
          actionId: intent.actionId,
          kind: "child-session-launched",
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({ childEpoch: record.childEpoch, childId, workspaceId: record.workspaceId }),
          }),
          runId: intent.runId,
        });
      }
      case "inspect-child-session": {
        const record = this.children.get(intent.inputs.childId);
        if (record !== undefined && record.childEpoch !== intent.preconditions.childEpoch) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "child-session-inspected",
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("child.stale-epoch", "child inspection epoch is stale"),
            }),
            runId: intent.runId,
          });
        }
        return Object.freeze({
          actionId: intent.actionId,
          kind: "child-session-inspected",
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({
              childEpoch: record?.childEpoch ?? intent.preconditions.childEpoch,
              childId: intent.inputs.childId,
              sealedRoot: record?.sealedRoot ?? null,
              state: record?.state ?? "absent",
            }),
          }),
          runId: intent.runId,
        });
      }
      case "fence-child-session": {
        const record = this.children.get(intent.inputs.childId);
        if (intent.preconditions.childEpoch === intent.preconditions.replacementEpoch) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "child-session-fenced",
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("child.replacement-epoch", "replacement epoch must differ from the fenced epoch"),
            }),
            runId: intent.runId,
          });
        }
        if (record !== undefined && record.childEpoch !== intent.preconditions.childEpoch) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "child-session-fenced",
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("child.stale-epoch", "stale epoch cannot fence the active child"),
            }),
            runId: intent.runId,
          });
        }
        if (record !== undefined) {
          record.state = "absent";
          this.scheduler.cancel(`child:${record.childId}:`);
          this.workspaces.markQuiescent(record.workspaceId);
        }
        return Object.freeze({
          actionId: intent.actionId,
          kind: "child-session-fenced",
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({
              childId: intent.inputs.childId,
              observedEpoch: record?.childEpoch ?? intent.preconditions.childEpoch,
              state: record === undefined ? "already-absent" : "fenced",
            }),
          }),
          runId: intent.runId,
        });
      }
    }
  }

  private schedulePending(record: ChildRecord): void {
    for (let index = record.nextEvent; index < record.script.events.length; index += 1) {
      const event = record.script.events[index];
      if (event !== undefined) {
        const due = Math.max(this.trace.currentTick(), record.launchedTick + event.atTick);
        this.scheduler.schedule(due, `child:${record.childId}:${String(index)}`, () => {
          this.runEvent(record.childId, index);
        });
      }
    }
  }

  private runEvent(childId: ChildId, index: number): void {
    const record = this.children.get(childId);
    const event = record?.script.events[index];
    if (record === undefined || event === undefined || record.state !== "running" || record.nextEvent !== index) {
      return;
    }
    if (event.kind === "write") {
      const written = this.workspaces.writeFile(record.workspaceId, event.path, event.bytes);
      if (written.kind !== "ok") {
        record.state = "quiescent";
        this.workspaces.markQuiescent(record.workspaceId);
        return;
      }
      this.trace.recordSemantic(
        "child",
        "workspace-write",
        `child:${childId}:event:${String(index)}`,
        Object.freeze({ bytes: event.bytes.length, digest: digestForBytes(event.bytes), path: event.path }),
      );
      record.nextEvent += 1;
      return;
    }
    if (event.kind === "seal") {
      const root = this.workspaces.captureRoot(record.workspaceId);
      if (root === null || !this.persistSeal(record, root)) {
        return;
      }
      record.sealedRoot = root;
      this.trace.recordSemantic("child", "root-sealed", `child:${childId}:seal`, Object.freeze({ root }));
      record.nextEvent += 1;
      return;
    }
    record.nextEvent += 1;
    if (event.kind === "exit") {
      record.state = "quiescent";
      this.workspaces.markQuiescent(record.workspaceId);
      this.trace.recordSemantic("child", "exited", `child:${childId}:terminal`, Object.freeze({ code: event.code }));
    } else if (event.kind === "kill") {
      record.state = "absent";
      this.workspaces.markQuiescent(record.workspaceId);
      this.trace.recordSemantic("child", "killed", `child:${childId}:terminal`, Object.freeze({ state: "killed" }));
    } else {
      this.trace.recordSemantic("child", "hung", `child:${childId}:terminal`, Object.freeze({ state: "running" }));
    }
  }

  private persistSeal(record: ChildRecord, root: ArtifactRoot): boolean {
    const bytes = this.artifacts.serialize(root);
    if (bytes === null) {
      return false;
    }
    const finalPath = `/sealed/${record.childId}/${root}`;
    if (this.fileSystem.exists(finalPath)) {
      return true;
    }
    const temporaryPath = `/sealed/temp/${record.childId}.${root}`;
    const append = this.fileSystem.appendFile(temporaryPath, bytes, "child.seal.append");
    if (append.kind !== "ok") {
      return false;
    }
    const fsync = this.fileSystem.fsyncFile(temporaryPath, "child.seal.file-fsync");
    if (fsync.kind !== "ok") {
      return false;
    }
    const rename = this.fileSystem.rename(temporaryPath, finalPath, "child.seal.rename");
    if (rename.kind !== "ok") {
      return false;
    }
    const dirsync = this.fileSystem.fsyncDirectory(`/sealed/${record.childId}`, "child.seal.directory-fsync");
    if (dirsync.kind !== "ok") {
      return false;
    }
    if (this.trace.reachCrashPoint("child.seal.ack", Object.freeze({ childId: record.childId, root }))) {
      return false;
    }
    return true;
  }

  private durableSealedRoot(record: ChildRecord): ArtifactRoot | null {
    if (record.sealedRoot !== null && this.fileSystem.exists(`/sealed/${record.childId}/${record.sealedRoot}`)) {
      return record.sealedRoot;
    }
    const prefix = `/sealed/${record.childId}/`;
    const candidate = this.fileSystem.listFiles(prefix).find((path) => path.startsWith(prefix));
    if (candidate === undefined) {
      return null;
    }
    const root = candidate.slice(prefix.length);
    const tree = this.artifacts.get(root);
    return tree?.root ?? null;
  }
}
