# Architecture Amendment 001 — W1 Recovery and Integration

**Scope:** restore trusted W0 governance; close the W1 L3 mutable-manifest
self-certification hole; land the six operator-ratified integration seams; adopt
CAR-L3-1 and CAR-L3-2; and regularize/re-verify surviving L2 and L3 work.

**Operator authority:** explicitly pre-approved in the W1-R Recovery & Integration
owner prompt. This marker is executed only with the documented amendment command
and the session-scoped approval environment value.

The protected-file list below is exact. `protected-files.json` is included because
the amendment regenerates it; this marker includes itself because approval scope
must remain protected in every successor baseline.

```architecture-amendment
{
  "format": 1,
  "id": "001",
  "operatorApproval": "W1-R Recovery & Integration owner prompt: operator-granted Amendment 001 authority",
  "rationale": "Restore W0 governance, pin protection to committed governance tags, harden amendment/tag succession, land W1 build and gate seams, embed and bind DecisionCommitted facts, adopt the reviewed AcceptedBatch mint capability, and register re-verified L2/L3 suites.",
  "protectedFiles": [
    "adapters/tsconfig.json",
    "apps/tsconfig.json",
    "authority/protocol/accepted-batch.ts",
    "package.json",
    "policy-root/SEAM-OWNERSHIP.md",
    "policy-root/amendment-marker.ts",
    "policy-root/amendments/ARCHITECTURE-AMENDMENT-001.md",
    "policy-root/amendments/README.md",
    "policy-root/architecture-checker.ts",
    "policy-root/bootstrap-baselines.ts",
    "policy-root/fingerprint-checker.ts",
    "policy-root/gate-self-tests.ts",
    "policy-root/governance-baseline.ts",
    "policy-root/link-testkit-dependencies.ts",
    "policy-root/protected-files.json",
    "policy-root/protection-checker.ts",
    "policy-root/protocol-fingerprints.json",
    "policy-root/required-suites.json",
    "policy-root/suite-manifest-checker.ts",
    "policy-root/w0-gate.ts",
    "runtime/tsconfig.json",
    "storage/tsconfig.json",
    "testkit/tsconfig.json",
    "tsconfig.json"
  ],
  "fingerprintChanges": [
    {
      "capsule": "JournalRecord",
      "oldDigest": "sha256:08dc91e117dad5a8db02d3220ddfc0b806af93cba6aaa5ee2696985c79a2f9e0",
      "newDigest": "sha256:fc0158ceeb596c8726abf893277e94d9499c791c7f222ab549fee9342bd85a0f"
    }
  ]
}
```

## Rulings represented

- Protection resolves its manifest from `w0-trusted-baseline`, then a contiguous,
  validated `governance-baseline-NNN` chain. Working-tree hash edits never define
  the referee.
- Baseline/tag creation requires the flag, exact environment value, and this exact
  marker scope. The tool regenerates baselines, then creates the annotated tag only
  after the complete change is committed and the tree is clean.
- Strict referenced projects cover storage, runtime, adapters, apps, and all
  testkit content including real adapters.
- The journal append law is zero-edge until commit-loop source exists, then exactly
  one import/call edge from commit-loop.
- Registered suites carry commands and the default gate runs every command;
  D2.4 remains pending because L2 supplies only bounded framework/toy coverage,
  not the production-authority third-outcome hunt.
- Lanes request policy registration; integration owns policy-root and seams.
- `DecisionCommitted` carries canonical ordered facts plus `factRoot`; mint/replay
  reject a mismatch. `commandRoot` remains a CAS reference.
- The reviewed opaque AcceptedBatch mint design is adopted deliberately, with
  canonical ownership, run binding, fact-root binding, and facade-only value use.
