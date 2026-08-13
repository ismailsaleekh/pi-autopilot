import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { protocolCapsules } from "../authority/protocol/aggregate.generated.js";
import type { Digest } from "../authority/protocol/schema.js";
import { portContractCapsules } from "../ports/contracts/aggregate.generated.js";
import {
  amendmentApprovalGranted,
  amendmentMarkerRelativePath,
  parseArchitectureAmendmentMarkdown,
  validateArchitectureAmendmentScope,
} from "./amendment-marker.js";
import type { AmendmentFingerprintChange } from "./amendment-marker.js";
import {
  activeAmendmentMarkers,
  currentFingerprintManifest,
  decodeFingerprintManifest,
} from "./fingerprint-checker.js";
import type { FingerprintManifest } from "./fingerprint-checker.js";
import {
  GOVERNANCE_BASELINE_PREFIX,
  GOVERNANCE_TAG_FORMAT,
  GOVERNANCE_TAG_TOOL,
  contentObjectDigest,
  governanceTagMessage,
  nextGovernanceAmendment,
  readCommittedFile,
  resolveGovernanceBaseline,
} from "./governance-baseline.js";
import type { GovernanceTagMetadata } from "./governance-baseline.js";
import {
  AMENDMENT_ENVIRONMENT_FLAG,
  REQUIRED_PROTECTED_PATHS,
  contentDigest,
  decodeProtectionManifest,
} from "./protection-checker.js";
import type { ProtectionManifest } from "./protection-checker.js";

const invokedWithApproval = amendmentApprovalGranted(
  process.argv,
  process.env[AMENDMENT_ENVIRONMENT_FLAG],
);
if (!invokedWithApproval) {
  process.stderr.write(
    `baseline regeneration requires --approved-amendment and ${AMENDMENT_ENVIRONMENT_FLAG}=1\n`,
  );
  process.exitCode = 2;
} else {
  runBaselineAmendment();
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readPinnedProtectionManifest(nextRoot: string, tag: string): ProtectionManifest | null {
  const committed = readCommittedFile(nextRoot, tag, "policy-root/protected-files.json");
  if (committed.text === null) {
    return null;
  }
  return decodeProtectionManifest(parseJson(committed.text));
}

function readPinnedFingerprints(nextRoot: string, tag: string): FingerprintManifest | null {
  const committed = readCommittedFile(nextRoot, tag, "policy-root/protocol-fingerprints.json");
  if (committed.text === null) {
    return null;
  }
  return decodeFingerprintManifest(parseJson(committed.text));
}

function fingerprintChanges(
  prior: FingerprintManifest,
  current: FingerprintManifest,
): readonly AmendmentFingerprintChange[] {
  const output: AmendmentFingerprintChange[] = [];
  const names = new Set([...Object.keys(prior.capsules), ...Object.keys(current.capsules)]);
  for (const capsule of [...names].sort()) {
    const oldDigest = prior.capsules[capsule]?.digest ?? null;
    const newDigest = current.capsules[capsule]?.digest ?? null;
    if (oldDigest !== newDigest) {
      output.push(Object.freeze({ capsule, oldDigest, newDigest }));
    }
  }
  return Object.freeze(output);
}

function targetProtectedPaths(
  prior: ProtectionManifest,
  markerPath: string,
): readonly string[] {
  return Object.freeze([...new Set([
    ...REQUIRED_PROTECTED_PATHS,
    ...Object.keys(prior.files).filter((path) => path !== "policy-root/protected-files.json"),
    markerPath,
  ])].sort());
}

function targetProtectionManifest(
  nextRoot: string,
  paths: readonly string[],
  fingerprintText: string,
): { readonly manifest: ProtectionManifest; readonly text: string } | null {
  const files: Record<string, Digest> = Object.create(null);
  for (const path of paths) {
    const absolute = join(nextRoot, path);
    if (!existsSync(absolute)) {
      process.stderr.write(`refusing amendment: protected file is missing: ${path}\n`);
      return null;
    }
    const text = path === "policy-root/protocol-fingerprints.json"
      ? fingerprintText
      : readFileSync(absolute, "utf8");
    files[path] = contentDigest(text);
  }
  const unsignedText = pretty({ format: 1, files });
  files["policy-root/protected-files.json"] = contentDigest(unsignedText);
  const manifest = Object.freeze({ format: 1, files: Object.freeze(files) });
  return Object.freeze({ manifest, text: pretty(manifest) });
}

function changedProtectedPaths(
  prior: ProtectionManifest,
  target: ProtectionManifest,
  priorManifestText: string,
  targetManifestText: string,
): readonly string[] {
  const output: string[] = [];
  const paths = new Set([...Object.keys(prior.files), ...Object.keys(target.files)]);
  for (const path of [...paths].sort()) {
    if (path === "policy-root/protected-files.json") {
      continue;
    }
    if (prior.files[path] !== target.files[path]) {
      output.push(path);
    }
  }
  if (priorManifestText !== targetManifestText) {
    output.push("policy-root/protected-files.json");
  }
  return Object.freeze(output.sort());
}

function git(nextRoot: string, arguments_: readonly string[]): { readonly status: number | null; readonly stderr: string; readonly stdout: string } {
  const child = spawnSync("git", ["-C", nextRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return Object.freeze({
    status: child.status,
    stderr: typeof child.stderr === "string" ? child.stderr : "",
    stdout: typeof child.stdout === "string" ? child.stdout : "",
  });
}

function expectedMarkerSet(
  prior: ProtectionManifest,
  expectedMarkerName: string,
): readonly string[] {
  const historical = Object.keys(prior.files)
    .filter((path) => /^policy-root\/amendments\/ARCHITECTURE-AMENDMENT-[0-9]{3,}\.md$/.test(path))
    .map((path) => path.slice(path.lastIndexOf("/") + 1));
  return Object.freeze([...new Set([...historical, expectedMarkerName])].sort());
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function runBaselineAmendment(): void {
  const modulePolicyRoot = dirname(fileURLToPath(import.meta.url));
  const moduleParent = dirname(modulePolicyRoot);
  const nextRoot = basename(moduleParent) === "dist-policy" ? dirname(moduleParent) : moduleParent;

  const resolution = resolveGovernanceBaseline(nextRoot);
  if (resolution.baseline === null) {
    for (const finding of resolution.findings) {
      process.stderr.write(`refusing amendment: ${finding}\n`);
    }
    process.exitCode = 2;
    return;
  }
  const amendment = nextGovernanceAmendment(resolution.baseline);
  const markerPath = amendmentMarkerRelativePath(amendment);
  const markerName = markerPath.slice(markerPath.lastIndexOf("/") + 1);
  const markerAbsolute = join(nextRoot, markerPath);
  if (!existsSync(markerAbsolute)) {
    process.stderr.write(`refusing amendment: required marker is missing: ${markerPath}\n`);
    process.exitCode = 2;
    return;
  }

  const priorManifestRead = readCommittedFile(
    nextRoot,
    resolution.baseline.tag,
    "policy-root/protected-files.json",
  );
  const priorManifest = readPinnedProtectionManifest(nextRoot, resolution.baseline.tag);
  const priorFingerprints = readPinnedFingerprints(nextRoot, resolution.baseline.tag);
  if (priorManifestRead.text === null || priorManifest === null || priorFingerprints === null) {
    process.stderr.write(`refusing amendment: ${resolution.baseline.tag} has unreadable governance baselines\n`);
    process.exitCode = 2;
    return;
  }

  const presentMarkers = activeAmendmentMarkers(nextRoot);
  const requiredMarkers = expectedMarkerSet(priorManifest, markerName);
  if (!sameStrings(presentMarkers, requiredMarkers)) {
    process.stderr.write("refusing amendment: exactly the historical markers plus the next amendment marker must be present\n");
    process.exitCode = 2;
    return;
  }

  const markerText = readFileSync(markerAbsolute, "utf8");
  const marker = parseArchitectureAmendmentMarkdown(markerText, amendment);
  if (marker === null) {
    process.stderr.write(`refusing amendment: ${markerPath} is malformed or names the wrong amendment\n`);
    process.exitCode = 2;
    return;
  }

  const currentFingerprints = currentFingerprintManifest(Object.freeze([
    ...protocolCapsules,
    ...portContractCapsules,
  ]));
  const fingerprintText = pretty(currentFingerprints);
  const protectedPaths = targetProtectedPaths(priorManifest, markerPath);
  const target = targetProtectionManifest(nextRoot, protectedPaths, fingerprintText);
  if (target === null) {
    process.exitCode = 2;
    return;
  }
  const changedPaths = changedProtectedPaths(
    priorManifest,
    target.manifest,
    priorManifestRead.text,
    target.text,
  );
  if (changedPaths.length === 0) {
    process.stderr.write("refusing amendment: no protected governance change exists\n");
    process.exitCode = 2;
    return;
  }
  const scopeFindings = validateArchitectureAmendmentScope(
    marker,
    changedPaths,
    fingerprintChanges(priorFingerprints, currentFingerprints),
  );
  if (scopeFindings.length > 0) {
    for (const finding of scopeFindings) {
      process.stderr.write(`refusing amendment: ${finding}\n`);
    }
    process.exitCode = 2;
    return;
  }

  writeFileSync(join(nextRoot, "policy-root", "protocol-fingerprints.json"), fingerprintText, "utf8");
  writeFileSync(join(nextRoot, "policy-root", "protected-files.json"), target.text, "utf8");

  const status = git(nextRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) {
    process.stderr.write(`refusing amendment: git status failed: ${status.stderr.trim()}\n`);
    process.exitCode = 2;
    return;
  }
  if (status.stdout.trim().length > 0) {
    process.stdout.write(
      `amendment ${amendment} baselines regenerated; commit the complete reviewed change, then rerun the same approved command to create ${GOVERNANCE_BASELINE_PREFIX}${amendment}\n`,
    );
    return;
  }

  const committedMarker = readCommittedFile(nextRoot, "HEAD", markerPath);
  const committedManifest = readCommittedFile(nextRoot, "HEAD", "policy-root/protected-files.json");
  const committedFingerprints = readCommittedFile(nextRoot, "HEAD", "policy-root/protocol-fingerprints.json");
  if (
    committedMarker.text !== markerText
    || committedManifest.text !== target.text
    || committedFingerprints.text !== fingerprintText
  ) {
    process.stderr.write("refusing amendment: marker and regenerated baselines must be committed at HEAD\n");
    process.exitCode = 2;
    return;
  }

  const tag = `${GOVERNANCE_BASELINE_PREFIX}${amendment}`;
  const existing = git(nextRoot, ["show-ref", "--verify", `refs/tags/${tag}`]);
  if (existing.status === 0) {
    process.stderr.write(`refusing amendment: governance tag already exists: ${tag}\n`);
    process.exitCode = 2;
    return;
  }
  const metadata: GovernanceTagMetadata = Object.freeze({
    format: GOVERNANCE_TAG_FORMAT,
    tool: GOVERNANCE_TAG_TOOL,
    amendment,
    predecessor: resolution.baseline.tag,
    marker: markerPath,
    markerDigest: contentObjectDigest(markerText),
    manifestDigest: contentObjectDigest(target.text),
  });
  const created = git(nextRoot, ["tag", "-a", tag, "-m", governanceTagMessage(metadata), "HEAD"]);
  if (created.status !== 0) {
    process.stderr.write(`failed to create ${tag}: ${created.stderr.trim()}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`created governance baseline tag ${tag} at committed HEAD\n`);
}
