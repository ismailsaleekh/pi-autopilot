# Wave-3 integration step 4: release gates

## Integrated lanes

- Lane C `95d007e7a3e3c79e6df85193c62e042ac83014ae`: S2-C previous-release skew manifest/helper/tests.
- Lane D `8942370670ee551cd9b4031e1804f89b39710841`, `49da9a7d90e9e259f03acf7bf13c5d427b2c8415`, `b9fa6ba3fd9c8296a64b25c657ac3e11f1c64eb6`: S2-D corpus rehearsal contracts, isolation, mutable-clone rehearsal, and root-cause fixes.

Cherry-picks produced no textual conflict stages (`git ls-files -u` empty), so there were no base/ours/theirs hunks to blanket-resolve. Semantic integration was still applied around package payload, CI/release gates, compiled installed execution, and docs.

## Release gate wiring

- `npm run test:version-skew` now permanently runs the S2-C manifest contract plus previous-client/current-coordinator, current-client/previous-coordinator, natural restart, idempotent replay, mixed election, and retained cf50/S1 security journeys.
- The digest-pinned previous fixture remains `sha256:e98ccee99e95d5ba9c958c91c354eef40326fa21cf89a8ba37bd10e6650485a7` for `tests/fixtures/releases/cf50/pi-autopilot-1.1.8-cf50.tgz`.
- `autopilot-s2-corpus-rehearsal` ships as a compiled installed bin backed by generic S2-D harness code under `dist/tools/s2-corpus-rehearsal/` and source under `tools/s2-corpus-rehearsal/`.
- Reusable S2-D commands: `status`, `request`, `clone`, `rehearse`, `manifest`, and `result`.
- Default S2-D release status never reads a live corpus: without explicit `S2_D_REHEARSAL_RESULT`, it exits `not_run`. Certification requires explicit mutable rehearsal result evidence.
- Package payload gates include generic S2-D harness code and deterministically exclude tests, tarballs, private request/result/corpus/log paths, live witness/corpus clone artifacts, node_modules, and local runtime state.
- CI and `test:release` explicitly run `test:version-skew` and `test:s2-corpus`.

## Focused verification run

- `npm run typecheck`
- `npm run test:version-skew`
- `npm run test:s2-corpus`
- `node --experimental-strip-types --test --test-concurrency=1 tests/package/package.test.ts tests/package/s2-corpus-package-gate.test.ts`
- `npm run security:scan -- --quiet && npm run sbom && npm run payload:check`
- `npm run docs:verify`
- `npm run pack:dry-run`
