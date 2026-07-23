# integrate-3-retention

Integrated Lane E retention commits `4528762364da2879a040d41fcce40c4b80003522` and `059646f17d7727cdffcf7f9ff0e4798f94e197b3` into the current A+B S2 integration.

## Done

- Exported S2 retention archive / owned-GC / pressure-state APIs from the coordination barrel.
- Wired coordinator-backed close/abort terminal evidence into S2 cold archive publication, verified hot-summary eligibility, and terminal cleanup binding verification.
- Added coordinator-owned scheduled S2 GC for terminal runs over package-owned `_trash/` and `transition-backups/` candidates only.
- Connected disk-gate failures to durable per-run S2 pressure state plus bounded diagnostics, worktree creation refusal for only the offending run, and scheduler skip behavior that leaves unrelated runs dispatchable.
- Preserved owner, sole-copy, cold-archive verification, dirty/quarantine, symlink/hardlink, and refusal invariants; no manual deletion path added.
- Added real hard-kill restart coverage for cold archive write/fsync/rename, hot summary write/fsync/rename, ledger append/fsync, GC rename, and GC rm boundaries.
- Updated S2 retention behavioral docs and regenerated/verified docs/dist.

## Verification

- `npm run typecheck`
- `node --experimental-strip-types --test tests/model/s2-retention-state-machine.test.ts tests/unit/s2-retention.test.ts tests/chaos/s2-retention-chaos.test.ts tests/crash/s2-retention-resume.test.ts tests/unit/phase2-parallelism.test.ts tests/unit/close-runtime.test.ts`
- `npm run build`
- `npm run docs:generate`
- `npm run docs:verify`
