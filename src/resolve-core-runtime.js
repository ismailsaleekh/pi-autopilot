import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export class CoreInstallError extends Error {
  constructor(message, code = "metadata", platformKey = undefined, path = undefined) {
    super(message); this.name = "CoreInstallError"; this.code = code; this.platformKey = platformKey; this.path = path;
  }
}
export const CORE_BIN_ENTRY = "bin/autopilot-core.mjs";
export const AGENT_RUNNER_BIN_ENTRY = "bin/autopilot-agent-run.mjs";
export const CHILD_ADDON_ENTRY = "src/generated/child-extension.ts";
export const SUPPORTED_CORE_BINARIES = Object.freeze({
  "darwin-arm64": "autopilot-core", "darwin-x64": "autopilot-core", "linux-arm64": "autopilot-core", "linux-x64": "autopilot-core", "win32-x64": "autopilot-core.exe",
});

export function corePlatformKey(options = {}) { return `${options.platform ?? process.platform}-${options.arch ?? process.arch}`; }
export function resolveCoreWrapper(options = {}) { return context(options).coreWrapper; }
export function resolveAgentRunner(options = {}) { return context(options).agentWrapper; }
export function resolveRunnerTransport(options = {}) {
  const c = context(options);
  return { nodeExecutable: process.execPath, runnerWrapper: c.agentWrapper, childAddon: c.childAddon };
}
export function resolveCoreBinary(options = {}) {
  const c = context(options), platformKey = corePlatformKey(options), name = SUPPORTED_CORE_BINARIES[platformKey];
  if (name === undefined) throw new CoreInstallError(`autopilot-core unsupported platform ${platformKey}. Supported platforms: ${Object.keys(SUPPORTED_CORE_BINARIES).join(", ")}`, "unsupported-platform", platformKey);
  const binary = resolve(c.root, "binaries", platformKey, name); inside(c.root, binary, c.packageJsonPath, `autopilot-core binary for ${platformKey}`, "escape");
  const stat = file(binary, c.packageJsonPath, `autopilot-core binary for ${platformKey}`, "missing-binary", constants.R_OK | constants.X_OK, platformKey);
  const manifestPath = join(c.root, "binaries", "MANIFEST.json"), manifest = json(manifestPath, c.packageJsonPath);
  const source = record(manifest.source, manifestPath, "source"), rows = record(manifest.binaries, manifestPath, "binaries"), row = record(rows[platformKey], manifestPath, `binaries.${platformKey}`);
  const rel = relative(c.root, binary).replaceAll("\\", "/"), sha = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (manifest.schema !== 1) bad(c.packageJsonPath, `binaries/MANIFEST.json schema must be 1, got ${String(manifest.schema)}`);
  if (row.path !== rel) bad(c.packageJsonPath, `manifest path mismatch for ${platformKey}: recorded ${String(row.path)}, current ${rel}`, "metadata", binary);
  if (row.sizeBytes !== stat.size) bad(c.packageJsonPath, `manifest sizeBytes mismatch for ${platformKey}: recorded ${String(row.sizeBytes)}, current ${stat.size}`, "metadata", binary);
  if (row.sha256 !== sha) bad(c.packageJsonPath, `manifest sha256 mismatch for ${platformKey}: recorded ${String(row.sha256)}, current ${sha}`, "metadata", binary);
  if (typeof source.hash !== "string" || source.hash.length === 0 || row.sourceHash !== source.hash) bad(c.packageJsonPath, `manifest sourceHash mismatch for ${platformKey}: recorded ${String(row.sourceHash)}, manifest source.hash ${String(source.hash)}`);
  return binary;
}

function context(options) {
  const packageJsonPath = options.packageJsonPath ?? fileURLToPath(new URL("../package.json", import.meta.url)), root = dirname(packageJsonPath), pkg = json(packageJsonPath, packageJsonPath);
  const core = bin(pkg, packageJsonPath, root, "autopilot-core", CORE_BIN_ENTRY), agent = bin(pkg, packageJsonPath, root, "autopilot-agent-run", AGENT_RUNNER_BIN_ENTRY);
  const childAddon = resolve(root, CHILD_ADDON_ENTRY); inside(root, childAddon, packageJsonPath, "autopilot child add-on", "escape"); file(childAddon, packageJsonPath, "autopilot child add-on", "missing-wrapper", constants.R_OK);
  return { packageJsonPath, root, coreWrapper: core, agentWrapper: agent, childAddon };
}
function bin(pkg, packageJsonPath, root, command, expected) {
  const bins = record(pkg.bin, packageJsonPath, "bin"), entry = bins[command];
  if (entry !== expected) bad(packageJsonPath, `package.json bin.${command} must point to ${expected}, got ${String(entry)}`);
  const path = resolve(root, entry); inside(root, path, packageJsonPath, `bin.${command}`, "escape"); file(path, packageJsonPath, `${command} wrapper`, "missing-wrapper", constants.R_OK); return path;
}
function file(path, packageJsonPath, label, missingCode, accessMode, platformKey = undefined) {
  let stat; try { stat = lstatSync(path); } catch (e) { throw err(packageJsonPath, `${label} is missing: ${path}: ${msg(e)}`, missingCode, platformKey, path); }
  if (stat.isSymbolicLink()) throw err(packageJsonPath, `${label} must not be a symlink: ${path}`, "symlink", platformKey, path);
  if (!stat.isFile()) throw err(packageJsonPath, `${label} must be a regular file: ${path}`, "not-regular-file", platformKey, path);
  try { accessSync(path, accessMode); } catch (e) { const x = Boolean(accessMode & constants.X_OK); throw err(packageJsonPath, `${label} is not ${x ? "executable" : "readable"}: ${path}: ${msg(e)}`, x ? "not-executable" : "not-readable", platformKey, path); }
  return stat;
}
function inside(root, candidate, packageJsonPath, label, code) {
  const rel = relative(root, candidate); if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  bad(packageJsonPath, `${label} escapes package root: ${candidate}`, code, candidate);
}
function json(path, packageJsonPath) { try { return record(JSON.parse(readFileSync(path, "utf8")), path, "root"); } catch (e) { if (e instanceof CoreInstallError) throw e; return bad(packageJsonPath, `${path} is not readable JSON: ${msg(e)}`, "metadata", path); } }
function record(value, path, label) { if (typeof value === "object" && value !== null && !Array.isArray(value)) return value; throw new CoreInstallError(`${path} ${label} must be a JSON object`); }
function bad(packageJsonPath, detail, code = "metadata", path = undefined) { throw err(packageJsonPath, detail, code, undefined, path); }
function err(packageJsonPath, detail, code, platformKey, path) { return new CoreInstallError(`autopilot-core is not installed (${detail}). Reinstall pi-autopilot. package=${packageJsonPath}`, code, platformKey, path); }
function msg(error) { return error instanceof Error ? error.message : String(error); }
