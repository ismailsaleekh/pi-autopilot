import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigestUnknown } from "../authority/protocol/schema.js";
import type { Digest, JsonValue } from "../authority/protocol/schema.js";
import { activeAmendmentMarkers } from "./fingerprint-checker.js";

export interface ProtectionManifest {
  readonly format: 1;
  readonly files: Readonly<Record<string, Digest>>;
}

export interface ProtectionFinding {
  readonly path: string;
  readonly detail: string;
}

export const AMENDMENT_ENVIRONMENT_FLAG = "PI_AUTOPILOT_ARCHITECTURE_AMENDMENT_APPROVED";

interface UnknownObject {
  readonly [key: string]: unknown;
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function decodeProtectionManifest(value: unknown): ProtectionManifest | null {
  if (!isObject(value) || value["format"] !== 1 || !isObject(value["files"])) {
    return null;
  }
  const files: Record<string, Digest> = Object.create(null);
  for (const path of Object.keys(value["files"]).sort()) {
    const digest = value["files"][path];
    if (!isDigest(digest)) {
      return null;
    }
    files[path] = digest;
  }
  return Object.freeze({ format: 1, files: Object.freeze(files) });
}

export function contentDigest(text: string): Digest {
  return canonicalDigestUnknown(text);
}

export function checkProtectedFiles(
  nextRoot: string,
  manifest: ProtectionManifest,
  markers: readonly string[],
): readonly ProtectionFinding[] {
  const output: ProtectionFinding[] = [];
  for (const path of Object.keys(manifest.files).sort()) {
    if (path === "policy-root/protected-files.json") {
      continue;
    }
    const expected = manifest.files[path];
    const absolute = join(nextRoot, path);
    if (!existsSync(absolute)) {
      output.push(Object.freeze({ path, detail: "protected policy file is missing" }));
      continue;
    }
    const actual = contentDigest(readFileSync(absolute, "utf8"));
    if (actual !== expected) {
      output.push(Object.freeze({
        path,
        detail: markers.length === 0
          ? "protected policy file changed without an architecture amendment marker"
          : "protected policy file changed; amendment review must update the protection baseline",
      }));
    }
  }
  if (output.length === 0 && markers.length > 0) {
    output.push(Object.freeze({
      path: "policy-root/amendments",
      detail: "stale architecture amendment marker exists without a protected-file change",
    }));
  }
  return Object.freeze(output);
}

export function readProtectionManifest(path: string): ProtectionManifest | null {
  if (!existsSync(path)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return decodeProtectionManifest(value);
}

export function checkRepositoryProtection(nextRoot: string): readonly ProtectionFinding[] {
  const manifest = readProtectionManifest(join(nextRoot, "policy-root", "protected-files.json"));
  if (manifest === null) {
    return Object.freeze([Object.freeze({
      path: "policy-root/protected-files.json",
      detail: "protection manifest is missing or malformed",
    })]);
  }
  const expectedSelfDigest = manifest.files["policy-root/protected-files.json"];
  if (expectedSelfDigest === undefined) {
    return Object.freeze([Object.freeze({
      path: "policy-root/protected-files.json",
      detail: "protection manifest must carry its own approved digest",
    })]);
  }
  const selfComparable: Record<string, unknown> = Object.create(null);
  selfComparable["format"] = manifest.format;
  const selfFiles: Record<string, Digest> = Object.create(null);
  for (const path of Object.keys(manifest.files).sort()) {
    if (path !== "policy-root/protected-files.json") {
      const digest = manifest.files[path];
      if (digest !== undefined) {
        selfFiles[path] = digest;
      }
    }
  }
  selfComparable["files"] = selfFiles;
  const actualSelfDigest = contentDigest(`${JSON.stringify(selfComparable, null, 2)}\n`);
  if (actualSelfDigest !== expectedSelfDigest) {
    return Object.freeze([Object.freeze({
      path: "policy-root/protected-files.json",
      detail: "protection manifest self-digest is invalid",
    })]);
  }
  const markers = activeAmendmentMarkers(nextRoot);
  if (markers.length > 0 && process.env[AMENDMENT_ENVIRONMENT_FLAG] !== "1") {
    return Object.freeze([Object.freeze({
      path: "policy-root/amendments",
      detail: `architecture marker requires protected CI approval via ${AMENDMENT_ENVIRONMENT_FLAG}`,
    })]);
  }
  return checkProtectedFiles(nextRoot, manifest, markers);
}

export function protectionManifestValue(files: Readonly<Record<string, Digest>>): JsonValue {
  return Object.freeze({ format: 1, files: Object.freeze(files) });
}
