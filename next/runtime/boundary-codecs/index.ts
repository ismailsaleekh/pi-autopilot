import {
  artifactRefSchema,
  diagnosticSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ArtifactRef,
  Diagnostic,
} from "../../authority/protocol/identifiers.js";
import {
  commandSchema,
} from "../../authority/protocol/command.capsule.js";
import type { Command } from "../../authority/protocol/command.capsule.js";
import {
  evidenceEnvelopeSchema,
} from "../../authority/protocol/evidence-fact.capsule.js";
import {
  journalRecordCapsule,
} from "../../authority/protocol/journal-record.capsule.js";
import type {
  JournalRecord,
  RunGenesis,
} from "../../authority/protocol/journal-record.capsule.js";
import {
  arrayOf,
  defineCapsule,
  jsonValue,
} from "../../authority/protocol/schema.js";
import type {
  Infer,
  JsonValue,
  SchemaCapsule,
} from "../../authority/protocol/schema.js";
import {
  stimulusCapsule,
} from "../../authority/protocol/stimulus.capsule.js";
import type { Stimulus } from "../../authority/protocol/stimulus.capsule.js";
import {
  childObservationCapsule,
} from "../../ports/contracts/child.capsule.js";
import type { ChildObservation } from "../../ports/contracts/child.capsule.js";
import {
  clockObservationCapsule,
} from "../../ports/contracts/clock.capsule.js";
import type { ClockObservation } from "../../ports/contracts/clock.capsule.js";
import {
  gitObservationCapsule,
} from "../../ports/contracts/git.capsule.js";
import type { GitObservation } from "../../ports/contracts/git.capsule.js";
import {
  secretsObservationCapsule,
} from "../../ports/contracts/secrets.capsule.js";
import type { SecretsObservation } from "../../ports/contracts/secrets.capsule.js";
import {
  storeObservationCapsule,
} from "../../ports/contracts/store.capsule.js";
import type { StoreObservation } from "../../ports/contracts/store.capsule.js";
import {
  workspaceObservationCapsule,
} from "../../ports/contracts/workspace.capsule.js";
import type { WorkspaceObservation } from "../../ports/contracts/workspace.capsule.js";

export interface BoundaryLimits {
  readonly maxCanonicalBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxProperties: number;
}

export interface BoundaryFeedback {
  readonly kind: "feedback";
  readonly code:
    | "boundary-limit"
    | "boundary-schema"
    | "boundary-unsupported"
    | "boundary-hostile";
  readonly path: string;
  readonly diagnostic: string;
}

export type BoundaryResult<Value> =
  | {
      readonly kind: "ok";
      readonly value: Value;
      readonly canonicalBytes: Uint8Array;
    }
  | BoundaryFeedback;

export type RuntimePortName = "workspace" | "git" | "child" | "store" | "clock" | "secrets";

export type EvidenceEnvelopeWire = Infer<typeof evidenceEnvelopeSchema>;

export type RuntimePortObservation =
  | WorkspaceObservation
  | GitObservation
  | ChildObservation
  | StoreObservation
  | ClockObservation
  | SecretsObservation;

interface MutableJsonObject {
  [field: string]: JsonValue;
}

interface VisitTask {
  readonly kind: "visit";
  readonly source: unknown;
  readonly depth: number;
  readonly path: string;
  readonly assign: (value: JsonValue) => void;
}

interface LeaveTask {
  readonly kind: "leave";
  readonly source: object;
  readonly value: JsonValue[] | MutableJsonObject;
}

type ExtractionTask = VisitTask | LeaveTask;

const DEFAULT_LIMITS: BoundaryLimits = Object.freeze({
  maxCanonicalBytes: 1024 * 1024,
  maxDepth: 64,
  maxNodes: 65_536,
  maxProperties: 65_536,
});

const inertJsonCapsule = defineCapsule("RuntimeInertJson", jsonValue());
const commandBatchCapsule = defineCapsule("RuntimeCommandBatch", arrayOf(commandSchema));
const artifactRefCapsule = defineCapsule("RuntimeArtifactRef", artifactRefSchema);
const diagnosticCapsule = defineCapsule("RuntimeDiagnostic", diagnosticSchema);
const evidenceEnvelopeWireCapsule = defineCapsule("RuntimeEvidenceEnvelopeWire", evidenceEnvelopeSchema);

function feedback(
  code: BoundaryFeedback["code"],
  path: string,
  diagnostic: string,
): BoundaryFeedback {
  return Object.freeze({ kind: "feedback", code, path, diagnostic });
}

function positiveBound(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function readLimit(input: object, field: keyof BoundaryLimits): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(input, field);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function decodeLimits(input: unknown): BoundaryLimits {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return DEFAULT_LIMITS;
    }
    return Object.freeze({
      maxCanonicalBytes: positiveBound(
        readLimit(input, "maxCanonicalBytes"),
        DEFAULT_LIMITS.maxCanonicalBytes,
        64 * 1024 * 1024,
      ),
      maxDepth: positiveBound(readLimit(input, "maxDepth"), DEFAULT_LIMITS.maxDepth, 1024),
      maxNodes: positiveBound(readLimit(input, "maxNodes"), DEFAULT_LIMITS.maxNodes, 1_000_000),
      maxProperties: positiveBound(
        readLimit(input, "maxProperties"),
        DEFAULT_LIMITS.maxProperties,
        1_000_000,
      ),
    });
  } catch {
    return DEFAULT_LIMITS;
  }
}

function arrayIndex(key: string, length: number): number | null {
  if (key.length === 0 || (key.length > 1 && key.startsWith("0"))) {
    return null;
  }
  const value = Number(key);
  return Number.isSafeInteger(value) && value >= 0 && value < length && String(value) === key
    ? value
    : null;
}

function ownDataValue(source: object, key: string): { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "error"; readonly diagnostic: string } {
  const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) {
    return Object.freeze({ kind: "error", diagnostic: "property disappeared during boundary capture" });
  }
  if (!("value" in descriptor)) {
    return Object.freeze({ kind: "error", diagnostic: "accessor properties are not invoked at the boundary" });
  }
  if (!descriptor.enumerable && key !== "length") {
    return Object.freeze({ kind: "error", diagnostic: "non-enumerable data properties are not inert JSON" });
  }
  return Object.freeze({ kind: "ok", value: descriptor.value });
}

function budgetCharge(current: number, text: string): number {
  if (text.length > Math.floor((Number.MAX_SAFE_INTEGER - current - 16) / 6)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return current + 16 + text.length * 6;
}

function cloneCanonicalBytes(input: unknown, maximum: number): Uint8Array | BoundaryFeedback | null {
  try {
    if (!(input instanceof Uint8Array)) {
      return null;
    }
    if (input.byteLength > maximum) {
      return feedback(
        "boundary-limit",
        "$bytes",
        `canonical input exceeds the ${String(maximum)} byte boundary; submit an artifact reference`,
      );
    }
    return Uint8Array.prototype.slice.call(input);
  } catch {
    return feedback("boundary-hostile", "$bytes", "byte input could not be copied without hostile host behavior");
  }
}

/**
 * Captures arbitrary host values into a fresh, prototype-free JSON graph.
 * Accessors are never invoked. Proxy traps, revoked proxies, cycles, excessive
 * depth, and unsupported JavaScript values become bounded feedback.
 */
export function inertJsonFromUnknown(input: unknown, limitsInput?: unknown): BoundaryResult<JsonValue> {
  const limits = decodeLimits(limitsInput);
  try {
    let root: JsonValue | undefined;
    let nodes = 0;
    let properties = 0;
    let budget = 0;
    const active = new WeakSet<object>();
    const tasks: ExtractionTask[] = [Object.freeze({
      kind: "visit",
      source: input,
      depth: 0,
      path: "$",
      assign(value: JsonValue) {
        root = value;
      },
    })];

    while (tasks.length > 0) {
      const task = tasks.pop();
      if (task === undefined) {
        continue;
      }
      if (task.kind === "leave") {
        active.delete(task.source);
        Object.freeze(task.value);
        continue;
      }
      nodes += 1;
      budget += 16;
      if (nodes > limits.maxNodes) {
        return feedback("boundary-limit", task.path, "host value exceeds the bounded node count");
      }
      if (task.depth > limits.maxDepth) {
        return feedback("boundary-limit", task.path, "host value exceeds the bounded nesting depth");
      }
      const source = task.source;
      if (source === null || typeof source === "boolean") {
        task.assign(source);
        continue;
      }
      if (typeof source === "string") {
        budget = budgetCharge(budget, source);
        if (budget > limits.maxCanonicalBytes) {
          return feedback("boundary-limit", task.path, "text exceeds the bounded canonical artifact envelope");
        }
        task.assign(source);
        continue;
      }
      if (typeof source === "number") {
        if (!Number.isFinite(source) || Object.is(source, -0)) {
          return feedback("boundary-unsupported", task.path, "numbers must be finite and must not be negative zero");
        }
        task.assign(source);
        continue;
      }
      if (typeof source !== "object") {
        return feedback(
          "boundary-unsupported",
          task.path,
          `JavaScript ${typeof source} values are not inert JSON`,
        );
      }
      if (active.has(source)) {
        return feedback("boundary-unsupported", task.path, "circular references are not serializable boundary values");
      }

      const array = Array.isArray(source);
      if (!array) {
        const prototype = Reflect.getPrototypeOf(source);
        if (prototype !== null && prototype !== Object.prototype) {
          return feedback("boundary-unsupported", task.path, "only plain or null-prototype objects cross the boundary");
        }
      }
      const keys = Reflect.ownKeys(source);
      if (keys.some((key) => typeof key === "symbol")) {
        return feedback("boundary-unsupported", task.path, "symbol-named properties are not inert JSON");
      }
      const textKeys: string[] = [];
      for (const key of keys) {
        if (typeof key === "string") {
          textKeys.push(key);
        }
      }
      properties += textKeys.length;
      if (properties > limits.maxProperties) {
        return feedback("boundary-limit", task.path, "host value exceeds the bounded property count");
      }
      active.add(source);

      if (array) {
        const lengthValue = ownDataValue(source, "length");
        if (
          lengthValue.kind === "error"
          || typeof lengthValue.value !== "number"
          || !Number.isSafeInteger(lengthValue.value)
          || lengthValue.value < 0
          || lengthValue.value > limits.maxProperties
        ) {
          return feedback("boundary-hostile", `${task.path}.length`, "array length is unavailable or exceeds the boundary");
        }
        const length = lengthValue.value;
        const output: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          output.push(null);
        }
        const indexed = new Map<number, unknown>();
        for (const key of textKeys) {
          if (key === "length") {
            continue;
          }
          const index = arrayIndex(key, length);
          if (index === null || indexed.has(index)) {
            return feedback("boundary-unsupported", `${task.path}.${key}`, "arrays must contain only dense indexed data properties");
          }
          const property = ownDataValue(source, key);
          if (property.kind === "error") {
            return feedback("boundary-hostile", `${task.path}[${key}]`, property.diagnostic);
          }
          indexed.set(index, property.value);
        }
        if (indexed.size !== length) {
          return feedback("boundary-unsupported", task.path, "sparse arrays are not accepted at the boundary");
        }
        task.assign(output);
        tasks.push(Object.freeze({ kind: "leave", source, value: output }));
        for (let index = length - 1; index >= 0; index -= 1) {
          const child = indexed.get(index);
          tasks.push(Object.freeze({
            kind: "visit",
            source: child,
            depth: task.depth + 1,
            path: `${task.path}[${String(index)}]`,
            assign(value: JsonValue) {
              output[index] = value;
            },
          }));
        }
        continue;
      }

      const output: MutableJsonObject = Object.create(null);
      const sortedKeys = textKeys.slice().sort();
      const values = new Map<string, unknown>();
      for (const key of sortedKeys) {
        budget = budgetCharge(budget, key);
        if (budget > limits.maxCanonicalBytes) {
          return feedback("boundary-limit", `${task.path}.${key}`, "object keys exceed the canonical byte boundary");
        }
        const property = ownDataValue(source, key);
        if (property.kind === "error") {
          return feedback("boundary-hostile", `${task.path}.${key}`, property.diagnostic);
        }
        values.set(key, property.value);
      }
      task.assign(output);
      tasks.push(Object.freeze({ kind: "leave", source, value: output }));
      for (let index = sortedKeys.length - 1; index >= 0; index -= 1) {
        const key = sortedKeys[index];
        if (key !== undefined) {
          tasks.push(Object.freeze({
            kind: "visit",
            source: values.get(key),
            depth: task.depth + 1,
            path: `${task.path}.${key}`,
            assign(value: JsonValue) {
              output[key] = value;
            },
          }));
        }
      }
    }

    if (root === undefined) {
      return feedback("boundary-unsupported", "$", "undefined is not an inert JSON value");
    }
    const encoded = inertJsonCapsule.encodeUnknown(root);
    if (encoded.kind === "error") {
      return feedback("boundary-schema", encoded.error.path, encoded.error.diagnostic);
    }
    if (encoded.value.byteLength > limits.maxCanonicalBytes) {
      return feedback(
        "boundary-limit",
        "$bytes",
        `canonical value exceeds the ${String(limits.maxCanonicalBytes)} byte boundary; use CAS references`,
      );
    }
    const decoded = inertJsonCapsule.decodeCanonical(encoded.value);
    if (decoded.kind === "error") {
      return feedback("boundary-schema", decoded.error.path, decoded.error.diagnostic);
    }
    return Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: encoded.value.slice() });
  } catch {
    return feedback("boundary-hostile", "$", "host value could not be inspected without invoking hostile behavior");
  }
}

/** Runs one frozen W0 capsule only after hostile input has become inert JSON. */
export function decodeBoundaryValue<Name extends string, Value>(
  input: unknown,
  capsule: SchemaCapsule<Name, Value>,
  limitsInput?: unknown,
): BoundaryResult<Value> {
  const limits = decodeLimits(limitsInput);
  try {
    const canonicalInput = cloneCanonicalBytes(input, limits.maxCanonicalBytes);
    if (canonicalInput !== null) {
      if (!(canonicalInput instanceof Uint8Array)) {
        return canonicalInput;
      }
      const decodedBytes = capsule.decodeCanonical(canonicalInput);
      return decodedBytes.kind === "ok"
        ? Object.freeze({ kind: "ok", value: decodedBytes.value, canonicalBytes: canonicalInput.slice() })
        : feedback("boundary-schema", decodedBytes.error.path, decodedBytes.error.diagnostic);
    }
    const inert = inertJsonFromUnknown(input, limits);
    if (inert.kind !== "ok") {
      return inert;
    }
    const encoded = capsule.encodeUnknown(inert.value);
    if (encoded.kind === "error") {
      return feedback("boundary-schema", encoded.error.path, encoded.error.diagnostic);
    }
    if (encoded.value.byteLength > limits.maxCanonicalBytes) {
      return feedback("boundary-limit", "$bytes", "typed canonical value exceeds the boundary byte limit");
    }
    const decoded = capsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "ok", value: decoded.value, canonicalBytes: encoded.value.slice() })
      : feedback("boundary-schema", decoded.error.path, decoded.error.diagnostic);
  } catch {
    return feedback("boundary-hostile", "$", "typed boundary decoding was exception-contained");
  }
}

export function decodeStimulus(input: unknown, limitsInput?: unknown): BoundaryResult<Stimulus> {
  return decodeBoundaryValue(input, stimulusCapsule, limitsInput);
}

export function decodeCommand(input: unknown, limitsInput?: unknown): BoundaryResult<Command> {
  const singleCommandCapsule = defineCapsule("RuntimeCommand", commandSchema);
  return decodeBoundaryValue(input, singleCommandCapsule, limitsInput);
}

export function decodeCommandBatch(input: unknown, limitsInput?: unknown): BoundaryResult<readonly Command[]> {
  return decodeBoundaryValue(input, commandBatchCapsule, limitsInput);
}

export function decodeJournalRecord(input: unknown, limitsInput?: unknown): BoundaryResult<JournalRecord> {
  return decodeBoundaryValue(input, journalRecordCapsule, limitsInput);
}

export function decodeRunGenesis(input: unknown, limitsInput?: unknown): BoundaryResult<RunGenesis> {
  const decoded = decodeJournalRecord(input, limitsInput);
  if (decoded.kind !== "ok") {
    return decoded;
  }
  return decoded.value.kind === "run-genesis"
    ? Object.freeze({
        kind: "ok",
        value: decoded.value,
        canonicalBytes: decoded.canonicalBytes,
      })
    : feedback("boundary-schema", "$.kind", "commit-loop genesis must be a run-genesis record");
}

export function decodeArtifactReference(input: unknown, limitsInput?: unknown): BoundaryResult<ArtifactRef> {
  return decodeBoundaryValue(input, artifactRefCapsule, limitsInput);
}

export function decodeDiagnostic(input: unknown, limitsInput?: unknown): BoundaryResult<Diagnostic> {
  return decodeBoundaryValue(input, diagnosticCapsule, limitsInput);
}

export function decodeEvidenceEnvelopeWire(
  input: unknown,
  limitsInput?: unknown,
): BoundaryResult<EvidenceEnvelopeWire> {
  return decodeBoundaryValue(input, evidenceEnvelopeWireCapsule, limitsInput);
}

export function decodePortObservation(
  input: unknown,
  portInput: unknown,
  limitsInput?: unknown,
): BoundaryResult<RuntimePortObservation> {
  if (portInput === "workspace") {
    return decodeBoundaryValue(input, workspaceObservationCapsule, limitsInput);
  }
  if (portInput === "git") {
    return decodeBoundaryValue(input, gitObservationCapsule, limitsInput);
  }
  if (portInput === "child") {
    return decodeBoundaryValue(input, childObservationCapsule, limitsInput);
  }
  if (portInput === "store") {
    return decodeBoundaryValue(input, storeObservationCapsule, limitsInput);
  }
  if (portInput === "clock") {
    return decodeBoundaryValue(input, clockObservationCapsule, limitsInput);
  }
  if (portInput === "secrets") {
    return decodeBoundaryValue(input, secretsObservationCapsule, limitsInput);
  }
  return feedback(
    "boundary-schema",
    "$.port",
    "port must be workspace, git, child, store, clock, or secrets",
  );
}
