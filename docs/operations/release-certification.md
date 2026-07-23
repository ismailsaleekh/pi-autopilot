---
doc_id: operations/release-certification
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - scripts/run-certified-command.mjs
  - scripts/check-production-git-spawns.mjs
  - scripts/security-scan.mjs
  - scripts/generate-sbom.mjs
  - scripts/check-package-payload.mjs
  - scripts/verify-packed-consumer.mjs
  - scripts/test-packed-consumer-release.mjs
signature_hash: 'sha256:ff6dc0cb79ae5ce4eda7c19477ad3f1c9bbbf94c832f5b43564814ef7401be2b'
body_hash: 'sha256:ff6dc0cb79ae5ce4eda7c19477ad3f1c9bbbf94c832f5b43564814ef7401be2b'
semantic_attestation: 'sha256:ff6dc0cb79ae5ce4eda7c19477ad3f1c9bbbf94c832f5b43564814ef7401be2b'
stability: evolving
---

# Operations: Release Certification

Release certification proves an **exact candidate commit** builds, tests, packs, and
ships cleanly with no metered credentials, no forbidden network, and no candidate
drift. It is driven by the certified-command wrapper and a set of offline evidence
lanes. Certification is scoped to one exact commit/tree; a later descendant is **not**
covered by an earlier certificate.

## Certified-command wrapper

`scripts/run-certified-command.mjs` runs one sealed command under strict containment.
It requires `--evidence-dir <abs>`, `--id <bounded-id>`, `--timeout-ms`, and
`--max-rss-bytes`, followed by `-- <literal argv>`. It also accepts an optional,
repeatable `--artifact <abs-path>` that hashes each declared file (SHA-256) and records
it in the report as `declared_artifacts` for the audit trail. It:

- refuses metered-model credentials in the environment (the explicit list
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`,
  `GEMINI_API_KEY`, plus the wider metered pattern) and records a credential proof;
- requires the evidence root to be **outside** and not containing the candidate clone,
  and writes each report exactly once (`O_EXCL`, fsync, atomic rename);
- seals the candidate identity (commit, tree, working-tree status hash) **before** and
  **after** the command and flags `candidate-mutated` on any drift;
- monitors the whole process tree for `timeout`, `rss-limit`, `descendant-survived`,
  `process-discovery-failed`, `spawn-unconfirmed`, and kernel-rusage breaches;
- forbids network on non-network lanes via a preload that denies `net`/`tls`/`http`/
  `https`/`dgram`/`fetch` and trips a `network-access` breach if a canary marker
  appears. Only the `install` and `security-audit` lanes (`NETWORK_LANES`) skip that
  deny-network preload; for them the wrapper sets npm offline/audit flags and labels the
  lane `AUTOPILOT_CERTIFIED_NETWORK: 'registry-only'` and forwards proxy/registry env,
  but it does **not** itself enforce a registry-host egress allowlist — "registry-only"
  is the lane's intended use, enforced by npm configuration, not a wrapper-level network
  filter.

### Short-runtime root + unconditional cleanup

The wrapper creates its ephemeral runtime root under a **short private `TMPDIR`**
outside the evidence tree (a runtime root below the evidence directory can make the
production coordinator socket unbindable). The runtime root is removed
**unconditionally** in a `finally` block; durable reports and logs remain in the
externally sealed evidence root. A cleanup failure is itself recorded and fails the
report.

### Verdict

A report `passed` is true only when there was no spawn error, no breach, no cleanup
error, the child close was observed, the exit code was `0`, and there was no exit
signal. `passed: true` with a written report is the only certification signal — a bare
process exit 0 without a report is not a verdict.

## Production Git scan

`npm run production-git:check` (`scripts/check-production-git-spawns.mjs`) proves the
shipped runtime performs **zero raw production Git spawns**: all Git goes through the
package's guarded Git process layer. The scanner has narrow, explicit owner allowances
for the docs and certification scripts and emits the final scanner scope (scanned roots
and approved process owners) in its report.

## Deterministic packs and packed-consumer proof

The packed-consumer scripts build one npm pack, install it into a throwaway consumer
(`scripts/test-packed-consumer-release.mjs` builds and installs the tarball;
`scripts/verify-packed-consumer.mjs` loads it), and prove source/dist parity, that the
extension **registers** the exact public Autopilot command set (via the host
`registerCommand` callbacks, not command execution), zero network/provider calls
(network + provider canaries trip loudly), an untouched discovery canary, zero raw
production Git spawns, and the exact Pi peer. The byte-identical two-pack determinism
check is part of the surrounding release-certification **procedure** (build two packs in
separate external directories and compare bytes), not of these scripts. The docs payload
changes the tarball, so
**the Phase 38 pack hash must not be reused as the expected Phase 39 hash** — recompute
it for the current candidate.

## Security scan / audit / SBOM / payload

- `npm run security:scan` (`scripts/security-scan.mjs`) is the **offline** scan; it must
  report no findings. It checks `package-lock.json` for non-registry sources, missing
  integrity, and unapproved install scripts by comparing each entry's version + integrity
  against a `reviewedInstallScripts` allowlist (it does not read install-script source
  bodies).
- `npm run security:audit` (`npm audit --audit-level=high`, external npm registry
  behavior, not owned by these scripts) runs with registry access. As of the Phase 38
  certification the high threshold passed and the run reported one visible moderate
  `protobufjs@7.6.4` advisory; because this reflects live registry advisory state, treat
  it as the historical certification record, re-run it for the current candidate, and
  document whatever it reports rather than ever claiming "zero vulnerabilities."
  (`scripts/security-scan.mjs` separately holds `protobufjs@7.6.4` in its
  `reviewedInstallScripts` version+integrity allowlist.)
- `npm run sbom` (`scripts/generate-sbom.mjs`) generates a CycloneDX 1.5 SBOM at
  `artifacts/security/cyclonedx-sbom.json`.
- `npm run payload:check` (`scripts/check-package-payload.mjs`) verifies the published
  payload manifest.

## Phase 38 historical certification record

> The facts in this section are the **external Phase 38 certification evidence record**
> (evidence root `~/.pi/r38/e/phase38-d65-autopilot-cert-7ececa1`), not values computed
> by the scripts covered by this doc. They are recorded here as the historical release
> ledger.

The Phase 38 local package implementation and its exact-candidate certification are
complete at these exact facts:

- Certified commit `7ececa115cae39828f72667b4ea0885780cd9f23`, tree
  `1964bdca7a75c4146b95d039c0d42757e776edaa`.
- 21/21 sealed command reports passed; full offline gate 931 tests / 158 suites / 0
  failures.
- Focused D65: 170 tests / 40 suites (stream 28/5, extract 6/2, graph 95/25, cap 41/8);
  multiprocess 124 tests / 18 suites.
- Scale corpus passed: 100,000 events, 10,000 contested requests, 32 logical clients,
  frozen under a 60-second bound.
- Two tarballs byte-identical; packed consumer passed nine exact commands with
  source/dist parity, zero network calls, an untouched discovery canary, zero raw
  production Git spawns, and Pi peer `0.81.1`.
- Offline security scan passed with no findings; the high-threshold audit passed with
  one visible moderate `protobufjs@7.6.4` advisory; a CycloneDX 1.5 SBOM was generated;
  no metered credentials were present; only the npm install/audit lanes used
  registry-only network.

## Exact-candidate invalidation rule

> This rule is a release-governance policy (D65/D67 doctrine), not a value the covered
> scripts compute; `run-certified-command.mjs` only seals the *current* candidate's
> commit/tree/status at runtime.

The Phase 38 certificate covers **only** commit `7ececa1` / tree `1964bdc`. The Phase 39
docs-integrated descendant is a different commit/tree and is **not** covered by that
certificate. Do not claim current-package release certification until the exact current
candidate is re-run through the full certified-command driver with clean pre/post seals.

## External release blockers

> These are external governance/status caveats, not facts established by the covered
> scripts. They remain external to this package's local scope and are not satisfied by
> any local run:

- the actual authorized private C5;
- hosted Windows Node 22/24 CI;
- exact-current-candidate release recertification;
- release-lead authorization, version tag, and npm publication;
- live-provider witnesses where required.

## Enforced in

- `scripts/run-certified-command.mjs`, `scripts/check-production-git-spawns.mjs`,
  `scripts/security-scan.mjs`, `scripts/generate-sbom.mjs`,
  `scripts/check-package-payload.mjs`, `scripts/verify-packed-consumer.mjs`,
  `scripts/test-packed-consumer-release.mjs`.

## Related

- [crash-recovery.md](crash-recovery.md), [start-run.md](start-run.md)
- Concepts: [`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md),
  [`../concepts/d65-terminal-tail.md`](../concepts/d65-terminal-tail.md)
- Release ledger: [`../../TEST_PLAN.md`](../../TEST_PLAN.md),
  [`../../PUBLISHING.md`](../../PUBLISHING.md)
