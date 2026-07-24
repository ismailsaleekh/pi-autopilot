---
doc_id: cli/autopilot-launch-signer
mode: authored
review_policy: contract
covers_surfaces:
  - autopilot-launch-signer
covers_sources:
  - src/cli/autopilot-launch-signer.ts
signature_hash: 'sha256:8dd8f0c31fd32f1ea7122401f9820d2c23c2ec20bfc6c45264185616dc389d7b'
body_hash: 'sha256:495a4d23390356968deb83c251a67679a4071f6df605b9c563209bad3216b281'
stability: evolving
---

# `autopilot-launch-signer`

The external operator/control-plane launch signer for D65. It is the **only**
component that possesses the operator's private PKCS#8 signing key. It is a
distinct compiled bin (`dist/src/cli/autopilot-launch-signer.js`), never a
runtime module and never a test helper, and it never invokes a model or paid
API.

## Purpose

Production runtime must never possess or read the private signing key and must
never self-sign policy, heartbeat, continuation, or capacity authority. The
launch signer holds the mode-0600 key **outside** every clone/state/session/
evidence root, reads the live coordinator status/doctor/policy identity for a
run, builds the canonical unsigned `autopilot.launch_policy.v1` /
`autopilot.program_heartbeat.v1` bytes, signs them with the operator key, and
writes the signed candidate to the exact evidence path the runtime consumes. The
runtime only **verifies** and **consumes** the signed bytes through the frozen
`accept-program-heartbeat` / `register-authoritative-artifact` store surfaces.

## Synopsis

`autopilot-launch-signer --config <absolute-mode-0600-config> --request <json>`

- `--config` (or `AUTOPILOT_LAUNCH_SIGNER_CONFIG`) names a mode-0600, one-link,
  no-follow `autopilot.launch_signer_config.v1` file that binds the private key
  path, program/roster/package/B0 identity, trust anchor ref/digest, evidence
  root, policy id/path, and the sealed policy issue timestamp.
- `--request` is a closed JSON request: either a `launch-policy` request (naming
  the run state root, repo/run, policy id/ref, and expected sealed policy
  digest) or a `program-heartbeat` request (naming the run state root, repo/run,
  the graph sequence/digest to govern, and the exact next heartbeat sequence).

## Behavior

- Reads the config and key through mode-checked, no-follow, one-link,
  descriptor-identity-checked reads; a symlink, wrong mode, or oversized file
  fails closed.
- For a `launch-policy` request, it reads the live accepted bootstrap artifact,
  builds the exact cap-one policy (`parallel_cap`, `maximum_parallel_cap`, and
  `expected_checkout_units` all `1`), signs it with domain
  `AUTOPILOT-D65-LAUNCH-POLICY\0`, and re-parses its own output before writing.
- For a `program-heartbeat` request, it reads the live accepted policy, run,
  attached dispatch session, and current status/doctor semantic digests, builds
  the signed heartbeat with domain `AUTOPILOT-D65-PROGRAM-HEARTBEAT\0`, and
  binds the exact graph sequence/digest the runtime is accepting.
- Emits exactly one `autopilot.launch_signer_result.v1` JSON line naming the
  ref, absolute path, digest, and byte count of the written signed candidate.
- Supports heartbeat renewal during the run: each renewal request names the next
  contiguous heartbeat sequence and the current governing graph tuple.

## Isolation invariants

- The runtime never learns the key path; it passes only the signing request and
  reads the signed candidate the signer wrote.
- The signer never mutates coordinator authority: it only reads status/doctor
  and writes signed evidence files. Acceptance is the runtime's frozen job.
- The signer never invokes a model or paid API and inherits no metered
  credentials.

## Related

- Concept: [`../concepts/dispatch-and-recovery-authority.md`](../concepts/dispatch-and-recovery-authority.md),
  [`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md)
- Operations: [`../operations/start-run.md`](../operations/start-run.md)
- Command: [`../commands/autopilot.md`](../commands/autopilot.md)
