import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { CoreInstallError, resolveAgentRunner, resolveCoreBinary } from "../src/resolve-core.ts";

const SOURCE_HASH = "a".repeat(64);

function writePackage(root: string, platformKey = "darwin-arm64", binaryName = "autopilot-core") {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "generated"), { recursive: true });
  writeFileSync(join(root, "bin", "autopilot-core.mjs"), "#!/usr/bin/env node\n");
  writeFileSync(join(root, "bin", "autopilot-agent-run.mjs"), "#!/usr/bin/env node\n");
  writeFileSync(join(root, "src", "generated", "child-extension.ts"), "export {};\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", bin: { "autopilot-core": "bin/autopilot-core.mjs", "autopilot-agent-run": "bin/autopilot-agent-run.mjs" } }));
  const binary = join(root, "binaries", platformKey, binaryName);
  let bytes: Buffer;
  try { bytes = readFileSync(binary); } catch { bytes = Buffer.alloc(0); }
  writeFileSync(join(root, "binaries", "MANIFEST.json"), JSON.stringify({ schema: 1, source: { hash: SOURCE_HASH }, binaries: { [platformKey]: { path: `binaries/${platformKey}/${binaryName}`, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, sourceHash: SOURCE_HASH } } }));
}

function executableBinary(root: string, platformKey = "darwin-arm64", binaryName = "autopilot-core") {
  const binDir = join(root, "binaries", platformKey);
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, binaryName);
  writeFileSync(binary, "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(binary, 0o755);
  return binary;
}

test("core binary resolves through packaged platform binary and manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-bin-resolution-"));
  const binary = executableBinary(dir);
  writePackage(dir);
  assert.equal(resolveCoreBinary({ packageJsonPath: join(dir, "package.json"), platform: "darwin", arch: "arm64" }), binary);
});

test("agent runner resolves only the package-contained declared wrapper", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-runner-resolution-"));
  executableBinary(dir);
  writePackage(dir);
  assert.equal(resolveAgentRunner({ packageJsonPath: join(dir, "package.json") }), join(dir, "bin", "autopilot-agent-run.mjs"));
});

test("core binary rejects symlink and directory payloads with typed install errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-core-typed-reject-"));
  mkdirSync(join(dir, "binaries", "darwin-arm64"), { recursive: true });
  symlinkSync(join(dir, "package.json"), join(dir, "binaries", "darwin-arm64", "autopilot-core"));
  writePackage(dir);
  assert.throws(
    () => resolveCoreBinary({ packageJsonPath: join(dir, "package.json"), platform: "darwin", arch: "arm64" }),
    (error) => error instanceof CoreInstallError && error.code === "symlink" && /must not be a symlink/u.test(error.message),
  );

  const dirPayloadRoot = mkdtempSync(join(tmpdir(), "autopilot-core-directory-reject-"));
  mkdirSync(join(dirPayloadRoot, "binaries", "linux-x64", "autopilot-core"), { recursive: true });
  writePackage(dirPayloadRoot, "linux-x64");
  assert.throws(
    () => resolveCoreBinary({ packageJsonPath: join(dirPayloadRoot, "package.json"), platform: "linux", arch: "x64" }),
    (error) => error instanceof CoreInstallError && error.code === "not-regular-file" && /regular file/u.test(error.message),
  );
});

test("agent runner rejects symlink, escape, and missing bin declarations", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-runner-reject-"));
  executableBinary(dir);
  writePackage(dir);
  const packageJsonPath = join(dir, "package.json");
  writeFileSync(packageJsonPath, JSON.stringify({ name: "fixture", bin: { "autopilot-core": "bin/autopilot-core.mjs", "autopilot-agent-run": "../escape.mjs" } }));
  assert.throws(() => resolveAgentRunner({ packageJsonPath }), /bin\.autopilot-agent-run/u);

  writePackage(dir);
  rmFile(join(dir, "bin", "autopilot-agent-run.mjs"));
  symlinkSync(packageJsonPath, join(dir, "bin", "autopilot-agent-run.mjs"));
  assert.throws(
    () => resolveAgentRunner({ packageJsonPath }),
    (error) => error instanceof CoreInstallError && error.code === "symlink" && /must not be a symlink/u.test(error.message),
  );

  const dirPayloadRoot = mkdtempSync(join(tmpdir(), "autopilot-runner-directory-reject-"));
  executableBinary(dirPayloadRoot);
  writePackage(dirPayloadRoot);
  rmFile(join(dirPayloadRoot, "bin", "autopilot-agent-run.mjs"));
  mkdirSync(join(dirPayloadRoot, "bin", "autopilot-agent-run.mjs"), { recursive: true });
  assert.throws(
    () => resolveAgentRunner({ packageJsonPath: join(dirPayloadRoot, "package.json") }),
    (error) => error instanceof CoreInstallError && error.code === "not-regular-file" && /regular file/u.test(error.message),
  );

  writeFileSync(packageJsonPath, JSON.stringify({ name: "fixture", bin: { "autopilot-core": "bin/autopilot-core.mjs" } }));
  assert.throws(() => resolveAgentRunner({ packageJsonPath }), /bin\.autopilot-agent-run/u);
});

test("host source has no derived path fallback", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.bin["autopilot-core"], "bin/autopilot-core.mjs");
  assert.equal(packageJson.bin["autopilot-agent-run"], "bin/autopilot-agent-run.mjs");
  for (const file of sourceFiles(new URL("../src/", import.meta.url))) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("dist/"), false, `${file} contains a forbidden dist path`);
    assert.equal(text.includes("target/"), false, `${file} contains a forbidden target path`);
  }
});

function rmFile(path: string): void {
  try { unlinkSync(path); } catch {}
}

function sourceFiles(root: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const url = new URL(entry.name, root);
    if (entry.isDirectory()) out.push(...sourceFiles(new URL(`${entry.name}/`, root)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(url.pathname);
  }
  return out;
}
