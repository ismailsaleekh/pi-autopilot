import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolveCoreOptions {
  packageJsonPath?: string;
}

export class CoreInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreInstallError";
  }
}

export function resolveCoreBinary(options: ResolveCoreOptions = {}): string {
  const packageJsonPath = options.packageJsonPath ?? defaultPackageJsonPath();
  const metadata = readPackageMetadata(packageJsonPath);
  const bin = metadata.bin;
  if (!isRecord(bin)) {
    throw installError(packageJsonPath, "package.json has no bin map");
  }
  const entry = bin["autopilot-core"];
  if (typeof entry !== "string" || entry.length === 0) {
    throw installError(packageJsonPath, "package.json bin.autopilot-core is absent");
  }
  const candidate = isAbsolute(entry) ? entry : resolve(dirname(packageJsonPath), entry);
  try {
    accessSync(candidate, constants.X_OK);
  } catch (error) {
    throw installError(
      packageJsonPath,
      `package.json bin.autopilot-core points to unavailable binary ${candidate}: ${errorMessage(error)}`,
    );
  }
  return candidate;
}

function defaultPackageJsonPath(): string {
  return fileURLToPath(new URL("../package.json", import.meta.url));
}

function readPackageMetadata(packageJsonPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (isRecord(parsed)) {
      return parsed;
    }
    throw new CoreInstallError(`package metadata at ${packageJsonPath} is not a JSON object`);
  } catch (error) {
    if (error instanceof CoreInstallError) {
      throw error;
    }
    throw installError(packageJsonPath, errorMessage(error));
  }
}

function installError(packageJsonPath: string, detail: string): CoreInstallError {
  return new CoreInstallError(
    `autopilot-core is not installed (${detail}). Reinstall pi-autopilot or run cargo build -p drivers --release so the package.json bin entry is present. package=${packageJsonPath}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
