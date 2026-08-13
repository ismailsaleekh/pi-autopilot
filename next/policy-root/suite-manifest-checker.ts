import { existsSync, readFileSync } from "node:fs";

export interface SuiteRegistration {
  readonly id: string;
  readonly owner: string;
  readonly registration: "pending" | "registered";
}

export interface SuiteManifest {
  readonly format: 1;
  readonly suites: readonly SuiteRegistration[];
}

export interface SuiteManifestFinding {
  readonly suite: string;
  readonly detail: string;
}

interface UnknownObject {
  readonly [key: string]: unknown;
}

export const REQUIRED_SUITE_IDS = Object.freeze([
  "D2.1-replay-determinism",
  "D2.2-full-run-scenarios",
  "D2.3-crash-matrix",
  "D2.4-third-outcome-hunt",
  "D2.5-idempotency",
  "D2.6-totality-fuzzing",
  "D2.7-yardstick-properties",
  "D3.1-adapter-contract-parity",
  "D3.2-journal-durability",
  "D3.3-real-git",
  "D3.4-process-reality",
  "D3.5-sandbox",
  "D3.6-scale",
  "D3.7-real-pi",
  "D3.8-w0-replay-corpus",
]);

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeSuiteManifest(value: unknown): SuiteManifest | null {
  if (!isObject(value) || value["format"] !== 1 || !Array.isArray(value["suites"])) {
    return null;
  }
  const suites: SuiteRegistration[] = [];
  for (const entry of value["suites"]) {
    if (
      !isObject(entry)
      || typeof entry["id"] !== "string"
      || typeof entry["owner"] !== "string"
      || (entry["registration"] !== "pending" && entry["registration"] !== "registered")
    ) {
      return null;
    }
    suites.push(Object.freeze({
      id: entry["id"],
      owner: entry["owner"],
      registration: entry["registration"],
    }));
  }
  return Object.freeze({ format: 1, suites: Object.freeze(suites) });
}

export function checkSuiteManifest(
  manifest: SuiteManifest,
  requireRegistered: boolean,
): readonly SuiteManifestFinding[] {
  const output: SuiteManifestFinding[] = [];
  const byId = new Map<string, SuiteRegistration>();
  for (const suite of manifest.suites) {
    if (byId.has(suite.id)) {
      output.push(Object.freeze({ suite: suite.id, detail: "duplicate suite registration" }));
    }
    byId.set(suite.id, suite);
  }
  for (const requiredId of REQUIRED_SUITE_IDS) {
    const suite = byId.get(requiredId);
    if (suite === undefined) {
      output.push(Object.freeze({ suite: requiredId, detail: "required D2/D3 suite is missing" }));
    } else if (suite.owner.length === 0) {
      output.push(Object.freeze({ suite: requiredId, detail: "suite owner is empty" }));
    } else if (requireRegistered && suite.registration !== "registered") {
      output.push(Object.freeze({ suite: requiredId, detail: "suite is pending or skipped after registration became mandatory" }));
    }
  }
  for (const id of byId.keys()) {
    if (!REQUIRED_SUITE_IDS.includes(id)) {
      output.push(Object.freeze({ suite: id, detail: "unknown suite entry requires policy-root amendment" }));
    }
  }
  return Object.freeze(output);
}

export function readSuiteManifest(path: string): SuiteManifest | null {
  if (!existsSync(path)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return decodeSuiteManifest(value);
}
