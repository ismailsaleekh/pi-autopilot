# Port law traces

This directory is the centrally owned semantic contract suite shared by fake
and real adapter test harnesses. It contains no simulation or adapter import.
Production adapters must not import these files at runtime; their D3 test driver
imports the vectors and implements `LawDriver`.

## Format

A `ContractVector` has:

- stable `id` and one of the six `port` names;
- a human-readable closed list of `behaviors` under test;
- `replay(driver)`, which performs declarative fixture requests, sends canonical
  frozen intents, records normalized `LawTraceEntry` values, and returns all
  findings without throwing.

A trace entry is:

```ts
{
  port: "store",
  operation: "install",
  result: "ok", // or "retry" / "rejected"
  facts: ["sealed-object-installed"],
}
```

Fixtures are explicit data variants (`tree`, `workspace`, `repository`,
`root-list`, `child-script`, `secret`). They are not adapter implementation
helpers. A driver must create the physical fixture independently, then the same
vector supplies the contract intents and assertions. Binary fixture bytes are
part of the vector.

`bindLawIntent` implements only the frozen action-ID derivation and returns
canonical inert JSON. It is test construction code, never an effect
implementation.

## Current vectors

| Port | Vector | Principal laws |
|---|---|---|
| workspace | `workspace.allocate-isolate-inspect-dispose.v1` | exclusivity, root/policy binding, inspect, fenced disposal |
| git | `git.materialize-seal-integrate-cas.v1` | immutable base, exact seal/compare, deterministic integration, CAS idempotency |
| child | `child.script-write-seal-exit-fence.v1` | identity-selected script, explicit ticks, seal-before-exit, fence |
| store | `store.atomic-install-range-page-presence.v1` | atomic install, duplicate install, exact binary range, sorted cursor page |
| clock | `clock.explicit-monotonic-advance.v1` | not-before retry, no implicit time, monotonic tick |
| secrets | `secrets.opaque-authorize-revoke.v1` | opaque bytes, child/epoch bind, idempotent revoke |

## Running against fakes and reals

The fake side uses `SimLawDriver`; `npm run sim:test` requires all six vectors to
return zero findings. W2 adapter owners implement a separate driver in the D3
test tree and replay `PORT_LAW_VECTORS` unchanged. Differential certification
compares the resulting law traces and validates fixture bytes through
`readArtifact`.

Changing a vector because a real adapter disagrees is a contract review, not an
adapter fix. Copying a fake algorithm into a real driver, or importing a real
operation into SimWorld, violates the law-trace architecture even if tests turn
green.
