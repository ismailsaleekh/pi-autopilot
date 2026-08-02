import * as runtime from "./resolve-core-runtime.js";

export interface ResolveCoreOptions {
  packageJsonPath?: string;
  platform?: NodeJS.Platform | string;
  arch?: NodeJS.Architecture | string;
}

export type CoreInstallErrorCode = "metadata" | "escape" | "unsupported-platform" | "missing-wrapper" | "missing-binary" | "symlink" | "not-regular-file" | "not-readable" | "not-executable";
export type SupportedCorePlatformKey = string;
export interface RunnerResolution { readonly nodeExecutable: string; readonly runnerWrapper: string; readonly childAddon: string; }
export const CORE_BIN_ENTRY: "bin/autopilot-core.mjs" = runtime.CORE_BIN_ENTRY;
export const AGENT_RUNNER_BIN_ENTRY: "bin/autopilot-agent-run.mjs" = runtime.AGENT_RUNNER_BIN_ENTRY;
export const CHILD_ADDON_ENTRY: "src/generated/child-extension.ts" = runtime.CHILD_ADDON_ENTRY;
export const SUPPORTED_CORE_BINARIES: Readonly<Record<SupportedCorePlatformKey, string>> = runtime.SUPPORTED_CORE_BINARIES;
export const CoreInstallError: { new(message: string, code?: CoreInstallErrorCode, platformKey?: string, path?: string): Error & { code: CoreInstallErrorCode; platformKey?: string; path?: string } } = runtime.CoreInstallError;
export const corePlatformKey: (options?: Pick<ResolveCoreOptions, "platform" | "arch">) => string = runtime.corePlatformKey;
export const resolveCoreWrapper: (options?: Pick<ResolveCoreOptions, "packageJsonPath">) => string = runtime.resolveCoreWrapper;
export const resolveCoreBinary: (options?: ResolveCoreOptions) => string = runtime.resolveCoreBinary;
export const resolveAgentRunner: (options?: Pick<ResolveCoreOptions, "packageJsonPath">) => string = runtime.resolveAgentRunner;
export const resolveRunnerTransport: (options?: Pick<ResolveCoreOptions, "packageJsonPath">) => RunnerResolution = runtime.resolveRunnerTransport;
