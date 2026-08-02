#!/usr/bin/env node
/**
 * regen-binary-manifest.mjs — regenerate binaries/MANIFEST.json from FRESHLY BUILT bytes.
 *
 * This exists because the manifest was previously hand-maintained, which makes it
 * possible to re-bless STALE binaries under a fresh source hash: the parity gate
 * would then pass on false pretenses while shipping bytes that never contained the
 * current source. That is the single most dangerous failure mode here, because the
 * gate is what LIVE trusts.
 *
 * Contract:
 *   - Every platform in SUPPORTED_CORE_BINARIES must have a freshly built artifact
 *     in --build-root. A missing target is a HARD REFUSAL, never a partial manifest.
 *   - Each artifact must be NEWER than every build input, otherwise it predates the
 *     current source and is stale. Also a HARD REFUSAL.
 *   - sha256/sizeBytes are read from the copied bytes AFTER copying, so the manifest
 *     always describes what is actually shipped.
 *   - buildMethod strings are preserved from the existing manifest, since they record
 *     how each target must be built (native / rust-lld+musl / mingw).
 *
 * Usage: node scripts/regen-binary-manifest.mjs --build-root <CARGO_TARGET_DIR>
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const buildRootIndex = argv.indexOf("--build-root");
if (buildRootIndex < 0 || !argv[buildRootIndex + 1]) fail("usage: regen-binary-manifest.mjs --build-root <CARGO_TARGET_DIR>");
const buildRoot = resolve(argv[buildRootIndex + 1]);

function fail(message) {
  console.error(`regen-binary-manifest: ${message}`);
  process.exit(2);
}

const manifestPath = join(root, "binaries", "MANIFEST.json");
if (!existsSync(manifestPath)) fail("missing binaries/MANIFEST.json to take buildMethod/target metadata from");
const previous = JSON.parse(readFileSync(manifestPath, "utf8"));

const resolverPath = join(root, "src", "resolve-core-runtime.js");
const { SUPPORTED_CORE_BINARIES: dispatch } = await import(pathToFileURL(resolverPath).href);
if (typeof dispatch !== "object" || dispatch === null || Array.isArray(dispatch) || Object.keys(dispatch).length === 0) {
  fail("SUPPORTED_CORE_BINARIES must be a non-empty object");
}

// Recompute the source hash EXACTLY as scripts/gates/binary-parity.sh does.
const BUILD_INPUT_ROOTS = ["kernel", "drivers", "codegen", "modelcheck", "data"];
const BUILD_INPUT_FILES = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];
const BUILD_INPUT_SUFFIXES = [".rs", ".toml", ".lock", ".kdl"];
const listed = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate", "--", ...BUILD_INPUT_ROOTS, ...BUILD_INPUT_FILES], { maxBuffer: 64 * 1024 * 1024 })
  .toString("utf8").split("\0").filter(Boolean);
const isBuildInput = (rel) =>
  BUILD_INPUT_FILES.includes(rel) || rel.startsWith("data/") ||
  (BUILD_INPUT_ROOTS.some((name) => rel.startsWith(`${name}/`)) && BUILD_INPUT_SUFFIXES.some((s) => rel.endsWith(s)));

const sourceFiles = [...new Set(listed)].sort().filter((rel) => {
  const p = join(root, rel);
  return isBuildInput(rel) && existsSync(p) && statSync(p).isFile();
});
if (sourceFiles.length === 0) fail("no build-affecting source inputs found");

const sourceHasher = createHash("sha256");
let newestInputMs = 0;
for (const rel of sourceFiles) {
  const p = join(root, rel);
  sourceHasher.update(Buffer.from(rel, "utf8"));
  sourceHasher.update(Buffer.from([0]));
  sourceHasher.update(readFileSync(p));
  sourceHasher.update(Buffer.from([0]));
  newestInputMs = Math.max(newestInputMs, statSync(p).mtimeMs);
}
const sourceHash = sourceHasher.digest("hex");

// REFUSE unless every dispatch platform has a fresh artifact.
const binaries = {};
const problems = [];
for (const [platform, binaryName] of Object.entries(dispatch).sort()) {
  const prev = previous.binaries?.[platform];
  if (!prev?.target || !prev?.buildMethod) { problems.push(`${platform}: previous manifest lacks target/buildMethod to preserve`); continue; }
  const built = join(buildRoot, prev.target, "release", binaryName);
  if (!existsSync(built)) { problems.push(`${platform}: no freshly built artifact at ${built} (refusing to re-bless stale bytes)`); continue; }
  const builtStat = statSync(built);
  if (builtStat.size === 0) { problems.push(`${platform}: freshly built artifact is zero-length`); continue; }
  if (builtStat.mtimeMs < newestInputMs) {
    problems.push(`${platform}: artifact (${new Date(builtStat.mtimeMs).toISOString()}) is OLDER than newest build input (${new Date(newestInputMs).toISOString()}) — stale, refusing`);
    continue;
  }
  const rel = `binaries/${platform}/${binaryName}`;
  const dest = join(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(built, dest);
  chmodSync(dest, 0o755);
  const bytes = readFileSync(dest);
  binaries[platform] = {
    buildMethod: prev.buildMethod,
    path: rel,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    sourceHash,
    target: prev.target,
  };
}

if (problems.length > 0) {
  console.error("regen-binary-manifest: REFUSING to write a manifest");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nEvery shipped platform must be rebuilt from the current source before regenerating.");
  process.exit(1);
}

const manifest = {
  binaries,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  schema: previous.schema ?? 1,
  source: {
    directories: BUILD_INPUT_ROOTS,
    fileCount: sourceFiles.length,
    files: BUILD_INPUT_FILES,
    hash: sourceHash,
    hashAlgorithm: previous.source?.hashAlgorithm ?? "sha256(path-nul-content-nul over build-affecting tracked and untracked inputs)",
  },
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`regen-binary-manifest: wrote ${Object.keys(binaries).length} platforms, sourceHash=${sourceHash}, inputs=${sourceFiles.length}`);
