# D77 gate scripts

Independent referees for the [D77](../../../../plans/active/autopilot-extension/autopilot-kernel-architecture-and-agent-execution-plan-2026-07-27.md)
implementation. They enforce the structural budgets and architectural
invariants that the whole convergence property depends on.

## The scripts

| Script | DoD | Enforces |
|---|---|---|
| `loc.sh kernel` | S1 | Core kernel ≤ 2,000 LOC — **the W1 kill-switch** |
| `loc.sh core` | S2 | Shipped Core (`kernel/` + `drivers/`) ≤ 6,500 LOC |
| `loc.sh tooling` | S2b | Build-time tooling (`codegen/` + `modelcheck/`) ≤ 2,000 LOC |
| `loc.sh all` | report | Combined total across kernel, drivers, codegen, and modelcheck; reports against 8,500 LOC, not an enforcement scope |
| `kernel-purity.sh` | S4, F1 | Kernel names no domain concept; performs no IO |
| `no-inference.sh` | B4 | State comes only from `fold(events)` |
| `host-thinness.sh` | S7 | TS Host ≤ 1,200 LOC and **decides nothing** (D78) |
| `readable-source.mjs` | readable-a | Recurrence gate for packed macros, rustfmt suppression, hidden includes, escaped runtime strings, and overlong handwritten behavior |
| `binary-parity.sh` | D81 | Shipped `binaries/` artifacts match current tracked Rust source and manifest fingerprints |
| `selftest.sh` | S0 | Proves the D77 gates above actually work |
| `readable-source-selftest.mjs` | readable-a | Isolated clean/mutated fixtures for `readable-source.mjs` |

All gates exit `0` on pass, `1` on violation, `2` on usage error. Absent
directories are not a failure, so the gates are safe to run from W0 onward.

D79 §13 records the W3 S2 breach as a budget mis-apportionment, not a budget
raise: D77's own sketch allocated kernel ≤ 2,000 plus drivers ~1,700 while also
mandating build-time `codegen` and `modelcheck` with no separate line item. The
split keeps shipped Core and verification tooling separately bounded, with
selftest fixtures proving both new kill-switches fire, while `loc.sh all` still
reports the combined total so no line is hidden.

D80 then corrected D77 §2's remaining internal inconsistency: the sketch had
already allocated 3,700 LOC of kernel + drivers against a stated 3,500 Core
ceiling, before the measured D76 §13 driver scope was reconciled. The corrected
6,500 Core ceiling is evidence-based on 15 delivered modules, leaves the frozen
2,000-LOC kernel budget untouched, and follows four re-cuts that recovered 628
LOC before the figure changed. `selftest.sh` pins that correction with a Core
over-budget fixture and an independent kernel over-budget fixture, so this is a
budget with its own observed kill-switch, not a pressure raise.

## Why `selftest.sh` exists

A referee that silently passes everything is worse than no referee: it
manufactures false confidence exactly when a budget is being blown.

This is not hypothetical. It is:

- the shape of BUG-179 through BUG-182 and F012 — an acceptance boundary never
  exercised by the thing it judged; and
- the `retrofit_cascading` failure class — under pressure, the agent that blows
  a budget "fixes" the script that measures it.

So every gate is proven against a known-**good** fixture it must accept *and* a
known-**bad** fixture it must reject. `selftest.sh` builds both in a temp dir and
asserts the exit codes.

**This already paid for itself.** The first run caught a real defect: the purity
gate used a word-boundary regex, so `spawn_implementer()` and `lane_is_ready()`
slipped through — domain vocabulary embedded *inside* an identifier, which is
exactly how the boundary leaks in practice. The match is now substring-based.
A later run caught `no-inference.sh` swallowing malformed regex terms; inference
concepts are now fixed-substring matched, and pattern entries are validated before
scanning.

`no-inference.sh` matches banned concepts as fixed substrings against
comment-stripped source. A concept such as `exists` therefore catches both
`x.exists()` and the bare field/identifier form `x.exists`; adding a concept
requires adding selftest fixtures for both forms.

## W0 obligation

`selftest.sh` must exit 0 before W1 begins. A gate that cannot reject its
known-bad fixture means **the kill-switch cannot be trusted to fire**, and W1
must not start.

```bash
./scripts/gates/selftest.sh     # must exit 0 — W0 gate (113/113 fixtures)
```

## Readable-source recurrence gate

`readable-source.mjs` is wired into `gate:release` without changing any LOC
budget. It scans production handwritten Rust/TypeScript/JavaScript under
`codegen/src`, `modelcheck/src`, `kernel/src`, `drivers/src`, and `src`; skips
only files with a generated marker in the first five lines; and reports loud
`path:line/class` violations. Allowed controls are deliberately exact: KDL data
through `include_str!(...data/*.kdl)`, top-level `README.md`/`LICENSE` plain-text
includes, and two documented declarative vocabulary lines in
`codegen/src/contracts.rs`. Any new exemption must be exact and covered by
`readable-source-selftest.mjs`.

```bash
node scripts/gates/readable-source-selftest.mjs
node scripts/gates/readable-source.mjs
```

## The host boundary (D78)

Pi loads extensions as **TypeScript modules**, so Rust cannot be the Pi extension.
Autopilot therefore ships as a thin TS **Host** (the extension) plus a Rust **Core**
binary over a typed stdio JSON-RPC seam.

The risk is that the Host slowly re-acquires semantics until it becomes a second
orchestrator that disagrees with Core. `host-thinness.sh` prevents that by banning
decision vocabulary — state derivation, workflow/lane/candidate names, scheduling,
merge/CAS, verdicts, and role/prompt selection — from Host source.

The **one** sanctioned Host decision is the fail-closed guard default: when Core is
unavailable or times out, the `tool_call` guard denies. Failing open would breach two of
the eight D76 §10 hard boundaries, so this is hardcoded and pinned by its own fixture.

## Rules

1. **Never edit a gate to make a wave pass.** Exceeding the kernel budget is a
   halt-and-report condition; the response is to move logic into declarative
   data or a driver, never to raise the ceiling.
2. **Never delete a banned term** from `kernel-purity.sh` or `no-inference.sh`
   to clear a violation.
3. **Exemptions must be justified.** `no-inference.sh` carries an
   `EXEMPT_SUFFIXES` list only for disposable-cache and safe-cleanup paths.
   Each entry names its file and its reason, and an exempted file must still
   never set run/lane/candidate state. Lexical collisions in other files must
   be renamed or narrowed, not hidden by a whole-file exemption.
4. **Changing a gate requires re-running `selftest.sh`**, plus a new fixture
   covering the behavior that changed.

## Counting rules (`loc.sh`, `host-thinness.sh`)

Deliberately conservative — it over-counts rather than under-counts, so the
gate cannot be gamed by formatting.

- `loc.sh` counts `.rs`; `host-thinness.sh` counts `.ts`/`.mts` under `src/`.
  Declarative data is **not** code and is not counted.
- Excludes blank lines, whole-line `//` / `//!` / `///`, and whole-line `/* */`.
- Includes everything else, including `use`, `#[derive]`, and braces.
- `loc.sh` excludes every path component named `tests` (for example
  `<crate>/tests/**` and nested `src/**/tests/**` fixtures) but not lookalike
  components such as `tests_support` or `contest`.
- Excludes files marked `// @generated by codegen` in the first 5 lines.
- Does **not** exclude `#[cfg(test)]` modules — test code in a source file
  counts against the budget, which discourages hiding logic in test-gated
  modules.
