#!/usr/bin/env bash
#
# selftest.sh — proves the D77 gate scripts actually fail on known-bad input.
#
# WHY THIS EXISTS
# ---------------
# The gate scripts are the referees for the W1 kill-switch and for Closures B
# and S4/F1. A referee that silently passes everything is worse than no referee:
# it manufactures false confidence exactly when the budget is being blown.
#
# This is not hypothetical. It is the shape of BUG-179..182 and F012 — an
# acceptance boundary that was never exercised by the thing it judged. It is
# also the `retrofit_cascading` failure class: under pressure, the agent that
# blows a budget "fixes" the script that measures it.
#
# So each gate is proven against BOTH:
#   - a known-GOOD fixture, which it must accept (exit 0); and
#   - a known-BAD fixture, which it must reject (exit 1).
#
# A gate that cannot reject its known-bad fixture is itself a W0 failure.
#
# Usage:
#     scripts/gates/selftest.sh
#
# Exit codes:
#     0  all gates behave correctly on good and bad fixtures
#     1  a gate failed to accept good input or failed to reject bad input
#     2  usage/environment error
#
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir

readonly LOC="$script_dir/loc.sh"
readonly PURITY="$script_dir/kernel-purity.sh"
readonly NOINFER="$script_dir/no-inference.sh"
readonly HOSTTHIN="$script_dir/host-thinness.sh"
readonly BINARY="$script_dir/binary-parity.sh"
readonly REALPROD="$script_dir/real-producers.mjs"

for s in "$LOC" "$PURITY" "$NOINFER" "$HOSTTHIN" "$BINARY" "$REALPROD"; do
  [ -x "$s" ] || { printf 'selftest.sh: not executable: %s\n' "$s" >&2; exit 2; }
done

tmp="$(mktemp -d "${TMPDIR:-/tmp}/autopilot-gate-selftest.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

passes=0
failures=0

# expect EXPECTED_CODE LABEL COMMAND...
expect() {
  local want="$1" label="$2"; shift 2
  local got=0
  "$@" >"$tmp/out.log" 2>&1 || got=$?
  if [ "$got" -eq "$want" ]; then
    printf '  ok    %s (exit %d)\n' "$label" "$got"
    passes=$((passes + 1))
  else
    printf '  FAIL  %s — expected exit %d, got %d\n' "$label" "$want" "$got" >&2
    sed 's/^/          /' "$tmp/out.log" >&2
    failures=$((failures + 1))
  fi
}

write_binary_parity_fixture() {
  local root="$1" mode="$2"

  mkdir -p \
    "$root/bin" \
    "$root/binaries/darwin-arm64" \
    "$root/kernel/src" \
    "$root/drivers/src" \
    "$root/codegen/src" \
    "$root/modelcheck/src"

  cat > "$root/bin/autopilot-core.mjs" <<'JS'
#!/usr/bin/env node
const supported = {
  'darwin-arm64': 'autopilot-core',
};
JS

  cat > "$root/kernel/src/lib.rs" <<'RS'
pub fn kernel_state() -> u8 { 1 }
RS
  cat > "$root/drivers/src/lib.rs" <<'RS'
pub fn driver_state() -> u8 { 2 }
RS
  mkdir -p "$root/data"
  cat > "$root/codegen/src/main.rs" <<'RS'
fn main() {}
RS
  cat > "$root/modelcheck/src/main.rs" <<'RS'
fn main() {}
RS
  cat > "$root/Cargo.toml" <<'TOML'
[workspace]
members = ["kernel", "drivers", "codegen", "modelcheck"]
TOML
  cat > "$root/Cargo.lock" <<'LOCK'
# fixture lockfile
LOCK
  cat > "$root/rust-toolchain.toml" <<'TOML'
[toolchain]
channel = "stable"
TOML
  cat > "$root/data/seam_real_producers.rs" <<'RS'
pub fn seam_fixture() -> u8 { 4 }
RS
  cat > "$root/data/workflow.kdl" <<'KDL'
workflow {}
KDL

  printf '#!/bin/sh\necho autopilot-core fixture\n' > "$root/binaries/darwin-arm64/autopilot-core"
  chmod +x "$root/binaries/darwin-arm64/autopilot-core"

  touch -t 202607280101.00 "$root/kernel/src/lib.rs" "$root/drivers/src/lib.rs" "$root/codegen/src/main.rs" "$root/modelcheck/src/main.rs" "$root/data/seam_real_producers.rs" "$root/data/workflow.kdl" "$root/Cargo.toml" "$root/Cargo.lock" "$root/rust-toolchain.toml"
  touch -t 202607280102.00 "$root/binaries/darwin-arm64/autopilot-core"

  python3 - "$root" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
source_files = ["Cargo.lock", "Cargo.toml", "codegen/src/main.rs", "data/seam_real_producers.rs", "data/workflow.kdl", "drivers/src/lib.rs", "kernel/src/lib.rs", "modelcheck/src/main.rs", "rust-toolchain.toml"]
h = hashlib.sha256()
for rel in sorted(source_files):
    h.update(rel.encode())
    h.update(b"\0")
    h.update((root / rel).read_bytes())
    h.update(b"\0")
source_hash = h.hexdigest()
binary_rel = "binaries/darwin-arm64/autopilot-core"
binary_hash = hashlib.sha256((root / binary_rel).read_bytes()).hexdigest()
manifest = {
    "schema": 1,
    "source": {
        "directories": ["kernel", "drivers", "codegen", "modelcheck", "data"],
        "files": ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
        "hash": source_hash,
        "hashAlgorithm": "sha256(path-nul-content-nul over build-affecting tracked and untracked inputs)",
    },
    "binaries": {
        "darwin-arm64": {
            "path": binary_rel,
            "sha256": binary_hash,
            "sourceHash": source_hash,
            "target": "aarch64-apple-darwin",
        }
    },
}
(root / "binaries/MANIFEST.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
PY

  git -C "$root" init -q
  git -C "$root" config user.email selftest@example.invalid
  git -C "$root" config user.name 'Gate Selftest'
  git -C "$root" add bin kernel drivers codegen modelcheck data binaries Cargo.toml Cargo.lock rust-toolchain.toml

  if [ "$mode" = "stale" ]; then
    printf '\npub fn repaired_source() -> u8 { 3 }\n' >> "$root/drivers/src/lib.rs"
    touch -t 202607280103.00 "$root/drivers/src/lib.rs"
    git -C "$root" add drivers/src/lib.rs
  elif [ "$mode" = "untracked" ]; then
    cat > "$root/drivers/src/untracked_build_input.rs" <<'RS'
pub fn untracked_build_input() -> u8 { 9 }
RS
    touch -t 202607280103.00 "$root/drivers/src/untracked_build_input.rs"
  elif [ "$mode" = "cargo" ]; then
    printf '\n[profile.release]\nopt-level = "z"\n' >> "$root/Cargo.toml"
    touch -t 202607280103.00 "$root/Cargo.toml"
    git -C "$root" add Cargo.toml
  elif [ "$mode" = "newer-mtime" ]; then
    touch -t 202607280103.00 "$root/kernel/src/lib.rs"
  fi
}

# ---------------------------------------------------------------------------
# loc.sh
# ---------------------------------------------------------------------------
printf '\nloc.sh\n'

# GOOD: a small kernel, well under 2000.
good="$tmp/loc-good"
mkdir -p "$good/kernel"
{
  echo '// a comment line that must NOT be counted'
  echo ''
  echo '/* block'
  echo '   comment */'
  for i in $(seq 1 50); do echo "let x$i = $i;"; done
} > "$good/kernel/lib.rs"
expect 0 "accepts a 50-LOC kernel" "$LOC" --root "$good" kernel

# BAD: a kernel over budget. This is THE kill-switch test.
bad="$tmp/loc-bad"
mkdir -p "$bad/kernel"
for i in $(seq 1 2500); do echo "let x$i = $i;"; done > "$bad/kernel/lib.rs"
expect 1 "rejects a 2500-LOC kernel (kill-switch)" "$LOC" --root "$bad" kernel

# BAD: symlinked Rust sources are still source; they must not bypass the budget.
lsym="$tmp/loc-symlink-bad"
mkdir -p "$lsym/kernel"
for i in $(seq 1 2500); do echo "let symlinked$i = $i;"; done > "$lsym/large.rs"
ln -s ../large.rs "$lsym/kernel/lib.rs"
expect 1 "rejects a 2500-LOC kernel through a symlinked .rs file" "$LOC" --root "$lsym" kernel

# BAD: the kernel kill-switch is independent even when Core as a whole is under 6500.
kind="$tmp/loc-kernel-independent"
mkdir -p "$kind/kernel" "$kind/drivers"
for i in $(seq 1 2500); do echo "let k$i = $i;"; done > "$kind/kernel/lib.rs"
for i in $(seq 1 3000); do echo "let d$i = $i;"; done > "$kind/drivers/lib.rs"
expect 1 "kernel rejects 2500 LOC even when core totals 5500" "$LOC" --root "$kind" kernel

# GOOD: shipped Core budget is kernel + drivers only.
coregood="$tmp/loc-core-good"
mkdir -p "$coregood/kernel" "$coregood/drivers"
for i in $(seq 1 1000); do echo "let k$i = $i;"; done > "$coregood/kernel/lib.rs"
for i in $(seq 1 5400); do echo "let d$i = $i;"; done > "$coregood/drivers/lib.rs"
expect 0 "core accepts 6400 LOC across kernel + drivers" "$LOC" --root "$coregood" core

# BAD: an over-budget Core must trip the new kill-switch.
corebad="$tmp/loc-core-bad"
mkdir -p "$corebad/drivers"
for i in $(seq 1 6600); do echo "let d$i = $i;"; done > "$corebad/drivers/lib.rs"
expect 1 "core rejects a 6600-LOC drivers tree (kill-switch)" "$LOC" --root "$corebad" core

# GOOD: build-time tooling budget is codegen + modelcheck only.
toolinggood="$tmp/loc-tooling-good"
mkdir -p "$toolinggood/codegen" "$toolinggood/modelcheck"
for i in $(seq 1 1000); do echo "let c$i = $i;"; done > "$toolinggood/codegen/main.rs"
for i in $(seq 1 900); do echo "let m$i = $i;"; done > "$toolinggood/modelcheck/lib.rs"
expect 0 "tooling accepts 1900 LOC across codegen + modelcheck" "$LOC" --root "$toolinggood" tooling

# BAD: over-budget tooling must trip the new kill-switch.
toolingbad="$tmp/loc-tooling-bad"
mkdir -p "$toolingbad/codegen"
for i in $(seq 1 2100); do echo "let c$i = $i;"; done > "$toolingbad/codegen/main.rs"
expect 1 "tooling rejects a 2100-LOC codegen tree (kill-switch)" "$LOC" --root "$toolingbad" tooling

# Cross-contamination guards: each split scope counts only its own directories.
coreclean="$tmp/loc-core-cross-contamination"
mkdir -p "$coreclean/kernel" "$coreclean/drivers" "$coreclean/codegen"
for i in $(seq 1 10); do echo "let k$i = $i;"; done > "$coreclean/kernel/lib.rs"
for i in $(seq 1 10); do echo "let d$i = $i;"; done > "$coreclean/drivers/lib.rs"
for i in $(seq 1 6000); do echo "let c$i = $i;"; done > "$coreclean/codegen/main.rs"
expect 0 "core ignores a huge codegen tree" "$LOC" --root "$coreclean" core

toolingclean="$tmp/loc-tooling-cross-contamination"
mkdir -p "$toolingclean/drivers" "$toolingclean/codegen" "$toolingclean/modelcheck"
for i in $(seq 1 6000); do echo "let d$i = $i;"; done > "$toolingclean/drivers/lib.rs"
for i in $(seq 1 10); do echo "let c$i = $i;"; done > "$toolingclean/codegen/main.rs"
for i in $(seq 1 10); do echo "let m$i = $i;"; done > "$toolingclean/modelcheck/lib.rs"
expect 0 "tooling ignores a huge drivers tree" "$LOC" --root "$toolingclean" tooling

# Comments/blanks must not be counted: 2500 comment lines must PASS.
cmt="$tmp/loc-comments"
mkdir -p "$cmt/kernel"
for i in $(seq 1 2500); do echo "// filler $i"; done > "$cmt/kernel/lib.rs"
expect 0 "does not count comment lines" "$LOC" --root "$cmt" kernel

# Generated files must be excluded.
gen="$tmp/loc-generated"
mkdir -p "$gen/kernel"
{
  echo '// @generated by codegen'
  for i in $(seq 1 2500); do echo "let g$i = $i;"; done
} > "$gen/kernel/generated.rs"
expect 0 "excludes @generated files" "$LOC" --root "$gen" kernel

coregen="$tmp/loc-core-generated"
mkdir -p "$coregen/kernel" "$coregen/drivers"
for i in $(seq 1 10); do echo "let k$i = $i;"; done > "$coregen/kernel/lib.rs"
{
  echo '// @generated by codegen'
  for i in $(seq 1 4000); do echo "let d$i = $i;"; done
} > "$coregen/drivers/generated.rs"
expect 0 "core excludes @generated files" "$LOC" --root "$coregen" core

toolinggen="$tmp/loc-tooling-generated"
mkdir -p "$toolinggen/codegen" "$toolinggen/modelcheck"
{
  echo '// @generated by codegen'
  for i in $(seq 1 2500); do echo "let c$i = $i;"; done
} > "$toolinggen/codegen/generated.rs"
for i in $(seq 1 10); do echo "let m$i = $i;"; done > "$toolinggen/modelcheck/lib.rs"
expect 0 "tooling excludes @generated files" "$LOC" --root "$toolinggen" tooling

# `all` scope aggregates across dirs and uses the combined 8500 reporting budget.
allbad="$tmp/loc-all-bad"
mkdir -p "$allbad/kernel" "$allbad/drivers" "$allbad/codegen"
for i in $(seq 1 1900); do echo "let k$i = $i;"; done > "$allbad/kernel/lib.rs"
for i in $(seq 1 1900); do echo "let d$i = $i;"; done > "$allbad/drivers/lib.rs"
for i in $(seq 1 1900); do echo "let c$i = $i;"; done > "$allbad/codegen/main.rs"
expect 0 "kernel alone (1900) is within 2000" "$LOC" --root "$allbad" kernel
expect 0 "all reports 5700 total against the combined 8500 budget without enforcing" "$LOC" --root "$allbad" all

# Absent dirs are not an error (pre-W1).
mkdir -p "$tmp/loc-empty-root"
expect 0 "tolerates an absent kernel/ (pre-W1)" "$LOC" --root "$tmp/loc-empty-root" kernel

# Usage errors are exit 2, distinct from a budget failure.
expect 2 "rejects an unknown scope with exit 2" "$LOC" --root "$good" bogus-scope

# ---------------------------------------------------------------------------
# kernel-purity.sh
# ---------------------------------------------------------------------------
printf '\nkernel-purity.sh\n'

pgood="$tmp/purity-good"
mkdir -p "$pgood/kernel"
cat > "$pgood/kernel/lib.rs" <<'RS'
//! Generic interpreter. Mentions no domain concept.
pub fn fold(state: State, event: &Event) -> State {
    match event.kind {
        Kind::Started => state.begin(),
        Kind::Settled => state.settle(),
    }
}
RS
expect 0 "accepts a domain-free, pure kernel" "$PURITY" --root "$pgood"

# Domain vocabulary in a comment must NOT trip the gate.
pcmt="$tmp/purity-comment"
mkdir -p "$pcmt/kernel"
cat > "$pcmt/kernel/lib.rs" <<'RS'
// This interpreter is used by the implementer and validator lanes via git.
pub fn step(s: State) -> State { s }
RS
expect 0 "ignores domain words inside comments" "$PURITY" --root "$pcmt"

# BAD: domain vocabulary in code.
pdom="$tmp/purity-domain"
mkdir -p "$pdom/kernel"
cat > "$pdom/kernel/lib.rs" <<'RS'
pub fn dispatch(s: State) -> State {
    if s.lane_is_ready() { return s.spawn_implementer(); }
    s
}
RS
expect 1 "rejects domain vocabulary in kernel code" "$PURITY" --root "$pdom"

# BAD: impurity in code.
pimp="$tmp/purity-impure"
mkdir -p "$pimp/kernel"
cat > "$pimp/kernel/lib.rs" <<'RS'
pub fn stamp(s: State) -> State {
    let t = SystemTime::now();
    s.with(t)
}
RS
expect 1 "rejects SystemTime::now in the kernel" "$PURITY" --root "$pimp"

pimp2="$tmp/purity-impure-fs"
mkdir -p "$pimp2/kernel"
cat > "$pimp2/kernel/lib.rs" <<'RS'
pub fn load(p: &Path) -> Vec<u8> {
    std::fs::read(p).unwrap()
}
RS
expect 1 "rejects std::fs in the kernel" "$PURITY" --root "$pimp2"

pimp3="$tmp/purity-impure-env-current-dir"
mkdir -p "$pimp3/kernel"
cat > "$pimp3/kernel/lib.rs" <<'RS'
pub fn cwd() -> std::path::PathBuf {
    std::env::current_dir().unwrap()
}
RS
expect 1 "rejects std::env::current_dir in the kernel" "$PURITY" --root "$pimp3"

expect 0 "tolerates an absent kernel/ (pre-W1)" "$PURITY" --root "$tmp/loc-empty-root"

# ---------------------------------------------------------------------------
# no-inference.sh
# ---------------------------------------------------------------------------
printf '\nno-inference.sh\n'

ngood="$tmp/noinfer-good"
mkdir -p "$ngood/kernel"
cat > "$ngood/kernel/lib.rs" <<'RS'
//! State comes only from the log.
pub fn state(events: &[Event]) -> State {
    events.iter().fold(State::EMPTY, apply)
}
RS
expect 0 "accepts pure fold-based state" "$NOINFER" --root "$ngood"

# Every banned inference concept must reject both method-call syntax
# (`entry.exists()`) and bare field/identifier syntax (`entry.exists`).
readonly -a NOINFER_CONCEPT_FIXTURES=(
  exists
  try_exists
  is_file
  is_dir
  modified
  mtime
  created
  accessed
  metadata
  read_dir
  glob
  walkdir
  DirEntry
  file_stem
  extension
  file_name
  ends_with
  starts_with
  kill
  is_alive
  pid_exists
  latest
  most_recent
)

for concept in "${NOINFER_CONCEPT_FIXTURES[@]}"; do
  ncall="$tmp/noinfer-${concept}-call"
  mkdir -p "$ncall/kernel"
  cat > "$ncall/kernel/lib.rs" <<RS
pub fn infer(entry: &Entry) -> Step {
    if entry.${concept}() { Step::Continue } else { Step::Recover }
}
RS
  expect 1 "rejects ${concept}() call-form inference" "$NOINFER" --root "$ncall"

  nbare="$tmp/noinfer-${concept}-bare"
  mkdir -p "$nbare/kernel"
  cat > "$nbare/kernel/lib.rs" <<RS
pub fn infer(entry: &Entry) -> Step {
    let observed = entry.${concept};
    Step::from(observed)
}
RS
  expect 1 "rejects ${concept} bare-field inference" "$NOINFER" --root "$nbare"
done

# FIX-1 regression fixtures: these constructs used to be invisible because
# malformed ERE terms made grep exit 2 and the gate swallowed that failure.
nglob="$tmp/noinfer-glob"
mkdir -p "$nglob/drivers"
cat > "$nglob/drivers/lib.rs" <<'RS'
pub fn artifacts() -> Vec<PathBuf> {
    glob("runs/*/artifacts/*.json").unwrap().collect()
}
RS
expect 1 "rejects glob( artifact listing" "$NOINFER" --root "$nglob"

nkill="$tmp/noinfer-kill0"
mkdir -p "$nkill/drivers"
cat > "$nkill/drivers/lib.rs" <<'RS'
pub fn live() -> Step {
    if kill(0, None).is_ok() { Step::Continue } else { Step::Recover }
}
RS
expect 1 "rejects kill(0 liveness checks" "$NOINFER" --root "$nkill"

nstarts="$tmp/noinfer-starts-with"
mkdir -p "$nstarts/kernel"
cat > "$nstarts/kernel/lib.rs" <<'RS'
pub fn classify(file_name: &str) -> Step {
    if file_name.starts_with("implementation") { Step::Validate } else { Step::Implement }
}
RS
expect 1 "rejects starts_with(\"implementation filename prefixes" "$NOINFER" --root "$nstarts"

nsort="$tmp/noinfer-sort-by-modified"
mkdir -p "$nsort/drivers"
cat > "$nsort/drivers/lib.rs" <<'RS'
pub fn choose(mut artifacts: Vec<Artifact>) -> Option<Artifact> {
    artifacts.sort_by_key(|e| e.modified);
    artifacts.pop()
}
RS
expect 1 "rejects sort_by_key(|e| e.modified) ordering" "$NOINFER" --root "$nsort"

nread="$tmp/noinfer-read-to-string-state"
mkdir -p "$nread/drivers"
cat > "$nread/drivers/lib.rs" <<'RS'
pub fn infer() -> Step {
    if std::fs::read_to_string("runs/closed.marker").is_ok() { Step::Closed } else { Step::Open }
}
RS
expect 1 "rejects state inferred from std::fs::read_to_string" "$NOINFER" --root "$nread"

# Pattern-list errors must fail loudly before any source scan.
nmalformed="$tmp/noinfer-malformed-pattern-root"
mkdir -p "$nmalformed"
malformed_gate="$tmp/noinfer-malformed-pattern.sh"
awk '
  index($0, "sort_by_key") {
    print "  '\''glob('\''"
    next
  }
  { print }
' "$NOINFER" > "$malformed_gate"
chmod +x "$malformed_gate"
expect 2 "rejects a malformed no-inference pattern entry" "$malformed_gate" --root "$nmalformed"

# Exempt paths are allowed to touch the filesystem.
nex="$tmp/noinfer-exempt"
mkdir -p "$nex/drivers/fs"
cat > "$nex/drivers/fs/cache.rs" <<'RS'
pub fn drop_cache(p: &Path) {
    if p.exists() { let _ = remove_file(p); }
}
RS
expect 0 "permits the justified cache exemption" "$NOINFER" --root "$nex"

nmacro_good="$tmp/noinfer-kernel-macros-clean"
mkdir -p "$nmacro_good/kernel/macros/src"
cat > "$nmacro_good/kernel/macros/src/lib.rs" <<'RS'
pub fn type_suffix_is(value: &Type, expected: &str) -> bool {
    let Type::Path(TypePath { path, .. }) = value else {
        return false;
    };
    path.segments.last().is_some_and(|segment| segment.ident == expected)
}
RS
expect 0 "accepts the kernel macro AST type suffix helper" "$NOINFER" --root "$nmacro_good"

nmacro_bad="$tmp/noinfer-kernel-macros-real-violation"
mkdir -p "$nmacro_bad/kernel/macros/src"
cat > "$nmacro_bad/kernel/macros/src/lib.rs" <<'RS'
pub fn infer_from_listing(p: &Path) -> Step {
    if std::fs::read_dir(p).is_ok() { Step::Recover } else { Step::Continue }
}
RS
expect 1 "rejects real inference in the kernel macro file" "$NOINFER" --root "$nmacro_bad"

expect 0 "tolerates absent sources (pre-W1)" "$NOINFER" --root "$tmp/loc-empty-root"

# ---------------------------------------------------------------------------
# host-thinness.sh  (D78)
# ---------------------------------------------------------------------------
printf '\nhost-thinness.sh\n'

# GOOD: a pure transport adapter — forwards frames, decides nothing.
hgood="$tmp/host-good"
mkdir -p "$hgood/src"
cat > "$hgood/src/extension.ts" <<'TS'
export default function autopilotExtension(pi: Host): void {
  pi.registerCommand('autopilot', {
    async handler(args, ctx) {
      const reply = await core.request({ kind: 'command', payload: { args } });
      await applyEffects(reply, ctx);
    },
  });
}
TS
expect 0 "accepts a decision-free transport host" "$HOSTTHIN" --root "$hgood"

# GOOD: the sanctioned fail-closed guard default is not a "decision".
hguard="$tmp/host-guard"
mkdir -p "$hguard/src"
cat > "$hguard/src/guard.ts" <<'TS'
export async function onToolCall(event: E, ctx: C): Promise<Decision> {
  const reply = await core.requestWithTimeout({ kind: 'guard-query', payload: event }, 5000);
  if (reply === undefined) return { allow: false, reason: 'core-unavailable' };
  return reply.payload;
}
TS
expect 0 "permits the fail-closed guard default" "$HOSTTHIN" --root "$hguard"

# BAD: host derives state.
hstate="$tmp/host-state"
mkdir -p "$hstate/src"
cat > "$hstate/src/extension.ts" <<'TS'
function current(events: Event[]): State {
  return events.reduce(applyEvent, EMPTY);
}
TS
expect 1 "rejects state derivation in the host" "$HOSTTHIN" --root "$hstate"

# BAD: host schedules.
hsched="$tmp/host-sched"
mkdir -p "$hsched/src"
cat > "$hsched/src/extension.ts" <<'TS'
function dispatch(lanes: Lane[]): Lane | undefined {
  return selectReadyLane(lanes);
}
TS
expect 1 "rejects scheduling in the host" "$HOSTTHIN" --root "$hsched"

# BAD: host renders prompts / selects roles.
hrole="$tmp/host-role"
mkdir -p "$hrole/src"
cat > "$hrole/src/extension.ts" <<'TS'
const prompt = renderPrompt(selectRole(assignment), manifest);
TS
expect 1 "rejects role/prompt selection in the host" "$HOSTTHIN" --root "$hrole"

# BAD: host merges / CASes refs.
hmerge="$tmp/host-merge"
mkdir -p "$hmerge/src"
cat > "$hmerge/src/extension.ts" <<'TS'
await mergeCandidate(candidate, runMain);
TS
expect 1 "rejects integration logic in the host" "$HOSTTHIN" --root "$hmerge"

hverdict="$tmp/host-generic-verdict"
mkdir -p "$hverdict/src"
cat > "$hverdict/src/extension.ts" <<'TS'
export function localAcceptance(findings: string[]): "pass" | "fail" {
  return findings.length === 0 ? "pass" : "fail";
}
TS
expect 1 "rejects generic local pass/fail acceptance logic in the host" "$HOSTTHIN" --root "$hverdict"

# Decision vocabulary in a comment must NOT trip the gate.
hcmt="$tmp/host-comment"
mkdir -p "$hcmt/src"
cat > "$hcmt/src/extension.ts" <<'TS'
// Core owns fold( ), selectReadyLane, and mergeCandidate. The host only relays.
export const noop = 0;
TS
expect 0 "ignores decision words inside comments" "$HOSTTHIN" --root "$hcmt"

# BAD: host over budget.
hbig="$tmp/host-big"
mkdir -p "$hbig/src"
for i in $(seq 1 1400); do echo "export const v$i = $i;"; done > "$hbig/src/big.ts"
expect 1 "rejects a 1400-LOC host (budget 1200)" "$HOSTTHIN" --root "$hbig"

# Generated seam types must not count against the host budget.
hgen="$tmp/host-generated"
mkdir -p "$hgen/src"
{
  echo '// @generated by codegen'
  for i in $(seq 1 1400); do echo "export type T$i = $i;"; done
} > "$hgen/src/frames.ts"
expect 0 "excludes @generated seam types from the budget" "$HOSTTHIN" --root "$hgen"

expect 0 "tolerates an absent src/ (pre-W3)" "$HOSTTHIN" --root "$tmp/loc-empty-root"

# ---------------------------------------------------------------------------
# real-producers.mjs  (DEFECT-2 / F012)
# ---------------------------------------------------------------------------
printf '\nreal-producers.mjs\n'

rgood="$tmp/real-producers-good"
mkdir -p "$rgood/drivers/src/seam"
cat > "$rgood/drivers/src/seam/mod.rs" <<'RS'
fn dispatch(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    match frame.kind.as_str() { "command" => command(frame, state), "agent-result" => route_agent_result(frame, state), "task-completed" => route_task_completed(frame, state), other => done(frame.id, rejection("unknown-kind", other)), }
}
fn command(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    match parsed.route.driver.as_str() { "planning" => route_plan(frame.id, &parsed.args, state), "allocation-dispatch-runner" => route_run(frame.id, &parsed.args[0], state), other => done(frame.id, rejection("unknown-driver", other)), }
}
fn route_plan(id: u64, args: &[String], state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let dossier = p2_ground(&RepoGrounding { repo: current_dir()? }, &inventory)?;
    let assignments = planning_assignments(&args[0], &plan);
    let issue = planning_bg_action(assignments.first().unwrap(), state.state.revision);
    append_runner_invocation(state, &issue.binding)?;
    spawn(id, issue.action)
}
fn route_run(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> { let approved = read_approved_plan(workstream)?; let readiness = lane_readiness_from_events(&lanes, &approved, state); let resources = host_resource_facts()?; append_runner_invocation(state, &binding)?; spawn(id, action) }
fn route_agent_result(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> { accept_planning_carrier(frame.id, &assignment_id, carrier, state, None) }
fn route_task_completed(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> { let binding = binding_for(state, &payload.action_id, &payload.assignment_id)?; append_terminal_event(state, &payload, &binding)?; done(frame.id, state.summary()) }
fn accept_planning_carrier(id: u64, assignment_id: &Id, carrier: AgentCarrier, state: &mut CoreState, terminal: Option<&Payload>) -> Result<SeamEnvelope, AnyError> { done(id, "accepted".to_owned()) }
RS
expect 0 "accepts reachable routes backed by real producers and recorded spawns" node "$REALPROD" --root "$rgood"

rbad="$tmp/real-producers-bad"
mkdir -p "$rbad/drivers/src/seam"
cat > "$rbad/drivers/src/seam/mod.rs" <<'RS'
fn dispatch(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    match frame.kind.as_str() { "command" => command(frame, state), "agent-result" => route_agent_result(frame, state), "task-completed" => route_task_completed(frame, state), other => done(frame.id, rejection("unknown-kind", other)), }
}
fn command(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    match parsed.route.driver.as_str() { "planning" => route_plan(frame.id, &parsed.args, state), "allocation-dispatch-runner" => route_run(frame.id, &parsed.args[0], state), other => done(frame.id, rejection("unknown-driver", other)), }
}
fn route_plan(id: u64, args: &[String], state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let dossier = p2_ground(&RepoGrounding { repo: current_dir()? }, &inventory)?;
    let assignments = planning_assignments(&args[0], &plan);
    let issue = planning_bg_action(assignments.first().unwrap(), state.state.revision);
    let result = spawn(id, issue.action);
    return result;
    append_runner_invocation(state, &issue.binding)?;
}
fn route_run(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> { let approved = read_approved_plan(workstream)?; let readiness = lane_readiness_from_events(&lanes, &approved, state); let resources = host_resource_facts()?; append_runner_invocation(state, &binding)?; spawn(id, action) }
fn route_agent_result(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> { accept_planning_carrier(frame.id, &assignment_id, carrier, state, None) }
fn route_task_completed(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> { let binding = binding_for(state, &payload.action_id, &payload.assignment_id)?; append_terminal_event(state, &payload, &binding)?; done(frame.id, state.summary()) }
fn accept_planning_carrier(id: u64, assignment_id: &Id, carrier: AgentCarrier, state: &mut CoreState, terminal: Option<&Payload>) -> Result<SeamEnvelope, AnyError> { done(id, "accepted".to_owned()) }
RS
expect 1 "rejects a reachable route that records invocation only after spawn returns" node "$REALPROD" --root "$rbad"

# ---------------------------------------------------------------------------
# binary-parity.sh  (D81 source/artifact parity)
# ---------------------------------------------------------------------------
printf '\nbinary-parity.sh\n'

bgood="$tmp/binary-parity-good"
write_binary_parity_fixture "$bgood" current
expect 0 "accepts binaries rebuilt from the current tracked source hash" "$BINARY" --root "$bgood"

bbad="$tmp/binary-parity-stale"
write_binary_parity_fixture "$bbad" stale
expect 1 "rejects stale binary with a stale manifest source hash" "$BINARY" --root "$bbad"

buntracked="$tmp/binary-parity-untracked"
write_binary_parity_fixture "$buntracked" untracked
expect 1 "rejects an untracked Rust build input missing from the manifest hash" "$BINARY" --root "$buntracked"

bcargo="$tmp/binary-parity-cargo"
write_binary_parity_fixture "$bcargo" cargo
expect 1 "rejects a tracked Cargo.toml build-input change missing from the manifest hash" "$BINARY" --root "$bcargo"

bmtime="$tmp/binary-parity-newer-mtime"
write_binary_parity_fixture "$bmtime" newer-mtime
expect 0 "accepts matching sourceHash even when source mtimes are newer than binaries" "$BINARY" --root "$bmtime"

# ---------------------------------------------------------------------------

printf '\nselftest: %d passed, %d failed\n' "$passes" "$failures"

if [ "$failures" -gt 0 ]; then
  cat >&2 <<'EOF'

selftest.sh: GATE SELF-TEST FAILED.

  A gate that cannot reject its known-bad fixture is not a gate. W0 is not
  complete and W1 must not begin: the kill-switch cannot be trusted to fire.
EOF
  exit 1
fi

printf 'selftest: all gates accept good input and reject bad input.\n'
exit 0
