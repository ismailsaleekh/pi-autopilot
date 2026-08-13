import type { Digest } from "../authority/protocol/schema.js";

export interface AmendmentFingerprintChange {
  readonly capsule: string;
  readonly oldDigest: Digest | null;
  readonly newDigest: Digest | null;
}

export function amendmentApprovalGranted(
  arguments_: readonly string[],
  environmentValue: string | undefined,
): boolean {
  return arguments_.includes("--approved-amendment") && environmentValue === "1";
}

export interface ArchitectureAmendmentMarker {
  readonly format: 1;
  readonly id: string;
  readonly operatorApproval: string;
  readonly rationale: string;
  readonly protectedFiles: readonly string[];
  readonly fingerprintChanges: readonly AmendmentFingerprintChange[];
}

interface UnknownObject {
  readonly [key: string]: unknown;
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = expected.slice().sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isDigestOrNull(value: unknown): value is Digest | null {
  return value === null || (typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value));
}

function isProtectedPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.split("/").includes("..")
    && !value.includes("\\");
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const prior = values[index - 1];
    return index === 0 || prior !== undefined && prior < value;
  });
}

function decodeFingerprintChange(value: unknown): AmendmentFingerprintChange | null {
  if (
    !isObject(value)
    || !exactKeys(value, ["capsule", "newDigest", "oldDigest"])
    || typeof value["capsule"] !== "string"
    || value["capsule"].length === 0
    || !isDigestOrNull(value["oldDigest"])
    || !isDigestOrNull(value["newDigest"])
    || value["oldDigest"] === value["newDigest"]
  ) {
    return null;
  }
  return Object.freeze({
    capsule: value["capsule"],
    oldDigest: value["oldDigest"],
    newDigest: value["newDigest"],
  });
}

export function decodeArchitectureAmendment(value: unknown): ArchitectureAmendmentMarker | null {
  if (
    !isObject(value)
    || !exactKeys(value, [
      "fingerprintChanges",
      "format",
      "id",
      "operatorApproval",
      "protectedFiles",
      "rationale",
    ])
    || value["format"] !== 1
    || typeof value["id"] !== "string"
    || !/^[0-9]{3,}$/.test(value["id"])
    || typeof value["operatorApproval"] !== "string"
    || value["operatorApproval"].trim().length === 0
    || typeof value["rationale"] !== "string"
    || value["rationale"].trim().length === 0
    || !Array.isArray(value["protectedFiles"])
    || !value["protectedFiles"].every(isProtectedPath)
    || !sortedUnique(value["protectedFiles"])
    || !Array.isArray(value["fingerprintChanges"])
  ) {
    return null;
  }
  const fingerprintChanges: AmendmentFingerprintChange[] = [];
  for (const entry of value["fingerprintChanges"]) {
    const decoded = decodeFingerprintChange(entry);
    if (decoded === null) {
      return null;
    }
    fingerprintChanges.push(decoded);
  }
  if (!sortedUnique(fingerprintChanges.map((entry) => entry.capsule))) {
    return null;
  }
  return Object.freeze({
    format: 1,
    id: value["id"],
    operatorApproval: value["operatorApproval"],
    rationale: value["rationale"],
    protectedFiles: Object.freeze(value["protectedFiles"].slice()),
    fingerprintChanges: Object.freeze(fingerprintChanges),
  });
}

export function amendmentMarkerRelativePath(id: string): string {
  return `policy-root/amendments/ARCHITECTURE-AMENDMENT-${id}.md`;
}

export function parseArchitectureAmendmentMarkdown(
  text: string,
  expectedId: string,
): ArchitectureAmendmentMarker | null {
  const blocks = [...text.matchAll(/```architecture-amendment\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) {
    return null;
  }
  const body = blocks[0]?.[1];
  if (body === undefined) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const decoded = decodeArchitectureAmendment(value);
  return decoded !== null && decoded.id === expectedId ? decoded : null;
}

function changeIdentity(change: AmendmentFingerprintChange): string {
  return `${change.capsule}\u0000${String(change.oldDigest)}\u0000${String(change.newDigest)}`;
}

export function validateArchitectureAmendmentScope(
  marker: ArchitectureAmendmentMarker,
  expectedProtectedFiles: readonly string[],
  expectedFingerprintChanges: readonly AmendmentFingerprintChange[],
): readonly string[] {
  const findings: string[] = [];
  const expectedPaths = expectedProtectedFiles.slice().sort();
  if (
    marker.protectedFiles.length !== expectedPaths.length
    || marker.protectedFiles.some((path, index) => path !== expectedPaths[index])
  ) {
    findings.push("amendment marker protectedFiles must name every and only changed protected file");
  }
  const expectedFingerprints = expectedFingerprintChanges.slice().sort((left, right) => left.capsule.localeCompare(right.capsule));
  if (
    marker.fingerprintChanges.length !== expectedFingerprints.length
    || marker.fingerprintChanges.some((change, index) => {
      const expected = expectedFingerprints[index];
      return expected === undefined || changeIdentity(change) !== changeIdentity(expected);
    })
  ) {
    findings.push("amendment marker fingerprintChanges must carry the exact old/new capsule fingerprints");
  }
  const markerPath = amendmentMarkerRelativePath(marker.id);
  if (!marker.protectedFiles.includes(markerPath)) {
    findings.push("amendment marker must include its own path in protectedFiles");
  }
  return Object.freeze(findings);
}
