import { spawnSync } from "node:child_process";
import { canonicalDigestUnknown } from "../authority/protocol/schema.js";
import type { Digest } from "../authority/protocol/schema.js";

export const TRUSTED_BOOTSTRAP_TAG = "w0-trusted-baseline";
export const TRUSTED_BOOTSTRAP_COMMIT = "b5f5a142b1c99a67aed90a99fcb1ad05e8f28f7e";
export const GOVERNANCE_BASELINE_PREFIX = "governance-baseline-";
export const GOVERNANCE_TAG_FORMAT = 1;
export const GOVERNANCE_TAG_TOOL = "pi-autopilot-governance-baseline";

export interface GovernanceTagMetadata {
  readonly format: 1;
  readonly tool: typeof GOVERNANCE_TAG_TOOL;
  readonly amendment: string;
  readonly predecessor: string;
  readonly marker: string;
  readonly markerDigest: Digest;
  readonly manifestDigest: Digest;
}

export interface GovernanceBaseline {
  readonly tag: string;
  readonly amendment: string | null;
  readonly predecessor: string | null;
}

export interface GovernanceBaselineResolution {
  readonly baseline: GovernanceBaseline | null;
  readonly findings: readonly string[];
}

interface UnknownObject {
  readonly [key: string]: unknown;
}

interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
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

function runGit(nextRoot: string, arguments_: readonly string[]): GitResult {
  const child = spawnSync("git", ["-C", nextRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return Object.freeze({
    status: child.status,
    stdout: typeof child.stdout === "string" ? child.stdout : "",
    stderr: typeof child.stderr === "string" ? child.stderr : "",
  });
}

function gitFailure(result: GitResult): string {
  const detail = result.stderr.trim();
  return detail.length > 0 ? detail : `git exited with status ${String(result.status)}`;
}

function nextPrefix(nextRoot: string): { readonly prefix: string | null; readonly finding: string | null } {
  const result = runGit(nextRoot, ["rev-parse", "--show-prefix"]);
  if (result.status !== 0) {
    return Object.freeze({ prefix: null, finding: `cannot locate repository for governance baseline: ${gitFailure(result)}` });
  }
  const prefix = result.stdout.trim();
  return Object.freeze({ prefix: prefix.length === 0 ? "" : `${prefix.replace(/\/+$/, "")}/`, finding: null });
}

export function readCommittedFile(
  nextRoot: string,
  revision: string,
  nextRelativePath: string,
): { readonly text: string | null; readonly finding: string | null } {
  const located = nextPrefix(nextRoot);
  if (located.prefix === null) {
    return Object.freeze({ text: null, finding: located.finding });
  }
  const result = runGit(nextRoot, ["show", `${revision}:${located.prefix}${nextRelativePath}`]);
  if (result.status !== 0) {
    return Object.freeze({
      text: null,
      finding: `cannot read ${nextRelativePath} from ${revision}: ${gitFailure(result)}`,
    });
  }
  return Object.freeze({ text: result.stdout, finding: null });
}

export function contentObjectDigest(text: string): Digest {
  return canonicalDigestUnknown(text);
}

export function decodeGovernanceTagMetadata(value: unknown): GovernanceTagMetadata | null {
  if (
    !isObject(value)
    || !exactKeys(value, [
      "amendment",
      "format",
      "manifestDigest",
      "marker",
      "markerDigest",
      "predecessor",
      "tool",
    ])
    || value["format"] !== GOVERNANCE_TAG_FORMAT
    || value["tool"] !== GOVERNANCE_TAG_TOOL
    || typeof value["amendment"] !== "string"
    || !/^[0-9]{3,}$/.test(value["amendment"])
    || typeof value["predecessor"] !== "string"
    || typeof value["marker"] !== "string"
    || value["marker"] !== `policy-root/amendments/ARCHITECTURE-AMENDMENT-${value["amendment"]}.md`
    || !isDigest(value["markerDigest"])
    || !isDigest(value["manifestDigest"])
  ) {
    return null;
  }
  return Object.freeze({
    format: 1,
    tool: GOVERNANCE_TAG_TOOL,
    amendment: value["amendment"],
    predecessor: value["predecessor"],
    marker: value["marker"],
    markerDigest: value["markerDigest"],
    manifestDigest: value["manifestDigest"],
  });
}

export function governanceTagMessage(metadata: GovernanceTagMetadata): string {
  return JSON.stringify(metadata);
}

function tagCommitExists(nextRoot: string, tag: string): string | null {
  const result = runGit(nextRoot, ["rev-parse", "--verify", `${tag}^{commit}`]);
  return result.status === 0 ? null : `governance baseline tag ${tag} does not resolve to a commit: ${gitFailure(result)}`;
}

function isAncestor(nextRoot: string, ancestor: string, descendant: string): boolean {
  return runGit(nextRoot, ["merge-base", "--is-ancestor", `${ancestor}^{commit}`, `${descendant}^{commit}`]).status === 0;
}

function parseTagMetadata(nextRoot: string, tag: string): GovernanceTagMetadata | null {
  const result = runGit(nextRoot, ["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`]);
  if (result.status !== 0) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
  return decodeGovernanceTagMetadata(value);
}

function validateGovernanceTag(
  nextRoot: string,
  tag: string,
  expectedAmendment: string,
  expectedPredecessor: string,
): readonly string[] {
  const output: string[] = [];
  const objectType = runGit(nextRoot, ["cat-file", "-t", `refs/tags/${tag}`]);
  if (objectType.status !== 0 || objectType.stdout.trim() !== "tag") {
    output.push(`${tag} must be an annotated tag created by amendment tooling`);
    return Object.freeze(output);
  }
  const commitFinding = tagCommitExists(nextRoot, tag);
  if (commitFinding !== null) {
    output.push(commitFinding);
    return Object.freeze(output);
  }
  const metadata = parseTagMetadata(nextRoot, tag);
  if (metadata === null) {
    output.push(`${tag} has missing or malformed amendment-tool metadata`);
    return Object.freeze(output);
  }
  if (metadata.amendment !== expectedAmendment) {
    output.push(`${tag} metadata names amendment ${metadata.amendment}, expected ${expectedAmendment}`);
  }
  if (metadata.predecessor !== expectedPredecessor) {
    output.push(`${tag} predecessor is ${metadata.predecessor}, expected ${expectedPredecessor}`);
  } else if (!isAncestor(nextRoot, expectedPredecessor, tag)) {
    output.push(`${tag} is not a descendant of predecessor ${expectedPredecessor}`);
  }
  const marker = readCommittedFile(nextRoot, tag, metadata.marker);
  if (marker.text === null) {
    output.push(marker.finding ?? `${tag} marker cannot be read`);
  } else if (contentObjectDigest(marker.text) !== metadata.markerDigest) {
    output.push(`${tag} marker digest does not match its committed marker`);
  }
  const manifest = readCommittedFile(nextRoot, tag, "policy-root/protected-files.json");
  if (manifest.text === null) {
    output.push(manifest.finding ?? `${tag} protection manifest cannot be read`);
  } else if (contentObjectDigest(manifest.text) !== metadata.manifestDigest) {
    output.push(`${tag} manifest digest does not match its committed protection manifest`);
  }
  return Object.freeze(output);
}

export function resolveGovernanceBaseline(
  nextRoot: string,
  trustedBootstrapCommit: string = TRUSTED_BOOTSTRAP_COMMIT,
): GovernanceBaselineResolution {
  const findings: string[] = [];
  const bootstrapFinding = tagCommitExists(nextRoot, TRUSTED_BOOTSTRAP_TAG);
  if (bootstrapFinding !== null) {
    return Object.freeze({ baseline: null, findings: Object.freeze([bootstrapFinding]) });
  }
  const bootstrapCommit = runGit(nextRoot, ["rev-parse", "--verify", `${TRUSTED_BOOTSTRAP_TAG}^{commit}`]);
  if (
    bootstrapCommit.status !== 0
    || bootstrapCommit.stdout.trim() !== trustedBootstrapCommit
  ) {
    return Object.freeze({
      baseline: null,
      findings: Object.freeze([
        `${TRUSTED_BOOTSTRAP_TAG} must resolve exactly to pinned commit ${trustedBootstrapCommit}`,
      ]),
    });
  }

  const listed = runGit(nextRoot, ["tag", "--list", `${GOVERNANCE_BASELINE_PREFIX}*`]);
  if (listed.status !== 0) {
    return Object.freeze({
      baseline: null,
      findings: Object.freeze([`cannot enumerate governance baseline tags: ${gitFailure(listed)}`]),
    });
  }
  const tags = listed.stdout.split("\n").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  const numbered: { readonly tag: string; readonly number: number; readonly amendment: string }[] = [];
  for (const tag of tags) {
    const match = /^governance-baseline-([0-9]{3,})$/.exec(tag);
    if (match === null || match[1] === undefined) {
      findings.push(`malformed governance baseline tag is present: ${tag}`);
      continue;
    }
    numbered.push(Object.freeze({ tag, number: Number(match[1]), amendment: match[1] }));
  }
  numbered.sort((left, right) => left.number - right.number);

  let predecessor = TRUSTED_BOOTSTRAP_TAG;
  for (let index = 0; index < numbered.length; index += 1) {
    const entry = numbered[index];
    if (entry === undefined) {
      continue;
    }
    const expectedNumber = index + 1;
    const expectedAmendment = String(expectedNumber).padStart(3, "0");
    if (entry.number !== expectedNumber) {
      findings.push(`governance baseline succession must be contiguous; expected ${GOVERNANCE_BASELINE_PREFIX}${expectedAmendment}`);
    }
    findings.push(...validateGovernanceTag(nextRoot, entry.tag, expectedAmendment, predecessor));
    predecessor = entry.tag;
  }

  const latest = numbered[numbered.length - 1];
  const selected = latest === undefined
    ? Object.freeze({ tag: TRUSTED_BOOTSTRAP_TAG, amendment: null, predecessor: null })
    : Object.freeze({ tag: latest.tag, amendment: latest.amendment, predecessor: latest.number === 1
      ? TRUSTED_BOOTSTRAP_TAG
      : `${GOVERNANCE_BASELINE_PREFIX}${String(latest.number - 1).padStart(3, "0")}` });
  if (!isAncestor(nextRoot, selected.tag, "HEAD")) {
    findings.push(`selected governance baseline ${selected.tag} is not an ancestor of HEAD`);
  }
  return findings.length === 0
    ? Object.freeze({ baseline: selected, findings: Object.freeze([]) })
    : Object.freeze({ baseline: null, findings: Object.freeze(findings) });
}

export function nextGovernanceAmendment(baseline: GovernanceBaseline): string {
  const prior = baseline.amendment === null ? 0 : Number(baseline.amendment);
  return String(prior + 1).padStart(3, "0");
}
