---
doc_id: cli/autopilot-agent-run
mode: mixed
review_policy: contract
covers_surfaces:
  - autopilot-agent-run
covers_sources:
  - bin/autopilot-agent-run.mjs
  - drivers/src/runner/child.rs
signature_hash: 'sha256:6a2b2a4d670b47bf0757d6cd542538122a0183d625023be72212d51161cfee73'
body_hash: 'sha256:247c9228a410e7156c9762ed3b6315024520cb445f813ffb83f331a712ca5606'
stability: stable
---

# `autopilot-agent-run`

`autopilot-agent-run` is the package-contained child-runner wrapper shipped by `pi-autopilot@1.3.1`.

## Synopsis

```bash
autopilot-agent-run --spec /absolute/path/to/autopilot.agent_run_spec.v1.json
```

The npm bin points to `bin/autopilot-agent-run.mjs`. The wrapper resolves only the sibling `bin/autopilot-core.mjs` inside the same physical package root and invokes:

```bash
node <package>/bin/autopilot-core.mjs agent-run --spec <absolute-spec>
```

There is no PATH, cwd, ancestor, `dist/`, `target/`, or source-checkout fallback.

## Contract

The Rust `agent-run` mode reads one strict `autopilot.agent_run_spec.v1` document, rejects unknown fields and identity/path drift, validates the role/mode/roster/tool allowlist, verifies deterministic prompt/spec/carrier paths, removes metered API-key route overrides, and launches `pi --mode json --no-session --no-extensions` directly.

A successful child run must emit exactly one final assistant result, followed by a successful `agent_end`. Planning results are validated against the requested planning boundary before the planning carrier is written. Delivery results must parse as `autopilot.delivery_result.v1` and match the lane/attempt/base/worktree identity before Core accepts them.

## Failure behavior

The wrapper exits nonzero if the contained core wrapper is missing or not a regular file. Core `agent-run` exits nonzero for malformed specs, missing prompts, stale carriers, roster drift, Pi spawn failure, Pi timeout, oversized stdout/stderr, malformed JSONL, provider/model drift, missing `agent_end`, boundary rejection, or carrier write failure.

## Related

- Runner subsystem: [`../subsystems/runner-and-forced-output.md`](../subsystems/runner-and-forced-output.md)
- Generated contracts: [`../generated/contracts.md`](../generated/contracts.md)
