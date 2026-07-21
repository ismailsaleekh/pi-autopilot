# Docs semantic attestations

These artifacts are the **agentic** half of the docs freshness gate's
detection / judgment / enforcement boundary (design D67, check **C11**).

- **Detection + enforcement are deterministic** and live in
  `scripts/docs-verify.mjs`: for every `review_policy: behavioral` doc whose
  covered-source `body_hash` has changed since its recorded review, C11 asserts an
  attestation here whose `reviewed_body_hash` equals the *current* body hash and
  whose `verdict` is `PASS`. A missing or stale attestation fails the gate loudly.
- **Judgment is agentic**: the *content* of the review (does the prose still describe
  the code correctly?) is produced by an independent Pi validate-role review. It is
  offline and never in the deterministic CI path; it only decides whether a current
  PASS receipt exists.

## Contract (`autopilot.docs_semantic_attestation.v1`)

```jsonc
{
  "schema_version": "autopilot.docs_semantic_attestation.v1",
  "doc_id": "subsystems/coordination",          // == the doc's frontmatter doc_id
  "reviewed_body_hash": "sha256:…",              // must equal the current covers_sources body_hash
  "verdict": "PASS",                              // only PASS clears C11
  "reviewer": "validate-role (offline agentic review)",
  "reviewed_at": "2026-07-21T00:00:00.000Z",
  "covers_sources": ["src/core/coordination/…"],
  "notes": "why the prose still matches the code"
}
```

The file name is the `doc_id` with `/` replaced by `__`, e.g.
`subsystems/coordination` → `subsystems__coordination.json`.

## Producing a fresh attestation

1. Compute the current body hash of the doc's `covers_sources`:
   `node -e "import('../../scripts/docs/hashing.mjs').then(m => console.log(m.computeCoverHashes(['src/…']).bodyHash))"`.
2. Have an independent validate-role review read the covered source + the doc prose.
3. On PASS, write this artifact with `reviewed_body_hash` set to that hash.
4. `npm run docs:verify` re-checks currency deterministically.

## Anti-self-certification

The source-changing author cannot self-sign: C4's git-aware guard already requires a
same-change doc-body edit on a contract change, and C11's receipt must be produced by
a review keyed to the exact current bytes. Re-hashing without re-reading is forbidden.

> These baseline attestations are committed deliberately. The directory is otherwise
> gitignored (`artifacts/*` with an allowlist); commit new attestations explicitly.
