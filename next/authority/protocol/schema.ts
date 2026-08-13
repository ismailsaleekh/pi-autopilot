/*
 * Pure, zero-dependency schema algebra used by every W0 protocol capsule.
 * Descriptors are immutable data. Runtime interpretation is synchronous and
 * total for serialized JSON values and byte strings.
 */

declare const brandToken: unique symbol;

export type BrandedText<Name extends string> = string & {
  readonly [brandToken]: Name;
};

export type Digest = BrandedText<"Digest">;

export type TextFormat =
  | "plain"
  | "non-empty"
  | "identifier"
  | "action-id"
  | "digest"
  | "artifact-root"
  | "path"
  | "source-anchor"
  | "decimal-natural"
  | "git-oid"
  | "git-ref";

export interface TextSchema<BrandName extends string | null = string | null> {
  readonly tag: "text";
  readonly brand: BrandName;
  readonly format: TextFormat;
}

export interface NaturalSchema {
  readonly tag: "natural";
}

export interface BooleanSchema {
  readonly tag: "boolean";
}

export type LiteralValue = string | boolean | null;

export interface LiteralSchema<Value extends LiteralValue = LiteralValue> {
  readonly tag: "literal";
  readonly value: Value;
}

export interface FieldSchemas {
  readonly [field: string]: Schema;
}

export interface ObjectSchema<Fields extends FieldSchemas = FieldSchemas> {
  readonly tag: "object";
  readonly fields: Fields;
}

export interface UnionSchema<Options extends readonly Schema[] = readonly Schema[]> {
  readonly tag: "union";
  readonly options: Options;
}

export interface ArraySchema<Items extends Schema = Schema, Minimum extends 0 | 1 = 0 | 1> {
  readonly tag: "array";
  readonly items: Items;
  readonly minimum: Minimum;
}

export interface NullableSchema<Inner extends Schema = Schema> {
  readonly tag: "nullable";
  readonly inner: Inner;
}

export interface JsonSchema {
  readonly tag: "json";
}

export type Schema =
  | TextSchema
  | NaturalSchema
  | BooleanSchema
  | LiteralSchema
  | ObjectSchema
  | UnionSchema
  | ArraySchema
  | NullableSchema
  | JsonSchema;

export const CANONICAL_WIRE_VERSION = "pi-autopilot.canonical-json.v1";
export const MAX_SERIALIZED_DEPTH = 64;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [field: string]: JsonValue };

type NextInferenceDepth<Depth extends readonly unknown[]> = readonly [unknown, ...Depth];

export type Infer<
  ValueSchema,
  Depth extends readonly unknown[] = readonly [],
> = Depth["length"] extends 48
  ? unknown
  : ValueSchema extends TextSchema<infer BrandName>
    ? BrandName extends string
      ? BrandedText<BrandName>
      : string
    : ValueSchema extends NaturalSchema
      ? number
      : ValueSchema extends BooleanSchema
        ? boolean
        : ValueSchema extends LiteralSchema<infer Value>
          ? Value
          : ValueSchema extends ObjectSchema<infer Fields>
            ? {
                readonly [Field in keyof Fields]: Infer<
                  Fields[Field],
                  NextInferenceDepth<Depth>
                >;
              }
            : ValueSchema extends UnionSchema<infer Options>
              ? Infer<Options[number], NextInferenceDepth<Depth>>
              : ValueSchema extends ArraySchema<infer Items, infer Minimum>
                ? Minimum extends 1
                  ? readonly [
                      Infer<Items, NextInferenceDepth<Depth>>,
                      ...Infer<Items, NextInferenceDepth<Depth>>[],
                    ]
                  : readonly Infer<Items, NextInferenceDepth<Depth>>[]
                : ValueSchema extends NullableSchema<infer Inner>
                  ? Infer<Inner, NextInferenceDepth<Depth>> | null
                  : ValueSchema extends JsonSchema
                    ? JsonValue
                    : never;

export interface DecodeError {
  readonly code:
    | "invalid-utf8"
    | "invalid-json"
    | "schema-mismatch"
    | "unknown-field"
    | "missing-field"
    | "noncanonical";
  readonly path: string;
  readonly diagnostic: string;
}

export type DecodeResult<Value> =
  | { readonly kind: "ok"; readonly value: Value }
  | { readonly kind: "error"; readonly error: DecodeError };

export type Discriminant<Value> = Value extends { readonly kind: infer Kind extends string }
  ? Kind
  : never;

export interface CapsuleArbitraries<Value> {
  readonly valid: (seed: number) => Value;
  readonly validForKind: (kind: string, seed: number) => Value;
  readonly malformedValue: (seed: number) => unknown;
  readonly malformedBytes: (seed: number) => Uint8Array;
  readonly arbitraryBytes: (seed: number, length: number) => Uint8Array;
}

export interface SchemaCapsule<Name extends string, Value> {
  readonly name: Name;
  readonly schema: Schema;
  readonly kinds: readonly Discriminant<Value>[];
  readonly fingerprint: Digest;
  readonly decode: (input: JsonValue) => DecodeResult<Value>;
  readonly decodeCanonical: (input: Uint8Array) => DecodeResult<Value>;
  readonly encode: (value: Value) => Uint8Array;
  readonly encodeUnknown: (value: unknown) => DecodeResult<Uint8Array>;
  readonly digest: (value: Value) => Digest;
  readonly digestUnknown: (value: unknown) => DecodeResult<Digest>;
  readonly arbitrary: CapsuleArbitraries<Value>;
}

interface MutableSchemaFields {
  [field: string]: Schema;
}

interface UnknownObject {
  readonly [field: string]: unknown;
}

interface MutableUnknownObject {
  [field: string]: unknown;
}

interface ParseState {
  readonly text: string;
  index: number;
}

const SHA256_CONSTANTS: readonly number[] = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = "0123456789abcdef";

function freezeTextSchema<BrandName extends string | null>(
  brand: BrandName,
  format: TextFormat,
): TextSchema<BrandName> {
  return Object.freeze({ tag: "text", brand, format });
}

export function text(format?: TextFormat): TextSchema<null>;
export function text(format: TextFormat = "plain") {
  return freezeTextSchema(null, format);
}

export function brandedText<const BrandName extends string>(
  brand: BrandName,
  format?: TextFormat,
): TextSchema<BrandName>;
export function brandedText(brand: string, format: TextFormat = "identifier") {
  return freezeTextSchema(brand, format);
}

export function natural(): NaturalSchema {
  return Object.freeze({ tag: "natural" });
}

export function booleanValue(): BooleanSchema {
  return Object.freeze({ tag: "boolean" });
}

export function literal<const Value extends LiteralValue>(value: Value): LiteralSchema<Value>;
export function literal(value: LiteralValue) {
  return Object.freeze({ tag: "literal", value });
}

export function object<const Fields extends FieldSchemas>(fields: Fields): ObjectSchema<Fields>;
export function object(fields: FieldSchemas) {
  const sortedFields: MutableSchemaFields = {};
  const fieldNames = Object.keys(fields).sort();
  for (const fieldName of fieldNames) {
    const fieldSchema = fields[fieldName];
    if (fieldSchema !== undefined) {
      sortedFields[fieldName] = fieldSchema;
    }
  }
  return Object.freeze({
    tag: "object",
    fields: Object.freeze(sortedFields),
  });
}

export function union<const Options extends readonly Schema[]>(options: Options): UnionSchema<Options>;
export function union(options: readonly Schema[]) {
  return Object.freeze({
    tag: "union",
    options: Object.freeze(options.slice()),
  });
}

export function arrayOf<const Items extends Schema>(items: Items): ArraySchema<Items, 0>;
export function arrayOf(items: Schema) {
  return Object.freeze({ tag: "array", items, minimum: 0 });
}

export function nonEmptyArrayOf<const Items extends Schema>(items: Items): ArraySchema<Items, 1>;
export function nonEmptyArrayOf(items: Schema) {
  return Object.freeze({ tag: "array", items, minimum: 1 });
}

export function nullable<const Inner extends Schema>(inner: Inner): NullableSchema<Inner>;
export function nullable(inner: Schema) {
  return Object.freeze({ tag: "nullable", inner });
}

export function jsonValue(): JsonSchema {
  return Object.freeze({ tag: "json" });
}

function success<Value>(value: Value): DecodeResult<Value> {
  return Object.freeze({ kind: "ok", value });
}

function failure(
  code: DecodeError["code"],
  path: string,
  diagnostic: string,
): DecodeResult<never> {
  return Object.freeze({
    kind: "error",
    error: Object.freeze({ code, path, diagnostic }),
  });
}

function hasOwn(value: UnknownObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHexText(value: string, expectedLength: number): boolean {
  if (value.length !== expectedLength) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code >= 48 && code <= 57;
    const lowerHex = code >= 97 && code <= 102;
    if (!digit && !lowerHex) {
      return false;
    }
  }
  return true;
}

function isIdentifier(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const alphaUpper = code >= 65 && code <= 90;
    const alphaLower = code >= 97 && code <= 122;
    const digit = code >= 48 && code <= 57;
    const punctuation = code === 45 || code === 46 || code === 58 || code === 95;
    if (!alphaUpper && !alphaLower && !digit && !punctuation) {
      return false;
    }
  }
  return true;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isRelativePath(value: string): boolean {
  if (value.length === 0 || value.charCodeAt(0) === 47 || value.includes("\\") || value.includes("\u0000")) {
    return false;
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}

function textMatchesFormat(value: string, format: TextFormat): boolean {
  if (!isWellFormedUnicode(value)) {
    return false;
  }
  switch (format) {
    case "plain":
      return true;
    case "non-empty":
      return value.length > 0;
    case "identifier":
      return isIdentifier(value);
    case "action-id":
      return value.startsWith("action:sha256:") && isHexText(value.slice(14), 64);
    case "digest":
    case "artifact-root":
      return value.startsWith("sha256:") && isHexText(value.slice(7), 64);
    case "path":
      return isRelativePath(value);
    case "source-anchor":
      return value.startsWith("anchor:") && isIdentifier(value.slice(7));
    case "decimal-natural":
      if (value === "0") {
        return true;
      }
      if (value.length === 0 || value.charCodeAt(0) < 49 || value.charCodeAt(0) > 57) {
        return false;
      }
      for (let index = 1; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 48 || code > 57) {
          return false;
        }
      }
      return true;
    case "git-oid":
      return isHexText(value, 40) || isHexText(value, 64);
    case "git-ref":
      return value.startsWith("refs/")
        && isRelativePath(value)
        && !value.includes("..")
        && !value.endsWith(".")
        && !value.endsWith("/");
  }
}

function joinPath(parent: string, field: string): string {
  if (parent === "$") {
    return `$.${field}`;
  }
  return `${parent}.${field}`;
}

function decodeJsonValue(input: unknown, path: string, depth: number): DecodeResult<JsonValue> {
  if (depth > MAX_SERIALIZED_DEPTH) {
    return failure("schema-mismatch", path, "JSON nesting exceeds the serialized boundary depth");
  }
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    if (typeof input === "string" && !isWellFormedUnicode(input)) {
      return failure("schema-mismatch", path, "text must contain well-formed Unicode");
    }
    return success(input);
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      return failure("schema-mismatch", path, "number must be finite and must not be negative zero");
    }
    return success(input);
  }
  if (Array.isArray(input)) {
    const output: JsonValue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const decoded = decodeJsonValue(input[index], `${path}[${String(index)}]`, depth + 1);
      if (decoded.kind === "error") {
        return decoded;
      }
      output.push(decoded.value);
    }
    return success(Object.freeze(output));
  }
  if (isPlainObject(input)) {
    const output: { [field: string]: JsonValue } = Object.create(null);
    const keys = Object.keys(input).sort();
    for (const key of keys) {
      if (!isWellFormedUnicode(key)) {
        return failure("schema-mismatch", joinPath(path, key), "object key must contain well-formed Unicode");
      }
      const decoded = decodeJsonValue(input[key], joinPath(path, key), depth + 1);
      if (decoded.kind === "error") {
        return decoded;
      }
      output[key] = decoded.value;
    }
    return success(Object.freeze(output));
  }
  return failure("schema-mismatch", path, "value is not serializable JSON");
}

function decodeWithSchema(
  valueSchema: Schema,
  input: unknown,
  path: string,
  depth: number,
): DecodeResult<unknown> {
  switch (valueSchema.tag) {
    case "text":
      if (typeof input !== "string" || !textMatchesFormat(input, valueSchema.format)) {
        return failure("schema-mismatch", path, `expected ${valueSchema.format} text`);
      }
      return success(input);
    case "natural":
      if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
        return failure("schema-mismatch", path, "expected a non-negative safe integer");
      }
      return success(input);
    case "boolean":
      if (typeof input !== "boolean") {
        return failure("schema-mismatch", path, "expected a boolean");
      }
      return success(input);
    case "literal":
      if (input !== valueSchema.value) {
        return failure("schema-mismatch", path, `expected literal ${canonicalText(valueSchema.value)}`);
      }
      return success(input);
    case "object": {
      if (!isPlainObject(input)) {
        return failure("schema-mismatch", path, "expected an object");
      }
      const actualKeys = Object.keys(input);
      const expectedKeys = Object.keys(valueSchema.fields);
      for (const actualKey of actualKeys) {
        if (!hasOwn(valueSchema.fields, actualKey)) {
          return failure("unknown-field", joinPath(path, actualKey), "unknown fields are forbidden");
        }
      }
      const output: MutableUnknownObject = Object.create(null);
      for (const expectedKey of expectedKeys) {
        if (!hasOwn(input, expectedKey)) {
          return failure("missing-field", joinPath(path, expectedKey), "required field is missing");
        }
        const childSchema = valueSchema.fields[expectedKey];
        if (childSchema === undefined) {
          return failure("schema-mismatch", joinPath(path, expectedKey), "schema field is unavailable");
        }
        const child = decodeWithSchema(childSchema, input[expectedKey], joinPath(path, expectedKey), depth + 1);
        if (child.kind === "error") {
          return child;
        }
        output[expectedKey] = child.value;
      }
      return success(Object.freeze(output));
    }
    case "union": {
      let selectedOptions = valueSchema.options;
      if (isPlainObject(input) && typeof input["kind"] === "string") {
        const matchingOptions = valueSchema.options.filter(
          (option) => variantKind(option) === input["kind"],
        );
        if (matchingOptions.length === 1) {
          selectedOptions = matchingOptions;
        }
      }
      for (const option of selectedOptions) {
        const decoded = decodeWithSchema(option, input, path, depth + 1);
        if (decoded.kind === "ok") {
          return decoded;
        }
      }
      return failure("schema-mismatch", path, "value does not match a closed union variant");
    }
    case "array": {
      if (!Array.isArray(input) || input.length < valueSchema.minimum) {
        const qualifier = valueSchema.minimum === 1 ? "non-empty " : "";
        return failure("schema-mismatch", path, `expected a ${qualifier}array`);
      }
      const output: unknown[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const child = decodeWithSchema(
          valueSchema.items,
          input[index],
          `${path}[${String(index)}]`,
          depth + 1,
        );
        if (child.kind === "error") {
          return child;
        }
        output.push(child.value);
      }
      return success(Object.freeze(output));
    }
    case "nullable":
      if (input === null) {
        return success(null);
      }
      return decodeWithSchema(valueSchema.inner, input, path, depth + 1);
    case "json":
      return decodeJsonValue(input, path, depth + 1);
  }
}

function escapedString(value: string): string {
  let output = "\"";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34) {
      output += "\\\"";
    } else if (code === 92) {
      output += "\\\\";
    } else if (code <= 0x1f) {
      output += `\\u${HEX[(code >>> 12) & 15]}${HEX[(code >>> 8) & 15]}${HEX[(code >>> 4) & 15]}${HEX[code & 15]}`;
    } else {
      output += value[index];
    }
  }
  return `${output}\"`;
}

function canonicalText(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return escapedString(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      items.push(canonicalText(item));
    }
    return `[${items.join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries: string[] = [];
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      entries.push(`${escapedString(key)}:${canonicalText(value[key])}`);
    }
    return `{${entries.join(",")}}`;
  }
  return "null";
}

function encodeUtf8(value: string): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (following - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint <= 0x7f) {
      output.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      output.push(0xc0 | (codePoint >>> 6));
      output.push(0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      output.push(0xe0 | (codePoint >>> 12));
      output.push(0x80 | ((codePoint >>> 6) & 0x3f));
      output.push(0x80 | (codePoint & 0x3f));
    } else {
      output.push(0xf0 | (codePoint >>> 18));
      output.push(0x80 | ((codePoint >>> 12) & 0x3f));
      output.push(0x80 | ((codePoint >>> 6) & 0x3f));
      output.push(0x80 | (codePoint & 0x3f));
    }
  }
  return Uint8Array.from(output);
}

function utf8Failure(index: number, diagnostic: string): DecodeResult<string> {
  return failure("invalid-utf8", `$bytes[${String(index)}]`, diagnostic);
}

function decodeUtf8(bytes: Uint8Array): DecodeResult<string> {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index];
    if (first === undefined) {
      return utf8Failure(index, "byte is unavailable");
    }
    if (first <= 0x7f) {
      chunks.push(String.fromCharCode(first));
      continue;
    }
    let needed = 0;
    let codePoint = 0;
    let minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      codePoint = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      codePoint = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      codePoint = first & 0x07;
      minimum = 0x10000;
    } else {
      return utf8Failure(index, "invalid leading byte");
    }
    if (index + needed >= bytes.length) {
      return utf8Failure(index, "truncated UTF-8 sequence");
    }
    for (let offset = 1; offset <= needed; offset += 1) {
      const continuation = bytes[index + offset];
      if (continuation === undefined || (continuation & 0xc0) !== 0x80) {
        return utf8Failure(index + offset, "invalid continuation byte");
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (
      codePoint < minimum
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return utf8Failure(index, "non-scalar or overlong UTF-8 sequence");
    }
    if (codePoint <= 0xffff) {
      chunks.push(String.fromCharCode(codePoint));
    } else {
      const adjusted = codePoint - 0x10000;
      chunks.push(String.fromCharCode(0xd800 + (adjusted >>> 10)));
      chunks.push(String.fromCharCode(0xdc00 + (adjusted & 0x3ff)));
    }
    index += needed;
  }
  return success(chunks.join(""));
}

function skipWhitespace(state: ParseState): void {
  while (state.index < state.text.length) {
    const code = state.text.charCodeAt(state.index);
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) {
      return;
    }
    state.index += 1;
  }
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 97 && code <= 102) {
    return code - 87;
  }
  if (code >= 65 && code <= 70) {
    return code - 55;
  }
  return -1;
}

function parseString(state: ParseState): DecodeResult<string> {
  if (state.text.charCodeAt(state.index) !== 34) {
    return failure("invalid-json", `$text[${String(state.index)}]`, "expected a quoted string");
  }
  state.index += 1;
  const chunks: string[] = [];
  while (state.index < state.text.length) {
    const code = state.text.charCodeAt(state.index);
    state.index += 1;
    if (code === 34) {
      return success(chunks.join(""));
    }
    if (code === 92) {
      if (state.index >= state.text.length) {
        return failure("invalid-json", "$", "truncated escape sequence");
      }
      const escape = state.text.charCodeAt(state.index);
      state.index += 1;
      if (escape === 34 || escape === 47 || escape === 92) {
        chunks.push(String.fromCharCode(escape));
      } else if (escape === 98) {
        chunks.push(String.fromCharCode(8));
      } else if (escape === 102) {
        chunks.push(String.fromCharCode(12));
      } else if (escape === 110) {
        chunks.push(String.fromCharCode(10));
      } else if (escape === 114) {
        chunks.push(String.fromCharCode(13));
      } else if (escape === 116) {
        chunks.push(String.fromCharCode(9));
      } else if (escape === 117) {
        if (state.index + 4 > state.text.length) {
          return failure("invalid-json", "$", "truncated Unicode escape");
        }
        let escapedCode = 0;
        for (let offset = 0; offset < 4; offset += 1) {
          const digit = hexDigit(state.text.charCodeAt(state.index + offset));
          if (digit < 0) {
            return failure("invalid-json", "$", "invalid Unicode escape");
          }
          escapedCode = (escapedCode << 4) | digit;
        }
        chunks.push(String.fromCharCode(escapedCode));
        state.index += 4;
      } else {
        return failure("invalid-json", "$", "unknown escape sequence");
      }
    } else if (code <= 0x1f) {
      return failure("invalid-json", "$", "unescaped control character");
    } else {
      chunks.push(String.fromCharCode(code));
    }
  }
  return failure("invalid-json", "$", "unterminated string");
}

function parseNumber(state: ParseState): DecodeResult<number> {
  const start = state.index;
  if (state.text.charCodeAt(state.index) === 45) {
    state.index += 1;
  }
  if (state.text.charCodeAt(state.index) === 48) {
    state.index += 1;
  } else {
    const firstDigit = state.text.charCodeAt(state.index);
    if (firstDigit < 49 || firstDigit > 57) {
      return failure("invalid-json", `$text[${String(start)}]`, "invalid number");
    }
    while (state.index < state.text.length) {
      const digit = state.text.charCodeAt(state.index);
      if (digit < 48 || digit > 57) {
        break;
      }
      state.index += 1;
    }
  }
  if (state.text.charCodeAt(state.index) === 46) {
    state.index += 1;
    const fractionStart = state.index;
    while (state.index < state.text.length) {
      const digit = state.text.charCodeAt(state.index);
      if (digit < 48 || digit > 57) {
        break;
      }
      state.index += 1;
    }
    if (state.index === fractionStart) {
      return failure("invalid-json", "$", "fraction requires digits");
    }
  }
  const exponent = state.text.charCodeAt(state.index);
  if (exponent === 69 || exponent === 101) {
    state.index += 1;
    const sign = state.text.charCodeAt(state.index);
    if (sign === 43 || sign === 45) {
      state.index += 1;
    }
    const exponentStart = state.index;
    while (state.index < state.text.length) {
      const digit = state.text.charCodeAt(state.index);
      if (digit < 48 || digit > 57) {
        break;
      }
      state.index += 1;
    }
    if (state.index === exponentStart) {
      return failure("invalid-json", "$", "exponent requires digits");
    }
  }
  const parsed = Number(state.text.slice(start, state.index));
  if (!Number.isFinite(parsed)) {
    return failure("invalid-json", "$", "number must be finite");
  }
  return success(parsed);
}

function parseValue(state: ParseState, depth: number): DecodeResult<unknown> {
  if (depth > MAX_SERIALIZED_DEPTH) {
    return failure("invalid-json", "$", "JSON nesting exceeds the serialized boundary depth");
  }
  skipWhitespace(state);
  const code = state.text.charCodeAt(state.index);
  if (code === 34) {
    return parseString(state);
  }
  if (code === 123) {
    state.index += 1;
    skipWhitespace(state);
    const output: MutableUnknownObject = Object.create(null);
    if (state.text.charCodeAt(state.index) === 125) {
      state.index += 1;
      return success(Object.freeze(output));
    }
    while (state.index < state.text.length) {
      const key = parseString(state);
      if (key.kind === "error") {
        return key;
      }
      if (hasOwn(output, key.value)) {
        return failure("invalid-json", joinPath("$", key.value), "duplicate object key");
      }
      skipWhitespace(state);
      if (state.text.charCodeAt(state.index) !== 58) {
        return failure("invalid-json", "$", "expected ':' after object key");
      }
      state.index += 1;
      const value = parseValue(state, depth + 1);
      if (value.kind === "error") {
        return value;
      }
      output[key.value] = value.value;
      skipWhitespace(state);
      const separator = state.text.charCodeAt(state.index);
      if (separator === 125) {
        state.index += 1;
        return success(Object.freeze(output));
      }
      if (separator !== 44) {
        return failure("invalid-json", "$", "expected ',' or '}' in object");
      }
      state.index += 1;
      skipWhitespace(state);
    }
    return failure("invalid-json", "$", "unterminated object");
  }
  if (code === 91) {
    state.index += 1;
    skipWhitespace(state);
    const output: unknown[] = [];
    if (state.text.charCodeAt(state.index) === 93) {
      state.index += 1;
      return success(Object.freeze(output));
    }
    while (state.index < state.text.length) {
      const value = parseValue(state, depth + 1);
      if (value.kind === "error") {
        return value;
      }
      output.push(value.value);
      skipWhitespace(state);
      const separator = state.text.charCodeAt(state.index);
      if (separator === 93) {
        state.index += 1;
        return success(Object.freeze(output));
      }
      if (separator !== 44) {
        return failure("invalid-json", "$", "expected ',' or ']' in array");
      }
      state.index += 1;
    }
    return failure("invalid-json", "$", "unterminated array");
  }
  if (state.text.startsWith("true", state.index)) {
    state.index += 4;
    return success(true);
  }
  if (state.text.startsWith("false", state.index)) {
    state.index += 5;
    return success(false);
  }
  if (state.text.startsWith("null", state.index)) {
    state.index += 4;
    return success(null);
  }
  if (code === 45 || (code >= 48 && code <= 57)) {
    return parseNumber(state);
  }
  return failure("invalid-json", `$text[${String(state.index)}]`, "unexpected JSON token");
}

function parseJsonBytes(bytes: Uint8Array): DecodeResult<unknown> {
  const decodedText = decodeUtf8(bytes);
  if (decodedText.kind === "error") {
    return decodedText;
  }
  const state: ParseState = { text: decodedText.value, index: 0 };
  const parsed = parseValue(state, 0);
  if (parsed.kind === "error") {
    return parsed;
  }
  skipWhitespace(state);
  if (state.index !== state.text.length) {
    return failure("invalid-json", `$text[${String(state.index)}]`, "trailing JSON content");
  }
  return parsed;
}

export function canonicalEncodeUnknown(value: unknown): Uint8Array {
  return encodeUtf8(canonicalText(value));
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function sha256Bytes(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  padded[paddedLength - 8] = (highBits >>> 24) & 0xff;
  padded[paddedLength - 7] = (highBits >>> 16) & 0xff;
  padded[paddedLength - 6] = (highBits >>> 8) & 0xff;
  padded[paddedLength - 5] = highBits & 0xff;
  padded[paddedLength - 4] = (lowBits >>> 24) & 0xff;
  padded[paddedLength - 3] = (lowBits >>> 16) & 0xff;
  padded[paddedLength - 2] = (lowBits >>> 8) & 0xff;
  padded[paddedLength - 1] = lowBits & 0xff;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      const b0 = padded[base] ?? 0;
      const b1 = padded[base + 1] ?? 0;
      const b2 = padded[base + 2] ?? 0;
      const b3 = padded[base + 3] ?? 0;
      words[index] = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const prior15 = words[index - 15] ?? 0;
      const prior2 = words[index - 2] ?? 0;
      const s0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
      const s1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const state = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let index = 0; index < state.length; index += 1) {
    const value = state[index] ?? 0;
    const base = index * 4;
    output[base] = (value >>> 24) & 0xff;
    output[base + 1] = (value >>> 16) & 0xff;
    output[base + 2] = (value >>> 8) & 0xff;
    output[base + 3] = value & 0xff;
  }
  return output;
}

export function digestBytes(input: Uint8Array): Digest;
export function digestBytes(input: Uint8Array) {
  const hash = sha256Bytes(input);
  let hex = "";
  for (const byte of hash) {
    hex += `${HEX[(byte >>> 4) & 15]}${HEX[byte & 15]}`;
  }
  return `sha256:${hex}`;
}

export function canonicalDigestUnknown(value: unknown): Digest {
  return digestBytes(canonicalEncodeUnknown(value));
}

function normalizedSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    return 0;
  }
  return Math.abs(Math.trunc(seed)) >>> 0;
}

function seedHex(seed: number): string {
  let output = "";
  let value = normalizedSeed(seed) ^ 0x9e3779b9;
  for (let index = 0; index < 64; index += 1) {
    value = (Math.imul(value ^ (value >>> 16), 0x45d9f3b) + index + 1) >>> 0;
    output += HEX[value & 15];
  }
  return output;
}

function safeBrandLabel(brand: string | null): string {
  if (brand === null || brand.length === 0) {
    return "value";
  }
  let output = "";
  for (let index = 0; index < brand.length; index += 1) {
    const code = brand.charCodeAt(index);
    const lower = code >= 65 && code <= 90 ? code + 32 : code;
    const permitted = (lower >= 97 && lower <= 122) || (lower >= 48 && lower <= 57);
    output += permitted ? String.fromCharCode(lower) : "-";
  }
  return output;
}

function generatedText(valueSchema: TextSchema, seed: number): string {
  const normalized = normalizedSeed(seed);
  switch (valueSchema.format) {
    case "plain":
      return `text-${String(normalized)}`;
    case "non-empty":
      return `value-${String(normalized)}`;
    case "identifier":
      return `${safeBrandLabel(valueSchema.brand)}:${String(normalized)}`;
    case "action-id":
      return `action:sha256:${seedHex(normalized)}`;
    case "digest":
    case "artifact-root":
      return `sha256:${seedHex(normalized)}`;
    case "path":
      return `artifact/${safeBrandLabel(valueSchema.brand)}-${String(normalized)}`;
    case "source-anchor":
      return `anchor:${safeBrandLabel(valueSchema.brand)}:${String(normalized)}`;
    case "decimal-natural":
      return String(normalized);
    case "git-oid":
      return seedHex(normalized).slice(0, normalized % 2 === 0 ? 40 : 64);
    case "git-ref":
      return `refs/pi-autopilot/${safeBrandLabel(valueSchema.brand)}-${String(normalized)}`;
  }
}

function generateValid(valueSchema: Schema, seed: number, depth: number): unknown {
  const normalized = normalizedSeed(seed + depth * 131);
  switch (valueSchema.tag) {
    case "text":
      return generatedText(valueSchema, normalized);
    case "natural":
      return normalized % 1000000;
    case "boolean":
      return normalized % 2 === 0;
    case "literal":
      return valueSchema.value;
    case "object": {
      const output: MutableUnknownObject = Object.create(null);
      const fields = Object.keys(valueSchema.fields);
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (field !== undefined) {
          const childSchema = valueSchema.fields[field];
          if (childSchema !== undefined) {
            output[field] = generateValid(childSchema, normalized + index * 977 + 1, depth + 1);
          }
        }
      }
      return Object.freeze(output);
    }
    case "union": {
      if (valueSchema.options.length === 0) {
        return null;
      }
      const selected = valueSchema.options[normalized % valueSchema.options.length];
      return selected === undefined ? null : generateValid(selected, normalized, depth + 1);
    }
    case "array": {
      const length = valueSchema.minimum === 1 ? 1 + (normalized % 2) : normalized % 3;
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        output.push(generateValid(valueSchema.items, normalized + index * 313 + 1, depth + 1));
      }
      return Object.freeze(output);
    }
    case "nullable":
      return normalized % 3 === 0 ? null : generateValid(valueSchema.inner, normalized + 1, depth + 1);
    case "json": {
      const output: { [field: string]: JsonValue } = Object.create(null);
      output["sample"] = `json-${String(normalized)}`;
      output["seed"] = normalized;
      return Object.freeze(output);
    }
  }
}

function variantKind(option: Schema): string | null {
  if (option.tag !== "object") {
    return null;
  }
  const kindSchema = option.fields["kind"];
  if (kindSchema === undefined || kindSchema.tag !== "literal" || typeof kindSchema.value !== "string") {
    return null;
  }
  return kindSchema.value;
}

function schemaKinds(valueSchema: Schema): readonly string[] {
  const output: string[] = [];
  const options = valueSchema.tag === "union" ? valueSchema.options : [valueSchema];
  for (const option of options) {
    const kind = variantKind(option);
    if (kind !== null) {
      output.push(kind);
    }
  }
  return Object.freeze(output.sort());
}

function generateForKind(valueSchema: Schema, kind: string, seed: number): unknown {
  const options = valueSchema.tag === "union" ? valueSchema.options : [valueSchema];
  for (const option of options) {
    if (variantKind(option) === kind) {
      return generateValid(option, seed, 0);
    }
  }
  return generateValid(valueSchema, seed, 0);
}

function malformedValue(valueSchema: Schema, seed: number): unknown {
  const valid = generateValid(valueSchema, seed, 0);
  if (isPlainObject(valid)) {
    const output: MutableUnknownObject = Object.create(null);
    for (const key of Object.keys(valid)) {
      output[key] = valid[key];
    }
    output["unexpectedField"] = true;
    return Object.freeze(output);
  }
  return Object.freeze({ unexpectedField: valid });
}

export function fuzzBytes(seed: number, length: number): Uint8Array {
  const safeLength = Number.isSafeInteger(length) && length > 0 ? length : 0;
  const output = new Uint8Array(safeLength);
  let state = normalizedSeed(seed) ^ 0xa5a5a5a5;
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + index + 1) >>> 0;
    output[index] = state & 0xff;
  }
  return output;
}

function malformedCanonicalBytes(valueSchema: Schema, seed: number): Uint8Array {
  const canonical = canonicalEncodeUnknown(generateValid(valueSchema, seed, 0));
  const mode = normalizedSeed(seed) % 4;
  if (mode === 0) {
    const output = new Uint8Array(canonical.length + 1);
    output[0] = 32;
    output.set(canonical, 1);
    return output;
  }
  if (mode === 1) {
    const output = new Uint8Array(canonical.length + 1);
    output.set(canonical);
    output[output.length - 1] = 10;
    return output;
  }
  if (mode === 2) {
    return Uint8Array.from([0xc0, 0xaf]);
  }
  const output = canonical.slice();
  if (output.length === 0) {
    return Uint8Array.from([0xff]);
  }
  output[Math.floor(output.length / 2)] = 0xff;
  return output;
}

function decodeCanonicalWithSchema(valueSchema: Schema, bytes: Uint8Array): DecodeResult<unknown> {
  const parsed = parseJsonBytes(bytes);
  if (parsed.kind === "error") {
    return parsed;
  }
  const decoded = decodeWithSchema(valueSchema, parsed.value, "$", 0);
  if (decoded.kind === "error") {
    return decoded;
  }
  const canonical = canonicalEncodeUnknown(decoded.value);
  if (!bytesEqual(bytes, canonical)) {
    return failure(
      "noncanonical",
      "$",
      "encoding must use sorted keys, canonical numbers and escapes, and no whitespace",
    );
  }
  return decoded;
}

export function defineCapsule<const Name extends string, const ValueSchema extends Schema>(
  name: Name,
  valueSchema: ValueSchema,
): SchemaCapsule<Name, Infer<ValueSchema>>;
export function defineCapsule(name: string, valueSchema: Schema): unknown {
  const fingerprint = canonicalDigestUnknown(Object.freeze({
    canonicalWire: CANONICAL_WIRE_VERSION,
    digest: "sha-256",
    maxSerializedDepth: MAX_SERIALIZED_DEPTH,
    name,
    schema: valueSchema,
  }));
  const kinds = schemaKinds(valueSchema);
  return Object.freeze({
    name,
    schema: valueSchema,
    kinds,
    fingerprint,
    decode(input: JsonValue) {
      return decodeWithSchema(valueSchema, input, "$", 0);
    },
    decodeCanonical(input: Uint8Array) {
      return decodeCanonicalWithSchema(valueSchema, input);
    },
    encode(value: unknown) {
      return canonicalEncodeUnknown(value);
    },
    encodeUnknown(value: unknown) {
      const decoded = decodeWithSchema(valueSchema, value, "$", 0);
      if (decoded.kind === "error") {
        return decoded;
      }
      return success(canonicalEncodeUnknown(decoded.value));
    },
    digest(value: unknown) {
      return digestBytes(canonicalEncodeUnknown(value));
    },
    digestUnknown(value: unknown) {
      const decoded = decodeWithSchema(valueSchema, value, "$", 0);
      if (decoded.kind === "error") {
        return decoded;
      }
      return success(digestBytes(canonicalEncodeUnknown(decoded.value)));
    },
    arbitrary: Object.freeze({
      valid(seed: number) {
        return generateValid(valueSchema, seed, 0);
      },
      validForKind(kind: string, seed: number) {
        return generateForKind(valueSchema, kind, seed);
      },
      malformedValue(seed: number) {
        return malformedValue(valueSchema, seed);
      },
      malformedBytes(seed: number) {
        return malformedCanonicalBytes(valueSchema, seed);
      },
      arbitraryBytes(seed: number, length: number) {
        return fuzzBytes(seed, length);
      },
    }),
  });
}
