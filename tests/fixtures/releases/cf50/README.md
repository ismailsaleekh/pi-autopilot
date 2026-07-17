# Actual cf50 release fixture

`pi-autopilot-1.1.8-cf50.tgz` is the immutable release artifact staged as
`cf50-20260715T211057Z`. It is not reconstructed from current source. The
harness verifies its exact byte size, SHA-256 digest, package manifest, compiled
runtime constants, and required client/coordinator entrypoints before use.

The fixture exists only for bidirectional release-skew certification:

- actual cf50 client → current candidate coordinator;
- current candidate client → actual cf50 coordinator;
- mixed auto-start election between the two package generations.

The package `files` allowlist excludes `tests/`, and package/payload tests assert
that this tarball never enters the npm artifact.

Replacing this file requires a new release-fixture manifest and an explicit S1
contract/decision amendment. Do not regenerate it with `npm pack` or `git
archive` during tests.
