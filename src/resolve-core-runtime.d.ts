export type CoreInstallErrorCode = "metadata" | "escape" | "unsupported-platform" | "missing-wrapper" | "missing-binary" | "symlink" | "not-regular-file" | "not-readable" | "not-executable";
export type SupportedCorePlatformKey = string;
export interface ResolveCoreRuntimeOptions {
  readonly packageJsonPath?: string;
  readonly platform?: NodeJS.Platform | string;
  readonly arch?: NodeJS.Architecture | string;
}
export interface RunnerResolution {
  readonly nodeExecutable: string;
  readonly runnerWrapper: string;
  readonly childAddon: string;
}
export class CoreInstallError extends Error {
  readonly code: CoreInstallErrorCode;
  readonly platformKey?: string;
  readonly path?: string;
  constructor(message: string, code?: CoreInstallErrorCode, platformKey?: string, path?: string);
}
export const CORE_BIN_ENTRY: "bin/autopilot-core.mjs";
export const AGENT_RUNNER_BIN_ENTRY: "bin/autopilot-agent-run.mjs";
export const CHILD_ADDON_ENTRY: "src/generated/child-extension.ts";
export const SUPPORTED_CORE_BINARIES: Readonly<Record<SupportedCorePlatformKey, string>>;
export function corePlatformKey(options?: Pick<ResolveCoreRuntimeOptions, "platform" | "arch">): string;
export function resolveCoreWrapper(options?: Pick<ResolveCoreRuntimeOptions, "packageJsonPath">): string;
export function resolveAgentRunner(options?: Pick<ResolveCoreRuntimeOptions, "packageJsonPath">): string;
export function resolveRunnerTransport(options?: Pick<ResolveCoreRuntimeOptions, "packageJsonPath">): RunnerResolution;
export function resolveCoreBinary(options?: ResolveCoreRuntimeOptions): string;
