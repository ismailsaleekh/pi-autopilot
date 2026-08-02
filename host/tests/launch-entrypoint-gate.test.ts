import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { certifyLaunchEntrypoint } from "../../scripts/check-launch-entrypoint.mjs";

const TEST_PLATFORM = "linux";
const TEST_ARCH = "x64";
const TEST_PLATFORM_KEY = `${TEST_PLATFORM}-${TEST_ARCH}`;
const TEST_BINARY_NAME = "autopilot-core";
const SOURCE_HASH = "f".repeat(64);

interface FixtureOptions {
  readonly mode?: "valid" | "malformed" | "extra" | "id-drift" | "timeout" | "nonzero";
}

function certifyFixture(root: string, overrides: Record<string, unknown> = {}) {
  return certifyLaunchEntrypoint({
    packageRoot: root,
    platform: TEST_PLATFORM,
    arch: TEST_ARCH,
    requestId: 41,
    timeoutMs: 10_000,
    ...overrides,
  });
}

function makeFixture(options: FixtureOptions = {}): string {
  const mode = options.mode ?? "valid";
  const root = mkdtempSync(join(tmpdir(), "pi-autopilot-launch-gate-fixture."));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "extensions"), { recursive: true });
  mkdirSync(join(root, "src", "generated"), { recursive: true });
  mkdirSync(join(root, "binaries", TEST_PLATFORM_KEY), { recursive: true });

  writePackageJson(root, {
    name: "pi-autopilot-fixture",
    type: "module",
    bin: {
      "autopilot-core": "bin/autopilot-core.mjs",
      "autopilot-agent-run": "bin/autopilot-agent-run.mjs",
    },
    pi: { extensions: ["./extensions/autopilot.ts"] },
  });
  writeFileSync(join(root, "extensions", "autopilot.ts"), "export default function autopilot() {}\n", "utf8");
  writeFileSync(join(root, "src", "generated", "child-extension.ts"), "export {};\n", "utf8");
  writeFileSync(
    join(root, "bin", "autopilot-core.mjs"),
    "#!/usr/bin/env node\nimport { resolveCoreBinary } from '../src/resolve-core-runtime.js';\nresolveCoreBinary();\n",
    "utf8",
  );
  writeFileSync(
    join(root, "bin", "autopilot-agent-run.mjs"),
    "#!/usr/bin/env node\nimport { resolveCoreWrapper } from '../src/resolve-core-runtime.js';\nresolveCoreWrapper();\n",
    "utf8",
  );

  const binary = binaryPath(root);
  writeFileSync(binary, fakeCoreScript(mode), "utf8");
  chmodSync(binary, 0o755);
  writeManifest(root);
  return root;
}

function writePackageJson(root: string, value: Record<string, unknown>): void {
  writeFileSync(join(root, "package.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readPackageJson(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function binaryPath(root: string): string {
  return join(root, "binaries", TEST_PLATFORM_KEY, TEST_BINARY_NAME);
}

function writeManifest(root: string, mutate?: (manifest: Record<string, unknown>) => void): void {
  const binary = binaryPath(root);
  const bytes = readFileSync(binary);
  const rel = `binaries/${TEST_PLATFORM_KEY}/${TEST_BINARY_NAME}`;
  const manifest = {
    schema: 1,
    source: { hash: SOURCE_HASH },
    binaries: {
      [TEST_PLATFORM_KEY]: {
        path: rel,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
        sourceHash: SOURCE_HASH,
        target: "x86_64-unknown-linux-musl",
      },
    },
  };
  mutate?.(manifest);
  writeFileSync(join(root, "binaries", "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function fakeCoreScript(mode: FixtureOptions["mode"]): string {
  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8').trim();
let id = 0;
try { id = JSON.parse(input).id; } catch {}
const done = (frameId = id) => JSON.stringify({ v: 1, id: frameId, kind: 'done', payload: { status: 'fixture-status' } }) + '\\n';
if (${JSON.stringify(mode)} === 'malformed') { process.stdout.write('not-json\\n'); process.exit(0); }
if (${JSON.stringify(mode)} === 'extra') { process.stdout.write(done() + done()); process.exit(0); }
if (${JSON.stringify(mode)} === 'id-drift') { process.stdout.write(done(id + 1)); process.exit(0); }
if (${JSON.stringify(mode)} === 'timeout') { setTimeout(() => {}, 10_000); }
else if (${JSON.stringify(mode)} === 'nonzero') { process.stderr.write('fixture nonzero\\n'); process.exit(17); }
else { process.stdout.write(done()); }
`;
}

test("launch entrypoint gate accepts a contained resolver-backed fixture", () => {
  const root = makeFixture();
  try {
    const report = certifyFixture(root);
    assert.equal(report.passed, true);
    assert.equal(report.bin["autopilot-core"], "bin/autopilot-core.mjs");
    assert.equal(report.bin["autopilot-agent-run"], "bin/autopilot-agent-run.mjs");
    assert.equal(report.platform_key, TEST_PLATFORM_KEY);
    assert.equal(report.status_probe.request_id, 41);
    assert.equal(report.status_probe.status, "fixture-status");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch entrypoint gate rejects wrong and missing bin metadata", () => {
  for (const [label, mutate, pattern] of [
    ["missing core", (pkg: Record<string, unknown>) => { delete (pkg.bin as Record<string, unknown>)["autopilot-core"]; }, /package\.json bin keys/u],
    ["missing runner", (pkg: Record<string, unknown>) => { delete (pkg.bin as Record<string, unknown>)["autopilot-agent-run"]; }, /package\.json bin keys/u],
    ["wrong core", (pkg: Record<string, unknown>) => { (pkg.bin as Record<string, unknown>)["autopilot-core"] = "bin/wrong.mjs"; }, /bin\.autopilot-core must be exactly/u],
    ["wrong runner", (pkg: Record<string, unknown>) => { (pkg.bin as Record<string, unknown>)["autopilot-agent-run"] = "bin/wrong.mjs"; }, /bin\.autopilot-agent-run must be exactly/u],
  ] as const) {
    const root = makeFixture();
    try {
      const pkg = readPackageJson(root);
      mutate(pkg);
      writePackageJson(root, pkg);
      assert.throws(() => certifyFixture(root), pattern, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("launch entrypoint gate rejects escaped package metadata", () => {
  const root = makeFixture();
  try {
    const pkg = readPackageJson(root);
    (pkg.bin as Record<string, unknown>)["autopilot-core"] = "../escape.mjs";
    writePackageJson(root, pkg);
    assert.throws(() => certifyFixture(root), /escapes package root/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch entrypoint gate rejects missing, symlink, and non-executable native binaries", () => {
  for (const [label, mutate, pattern] of [
    ["missing", (root: string) => unlinkSync(binaryPath(root)), /binary.*missing|is missing/u],
    ["symlink", (root: string) => { const binary = binaryPath(root); unlinkSync(binary); symlinkSync(join(root, "package.json"), binary); }, /must not be a symlink/u],
    ["non-executable", (root: string) => chmodSync(binaryPath(root), 0o644), /not executable/u],
  ] as const) {
    const root = makeFixture();
    try {
      mutate(root);
      assert.throws(() => certifyFixture(root), pattern, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("launch entrypoint gate rejects unsupported platforms", () => {
  const root = makeFixture();
  try {
    assert.throws(() => certifyFixture(root, { platform: "freebsd", arch: "riscv64" }), /unsupported platform freebsd-riscv64/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch entrypoint gate rejects manifest path, hash, size, and sourceHash drift", () => {
  for (const [label, mutate, pattern] of [
    ["path", (manifest: Record<string, unknown>) => { (((manifest.binaries as Record<string, unknown>)[TEST_PLATFORM_KEY] as Record<string, unknown>).path) = "binaries/linux-x64/wrong"; }, /manifest path mismatch/u],
    ["hash", (manifest: Record<string, unknown>) => { (((manifest.binaries as Record<string, unknown>)[TEST_PLATFORM_KEY] as Record<string, unknown>).sha256) = "0".repeat(64); }, /manifest sha256 mismatch/u],
    ["size", (manifest: Record<string, unknown>) => { (((manifest.binaries as Record<string, unknown>)[TEST_PLATFORM_KEY] as Record<string, unknown>).sizeBytes) = 1; }, /manifest sizeBytes mismatch/u],
    ["sourceHash", (manifest: Record<string, unknown>) => { (((manifest.binaries as Record<string, unknown>)[TEST_PLATFORM_KEY] as Record<string, unknown>).sourceHash) = "e".repeat(64); }, /manifest sourceHash mismatch/u],
  ] as const) {
    const root = makeFixture();
    try {
      writeManifest(root, mutate);
      assert.throws(() => certifyFixture(root), pattern, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("launch entrypoint gate rejects malformed, extra, id-drift, timeout, and nonzero status launches", () => {
  for (const [mode, pattern, timeoutMs] of [
    ["malformed", /malformed status frame JSON/u, 10_000],
    ["extra", /expected exactly one LF-terminated status frame/u, 10_000],
    ["id-drift", /status-frame id drift/u, 10_000],
    ["timeout", /timed out after/u, 100],
    ["nonzero", /exited nonzero/u, 10_000],
  ] as const) {
    const root = makeFixture({ mode });
    try {
      assert.throws(() => certifyFixture(root, { timeoutMs }), pattern, mode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("launch entrypoint gate rejects wrapper symlinks before launch", () => {
  const root = makeFixture();
  try {
    const wrapper = join(root, "bin", "autopilot-core.mjs");
    unlinkSync(wrapper);
    symlinkSync(join(root, "package.json"), wrapper);
    assert.throws(() => certifyFixture(root), /wrapper must not be a symlink/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
