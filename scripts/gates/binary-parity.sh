#!/usr/bin/env bash
#
# binary-parity.sh — shipped autopilot-core binary/source parity gate.
#
# The npm package ships prebuilt binaries from binaries/<platform>/ while the
# Rust target/ tree is intentionally ignored. This gate makes source/artifact
# drift a hard failure before tests or prepack can succeed.
#
# Usage:
#     scripts/gates/binary-parity.sh
#     scripts/gates/binary-parity.sh --root DIR
#
# Exit codes:
#     0  binaries match the current tracked source tree and manifest
#     1  parity violation (stale/missing/untracked/non-executable/hash mismatch)
#     2  usage/environment error
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
    --root)
      [ $# -ge 2 ] || usage
      root="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      printf 'binary-parity.sh: unknown argument: %s\n' "$1" >&2
      usage
      ;;
  esac
done

if [ -z "$root" ]; then
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd -- "$script_dir/../.." && pwd)"
fi

if [ ! -d "$root" ]; then
  printf 'binary-parity.sh: root directory does not exist: %s\n' "$root" >&2
  exit 2
fi

python3 - "$root" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
violations: list[str] = []


def env_error(message: str) -> None:
    print(f"binary-parity.sh: {message}", file=sys.stderr)
    sys.exit(2)


def git(args: list[str]) -> bytes:
    try:
        return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)
    except FileNotFoundError:
        env_error("git is required")
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace").strip()
        if detail:
            env_error(f"git {' '.join(args)} failed: {detail}")
        env_error(f"git {' '.join(args)} failed")


def git_ls_files(paths: list[str]) -> list[str]:
    data = git(["ls-files", "-z", "--", *paths])
    return [p.decode("utf-8") for p in data.split(b"\0") if p]


try:
    inside = git(["rev-parse", "--is-inside-work-tree"]).decode().strip()
except SystemExit:
    raise
if inside != "true":
    env_error(f"not inside a git work tree: {root}")

source_files = sorted(
    p for p in git_ls_files(["kernel", "drivers", "codegen"])
    if p.endswith(".rs") and (root / p).is_file()
)
if not source_files:
    env_error("no tracked Rust source files under kernel/, drivers/, or codegen/")

source_hasher = hashlib.sha256()
newest_source: tuple[int, str] | None = None
for rel in source_files:
    path = root / rel
    data = path.read_bytes()
    source_hasher.update(rel.encode("utf-8"))
    source_hasher.update(b"\0")
    source_hasher.update(data)
    source_hasher.update(b"\0")
    mtime_ns = path.stat().st_mtime_ns
    if newest_source is None or mtime_ns > newest_source[0]:
        newest_source = (mtime_ns, rel)

assert newest_source is not None
source_hash = source_hasher.hexdigest()
newest_source_mtime_ns, newest_source_rel = newest_source

launcher = root / "bin" / "autopilot-core.mjs"
if not launcher.is_file():
    env_error("missing bin/autopilot-core.mjs dispatch launcher")
launcher_text = launcher.read_text(encoding="utf-8")
match = re.search(r"const\s+supported\s*=\s*\{(?P<body>.*?)\}\s*;", launcher_text, re.S)
if not match:
    env_error("could not find supported dispatch map in bin/autopilot-core.mjs")
pairs = re.findall(r"['\"]([^'\"]+)['\"]\s*:\s*['\"]([^'\"]+)['\"]", match.group("body"))
if not pairs:
    env_error("dispatch map in bin/autopilot-core.mjs is empty or unparsable")
dispatch = dict(pairs)
expected_binary_paths = {f"binaries/{platform}/{name}" for platform, name in dispatch.items()}

manifest_rel = "binaries/MANIFEST.json"
manifest_path = root / manifest_rel
if not manifest_path.is_file():
    violations.append("missing binaries/MANIFEST.json")
elif manifest_path.stat().st_size == 0:
    violations.append("binaries/MANIFEST.json is zero-length")

tracked_binaries = set(git_ls_files(["binaries"]))
if manifest_rel not in tracked_binaries:
    violations.append("binaries/MANIFEST.json is not tracked by git")

manifest: dict[str, object] = {}
if manifest_path.is_file() and manifest_path.stat().st_size > 0:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        violations.append(f"binaries/MANIFEST.json is invalid JSON: {exc}")

manifest_source = manifest.get("source") if isinstance(manifest, dict) else None
if isinstance(manifest_source, dict):
    recorded_top_hash = manifest_source.get("hash")
    if recorded_top_hash != source_hash:
        violations.append(
            f"manifest source.hash mismatch: recorded {recorded_top_hash!r}, current {source_hash}"
        )
else:
    violations.append("binaries/MANIFEST.json missing source.hash object")

manifest_binaries = manifest.get("binaries") if isinstance(manifest, dict) else None
if not isinstance(manifest_binaries, dict):
    violations.append("binaries/MANIFEST.json missing binaries object")
    manifest_binaries = {}

for platform, binary_name in sorted(dispatch.items()):
    rel = f"binaries/{platform}/{binary_name}"
    path = root / rel

    if rel not in tracked_binaries:
        violations.append(f"{rel} is required by dispatch map but is not tracked by git")

    if not path.exists():
        violations.append(f"{rel} is missing")
        continue
    if not path.is_file():
        violations.append(f"{rel} is not a regular file")
        continue
    if path.stat().st_size == 0:
        violations.append(f"{rel} is zero-length")
    if not os.access(path, os.X_OK):
        violations.append(f"{rel} is not executable")
    if path.stat().st_mtime_ns < newest_source_mtime_ns:
        violations.append(
            f"{rel} is older than newest tracked Rust source {newest_source_rel}"
        )

    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    entry = manifest_binaries.get(platform)
    if not isinstance(entry, dict):
        violations.append(f"manifest missing binaries.{platform} entry")
        continue

    if entry.get("path") != rel:
        violations.append(f"manifest binaries.{platform}.path is {entry.get('path')!r}, expected {rel}")
    if entry.get("sha256") != digest:
        violations.append(
            f"manifest sha256 mismatch for {platform}: recorded {entry.get('sha256')!r}, current {digest}"
        )
    if entry.get("sourceHash") != source_hash:
        violations.append(
            f"manifest sourceHash mismatch for {platform}: recorded {entry.get('sourceHash')!r}, current {source_hash}"
        )

for rel in sorted(p for p in tracked_binaries if p != manifest_rel and p not in expected_binary_paths):
    path = root / rel
    if not path.exists():
        violations.append(f"tracked shipped binary {rel} is missing")
        continue
    if not path.is_file():
        violations.append(f"tracked shipped binary {rel} is not a regular file")
        continue
    if path.stat().st_size == 0:
        violations.append(f"tracked shipped binary {rel} is zero-length")
    if not os.access(path, os.X_OK):
        violations.append(f"tracked shipped binary {rel} is not executable")
    if path.stat().st_mtime_ns < newest_source_mtime_ns:
        violations.append(f"tracked shipped binary {rel} is older than {newest_source_rel}")

print(
    "binary-parity.sh: "
    f"source_files={len(source_files)} "
    f"source_hash={source_hash} "
    f"newest_source={newest_source_rel} "
    f"platforms={','.join(sorted(dispatch))}"
)

if violations:
    print("", file=sys.stderr)
    print("binary-parity.sh: BINARY PARITY VIOLATION", file=sys.stderr)
    for violation in violations:
        print(f"  - {violation}", file=sys.stderr)
    print("", file=sys.stderr)
    print(
        "Rebuild every shipped binary from the current source tree and regenerate binaries/MANIFEST.json.",
        file=sys.stderr,
    )
    sys.exit(1)

print("binary-parity.sh: all shipped binaries match current source and manifest.")
PY
