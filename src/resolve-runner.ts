import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolveRunnerOptions {
  packageJsonPath?: string;
}

export type RunnerInstallErrorCode = "metadata" | "missing-wrapper" | "symlink" | "not-regular-file" | "not-readable";

export class RunnerInstallError extends Error {
  readonly code: RunnerInstallErrorCode;
  readonly path?: string;

  constructor(message: string, code: RunnerInstallErrorCode = "metadata", path?: string) {
    super(message);
    this.name = "RunnerInstallError";
    this.code = code;
    this.path = path;
  }
}

export interface RunnerResolution {
  readonly nodeExecutable: string;
  readonly runnerWrapper: string;
}

export function resolveAgentRunner(options: ResolveRunnerOptions = {}): string {
  const packageJsonPath = options.packageJsonPath ?? defaultPackageJsonPath();
  const packageRoot = dirname(packageJsonPath);
  const metadata = readPackageMetadata(packageJsonPath);
  const bin = metadata.bin;
  if (!isRecord(bin)) throw installError(packageJsonPath, "package.json has no bin map");
  const entry = bin["autopilot-agent-run"];
  if (entry !== "bin/autopilot-agent-run.mjs") {
    throw installError(packageJsonPath, `package.json bin.autopilot-agent-run must point to bin/autopilot-agent-run.mjs, got ${String(entry)}`);
  }
  const candidate = resolve(packageRoot, entry);
  assertInside(packageRoot, candidate, packageJsonPath);
  assertReadableRegularFile(candidate, packageJsonPath);
  return candidate;
}

export function resolveRunnerTransport(options: ResolveRunnerOptions = {}): RunnerResolution {
  return {
    nodeExecutable: process.execPath,
    runnerWrapper: resolveAgentRunner(options),
  };
}

function defaultPackageJsonPath(): string {
  return fileURLToPath(new URL("../package.json", import.meta.url));
}

function readPackageMetadata(packageJsonPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (isRecord(parsed)) return parsed;
    throw new RunnerInstallError(`package metadata at ${packageJsonPath} is not a JSON object`, "metadata", packageJsonPath);
  } catch (error) {
    if (error instanceof RunnerInstallError) throw error;
    throw installError(packageJsonPath, errorMessage(error));
  }
}

function assertInside(root: string, candidate: string, packageJsonPath: string): void {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(normalizedRoot)) {
    throw installError(packageJsonPath, `autopilot-agent-run wrapper escapes package root: ${candidate}`);
  }
}

function assertReadableRegularFile(candidate: string, packageJsonPath: string): void {
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    throw installError(packageJsonPath, `autopilot-agent-run wrapper is missing: ${candidate}: ${errorMessage(error)}`, "missing-wrapper", candidate);
  }
  if (stat.isSymbolicLink()) {
    throw installError(packageJsonPath, `autopilot-agent-run wrapper must not be a symlink: ${candidate}`, "symlink", candidate);
  }
  if (!stat.isFile()) {
    throw installError(packageJsonPath, `autopilot-agent-run wrapper must be a regular file: ${candidate}`, "not-regular-file", candidate);
  }
  try {
    accessSync(candidate, constants.R_OK);
  } catch (error) {
    throw installError(packageJsonPath, `autopilot-agent-run wrapper is not readable: ${candidate}: ${errorMessage(error)}`, "not-readable", candidate);
  }
}

function installError(packageJsonPath: string, detail: string, code: RunnerInstallErrorCode = "metadata", path?: string): RunnerInstallError {
  return new RunnerInstallError(`autopilot-agent-run is not installed (${detail}). Reinstall pi-autopilot. package=${packageJsonPath}`, code, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
