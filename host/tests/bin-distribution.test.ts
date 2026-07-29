import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * BUG-184 REPLACEMENT. H10 previously asserted that a missing Core binary
 * produced an operator message AT EXTENSION LOAD, deduplicated through a
 * module-level Set. That pinned two defects: Autopilot spoke in sessions that
 * never used it, and the dedup key was process-global across unrelated
 * sessions. The binary is now probed at the point of use, where its absence is
 * a BLOCKING failure of the activating command rather than a passive notice.
 */
test("H10 BUG-184: a missing binary stays silent at load and blocks the activating command", async () => {
  const root = fixturePackage("darwin", "arm64", false);
  const stateRoot = mkdtempSync(join(tmpdir(), "autopilot-h10-state-"));
  const messages: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const pi = {
    events: { on() { return () => {}; }, emit() {} },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) { hooks.set(name, handler); },
    registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, definition); },
    registerTool() {},
    appendEntry() {},
    sendMessage(message: { content?: string } | string) { messages.push(typeof message === "string" ? message : String(message.content)); },
  };
  const ctx = { hasUI: false, mode: "json", ui: { notify() {} }, sessionManager: { getSessionId: () => "019faf00-0000-7000-8000-0000000000d1" } };
  try {
    autopilotExtension(pi, { packageJsonPath: root + "/package.json", platform: "darwin", arch: "arm64", stateRoot, processIdentity: "pid:test:started:1" });
    await hooks.get("session_start")?.({ reason: "startup" }, ctx);

    assert.deepEqual(messages, [], "a missing binary must not speak at load time");

    await assert.rejects(
      () => commands.get("autopilot-plan")!.handler("main A.md B.md C.md CTX.md", ctx),
      /autopilot-core binary missing for darwin-arm64/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
