import {
  bytesEqual,
  canonicalEncodeUnknown,
  defineCapsule,
  jsonValue,
} from "../../authority/protocol/schema.js";
import type { JsonValue } from "../../authority/protocol/schema.js";

export type TraceCategory = "semantic" | "contract" | "durability" | "operational";

export interface TraceEvent {
  readonly sequence: number;
  readonly tick: number;
  readonly category: TraceCategory;
  readonly source: string;
  readonly name: string;
  readonly key: string;
  readonly data: JsonValue;
}

export type TraceEquivalenceResult =
  | {
      readonly kind: "equivalent";
      readonly leftEvents: number;
      readonly rightEvents: number;
    }
  | {
      readonly kind: "different";
      readonly leftEvents: number;
      readonly rightEvents: number;
      readonly firstDifference: number;
      readonly diagnostic: string;
    }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const jsonCapsule = defineCapsule("SimulationTraceJson", jsonValue());

export function traceJson(input: unknown): JsonValue | null {
  try {
    const encoded = jsonCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = jsonCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

function validCategory(input: unknown): input is TraceCategory {
  return input === "semantic"
    || input === "contract"
    || input === "durability"
    || input === "operational";
}

function decodeEvent(input: unknown): TraceEvent | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const sequence = Reflect.get(input, "sequence");
    const tick = Reflect.get(input, "tick");
    const category = Reflect.get(input, "category");
    const source = Reflect.get(input, "source");
    const name = Reflect.get(input, "name");
    const key = Reflect.get(input, "key");
    const data = traceJson(Reflect.get(input, "data"));
    if (
      typeof sequence !== "number"
      || !Number.isSafeInteger(sequence)
      || sequence < 0
      || typeof tick !== "number"
      || !Number.isSafeInteger(tick)
      || tick < 0
      || !validCategory(category)
      || typeof source !== "string"
      || typeof name !== "string"
      || typeof key !== "string"
      || data === null
    ) {
      return null;
    }
    return Object.freeze({ sequence, tick, category, source, name, key, data });
  } catch {
    return null;
  }
}

function eventArray(input: unknown): readonly TraceEvent[] | null {
  try {
    if (input instanceof SimTrace) {
      return input.snapshot();
    }
    if (!Array.isArray(input)) {
      return null;
    }
    const output: TraceEvent[] = [];
    for (const candidate of input) {
      const event = decodeEvent(candidate);
      if (event === null) {
        return null;
      }
      output.push(event);
    }
    return Object.freeze(output);
  } catch {
    return null;
  }
}

function semanticProjection(events: readonly TraceEvent[]): readonly JsonValue[] {
  const output: JsonValue[] = [];
  const accepted = new Map<string, Uint8Array>();
  for (const event of events) {
    if (event.category !== "semantic") {
      continue;
    }
    const projected = Object.freeze({
      data: event.data,
      key: event.key,
      name: event.name,
      source: event.source,
    });
    const encoded = canonicalEncodeUnknown(projected);
    const prior = accepted.get(event.key);
    if (prior !== undefined && bytesEqual(prior, encoded)) {
      continue;
    }
    accepted.set(event.key, encoded);
    output.push(projected);
  }
  return Object.freeze(output);
}

export class SimTrace {
  private readonly events: TraceEvent[];

  public constructor(prefix?: unknown) {
    const decodedPrefix = prefix === undefined ? Object.freeze([]) : eventArray(prefix);
    this.events = decodedPrefix === null ? [] : decodedPrefix.slice();
  }

  public append(
    tick: unknown,
    category: unknown,
    source: unknown,
    name: unknown,
    key: unknown,
    data: unknown,
  ): boolean {
    try {
      const normalizedData = traceJson(data);
      if (
        typeof tick !== "number"
        || !Number.isSafeInteger(tick)
        || tick < 0
        || !validCategory(category)
        || typeof source !== "string"
        || source.length === 0
        || typeof name !== "string"
        || name.length === 0
        || typeof key !== "string"
        || key.length === 0
        || normalizedData === null
      ) {
        return false;
      }
      this.events.push(Object.freeze({
        sequence: this.events.length,
        tick,
        category,
        source,
        name,
        key,
        data: normalizedData,
      }));
      return true;
    } catch {
      return false;
    }
  }

  public snapshot(): readonly TraceEvent[] {
    return Object.freeze(this.events.slice());
  }

  public canonicalBytes(): Uint8Array {
    return canonicalEncodeUnknown(this.events);
  }

  public semanticBytes(): Uint8Array {
    return canonicalEncodeUnknown(semanticProjection(this.events));
  }
}

/**
 * Semantic equivalence compares the ordered semantic projection only. Tick,
 * polling, durability, crash, restart, and normalized port-observation events
 * are operational and excluded. Repeated identical semantic keys are folded;
 * a repeated key with different bytes remains visible and therefore differs.
 * The function is total: malformed inputs produce an `invalid` result.
 */
export function assertTraceEquivalent(left: unknown, right: unknown): TraceEquivalenceResult {
  const leftEvents = eventArray(left);
  const rightEvents = eventArray(right);
  if (leftEvents === null || rightEvents === null) {
    return Object.freeze({ kind: "invalid", diagnostic: "trace input is not a valid SimTrace or TraceEvent array" });
  }
  const leftSemantic = semanticProjection(leftEvents);
  const rightSemantic = semanticProjection(rightEvents);
  const sharedLength = Math.min(leftSemantic.length, rightSemantic.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftBytes = canonicalEncodeUnknown(leftSemantic[index]);
    const rightBytes = canonicalEncodeUnknown(rightSemantic[index]);
    if (!bytesEqual(leftBytes, rightBytes)) {
      return Object.freeze({
        kind: "different",
        leftEvents: leftSemantic.length,
        rightEvents: rightSemantic.length,
        firstDifference: index,
        diagnostic: "semantic events differ at the reported index",
      });
    }
  }
  if (leftSemantic.length !== rightSemantic.length) {
    return Object.freeze({
      kind: "different",
      leftEvents: leftSemantic.length,
      rightEvents: rightSemantic.length,
      firstDifference: sharedLength,
      diagnostic: "semantic traces have different lengths",
    });
  }
  return Object.freeze({
    kind: "equivalent",
    leftEvents: leftSemantic.length,
    rightEvents: rightSemantic.length,
  });
}
