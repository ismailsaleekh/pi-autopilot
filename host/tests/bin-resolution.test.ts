import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { CoreInstallError, resolveCoreBinary } from "../src/resolve-core.ts";
import { resolveAgentRunner, RunnerInstallError } from "../src/resolve-runner.ts";

test("core binary resolves through packaged platform binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-bin-resolution-"));
  const binDir = join(dir, "binaries", "darwin-arm64");
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, "autopilot-core");
  writeFileSync(binary, "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(binary, 0o755);
  const packageJsonPath = join(dir, "package.json");
  writeFileSync(
    packageJsonPath,
    JSON.stringify({ name: "fixture", bin: { "autopilot-core": "bin/autopilot-core.mjs" } }),
  );

  assert.equal(resolveCoreBinary({ packageJsonPath, platform: "darwin", arch: "arm64" }), binary);
});

test("agent runner resolves only the package-contained declared wrapper", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-runner-resolution-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  const wrapper = join(dir, "bin", "autopilot-agent-run.mjs");
  writeFileSync(wrapper, "#!/usr/bin/env node\n");
  const packageJsonPath = join(dir, "package.json");
  writeFileSync(packageJsonPath, JSON.stringify({ name: "fixture", bin: { "autopilot-agent-run": "bin/autopilot-agent-run.mjs" } }));
  assert.equal(resolveAgentRunner({ packageJsonPath }), wrapper);
});

test("core binary rejects symlink and directory payloads with typed install errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-core-typed-reject-"));
  const binDir = join(dir, "binaries", "darwin-arm64");
  mkdirSync(binDir, { recursive: true });
  const packageJsonPath = join(dir, "package.json");
  writeFileSync(packageJsonPath, JSON.stringify({ name: "fixture", bin: { "autopilot-core": "bin/autopilot-core.mjs" } }));

  symlinkSync(packageJsonPath, join(binDir, "autopilot-core"));
  assert.throws(
    () => resolveCoreBinary({ packageJsonPath, platform: "darwin", arch: "arm64" }),
    (error) => error instanceof CoreInstallError && error.code === "symlink" && /must not be a symlink/u.test(error.message),
  );

  const linuxDir = join(dir, "binaries", "linux-x64", "autopilot-core");
  mkdirSync(linuxDir, { recursive: true });
  assert.throws(
    () => resolveCoreBinary({ packageJsonPath, platform: "linux", arch: "x64" }),
    (error) => error instanceof CoreInstallError && error.code === "not-regular-file" && /regular file/u.test(error.message),
  );
});

test("agent runner rejects symlink, escape, and missing bin declarations", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-runner-reject-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  const packageJsonPath = join(dir, "package.json");
  writeFileSync(packageJsonPath, JSON.stringify({ name: "fixture", bin: { "autopilot-agent-run": "../escape.mjs" } }));
  assert.throws(() => resolveAgentRunner({ packageJsonPath }), /bin\.autopilot-agent-run/u);

  writeFileSync(packageJsonPath, JSON.stringify({ name: "fixture", bin: { "autopilot-agent-run": "bin/autopilot-agent-run.mjs" } }));
  symlinkSync(packageJsonPath, join(dir, "bin", "autopilot-agent-run.mjs"));
  assert.throws(
    () => resolveAgentRunner({ packageJsonPath }),
    (error) => error instanceof RunnerInstallError && error.code === "symlink" && /must not be a symlink/u.test(error.message),
  );

  const dirPayloadRoot = mkdtempSync(join(tmpdir(), "autopilot-runner-directory-reject-"));
  mkdirSync(join(dirPayloadRoot, "bin", "autopilot-agent-run.mjs"), { recursive: true });
  const dirPayloadPackage = join(dirPayloadRoot, "package.json");
  writeFileSync(dirPayloadPackage, JSON.stringify({ name: "fixture", bin: { "autopilot-agent-run": "bin/autopilot-agent-run.mjs" } }));
  assert.throws(
    () => resolveAgentRunner({ packageJsonPath: dirPayloadPackage }),
    (error) => error instanceof RunnerInstallError && error.code === "not-regular-file" && /regular file/u.test(error.message),
  );

  const missingPackage = join(dir, "missing-package.json");
  writeFileSync(missingPackage, JSON.stringify({ name: "fixture", bin: {} }));
  assert.throws(() => resolveAgentRunner({ packageJsonPath: missingPackage }), /bin\.autopilot-agent-run/u);
});

test("host source has no derived path fallback", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(typeof packageJson.bin["autopilot-core"], "string");
  const sourceRoot = new URL("../src/", import.meta.url);
  for (const file of sourceFiles(sourceRoot)) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("dist/"), false, `${file} contains a forbidden dist path`);
    assert.equal(text.includes("target/"), false, `${file} contains a forbidden target path`);
  }
});

function sourceFiles(root: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const url = new URL(entry.name, root);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(new URL(`${entry.name}/`, root)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(url.pathname);
    }
  }
  return out;
}
