import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolveCoreOptions {
  packageJsonPath?: string;
  platform?: NodeJS.Platform | string;
  arch?: NodeJS.Architecture | string;
}

export type CoreInstallErrorCode = "metadata" | "unsupported-platform" | "missing-binary" | "symlink" | "not-regular-file" | "not-executable";

export class CoreInstallError extends Error {
  readonly code: CoreInstallErrorCode;
  readonly platformKey?: string;

  constructor(message: string, code: CoreInstallErrorCode = "metadata", platformKey?: string) {
    super(message);
    this.name = "CoreInstallError";
    this.code = code;
    this.platformKey = platformKey;
  }
}

const SUPPORTED_BINARIES = Object.freeze({
  "darwin-arm64": "autopilot-core",
  "darwin-x64": "autopilot-core",
  "linux-x64": "autopilot-core",
  "linux-arm64": "autopilot-core",
  "win32-x64": "autopilot-core.exe",
} as const);

type SupportedPlatformKey = keyof typeof SUPPORTED_BINARIES;

export function resolveCoreBinary(options: ResolveCoreOptions = {}): string {
  const packageJsonPath = options.packageJsonPath ?? defaultPackageJsonPath();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformKey = `${platform}-${arch}`;
  const binaryName = SUPPORTED_BINARIES[platformKey as SupportedPlatformKey];
  if (binaryName === undefined) {
    throw new CoreInstallError(
      `autopilot-core unsupported platform ${platformKey}. Supported platforms: ${Object.keys(SUPPORTED_BINARIES).join(", ")}`,
      "unsupported-platform",
      platformKey,
    );
  }

  assertPackageDeclaresResolver(packageJsonPath);
  const candidate = join(dirname(packageJsonPath), "binaries", platformKey, binaryName);
  assertExecutableRegularFile(candidate, platformKey);
  return candidate;
}

export function corePlatformKey(options: Pick<ResolveCoreOptions, "platform" | "arch"> = {}): string {
  return `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
}

function assertExecutableRegularFile(candidate: string, platformKey: string): void {
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    throw new CoreInstallError(
      `autopilot-core binary missing for ${platformKey}: ${candidate}: ${errorMessage(error)}`,
      "missing-binary",
      platformKey,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new CoreInstallError(
      `autopilot-core binary for ${platformKey} must not be a symlink: ${candidate}`,
      "symlink",
      platformKey,
    );
  }
  if (!stat.isFile()) {
    throw new CoreInstallError(
      `autopilot-core binary for ${platformKey} must be a regular file: ${candidate}`,
      "not-regular-file",
      platformKey,
    );
  }
  try {
    accessSync(candidate, constants.X_OK);
  } catch (error) {
    throw new CoreInstallError(
      `autopilot-core binary for ${platformKey} is not executable: ${candidate}: ${errorMessage(error)}`,
      "not-executable",
      platformKey,
    );
  }
}

function defaultPackageJsonPath(): string {
  return fileURLToPath(new URL("../package.json", import.meta.url));
}

function assertPackageDeclaresResolver(packageJsonPath: string): void {
  const metadata = readPackageMetadata(packageJsonPath);
  const bin = metadata.bin;
  if (!isRecord(bin)) {
    throw installError(packageJsonPath, "package.json has no bin map");
  }
  const entry = bin["autopilot-core"];
  if (typeof entry !== "string" || entry.length === 0) {
    throw installError(packageJsonPath, "package.json bin.autopilot-core is absent");
  }
  if (entry !== "bin/autopilot-core.mjs") {
    throw installError(packageJsonPath, `package.json bin.autopilot-core must point to bin/autopilot-core.mjs, got ${entry}`);
  }
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
    `autopilot-core is not installed (${detail}). Reinstall pi-autopilot. package=${packageJsonPath}`,
    "metadata",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
