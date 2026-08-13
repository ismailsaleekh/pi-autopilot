import { actionIdSchema } from "../../authority/protocol/identifiers.js";
import type { ActionId } from "../../authority/protocol/identifiers.js";
import {
  canonicalDigestUnknown,
  defineCapsule,
  jsonValue,
} from "../../authority/protocol/schema.js";
import type { JsonValue } from "../../authority/protocol/schema.js";

export type LawPortName = "workspace" | "git" | "child" | "store" | "clock" | "secrets";

export interface LawTraceEntry {
  readonly port: LawPortName;
  readonly operation: string;
  readonly result: "ok" | "retry" | "rejected";
  readonly facts: readonly string[];
}

export interface LawVectorResult {
  readonly vectorId: string;
  readonly trace: readonly LawTraceEntry[];
  readonly findings: readonly string[];
}

export interface LawDriver {
  readonly fixture: (request: LawFixture) => Promise<LawFixtureResult>;
  readonly dispatch: (port: LawPortName, intent: JsonValue) => Promise<unknown>;
  readonly advance: (ticks: number) => Promise<void>;
  readonly readArtifact: (reference: JsonValue) => Promise<Uint8Array | null>;
  readonly containsSecretBytes: (bytes: Uint8Array) => Promise<boolean>;
}

export type LawFixture =
  | {
      readonly kind: "tree";
      readonly name: string;
      readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
    }
  | {
      readonly kind: "workspace";
      readonly name: string;
      readonly treeName: string;
    }
  | {
      readonly kind: "repository";
      readonly name: string;
      readonly runId: string;
      readonly treeName: string;
    }
  | {
      readonly kind: "root-list";
      readonly name: string;
      readonly treeNames: readonly string[];
    }
  | {
      readonly kind: "child-script";
      readonly name: string;
      readonly workItemId: string;
      readonly workspaceName: string;
      readonly writes: readonly { readonly tick: number; readonly path: string; readonly bytes: Uint8Array }[];
      readonly sealTick: number | null;
      readonly terminal: "exit" | "hang" | "kill";
      readonly terminalTick: number;
    }
  | { readonly kind: "secret"; readonly name: string; readonly handle: string; readonly bytes: Uint8Array };

export type LawFixtureResult =
  | {
      readonly kind: "tree";
      readonly name: string;
      readonly root: string;
      readonly manifest: JsonValue;
      readonly firstFile: JsonValue;
    }
  | {
      readonly kind: "workspace";
      readonly name: string;
      readonly workspaceId: string;
      readonly root: string;
      readonly leaseId: string;
    }
  | {
      readonly kind: "repository";
      readonly name: string;
      readonly runId: string;
      readonly identity: string;
      readonly head: string;
      readonly tree: string;
    }
  | { readonly kind: "root-list"; readonly name: string; readonly reference: JsonValue }
  | { readonly kind: "child-script"; readonly name: string }
  | { readonly kind: "secret"; readonly name: string; readonly handle: string }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export interface ContractVector {
  readonly id: string;
  readonly port: LawPortName;
  readonly behaviors: readonly string[];
  readonly replay: (driver: LawDriver) => Promise<LawVectorResult>;
}

const jsonCapsule = defineCapsule("LawIntentJson", jsonValue());
const actionCapsule = defineCapsule("LawActionId", actionIdSchema);

function isJsonObject(value: JsonValue): value is { readonly [field: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionId(port: LawPortName, value: JsonValue): ActionId | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const runId = value["runId"];
  const kind = value["kind"];
  const inputs = value["inputs"];
  const preconditions = value["preconditions"];
  if (
    typeof runId !== "string"
    || typeof kind !== "string"
    || typeof inputs !== "object"
    || inputs === null
    || Array.isArray(inputs)
    || typeof preconditions !== "object"
    || preconditions === null
    || Array.isArray(preconditions)
  ) {
    return null;
  }
  const digest = canonicalDigestUnknown(Object.freeze({
    domain: "pi-autopilot.action.v1",
    inputs,
    kind,
    port,
    preconditions,
    runId,
  }));
  const decoded = actionCapsule.decode(`action:sha256:${digest.slice(7)}`);
  return decoded.kind === "ok" ? decoded.value : null;
}

/** Adds the frozen canonical action ID to a law-vector intent candidate. */
export function bindLawIntent(port: LawPortName, input: unknown): JsonValue | null {
  try {
    const encoded = jsonCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = jsonCapsule.decodeCanonical(encoded.value);
    if (decoded.kind === "error" || !isJsonObject(decoded.value)) {
      return null;
    }
    const id = actionId(port, decoded.value);
    if (id === null) {
      return null;
    }
    const runId = decoded.value["runId"];
    const kind = decoded.value["kind"];
    const inputs = decoded.value["inputs"];
    const preconditions = decoded.value["preconditions"];
    if (runId === undefined || kind === undefined || inputs === undefined || preconditions === undefined) {
      return null;
    }
    return Object.freeze({ actionId: id, inputs, kind, preconditions, runId });
  } catch {
    return null;
  }
}

export function lawTrace(
  vectorId: string,
  trace: readonly LawTraceEntry[],
  findings: readonly string[],
): LawVectorResult {
  return Object.freeze({
    vectorId,
    trace: Object.freeze(trace.slice()),
    findings: Object.freeze(findings.slice()),
  });
}
