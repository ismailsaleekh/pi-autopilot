import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigestUnknown } from "../authority/protocol/schema.js";
import type { Digest, JsonValue, Schema } from "../authority/protocol/schema.js";

export interface FingerprintEntry {
  readonly digest: Digest;
  readonly kinds: readonly string[];
}

export interface FingerprintManifest {
  readonly format: 1;
  readonly capsules: Readonly<Record<string, FingerprintEntry>>;
}

export interface FingerprintFinding {
  readonly capsule: string;
  readonly detail: string;
}

interface ManifestObject {
  readonly [key: string]: unknown;
}

function isObject(value: unknown): value is ManifestObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function decodeFingerprintManifest(value: unknown): FingerprintManifest | null {
  if (!isObject(value) || value["format"] !== 1 || !isObject(value["capsules"])) {
    return null;
  }
  const rawCapsules = value["capsules"];
  const capsules: Record<string, FingerprintEntry> = Object.create(null);
  for (const name of Object.keys(rawCapsules).sort()) {
    const entry = rawCapsules[name];
    if (!isObject(entry) || !isDigest(entry["digest"]) || !isStringArray(entry["kinds"])) {
      return null;
    }
    capsules[name] = Object.freeze({
      digest: entry["digest"],
      kinds: Object.freeze(entry["kinds"].slice().sort()),
    });
  }
  return Object.freeze({ format: 1, capsules: Object.freeze(capsules) });
}

interface FingerprintCapsule {
  readonly name: string;
  readonly schema: Schema;
  readonly kinds: readonly string[];
  readonly fingerprint: Digest;
}

export function currentFingerprintManifest(
  capsules: readonly FingerprintCapsule[],
): FingerprintManifest {
  const output: Record<string, FingerprintEntry> = Object.create(null);
  const sorted = capsules.slice().sort((left, right) => {
    if (left.name < right.name) {
      return -1;
    }
    return left.name > right.name ? 1 : 0;
  });
  for (const capsule of sorted) {
    output[capsule.name] = Object.freeze({
      digest: capsule.fingerprint,
      kinds: Object.freeze(capsule.kinds.slice().sort()),
    });
  }
  return Object.freeze({ format: 1, capsules: Object.freeze(output) });
}

function manifestComparable(manifest: FingerprintManifest): JsonValue {
  return Object.freeze({
    format: manifest.format,
    capsules: Object.freeze(Object.fromEntries(
      Object.entries(manifest.capsules).map(([name, entry]) => [
        name,
        Object.freeze({ digest: entry.digest, kinds: entry.kinds }),
      ]),
    )),
  });
}

export function fingerprintManifestDigest(manifest: FingerprintManifest): Digest {
  return canonicalDigestUnknown(manifestComparable(manifest));
}

export function diffFingerprints(
  expected: FingerprintManifest,
  actual: FingerprintManifest,
): readonly FingerprintFinding[] {
  const output: FingerprintFinding[] = [];
  const names = new Set([...Object.keys(expected.capsules), ...Object.keys(actual.capsules)]);
  for (const name of [...names].sort()) {
    const prior = expected.capsules[name];
    const current = actual.capsules[name];
    if (prior === undefined) {
      output.push(Object.freeze({ capsule: name, detail: "capsule is absent from the protected baseline" }));
    } else if (current === undefined) {
      output.push(Object.freeze({ capsule: name, detail: "protected capsule is absent from generated aggregate" }));
    } else if (
      prior.digest !== current.digest
      || prior.kinds.length !== current.kinds.length
      || prior.kinds.some((kind, index) => kind !== current.kinds[index])
    ) {
      output.push(Object.freeze({ capsule: name, detail: "schema or closed-union kind fingerprint changed" }));
    }
  }
  return Object.freeze(output);
}

export function activeAmendmentMarkers(nextRoot: string): readonly string[] {
  const directory = join(nextRoot, "policy-root", "amendments");
  if (!existsSync(directory)) {
    return Object.freeze([]);
  }
  return Object.freeze(readdirSync(directory)
    .filter((name) => /^ARCHITECTURE-AMENDMENT-[A-Za-z0-9._-]+\.md$/.test(name))
    .sort());
}

export function checkFingerprintChange(
  expected: FingerprintManifest,
  actual: FingerprintManifest,
  amendmentMarkers: readonly string[],
): readonly FingerprintFinding[] {
  const differences = diffFingerprints(expected, actual);
  if (differences.length === 0) {
    if (amendmentMarkers.length > 0) {
      return Object.freeze([Object.freeze({
        capsule: "policy-root/amendments",
        detail: "stale amendment marker exists without a fingerprint change",
      })]);
    }
    return differences;
  }
  if (amendmentMarkers.length === 0) {
    return Object.freeze(differences.map((difference) => Object.freeze({
      capsule: difference.capsule,
      detail: `${difference.detail}; an operator-approved architecture amendment marker is required`,
    })));
  }
  return differences;
}

export function readFingerprintManifest(path: string): FingerprintManifest | null {
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return decodeFingerprintManifest(parsed);
}
