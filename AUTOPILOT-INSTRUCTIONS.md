<p align="center">
  <img src="logo.png" alt="Autopilot" width="128" height="128" />
</p>

# Autopilot — Mandatory Agent Instructions

**Read this before you read code, edit code, or run anything in this package.**
These docs are written for AI agents working *on* `pi-autopilot`, not for humans.
They are optimized for fast, deterministic navigation from behavior → source, and
they are kept current mechanically by a docs-freshness gate (checks C0–C11).

---

## Required read order

1. **[`docs/INDEX.md`](docs/INDEX.md)** — the machine-navigable surface + subsystem
   index. Generated from code; it is the map of every command, tool, CLI, schema,
   and subsystem.
2. **[`docs/read-before-edit.md`](docs/read-before-edit.md)** — the source-path →
   owning-doc read-gate. Before editing any covered source file, open its owning
   doc first.
3. The specific `docs/` entry for the surface or subsystem you are touching.

`docs/manifest.json` is the O(1) machine index: `surface_to_docs`,
`source_to_docs`, and per-doc `{mode, review_policy, hashes}`. Load it directly for
navigation instead of grepping prose.

---

## Hard rules (non-negotiable)

- **Docs are checked against code, never the reverse.** The surface inventory is
  enumerated from exported constants + a TypeScript-AST pass. If you change a
  covered source, the gate forces a matching doc update. Do not "fix" the gate by
  weakening a check.
- **Facts are generated, prose is fenced.** Regions wrapped in
  `<!-- GENERATED:x START … -->` are emitted from code by `scripts/docs-generate.mjs`
  and byte-verified. Never hand-edit them; run `npm run docs:generate`.
- **No silent fallbacks.** An unparseable doc, unresolved reference, or stale hash
  is a loud, hard failure. Never add a skip/try-catch-pass to make the gate green.
- **No self-certification.** A covered-signature change must ship with a same-change
  doc-body edit; behavioral docs additionally require an independent semantic
  attestation keyed to the current source bytes.
- **Parent vs child tools are distinct.** `context_budget` and
  `autopilot_respond_claim_request` are parent-session tools; `autopilot_emit_status`
  and `autopilot_materialize_context` are child-runner-only. Do not cross them.
- **Runtime state lives under `~/.pi/agent/autopilot/`** and per-workstream runtime
  under `.pi/autopilot/<workstream>/`. Close/abort are local-only (no fetch, push,
  or PR).
- **Never route child work through paid/metered frontier APIs.** GPT/Codex and
  Claude-class work uses Pi subscription channels only.

---

## Keeping docs current (the workflow)

```bash
npm run build          # dist/ must be current; the gate reads compiled constants
npm run docs:generate  # regenerate GENERATED regions + read-before-edit + manifest
npm run docs:verify    # run C0–C11 (deterministic, offline); fails loud on drift
npm run docs:attest    # bounded: re-stamp signature_hash/body_hash + rebuild manifest
```

The gate also runs inside `npm run test:package` (hence `npm run test`) and
`prepack`, so stale docs block publish. See
[`docs/subsystems/docs-freshness-gate.md`](docs/subsystems/docs-freshness-gate.md)
for the full check catalog and the deterministic/agentic boundary.
