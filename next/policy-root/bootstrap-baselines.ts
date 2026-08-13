import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { protocolCapsules } from "../authority/protocol/aggregate.generated.js";
import { portContractCapsules } from "../ports/contracts/aggregate.generated.js";
import { currentFingerprintManifest } from "./fingerprint-checker.js";
import { contentDigest } from "./protection-checker.js";

const invokedWithApproval = process.argv.includes("--approved-amendment")
  && process.env["PI_AUTOPILOT_ARCHITECTURE_AMENDMENT_APPROVED"] === "1";
if (!invokedWithApproval) {
  process.stderr.write("baseline regeneration requires --approved-amendment and protected CI approval\n");
  process.exitCode = 2;
} else {

const modulePolicyRoot = dirname(fileURLToPath(import.meta.url));
const moduleParent = dirname(modulePolicyRoot);
const nextRoot = basename(moduleParent) === "dist-policy" ? dirname(moduleParent) : moduleParent;

const protectedPaths = Object.freeze([
  "authority/tsconfig.json",
  "package.json",
  "policy-root/architecture-checker.ts",
  "policy-root/bootstrap-baselines.ts",
  "policy-root/fingerprint-checker.ts",
  "policy-root/gate-self-tests.ts",
  "policy-root/generate-aggregates.ts",
  "policy-root/hygiene-checker.ts",
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
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.policy.json",
  "tsconfig.tests.json",
]);

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const fingerprints = currentFingerprintManifest(Object.freeze([
  ...protocolCapsules,
  ...portContractCapsules,
]));
writeFileSync(
  join(nextRoot, "policy-root", "protocol-fingerprints.json"),
  pretty(fingerprints),
  "utf8",
);

const files: Record<string, string> = Object.create(null);
for (const path of protectedPaths) {
  files[path] = contentDigest(readFileSync(join(nextRoot, path), "utf8"));
}
const unsignedManifest = pretty({ format: 1, files });
files["policy-root/protected-files.json"] = contentDigest(unsignedManifest);
writeFileSync(
  join(nextRoot, "policy-root", "protected-files.json"),
  pretty({ format: 1, files }),
  "utf8",
);
}
