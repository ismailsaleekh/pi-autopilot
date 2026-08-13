import { digestBytes } from "../../authority/protocol/schema.js";
import type { JsonValue } from "../../authority/protocol/schema.js";
import { childObservationCapsule } from "../contracts/child.capsule.js";
import { clockObservationCapsule } from "../contracts/clock.capsule.js";
import { gitObservationCapsule } from "../contracts/git.capsule.js";
import { secretsObservationCapsule } from "../contracts/secrets.capsule.js";
import { storeObservationCapsule } from "../contracts/store.capsule.js";
import { workspaceObservationCapsule } from "../contracts/workspace.capsule.js";
import type {
  LawArtifactEvidence,
  LawDriver,
  LawPortName,
  LawTraceEntry,
} from "./contract-vector.js";
import { defineCapsule, jsonValue } from "../../authority/protocol/schema.js";

const lawJsonCapsule = defineCapsule("LawVectorHelperJson", jsonValue());

export interface LawCallResult {
  readonly trace: LawTraceEntry;
  readonly observation: JsonValue | null;
  readonly value: JsonValue | null;
  readonly finding: string | null;
}

export interface LawCallOptions {
  readonly project?: (observation: JsonValue) => JsonValue;
}

export function field(input: unknown, name: string): unknown {
  try {
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? Reflect.get(input, name)
      : undefined;
  } catch {
    return undefined;
  }
}

export function json(input: unknown): JsonValue | null {
  try {
    const encoded = lawJsonCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = lawJsonCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

function emptyTrace(port: LawPortName, operation: string): LawTraceEntry {
  return Object.freeze({
    actionId: null,
    artifactEvidence: Object.freeze([]),
    diagnosticCode: null,
    observationDigest: null,
    observationKind: null,
    operation,
    port,
    result: "rejected",
    semanticProjection: null,
  });
}

function decodeObservation(port: LawPortName, input: JsonValue) {
  switch (port) {
    case "workspace": return workspaceObservationCapsule.decode(input);
    case "git": return gitObservationCapsule.decode(input);
    case "child": return childObservationCapsule.decode(input);
    case "store": return storeObservationCapsule.decode(input);
    case "clock": return clockObservationCapsule.decode(input);
    case "secrets": return secretsObservationCapsule.decode(input);
  }
}

function isArtifactRef(value: JsonValue): value is JsonValue & {
  readonly blob: string;
  readonly byteLength: string;
  readonly codec: string;
  readonly codecVersion: string;
  readonly digest: string;
  readonly path: string;
  readonly range: JsonValue;
  readonly root: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { readonly [field: string]: JsonValue };
  return typeof candidate["blob"] === "string"
    && typeof candidate["byteLength"] === "string"
    && typeof candidate["codec"] === "string"
    && typeof candidate["codecVersion"] === "string"
    && typeof candidate["digest"] === "string"
    && typeof candidate["path"] === "string"
    && "range" in candidate
    && typeof candidate["root"] === "string";
}

function collectReferences(value: JsonValue, output: JsonValue[]): void {
  if (isArtifactRef(value)) {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      collectReferences(child, output);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      collectReferences(child, output);
    }
  }
}

async function artifactEvidence(driver: LawDriver, observation: JsonValue): Promise<readonly LawArtifactEvidence[]> {
  const references: JsonValue[] = [];
  collectReferences(observation, references);
  const output: LawArtifactEvidence[] = [];
  for (const reference of references) {
    if (!isArtifactRef(reference)) {
      continue;
    }
    const bytes = await driver.readArtifact(reference);
    const range = reference.range;
    const expectedLength = typeof range === "object" && range !== null && !Array.isArray(range)
      ? range["length"]
      : reference.byteLength;
    const lengthMatches = bytes !== null && typeof expectedLength === "string" && String(bytes.byteLength) === expectedLength;
    const digestMatches = bytes !== null && range === null && String(digestBytes(bytes)) === reference.digest;
    output.push(Object.freeze({
      reference,
      codec: reference.codec,
      codecVersion: reference.codecVersion,
      digest: reference.digest,
      byteLength: reference.byteLength,
      verified: lengthMatches && (range === null ? digestMatches : true),
    }));
  }
  return Object.freeze(output);
}

export async function lawCall(
  driver: LawDriver,
  port: LawPortName,
  operation: string,
  intent: JsonValue | null,
  expectedObservation: string,
  expectedResult: "ok" | "retry",
  options: LawCallOptions = Object.freeze({}),
): Promise<LawCallResult> {
  if (intent === null) {
    return Object.freeze({
      trace: emptyTrace(port, operation),
      observation: null,
      value: null,
      finding: `${operation}: law intent could not be bound`,
    });
  }
  let dispatched: unknown;
  try {
    dispatched = await driver.dispatch(port, intent);
  } catch {
    return Object.freeze({
      trace: emptyTrace(port, operation),
      observation: null,
      value: null,
      finding: `${operation}: driver threw`,
    });
  }
  const dispatchKind = field(dispatched, "kind");
  const rawObservation = dispatchKind === "observation" ? field(dispatched, "observation") : null;
  const observationJson = json(rawObservation);
  if (observationJson === null) {
    return Object.freeze({
      trace: emptyTrace(port, operation),
      observation: null,
      value: null,
      finding: `${operation}: driver did not return inert observation JSON`,
    });
  }
  const decoded = decodeObservation(port, observationJson);
  if (decoded.kind === "error") {
    return Object.freeze({
      trace: emptyTrace(port, operation),
      observation: observationJson,
      value: null,
      finding: `${operation}: ${decoded.error.diagnostic}`,
    });
  }
  const canonical = json(decoded.value);
  if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) {
    return Object.freeze({
      trace: emptyTrace(port, operation),
      observation: observationJson,
      value: null,
      finding: `${operation}: normalized observation is unavailable`,
    });
  }
  const intentAction = field(intent, "actionId");
  const intentRun = field(intent, "runId");
  const observationKind = field(canonical, "kind");
  const actionId = field(canonical, "actionId");
  const runId = field(canonical, "runId");
  const result = field(canonical, "result");
  const resultKind = field(result, "kind");
  const rawValue = field(result, "value");
  const value = json(rawValue);
  const diagnostic = field(result, "diagnostic");
  const diagnosticCode = field(diagnostic, "code");
  const matches = dispatchKind === "observation"
    && observationKind === expectedObservation
    && resultKind === expectedResult
    && actionId === intentAction
    && runId === intentRun;
  const projection = options.project === undefined ? canonical : options.project(canonical);
  const evidence = await artifactEvidence(driver, canonical);
  return Object.freeze({
    trace: Object.freeze({
      port,
      operation,
      actionId: typeof actionId === "string" ? actionId : null,
      observationKind: typeof observationKind === "string" ? observationKind : null,
      observationDigest: lawJsonCapsule.digest(canonical),
      result: resultKind === "ok" ? "ok" : resultKind === "retry" ? "retry" : "rejected",
      diagnosticCode: typeof diagnosticCode === "string" ? diagnosticCode : null,
      semanticProjection: projection,
      artifactEvidence: evidence,
    }),
    observation: canonical,
    value,
    finding: matches ? null : `${operation}: expected exact ${expectedObservation}/${expectedResult} action binding`,
  });
}

export function collectFinding(output: string[], finding: string | null): void {
  if (finding !== null) {
    output.push(finding);
  }
}
