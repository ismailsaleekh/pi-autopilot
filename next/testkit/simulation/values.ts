import {
  artifactPathSchema,
  artifactRootSchema,
  childEpochSchema,
  childIdSchema,
  diagnosticCodeSchema,
  leaseIdSchema,
  pageCursorSchema,
  revisionIdSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ArtifactPath,
  ArtifactRoot,
  ChildEpoch,
  ChildId,
  DiagnosticCode,
  LeaseId,
  PageCursor,
  RevisionId,
} from "../../authority/protocol/identifiers.js";
import {
  canonicalDigestUnknown,
  defineCapsule,
  digestBytes,
} from "../../authority/protocol/schema.js";
import type { Digest, JsonValue, SchemaCapsule } from "../../authority/protocol/schema.js";

const artifactPathCapsule = defineCapsule("SimulationArtifactPath", artifactPathSchema);
const artifactRootCapsule = defineCapsule("SimulationArtifactRoot", artifactRootSchema);
const childEpochCapsule = defineCapsule("SimulationChildEpoch", childEpochSchema);
const childIdCapsule = defineCapsule("SimulationChildId", childIdSchema);
const diagnosticCodeCapsule = defineCapsule("SimulationDiagnosticCode", diagnosticCodeSchema);
const leaseIdCapsule = defineCapsule("SimulationLeaseId", leaseIdSchema);
const pageCursorCapsule = defineCapsule("SimulationPageCursor", pageCursorSchema);
const revisionIdCapsule = defineCapsule("SimulationRevisionId", revisionIdSchema);

function decodedOrGenerated<Value>(
  capsule: SchemaCapsule<string, Value>,
  candidate: string,
  fallbackSeed: number,
): Value {
  const result = capsule.decode(candidate);
  return result.kind === "ok" ? result.value : capsule.arbitrary.valid(fallbackSeed);
}

export function cloneBytes(input: unknown): Uint8Array | null {
  try {
    if (!(input instanceof Uint8Array)) {
      return null;
    }
    return input.slice();
  } catch {
    return null;
  }
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

export function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function encodeUtf8(value: string): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + following - 0xdc00;
        index += 1;
      } else {
        point = 0xfffd;
      }
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      point = 0xfffd;
    }
    if (point <= 0x7f) {
      output.push(point);
    } else if (point <= 0x7ff) {
      output.push(0xc0 | (point >>> 6), 0x80 | (point & 0x3f));
    } else if (point <= 0xffff) {
      output.push(0xe0 | (point >>> 12), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      output.push(
        0xf0 | (point >>> 18),
        0x80 | ((point >>> 12) & 0x3f),
        0x80 | ((point >>> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return Uint8Array.from(output);
}

export function decodeUtf8(input: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return null;
  }
}

export function bytesHex(input: Uint8Array): string {
  const digits = "0123456789abcdef";
  let output = "";
  for (const byte of input) {
    output += `${digits[(byte >>> 4) & 15]}${digits[byte & 15]}`;
  }
  return output;
}

export function digestForBytes(input: Uint8Array): Digest {
  return digestBytes(input);
}

export function artifactRootFor(value: JsonValue): ArtifactRoot {
  const digest = canonicalDigestUnknown(value);
  return decodedOrGenerated(artifactRootCapsule, digest, 1);
}

export function artifactRootForBytes(input: Uint8Array): ArtifactRoot {
  return decodedOrGenerated(artifactRootCapsule, digestBytes(input), 2);
}

export function artifactPath(value: string): ArtifactPath | null {
  const decoded = artifactPathCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}

export function childIdFor(label: JsonValue): ChildId {
  const digest = canonicalDigestUnknown(label).slice(7);
  return decodedOrGenerated(childIdCapsule, `child:${digest}`, 3);
}

export function childEpochFor(label: JsonValue): ChildEpoch {
  const digest = canonicalDigestUnknown(label).slice(7);
  const decimal = BigInt(`0x${digest}`).toString(10);
  return decodedOrGenerated(childEpochCapsule, decimal, 4);
}

export function leaseIdFor(label: JsonValue): LeaseId {
  const digest = canonicalDigestUnknown(label).slice(7);
  return decodedOrGenerated(leaseIdCapsule, `lease:${digest}`, 5);
}

export function revisionIdFor(label: JsonValue): RevisionId {
  const digest = canonicalDigestUnknown(label).slice(7);
  return decodedOrGenerated(revisionIdCapsule, `revision:${digest}`, 6);
}

export function diagnosticCode(value: string): DiagnosticCode {
  return decodedOrGenerated(diagnosticCodeCapsule, value, 7);
}

export function pageCursorFor(offset: number, binding: string): PageCursor {
  const digest = canonicalDigestUnknown(Object.freeze({ binding, offset })).slice(7, 23);
  return decodedOrGenerated(pageCursorCapsule, `cursor:${String(offset)}:${digest}`, 8);
}

export function pageCursorOffset(cursor: PageCursor, binding: string): number | null {
  const fields = cursor.split(":");
  if (fields.length !== 3 || fields[0] !== "cursor") {
    return null;
  }
  const offset = Number(fields[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return null;
  }
  return pageCursorFor(offset, binding) === cursor ? offset : null;
}
