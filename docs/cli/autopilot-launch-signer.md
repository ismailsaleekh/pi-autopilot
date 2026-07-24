---
doc_id: cli/autopilot-launch-signer
mode: authored
review_policy: contract
covers_surfaces:
  - autopilot-launch-signer
covers_sources:
  - src/cli/autopilot-launch-signer.ts
signature_hash: 'sha256:279a789983604ed3d9b43040cc4bed1bbad75983311ed32e183d2ca5bbc38c65'
body_hash: 'sha256:ed85d85ce3be406ae8b718faaa1269a7bfeda98da43cd12546abf3a8819c3c29'
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
  root, policy id/path, and the sealed policy issue timestamp. Its state, session,
  and evidence roots must be existing canonical absolute directories; program
  rows must be workstream-byte-sorted without duplicates, and the own row must
  exactly match the config's workstream/run/state/repo authority.
- `--request` is a closed JSON request: either a `launch-policy` request (naming
  the canonical run state and session roots, repo/run, policy id/ref, and expected
  sealed policy digest) or a `program-heartbeat` request (naming those same roots
  and repo/run, the graph sequence/digest to govern, and the exact next heartbeat
  sequence). Repo ids and run ids use the shared closed launch grammar.

## Behavior

- Reads the config and key through mode-checked, no-follow, one-link,
  descriptor-identity-checked reads; a symlink, wrong mode, or oversized file
  fails closed. Before any coordinator query or key read, the request state and
  session roots must exactly equal the canonical config roots, and a policy
  request's id/ref must exactly equal the sealed config id/ref.
- For a `launch-policy` request, it reads the live accepted bootstrap artifact,
  builds the exact cap-one policy (`parallel_cap`, `maximum_parallel_cap`, and
  `expected_checkout_units` all `1`), signs it with domain
  `AUTOPILOT-D65-LAUNCH-POLICY\0`, and re-parses its own output before writing.
- For a `program-heartbeat` request, it reads the live accepted policy, run,
  attached dispatch session, and current status/doctor semantic digests, builds
  the signed heartbeat with domain `AUTOPILOT-D65-PROGRAM-HEARTBEAT\0`, and
  binds the exact graph sequence/digest the runtime is accepting. Every launched
  foreign row re-reads its own accepted signed heartbeat bytes and takes both
  graph fields from that one row authority; if a newer graph artifact exists,
  the row is fenced with `graph-drift` instead of combining mismatched facts.
- Emits exactly one `autopilot.launch_signer_result.v1` JSON line naming the
  ref, absolute path, digest, and byte count of the written signed candidate.
- Supports heartbeat renewal during the run: each renewal request names the next
  contiguous heartbeat sequence and the current governing graph tuple.

## Isolation invariants

- The runtime never learns the key path; it passes only the signing request and
  reads the signed candidate the signer wrote. The key's canonical path must be
  outside source/Git/worktree/runtime/evidence authority and both the config and
  request state/session roots.
- The signer never mutates coordinator authority: it only reads status/doctor
  and writes signed evidence files. Acceptance is the runtime's frozen job.
- The signer never invokes a model or paid API and inherits no metered
  credentials.

## Related

- Concept: [`../concepts/dispatch-and-recovery-authority.md`](../concepts/dispatch-and-recovery-authority.md),
  [`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md)
- Operations: [`../operations/start-run.md`](../operations/start-run.md)
- Command: [`../commands/autopilot.md`](../commands/autopilot.md)
