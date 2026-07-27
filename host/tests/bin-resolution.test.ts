import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveCoreBinary } from "../src/resolve-core.ts";

test("core binary resolves through package.json bin metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-bin-resolution-"));
  const binDir = join(dir, "target", "release");
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, "autopilot-core");
  writeFileSync(binary, "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(binary, 0o755);
  const packageJsonPath = join(dir, "package.json");
  writeFileSync(
    packageJsonPath,
    JSON.stringify({ name: "fixture", bin: { "autopilot-core": "target/release/autopilot-core" } }),
  );

  assert.equal(resolveCoreBinary({ packageJsonPath }), binary);
});

test("host source has no derived path fallback", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(typeof packageJson.bin["autopilot-core"], "string");
  const sourceRoot = new URL("../src/", import.meta.url);
  for (const file of sourceFiles(sourceRoot)) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("dist/"), false, `${file} contains a forbidden derived path`);
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
