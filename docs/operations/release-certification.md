---
doc_id: operations/release-certification
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - scripts/certify-runtime-repair.mjs
  - scripts/check-payload.mjs
signature_hash: 'sha256:17987c94a79011cfcb9fcf835367977709b749a88fce76034013332fbf327569'
body_hash: 'sha256:17987c94a79011cfcb9fcf835367977709b749a88fce76034013332fbf327569'
semantic_attestation: 'sha256:17987c94a79011cfcb9fcf835367977709b749a88fce76034013332fbf327569'
stability: evolving
---

# Operations: runtime-repair release certification

The runtime-repair certificate is scoped to one clean `pi-autopilot@1.3.1` candidate and one clean `pi-background-tasks@0.6.1` candidate. It proves the pair can run the real Pi SDK background integration with no network, no paid/metered API, deterministic tarballs, and installed-consumer parity.

## Driver

```bash
node scripts/certify-runtime-repair.mjs \
  --autopilot-root /absolute/path/to/pi-autopilot \
  --background-root /absolute/path/to/pi-background-tasks \
  --evidence-dir /absolute/external/evidence-dir
```

The driver refuses metered credential variables, requires absolute clean package roots, writes evidence outside both repositories, and fails if package commit/tree identity changes during certification. Payload certification treats `extensions/autopilot.ts` as the package-declared Pi entrypoint and requires it alongside the Host source, bin wrappers, generated contracts/add-on files, and shipped binaries. The offline security scan allowlists only exact reviewed install-script packages and three Pi 0.83 SDK nested-lock integrity exceptions. TypeBox is a Pi-provided peer (`peerDependencies.typebox="*"`) plus dev-only `typebox@1.3.7` for local compile/type tests; it must not appear as a runtime or bundled dependency.

## Ledger IDs expected by the SMF validator

The certificate at `/tmp/smf-resolution/autopilot-runtime-repair-cert.v1.json` uses format `pi-autopilot.runtime-repair-certificate.v1` and contains exactly these paired ledger rows:

1. `background-default-suite`
2. `autopilot-gates`
3. `autopilot-focused-rust`
4. `autopilot-rust-tests`
5. `autopilot-host-tests`
6. `runtime-integration`
7. `payload-and-pack-dry-run`
8. `reproducible-tarballs`
9. `installed-consumer-four-path-sdk`
10. `final-clean-identity`

Each row has `status: PASS`, `command_sha256`, and `report_sha256`. The certificate also binds package names, versions, package OIDs/trees, intended loaded runtime source `../packages/pi-autopilot`, no-paid/no-network booleans, zero-metered-credentials proof, and a canonical self-hash.

## What the certificate does not do

The package certificate does not emit the SMF authority seal and does not by itself make the superproject clean. The superproject still needs an operator-owned clean commit that pins both submodule gitlinks and updates `.pi/settings.json` to load the local `../packages/pi-autopilot` candidate.
