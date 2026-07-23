# Integration 6: docs/release contract

## Scope

Updated package-owned docs from current code and scripts for Wave-3/S2 release facts:

- versioned persisted-artifact ingress and BUG-177 `autopilot.unit_failure.v1` producer provenance;
- exhaustive S2 failure lanes, retry policies, and exact-scope behavior;
- permanent bidirectional cf50/current release-skew gate;
- S2-D mutable corpus clone/rehearsal isolation and Phase36 recovery dispositions;
- S2 retention archive, owned GC, and disk-pressure behavior;
- operations/troubleshooting and top-level release/test/publish instructions.

Generated regions (`docs/read-before-edit.md`, `docs/manifest.json`) were updated only through the official docs scripts.

## Non-doc release hygiene

While running `npm run test:package`, two package-gate regressions in the integrated code surfaced and were fixed:

- `bin/autopilot-s2-corpus-rehearsal.mjs` no longer imports `node:child_process`; it imports the contained compiled CLI directly.
- `tools/s2-corpus-rehearsal/candidate-worker.ts` now parses its worker input without double assertions; `dist/` was rebuilt.

## Validation run

- `npm run build` — PASS
- `npm run docs:generate` — PASS
- `npm run docs:verify` before hash re-stamp — expected C4 for new `docs/tools/s2-corpus-rehearsal.md`
- `npm run docs:attest` — PASS; re-stamped deterministic source/body hashes only
- `npm run docs:verify` — PASS
- `node scripts/docs-generate.mjs --check` — PASS
- `npm run production-git:check` — PASS
- `node --experimental-strip-types --test tests/package/type-safety.test.ts` — PASS
- `npm run test:package` — PASS

No independent semantic attestation was authored or claimed in this step; `semantic_attestation` remains `null` for the new doc in `docs/manifest.json`.
