# Final startup race fix

## Root cause

The delayed-winner fixture was polling the latest startup report for `after-activation-before-first-handshake`. That report is one file per attempt and is overwritten on each transition. Under load, the waiting client could connect immediately after `listen()` and drive the coordinator to `first-exact-handshake-served` before the test poll observed the intermediate report. The winner process stayed alive and stderr stayed empty because it was correctly paused at the first-handshake barrier; the harness had missed a transient state, not a real startup failure.

There was also a production ordering gap: `startCoordinatorServer()` bound the socket before awaiting the post-activation observer transition, so request handling could run concurrently with startup observation.

## Fix

- Added a startup request gate in `src/core/coordination/server.ts` (and built `dist/.../server.js`) so accepted sockets cannot process frames until `after-activation-before-first-handshake` observation completes. The gate is released in `finally` so cleanup/drain remains bounded on observer failure.
- Made `delayedWinnerFixture` arm and wait on the real `after-activation-before-first-handshake` barrier before releasing the election loser, then release that barrier and wait for the existing `first-exact-handshake-served` barrier. This makes state transition observation deterministic without increasing timeouts or weakening assertions.

## Validation

- `node --experimental-strip-types --test --test-concurrency=1 --test-name-pattern="fails closed when the delayed winner lock identity changes" tests/multiprocess/coordinator-startup-state-machine.test.ts` — pass
- `node --experimental-strip-types --test --test-concurrency=1 tests/multiprocess/coordinator-startup-state-machine.test.ts` — pass
- `npm run typecheck` — pass

The certification evidence log at `/Users/lizavasilyeva/work/s2-orchestration/certification/npm-test.log` was not modified.
