import type { Diagnostic } from "../../authority/protocol/identifiers.js";
import type { JsonValue, SchemaCapsule } from "../../authority/protocol/schema.js";
import { diagnosticCode } from "./values.js";
import type { CrashPointId } from "../crash-matrix/registry.js";

export type SimPortExecution<Observation> =
  | { readonly kind: "observation"; readonly observation: Observation }
  | { readonly kind: "crashed"; readonly point: CrashPointId }
  | { readonly kind: "rejected"; readonly diagnostic: Diagnostic };

export interface PortTraceSink {
  readonly currentTick: () => number;
  readonly recordContract: (port: string, actionId: string, value: unknown) => void;
  readonly recordSemantic: (source: string, name: string, key: string, value: unknown) => void;
  readonly reachCrashPoint: (point: CrashPointId, detail: JsonValue) => boolean;
}

export type SafeDecodeResult<Value> =
  | { readonly kind: "ok"; readonly value: Value }
  | { readonly kind: "error"; readonly diagnostic: Diagnostic };

export function diagnostic(code: string, message: string): Diagnostic {
  return Object.freeze({
    code: diagnosticCode(code),
    message: message.length > 0 ? message : "simulation rejected the operation",
    related: Object.freeze([]),
  });
}

export function safeDecode<Value>(
  capsule: SchemaCapsule<string, Value>,
  input: unknown,
): SafeDecodeResult<Value> {
  try {
    const encoded = capsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return Object.freeze({
        kind: "error",
        diagnostic: diagnostic("sim.invalid-contract-value", `${encoded.error.path}: ${encoded.error.diagnostic}`),
      });
    }
    const decoded = capsule.decodeCanonical(encoded.value);
    if (decoded.kind === "error") {
      return Object.freeze({
        kind: "error",
        diagnostic: diagnostic("sim.invalid-contract-value", `${decoded.error.path}: ${decoded.error.diagnostic}`),
      });
    }
    return Object.freeze({ kind: "ok", value: decoded.value });
  } catch {
    return Object.freeze({
      kind: "error",
      diagnostic: diagnostic("sim.uninspectable-contract-value", "input could not be inspected without invoking hostile host behavior"),
    });
  }
}
