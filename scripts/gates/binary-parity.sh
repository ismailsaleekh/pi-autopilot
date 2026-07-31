#!/usr/bin/env bash
#
# binary-parity.sh — shipped autopilot-core binary/source parity gate.
#
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: binary-parity.sh [--root DIR]

  --root DIR   treat DIR as the package root (default: script's ../../)
EOF
  exit 2
}

root=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || usage; root="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) printf 'binary-parity.sh: unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done

if [ -z "$root" ]; then
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd -- "$script_dir/../.." && pwd)"
fi
[ -d "$root" ] || { printf 'binary-parity.sh: root directory does not exist: %s\n' "$root" >&2; exit 2; }

python3 - "$root" <<'PY'
from __future__ import annotations
import hashlib, json, os, subprocess, sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
violations: list[str] = []
BUILD_INPUT_ROOTS = ["kernel", "drivers", "codegen", "modelcheck", "data"]
BUILD_INPUT_FILES = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]
BUILD_INPUT_SUFFIXES = (".rs", ".toml", ".lock", ".kdl")

def env_error(message: str) -> None:
    print(f"binary-parity.sh: {message}", file=sys.stderr); sys.exit(2)

def git(args: list[str]) -> bytes:
    try: return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)
    except FileNotFoundError: env_error("git is required")
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace").strip()
        env_error(f"git {' '.join(args)} failed{': ' + detail if detail else ''}")

def git_ls_files(paths: list[str], *, include_untracked: bool = False) -> list[str]:
    args = ["ls-files", "-z"]
    if include_untracked: args.extend(["--cached", "--others", "--exclude-standard", "--deduplicate"])
    args.extend(["--", *paths])
    return [p.decode("utf-8") for p in git(args).split(b"\0") if p]

def is_build_input(rel: str) -> bool:
    if rel in BUILD_INPUT_FILES or rel.startswith("data/"): return True
    return any(rel.startswith(f"{name}/") for name in BUILD_INPUT_ROOTS) and rel.endswith(BUILD_INPUT_SUFFIXES)

if git(["rev-parse", "--is-inside-work-tree"]).decode().strip() != "true": env_error(f"not inside a git work tree: {root}")

source_files: list[str] = []
for rel in sorted(set(git_ls_files([*BUILD_INPUT_ROOTS, *BUILD_INPUT_FILES], include_untracked=True))):
    path = root / rel
    if not is_build_input(rel) or not path.exists() or path.is_dir(): continue
    if path.is_symlink(): violations.append(f"build input {rel} is a symlink; sourceHash must cover regular source bytes"); continue
    if not path.is_file(): violations.append(f"build input {rel} is not a regular file"); continue
    source_files.append(rel)
if not source_files: env_error("no build-affecting source inputs found under Cargo.*, kernel/, drivers/, codegen/, modelcheck/, or data/")

hasher = hashlib.sha256()
for rel in source_files:
    hasher.update(rel.encode("utf-8")); hasher.update(b"\0"); hasher.update((root / rel).read_bytes()); hasher.update(b"\0")
source_hash = hasher.hexdigest()

launcher = root / "bin" / "autopilot-core.mjs"
if not launcher.is_file(): env_error("missing bin/autopilot-core.mjs dispatch launcher")
resolver = root / "src" / "resolve-core-runtime.js"
if not resolver.is_file(): env_error("missing src/resolve-core-runtime.js production Core resolver")
node_script = """
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.argv[1]).href);
const supported = mod.SUPPORTED_CORE_BINARIES;
if (typeof supported !== 'object' || supported === null || Array.isArray(supported)) {
  throw new Error('SUPPORTED_CORE_BINARIES must be an object');
}
console.log(JSON.stringify(supported));
"""
try:
    raw_dispatch = subprocess.check_output(["node", "--input-type=module", "-e", node_script, str(resolver)], stderr=subprocess.PIPE)
except FileNotFoundError:
    env_error("node is required to load src/resolve-core-runtime.js")
except subprocess.CalledProcessError as exc:
    detail = exc.stderr.decode("utf-8", "replace").strip()
    env_error(f"could not load SUPPORTED_CORE_BINARIES from src/resolve-core-runtime.js{': ' + detail if detail else ''}")
try:
    dispatch = json.loads(raw_dispatch.decode("utf-8"))
except json.JSONDecodeError as exc:
    env_error(f"SUPPORTED_CORE_BINARIES export returned non-JSON output: {exc}")
if not isinstance(dispatch, dict) or not dispatch or any(not isinstance(platform, str) or not isinstance(name, str) or not platform or not name for platform, name in dispatch.items()):
    env_error("SUPPORTED_CORE_BINARIES must be a non-empty string-to-string map")
expected_binary_paths = {f"binaries/{platform}/{name}" for platform, name in dispatch.items()}

manifest_rel = "binaries/MANIFEST.json"
manifest_path = root / manifest_rel
if not manifest_path.is_file(): violations.append("missing binaries/MANIFEST.json")
elif manifest_path.stat().st_size == 0: violations.append("binaries/MANIFEST.json is zero-length")
tracked_binaries = set(git_ls_files(["binaries"]))
if manifest_rel not in tracked_binaries: violations.append("binaries/MANIFEST.json is not tracked by git")

manifest: dict[str, object] = {}
if manifest_path.is_file() and manifest_path.stat().st_size > 0:
    try: manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc: violations.append(f"binaries/MANIFEST.json is invalid JSON: {exc}")
manifest_source = manifest.get("source") if isinstance(manifest, dict) else None
if isinstance(manifest_source, dict):
    if manifest_source.get("hash") != source_hash: violations.append(f"manifest source.hash mismatch: recorded {manifest_source.get('hash')!r}, current {source_hash}")
else: violations.append("binaries/MANIFEST.json missing source.hash object")
manifest_binaries = manifest.get("binaries") if isinstance(manifest, dict) else None
if not isinstance(manifest_binaries, dict): violations.append("binaries/MANIFEST.json missing binaries object"); manifest_binaries = {}

for platform, binary_name in sorted(dispatch.items()):
    rel = f"binaries/{platform}/{binary_name}"; path = root / rel
    if rel not in tracked_binaries: violations.append(f"{rel} is required by dispatch map but is not tracked by git")
    if not path.exists(): violations.append(f"{rel} is missing"); continue
    if not path.is_file(): violations.append(f"{rel} is not a regular file"); continue
    if path.stat().st_size == 0: violations.append(f"{rel} is zero-length")
    if not os.access(path, os.X_OK): violations.append(f"{rel} is not executable")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    entry = manifest_binaries.get(platform)
    if not isinstance(entry, dict): violations.append(f"manifest missing binaries.{platform} entry"); continue
    if entry.get("path") != rel: violations.append(f"manifest binaries.{platform}.path is {entry.get('path')!r}, expected {rel}")
    if entry.get("sha256") != digest: violations.append(f"manifest sha256 mismatch for {platform}: recorded {entry.get('sha256')!r}, current {digest}")
    if entry.get("sourceHash") != source_hash: violations.append(f"manifest sourceHash mismatch for {platform}: recorded {entry.get('sourceHash')!r}, current {source_hash}")

for rel in sorted(p for p in tracked_binaries if p != manifest_rel and p not in expected_binary_paths):
    path = root / rel
    if not path.exists(): violations.append(f"tracked shipped binary {rel} is missing"); continue
    if not path.is_file(): violations.append(f"tracked shipped binary {rel} is not a regular file"); continue
    if path.stat().st_size == 0: violations.append(f"tracked shipped binary {rel} is zero-length")
    if not os.access(path, os.X_OK): violations.append(f"tracked shipped binary {rel} is not executable")

print("binary-parity.sh: " f"source_inputs={len(source_files)} " f"source_hash={source_hash} " f"hash_scope=Cargo.*,kernel,drivers,codegen,modelcheck,data " f"platforms={','.join(sorted(dispatch))}")
if violations:
    print("", file=sys.stderr); print("binary-parity.sh: BINARY PARITY VIOLATION", file=sys.stderr)
    for violation in violations: print(f"  - {violation}", file=sys.stderr)
    print("", file=sys.stderr); print("Rebuild every shipped binary from the current source inputs and regenerate binaries/MANIFEST.json.", file=sys.stderr)
    sys.exit(1)
print("binary-parity.sh: all shipped binaries match current source and manifest.")
PY
