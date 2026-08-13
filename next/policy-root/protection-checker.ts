import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigestUnknown } from "../authority/protocol/schema.js";
import type { Digest, JsonValue } from "../authority/protocol/schema.js";
import { activeAmendmentMarkers } from "./fingerprint-checker.js";
import {
  TRUSTED_BOOTSTRAP_COMMIT,
  readCommittedFile,
  resolveGovernanceBaseline,
} from "./governance-baseline.js";

export interface ProtectionManifest {
  readonly format: 1;
  readonly files: Readonly<Record<string, Digest>>;
}

export interface ProtectionFinding {
  readonly path: string;
  readonly detail: string;
}

export const AMENDMENT_ENVIRONMENT_FLAG = "PI_AUTOPILOT_ARCHITECTURE_AMENDMENT_APPROVED";

export const REQUIRED_PROTECTED_PATHS = Object.freeze([
  "adapters/tsconfig.json",
  "apps/tsconfig.json",
  "authority/protocol/accepted-batch.ts",
  "authority/tsconfig.json",
  "package.json",
  "policy-root/SEAM-OWNERSHIP.md",
  "policy-root/amendment-marker.ts",
  "policy-root/amendments/README.md",
  "policy-root/architecture-checker.ts",
  "policy-root/bootstrap-baselines.ts",
  "policy-root/fingerprint-checker.ts",
  "policy-root/gate-self-tests.ts",
  "policy-root/generate-aggregates.ts",
  "policy-root/governance-baseline.ts",
  "policy-root/hygiene-checker.ts",
  "policy-root/link-testkit-dependencies.ts",
  "policy-root/negative-compile.ts",
  "policy-root/payload-checker.ts",
  "policy-root/protection-checker.ts",
  "policy-root/protocol-fingerprints.json",
  "policy-root/purity-poison.test.ts",
  "policy-root/required-suites.json",
  "policy-root/run-policy.ts",
  "policy-root/suite-manifest-checker.ts",
  "policy-root/suppression-checker.ts",
  "policy-root/w0-gate.ts",
  "ports/tsconfig.json",
  "runtime/tsconfig.json",
  "storage/tsconfig.json",
  "testkit/tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.policy.json",
  "tsconfig.tests.json",
]);

interface UnknownObject {
  readonly [key: string]: unknown;
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function exactKeys(value: UnknownObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = expected.slice().sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function decodeProtectionManifest(value: unknown): ProtectionManifest | null {
  if (
    !isObject(value)
    || !exactKeys(value, ["files", "format"])
    || value["format"] !== 1
    || !isObject(value["files"])
  ) {
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

function selfComparableText(manifest: ProtectionManifest): string {
  const files: Record<string, Digest> = Object.create(null);
  for (const path of Object.keys(manifest.files).sort()) {
    if (path === "policy-root/protected-files.json") {
      continue;
    }
    const digest = manifest.files[path];
    if (digest !== undefined) {
      files[path] = digest;
    }
  }
  return `${JSON.stringify({ format: manifest.format, files }, null, 2)}\n`;
}

export function checkProtectionManifestSelfDigest(
  manifest: ProtectionManifest,
): readonly ProtectionFinding[] {
  const expected = manifest.files["policy-root/protected-files.json"];
  if (expected === undefined) {
    return Object.freeze([Object.freeze({
      path: "policy-root/protected-files.json",
      detail: "protection manifest must carry its own approved digest",
    })]);
  }
  if (contentDigest(selfComparableText(manifest)) !== expected) {
    return Object.freeze([Object.freeze({
      path: "policy-root/protected-files.json",
      detail: "protection manifest self-digest is invalid",
    })]);
  }
  return Object.freeze([]);
}

export function checkProtectedFiles(
  nextRoot: string,
  manifest: ProtectionManifest,
  markers: readonly string[],
  requiredPaths: readonly string[] = REQUIRED_PROTECTED_PATHS,
): readonly ProtectionFinding[] {
  const output: ProtectionFinding[] = [];
  for (const path of requiredPaths) {
    if (manifest.files[path] === undefined) {
      output.push(Object.freeze({
        path,
        detail: "required protected path is absent from the git-pinned protection manifest",
      }));
    }
  }
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
          ? "protected policy file differs from the git-pinned governance baseline"
          : "protected policy file differs from the git-pinned governance baseline; a marker cannot self-approve it",
      }));
    }
  }
  return Object.freeze(output);
}

function parseManifestText(text: string): ProtectionManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return decodeProtectionManifest(value);
}

export function readProtectionManifest(path: string): ProtectionManifest | null {
  if (!existsSync(path)) {
    return null;
  }
  return parseManifestText(readFileSync(path, "utf8"));
}

export function checkRepositoryProtection(
  nextRoot: string,
  requiredPaths: readonly string[] = REQUIRED_PROTECTED_PATHS,
  trustedBootstrapCommit: string = TRUSTED_BOOTSTRAP_COMMIT,
): readonly ProtectionFinding[] {
  const resolution = resolveGovernanceBaseline(nextRoot, trustedBootstrapCommit);
  if (resolution.baseline === null) {
    return Object.freeze(resolution.findings.map((detail) => Object.freeze({
      path: "policy-root/protected-files.json",
      detail,
    })));
  }
  const committed = readCommittedFile(
    nextRoot,
    resolution.baseline.tag,
    "policy-root/protected-files.json",
  );
  if (committed.text === null) {
    return Object.freeze([Object.freeze({
      path: "policy-root/protected-files.json",
      detail: committed.finding ?? `cannot read git-pinned baseline ${resolution.baseline.tag}`,
    })]);
  }
  const manifest = parseManifestText(committed.text);
  if (manifest === null) {
    return Object.freeze([Object.freeze({
      path: "policy-root/protected-files.json",
      detail: `git-pinned protection manifest at ${resolution.baseline.tag} is malformed`,
    })]);
  }
  const selfFindings = checkProtectionManifestSelfDigest(manifest);
  if (selfFindings.length > 0) {
    return selfFindings;
  }

  const output = [...checkProtectedFiles(
    nextRoot,
    manifest,
    activeAmendmentMarkers(nextRoot),
    requiredPaths,
  )];
  const workingPath = join(nextRoot, "policy-root", "protected-files.json");
  if (!existsSync(workingPath)) {
    output.push(Object.freeze({
      path: "policy-root/protected-files.json",
      detail: "working-tree protection manifest is missing",
    }));
  } else if (readFileSync(workingPath, "utf8") !== committed.text) {
    output.push(Object.freeze({
      path: "policy-root/protected-files.json",
      detail: `working-tree manifest differs from git-pinned baseline ${resolution.baseline.tag} and cannot self-certify`,
    }));
  }
  return Object.freeze(output);
}

export function protectionManifestValue(files: Readonly<Record<string, Digest>>): JsonValue {
  return Object.freeze({ format: 1, files: Object.freeze(files) });
}
