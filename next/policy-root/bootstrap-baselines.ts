import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { protocolCapsules } from "../authority/protocol/aggregate.generated.js";
import { portContractCapsules } from "../ports/contracts/aggregate.generated.js";
import { currentFingerprintManifest } from "./fingerprint-checker.js";
import { contentDigest } from "./protection-checker.js";

const modulePolicyRoot = dirname(fileURLToPath(import.meta.url));
const moduleParent = dirname(modulePolicyRoot);
const nextRoot = basename(moduleParent) === "dist-policy" ? dirname(moduleParent) : moduleParent;

const protectedPaths = Object.freeze([
  "policy-root/architecture-checker.ts",
  "policy-root/fingerprint-checker.ts",
  "policy-root/gate-self-tests.ts",
  "policy-root/protocol-fingerprints.json",
  "policy-root/protection-checker.ts",
  "policy-root/required-suites.json",
  "policy-root/suite-manifest-checker.ts",
  "policy-root/suppression-checker.ts",
  "tsconfig.base.json",
  "authority/tsconfig.json",
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
writeFileSync(
  join(nextRoot, "policy-root", "protected-files.json"),
  pretty({ format: 1, files }),
  "utf8",
);
