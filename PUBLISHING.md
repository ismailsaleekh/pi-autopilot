# Publishing Autopilot

Autopilot now packages the extension commands, `context_budget`, contracts/templates, forced-output/status support, state-store helpers, runner CLI/bin, fake-Pi witnesses, parent prompt, restart prompt, offline SDK/RPC/package gates, and `pack:dry-run` payload checks. A publish decision must still treat live provider-backed child execution as an explicit operator-approved release witness, not as part of the default offline gate.

## Required pre-publish gate

Run from the repository root:

```bash
npm run build
npm run typecheck
npm run test:package
npm run test
npm run pack:dry-run
```

Also run release docs audits and forbidden legacy-runtime scans before cutting a package.

## Package payload checklist

1. Confirm `npm run pack:dry-run` includes `bin/`, `dist/`, `extensions/`, `src/`, `templates/`, README, TESTING, TEST_PLAN, PUBLISHING, and LICENSE.
2. Confirm tests, artifacts, dependency directories, and local runtime state are excluded from the tarball.
3. Verify `pi.extensions` points at `./extensions/autopilot.ts` and the package bin exposes `autopilot-agent-run` through compiled `dist/src/cli/autopilot-agent-run.js`, not Node type stripping of `.ts` under `node_modules`.
4. Verify `/autopilot` and `/autopilot-restart` load from the installed package and not from repo-local prompt files.
5. Verify `/autopilot` activates `context_budget` in a parent session and that `/autopilot-restart` remains read-only.
6. Verify `autopilot-agent-run --dry-run <unit-spec.json>` works from the documented install mode.
7. Verify the fake-Pi runner/e2e witness still joins status artifact, receipt artifact, receipt hash, provider identity, and structured tool carrier.

## Release limitations

Do not market the package as a fully autonomous live-provider scheduler. The current package supplies the Autopilot surfaces and offline/default QA needed for parent-prompt-driven orchestration, child runner validation, state-store persistence, and package distribution. It does not ship compiled scheduling UI, PTY/TUI coverage, migration tooling for older runtime folders, or default automated live-provider child runs.

Any live child execution witness must be opt-in, use subscription Pi channels only, use one of the allowed provider patterns (`openai-codex/*`, `anthropic/*`, `opencode-go/*`, `kimi-coding/*`, `zai/*`), avoid metered frontier API routes, run against a disposable workstream, and launch through `autopilot-agent-run` with a reviewed Autopilot unit spec.
