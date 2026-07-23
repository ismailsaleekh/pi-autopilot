# S2-C release-skew fixture lane

This lane promotes the immutable previous published Autopilot package into a reusable
S2-C offline skew gate. The lane manifest points at the digest-pinned actual cf50
release tarball under `../cf50/`; it does not duplicate, rebuild, or synthesize a
predecessor package.

The S2-C tests verify:

- previous published client → current candidate coordinator;
- current candidate client → previous published coordinator;
- attach, heartbeat, exact idempotent replay, natural restart in both directions;
- one stable mixed-build auto-start election winner;
- fixture digest/size/package identity and exclusion from the npm payload.

The package `files` allowlist excludes `tests/`, so both this manifest and the
referenced previous-release tarball remain test-only release evidence.
