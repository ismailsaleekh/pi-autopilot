import {
  canonicalDigestUnknown,
  defineCapsule,
  jsonValue,
} from "../../authority/protocol/schema.js";
import type {
  DecodeResult,
  Digest,
  Infer,
  JsonValue,
  Schema,
  SchemaCapsule,
} from "../../authority/protocol/schema.js";

interface UnknownObject {
  readonly [field: string]: unknown;
}

interface MutableJsonObject {
  [field: string]: JsonValue;
}

const valueSchemaForNormalization = jsonValue();
const valueCapsuleForNormalization = defineCapsule(
  "IntentActionNormalization",
  valueSchemaForNormalization,
);

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedActionId(port: string, value: unknown): string | null {
  if (!isObject(value)) {
    return null;
  }
  const runId = value["runId"];
  const kind = value["kind"];
  const inputs = value["inputs"];
  const preconditions = value["preconditions"];
  if (typeof runId !== "string" || typeof kind !== "string" || !isObject(inputs) || !isObject(preconditions)) {
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
  return `action:sha256:${digest.slice(7)}`;
}

function invalidAction<Value>(diagnostic: string): DecodeResult<Value> {
  return Object.freeze({
    kind: "error",
    error: Object.freeze({
      code: "schema-mismatch",
      path: "$.actionId",
      diagnostic,
    }),
  });
}

function verifyAction<Value>(port: string, result: DecodeResult<Value>): DecodeResult<Value> {
  if (result.kind === "error") {
    return result;
  }
  const expected = expectedActionId(port, result.value);
  if (!isObject(result.value) || expected === null || result.value["actionId"] !== expected) {
    return invalidAction("actionId must equal the canonical digest of port, runId, kind, inputs, and preconditions");
  }
  return result;
}

function normalizeAction<Value>(
  port: string,
  value: Value,
  decode: (input: JsonValue) => DecodeResult<Value>,
): Value {
  const expected = expectedActionId(port, value);
  if (!isObject(value) || expected === null) {
    return value;
  }
  const encodedResult = valueCapsuleForNormalization.encodeUnknown(value);
  if (encodedResult.kind === "error") {
    return value;
  }
  const decodedValue = valueCapsuleForNormalization.decodeCanonical(encodedResult.value);
  if (decodedValue.kind === "error" || !isObject(decodedValue.value)) {
    return value;
  }
  const candidate: MutableJsonObject = Object.create(null);
  for (const key of Object.keys(decodedValue.value).sort()) {
    const fieldValue = decodedValue.value[key];
    if (fieldValue !== undefined) {
      candidate[key] = fieldValue;
    }
  }
  candidate["actionId"] = expected;
  const decoded = decode(Object.freeze(candidate));
  return decoded.kind === "ok" ? decoded.value : value;
}

export function defineIntentCapsule<
  const Name extends string,
  const ValueSchema extends Schema,
>(
  name: Name,
  port: string,
  valueSchema: ValueSchema,
): SchemaCapsule<Name, Infer<ValueSchema>> {
  const base = defineCapsule(name, valueSchema);
  const fingerprint: Digest = canonicalDigestUnknown(Object.freeze({
    actionIdDerivation: "pi-autopilot.action.v1",
    name,
    port,
    schema: valueSchema,
  }));
  return Object.freeze({
    name,
    schema: valueSchema,
    kinds: base.kinds,
    fingerprint,
    decode(input: JsonValue) {
      return verifyAction(port, base.decode(input));
    },
    decodeCanonical(input: Uint8Array) {
      return verifyAction(port, base.decodeCanonical(input));
    },
    encode(value: Infer<ValueSchema>) {
      return base.encode(value);
    },
    encodeUnknown(value: unknown) {
      const baseEncoded = base.encodeUnknown(value);
      if (baseEncoded.kind === "error") {
        return baseEncoded;
      }
      const verified = verifyAction(port, base.decodeCanonical(baseEncoded.value));
      if (verified.kind === "error") {
        return verified;
      }
      return base.encodeUnknown(verified.value);
    },
    digest(value: Infer<ValueSchema>) {
      return base.digest(value);
    },
    digestUnknown(value: unknown) {
      const baseEncoded = base.encodeUnknown(value);
      if (baseEncoded.kind === "error") {
        return baseEncoded;
      }
      const verified = verifyAction(port, base.decodeCanonical(baseEncoded.value));
      if (verified.kind === "error") {
        return verified;
      }
      return base.digestUnknown(verified.value);
    },
    arbitrary: Object.freeze({
      valid(seed: number) {
        return normalizeAction(port, base.arbitrary.valid(seed), base.decode);
      },
      validForKind(kind: string, seed: number) {
        return normalizeAction(port, base.arbitrary.validForKind(kind, seed), base.decode);
      },
      malformedValue(seed: number) {
        return base.arbitrary.malformedValue(seed);
      },
      malformedBytes(seed: number) {
        return base.arbitrary.malformedBytes(seed);
      },
      arbitraryBytes(seed: number, length: number) {
        return base.arbitrary.arbitraryBytes(seed, length);
      },
    }),
  });
}
