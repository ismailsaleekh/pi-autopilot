import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import autopilotExtension from "../src/extension.ts";
import { CoreInstallError, resolveCoreBinary } from "../src/resolve-core.ts";

function fixturePackage(platform: string, arch: string, withBinary = true): string {
  const root = mkdtempSync(join(tmpdir(), "autopilot-bin-dist-"));
  mkdirSync(join(root, "binaries", `${platform}-${arch}`), { recursive: true });
  if (withBinary) {
    const name = platform === "win32" ? "autopilot-core.exe" : "autopilot-core";
    const binary = join(root, "binaries", `${platform}-${arch}`, name);
    writeFileSync(binary, "#!/usr/bin/env sh\nexit 0\n");
    chmodSync(binary, 0o755);
  }
  writeFileSync(root + "/package.json", JSON.stringify({ name: "fixture", bin: { "autopilot-core": "bin/autopilot-core.mjs" } }));
  return root;
}

test("H7 fresh git install resolves packaged platform binary without target build output", () => {
  const root = fixturePackage("darwin", "arm64");
  try {
    assert.equal(resolveCoreBinary({ packageJsonPath: root + "/package.json", platform: "darwin", arch: "arm64" }), join(root, "binaries", "darwin-arm64", "autopilot-core"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H8 fresh npm pack install resolves packaged platform binary", () => {
  const root = fixturePackage("linux", "x64");
  try {
    assert.equal(resolveCoreBinary({ packageJsonPath: root + "/package.json", platform: "linux", arch: "x64" }), join(root, "binaries", "linux-x64", "autopilot-core"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H9 unsupported platform reports typed error naming platform", () => {
  const root = fixturePackage("darwin", "arm64");
  try {
    assert.throws(
      () => resolveCoreBinary({ packageJsonPath: root + "/package.json", platform: "freebsd", arch: "riscv64" }),
      (error) => error instanceof CoreInstallError && /unsupported platform freebsd-riscv64/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H10 binary missing at extension load notifies exactly once", () => {
  const root = fixturePackage("darwin", "arm64", false);
  const messages: string[] = [];
  const pi = {
    registerCommand() {},
    sendMessage(message: string) { messages.push(message); },
  };
  try {
    autopilotExtension(pi, { packageJsonPath: root + "/package.json", platform: "darwin", arch: "arm64" });
    autopilotExtension(pi, { packageJsonPath: root + "/package.json", platform: "darwin", arch: "arm64" });
    assert.deepEqual(messages, ["Autopilot unavailable: core binary missing for darwin-arm64. Reinstall pi-autopilot."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
