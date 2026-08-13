# adapters/secrets

`SecretsAdapter` is an opaque in-process handle broker. Registration copies
secret bytes into a private map. Contract observations contain only secret
handles, policy digests, lease ids, and revocation state. The only byte-bearing
surface is `useLease()`, which provides a fresh private copy directly to a
caller-supplied consumer and returns no bytes.

Lease use rechecks the bound child/epoch capability immediately before exposing
a fresh copy. Errors are fixed diagnostics: caught exceptions and consumer
failures are never stringified. Revocation is idempotent. The broker stores no workflow meaning;
its mutable records are only physical secret/lease capability state.
