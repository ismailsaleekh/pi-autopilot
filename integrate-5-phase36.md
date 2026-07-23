# Integrate 5 — Phase36 closeout

## Summary

- Closed the S2-D owned-recovery seam so migration-frozen ordinary attach contention enters supported migration recovery APIs with exact `recovery_id` payloads and verifies pending recovery is zero before action coverage.
- Added retained terminal-attempt lease measurement/recovery proof plumbing: contracts now distinguish recovery-required retained terminal leases, and candidate recovery records before/after terminal recovery evidence.
- Added real subprocess coverage for authority-version operation outputs: synthetic corpus now includes recovered and blocked owned-operation candidates, plus a migration-frozen owned-recovery subprocess regression.
- Hardened release propagation: candidate blockers fail result writing before release evidence is emitted; parsed rehearsal results still require zero blockers and complete durable-run action coverage.
- Updated package docs facts for S2-D Phase36 release seams and regenerated/verified build artifacts.

## Verification

- `node --experimental-strip-types --test --test-concurrency=1 tests/unit/s2-corpus-contracts.test.ts tests/unit/s2-corpus-isolation.test.ts tests/e2e/s2-corpus-synthetic-rehearsal.test.ts tests/package/s2-corpus-package-gate.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run docs:generate`
- `npm run docs:verify`
