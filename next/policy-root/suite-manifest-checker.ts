import { existsSync, readFileSync } from "node:fs";

export interface SuiteRegistration {
  readonly id: string;
  readonly owner: string;
  readonly registration: "pending" | "registered";
  readonly command?: string;
}

export interface SuiteManifest {
  readonly format: 1;
  readonly suites: readonly SuiteRegistration[];
}

export interface SuiteManifestFinding {
  readonly suite: string;
  readonly detail: string;
}

export interface RegisteredSuiteCommand {
  readonly id: string;
  readonly command: string;
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

function hasOnlyRegistrationKeys(value: UnknownObject): boolean {
  const allowed = new Set(["command", "id", "owner", "registration"]);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function decodeSuiteManifest(value: unknown): SuiteManifest | null {
  if (!isObject(value) || value["format"] !== 1 || !Array.isArray(value["suites"])) {
    return null;
  }
  if (Object.keys(value).some((key) => key !== "format" && key !== "suites")) {
    return null;
  }
  const suites: SuiteRegistration[] = [];
  for (const entry of value["suites"]) {
    if (
      !isObject(entry)
      || !hasOnlyRegistrationKeys(entry)
      || typeof entry["id"] !== "string"
      || typeof entry["owner"] !== "string"
      || (entry["registration"] !== "pending" && entry["registration"] !== "registered")
    ) {
      return null;
    }
    if (entry["registration"] === "registered") {
      if (typeof entry["command"] !== "string" || entry["command"].trim().length === 0) {
        return null;
      }
      suites.push(Object.freeze({
        id: entry["id"],
        owner: entry["owner"],
        registration: "registered",
        command: entry["command"],
      }));
    } else {
      if (entry["command"] !== undefined) {
        return null;
      }
      suites.push(Object.freeze({
        id: entry["id"],
        owner: entry["owner"],
        registration: "pending",
      }));
    }
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
    if (suite.registration === "registered" && (suite.command === undefined || suite.command.trim().length === 0)) {
      output.push(Object.freeze({ suite: suite.id, detail: "registered suite requires a non-empty command" }));
    }
    if (suite.registration === "pending" && suite.command !== undefined) {
      output.push(Object.freeze({ suite: suite.id, detail: "pending suite forbids a command" }));
    }
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

export function registeredSuiteCommands(
  manifest: SuiteManifest,
): readonly RegisteredSuiteCommand[] {
  return Object.freeze(manifest.suites
    .filter((suite): suite is SuiteRegistration & { readonly command: string } => (
      suite.registration === "registered" && suite.command !== undefined
    ))
    .map((suite) => Object.freeze({ id: suite.id, command: suite.command })));
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
