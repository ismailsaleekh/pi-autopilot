import { join } from "node:path";
import { protocolCapsules } from "../authority/protocol/aggregate.generated.js";
import { portContractCapsules } from "../ports/contracts/aggregate.generated.js";
import {
  checkArchitecture,
  formatArchitectureFinding,
} from "./architecture-checker.js";
import {
  activeAmendmentMarkers,
  checkFingerprintChange,
  currentFingerprintManifest,
  readFingerprintManifest,
} from "./fingerprint-checker.js";
import { checkHygiene } from "./hygiene-checker.js";
import { checkPayloadShapes } from "./payload-checker.js";
import { checkRepositoryProtection } from "./protection-checker.js";
import { checkSuiteManifest, readSuiteManifest } from "./suite-manifest-checker.js";
import { checkSuppressions, formatSuppressionFinding } from "./suppression-checker.js";

export interface PolicySummary {
  readonly architectureFindings: number;
  readonly suppressionFindings: number;
  readonly fingerprintFindings: number;
  readonly protectionFindings: number;
  readonly suiteFindings: number;
  readonly hygieneFindings: number;
  readonly payloadFindings: number;
}

export function runPolicy(nextRoot: string): PolicySummary {
  const architecture = checkArchitecture(nextRoot);
  for (const finding of architecture) {
    process.stderr.write(`${formatArchitectureFinding(finding)}\n`);
  }

  const suppressions = checkSuppressions(nextRoot);
  for (const finding of suppressions) {
    process.stderr.write(`${formatSuppressionFinding(finding)}\n`);
  }

  const expectedFingerprints = readFingerprintManifest(
    join(nextRoot, "policy-root", "protocol-fingerprints.json"),
  );
  const actualFingerprints = currentFingerprintManifest(Object.freeze([
    ...protocolCapsules,
    ...portContractCapsules,
  ]));
  const amendmentMarkers = activeAmendmentMarkers(nextRoot);
  const fingerprintFindings = expectedFingerprints === null
    ? Object.freeze([Object.freeze({
        capsule: "policy-root/protocol-fingerprints.json",
        detail: "fingerprint baseline is missing or malformed",
      })])
    : checkFingerprintChange(
        expectedFingerprints,
        actualFingerprints,
        amendmentMarkers,
      );
  for (const finding of fingerprintFindings) {
    process.stderr.write(`fingerprint ${finding.capsule}: ${finding.detail}\n`);
  }

  const protections = checkRepositoryProtection(nextRoot);
  for (const finding of protections) {
    process.stderr.write(`protection ${finding.path}: ${finding.detail}\n`);
  }

  const hygiene = checkHygiene(nextRoot);
  for (const finding of hygiene) {
    process.stderr.write(`hygiene ${finding.path}:${String(finding.line)} ${finding.detail}\n`);
  }

  const payloads = checkPayloadShapes(nextRoot);
  for (const finding of payloads) {
    process.stderr.write(`payload ${finding.path}:${String(finding.line)} ${finding.detail}\n`);
  }

  const suiteManifest = readSuiteManifest(join(nextRoot, "policy-root", "required-suites.json"));
  const suites = suiteManifest === null
    ? Object.freeze([Object.freeze({
        suite: "policy-root/required-suites.json",
        detail: "suite manifest is missing or malformed",
      })])
    : checkSuiteManifest(suiteManifest, false);
  for (const finding of suites) {
    process.stderr.write(`required-suite ${finding.suite}: ${finding.detail}\n`);
  }

  return Object.freeze({
    architectureFindings: architecture.length,
    suppressionFindings: suppressions.length,
    fingerprintFindings: fingerprintFindings.length,
    protectionFindings: protections.length,
    suiteFindings: suites.length,
    hygieneFindings: hygiene.length,
    payloadFindings: payloads.length,
  });
}
