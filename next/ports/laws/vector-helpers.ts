import type {
  LawDriver,
  LawPortName,
  LawTraceEntry,
} from "./contract-vector.js";
import { defineCapsule, jsonValue } from "../../authority/protocol/schema.js";
import type { JsonValue } from "../../authority/protocol/schema.js";

const lawJsonCapsule = defineCapsule("LawVectorHelperJson", jsonValue());

export interface LawCallResult {
  readonly trace: LawTraceEntry;
  readonly observation: unknown;
  readonly value: unknown;
  readonly finding: string | null;
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

export async function lawCall(
  driver: LawDriver,
  port: LawPortName,
  operation: string,
  intent: JsonValue | null,
  expectedObservation: string,
  expectedResult: "ok" | "retry",
): Promise<LawCallResult> {
  if (intent === null) {
    return Object.freeze({
      trace: Object.freeze({ port, operation, result: "rejected", facts: Object.freeze([]) }),
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
      trace: Object.freeze({ port, operation, result: "rejected", facts: Object.freeze([]) }),
      observation: null,
      value: null,
      finding: `${operation}: driver threw`,
    });
  }
  const dispatchKind = field(dispatched, "kind");
  const observation = field(dispatched, "observation");
  const observationKind = field(observation, "kind");
  const result = field(observation, "result");
  const resultKind = field(result, "kind");
  const value = field(result, "value");
  const matches = dispatchKind === "observation"
    && observationKind === expectedObservation
    && resultKind === expectedResult;
  return Object.freeze({
    trace: Object.freeze({
      port,
      operation,
      result: resultKind === "ok" ? "ok" : resultKind === "retry" ? "retry" : "rejected",
      facts: Object.freeze([expectedObservation]),
    }),
    observation,
    value,
    finding: matches ? null : `${operation}: expected ${expectedObservation}/${expectedResult}`,
  });
}

export function collectFinding(output: string[], finding: string | null): void {
  if (finding !== null) {
    output.push(finding);
  }
}
