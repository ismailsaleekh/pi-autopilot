---
doc_id: subsystems/docs-freshness-gate
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Docs Freshness Gate

The deterministic, offline QA layer that keeps this package's agent-first docs always
current. It inverts the direction of truth: **code is authoritative; docs are checked
against code**, bidirectionally. A doc is "fresh" iff (a) it covers every code surface
it claims scope over, (b) it references nothing that no longer exists, and (c) any
change to a covered source is forced to surface as a regenerated region or a
re-attestation in the same change.

## Components

| File | Role |
|---|---|
| `scripts/docs-generate.mjs` | Emits every `GENERATED:*` region + `read-before-edit.md` + `manifest.json` from code (writes). |
| `scripts/docs-verify.mjs` | Runs checks C0–C11 in check mode; `--write` re-stamps hashes + rebuilds the manifest ONLY. |
| `scripts/docs/*.mjs` | Shared backbone: frontmatter parser, code-surface enumeration, two-tier hashing, fact-pins, references, model/manifest. |
| `docs/manifest.json` | Generated navigation + coverage index; byte-verified (C7). |
| `tests/package/docs-contract.test.ts` | The gate; invokes `docs-verify` in check mode inside `npm run test:package`. |
| `artifacts/docs-semantic/*.json` | Agentic semantic attestations, hash-checked by C11. |

## Two modes

Every doc region is exactly one of two modes, each with the strongest possible check:

1. **Generated (facts).** Command/tool/CLI lists, model roster, schema names, runtime
   paths, and default constants are emitted from code between `GENERATED:*` markers
   and asserted byte-equal to a fresh regeneration (C2). Factual drift is impossible.
2. **Authored (prose).** Concepts, invariants, and rationale are hand-written and
   fenced: every symbol/path they mention must still exist (C3), a signature fence
   fires on contract change (C4), and a body-hash change or same-change prose edit on
   a `behavioral` doc triggers an independent semantic review whose currency is
   enforced (C11). Any semantic-attestation artifact that exists is validated against
   the current doc id, covered-source hash, and source list so stale receipts fail
   even when the doc is not otherwise triggered.

## Check catalog (C0–C11)

| Check | Guarantee |
|---|---|
| C0 | Frontmatter parses against the schema; malformed → hard error, no skip. |
| C1 | Every code surface (constants + AST registration cross-check) is covered by a doc, and every `covers_surfaces` entry is a real surface. |
| C2 | Every `GENERATED:*` region is byte-equal to a fresh regeneration. |
| C3 | Every referenced symbol/path and every `covers_sources` entry resolves on disk. |
| C4 | The AST signature digest of `covers_sources` matches `signature_hash`; a mismatch without a same-change body edit fails (anti-self-certification). |
| C5 | Every fact-pin's compiled value equals `expect` and its `text` appears verbatim. |
| C6 | Every intra-docs / README→docs / gateway link + `#anchor` resolves. |
| C7 | `manifest.json` equals a fresh rebuild; no generated region has two owners. |
| C8 | The code-computed boundary set (surface exporters + `src/cli/*.ts` + `src/core/*/index.ts` barrels) is covered; the floor only ratchets up, and once full coverage is reached it latches (`full_coverage_required`) so any new boundary file is a hard failure until documented. |
| C9 | No banned stale phrase appears in authored prose. |
| C10 | `docs/` + gateway ship in the npm payload. |
| C11 | Every triggered `behavioral` doc has a current PASS semantic attestation keyed to the current `body_hash`; any stale existing attestation is rejected. |

## Determinism boundary

C0–C10 and C11's *enforcement* are fully deterministic (string-set membership,
byte-equality, AST digests, file/anchor existence, hash/JSON comparison): identical
pass/fail every run, no model, network, time, or randomness. Only the *production* of
a semantic attestation is agentic, and its output feeds a deterministic re-check — it
never influences the gate's determinism, only whether a current receipt exists.

## Author / refresh workflow

```bash
npm run build          # dist/ must be current; the gate reads compiled constants
npm run docs:generate  # regenerate GENERATED regions + read-before-edit + manifest
npm run docs:verify    # C0–C11 (deterministic, offline)
npm run docs:attest    # bounded re-stamp of signature_hash/body_hash + manifest
```

The gate is a natural validate-role witness in Autopilot's own quality loop: a
doc-touching unit runs `npm run docs:verify`, and the closure gate can require a
docs-contract PASS when a unit's `owned_paths` intersect `src/core/**` or `docs/**`.
